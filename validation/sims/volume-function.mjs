/**
 * v32 volume-pricing Function sim — runs the REAL shipped logic
 * (extensions/cellexia-volume/src/logic.js, imported directly, no copies)
 * against fixture inputs shaped like src/cart_lines_discounts_generate_run.graphql
 * (docs/SPEC-v32-volume-pricing.md):
 *
 *  - the armed happy path in 2-decimal, 0-decimal (JPY) and 3-decimal
 *    (BHD) currencies, with the fixedAmount emitted from INTEGER minor
 *    units — and the rounding rule pinned against an INDEPENDENT
 *    half-up integer computation over a sweep (the widget-parity core);
 *  - every fail-closed anchor ALONE: off switch, missing config, class
 *    gate, wrong variant, tier variant, subscription line, gift line,
 *    below-minimum quantity, missing country, currency mismatch, the p1
 *    staleness tripwire, the 60% sanity clamp, k out of range;
 *  - the localized message chain (exact -> base -> en) and the ALL
 *    strategy / one-candidate-per-qualifying-line output shape.
 *
 * The module is loaded dynamically so the mutation harness can point
 * CX_SIM_SRC at a mutated copy (the quantity-selector convention brought
 * to an ESM function).
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { makeChecker } from "../lib/util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_SRC = path.join(HERE, "..", "..", "extensions", "cellexia-volume", "src", "logic.js");
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;
const {
  volumeOperations,
  volumeLineOff,
  volumeConfig,
  volumeMessage,
  volumeTargetMinor,
  minorUnits,
  fmtAmount,
  numId,
  VOLUME_MSG,
  MAX_OFF_SHARE,
} = await import(pathToFileURL(SRC_PATH).href);

const { ok, finish } = makeChecker("v32 volume-pricing function vs the real logic.js");

// ------------------------------------------------------------- fixtures

/** The US-shaped tier entry: 1 Jar $86, 3 Jars $205, k=3. */
function usEntry() {
  return { c: "USD", m: 100, p1: 8600, p3: 20500 };
}

function cfgFixture(overrides = {}) {
  return {
    v: 1,
    on: true,
    p: {
      "111": { k: 3, v1: "9001", cc: { US: usEntry(), GB: { c: "GBP", m: 100, p1: 5900, p3: 13428 } } },
      "222": { k: 2, v1: "9101", cc: { US: { c: "USD", m: 100, p1: 4000, p3: 7000 } } },
    },
    _s: { h: "x", t: "2026-09-21T00:00:00Z", d: "gid://shopify/DiscountAutomaticNode/1" },
    ...overrides,
  };
}

function line(overrides = {}) {
  const qty = overrides.qty ?? 4;
  const unitMinor = overrides.unitMinor ?? 8600;
  const m = overrides.m ?? 100;
  const amount = (qty * unitMinor) / m;
  return {
    id: overrides.id ?? "gid://shopify/CartLine/1",
    quantity: qty,
    attribute: overrides.gift ? { value: "1" } : null,
    cost: {
      subtotalAmount: {
        amount: overrides.amount ?? String(amount),
        currencyCode: overrides.currency ?? "USD",
      },
    },
    merchandise: {
      __typename: overrides.typename ?? "ProductVariant",
      id: `gid://shopify/ProductVariant/${overrides.vid ?? "9001"}`,
      product: { id: `gid://shopify/Product/${overrides.pid ?? "111"}` },
    },
    sellingPlanAllocation: overrides.plan ? { sellingPlan: { id: "gid://shopify/SellingPlan/5" } } : null,
  };
}

function input(overrides = {}) {
  return {
    cart: { lines: overrides.lines ?? [line()] },
    discount: { discountClasses: overrides.classes ?? ["PRODUCT"] },
    localization: {
      country: { isoCode: overrides.country ?? "US" },
      language: { isoCode: overrides.lang ?? "EN" },
    },
    shop: { metafield: overrides.noCfg ? null : { jsonValue: overrides.cfg ?? cfgFixture() } },
  };
}

function firstCandidate(ops) {
  return ops.length === 1 ? ops[0].productDiscountsAdd.candidates[0] : null;
}

// ------------------------------------------------------------ happy path

{
  const ops = volumeOperations(input());
  ok(ops.length === 1 && ops[0].productDiscountsAdd.selectionStrategy === "ALL", "F1: one ALL operation for a qualifying line");
  const cand = firstCandidate(ops);
  // 4 x 8600 = 34400; target = round(4 x 20500 / 3) = 27333; off = 7067.
  ok(cand && cand.value.fixedAmount.amount === "70.67", "F1: fixedAmount = the exact minor-unit difference (got " + (cand && cand.value.fixedAmount.amount) + ")");
  ok(cand && cand.value.fixedAmount.appliesToEachItem === false, "F1: the amount applies to the LINE, not each item");
  ok(cand && cand.targets.length === 1 && cand.targets[0].cartLine.id === "gid://shopify/CartLine/1", "F1: targets exactly the qualifying line");
  ok(cand && cand.message === VOLUME_MSG.en, "F1: english message by default");
}
{
  const ops = volumeOperations(input({ lines: [line({ qty: 5 })] }));
  const cand = firstCandidate(ops);
  // 5 x 8600 = 43000; target = round(5 x 20500 / 3) = 34167; off = 8833.
  ok(cand && cand.value.fixedAmount.amount === "88.33", "F2: qty 5 keeps the exact top-tier rate (got " + (cand && cand.value.fixedAmount.amount) + ")");
}
{
  // GB: 4 x 5900 = 23600; target = round(4 x 13428 / 3) = 17904; off = 5696.
  const ops = volumeOperations(input({ country: "GB", lines: [line({ unitMinor: 5900, currency: "GBP" })] }));
  const cand = firstCandidate(ops);
  ok(cand && cand.value.fixedAmount.amount === "56.96", "F3: the country picks its own price point (GB, got " + (cand && cand.value.fixedAmount.amount) + ")");
}
{
  // k=2 product: minimum is 3. qty 3 x 4000 = 12000; target = round(3 x 7000 / 2) = 10500; off = 1500.
  const ops = volumeOperations(input({ lines: [line({ pid: "222", vid: "9101", qty: 3, unitMinor: 4000 })] }));
  const cand = firstCandidate(ops);
  ok(cand && cand.value.fixedAmount.amount === "15.00", "F4: a K=2 product discounts from 3 units (got " + (cand && cand.value.fixedAmount.amount) + ")");
}
{
  // JPY (m=1): 1 unit ¥8,600, top ¥20,500 — amounts carry no decimals.
  const cfg = cfgFixture();
  cfg.p["111"].cc.JP = { c: "JPY", m: 1, p1: 8600, p3: 20500 };
  const ops = volumeOperations(
    input({ cfg, country: "JP", lines: [line({ m: 1, unitMinor: 8600, currency: "JPY" })] }),
  );
  const cand = firstCandidate(ops);
  ok(cand && cand.value.fixedAmount.amount === "7067", "F5: a zero-decimal currency emits whole units (got " + (cand && cand.value.fixedAmount.amount) + ")");
}
{
  // BHD (m=1000): p1 86.000, p3 205.000.
  const cfg = cfgFixture();
  cfg.p["111"].cc.BH = { c: "BHD", m: 1000, p1: 86000, p3: 205000 };
  const ops = volumeOperations(
    input({ cfg, country: "BH", lines: [line({ m: 1000, unitMinor: 86000, currency: "BHD" })] }),
  );
  const cand = firstCandidate(ops);
  ok(cand && cand.value.fixedAmount.amount === "70.667", "F6: a three-decimal currency emits three decimals (got " + (cand && cand.value.fixedAmount.amount) + ")");
}
{
  const both = volumeOperations(
    input({
      lines: [
        line(),
        line({ id: "gid://shopify/CartLine/2", pid: "222", vid: "9101", qty: 3, unitMinor: 4000 }),
      ],
    }),
  );
  ok(
    both.length === 1 && both[0].productDiscountsAdd.candidates.length === 2,
    "F7: several qualifying lines ride ONE operation as separate candidates",
  );
}

// ---------------------------------------------------- widget rounding twin

{
  // Independent half-up integral formula: floor((2*n*p3 + k) / (2*k)).
  let match = true;
  for (let k = 2; k <= 6; k += 1) {
    for (let n = k + 1; n <= 24; n += 1) {
      for (const p3 of [20500, 13428, 9999, 12345, 7001]) {
        const independent = Math.floor((2 * n * p3 + k) / (2 * k));
        if (volumeTargetMinor(n, p3, k) !== independent) match = false;
      }
    }
  }
  ok(match, "F8: volumeTargetMinor == independent half-up integer formula over the sweep (the widget-parity core)");
}

// --------------------------------------------------------- fail-closed anchors

{
  ok(volumeOperations(input({ cfg: cfgFixture({ on: false }) })).length === 0, "A1: on:false = inert (the go-live switch)");
  ok(volumeOperations(input({ noCfg: true })).length === 0, "A2: no config metafield = inert");
  ok(volumeOperations(input({ classes: ["ORDER"] })).length === 0, "A3: PRODUCT class gate");
  ok(volumeOperations(input({ lines: [line({ qty: 3 })] })).length === 0, "A4: below K+1 = full price (the tiers own 1..K)");
  ok(volumeOperations(input({ lines: [line({ vid: "9002" })] })).length === 0, "A5: only the 1-unit variant (a tier line is never touched)");
  ok(volumeOperations(input({ lines: [line({ pid: "999" })] })).length === 0, "A6: unknown product = untouched");
  ok(volumeOperations(input({ lines: [line({ plan: true })] })).length === 0, "A7: a subscription line is never discounted");
  ok(volumeOperations(input({ lines: [line({ gift: true })] })).length === 0, "A8: a gift-marked line is never discounted");
  ok(volumeOperations(input({ country: "FR" })).length === 0, "A9: no mirrored prices for the country = full price");
  ok(volumeOperations(input({ lines: [line({ currency: "EUR" })] })).length === 0, "A10: currency mismatch vs the mirror = full price");
  ok(volumeOperations(input({ lines: [line({ amount: "344.01" })] })).length === 0, "A11: the p1 STALENESS TRIPWIRE — a changed price yields no discount, never a wrong one");
  ok(volumeOperations(input({ lines: [line({ typename: "CustomProduct" })] })).length === 0, "A12: non-variant merchandise = untouched");
  const badK = cfgFixture();
  badK.p["111"].k = 1;
  ok(volumeOperations(input({ cfg: badK })).length === 0, "A13: k out of range = untouched");
  const noDiscount = cfgFixture();
  // p3 >= k*p1 means no genuine saving: off <= 0 must yield nothing.
  noDiscount.p["111"].cc.US = { c: "USD", m: 100, p1: 8600, p3: 25800 };
  ok(volumeOperations(input({ cfg: noDiscount })).length === 0, "A14: a non-discounting catalog yields nothing (off <= 0)");
  const tooDeep = cfgFixture();
  tooDeep.p["111"].cc.US = { c: "USD", m: 100, p1: 10000, p3 : 3000 };
  ok(
    volumeOperations(input({ cfg: tooDeep, lines: [line({ unitMinor: 10000 })] })).length === 0,
    "A15: the " + Math.round(MAX_OFF_SHARE * 100) + "% sanity clamp refuses a config that would halve-plus the line",
  );
  ok(volumeOperations({ cart: { lines: [] }, discount: { discountClasses: ["PRODUCT"] }, localization: { country: { isoCode: "US" } }, shop: { metafield: { jsonValue: cfgFixture() } } }).length === 0, "A16: empty cart = nothing");
}

// ------------------------------------------------------------- helpers

{
  ok(numId("gid://shopify/ProductVariant/42") === "42" && numId("42") === "42" && numId(null) === "", "H1: numId strips the GID prefix");
  ok(minorUnits("86.00", 100) === 8600 && minorUnits("8600", 1) === 8600 && minorUnits("86.000", 1000) === 86000, "H2: minorUnits per currency factor");
  ok(minorUnits("junk", 100) === -1 && minorUnits("-5", 100) === -1, "H3: junk/negative amounts are refused");
  ok(fmtAmount(7067, 100) === "70.67" && fmtAmount(7067, 1) === "7067" && fmtAmount(70667, 1000) === "70.667", "H4: fmtAmount per currency decimals");
  ok(volumeMessage("FR") === VOLUME_MSG.fr && volumeMessage("pt-PT") === VOLUME_MSG.pt && volumeMessage("xx") === VOLUME_MSG.en && volumeMessage(undefined) === VOLUME_MSG.en, "H5: message chain exact -> base -> en");
  ok(volumeConfig({ shop: { metafield: { jsonValue: cfgFixture({ on: false }) } } }) === null, "H6: volumeConfig refuses a disarmed blob");
  const verdict = volumeLineOff(line(), cfgFixture(), "US");
  ok(!!verdict && verdict.off === 7067 && verdict.m === 100, "H7: volumeLineOff returns integer minor units");
  // No em dash in any shopper-facing message (the house copy rule).
  let dashes = false;
  for (const msg of Object.values(VOLUME_MSG)) {
    if (String(msg).indexOf("—") !== -1 || String(msg).indexOf("–") !== -1) dashes = true;
  }
  ok(!dashes, "H8: no em/en dashes in any localized message");
}

finish();

// ------------------------------------------------------------- mutants
if (!process.env.CX_SKIP_MUTANTS) {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { runMutants } = require("./lib/mutants.cjs");
  const bad = runMutants({
    selfPath: fileURLToPath(import.meta.url),
    srcPath: REAL_SRC,
    mutants: [
      {
        // The go-live switch IS the safety model (create-active-but-inert).
        name: "m1-on-flag-ignored",
        find: "  if (cfg.on !== true) return null;",
        replace: "  ",
      },
      {
        // Discounting tier variants would double-discount the catalog.
        name: "m2-variant-anchor-dropped",
        find: "  if (numId(merch.id) !== String(entry.v1)) return null;",
        replace: "  ",
      },
      {
        // The staleness tripwire is what makes a stale mirror SAFE.
        name: "m3-staleness-tripwire-dropped",
        find: "  if (subMinor !== qty * p1) return null;",
        replace: "  ",
      },
      {
        // A subscription line must never be discounted (plan pricing owns it).
        name: "m4-subscription-skip-dropped",
        find: "  if (line.sellingPlanAllocation) return null;",
        replace: "  ",
      },
      {
        // The minimum is K+1 — the tiers themselves own 1..K.
        name: "m5-min-qty-off-by-one",
        find: "  if (!(typeof qty === \"number\" && isFinite(qty) && qty >= k + 1)) return null;",
        replace: "  if (!(typeof qty === \"number\" && isFinite(qty) && qty >= k)) return null;",
      },
      {
        // Truncation instead of half-up breaks widget/checkout parity.
        name: "m6-rounding-floored",
        find: "  return Math.round((qty * p3) / k);",
        replace: "  return Math.floor((qty * p3) / k);",
      },
      {
        // The clamp is the last line against a corrupted mirror.
        name: "m7-sanity-clamp-dropped",
        find: "  if (off > subMinor * MAX_OFF_SHARE) return null;",
        replace: "  ",
      },
      {
        // Per-item application would multiply the discount by the quantity.
        name: "m8-applies-to-each-item",
        find: "          appliesToEachItem: false,",
        replace: "          appliesToEachItem: true,",
      },
      {
        // The gift skip keeps the rewards machinery's lines out of reach.
        name: "m9-gift-skip-dropped",
        find: "  if (line.attribute && line.attribute.value != null && line.attribute.value !== \"\") return null;",
        replace: "  ",
      },
      {
        // Currency mismatch = a converted-market line against the wrong mirror.
        name: "m10-currency-anchor-dropped",
        find: "  if (!sub || sub.currencyCode !== ce.c) return null;",
        replace: "  if (!sub) return null;",
      },
    ],
  });
  if (bad > 0) {
    console.log(`\n${bad} MUTANT(S) NOT CAUGHT (volume-function)`);
    process.exitCode = 1;
  }
}
