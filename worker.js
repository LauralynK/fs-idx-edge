/**
 * FS IDX Edge Search — Cloudflare Worker + Hyperdrive (Neon Postgres)
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
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
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
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return jsonResponse({ error: err.message }, corsHeaders, 500);
    } finally {
      await client.end();
    }
  },
};

// ── Search ──────────────────────────────────────────────────────

async function handleSearch(q, client, env, cors) {
  const where = ["mlgcanview = true", "(photos_synced = true OR photoscount = 0)"];
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

  // County
  const county = q.get("county");
  if (county) {
    const counties = county.split(",").map(c => c.trim()).filter(Boolean);
    if (counties.length > 0) {
      const placeholders = counties.map(() => p()).join(",");
      where.push(`countyorparish IN (${placeholders})`);
      params.push(...counties);
    }
  } else {
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

  // Waterfront / pool
  if (q.get("waterfront") === "1") {
    where.push("(waterfrontyn = true OR mfr_wateraccessyn = true)");
  }
  if (q.get("pool") === "1") {
    where.push("poolprivateyn = true");
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
    subdivisionname, listagentfullname, listofficename`;

  const results = await client.query(
    `SELECT ${cols} FROM listings ${whereSql} ORDER BY ${orderBy} LIMIT ${p()} OFFSET ${p()}`,
    [...params, perPage, offset]
  );

  return jsonResponse({
    listings: results.rows,
    total,
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
