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
  "bbpResearchNode",
  "bbpBuildRows",
  "mountBbp",
];
const EXTRACTED = [
  extractVar(SRC, "CX_AZ_ICONS"),
  extractVar(SRC, "AZ_SHIPS_FORMS"),
  extractVar(SRC, "BBP_DATE_SENTINEL"),
  extractVar(SRC, "BBP_COUNTRY_SENTINEL"),
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
  }, over || {});
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
    bbp: { live: true, c: baseConf(), dl: true, sf: "PL", sfs: "Ships from @@C@@", rs: "Based on published research from", sl: "Independent testing. Proven skin tolerance." },
  };
  return Object.assign(cfg, over || {});
}

function run(cfg, opts) {
  opts = opts || {};
  const page = makePage();
  const tracked = [];
  const sandbox = {
    document: page.doc,
    window: { Intl },
    Intl,
    JSON,
    console,
    cfg: cfg,
    PREVIEW: opts.preview || null,
    AZ_CFG: opts.azCfg || null,
    track: (k) => tracked.push(k),
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
  vm.runInContext("mountBbp()", sandbox);
  return { page, sandbox, tracked };
}

// mini-dom's El.textContent already walks children (and returns _text for
// a leaf), so the node's own getter is the whole story.
const textOf = (node) => (node ? String(node.textContent || "") : "");
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

  const notLive = run(baseCfg({ bbp: { live: false, c: baseConf(), dl: true, sf: "PL", sfs: "Ships from @@C@@", rs: "x", sl: "y" } }));
  ok(notLive.page.doc.querySelector(".cx-bbp") === null, "B2 member present but not live: nothing renders");
  ok(notLive.tracked.length === 0, "B2 no beacon");

  const nullConf = run(baseCfg({ bbp: { live: true, c: null, dl: true, sf: "PL", sfs: "Ships from @@C@@", rs: "x", sl: "y" } }));
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
  ok(!!si && si.getAttribute("alt") === "Independent testing. Proven skin tolerance.", "E7 the translated note is the seal alt text");
  ok(textOf(run(baseCfg()).page.doc.querySelector(".cx-bbp-research__note")) === "Independent testing. Proven skin tolerance.", "E8 the note is the translated string");
  ok(textOf(run(baseCfg()).page.doc.querySelector(".cx-bbp-research__eyebrow")) === "Based on published research from", "E8 the eyebrow is the translated string");
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
        name: "m6-conf-not-required",
        find: "      var conf = bbpConf(d);\n      if (!conf) return;",
        replace: "      var conf = bbpConf(d) || {};\n      if (!conf) return;",
      },
    ],
  });
  if (bad > 0) {
    console.log(`\n${bad} MUTANT(S) NOT CAUGHT (buy-box-proof)`);
    process.exitCode = 1;
  } else {
    console.log("ALL 6 MUTANTS CAUGHT (buy-box-proof)");
  }
}
