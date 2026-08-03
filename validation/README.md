# validation/ — the repo-resident validation suite

**Why this directory exists in the repo:** the previous generation of this
suite (equivalence prover + baselines + a ~1,200-check harness + ~18 sims,
built across 20 waves) lived in a session tmp scratchpad and was **wiped by
OS tmp cleanup**. Only two proofs survived. Everything here is therefore
repo-resident, ships in the dev ZIP, is excluded from nothing, and must
never be moved to tmp. `validation/suite-manifest.json` + harness section 9
make deleting (or hollowing out) any suite a build failure.

Run everything:

```
npm run validate                      # strict (the default)
node validation/run-all.mjs --no-strict   # build phase only: absent suites = loud SKIP
```

House rules: offline (node / npx tsx only — no network, no Shopify auth),
deterministic (inject clocks, never depend on Date.now), total runtime
under ~3 minutes.

## Suites

- **run-all.mjs** — runs every registered suite, prints a per-suite
  scoreboard + totals, exits non-zero on any failure (and, in strict mode,
  on any registered-but-absent suite). A suite that exits 0 without its
  `ALL-N-PASSED` line is treated as failed (vacuity guard).
- **prover.mjs** — normalized-equivalence of `extensions/cellexia-booster`
  (blocks/, snippets/, assets/*.js) against `baselines/v68/`, driven by
  `allowlist.json` (intended divergences; stale entries fail); carries the
  template/builder registry for future Liquid→JS migrations and the Liquid
  byte meter. Passes trivially on the untouched tree.
- **baselines/v68/** — committed snapshot of the theme extension at v6.8,
  the equivalence baseline for future waves. Re-baseline deliberately, per
  wave, never as a side effect.
- **harness.mjs** — structural tripwires, each self-checking against
  vacuity: Liquid byte budget (≤95,000 own budget under Shopify's 102,400
  cap) + per-file floor/ceiling; PREVIEW COVERAGE (all 33 FEATURE_KEYS
  parsed live from settings.server.ts, each pinned to real storefront
  markers / checkout gates); PICKER COVERAGE (FEATURE_GROUPS, GROUPS,
  CONFIGURE_URL, fallback-group code); CLASS COVERAGE (every emitted cx-*
  token styled, prefix-resolved, or annotated — cart, pdp AND the v8
  proof asset; v8.2 closes the review-proven concat blind spots: the
  attrs-array 'class' idiom, a comment-stripped sweep of every single-
  quoted cx-token-only literal — ternary modifiers, className ternaries,
  dynamic class prefixes — an annotated NON-CLASS literal list for the
  ids the sweep drags in, and a self-test pinning the eleven review-
  proven tokens so the scan can never go blind to them again);
  CONFIG-PATH RESOLUTION (executes the real settings model,
  prisma stubbed); ESCAPE DISCIPLINE (href/src escaping in Liquid, the
  seven annotated innerHTML sites, ZERO innerHTML in cellexia-proof.js);
  schema names ≤25 chars; react-reconciler ^0.29.2 in all 4 checkout
  extensions; v8 pin block (proxy Cache-Control, prisma proof tables +
  legacyGid @unique, compact sanitize anchors + emission defaults, the
  __preview handoff, compact island members, v8 locale keys, the v8.1
  press market scoping, and the v8.2 ultra-compact wiring: three
  sanitize anchors, emission defaults, the three island "cm" literals,
  the .cx-press__quote[hidden] guard + endorsement pre-line rule); SUITE
  INVENTORY (manifest-enforced file floors + the pending→required
  ratchet).
- **settings-derivation.ts** — port of the surviving v6.8 proof: executes
  the REAL settings.server.ts and proves the 33-key inventory, amazon-flag
  mirroring, safe defaults, cfg-path resolution, sanitize round-trips,
  the 33-key flip tripwire, snapshot/restore, and pre-v6.8 merge
  back-compat (112 checks).
- **lib/** — shared helpers: `util.mjs` (normalization, checker,
  live FEATURE_KEYS parser), `settings-loader.ts` (loads the real settings
  model with prisma stubbed into `lib/.gen/`, regenerated from the current
  tree every run), `emit-default-settings.ts` (prints the real serialized
  emission for the harness).
- **sims/** — engine/feature suites that vm-extract the REAL shipped
  functions (never re-implementations) and print `ALL-N-PASSED`:
  dispatch-tz, delivery-businessdays, checkout-delivery-engine,
  native-dates, plurals, translation-service, crosssell-pipeline, fbt,
  badge-cards, az-split, subscribed-upgrade, survey-methodology,
  proof-gallery, proof-server, threshold-snap, flip-test.
  The eight most safety-critical (dispatch-tz, delivery, plurals,
  crosssell, az-split, survey-methodology, proof-gallery, proof-server)
  are mutation-tested: 3+ targeted mutants each, applied to a COPY, all
  must be caught; the mutants are recorded in each suite's header
  comment.

  Feature batch, two lines each:
  - **translation-service.ts** — real translation.server.ts vs mock DeepL +
    admin: allowlists, scoped metafield admission, incremental/outdated-only
    runs, manual-edit preservation, per-language independence, quota dedupe.
  - **crosssell-pipeline.cjs** — real cart cross-sell: complementary→related
    fallback order, dedupe/exclusions/caps, `_cellexia_upsell:'cart'`
    attribution, signature cache + stale-commit guard, manual island mode.
    Mutation-tested (5 mutants, header comment).
  - **fbt.cjs** — real az_fbt + az_similar_items: manual precedence (zero
    fetches), related fallback with cross-fetch dedupe, FBT↔similar dedupe,
    v6.5 placement resolution, checkbox math, 'fbt' attribution.
  - **badge-cards.cjs** — real card-flag decorator: cardGateOn gates, v6.6
    theme-tag replacement + untouched-without-flag rule, bought lines,
    sessionStorage cache/TTL, 2-fetch budget, debounced re-scan observer.
  - **az-split.cjs** — port of the surviving v6.8 scratchpad proof: the
    stock/ships split case matrix, restore semantics, per-line beacons,
    preview draft convention. Mutation-tested (5 mutants, header comment).
  - **subscribed-upgrade.cjs** — the v5.1 Joy rule: a volume tier is offered
    to a subscribed line only when the target variant allocates the line's
    plan (422 guard), plus savings-math fallbacks and plan lookup.
  - **survey-methodology.cjs** — real surveyBuildPanel (v6.11): merchant
    methodology token substitution ({{ total }}/{{ yes }}/{{ percent }} →
    live numbers, fail-safe 0), built-in translated fallback path, verifier
    link contract, textContent-only sink; v7 outcomes builder + study
    chips; v8 compact modes (survey top-line + "+ N more" disclosure,
    study --compact parity, bottle slim band). Mutation-tested (12
    mutants, header comment).
  - **proof-gallery.cjs** — real cellexia-proof.js renderers (v8): press
    rotate band, endorsement wall pagination/monogram/CLDR headline,
    results gallery cards + filter drawer → exact query pins + lightbox,
    scale-banner fallback chain, https/video URL gates, fail-closed
    empties, XSS textContent discipline; v8.2 ultra-compact branches
    (press tap-reveal/re-hide, endo composed head row + rail append,
    results root modifier, paragraph pre-line coverage) each with a
    cm-absent twin, plus the preview-render/beacon-suppression contract
    (pfWhenAllowed / pfPreviewVerified / pfBeaconsOff matrix — predicate,
    never the poll). Deterministic proofFetch stub (no network).
    Mutation-tested (9 mutants, header comment).
  - **proof-server.ts** — real proof.server.ts (prisma stubbed in-memory,
    settings-loader convention → validation/lib/.gen/): getPublicPress
    v8.1 market matrix (agnostic-only without a market, never another
    market's items), product prioritisation bands, endorsement
    pagination vs the ALL-matching total, results projection (approved +
    image-bearing only — items, totals AND facets), the exact public
    field sets (no shop/status/featured/sortWeight/productGids/
    marketHandles/legacyGid leak), facet stability under filters,
    PUBLIC_ROW_CEILING take pins, market-handle clean/parse round-trips
    and savePressItem validation. Mutation-tested (5 mutants incl. the
    review-proven market-filter dead-code, header comment); as a .ts
    suite it hands mutants.cjs the lib/tsx-shim.cjs bridge (plain-node →
    vendored tsx) via CX_TSX_SUITE.
  - **threshold-snap.ts** — real shipping.server.ts vs a mock Admin client:
    the 60.01→60 snap matrix, zone rate rules, lowest-per-market attribution,
    rest-of-world/unmatched zones, never-throw error paths.
  - **flip-test.ts** — all 33 FeatureKeys through the real settings model:
    flip round-trips, market scoping, applyFlipForMarket isolation,
    snapshot/restore, selective restore + the cart overlap group.
  - **sims/lib/** — shared vm-extraction helpers (`extract.cjs`), the
    documented mini-DOM (`mini-dom.cjs`), the mutation harness
    (`mutants.cjs`, mutant copies under `validation/.generated/`, never
    tmp) and `tsx-shim.cjs` (lets mutants.cjs re-run a TypeScript suite:
    plain-node bridge to the vendored tsx CLI, target via CX_TSX_SUITE).

## Landing a new suite (for rebuild agents)

1. Put the file in `validation/` or `validation/sims/` under its
   registered basename (any of .mjs/.js/.cjs/.ts — run-all resolves the
   extension; .ts runs under `npx tsx`).
2. Flip its `suite-manifest.json` entry from `pending` to `required` (and
   correct the filename if your extension differs) **in the same change**
   — harness section 9 fails the build the moment the file exists while
   the manifest still says pending.
3. Print `ALL <n> CHECKS PASSED (<suite label>)` on success; exit non-zero
   on any failure.

## Changing shipped extension files (future waves)

Any intended change to `extensions/cellexia-booster` blocks/snippets/JS
fails the prover until you either add an `allowlist.json` entry
(file/reason/wave) or — at a wave boundary — re-baseline by copying the
new tree over `baselines/v68/`'s successor and updating the prover paths.
