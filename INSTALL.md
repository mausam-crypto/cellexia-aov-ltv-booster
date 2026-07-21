# Cellexia AOV & LTV Booster — Developer Install Guide

This is a complete, custom Shopify app for the Cellexia store (Shopify Plus). It ships an
embedded Polaris admin, a theme app extension (cart + product-page widgets), and three
checkout UI extensions — pre-translated into the store's 17 languages.

**Read this file top to bottom before running anything.** Total time: ~30 min for a dev
install, ~1–2 h including production hosting.

---

## 0. What you're deploying (60-second orientation)

| Piece | Where it runs | What it does |
|---|---|---|
| Remix app (`app/`) | Your Node host (or `npm run dev` tunnel) | Embedded admin dashboard, settings, analytics, experiments, webhooks, app proxy |
| Theme app extension (`extensions/cellexia-booster/`) | Shopify CDN | Cart drawer upsells, free-shipping bar, PDP trust widgets (clinical study, verified B/A, batch transparency, guarantee, derm survey) |
| Checkout UI extensions (`extensions/checkout-*/`) | Shopify checkout | Upsell, Order Protection, trust module (Plus only) |
| Prisma DB | SQLite (dev) / Postgres (prod) | Sessions, settings, analytics events, experiments |

Two things to know before you start:

1. **Safe by default** — after install, NOTHING appears on the storefront or checkout
   until a feature is switched on in the app's dashboard. Don't be surprised by an
   "empty" storefront; that's by design.
2. **Settings flow** — the dashboard saves to the DB and mirrors config to metafields
   (`cellexia.config` app-data metafield for Liquid; `$app:cellexia.config` shop
   metafield for checkout). The storefront reads only metafields, so the app server
   being down never breaks the storefront.

## 1. Prerequisites

- Node **20+** and npm (Node 18.20+ works; 20 LTS recommended)
- A **Shopify Partner account** with access to the Cellexia store's organization
  (or collaborator access to the store) — https://partners.shopify.com
- The target store must be **Shopify Plus** (checkout UI extensions require it)
- Apps already on the store: **Joy Subscription** (native selling plans) and
  **Translate & Adapt** (translations) — both are integrated with, not bundled
- No global Shopify CLI needed — it's a dev dependency (`npx shopify` works after install)

## 2. Local setup & first run

```bash
unzip cellexia-aov-ltv-booster-*.zip && cd cellexia-aov-ltv-booster
npm install                 # installs app + all extension workspaces
npm run config:link         # connect to the Partner org:
                            #   → choose "Create this app as a new app"
                            #   → name: "Cellexia AOV & LTV Booster"
                            # (fills client_id in shopify.app.toml automatically)
npm run dev                 # starts tunnel + hot reload, offers install on a store
```

`npm run dev` prints an install link — use a **development store** first. The predev
hook runs the Prisma migrations automatically. Approve the OAuth scopes when prompted.

> **Scopes** (already declared in `shopify.app.toml`): products, publications, orders,
> locales, translations, markets, metaobjects (+definitions), files.
> **Production note:** the `orders/paid` webhook carries protected customer data — for
> the production app, request **Protected customer data access → Orders** in the Partner
> dashboard (App → API access). Without it, order analytics/experiment metrics stay empty
> on the live store (everything else works).

Sanity checks that must pass from a fresh clone:

```bash
npm run typecheck   # strict TS across the Remix app
npm run build       # production client + SSR build
```

## 3. Deploy the extensions

```bash
npm run deploy      # pushes theme extension + 3 checkout extensions + app config
```

`include_config_on_deploy = true` is set, so `shopify.app.toml` (scopes, webhooks, app
proxy) ships with each version. Re-run `npm run deploy` after any extension change.

## 4. Production hosting (the Remix server)

Any Node host works (Fly.io, Render, Railway, Heroku, a VPS). A `Dockerfile` is included.

1. **Database**: switch Prisma to Postgres for production — in `prisma/schema.prisma`
   change the datasource to `provider = "postgresql"` + `url = env("DATABASE_URL")`,
   then run `npx prisma migrate deploy` on the host (the `setup` npm script does this).
2. **Environment variables** (see `.env.example`):
   - `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` — from the Partner dashboard (App → settings)
   - `SHOPIFY_APP_URL` — your public https URL
   - `SCOPES` — copy the exact list from `shopify.app.toml`
   - `DATABASE_URL` — Postgres connection string
3. **URLs — all FOUR places**: in `shopify.app.toml` set to your host URL:
   `application_url`, the three `redirect_urls`, **and `[app_proxy] url`** — the proxy
   URL is your host **plus `/proxy`** (e.g. `https://app.example.com/proxy`). Then
   `npm run deploy`. ⚠️ Forgetting the app proxy is the #1 silent breakage: the admin
   works fine, but preview links, storefront analytics and cart data all 404 on
   `/apps/cellexia/*`. If you created the app via `shopify app config link`, ALSO verify
   the `[app_proxy]` block still exists in the toml afterwards (the CLI rewrites the file
   from remote config and drops the block if the remote app had no proxy). The
   **Setup & health** page's "App proxy reachable" check verifies this end-to-end.
4. Start: `npm run setup && npm run start` (or the Docker image, which does both).
5. Open the app from the store admin once — OAuth completes and sessions persist.

## 5. Store wiring (one-time, ~10 minutes — do these in order)

1. **App admin → any page** — loads once to run first-time setup. Visiting
   **Product boosters** auto-creates the metaobject definitions (Content → Metaobjects
   in Shopify admin will show six `cellexia_*` types) and the product metafield
   definitions. Errors surface in a banner; it's idempotent, reload to retry.
2. **Settings → Save once** (even without changes) — writes the config metafields the
   storefront reads.
3. **Theme editor → App embeds** (Online Store → Themes → Customize → App embeds):
   enable **Cellexia cart booster** and **Cellexia PDP booster**. No theme code edits —
   widgets auto-inject into the existing mini-cart drawer and product pages.
4. **Checkout editor** (Settings → Checkout → Customize): add the three Cellexia blocks
   (Upsell, Order Protection, Trust) where the design calls for them (typical:
   protection above payment, upsell under line items, trust in the summary footer).
5. **App → Checkout → "Create / verify protection product"** — creates the hidden
   `cellexia-order-protection` product, publishes it to the Online Store channel, and
   stores its variant. (Keep it published; hide it from search/collections via theme
   if desired — do NOT remove it from the Online Store channel.)
6. **Setup & health green** — open **Setup & health** in the app and fix anything red
   (it verifies the steps above programmatically, including whether the app embeds are
   really enabled in the published theme).
7. **Preview, then go live** — on the **Preview** page: pick features → Arm → open the
   preview link (new tab) to see them rendered on the real site (only you can see them;
   simulated market supported; checkout preview included) → back in the app, **Go live**
   for the market(s) you choose. Or flip features directly on the dashboard/Markets page.
   Remember: everything ships OFF until you enable it.

Optional: add the drag-and-drop app blocks (trust badges, guarantee, Trustpilot,
clinical results, subscription nudge) to JSON-template pages via the theme editor.

## 6. Per-product content (PDP trust boosters)

App → **Product boosters** → pick a product → fill in the clinical study, verified
before/after entries (image upload or URL), batch transparency (ingredients + CoA PDFs),
and per-product switches. All of this is stored in Shopify **metaobjects**, so:

- Translate & Adapt translates it under **Content → Metaobjects** (field-by-field).
- The storefront automatically renders the buyer's language.
- Raw entries are also editable in Shopify admin → Content → Metaobjects.

Widget microcopy (headings, "Verified by…", guarantee copy) is already translated in all
17 store languages; merchants can override any text per block in the theme editor and
translate overrides in Translate & Adapt like any theme content.

## 7. Verifying the install (smoke test)

1. Dashboard shows the onboarding banner ("not live anywhere yet") → enable
   **Cart upsells** → storefront: add a 1-unit product to cart → drawer shows the
   free-shipping bar + "Upgrade to 2/3 units" tiles → upgrade swaps the variant.
2. Enable **Order Protection** (after step 5.5) + place the block in checkout →
   checkout shows the protection toggle; toggling adds/removes the fee line.
3. Configure a clinical study on one product + enable **Clinical study** → that
   product's PDP shows the study band; other products don't.
4. **Markets** page: restrict a feature to one market → verify it disappears from the
   other market's storefront (use market URL prefixes to test).
5. **Experiments**: create one for a single market (needs ≥ a few days of order history
   for a meaningful baseline; conversion-rate rows read "n/a" until the session beacon
   has collected data — expected on day one).

## 8. Troubleshooting

- **Preview link / `/apps/cellexia/*` returns 404 on the storefront**: the App Proxy is
  missing or points at the wrong upstream. Check Setup & health → "App proxy reachable".
  Fix: Partner Dashboard → your app → App setup → **App proxy**: prefix `apps`, subpath
  `cellexia`, URL `https://<your-app-host>/proxy` — or set `[app_proxy] url` in
  `shopify.app.toml` and `npm run deploy`. Verify by opening
  `https://<store>/apps/cellexia/track` — it must answer
  `{"ok":true,"service":"cellexia-booster"}`.
- **Widgets don't render**: (a) feature enabled? (b) Settings saved at least once?
  (c) app embeds enabled in THE PUBLISHED theme? (d) market scope includes the market
  you're viewing? (e) for PDP content widgets — product has content AND its per-product
  switch is on?
- **Checkout blocks missing**: they must be added in the checkout editor (step 5.4);
  config metafield must exist (step 5.2); feature enabled.
- **Scope errors after pulling a new version**: merchants must re-approve OAuth when
  scopes change — open the app in admin and accept.
- **Do not** change the Polaris CSS imports to the `?url` + links pattern — it breaks
  the Vite build in this workspace (side-effect imports are intentional).
- **Order analytics empty in prod**: request Protected customer data (orders) access
  (see §2) and re-deliver a test order.

## 9. Codebase map

- `README.md` — feature overview + architecture diagram
- `docs/SPEC.md`, `docs/SPEC-v2-markets-experiments.md`, `docs/SPEC-v3-pdp-boosters.md`
  — binding specs (settings contract, market gating, experiments math, metaobject model)
- `docs/theme-integration.md` — exact coupling to the Sleepify theme (CartJS,
  `refreshMiniCart`, injection selectors). **Read before touching widget code.**
- `app/models/settings.server.ts` — the settings/feature-flag contract (single source
  of truth; all market/flag logic goes through its helpers)
- `app/services/` — metafield sync, metaobjects, PDP content, markets, experiments, stats
- `extensions/cellexia-booster/` — theme extension (blocks, JS, CSS, 18 locale files)
- `extensions/checkout-*/` — checkout UI extensions (React, typed against 2025-07)
