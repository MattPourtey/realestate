// Shared helpers for realestate.mattpourtey.com pages.
// All listing data comes from the site's own Worker API (/api/*), which proxies
// the Bridge MLS feed. Nothing here is hard-coded listing data.

const DEFAULT_DATASET = "test_sd";
const IS_DEMO = true; // flip to false once a real MLS dataset is live

const unsplash = (id, w = 1200) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=72`;

export const CATEGORY_PHOTOS = {
  houses: unsplash("photo-1570129477492-45c003edd2be", 900),
  condos: unsplash("photo-1600596542815-ffad4c1539a9", 900),
  apartments: unsplash("photo-1624204386084-dd8c05e32226", 900),
  townhomes: unsplash("photo-1592595896616-c37162298647", 900),
  luxury: unsplash("photo-1564013799919-ab600027ffc6", 900),
  multifamily: unsplash("photo-1598228723793-52759bba239c", 900),
  rentals: unsplash("photo-1584738766473-61c083514bf4", 900),
  commercial: unsplash("photo-1621831337128-35676ca30868", 900),
  land: unsplash("photo-1775239925233-979d7aac7166", 900),
};
export const HERO_PHOTO = unsplash("photo-1512917774080-9991f1c4c750", 2200);

// ---------- API ----------

async function getJSON(url) {
  const res = await fetch(url);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

export const api = {
  listings(params = {}) {
    const p = new URLSearchParams({ dataset: DEFAULT_DATASET, ...params });
    for (const [k, v] of [...p]) if (v === "" || v == null) p.delete(k);
    return getJSON("/api/listings?" + p);
  },
  listing(key, dataset = DEFAULT_DATASET, photoStart = null) {
    const p = photoStart != null && /^\d{1,2}$/.test(String(photoStart)) ? `&p=${photoStart}` : "";
    return getJSON(`/api/listings/${encodeURIComponent(key)}?dataset=${encodeURIComponent(dataset)}${p}`);
  },
  categories(dataset = DEFAULT_DATASET) {
    return getJSON("/api/categories?dataset=" + encodeURIComponent(dataset));
  },
};

// ---------- formatting ----------

export const money = (n) => (n == null ? "Price on request" : "$" + Number(n).toLocaleString("en-US"));
export const num = (n) => Number(n).toLocaleString("en-US");

export function listedDate(r) {
  if (!r.ListingContractDate) return null;
  const d = new Date(r.ListingContractDate + "T12:00:00");
  return isNaN(d) ? null : d;
}
export function isNew(r, days = 14) {
  const d = listedDate(r);
  return d ? (Date.now() - d.getTime()) / 864e5 <= days : false;
}
export const typeLabel = (r) => r.PropertySubType || r.PropertyType || "Property";
export const addressLine = (r) => r.UnparsedAddress || [r.City, r.StateOrProvince].filter(Boolean).join(", ");
export const listingHref = (r, dataset = DEFAULT_DATASET) =>
  `/listing/?key=${encodeURIComponent(r.ListingKey)}&dataset=${encodeURIComponent(dataset)}` +
  (r.StockPhotos && r.StockStart != null ? `&p=${r.StockStart}` : "");

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

// ---------- saved listings (this browser only) ----------

const SAVE_KEY = "re-saved-v1";
export const saved = {
  all() {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY) || "[]"); } catch { return []; }
  },
  has(key) { return this.all().some((s) => s.key === key); },
  toggle(key, dataset = DEFAULT_DATASET, p = null) {
    let list = this.all();
    const on = !list.some((s) => s.key === key);
    list = on ? [...list, { key, dataset, p }] : list.filter((s) => s.key !== key);
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(list.slice(-100))); } catch { /* storage blocked */ }
    updateSavedCount();
    return on;
  },
};

const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.6 4.5 7.1 4.5c2 0 3.6 1.1 4.9 2.8 1.3-1.7 2.9-2.8 4.9-2.8 3.5 0 5.7 3.5 4.4 6.8-1.8 4.6-9.3 9.2-9.3 9.2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

export function saveButton(r, dataset = DEFAULT_DATASET) {
  const b = el("button", { class: "save", type: "button" });
  const sync = () => {
    const on = saved.has(r.ListingKey);
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", on ? "Remove from saved" : "Save listing");
  };
  b.innerHTML = HEART;
  sync();
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    saved.toggle(r.ListingKey, dataset, r.StockStart ?? null);
    sync();
  });
  return b;
}

// ---------- cards ----------

function photoOrPlaceholder(src, alt) {
  if (!src) return el("div", { class: "nophoto", text: "Photo unavailable" });
  const img = el("img", { src, alt, loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => img.replaceWith(el("div", { class: "nophoto", text: "Photo unavailable" })), { once: true });
  return img;
}

export function listingCard(r, { dataset = DEFAULT_DATASET, showListed = false } = {}) {
  const href = listingHref(r, dataset);
  const facts = el("div", { class: "card-facts" },
    r.BedroomsTotal != null && el("span", {}, el("b", { text: r.BedroomsTotal }), " bd"),
    r.BathroomsTotalInteger != null && el("span", {}, el("b", { text: r.BathroomsTotalInteger }), " ba"),
    r.LivingArea != null && el("span", {}, el("b", { text: num(r.LivingArea) }), " sq ft"),
  );
  const listed = listedDate(r);
  const meta = showListed && listed
    ? `${typeLabel(r)}, listed ${listed.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : `${typeLabel(r)}${r.StandardStatus ? ", " + r.StandardStatus.toLowerCase() : ""}`;

  return el("article", { class: "card" },
    el("div", { class: "card-media" },
      photoOrPlaceholder(r.Photos && r.Photos[0], addressLine(r) || "Listing photo"),
      isNew(r) && el("span", { class: "tag tag-new", text: "New" }),
      r.StockPhotos && el("span", { class: "tag tag-stock", text: "Stock photo" }),
      saveButton(r, dataset),
    ),
    el("div", { class: "card-body" },
      el("div", { class: "card-price", text: money(r.ListPrice) }),
      facts,
      el("div", { class: "card-addr", text: addressLine(r) }),
      el("div", { class: "card-type", text: meta }),
    ),
    el("a", { class: "card-link", href, "aria-label": `${money(r.ListPrice)}, ${addressLine(r)}` }),
  );
}

export function skeletonCards(container, n, height = 330) {
  container.replaceChildren(...Array.from({ length: n }, () => el("div", { class: "skeleton", style: `height:${height}px` })));
}

// ---------- site chrome ----------

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

export function updateSavedCount() {
  const n = saved.all().length;
  document.querySelectorAll("[data-saved-count]").forEach((e) => (e.textContent = n ? String(n) : ""));
}

export function mountChrome(active = "") {
  const link = (href, label, id) =>
    el("li", {}, el("a", { href, "aria-current": active === id ? "page" : null, "data-nav": id, text: label }));

  const rent = link("/listings/?category=rentals", "Rent", "rent");
  rent.hidden = true; // shown only if the feed has rentals

  const nav = el("header", { class: "nav" },
    el("div", { class: "wrap" },
      el("a", { class: "logo", href: "/" }, el("b", { text: "Matthew" }), el("span", { text: "Real Estate" })),
      el("nav", { "aria-label": "Main" },
        el("ul", { class: "nav-links" },
          link("/", "Home", "home"),
          link("/listings/", "Buy", "buy"),
          rent,
          link("/#sell", "Sell", "sell"),
          link("/#categories", "Explore", "explore"),
        ),
      ),
      el("div", { class: "nav-tools" },
        (() => { const a = el("a", { class: "icon-btn", href: "/listings/", "aria-label": "Search listings" }); a.innerHTML = SEARCH_ICON + "<span>Search</span>"; return a; })(),
        (() => { const a = el("a", { class: "icon-btn", href: "/listings/?saved=1", "aria-current": active === "saved" ? "page" : null }); a.innerHTML = HEART.replace('aria-hidden="true"', 'aria-hidden="true" width="18" height="18"') + '<span>Saved</span><span class="count-pill" data-saved-count></span>'; return a; })(),
      ),
    ),
  );

  const top = [];
  if (IS_DEMO) top.push(el("div", { class: "notice", text: "Preview mode: listings shown are sample MLS test data, not real properties for sale." }));
  document.body.prepend(...top, nav);

  const year = new Date().getFullYear();
  const col = (title, items) => el("div", {}, el("h3", { text: title }), el("ul", {}, items.map(([h, t, ext]) => el("li", {}, el("a", { href: h, text: t, target: ext ? "_blank" : null, rel: ext ? "noopener" : null })))));
  const footer = el("footer", { class: "footer" },
    el("div", { class: "wrap" },
      el("div", { class: "footer-grid" },
        el("div", {},
          el("a", { class: "logo", href: "/" }, el("b", { text: "Matthew" }), el("span", { text: "Real Estate" })),
          el("p", { class: "footer-blurb", text: "Active listings pulled straight from the MLS feed, refreshed every few minutes. Based in Las Vegas, NV." }),
        ),
        col("Browse", [["/listings/", "All listings"], ["/listings/?sort=newest", "Newest"], ["/listings/?category=luxury", "Luxury"], ["/listings/?saved=1", "Saved homes"]]),
        col("Property types", [["/listings/?category=houses", "Houses"], ["/listings/?category=condos", "Condos"], ["/listings/?category=townhomes", "Townhomes"], ["/listings/?category=commercial", "Commercial"]]),
        col("Contact", [["https://www.linkedin.com/in/mattpourtey", "LinkedIn", true], ["/#sell", "Selling a home"]]),
      ),
      el("div", { class: "footer-legal" },
        el("p", { text: `© ${year} Matthew Pourteymaur. Listing data provided by Bridge Interactive. Information is deemed reliable but not guaranteed.` }),
        el("p", {}, "Demo listing photos from ", el("a", { href: "https://unsplash.com/?utm_source=realestate_mattpourtey&utm_medium=referral", target: "_blank", rel: "noopener", text: "Unsplash" }), "."),
      ),
    ),
  );
  document.body.append(footer);
  updateSavedCount();

  // Show "Rent" only when the live feed actually has rentals.
  api.categories().then((c) => { if (c.categories.some((x) => x.id === "rentals")) rent.hidden = false; }).catch(() => {});
}

export { DEFAULT_DATASET };
