// node_modules/@shopify/shopify_function/run.ts
function run_default(userfunction) {
  try {
    ShopifyFunction;
  } catch (e) {
    throw new Error(
      "ShopifyFunction is not defined. Please rebuild your function using the latest version of Shopify CLI."
    );
  }
  const input_obj = ShopifyFunction.readInput();
  const output_obj = userfunction(input_obj);
  ShopifyFunction.writeOutput(output_obj);
}

// extensions/cellexia-rewards/src/logic.js
var SHOP_CURRENCY = "EUR";
var CLASS_PRODUCT = "PRODUCT";
var CLASS_SHIPPING = "SHIPPING";
var STRATEGY_FIRST = "FIRST";
var STRATEGY_ALL = "ALL";
var MSG_GIFT = "Free gift";
var MSG_SHIPPING = "Free shipping";
var MSG_KIT_DEFAULT = "Set savings -{pct}%";
var EMPTY = Object.freeze([]);
function numId(gid) {
  if (gid == null) return "";
  const s = String(gid);
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}
function money(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
function pctString(p) {
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
function selectConfig(mf, previewAttrValue) {
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
function marketFor(cfg, iso) {
  const cm = cfg && obj(cfg.cm);
  if (!cm || !iso) return "";
  const v = cm[String(iso).toUpperCase()];
  return typeof v === "string" ? v : "";
}
function scopeOk(scope, market) {
  const s = obj(scope);
  if (!s || s.mode !== "selected") return true;
  return arr(s.markets).indexOf(market) !== -1;
}
function classifyLines(cfg, cart, market) {
  const lines = cart && arr(cart.lines);
  const gt = cfg && obj(cfg.gt) || {};
  const ss = cfg && obj(cfg.ss) || {};
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
      sub: !!(line.sellingPlanAllocation && line.sellingPlanAllocation.sellingPlan)
    });
  }
  return out;
}
function spendOf(lines) {
  let s = 0;
  for (const l of lines) if (!l.gift && !l.prot && !l.sachet) s += l.amount;
  return money(s);
}
function cartCurrency(lines) {
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
function marketOf(cfg, input) {
  const loc = input && input.localization;
  const h = loc && loc.market && loc.market.handle;
  if (typeof h === "string" && h.trim()) return h;
  return marketFor(cfg, countryOf(input));
}
function kitTier(tiers, count) {
  let best = null;
  for (const t of arr(tiers)) {
    if (!t) continue;
    const n = Number(t.n);
    if (!(n > 0) || n > count) continue;
    if (!best || n > Number(best.n)) best = t;
  }
  return best;
}
function computeKit(cfg, input) {
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
    (l) => l.qty > 0 && !l.gift && !l.prot && !l.sachet && !l.excl && (includeSub || !l.sub)
  );
  if (!eligible.length) return [];
  const distinct = new Set(eligible.map((l) => l.pid)).size;
  const tier = kitTier(ss.tiers, distinct);
  if (!tier) return [];
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
            associatedDiscountCode: { code: String(code) }
          }
        ]
      }
    }
  ];
}
function giftAmounts(gt, market, currency, rate) {
  const tiers = arr(gt && gt.tiers);
  const bm = obj(gt && gt.bm) || {};
  const entry = obj(bm[market]);
  const useMarket = !!entry && String(entry.c) === currency && Array.isArray(entry.a);
  return tiers.map((t, i) => {
    if (useMarket && Number(entry.a[i]) > 0) return money(entry.a[i]);
    return money(Number(t && t.eur) * rate);
  });
}
function reachedTier(amounts, spend) {
  let reached = -1;
  for (let i = 0; i < amounts.length; i++) if (amounts[i] <= spend) reached = i;
  return reached;
}
function computeGifts(cfg, input) {
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
  const granted = /* @__PURE__ */ new Set();
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
      value: { percentage: { value: pctString(100) } }
    });
  }
  if (!candidates.length) return [];
  return [{ productDiscountsAdd: { selectionStrategy: STRATEGY_ALL, candidates } }];
}
function unitsOf(cfg, lines) {
  const units = cfg && obj(cfg.units) || {};
  let n = 0;
  for (const l of lines) {
    if (l.gift || l.prot || l.sachet) continue;
    const u = Number(units[l.vid]);
    n += (u > 1 ? Math.floor(u) : 1) * l.qty;
  }
  return n;
}
function shippingThreshold(fs, market, currency, rate) {
  const bm = obj(fs && fs.bm) || {};
  const entry = obj(bm[market]);
  if (!entry || entry.a == null || !isFinite(Number(entry.a))) return null;
  const c = String(entry.c || "");
  if (c === currency) return money(entry.a);
  if (c === SHOP_CURRENCY) return money(Number(entry.a) * rate);
  return null;
}
function computeShipping(cfg, input) {
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
      value: { percentage: { value: pctString(100) } }
    });
  }
  if (!candidates.length) return [];
  return [{ deliveryDiscountsAdd: { selectionStrategy: STRATEGY_ALL, candidates } }];
}
function configOf(input) {
  const shop = input && input.shop;
  const mf = shop && shop.metafield ? shop.metafield.jsonValue : null;
  const attr = input && input.cart && input.cart.attribute ? input.cart.attribute.value : null;
  return selectConfig(mf, attr);
}
function cartLinesOperations(input) {
  const cfg = configOf(input);
  if (!cfg) return [];
  return input.triggeringDiscountCode ? computeKit(cfg, input) : computeGifts(cfg, input);
}
function deliveryOperations(input) {
  const cfg = configOf(input);
  if (!cfg) return [];
  return computeShipping(cfg, input);
}

// extensions/cellexia-rewards/src/cart_lines_discounts_generate_run.js
function cartLinesDiscountsGenerateRun(input) {
  try {
    return { operations: cartLinesOperations(input) };
  } catch {
    return { operations: [] };
  }
}

// extensions/cellexia-rewards/src/cart_delivery_options_discounts_generate_run.js
function cartDeliveryOptionsDiscountsGenerateRun(input) {
  try {
    return { operations: deliveryOperations(input) };
  } catch {
    return { operations: [] };
  }
}

// <stdin>
function cartLinesDiscountsGenerateRun2() {
  return run_default(cartLinesDiscountsGenerateRun);
}
function cartDeliveryOptionsDiscountsGenerateRun2() {
  return run_default(cartDeliveryOptionsDiscountsGenerateRun);
}
export {
  cartDeliveryOptionsDiscountsGenerateRun2 as cartDeliveryOptionsDiscountsGenerateRun,
  cartLinesDiscountsGenerateRun2 as cartLinesDiscountsGenerateRun
};
