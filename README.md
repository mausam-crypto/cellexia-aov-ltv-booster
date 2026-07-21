# Cellexia AOV & LTV Booster

A custom Shopify app for **Cellexia** that adds every conversion, AOV and LTV lever a CRO expert
would want — designed to slot natively into the existing "Sleepify" theme, work in all 17 store
languages via **Translate & Adapt**, and integrate with **Joy Subscription** (native selling plans).

## Features (all individually toggleable from the admin dashboard)

| Area | Feature | Where |
|---|---|---|
| Cart drawer | Free-shipping progress bar (threshold configurable, default 150) | Theme app embed |
| Cart drawer | Volume upgrade tiles — swap a 1-unit line to the 2-unit (−15%) or 3-unit (−20%) variant in one tap | Theme app embed |
| Cart drawer | One-tap switch of a one-time line to the **Continuous Treatment Plan** (Joy selling plan, −5%) | Theme app embed |
| Cart drawer | Compact trust row (secure checkout · guarantee · Trustpilot) | Theme app embed |
| Product page | Trust badges under the add-to-cart button | Theme app embed (auto-inject) + app block |
| Product page | Money-back guarantee badge, Trustpilot strip, subscription nudge | Theme app embed (auto-inject) + app blocks |
| Anywhere | Clinical study results band (stat numbers + translated labels) | App block |
| Checkout (Plus) | Product upsells ("Complete your routine") with one-tap add | Checkout UI extension |
| Checkout (Plus) | Order Protection add-on (a few $/€ per order) | Checkout UI extension |
| Checkout (Plus) | Trust module: guarantee, secure checkout, Trustpilot, subscription hint | Checkout UI extension |
| Admin | Dashboard with per-feature toggles, settings pages, variant pickers | Embedded Polaris app |
| Product page | **Clinical study widget** — per-product instrumented study ("83% showed measurable reduction… n=112, corneometer/VISIA") with numbered results | Theme app embed + metaobjects |
| Product page | **Verified before/after** — timestamped, VISIA-imaged at a partner clinic, verified by a named dermatologist with license # | Theme app embed + metaobjects |
| Product page | **Batch transparency** — published certificates of analysis + actual ingredient concentrations ("2% encapsulated, not a 'blend'") | Theme app embed + metaobjects |
| Product page | **Empty bottle guarantee** — return the empty bottle within 60 days for a full refund | Theme app embed |
| Product page | **Dermatologist survey** — "9 out of 10 dermatologists surveyed would recommend" (n=270) with third-party verification seal | Theme app embed |
| Admin | **Product boosters**: per-product content editors (studies, B/A images with uploads, CoAs) + per-product on/off | Embedded Polaris app |
| Admin | **Markets**: feature × market matrix — turn any feature on/off per market, whole-market one-click enable, "all markets" switch | Embedded Polaris app |
| Admin | **Experiments**: sequential rollout tracker per market with baseline comparison + statistical early-warning (never A/B) | Embedded Polaris app |
| Admin | Analytics: AOV, units/order, subscription rate, protection attach rate, per-feature funnels | Embedded Polaris app |
| Admin | Localization overview + Translate & Adapt guide | Embedded Polaris app |

## Real preview — see it live before anyone else does

The **Preview** page is the launch workflow: pick features → arm preview → open the preview
link → you're browsing your **actual live store** with the draft widgets rendered in place
(real theme, real cart drawer, real product data, simulated market) while every real visitor
sees the site completely unchanged. A "visible only to you" bar marks preview mode; analytics
beacons are fully suppressed; checkout preview works through a token-verified preview cart
(and preview checkouts never enter analytics). When it looks right, the **Go live** card
applies exactly those features to the market(s) you choose — with experiment-lock guards.
Not a mockup: it is the production rendering, gated by a server-verified token.

## Setup & health

The **Setup & health** page runs nine programmatic checks before you launch: config
metafields in sync, app embeds actually enabled in the published theme (read via the Themes
API), theme selectors the widgets target still present, webhooks registered, protection
product active + published, metaobject definitions created, language coverage, order-data
flow, and preview hygiene. The dashboard shows a banner until everything passes — when it's
green, the install is verifiably launch-ready.

## Safe by default

A fresh install changes **nothing** on the storefront or in checkout:

- Every feature ships disabled; a missing config metafield means *hidden*, never "default on".
- Theme app embeds additionally start disabled in the theme editor (Shopify native behavior),
  and checkout blocks only exist once you place them in the checkout editor.
- Features go live only when you enable them in the dashboard — globally or per market.

## Per-market targeting

Every feature carries a market scope: **All markets** or a selected list of Shopify Markets
(e.g. roll the cart volume upsell out to Ireland first). The **Markets** page is a feature ×
market matrix: check/uncheck any cell, enable a whole market in one click, or flip a feature
back to "all markets". Enforced server-side in Liquid (`localization.market`) and in checkout
extensions (which *fail closed* — if the buyer's market can't be determined and the feature is
market-restricted, it stays hidden).

## Experiments (sequential — deliberately not A/B)

For Google Ads compliance there is never more than one live version per market. An experiment:

1. Pick a market (or all markets) and a baseline window (7/14/21/28 days) — the app shows the
   baseline metrics it already has for that market.
2. Pick one or more features to flip (on *or* off). Starting the experiment applies the flips
   for that market only and snapshots the previous state.
3. The tracker then compares an equal-length window against the baseline: sessions, orders,
   conversion rate, AOV, revenue/day, units/order, subscription and protection attach rates.
4. **Early warning**: after a few days, Welch t-tests (AOV, orders/day, revenue/day) and
   two-proportion z-tests (conversion & attach rates) flag drops too large to be random —
   a red banner recommends stopping when the evidence is strong (p < 0.01 or a >15 % drop).
5. Conclude (or stop early) with one of two buttons: **Keep the changes** or **Roll back** to
   the snapshotted state. The final report shows both windows side by side with plain-language
   significance ("very unlikely to be random, p = 0.008").

Conversion rate uses a lightweight once-per-session beacon from the theme embed as its
denominator — it collects whenever the Cart Booster app embed is active (regardless of which
features are on), and the tracker automatically marks conversion comparisons "n/a" when
session tracking didn't cover the full baseline window. **One experiment per market** can run
at a time (concurrent experiments across different markets are fine; within any market there
is only ever one live configuration — never an A/B split). Two running experiments can never
touch the same feature, which keeps every rollback provably safe. Reports state the usual
caveat of sequential comparisons: seasonality and traffic changes are not controlled for.

## PDP trust boosters & Translate & Adapt

Per-product content (study details, before/after entries, ingredient disclosures, CoAs)
lives in **Shopify metaobjects** created by the app — so every text field is translatable in
Translate & Adapt under **Content → Metaobjects**, Liquid renders the buyer's language
automatically, and you can even edit the raw entries in Shopify admin → Content. The app's
**Product boosters** section gives you the friendly editor: pick a product, fill in the
study/B-A/batch content (image + PDF uploads included), and flip per-product switches.
Widget microcopy (headings, "Verified by…", guarantee copy) ships pre-translated in all 17
languages like everything else. Each of the five widgets is individually toggleable globally,
per market (Markets matrix), and per product.

## How the pieces fit

```
┌────────────────────────┐   save    ┌──────────────────────────────────────┐
│  Polaris admin (Remix) │ ────────► │ Prisma (ShopSettings JSON)           │
│  toggles + settings    │           │   └► mirrored to metafields:         │
└────────────────────────┘           │      • AppInstallation cellexia.config│──► Theme extension (Liquid)
                                     │      • Shop $app:cellexia.config      │──► Checkout UI extensions
                                     └──────────────────────────────────────┘
Storefront widgets ──► /apps/cellexia/track (beacons) ──► Event table ──► Analytics page
orders/paid webhook ──► OrderStat table (AOV, attach rates)
/apps/cellexia/cart-data (application/liquid) ──► fresh variant tiers + selling plans, buyer currency
```

- **Copy vs config**: feature flags, numbers, ids live in the settings JSON; **all storefront copy
  ships as extension locale files** (the same 17 languages as the theme) so Translate & Adapt
  manages translations exactly like theme content. Text overrides typed into theme-editor block
  settings are theme content → also translatable in Translate & Adapt.
- **Volume pricing**: Cellexia sells 1/2/3-unit tiers as *variants* (position = units). The cart
  upsell swaps the line to the higher-tier variant (preserving any selling plan), it never just
  bumps quantity.
- **Joy Subscription**: Joy creates native Shopify selling plans. Widgets read the real discount
  from `selling_plan.price_adjustments[0].value` (5% is only the default), switch lines to a plan
  via `/cart/change.js`, and hide all subscription UI for B2B customers.

## Prerequisites

- Node 20+, npm
- A [Shopify Partner](https://partners.shopify.com) account (or store-owner access for a custom app)
- The Cellexia store (Shopify Plus — required for checkout UI extensions)
- Joy Subscription and Translate & Adapt installed on the store

## First-time setup

```bash
cd cellexia-aov-ltv-booster
npm install
npm run config:link   # connect to (or create) the app in your Partner dashboard
npm run dev           # tunnels, hot-reloads app + all extensions, offers install to dev store
```

`shopify.app.toml` ships with `client_id` empty — `npm run config:link` fills it. Scopes used:
`read_products, write_products, read_publications, write_publications, read_orders, read_locales, read_translations`
(publications scopes let the app publish the Order Protection product to the Online Store channel).

### Deploy

```bash
npm run deploy        # pushes the extensions + config as a new app version
```

Host the Remix backend anywhere Node runs (Fly.io, Render, Heroku…). Set env vars
`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, `DATABASE_URL`
(swap `prisma/schema.prisma` datasource to Postgres for production) and run
`npm run setup && npm run start`.

### Store wiring after install (one-time, ~5 minutes)

1. **Theme editor → App embeds** — enable **Cellexia Cart Booster** and **Cellexia PDP Booster**
   (Online Store → Themes → Customize → App embeds). The cart/PDP widgets auto-inject into the
   existing mini-cart drawer and product page — no theme code edits required.
2. **Optional app blocks** — in the theme editor, add "Trust badges", "Guarantee",
   "Trustpilot", "Clinical results", "Subscription nudge" blocks to any section that accepts app
   blocks (home page, landing pages…).
3. **Checkout editor** (Settings → Checkout → Customize) — drag the three Cellexia blocks
   (Upsell, Order Protection, Trust) where you want them (typical: protection above payment,
   upsell below line items, trust in the footer of the order summary).
4. **Order Protection product** — in the app: Checkout → "Create / verify protection product"
   (creates a hidden `cellexia-order-protection` product and stores its variant).
5. **Analytics** — orders/paid webhook is registered automatically on deploy;
   protected-customer-data access (orders) must be approved in the Partner dashboard for
   production.

## Translate & Adapt workflow

- Widget copy ships pre-translated in: `ar da de el en es fi fr hu it ja nl no pl pt-PT ro sv`
  (matching the theme's locales; checkout also ships `nb`). Nothing to do for these.
- To *change* a string in any language: Translate & Adapt → Online Store → Theme → **App embeds /
  App blocks** (text overrides you typed in the theme editor appear here and are translatable
  per language).
- Joy plan names ("Continuous Treatment Plan") are native selling plans → translate them in
  Translate & Adapt under Products → the subscription plan resource.
- The Localization page inside the app shows your published shop languages next to the languages
  the widgets ship with.

## Development notes

- `npm run typecheck` — strict TS across the Remix app.
- Theme extension JS is dependency-free ES2019 (`extensions/cellexia-booster/assets/`); it
  feature-tests every selector and silently no-ops if the theme changes.
- The storefront reads config from metafields at render time — the "Re-sync storefront config"
  button on the Settings page rewrites them if they ever drift.
- `docs/SPEC.md` is the binding feature/contract spec; `docs/theme-integration.md` documents the
  exact theme DOM/JS the widgets integrate with (CartJS, `refreshMiniCart`, `.mini-cart__list`
  sibling injection, etc.). Read both before changing widget behavior.

## Deliberately out of scope (for now)

- **Post-purchase one-click upsell** (`checkout_post_purchase` extension) — biggest remaining AOV
  lever; needs changeset-signing endpoints in the backend. The in-checkout upsell covers the
  requested scope.
- **Web pixel extension** — storefront beacons + orders webhook already cover funnel analytics.
- **Automatic Trustpilot rating sync** — rating/count are entered in the dashboard (Cellexia
  currently reviews on Stamped.io; the Trustpilot widget is ready the day the profile is live).
