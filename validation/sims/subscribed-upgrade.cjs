/**
 * Subscribed-upgrade sim — the v5.1 live-bug contract: Joy allocates
 * selling plans PER VARIANT, so a volume tier is an upgrade candidate for
 * a SUBSCRIBED line only when the target variant allocates the line's
 * current plan (otherwise /cart/add.js 422s and the subscription would be
 * silently dropped).
 *
 * Runs the REAL functions vm-extracted from
 * extensions/cellexia-booster/assets/cellexia-cart.js:
 *   volumeOffers, savingsPercent, variantAllocatesPlan, upgradeCandidates,
 *   productFor, variantByPosition, currentVariant, itemHasPlan,
 *   planMetaById, findPlanForItem, planPercent, linePlanPercent.
 *
 * Sandbox state (cfg/SETTINGS/state/featureOn) is scenario data, not
 * logic; featureOn is the real extracted function driven by EFFECTIVE.
 */
"use strict";
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const { extractAll } = require("./lib/extract.cjs");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "..", "extensions", "cellexia-booster", "assets", "cellexia-cart.js"),
  "utf8",
);

const EXTRACTED = extractAll(SRC, {
  functions: [
    "featureOn",
    "productFor",
    "variantByPosition",
    "currentVariant",
    "volumeOffers",
    "savingsPercent",
    "variantAllocatesPlan",
    "upgradeCandidates",
    "planMetaById",
    "findPlanForItem",
    "planPercent",
    "linePlanPercent",
    "itemHasPlan",
  ],
});

let checks = 0, failures = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.error("FAIL: " + label); }
}

function makeSandbox({ settings, products, effective }) {
  const sandbox = {
    console,
    PREVIEW: null,
    EFFECTIVE: effective || { volume: true },
    CART_FEATURE_KEYS: { volume: "cart_volume_upsell" },
    SETTINGS: settings,
    state: { products: products || {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox, { filename: "extracted-upgrade-module.js" });
  return sandbox;
}

// Product fixture: 1/2/3-unit tiers. Plan 777 allocated ONLY on the 1-unit
// variant (the live-store Joy shape); plan 888 allocated on all tiers.
const PRODUCT = {
  variants: [
    { id: 11, position: 1, price: 4900, available: true,
      planAllocations: [{ planId: 777, price: 4400 }, { planId: 888, price: 4655 }] },
    { id: 12, position: 2, price: 8800, available: true, compare_at_price: 9800,
      planAllocations: [{ planId: 888, price: 8360 }] },
    { id: 13, position: 3, price: 11700, available: true,
      planAllocations: [{ planId: 888, price: 11115 }] },
  ],
  sellingPlanGroups: [
    { name: "Subscribe & Save", plans: [
      { id: 777, name: "Monthly", valueType: "percentage", value: 10 },
      { id: 888, name: "Every 2 months", valueType: "percentage", value: 5 },
    ] },
  ],
};

const SETTINGS = {
  volumeOffers: [
    { quantity: 3, discountPct: 20 },
    { quantity: 2, discountPct: 10 },
    { quantity: 1, discountPct: 0 },   // filtered: quantity must be > 1
    null,                              // filtered: nullish offer
  ],
  sellingPlanKeyword: "subscribe",
  subscriptionDiscountPct: 7,
};

const LINE_PLAIN = { product_id: 900, variant_id: 11, quantity: 1 };
const LINE_SUBSCRIBED_777 = {
  product_id: 900, variant_id: 11, quantity: 1,
  selling_plan_allocation: { selling_plan: { id: 777 } },
};
const LINE_SUBSCRIBED_888 = {
  product_id: 900, variant_id: 11, quantity: 1,
  selling_plan_allocation: { selling_plan: { id: 888 } },
};

function candidates(sandbox, item) {
  sandbox.__item = item;
  return vm.runInContext("upgradeCandidates(__item)", sandbox);
}

// --- volumeOffers hygiene ----------------------------------------------------
{
  const sb = makeSandbox({ settings: SETTINGS, products: { 900: PRODUCT } });
  const offers = vm.runInContext("volumeOffers()", sb);
  ok(offers.length === 2, "volumeOffers drops qty<=1 and nullish entries");
  ok(Number(offers[0].quantity) === 2 && Number(offers[1].quantity) === 3,
    "volumeOffers sorted ascending by quantity");
}

// --- unsubscribed line: all higher tiers qualify ------------------------------
{
  const sb = makeSandbox({ settings: SETTINGS, products: { 900: PRODUCT } });
  const out = candidates(sb, LINE_PLAIN);
  ok(out.length === 2, "plain line: both higher tiers offered (got " + out.length + ")");
  ok(out[0].quantity === 2 && out[1].quantity === 3, "plain line: tiers 2 and 3, ascending");
  // savings math: bundle vs qty x tier-1 price -> 2*4900=9800 vs 8800 = 10%
  ok(out[0].percent === Math.round(((2 * 4900 - 8800) / (2 * 4900)) * 100),
    "tier-2 savings from qty x tier1 price (10%)");
  ok(out[1].percent === Math.round(((3 * 4900 - 11700) / (3 * 4900)) * 100),
    "tier-3 savings from qty x tier1 price (20%)");
  ok(out[0].perUnitCents === Math.round(8800 / 2), "tier-2 per-unit cents");
}

// --- v5.1 plan-allocation gate on volume tiles --------------------------------
{
  const sb = makeSandbox({ settings: SETTINGS, products: { 900: PRODUCT } });
  const gated = candidates(sb, LINE_SUBSCRIBED_777);
  ok(gated.length === 0,
    "subscribed(777) line: NO tier qualifies (tiers lack plan 777) — the 422 guard");
  const open = candidates(sb, LINE_SUBSCRIBED_888);
  ok(open.length === 2,
    "subscribed(888) line: tiers allocating the line's plan still qualify");
}

// --- plan id comparison is String-normalized ----------------------------------
{
  const products = { 900: JSON.parse(JSON.stringify(PRODUCT)) };
  // allocation carries the id as a string, the line as a number
  products[900].variants[1].planAllocations = [{ planId: "888" }];
  products[900].variants[2].planAllocations = [{ planId: "888" }];
  const sb = makeSandbox({ settings: SETTINGS, products });
  const out = candidates(sb, LINE_SUBSCRIBED_888);
  ok(out.length === 2, "string/number planId still matches (String() both sides)");
}

// --- fail-closed edges ---------------------------------------------------------
{
  const sb = makeSandbox({ settings: SETTINGS, products: { 900: PRODUCT } });
  ok(candidates(sb, { product_id: 900, variant_id: 11, quantity: 2 }).length === 0,
    "quantity != 1 line: no upgrade tiles");
  ok(candidates(sb, { product_id: 999, variant_id: 11, quantity: 1 }).length === 0,
    "unknown product: no tiles");
  ok(candidates(sb, { product_id: 900, variant_id: 404, quantity: 1 }).length === 0,
    "unknown variant: no tiles");
  const off = makeSandbox({ settings: SETTINGS, products: { 900: PRODUCT }, effective: { volume: false } });
  ok(candidates(off, LINE_PLAIN).length === 0, "feature off: no tiles");
}

// --- unavailable tier + already-on-tier lines ----------------------------------
{
  const products = { 900: JSON.parse(JSON.stringify(PRODUCT)) };
  products[900].variants[1].available = false; // 2-unit tier sold out
  const sb = makeSandbox({ settings: SETTINGS, products });
  const out = candidates(sb, LINE_PLAIN);
  ok(out.length === 1 && out[0].quantity === 3, "sold-out tier skipped, higher tier kept");

  const sb2 = makeSandbox({ settings: SETTINGS, products: { 900: PRODUCT } });
  const fromTier2 = candidates(sb2, { product_id: 900, variant_id: 12, quantity: 1 });
  ok(fromTier2.length === 1 && fromTier2[0].quantity === 3,
    "line already on tier 2: only tier 3 offered (qty <= currentPos dropped)");
  const fromTier3 = candidates(sb2, { product_id: 900, variant_id: 13, quantity: 1 });
  ok(fromTier3.length === 0, "line on top tier: nothing offered");
}

// --- savings fallbacks -----------------------------------------------------------
{
  // No tier-1 price -> compare_at_price fallback; neither -> offer.discountPct.
  const products = { 900: JSON.parse(JSON.stringify(PRODUCT)) };
  products[900].variants[0].price = 0; // kills the bundle math
  const sb = makeSandbox({ settings: SETTINGS, products });
  const out = candidates(sb, { product_id: 900, variant_id: 11, quantity: 1 });
  const tier2 = out.find((c) => c.quantity === 2);
  const tier3 = out.find((c) => c.quantity === 3);
  ok(!!tier2 && tier2.percent === Math.round(((9800 - 8800) / 9800) * 100),
    "no tier-1 price: compare_at_price savings fallback");
  ok(!!tier3 && tier3.percent === 20,
    "no tier-1 price, no compare_at: offer.discountPct fallback");
}

// --- itemHasPlan shapes -----------------------------------------------------------
{
  const sb = makeSandbox({ settings: SETTINGS, products: { 900: PRODUCT } });
  sb.__a = LINE_SUBSCRIBED_777;
  sb.__b = LINE_PLAIN;
  sb.__c = { selling_plan_allocation: { selling_plan: {} } };
  ok(vm.runInContext("itemHasPlan(__a)", sb) === true, "itemHasPlan: allocated line true");
  ok(vm.runInContext("itemHasPlan(__b)", sb) === false, "itemHasPlan: plain line false");
  ok(vm.runInContext("itemHasPlan(__c)", sb) === false, "itemHasPlan: id-less allocation false");
}

// --- findPlanForItem keyword + fallback --------------------------------------------
{
  const sb = makeSandbox({ settings: SETTINGS, products: { 900: PRODUCT } });
  sb.__item = LINE_PLAIN;
  const plan = vm.runInContext("findPlanForItem(__item)", sb);
  ok(!!plan && String(plan.id) === "777",
    "keyword 'subscribe' matches the group name; first allocation wins");
  ok(!!plan && plan.allocPrice === 4400, "per-variant allocation price carried");

  // No keyword: first allocation is the fallback.
  const sb2 = makeSandbox({
    settings: Object.assign({}, SETTINGS, { sellingPlanKeyword: "" }),
    products: { 900: PRODUCT },
  });
  sb2.__item = LINE_PLAIN;
  const fb = vm.runInContext("findPlanForItem(__item)", sb2);
  ok(!!fb && String(fb.id) === "777", "no keyword: first allocation fallback");

  // Variant without allocations: null.
  const products = { 900: JSON.parse(JSON.stringify(PRODUCT)) };
  products[900].variants[0].planAllocations = [];
  const sb3 = makeSandbox({ settings: SETTINGS, products });
  sb3.__item = LINE_PLAIN;
  ok(vm.runInContext("findPlanForItem(__item)", sb3) === null,
    "no per-variant allocations: no plan (v4.7 eligibility rule)");
}

// --- linePlanPercent: allocation price beats plan metadata --------------------------
{
  const sb = makeSandbox({ settings: SETTINGS, products: { 900: PRODUCT } });
  sb.__item = LINE_PLAIN;
  sb.__plan = { id: 777, valueType: "percentage", value: 10, allocPrice: 4400 };
  ok(vm.runInContext("linePlanPercent(__item, __plan)", sb) ===
    Math.round(((4900 - 4400) / 4900) * 100),
    "allocPrice < base: real per-line saving wins");
  sb.__plan2 = { id: 777, valueType: "percentage", value: 10, allocPrice: null };
  ok(vm.runInContext("linePlanPercent(__item, __plan2)", sb) === 10,
    "no allocPrice: plan percentage metadata");
  sb.__plan3 = { id: 777, valueType: "fixed", value: 0, allocPrice: null };
  ok(vm.runInContext("linePlanPercent(__item, __plan3)", sb) === 7,
    "no usable metadata: settings.subscriptionDiscountPct fallback");
}

if (failures > 0) {
  console.error(`\n${failures}/${checks} CHECKS FAILED`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED (subscribed-upgrade plan-allocation gate vs the real cellexia-cart.js)`);
