/**
 * v21 cart-overlay sim — runs the REAL gate/lock/cue/heal machinery
 * vm-extracted from extensions/cellexia-booster/assets/cellexia-cart.js:
 *
 *  - the 2^3 gating matrix: ofixSync plants EXACTLY the html gate classes
 *    (cx-ofix / cx-compact / cx-pin) matching the three independent
 *    featureOn verdicts — live (EFFECTIVE), preview-live and preview-draft
 *    (PREVIEW.live / PREVIEW.flags) — and strips them the moment a verdict
 *    goes false;
 *  - the scroll lock: html.cx-ofix-lock mirrors .mini-cart.is-open in BOTH
 *    directions, only while cart_overlay_fix is on;
 *  - the scroll cue v2 (v21.1): a mini scrollbar thumb driven by inline
 *    custom properties on .mini-cart (--cx-spo/--cx-spt/--cx-sth), plus a
 *    once-per-open peek glide (ofixPeek) and the rangeless-drawer pan guard
 *    (cx-noscroll) and the checkout-total format heal (ofixMoneyHeal);
 *  - the qty heal: a BLANK .qty input (the theme's mini-cart.liquid renders
 *    value="" on every page-load pass — `item.quantity` inside a
 *    `for line_item` loop) is filled from state.cart by data-lineid; a
 *    non-blank value (correct, or the shopper's mid-edit typing) is NEVER
 *    overwritten, and any row/item count mismatch bails whole;
 *  - the observer-storm guard: no sync path ever writes .mini-cart's own
 *    class attribute (the theme section's MutationObserver fetches /cart.js
 *    a second after every class change there), and the theme's checkout
 *    anchor is the same node object across syncs (CSS-only sticky bar);
 *  - fail-closed: a missing .mini-cart strips every gate class.
 *
 * Viewport numbers mirror the live capture (2026-09-14, cellexialabs.com,
 * 375x812 emulation: content clientHeight 812 once normalized, the theme's
 * stale inline calc leaving 685). The cue math is pure arithmetic over the
 * three scroll metrics, so the scenarios parameterize them directly.
 *
 * Documented stubs: mini-dom document gains a REAL El documentElement (the
 * default makeDocument one is a static object) and a settable activeElement;
 * qty inputs carry a plain `value` property (mini-dom El has none); the
 * sandbox carries a MutationObserver global (a bare function - only its
 * typeof matters to ofixCanLock) unless a scenario removes it; window
 * provides recording addEventListener + a manual-flush requestAnimationFrame
 * whose queue the scenarios can inspect. No timers run.
 */
"use strict";
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const { extractAll } = require("./lib/extract.cjs");
const { makeDocument, El } = require("./lib/mini-dom.cjs");

const REAL_SRC = path.join(
  __dirname,
  "..",
  "..",
  "extensions",
  "cellexia-booster",
  "assets",
  "cellexia-cart.js",
);
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;
const SRC = fs.readFileSync(SRC_PATH, "utf8");

const EXTRACTED = extractAll(SRC, {
  vars: ["CART_FEATURE_KEYS", "ofixBound", "ofixRaf", "ofixWasOpen", "ofixPeekDone", "ofixCanLock"],
  functions: [
    "featureOn",
    "drawerIsOpen",
    "activeCurrency",
    "money",
    "ofixMoneyHeal",
    "ofixCountHeal",
    "ofixPeek",
    "ofixQtyHeal",
    "ofixCueUpdate",
    "ofixSync",
    "ofixSchedule",
    "ofixInit",
  ],
});

let checks = 0;
let failures = 0;
function ok(cond, label) {
  checks++;
  if (!cond) {
    failures++;
    console.error("FAIL: " + label);
  }
}

// ---------------------------------------------------------------- fixtures

function styleStub() {
  const props = {};
  return {
    props,
    setProperty(name, value) { props[name] = String(value); },
    removeProperty(name) { delete props[name]; },
    getPropertyValue(name) { return props[name] || ""; },
  };
}

function buildDrawer(doc, opts) {
  const o = Object.assign(
    {
      present: true,
      open: true,
      scrollHeight: 1540,
      clientHeight: 812,
      scrollTop: 0,
      lines: [],
    },
    opts,
  );
  if (!o.present) return null;
  const mini = new El("section");
  mini.className = o.open ? "mini-cart is-open" : "mini-cart";
  mini.style = styleStub(); // ofixCueUpdate writes the thumb custom props here
  const bg = new El("div");
  bg.className = "mini-cart__bg";
  const content = new El("div");
  content.className = "mini-cart__content";
  content.scrollHeight = o.scrollHeight;
  content.clientHeight = o.clientHeight;
  content.scrollTop = o.scrollTop;
  // Panel geometry for the thumb's --cx-spl: wide phones anchor the 400px
  // panel right, leaving a page gutter (left > 0) — the v21.3 case.
  const panelLeft = o.panelLeft || 0;
  const panelRight = o.panelRight !== undefined ? o.panelRight : panelLeft + 375;
  content.getBoundingClientRect = () => ({
    left: panelLeft,
    right: panelRight,
    top: 0,
    bottom: o.clientHeight,
    width: panelRight - panelLeft,
    height: o.clientHeight,
  });
  const header = new El("div");
  header.className = "mini-cart__header";
  const list = new El("div");
  list.className = "mini-cart__list";
  const inputs = [];
  o.lines.forEach(function (line, index) {
    const row = new El("div");
    row.className = "product product--cart d-flex justify-between";
    row.setAttribute("data-lineid", String(index + 1));
    if (line.varid !== undefined) row.setAttribute("data-varid", String(line.varid));
    const qty = new El("div");
    qty.className = "qty d-flex align-center";
    const input = new El("input");
    input.value = line.value; // mini-dom El has no value of its own
    qty.appendChild(input);
    row.appendChild(qty);
    list.appendChild(row);
    inputs.push(input);
  });
  const footer = new El("div");
  footer.className = "mini-cart__footer";
  const ftSpan = new El("span");
  ftSpan.className = "total updated-subtotal";
  ftSpan.textContent = "0,00 zl";
  footer.appendChild(ftSpan);
  const actions = new El("div");
  actions.className = "mini-cart__actions";
  actions.offsetHeight = o.actionsHeight || 0;
  const checkout = new El("a");
  checkout.className = "btn btn--primary btn--hover-alt";
  checkout.setAttribute("href", "/checkout");
  const ckSpan = new El("span");
  ckSpan.className = "checkout-subtotal";
  ckSpan.textContent = "0,00 zl";
  checkout.appendChild(ckSpan);
  const wrap = new El("div");
  wrap.appendChild(checkout);
  actions.appendChild(wrap);
  content.appendChild(header);
  content.appendChild(list);
  content.appendChild(footer);
  content.appendChild(actions);
  mini.appendChild(bg);
  mini.appendChild(content);
  doc.body.appendChild(mini);
  return { mini, bg, content, list, footer, actions, checkout, ckSpan, ftSpan, inputs };
}

function run(opts) {
  const o = Object.assign(
    {
      effective: {},
      preview: null,
      cart: undefined, // undefined -> default two-line cart
      drawer: {},
    },
    opts,
  );
  const doc = makeDocument();
  // The default makeDocument documentElement is a static {lang} object —
  // the module plants its gate classes there, so give it a real El; and
  // ofixCountHeal builds the theme's badge markup, so it needs
  // createElement (absent from the default document surface).
  const html = new El("html");
  doc.documentElement = html;
  doc.createElement = (tag) => new El(tag);
  // Header cart icon — the LIVE theme omits .cart-count entirely on an
  // empty-cart page load (unlike this repo's theme copy).
  const icon = new El("button");
  icon.className = "icon icon--cart";
  if (o.iconBadge) {
    const b = new El("span");
    b.className = "cart-count";
    const bs = new El("span");
    bs.textContent = String(o.iconBadge);
    b.appendChild(bs);
    icon.appendChild(b);
  }
  const sr = new El("span");
  sr.className = "sr-only";
  sr.textContent = "Cart";
  icon.appendChild(sr);
  doc.body.appendChild(icon);
  const drawer = buildDrawer(doc, o.drawer);
  const listeners = [];
  const rafQueue = [];
  const sandbox = {
    document: doc,
    console,
    JSON,
    // ofixCanLock reads typeof MutationObserver - a bare function suffices.
    ...(o.noMutationObserver ? {} : { MutationObserver: function () {} }),
    cfg: Object.assign({ currency: "PLN" }, o.mf !== undefined ? { mf: o.mf } : {}),
    EFFECTIVE: o.effective,
    PREVIEW: o.preview,
    state: {
      cart:
        o.cart === undefined
          ? { items: [{ quantity: 2 }, { quantity: 1 }] }
          : o.cart,
    },
    window: {
      ...(o.noMatchMedia
        ? {}
        : { matchMedia: function () { return { matches: o.reducedMotion === true }; } }),
      ...(o.noFormatMoney
        ? {}
        : { formatMoney: function (cents, fmt) { return "FMT[" + cents + "|" + fmt + "]"; } }),
      ...(o.moneyFormat !== undefined ? { moneyFormat: o.moneyFormat } : {}),
      getComputedStyle: function () {
        return { direction: o.rtl ? "rtl" : "ltr" };
      },
      addEventListener: function (type) {
        listeners.push(type);
      },
      requestAnimationFrame: function (fn) {
        rafQueue.push(fn);
        return rafQueue.length;
      },
      setTimeout: function () {
        return 1;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox, { filename: "extracted-ofix-module.js" });
  return {
    doc,
    html,
    drawer,
    sandbox,
    listeners,
    raf: rafQueue,
    flushRaf: function () {
      while (rafQueue.length) rafQueue.shift()();
    },
    sync: function () {
      vm.runInContext("ofixSync()", sandbox);
    },
    init: function () {
      vm.runInContext("ofixInit()", sandbox);
    },
    schedule: function () {
      vm.runInContext("ofixSchedule()", sandbox);
    },
    moneyHeal: function (cart) {
      sandbox.__cart = cart;
      vm.runInContext("ofixMoneyHeal(__cart)", sandbox);
    },
    countHeal: function (cart) {
      sandbox.__cart = cart;
      vm.runInContext("ofixCountHeal(__cart)", sandbox);
    },
    icon,
  };
}

const has = (el, cls) => el.classList.contains(cls);

// ------------------------------------------------- A. the gating matrix
{
  for (let bits = 0; bits < 8; bits++) {
    const eff = {
      ofix: !!(bits & 1),
      compact: !!(bits & 2),
      pinned: !!(bits & 4),
    };
    const t = run({ effective: eff, drawer: { open: false } });
    t.sync();
    ok(
      has(t.html, "cx-ofix") === eff.ofix &&
        has(t.html, "cx-compact") === eff.compact &&
        has(t.html, "cx-pin") === eff.pinned,
      `A1 combo ofix=${eff.ofix} compact=${eff.compact} pinned=${eff.pinned} plants exactly its classes`,
    );
    ok(
      !has(t.html, "cx-ofix-lock"),
      `A1 combo ${bits}: a CLOSED drawer never locks`,
    );
  }

  // Preview-draft path: EFFECTIVE all false, PREVIEW.flags arms one key.
  const draft = run({
    effective: { ofix: false, compact: false, pinned: false },
    preview: { live: {}, flags: { cart_compact: true } },
  });
  draft.sync();
  ok(
    !has(draft.html, "cx-ofix") &&
      has(draft.html, "cx-compact") &&
      !has(draft.html, "cx-pin"),
    "A2 a preview DRAFT arms exactly its own feature",
  );

  // Preview-live path (the simulated market says it would be live).
  const pl = run({
    effective: {},
    preview: { live: { cart_pinned_checkout: true }, flags: {} },
  });
  pl.sync();
  ok(
    has(pl.html, "cx-pin") && !has(pl.html, "cx-compact"),
    "A3 the preview live-in-market verdict arms the feature",
  );

  // No preview, nothing effective: nothing planted (real visitors).
  const off = run({ effective: {} });
  off.sync();
  ok(
    !has(off.html, "cx-ofix") &&
      !has(off.html, "cx-compact") &&
      !has(off.html, "cx-pin") &&
      !has(off.html, "cx-ofix-lock"),
    "A4 all-off plants nothing",
  );
}

// ------------------------------------------------------- B. the scroll lock
{
  const t = run({ effective: { ofix: true }, drawer: { open: true } });
  t.sync();
  ok(has(t.html, "cx-ofix-lock"), "B1 open drawer + ofix on -> locked");
  t.drawer.mini.className = "mini-cart"; // closeMini() removes is-open
  t.sync();
  ok(!has(t.html, "cx-ofix-lock"), "B1 close transition releases the lock");
  ok(has(t.html, "cx-ofix"), "B1 the gate class itself stays while the feature is on");

  const noFix = run({ effective: { ofix: false, compact: true }, drawer: { open: true } });
  noFix.sync();
  ok(!has(noFix.html, "cx-ofix-lock"), "B2 the lock rides cart_overlay_fix ONLY");

  // Review C3: a browser without MutationObserver has no close-mirror —
  // it must NEVER lock (height/cue/heal still work, the page never freezes).
  const noMo = run({
    effective: { ofix: true },
    drawer: { open: true },
    noMutationObserver: true,
  });
  noMo.sync();
  ok(
    has(noMo.html, "cx-ofix") && !has(noMo.html, "cx-ofix-lock"),
    "B4 without MutationObserver the gate plants but the lock NEVER engages",
  );

  // Feature flips off mid-session (metafield sync): classes actively strip.
  const flip = run({ effective: { ofix: true }, drawer: { open: true } });
  flip.sync();
  ok(has(flip.html, "cx-ofix") && has(flip.html, "cx-ofix-lock"), "B3 armed");
  flip.sandbox.EFFECTIVE.ofix = false;
  flip.sync();
  ok(
    !has(flip.html, "cx-ofix") && !has(flip.html, "cx-ofix-lock"),
    "B3 turning the feature off strips gate AND lock on the next sync",
  );
}

// --------------------------------- C. the scroll-thumb cue (v21.1 report #3)
{
  const spo = (t) => t.drawer.mini.style.getPropertyValue("--cx-spo");
  const spt = (t) => t.drawer.mini.style.getPropertyValue("--cx-spt");
  const sth = (t) => t.drawer.mini.style.getPropertyValue("--cx-sth");

  const t = run({
    effective: { compact: true },
    drawer: { open: true, scrollHeight: 1540, clientHeight: 812, scrollTop: 0 },
  });
  t.sync();
  ok(spo(t) === "1", "C1 overflowing content shows the thumb");
  // track = 812 - 0 - 16 = 796; th = round(796 * 812 / 1540) = 420; top inset 8
  ok(sth(t) === "420px", `C1 thumb height mirrors the visible share (got ${sth(t)})`);
  ok(spt(t) === "8px", "C1 at the top the thumb sits at the top inset");
  t.drawer.content.scrollTop = 1540 - 812; // the very end
  t.sync();
  ok(spt(t) === "384px", `C1 at the end the thumb sits at the track end (got ${spt(t)})`);
  t.drawer.content.scrollTop = -40; // iOS rubber-band overshoot
  t.sync();
  ok(spt(t) === "8px", "C1 rubber-band overshoot clamps to the track");

  const pin = run({
    effective: { compact: true, pinned: true },
    drawer: { open: true, scrollHeight: 1540, clientHeight: 812, actionsHeight: 96 },
  });
  pin.sync();
  // track = 812 - 96 - 16 = 700; th = round(700 * 812 / 1540) = 369
  ok(
    pin.drawer.mini.style.getPropertyValue("--cx-sth") === "369px",
    `C2 the pinned bar's height comes out of the thumb track (got ${pin.drawer.mini.style.getPropertyValue("--cx-sth")})`,
  );

  // v21.3: the thumb hugs the PANEL edge, not the overlay's — a 400px
  // panel anchored right on a 430pt phone has left=30.
  const wide = run({
    effective: { compact: true },
    drawer: { open: true, scrollHeight: 1540, clientHeight: 812, panelLeft: 30, panelRight: 430 },
  });
  wide.sync();
  ok(
    wide.drawer.mini.style.getPropertyValue("--cx-spl") === "34px",
    `C2b on a wide phone the thumb sits 4px inside the panel's LEFT edge (got ${wide.drawer.mini.style.getPropertyValue("--cx-spl")})`,
  );
  const rtl = run({
    effective: { compact: true },
    rtl: true,
    drawer: { open: true, scrollHeight: 1540, clientHeight: 812, panelLeft: 30, panelRight: 430 },
  });
  rtl.sync();
  ok(
    rtl.drawer.mini.style.getPropertyValue("--cx-spl") === "422px",
    `C2c in RTL the thumb mirrors to the panel's RIGHT edge (got ${rtl.drawer.mini.style.getPropertyValue("--cx-spl")})`,
  );

  const short = run({
    effective: { compact: true },
    drawer: { open: true, scrollHeight: 700, clientHeight: 812 },
  });
  short.sync();
  ok(spo(short) === "0", "C3 a cart that fits shows no thumb");

  const closed = run({
    effective: { compact: true },
    drawer: { open: false, scrollHeight: 1540, clientHeight: 812 },
  });
  closed.sync();
  ok(spo(closed) === "0", "C4 a closed drawer never shows the thumb");

  const noCompact = run({
    effective: { ofix: true },
    drawer: { open: true, scrollHeight: 1540, clientHeight: 812 },
  });
  noCompact.sync();
  ok(spo(noCompact) === "0", "C5 the thumb rides cart_compact ONLY");
}

// -------------------- N. rangeless-drawer pan guard (v21.1 report #1)
{
  const short = run({
    effective: { ofix: true },
    drawer: { open: true, scrollHeight: 700, clientHeight: 812 },
  });
  short.sync();
  ok(has(short.drawer.content, "cx-noscroll"), "N1 nothing to scroll -> the pan dies at the panel");
  short.drawer.content.scrollHeight = 1600; // items added
  short.sync();
  ok(!has(short.drawer.content, "cx-noscroll"), "N1 growing past the fold releases the guard");

  const off = run({
    effective: { compact: true },
    drawer: { open: true, scrollHeight: 700, clientHeight: 812 },
  });
  off.sync();
  ok(!has(off.drawer.content, "cx-noscroll"), "N2 the guard rides cart_overlay_fix ONLY");
}

// -------------------- M. checkout-total format heal (v21.1 report #2)
{
  const t = run({ effective: { ofix: true }, mf: "{{amount}} zl" });
  t.moneyHeal({ total_price: 25300 });
  ok(
    t.drawer.ckSpan.textContent === "FMT[25300|{{amount}} zl]" &&
      t.drawer.ftSpan.textContent === "FMT[25300|{{amount}} zl]",
    `M1 both totals get the theme's shop-format value via the island's mf (got "${t.drawer.ckSpan.textContent}")`,
  );

  const late = run({ effective: { pinned: true }, moneyFormat: "WMF" });
  late.moneyHeal({ total_price: 100 });
  ok(
    late.drawer.ckSpan.textContent === "FMT[100|WMF]",
    "M2 without the island member the theme's window.moneyFormat still serves (pinned alone gates too)",
  );

  const fallback = run({ effective: { ofix: true }, mf: "{{amount}}", noFormatMoney: true });
  fallback.moneyHeal({ total_price: 25300 });
  ok(
    fallback.drawer.ckSpan.textContent !== "0,00 zl" &&
      fallback.drawer.ckSpan.textContent.indexOf("253") !== -1,
    `M3 without the theme's formatMoney the app's money() still replaces the flash (got "${fallback.drawer.ckSpan.textContent}")`,
  );

  const off = run({ effective: { compact: true }, mf: "{{amount}}" });
  off.moneyHeal({ total_price: 25300 });
  ok(off.drawer.ckSpan.textContent === "0,00 zl", "M4 the heal rides cart_overlay_fix / pinned ONLY");

  const bad = run({ effective: { ofix: true }, mf: "{{amount}}" });
  bad.moneyHeal({ total_price: "junk" });
  ok(bad.drawer.ckSpan.textContent === "0,00 zl", "M5 a malformed cart payload changes nothing");
}

// ------------------ H. the header count badge heal (v21.2 field report)
{
  const badgeOf = (t) => t.icon.querySelector(".cart-count span");

  const t = run({ effective: { ofix: true } });
  ok(badgeOf(t) === null, "H1 an empty-cart page load carries no badge (the live theme's markup)");
  t.countHeal({ item_count: 1 });
  ok(
    badgeOf(t) !== null && badgeOf(t).textContent === "1",
    "H1 the first add creates the theme's own badge markup with the count",
  );
  ok(
    t.icon.children[0].className === "cart-count",
    "H1 the badge lands FIRST inside the icon (the Liquid order)",
  );
  t.countHeal({ item_count: 3 });
  ok(
    t.icon.querySelectorAll(".cart-count").length === 1 && badgeOf(t).textContent === "3",
    "H2 later heals update the same badge — never a second one",
  );

  const seeded = run({ effective: { ofix: true }, iconBadge: 2 });
  seeded.countHeal({ item_count: 5 });
  ok(
    seeded.icon.querySelectorAll(".cart-count").length === 1 &&
      badgeOf(seeded).textContent === "5",
    "H3 a Liquid-rendered badge is reused, not duplicated",
  );

  const zero = run({ effective: { ofix: true } });
  zero.countHeal({ item_count: 0 });
  ok(badgeOf(zero) === null, "H4 an empty cart never invents a zero badge");

  const off = run({ effective: { compact: true, pinned: true } });
  off.countHeal({ item_count: 4 });
  ok(badgeOf(off) === null, "H5 the badge heal rides cart_overlay_fix ONLY");

  const bad = run({ effective: { ofix: true } });
  bad.countHeal(null);
  bad.countHeal({ item_count: "junk" });
  ok(badgeOf(bad) === null, "H6 malformed cart payloads change nothing");
}

// ------------------------- P. the peek glide on open (v21.1 report #3)
{
  const t = run({
    effective: { compact: true },
    drawer: { open: true, scrollHeight: 1540, clientHeight: 812 },
  });
  const content = t.drawer.content;
  let cur = content.scrollTop;
  let maxSeen = 0;
  Object.defineProperty(content, "scrollTop", {
    configurable: true,
    get: () => cur,
    set: (v) => { cur = v; if (v > maxSeen) maxSeen = v; },
  });
  t.sync(); // open transition -> glide queued
  ok(t.raf.length === 1, "P1 the open transition queues exactly one glide");
  t.flushRaf();
  ok(maxSeen > 20 && maxSeen <= 44, `P1 the glide went out ~44px (max ${maxSeen})`);
  ok(cur === 0, "P1 and eased back to the top");
  t.sync();
  ok(t.raf.length === 0, "P2 a later sync while open never re-glides");
  // The latch must hold on its own too (defense in depth vs the sync-side
  // open-edge detector): a DIRECT second call is also a no-op.
  t.sandbox.__pc = content;
  vm.runInContext("ofixPeek(__pc)", t.sandbox);
  ok(t.raf.length === 0, "P2 the once-per-open latch holds even for a direct call");
  t.drawer.mini.className = "mini-cart";
  t.sync(); // close re-arms the once-per-open latch
  t.drawer.mini.className = "mini-cart is-open";
  maxSeen = 0;
  t.sync();
  ok(t.raf.length === 1, "P2 reopening glides again");
  t.flushRaf();
  ok(maxSeen > 0 && cur === 0, "P2 and completes again");

  const rm = run({
    effective: { compact: true },
    reducedMotion: true,
    drawer: { open: true, scrollHeight: 1540, clientHeight: 812 },
  });
  rm.sync();
  ok(rm.raf.length === 0, "P3 prefers-reduced-motion skips the glide entirely");

  const ab = run({
    effective: { compact: true },
    drawer: { open: true, scrollHeight: 1540, clientHeight: 812 },
  });
  const c2 = ab.drawer.content;
  ab.sync();
  ab.raf.shift()(); // frame 1
  ab.raf.shift()(); // frame 2 - mid-glide
  const at = c2.scrollTop;
  ok(at > 0, `P4 mid-glide the content moved (${at}px)`);
  c2._fire("touchstart");
  while (ab.raf.length) ab.raf.shift()();
  ok(c2.scrollTop === at, "P4 a shopper touch freezes the glide where their finger took over");
  ok((c2._listeners.touchstart || []).length === 0, "P4 the abort listeners are cleaned up");

  const sc = run({
    effective: { compact: true },
    drawer: { open: true, scrollHeight: 1540, clientHeight: 812, scrollTop: 300 },
  });
  sc.sync();
  ok(sc.raf.length === 0, "P5 a drawer already scrolled never glides");

  const nm = run({
    effective: { compact: true },
    noMatchMedia: true,
    drawer: { open: true, scrollHeight: 1540, clientHeight: 812 },
  });
  nm.sync();
  ok(nm.raf.length === 1, "P6 a browser without matchMedia still glides (guard fails open)");
}

// ---------------------------------------------------------- D. the qty heal
{
  const t = run({
    effective: { ofix: true },
    cart: { items: [{ quantity: 2 }, { quantity: 1 }] },
    drawer: { open: true, lines: [{ value: "" }, { value: "" }] },
  });
  t.sync();
  ok(
    t.drawer.inputs[0].value === "2" && t.drawer.inputs[1].value === "1",
    `D1 blank inputs are filled from state.cart by data-lineid (got "${t.drawer.inputs[0].value}", "${t.drawer.inputs[1].value}")`,
  );

  const edit = run({
    effective: { ofix: true },
    cart: { items: [{ quantity: 2 }, { quantity: 1 }] },
    drawer: { open: true, lines: [{ value: "5" }, { value: "" }] },
  });
  edit.sync();
  ok(
    edit.drawer.inputs[0].value === "5",
    "D2 a non-blank value (shopper mid-edit) is NEVER overwritten",
  );
  ok(edit.drawer.inputs[1].value === "1", "D2 the blank sibling still heals");

  const mismatch = run({
    effective: { ofix: true },
    cart: { items: [{ quantity: 2 }] },
    drawer: { open: true, lines: [{ value: "" }, { value: "" }] },
  });
  mismatch.sync();
  ok(
    mismatch.drawer.inputs[0].value === "" && mismatch.drawer.inputs[1].value === "",
    "D3 a row/item count mismatch bails whole — never guess a mapping",
  );

  const noCart = run({
    effective: { ofix: true },
    cart: null,
    drawer: { open: true, lines: [{ value: "" }] },
  });
  noCart.sync();
  ok(noCart.drawer.inputs[0].value === "", "D4 no state.cart yet -> wait for the next pass");

  const offHeal = run({
    effective: { ofix: false, compact: true },
    cart: { items: [{ quantity: 2 }] },
    drawer: { open: true, lines: [{ value: "" }] },
  });
  offHeal.sync();
  ok(offHeal.drawer.inputs[0].value === "", "D5 the heal rides cart_overlay_fix ONLY");

  // Review C1: a FOCUSED blank input is the shopper clearing the field to
  // retype — refilling it would let the theme's keyup autocommit order a
  // concatenated quantity. Leave it alone; heal the unfocused sibling.
  const focused = run({
    effective: { ofix: true },
    cart: { items: [{ quantity: 3 }, { quantity: 1 }] },
    drawer: { open: true, lines: [{ value: "" }, { value: "" }] },
  });
  focused.doc.activeElement = focused.drawer.inputs[0];
  focused.sync();
  ok(
    focused.drawer.inputs[0].value === "",
    "D6 a focused blank input (shopper mid-clear) is never refilled",
  );
  ok(focused.drawer.inputs[1].value === "1", "D6 the unfocused sibling still heals");

  // Review C2: equal-count composition divergence (another tab changed the
  // cart) — the Liquid rows' data-varid disagrees with state.cart; skip.
  const diverged = run({
    effective: { ofix: true },
    cart: { items: [{ id: 900, quantity: 5 }, { id: 901, quantity: 6 }] },
    drawer: {
      open: true,
      lines: [{ value: "", varid: 100 }, { value: "", varid: 901 }],
    },
  });
  diverged.sync();
  ok(
    diverged.drawer.inputs[0].value === "",
    "D7 a data-varid identity mismatch skips the row (never a wrong fill)",
  );
  ok(
    diverged.drawer.inputs[1].value === "6",
    "D7 the row whose identity matches still heals",
  );
}

// ------------------------------------------------- E. fail-closed + safety
{
  const t = run({ effective: { ofix: true, compact: true, pinned: true }, drawer: { present: false } });
  t.html.className = "cx-ofix cx-ofix-lock cx-compact cx-pin"; // stale classes
  t.sync();
  ok(
    t.html.className.indexOf("cx-") === -1,
    `E1 a missing .mini-cart strips every gate class (got "${t.html.className}")`,
  );

  const g = run({ effective: { ofix: true, compact: true, pinned: true }, drawer: { open: true } });
  const miniClassBefore = g.drawer.mini.className;
  const checkoutBefore = g.drawer.checkout;
  g.sync();
  g.sync();
  ok(
    g.drawer.mini.className === miniClassBefore,
    "E2 sync never writes .mini-cart's own class attribute (theme observer storm guard)",
  );
  ok(
    g.drawer.actions.querySelector("a.btn--primary") === checkoutBefore,
    "E2 the theme's checkout anchor is the same node across syncs (CSS-only bar)",
  );
  ok(
    has(g.html, "cx-ofix") && has(g.html, "cx-compact") && has(g.html, "cx-pin"),
    "E2 double sync keeps exactly the same classes",
  );
  ok(
    g.html.className.split(/\s+/).filter((c) => c === "cx-ofix").length === 1,
    "E2 idempotent — no duplicate class tokens",
  );
}

// ------------------------------------- G. cue listener wiring (review C7)
{
  const t = run({
    effective: { compact: true },
    drawer: { open: true, scrollHeight: 1540, clientHeight: 812, scrollTop: 0 },
  });
  t.sync();
  const content = t.drawer.content;
  ok(
    (content._listeners.scroll || []).length === 1 &&
      (content._listeners.load || []).length === 1,
    "G1 sync binds the content scroll + capture-phase image-load listeners exactly once",
  );
  t.sync();
  ok(
    (content._listeners.scroll || []).length === 1,
    "G1 re-sync never stacks a second listener (ofixBound guard)",
  );
  // The SHOPPER's scroll (not a sync pass) must re-verdict the thumb.
  content.scrollTop = 1540 - 812; // at the very end
  content._fire("scroll");
  ok(
    t.drawer.mini.style.getPropertyValue("--cx-spt") === "384px",
    "G2 the bound scroll listener alone moves the thumb to the track end",
  );
  content.scrollTop = 0;
  content._fire("scroll");
  ok(
    t.drawer.mini.style.getPropertyValue("--cx-spt") === "8px",
    "G2 and back to the top",
  );
  // A late-loading drawer image grows scrollHeight silently: the
  // capture-phase load listener schedules a re-verdict.
  const g3 = run({
    effective: { compact: true },
    drawer: { open: true, scrollHeight: 812, clientHeight: 812 },
  });
  g3.sync();
  ok(g3.drawer.mini.style.getPropertyValue("--cx-spo") === "0", "G3 fits before the image loads");
  g3.drawer.content.scrollHeight = 1200;
  g3.drawer.content._fire("load");
  g3.flushRaf();
  ok(
    g3.drawer.mini.style.getPropertyValue("--cx-spo") === "1",
    "G3 an image load that grows the content re-verdicts the thumb",
  );
}

// ----------------------------------------------------- F. init + scheduling
{
  const off = run({ effective: {} });
  off.init();
  ok(off.listeners.length === 0, "F1 all-off: init registers ZERO window listeners");

  const on = run({ effective: { compact: true }, drawer: { open: true, scrollHeight: 1540 } });
  on.init();
  ok(
    on.listeners.indexOf("resize") !== -1 &&
      on.listeners.indexOf("orientationchange") !== -1 &&
      on.listeners.indexOf("pageshow") !== -1,
    "F2 any feature on: resize/orientationchange/pageshow re-verdict listeners",
  );
  ok(on.drawer.mini.style.getPropertyValue("--cx-spo") === "1", "F2 init runs a first sync");

  const sched = run({ effective: { ofix: true }, drawer: { open: true } });
  sched.schedule();
  sched.schedule();
  sched.schedule();
  ok(!has(sched.html, "cx-ofix"), "F3 scheduled work waits for the frame");
  ok(
    sched.raf.length === 1,
    `F3 three schedules coalesce into ONE frame callback (got ${sched.raf.length})`,
  );
  sched.flushRaf();
  ok(has(sched.html, "cx-ofix"), "F3 one coalesced frame applies the sync");
  // Review C8: the scheduler must RE-ARM after a frame (an inverted or
  // missing ofixRaf reset would wedge it after the first batch).
  sched.schedule();
  ok(
    sched.raf.length === 1,
    "F3 the scheduler re-arms for the next burst after a frame",
  );
  sched.flushRaf();

  // Review C9: the canonical use of these default-OFF features is a merchant
  // PREVIEW (EFFECTIVE all false, PREVIEW armed) — init must register the
  // re-verdict listeners and run the first sync through the featureOn union.
  const prev = run({
    effective: {},
    preview: { live: {}, flags: { cart_compact: true } },
    drawer: { open: true, scrollHeight: 1540, clientHeight: 812 },
  });
  prev.init();
  ok(
    prev.listeners.indexOf("resize") !== -1 &&
      prev.listeners.indexOf("pageshow") !== -1,
    "F4 a preview-only session still gets the re-verdict listeners",
  );
  ok(
    has(prev.html, "cx-compact") &&
      prev.drawer.mini.style.getPropertyValue("--cx-spo") === "1",
    "F4 init's first sync plants the previewed gate + thumb",
  );
}

console.log(
  failures === 0
    ? `ALL ${checks} CHECKS PASSED (v21 cart overlay vs the real cellexia-cart.js module)`
    : `\n${failures}/${checks} CHECKS FAILED`,
);
if (failures > 0) process.exitCode = 1;

// ------------------------------------------------------------- mutants
if (!process.env.CX_SKIP_MUTANTS && failures === 0) {
  const { runMutants } = require("./lib/mutants.cjs");
  const bad = runMutants({
    selfPath: __filename,
    srcPath: REAL_SRC,
    mutants: [
      {
        // A lock that never releases freezes the page after checkout-close.
        name: "m1-lock-never-releases",
        find: "      if (ofix && ofixCanLock && drawerIsOpen()) root.classList.add('cx-ofix-lock');\n      else root.classList.remove('cx-ofix-lock');",
        replace: "      if (ofix && ofixCanLock) root.classList.add('cx-ofix-lock');",
      },
      {
        // A thumb on a CLOSED drawer would ghost over the page dim.
        name: "m2-thumb-shows-when-closed",
        find: "      if (featureOn('compact') && drawerIsOpen() && scrollable) {",
        replace: "      if (featureOn('compact') && scrollable) {",
      },
      {
        // Writing .mini-cart's class fires the theme observer's /cart.js
        // fetch on every sync — the exact storm the design forbids.
        name: "m3-class-on-mini",
        find: "      if (ofix) root.classList.add('cx-ofix');\n      else root.classList.remove('cx-ofix');",
        replace: "      if (ofix) mini.classList.add('cx-ofix');\n      else mini.classList.remove('cx-ofix');",
      },
      {
        // A featureOn that answers true for everyone leaks the layout live.
        name: "m4-gate-leaks-live",
        find: "    return EFFECTIVE[key] === true;\n  }",
        replace: "    return true;\n  }",
      },
      {
        // The off-path must actively STRIP, not merely stop adding.
        name: "m5-strip-skipped-when-off",
        find: "      var ofix = featureOn('ofix');\n      var compact = featureOn('compact');\n      var pinned = featureOn('pinned');",
        replace: "      var ofix = featureOn('ofix');\n      var compact = featureOn('compact');\n      var pinned = featureOn('pinned');\n      if (!ofix && !compact && !pinned) return;",
      },
      {
        // Overwriting a non-blank value clobbers the shopper's typing.
        name: "m6-heal-overwrites-nonblank",
        find: "      if (!input || input.value !== '' || input === document.activeElement) continue;",
        replace: "      if (!input || input === document.activeElement) continue;",
      },
      {
        // Healing across a count mismatch guesses a wrong mapping.
        name: "m7-heal-count-blind",
        find: "    if (!rows.length || rows.length !== cart.items.length) return;",
        replace: "    if (!rows.length) return;",
      },
      {
        // The heal belongs to cart_overlay_fix alone.
        name: "m8-heal-when-off",
        find: "  function ofixQtyHeal() {\n    if (!featureOn('ofix')) return;",
        replace: "  function ofixQtyHeal() {\n    if (false) return;",
      },
      {
        // Review #1: without the guard a rangeless drawer keeps chaining
        // the pan to the page on iOS.
        name: "m9-noscroll-never-set",
        find: "      if (featureOn('ofix') && !scrollable) content.classList.add('cx-noscroll');",
        replace: "      if (false) content.classList.add('cx-noscroll');",
      },
      {
        // Review C7: without the scroll binding the cue is set once at open
        // and never re-verdicted by the shopper's own scrolling.
        name: "m10-cue-scroll-binding-dropped",
        find: "        content.addEventListener('scroll', ofixCueUpdate, false);",
        replace: "        void 0;",
      },
      {
        // Review C1: refilling the focused input the shopper just cleared
        // lets the theme's keyup autocommit order a concatenated quantity.
        name: "m11-heal-refills-focused-input",
        find: "      if (!input || input.value !== '' || input === document.activeElement) continue;",
        replace: "      if (!input || input.value !== '') continue;",
      },
      {
        // Review C2: without the identity check an equal-count cart
        // divergence fills another line's quantity.
        name: "m12-heal-ignores-varid",
        find: "      if (varid && String(item.id) !== varid) continue;",
        replace: "      if (false) continue;",
      },
      {
        // Review C3: locking on a browser that cannot mirror the close
        // transition freezes the page permanently.
        name: "m13-locks-without-observer",
        find: "  var ofixCanLock = typeof MutationObserver === 'function';",
        replace: "  var ofixCanLock = true;",
      },
      {
        // Report #2: skipping the shop-format branch leaves the theme's
        // Intl flash as the healed value.
        name: "m14-money-heal-ignores-shop-format",
        find: "    if (typeof window.formatMoney === 'function' && fmt) {\n      txt = window.formatMoney(cart.total_price, fmt);\n    } else {\n      txt = money(cart.total_price);\n    }",
        replace: "    txt = money(cart.total_price);",
      },
      {
        // Report #3: the glide must respect prefers-reduced-motion.
        name: "m15-peek-ignores-reduced-motion",
        find: "      try {\n        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;\n      } catch (e) { /* no preference signal — proceed */ }",
        replace: "      /* reduced-motion guard removed */",
      },
      {
        // v21.3: ignoring the panel offset floats the thumb in the dimmed
        // page gutter on wide phones (the exact field report).
        name: "m19-thumb-ignores-panel-edge",
        find: "        var spl = rtl ? rect.right - 8 : rect.left + 4;",
        replace: "        var spl = 4;",
      },
      {
        // v21.2: a badge that is built but never attached leaves the icon
        // blank exactly as the theme bug does.
        name: "m17-count-badge-never-attached",
        find: "        icons[i].insertBefore(badge, icons[i].firstChild);",
        replace: "        void badge;",
      },
      {
        // v21.2: inventing a zero badge changes the theme's empty-cart look.
        name: "m18-count-heal-invents-zero-badge",
        find: "    if (!cart || typeof cart.item_count !== 'number' || cart.item_count <= 0) return;",
        replace: "    if (!cart || typeof cart.item_count !== 'number') return;",
      },
      {
        // Report #3: a glide on EVERY sync would fight the shopper.
        name: "m16-peek-every-sync",
        find: "      if (ofixPeekDone || !featureOn('compact')) return;\n      ofixPeekDone = true; // one attempt per drawer-open, whatever happens",
        replace: "      if (!featureOn('compact')) return;",
      },
    ],
  });
  if (bad > 0) {
    console.log(`\n${bad} MUTANT(S) NOT CAUGHT (cart-overlay-fix)`);
    process.exitCode = 1;
  } else {
    console.log("ALL 19 MUTANTS CAUGHT (cart-overlay-fix)");
  }
}
