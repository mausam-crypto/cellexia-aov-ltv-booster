# Cellexia AOV & LTV Booster — Master Build Spec

Read `docs/theme-integration.md` FIRST. It contains the theme facts (CartJS, mini-cart DOM,
variant-based volume pricing, Joy selling plans, design tokens) that every widget must respect.

## Architecture

- **Remix app** (`app/`): embedded Polaris admin. Settings stored in Prisma (`ShopSettings.data`,
  JSON) and mirrored on every save to metafields (see below). Analytics via `Event`/`OrderStat`.
- **Theme app extension** (`extensions/cellexia-booster/`): app embeds + app blocks for the
  storefront (cart drawer widgets, PDP badges, clinical results, subscription nudge).
- **3 Checkout UI extensions** (Shopify Plus): `checkout-upsell`, `checkout-protection`,
  `checkout-trust`.
- **App proxy** (`/apps/cellexia/*` → `/proxy/*`): `track` (analytics beacon) and `cart-data`
  (application/liquid — storefront-rendered JSON with variant tiers + selling plans, buyer currency).

## Settings contract

Canonical TypeScript shape: `app/models/settings.server.ts` (`BoosterSettings`, `DEFAULT_SETTINGS`).
Never invent fields — extend that file if something is missing.

Mirrored on save by `app/services/metafields.server.ts` to:
1. **App-data metafield** — owner `AppInstallation`, namespace `cellexia`, key `config`, type `json`.
   Theme extension reads it in Liquid: `{{ app.metafields.cellexia.config.value }}` (a structured
   object; e.g. `app.metafields.cellexia.config.value.cartUpsell.enabled`). May be nil before first
   save — every block must fall back to `DEFAULT_SETTINGS` values via `| default:`.
2. **Shop metafield** — owner `Shop`, namespace `$app:cellexia`, key `config`, type `json`.
   Checkout extensions declare it in their toml and read it via `useAppMetafields()`.

User-facing COPY never lives in settings. It ships as extension locale files (17 languages) and
theme-editor block settings (translatable via Translate & Adapt). Settings hold only booleans,
numbers, ids, URLs, color hexes.

## i18n (Translate & Adapt compatibility)

- Languages (match theme `locales/`): `ar da de el en es fi fr hu it ja nl no pl pt-PT ro sv`.
  `en` is the default (`en.default.json`). Checkout extensions additionally ship `nb.json`
  (copy of `no`) because checkout uses `nb` for Norwegian Bokmål.
- Theme extension: every string via `{{ 'namespace.key' | t }}` with params
  (`{{ 'volume.save_pct' | t: percent: 15 }}`). Block settings may override text per block instance;
  those overrides are theme content → translatable in Translate & Adapt. Defaults must come from
  the `t` filter, NOT hardcoded English.
- Checkout extensions: `useTranslate()` with `{{placeholder}}` interpolation in locale JSON.
- `ar` is RTL: extension CSS uses logical properties (`margin-inline-*`, `padding-inline-*`,
  `inset-inline-*`) — never `left`/`right` physical properties for spacing that matters.
- Selling-plan names and product content are translated by Translate & Adapt natively (Joy plans
  are native selling plans = translatable resources). Our widgets display plan names from
  Shopify data as-is; our own microcopy comes from our locale files.

## Canonical string catalogs

Translators (locale agents) translate EXACTLY these keys. Builders use EXACTLY these keys.

### Theme extension — `extensions/cellexia-booster/locales/en.default.json`

```json
{
  "shipbar": {
    "away_html": "You're {{ amount }} away from free shipping",
    "unlocked": "Congratulations — you've unlocked free shipping!"
  },
  "volume": {
    "title": "Save more per unit",
    "upgrade_to": "Upgrade to {{ count }} units",
    "save_pct": "Save {{ percent }}%",
    "per_unit": "{{ price }} / unit",
    "best_value": "Best value",
    "most_popular": "Most popular",
    "current_pack": "Your current pack",
    "upgraded": "Pack upgraded — you're saving more per unit",
    "error": "Something went wrong. Please try again."
  },
  "subscription": {
    "switch_title": "Make it a Continuous Treatment Plan",
    "switch_cta": "Switch & save {{ percent }}%",
    "benefits": "Save {{ percent }}% on every delivery. Skip, pause or cancel anytime.",
    "switched": "Continuous Treatment Plan activated",
    "nudge_title": "Never run out",
    "nudge_body": "Join the Continuous Treatment Plan: save {{ percent }}% on every delivery, free shipping included. Cancel anytime.",
    "error": "Something went wrong. Please try again."
  },
  "badges": {
    "secure_checkout": "Secure checkout",
    "free_shipping_over": "Free shipping over {{ amount }}",
    "money_back": "{{ days }}-day money-back guarantee",
    "dermatologist_tested": "Dermatologist tested",
    "cruelty_free": "Cruelty free",
    "clinically_proven": "Clinically proven",
    "ssl_encrypted": "SSL-encrypted payment",
    "easy_returns": "Easy returns"
  },
  "guarantee": {
    "title": "{{ days }}-Day Money-Back Guarantee",
    "body": "Love your results or your money back. Not fully satisfied within {{ days }} days? We'll refund you — no questions asked."
  },
  "trustpilot": {
    "excellent": "Excellent",
    "reviews_count": "{{ count }} reviews on",
    "view": "See our reviews on Trustpilot",
    "decimal_separator": "."
  },
  "clinical": {
    "eyebrow": "Clinical results",
    "title": "Proven by science",
    "stat_improvement": "saw visibly improved skin",
    "stat_hydration": "reported deeper hydration",
    "stat_visible": "weeks to first visible results",
    "footnote": "Results from an independent clinical study.",
    "source_label": "Study details"
  },
  "a11y": {
    "close": "Close",
    "loading": "Loading",
    "rating_out_of_5": "Rated {{ rating }} out of 5"
  }
}
```

### Checkout upsell — `extensions/checkout-upsell/locales/en.default.json`

```json
{
  "title": "Complete your routine",
  "subtitle": "Add before your order ships — no extra shipping cost",
  "add": "Add",
  "adding": "Adding…",
  "added": "Added",
  "save_pct": "Save {{percent}}%",
  "error": "Couldn't add the product. Please try again."
}
```

### Checkout protection — `extensions/checkout-protection/locales/en.default.json`

```json
{
  "title": "Order Protection",
  "description": "Protect your order against loss, theft and damage in transit.",
  "price_label": "for {{price}}",
  "added": "Your order is protected",
  "error": "Couldn't update Order Protection. Please try again."
}
```

### Checkout trust — `extensions/checkout-trust/locales/en.default.json`

```json
{
  "guarantee_title": "{{days}}-Day Money-Back Guarantee",
  "guarantee_body": "Love your results or your money back — no questions asked.",
  "secure": "Secure SSL-encrypted checkout",
  "clinical": "Clinically proven formulas",
  "trustpilot": "{{rating}}/5 · {{count}} reviews on Trustpilot"
}
```

(v5.5: the `subscription_hint` line — "Continuous Treatment Plan members
save {{percent}}% on every delivery." — was removed from the checkout trust
module on merchant request, including its key in all 18 locale files.)

## Theme app extension spec (`extensions/cellexia-booster/`)

`shopify.extension.toml`:
```toml
api_version = "2025-07"

[[extensions]]
name = "Cellexia Booster"
handle = "cellexia-booster"
type = "theme"
```

Directory layout (theme app extension conventions):
`blocks/` (each .liquid with `{% schema %}`), `assets/`, `snippets/`, `locales/`.

CSS namespace: every class prefixed `cx-`. One stylesheet `assets/cellexia-booster.css` using the
theme tokens (Gobold/argumentum, #1d1d1b, #b1cded, #f4f4f4, pill radius 70px). Reuse theme utility
classes in markup too (`d-flex`, `btn btn--primary`, `eyebrow`). RTL-safe (logical properties).

### Blocks

1. **`blocks/cart-booster.liquid`** — app embed (`"target": "body"`). The flagship.
   - Renders (hidden) container + per-cart-item Liquid config JSON
     (`<script type="application/json" id="cx-cart-config">`) with: settings blob (from
     `app.metafields.cellexia.config.value`, defaults if nil), free-shipping threshold in cents,
     cart items incl. `item.product.variants` (id/option1/price/compare_at_price/available/position)
     and `item.product.selling_plan_groups` (id/name/plans w/ price_adjustments[0].value),
     `customer.b2b?`, `cart.currency.iso_code`, localized strings needed by JS
     (via `{{ 'key' | t | json }}`).
   - Loads `assets/cellexia-cart.js` (defer) + stylesheet.
   - JS responsibilities (all inside an IIFE, no globals except `window.CellexiaBooster`):
     * Wait for DOM; find `.mini-cart__content`; insert widget root `<div class="cx-cart-booster">`
       BETWEEN `.mini-cart__list` and `.mini-cart__footer` (i.e. sibling; survives refreshMiniCart).
       If mini-cart absent, no-op gracefully.
     * **Free-shipping bar**: progress toward threshold from `/cart.js` totals
       (`items_subtotal_price`); uses global `formatter` (fallback `Intl.NumberFormat` +
       `Shopify.currency.active`). Strings: `shipbar.*`. Hide when disabled.
     * **Volume upsell**: for each cart line whose variant is tier 1 or 2 (variant `position` <
       max tier), offer upgrade tiles for higher tiers (2→−15 %, 3→−20 % — percentages COMPUTED
       from real variant prices: `savings = position*unit_price(tier1) − tier_price`, show
       rounded % off; fall back to configured `volumeOffers` percentages when compare price
       missing). Tile shows `volume.upgrade_to`, per-unit price, savings %; highlight
       `highlightQuantity` with `volume.best_value`. Click = swap line: `/cart/change.js`
       `{id: line.key, quantity: 0}` then `/cart/add.js` `{id: newVariantId, quantity: 1,
       selling_plan?}` (preserve the line's selling plan), then refresh via global
       `refreshMiniCart(cart)` if present else custom minimal refresh + keep drawer open.
     * **Subscription switch**: for one-time lines whose product has a selling plan group (prefer
       plan whose group/plan name matches `sellingPlanKeyword`, case-insensitive; else first
       plan), show one-liner: `subscription.switch_title` + benefits + CTA with plan's REAL
       discount % (`price_adjustments[0].value`). Click = `/cart/change.js`
       `{id: line.key, selling_plan: planId}`. Hidden entirely when `window.isB2BCustomer === true`
       or `data.b2b` true.
     * **Trust row**: compact row (lock icon + `badges.secure_checkout`, guarantee days, Trustpilot
       stars if enabled) above `.mini-cart__actions`.
     * **Data freshness**: on cart mutations (MutationObserver on `.mini-cart__list` childList +
       `.mini-cart` class attr), re-fetch `/cart.js`; if cart contains products not in the Liquid
       config map, fetch `{Shopify.routes.root}apps/cellexia/cart-data` (JSON; see proxy) to
       refresh the variant/plan map. Re-render widgets idempotently.
     * **Tracking**: `navigator.sendBeacon`/fetch POST to
       `{Shopify.routes.root}apps/cellexia/track` — impressions (once per drawer-open per feature),
       `upgrade` (volume swap, include revenue delta), `subscribe` (plan switch). Feature keys:
       `free_shipping_bar`, `cart_upsell`, `subscription_upsell`, `trust_badges`. Fire-and-forget,
       never block UI, wrap in try/catch.
   - Block settings (theme editor, all optional overrides): custom title texts (default empty →
     use `t` strings), toggle placement in cart page too (renders same widgets after
     `.cart__table` on `/cart`).
   - Everything gated on `settings.cartUpsell.enabled` (+ per-widget flags) read from metafield at
     RENDER time (Liquid) — if master switch is off, render nothing at all.

2. **`blocks/pdp-booster.liquid`** — app embed (`"target": "body"`), PDP auto-injection.
   - Only active on product templates (`request.page_type == 'product'`).
   - Renders hidden template markup + loads `assets/cellexia-pdp.js`, which injects:
     * Trust badges row → inside `.pdp__grey` after `.stock-msg` (fallback: after
       `.pdp__actions--flex`; no-op if missing). Uses `trustBadges.items` from config.
     * Guarantee badge (icon + `guarantee.title`) → after the badges row.
     * Trustpilot strip (stars SVG + rating + `trustpilot.reviews_count` + link) → under badges.
     * Subscription nudge card → after `[sm-rc-widget]` / the selling-plan widget container
       (only when product has selling plan groups; respects B2B).
   - All content rendered as Liquid inside the embed (with product context via
     `product` object NOT available in app embeds — so: render TEMPLATES with `t` strings and
     placeholders; JS fills product-specific numbers from the PDP DOM/`ShopifyAnalytics.meta` or
     the config). Keep static copy fully server-rendered for i18n correctness.
   - Gated on respective feature flags. Individual `disable on this page` block settings.

3. **`blocks/trust-badges.liquid`** — app block (`"target": "section"`), same badge row as above
   for merchants to place via theme editor in any section supporting app blocks. Settings: style
   (light/dark), which badges (checkboxes), alignment.

4. **`blocks/guarantee.liquid`** — app block: money-back guarantee card. Settings: days override,
   compact/full layout. Strings `guarantee.*`.

5. **`blocks/trustpilot.liquid`** — app block: Trustpilot rating widget (5-star SVG row with
   partial fill from `trustpilot.rating`, "Excellent", count + link to `profileUrl`).
   Note: config metafield holds rating/count/url; block settings can override per instance.

6. **`blocks/clinical-results.liquid`** — app block: stat band (Gobold numbers + argumentum
   labels), `clinical.*` strings, stats from config metafield (value/suffix/labelKey), block
   settings allow custom label text per stat (overrides labelKey lookup). Optional CTA link.

7. **`blocks/subscription-nudge.liquid`** — app block version of the nudge card (for sections
   supporting app blocks / footer of PDP), `subscription.nudge_*` strings.

`snippets/cx-icons.liquid`: inline SVG icon set (lock, truck, shield-check, leaf, star,
star-half, droplet, check, refresh) parameterized `{% render 'cx-icons', icon: 'lock' %}`.
Monochrome `currentColor`, 20×20 viewBox.

### Analytics beacons from blocks
Impression beacons only when feature visible; use `sendBeacon` with JSON blob; endpoint accepts
`{feature, type, quantity?, revenue?, currency?, meta?}`.

## Checkout UI extensions spec

Common toml shape (per extension, adjust name/handle/description):
```toml
api_version = "2025-07"

[[extensions]]
name = "Cellexia Checkout Upsell"
handle = "cellexia-checkout-upsell"
type = "ui_extension"

  [[extensions.targeting]]
  module = "./src/Checkout.tsx"
  target = "purchase.checkout.block.render"

  [extensions.capabilities]
  api_access = true

  [[extensions.metafields]]
  namespace = "$app:cellexia"
  key = "config"
```
Each extension dir: `package.json` (name `checkout-…`, deps `react` ^18.2, `@shopify/ui-extensions`
+ `@shopify/ui-extensions-react` at `"2025.7.x"`), `tsconfig.json`, `src/Checkout.tsx`, `locales/`.
Read config: `useAppMetafields()` → find entry with `metafield.key === 'config'` → JSON.parse →
merge over hardcoded defaults (metafield may be missing). Respect `enabled` flags: render `null`
when off. All components from `@shopify/ui-extensions-react/checkout`. Use `useTranslate()`,
`useApplyCartLinesChange()`, `useCartLines()`, `useApi()` (for `query` — Storefront API).

1. **checkout-upsell**: reads `checkoutUpsell.variantIds` (Storefront `nodes(ids:)` query for
   title/price/compareAtPrice/image/availableForSale), filters out variants already in cart +
   unavailable, shows up to `maxOffers` compact offer rows (image, title, price, compare-at
   strikethrough + `save_pct`, Add button). Add via `applyCartLinesChange` `addCartLine` with
   attribute `{key: "_cellexia_upsell", value: "checkout"}`. Handle result.type === 'error' with
   inline error text. Loading/added states on the button.
2. **checkout-protection**: reads `checkoutProtection` config (variantId, defaultOn). Queries the
   variant's price via Storefront API. Renders a toggle/checkbox card (shield icon, title,
   description, price). ON → `addCartLine` (qty 1, attribute `_cellexia_protection: "1"`);
   OFF → `removeCartLine`. If `defaultOn` and not yet in cart and buyer hasn't interacted this
   session, auto-add once (guard with useRef; never re-add after manual removal). Detect existing
   protection line by merchandiseId. Render null if variantId missing.
3. **checkout-trust**: reads `checkoutTrust`, `guarantee`, `trustpilot`, `subscriptionNudge`
   config; renders a compact trust module: guarantee line (shield icon), secure checkout line
   (lock icon), Trustpilot line (stars + `trustpilot` string), optional subscription hint when
   cart has no subscription lines. Pure display, no mutations.

## Admin dashboard spec (`app/routes/`)

Patterns:
- Loader: `const { session, admin } = await authenticate.admin(request);` then
  `getSettings(session.shop)`.
- Action: parse `formData.get("patch")` (JSON string of `DeepPartial<BoosterSettings>`), call
  `saveSettings` (which sanitizes/clamps values server-side), then
  `syncSettingsToMetafields(admin, next)`; return `{ ok, syncErrors }`;
  show Toast (`shopify.toast.show` via App Bridge) on result.
- All pages Polaris (Page, Layout, Card/BlockStack, SettingToggle-style cards, Banner for sync
  errors). TitleBar from `@shopify/app-bridge-react`.

Routes (all under `app.` prefix, already-linked in `app/routes/app.tsx` NavMenu):
- `app._index.tsx` — Dashboard: hero stats row (30-day AOV, units/order, subscription rate,
  protection attach — from `getAnalyticsSummary`), grid of feature cards each with status badge
  + enable/disable toggle (action intent `toggle`, dot-path e.g. `cartUpsell.enabled`) + link to
  its settings page. "Open theme editor" + "Open checkout editor" external links
  (`https://admin.shopify.com/store/{storePrefix}/themes/current/editor?context=apps`,
  `https://admin.shopify.com/store/{storePrefix}/settings/checkout/editor`).
- `app.features.cart.tsx` — cart upsell config (bar toggle, volume offers editor with qty+pct
  rows, highlight select, subscription switch toggle + keyword, trust row toggle) + live-ish
  HTML preview card mimicking the drawer widget (static, brand-styled).
- `app.features.checkout.tsx` — upsell (enable, variant multi-picker w/ search via
  `app.api.variants` fetcher, maxOffers), protection (enable, price field + "Create/verify
  protection product" action → `ensureProtectionProduct`, defaultOn), trust module toggles.
- `app.features.badges.tsx` — trust badges (enable, style, badge checkboxes ordered), Trustpilot
  (enable, rating 0–5 step .1, review count, profile URL), guarantee (enable, days).
- `app.features.clinical.tsx` — enable + stats editor (value, suffix, label preset select
  mapping to labelKeys, up to 4) + footnote note explaining translations.
- `app.features.subscriptions.tsx` — nudge enable, discount pct, selling-plan keyword, and a
  "How it works with Joy Subscription" explainer card (native selling plans, T&A translates
  plan names).
- `app.analytics.tsx` — period select (7/30/90), stat cards, funnels DataTable
  (feature/impressions/clicks/conversions/revenue), empty state.
- `app.localization.tsx` — GraphQL `shopLocales { locale name primary published }`, table of shop
  languages vs our 17 shipped languages (✓ badge), step-by-step Translate & Adapt guide
  (theme content → app embeds; metafields note; selling plan names).
- `app.settings.tsx` — free-shipping threshold, brand colors (3 hex fields, prefilled from
  branding), "Re-sync storefront config" button (re-runs metafield sync), install status
  (deep link to theme editor app embeds:
  `https://{shop}/admin/themes/current/editor?context=apps`).
- `app.api.variants.tsx` — loader-only JSON: `?q=` → `searchVariants`, `?ids=` →
  `getVariantsByIds` (for hydrating saved pickers).

## Analytics taxonomy

feature ∈ `cart_upsell, free_shipping_bar, subscription_upsell, subscription_nudge, trust_badges,
trustpilot, guarantee, clinical_results, checkout_upsell, checkout_protection, checkout_trust`
type ∈ `impression, click, upgrade, subscribe, add_to_cart, protect_on, protect_off, conversion`
(`app/services/analytics.server.ts` whitelists these.)

## Conventions

- TypeScript strict; no `any` unless unavoidable. Remix v2 flat routes.
- Liquid: whitespace-controlled tags, `| t` for ALL copy, `| json` for data, defensive
  `| default:` everywhere metafields are read.
- JS assets: vanilla ES2019 IIFE (theme supports older Safari), no build step, jQuery allowed
  (theme guarantees it) but prefer vanilla; NEVER assume our elements exist.
- Never break the theme: all injections feature-test selectors and silently no-op.
- Keep files self-contained; do not edit files owned by another workstream (see file map above).
