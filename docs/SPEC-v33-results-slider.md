# SPEC v33 — Results gallery: combined clinical photo · study design · compare slider

**Sections** `beforeAfter.labDesign` ("classic" | "study") + `beforeAfter.slider`
(boolean) · **DB** `CustomerResult.combinedUrl` · **admin** /app/proof/results
(Clinical display card + per-entry Photo format) · **transport** results proxy
`payload.ui` + four new `payload.copy` codes (aw/dr/iv/zm) — ZERO Liquid bytes,
ZERO locale bytes · built 2026-09-23. Ships with both options OFF and no
existing entry changed.

Merchant ask (2026-09-23, with the Strivectin PDP reference screenshot): for
the proof library's before/after gallery, (1) allow uploading ONE single
combined before+after photo for clinical entries instead of a separate pair;
(2) make clinical entries look even more like a clinical study result — a
design that can be selected for all clinical entries; (3) an optional on/off
before/after drag slider so shoppers compare the photos themselves — and the
slider must work BOTH for two-image entries AND for single combined images.
Goal: trust and credibility.

Binding contract for the v33 wave. Read `docs/SPEC-v25-results-redesign.md`
first — its architecture (proxy chrome copy, lab-only triple gates, fail-closed
rendering, density rule) all carries over, plus the v25 non-negotiables: ES5,
textContent-only sinks, createElementNS icons, pfHttps gates, class coverage,
zero innerHTML, zero new assets. "Clinical entry" always means a
`source = "lab"` CustomerResult row (the storefront badge "Clinical study
result") — NOT the unrelated `clinical_results` stat-band FeatureKey.

## 1. Data model (BOTH schema files + sqlite migration
`20260923090000_v33_results_combined`; Postgres = `db push` per UPDATE.md §2)

`CustomerResult` gains ONE nullable column: `combinedUrl String?` — the https
URL of a single side-by-side composite (left half = Before, right half =
After, same framing in both halves).

Rules (proof.server.ts):

- LAB-ONLY, three layers (the v25 measurements pattern): `saveResult` cleans
  `combinedUrl` through `cleanHttpsUrl` only when `source === "lab"` and
  clears it otherwise (flipping an entry to customer deliberately drops the
  clinical figure); `getPublicResults` serves `combinedUrl: lab ? … : null`
  (the drifted-data belt, mutant-pinned); `resultsValidItems` computes
  `c = lab ? pfHttps(it.combinedUrl) : ''` (the redundant client belt).
- COMBINED WINS: when `combinedUrl` is non-empty the data object stores
  `beforeUrl`/`afterUrl` as null — a row never carries both layouts, so the
  renderer can never show one result twice. The admin's `formToPayload`
  strips the unused layout's URLs first; the server rule is the belt.
- The at-least-one-content rule now counts the combined photo.
- The renderable gate is LAB-AWARE:
  `beforeUrl || afterUrl || (source === "lab" && combinedUrl)` — a customer
  row whose only image is a drifted combined photo would never render, so it
  must not enter items, totals or facets at all.
- `PublicResult` is now NINETEEN fields (PR4 pin moved; the v25 "eighteen"
  contract grows by `combinedUrl`).
- No translation impact: the column is a URL (`TRANSLATABLE_PROOF_FIELDS`
  untouched, T7b stays 14).

## 2. Settings (settings.server.ts) — two LIVE display options

- `beforeAfter.labDesign: LAB_RESULT_DESIGNS = ["classic", "study"]`,
  default `"classic"`; sanitize = closed-enum coercion (WALL_STYLES
  precedent).
- `beforeAfter.slider: boolean`, default `false`; sanitize = typeof-boolean
  coercion (press.logoCue precedent).
- Both are LIVE display settings with no draft plumbing (the v6.5/v8.3
  density/placement precedent) and are NOT FeatureKeys — they inherit
  `verified_before_after`'s master flag, market scope, pdp_flags opt-out,
  preview draft and beacons. FEATURE_KEYS stays 47.

## 3. Transport (proxy.proof.tsx) — zero Liquid, zero locale bytes

Liquid sits at 99,454/99,500 (46B) and el/ar at the 15,200B pin, so nothing
new may ride the island or the catalogs:

- NEW `payload.ui` member on PAGE-1 results responses (the endorsements
  page-1 settings precedent, own try/catch — a settings failure serves the
  classic gallery): `{cs: 1}` when `labDesign === "study"`, `{sl: 1}` when
  `slider === true`; absent otherwise. The widget reads it ONCE with strict
  `=== 1` checks (`resultsUiFlags`, fail closed) and reuses the flags for
  every refetched card and lightbox.
- FOUR new `payload.copy` codes in `results-ui-copy.server.ts` (all 18
  locales, nb/no twins, native, no em dashes; UC pins extended):
  `aw` "After @@N@@ weeks" (study photo tag), `dr` "Drag to compare"
  (slider hint + aria-label), `iv` "Individual results may vary." (study
  footnote), `zm` "View larger" (slider-mode lightbox button). The
  resultsApplyCopy whitelist is now TEN codes (harness pin moved).
- PREVIEW CACHE-BUSTER: the proxy response is CDN-cached 60s/300s, so a
  display flip can take ~5 minutes to reach shoppers (the admin card says
  so). While `pfPreviewVerified()` is true, `resultsParams` appends a
  per-minute `pv` token so the MERCHANT's preview sees flips within about a
  minute. Shoppers never send the parameter (sim-pinned).

## 4. Storefront (cellexia-proof.js + cellexia-booster.css)

Flags-off DOM is byte-identical to v25 (U7/C2/C5 root pins + R2/R7 hold; no
root modifier is ever added for v33 — both features are card-level).

- COMBINED FIGURE (classic media): `resultsComboFrame` renders ONE
  full-width `cx-results__frame--combo` frame whose
  `cx-results__thumb--combo` keeps the composite's natural aspect (the
  pair's 1:1 crop would cut both outer halves), tagged with the joint
  `resultsComboTag` label "Before / After" (built from the existing
  bef/aft island strings — no new locale text). The lightbox shows one
  `cx-lightbox__img--combo` figure spanning the 2-column grid.
- COMPARE SLIDER (`resultsSlider`): one stage, two feeds — the separate
  pair (base img = After, clipped top layer = Before) or the ONE composite
  (base = its RIGHT half, top = its LEFT half; 200%-wide layers, the stage
  adopts `naturalWidth/2 × naturalHeight` on image load). The divider is an
  inline `clip-path: inset(0 X% 0 0)` set by the pure, sim-tested pair
  `resultsSliderPct` (pointer → clamped 0–100, null when unmeasurable) and
  `resultsSliderSet` (one-decimal position, complement re-rounded — no
  IEEE754 tails). PHYSICAL geometry on purpose: a photo's left half stays
  its left half under RTL; only the text tags follow physical sides
  explicitly (`cx-results__tag--ba` left, `--ba-after` right).
  - The stage is a plain div — a drag control may not nest inside the
    media `<button>`. In slider mode the media becomes
    `cx-results__media--slider` (div) and a dedicated `cx-results__zoom`
    button (zm label, new zoom icon) owns `pfLbOpen` + the click beacon.
  - Input: pointerdown (preferred) with mouse/touch fallback; press jumps
    the divider (juxtapose convention); drag listeners attach to document
    for the drag's duration; the handle is a real ARIA slider
    (`role=slider`, valuemin/max/now, dr aria-label, ArrowLeft/Right ±5,
    Home/End). `touch-action: pan-y` keeps vertical rail scrolling alive;
    horizontal drags belong to the slider. Review hardening (C1/C2, all
    refuter-confirmed 3/3): `setPointerCapture` on the stage retargets
    pointerup AND the synthesized click to the stage, whose click
    suppressor keeps a drag released over the lightbox backdrop from
    closing the dialog; `pointercancel`/`touchcancel` tear the document
    listeners down (a browser-taken vertical pan ends in cancel, never
    up — without this the divider chased every later scroll); a recorded
    `dragId` keeps a second finger from cross-driving the stage.
  - Capability gate (C4): the stage needs `aspect-ratio` + `clip-path`;
    when `CSS.supports` answers no (Safari <= 14), `resultsSlider`
    returns null and the classic media serves (fail closed). A missing
    `CSS.supports` (the sim's vm) proceeds. Side effect: every gated-in
    browser has PointerEvent, so the mouse/touch fallback is a belt.
  - Video entries (C3): the play chip stays decorative in slider media —
    `pointer-events: none`, PHYSICAL bottom-left (the zoom button owns
    physical bottom-right; a logical inset stacked them under RTL) — and
    the zoom button's aria-label appends the vid string ("View larger ·
    Video"), since a div's stray sr-only span is announced by nothing.
  - The `cx-results__ba-hint` "Drag to compare" pill hides after first use
    ([hidden] guard styled). Ultra density hides it entirely (240px cards);
    coarse pointers get the 44px handle/zoom floor.
  - Slider needs both halves: single-image entries keep the classic media
    even with the option on. Video entries keep the play chip; the video
    itself lives in the lightbox as before.
- STUDY DESIGN (`labDesign: "study"`, LAB cards only — customer cards are
  never dressed as studies, mutant-pinned): card modifier
  `cx-results__card--study`; `resultsStudyHead` prepends an ink document
  band (flask icon + the lb "Clinical study result" string, uppercase
  letterspaced — the v8.8 dossier language) and the badges row drops its
  now-duplicate lab pill (one credential); photo tags restyle to ink chips
  and the After tag week-stamps via `resultsAfterTag` ("After 7 weeks",
  aw code) whenever the entry has a duration — never on weekless entries
  (mutant-pinned: no fabricated "After 0 weeks"); `resultsDisclaim`
  closes the card with the iv footnote. The lightbox keeps its lab pill
  (no band there) and gains the week-stamped caption + footnote. Arabic:
  the new letterspaced chrome (`study-t`, `ba-hint`) joins the
  `:lang(ar) letter-spacing: 0` reset.
- Both options compose freely (study band + slider stage on the same card).

## 5. Admin (app.proof.results.tsx + ProofForms.tsx)

- Per-entry: a lab-only "Photo format" ChoiceList — "Separate before and
  after photos" | "One combined before/after photo (before on the left,
  after on the right)". Combined mode swaps the two ProofImageFields for
  one wide field (`previewFit="contain"` — cover would crop the composite)
  with the left/right guidance. `imageMode` is client-only and derived
  (`combinedUrl ? "combined" : "pair"` on open); `formToPayload` strips the
  unused layout's URLs; `hasContent` counts the active layout only. The
  moderation row shows ONE thumbnail + a "Combined photo" badge for
  combined entries. Review C5: `photoSwapLoss` blocks a save whenever the
  ACTIVE layout has no photo while the inactive one still does (a
  format/source switch would otherwise silently delete the entry's only
  image and the row would vanish from the storefront — image-less rows
  never serve); a caution line explains the way out.
- Shop-wide: a "Clinical display" card (own displayFetcher, the v8.11b
  isolation rule) — the design ChoiceList (Classic | Clinical study) and
  the slider Checkbox, both posting `save_settings` patches; help text
  states the ~5-minute proxy-cache delay.
- Uploads reuse the existing `upload_image` multipart path unchanged (a
  combined composite is just an image).

## 6. Proof inventory

- `sims/proof-gallery.cjs`: extraction list += the nine v33 functions;
  CLIN_COPY += aw/dr/iv/zm; cases R25 (strict ui flags), R26 (combined
  mapping lab+https gates), R27 (combo frame/figure + joint tag), R28
  (slider stage both feeds, press-jump, keyboard, hint, zoom → lightbox +
  beacon + video label, decorative chip, single-image bail), R29 (study
  band/stamp/pill/disclaim, weekless, customer untouched, lightbox,
  fail-soft), R30 (flags flow to Show-more cards; root class untouched),
  R31 (pure clamp math + IEEE754 re-round), R32 (pv preview-only), R33
  (capability gate fails closed); mutants m38–m43 (loose flag reads,
  combined lab gate, clamp, study lab gate, weekless stamp, caps gate) +
  re-anchored m6/m34. 521 checks.
- `sims/proof-server.ts`: seedResult += combinedUrl; PR4 → nineteen
  fields; SR5/PR12 (save round-trip, combined wins, refused image-less
  flip, https gate, lab-aware renderable gate, serve belt); UC codes list
  → ten + aw @@N@@ sentinel + v33 English pins; mutants m8–m10 (belt,
  save gate, combined-wins) + re-anchored m2. 532 checks.
- harness v33 block: schema ×2 + migration, the three server gates +
  exclusivity, settings enum/sanitize/defaults, the proxy payload.ui
  emission, strict JS reads + raw reads + ARIA pins, CSS class family +
  touch-action + :lang(ar), admin wiring; the v25 whitelist pin now reads
  ten codes. Prover allowlist: v33 entry for cellexia-proof.js.
- Suite after v33: 36 suites / 11,929 checks green + tsc + build.

## 7. Byte meters (at ship)

Liquid TOTAL 99,454/99,500 — UNTOUCHED (no .liquid file in the wave).
Locale files untouched (el 15,069 / ar 15,124 vs the 15,200 pin). New
strings live in results-ui-copy.server.ts (~9.4KB). cellexia-proof.js
~119KB, cellexia-booster.css ~190KB (no caps).

## 8. Out-of-band fix + out of scope

- OUT-OF-BAND FIX shipped with this wave: `package-lock.json` gains the
  `extensions/cellexia-volume` workspace entries the v32 wave forgot —
  the fresh-unzip gauntlet's `npm ci` failed on every v32.x ZIP
  ("Missing: cellexia-volume@0.0.1 from lock file"), breaking the
  UPDATE.md §3 deploy flow on fresh checkouts. The regeneration is
  proven purely additive (two entries added, zero removed/changed).

### Out of scope (deliberate)

- No slider/design analytics beacon (impression + click stay the gallery's
  existing pair); can ride ALLOWED_FEATURES later if asked.
- No per-entry design override (the design is a shop-wide choice, per the
  ask "for all clinical reviews").
- No image-dimension validation for composites (the admin guidance states
  the left/right layout; a wrong composite is visibly wrong in preview).
- The pre-load composite aspect guess is 1:1 (JS refines on load); a CSS
  aspect hint per entry would need per-item data for marginal gain.
