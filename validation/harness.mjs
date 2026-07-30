/**
 * Structural harness — the tripwire suite. Rebuilt repo-resident after the
 * scratchpad wipe; every section is self-checking against vacuity (a check
 * that can no longer see its subject FAILS instead of passing silently).
 *
 * Sections:
 *   1. Liquid byte budget — total <= 95,000 (own budget under the 102,400
 *      Shopify theme-app-extension cap) + per-file floor/ceiling sanity.
 *   2. PREVIEW COVERAGE — FEATURE_KEYS parsed LIVE from settings.server.ts
 *      (31 keys); every key mapped to verified evidence in a real file
 *      (storefront data-cx-feature markers / checkout extension gates /
 *      documented alias), both directions (no unmapped key, no stale map).
 *   3. PICKER COVERAGE — every key present in app.preview.tsx
 *      FEATURE_GROUPS, app.features._index.tsx GROUPS and CONFIGURE_URL;
 *      fallback-group code still present in both routes.
 *   4. CLASS COVERAGE — every cx-* class token emitted by BOTH theme JS
 *      files and ALL .liquid files is styled in cellexia-booster.css,
 *      resolves as a dynamic prefix, or sits in the annotated inherit
 *      list (whose entries must stay emitted and stay unstyled).
 *   5. CONFIG-PATH RESOLUTION — executes the real settings.server.ts
 *      (npx tsx, prisma stubbed) and proves every cfg.* path read by the
 *      Liquid blocks resolves in the serialized DEFAULT_SETTINGS emission
 *      (documented exception: `preview`, injected at metafield-write time
 *      by metafields.server.ts — its injection site is pinned too), and
 *      every top-level cfg.<key> the theme JS reads is emitted as a JSON
 *      key by the Liquid.
 *   6. ESCAPE DISCIPLINE — no unescaped merchant value reaches href/src in
 *      Liquid; innerHTML in theme JS only at the seven annotated sites
 *      (entity-decoder, numeric-stars, static-svg-icon).
 *   7. SCHEMA NAMES — every {% schema %} name <= 25 chars (Shopify limit).
 *   8. REACT-RECONCILER — ^0.29.2 pinned in all 4 checkout extensions.
 *   9. SUITE INVENTORY — validation/suite-manifest.json enforced: required
 *      files exist above their byte floors (a deleted or hollowed suite
 *      fails the build); a pending file that has landed on disk MUST be
 *      flipped to required in the manifest (the ratchet).
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
ok(FEATURE_KEYS.length === 31, `FEATURE_KEYS parsed live: 31 keys (got ${FEATURE_KEYS.length})`);

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
  verified_before_after: [{ file: PDP_JS, has: MARK("verified_before_after") }],
  batch_transparency: [{ file: PDP_JS, has: MARK("batch_transparency") }],
  empty_bottle_guarantee: [{ file: PDP_JS, has: MARK("empty_bottle_guarantee") }],
  derm_survey: [{ file: PDP_JS, has: MARK("derm_survey") }],
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
}

// ====================================================== 4. CLASS COVERAGE
{
  /**
   * Annotated inherit list: cx-* tokens emitted on purpose WITHOUT a rule
   * in cellexia-booster.css. Every entry must (a) still be emitted and
   * (b) still be unstyled — otherwise the annotation is stale and fails.
   */
  const INHERIT = {
    "cx-ba": "scoping hook on the before/after root; visual style comes from the paired cx-proof class",
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
    "cx-survey__seal-body": "structural wrapper inside the survey seal; children styled",
    "cx-subswitch__head": "laid out entirely by the theme utility classes it is paired with (d-flex align-center)",
    "cx-offers-more__label": "overflow-toggle label span; typography inherited from the toggle button",
    "cx-azcta-label": "CTA label span inherits the theme button typography; only its hidden cx-azcta-original twin needs CSS",
  };

  // ---- emitted tokens, from class-emission contexts only ----------------
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
  for (const jf of [CART_JS, PDP_JS]) {
    const src = read(jf);
    const contexts = [
      /cxEl\('[a-z0-9]+', *'([^']*)'/g, // cxEl(tag, class, ...)
      /classList\.(?:add|remove|toggle)\('([^']*)'\)/g,
      /className *= *'([^']*)'/g,
      /setAttribute\('class', *'([^']*)'\)/g,
      /\bel\('[a-z0-9]+', *'([^']*)'/g, // preview-bar helper el(tag, class, text)
      /class="([^"]*)"/g, // class attrs inside annotated static SVG strings
    ];
    for (const re of contexts) {
      for (const m of src.matchAll(re)) grab(m[1]);
    }
  }
  ok(tokens.size >= 150, `class coverage: extractor sees a real surface (${tokens.size} emitted cx-* tokens)`);

  // ---- styled tokens from the shipped CSS --------------------------------
  const css = read(CSS);
  const styled = new Set([...css.matchAll(/\.(cx-[A-Za-z0-9_-]+)/g)].map((m) => m[1]));
  ok(styled.size >= 200, `class coverage: CSS parse sees a real surface (${styled.size} styled cx-* tokens)`);

  for (const t of tokens) {
    if (styled.has(t)) continue;
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
}

// ============================================ 5. CONFIG-PATH RESOLUTION
{
  // Execute the REAL settings model (prisma stubbed) and capture the
  // serialized emission — the old harness section 16, repo-resident now.
  const out = execFileSync("npx", ["tsx", rp("validation/lib/emit-default-settings.ts")], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
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
  const liquidAll = LIQUID_FILES.map((f) => read(f)).join("\n");
  for (const jf of [CART_JS, PDP_JS]) {
    const src = read(jf);
    const keys = new Set([...src.matchAll(/\bcfg\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
    ok(keys.size >= 10, `config paths: JS read surface visible in ${jf} (${keys.size} keys)`);
    for (const k of keys) {
      ok(liquidAll.includes(`"${k}":`), `config paths: JS cfg.${k} (${jf}) is emitted by the Liquid`);
    }
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

  // Theme JS: innerHTML only at the seven annotated sites.
  const ALLOWED_INNERHTML = [
    { re: /decodeArea\.innerHTML = str;/g, why: "HTML-entity decode trick; result only ever reaches textContent", expect: { [CART_JS]: 1, [PDP_JS]: 1 } },
    { re: /span\.innerHTML = cxStarsSvgs\(rating, uid, size\);/g, why: "the annotated numeric-stars case (all inputs numeric)", expect: { [CART_JS]: 1, [PDP_JS]: 1 } },
    { re: /wrap\.innerHTML = '<svg [\s\S]*?';/g, why: "static svg icon constants; only numeric size + static icon-map spec are concatenated", expect: { [CART_JS]: 1, [PDP_JS]: 2 } },
  ];
  for (const jf of [CART_JS, PDP_JS]) {
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

finish();
