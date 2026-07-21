# SPEC v3 — PDP Trust Boosters + Per-Market Concurrent Experiments

Extends SPEC.md + SPEC-v2. Two pillars: (A) five per-product PDP conversion boosters,
(B) experiments become one-per-market concurrent.

## A. The five boosters — CRO intent

All five are precision-trust widgets: specificity (exact n, instruments, license numbers,
batch numbers, dates) + verifiability (named third parties, links, downloadable documents)
+ restrained design (small print INCREASES credibility — never shouty). Brand-native:
Gobold numbers/headlines, argumentum body, ink #1d1d1b, accent #b1cded, panels #f4f4f4,
`.eyebrow` labels. RTL-safe. No fake elements ever (no stock faces, no invented seals —
the verification badge names the real verifier from settings).

1. **Clinical study** (`clinical_study`): eyebrow "Independent clinical study" → headline
   result rendered huge (Gobold), grid of additional numbered results (value+suffix big,
   label small), methodology small-print line: "n = 112 participants · 8-week study ·
   [lab name]" + "Instrument-measured: corneometer, VISIA", optional "View study summary"
   link, footnote. Left accent border #b1cded.
2. **Verified before/after** (`verified_before_after`): side-by-side unretouched images
   with BEFORE/AFTER tags + real dates + "Week 0 / Week N" chips; caption "Unretouched
   VISIA images captured at [clinic]"; verification bar: shield icon + "Verified by
   [Dr name] — License [#]" + quoted statement + "View verification" link. Multiple
   entries = horizontal scroll-snap row. One verified B/A beats twenty unverified.
3. **Batch transparency** (`batch_transparency`): eyebrow "Full transparency"; ingredient
   table: Ingredient | Actual concentration (bold, e.g. "2 %") | Form ("encapsulated" —
   not a "blend"); certificates of analysis list: Batch # · date · lab · download link
   (PDF); honesty line: "Every batch is independently tested and published. Judge for
   yourself." Repositions Cellexia as the honest player.
4. **Empty bottle guarantee** (`empty_bottle_guarantee`): high-contrast panel, Gobold
   headline "Use every last drop", body "Take {{ days }} days. If you don't love your
   results, return the empty bottle for a full refund." + three risk-reversal points +
   terms link. Days from settings (default 60).
5. **Dermatologist survey** (`derm_survey`, EVERY product page): giant Gobold "9/10" +
   "dermatologists surveyed would recommend Cellexia" + "Independent survey of 270
   board-certified dermatologists" + third-party verification seal (inline SVG laurel +
   check, `cx-icons` icon `seal-check`) + "Survey verified by [name]" + methodology link.

## Content model (metaobjects — Translate & Adapt native)

Created idempotently by `ensurePdpDefinitions(admin)` in
`app/services/metaobjects.server.ts` (metaobjectDefinitionCreate; type names below;
`access.storefront: PUBLIC_READ`; `capabilities.translatable.enabled: true` so every
text field is translatable in Translate & Adapt under Content → Metaobjects; also
`capabilities.publishable.enabled: true` with status ACTIVE on create). Field keys are
FROZEN — Liquid reads them literally.

- `cellexia_study_result`: value (number_decimal), suffix (single_line_text_field),
  label (single_line_text_field)
- `cellexia_clinical_study`: title (single_line_text_field), concern
  (single_line_text_field), duration_weeks (number_integer), sample_size
  (number_integer), lab_name (single_line_text_field), instruments
  (single_line_text_field), study_url (url), results
  (list.metaobject_reference → cellexia_study_result), footnote (multi_line_text_field)
- `cellexia_before_after`: before_image (file_reference), after_image (file_reference),
  before_date (date), after_date (date), weeks (number_integer), clinic
  (single_line_text_field), imaging (single_line_text_field), verifier_name
  (single_line_text_field), verifier_license (single_line_text_field), statement
  (multi_line_text_field), verification_url (url)
- `cellexia_ingredient`: name (single_line_text_field), concentration (number_decimal),
  form (single_line_text_field), note (single_line_text_field)
- `cellexia_coa`: batch (single_line_text_field), issued (date), lab
  (single_line_text_field), document_url (url), document (file_reference)
- `cellexia_batch_transparency`: intro (multi_line_text_field), ingredients
  (list.metaobject_reference → cellexia_ingredient), certificates
  (list.metaobject_reference → cellexia_coa)

Product metafields (namespace `cellexia`, set via metafieldsSet, definitions created by
`ensurePdpDefinitions` too so they render nicely in admin):
- `clinical_study`: metaobject_reference
- `before_afters`: list.metaobject_reference
- `batch_transparency`: metaobject_reference
- `pdp_flags`: json — per-product opt-in/out:
  `{ "clinical_study": bool, "verified_before_after": bool, "batch_transparency": bool,
     "empty_bottle_guarantee": bool, "derm_survey": bool }` (missing key = true).

**Widget visibility rule** (Liquid): global feature flag on AND market scope matches AND
per-product flag not false AND (for content widgets) content exists. Derm survey needs no
per-product content (global settings) but respects the per-product opt-out.

New scopes (toml + .env.example — DONE in scaffold): `read_metaobject_definitions,
write_metaobject_definitions, read_metaobjects, write_metaobjects, read_files, write_files`.

## Settings additions (settings.server.ts — DONE, read it)

New FeatureKeys: `clinical_study, verified_before_after, batch_transparency,
empty_bottle_guarantee, derm_survey` (17 total). New sections (all enabled:false —
safe default): `clinicalStudy{enabled}`, `beforeAfter{enabled}`,
`batchTransparency{enabled}`, `emptyBottleGuarantee{enabled, days:60}`,
`dermSurvey{enabled, recommend:9, outOf:10, sampleSize:270, verifierName:"",
verificationUrl:""}`. marketScopes gains the five keys automatically.

## services (app/services/)

`metaobjects.server.ts`: ensurePdpDefinitions(admin) (idempotent — query definitions by
type first); generic metaobject CRUD: createMetaobject(admin, type, fields),
updateMetaobject(admin, id, fields), deleteMetaobject(admin, id) (metaobjectCreate /
metaobjectUpdate / metaobjectDelete; fields as [{key, value}] with value strings — JSON
for references/lists); stagedImageUpload(admin, {filename, mimeType, buffer}) →
stagedUploadsCreate → POST to target → fileCreate → poll fileStatus READY → returns
{fileGid, url}. All returning {ok, errors, ...}.

`pdp-content.server.ts`: getProductBoosters(admin, productId) → hydrated view of the
four metafields incl. referenced metaobjects (single GraphQL query using product +
metafields + references); saveClinicalStudy(admin, productId, data) (create-or-update
metaobject + nested results — diff existing result metaobjects, create/update/delete,
then metafieldsSet reference); saveBeforeAfters(admin, productId, entries[]) (same
pattern, ordered list); saveBatchTransparency(admin, productId, data) (nested
ingredients + certificates); savePdpFlags(admin, productId, flags); plus
listProductsWithBoosterStatus(admin, search) for the picker (products query incl. the
cellexia metafields, mapped to per-booster configured/enabled booleans).

## Storefront (theme extension)

Extend `blocks/pdp-booster.liquid` + `assets/cellexia-pdp.js` + `assets/cellexia-booster.css`
+ `snippets/cx-icons.liquid` (add `seal-check`, `bottle`, `download`, `calendar` icons).

- New Liquid `<template>` fragments (server-rendered, fully translated, product-aware via
  the global `product` object — available in app embeds on product templates) for the five
  widgets, each gated: explicit `== true` master flag AND market scope (existing pattern,
  new keys) AND `product.metafields.cellexia.pdp_flags.value[key] != false` AND content
  present (`product.metafields.cellexia.clinical_study.value` etc.). Metaobject field
  access: `mo.field_key.value`; file_reference → `| image_url: width: 800`; list refs →
  `.value` iterates metaobjects. All merchant metaobject text renders TRANSLATED
  automatically per storefront language (T&A handles it).
- cellexia-pdp.js: new injection routine — build container `.cx-proof-stack` and insert
  BEFORE `document.querySelector('.pdp__tabs')` (fallback: after `section.pdp` /
  `.pdp`; final fallback no-op). Clone templates in CRO order: derm_survey,
  clinical_study, verified_before_after, batch_transparency, empty_bottle_guarantee.
  Impression beacons per widget (feature keys above, market attached — reuse track()).
  B/A row: scroll-snap CSS only, no JS carousel. Keep everything null-guarded.
- Embed block settings: placement select (above_tabs default / below_tabs), per-widget
  hide checkboxes (site-wide layout control; per-product control lives in pdp_flags).
- CSS: `.cx-proof-stack` sections max-width matching `.container--md`, generous
  whitespace, Gobold display numbers (values clamp responsive), B/A grid
  (2-col, stack on mobile), ingredient table (bordered 2px #f4f4f4, bold concentration
  column), guarantee panel (ink #1d1d1b inverse with white text + accent border),
  survey stat huge (~72px desktop). ≤ +12KB total.

### Locale catalog additions (theme ext en.default.json — EXACT keys; translators mirror)

```json
"study": {
  "eyebrow": "Independent clinical study",
  "methodology": "n = {{ n }} participants · {{ weeks }}-week study · {{ lab }}",
  "instruments": "Instrument-measured: {{ methods }}",
  "view_study": "View study summary",
  "footnote_default": "Measured under dermatological control. Individual results may vary."
},
"ba": {
  "eyebrow": "Verified results",
  "title": "Real results, independently verified",
  "before": "Before",
  "after": "After",
  "week_0": "Week 0",
  "week_n": "Week {{ weeks }}",
  "captured": "Unretouched {{ imaging }} images captured at {{ clinic }}",
  "verified_by": "Verified by {{ name }} — License {{ license }}",
  "view_verification": "View verification"
},
"batch": {
  "eyebrow": "Full transparency",
  "title": "What's inside — exactly",
  "col_ingredient": "Ingredient",
  "col_concentration": "Actual concentration",
  "col_form": "Form",
  "coa_title": "Certificates of analysis",
  "batch_no": "Batch {{ batch }}",
  "tested_by": "Tested by {{ lab }}",
  "download": "Download certificate",
  "honesty": "Every batch is independently tested and published. Judge for yourself."
},
"bottle": {
  "title": "Use every last drop",
  "body": "Take {{ days }} days. If you don't love your results, return the empty bottle for a full refund.",
  "point_1": "Works or it's free — even with an empty bottle",
  "point_2": "No questions asked",
  "point_3": "Full refund to your original payment method",
  "terms": "See guarantee terms"
},
"survey": {
  "stat": "{{ recommend }} out of {{ outof }}",
  "title": "dermatologists surveyed would recommend Cellexia",
  "sample": "Independent survey of {{ n }} board-certified dermatologists",
  "verified_badge": "Third-party verified",
  "verified_by": "Survey verified by {{ name }}",
  "methodology": "See survey methodology"
}
```
Translator rules identical to v1 (placeholders byte-exact, "Trustpilot"-style brand
handling n/a here, register per language as before).

## Admin UI

- `app.products.tsx` (nav "Product boosters"): global card row first — the five features'
  master toggles + market-reach captions (matrix handles scopes; link there) — then a
  searchable product table (thumbnail, title, five status dots configured/on/off,
  Configure button). Products from listProductsWithBoosterStatus.
- `app.products.$id.tsx`: per-product editor. Cards per booster with per-product enable
  Checkbox (pdp_flags) + editors: clinical study form incl. results repeater; B/A entries
  repeater with image DropZone upload (stagedImageUpload) OR image URL paste, dates,
  auto-computed weeks, verifier fields; batch: intro, ingredients repeater, certificates
  repeater with PDF upload/URL; guarantee + survey cards = toggle + link to their global
  settings. Save per card (separate intents). Deep link per metaobject: "Edit in Shopify
  admin (raw)" → https://admin.shopify.com/store/{prefix}/content/entries/... (link to
  Content → Metaobjects list is sufficient). A prominent "Translate this content" hint
  linking to Translate & Adapt.
- `app.features.survey.tsx` (nav under existing Badges? new page): dermSurvey global
  settings (numbers, verifier name, verification URL) + MarketScopeCard (derm_survey) +
  live preview mimicking the widget.
- `app._index.tsx`: five new feature cards (statusFlagKey pattern), grouped "Product
  page — trust boosters".
- First-run: any of these pages' loaders call ensurePdpDefinitions once (cache a
  module-level per-shop flag) and surface definition-creation errors in a Banner.

## B. Experiments: one concurrent experiment PER MARKET

Reverses the v2 one-per-shop rule, correctly this time:

- **Guards** (startExperiment): (1) no running experiment in the SAME market; market
  "all" conflicts with any running experiment and vice versa. (2) NO FLIP-KEY OVERLAP:
  a key flipped by any running experiment cannot be flipped by a new one (any market) —
  and any cart_* key counts as overlapping with any other cart_* key (shared master).
  Wizard: markets with running experiments disabled in the Select (named); locked
  features shown disabled in the flip table with "In use by experiment X".
- **Rollback = selective restore**: new `restoreFlagsSelective(settings, snapshot,
  keys)` in settings.server.ts (DONE — read it): restores ONLY the flipped keys' raw
  flags + their scopes; if any key is cart_*, restores cartMaster + all four cart
  sub-flags (safe: the overlap guard means no other running experiment touches cart).
  concludeExperiment uses it with the experiment's own flip keys. Whole-shop
  restoreFlags stays for backward compat but experiments no longer use it.
- **Drift detection per experiment**: hash only the experiment's flipped keys' raw
  flags + scopes (another market's experiment must NOT trigger drift warnings).
- **UI**: app.experiments.tsx redesigned for multiple running experiments — one card per
  running experiment (market Badge, day X of N ProgressBar, quick numbers: orders and
  conversion/AOV deltas vs baseline so far, warning chip) + completed/stopped table
  below. Dashboard banner already handles multiple critical warnings. The
  Google-ads/sequential explainer stays: within ANY market there is only ever ONE live
  configuration; concurrency is across markets only.
- periodMetrics is already market-filtered, so concurrent experiments have independent
  data. Report caveat line gains: "Other markets may be running their own experiments;
  metrics here are for this market only."
- analytics.server.ts ALLOWED_FEATURES += the five new keys (impression beacons).
