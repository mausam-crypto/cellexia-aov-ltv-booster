/**
 * v8.9 proof-band PLACEMENT sim — runs the REAL placement functions
 * (vm-extracted from cellexia-proof.js) against mini-DOM page shims.
 *
 * Contracts pinned:
 *   P1 three placements, stack present: above_proof before the stack,
 *      below_proof between stack and tabs, below_tabs after the tabs —
 *      independent of arrival order (all 6 permutations);
 *   P2 stack ABSENT: above_proof and below_proof both fall back to before
 *      the tabs, in RANK order regardless of which fetch resolved first
 *      (the v8.9 review's nondeterminism catch — pfSortBandRun);
 *   P3 home page (ctx brand): every placement key collapses to the single
 *      below_tabs band appended to #main — one band, fixed slot order
 *      (the v8.9 review's fragmentation catch — pfPlacementKey ctx gate);
 *   P4 no anchors at all: pfBandAt returns null (fail closed, nothing
 *      appended to <body>);
 *   P5 slots: every band carries the three fixed slots in
 *      press → endorsements → results order;
 *   H  (v8.15) press home anchor: a valid island "ha" yields the
 *      home_after key on brand ctx only (product ctx keeps pl; malformed
 *      ha collapses to below_tabs); the home_after band inserts right
 *      after the merchant-picked shopify-section wrapper; a missing
 *      section key falls back to the end-of-main chain; press band +
 *      default band coexist rank-ordered when adjacent.
 *
 * MUTATION TESTS (all must be CAUGHT):
 *   m1-sort-dropped        pfSortBandRun call removed (P2)
 *   m2-ctx-gate-dropped    pfPlacementKey ignores ctx (P3)
 *   m3-rank-flattened      PF_BAND_RANK collapses to one rank (P2)
 *   m4-home-anchor-dropped home_after never resolves its section (H)
 *   m5-ha-gate-dropped     pfPlacementKey ignores the ha member (H)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { extractAll } = require("./lib/extract.cjs");
const { makeDocument } = require("./lib/mini-dom.cjs");
const { runMutants } = require("./lib/mutants.cjs");

const REAL_SRC = path.join(
  __dirname, "..", "..",
  "extensions", "cellexia-booster", "assets", "cellexia-proof.js",
);
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;
const SRC = fs.readFileSync(SRC_PATH, "utf8");

let checks = 0, failures = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.error("FAIL: " + label); }
}

const EXTRACTED = extractAll(SRC, {
  vars: ["PF_SLOT_ORDER", "PF_BAND_RANK"],
  functions: [
    "pfInsertAfter", "pfPastCxSiblings", "pfNewBand", "pfBandBelowTabs",
    "pfHomeAnchorKey", "pfHomeSectionAnchor",
    "pfBandAt", "pfPlacementKey", "pfSortBandRun",
  ],
});

function makePage(kind) {
  const doc = makeDocument();
  const sandbox = { console, document: doc };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox);
  const main = doc.createElement("main");
  main.setAttribute("id", "main");
  doc.body.appendChild(main);
  if (kind === "pdp" || kind === "pdp-no-stack") {
    const pdp = doc.createElement("section");
    pdp.className = "pdp";
    main.appendChild(pdp);
    if (kind === "pdp") {
      const stack = doc.createElement("div");
      stack.className = "cx-proof-stack container container--md";
      main.appendChild(stack);
    }
    const tabs = doc.createElement("section");
    tabs.className = "pdp__tabs";
    main.appendChild(tabs);
  }
  if (kind === "home-sections") {
    // The OS-2.0 home page: JSON-template sections rendered as
    // shopify-section wrappers directly inside #main (id suffix = the
    // templates/index.json order key).
    for (const key of ["main", "product_slider_FR8JAB", "cta_banner_4KL4FE"]) {
      const section = doc.createElement("div");
      section.className = "shopify-section";
      section.setAttribute(
        "id",
        "shopify-section-template--12345__" + key,
      );
      main.appendChild(section);
    }
  }
  return { doc, sandbox, main };
}

function landmarkOrder(main) {
  const order = [];
  (function walk(node) {
    for (const c of node.childNodes) {
      if (c.nodeType !== 1) continue;
      const cls = c.className || "";
      if (cls.indexOf("cx-proof-band") !== -1) order.push(c.getAttribute("data-cx-band"));
      else if (cls.indexOf("cx-proof-stack") !== -1) order.push("STACK");
      else if (cls.indexOf("pdp__tabs") !== -1) order.push("TABS");
      else if (cls.indexOf("shopify-section") !== -1)
        order.push("S:" + (c.getAttribute("id") || "").split("__").pop());
      else walk(c);
    }
  })(main);
  return order.join("|");
}

function place(sandbox, keys) {
  for (const key of keys) vm.runInContext(`pfBandAt(${JSON.stringify(key)});`, sandbox);
}

// ---- P1: stack present, all six arrival permutations converge -------------
const KEYS = ["above_proof", "below_proof", "below_tabs"];
const PERMS = [
  ["above_proof", "below_proof", "below_tabs"],
  ["above_proof", "below_tabs", "below_proof"],
  ["below_proof", "above_proof", "below_tabs"],
  ["below_proof", "below_tabs", "above_proof"],
  ["below_tabs", "above_proof", "below_proof"],
  ["below_tabs", "below_proof", "above_proof"],
];
const EXPECT_PDP = "above_proof|STACK|below_proof|TABS|below_tabs";
for (const perm of PERMS) {
  const { sandbox, main } = makePage("pdp");
  place(sandbox, perm);
  ok(landmarkOrder(main) === EXPECT_PDP,
    "P1: stack present, arrival " + perm.join(">") + " -> " + EXPECT_PDP + " (got " + landmarkOrder(main) + ")");
}

// ---- P2: stack absent — rank order at the shared before-tabs anchor -------
for (const perm of [["above_proof", "below_proof"], ["below_proof", "above_proof"]]) {
  const { sandbox, main } = makePage("pdp-no-stack");
  place(sandbox, perm);
  ok(landmarkOrder(main) === "above_proof|below_proof|TABS",
    "P2: no stack, arrival " + perm.join(">") + " stays rank-ordered (got " + landmarkOrder(main) + ")");
}

// ---- P3: off product pages every key collapses to below_tabs --------------
{
  const { sandbox } = makePage("home");
  const keys = ["a", "b", ""].map((pl) =>
    vm.runInContext(`pfPlacementKey({ ctx: "brand", pl: ${JSON.stringify(pl)} });`, sandbox));
  ok(keys.every((k) => k === "below_tabs"),
    "P3: brand ctx collapses every pl code to below_tabs (got " + keys.join(",") + ")");
  const prodKeys = ["a", "b", ""].map((pl) =>
    vm.runInContext(`pfPlacementKey({ ctx: "product", pl: ${JSON.stringify(pl)} });`, sandbox));
  ok(prodKeys.join(",") === "above_proof,below_proof,below_tabs",
    "P3b: product ctx decodes the three codes (got " + prodKeys.join(",") + ")");
  const { sandbox: s2, main: m2 } = makePage("home");
  place(s2, ["below_tabs"]);
  ok(landmarkOrder(m2) === "below_tabs", "P3c: home band appends to #main");
}

// ---- P4: fail closed with no anchors --------------------------------------
{
  const doc = makeDocument();
  const sandbox = { console, document: doc };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox);
  const band = vm.runInContext('pfBandAt("below_tabs");', sandbox);
  ok(band === null, "P4: no #main/no pdp anchors -> null (fail closed)");
  ok(doc.body.childNodes.length === 0, "P4b: nothing appended to <body>");
}

// ---- P5: slot inventory ---------------------------------------------------
{
  const { sandbox, main } = makePage("pdp");
  place(sandbox, ["below_tabs"]);
  const slots = vm.runInContext(
    '[].map.call(document.querySelector(".cx-proof-band").querySelectorAll("[data-cx-slot]"), function (s) { return s.getAttribute("data-cx-slot"); }).join(",");',
    sandbox);
  ok(slots === "press,endorsements,results", "P5: fixed slot order (got " + slots + ")");
}

// ---- H (v8.15): press home anchor -----------------------------------------
{
  // H1: key selection — a valid ha wins on brand ctx only; malformed
  // shapes fail closed to the shared end-of-main band.
  const { sandbox } = makePage("home");
  const keyOf = (conf) =>
    vm.runInContext(`pfPlacementKey(${JSON.stringify(conf)});`, sandbox);
  ok(keyOf({ ctx: "brand", ha: "product_slider_FR8JAB" }) === "home_after",
    "H1: brand ctx + valid ha -> home_after");
  ok(keyOf({ ctx: "brand" }) === "below_tabs",
    "H1b: brand ctx without ha keeps the v8.7 collapse");
  ok(keyOf({ ctx: "product", ha: "product_slider_FR8JAB", pl: "a" }) === "above_proof",
    "H1c: product ctx ignores ha (home-only concept)");
  for (const bad of ["bad key!", "", 123, "x".repeat(65)]) {
    ok(keyOf({ ctx: "brand", ha: bad }) === "below_tabs",
      "H1d: malformed ha " + JSON.stringify(bad) + " fails closed to below_tabs");
  }
}
{
  // H2: the home_after band lands right after the picked section wrapper.
  const { sandbox, main } = makePage("home-sections");
  vm.runInContext(
    'pfBandAt("home_after", { ctx: "brand", ha: "product_slider_FR8JAB" });',
    sandbox);
  ok(landmarkOrder(main) === "S:main|S:product_slider_FR8JAB|home_after|S:cta_banner_4KL4FE",
    "H2: band inserted after the picked section (got " + landmarkOrder(main) + ")");
}
{
  // H3: a deleted/renamed section key falls back to the end-of-main chain,
  // and the shared default band still rank-sorts after the press band.
  const { sandbox, main } = makePage("home-sections");
  vm.runInContext(
    'pfBandAt("home_after", { ctx: "brand", ha: "gone_section" });',
    sandbox);
  place(sandbox, ["below_tabs"]);
  ok(landmarkOrder(main) ===
      "S:main|S:product_slider_FR8JAB|S:cta_banner_4KL4FE|home_after|below_tabs",
    "H3: missing section -> end of main, press band before the default band (got " +
      landmarkOrder(main) + ")");
}
{
  // H4: idempotence — re-requesting the home band returns the same node.
  const { sandbox, main } = makePage("home-sections");
  const twice = vm.runInContext(
    'pfBandAt("home_after", { ctx: "brand", ha: "product_slider_FR8JAB" }) === ' +
      'pfBandAt("home_after", { ctx: "brand", ha: "product_slider_FR8JAB" });',
    sandbox);
  ok(twice === true, "H4: home band is created once and reused");
  ok((landmarkOrder(main).match(/home_after/g) || []).length === 1,
    "H4b: exactly one home band in the DOM");
}

// ---- mutants ---------------------------------------------------------------
if (!process.env.CX_SIM_SRC) {
  const failedMutants = runMutants({
    selfPath: __filename,
    srcPath: REAL_SRC,
    mutants: [
      {
        name: "m1-sort-dropped",
        find: "    pfSortBandRun(band);",
        replace: "",
      },
      {
        name: "m2-ctx-gate-dropped",
        find: "    if (!conf || conf.ctx !== 'product') {",
        replace: "    if (false) {",
      },
      {
        name: "m3-rank-flattened",
        find: "  var PF_BAND_RANK = { home_after: 0, above_proof: 1, below_proof: 2, below_tabs: 3 };",
        replace: "  var PF_BAND_RANK = { home_after: 0, above_proof: 0, below_proof: 0, below_tabs: 0 };",
      },
      {
        name: "m4-home-anchor-dropped",
        find: "      var homeAnchor = pfHomeSectionAnchor(pfHomeAnchorKey(conf));",
        replace: "      var homeAnchor = null;",
      },
      {
        name: "m5-ha-gate-dropped",
        find: "      if (conf && pfHomeAnchorKey(conf)) return 'home_after';",
        replace: "",
      },
    ],
  });
  if (failedMutants > 0) process.exit(1);
}

if (failures > 0) {
  console.error(failures + "/" + checks + " CHECKS FAILED (v8.9 proof-band placement vs the real cellexia-proof.js)");
  process.exit(1);
}
console.log("ALL " + checks + " CHECKS PASSED (v8.9 proof-band placement vs the real cellexia-proof.js)");
