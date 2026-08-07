/**
 * Structural harness — the tripwire suite. Rebuilt repo-resident after the
 * scratchpad wipe; every section is self-checking against vacuity (a check
 * that can no longer see its subject FAILS instead of passing silently).
 *
 * Sections:
 *   1. Liquid byte budget — total <= 95,000 (own budget under the 102,400
 *      Shopify theme-app-extension cap) + per-file floor/ceiling sanity.
 *   2. PREVIEW COVERAGE — FEATURE_KEYS parsed LIVE from settings.server.ts
 *      (33 keys); every key mapped to verified evidence in a real file
 *      (storefront data-cx-feature markers / checkout extension gates /
 *      documented alias), both directions (no unmapped key, no stale map).
 *   3. PICKER COVERAGE — every key present in app.preview.tsx
 *      FEATURE_GROUPS, app.features._index.tsx GROUPS and CONFIGURE_URL;
 *      fallback-group code still present in both routes.
 *   4. CLASS COVERAGE — every cx-* class token emitted by the THREE theme
 *      JS files (cart, pdp, v8 proof) and ALL .liquid files is styled in
 *      cellexia-booster.css, resolves as a dynamic prefix, or sits in the
 *      annotated inherit list (whose entries must stay emitted and stay
 *      unstyled).
 *   5. CONFIG-PATH RESOLUTION — executes the real settings.server.ts
 *      (npx tsx, prisma stubbed) and proves every cfg.* path read by the
 *      Liquid blocks resolves in the serialized DEFAULT_SETTINGS emission
 *      (documented exception: `preview`, injected at metafield-write time
 *      by metafields.server.ts — its injection site is pinned too), and
 *      every top-level cfg.<key> the theme JS reads is emitted as a JSON
 *      key by the Liquid.
 *   6. ESCAPE DISCIPLINE — no unescaped merchant value reaches href/src in
 *      Liquid; innerHTML in theme JS only at the seven annotated sites
 *      (entity-decoder, numeric-stars, static-svg-icon); the v8 proof
 *      asset carries ZERO innerHTML sites (a first one fails the build).
 *   7. SCHEMA NAMES — every {% schema %} name <= 25 chars (Shopify limit).
 *   8. REACT-RECONCILER — ^0.29.2 pinned in all 4 checkout extensions.
 *   9. SUITE INVENTORY — validation/suite-manifest.json enforced: required
 *      files exist above their byte floors (a deleted or hollowed suite
 *      fails the build); a pending file that has landed on disk MUST be
 *      flipped to required in the manifest (the ratchet).
 *  10. v8.4/v8.5 DEPLOY-PROOFING — env-aware Prisma selector as the ONLY
 *      generate/apply path in npm scripts (bare prisma generate/migrate
 *      banned), db.server.ts wrong-database boot guard, assertProofModels
 *      wired into all 11 entry funnels, proof-database health check (stale
 *      client / missing tables / wrong-database engine probe) in both
 *      orchestrator paths, schema.postgres.prisma recomputed-twin parity
 *      (drift = failure), Dockerfile prisma+scripts-before-npm-ci order,
 *      dev-URL safety + 2025-10 API pins, UPDATE.md + INSTALL.md
 *      deploy-guidance anchors.
 *
 * Run: node validation/harness.mjs
 */
import { execFileSync } from "node:child_process";
import {
  ROOT,
  rp,
  read,
  exists,
  bytesOf,
  listFiles,
  makeChecker,
  parseFeatureKeys,
  keysBetween,
} from "./lib/util.mjs";

const { ok, finish } = makeChecker("harness: structural tripwires");

const EXT = "extensions/cellexia-booster";
const BLOCKS = listFiles(`${EXT}/blocks`, ".liquid").map((f) => `${EXT}/blocks/${f}`);
const SNIPPETS = listFiles(`${EXT}/snippets`, ".liquid").map((f) => `${EXT}/snippets/${f}`);
const LIQUID_FILES = [...BLOCKS, ...SNIPPETS];
const CART_JS = `${EXT}/assets/cellexia-cart.js`;
const PDP_JS = `${EXT}/assets/cellexia-pdp.js`;
const PROOF_JS = `${EXT}/assets/cellexia-proof.js`; // v8 proof-library runtime
const CSS = `${EXT}/assets/cellexia-booster.css`;

// ===================================================== 1. Liquid byte budget
{
  const SHOPIFY_CAP = 102_400; // Shopify's hard cap on total Liquid in a theme app extension
  const BUDGET = 95_000; // our own margin below the cap
  const FLOOR = 500; // a shipped block/snippet below this has been gutted
  const CEILING = 30_000; // a single file above this needs a Liquid diet
  let total = 0;
  for (const f of LIQUID_FILES) {
    const n = bytesOf(f);
    total += n;
    ok(n >= FLOOR, `liquid floor (${FLOOR}B): ${f} has ${n}B`);
    ok(n <= CEILING, `liquid ceiling (${CEILING}B): ${f} has ${n}B`);
  }
  ok(LIQUID_FILES.length >= 10, `liquid surface visible (${LIQUID_FILES.length} files)`);
  ok(
    total <= BUDGET,
    `total Liquid ${total}B within budget ${BUDGET}B (Shopify cap ${SHOPIFY_CAP}B)`,
  );
}

// ==================================================== 2. PREVIEW COVERAGE
const FEATURE_KEYS = parseFeatureKeys();
ok(FEATURE_KEYS.length === 33, `FEATURE_KEYS parsed live: 33 keys (got ${FEATURE_KEYS.length})`);

/**
 * Evidence map: every FeatureKey -> at least one verified pattern in a real
 * shipped file. Aliases are documented where the storefront marker name
 * differs from the FeatureKey (historic marker names kept for analytics
 * continuity).
 */
const MARK = (name) => `'data-cx-feature', '${name}'`; // theme-JS builder marker
const EVIDENCE = {
  cart_volume_upsell: [{ file: CART_JS, has: MARK("cart_upsell"), note: "marker alias cart_upsell" }],
  free_shipping_bar: [{ file: CART_JS, has: MARK("free_shipping_bar") }],
  cart_subscription_upsell: [{ file: CART_JS, has: MARK("subscription_upsell"), note: "marker alias subscription_upsell" }],
  cart_trust_row: [{ file: CART_JS, has: "'cart_trust_row'", note: "effective-flag gate (row is part of the cart shell, no own marker)" }],
  trust_badges: [{ file: PDP_JS, has: MARK("trust_badges") }],
  trustpilot: [{ file: PDP_JS, has: MARK("trustpilot") }],
  guarantee: [{ file: PDP_JS, has: MARK("guarantee") }],
  clinical_results: [{ file: `${EXT}/blocks/clinical-results.liquid`, has: 'data-cx-feature="clinical_results"', note: "Liquid-rendered block (no JS builder)" }],
  subscription_nudge: [{ file: PDP_JS, has: MARK("subscription_nudge") }],
  checkout_upsell: [{ file: "extensions/checkout-upsell/src/Checkout.tsx", has: "'checkout_upsell'", note: "checkout extension gate" }],
  checkout_protection: [{ file: "extensions/checkout-protection/src/Checkout.tsx", has: "'checkout_protection'", note: "checkout extension gate" }],
  checkout_trust: [{ file: "extensions/checkout-trust/src/Checkout.tsx", has: "'checkout_trust'", note: "checkout extension gate" }],
  clinical_study: [{ file: PDP_JS, has: MARK("clinical_study") }],
  verified_before_after: [{ file: PROOF_JS, has: MARK("verified_before_after"), note: "v8: marker moved to the proof asset — the results-gallery block replaces the retired PDP BA widget (same feature key)" }],
  batch_transparency: [{ file: PDP_JS, has: MARK("batch_transparency") }],
  empty_bottle_guarantee: [{ file: PDP_JS, has: MARK("empty_bottle_guarantee") }],
  derm_survey: [{ file: PDP_JS, has: MARK("derm_survey") }],
  press: [{ file: PROOF_JS, has: MARK("press"), note: "v8 proof-library asset renders the press band" }],
  derm_endorsements: [{ file: PROOF_JS, has: MARK("derm_endorsements"), note: "v8 proof-library asset renders the endorsement wall" }],
  cart_cross_sell: [{ file: CART_JS, has: MARK("cart_cross_sell") }],
  dispatch_countdown: [{ file: PDP_JS, has: MARK("dispatch_countdown") }],
  delivery_estimate: [
    { file: PDP_JS, has: MARK("delivery_estimate") },
    { file: "extensions/checkout-delivery/src/Checkout.tsx", has: "'delivery_estimate'", note: "checkout extension gate" },
  ],
  az_buy_box: [{ file: PDP_JS, has: MARK("az_buy_box") }],
  az_microcopy: [{ file: PDP_JS, has: MARK("az_microcopy") }],
  az_delivery_line: [{ file: PDP_JS, has: MARK("az_delivery_line") }],
  az_stock_line: [{ file: PDP_JS, has: MARK("az_stock_line") }],
  az_ships_from: [{ file: PDP_JS, has: MARK("az_ships_from") }],
  az_bought_count: [{ file: PDP_JS, has: "'az_bought_count'", note: "bought line is text inside the buy box / cards (gate key, no own marker)" }],
  az_bestseller_badge: [{ file: PDP_JS, has: MARK("az_bestseller_badge") }],
  az_fbt: [{ file: PDP_JS, has: MARK("az_fbt") }],
  az_similar_items: [{ file: PDP_JS, has: MARK("az_similar_items") }],
  az_cart_free_line: [{ file: CART_JS, has: MARK("az_cart_free_line") }],
  az_cta_count: [{ file: CART_JS, has: "'az_cta_count'", note: "CTA-count decorates the theme CTA button (gate key, no own marker)" }],
};

{
  const mapped = new Set(Object.keys(EVIDENCE));
  for (const key of FEATURE_KEYS) {
    ok(mapped.has(key), `preview coverage: evidence declared for ${key}`);
  }
  for (const key of mapped) {
    ok(FEATURE_KEYS.includes(key), `preview coverage: no stale evidence entry (${key} is a live FeatureKey)`);
  }
  const cache = new Map();
  const srcOf = (f) => {
    if (!cache.has(f)) cache.set(f, read(f));
    return cache.get(f);
  };
  for (const [key, evidences] of Object.entries(EVIDENCE)) {
    for (const ev of evidences) {
      ok(
        srcOf(ev.file).includes(ev.has),
        `preview coverage: ${key} evidence matches in ${ev.file} (${ev.has})`,
      );
    }
  }
}

// ===================================================== 3. PICKER COVERAGE
{
  const KEYSET = new Set(FEATURE_KEYS);
  const equalsFeatureKeys = (label, found) => {
    const set = new Set(found);
    for (const k of FEATURE_KEYS) ok(set.has(k), `${label}: contains ${k}`);
    for (const k of set) ok(KEYSET.has(k), `${label}: no unknown key ${k}`);
  };

  const previewSrc = read("app/routes/app.preview.tsx");
  equalsFeatureKeys(
    "app.preview.tsx FEATURE_GROUPS",
    keysBetween(previewSrc, "const FEATURE_GROUPS", "];", FEATURE_KEYS),
  );
  ok(
    previewSrc.includes("is missing from FEATURE_GROUPS"),
    "app.preview.tsx: loader honesty assertion (FEATURE_GROUPS vs FEATURE_KEYS) present",
  );

  const hubSrc = read("app/routes/app.features._index.tsx");
  equalsFeatureKeys(
    "app.features._index.tsx GROUPS",
    keysBetween(hubSrc, "const GROUPS", "];", FEATURE_KEYS),
  );
  equalsFeatureKeys(
    "app.features._index.tsx CONFIGURE_URL",
    keysBetween(hubSrc, "const CONFIGURE_URL", "};", FEATURE_KEYS),
  );
  ok(
    hubSrc.includes("groupedHubKeys"),
    "app.features._index.tsx: ungrouped-key fallback group code present",
  );

  // v8.6: the Markets matrix is the marketScopes EDITOR — it shipped with
  // only 15 of 33 keys for months (clinical_study etc. had working market
  // gating but NO admin control). Same bar as the other two pickers now:
  // every key curated in MATRIX_GROUPS, fallback group as the safety net.
  const matrixSrc = read("app/routes/app.markets.tsx");
  equalsFeatureKeys(
    "app.markets.tsx MATRIX_GROUPS",
    keysBetween(matrixSrc, "const MATRIX_GROUPS", "];", FEATURE_KEYS),
  );
  // The fallback derives its key inventory from the LOADER's featureStates
  // (server-computed from the real FEATURE_KEYS) — module-scope client use
  // of the settings.server VALUE breaks the Remix build (v8.3 lesson), so
  // these anchors pin the loader-data-driven shape specifically.
  ok(
    matrixSrc.includes("function buildRenderGroups(") &&
      matrixSrc.includes("CURATED_MATRIX_KEYS"),
    "app.markets.tsx: ungrouped-key fallback group code present (loader-data-driven)",
  );
  ok(
    matrixSrc.includes("buildRenderGroups(featureStates)") &&
      matrixSrc.includes("renderGroups.flatMap((group) => group.features)"),
    "app.markets.tsx: rendered rows AND the save list both derive from the fallback-aware groups",
  );
  // A matrix row must also SAVE its flag flip — every non-cart, non-az key
  // needs a patch mapper (the hand-written blocks or SIMPLE_SECTIONS), and
  // the az rows write their INDEPENDENT amazon.* sub-flags changed-only
  // (there is NO amazon master switch — settings.server.ts
  // AMAZON_FLAG_FIELDS: "each key toggles independently"; the review caught
  // a phantom `amazon.enabled` write here, hence the negative pins).
  for (const anchor of [
    '["clinical_study", "clinicalStudy"]',
    '["verified_before_after", "beforeAfter"]',
    '["batch_transparency", "batchTransparency"]',
    '["empty_bottle_guarantee", "emptyBottleGuarantee"]',
    '["derm_survey", "dermSurvey"]',
    '["press", "press"]',
    '["derm_endorsements", "dermEndorsements"]',
    "const azChangedKeys = AZ_MATRIX_KEYS.filter(",
    "azChangedKeys.map((key) => [AZ_FLAG_FIELD[key], state[key].on])",
  ]) {
    ok(matrixSrc.includes(anchor), `app.markets.tsx: flag-patch mapper present: ${anchor}`);
  }
  ok(
    !matrixSrc.includes("amazon.enabled") && !matrixSrc.includes("anyAzOn"),
    "app.markets.tsx: no phantom amazon master switch (az flags are independent — the field does not exist in BoosterSettings)",
  );
  // v8.7 (merchant ask): market scopes are ALWAYS editable — pre-configure
  // targeting BEFORE enabling a feature. The cells must never be gated on
  // the feature toggle or the all-markets mode (toggleCell converts
  // all→selected itself), and the off-state note must say selections save.
  ok(
    !matrixSrc.includes("Enable the feature first") &&
      !matrixSrc.includes('disabled={row.mode === "all"}') &&
      !matrixSrc.includes("mutedStyle"),
    "app.markets.tsx: scope cells carry no feature-off/all-mode gating or dimming (scopes editable before enabling)",
  );
  ok(
    matrixSrc.includes("selections save now, apply when"),
    "app.markets.tsx: the off-state note says selections save now and apply on enable",
  );

  // v8.6: the Display density card must stay reachable — anchor + scroll on
  // the hub, deep links from the two pages merchants actually start from.
  ok(
    hubSrc.includes('id="display-density"') &&
      hubSrc.includes('window.location.hash === "#display-density"'),
    "app.features._index.tsx: display-density anchor + hash-scroll present",
  );
  ok(
    read("app/routes/app.proof.tsx").includes('url: "/app/features#display-density"'),
    "app.proof.tsx: Display density header link present",
  );
  ok(
    read("app/routes/app.products.tsx").includes('url="/app/features#display-density"'),
    "app.products.tsx: Display density link present",
  );

  // v8.7 STANDING RULE (merchant-verified): this store's legacy Liquid
  // templates cannot take section app blocks — the v8 proof blocks shipped
  // as target "section" and were UNADDABLE (content + armed preview =
  // nothing renders, no picker offers the block). Everything storefront
  // ships as an app EMBED (target "body") with JS self-insertion. The five
  // pre-v8 optional blocks are FROZEN exceptions; any NEW section-target
  // block fails the build here. Rule text: docs/theme-integration.md.
  const LEGACY_SECTION_BLOCKS = new Set([
    "clinical-results.liquid",
    "guarantee.liquid",
    "subscription-nudge.liquid",
    "trust-badges.liquid",
    "trustpilot.liquid",
  ]);
  for (const f of listFiles(`${EXT}/blocks`, ".liquid")) {
    const target = (read(`${EXT}/blocks/${f}`).match(/"target":"([a-z]+)"/) || [])[1];
    if (LEGACY_SECTION_BLOCKS.has(f)) {
      ok(
        target === "section",
        `embeds-only rule: ${f} is a FROZEN legacy section block (got target ${target}) — do not grow this list`,
      );
    } else {
      ok(
        target === "body",
        `embeds-only rule: ${f} must be an app embed (target body, got ${target}) — section app blocks cannot be added on this store's legacy templates (docs/theme-integration.md)`,
      );
    }
  }
  // (a) the merged proof embed: name + target + all three islands + NO
  // mount divs (the JS self-inserts via the ordered band)
  const proofLiquid = read(`${EXT}/blocks/proof-booster.liquid`);
  ok(
    proofLiquid.includes('"name":"Cellexia proof library"') &&
      proofLiquid.includes('"target":"body"'),
    'v8.7: proof-booster.liquid is the "Cellexia proof library" app embed',
  );
  for (const island of ["cx-press-config", "cx-endo-config", "cx-results-config"]) {
    ok(proofLiquid.includes(`id="${island}"`), `v8.7: proof embed emits #${island}`);
  }
  ok(
    !proofLiquid.includes("data-cx-mount"),
    "v8.7: proof embed emits no mount divs (self-insertion owns placement)",
  );
  // (b) the JS self-insertion band: fixed slot order, pdp anchor chain,
  // main fallback, FAIL-CLOSED (never append to <body>)
  const proofJs = read(PROOF_JS);
  for (const anchor of [
    "var PF_SLOT_ORDER = ['press', 'endorsements', 'results'];",
    "document.querySelector('.pdp__tabs')",
    "document.getElementById('main')",
    "cx-proof-band container container--md",
    // CODE-level fail-closed pins (a comment can rot; these cannot):
    "    if (!placed) return null;",
    // deterministic order at the contended .pdp__tabs anchor — the band
    // walks past merchant-placed cx widgets that inserted there first
    "function pfPastCxSiblings(anchor) {",
    "indexOf('cx-proof-stack')",
    "indexOf('cx-az-sections')",
    "pfInsertAfter(band, pfPastCxSiblings(tabs))",
  ]) {
    ok(proofJs.includes(anchor), `v8.7: self-insertion anchor present in cellexia-proof.js: ${anchor}`);
  }
  // v8.9: per-widget placement — enum + island lean codes + multi-band JS.
  ok(
    /export const PROOF_PLACEMENTS = \[\n  "below_tabs",\n  "above_proof",\n  "below_proof",\n\] as const;/.test(read("app/models/settings.server.ts")),
    "v8.9: PROOF_PLACEMENTS enum is the closed three-placement set",
  );
  for (const section of ["press", "dermEndorsements", "beforeAfter"]) {
    ok(
      proofLiquid.includes(`{% if cfg.${section}.placement == "above_proof" %},"pl":"a"{% elsif cfg.${section}.placement == "below_proof" %},"pl":"b"{% endif %}`),
      `v8.9: ${section} island emits the lean pl placement code`,
    );
  }
  for (const anchor99 of [
    "function pfBandAt(key) {",
    "function pfPlacementKey(conf) {",
    "data-cx-band",
    "if (key === 'above_proof') {",
    "} else if (key === 'below_proof') {",
    "document.querySelector('.cx-proof-stack')",
    "pfMount(name, island, node, conf)",
    // determinism layer (review catches): rank-sorted band runs, the
    // brand-ctx collapse, and the band-aware sibling walk
    "function pfSortBandRun(band) {",
    "var PF_BAND_RANK = { above_proof: 0, below_proof: 1, below_tabs: 2 };",
    "if (!conf || conf.ctx !== 'product') return 'below_tabs';",
    "indexOf('cx-proof-band')",
  ]) {
    ok(proofJs.includes(anchor99), `v8.9: placement anchor present in cellexia-proof.js: ${anchor99}`);
  }
  // the pdp embed's stack insertion is band-aware (preview builds the stack
  // late — it must land above below_proof bands already at the tabs anchor)
  ok(
    read(PDP_JS).includes("getAttribute('data-cx-band') === 'below_proof'"),
    "v8.9: buildProofStack walks back past below_proof bands before inserting the stack",
  );
  ok(
    [...proofJs.matchAll(/pfMount\('(?:press|endorsements|results)', isl\.el, node, isl\.conf\)/g)].length === 3,
    "v8.9: all three widget call sites pass their island conf into pfMount",
  );
  const hubSrc99 = read("app/routes/app.features._index.tsx");
  ok(
    hubSrc99.includes('const PLACEMENT_VALUES = ["below_tabs", "above_proof", "below_proof"] as const;'),
    "v8.9: admin client-safe PLACEMENT_VALUES mirror matches the server enum",
  );
  ok(
    hubSrc99.includes('id="proof-placement"') &&
      hubSrc99.includes('window.location.hash === "#proof-placement"'),
    "v8.9: placement card anchor + hash scroll on the Features page",
  );
  ok(
    read("app/routes/app.proof.tsx").includes('url: "/app/features#proof-placement"'),
    "v8.9: Proof library header links to the placement card",
  );

  // v8.10: press WALL layout — enum + island ly code + wall builder + admin.
  ok(
    /export const PRESS_LAYOUTS = \["featured", "wall"\] as const;/.test(read("app/models/settings.server.ts")),
    "v8.10: PRESS_LAYOUTS enum is the closed two-layout set",
  );
  ok(
    proofLiquid.includes('{% if cfg.press.layout == "wall" %},"ly":"w"{% endif %}'),
    "v8.10: press island emits the lean ly layout code",
  );
  for (const anchor10 of [
    "function pressBuildWall(items, s) {",
    "if (conf.ly === 'w') return pressBuildWall(items, s);",
    "cx-press__wall-card",
    "cx-press__wall-quote",
  ]) {
    ok(proofJs.includes(anchor10), `v8.10: wall anchor present in cellexia-proof.js: ${anchor10}`);
  }
  ok(
    read("app/routes/app.features._index.tsx").includes('const PRESS_LAYOUT_VALUES = ["featured", "wall"] as const;') &&
      read("app/routes/app.features._index.tsx").includes("All quotes visible — compact cards"),
    "v8.10: admin press-layout picker + client-safe mirror present",
  );

  // v8.12: the optional logo switch cue (active-tab indicator, full layout
  // only — behavior pinned by proof-gallery Q-series).
  ok(
    proofLiquid.includes('{% if cfg.press.logoCue == true %},"lc":1{% endif %}'),
    "v8.12: press island emits the lc cue code",
  );
  ok(
    proofJs.includes("var cue = conf.lc === 1 && !ultra && !compact;"),
    "v8.12: the cue applies to the FULL featured layout only",
  );
  ok(
    read(CSS).includes(".cx-press--cue .cx-press__logo[aria-pressed=\"true\"]::after {"),
    "v8.12: the active-logo indicator rule exists",
  );
  ok(
    read("app/routes/app.features._index.tsx").includes("logo switch cue"),
    "v8.12: admin toggle present",
  );

  // v8.11: proof-library translations — schema model, island locale
  // emission, JS locale param, proxy overlay, service allowlist, admin
  // intents. Behavior itself is pinned by sims/proof-translation.ts.
  ok(
    read("prisma/schema.prisma").includes("model ProofTranslation {") &&
      read("prisma/schema.prisma").includes("@@unique([shop, resourceType, resourceId, locale, field])"),
    "v8.11: ProofTranslation model with the composite unique key",
  );
  ok(
    [...proofLiquid.matchAll(/"lo":\{\{request\.locale\.iso_code\|json\}\}/g)].length === 3,
    "v8.11: all three islands emit the page locale",
  );
  ok(
    proofJs.includes("params.locale = conf.lo.toLowerCase();"),
    "v8.11: proof fetches carry the page locale",
  );
  const proxySrc11 = read("app/routes/proxy.proof.tsx");
  ok(
    proxySrc11.includes("getProofTranslationOverlay") &&
      [...proxySrc11.matchAll(/normalizeLocaleParam\(url\.searchParams\.get\("locale"\)\)/g)].length === 3,
    "v8.11: the proxy overlays translations for all three types",
  );
  const ptSvc = read("app/services/proof-translation.server.ts");
  ok(
    ptSvc.includes('press: ["quote"],') &&
      ptSvc.includes('endorsements: ["quote", "credentials"],') &&
      ptSvc.includes('results: ["testimonial"],'),
    "v8.11: the translatable-fields allowlist is exactly prose (names/publications/URLs never translated)",
  );
  for (const route of ["app.proof.press.tsx", "app.proof.endorsements.tsx", "app.proof.results.tsx"]) {
    const tabSrc11 = read(`app/routes/${route}`);
    ok(
      tabSrc11.includes('case "translate_proof": {') &&
        tabSrc11.includes('case "save_translation": {') &&
        tabSrc11.includes("ProofTranslationsSection"),
      `v8.11: ${route} carries the translate intents + per-entry review editor`,
    );
    // v8.12b (merchant catch): the feature's MASTER SWITCH lives where
    // Configure leads — each tab enables/disables its own widget (before
    // this, press/endorsements had NO enable control anywhere except the
    // Markets matrix row).
    ok(
      tabSrc11.includes("const submitFeatureEnabled = (enabled: boolean) => {") &&
        tabSrc11.includes("{featureEnabled ? \"Disable\" : \"Enable\"}"),
      `v8.12b: ${route} carries the feature master switch`,
    );
  }

  // page scope: the embed renders on product + home templates ONLY (the v8
  // design scope) — without this guard an enabled widget would append to
  // cart/blog/search pages' #main too.
  ok(
    proofLiquid.includes("if request.page_type == 'product' or request.page_type == 'index'") &&
      proofLiquid.includes("unless cx_page_ok"),
    "v8.7: proof embed emission is guarded to product + index page types",
  );
  // no admin surface may describe the retired block-placement model
  for (const route of ["app.proof.press.tsx", "app.proof.endorsements.tsx", "app.proof.results.tsx"]) {
    const tabSrc = read(`app/routes/${route}`).replace(/\s+/g, " ");
    ok(
      !/block is placed|place the block|Add block/.test(tabSrc),
      `${route}: no stale block-placement wording`,
    );
  }
  ok(
    !/document\.body\.appendChild\(band\)/.test(proofJs),
    "v8.7: the band is never appended to <body> (fail-closed placement)",
  );
  // (c) Preview Center readiness notes name the EMBED (the surface the
  // merchant was on when the v8.6 block-placement trap hit)
  const previewSvc = read("app/services/preview.server.ts");
  ok(
    previewSvc.includes("Cellexia proof library") &&
      previewSvc.includes("App embeds panel") &&
      previewSvc.includes("even in preview"),
    "preview.server.ts: proofReadiness reasons carry the enable-the-embed warning",
  );
  // (d) Proof library hub banner: enable-the-embed with the real embed name
  // (whitespace-collapsed — JSX line wrapping may split strings)
  const proofHubFlat = read("app/routes/app.proof.tsx").replace(/\s+/g, " ");
  ok(
    proofHubFlat.includes("One-time step: enable the app embed") &&
      proofHubFlat.includes("Cellexia proof library") &&
      proofHubFlat.includes("context=apps"),
    "app.proof.tsx: enable-the-embed Banner with App-embeds deep link present",
  );
  // (e) docs updated + the health check probes the embed
  const updateDoc = read("UPDATE.md");
  ok(
    !updateDoc.includes("Cellexia derm endorsements"),
    'UPDATE.md: the wrong v8 block name "Cellexia derm endorsements" is gone',
  );
  ok(
    updateDoc.includes('app embed is not enabled. Theme editor → App embeds'),
    "UPDATE.md: §6 troubleshooting bullet points at the proof embed",
  );
  ok(
    read("docs/theme-integration.md").includes("STANDING RULE — app embeds ONLY"),
    "theme-integration.md: the embeds-only standing rule is documented",
  );
  ok(
    read("app/services/health.server.ts").includes('detectEmbed(settingsData, "blocks/proof-booster")'),
    "health.server.ts: theme-embeds check probes the proof embed",
  );
}

// ====================================================== 4. CLASS COVERAGE
{
  /**
   * Annotated inherit list: cx-* tokens emitted on purpose WITHOUT a rule
   * in cellexia-booster.css. Every entry must (a) still be emitted and
   * (b) still be unstyled — otherwise the annotation is stale and fails.
   */
  const INHERIT = {
    "cx-batch": "scoping hook on the batch-transparency root; paired with styled cx-proof",
    "cx-azfree__text": "text span inside the azfree message; typography inherited from the theme paragraph",
    "cx-badges__label": "badge label span kept for template parity; typography inherited",
    "cx-bottle__content": "structural wrapper in the empty-bottle modal; children carry the styles",
    "cx-guarantee__content": "structural wrapper (parity with guarantee.liquid markup); children styled",
    "cx-nudge--panel": "variant marker; the panel look lives on .cx-nudge base + theme card styles",
    "cx-nudge__content": "structural wrapper (parity with subscription-nudge.liquid); children styled",
    "cx-preview-bar__label": "preview bar styles itself inline (must render on any theme without our CSS)",
    "cx-stars__star": "SVG star sized by width/height attributes, colored by its gradient fill",
    "cx-survey__panel-verify": "verification paragraph; typography inherited from the survey panel",
    "cx-subswitch__head": "laid out entirely by the theme utility classes it is paired with (d-flex align-center)",
    "cx-offers-more__label": "overflow-toggle label span; typography inherited from the toggle button",
    "cx-azcta-label": "CTA label span inherits the theme button typography; only its hidden cx-azcta-original twin needs CSS",
    "cx-azfree--qualified": "qualified-state marker on the free line (className ternary); the qualified look IS the base cx-azfree style — only the unqualified twin restyles",
    "cx-delivery--cart": "cart surface-variant marker added via className.replace; a JS query hook for the tick refresh — styling rides the base cx-delivery block",
  };

  /**
   * NON-CLASS cx-* literals (v8.2): the pragmatic single-quoted sweep below
   * also matches quoted literals that are NOT class emissions — element /
   * config-island IDs, dynamic id prefixes, one DOM comment marker and one
   * substring guard. Each entry is annotated with what it actually is and
   * is self-checked: it must still appear as a quoted literal in the theme
   * JS (stale entries fail) and must stay UNSTYLED in the CSS (an entry
   * that gains a rule is misclassified and fails until it is moved out).
   * Never park an unresolved CLASS token here — that is what INHERIT is
   * for, and the review-proven self-test below keeps the sweep honest.
   */
  const NON_CLASS_LITERALS = {
    "cx-cart-config": "cart config-island id (getElementById)",
    "cx-pdp-config": "pdp config-island id (getElementById)",
    "cx-az-config": "amazon config-island id (getElementById)",
    "cx-batch-config": "batch config-island id (getElementById)",
    "cx-bottle-config": "bottle config-island id (getElementById)",
    "cx-study-config": "study config-island id (getElementById)",
    "cx-press-config": "press config-island id (pfIsland)",
    "cx-endo-config": "endorsement config-island id (pfIsland)",
    "cx-results-config": "results config-island id (pfIsland)",
    "cx-gcheck": "guarantee-check modal singleton id",
    "cx-gcheck-title": "guarantee-check modal aria-labelledby id",
    "cx-survey-method": "survey methodology panel id (aria-controls)",
    "cx-survey-outcomes": "survey outcomes list id (aria-controls, v8 compact)",
    "cx-az-returns-panel": "returns disclosure panel id (aria-controls)",
    "cx-delivery-tip": "delivery tooltip id (aria-describedby)",
    "cx-proof-lb": "proof lightbox singleton id (v8)",
    "cx-results-drawer": "results filter drawer id (aria-controls)",
    "cx-delivery-tip-cart-": "dynamic tooltip id prefix ('…-' + uid), not a class prefix",
    "cx-offers-overflow-": "dynamic overflow panel id prefix ('…-' + context), not a class prefix",
    "cx-az-order": "DOM comment marker (createComment), not an element class",
    "cx-az-card": "substring guard (cls.indexOf) over the styled cx-az-card* family, not an emission",
    "cx-tpl-pdp-survey": "PROOF_ORDER template id (Liquid mount lookup)",
    "cx-tpl-pdp-study": "PROOF_ORDER template id (Liquid mount lookup)",
    "cx-tpl-pdp-batch": "PROOF_ORDER template id (Liquid mount lookup)",
    "cx-tpl-pdp-bottle": "PROOF_ORDER template id (Liquid mount lookup)",
  };

  // ---- emitted tokens, from class-emission contexts -----------------------
  const tokens = new Set();
  const grab = (str) => {
    for (const t of String(str).split(/\s+/)) {
      if (/^cx-[A-Za-z0-9_-]+$/.test(t)) tokens.add(t);
    }
  };
  for (const f of LIQUID_FILES) {
    const src = read(f);
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      // skip Liquid interpolation fragments; keep plain tokens
      grab(m[1].replace(/\{\{[^}]*\}\}/g, " ").replace(/\{%[^%]*%\}/g, " "));
    }
  }
  const jsSources = new Map();
  for (const jf of [CART_JS, PDP_JS, PROOF_JS]) {
    const src = read(jf);
    jsSources.set(jf, src);
    const contexts = [
      /cxEl\('[a-z0-9]+', *'([^']*)'/g, // cxEl(tag, class, ...)
      /pfEl\('[a-z0-9]+', *'([^']*)'/g, // v8 proof asset's cxEl twin
      /classList\.(?:add|remove|toggle)\('([^']*)'\)/g,
      /className *= *'([^']*)'/g,
      /setAttribute\('class', *'([^']*)'\)/g,
      /\bel\('[a-z0-9]+', *'([^']*)'/g, // preview-bar helper el(tag, class, text)
      /class="([^"]*)"/g, // class attrs inside annotated static SVG strings
      // v8.2 (review-proven blind spot a): class passed through the flat
      // attrs array — cxEl/pfEl(tag, null, ['class', 'cx-…', …]).
      /'class',\s*'([^']+)'/g,
    ];
    for (const re of contexts) {
      for (const m of src.matchAll(re)) grab(m[1]);
    }
    // v8.2 (review-proven blind spots b+c): the emission-context regexes
    // above cannot see string-CONCAT idioms — ternary modifier fragments
    // ('cx-proof cx-survey' + (compact ? ' cx-survey--compact' : '')),
    // className ternaries (open ? '…' : 'cx-endo__card cx-endo__card--open')
    // and dynamic class prefixes ('cx-x--' + value). Pragmatic closure:
    // ALSO treat every single-quoted literal composed SOLELY of optional-
    // space-separated cx-* tokens as emitted. Full-line // comments are
    // stripped first (comments are not emissions — the section-5
    // precedent); non-class literals this sweep drags in (island ids etc.)
    // are handled by the annotated NON_CLASS_LITERALS list above, never by
    // weakening the assert. Trailing-dash tokens ('cx-x--…-') flow into the
    // existing dynamic-prefix rule, closing blind spot (c).
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    for (const m of code.matchAll(/'( ?cx-[A-Za-z0-9_-]+(?: cx-[A-Za-z0-9_-]+)* ?)'/g)) {
      grab(m[1]);
    }
  }
  ok(tokens.size >= 300, `class coverage: extractor sees a real surface (${tokens.size} emitted cx-* tokens)`);

  // ---- self-test: the review-proven tokens can never go invisible again ----
  // The v8 review PROVED the scan was blind to the concat/attrs-array
  // idioms behind these seven tokens (plus the proof-density modifier
  // trios and the className-ternary card--open). If any of them stops
  // being seen — a regex regression, an idiom change — this fails BEFORE
  // the coverage loop can silently pass on an invisible surface.
  const REVIEW_PROVEN_TOKENS = [
    "cx-survey--compact",
    "cx-study--compact",
    "cx-bottle--compact",
    "cx-survey__more-btn",
    "cx-results__chip--on",
    "cx-results__badge--verified",
    "cx-results__badge--lab",
    // v8.3 COMPACT middle-tier modifiers (cm 1 — same concat idiom; these
    // tokens shipped in v8.2 meaning ultra and were REPURPOSED in v8.3)
    "cx-press--compact",
    "cx-endo--compact",
    "cx-results--compact",
    // v8.3 ULTRA modifiers (cm 2 — the renamed v8.2 look, same idiom)
    "cx-press--ultra",
    "cx-endo--ultra",
    "cx-results--ultra",
    // v8 className-ternary idiom
    "cx-endo__card--open",
  ];
  for (const t of REVIEW_PROVEN_TOKENS) {
    ok(tokens.has(t), `class coverage self-test: scan sees the review-proven token ${t}`);
  }

  // ---- styled tokens from the shipped CSS --------------------------------
  const css = read(CSS);
  const styled = new Set([...css.matchAll(/\.(cx-[A-Za-z0-9_-]+)/g)].map((m) => m[1]));
  ok(styled.size >= 200, `class coverage: CSS parse sees a real surface (${styled.size} styled cx-* tokens)`);

  for (const t of tokens) {
    if (styled.has(t)) continue;
    // Annotated non-class literals (ids, prefixes, markers) resolve first —
    // BEFORE the dash rule, because the dynamic ID prefixes end in '-' too.
    if (Object.prototype.hasOwnProperty.call(NON_CLASS_LITERALS, t)) continue;
    if (t.endsWith("-")) {
      // dynamic-suffix prefix (e.g. cx-badges--align- + value): some styled
      // class must carry the prefix, else the modifier family is dead.
      const hit = [...styled].some((s) => s.startsWith(t));
      ok(hit, `class coverage: dynamic prefix ${t}* matches a styled class`);
      continue;
    }
    ok(
      Object.prototype.hasOwnProperty.call(INHERIT, t),
      `class coverage: emitted token styled or annotated: ${t}`,
    );
  }
  for (const [t, reason] of Object.entries(INHERIT)) {
    ok(tokens.has(t), `inherit list live: ${t} still emitted (${reason})`);
    ok(!styled.has(t), `inherit list honest: ${t} still unstyled in CSS`);
  }
  for (const [t, reason] of Object.entries(NON_CLASS_LITERALS)) {
    const stillQuoted = [...jsSources.values()].some((src) => src.includes(`'${t}`));
    ok(stillQuoted, `non-class literal list live: '${t}' still in the theme JS (${reason})`);
    ok(!styled.has(t), `non-class literal list honest: ${t} has no CSS rule (a styled entry is a misclassified class)`);
  }
}

// ============================================ 5. CONFIG-PATH RESOLUTION
{
  // Execute the REAL settings model (prisma stubbed) and capture the
  // serialized emission — the old harness section 16, repo-resident now.
  const out = execFileSync("npx", ["tsx", rp("validation/lib/emit-default-settings.ts")], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const DEF = JSON.parse(out);
  ok(DEF && typeof DEF === "object", "emission: DEFAULT_SETTINGS executed from the live model");

  const resolves = (path) => {
    let node = DEF;
    for (const part of path.split(".")) {
      if (node === null || typeof node !== "object" || !(part in node)) return false;
      node = node[part];
    }
    return true;
  };

  // Paths legitimately absent from DEFAULT_SETTINGS, each pinned to the
  // code that injects them into the metafield emission at write time.
  const INJECTED = {
    preview: { file: "app/services/metafields.server.ts", has: "preview: {" },
  };

  const liquidPaths = new Set();
  for (const f of BLOCKS) {
    for (const m of read(f).matchAll(/\bcfg\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g)) {
      liquidPaths.add(m[1]);
    }
  }
  ok(liquidPaths.size >= 80, `config paths: Liquid read surface visible (${liquidPaths.size} paths)`);
  for (const p of liquidPaths) {
    const top = p.split(".")[0];
    if (INJECTED[top]) {
      ok(
        read(INJECTED[top].file).includes(INJECTED[top].has),
        `config paths: injected member '${top}' still written by ${INJECTED[top].file}`,
      );
      continue;
    }
    ok(resolves(p), `config paths: Liquid cfg.${p} resolves in the real emission`);
  }
  for (const [top, pin] of Object.entries(INJECTED)) {
    ok(liquidPaths.has(top) || [...liquidPaths].some((p) => p.startsWith(`${top}.`)),
      `config paths: injected-member annotation for '${top}' still used by Liquid`);
    void pin;
  }

  // Theme-JS side: every top-level cfg.<key> read by the JS must be emitted
  // as a JSON member by the Liquid that builds its config element.
  // Comments are not reads: full-line // comments are stripped before the
  // scan (v8: the compact-mode comments cite their cfg.<section>.compact
  // settings SOURCES, which the Liquid deliberately compresses into lean
  // "cm" members instead of emitting whole sections — a code read of those
  // paths would still fail here). The proof asset reads islands, not cfg.
  const liquidAll = LIQUID_FILES.map((f) => read(f)).join("\n");
  for (const jf of [CART_JS, PDP_JS]) {
    const src = read(jf).replace(/^\s*\/\/.*$/gm, "");
    const keys = new Set([...src.matchAll(/\bcfg\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
    ok(keys.size >= 10, `config paths: JS read surface visible in ${jf} (${keys.size} keys)`);
    for (const k of keys) {
      ok(liquidAll.includes(`"${k}":`), `config paths: JS cfg.${k} (${jf}) is emitted by the Liquid`);
    }
  }

  // ---- v6.10 draftConfig enum path (shipsFromFormat) ----------------------
  // The az_ships_from display format rides the draftConfig armed-payload
  // convention (dermSurveyFormat/deliveryFormat pattern): validated against
  // the closed enum at BOTH sanitize sites, carried tokenless into the
  // metafield payloads, decoded lean ('s'/'p') by the Liquid + theme JS.
  {
    const settingsSrc = read("app/models/settings.server.ts");
    ok(
      settingsSrc.includes(`SHIPS_FROM_FORMATS = ["subtle", "prominent"] as const`),
      "v6.10: SHIPS_FROM_FORMATS closed enum in the settings model",
    );
    ok(
      settingsSrc.includes("SHIPS_FROM_FORMATS.includes(az.shipsFromFormat as ShipsFromFormat)"),
      "v6.10: sanitizeSettings coerces shipsFromFormat against the enum",
    );
    const previewSrc = read("app/services/preview.server.ts");
    ok(
      previewSrc.includes("out.shipsFromFormat = shipsFromFormat as ShipsFromFormat;"),
      "v6.10: sanitizeDraftConfig admits shipsFromFormat (enum-validated)",
    );
    const metafieldsSrc = read("app/services/metafields.server.ts");
    ok(
      metafieldsSrc.includes("draftConfig.shipsFromFormat = shipsFromFormat;"),
      "v6.10: loadPreviewPayload mirror admits shipsFromFormat (enum-validated)",
    );
    ok(
      DEF.amazon?.shipsFromFormat === "subtle",
      "v6.10: shipsFromFormat defaults to 'subtle' in the real emission",
    );
    const azLiquid = read(`${EXT}/blocks/amazon-booster.liquid`);
    ok(
      azLiquid.includes(`"f": {{ cfg.amazon.shipsFromFormat | slice: 0 | json }}`),
      "v6.10: ships member carries the lean live format code",
    );
    ok(
      azLiquid.includes(`"sf": {{ cx_prev.draftConfig.shipsFromFormat | slice: 0 | json }}`),
      "v6.10: preview member carries the lean draft format code",
    );
    const pdpSrc = read(PDP_JS);
    ok(
      pdpSrc.includes("function azShipsFormat()"),
      "v6.10: azShipsFormat decoder present in the theme JS",
    );
  }

  // ---- v6.11 survey methodology full-text editability ---------------------
  // The "How the survey was conducted" text is fully merchant-editable: the
  // admin Survey page loads the built-in explanation into the editor
  // (BUILT_IN_METHODOLOGY), and BOTH the storefront panel builder and the
  // admin preview substitute the live-number tokens {{ total }} / {{ yes }}
  // / {{ percent }} in merchant text. Three structural guarantees:
  //   (a) the admin constant stays VERBATIM-identical to the extension's
  //       en.default.json survey.methodology_p1..p5 (one source of truth —
  //       drift would make "Edit the built-in text" load stale copy);
  //   (b) the storefront substitution regexes exist in the pdp JS (the
  //       behavior itself is proven by sims/survey-methodology.cjs);
  //   (c) the admin mirrors the exact same three regexes.
  {
    const surveyRoute = read("app/routes/app.features.survey.tsx");
    const enLocale = JSON.parse(read(`${EXT}/locales/en.default.json`));
    const METHODOLOGY_KEYS = ["methodology_p1", "methodology_p2", "methodology_p3", "methodology_p4", "methodology_p5"];
    for (const key of METHODOLOGY_KEYS) {
      const text = enLocale.survey?.[key];
      ok(typeof text === "string" && text.length > 0, `v6.11: en.default.json survey.${key} present`);
    }
    // TRUE verbatim sync: extract the BUILT_IN_METHODOLOGY array literal and
    // compare element-by-element (exactly 5 entries, each character-equal to
    // its locale string). A substring check would let appended sentences, a
    // 6th paragraph or a gutted constant slip through.
    const arrStart = surveyRoute.indexOf("const BUILT_IN_METHODOLOGY = [");
    ok(arrStart !== -1, "v6.11: BUILT_IN_METHODOLOGY constant present in the survey route");
    const arrEnd = surveyRoute.indexOf("];", arrStart);
    ok(arrEnd !== -1, "v6.11: BUILT_IN_METHODOLOGY array literal terminated");
    if (arrStart !== -1 && arrEnd !== -1) {
      const body = surveyRoute.slice(arrStart, arrEnd);
      const literals = [...body.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => JSON.parse(m[0]));
      ok(literals.length === 5, `v6.11: BUILT_IN_METHODOLOGY holds exactly 5 paragraphs (got ${literals.length})`);
      METHODOLOGY_KEYS.forEach((key, i) => {
        ok(
          literals[i] === enLocale.survey?.[key],
          `v6.11: BUILT_IN_METHODOLOGY[${i}] === survey.${key} (verbatim, whole-element)`,
        );
      });
    }
    // The 'question' format's admin hero quote mirrors the same locale
    // string the storefront blockquotes (surveyStr('p3')).
    const qMatch = surveyRoute.match(/const QUESTION_EN =\s*("(?:[^"\\]|\\.)*");/);
    ok(!!qMatch, "v6.11: QUESTION_EN constant extractable from the survey route");
    ok(
      !!qMatch && JSON.parse(qMatch[1]) === enLocale.survey?.methodology_p3,
      "v6.11: QUESTION_EN === survey.methodology_p3 (verbatim admin/locale sync)",
    );
    // The admin preview substitutes RAW digits exactly like the storefront
    // (String(total) — never locale-grouped "1,234"). v7: the survey page is
    // a global-defaults page — the preview runs on labeled EXAMPLE numbers.
    ok(
      surveyRoute.includes("const previewTotal = String(EXAMPLE_TOTAL);") &&
        surveyRoute.includes("const previewYes = String(EXAMPLE_YES);"),
      "v6.11/v7: admin preview numbers are raw digits (storefront parity, no comma grouping)",
    );
    ok(
      !surveyRoute.includes("toLocaleString"),
      "v6.11: no locale-grouped numbers anywhere in the survey admin preview",
    );
    ok(
      surveyRoute.includes('BUILT_IN_METHODOLOGY.join("\\n\\n")'),
      "v6.11: admin loads/normalizes the built-in text via BUILT_IN_METHODOLOGY.join",
    );
    ok(
      surveyRoute.includes("const methodologyToStore ="),
      "v6.11: untouched built-in copy normalizes to \"\" on save (translations preserved)",
    );
    const pdpSrc = read(PDP_JS);
    const TOKEN_REPLACES = [
      ".replace(/\\{\\{\\s*total\\s*\\}\\}/g, String(total))",
      ".replace(/\\{\\{\\s*yes\\s*\\}\\}/g, String(yes))",
      ".replace(/\\{\\{\\s*percent\\s*\\}\\}/g, String(pct))",
    ];
    for (const snippet of TOKEN_REPLACES) {
      ok(pdpSrc.includes(snippet), `v6.11: storefront token substitution present: ${snippet}`);
    }
    for (const token of ["total", "yes", "percent"]) {
      ok(
        surveyRoute.includes(`.replace(/\\{\\{\\s*${token}\\s*\\}\\}/g`),
        `v6.11: admin preview mirrors the {{ ${token} }} substitution`,
      );
    }
  }

  // ---- v6.11 clinical-study desktop alignment -----------------------------
  // Desktop constrains .cx-study to the survey's centered 680px measure
  // (v5.8.3 convention) instead of spanning the full container--md. The
  // override rides CASCADE ORDER (same specificity inside the media query),
  // so the desktop block must appear AFTER the base .cx-study rule.
  {
    const css = read(CSS);
    const desktopRule = "@media (min-width: 750px) {\n  .cx-study {\n    max-width: 680px;\n    margin-inline: auto;\n  }\n}";
    ok(css.includes(desktopRule), "v6.11: .cx-study desktop centered-measure rule present");
    const baseIdx = css.indexOf(".cx-study {\n  border-inline-start");
    ok(baseIdx !== -1, "v6.11: .cx-study base rule still anchored (border-inline-start card)");
    ok(
      baseIdx !== -1 && css.indexOf(desktopRule) > baseIdx,
      "v6.11: desktop rule follows the base rule (cascade-order override)",
    );
  }

  // ---- v7 per-product proof widgets ---------------------------------------
  // The dermatologist survey is PER-PRODUCT (cellexia.product_survey
  // metaobject; content presence = the per-product switch, off until added),
  // one outcomes-forward format — the five v5.8 formats and their
  // draftConfig.dermSurveyFormat preview plumbing are RETIRED. The study
  // gains the product-binding subject line + protocol fact chips; the
  // guarantee headline is "Try it for {{ days }}, completely risk-free"
  // with theme-block copy overrides. Runtime behavior is proven by
  // sims/survey-methodology.cjs; these pins keep the cross-file wiring
  // from silently regressing.
  {
    const pdpLiquid = read(`${EXT}/blocks/pdp-booster.liquid`);
    const pdpSrc = read(PDP_JS);
    // Per-product survey wiring.
    ok(
      pdpLiquid.includes("product.metafields.cellexia.product_survey.value"),
      "v7: survey Liquid reads the per-product metaobject (content-presence gate)",
    );
    ok(
      pdpLiquid.includes('"o": ['),
      "v7: survey island emits the outcome rows member",
    );
    ok(
      !pdpLiquid.includes("dermSurveyFormat") && !pdpLiquid.includes('"surveyFormat"'),
      "v7: the draft survey-format preview member is retired from the Liquid",
    );
    ok(
      pdpSrc.includes("cx-survey__bar-fill") && pdpSrc.includes("'@@YES@@'"),
      "v7: outcomes builder present in the theme JS (bar fill + sentinel labels)",
    );
    ok(
      !pdpSrc.includes("SURVEY_FORMATS") && !pdpSrc.includes("cfg.preview.surveyFormat") && !pdpSrc.includes("buildSurveyDots"),
      "v7: format dispatch + dots machinery retired from the theme JS",
    );
    // Study product binding + protocol facts.
    ok(
      pdpSrc.includes("cx-study__subject") && pdpSrc.includes("cx-study__facts"),
      "v7: study subject line + protocol fact chips present in the theme JS",
    );
    ok(
      /"sub":/.test(pdpLiquid) && /"pn":/.test(pdpLiquid),
      "v7: study island emits the subject + participants members",
    );
    // Guarantee headline + overrides.
    ok(
      pdpLiquid.includes("'bottle.title' | t: days: cx_days_label"),
      "v7: guarantee title interpolates the pluralized days label",
    );
    ok(
      pdpLiquid.includes("bottle_body_override") && pdpLiquid.includes("bottle_point_3_override"),
      "v7: guarantee body/point overrides present in schema + emission",
    );
    const enLocale7 = JSON.parse(read(`${EXT}/locales/en.default.json`));
    ok(
      typeof enLocale7.bottle?.title === "string" && enLocale7.bottle.title.includes("{{ days }}"),
      "v7: bottle.title carries the {{ days }} param",
    );
    ok(
      typeof enLocale7.survey?.outcome_agree === "string" &&
        enLocale7.survey.outcome_agree.includes("@@YES@@") &&
        enLocale7.survey.outcome_agree.includes("@@TOTAL@@"),
      "v7: survey.outcome_agree carries the sentinel tokens",
    );
    for (const gone of ["title_pct", "count", "report_title", "dot_legend", "question_intro"]) {
      ok(
        enLocale7.survey?.[gone] === undefined,
        `v7: retired survey key removed from en.default.json: survey.${gone}`,
      );
    }
    // Draft plumbing retirement in the app.
    const previewSrc = read("app/services/preview.server.ts");
    const metafieldsSrc = read("app/services/metafields.server.ts");
    const previewRoute = read("app/routes/app.preview.tsx");
    ok(
      !previewSrc.includes("dermSurveyFormat") && !metafieldsSrc.includes("dermSurveyFormat"),
      "v7: dermSurveyFormat retired from the preview payload pipeline",
    );
    ok(
      !previewRoute.includes("SURVEY_FORMAT_OPTIONS") && !previewRoute.includes("dermSurveyFormat"),
      "v7: the Preview Center survey-format Select is retired",
    );
    ok(
      previewSrc.includes("readiness.derm_survey = contentReadiness(") &&
        previewSrc.includes("counts?.survey"),
      "v7: derm_survey readiness is content-gated (per-product story)",
    );
    // Server content pipeline anchors.
    const metaobjectsSrc = read("app/services/metaobjects.server.ts");
    ok(
      metaobjectsSrc.includes('"cellexia_product_survey"') && metaobjectsSrc.includes('"cellexia_survey_outcome"'),
      "v7: survey metaobject definitions registered (frozen type names)",
    );
    const translationSrc = read("app/services/translation.server.ts");
    for (const key of ['"question"', '"methodology"', '"subject"']) {
      ok(
        translationSrc.includes(key),
        `v7: translation allowlist admits the ${key} field`,
      );
    }
    // (The "value"-stays-excluded guarantee is behaviorally pinned by
    // sims/translation-service.ts — shouldTranslateField("value") === false.)
  }

  // ---- v8 proof library + compact display modes ---------------------------
  // Hundreds/thousands of proof entries ride three Prisma tables + one
  // CDN-cached app-proxy JSON endpoint; the storefront renderers live in
  // the NEW assets/cellexia-proof.js behind three config-emission-only
  // blocks. The PDP before/after widget retires (the standalone
  // results-gallery block replaces it, same feature key), and the survey /
  // study / guarantee widgets gain LIVE compact display modes. Runtime
  // behavior is proven by sims/proof-gallery.cjs and the
  // survey-methodology.cjs C-series; these pins keep the cross-file
  // wiring from silently regressing.
  {
    // Proxy endpoint + the CDN cache contract (spec §2).
    ok(exists("app/routes/proxy.proof.tsx"), "v8: proxy.proof route present");
    ok(
      read("app/routes/proxy.proof.tsx").includes(`"public, max-age=60, s-maxage=300"`),
      "v8: proxy carries the literal CDN Cache-Control value",
    );
    // Proof-library tables + the exactly-once legacy-import key (spec §1).
    const schemaSrc = read("prisma/schema.prisma");
    for (const model of ["PressItem", "DermEndorsement", "CustomerResult"]) {
      ok(schemaSrc.includes(`model ${model} {`), `v8: prisma schema declares model ${model}`);
    }
    ok(
      /legacyGid\s+String\?\s+@unique/.test(schemaSrc),
      "v8: CustomerResult.legacyGid is the @unique exactly-once import key",
    );
    // Compact display-density settings: typeof-boolean sanitize anchors.
    const settingsSrc8 = read("app/models/settings.server.ts");
    for (const section of ["clinicalStudy", "emptyBottleGuarantee", "dermSurvey"]) {
      ok(
        settingsSrc8.includes(`if (typeof next.${section}.compact !== "boolean") {`),
        `v8: sanitize pins ${section}.compact to typeof-boolean`,
      );
    }
    // New sections + compact flags resolve in the REAL emission.
    for (const p of [
      "press.enabled",
      "dermEndorsements.enabled",
      "dermSurvey.compact",
      "clinicalStudy.compact",
      "emptyBottleGuarantee.compact",
      "marketScopes.press.mode",
      "marketScopes.press.markets",
      "marketScopes.derm_endorsements.mode",
      "marketScopes.derm_endorsements.markets",
    ]) {
      ok(resolves(p), `v8: cfg path resolves in the real emission: ${p}`);
    }
    ok(
      DEF.press?.enabled === false && DEF.dermEndorsements?.enabled === false,
      "v8: press/dermEndorsements arrive OFF by default",
    );
    ok(
      DEF.dermSurvey?.compact === false &&
        DEF.clinicalStudy?.compact === false &&
        DEF.emptyBottleGuarantee?.compact === false,
      "v8: all three compact modes default to the full-height look",
    );
    // The pdp asset arms the proof asset's preview contract (beacon
    // suppression + draft-island admission) on a VERIFIED session only.
    ok(
      read(PDP_JS).includes("window.CellexiaBooster.__preview = true;"),
      "v8: verified preview sets window.CellexiaBooster.__preview for cellexia-proof.js",
    );
    // The three new blocks shipped (section 1's floor already sweeps every
    // blocks/ file; these pins keep a rename/deletion from degrading into
    // a silent directory-listing change).
    ok(
      exists(`${EXT}/blocks/proof-booster.liquid`) &&
        bytesOf(`${EXT}/blocks/proof-booster.liquid`) >= 2000,
      "v8.7: blocks/proof-booster.liquid shipped (>= 2000B — carries all three islands)",
    );
    // Lean compact members in the pdp islands (LIVE settings, == true strict).
    const pdpLiquid8 = read(`${EXT}/blocks/pdp-booster.liquid`);
    for (const gate of ["dermSurvey", "clinicalStudy", "emptyBottleGuarantee"]) {
      ok(
        pdpLiquid8.includes(`{% if cfg.${gate}.compact == true %}, "cm": 1{% endif %}`),
        `v8: island carries the lean compact member off cfg.${gate}.compact`,
      );
    }
    // The retired BA island must STAY retired (the results gallery owns the
    // feature key now — a resurrected island would double-render).
    ok(
      !pdpLiquid8.includes("cx-ba-config"),
      "v8: the #cx-ba-config island emission stays retired from pdp-booster.liquid",
    );
    // v8 locale keys (fixed UI strings; entry content is served as entered).
    const en8 = JSON.parse(read(`${EXT}/locales/en.default.json`));
    ok(
      typeof en8.press?.eyebrow === "string" && en8.press.eyebrow.length > 0,
      "v8: press.eyebrow present in en.default.json",
    );
    ok(
      typeof en8.endo?.count_headline?.other === "string" &&
        en8.endo.count_headline.other.includes("{{ n }}"),
      "v8: endo.count_headline.other carries the {{ n }} param (CLDR pair)",
    );
    ok(
      typeof en8.results?.banner_verified === "string" &&
        en8.results.banner_verified.includes("{{ count }}"),
      "v8: results.banner_verified carries the {{ count }} param",
    );
    ok(
      typeof en8.survey?.more_outcomes === "string" &&
        en8.survey.more_outcomes.includes("@@N@@"),
      "v8: survey.more_outcomes carries the @@N@@ sentinel",
    );

    // ---- v8.1 press market scoping (merchant ask 2026-08-02) --------------
    // Each press item can be limited to selected markets ([] = every
    // market); the storefront sends its market handle, the proxy sanitises
    // it, the service filters server-side — a request WITHOUT a market gets
    // only market-agnostic items, never another market's press.
    const proofSrc8 = read("app/services/proof.server.ts");
    ok(
      proofSrc8.includes("export function parseMarketHandles") &&
        proofSrc8.includes("function cleanMarketHandles"),
      "v8.1: press market-handle parse + clean helpers present",
    );
    ok(
      proofSrc8.includes("return marketHandle !== null && handles.includes(marketHandle);"),
      "v8.1: getPublicPress filters market-limited items server-side",
    );
    const proxySrc8 = read("app/routes/proxy.proof.tsx");
    ok(
      proxySrc8.includes("function normalizeMarketParam") &&
        proxySrc8.includes('normalizeMarketParam(url.searchParams.get("market"))'),
      "v8.1: proxy sanitises + forwards the market param",
    );
    const proofJs8 = read(PROOF_JS);
    ok(
      proofJs8.includes("if (PF_MARKET) pressParams.market = PF_MARKET;"),
      "v8.1: press fetch carries the buyer's market handle",
    );
    const schema8 = read("prisma/schema.prisma");
    ok(
      /model PressItem[\s\S]*?marketHandles String\s+@default\("\[\]"\)/.test(schema8),
      "v8.1: PressItem carries the marketHandles column",
    );
    const pressRoute8 = read("app/routes/app.proof.press.tsx");
    ok(
      pressRoute8.includes("marketHandles: values.marketHandles,") &&
        pressRoute8.includes("parseMarketHandleList(item.marketHandles)"),
      "v8.1: press admin round-trips marketHandles through save + edit",
    );
    const forms8 = read("app/components/ProofForms.tsx");
    ok(
      forms8.includes("export function ItemMarketPicker") &&
        forms8.includes("Leave empty to show the quote without a link."),
      "v8.1: per-item market picker + optional-link helpText in the press form",
    );

    // ---- v8.2-LEGACY ultra-compact booleans + v8.3 three-tier density -----
    // v8.2 gave the three proof-library widgets LIVE compact booleans;
    // v8.3 replaced them with a closed density enum (full | compact |
    // ultra) carried to the storefront as the lean two-code "cm" island
    // member (2 = ultra, 1 = compact, absent = full). The v8.2 booleans
    // stay in the model ONLY as stored-JSON back-compat inputs to the
    // density coercion. Runtime behavior is proven by
    // sims/proof-gallery.cjs (U/C series); these pins keep the
    // settings→island→CSS wiring from silently regressing.
    const settingsFlat = settingsSrc8.replace(/\s+/g, " ");
    ok(
      settingsSrc8.includes(
        `export const PROOF_DENSITIES = ["full", "compact", "ultra"] as const;`,
      ),
      "v8.3: PROOF_DENSITIES is the closed three-tier enum",
    );
    for (const section of ["press", "dermEndorsements", "beforeAfter"]) {
      // Legacy boolean kept + sanitized (the coercion's input).
      ok(
        settingsSrc8.includes(`if (typeof next.${section}.compact !== "boolean") {`),
        `v8.2-LEGACY: sanitize pins ${section}.compact to typeof-boolean`,
      );
      ok(resolves(`${section}.compact`), `v8.2-LEGACY: cfg path resolves in the real emission: ${section}.compact`);
      // v8.3 density enum-check + legacy-boolean coercion in sanitize
      // (whitespace-normalized: prettier wraps the three sections
      // differently).
      ok(
        settingsFlat.includes(`!PROOF_DENSITIES.includes(next.${section}.density as ProofDensity)`),
        `v8.3: sanitize enum-checks ${section}.density against PROOF_DENSITIES`,
      );
      ok(
        settingsFlat.includes(
          `next.${section}.density = next.${section}.compact === true ? "ultra" : "full";`,
        ),
        `v8.3: sanitize coerces an invalid ${section}.density from the v8.2 legacy boolean`,
      );
      ok(resolves(`${section}.density`), `v8.3: cfg path resolves in the real emission: ${section}.density`);
    }
    ok(
      DEF.press?.compact === false &&
        DEF.dermEndorsements?.compact === false &&
        DEF.beforeAfter?.compact === false,
      "v8.2-LEGACY: all three retired booleans still default false (a truthy default would coerce every fresh shop to ultra)",
    );
    ok(
      DEF.press?.density === "full" &&
        DEF.dermEndorsements?.density === "full" &&
        DEF.beforeAfter?.density === "full",
      "v8.3: all three proof densities default to the full v8 look",
    );
    // v8.3 load-path twin of the sanitize coercion: mergeSettings fills a
    // MISSING density key from the defaults, so stored v8.2 JSON would
    // silently merge to "full" and a shop that enabled ultra-compact on
    // v8.2 would lose it. getSettings must run the raw stored JSON through
    // coerceLegacyProofDensities (behaviorally proven by sims/flip-test's
    // settings surface; these anchors keep the wiring visible).
    ok(
      settingsSrc8.includes("function coerceLegacyProofDensities("),
      "v8.3: the load-path density coercion helper exists",
    );
    ok(
      settingsFlat.includes(
        "return coerceLegacyProofDensities( mergeSettings(structuredClone(DEFAULT_SETTINGS), raw), raw, );",
      ),
      "v8.3: getSettings wraps mergeSettings with the coercion, fed the RAW stored JSON",
    );
    ok(
      settingsSrc8.includes("if (PROOF_DENSITIES.includes(stored as ProofDensity)) continue;") &&
        settingsSrc8.includes(
          `settings[key].density = settings[key].compact === true ? "ultra" : "full";`,
        ),
      "v8.3: the helper honors a valid STORED density and otherwise derives from the legacy boolean",
    );
    // Lean two-code density members in the three proof-block islands
    // (LIVE settings, closed-enum string compare — one literal pins both
    // codes AND both density literals per block).
    const CM_ISLANDS = [
      ["proof-booster", "press"],
      ["proof-booster", "dermEndorsements"],
      ["proof-booster", "beforeAfter"],
    ];
    for (const [block, section] of CM_ISLANDS) {
      ok(
        read(`${EXT}/blocks/${block}.liquid`).includes(
          `{% if cfg.${section}.density == "ultra" %}, "cm": 2{% elsif cfg.${section}.density == "compact" %}, "cm": 1{% endif %}`,
        ),
        `v8.3: blocks/${block}.liquid island emits the two-code density member off cfg.${section}.density`,
      );
    }
    // ---- v8.8: dermatologist-survey DESIGNS (three official looks) -----
    // Enum + island lean-code emission + admin mirror + JS dispatch. The
    // designs are presentation-only recompositions of the SAME strings and
    // numbers; classic stays byte-exact (the sim's S-cases pin that) and
    // an unknown sd code falls through to classic (sim D4).
    ok(
      /export const DERM_SURVEY_DESIGNS = \[\n  "classic",\n  "certificate",\n  "dossier",\n  "seal",\n\] as const;/.test(read("app/models/settings.server.ts")),
      "v8.8: DERM_SURVEY_DESIGNS enum is the closed four-design set",
    );
    ok(
      read(`${EXT}/blocks/pdp-booster.liquid`).includes(
        `{% if cfg.dermSurvey.design == "certificate" %}, "sd": "c"{% elsif cfg.dermSurvey.design == "dossier" %}, "sd": "d"{% elsif cfg.dermSurvey.design == "seal" %}, "sd": "s"{% endif %}`,
      ),
      "v8.8: survey island emits the lean sd design code off cfg.dermSurvey.design",
    );
    const surveyAdmin = read("app/routes/app.features.survey.tsx");
    ok(
      surveyAdmin.includes('const DESIGN_VALUES = ["classic", "certificate", "dossier", "seal"] as const;'),
      "v8.8: admin client-safe DESIGN_VALUES mirror matches the server enum (v8.3 lesson — never import the .server VALUE)",
    );
    ok(
      surveyAdmin.includes("design: state.design,") && surveyAdmin.includes("Widget design"),
      "v8.8: survey admin page renders the design picker and saves the field",
    );
    const pdpJs88 = read(PDP_JS);
    for (const anchor88 of [
      "function surveyDesign(d) {",
      "if (sd === 'c') return surveyBuildCertSection(d, rows, total, rec, title);",
      "return surveyBuildSealSection(d, rows, total, rec, title, sver);",
      "function surveyQuestionNode(d, cls) {",
      "function surveyIntroNode(d, cls) {",
      "if (!title && !rec) return null;",
      "surveyBuildDossierSection(d, rows, total, rec, title, dver)",
      "cx-survey--cert",
      "cx-survey--dossier",
      "cx-survey--seal",
      "document.createElementNS(NS, 'circle')",
    ]) {
      ok(pdpJs88.includes(anchor88), `v8.8: survey design anchor present in cellexia-pdp.js: ${anchor88}`);
    }
    // cfg path resolution: the island reads cfg.dermSurvey.design — the
    // section-5 resolver sweep picks it up automatically via the emission,
    // but pin the settings default too (fresh shops must be classic).
    ok(
      read("app/models/settings.server.ts").includes('    design: "classic",'),
      "v8.8: DEFAULT_SETTINGS.dermSurvey.design is classic",
    );

    // The ultra press quote is the ONLY [hidden]-toggled proof element —
    // without this guard the flex display would defeat [hidden] (the
    // v6.8.1 bare-truck-icon lesson). Only ultra ever toggles it; the
    // compact tier keeps the quote permanently visible.
    const css82 = read(CSS);
    ok(
      css82.includes(".cx-press__quote[hidden] {\n  display: none !important;\n}"),
      "v8.2: .cx-press__quote[hidden] display guard present in the CSS",
    );
    // Expanded endorsement quotes render merchant paragraph breaks
    // (pre-line) in EVERY tier; the collapsed clamp is untouched.
    ok(
      /\.cx-endo__card--open \.cx-endo__quote \{[^}]*white-space: pre-line;/.test(css82),
      "v8.2: expanded endorsement quotes keep paragraph breaks (pre-line rule)",
    );
    // v8.3 compact tier: the 2-line quote clamp must lose to expand-in-
    // place — the modifier-scoped override un-clamps --open cards (it
    // sits after the clamp with higher specificity, so the shared
    // pre-line rule above still wins too).
    ok(
      /\.cx-endo--compact \.cx-endo__card--open \.cx-endo__quote \{[^}]*-webkit-line-clamp: none;/.test(css82),
      "v8.3: compact endo expand-in-place un-clamps the 2-line quote (--open override)",
    );
    // v8.3 compact results: the >=900px grid recomposition is suppressed —
    // the rail stays a flex scroll-snap rail on desktop (rail-not-grid).
    ok(
      css82.includes(".cx-results--compact .cx-results__rail {\n    display: flex;\n    grid-template-columns: none;"),
      "v8.3: compact results suppress the desktop grid (flex rail-not-grid >=900px)",
    );
  }
}

// ================================================= 6. ESCAPE DISCIPLINE
{
  // Liquid: any {{ ... }} interpolation inside href=/src= must be escaped
  // or an asset_url. The two merchant-URL sites are pinned so the scan can
  // never rot into matching nothing.
  let sites = 0;
  for (const f of LIQUID_FILES) {
    const src = read(f);
    for (const m of src.matchAll(/\b(href|src)="\{\{([^}]*)\}\}"/g)) {
      sites += 1;
      ok(
        /\|\s*(escape|escape_once|asset_url)\b/.test(m[2]),
        `escape discipline: ${f} ${m[1]}="{{${m[2].trim()}}}" is escaped/asset_url`,
      );
    }
    ok(!/\b(?:href|src)=\{\{/.test(src), `escape discipline: no unquoted href/src interpolation in ${f}`);
  }
  ok(sites >= 5, `escape discipline: interpolated href/src sites visible (${sites})`);
  ok(
    read(`${EXT}/blocks/clinical-results.liquid`).includes("block.settings.cta_url | escape"),
    "escape discipline: clinical CTA merchant URL escaped",
  );
  ok(
    read(`${EXT}/blocks/trustpilot.liquid`).includes("profile_url | escape"),
    "escape discipline: Trustpilot profile merchant URL escaped",
  );

  // Theme JS: innerHTML only at the seven annotated sites — and the v8
  // proof asset holds the line at ZERO (its SVG rides createElementNS and
  // its entity decode is a bounded replace chain): the per-file totals
  // below make the FIRST innerHTML in cellexia-proof.js a build failure.
  const ALLOWED_INNERHTML = [
    { re: /decodeArea\.innerHTML = str;/g, why: "HTML-entity decode trick; result only ever reaches textContent", expect: { [CART_JS]: 1, [PDP_JS]: 1, [PROOF_JS]: 0 } },
    { re: /span\.innerHTML = cxStarsSvgs\(rating, uid, size\);/g, why: "the annotated numeric-stars case (all inputs numeric)", expect: { [CART_JS]: 1, [PDP_JS]: 1, [PROOF_JS]: 0 } },
    { re: /wrap\.innerHTML = '<svg [\s\S]*?';/g, why: "static svg icon constants; only numeric size + static icon-map spec are concatenated", expect: { [CART_JS]: 1, [PDP_JS]: 2, [PROOF_JS]: 0 } },
  ];
  for (const jf of [CART_JS, PDP_JS, PROOF_JS]) {
    const src = read(jf);
    const all = [...src.matchAll(/\.innerHTML *[+]?= */g)].length;
    let allowed = 0;
    for (const rule of ALLOWED_INNERHTML) {
      const n = [...src.matchAll(rule.re)].length;
      ok(
        n === rule.expect[jf],
        `escape discipline: ${jf} has exactly ${rule.expect[jf]} '${rule.why}' innerHTML site(s) (got ${n})`,
      );
      allowed += n;
    }
    ok(
      all === allowed,
      `escape discipline: ${jf} has no innerHTML beyond the annotated sites (total ${all}, annotated ${allowed})`,
    );
    // The static-svg sites may concatenate ONLY the numeric icon `size`
    // and the static icon-map `spec` entries (never config/merchant text).
    for (const m of src.matchAll(/wrap\.innerHTML = ('<svg [\s\S]*?');/g)) {
      const idents = [...m[1].matchAll(/\+ *([A-Za-z_$][\w$]*)/g)].map((x) => x[1]);
      ok(
        idents.every((id) => id === "size" || id === "spec"),
        `escape discipline: static-svg innerHTML concatenates only size/spec in ${jf} (saw: ${idents.join(",") || "none"})`,
      );
    }
  }
}

// ==================================================== 7. SCHEMA NAMES
{
  const LIMIT = 25; // Shopify block-schema name limit
  for (const f of BLOCKS) {
    const src = read(f);
    const m = src.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
    ok(!!m, `schema present in ${f}`);
    if (!m) continue;
    const schema = JSON.parse(m[1]);
    ok(
      typeof schema.name === "string" && schema.name.length <= LIMIT,
      `schema name <= ${LIMIT} chars: ${f} ("${schema.name}" = ${schema.name?.length})`,
    );
  }
}

// ================================================ 8. REACT-RECONCILER PIN
{
  const CHECKOUT_EXTS = ["checkout-delivery", "checkout-protection", "checkout-trust", "checkout-upsell"];
  for (const ext of CHECKOUT_EXTS) {
    const pkg = JSON.parse(read(`extensions/${ext}/package.json`));
    const pin = pkg.dependencies?.["react-reconciler"];
    ok(pin === "^0.29.2", `react-reconciler ^0.29.2 pinned in extensions/${ext} (got ${pin})`);
  }
}

// ==================================================== 9. SUITE INVENTORY
{
  const manifest = JSON.parse(read("validation/suite-manifest.json"));
  ok(Array.isArray(manifest.files) && manifest.files.length >= 20, "suite manifest lists the full inventory");
  for (const entry of manifest.files) {
    const { file, floorBytes, phase } = entry;
    ok(phase === "required" || phase === "pending", `manifest phase valid for ${file}`);
    if (phase === "required") {
      const present = exists(file);
      ok(present, `suite inventory: required file present: ${file}`);
      if (present) {
        ok(
          bytesOf(file) >= floorBytes,
          `suite inventory: ${file} >= ${floorBytes}B floor (got ${bytesOf(file)}B — a hollowed suite is a deleted suite)`,
        );
      }
    } else if (exists(file)) {
      // The ratchet: once a pending suite lands, its manifest entry must be
      // flipped to required in the SAME change, or the build fails here.
      ok(
        false,
        `suite inventory RATCHET: ${file} exists on disk but is still 'pending' in suite-manifest.json — flip it to 'required'`,
      );
    } else {
      console.log(`  pending (not landed yet): ${file}`);
    }
  }
}

// ======================================= 10. v8.4/v8.5 DEPLOY-PROOFING
// Two root-caused production failure classes: (v8.4) a STALE generated client
// missing the v8 proof models ("Cannot read properties of undefined"), and
// (v8.5, found by the 31-agent deploy audit) a client generated from the
// SQLITE dev schema on a Postgres host — which silently runs production
// against a throwaway local dev.sqlite while every check passes. These pins
// keep every countermeasure from regressing.
{
  // (a) v8.5: EVERY Prisma-touching npm script goes through the env-aware
  // selector — bare `prisma generate`/`migrate deploy` in scripts is banned.
  const pkg = JSON.parse(read("package.json"));
  ok(
    pkg.scripts?.build === "node scripts/prisma-env.mjs generate && remix vite:build",
    `v8.5: build script generates via the env-aware selector (got: ${pkg.scripts?.build})`,
  );
  ok(
    pkg.scripts?.postinstall === "node scripts/prisma-env.mjs generate",
    `v8.5: postinstall generates via the env-aware selector (got: ${pkg.scripts?.postinstall})`,
  );
  ok(
    pkg.scripts?.setup === "node scripts/prisma-env.mjs setup",
    `v8.5: setup goes through the selector (db push on Postgres, migrate deploy on SQLite) (got: ${pkg.scripts?.setup})`,
  );
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    ok(
      !/(^|\s)prisma (generate|migrate)/.test(cmd),
      `v8.5: npm script "${name}" does not call prisma generate/migrate directly (selector-only rule): ${cmd}`,
    );
  }
  const selector = read("scripts/prisma-env.mjs");
  for (const anchor of [
    'const SQLITE_SCHEMA = "prisma/schema.prisma";',
    'const POSTGRES_SCHEMA = "prisma/schema.postgres.prisma";',
    "/^postgres(ql)?:\\/\\//.test(url)",
    "process.env.PRISMA_SCHEMA",
    ".generated-client.json",
    'run(["db", "push", "--schema", schema])',
    'run(["migrate", "deploy", "--schema", schema])',
  ]) {
    ok(selector.includes(anchor), `v8.5: selector anchor present: ${anchor}`);
  }

  // (a2) v8.5: wrong-database boot guard in db.server.ts — refuses to start
  // a Postgres-configured host on a sqlite-generated client, and passes
  // DATABASE_URL as datasourceUrl so unmarked mismatches fail loud too.
  const dbSrc = read("app/db.server.ts");
  for (const anchor of [
    'readFileSync("prisma/.generated-client.json"',
    "/^postgres(ql)?:\\/\\//.test(DATABASE_URL)",
    'provider !== null && provider !== "postgresql"',
    "silently run against a local SQLite file",
    "new PrismaClient({ datasourceUrl: DATABASE_URL })",
  ]) {
    ok(dbSrc.includes(anchor), `v8.5: db.server.ts boot-guard anchor present: ${anchor}`);
  }

  // (b) v8.4: every proof-library entry funnel asserts the models exist and
  // otherwise throws the actionable message (now v8.5-flow wording).
  const proofSrc = read("app/services/proof.server.ts");
  ok(
    proofSrc.includes("export function assertProofModels(): void {"),
    "v8.4: assertProofModels guard defined in proof.server.ts",
  );
  for (const anchor of [
    '"pressItem", "dermEndorsement", "customerResult"',
    "generated BEFORE the v8 schema",
    "a one-off shell run on the host does NOT persist",
    "auto-selects the right schema from DATABASE_URL",
    "prisma/schema.postgres.prisma",
  ]) {
    ok(proofSrc.includes(anchor), `v8.4: guard message anchor present: ${anchor}`);
  }
  const guardCalls = [...proofSrc.matchAll(/^ {2}assertProofModels\(\);$/gm)].length;
  ok(
    guardCalls >= 11,
    `v8.4: guard wired into the entry funnels — 3 list* + 3 save* + 3 getPublic* + import + delegateFor (found ${guardCalls} call sites, need >= 11)`,
  );

  // (c) health check #12: stale client vs missing tables vs (v8.5) WRONG
  // DATABASE — three failure modes, three distinct fixes.
  const healthSrc = read("app/services/health.server.ts");
  ok(
    healthSrc.includes('runCheck("proof-database", "Proof library database"'),
    "v8.4: proof-database health check defined",
  );
  const healthWired = [...healthSrc.matchAll(/checkProofDatabase\(\),/g)].length;
  ok(
    healthWired === 2,
    `v8.4: proof-database check wired into BOTH orchestrator paths (found ${healthWired}, need 2 — Promise.all list + settings-crash fallback)`,
  );
  ok(
    healthSrc.includes("does NOT persist into the running service"),
    "v8.4: stale-client fixHint carries the shell-run-does-not-persist warning",
  );
  ok(
    healthSrc.includes("the bundled migrations are SQLite-dialect"),
    "v8.4: missing-tables fixHint steers Postgres to db push (SQLite-dialect migrations warning)",
  );
  for (const anchor of [
    'await prisma.$queryRawUnsafe("select sqlite_version()")',
    "WRONG DATABASE: DATABASE_URL points at Postgres",
    'wantsPostgres && engine === "sqlite"',
  ]) {
    ok(healthSrc.includes(anchor), `v8.5: wrong-database engine probe anchor present: ${anchor}`);
  }

  // (d) schema twin parity: schema.postgres.prisma must be schema.prisma with
  // ONLY the datasource block swapped (postgresql + env("DATABASE_URL")).
  // Recompute the expected twin from schema.prisma and diff — drift = failure.
  const dev = read("prisma/schema.prisma");
  const twin = read("prisma/schema.postgres.prisma");
  const expected = dev
    .replace('provider = "sqlite"', 'provider = "postgresql"')
    .replace('url      = "file:dev.sqlite"', 'url      = env("DATABASE_URL")');
  ok(expected !== dev, "v8.4: twin transformation matched the dev datasource block (schema.prisma still SQLite)");
  const body = twin.slice(twin.indexOf("generator client"));
  ok(
    body === expected,
    "v8.4: schema.postgres.prisma is schema.prisma with only the datasource swapped (twin has drifted — regenerate it from schema.prisma)",
  );
  ok(
    twin.startsWith("// PRODUCTION (Postgres) twin of schema.prisma"),
    "v8.4: twin header identifies it as generated-from-schema.prisma",
  );

  // (e) docs steer the dev to all of the above — UPDATE.md and INSTALL.md
  // must both describe the v8.5 flow (the audit caught INSTALL.md still
  // teaching the banned hand-patch + migrate-deploy-on-Postgres path).
  const updateMd = read("UPDATE.md");
  for (const anchor of [
    "npx prisma db push --schema prisma/schema.postgres.prisma",
    "does NOT\n> persist into the running service",
    "Proof library database",
    "scripts/prisma-env.mjs",
    "refuses to boot",
    "automatically_update_urls_on_dev = false",
    "shopify.app.toml.example",
  ]) {
    ok(updateMd.includes(anchor), `v8.5: UPDATE.md deploy-guidance anchor present: ${JSON.stringify(anchor)}`);
  }
  const installMd = read("INSTALL.md");
  for (const anchor of [
    "npx prisma db push --schema prisma/schema.postgres.prisma",
    "scripts/prisma-env.mjs",
    "never run `prisma migrate deploy` against Postgres",
    "FOUR Cellexia blocks",
    "cp shopify.app.toml.example shopify.app.toml",
  ]) {
    ok(installMd.includes(anchor), `v8.5: INSTALL.md deploy-guidance anchor present: ${JSON.stringify(anchor)}`);
  }
  ok(
    !installMd.includes('change the datasource to `provider = "postgresql"`'),
    "v8.5: INSTALL.md no longer teaches the hand-patch flow",
  );

  // (f) v8.5: Dockerfile must copy prisma/ + scripts/ BEFORE npm ci (the
  // postinstall hook needs both) — order-sensitive, audit-proven failure.
  const dockerfile = read("Dockerfile");
  const ciAt = dockerfile.indexOf("RUN npm ci");
  ok(ciAt !== -1, "v8.5: Dockerfile still installs with npm ci");
  ok(
    dockerfile.indexOf("COPY prisma ./prisma") !== -1 &&
      dockerfile.indexOf("COPY prisma ./prisma") < ciAt &&
      dockerfile.indexOf("COPY scripts ./scripts") !== -1 &&
      dockerfile.indexOf("COPY scripts ./scripts") < ciAt,
    "v8.5: Dockerfile copies prisma/ and scripts/ before npm ci (postinstall needs them)",
  );

  // (g) v8.5: dev-session safety + supported API version pins. The REAL
  // shopify.app.toml is deliberately ABSENT from shipped ZIPs (so an
  // unzip-over can never clobber production config) and, when present, may
  // carry the dev's linked production values — so the ALWAYS-pinned file is
  // the .example template; the real toml is checked only while it is still
  // our unlinked template (empty client_id).
  ok(exists("shopify.app.toml.example"), "v8.5: shopify.app.toml.example template ships in-tree");
  const exampleToml = read("shopify.app.toml.example");
  ok(
    exampleToml.includes("automatically_update_urls_on_dev = false"),
    "v8.5: .example template pins automatically_update_urls_on_dev = false (dev must never repoint live URLs)",
  );
  ok(
    exampleToml.includes('api_version = "2025-10"'),
    "v8.5: .example template pins webhooks api_version 2025-10 (newest the installed dependency line supports)",
  );
  if (exists("shopify.app.toml")) {
    const appToml = read("shopify.app.toml");
    if (/client_id = ""/.test(appToml)) {
      ok(
        appToml.includes("automatically_update_urls_on_dev = false") &&
          appToml.includes('api_version = "2025-10"'),
        "v8.5: the in-tree template shopify.app.toml matches the .example safety settings",
      );
    } else {
      console.log("  shopify.app.toml is linked to a real app — template pins checked on the .example only");
    }
  } else {
    console.log("  shopify.app.toml absent (shipped-ZIP layout) — template pins checked on the .example");
  }
  ok(
    read("app/shopify.server.ts").includes("ApiVersion.October25"),
    "v8.5: server apiVersion pinned to ApiVersion.October25 in shopify.server.ts",
  );
}

// ===================================== v8.13 PRODUCT DISPLAY NAMES
{
  // (a) Translatable cellexia.display_name product metafield definition.
  const metaSrc = read("app/services/metaobjects.server.ts");
  ok(
    metaSrc.includes('displayName: "display_name"'),
    "v8.13: PDP_METAFIELD_KEYS carries displayName -> display_name",
  );
  ok(
    metaSrc.includes('"Cellexia display name"') &&
      metaSrc.includes("single_line_text_field"),
    "v8.13: display_name metafield definition present (single_line_text_field)",
  );

  // (b) Liquid: cx_pname derivation + ALL name interpolations use it. The
  // negative pin means a future edit can't quietly reintroduce the raw
  // title into a sentence the merchant localized.
  const pdpLiquid = read(`${EXT}/blocks/pdp-booster.liquid`);
  ok(
    pdpLiquid.includes(
      "assign cx_pname = product.metafields.cellexia.display_name.value | default: product.title",
    ),
    "v8.13: pdp-booster.liquid derives cx_pname from display_name with title fallback",
  );
  // Review v8.13 F6: the assign originally sat INSIDE the survey gate, so
  // the study-only path interpolated an undefined name ("Tested on  itself").
  // Pin the assign UNCONDITIONAL: before the first feature gate of the block.
  const pnameAssignAt = pdpLiquid.indexOf("assign cx_pname");
  const firstGateAt = pdpLiquid.indexOf("if cfg.dermSurvey.enabled");
  ok(
    pnameAssignAt !== -1 && firstGateAt !== -1 && pnameAssignAt < firstGateAt,
    "v8.13: cx_pname assigned unconditionally BEFORE the survey gate (study/preview paths need it too)",
  );
  const pnameUses = (pdpLiquid.match(/product: cx_pname/g) ?? []).length;
  ok(
    pnameUses === 3,
    `v8.13: exactly 3 'product: cx_pname' interpolations in pdp-booster.liquid (got ${pnameUses})`,
  );
  ok(
    !pdpLiquid.includes("product: product.title"),
    "v8.13: no raw 'product: product.title' interpolation remains in pdp-booster.liquid",
  );

  // (c) Service anchors: native Shopify translation machinery on the
  // metafield GID (register with digest, remove by locale, delete-on-blank).
  const nameSrc = read("app/services/product-names.server.ts");
  for (const anchor of [
    "translationsRegister(resourceId: $id, translations: $translations)",
    "translationsRemove(resourceId: $id, locales: $locales",
    "translatableContentDigest: digest",
    "metafieldsDelete(metafields: [$input])",
    'type: "single_line_text_field"',
  ]) {
    ok(nameSrc.includes(anchor), `v8.13: product-names.server.ts anchor: ${anchor}`);
  }

  // (d) Admin page wired to the service + nav tab present.
  const pageSrc = read("app/routes/app.product-names.tsx");
  ok(
    pageSrc.includes('case "load_names"') &&
      pageSrc.includes('case "save_names"') &&
      pageSrc.includes("saveProductDisplayName(admin, gid, baseName, perLocale)"),
    "v8.13: Product names page wires load/save intents to the service",
  );
  ok(
    read("app/routes/app.tsx").includes(
      '<Link to="/app/product-names">Product names</Link>',
    ),
    "v8.13: NavMenu carries the Product names tab",
  );

  // (e) NEVER machine-translated: the DeepL metafield allowlist stays
  // closed to display_name. Doc contract pinned positively; the function
  // BODY (comment excluded — slice starts at the export line) must never
  // mention display_name in any casing.
  const trSrc = read("app/services/translation.server.ts");
  ok(
    trSrc.includes(
      "cellexia.display_name metafield (v8.13 product display names) must NEVER",
    ),
    "v8.13: collectAllowedMetafieldGids doc pins the display_name exclusion",
  );
  const fnStart = trSrc.indexOf("export function collectAllowedMetafieldGids");
  const fnEnd = trSrc.indexOf("\n}", fnStart);
  const fnBody = fnStart === -1 ? "" : trSrc.slice(fnStart, fnEnd);
  ok(
    fnStart !== -1 &&
      fnEnd !== -1 &&
      !fnBody.includes("display_name") &&
      !fnBody.toLowerCase().includes("displayname"),
    "v8.13: collectAllowedMetafieldGids body admits no display_name GID",
  );
}

finish();
