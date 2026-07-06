/**
 * FS IDX Edge Search — build 20260511-1805 — Cloudflare Worker + Hyperdrive (Neon Postgres)
 * 
 * Serves search UI, listing API, detail views, stats.
 * All data from Neon via Hyperdrive. Photos from R2.
 * Zero VPS dependency. Zero D1.
 */

import SEARCH_HTML from "./search.html";
import pg from 'pg';
const { Client } = pg;

const VALID_SORTS = {
  newest: "listingcontractdate DESC NULLS LAST",
  oldest: "listingcontractdate ASC NULLS LAST",
  price_high: "listprice DESC NULLS LAST",
  price_low: "listprice ASC NULLS LAST",
  price_desc: "listprice DESC NULLS LAST",
  price_asc: "listprice ASC NULLS LAST",
  beds: "bedroomstotal DESC NULLS LAST",
  sqft: "livingarea DESC NULLS LAST",
  modified: "modificationtimestamp DESC NULLS LAST",
};

const VALID_STATUSES = ["Active", "Pending", "Coming Soon", "Closed"];
const VALID_PROP_TYPES = [
  "Residential", "Land", "Commercial Sale", "Residential Income",
  "Commercial Lease", "Residential Lease", "Business Opportunity",
];
const VALID_WF_TYPES = ["gulf", "bay", "canal", "lake", "river", "beach"];
const DEFAULT_COUNTIES = ["Sarasota", "Charlotte", "Lee"];
const MAX_PER_PAGE = 50;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ── Lead capture routes (no DB needed) ──────────────────────
    if (request.method === "POST" && path === "/api/showing-request") {
      return await handleShowingRequest(request, env, corsHeaders);
    }
    if (request.method === "POST" && path === "/api/signup") {
      return await handleSignup(request, env, corsHeaders);
    }

    // Connect to Postgres via Hyperdrive
    const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });

    try {
      await client.connect();

      if (path === "/api/listings" || path === "/api/listings/") {
        return await handleSearch(url.searchParams, client, env, corsHeaders);
      }
      if (path.startsWith("/api/listings/")) {
        const key = path.split("/api/listings/")[1];
        if (key) return await handleDetail(key, client, env, corsHeaders);
      }
      if (path === "/api/stats") {
        return await handleStats(client, corsHeaders);
      }
      if (path === "/api/health") {
        return jsonResponse({ status: "ok", edge: true, db: "neon" }, corsHeaders);
      }
      if (path === "/" || path === "/index.html") {
        return new Response(SEARCH_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
        });
      }
      // Shareable listing links (2026-07-06): /listing/:key opens the detail
      // view directly, with OG tags so shared links unfurl with photo + price.
      if (path.startsWith("/listing/")) {
        const rawKey = decodeURIComponent(path.split("/listing/")[1] || "").replace(/[^A-Za-z0-9_-]/g, "");
        if (!rawKey) return Response.redirect(url.origin + "/", 302);
        const r = await client.query(
          `SELECT listingkey, listingid, unparsedaddress, city, stateorprovince, postalcode,
                  listprice, closeprice, standardstatus, bedroomstotal, bathroomstotalinteger,
                  livingarea, primary_photo, region
           FROM listings WHERE listingkey = $1 AND mlgcanview = true`, [rawKey]);
        if (r.rows.length === 0) return Response.redirect(url.origin + "/", 302);
        const l = r.rows[0];
        const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const price = l.standardstatus === "Closed" && l.closeprice ? l.closeprice : l.listprice;
        const priceStr = price ? "$" + Number(price).toLocaleString("en-US") : "";
        const title = `${esc(l.unparsedaddress || "")}, ${esc(titleCaseCity(l.city))} — ${priceStr}`;
        const descBits = [];
        if (l.bedroomstotal != null) descBits.push(`${l.bedroomstotal} bd`);
        if (l.bathroomstotalinteger != null) descBits.push(`${l.bathroomstotalinteger} ba`);
        if (l.livingarea) descBits.push(`${Number(l.livingarea).toLocaleString("en-US")} sqft`);
        descBits.push(l.standardstatus === "Closed" ? "Sold" : esc(l.standardstatus || ""));
        const desc = `${descBits.join(" · ")} · MLS# ${esc(String(l.listingid || rawKey).replace(/^MFR/, ""))} · Four Sails Real Estate`;
        const ogImage = l.primary_photo || "https://assets.4sails.net/Logo%20OUtline%20Test%20copy.png";
        const inject =
          `<meta property="og:title" content="${title}">` +
          `<meta property="og:description" content="${desc}">` +
          `<meta property="og:image" content="${esc(ogImage)}">` +
          `<meta property="og:url" content="${esc(url.origin + "/listing/" + rawKey)}">` +
          `<meta property="og:type" content="website">` +
          `<meta name="twitter:card" content="summary_large_image">` +
          (l.region === "PR" ? "<script>window.__PR_MODE__=true</script>" : "") +
          `<script>window.__OPEN_LISTING__=${JSON.stringify(rawKey)}</script></head>`;
        return new Response(SEARCH_HTML.replace("</head>", inject), {
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
        });
      }
      // Personal Puerto Rico search (2026-07-06) — same UI in PR mode, noindex
      if (path === "/pr" || path === "/pr/") {
        const prHtml = SEARCH_HTML.replace(
          "</head>",
          '<meta name="robots" content="noindex, nofollow"><script>window.__PR_MODE__=true</script></head>'
        );
        return new Response(prHtml, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "X-Robots-Tag": "noindex, nofollow",
            ...corsHeaders,
          },
        });
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return jsonResponse({ error: err.message }, corsHeaders, 500);
    } finally {
      await client.end();
    }
  },
};

// ── Search ──────────────────────────────────────────────────────

function titleCaseCity(s) {
  return s ? String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : "";
}

async function handleSearch(q, client, env, cors) {
  const where = ["mlgcanview = true"];
  const params = [];
  let paramIdx = 0;
  const p = () => `$${++paramIdx}`;

  // Property type
  const propType = q.get("property_type");
  if (propType && VALID_PROP_TYPES.includes(propType)) {
    where.push(`propertytype = ${p()}`); params.push(propType);
  } else if (!propType) {
    where.push("propertytype = 'Residential'");
  }

  // Status
  const status = q.get("status") || "Active";
  if (status.toUpperCase() !== "ALL") {
    if (VALID_STATUSES.includes(status)) {
      where.push(`standardstatus = ${p()}`); params.push(status);
    }
  }

  // Region: PR personal mode searches Puerto Rico listings island-wide.
  // PR photo coverage is still backfilling, so don't hide photo-less listings there.
  const region = q.get("region");
  const isPR = region === "PR";
  if (isPR) {
    where.push("region = 'PR'");
  }

  // Only require photos_synced for non-Closed listings (FL public search only)
  if (status !== "Closed" && !isPR) {
    where.push("(photos_synced = true OR photoscount = 0)");
  }
  // County (doubles as municipality filter in PR mode)
  const county = q.get("county");
  if (county) {
    const counties = county.split(",").map(c => c.trim()).filter(Boolean);
    if (counties.length > 0) {
      const placeholders = counties.map(() => p()).join(",");
      where.push(`countyorparish IN (${placeholders})`);
      params.push(...counties);
    }
  } else if (!isPR) {
    const placeholders = DEFAULT_COUNTIES.map(() => p()).join(",");
    where.push(`countyorparish IN (${placeholders})`);
    params.push(...DEFAULT_COUNTIES);
  }

  // City
  const city = q.get("city");
  if (city) {
    const clean = city.replace(/[^a-zA-Z0-9 \-.]/g, "").toUpperCase();
    if (clean) { where.push(`city = ${p()}`); params.push(clean); }
  }

  // Zip
  const zip = q.get("zip");
  if (zip) {
    const clean = zip.replace(/\D/g, "").slice(0, 10);
    if (clean) { where.push(`postalcode = ${p()}`); params.push(clean); }
  }

  // Price range
  const minPrice = parseFloat(q.get("min_price"));
  if (!isNaN(minPrice)) { where.push(`listprice >= ${p()}`); params.push(minPrice); }
  const maxPrice = parseFloat(q.get("max_price"));
  if (!isNaN(maxPrice)) { where.push(`listprice <= ${p()}`); params.push(maxPrice); }

  // Beds / baths
  const minBeds = parseInt(q.get("min_beds"));
  if (!isNaN(minBeds)) { where.push(`bedroomstotal >= ${p()}`); params.push(minBeds); }
  const minBaths = parseInt(q.get("min_baths"));
  if (!isNaN(minBaths)) { where.push(`bathroomstotalinteger >= ${p()}`); params.push(minBaths); }

  // Subtype
  const subtype = q.get("property_subtype");
  if (subtype) {
    const subs = subtype.split(",").map(s => s.trim()).filter(Boolean);
    if (subs.length) {
      const placeholders = subs.map(() => p()).join(",");
      where.push(`propertysubtype IN (${placeholders})`);
      params.push(...subs);
    }
  }

  // Bounds (map search) — sw_lat,sw_lng,ne_lat,ne_lng
  const bounds = q.get("bounds");
  if (bounds) {
    const [swLat, swLng, neLat, neLng] = bounds.split(",").map(Number);
    if ([swLat, swLng, neLat, neLng].every(n => !isNaN(n))) {
      where.push(`latitude BETWEEN ${p()} AND ${p()}`);
      params.push(swLat, neLat);
      where.push(`longitude BETWEEN ${p()} AND ${p()}`);
      params.push(swLng, neLng);
    }
  }

  // Waterfront / pool
  if (q.get("waterfront") === "1") {
    where.push("(waterfrontyn = true OR mfr_wateraccessyn = true)");
  }
  if (q.get("pool") === "1") {
    where.push("poolprivateyn = true");
  }
  if (q.get("new_construction") === "1") {
    where.push("newconstructionyn = 'true'");
  }
  if (q.get("garage") === "1") {
    where.push("garageyn = 'true'");
  }
  if (q.get("furnished") === "1") {
    where.push("furnished IS NOT NULL AND furnished != 'Unfurnished'");
  }
  if (q.get("water_view") === "1") {
    where.push("mfr_waterviewyn = 'true'");
  }
  if (q.get("no_hoa") === "1") {
    where.push("(associationyn = 'false' OR associationyn IS NULL)");
  }
  if (q.get("senior") === "1") {
    where.push("seniorcommunityyn = 'true'");
  }

  // Waterfront type
  const wfTypes = q.get("waterfront_type");
  if (wfTypes) {
    const types = wfTypes.split(",").map(t => t.trim()).filter(t => VALID_WF_TYPES.includes(t));
    if (types.length) {
      where.push("(" + types.map(() => `waterfront_type LIKE ${p()}`).join(" OR ") + ")");
      params.push(...types.map(t => `%${t}%`));
    }
  }

  // Year built
  const minYear = parseInt(q.get("min_year"));
  if (!isNaN(minYear)) { where.push(`yearbuilt >= ${p()}`); params.push(minYear); }
  const maxYear = parseInt(q.get("max_year"));
  if (!isNaN(maxYear)) { where.push(`yearbuilt <= ${p()}`); params.push(maxYear); }

  // Sqft
  const minSqft = parseFloat(q.get("min_sqft"));
  if (!isNaN(minSqft)) { where.push(`livingarea >= ${p()}`); params.push(minSqft); }
  const maxSqft = parseFloat(q.get("max_sqft"));
  if (!isNaN(maxSqft)) { where.push(`livingarea <= ${p()}`); params.push(maxSqft); }

  // Lot size (acres)
  const minLot = parseFloat(q.get("min_lot"));
  if (!isNaN(minLot)) { where.push(`lotsizeacres >= ${p()}`); params.push(minLot); }
  const maxLot = parseFloat(q.get("max_lot"));
  if (!isNaN(maxLot)) { where.push(`lotsizeacres <= ${p()}`); params.push(maxLot); }

  // Sort
  const sortKey = q.get("sort") || "newest";
  const orderBy = VALID_SORTS[sortKey] || VALID_SORTS.newest;

  // Pagination
  const page = Math.max(1, Math.min(1000, parseInt(q.get("page")) || 1));
  const perPage = Math.max(1, Math.min(MAX_PER_PAGE, parseInt(q.get("per_page")) || 20));
  const offset = (page - 1) * perPage;

  const whereSql = "WHERE " + where.join(" AND ");

  // Count
  const countResult = await client.query(
    `SELECT COUNT(*) as c FROM listings ${whereSql}`, params
  );
  const total = parseInt(countResult.rows[0]?.c ?? 0);

  // Results
  const cols = `listingkey, listingid, standardstatus, propertytype, propertysubtype,
    listprice, mfr_currentprice, unparsedaddress, city, stateorprovince, postalcode,
    countyorparish, bedroomstotal, bathroomstotalinteger, bathroomsfull, bathroomshalf,
    livingarea, lotsizeacres, yearbuilt, garagespaces, poolprivateyn, waterfrontyn,
    mfr_wateraccessyn, mfr_waterviewyn, waterfrontfeatures, photoscount, daysonmarket,
    onmarketdate, listingcontractdate, modificationtimestamp, latitude, longitude,
    subdivisionname, listagentfullname, listofficename,
    newconstructionyn, garageyn, furnished, seniorcommunityyn, associationyn,
    closeprice, closedate`;

  const results = await client.query(
    `SELECT ${cols} FROM listings ${whereSql} ORDER BY ${orderBy} LIMIT ${p()} OFFSET ${p()}`,
    [...params, perPage, offset]
  );

  return jsonResponse({
    listings: results.rows,
    total,
    pages: Math.ceil(total / perPage),
    page,
    per_page: perPage,
    has_more: results.rows.length === perPage,
  }, cors);
}

// ── Detail ──────────────────────────────────────────────────────

async function handleDetail(key, client, env, cors) {
  const clean = key.replace(/[^a-zA-Z0-9_-]/g, "");

  const result = await client.query(
    "SELECT * FROM listings WHERE listingkey = $1", [clean]
  );
  const row = result.rows[0];
  if (!row) return jsonResponse({ error: "Not found" }, cors, 404);

  // Construct photo URLs from standard path — no media table query needed
  const photoCount = row.photoscount || 0;
  const listingId = row.listingid || "";
  const MEDIA_BASE = env.R2_PUBLIC_URL || "https://media.foursailsrealestate.com";
  const media = [];
  for (let i = 0; i < photoCount; i++) {
    media.push({ r2_url: `${MEDIA_BASE}/photos/${listingId}/${i}.jpg`, Order_: i });
  }

  return jsonResponse({ ...row, media, source: "edge-pg" }, cors);
}

// ── Stats ───────────────────────────────────────────────────────

async function handleStats(client, cors) {
  const [statusRes, citiesRes, typesRes, syncRes, totalRes] = await Promise.all([
    client.query("SELECT standardstatus, COUNT(*) as count FROM listings WHERE mlgcanview = true GROUP BY standardstatus ORDER BY count DESC"),
    client.query("SELECT city, COUNT(*) as count FROM listings WHERE mlgcanview = true AND standardstatus = 'Active' GROUP BY city ORDER BY count DESC LIMIT 20"),
    client.query("SELECT propertytype, COUNT(*) as count FROM listings WHERE mlgcanview = true AND standardstatus = 'Active' GROUP BY propertytype ORDER BY count DESC"),
    client.query("SELECT * FROM sync_state WHERE id = 1"),
    client.query("SELECT COUNT(*) as c FROM listings WHERE standardstatus = 'Active'"),
  ]);

  return jsonResponse({
    status_counts: statusRes.rows,
    top_cities: citiesRes.rows,
    property_types: typesRes.rows,
    sync_state: syncRes.rows[0],
    active_count: parseInt(totalRes.rows[0]?.c ?? 0),
  }, cors);
}

// ── Lead Capture: Showing Request ───────────────────────────────

async function handleShowingRequest(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, cors, 400); }

  const { name = "", email = "", phone = "", preferred_date = "", preferred_time = "", message = "", listing_address = "", mls_number = "" } = body;
  if (!name || !email) return jsonResponse({ error: "Name and email are required" }, cors, 400);

  // TODO: move these to CF Worker secrets: CRM_API_TOKEN, CRM_CF_CLIENT_ID, CRM_CF_CLIENT_SECRET
  const CRM_TOKEN = "NubMEtYGRVVV_P5mAaJ-wUN4j7TjFiLJpRfK7-iKtX8"; // TODO: move to env.CRM_API_KEY once verified
  const CRM_CLIENT_ID = "54f3b5ea262af3e05491a8b8f7b6aec0.access";
  const CRM_CLIENT_SECRET = "1ca633018b84ab27ad517daa156c9ce866f9cbf04bb9d20d3504cfd4c095f170";
  const crmHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${CRM_TOKEN}`,
    "CF-Access-Client-Id": CRM_CLIENT_ID,
    "CF-Access-Client-Secret": CRM_CLIENT_SECRET,
  };

  const nameParts = name.trim().split(/\s+/);
  const first_name = nameParts[0] || name;
  const last_name = nameParts.slice(1).join(" ") || "";
  const notes = `Showing request for ${listing_address} MLS#${mls_number} - ${preferred_date} ${preferred_time}${message ? " - " + message : ""}`;

  const telegramMsg = `🏠 New Showing Request\n${name} wants to see ${listing_address} (MLS# ${mls_number})\n📅 ${preferred_date} ${preferred_time}\n📞 ${phone || "not provided"}\n✉️ ${email}`;
  const confirmationHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#F8F7F3"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table width="480" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)"><tr><td style="background:#1D3F60;padding:24px;text-align:center"><img src="https://assets.4sails.net/Logo%20OUtline%20Test%20copy.png" alt="Four Sails Real Estate" height="48" style="filter:brightness(0) invert(1)"><div style="color:#E3DEC3;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-top:8px">Four Sails Real Estate</div></td></tr><tr><td style="background:#ffffff;padding:32px"><h2 style="color:#1D3F60;margin:0 0 16px;font-size:20px">Your Showing Request</h2><p style="color:#374151;line-height:1.7;margin:0 0 12px">Thank you, ${escHtmlWorker(first_name)}! We've received your request to see:</p><div style="background:#F8F7F3;border-left:4px solid #1D3F60;padding:14px 18px;margin:16px 0;border-radius:0 6px 6px 0"><strong style="color:#1D3F60">${escHtmlWorker(listing_address)}</strong>${mls_number ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">MLS# ${escHtmlWorker(mls_number)}</div>` : ""}</div><p style="color:#374151;line-height:1.7;margin:0 0 12px">Requested date: <strong>${escHtmlWorker(preferred_date)}</strong> &bull; ${escHtmlWorker(preferred_time)}</p><p style="color:#374151;line-height:1.7;margin:0">We'll be in touch shortly to confirm the date and time. If you have any questions in the meantime, call us at <a href="tel:+19415002048" style="color:#1D3F60">(941) 500-2048</a>.</p></td></tr><tr><td style="background:#F8F7F3;padding:16px;text-align:center;font-size:11px;color:#9ca3af">&copy; 2026 Four Sails Real Estate &bull; Lauralyn Kazimir, Licensed Real Estate Broker</td></tr></table></td></tr></table></body></html>`;

  const results = await Promise.allSettled([
    // 1. CRM contact
    fetch("https://api.4sails.net/api/contacts", {
      method: "POST",
      headers: crmHeaders,
      body: JSON.stringify({ first_name, last_name, email, phone, lead_source: "idx_showing_request", notes }),
    }),
    // 2. CRM task
    fetch("https://api.4sails.net/api/tasks", {
      method: "POST",
      headers: crmHeaders,
      body: JSON.stringify({
        title: `Showing Request - ${listing_address}`,
        description: notes,
        priority: "high",
        domain: "re",
        task_type: "showing",
      }),
    }),
    // 3. Telegram alert
    env.TELEGRAM_BOT_TOKEN ? fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: "-1003784623764", text: telegramMsg }),
    }) : Promise.resolve(),
    // 4. Mailgun confirmation
    env.MAILGUN_API_KEY ? sendMailgun(env.MAILGUN_API_KEY, {
      from: "Four Sails Real Estate <info@foursails.vip>",
      to: email,
      subject: `Your Showing Request - ${listing_address}`,
      html: confirmationHtml,
    }) : Promise.resolve(),
  ]);

  // Log any failures but don't surface them to the user
  results.forEach((r, i) => { if (r.status === "rejected") console.error(`showingRequest action ${i} failed:`, r.reason); });

  return jsonResponse({ status: "ok" }, cors);
}

// ── Lead Capture: Listing Signup ─────────────────────────────────

async function handleSignup(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, cors, 400); }

  const { name = "", email = "", area = "", price_range = "" } = body;
  if (!name || !email) return jsonResponse({ error: "Name and email are required" }, cors, 400);

  // TODO: move these to CF Worker secrets: CRM_API_TOKEN, CRM_CF_CLIENT_ID, CRM_CF_CLIENT_SECRET
  const CRM_TOKEN = "NubMEtYGRVVV_P5mAaJ-wUN4j7TjFiLJpRfK7-iKtX8"; // TODO: move to env.CRM_API_KEY once verified
  const CRM_CLIENT_ID = "54f3b5ea262af3e05491a8b8f7b6aec0.access";
  const CRM_CLIENT_SECRET = "1ca633018b84ab27ad517daa156c9ce866f9cbf04bb9d20d3504cfd4c095f170";
  const crmHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${CRM_TOKEN}`,
    "CF-Access-Client-Id": CRM_CLIENT_ID,
    "CF-Access-Client-Secret": CRM_CLIENT_SECRET,
  };

  const nameParts = name.trim().split(/\s+/);
  const first_name = nameParts[0] || name;
  const last_name = nameParts.slice(1).join(" ") || "";
  const notes = `Listing signup via IDX. Area: ${area} | Budget: ${price_range}`;

  const telegramMsg = `📋 New Listing Signup\n${name} (${email})\nArea: ${area} | Budget: ${price_range}`;
  const confirmationHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#F8F7F3"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table width="480" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)"><tr><td style="background:#1D3F60;padding:24px;text-align:center"><img src="https://assets.4sails.net/Logo%20OUtline%20Test%20copy.png" alt="Four Sails Real Estate" height="48" style="filter:brightness(0) invert(1)"><div style="color:#E3DEC3;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-top:8px">Four Sails Real Estate</div></td></tr><tr><td style="background:#ffffff;padding:32px"><h2 style="color:#1D3F60;margin:0 0 16px;font-size:20px">Welcome to Four Sails Real Estate</h2><p style="color:#374151;line-height:1.7;margin:0 0 12px">Hi ${escHtmlWorker(first_name)}, thanks for signing up! We'll send you curated listings in <strong>${escHtmlWorker(area)}</strong> matching your budget of <strong>${escHtmlWorker(price_range)}</strong>.</p><p style="color:#374151;line-height:1.7;margin:0 0 12px">Our team handpicks properties that match your preferences — no spam, just great listings.</p><p style="color:#374151;line-height:1.7;margin:0">Questions? Call us at <a href="tel:+19415002048" style="color:#1D3F60">(941) 500-2048</a> or reply to this email.</p></td></tr><tr><td style="background:#F8F7F3;padding:16px;text-align:center;font-size:11px;color:#9ca3af">&copy; 2026 Four Sails Real Estate &bull; Lauralyn Kazimir, Licensed Real Estate Broker</td></tr></table></td></tr></table></body></html>`;

  const results = await Promise.allSettled([
    // 1. CRM contact
    fetch("https://api.4sails.net/api/contacts", {
      method: "POST",
      headers: crmHeaders,
      body: JSON.stringify({ first_name, last_name, email, lead_source: "idx_listing_signup", notes }),
    }),
    // 2. Telegram alert
    env.TELEGRAM_BOT_TOKEN ? fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: "-1003784623764", text: telegramMsg }),
    }) : Promise.resolve(),
    // 3. Mailgun confirmation
    env.MAILGUN_API_KEY ? sendMailgun(env.MAILGUN_API_KEY, {
      from: "Four Sails Real Estate <info@foursails.vip>",
      to: email,
      subject: "Welcome to Four Sails Real Estate",
      html: confirmationHtml,
    }) : Promise.resolve(),
  ]);

  results.forEach((r, i) => { if (r.status === "rejected") console.error(`signup action ${i} failed:`, r.reason); });

  return jsonResponse({ status: "ok" }, cors);
}

// ── Mailgun helper ───────────────────────────────────────────────

async function sendMailgun(apiKey, { from, to, subject, html }) {
  const form = new URLSearchParams();
  form.append("from", from);
  form.append("to", to);
  form.append("subject", subject);
  form.append("html", html);
  return fetch("https://api.mailgun.net/v3/mail.4sails.net/messages", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa("api:" + apiKey),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
}

function escHtmlWorker(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function jsonResponse(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
      ...cors,
    },
  });
}
