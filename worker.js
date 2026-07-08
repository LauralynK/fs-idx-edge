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

// ── Area pages (2026-07-07) ─────────────────────────────────────
// Replaces IDX Broker area widgets on foursailsrealestate.com.
// Barrier-island areas use point-in-polygon (Postgres native geometry).
// MK south = Census CDP boundary (Charlotte half, simplified); MK north +
// Casey Key = boundaries derived from listing data and verified against
// live listings (all matches on-island streets, zero mainland intruders).
// All values below are server-side constants — safe to inline in SQL.
const MK_POLY_SOUTH = "((-82.37425,26.94604),(-82.37379,26.94521),(-82.37314,26.94402),(-82.36982,26.93798),(-82.36968,26.93777),(-82.36878,26.9365),(-82.36804,26.93544),(-82.3674,26.93446),(-82.36601,26.93221),(-82.3645,26.92972),(-82.36385,26.92864),(-82.36368,26.92837),(-82.36318,26.92761),(-82.36295,26.92725),(-82.36263,26.92676),(-82.36099,26.92397),(-82.36065,26.92339),(-82.36026,26.92284),(-82.3585,26.9197),(-82.35755,26.91803),(-82.35727,26.91752),(-82.35682,26.91673),(-82.35542,26.9143),(-82.3538,26.91171),(-82.35332,26.91099),(-82.35329,26.91095),(-82.35256,26.90984),(-82.35065,26.90697),(-82.34553,26.89923),(-82.34496,26.89817),(-82.34433,26.89714),(-82.3437,26.89622),(-82.34295,26.89525),(-82.34222,26.89439),(-82.34205,26.89435),(-82.34198,26.8945),(-82.34224,26.89532),(-82.34226,26.8955),(-82.34218,26.89566),(-82.34208,26.89582),(-82.34206,26.89599),(-82.34208,26.89617),(-82.34216,26.89634),(-82.34218,26.8965),(-82.34215,26.89668),(-82.34206,26.89684),(-82.34193,26.89698),(-82.34064,26.89806),(-82.33908,26.90027),(-82.33583,26.90587),(-82.33626,26.90776),(-82.33714,26.90925),(-82.34018,26.91433),(-82.34242,26.91775),(-82.34606,26.92347),(-82.34971,26.92903),(-82.35235,26.93371),(-82.353,26.93444),(-82.35323,26.93456),(-82.35363,26.93464),(-82.35599,26.93653),(-82.35775,26.93896),(-82.36164,26.94607),(-82.36512,26.94614),(-82.37056,26.94606),(-82.3726,26.94604),(-82.37424,26.94604),(-82.37425,26.94604))";
const MK_POLY_NORTH = "((-82.475,27.036),(-82.475,26.94),(-82.356,26.94),(-82.3635,26.955),(-82.3705,26.96),(-82.379,26.97),(-82.3835,26.98),(-82.3945,26.99),(-82.4033,27.0),(-82.4088,27.01),(-82.4138,27.02),(-82.4197,27.03),(-82.4225,27.036))";
const CASEY_KEY_POLY = "((-82.515,27.198),(-82.499,27.196),(-82.4965,27.192),(-82.4945,27.186),(-82.494,27.18),(-82.493,27.174),(-82.489,27.168),(-82.4848,27.162),(-82.482,27.156),(-82.479,27.15),(-82.4762,27.142),(-82.474,27.136),(-82.4706,27.131),(-82.469,27.125),(-82.4665,27.118),(-82.464,27.112),(-82.475,27.11),(-82.495,27.15))";
const WELLEN_SUBS_SQL = ["%WELLEN%", "GRAN PARADISO%", "ISLANDWALK%", "RENAISSANCE%WEST%",
  "%WEST VILLAGE%", "%WEST VLGS%", "SOLSTICE%", "OASIS%", "TORTUGA", "EVERLY%",
  "WYSTERIA%", "%VILLAGE K TOWNHOMES%"]
  .map((s) => `subdivisionname ILIKE '${s}'`).join(" OR ");

const AREAS = {
  "manasota-key": {
    name: "Manasota Key",
    where: `(latitude IS NOT NULL AND (point(longitude,latitude) <@ '${MK_POLY_SOUTH}'::polygon OR point(longitude,latitude) <@ '${MK_POLY_NORTH}'::polygon))`,
  },
  "casey-key": {
    name: "Casey Key",
    where: `(latitude IS NOT NULL AND point(longitude,latitude) <@ '${CASEY_KEY_POLY}'::polygon)`,
  },
  "venice": { name: "Venice", where: `city = 'VENICE'` },
  "englewood": { name: "Englewood", where: `city = 'ENGLEWOOD'` },
  "sarasota": { name: "Sarasota", where: `city = 'SARASOTA'` },
  "nokomis-osprey": { name: "Nokomis & Osprey", where: `city IN ('NOKOMIS','OSPREY')` },
  "boca-grande": { name: "Boca Grande", where: `city = 'BOCA GRANDE'` },
  "wellen-park": { name: "Wellen Park", where: `(city IN ('VENICE','NORTH PORT') AND (${WELLEN_SUBS_SQL}))` },
  "boca-royale": { name: "Boca Royale", where: `(city = 'ENGLEWOOD' AND subdivisionname ILIKE 'BOCA ROYALE%')` },
};


// Secrets may arrive as classic per-worker secrets (plain string) or as
// account Secrets Store bindings (object with .get()). Normalize to strings.
async function resolveSecrets(env) {
  for (const k of ["MAILGUN_API_KEY", "TELEGRAM_BOT_TOKEN"]) {
    if (env[k] && typeof env[k].get === "function") {
      try { env[k] = await env[k].get(); } catch (e) { console.error(`secret ${k}: ${e.message}`); env[k] = null; }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    await resolveSecrets(env);

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

    // ── Design preview (temporary, 2026-07-08): native listing-card mock
    // for the foursailsrealestate.com Astro cutover. Static, noindex.
    // Remove once the native area components ship.
    if (path === "/preview/cards") {
      return new Response(PREVIEW_CARDS_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Robots-Tag": "noindex, nofollow",
          "Cache-Control": "no-store",
        },
      });
    }

    // Connect to Postgres via Hyperdrive
    const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });

    try {
      await client.connect();

      if (request.method === "POST" && path === "/api/saved-searches") {
        return await handleSaveSearch(request, client, env, corsHeaders);
      }
      if (path === "/unsubscribe") {
        return await handleUnsubscribe(url, client, corsHeaders);
      }
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
        return jsonResponse({
          status: "ok", edge: true, db: "neon",
          // Presence booleans only — helps diagnose silent lead-form/alert failures
          secrets: {
            mailgun: !!env.MAILGUN_API_KEY,
            telegram: !!env.TELEGRAM_BOT_TOKEN,
          },
        }, corsHeaders);
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
      // Area pages (2026-07-07): /area/:slug = pre-filtered search page;
      // /area/:slug/widget = embeddable branded hotsheet for the main site
      // (replaces IDX Broker <script> widgets on Astro area pages).
      const areaMatch = path.match(/^\/area\/([a-z0-9-]+)(\/widget)?\/?$/);
      if (areaMatch && AREAS[areaMatch[1]]) {
        if (areaMatch[2]) {
          return await handleAreaWidget(areaMatch[1], url, client, corsHeaders);
        }
        const a = AREAS[areaMatch[1]];
        const inject =
          `<script>window.__AREA__=${JSON.stringify({ slug: areaMatch[1], name: a.name })}</script></head>`;
        return new Response(SEARCH_HTML.replace("</head>", inject), {
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
        });
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return jsonResponse({ error: err.message }, corsHeaders, 500);
    } finally {
      await client.end();
    }
  },

  // Saved-search alerts — cron fires every 15 min (wrangler.toml [triggers]).
  // Instant searches check every run; daily send ~9 AM ET; weekly Monday; monthly the 1st.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processSavedSearchAlerts(env));
  },
};

// ── Search ──────────────────────────────────────────────────────

function titleCaseCity(s) {
  return s ? String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : "";
}

// Shared WHERE-clause builder — used by /api/listings AND the saved-search
// alert scheduler, so saved criteria match exactly what the site shows.
function buildListingFilters(q) {
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

  // Area pages: pre-baked geographic filters (see AREAS). Slug is validated
  // against the AREAS map — unknown values are ignored.
  const areaSlug = q.get("area");
  if (areaSlug && AREAS[areaSlug]) {
    where.push(AREAS[areaSlug].where);
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

  return { where, params };
}

async function handleSearch(q, client, env, cors) {
  const { where, params } = buildListingFilters(q);

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
    `SELECT ${cols} FROM listings ${whereSql} ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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

// ── Area widget: embeddable branded hotsheet ────────────────────
// Iframed on foursailsrealestate.com area pages (replaces IDX Broker
// widgets). ?status=Active|Closed  ?limit=1..12 (default 6).
async function handleAreaWidget(slug, url, client, cors) {
  const a = AREAS[slug];
  const q = url.searchParams;
  const sold = q.get("status") === "Closed";
  const limit = Math.max(1, Math.min(12, parseInt(q.get("limit")) || 6));

  const fq = new URLSearchParams({ area: slug, status: sold ? "Closed" : "Active" });
  const { where, params } = buildListingFilters(fq);
  if (sold) where.push("closedate >= (CURRENT_DATE - INTERVAL '12 months')");
  const whereSql = "WHERE " + where.join(" AND ");
  const orderBy = sold ? "closedate DESC NULLS LAST" : "listingcontractdate DESC NULLS LAST";

  const countR = await client.query(`SELECT COUNT(*) c FROM listings ${whereSql}`, params);
  const total = parseInt(countR.rows[0]?.c ?? 0);
  const r = await client.query(
    `SELECT listingkey, listingid, unparsedaddress, city, listprice, closeprice, closedate,
            standardstatus, bedroomstotal, bathroomstotalinteger, livingarea, photoscount
     FROM listings ${whereSql} ORDER BY ${orderBy} LIMIT ${limit}`, params);

  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmtP = (n) => n ? "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "";
  const viewAll = `${SITE_ORIGIN}/area/${slug}${sold ? "#status=Closed" : ""}`;
  const logo = "https://assets.4sails.net/Logo%20OUtline%20Test%20copy.png";

  const cards = r.rows.map((l) => {
    const link = `${SITE_ORIGIN}/listing/${encodeURIComponent(l.listingkey)}`;
    const price = sold && l.closeprice ? l.closeprice : l.listprice;
    const photo = l.photoscount > 0
      ? `<img src="https://media.foursailsrealestate.com/photos/${esc(l.listingid)}/0.jpg" alt="" loading="lazy" onerror="this.onerror=null;this.src='${logo}';this.style.objectFit='contain';this.style.padding='24px';this.style.filter='brightness(0) invert(1)';this.style.opacity='.6'">`
      : `<img src="${logo}" alt="" style="object-fit:contain;padding:24px;filter:brightness(0) invert(1);opacity:.6">`;
    const soldTag = sold && l.closedate
      ? `<span class="tag">SOLD ${new Date(l.closedate).toLocaleDateString("en-US", { month: "short", year: "numeric" })}</span>` : "";
    const bits = [];
    if (l.bedroomstotal != null) bits.push(`<strong>${l.bedroomstotal}</strong> bd`);
    if (l.bathroomstotalinteger != null) bits.push(`<strong>${l.bathroomstotalinteger}</strong> ba`);
    if (l.livingarea) bits.push(`<strong>${Number(l.livingarea).toLocaleString("en-US")}</strong> sqft`);
    return `<a class="wcard" href="${link}" target="_top" rel="noopener"><span class="wphoto">${photo}${soldTag}</span><span class="wbody"><span class="wprice">${fmtP(price)}</span><span class="waddr">${esc(l.unparsedaddress || "")}</span><span class="wdet">${bits.join(" \u00b7 ")}</span></span></a>`;
  }).join("");

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(a.name)} \u2014 Four Sails Real Estate</title><style>
body{margin:0;padding:0;background:transparent;font-family:'Lato',-apple-system,'Segoe UI',sans-serif}
.wgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px;padding:2px}
.wcard{display:block;text-decoration:none;background:#fff;border:1px solid #e5e2da;border-radius:8px;overflow:hidden;transition:box-shadow .15s,transform .15s}
.wcard:hover{box-shadow:0 6px 18px rgba(29,63,96,.18);transform:translateY(-2px)}
.wphoto{display:block;position:relative;height:160px;background:#1D3F60}
.wphoto img{width:100%;height:100%;object-fit:cover;display:block}
.tag{position:absolute;top:10px;left:10px;background:#1D3F60;color:#E3DEC3;font-size:.65rem;font-weight:700;letter-spacing:1px;padding:4px 10px;border-radius:3px}
.wbody{display:block;padding:12px 14px}
.wprice{display:block;font-family:Georgia,serif;color:#1D3F60;font-size:1.15rem;font-weight:700}
.waddr{display:block;color:#444;font-size:.8rem;margin:4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wdet{display:block;color:#777;font-size:.75rem}
.wfoot{text-align:center;padding:16px 8px 6px}
.wall{display:inline-block;background:#E3DEC3;color:#1D3F60;font-weight:700;font-size:.8rem;letter-spacing:.5px;padding:10px 26px;border-radius:4px;text-decoration:none}
.wall:hover{background:#d9d2b2}
.wattr{color:#999;font-size:.62rem;text-align:center;padding:10px 12px 6px;line-height:1.5}
.wempty{color:#666;font-family:Georgia,serif;text-align:center;padding:30px 12px}
</style></head><body>
${r.rows.length ? `<div class="wgrid">${cards}</div>` : `<div class="wempty">No ${sold ? "recent sales" : "active listings"} right now \u2014 check back soon.</div>`}
<div class="wfoot"><a class="wall" href="${viewAll}" target="_top" rel="noopener">VIEW ALL ${total.toLocaleString("en-US")} ${esc(a.name.toUpperCase())} ${sold ? "SALES (12 MO)" : "LISTINGS"} \u2192</a></div>
<div class="wattr">Listings courtesy of Stellar MLS as distributed by MLS GRID. IDX information is provided exclusively for consumers' personal, non-commercial use. Listing information \u00a9 ${new Date().getFullYear()} Stellar MLS.</div>
</body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=900",
      "X-Robots-Tag": "noindex",
      ...cors,
    },
  });
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

// ── Saved Searches: create, unsubscribe, scheduled email alerts ──

const SITE_ORIGIN = "https://idx2.foursailsrealestate.com";
const ALERT_FREQUENCIES = ["instant", "daily", "weekly", "monthly"];
const FREQUENCY_TEXT = {
  instant: "as soon as new listings appear",
  daily: "a daily digest (mornings)",
  weekly: "a weekly digest (Monday mornings)",
  monthly: "a monthly digest (1st of the month)",
};
const CRITERIA_KEYS = [
  "region", "county", "city", "zip", "min_price", "max_price", "min_beds", "min_baths",
  "min_sqft", "max_sqft", "min_lot", "max_lot", "min_year", "max_year",
  "property_type", "property_subtype", "waterfront", "waterfront_type", "pool",
  "new_construction", "garage", "furnished", "water_view", "no_hoa", "senior", "status",
];

function genToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Four Sails brand email components (per EMAIL-STANDARDS.md) ───────

const FS_ASSETS = "https://assets.4sails.net";

const FS_HEADER = `<tr><td style="background-color:#1D3F60; padding:20px 30px; text-align:center;"><table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td style="vertical-align:middle; padding-right:15px;"><img src="${FS_ASSETS}/Logo%20OUtline%20Test%20copy.png" width="55" height="55" alt="Four Sails Real Estate" style="display:block;"></td><td style="vertical-align:middle; text-align:center;"><span style="color:#ffffff; font-size:16px; letter-spacing:3px; font-family:Georgia, serif; display:block; line-height:1.3;">FOUR SAILS REAL ESTATE</span><span style="color:#E3DEC3; font-size:11px; letter-spacing:4px; font-family:Georgia, serif; display:block; line-height:1.3;">LOVE YOUR NEIGHBORHOOD</span></td></tr></table></td></tr>`;

function fsSignatureCard(headshotUrl, name, title, email, marginBottom) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-radius:6px; overflow:hidden; border:1px solid #e8e8e8;${marginBottom ? " margin-bottom:12px;" : ""}"><tr><td width="100" style="width:100px;"><img src="${headshotUrl}" alt="${name.replace(/"/g, "&quot;")}" width="100" style="width:100px; height:100px; object-fit:cover; display:block;"></td><td valign="middle" style="padding:12px 16px;"><p style="margin:0 0 3px; color:#1D3F60; font-size:15px; font-weight:700; font-family:Georgia, serif;">${name}</p><p style="margin:0 0 10px; color:#888; font-size:11px; letter-spacing:1.5px;">${title}</p><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:0 8px 6px 0; vertical-align:middle;"><a href="tel:9415002048"><img src="${FS_ASSETS}/icon-phone2.png" alt="Phone" width="16" height="16" style="width:16px; height:16px; display:block;"></a></td><td style="padding:0 0 6px 0; vertical-align:middle;"><a href="tel:9415002048" style="color:#1D3F60; text-decoration:none; font-size:13px;">941-500-2048</a></td></tr><tr><td style="padding:0 8px 0 0; vertical-align:middle;"><a href="mailto:${email}"><img src="${FS_ASSETS}/icon-email2.png" alt="Email" width="16" height="16" style="width:16px; height:16px; display:block;"></a></td><td style="padding:0; vertical-align:middle;"><a href="mailto:${email}" style="color:#1D3F60; text-decoration:none; font-size:13px;">${email}</a></td></tr></table></td></tr></table>`;
}

const FS_DUAL_SIGNATURE =
  `<tr><td style="padding:0 30px;"><hr style="border:none; border-top:1px solid #e8e8e8; margin:0;"></td></tr>` +
  `<tr><td style="padding:20px 30px;"><p style="margin:0 0 14px; color:#444; font-size:14px; font-family:Georgia, serif;">Warm regards,</p>` +
  fsSignatureCard(`${FS_ASSETS}/Lauralyn%20Kazimir%20%E2%80%93%20Licensed%20Real%20Estate%20Broker%2C%20Four%20Sails%20Real%20Estate.jpg`, `Lauralyn "Laurie" Kazimir`, "LICENSED REAL ESTATE BROKER", "laurie@foursails.vip", true) +
  fsSignatureCard(`${FS_ASSETS}/Christian%20Kazimir%20%E2%80%93%20Broker%20Associate%2C%20Four%20Sails%20Real%20Estate.jpeg`, "Christian Kazimir", "BROKER ASSOCIATE", "christian@foursails.vip", false) +
  `</td></tr>`;

function fsFooter(unsubUrl, extra = "") {
  return `<tr><td style="background-color:#1D3F60; padding:20px 30px; text-align:center;"><p style="color:#ffffff; font-size:13px; margin:0 0 4px 0;">Four Sails Real Estate</p><p style="color:#aaa; font-size:11px; margin:0 0 4px 0;">2100 Constitution Blvd Suite #119, Sarasota, FL 34231</p><p style="color:#aaa; font-size:11px; margin:0 0 12px 0;"><a href="tel:9415002048" style="color:#E3DEC3; text-decoration:none;">941-500-2048</a> &nbsp;|&nbsp; <a href="https://www.foursailsrealestate.com" style="color:#E3DEC3; text-decoration:none;">foursailsrealestate.com</a></p><p style="color:#888; font-size:10px; letter-spacing:1px; margin:0 0 10px 0;">REALTOR&reg; &nbsp;|&nbsp; EQUAL HOUSING OPPORTUNITY</p>${extra}<p style="color:#888; font-size:10px; margin:0;"><a href="${unsubUrl}" style="color:#888; text-decoration:underline;">Unsubscribe</a></p></td></tr>`;
}

function fsWrap(title, innerRows) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title></head><body style="margin:0; padding:0; background-color:#F8F7F3; font-family:Georgia, 'Times New Roman', serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F8F7F3;"><tr><td align="center" style="padding:20px 10px;"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:4px; overflow:hidden; max-width:600px; width:100%;">${innerRows}</table></td></tr></table></body></html>`;
}

function criteriaSummary(c) {
  const bits = [];
  const fmtP = (n) => "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (c.area && AREAS[c.area]) bits.push(AREAS[c.area].name);
  if (c.region === "PR") bits.push("Puerto Rico");
  if (c.county) bits.push(c.county.split(",").join(", "));
  if (c.city) bits.push(titleCaseCity(c.city));
  if (c.zip) bits.push("ZIP " + c.zip);
  if (c.property_subtype) bits.push(c.property_subtype.split(",").join(", "));
  if (c.min_price && c.max_price) bits.push(fmtP(c.min_price) + "\u2013" + fmtP(c.max_price));
  else if (c.min_price) bits.push(fmtP(c.min_price) + "+");
  else if (c.max_price) bits.push("Under " + fmtP(c.max_price));
  if (c.min_beds) bits.push(c.min_beds + "+ bd");
  if (c.min_baths) bits.push(c.min_baths + "+ ba");
  if (c.waterfront === "1") bits.push("Waterfront");
  if (c.pool === "1") bits.push("Pool");
  if (c.new_construction === "1") bits.push("New Construction");
  if (c.no_hoa === "1") bits.push("No HOA");
  if (c.status && c.status !== "Active" && c.status.toUpperCase() !== "ALL") bits.push(c.status === "Closed" ? "Sold" : c.status);
  return bits.join(" \u00b7 ") || "All residential listings";
}

// Deep-link back to the search UI — the site restores filters from the hash.
function criteriaLink(c) {
  const entries = Object.entries(c).filter(([k, v]) => v && k !== "region" && k !== "area");
  const hash = entries.map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  let base = SITE_ORIGIN + "/";
  if (c.region === "PR") base = SITE_ORIGIN + "/pr";
  else if (c.area && AREAS[c.area]) base = SITE_ORIGIN + "/area/" + c.area;
  return hash ? base + "#" + hash : base;
}

async function handleSaveSearch(request, client, env, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, cors, 400); }

  const name = String(body.name || "").trim().slice(0, 120);
  const email = String(body.email || "").trim().slice(0, 200).toLowerCase();
  const searchName = String(body.search_name || "").trim().slice(0, 120);
  const frequency = ALERT_FREQUENCIES.includes(body.frequency) ? body.frequency : "daily";
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jsonResponse({ error: "Name and a valid email are required" }, cors, 400);
  }

  // Sanitize criteria: known keys only, string values, capped length
  const rawCriteria = body.criteria && typeof body.criteria === "object" ? body.criteria : {};
  const criteria = {};
  for (const k of CRITERIA_KEYS) {
    if (rawCriteria[k] != null && String(rawCriteria[k]).trim() !== "") {
      criteria[k] = String(rawCriteria[k]).slice(0, 200);
    }
  }

  const token = genToken();
  await client.query(
    `INSERT INTO saved_searches (email, subscriber_name, search_name, criteria, frequency, unsubscribe_token)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [email, name, searchName, JSON.stringify(criteria), frequency, token]
  );

  // TODO: move these to CF Worker secrets: CRM_API_TOKEN, CRM_CF_CLIENT_ID, CRM_CF_CLIENT_SECRET
  const CRM_TOKEN = "NubMEtYGRVVV_P5mAaJ-wUN4j7TjFiLJpRfK7-iKtX8";
  const CRM_CLIENT_ID = "54f3b5ea262af3e05491a8b8f7b6aec0.access";
  const CRM_CLIENT_SECRET = "1ca633018b84ab27ad517daa156c9ce866f9cbf04bb9d20d3504cfd4c095f170";
  const crmHeaders = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${CRM_TOKEN}`,
    "CF-Access-Client-Id": CRM_CLIENT_ID,
    "CF-Access-Client-Secret": CRM_CLIENT_SECRET,
  };

  const nameParts = name.split(/\s+/);
  const first_name = nameParts[0] || name;
  const last_name = nameParts.slice(1).join(" ") || "";
  const summary = criteriaSummary(criteria);
  const notes = `Saved search via IDX${searchName ? ` \u201c${searchName}\u201d` : ""} \u2014 ${frequency} alerts. Criteria: ${summary}`;
  const telegramMsg = `\ud83d\udd14 New Saved Search\n${name} (${email})\n${summary}\nAlerts: ${frequency}`;

  const unsubUrl = `${SITE_ORIGIN}/unsubscribe?token=${token}`;
  const confirmationHtml = fsWrap("Your Listing Alerts Are Active", FS_HEADER +
    `<tr><td style="padding:24px 30px 8px;"><h2 style="color:#1D3F60; margin:0 0 14px; font-size:20px; font-family:Georgia, serif;">Your Listing Alerts Are Active</h2><p style="color:#333; font-size:14px; line-height:1.7; margin:0 0 12px;">Hi ${escHtmlWorker(first_name)}, we saved your search${searchName ? ` <strong>\u201c${escHtmlWorker(searchName)}\u201d</strong>` : ""}:</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;"><tr><td style="background-color:#F8F7F3; border-left:4px solid #1D3F60; padding:14px 18px; border-radius:0 6px 6px 0;"><strong style="color:#1D3F60; font-size:14px;">${escHtmlWorker(summary)}</strong></td></tr></table><p style="color:#333; font-size:14px; line-height:1.7; margin:0 0 12px;">You'll receive ${FREQUENCY_TEXT[frequency]} whenever new or updated listings match.</p><p style="color:#333; font-size:14px; line-height:1.7; margin:0 0 8px;">Questions? Call us at <a href="tel:9415002048" style="color:#1D3F60;">941-500-2048</a> or reply to this email.</p></td></tr>` +
    FS_DUAL_SIGNATURE + fsFooter(unsubUrl));

  const results = await Promise.allSettled([
    // 1. CRM contact (lead capture)
    fetch("https://api.4sails.net/api/contacts", {
      method: "POST",
      headers: crmHeaders,
      body: JSON.stringify({ first_name, last_name, email, lead_source: "idx_saved_search", notes }),
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
      subject: "Your Listing Alerts Are Active \u2014 Four Sails Real Estate",
      html: confirmationHtml,
    }) : Promise.resolve(),
  ]);
  results.forEach((r, i) => { if (r.status === "rejected") console.error(`saveSearch action ${i} failed:`, r.reason); });

  return jsonResponse({ status: "ok" }, cors);
}

async function handleUnsubscribe(url, client, cors) {
  const token = (url.searchParams.get("token") || "").replace(/[^a-f0-9]/gi, "").slice(0, 64);
  let ok = false;
  if (token) {
    const r = await client.query(
      "UPDATE saved_searches SET active = false WHERE unsubscribe_token = $1 RETURNING id", [token]);
    ok = r.rows.length > 0;
  }
  const title = ok ? "You're Unsubscribed" : "Link Not Recognized";
  const msg = ok
    ? "You won't receive any more alerts for this saved search. You can create a new one anytime at our search page."
    : "We couldn't find that saved search \u2014 it may already be unsubscribed. If you keep receiving alerts, reply to any alert email and we'll take care of it.";
  const html = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} \u2014 Four Sails Real Estate</title></head><body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#F8F7F3"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:48px 16px"><table width="480" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1)"><tr><td style="background:#1D3F60;padding:24px;text-align:center"><img src="https://assets.4sails.net/Logo%20OUtline%20Test%20copy.png" alt="Four Sails Real Estate" height="48" style="filter:brightness(0) invert(1)"></td></tr><tr><td style="background:#ffffff;padding:32px;text-align:center"><h2 style="color:#1D3F60;margin:0 0 12px">${title}</h2><p style="color:#374151;line-height:1.7;margin:0 0 20px">${msg}</p><a href="${SITE_ORIGIN}/" style="display:inline-block;background:#1D3F60;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold">Back to Search</a></td></tr><tr><td style="background:#F8F7F3;padding:16px;text-align:center;font-size:11px;color:#9ca3af">&copy; 2026 Four Sails Real Estate &bull; Lauralyn Kazimir, Licensed Real Estate Broker</td></tr></table></td></tr></table></body></html>`;
  return new Response(html, { status: ok ? 200 : 404, headers: { "Content-Type": "text/html; charset=utf-8", ...cors } });
}

// ── Alert scheduler ─────────────────────────────────────────────

function etParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    hour: parseInt(get("hour"), 10) % 24,
    weekday: get("weekday"),
    day: parseInt(get("day"), 10),
  };
}

// Instant: due every run. Daily/weekly/monthly: at/after 9 AM ET on the due
// day, once per day (last_checked_at gates re-checks; last_alerted_at windows content).
function isDue(s, now) {
  if (s.frequency === "instant") return true;
  if (now.hour < 9) return false;
  if (s.frequency === "weekly" && now.weekday !== "Mon") return false;
  if (s.frequency === "monthly" && now.day !== 1) return false;
  if (!s.last_checked_at) return true;
  return etParts(new Date(s.last_checked_at)).dateKey !== now.dateKey;
}

async function processSavedSearchAlerts(env) {
  await resolveSecrets(env);
  if (!env.MAILGUN_API_KEY) { console.error("saved-search alerts: MAILGUN_API_KEY not set, skipping run"); return; }
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT * FROM saved_searches WHERE active = true ORDER BY id");
    if (!rows.length) return;
    const nowET = etParts(new Date());
    for (const s of rows) {
      try {
        if (!isDue(s, nowET)) continue;
        const since = s.last_alerted_at || s.created_at;
        const q = new URLSearchParams(s.criteria || {});
        const { where, params } = buildListingFilters(q);
        // Window on updated_at (DB ingest time), not modificationtimestamp:
        // while sync catches up a backlog, listings arrive with older MLS
        // timestamps — ingest time is when they become new to OUR site.
        where.push(`updated_at > $${params.length + 1}`);
        params.push(since);
        const whereSql = "WHERE " + where.join(" AND ");

        const countRes = await client.query(`SELECT COUNT(*) AS c FROM listings ${whereSql}`, params);
        const total = parseInt(countRes.rows[0]?.c ?? 0);
        if (total === 0) {
          await client.query("UPDATE saved_searches SET last_checked_at = now() WHERE id = $1", [s.id]);
          continue;
        }

        const listRes = await client.query(
          `SELECT listingkey, listingid, standardstatus, listprice, closeprice, unparsedaddress, city,
                  bedroomstotal, bathroomstotalinteger, livingarea, lotsizeacres, yearbuilt, photoscount, region
           FROM listings ${whereSql} ORDER BY updated_at DESC LIMIT 12`, params);

        const resp = await sendMailgun(env.MAILGUN_API_KEY, {
          from: "Four Sails Real Estate <info@foursails.vip>",
          to: s.email,
          subject: alertSubject(s, total),
          html: buildAlertEmail(s, listRes.rows, total),
        });
        if (!resp.ok) { console.error(`saved-search ${s.id}: mailgun ${resp.status}`); continue; }

        await client.query("UPDATE saved_searches SET last_checked_at = now(), last_alerted_at = now() WHERE id = $1", [s.id]);
        console.log(`saved-search ${s.id}: alerted ${s.email} (${total} match${total === 1 ? "" : "es"})`);
      } catch (err) {
        console.error(`saved-search ${s.id} failed:`, err.message);
      }
    }
  } finally {
    await client.end();
  }
}

function alertSubject(s, total) {
  const label = s.search_name || criteriaSummary(s.criteria || {});
  return `${total} ${total === 1 ? "listing matches" : "listings match"} your search \u2014 ${label}`.slice(0, 150);
}

function buildAlertEmail(s, listings, total) {
  const summary = criteriaSummary(s.criteria || {});
  const viewAllUrl = criteriaLink(s.criteria || {});
  const unsubUrl = `${SITE_ORIGIN}/unsubscribe?token=${s.unsubscribe_token}`;
  const first = (s.subscriber_name || "").split(/\s+/)[0] || "there";

  const cards = listings.map((l, idx) => {
    const price = l.standardstatus === "Closed" && l.closeprice ? l.closeprice : l.listprice;
    const priceStr = price ? "$" + Number(price).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "\u2014";
    const bits = [];
    if (l.bedroomstotal != null) bits.push(`${l.bedroomstotal} Beds`);
    if (l.bathroomstotalinteger != null) bits.push(`${l.bathroomstotalinteger} Baths`);
    if (l.livingarea) bits.push(`${Number(l.livingarea).toLocaleString("en-US")} SF`);
    if (!l.livingarea && l.lotsizeacres) bits.push(`${Number(l.lotsizeacres).toFixed(2)} Acres`);
    if (l.yearbuilt) bits.push(`Built ${l.yearbuilt}`);
    const st = l.standardstatus === "Closed" ? "SOLD" : String(l.standardstatus || "").toUpperCase();
    const link = `${SITE_ORIGIN}/listing/${encodeURIComponent(l.listingkey)}`;
    const photo = l.photoscount > 0
      ? `<img src="https://media.foursailsrealestate.com/photos/${l.listingid}/0.jpg" alt="${escHtmlWorker(l.unparsedaddress || "Listing photo")}" width="180" style="width:180px; height:140px; object-fit:cover; display:block;">`
      : `<table role="presentation" cellpadding="0" cellspacing="0" style="width:180px; height:140px; background-color:#1D3F60;"><tr><td align="center" valign="middle" style="color:#E3DEC3; font-size:11px; font-family:Georgia, serif;">Photos Coming Soon</td></tr></table>`;
    return `<tr><td style="padding:${idx === 0 ? 12 : 0}px 30px 12px 30px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e8; border-radius:6px; overflow:hidden;"><tr><td width="180" valign="top" style="width:180px;"><a href="${link}" style="text-decoration:none;">${photo}</a></td><td valign="top" style="padding:12px 16px;"><p style="margin:0 0 4px; color:#1D3F60; font-size:18px; font-weight:700;">${priceStr} <span style="color:#888; font-size:10px; font-weight:400; letter-spacing:1px;">${st}</span></p><p style="margin:0 0 3px; color:#1D3F60; font-size:13px; font-weight:700;">${escHtmlWorker(l.unparsedaddress || "")}</p><p style="margin:0 0 6px; color:#888; font-size:12px;">${escHtmlWorker(titleCaseCity(l.city))}${l.region === "PR" ? ", PR" : ", FL"}</p><p style="margin:0 0 10px; color:#666; font-size:12px;">${bits.join(" &bull; ")}</p><a href="${link}" style="display:inline-block; background-color:#E3DEC3; color:#1D3F60; padding:8px 20px; text-decoration:none; font-size:12px; font-weight:700; border-radius:3px; letter-spacing:0.5px;">VIEW LISTING</a></td></tr></table></td></tr>`;
  }).join("");

  const moreLine = total > listings.length
    ? `<tr><td style="padding:0 30px 4px; text-align:center;"><p style="color:#888; font-size:12px; margin:0;">\u2026and ${total - listings.length} more matching ${total - listings.length === 1 ? "listing" : "listings"}.</p></td></tr>`
    : "";

  const intro = `<tr><td style="padding:24px 30px 4px;"><h2 style="color:#1D3F60; margin:0 0 8px; font-size:20px; font-family:Georgia, serif;">${total} New ${total === 1 ? "Match" : "Matches"} for Your Search</h2><p style="color:#333; font-size:14px; line-height:1.7; margin:0 0 4px;">Hi ${escHtmlWorker(first)}, here's what's new${s.search_name ? ` for <strong>\u201c${escHtmlWorker(s.search_name)}\u201d</strong>` : ""}:</p><p style="color:#888; font-size:12px; margin:0;">${escHtmlWorker(summary)}</p></td></tr>`;

  const cta = `<tr><td style="padding:12px 30px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td style="background-color:#1D3F60; border-radius:6px; padding:14px 32px; text-align:center;"><a href="${viewAllUrl}" style="color:#ffffff; text-decoration:none; font-size:14px; font-weight:700; letter-spacing:1px; font-family:Georgia, serif;">VIEW ALL RESULTS</a></td></tr></table></td></tr>`;

  const footerExtra = `<p style="color:#888; font-size:10px; margin:0 0 10px 0;">You're receiving ${FREQUENCY_TEXT[s.frequency] || "email alerts"} for this saved search. Listing information &copy; 2026 Stellar MLS as distributed by MLS GRID.</p>`;

  return fsWrap(alertSubject(s, total), FS_HEADER + intro + cards + moreLine + cta + FS_DUAL_SIGNATURE + fsFooter(unsubUrl, footerExtra));
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

// Temporary design-preview mock (2026-07-08) — see /preview/cards route.
const PREVIEW_CARDS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Card Mockup — Manasota Key</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&family=Marcellus&display=swap" rel="stylesheet">
<style>
:root {
  --navy:#1D3F60; --ivory:#F8F7F3; --champagne:#E3DEC3; --sandstone:#D9CBBF;
  --white:#FFF; --navy-light:#2A5580; --navy-dark:#15304A;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Lato',sans-serif;color:var(--navy);background:var(--ivory);line-height:1.6}
h1,h2,h3{font-family:'Marcellus',Georgia,serif;color:var(--navy);line-height:1.2}
.section{padding:4rem 2rem}
.section-inner{max-width:1100px;margin:0 auto}
.section-title{font-size:2.2rem;text-align:center;margin-bottom:.75rem}
.section-subtitle{text-align:center;font-size:1.05rem;opacity:.7;margin:0 auto 2.5rem;max-width:600px}

.listings-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1.75rem}
@media(max-width:900px){.listings-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.listings-grid{grid-template-columns:1fr}}

.listing-card{
  display:block;background:var(--white);border-radius:8px;overflow:hidden;
  text-decoration:none;color:var(--navy);
  box-shadow:0 2px 12px rgba(29,63,96,0.08);
  transition:transform .25s,box-shadow .25s;
}
.listing-card:hover{transform:translateY(-3px);box-shadow:0 10px 28px rgba(29,63,96,0.16)}
.listing-photo{position:relative;aspect-ratio:3/2;overflow:hidden;background:var(--sandstone)}
.listing-photo img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .4s}
.listing-card:hover .listing-photo img{transform:scale(1.04)}
.listing-status{
  position:absolute;top:.75rem;left:.75rem;background:var(--champagne);color:var(--navy);
  font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;
  padding:.25rem .65rem;border-radius:3px;
}
.listing-tag{
  position:absolute;top:.75rem;right:.75rem;background:rgba(29,63,96,0.85);color:var(--ivory);
  font-size:.72rem;font-weight:400;letter-spacing:.06em;text-transform:uppercase;
  padding:.25rem .65rem;border-radius:3px;
}
.listing-body{padding:1.1rem 1.25rem 1.25rem}
.listing-price{font-family:'Marcellus',Georgia,serif;font-size:1.55rem;margin-bottom:.15rem}
.listing-address{font-size:.98rem;font-weight:700;letter-spacing:.01em}
.listing-city{font-size:.85rem;opacity:.65;margin-bottom:.75rem}
.listing-specs{
  display:flex;align-items:center;gap:.9rem;font-size:.88rem;
  border-top:1px solid var(--champagne);padding-top:.75rem;
}
.listing-specs strong{font-weight:700}
.spec-div{width:1px;height:14px;background:var(--sandstone)}
.listing-type{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;opacity:.5;margin-top:.55rem}

.view-all{text-align:center;margin-top:2.5rem}
.view-all a{
  display:inline-block;background:var(--navy);color:var(--ivory);padding:.8rem 2.4rem;
  border-radius:4px;font-weight:600;font-size:.95rem;text-decoration:none;letter-spacing:.03em;
}
.mls-note{text-align:center;font-size:.72rem;opacity:.45;margin-top:2rem;max-width:700px;margin-left:auto;margin-right:auto}
</style>
</head>
<body>
<section class="section">
  <div class="section-inner">
    <h2 class="section-title">Active Listings on Manasota Key</h2>
    <p class="section-subtitle">Currently available properties on the island</p>
    <div class="listings-grid">

    <a class="listing-card" href="#">
      <div class="listing-photo">
        <img src="https://media.foursailsrealestate.com/photos/MFRN6140444/0.jpg" alt="7159 Manasota Key Rd" loading="lazy" />
        <span class="listing-status">Active</span>
        <span class="listing-tag">Waterfront</span>
      </div>
      <div class="listing-body">
        <div class="listing-price">$11,900,000</div>
        <div class="listing-address">7159 Manasota Key Rd</div>
        <div class="listing-city">Manasota Key &middot; Englewood, FL 34223</div>
        <div class="listing-specs">
          <span><strong>6</strong> Beds</span><span class="spec-div"></span>
          <span><strong>11</strong> Baths</span><span class="spec-div"></span>
          <span><strong>12,789</strong> Sq Ft</span>
        </div>
        <div class="listing-type">Single Family Residence</div>
      </div>
    </a>

    <a class="listing-card" href="#">
      <div class="listing-photo">
        <img src="https://media.foursailsrealestate.com/photos/MFRA4688005/0.jpg" alt="2740 N Beach Rd #B" loading="lazy" />
        <span class="listing-status">Active</span>
        <span class="listing-tag">Waterfront</span>
      </div>
      <div class="listing-body">
        <div class="listing-price">$4,700,000</div>
        <div class="listing-address">2740 N Beach Rd #B</div>
        <div class="listing-city">Manasota Key &middot; Englewood, FL 34223</div>
        <div class="listing-specs">
          <span><strong>3</strong> Beds</span><span class="spec-div"></span>
          <span><strong>2</strong> Baths</span><span class="spec-div"></span>
          <span><strong>1,799</strong> Sq Ft</span>
        </div>
        <div class="listing-type">Single Family Residence</div>
      </div>
    </a>

    <a class="listing-card" href="#">
      <div class="listing-photo">
        <img src="https://media.foursailsrealestate.com/photos/MFRN6142094/0.jpg" alt="7090 Manasota Key Rd" loading="lazy" />
        <span class="listing-status">Active</span>
        <span class="listing-tag">Waterfront</span>
      </div>
      <div class="listing-body">
        <div class="listing-price">$3,650,000</div>
        <div class="listing-address">7090 Manasota Key Rd</div>
        <div class="listing-city">Manasota Key &middot; Englewood, FL 34223</div>
        <div class="listing-specs">
          <span><strong>3</strong> Beds</span><span class="spec-div"></span>
          <span><strong>4</strong> Baths</span><span class="spec-div"></span>
          <span><strong>2,211</strong> Sq Ft</span>
        </div>
        <div class="listing-type">Single Family Residence</div>
      </div>
    </a>

    <a class="listing-card" href="#">
      <div class="listing-photo">
        <img src="https://media.foursailsrealestate.com/photos/MFRD6145492/0.jpg" alt="2708 N Beach Rd #2" loading="lazy" />
        <span class="listing-status">Active</span>
        <span class="listing-tag">Waterfront</span>
      </div>
      <div class="listing-body">
        <div class="listing-price">$2,100,000</div>
        <div class="listing-address">2708 N Beach Rd #2</div>
        <div class="listing-city">Manasota Key &middot; Englewood, FL 34223</div>
        <div class="listing-specs">
          <span><strong>3</strong> Beds</span><span class="spec-div"></span>
          <span><strong>4</strong> Baths</span><span class="spec-div"></span>
          <span><strong>3,029</strong> Sq Ft</span>
        </div>
        <div class="listing-type">Condominium</div>
      </div>
    </a>

    <a class="listing-card" href="#">
      <div class="listing-photo">
        <img src="https://media.foursailsrealestate.com/photos/MFRN6142960/0.jpg" alt="6780 Manasota Key Rd" loading="lazy" />
        <span class="listing-status">Active</span>
        <span class="listing-tag">Waterfront</span>
      </div>
      <div class="listing-body">
        <div class="listing-price">$1,999,000</div>
        <div class="listing-address">6780 Manasota Key Rd</div>
        <div class="listing-city">Manasota Key &middot; Englewood, FL 34223</div>
        <div class="listing-specs">
          <span><strong>3</strong> Beds</span><span class="spec-div"></span>
          <span><strong>3</strong> Baths</span><span class="spec-div"></span>
          <span><strong>1,854</strong> Sq Ft</span>
        </div>
        <div class="listing-type">Single Family Residence</div>
      </div>
    </a>

    <a class="listing-card" href="#">
      <div class="listing-photo">
        <img src="https://media.foursailsrealestate.com/photos/MFRC7521173/0.jpg" alt="7515 Manasota Key Rd" loading="lazy" />
        <span class="listing-status">Active</span>
        <span class="listing-tag">Waterfront</span>
      </div>
      <div class="listing-body">
        <div class="listing-price">$1,899,000</div>
        <div class="listing-address">7515 Manasota Key Rd</div>
        <div class="listing-city">Manasota Key &middot; Englewood, FL 34223</div>
        <div class="listing-specs">
          <span><strong>3</strong> Beds</span><span class="spec-div"></span>
          <span><strong>3</strong> Baths</span><span class="spec-div"></span>
          <span><strong>2,209</strong> Sq Ft</span>
        </div>
        <div class="listing-type">Single Family Residence</div>
      </div>
    </a>
    </div>
    <div class="view-all"><a href="#">View All 80 Manasota Key Listings</a></div>
    <p class="mls-note">Listings courtesy of Stellar MLS. Information deemed reliable but not guaranteed. &copy; 2026 Four Sails Real Estate &mdash; Lauralyn Christian Real Estate, Inc.</p>
  </div>
</section>
</body>
</html>`;
