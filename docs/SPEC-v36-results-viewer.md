# SPEC v36 — before/after full-screen swipe viewer (results browse rework)

2026-10-06. The merchant's ask: the rail's horizontal scrolling is good,
but "Show more" below the rail appending cards sideways is bad UI; with
50-150 results per product, browsing must be seamless, add zero vertical
page space, keep initial load speed, and stay obvious for non-technical
mobile shoppers (mobile first, desktop too). Three interactive mockups
were evaluated (seamless auto-loading rail / "See all" grid overlay /
full-screen swipe viewer); the merchant picked **Option 3: the swipe
viewer**. Options 1 and 2 remain possible later add-ons on the same
plumbing and are explicitly out of scope here.

## Shopper behavior

- Rail = page 1 (12 results), untouched look. Its last position is the
  **"+N" tile** (`cx-results__moretile`): big numeral `+75` plus the
  `sa` caption ("See all 87 results"). It opens the viewer at the first
  unseen result — or, after a closed viewer session, at the **resume
  seat** (`st.vwAt`), so result 26 is never skipped. The legacy Show
  more button is still BUILT but stays hidden while the viewer is armed
  (it is the degrade path, and the sim fixture's reality).
- Any media/zoom tap opens the **viewer** at that card's index: a
  full-screen dialog on mobile (<900px), a large centered dialog on
  desktop. Chrome: aria-live counter `14/87` (digits only — no locale
  cost), close X (`results.close`), prev/next round buttons (`pr`/`nx`
  aria labels), bottom thumbnail strip (52/56px CDN thumbs, active ring,
  tap to jump, auto-centering) ending in a `+N` ghost chip while
  unfetched results remain.
- The item body is the EXISTING lightbox content, grafted: slider /
  combined figure / pair figures, video, badges + study tag, clinical
  panel, disclaimer, quote + attribution + meta — every v25/v33/v35
  gate (sl, cs, ns, ht, lab belts) rides along by construction.
- **Paging is invisible**: nav/jump within 3 of the end fetches
  `per=24`, `page = floor(store/24)+1`, same filters; id dedupe absorbs
  the overlap with the rail's per=12 page 1 (and cache skew). An
  all-duplicate or empty page stops the pager (loop guard). Opening at
  a not-yet-fetched index (the tile case) paints a quiet waiting stage
  until the page lands. Neighbors (idx±1) prefetch at width=1080.
- **Gestures**: swipe left/right pages (40px horizontal-dominant,
  start/end points only, no preventDefault) — but a gesture STARTING
  inside the compare stage (`.cx-results__ba`), the strip, or a video
  belongs to that control; the slider keeps full-screen dragging.
  ArrowLeft/Right page unless the slider handle has focus (its ±5% keys
  win). RTL (ar): chrome mirrored in CSS, swipe + arrow direction
  mirrored in JS (`resultsSwipeStep`).
- **Closing**: X, Escape, desktop backdrop, and the PHONE BACK BUTTON —
  one `history.pushState({cxVw:1})` per open, popstate closes, a UI
  close consumes the entry with `history.back()`; all feature-gated and
  skipped under `Shopify.designMode` (theme editor) and in the sim
  sandbox. Scroll lock/focus trap/focus restore are pfLbOpen's.
- Filters: a filter refetch resets the store, ids and resume seat; the
  tile re-counts from the filtered total; the viewer browses the
  filtered sequence (pager carries `st`).

## Arming + degrade matrix

The viewer arms only when `payload.copy` carries non-blank `pr` AND
`nx`; the tile additionally needs `sa`. Absent codes (old server during
the deploy gap, a <=5-minute stale proxy cache, the sim STR fixture) =
today's gallery including Show more, byte-identical behavior. A throw
inside `resultsViewerOpen` falls back to the classic one-item lightbox
(the dialog is built COMPLETELY before `pfLbOpen`, so the singleton is
still free); a programmatic double-open is refused by the viewer's own
singleton guard (no zombie pager into the shared store).

## Implementation map

- `app/services/results-ui-copy.server.ts` — codes `sa` ("See all @@N@@
  results"), `pr` ("Previous result"), `nx` ("Next result") across all
  17 tables (nb/no twins), native, no em dashes, `sa` carries @@N@@
  everywhere. Proxy untouched (the spread ships everything).
- `extensions/cellexia-booster/assets/cellexia-proof.js` (ES5,
  extraction-friendly top-level functions):
  - `resultsValidItems` + `id` member; `resultsApplyCopy` whitelist →
    13 codes; `resultsParams` delegates to NEW
    `resultsPageParams(conf, st, page, per)` (rail queries stay
    byte-identical — R16/H4 pins).
  - `pfLbOpen(root, trigger, opts)` additive third arg;
    `pfLbClose` fires `state.onClose` AFTER teardown. Both v8.21
    pinned lines untouched.
  - NEW: `resultsMergeItems`, `resultsCounterText`, `resultsCdnThumb`
    (host-gated `^https://cdn\.shopify\.com/`, idempotent ?width;
    strip 120 / viewer+prefetch 1080; foreign https passes through),
    `resultsSwipeStep`, `resultsViewerRtl`, `resultsViewerContent`
    (lightbox-card graft minus its close control),
    `resultsViewerPrefetch`, `resultsViewerHistory`,
    `resultsViewerSwipeBind`, `resultsViewerOpen` (dual-class
    `cx-lightbox__card cx-results-vw__card` dialog — the pinned
    pfLbOpen card selector finds it unchanged).
  - `resultsBuildCard(item, s, o, vw)` — vw routes taps to the viewer;
    absent vw = classic lightbox exactly (sims, old calls).
  - `resultsBuildSection` — seeds `st.items`/`st.ids`, arms `vwOn`,
    builds the tile, dedupes legacy appends, `syncMore` owns the tile's
    count/caption/end-seat and hides Show more while armed, filter
    resets clear the store + `st.vwAt`.
- `extensions/cellexia-booster/assets/cellexia-booster.css` — v36
  section at the END (equal-specificity overrides must come after every
  `.cx-lightbox` rule, the <=640px bottom-sheet included):
  `cx-results__moretile(-n/-t)`, `cx-results-vw` family (full-screen
  card base, >=900px centered dialog, head/count/close/body/stage
  (+--wait)/item/nav/btn(+RTL mirrors, [disabled])/strip/thumb(--on)/
  ghost), `[hidden]` display:none!important guards, reduced-motion
  kills the fade + the wait pulse.
- ZERO Liquid bytes, zero locale-file bytes, zero settings, zero ui
  flags, zero new beacons (the existing impression + click sites are
  unchanged), zero server pagination changes.

## Validation

- `sims/proof-gallery.cjs`: VW1-VW11 (+ the VW6 resume tail) and LB6;
  extraction list + STR fixture untouched (the fixture's missing codes
  ARE the degrade proof — R16 passes by construction). New mutants
  m50-m55 (dedupe, CDN gate, swipe threshold, pager formula, stage
  exclusion, counter clamp). m34's find moved with the 13-code line.
- `sims/proof-server.ts`: UC1 codes array += sa/pr/nx; UC2 auto-covers
  non-blank/no-em-dash + the new `sa` @@N@@ sentinel; UC5 pins the
  English strings.
- `harness.mjs`: the v25 whitelist pin moved (13 codes); new v36 block
  (RAW reads, arming line, dual-class literal, onClose hook, designMode
  guard, delegation line, pager formula, CDN gate, stage exclusion,
  singleton guard + resume, CSS families + override order + [hidden]
  guards + RTL mirrors, zero-Liquid).
- `allowlist.json`: one v36 entry for cellexia-proof.js (CSS is not a
  baselined surface).
- `npm run validate` → 36 suites / 12,280 checks, VALIDATION GREEN.

## Real-browser verification (fixture, 2026-10-06)

Fixture: scratchpad `v36-fixture/` (real JS+CSS, stubbed proxy with 87
items, 280ms latency, ui {cs:1,sl:1}), `v36-smoke` entry in the
parent-root `.claude/launch.json` (port 4186; the folder dies with the
session — rebuild from this spec's recipe when needed). Verified on
375x812 and desktop: Show more hidden / tile last ("+75 See all 87
results"); card tap → 2/87; thumb-jump → per=24 fetch → 24 thumbs,
ghost +63; ghost → waiting seat → resolves at 25/87, 48 thumbs, +39;
compare-stage drags move the divider (50→4) and never page (probed by
event target); neutral swipes page both ways; Escape/X/backdrop close +
scroll unlock + focus restore; tile RESUMES at 25/87; browser back
closes in place (URL and rail intact); filters re-count ("+17 · See all
29", viewer 13/29, filtered pager URLs); RTL mirrors chrome and swipe
directions; desktop centered dialog; console clean (the fixture's
beacon 501s aside).

## Release

`cellexia-aov-ltv-booster-UPDATE-2026-10-06-v36.zip` (not deployed).
Ship note: every extension deploy is currently gated by the Oct-1-2026
Shopify checkout block — the checkout Polaris migration must land
first. Post-deploy: fingerprint the served cellexia-proof.js for a v36
marker (e.g. `resultsViewerOpen`), then live-check tap → viewer →
swipe/arrows → invisible paging on the PDP; the viewer arms only once
the proxy cache (<=5 min) serves the new copy codes.
