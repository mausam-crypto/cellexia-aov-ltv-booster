/**
 * v6.8 az stock/ships split sim — runs the REAL az stock module extracted
 * from extensions/cellexia-booster/assets/cellexia-pdp.js (vm + function
 * extraction, the house sim convention). Repo-resident port of the
 * surviving scratchpad proof v68-az-split-sim.js (the rest of the historic
 * suite was wiped with the session tmp scratchpad — hence validation/).
 *
 * Proves the Tier-3 case matrix for the split builder/mount/sync:
 *   1. stock-only  — green In Stock line alone replaces the theme .stock-msg;
 *   2. ships-only  — Ships-from line alone replaces it (Intl.DisplayNames name);
 *   3. both        — both lines render (pre-split combined look), one container;
 *   4. neither     — nothing mounts, theme .stock-msg untouched;
 *   5. no-warehouse — az_ships_from ON but no resolvable warehouse: fail
 *      closed (ships-only -> nothing mounts; with stock -> In Stock only);
 * plus the unchanged restore semantics (unavailable variant hides our node
 * and restores the theme message; re-availability swaps back), per-line
 * impression beacons, and the per-market preview convention (azOn draft).
 *
 * Stubs are minimal and documented: a tiny DOM (single-class selectors
 * only; unsupported selectors return null exactly like a no-match) and
 * decodeEntities = identity (no HTML entities in the sim strings).
 *
 * MUTATION TESTS (all must be CAUGHT — non-zero exit on a mutant copy):
 *   m1-payload-gate-or   azStockAllowed && -> ||   (payload-gate honesty, G1)
 *   m2-always-available  azStockSync availability forced true (restore, R1/R3)
 *   m3-beacon-no-guard   azStockSync stock once-guard dropped (R2 double-sync)
 *   m4-ships-needs-stock azMountStock mounts only with stock on (S2 ships-only)
 *   m5-wrong-member      azShipsWarehouseName reads shipsFrom, not ships (S2)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REAL_SRC = path.join(
  __dirname, "..", "..",
  "extensions", "cellexia-booster", "assets", "cellexia-pdp.js",
);
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;
const SRC = fs.readFileSync(SRC_PATH, "utf8");

// ---------------------------------------------------------------- extraction
function extractFn(name) {
  const marker = `  function ${name}(`;
  const start = SRC.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in cellexia-pdp.js`);
  let i = SRC.indexOf("{", start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    const ch = SRC[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

const FNS = [
  "insertAfter",
  "cxEl",
  "cxSp",
  "azPageLocale",
  "azT",
  "azReadConfig",
  "azOn",
  "azHasStr",
  "azTplPayload",
  "azRegionName",
  "azWarehouseName",
  "azShipsWarehouseName",
  "azProductData",
  "azCurrentVariantId",
  "azVariantInfo",
  "azStockAllowed",
  "azShipsAllowed",
  "azStockSync",
  "azMountStock",
  "azBuildStock",
];
const EXTRACTED = FNS.map(extractFn).join("\n\n");

// Static evidence pins (the coverage-tripwire style): the ships line root
// must carry its own feature attribute, and the file must gate each line
// on its own key.
const PINS = [
  ["ships line data-cx-feature", /'data-cx-feature', 'az_ships_from'/.test(SRC)],
  ["stock line data-cx-feature", /'data-cx-feature', 'az_stock_line'/.test(SRC)],
  ["stockAllowed on its own key", /azOn\('az_stock_line'\) && azTplPayload\('az_stock_line'\)/.test(SRC)],
  ["shipsAllowed on its own key", /azOn\('az_ships_from'\) && azTplPayload\('az_ships_from'\)/.test(SRC)],
  ["ships beacon", /track\('az_ships_from'\)/.test(SRC)],
];

// ------------------------------------------------------------------ mini-DOM
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.attrs = {};
    this.childNodes = [];
    this.parentNode = null;
    this.style = {};
    this._text = "";
  }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return n in this.attrs; }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    node.parentNode = this;
    if (i === -1) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i !== -1) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const sib = this.parentNode.childNodes;
    return sib[sib.indexOf(this) + 1] || null;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v) { this.childNodes = []; this._text = String(v); }
  get classList() {
    const self = this;
    return {
      contains(c) { return (self.attrs.class || "").split(/\s+/).includes(c); },
      add(c) { if (!this.contains(c)) self.attrs.class = ((self.attrs.class || "") + " " + c).trim(); },
    };
  }
  matchesClass(cls) { return (this.attrs.class || "").split(/\s+/).includes(cls); }
  querySelector(sel) {
    const m = /^\.([A-Za-z0-9_-]+)$/.exec(sel);
    if (!m) return null; // unsupported selector = no match (documented stub)
    const cls = m[1];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 1) {
          if (c.matchesClass(cls)) return c;
          const hit = walk(c);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(this);
  }
  querySelectorAll(sel) {
    const m = /^\.([A-Za-z0-9_-]+)$/.exec(sel);
    if (!m) return [];
    const cls = m[1];
    const out = [];
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 1) {
          if (c.matchesClass(cls)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
}

function textNode(s) {
  return { nodeType: 3, parentNode: null, childNodes: [], textContent: String(s) };
}

// ------------------------------------------------------------ scenario setup
function makePage(configObj) {
  const root = new El("body");
  const grey = new El("div");
  grey.setAttribute("class", "pdp__grey");
  const stockMsg = new El("p");
  stockMsg.setAttribute("class", "stock-msg");
  stockMsg.textContent = "in stock ships from our warehouse"; // the theme's own line
  const actions = new El("div");
  actions.setAttribute("class", "pdp__actions--flex");
  grey.appendChild(stockMsg);
  grey.appendChild(actions);
  root.appendChild(grey);

  const cfgEl = new El("script");
  cfgEl.id = "cx-az-config";
  cfgEl.textContent = JSON.stringify(configObj);
  cfgEl.setAttribute("data-cx-market", "global");

  const document = {
    root,
    getElementById(id) { return id === "cx-az-config" ? cfgEl : null; },
    querySelector(sel) { return root.querySelector(sel); },
    querySelectorAll(sel) { return root.querySelectorAll(sel); },
    createElement(tag) { return new El(tag); },
    createTextNode(s) { return textNode(s); },
  };
  return { document, grey, stockMsg };
}

function runScenario(config, opts) {
  opts = opts || {};
  const page = makePage(config);
  const tracked = [];
  const sandbox = {
    document: page.document,
    window: { Intl, fetch: () => Promise.reject(new Error("no fetch in sim")) },
    Intl,
    JSON,
    console,
    // module-level state the extracted functions close over
    PREVIEW: opts.preview || null,
    AZ_CFG: null,
    AZ_CFG_READ: false,
    azStockState: null,
    track: (k) => tracked.push(k),
    decodeEntities: (s) => s, // sim strings carry no HTML entities
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox, { filename: "extracted-az-module.js" });
  vm.runInContext("azMountStock()", sandbox);
  return { page, sandbox, tracked };
}

const BASE_STRINGS = {
  "amazon.in_stock": "In Stock",
  "amazon.ships_from": "Ships from @@COUNTRY@@",
};
const PRODUCT = { id: 1, handle: "x", selectedVariant: "11", variants: { 11: { available: true }, 12: { available: false } } };

function cfgFor(stockOn, shipsOn, warehouse, extra) {
  const c = {
    pageLocale: "en",
    country: "CH",
    product: PRODUCT,
    strings: { _: 1 },
    effective: {
      az_stock_line: !!stockOn,
      az_ships_from: !!shipsOn,
    },
  };
  if (stockOn) {
    c.stock = { live: true };
    c.strings["amazon.in_stock"] = BASE_STRINGS["amazon.in_stock"];
  }
  if (shipsOn) {
    c.ships = { live: true, warehouse: warehouse == null ? "CH" : warehouse };
    c.strings["amazon.ships_from"] = BASE_STRINGS["amazon.ships_from"];
  }
  return Object.assign(c, extra || {});
}

// ------------------------------------------------------------------ checks
let checks = 0, failures = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.error("FAIL: " + label); }
}

for (const [label, pass] of PINS) ok(pass, "pin: " + label);

const CH_NAME = new Intl.DisplayNames(["en"], { type: "region" }).of("CH"); // "Switzerland"

// --- case 1: stock-only ------------------------------------------------------
{
  const { page, tracked } = runScenario(cfgFor(true, false));
  const node = page.document.querySelector(".cx-az-stock");
  ok(!!node, "S1 mounts the container");
  ok(!!node && node.querySelector(".cx-az-stock__instock") !== null, "S1 In Stock line renders");
  ok(!!node && node.querySelector(".cx-az-stock__ships") === null, "S1 NO ships line");
  ok(!!node && node.querySelector(".cx-az-stock__instock").getAttribute("data-cx-feature") === "az_stock_line", "S1 line root carries az_stock_line");
  ok(!!node && node.getAttribute("hidden") === null, "S1 container visible (variant available)");
  ok(page.stockMsg.style.display === "none", "S1 theme .stock-msg swapped out");
  ok(tracked.join(",") === "az_stock_line", "S1 beacon: az_stock_line only");
}

// --- case 2: ships-only ------------------------------------------------------
{
  const { page, tracked } = runScenario(cfgFor(false, true, "CH"));
  const node = page.document.querySelector(".cx-az-stock");
  ok(!!node, "S2 mounts the container");
  ok(!!node && node.querySelector(".cx-az-stock__instock") === null, "S2 NO In Stock line");
  const ships = node && node.querySelector(".cx-az-stock__ships");
  ok(!!ships, "S2 ships line renders");
  ok(!!ships && ships.getAttribute("data-cx-feature") === "az_ships_from", "S2 line root carries az_ships_from");
  ok(!!ships && ships.textContent === "Ships from " + CH_NAME, "S2 country name via Intl.DisplayNames (" + CH_NAME + ")");
  ok(page.stockMsg.style.display === "none", "S2 ships ALONE swaps the theme .stock-msg");
  ok(tracked.join(",") === "az_ships_from", "S2 beacon: az_ships_from only");
}

// --- case 3: both ------------------------------------------------------------
{
  const { page, tracked } = runScenario(cfgFor(true, true, "CH"));
  const node = page.document.querySelector(".cx-az-stock");
  ok(!!node && node.querySelector(".cx-az-stock__instock") !== null && node.querySelector(".cx-az-stock__ships") !== null,
    "S3 both lines render in one container (combined look)");
  ok(page.document.querySelectorAll(".cx-az-stock").length === 1, "S3 single container");
  ok(page.stockMsg.style.display === "none", "S3 theme .stock-msg swapped out");
  ok(tracked.slice().sort().join(",") === "az_ships_from,az_stock_line", "S3 both beacons, one each");
}

// --- case 4: neither ---------------------------------------------------------
{
  const { page, tracked } = runScenario(cfgFor(false, false));
  ok(page.document.querySelector(".cx-az-stock") === null, "S4 nothing mounts");
  ok(page.stockMsg.style.display !== "none", "S4 theme .stock-msg untouched");
  ok(tracked.length === 0, "S4 no beacons");
}

// --- case 5: no-warehouse (fail closed) ---------------------------------------
{
  // 5a ships-only with an empty warehouse: nothing may mount and the theme
  // line must stay (a replacement never leaves a hole).
  const a = runScenario(cfgFor(false, true, ""));
  ok(a.page.document.querySelector(".cx-az-stock") === null, "S5a ships-only w/o warehouse: nothing mounts");
  ok(a.page.stockMsg.style.display !== "none", "S5a theme .stock-msg untouched");
  ok(a.tracked.length === 0, "S5a no beacons");
  // 5b stock + ships on, no warehouse: In Stock only.
  const b = runScenario(cfgFor(true, true, ""));
  const node = b.page.document.querySelector(".cx-az-stock");
  ok(!!node && node.querySelector(".cx-az-stock__instock") !== null && node.querySelector(".cx-az-stock__ships") === null,
    "S5b with stock on: In Stock renders, ships fails closed");
  ok(b.tracked.join(",") === "az_stock_line", "S5b beacon: az_stock_line only");
  // 5c garbage warehouse code fails closed too.
  const c = runScenario(cfgFor(false, true, "Z9"));
  ok(c.page.document.querySelector(".cx-az-stock") === null, "S5c invalid ISO2 warehouse: fail closed");
}

// --- restore semantics (unchanged) --------------------------------------------
{
  const cfg = cfgFor(true, true, "CH");
  cfg.product = { id: 1, handle: "x", selectedVariant: "12", variants: PRODUCT.variants }; // unavailable
  const { page, sandbox, tracked } = runScenario(cfg);
  const node = page.document.querySelector(".cx-az-stock");
  ok(!!node, "R1 container mounts even when unavailable (sync decides)");
  ok(!!node && node.getAttribute("hidden") !== null, "R1 container hidden while variant unavailable");
  ok(page.stockMsg.style.display !== "none", "R1 theme .stock-msg restored/visible");
  ok(tracked.length === 0, "R1 no beacon while nothing is shown");
  // variant flips to available -> swap happens, beacons fire once
  vm.runInContext("AZ_CFG.product.selectedVariant = '11'; azStockSync(); azStockSync();", sandbox);
  ok(node.getAttribute("hidden") === null, "R2 available again: our node shows");
  ok(page.stockMsg.style.display === "none", "R2 theme .stock-msg swapped out");
  ok(tracked.slice().sort().join(",") === "az_ships_from,az_stock_line", "R2 beacons fired once each (double-sync safe)");
  // ... and back to unavailable: the theme message must come back with
  // its ORIGINAL display value (the actual restore write, not the
  // never-swapped R1 case).
  vm.runInContext("AZ_CFG.product.selectedVariant = '12'; azStockSync();", sandbox);
  ok(node.getAttribute("hidden") !== null, "R3 unavailable again: our node hides");
  ok(page.stockMsg.style.display === "", "R3 theme .stock-msg display RESTORED to its original value");
}

// --- preview draft convention ---------------------------------------------------
{
  // Live-off everywhere, draft flag on inside a verified preview session:
  // azOn follows PREVIEW.flags; the gated members are emitted by the
  // Liquid draft path (cx_draft_az_ships) — modeled here as present.
  const cfg = cfgFor(false, false);
  cfg.stock = { live: false };
  cfg.ships = { live: false, warehouse: "NL" };
  cfg.strings["amazon.in_stock"] = BASE_STRINGS["amazon.in_stock"];
  cfg.strings["amazon.ships_from"] = BASE_STRINGS["amazon.ships_from"];
  const { page, tracked } = runScenario(cfg, {
    preview: { live: {}, flags: { az_ships_from: true }, market: "global" },
  });
  const node = page.document.querySelector(".cx-az-stock");
  ok(!!node && node.querySelector(".cx-az-stock__ships") !== null && node.querySelector(".cx-az-stock__instock") === null,
    "P1 preview draft az_ships_from renders the ships line alone");
  const NL_NAME = new Intl.DisplayNames(["en"], { type: "region" }).of("NL");
  ok(node.querySelector(".cx-az-stock__ships").textContent === "Ships from " + NL_NAME, "P1 warehouse from the ships member (" + NL_NAME + ")");
  ok(tracked.join(",") === "az_ships_from", "P1 draft beacon convention unchanged (suppression happens in track())");
}

// --- payload gate honesty --------------------------------------------------------
{
  // Effective true but the gated member ABSENT (e.g. embed checkbox off):
  // azTplPayload fails closed, nothing mounts.
  const cfg = cfgFor(false, false);
  cfg.effective.az_stock_line = true;
  cfg.effective.az_ships_from = true;
  cfg.strings["amazon.in_stock"] = BASE_STRINGS["amazon.in_stock"];
  cfg.strings["amazon.ships_from"] = BASE_STRINGS["amazon.ships_from"];
  const { page } = runScenario(cfg);
  ok(page.document.querySelector(".cx-az-stock") === null, "G1 missing gated members = fail closed (embed-setting rule)");
}

if (failures > 0) {
  console.error(`\n${failures}/${checks} CHECKS FAILED`);
  process.exit(1);
}
// ---------------------------------------------------- v6.8.1 micro dedupe
// The microcopy ships-from row must YIELD to the dedicated az_ships_from
// line (never two "Ships from" in one buy box), and must stay hidden when
// no label resolves (the CSS [hidden] guard covers the display:flex trap).
{
  const src = SRC;
  ok(/var label = '';\s*\n\s*if \(!azShipsAllowed\(\)\) \{/.test(src),
    'v6.8.1: micro ships row gated behind !azShipsAllowed() (dedupe vs the dedicated line)');
  ok(src.includes("if (row && slot && line) {") &&
    src.indexOf("row.removeAttribute('hidden')") > src.indexOf("if (row && slot && line) {"),
    'v6.8.1: micro row still fail-closed (populate+unhide only with a resolved label and line)');
  const css = fs.readFileSync(path.join(path.dirname(SRC_PATH), 'cellexia-booster.css'), 'utf8');
  ok(/\.cx-az-micro__row\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/.test(css),
    'v6.8.1: CSS guard .cx-az-micro__row[hidden] { display: none !important; } present');
}

console.log(`ALL ${checks} CHECKS PASSED (v6.8 az stock/ships split sim vs the real cellexia-pdp.js module)`);

// ------------------------------------------------------------ mutation tests
if (!process.env.CX_SKIP_MUTANTS && SRC_PATH === REAL_SRC) {
  const { runMutants } = require("./lib/mutants.cjs");
  const MUTANTS = [
    {
      name: "m1-payload-gate-or",
      find: "return azOn('az_stock_line') && azTplPayload('az_stock_line');",
      replace: "return azOn('az_stock_line') || azTplPayload('az_stock_line');",
    },
    {
      name: "m2-always-available",
      find: "var available = !!(info && info.available === true);",
      replace: "var available = true;",
    },
    {
      name: "m3-beacon-no-guard",
      find: "if (st.stockOn && !st.tracked) {",
      replace: "if (st.stockOn) {",
    },
    {
      name: "m4-ships-needs-stock",
      find: "if (!stockOn && !shipsLine) return;",
      replace: "if (!stockOn) return;",
    },
    {
      name: "m5-wrong-member",
      find: "var sh = AZ_CFG && AZ_CFG.ships;",
      replace: "var sh = AZ_CFG && AZ_CFG.shipsFrom;",
    },
  ];
  const bad = runMutants({ selfPath: __filename, srcPath: REAL_SRC, mutants: MUTANTS });
  if (bad > 0) {
    console.error(`${bad}/${MUTANTS.length} MUTANTS ESCAPED`);
    process.exit(1);
  }
  console.log(`ALL ${MUTANTS.length} MUTANTS CAUGHT (az-split)`);
}
