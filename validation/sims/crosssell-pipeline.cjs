/**
 * Cart cross-sell pipeline sim — runs the REAL v4.8/v4.9/v6.7 cross-sell
 * machinery vm-extracted from
 * extensions/cellexia-booster/assets/cellexia-cart.js:
 *
 *  - anchors: highest-value line first, protection product never anchors,
 *    max two distinct products;
 *  - complementary -> related fallback per source, anchor before fallback,
 *    first non-empty recommendations answer wins (no extra fetches);
 *  - pick pipeline (v16): rows straight from the recommendations payload
 *    — protection exclusion, handle dedupe, first AVAILABLE variant's
 *    presentment price / compare-at, no-available-variant drop; NO app
 *    proxy hop, no pick cap, no pick-time in-cart filter;
 *  - shared prune/wire: display cap (default 2 on invalid settings),
 *    product- AND variant-level in-cart hiding, rewards skip sets by
 *    variant (skipV) and, for auto rows, by handle (skipH, v16 render-
 *    time), add-button wiring;
 *  - attribution: one-click add posts _cellexia_upsell:'cart' with the
 *    busy-guard and the revenue beacon;
 *  - cache (v16): keyed by ORDERED anchor product ids + currency +
 *    pageLocale (never the whole cart signature — quantity / tier changes
 *    keep the rows), commit only while that key is still current, always
 *    persisted to sessionStorage (10-minute TTL), fetch starts with the
 *    drawer CLOSED, 200 ms render-path debounce, one in-flight per key,
 *    crossSellWarm() pre-fills the cache without touching live rows;
 *  - product data fast path (v16): ensureProductData waits for the page-
 *    product prefetch, then fetches {root}products/{handle}.js per
 *    missing line (adapted to the products-map shape), and only then the
 *    app proxy; productFromAjaxJson adapter contract;
 *  - theme hand-off hook (v16): window.refreshMiniCart wrapped once —
 *    seeds state.cart + renders SYNCHRONOUSLY before the original runs,
 *    re-renders once missing product data lands, transparent otherwise;
 *  - manual mode: cfg.csx island rows, override-title blank gate, money
 *    markup fallback.
 *
 * Documented stubs: decodeEntities = identity (no entities in sim
 * strings), drawerIsOpen/isCartPageContext/renderAll/safeThemeRefresh/
 * decorateSubscriptionRows/setNotice/track are environment probes and
 * recorders; fetchJSON is a scripted recorder (network never leaves the
 * sim). Timers and the clock (Date.now) are injected — no real
 * setTimeout flakiness; window.sessionStorage is an in-memory fake.
 *
 * MUTATION TESTS (all must be CAUGHT — non-zero exit on a mutant copy):
 *   m1-related-first      complementary/related attempt order swapped
 *   m2-fallback-inverted  "first non-empty wins" guard inverted
 *   m3-cap-off-by-one     prune display cap >= -> >
 *   m4-protection-anchors protection product allowed to anchor
 *   m5-commit-unguarded   result commits even when the anchors changed
 *   m6-cache-ttl-ignored  sessionStorage entry served past its TTL
 *   m7-ajax-skipped       product fast path skipped (proxy every time)
 *   m8-skiph-dropped      auto rows ignore the rewards handle skip set
 *   m9-currency-blind-key cache key ignores the presentment currency
 *   m10-hook-no-sync-render theme hand-off no longer renders synchronously
 *   m11-failure-persisted   an all-failed chain cached as "nothing to recommend"
 *   m12-hook-seed-after-render hand-off renders the OLD cart, seeds after
 *   m13-market-blind-key    cache key ignores the market
 *   m14-unknown-anchor-as-empty derivation treats an unknown anchor as empty
 *   m15-b2b-persisted       B2B rows written to sessionStorage
 *   m16-unauthoritative-persisted set answer cached although an earlier anchor failed
 *   m17-fetchnow-ignores-cache   hand-off fetch ignores a cached / derived answer
 *   m18-fetchnow-live-key-refetch hand-off refetches a key that is already live
 *   m19-hook-reinstall-dropped   scheduleRefresh no longer re-installs the hook
 *   m20-derived-restored         derived pair answer re-stored with a fresh timestamp
 *   m21-skipped-as-empty         a never-asked anchor cached as "nothing"
 */
"use strict";
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const { extractAll } = require("./lib/extract.cjs");
const { makeDocument } = require("./lib/mini-dom.cjs");

const REAL_SRC = path.join(
  __dirname, "..", "..",
  "extensions", "cellexia-booster", "assets", "cellexia-cart.js",
);
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;
const SRC = fs.readFileSync(SRC_PATH, "utf8");

const EXTRACTED = extractAll(SRC, {
  vars: ["PROTECTION_HANDLE", "autoCrossSell", "CROSS_SELL_CACHE_TTL", "productPrefetch", "MARKET"],
  functions: [
    "routeRoot",
    "featureOn",
    "isB2B",
    "t",
    "activeCurrency",
    "money",
    "el",
    "cxEl",
    "cxSp",
    "cxRawStr",
    "cxStr",
    "fetchCart",
    "normalizeProductsPayload",
    "planAdjustmentsFromAjax",
    "productFromAjaxJson",
    "productHandleFromPath",
    "productJsonUrl",
    "mergeAjaxProduct",
    "missingProductIds",
    "fetchCartItemProducts",
    "prefetchPageProduct",
    "ensureProductData",
    "cartRequest",
    "lineValue",
    "crossSellMaxItems",
    "crossSellMode",
    "wireCrossSellRow",
    "crossSellExclusions",
    "pruneCrossSellRows",
    "crosssellTitleText",
    "crosssellMoneyText",
    "crosssellBuildRow",
    "crosssellBuildBox",
    "renderCrossSellManual",
    "cartSignature",
    "crossSellAnchorKey",
    "crossSellCurrentKey",
    "crossSellRowOk",
    "crossSellStore",
    "crossSellCacheGet",
    "crossSellCachePut",
    "crossSellCacheResolve",
    "autoCrossSellAnchors",
    "fetchRecommendations",
    "fetchRecommendedProducts",
    "recommendationImage",
    "sizedImageUrl",
    "firstAvailableVariant",
    "fetchHandleData",
    "crossSellRowsFromRecs",
    "buildAutoCrossSellRows",
    "fetchAutoCrossSell",
    "scheduleAutoCrossSell",
    "crossSellFetchNow",
    "crossSellWarm",
    "buildAutoCrossSellRow",
    "renderCrossSellAuto",
    "renderCrossSell",
    "performCrossSellAdd",
    "installThemeCartHook",
    "scheduleRefresh",
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
const flush = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))));

function makeSim(opts) {
  opts = opts || {};
  const doc = makeDocument();
  const calls = { fetches: [], cartRequests: [], tracks: [], renderAll: 0, notices: [] };
  const timers = [];
  const clock = { t: 1700000000000 };
  const storeMap = opts.storeMap || {};
  const sessionStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(storeMap, k) ? storeMap[k] : null),
    setItem: (k, v) => { storeMap[k] = String(v); },
    removeItem: (k) => { delete storeMap[k]; },
  };
  const responders = opts.responders || {};
  // scripted fetchJSON: first matching URL-prefix responder wins.
  function fetchJSON(url, options) {
    calls.fetches.push({ url, options });
    for (const prefix of Object.keys(responders)) {
      if (url.indexOf(prefix) === 0) {
        const r = responders[prefix];
        const out = typeof r === "function" ? r(url, options) : r;
        return Promise.resolve(out).then((v) => {
          if (v instanceof Error) throw v;
          return v;
        });
      }
    }
    return Promise.reject(new Error("no responder for " + url));
  }
  const sandbox = {
    console,
    JSON,
    Promise,
    Intl,
    Math,
    Number,
    String,
    Array,
    Object,
    isFinite,
    encodeURIComponent,
    Date: { now: () => clock.t },
    document: doc,
    window: {
      setTimeout: (fn, ms) => { const t = { ms }; t.fn = () => { t.fired = true; return fn(); }; timers.push(t); return timers.length; },
      clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
      location: { reload: () => { calls.reloaded = true; }, pathname: opts.pathname || "/" },
      sessionStorage: opts.noStorage ? undefined : sessionStorage,
      Shopify: opts.shopify || undefined,
    },
    PREVIEW: null,
    BEACONS_OFF: false,
    EFFECTIVE: Object.assign({ crossSell: true }, opts.effective || {}),
    CART_FEATURE_KEYS: { crossSell: "cart_cross_sell" },
    cfg: Object.assign(
      { currency: "EUR", overrides: {}, products: {}, pageLocale: "en", market: "eu" },
      opts.cfg || {},
    ),
    SETTINGS: Object.assign({}, opts.settings || {}),
    STRINGS: Object.assign({
      "crosssell.title": "You may also like",
      "crosssell.add": "Add",
      "crosssell.adding": "Adding…",
      "crosssell.added": "Added to cart",
      "volume.error": "Something went wrong",
    }, opts.strings || {}),
    state: Object.assign({
      cart: null,
      products: {},
      busy: false,
      crossSellAdding: null,
      pageRoot: null,
      refreshTimer: null,
    }, opts.state || {}),
    // recorders / documented environment stubs
    fetchJSON,
    decodeEntities: (s) => s,
    track: (feature, type, extra) => calls.tracks.push({ feature, type, extra }),
    renderAll: () => { calls.renderAll++; },
    setNotice: (type, text) => calls.notices.push({ type, text }),
    safeThemeRefresh: () => { calls.themeRefreshed = true; },
    refresh: () => { calls.refresh = (calls.refresh || 0) + 1; return Promise.resolve(); },
    decorateSubscriptionRows: () => {},
    drawerIsOpen: () => opts.drawerOpen !== false,
    isCartPageContext: () => opts.onCartPage === true,
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox, { filename: "extracted-crosssell-module.js" });
  return { sandbox, doc, calls, timers, clock, storeMap };
}

const RECS_URL = "/recommendations/products.json";
// Safe cache-entry reader for assertions: a regression yields a FAIL line, never a crash.
const entry = (m, k) => { try { return JSON.parse(m[k]); } catch (e) { return null; } };
const rowsOf = (m, k) => { const e = entry(m, k); return e && Array.isArray(e.rows) ? e.rows : null; };
const fire = (sim, i) => { const t = sim.timers[i]; if (t && !t.cleared && !t.fired) t.fn(); return !!t; };
const PROXY_URL = "/apps/cellexia/cart-data";

function cartWith(items, token) {
  return { token: token || "tok1", items };
}
const LINE = (pid, vid, qty, value, handle) => ({
  product_id: pid, variant_id: vid, quantity: qty,
  final_line_price: value, handle: handle || "p" + pid,
});

async function main() {
  // --- signature ---------------------------------------------------------------
  {
    const { sandbox } = makeSim();
    ok(vm.runInContext("cartSignature()", sandbox) === "", "no cart: empty signature");
    sandbox.state.cart = cartWith([LINE(1, 11, 2, 100), LINE(2, 22, 1, 50)]);
    const sig = vm.runInContext("cartSignature()", sandbox);
    ok(sig === "tok1|11x2,22x1", "signature = token | sorted variantxqty (" + sig + ")");
    sandbox.state.cart = cartWith([LINE(2, 22, 1, 50), LINE(1, 11, 2, 100)]);
    ok(vm.runInContext("cartSignature()", sandbox) === sig, "line order does not change the signature");
    sandbox.state.cart = cartWith([LINE(1, 11, 3, 100), LINE(2, 22, 1, 50)]);
    ok(vm.runInContext("cartSignature()", sandbox) !== sig, "quantity change invalidates the signature");
  }

  // --- anchors -------------------------------------------------------------------
  {
    const { sandbox } = makeSim();
    sandbox.state.cart = cartWith([
      LINE(1, 11, 1, 4900),
      LINE(2, 22, 1, 9900),
      LINE(3, 33, 1, 20000, "cellexia-order-protection"),
      LINE(2, 23, 1, 100), // same product as line 2, lower value
      LINE(4, 44, 1, 8000),
    ]);
    const anchors = vm.runInContext("autoCrossSellAnchors()", sandbox);
    ok(anchors.length === 2, "max two anchor products");
    ok(String(anchors[0].product_id) === "2", "highest-value non-protection line anchors first");
    ok(String(anchors[1].product_id) === "4", "second distinct product is the fallback source");
    ok(anchors.every((a) => a.handle !== "cellexia-order-protection"),
      "the protection product NEVER anchors (even as top value)");
  }

  // --- complementary -> related fallback, anchor before fallback ------------------
  {
    // complementary of anchor 1 answers -> exactly ONE fetch.
    const sim = makeSim({
      responders: {
        [RECS_URL]: (url) =>
          url.indexOf("intent=complementary") !== -1 && url.indexOf("product_id=2") !== -1
            ? { products: [{ id: 90, handle: "rec-a", title: "Rec A", featured_image: "https://cdn/x.jpg" }] }
            : { products: [] },
      },
    });
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900), LINE(4, 44, 1, 8000)]);
    const out = await vm.runInContext(
      "fetchRecommendedProducts(autoCrossSellAnchors())", sim.sandbox);
    const products = out.products;
    ok(products.length === 1 && products[0].handle === "rec-a", "complementary answer wins");
    ok(out.answered === true && out.outcomes.join(",") === "won,skipped", "v16: answered + outcomes = won (anchor), skipped (fallback never tried)");
    ok(sim.calls.fetches.length === 1, "first non-empty answer stops the chain (1 fetch)");
    ok(sim.calls.fetches[0].url.indexOf("intent=complementary") !== -1 &&
       sim.calls.fetches[0].url.indexOf("product_id=2") !== -1,
      "first attempt = anchor complementary");
  }
  {
    // anchor complementary empty -> anchor related -> fallback source next.
    const answers = {
      "product_id=2&limit=8&intent=complementary": [],
      "product_id=2&limit=8&intent=related": [],
      "product_id=4&limit=8&intent=complementary": [{ id: 91, handle: "rec-b", title: "Rec B" }],
    };
    const sim = makeSim({
      responders: {
        [RECS_URL]: (url) => {
          for (const k of Object.keys(answers)) {
            if (url.indexOf(k) !== -1) return { products: answers[k] };
          }
          return { products: [] };
        },
      },
    });
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900), LINE(4, 44, 1, 8000)]);
    const out = await vm.runInContext(
      "fetchRecommendedProducts(autoCrossSellAnchors())", sim.sandbox);
    const products = out.products;
    ok(products.length === 1 && products[0].handle === "rec-b",
      "fallback source complementary fills after both anchor intents were empty");
    ok(out.answered === true && out.outcomes.join(",") === "empty,won", "v16: outcomes = empty (anchor answered nothing twice), won (fallback)");
    const intents = sim.calls.fetches.map((f) => {
      const pid = /product_id=(\d+)/.exec(f.url)[1];
      const intent = /intent=(\w+)/.exec(f.url)[1];
      return pid + ":" + intent;
    });
    ok(intents.join(",") === "2:complementary,2:related,4:complementary",
      "attempt order: complementary then related per source, anchor before fallback (" + intents.join(",") + ")");
  }
  {
    // A failed recommendations call is tolerated silently (empty array).
    const sim = makeSim({
      responders: { [RECS_URL]: () => new Error("HTTP 404") },
    });
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    const out = await vm.runInContext(
      "fetchRecommendedProducts(autoCrossSellAnchors())", sim.sandbox);
    ok(Array.isArray(out.products) && out.products.length === 0, "404/failure per attempt tolerated silently");
    ok(out.answered === false && out.outcomes.join(",") === "failed", "v16: an all-failed chain is NOT an answer (answered=false, outcome failed)");
    // one intent failed, the other answered empty -> the anchor is 'failed' (unknown), never 'empty'
    const mixed = makeSim({ responders: { [RECS_URL]: (url) => (url.indexOf("intent=complementary") !== -1 ? new Error("HTTP 500") : { products: [] }) } });
    mixed.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    const outMixed = await vm.runInContext("fetchRecommendedProducts(autoCrossSellAnchors())", mixed.sandbox);
    ok(outMixed.answered === true && outMixed.outcomes.join(",") === "failed", "v16: failed + empty intents = anchor outcome 'failed' (answered by the empty one)");
    let rejected = false;
    await vm.runInContext("buildAutoCrossSellRows(autoCrossSellAnchors())", sim.sandbox).catch(() => { rejected = true; });
    ok(rejected, "v16: buildAutoCrossSellRows REJECTS when every attempt failed (nothing to cache)");
    const built = await vm.runInContext("buildAutoCrossSellRows(autoCrossSellAnchors())", mixed.sandbox);
    ok(built && Array.isArray(built.rows) && built.rows.length === 0 && built.outcomes.join(",") === "failed", "v16: an answered-empty chain resolves {rows: [], outcomes}");
  }

  // --- pick pipeline (v16): rows straight from the recommendations payload -----
  {
    const recs = [];
    for (let i = 1; i <= 8; i++) {
      recs.push({
        id: 100 + i, handle: "h" + i, title: "P" + i,
        featured_image: i === 1 ? "https://cdn/p1.jpg" : null,
        variants: [
          { id: 9000 + i, price: 1000 * i, available: i !== 2, compare_at_price: i === 1 ? 2500 : null },
          { id: 9100 + i, price: 1100 * i, available: true },
        ],
      });
    }
    recs[2].variants = [{ id: 9003, price: 3000, available: false }]; // h3: every variant sold out
    recs.splice(1, 0,
      { id: 999, handle: "cellexia-order-protection", title: "Protection", variants: [{ id: 1, price: 1 }] }, // excluded
      { id: 101, handle: "h1", title: "P1 dup", variants: [{ id: 2, price: 1 }] },                            // handle dup
      { id: 5, handle: "in-cart", title: "In cart", variants: [{ id: 55, price: 100 }] },                    // in cart: KEPT (render-time prune)
      { handle: "", title: "no handle", variants: [{ id: 3, price: 1 }] },                                    // unusable
      { id: 77, handle: "no-variants", title: "No variants" },                                                 // no variants array
    );
    const sim = makeSim({
      responders: {
        [RECS_URL]: { products: recs },
        [PROXY_URL]: () => new Error("proxy must not be called"),
      },
    });
    sim.sandbox.state.cart = cartWith([LINE(5, 55, 1, 9900, "in-cart")]);
    const rows = (await vm.runInContext("buildAutoCrossSellRows(autoCrossSellAnchors())", sim.sandbox)).rows;
    const handles = rows.map((r) => r.handle);
    ok(handles.indexOf("cellexia-order-protection") === -1, "protection product excluded from picks");
    ok(handles.filter((h) => h === "h1").length === 1, "handle dedupe");
    ok(handles.indexOf("in-cart") !== -1, "v16: in-cart product stays in the (cart-agnostic) rows — pruned at render");
    ok(handles.indexOf("no-variants") === -1, "product without variants drops");
    ok(handles.indexOf("h3") === -1, "every variant sold out: product drops");
    const h2 = rows.find((r) => r.handle === "h2");
    ok(!!h2 && h2.variantId === 9102 && h2.priceCents === 2200, "sold-out first variant: next available variant wins (its price)");
    ok(rows.length === 8, "v16: no pick cap — every usable recommendation kept (got " + rows.length + ")");
    ok(handles.indexOf("h7") !== -1 && handles.indexOf("h8") !== -1, "v16: 7th/8th recommendations kept as spare rows");
    const h1 = rows.find((r) => r.handle === "h1");
    ok(!!h1 && h1.priceCents === 1000 && h1.compareAtCents === 2500 && h1.variantId === 9001,
      "v16: presentment price + compare-at + variant id from the recommendations payload");
    ok(!!h1 && h1.title === "P1" && h1.image === "https://cdn/p1.jpg" && h1.productId === 101,
      "title / image / product id from the recommendations payload");
    ok(sim.calls.fetches.every((f) => f.url.indexOf(PROXY_URL) !== 0), "v16: ZERO app-proxy calls in the auto pipeline");
    ok(sim.calls.fetches.length === 1, "one recommendations call, nothing else (" + sim.calls.fetches.length + ")");
  }

  // --- prune/wire: cap, in-cart hiding, wiring -------------------------------------
  {
    const sim = makeSim({ settings: { crossSellMaxItems: "not-a-number" } });
    ok(vm.runInContext("crossSellMaxItems()", sim.sandbox) === 2,
      "invalid crossSellMaxItems falls back to 2");
    sim.sandbox.SETTINGS.crossSellMaxItems = 3;
    ok(vm.runInContext("crossSellMaxItems()", sim.sandbox) === 3, "explicit cap honored");
    ok(vm.runInContext("crossSellMode()", sim.sandbox) === "auto",
      "auto is the contract default mode");
    sim.sandbox.SETTINGS.crossSellMode = "manual";
    ok(vm.runInContext("crossSellMode()", sim.sandbox) === "manual", "explicit manual mode");
    sim.sandbox.SETTINGS.crossSellMode = "banana";
    ok(vm.runInContext("crossSellMode()", sim.sandbox) === "auto",
      "unknown mode string runs the recommendations pipeline");
  }
  {
    const sim = makeSim({ settings: { crossSellMaxItems: 2 } });
    sim.sandbox.state.cart = cartWith([LINE(5, 55, 1, 100), LINE(6, 66, 1, 100)]);
    const rowsSpec = [
      { handle: "a", productId: 5, title: "A", image: null, variantId: 500, priceCents: 100, compareAtCents: 0 },  // product in cart
      { handle: "b", productId: 7, title: "B", image: null, variantId: 66, priceCents: 100, compareAtCents: 0 },   // variant in cart
      { handle: "c", productId: 8, title: "C", image: null, variantId: 800, priceCents: 100, compareAtCents: 0 },
      { handle: "d", productId: 9, title: "D", image: null, variantId: 900, priceCents: 100, compareAtCents: 0 },
      { handle: "e", productId: 10, title: "E", image: null, variantId: 1000, priceCents: 100, compareAtCents: 0 },
    ];
    sim.sandbox.__rows = rowsSpec;
    const visible = vm.runInContext(`
      (function () {
        var host = document.createElement('ul');
        var items = [];
        for (var i = 0; i < __rows.length; i++) {
          var node = buildAutoCrossSellRow(__rows[i]);
          host.appendChild(node);
          items.push(node);
        }
        __host = host;
        return pruneCrossSellRows(items);
      })()`, sim.sandbox);
    ok(visible === 2, "prune: display cap 2 (got " + visible + ")");
    const left = sim.sandbox.__host.children.map((c) => c.getAttribute("data-variant-id"));
    ok(left.join(",") === "800,900", "in-cart product AND variant rows removed; overflow removed (" + left.join(",") + ")");
    const btn = sim.sandbox.__host.children[0].querySelector(".cx-crosssell__add");
    ok(!!btn && btn._listeners.click && btn._listeners.click.length === 1,
      "surviving rows get exactly one wired add button");
  }
  {
    // v16: the rewards handle skip set (sachet / gift-pool products) is a
    // RENDER-time filter on auto rows (data-handle) — cached rows stay
    // cart-agnostic; skipV (variant) unchanged.
    const sim = makeSim({ settings: { crossSellMaxItems: 5 } });
    sim.sandbox.state.cart = cartWith([LINE(1, 11, 1, 100)]);
    sim.sandbox.state.rw = { pct: 0, skipV: { "700": true }, skipH: { "sachet-h": true }, skipK: {}, exc: {} };
    sim.sandbox.__rows = [
      { handle: "sachet-h", productId: 20, title: "S", image: null, variantId: 200, priceCents: 100, compareAtCents: 0 },
      { handle: "pool-v", productId: 21, title: "V", image: null, variantId: 700, priceCents: 100, compareAtCents: 0 },
      { handle: "keep", productId: 22, title: "K", image: null, variantId: 800, priceCents: 100, compareAtCents: 0 },
    ];
    const visible = vm.runInContext(`
      (function () {
        var host = document.createElement('ul');
        var items = [];
        for (var i = 0; i < __rows.length; i++) {
          var node = buildAutoCrossSellRow(__rows[i]);
          host.appendChild(node);
          items.push(node);
        }
        __host = host;
        return pruneCrossSellRows(items);
      })()`, sim.sandbox);
    ok(visible === 1, "v16 prune: skipH (handle) and skipV (variant) rows removed (visible " + visible + ")");
    ok(sim.sandbox.__host.children.length === 1 && sim.sandbox.__host.children[0].getAttribute("data-handle") === "keep",
      "v16: auto rows carry data-handle; only the non-skipped row survives");
    sim.sandbox.state.rw = null;
  }

  // --- attribution + busy guard -----------------------------------------------------
  {
    const sim = makeSim({
      responders: {
        "/cart/add.js": (url, options) => ({ ok: true }),
        "/cart.js": cartWith([LINE(8, 800, 1, 100)]),
        [PROXY_URL]: { products: {} },
      },
    });
    sim.sandbox.state.cart = cartWith([]);
    vm.runInContext("performCrossSellAdd(800, 4900, null)", sim.sandbox);
    ok(sim.sandbox.state.busy === true && sim.sandbox.state.crossSellAdding === "800",
      "add flow: busy + adding state set synchronously");
    vm.runInContext("performCrossSellAdd(801, 100, null)", sim.sandbox);
    await flush();
    const adds = sim.calls.fetches.filter((f) => f.url === "/cart/add.js");
    ok(adds.length === 1, "busy-guard: second click is a no-op");
    const body = JSON.parse(adds[0].options.body);
    ok(body.id === 800 && body.quantity === 1 && body.properties._cellexia_upsell === "cart",
      "attribution: cart/add.js body carries _cellexia_upsell:'cart'");
    const beacon = sim.calls.tracks.find((t) => t.feature === "cart_cross_sell");
    ok(!!beacon && beacon.type === "add_to_cart" && beacon.extra.revenue === 49 && beacon.extra.quantity === 1,
      "revenue beacon: cart_cross_sell add_to_cart 49.00 x1");
    ok(sim.sandbox.state.busy === false && sim.sandbox.state.crossSellAdding === null,
      "busy cleared after the add settles");
    ok(sim.calls.notices.some((n) => n.type === "success"), "success notice shown");
  }

  // --- cache/debounce/commit semantics (v16: anchor-keyed, session-persisted) --------
  {
    let releaseRecs;
    const recsGate = new Promise((r) => { releaseRecs = r; });
    const sim = makeSim({
      responders: {
        [RECS_URL]: () => recsGate.then(() => ({ products: [{ id: 90, handle: "rec-a", title: "Rec A", variants: [{ id: 700, price: 900 }] }] })),
        [PROXY_URL]: () => new Error("proxy must not be called"),
      },
      drawerOpen: false, // v16: fetch starts with the drawer CLOSED
    });
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    const key = vm.runInContext("crossSellCurrentKey()", sim.sandbox);
    ok(key === "cx_xs:2:eu:EUR:en:2", "anchor key = cx_xs:2:<market>:<currency>:<locale>:<ordered anchor ids> (" + key + ")");
    const host1 = sim.doc.createElement("div");
    sim.sandbox.__host = host1;
    let out = vm.runInContext("renderCrossSell(__host)", sim.sandbox);
    ok(out === null, "auto mode, nothing cached yet: renders nothing");
    ok(sim.timers.length === 1 && sim.timers[0].ms === 200, "fetch debounced 200 ms — scheduled while the drawer is closed");
    out = vm.runInContext("renderCrossSell(__host)", sim.sandbox);
    ok(sim.timers.filter((t) => !t.cleared).length === 1,
      "re-render for the same key: still one scheduled fetch");
    sim.timers[0].fn(); // fire the debounce -> recommendations fetch starts
    await flush();
    ok(sim.sandbox.autoCrossSell.pending[key] === true, "key marked in flight");
    releaseRecs();
    await flush();
    ok(sim.calls.renderAll === 1, "commit for the fetched anchors re-renders");
    ok(sim.sandbox.autoCrossSell.key === key && Array.isArray(sim.sandbox.autoCrossSell.rows) && sim.sandbox.autoCrossSell.rows.length === 1,
      "rows held under the fetched key");
    ok(!!sim.storeMap[key] && JSON.parse(sim.storeMap[key]).rows.length === 1, "rows persisted in sessionStorage under the key");
    out = vm.runInContext("renderCrossSell(__host)", sim.sandbox);
    ok(out === "cart_cross_sell", "cached rows render the box");
    ok(host1.querySelectorAll(".cx-crosssell__item").length === 1, "one visible row");
    ok(host1.querySelector(".cx-crosssell").getAttribute("data-cx-feature") === "cart_cross_sell",
      "feature marker on the box");
    const fetchCount = sim.calls.fetches.length;
    ok(fetchCount === 1, "exactly one network call for the whole auto pipeline (" + fetchCount + ")");
    vm.runInContext("renderCrossSell(document.createElement('div'))", sim.sandbox);
    ok(sim.calls.fetches.length === fetchCount && sim.timers.filter((t) => !t.cleared && !t.fired).length === 0,
      "reopen with an unchanged cart: cache hit, no refetch");
    // v16: quantity change / tier upgrade of the anchor keeps the key -> no refetch, rows still render.
    sim.sandbox.state.cart = cartWith([LINE(2, 23, 1, 19800)], "tok-after-upgrade"); // 2-unit tier variant, new token
    ok(vm.runInContext("crossSellCurrentKey()", sim.sandbox) === key, "upgrade to another tier variant keeps the anchor key");
    const host2 = sim.doc.createElement("div");
    sim.sandbox.__host2 = host2;
    ok(vm.runInContext("renderCrossSell(__host2)", sim.sandbox) === "cart_cross_sell" &&
       sim.calls.fetches.length === fetchCount && sim.timers.filter((t) => !t.cleared && !t.fired).length === 0,
      "v16: tier upgrade / quantity change: rows render from cache, no refetch, no timer");
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 3, 29700)]);
    ok(vm.runInContext("crossSellCurrentKey()", sim.sandbox) === key, "quantity change keeps the anchor key");
  }
  {
    // A later page (fresh in-memory state, same sessionStorage) renders synchronously from the session cache.
    const sim = makeSim({ responders: { [RECS_URL]: () => new Error("must not fetch") } });
    const key = "cx_xs:2:eu:EUR:en:2";
    sim.storeMap[key] = JSON.stringify({ t: sim.clock.t - 1000, rows: [
      { handle: "rec-a", productId: 90, title: "Rec A", image: null, variantId: 700, priceCents: 900, compareAtCents: 0 },
      { handle: "", productId: 91, title: "bad", image: null, variantId: 701, priceCents: 900, compareAtCents: 0 }, // malformed entry ignored
    ] });
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    const host = sim.doc.createElement("div");
    sim.sandbox.__host = host;
    ok(vm.runInContext("renderCrossSell(__host)", sim.sandbox) === "cart_cross_sell", "session cache hit renders synchronously on a fresh page");
    ok(sim.calls.fetches.length === 0 && sim.timers.length === 0, "session cache hit: zero network, no timer");
    ok(host.querySelectorAll(".cx-crosssell__item").length === 1, "malformed cached entries are dropped");
    // TTL: past 10 minutes the entry is stale -> refetch scheduled.
    const sim2 = makeSim({ responders: { [RECS_URL]: { products: [] } } });
    sim2.storeMap[key] = JSON.stringify({ t: sim2.clock.t - 600001, rows: [{ handle: "rec-a", productId: 90, title: "A", image: null, variantId: 700, priceCents: 900, compareAtCents: 0 }] });
    sim2.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    sim2.sandbox.__host = sim2.doc.createElement("div");
    ok(vm.runInContext("renderCrossSell(__host)", sim2.sandbox) === null && sim2.timers.length === 1,
      "session cache entry older than the 10-minute TTL is ignored (refetch scheduled)");
    // No sessionStorage at all: the pipeline still works in memory.
    const sim3 = makeSim({ noStorage: true, responders: { [RECS_URL]: { products: [{ id: 90, handle: "rec-a", title: "A", variants: [{ id: 700, price: 900 }] }] } } });
    sim3.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    sim3.sandbox.__host = sim3.doc.createElement("div");
    vm.runInContext("renderCrossSell(__host)", sim3.sandbox);
    sim3.timers[0].fn();
    await flush();
    ok(sim3.calls.renderAll === 1 && vm.runInContext("renderCrossSell(__host)", sim3.sandbox) === "cart_cross_sell",
      "without sessionStorage the in-memory cache still serves the rows");
  }
  {
    // Cache key: currency and storefront language are part of the key (presentment prices, localized titles).
    const sim = makeSim({ shopify: { currency: { active: "USD" } }, cfg: { pageLocale: "fr" } });
    sim.sandbox.state.cart = cartWith([LINE(4, 44, 1, 100), LINE(2, 22, 1, 9900)]);
    const key = vm.runInContext("crossSellCurrentKey()", sim.sandbox);
    ok(key === "cx_xs:2:eu:USD:fr:2,4", "key carries market + currency + locale + anchors in value order (" + key + ")");
    const other = makeSim({ cfg: { market: "ie" } });
    other.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    ok(vm.runInContext("crossSellCurrentKey()", other.sandbox) === "cx_xs:2:ie:EUR:en:2", "a different market (same currency + language) is a different key");
    ok(vm.runInContext("crossSellAnchorKey([])", sim.sandbox) === "" &&
       vm.runInContext("crossSellAnchorKey([{ handle: 'x' }])", sim.sandbox) === "",
      "no usable anchor -> empty key (nothing scheduled)");
  }
  {
    // Mid-flight anchor change: the result must NOT commit to the live rows — but it IS cached.
    let releaseRecs;
    const recsGate = new Promise((r) => { releaseRecs = r; });
    const sim = makeSim({
      responders: {
        [RECS_URL]: () => recsGate.then(() => ({ products: [{ id: 90, handle: "rec-a", title: "Rec A", variants: [{ id: 700, price: 900 }] }] })),
      },
    });
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    const key = vm.runInContext("crossSellCurrentKey()", sim.sandbox);
    vm.runInContext(`scheduleAutoCrossSell(${JSON.stringify(key)}, autoCrossSellAnchors())`, sim.sandbox);
    sim.timers[0].fn();
    await flush();
    sim.sandbox.state.cart = cartWith([LINE(9, 99, 1, 50000)]); // another product now anchors
    releaseRecs();
    await flush();
    ok(sim.sandbox.autoCrossSell.key === null && sim.sandbox.autoCrossSell.rows === null,
      "stale fetch result never commits (anchors changed mid-flight)");
    ok(sim.calls.renderAll === 0, "no re-render for a stale commit");
    ok(!!sim.storeMap[key], "…but the result is cached for the next time those anchors return");
    ok(!sim.sandbox.autoCrossSell.pending[key], "in-flight mark cleared");
    // Failure path: every attempt fails -> empty in-memory result held for the current key, NEVER persisted;
    // a fresh page (same sessionStorage) retries, and warm retries too.
    const shared = {};
    const sim2 = makeSim({ storeMap: shared, responders: { [RECS_URL]: () => new Error("HTTP 500") } });
    sim2.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    const key2 = vm.runInContext("crossSellCurrentKey()", sim2.sandbox);
    vm.runInContext(`scheduleAutoCrossSell(${JSON.stringify(key2)}, autoCrossSellAnchors())`, sim2.sandbox);
    sim2.timers[0].fn();
    await flush();
    ok(sim2.sandbox.autoCrossSell.key === key2 && Array.isArray(sim2.sandbox.autoCrossSell.rows) && sim2.sandbox.autoCrossSell.rows.length === 0,
      "all recommendation attempts failing: empty rows held in memory, nothing renders");
    ok(vm.runInContext("renderCrossSell(document.createElement('div'))", sim2.sandbox) === null &&
       sim2.timers.filter((t) => !t.cleared && !t.fired).length === 0,
      "failure: no render, no re-hammering of the endpoint on this page");
    ok(!shared[key2] && Object.keys(shared).length === 0, "v16: a failed fetch is NEVER persisted to sessionStorage");
    ok(!sim2.sandbox.autoCrossSell.pending[key2], "failure: in-flight mark cleared");
    const sim2b = makeSim({ storeMap: shared, responders: { [RECS_URL]: { products: [{ id: 90, handle: "rec-a", title: "A", variants: [{ id: 700, price: 900 }] }] } } });
    sim2b.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    ok(vm.runInContext("renderCrossSell(document.createElement('div'))", sim2b.sandbox) === null && sim2b.timers.length === 1,
      "a later page (same session) after a failure schedules a fresh fetch");
    vm.runInContext("crossSellWarm([{ product_id: 2 }])", sim2b.sandbox);
    await flush();
    ok(sim2b.calls.fetches.length === 1 && !!shared[key2], "warm after a failure fetches again and caches the real answer");
    // A real "nothing to recommend" answer IS cached (10 min) — no re-hammering across pages.
    const shared2 = {};
    const sim3 = makeSim({ storeMap: shared2, responders: { [RECS_URL]: { products: [] } } });
    sim3.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    vm.runInContext("renderCrossSell(document.createElement('div'))", sim3.sandbox);
    sim3.timers[0].fn();
    await flush();
    ok(!!shared2[key2] && JSON.parse(shared2[key2]).rows.length === 0, "an answered-empty result is persisted as []");
    const sim3b = makeSim({ storeMap: shared2, responders: { [RECS_URL]: () => new Error("must not fetch") } });
    sim3b.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    ok(vm.runInContext("renderCrossSell(document.createElement('div'))", sim3b.sandbox) === null && sim3b.timers.length === 0 && sim3b.calls.fetches.length === 0,
      "a later page honours the cached empty answer (no fetch, no timer)");
  }
  {
    // v16 per-anchor derivation: [P, Q] resolves from the single-anchor entries the pre-warm / page-load render left.
    const shared = {};
    const K = (ids) => "cx_xs:2:eu:EUR:en:" + ids;
    const rowsP = [{ handle: "rec-p", productId: 90, title: "P rec", image: null, variantId: 700, priceCents: 900, compareAtCents: 0 }];
    const rowsQ = [{ handle: "rec-q", productId: 91, title: "Q rec", image: null, variantId: 701, priceCents: 900, compareAtCents: 0 }];
    const sim = makeSim({ storeMap: shared, responders: { [RECS_URL]: () => new Error("must not fetch") } });
    shared[K("2")] = JSON.stringify({ t: sim.clock.t, rows: rowsP });
    shared[K("4")] = JSON.stringify({ t: sim.clock.t, rows: rowsQ });
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900), LINE(4, 44, 1, 100)]); // anchors [2, 4]
    const host = sim.doc.createElement("div");
    sim.sandbox.__host = host;
    ok(vm.runInContext("renderCrossSell(__host)", sim.sandbox) === "cart_cross_sell" && host.querySelector(".cx-crosssell__name").textContent === "P rec",
      "[P,Q] with cache(P) non-empty: P's rows render synchronously (chain semantics: anchor before fallback)");
    ok(sim.calls.fetches.length === 0 && sim.timers.length === 0 && shared[K("2,4")] === undefined, "no fetch, no timer; the derived answer is NOT re-stored under the pair key (it would outlive its sources)");
    // Aged source: the derivation follows the single entry's own TTL.
    shared[K("2")] = JSON.stringify({ t: sim.clock.t - 600001, rows: rowsP });
    const simA2 = makeSim({ storeMap: shared, responders: { [RECS_URL]: () => new Error("must not fetch") } });
    simA2.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900), LINE(4, 44, 1, 100)]);
    ok(vm.runInContext("renderCrossSell(document.createElement('div'))", simA2.sandbox) === null && simA2.timers.length === 1,
      "[P,Q] with cache(P) expired: unknown again, a fetch is scheduled (no 20-minute snapshot)");
    shared[K("2")] = JSON.stringify({ t: sim.clock.t, rows: [] }); // P answered empty
    const simB = makeSim({ storeMap: shared, responders: { [RECS_URL]: () => new Error("must not fetch") } });
    delete shared[K("2,4")];
    simB.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900), LINE(4, 44, 1, 100)]);
    const hostB = simB.doc.createElement("div");
    simB.sandbox.__host = hostB;
    ok(vm.runInContext("renderCrossSell(__host)", simB.sandbox) === "cart_cross_sell" && hostB.querySelector(".cx-crosssell__name").textContent === "Q rec",
      "[P,Q] with cache(P) = [] and cache(Q) non-empty: falls through to Q (first non-empty wins)");
    delete shared[K("2,4")];
    delete shared[K("4")]; // Q unknown
    const simC = makeSim({ storeMap: shared, responders: { [RECS_URL]: { products: [] } } });
    simC.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900), LINE(4, 44, 1, 100)]);
    ok(vm.runInContext("renderCrossSell(document.createElement('div'))", simC.sandbox) === null && simC.timers.length === 1,
      "[P,Q] with cache(P) = [] and Q unknown: cannot conclude, a fetch is scheduled");
    // A pair fetch teaches the single-anchor entries: P empty, Q wins.
    const shared2 = {};
    const simD = makeSim({ storeMap: shared2, responders: { [RECS_URL]: (url) => (url.indexOf("product_id=4") !== -1 && url.indexOf("complementary") !== -1
      ? { products: [{ id: 91, handle: "rec-q", title: "Q rec", variants: [{ id: 701, price: 900 }] }] } : { products: [] }) } });
    simD.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900), LINE(4, 44, 1, 100)]);
    vm.runInContext("renderCrossSell(document.createElement('div'))", simD.sandbox);
    simD.timers[0].fn();
    await flush();
    ok(!!rowsOf(shared2, K("2,4")) && rowsOf(shared2, K("2")) && rowsOf(shared2, K("2")).length === 0 && rowsOf(shared2, K("4")) && rowsOf(shared2, K("4")).length === 1 && rowsOf(shared2, K("4"))[0].handle === "rec-q",
      "pair fetch persists the pair AND the per-anchor knowledge (P = [], Q = its rows)");
    // The winner is the FIRST anchor: the second anchor was never asked ('skipped') and stays unknown.
    const shared2b = {};
    const simD2 = makeSim({ storeMap: shared2b, responders: { [RECS_URL]: (url) => (url.indexOf("product_id=2") !== -1 && url.indexOf("complementary") !== -1
      ? { products: [{ id: 90, handle: "rec-p", title: "P rec", variants: [{ id: 700, price: 900 }] }] } : { products: [] }) } });
    simD2.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900), LINE(4, 44, 1, 100)]);
    vm.runInContext("renderCrossSell(document.createElement('div'))", simD2.sandbox);
    fire(simD2, 0);
    await flush();
    ok(!!rowsOf(shared2b, K("2,4")) && rowsOf(shared2b, K("2")) && rowsOf(shared2b, K("2"))[0].handle === "rec-p" && shared2b[K("4")] === undefined,
      "pair fetch, first anchor wins: its own entry stored, the skipped second anchor stays UNKNOWN (never cached as empty)");
    const simD3 = makeSim({ storeMap: shared2b, responders: { [RECS_URL]: { products: [] } } });
    simD3.sandbox.state.cart = cartWith([LINE(4, 44, 1, 100)]);
    ok(vm.runInContext("renderCrossSell(document.createElement('div'))", simD3.sandbox) === null && simD3.timers.length === 1,
      "a later cart with only the skipped anchor schedules its own fetch");
    // ...but a failed anchor stays unknown.
    const shared3 = {};
    const simE = makeSim({ storeMap: shared3, responders: { [RECS_URL]: (url) => (url.indexOf("product_id=2") !== -1 ? new Error("HTTP 500")
      : { products: [{ id: 91, handle: "rec-q", title: "Q rec", variants: [{ id: 701, price: 900 }] }] }) } });
    simE.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900), LINE(4, 44, 1, 100)]);
    vm.runInContext("renderCrossSell(document.createElement('div'))", simE.sandbox);
    simE.timers[0].fn();
    await flush();
    ok(shared3[K("2")] === undefined && !!rowsOf(shared3, K("4")), "pair fetch: the failed anchor's own entry stays unknown (never cached as empty); the winner's entry is stored");
    ok(!shared3[K("2,4")], "pair fetch: an anchor BEFORE the winner failed -> the set answer is not authoritative, not persisted under the set key");
    ok(simE.calls.renderAll === 1 && vm.runInContext("renderCrossSell(document.createElement('div'))", simE.sandbox) === "cart_cross_sell",
      "...but the rows still serve this page from memory");
    // Single anchor: complementary fails, related wins -> its own answer, authoritative.
    const shared4 = {};
    const simF = makeSim({ storeMap: shared4, responders: { [RECS_URL]: (url) => (url.indexOf("complementary") !== -1 ? new Error("HTTP 500")
      : { products: [{ id: 91, handle: "rec-q", title: "Q rec", variants: [{ id: 701, price: 900 }] }] }) } });
    simF.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    vm.runInContext("renderCrossSell(document.createElement('div'))", simF.sandbox);
    simF.timers[0].fn();
    await flush();
    ok(rowsOf(shared4, K("2")) && rowsOf(shared4, K("2")).length === 1 && rowsOf(shared4, K("2"))[0].handle === "rec-q", "single anchor: failed complementary + winning related = the anchor's own answer, persisted");
  }
  {
    // v16 B2B: rows stay in memory only (no sessionStorage) — catalog prices cannot be told apart client-side.
    const shared = {};
    const sim = makeSim({ storeMap: shared, cfg: { b2b: true }, responders: { [RECS_URL]: { products: [{ id: 90, handle: "rec-a", title: "A", variants: [{ id: 700, price: 900 }] }] } } });
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    shared["cx_xs:2:eu:EUR:en:2"] = JSON.stringify({ t: sim.clock.t, rows: [{ handle: "d2c", productId: 1, title: "D2C", image: null, variantId: 1, priceCents: 1, compareAtCents: 0 }] });
    ok(vm.runInContext("renderCrossSell(document.createElement('div'))", sim.sandbox) === null && sim.timers.length === 1, "B2B: a persisted D2C entry is ignored (fetch scheduled)");
    fire(sim, 0);
    await flush();
    ok(sim.calls.renderAll === 1 && vm.runInContext("renderCrossSell(document.createElement('div'))", sim.sandbox) === "cart_cross_sell",
      "B2B: fetched rows serve from memory");
    ok(rowsOf(shared, "cx_xs:2:eu:EUR:en:2") && rowsOf(shared, "cx_xs:2:eu:EUR:en:2")[0].handle === "d2c", "B2B: nothing written to sessionStorage");
    // the theme's own flag (window.isB2BCustomer) is the other B2B signal
    const simW = makeSim({ storeMap: shared, responders: { [RECS_URL]: { products: [] } } });
    simW.sandbox.window.isB2BCustomer = true;
    simW.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    ok(vm.runInContext("renderCrossSell(document.createElement('div'))", simW.sandbox) === null && simW.timers.length === 1, "B2B via window.isB2BCustomer: sessionStorage ignored too");
    // B2B / no store: the in-memory key stops re-scheduling and fetchNow (already live guard)
    fire(simW, 0);
    await flush();
    const wf = simW.calls.fetches.length;
    vm.runInContext("renderCrossSell(document.createElement('div'))", simW.sandbox);
    vm.runInContext("crossSellFetchNow()", simW.sandbox);
    await flush();
    ok(simW.calls.fetches.length === wf && simW.timers.filter((t) => !t.cleared && !t.fired).length === 0,
      "B2B (no session cache): the live in-memory key stops both the render path and fetchNow from refetching");
  }
  {
    // v16 debounce edge cases: latest key wins, no re-schedule while pending, stale rows keep rendering, TTL boundary.
    let release;
    const gate = new Promise((r) => { release = r; });
    const sim = makeSim({ responders: { [RECS_URL]: (url) => (url.indexOf("product_id=2") !== -1
      ? { products: [{ id: 90, handle: "rec-a", title: "A", variants: [{ id: 700, price: 900 }] }] }
      : gate.then(() => ({ products: [] }))) } });
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    vm.runInContext("renderCrossSell(document.createElement('div'))", sim.sandbox);
    sim.timers[0].fn();
    await flush();
    const host = sim.doc.createElement("div");
    sim.sandbox.__host = host;
    ok(vm.runInContext("renderCrossSell(__host)", sim.sandbox) === "cart_cross_sell", "rows for anchor A committed");
    sim.sandbox.state.cart = cartWith([LINE(9, 99, 1, 50000)]); // anchor B
    const hostB = sim.doc.createElement("div");
    sim.sandbox.__hostB = hostB;
    ok(vm.runInContext("renderCrossSell(__hostB)", sim.sandbox) === "cart_cross_sell" && hostB.querySelectorAll(".cx-crosssell__item").length === 1,
      "anchor change: STALE rows keep rendering while the fetch for the new key is pending");
    const live = sim.timers.filter((t) => !t.cleared && !t.fired);
    ok(live.length === 1 && sim.sandbox.autoCrossSell.timerKey === "cx_xs:2:eu:EUR:en:9", "one live timer for the new key");
    sim.sandbox.state.cart = cartWith([LINE(10, 100, 1, 60000)]); // anchor C before B fired
    vm.runInContext("renderCrossSell(document.createElement('div'))", sim.sandbox);
    ok(live[0].cleared === true && sim.timers.filter((t) => !t.cleared && !t.fired).length === 1 && sim.sandbox.autoCrossSell.timerKey === "cx_xs:2:eu:EUR:en:10",
      "latest key wins: B's timer cleared, one live timer for C");
    (sim.timers.filter((t) => !t.cleared && !t.fired)[0] || { fn() {} }).fn(); // C in flight (gated)
    await flush();
    vm.runInContext("renderCrossSell(document.createElement('div'))", sim.sandbox);
    ok(sim.timers.filter((t) => !t.cleared && !t.fired).length === 0 && sim.sandbox.autoCrossSell.pending["cx_xs:2:eu:EUR:en:10"] === true,
      "re-render while the key is in flight: no new timer");
    release();
    await flush();
    // TTL boundary: exactly TTL old is still fresh, TTL+1 is stale.
    const simT = makeSim();
    simT.storeMap["k"] = JSON.stringify({ t: simT.clock.t - 600000, rows: [] });
    ok(Array.isArray(vm.runInContext("crossSellCacheGet('k')", simT.sandbox)), "cache entry exactly 10 minutes old is still served");
    simT.storeMap["k"] = JSON.stringify({ t: simT.clock.t - 600001, rows: [] });
    ok(vm.runInContext("crossSellCacheGet('k')", simT.sandbox) === null, "cache entry older than 10 minutes is a miss");
  }
  {
    // v16 crossSellFetchNow (theme hand-off): no debounce, drops a pending timer for the same key, adopts the cache when present.
    let release;
    const gate = new Promise((r) => { release = r; });
    const sim = makeSim({ responders: { [RECS_URL]: () => gate.then(() => ({ products: [{ id: 90, handle: "rec-a", title: "A", variants: [{ id: 700, price: 900 }] }] })) } });
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    vm.runInContext("renderCrossSell(document.createElement('div'))", sim.sandbox); // schedules the 200 ms timer
    ok(sim.timers.length === 1, "render path scheduled the debounce");
    vm.runInContext("crossSellFetchNow()", sim.sandbox);
    await flush();
    ok(sim.timers[0].cleared === true && sim.calls.fetches.length === 1 && sim.sandbox.autoCrossSell.pending["cx_xs:2:eu:EUR:en:2"] === true,
      "fetchNow: timer dropped, fetch started without waiting for the debounce");
    vm.runInContext("crossSellFetchNow()", sim.sandbox);
    await flush();
    ok(sim.calls.fetches.length === 1, "fetchNow while in flight: no second fetch");
    release();
    await flush();
    ok(sim.calls.renderAll === 1 && sim.sandbox.autoCrossSell.key === "cx_xs:2:eu:EUR:en:2", "fetchNow result committed + rendered");
    vm.runInContext("crossSellFetchNow()", sim.sandbox);
    await flush();
    ok(sim.calls.fetches.length === 1, "fetchNow with the key already live: no-op");
    const off = makeSim({ effective: { crossSell: false }, responders: { [RECS_URL]: { products: [] } } });
    off.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    vm.runInContext("crossSellFetchNow()", off.sandbox);
    const manual = makeSim({ settings: { crossSellMode: "manual" }, responders: { [RECS_URL]: { products: [] } } });
    manual.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    vm.runInContext("crossSellFetchNow()", manual.sandbox);
    await flush();
    ok(off.calls.fetches.length === 0 && manual.calls.fetches.length === 0, "fetchNow is inert when cross-sell is off or manual");
    // fetchNow adopts a cached answer (single key) and a derived one (pair from singles): no fetch, no timer.
    const K = (ids) => "cx_xs:2:eu:EUR:en:" + ids;
    const rowsP = [{ handle: "rec-p", productId: 90, title: "P rec", image: null, variantId: 700, priceCents: 900, compareAtCents: 0 }];
    const cached = makeSim({ responders: { [RECS_URL]: () => new Error("must not fetch") } });
    cached.storeMap[K("2")] = JSON.stringify({ t: cached.clock.t, rows: rowsP });
    cached.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    vm.runInContext("crossSellFetchNow()", cached.sandbox);
    await flush();
    ok(cached.calls.fetches.length === 0 && Object.keys(cached.sandbox.autoCrossSell.pending).length === 0 && cached.timers.length === 0,
      "fetchNow with the answer in the session cache: no fetch, nothing pending");
    cached.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900), LINE(4, 44, 1, 100)]);
    cached.storeMap[K("4")] = JSON.stringify({ t: cached.clock.t, rows: [] });
    vm.runInContext("crossSellFetchNow()", cached.sandbox);
    await flush();
    ok(cached.calls.fetches.length === 0 && Object.keys(cached.sandbox.autoCrossSell.pending).length === 0,
      "fetchNow with a DERIVED answer (pair from the single entries): no fetch");
    const hostC = cached.doc.createElement("div");
    cached.sandbox.__host = hostC;
    ok(vm.runInContext("renderCrossSell(__host)", cached.sandbox) === "cart_cross_sell" && hostC.querySelector(".cx-crosssell__name").textContent === "P rec" && cached.calls.fetches.length === 0,
      "...and the render adopts the same derived rows");
  }
  {
    // v16 scheduleRefresh() re-installs the theme hook (idempotent) for a theme that defines refreshMiniCart late.
    const sim = makeSim();
    vm.runInContext("installThemeCartHook()", sim.sandbox); // nothing to wrap yet
    ok(sim.sandbox.window.refreshMiniCart === undefined, "boot without the theme function: nothing installed");
    const late = function () { return "late"; };
    sim.sandbox.window.refreshMiniCart = late;
    vm.runInContext("scheduleRefresh()", sim.sandbox);
    ok(sim.sandbox.window.refreshMiniCart !== late && sim.sandbox.window.refreshMiniCart.__cxCartHook === true, "scheduleRefresh() (any observer tick) installs the hook once the theme function exists");
    ok(sim.timers.length === 1 && sim.timers[0].ms === 120, "scheduleRefresh still arms the 120 ms reconcile timer");
    const w1 = sim.sandbox.window.refreshMiniCart;
    vm.runInContext("scheduleRefresh()", sim.sandbox);
    ok(sim.sandbox.window.refreshMiniCart === w1 && sim.timers[0].cleared === true && sim.timers.length === 2, "second tick: same wrapper (idempotent), timer debounced");
    sim.sandbox.window.refreshMiniCart = function () { return "redefined"; }; // theme redefined it after our wrap
    vm.runInContext("scheduleRefresh()", sim.sandbox);
    ok(sim.sandbox.window.refreshMiniCart.__cxCartHook === true && sim.sandbox.window.refreshMiniCart() === "redefined", "a redefined theme function is re-wrapped and still returns its own result");
  }
  {
    // crossSellWarm(): pre-fills the cache for anchors the cart does not have yet (product-page pre-warm).
    const sim = makeSim({
      responders: { [RECS_URL]: { products: [{ id: 90, handle: "rec-a", title: "Rec A", variants: [{ id: 700, price: 900 }] }] } },
    });
    sim.sandbox.state.cart = cartWith([]); // empty cart on the product page
    vm.runInContext("crossSellWarm([{ product_id: 2, handle: 'p2' }])", sim.sandbox);
    await flush();
    ok(sim.calls.fetches.length === 1 && sim.calls.fetches[0].url.indexOf("product_id=2") !== -1, "warm fetches recommendations for the future anchor immediately (no debounce)");
    ok(sim.calls.renderAll === 0 && sim.sandbox.autoCrossSell.key === null, "warm never touches the live rows / never re-renders");
    ok(!!sim.storeMap["cx_xs:2:eu:EUR:en:2"], "warm result cached under the anchor key");
    vm.runInContext("crossSellWarm([{ product_id: 2, handle: 'p2' }])", sim.sandbox);
    await flush();
    ok(sim.calls.fetches.length === 1, "warm is a no-op when the key is already cached");
    // The add-to-cart lands: anchors = [2] -> synchronous render from the warmed cache.
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    const host = sim.doc.createElement("div");
    sim.sandbox.__host = host;
    ok(vm.runInContext("renderCrossSell(__host)", sim.sandbox) === "cart_cross_sell" && sim.timers.length === 0 && sim.calls.fetches.length === 1,
      "first drawer render after the add: rows from the warmed cache, no fetch, no timer");
    // warm respects the feature gate / manual mode
    const off = makeSim({ effective: { crossSell: false }, responders: { [RECS_URL]: { products: [] } } });
    vm.runInContext("crossSellWarm([{ product_id: 2 }])", off.sandbox);
    const manual = makeSim({ settings: { crossSellMode: "manual" }, responders: { [RECS_URL]: { products: [] } } });
    vm.runInContext("crossSellWarm([{ product_id: 2 }])", manual.sandbox);
    await flush();
    ok(off.calls.fetches.length === 0 && manual.calls.fetches.length === 0, "warm is inert when cross-sell is off or manual");
  }

  // --- v16 product data fast path (products-map for the offers) -----------------------
  {
    const AJAX = {
      id: 42, handle: "cellular-cream", title: "Cream", tags: ["skin", "sample-sachet"],
      variants: [
        { id: 4201, option1: "1 unit", price: 4900, compare_at_price: null, available: true,
          selling_plan_allocations: [{ selling_plan_id: 777, price: 4655, price_adjustments: [{ position: 1, price: 4655 }] }] },
        { id: 4202, option1: "2 units", price: 8330, compare_at_price: 9800, available: false, selling_plan_allocations: [] },
        { id: 4203, option1: "3 units", price: 11760, compare_at_price: 14700 },
      ],
      selling_plan_groups: [{ id: "g1", name: "Continuous Treatment", selling_plans: [
        { id: 777, name: "Every 2 months", price_adjustments: [{ order_count: null, position: 1, value_type: "percentage", value: 5 }] },
        { id: 778, name: "No adjustment" },
      ] }],
    };
    const sim = makeSim();
    sim.sandbox.__ajax = AJAX;
    const entry = vm.runInContext("productFromAjaxJson(__ajax)", sim.sandbox);
    ok(!!entry && entry.variants.length === 3, "adapter: one entry per variant");
    ok(entry.variants.map((v) => v.position).join(",") === "1,2,3", "adapter: position = 1-based variant order (the volume tier)");
    ok(entry.variants[0].id === 4201 && entry.variants[0].price === 4900 && entry.variants[0].compare_at_price === null && entry.variants[0].available === true && entry.variants[0].option1 === "1 unit",
      "adapter: id / price / compare_at null / available / option1 mapped");
    ok(entry.variants[1].compare_at_price === 9800 && entry.variants[1].available === false, "adapter: compare-at + sold-out variant kept as unavailable");
    ok(entry.variants[2].available === true && entry.variants[2].planAllocations.length === 0, "adapter: missing available -> available; missing allocations -> []");
    ok(entry.variants[0].planAllocations.length === 1 && entry.variants[0].planAllocations[0].planId === 777 && entry.variants[0].planAllocations[0].price === 4655,
      "adapter: selling_plan_allocations -> planAllocations [{planId, price}]");
    ok(entry.sellingPlanGroups.length === 1 && entry.sellingPlanGroups[0].name === "Continuous Treatment" && entry.sellingPlanGroups[0].plans.length === 2,
      "adapter: selling_plan_groups -> sellingPlanGroups [{id, name, plans}]");
    ok(entry.sellingPlanGroups[0].plans[0].valueType === "percentage" && entry.sellingPlanGroups[0].plans[0].value === 5 &&
       entry.sellingPlanGroups[0].plans[1].valueType === null && entry.sellingPlanGroups[0].plans[1].value === 0,
      "adapter: price_adjustments[0] -> valueType/value, defaults null/0");
    ok(entry.s === 1, "adapter: sample-sachet tag -> s:1 (the rewards sachet flag)");
    ok(vm.runInContext("productFromAjaxJson({ id: 1, variants: [] })", sim.sandbox) === null &&
       vm.runInContext("productFromAjaxJson({ id: 1 })", sim.sandbox) === null &&
       vm.runInContext("productFromAjaxJson(null)", sim.sandbox) === null &&
       vm.runInContext("productFromAjaxJson({ id: 1, variants: [{ price: 1 }] })", sim.sandbox) === null,
      "adapter: unusable shapes (no variants / variant without id) -> null");
    // The adapted entry drives the REAL volume / subscription math the same way island data does.
    const simV = makeSim({ effective: { volume: true }, settings: { volumeOffers: [{ quantity: 2, discountPct: 15 }, { quantity: 3, discountPct: 20 }], sellingPlanKeyword: "Continuous Treatment", subscriptionDiscountPct: 5 } });
    simV.sandbox.CART_FEATURE_KEYS.volume = "cart_volume_upsell";
    simV.sandbox.__ajax = AJAX;
    vm.runInContext("state.products['42'] = productFromAjaxJson(__ajax)", simV.sandbox);
    simV.sandbox.__item = { product_id: 42, variant_id: 4201, quantity: 1, key: "42:1" };
    ok(vm.runInContext("variantByPosition(productFor(__item), 2).id === 4202 && currentVariant(productFor(__item), 4201).position === 1", simV.sandbox),
      "adapter -> real volume math: variantByPosition / currentVariant resolve the tiers");
    ok(vm.runInContext("savingsPercent(productFor(__item), { quantity: 2 }, variantByPosition(productFor(__item), 2))", simV.sandbox) === 15 &&
       vm.runInContext("savingsPercent(productFor(__item), { quantity: 3 }, variantByPosition(productFor(__item), 3))", simV.sandbox) === 20,
      "adapter -> real savings math: 2 units = 15%, 3 units = 20% from the adapted prices");
    const cands = vm.runInContext("upgradeCandidates(__item)", simV.sandbox);
    ok(cands.length === 1 && cands[0].quantity === 3 && cands[0].percent === 20 && cands[0].variant.id === 4203 && cands[0].perUnitCents === 3920,
      "adapter -> real upgradeCandidates: sold-out 2-unit tier skipped, 3-unit tier offered (20%, per-unit 39.20)");
    const plan = vm.runInContext("findPlanForItem(__item)", simV.sandbox);
    ok(!!plan && plan.id === 777 && plan.name === "Every 2 months" && plan.allocPrice === 4655 && plan.valueType === "percentage" && plan.value === 5,
      "adapter -> real subscription lookup: keyword-matched plan via the variant's planAllocations + group metadata");
    ok(vm.runInContext("linePlanPercent(__item, findPlanForItem(__item))", simV.sandbox) === 5, "adapter -> real line plan percent (allocation price vs one-time price) = 5%");
    ok(vm.runInContext("variantAllocatesPlan(currentVariant(productFor(__item), 4202), 777)", simV.sandbox) === false &&
       vm.runInContext("upgradeCandidates(Object.assign({}, __item, { selling_plan_allocation: { selling_plan: { id: 777 } } })).length", simV.sandbox) === 0,
      "adapter -> subscribed line: tier variants without the plan allocation are never offered (v5.1 rule holds on Ajax data)");
    ok(vm.runInContext("productHandleFromPath('/fr/collections/soins/products/creme-cellulaire?variant=1#x')", sim.sandbox) === "creme-cellulaire" &&
       vm.runInContext("productHandleFromPath('/products/x/')", sim.sandbox) === "x" &&
       vm.runInContext("productHandleFromPath('/collections/all')", sim.sandbox) === "" &&
       vm.runInContext("productHandleFromPath(null)", sim.sandbox) === "",
      "productHandleFromPath: locale + collection prefixes, query/hash/trailing slash stripped; non-product urls -> ''");
    ok(vm.runInContext("productJsonUrl('creme')", sim.sandbox) === "/products/creme.js", "productJsonUrl = routeRoot() + products/<handle>.js");
    const simFr = makeSim({ shopify: { routes: { root: "/fr/" } } });
    ok(vm.runInContext("productJsonUrl('creme')", simFr.sandbox) === "/fr/products/creme.js", "productJsonUrl keeps the locale/market root");
  }
  {
    // ensureProductData: (1) page prefetch awaited, (2) products/<handle>.js per missing line, (3) proxy last.
    const AJAX = (id) => ({ id, handle: "p" + id, variants: [{ id: id * 10 + 1, price: 100 }, { id: id * 10 + 2, price: 170 }] });
    const sim = makeSim({
      responders: {
        "/products/p8.js": AJAX(8),
        "/products/p9.js": () => new Error("HTTP 404"),
        [PROXY_URL]: { products: { "9": { variants: [{ id: 91, price: 100, position: 1 }] } } },
      },
    });
    const cart = cartWith([
      Object.assign(LINE(8, 81, 1, 100), { url: "/products/p8?variant=81" }),
      Object.assign(LINE(9, 91, 1, 100), { url: "/products/p9" }),
      LINE(7, 71, 1, 100), // no url at all -> proxy only
    ]);
    sim.sandbox.state.products = { "7": { variants: [{ id: 71, price: 100, position: 1 }] } };
    ok(vm.runInContext("missingProductIds(" + JSON.stringify(cart) + ").join(',')", sim.sandbox) === "8,9", "missingProductIds: island products skipped, dedupe");
    const fetched = await vm.runInContext("ensureProductData(" + JSON.stringify(cart) + ")", sim.sandbox);
    ok(fetched === true, "ensureProductData resolves true when data was fetched");
    ok(!!sim.sandbox.state.products["8"] && sim.sandbox.state.products["8"].variants[1].position === 2,
      "missing product filled from products/<handle>.js (adapted, positions assigned)");
    const urls = sim.calls.fetches.map((f) => f.url);
    ok(urls.indexOf("/products/p8.js") !== -1 && urls.indexOf("/products/p9.js") !== -1, "one Ajax product request per missing line");
    ok(urls.filter((u) => u.indexOf(PROXY_URL) === 0).length === 1, "proxy called ONCE, only for what the fast path could not fill (p9 404)");
    ok(!!sim.sandbox.state.products["9"] && sim.sandbox.state.products["9"].variants[0].id === 91, "proxy fallback still fills the rest");
    ok(urls.indexOf("/products/p8.js") < urls.findIndex((u) => u.indexOf(PROXY_URL) === 0), "fast path runs BEFORE the proxy");
    // Nothing missing: no network, resolves false.
    const before = sim.calls.fetches.length;
    ok((await vm.runInContext("ensureProductData(" + JSON.stringify(cart) + ")", sim.sandbox)) === false && sim.calls.fetches.length === before,
      "nothing missing: no request, resolves false");
    // Everything filled by the fast path: proxy never called.
    const sim2 = makeSim({ responders: { "/products/p8.js": AJAX(8), [PROXY_URL]: () => new Error("proxy must not be called") } });
    const cart2 = cartWith([Object.assign(LINE(8, 81, 1, 100), { url: "/fr/products/p8?variant=81" })]);
    ok((await vm.runInContext("ensureProductData(" + JSON.stringify(cart2) + ")", sim2.sandbox)) === true &&
       sim2.calls.fetches.length === 1 && sim2.calls.fetches[0].url === "/products/p8.js",
      "fast path alone fills the map: zero proxy calls (handle taken from the line url, root from routeRoot)");
    // Island data is never overwritten by the fast path.
    const sim3 = makeSim({ responders: { "/products/p8.js": AJAX(8) } });
    sim3.sandbox.state.products = { "8": { variants: [{ id: 81, price: 999, position: 1 }] } };
    await vm.runInContext("ensureProductData(" + JSON.stringify(cart2) + ")", sim3.sandbox);
    vm.runInContext("mergeAjaxProduct(" + JSON.stringify(AJAX(8)) + ")", sim3.sandbox);
    ok(sim3.sandbox.state.products["8"].variants[0].price === 999 && sim3.calls.fetches.length === 0, "existing (island) entries win over Ajax data");
    // Page-product prefetch: awaited first, warms the cross-sell for that product; then the missing check is re-run.
    const sim4 = makeSim({
      pathname: "/fr/products/p8",
      responders: {
        "/products/p8.js": AJAX(8),
        [RECS_URL]: { products: [{ id: 90, handle: "rec-a", title: "A", variants: [{ id: 700, price: 900 }] }] },
        [PROXY_URL]: () => new Error("proxy must not be called"),
      },
    });
    const pre = vm.runInContext("prefetchPageProduct()", sim4.sandbox);
    ok(pre && typeof pre.then === "function" && vm.runInContext("prefetchPageProduct()", sim4.sandbox) === pre, "prefetch: one shared promise per page");
    const cart4 = cartWith([LINE(8, 81, 1, 100)]); // no url — only the prefetch (or the proxy) can fill it
    const p4 = vm.runInContext("ensureProductData(" + JSON.stringify(cart4) + ")", sim4.sandbox);
    ok((await p4) === true && !!sim4.sandbox.state.products["8"], "ensureProductData waits for the in-flight page prefetch instead of hitting the proxy");
    await flush();
    ok(sim4.calls.fetches.some((f) => f.url.indexOf(RECS_URL) === 0 && f.url.indexOf("product_id=8") !== -1) && !!sim4.storeMap["cx_xs:2:eu:EUR:en:8"],
      "prefetch warms the auto cross-sell cache for the page product");
    ok(sim4.calls.fetches.every((f) => f.url.indexOf(PROXY_URL) !== 0), "product page add: zero proxy calls");
    const none = makeSim({ pathname: "/collections/all" });
    ok(vm.runInContext("prefetchPageProduct()", none.sandbox) === null && none.calls.fetches.length === 0, "non-product page: prefetch is a no-op");
  }

  // --- v16 theme hand-off hook -----------------------------------------------------
  {
    const order = [];
    const sim = makeSim({
      responders: { "/products/p8.js": { id: 8, handle: "p8", variants: [{ id: 81, price: 100 }, { id: 82, price: 170 }] }, [RECS_URL]: () => new Error("HTTP 503") },
    });
    let cartArg = null;
    sim.sandbox.renderAll = () => { sim.calls.renderAll++; order.push("render:" + (sim.sandbox.state.cart === cartArg) + ":" + (sim.sandbox.state.themeStale === null)); };
    sim.sandbox.window.refreshMiniCart = function (cart) { order.push("orig:" + (cart && cart.items ? cart.items.length : "?") + ":" + (arguments.length)); return "orig-return"; };
    const original = sim.sandbox.window.refreshMiniCart;
    vm.runInContext("installThemeCartHook()", sim.sandbox);
    const wrapped = sim.sandbox.window.refreshMiniCart;
    ok(wrapped !== original && wrapped.__cxCartHook === true, "hook installed once (marked)");
    vm.runInContext("installThemeCartHook()", sim.sandbox);
    ok(sim.sandbox.window.refreshMiniCart === wrapped && order.length === 0, "second install is a no-op: the very same wrapper stays (never double-wrapped)");
    sim.sandbox.state.themeStale = { items: [] };
    const cart = cartWith([Object.assign(LINE(8, 81, 1, 100), { url: "/products/p8?variant=81" })], "tok-theme");
    cartArg = cart;
    const ret = wrapped(cart, "extra");
    ok(ret === "orig-return", "wrapper returns the theme function's own result");
    ok(sim.sandbox.state.cart === cart && sim.sandbox.state.themeStale === null, "theme cart seeded synchronously; stale catch-up cleared");
    ok(order.join(",") === "render:true:true,orig:1:2", "renders with the NEW cart seeded BEFORE the original runs (same frame the drawer opens); original gets every argument (" + order.join(",") + ")");
    ok(sim.timers.length === 0 && sim.sandbox.autoCrossSell.pending["cx_xs:2:eu:EUR:en:8"] === true, "hand-off kicks the cross-sell fetch immediately (in flight, no debounce timer)");
    await flush();
    ok(sim.calls.fetches.some((f) => f.url.indexOf(RECS_URL) === 0), "hand-off: recommendations requested");
    ok(!!sim.sandbox.state.products["8"] && sim.calls.renderAll === 2, "missing product fetched via the fast path, then ONE re-render (the failed cross-sell fetch renders nothing)");
    order.length = 0;
    wrapped(cart);
    await flush();
    ok(order.join(",") === "render:true:true,orig:1:1" && sim.calls.renderAll === 3, "nothing missing: single synchronous render, no extra re-render");
    order.length = 0;
    wrapped(null);
    wrapped({ item_count: 0 });
    ok(order.join(",") === "orig:?:1,orig:?:1" && sim.sandbox.state.cart === cart, "non-cart arguments pass straight through, state untouched");
    // Never break the theme: a throwing renderAll / a rejecting product fetch still lets the original run and return.
    order.length = 0;
    sim.sandbox.renderAll = () => { sim.calls.renderAll++; throw new Error("boom"); };
    let threw = false;
    let ret2 = null;
    try { ret2 = wrapped(cart); } catch (e) { threw = true; }
    ok(!threw && ret2 === "orig-return" && order.join(",") === "orig:1:1", "renderAll throwing inside the wrapper: swallowed, original still runs and returns");
    const simR = makeSim({ effective: { crossSell: false }, responders: { "/products/p9.js": () => new Error("HTTP 404"), [PROXY_URL]: () => new Error("HTTP 500") } });
    let origCalls = 0;
    simR.sandbox.window.refreshMiniCart = function () { origCalls++; return "ok"; };
    vm.runInContext("installThemeCartHook()", simR.sandbox);
    const cartR = cartWith([Object.assign(LINE(9, 91, 1, 100), { url: "/products/p9" })]);
    let rejected = false;
    process.once("unhandledRejection", () => { rejected = true; });
    ok(simR.sandbox.window.refreshMiniCart(cartR) === "ok" && origCalls === 1, "product data unavailable everywhere: original still ran");
    await flush();
    ok(!rejected && simR.calls.renderAll === 1, "product fetch + proxy both failing: no unhandled rejection, no extra render");
    // No theme function: install is a silent no-op.
    const bare = makeSim();
    vm.runInContext("installThemeCartHook()", bare.sandbox);
    ok(bare.sandbox.window.refreshMiniCart === undefined, "no refreshMiniCart on the page: nothing installed");
  }

  // --- manual mode --------------------------------------------------------------------
  {
    const csx = [
      { v: 501, p: 71, c: 1900, n: "Serum", pf: "€19.00", i: "https://cdn/a.jpg", i2: "https://cdn/a2.jpg" },
      { v: 502, p: 72, c: 2900, n: "Cream", pf: "<span>€29.00</span>", cf: "€39.00", cc: 3900 },
      { v: 503, p: 5, c: 900, n: "InCart", pf: "€9.00" },
    ];
    const sim = makeSim({
      settings: { crossSellMode: "manual", crossSellMaxItems: 4 },
      cfg: { currency: "EUR", overrides: { crossSellTitle: "   " }, csx },
    });
    sim.sandbox.state.cart = cartWith([LINE(5, 55, 1, 100)]);
    const host = sim.doc.createElement("div");
    sim.sandbox.__host = host;
    const out = vm.runInContext("renderCrossSell(__host)", sim.sandbox);
    ok(out === "cart_cross_sell", "manual mode renders from the cfg.csx island");
    ok(sim.calls.fetches.length === 0, "manual mode: zero network");
    const items = host.querySelectorAll(".cx-crosssell__item");
    ok(items.length === 2, "manual rows pruned by the shared path (in-cart product hidden)");
    ok(host.querySelector(".cx-crosssell__title").textContent === "You may also like",
      "whitespace-only title override falls back to the translated default");
    const priceTexts = items.map((li) => li.querySelector(".cx-crosssell__price").textContent);
    ok(priceTexts[0] === "€19.00", "plain Liquid money string lands verbatim");
    const eur29 = vm.runInContext("money(2900)", sim.sandbox);
    ok(priceTexts[1] === eur29, "markup-bearing money format falls back to the runtime formatter");
    const cmp = items[1].querySelector(".cx-crosssell__compare");
    ok(!!cmp && cmp.textContent === "€39.00", "compare-at string rendered");

    sim.sandbox.cfg.overrides.crossSellTitle = "Complete the set";
    const host2 = sim.doc.createElement("div");
    sim.sandbox.__host2 = host2;
    vm.runInContext("renderCrossSell(__host2)", sim.sandbox);
    ok(host2.querySelector(".cx-crosssell__title").textContent === "Complete the set",
      "non-blank title override wins");
  }
  {
    // Manual mode with no island: nothing renders (the old template-emission gate).
    const sim = makeSim({ settings: { crossSellMode: "manual" }, cfg: { currency: "EUR", overrides: {} } });
    sim.sandbox.state.cart = cartWith([LINE(5, 55, 1, 100)]);
    sim.sandbox.__host = sim.doc.createElement("div");
    ok(vm.runInContext("renderCrossSell(__host)", sim.sandbox) === null,
      "manual mode without cfg.csx renders nothing");
    // feature off: nothing renders in either mode.
    const off = makeSim({ effective: { crossSell: false } });
    off.sandbox.state.cart = cartWith([LINE(5, 55, 1, 100)]);
    off.sandbox.__host = off.doc.createElement("div");
    ok(vm.runInContext("renderCrossSell(__host)", off.sandbox) === null,
      "feature off: renderCrossSell renders nothing");
  }

  if (failures > 0) {
    console.error(`\n${failures}/${checks} CHECKS FAILED`);
    process.exit(1);
  }
  console.log(`ALL ${checks} CHECKS PASSED (cart cross-sell pipeline vs the real cellexia-cart.js)`);

  // ---------------------------------------------------------- mutation tests
  if (!process.env.CX_SKIP_MUTANTS && SRC_PATH === REAL_SRC) {
    const { runMutants } = require("./lib/mutants.cjs");
    const MUTANTS = [
      {
        name: "m1-related-first",
        find: "attempts.push({ id: item.product_id, intent: 'complementary', i: i });\n      attempts.push({ id: item.product_id, intent: 'related', i: i });",
        replace: "attempts.push({ id: item.product_id, intent: 'related', i: i });\n      attempts.push({ id: item.product_id, intent: 'complementary', i: i });",
      },
      {
        name: "m2-fallback-inverted",
        find: "if (out.products.length) return;",
        replace: "if (!out.products.length) return;",
      },
      {
        name: "m3-cap-off-by-one",
        find: "visible >= cap;",
        replace: "visible > cap;",
      },
      {
        name: "m4-protection-anchors",
        find: "if (String(item.handle || '') === PROTECTION_HANDLE) continue;",
        replace: "if (false) continue;",
      },
      {
        name: "m5-commit-unguarded",
        find: "if (crossSellCurrentKey() === key) { // commit only for the anchors we fetched for",
        replace: "if (true) { // commit only for the anchors we fetched for",
      },
      {
        name: "m6-cache-ttl-ignored",
        find: "if (Date.now() - parsed.t > CROSS_SELL_CACHE_TTL) return null;",
        replace: "if (false) return null;",
      },
      {
        name: "m7-ajax-skipped",
        find: "var handle = productHandleFromPath(item.url);\n      if (!handle) continue;",
        replace: "var handle = productHandleFromPath(item.url);\n      if (true) continue;",
      },
      {
        name: "m8-skiph-dropped",
        find: "(state.rw && state.rw.skipH && handle && state.rw.skipH[String(handle)] === true) ||",
        replace: "false ||",
      },
      {
        name: "m10-hook-no-sync-render",
        find: "state.themeStale = null; // the theme is about to render exactly this cart\n            renderAll();",
        replace: "state.themeStale = null; // the theme is about to render exactly this cart\n            ;",
      },
      {
        name: "m9-currency-blind-key",
        find: "return 'cx_xs:2:' + MARKET + ':' + activeCurrency() + ':' + locale + ':' + ids.join(',');",
        replace: "return 'cx_xs:2:' + MARKET + ':' + 'EUR' + ':' + locale + ':' + ids.join(',');",
      },
      {
        name: "m11-failure-persisted",
        find: "if (!out.answered) throw new Error('recommendations unavailable');",
        replace: "if (false) throw new Error('recommendations unavailable');",
      },
      {
        name: "m12-hook-seed-after-render",
        find: "state.cart = cart;\n            state.themeStale = null; // the theme is about to render exactly this cart\n            renderAll();",
        replace: "renderAll();\n            state.cart = cart;\n            state.themeStale = null; // the theme is about to render exactly this cart",
      },
      {
        name: "m13-market-blind-key",
        find: "return 'cx_xs:2:' + MARKET + ':' + activeCurrency()",
        replace: "return 'cx_xs:2:' + 'eu' + ':' + activeCurrency()",
      },
      {
        name: "m14-unknown-anchor-as-empty",
        find: "if (single === null) return null; // unknown: the chain must run",
        replace: "if (single === null) continue; // unknown: the chain must run",
      },
      {
        name: "m16-unauthoritative-persisted",
        find: "if (authoritative) crossSellCachePut(key, rows);",
        replace: "if (true) crossSellCachePut(key, rows);",
      },
      {
        name: "m17-fetchnow-ignores-cache",
        find: "if (crossSellCacheResolve(anchors)) return; // renderAll adopts it on its next pass",
        replace: "; // renderAll adopts it on its next pass",
      },
      {
        name: "m18-fetchnow-live-key-refetch",
        find: "if (!key || autoCrossSell.key === key || autoCrossSell.pending[key]) return;\n      if (crossSellCacheResolve(anchors)) return;",
        replace: "if (!key || autoCrossSell.pending[key]) return;\n      if (crossSellCacheResolve(anchors)) return;",
      },
      {
        name: "m19-hook-reinstall-dropped",
        find: "installThemeCartHook(); // v16: idempotent",
        replace: "; // v16: idempotent",
      },
      {
        name: "m20-derived-restored",
        find: "if (single.length) return single;\n    }\n    return []; // every anchor answered \"nothing\"",
        replace: "if (single.length) { crossSellCachePut(key, single); return single; }\n    }\n    return []; // every anchor answered \"nothing\"",
      },
      {
        name: "m21-skipped-as-empty",
        find: "else if (out.outcomes[j] === 'empty') crossSellCachePut(crossSellAnchorKey([anchors[j]]), []);",
        replace: "else if (out.outcomes[j] !== 'failed') crossSellCachePut(crossSellAnchorKey([anchors[j]]), []);",
      },
      {
        name: "m15-b2b-persisted",
        find: "if (isB2B()) return null;\n    try { return window.sessionStorage || null; }",
        replace: "if (false) return null;\n    try { return window.sessionStorage || null; }",
      },
    ];
    const bad = runMutants({ selfPath: __filename, srcPath: REAL_SRC, mutants: MUTANTS });
    if (bad > 0) {
      console.error(`${bad}/${MUTANTS.length} MUTANTS ESCAPED`);
      process.exit(1);
    }
    console.log(`ALL ${MUTANTS.length} MUTANTS CAUGHT (crosssell-pipeline)`);
  }
}

main().catch((e) => {
  console.error("SIM CRASHED:", e);
  process.exit(1);
});
