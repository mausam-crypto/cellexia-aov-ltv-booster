/**
 * v31 quantity-sync + atc-button sim — runs the REAL stepper-sync and ATC
 * restyle machinery vm-extracted from
 * extensions/cellexia-booster/assets/cellexia-pdp.js
 * (docs/SPEC-v31-qty-sync-atc.md):
 *
 *  - mount against a replica of the LIVE buy area (tier pills incl. the
 *    trailing-newline leak, the theme's .action--qty .qty stepper with the
 *    sm-rc quantity input, the [sm-rc-add-to-cart] button with .is-text +
 *    [sm-rc-current-price]) — and every bail path (draft gate, MOQ > 1,
 *    non-consecutive tiers, id mismatch) proven to leave the theme's
 *    stepper untouched (never hide without inserting, v6.6);
 *  - the unit counter: 1..K relay ONE pill click for the matching tier and
 *    the input keeps submit-quantity 1; past the catalog the count stays on
 *    the top pill, the input holds WHOLE bundle counts (a dead interceptor
 *    under-buys, never oversells), the composed cents = bundles + best
 *    remainder, and the ATC price text is owned via the v26 money twin;
 *  - the ATC capture: steps aside without a remainder, otherwise ONE
 *    items[] add mirroring the theme's success flow;
 *  - pill-driven sync-back (a card tap moves the stepper) without relay
 *    loops or double beacons; the subscription clamp at the top tier;
 *  - the observer write-back: a theme price rewrite while a composed price
 *    is owned is corrected in a microtask (idempotence breaks the loop);
 *  - the atcb restyle: label wrapped from the theme's OWN text, the price
 *    span MOVED (same node — later writes land), drift/notify-me shapes
 *    bail before any mutation.
 *
 * Documented stubs: track is a recorder (preview suppression is the real
 * track()'s own first line, pinned by the house sims that extract it);
 * routeRoot/successState/renderVariables/fetch are recorders; theme pills
 * get a recording .click() that ALSO twins the theme's inline handler
 * (moves .active, writes the tier price in the THEME's own "$" format) and
 * fires addEventListener listeners — exactly the surface the sync drives;
 * azSubPlanId is a sandbox global the clamp cases flip; MutationObserver
 * is a recording fake (the browser API is absent in the vm realm).
 */
"use strict";
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const { extractAll } = require("./lib/extract.cjs");
const { makeDocument, El, textNode, matchesSelector } = require("./lib/mini-dom.cjs");

const REAL_SRC = path.join(
  __dirname,
  "..",
  "..",
  "extensions",
  "cellexia-booster",
  "assets",
  "cellexia-pdp.js",
);
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;
const SRC = fs.readFileSync(SRC_PATH, "utf8");

const EXTRACTED = extractAll(SRC, {
  vars: [
    "PREVIEW",
    "CX_QSEL_STR",
    "CX_QSEL_UNITS",
    "CX_AZ_ICONS",
    "qselMounted",
    "qselApi",
    "QSYNC_CAP",
    "qsyncState",
    "qsyncDocWired",
    "qsyncPricePending",
  ],
  functions: [
    "pdpMember",
    "pdpMemberAllowed",
    "cxEl",
    "cxSp",
    "cxIcon",
    "qselData",
    "qselAllowed",
    "qselLocale",
    "qselStr",
    "qselTpl",
    "qselFormatMoney",
    "qselMoney",
    "qselQty",
    "qselLabel",
    "qselPlural",
    "qselUnitLabel",
    "qselImgs",
    "qselPriceBlock",
    "qselCard",
    "qselWrap",
    "qselButtons",
    "qselPaint",
    "qselBind",
    "qselMount",
    "qsyncData",
    "qsyncAllowed",
    "qsyncTiers",
    "qsyncSplit",
    "qsyncSubActive",
    "qsyncActiveIdx",
    "qsyncChip",
    "qsyncPriceRestore",
    "qsyncPriceWrite",
    "qsyncSchedulePriceWrite",
    "qsyncPrice",
    "qsyncPulse",
    "qsyncApply",
    "qsyncStep",
    "qsyncComposedAdd",
    "qsyncAtcCapture",
    "qsyncMount",
    "atcbMount",
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

// ------------------------------------------------------------------ sandbox

function makeContext() {
  const doc = makeDocument();
  // The shipped module wires document-level listeners (ATC capture +
  // cx:buybox:change) — record them like El does.
  doc._listeners = {};
  doc.addEventListener = function (type, fn) {
    (doc._listeners[type] = doc._listeners[type] || []).push(fn);
  };
  const beacons = [];
  const fetches = [];
  const observers = [];
  function FakeMutationObserver(cb) {
    this.cb = cb;
    this.targets = [];
    observers.push(this);
  }
  FakeMutationObserver.prototype.observe = function (target) {
    this.targets.push(target);
  };
  const sandbox = {
    document: doc,
    window: {
      Shopify: { currency: { active: "EUR" } },
      fetch: function (url, opts) {
        fetches.push({ url, opts: opts || null });
        return Promise.resolve({
          ok: true,
          json: function () {
            return Promise.resolve({ items: [] });
          },
        });
      },
      renderVariablesCalls: 0,
      successStateCalls: 0,
    },
    track: function (feature, type, meta) {
      beacons.push([feature, type || "impression", meta || ""]);
    },
    routeRoot: function () {
      return "/";
    },
    azSubPlanId: function () {
      return null;
    },
    MutationObserver: FakeMutationObserver,
    cfg: {},
    console,
  };
  sandbox.window.renderVariables = function () {
    sandbox.window.renderVariablesCalls++;
  };
  sandbox.window.successState = function () {
    sandbox.window.successStateCalls++;
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox);
  return { sandbox, doc, beacons, fetches, observers };
}

function call(ctx, name, ...args) {
  const fn = vm.runInContext(name, ctx.sandbox);
  return fn(...args);
}

function stateOf(ctx) {
  return vm.runInContext("qsyncState", ctx.sandbox);
}

async function flush() {
  // Promise chains (composed add, observer write-back) resolve in
  // microtasks — drain a few turns deterministically.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// -------------------------------------------------------------- buy fixture

const IDS = ["42692253646984", "42692253679752", "42739675168904"];

const LIVE_VARIANTS = [
  { id: 42692253646984, t: "1 Jar", p: 6700, im: "//cdn.shopify.com/x.jpg" },
  { id: 42692253679752, t: "2 Jars - 15% Off", p: 11390, im: "//cdn.shopify.com/x.jpg" },
  { id: 42739675168904, t: "3 Jars - 20% Off", p: 16080, im: "//cdn.shopify.com/x.jpg" },
];

function qsMember(v) {
  return { live: false, l: "en", mf: "€{{amount}}", v };
}

/**
 * Replica of the LIVE buy area (docs/theme-integration.md): tier pills
 * (last data-val-id leaks a newline), the .action--qty .qty stepper, and
 * the ATC button. Pill .click() twins the theme's inline handler: moves
 * .active, writes the tier's price into [sm-rc-current-price] in the
 * THEME's own naive "$" format (deliberately NOT the shop format, so a
 * mutant that lets the sync own in-catalog prices is visible), then fires
 * the listeners a real dispatch would reach.
 */
function makeBuyArea(ctx, opts) {
  const o = Object.assign({ min: "1", ids: IDS, cents: [6700, 11390, 16080], atcText: "Add to cart -" }, opts);
  const doc = ctx.doc;

  const options = new El("div");
  options.className = "pdp__options";
  const wrap = new El("div");
  wrap.className = "option__wrap option__wrap--buttons";
  wrap.setAttribute("data-option", "sm-rc-option1-selector");
  const btnwrap = new El("div");
  btnwrap.className = "btn__wrap d-flex";

  const priceSpan = new El("span");
  priceSpan.setAttribute("sm-rc-current-price", "");

  const buttons = o.ids.map((id, i) => {
    const b = new El("button");
    b.className = "btn btn--outline btn--flex" + (i === 0 ? " active" : "");
    const leaked = i === o.ids.length - 1 ? id + "\n" : String(id);
    b.setAttribute("data-val-id", leaked);
    b.setAttribute("data-units", String(i + 1));
    b._clicks = 0;
    b.click = function () {
      b._clicks++;
      for (const other of buttons) {
        other.className = other.className.replace(/ ?\bactive\b/, "");
      }
      b.className += " active";
      priceSpan.textContent = "$" + (o.cents[i] / 100).toFixed(2);
      b._fire("click", { target: b });
    };
    btnwrap.appendChild(b);
    return b;
  });
  wrap.appendChild(btnwrap);
  options.appendChild(wrap);
  doc.body.appendChild(options);

  // The theme's global renderer twin: writes the ACTIVE tier's price in the
  // theme's own naive "$" format (what the restore hands back to).
  ctx.sandbox.window.renderVariables = function () {
    ctx.sandbox.window.renderVariablesCalls++;
    for (let i = 0; i < buttons.length; i++) {
      if ((" " + buttons[i].className + " ").indexOf(" active ") !== -1) {
        priceSpan.textContent = "$" + (o.cents[i] / 100).toFixed(2);
        return;
      }
    }
  };

  const actions = new El("div");
  actions.className = "pdp__actions pdp__actions--flex d-flex justify-between";
  const actionQty = new El("div");
  actionQty.className = "action action--qty";
  const qty = new El("div");
  qty.className = "qty d-flex align-center";
  const minus = new El("button");
  minus.className = "js-qty js-qty--minus";
  const input = new El("input");
  input.setAttribute("sm-rc-quantity-selector", "");
  input.setAttribute("name", "quantity");
  input.setAttribute("min", o.min);
  input.value = o.min;
  const plus = new El("button");
  plus.className = "js-qty js-qty--plus";
  qty.appendChild(minus);
  qty.appendChild(input);
  qty.appendChild(plus);
  actionQty.appendChild(qty);
  actions.appendChild(actionQty);

  const actionAtc = new El("div");
  actionAtc.className = "action action--atc";
  const atc = new El("button");
  atc.className = "btn btn--primary btn--atc";
  atc.setAttribute("sm-rc-add-to-cart", "");
  atc.closest = function (sel) {
    return matchesSelector(atc, sel) ? atc : null;
  };
  const oos = new El("span");
  oos.className = "oos-text";
  oos.textContent = "Out of stock";
  const isText = new El("span");
  isText.className = "is-text";
  if (o.atcText !== null) {
    const t = textNode(o.atcText + " ");
    t.nodeValue = o.atcText + " ";
    isText.appendChild(t);
  }
  isText.appendChild(priceSpan);
  atc.appendChild(oos);
  atc.appendChild(isText);
  actionAtc.appendChild(atc);
  actions.appendChild(actionAtc);
  doc.body.appendChild(actions);

  return { options, wrap, buttons, qty, input, atc, isText, priceSpan };
}

function mountSync(opts, memberOpts) {
  const ctx = makeContext();
  const page = makeBuyArea(ctx, opts);
  ctx.sandbox.cfg = Object.assign(
    { qs: qsMember(LIVE_VARIANTS), qy: { live: true } },
    memberOpts || {},
  );
  call(ctx, "qsyncMount");
  const root = ctx.doc.querySelector(".cx-qsync");
  return { ctx, page, root };
}

function stepper(root) {
  return {
    minus: root.querySelector(".cx-qsync__btn--minus"),
    plus: root.querySelector(".cx-qsync__btn--plus"),
    count: root.querySelector(".cx-qsync__count"),
    chip: root.querySelector(".cx-qsync__save"),
  };
}

function press(el, times) {
  for (let i = 0; i < (times || 1); i++) el._fire("click", { target: el });
}

// ------------------------------------------------- S1: mount happy path

{
  const { ctx, page, root } = mountSync();
  ok(!!root, "S1: sync stepper mounts on the live buy-area fixture");
  ok(
    root && root.parentNode === page.qty.parentNode && root.nextElementSibling === page.qty,
    "S1: stepper inserted exactly where the theme's .qty was (before it)",
  );
  ok(
    (" " + page.qty.className + " ").indexOf(" cx-qsync-src ") !== -1 &&
      page.qty.getAttribute("aria-hidden") === "true" &&
      page.qty.getAttribute("data-cx-qsync") === "1",
    "S1: theme stepper hidden (class + aria-hidden + idempotency marker) only after the insert",
  );
  ok(root && root.getAttribute("data-cx-feature") === "quantity_sync", "S1: root carries the feature marker");
  ok(root && root.getAttribute("aria-label") === "Quantity", "S1: group label = the en qty string");
  const s = stepper(root);
  ok(
    s.minus.getAttribute("aria-label") === "Decrease quantity" &&
      s.plus.getAttribute("aria-label") === "Increase quantity",
    "S1: stepper buttons carry the localized aria labels",
  );
  ok(s.count.textContent === "1" && page.input.value === "1", "S1: count mirrors the active pill; submit qty = 1");
  ok(
    ctx.beacons.length === 1 && ctx.beacons[0].join("|") === "quantity_sync|impression|",
    "S1: exactly one impression beacon on mount",
  );
  ok(s.chip.hidden === true, "S1: no save chip at 1 unit");
}

// ------------------------------------------------- S2: gates veto the mount

{
  const ctx = makeContext();
  makeBuyArea(ctx);
  ctx.sandbox.cfg = { qs: qsMember(LIVE_VARIANTS) }; // qy member absent
  call(ctx, "qsyncMount");
  ok(!ctx.doc.querySelector(".cx-qsync"), "S2: no qy member = no mount");
}
{
  const ctx = makeContext();
  makeBuyArea(ctx);
  ctx.sandbox.cfg = { qs: qsMember(LIVE_VARIANTS), qy: { live: false } };
  call(ctx, "qsyncMount");
  ok(!ctx.doc.querySelector(".cx-qsync"), "S2: live:false without a verified preview = no mount");
}
{
  const ctx = makeContext();
  const page = makeBuyArea(ctx);
  ctx.sandbox.cfg = { qs: qsMember(LIVE_VARIANTS), qy: { live: false } };
  vm.runInContext("PREVIEW = { flags: { quantity_sync: true }, live: {} };", ctx.sandbox);
  call(ctx, "qsyncMount");
  ok(!!ctx.doc.querySelector(".cx-qsync"), "S2: a verified preview draft flag admits the mount");
  ok((" " + page.qty.className + " ").indexOf(" cx-qsync-src ") !== -1, "S2: draft mount behaves like live (theme stepper hidden)");
}
{
  const ctx = makeContext();
  makeBuyArea(ctx);
  ctx.sandbox.cfg = { qy: { live: true } }; // qs data member missing
  call(ctx, "qsyncMount");
  ok(!ctx.doc.querySelector(".cx-qsync"), "S2: no qs data (variant cents) = no mount");
}

// ------------------------------------------------- S3: MOQ > 1 bails

{
  const { ctx, page, root } = mountSync({ min: "3" });
  ok(!root, "S3: a MOQ stepper (min=3) is never replaced");
  ok(
    (" " + page.qty.className + " ").indexOf(" cx-qsync-src ") === -1 && !page.qty.getAttribute("aria-hidden"),
    "S3: the theme stepper is fully untouched on the bail",
  );
  ok(ctx.beacons.length === 0, "S3: no beacon on a bail");
}

// ------------------------------------------------- S4: tier-shape guards

{
  const ctx = makeContext();
  makeBuyArea(ctx);
  ctx.sandbox.cfg = {
    qy: { live: true },
    qs: qsMember([
      { id: 42692253646984, t: "30ml", p: 6700 },
      { id: 42692253679752, t: "50ml", p: 11390 },
      { id: 42739675168904, t: "100ml", p: 16080 },
    ]),
  };
  call(ctx, "qsyncMount");
  ok(!ctx.doc.querySelector(".cx-qsync"), "S4: size-shaped titles (30ml/50ml) = no mount, no fabricated unit math");
}
{
  const ctx = makeContext();
  makeBuyArea(ctx);
  ctx.sandbox.cfg = {
    qy: { live: true },
    qs: qsMember([
      { id: 42692253646984, t: "1 Jar", p: 6700 },
      { id: 42692253679752, t: "3 Jars", p: 16080 },
    ]),
  };
  call(ctx, "qsyncMount");
  ok(!ctx.doc.querySelector(".cx-qsync"), "S4: non-consecutive tiers (1,3) = no mount");
}
{
  const ctx = makeContext();
  makeBuyArea(ctx, { ids: ["1", "2", "3"] }); // pills exist but ids differ
  ctx.sandbox.cfg = { qy: { live: true }, qs: qsMember(LIVE_VARIANTS) };
  call(ctx, "qsyncMount");
  ok(!ctx.doc.querySelector(".cx-qsync"), "S4: id mismatch vs the theme pills = no mount (theme drift)");
}

// ------------------------------------------------- S5: units 1..3 relay pills

{
  const { ctx, page, root } = mountSync();
  const s = stepper(root);
  press(s.plus);
  ok(s.count.textContent === "2", "S5: plus moves the count to 2");
  ok(page.buttons[1]._clicks === 1 && page.buttons[0]._clicks === 0, "S5: exactly ONE relay click on the 2-unit pill");
  ok(page.input.value === "1", "S5: submit quantity stays 1 (the tier variant IS the 2 units)");
  ok(page.priceSpan.textContent === "$113.90", "S5: the THEME wrote the tier price (the sync owns nothing in catalog)");
  const chip = s.chip;
  ok(chip.hidden === false && chip.textContent === "Save €20.10", "S5: save chip = 2x baseline minus tier, cards' wording (got " + chip.textContent + ")");
  ok((" " + root.className + " ").indexOf(" cx-qsync--deal ") !== -1, "S5: the deal ring accompanies the chip");
  ok(
    ctx.beacons.filter((b) => b[0] === "quantity_sync" && b[1] === "click" && b[2] === "q2").length === 1,
    "S5: one q2 click beacon",
  );
  press(s.plus);
  ok(s.count.textContent === "3" && page.buttons[2]._clicks === 1 && page.input.value === "1", "S5: 3 selects the top tier at submit qty 1");
  press(s.minus, 2);
  ok(s.count.textContent === "1" && page.buttons[0]._clicks === 1 && page.input.value === "1", "S5: minus walks back to 1 through the pills");
  ok(s.chip.hidden === true && (" " + root.className + " ").indexOf(" cx-qsync--deal ") === -1, "S5: chip and ring retire at 1 unit");
}

// ------------------------------------------------- S6: past the catalog (4+)

{
  const { ctx, page, root } = mountSync();
  const s = stepper(root);
  press(s.plus, 3); // n = 4
  ok(s.count.textContent === "4", "S6: count reaches 4");
  ok(page.buttons[2]._clicks === 1, "S6: the top pill was selected once on the way (no extra relay at 4)");
  ok(page.input.value === "1", "S6: submit qty = whole bundles only (floor(4/3) = 1) — a dead interceptor under-buys");
  ok(page.priceSpan.textContent === "€227.80", "S6: composed price owned in shop format (3-pack + 1, got " + page.priceSpan.textContent + ")");
  ok(s.chip.textContent === "Save €40.20", "S6: chip = 4x baseline minus composed (got " + s.chip.textContent + ")");
  press(s.plus); // n = 5
  ok(page.priceSpan.textContent === "€274.70" && page.input.value === "1", "S6: 5 = 3-pack + 2-pack (got " + page.priceSpan.textContent + ")");
  press(s.plus); // n = 6
  ok(page.priceSpan.textContent === "€321.60" && page.input.value === "2", "S6: 6 = two whole bundles, submit qty 2, no remainder");
  press(s.minus, 3); // back to 3
  ok(
    page.priceSpan.textContent === "$160.80" && ctx.sandbox.window.renderVariablesCalls > 0,
    "S6: back in catalog the price is handed BACK to the theme (renderVariables restore)",
  );
}

// ------------------------------------------------- S7: the ATC capture

{
  const { ctx, page, root } = mountSync();
  const s = stepper(root);
  press(s.plus, 5); // n = 6 — whole bundles
  let prevented = 0;
  let stopped = 0;
  const ev = {
    target: page.atc,
    preventDefault: function () { prevented++; },
    stopPropagation: function () { stopped++; },
  };
  ctx.doc._listeners.click[0](ev);
  ok(prevented === 0 && stopped === 0 && ctx.fetches.length === 0, "S7: whole bundles = the capture steps aside (native add is exact)");
  press(s.minus, 2); // n = 4 — needs a remainder line
  ctx.doc._listeners.click[0](ev);
  ok(prevented === 1 && stopped === 1, "S7: remainder counts intercept the native add");
  ok(ctx.fetches.length === 1 && ctx.fetches[0].url === "/cart/add.js", "S7: ONE composed add call");
  const body = JSON.parse(ctx.fetches[0].opts.body);
  ok(
    Array.isArray(body.items) &&
      body.items.length === 2 &&
      body.items[0].id === 42739675168904 &&
      body.items[0].quantity === 1 &&
      body.items[1].id === 42692253646984 &&
      body.items[1].quantity === 1,
    "S7: items = one 3-pack bundle + the 1-unit remainder",
  );
  ok(
    ctx.beacons.some((b) => b.join("|") === "quantity_sync|add_to_cart|q4"),
    "S7: the composed add beacons add_to_cart with the unit meta",
  );
}
{
  const { ctx, page, root } = mountSync();
  press(stepper(root).plus, 4); // n = 5 -> 3 + 2
  const ev = { target: page.atc, preventDefault() {}, stopPropagation() {} };
  ctx.doc._listeners.click[0](ev);
  const body = JSON.parse(ctx.fetches[0].opts.body);
  ok(
    body.items[1].id === 42692253679752 && body.items[1].quantity === 1,
    "S7: the remainder line is the BEST matching tier (2-pack), quantity 1",
  );
}

// ------------------------------------------------- S9: pill-driven sync-back

{
  const { ctx, page, root } = mountSync();
  const s = stepper(root);
  // A card tap relays a native click on the 2-unit pill — the stepper follows.
  page.buttons[1].click();
  ok(s.count.textContent === "2" && page.input.value === "1", "S9: a tier tap moves the stepper to that tier's units");
  ok(page.buttons[1]._clicks === 1, "S9: the sync does NOT re-click the pill it just heard (no relay loop)");
  ok(
    ctx.beacons.filter((b) => b[0] === "quantity_sync" && b[1] === "click").length === 0,
    "S9: a pill-driven change ships no quantity_sync click beacon (one shopper action, one beacon)",
  );
  // From a composed count, tapping a tier collapses back to that tier.
  press(s.plus, 3); // 2 -> 5
  page.buttons[0].click();
  ok(s.count.textContent === "1" && page.input.value === "1", "S9: tapping the 1-unit tier from a composed count collapses to 1");
}

// ------------------------------------------------- S10: subscription clamp

{
  const { ctx, page, root } = mountSync();
  const s = stepper(root);
  ctx.sandbox.azSubPlanId = function () { return "718653555063"; };
  press(s.plus, 5);
  ok(s.count.textContent === "3", "S10: with a subscription selected the stepper caps at the top tier");
  ctx.sandbox.azSubPlanId = function () { return null; };
  press(s.plus, 2); // one-time again: 3 -> 5
  ok(s.count.textContent === "5", "S10: back on one-time the composed counts return");
  ctx.sandbox.azSubPlanId = function () { return "718653555063"; };
  // The buy box announces the mode flip.
  ctx.doc._listeners["cx:buybox:change"][0]();
  ok(s.count.textContent === "3" && page.input.value === "1", "S10: cx:buybox:change snaps a composed count back to the top tier");
  const ev = { target: page.atc, preventDefault() {}, stopPropagation() {} };
  ctx.doc._listeners.click[0](ev);
  ok(ctx.fetches.length === 0, "S10: in sub mode the capture never composes an add");
}

// ------------------------------------------------- S12b: chip honesty

{
  // A catalog whose 2-tier saves NOTHING (2 x 6700 exactly): the chip must
  // stay hidden — computed honesty, the v26 save-chip rule twinned.
  const ctx = makeContext();
  makeBuyArea(ctx, { cents: [6700, 13400, 16080] });
  ctx.sandbox.cfg = {
    qy: { live: true },
    qs: qsMember([
      { id: 42692253646984, t: "1 Jar", p: 6700 },
      { id: 42692253679752, t: "2 Jars", p: 13400 },
      { id: 42739675168904, t: "3 Jars - 20% Off", p: 16080 },
    ]),
  };
  call(ctx, "qsyncMount");
  const root = ctx.doc.querySelector(".cx-qsync");
  const s = stepper(root);
  press(s.plus); // n = 2, zero saving
  ok(
    s.chip.hidden === true && s.chip.textContent === "" && (" " + root.className + " ").indexOf(" cx-qsync--deal ") === -1,
    "S12b: a zero saving hides the chip and the ring (never a 'Save €0.00' claim)",
  );
  press(s.plus); // n = 3, real saving again
  ok(s.chip.hidden === false && s.chip.textContent === "Save €40.20", "S12b: a real saving brings the chip back (got " + s.chip.textContent + ")");
}

// ------------------------------------------------- S12: cap + no-op beacons

{
  const { ctx, root } = mountSync();
  const s = stepper(root);
  press(s.plus, 40);
  ok(s.count.textContent === "24", "S12: the counter caps at 24 (qselQty's own cap)");
  const clicks = ctx.beacons.filter((b) => b[0] === "quantity_sync" && b[1] === "click").length;
  ok(clicks === 23, "S12: clamped presses beacon nothing (23 real changes, got " + clicks + ")");
  press(s.minus, 40);
  ok(s.count.textContent === "1", "S12: minus floors at 1");
}

// ------------------------------------------------- S13: atcb restyle

{
  const ctx = makeContext();
  const page = makeBuyArea(ctx);
  ctx.sandbox.cfg = { ab: { live: true } };
  call(ctx, "atcbMount");
  const atc = page.atc;
  ok((" " + atc.className + " ").indexOf(" cx-atcb ") !== -1, "S13: button gains the restyle class");
  ok(atc.getAttribute("data-cx-feature") === "atc_button", "S13: button carries the feature marker");
  const kids = page.isText.children;
  ok(
    kids.length === 2 &&
      kids[0].className === "cx-atcb__main" &&
      kids[1].className === "cx-atcb__price",
    "S13: .is-text reflows into main + price slots",
  );
  const label = kids[0].querySelector(".cx-atcb__label");
  ok(!!label && label.textContent === "Add to cart", "S13: label = the theme's own text minus the ' - ' joiner (got '" + (label && label.textContent) + "')");
  // mini-dom stores innerHTML verbatim (cxIcon degrades to a text node
  // here), so the glyph is asserted by SLOT: two children, the label last.
  ok(
    kids[0].childNodes.length === 2 && kids[0].childNodes[1] === label,
    "S13: the cart glyph slot leads the label",
  );
  ok(kids[1].children[0] === page.priceSpan, "S13: the price span MOVED (same node) into the price slot");
  page.priceSpan.textContent = "€99.00";
  ok(page.isText.querySelector("[sm-rc-current-price]").textContent === "€99.00", "S13: later theme writes land in the moved node");
  ok(
    page.atc.querySelector(".oos-text") !== null && page.atc.querySelector(".oos-text").textContent === "Out of stock",
    "S13: the OOS span is untouched",
  );
  ok(ctx.beacons.filter((b) => b.join("|") === "atc_button|impression|").length === 1, "S13: one impression per decorated button");
  call(ctx, "atcbMount");
  ok(page.isText.children.length === 2 && ctx.beacons.length === 1, "S13: remount is idempotent (marker guard)");
}

// ------------------------------------------------- S14: atcb bails

{
  const ctx = makeContext();
  const page = makeBuyArea(ctx);
  ctx.sandbox.cfg = { ab: { live: false } };
  call(ctx, "atcbMount");
  ok((" " + page.atc.className + " ").indexOf(" cx-atcb ") === -1 && ctx.beacons.length === 0, "S14: live:false = untouched button, no beacon");
}
{
  // Notify-me shaped button: no .is-text/price span at all.
  const ctx = makeContext();
  const doc = ctx.doc;
  const btn = new El("button");
  btn.className = "btn btn--primary btn--atc";
  btn.setAttribute("sm-rc-add-to-cart", "");
  btn.textContent = "Notify me";
  doc.body.appendChild(btn);
  ctx.sandbox.cfg = { ab: { live: true } };
  call(ctx, "atcbMount");
  ok((" " + btn.className + " ").indexOf(" cx-atcb ") === -1 && btn.textContent === "Notify me", "S14: a notify-me button is left exactly as it is");
}
{
  // Unknown extra element inside .is-text = theme drift: bail BEFORE mutating.
  const ctx = makeContext();
  const page = makeBuyArea(ctx);
  const stray = new El("strong");
  stray.textContent = "!";
  page.isText.appendChild(stray);
  ctx.sandbox.cfg = { ab: { live: true } };
  call(ctx, "atcbMount");
  ok(
    (" " + page.atc.className + " ").indexOf(" cx-atcb ") === -1 && page.isText.childNodes.length === 3,
    "S14: unknown .is-text children = no mutation at all",
  );
}

// ------------------------------------------------- S15: cards + sync together

{
  const ctx = makeContext();
  const page = makeBuyArea(ctx);
  ctx.sandbox.cfg = { qs: Object.assign(qsMember(LIVE_VARIANTS), { live: true }), qy: { live: true } };
  call(ctx, "qselMount");
  call(ctx, "qsyncMount");
  const cardsRoot = ctx.doc.querySelector(".cx-qsel");
  const root = ctx.doc.querySelector(".cx-qsync");
  ok(!!cardsRoot && !!root, "S15: cards and sync mount together");
  const s = stepper(root);
  press(s.plus); // n = 2 through the cards' choose channel
  const cards = cardsRoot.querySelectorAll(".cx-qsel__card");
  ok(cards[1].getAttribute("aria-checked") === "true" && cards[0].getAttribute("aria-checked") === "false", "S15: the stepper repaints the card selection through choose");
  ok(page.buttons[1]._clicks === 1, "S15: one theme relay under the choose channel too");
  ok(
    ctx.beacons.filter((b) => b[0] === "quantity_selector" && b[1] === "click").length === 0,
    "S15: a stepper-driven choose is silent under the cards' key (the sync owns the beacon)",
  );
  ok(
    ctx.beacons.filter((b) => b[0] === "quantity_sync" && b[1] === "click" && b[2] === "q2").length === 1,
    "S15: ...and beacons once under its own key",
  );
  ok((" " + cards[1].className + " ").indexOf(" cx-qsel__card--pulse ") !== -1, "S15: the chosen card pulses (the visual thread)");
  // A card tap (shopper action) still beacons under the cards' key and the
  // stepper follows silently.
  cards[2]._fire("click");
  ok(s.count.textContent === "3", "S15: a card tap moves the stepper");
  ok(
    ctx.beacons.filter((b) => b[0] === "quantity_selector" && b[1] === "click" && b[2] === "q3").length === 1,
    "S15: the card tap beacons under the cards' key exactly once",
  );
}

// ------------------------------------------------- S17: v32 volume (vd) mode

{
  const ctx = makeContext();
  const page = makeBuyArea(ctx);
  ctx.sandbox.cfg = { qs: qsMember(LIVE_VARIANTS), qy: { live: true, vd: 1 } };
  call(ctx, "qsyncMount");
  const root = ctx.doc.querySelector(".cx-qsync");
  ok(!!root, "S17: vd mode mounts like the plain sync");
  const s = stepper(root);
  press(s.plus, 3); // n = 4
  ok(s.count.textContent === "4", "S17: count reaches 4 in vd mode");
  ok(page.input.value === "4", "S17: the input holds the FULL unit count (one discounted line, native add)");
  ok(
    page.buttons[0]._clicks === 1 && page.buttons[2]._clicks === 1,
    "S17: crossing the catalog relays ONE click back to the 1-unit pill (the mechanical selection)",
  );
  // round(4 x 16080 / 3) = 21440 — the SAME half-up formula the function's
  // logic.js applies to the discounted line.
  ok(page.priceSpan.textContent === "€214.40", "S17: displayed total = round(n x p3 / K) (got " + page.priceSpan.textContent + ")");
  ok(s.chip.textContent === "Save €53.60", "S17: chip = n x baseline minus the discounted total (got " + s.chip.textContent + ")");
  const ev = { target: page.atc, preventDefault() { ok(false, "S17: vd must never preventDefault"); }, stopPropagation() {} };
  ctx.doc._listeners.click[0](ev);
  ok(ctx.fetches.length === 0, "S17: vd mode NEVER intercepts the add (the discount prices the native line)");
  press(s.plus, 2); // n = 6
  ok(page.input.value === "6" && page.priceSpan.textContent === "€321.60", "S17: at a multiple of K the vd figure equals the bundle figure (got " + page.priceSpan.textContent + ")");
  press(s.minus, 3); // n = 3
  ok(
    page.input.value === "1" && page.buttons[2]._clicks === 2 && page.priceSpan.textContent === "$160.80",
    "S17: dropping back into the catalog re-selects the tier pill and hands the price to the theme",
  );
}

// ------------------------------------------- S18: vd paints the TOP card

{
  const ctx = makeContext();
  const page = makeBuyArea(ctx);
  ctx.sandbox.cfg = { qs: Object.assign(qsMember(LIVE_VARIANTS), { live: true }), qy: { live: true, vd: 1 } };
  call(ctx, "qselMount");
  call(ctx, "qsyncMount");
  const cardsRoot = ctx.doc.querySelector(".cx-qsel");
  const root = ctx.doc.querySelector(".cx-qsync");
  const s = stepper(root);
  const cards = cardsRoot.querySelectorAll(".cx-qsel__card");
  press(s.plus, 3); // n = 4
  ok(
    cards[2].getAttribute("aria-checked") === "true" && cards[0].getAttribute("aria-checked") === "false",
    "S18: past the catalog the TOP card stays painted (the rate promise) while the pill selection is the 1-unit variant",
  );
  ok(page.buttons[0]._clicks === 1, "S18: ...and the mechanical relay went to the 1-unit pill");
  press(s.plus); // n = 5, no relay, paint stays
  ok(cards[2].getAttribute("aria-checked") === "true", "S18: the top card stays painted across further steps");
  // A card tap still collapses to that tier.
  cards[0]._fire("click");
  ok(s.count.textContent === "1" && page.input.value === "1", "S18: tapping the 1-unit card from a vd count collapses to 1");
  ok(cards[0].getAttribute("aria-checked") === "true", "S18: ...and paints the tapped card again");
}

// ---------------------------------- S19: v32.2 volume wanted-but-not-armed

{
  // vd:0 = the merchant turned volume ON but arming is not verified: the
  // stepper caps at the top tier (the merchant rejected the composed 3+1
  // fallback for 4+) — never a count the discount cannot price.
  const ctx = makeContext();
  const page = makeBuyArea(ctx);
  ctx.sandbox.cfg = { qs: qsMember(LIVE_VARIANTS), qy: { live: true, vd: 0 } };
  call(ctx, "qsyncMount");
  const root = ctx.doc.querySelector(".cx-qsync");
  ok(!!root, "S19: vw mode mounts like the plain sync");
  const s = stepper(root);
  press(s.plus, 6);
  ok(s.count.textContent === "3" && page.input.value === "1", "S19: the counter caps at the top tier while volume is unverified");
  ok(
    ctx.beacons.filter((b) => b[0] === "quantity_sync" && b[1] === "click").length === 2,
    "S19: clamped presses beacon nothing (2 real changes)",
  );
  const ev = { target: page.atc, preventDefault() { ok(false, "S19: vw must never preventDefault"); }, stopPropagation() {} };
  ctx.doc._listeners.click[0](ev);
  ok(ctx.fetches.length === 0, "S19: nothing is ever composed in vw mode");
  ok(page.priceSpan.textContent === "$160.80", "S19: the theme owns the price at the cap");
}

// -------------------------------------- S11 + S16 (async): observer + add flow

async function asyncChecks() {
  {
    const { ctx, page, root } = mountSync();
    press(stepper(root).plus, 3); // n = 4, composed price owned
    ok(page.priceSpan.textContent === "€227.80", "S11: composed price in place");
    ok(
      ctx.observers.length === 1 && ctx.observers[0].targets.indexOf(page.priceSpan) !== -1,
      "S11: the price span is observed",
    );
    // Theme rewrites the span (its own event) — the sync writes back in a
    // microtask, never synchronously inside the observer callback.
    page.priceSpan.textContent = "$160.80";
    ctx.observers[0].cb();
    ok(page.priceSpan.textContent === "$160.80", "S11: no synchronous tug-of-war inside the observer");
    await flush();
    ok(page.priceSpan.textContent === "€227.80", "S11: the microtask write-back restores the composed price");
    // Back in catalog nothing is owned: a theme write stays.
    press(stepper(root).minus); // n = 3
    page.priceSpan.textContent = "$160.80";
    ctx.observers[0].cb();
    await flush();
    ok(page.priceSpan.textContent === "$160.80", "S11: in catalog the theme's writes are never touched");
  }
  {
    const { ctx, page, root } = mountSync();
    press(stepper(root).plus, 3); // n = 4
    const ev = { target: page.atc, preventDefault() {}, stopPropagation() {} };
    ctx.doc._listeners.click[0](ev);
    await flush();
    ok(ctx.sandbox.window.successStateCalls === 1, "S16: the composed add hands off to the theme's own successState");
  }
}

// ------------------------------------------------------------- mutants
async function main() {
  await asyncChecks();
  console.log(
    failures === 0
      ? `ALL ${checks} CHECKS PASSED (v31 quantity sync + atc button vs the real cellexia-pdp.js module)`
      : `\n${failures}/${checks} CHECKS FAILED`,
  );
  if (failures > 0) process.exitCode = 1;
  runMutantsPhase();
}

function runMutantsPhase() {
  if (!process.env.CX_SKIP_MUTANTS && failures === 0) {
  const { runMutants } = require("./lib/mutants.cjs");
  const bad = runMutants({
    selfPath: __filename,
    srcPath: REAL_SRC,
    mutants: [
      {
        // Dropping the allowed-gate would leak draft/live-off mounts.
        name: "m1-gate-dropped",
        find: "    return !!d && pdpMemberAllowed(d, 'quantity_sync');",
        replace: "    return !!d;",
      },
      {
        // The consecutive-1..K guard is the anti-fabrication rule: a
        // size-shaped product must never get unit semantics.
        name: "m2-consecutive-dropped",
        find: "      if (qselQty(v.t) !== i + 1) return null;",
        replace: "      ",
      },
      {
        // A MOQ stepper steps by its min — replacing it corrupts B2B carts.
        name: "m3-moq-bail-dropped",
        find: "      if ((parseInt(input.getAttribute('min') || '1', 10) || 1) > 1) return;",
        replace: "      ",
      },
      {
        // The input must hold WHOLE BUNDLES, never the unit count — the
        // native add multiplies it by the selected tier.
        name: "m4-submit-qty-units",
        find: "    try { st.input.value = String(split.qty); } catch (e) { /* noop */ }",
        replace: "    try { st.input.value = String(st.n); } catch (e) { /* noop */ }",
      },
      {
        // Without the remainder gate every add is intercepted (or none).
        name: "m5-remainder-gate-flipped",
        find: "      if (!split.rem) return;",
        replace: "      if (split.rem) return;",
      },
      {
        // The composed items must carry the BUNDLE count, not the units.
        name: "m6-items-unit-count",
        find: "    var items = [{ id: parseInt(split.tier.id, 10), quantity: split.qty }];",
        replace: "    var items = [{ id: parseInt(split.tier.id, 10), quantity: st.n }];",
      },
      {
        // The subscription clamp keeps plan pricing exact.
        name: "m7-sub-clamp-dropped",
        find: "    var cap = qsyncSubActive() || st.vw ? st.top.q : QSYNC_CAP;",
        replace: "    var cap = st.vw ? st.top.q : QSYNC_CAP;",
      },
      {
        // v32.2: an unverified volume must cap, never compose (the field
        // incident's rejected 3+1 fallback).
        name: "m19-vw-clamp-dropped",
        find: "    var cap = qsyncSubActive() || st.vw ? st.top.q : QSYNC_CAP;",
        replace: "    var cap = qsyncSubActive() ? st.top.q : QSYNC_CAP;",
      },
      {
        // In catalog the THEME owns the price text; owning it always would
        // fight renderVariables on every variant/plan change.
        name: "m8-price-owned-always",
        find: "    if (st.n <= st.top.q) {",
        replace: "    if (false) {",
      },
      {
        // The composed cents must include the remainder tier.
        name: "m9-remainder-cents-dropped",
        find: "      cents: bundles * top.p + (r > 0 ? tiers[r - 1].p : 0)",
        replace: "      cents: bundles * top.p",
      },
      {
        // A stepper-driven choose must stay silent under the cards' key.
        name: "m10-relay-not-silent",
        find: "        else if (qselApi) qselApi.choose(split.tier.idx, false, true);",
        replace: "        else if (qselApi) qselApi.choose(split.tier.idx, false);",
      },
      {
        // The chip is computed honesty — a zero saving must hide it.
        name: "m11-chip-honesty-dropped",
        find: "    if (st.n >= 2 && diff > 0) {",
        replace: "    if (st.n >= 2) {",
      },
      {
        // The mount impression is the analytics denominator.
        name: "m12-impression-dropped",
        find: "      try { input.value = '1'; } catch (e) { /* noop */ }\n      track('quantity_sync');",
        replace: "      try { input.value = '1'; } catch (e) { /* noop */ }",
      },
      {
        // The restyle gate mirrors every other member gate.
        name: "m13-atcb-gate-dropped",
        find: "      if (!d || !pdpMemberAllowed(d, 'atc_button')) return;",
        replace: "      if (!d) return;",
      },
      {
        // v32 vd: the input must hold the FULL unit count (the discounted
        // single line) — bundle counts would under-add.
        name: "m15-vd-input-bundles",
        find: "      return { tier: tiers[0], qty: n, rem: null, cents: Math.round(n * top.p / top.q) };",
        replace: "      return { tier: tiers[0], qty: Math.floor(n / top.q), rem: null, cents: Math.round(n * top.p / top.q) };",
      },
      {
        // v32 vd: the capture must step aside — the discount prices the
        // native line; composing would double the order.
        name: "m16-vd-intercepts",
        find: "      if (st.vd) return;\n      var split = qsyncSplit(st.n, st.tiers);",
        replace: "      var split = qsyncSplit(st.n, st.tiers);",
      },
      {
        // v32 vd: the cards must keep the TOP tier painted (the rate
        // promise), never the mechanical 1-unit selection.
        name: "m17-vd-paints-mechanical",
        find: "    var paintIdx = vdTop ? st.top.idx : split.tier.idx;",
        replace: "    var paintIdx = split.tier.idx;",
      },
      {
        // v32 vd: the shown figure must be the discounted formula, not the
        // full single-unit price.
        name: "m18-vd-full-price-shown",
        find: "cents: Math.round(n * top.p / top.q) };",
        replace: "cents: n * tiers[0].p };",
      },
      {
        // Drift must bail BEFORE any mutation.
        name: "m14-drift-bail-dropped",
        find: "        return;\n      }\n      label = label.replace(/\\s*[-–—]\\s*$/, '').replace(/^\\s+|\\s+$/g, '');",
        replace: "        continue;\n      }\n      label = label.replace(/\\s*[-–—]\\s*$/, '').replace(/^\\s+|\\s+$/g, '');",
      },
    ],
  });
  if (bad > 0) {
    console.log(`\n${bad} MUTANT(S) NOT CAUGHT (quantity-sync)`);
    process.exitCode = 1;
  }
  }
}

main();
