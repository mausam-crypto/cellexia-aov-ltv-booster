/**
 * v19 buy-box proof block sim — runs the REAL block builders extracted from
 * extensions/cellexia-booster/assets/cellexia-pdp.js (vm + brace-balanced
 * function extraction, the house convention: never a re-implementation).
 *
 * Proves the merchant-facing contract of the block:
 *   A. ORDER + COMPOSITION — with everything supplied, the in-panel node
 *      carries exactly ships / delivery / badges / guarantee / rating in the
 *      design's order, and the research band is a SECOND node inserted after
 *      .pdp__grey (not inside it);
 *   B. FAIL-CLOSED — no member, no settings payload (a metafield written
 *      before v19), block not live, no anchor: nothing renders and nothing
 *      beacons. A row whose fact is missing drops out ALONE, never taking
 *      the block with it;
 *   C. GRAMMAR — the ships line only renders with an INFLECTED country form
 *      from the shared AZ_SHIPS_FORMS table ("z Polski", "der Schweiz"), and
 *      the sentence is rebuilt around the @@C@@ sentinel so each language
 *      keeps its own word order (RTL included). No form -> no row;
 *   D. BORROWED FACTS — badges/guarantee/rating read the SHARED island
 *      members (the block stores no second copy of a label, a day count or
 *      a rating), unknown badge keys drop, free_shipping_over drops without
 *      a safe amount, and the merchant's badge ORDER is preserved;
 *   E. RESEARCH BAND — uploaded logos take the single row with rules
 *      (--row), text wordmarks stack, blank names drop, and an all-blank
 *      band with the seal off renders nothing;
 *   F. BEACON HONESTY — exactly ONE buy_box_proof impression however many
 *      pieces painted, and none at all when nothing painted;
 *   G. PREVIEW — a draft flag renders the block for a verified preview
 *      session exactly as live would.
 *
 * SCOPE NOTE: the delivery DATE engine has its own suites
 * (sims/delivery-businessdays, sims/us-state-delivery, sims/native-dates);
 * here deliveryConfig/Compute/FormatDate/T are documented stubs so these
 * checks isolate the ROW (sentinel split, guarantee pill, the dl gate).
 * cxIcon degrades to an empty text node (mini-dom does not parse
 * innerHTML), and bbpBuiltInSeal is stubbed for the same reason — the seal
 * markup is a static constant guarded by the harness innerHTML rules.
 *
 * MUTATION TESTS (all must be CAUGHT):
 *   m1-ships-bare-name    grammar table ignored -> ungrammatical bare name
 *   m2-delivery-ignores-dl  hidden-country/excluded verdict ignored
 *   m3-badge-fs-gate      free_shipping_over shown without a safe amount
 *   m4-blank-name-painted blank institution name renders an empty cell
 *   m5-beacon-per-piece   one beacon per painted piece instead of per block
 *   m6-conf-not-required  a null settings payload still renders
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { extractFunction, extractVar } = require("./lib/extract.cjs");
const { makeDocument, El, textNode } = require("./lib/mini-dom.cjs");

const REAL_SRC = path.join(
  __dirname, "..", "..",
  "extensions", "cellexia-booster", "assets", "cellexia-pdp.js",
);
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;
const SRC = fs.readFileSync(SRC_PATH, "utf8");

let checks = 0;
let failures = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.log(`FAIL: ${label}`); }
}

const FNS = [
  "insertAfter",
  "cxEl",
  "cxSp",
  "cxIcon",
  "cxRawStr",
  "bottleStr",
  "badgeIconNode",
  "cxStarsSvgs",
  "cxStarsNode",
  "cxStarIcon",
  "azPageLocale",
  "pdpMember",
  "pdpMemberAllowed",
  "bbpData",
  "bbpConf",
  "bbpAllowed",
  "bbpEffective",
  "bbpLocale",
  "bbpShipsPhrase",
  "bbpSplitRow",
  "bbpShipsRow",
  "bbpDeliveryRow",
  "bbpBadgeRow",
  "bbpGuaranteeCard",
  "bbpRatingRow",
  "bbpSealNode",
  // v19.2: the runtime balances each logo cell to equal optical area once
  // the image's natural size is known.
  "bbpBalanceLogo",
  // v28: the award strip (curated 18-locale copy, closed category catalog,
  // one-row proportional fit).
  "bbpAwardLocale",
  "bbpAwardTpl",
  "bbpAwardFit",
  "bbpAwardNode",
  "bbpResearchNode",
  "bbpBuildRows",
  // v22: mountBbp tags the impression with which URL-gated pieces painted.
  "bbpGateMeta",
  "bbpAwardWatch",
  "mountBbp",
  // v29 split: the band and the strip are their own features with their
  // own members, mounts and beacons; mountBbp keeps a LEGACY branch for a
  // pre-v29 metafield (no rb/aw member).
  "rbData",
  "awData",
  "rbBandConf",
  "awBuildConf",
  "mountResearchBand",
  "mountAwardStrip",
];
const EXTRACTED = [
  extractVar(SRC, "CX_AZ_ICONS"),
  extractVar(SRC, "AZ_SHIPS_FORMS"),
  extractVar(SRC, "BBP_DATE_SENTINEL"),
  extractVar(SRC, "BBP_COUNTRY_SENTINEL"),
  extractVar(SRC, "CX_BBP_AWARD"),
  ...FNS.map((n) => extractFunction(SRC, n)),
].join("\n\n");

// ------------------------------------------------------------------ page
function makePage() {
  const doc = makeDocument();
  const info = new El("div");
  info.setAttribute("class", "pdp__info");
  const grey = new El("div");
  grey.setAttribute("class", "pdp__grey");
  const actions = new El("div");
  actions.setAttribute("class", "pdp__actions--flex");
  const stockMsg = new El("p");
  stockMsg.setAttribute("class", "stock-msg");
  grey.appendChild(actions);
  grey.appendChild(stockMsg);
  info.appendChild(grey);
  const accordions = new El("div");
  accordions.setAttribute("class", "pdp__accordions");
  info.appendChild(accordions);
  doc.body.appendChild(info);
  return { doc, info, grey, stockMsg, accordions };
}

const STRINGS = {
  "delivery.line": "Get it by @@DATE@@",
  "delivery.badge": "Delivery guarantee",
};

function baseConf(over) {
  return Object.assign({
    enabled: true,
    showShipsFrom: true,
    showDelivery: true,
    showDeliveryBadge: true,
    badges: ["secure_checkout", "dermatologist_tested", "cruelty_free", "easy_returns"],
    showGuarantee: true,
    showRating: true,
    research: {
      enabled: true,
      institutions: [
        { name: "Harvard Medical School", imageUrl: "" },
        { name: "University of Oxford", imageUrl: "" },
        { name: "The Lancet", imageUrl: "" },
      ],
    },
    seal: { enabled: true, imageUrl: "" },
    // v28: the award strip's DEFAULT_SETTINGS mirror — OFF, gateless.
    award: { enabled: false, gate: "", rank: 1, count: 100, category: "wrinkle", publication: "Verbraucher Berichte", imageUrl: "", year: 2026 },
  }, over || {});
}

// The award strip enabled with the shipped defaults (the reference mock).
function awardOn(over) {
  return Object.assign({ enabled: true, gate: "", rank: 1, count: 100, category: "wrinkle", publication: "Verbraucher Berichte", imageUrl: "", year: 2026 }, over || {});
}

function baseCfg(over) {
  const cfg = {
    market: "poland",
    delivery: { pageLocale: "en" },
    badges: {
      live: false,
      k: ["secure_checkout"],
      fs: true,
      l: ["Secure checkout", "Free shipping over 150,00 zł", "60-day money-back guarantee", "Dermatologist tested", "Cruelty free", "Clinically proven", "SSL-encrypted payment", "Easy returns"],
    },
    g: { live: false, t: "60-Day Money-Back Guarantee" },
    tp: { live: false, aria: "Rated 4.7 out of 5", label: "4.7/5", r: 4.7, cnt: "4619 reviews on", view: "See our reviews on Trustpilot", url: "https://www.trustpilot.com/review/cellexia.com", link: true },
    bbp: { live: true, c: baseConf(), dl: true, sf: "PL", sfs: "Ships from @@C@@", rs: "Based on published research from" },
  };
  return Object.assign(cfg, over || {});
}

function run(cfg, opts) {
  opts = opts || {};
  const page = makePage();
  const tracked = [];
  const metas = [];
  const sandbox = {
    document: page.doc,
    window: { Intl },
    Intl,
    JSON,
    console,
    cfg: cfg,
    PREVIEW: opts.preview || null,
    AZ_CFG: opts.azCfg || null,
    track: (k, _t, m) => { tracked.push(k); metas.push(m === undefined ? null : m); },
    // The gate module is proven by sims/param-gates; here every gate is
    // LOCKED so the render-side guards and per-feature meta are testable.
    cxGateOpen: () => false,
    decodeEntities: (s) => s, // sim strings carry no HTML entities
    // Delivery DATE engine: proven by its own suites. Here it is a fixed,
    // documented stub so these checks isolate the ROW composition.
    deliveryConfig: () => (opts.deliveryBroken ? null : { pageLocale: "en" }),
    deliveryCompute: () => ({ dispatch: 1, min: 2, max: 3 }),
    deliveryFormatDate: () => (opts.noDate ? "" : "Friday, September 11"),
    deliveryT: (key, params) => {
      let str = STRINGS[key] || "";
      if (str && params) {
        Object.keys(params).forEach((p) => {
          str = str.split("@@" + p.toUpperCase() + "@@").join(String(params[p]));
        });
      }
      return str;
    },
    // mini-dom stores innerHTML verbatim (no parsing), so the static seal
    // constant cannot produce a child here. The harness innerHTML rules
    // guard that markup; this stub keeps the BAND checks meaningful.
    bbpBuiltInSeal: () => {
      const el = new El("svg");
      el.setAttribute("class", "cx-bbp-research__seal-art");
      return el;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox, { filename: "extracted-bbp-module.js" });
  // The real init() order: rows/legacy first, then the band, then the
  // strip (which unshifts ahead of the band under the panel).
  vm.runInContext("mountBbp(); mountResearchBand(); mountAwardStrip();", sandbox);
  return { page, sandbox, tracked, metas };
}

// mini-dom's El.textContent already walks children (and returns _text for
// a leaf), so the node's own getter is the whole story.
const textOf = (node) => (node ? String(node.textContent || "") : "");
// mini-dom images carry no natural size and never fire load, so
// bbpBalanceLogo's apply() is a documented no-op here: the AREA maths is
// verified in the browser against the real files, this suite verifies that
// balancing never breaks the build (a throw would lose the whole band).
// The piece each child of the block root IS, by its own identifying class
// (children carry a shared modifier class too — cx-bbp__row, list-reset).
const PIECE_CLASSES = ["cx-bbp__ships", "cx-bbp__deliver", "cx-bbp__badges", "cx-bbp__guarantee", "cx-bbp__rating"];
const rowClasses = (root) =>
  root
    ? root.children.map((c) => {
        const list = (c.getAttribute("class") || "").split(/\s+/);
        return PIECE_CLASSES.find((p) => list.indexOf(p) !== -1) || list.join(".");
      })
    : [];

// ------------------------------------------------------- A. composition
{
  const { page, tracked } = run(baseCfg());
  const rows = page.doc.querySelector(".cx-bbp");
  ok(!!rows, "A1 the in-panel block mounts");
  ok(rows && rows.parentNode === page.grey, "A1 rows live INSIDE .pdp__grey");
  ok(
    rows && rows.getAttribute("data-cx-feature") === "buy_box_proof",
    "A1 rows root carries the feature marker",
  );
  ok(
    JSON.stringify(rowClasses(rows)) ===
      JSON.stringify(["cx-bbp__ships", "cx-bbp__deliver", "cx-bbp__badges", "cx-bbp__guarantee", "cx-bbp__rating"]),
    `A2 design order: ships, delivery, badges, guarantee, rating (got ${JSON.stringify(rowClasses(rows))})`,
  );
  const band = page.doc.querySelector(".cx-bbp-research");
  ok(!!band, "A3 the research band mounts");
  ok(band && band.parentNode === page.info, "A3 band is a SIBLING of .pdp__grey, not inside it");
  ok(
    page.grey.childNodes.indexOf(rows) > page.grey.childNodes.indexOf(page.stockMsg),
    "A4 rows are chained AFTER .stock-msg",
  );
  ok(
    page.info.childNodes.indexOf(band) === page.info.childNodes.indexOf(page.grey) + 1,
    "A4 band sits directly after the grey panel, above the accordions",
  );
  ok(tracked.join(",") === "buy_box_proof", `F1 exactly one beacon for the whole block (got ${tracked.join(",")})`);
}

// ------------------------------------------------------- B. fail closed
{
  const noMember = run(baseCfg({ bbp: undefined }));
  ok(noMember.page.doc.querySelector(".cx-bbp") === null, "B1 no island member: nothing renders");
  ok(noMember.tracked.length === 0, "B1 no beacon");

  const notLive = run(baseCfg({ bbp: { live: false, c: baseConf(), dl: true, sf: "PL", sfs: "Ships from @@C@@", rs: "x" } }));
  ok(notLive.page.doc.querySelector(".cx-bbp") === null, "B2 member present but not live: nothing renders");
  ok(notLive.tracked.length === 0, "B2 no beacon");

  const nullConf = run(baseCfg({ bbp: { live: true, c: null, dl: true, sf: "PL", sfs: "Ships from @@C@@", rs: "x" } }));
  ok(nullConf.page.doc.querySelector(".cx-bbp") === null, "B3 pre-v19 metafield (no settings payload): nothing renders");
  ok(nullConf.tracked.length === 0, "B3 no beacon");

  // No anchor at all: graceful no-op, and the research band never lands
  // on its own (the block is one unit anchored on the buy panel).
  const page = makePage();
  page.grey.parentNode.removeChild(page.grey);
  const tracked = [];
  const sandbox = {
    document: page.doc, window: { Intl }, Intl, JSON, console,
    cfg: baseCfg(), PREVIEW: null, AZ_CFG: null,
    track: (k) => tracked.push(k), decodeEntities: (s) => s,
    deliveryConfig: () => ({ pageLocale: "en" }),
    deliveryCompute: () => ({ dispatch: 1, min: 2, max: 3 }),
    deliveryFormatDate: () => "Friday, September 11",
    deliveryT: (k) => STRINGS[k] || "",
    bbpBuiltInSeal: () => new El("svg"),
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox, { filename: "extracted-bbp-module.js" });
  vm.runInContext("mountBbp()", sandbox);
  ok(page.doc.querySelector(".cx-bbp") === null, "B4 missing buy panel: graceful no-op");
  ok(page.doc.querySelector(".cx-bbp-research") === null, "B4 the band does not mount on its own");
  ok(tracked.length === 0, "B4 no beacon");
}

// ---------------------------------------------------------- C. grammar
{
  const pl = run(baseCfg());
  const ships = pl.page.doc.querySelector(".cx-bbp__ships");
  ok(!!ships, "C1 ships row renders with a mapped warehouse");
  ok(textOf(ships) === "Ships from Poland", `C1 English form (got "${textOf(ships)}")`);

  // Polish page: the table's inflected form, never the bare nominative.
  const plPage = baseCfg();
  plPage.delivery.pageLocale = "pl";
  plPage.bbp.sfs = "Wysyłka @@C@@";
  const inflected = run(plPage);
  ok(
    textOf(inflected.page.doc.querySelector(".cx-bbp__ships")) === "Wysyłka z Polski",
    `C2 Polish uses the inflected form (got "${textOf(inflected.page.doc.querySelector(".cx-bbp__ships"))}")`,
  );
  const strong = inflected.page.doc.querySelector(".cx-bbp__ships strong");
  ok(!!strong && textOf(strong) === "z Polski", "C2 the country phrase is the emphasised half");

  // Sentinel-leading sentence (the country opens the line) still splits.
  const lead = baseCfg();
  lead.bbp.sfs = "@@C@@ から発送";
  lead.delivery.pageLocale = "ja";
  const jp = run(lead);
  ok(textOf(jp.page.doc.querySelector(".cx-bbp__ships")) === "ポーランド から発送", "C3 sentinel-leading sentence splits correctly");

  // No inflected form (warehouse outside the table) -> NO row, and the
  // rest of the block still renders.
  const unknown = baseCfg();
  unknown.bbp.sf = "ZW";
  const none = run(unknown);
  ok(none.page.doc.querySelector(".cx-bbp__ships") === null, "C4 unmapped warehouse: ships row drops");
  ok(none.page.doc.querySelector(".cx-bbp__rating") !== null, "C4 the rest of the block still renders");
  ok(none.tracked.join(",") === "buy_box_proof", "C4 the block still beacons once");

  // A sentence with no sentinel is unusable -> row drops (never a
  // sentence with the country silently missing).
  const noSentinel = baseCfg();
  noSentinel.bbp.sfs = "Ships from our warehouse";
  ok(run(noSentinel).page.doc.querySelector(".cx-bbp__ships") === null, "C5 sentinel-less sentence: row drops");

  // Row switch off.
  const off = baseCfg();
  off.bbp.c = baseConf({ showShipsFrom: false });
  ok(run(off).page.doc.querySelector(".cx-bbp__ships") === null, "C6 showShipsFrom false: row drops");
}

// ---------------------------------------------------- D. borrowed facts
{
  const base = run(baseCfg());
  const deliver = base.page.doc.querySelector(".cx-bbp__deliver");
  ok(textOf(deliver).indexOf("Get it by Friday, September 11") === 0, "D1 delivery sentence rebuilt around the date sentinel");
  ok(!!base.page.doc.querySelector(".cx-bbp__pill"), "D1 the delivery-guarantee pill rides the row");
  ok(textOf(base.page.doc.querySelector(".cx-bbp__pill")) === "Delivery guarantee", "D1 pill text from delivery.badge");

  const noPill = baseCfg();
  noPill.bbp.c = baseConf({ showDeliveryBadge: false });
  ok(run(noPill).page.doc.querySelector(".cx-bbp__pill") === null, "D2 showDeliveryBadge false: pill drops, row stays");
  ok(run(noPill).page.doc.querySelector(".cx-bbp__deliver") !== null, "D2 the date row stays");

  const hidden = baseCfg();
  hidden.bbp.dl = false;
  ok(run(hidden).page.doc.querySelector(".cx-bbp__deliver") === null, "D3 dl false (country hidden / product excluded): row drops");

  ok(run(baseCfg(), { noDate: true }).page.doc.querySelector(".cx-bbp__deliver") === null, "D4 no formattable date: row drops (never a vague promise)");
  ok(run(baseCfg(), { deliveryBroken: true }).page.doc.querySelector(".cx-bbp__deliver") === null, "D4 invalid delivery config: row drops");

  // Badges: merchant order, index-aligned shared labels, unknown keys out.
  const badges = base.page.doc.querySelector(".cx-bbp__badges");
  ok(
    badges && badges.children.map((li) => textOf(li)).join("|") === "Secure checkout|Dermatologist tested|Cruelty free|Easy returns",
    `D5 badge labels + merchant order from the SHARED member (got "${badges && badges.children.map((li) => textOf(li)).join("|")}")`,
  );
  const reordered = baseCfg();
  reordered.bbp.c = baseConf({ badges: ["easy_returns", "secure_checkout", "nonsense_key"] });
  const rr = run(reordered).page.doc.querySelector(".cx-bbp__badges");
  ok(
    rr && rr.children.map((li) => textOf(li)).join("|") === "Easy returns|Secure checkout",
    "D6 order preserved, unknown key dropped",
  );
  const fsCfg = baseCfg();
  fsCfg.bbp.c = baseConf({ badges: ["free_shipping_over", "cruelty_free"] });
  fsCfg.badges.fs = false;
  const fsRow = run(fsCfg).page.doc.querySelector(".cx-bbp__badges");
  ok(fsRow && fsRow.children.map((li) => textOf(li)).join("|") === "Cruelty free", "D7 free_shipping_over drops without a safe amount");
  const noneCfg = baseCfg();
  noneCfg.bbp.c = baseConf({ badges: [] });
  ok(run(noneCfg).page.doc.querySelector(".cx-bbp__badges") === null, "D8 no badge keys: strip drops");
  const noBadgeMember = baseCfg();
  noBadgeMember.badges = undefined;
  ok(run(noBadgeMember).page.doc.querySelector(".cx-bbp__badges") === null, "D9 no shared badge member: strip drops (no invented labels)");

  // Guarantee + rating read their shared members.
  ok(textOf(base.page.doc.querySelector(".cx-bbp__guarantee-title")) === "60-Day Money-Back Guarantee", "D10 guarantee title from the shared g member");
  const noG = baseCfg();
  noG.g = undefined;
  ok(run(noG).page.doc.querySelector(".cx-bbp__guarantee") === null, "D10 no g member: card drops");
  ok(textOf(base.page.doc.querySelector(".cx-bbp__score")) === "4.7/5", "D11 score from the shared tp member");
  ok(textOf(base.page.doc.querySelector(".cx-bbp__count")) === "4619 reviews on", "D11 review count from the shared tp member");
  const link = base.page.doc.querySelector(".cx-bbp__brand-link");
  ok(!!link && link.getAttribute("href") === "https://www.trustpilot.com/review/cellexia.com", "D11 the review link rides the shared URL");
  const noLink = baseCfg();
  noLink.tp = Object.assign({}, noLink.tp, { link: false });
  ok(run(noLink).page.doc.querySelector(".cx-bbp__brand-link") === null, "D12 showLink false: no link, row stays");
  ok(run(noLink).page.doc.querySelector(".cx-bbp__rating") !== null, "D12 rating row stays");
  const noTp = baseCfg();
  noTp.tp = undefined;
  ok(run(noTp).page.doc.querySelector(".cx-bbp__rating") === null, "D13 no tp member: rating row drops");

  // v30 rating-row size: bbpRatingRow writes the `--cxtp` custom property
  // ONLY when the conf asks for MORE than 100% — a pre-v30 conf (no key,
  // the base fixture), 100 itself, junk and anything below leave the style
  // attribute off entirely (byte-identical DOM), and the factor caps at 2.
  ok(base.page.doc.querySelector(".cx-bbp__rating").getAttribute("style") === null, "D14 pre-v30 conf (no ratingScale): no inline style — byte-identical DOM");
  const scaled = baseCfg();
  scaled.bbp.c = baseConf({ ratingScale: 130 });
  ok(run(scaled).page.doc.querySelector(".cx-bbp__rating").getAttribute("style") === "--cxtp:1.3", "D14 ratingScale 130 -> --cxtp:1.3");
  const atHundred = baseCfg();
  atHundred.bbp.c = baseConf({ ratingScale: 100 });
  ok(run(atHundred).page.doc.querySelector(".cx-bbp__rating").getAttribute("style") === null, "D14 ratingScale 100: no inline style");
  const below = baseCfg();
  below.bbp.c = baseConf({ ratingScale: 80 });
  ok(run(below).page.doc.querySelector(".cx-bbp__rating").getAttribute("style") === null, "D14 ratingScale below 100: no inline style");
  const junkScale = baseCfg();
  junkScale.bbp.c = baseConf({ ratingScale: "big" });
  ok(run(junkScale).page.doc.querySelector(".cx-bbp__rating").getAttribute("style") === null, "D14 junk ratingScale: no inline style");
  const hugeScale = baseCfg();
  hugeScale.bbp.c = baseConf({ ratingScale: 999 });
  ok(run(hugeScale).page.doc.querySelector(".cx-bbp__rating").getAttribute("style") === "--cxtp:2", "D14 ratingScale 999 caps at --cxtp:2");

  // v30.1 Trustpilot display rounding: the star IMAGE snaps to the nearest
  // half star while label/aria keep the raw score — the base 4.7 paints
  // 4.5 (fifth star a 50% gradient, never the raw 70%), and 4.8 paints
  // five FULL stars, exactly like trustpilot.com. A full star's gradient
  // carries TWO offset="100%" stops, so five full stars = ten of them.
  const starsHtml = base.page.doc.querySelector(".cx-stars").innerHTML;
  ok(starsHtml.indexOf('offset="50%"') !== -1 && starsHtml.indexOf('offset="70%"') === -1, "D15 r=4.7 snaps to 4.5: fifth star 50%, never 70%");
  const rFull = baseCfg();
  rFull.tp = Object.assign({}, rFull.tp, { r: 4.8 });
  const fullHtml = run(rFull).page.doc.querySelector(".cx-stars").innerHTML;
  ok(fullHtml.split('offset="100%"').length === 11, "D15 r=4.8 snaps to 5: five FULL stars (ten 100% stops)");
}

// --------------------------------------------------------- E. research
{
  const wordmarks = run(baseCfg()).page.doc.querySelector(".cx-bbp-research__logos");
  ok(!!wordmarks, "E1 wordmark band renders");
  ok(
    (wordmarks.getAttribute("class") || "").indexOf("cx-bbp-research__logos--row") === -1,
    "E1 text wordmarks do NOT take the single-row modifier (they stack)",
  );
  ok(wordmarks.children.length === 3, "E1 three institutions");

  const withLogos = baseCfg();
  withLogos.bbp.c = baseConf({
    research: {
      enabled: true,
      institutions: [
        { name: "Harvard Medical School", imageUrl: "https://cdn.shopify.com/a.png" },
        { name: "University of Oxford", imageUrl: "https://cdn.shopify.com/b.png" },
        { name: "The Lancet", imageUrl: "https://cdn.shopify.com/c.png" },
      ],
    },
  });
  const logoRun = run(withLogos);
  const logoList = logoRun.page.doc.querySelector(".cx-bbp-research__logos");
  ok(
    (logoList.getAttribute("class") || "").indexOf("cx-bbp-research__logos--row") !== -1,
    "E2 uploaded logos take the single row with rules (the design's band)",
  );
  const img = logoRun.page.doc.querySelector(".cx-bbp-research__logo-img");
  ok(!!img && img.getAttribute("src") === "https://cdn.shopify.com/a.png", "E2 the merchant's file is rendered verbatim");
  ok(!!img && img.getAttribute("alt") === "Harvard Medical School", "E2 the name is the image alt");

  // Mixed: one wordmark among logos keeps the stacking layout (a wrapped
  // rule reads as a rendering bug).
  const mixed = baseCfg();
  mixed.bbp.c = baseConf({
    research: { enabled: true, institutions: [
      { name: "Harvard Medical School", imageUrl: "https://cdn.shopify.com/a.png" },
      { name: "The Lancet", imageUrl: "" },
    ] },
  });
  ok(
    (run(mixed).page.doc.querySelector(".cx-bbp-research__logos").getAttribute("class") || "").indexOf("--row") === -1,
    "E3 a mixed band stacks",
  );

  const blank = baseCfg();
  blank.bbp.c = baseConf({
    research: { enabled: true, institutions: [{ name: "", imageUrl: "https://cdn.shopify.com/a.png" }, { name: "The Lancet", imageUrl: "" }] },
  });
  const blankRun = run(blank);
  ok(blankRun.page.doc.querySelector(".cx-bbp-research__logos").children.length === 1, "E4 a blank name is dropped, never an empty cell");

  const researchOff = baseCfg();
  researchOff.bbp.c = baseConf({ research: { enabled: false, institutions: [{ name: "The Lancet", imageUrl: "" }] } });
  const ro = run(researchOff);
  ok(ro.page.doc.querySelector(".cx-bbp-research__logos") === null, "E5 research off: no logos");
  ok(ro.page.doc.querySelector(".cx-bbp-research__seal") !== null, "E5 the seal survives on its own");

  const nothing = baseCfg();
  nothing.bbp.c = baseConf({ research: { enabled: false, institutions: [] }, seal: { enabled: false, imageUrl: "" } });
  const nb = run(nothing);
  ok(nb.page.doc.querySelector(".cx-bbp-research") === null, "E6 nothing to say: the whole band drops");
  ok(nb.page.doc.querySelector(".cx-bbp") !== null, "E6 the in-panel rows still render");
  ok(nb.tracked.join(",") === "buy_box_proof", "F2 one beacon for a rows-only block");

  const sealImg = baseCfg();
  sealImg.bbp.c = baseConf({ seal: { enabled: true, imageUrl: "https://cdn.shopify.com/seal.png" } });
  const si = run(sealImg).page.doc.querySelector(".cx-bbp-research__seal-img");
  ok(!!si && si.getAttribute("src") === "https://cdn.shopify.com/seal.png", "E7 a merchant seal file replaces the built-in artwork");
  // The seal is artwork that carries its own wording, so it is decorative:
  // an empty alt, and no caption anywhere in the band.
  ok(!!si && si.getAttribute("alt") === "", "E7 a merchant seal file is decorative (empty alt)");
  const bandNow = run(baseCfg()).page.doc.querySelector(".cx-bbp-research");
  ok(bandNow.querySelector(".cx-bbp-research__note") === null, "E8 the band paints no caption");
  ok(!/DermaCert Certified|Independent testing/.test(textOf(bandNow)), "E8 no retired caption copy survives in the band");
  // Marks and seal are DIRECT children of the band: the two-column media
  // query styles `.cx-bbp-research > .cx-bbp-research__seal`, so a wrapper
  // between them would silently drop the layout back to stacked.
  const kids = [].slice.call(bandNow.children).map((n) => n.getAttribute("class") || "");
  ok(kids.length === 2 && /__col/.test(kids[0]) && /__seal/.test(kids[1]),
     "E8 the band has exactly two children: marks column then seal");
  ok(textOf(run(baseCfg()).page.doc.querySelector(".cx-bbp-research__eyebrow")) === "Based on published research from", "E8 the eyebrow is the translated string");
}

// -------------------------------------------- E9. equal-optical-area maths
{
  // bbpBalanceLogo is what stops a 9:1 wordmark rendering a third of the
  // height of a 3:1 lockup beside it. mini-dom images have no natural size,
  // so drive it with the REAL measured dimensions of the merchant's files.
  const { sandbox } = run(baseCfg());
  const grow = (nw, nh) => {
    const li = { style: {} };
    const img = { naturalWidth: nw, naturalHeight: nh, complete: true, addEventListener() {} };
    sandbox.bbpBalanceLogo(li, img);
    return Number(li.style.flexGrow);
  };
  const harvard = grow(1024, 268);   // 3.82:1
  const oxford = grow(1280, 378);    // 3.39:1
  const lancet = grow(3840, 421);    // 9.12:1
  ok(Math.abs(harvard - Math.sqrt(1024 / 268)) < 0.002, `E9 grow is sqrt(ratio) for Harvard (got ${harvard})`);
  ok(Math.abs(lancet - Math.sqrt(3840 / 421)) < 0.002, `E9 grow is sqrt(ratio) for The Lancet (got ${lancet})`);
  ok(lancet > harvard && harvard > oxford, "E9 the widest mark gets the widest cell");
  // The contract: width_i proportional to grow_i, height_i = width_i / r_i,
  // so area_i = grow_i^2 / r_i is EQUAL for every mark.
  const area = (g, r) => (g * g) / r;
  const a1 = area(harvard, 1024 / 268);
  const a2 = area(oxford, 1280 / 378);
  const a3 = area(lancet, 3840 / 421);
  ok(Math.abs(a1 - a2) < 0.002 && Math.abs(a1 - a3) < 0.002,
    `E9 every mark covers the SAME optical area (${a1.toFixed(3)} / ${a2.toFixed(3)} / ${a3.toFixed(3)})`);
  // Degenerate inputs must leave the equal-cell default rather than throw.
  const liBad = { style: {} };
  sandbox.bbpBalanceLogo(liBad, { naturalWidth: 0, naturalHeight: 0, complete: true, addEventListener() {} });
  ok(liBad.style.flexGrow === undefined, "E9 an unmeasured image keeps the equal-cell default");
}

// ------------------------------------------------------ AW. award strip
{
  // AW1 — the default config ships the strip OFF: nothing paints, and the
  // rest of the block is exactly as before v28.
  const off = run(baseCfg());
  ok(off.page.doc.querySelector(".cx-bbp-award") === null, "AW1 default config: the strip is absent");

  // AW2 — enabled with the shipped defaults: the reference-mock content in
  // English, wordmark cell, year beneath.
  const onCfg = baseCfg();
  onCfg.bbp.c = baseConf({ award: awardOn() });
  const on = run(onCfg);
  const strip = on.page.doc.querySelector(".cx-bbp-award");
  ok(!!strip, "AW2 enabled: the strip mounts");
  ok(strip && strip.getAttribute("data-cx-feature") === "buy_box_proof", "AW2 the strip carries the block's feature marker");
  ok(textOf(strip && strip.querySelector(".cx-bbp-award__rank")) === "#1", "AW2 the medallion is the English '#1'");
  ok(
    textOf(strip && strip.querySelector(".cx-bbp-award__l1")) === "Rated #1 of 100+ wrinkle treatments",
    `AW2 line 1 composes rank, count and the curated category (got "${textOf(strip && strip.querySelector(".cx-bbp-award__l1"))}")`,
  );
  ok(textOf(strip && strip.querySelector(".cx-bbp-award__l2")) === "in independent lab testing", "AW2 line 2 is the curated method line");
  ok(textOf(strip && strip.querySelector(".cx-bbp-award__pub-name")) === "Verbraucher Berichte", "AW2 the publication renders as written (proper noun)");
  ok(strip && strip.querySelector(".cx-bbp-award__bar") !== null, "AW2 the built-in lockup carries the reference's colour bar");
  ok(strip && strip.querySelector(".cx-bbp-award__bar").getAttribute("aria-hidden") === "true", "AW2 the bar is decorative");
  ok(textOf(strip && strip.querySelector(".cx-bbp-award__year")) === "2026", "AW2 the year is its own fourth cell");
  ok(strip && strip.querySelector(".cx-bbp-award__rank").getAttribute("aria-hidden") === "true", "AW2 the medallion is decorative (line 1 already states the rank)");

  // AW3 — design order: .pdp__grey, then the strip, then the research band.
  const kids = on.page.info.children.map((c) => c.getAttribute("class") || "");
  const iGrey = kids.findIndex((c) => /pdp__grey/.test(c));
  const iAward = kids.findIndex((c) => /cx-bbp-award/.test(c));
  const iBand = kids.findIndex((c) => /cx-bbp-research/.test(c));
  ok(
    iGrey !== -1 && iAward === iGrey + 1 && iBand === iAward + 1,
    `AW3 order under the panel is grey, award strip, research band (got ${kids.join(" | ")})`,
  );
  ok(on.tracked.join(",") === "buy_box_proof", "AW3 still exactly one beacon for the whole block");

  // AW4 — fail closed on every leg.
  const noPub = baseCfg();
  noPub.bbp.c = baseConf({ award: awardOn({ publication: "" }) });
  ok(run(noPub).page.doc.querySelector(".cx-bbp-award") === null, "AW4 no named publication: no strip (no source, no claim)");
  const badCat = baseCfg();
  badCat.bbp.c = baseConf({ award: awardOn({ category: "unicorns" }) });
  ok(run(badCat).page.doc.querySelector(".cx-bbp-award") === null, "AW4 unknown category key: no strip (never half a sentence)");
  const badRank = baseCfg();
  badRank.bbp.c = baseConf({ award: awardOn({ rank: 0 }) });
  ok(run(badRank).page.doc.querySelector(".cx-bbp-award") === null, "AW4 a non-positive rank: no strip");
  const preV28 = baseCfg();
  preV28.bbp.c = baseConf();
  delete preV28.bbp.c.award;
  ok(run(preV28).page.doc.querySelector(".cx-bbp-award") === null, "AW4 a pre-v28 mirror (no award key): no strip");
  ok(run(preV28).page.doc.querySelector(".cx-bbp") !== null, "AW4 and the rest of the block is untouched");

  // AW5 — an uploaded mark replaces the wordmark; the name becomes alt.
  const withLogo = baseCfg();
  withLogo.bbp.c = baseConf({ award: awardOn({ imageUrl: "https://cdn.shopify.com/vb.png" }) });
  const logoRun = run(withLogo);
  const mark = logoRun.page.doc.querySelector(".cx-bbp-award__pub-img");
  ok(!!mark && mark.getAttribute("src") === "https://cdn.shopify.com/vb.png", "AW5 the merchant's mark is rendered verbatim");
  ok(!!mark && mark.getAttribute("alt") === "Verbraucher Berichte", "AW5 the publication name is the mark's alt");
  ok(logoRun.page.doc.querySelector(".cx-bbp-award__pub-name") === null, "AW5 no wordmark beside the mark");
  ok(logoRun.page.doc.querySelector(".cx-bbp-award__bar") === null, "AW5 the uploaded mark replaces the WHOLE lockup, colour bar included");

  // AW6 — the strip stands alone: research off, seal off, still one strip
  // and one beacon (the band is absent, not the strip).
  const alone = baseCfg();
  alone.bbp.c = baseConf({
    research: { enabled: false, institutions: [] },
    seal: { enabled: false, imageUrl: "" },
    award: awardOn(),
  });
  const aloneRun = run(alone);
  ok(aloneRun.page.doc.querySelector(".cx-bbp-award") !== null, "AW6 the strip renders without the research band");
  ok(aloneRun.page.doc.querySelector(".cx-bbp-research") === null, "AW6 the band stays absent");
  ok(aloneRun.tracked.join(",") === "buy_box_proof", "AW6 one beacon");

  // AW7 — locale composition: Japanese puts the category FIRST and counts
  // with 種類 (the {c}/{n}/{r} template is order-free), and the medallion
  // takes the locale's own short form.
  const ja = baseCfg({ delivery: { pageLocale: "ja" } });
  ja.bbp.c = baseConf({ award: awardOn() });
  const jaRun = run(ja);
  ok(
    textOf(jaRun.page.doc.querySelector(".cx-bbp-award__l1")) === "シワケア製品100種類以上の中で第1位",
    `AW7 Japanese line 1 (got "${textOf(jaRun.page.doc.querySelector(".cx-bbp-award__l1"))}")`,
  );
  ok(textOf(jaRun.page.doc.querySelector(".cx-bbp-award__rank")) === "1位", "AW7 Japanese medallion");

  // AW8 — a medallion form longer than three characters takes the --wide
  // modifier instead of overflowing the circle (German "Nr.1" is four,
  // "Nr.10" five; the English "#1" stays at full size).
  const de = baseCfg({ delivery: { pageLocale: "de" } });
  de.bbp.c = baseConf({ award: awardOn({ rank: 10 }) });
  const deRun = run(de);
  const medal = deRun.page.doc.querySelector(".cx-bbp-award__rank");
  ok(textOf(medal) === "Nr.10", "AW8 German medallion form");
  ok(!!medal && /cx-bbp-award__rank--wide/.test(medal.getAttribute("class") || ""), "AW8 five characters take the --wide modifier");
  const enShort = baseCfg();
  enShort.bbp.c = baseConf({ award: awardOn() });
  const enMedal = run(enShort).page.doc.querySelector(".cx-bbp-award__rank");
  ok(!!enMedal && !/--wide/.test(enMedal.getAttribute("class") || ""), "AW8 the two-character '#1' does not");

  // AW9 — a missing year (a hand-edited mirror) drops the year line alone.
  const noYear = baseCfg();
  noYear.bbp.c = baseConf({ award: awardOn() });
  delete noYear.bbp.c.award.year;
  const noYearRun = run(noYear);
  ok(noYearRun.page.doc.querySelector(".cx-bbp-award") !== null, "AW9 the strip survives a missing year");
  ok(noYearRun.page.doc.querySelector(".cx-bbp-award__year") === null, "AW9 the year line drops alone");
}

// ------------------------------------------------- V. v29 feature split
// The band and the strip as their OWN features: own island members ("rb"
// / "aw"), own live + draft flags, own markers and own beacons. baseCfg
// above is deliberately the LEGACY island (old nested config, no rb/aw
// member): every A-G check therefore also proves the deploy-gap path.
function splitBandSection(over) {
  return Object.assign({
    enabled: true,
    showResearch: true,
    gate: "",
    institutions: [
      { name: "Harvard Medical School", imageUrl: "" },
      { name: "University of Oxford", imageUrl: "" },
      { name: "The Lancet", imageUrl: "" },
    ],
    seal: { enabled: true, gate: "", imageUrl: "" },
  }, over || {});
}

function splitCfg(over) {
  // The v29 island: rows-only bbp config, the band and the strip in their
  // own members ("rs" rides both bbp — legacy — and rb).
  const cfg = baseCfg();
  cfg.bbp.c = {
    enabled: true,
    showShipsFrom: true,
    showDelivery: true,
    showDeliveryBadge: true,
    badges: ["secure_checkout", "dermatologist_tested", "cruelty_free", "easy_returns"],
    showGuarantee: true,
    showRating: true,
  };
  cfg.rb = { live: true, c: splitBandSection(), rs: "Based on published research from" };
  cfg.aw = { live: true, c: awardOn() };
  return Object.assign(cfg, over || {});
}

{
  // V1 — all three live: rows in the panel, then strip, then band; the
  // pieces carry their OWN feature markers and each feature beacons once.
  const all = run(splitCfg());
  ok(all.page.doc.querySelector(".cx-bbp") !== null, "V1 rows render from the rows-only config");
  const band = all.page.doc.querySelector(".cx-bbp-research");
  const strip = all.page.doc.querySelector(".cx-bbp-award");
  ok(!!band && band.getAttribute("data-cx-feature") === "research_band", "V1 the band carries its OWN feature marker");
  ok(!!strip && strip.getAttribute("data-cx-feature") === "award_strip", "V1 the strip carries its OWN feature marker");
  const kids = all.page.info.children.map((c) => c.getAttribute("class") || "");
  const iGrey = kids.findIndex((c) => /pdp__grey/.test(c));
  const iAward = kids.findIndex((c) => /cx-bbp-award/.test(c));
  const iBand = kids.findIndex((c) => /cx-bbp-research/.test(c));
  ok(iGrey !== -1 && iAward === iGrey + 1 && iBand === iAward + 1,
    `V1 design order holds across features: grey, strip, band (got ${kids.join(" | ")})`);
  ok(all.tracked.slice().sort().join(",") === "award_strip,buy_box_proof,research_band",
    `V1 one beacon per FEATURE (got ${all.tracked.join(",")})`);
  ok(all.metas[all.tracked.indexOf("buy_box_proof")] === null,
    "V1 the rows beacon carries no gate meta in the split model");

  // V2 — independence from the proof block: rows OFF, band + strip still
  // render and beacon; buy_box_proof stays silent.
  const noRows = splitCfg();
  noRows.bbp.live = false;
  const nr = run(noRows);
  ok(nr.page.doc.querySelector(".cx-bbp") === null, "V2 proof block off: no rows");
  ok(nr.page.doc.querySelector(".cx-bbp-research") !== null, "V2 the band renders without the proof block");
  ok(nr.page.doc.querySelector(".cx-bbp-award") !== null, "V2 the strip renders without the proof block");
  ok(nr.tracked.slice().sort().join(",") === "award_strip,research_band",
    `V2 only the two features that painted beacon (got ${nr.tracked.join(",")})`);

  // V2b — and each is gated by its OWN live flag.
  const bandOff = splitCfg();
  bandOff.rb.live = false;
  ok(run(bandOff).page.doc.querySelector(".cx-bbp-research") === null, "V2b band not live: no band");
  ok(run(bandOff).page.doc.querySelector(".cx-bbp-award") !== null, "V2b the strip is unaffected");
  const stripOff = splitCfg();
  stripOff.aw.live = false;
  ok(run(stripOff).page.doc.querySelector(".cx-bbp-award") === null, "V2b strip not live: no strip");
  ok(run(stripOff).page.doc.querySelector(".cx-bbp-research") !== null, "V2b the band is unaffected");

  // V3 — showResearch=false keeps the seal-only band (the pre-v29
  // research.enabled semantics, carried by the sub-flag).
  const sealOnly = splitCfg();
  sealOnly.rb.c = splitBandSection({ showResearch: false });
  const so = run(sealOnly);
  ok(so.page.doc.querySelector(".cx-bbp-research__col") === null, "V3 showResearch off: no institution column");
  ok(so.page.doc.querySelector(".cx-bbp-research__seal") !== null, "V3 the seal survives on its own");

  // V4 — PREVIEWABLE SEPARATELY (the point of the split): a verified
  // preview session with ONLY the band's draft flag renders the band and
  // nothing else; only the strip's flag renders the strip alone. Beacons
  // are suppressed by track() in preview, exactly like every feature.
  const dark = splitCfg();
  dark.bbp.live = false;
  dark.rb.live = false;
  dark.aw.live = false;
  const bandPrev = run(dark, { preview: { live: {}, flags: { research_band: true }, market: "poland" } });
  ok(bandPrev.page.doc.querySelector(".cx-bbp-research") !== null, "V4 band draft flag alone: the band previews");
  ok(bandPrev.page.doc.querySelector(".cx-bbp-award") === null, "V4 ...without the strip");
  ok(bandPrev.page.doc.querySelector(".cx-bbp") === null, "V4 ...and without the proof block");
  const stripPrev = run(dark, { preview: { live: {}, flags: { award_strip: true }, market: "poland" } });
  ok(stripPrev.page.doc.querySelector(".cx-bbp-award") !== null, "V4 strip draft flag alone: the strip previews");
  ok(stripPrev.page.doc.querySelector(".cx-bbp-research") === null, "V4 ...without the band");

  // V5 — a draft preview of a NOT-yet-enabled strip still renders: the
  // enabled flag IS the feature flag in the split model, so the builder's
  // strict check is satisfied by awBuildConf once the draft gate passed.
  const darkOff = splitCfg();
  darkOff.bbp.live = false;
  darkOff.rb.live = false;
  darkOff.aw.live = false;
  darkOff.aw.c = awardOn({ enabled: false });
  ok(
    run(darkOff, { preview: { live: {}, flags: { award_strip: true }, market: "poland" } })
      .page.doc.querySelector(".cx-bbp-award") !== null,
    "V5 draft preview renders the strip even while its flag is still off",
  );

  // V6 — fail closed per feature: a member whose config is null (a
  // hand-edited mirror) paints nothing and beacons nothing.
  const nullBand = splitCfg();
  nullBand.rb.c = null;
  ok(run(nullBand).page.doc.querySelector(".cx-bbp-research") === null, "V6 null band config: nothing");
  const nullStrip = splitCfg();
  nullStrip.aw.c = null;
  ok(run(nullStrip).page.doc.querySelector(".cx-bbp-award") === null, "V6 null strip config: nothing");

  // V7 — the split island never double-renders through the legacy branch
  // (rb/aw present -> mountBbp leaves the pieces to their own mounts).
  const both = run(splitCfg());
  ok(both.page.doc.querySelectorAll(".cx-bbp-research").length === 1, "V7 exactly one band");
  ok(both.page.doc.querySelectorAll(".cx-bbp-award").length === 1, "V7 exactly one strip");

  // V8 — gate meta rides the OWNING feature's beacon now (every gate is
  // LOCKED via the cxGateOpen stub; the digest machinery has its own sim).
  const gated = splitCfg();
  // Institutions gated, seal ungated: the band still paints (seal), so
  // its beacon carries the control arm. The strip is all-or-nothing.
  gated.rb.c = splitBandSection({ gate: "br" });
  gated.aw.c = awardOn({ gate: "ba" });
  const gr = run(gated, { preview: { live: { research_band: true, award_strip: true, buy_box_proof: true }, flags: {}, market: "poland" } });
  ok(gr.page.doc.querySelector(".cx-bbp-research__col") !== null && gr.page.doc.querySelector(".cx-bbp-award") !== null,
    "V8 the Preview Center renders the gated pieces of both features");
  const liveGated = run(gated);
  ok(liveGated.page.doc.querySelector(".cx-bbp-research__col") === null,
    "V8 locked institutions do not paint outside preview");
  ok(liveGated.tracked.indexOf("research_band") !== -1 &&
    liveGated.metas[liveGated.tracked.indexOf("research_band")] === "g:",
    "V8 the partially locked band beacons the control arm under ITS OWN feature");
  ok(liveGated.tracked.indexOf("award_strip") === -1,
    "V8 a fully locked strip paints nothing and beacons nothing (impression honesty)");
}

// ---------------------------------------------------------- G. preview
{
  const draft = baseCfg();
  draft.bbp.live = false;
  const previewed = run(draft, { preview: { live: {}, flags: { buy_box_proof: true }, market: "poland" } });
  ok(previewed.page.doc.querySelector(".cx-bbp") !== null, "G1 draft flag renders the block in a verified preview session");
  ok(previewed.page.doc.querySelector(".cx-bbp-research") !== null, "G1 including the research band");
  ok(previewed.tracked.length === 0 || previewed.tracked.join(",") === "buy_box_proof", "G1 preview beacons are suppressed by track() itself");

  const noDraft = run(draft, { preview: { live: {}, flags: {}, market: "poland" } });
  ok(noDraft.page.doc.querySelector(".cx-bbp") === null, "G2 preview without the draft flag: still nothing (no leak)");
}

// ------------------------------------------------------------ static pins
{
  const pins = [
    ["data-cx-feature', 'buy_box_proof'", "the block carries its own feature marker"],
    ["if ((key === 'az_microcopy' || key === 'az_ships_from') && bbpEffective()) return false;", "azOn stands the two az patterns down"],
    ["if (bbpEffective()) return; // v19: the proof block renders the date row", "mountDelivery stands down"],
    ["var anchor = bbpEffective() ? null :", "the classic badge/guarantee/trustpilot chain stands down"],
    ["'.cx-bbp'", "the block is placed deliberately in AZ_BUYBOX_ORDER"],
  ];
  for (const [needle, why] of pins) {
    ok(SRC.includes(needle), `PIN ${why}`);
  }
}

if (failures === 0) {
  console.log(`ALL ${checks} CHECKS PASSED (v19 buy-box proof block vs the real cellexia-pdp.js builders)`);
} else {
  console.log(`\n${failures}/${checks} CHECKS FAILED`);
  process.exitCode = 1;
}

if (!process.env.CX_SKIP_MUTANTS && failures === 0) {
  const { runMutants } = require("./lib/mutants.cjs");
  const bad = runMutants({
    selfPath: __filename,
    srcPath: REAL_SRC,
    mutants: [
      {
        // The anchor MUST include the bbpLocale() line: azShipsForm carries
        // a byte-identical table lookup EARLIER in the file, and the mutant
        // runner replaces the FIRST occurrence only.
        name: "m1-ships-bare-name",
        find: "    var loc = bbpLocale();\n    if (!loc) return '';\n    var table = AZ_SHIPS_FORMS[loc] || AZ_SHIPS_FORMS[String(loc).split('-')[0]];\n    if (!table) return '';\n    var form = table[wh];\n    return typeof form === 'string' ? form : '';",
        replace: "    var loc = bbpLocale();\n    if (!loc) return '';\n    var table = AZ_SHIPS_FORMS[loc] || AZ_SHIPS_FORMS[String(loc).split('-')[0]];\n    if (!table) return '';\n    var form = table[wh];\n    return typeof form === 'string' ? form : wh;",
      },
      {
        name: "m2-delivery-ignores-dl",
        find: "if (conf.showDelivery === false || d.dl !== true) return null;",
        replace: "if (conf.showDelivery === false) return null;",
      },
      {
        name: "m3-badge-fs-gate",
        find: "if (key === 'free_shipping_over' && badges.fs !== true) continue; // no safe amount: skip",
        replace: "if (false) continue; // no safe amount: skip",
      },
      {
        name: "m4-blank-name-painted",
        find: "        var name = cxRawStr(item, 'name');\n        if (!name) continue;",
        replace: "        var name = cxRawStr(item, 'name');\n        if (false) continue;",
      },
      {
        name: "m5-beacon-per-piece",
        find: "      if (rows && insertAfter(rows, anchor)) painted = true;",
        replace: "      if (rows && insertAfter(rows, anchor)) { painted = true; track('buy_box_proof'); }",
      },
      {
        // Dropping the sqrt would size cells by raw ratio, over-correcting
        // the wide wordmark instead of balancing area — E9 catches it.
        name: "m7-balance-drops-sqrt",
        find: "li.style.flexGrow = String(Math.round(Math.sqrt(w / h) * 1000) / 1000);",
        replace: "li.style.flexGrow = String(Math.round((w / h) * 1000) / 1000);",
      },
      {
        name: "m6-conf-not-required",
        find: "      var conf = bbpConf(d);\n      if (!conf) return;",
        replace: "      var conf = bbpConf(d) || {};\n      if (!conf) return;",
      },
      {
        // v28: the strict default-OFF gate — losing it lights the strip on
        // every pre-v28 blob whose merged defaults carry content (AW1).
        name: "m8-award-default-on",
        find: "    if (!aw || aw.enabled !== true) return null;",
        replace: "    if (!aw) return null;",
      },
      {
        // v28: the strip must land BETWEEN the panel and the band (AW3;
        // the legacy branch is one level deeper since v29).
        name: "m9-award-not-first",
        find: "        var award = bbpAwardNode(conf);\n        if (award && insertAfter(award, grey)) painted = true;",
        replace: "        var award = bbpAwardNode(conf);\n        if (award && insertAfter(award, research || grey)) painted = true;",
      },
      {
        // v28: an unknown category must never render half a sentence (AW4).
        name: "m10-award-category-open",
        find: "    var cat = pack && pack.c && typeof pack.c[aw.category] === 'string' ? pack.c[aw.category] : '';",
        replace: "    var cat = pack && pack.c && typeof pack.c[aw.category] === 'string' ? pack.c[aw.category] : String(aw.category || '');",
      },
      {
        // v29: the band must gate on ITS OWN feature flag (V2b/V4).
        name: "m11-band-not-own-feature",
        find: "      if (!d || !pdpMemberAllowed(d, 'research_band')) return;",
        replace: "      if (!d) return;",
      },
      {
        // v29: the strip's own marker is the analytics identity (V1).
        name: "m12-strip-marker-lost",
        find: "      award.setAttribute('data-cx-feature', 'award_strip');",
        replace: "      ;",
      },
      {
        // v29: dropping the legacy branch dark-ships every pre-migration
        // shop (A3/AW2 run against the legacy island on purpose).
        // v30: dropping the >100 gate writes --cxtp:1 into every
        // explicit-100 row — the byte-identical default DOM guarantee dies.
        name: "m14-ratingscale-writes-at-100",
        find: "    if (isFinite(rs) && rs > 100) {",
        replace: "    if (isFinite(rs)) {",
      },
      {
        name: "m15-ratingscale-uncapped",
        find: "      if (rs > 200) rs = 200;",
        replace: "      ;",
      },
      {
        // v30.1: dropping the half-star snap paints the raw 70% partial
        // again — the Trustpilot-rule display dies.
        name: "m16-star-snap-dropped",
        find: "    r = Math.round(r * 2) / 2;",
        replace: "    ;",
      },
      {
        name: "m13-legacy-path-lost",
        find: "      if (!rbData() && !awData()) {",
        replace: "      if (false) {",
      },
    ],
  });
  if (bad > 0) {
    console.log(`\n${bad} MUTANT(S) NOT CAUGHT (buy-box-proof)`);
    process.exitCode = 1;
  } else {
    // (init's mountResearchBand-before-mountAwardStrip order cannot be
    // mutation-tested here — the sim drives the mounts itself — so the
    // harness v29 block pins the call sequence instead.)
    console.log("ALL 16 MUTANTS CAUGHT (buy-box-proof)");
  }
}
