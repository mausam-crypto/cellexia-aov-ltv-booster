# SPEC v38 — compare slider in the enlarged view only (slider scope)

Read with SPEC-v33 (the slider), SPEC-v35 (display options) and SPEC-v36
(the swipe viewer). Shipped 2026-10-09.

## Merchant ask

"Add an option that lets us choose between keeping the slider drag for all
(as now) or showing a standard before/after for all and only showing the
slider drag when they click and open the overlay (lightbox). Turn on the
standard before/after + lightbox slider by default. Make sure it all
displays perfectly on mobile."

Rationale given to the merchant: at 50% a card slider shows half a before
photo glued to half an after photo, so a shopper who never drags never sees
either photo whole; the side-by-side shows the full result at a glance, and
the drag earns its place in the enlarged view, where the shopper has shown
intent and the photo is big. Side effect on mobile: card photos no longer
carry `touch-action: pan-y`, so a horizontal swipe that starts on a photo
scrolls the rail again.

## Setting

`beforeAfter.sliderScope: "lightbox" | "everywhere"` (LIVE display setting,
`RESULTS_SLIDER_SCOPES`, the labDesign/desktopLayout convention).

| Admin choice ("Before/after comparison slider") | slider | sliderScope |
|---|---|---|
| Standard side by side on cards, slider in the enlarged view (recommended) | true | lightbox |
| Slider everywhere: on the cards and in the enlarged view | true | everywhere |
| Off: standard side by side everywhere | false | (kept) |

- DEFAULT_SETTINGS: `slider: true` (was false) + `sliderScope: "lightbox"`.
  The live store already had `slider: true` stored (payload.ui `sl:1` since
  2026-09-24), so after deploy it lands on the lightbox scope with no admin
  action. Stores that explicitly stored `slider: false` stay off.
- sanitize: a junk or absent scope (every pre-v38 store) coerces to
  "lightbox". "Off" keeps the stored scope so switching back on restores it.
- The admin control is one ChoiceList in the Clinical display card that
  drives both stored fields (`submitDisplay({ slider: true, sliderScope })`
  or `{ slider: false }`).

## Transport

`payload.ui.sc = 1` on the page-1 results response only when
`slider === true && sliderScope === "everywhere"` (the v35 "emit only when
departing from the default" rule). Strict `=== 1` read in
`resultsUiFlags`; absent/junk = lightbox scope. Zero Liquid bytes, zero
locale bytes, zero new copy codes (the hint reuses `dr`).

Deploy-gap matrix:

| Server | Widget JS | Result |
|---|---|---|
| old (no sc) | new | lightbox scope (the default) |
| new | old | v33 sliders on cards (old JS ignores sc) |
| new | new | the admin choice |

## Storefront

- `resultsBuildCard`: card stage only on `o.sl && o.sc`. Otherwise the
  standard media button (pair frames or the combined frame). In the
  lightbox scope (`sl && !sc`) the button gains a decorative
  `span.cx-results__zoom.cx-results__zoom--cue` (aria-hidden, 28px,
  pointer-events none, magnifier icon): "tap for the enlarged view". The
  one-photo and capability-gate fallbacks in the everywhere scope keep the
  exact v33 classic card (no cue).
- `resultsBuildLightbox`: the stage still needs only `o.sl` (so the swipe
  viewer, which grafts this builder, carries it too) and is marked
  `cx-results__ba--teach` when `!o.sc`. v33 hid the enlarged view's
  "Drag to compare" hint because the cards had already taught the drag; in
  the lightbox scope nothing else teaches it, so the teach rule shows it,
  top-center (the side tags own the bottom corners there; the classic
  lightbox's sticky close sits top-right, clear of it), wrapping to a
  centered second line instead of truncating (`inline-size: max-content`
  + a stage-relative cap — without max-content the `left: 50%` anchor
  would shrink-wrap the pill at half the stage width).
- `resultsComboFrame(item, s, o)`: the combined photo's standard card now
  labels each half like the stage (Before over the physical left half, the
  After tag over the right half, week-stamped in the study design via
  `resultsAfterTag`) instead of one joint "Before / After" tag. Physical
  sides on purpose (the stage-tag classes): the composite's left half is
  the before photo in every reading direction. The non-slider lightbox
  figure keeps its joint caption (`resultsComboTag`).

## Mobile layout fixes (CSS, v38 block at the end of cellexia-booster.css)

The week-stamped After tag runs long in several languages after the
parallel label change ("Săptămâni de utilizare: 10", "10 settimane di
utilizzo", "10 semanas de utilização"), and a half-width frame is ~140px
on a 375px phone.

- `.cx-results__frame .cx-results__tag`: border-box, `max-inline-size:
  calc(100% - 20px)`, line-height 1.3, radius 12px (still a full pill on
  one line, a rounded rectangle on two), `overflow-wrap: break-word` +
  `hyphens: auto`.
- `.cx-results__frame--combo .cx-results__tag` and
  `.cx-results__ba .cx-results__tag`: capped at `calc(50% - 20px)` so a
  tag never crosses into the other half. On the stage this also fixes a
  live defect class: the divider line is drawn OVER the tags, and a long
  After tag crossed the middle (seen in the viewer with ro before the fix).
  This piece protects every scope, including "everywhere".

## Verification (2026-10-09)

Fixture: scratchpad `v38-fixture/` built from the LIVE results payload
(24 real items, 21 combined lab photos at 400x224 + 1 lab pair) plus two
synthetic customer pairs; `?ui=lb|all|off`, `?l=en|ro|it|ptpt|fr|de|sv|ar|ja`
(bef/aft/aw/dr/zm per language, html lang set for hyphenation), `?nv=1`
drops the viewer codes (classic lightbox path); `audit.js` measures every
card tag against its frame/half, the cue against tags and media, and in
the enlarged view: tags vs the divider, hint vs tags/close/arrows, and
body scroll. Parent-root launch.json entry `v38-fixture` (port 4191; the
folder dies with the session).

- 375x812: all 9 languages, lightbox scope: 0 problems; viewer fits
  (685/685, no scroll); drag 50→7 hides the hint, never pages or closes.
- Everywhere scope (ro): 12 card stages, 12 zoom buttons, 0 cues, no tag
  crosses a card divider, enlarged-view hint hidden (v33 exactly).
- Off (ro): standard cards, no cue, static figures in the viewer.
- Classic lightbox (`nv=1`, ro): stage + hint, clear of the sticky close.
- 375x667, 360x740, 390x844, 414x896 (fr/ro/it/pt-PT/de): 0 problems,
  viewer never scrolls.
- 320x640 (fr, edge case): the combined stage is 187px wide (height-
  driven, v36.2); the After tag hyphenates to three short lines
  ("4 SEM. / D'UTILI- / SATION") and the hint wraps to two centered lines,
  all inside their halves.
- 1280x800: 0 problems, dialog fits (605/605).

## Tests

- proof-gallery: R25 (sc strict read), R27 (combined half tags), R28/R30/
  R33/VW8 moved to `sc` (the v33 behavior is now the everywhere scope),
  NEW R38 (lightbox scope card + cue + teaching stage, combined study card),
  R39 (everywhere = v33 exactly incl. the one-photo fallback, off, sc-only
  inert, absent flags = pre-v38 card), R40 (page-1 scope flows to
  Show-more cards), VW12 (viewer opens on a teaching stage). Mutants
  m56 card scope gate, m57 teach marker, m58 cue scope gate, m59 combined
  After half unstamped, all caught; m38 find moved with the widened flag
  return.
- harness: v33 pins moved (design default, flag return, admin save), NEW
  v38 block (enum, defaults, sanitize, proxy sc, JS gates, CSS ordering and
  caps, admin wiring, zero Liquid).
- allowlist: v38 entry for cellexia-proof.js.
- Suite 36 / 12,603 checks green, `tsc` 0, `npm run build` 0.

## Review (one adversarial agent) — 3 findings, all fixed

1. A video entry's play chip (top inline-end on standard cards) painted
   over the combined card's top-right After tag (and could reach a long
   week-stamped pair tag). Standard cards now put the chip at the PHYSICAL
   bottom-left, the v33 slider-card spot; bottom-right belongs to the cue.
2. In the classic one-item lightbox (the viewer's fallback) the centered
   hint could slide under the 40px sticky close below ~330px (French).
   That lightbox caps the hint at `calc(100% - 100px)` (symmetric, RTL-
   safe), so it wraps sooner; the viewer keeps the wider cap.
3. Screen readers lost the v33 zoom button's "View larger" name on the
   default-scope card: the media button now carries `aria-label` =
   zm (+ " · " + the video label), only when the proxy copy is present.

Re-verified in the fixture: no chip/tag/cue overlaps in lb/off/RTL, the
everywhere chip unchanged, 320px French classic lightbox hint clear of the
close.

## v38.1 (2026-10-09) — scale banner count (merchant catch)

"'See results from 16 real Cellexia users.' does not take into account lab
tests. Add an option so it only says 'See results from real Cellexia
users.' (no number), or option 2: a number reflecting all the
before/afters for this product, in all languages."

Root cause: `resultsBannerData` preferred `verifiedTotal` (approved AND
`verified` rows), and lab entries are never verified purchases. Live on
2026-10-09: cellular-renewal-cream 16 verified vs 132 served; products
with 0 verified fell back to `banner_all` with the full total (e.g.
advanced-glow-reset-serum "See results from 43 Cellexia users.").

- Setting `beforeAfter.bannerCount: "none" | "all"` (RESULTS_BANNER_COUNTS,
  LIVE, default "none"). Admin: "Banner above the gallery" ChoiceList in
  the Clinical display card.
- "none": the proxy's new copy code `bn` (results-ui-copy.server.ts, all
  19 languages, each mirroring its catalog's `results.banner_verified`
  with the count removed and grammar re-agreed: de "echter
  Cellexia-Anwender", fi "aitojen Cellexia-käyttäjien", hu
  "Cellexia-felhasználók", ro drops ": N în total", ja reworded to
  "実際のCellexiaユーザーの結果をご覧ください。"). Native check by one
  reviewer agent: all pass. Rendered as plain text (no count element).
- "all": `payload.ui.ca = 1` → `banner_verified`'s sentence with the page-1
  unfiltered `total` = every result the shopper can browse there
  (customer + clinical, brand-wide untagged entries included).
- Why the proxy and not a locale key: Liquid sits at 99,454/99,500 and
  ar/el at the locale byte wall; zero Liquid bytes, zero locale keys.
  Translate & Adapt cannot override `bn` (same as the other proxy chrome).
- Deploy gap: new widget + old server (no `bn`, no `ca`) keeps the exact
  pre-v38.1 chain; old widget + new server keeps the verified number
  until the extension deploys. An empty gallery renders nothing in every
  mode.
- Tests: proof-gallery R25 (ca strict), R41 (data: numberless, count-all
  incl. lab-only products, empty, no verified fallback under ca, legacy
  chain), R42 (DOM: plain text vs count element); mutants m60 count-all
  reverts to verified, m61 numberless dropped, m62 ca falls through on
  empty; m34/m38 anchors moved. proof-server UC1 (14 codes), UC2 (bn: no
  number/sentinel/en dash, names the brand, catalog punctuation), UC5
  pins (en/ro/de). Harness v38.1 block + moved v25/v33 pins. Suite 36 /
  12,697 green.
- Verified in the fixture (375px): en/ro/ar/ja numberless, de count-all
  ("Sehen Sie die Ergebnisse von 60 echten Cellexia-Anwendern." with 16
  verified), stale-cache path ("16 real Cellexia users."); no overflow.
