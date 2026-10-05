# SPEC v35 — Results gallery: study batches · study mix · display options

**DB** `CustomerResult.study` (nullable, lab-only) · **sections**
`beforeAfter.galleryOrder` ("mix" | "curated" | "newest"),
`beforeAfter.desktopLayout` ("row" | "grid"), `beforeAfter.showStudy`
(bool), `beforeAfter.hideLabQuotes` (bool) · **admin** /app/proof/results
("Add study batch" flow + four new Clinical-display options + Study name
field in the entry form) · **transport** results proxy: order applied
SERVER-side on every page, `payload.ui` gains gr/ns/ht (page 1), items
gain `study` · **storefront** study tag, testimonial expander, one-row
desktop default — ZERO Liquid bytes, ZERO locale bytes, ZERO new copy
codes · built 2026-10-03.

Merchant ask (2026-10-03): (1) desktop gallery stacks multiple rows and
eats vertical space — should be ONE row; (2) results from one study batch
all display together, then the next batch — instead show one result from
each study batch first, with display-order options to customise; (3) a
small study-name tag on each before/after; (4) batch upload — one batch =
one study for one product, measures/instruments shared, per-row numbers,
easy to add dozens accurately; (5) long testimonials are cut with no
expander; (6) an optional off-by-default setting hiding testimonials on
clinical entries.

Read `docs/SPEC-v34-result-presets.md`, `docs/SPEC-v33-results-slider.md`
and `docs/SPEC-v25-results-redesign.md` first — this wave composes with
all three contracts (presets, ui flags, fail-closed rendering, ES5 /
textContent / pfHttps discipline) and changes none of them.

## 1. Data model (BOTH schema files + sqlite migration
`20261003090000_v35_result_studies`; Postgres = `db push`, UPDATE.md §2)

`CustomerResult` gains ONE nullable column: `study String?` — the clinical
study (study-batch) name, usually a preset's name.

Rules (proof.server.ts):

- LAB-ONLY, three layers (the measurements pattern): `cleanResultInput`
  computes `study = isLab ? cleanText(input.study, RESULT_STUDY_MAX) : ""`
  (RESULT_STUDY_MAX = 80, PRESET_NAME_MAX's twin); `getPublicResults`
  serves `study: lab ? row.study : null` (serve belt, mutant-pinned m14);
  the widget's item map `st` is lab-gated too (client belt, m46).
- NEVER translated: a study name is a proper noun (the attributionName
  rule) — `TRANSLATABLE_PROOF_FIELDS` untouched, harness-pinned.
- REFACTOR: saveResult's inline cleaning extracted into
  `cleanResultInput(input) -> {errors, data}` so the batch runs each row
  through the IDENTICAL rules. Behaviour byte-equivalent for single saves
  (proof-server SR/PR suites hold unchanged).
- `PublicResult` is now TWENTY fields (PR4 pin moved; + `study`).

## 2. Gallery order (SERVER-side — no ui flag)

`beforeAfter.galleryOrder`, default **"mix"**:

- **mix** — round-robin across study batches: the first card from EVERY
  study, then every second, and so on. Grouping key = the lab row's study
  name; ALL study-less rows share ONE catch-all group (each as its own
  group would flood round one). Group sequence = first appearance in the
  curated order, so a featured entry still pulls its study to the front;
  rows inside a group keep curated order. With ≤1 group the output is
  IDENTITY — so the new default cannot reshuffle a live gallery that has
  no study tags yet (the deploy-safety property).
- **curated** — the pre-v35 sequence (featured desc, sortWeight asc,
  createdAt desc).
- **newest** — createdAt desc (stable; the featured pin deliberately
  ignored).

Applied in `getPublicResults(…, order)` AFTER filtering, BEFORE
pagination, INSIDE each product band (`applyGalleryOrder` partitions
tagged/brand again post-filter — the spec-§2 tagged-first contract is
untouchable). Facets, `verifiedTotal` and `total` are order-blind. Junk
order coerces to "curated" (`cleanEnum`, fail closed). The proxy therefore
reads `settings.beforeAfter` on EVERY results request now (the sequence
must agree across Show-more pages) — own try/catch; a failed read serves
curated order and no `ui` member. Pinned by GO1–GO7 + mutants m13/m16.

## 3. Transport (proxy.proof.tsx)

- Items gain `study` (full-name key, the house convention).
- `payload.ui` (page 1 only, the v33 contract) gains three flags, each
  emitted only when it departs from its default: `gr: 1`
  (desktopLayout === "grid"), `ns: 1` (showStudy === false), `ht: 1`
  (hideLabQuotes === true). Old servers emit none of them — the widget
  fails closed to row/tags-on/quotes-on (strict `=== 1`, R25 + m38/m48).
- ZERO new copy codes: the study tag renders the raw merchant text, the
  expander reuses the island's existing `more` string as its aria-label.

## 4. Storefront (cellexia-proof.js + cellexia-booster.css)

- **ONE-ROW DESKTOP (the fix):** at ≥900px the FULL-density rail no longer
  recomposes into the 4-column grid — the mobile flex/snap rail carries
  through with `flex: 0 0 320px` cards and the compact tier's thin
  scrollbar. The old grid survives behind `.cx-results--grid`, added by
  the widget ONLY under `ui.gr` (the only root-class flag; R37 + R30 root
  pin + m48). Ultra/compact desktop blocks sit later in the cascade, so
  those tiers always rail exactly as before.
- **STUDY TAG** (`resultsStudyTag`): a muted outline chip in the badges
  row (card AND lightbox) with `textContent = item.st`; ellipsized via
  CSS so a long name can never stretch a card; skipped under `ui.ns`, for
  entries without a study, and (by the st gate) for customer rows. In
  study design the chip coexists with the document band while the lab
  pill stays suppressed (one credential).
- **TESTIMONIAL EXPANDER** (`resultsQuoteMore`/`resultsQuoteSync`/
  `resultsQuoteClamped`): a chevron button after the clamped quote, built
  `[hidden]`, surfaced only when a rAF-deferred probe PROVES the 3-line
  clamp cut text off (`scrollHeight > clientHeight + 1`; non-numeric
  metrics fail closed — sim DOM, detached nodes). REAL-BROWSER CATCH #1:
  the decorative ::before quote mark (a 32px glyph hung at −3px) alone
  inflates scrollHeight past a ONE-LINE quote's clientHeight, so every
  short quote grew a pointless expander — the probe now toggles
  `cx-results__quote--probe` (::before suppressed) around the two
  synchronous reads, which never paints. REVIEW CATCH #2: the one-shot
  probe fires inside the web-font swap window (Argumentum reflows the
  clamp moments later), so every built (quote, button) pair is recorded
  and re-synced on window `load` + a 250ms-debounced `resize`
  (reveal-only; open quotes skipped by the sync guard; detached pairs
  no-op on zero clientHeight). Click toggles `cx-results__quote--open`
  (lifts every clamp incl. ultra's 1-line via a two-class selector placed
  after it; `white-space: pre-line` restores paragraph breaks) + chevron
  rotation + `aria-expanded`. No island `more` label → no unnamed button
  (the quote keeps today's clamp; the lightbox always carried the full
  text). The probe never re-hides an open quote's control. Mutant m47
  pins the overflow gate.
- **HIDE LAB QUOTES** (`resultsHideQuote` = `ht AND lab`): strips the
  quote, the attribution AND the expander from lab cards and from the
  lightbox foot (a hidden quote must not resurface on zoom — m49);
  customer entries always keep theirs (m45). The clinical panel, badges
  and meta stay — the card stands on the numbers.
- `resultsUiFlags` → `{cs, sl, gr, ns, ht}`, same strict discipline.
- `RESULTS_ICON_PATHS` gains `chev`.

## 5. Admin (app.proof.results.tsx + ProofForms.tsx + ResultBatchForm.tsx)

- **"Add study batch"** (new disclosure next to "Add result", own
  batchFetcher — the v8.11b isolation rule): the study constants once
  (preset picker fills them + the study name; name/duration/quote/
  attribution/marks/measurement DEFINITIONS without percents — the v34
  payload shape), photo format (pair | combined, locked while rows
  exist), product tags, status (default pending — one "Approve all
  pending" click publishes a reviewed batch), verified, then ONE COMPACT
  ROW PER PARTICIPANT: photos + one percent field per measurement
  (+ optional per-row age/skin behind a toggle). A bulk DropZone uploads
  MANY files sequentially through the existing `upload_image` intent
  (single fetcher, one-in-flight guard, 150ms pacing) and creates rows in
  numeric-aware filename order; every cell shows its thumbnail, re-drops
  individually, pair rows can Swap — the accuracy is CHECKABLE, never
  assumed. A failed upload surfaces a named toast and leaves its cell's
  DropZone open. Review catches hardened the flow: the pairing key ranks
  the literal before/after TOKENS explicitly (plain alphabetical order
  puts "01-after" BEFORE "01-before", which would have swapped every pair
  under the hint's own naming convention); a pair-mode drop with ANY
  skipped file (oversize/wrong type) refuses the WHOLE drop instead of
  silently cross-pairing the remainder; Swap disables while either cell's
  upload is in flight (the queued item targets a fixed slot); the form
  stays MOUNTED while its disclosure is closed (a stray toggle click must
  not discard dozens of uploads — only a successful save resets it);
  unchecking "per-person details" blanks the hidden age/skin values at
  submit; and an ok batch whose preset upsert failed surfaces that
  warning as its own toast.
- Route intent `save_result_batch` → `saveResultBatch`: every row expands
  to a full ResultInput (shared defs zipped with the row's pcts) through
  `cleanResultInput`; batch-extra rule: every row needs its active
  layout's photo(s). ALL-OR-NOTHING: one bad row refuses the whole batch
  with row-numbered errors (capped at 12 + an honest overflow line) —
  a silent partial import is exactly the inaccuracy this feature exists
  to prevent (m15). Creates ride ONE nextSortWeight run (batch keeps its
  on-screen order); a mid-create failure reports created/total honestly.
  `savePreset` (default on) upserts the constants as a preset named after
  the study — non-fatal. Caps: MAX_RESULT_BATCH_ROWS = 100 (client twin
  MAX_BATCH_ROWS). After success: toast, form reset (key bump), and one
  bulk translate_proof run when auto-translate is on (the quote repeats
  on every row).
- **Entry form**: lab section gains a "Study name" TextField;
  `applyPreset` fills it with the preset's name (the preset payload
  itself is UNCHANGED — v34 pins hold). formToPayload/itemToForm carry
  it; the admin list's metaLine leads with the study.
- **Clinical display card** gains four LIVE options (displayFetcher,
  save_settings patches, the ~5-min cache note applies): Gallery order
  (Study variety / Manual / Newest), Desktop layout (Single row / Grid),
  Show the study name on cards (default on), Hide testimonials on
  clinical entries (default off).

## 6. Settings (settings.server.ts)

`RESULTS_GALLERY_ORDERS` (twin const in proof.server.ts — keep identical)
and `RESULTS_DESKTOP_LAYOUTS`, both closed enums; four new beforeAfter
fields with defaults `mix` / `row` / `true` / `false`; sanitize = closed
enum coercion ×2 + typeof-boolean ×2 (the labDesign/slider discipline).
No new FeatureKey (presentation options of verified_before_after — the
v33 verdict). FEATURE_KEYS stays 47.

## 7. Proof inventory

- `sims/proof-server.ts`: seedResult += study; PR4 → twenty fields; NEW
  ST1–ST4 (lab-only save, flip clears, serve belt, 80 cap), GO1–GO7
  (curated identity, junk coercion, mix round-robin + featured-first
  group order, paging concatenation, newest, drifted-customer grouping,
  product bands), SB1–SB6 (3-row happy path incl. per-row numbers +
  shared constants + sortWeight order + preset upsert, all-or-nothing,
  row-numbered errors, both-photos rule, combined rows, savePreset off,
  header validation, caps, error cap); mutants m13 (order ignored), m14
  (serve belt), m15 (partial write), m16 (mix lab gate). 549 → 588.
- `sims/proof-gallery.cjs`: extraction += the five v35 functions; sandbox
  gains a recording requestAnimationFrame; R25 widened to five flags;
  NEW R34 (study tag: belt, chip, ns, study design, lightbox), R35
  (expander: hidden build, rAF probe, proven-overflow surface, toggle,
  open guard, pure clamp probe, stale-island degrade), R36 (ht: card +
  lightbox, customer untouched, panel stays), R37 (grid root modifier);
  mutants m44–m49 + re-anchored m38. 521 → 550.
- harness v35 block: schema ×2 + migration, lab-only study + serve belt,
  order coercion + interleave invariants, batch same-cleaner +
  all-or-nothing ordering pin, settings enums/defaults/sanitize, proxy
  order-per-page + gr/ns/ht emission, widget belts/expander/grid pins,
  CSS grid-only-behind-modifier + cascade-order pin, admin wiring,
  study-not-translatable. v33's two proxy/flags pins moved with the
  restructure (documented there). Prover allowlist: v35 entry for
  cellexia-proof.js (CSS is outside baseline scope).
- Suite after v35: 36 suites / 12,060 checks + tsc + build.

## 8. Byte meters (at ship)

Liquid TOTAL 99,454/99,500 — UNTOUCHED (no .liquid file in the wave).
Locale files untouched (el 15,069 / ar 15,124 vs the 15,200 pin).
cellexia-proof.js ~131KB, cellexia-booster.css ~194KB (no caps).

## 9. Out of scope (deliberate)

- No per-study landing/filter chip on the storefront (the study tag is
  informational; the concern/age/skin/duration facets stay the filter
  surface).
- No CSV import for batches (the photo-pairing DropZone + percent grid
  covers the "dozens, accurately" ask without a column-mapping UI).
- No study rename cascade (edit entries' Study name individually, or
  re-upload; presets rename via delete + re-save, the v34 rule).
- No new analytics beacons (the gallery's impression/click pair carries).
- ResultPreset.payload shape untouched — presets still carry no product
  tags and no study field (the preset NAME is the study identity).
