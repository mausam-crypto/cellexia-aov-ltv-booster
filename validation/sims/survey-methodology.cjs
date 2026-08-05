/**
 * v7 survey sim — runs the REAL per-product outcomes survey extracted from
 * extensions/cellexia-booster/assets/cellexia-pdp.js (vm + function
 * extraction, the house sim convention). Successor of the v6.11
 * methodology-token sim: the five v5.8 display formats are retired and the
 * widget is per-product (cfg.survey = {total: sample size, rec?: validated
 * recommend count, t?/q?/intro?: merchant overrides, o: outcome rows
 * {s: statement, y: yes count}, method/verifier/url}); ALL outcome math
 * happens in the JS builder with the same fail-closed rules the Liquid
 * gate applies.
 *
 * Panel cases (methodology disclosure — carried over from v6.11, numbers
 * now per-product):
 *   M1 merchant text with tokens  -> one <p> per non-blank line, tokens
 *      substituted with the product numbers (total = sample size,
 *      yes = rec, percent = round(rec/total*100)), textContent-only;
 *   M2 token-less merchant text   -> rendered verbatim;
 *   M3 token whitespace variants  -> {{total}} / {{  percent  }} etc.;
 *   M4 blank / whitespace-only method -> built-in p1..p5 path (p3 keeps
 *      the question class, collapsed-space separators);
 *   M5 verifier line: with URL -> .cx-survey__panel-verify wraps a
 *      .cx-proof__link anchor (href pinned); without URL -> plain text;
 *      no verifier -> no verify paragraph;
 *   M6 fail-safe numbers: missing/non-finite rec/total substitute 0;
 *   M7 markup-shaped merchant text stays textContent (no innerHTML).
 *
 * Section cases (the v7 outcomes builder):
 *   S1 full build — eyebrow, rec headline (round(248/270*100) = 92%),
 *      rec_line headline text, outcomes intro, one <li> per valid row with
 *      derived pct (243/270 -> 90, 200/270 -> 74), decorative bar fill
 *      width = pct%, sentinel-substituted "y of total agreed" micro-label,
 *      disclosure appended;
 *   S2 invalid rows dropped — y <= 0, y > total, blank statement;
 *   S3 fail closed — zero valid rows AND no valid rec -> null; valid rec
 *      alone -> headline without intro/list; rows alone -> list without
 *      headline;
 *   S4 title override beats rec_line; title renders alone when no rec;
 *   S5 question blockquote when q present;
 *   S6 per-product intro override beats the built-in outcomes_intro;
 *   S7 missing/invalid total -> null regardless of rows;
 *   S8 rec out of range (rec > total) -> demoted to no-headline;
 *   S9 markup-shaped statements stay textContent;
 *   S10 zero-arg builder + marker attrs (data-cx-feature=derm_survey).
 *
 * v8 compact cases (C1-C7 — cfg.<section>.compact LIVE settings ride the
 * islands as lean "cm": 1 members; d.cm === 1 branches in the builders):
 *   C1 survey compact structure — --compact root modifier, quoted
 *      question + intro dropped, top line = the FIRST valid row
 *      (strong pct + ' — statement'), "+ N more outcomes" disclosure
 *      button, the FULL surveyBuildOutcomes list parked behind [hidden]
 *      with id=cx-survey-outcomes, methodology disclosure unchanged;
 *   C2 more-button label math = rows − 1;
 *   C3 bindSurveyMore toggles [hidden] + aria-expanded both ways;
 *   C4 single valid row -> top line only (no button, no list);
 *   C5 missing more_outcomes string -> list ships VISIBLE (degrade,
 *      never unreachable);
 *   C6 study compact = cx-study--compact modifier, DOM otherwise
 *      IDENTICAL to full mode (pure CSS recomposition);
 *   C7 bottle compact = slim band: no body/points/cx-bottle__content
 *      (they live in the unchanged modal), icon disc + title + the
 *      data-cx-guarantee-check trigger on one row; full mode untouched.
 *
 * Stubs: the shared mini-DOM; decodeEntities runs real but sim strings
 * avoid '&' so it is identity by its own guard; cxIcon runs real — the
 * mini-DOM stores innerHTML verbatim without parsing, so it degrades to
 * an empty text node exactly as fail-closed design intends.
 *
 * MUTATION TESTS (all must be CAUGHT — non-zero exit on a mutant copy):
 *   m1-wrong-token-value   total substituted with the yes count (M1)
 *   m2-innerhtml-sink      merchant <p> built via innerHTML (M7)
 *   m3-merchant-branch-off custom text silently ignored (M1/M2)
 *   m4-blank-lines-kept    blank merchant lines render empty <p>s (M1)
 *   m5-invalid-rows-kept   row validation dropped (S2)
 *   m6-fail-open-empty     empty survey renders instead of null (S3)
 *   m7-pct-ceil            row percent ceiling instead of rounding (S1)
 *   m11-compact-always-on  compact gate d.cm === 1 inverted to true (S1:
 *                          full mode must carry NO --compact modifier)
 *   m12-more-toggle-broken bindSurveyMore no longer flips [hidden] (C3)
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
  "extensions", "cellexia-booster", "assets", "cellexia-pdp.js",
);
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;
const SRC = fs.readFileSync(SRC_PATH, "utf8");

let checks = 0, failures = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.error("FAIL: " + label); }
}

// ---------------------------------------------------------------- sandbox
const EXTRACTED = extractAll(SRC, {
  vars: ["CX_AZ_ICONS"],
  functions: [
    "decodeEntities",
    "cxEl",
    "cxSp",
    "cxIcon",
    "bottleStr",
    "cxRawStr",
    "surveyData",
    "surveyStr",
    "surveyBuildPanel",
    "surveyBuildHow",
    "surveyEyebrow",
    "surveyBuildOutcomes",
    "surveyBuildSection",
    "surveyDesign",
    "surveyAgreeText",
    "surveyHeadline",
    "surveyBuildCertSection",
    "surveyBuildDossierSection",
    "surveyBuildSealSection",
    "surveyBuildSealSvg",
    "bindSurveyMore",
    "bottleBuildNode",
    "studyData",
    "studyNum",
    "studyValSpan",
    "studyBuildSection",
  ],
});

const STRINGS = {
  eyebrow: "Independent dermatologist survey",
  how: "How the survey was conducted",
  verified_badge: "Third-party verified",
  verified_by: "Survey verified by Cosmetic Research Center",
  p1: "In May 2026, a research firm surveyed {{ total }} dermatologists.",
  p2: "Each dermatologist tested the products. They were then asked:",
  p3: "Would you recommend this product?",
  p4: "All answered. {{ yes }} said yes ({{ percent }}%).",
  p5: "The survey was requested by Cellexia.",
  rec_line: "of dermatologists surveyed would recommend this product",
  outcomes_intro: "The surveyed dermatologists also rated these outcomes:",
  outcome_agree: "@@YES@@ of @@TOTAL@@ agreed",
  more_outcomes: "+ @@N@@ more outcomes", // v8 compact (emitted only when compact is on)
};

function makeSandbox(survey) {
  const doc = makeDocument();
  const sandbox = {
    console,
    document: doc,
    cfg: { survey: survey, surveyStrings: STRINGS },
  };
  vm.createContext(sandbox);
  // decodeArea is IIFE module state in the shipped file; sim strings avoid
  // '&' so decodeEntities never touches it.
  vm.runInContext("var decodeArea;\n" + EXTRACTED, sandbox);
  return sandbox;
}

function buildPanel(sandbox) {
  vm.runInContext(
    "var __panel = cxEl('div', 'cx-survey__panel'); surveyBuildPanel(__panel);",
    sandbox,
  );
  return vm.runInContext("__panel", sandbox);
}

function buildSection(sandbox) {
  vm.runInContext("var __node = surveyBuildSection();", sandbox);
  return vm.runInContext("__node", sandbox);
}

function paragraphs(panel) {
  return panel.childNodes.filter((c) => c.nodeType === 1 && c.tagName === "P");
}

// Product numbers: sample 270, recommend 248 -> 92%.
const NUMBERS = { total: 270, rec: 248 };

// ============================================================ panel (M1-M7)

// --- M1: merchant text with tokens -------------------------------------------------
{
  const sb = makeSandbox(Object.assign({
    method: "We surveyed {{ total }} dermatologists.\n\n{{ yes }} answered yes — {{ percent }}% of respondents.",
  }, NUMBERS));
  const panel = buildPanel(sb);
  const ps = paragraphs(panel);
  ok(ps.length === 2, "M1: one <p> per non-blank merchant line (blank line dropped)");
  ok(ps[0] && ps[0].textContent === "We surveyed 270 dermatologists.",
    "M1: {{ total }} substituted with the product sample size");
  ok(ps[1] && ps[1].textContent === "248 answered yes — 92% of respondents.",
    "M1: {{ yes }} and {{ percent }} substituted from the rec count");
}

// --- M2: token-less merchant text verbatim -----------------------------------------
{
  const sb = makeSandbox(Object.assign({ method: "Our own wording, no numbers." }, NUMBERS));
  const ps = paragraphs(buildPanel(sb));
  ok(ps.length === 1 && ps[0].textContent === "Our own wording, no numbers.",
    "M2: token-less merchant text rendered verbatim");
}

// --- M3: token whitespace variants -------------------------------------------------
{
  const sb = makeSandbox(Object.assign({
    method: "{{total}} asked, {{  yes  }} yes, {{\tpercent\t}} percent.",
  }, NUMBERS));
  const ps = paragraphs(buildPanel(sb));
  ok(ps.length === 1 && ps[0].textContent === "270 asked, 248 yes, 92 percent.",
    "M3: flexible inner whitespace accepted for every token");
}

// --- M4: blank method -> built-in translated path ----------------------------------
for (const blank of ["", "   \n  \t ", undefined]) {
  const sb = makeSandbox(Object.assign({ method: blank }, NUMBERS));
  const panel = buildPanel(sb);
  const ps = paragraphs(panel);
  ok(ps.length === 5,
    `M4: built-in path renders five paragraphs (method=${JSON.stringify(blank)})`);
  ok(ps.length === 5 && ps[0].textContent === STRINGS.p1 && ps[4].textContent === STRINGS.p5,
    `M4: built-in paragraphs come from surveyStrings untouched (method=${JSON.stringify(blank)})`);
  ok(ps.length === 5 && (ps[2].attrs.class || "") === "cx-survey__panel-q",
    `M4: p3 keeps the question class (method=${JSON.stringify(blank)})`);
  const seps = panel.childNodes.filter((c) => c.nodeType === 3 && c.textContent === " ");
  ok(seps.length === 4,
    `M4: collapsed-space separators between built-in paragraphs (method=${JSON.stringify(blank)})`);
}

// --- M5: verifier line ---------------------------------------------------------------
{
  const sb = makeSandbox(Object.assign({
    method: "Custom text.",
    verifier: "Cosmetic Research Center",
    url: "https://example.com/survey",
  }, NUMBERS));
  const verify = buildPanel(sb).querySelector(".cx-survey__panel-verify");
  ok(!!verify, "M5: verifier paragraph present when verifier set");
  const link = verify && verify.querySelector("a.cx-proof__link");
  ok(!!link && link.getAttribute("href") === "https://example.com/survey",
    "M5: verified-by renders as a .cx-proof__link anchor with the merchant URL");
  ok(!!link && link.textContent === STRINGS.verified_by,
    "M5: anchor text is the translated verified_by string");

  const sb2 = makeSandbox(Object.assign({
    method: "Custom text.", verifier: "Cosmetic Research Center", url: "",
  }, NUMBERS));
  const verify2 = buildPanel(sb2).querySelector(".cx-survey__panel-verify");
  ok(!!verify2 && !verify2.querySelector("a") && verify2.textContent === STRINGS.verified_by,
    "M5: no URL -> plain text verified-by (no anchor)");

  const sb3 = makeSandbox(Object.assign({ method: "Custom text." }, NUMBERS));
  ok(!buildPanel(sb3).querySelector(".cx-survey__panel-verify"),
    "M5: no verifier -> no verify paragraph");

  const sb4 = makeSandbox(Object.assign({
    method: "", verifier: "Cosmetic Research Center", url: "https://example.com/survey",
  }, NUMBERS));
  ok(!!buildPanel(sb4).querySelector(".cx-survey__panel-verify a.cx-proof__link"),
    "M5: built-in branch appends the same linked verify paragraph");
}

// --- M6: fail-safe numbers + the rec-absent drop-line rule ---------------------------
{
  // v7: a product without a valid rec count has no truthful yes/percent —
  // merchant lines using those tokens are DROPPED, never zero-filled.
  const sb = makeSandbox({
    method: "We surveyed {{ total }} dermatologists.\n{{ yes }} recommended it.\nThat is {{ percent }}% of respondents.",
    total: 270,
  });
  const ps = paragraphs(buildPanel(sb));
  ok(ps.length === 1 && ps[0].textContent === "We surveyed 270 dermatologists.",
    "M6: rec-absent -> {{ yes }}/{{ percent }} lines dropped, {{ total }} line kept");

  const sb2 = makeSandbox({
    method: "We surveyed {{ total }} dermatologists.\n{{ yes }} recommended it.\nThat is {{ percent }}% of respondents.",
    total: 270, rec: 248,
  });
  const ps2 = paragraphs(buildPanel(sb2));
  ok(ps2.length === 3 && ps2[1].textContent === "248 recommended it." &&
    ps2[2].textContent === "That is 92% of respondents.",
    "M6: with a valid rec all lines render with real numbers");

  const sb3 = makeSandbox({ method: "{{ total }} asked.", rec: "nope", total: undefined });
  const ps3 = paragraphs(buildPanel(sb3));
  ok(ps3.length === 1 && ps3[0].textContent === "0 asked.",
    "M6: non-finite total still substitutes safely — no NaN, no raw token");
}

// --- M8: built-in path without p4 (rec-absent products omit the answer-count line) ---
{
  const NO_P4 = Object.assign({}, STRINGS);
  delete NO_P4.p4;
  const doc = makeDocument();
  const sandbox = { console, document: doc, cfg: { survey: { total: 270 }, surveyStrings: NO_P4 } };
  vm.createContext(sandbox);
  vm.runInContext("var decodeArea;\n" + EXTRACTED, sandbox);
  const panel = vm.runInContext(
    "var __p = cxEl('div', 'cx-survey__panel'); surveyBuildPanel(__p); __p;",
    sandbox,
  );
  const ps = paragraphs(panel);
  ok(ps.length === 4, "M8: absent p4 key -> four paragraphs, no empty <p>");
  ok(ps.length === 4 && ps[3].textContent === STRINGS.p5,
    "M8: p5 still closes the disclosure");
  ok(ps.length === 4 && (ps[2].attrs.class || "") === "cx-survey__panel-q",
    "M8: p3 keeps the question class in the shortened set");
  const seps = panel.childNodes.filter((c) => c.nodeType === 3 && c.textContent === " ");
  ok(seps.length === 3, "M8: separator count follows the appended paragraphs");
}

// --- M7: markup-shaped merchant text stays text --------------------------------------
{
  const sb = makeSandbox(Object.assign({
    method: "<script>alert(1)</script> {{ total }} <b>bold</b>",
  }, NUMBERS));
  const ps = paragraphs(buildPanel(sb));
  ok(ps.length === 1 &&
    ps[0].textContent === "<script>alert(1)</script> 270 <b>bold</b>",
    "M7: markup renders as literal text with tokens still substituted");
  ok(ps.length === 1 && ps[0].childNodes.length === 0 && ps[0]._innerHTML === null,
    "M7: textContent sink only — no parsed children, no innerHTML");
}

// ========================================================= section (S1-S10)

const OUTCOMES = [
  { s: "Visibly firmer skin after 8 weeks", y: 243 },
  { s: "Reduced wrinkle depth", y: 200 },
];

// --- S1: full build ------------------------------------------------------------------
{
  const sb = makeSandbox(Object.assign({ live: true, o: OUTCOMES }, NUMBERS));
  const node = buildSection(sb);
  ok(!!node && node.tagName === "SECTION" &&
    (node.attrs.class || "") === "cx-proof cx-survey",
    "S1: root section built with the v7 classes");
  ok(!!node && node.getAttribute("data-cx-feature") === "derm_survey",
    "S1: data-cx-feature marker intact");
  const eyebrow = node && node.querySelector(".cx-proof__eyebrow");
  ok(!!eyebrow && eyebrow.textContent === STRINGS.eyebrow, "S1: eyebrow rendered");
  const pct = node && node.querySelector(".cx-survey__rec-pct");
  ok(!!pct && pct.textContent === "92%", "S1: rec headline percent = round(248/270*100)");
  const headline = node && node.querySelector(".cx-survey__headline");
  ok(!!headline && headline.textContent === STRINGS.rec_line,
    "S1: headline falls back to the translated rec_line");
  const intro = node && node.querySelector(".cx-survey__intro");
  ok(!!intro && intro.textContent === STRINGS.outcomes_intro,
    "S1: outcomes intro rendered from the built-in string");
  const lis = node ? node.querySelectorAll("li.cx-survey__outcome") : [];
  ok(lis.length === 2, "S1: one <li> per valid outcome row");
  const pcts = node ? node.querySelectorAll(".cx-survey__outcome-pct") : [];
  ok(pcts.length === 2 && pcts[0].textContent === "90%" && pcts[1].textContent === "74%",
    "S1: row percents derived by rounding (243/270 -> 90, 200/270 -> 74)");
  const fills = node ? node.querySelectorAll(".cx-survey__bar-fill") : [];
  ok(fills.length === 2 && fills[0].style.width === "90%" && fills[1].style.width === "74%",
    "S1: decorative bar fill width = derived percent only");
  const bars = node ? node.querySelectorAll(".cx-survey__bar") : [];
  ok(bars.length === 2 && bars.every((b) => b.getAttribute("aria-hidden") === "true"),
    "S1: bars are aria-hidden (percent is already text)");
  const ns = node ? node.querySelectorAll(".cx-survey__outcome-n") : [];
  ok(ns.length === 2 && ns[0].textContent === "243 of 270 agreed" &&
    ns[1].textContent === "200 of 270 agreed",
    "S1: @@YES@@/@@TOTAL@@ sentinels substituted per row");
  const statements = node ? node.querySelectorAll(".cx-survey__outcome-statement") : [];
  ok(statements.length === 2 && statements[0].textContent === OUTCOMES[0].s,
    "S1: statements rendered via textContent");
  ok(!!node && !!node.querySelector(".cx-survey__how") &&
    !!node.querySelector(".cx-survey__panel"),
    "S1: methodology disclosure appended");
  ok(!!node && !!node.querySelector(".cx-survey__how-btn"),
    "S1: disclosure toggle button present for bindSurveyDisclosure");
}

// --- S2: invalid rows dropped --------------------------------------------------------
{
  const sb = makeSandbox(Object.assign({
    live: true,
    o: [
      { s: "Valid row", y: 100 },
      { s: "Zero yes", y: 0 },
      { s: "Above total", y: 271 },
      { s: "   ", y: 50 },
      { s: "Non-numeric", y: "many" },
      null,
    ],
  }, NUMBERS));
  const node = buildSection(sb);
  const lis = node ? node.querySelectorAll("li.cx-survey__outcome") : [];
  ok(lis.length === 1, "S2: invalid rows (y<=0, y>total, blank/missing statement) dropped");
  const st = node && node.querySelector(".cx-survey__outcome-statement");
  ok(!!st && st.textContent === "Valid row", "S2: the surviving row is the valid one");
}

// --- S3: fail-closed combinations ----------------------------------------------------
{
  const sb = makeSandbox({ live: true, total: 270, o: [{ s: "Too high", y: 999 }] });
  ok(buildSection(sb) === null,
    "S3: zero valid rows AND no rec -> null (nothing truthful to show)");

  const sb2 = makeSandbox({ live: true, total: 270, rec: 248, o: [] });
  const node2 = buildSection(sb2);
  ok(!!node2 && !!node2.querySelector(".cx-survey__rec-pct") &&
    !node2.querySelector(".cx-survey__intro") &&
    node2.querySelectorAll("li.cx-survey__outcome").length === 0,
    "S3: valid rec alone -> headline without intro or outcome list");

  const sb3 = makeSandbox({ live: true, total: 270, o: [{ s: "Only rows", y: 200 }] });
  const node3 = buildSection(sb3);
  ok(!!node3 && !node3.querySelector(".cx-survey__rec-pct") &&
    node3.querySelectorAll("li.cx-survey__outcome").length === 1,
    "S3: valid rows alone -> outcome list without the rec headline");
}

// --- S4: title override --------------------------------------------------------------
{
  const sb = makeSandbox(Object.assign({
    live: true, t: "93% would put their name on it", o: OUTCOMES,
  }, NUMBERS));
  const headline = buildSection(sb).querySelector(".cx-survey__headline");
  ok(!!headline && headline.textContent === "93% would put their name on it",
    "S4: per-product title override beats rec_line");

  const sb2 = makeSandbox({
    live: true, total: 270, t: "Standalone headline", o: [{ s: "Row", y: 100 }],
  });
  const node2 = buildSection(sb2);
  const headline2 = node2 && node2.querySelector(".cx-survey__headline");
  ok(!!headline2 && headline2.textContent === "Standalone headline" &&
    !node2.querySelector(".cx-survey__rec-pct"),
    "S4: title renders alone when no valid rec");
}

// --- S5: question blockquote ---------------------------------------------------------
{
  const sb = makeSandbox(Object.assign({
    live: true, q: "Would you recommend this to a patient?", o: OUTCOMES,
  }, NUMBERS));
  const quote = buildSection(sb).querySelector("blockquote.cx-survey__quote");
  ok(!!quote && quote.textContent === "Would you recommend this to a patient?",
    "S5: question renders as the blockquote when present");
  const sb2 = makeSandbox(Object.assign({ live: true, o: OUTCOMES }, NUMBERS));
  ok(!buildSection(sb2).querySelector("blockquote.cx-survey__quote"),
    "S5: no question -> no blockquote");
}

// --- S6: intro override --------------------------------------------------------------
{
  const sb = makeSandbox(Object.assign({
    live: true, intro: "270 dermatologists rated this cream:", o: OUTCOMES,
  }, NUMBERS));
  const intro = buildSection(sb).querySelector(".cx-survey__intro");
  ok(!!intro && intro.textContent === "270 dermatologists rated this cream:",
    "S6: per-product intro override beats the built-in outcomes_intro");
}

// --- S7: invalid total ---------------------------------------------------------------
{
  for (const total of [0, -5, "270", undefined, NaN]) {
    const sb = makeSandbox({ live: true, total: total, rec: 200, o: OUTCOMES });
    ok(buildSection(sb) === null,
      `S7: invalid total (${JSON.stringify(total)}) -> null regardless of rows`);
  }
}

// --- S8: rec out of range ------------------------------------------------------------
{
  const sb = makeSandbox({ live: true, total: 270, rec: 271, o: OUTCOMES });
  const node = buildSection(sb);
  ok(!!node && !node.querySelector(".cx-survey__rec-pct"),
    "S8: rec > total demoted to no headline (rows still render)");
}

// --- S9: markup-shaped statements ----------------------------------------------------
{
  const sb = makeSandbox(Object.assign({
    live: true, o: [{ s: "<img src=x onerror=alert(1)> firmer skin", y: 100 }],
  }, NUMBERS));
  const st = buildSection(sb).querySelector(".cx-survey__outcome-statement");
  ok(!!st && st.textContent === "<img src=x onerror=alert(1)> firmer skin" &&
    st.childNodes.length === 0 && st._innerHTML === null,
    "S9: statements are textContent-only — markup renders literally");
}

// --- S10: zero-arg builder -----------------------------------------------------------
{
  const sb = makeSandbox(Object.assign({ live: true, o: OUTCOMES }, NUMBERS));
  const arity = vm.runInContext("surveyBuildSection.length", sb);
  ok(arity === 0, "S10: surveyBuildSection is zero-arg (format dispatch retired)");
  ok(vm.runInContext("typeof surveyData()", sb) === "object",
    "S10: surveyData still reads cfg.survey");
}

// --- S11: rec percent rounding mode (200/270 = 74.07 -> 74, not ceil 75) -------------
{
  const sb = makeSandbox({ live: true, total: 270, rec: 200, o: OUTCOMES });
  const pct = buildSection(sb).querySelector(".cx-survey__rec-pct");
  ok(!!pct && pct.textContent === "74%",
    "S11: rec headline percent uses Math.round (74%, ceil would give 75%)");
}

// ================================================== study builder (T1-T5)
// v7 merchant contract (2026-08-01 ask): the ENTIRE subject line is
// editable per product, and every protocol fact chip is optional — an
// empty field renders no chip, zero chips render no list.

const STUDY_STR = {
  eyebrow: "Independent clinical study",
  view: "View study summary",
  foot: "Measured under the supervision of dermatologists, not self-reported.",
  sub: "Tested on Cellular Renewal Cream itself — the exact formula on this page.",
  fn: "34 participants",
};

function buildStudy(data) {
  const doc = makeDocument();
  const sandbox = { console, document: doc, cfg: {} };
  vm.createContext(sandbox);
  vm.runInContext("var decodeArea;\n" + EXTRACTED, sandbox);
  sandbox.__data = data;
  vm.runInContext("var __node = studyBuildSection(__data);", sandbox);
  return vm.runInContext("__node", sandbox);
}

const STUDY_BASE = {
  live: true,
  t: "Clinically proven",
  r: [{ v: 91, s: "%", l: "firmer skin" }],
  str: STUDY_STR,
};

// --- T1: the subject line is fully editable ------------------------------------------
{
  const node = buildStudy(Object.assign({}, STUDY_BASE, {
    sub: "We tested this exact cream on real people.",
  }));
  const subj = node.querySelector(".cx-study__subject");
  ok(!!subj && subj.textContent === "We tested this exact cream on real people.",
    "T1: per-product subject replaces the ENTIRE built-in line verbatim");

  const node2 = buildStudy(Object.assign({}, STUDY_BASE));
  const subj2 = node2.querySelector(".cx-study__subject");
  ok(!!subj2 && subj2.textContent === STUDY_STR.sub,
    "T1: no override -> the built-in product-title line renders");

  const node3 = buildStudy(Object.assign({}, STUDY_BASE, { sub: "   " }));
  ok(node3.querySelector(".cx-study__subject").textContent === STUDY_STR.sub,
    "T1: whitespace-only override falls back to the built-in line");
}

// --- T2: all four protocol chips, in order -------------------------------------------
{
  const node = buildStudy(Object.assign({}, STUDY_BASE, {
    pn: 34, pw: "8-week study", pl: "Derma Consult GmbH",
    pi: "Measured with Cutometer MPA 580",
  }));
  const chips = node.querySelectorAll("li.cx-study__fact");
  ok(chips.length === 4, "T2: four filled fields -> four chips");
  ok(chips.length === 4 &&
    chips[0].textContent === "34 participants" &&
    chips[1].textContent === "8-week study" &&
    chips[2].textContent === "Derma Consult GmbH" &&
    chips[3].textContent === "Measured with Cutometer MPA 580",
    "T2: chip order is participants, duration, lab, instruments");
}

// --- T3: any chip can be left empty individually -------------------------------------
{
  const cases = [
    [{ pw: "8-week study", pl: "Lab", pi: "Measured with X" }, "participants"],
    [{ pn: 34, pl: "Lab", pi: "Measured with X" }, "duration"],
    [{ pn: 34, pw: "8-week study", pi: "Measured with X" }, "lab"],
    [{ pn: 34, pw: "8-week study", pl: "Lab" }, "instruments"],
  ];
  for (const [members, label] of cases) {
    const node = buildStudy(Object.assign({}, STUDY_BASE, members));
    ok(node.querySelectorAll("li.cx-study__fact").length === 3,
      `T3: empty ${label} field -> that chip absent, the rest render`);
  }
}

// --- T4: zero chips -> no list at all ------------------------------------------------
{
  const node = buildStudy(Object.assign({}, STUDY_BASE));
  ok(!node.querySelector(".cx-study__facts"),
    "T4: no protocol fields filled -> no chips list in the DOM");
}

// --- T5: zero/invalid participants never chip ----------------------------------------
{
  for (const pn of [0, -3, "34", undefined]) {
    const node = buildStudy(Object.assign({}, STUDY_BASE, { pn: pn, pl: "Lab" }));
    const chips = node.querySelectorAll("li.cx-study__fact");
    ok(chips.length === 1 && chips[0].textContent === "Lab",
      `T5: participants=${JSON.stringify(pn)} -> no participants chip`);
  }
}

// ================================================== v8 compact modes (C1-C7)
// cfg.dermSurvey.compact / cfg.clinicalStudy.compact /
// cfg.emptyBottleGuarantee.compact are LIVE display-density settings; the
// Liquid compresses each into a lean "cm": 1 island member (== true strict
// gate) and the builders branch on d.cm === 1.

// --- C1: survey compact structure ----------------------------------------------------
{
  const sb = makeSandbox(Object.assign({
    live: true, cm: 1, q: "Would you recommend this to a patient?", o: OUTCOMES,
  }, NUMBERS));
  const node = buildSection(sb);
  ok(!!node && (node.attrs.class || "") === "cx-proof cx-survey cx-survey--compact",
    "C1: compact root carries the --compact modifier");
  ok(!!node && node.getAttribute("data-cx-feature") === "derm_survey",
    "C1: data-cx-feature marker intact in compact mode");
  const pct = node && node.querySelector(".cx-survey__rec-pct");
  ok(!!pct && pct.textContent === "92%", "C1: rec headline percent survives compact");
  ok(!!node && !node.querySelector("blockquote.cx-survey__quote"),
    "C1: compact drops the quoted question (the vertical diet)");
  ok(!!node && !node.querySelector(".cx-survey__intro"),
    "C1: compact drops the outcomes intro");
  const top = node && node.querySelector(".cx-survey__top-line");
  const tp = top && top.querySelector("strong.cx-survey__top-pct");
  ok(!!tp && tp.textContent === "90%",
    "C1: top-line pct is the merchant's FIRST valid row in a <strong> (243/270 -> 90)");
  ok(!!top && top.textContent === "90% — Visibly firmer skin after 8 weeks",
    "C1: top line composes 'pct — statement'");
  const more = node && node.querySelector("button.cx-survey__more-btn");
  ok(!!more && more.getAttribute("data-cx-survey-more") === "" &&
    more.getAttribute("aria-expanded") === "false" &&
    more.getAttribute("aria-controls") === "cx-survey-outcomes",
    "C1: '+ N more outcomes' button carries the disclosure attrs");
  ok(!!more && more.textContent === "+ 1 more outcomes",
    "C1: button label substitutes rows - 1 into @@N@@");
  const list = node && node.querySelector(".cx-survey__outcomes");
  ok(!!list && list.getAttribute("id") === "cx-survey-outcomes" && list.hasAttribute("hidden"),
    "C1: the full outcome list is parked behind [hidden] under the button's id");
  ok(!!list && list.querySelectorAll("li.cx-survey__outcome").length === 2,
    "C1: the hidden list is the FULL surveyBuildOutcomes list (top row included)");
  ok(!!node && !!node.querySelector(".cx-survey__how") && !!node.querySelector(".cx-survey__panel"),
    "C1: methodology disclosure unchanged in compact mode");
}

// --- C2: more-button label math ------------------------------------------------------
{
  const sb = makeSandbox(Object.assign({
    live: true, cm: 1,
    o: OUTCOMES.concat([{ s: "Improved elasticity", y: 190 }, { s: "Smoother texture", y: 150 }]),
  }, NUMBERS));
  const more = buildSection(sb).querySelector(".cx-survey__more-btn");
  ok(!!more && more.textContent === "+ 3 more outcomes",
    "C2: four valid rows -> '+ 3 more outcomes' (rows - 1)");
}

// --- C3: bindSurveyMore toggles both ways --------------------------------------------
{
  const sb = makeSandbox(Object.assign({ live: true, cm: 1, o: OUTCOMES }, NUMBERS));
  vm.runInContext("var __w = surveyBuildSection(); bindSurveyMore(__w);", sb);
  const node = vm.runInContext("__w", sb);
  const btn = node.querySelector("[data-cx-survey-more]");
  const list = node.querySelector(".cx-survey__outcomes");
  ok(!!btn && !!list && list.hasAttribute("hidden"), "C3: list starts hidden");
  btn._fire("click");
  ok(!list.hasAttribute("hidden") && btn.getAttribute("aria-expanded") === "true",
    "C3: first press reveals the full list + flips aria-expanded");
  btn._fire("click");
  ok(list.hasAttribute("hidden") && btn.getAttribute("aria-expanded") === "false",
    "C3: second press hides it again");
}

// --- C4: single valid row -> top line only -------------------------------------------
{
  const sb = makeSandbox(Object.assign({ live: true, cm: 1, o: [OUTCOMES[0]] }, NUMBERS));
  const node = buildSection(sb);
  ok(!!node && !!node.querySelector(".cx-survey__top-line"),
    "C4: single row still renders the top line");
  ok(!!node && !node.querySelector(".cx-survey__more-btn") && !node.querySelector(".cx-survey__outcomes"),
    "C4: single row -> no disclosure button, no hidden list");
}

// --- C5: missing more_outcomes label -> list ships visible (degrade) -----------------
{
  const NO_MORE = Object.assign({}, STRINGS);
  delete NO_MORE.more_outcomes;
  const doc = makeDocument();
  const sandbox = {
    console, document: doc,
    cfg: { survey: Object.assign({ live: true, cm: 1, o: OUTCOMES }, NUMBERS), surveyStrings: NO_MORE },
  };
  vm.createContext(sandbox);
  vm.runInContext("var decodeArea;\n" + EXTRACTED, sandbox);
  const node = vm.runInContext("surveyBuildSection()", sandbox);
  ok(!!node && !node.querySelector(".cx-survey__more-btn"),
    "C5: missing more_outcomes string -> no dead button");
  const list = node && node.querySelector(".cx-survey__outcomes");
  ok(!!list && !list.hasAttribute("hidden"),
    "C5: the full list ships VISIBLE instead of unreachable (stale-island degrade)");
}

// --- C6: study compact = modifier only, DOM otherwise identical ----------------------
{
  const treeShape = (el) =>
    el.childNodes
      .filter((c) => c.nodeType === 1)
      .map((c) => `${c.tagName}[${c.attrs.class || ""}](${treeShape(c)})`)
      .join(",");
  const fullNode = buildStudy(Object.assign({}, STUDY_BASE, { pn: 34, pl: "Derma Consult GmbH" }));
  const compactNode = buildStudy(Object.assign({}, STUDY_BASE, { pn: 34, pl: "Derma Consult GmbH", cm: 1 }));
  ok((fullNode.attrs.class || "") === "cx-proof cx-study",
    "C6: full study root carries NO compact modifier");
  ok((compactNode.attrs.class || "") === "cx-proof cx-study cx-study--compact",
    "C6: compact study root = cx-study--compact modifier");
  ok(treeShape(fullNode) === treeShape(compactNode) && treeShape(compactNode).length > 0,
    "C6: compact DOM is otherwise IDENTICAL (pure CSS recomposition)");
}

// --- C7: bottle compact = slim band; full mode untouched -----------------------------
{
  const BOTTLE = {
    live: true,
    title: "Try it for 90 days, completely risk-free",
    body: "Return the empty bottle if you change your mind.",
    p1: "Point one", p2: "Point two", p3: "Point three",
    check: "Guarantee check",
  };
  const buildBottle = (data) => {
    const doc = makeDocument();
    const sandbox = { console, document: doc, cfg: {} };
    vm.createContext(sandbox);
    vm.runInContext("var decodeArea;\n" + EXTRACTED, sandbox);
    sandbox.__data = data;
    vm.runInContext("var __node = bottleBuildNode(__data);", sandbox);
    return vm.runInContext("__node", sandbox);
  };
  const fullNode = buildBottle(Object.assign({}, BOTTLE));
  ok((fullNode.attrs.class || "") === "cx-proof cx-bottle",
    "C7: full bottle root untouched (no compact modifier)");
  ok(!!fullNode.querySelector(".cx-bottle__content") &&
    !!fullNode.querySelector(".cx-bottle__body") &&
    fullNode.querySelectorAll("li.cx-bottle__point").length === 3,
    "C7: full mode keeps the content wrapper, body and three points");
  const slim = buildBottle(Object.assign({ cm: 1 }, BOTTLE));
  ok((slim.attrs.class || "") === "cx-proof cx-bottle cx-bottle--compact",
    "C7: compact bottle = the cx-bottle--compact slim band");
  ok(!slim.querySelector(".cx-bottle__content") &&
    !slim.querySelector(".cx-bottle__points") &&
    !slim.querySelector(".cx-bottle__body"),
    "C7: compact omits body/points/content wrapper (they live in the modal)");
  ok(!!slim.querySelector(".cx-bottle__icon"),
    "C7: icon disc present on the band");
  const title = slim.querySelector("h2.cx-bottle__title");
  ok(!!title && title.textContent === BOTTLE.title, "C7: title on the band row");
  const trigger = slim.querySelector("button.cx-bottle__check");
  ok(!!trigger && trigger.getAttribute("data-cx-guarantee-check") === "" &&
    trigger.textContent === BOTTLE.check,
    "C7: the guarantee-check modal trigger survives on the band");
}

// --- D1-D5: v8.8 survey DESIGNS (sd codes; presentation only) ------------------------
// Every design must render the FULL content: rec %, every valid outcome row
// with its derived pct AND the "@@YES@@ of @@TOTAL@@" micro-label, and the
// methodology disclosure — the designs recompose, never drop.
(function () {
  function designSurvey(sd) {
    return {
      live: true, sd: sd, total: 270, rec: 248,
      verifier: "Cosmetic Research Center",
      o: [
        { s: "Skin looked visibly firmer", y: 243 },
        { s: "Fine lines appeared reduced", y: 200 },
        { s: "Suitable for sensitive skin", y: 180 },
      ],
    };
  }
  function textOf(node) { return node ? node.textContent : ""; }
  function all(node, sel) { return node ? node.querySelectorAll(sel) : []; }

  // D1 certificate: modifier + pct + ruled table rows (statement + figures)
  var certRoot = buildSection(makeSandbox(designSurvey("c")));
  ok(certRoot && certRoot.className.indexOf("cx-survey--cert") !== -1, "D1: cert modifier class");
  ok(textOf(certRoot.querySelector(".cx-svyc__pct")) === "92%", "D1: cert big pct = 92%");
  var certRows = all(certRoot, ".cx-svyc__row");
  ok(certRows.length === 3, "D1: cert renders ALL 3 outcome rows");
  ok(textOf(certRows[0].querySelector(".cx-svyc__stmt")) === "Skin looked visibly firmer", "D1: cert statement text");
  ok(textOf(certRows[0].querySelector(".cx-svyc__figpct")) === "90%", "D1: cert row pct 243/270 -> 90%");
  ok(textOf(certRows[1].querySelector(".cx-svyc__frac")).indexOf("200") !== -1 &&
     textOf(certRows[1].querySelector(".cx-svyc__frac")).indexOf("270") !== -1, "D1: cert micro-label carries y and total");
  ok(!!certRoot.querySelector("[data-cx-survey-toggle]"), "D1: cert keeps the methodology disclosure");
  ok(all(certRoot, ".cx-survey__bar").length === 0, "D1: cert has no decorative bars (ruled table)");

  // D2 dossier: band + chip + indexed rows + gauge widths from numbers
  var dosRoot = buildSection(makeSandbox(designSurvey("d")));
  ok(dosRoot && dosRoot.className.indexOf("cx-survey--dossier") !== -1, "D2: dossier modifier class");
  ok(!!dosRoot.querySelector(".cx-svyd__band"), "D2: dossier ink band present");
  ok(!!dosRoot.querySelector(".cx-svyd__band-chip"), "D2: dossier verified chip (verifier set)");
  var dosRows = all(dosRoot, ".cx-svyd__row");
  ok(dosRows.length === 3, "D2: dossier renders ALL 3 outcome rows");
  ok(textOf(dosRows[0].querySelector(".cx-svyd__idx")) === "01" &&
     textOf(dosRows[2].querySelector(".cx-svyd__idx")) === "03", "D2: dossier zero-padded row indexes");
  ok(dosRows[1].querySelector(".cx-svyd__gauge-fill").style.width === "74%", "D2: dossier gauge width 200/270 -> 74%");
  ok(!!dosRoot.querySelector("[data-cx-survey-toggle]"), "D2: dossier keeps the methodology disclosure");
  var dosNoVer = designSurvey("d");
  dosNoVer.verifier = "";
  var dosRoot2 = buildSection(makeSandbox(dosNoVer));
  ok(dosRoot2 && !dosRoot2.querySelector(".cx-svyd__band-chip"), "D2b: no verifier -> no band chip");

  // D3 seal: svg seal with pct + verified sub-label + stat cards
  var sealRoot = buildSection(makeSandbox(designSurvey("s")));
  ok(sealRoot && sealRoot.className.indexOf("cx-survey--seal") !== -1, "D3: seal modifier class");
  var sealNum = sealRoot.querySelector(".cx-svys__seal-num");
  ok(sealNum && sealNum.textContent === "92%", "D3: seal svg carries the 92% figure");
  ok(all(sealRoot, ".cx-svys__card").length === 3, "D3: seal renders ALL 3 stat cards");
  ok(textOf(sealRoot.querySelector(".cx-svys__card-pct")) === "90%", "D3: seal first card pct");
  ok(!!sealRoot.querySelector("[data-cx-survey-toggle]"), "D3: seal keeps the methodology disclosure");

  // D4 unknown/absent sd codes fall through to classic (fail-closed)
  var weird = designSurvey("x");
  var classicRoot = buildSection(makeSandbox(weird));
  ok(classicRoot && classicRoot.className.indexOf("cx-survey--cert") === -1 &&
     classicRoot.className.indexOf("cx-survey--dossier") === -1 &&
     classicRoot.className.indexOf("cx-survey--seal") === -1 &&
     all(classicRoot, ".cx-survey__outcome").length === 3, "D4: unknown sd renders classic");

  // D5 designs ignore cm (inherently compact — no --compact modifier, full list)
  var certCm = designSurvey("c");
  certCm.cm = 1;
  var certCmRoot = buildSection(makeSandbox(certCm));
  ok(certCmRoot && certCmRoot.className.indexOf("cx-survey--compact") === -1 &&
     all(certCmRoot, ".cx-svyc__row").length === 3, "D5: cert ignores cm and shows every row");

  // D6 truthfulness: NO rec and NO title -> NO headline in any design
  // (rec_line is a continuation fragment; classic fails closed the same way)
  ["c", "d", "s"].forEach(function (sd) {
    var noRec = designSurvey(sd);
    delete noRec.rec;
    var r = buildSection(makeSandbox(noRec));
    ok(r && !r.querySelector(".cx-survey__headline"),
      "D6(" + sd + "): rec-less design renders NO rec_line headline");
    ok(r && r.querySelectorAll(sd === "c" ? ".cx-svyc__row" : sd === "d" ? ".cx-svyd__row" : ".cx-svys__card").length === 3,
      "D6(" + sd + "): outcome rows still render");
  });

  // D7 seal verified gating: the "verified" sub-label requires a verifier;
  // with neither rec nor verifier the seal graphic disappears entirely
  var sealNoVer = designSurvey("s");
  sealNoVer.verifier = "";
  var sealNoVerRoot = buildSection(makeSandbox(sealNoVer));
  ok(sealNoVerRoot && !sealNoVerRoot.querySelector(".cx-svys__seal-sub"),
    "D7: no verifier -> no verified sub-label under the seal");
  ok(sealNoVerRoot && !!sealNoVerRoot.querySelector(".cx-svys__seal-svg"),
    "D7: rec alone still shows the percentage seal");
  var sealBare = designSurvey("s");
  sealBare.verifier = "";
  delete sealBare.rec;
  var sealBareRoot = buildSection(makeSandbox(sealBare));
  ok(sealBareRoot && !sealBareRoot.querySelector(".cx-svys__seal") &&
     !sealBareRoot.querySelector(".cx-svys__seal-sub"),
    "D7b: neither rec nor verifier -> no seal graphic at all");
  // D7c accessible percent: the aria-hidden SVG figure is mirrored as text
  var sealFull = buildSection(makeSandbox(designSurvey("s")));
  ok(sealFull && sealFull.querySelector(".cx-vh") &&
     sealFull.querySelector(".cx-vh").textContent === "92%",
    "D7c: seal mirrors the percentage as visually-hidden text");
})();

// ---------------------------------------------------------------- mutants
if (!process.env.CX_SKIP_MUTANTS && failures === 0) {
  const failedMutants = runMutants({
    selfPath: __filename,
    srcPath: REAL_SRC,
    mutants: [
      {
        name: "m1-wrong-token-value",
        find: ".replace(/\\{\\{\\s*total\\s*\\}\\}/g, String(total))",
        replace: ".replace(/\\{\\{\\s*total\\s*\\}\\}/g, String(yes))",
      },
      {
        name: "m2-innerhtml-sink",
        find: "        p = document.createElement('p');\n        p.textContent = lineText;",
        replace: "        p = document.createElement('p');\n        p.innerHTML = lineText;",
      },
      {
        name: "m3-merchant-branch-off",
        find: "if (method.replace(/\\s+/g, '') !== '') {",
        replace: "if (false && method.replace(/\\s+/g, '') !== '') {",
      },
      {
        name: "m4-blank-lines-kept",
        find: "        if (!lineText) continue;",
        replace: "",
      },
      {
        name: "m5-invalid-rows-kept",
        find: "      if (y > 0 && y <= total && typeof o.s === 'string' && /\\S/.test(o.s)) {",
        replace: "      if (typeof o.s === 'string') {",
      },
      {
        name: "m15-seal-verified-ungated",
        find: "      if (ver) {\n        var sub = cxEl('span', 'cx-svys__seal-sub');",
        replace: "      if (true) {\n        var sub = cxEl('span', 'cx-svys__seal-sub');",
      },
      {
        name: "m16-headline-fallback-ungated",
        find: "    if (!title && !rec) return null;",
        replace: "",
      },
      {
        name: "m13-design-dispatch-dead",
        find: "    var sd = surveyDesign(d);",
        replace: "    var sd = '';",
      },
      {
        name: "m14-cert-drops-rows",
        find: "      for (var r = 0; r < rows.length; r++) {\n        var li = cxEl('li', 'cx-svyc__row');",
        replace: "      for (var r = 0; r < 1; r++) {\n        var li = cxEl('li', 'cx-svyc__row');",
      },
      {
        name: "m6-fail-open-empty",
        find: "    if (!rec && rows.length === 0) return null;",
        replace: "",
      },
      {
        name: "m7-pct-ceil",
        find: "rows.push({ s: o.s, y: y, pct: Math.round(y / total * 100) });",
        replace: "rows.push({ s: o.s, y: y, pct: Math.ceil(y / total * 100) });",
      },
      {
        name: "m8-drop-guard-removed",
        find: "        if (yes <= 0 && /\\{\\{\\s*(yes|percent)\\s*\\}\\}/.test(lineText)) continue;",
        replace: "",
      },
      {
        name: "m9-rec-pct-ceil",
        find: "el.textContent = Math.round(rec / total * 100) + '%';",
        replace: "el.textContent = Math.ceil(rec / total * 100) + '%';",
      },
      {
        name: "m10-empty-chip-list",
        find: "    if (facts.length > 0) {",
        replace: "    if (true) {",
      },
      {
        name: "m11-compact-always-on",
        find: "    var compact = d.cm === 1; // v8 display density (LIVE setting, no draft plumbing)",
        replace: "    var compact = true; // v8 display density (LIVE setting, no draft plumbing)",
      },
      {
        name: "m12-more-toggle-broken",
        find: "        var open = btn.getAttribute('aria-expanded') === 'true';\n        btn.setAttribute('aria-expanded', open ? 'false' : 'true');\n        if (open) list.setAttribute('hidden', '');\n        else list.removeAttribute('hidden');",
        replace: "        var open = btn.getAttribute('aria-expanded') === 'true';\n        btn.setAttribute('aria-expanded', open ? 'false' : 'true');",
      },
    ],
  });
  if (failedMutants > 0) {
    console.error(`\n${failedMutants} MUTANT(S) NOT CAUGHT`);
    process.exit(1);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${checks} CHECKS FAILED`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED (v7 per-product outcomes survey + v8 compact modes vs the real cellexia-pdp.js)`);
