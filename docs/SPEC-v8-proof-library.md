# SPEC v8 — Proof library (press · dermatologist endorsements · results gallery · compact modes)

Binding contract for the v8 wave. Read `docs/SPEC.md` and `docs/SPEC-v7-product-proof.md`
first — every v7 invariant (byte budget, ES5, textContent-only, class coverage, prover
allowlist, knownIds, honest fail-closed rendering) carries over. Merchant ask (2026-08-01):
(1) "As seen in the press" — publication logo + large quote, per-product or brand-level,
product pages AND a customisable home-page module; (2) dermatologist endorsement wall built
for DOZENS/HUNDREDS of endorsements (scale must be visible, browsing must be easy, optional
photo per dermatologist), per-product or brand, product pages AND home module; (3) optional
COMPACT MODE for the survey / clinical study / guarantee PDP widgets (drastically less
vertical space, both breakpoints); (4) the before/after widget rebuilt as a browsable,
filterable results gallery for hundreds/thousands of entries (lab data AND customer-
submitted results, rich fields, filters, scale banner, swipeable mobile cards + filter
drawer, desktop grid, admin approve/tag/reorder/feature, product-page prioritisation +
brand home module). Everything trust-first on mobile and desktop.

## 0. Architecture decision — why a database, not metaobjects

Hundreds/thousands of entries cannot ride Liquid JSON islands (byte budget) or metaobject
list references (caps, admin ergonomics). v8 adds a PROOF LIBRARY: three Prisma tables,
one public app-proxy JSON endpoint with filtering/pagination/CDN caching, and storefront
JS that fetches and renders client-side. Fixed UI strings stay in the 18 locale catalogs;
entry content (quotes, testimonials) is merchant/customer text and is NOT machine-translated
(served as entered). Small-N surfaces (press) use the same machinery for one consistent
admin story.

## 1. Data (prisma/schema.prisma + migration)

```prisma
model PressItem {
  id          String   @id @default(cuid())
  shop        String
  status      String   @default("approved") // approved | hidden
  featured    Boolean  @default(false)
  sortWeight  Int      @default(0)
  publication String                        // e.g. "Vogue"
  logoUrl     String?                       // Shopify Files CDN url
  quote       String                        // the large quote
  articleUrl  String?
  productGids String   @default("[]")       // JSON string[]; [] = brand-level
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([shop, status, featured, sortWeight])
}

model DermEndorsement {
  id          String   @id @default(cuid())
  shop        String
  status      String   @default("approved")
  featured    Boolean  @default(false)
  sortWeight  Int      @default(0)
  name        String                        // "Dr. Anna Weiss"
  credentials String?                       // "MD, Board-certified dermatologist"
  country     String?                       // ISO2
  quote       String
  imageUrl    String?                       // optional portrait
  productGids String   @default("[]")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([shop, status, featured, sortWeight])
}

model CustomerResult {
  id            String   @id @default(cuid())
  shop          String
  status        String   @default("pending") // pending | approved | hidden
  featured      Boolean  @default(false)
  sortWeight    Int      @default(0)
  source        String   @default("customer") // lab | customer
  verified      Boolean  @default(false)      // verified purchase
  beforeUrl     String?
  afterUrl      String?
  ageRange      String?  // "18-24" | "25-34" | "35-44" | "45-54" | "55-64" | "65+"
  skinType      String?  // "dry" | "oily" | "combination" | "sensitive" | "normal"
  concern       String?  // free-slug, e.g. "wrinkles", "firmness" (admin tags)
  durationWeeks Int?
  country       String?  // ISO2
  testimonial   String?
  videoUrl      String?
  productGids   String   @default("[]")
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([shop, status, featured, sortWeight])
  @@index([shop, status, concern])
}
```

Migration: new SQLite migration dir (`v8_proof_library`); Postgres deploys use
`prisma db push` per UPDATE.md — note it in the v8 update notes.

## 2. Proxy API (app/routes/proxy.proof.tsx → /apps/cellexia/proof)

GET only, authenticated as an app proxy (same verification as proxy.cart-data). Query:
`type=press|endorsements|results` (required) + common `product` (numeric product id or gid;
optional) + results-only filters `concern`, `age`, `skin`, `duration`
(lt8|8to12|gt12 buckets), `page` (1-based), `per` (max 24). Responses (JSON,
`Cache-Control: public, max-age=60, s-maxage=300`):

- press: `{ total, items: [{id, publication, logoUrl, quote, articleUrl}] }` — approved,
  ordered featured desc, sortWeight asc, createdAt desc. If `product` given: items tagged
  with that product FIRST, then brand-level ([]) items; product-tagged-for-OTHER-products
  excluded.
- endorsements: `{ total, items: [{id, name, credentials, country, quote, imageUrl}] }` —
  same ordering/prioritisation rule; paginated (`per` default 24); `total` = ALL approved
  matching (the scale number).
- results: `{ total, verifiedTotal, items: [...all card fields...], facets: {concerns:
  [{value,count}], ages: [...], skins: [...], durations: [...]} }` — approved only;
  prioritisation: product-tagged first, then brand; featured pinned first within each
  band; facets computed over the UNfiltered approved+product-scoped set so filter counts
  stay stable. `verifiedTotal` = approved AND verified (the honest scale-banner number).

Never expose pending/hidden rows, shop column, or admin fields. All strings served raw —
storefront renders via textContent only.

## 3. Storefront

### 3a. New shared asset: extensions/cellexia-booster/assets/cellexia-proof.js

New ES5 IIFE (same discipline as cellexia-pdp.js: textContent-only, cxEl-style helpers
local to this file, try/catch fail-closed, no innerHTML anywhere — NOT even the icon trick;
use inline SVG via createElementNS). Contains: `proofFetch(type, params)` (routeRoot +
`apps/cellexia/proof`, JSON, 8s timeout, one retry), the three renderers, the filter
drawer/lightbox machinery, and `track()` beacons (feature keys below; suppressed in
preview sessions exactly like cellexia-pdp.js — read the same `cfg.preview` contract from
its own config island; simplest faithful rule: the island carries `"live"` booleans and the
page may carry `#cx-pdp-config` PREVIEW state — when a verified preview is active the pdp
asset sets `window.CellexiaBooster.__preview`; cellexia-proof.js reads that flag and
suppresses beacons, mirroring BEACONS_OFF).

### 3b. Three new app blocks (each ≤1,500 bytes of Liquid, config-emission-only, schema
name ≤25 chars, block usable on ANY template — the same block serves product AND home)

- `blocks/press.liquid` — gate: `cfg.press.enabled` + marketScopes.press + (on product
  pages) `cx_pdp_flags.press != false`. Island `#cx-press-config`:
  `{live, ctx: 'product'|'brand' (request.page_type == 'product' → product + numeric id),
  pid, str:{eyebrow, aria}}`. Renderer: full-bleed quiet band — eyebrow "AS SEEN IN THE
  PRESS", logo row (grayscale logos, opacity .55, hover/full color), ONE large featured
  quote (largest Gobold serif-feel quote + publication name), quotes rotate on logo
  click/tap (no autoplay). Mobile: horizontally scrollable logo strip + the quote below.
- `blocks/derm-endorsements.liquid` — gate: `cfg.dermEndorsements.enabled` +
  marketScopes.derm_endorsements + product-page opt-out flag `derm_endorsements`. Island
  `#cx-endo-config` `{live, ctx, pid, str:{...}}`. Renderer: THE WALL — headline
  "Endorsed by {{ n }} dermatologists" (n = total from API, count-up NOT animated —
  static, credible), then a dense browsable wall: compact cards (portrait 44px circle
  when present else initials monogram, name, credentials line, one-line quote clamped,
  tap to expand full quote in place). Mobile: 1-col virtual list w/ "Show more" pagination
  (24/pageload); desktop: 3-4 col masonry-ish grid (CSS columns), "Show more" appends.
  The POINT is visible scale + easy browsing: the count headline + a subtle
  "{{ shown }} of {{ n }}" progress line.
- `blocks/results-gallery.liquid` — REPLACES the old PDP before/after widget. Gate:
  `cfg.beforeAfter.enabled` + marketScopes.verified_before_after + product opt-out flag
  `verified_before_after` (all UNCHANGED keys). Island `#cx-results-config`
  `{live, ctx, pid, str:{~20 keys: scale banners, filter labels, facet labels, verified
  badge, lab badge, video, weeks label w/ @@N@@, empty-state, show_more, close}}`.
  Renderer: scale banner first ("See results from {{ count }} verified Cellexia
  customers." — verifiedTotal; when verifiedTotal is 0 fall back to the non-verified
  wording with total; 0 total → whole module renders nothing, fail closed). COMPACT
  DISCIPLINE: the module is a fixed-height band, never a tall stack — mobile: filter
  chips row (opens a bottom-sheet drawer with the 4 facet groups) + horizontally
  swipeable cards (scroll-snap), card = stacked before/after thumbs (aspect 1:1, tap →
  lightbox), age/concern/duration/country microline, verified/lab badge, testimonial
  clamped to 2 lines (expand in lightbox), play badge when videoUrl. Desktop: same
  filter row inline + a 4-col grid, "Show more" appends pages. Lightbox: side-by-side
  before/after, full testimonial, all metadata, <video controls> when videoUrl is a
  direct media file else a plain link-out. PDP shows product-prioritised results
  automatically (pid passed); home/brand context shows everything.
- The OLD BA machinery retires from the PDP: remove `#cx-ba-config` island emission from
  pdp-booster.liquid + the ba* builders from cellexia-pdp.js + `cx-tpl-pdp-ba` slot in
  PROOF_ORDER dispatch (keep the featureKey slot pointing at nothing — results-gallery is
  a standalone block the merchant places; simplest: PROOF_ORDER drops the ba row, EVIDENCE
  marker moves to cellexia-proof.js `['data-cx-feature', 'verified_before_after']`).
  Old cx-ba CSS rules deleted; INHERIT rows for cx-ba pruned.

### 3c. Compact modes (item 3 — settings-driven, LIVE settings, no draft plumbing;
v6.5 placement precedent)

Settings: `dermSurvey.compact`, `clinicalStudy.compact`, `emptyBottleGuarantee.compact`
(boolean, default false, sanitize typeof-boolean). Liquid: islands carry lean `"cm": 1`
members when on (survey member + study island + bottle island). JS builders branch:
- Survey compact: ONE row — big pct + rec_line on a single line (wraps on mobile), then
  the TOP outcome only as an inline "91% — Skin looked visibly firmer" line, a
  "+ {{ n }} more outcomes" disclosure button expanding the full outcome list in place,
  disclosure/verified chip unchanged. Vertical target ≤ 40% of full mode.
- Study compact: subject + heading on one block, hero value INLINE with its label
  (baseline row), stat grid → single wrapping row of "37% wrinkle depth"-style mini
  stats, chips inline in the same row flow, footnote kept. No hero 68px numeral —
  32px.
- Guarantee compact: single slim band (not the big ink panel): check icon + title +
  "Guarantee check" link on one row, ink background, points hidden (they live in the
  modal, which is unchanged). Height ≈ 64px.
CSS for all compact variants both breakpoints; `--compact` BEM modifiers on the roots.
Admin: a "Compact mode" checkbox on each of the three feature cards/pages (survey
defaults page, products-page guarantee editor, features hub clinical row → a small
clinical settings location: put all three toggles on ONE new "Display density" card on
the Features hub page — simplest single home; buildPatch per section).

## 4. Settings + feature keys

- NEW FeatureKeys (+2 → 33): `press`, `derm_endorsements`. Full 33-key surgery:
  FEATURE_KEYS, FeatureKey union, FEATURE_DEFS (labels "As seen in the press",
  "Dermatologist endorsements"), FEATURE_RAW_FIELD, STANDALONE_SECTION_FIELDS
  (sections `press{enabled:false}`, `dermEndorsements{enabled:false}`), marketScopes
  auto, PDP_FLAG_KEYS += press, derm_endorsements (opt-out per product, existing
  polarity), analytics ALLOWED_FEATURES += both, FEATURE_GROUPS (app.preview.tsx) +
  GROUPS + CONFIGURE_URL (both → /app/proof), EVIDENCE rows (markers live in
  cellexia-proof.js), count pins 31→33 in harness.mjs:84 + settings-derivation.ts:58/64
  + flip-test.ts:48, PREVIEWABLE: both keys previewable via draft flags (blocks read
  live/draft exactly like other features: draft gate additive OR cfg enabled —
  blocks placed in theme + armed preview flags show them), featureReadiness:
  contentReadiness-style cases fed by proof-library counts (extras gains
  `proofCounts {press, endorsements, results}`).
- `beforeAfter` section unchanged (enabled flag reused by the gallery).

## 5. Admin

- Nav (app/routes/app.tsx): + `<Link to="/app/proof">Proof library</Link>` after
  Product boosters.
- `app.proof.tsx` — hub with three tabs (Press / Endorsements / Results) via nested
  routes `app.proof._index.tsx` (redirect to results), `app.proof.press.tsx`,
  `app.proof.endorsements.tsx`, `app.proof.results.tsx`. Shared service
  `app/services/proof.server.ts`: typed CRUD + list w/ filters + counts + reorder
  (swap sortWeight) + bulk approve + `importLegacyBeforeAfters(admin, shop)` (reads
  every product's BA metaobjects via existing pdp-content machinery → CustomerResult
  rows source=lab, verified=true, productGids=[product], beforeUrl/afterUrl from the
  metaobject images, testimonial=statement, durationWeeks=weeks; idempotent via a
  legacyKey column? — add `legacyGid String? @unique` to CustomerResult for exactly-once
  import).
- Each tab: table (status badge, featured star toggle, product tags, up/down reorder,
  edit inline panel or subpage form, delete w/ 2-click), "Add" form with
  stagedImageUpload image fields (reuse the upload intent pattern from
  app.products.$id.tssx), product tagging via a product search picker (reuse the
  /app/api/variants-style search or listProductsWithBoosterStatus), results tab extra:
  approve/pending filter chips, facet fields as Selects (age/skin/duration/country),
  source lab|customer, verified checkbox, video URL (https-validated), Import button
  for legacy BAs.
- Feature pages: press + derm_endorsements rows on the Features hub gate on/off +
  market scopes (MarketScopeCard on the proof tabs themselves — one scope card per
  tab page, patching marketScopes.press / .derm_endorsements). "Display density"
  card on the features hub carries the three compact toggles (spec 3c).
- Products editor: two new per-product opt-out Checkboxes (press, derm_endorsements)
  in a light "Brand proof on this product" card linking to /app/proof.

## 6. i18n (en.default.json + 17 translations)

New groups: `press.eyebrow` ("As seen in the press"), `press.read_article`
("Read the article"); `endo.*` (eyebrow "DERMATOLOGIST ENDORSEMENTS", count_headline
"Endorsed by {{ n }} dermatologists" (+ CLDR one), shown_of ("Showing @@SHOWN@@ of
@@TOTAL@@"), show_more ("Show more"), read_full ("Read full endorsement"));
`results.*` (~18 keys: banner_verified ("See results from {{ count }} verified Cellexia
customers."), banner_all ("See results from {{ count }} Cellexia customers."), filters
(filter_concern/age/skin/duration + facet value labels for skin types + duration buckets
+ age ranges use raw "25-34" strings composed w/ years label), verified_badge
("Verified purchase"), lab_badge ("Clinical study result"), video_badge ("Video"),
weeks_of_use ("@@N@@ weeks of use"), before/after labels, show_more, empty ("No results
match these filters yet."), close, clear_filters). Sentinel convention for
number-in-string; CLDR plural only for endo.count_headline. Age ranges/countries render
as data (country via Intl.DisplayNames like az ships-from).
Compact additions: `survey.more_outcomes` ("+ @@N@@ more outcomes").

## 7. Validation

- New sims: `proof-gallery.cjs` (vm-extract cellexia-proof.js renderers: press rotate,
  endorsement wall pagination + monogram fallback, results card build + filter state →
  query params + facet chips + fail-closed empties + scale-banner fallback logic +
  XSS textContent discipline; mutants ≥5) and compact cases appended to
  survey-methodology.cjs (survey/study compact variants) — bottle compact pinned in the
  new sim or harness. Register in run-all + manifest.
- harness: 31→33 count, EVIDENCE rows for the 2 new keys + the moved
  verified_before_after marker, CLASS-COVERAGE picks up cellexia-proof.js
  automatically? NO — harness scans CART_JS + PDP_JS only: EXTEND the scan list to
  include cellexia-proof.js (new constant PROOF_JS) for class coverage, escape
  discipline (innerHTML count 0 for the new file), and the JS-direction config checks
  where applicable. v8 pin block: proxy route exists + Cache-Control pin + prisma
  models present + compact settings sanitize + block byte sizes ≥500.
- prover: allowlist entries for pdp-booster.liquid + cellexia-pdp.js edits + NEW files
  (blocks/press.liquid, blocks/derm-endorsements.liquid, blocks/results-gallery.liquid,
  assets/cellexia-proof.js) + DELETED emission (ba island) — new/changed files each
  need entries.
- Byte budget: three new blocks ≤4.5KB total; ba island removal recovers ~1.4KB;
  target total ≤ 93,500 (hard stop 95,000).
- settings-derivation/flip-test: 33 repins.

## 8. Ship checklist

validate green · tsc · build · migration applies on fresh SQLite (npm run setup path)
· fixture verification: press band, endorsement wall (seeded 60 entries), results
gallery (seeded 40 cards, filters live against a stub server), compact modes ×3,
mobile+desktop · adversarial review wave · UPDATE.md v8 notes (new nav page, blocks
must be PLACED in the theme editor on product template + home; migration note:
Postgres `prisma db push`; legacy BA import button; compact toggles) · memory · ZIP.
