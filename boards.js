/**
 * Four Sails Life Boards — accounts + saved homes (Phase 2, 2026-07-09)
 *
 * Magic-link email auth (no passwords) + personal board of saved listings.
 * Session = HMAC-signed cookie scoped to .foursailsrealestate.com so it
 * works on the main Astro site AND this worker's hosts (search/idx2).
 *
 * Routes (all handled via handleBoardsRoute, called from worker fetch):
 *   POST   /api/auth/request-link   {email, name?, return_url?} → magic link email
 *   GET    /auth/verify?token=...   → set session cookie, redirect to return_url
 *   POST   /api/auth/logout         → clear cookie
 *   GET    /api/me                  → current user + board summary (401 if none)
 *   GET    /api/board               → full board: items + listing cards + saved searches
 *   POST   /api/board/items         {listing_key, note?} → save a home ("activation"!)
 *   DELETE /api/board/items/:key    → unsave
 *   GET    /api/board/shared/:tok   → public read-only board view (share link)
 *   POST   /api/events              {listing_key?, type, meta?} → behavior beacon
 *
 * Session secret lives in app_config (Neon) — generated on first use. This
 * avoids blocking on CF dashboard access; migrate to Secrets Store later.
 */

const COOKIE_NAME = "fs_session";
const COOKIE_DOMAIN = ".foursailsrealestate.com";
const SESSION_DAYS = 30;
const LINK_TTL_MIN = 15;
const DEFAULT_RETURN = "https://www.foursailsrealestate.com/";

const ALLOWED_ORIGINS = [
  "https://foursailsrealestate.com",
  "https://www.foursailsrealestate.com",
  "https://search.foursailsrealestate.com",
  "https://idx2.foursailsrealestate.com",
];

const EVENT_TYPES = ["view", "modal_open", "share_copy", "search"];

// ── CORS (credentialed — cookies require echoing a specific origin) ──

export function boardsCors(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[1];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

export function isBoardsPath(path) {
  return (
    path.startsWith("/api/auth/") ||
    path === "/api/me" ||
    path === "/api/board" ||
    path.startsWith("/api/board/") ||
    path === "/api/events" ||
    path === "/auth/verify"
  );
}

// ── Session crypto ──────────────────────────────────────────────

let cachedSecret = null;

async function getSessionSecret(client) {
  if (cachedSecret) return cachedSecret;
  // Single atomic upsert-with-RETURNING: returns the existing secret if one
  // is already stored, else persists our candidate. Write queries bypass
  // Hyperdrive's SELECT cache (a plain re-SELECT after INSERT can serve a
  // stale empty result — bit us on first deploy, 2026-07-09).
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const candidate = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const r = await client.query(
    `INSERT INTO app_config (key, value) VALUES ('session_secret', $1)
     ON CONFLICT (key) DO UPDATE SET value = app_config.value
     RETURNING value`,
    [candidate]
  );
  cachedSecret = r.rows[0].value;
  return cachedSecret;
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeSessionCookie(client, userId) {
  const secret = await getSessionSecret(client);
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = `${userId}.${exp}`;
  const sig = await hmacHex(secret, payload);
  const value = `${payload}.${sig}`;
  return `${COOKIE_NAME}=${value}; Domain=${COOKIE_DOMAIN}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Domain=${COOKIE_DOMAIN}; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function parseCookies(request) {
  const out = {};
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Returns {id, email, name} or null. Constant-time-ish HMAC verify. */
export async function getSessionUser(request, client) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (!/^\d+$/.test(uid) || !/^\d+$/.test(exp)) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  const secret = await getSessionSecret(client);
  const expect = await hmacHex(secret, `${uid}.${exp}`);
  if (expect.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  const r = await client.query("SELECT id, email, name FROM users WHERE id = $1", [Number(uid)]);
  return r.rows[0] || null;
}

// ── Helpers ───────────────────────────────────────────────

/**
 * Cache-bust nonce for SELECTs that must reflect a write the user just made
 * (stale cache = "I saved a home and my board is empty"). Hyperdrive's ~60s
 * query cache keys on SQL text + parameter values — but comments are STRIPPED
 * from the key (verified live 2026-07-09), so the nonce must be a real bound
 * parameter: append `AND $n::text <> ''` and pass nonce(). Boards traffic is
 * light; the extra DB roundtrips are fine.
 */
function nonce() {
  return crypto.randomUUID();
}

function safeReturnUrl(raw) {
  if (!raw) return DEFAULT_RETURN;
  try {
    const u = new URL(raw);
    if (ALLOWED_ORIGINS.includes(u.origin)) return u.href;
  } catch { /* relative or garbage */ }
  return DEFAULT_RETURN;
}

async function ensureBoard(client, userId) {
  // Atomic upsert — same Hyperdrive lesson as getSessionSecret: a SELECT here
  // can serve a ~60s-stale cached "no board" result right after creation,
  // which minted duplicate boards per user (caught in Life Boards UI E2E,
  // 2026-07-09). Writes bypass the cache; UNIQUE(user_id) enforces one board.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const shareToken = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const r = await client.query(
    `INSERT INTO boards (user_id, share_token) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET user_id = boards.user_id
     RETURNING id, name, share_token`,
    [userId, shareToken]);
  return r.rows[0];
}

const ITEM_LISTING_COLS = `l.listingkey, l.listingid, l.unparsedaddress, l.city,
  l.stateorprovince, l.postalcode, l.listprice, l.closeprice, l.standardstatus,
  l.bedroomstotal, l.bathroomstotalinteger, l.livingarea, l.primary_photo,
  l.waterfrontyn, l.propertysubtype, l.listingcontractdate, l.purchasecontractdate, l.closedate`;

async function boardItemsWithListings(client, boardId) {
  const r = await client.query(
    `SELECT bi.listing_key, bi.note, bi.created_at AS saved_at, ${ITEM_LISTING_COLS}
     FROM board_items bi
     LEFT JOIN listings l ON l.listingkey = bi.listing_key AND l.mlgcanview = true
     WHERE bi.board_id = $1 AND $2::text <> ''
     ORDER BY bi.created_at DESC`, [boardId, nonce()]);
  return r.rows;
}

// ── Main router (returns Response or null) ──────────────────────

export async function handleBoardsRoute(request, url, path, client, env, deps) {
  if (!isBoardsPath(path)) return null;
  const cors = boardsCors(request);
  const { jsonResponse } = deps;

  // -- Auth --------------------------------------------------------------
  if (request.method === "POST" && path === "/api/auth/request-link") {
    return await handleRequestLink(request, url, client, env, cors, deps);
  }
  if (request.method === "GET" && path === "/auth/verify") {
    return await handleVerify(url, client, deps);
  }
  if (request.method === "POST" && path === "/api/auth/logout") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookie(), ...cors },
    });
  }

  // -- Public shared board (no auth) --------------------------------------
  const sharedMatch = path.match(/^\/api\/board\/shared\/([a-f0-9]{32})$/);
  if (request.method === "GET" && sharedMatch) {
    const r = await client.query(
      `SELECT b.id, b.name, u.name AS owner_name FROM boards b
       JOIN users u ON u.id = b.user_id WHERE b.share_token = $1`, [sharedMatch[1]]);
    if (!r.rows.length) return jsonResponse({ error: "Board not found" }, cors, 404);
    const b = r.rows[0];
    const items = await boardItemsWithListings(client, b.id);
    const ownerFirst = (b.owner_name || "").trim().split(/\s+/)[0] || "";
    return jsonResponse({ board: { name: b.name, owner: ownerFirst }, items }, cors);
  }

  // -- Events beacon (auth optional) ---------------------------------------
  if (request.method === "POST" && path === "/api/events") {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, cors, 400); }
    const type = String(body.type || "");
    if (!EVENT_TYPES.includes(type)) return jsonResponse({ error: "Unknown event type" }, cors, 400);
    const user = await getSessionUser(request, client);
    const key = body.listing_key ? String(body.listing_key).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) : null;
    await client.query(
      "INSERT INTO events (user_id, listing_key, type, meta) VALUES ($1, $2, $3, $4)",
      [user ? user.id : null, key, type, body.meta ? JSON.stringify(body.meta).slice(0, 2000) : null]);
    return jsonResponse({ ok: true }, cors);
  }

  // -- Everything below requires a session ---------------------------------
  const user = await getSessionUser(request, client);
  if (!user) return jsonResponse({ error: "Not signed in" }, cors, 401);

  if (request.method === "GET" && path === "/api/me") {
    const board = await ensureBoard(client, user.id);
    const c = await client.query("SELECT count(*)::int AS n FROM board_items WHERE board_id = $1 AND $2::text <> ''", [board.id, nonce()]);
    const keys = await client.query("SELECT listing_key FROM board_items WHERE board_id = $1 AND $2::text <> ''", [board.id, nonce()]);
    return jsonResponse({
      user: { id: user.id, email: user.email, name: user.name },
      board: { id: board.id, name: board.name, share_token: board.share_token, item_count: c.rows[0].n },
      saved_keys: keys.rows.map((r) => r.listing_key),
    }, cors);
  }

  if (request.method === "GET" && path === "/api/board") {
    const board = await ensureBoard(client, user.id);
    const items = await boardItemsWithListings(client, board.id);
    const ss = await client.query(
      `SELECT id, search_name, criteria, frequency, created_at FROM saved_searches
       WHERE email = $1 AND active = true AND $2::text <> '' ORDER BY created_at DESC`, [user.email, nonce()]);
    return jsonResponse({
      user: { id: user.id, email: user.email, name: user.name },
      board: { id: board.id, name: board.name, share_token: board.share_token },
      items,
      saved_searches: ss.rows,
    }, cors);
  }

  if (request.method === "POST" && path === "/api/board/items") {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, cors, 400); }
    const key = String(body.listing_key || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (!key) return jsonResponse({ error: "listing_key required" }, cors, 400);
    const exists = await client.query("SELECT 1 FROM listings WHERE listingkey = $1 AND mlgcanview = true", [key]);
    if (!exists.rows.length) return jsonResponse({ error: "Listing not found" }, cors, 404);
    const board = await ensureBoard(client, user.id);
    const note = body.note ? String(body.note).slice(0, 500) : null;
    await client.query(
      `INSERT INTO board_items (board_id, listing_key, note, added_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, listing_key) DO UPDATE SET note = COALESCE(EXCLUDED.note, board_items.note)`,
      [board.id, key, note, user.id]);
    await client.query(
      "INSERT INTO events (user_id, listing_key, type) VALUES ($1, $2, 'save')", [user.id, key]);
    return jsonResponse({ ok: true, listing_key: key }, cors);
  }

  const delMatch = path.match(/^\/api\/board\/items\/([A-Za-z0-9_-]+)$/);
  if (request.method === "DELETE" && delMatch) {
    const board = await ensureBoard(client, user.id);
    await client.query(
      "DELETE FROM board_items WHERE board_id = $1 AND listing_key = $2", [board.id, delMatch[1]]);
    await client.query(
      "INSERT INTO events (user_id, listing_key, type) VALUES ($1, $2, 'unsave')", [user.id, delMatch[1]]);
    return jsonResponse({ ok: true }, cors);
  }

  return jsonResponse({ error: "Not found" }, cors, 404);
}

// ── Magic link: request + verify ────────────────────────────────

async function handleRequestLink(request, url, client, env, cors, deps) {
  const { jsonResponse, genToken, sendMailgun, fsWrap, FS_HEADER, escHtmlWorker } = deps;
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, cors, 400); }

  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jsonResponse({ error: "A valid email is required" }, cors, 400);
  }
  const name = String(body.name || "").trim().slice(0, 120);
  const returnUrl = safeReturnUrl(body.return_url);

  // Find-or-create user
  let r = await client.query("SELECT id, name FROM users WHERE email = $1", [email]);
  let userId;
  let isNew = false;
  if (r.rows.length) {
    userId = r.rows[0].id;
    if (name && !r.rows[0].name) {
      await client.query("UPDATE users SET name = $1 WHERE id = $2", [name, userId]);
    }
  } else {
    r = await client.query(
      "INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id", [email, name || null]);
    userId = r.rows[0].id;
    isNew = true;
  }

  // Light rate limit: one link per 60s per user
  const recent = await client.query(
    "SELECT 1 FROM auth_tokens WHERE user_id = $1 AND created_at > now() - interval '60 seconds'", [userId]);
  if (recent.rows.length) {
    return jsonResponse({ error: "A sign-in link was just sent — check your email" }, cors, 429);
  }

  const token = genToken() + genToken(); // 96 hex chars
  await client.query(
    `INSERT INTO auth_tokens (token, user_id, expires_at) VALUES ($1, $2, now() + interval '${LINK_TTL_MIN} minutes')`,
    [token, userId]);

  const verifyUrl = `${url.origin}/auth/verify?token=${token}&return=${encodeURIComponent(returnUrl)}`;
  const firstName = (name || "").split(/\s+/)[0] || "there";

  const emailRows = FS_HEADER +
    `<tr><td style="padding:32px 30px;">
      <h2 style="color:#1D3F60; font-family:Georgia, serif; font-size:20px; margin:0 0 14px;">Your sign-in link</h2>
      <p style="color:#444; font-size:14px; line-height:1.7; margin:0 0 18px;">Hi ${escHtmlWorker(firstName)}, tap the button below to sign in to <strong>Four Sails Life Boards</strong> — your saved homes and searches, all in one place.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 18px;"><tr><td style="background-color:#1D3F60; border-radius:4px;"><a href="${verifyUrl}" style="display:inline-block; padding:13px 34px; color:#E3DEC3; font-family:Georgia, serif; font-size:15px; letter-spacing:1px; text-decoration:none;">SIGN IN</a></td></tr></table>
      <p style="color:#888; font-size:12px; line-height:1.6; margin:0;">This link works once and expires in ${LINK_TTL_MIN} minutes. If you didn't request it, you can safely ignore this email.</p>
    </td></tr>` +
    `<tr><td style="background-color:#1D3F60; padding:16px 30px; text-align:center;">
      <p style="color:#aaa; font-size:11px; margin:0;">Four Sails Real Estate &middot; 2100 Constitution Blvd Suite #119, Sarasota, FL 34231 &middot; <a href="tel:9415002048" style="color:#E3DEC3; text-decoration:none;">941-500-2048</a></p>
    </td></tr>`;

  const actions = [
    env.MAILGUN_API_KEY ? sendMailgun(env.MAILGUN_API_KEY, {
      from: "Four Sails Real Estate <info@foursails.vip>",
      to: email,
      subject: "Sign in to Four Sails Life Boards",
      html: fsWrap("Sign in to Four Sails Life Boards", emailRows),
    }) : Promise.reject(new Error("no mailgun key")),
  ];

  // New signups → CRM (tagged boards; lead-source normalized server-side)
  if (isNew) {
    const nameParts = (name || "").split(/\s+/);
    actions.push(fetch("https://api.4sails.net/api/contacts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // TODO: move to Secrets Store (carried from handleSignup)
        "Authorization": "Bearer NubMEtYGRVVV_P5mAaJ-wUN4j7TjFiLJpRfK7-iKtX8",
        "CF-Access-Client-Id": "54f3b5ea262af3e05491a8b8f7b6aec0.access",
        "CF-Access-Client-Secret": "1ca633018b84ab27ad517daa156c9ce866f9cbf04bb9d20d3504cfd4c095f170",
      },
      body: JSON.stringify({
        first_name: nameParts[0] || email.split("@")[0],
        last_name: nameParts.slice(1).join(" ") || "",
        email,
        lead_source: "life_boards",
        notes: "Signed up for Four Sails Life Boards (saved homes account).",
      }),
    }));
  }

  const results = await Promise.allSettled(actions);
  if (results[0].status === "rejected") {
    console.error("magic-link email failed:", results[0].reason);
    return jsonResponse({ error: "Couldn't send the sign-in email — please try again" }, cors, 502);
  }
  return jsonResponse({ ok: true, message: "Check your email for a sign-in link" }, cors);
}

async function handleVerify(url, client, deps) {
  const token = String(url.searchParams.get("token") || "").replace(/[^a-f0-9]/g, "");
  const returnUrl = safeReturnUrl(url.searchParams.get("return"));

  const fail = (msg) => new Response(
    `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign-in link — Four Sails Real Estate</title></head>
     <body style="font-family:Georgia,serif;background:#F8F7F3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
     <div style="background:#fff;border-radius:8px;padding:40px;max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)">
     <h2 style="color:#1D3F60;margin:0 0 12px">${msg}</h2>
     <p style="color:#666;font-size:14px;line-height:1.6">Sign-in links work once and expire after ${LINK_TTL_MIN} minutes. Head back and request a fresh one.</p>
     <a href="${returnUrl}" style="color:#1D3F60">&larr; Back to Four Sails Real Estate</a></div></body></html>`,
    { status: 400, headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" } });

  if (!token) return fail("That link isn't valid");

  const r = await client.query(
    `UPDATE auth_tokens SET used_at = now()
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`, [token]);
  if (!r.rows.length) return fail("That link has expired");

  const userId = r.rows[0].user_id;
  await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
  await ensureBoard(client, userId);
  await client.query("INSERT INTO events (user_id, type) VALUES ($1, 'login')", [userId]);

  const cookie = await makeSessionCookie(client, userId);
  return new Response(null, {
    status: 302,
    headers: { "Location": returnUrl, "Set-Cookie": cookie },
  });
}
