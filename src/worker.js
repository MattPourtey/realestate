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
  "ListingContractDate",
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

// Bridge's test-data photo host returns 403, so test listings get free
// Unsplash house photos instead (Unsplash License; hotlinked as Unsplash asks).
// Real MLS datasets are never touched by this.
const STOCK_PHOTO_IDS = [
  "photo-1570129477492-45c003edd2be", "photo-1600596542815-ffad4c1539a9",
  "photo-1781797221329-c3d083ab6d99", "photo-1598228723793-52759bba239c",
  "photo-1580587771525-78b9dba3b914", "photo-1787094497609-5efe6029b950",
  "photo-1568605114967-8130f3a36994", "photo-1583608205776-bfd35f0d9f83",
  "photo-1777428762767-e3a797da389a", "photo-1628624747186-a941c476b7ef",
  "photo-1512917774080-9991f1c4c750", "photo-1786550860372-116b871a1697",
  "photo-1605276374104-dee2a0ed3cd6", "photo-1592595896616-c37162298647",
  "photo-1758158452965-ef267a639880", "photo-1605146769289-440113cc3d00",
  "photo-1494526585095-c41746248156", "photo-1584738766473-61c083514bf4",
  "photo-1564013799919-ab600027ffc6",
];
const STOCK_PER_LISTING = 4;

export function isTestDataset(ds) {
  return ds === "test" || ds.startsWith("test_");
}

// Same listing always gets the same photos.
export function stockPhotos(key) {
  let h = 0;
  for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const out = [];
  for (let i = 0; i < STOCK_PER_LISTING; i++) {
    const id = STOCK_PHOTO_IDS[(h + i * 7) % STOCK_PHOTO_IDS.length];
    out.push(`https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=70`);
  }
  return out;
}

// Browse categories. The homepage only shows ones with a live count above 0,
// so categories appear/disappear with the data. Filters are fixed strings
// (never built from user input).
const LUXURY_MIN = 750000; // raise to ~1,000,000+ for real Las Vegas data
export const CATEGORIES = {
  houses:       { label: "Houses",       filter: "PropertySubType eq 'Single Family Residence'" },
  condos:       { label: "Condos",       filter: "PropertySubType eq 'Condominium'" },
  apartments:   { label: "Apartments",   filter: "PropertySubType eq 'Apartment'" },
  townhomes:    { label: "Townhomes",    filter: "PropertySubType eq 'Townhouse'" },
  luxury:       { label: "Luxury",       filter: `PropertyType eq 'Residential' and ListPrice ge ${LUXURY_MIN}` },
  multifamily:  { label: "Multi-family", filter: "(PropertySubType eq 'Duplex' or PropertySubType eq 'Triplex' or PropertySubType eq 'Quadruplex')" },
  rentals:      { label: "Rentals",      filter: "PropertyType eq 'Residential Lease'" },
  commercial:   { label: "Commercial",   filter: "(PropertyType eq 'Business' or PropertyType eq 'Commercial Sale')" },
  land:         { label: "Land",         filter: "PropertyType eq 'Land'" },
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
          results: (data.value || []).map((r) => clean(r, q.dataset)),
        });
      }

      if (url.pathname === "/api/categories") {
        const dataset = pickDataset(url.searchParams.get("dataset"));
        if (!dataset) return json({ error: "Unknown dataset" }, 400);
        const ids = Object.keys(CATEGORIES);
        const counts = await Promise.all(
          [null, ...ids].map((id) =>
            bridge(env, ctx, buildCountUrl(dataset, id)).then((d) => d["@odata.count"] ?? 0)
          )
        );
        return json({
          dataset,
          total: counts[0],
          categories: ids
            .map((id, i) => ({ id, label: CATEGORIES[id].label, count: counts[i + 1] }))
            .filter((c) => c.count > 0),
        });
      }

      const one = url.pathname.match(/^\/api\/listings\/([A-Za-z0-9_-]{1,64})$/);
      if (one) {
        const dataset = pickDataset(url.searchParams.get("dataset"));
        if (!dataset) return json({ error: "Unknown dataset" }, 400);
        const target = new URL(`${BRIDGE_BASE}/${dataset}/Property('${one[1]}')`);
        target.searchParams.set("$select", PUBLIC_FIELDS.join(","));
        const data = await bridge(env, ctx, target);
        return json(clean(data, dataset));
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

  const category = params.get("category") || "";
  if (category && !Object.hasOwn(CATEGORIES, category)) return { error: "Invalid category" };

  return {
    dataset,
    category,
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
  if (q.category) filters.push(CATEGORIES[q.category].filter);

  const u = new URL(`${BRIDGE_BASE}/${q.dataset}/Property`);
  u.searchParams.set("$select", PUBLIC_FIELDS.join(","));
  u.searchParams.set("$filter", filters.join(" and "));
  u.searchParams.set("$orderby", SORTS[q.sort]);
  u.searchParams.set("$top", String(q.top));
  u.searchParams.set("$skip", String((q.page - 1) * q.top));
  return u;
}

// Count-only query: one tiny record, we just read @odata.count.
export function buildCountUrl(dataset, categoryId) {
  const filters = ["StandardStatus eq 'Active'"];
  if (categoryId) filters.push(CATEGORIES[categoryId].filter);
  const u = new URL(`${BRIDGE_BASE}/${dataset}/Property`);
  u.searchParams.set("$select", "ListingKey");
  u.searchParams.set("$filter", filters.join(" and "));
  u.searchParams.set("$top", "1");
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

export function clean(rec, dataset = "") {
  const out = {};
  for (const f of PUBLIC_FIELDS) {
    if (f === "Media") continue;
    out[f] = rec[f] ?? null;
  }
  if (isTestDataset(dataset)) {
    out.Photos = stockPhotos(rec.ListingKey);
    out.StockPhotos = true;
    return out;
  }
  out.StockPhotos = false;
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
