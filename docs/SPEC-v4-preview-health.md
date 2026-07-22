# SPEC v4 — Real Preview System, Setup & Health, Admin UX Overhaul

Extends SPEC v1–v3. Three pillars: (A) a REAL preview system — the actual widgets rendered
on the actual live site, visible only to the merchant; (B) programmatic setup/health checks
so a fresh install is verifiably launch-ready; (C) admin UX reorganization.

## A. Preview system

### Principles (non-negotiable)

1. **Real rendering only.** Previews are the production Liquid/JS/CSS rendering on the
   production storefront (and real checkout for checkout blocks). No admin-side mockups.
2. **Zero visitor impact.** When preview is DISARMED, the rendered page output for
   visitors is byte-identical to v3 behavior. When ARMED, real visitors get only inert
   hidden `<template>` nodes (no visible/behavioral change); only a browser holding the
   preview session sees draft widgets.
3. **No secrets in page source.** The raw preview token appears only in the entry URL
   (and is stripped from the address bar via `history.replaceState` immediately after
   the hub seeds sessionStorage — third-party trackers in the theme layout must not see
   it via page_location/referrer) and in sessionStorage of the previewing browser; it is
   verified SERVER-SIDE (app proxy). Neither the token nor its hash is ever written to
   the app-data metafield that feeds page-visible Liquid config. The shop metafield —
   reachable only by our checkout extensions — carries ONLY `tokenHash` (sha256 hex of
   the raw token) for checkout preview comparison; the raw token never ships to a
   buyer's checkout session.
4. **No data pollution.** Preview mode suppresses ALL beacons (session + impressions +
   conversions); orders carrying the preview attribute are skipped by the orders webhook.

### Data model

New Prisma model:
```prisma
model PreviewState {
  id            Int      @id @default(autoincrement())
  shop          String   @unique
  token         String                    // RAW preview token (at-rest by design, see below)
  armed         Boolean  @default(false)
  armedAt       DateTime?
  draftFlags    String   @default("{}")   // JSON Record<FeatureKey, boolean>
  simulatedMarket String?                 // market handle for effective-flag simulation
  productHandle String?                   // preferred PDP preview product
  updatedAt     DateTime @updatedAt
  createdAt     DateTime @default(now())
}
```
(MIGRATED — done in scaffold.) Raw token: 32 hex chars (crypto.randomBytes(16)),
regenerable; verified with a timing-safe comparison of the raw token.

**Raw-token-at-rest is the deliberate design** (not an oversight): this is a custom
single-merchant app running against its own server-side DB, and keeping the raw token
recoverable is what makes the persistent, shareable entry URL possible (the Preview
Center can always rebuild and display it without forcing a rotation). The surfaces a
page or buyer can see carry no raw token: the app-data metafield is tokenless, the
checkout shop metafield carries the sha256 `tokenHash` only, and the entry URL is
stripped from the address bar via `history.replaceState`. Do NOT "harden" the DB to
hash-at-rest — it would break URL recovery for zero practical gain here.

### Config metafield changes (metafields.server.ts — split payloads)

`syncSettingsToMetafields` now takes an optional preview payload and writes DIFFERENT
values to the two metafields:
- App-data metafield (Liquid-visible): settings + `preview: { armed, draftFlags }` —
  NO token, NO hash.
- Shop metafield (checkout-only): settings + `preview: { armed, draftFlags, tokenHash }`
  where `tokenHash` = sha256 hex of the raw token, computed at write time inside
  syncSettingsToMetafields (the sync payload's `token` field stays the RAW input);
  written as `""` whenever disarmed.
Both written on every settings save AND on every preview arm/disarm/draft change (the
preview service re-syncs). `armed` false ⇒ `draftFlags` written as `{}` and `tokenHash`
as `""` (defense in depth).

### Server (new `app/services/preview.server.ts`)

- getPreviewState(shop) / ensurePreviewState(shop) (creates row with fresh token).
- armPreview(shop, admin, {draftFlags, simulatedMarket?, productHandle?}) → validates
  flags (FeatureKey booleans only), stores, sets armed:true + armedAt, re-syncs
  metafields. disarmPreview(shop, admin) → armed:false, draftFlags "{}", re-sync.
- rotateToken(shop, admin) → new token (returned RAW for URL building; raw-at-rest means
  the URL stays rebuildable later without rotating), re-sync shop metafield (hash only).
- verifyToken(shop, rawToken) → timing-safe comparison of the raw token against
  PreviewState.token (raw-at-rest by design, see §Data model); used by proxy endpoints.
- buildPreviewUrls(shopDomain, rawToken, {productHandle, market}) → entry URL etc.

### Storefront entry + config (app proxy routes)

- `proxy.preview.tsx` (`/apps/cellexia/preview?t=<raw>`): authenticate.public.appProxy;
  verifyToken; INVALID → tiny Liquid page "Preview link expired" ({% layout none %}).
  VALID → `application/liquid` WITHOUT `{% layout none %}` so Shopify wraps it in the
  REAL theme layout (header, footer, mini-cart drawer, all theme CSS/JS, our embeds).
  Body: a compact "Cellexia Preview Hub" panel (inline-styled, cx- classes):
  explains preview is active, an inline script stores
  `sessionStorage.cx_preview_token = <raw>` + `cx_preview_ok = '1'` (the storefront
  runtime keys its inline session-beacon suppression on `cx_preview_ok`; the entry page
  is server-verified so seeding it optimistically is correct) + `cx_preview_market =
  <market param>`, then immediately strips the token-bearing query string from the
  address bar via `history.replaceState(null, '', location.pathname)` (inside the same
  try/catch), then quick actions: link to the chosen product page (from ?product= handle, validated
  via all_products), "browse the store", and a "Checkout preview" button (JS: POST
  /cart/add.js with the product's first available variant + attributes[_cx_preview]=raw
  token via /cart/update.js, then location '/checkout'). Never `{% layout none %}` on
  the valid path — the whole point is the real site shell.
- `proxy.preview-config.tsx` (`/apps/cellexia/preview-config?t=<raw>`): JSON (NOT
  liquid): verifyToken → `{ valid, armed, draftFlags, simulatedMarket }`; invalid →
  `{ valid: false }` (200, no details — definitively invalid, the runtime drops the
  token); unexpected server errors → `{ valid: false, retriable: true }` (503 — the
  runtime keeps the token and may retry). Cache-Control: no-store on both.

### Theme extension preview runtime

`cart-booster.liquid` + `pdp-booster.liquid`:
- Read `cfg.preview.armed` + `cfg.preview.draftFlags` (app-data metafield — tokenless).
- Template rendering gates become: render a widget's `<template>` when
  `liveEffective OR (preview.armed AND draftFlags[key] == true)`. Draft-only templates
  carry `data-cx-draft="1"`. Existing live-path markup/behavior UNCHANGED (byte-identical
  when disarmed — verify by diffing rendered branches).
- Config JSON gains `previewArmed: bool` + `draftFlags` + `draftScopes`? NO — keep it
  minimal: `preview: { armed, flags: draftFlags }` only. (Draft market simulation is
  resolved at runtime from the fetched preview-config + simulatedMarket; scope logic for
  preview only = the simulated market is chosen in the Preview Center, the server
  computes and returns *effective draft flags for that market* in preview-config, so JS
  still does NO scope logic. preview-config computes: for each FeatureKey,
  draftFlags[key] === true — draft flags are absolute overrides for preview, market
  simulation affects only the *live* features' visibility in preview: the server also
  returns `liveEffectiveForMarket: Record<FeatureKey, boolean>` computed via
  isFeatureOnForMarket(settings, key, simulatedMarket) so the preview shows the true
  combined state (live-in-that-market ∪ draft) — exactly what going live would look like.)
- `cellexia-cart.js` / `cellexia-pdp.js`:
  - On init: if `sessionStorage.cx_preview_token` exists AND cfg.preview.armed → fetch
    preview-config (t=token). valid:false → clear sessionStorage, run normal.
    valid → PREVIEW MODE: effective flags per widget := liveEffectiveForMarket[key] OR
    draft flags[key]; render draft templates too; SUPPRESS every beacon (track() and the
    inline session beacon both check the sessionStorage key first — the inline beacon
    check must be inside its try/catch); inject a fixed preview bar (bottom): "Cellexia
    preview — only you can see this · market: X · [Exit preview]" (English hardcoded —
    merchant-facing tool, not buyer copy; inline styles, no locale keys). Exit clears
    sessionStorage + reloads.
  - Preview must not alter live behavior: all preview branches strictly behind the
    sessionStorage+armed+valid triple gate.

### Checkout preview

Extensions (all three): read `preview` from the shop metafield config; read cart
attribute `_cx_preview` via the attributes API. The cart attribute carries the RAW
token; the metafield carries only `tokenHash`. When `preview.armed &&
sha256(attribute) === preview.tokenHash` → use draft semantics: feature treated as enabled when
`draftFlags[key] === true` (in addition to normal live gating), market gating bypassed
ONLY for draft-enabled keys (the preview cart is the merchant's own), protection
defaultOn auto-add DISABLED in preview (never auto-mutate a preview cart), upsell "Add"
still works (real cart — fine). When not in preview: behavior byte-identical to v3.
`webhooks.orders.paid.tsx`: skip OrderStat upsert ONLY when the `_cx_preview` note
attribute exactly equals the CURRENT PreviewState.token (row exists, token non-empty) —
cart attributes are buyer-settable via the public cart API, so any other value (or a
failed lookup) counts the order normally. Preview checkouts never pollute
analytics/experiments; forged attributes never hide real orders.

## B. Setup & Health (new `app/services/health.server.ts` + admin surface)

New scope: `read_themes` (added to toml/.env — DONE in scaffold).

`runHealthChecks(admin, session)` returns ordered checks `{id, label, status:
pass|warn|fail, detail, fixHint, fixUrl?}`:
1. **config-metafields**: read back both metafields, parse, compare `version` and a
   settings fingerprint vs DB → fail = "Re-sync from Settings".
2. **theme-embeds**: published theme (themes(first:10, roles:[MAIN])) → read
   config/settings_data.json asset (OnlineStoreTheme.files or themeFilesBody? use the
   files(filenames:["config/settings_data.json"]) connection, 2025-07) → parse →
   current.blocks entries whose type contains our extension handle
   ("cellexia-booster/blocks/cart-booster" etc.) → each embed: present & !disabled =
   pass; missing/disabled = fail with deep link to theme editor app embeds.
3. **theme-compat**: published theme has sections/mini-cart.liquid containing
   "mini-cart__list" and sections/pdp.liquid containing "pdp__grey" (files query) →
   warn if not found (selectors the widgets target).
4. **webhooks**: webhookSubscriptions(first:20) contains orders/paid + app/uninstalled →
   warn if missing (register on deploy).
5. **protection-product**: reuse ensure-check read-only (exists, ACTIVE, published) —
   only when checkoutProtection.enabled, else "n/a" pass with hint.
6. **metaobject-definitions**: the six types exist (read-only query) → fail with
   "Open Product boosters once to create".
7. **locales**: shopLocales published set vs shipped 17 → warn listing gaps.
8. **orders-data**: OrderStat count>0 or webhook recently fired → info-level warn
   ("analytics will populate after first paid order; production needs Protected
   customer data approval").
9. **preview-hygiene**: PreviewState.armed && armedAt older than 48h → warn "disarm".
10. **app-proxy** (added after a production incident): server-side fetch of
   https://<shop>/apps/cellexia/track — our proxy loader answers
   {"ok":true,"service":"cellexia-booster"}; Shopify 404 = proxy not registered (fail
   with toml/Partner-dashboard fix); non-app response = wrong upstream URL (fail);
   password-page/network issues degrade to warn.
All checks individually try/caught — a check that throws reports fail with the error
message, never breaks the page.

Admin surface: `app.setup.tsx` ("Setup & health"): checklist UI with per-check status,
re-run button, fix links. Dashboard (`app._index`): compact "Setup: N/M passing" Banner
(critical if any fail) linking there, shown until all pass; plus the existing onboarding
banner only when setup passes but nothing is live.

## C. Admin UX overhaul

- **Nav (app.tsx)** consolidated to 8 items: Dashboard, Preview, Features, Product
  boosters, Markets, Experiments, Analytics, Settings.
- **New `app.features._index.tsx` hub**: all 17 features as cards grouped by surface
  (Cart drawer / Product page / Checkout) with status badge, reach chip, preview-armed
  chip, Configure link (existing pages unchanged; survey + localization pages linked
  from the hub and Settings; old direct routes keep working).
- **Preview Center `app.preview.tsx`** — the workflow centerpiece:
  1. Feature picker table (grouped; per-feature READINESS from a shared
     `featureReadiness(settings, extras)` helper in preview.server.ts: e.g.
     checkout_upsell needs variantIds; checkout_protection needs variantId; per-product
     widgets show "N products have content"; not-ready features can still be
     draft-toggled but show a warning).
  2. Context: market Select (simulation), product picker (PDP handle) with sensible
     default (first product with booster content, else first product).
  3. Arm & launch card: Arm/Update preview → shows the three launch buttons (external,
     new tab): Product page, Cart drawer (product page + "add to cart to open the
     drawer" hint), Checkout preview (opens hub which builds the preview cart). Shows
     the shareable entry URL + Rotate link + Disarm. Armed state banner app-wide chip.
  4. **Go live** card: after previewing, pick target market(s) (checkbox list + "all")
     → shows EXACTLY what will change (feature → market diff computed server-side) →
     Apply: for each draft-flagged feature apply applyFlipForMarket(key, market, true)
     (skip ones already live there; refuse markets locked by running experiments with
     the experiment named), save + sync, then optional auto-disarm checkbox (default
     on). Everything through existing settings helpers — no new flag semantics.
- **Consistency pass**: every feature page gets the same header pattern (status badge +
  "Preview this" shortcut linking to Preview Center with the feature pre-selected via
  ?feature= param) — implemented as a small shared component in
  `app/components/` (client-safe directory, NOT app/routes).

## D. Deep-debug wave (after build)

Audit lenses: (1) disarmed-path byte-parity on storefront (diff rendered Liquid branches
+ JS gates); (2) preview security (token handling, no leakage into app-data metafield or
page source, proxy endpoints, checkout attribute); (3) fresh-install lifecycle simulation
against dev.sqlite (install → defaults → arm preview → apply-to-live → experiment guard
interplay: preview apply on an experimenting market must be refused); (4) health checks
GraphQL shapes; (5) full regression: all prior validation suites (flip tests, races,
locales, builds).

## E. Preview coverage invariant (v5.3)

Every feature MUST be previewable through a real surface — a merchant must be
able to see what they are enabling before it goes live, for every current and
FUTURE FeatureKey.

- **Coverage rule**: each key in `FEATURE_KEYS` (settings.server.ts) maps to a
  preview surface: `storefront` (a `data-cx-feature="<key>"` marker or the
  `cx-tpl-*` template the storefront JS clones for that key), `checkout` (the
  `preview.draftFlags.<key> === true` gate in the matching
  `extensions/checkout-*/src/Checkout.tsx`), or `excluded` with a written
  reason (currently only `clinical_results`: a theme-editor app block,
  previewed natively in the Shopify theme editor and excluded from
  `PREVIEWABLE_FEATURE_KEYS` in preview.server.ts).
- **Runtime visibility conditions**: a feature whose live engine can hide the
  widget for non-flag reasons (e.g. the dispatch countdown's credibility
  window) must, inside a VERIFIED preview session, render either the real
  widget (when the live engine shows it) or a clearly LABELED sample
  (`data-cx-sample="1"`) plus a merchant-facing English note naming the real
  reason it is hidden and the real display rule. Invalid config renders a
  diagnostic note instead of the widget. Server-side, `featureReadiness`
  mirrors the same window math so the Preview Center states up front what the
  preview will show right now.
- **Enforcement**: the parity harness's PREVIEW COVERAGE section parses
  `FEATURE_KEYS` live from settings.server.ts source and fails when any key
  lacks a coverage entry, when an entry's evidence pattern no longer matches
  its evidence file, or when an `excluded` entry has no written reason. A new
  FeatureKey cannot ship until the map is extended with VERIFIED evidence for
  it.
- **Real visitors stay byte-identical**: every preview-only branch is gated on
  a verified preview session (storefront `PREVIEW` non-null); the harness's
  section-1 disarmed byte-parity oracles remain the proof and must keep
  passing untouched. Never fabricate urgency for real visitors — samples exist
  only in preview sessions and only with the explanatory note attached.
