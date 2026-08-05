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
 *      press → endorsements → results order.
 *
 * MUTATION TESTS (all must be CAUGHT):
 *   m1-sort-dropped      pfSortBandRun call removed (P2)
 *   m2-ctx-gate-dropped  pfPlacementKey ignores ctx (P3)
 *   m3-rank-flattened    PF_BAND_RANK collapses to one rank (P2)
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
        find: "    if (!conf || conf.ctx !== 'product') return 'below_tabs';",
        replace: "",
      },
      {
        name: "m3-rank-flattened",
        find: "  var PF_BAND_RANK = { above_proof: 0, below_proof: 1, below_tabs: 2 };",
        replace: "  var PF_BAND_RANK = { above_proof: 0, below_proof: 0, below_tabs: 0 };",
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
