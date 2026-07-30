/**
 * az card flags + bought lines sim (v6.4/v6.6 badge-everywhere) — runs the
 * REAL decorator machinery vm-extracted from
 * extensions/cellexia-booster/assets/cellexia-cart.js:
 *
 *  - decorator gates: the shared two-key cardGateOn ({setting, live} +
 *    verified-preview union, merchant setting always binding), the
 *    checkout guard, usable-strings guard, boot-once;
 *  - tag REPLACEMENT rule (v6.6): the theme's .product__tag pill (or a
 *    POPULATED .badges overlay) is hidden via cx-az-tagswap ONLY in the
 *    same pass that inserted OUR flag — never without it; empty .badges
 *    containers and undecorated cards stay untouched;
 *  - bought line: CLDR plural + azCompact figure under .product__info
 *    (or after the image box on Boost PFS grids), fail closed without a
 *    usable "other" string;
 *  - cache: sessionStorage keyed by locale + sorted-handle hash, 10 min
 *    TTL, cache hits never touch the network; every REQUESTED handle
 *    converges to a verdict (null = "0" mark, never re-asked);
 *  - network budget: at most TWO batched proxy calls per page, in-flight
 *    handles owned by their fetch, fail-closed on fetch errors;
 *  - re-scan observer: debounced document-level childList observer,
 *    wakeups caused by our own cx-az-card* insertions are skipped,
 *    re-entries idempotent via the data-cx-cardflag marks.
 *
 * Documented stubs: decodeEntities = identity; fetchJSON is a scripted
 * recorder; sessionStorage / MutationObserver / getComputedStyle /
 * timers / Date.now are injected (deterministic clock, no real waits).
 */
"use strict";
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const { extractAll } = require("./lib/extract.cjs");
const { makeDocument, El } = require("./lib/mini-dom.cjs");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "..", "extensions", "cellexia-booster", "assets", "cellexia-cart.js"),
  "utf8",
);

const EXTRACTED = extractAll(SRC, {
  vars: [
    "cardFlagsBooted",
    "cardFlagMap",
    "cardFlagPending",
    "cardFlagFetches",
    "CARD_FLAG_FETCH_MAX",
    "CARD_FLAG_CONTAINERS",
  ],
  functions: [
    "routeRoot",
    "t",
    "el",
    "azStr",
    "cardGateOn",
    "badgeCardsOn",
    "boughtCardsOn",
    "cardFlagInCheckout",
    "cardFlagHandle",
    "cardFlagAnchors",
    "cardFlagHash",
    "cardFlagCacheKey",
    "cardFlagCacheGet",
    "cardFlagCachePut",
    "cardFlagFetch",
    "buildCardFlag",
    "azPageLocale",
    "azCompact",
    "cardBoughtLabel",
    "buildCardBought",
    "swapThemeTag",
    "insertCardBought",
    "decorateCardFlags",
    "cardFlagKnown",
    "mergeCardFlagMap",
    "cardFlagPass",
    "setupCardFlagObserver",
    "initCardFlags",
  ],
});

let checks = 0, failures = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.error("FAIL: " + label); }
}
const flush = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r))));

const STRINGS = {
  "amazon.bestseller": "#@@RANK@@ Best Seller",
  "amazon.bought_count.other": "@@N@@+ bought in past month",
  "amazon.bought_count.one": "@@N@@ bought in past month",
};

function addThemeCard(doc, handle, opts) {
  opts = opts || {};
  const card = new El("div");
  card.className = "product product--default";
  const image = new El("div");
  image.className = "product__image";
  const a = new El("a");
  a.setAttribute("href", opts.href || "/products/" + handle);
  image.appendChild(a);
  if (opts.themeTag !== false) {
    const tag = new El("span");
    tag.className = "product__tag";
    tag.textContent = "Sale";
    image.appendChild(tag);
  }
  if (opts.badges) {
    const badges = new El("div");
    badges.className = "badges";
    if (opts.badges === "populated") {
      const b = new El("span");
      b.textContent = "New";
      badges.appendChild(b);
    }
    image.appendChild(badges);
  }
  const info = new El("div");
  info.className = "product__info";
  card.appendChild(image);
  card.appendChild(info);
  doc.body.appendChild(card);
  return { card, image, info };
}

function addBoostCard(doc, handle) {
  const image = new El("div");
  image.className = "boost-pfs-filter-product-item-image";
  const a = new El("a");
  a.setAttribute("href", "/fr/products/" + handle + "?variant=2#pick");
  image.appendChild(a);
  doc.body.appendChild(image);
  return { image };
}

function makeSim(opts) {
  opts = opts || {};
  const doc = makeDocument();
  const calls = { fetches: [], timers: [] };
  const clock = { now: 1_000_000 };
  const store = new Map();
  const observers = [];
  class MutationObserverStub {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() {}
  }
  const responders = opts.responders || {};
  const sandbox = {
    console, JSON, Promise, Intl, Math, Number, String, Object, Array,
    isFinite, encodeURIComponent, decodeURIComponent,
    Date: { now: () => clock.now },
    document: doc,
    MutationObserver: MutationObserverStub,
    window: {
      Shopify: opts.checkout ? { Checkout: {} } : {},
      location: { pathname: opts.pathname || "/collections/all" },
      fetch: function () {},
      sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
      },
      getComputedStyle: (n) => ({ position: n.style.position || "static" }),
      setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
      clearTimeout: (id) => { if (calls.timers[id - 1]) calls.timers[id - 1].cleared = true; },
    },
    PREVIEW: opts.preview || null,
    cfg: Object.assign({
      pageLocale: "en",
      badgeCards: { setting: true, live: true },
      boughtCards: { setting: true, live: true },
    }, opts.cfg || {}),
    STRINGS: Object.assign({}, STRINGS, opts.strings || {}),
    decodeEntities: (s) => s,
    fetchJSON: (url) => {
      calls.fetches.push(decodeURIComponent(url.split("handles=")[1] || url));
      const r = responders.proxy || (() => ({ productsByHandle: {} }));
      return Promise.resolve(r(url)).then((v) => {
        if (v instanceof Error) throw v;
        return v;
      });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox, { filename: "extracted-cardflags-module.js" });
  return { sandbox, doc, calls, clock, store, observers };
}

async function main() {
  // --- decorator gates (unit) -----------------------------------------------
  {
    const { sandbox } = makeSim();
    sandbox.__g = (gate, preview) => {
      sandbox.PREVIEW = preview || null;
      sandbox.__gate = gate;
      return vm.runInContext("cardGateOn(__gate, 'az_bestseller_badge')", sandbox);
    };
    ok(sandbox.__g(null) === false, "gate: missing island = off");
    ok(sandbox.__g({ setting: true, live: true }) === true, "gate: setting+live = on");
    ok(sandbox.__g({ setting: true, live: false }) === false, "gate: live master off = off");
    ok(sandbox.__g({ setting: false, live: true }) === false, "gate: merchant setting off = off");
    ok(sandbox.__g({ setting: false, live: false }, { live: {}, flags: { az_bestseller_badge: true } }) === false,
      "gate: preview NEVER un-hides a merchant-disabled surface");
    ok(sandbox.__g({ setting: true, live: false }, { live: {}, flags: { az_bestseller_badge: true } }) === true,
      "gate: verified preview draft flag + setting = on");
    sandbox.PREVIEW = null;
  }

  // --- handle extraction (unit) -------------------------------------------------
  {
    const { sandbox } = makeSim();
    sandbox.__h = (href) => {
      sandbox.__href = href;
      return vm.runInContext("cardFlagHandle(__href)", sandbox);
    };
    ok(sandbox.__h("/products/foo") === "foo", "plain product url");
    ok(sandbox.__h("/fr/products/Foo-Bar?variant=1#x") === "foo-bar",
      "locale prefix + query + fragment tolerated, lowercased");
    ok(sandbox.__h("/collections/all/products/x") === "x", "collection-scoped url");
    ok(sandbox.__h("/pages/about") === "" && sandbox.__h("") === "" && sandbox.__h(null) === "",
      "non-product hrefs: empty");
  }

  // --- sessionStorage cache (unit, injected clock) ---------------------------------
  {
    const { sandbox, clock } = makeSim();
    const key = vm.runInContext("cardFlagCacheKey(['b', 'a'])", sandbox);
    const key2 = vm.runInContext("cardFlagCacheKey(['a', 'b'])", sandbox);
    ok(key === key2 && key.indexOf("cx_az_cardflags:2:en:") === 0,
      "cache key: v2 namespace + locale + order-independent handle hash");
    vm.runInContext("cardFlagCachePut(" + JSON.stringify(key) + ", { a: null, b: { badge: null, bought: 7 } })", sandbox);
    clock.now += 599_999;
    const hit = vm.runInContext("cardFlagCacheGet(" + JSON.stringify(key) + ")", sandbox);
    ok(!!hit && hit.b.bought === 7 && hit.a === null, "fresh entry (9m59s) served");
    clock.now += 2;
    ok(vm.runInContext("cardFlagCacheGet(" + JSON.stringify(key) + ")", sandbox) === null,
      "entry older than the 10-minute TTL rejected");
    sandbox.window.sessionStorage.setItem(key, "{not json");
    ok(vm.runInContext("cardFlagCacheGet(" + JSON.stringify(key) + ")", sandbox) === null,
      "corrupted cache entry rejected");
  }

  // --- verdict normalization (unit) ---------------------------------------------------
  {
    const sim = makeSim({
      responders: {
        proxy: () => ({
          productsByHandle: {
            good: { bestseller: { rank: 2, category: "Serums" }, bought: 1520.9 },
            "rank-zero": { bestseller: { rank: 0, category: "Serums" } },
            "blank-cat": { bestseller: { rank: 1, category: "" }, bought: -3 },
            "bought-only": { bought: 12 },
          },
        }),
      },
    });
    const map = await vm.runInContext(
      "cardFlagFetch(['good','rank-zero','blank-cat','bought-only','missing'])", sim.sandbox);
    ok(map.good.badge.rank === 2 && map.good.bought === 1520,
      "verdict: honest badge + floored bought count");
    ok(map["rank-zero"] === null, "rank<=0 badge fails the honesty gate -> null verdict");
    ok(map["blank-cat"] === null, "blank category + invalid bought -> null verdict");
    ok(map["bought-only"].badge === null && map["bought-only"].bought === 12,
      "bought-only verdict keeps the line without a badge");
    ok(map.missing === null, "every REQUESTED handle gets a verdict (unknown -> null)");
  }

  // --- bought label (unit) ----------------------------------------------------------------
  {
    const { sandbox } = makeSim();
    // honesty pre-floor: 1520 anchors to 1000 ("1K"), never rounds up
    ok(vm.runInContext("cardBoughtLabel(1520)", sandbox) === "1K+ bought in past month",
      "bought label: compact-FLOORED figure in the plural-correct string");
    ok(vm.runInContext("cardBoughtLabel(1)", sandbox) === "1 bought in past month",
      "n=1 selects the 'one' category string");
    ok(vm.runInContext("cardBoughtLabel(0)", sandbox) === null, "n<=0: no line");
    const noOther = makeSim({ strings: { "amazon.bought_count.other": "Translation missing: en.amazon.bought_count.other" } });
    ok(vm.runInContext("cardBoughtLabel(5)", noOther.sandbox) === null,
      "Translation-missing 'other' string: unbuildable, fail closed");
    const noOne = makeSim({ strings: { "amazon.bought_count.one": "" } });
    ok(vm.runInContext("cardBoughtLabel(1)", noOne.sandbox) === "1+ bought in past month",
      "missing category string falls back to 'other'");
  }

  // --- full boot pass: fetch, decorate, replace, mark ----------------------------------------
  {
    const sim = makeSim({
      responders: {
        proxy: () => ({
          productsByHandle: {
            alpha: { bestseller: { rank: 1, category: "Serums" }, bought: 2300 },
            beta: { bought: 40 },
            gamma: {},
          },
        }),
      },
    });
    const alpha = addThemeCard(sim.doc, "alpha", { badges: "empty" });
    const gamma = addThemeCard(sim.doc, "gamma");
    const dupAlpha = addThemeCard(sim.doc, "alpha");
    const beta = addBoostCard(sim.doc, "beta");
    const unknown = addThemeCard(sim.doc, "unknown");
    vm.runInContext("initCardFlags()", sim.sandbox);
    await flush();
    ok(sim.calls.fetches.length === 1 &&
       sim.calls.fetches[0] === "alpha,gamma,beta,unknown",
      "ONE batched fetch, handles deduped in scan order (" + sim.calls.fetches[0] + ")");
    // alpha: badge + bought + replacement rule
    const flag = alpha.image.querySelector(".cx-az-cardflag");
    ok(!!flag && flag.querySelector(".cx-az-cardflag__pill").textContent === "#1 Best Seller" &&
       flag.querySelector(".cx-az-cardflag__cat").textContent === "Serums",
      "badge overlay: localized pill + category");
    ok(alpha.image.style.position === "relative", "static image box gets position:relative");
    ok(alpha.image.querySelector(".product__tag").classList.contains("cx-az-tagswap"),
      "REPLACEMENT RULE: theme tag hidden in the same pass as our flag");
    ok(!alpha.image.querySelector(".badges").classList.contains("cx-az-tagswap"),
      "empty .badges container left alone");
    const bought = alpha.info.querySelector(".cx-az-cardbought");
    ok(!!bought && bought.textContent === "2K+ bought in past month",
      "bought line lands at the end of .product__info (floored compact figure)");
    ok(alpha.image.getAttribute("data-cx-cardflag") === "1", "decorated card marked '1'");
    // duplicate-handle card decorated from the same verdict
    ok(dupAlpha.image.querySelector(".cx-az-cardflag") !== null &&
       dupAlpha.image.getAttribute("data-cx-cardflag") === "1",
      "second card with the same handle decorated from the shared verdict");
    // beta (Boost grid): bought only, line after the box
    ok(beta.image.querySelector(".cx-az-cardflag") === null, "no badge without badge data");
    ok(beta.image.nextSibling && beta.image.nextSibling.className === "cx-az-cardbought",
      "Boost box without .product__info: line right after the image box");
    // gamma: nothing to render
    ok(gamma.image.getAttribute("data-cx-cardflag") === "0", "empty verdict converges to the '0' mark");
    ok(!gamma.image.querySelector(".product__tag").classList.contains("cx-az-tagswap"),
      "card WITHOUT our flag keeps its theme tag untouched");
    ok(unknown.image.getAttribute("data-cx-cardflag") === "0", "proxy-unknown handle marked '0'");
    // idempotent re-pass: no double decoration
    vm.runInContext("cardFlagPass(true)", sim.sandbox);
    ok(alpha.image.querySelectorAll(".cx-az-cardflag").length === 1 &&
       alpha.info.querySelectorAll(".cx-az-cardbought").length === 1,
      "re-pass is idempotent (data-cx-cardflag mark)");
    // double boot: no second observer / pass
    const before = sim.observers.length;
    vm.runInContext("initCardFlags()", sim.sandbox);
    ok(sim.observers.length === before, "initCardFlags boots once per page");

    // --- observer re-scan from the merged map (no new fetch) ------------------
    const late = addThemeCard(sim.doc, "alpha");
    const observer = sim.observers[0];
    ok(!!observer && observer.target === sim.doc.body && observer.options.childList === true &&
       observer.options.subtree === true,
      "document-level childList+subtree observer installed");
    // wakeup caused by our own decoration: skipped
    observer.cb([{ addedNodes: [{ nodeType: 1, className: "cx-az-cardflag cx-az-cardflag--overlay" }] }]);
    ok(sim.calls.timers.filter((t) => !t.cleared && !t.fired).length === 0,
      "our own cx-az-card* insertions never schedule a re-scan");
    observer.cb([{ addedNodes: [{ nodeType: 1, className: "product product--default" }] }]);
    const pending = sim.calls.timers.filter((t) => !t.cleared);
    ok(pending.length === 1 && pending[0].ms === 250, "foreign insertion schedules the 250 ms debounce");
    const fetchesBefore = sim.calls.fetches.length;
    pending[0].fn();
    pending[0].fired = true;
    await flush();
    ok(late.image.querySelector(".cx-az-cardflag") !== null &&
       late.image.getAttribute("data-cx-cardflag") === "1",
      "re-scan decorates the late card from the merged map");
    ok(sim.calls.fetches.length === fetchesBefore, "known handles cost no new network");
  }

  // --- populated .badges replacement -----------------------------------------------------------
  {
    const sim = makeSim({
      responders: {
        proxy: () => ({ productsByHandle: { alpha: { bestseller: { rank: 3, category: "Creams" } } } }),
      },
    });
    const card = addThemeCard(sim.doc, "alpha", { themeTag: false, badges: "populated" });
    vm.runInContext("initCardFlags()", sim.sandbox);
    await flush();
    ok(card.image.querySelector(".cx-az-cardflag") !== null, "flag rendered");
    ok(card.image.querySelector(".badges").classList.contains("cx-az-tagswap"),
      "POPULATED .badges overlay hidden when no .product__tag exists");
  }

  // --- network budget + fail-closed fetch -------------------------------------------------------
  {
    let failFirst = true;
    const sim = makeSim({
      responders: {
        proxy: () => {
          if (failFirst) { failFirst = false; return new Error("HTTP 500"); }
          return { productsByHandle: { b1: { bought: 9 } } };
        },
      },
    });
    addThemeCard(sim.doc, "b0");
    vm.runInContext("initCardFlags()", sim.sandbox);
    await flush();
    ok(sim.calls.fetches.length === 1, "first budget slot spent on the failed fetch");
    ok(sim.doc.querySelector(".cx-az-cardbought") === null &&
       sim.doc.querySelector('[data-cx-cardflag="0"]') === null,
      "fetch failure: cards left untouched (fail closed, no marks)");
    ok(vm.runInContext("cardFlagPending", sim.sandbox).b0 === undefined,
      "failed batch releases its pending handles");
    addThemeCard(sim.doc, "b1");
    vm.runInContext("cardFlagPass(false)", sim.sandbox);
    await flush();
    ok(sim.calls.fetches.length === 2, "second (last) budget slot used for the new batch");
    ok(sim.doc.querySelectorAll(".cx-az-cardbought").length === 1, "second batch decorated");
    addThemeCard(sim.doc, "b2");
    vm.runInContext("cardFlagPass(false)", sim.sandbox);
    await flush();
    ok(sim.calls.fetches.length === 2, "TWO-call budget exhausted: no third fetch, card left untouched");
  }

  // --- cache hit: zero network ---------------------------------------------------------------------
  {
    const sim = makeSim();
    const key = vm.runInContext("cardFlagCacheKey(['cached'])", sim.sandbox);
    sim.sandbox.window.sessionStorage.setItem(key, JSON.stringify({
      t: sim.clock.now, map: { cached: { badge: null, bought: 55 } },
    }));
    const card = addThemeCard(sim.doc, "cached");
    vm.runInContext("initCardFlags()", sim.sandbox);
    await flush();
    ok(sim.calls.fetches.length === 0, "sessionStorage hit: the network is never touched");
    ok(card.info.querySelector(".cx-az-cardbought") !== null &&
       card.image.getAttribute("data-cx-cardflag") === "1",
      "cache-served verdict decorates the card");
  }

  // --- boot guards -----------------------------------------------------------------------------------
  {
    const checkout = makeSim({ checkout: true });
    addThemeCard(checkout.doc, "alpha");
    vm.runInContext("initCardFlags()", checkout.sandbox);
    await flush();
    ok(checkout.calls.fetches.length === 0 && checkout.observers.length === 0,
      "checkout guard: never boots in checkout");

    const gatesOff = makeSim({
      cfg: { badgeCards: { setting: true, live: false }, boughtCards: { setting: false, live: true } },
    });
    const card = addThemeCard(gatesOff.doc, "alpha");
    vm.runInContext("initCardFlags()", gatesOff.sandbox);
    await flush();
    ok(gatesOff.calls.fetches.length === 0 && card.image.getAttribute("data-cx-cardflag") === null,
      "both gates failing: zero DOM writes, zero network");

    const noStrings = makeSim({
      strings: {
        "amazon.bestseller": "Translation missing: en.amazon.bestseller",
        "amazon.bought_count.other": "",
      },
    });
    addThemeCard(noStrings.doc, "alpha");
    vm.runInContext("initCardFlags()", noStrings.sandbox);
    await flush();
    ok(noStrings.calls.fetches.length === 0,
      "gates on but no usable strings for either element: never boots");
  }

  if (failures > 0) {
    console.error(`\n${failures}/${checks} CHECKS FAILED`);
    process.exit(1);
  }
  console.log(`ALL ${checks} CHECKS PASSED (az card flags + bought lines vs the real cellexia-cart.js)`);
}

main().catch((e) => {
  console.error("SIM CRASHED:", e);
  process.exit(1);
});
