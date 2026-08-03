# SPEC v7 — Per-product proof widgets (clinical study · dermatologist survey · risk-free guarantee)

Binding contract for the v7 wave. Read `docs/SPEC.md` first (architecture, i18n doctrine,
metafield mirroring). Merchant ask (2026-08-01): (1) the clinical study must read as a study
conducted on THIS product and be deeply customisable; (2) the dermatologist survey becomes
PER-PRODUCT — unique outcome statements per product, off by default until content is added,
one outcomes-forward format replacing the five v5.8 formats; (3) the empty-bottle guarantee
headline becomes "Try it for 60 days, completely risk-free" with deeper copy customisation.
All three: designed for the SKEPTICAL visitor — specificity, verifiability, restraint —
perfect on mobile and desktop.

Non-negotiable invariants (from the v7 recon, validation/):

- FeatureKey names DO NOT change: `derm_survey`, `clinical_study`, `empty_bottle_guarantee`
  (31-key pins in harness:84, settings-derivation, flip-test; marketScopes persistence;
  analytics ALLOWED_FEATURES). All admin-visible renames are label/copy only.
- Total theme-extension Liquid < 95,000 bytes (currently 84,806; per-file ceiling 30,000 —
  pdp-booster.liquid is at 23,953). JSON-island short-key convention; JS-built markup.
- ES5 only in theme JS; textContent-only sinks (innerHTML counts are harness-pinned:
  pdp 4 sites exactly); decoded strings never reach attributes; raw strings (cxRawStr)
  for URLs. New cx-* classes need CSS rules or harness INHERIT rows.
- Prover: every touched file in blocks//snippets//assets/*.js needs a v7 allowlist entry.
- pdp.js sim-extracted helper names/indent must not change (cxEl, cxSp, decodeEntities,
  track, insertAfter, azCompact twin…).

## 1. Data model

### 1a. New metaobject types (ensurePdpDefinitions; leaf before parent; both
translatable+publishable, PUBLIC_READ; type names FROZEN once shipped)

`cellexia_survey_outcome` (displayNameKey "statement"):
- `statement` single_line_text_field — the outcome statement dermatologists rated
  (e.g. "Visibly firmer skin after 8 weeks of use"). TRANSLATABLE (field name already
  in TRANSLATABLE_FIELD_KEYS).
- `yes_count` number_integer — how many of the surveyed dermatologists agreed.

`cellexia_product_survey` (displayNameKey "title"):
- `title` single_line — optional headline override (translatable, existing key).
- `sample_size` number_integer — dermatologists surveyed for THIS product (required for render).
- `recommend_yes` number_integer — optional; enables the "NN% would recommend" headline.
- `question` single_line — optional; the exact question asked (translatable; ADD "question"
  to TRANSLATABLE_FIELD_KEYS — no other type uses that field name).
- `intro` single_line — optional override of the built-in outcomes intro (translatable,
  existing key "intro").
- `methodology` multi_line — optional PER-PRODUCT disclosure override (translatable; ADD
  "methodology" to TRANSLATABLE_FIELD_KEYS). Wins over the shop-global custom text.
- `verifier_name` single_line — optional per-product verifier (NOT translatable — proper noun).
- `verification_url` url — optional.
- `outcomes` list.metaobject_reference → cellexia_survey_outcome.

Product metafield: `cellexia.product_survey`, metaobject_reference, pinned, PUBLIC_READ
(add to PDP_METAFIELD_KEYS + definition-create array + lookup query; stays under the
`metafieldDefinitions(first: 20)` window — 6 keys after this wave).

### 1b. Clinical study definition gains one field (MIGRATION REQUIRED)

`cellexia_clinical_study` + `subject` single_line — optional "conducted on this product"
line override (translatable; ADD "subject" to TRANSLATABLE_FIELD_KEYS).

ensurePdpDefinitions today creates but never migrates. Add `ensureDefinitionFields`:
for an EXISTING definition, query its fieldDefinitions, and `metaobjectDefinitionUpdate`
with `fieldDefinitions: [{create: {...}}]` operations for missing keys only. Idempotent,
create-race tolerant (TAKEN ⇒ success), called from ensurePdpDefinitions for
cellexia_clinical_study/`subject`. New shops get `subject` in the create branch too.

### 1c. Per-product gating (survey OFF by default per product)

Content presence = the per-product switch, exactly like clinical study: no
`cellexia.product_survey` metafield ⇒ hidden everywhere, regardless of the master flag.
The existing `pdp_flags.derm_survey` opt-OUT stays as an additional kill switch (missing
key = true, unchanged polarity — it only matters once content exists). Master
`dermSurvey.enabled` + marketScopes + theme-block `show_derm_survey` unchanged.

### 1d. Settings model (app/models/settings.server.ts)

- `dermSurvey.sampleSize`, `yesCount`, `format` + `DERM_SURVEY_FORMATS` become LEGACY
  (kept in shape/defaults/sanitize for stored-JSON back-compat; UI + storefront no longer
  read them; JSDoc marks them v7-legacy like recommend/outOf).
- `dermSurvey.methodology`, `verifierName`, `verificationUrl` become the SHOP-GLOBAL
  DEFAULTS the per-product metaobject can override per field.
- `emptyBottleGuarantee` shape unchanged. FEATURE_DEFS label →
  `"Risk-free trial guarantee"`. No new settings fields anywhere (per-product data lives
  in metaobjects; bottle copy overrides live in theme-block settings — doctrine).

### 1e. Preview plumbing retirement

`draftConfig.dermSurveyFormat` is REMOVED at all 7 live sites: preview.server.ts (type
member + sanitizeDraftConfig block), metafields.server.ts (loadPreviewPayload block),
app.preview.tsx (SURVEY_FORMAT_OPTIONS, liveSurveyFormat, surveyFormat state, submitArm
member, the Survey-format Select block), pdp-booster.liquid preview member (`"surveyFormat"`),
cellexia-pdp.js (`cfg.preview.surveyFormat` read + surveyBuildFormat + SURVEY_FORMATS).
deliveryFormat/shipsFromFormat plumbing is untouched. Preview of the survey = the standard
draft-flag mechanism (content is live metafields, so an armed draft flag previews the real
per-product widget).

Preview readiness: `FeatureReadinessExtras.productsWithContent` gains `survey: number`;
`featureReadiness` gains `readiness.derm_survey = contentReadiness(counts?.survey,
"dermatologist survey")`; app.preview.tsx extras filter + `hasContent` OR-term +
`NOT_READY_FIX_LINKS.derm_survey = {url:"/app/products", label:"Add content under Product
boosters"}`. Features hub `CONFIGURE_URL.derm_survey` → `"/app/products"`; the
"Dermatologist survey settings" related-settings button stays (global defaults page).

## 2. Storefront

### 2a. Survey widget — ONE outcomes-forward format (replaces seal/report/question/tally/strip)

Liquid (pdp-booster.liquid): per-product read `assign cx_svy =
product.metafields.cellexia.product_survey.value` inside the live gate (and lazily in the
draft gate — the `unless` double-read convention). `survey_ok` recomputed per product:
`sample_size > 0` AND (at least one outcome with `0 < yes_count <= sample_size` OR a valid
`recommend_yes`). Emission (inside #cx-pdp-config, keeps the top-level `"survey"` /
`"surveyStrings"` cfg keys for harness S5):

```
"survey": {"live": bool, "total": N, "rec": N|absent, "t": title|absent, "q": question|absent,
  "intro": intro|absent, "o": [{"s": statement, "y": yes}...],
  "method": product methodology || cfg.dermSurvey.methodology,
  "verifier": product verifier_name || cfg.dermSurvey.verifierName,
  "url": product verification_url || cfg.dermSurvey.verificationUrl}
"surveyStrings": {eyebrow, how, verified_badge, verified_by (t: name: effective verifier),
  p1..p5 (t-params from PER-PRODUCT numbers: total = sample_size, yes = recommend_yes or
  summed best outcome — see 2a-iv), rec_line (t: total, product: product.title),
  outcomes_intro (t: product: product.title), outcome_agree (RAW with @@YES@@/@@TOTAL@@
  sentinels — JS substitutes per row)}
```

JS (cellexia-pdp.js) — rewritten survey block, same function names where the sim extracts
them (`surveyData`, `surveyStr`, `surveyAllowed`, `surveyBuildPanel`, `surveyBuildHow`,
`surveyEyebrow`, `surveyBuildSection`, `surveyTplNode`; `surveyBuildFormat`,
`buildSurveyDots` DELETED; `bindSurveyDisclosure` kept):

i. Root `section.cx-proof.cx-survey` (no format modifier), marker
   `['data-cx-feature', 'derm_survey']` (harness EVIDENCE).
ii. Eyebrow (existing class). Headline block when `rec` valid:
    `div.cx-survey__headnum` > `span.cx-survey__rec-pct` (Gobold, round(rec/total*100)+"%")
    + `h2.cx-survey__headline` (title override || rec_line). When no `rec`: title override
    rendered alone if present, else no headline (outcomes carry the section).
iii. Optional `blockquote.cx-survey__quote` (existing class/CSS) for `q`.
iv. `p.cx-survey__intro` = per-product intro || outcomes_intro.
v. `ul.cx-survey__outcomes list-reset` — per valid outcome row (`0 < y <= total`; invalid
   rows DROPPED; zero valid rows AND no valid rec ⇒ builder returns null — fail closed):
   `li.cx-survey__outcome` > `div.cx-survey__outcome-row` (`span.cx-survey__outcome-statement`
   + `span.cx-survey__outcome-pct` pct+"%") + `div.cx-survey__bar` >
   `div.cx-survey__bar-fill` (style.width = pct+"%" — numeric only, computed
   Math.round(y/total*100)) + `span.cx-survey__outcome-n` (outcome_agree with
   @@YES@@/@@TOTAL@@ → String numbers, textContent).
vi. Disclosure: surveyBuildHow/surveyBuildPanel UNCHANGED in behavior (methodology
    precedence per-product > global custom > built-in p1..p5; v6.11 token substitution
    `{{ total }}/{{ yes }}/{{ percent }}` intact — numbers now per-product: total =
    sample_size, yes = rec (or 0), percent = round(rec/total*100) or 0). Verifier chip +
    verified_by link unchanged.
vii. PROOF_ORDER, idempotence, track('derm_survey') beacons unchanged.
     bindSurveyDisclosure call in buildProofStack stays; the buildSurveyDots call is removed.

### 2b. Study widget — product binding + protocol facts

Island additions/changes (#cx-study-config): NEW `"sub"` (per-product subject when set),
NEW `"pn"` (sample_size), `"pw"` (precomposed weeks_count label), `"pl"` (lab_name) as
separate lean members replacing the composed `"m1"` (retired); `"m2"` (instruments,
pre-interpolated) retired in favor of raw `"pi"` (instruments string). `"str"` gains
`"sub"` (t 'study.subject' with product: product.title) and `"fn"` (t 'study.fact_participants'
@@N@@ sentinel or t-param n — pick t-param, Liquid-composed, lean).

JS (studyBuildSection):
- After eyebrow: `p.cx-study__subject` = data.sub (override) || str.sub (default composed
  with the localized product title). Always rendered (the product-binding line is the point).
- After concern/hero/grid: `ul.cx-study__facts list-reset` of `li.cx-study__fact` chips,
  built only from present members: participants (str.fn pre-composed "34 participants"),
  weeks (pw), lab (pl, raw text), instruments (pi prefixed by existing 'study.instruments'
  composition — emit `"m2"`-style pre-interpolated string as `"pi"`). 0 facts ⇒ no list.
- m1/m2 paragraph rendering removed; footnote/link/hero/grid unchanged.

### 2c. Bottle guarantee

- EN `bottle.title` → `"Try it for {{ days }}, completely risk-free"` — NOTE the title now
  carries the `{{ days }}` param (precomposed pluralized days label, same as body). Liquid
  title assign: `block.settings.bottle_title_override | default: 'bottle.title' | t: days:
  cx_days_label` (override wins verbatim, as today).
- Theme-block schema gains: `bottle_body_override`, `bottle_point_1_override`,
  `bottle_point_2_override`, `bottle_point_3_override` (text settings, blank ⇒ translated
  default; same info line as the existing title override). Liquid island members use
  override-or-t for body/p1/p2/p3. Theme-editor settings are Translate & Adapt-translatable
  (doctrine).
- Admin copy updates: app.products.tsx PDP_FEATURES title → "Risk-free trial guarantee",
  desc mentions the new headline; FEATURE_DEFS label likewise; features-hub/product-editor
  strings that quote "Use every last drop" updated.
- CSS: mobile keeps the stacked column; desktop panel constrained to the SAME 680px centered
  measure as survey/study (measure coupling rule) — `@media (min-width: 750px)
  .cx-bottle { max-width: 680px; margin-inline: auto; }` and the guarantee modal untouched.

### 2d. CSS additions (cellexia-booster.css — not baselined, but class-coverage enforced)

New classes to style: `cx-survey__headnum`, `cx-survey__rec-pct`, `cx-survey__outcomes`,
`cx-survey__outcome`, `cx-survey__outcome-row`, `cx-survey__outcome-statement`,
`cx-survey__outcome-pct`, `cx-survey__bar`, `cx-survey__bar-fill`, `cx-survey__outcome-n`,
`cx-study__subject`, `cx-study__facts`, `cx-study__fact`. Delete now-dead format rules
(seal/report/question/tally/strip sections EXCEPT `.cx-survey__quote` which the new widget
reuses, and the shared disclosure/panel/chip rules which stay). Delete the INHERIT row for
`cx-survey__seal-body` (emission dies). Keep `cx-survey__panel-verify` row (still emitted,
still unstyled). The v6.11 harness-pinned `.cx-study` 680px block stays byte-identical.

Design language (tokens are hardcoded): ink #1d1d1b, accent #b1cded, hairline #e5e5e3,
panel #fafaf9, muted #808080, track #e9eef5, Gobold+700 for numerals/headlines.
Bars: 6px track #e9eef5, fill ink; pct numerals Gobold 15-16px; statements 14px;
outcome-n 11px muted. Desktop (≥750px): survey keeps max-width 680 centered,
text-align start for outcome rows (long-form rule), headline centered. Mobile: stacked,
full-width bars, 44px+ touch target for the disclosure button. RTL: logical properties
only (bars fill from inline-start).

## 3. Admin

### 3a. Product editor (app.products.$id.tsx)

New "Dermatologist survey" CONTENT card (replaces the flag-only card; keeps the per-product
opt-out Checkbox): fields per 1a (title, sample size, recommend-yes, question, intro,
methodology multiline, verifier name, verification URL), outcome rows (statement +
yes_count, add ≤6 client / 8 server, remove, Move up/down like BA entries), live percent
preview per row, fail-closed warnings mirroring the storefront rules, delete-survey 2-click
confirm, knownIds staleness (clinicalSeedIdsRef pattern), auto-translate candidate
(save_survey joins the candidates list), stale/error banners. Server: `save_survey` /
`delete_survey` intents → `saveProductSurvey`/`deleteProductSurvey` in pdp-content.server.ts
(saveClinicalStudy/deleteClinicalStudy mirrors, MAX_SURVEY_OUTCOMES=8, references(first: 8)).

Study card: + Subject TextField (helpText: the "tested on this product" line; blank ⇒
translated default with the product title) + Move up/down for result rows (first row =
headline stat).

Guarantee card: copy refresh only (new headline quoted).

### 3b. Product index (app.products.tsx)

PDP_FEATURES: derm_survey `perProductContent: true`, desc "Per-product outcomes survey…
off on every product until you add its survey content."; guarantee title/desc rename.
Survey status badge becomes content-aware: `ProductBoosterStatus.boosters` gains
`derm_survey: boolean` (LIST_PRODUCTS_QUERY gains the productSurvey metafield alias).

### 3c. Survey feature page (app.features.survey.tsx)

Repurposed as GLOBAL DEFAULTS + master switch page: enabled toggle, marketScopes card,
default verifier name/URL, the v6.11 methodology editor (BUILT_IN_METHODOLOGY + tokens +
load/reset button + normalizeMethodologyForSave — ALL KEPT, harness lock intact), and an
explainer card pointing to Product boosters for per-product content. REMOVED: sampleSize/
yesCount fields, the five-format picker, format previews. Methodology preview keeps
`const previewTotal = String(EXAMPLE_TOTAL);` / `const previewYes = String(EXAMPLE_YES);`
(270/248 example constants, labeled as example values in the UI) so the harness pin shape
survives; no toLocaleString.

## 4. Locale catalogs (all 18 files)

survey.*: ADD `rec_line` ("of {{ total }} dermatologists surveyed would recommend
{{ product }}"), `outcomes_intro` ("The surveyed dermatologists also rated the outcomes
they observed with {{ product }}:"), `outcome_agree` ("@@YES@@ of @@TOTAL@@ agreed" —
sentinel convention, no t-params). REMOVE `title_pct, count, report_title, report_surveyed,
report_yes, report_recommend, question_intro, question_result, dot_legend` (9 keys, every
file). KEEP eyebrow/how/verified_badge/verified_by/methodology_p1..p5 byte-identical
(harness three-way lock).

study.*: ADD `subject` ("Tested on {{ product }} itself — the exact formula on this
page."), `fact_participants` ("{{ n }} participants"). REMOVE `methodology` (the m1
composition). KEEP eyebrow/weeks_count/instruments/view_study/footnote_default.

bottle.*: `title` → "Try it for {{ days }}, completely risk-free" (all 18, native quality,
days param = precomposed pluralized label). Everything else unchanged.

Translation quality bar: native idiom per locale, correct quote marks and % spacing,
plural-category correctness (no new plural keys), `ar` RTL-safe (no new physical-direction
copy), `ja` no-plural conventions. en.default.json is authored in the storefront wave;
17 translations follow.

## 5. Validation surgery (walk validation-map §7)

1. allowlist.json: +v7 entries for blocks/pdp-booster.liquid and assets/cellexia-pdp.js
   (entries accumulate; one per file suffices — refresh reasons).
2. harness S5 v6.11 survey block: KEEP methodology three-way lock pins; DELETE the retired
   previewTotal semantics? No — keep `String(` pins (spec 3c keeps the shape). ADD v7 pins:
   survey island emits `"o":` outcomes member; pdp.js contains `cx-survey__bar-fill`;
   SURVEY_FORMAT retirement pin (`SURVEY_FORMAT_OPTIONS` absent from app.preview.tsx,
   `dermSurveyFormat` absent from preview.server.ts/metafields.server.ts).
3. EVIDENCE rows: unchanged (markers stay).
4. INHERIT: delete `cx-survey__seal-body`; audit `cx-bottle__content`/`cx-survey__panel-verify`
   (stay). New classes get CSS rules (no new INHERIT rows expected).
5. cfg paths: survey Liquid still reads cfg.dermSurvey.{enabled,methodology,verifierName,
   verificationUrl} (+marketScopes) — all resolve. Legacy format/sampleSize/yesCount reads
   REMOVED from Liquid.
6. sims/survey-methodology.cjs: rewrite in place (same basename, ≥9,000 B): keep M-panel
   cases (methodology precedence + tokens + textContent), ADD outcomes cases (row math,
   invalid-row drop, zero-rows fail-closed, rec headline math, bar width numeric, statement
   textContent, verified link), 4+ mutants re-anchored to the new source. Extraction list
   updated (surveyBuildFormat/buildSurveyDots gone; new builders in).
7. suite-manifest/run-all: unchanged (same basename).
8. Analytics: no new keys/types.
9. settings-derivation/flip-test: untouched (no FeatureKey changes).
10. Byte meter: expect ~+1.5KB Liquid net; hard stop if pdp-booster > 28,000 (self-imposed
    margin under the 30,000 ceiling).

## 6. Ship checklist

npm run validate green (strict) · npx tsc --noEmit clean · npm run build green · fixture
screenshots mobile+desktop for all three widgets (survey with/without rec headline, study
with 1 and 4 results, bottle with/without overrides) · adversarial review wave · UPDATE.md
v7 notes (survey OFF until per-product content added — the deliberate migration story;
guarantee rename; study additions; definition migration note) · memory · fresh-clone ZIP.
