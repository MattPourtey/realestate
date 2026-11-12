// realestate.mattpourtey.com Worker
//
// Serves static files from ./public and exposes a small read-only API that
// proxies the Bridge Data Output API. The Bridge Server Token never leaves
// Cloudflare: it is read from the encrypted secret BRIDGE_SERVER_TOKEN.
//
// Routes:
//   GET /api/health              -> is the token configured / reachable
//   GET /api/listings            -> search listings (see parseSearch for params)
//   GET /api/listings/:key       -> one listing by ListingKey
//   everything else              -> static assets in ./public

const BRIDGE_BASE = "https://api.bridgedataoutput.com/api/v2/OData";

// Datasets this site is allowed to query. Add real MLS ids here once approved.
const ALLOWED_DATASETS = ["test_sd", "test_sf", "test"];
const DEFAULT_DATASET = "test_sd";

// Only these fields are ever requested from Bridge or returned to visitors.
// Raw MLS records include private data (lockbox codes, showing instructions,
// occupant names/phones, private remarks). Never widen this list with those.
const PUBLIC_FIELDS = [
  "ListingKey",
  "ListPrice",
  "StandardStatus",
  "PropertyType",
  "PropertySubType",
  "UnparsedAddress",
  "City",
  "StateOrProvince",
  "PostalCode",
  "BedroomsTotal",
  "BathroomsTotalInteger",
  "LivingArea",
  "LotSizeAcres",
  "YearBuilt",
  "DaysOnMarket",
  "PublicRemarks",
  "Latitude",
  "Longitude",
  "ListOfficeName",
  "PhotosCount",
  "Media",
];

const SORTS = {
  newest: "ListingContractDate desc",
  price_asc: "ListPrice asc",
  price_desc: "ListPrice desc",
};

const MAX_PAGE = 24;
const CACHE_SECONDS = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }
    if (!env.BRIDGE_SERVER_TOKEN) {
      return json({ error: "BRIDGE_SERVER_TOKEN secret is not set on the Worker" }, 503);
    }

    try {
      if (url.pathname === "/api/health") {
        return json({ ok: true, datasets: ALLOWED_DATASETS });
      }

      if (url.pathname === "/api/listings") {
        const q = parseSearch(url.searchParams);
        if (q.error) return json({ error: q.error }, 400);
        const data = await bridge(env, ctx, buildSearchUrl(q));
        return json({
          dataset: q.dataset,
          page: q.page,
          pageSize: q.top,
          total: data["@odata.count"] ?? null,
          results: (data.value || []).map(clean),
        });
      }

      const one = url.pathname.match(/^\/api\/listings\/([A-Za-z0-9_-]{1,64})$/);
      if (one) {
        const dataset = pickDataset(url.searchParams.get("dataset"));
        if (!dataset) return json({ error: "Unknown dataset" }, 400);
        const target = new URL(`${BRIDGE_BASE}/${dataset}/Property('${one[1]}')`);
        target.searchParams.set("$select", PUBLIC_FIELDS.join(","));
        const data = await bridge(env, ctx, target);
        return json(clean(data));
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      const status = err.status && err.status < 500 ? err.status : 502;
      return json({ error: err.message || "Upstream error" }, status);
    }
  },
};

// ---------- request parsing ----------

export function pickDataset(value) {
  const ds = value || DEFAULT_DATASET;
  return ALLOWED_DATASETS.includes(ds) ? ds : null;
}

function intParam(params, name, min, max) {
  const raw = params.get(name);
  if (raw === null || raw === "") return { value: null };
  if (!/^\d+$/.test(raw)) return { error: `${name} must be a whole number` };
  const n = Number(raw);
  if (n < min || n > max) return { error: `${name} must be between ${min} and ${max}` };
  return { value: n };
}

export function parseSearch(params) {
  const dataset = pickDataset(params.get("dataset"));
  if (!dataset) return { error: "Unknown dataset" };

  const minPrice = intParam(params, "minPrice", 0, 1e9);
  const maxPrice = intParam(params, "maxPrice", 0, 1e9);
  const beds = intParam(params, "beds", 0, 50);
  const baths = intParam(params, "baths", 0, 50);
  const page = intParam(params, "page", 1, 400);
  const pageSize = intParam(params, "pageSize", 1, MAX_PAGE);
  for (const p of [minPrice, maxPrice, beds, baths, page, pageSize]) {
    if (p.error) return { error: p.error };
  }
  if (minPrice.value !== null && maxPrice.value !== null && minPrice.value > maxPrice.value) {
    return { error: "Min price is higher than max price" };
  }

  // City: letters, spaces, periods, apostrophes and hyphens only.
  let city = (params.get("city") || "").trim();
  if (city && !/^[A-Za-z .'-]{1,60}$/.test(city)) return { error: "Invalid city" };

  const sort = params.get("sort") || "newest";
  if (!SORTS[sort]) return { error: "Invalid sort" };

  return {
    dataset,
    minPrice: minPrice.value,
    maxPrice: maxPrice.value,
    beds: beds.value,
    baths: baths.value,
    city,
    sort,
    page: page.value || 1,
    top: pageSize.value || 12,
  };
}

// OData string literal: wrap in single quotes, double any embedded quote.
function odataString(s) {
  return `'${s.replace(/'/g, "''")}'`;
}

export function buildSearchUrl(q) {
  const filters = ["StandardStatus eq 'Active'"];
  if (q.minPrice !== null) filters.push(`ListPrice ge ${q.minPrice}`);
  if (q.maxPrice !== null) filters.push(`ListPrice le ${q.maxPrice}`);
  if (q.beds !== null) filters.push(`BedroomsTotal ge ${q.beds}`);
  if (q.baths !== null) filters.push(`BathroomsTotalInteger ge ${q.baths}`);
  if (q.city) filters.push(`City eq ${odataString(q.city)}`);

  const u = new URL(`${BRIDGE_BASE}/${q.dataset}/Property`);
  u.searchParams.set("$select", PUBLIC_FIELDS.join(","));
  u.searchParams.set("$filter", filters.join(" and "));
  u.searchParams.set("$orderby", SORTS[q.sort]);
  u.searchParams.set("$top", String(q.top));
  u.searchParams.set("$skip", String((q.page - 1) * q.top));
  return u;
}

// ---------- upstream ----------

async function bridge(env, ctx, target) {
  // Cache key never contains the token.
  const cacheKey = new Request(target.toString(), { method: "GET" });
  const cache = typeof caches !== "undefined" ? caches.default : null;

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
  }

  const res = await fetch(target.toString(), {
    headers: { Authorization: `Bearer ${env.BRIDGE_SERVER_TOKEN}`, Accept: "application/json" },
  });

  if (!res.ok) {
    const err = new Error(
      res.status === 404 ? "Listing not found" :
      res.status === 429 ? "Rate limited by Bridge, try again shortly" :
      `Bridge API returned ${res.status}`
    );
    err.status = res.status === 404 ? 404 : res.status === 429 ? 429 : 502;
    throw err;
  }

  const body = await res.text();
  if (cache) {
    const toCache = new Response(body, {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
    });
    ctx.waitUntil(cache.put(cacheKey, toCache));
  }
  return JSON.parse(body);
}

// ---------- response shaping ----------

export function clean(rec) {
  const out = {};
  for (const f of PUBLIC_FIELDS) {
    if (f === "Media") continue;
    out[f] = rec[f] ?? null;
  }
  out.Photos = (rec.Media || [])
    .filter((m) => m && m.MediaURL && (!m.MediaCategory || m.MediaCategory === "Photo"))
    .sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0))
    .slice(0, 12)
    .map((m) => m.MediaURL);
  return out;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? `public, max-age=${CACHE_SECONDS}` : "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
