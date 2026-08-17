// v14 rewards — ALL decision logic of the "Cellexia rewards" Discount
// Function as pure functions over plain objects (SPEC-v14-rewards §8).
//
// Why pure + separate: the validation harness runs these in plain Node
// (validation/sims/rewards-function.mjs) without a wasm build, and the two
// run modules (cart lines / delivery options) are thin wrappers so the wasm
// entry points never carry logic of their own.
//
// House rules for a Function: deterministic (no Date, no Math.random, no
// I/O), no throws on odd input (return "no operations" instead), numeric
// ids compared as strings after stripping the GID prefix, money as decimal
// strings compared after Number() + 2-decimal rounding, percentages emitted
// as strings ("5.0", "100.0") like Shopify's own JS examples.
//
// The config is the shop metafield $app:cellexia/rewards written by the
// server (SPEC §2.2): {v, ph, live:{ss,gt,fs,units,prot,giftPids,cm}, draft}.

/** Shop currency (SPEC §8: EUR-denominated defaults; `a × rate` fallback only when the entry is in the shop currency). */
export const SHOP_CURRENCY = "EUR";

/** Selection strategies / classes as string literals (no generated types needed). */
export const CLASS_PRODUCT = "PRODUCT";
export const CLASS_SHIPPING = "SHIPPING";
export const STRATEGY_FIRST = "FIRST";
export const STRATEGY_ALL = "ALL";

export const MSG_GIFT = "Free gift";
export const MSG_SHIPPING = "Free shipping";
/** Default KIT message; the merchant's cfg.ss.msg (with {pct}) wins when set. Plain hyphen-minus on purpose (checkout font safety). */
export const MSG_KIT_DEFAULT = "Set savings -{pct}%";

const EMPTY = Object.freeze([]);

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

/** "gid://shopify/ProductVariant/123" -> "123"; already-numeric / falsy input passes through as a string. */
export function numId(gid) {
  if (gid == null) return "";
  const s = String(gid);
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

/** Decimal string -> number rounded to 2 places (threshold comparisons). NaN -> 0. */
export function money(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Percentage as Shopify's JS examples emit it: "5.0", "12.5", "100.0". */
export function pctString(p) {
  const n = Number(p);
  if (!isFinite(n)) return "0.0";
  const s = String(Math.round(n * 100) / 100);
  return s.indexOf(".") === -1 ? s + ".0" : s;
}

function arr(v) {
  return Array.isArray(v) ? v : EMPTY;
}

function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

// ---------------------------------------------------------------------------
// config selection + market
// ---------------------------------------------------------------------------

/**
 * Pick live vs draft (SPEC §8: cfg = mf.draft && cart._cx_preview === mf.ph
 * && mf.ph ? mf.draft : mf.live). Accepts the raw jsonValue (object) or, defensively,
 * a JSON string. Returns null when there is no usable config.
 */
export function selectConfig(mf, previewAttrValue) {
  let m = mf;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  m = obj(m);
  if (!m) return null;
  const ph = typeof m.ph === "string" ? m.ph : "";
  const draft = obj(m.draft);
  if (draft && ph && previewAttrValue === ph) return draft;
  return obj(m.live);
}

/** Market handle for a country ISO2 via cfg.cm, "" when unknown. */
export function marketFor(cfg, iso) {
  const cm = cfg && obj(cfg.cm);
  if (!cm || !iso) return "";
  const v = cm[String(iso).toUpperCase()];
  return typeof v === "string" ? v : "";
}

/** MarketScope check: {mode:'all'|'selected', markets:[]}; missing scope = all. */
export function scopeOk(scope, market) {
  const s = obj(scope);
  if (!s || s.mode !== "selected") return true;
  return arr(s.markets).indexOf(market) !== -1;
}

// ---------------------------------------------------------------------------
// line classification (shared by all three computations)
// ---------------------------------------------------------------------------

/**
 * Flatten every ProductVariant line into
 * {id, qty, vid, pid, amount, currency, gift, prot, sachet, excl, sub}.
 * Non-variant merchandise (custom products) is skipped entirely.
 */
export function classifyLines(cfg, cart, market) {
  const lines = cart && arr(cart.lines);
  const gt = (cfg && obj(cfg.gt)) || {};
  const ss = (cfg && obj(cfg.ss)) || {};
  const pool = arr(gt.pool).map(String);
  const exclByMarket = obj(ss.excl) || {};
  const excl = arr(exclByMarket[market]).map(String);
  const prot = cfg && cfg.prot ? String(cfg.prot) : "";
  const out = [];
  for (const line of lines) {
    if (!line || !line.merchandise) continue;
    const m = line.merchandise;
    if (m.__typename && m.__typename !== "ProductVariant") continue;
    if (!m.id) continue;
    const vid = numId(m.id);
    const pid = m.product ? numId(m.product.id) : "";
    const cost = line.cost && line.cost.subtotalAmount ? line.cost.subtotalAmount : null;
    const giftAttr = line.attribute && line.attribute.value != null && line.attribute.value !== "";
    out.push({
      id: line.id,
      qty: Number(line.quantity) > 0 ? Math.floor(Number(line.quantity)) : 0,
      vid,
      pid,
      amount: money(cost ? cost.amount : 0),
      currency: cost && cost.currencyCode ? String(cost.currencyCode) : "",
      giftTier: giftAttr ? String(line.attribute.value) : "",
      gift: !!giftAttr,
      prot: !!prot && pid === prot,
      sachet: !!(m.product && m.product.hasAnyTag) || pool.indexOf(vid) !== -1,
      excl: excl.indexOf(pid) !== -1,
      sub: !!(line.sellingPlanAllocation && line.sellingPlanAllocation.sellingPlan),
    });
  }
  return out;
}

/** Spend (SPEC §0, v14.1): Σ subtotalAmount over lines that are NOT gift, NOT protection and NOT sachet (mirrors rwSpendCents in cellexia-cart.js — €1 sachets never buy a tier). */
export function spendOf(lines) {
  let s = 0;
  for (const l of lines) if (!l.gift && !l.prot && !l.sachet) s += l.amount;
  return money(s);
}

/** Cart presentment currency = currency of the first line with one, "" for an empty cart. */
export function cartCurrency(lines) {
  for (const l of lines) if (l.currency) return l.currency;
  return "";
}

function rateOf(input) {
  const r = Number(input && input.presentmentCurrencyRate);
  return isFinite(r) && r > 0 ? r : 1;
}

function hasClass(input, cls) {
  const d = input && input.discount;
  return !!d && arr(d.discountClasses).indexOf(cls) !== -1;
}

function countryOf(input) {
  const loc = input && input.localization;
  return loc && loc.country && loc.country.isoCode ? String(loc.country.isoCode) : "";
}

/**
 * Market handle of the cart: input.localization.market.handle when Shopify
 * gives one (authoritative — a country can belong to several markets or a
 * catalog-only market), else the country -> handle map cfg.cm (SPEC §8).
 */
export function marketOf(cfg, input) {
  const loc = input && input.localization;
  const h = loc && loc.market && loc.market.handle;
  if (typeof h === "string" && h.trim()) return h;
  return marketFor(cfg, countryOf(input));
}

// ---------------------------------------------------------------------------
// KIT set-savings (code node)
// ---------------------------------------------------------------------------

/** Highest tier {n,p,c} with n <= count, or null. Same rule as the storefront twin cxRwTier(). */
export function kitTier(tiers, count) {
  let best = null;
  for (const t of arr(tiers)) {
    if (!t) continue;
    const n = Number(t.n);
    if (!(n > 0) || n > count) continue;
    if (!best || n > Number(best.n)) best = t;
  }
  return best;
}

/**
 * Operations for the set-savings code node. Requires
 * input.triggeringDiscountCode. Grant rule (case-insensitive): the code
 * grants ONLY when it equals the code of the tier the cart qualifies for —
 * a ladder code typed on a cart that qualifies for another tier grants
 * nothing (Shopify reports it "not applicable"), so ladder codes can never
 * stack or over-grant. v15: no alias codes — the store's own historical
 * codes are never ours; the app steps aside for them on the storefront /
 * checkout side (yieldToCodes) and this Function never sees them.
 * One productDiscountsAdd, one candidate targeting every eligible line
 * (full quantity), selectionStrategy FIRST, associatedDiscountCode set so
 * Shopify attributes the discount to the code.
 */
export function computeKit(cfg, input) {
  if (!cfg || !input || !hasClass(input, CLASS_PRODUCT)) return [];
  const code = input.triggeringDiscountCode;
  if (!code) return [];
  const ss = obj(cfg.ss);
  if (!ss || !ss.on) return [];
  const market = marketOf(cfg, input);
  if (!scopeOk(ss.scope, market)) return [];
  const lines = classifyLines(cfg, input.cart, market);
  const includeSub = ss.sub !== false;
  const eligible = lines.filter(
    (l) => l.qty > 0 && !l.gift && !l.prot && !l.sachet && !l.excl && (includeSub || !l.sub),
  );
  if (!eligible.length) return [];
  const distinct = new Set(eligible.map((l) => l.pid)).size;
  const tier = kitTier(ss.tiers, distinct);
  if (!tier) return [];
  // Codes are case-insensitive on Shopify's side (a buyer typing "set2" gets code "SET2").
  if (String(tier.c).toUpperCase() !== String(code).toUpperCase()) return [];
  const pct = pctString(tier.p);
  const template = typeof ss.msg === "string" && ss.msg.trim() ? ss.msg : MSG_KIT_DEFAULT;
  const message = template.split("{pct}").join(String(Math.round(Number(tier.p) * 100) / 100));
  return [
    {
      productDiscountsAdd: {
        selectionStrategy: STRATEGY_FIRST,
        candidates: [
          {
            message,
            targets: eligible.map((l) => ({ cartLine: { id: l.id } })),
            value: { percentage: { value: pct } },
            associatedDiscountCode: { code: String(code) },
          },
        ],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// gift tiers (automatic node)
// ---------------------------------------------------------------------------

/**
 * Per-tier thresholds in the cart currency: bm[market].a[i] when that
 * market entry is denominated in the cart currency AND a[i] > 0 (mirrors the
 * storefront: an empty/0 slot means "not overridden"), else tiers[i].eur × rate.
 */
export function giftAmounts(gt, market, currency, rate) {
  const tiers = arr(gt && gt.tiers);
  const bm = obj(gt && gt.bm) || {};
  const entry = obj(bm[market]);
  const useMarket = !!entry && String(entry.c) === currency && Array.isArray(entry.a);
  return tiers.map((t, i) => {
    if (useMarket && Number(entry.a[i]) > 0) return money(entry.a[i]);
    return money(Number(t && t.eur) * rate);
  });
}

/** Highest tier index whose amount <= spend, -1 when none. */
export function reachedTier(amounts, spend) {
  let reached = -1;
  for (let i = 0; i < amounts.length; i++) if (amounts[i] <= spend) reached = i;
  return reached;
}

/**
 * Operations for the automatic "Cellexia free gifts" node: one
 * productDiscountsAdd (selectionStrategy ALL) with one 100 % candidate per
 * granted gift line, quantity 1 — extra units and unearned gift lines stay paid.
 */
export function computeGifts(cfg, input) {
  if (!cfg || !input || !hasClass(input, CLASS_PRODUCT)) return [];
  const gt = obj(cfg.gt);
  if (!gt || !gt.on) return [];
  const market = marketOf(cfg, input);
  if (!scopeOk(gt.scope, market)) return [];
  const lines = classifyLines(cfg, input.cart, market);
  const giftLines = lines.filter((l) => l.gift && l.qty > 0);
  if (!giftLines.length) return [];
  const spend = spendOf(lines);
  const amounts = giftAmounts(gt, market, cartCurrency(lines), rateOf(input));
  const reached = reachedTier(amounts, spend);
  if (reached < 0) return [];
  const cumulative = gt.cum !== false;
  const granted = new Set();
  let samplesAllowed = 0;
  const tiers = arr(gt.tiers);
  for (let i = 0; i <= reached; i++) {
    if (!cumulative && i !== reached) continue;
    for (const slot of arr(tiers[i] && tiers[i].slots)) {
      for (const opt of arr(slot)) {
        if (!opt) continue;
        if (opt.k === "v" && opt.vid != null && opt.vid !== "") granted.add(String(opt.vid));
        else if (opt.k === "s") samplesAllowed += Math.max(0, Math.floor(Number(opt.n) || 0));
      }
    }
  }
  const pool = arr(gt.pool).map(String);
  const max = Number(gt.max) > 0 ? Math.floor(Number(gt.max)) : 4;
  const candidates = [];
  let samples = 0;
  for (const l of giftLines) {
    if (candidates.length >= max) break;
    let free = false;
    if (granted.has(l.vid)) free = true;
    else if (pool.indexOf(l.vid) !== -1 && samples < samplesAllowed) {
      free = true;
      samples += 1;
    }
    if (!free) continue;
    candidates.push({
      message: MSG_GIFT,
      targets: [{ cartLine: { id: l.id, quantity: 1 } }],
      value: { percentage: { value: pctString(100) } },
    });
  }
  if (!candidates.length) return [];
  return [{ productDiscountsAdd: { selectionStrategy: STRATEGY_ALL, candidates } }];
}

// ---------------------------------------------------------------------------
// free-shipping guarantee (automatic node, delivery target)
// ---------------------------------------------------------------------------

/** Full-size units: Σ (cfg.units[vid] || 1) × qty over non-gift, non-protection, non-sachet lines. */
export function unitsOf(cfg, lines) {
  const units = (cfg && obj(cfg.units)) || {};
  let n = 0;
  for (const l of lines) {
    if (l.gift || l.prot || l.sachet) continue;
    const u = Number(units[l.vid]);
    n += (u > 1 ? Math.floor(u) : 1) * l.qty;
  }
  return n;
}

/**
 * Free-shipping threshold for the market in the cart currency, or null when
 * the market has no explicit entry (never a fallback) or the entry cannot
 * be expressed in the cart currency (only shop-currency entries convert).
 */
export function shippingThreshold(fs, market, currency, rate) {
  const bm = obj(fs && fs.bm) || {};
  const entry = obj(bm[market]);
  if (!entry || entry.a == null || !isFinite(Number(entry.a))) return null;
  const c = String(entry.c || "");
  if (c === currency) return money(entry.a);
  if (c === SHOP_CURRENCY) return money(Number(entry.a) * rate);
  return null;
}

/**
 * Operations for the automatic "Cellexia free shipping" node: per delivery
 * group the cheapest option that costs something becomes 100 % off (standard
 * shipping; express/priority untouched). selectionStrategy ALL so every
 * group in a split shipment is covered.
 */
export function computeShipping(cfg, input) {
  if (!cfg || !input || !hasClass(input, CLASS_SHIPPING)) return [];
  const fs = obj(cfg.fs);
  if (!fs || !fs.on) return [];
  const market = marketOf(cfg, input);
  if (!scopeOk(fs.scope, market)) return [];
  const lines = classifyLines(cfg, input.cart, market);
  if (!lines.length) return [];
  const min = Number(fs.min) > 0 ? Math.floor(Number(fs.min)) : 0;
  let ok = min > 0 && unitsOf(cfg, lines) >= min;
  if (!ok && fs.th !== false) {
    const th = shippingThreshold(fs, market, cartCurrency(lines), rateOf(input));
    ok = th != null && spendOf(lines) >= th;
  }
  if (!ok) return [];
  const candidates = [];
  for (const g of arr(input.cart && input.cart.deliveryGroups)) {
    let best = null;
    for (const o of arr(g && g.deliveryOptions)) {
      if (!o || !o.handle) continue;
      const cost = money(o.cost && o.cost.amount);
      if (cost <= 0) continue;
      if (!best || cost < best.cost) best = { handle: String(o.handle), cost };
    }
    if (!best) continue;
    candidates.push({
      message: MSG_SHIPPING,
      targets: [{ deliveryOption: { handle: best.handle } }],
      value: { percentage: { value: pctString(100) } },
    });
  }
  if (!candidates.length) return [];
  return [{ deliveryDiscountsAdd: { selectionStrategy: STRATEGY_ALL, candidates } }];
}

// ---------------------------------------------------------------------------
// entry points used by the run modules (and by the sim end-to-end checks)
// ---------------------------------------------------------------------------

function configOf(input) {
  const shop = input && input.shop;
  const mf = shop && shop.metafield ? shop.metafield.jsonValue : null;
  const attr = input && input.cart && input.cart.attribute ? input.cart.attribute.value : null;
  return selectConfig(mf, attr);
}

/** cart.lines.discounts.generate.run: KIT when a code triggered us, otherwise gifts. */
export function cartLinesOperations(input) {
  const cfg = configOf(input);
  if (!cfg) return [];
  return input.triggeringDiscountCode ? computeKit(cfg, input) : computeGifts(cfg, input);
}

/** cart.delivery-options.discounts.generate.run: free-shipping guarantee. */
export function deliveryOperations(input) {
  const cfg = configOf(input);
  if (!cfg) return [];
  return computeShipping(cfg, input);
}
