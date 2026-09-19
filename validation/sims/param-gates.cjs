/**
 * v22 URL PARAMETER GATES — executable proof against the REAL shipped module
 * (docs/SPEC-v22-param-gates.md).
 *
 * The contract this suite holds:
 *
 *   A. DIGEST         the extension's hash lane is a byte-twin of
 *                     app/models/gate-digest.ts, and of the canonical
 *                     FNV-1a 32 test vector.
 *   B. MATCHING       a tagged link opens its own gate and nothing else,
 *                     wherever the parameter sits among the others.
 *   C. VALUE FORMAT   the stored unlock round-trips, sorts stably, and
 *                     drops anything expired or malformed.
 *   D. EXPIRY         exactly 90 days, measured on an INJECTED clock.
 *   E. INDEPENDENCE   two gates unlock, clear and lapse separately.
 *   F. FAIL CLOSED    no island, no gate, unreadable storage, a dangling
 *                     reference or a malformed digest all paint nothing.
 *   G. PERSISTENCE    the cookie is restored from the localStorage mirror
 *                     with no network call, and the proxy is asked only
 *                     when a parameter actually matched.
 *   H. INPUTS         the module reads the query string and its own storage
 *                     and NOTHING else — no user agent, referrer, IP,
 *                     device or automation signal anywhere in it.
 *   I. TWINS          cellexia-pdp.js and cellexia-cart.js carry the same
 *                     module byte for byte.
 *
 * SCOPE NOTE: the render-side guards (bbpSealNode / bbpResearchNode /
 * v28's bbpAwardNode) are proved here against the real builders, so a
 * gate that stops hiding its piece fails this suite and not only the v19
 * one.
 *
 * MUTATION TESTS (all must be CAUGHT):
 *   m1  the clear digest stops winning over the open digest
 *   m2  expiry is not enforced on read
 *   m3  the seal's gate guard is dropped
 *   m4  the research band's gate guard is dropped
 *   m5  the stored value is not version-checked
 *   m6  the proxy sync stops de-duplicating across the two bundles
 *   m7  the award strip's gate guard is dropped (v28)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { extractFunction, extractVar } = require("./lib/extract.cjs");
const { makeDocument, El } = require("./lib/mini-dom.cjs");

const EXT = path.join(
  __dirname, "..", "..", "extensions", "cellexia-booster", "assets",
);
const REAL_SRC = path.join(EXT, "cellexia-pdp.js");
const CART_SRC = path.join(EXT, "cellexia-cart.js");
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;
const SRC = fs.readFileSync(SRC_PATH, "utf8");

let checks = 0;
let failures = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.log(`FAIL: ${label}`); }
}

const GATE_FNS = [
  "cxGateDigest",
  "cxGateConf",
  "cxGateQueryDigests",
  "cxGateParse",
  "cxGateSerialize",
  "cxGateCookie",
  "cxTrim",
  "cxGateStored",
  "cxGateSave",
  "cxGateBoot",
  "cxIndexOf",
  "cxGateSync",
  "cxGateOpen",
];
const GATE_VARS = [
  "CX_GATE_COOKIE",
  "CX_GATE_STORE",
  "CX_GATE_VERSION",
  "CX_GATE_TTL",
  "CX_GATE_MAX_PAIRS",
];
const GATE_MODULE = [
  ...GATE_VARS.map((v) => extractVar(SRC, v)),
  ...GATE_FNS.map((f) => extractFunction(SRC, f)),
].join("\n\n");

const DAY = 86400;
const TTL = 90 * DAY;
const T0 = 1_780_000_000; // a fixed instant, seconds — never Date.now()

// --------------------------------------------------------------- sandbox

/**
 * A browser just real enough for the module: a query string, a cookie jar
 * that honours max-age=0, a localStorage that can be made to throw, and a
 * fetch recorder. Everything the module could branch on is here, so a
 * branch on anything else would show up as an undefined-property throw.
 */
function makeBrowser({ search = "", cookie = "", store = null, island = undefined, now = T0, storageThrows = false } = {}) {
  const page = makeDocument();
  if (island !== undefined) {
    const el = new El("script");
    el.setAttribute("id", "cx-g");
    el.setAttribute("type", "application/json");
    el.textContent = typeof island === "string" ? island : JSON.stringify(island);
    page.body.appendChild(el);
  }
  const jar = new Map();
  if (cookie) {
    for (const chunk of cookie.split(";")) {
      const eq = chunk.indexOf("=");
      if (eq > 0) jar.set(chunk.slice(0, eq).trim(), chunk.slice(eq + 1).trim());
    }
  }
  const local = new Map();
  if (store) local.set("cx:ux", store);
  const fetches = [];
  const sandbox = {
    document: {
      getElementById: (id) => page.getElementById(id),
      get cookie() {
        return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
      },
      set cookie(raw) {
        const first = raw.split(";")[0];
        const eq = first.indexOf("=");
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (/max-age=0(\b|;|$)/i.test(raw)) jar.delete(name);
        else jar.set(name, value);
      },
    },
    window: {
      location: { search },
      localStorage: {
        getItem: (k) => {
          if (storageThrows) throw new Error("denied");
          return local.has(k) ? local.get(k) : null;
        },
        setItem: (k, v) => {
          if (storageThrows) throw new Error("denied");
          local.set(k, String(v));
        },
        removeItem: (k) => {
          if (storageThrows) throw new Error("denied");
          local.delete(k);
        },
      },
      fetch: (url, opts) => {
        fetches.push({ url, body: JSON.parse(opts.body) });
        return { catch: () => {} };
      },
    },
    JSON, Math, Number, String, Object, Array, RegExp, isFinite,
    decodeURIComponent, encodeURIComponent,
    routeRoot: () => "/",
    console,
  };
  sandbox.window.localStorage.__map = local;
  vm.createContext(sandbox);
  vm.runInContext(GATE_MODULE, sandbox, { filename: "extracted-gate-module.js" });
  sandbox.__jar = jar;
  sandbox.__local = local;
  sandbox.__fetches = fetches;
  sandbox.__now = now;
  return sandbox;
}

function digestOf(text) {
  return makeBrowser({}).cxGateDigest(text);
}

// A live shop: two gates, each with its own parameter.
const GATE_A = { id: "br", param: "k7mq3v", token: "9fd2xw41rb" };
const GATE_B = { id: "bs", param: "p4zc8n", token: "hq06vm23dt" };
function islandFor(...gates) {
  const out = {};
  for (const g of gates) {
    out[g.id] = digestOf(`${g.param}=${g.token}`) + digestOf(`${g.param}=off`);
  }
  return out;
}
const ISLAND = islandFor(GATE_A, GATE_B);

// ------------------------------------------------------------- A. DIGEST
{
  // The canonical FNV-1a 32 vector: fnv1a32("hello") === 0x4f9f2cab. Lane 1
  // uses the standard offset basis, so the first 8 hex chars must match it.
  ok(digestOf("hello").slice(0, 8) === "4f9f2cab", "A1 lane 1 is canonical FNV-1a 32");
  ok(/^[0-9a-f]{16}$/.test(digestOf("k7mq3v=9fd2xw41rb")), "A2 a digest is 16 lowercase hex chars");
  ok(digestOf("a") !== digestOf("b"), "A3 different inputs give different digests");
  ok(digestOf("k7mq3v=9fd2xw41rb") !== digestOf("k7mq3v=off"), "A4 the open and clear digests differ");

  // TWINNING: the shipped TypeScript lane must agree, or the metafield would
  // carry a digest the extension can never match.
  const ts = fs.readFileSync(
    path.join(__dirname, "..", "..", "app", "models", "gate-digest.ts"), "utf8",
  );
  ok(ts.includes("0x811c9dc5") && ts.includes("0x811c9dcd"), "A5 the TS lane declares both offset bases");
  ok(GATE_MODULE.includes("[2166136261, 2166136269]"), "A6 the JS lane declares the same two bases (0x811c9dc5 / 0x811c9dcd)");
  ok(ts.includes("GATE_OFF_VALUE = \"off\""), "A7 the clear literal is shared");
}

// ----------------------------------------------------------- B. MATCHING
{
  const open = `?${GATE_A.param}=${GATE_A.token}`;
  const cases = [
    [open, "bare"],
    [`${open}&utm_source=meta`, "parameter first"],
    [`?variant=41234567890&${GATE_A.param}=${GATE_A.token}`, "parameter last"],
    [`?a=1&${GATE_A.param}=${GATE_A.token}&b=2`, "parameter in the middle"],
    [`?gclid=Cj0abc&${GATE_A.param}=${GATE_A.token}&fbclid=IwAR9`, "between two click ids"],
  ];
  for (const [search, why] of cases) {
    const w = makeBrowser({ search, island: ISLAND });
    w.cxGateBoot(T0 * 1000);
    ok(w.cxGateOpen("br", T0 * 1000) === true, `B1 opens with the parameter ${why}`);
    ok(w.cxGateOpen("bs", T0 * 1000) === false, `B2 the OTHER gate stays shut (${why})`);
  }

  const wrong = makeBrowser({ search: `?${GATE_A.param}=nope123456`, island: ISLAND });
  wrong.cxGateBoot(T0 * 1000);
  ok(wrong.cxGateOpen("br", T0 * 1000) === false, "B3 the right name with the wrong token opens nothing");

  const none = makeBrowser({ search: "?utm_source=meta&gclid=Cj0abc", island: ISLAND });
  none.cxGateBoot(T0 * 1000);
  ok(none.cxGateOpen("br", T0 * 1000) === false, "B4 ordinary campaign parameters open nothing");

  // URL-encoding: the pair is decoded before hashing, so an encoded form of
  // the same parameter still matches.
  const enc = makeBrowser({ search: `?%6b7mq3v=${GATE_A.token}`, island: ISLAND });
  enc.cxGateBoot(T0 * 1000);
  ok(enc.cxGateOpen("br", T0 * 1000) === true, "B5 a percent-encoded parameter name still matches");

  const flat = makeBrowser({ search: "", island: ISLAND });
  flat.cxGateBoot(T0 * 1000);
  ok(flat.cxGateOpen("br", T0 * 1000) === false, "B6 a clean URL opens nothing");

  // More pairs than the cap: the module must not scan unboundedly.
  const many = [];
  for (let i = 0; i < 40; i++) many.push(`f${i}=1`);
  many.push(`${GATE_A.param}=${GATE_A.token}`);
  const capped = makeBrowser({ search: `?${many.join("&")}`, island: ISLAND });
  capped.cxGateBoot(T0 * 1000);
  ok(capped.cxGateOpen("br", T0 * 1000) === false, "B7 pairs past CX_GATE_MAX_PAIRS are not scanned");
}

// ------------------------------------------------------- C. VALUE FORMAT
{
  const w = makeBrowser({});
  const value = w.cxGateSerialize({ bs: T0 + TTL, br: T0 + TTL }, T0);
  ok(value === `1.br-${T0 + TTL}.bs-${T0 + TTL}`, "C1 serializes version-first with sorted ids");
  const back = w.cxGateParse(value, T0);
  ok(back.br === T0 + TTL && back.bs === T0 + TTL, "C2 round-trips");
  ok(w.cxGateSerialize({}, T0) === "", "C3 an empty set serializes to the empty string");
  ok(Object.keys(w.cxGateParse("2.br-9999999999", T0)).length === 0, "C4 an unknown format version is rejected whole");
  ok(Object.keys(w.cxGateParse("1.br", T0)).length === 0, "C5 a member with no expiry is dropped");
  ok(Object.keys(w.cxGateParse("1.BR-9999999999", T0)).length === 0, "C6 an id outside [a-z0-9]{1,8} is dropped");
  ok(Object.keys(w.cxGateParse("garbage", T0)).length === 0, "C7 junk parses to nothing");
  ok(Object.keys(w.cxGateParse(null, T0)).length === 0, "C8 a null value parses to nothing");
  const mixed = w.cxGateParse(`1.br-${T0 + TTL}.bs-${T0 - 1}`, T0);
  ok(mixed.br === T0 + TTL && mixed.bs === undefined, "C9 one expired member does not take the live one down with it");
}

// ------------------------------------------------------------- D. EXPIRY
{
  const w = makeBrowser({ search: `?${GATE_A.param}=${GATE_A.token}`, island: ISLAND });
  w.cxGateBoot(T0 * 1000);
  ok(w.cxGateOpen("br", (T0 + TTL - 1) * 1000) === true, "D1 open one second before 90 days");
  ok(w.cxGateOpen("br", (T0 + TTL) * 1000) === false, "D2 shut exactly AT 90 days");
  ok(w.cxGateOpen("br", (T0 + TTL + DAY) * 1000) === false, "D3 shut after 90 days");
  ok(w.CX_GATE_TTL === TTL, "D4 the TTL constant is 90 days in seconds");

  // A later visit through the same link restarts the 90 days.
  const again = makeBrowser({
    search: `?${GATE_A.param}=${GATE_A.token}`,
    island: ISLAND,
    store: `1.br-${T0 + TTL}`,
  });
  again.cxGateBoot((T0 + 30 * DAY) * 1000);
  ok(again.cxGateOpen("br", (T0 + 119 * DAY) * 1000) === true, "D5 clicking the link again restarts the window");
}

// ------------------------------------------------------- E. INDEPENDENCE
{
  const both = makeBrowser({
    search: `?${GATE_A.param}=${GATE_A.token}&${GATE_B.param}=${GATE_B.token}`,
    island: ISLAND,
  });
  both.cxGateBoot(T0 * 1000);
  ok(both.cxGateOpen("br", T0 * 1000) && both.cxGateOpen("bs", T0 * 1000), "E1 one URL can open both gates");

  // Arriving through the second link on day 60 must not disturb the first.
  const later = makeBrowser({
    search: `?${GATE_B.param}=${GATE_B.token}`,
    island: ISLAND,
    store: `1.br-${T0 + TTL}`,
  });
  later.cxGateBoot((T0 + 60 * DAY) * 1000);
  const stored = later.cxGateStored(T0 + 60 * DAY);
  ok(stored.br === T0 + TTL, "E2 a second unlock leaves the first one's clock alone");
  ok(stored.bs === T0 + 60 * DAY + TTL, "E3 the second gate gets its own full window");

  const clear = makeBrowser({
    search: `?${GATE_A.param}=off`,
    island: ISLAND,
    store: `1.br-${T0 + TTL}.bs-${T0 + TTL}`,
  });
  clear.cxGateBoot(T0 * 1000);
  ok(clear.cxGateOpen("br", T0 * 1000) === false, "E4 the clear value shuts its own gate");
  ok(clear.cxGateOpen("bs", T0 * 1000) === true, "E5 and leaves the other one open");

  // Both digests on one URL is nonsense; refusing to open is the safe read.
  const contradictory = makeBrowser({
    search: `?${GATE_A.param}=${GATE_A.token}&${GATE_A.param}=off`,
    island: ISLAND,
  });
  contradictory.cxGateBoot(T0 * 1000);
  ok(contradictory.cxGateOpen("br", T0 * 1000) === false, "E6 clear wins when a URL carries both");
}

// -------------------------------------------------------- F. FAIL CLOSED
{
  const noIsland = makeBrowser({ search: `?${GATE_A.param}=${GATE_A.token}` });
  noIsland.cxGateBoot(T0 * 1000);
  ok(noIsland.cxGateOpen("br", T0 * 1000) === false, "F1 no island (no gate is live) opens nothing");

  const onlyB = makeBrowser({ search: `?${GATE_A.param}=${GATE_A.token}`, island: islandFor(GATE_B) });
  onlyB.cxGateBoot(T0 * 1000);
  ok(onlyB.cxGateOpen("br", T0 * 1000) === false, "F2 a gate that is off cannot be opened");

  const badJson = makeBrowser({ search: `?${GATE_A.param}=${GATE_A.token}`, island: "{not json" });
  badJson.cxGateBoot(T0 * 1000);
  ok(badJson.cxGateOpen("br", T0 * 1000) === false, "F3 an unparseable island opens nothing");

  const shortPair = makeBrowser({ search: `?${GATE_A.param}=${GATE_A.token}`, island: { br: "deadbeef" } });
  shortPair.cxGateBoot(T0 * 1000);
  ok(shortPair.cxGateOpen("br", T0 * 1000) === false, "F4 a malformed digest pair opens nothing");

  const denied = makeBrowser({ search: `?${GATE_A.param}=${GATE_A.token}`, island: ISLAND, storageThrows: true });
  let threw = false;
  try { denied.cxGateBoot(T0 * 1000); } catch (e) { threw = true; }
  ok(threw === false, "F5 storage that throws never breaks the page");
  ok(denied.cxGateOpen("br", T0 * 1000) === false || denied.__jar.has("cx_ux"), "F6 storage that throws falls back to the cookie lane or to shut");

  ok(makeBrowser({}).cxGateOpen("", T0 * 1000) === false, "F7 an empty gate id is never open");
  ok(makeBrowser({}).cxGateOpen("br", T0 * 1000) === false, "F8 a reference with nothing stored is never open");
}

// -------------------------------------------------------- G. PERSISTENCE
{
  const fresh = makeBrowser({ search: `?${GATE_A.param}=${GATE_A.token}`, island: ISLAND });
  fresh.cxGateBoot(T0 * 1000);
  ok(fresh.__jar.get("cx_ux") === `1.br-${T0 + TTL}`, "G1 the unlock is written to the cookie");
  ok(fresh.__local.get("cx:ux") === `1.br-${T0 + TTL}`, "G2 and mirrored to localStorage");
  ok(fresh.__fetches.length === 1, "G3 the proxy is asked exactly once");
  ok(fresh.__fetches[0].url === "/apps/cellexia/gate", "G4 at the app-proxy path");
  ok(
    fresh.__fetches[0].body.d.length === 1 &&
      fresh.__fetches[0].body.d[0] === digestOf(`${GATE_A.param}=${GATE_A.token}`),
    "G5 sending the DIGEST, never the gate id or the parameter",
  );
  ok(JSON.stringify(fresh.__fetches[0].body).indexOf(GATE_A.param) === -1, "G6 the parameter never leaves the browser");

  // The Safari case: the cookie lane is gone, the mirror survived.
  const healed = makeBrowser({ island: ISLAND, store: `1.br-${T0 + TTL}` });
  healed.cxGateBoot(T0 * 1000);
  ok(healed.__jar.get("cx_ux") === `1.br-${T0 + TTL}`, "G7 a lost cookie is restored from the mirror");
  ok(healed.__fetches.length === 0, "G8 restoring costs no network call");

  // An ordinary page view with everything intact must be silent.
  const quiet = makeBrowser({
    island: ISLAND,
    store: `1.br-${T0 + TTL}`,
    cookie: `cx_ux=1.br-${T0 + TTL}`,
  });
  quiet.cxGateBoot(T0 * 1000);
  ok(quiet.__fetches.length === 0, "G9 an ordinary page view asks the proxy for nothing");

  // Both bundles boot on a product page and both capture; the proxy must
  // still be asked once, not twice.
  const twice = makeBrowser({ search: `?${GATE_A.param}=${GATE_A.token}`, island: ISLAND });
  twice.cxGateBoot(T0 * 1000);
  twice.cxGateBoot(T0 * 1000);
  ok(twice.__fetches.length === 1, "G11 a second bundle capturing the same unlock does not post again");
  ok(twice.cxGateOpen("br", T0 * 1000) === true, "G12 and the unlock is still in place after both");

  const lapsed = makeBrowser({ island: ISLAND, store: `1.br-${T0 - 1}` });
  lapsed.cxGateBoot(T0 * 1000);
  ok(!lapsed.__jar.has("cx_ux") || lapsed.__jar.get("cx_ux") === "", "G10 a lapsed unlock is cleared, not resurrected");
}

// ------------------------------------------------------------- H. INPUTS
{
  // The module may branch on the query string and on its own storage. If it
  // ever branched on who the visitor appears to BE, the same URL would stop
  // meaning the same thing for everyone — so these must never appear.
  const forbidden = [
    "userAgent", "navigator.platform", "navigator.language", "webdriver",
    "referrer", "document.referrer", "screen.", "maxTouchPoints",
    "headless", "crawler", "Googlebot", "bingbot", "facebookexternalhit",
  ];
  for (const needle of forbidden) {
    ok(GATE_MODULE.indexOf(needle) === -1, `H1 the module never reads ${needle}`);
  }
  ok(/\bbot\b/i.test(GATE_MODULE) === false, "H2 the module has no bot branch at all");
  ok(GATE_MODULE.indexOf("Math.random") === -1, "H3 nothing is randomised — the same URL always means the same thing");
  ok(GATE_MODULE.indexOf("Date.now") === -1, "H4 the clock is injected, never read inside the module");

  // The Liquid emits the island unconditionally on whether a gate is on,
  // never on anything about the request, so the HTML is the same for all.
  const liquid = fs.readFileSync(
    path.join(__dirname, "..", "..", "extensions", "cellexia-booster", "blocks", "cart-booster.liquid"), "utf8",
  );
  ok(
    liquid.includes('{%- if cfg.paramGates -%}\n<script type="application/json" id="cx-g">{{ cfg.paramGates | json }}</script>'),
    "H5 the island is gated only on the registry, never on the request",
  );
  ok(liquid.indexOf("request.user_agent") === -1, "H6 the Liquid has no request-shape branch");
}

// -------------------------------------------------------------- I. TWINS
{
  const cart = fs.readFileSync(CART_SRC, "utf8");
  const slice = (src) => {
    const a = src.indexOf("  // --------------------------------------------- v22 URL parameter gates");
    const b = src.indexOf("  function cxGateOpen(id, nowMs) {");
    return a === -1 || b === -1 ? null : src.slice(a, src.indexOf("\n  }\n", b) + 4);
  };
  const pdpSlice = slice(fs.readFileSync(REAL_SRC, "utf8"));
  const cartSlice = slice(cart);
  ok(pdpSlice !== null && cartSlice !== null, "I1 both bundles carry the module");
  ok(pdpSlice === cartSlice, "I2 the two copies are byte-identical");
  ok(cart.includes("cxGateBoot(Date.now());"), "I3 the cart bundle captures on every page type");
  ok(fs.readFileSync(REAL_SRC, "utf8").includes("cxGateBoot(Date.now());"), "I4 the pdp bundle captures too");
}

// ----------------------------------------------- render-side gate guards
{
  // The real v19 builders, with the gate guards in place — plus the v28
  // award strip's builder and its curated table (bbpLocale needs a cfg
  // with a page locale, exactly what the pdp bundle gives it).
  const RENDER_FNS = [
    "cxEl", "cxSp", "cxRawStr", "decodeEntities", "bottleStr", "insertAfter",
    "bbpSealNode", "bbpBalanceLogo", "bbpResearchNode", "bbpGateMeta",
    "bbpLocale", "bbpAwardLocale", "bbpAwardTpl", "bbpAwardNode",
  ];
  function renderBand({ conf, unlocked = "", preview = null, now = T0 }) {
    const page = makeDocument();
    const sandbox = {
      document: {
        getElementById: (id) => page.getElementById(id),
        createElement: (t) => new El(t),
        createTextNode: (t) => { const n = new El("#text"); n.textContent = t; return n; },
        get cookie() { return unlocked ? `cx_ux=${unlocked}` : ""; },
        set cookie(_v) {},
      },
      window: { localStorage: null, location: { search: "" } },
      Date: { now: () => now * 1000 },
      PREVIEW: preview,
      JSON, Math, Number, String, Object, Array, RegExp, isFinite,
      decodeURIComponent, console,
      cfg: { delivery: { pageLocale: "en" } },
      cxIcon: () => new El("svg"),
      bbpBuiltInSeal: () => { const e = new El("svg"); e.setAttribute("class", "cx-bbp-research__seal-art"); return e; },
    };
    vm.createContext(sandbox);
    vm.runInContext(GATE_MODULE, sandbox, { filename: "gate.js" });
    vm.runInContext(
      [extractVar(SRC, "CX_BBP_AWARD"), ...RENDER_FNS.map((f) => extractFunction(SRC, f))].join("\n\n"),
      sandbox,
      { filename: "render.js" },
    );
    sandbox.__conf = conf;
    sandbox.__d = { rs: "Based on published research from" };
    return {
      node: vm.runInContext("bbpResearchNode(__d, __conf)", sandbox),
      award: vm.runInContext("bbpAwardNode(__conf)", sandbox),
      meta: (n, aw) => vm.runInContext("bbpGateMeta(__conf, __node, __award)", Object.assign(sandbox, { __node: n, __award: aw === undefined ? null : aw })),
    };
  }
  const INSTS = [{ name: "Harvard Medical School", imageUrl: "" }];
  const ungated = { research: { enabled: true, gate: "", institutions: INSTS }, seal: { enabled: true, gate: "", imageUrl: "" } };
  const gatedBoth = { research: { enabled: true, gate: "br", institutions: INSTS }, seal: { enabled: true, gate: "bs", imageUrl: "" } };
  const gatedResearch = { research: { enabled: true, gate: "br", institutions: INSTS }, seal: { enabled: true, gate: "", imageUrl: "" } };

  let r = renderBand({ conf: ungated });
  ok(r.node && r.node.querySelector(".cx-bbp-research__col") && r.node.querySelector(".cx-bbp-research__seal"),
    "R1 ungated: the band paints exactly as it did before v22");
  ok(r.meta(r.node) === "", "R2 ungated: the beacon carries no gate meta at all");

  r = renderBand({ conf: gatedBoth });
  ok(r.node === null, "R3 both pieces gated and locked: the whole band is absent");

  r = renderBand({ conf: gatedBoth, unlocked: `1.br-${T0 + TTL}.bs-${T0 + TTL}` });
  ok(r.node && r.node.querySelector(".cx-bbp-research__col") && r.node.querySelector(".cx-bbp-research__seal"),
    "R4 both unlocked: the band paints in full");
  ok(r.meta(r.node) === "g:br,bs", "R5 the treated arm is tagged with both ids");

  r = renderBand({ conf: gatedBoth, unlocked: `1.bs-${T0 + TTL}` });
  ok(r.node && !r.node.querySelector(".cx-bbp-research__col") && r.node.querySelector(".cx-bbp-research__seal"),
    "R6 seal unlocked alone: the seal paints, the research column does not");
  ok(r.meta(r.node) === "g:bs", "R7 tagged with the one piece that painted");

  r = renderBand({ conf: gatedResearch });
  ok(r.node && !r.node.querySelector(".cx-bbp-research__col") && r.node.querySelector(".cx-bbp-research__seal"),
    "R8 one piece gated, one not: the ungated piece is untouched");
  ok(r.meta(r.node) === "g:", "R9 the control arm is tagged so the two are comparable");

  r = renderBand({ conf: gatedBoth, preview: { live: {}, flags: {} } });
  ok(r.node && r.node.querySelector(".cx-bbp-research__col") && r.node.querySelector(".cx-bbp-research__seal"),
    "R10 the Preview Center renders gated pieces so the merchant can check the design");

  // A dangling reference — the gate id names a gate the merchant turned off,
  // so no digest exists for it. The piece must stay hidden, never fall open.
  r = renderBand({ conf: { research: { enabled: true, gate: "zz", institutions: INSTS }, seal: { enabled: false, gate: "", imageUrl: "" } } });
  ok(r.node === null, "R11 a dangling gate reference fails CLOSED");

  // ---- v28: the award strip is the third gated piece -----------------------
  const AWARD = { enabled: true, gate: "", rank: 1, count: 100, category: "wrinkle", publication: "Verbraucher Berichte", imageUrl: "", year: 2026 };
  const awardGated = {
    research: { enabled: true, gate: "", institutions: INSTS },
    seal: { enabled: false, gate: "", imageUrl: "" },
    award: Object.assign({}, AWARD, { gate: "ba" }),
  };

  r = renderBand({ conf: Object.assign({}, awardGated, { award: AWARD }) });
  ok(r.award && r.award.querySelector(".cx-bbp-award__l1") !== null, "R12 ungated award: the strip paints for everyone");
  ok(r.meta(r.node, r.award) === "", "R12 and the beacon carries no gate meta");

  r = renderBand({ conf: awardGated });
  ok(r.award === null, "R13 gated and locked: the strip is absent");
  ok(r.meta(r.node, r.award) === "g:", "R13 the control arm is tagged for the comparison");

  r = renderBand({ conf: awardGated, unlocked: `1.ba-${T0 + TTL}` });
  ok(r.award !== null, "R14 the tagged link's unlock paints the strip");
  ok(r.meta(r.node, r.award) === "g:ba", "R14 the treated arm carries the award's id");

  r = renderBand({ conf: awardGated, preview: { live: {}, flags: {} } });
  ok(r.award !== null, "R15 the Preview Center renders the gated strip");

  r = renderBand({ conf: Object.assign({}, awardGated, { award: Object.assign({}, AWARD, { gate: "zz" }) }) });
  ok(r.award === null, "R16 a dangling award gate reference fails CLOSED");

  // All three pieces gated and unlocked together: one sorted meta.
  const allGated = {
    research: { enabled: true, gate: "br", institutions: INSTS },
    seal: { enabled: true, gate: "bs", imageUrl: "" },
    award: Object.assign({}, AWARD, { gate: "ba" }),
  };
  r = renderBand({ conf: allGated, unlocked: `1.br-${T0 + TTL}.bs-${T0 + TTL}.ba-${T0 + TTL}` });
  ok(r.node !== null && r.award !== null, "R17 all three unlock together");
  ok(r.meta(r.node, r.award) === "g:ba,br,bs", "R17 the meta lists every painted gated piece, sorted");
}

// ------------------------------------------------------------ static pins
{
  const pins = [
    ["if (seal.gate && !PREVIEW && !cxGateOpen(seal.gate, Date.now())) return null;", "the seal's gate guard is in the shipped builder"],
    ["var researchGated = !!(research && research.gate) && !PREVIEW && !cxGateOpen(research.gate, Date.now());", "the research band's gate guard is in the shipped builder"],
    ["if (aw.gate && !PREVIEW && !cxGateOpen(aw.gate, Date.now())) return null;", "the award strip's gate guard is in the shipped builder (v28)"],
    ["track('buy_box_proof', 'impression', bbpGateMeta(conf, research, award));", "the impression carries the gate meta for all three pieces"],
    ["if (typeof meta === 'string' && meta) payload.meta = meta;", "track() forwards meta to the beacon"],
    ["'apps/cellexia/gate'", "the proxy path is the documented one"],
  ];
  for (const [needle, why] of pins) ok(SRC.includes(needle), `PIN ${why}`);

  // The raw parameter must never be projected into either metafield mirror.
  const mf = fs.readFileSync(
    path.join(__dirname, "..", "..", "app", "services", "metafields.server.ts"), "utf8",
  );
  const mirrors = (mf.match(/paramGates: projectGates\(settings\.paramGates\),/g) || []).length;
  ok(mirrors === 2, "PIN both metafield mirrors project the registry down to digests");
  ok(mf.includes("gate.enabled !== true || !gate.param || !gate.token) continue;"),
    "PIN projectGates skips any gate that is off or incomplete");
}

if (failures === 0) {
  console.log(`ALL ${checks} CHECKS PASSED (v22 URL parameter gates vs the real cellexia-pdp.js module)`);
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
        name: "m1-clear-loses-to-open",
        find: "        if (cxIndexOf(found, clear) !== -1) {\n          delete stored[id];\n        } else if (cxIndexOf(found, open) !== -1) {",
        replace: "        if (cxIndexOf(found, open) !== -1) {\n          stored[id] = nowSeconds + CX_GATE_TTL;\n          matched.push(open);\n        } else if (cxIndexOf(found, clear) !== -1) {",
      },
      {
        name: "m2-expiry-not-enforced",
        find: "      if (!isFinite(expiry) || expiry <= nowSeconds) continue;",
        replace: "      if (!isFinite(expiry)) continue;",
      },
      {
        name: "m3-seal-gate-dropped",
        find: "    if (seal.gate && !PREVIEW && !cxGateOpen(seal.gate, Date.now())) return null;",
        replace: "    if (false) return null;",
      },
      {
        name: "m4-research-gate-dropped",
        find: "    var researchGated = !!(research && research.gate) && !PREVIEW && !cxGateOpen(research.gate, Date.now());",
        replace: "    var researchGated = false;",
      },
      {
        name: "m6-sync-not-deduped",
        find: "      if (window.__cxGateSynced) return;\n      window.__cxGateSynced = true;",
        replace: "      if (false) return;",
      },
      {
        name: "m5-version-not-checked",
        find: "    if (parts[0] !== CX_GATE_VERSION) return out;",
        replace: "    if (false) return out;",
      },
      {
        // v28: the award strip's guard (R13).
        name: "m7-award-gate-dropped",
        find: "    if (aw.gate && !PREVIEW && !cxGateOpen(aw.gate, Date.now())) return null;",
        replace: "    if (false) return null;",
      },
    ],
  });
  if (bad.length) {
    console.log(`\nMUTANTS NOT CAUGHT: ${bad.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("ALL 7 MUTANTS CAUGHT (v22 parameter gates)");
  }
}
