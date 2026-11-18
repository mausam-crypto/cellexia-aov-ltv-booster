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
 *
 * v40 (SPEC-v40, Joy Subscriptions): the NATIVE family. Joy puts every
 * pack size on its OWN plan (live store 2026-11-13: 1 unit = "Every 2
 * Months", 2/3 units = "Every 3 Months", plan ids per product) while the
 * dark in-house app's 0 % plans sit on every variant. With the in-house
 * app not live and its plan ids known (cfg.sx.p), a Joy line's tier tile
 * moves to the tier variant's own offerable plan and carries that plan's
 * id (v40.2: no plan name — the merchant removed the frequency label from
 * the tile); the switch card's keyword-less fallback is the first
 * offerable allocation. Island absent / in-house LIVE / B2B / kill switch
 * = exactly the pre-v40 verdicts above.
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
  // v40: the proxy-loaded deny-list state the native family reads
  vars: ["nativeDeny", "nativeDenyAsked", /* v41 */ "CS_APP", "csIds"],
  functions: [
    // v41 Cellexia Subscriptions (the new app's family)
    "csLearn",
    "csPlan",
    "csOffered",
    "csOn",
    "csAlloc",
    "csLinePlan",
    "csSavingsPercent",
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
    // v17 subscription-aware tiles + the transition-guarded fallback
    "variantPlanAlloc",
    "subscriptionAware",
    "subSavingsPercent",
    "subsAware",
    "subsLive",
    "ownedPlan",
    "isB2B",
    // v40 native (Joy) family
    "inhouseLive",
    "nativeDenyList",
    "subsDenied",
    "nativeSubs",
    "nativeAlloc",
    "nativePlanName",
    "nativeSameName",
    "nativeLinePlan",
    "nativeVariantAlloc",
  ],
});

let checks = 0, failures = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.error("FAIL: " + label); }
}

function makeSandbox({ settings, products, effective, cfg, win }) {
  const sandbox = {
    console,
    PREVIEW: null,
    EFFECTIVE: effective || { volume: true },
    CART_FEATURE_KEYS: { volume: "cart_volume_upsell" },
    SETTINGS: settings,
    // v17: cfg carries the gated sx member; window backs the real isB2B.
    cfg: cfg || {},
    window: win || {},
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
  // v17: subscribed tiles are priced from the tier's OWN allocation for the
  // line's plan — never from the one-time variant price.
  ok(open[0].addPriceCents === 8360 && open[0].perUnitCents === Math.round(8360 / 2),
    "subscribed(888) tier-2: per-unit and add price from the 8360 allocation");
  ok(open[1].addPriceCents === 11115 && open[1].perUnitCents === Math.round(11115 / 3),
    "subscribed(888) tier-3: per-unit and add price from the 11115 allocation");
  // v17 save badge (merchant decision): vs qty x the FULL one-time 1-unit price.
  ok(open[0].percent === Math.round(((2 * 4900 - 8360) / (2 * 4900)) * 100),
    "subscribed(888) tier-2 percent vs full one-time baseline (15%)");
  ok(open[1].percent === Math.round(((3 * 4900 - 11115) / (3 * 4900)) * 100),
    "subscribed(888) tier-3 percent vs full one-time baseline (24%)");
}

// --- v17 kill switch + unpriceable allocations fail closed --------------------
{
  // Kill switch off: subscribed lines get ZERO tiles (pre-v17 live behavior);
  // plain lines are untouched and keep one-time pricing.
  const off = makeSandbox({
    settings: Object.assign({}, SETTINGS, { subscriptionAware: false }),
    products: { 900: PRODUCT },
  });
  ok(candidates(off, LINE_SUBSCRIBED_888).length === 0,
    "kill switch off: subscribed line gets no tiles (never a one-time price)");
  const plainOff = candidates(off, LINE_PLAIN);
  ok(plainOff.length === 2 && plainOff[0].perUnitCents === Math.round(8800 / 2),
    "kill switch off: plain line unchanged, one-time pricing");

  // THE transition-hazard pin: allocations exist (the new app attaches plans
  // at product level) but carry no usable price -> zero tiles, because a
  // subscribed line's tile must never fall back to the one-time price.
  const products = { 900: JSON.parse(JSON.stringify(PRODUCT)) };
  products[900].variants[1].planAllocations = [{ planId: 888 }];
  products[900].variants[2].planAllocations = [{ planId: 888, price: 0 }];
  const sb = makeSandbox({ settings: SETTINGS, products });
  ok(candidates(sb, LINE_SUBSCRIBED_888).length === 0,
    "allocation without a usable price: no tile (fail closed, no one-time fallback)");

  // Prepaid detector: an allocation priced ABOVE the one-time price is a
  // multi-delivery prepaid charge (per_delivery_price is not captured) —
  // never a tile, its per-unit math would overstate by the deliveries factor.
  const prepaid = { 900: JSON.parse(JSON.stringify(PRODUCT)) };
  prepaid[900].variants[1].planAllocations = [{ planId: 888, price: 25080 }];
  prepaid[900].variants[2].planAllocations = [{ planId: 888, price: 33345 }];
  const sbP = makeSandbox({ settings: SETTINGS, products: prepaid });
  ok(candidates(sbP, LINE_SUBSCRIBED_888).length === 0,
    "prepaid allocation (price above one-time): no tile");

  // Plain lines carry addPriceCents too (the beacon's truthful revenue base).
  const sb2 = makeSandbox({ settings: SETTINGS, products: { 900: PRODUCT } });
  const plain = candidates(sb2, LINE_PLAIN);
  ok(plain[0].addPriceCents === 8800 && plain[1].addPriceCents === 11700,
    "plain line candidates carry one-time addPriceCents");

  // No usable baseline: the badge hides (0) rather than borrowing the
  // one-time compare_at / discountPct fallbacks.
  const zeroBase = { 900: JSON.parse(JSON.stringify(PRODUCT)) };
  zeroBase[900].variants[0].price = 0;
  const sb3 = makeSandbox({ settings: SETTINGS, products: zeroBase });
  const subZero = candidates(sb3, LINE_SUBSCRIBED_888);
  ok(subZero.length === 2 && subZero[0].percent === 0 && subZero[1].percent === 0,
    "subscribed tile with no baseline: percent 0 (badge hidden), never a one-time fallback");
}

// --- plan id comparison is String-normalized ----------------------------------
{
  const products = { 900: JSON.parse(JSON.stringify(PRODUCT)) };
  // allocation carries the id as a string, the line as a number (prices kept
  // usable — v17 requires them for subscribed tiles)
  products[900].variants[1].planAllocations = [{ planId: "888", price: 8360 }];
  products[900].variants[2].planAllocations = [{ planId: "888", price: 11115 }];
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

  // v17 TRANSITION GUARD: without the live/market/ownership context, a plan
  // the keyword did not name is NOT fallback-eligible — the switch card must
  // never enroll a shopper into an unlaunched app's plans.
  const sb2 = makeSandbox({
    settings: Object.assign({}, SETTINGS, { sellingPlanKeyword: "" }),
    products: { 900: PRODUCT },
  });
  sb2.__item = LINE_PLAIN;
  ok(vm.runInContext("findPlanForItem(__item)", sb2) === null,
    "no keyword + no live owned context: NO fallback plan (transition guard)");

  // With the v17 context vouching for the plan (sx present + owned + LIVE,
  // v23), the fallback works again.
  const sb2b = makeSandbox({
    settings: Object.assign({}, SETTINGS, { sellingPlanKeyword: "" }),
    products: { 900: PRODUCT },
    cfg: { sx: { p: ["777"], live: true } },
  });
  sb2b.__item = LINE_PLAIN;
  const fb = vm.runInContext("findPlanForItem(__item)", sb2b);
  ok(!!fb && String(fb.id) === "777", "no keyword + owned live plan: fallback returns it");

  // v23: same context but the app is in SETUP (island open for previews,
  // live:false) — the keyword-less fallback must NOT enroll anyone.
  // v40: both of the variant's plans are the in-house app's here, so the
  // native fallback has nothing offerable either.
  const sb2c = makeSandbox({
    settings: Object.assign({}, SETTINGS, { sellingPlanKeyword: "" }),
    products: { 900: PRODUCT },
    cfg: { sx: { p: ["777", "888"], live: false } },
  });
  sb2c.__item = LINE_PLAIN;
  ok(vm.runInContext("findPlanForItem(__item)", sb2c) === null,
    "v23: no keyword + owned plans but app in SETUP: fallback refuses (no proof-less enrollment)");

  // v40: SETUP with a FOREIGN discounted plan on the variant (888 is not
  // on the in-house list) — the native fallback returns that one and never
  // the dark in-house plan, although 777 comes first and is cheaper.
  const sb2d = makeSandbox({
    settings: Object.assign({}, SETTINGS, { sellingPlanKeyword: "" }),
    products: { 900: PRODUCT },
    cfg: { sx: { p: ["777"], live: false } },
  });
  sb2d.__item = LINE_PLAIN;
  const fbNative = vm.runInContext("findPlanForItem(__item)", sb2d);
  ok(!!fbNative && String(fbNative.id) === "888" && fbNative.allocPrice === 4655,
    "v40: SETUP + a non-in-house discounted plan: native fallback returns it, never the dark in-house 777");

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

// ============================================================================
// v40 — native selling plans (Joy Subscriptions). Fixture = the LIVE shape
// (cellular-renewal-cream, Spanish market, 2026-11-13): Joy "Every 2 Months"
// on the 1-unit variant only, Joy "Every 3 Months" on the 2/3-unit variants
// only, and the dark in-house app's three 0 % plans on EVERY variant at the
// one-time price. Joy's allocation comes first per variant.
// ============================================================================
const JOY_2M = 718347501943;
const JOY_3M = 718347534711;
const INHOUSE = ["718653555063", "718653587831", "718653620599"];
const inhouseAllocs = (price) => INHOUSE.map((id) => ({ planId: Number(id), price }));
const JOY_PRODUCT = {
  variants: [
    { id: 21, position: 1, price: 5700, available: true,
      planAllocations: [{ planId: JOY_2M, price: 5415 }].concat(inhouseAllocs(5700)) },
    { id: 22, position: 2, price: 9690, compare_at_price: 11400, available: true,
      planAllocations: [{ planId: JOY_3M, price: 9206 }].concat(inhouseAllocs(9690)) },
    { id: 23, position: 3, price: 13680, compare_at_price: 17100, available: true,
      planAllocations: [{ planId: JOY_3M, price: 12996 }].concat(inhouseAllocs(13680)) },
  ],
  sellingPlanGroups: [
    { name: "Every 2 months", plans: [{ id: JOY_2M, name: "Every 2 Months", valueType: "percentage", value: 5 }] },
    { name: "Every 3 months", plans: [{ id: JOY_3M, name: "Every 3 Months", valueType: "percentage", value: 5 }] },
    { name: "Main", plans: [
      { id: 718653555063, name: "Every 3 weeks", valueType: null, value: 0 },
      { id: 718653587831, name: "Every 2 months", valueType: null, value: 0 },
      { id: 718653620599, name: "Every 3 months", valueType: null, value: 0 },
    ] },
  ],
};
const SX_DARK = { p: INHOUSE, live: false };
const SX_LIVE = { p: INHOUSE, live: true };
const JOY_SETTINGS = Object.assign({}, SETTINGS, { sellingPlanKeyword: "Continuous Treatment" });
const LINE_JOY = {
  product_id: 950, variant_id: 21, quantity: 1,
  selling_plan_allocation: { selling_plan: { id: JOY_2M, name: "Every 2 Months" } },
};
const LINE_JOY_PLAIN = { product_id: 950, variant_id: 21, quantity: 1 };
const LINE_INHOUSE = {
  product_id: 950, variant_id: 21, quantity: 1,
  selling_plan_allocation: { selling_plan: { id: 718653587831, name: "Every 2 months" } },
};
const joyClone = () => JSON.parse(JSON.stringify(JOY_PRODUCT));

// --- v40 tier tiles for a Joy line --------------------------------------------
{
  const sb = makeSandbox({ settings: JOY_SETTINGS, products: { 950: JOY_PRODUCT }, cfg: { sx: SX_DARK } });
  const out = candidates(sb, LINE_JOY);
  ok(out.length === 2, "v40: Joy 1-unit line, in-house dark: BOTH pack tiers offered (got " + out.length + ")");
  ok(out.length === 2 && String(out[0].planId) === String(JOY_3M) && String(out[1].planId) === String(JOY_3M),
    "v40: each tier carries the TIER variant's own Joy plan id (Every 3 Months), never the line's");
  ok(out.length === 2 && out[0].addPriceCents === 9206 && out[0].perUnitCents === Math.round(9206 / 2) &&
    out[1].addPriceCents === 12996 && out[1].perUnitCents === Math.round(12996 / 3),
    "v40: tiles priced from the tier's own Joy allocation (9206 / 12996), never one-time");
  ok(out.length === 2 && !("planName" in out[0]) && !("planName" in out[1]),
    "v40.2: the tile candidate carries NO plan name (the frequency label was removed from the tile)");
  ok(out.length === 2 && out[0].percent === Math.round(((2 * 5700 - 9206) / (2 * 5700)) * 100),
    "v40: save badge vs qty x the full one-time 1-unit price (19%)");

  // The same cart line while the in-house app is LIVE: Joy lines stay inert.
  const live = makeSandbox({ settings: JOY_SETTINGS, products: { 950: JOY_PRODUCT }, cfg: { sx: SX_LIVE } });
  ok(candidates(live, LINE_JOY).length === 0,
    "v40: in-house app LIVE: a Joy line gets NO tile (the native family is off)");

  // Island absent and no proxy list yet: the in-house plan ids are unknown.
  const blind = makeSandbox({ settings: JOY_SETTINGS, products: { 950: JOY_PRODUCT } });
  ok(candidates(blind, LINE_JOY).length === 0,
    "v40: in-house plan ids unknown (no island, no proxy list): inert, fail closed");
  // ...and once the proxy's xp list landed, native works without the island.
  vm.runInContext("nativeDeny = " + JSON.stringify(INHOUSE), blind);
  ok(candidates(blind, LINE_JOY).length === 2,
    "v40: island absent + proxy xp loaded: the Joy line's tiles appear");
  const blindEmpty = makeSandbox({ settings: JOY_SETTINGS, products: { 950: JOY_PRODUCT } });
  vm.runInContext("nativeDeny = []", blindEmpty);
  ok(candidates(blindEmpty, LINE_JOY).length === 2,
    "v40: in-house app gone for good (xp = []): native still works");

  const b2b = makeSandbox({ settings: JOY_SETTINGS, products: { 950: JOY_PRODUCT }, cfg: { sx: SX_DARK }, win: { isB2BCustomer: true } });
  ok(candidates(b2b, LINE_JOY).length === 0, "v40: B2B: no native tiles");
  const off = makeSandbox({
    settings: Object.assign({}, JOY_SETTINGS, { subscriptionAware: false }),
    products: { 950: JOY_PRODUCT }, cfg: { sx: SX_DARK },
  });
  ok(candidates(off, LINE_JOY).length === 0, "v40: kill switch off: no native tiles");

  // Plain (one-time) lines are untouched by any of this.
  const plain = candidates(sb, LINE_JOY_PLAIN);
  ok(plain.length === 2 && plain[0].addPriceCents === 9690 && plain[0].planId === null,
    "v40: one-time line: one-time tiles, no plan id");
}

// --- v40 families never cross ---------------------------------------------------
{
  // A line on a (dark) IN-HOUSE plan: every tier allocates that exact plan,
  // so the pre-v40 exact path answers — and never hands out a Joy plan.
  const sb = makeSandbox({ settings: JOY_SETTINGS, products: { 950: JOY_PRODUCT }, cfg: { sx: SX_DARK } });
  const out = candidates(sb, LINE_INHOUSE);
  ok(out.length === 2 && out[0].planId === null && out[0].addPriceCents === 9690,
    "v40: in-house plan line: exact-plan tiles as before, planId null (never moved onto a Joy plan)");

  // The tier variant's in-house allocation gets a REAL discount and sits
  // first: the deny-list — not the price — keeps it out.
  const products = { 950: joyClone() };
  products[950].variants[1].planAllocations = [{ planId: 718653587831, price: 9000 }, { planId: JOY_3M, price: 9206 }];
  const sb2 = makeSandbox({ settings: JOY_SETTINGS, products, cfg: { sx: SX_DARK } });
  const out2 = candidates(sb2, LINE_JOY);
  ok(out2.length === 2 && String(out2[0].planId) === String(JOY_3M) && out2[0].addPriceCents === 9206,
    "v40: a discounted in-house allocation ordered first is NEVER the tier plan (deny-list)");

  // Tier variants carrying ONLY in-house allocations: nothing to move to.
  const only = { 950: joyClone() };
  only[950].variants[1].planAllocations = inhouseAllocs(9000);
  only[950].variants[2].planAllocations = inhouseAllocs(13000);
  const sb3 = makeSandbox({ settings: JOY_SETTINGS, products: only, cfg: { sx: SX_DARK } });
  ok(candidates(sb3, LINE_JOY).length === 0,
    "v40: tier variants with only in-house plans: no tile for a Joy line");
}

// --- v40 offerable rule + disclosure ---------------------------------------------
{
  // v40.2: the tile shows no plan name any more, so a tier plan whose name
  // is unknown (its group is missing from the product data) is offered like
  // any other — the allocation itself is what the add needs.
  const nameless = { 950: joyClone() };
  nameless[950].sellingPlanGroups.splice(1, 1);
  const sb = makeSandbox({ settings: JOY_SETTINGS, products: nameless, cfg: { sx: SX_DARK } });
  const outN = candidates(sb, LINE_JOY);
  ok(outN.length === 2 && String(outN[0].planId) === String(JOY_3M) && outN[0].addPriceCents === 9206,
    "v40.2: tier plan without a name: the tile is still offered on that plan");

  // Two offerable plans on the tier: the one NAMED like the line's plan
  // (same schedule) is the one the upgrade moves to.
  const same = { 950: joyClone() };
  same[950].variants[1].planAllocations = [{ planId: JOY_3M, price: 9206 }, { planId: 555001, price: 9300 }];
  same[950].sellingPlanGroups.push({ name: "Alt", plans: [{ id: 555001, name: "every 2 months", valueType: "percentage", value: 4 }] });
  const sb2 = makeSandbox({ settings: JOY_SETTINGS, products: same, cfg: { sx: SX_DARK } });
  const out2 = candidates(sb2, LINE_JOY);
  ok(out2.length === 2 && String(out2[0].planId) === "555001" && out2[0].addPriceCents === 9300,
    "v40: a tier plan named like the line's (case-insensitive) is preferred over an earlier one");

  // A 0 % Joy plan on the tier is no offer; a prepaid lump (above one-time)
  // is refused by the same strict rule.
  const zero = { 950: joyClone() };
  zero[950].variants[1].planAllocations = [{ planId: JOY_3M, price: 9690 }];
  zero[950].variants[2].planAllocations = [{ planId: JOY_3M, price: 41040 }];
  const sb3 = makeSandbox({ settings: JOY_SETTINGS, products: zero, cfg: { sx: SX_DARK } });
  ok(candidates(sb3, LINE_JOY).length === 0,
    "v40: tier allocation at the one-time price (0 %) or above it (prepaid): not offerable, no tile");

  // The LINE's own plan must itself be offerable — a 0 % line is no proof.
  const flat = { 950: joyClone() };
  flat[950].variants[0].planAllocations[0].price = 5700;
  const sb4 = makeSandbox({ settings: JOY_SETTINGS, products: flat, cfg: { sx: SX_DARK } });
  ok(candidates(sb4, LINE_JOY).length === 0,
    "v40: a line whose own plan is priced at one-time is not a native line: no tile");

  // A tier variant that DOES allocate the line's exact plan keeps the
  // pre-v40 exact path: same plan, no label, planId null.
  const exact = { 950: joyClone() };
  exact[950].variants[1].planAllocations = [{ planId: JOY_2M, price: 9100 }, { planId: JOY_3M, price: 9206 }];
  const sb5 = makeSandbox({ settings: JOY_SETTINGS, products: exact, cfg: { sx: SX_DARK } });
  const out5 = candidates(sb5, LINE_JOY);
  ok(out5.length === 2 && out5[0].addPriceCents === 9100 && out5[0].planId === null,
    "v40: tier that allocates the line's exact plan: the pre-v40 same-plan tile wins");
}

// --- v40 nativeLinePlan / nativeVariantAlloc directly ------------------------------
{
  const sb = makeSandbox({ settings: JOY_SETTINGS, products: { 950: JOY_PRODUCT }, cfg: { sx: SX_DARK } });
  sb.__joy = LINE_JOY;
  sb.__inh = LINE_INHOUSE;
  sb.__plain = LINE_JOY_PLAIN;
  const lp = vm.runInContext("nativeLinePlan(__joy)", sb);
  ok(!!lp && String(lp.planId) === String(JOY_2M) && lp.name === "Every 2 Months",
    "v40: nativeLinePlan names a Joy line's plan from the product data");
  ok(vm.runInContext("nativeLinePlan(__inh)", sb) === null, "v40: an in-house plan line is never native");
  ok(vm.runInContext("nativeLinePlan(__plain)", sb) === null, "v40: a one-time line is never native");
  sb.__v2 = JOY_PRODUCT.variants[1];
  sb.__p = JOY_PRODUCT;
  const va = vm.runInContext("nativeVariantAlloc(__p, __v2, 'Every 2 Months')", sb);
  ok(!!va && String(va.planId) === String(JOY_3M) && va.price === 9206 && va.name === "Every 3 Months",
    "v40: nativeVariantAlloc: no same-named plan on the variant -> its first offerable one");
  // Two offerable plans: the one named like the preference wins over order.
  const two = joyClone();
  two.variants[1].planAllocations = [{ planId: JOY_3M, price: 9206 }, { planId: JOY_2M, price: 9300 }];
  sb.__p2 = two;
  sb.__v22 = two.variants[1];
  const pref = vm.runInContext("nativeVariantAlloc(__p2, __v22, 'EVERY 2 MONTHS')", sb);
  ok(!!pref && String(pref.planId) === String(JOY_2M),
    "v40: nativeVariantAlloc prefers the plan named like the anchor (same schedule, case-insensitive)");
  ok(vm.runInContext("nativeAlloc({ price: 5700 }, { planId: 1, price: 5700 })", sb) === false &&
    vm.runInContext("nativeAlloc({ price: 5700 }, { planId: 1, price: 5699 })", sb) === true &&
    vm.runInContext("nativeAlloc({ price: 5700 }, { planId: 1, price: 0 })", sb) === false &&
    vm.runInContext("nativeAlloc({ price: 5700 }, { planId: 718653587831, price: 5000 })", sb) === false,
    "v40: nativeAlloc = strictly below one-time, positive, and not an in-house plan");
}

// --- v40 switch-card plan lookup (findPlanForItem) -----------------------------------
{
  const find = (sb, item) => { sb.__item = item; return vm.runInContext("findPlanForItem(__item)", sb); };
  // The live keyword ("Continuous Treatment") names NO current Joy plan or
  // group — that phrase is only Joy's widget label. The native fallback is
  // what finds the plan.
  const sb = makeSandbox({ settings: JOY_SETTINGS, products: { 950: JOY_PRODUCT }, cfg: { sx: SX_DARK } });
  const plan = find(sb, LINE_JOY_PLAIN);
  ok(!!plan && String(plan.id) === String(JOY_2M) && plan.allocPrice === 5415 && plan.name === "Every 2 Months",
    "v40: keyword matches nothing + in-house dark: fallback = the variant's Joy plan");
  sb.__plan = plan;
  ok(vm.runInContext("linePlanPercent(__item, __plan)", sb) === 5,
    "v40: the switch card's percent is the real allocation saving (5%)");

  const live = makeSandbox({ settings: JOY_SETTINGS, products: { 950: JOY_PRODUCT }, cfg: { sx: SX_LIVE } });
  const livePlan = find(live, LINE_JOY_PLAIN);
  ok(!!livePlan && INHOUSE.indexOf(String(livePlan.id)) !== -1,
    "v40: in-house app LIVE: the fallback is the owned in-house plan, exactly as v23 (never Joy's)");

  const blind = makeSandbox({ settings: JOY_SETTINGS, products: { 950: JOY_PRODUCT } });
  ok(find(blind, LINE_JOY_PLAIN) === null,
    "v40: in-house plan ids unknown: no keyword-less fallback (fail closed)");

  // In-house allocations FIRST and discounted: still Joy's plan.
  const reordered = { 950: joyClone() };
  reordered[950].variants[0].planAllocations = inhouseAllocs(5000).concat([{ planId: JOY_2M, price: 5415 }]);
  const sb2 = makeSandbox({ settings: JOY_SETTINGS, products: reordered, cfg: { sx: SX_DARK } });
  const p2 = find(sb2, LINE_JOY_PLAIN);
  ok(!!p2 && String(p2.id) === String(JOY_2M),
    "v40: discounted in-house allocations ordered first: the fallback still skips them");

  // Only in-house allocations on the variant: nothing to offer.
  const only = { 950: joyClone() };
  only[950].variants[0].planAllocations = inhouseAllocs(5000);
  const sb3 = makeSandbox({ settings: JOY_SETTINGS, products: only, cfg: { sx: SX_DARK } });
  ok(find(sb3, LINE_JOY_PLAIN) === null, "v40: only dark in-house plans on the variant: no switch plan");

  // A loose keyword that names BOTH apps' plans ("every"): with the
  // in-house app dark it may only ever resolve the Joy plan...
  const loose = Object.assign({}, JOY_SETTINGS, { sellingPlanKeyword: "every" });
  const sb4 = makeSandbox({ settings: loose, products: reordered, cfg: { sx: SX_DARK } });
  const p4 = find(sb4, LINE_JOY_PLAIN);
  ok(!!p4 && String(p4.id) === String(JOY_2M),
    "v40: keyword naming a DARK in-house plan first: skipped, the Joy plan is returned");
  const sb5 = makeSandbox({ settings: loose, products: only, cfg: { sx: SX_DARK } });
  ok(find(sb5, LINE_JOY_PLAIN) === null,
    "v40: keyword naming only dark in-house plans: null (no enrollment into a dark app)");
  // ...while LIVE the keyword keeps naming in-house plans, as before v40.
  const sb6 = makeSandbox({ settings: loose, products: reordered, cfg: { sx: SX_LIVE } });
  const p6 = find(sb6, LINE_JOY_PLAIN);
  ok(!!p6 && INHOUSE.indexOf(String(p6.id)) !== -1,
    "v40: in-house LIVE: the keyword still resolves the in-house plan (unchanged)");
}

// ============================================================================
// v41 — the NEW subscriptions app (Cellexia Subscriptions, SPEC-v41)
//
// Fixture = the store since 2026-11-18: Joy's 5 % plans (listed first) AND
// one plan of the new app per size, at the size's own price (group app
// "cellexia-subscriptions": 4 / 8 / 12 weeks). The old in-house group is
// gone from the products; cfg.sx still carries its three ids (leftover
// metafields). cfg.cs === 1 = the new app offers subscriptions to this
// visitor's country.
// ============================================================================
{
  const CS4 = 719235481975, CS8 = 719235514743, CS12 = 719235547511;
  const csProduct = (cs, csFirst) => {
    cs = cs || [5700, 9690, 13680];
    const pair = (joy, own) => (csFirst ? [own, joy] : [joy, own]);
    return {
      variants: [
        { id: 21, position: 1, price: 5700, available: true,
          planAllocations: pair({ planId: JOY_2M, price: 5415 }, { planId: CS4, price: cs[0] }) },
        { id: 22, position: 2, price: 9690, compare_at_price: 11400, available: true,
          planAllocations: pair({ planId: JOY_3M, price: 9206 }, { planId: CS8, price: cs[1] }) },
        { id: 23, position: 3, price: 13680, compare_at_price: 17100, available: true,
          planAllocations: pair({ planId: JOY_3M, price: 12996 }, { planId: CS12, price: cs[2] }) },
      ],
      sellingPlanGroups: [
        { name: "Every 2 months", app: "gid://shopify/AppInstallation/839816774007", plans: [{ id: JOY_2M, name: "Every 2 Months", valueType: "percentage", value: 5 }] },
        { name: "Every 3 months", app: "gid://shopify/AppInstallation/839816774007", plans: [{ id: JOY_3M, name: "Every 3 Months", valueType: "percentage", value: 5 }] },
        { name: "Subscription", app: "cellexia-subscriptions", plans: [
          { id: CS4, name: "Delivered every 4 weeks", valueType: null, value: 0 },
          { id: CS8, name: "Delivered every 8 weeks", valueType: null, value: 0 },
          { id: CS12, name: "Delivered every 12 weeks", valueType: null, value: 0 },
        ] },
      ],
    };
  };
  const LINE_CS = { product_id: 950, variant_id: 21, quantity: 1,
    selling_plan_allocation: { selling_plan: { id: CS4, name: "Delivered every 4 weeks" } } };
  const LINE_CS_2 = { product_id: 950, variant_id: 22, quantity: 1,
    selling_plan_allocation: { selling_plan: { id: CS8, name: "Delivered every 8 weeks" } } };
  const ON = { sx: SX_DARK, cs: 1 };   // Luxembourg
  const OFF = { sx: SX_DARK };         // France, Spain, ...
  const sbOf = (cfg, product, extra) => makeSandbox(Object.assign({ settings: JOY_SETTINGS, products: { 950: product || csProduct() }, cfg }, extra || {}));
  const find = (sb, item) => { sb.__item = item; return vm.runInContext("findPlanForItem(__item)", sb); };

  // --- the bigger-pack tile of a line subscribed on the new app's plan
  {
    const sb = sbOf(ON);
    ok(vm.runInContext("csOn()", sb) === true && vm.runInContext("nativeSubs()", sb) === false,
      "v41: where the new app is on, it is the only family (native stands down)");
    const out = candidates(sb, LINE_CS);
    ok(out.length === 2, "v41: a line on the new app's plan gets BOTH pack tiles (got " + out.length + ")");
    ok(out.length === 2 && String(out[0].planId) === String(CS8) && String(out[1].planId) === String(CS12),
      "v41: each tile carries THAT PACK'S OWN plan of the new app (8 weeks, 12 weeks) — never the line's, never Joy's");
    ok(out.length === 2 && out[0].addPriceCents === 9690 && out[0].perUnitCents === 4845 &&
      out[1].addPriceCents === 13680 && out[1].perUnitCents === 4560,
      "v41: tiles priced from the pack's own allocation — today the pack's price (96.90 / 136.80), not Joy's 92.06 / 129.96");
    ok(out.length === 2 && out[0].percent === 15 && out[1].percent === 20,
      "v41: save badge = the pack saving against the 1-unit subscription price (15 % / 20 %)");
    ok(out.length === 2 && !("planName" in out[0]), "v41: price only — the tile carries no plan name");

    // from the 2-unit pack: one tile, the 3-unit pack on its 12-week plan
    const up = candidates(sb, LINE_CS_2);
    ok(up.length === 1 && String(up[0].planId) === String(CS12) && up[0].addPriceCents === 13680,
      "v41: a subscribed 2-unit line upgrades to the 3-unit pack on its own plan");

    // "Buy once": a one-time line keeps one-time tiles
    const plain = candidates(sb, LINE_JOY_PLAIN);
    ok(plain.length === 2 && plain[0].planId === null && plain[0].addPriceCents === 9690 && plain[1].addPriceCents === 13680,
      "v41: a one-time line (Buy once) upgrades to a one-time bigger pack, no plan");
  }

  // --- the day the subscription is cheaper than a one-time purchase
  {
    const sb = sbOf(ON, csProduct([5400, 9180, 12960]));
    const out = candidates(sb, LINE_CS);
    ok(out.length === 2 && out[0].addPriceCents === 9180 && out[1].addPriceCents === 12960 &&
      String(out[0].planId) === String(CS8),
      "v41 cheaper plans: tiles at the new app's prices (91.80 / 129.60)");
    ok(out.length === 2 && out[0].percent === Math.round(((2 * 5400 - 9180) / (2 * 5400)) * 100),
      "v41 cheaper plans: the badge compares with what this subscriber pays per unit (54.00), not the dearer one-time price");
    // listed first or last: no difference
    const first = candidates(sbOf(ON, csProduct([5400, 9180, 12960], true)), LINE_CS);
    ok(first.length === 2 && String(first[0].planId) === String(CS8) && first[0].addPriceCents === 9180,
      "v41: the order of the allocations does not matter");
  }

  // --- no plan of the new app on the bigger pack: no tile (never drop, never borrow)
  {
    const p = csProduct();
    p.variants[1].planAllocations = [{ planId: JOY_3M, price: 9206 }];
    const out = candidates(sbOf(ON, p), LINE_CS);
    ok(out.length === 1 && out[0].quantity === 3,
      "v41: a pack without a plan of the new app gets no tile for a subscribed line (Joy's plan is not borrowed)");
  }

  // --- gates
  {
    ok(candidates(sbOf(ON, null, { settings: Object.assign({}, JOY_SETTINGS, { subscriptionAware: false }) }), LINE_CS).length === 0,
      "v41: kill switch off: no tile on a subscribed line (the v17 safe-inert state)");
    const b2b = sbOf(ON, null, { win: { isB2BCustomer: true } });
    ok(vm.runInContext("csOffered()", b2b) === false && candidates(b2b, LINE_CS).length === 0,
      "v41: B2B: the new app is not offered, a line on its plan is left alone");
    // a Joy line in a country where the new app is on: no tile
    ok(candidates(sbOf(ON), LINE_JOY).length === 0,
      "v41: a line on another app's plan where the new app is on: no tile");
  }

  // --- a country where the new app is NOT offered
  {
    const sb = sbOf(OFF);
    ok(vm.runInContext("csOn()", sb) === false, "v41 off: no cs member in the island = not offered");
    ok(candidates(sb, LINE_CS).length === 0,
      "v41 off: a line that carries the new app's plan is left alone (no tile)");
    // Joy exactly as v40, with the new app's plans on the same variants
    const joy = candidates(sb, LINE_JOY);
    ok(joy.length === 2 && String(joy[0].planId) === String(JOY_3M) && joy[0].addPriceCents === 9206 && joy[1].addPriceCents === 12996 &&
      joy[0].percent === Math.round(((2 * 5700 - 9206) / (2 * 5700)) * 100),
      "v41 off: a Joy line's tiles are the v40 tiles (9206 / 12996 on Every 3 Months)");
    // ...even when the new app's plans are cheaper than Joy's and listed first
    const cheap = sbOf(OFF, csProduct([5000, 9000, 12000], true));
    const joy2 = candidates(cheap, LINE_JOY);
    ok(joy2.length === 2 && String(joy2[0].planId) === String(JOY_3M) && joy2[0].addPriceCents === 9206,
      "v41 off: a cheaper plan of the new app listed first is never a Joy line's tier plan");
    const plain = candidates(sb, LINE_JOY_PLAIN);
    ok(plain.length === 2 && plain[0].planId === null && plain[0].addPriceCents === 9690,
      "v41 off: one-time tiles unchanged");
  }

  // --- the "switch to subscription" card
  {
    ok(find(sbOf(ON), LINE_JOY_PLAIN) === null,
      "v41: no switch card where the new app is on (it would pick Joy's plan there)");
    ok(find(sbOf(ON, csProduct([5000, 9000, 12000], true)), LINE_JOY_PLAIN) === null,
      "v41: ...not with a cheaper plan of the new app either");
    ok(find(sbOf(ON, null, { settings: Object.assign({}, JOY_SETTINGS, { sellingPlanKeyword: "every" }) }), LINE_JOY_PLAIN) === null,
      "v41: ...and not through the keyword");
    // elsewhere: Joy's plan as in v40, never a plan of the new app
    const off = find(sbOf(OFF), LINE_JOY_PLAIN);
    ok(!!off && String(off.id) === String(JOY_2M) && off.allocPrice === 5415,
      "v41 off: the card's plan is Joy's, as in v40");
    const offCheap = find(sbOf(OFF, csProduct([5000, 9000, 12000], true)), LINE_JOY_PLAIN);
    ok(!!offCheap && String(offCheap.id) === String(JOY_2M),
      "v41 off: a cheaper plan of the new app listed first is skipped for Joy's");
    // a keyword that names the new app's plans ("delivered") resolves nothing
    const kw = Object.assign({}, JOY_SETTINGS, { sellingPlanKeyword: "delivered" });
    const p = csProduct();
    p.variants[0].planAllocations = [{ planId: CS4, price: 5700 }];
    ok(find(sbOf(OFF, p, { settings: kw }), LINE_JOY_PLAIN) === null,
      "v41 off: a keyword naming the new app's plan never enrolls a line into it");
    const kwGroup = Object.assign({}, JOY_SETTINGS, { sellingPlanKeyword: "subscription" });
    ok(find(sbOf(OFF, p, { settings: kwGroup }), LINE_JOY_PLAIN) === null,
      "v41 off: ...nor does one naming its group (\"Subscription\")");
  }

  // --- the readers themselves
  {
    const sb = sbOf(ON);
    ok(vm.runInContext("csPlan(" + CS4 + ")", sb) === true && vm.runInContext("csPlan('" + CS12 + "')", sb) === true &&
      vm.runInContext("csPlan(" + JOY_2M + ")", sb) === false && vm.runInContext("csPlan(null)", sb) === false,
      "v41: a plan is the new app's when its group's app is cellexia-subscriptions (number or string id)");
    sb.__v = csProduct().variants[1];
    const a = vm.runInContext("csAlloc(__v)", sb);
    ok(!!a && String(a.planId) === String(CS8) && a.price === 9690, "v41: csAlloc = the variant's own allocation on that app's plan");
    sb.__none = { price: 5700, planAllocations: [{ planId: JOY_2M, price: 5415 }] };
    ok(vm.runInContext("csAlloc(__none)", sb) === null, "v41: a variant with only another app's plan has none");
    sb.__zero = { price: 5700, planAllocations: [{ planId: CS4, price: 0 }] };
    sb.__lump = { price: 5700, planAllocations: [{ planId: CS4, price: 17100 }] };
    ok(vm.runInContext("csAlloc(__zero)", sb) === null && vm.runInContext("csAlloc(__lump)", sb) === null,
      "v41: an unusable price (zero, or above one-time) is no allocation");
    // learned once, kept: entries replaced by ones without \"app\" (an older server) do not unlearn
    vm.runInContext("csPlan(1)", sb);
    const stripped = csProduct();
    stripped.sellingPlanGroups.forEach((g) => { delete g.app; });
    sb.state.products = { 950: stripped };
    ok(vm.runInContext("csPlan(" + CS8 + ")", sb) === true,
      "v41: plan ids once learned survive product data that lacks the app member");
    const blind = sbOf(ON, stripped);
    ok(candidates(blind, LINE_CS).length === 0 && vm.runInContext("csPlan(" + CS4 + ")", blind) === false,
      "v41: plans of the new app unknown: a subscribed line gets no tile (never a one-time or borrowed one)");
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${checks} CHECKS FAILED`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED (subscribed-upgrade plan-allocation gate vs the real cellexia-cart.js)`);
