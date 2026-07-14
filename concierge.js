// ── FSRE Concierge — P1 PRIVATE PILOT ──────────────────────────────
// Conversational assistant over the live IDX inventory.
// Per plan doc (fsre-concierge-bot-plan.md) + Laurie's authorization
// 2026-07-10: "don't want it live to any public/customer view until we
// test on our end."
//
// P1 scope:
//   • /concierge?k=ACCESS_KEY   — private chat page (noindex, key-gated)
//   • POST /api/concierge/chat  — key-gated chat API
//   • Access key lives in Neon app_config('concierge_access_key')
//   • LLM: OpenRouter — Claude Haiku 4.5 primary, Gemini 2.5 Flash fallback
//     (per-key $ cap set in OpenRouter dashboard = hard budget isolation)
//   • Tools: search_listings + get_listing_detail (same buildListingFilters
//     codepath as /api/listings) + request_human_handoff (P1: logged only —
//     NO CRM contact, NO Telegram ping; fake leads while we red-team)
//   • Memory: full message history in Neon (concierge_messages.msg JSONB),
//     replayed per turn. Per-visitor semantic memory = P2.
//   • Guardrails in system prompt from message one: AI disclosure,
//     licensed-activity boundary, Fair Housing no-steering.
//
// NOT in P1 (deliberate): public exposure, CRM writes, outbound email/SMS,
// save-to-board (needs signed-in user), seller valuations.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODELS = ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash"];
const MAX_TOOL_ROUNDS = 4;
const MAX_REPLY_TOKENS = 1024;
const MAX_MESSAGES_PER_CONVERSATION = 60; // P1 safety cap
const MAX_USER_MESSAGE_CHARS = 2000;
const HISTORY_LIMIT = 40; // messages replayed per turn

// ── Routing ─────────────────────────────────────────────────────────

export function isConciergePath(path) {
  return path === "/concierge" || path === "/api/concierge/chat";
}

export async function handleConciergeRoute(request, url, path, client, env, helpers) {
  const { jsonResponse } = helpers;
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  const accessKey = await getAccessKey(client);
  if (!accessKey) {
    return jsonResponse({ error: "concierge not configured" }, cors, 503);
  }

  if (path === "/concierge" && request.method === "GET") {
    // Page itself is key-gated: wrong/absent key → plain 404 (no hints).
    if (url.searchParams.get("k") !== accessKey) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(CONCIERGE_HTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }

  if (path === "/api/concierge/chat" && request.method === "POST") {
    return await handleChat(request, client, env, cors, accessKey, helpers);
  }

  return jsonResponse({ error: "not found" }, cors, 404);
}

async function getAccessKey(client) {
  try {
    const r = await client.query(
      "SELECT value FROM app_config WHERE key = 'concierge_access_key'"
    );
    return r.rows[0]?.value || null;
  } catch (e) {
    console.error("concierge access key lookup failed:", e.message);
    return null;
  }
}

// ── Chat handler ────────────────────────────────────────────────────

async function handleChat(request, client, env, cors, accessKey, helpers) {
  const { jsonResponse } = helpers;

  if (!env.OPENROUTER_API_KEY) {
    return jsonResponse({ error: "model unavailable" }, cors, 503);
  }

  let body;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body.message !== "string" || !body.message.trim()) {
    return jsonResponse({ error: "message required" }, cors, 400);
  }
  if (body.key !== accessKey) {
    return jsonResponse({ error: "unauthorized" }, cors, 401);
  }
  const userText = body.message.trim().slice(0, MAX_USER_MESSAGE_CHARS);

  // Load or create conversation
  let convId = null;
  if (body.conversation_id && /^[0-9a-f-]{36}$/.test(body.conversation_id)) {
    const r = await client.query(
      "SELECT id, message_count FROM concierge_conversations WHERE id = $1",
      [body.conversation_id]
    );
    if (r.rows.length) {
      if (r.rows[0].message_count >= MAX_MESSAGES_PER_CONVERSATION) {
        return jsonResponse({
          error: "conversation_full",
          reply: "This conversation has reached its length limit — refresh the page to start a fresh one.",
        }, cors, 200);
      }
      convId = r.rows[0].id;
    }
  }
  if (!convId) {
    const r = await client.query(
      "INSERT INTO concierge_conversations (label) VALUES ('p1-pilot') RETURNING id"
    );
    convId = r.rows[0].id;
  }

  // Replay history
  const hist = await client.query(
    `SELECT msg FROM concierge_messages WHERE conversation_id = $1
     ORDER BY id DESC LIMIT $2`,
    [convId, HISTORY_LIMIT]
  );
  const history = hist.rows.reverse().map((r) => r.msg);

  const userMsg = { role: "user", content: userText };
  await saveMsg(client, convId, userMsg, null, null, null);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    userMsg,
  ];

  // Tool loop
  let reply = null;
  let modelUsed = null;
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const resp = await callOpenRouter(env, messages, round < MAX_TOOL_ROUNDS);
      modelUsed = resp.model || null;
      const choice = resp.choices?.[0];
      if (!choice) throw new Error("empty completion");
      const m = choice.message;

      const assistantMsg = { role: "assistant", content: m.content ?? null };
      if (m.tool_calls?.length) assistantMsg.tool_calls = m.tool_calls;
      messages.push(assistantMsg);
      await saveMsg(client, convId, assistantMsg, modelUsed,
        resp.usage?.prompt_tokens ?? null, resp.usage?.completion_tokens ?? null);

      if (!m.tool_calls?.length) {
        reply = m.content || "";
        break;
      }

      for (const tc of m.tool_calls) {
        const result = await runTool(tc, client, env, convId, helpers);
        const toolMsg = {
          role: "tool",
          tool_call_id: tc.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        };
        messages.push(toolMsg);
        await saveMsg(client, convId, toolMsg, null, null, null);
      }
    }
  } catch (e) {
    console.error("concierge chat error:", e.message);
    return jsonResponse({
      conversation_id: convId,
      reply: "I hit a technical snag on my end — please try that again in a moment.",
      error: "llm_error",
    }, cors, 200);
  }

  if (reply === null) {
    reply = "I wasn't able to finish looking that up — could you rephrase or narrow it down?";
  }

  await client.query(
    `UPDATE concierge_conversations
     SET message_count = message_count + 2, last_at = now() WHERE id = $1`,
    [convId]
  );

  return jsonResponse({ conversation_id: convId, reply, model: modelUsed }, cors);
}

async function saveMsg(client, convId, msg, model, tokensIn, tokensOut) {
  await client.query(
    `INSERT INTO concierge_messages (conversation_id, msg, model, tokens_in, tokens_out)
     VALUES ($1, $2, $3, $4, $5)`,
    [convId, JSON.stringify(msg), model, tokensIn, tokensOut]
  );
}

async function callOpenRouter(env, messages, allowTools) {
  const payload = {
    models: MODELS,
    messages,
    max_tokens: MAX_REPLY_TOKENS,
    temperature: 0.3,
  };
  if (allowTools) payload.tools = TOOLS;

  const r = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://search.foursailsrealestate.com",
      "X-Title": "FSRE Concierge (private pilot)",
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`openrouter ${r.status}: ${t.slice(0, 300)}`);
  }
  return await r.json();
}

// ── Tools ───────────────────────────────────────────────────────────

const AREA_SLUGS = [
  "manasota-key", "casey-key", "venice", "englewood", "sarasota",
  "nokomis-osprey", "boca-grande", "wellen-park", "boca-royale", "rotonda-west",
];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_listings",
      description:
        "Search live MLS inventory (Sarasota/Charlotte/Manatee/Lee counties, FL). " +
        "Returns matching listings with price, address, beds/baths, sqft, status. " +
        "Use area for the named communities; city/zip for anything else.",
      parameters: {
        type: "object",
        properties: {
          area: { type: "string", enum: AREA_SLUGS, description: "Named area page (preferred when it matches)" },
          city: { type: "string", description: "City name, e.g. Venice" },
          zip: { type: "string" },
          status: { type: "string", enum: ["Active", "Pending", "Closed"], description: "Default Active. Closed = sold." },
          min_price: { type: "number" },
          max_price: { type: "number" },
          min_beds: { type: "number" },
          min_baths: { type: "number" },
          min_sqft: { type: "number" },
          max_sqft: { type: "number" },
          waterfront: { type: "boolean", description: "True = waterfront only" },
          pool: { type: "boolean", description: "True = private pool only" },
          property_type: { type: "string", enum: ["Residential", "Land", "Residential Income", "Commercial Sale"] },
          property_subtype: {
            type: "string",
            description: "Comma-separated home styles to INCLUDE (Residential only). Valid: Single Family Residence, Condominium, Townhouse, Villa, Half Duplex, Mobile Home, Manufactured Home, Farm. Example: visitor wants houses only (no condos) => 'Single Family Residence'. Use whenever the visitor specifies or excludes home styles.",
          },
          no_hoa: { type: "boolean" },
          sort: { type: "string", enum: ["newest", "price_asc", "price_desc"], description: "Default newest" },
          limit: { type: "number", description: "Max results, 1-10, default 6" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_listing_detail",
      description:
        "Full detail for one listing: description, features, lot, taxes/HOA, photos. " +
        "Accepts the listing_key from search results or an MLS number.",
      parameters: {
        type: "object",
        properties: {
          listing_key: { type: "string", description: "listingkey from search results, or MLS # like N6142960" },
        },
        required: ["listing_key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_human_handoff",
      description:
        "Route the visitor to Laurie or Christian (licensed agents). Use when the visitor wants a showing, " +
        "a valuation, pricing/negotiation/contract advice, or asks for a human. " +
        "Summarize what they're looking for so the agents have context.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why the handoff (showing request, pricing advice, valuation, ...)" },
          summary: { type: "string", description: "What the visitor wants: criteria, timeline, context" },
          contact: { type: "string", description: "Name/phone/email if the visitor shared them" },
        },
        required: ["reason", "summary"],
      },
    },
  },
];

async function runTool(tc, client, env, convId, helpers) {
  let args = {};
  try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* leave empty */ }

  try {
    switch (tc.function?.name) {
      case "search_listings":
        return await toolSearch(args, client, helpers);
      case "get_listing_detail":
        return await toolDetail(args, client);
      case "request_human_handoff":
        return await toolHandoff(args, client, convId);
      default:
        return { error: `unknown tool ${tc.function?.name}` };
    }
  } catch (e) {
    console.error(`concierge tool ${tc.function?.name} failed:`, e.message);
    return { error: "tool failed — tell the visitor you couldn't complete the lookup" };
  }
}

async function toolSearch(args, client, helpers) {
  const { buildListingFilters } = helpers;
  const q = new URLSearchParams();
  if (args.area && AREA_SLUGS.includes(args.area)) q.set("area", args.area);
  if (args.city) q.set("city", String(args.city));
  if (args.zip) q.set("zip", String(args.zip));
  q.set("status", ["Active", "Pending", "Closed"].includes(args.status) ? args.status : "Active");
  for (const k of ["min_price", "max_price", "min_beds", "min_baths", "min_sqft", "max_sqft"]) {
    if (args[k] != null && isFinite(args[k])) q.set(k, String(Math.round(args[k])));
  }
  if (args.waterfront === true) q.set("waterfront", "1");
  if (args.pool === true) q.set("pool", "1");
  if (args.no_hoa === true) q.set("no_hoa", "1");
  if (args.property_type) q.set("property_type", String(args.property_type));
  if (args.property_subtype) q.set("property_subtype", String(args.property_subtype));

  const { where, params } = buildListingFilters(q);
  const whereSql = "WHERE " + where.join(" AND ");
  const sortMap = {
    newest: "listingcontractdate DESC NULLS LAST",
    price_asc: "listprice ASC NULLS LAST",
    price_desc: "listprice DESC NULLS LAST",
  };
  const orderBy = sortMap[args.sort] || sortMap.newest;
  const limit = Math.max(1, Math.min(10, parseInt(args.limit) || 6));

  const countR = await client.query(`SELECT COUNT(*) AS c FROM listings ${whereSql}`, params);
  const total = parseInt(countR.rows[0]?.c ?? 0);

  const r = await client.query(
    `SELECT listingkey, listingid, standardstatus, listprice, closeprice, closedate,
            unparsedaddress, city, postalcode, bedroomstotal, bathroomstotalinteger,
            livingarea, lotsizeacres, yearbuilt, poolprivateyn, waterfrontyn,
            subdivisionname, propertysubtype,
            GREATEST(0, current_date - listingcontractdate::date)::int AS dom
     FROM listings ${whereSql} ORDER BY ${orderBy}
     LIMIT $${params.length + 1}`,
    [...params, limit]
  );

  return {
    total_matches: total,
    showing: r.rows.length,
    listings: r.rows.map((l) => ({
      listing_key: l.listingkey,
      mls: l.listingid,
      status: l.standardstatus,
      price: l.standardstatus === "Closed" ? Number(l.closeprice) : Number(l.listprice),
      sold_date: l.closedate || undefined,
      address: l.unparsedaddress || `(address not displayed) ${l.city}`,
      city: l.city,
      zip: l.postalcode,
      beds: l.bedroomstotal,
      baths: l.bathroomstotalinteger,
      sqft: l.livingarea,
      lot_acres: l.lotsizeacres,
      year_built: l.yearbuilt,
      pool: l.poolprivateyn === true,
      waterfront: l.waterfrontyn === true,
      subdivision: l.subdivisionname,
      type: l.propertysubtype,
      days_on_market: l.dom,
      link: `https://www.foursailsrealestate.com/mls/${l.listingid}`,
    })),
  };
}

async function toolDetail(args, client) {
  const raw = String(args.listing_key || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!raw) return { error: "listing_key required" };

  const r = await client.query(
    `SELECT listingkey, listingid, standardstatus, listprice, closeprice, closedate,
            unparsedaddress, city, stateorprovince, postalcode, countyorparish,
            bedroomstotal, bathroomstotalinteger, bathroomsfull, bathroomshalf,
            livingarea, lotsizeacres, yearbuilt, garagespaces, poolprivateyn,
            waterfrontyn, waterfrontfeatures, mfr_wateraccessyn, mfr_waterviewyn,
            subdivisionname, propertysubtype, publicremarks, taxannualamount,
            associationyn, associationfee, associationfeefrequency,
            seniorcommunityyn, newconstructionyn, furnished, virtualtoururlunbranded,
            photoscount,
            GREATEST(0, current_date - listingcontractdate::date)::int AS dom
     FROM listings
     WHERE mlgcanview = true AND (listingkey = $1 OR listingid = $1)
     LIMIT 1`,
    [raw]
  );
  if (!r.rows.length) return { error: "listing not found" };
  const l = r.rows[0];

  return {
    listing_key: l.listingkey,
    mls: l.listingid,
    status: l.standardstatus,
    price: l.standardstatus === "Closed" ? Number(l.closeprice) : Number(l.listprice),
    sold_date: l.closedate || undefined,
    address: l.unparsedaddress || "(address not displayed by seller's request)",
    city: l.city, state: l.stateorprovince, zip: l.postalcode, county: l.countyorparish,
    beds: l.bedroomstotal,
    baths_total: l.bathroomstotalinteger, baths_full: l.bathroomsfull, baths_half: l.bathroomshalf,
    sqft: l.livingarea, lot_acres: l.lotsizeacres, year_built: l.yearbuilt,
    garage_spaces: l.garagespaces, pool: l.poolprivateyn === true,
    waterfront: l.waterfrontyn === true, waterfront_features: l.waterfrontfeatures,
    water_access: l.mfr_wateraccessyn === true, water_view: l.mfr_waterviewyn === true,
    subdivision: l.subdivisionname, type: l.propertysubtype,
    description: (l.publicremarks || "").slice(0, 1500),
    annual_taxes: l.taxannualamount != null ? Number(l.taxannualamount) : undefined,
    hoa: l.associationyn === true
      ? { fee: l.associationfee != null ? Number(l.associationfee) : null, frequency: l.associationfeefrequency }
      : "none",
    senior_community: l.seniorcommunityyn === true,
    new_construction: l.newconstructionyn === true,
    furnished: l.furnished,
    virtual_tour: l.virtualtoururlunbranded || undefined,
    photos_count: l.photoscount,
    days_on_market: l.dom,
    link: `https://www.foursailsrealestate.com/mls/${l.listingid}`,
  };
}

async function toolHandoff(args, client, convId) {
  // P1: log only. NO CRM contact, NO Telegram — fake leads during red-team.
  // P2 wires this to CRM (own lead source) + Telegram RE-group ping.
  const fact = [
    `HANDOFF REQUEST — ${String(args.reason || "unspecified").slice(0, 200)}`,
    `Summary: ${String(args.summary || "").slice(0, 800)}`,
    args.contact ? `Contact: ${String(args.contact).slice(0, 200)}` : null,
  ].filter(Boolean).join("\n");

  await client.query(
    "INSERT INTO concierge_facts (conversation_id, kind, fact) VALUES ($1, 'handoff', $2)",
    [convId, fact]
  );
  return {
    status: "handoff_logged",
    note: "Tell the visitor Laurie & Christian will follow up shortly. (Pilot mode: request logged for review, not yet routed live.)",
  };
}

// ── System prompt (guardrails from message one) ─────────────────────

const SYSTEM_PROMPT = `You are the Four Sails Assistant, an AI concierge for Four Sails Real Estate on Florida's Gulf Coast (Manasota Key, Englewood, Venice, Sarasota and nearby communities). The brokers are Lauralyn "Laurie" Kazimir and Christian, of Four Sails Real Estate.

CURRENTLY IN PRIVATE PILOT — your users right now are Laurie and Christian testing you.

## Identity & disclosure
- You are an AI assistant and you say so whenever asked or when it's relevant. Never pretend to be human.
- Warm, knowledgeable, unhurried. Coastal-professional, not salesy. Concise by default.

## What you do
- Answer questions about live inventory using your tools — search_listings and get_listing_detail. ALWAYS use tools for listing facts; NEVER invent listings, prices, or availability from memory.
- Share objective area knowledge: geography, property types, waterfront types (Gulf-front vs. bay vs. canal), what's on the market.
- Geography facts: Manasota Key is an 11-mile barrier island (Sarasota + Charlotte counties) separated from the mainland by Lemon Bay. Englewood and Venice are mainland towns — Englewood is the mainland community adjacent to Manasota Key, not on the island. Wellen Park is a master-planned community in the Venice/North Port area.
- Help visitors explore: suggest refining searches, mention nearby alternatives, invite them to save homes or set up listing alerts on the site.

## Home styles — clarify early (important)
- The MLS mixes single-family homes, condos, townhouses, villas, mobile homes, and even timeshares. Unfiltered results overwhelm people.
- If the visitor hasn't said what style they want, ask early — one friendly question: single-family homes, condos/townhomes, or open to anything? Then filter with property_subtype on every search.
- "House" or "home" usually means Single Family Residence — set property_subtype accordingly rather than searching everything.
- The "waterfront" flag includes freshwater ponds and lakes. If the visitor wants saltwater / Gulf / bay / canal, confirm via get_listing_detail (waterfront_features) before presenting a listing as saltwater — or say plainly that you're verifying which ones are truly saltwater.
- When totals matter, report total_matches, not just the shown sample.
- Include the listing link when discussing a specific property.

## Connecting visitors to humans
- The ONLY humans you ever connect a visitor with are Laurie & Christian — they work together as a team, so the visitor gets both no matter what.
- NEVER refer a visitor to a listing's own agent, office, or any outside agent — no "contact the listing agent," no agent or brokerage names as a contact path. Every showing, question, or next step routes through Laurie & Christian (request_human_handoff).

## Hard boundaries (licensed activity — route to humans)
- NO advice on offer price, negotiation strategy, or contract terms. That is exactly what Laurie & Christian do — offer to connect them (request_human_handoff).
- NO home valuations or "what is my home worth" opinions — handoff.
- Showing requests, listing appointments, or "talk to a person" — handoff.
- You never make commitments on the agents' behalf (no confirmed appointment times — the agents confirm).

## Fair Housing (non-negotiable)
- Never steer. Never characterize neighborhoods or communities by demographics, safety/crime, school quality opinions, or any protected-class proxy (including coded language like "family-friendly area," "good schools," "safe neighborhood," "the right kind of community").
- If asked such questions, decline gracefully and redirect to objective sources: "I can't characterize neighborhoods that way, but I can share objective data — for schools, GreatSchools.org and the county district site are good sources. What matters most to you in the home itself?"
- Describe PROPERTIES and objective facts (price, size, features, distances, flood zone, HOA), not the people who live nearby.

## Style
- Prices: $1.2M / $450K style. Areas: use proper names.
- Don't dump raw data — synthesize. 2-4 listings described conversationally beats a table.
- One question at a time when clarifying what they want.
- If a tool fails, say you couldn't complete the lookup — never fabricate a result.
- Puerto Rico listings exist in the system but are not part of the public Florida search — don't offer them.

## Attribution
When presenting listing data, occasionally note listings come from Stellar MLS (required attribution: data provided via MLS Grid). Not needed on every message.`;

// ── Private pilot chat page ─────────────────────────────────────────

const CONCIERGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Four Sails Concierge — Private Pilot</title>
<style>
  :root { --navy:#1D3F60; --ivory:#F8F7F3; --champagne:#E3DEC3; --sand:#D9CBBF; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Lato',-apple-system,sans-serif; background:var(--ivory); height:100dvh; display:flex; flex-direction:column; }
  header { background:var(--navy); color:var(--ivory); padding:14px 20px; display:flex; align-items:center; gap:12px; }
  header h1 { font-family:Georgia,serif; font-size:18px; font-weight:normal; letter-spacing:.5px; }
  header .pill { font-size:11px; background:var(--champagne); color:var(--navy); border-radius:10px; padding:2px 10px; letter-spacing:1px; text-transform:uppercase; }
  #chat { flex:1; overflow-y:auto; padding:20px; max-width:760px; width:100%; margin:0 auto; }
  .msg { margin:10px 0; max-width:85%; padding:12px 16px; border-radius:14px; line-height:1.5; font-size:15px; white-space:pre-wrap; word-wrap:break-word; }
  .user { background:var(--navy); color:var(--ivory); margin-left:auto; border-bottom-right-radius:4px; }
  .bot  { background:#fff; border:1px solid var(--sand); border-bottom-left-radius:4px; }
  .bot a { color:var(--navy); font-weight:bold; }
  .typing { color:#888; font-style:italic; }
  form { display:flex; gap:10px; padding:14px 20px 20px; max-width:760px; width:100%; margin:0 auto; }
  input { flex:1; padding:12px 16px; border:1px solid var(--sand); border-radius:24px; font-size:15px; outline:none; background:#fff; }
  input:focus { border-color:var(--navy); }
  button { background:var(--navy); color:var(--ivory); border:none; border-radius:24px; padding:12px 22px; font-size:15px; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
</style>
</head>
<body>
<header>
  <h1>Four Sails Concierge</h1>
  <span class="pill">Private Pilot</span>
</header>
<div id="chat"></div>
<form id="f">
  <input id="inp" placeholder="Ask about listings, areas, waterfront..." autocomplete="off" autofocus>
  <button id="send" type="submit">Send</button>
</form>
<script>
(function () {
  var key = new URLSearchParams(location.search).get("k") || "";
  var convId = null;
  var chat = document.getElementById("chat");
  var f = document.getElementById("f");
  var inp = document.getElementById("inp");
  var send = document.getElementById("send");

  function esc(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function linkify(html) {
    return html.replace(/(https:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
               .replace(/\\*\\*([^*]+)\\*\\*/g, "<b>$1</b>");
  }
  function add(role, text) {
    var d = document.createElement("div");
    d.className = "msg " + role;
    if (role === "bot") d.innerHTML = linkify(esc(text)); else d.textContent = text;
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
    return d;
  }

  add("bot", "Hi! I'm the Four Sails Assistant — an AI concierge with live access to our Gulf Coast MLS inventory. Ask me about listings, areas, waterfront options, whatever you're curious about. (Private pilot mode.)");

  f.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = inp.value.trim();
    if (!text) return;
    inp.value = "";
    add("user", text);
    var t = add("bot", "…");
    t.classList.add("typing");
    send.disabled = true;

    fetch("/api/concierge/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key, conversation_id: convId, message: text }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.conversation_id) convId = d.conversation_id;
        t.classList.remove("typing");
        t.innerHTML = linkify(esc(d.reply || d.error || "Something went wrong."));
        chat.scrollTop = chat.scrollHeight;
      })
      .catch(function () {
        t.classList.remove("typing");
        t.textContent = "Connection error — please try again.";
      })
      .finally(function () { send.disabled = false; inp.focus(); });
  });
})();
</script>
</body>
</html>`;
