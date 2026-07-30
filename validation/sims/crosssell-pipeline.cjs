/**
 * Cart cross-sell pipeline sim — runs the REAL v4.8/v4.9/v6.7 cross-sell
 * machinery vm-extracted from
 * extensions/cellexia-booster/assets/cellexia-cart.js:
 *
 *  - anchors: highest-value line first, protection product never anchors,
 *    max two distinct products;
 *  - complementary -> related fallback per source, anchor before fallback,
 *    first non-empty recommendations answer wins (no extra fetches);
 *  - pick pipeline: handle dedupe, in-cart product exclusion, protection
 *    exclusion, 6-pick cap, first-available-variant enrichment via the
 *    app proxy (unknown/sold-out handles drop silently);
 *  - shared prune/wire: display cap (default 2 on invalid settings),
 *    product- AND variant-level in-cart hiding, add-button wiring;
 *  - attribution: one-click add posts _cellexia_upsell:'cart' with the
 *    busy-guard and the revenue beacon;
 *  - cache: per cart-token+line-signature, commit only for the cart the
 *    fetch was started for, 200 ms debounce, one in-flight per signature;
 *  - manual mode: cfg.csx island rows, override-title blank gate, money
 *    markup fallback.
 *
 * Documented stubs: decodeEntities = identity (no entities in sim
 * strings), drawerIsOpen/isCartPageContext/renderAll/safeThemeRefresh/
 * decorateSubscriptionRows/setNotice/track are environment probes and
 * recorders; fetchJSON is a scripted recorder (network never leaves the
 * sim). Timers are injected (no Date.now / real setTimeout flakiness).
 *
 * MUTATION TESTS (all must be CAUGHT — non-zero exit on a mutant copy):
 *   m1-related-first      complementary/related attempt order swapped
 *   m2-fallback-inverted  "first non-empty wins" guard inverted
 *   m3-cap-off-by-one     prune display cap >= -> >
 *   m4-protection-anchors protection product allowed to anchor
 *   m5-pick-cap-lifted    recommended-pick cap 6 lifted
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
  vars: ["PROTECTION_HANDLE", "autoCrossSell"],
  functions: [
    "routeRoot",
    "featureOn",
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
    "autoCrossSellAnchors",
    "fetchRecommendations",
    "fetchRecommendedProducts",
    "recommendationImage",
    "sizedImageUrl",
    "firstAvailableVariant",
    "fetchHandleData",
    "buildAutoCrossSellRows",
    "fetchAutoCrossSell",
    "scheduleAutoCrossSell",
    "buildAutoCrossSellRow",
    "renderCrossSellAuto",
    "renderCrossSell",
    "performCrossSellAdd",
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
    document: doc,
    window: {
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
      location: { reload: () => { calls.reloaded = true; } },
    },
    PREVIEW: null,
    BEACONS_OFF: false,
    EFFECTIVE: Object.assign({ crossSell: true }, opts.effective || {}),
    CART_FEATURE_KEYS: { crossSell: "cart_cross_sell" },
    cfg: Object.assign(
      { currency: "EUR", overrides: {}, products: {} },
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
    }, opts.state || {}),
    // recorders / documented environment stubs
    fetchJSON,
    decodeEntities: (s) => s,
    track: (feature, type, extra) => calls.tracks.push({ feature, type, extra }),
    renderAll: () => { calls.renderAll++; },
    setNotice: (type, text) => calls.notices.push({ type, text }),
    safeThemeRefresh: () => { calls.themeRefreshed = true; },
    decorateSubscriptionRows: () => {},
    drawerIsOpen: () => opts.drawerOpen !== false,
    isCartPageContext: () => opts.onCartPage === true,
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox, { filename: "extracted-crosssell-module.js" });
  return { sandbox, doc, calls, timers };
}

const RECS_URL = "/recommendations/products.json";
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
    const products = await vm.runInContext(
      "fetchRecommendedProducts(autoCrossSellAnchors())", sim.sandbox);
    ok(products.length === 1 && products[0].handle === "rec-a", "complementary answer wins");
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
    const products = await vm.runInContext(
      "fetchRecommendedProducts(autoCrossSellAnchors())", sim.sandbox);
    ok(products.length === 1 && products[0].handle === "rec-b",
      "fallback source complementary fills after both anchor intents were empty");
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
    const products = await vm.runInContext(
      "fetchRecommendedProducts(autoCrossSellAnchors())", sim.sandbox);
    ok(Array.isArray(products) && products.length === 0, "404/failure per attempt tolerated silently");
  }

  // --- pick pipeline: dedupe, exclusions, cap 6, enrichment -----------------------
  {
    const recs = [];
    for (let i = 1; i <= 8; i++) recs.push({ id: 100 + i, handle: "h" + i, title: "P" + i });
    recs.splice(1, 0,
      { id: 999, handle: "cellexia-order-protection", title: "Protection" }, // excluded
      { id: 101, handle: "h1", title: "P1 dup" },                            // handle dup
      { id: 5, handle: "in-cart", title: "In cart" },                        // product in cart
      { handle: "", title: "no handle" },                                    // unusable
    );
    const byHandle = {};
    for (let i = 1; i <= 8; i++) {
      byHandle["h" + i] = {
        variants: [
          { id: 9000 + i, price: 1000 * i, available: i !== 2, compare_at_price: i === 1 ? 2500 : null },
          { id: 9100 + i, price: 1100 * i },
        ],
      };
    }
    delete byHandle.h3; // unknown to the proxy -> dropped
    const sim = makeSim({
      responders: {
        [RECS_URL]: { products: recs },
        [PROXY_URL]: { productsByHandle: byHandle },
      },
    });
    sim.sandbox.state.cart = cartWith([LINE(5, 55, 1, 9900, "in-cart")]);
    const rows = await vm.runInContext("buildAutoCrossSellRows()", sim.sandbox);
    const handles = rows.map((r) => r.handle);
    ok(handles.indexOf("cellexia-order-protection") === -1, "protection product excluded from picks");
    ok(handles.indexOf("in-cart") === -1, "in-cart product excluded from picks");
    ok(handles.filter((h) => h === "h1").length === 1, "handle dedupe");
    ok(handles.indexOf("h2") === -1 || rows.find((r) => r.handle === "h2").variantId === 9102,
      "sold-out first variant: next available variant wins");
    ok(handles.indexOf("h3") === -1, "handle unknown to the proxy drops silently");
    // cap: 6 picks max BEFORE enrichment — h1..h6 picked, h2 kept via 2nd
    // variant, h3 dropped at enrichment -> 5 rows.
    ok(rows.length === 5, "6-pick cap then enrichment drops (got " + rows.length + ")");
    ok(handles.indexOf("h7") === -1 && handles.indexOf("h8") === -1,
      "picks beyond the 6 cap never fetched/rendered");
    const h1 = rows.find((r) => r.handle === "h1");
    ok(!!h1 && h1.priceCents === 1000 && h1.compareAtCents === 2500,
      "presentment price + compare-at from the proxy");
    ok(!!h1 && h1.title === "P1", "title from the recommendations payload");
    const proxyCalls = sim.calls.fetches.filter((f) => f.url.indexOf(PROXY_URL) === 0);
    ok(proxyCalls.length === 1 &&
       decodeURIComponent(proxyCalls[0].url.split("handles=")[1]) === "h1,h2,h3,h4,h5,h6",
      "ONE batched proxy call for exactly the capped picks");
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

  // --- cache/debounce/commit semantics -------------------------------------------------
  {
    let releaseProxy;
    const proxyGate = new Promise((r) => { releaseProxy = r; });
    const sim = makeSim({
      responders: {
        [RECS_URL]: { products: [{ id: 90, handle: "rec-a", title: "Rec A" }] },
        [PROXY_URL]: () => proxyGate.then(() => ({
          productsByHandle: { "rec-a": { variants: [{ id: 700, price: 900 }] } },
        })),
      },
    });
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    const host1 = sim.doc.createElement("div");
    sim.sandbox.__host = host1;
    let out = vm.runInContext("renderCrossSell(__host)", sim.sandbox);
    ok(out === null, "auto mode, nothing cached yet: renders nothing");
    ok(sim.timers.length === 1 && sim.timers[0].ms === 200, "fetch debounced 200 ms");
    out = vm.runInContext("renderCrossSell(__host)", sim.sandbox);
    ok(sim.timers.filter((t) => !t.cleared).length === 1,
      "re-render for the same signature: still one scheduled fetch");
    sim.timers[0].fn(); // fire the debounce -> recommendations + proxy fetch start
    await flush();
    releaseProxy();
    await flush();
    ok(sim.calls.renderAll === 1, "commit for the fetched cart re-renders");
    ok(Array.isArray(sim.sandbox.autoCrossSell.rows) && sim.sandbox.autoCrossSell.rows.length === 1,
      "rows cached under the fetched signature");
    out = vm.runInContext("renderCrossSell(__host)", sim.sandbox);
    ok(out === "cart_cross_sell", "cached rows render the box");
    ok(host1.querySelectorAll(".cx-crosssell__item").length === 1, "one visible row");
    ok(host1.querySelector(".cx-crosssell").getAttribute("data-cx-feature") === "cart_cross_sell",
      "feature marker on the box");
    const fetchCount = sim.calls.fetches.length;
    vm.runInContext("renderCrossSell(document.createElement('div'))", sim.sandbox);
    ok(sim.calls.fetches.length === fetchCount && sim.timers.filter((t) => !t.cleared).length === 1,
      "reopen with an unchanged cart: cache hit, no refetch");
  }
  {
    // Mid-flight cart change: the fetch result must NOT commit.
    let releaseProxy;
    const proxyGate = new Promise((r) => { releaseProxy = r; });
    const sim = makeSim({
      responders: {
        [RECS_URL]: { products: [{ id: 90, handle: "rec-a", title: "Rec A" }] },
        [PROXY_URL]: () => proxyGate.then(() => ({
          productsByHandle: { "rec-a": { variants: [{ id: 700, price: 900 }] } },
        })),
      },
    });
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 1, 9900)]);
    const sig = vm.runInContext("cartSignature()", sim.sandbox);
    vm.runInContext(`scheduleAutoCrossSell(${JSON.stringify(sig)})`, sim.sandbox);
    sim.timers[0].fn();
    await flush();
    sim.sandbox.state.cart = cartWith([LINE(2, 22, 2, 19800)]); // cart mutated mid-flight
    releaseProxy();
    await flush();
    ok(sim.sandbox.autoCrossSell.signature === null && sim.sandbox.autoCrossSell.rows === null,
      "stale fetch result never commits (signature changed mid-flight)");
    ok(sim.calls.renderAll === 0, "no re-render for a stale commit");
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
        find: "attempts.push({ id: item.product_id, intent: 'complementary' });\n      attempts.push({ id: item.product_id, intent: 'related' });",
        replace: "attempts.push({ id: item.product_id, intent: 'related' });\n      attempts.push({ id: item.product_id, intent: 'complementary' });",
      },
      {
        name: "m2-fallback-inverted",
        find: "if (products.length) return products;",
        replace: "if (!products.length) return products;",
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
        name: "m5-pick-cap-lifted",
        find: "for (var i = 0; i < products.length && picks.length < 6; i++) {",
        replace: "for (var i = 0; i < products.length && picks.length < 60; i++) {",
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
