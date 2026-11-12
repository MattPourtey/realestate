# realestate

Source for https://realestate.mattpourtey.com

## How it works

```
Visitor -> Cloudflare Worker "realestate"
             |- /api/*      -> src/worker.js -> Bridge Data Output API (token from secret)
             '- everything  -> static files in public/
```

- `public/index.html` : homepage (hero search, featured, categories, recent, CTA)
- `public/listings/` : search results; `?saved=1` shows saved homes
- `public/listing/` : one listing (`?key=&dataset=&p=`)
- `public/assets/site.css`, `public/assets/app.js` : shared styles, cards, nav/footer, saved homes (localStorage)
- `src/worker.js` : read-only API that proxies Bridge
- `wrangler.jsonc` : Worker config

## Deploys

Push to `main`. Cloudflare Workers Builds runs `npx wrangler deploy` and the site is live in about a minute.

## API routes

| Route | What it does |
|---|---|
| `GET /api/health` | Checks the Worker has its token configured |
| `GET /api/listings` | Search active listings |
| `GET /api/listings/{ListingKey}` | One listing |
| `GET /api/categories` | Live counts per property category (only non-empty ones) |

`/api/listings` params: `dataset` (`test_sd`, `test_sf`, `test`), `city`, `minPrice`, `maxPrice`, `beds`, `baths`, `category` (`houses`, `condos`, `apartments`, `townhomes`, `luxury`, `multifamily`, `rentals`, `commercial`, `land`), `sort` (`newest`, `price_asc`, `price_desc`), `page`, `pageSize` (max 24).

## Going live with real data

When a real MLS dataset is approved: add it to `ALLOWED_DATASETS` (worker), set `DEFAULT_DATASET` and `IS_DEMO = false` in `public/assets/app.js`, and raise `LUXURY_MIN` to fit the market.

Responses are cached for 5 minutes.

## Secrets

This repo is **public**. Never commit tokens.

| Secret | Where |
|---|---|
| `BRIDGE_SERVER_TOKEN` | Cloudflare dashboard > Workers & Pages > realestate > Settings > Variables and Secrets (type: Secret) |

For local dev with `wrangler dev`, put it in `.dev.vars` (git-ignored).

## Data safety

Raw MLS records include private fields (lockbox codes, showing instructions, occupant contact info, private remarks). The Worker only requests and returns the fields in `PUBLIC_FIELDS`. Do not add private fields to that list.

## Adding a real MLS dataset

1. Get the dataset approved for the "Number Ring" app on Bridge.
2. Add its id to `ALLOWED_DATASETS` in `src/worker.js` and to the dataset dropdown in `public/listings/index.html`.
3. Follow the MLS's IDX display rules (attribution, disclaimers, refresh rate) before going live.
