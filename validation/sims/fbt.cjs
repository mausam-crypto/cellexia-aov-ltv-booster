/**
 * az_fbt + az_similar_items sim — runs the REAL v6.1/v6.3/v6.5 FBT and
 * similar-items machinery vm-extracted from
 * extensions/cellexia-booster/assets/cellexia-pdp.js:
 *
 *  - MANUAL PRECEDENCE: a merchant-picked list mounts with ZERO fetches
 *    (no auto fallback), publishes its variant identities for the
 *    similar-row dedupe, and gets post-build badge decoration;
 *  - AUTO: complementary recommendations for THIS product, falling back
 *    to intent=related on zero USABLE rows, `seen` persisting across the
 *    two fetches so the related fill never repeats a complementary pick;
 *  - pick filter: never the current product, never the protection
 *    product, handle+id dedupe, title required, 2-row cap; enrichment
 *    drops unknown/sold-out handles silently;
 *  - FBT <-> similar dedupe: similar consumes the FBT picks promise
 *    (ids / handles / variantIds — the manual-row variant identity path
 *    included), and an all-overlap answer still renders (availability >
 *    purity);
 *  - PLACEMENT RESOLUTION (v6.5): per-widget 't'/'b' codes, tabs_below
 *    default, shared container when placements agree with FBT kept
 *    first, buybox fallback when the tabs anchor is missing;
 *  - checkbox math, add-bundle attribution (_cellexia_upsell:'fbt'),
 *    beacons.
 *
 * Documented stubs: decodeEntities = identity; azFetchJSON is a scripted
 * recorder (no network); track is a recorder; window.fetch is a recorder
 * for the add-bundle POST. Everything else is the real shipped code.
 */
"use strict";
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const { extractAll } = require("./lib/extract.cjs");
const { makeDocument, El } = require("./lib/mini-dom.cjs");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "..", "extensions", "cellexia-booster", "assets", "cellexia-pdp.js"),
  "utf8",
);

const EXTRACTED = extractAll(SRC, {
  vars: ["AZ_PROTECTION", "azFbtBusy", "azFbtPicksPromise"],
  functions: [
    "routeRoot",
    "insertAfter",
    "cxEl",
    "cxSp",
    "azReadConfig",
    "azOn",
    "azCardsOn",
    "azT",
    "azHasStr",
    "azMoney",
    "azPageLocale",
    "azProductData",
    "azCurrentVariantId",
    "azVariantInfo",
    "azCardBadge",
    "azPlacement",
    "azFindSections",
    "azNewSections",
    "azSectionsContainer",
    "azRecImage",
    "azSizedImage",
    "azFetchRecs",
    "azFetchHandleData",
    "azFirstAvailableVariant",
    "azFbtRows",
    "azFbtUpdate",
    "azFbtSyncThis",
    "azFbtAdd",
    "azFbtFinish",
    "azFbtRowEl",
    "azFbtEmptyPicks",
    "azFbtPicks",
    "azFbtCollect",
    "azFbtEnrich",
    "azMountFbt",
    "azSimilarOverlaps",
    "azMountSimilar",
    "azFbtDecorateManual",
    "azBuildFbtRowLi",
    "azBuildFbt",
    "azBuildSimilar",
    "azBuildRowFlag",
    "azBuildCardFlag",
    "azTplPayload",
    "azTpl",
  ],
});

let checks = 0, failures = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.error("FAIL: " + label); }
}
const flush = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(() => setImmediate(r)))));

const STRINGS = {
  "amazon.fbt_title": "Frequently bought together",
  "amazon.fbt_this_item": "This item:",
  "amazon.fbt_total": "Total:",
  "amazon.fbt_add_both": "Add both to cart",
  "amazon.fbt_add_1": "Add 1 to cart",
  "amazon.fbt_add_3": "Add 3 to cart",
  "amazon.similar_title": "Customers also considered",
  "amazon.bestseller_tpl": "#@@RANK@@ Best Seller",
};

function makeSim(opts) {
  opts = opts || {};
  const doc = makeDocument();
  // theme anchors: hero section, tabs box, proof stack
  const pdp = new El("section");
  pdp.className = "pdp";
  doc.body.appendChild(pdp);
  if (opts.noTabs !== true) {
    const tabs = new El("div");
    tabs.className = "pdp__tabs";
    doc.body.appendChild(tabs);
  }
  const stack = new El("div");
  stack.className = "cx-proof-stack";
  doc.body.appendChild(stack);

  const config = Object.assign({
    pageLocale: "en",
    currency: "EUR",
    product: {
      id: 1, handle: "main", selectedVariant: "11",
      variants: { 11: { available: true, price: 4900 } },
    },
    effective: { az_fbt: true, az_similar_items: true },
    fbt: { mode: "auto", title: "Main product", priceFmt: "€49.00", img: "" },
    badgeCards: { setting: true, live: true },
    strings: STRINGS,
  }, opts.config || {});
  const cfgEl = new El("script");
  cfgEl.id = "cx-az-config";
  cfgEl.textContent = JSON.stringify(config);
  cfgEl.setAttribute("data-cx-market", "global");
  doc.body.appendChild(cfgEl);

  const calls = { recs: [], proxy: [], tracks: [], posts: [], refreshed: [] };
  const responders = opts.responders || {};
  const sandbox = {
    console, JSON, Promise, Intl, Math, Number, String, Array, Object,
    isFinite, encodeURIComponent,
    document: doc,
    Error,
    window: {
      Intl,
      fetch: (url, o) => {
        calls.posts.push({ url, options: o });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      },
      refreshMiniCart: (cart) => calls.refreshed.push(cart),
    },
    PREVIEW: opts.preview || null,
    AZ_CFG: null,
    AZ_CFG_READ: false,
    track: (k, t) => calls.tracks.push(t ? k + ":" + t : k),
    decodeEntities: (s) => s,
    // scripted network at the azFetchJSON seam (documented stub)
    azFetchJSON: (url) => {
      if (url.indexOf("recommendations/products.json") !== -1) {
        calls.recs.push(url);
        const intent = /intent=(\w+)/.exec(url)[1];
        const r = (responders.recs || (() => []))(intent, url);
        return Promise.resolve(r).then((v) => {
          if (v instanceof Error) throw v;
          return { products: v };
        });
      }
      if (url.indexOf("apps/cellexia/cart-data") !== -1) {
        calls.proxy.push(decodeURIComponent(url.split("handles=")[1]));
        const r = (responders.proxy || (() => ({})))(url);
        return Promise.resolve(r).then((v) => ({ productsByHandle: v }));
      }
      if (url.indexOf("cart.js") !== -1) return Promise.resolve({ token: "t" });
      return Promise.reject(new Error("no responder for " + url));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox, { filename: "extracted-fbt-module.js" });
  return { sandbox, doc, calls };
}

async function main() {
  // --- placement codes -----------------------------------------------------
  {
    const a = makeSim();
    ok(vm.runInContext("azPlacement('fbt')", a.sandbox) === "tabs_below",
      "no place codes: tabs_below default");
    const b = makeSim({ config: { place: { fbt: "b", sim: "t" } } });
    ok(vm.runInContext("azPlacement('fbt')", b.sandbox) === "buybox", "'b' = buybox");
    ok(vm.runInContext("azPlacement('sim')", b.sandbox) === "tabs_below", "'t' = tabs_below");
    const c = makeSim({ config: { place: { fbt: "x" } } });
    ok(vm.runInContext("azPlacement('fbt')", c.sandbox) === "tabs_below",
      "unknown code (old metafield mirror) = default");
  }

  // --- container resolution ---------------------------------------------------
  {
    const sim = makeSim();
    const c1 = vm.runInContext("azSectionsContainer('tabs_below')", sim.sandbox);
    ok(!!c1 && c1.getAttribute("data-cx-az-place") === "tabs_below",
      "tabs_below container created with its place attribute");
    const tabs = sim.doc.querySelector(".pdp__tabs");
    ok(tabs.nextSibling === c1, "tabs_below container sits directly after .pdp__tabs");
    const c2 = vm.runInContext("azSectionsContainer('tabs_below')", sim.sandbox);
    ok(c2 === c1, "second resolve reuses the SAME container (shared location)");
    const b1 = vm.runInContext("azSectionsContainer('buybox')", sim.sandbox);
    ok(b1 !== c1 && b1.getAttribute("data-cx-az-place") === "buybox",
      "buybox placement gets its own container");
    const stack = sim.doc.querySelector(".cx-proof-stack");
    ok(stack.parentNode.childNodes.indexOf(b1) ===
       stack.parentNode.childNodes.indexOf(stack) - 1,
      "buybox container inserted directly before the proof stack");
  }
  {
    const sim = makeSim({ noTabs: true });
    const c = vm.runInContext("azSectionsContainer('tabs_below')", sim.sandbox);
    ok(!!c && c.getAttribute("data-cx-az-place") === "buybox",
      "missing tabs anchor: tabs_below degrades to the buybox placement");
  }

  // --- auto flow: complementary answers ------------------------------------------
  {
    const sim = makeSim({
      responders: {
        recs: (intent) => intent === "complementary"
          ? [
              { id: 1, handle: "main", title: "Self" },                       // current product
              { id: 99, handle: "cellexia-order-protection", title: "Prot" }, // protection
              { id: 2, handle: "x", title: "X", featured_image: "https://cdn/x.jpg" },
              { id: 2, handle: "x-alias", title: "X again" },                 // same product id
              { id: 3, handle: "no-title" },                                  // unusable
              { id: 4, handle: "y", title: "Y" },
              { id: 5, handle: "z", title: "Z" },                             // beyond the 2 cap
            ]
          : [],
        proxy: () => ({
          x: { variants: [{ id: 210, price: 1900, available: true }] },
          y: { variants: [{ id: 220, price: 2900 }] },
        }),
      },
    });
    vm.runInContext("azMountFbt()", sim.sandbox);
    await flush();
    ok(sim.calls.recs.length === 1 && sim.calls.recs[0].indexOf("intent=complementary") !== -1 &&
       sim.calls.recs[0].indexOf("product_id=1") !== -1,
      "complementary fetched once for THIS product, no related call");
    ok(sim.calls.proxy.join("|") === "x,y",
      "enrichment batch = the capped, filtered picks (x,y — self/protection/dup/no-title dropped, z beyond cap)");
    const node = sim.doc.querySelector(".cx-az-fbt");
    ok(!!node, "FBT section attached");
    const host = sim.doc.querySelector(".cx-az-sections");
    ok(!!host && host.getAttribute("data-cx-az-place") === "tabs_below" &&
       node.parentNode === host,
      "attached inside the tabs_below container (default placement)");
    const rows = node.querySelectorAll("[data-cx-az-fbt-row]");
    ok(rows.length === 3, "This-item row + 2 recommendation rows");
    ok(rows[0].getAttribute("data-cx-this") === "1" && rows[0].getAttribute("data-price-cents") === "4900",
      "This-item row synced to the selected variant price");
    ok(rows[1].getAttribute("data-variant-id") === "210" && rows[2].getAttribute("data-variant-id") === "220",
      "rec rows carry the first available variant ids");
    const eur = (c) => vm.runInContext(`azMoney(${c})`, sim.sandbox);
    ok(node.querySelector("[data-cx-az-fbt-total]").textContent === eur(4900 + 1900 + 2900),
      "checkbox math: total = sum of all checked rows");
    const btn = node.querySelector("[data-cx-az-fbt-add]");
    ok(!!btn && btn.textContent === "Add 3 to cart", "3 checked: count-plural label");
    ok(sim.calls.tracks.join(",") === "az_fbt", "one az_fbt impression beacon");
    // uncheck a rec row -> both-form for exactly 2
    rows[2].querySelector(".cx-az-fbt__check").checked = false;
    sim.sandbox.__node = node;
    vm.runInContext("azFbtUpdate(__node)", sim.sandbox);
    ok(btn.textContent === "Add both to cart", "2 checked: the both form");
    ok(node.querySelector("[data-cx-az-fbt-total]").textContent === eur(4900 + 1900),
      "total tracks the unchecked row");
    rows[0].querySelector(".cx-az-fbt__check").checked = false;
    rows[1].querySelector(".cx-az-fbt__check").checked = false;
    vm.runInContext("azFbtUpdate(__node)", sim.sandbox);
    ok(btn.disabled === true, "0 checked: add button disabled");
    // thumbnails: only rows with images join the strip (x has one)
    const strip = node.querySelector("[data-cx-az-fbt-strip]");
    ok(strip.querySelectorAll(".cx-az-fbt__thumb").length === 1 &&
       strip.querySelectorAll(".cx-az-fbt__plus").length === 0,
      "strip: one thumbnail (only x shipped an image), no orphan + glyph");
    // idempotence
    vm.runInContext("azMountFbt()", sim.sandbox);
    await flush();
    ok(sim.doc.querySelectorAll(".cx-az-fbt").length === 1, "re-mount is a no-op");
  }

  // --- auto flow: related fallback with cross-fetch dedupe -------------------------
  {
    const sim = makeSim({
      responders: {
        recs: (intent) => intent === "complementary"
          ? [{ id: 2, handle: "a", title: "A" }]
          : [{ id: 2, handle: "a", title: "A" }, { id: 3, handle: "b", title: "B" }, { id: 4, handle: "c", title: "C" }],
        proxy: () => ({
          // a is sold out everywhere -> zero USABLE complementary rows
          a: { variants: [{ id: 300, price: 100, available: false }] },
          b: { variants: [{ id: 310, price: 200 }] },
          c: { variants: [{ id: 320, price: 300 }] },
        }),
      },
    });
    vm.runInContext("azMountFbt()", sim.sandbox);
    await flush();
    const intents = sim.calls.recs.map((u) => /intent=(\w+)/.exec(u)[1]);
    ok(intents.join(",") === "complementary,related",
      "zero usable complementary rows: related fetched second");
    const node = sim.doc.querySelector(".cx-az-fbt");
    const rows = node ? node.querySelectorAll("[data-cx-az-fbt-row]") : [];
    ok(rows.length === 3 &&
       rows[1].getAttribute("data-variant-id") === "310" &&
       rows[2].getAttribute("data-variant-id") === "320",
      "related fill deduped against the complementary pick (a never repeats; b,c used)");
    const used = await vm.runInContext("azFbtPicks()", sim.sandbox);
    ok(used.handles.b === true && used.handles.c === true && !used.handles.a &&
       used.variantIds["310"] === true && used.ids["3"] === true,
      "published picks carry handles + ids + variantIds of the RENDERED rows");
  }

  // --- fewer than two rows = no section -----------------------------------------------
  {
    const sim = makeSim({
      responders: { recs: () => [], proxy: () => ({}) },
    });
    vm.runInContext("azMountFbt()", sim.sandbox);
    await flush();
    ok(sim.doc.querySelector(".cx-az-fbt") === null, "both intents empty: no section");
    ok(sim.calls.tracks.length === 0, "no beacon without a section");
    const used = await vm.runInContext("azFbtPicks()", sim.sandbox);
    ok(Object.keys(used.handles).length === 0, "picks resolve empty (similar never blocked)");
  }

  // --- gates: payload + effective ------------------------------------------------------
  {
    const noPayload = makeSim({ config: { fbt: null } });
    vm.runInContext("azMountFbt()", noPayload.sandbox);
    await flush();
    ok(noPayload.doc.querySelector(".cx-az-fbt") === null && noPayload.calls.recs.length === 0,
      "missing fbt payload member: fail closed, zero fetches");
    const off = makeSim({ config: { effective: { az_fbt: false, az_similar_items: true } } });
    vm.runInContext("azMountFbt()", off.sandbox);
    await flush();
    ok(off.doc.querySelector(".cx-az-fbt") === null && off.calls.recs.length === 0,
      "feature off: fail closed, zero fetches");
  }

  // --- manual precedence ------------------------------------------------------------------
  {
    const sim = makeSim({
      config: {
        fbt: {
          mode: "manual", title: "Main product", priceFmt: "€49.00", img: "",
          rows: [
            { id: 21, price: 2000, priceFmt: "€20.00", title: "R1", img: "https://cdn/r1.jpg", bRank: 3, bCat: "Serums" },
            { id: 22, price: 3000, priceFmt: "€30.00", title: "R2", img: "" },
          ],
        },
      },
    });
    vm.runInContext("azMountFbt()", sim.sandbox);
    await flush();
    ok(sim.calls.recs.length === 0 && sim.calls.proxy.length === 0,
      "MANUAL PRECEDENCE: zero fetches, no auto fallback");
    const node = sim.doc.querySelector(".cx-az-fbt");
    ok(!!node && node.getAttribute("data-cx-az-mode") === "manual", "manual section attached");
    const rows = node.querySelectorAll("[data-cx-az-fbt-row]");
    ok(rows.length === 3, "this + 2 manual rows");
    ok(rows[0].querySelector(".cx-az-fbt__check").disabled === true,
      "This-item checkbox is locked");
    const flags = node.querySelectorAll(".cx-az-cardflag");
    ok(flags.length === 1 &&
       rows[1].querySelector(".cx-az-cardflag") !== null &&
       rows[2].querySelector(".cx-az-cardflag") === null,
      "manual badge decoration: only the row with rank+category gets the flag");
    sim.sandbox.__node = node;
    vm.runInContext("azFbtDecorateManual(__node)", sim.sandbox);
    ok(node.querySelectorAll(".cx-az-cardflag").length === 1, "decoration re-entry is idempotent");
    const used = await vm.runInContext("azFbtPicks()", sim.sandbox);
    ok(used.variantIds["21"] === true && used.variantIds["22"] === true &&
       Object.keys(used.ids).length === 0,
      "manual picks publish VARIANT identity only (rows carry no product ids)");
    ok(sim.calls.tracks.join(",") === "az_fbt", "manual attach fires the beacon");

    // add-bundle attribution
    vm.runInContext("azFbtAdd(__node)", sim.sandbox);
    await flush();
    ok(sim.calls.posts.length === 1 && sim.calls.posts[0].url.indexOf("cart/add.js") !== -1,
      "add posts to cart/add.js once");
    const items = JSON.parse(sim.calls.posts[0].options.body).items;
    ok(items.length === 3 && items.every((i) => i.quantity === 1 && i.properties._cellexia_upsell === "fbt"),
      "every bundle line carries _cellexia_upsell:'fbt'");
    ok(sim.calls.refreshed.length === 1, "theme refreshMiniCart handed the fresh cart");
    ok(sim.calls.tracks.join(",") === "az_fbt,az_fbt:click", "add fires the click beacon");
    ok(sim.sandbox.azFbtBusy === false, "busy flag released");
  }
  {
    // Manual list whose azCardsOn gate is off: no decoration.
    const sim = makeSim({
      config: {
        badgeCards: { setting: false, live: true },
        fbt: { mode: "manual", title: "Main", priceFmt: "€49.00", img: "",
          rows: [{ id: 21, price: 2000, priceFmt: "€20.00", title: "R1", img: "", bRank: 3, bCat: "Serums" }] },
      },
    });
    vm.runInContext("azMountFbt()", sim.sandbox);
    await flush();
    const node = sim.doc.querySelector(".cx-az-fbt");
    ok(!!node && node.querySelectorAll(".cx-az-cardflag").length === 0,
      "badgeCards setting off: manual rows stay undecorated");
  }

  // --- similar: FBT dedupe + overlap-beats-empty ---------------------------------------------
  {
    const sim = makeSim({
      responders: {
        recs: (intent) => intent === "complementary"
          ? [{ id: 2, handle: "x", title: "X" }]
          : [
              { id: 2, handle: "x", title: "X" },       // FBT overlap
              { id: 6, handle: "c", title: "C", url: "/products/c" },
              { id: 7, handle: "d", title: "D" },
              { id: 1, handle: "main", title: "Self" },  // current product
            ],
        proxy: () => ({
          x: { variants: [{ id: 210, price: 1900 }], bestseller: { rank: 2, category: "Serums" } },
          c: { variants: [{ id: 610, price: 2100 }], bestseller: { rank: 1, category: "Creams" } },
          d: { variants: [{ id: 710, price: 2200 }] },
        }),
      },
    });
    vm.runInContext("azMountFbt()", sim.sandbox);
    await flush();
    vm.runInContext("azMountSimilar()", sim.sandbox);
    await flush();
    const similar = sim.doc.querySelector(".cx-az-similar");
    ok(!!similar, "similar row attached");
    const cards = similar.querySelectorAll(".cx-az-similar__card");
    const names = cards.map((c) => c.querySelector(".cx-az-similar__name").textContent);
    ok(names.join(",") === "C,D", "similar drops the FBT pick and the current product (" + names.join(",") + ")");
    // href is assigned as a JS property in the shipped code (a.href = ...)
    ok(cards[0].querySelector("a").href === "/products/c",
      "payload-relative url used verbatim; fallback builds /products/<handle>");
    ok(cards[1].querySelector("a").href === "/products/d",
      "handle fallback url for payloads without one");
    ok(cards[0].querySelectorAll(".cx-az-cardflag").length === 1 &&
       cards[1].querySelectorAll(".cx-az-cardflag").length === 0,
      "similar card badge only with the honesty-gated proxy data");
    // shared container: FBT precedes similar
    const host = sim.doc.querySelector(".cx-az-sections");
    const kids = host.children.map((k) => k.className.split(" ")[0]);
    ok(kids.join(",") === "cx-az-fbt,cx-az-similar", "FBT first inside the shared container");
    ok(sim.calls.tracks.indexOf("az_similar_items") !== -1, "similar impression beacon");
    vm.runInContext("azMountSimilar()", sim.sandbox);
    await flush();
    ok(sim.doc.querySelectorAll(".cx-az-similar").length === 1, "similar re-mount is a no-op");
  }
  {
    // every candidate overlaps the FBT rows -> the overlap set still renders
    const sim = makeSim({
      responders: {
        recs: (intent) => intent === "complementary"
          ? [{ id: 2, handle: "x", title: "X" }, { id: 3, handle: "y", title: "Y" }]
          : [{ id: 2, handle: "x", title: "X" }, { id: 3, handle: "y", title: "Y" }],
        proxy: () => ({
          x: { variants: [{ id: 210, price: 1900 }] },
          y: { variants: [{ id: 220, price: 2900 }] },
        }),
      },
    });
    vm.runInContext("azMountFbt()", sim.sandbox);
    await flush();
    vm.runInContext("azMountSimilar()", sim.sandbox);
    await flush();
    const similar = sim.doc.querySelector(".cx-az-similar");
    ok(!!similar && similar.querySelectorAll(".cx-az-similar__card").length === 2,
      "all-overlap answer still renders (a row with overlap beats an empty row)");
  }
  {
    // FBT attaches AFTER similar (async race): insertBefore keeps FBT first.
    let releaseProxy;
    const gate = new Promise((r) => { releaseProxy = r; });
    const sim = makeSim({
      responders: {
        recs: (intent) => intent === "complementary"
          ? [{ id: 2, handle: "x", title: "X" }, { id: 3, handle: "y", title: "Y" }]
          : [{ id: 6, handle: "c", title: "C" }],
        proxy: (url) => url.indexOf("x") !== -1 && url.indexOf("c") === -1
          ? gate.then(() => ({
              x: { variants: [{ id: 210, price: 1900 }] },
              y: { variants: [{ id: 220, price: 2900 }] },
            }))
          : ({ c: { variants: [{ id: 610, price: 2100 }] } }),
      },
    });
    // No FBT started yet -> similar consumes the empty-picks default.
    vm.runInContext("azFbtPicksPromise = null; azMountSimilar()", sim.sandbox);
    await flush();
    ok(sim.doc.querySelector(".cx-az-similar") !== null, "similar attached first");
    vm.runInContext("azMountFbt()", sim.sandbox);
    releaseProxy();
    await flush();
    const host = sim.doc.querySelector(".cx-az-sections");
    const kids = host.children.map((k) => k.className.split(" ")[0]);
    ok(kids.join(",") === "cx-az-fbt,cx-az-similar",
      "late-resolving FBT is inserted BEFORE the similar row");
  }

  // --- manual variant-identity dedupe (unit) ---------------------------------------------------
  {
    const sim = makeSim();
    sim.sandbox.__pick = { handle: "c", productId: "6" };
    sim.sandbox.__entry = { variants: [{ id: 21 }, { id: 5000 }] };
    sim.sandbox.__used = { ids: {}, handles: {}, variantIds: { 21: true } };
    ok(vm.runInContext("azSimilarOverlaps(__pick, __entry, __used)", sim.sandbox) === true,
      "manual FBT rows: ANY proxy variant matching a used variant id = same product");
    sim.sandbox.__entry2 = { variants: [{ id: 5000 }] };
    ok(vm.runInContext("azSimilarOverlaps(__pick, __entry2, __used)", sim.sandbox) === false,
      "no id/handle/variant match: no overlap");
  }

  // --- per-widget placement split ------------------------------------------------------------------
  {
    const sim = makeSim({
      config: { place: { fbt: "b", sim: "t" } },
      responders: {
        recs: (intent) => intent === "complementary"
          ? [{ id: 2, handle: "x", title: "X" }, { id: 3, handle: "y", title: "Y" }]
          : [{ id: 6, handle: "c", title: "C" }],
        proxy: () => ({
          x: { variants: [{ id: 210, price: 1900 }] },
          y: { variants: [{ id: 220, price: 2900 }] },
          c: { variants: [{ id: 610, price: 2100 }] },
        }),
      },
    });
    vm.runInContext("azMountFbt()", sim.sandbox);
    await flush();
    vm.runInContext("azMountSimilar()", sim.sandbox);
    await flush();
    const sections = sim.doc.querySelectorAll(".cx-az-sections");
    ok(sections.length === 2, "disagreeing placements: two containers");
    const fbtHost = sim.doc.querySelector(".cx-az-fbt").parentNode;
    const simHost = sim.doc.querySelector(".cx-az-similar").parentNode;
    ok(fbtHost.getAttribute("data-cx-az-place") === "buybox" &&
       simHost.getAttribute("data-cx-az-place") === "tabs_below",
      "FBT in buybox, similar under the tabs — per-widget codes respected");
  }

  if (failures > 0) {
    console.error(`\n${failures}/${checks} CHECKS FAILED`);
    process.exit(1);
  }
  console.log(`ALL ${checks} CHECKS PASSED (az_fbt + az_similar_items vs the real cellexia-pdp.js)`);
}

main().catch((e) => {
  console.error("SIM CRASHED:", e);
  process.exit(1);
});
