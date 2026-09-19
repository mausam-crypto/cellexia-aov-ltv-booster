/**
 * v26 quantity-selector sim — runs the REAL card-picker machinery
 * vm-extracted from extensions/cellexia-booster/assets/cellexia-pdp.js
 * (docs/SPEC-v26-quantity-selector.md):
 *
 *  - mount against a replica of the LIVE theme picker markup (2026-09-18:
 *    .pdp__options > .option__wrap--buttons > .btn__wrap > button pills with
 *    data-val-id / data-units, INCLUDING the trailing-newline the theme's
 *    pdp-options.liquid leaks into the last button's data-val-id);
 *  - id-only button mapping, and every bail path (count mismatch, id
 *    mismatch, multi-option product, single variant) proven to leave the
 *    theme's picker untouched — never hide without inserting (v6.6);
 *  - math honesty: per-unit price + struck baseline + save chip only when
 *    the first variant is a real 1-unit baseline and the tier genuinely
 *    discounts; a "30ml"-style title never fabricates unit math;
 *  - the relay contract: a card tap fires ONE native click on the matching
 *    original button and one click beacon with the q<units> meta; selecting
 *    the selected card is a no-op; arrow keys move the selection;
 *  - the live/draft gate (pdpMemberAllowed) and the money chain
 *    (qselFormatMoney twin: all Shopify placeholder variants, tag strip).
 *
 * Documented stubs: track is a recorder (beacon suppression under PREVIEW
 * is the track() function's own first line, pinned by the house sims that
 * extract it); theme buttons get a recording .click() — exactly the surface
 * the relay drives; focus() is absent (the module try/catches it).
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
  "cellexia-pdp.js",
);
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;
const SRC = fs.readFileSync(SRC_PATH, "utf8");

const EXTRACTED = extractAll(SRC, {
  vars: ["PREVIEW", "CX_QSEL_STR", "CX_QSEL_UNITS", "CX_AZ_ICONS", "qselMounted"],
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
  const beacons = [];
  const sandbox = {
    document: doc,
    window: {
      Shopify: { currency: { active: "EUR" } },
    },
    track: function (feature, type, meta) {
      beacons.push([feature, type || "impression", meta || ""]);
    },
    cfg: {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox);
  return { sandbox, doc, beacons };
}

function call(ctx, name, ...args) {
  const fn = vm.runInContext(name, ctx.sandbox);
  return fn(...args);
}

// Replica of the LIVE theme picker (see docs/theme-integration.md): the
// third button's data-val-id carries the theme's trailing newline.
function makePicker(ctx, ids, opts) {
  const o = Object.assign({ activeIndex: 0, extraWrap: false, leakNewline: true }, opts);
  const doc = ctx.doc;
  const options = new El("div");
  options.className = "pdp__options";
  const wrap = new El("div");
  wrap.className = "option__wrap option__wrap--buttons";
  wrap.setAttribute("data-option", "sm-rc-option1-selector");
  const label = new El("label");
  label.textContent = "Select Size";
  wrap.appendChild(label);
  const btnwrap = new El("div");
  btnwrap.className = "btn__wrap d-flex";
  const buttons = ids.map((id, i) => {
    const b = new El("button");
    b.className = "btn btn--outline btn--flex" + (i === o.activeIndex ? " active" : "");
    const leaked = o.leakNewline && i === ids.length - 1 ? id + "\n" : String(id);
    b.setAttribute("data-val-id", leaked);
    b.setAttribute("data-units", String(i + 1));
    b._clicks = 0;
    b.click = function () {
      b._clicks++;
    };
    btnwrap.appendChild(b);
    return b;
  });
  wrap.appendChild(btnwrap);
  options.appendChild(wrap);
  if (o.extraWrap) {
    const second = new El("div");
    second.className = "option__wrap option__wrap--buttons";
    options.appendChild(second);
  }
  doc.body.appendChild(options);
  return { options, wrap, buttons };
}

const IDS = ["42692253646984", "42692253679752", "42739675168904"];

function euro(v) {
  return { live: true, l: "en", mf: "€{{amount}}", v };
}

const LIVE_VARIANTS = [
  { id: 42692253646984, t: "1 Jar", p: 6700, im: "//cdn.shopify.com/x.jpg" },
  { id: 42692253679752, t: "2 Jars - 15% Off", p: 11390, im: "//cdn.shopify.com/x.jpg" },
  { id: 42739675168904, t: "3 Jars - 20% Off", p: 16080, im: "//cdn.shopify.com/x.jpg" },
];

function mountLive(opts) {
  const ctx = makeContext();
  const page = makePicker(ctx, IDS, opts);
  ctx.sandbox.cfg = { qs: euro(LIVE_VARIANTS) };
  call(ctx, "qselMount");
  const root = ctx.doc.querySelector(".cx-qsel");
  return { ctx, page, root };
}

// ------------------------------------------- Q1: the live-store happy path

{
  const { ctx, page, root } = mountLive();
  ok(!!root, "Q1: selector mounts on the live-store fixture");
  ok(
    root && page.options.children[0] === root && page.options.children[1] === page.wrap,
    "Q1: cards are inserted exactly where the pill group was (before it)",
  );
  ok(
    (" " + page.wrap.className + " ").indexOf(" cx-qsel-src ") !== -1 &&
      page.wrap.getAttribute("aria-hidden") === "true" &&
      page.wrap.getAttribute("data-cx-qsel") === "1",
    "Q1: the pill group is hidden (class + aria-hidden + idempotency marker) only after the insert",
  );
  ok(
    root && root.getAttribute("data-cx-feature") === "quantity_selector",
    "Q1: root carries the feature marker",
  );
  const title = root && root.querySelector(".cx-qsel__title");
  ok(!!title && title.textContent === "Choose quantity", "Q1: heading = the en table title");
  const cards = root ? root.querySelectorAll(".cx-qsel__card") : [];
  ok(cards.length === 3, "Q1: one card per variant");
  const names = cards.map((c) => c.querySelector(".cx-qsel__name").textContent);
  ok(
    names[0] === "1 Jar" && names[1] === "2 Jars" && names[2] === "3 Jars",
    "Q1: tier names cleaned of the ' - 15% Off' suffix (got: " + names.join(" | ") + ")",
  );
  const badges = cards.map((c) => {
    const b = c.querySelector(".cx-qsel__badge");
    return b ? b.textContent : "";
  });
  ok(
    badges[0] === "" && badges[1] === "Most popular" && badges[2] === "Best value",
    "Q1: badges = none / b2 (volume.most_popular, v27) on the middle tier / b3 (volume.best_value) on the last",
  );
  ok(
    cards[0].getAttribute("aria-checked") === "true" &&
      cards[0].getAttribute("tabindex") === "0" &&
      cards[1].getAttribute("aria-checked") === "false",
    "Q1: the theme's own active pill (the first) is mirrored as the selection",
  );
  const now = cards.map((c) => c.querySelector(".cx-qsel__now").textContent);
  ok(now[0] === "€67.00", "Q1: 1-unit card shows the plain total (got " + now[0] + ")");
  ok(now[1] === "€56.95 each", "Q1: 2-unit per-unit price (got " + now[1] + ")");
  ok(now[2] === "€53.60 each", "Q1: 3-unit per-unit price (got " + now[2] + ")");
  const was1 = cards[1].querySelector(".cx-qsel__was");
  ok(!!was1 && was1.textContent === "€67.00 each", "Q1: struck 1-unit baseline on tier 2");
  ok(!cards[0].querySelector(".cx-qsel__was"), "Q1: no struck price on the baseline card");
  const saves = cards.map((c) => {
    const s = c.querySelector(".cx-qsel__save");
    return s ? s.textContent : "";
  });
  ok(
    saves[0] === "" && saves[1] === "Save €20.10" && saves[2] === "Save €40.20",
    "Q1: save chips computed from the REAL prices (got: " + saves.join(" | ") + ")",
  );
  const imgs2 = cards[1].querySelector(".cx-qsel__imgs");
  ok(
    imgs2.querySelectorAll(".cx-qsel__img").length === 2 &&
      (" " + imgs2.className + " ").indexOf(" cx-qsel__imgs--n2 ") !== -1,
    "Q1: 2-unit tier fans two copies of the product shot",
  );
  ok(
    cards[2].querySelector(".cx-qsel__imgs").querySelectorAll(".cx-qsel__img").length === 3,
    "Q1: 3-unit tier fans three",
  );
  ok(
    ctx.beacons.length === 1 &&
      ctx.beacons[0][0] === "quantity_selector" &&
      ctx.beacons[0][1] === "impression",
    "Q1: exactly one impression beacon after a successful mount",
  );
  // Singleton: a second mount call must not duplicate the widget.
  call(ctx, "qselMount");
  ok(
    ctx.doc.querySelectorAll(".cx-qsel").length === 1,
    "Q1: remount is a no-op (singleton + idempotency marker)",
  );

  // ---------------------------------------- Q2: relay + keyboard behavior
  cards[1]._fire("click");
  ok(
    page.buttons[1]._clicks === 1,
    "Q2: a card tap relays ONE native click to the matching theme button",
  );
  ok(
    cards[1].getAttribute("aria-checked") === "true" &&
      cards[0].getAttribute("aria-checked") === "false" &&
      cards[1].getAttribute("tabindex") === "0" &&
      cards[0].getAttribute("tabindex") === "-1",
    "Q2: selection restyles (roving tabindex + aria-checked)",
  );
  ok(
    ctx.beacons.length === 2 &&
      ctx.beacons[1][1] === "click" &&
      ctx.beacons[1][2] === "q2",
    "Q2: click beacon carries the q<units> meta",
  );
  cards[1]._fire("click");
  ok(
    page.buttons[1]._clicks === 1 && ctx.beacons.length === 2,
    "Q2: re-selecting the selected card is a no-op (no relay, no beacon)",
  );
  const group = root.querySelector(".cx-qsel__list");
  let prevented = 0;
  group._fire("keydown", { key: "ArrowDown", preventDefault: () => prevented++ });
  ok(
    cards[2].getAttribute("aria-checked") === "true" &&
      page.buttons[2]._clicks === 1 &&
      prevented === 1,
    "Q2: ArrowDown moves the selection and relays",
  );
  group._fire("keydown", { key: "Home", preventDefault: () => prevented++ });
  ok(
    cards[0].getAttribute("aria-checked") === "true" && page.buttons[0]._clicks === 1,
    "Q2: Home selects the first tier",
  );
  group._fire("keydown", { key: "a", preventDefault: () => prevented++ });
  ok(prevented === 2, "Q2: unrelated keys pass through untouched");
}

// ---------------------------------------------------- Q3: live/draft gating

{
  // Live off, no preview: nothing renders, nothing hidden, no beacon.
  const ctx = makeContext();
  const page = makePicker(ctx, IDS);
  const d = euro(LIVE_VARIANTS);
  d.live = false;
  ctx.sandbox.cfg = { qs: d };
  call(ctx, "qselMount");
  ok(
    !ctx.doc.querySelector(".cx-qsel") &&
      page.wrap.className.indexOf("cx-qsel-src") === -1 &&
      ctx.beacons.length === 0,
    "Q3: live=false without preview renders nothing and touches nothing",
  );
  // Draft flag inside a verified preview session: renders.
  vm.runInContext(
    "PREVIEW = { flags: { quantity_selector: true }, live: {}, market: 'x' }; qselMounted = false;",
    ctx.sandbox,
  );
  call(ctx, "qselMount");
  ok(
    !!ctx.doc.querySelector(".cx-qsel"),
    "Q3: the armed draft flag renders inside a verified preview session",
  );
  // Absent member fails closed even in preview.
  const ctx2 = makeContext();
  makePicker(ctx2, IDS);
  ctx2.sandbox.cfg = {};
  vm.runInContext("PREVIEW = { flags: { quantity_selector: true }, live: {} };", ctx2.sandbox);
  call(ctx2, "qselMount");
  ok(!ctx2.doc.querySelector(".cx-qsel"), "Q3: no island member = nothing, preview included");
}

// -------------------------------------------------- Q4: bail + honesty gates

{
  // Button-count mismatch (theme drift): bail before hiding anything.
  const ctx = makeContext();
  const page = makePicker(ctx, IDS.slice(0, 2));
  ctx.sandbox.cfg = { qs: euro(LIVE_VARIANTS) };
  call(ctx, "qselMount");
  ok(
    !ctx.doc.querySelector(".cx-qsel") && page.wrap.className.indexOf("cx-qsel-src") === -1,
    "Q4: count mismatch bails, pills untouched",
  );
}
{
  // Id mismatch: same count, different ids.
  const ctx = makeContext();
  const page = makePicker(ctx, ["1", "2", "3"]);
  ctx.sandbox.cfg = { qs: euro(LIVE_VARIANTS) };
  call(ctx, "qselMount");
  ok(
    !ctx.doc.querySelector(".cx-qsel") && page.wrap.className.indexOf("cx-qsel-src") === -1,
    "Q4: id mismatch bails, pills untouched (mapping is by id, never index)",
  );
}
{
  // Multi-option product: two option groups.
  const ctx = makeContext();
  makePicker(ctx, IDS, { extraWrap: true });
  ctx.sandbox.cfg = { qs: euro(LIVE_VARIANTS) };
  call(ctx, "qselMount");
  ok(!ctx.doc.querySelector(".cx-qsel"), "Q4: multi-option product keeps the theme picker");
}
{
  // Fewer than 2 variants.
  const ctx = makeContext();
  makePicker(ctx, IDS.slice(0, 1));
  ctx.sandbox.cfg = { qs: euro(LIVE_VARIANTS.slice(0, 1)) };
  call(ctx, "qselMount");
  ok(!ctx.doc.querySelector(".cx-qsel"), "Q4: a single variant renders nothing");
}
{
  // No 1-unit baseline (first variant parses as 2): totals only, no claims.
  const ctx = makeContext();
  makePicker(ctx, IDS.slice(0, 2));
  ctx.sandbox.cfg = {
    qs: euro([
      { id: IDS[0], t: "2 Jars", p: 11390, im: "//c/x.jpg" },
      { id: IDS[1], t: "3 Jars", p: 16080, im: "//c/x.jpg" },
    ]),
  };
  call(ctx, "qselMount");
  const root = ctx.doc.querySelector(".cx-qsel");
  ok(!!root, "Q4: no-baseline product still mounts");
  ok(
    root &&
      !root.querySelector(".cx-qsel__was") &&
      !root.querySelector(".cx-qsel__save") &&
      root.querySelectorAll(".cx-qsel__now")[0].textContent === "€113.90",
    "Q4: without a 1-unit baseline every card shows its plain total (no fabricated claims)",
  );
}
{
  // "30ml"-shaped titles: leading number out of range = no unit math.
  const ctx = makeContext();
  makePicker(ctx, IDS.slice(0, 2));
  ctx.sandbox.cfg = {
    qs: euro([
      { id: IDS[0], t: "30ml", p: 5700, im: "//c/x.jpg" },
      { id: IDS[1], t: "50ml", p: 7700, im: "//c/x.jpg" },
    ]),
  };
  call(ctx, "qselMount");
  const root = ctx.doc.querySelector(".cx-qsel");
  ok(
    !!root && !root.querySelector(".cx-qsel__was") && !root.querySelector(".cx-qsel__save"),
    "Q4: ml-sized variants never get per-unit math (qty parse fails closed)",
  );
  ok(
    root && root.querySelectorAll(".cx-qsel__name")[0].textContent === "30ml",
    "Q4: ml titles render verbatim",
  );
}
{
  // A tier that does NOT actually discount (each >= baseline): no claims.
  const ctx = makeContext();
  makePicker(ctx, IDS.slice(0, 2));
  ctx.sandbox.cfg = {
    qs: euro([
      { id: IDS[0], t: "1 Jar", p: 6700, im: "//c/x.jpg" },
      { id: IDS[1], t: "2 Jars - 15% Off", p: 14000, im: "//c/x.jpg" },
    ]),
  };
  call(ctx, "qselMount");
  const root = ctx.doc.querySelector(".cx-qsel");
  const second = root && root.querySelectorAll(".cx-qsel__card")[1];
  ok(
    !!second &&
      !second.querySelector(".cx-qsel__was") &&
      !second.querySelector(".cx-qsel__save") &&
      second.querySelector(".cx-qsel__now").textContent === "€140.00",
    "Q4: a tier priced ABOVE the baseline shows its total, never a per-unit claim",
  );
}

// ------------------------------------------------------- Q5: money machinery

{
  const ctx = makeContext();
  const fm = (c, f) => call(ctx, "qselFormatMoney", c, f);
  ok(fm(11390, "€{{amount}}") === "€113.90", "Q5: amount");
  ok(fm(1234567, "{{amount_with_comma_separator}} zł") === "12.345,67 zł", "Q5: comma separator");
  ok(fm(500, "¥{{amount_no_decimals}}") === "¥5", "Q5: no decimals");
  ok(fm(1234567, "CHF {{amount_with_apostrophe_separator}}") === "CHF 12'345.67", "Q5: apostrophe");
  ok(
    fm(11390, "<span class=money>{{amount}}</span> kr") === "113.90 kr",
    "Q5: HTML stripped from the format (textContent-safe)",
  );
  ok(fm(11390, "no placeholder") === "", "Q5: sentinel-less format fails closed");
  const d = { mf: "€{{amount}}" };
  ok(call(ctx, "qselMoney", 11390, d) === "€113.90", "Q5: qselMoney uses the twin when the theme helper is absent");
  ctx.sandbox.window.formatMoney = function (cents, f) {
    return "<b>THEME " + cents + "</b>";
  };
  ok(
    call(ctx, "qselMoney", 11390, d) === "€113.90",
    "Q5: the TWIN wins even when the theme helper exists — the live theme's formatMoney ignores placeholder semantics (verified live 2026-09-18)",
  );
  ok(
    call(ctx, "qselMoney", 11390, { mf: "{{amount_futuristic}} kr" }) === "THEME 11390",
    "Q5: an unknown placeholder falls through to the theme helper (tags stripped)",
  );
  ctx.sandbox.window.formatMoney = undefined;
  const intl = call(ctx, "qselMoney", 6700, {});
  ok(
    typeof intl === "string" && intl.indexOf("67") !== -1,
    "Q5: no format at all falls back to Intl in the active currency (got " + intl + ")",
  );
}

// ---------------------------------------------------- Q6: strings + locales

{
  const ctx = makeContext();
  ok(call(ctx, "qselLocale", { l: "pt-PT" }) === "pt-PT", "Q6: exact locale hit");
  ok(call(ctx, "qselLocale", { l: "pt" }) === "pt-PT", "Q6: base-language scan finds the regional pack");
  ok(call(ctx, "qselLocale", { l: "zh" }) === "en", "Q6: unknown language falls back to en");
  ok(call(ctx, "qselLocale", {}) === "en", "Q6: missing l falls back to en");
  ok(
    call(ctx, "qselTpl", { l: "fr" }, "each", "56,95 €") === "56,95 € l'unité",
    "Q6: French per-unit composition",
  );
  ok(
    call(ctx, "qselTpl", { l: "ja" }, "save", "¥1,234") === "¥1,234お得",
    "Q6: Japanese save composition (amount-leading)",
  );
  ok(
    call(ctx, "qselTpl", { l: "de" }, "each", "56,95 €") === "je 56,95 €",
    "Q6: German je-form leads with the word",
  );
  ok(call(ctx, "qselQty", "2 Jars - 15% Off") === 2, "Q6: qty parses the leading integer");
  ok(call(ctx, "qselQty", "123 pack") === 0, "Q6: 3-digit leading numbers are rejected whole");
  ok(call(ctx, "qselQty", "Jar") === 0, "Q6: no digits = no qty");
  ok(call(ctx, "qselLabel", "2 Jars – 15% Off") === "2 Jars", "Q6: en-dash suffix stripped too");
  ok(call(ctx, "qselLabel", "Duo Pack") === "Duo Pack", "Q6: suffix-less titles pass verbatim");
}

// -------------------------------------- Q8: v26.1 free-shipping micro-line

{
  // Threshold between tier 1 and tier 2 (the live-store shape): tags land
  // on tiers 2 and 3 only, in the name column.
  const ctx = makeContext();
  makePicker(ctx, IDS);
  const d = euro(LIVE_VARIANTS);
  d.fst = 10000;
  ctx.sandbox.cfg = { qs: d };
  call(ctx, "qselMount");
  const root = ctx.doc.querySelector(".cx-qsel");
  const ships = [].map.call(root.querySelectorAll(".cx-qsel__card"), (c) => {
    const s = c.querySelector(".cx-qsel__ship-label");
    return s ? s.textContent : "";
  });
  ok(
    ships[0] === "" && ships[1] === "Free shipping" && ships[2] === "Free shipping",
    "Q8: tag only on tiers whose OWN price clears the threshold (got: " + ships.join(" | ") + ")",
  );
  ok(
    root.querySelectorAll(".cx-qsel__ship").length === 2,
    "Q8: exactly two ship lines for the live-store threshold shape",
  );
}
{
  // No fst member (sub-flag off, or no safe per-market amount): no tags.
  const ctx = makeContext();
  makePicker(ctx, IDS);
  ctx.sandbox.cfg = { qs: euro(LIVE_VARIANTS) };
  call(ctx, "qselMount");
  ok(
    ctx.doc.querySelectorAll(".cx-qsel__ship").length === 0,
    "Q8: fst absent = no tag anywhere (fail closed)",
  );
}
{
  // Threshold above every tier (the lip-stick shape): no tags — the line
  // must never promise what checkout will not honor.
  const ctx = makeContext();
  makePicker(ctx, IDS);
  const d = euro(LIVE_VARIANTS);
  d.fst = 99000;
  ctx.sandbox.cfg = { qs: d };
  call(ctx, "qselMount");
  ok(
    ctx.doc.querySelectorAll(".cx-qsel__ship").length === 0,
    "Q8: a threshold no tier reaches shows no tag (honesty over nudging)",
  );
}
{
  // Threshold below tier 1: every tier qualifies, every tier says so —
  // tagging only 2/3 would imply tier 1 pays shipping, which would be
  // false. Localized label rides the same table.
  const ctx = makeContext();
  makePicker(ctx, IDS);
  const d = euro(LIVE_VARIANTS);
  d.l = "fr";
  d.fst = 5000;
  ctx.sandbox.cfg = { qs: d };
  call(ctx, "qselMount");
  const labels = [].map.call(
    ctx.doc.querySelectorAll(".cx-qsel__ship-label"),
    (s) => s.textContent,
  );
  ok(
    labels.length === 3 && labels.every((t) => t === "Livraison gratuite"),
    "Q8: below-baseline threshold tags every tier, native label (got: " + labels.join(" | ") + ")",
  );
}

// -------------------------------- U: v27 unit-type mapping + plural forms

{
  // A mapped product composes its labels from the catalog, overriding the
  // variant titles entirely (this fixture's titles still say "Jars").
  const ctx = makeContext();
  makePicker(ctx, IDS);
  const d = euro(LIVE_VARIANTS);
  d.u = "syringe";
  ctx.sandbox.cfg = { qs: d };
  call(ctx, "qselMount");
  const names = [].map.call(
    ctx.doc.querySelectorAll(".cx-qsel__name"),
    (n) => n.textContent,
  );
  ok(
    names[0] === "1 Syringe" && names[1] === "2 Syringes" && names[2] === "3 Syringes",
    "U: mapped unit overrides the variant-title labels (got: " + names.join(" | ") + ")",
  );
}
{
  const ctx = makeContext();
  const label = (l, u, n) =>
    call(ctx, "qselUnitLabel", { u, l }, { t: n + " x", p: 1 });
  ok(label("pl", "syringe", 1) === "1 Strzykawka", "U: pl one");
  ok(label("pl", "syringe", 2) === "2 Strzykawki", "U: pl few (2-4)");
  ok(label("pl", "syringe", 5) === "5 Strzykawek", "U: pl many (5+)");
  ok(label("ar", "jar", 1) === "عبوة واحدة", "U: ar one (word form, no digit)");
  ok(label("ar", "jar", 2) === "عبوتان", "U: ar dual (no digit)");
  ok(label("ar", "jar", 3) === "3 عبوات", "U: ar few");
  ok(label("fi", "tube", 1) === "1 Tuubi", "U: fi nominative");
  ok(label("fi", "tube", 2) === "2 Tuubia", "U: fi numeral partitive");
  ok(label("hu", "syringe", 3) === "3 fecskendő", "U: hu numeral takes the singular");
  ok(label("ja", "stick", 2) === "スティック2本", "U: ja counter form");
  ok(label("ro", "syringe", 2) === "2 Seringi", "U: ro few");
  ok(label("pt-PT", "jar", 3) === "3 Boiões", "U: pt-PT plural");
  ok(label("de", "jar", 2) === "2 Tiegel", "U: de invariant plural");
  // Fallbacks: unresolvable = null, the card keeps the title label.
  ok(call(ctx, "qselUnitLabel", { l: "en" }, { t: "2 Jars", p: 1 }) === null, "U: no mapping = null");
  ok(
    call(ctx, "qselUnitLabel", { u: "vial", l: "en" }, { t: "2 Jars", p: 1 }) === null,
    "U: unknown unit = null (never a broken string)",
  );
  ok(
    call(ctx, "qselUnitLabel", { u: "jar", l: "en" }, { t: "Jar", p: 1 }) === null,
    "U: unparseable count = null",
  );
}
{
  // Catalog integrity: 18 locales x 7 units, category sets per plural rule,
  // {n} in every digit-bearing form, no em/en dashes anywhere.
  const ctx = makeContext();
  const units = vm.runInContext("CX_QSEL_UNITS", ctx.sandbox);
  const locales = Object.keys(units);
  ok(locales.length === 18, "U: catalog covers 18 locales (got " + locales.length + ")");
  const UNIT_KEYS = ["jar", "syringe", "tube", "dropper", "stick", "pump", "bottle"];
  const CATS = {
    pl: ["one", "few", "many"],
    ro: ["one", "few"],
    ar: ["one", "two", "few"],
    hu: ["other"],
    ja: ["other"],
  };
  for (const loc of locales) {
    const expected = CATS[loc] || ["one", "other"];
    for (const unit of UNIT_KEYS) {
      const forms = units[loc] && units[loc][unit];
      ok(!!forms, "U: " + loc + "." + unit + " present");
      if (!forms) continue;
      ok(
        Object.keys(forms).sort().join(",") === expected.slice().sort().join(","),
        "U: " + loc + "." + unit + " carries exactly the " + expected.join("/") + " forms",
      );
      for (const [cat, form] of Object.entries(forms)) {
        const digitless = loc === "ar" && (cat === "one" || cat === "two");
        ok(
          digitless ? form.indexOf("{n}") === -1 : form.indexOf("{n}") !== -1,
          "U: " + loc + "." + unit + "." + cat + " {n} rule",
        );
        ok(!/[—–]/.test(form), "U: " + loc + "." + unit + "." + cat + " dash-free");
      }
    }
  }
}

// ------------------------------------------------------------- Q7: images

{
  const ctx = makeContext();
  const imgsFor = (v, q) => call(ctx, "qselImgs", v, q);
  const vi = imgsFor({ im: "//c/2jars.jpg", vi: 1 }, 3);
  ok(
    vi.querySelectorAll(".cx-qsel__img").length === 1 &&
      (" " + vi.className + " ").indexOf(" cx-qsel__imgs--n1 ") !== -1,
    "Q7: a variant-specific image shows alone (the merchant's own render wins)",
  );
  const capped = imgsFor({ im: "//c/x.jpg" }, 5);
  ok(
    capped.querySelectorAll(".cx-qsel__img").length === 3,
    "Q7: the fan caps at three copies",
  );
  const none = imgsFor({}, 2);
  ok(
    (" " + none.className + " ").indexOf(" cx-qsel__imgs--n0 ") !== -1 &&
      none.querySelectorAll(".cx-qsel__img").length === 0,
    "Q7: no image = collapsed cell",
  );
  const evil = imgsFor({ im: "javascript:alert(1)" }, 2);
  ok(
    evil.querySelectorAll(".cx-qsel__img").length === 0,
    "Q7: only https/protocol-relative CDN urls are accepted",
  );
  const https = imgsFor({ im: "https://cdn.shopify.com/x.jpg" }, 2);
  ok(https.querySelectorAll(".cx-qsel__img").length === 2, "Q7: absolute https accepted");
}

// --------------------------------------------------------------- summary

console.log(
  failures === 0
    ? `ALL ${checks} CHECKS PASSED (v26 quantity selector vs the real cellexia-pdp.js module)`
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
        // Dropping the allowed-gate would leak draft/live-off renders.
        name: "m1-gate-dropped",
        find: "    return !!d && pdpMemberAllowed(d, 'quantity_selector');",
        replace: "    return !!d;",
      },
      {
        // Index pairing instead of id pairing silently mis-wires tiers the
        // moment the theme reorders — the id-mismatch bail proves the map.
        name: "m2-index-pairing",
        find: "        var pair = byId[String(v.id)];",
        replace: "        var pair = btns[i];",
      },
      {
        // The per-unit honesty gate: a tier priced at or above the baseline
        // must never wear per-unit framing.
        name: "m3-honesty-gate-dropped",
        find: "      // Honesty gate: per-unit framing only when it is a real discount.\n      if (!(each < base)) each = 0;",
        replace: "      // Honesty gate: per-unit framing only when it is a real discount.",
      },
      {
        // The relay IS the feature contract — without it the theme never
        // learns about the selection.
        name: "m4-relay-dropped",
        find: "      try { picked.btn.click(); } catch (e) { /* noop */ }",
        replace: "      ",
      },
      {
        // The suffix strip is the anti-confusion rule (several suffixes
        // overstate the real discount).
        name: "m5-suffix-kept",
        find: "    var cut = t.search(/\\s+[-–—]\\s+/);",
        replace: "    var cut = -1;",
      },
      {
        // Without the trim, the theme's trailing-newline leak breaks the
        // id map and the selector never mounts on the LIVE markup.
        name: "m6-trim-dropped",
        find: "      id = id.replace(/^\\s+|\\s+$/g, '');",
        replace: "      ",
      },
      {
        // Swapped separators would corrupt every comma-locale price.
        name: "m7-money-separators-swapped",
        find: "      case 'amount_with_comma_separator': value = delim(cents, 2, '.', ','); break;",
        replace: "      case 'amount_with_comma_separator': value = delim(cents, 2, ',', '.'); break;",
      },
      {
        // The impression is the analytics denominator for the feature.
        name: "m8-impression-dropped",
        find: "      qselMounted = true;\n      track('quantity_selector');",
        replace: "      qselMounted = true;",
      },
      {
        // Dropping the Polish branch degrades 2-6 to a bare singular
        // ("2 Strzykawka") through the one-form fallback.
        name: "m11-plural-map-flattened",
        find: "    if (base === 'pl') return n === 1 ? 'one' : n >= 2 && n <= 4 ? 'few' : 'many';",
        replace: "    if (base === 'pl') return n === 1 ? 'one' : 'one';",
      },
      {
        // The mapping must actually override the title labels.
        name: "m12-unit-mapping-ignored",
        find: "    name.textContent = qselUnitLabel(d, v) || qselLabel(v.t);",
        replace: "    name.textContent = qselLabel(v.t);",
      },
      {
        // Dropping the per-tier price comparison would tag EVERY tier the
        // moment any threshold exists — a false claim on low tiers.
        name: "m9-ship-threshold-ignored",
        find: "    if (typeof d.fst === 'number' && d.fst > 0 && typeof v.p === 'number' && v.p >= d.fst) {",
        replace: "    if (typeof d.fst === 'number' && d.fst > 0) {",
      },
      {
        // A flipped comparison tags the CHEAP tiers instead.
        name: "m10-ship-comparison-flipped",
        find: "typeof v.p === 'number' && v.p >= d.fst) {",
        replace: "typeof v.p === 'number' && v.p < d.fst) {",
      },
    ],
  });
  if (bad > 0) {
    console.log(`\n${bad} MUTANT(S) NOT CAUGHT (quantity-selector)`);
    process.exitCode = 1;
  }
}
