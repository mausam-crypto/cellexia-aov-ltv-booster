#!/usr/bin/env node --experimental-strip-types
/**
 * validation/sims/checkout-trust.ts — checkout trust module V2 sim (v9).
 *
 * Behavior-tests the extension's PURE logic module
 * extensions/checkout-trust/src/trust-logic.ts (config resolution, preview
 * resolution, the per-market gates, the preview diagnosis and the compact
 * tracked-date formatter) with REAL Intl, plus the structural contracts the
 * React component cannot be executed for:
 *
 *  T1 ENGINE TWIN — extensions/checkout-trust/src/delivery-engine.ts must be
 *     BYTE-IDENTICAL to checkout-delivery's engine (whole-file compare, the
 *     strongest twin pin), and the trust copy must actually compute (one
 *     fixed-clock computeDelivery probe), so the tracked row can never
 *     promise a date the delivery guarantee would not.
 *  T2 TRUST LOGIC — resolveConfig safe defaults (v9 rows OFF unless an
 *     explicit true; a pre-V2 config renders byte-identically), enabled
 *     requires explicit true, clamps, resolvePreview inertness,
 *     isAllowedInMarket fail-closed matrix, diagnosis ordering.
 *  T3 COMPACT DATE — trustFormatDateCompact vs an INDEPENDENT
 *     Intl.DateTimeFormat expectation (different API path) across all 18
 *     checkout languages × the shared fixture stamps; fr 1er rule; ja/de/el
 *     hard expectations; the short-form fallback chain.
 *  T4 LOCALES — the 18 checkout-trust locale files: key parity, required
 *     placeholders, the V2 copy contract (no "SSL" anywhere, the en
 *     wording verbatim), nb byte-equals no, per-file byte budget.
 *  T5 COMPONENT PINS — structural anchors in Checkout.tsx: the row gates
 *     compose flag AND own-market-scope AND draft grant, the tracked row
 *     uses the GUARANTEED max date, fails closed on an empty label, the
 *     v10 typed provinceCode threads into the engine resolve, and the two
 *     new translate keys ride the right params.
 *
 * The trust-logic SOURCE path honors CX_SIM_SRC — lib/mutants.cjs feeds
 * mutant copies through the same loader (tsx-shim.cjs carries this .ts
 * suite, the proof-server convention). Offline, deterministic, node-only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readSource } from "../lib/extract.mjs";
import { fixtureStamps } from "../lib/native-dates-gen.mjs";

// Local tap in the mutation-compatible output format: lib/mutants.cjs counts
// a catch as semantic ONLY on a "FAIL: " line or an "N/M CHECKS FAILED"
// trailer (lib/extract.mjs makeTap prints neither — its "FAIL  label" /
// "n of m checks FAILED" shapes are invisible to the mutation harness).
function makeMutationTap(name: string) {
  let checks = 0;
  let failures = 0;
  return {
    check(label: string, cond: boolean, note?: string) {
      checks++;
      if (!cond) {
        failures++;
        console.error(`FAIL: ${label}${note ? " — " + note : ""}`);
      }
    },
    eq(label: string, got: unknown, want: unknown) {
      this.check(
        label,
        got === want,
        "got=" + JSON.stringify(got) + " want=" + JSON.stringify(want),
      );
    },
    finish() {
      if (checks === 0) {
        console.error(`FAIL: ${name} executed zero checks (vacuous run)`);
        process.exit(1);
      }
      if (failures > 0) {
        console.error(`\n${failures}/${checks} CHECKS FAILED`);
        process.exit(1);
      }
      console.log(`ALL ${checks} CHECKS PASSED (${name})`);
    },
  };
}

const tap = makeMutationTap("checkout-trust");
const UT = Date.UTC;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const require2 = createRequire(import.meta.url);

const REAL_SRC = path.join(
  ROOT,
  "extensions",
  "checkout-trust",
  "src",
  "trust-logic.ts",
);
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;

/** Loads trust-logic from SRC_PATH via a .gen .ts copy so mutant copies
 *  (written with a .js basename by mutants.cjs) still load as TypeScript.
 *  Mutant child runs write a SEPARATE basename so the repo-resident
 *  trust-logic.real.ts never ends up carrying a mutant's source. */
async function loadTrustLogic(): Promise<any> {
  const src = fs.readFileSync(SRC_PATH, "utf8");
  const genDir = path.join(ROOT, "validation", "lib", ".gen");
  fs.mkdirSync(genDir, { recursive: true });
  const outPath = path.join(
    genDir,
    process.env.CX_SIM_SRC ? "trust-logic.mutant.ts" : "trust-logic.real.ts",
  );
  if (!fs.existsSync(outPath) || fs.readFileSync(outPath, "utf8") !== src) {
    fs.writeFileSync(outPath, src);
  }
  return await import(pathToFileURL(outPath).href);
}

const L = await loadTrustLogic();

// ------------------------------------------------------------ T1 engine twin
{
  const trustEngine = readSource(
    "extensions/checkout-trust/src/delivery-engine.ts",
  );
  const deliveryEngine = readSource(
    "extensions/checkout-delivery/src/delivery-engine.ts",
  );
  tap.check(
    "T1: delivery-engine.ts twin is BYTE-IDENTICAL across the two checkout extensions",
    trustEngine === deliveryEngine,
    "the tracked row and the delivery block must share one date engine — re-copy the file",
  );
  const E = await import(
    pathToFileURL(
      path.join(ROOT, "extensions", "checkout-trust", "src", "delivery-engine.ts"),
    ).href
  );
  const dc = E.resolveDeliveryConfig(
    {
      deliveryEstimate: {
        minDays: 2,
        maxDays: 4,
        deliveryDays: [1, 2, 3, 4, 5],
        holidaysEnabled: true,
      },
      dispatch: { cutoff: "14:00", timezone: "Europe/Paris", days: [1, 2, 3, 4, 5] },
    },
    "FR",
  );
  tap.check("T1: trust twin resolves a valid config", dc !== null);
  // Wed 2026-07-22 10:00 Paris (pre-cutoff dispatch day) -> dispatch same
  // day, min +2 business days = Fri Jul 24, max +4 = Tue Jul 28.
  const result = E.computeDelivery(dc, new Date(Date.UTC(2026, 6, 22, 8, 0)));
  tap.check(
    "T1: trust twin computes the shared fixture scenario",
    result !== null &&
      result.dispatch === UT(2026, 6, 22) &&
      result.min === UT(2026, 6, 24) &&
      result.max === UT(2026, 6, 28),
    "got=" + JSON.stringify(result),
  );
}

// ------------------------------------------------------------ T2 trust logic
{
  // resolveConfig: safe defaults all the way down.
  const dflt = L.resolveConfig(undefined);
  tap.check("T2: no config -> module OFF", dflt.checkoutTrust.enabled === false);
  tap.check(
    "T2: no config -> v9 rows OFF",
    dflt.checkoutTrust.showCustoms === false && dflt.checkoutTrust.showTracked === false,
  );
  tap.check(
    "T2: no config -> legacy rows keep their pre-V2 defaults",
    dflt.checkoutTrust.showGuarantee === true &&
      dflt.checkoutTrust.showTrustpilot === true &&
      dflt.checkoutTrust.showClinical === false &&
      dflt.checkoutTrust.showBadges === true,
  );

  // A pre-V2 config (five-flag shape, no row keys) must resolve rows OFF —
  // the upgrade renders byte-identically until the merchant opts in.
  const preV2 = L.resolveConfig({
    checkoutTrust: { enabled: true, showGuarantee: true, showTrustpilot: false },
  });
  tap.check("T2: pre-V2 config -> module on, rows OFF",
    preV2.checkoutTrust.enabled === true &&
      preV2.checkoutTrust.showCustoms === false &&
      preV2.checkoutTrust.showTracked === false);

  // Explicit true is the ONLY way a row turns on.
  for (const bad of ["yes", 1, null, [], {}, "true"]) {
    const cfg = L.resolveConfig({
      checkoutTrust: { enabled: true, showCustoms: bad, showTracked: bad },
    });
    tap.check(
      `T2: non-boolean row flag (${JSON.stringify(bad)}) -> rows OFF`,
      cfg.checkoutTrust.showCustoms === false && cfg.checkoutTrust.showTracked === false,
    );
  }
  const rowsOn = L.resolveConfig({
    checkoutTrust: { enabled: true, showCustoms: true, showTracked: true },
  });
  tap.check("T2: explicit true turns the rows on",
    rowsOn.checkoutTrust.showCustoms === true && rowsOn.checkoutTrust.showTracked === true);

  // v11 rowOrder: resolveConfig ALWAYS yields a full permutation of the six
  // row keys — ordering can reshuffle rows, never hide/double/reveal one.
  const DEFAULT_ORDER = ["badges", "guarantee", "customs", "tracked", "clinical", "trustpilot"];
  const orderOf = (root: unknown): string =>
    JSON.stringify(L.resolveConfig(root).checkoutTrust.rowOrder);
  tap.check("T2: TRUST_ROW_ORDER_DEFAULT is the pre-v11 hardcoded render order",
    JSON.stringify([...L.TRUST_ROW_ORDER_DEFAULT]) === JSON.stringify(DEFAULT_ORDER));
  tap.check("T2: no config -> default row order",
    JSON.stringify(dflt.checkoutTrust.rowOrder) === JSON.stringify(DEFAULT_ORDER));
  tap.check("T2: pre-v11 config (no rowOrder key) -> default row order (byte-identical upgrade)",
    JSON.stringify(preV2.checkoutTrust.rowOrder) === JSON.stringify(DEFAULT_ORDER));
  const fullCustom = ["trustpilot", "clinical", "tracked", "customs", "guarantee", "badges"];
  tap.check("T2: full custom permutation honored verbatim",
    orderOf({ checkoutTrust: { rowOrder: fullCustom } }) === JSON.stringify(fullCustom));
  tap.check("T2: partial order -> listed rows first, missing rows appended in default order",
    orderOf({ checkoutTrust: { rowOrder: ["clinical", "badges"] } }) ===
      JSON.stringify(["clinical", "badges", "guarantee", "customs", "tracked", "trustpilot"]));
  tap.check("T2: unknown keys drop + duplicates dedupe",
    orderOf({ checkoutTrust: { rowOrder: ["clinical", "amazon", "clinical", 7, null, "badges"] } }) ===
      JSON.stringify(["clinical", "badges", "guarantee", "customs", "tracked", "trustpilot"]));
  for (const bad of ["badges", 7, null, {}]) {
    tap.check(`T2: non-array rowOrder (${JSON.stringify(bad)}) -> default order`,
      orderOf({ checkoutTrust: { rowOrder: bad } }) === JSON.stringify(DEFAULT_ORDER));
  }
  // Twin sync: the settings model's CHECKOUT_TRUST_ROWS literal must carry
  // the SAME keys in the SAME order (source anchor — the server model does
  // not execute here; settings-derivation.ts covers its behavior).
  const settingsSrc = readSource("app/models/settings.server.ts");
  const rowsLiteral = settingsSrc.match(
    /export const CHECKOUT_TRUST_ROWS = \[([\s\S]*?)\] as const;/,
  );
  const settingsRows = rowsLiteral
    ? (rowsLiteral[1].match(/"[a-z_]+"/g) ?? []).map((s) => s.slice(1, -1))
    : [];
  tap.check("T2: settings.server.ts CHECKOUT_TRUST_ROWS twins TRUST_ROW_ORDER_DEFAULT",
    JSON.stringify(settingsRows) === JSON.stringify(DEFAULT_ORDER),
    "got=" + JSON.stringify(settingsRows));

  // enabled requires the explicit boolean true.
  for (const bad of [1, "true", {}, null]) {
    tap.check(
      `T2: enabled=${JSON.stringify(bad)} stays OFF`,
      L.resolveConfig({ checkoutTrust: { enabled: bad } }).checkoutTrust.enabled === false,
    );
  }

  // Clamps unchanged from V1.
  const clamped = L.resolveConfig({
    guarantee: { days: 0 },
    trustpilot: { rating: 9, reviewCount: -5 },
  });
  tap.check("T2: guarantee days clamps to >= 1", clamped.guarantee.days === 1);
  tap.check("T2: rating clamps to 5", clamped.trustpilot.rating === 5);
  tap.check("T2: review count clamps to 0", clamped.trustpilot.reviewCount === 0);
  tap.check("T2: showLink defaults linked", clamped.trustpilot.showLink === true);

  // resolvePreview: inert unless well-formed.
  const inert = L.resolvePreview({ preview: "nope" });
  tap.check("T2: malformed preview -> inert",
    inert.armed === false && inert.tokenHash === "" && Object.keys(inert.draftFlags).length === 0);
  const pv = L.resolvePreview({
    preview: {
      armed: true,
      tokenHash: "abc",
      draftFlags: { checkout_customs: true, checkout_tracked: "yes", checkout_trust: false },
    },
  });
  tap.check("T2: draftFlags keep booleans only",
    pv.armed === true &&
      pv.draftFlags.checkout_customs === true &&
      pv.draftFlags.checkout_trust === false &&
      !("checkout_tracked" in pv.draftFlags));

  // isAllowedInMarket fail-closed matrix — per NEW key.
  for (const key of ["checkout_customs", "checkout_tracked"]) {
    const scoped = (scope: unknown) => ({ marketScopes: { [key]: scope } });
    tap.check(`T2: ${key}: no config root -> allowed`, L.isAllowedInMarket(undefined, key, "eu") === true);
    tap.check(`T2: ${key}: no scope entry -> allowed`, L.isAllowedInMarket({ marketScopes: {} }, key, "eu") === true);
    tap.check(`T2: ${key}: mode all -> allowed`, L.isAllowedInMarket(scoped({ mode: "all", markets: [] }), key, undefined) === true);
    tap.check(`T2: ${key}: selected + listed -> allowed`, L.isAllowedInMarket(scoped({ mode: "selected", markets: ["eu", "ch"] }), key, "ch") === true);
    tap.check(`T2: ${key}: selected + UNLISTED -> hidden`, L.isAllowedInMarket(scoped({ mode: "selected", markets: ["eu"] }), key, "us") === false);
    tap.check(`T2: ${key}: selected + UNKNOWN market -> hidden (fail closed)`, L.isAllowedInMarket(scoped({ mode: "selected", markets: ["eu"] }), key, undefined) === false);
    tap.check(`T2: ${key}: selected + malformed list -> hidden`, L.isAllowedInMarket(scoped({ mode: "selected", markets: "eu" }), key, "eu") === false);
  }

  // Diagnosis ordering (most fundamental first). `diagBase` = the tracked
  // row not wanted; the v9 date-chain branches are exercised separately.
  const basePv = { armed: true, draftFlags: {}, tokenHash: "h" };
  const diagBase = {
    trackedWanted: false,
    countryCode: undefined as string | undefined,
    trackedDateLabel: "",
  };
  tap.check("T2: diagnosis: config missing first",
    L.trustPreviewDiagnosis({ ...diagBase, configFound: false, preview: basePv, attributeValue: "h", featureVisible: true }).includes("config metafield not found"));
  tap.check("T2: diagnosis: disarmed",
    L.trustPreviewDiagnosis({ ...diagBase, configFound: true, preview: { ...basePv, armed: false }, attributeValue: "h", featureVisible: true }).includes("not armed"));
  tap.check("T2: diagnosis: stale hash",
    L.trustPreviewDiagnosis({ ...diagBase, configFound: true, preview: basePv, attributeValue: "other", featureVisible: true }).includes("stale"));
  tap.check("T2: diagnosis: not draft-enabled",
    L.trustPreviewDiagnosis({ ...diagBase, configFound: true, preview: basePv, attributeValue: "h", featureVisible: false }).includes("not draft-enabled"));
  tap.check("T2: diagnosis: all rows off",
    L.trustPreviewDiagnosis({ ...diagBase, configFound: true, preview: basePv, attributeValue: "h", featureVisible: true }).includes("toggled off"));
  // v9 tracked-date branches: never blame the toggles for a date-chain hide.
  tap.check("T2: diagnosis: tracked wanted + no country -> asks for an address",
    L.trustPreviewDiagnosis({ configFound: true, preview: basePv, attributeValue: "h", featureVisible: true, trackedWanted: true, countryCode: undefined, trackedDateLabel: "" }).includes("no shipping country yet"));
  tap.check("T2: diagnosis: tracked wanted + uncomputable date names the country",
    L.trustPreviewDiagnosis({ configFound: true, preview: basePv, attributeValue: "h", featureVisible: true, trackedWanted: true, countryCode: "FR", trackedDateLabel: "" }).includes("no delivery date can be computed for FR"));
  tap.check("T2: diagnosis: tracked wanted + formattable date -> falls through to toggled off",
    L.trustPreviewDiagnosis({ configFound: true, preview: basePv, attributeValue: "h", featureVisible: true, trackedWanted: true, countryCode: "FR", trackedDateLabel: "28 juillet" }).includes("toggled off"));
}

// ------------------------------------------------- T3 compact date formatter
{
  // Independent expectation: a DIFFERENT Intl API path (DateTimeFormat
  // object + format) with its own local-noon rebuild and its own fr-1er
  // reimplementation. Catches option/locale drift in the shipped formatter.
  function expectedCompact(ut: number, locale: string): string {
    const d = new Date(ut);
    const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
    let out = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" }).format(local);
    if (locale.split("-")[0].toLowerCase() === "fr" && d.getUTCDate() === 1) {
      out = out.replace(/\b1\b/, "1er");
    }
    return out;
  }
  function expectedCompactFallback(ut: number): string {
    const d = new Date(ut);
    const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
    return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(local);
  }
  const CHECKOUT_LOCALES = [
    "en", "fr", "de", "es", "it", "pt-PT", "nl", "da", "sv", "no", "nb",
    "fi", "pl", "ro", "hu", "el", "ja", "ar",
  ];
  for (const locale of CHECKOUT_LOCALES) {
    for (const ut of fixtureStamps()) {
      const got = L.trustFormatDateCompact(ut, locale);
      const expected = expectedCompact(ut, locale);
      tap.check(
        "T3: compact " + locale + " " + new Date(ut).toISOString().slice(0, 10),
        got === expected,
        "got=" + JSON.stringify(got) + " expected=" + JSON.stringify(expected),
      );
    }
  }
  tap.eq("T3: fr hard expectation 2026-05-01", L.trustFormatDateCompact(UT(2026, 4, 1), "fr"), "1er mai");
  tap.eq("T3: ja hard expectation 2026-07-25", L.trustFormatDateCompact(UT(2026, 6, 25), "ja"), "7月25日");
  tap.eq("T3: de hard expectation 2026-07-25", L.trustFormatDateCompact(UT(2026, 6, 25), "de"), "25. Juli");
  tap.eq("T3: el genitive month 2026-07-25", L.trustFormatDateCompact(UT(2026, 6, 25), "el"), "25 Ιουλίου");
  const ut = UT(2026, 6, 22);
  tap.eq("T3: fallback: empty locale -> short form", L.trustFormatDateCompact(ut, ""), expectedCompactFallback(ut));
  tap.eq("T3: fallback: rejected tag -> short form", L.trustFormatDateCompact(ut, "no way!"), expectedCompactFallback(ut));
}

// ------------------------------------------------------------ T4 locale files
{
  const dir = path.join(ROOT, "extensions", "checkout-trust", "locales");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  tap.eq("T4: 18 locale files", files.length, 18);
  const REQUIRED_KEYS = [
    "guarantee_title", "guarantee_body", "secure", "clinical", "trustpilot",
    "customs", "tracked",
  ].sort();
  // guarantee_title/guarantee_body may be a flat string OR a CLDR plural
  // object (v9.1: ro/ar/pl + the one/other pairs — the component passes
  // `count`); every plural form must be a non-empty string and the `other`
  // form must interpolate {{days}} (one/two forms may spell the number out,
  // e.g. ro "într-o zi", ar "يوم واحد").
  const pluralOk = (value: unknown): boolean =>
    typeof value === "string"
      ? value.trim().length > 0
      : typeof value === "object" &&
        value !== null &&
        typeof (value as Record<string, unknown>).other === "string" &&
        Object.values(value as Record<string, unknown>).every(
          (form) => typeof form === "string" && form.trim().length > 0,
        );
  const daysCarrier = (value: unknown): string =>
    typeof value === "string"
      ? value
      : String((value as Record<string, unknown>)?.other ?? "");
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    const obj = JSON.parse(raw);
    tap.check(
      `T4: ${file} carries exactly the 7-key V2 catalog`,
      JSON.stringify(Object.keys(obj).sort()) === JSON.stringify(REQUIRED_KEYS),
      "got keys " + Object.keys(obj).sort().join(","),
    );
    tap.check(`T4: ${file} tracked carries {{date}}`, String(obj.tracked).includes("{{date}}"));
    // v11.1 one-sentence contract: no interpunct separator in the tracked
    // row — "… · Garantie d'ici au …" read as a SECOND standalone guarantee
    // next to the money-back line. The guarantee must stay grammatically
    // bound to the delivery noun. (The trustpilot value's "·" is fine.)
    tap.check(`T4: ${file} tracked is one sentence (no ·/・ separator)`,
      !String(obj.tracked).includes("·") && !String(obj.tracked).includes("・"));
    tap.check(`T4: ${file} guarantee title + body carry {{days}} (other form)`,
      daysCarrier(obj.guarantee_title).includes("{{days}}") &&
        daysCarrier(obj.guarantee_body).includes("{{days}}"));
    tap.check(`T4: ${file} guarantee values are well-formed strings or plural objects`,
      pluralOk(obj.guarantee_title) && pluralOk(obj.guarantee_body));
    tap.check(`T4: ${file} carries no SSL wording (V2 copy contract)`, !raw.includes("SSL"));
    tap.check(`T4: ${file} has no empty simple strings`,
      ["secure", "clinical", "trustpilot", "customs", "tracked"].every(
        (key) => typeof obj[key] === "string" && obj[key].trim().length > 0,
      ));
    tap.check(`T4: ${file} within the 15,000B per-file budget`,
      Buffer.byteLength(raw, "utf8") <= 15000);
  }
  const en = JSON.parse(fs.readFileSync(path.join(dir, "en.default.json"), "utf8"));
  tap.eq("T4: en secure is the V2 wording", en.secure, "Secure Encrypted Checkout");
  tap.eq("T4: en guarantee body (other) is the V2 wording", en.guarantee_body.other,
    "Not satisfied? Get your money back within {{days}} days.");
  tap.eq("T4: en guarantee body has the day=1 form", en.guarantee_body.one,
    "Not satisfied? Get your money back within {{days}} day.");
  // The grammar fixes the review confirmed stay pinned.
  const it = JSON.parse(fs.readFileSync(path.join(dir, "it.json"), "utf8"));
  tap.check("T4: it tracked carries the mandatory article (entro il)",
    it.tracked.includes("entro il {{date}}"));
  const ro = JSON.parse(fs.readFileSync(path.join(dir, "ro.json"), "utf8"));
  tap.check("T4: ro guarantee 'few' form drops the 'de' linker",
    ro.guarantee_body.few.includes("{{days}} zile") && !ro.guarantee_body.few.includes("de zile"));
  const arL = JSON.parse(fs.readFileSync(path.join(dir, "ar.json"), "utf8"));
  tap.check("T4: ar guarantee carries the full plural set",
    ["one", "two", "few", "many", "other"].every(
      (form) => typeof arL.guarantee_body[form] === "string" && arL.guarantee_body[form].length > 0,
    ));
  tap.eq("T4: en customs is the merchant's wording", en.customs,
    "No customs or additional fees on delivery.");
  // v11.1: ONE SENTENCE — the old "Tracked Delivery · Guaranteed by …"
  // two-part pattern read as a second standalone guarantee right under the
  // money-back line (merchant catch, 2026-08-10, fr screenshot).
  tap.eq("T4: en tracked is the merchant's wording", en.tracked,
    "Tracked delivery guaranteed by {{date}}");
  tap.check("T4: nb is a byte-copy of no (SPEC convention)",
    fs.readFileSync(path.join(dir, "nb.json"), "utf8") === fs.readFileSync(path.join(dir, "no.json"), "utf8"));
  const fr = JSON.parse(fs.readFileSync(path.join(dir, "fr.json"), "utf8"));
  tap.check("T4: fr tracked aligns with the delivery vocabulary",
    fr.tracked.includes("Livraison suivie") && fr.tracked.includes("d'ici au {{date}}"));
  const ja = JSON.parse(fs.readFileSync(path.join(dir, "ja.json"), "utf8"));
  tap.check("T4: ja tracked is one sentence binding the guarantee to お届け",
    ja.tracked.includes("追跡") && ja.tracked.includes("までのお届けを保証"));
}

// --------------------------------------------------------- T5 component pins
{
  const src = readSource("extensions/checkout-trust/src/Checkout.tsx");
  for (const anchor of [
    // The three market gates (also the harness EVIDENCE literals).
    "'checkout_trust'",
    "'checkout_customs'",
    "'checkout_tracked'",
    // Row visibility composes flag AND own market scope AND draft grant.
    "config.checkoutTrust.showCustoms && customsAllowedInMarket",
    "config.checkoutTrust.showTracked && trackedAllowedInMarket",
    "customsDraftEnabled",
    "trackedDraftEnabled",
    // Tracked date: the engine twin (v10: the typed provinceCode threads
    // into the resolve), the GUARANTEED max (never min), the compact
    // formatter on the checkout language, fail-closed empty label.
    "resolveDeliveryConfig(configRoot, countryCode, provinceCode)",
    "deliveryResult.max",
    "trustFormatDateCompact(guaranteedUt, language.isoCode)",
    "trackedDateLabel !== ''",
    // New strings ride the right keys + params; the guarantee pair passes
    // BOTH days (interpolation) and count (CLDR plural selection for the
    // locales shipping plural objects — ro/ar/pl and the one/other pairs).
    "translate('customs')",
    "translate('tracked', {date: trackedDateLabel})",
    "translate('guarantee_body', {",
    "count: config.guarantee.days,",
    // Country + v10 US state only ever come from the shipping address.
    "shippingAddress?.countryCode",
    "shippingAddress?.provinceCode",
    // v11: the render is DRIVEN by the normalized rowOrder — a keyed row map
    // indexed by the config order, every row still behind its own gate.
    "const rowsByKey: Record<TrustRowKey, ReactElement | null>",
    "{config.checkoutTrust.rowOrder.map((rowKey) => rowsByKey[rowKey])}",
    // ALL SIX rowsByKey entries stay behind their own render flag — the
    // Record type only forces key presence, not gating, so each ternary is
    // pinned: an ungated (or cross-wired) entry would let ordering REVEAL a
    // row whose show* flag is off, with tsc green.
    "badges: renderBadges ? (",
    "guarantee: renderGuarantee ? (",
    "customs: renderCustoms ? (",
    "tracked: renderTracked ? (",
    "clinical: renderClinical ? (",
    "trustpilot: renderTrustpilot ? (",
    // …and the flag derivations themselves (a derivation/ternary swap must
    // not slip through either).
    "const renderBadges = showBadges || inEditor;",
    "const renderGuarantee = showGuarantee || inEditor;",
    "const renderCustoms = customsVisible || inEditor;",
    "trackedVisible || (inEditor && trackedDateLabel !== '')",
    "const renderClinical = showClinical || inEditor;",
    "const renderTrustpilot = showTrustpilot || inEditor;",
  ]) {
    tap.check(`T5: Checkout.tsx anchor present: ${anchor}`, src.includes(anchor));
  }
  tap.check(
    "T5: tracked date never derives from deliveryResult.min",
    !src.includes("deliveryResult.min"),
  );
  // The pure logic lives in trust-logic.ts — the component must import it,
  // never redeclare it (the sim tests the module the component ships with).
  tap.check("T5: component imports the pure module", src.includes("from './trust-logic'"));
  tap.check("T5: component declares no local resolveConfig", !src.includes("function resolveConfig"));
}

// ------------------------------------------------------------------- mutants
if (!process.env.CX_SKIP_MUTANTS) {
  const { runMutants } = require2("./lib/mutants.cjs");
  process.env.CX_TSX_SUITE = fileURLToPath(import.meta.url);
  const failedMutants = runMutants({
    selfPath: path.join(HERE, "lib", "tsx-shim.cjs"),
    srcPath: REAL_SRC,
    mutants: [
      {
        name: "m1-customs-default-on",
        find: "showCustoms: readBoolean(trust, 'showCustoms', defaults.checkoutTrust.showCustoms),",
        replace: "showCustoms: readBoolean(trust, 'showCustoms', true),",
      },
      {
        name: "m2-tracked-default-on",
        find: "showTracked: readBoolean(trust, 'showTracked', defaults.checkoutTrust.showTracked),",
        replace: "showTracked: readBoolean(trust, 'showTracked', true),",
      },
      {
        name: "m3-market-gate-open",
        find: "if (!marketHandle) return false;",
        replace: "if (!marketHandle) return true;",
      },
      {
        name: "m4-selected-ignores-list",
        find: "return markets.includes(marketHandle);",
        replace: "return true;",
      },
      {
        name: "m5-enabled-loose",
        find: "enabled: isPlainObject(trust) && trust.enabled === true,",
        replace: "enabled: isPlainObject(trust),",
      },
      {
        name: "m6-compact-gains-weekday",
        find: "local.toLocaleDateString(locale, {day: 'numeric', month: 'long'})",
        replace: "local.toLocaleDateString(locale, {weekday: 'long', day: 'numeric', month: 'long'})",
      },
      {
        name: "m7-fr-ordinal-dropped",
        find: "label = label.replace(/\\b1\\b/, '1er');",
        replace: "label = label;",
      },
      {
        name: "m8-roworder-ignores-config",
        find: "  if (Array.isArray(value)) {",
        replace: "  if (false) {",
      },
      {
        name: "m9-roworder-drops-missing-append",
        find: "    if (!out.includes(key)) out.push(key);",
        replace: "    ;",
      },
      {
        name: "m10-roworder-keeps-duplicates",
        find: "        !out.includes(entry as TrustRowKey)",
        replace: "        true",
      },
    ],
  });
  if (failedMutants > 0) {
    console.error(`${failedMutants} MUTANT(S) NOT CAUGHT`);
    process.exit(1);
  }
  // The mutant children wrote their own .gen basename — remove the residue.
  try {
    fs.unlinkSync(path.join(ROOT, "validation", "lib", ".gen", "trust-logic.mutant.ts"));
  } catch {
    // best-effort cleanup
  }
}

tap.finish();
