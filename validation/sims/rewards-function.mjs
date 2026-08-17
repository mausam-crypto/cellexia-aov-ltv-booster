/**
 * Rewards Function sim (v14) — executes the REAL pure logic of the
 * "Cellexia rewards" Discount Function (extensions/cellexia-rewards/src/logic.js,
 * imported directly, no copies) against fixture inputs shaped like the
 * Discount Function API 2025-10 input (SPEC-v14-rewards §8):
 *
 *  - config selection: missing metafield / null jsonValue / empty cart → no
 *    operations; draft picked ONLY when the cart's _cx_preview attribute
 *    equals the armed hash;
 *  - KIT code node: grant on the exact qualifying code (targets every
 *    eligible line, FIRST, associatedDiscountCode), refuse a wrong/higher
 *    code, refuse below tier; gift lines, sachets, protection, per-market
 *    exclusions never count (sachets neither as products nor, v14.1, as
 *    spend); subscription toggle; market scope allow/deny;
 *    merchant message with {pct};
 *  - gift node: reached tier via market amounts (cart currency) vs EUR × rate;
 *    cumulative on/off; samples cap; max-lines cap; a gift line whose
 *    variant is not in the granted pool stays paid; every candidate targets
 *    quantity 1 with "100.0"; ONE productDiscountsAdd with ALL;
 *  - delivery node: units rule via the units map (a "2 Jars" variant counts
 *    2), threshold rule in the market currency and via the EUR fallback,
 *    cheapest option only, zero-cost options skipped, wrong class → nothing;
 *  - market resolution: localization.market.handle wins, cfg.cm[country]
 *    is the fallback; codes compare case-insensitively; v15: NO alias codes
 *    (a stale ss.alias list is ignored, ladder codes stay exact-match, the
 *    SET preset codes work like any code); a per-market
 *    gift amount is honoured only when > 0 (else EUR × rate, like the storefront);
 *  - the run wrappers never throw.
 *
 * Offline + deterministic by construction (no Date, no network).
 */
import { makeChecker } from "../lib/util.mjs";
import {
  selectConfig,
  marketFor,
  marketOf,
  scopeOk,
  numId,
  pctString,
  computeKit,
  computeGifts,
  computeShipping,
  cartLinesOperations,
  deliveryOperations,
} from "../../extensions/cellexia-rewards/src/logic.js";
import { cartLinesDiscountsGenerateRun } from "../../extensions/cellexia-rewards/src/cart_lines_discounts_generate_run.js";
import { cartDeliveryOptionsDiscountsGenerateRun } from "../../extensions/cellexia-rewards/src/cart_delivery_options_discounts_generate_run.js";

const { ok, finish } = makeChecker("sims/rewards-function");

// --- fixtures ----------------------------------------------------------------
// Variants: 11/12/13 = cream product 1 (1/2/3 jars), 21 = product 2, 31 = product 3,
// 41 = product 4, 51 = product 5, 90 = protection (product 9), 71/72 = sachets
// (product 7/8, tagged), 61 = gift jawline (product 6), 62 = towels (product 60),
// 63 = bag (product 600).
const LIVE = {
  ss: {
    on: true,
    tiers: [
      { n: 2, p: 5, c: "KIT2" },
      { n: 3, p: 10, c: "KIT3" },
      { n: 5, p: 20, c: "KIT5" },
      { n: 10, p: 30, c: "KIT10" },
    ],
    sub: true,
    scope: { mode: "all", markets: [] },
    excl: { usa: ["4"] },
    msg: "",
  },
  gt: {
    on: true,
    cum: true,
    max: 4,
    tiers: [
      { eur: 119, slots: [[{ k: "v", vid: "61" }], [{ k: "s", n: 2 }]] },
      { eur: 200, slots: [[{ k: "v", vid: "62" }], [{ k: "s", n: 2 }]] },
      { eur: 350, slots: [[{ k: "v", vid: "63" }], [{ k: "s", n: 3 }]] },
    ],
    bm: { usa: { a: [129, 219, 379], c: "USD" }, france: { a: [119, 200, 350], c: "EUR" } },
    pool: ["71", "72"],
    scope: { mode: "all", markets: [] },
  },
  fs: {
    on: true,
    min: 2,
    th: true,
    bm: { france: { a: 150, c: "EUR" }, usa: { a: 99, c: "USD" }, ch: { a: 100, c: "CHF" } },
    scope: { mode: "all", markets: [] },
  },
  units: { 12: 2, 13: 3 },
  prot: "9",
  giftPids: ["6", "60", "600", "7", "8"],
  cm: { US: "usa", FR: "france", DE: "eu", CH: "ch", AU: "australia" },
};

const DRAFT = JSON.parse(JSON.stringify(LIVE));
DRAFT.ss.tiers = [{ n: 2, p: 15, c: "KIT2" }];
DRAFT.ss.msg = "Bundle {pct}% off";

const MF = { v: 1, ph: "abc123", live: LIVE, draft: DRAFT };

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Build a cart line. opts: {vid, pid, amount, qty, gift, tag, sub, cur} */
let lineSeq = 0;
function line(vid, pid, amount, opts = {}) {
  lineSeq += 1;
  return {
    id: `gid://shopify/CartLine/${lineSeq}`,
    quantity: opts.qty ?? 1,
    attribute: opts.gift ? { value: String(opts.gift) } : null,
    cost: { subtotalAmount: { amount: String(amount), currencyCode: opts.cur ?? "EUR" } },
    merchandise: {
      __typename: "ProductVariant",
      id: `gid://shopify/ProductVariant/${vid}`,
      product: { id: `gid://shopify/Product/${pid}`, hasAnyTag: !!opts.tag },
    },
    sellingPlanAllocation: opts.sub ? { sellingPlan: { id: "gid://shopify/SellingPlan/1" } } : null,
  };
}

function input({
  lines = [],
  classes = ["PRODUCT"],
  code = null,
  country = "FR",
  market = null,
  rate = "1.0",
  mf = MF,
  preview = null,
  groups = [],
} = {}) {
  return {
    cart: {
      attribute: preview == null ? null : { value: preview },
      lines,
      deliveryGroups: groups,
    },
    discount: { discountClasses: classes },
    triggeringDiscountCode: code,
    localization: { market: market == null ? null : { handle: market }, country: { isoCode: country } },
    presentmentCurrencyRate: rate,
    shop: { metafield: mf === null ? null : { jsonValue: mf } },
  };
}

const firstOp = (ops) => (ops.length ? ops[0] : null);
const kitCand = (ops) => firstOp(ops)?.productDiscountsAdd?.candidates?.[0] ?? null;

// --- helpers -----------------------------------------------------------------
ok(numId("gid://shopify/ProductVariant/123") === "123", "numId strips the GID prefix");
ok(numId("123") === "123" && numId(null) === "", "numId passes numeric strings through, null → ''");
ok(pctString(5) === "5.0" && pctString(100) === "100.0" && pctString(12.5) === "12.5", "pctString matches the JS example format");
ok(marketFor(LIVE, "US") === "usa" && marketFor(LIVE, "us") === "usa" && marketFor(LIVE, "XX") === "", "marketFor maps ISO2 → market handle, unknown → ''");
ok(scopeOk({ mode: "all", markets: [] }, "usa") && scopeOk(null, "usa"), "scopeOk: all / missing scope allow");
ok(scopeOk({ mode: "selected", markets: ["usa"] }, "usa") && !scopeOk({ mode: "selected", markets: ["usa"] }, "france"), "scopeOk: selected allows listed only");
ok(marketOf(LIVE, input({ country: "US", market: "canada" })) === "canada", "marketOf: localization.market.handle wins over the country → cm map");
ok(marketOf(LIVE, input({ country: "US" })) === "usa", "marketOf: no market handle → cm[country] fallback");
ok(marketOf(LIVE, input({ country: "US", market: "  " })) === "usa", "marketOf: blank market handle → cm fallback");
ok(marketOf(LIVE, { localization: null }) === "", "marketOf: no localization at all → ''");

// --- config selection --------------------------------------------------------
ok(selectConfig(null, null) === null, "missing metafield → null config");
ok(selectConfig({ v: 1, ph: "", live: null, draft: null }, null) === null, "null live → null config");
ok(selectConfig(MF, null) === LIVE, "no preview attribute → live");
ok(selectConfig(MF, "wrong") === LIVE, "wrong preview hash → live");
ok(selectConfig(MF, "abc123") === DRAFT, "matching preview hash → draft");
ok(selectConfig({ ...MF, ph: "" }, "") === LIVE, "empty ph never selects draft even when attribute is empty");
ok(selectConfig(JSON.stringify(MF), "abc123").ss.msg === "Bundle {pct}% off", "string jsonValue is parsed defensively");
ok(cartLinesOperations(input({ mf: null, code: "KIT2", lines: [line(11, 1, 50), line(21, 2, 50)] })).length === 0, "no metafield → no operations (KIT)");
ok(cartLinesOperations(input({ code: "KIT2", lines: [] })).length === 0, "empty cart → no operations");
ok(cartLinesDiscountsGenerateRun(undefined).operations.length === 0, "cart-lines run wrapper never throws on undefined input");
ok(cartDeliveryOptionsDiscountsGenerateRun(null).operations.length === 0, "delivery run wrapper never throws on null input");

// --- KIT ---------------------------------------------------------------------
{
  const two = [line(11, 1, 57), line(21, 2, 57)];
  const ops = computeKit(LIVE, input({ lines: two, code: "KIT2" }));
  const c = kitCand(ops);
  ok(ops.length === 1 && c && c.value.percentage.value === "5.0", "KIT2 granted on 2 different products at 5.0");
  ok(c && c.targets.length === 2 && c.targets.every((t) => t.cartLine.id && t.cartLine.quantity === undefined), "KIT targets every eligible line, full quantity");
  ok(c && c.associatedDiscountCode.code === "KIT2" && ops[0].productDiscountsAdd.selectionStrategy === "FIRST", "KIT candidate carries associatedDiscountCode + FIRST");
  ok(c && c.message === "Set savings -5%", "default KIT message uses hyphen-minus and the pct");
  ok(computeKit(LIVE, input({ lines: two, code: "KIT3" })).length === 0, "KIT3 refused when only 2 products qualify (wrong code)");
  ok(computeKit(LIVE, input({ lines: [line(11, 1, 57)], code: "KIT2" })).length === 0, "KIT2 refused below tier (1 product)");
  ok(computeKit(LIVE, input({ lines: two, code: "KIT2", classes: ["ORDER"] })).length === 0, "KIT: wrong discount class → nothing");
  ok(computeKit(LIVE, input({ lines: two, code: null })).length === 0, "KIT: no triggering code → nothing");
  ok(cartLinesOperations(input({ lines: two, code: "KIT2" })).length === 1, "cartLinesOperations routes a triggering code to KIT");
  const lc = kitCand(computeKit(LIVE, input({ lines: two, code: "kit2" })));
  ok(lc && lc.value.percentage.value === "5.0" && lc.associatedDiscountCode.code === "kit2", "KIT code compared case-insensitively (kit2 == KIT2), associatedDiscountCode echoes the typed code");
  const mixed = clone(LIVE);
  mixed.ss.tiers[0].c = "Kit2";
  ok(computeKit(mixed, input({ lines: two, code: "KIT2" })).length === 1, "KIT tier code stored in mixed case still matches");
}
{
  // same product twice (1 jar + 3 jars) is ONE product
  const ops = computeKit(LIVE, input({ lines: [line(11, 1, 57), line(13, 1, 140)], code: "KIT2" }));
  ok(ops.length === 0, "two variants of the same product count as one product");
}
{
  // gift, sachet (tag), sachet (pool), protection lines never count / never discounted
  const lines = [line(11, 1, 57), line(61, 6, 37, { gift: 1 }), line(71, 7, 1, { tag: true }), line(72, 8, 1), line(90, 9, 3)];
  ok(computeKit(LIVE, input({ lines, code: "KIT2" })).length === 0, "gift + sachets + protection do not count toward KIT2");
  const lines2 = [...lines, line(21, 2, 57)];
  const c = kitCand(computeKit(LIVE, input({ lines: lines2, code: "KIT2" })));
  ok(c && c.targets.length === 2, "gift/sachet/protection lines are not KIT targets (only the 2 eligible lines)");
}
{
  // three products with KIT3 = 10 %; KIT5 refused
  const three = [line(11, 1, 57), line(21, 2, 57), line(31, 3, 57)];
  ok(kitCand(computeKit(LIVE, input({ lines: three, code: "KIT3" })))?.value.percentage.value === "10.0", "KIT3 granted at 10.0 on 3 products");
  ok(computeKit(LIVE, input({ lines: three, code: "KIT5" })).length === 0, "KIT5 refused on 3 products");
  ok(computeKit(LIVE, input({ lines: three, code: "KIT2" })).length === 0, "KIT2 refused when the cart qualifies for KIT3 (only the exact tier code)");
}
{
  // v15: NO alias codes. A stale pre-v15 metafield may still carry ss.alias
  // — the Function ignores it: only the exact qualifying ladder code grants;
  // the store's own historical KIT codes are never ours (the storefront /
  // checkout step aside for them via yieldToCodes, the Function never sees
  // them as triggeringDiscountCode).
  const stale = clone(LIVE);
  stale.ss.alias = ["KIT4", "KIT6"];
  const three = [line(11, 1, 57), line(21, 2, 57), line(31, 3, 57)];
  const two = [line(11, 1, 57), line(21, 2, 57)];
  ok(computeKit(stale, input({ lines: three, code: "KIT4" })).length === 0, "v15: a stale ss.alias list is ignored — non-ladder code KIT4 grants nothing on 3 products");
  ok(computeKit(stale, input({ lines: two, code: "KIT6" })).length === 0, "v15: stale alias KIT6 grants nothing on 2 products");
  ok(computeKit(stale, input({ lines: two, code: "kit6" })).length === 0, "v15: stale alias compared case-insensitively still grants nothing");
  ok(computeKit(stale, input({ lines: three, code: "KIT2" })).length === 0, "v15: ladder code KIT2 exact-match only (cart qualifies for KIT3)");
  ok(computeKit(stale, input({ lines: three, code: "KIT5" })).length === 0, "v15: ladder code KIT5 refused on 3 products (ladder codes never over-grant)");
  ok(computeKit(stale, input({ lines: three, code: "KIT7" })).length === 0, "v15: unknown code grants nothing");
  ok(computeKit(LIVE, input({ lines: three, code: "KIT4" })).length === 0, "v15: no alias list → non-ladder code grants nothing");
  ok(kitCand(computeKit(stale, input({ lines: three, code: "kit3" })))?.value.percentage.value === "10.0", "v15: the exact qualifying ladder code still grants (case-insensitive)");
  // v15 SET codes: the shipped presets use app-owned SET codes; the Function
  // treats any code string alike (config-driven).
  const setCfg = clone(LIVE);
  setCfg.ss.tiers = [{ n: 2, p: 5, c: "SET2" }, { n: 3, p: 10, c: "SET3" }, { n: 4, p: 15, c: "SET4" }, { n: 6, p: 20, c: "SET6" }];
  const s3 = kitCand(computeKit(setCfg, input({ lines: three, code: "SET3" })));
  ok(s3 && s3.value.percentage.value === "10.0" && s3.associatedDiscountCode.code === "SET3", "v15: SET3 grants 10.0 on 3 products (compact preset codes)");
  ok(computeKit(setCfg, input({ lines: three, code: "KIT3" })).length === 0, "v15: the store's own KIT3 typed on a SET-ladder cart grants nothing from our Function (Shopify applies the merchant's own discount instead)");
}
{
  // subscription toggle
  const lines = [line(11, 1, 57), line(21, 2, 54, { sub: true })];
  ok(computeKit(LIVE, input({ lines, code: "KIT2" })).length === 1, "subscription line counts when sub=true");
  const noSub = clone(LIVE);
  noSub.ss.sub = false;
  ok(computeKit(noSub, input({ lines, code: "KIT2" })).length === 0, "subscription line ignored when sub=false");
}
{
  // market scope + per-market exclusion
  const scoped = clone(LIVE);
  scoped.ss.scope = { mode: "selected", markets: ["france"] };
  const two = [line(11, 1, 57), line(21, 2, 57)];
  ok(computeKit(scoped, input({ lines: two, code: "KIT2", country: "FR" })).length === 1, "market scope allows france");
  ok(computeKit(scoped, input({ lines: two, code: "KIT2", country: "US" })).length === 0, "market scope denies usa");
  ok(computeKit(scoped, input({ lines: two, code: "KIT2", country: "XX" })).length === 0, "unknown country → market '' denied by selected scope");
  ok(computeKit(scoped, input({ lines: two, code: "KIT2", country: "US", market: "france" })).length === 1, "market handle from localization wins over cm[US] for the scope check");
  ok(computeKit(scoped, input({ lines: two, code: "KIT2", country: "FR", market: "usa" })).length === 0, "market handle 'usa' denied even though cm[FR]=france");
  ok(computeKit(scoped, input({ lines: two, code: "KIT2", country: "FR", market: "" })).length === 1, "empty market handle → cm fallback (france allowed)");
  const usLines = [line(11, 1, 57), line(41, 4, 57)];
  ok(computeKit(LIVE, input({ lines: usLines, code: "KIT2", country: "US" })).length === 0, "product 4 excluded in usa → only 1 product, KIT2 refused");
  ok(computeKit(LIVE, input({ lines: usLines, code: "KIT2", country: "FR" })).length === 1, "same cart in france → KIT2 granted (exclusion is per market)");
  const off = clone(LIVE);
  off.ss.on = false;
  ok(computeKit(off, input({ lines: two, code: "KIT2" })).length === 0, "ss.on=false → KIT refused");
}
{
  // draft selection via preview hash + merchant message
  const two = [line(11, 1, 57), line(21, 2, 57)];
  const c = kitCand(cartLinesOperations(input({ lines: two, code: "KIT2", preview: "abc123" })));
  ok(c && c.value.percentage.value === "15.0" && c.message === "Bundle 15% off", "draft tiers + msg used when _cx_preview matches ph");
  const c2 = kitCand(cartLinesOperations(input({ lines: two, code: "KIT2", preview: "nope" })));
  ok(c2 && c2.value.percentage.value === "5.0", "wrong preview hash falls back to live tiers");
}

// --- gifts -------------------------------------------------------------------
{
  // spend 120 EUR in france (market EUR amounts) → tier 1 → gift 61 free, qty 1
  const lines = [line(11, 1, 60), line(21, 2, 60), line(61, 6, 37, { gift: 1, qty: 2 })];
  const ops = computeGifts(LIVE, input({ lines }));
  const add = firstOp(ops)?.productDiscountsAdd;
  ok(ops.length === 1 && add.selectionStrategy === "ALL", "gift op is ONE productDiscountsAdd with ALL");
  ok(add.candidates.length === 1 && add.candidates[0].targets[0].cartLine.quantity === 1 && add.candidates[0].value.percentage.value === "100.0", "gift candidate: 100.0 on quantity 1 (extra unit stays paid)");
  ok(add.candidates[0].message === "Free gift", "gift message");
  ok(cartLinesOperations(input({ lines })).length === 1, "cartLinesOperations routes no-code runs to gifts");
  ok(computeGifts(LIVE, input({ lines, classes: ["SHIPPING"] })).length === 0, "gifts: wrong discount class → nothing");
}
{
  // below tier: 118 EUR → gift line stays paid
  const lines = [line(11, 1, 118), line(61, 6, 37, { gift: 1 })];
  ok(computeGifts(LIVE, input({ lines })).length === 0, "spend below tier 1 → gift stays paid");
  // gift line's own price does not count toward spend, protection neither
  const lines2 = [line(11, 1, 100), line(61, 6, 37, { gift: 1 }), line(90, 9, 30)];
  ok(computeGifts(LIVE, input({ lines: lines2 })).length === 0, "gift + protection amounts do not count toward spend");
  // v14.1: a paid sachet line does NOT count toward spend (mirrors the storefront rwSpendCents)
  const lines3 = [line(11, 1, 118), line(71, 7, 1, { tag: true }), line(61, 6, 37, { gift: 1 })];
  ok(computeGifts(LIVE, input({ lines: lines3 })).length === 0, "paid sachet (tag) does not count toward spend (118 + 1 sachet stays below tier 1)");
  const lines3b = [line(11, 1, 118), line(72, 8, 1), line(61, 6, 37, { gift: 1 })];
  ok(computeGifts(LIVE, input({ lines: lines3b })).length === 0, "paid sachet (pool) does not count toward spend either");
  const lines3c = [line(11, 1, 119), line(71, 7, 5, { tag: true }), line(61, 6, 37, { gift: 1 })];
  ok(computeGifts(LIVE, input({ lines: lines3c })).length === 1, "full-size 119 reaches tier 1 with sachets present (sachets are simply ignored)");
}
{
  // market amounts in cart currency vs EUR × rate
  const usd = [line(11, 1, 125, { cur: "USD" }), line(61, 6, 40, { gift: 1, cur: "USD" })];
  ok(computeGifts(LIVE, input({ lines: usd, country: "US", rate: "1.1" })).length === 0, "usa: 125 USD < 129 USD market amount (EUR×rate NOT used when market entry matches currency)");
  const usd2 = [line(11, 1, 129, { cur: "USD" }), line(61, 6, 40, { gift: 1, cur: "USD" })];
  ok(computeGifts(LIVE, input({ lines: usd2, country: "US", rate: "1.1" })).length === 1, "usa: 129 USD reaches the market amount");
  // australia has no bm entry → EUR × rate (119 × 1.6 = 190.4 AUD)
  const aud = [line(11, 1, 190, { cur: "AUD" }), line(61, 6, 40, { gift: 1, cur: "AUD" })];
  ok(computeGifts(LIVE, input({ lines: aud, country: "AU", rate: "1.6" })).length === 0, "australia: 190 AUD < 119 EUR × 1.6");
  const aud2 = [line(11, 1, 190.4, { cur: "AUD" }), line(61, 6, 40, { gift: 1, cur: "AUD" })];
  ok(computeGifts(LIVE, input({ lines: aud2, country: "AU", rate: "1.6" })).length === 1, "australia: 190.40 AUD reaches 119 EUR × 1.6");
  // usa entry is USD but the cart is in EUR (mismatch) → EUR fallback
  const eurUs = [line(11, 1, 119), line(61, 6, 37, { gift: 1 })];
  ok(computeGifts(LIVE, input({ lines: eurUs, country: "US", rate: "1.0" })).length === 1, "market entry currency ≠ cart currency → EUR tiers × rate");
  // market handle wins: country FR but handle "usa" → USD market amounts apply
  ok(computeGifts(LIVE, input({ lines: usd, country: "FR", market: "usa", rate: "1.1" })).length === 0, "gifts: localization.market.handle picks the usa amounts (125 USD < 129)");
  ok(computeGifts(LIVE, input({ lines: usd2, country: "FR", market: "usa", rate: "1.1" })).length === 1, "gifts: localization.market.handle picks the usa amounts (129 USD reaches)");
  // per-market amount 0 / null / "" → that tier falls back to EUR × rate (storefront parity)
  const zeroed = clone(LIVE);
  zeroed.gt.bm.usa.a = [0, null, ""];
  const usdFallback = [line(11, 1, 130.9, { cur: "USD" }), line(61, 6, 40, { gift: 1, cur: "USD" })];
  ok(computeGifts(zeroed, input({ lines: usdFallback, country: "US", rate: "1.1" })).length === 1, "gifts: market amount 0 → EUR × rate for that tier (119 × 1.1 = 130.9 reached)");
  ok(computeGifts(zeroed, input({ lines: [line(11, 1, 130.8, { cur: "USD" }), line(61, 6, 40, { gift: 1, cur: "USD" })], country: "US", rate: "1.1" })).length === 0, "gifts: market amount 0 → EUR × rate for that tier (130.8 < 130.9)");
  const partial = clone(LIVE);
  partial.gt.bm.usa.a = [129, 0, 379];
  const t2 = [line(11, 1, 220, { cur: "USD" }), line(62, 60, 20, { gift: 2, cur: "USD" })];
  ok(firstOp(computeGifts(partial, input({ lines: t2, country: "US", rate: "1.1" })))?.productDiscountsAdd.candidates.length === 1, "gifts: only the 0 slot falls back (tier 2 = 200 × 1.1 = 220 reached; tier 1 keeps 129)");
  const neg = clone(LIVE);
  neg.gt.bm.usa.a = [-5, 219, 379];
  ok(computeGifts(neg, input({ lines: [line(11, 1, 100, { cur: "USD" }), line(61, 6, 40, { gift: 1, cur: "USD" })], country: "US", rate: "1.1" })).length === 0, "gifts: negative market amount is not used (100 USD < 119 × 1.1)");
}
{
  // cumulative on/off with 3 tiers reached (spend 400)
  const lines = [
    line(11, 1, 400),
    line(61, 6, 37, { gift: 1 }),
    line(62, 60, 20, { gift: 2 }),
    line(63, 600, 39, { gift: 3 }),
  ];
  const cum = firstOp(computeGifts(LIVE, input({ lines })))?.productDiscountsAdd.candidates.length;
  ok(cum === 3, "cumulative: all three tier gifts free at spend 400");
  const noCum = clone(LIVE);
  noCum.gt.cum = false;
  const nc = firstOp(computeGifts(noCum, input({ lines })))?.productDiscountsAdd.candidates;
  ok(nc && nc.length === 1 && nc[0].targets[0].cartLine.id === lines[3].id, "non-cumulative: only the reached tier's gift (bag) is free");
}
{
  // samples cap: tier 1 allows 2 sachets; 3 sachet gift lines → 2 free
  const lines = [line(11, 1, 119), line(71, 7, 1, { gift: 1, tag: true }), line(72, 8, 1, { gift: 1, tag: true }), line(71, 7, 1, { gift: 1, tag: true })];
  const c = firstOp(computeGifts(LIVE, input({ lines })))?.productDiscountsAdd.candidates;
  ok(c && c.length === 2, "samples cap: only S=2 sachet gift lines are free at tier 1");
  // tier 2 reached → S = 4
  const lines2 = [line(11, 1, 200), ...lines.slice(1)];
  ok(firstOp(computeGifts(LIVE, input({ lines: lines2 })))?.productDiscountsAdd.candidates.length === 3, "samples cap grows cumulatively (S=4 at tier 2)");
}
{
  // max lines cap
  const capped = clone(LIVE);
  capped.gt.max = 2;
  const lines = [line(11, 1, 400), line(61, 6, 37, { gift: 1 }), line(62, 60, 20, { gift: 2 }), line(63, 600, 39, { gift: 3 })];
  ok(firstOp(computeGifts(capped, input({ lines })))?.productDiscountsAdd.candidates.length === 2, "max gift lines cap honoured (2 of 3)");
}
{
  // gift line whose variant is not in any pool → stays paid; other gift still free
  const lines = [line(11, 1, 400), line(51, 5, 60, { gift: 1 }), line(61, 6, 37, { gift: 1 })];
  const c = firstOp(computeGifts(LIVE, input({ lines })))?.productDiscountsAdd.candidates;
  ok(c && c.length === 1 && c[0].targets[0].cartLine.id === lines[2].id, "gift-marked line outside the pool stays paid");
  // gifts off / scope denied
  const off = clone(LIVE);
  off.gt.on = false;
  ok(computeGifts(off, input({ lines })).length === 0, "gt.on=false → no gift ops");
  const scoped = clone(LIVE);
  scoped.gt.scope = { mode: "selected", markets: ["usa"] };
  ok(computeGifts(scoped, input({ lines, country: "FR" })).length === 0, "gift scope denies france");
  ok(computeGifts(LIVE, input({ lines: [line(11, 1, 400)] })).length === 0, "no gift lines in cart → no ops even when tiers are reached");
}

// --- shipping ----------------------------------------------------------------
const GROUPS = [
  {
    id: "gid://shopify/CartDeliveryGroup/1",
    deliveryOptions: [
      { handle: "express", cost: { amount: "12.00" } },
      { handle: "standard", cost: { amount: "5.90" } },
      { handle: "pickup", cost: { amount: "0.00" } },
    ],
  },
];
{
  // units rule: variant 12 = "2 Jars" counts 2 units
  const ops = computeShipping(LIVE, input({ lines: [line(12, 1, 100)], classes: ["SHIPPING"], groups: GROUPS }));
  const add = firstOp(ops)?.deliveryDiscountsAdd;
  ok(ops.length === 1 && add.selectionStrategy === "ALL", "shipping: 2-jar variant alone reaches min units → ONE deliveryDiscountsAdd with ALL");
  ok(add.candidates.length === 1 && add.candidates[0].targets[0].deliveryOption.handle === "standard" && add.candidates[0].value.percentage.value === "100.0" && add.candidates[0].message === "Free shipping", "shipping: cheapest paid option only (standard, not express/pickup) at 100.0");
  ok(deliveryOperations(input({ lines: [line(12, 1, 100)], classes: ["SHIPPING"], groups: GROUPS })).length === 1, "deliveryOperations end-to-end grants");
  ok(computeShipping(LIVE, input({ lines: [line(11, 1, 100)], classes: ["SHIPPING"], groups: GROUPS })).length === 0, "shipping: 1 jar (1 unit) below min units and below threshold → nothing");
  ok(computeShipping(LIVE, input({ lines: [line(11, 1, 50, { qty: 2 })], classes: ["SHIPPING"], groups: GROUPS })).length === 1, "shipping: quantity 2 of a 1-unit variant = 2 units");
  ok(computeShipping(LIVE, input({ lines: [line(11, 1, 100), line(71, 7, 1, { tag: true }), line(61, 6, 37, { gift: 1 }), line(90, 9, 3)], classes: ["SHIPPING"], groups: GROUPS })).length === 0, "shipping: sachet, gift and protection lines add no units");
  ok(computeShipping(LIVE, input({ lines: [line(12, 1, 100)], classes: ["PRODUCT"], groups: GROUPS })).length === 0, "shipping: wrong discount class → nothing");
}
{
  // threshold rule in market currency (usa 99 USD) and via EUR fallback (ch entry is CHF, cart CHF? no: cart EUR → skip)
  const us = [line(11, 1, 99, { cur: "USD" })];
  ok(computeShipping(LIVE, input({ lines: us, classes: ["SHIPPING"], groups: GROUPS, country: "US", rate: "1.1" })).length === 1, "shipping threshold: 99 USD meets the usa USD amount");
  ok(computeShipping(LIVE, input({ lines: [line(11, 1, 98.99, { cur: "USD" })], classes: ["SHIPPING"], groups: GROUPS, country: "US", rate: "1.1" })).length === 0, "shipping threshold: 98.99 USD is below 99");
  // france entry is EUR; a CAD cart in france → EUR × rate (150 × 1.5 = 225)
  ok(computeShipping(LIVE, input({ lines: [line(11, 1, 225, { cur: "CAD" })], classes: ["SHIPPING"], groups: GROUPS, country: "FR", rate: "1.5" })).length === 1, "shipping threshold: shop-currency entry converts with the presentment rate");
  ok(computeShipping(LIVE, input({ lines: [line(11, 1, 224, { cur: "CAD" })], classes: ["SHIPPING"], groups: GROUPS, country: "FR", rate: "1.5" })).length === 0, "shipping threshold: 224 CAD < 150 EUR × 1.5");
  // ch entry is CHF but the cart is EUR → not convertible → skip (no fallback)
  ok(computeShipping(LIVE, input({ lines: [line(11, 1, 500)], classes: ["SHIPPING"], groups: GROUPS, country: "CH" })).length === 0, "shipping threshold: non-shop-currency entry in another currency is skipped, no 150 fallback");
  // eu market has no entry → nothing even at 1000
  ok(computeShipping(LIVE, input({ lines: [line(11, 1, 1000)], classes: ["SHIPPING"], groups: GROUPS, country: "DE" })).length === 0, "shipping threshold: market without explicit entry never qualifies by spend");
  // v14.1: spend ignores sachet, gift and protection lines: 149 + 1 sachet stays below 150
  ok(computeShipping(LIVE, input({ lines: [line(11, 1, 149), line(71, 7, 1, { tag: true })], classes: ["SHIPPING"], groups: GROUPS })).length === 0, "shipping threshold: paid sachet does not count toward spend");
  ok(computeShipping(LIVE, input({ lines: [line(11, 1, 150), line(71, 7, 1, { tag: true })], classes: ["SHIPPING"], groups: GROUPS })).length === 1, "shipping threshold: full-size 150 qualifies with a sachet present");
  ok(computeShipping(LIVE, input({ lines: [line(11, 1, 149), line(61, 6, 37, { gift: 1 })], classes: ["SHIPPING"], groups: GROUPS })).length === 0, "shipping threshold: gift line amount does not count toward spend");
  // th=false → threshold rule off
  const noTh = clone(LIVE);
  noTh.fs.th = false;
  ok(computeShipping(noTh, input({ lines: [line(11, 1, 500)], classes: ["SHIPPING"], groups: GROUPS })).length === 0, "fs.th=false disables the threshold rule");
  // min=0 → units rule off
  const noMin = clone(LIVE);
  noMin.fs.min = 0;
  ok(computeShipping(noMin, input({ lines: [line(12, 1, 100)], classes: ["SHIPPING"], groups: GROUPS })).length === 0, "fs.min=0 disables the units rule");
}
{
  // no discount when every option costs 0; scope; fs.on
  const free = [{ id: "g1", deliveryOptions: [{ handle: "standard", cost: { amount: "0.00" } }] }];
  ok(computeShipping(LIVE, input({ lines: [line(12, 1, 100)], classes: ["SHIPPING"], groups: free })).length === 0, "shipping: all options already free → no operation");
  const two = [
    { id: "g1", deliveryOptions: [{ handle: "a-std", cost: { amount: "4.00" } }, { handle: "a-exp", cost: { amount: "9.00" } }] },
    { id: "g2", deliveryOptions: [{ handle: "b-exp", cost: { amount: "9.00" } }, { handle: "b-std", cost: { amount: "6.00" } }] },
  ];
  const c = firstOp(computeShipping(LIVE, input({ lines: [line(12, 1, 100)], classes: ["SHIPPING"], groups: two })))?.deliveryDiscountsAdd.candidates;
  ok(c && c.length === 2 && c[0].targets[0].deliveryOption.handle === "a-std" && c[1].targets[0].deliveryOption.handle === "b-std", "shipping: one cheapest-option candidate per delivery group");
  const off = clone(LIVE);
  off.fs.on = false;
  ok(computeShipping(off, input({ lines: [line(12, 1, 100)], classes: ["SHIPPING"], groups: GROUPS })).length === 0, "fs.on=false → nothing");
  const scoped = clone(LIVE);
  scoped.fs.scope = { mode: "selected", markets: ["usa"] };
  ok(computeShipping(scoped, input({ lines: [line(12, 1, 100)], classes: ["SHIPPING"], groups: GROUPS, country: "FR" })).length === 0, "fs scope denies france");
  ok(computeShipping(scoped, input({ lines: [line(12, 1, 100)], classes: ["SHIPPING"], groups: GROUPS, country: "US" })).length === 1, "fs scope allows usa");
  ok(computeShipping(scoped, input({ lines: [line(12, 1, 100)], classes: ["SHIPPING"], groups: GROUPS, country: "FR", market: "usa" })).length === 1, "fs scope: localization.market.handle 'usa' wins over cm[FR]");
  ok(computeShipping(LIVE, input({ lines: [line(11, 1, 99, { cur: "USD" })], classes: ["SHIPPING"], groups: GROUPS, country: "DE", market: "usa", rate: "1.1" })).length === 1, "fs threshold: market handle selects the usa 99 USD entry although cm[DE]=eu");
  ok(computeShipping(LIVE, input({ lines: [], classes: ["SHIPPING"], groups: GROUPS })).length === 0, "shipping: empty cart → nothing");
}

finish();
