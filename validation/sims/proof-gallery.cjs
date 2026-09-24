/**
 * v8 proof-library sim — runs the REAL press band / dermatologist
 * endorsement wall / results gallery renderers extracted BY NAME from
 * extensions/cellexia-booster/assets/cellexia-proof.js (vm + the shared
 * extraction helper, the house sim convention — never re-implementations).
 *
 * The proof surfaces are DB-backed (three Prisma tables behind the
 * /apps/cellexia/proof app-proxy endpoint); the renderers receive API
 * payloads and must fail closed on anything the server did not vouch for.
 * This sim feeds them FIXTURE payloads through a deterministic proofFetch
 * stub (the real proofFetch — network, timeout, retry — is deliberately
 * NOT extracted; the stub records the exact query string of every call so
 * the API contract pins stay byte-exact).
 *
 * Helper cases (H):
 *   H1 pfDecode — bounded ordered entity chain, &amp; last (no over-
 *      decode of double-escapes), non-string passthrough;
 *   H2 pfHttps — THE URL gate: https-only, no whitespace, kills
 *      javascript:/http:/protocol-relative/non-strings;
 *   H3 pfVideoFile — direct-media classification on the path only
 *      (query/hash stripped), page URLs and http rejected;
 *   H4 pfQuery/resultsParams — skips empties, encodes both sides,
 *      product ctx appends product=pid, brand ctx omits it;
 *   H5 pfRegionName — Intl region name in the page language, '' on
 *      malformed codes.
 *
 * Press cases (P): band structure + featured quote first (API order),
 *   aria-label group strip, rotate on logo click only, article link
 *   hides without a URL, text-name fallback for missing/insecure logos,
 *   fail-closed empty/invalid payloads, XSS quote stays inert text.
 *
 * Optional-quote cases (PL, v8.14): quotes are optional — a library with
 *   NO quotes renders the compact cx-press--logos band (strip only, no
 *   quote block, no buttons, density tiers + cue ignored like the wall);
 *   in a MIXED strip quote-less items are static span marks
 *   (cx-press__logo--static, no aria-pressed, no handler) and rotation
 *   starts at the FIRST QUOTEFUL item; wall cards without a quote drop
 *   the blockquote + pub attribution but keep their read link.
 *
 * Endorsement-wall cases (W): count headline (CLDR one/other pick,
 *   @@N@@ = API total), "Showing X of N" progress math, Show-more
 *   pagination 24 -> 48 -> 60 with the exact ?type=endorsements&page=2
 *   &per=24 pin + button retirement at the end and on a failed page,
 *   monogram fallback (abbreviation tokens like "Dr." skipped) vs https
 *   portrait, credentials · country line via Intl, invalid rows dropped
 *   (all-invalid wall renders nothing), expand-in-place quote toggle,
 *   missing read_full label degrades to an unclamped card.
 *
 * Results-gallery cases (R): scale-banner fallback chain (verifiedTotal
 *   -> banner_verified, else total -> banner_all, else the WHOLE module
 *   is null), card build from a full fixture (stacked before/after
 *   thumbs + tags, play badge, verified/lab badges, meta microline,
 *   clamped testimonial), media click -> lightbox open + click beacon,
 *   imageless / http-image rows dropped, lightbox video-vs-link-out
 *   modes, facet chips + drawer flow (open, pick -> exact refetch query,
 *   active chip label/state, tap-again clears), empty filtered state,
 *   clear-filters reset, Show-more append respecting the filtered total,
 *   failed refetch keeps current content, facet label fallbacks, XSS
 *   testimonial stays inert text.
 *
 * Ultra cases (U, v8.2 look, v8.3 island "cm": 2): press collapses to
 *   one row (quote starts [hidden], logo tap reveals + rotates, a
 *   second tap on the ACTIVE logo re-hides + clears every aria-pressed),
 *   endorsement wall composes ONE <p> head row (count · shown_of, per-
 *   part degrade, re-composed after Show more which appends into the SAME
 *   wall/rail), results gallery gains the --ultra root modifier only
 *   (CSS does the rest — chips/drawer/banner/cards byte-identical), plus
 *   paragraph coverage: endorsement quotes keep their \n\n in textContent
 *   (the CSS pre-line rule is pinned by harness section 5) and the
 *   expand-in-place toggle still works on a multi-paragraph quote. Every
 *   ultra case has a cm-absent TWIN proving the default path unchanged.
 *
 * Compact cases (C, v8.3 NEW middle tier — island "cm": 1): press keeps
 *   the quote ALWAYS visible under cx-press--compact (never [hidden]; no
 *   tap-to-reveal — logo taps rotate exactly like full, a re-tap on the
 *   ACTIVE logo never collapses), endorsement wall composes the SAME
 *   head line as ultra but as an H2 under cx-endo--compact (no eyebrow,
 *   no separate progress element, Show more appends + re-composes, the
 *   expand-in-place card toggle intact inside the compact wall), results
 *   gallery gains the cx-results--compact root modifier only (full
 *   banner, full chip row, full cards — CSS suppresses the desktop grid
 *   recomposition). Plus strict-code probes: cm must be the NUMBER 1/2 —
 *   '1'/'2'/0/3 all fall back to the full layout (no modifier).
 *
 * Preview-contract cases (V, review-flagged): pfWhenAllowed matrix on the
 *   real predicate (live:true immediate; live:false + __preview;
 *   live:false + cx_preview_ok sessionStorage; live:false + neither → NOT
 *   rendered — asserted on the synchronous path + pfPreviewVerified
 *   itself, never the poll) and pfBeaconsOff (suppressed under __preview
 *   OR cx_preview_token; cx_preview_ok alone does NOT suppress — the
 *   token is the suppression key; token alone never renders drafts).
 *
 * v33 cases (R25–R32, combined figure + compare slider + study design):
 *   payload.ui strict === 1 flag reads (anything else fails closed),
 *   combined-image mapping is lab-gated client-side (the serve-belt
 *   twin) and https-gated, ONE combo frame/figure with the joint
 *   Before / After tag, the slider stage for BOTH feeds (pair layers +
 *   200%-wide composite halves) incl. press-jump, keyboard, clamp math
 *   and the zoom control owning the lightbox + click beacon, the study
 *   card (band first, week-stamped After tag, no duplicate lab pill,
 *   disclaim footnote, customer cards untouched, fail-soft on missing
 *   proxy copy), flags flowing to Show-more cards, and the preview-only
 *   pv cache-buster staying out of shopper URLs.
 *
 * Stubs: shared mini-DOM (v8 extensions documented in lib/mini-dom.cjs:
 * createElementNS + documentElement.lang — nothing else); proofFetch
 * (records + feeds queued fixtures, cb(null) when the queue is empty =
 * fetch failure); pfTrack (records beacons); pfLbOpen (records opens —
 * the dialog focus-trap machinery is outside the extraction surface);
 * window.setInterval records-but-never-fires (V4 asserts the predicate,
 * not the poll).
 *
 * MUTATION TESTS (all must be CAUGHT — non-zero exit on a mutant copy):
 *   m1-https-guard-bypass    pfHttps returns any string unchecked (H2)
 *   m2-banner-inverted       banner_all preferred over banner_verified (R)
 *   m3-monogram-abbrev-kept  "Dr." tokens reach the monogram (W)
 *   m4-per-cap-dropped       endorsement pagination loses per=24 (W)
 *   m5-innerhtml-sink        results testimonial via innerHTML (R XSS)
 *   m6-imageless-rows-kept   the >=1-https-image card filter dropped (R)
 *   m7-press-cm-gate-inverted   ultra = cm !== 2 (caught by the U
 *                               normal-mode twin: quote must stay visible)
 *   m8-press-reveal-broken      ultra logo tap no longer un-hides the
 *                               quote (U tap-reveal case)
 *   m9-preview-always-verified  pfPreviewVerified returns true for normal
 *                               visitors (V not-rendered case)
 *   m10-press-tier-confusion    the cm===1 branch treated as ULTRA
 *                               (caught by the C compact-tier case: the
 *                               quote must be VISIBLE without a tap)
 *   m13-press-logosonly-dead    logosOnly forced false (caught by PL1:
 *                               the --logos band must render)
 *   m14-press-static-lost       every strip item becomes a button (PL1
 *                               zero-button + PL3 static-span asserts)
 *   m15-press-first-quote-lost  rotation initialized at item 0 instead
 *                               of the first quoteful item (PL3)
 *   m32–m36 (v25 clinical)      lab gates ×2, copy whitelist, percent
 *                               cap, attribution textContent sink
 *   m37 (v26.2)                 one-decimal percent bound dropped
 *   m38–m42 (v33)               ui-flag strict reads loosened, combined
 *                               lab gate dropped, slider clamp dropped,
 *                               study lab gate dropped, week stamp on
 *                               weekless entries
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

// ---------------------------------------------------------------- sandbox
const EXTRACTED = extractAll(SRC, {
  vars: ["RESULTS_SKIN_KEYS", "RESULTS_DURATION_KEYS", "RESULTS_ICON_PATHS", "RESULTS_COMMA_DECIMAL"],
  functions: [
    "pfEl", "pfSp", "pfSvg", "pfDecode", "pfStr", "pfHttps", "pfVideoFile",
    "pfPosInt", "pfPageLocale", "pfRegionName", "pfQuery", "pfProductParams",
    "pfPreviewVerified", "pfBeaconsOff", "pfWhenAllowed", // v8.2: preview contract (V)
    "pressItems", "pressBuildWall", "pressBuildSection",
    "endoValidItems", "endoText", "endoBuildCard",
    "endoPanelBuild", "endoBuildSection", // v8.17 badge + v8.18 design builders:
    "endoBadgeShield", "endoBadgeBuild", "endoBadgeMount",
    "endoBadgeHeadParts", "endoBadgeAvatars", "endoBadgeOutlineShield",
    "endoBadgeCaduceus", "endoBadgeLaurel", "endoBadgeCrown",
    "endoBadgeChip", "endoBadgeTail", "endoApplyCopy",
    "pfStrRaw", // v8.22 raw reader for proxy-only copy codes
    "endoOverlayParas", "endoOverlayChevron", "endoOverlayFaq",
    "endoOverlayDocRow", // v8.22 official overlay + panel wall
    "endoOverlayNote", "endoOverlayBuild", "endoOverlayOpen",
    "resultsBannerData", "resultsFacetLabel", "resultsParams",
    "resultsValidItems", "resultsMetaLine", "resultsBadges",
    "resultsBuildFrame", "resultsBuildCard", "resultsBuildLightbox",
    "resultsFacetGroups", "resultsBuildSection",
    // v25 clinical redesign
    "resultsIcon", "resultsApplyCopy", "resultsValidMeasurements",
    "resultsAttr", "resultsClinical",
    // v26.2 decimal percents
    "resultsValidPct", "resultsFmtPct",
    // v33 combined figure + compare slider + study design
    "resultsUiFlags", "resultsAfterTag", "resultsComboTag",
    "resultsComboFrame", "resultsSliderPct", "resultsSliderSet",
    "resultsSlider", "resultsStudyHead", "resultsDisclaim",
  ],
});

// Deterministic stubs (declared before the extracted pieces; function
// declarations hoist, so proofFetch may call the extracted pfQuery).
const STUBS = [
  "var PF_FETCH_CALLS = [];",
  "var PF_FETCH_QUEUE = [];",
  "var PF_TRACKS = [];",
  "var PF_LB_OPENED = [];",
  "function proofFetch(type, params, cb) {",
  "  PF_FETCH_CALLS.push({ type: type, qs: '?type=' + type + pfQuery(params || {}) });",
  "  cb(PF_FETCH_QUEUE.length ? PF_FETCH_QUEUE.shift() : null);",
  "}",
  "function pfTrack(feature, type) { PF_TRACKS.push([feature, type || 'impression']); }",
  "function pfLbOpen(root, trigger) { PF_LB_OPENED.push(root); }",
].join("\n");

const doc = makeDocument();
// v8.2 (V series): setInterval records-but-never-fires so the preview
// matrix asserts pfWhenAllowed's SYNCHRONOUS path and the pfPreviewVerified
// predicate — never the poll (deterministic, no timers).
const INTERVALS = [];
const S = {
  console,
  document: doc,
  // window.Intl must be truthy for pfRegionName's guard; matchMedia is
  // deliberately absent -> isMobile() true (the guarded degrade path).
  window: {
    Intl,
    setInterval(fn, ms) { INTERVALS.push({ fn, ms }); return INTERVALS.length; },
    clearInterval() { /* recorded timers never fire */ },
  },
};
vm.createContext(S);
vm.runInContext(STUBS + "\n\n" + EXTRACTED, S);

function click(el) {
  el._fire("click", { target: el, preventDefault() { /* noop */ } });
}

// ---------------------------------------------------------------- fixtures

// Island str maps as the Liquid t|json emission ships them.
const STR = {
  bv: "See results from @@N@@ real Cellexia users.",
  ba: "See results from @@N@@ Cellexia users.",
  fc: "Concern", fa: "Age", fs: "Skin type", fd: "Duration",
  sd: "Dry", so: "Oily", sc: "Combination", ss: "Sensitive", sn: "Normal",
  d1: "Under 8 weeks", d2: "8–12 weeks", d3: "Over 12 weeks",
  ay: "@@R@@ years",
  vb: "Verified purchase", lb: "Clinical study result", vid: "Video",
  wk: "@@N@@ weeks of use", bef: "Before", aft: "After",
  more: "Show more", empty: "No results match these filters yet.",
  close: "Close", clear: "Clear filters",
};

const ENDO_STR = {
  eyebrow: "Dermatologist endorsements",
  one: "Endorsed by @@N@@ dermatologist",
  other: "Endorsed by @@N@@ dermatologists",
  shown: "Showing @@SHOWN@@ of @@TOTAL@@",
  more: "Show more",
  read: "Read full endorsement",
  // v8.17 additions as the island ships them (desc + badge strings; the
  // o* merchant overrides ride the same map and default to null/blank).
  desc: "Verified recommendations from licensed dermatologists.",
  bh1: "Recommended by @@N@@ dermatologist",
  bh2: "Recommended by @@N@@ dermatologists",
  bl: "Read their professional assessments",
  bv: "Verified professional assessments",
  chip: "Licensed dermatologists", // v8.18 credential chip
  cls: "Close", // v8.21 overlay close label (reused results.close)
};

const PRESS_STR = { eyebrow: "As seen in the press", aria: "As seen in the press", read: "Read the article" };

function endoFixture(count, offset) {
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({
      id: "e" + (offset + i),
      name: "Dr. Anna W" + (offset + i),
      credentials: "MD",
      country: "DE",
      quote: "Quote " + (offset + i),
      imageUrl: (offset + i) % 2 === 0 ? "https://cdn/p" + (offset + i) + ".jpg" : null,
    });
  }
  return items;
}

const RES_ITEM = {
  id: "r1",
  beforeUrl: "https://cdn/b.jpg",
  afterUrl: "https://cdn/a.jpg",
  videoUrl: "https://cdn/v.mp4",
  ageRange: "25-34",
  skinType: "dry",
  concern: "wrinkles",
  durationWeeks: 8,
  country: "DE",
  testimonial: "My skin changed.",
  verified: true,
  source: "customer",
};

function resultsFixture() {
  return {
    total: 40,
    verifiedTotal: 25,
    items: [
      RES_ITEM,
      { beforeUrl: "https://cdn/b2.jpg", afterUrl: "https://cdn/a2.jpg", skinType: "oily", verified: false, source: "lab" },
    ],
    facets: {
      concerns: [{ value: "wrinkles", count: 12 }, { value: "firmness", count: 8 }],
      ages: [{ value: "25-34", count: 9 }],
      skins: [{ value: "dry", count: 7 }, { value: "oily", count: 5 }],
      durations: [{ value: "8to12", count: 11 }],
    },
  };
}

// v25 clinical fixtures — the proxy-carried UI copy + a lab entry with
// the full clinical panel data (docs/SPEC-v25-results-redesign.md).
const CLIN_COPY = {
  rp: "Real people. Real results.",
  ma: "Clinically measured at @@N@@ weeks",
  vsb: "vs. baseline",
  mi: "Instrument measured",
  mp: "Same patient",
  mu: "Unretouched images",
  // v33 codes
  aw: "After @@N@@ weeks",
  dr: "Drag to compare",
  iv: "Individual results may vary.",
  zm: "View larger",
};
const STR_CLIN = Object.assign({}, STR, CLIN_COPY);
const RES_LAB = {
  id: "rl1",
  beforeUrl: "https://cdn/lb.jpg",
  afterUrl: "https://cdn/la.jpg",
  durationWeeks: 7,
  source: "lab",
  verified: false,
  testimonial: "I confirm these images are unretouched and from the same patient.",
  attributionName: "Dr. Lauren Bennett",
  attributionRole: "Consultant Dermatologist",
  measurements: [
    { label: "Under-eye wrinkle depth", dir: "down", pct: 18, info: "PRIMOS 3D scan." },
    { label: "Skin firmness", dir: "up", pct: 14, info: "Cutometer reading." },
    { label: "Puffiness", dir: "down", pct: 21.4 },
  ],
  markInstrument: true,
  markSamePatient: true,
  markUnretouched: true,
};

function pressFixture() {
  return {
    total: 3,
    items: [
      { publication: "Vogue", logoUrl: "https://cdn/vogue.svg", quote: "The quiet revolution.", articleUrl: "https://vogue.com/a" },
      { publication: "Elle", logoUrl: null, quote: "Skincare, decoded.", articleUrl: null },
      { publication: "Bazaar", logoUrl: "http://cdn/insecure.svg", quote: "Third quote.", articleUrl: "https://bazaar.com/b" },
    ],
  };
}

// ============================================================ helpers (H)

// --- H1: entity decode chain ---------------------------------------------------------
ok(S.pfDecode("a &amp; b") === "a & b", "H1: &amp; decodes");
ok(S.pfDecode("&#39;s &quot;x&quot;") === "'s \"x\"", "H1: quote entities decode");
ok(S.pfDecode("&lt;b&gt;") === "<b>", "H1: angle entities decode");
ok(S.pfDecode("&amp;lt;") === "&lt;", "H1: double-escapes collapse ONE level (&amp; last, no over-decode)");
ok(S.pfDecode(null) === null && S.pfDecode(12) === 12, "H1: non-strings pass through untouched");

// --- H2: the https gate --------------------------------------------------------------
ok(S.pfHttps("https://cdn.shopify.com/x.png") === "https://cdn.shopify.com/x.png", "H2: https URL passes");
ok(S.pfHttps("http://cdn.shopify.com/x.png") === "", "H2: http rejected");
ok(S.pfHttps("javascript:alert(1)") === "", "H2: javascript: rejected");
ok(S.pfHttps("//cdn.shopify.com/x.png") === "", "H2: protocol-relative rejected");
ok(S.pfHttps("https://a b.com") === "", "H2: whitespace rejected");
ok(S.pfHttps(42) === "", "H2: non-string rejected");

// --- H3: video classification --------------------------------------------------------
ok(S.pfVideoFile("https://cdn/x.mp4") === true, "H3: direct .mp4 is a media file");
ok(S.pfVideoFile("https://cdn/x.mp4?v=2#t") === true, "H3: query/hash stripped before the extension check");
ok(S.pfVideoFile("https://cdn/x.webm") === true, "H3: .webm is a media file");
ok(S.pfVideoFile("https://www.youtube.com/watch?v=abc") === false, "H3: a page URL is NOT a media file");
ok(S.pfVideoFile("http://cdn/x.mp4") === false, "H3: http media rejected (pfHttps gate first)");
ok(S.pfVideoFile("") === false, "H3: empty rejected");

// --- H4: query serialization + product scoping ---------------------------------------
ok(S.pfQuery({ a: "x y", b: "", c: null, d: 2 }) === "&a=x%20y&d=2",
  "H4: pfQuery skips empties and encodes both sides");
ok(S.pfQuery({}) === "", "H4: empty params -> empty tail");
ok(
  S.pfQuery(S.resultsParams({ ctx: "product", pid: 123 }, { concern: "wrinkles", age: "", skin: "dry", duration: "8to12", page: 2 })) ===
    "&concern=wrinkles&skin=dry&duration=8to12&page=2&per=12&product=123",
  "H4: product ctx -> full filter query string with per=12 + product",
);
ok(
  S.pfQuery(S.resultsParams({ ctx: "brand", pid: 0 }, { concern: "", age: "", skin: "", duration: "", page: 1 })) ===
    "&page=1&per=12",
  "H4: brand ctx omits product",
);

// --- H5: region names ----------------------------------------------------------------
ok(S.pfRegionName("de") === "Germany", "H5: ISO2 renders via Intl.DisplayNames in the page language");
ok(S.pfRegionName("") === "" && S.pfRegionName("DEU") === "", "H5: malformed codes render nothing");

// ============================================================== press (P)

// --- P1: band structure + featured quote first ---------------------------------------
{
  const section = S.pressBuildSection({ str: PRESS_STR }, pressFixture());
  ok(!!section && section.getAttribute("data-cx-feature") === "press", "P1: press marker on the root");
  const logos = section ? section.querySelectorAll(".cx-press__logo") : [];
  ok(logos.length === 3, "P1: one logo button per item");
  ok(logos.length === 3 && logos[0].getAttribute("aria-pressed") === "true",
    "P1: item 0 (featured-first API order) starts selected");
  const qt = section && section.querySelector(".cx-press__quote-text");
  ok(!!qt && qt.textContent === "The quiet revolution.", "P1: featured quote shown first");
  const pub = section && section.querySelector(".cx-press__pub");
  ok(!!pub && pub.textContent === "Vogue", "P1: publication name beside the quote");
  const strip = section && section.querySelector(".cx-press__logos");
  ok(!!strip && strip.getAttribute("role") === "group" &&
    strip.getAttribute("aria-label") === "As seen in the press",
    "P1: logo strip is a labelled group");
  const link = section && section.querySelector(".cx-proof__link");
  ok(!!link && link.getAttribute("href") === "https://vogue.com/a" && !link.hasAttribute("hidden"),
    "P1: article link shown with the item URL");
}

// --- P2: rotation on logo click; link hides without articleUrl -----------------------
{
  const section = S.pressBuildSection({ str: PRESS_STR }, pressFixture());
  const logos = section.querySelectorAll(".cx-press__logo");
  click(logos[1]);
  ok(section.querySelector(".cx-press__quote-text").textContent === "Skincare, decoded.",
    "P2: click rotates to the picked quote");
  ok(section.querySelector(".cx-press__pub").textContent === "Elle", "P2: publication follows");
  ok(logos[0].getAttribute("aria-pressed") === "false" && logos[1].getAttribute("aria-pressed") === "true",
    "P2: aria-pressed follows the selection");
  ok(section.querySelector(".cx-proof__link").hasAttribute("hidden"),
    "P2: no articleUrl -> the read link hides");
}

// --- P3: logo fallback text + http logo rejected -------------------------------------
{
  const section = S.pressBuildSection({ str: PRESS_STR }, pressFixture());
  const logos = section.querySelectorAll(".cx-press__logo");
  ok(!!logos[1].querySelector(".cx-press__logo-name"), "P3: missing logo -> text name");
  ok(!!logos[2].querySelector(".cx-press__logo-name") && !logos[2].querySelector(".cx-press__logo-img"),
    "P3: http logo drops to the text name (pfHttps gate)");
  const img = logos[0].querySelector(".cx-press__logo-img");
  ok(!!img && img.src === "https://cdn/vogue.svg", "P3: https logo renders as the image");
}

// --- P4: fail closed on empty/invalid payloads ---------------------------------------
ok(S.pressBuildSection({ str: PRESS_STR }, null) === null, "P4: null payload -> no band");
ok(S.pressBuildSection({ str: PRESS_STR }, { items: [] }) === null, "P4: zero items -> no band");
ok(S.pressBuildSection({ str: PRESS_STR }, { items: [{ quote: "Orphan quote" }] }) === null,
  "P4: publication-less rows dropped -> no band (quote alone is not an item)");

// --- P5: XSS quote stays inert text --------------------------------------------------
{
  const payload = "<b onmouseover=alert(1)>hi</b>";
  const section = S.pressBuildSection({ str: PRESS_STR }, { items: [{ publication: "P", quote: payload }] });
  const qt = section.querySelector(".cx-press__quote-text");
  ok(!!qt && qt.textContent === payload, "P5: markup-shaped quote renders literally");
  ok(!!qt && qt.childNodes.length === 0 && qt._innerHTML === null,
    "P5: textContent sink only — no parsed children, no innerHTML");
}

// --- Q1: v8.12 logo switch cue (lc:1 — FULL featured layout only) ---------------------
{
  const cued = S.pressBuildSection({ str: PRESS_STR, lc: 1 }, pressFixture());
  ok(!!cued && cued.className.indexOf("cx-press--cue") !== -1,
    "Q1: lc:1 adds the cue modifier on the full layout");
  const plain = S.pressBuildSection({ str: PRESS_STR }, pressFixture());
  ok(!!plain && plain.className.indexOf("cx-press--cue") === -1,
    "Q1b: no lc -> no cue (off by default)");
  const compactCued = S.pressBuildSection({ str: PRESS_STR, lc: 1, cm: 1 }, pressFixture());
  ok(!!compactCued && compactCued.className.indexOf("cx-press--cue") === -1,
    "Q1c: compact tier ignores the cue (full layout only)");
  const ultraCued = S.pressBuildSection({ str: PRESS_STR, lc: 1, cm: 2 }, pressFixture());
  ok(!!ultraCued && ultraCued.className.indexOf("cx-press--cue") === -1,
    "Q1d: ultra tier ignores the cue");
  const wallCued = S.pressBuildSection({ str: PRESS_STR, lc: 1, ly: "w" }, pressFixture());
  ok(!!wallCued && wallCued.className.indexOf("cx-press--cue") === -1,
    "Q1e: wall layout ignores the cue (nothing to switch)");
}

// --- PL1-PL4: v8.14 OPTIONAL quotes (logos-only band + static marks) -----------------
function logosOnlyFixture() {
  return {
    total: 3,
    items: [
      { publication: "Vogue", logoUrl: "https://cdn/vogue.svg", quote: "", articleUrl: "https://vogue.com/a" },
      { publication: "Elle", logoUrl: null, quote: null },
      { publication: "Bazaar", logoUrl: "http://cdn/insecure.svg" },
    ],
  };
}
{
  // PL1: no quotes at all -> the compact LOGOS-ONLY band (strip ends the band)
  const section = S.pressBuildSection({ str: PRESS_STR }, logosOnlyFixture());
  ok(!!section && section.className === "cx-proof cx-press cx-press--logos",
    "PL1: all-quote-less library -> cx-press--logos modifier");
  ok(!section.querySelector(".cx-press__quote") && !section.querySelector(".cx-press__quote-text"),
    "PL1: no quote block at all — the band ends at the strip");
  ok(section.querySelectorAll("button.cx-press__logo").length === 0,
    "PL1: nothing is a button (nothing to reveal)");
  const statics = section.querySelectorAll(".cx-press__logo--static");
  ok(statics.length === 3, "PL1: every mention renders as a static mark");
  ok(!section.querySelector("[hidden]"), "PL1: nothing [hidden]");
  const img = statics[0] && statics[0].querySelector(".cx-press__logo-img");
  ok(!!img && img.getAttribute("alt") === "Vogue",
    "PL1: static logo img carries the publication as its alt (no sr-only span needed)");
  ok(!!statics[1] && !!statics[1].querySelector(".cx-press__logo-name") &&
     !!statics[2] && !!statics[2].querySelector(".cx-press__logo-name"),
    "PL1: missing/http logo falls back to the wordmark name in the strip");
  const eyebrow = section.querySelector(".cx-proof__eyebrow");
  ok(!!eyebrow && eyebrow.textContent === "As seen in the press", "PL1: eyebrow kept");
  const strip = section.querySelector(".cx-press__logos");
  ok(!!strip && strip.getAttribute("role") === "group", "PL1: strip stays a labelled group");
  ok(!section.querySelector(".cx-proof__link"), "PL1: no read links in the logos-only band");
}
{
  // PL2: logos-only ignores density tiers AND the switch cue (wall precedent)
  const ultra = S.pressBuildSection({ str: PRESS_STR, cm: 2 }, logosOnlyFixture());
  ok(!!ultra && ultra.className === "cx-proof cx-press cx-press--logos",
    "PL2: cm:2 with no quotes stays the logos-only band (no --ultra)");
  const compact = S.pressBuildSection({ str: PRESS_STR, cm: 1 }, logosOnlyFixture());
  ok(!!compact && compact.className.indexOf("cx-press--compact") === -1,
    "PL2: cm:1 with no quotes -> no --compact tier");
  const cued = S.pressBuildSection({ str: PRESS_STR, lc: 1 }, logosOnlyFixture());
  ok(!!cued && cued.className.indexOf("cx-press--cue") === -1,
    "PL2: lc:1 with no quotes -> no switch cue (nothing to switch)");
}
{
  // PL3: MIXED strip — quote-less items are static marks, quoteful rotate
  const mixed = {
    total: 3,
    items: [
      { publication: "Vogue", logoUrl: "https://cdn/vogue.svg", quote: "", articleUrl: "https://vogue.com/a" },
      { publication: "Elle", logoUrl: null, quote: "Skincare, decoded.", articleUrl: null },
      { publication: "Bazaar", logoUrl: "https://cdn/bazaar.svg", quote: "Third quote.", articleUrl: "https://bazaar.com/b" },
    ],
  };
  const section = S.pressBuildSection({ str: PRESS_STR }, mixed);
  ok(!!section && section.className === "cx-proof cx-press",
    "PL3: a single quote keeps the normal featured band (no --logos)");
  const logos = section.querySelectorAll(".cx-press__logo");
  ok(logos.length === 3, "PL3: every mention stays in the strip, quote-less included");
  ok(section.querySelectorAll("button.cx-press__logo").length === 2,
    "PL3: only quoteful items are buttons");
  ok(logos[0].tagName === "SPAN" &&
     (logos[0].attrs.class || "").indexOf("cx-press__logo--static") !== -1 &&
     !logos[0].hasAttribute("aria-pressed"),
    "PL3: the quote-less mention is a static span with no aria-pressed");
  ok(section.querySelector(".cx-press__quote-text").textContent === "Skincare, decoded.",
    "PL3: rotation starts at the FIRST QUOTEFUL item, not item 0");
  ok(logos[1].getAttribute("aria-pressed") === "true" &&
     logos[2].getAttribute("aria-pressed") === "false",
    "PL3: aria-pressed starts on the first quoteful button");
  click(logos[0]);
  ok(section.querySelector(".cx-press__quote-text").textContent === "Skincare, decoded.",
    "PL3: tapping a static mark changes nothing (no handler bound)");
  click(logos[2]);
  ok(section.querySelector(".cx-press__quote-text").textContent === "Third quote." &&
     logos[2].getAttribute("aria-pressed") === "true" &&
     logos[1].getAttribute("aria-pressed") === "false",
    "PL3: quoteful buttons still rotate normally around the static mark");
  ok(!logos[0].hasAttribute("aria-pressed"),
    "PL3: rotation never stamps aria-pressed onto the static span");
}
{
  // PL4: WALL cards without a quote — bare logo/name card, no dangling foot
  const mixed = {
    total: 3,
    items: [
      { publication: "Vogue", logoUrl: "https://cdn/vogue.svg", quote: "The quiet revolution.", articleUrl: "https://vogue.com/a" },
      { publication: "Elle", logoUrl: "https://cdn/elle.svg", quote: "", articleUrl: "https://elle.com/x" },
      { publication: "Bazaar", logoUrl: null },
    ],
  };
  const section = S.pressBuildSection({ str: PRESS_STR, ly: "w" }, mixed);
  const cards = section.querySelectorAll(".cx-press__wall-card");
  ok(cards.length === 3, "PL4: quote-less mentions still get wall cards");
  ok(section.querySelectorAll(".cx-press__wall-quote").length === 1,
    "PL4: only the quoteful card carries a blockquote");
  const pubs = section.querySelectorAll(".cx-press__pub");
  ok(pubs.length === 1 && pubs[0].textContent === "Vogue",
    "PL4: attribution only where a LOGO header has a quote to attribute (a bare logo card self-attributes)");
  ok(!!cards[1].querySelector(".cx-proof__link"),
    "PL4: a quote-less card keeps its read link when an articleUrl exists");
  ok(!cards[2].querySelector(".cx-press__wall-foot"),
    "PL4: name-only quote-less card has no footer at all");
}

// --- W1-W4: v8.10 WALL layout (ly:'w' — all quotes visible, no interaction) ----------
{
  const section = S.pressBuildSection({ str: PRESS_STR, ly: "w" }, pressFixture());
  ok(!!section && section.className.indexOf("cx-press--wall") !== -1, "W1: wall modifier class");
  const cards = section.querySelectorAll(".cx-press__wall-card");
  ok(cards.length === 3, "W1: EVERY item renders its own card");
  ok(section.querySelectorAll(".cx-press__logo").length === 0 &&
     !section.querySelector("[data-cx-press-logo]"),
    "W1: no rotation logo buttons in the wall");
  ok(!section.querySelector("[hidden]"), "W1: nothing [hidden] — every quote visible");
  const quotes = section.querySelectorAll(".cx-press__wall-quote");
  ok(quotes.length === 3 && quotes[0].textContent === "The quiet revolution." &&
     quotes[1].textContent === "Skincare, decoded.",
    "W2: quotes render in API order with full text");
  // link only on the item that has an articleUrl
  const links = section.querySelectorAll(".cx-proof__link");
  ok(links.length === 2 && links[0].getAttribute("href") === "https://vogue.com/a" &&
     links[1].getAttribute("href") === "https://bazaar.com/b",
    "W3: read links only where an articleUrl exists (items 0 and 2, never 1)");
  // logo image when https, name fallback otherwise
  ok(!!cards[0].querySelector(".cx-press__wall-logo") &&
     !cards[1].querySelector(".cx-press__wall-logo") &&
     !!cards[1].querySelector(".cx-press__wall-name"),
    "W3b: https logo renders, missing logo falls back to the name");
  // footer attribution only under a logo IMAGE header — the name-fallback
  // header IS the attribution (no duplicated wordmark)
  const pubs = section.querySelectorAll(".cx-press__pub");
  ok(pubs.length === 1 && pubs[0].textContent === "Vogue",
    "W3c: attribution only under logo-image headers (name headers self-attribute)");
}
{
  // W4: wall ignores density codes (inherently compact — no tier classes)
  const section = S.pressBuildSection({ str: PRESS_STR, ly: "w", cm: 2 }, pressFixture());
  ok(!!section && section.className.indexOf("cx-press--wall") !== -1 &&
     section.className.indexOf("cx-press--ultra") === -1 &&
     section.className.indexOf("cx-press--compact") === -1,
    "W4: wall + cm:2 stays the wall (density ignored)");
  // and an unknown ly code falls through to the featured layout
  const feat = S.pressBuildSection({ str: PRESS_STR, ly: "x" }, pressFixture());
  ok(!!feat && feat.className.indexOf("cx-press--wall") === -1 &&
     !!feat.querySelector(".cx-press__logos"),
    "W4b: unknown ly code renders the featured layout (fail closed)");
}

// ==================================================== endorsement wall (W)

// --- W1: v8.22 — the monogram filler is GONE from the whole asset --------------------
ok(SRC.indexOf("endoInitials") === -1 && SRC.indexOf("cx-endo__monogram") === -1,
  "W1: no initials-monogram machinery anywhere (a letter circle reads as a fake avatar)");

// --- W2: headline + progress math on the first page ----------------------------------
{
  const section = S.endoBuildSection({ ctx: "brand", pid: 0, str: ENDO_STR }, { total: 60, items: endoFixture(24, 0) });
  ok(!!section && section.getAttribute("data-cx-feature") === "derm_endorsements",
    "W2: derm_endorsements marker on the root");
  ok(section.querySelector(".cx-endo__headline").textContent === "Endorsed by 60 dermatologists",
    "W2: count headline carries the API total (the scale claim)");
  ok(section.querySelector(".cx-endo__progress").textContent === "Showing 24 of 60",
    "W2: progress line = shown of total");
  ok(section.querySelectorAll(".cx-endo__card").length === 24, "W2: 24 cards on page 1");
  const more = section.querySelector(".cx-endo__show-more");
  ok(!!more && !more.hasAttribute("hidden"), "W2: Show more visible while shown < total");
}

// --- W3: pagination 24 -> 48 -> 60, button retires at the end ------------------------
{
  const section = S.endoBuildSection({ ctx: "brand", pid: 0, str: ENDO_STR }, { total: 60, items: endoFixture(24, 0) });
  const more = section.querySelector(".cx-endo__show-more");
  S.PF_FETCH_CALLS.length = 0;
  S.PF_FETCH_QUEUE.push({ total: 60, items: endoFixture(24, 24) });
  click(more);
  ok(S.PF_FETCH_CALLS[0].qs === "?type=endorsements&page=2&per=24",
    "W3: page-2 fetch pins the exact query (per=24, the server cap)");
  ok(section.querySelector(".cx-endo__progress").textContent === "Showing 48 of 60",
    "W3: progress advances to 48 of 60");
  ok(!more.hasAttribute("hidden"), "W3: button stays while more remain");
  S.PF_FETCH_QUEUE.push({ total: 60, items: endoFixture(12, 48) });
  click(more);
  ok(section.querySelector(".cx-endo__progress").textContent === "Showing 60 of 60",
    "W3: final page completes the wall");
  ok(more.hasAttribute("hidden"), "W3: button retires once shown >= total");
  ok(section.querySelectorAll(".cx-endo__card").length === 60, "W3: all 60 cards appended");
}

// --- W4: failed/empty next page retires the button, keeps the wall -------------------
{
  const section = S.endoBuildSection({ ctx: "brand", pid: 0, str: ENDO_STR }, { total: 60, items: endoFixture(24, 0) });
  const more = section.querySelector(".cx-endo__show-more");
  click(more); // queue empty -> proofFetch stub delivers null (fetch failure)
  ok(more.hasAttribute("hidden"), "W4: failed page -> button retired");
  ok(section.querySelectorAll(".cx-endo__card").length === 24, "W4: existing wall untouched");
}

// --- W5: CLDR one-form for a single endorsement --------------------------------------
{
  const section = S.endoBuildSection({ ctx: "brand", pid: 0, str: ENDO_STR }, { total: 1, items: endoFixture(1, 0) });
  ok(section.querySelector(".cx-endo__headline").textContent === "Endorsed by 1 dermatologist",
    "W5: total 1 picks the CLDR one form");
}

// --- W6: portrait when present; photo-less cards lead with the name ------------------
{
  const withImg = S.endoBuildCard({ n: "Dr. Anna Weiss", q: "Q", c: "MD", cc: "DE", img: "https://cdn/p.jpg" }, ENDO_STR);
  const photo = withImg.querySelector(".cx-endo__photo");
  ok(!!photo && photo.src === "https://cdn/p.jpg", "W6: https portrait used when present");
  const noImg = S.endoBuildCard({ n: "Dr. Anna Weiss", q: "Q", c: "MD", cc: "DE", img: "" }, ENDO_STR);
  ok(!noImg.querySelector(".cx-endo__photo") &&
     !noImg.querySelector(".cx-endo__head").querySelector("span"),
    "W6: no portrait -> NO avatar element at all (v8.22: monogram filler removed)");
  ok(noImg.querySelector(".cx-endo__name").textContent === "Dr. Anna Weiss",
    "W6: photo-less card still leads with the name");
}

// --- W7: credentials · country line --------------------------------------------------
{
  const card = S.endoBuildCard({ n: "Dr. A B", q: "Q", c: "MD", cc: "DE", img: "" }, ENDO_STR);
  ok(card.querySelector(".cx-endo__creds").textContent === "MD · Germany",
    "W7: credentials + Intl country joined with the middot");
}

// --- W8: invalid rows dropped; all-invalid wall renders nothing ----------------------
{
  const data = { total: 3, items: [{ name: "X" }, { quote: "no name" }, { name: "Dr. O K", quote: "fine" }] };
  ok(S.endoValidItems(data).length === 1, "W8: rows need a name AND a quote");
  ok(S.endoBuildSection({ str: ENDO_STR }, { total: 2, items: [{ name: "X" }] }) === null,
    "W8: all-invalid payload -> no wall (fail closed)");
  ok(S.endoBuildSection({ str: ENDO_STR }, null) === null, "W8: null payload -> no wall");
}

// --- W9: expand-in-place toggle ------------------------------------------------------
{
  const card = S.endoBuildCard({ n: "Dr. A B", q: "Long quote", c: "", cc: "", img: "" }, ENDO_STR);
  const btn = card.querySelector(".cx-endo__more");
  ok(!!btn && btn.getAttribute("aria-expanded") === "false", "W9: read-full button starts collapsed");
  click(btn);
  ok(btn.getAttribute("aria-expanded") === "true" && card.className === "cx-endo__card cx-endo__card--open",
    "W9: first press unclamps the quote in place");
  click(btn);
  ok(card.className === "cx-endo__card", "W9: second press re-clamps");
}

// --- W10: missing read_full label degrades to an unclamped card ----------------------
{
  const card = S.endoBuildCard({ n: "Dr. A B", q: "Q", c: "", cc: "", img: "" }, {});
  ok(card.className === "cx-endo__card cx-endo__card--open",
    "W10: stale island -> full quote ships unclamped, never unreachable");
  ok(!card.querySelector(".cx-endo__more"), "W10: no dead button");
}

// ===================================================== results gallery (R)

// --- R1: scale-banner fallback chain -------------------------------------------------
{
  const b = S.resultsBannerData(STR, 60, 40);
  ok(!!b && b.tpl === STR.bv && b.n === 40, "R1: verifiedTotal wins the banner");
  const b2 = S.resultsBannerData(STR, 60, 0);
  ok(!!b2 && b2.tpl === STR.ba && b2.n === 60, "R1: verifiedTotal 0 -> banner_all with total");
  ok(S.resultsBannerData(STR, 0, 0) === null && S.resultsBannerData(STR, "x", null) === null,
    "R1: no truthful number -> null (module fails closed)");
}

// --- R2: full card fixture -----------------------------------------------------------
{
  const items = S.resultsValidItems({ items: [RES_ITEM] });
  ok(items.length === 1, "R2: the full fixture row is valid");
  const card = S.resultsBuildCard(items[0], STR);
  const thumbs = card.querySelectorAll(".cx-results__thumb");
  ok(thumbs.length === 2 && thumbs[0].src === "https://cdn/b.jpg" && thumbs[1].src === "https://cdn/a.jpg",
    "R2: stacked before/after thumbs in order");
  const tags = card.querySelectorAll(".cx-results__tag");
  ok(tags.length === 2 && tags[0].textContent === "Before" && tags[1].textContent === "After",
    "R2: Before/After tags on the frames");
  ok(!!card.querySelector(".cx-results__play"), "R2: play badge for a video row");
  ok(!!card.querySelector(".cx-results__badge--verified"), "R2: verified badge");
  ok(!card.querySelector(".cx-results__badge--lab"), "R2: no lab badge for a customer row");
  ok(card.querySelector(".cx-results__meta").textContent === "25-34 years · Dry · wrinkles · 8 weeks of use · Germany",
    "R2: meta microline composes age · skin · concern · weeks · country");
  ok(card.querySelector(".cx-results__quote").textContent === "My skin changed.",
    "R2: testimonial rendered");
}

// --- R3: media click -> lightbox + click beacon --------------------------------------
{
  const items = S.resultsValidItems({ items: [RES_ITEM] });
  const card = S.resultsBuildCard(items[0], STR);
  S.PF_LB_OPENED.length = 0;
  S.PF_TRACKS.length = 0;
  click(card.querySelector(".cx-results__media"));
  ok(S.PF_LB_OPENED.length === 1, "R3: media click opens the lightbox");
  ok(S.PF_TRACKS.length === 1 && S.PF_TRACKS[0][0] === "verified_before_after" && S.PF_TRACKS[0][1] === "click",
    "R3: click beacon rides the verified_before_after key");
}

// --- R4: XSS testimonial stays inert text --------------------------------------------
{
  const payload = "<img src=x onerror=alert(1)><script>x</" + "script>";
  const items = S.resultsValidItems({ items: [{ beforeUrl: "https://cdn/b.jpg", testimonial: payload }] });
  const card = S.resultsBuildCard(items[0], STR);
  const quote = card.querySelector(".cx-results__quote");
  ok(!!quote && quote.textContent === payload, "R4: raw payload preserved as text");
  ok(!!quote && quote.childNodes.length === 0 && quote._innerHTML === null,
    "R4: textContent sink only — no parsed children, no innerHTML");
}

// --- R5: imageless / http-image rows dropped -----------------------------------------
{
  const items = S.resultsValidItems({ items: [
    { testimonial: "no images" },
    { beforeUrl: "http://cdn/b.jpg" },
    { afterUrl: "https://cdn/a.jpg" },
  ] });
  ok(items.length === 1 && items[0].a === "https://cdn/a.jpg",
    "R5: a gallery card needs at least one https image");
}

// --- R6: lab badge from source=lab ---------------------------------------------------
{
  const items = S.resultsValidItems({ items: [{ beforeUrl: "https://cdn/b.jpg", source: "lab", verified: false }] });
  const card = S.resultsBuildCard(items[0], STR);
  ok(!!card.querySelector(".cx-results__badge--lab") && !card.querySelector(".cx-results__badge--verified"),
    "R6: lab rows badge as clinical, not verified");
}

// --- R7: lightbox video modes --------------------------------------------------------
{
  const items = S.resultsValidItems({ items: [RES_ITEM] });
  const lb = S.resultsBuildLightbox(items[0], STR);
  const video = lb.querySelector(".cx-lightbox__video");
  ok(!!video && video.src === "https://cdn/v.mp4" && video.getAttribute("controls") === "",
    "R7: direct media file -> inline <video controls>");
  ok(lb.querySelectorAll(".cx-lightbox__fig").length === 2, "R7: side-by-side figures");
  ok(lb.querySelectorAll(".cx-lightbox__cap")[0].textContent === "Before", "R7: captions on the figures");
  ok(lb.querySelector(".cx-lightbox__quote").textContent === "My skin changed.", "R7: full testimonial");
  ok(!!lb.querySelector(".cx-lightbox__meta"), "R7: full metadata line");
  ok(lb.querySelector(".cx-lightbox__close").getAttribute("aria-label") === "Close",
    "R7: translated close label");

  const pageItems = S.resultsValidItems({ items: [
    { beforeUrl: "https://cdn/b.jpg", videoUrl: "https://www.youtube.com/watch?v=1" },
  ] });
  const lb2 = S.resultsBuildLightbox(pageItems[0], STR);
  ok(!lb2.querySelector(".cx-lightbox__video"), "R7: page URL -> no inline player");
  const link = lb2.querySelector(".cx-lightbox__link");
  const a = link && link.childNodes.filter((c) => c.nodeType === 1)[0];
  ok(!!a && a.getAttribute("href") === "https://www.youtube.com/watch?v=1" &&
    a.getAttribute("rel") === "noopener nofollow",
    "R7: page URL -> plain link-out with rel=noopener nofollow");
}

// --- R8: section banner --------------------------------------------------------------
{
  const section = S.resultsBuildSection({ ctx: "product", pid: 9, str: STR }, resultsFixture());
  ok(!!section && section.getAttribute("data-cx-feature") === "verified_before_after",
    "R8: verified_before_after marker on the root (the moved EVIDENCE marker)");
  ok(section.querySelector(".cx-results__count").textContent === "25",
    "R8: the number rides its own <strong>");
  ok(section.querySelector(".cx-results__banner").textContent === "See results from 25 real Cellexia users.",
    "R8: verified wording with verifiedTotal");
}

// --- R9: verifiedTotal 0 falls back to banner_all ------------------------------------
{
  const fx = resultsFixture();
  fx.verifiedTotal = 0;
  const section = S.resultsBuildSection({ ctx: "brand", pid: 0, str: STR }, fx);
  ok(section.querySelector(".cx-results__banner").textContent === "See results from 40 Cellexia users.",
    "R9: honest non-verified wording with the total");
}

// --- R10: fail-closed section combinations -------------------------------------------
{
  const fx = resultsFixture();
  fx.total = 0;
  fx.verifiedTotal = 0;
  ok(S.resultsBuildSection({ str: STR }, fx) === null, "R10: zero totals -> no module");
  ok(S.resultsBuildSection({ str: STR }, null) === null, "R10: null payload -> no module");
  const fx2 = resultsFixture();
  fx2.items = [{ testimonial: "no media" }];
  ok(S.resultsBuildSection({ str: STR }, fx2) === null,
    "R10: a banner with no valid cards is broken proof -> no module");
}

// --- R11: chips + drawer built from facets -------------------------------------------
{
  const section = S.resultsBuildSection({ ctx: "brand", pid: 0, str: STR }, resultsFixture());
  const chips = section.querySelectorAll(".cx-results__chip");
  ok(chips.length === 5, "R11: 4 facet-group chips + the clear chip");
  ok(chips[0].textContent === "Concern", "R11: group chip carries its label");
  ok(section.querySelector(".cx-results__chip--clear").hasAttribute("hidden"),
    "R11: clear chip hidden while no filter is active");
  ok(section.querySelectorAll(".cx-results__group").length === 4, "R11: 4 drawer groups");
  const opts = section.querySelectorAll(".cx-results__opt");
  ok(opts.length === 6, "R11: one option per facet value");
  ok(opts[0].textContent === "wrinkles 12", "R11: option shows value + count");
  ok(section.querySelector(".cx-results__drawer").hasAttribute("hidden"), "R11: drawer starts closed");
}

// --- R12: no facets -> no filter UI --------------------------------------------------
{
  const fx = resultsFixture();
  fx.facets = {};
  const section = S.resultsBuildSection({ ctx: "brand", pid: 0, str: STR }, fx);
  ok(section.querySelectorAll(".cx-results__chip").length === 0 && !section.querySelector(".cx-results__drawer"),
    "R12: facet-less payload ships no chips and no drawer");
}

// --- R13: filter pick -> refetch with the exact query, chip state --------------------
{
  const section = S.resultsBuildSection({ ctx: "product", pid: 9, str: STR }, resultsFixture());
  const chips = section.querySelectorAll(".cx-results__chip");
  const drawer = section.querySelector(".cx-results__drawer");
  click(chips[0]);
  ok(!drawer.hasAttribute("hidden"), "R13: chip opens the drawer");
  ok(chips[0].getAttribute("aria-expanded") === "true", "R13: chips reflect the open drawer");
  const opts = section.querySelectorAll(".cx-results__opt");
  S.PF_FETCH_CALLS.length = 0;
  S.PF_FETCH_QUEUE.push({ total: 12, verifiedTotal: 9, items: [RES_ITEM] });
  click(opts[0]); // concern: wrinkles
  ok(S.PF_FETCH_CALLS[0].qs === "?type=results&concern=wrinkles&page=1&per=12&product=9",
    "R13: pick refetches page 1 with the exact filter query");
  ok(drawer.hasAttribute("hidden"), "R13: selection closes the drawer");
  ok(chips[0].textContent === "Concern: wrinkles", "R13: active chip label = Group: Value");
  ok(chips[0].className === "cx-results__chip cx-results__chip--on", "R13: active chip carries --on");
  ok(!section.querySelector(".cx-results__chip--clear").hasAttribute("hidden"),
    "R13: clear chip appears with an active filter");
  ok(opts[0].getAttribute("aria-pressed") === "true", "R13: picked option is aria-pressed");
  ok(section.querySelectorAll(".cx-results__card").length === 1, "R13: rail re-rendered from the response");
}

// --- R14: empty filtered result -> empty state ---------------------------------------
{
  const section = S.resultsBuildSection({ ctx: "brand", pid: 0, str: STR }, resultsFixture());
  const opts = section.querySelectorAll(".cx-results__opt");
  S.PF_FETCH_QUEUE.push({ total: 0, verifiedTotal: 0, items: [], facets: {} });
  click(opts[1]); // firmness
  ok(section.querySelector(".cx-results__rail").hasAttribute("hidden"), "R14: rail hidden");
  const empty = section.querySelector(".cx-results__empty");
  ok(!empty.hasAttribute("hidden") && empty.textContent === "No results match these filters yet.",
    "R14: translated empty state shown");
  ok(section.querySelector(".cx-results__more").hasAttribute("hidden"), "R14: show-more hidden");
}

// --- R15: clear filters resets state + refetches without params ----------------------
{
  const section = S.resultsBuildSection({ ctx: "brand", pid: 0, str: STR }, resultsFixture());
  const opts = section.querySelectorAll(".cx-results__opt");
  S.PF_FETCH_QUEUE.push({ total: 12, verifiedTotal: 9, items: [RES_ITEM] });
  click(opts[0]);
  S.PF_FETCH_CALLS.length = 0;
  S.PF_FETCH_QUEUE.push(resultsFixture());
  click(section.querySelector(".cx-results__chip--clear"));
  ok(S.PF_FETCH_CALLS[0].qs === "?type=results&page=1&per=12",
    "R15: cleared filters vanish from the query");
  ok(section.querySelectorAll(".cx-results__chip")[0].textContent === "Concern",
    "R15: chip labels reset");
  ok(section.querySelectorAll(".cx-results__card").length === 2, "R15: full list restored");
}

// --- R16: show more appends and respects the filtered total --------------------------
{
  const fx = resultsFixture();
  fx.total = 3;
  const section = S.resultsBuildSection({ ctx: "brand", pid: 0, str: STR }, fx);
  const more = section.querySelector(".cx-results__more");
  ok(!more.hasAttribute("hidden"), "R16: show-more visible while shown < total");
  S.PF_FETCH_CALLS.length = 0;
  S.PF_FETCH_QUEUE.push({ total: 3, verifiedTotal: 2, items: [{ beforeUrl: "https://cdn/b3.jpg" }] });
  click(more);
  ok(S.PF_FETCH_CALLS[0].qs === "?type=results&page=2&per=12", "R16: page-2 fetch pinned");
  ok(section.querySelectorAll(".cx-results__card").length === 3, "R16: page appended, not replaced");
  ok(more.hasAttribute("hidden"), "R16: hidden once everything is shown");
}

// --- R17: failed refetch keeps current content ---------------------------------------
{
  const section = S.resultsBuildSection({ ctx: "brand", pid: 0, str: STR }, resultsFixture());
  const opts = section.querySelectorAll(".cx-results__opt");
  click(opts[0]); // queue empty -> cb(null)
  ok(section.querySelectorAll(".cx-results__card").length === 2,
    "R17: failed refetch never fakes an empty state — cards untouched");
  ok(section.querySelector(".cx-results__empty").hasAttribute("hidden"), "R17: empty state stays hidden");
}

// --- R18: facet label mapping + raw fallbacks ----------------------------------------
ok(S.resultsFacetLabel("skins", "dry", STR) === "Dry", "R18: skin value maps to its locale string");
ok(S.resultsFacetLabel("skins", "weird-new-type", STR) === "weird-new-type",
  "R18: unknown skin value stays honest raw data");
ok(S.resultsFacetLabel("durations", "8to12", STR) === "8–12 weeks", "R18: duration bucket label");
ok(S.resultsFacetLabel("ages", "25-34", STR) === "25-34 years", "R18: age range composes with the years label");
ok(S.resultsFacetLabel("ages", "25-34", {}) === "25-34", "R18: missing years label -> raw range");
ok(S.resultsFacetLabel("concerns", "wrinkles", STR) === "wrinkles", "R18: concerns are merchant slugs shown as data");

// ============================== v25 clinical redesign (R19–R24 + pins)

// --- R19: full clinical card — panel, tiles, marks, badge, attribution ---------------
{
  const items = S.resultsValidItems({ items: [RES_LAB] });
  ok(items.length === 1 && items[0].m.length === 3 && items[0].mk.mi && items[0].mk.mp && items[0].mk.mu,
    "R19: lab row surfaces measurements + all three trust marks");
  const card = S.resultsBuildCard(items[0], STR_CLIN);
  const panel = card.querySelector(".cx-results__clin");
  ok(!!panel, "R19: clinical panel renders on the card");
  ok(card.children[1] === panel, "R19: panel sits directly under the media (mock order)");
  ok(panel.querySelector(".cx-results__clin-title").textContent === "Clinically measured at 7 weeks",
    "R19: measured-at header composes @@N@@ with durationWeeks");
  ok(panel.querySelector(".cx-results__clin-base").textContent === "vs. baseline",
    "R19: vs-baseline tag renders");
  const tiles = panel.querySelectorAll(".cx-results__clin-tile");
  ok(tiles.length === 3, "R19: one tile per measurement");
  ok(tiles[0].querySelector(".cx-results__clin-label").textContent === "Under-eye wrinkle depth",
    "R19: tile label is the merchant text");
  const val0 = tiles[0].querySelector(".cx-results__clin-val");
  ok(val0.className === "cx-results__clin-val cx-results__clin-val--down" && val0.textContent === "18%",
    "R19: down metric carries the --down modifier and the bare percent");
  const val1 = tiles[1].querySelector(".cx-results__clin-val");
  ok(val1.className === "cx-results__clin-val cx-results__clin-val--up" && val1.textContent === "14%",
    "R19: up metric carries the --up modifier");
  ok(tiles[2].querySelector(".cx-results__clin-val").textContent === "21.4%",
    "R19: decimal percents render (dot on an en page, integers stay bare)");
  const marks = panel.querySelectorAll(".cx-results__clin-mark");
  ok(marks.length === 3 && marks[0].textContent === "Instrument measured" &&
    marks[1].textContent === "Same patient" && marks[2].textContent === "Unretouched images",
    "R19: the three checked trust marks render with their proxy labels");
  const lab = card.querySelector(".cx-results__badge--lab");
  ok(!!lab && lab.textContent === "Clinical study result" && !!lab.querySelector(".cx-results__badge-ic"),
    "R19: lab pill keeps its translated label and gains the flask icon");
  const attr = card.querySelector(".cx-results__attr");
  ok(!!attr && attr.textContent === "Dr. Lauren Bennett, Consultant Dermatologist",
    "R19: attribution renders name + role");
  const nameEl = card.querySelector(".cx-results__attr-name");
  ok(nameEl._innerHTML === null && nameEl.textContent === "Dr. Lauren Bennett",
    "R19: attribution name is a textContent sink");
  ok(card.querySelector(".cx-results__meta").textContent === "7 weeks of use",
    "R19: meta microline still composes for a lab row");
}

// --- R20: fail-closed gates + fail-soft chrome ---------------------------------------
{
  const customer = S.resultsValidItems({
    items: [Object.assign({}, RES_LAB, { source: "customer" })],
  });
  ok(customer[0].m.length === 0 && !customer[0].mk.mi && !customer[0].mk.mp && !customer[0].mk.mu,
    "R20: a customer row NEVER surfaces measurements or trust marks");
  ok(!S.resultsBuildCard(customer[0], STR_CLIN).querySelector(".cx-results__clin"),
    "R20: customer card ships no clinical panel");
  // second-defense pin (DIRECT call — the two lab gates are mutually
  // redundant through the public path, the v21.1 latch-pin precedent):
  ok(S.resultsClinical({ lab: false, m: [{ l: "X", d: "down", p: 9, i: "" }],
    mk: { mi: true, mp: false, mu: false }, weeks: 7 }, STR_CLIN) === null,
    "R20: resultsClinical itself refuses non-lab items");
  ok(S.resultsClinical({ lab: true, m: [], mk: { mi: false, mp: false, mu: false }, weeks: 7 }, STR_CLIN) === null,
    "R20: nothing to say -> no panel");
  // proxy copy absent (stale CDN): grid still renders, chrome fails soft
  const bare = S.resultsBuildCard(S.resultsValidItems({ items: [RES_LAB] })[0], STR);
  const barePanel = bare.querySelector(".cx-results__clin");
  ok(!!barePanel && barePanel.querySelectorAll(".cx-results__clin-tile").length === 3,
    "R20: missing copy strings never block the measured numbers");
  ok(!barePanel.querySelector(".cx-results__clin-head") && !barePanel.querySelector(".cx-results__clin-marks"),
    "R20: header and trust-mark row fail soft without their labels");
  // no weeks -> header keeps only the baseline tag
  const noWeeks = S.resultsValidItems({ items: [Object.assign({}, RES_LAB, { durationWeeks: null })] });
  const nwPanel = S.resultsBuildCard(noWeeks[0], STR_CLIN).querySelector(".cx-results__clin");
  ok(!nwPanel.querySelector(".cx-results__clin-title") && !!nwPanel.querySelector(".cx-results__clin-base"),
    "R20: weekless entry drops the measured-at line, keeps vs-baseline");
  // row validation: label/dir/pct all required, pct capped, cap at 6 rows
  ok(S.resultsValidMeasurements([
    { label: "ok", dir: "down", pct: 18 },
    { label: "ok2", dir: "down", pct: 34.2 },
    { label: "ok3", dir: "up", pct: 0.1 },
    { label: "", dir: "down", pct: 5 },
    { label: "x", dir: "sideways", pct: 5 },
    { label: "y", dir: "up", pct: 0 },
    { label: "z", dir: "up", pct: 9999 },
    { label: "w", dir: "up", pct: "12" },
    { label: "v", dir: "up", pct: 34.25 },
  ]).length === 3, "R20: invalid rows dropped (one-decimal 34.2/0.1 valid; 34.25, 0, 9999, strings not)");
  const eight = [];
  for (let i = 0; i < 8; i++) eight.push({ label: "m" + i, dir: "up", pct: 10 + i });
  ok(S.resultsValidMeasurements(eight).length === 6, "R20: measurement rows cap at 6");
}

// --- R21: info toggle — one shared note line, aria-expanded sync ---------------------
{
  const items = S.resultsValidItems({ items: [RES_LAB] });
  const panel = S.resultsBuildCard(items[0], STR_CLIN).querySelector(".cx-results__clin");
  const note = panel.querySelector(".cx-results__clin-note");
  const btns = panel.querySelectorAll(".cx-results__clin-info");
  ok(btns.length === 2, "R21: only rows WITH an info note get the toggle");
  ok(note.hasAttribute("hidden"), "R21: note starts hidden");
  click(btns[0]);
  ok(!note.hasAttribute("hidden") && note.textContent === "PRIMOS 3D scan." &&
    btns[0].getAttribute("aria-expanded") === "true",
    "R21: toggle reveals the tile's note");
  click(btns[1]);
  ok(note.textContent === "Cutometer reading." && btns[0].getAttribute("aria-expanded") === "false" &&
    btns[1].getAttribute("aria-expanded") === "true",
    "R21: second toggle swaps the note in place");
  click(btns[1]);
  ok(note.hasAttribute("hidden") && btns[1].getAttribute("aria-expanded") === "false",
    "R21: re-tap collapses");
}

// --- R21b (v26.2): decimal mark follows the page language --------------------------
{
  ok(S.resultsFmtPct(34.2) === "34.2%" && S.resultsFmtPct(34) === "34%",
    "R21b: no page language -> dot, integers bare");
  S.document.documentElement = { lang: "de-DE" };
  ok(S.resultsFmtPct(21.4) === "21,4%", "R21b: comma-decimal language renders the comma");
  ok(S.resultsFmtPct(21) === "21%", "R21b: integers carry no mark in any language");
  const items = S.resultsValidItems({ items: [RES_LAB] });
  const card = S.resultsBuildCard(items[0], STR_CLIN);
  const vals = card.querySelectorAll(".cx-results__clin-val");
  ok(vals[2].textContent === "21,4%", "R21b: the tile itself renders the localized mark");
  S.document.documentElement = { lang: "ja" };
  ok(S.resultsFmtPct(21.4) === "21.4%", "R21b: ja keeps the dot");
  S.document.documentElement = undefined;
}

// --- R22: resultsApplyCopy — whitelist, non-strings, blanks --------------------------
{
  const conf = { str: Object.assign({}, STR) };
  S.resultsApplyCopy(conf, { copy: { rp: "Tag", bv: "HACK", ma: 7, vsb: "   " } });
  ok(conf.str.rp === "Tag", "R22: whitelisted code merges");
  ok(conf.str.bv === STR.bv, "R22: island strings can never be overwritten (whitelist)");
  ok(!("ma" in conf.str) && !("vsb" in conf.str), "R22: non-strings and blanks are ignored");
  S.resultsApplyCopy(conf, null);
  S.resultsApplyCopy(null, { copy: { rp: "x" } });
  S.resultsApplyCopy(conf, { copy: "nope" });
  ok(conf.str.rp === "Tag", "R22: malformed payloads are inert");
}

// --- R23: section tagline + copy merge feeds later card builds -----------------------
{
  const fx = resultsFixture();
  fx.items = [RES_ITEM, RES_LAB];
  fx.copy = Object.assign({}, CLIN_COPY);
  const conf = { ctx: "brand", pid: 0, str: Object.assign({}, STR) };
  const section = S.resultsBuildSection(conf, fx);
  const tag = section.querySelector(".cx-results__tagline");
  ok(!!tag && tag.textContent === "Real people. Real results.",
    "R23: proxy copy renders the tagline under the banner");
  ok(section.querySelector(".cx-results__clin-title").textContent === "Clinically measured at 7 weeks",
    "R23: the merged copy feeds the clinical panels of the cards");
  const plain = S.resultsBuildSection({ ctx: "brand", pid: 0, str: Object.assign({}, STR) }, resultsFixture());
  ok(!plain.querySelector(".cx-results__tagline"), "R23: no copy member -> no tagline (fail soft)");
}

// --- R24: lightbox composition — svg close, clinical panel, foot row -----------------
{
  const items = S.resultsValidItems({ items: [RES_LAB] });
  const lb = S.resultsBuildLightbox(items[0], STR_CLIN);
  const close = lb.querySelector(".cx-lightbox__close");
  ok(close.getAttribute("aria-label") === "Close" && close.textContent === "" &&
    close.children.length === 1,
    "R24: close is the labeled icon button (no text glyph)");
  ok(!!lb.querySelector(".cx-results__clin") &&
    lb.querySelectorAll(".cx-results__clin-mark").length === 3,
    "R24: lightbox carries the same clinical panel + marks");
  const foot = lb.querySelector(".cx-lightbox__foot");
  ok(!!foot && !!foot.querySelector(".cx-lightbox__quote") &&
    foot.querySelector(".cx-results__attr").textContent === "Dr. Lauren Bennett, Consultant Dermatologist" &&
    !!foot.querySelector(".cx-lightbox__meta"),
    "R24: foot rows quote + attribution with the meta line");
  // quote-less, unattributed item: meta renders alone on the card
  const bareItem = S.resultsValidItems({ items: [Object.assign({}, RES_LAB, {
    testimonial: null, attributionName: null, attributionRole: null,
  })] })[0];
  const lb2 = S.resultsBuildLightbox(bareItem, STR_CLIN);
  ok(!lb2.querySelector(".cx-lightbox__foot") && !!lb2.querySelector(".cx-lightbox__meta"),
    "R24: no quote and no attribution -> no foot wrapper, meta stands alone");
}

// ================== v33 (combined figure · compare slider · study design)

// --- R25: payload.ui flag reads are strict and fail closed ---------------------------
{
  ok(JSON.stringify(S.resultsUiFlags({ ui: { cs: 1, sl: 1 } })) === '{"cs":true,"sl":true}',
    "R25: cs/sl === 1 read as on");
  ok(JSON.stringify(S.resultsUiFlags({ ui: {} })) === '{"cs":false,"sl":false}',
    "R25: empty ui -> both off");
  ok(JSON.stringify(S.resultsUiFlags({})) === '{"cs":false,"sl":false}',
    "R25: absent ui (old server) -> both off");
  ok(JSON.stringify(S.resultsUiFlags(null)) === '{"cs":false,"sl":false}',
    "R25: null data -> both off");
  ok(JSON.stringify(S.resultsUiFlags({ ui: { cs: "1", sl: true } })) === '{"cs":false,"sl":false}',
    "R25: '1'/true are not the NUMBER 1 -> off (strict)");
  ok(JSON.stringify(S.resultsUiFlags({ ui: "cs" })) === '{"cs":false,"sl":false}',
    "R25: non-object ui -> both off");
}

// --- R26: combined mapping — lab-gated (serve-belt twin) + https-gated ---------------
{
  const items = S.resultsValidItems({ items: [
    { id: "c1", combinedUrl: "https://cdn/combo.jpg", source: "lab" },
    { id: "c2", combinedUrl: "https://cdn/combo2.jpg", source: "customer" },
    { id: "c3", combinedUrl: "http://cdn/combo3.jpg", source: "lab" },
    { id: "c4", combinedUrl: "https://cdn/c4.jpg", beforeUrl: "https://cdn/b4.jpg", source: "customer" },
  ] });
  ok(items.length === 2,
    "R26: combined-only rows survive ONLY as lab rows with a https URL");
  ok(items[0].c === "https://cdn/combo.jpg" && items[0].b === "" && items[0].a === "",
    "R26: combined maps to c");
  ok(items[1].c === "" && items[1].b === "https://cdn/b4.jpg",
    "R26: a customer row's combined column never reaches c (client belt)");
}

// --- R27: combined card + lightbox (classic design, slider off) ----------------------
{
  const item = S.resultsValidItems({ items: [
    { id: "c1", combinedUrl: "https://cdn/combo.jpg", source: "lab", testimonial: "T" },
  ] })[0];
  const card = S.resultsBuildCard(item, Object.assign({}, STR_CLIN));
  const frames = card.querySelectorAll(".cx-results__frame");
  ok(frames.length === 1 && frames[0].className === "cx-results__frame cx-results__frame--combo",
    "R27: ONE combo frame");
  const thumb = card.querySelector(".cx-results__thumb");
  ok(!!thumb && thumb.src === "https://cdn/combo.jpg" &&
    thumb.className === "cx-results__thumb cx-results__thumb--combo",
    "R27: combo thumb keeps its natural-aspect modifier");
  const tag = card.querySelector(".cx-results__tag");
  ok(!!tag && tag.textContent === "Before / After", "R27: joint Before / After tag");
  ok(card.querySelector(".cx-results__media").tagName === "BUTTON",
    "R27: slider off -> the media stays the lightbox button");
  const lb = S.resultsBuildLightbox(item, Object.assign({}, STR_CLIN));
  ok(lb.querySelectorAll(".cx-lightbox__fig").length === 1,
    "R27: lightbox shows ONE combined figure");
  const lbImg = lb.querySelector(".cx-lightbox__img");
  ok(lbImg.className === "cx-lightbox__img cx-lightbox__img--combo" &&
    lbImg.src === "https://cdn/combo.jpg", "R27: lightbox combo modifier + src");
  ok(lb.querySelector(".cx-lightbox__cap").textContent === "Before / After",
    "R27: lightbox caption is the joint label");
}

// --- R28: slider stage — pair + combined feeds, drag/keys, zoom owns the lightbox ----
{
  const o = { cs: false, sl: true };
  const pairItem = S.resultsValidItems({ items: [RES_ITEM] })[0];
  const card = S.resultsBuildCard(pairItem, Object.assign({}, STR_CLIN), o);
  const media = card.querySelector(".cx-results__media");
  ok(media.tagName === "DIV" && media.className === "cx-results__media cx-results__media--slider",
    "R28: slider media is a plain div (no button nesting)");
  const stage = card.querySelector(".cx-results__ba");
  ok(!!stage && stage.className === "cx-results__ba", "R28: pair stage carries no combo modifier");
  const imgs = stage.querySelectorAll(".cx-results__ba-img");
  ok(imgs.length === 2 && imgs[0].src === RES_ITEM.afterUrl && imgs[1].src === RES_ITEM.beforeUrl,
    "R28: base = After, clipped top = Before");
  const top = stage.querySelector(".cx-results__ba-top");
  ok(top.style.clipPath === "inset(0 50% 0 0)", "R28: divider starts at the middle");
  const handle = stage.querySelector(".cx-results__ba-handle");
  ok(handle.getAttribute("role") === "slider" && handle.getAttribute("tabindex") === "0" &&
    handle.getAttribute("aria-valuenow") === "50" && handle.getAttribute("aria-label") === "Drag to compare",
    "R28: handle is a labelled slider control");
  const hint = stage.querySelector(".cx-results__ba-hint");
  ok(!!hint && hint.textContent === "Drag to compare" && !hint.hasAttribute("hidden"),
    "R28: drag hint shows until first use");
  const tags = stage.querySelectorAll(".cx-results__tag");
  ok(tags.length === 2 && /--ba\b/.test(tags[0].className) && /--ba-after/.test(tags[1].className),
    "R28: physical-side tags ride the stage");
  // press-jump: the sandbox has no PointerEvent -> the mouse path listens
  stage.getBoundingClientRect = () => ({ left: 0, width: 200 });
  stage._fire("mousedown", { clientX: 150, preventDefault() { /* noop */ }, type: "mousedown" });
  ok(top.style.clipPath === "inset(0 25% 0 0)" && handle.getAttribute("aria-valuenow") === "75",
    "R28: press jumps the divider to the pointer");
  ok(hint.hasAttribute("hidden"), "R28: first use hides the hint");
  handle._fire("keydown", { key: "ArrowLeft", preventDefault() { /* noop */ } });
  ok(handle.getAttribute("aria-valuenow") === "70", "R28: arrow keys step the divider");
  // zoom control owns the lightbox + the click beacon; RES_ITEM carries a
  // video, so the zoom label also announces it (the slider media's chip
  // is decorative — review C3) and no stray sr-only rides the div.
  const zoom = card.querySelector(".cx-results__zoom");
  ok(!!zoom && zoom.tagName === "BUTTON" &&
    zoom.getAttribute("aria-label") === "View larger · Video",
    "R28: zoom button labelled from zm + the video label");
  ok(!!media.querySelector(".cx-results__play") && !media.querySelector(".sr-only"),
    "R28: the play chip stays visual-only in slider media (sr text rides the zoom)");
  const opened = S.PF_LB_OPENED.length;
  S.PF_TRACKS.length = 0;
  click(zoom);
  ok(S.PF_LB_OPENED.length === opened + 1, "R28: zoom opens the lightbox");
  ok(JSON.stringify(S.PF_TRACKS) === '[["verified_before_after","click"]]',
    "R28: zoom sends the click beacon");
  // combined feed: 200%-wide halves over one stage
  const comboItem = S.resultsValidItems({ items: [
    { id: "c1", combinedUrl: "https://cdn/combo.jpg", source: "lab" },
  ] })[0];
  const comboCard = S.resultsBuildCard(comboItem, Object.assign({}, STR_CLIN), o);
  const comboStage = comboCard.querySelector(".cx-results__ba");
  ok(comboStage.className === "cx-results__ba cx-results__ba--combo", "R28: combo stage modifier");
  const comboImgs = comboStage.querySelectorAll(".cx-results__ba-img");
  ok(comboImgs[0].className === "cx-results__ba-img cx-results__ba-img--r" &&
    comboImgs[1].className === "cx-results__ba-img cx-results__ba-img--l" &&
    comboImgs[0].src === "https://cdn/combo.jpg" && comboImgs[1].src === "https://cdn/combo.jpg",
    "R28: right/left halves of the SAME composite");
  // single-image rows never build a broken stage
  const oneImg = S.resultsValidItems({ items: [{ beforeUrl: "https://cdn/b.jpg" }] })[0];
  const oneCard = S.resultsBuildCard(oneImg, Object.assign({}, STR_CLIN), o);
  ok(!oneCard.querySelector(".cx-results__ba") &&
    oneCard.querySelector(".cx-results__media").tagName === "BUTTON",
    "R28: one image -> classic media (slider needs both halves)");
  // the lightbox reuses the stage in slider mode
  const lb = S.resultsBuildLightbox(pairItem, Object.assign({}, STR_CLIN), o);
  ok(!!lb.querySelector(".cx-results__ba") && lb.querySelectorAll(".cx-lightbox__fig").length === 0,
    "R28: lightbox swaps figures for the compare stage");
}

// --- R33: capability gate — no aspect-ratio/clip-path support -> classic media -------
{
  const o = { cs: false, sl: true };
  const pairItem = S.resultsValidItems({ items: [RES_ITEM] })[0];
  S.window.CSS = { supports: function () { return false; } };
  const gated = S.resultsBuildCard(pairItem, Object.assign({}, STR_CLIN), o);
  ok(!gated.querySelector(".cx-results__ba") &&
    gated.querySelector(".cx-results__media").tagName === "BUTTON",
    "R33: a browser without aspect-ratio/clip-path gets the classic media (fail closed)");
  S.window.CSS = { supports: function () { return true; } };
  const passed = S.resultsBuildCard(pairItem, Object.assign({}, STR_CLIN), o);
  ok(!!passed.querySelector(".cx-results__ba"),
    "R33: a supporting browser builds the stage");
  delete S.window.CSS;
}

// --- R29: study design — band, week stamp, no duplicate pill, disclaim ---------------
{
  const o = { cs: true, sl: false };
  const labItem = S.resultsValidItems({ items: [RES_LAB] })[0];
  const card = S.resultsBuildCard(labItem, Object.assign({}, STR_CLIN), o);
  ok(card.className === "cx-results__card cx-results__card--study", "R29: study card modifier");
  const head = card.querySelector(".cx-results__study");
  ok(!!head && card.children[0] === head, "R29: the document band heads the card");
  ok(head.querySelector(".cx-results__study-t").textContent === "Clinical study result",
    "R29: band text = the lab badge string");
  const tags = card.querySelectorAll(".cx-results__tag");
  ok(tags[1].textContent === "After 7 weeks", "R29: After tag week-stamped via aw");
  ok(!card.querySelector(".cx-results__badge--lab"),
    "R29: the lab pill yields to the band (one credential)");
  const disc = card.querySelector(".cx-results__disclaim");
  ok(!!disc && disc.textContent === "Individual results may vary." &&
    card.children[card.children.length - 1] === disc,
    "R29: disclaim footnote closes the card");
  // weekless lab entry: never a fake week stamp
  const weekless = S.resultsValidItems({ items: [Object.assign({}, RES_LAB, { durationWeeks: null, measurements: [] })] })[0];
  const wCard = S.resultsBuildCard(weekless, Object.assign({}, STR_CLIN), o);
  ok(wCard.querySelectorAll(".cx-results__tag")[1].textContent === "After",
    "R29: no weeks -> plain After tag");
  // customer entries keep the classic card in study mode
  const custItem = S.resultsValidItems({ items: [RES_ITEM] })[0];
  const cust = S.resultsBuildCard(custItem, Object.assign({}, STR_CLIN), o);
  ok(cust.className === "cx-results__card" && !cust.querySelector(".cx-results__study") &&
    !cust.querySelector(".cx-results__disclaim"),
    "R29: customer cards untouched by the study design");
  // lightbox: week-stamped caption + disclaim, lab pill KEPT (no band there)
  const lb = S.resultsBuildLightbox(labItem, Object.assign({}, STR_CLIN), o);
  ok(lb.querySelectorAll(".cx-lightbox__cap")[1].textContent === "After 7 weeks",
    "R29: lightbox After caption week-stamped");
  ok(!!lb.querySelector(".cx-results__badge--lab"), "R29: lightbox keeps the lab pill");
  ok(!!lb.querySelector(".cx-results__disclaim"), "R29: lightbox carries the disclaim");
  // fail soft when the proxy copy is missing (old server, blocked copy)
  const bare = S.resultsBuildCard(labItem, Object.assign({}, STR), o);
  ok(bare.querySelectorAll(".cx-results__tag")[1].textContent === "After",
    "R29: missing aw -> plain After");
  ok(!bare.querySelector(".cx-results__disclaim"), "R29: missing iv -> no footnote");
}

// --- R30: flags read once and flow to Show-more cards --------------------------------
{
  const fx = resultsFixture();
  fx.total = 3;
  fx.ui = { cs: 1, sl: 1 };
  const section = S.resultsBuildSection({ ctx: "brand", pid: 0, str: Object.assign({}, STR_CLIN) }, fx);
  ok(section.className === "cx-proof cx-results",
    "R30: display flags never touch the root class (density pins hold)");
  ok(section.querySelectorAll(".cx-results__media--slider").length === 2,
    "R30: init cards render sliders");
  S.PF_FETCH_QUEUE.push({ total: 3, verifiedTotal: 2, items: [RES_LAB] }); // NO ui member on page 2
  click(section.querySelector(".cx-results__more"));
  const cards = section.querySelectorAll(".cx-results__card");
  ok(cards.length === 3 && cards[2].className === "cx-results__card cx-results__card--study" &&
    !!cards[2].querySelector(".cx-results__ba"),
    "R30: Show-more cards reuse the page-1 flags");
}

// --- R31: slider math is pure and clamped --------------------------------------------
{
  ok(S.resultsSliderPct({ left: 0, width: 200 }, 50) === 25, "R31: pct math");
  ok(S.resultsSliderPct({ left: 100, width: 200 }, 50) === 0, "R31: clamps at 0");
  ok(S.resultsSliderPct({ left: 0, width: 200 }, 900) === 100, "R31: clamps at 100");
  ok(S.resultsSliderPct(null, 50) === null, "R31: unmeasurable box -> null");
  ok(S.resultsSliderPct({ left: 0, width: 0 }, 50) === null, "R31: zero width -> null");
  ok(S.resultsSliderPct({ left: 0, width: 200 }, undefined) === null, "R31: no pointer -> null");
  const mk = () => S.document.createElement("div");
  const parts = { top: mk(), line: mk(), handle: mk(), pct: 50 };
  S.resultsSliderSet(parts, 62.34);
  ok(parts.pct === 62.3 && parts.top.style.clipPath === "inset(0 37.7% 0 0)",
    "R31: one-decimal position, complement re-rounded (no IEEE754 tail)");
  ok(parts.handle.getAttribute("aria-valuenow") === "62", "R31: aria value rounds to an integer");
  S.resultsSliderSet(parts, NaN);
  ok(parts.pct === 62.3, "R31: NaN never moves the divider");
}

// --- R32: the preview cache-buster stays out of shopper URLs -------------------------
{
  const qs = S.pfQuery(S.resultsParams({ ctx: "brand", pid: 0 }, { concern: "", age: "", skin: "", duration: "", page: 1 }));
  ok(qs.indexOf("pv=") === -1, "R32: normal visitors never send pv");
  S.window.CellexiaBooster = { __preview: true };
  const pqs = S.pfQuery(S.resultsParams({ ctx: "brand", pid: 0 }, { concern: "", age: "", skin: "", duration: "", page: 1 }));
  ok(/(&|\?)pv=\d+/.test(pqs), "R32: verified preview sends the per-minute pv token");
  delete S.window.CellexiaBooster;
}

// ================================== ultra (U, v8.2 look — v8.3 "cm": 2)

// --- U1: press ultra — collapsed row, tap-reveal, re-hide -----------------------------
{
  const section = S.pressBuildSection({ cm: 2, str: PRESS_STR }, pressFixture());
  ok(!!section && section.className === "cx-proof cx-press cx-press--ultra",
    "U1: cm:2 -> cx-press--ultra root modifier");
  const quote = section.querySelector(".cx-press__quote");
  ok(!!quote && quote.hasAttribute("hidden"), "U1: quote starts [hidden] (collapsed one-row band)");
  const logos = section.querySelectorAll(".cx-press__logo");
  ok(logos[0].getAttribute("aria-pressed") === "true", "U1: featured logo still starts aria-pressed");
  click(logos[1]);
  ok(!quote.hasAttribute("hidden"), "U1: logo tap reveals the quote");
  ok(section.querySelector(".cx-press__quote-text").textContent === "Skincare, decoded.",
    "U1: tap also rotates to the picked quote");
  ok(logos[1].getAttribute("aria-pressed") === "true" && logos[0].getAttribute("aria-pressed") === "false",
    "U1: aria-pressed follows the selection");
  click(logos[1]);
  ok(quote.hasAttribute("hidden"), "U1: second tap on the ACTIVE logo re-hides the quote");
  ok(logos[0].getAttribute("aria-pressed") === "false" && logos[1].getAttribute("aria-pressed") === "false" &&
    logos[2].getAttribute("aria-pressed") === "false",
    "U1: nothing reads pressed while collapsed");
  click(logos[0]);
  ok(!quote.hasAttribute("hidden") &&
    section.querySelector(".cx-press__quote-text").textContent === "The quiet revolution.",
    "U1: re-tap reveals + rotates again");
  ok(section.querySelector(".cx-proof__link").getAttribute("href") === "https://vogue.com/a",
    "U1: read-article link behavior unchanged in ultra");
  click(logos[1]);
  ok(section.querySelector(".cx-proof__link").hasAttribute("hidden"),
    "U1: linkless item still hides the read link in ultra");
}

// --- U2: press cm-absent twin — default path byte-identical --------------------------
{
  const section = S.pressBuildSection({ str: PRESS_STR }, pressFixture());
  ok(section.className === "cx-proof cx-press", "U2: no cm -> no modifier class");
  const quote = section.querySelector(".cx-press__quote");
  ok(!quote.hasAttribute("hidden"), "U2: quote visible from the start outside ultra");
  const logos = section.querySelectorAll(".cx-press__logo");
  click(logos[0]);
  click(logos[0]);
  ok(!quote.hasAttribute("hidden"), "U2: double-tap never hides the quote outside ultra");
  ok(logos[0].getAttribute("aria-pressed") === "true", "U2: active logo stays pressed outside ultra");
}

// --- U3: endorsement ultra — one composed head row over the same cards ---------------
{
  const section = S.endoBuildSection({ cm: 2, ctx: "brand", pid: 0, str: ENDO_STR },
    { total: 60, items: endoFixture(24, 0) });
  ok(!!section && section.className === "cx-proof cx-endo cx-endo--ultra",
    "U3: cm:2 -> cx-endo--ultra root modifier");
  ok(!section.querySelector(".cx-proof__eyebrow"), "U3: no eyebrow in ultra (single head row)");
  const head = section.querySelector(".cx-endo__headline");
  ok(!!head && head.tagName === "P", "U3: ultra head row is a <p>, not the H2");
  ok(head.textContent === "Endorsed by 60 dermatologists · Showing 24 of 60",
    "U3: head row composes count + middot + shown_of inline");
  ok(!section.querySelector(".cx-endo__progress"), "U3: no separate progress element in ultra");
  ok(section.querySelectorAll(".cx-endo__card").length === 24, "U3: same cards, same page size");
  const more = section.querySelector(".cx-endo__show-more");
  S.PF_FETCH_CALLS.length = 0;
  S.PF_FETCH_QUEUE.push({ total: 60, items: endoFixture(24, 24) });
  click(more);
  ok(S.PF_FETCH_CALLS[0].qs === "?type=endorsements&page=2&per=24",
    "U3: Show more pagination query unchanged in ultra");
  ok(section.querySelectorAll(".cx-endo__card").length === 48,
    "U3: Show more appends into the SAME wall (the ultra rail)");
  ok(head.textContent === "Endorsed by 60 dermatologists · Showing 48 of 60",
    "U3: head row re-composes after the append");
}

// --- U4: ultra head row degrades per part --------------------------------------------
{
  const s2 = S.endoBuildSection({ cm: 2, str: { other: ENDO_STR.other, read: "R" } },
    { total: 9, items: endoFixture(9, 0) });
  ok(s2.querySelector(".cx-endo__headline").textContent === "Endorsed by 9 dermatologists",
    "U4: missing shown_of degrades to the count alone");
  const s3 = S.endoBuildSection({ cm: 2, str: { shown: ENDO_STR.shown, read: "R" } },
    { total: 9, items: endoFixture(9, 0) });
  ok(s3.querySelector(".cx-endo__headline").textContent === "Showing 9 of 9",
    "U4: missing count headline degrades to shown_of alone");
  const s4 = S.endoBuildSection({ cm: 2, str: { read: "R" } }, { total: 9, items: endoFixture(9, 0) });
  ok(!s4.querySelector(".cx-endo__headline"), "U4: both strings missing -> no dead head row");
}

// --- U5: endorsement cm-absent twin — v8 wall unchanged ------------------------------
{
  const section = S.endoBuildSection({ ctx: "brand", pid: 0, str: ENDO_STR },
    { total: 60, items: endoFixture(24, 0) });
  ok(section.className === "cx-proof cx-endo", "U5: no cm -> no modifier");
  const head = section.querySelector(".cx-endo__headline");
  ok(!!head && head.tagName === "H2" && head.textContent === "Endorsed by 60 dermatologists",
    "U5: H2 count headline unchanged");
  ok(section.querySelector(".cx-endo__progress").textContent === "Showing 24 of 60",
    "U5: separate progress line unchanged");
  ok(!!section.querySelector(".cx-proof__eyebrow"), "U5: eyebrow present outside ultra/compact");
}

// --- U6: multi-paragraph quotes — \n\n preserved, expand-in-place intact -------------
// The renderer must hand the merchant's paragraph breaks through to
// textContent untouched in BOTH layouts; the visual break rides the
// `.cx-endo__card--open .cx-endo__quote { white-space: pre-line; }` rule,
// which harness section 5 pins in the shipped CSS.
{
  const paragraphs = "First paragraph.\n\nSecond paragraph.";
  const card = S.endoBuildCard({ n: "Dr. A B", q: paragraphs, c: "", cc: "", img: "" }, ENDO_STR);
  ok(card.querySelector(".cx-endo__quote").textContent === paragraphs,
    "U6: paragraph breaks reach textContent verbatim (full layout)");
  const btn = card.querySelector(".cx-endo__more");
  click(btn);
  ok(card.className === "cx-endo__card cx-endo__card--open",
    "U6: expanded card carries --open (the pre-line CSS hook)");
  ok(card.querySelector(".cx-endo__quote").textContent === paragraphs,
    "U6: expansion never rewrites the quote text");
  click(btn);
  ok(card.className === "cx-endo__card", "U6: re-clamp restores the collapsed class");
}

// --- U7: results ultra — root modifier only, everything else byte-identical ----------
{
  const section = S.resultsBuildSection({ cm: 2, ctx: "product", pid: 42, str: STR }, resultsFixture());
  ok(!!section && section.className === "cx-proof cx-results cx-results--ultra",
    "U7: cm:2 -> cx-results--ultra root modifier");
  ok(section.querySelectorAll(".cx-results__chip").length === 5,
    "U7: four group chips + clear chip unchanged (zero new strings)");
  ok(section.querySelectorAll(".cx-results__card").length === 2, "U7: same card rail");
  ok(!!section.querySelector(".cx-results__drawer"), "U7: filter drawer intact in ultra");
  ok(section.querySelector(".cx-results__banner").textContent ===
    "See results from 25 real Cellexia users.",
    "U7: scale banner text unchanged (ultra is CSS-only shrink)");
  const twin = S.resultsBuildSection({ ctx: "product", pid: 42, str: STR }, resultsFixture());
  ok(twin.className === "cx-proof cx-results", "U7: no cm -> no modifier (twin)");
}

// ================================== compact (C, v8.3 NEW middle tier — "cm": 1)

// --- C1: press compact — quote ALWAYS visible, rotation exactly like full ------------
{
  const section = S.pressBuildSection({ cm: 1, str: PRESS_STR }, pressFixture());
  ok(!!section && section.className === "cx-proof cx-press cx-press--compact",
    "C1: cm:1 -> cx-press--compact root modifier");
  ok(!!section.querySelector(".cx-proof__eyebrow"),
    "C1: eyebrow kept (the compact one-row band carries it inline via CSS)");
  const quote = section.querySelector(".cx-press__quote");
  ok(!!quote && !quote.hasAttribute("hidden"),
    "C1: quote VISIBLE from the start — compact never hides it behind a tap");
  const logos = section.querySelectorAll(".cx-press__logo");
  ok(logos[0].getAttribute("aria-pressed") === "true", "C1: featured logo starts aria-pressed");
  click(logos[1]);
  ok(!quote.hasAttribute("hidden"), "C1: rotation keeps the quote visible");
  ok(section.querySelector(".cx-press__quote-text").textContent === "Skincare, decoded.",
    "C1: logo click rotates to the picked quote (full-mode behavior)");
  ok(logos[0].getAttribute("aria-pressed") === "false" && logos[1].getAttribute("aria-pressed") === "true",
    "C1: aria-pressed follows the selection");
  click(logos[1]);
  ok(!quote.hasAttribute("hidden"),
    "C1: a re-tap on the ACTIVE logo never collapses the band (no ultra re-hide)");
  ok(logos[1].getAttribute("aria-pressed") === "true",
    "C1: the active logo stays pressed after the re-tap");
  ok(section.querySelector(".cx-proof__link").hasAttribute("hidden"),
    "C1: linkless item still hides the read link in compact");
  click(logos[0]);
  ok(section.querySelector(".cx-proof__link").getAttribute("href") === "https://vogue.com/a",
    "C1: read-article link behavior unchanged in compact");
}

// --- C2: strict tier codes — cm must be the NUMBER 1/2, anything else = full ---------
{
  for (const probe of ["1", "2", 0, 3]) {
    const p = S.pressBuildSection({ cm: probe, str: PRESS_STR }, pressFixture());
    ok(p.className === "cx-proof cx-press" && !p.querySelector(".cx-press__quote").hasAttribute("hidden"),
      `C2: press cm ${JSON.stringify(probe)} falls back to the full layout (quote visible, no modifier)`);
  }
  const e = S.endoBuildSection({ cm: "2", ctx: "brand", pid: 0, str: ENDO_STR },
    { total: 60, items: endoFixture(24, 0) });
  ok(e.className === "cx-proof cx-endo" && e.querySelector(".cx-endo__headline").tagName === "H2" &&
    !!e.querySelector(".cx-endo__progress") && !!e.querySelector(".cx-proof__eyebrow"),
    "C2: endo cm '2' (string) falls back to the full wall");
  const r = S.resultsBuildSection({ cm: "1", ctx: "brand", pid: 0, str: STR }, resultsFixture());
  ok(r.className === "cx-proof cx-results", "C2: results cm '1' (string) falls back to the full gallery");
}

// --- C3: endorsement compact — H2 head line with inline progress over the rail -------
{
  const section = S.endoBuildSection({ cm: 1, ctx: "brand", pid: 0, str: ENDO_STR },
    { total: 60, items: endoFixture(24, 0) });
  ok(!!section && section.className === "cx-proof cx-endo cx-endo--compact",
    "C3: cm:1 -> cx-endo--compact root modifier");
  ok(!section.querySelector(".cx-proof__eyebrow"), "C3: no eyebrow in compact (single head line)");
  const head = section.querySelector(".cx-endo__headline");
  ok(!!head && head.tagName === "H2", "C3: compact head line is an H2 (ultra keeps the <p>)");
  ok(head.textContent === "Endorsed by 60 dermatologists · Showing 24 of 60",
    "C3: headline composes count + middot + inline progress");
  ok(!section.querySelector(".cx-endo__progress"), "C3: no separate progress element in compact");
  ok(section.querySelectorAll(".cx-endo__card").length === 24, "C3: same cards, same page size (the 280px rail is CSS)");
  const more = section.querySelector(".cx-endo__show-more");
  S.PF_FETCH_CALLS.length = 0;
  S.PF_FETCH_QUEUE.push({ total: 60, items: endoFixture(24, 24) });
  click(more);
  ok(S.PF_FETCH_CALLS[0].qs === "?type=endorsements&page=2&per=24",
    "C3: Show more pagination query unchanged in compact");
  ok(section.querySelectorAll(".cx-endo__card").length === 48,
    "C3: Show more appends into the SAME wall (the compact rail)");
  ok(head.textContent === "Endorsed by 60 dermatologists · Showing 48 of 60",
    "C3: head line re-composes after the append");
  // Expand-in-place must survive inside the compact wall: the card gains
  // --open (the hook the compact 2-line clamp override + the shared
  // pre-line rule key off — both pinned in the shipped CSS by harness).
  const card = section.querySelectorAll(".cx-endo__card")[0];
  const btn = card.querySelector(".cx-endo__more");
  click(btn);
  ok(card.className === "cx-endo__card cx-endo__card--open" && btn.getAttribute("aria-expanded") === "true",
    "C3: expand-in-place toggle intact inside the compact wall");
  click(btn);
  ok(card.className === "cx-endo__card", "C3: re-clamp restores the collapsed card");
}

// --- C4: compact head line degrades per part (same rule as ultra) --------------------
{
  const s2 = S.endoBuildSection({ cm: 1, str: { other: ENDO_STR.other, read: "R" } },
    { total: 9, items: endoFixture(9, 0) });
  const h2 = s2.querySelector(".cx-endo__headline");
  ok(!!h2 && h2.tagName === "H2" && h2.textContent === "Endorsed by 9 dermatologists",
    "C4: missing shown_of degrades the H2 to the count alone");
  const s4 = S.endoBuildSection({ cm: 1, str: { read: "R" } }, { total: 9, items: endoFixture(9, 0) });
  ok(!s4.querySelector(".cx-endo__headline"), "C4: both strings missing -> no dead head line");
}

// --- C5: results compact — root modifier only, full banner/chips/cards ---------------
{
  const section = S.resultsBuildSection({ cm: 1, ctx: "product", pid: 42, str: STR }, resultsFixture());
  ok(!!section && section.className === "cx-proof cx-results cx-results--compact",
    "C5: cm:1 -> cx-results--compact root modifier");
  ok(section.querySelector(".cx-results__banner").textContent ===
    "See results from 25 real Cellexia users.",
    "C5: FULL scale banner untouched (compact keeps the full look up top)");
  ok(section.querySelectorAll(".cx-results__chip").length === 5,
    "C5: full wrapping chip row — four group chips + clear (zero new strings)");
  ok(section.querySelectorAll(".cx-results__card").length === 2,
    "C5: full-size cards on the rail (the desktop grid suppression is CSS-only)");
  ok(!!section.querySelector(".cx-results__drawer"), "C5: filter drawer intact in compact");
  const drawer = section.querySelector(".cx-results__drawer");
  click(section.querySelectorAll(".cx-results__chip")[0]);
  ok(!drawer.hasAttribute("hidden"), "C5: chip still opens the drawer in compact");
  const twin = S.resultsBuildSection({ ctx: "product", pid: 42, str: STR }, resultsFixture());
  ok(twin.className === "cx-proof cx-results", "C5: no cm -> no modifier (full-mode twin)");
}

// ============================================ preview contract (V, v8/v8.2)

function resetPreviewWorld() {
  delete S.window.CellexiaBooster;
  delete S.window.sessionStorage;
  INTERVALS.length = 0;
}

// --- V1: live islands render immediately ---------------------------------------------
{
  resetPreviewWorld();
  let called = 0;
  S.pfWhenAllowed({ live: true }, function () { called += 1; });
  ok(called === 1, "V1: live:true island renders immediately");
  ok(INTERVALS.length === 0, "V1: no poll armed for a live island");
}

// --- V2: draft island + verified __preview flag --------------------------------------
{
  resetPreviewWorld();
  S.window.CellexiaBooster = { __preview: true };
  ok(S.pfPreviewVerified() === true, "V2: __preview flag verifies the session");
  let called = 0;
  S.pfWhenAllowed({ live: false }, function () { called += 1; });
  ok(called === 1, "V2: draft island renders immediately once __preview is set");
}

// --- V3: draft island + cx_preview_ok session marker (non-product pages) -------------
{
  resetPreviewWorld();
  const store = { cx_preview_ok: "1" };
  S.window.sessionStorage = { getItem(k) { return k in store ? store[k] : null; } };
  ok(S.pfPreviewVerified() === true, "V3: cx_preview_ok=1 verifies the session");
  let called = 0;
  S.pfWhenAllowed({ live: false }, function () { called += 1; });
  ok(called === 1, "V3: draft island renders off the persisted verification marker");
}

// --- V4: draft island + NEITHER -> not rendered (the predicate, not the poll) --------
{
  resetPreviewWorld();
  const store = {};
  S.window.sessionStorage = { getItem(k) { return k in store ? store[k] : null; } };
  ok(S.pfPreviewVerified() === false,
    "V4: a normal visitor is NEVER preview-verified (the predicate)");
  let called = 0;
  S.pfWhenAllowed({ live: false }, function () { called += 1; });
  ok(called === 0, "V4: draft island does not render synchronously for a normal visitor");
  ok(INTERVALS.length === 1, "V4: the bounded verification poll is armed (and never fires here)");
  ok(S.pfPreviewVerified() === false,
    "V4: still unverified after the arm — the recorded poll could only ever no-op");
}

// --- V5: beacon suppression matrix ---------------------------------------------------
{
  resetPreviewWorld();
  ok(S.pfBeaconsOff() === false, "V5: normal visitor -> beacons ON");
  S.window.CellexiaBooster = { __preview: true };
  ok(S.pfBeaconsOff() === true, "V5: verified __preview session -> beacons suppressed");
  resetPreviewWorld();
  const store = { cx_preview_token: "tok" };
  S.window.sessionStorage = { getItem(k) { return k in store ? store[k] : null; } };
  ok(S.pfBeaconsOff() === true,
    "V5: cx_preview_token present (indeterminate window) -> beacons suppressed");
  const store2 = { cx_preview_ok: "1" };
  S.window.sessionStorage = { getItem(k) { return k in store2 ? store2[k] : null; } };
  ok(S.pfBeaconsOff() === false,
    "V5: cx_preview_ok alone does NOT suppress — the token is the suppression key");
}

// --- V6: token alone suppresses beacons but never renders drafts ---------------------
{
  resetPreviewWorld();
  const store = { cx_preview_token: "tok" };
  S.window.sessionStorage = { getItem(k) { return k in store ? store[k] : null; } };
  ok(S.pfBeaconsOff() === true && S.pfPreviewVerified() === false,
    "V6: cx_preview_token -> silent beacons, but drafts stay unrendered (unverified)");
  resetPreviewWorld();
}

// ==================================================== endorsement badge (B, v8.17)
//
// The buy-box badge: same payload as the wall, product ctx only, real
// portraits only (cap 5), headline chain ob -> bh1/bh2 -> one/other,
// link vs no-link line, and the documented .pdp__info anchor chain with
// the fail-closed guarantee (never body-append).

function badgeConf(extra) {
  const conf = { ctx: "product", pid: 9, bd: 1, str: ENDO_STR };
  return Object.assign(conf, extra || {});
}

// --- B1: build — avatars capped at 5, photo rows only, headline from total ----------
{
  const badge = S.endoBadgeBuild(badgeConf(), { total: 73, items: endoFixture(24, 0) });
  ok(!!badge && badge.getAttribute("data-cx-feature") === "derm_endorsements",
    "B1: badge root carries the derm_endorsements marker");
  // endoFixture alternates imageUrl (12 of 24 have one) — the strip keeps
  // photo rows ONLY and caps at five.
  ok(badge.querySelectorAll(".cx-endo-badge__avatar").length === 5,
    "B1: exactly five portrait avatars (photo rows only, capped)");
  ok(badge.querySelector(".cx-endo-badge__headline").textContent === "Recommended by 73 dermatologists",
    "B1: badge headline carries the API total via bh2");
  ok(!!badge.querySelector(".cx-endo-badge__shield"), "B1: shield icon present");
  const link = badge.querySelector(".cx-endo-badge__link");
  ok(!!link && link.textContent === "Read their professional assessments",
    "B1: link renders with the bl catalog string");
  ok(!badge.querySelector(".cx-endo-badge__alt"), "B1: no alt line while the link is on");
}

// --- B2: gates — bd flag and product ctx are both required --------------------------
ok(S.endoBadgeBuild({ ctx: "product", pid: 9, str: ENDO_STR }, { total: 5, items: endoFixture(5, 0) }) === null,
  "B2: no bd member -> no badge (the merchant toggle)");
ok(S.endoBadgeBuild(badgeConf({ ctx: "brand", pid: 0 }), { total: 5, items: endoFixture(5, 0) }) === null,
  "B2: brand/home ctx -> no badge (product pages only)");
ok(S.endoBadgeBuild(badgeConf(), { total: 0, items: [] }) === null,
  "B2: empty payload -> no badge (fails closed with the wall)");

// --- B3: portraitless payload keeps the badge, drops the strip ----------------------
{
  const bare = endoFixture(6, 0).map((it) => Object.assign({}, it, { imageUrl: null }));
  const badge = S.endoBadgeBuild(badgeConf(), { total: 6, items: bare });
  ok(!!badge && !badge.querySelector(".cx-endo-badge__strip"),
    "B3: no portraits -> no avatar strip (never monogram filler)");
  ok(!!badge.querySelector(".cx-endo-badge__headline"), "B3: headline still renders");
}

// --- B4: link toggle off -> the no-link line ----------------------------------------
{
  const badge = S.endoBadgeBuild(badgeConf({ bk: 0 }), { total: 73, items: endoFixture(24, 0) });
  ok(!badge.querySelector(".cx-endo-badge__link"), "B4: bk:0 -> no link");
  const alt = badge.querySelector(".cx-endo-badge__alt");
  ok(!!alt && alt.textContent === "Verified professional assessments",
    "B4: bv catalog string takes the row instead");
}

// --- B5: merchant overrides win on every surface ------------------------------------
{
  const str = Object.assign({}, ENDO_STR, {
    oe: "Trusted by skin experts",
    oh: "@@N@@ experts back this cream",
    od: "Custom description.",
    ob: "Backed by @@N@@ experts",
    ol: "See the expert reviews",
  });
  const wall = S.endoBuildSection({ ctx: "product", pid: 9, str }, { total: 73, items: endoFixture(24, 0) });
  ok(wall.querySelector(".cx-proof__eyebrow").textContent === "Trusted by skin experts",
    "B5: oe override drives the wall eyebrow");
  ok(wall.querySelector(".cx-endo__headline").textContent === "73 experts back this cream",
    "B5: oh override drives the wall headline with the live total");
  ok(wall.querySelector(".cx-endo__desc").textContent === "Custom description.",
    "B5: od override drives the description");
  const badge = S.endoBadgeBuild({ ctx: "product", pid: 9, bd: 1, str }, { total: 73, items: endoFixture(24, 0) });
  ok(badge.querySelector(".cx-endo-badge__headline").textContent === "Backed by 73 experts",
    "B5: ob override drives the badge headline");
  ok(badge.querySelector(".cx-endo-badge__link").textContent === "See the expert reviews",
    "B5: ol override drives the link text");
  const noLink = S.endoBadgeBuild({ ctx: "product", pid: 9, bd: 1, bk: 0, str: Object.assign({}, ENDO_STR, { on: "Assessed by experts" }) }, { total: 3, items: endoFixture(3, 0) });
  ok(noLink.querySelector(".cx-endo-badge__alt").textContent === "Assessed by experts",
    "B5: on override drives the no-link line");
  // Merchant overrides may carry {n} MORE THAN ONCE (Liquid's replace is
  // global) — every occurrence must substitute (review catch: string
  // .replace only did the first).
  const twice = Object.assign({}, ENDO_STR, { ob: "@@N@@ experts — all @@N@@ verified", oh: "@@N@@ of @@N@@ agree" });
  const badge2 = S.endoBadgeBuild({ ctx: "product", pid: 9, bd: 1, str: twice }, { total: 73, items: endoFixture(24, 0) });
  ok(badge2.querySelector(".cx-endo-badge__headline").textContent === "73 experts — all 73 verified",
    "B5b: EVERY @@N@@ occurrence substitutes in the badge headline");
  const wall2 = S.endoBuildSection({ ctx: "product", pid: 9, str: twice }, { total: 73, items: endoFixture(24, 0) });
  ok(wall2.querySelector(".cx-endo__headline").textContent === "73 of 73 agree",
    "B5b: EVERY @@N@@ occurrence substitutes in the wall headline");
  const ultra2 = S.endoBuildSection({ ctx: "product", pid: 9, cm: 2, str: Object.assign({}, twice, { shown: "" }) }, { total: 73, items: endoFixture(24, 0) });
  ok(ultra2.querySelector(".cx-endo__headline").textContent === "73 of 73 agree",
    "B5b: EVERY @@N@@ occurrence substitutes in the composed head line");
}

// --- B6: blank badge_headline falls back to the wall headline (the el path) ---------
{
  const str = Object.assign({}, ENDO_STR, { bh1: "", bh2: "" });
  const badge = S.endoBadgeBuild(badgeConf({ str }), { total: 73, items: endoFixture(24, 0) });
  ok(!!badge && badge.querySelector(".cx-endo-badge__headline").textContent === "Endorsed by 73 dermatologists",
    "B6: blank bh strings fall back to count_headline (locale byte-cap contract)");
}

// --- B7: description is a full-density-only line ------------------------------------
{
  const full = S.endoBuildSection({ ctx: "brand", pid: 0, str: ENDO_STR }, { total: 8, items: endoFixture(8, 0) });
  ok(full.querySelector(".cx-endo__desc").textContent === "Verified recommendations from licensed dermatologists.",
    "B7: full density renders the description under the headline");
  const ultra = S.endoBuildSection({ ctx: "brand", pid: 0, cm: 2, str: ENDO_STR }, { total: 8, items: endoFixture(8, 0) });
  ok(!ultra.querySelector(".cx-endo__desc"), "B7: ultra keeps its tight head (no description)");
  const compact = S.endoBuildSection({ ctx: "brand", pid: 0, cm: 1, str: ENDO_STR }, { total: 8, items: endoFixture(8, 0) });
  ok(!compact.querySelector(".cx-endo__desc"), "B7: compact keeps its tight head (no description)");
  const noDesc = S.endoBuildSection({ ctx: "brand", pid: 0, str: Object.assign({}, ENDO_STR, { desc: "" }) }, { total: 8, items: endoFixture(8, 0) });
  ok(!noDesc.querySelector(".cx-endo__desc"), "B7: blank desc skips the paragraph");
}

// --- B8: mount anchor chain + fail-closed -------------------------------------------
function pdpFixture(parts) {
  const info = S.document.createElement("div");
  info.setAttribute("class", "pdp__info");
  const made = {};
  for (const part of parts) {
    const el = S.document.createElement("div");
    if (part === "desc") {
      el.setAttribute("id", "persona-description");
      el.setAttribute("class", "pdp__description");
    } else if (part === "gallery") {
      el.setAttribute("class", "pdp__images pdp__images--default pdp__images--mobile");
    } else {
      el.setAttribute("class", "pdp__" + part);
    }
    info.appendChild(el);
    made[part] = el;
  }
  S.document.body.appendChild(info);
  return { info, made };
}
function unmountFixture(info) {
  S.document.body.removeChild(info);
  const stray = S.document.querySelector(".cx-endo-badge");
  if (stray && stray.parentNode) stray.parentNode.removeChild(stray);
}
{
  const { info, made } = pdpFixture(["price", "gallery", "desc"]);
  const badge = S.endoBadgeBuild(badgeConf(), { total: 73, items: endoFixture(24, 0) });
  ok(S.endoBadgeMount(badge) === true, "B8: mounts on the full pdp fixture");
  ok(badge.nextSibling === made.gallery && badge.previousElementSibling === made.price,
    "B8: badge sits between the price and the mobile gallery");
  ok(S.endoBadgeMount(S.endoBadgeBuild(badgeConf(), { total: 73, items: endoFixture(24, 0) })) === true &&
    S.document.querySelectorAll(".cx-endo-badge").length === 1,
    "B8: second mount is idempotent (one badge ever)");
  unmountFixture(info);
}
{
  const { info, made } = pdpFixture(["price", "desc"]);
  const badge = S.endoBadgeBuild(badgeConf(), { total: 73, items: endoFixture(24, 0) });
  ok(S.endoBadgeMount(badge) === true && badge.nextSibling === made.desc,
    "B8: no mobile gallery -> badge lands right above the description");
  unmountFixture(info);
}
{
  const { info, made } = pdpFixture(["price"]);
  const badge = S.endoBadgeBuild(badgeConf(), { total: 73, items: endoFixture(24, 0) });
  ok(S.endoBadgeMount(badge) === true && badge.previousElementSibling === made.price,
    "B8: price-only fixture -> badge lands right after the price");
  unmountFixture(info);
}
{
  const badge = S.endoBadgeBuild(badgeConf(), { total: 73, items: endoFixture(24, 0) });
  ok(S.endoBadgeMount(badge) === false && badge.parentNode === null &&
    !S.document.querySelector(".cx-endo-badge"),
    "B8: no anchors -> mount refuses, node never reaches the document (fail closed)");
}

// --- B9: link click scrolls to the wall + click beacon ------------------------------
{
  const { info } = pdpFixture(["price", "gallery", "desc"]);
  const wall = S.endoBuildSection({ ctx: "product", pid: 9, str: ENDO_STR }, { total: 73, items: endoFixture(24, 0) });
  S.document.body.appendChild(wall);
  const scrolls = [];
  wall.scrollIntoView = function (opts) { scrolls.push(opts || null); };
  const badge = S.endoBadgeBuild(badgeConf(), { total: 73, items: endoFixture(24, 0) });
  S.endoBadgeMount(badge);
  S.PF_TRACKS.length = 0;
  let prevented = 0;
  badge.querySelector(".cx-endo-badge__link")._fire("click", {
    target: badge, preventDefault() { prevented++; },
  });
  ok(prevented === 1, "B9: link click prevents the default jump");
  ok(scrolls.length === 1 && scrolls[0] && scrolls[0].behavior === "smooth",
    "B9: click smooth-scrolls to the wall section");
  ok(S.PF_TRACKS.length === 1 && S.PF_TRACKS[0][0] === "derm_endorsements" && S.PF_TRACKS[0][1] === "click",
    "B9: click beacon rides the existing derm_endorsements key");
  S.document.body.removeChild(wall);
  unmountFixture(info);
}

// --- B10: total can never undercut the visible rows ---------------------------------
{
  const badge = S.endoBadgeBuild(badgeConf(), { total: 3, items: endoFixture(24, 0) });
  ok(badge.querySelector(".cx-endo-badge__headline").textContent === "Recommended by 24 dermatologists",
    "B10: badge never claims fewer than it shows");
}

// ============================================ badge designs (BST, v8.18)
//
// Four looks behind the lean "bst" island code: absent = classic (the
// exact v8.17 markup), 1 = choice, 2 = slim, 3 = choice_compact.

// --- BST1: choice — crown title, chip, bold count, no blue shield -------------------
{
  const badge = S.endoBadgeBuild(badgeConf({ bst: 1 }), { total: 73, items: endoFixture(24, 0) });
  ok(badge.className === "cx-endo-badge cx-endo-badge--choice",
    "BST1: choice root modifier");
  const bst1Title = badge.querySelector(".cx-endo-badge__title");
  ok(!!bst1Title && bst1Title.textContent === "Dermatologist endorsements",
    "BST1: the crown title reuses the eyebrow string (zero extra locale bytes)");
  ok(badge.querySelectorAll(".cx-endo-badge__laurel").length === 2 &&
    !!badge.querySelector(".cx-endo-badge__laurel--flip") &&
    !!badge.querySelector(".cx-endo-badge__cadu"),
    "BST1: laurel pair (one mirrored) + caduceus in the crown");
  const chip = badge.querySelector(".cx-endo-badge__chip");
  ok(!!chip && chip.querySelector(".cx-endo-badge__chip-text").textContent === "Licensed dermatologists" &&
    !!chip.querySelector(".cx-endo-badge__chip-shield"),
    "BST1: credential chip with outline shield + chip string");
  const head = badge.querySelector(".cx-endo-badge__headline");
  ok(head.querySelector("strong") && head.querySelector("strong").textContent === "73",
    "BST1: the count is a bold <strong> in the choice headline");
  ok(head.textContent === "Recommended by 73 dermatologists",
    "BST1: headline text intact around the bold count");
  ok(!head.querySelector(".cx-endo-badge__shield"),
    "BST1: no blue shield inside the choice headline");
  ok(badge.querySelectorAll(".cx-endo-badge__avatar").length === 5,
    "BST1: choice keeps the five portraits");
  ok(!!badge.querySelector(".cx-endo-badge__row"),
    "BST1: portraits + body ride the row wrapper");
}

// --- BST2: slim — 3 portraits, +N spillover, shield kept, link kept ------------------
{
  const badge = S.endoBadgeBuild(badgeConf({ bst: 2 }), { total: 73, items: endoFixture(24, 0) });
  ok(badge.className === "cx-endo-badge cx-endo-badge--slim", "BST2: slim root modifier");
  ok(badge.querySelectorAll(".cx-endo-badge__avatar").length === 3,
    "BST2: slim shows three portraits");
  const bst2Plus = badge.querySelector(".cx-endo-badge__plus");
  ok(!!bst2Plus && bst2Plus.textContent === "+70",
    "BST2: the spillover counter is total minus SHOWN portraits");
  ok(!!badge.querySelector(".cx-endo-badge__headline .cx-endo-badge__shield"),
    "BST2: slim keeps the blue shield");
  ok(!!badge.querySelector(".cx-endo-badge__link"), "BST2: link present");
  ok(!badge.querySelector(".cx-endo-badge__crown") && !badge.querySelector(".cx-endo-badge__chip"),
    "BST2: no crown, no chip on the slim bar");
  const allPhoto = endoFixture(3, 0).map((it, i) =>
    Object.assign({}, it, { imageUrl: "https://cdn/x" + i + ".jpg" }));
  const tiny = S.endoBadgeBuild(badgeConf({ bst: 2 }), { total: 3, items: allPhoto });
  ok(!tiny.querySelector(".cx-endo-badge__plus"),
    "BST2: no counter when the total does not exceed the shown portraits");
}

// --- BST3: choice_compact — top row (title + chip), 4 portraits ---------------------
{
  const badge = S.endoBadgeBuild(badgeConf({ bst: 3 }), { total: 73, items: endoFixture(24, 0) });
  ok(badge.className === "cx-endo-badge cx-endo-badge--choice-c", "BST3: choice-c root modifier");
  const top = badge.querySelector(".cx-endo-badge__top");
  ok(!!top && !!top.querySelector(".cx-endo-badge__crown") && !!top.querySelector(".cx-endo-badge__chip"),
    "BST3: top row carries the compact crown + chip");
  ok(top.querySelectorAll(".cx-endo-badge__laurel").length === 0,
    "BST3: compact crown drops the laurels (caduceus + title only)");
  ok(badge.querySelectorAll(".cx-endo-badge__avatar").length === 4,
    "BST3: compact shows four portraits");
  ok(!!badge.querySelector(".cx-endo-badge__headline strong"),
    "BST3: bold count in the compact headline");
}

// --- BST4: classic stays byte-for-byte the v8.17 markup -----------------------------
{
  const badge = S.endoBadgeBuild(badgeConf(), { total: 73, items: endoFixture(24, 0) });
  ok(badge.className === "cx-endo-badge", "BST4: no bst -> no design modifier");
  ok(!badge.querySelector(".cx-endo-badge__row") && !badge.querySelector(".cx-endo-badge__crown") &&
    !badge.querySelector(".cx-endo-badge__chip") && !badge.querySelector(".cx-endo-badge__plus"),
    "BST4: classic has no v8.18 structure (strip + body directly on the root)");
  ok(!!badge.querySelector(".cx-endo-badge__headline .cx-endo-badge__shield") &&
    !badge.querySelector(".cx-endo-badge__headline strong"),
    "BST4: classic keeps the shield and a plain-text count");
}

// --- BST5: chip resolution — override wins, blank catalog hides (el path) -----------
{
  const over = S.endoBadgeBuild(badgeConf({ bst: 1, str: Object.assign({}, ENDO_STR, { oc: "Board-certified MDs" }) }), { total: 8, items: endoFixture(8, 0) });
  const bst5Chip = over.querySelector(".cx-endo-badge__chip-text");
  ok(!!bst5Chip && bst5Chip.textContent === "Board-certified MDs",
    "BST5: oc override drives the chip text");
  const blank = S.endoBadgeBuild(badgeConf({ bst: 1, str: Object.assign({}, ENDO_STR, { chip: "" }) }), { total: 8, items: endoFixture(8, 0) });
  ok(!blank.querySelector(".cx-endo-badge__chip"),
    "BST5: blank chip catalog string hides the chip entirely");
}

// --- BST6: slim + link off -> alt line takes the right slot -------------------------
{
  const badge = S.endoBadgeBuild(badgeConf({ bst: 2, bk: 0 }), { total: 73, items: endoFixture(24, 0) });
  ok(!badge.querySelector(".cx-endo-badge__link") &&
    badge.querySelector(".cx-endo-badge__alt").textContent === "Verified professional assessments",
    "BST6: slim honors the link toggle with the alt line");
}

// ============================================ localized copy merge (CP, v8.19)
//
// The proxy serves DeepL-translated merchant copy as data.copy under the
// island's own o* codes; endoApplyCopy merges it (whitelist, non-blank
// strings only) BEFORE the wall/badge build, so both surfaces render the
// page-locale text.

// --- CP1: whitelisted merge, junk ignored -------------------------------------------
{
  const conf = { ctx: "product", pid: 9, bd: 1, str: Object.assign({}, ENDO_STR) };
  S.endoApplyCopy(conf, { copy: {
    oe: "Recommandé par les experts",
    ob: "Approuvé par @@N@@ experts",
    zz: "never merged",
    oh: "",            // blank -> ignored
    od: 7,             // non-string -> ignored
  } });
  ok(conf.str.oe === "Recommandé par les experts" && conf.str.ob === "Approuvé par @@N@@ experts",
    "CP1: translated overrides land in the island str map");
  ok(!("zz" in conf.str), "CP1: unknown keys never merge (whitelist)");
  ok(conf.str.oh === undefined && conf.str.od === undefined,
    "CP1: blank/non-string values never merge");
  const badge = S.endoBadgeBuild(conf, { total: 73, items: endoFixture(24, 0) });
  ok(badge.querySelector(".cx-endo-badge__headline").textContent === "Approuvé par 73 experts",
    "CP1: the badge renders the LOCALIZED override with the live count");
  const wall = S.endoBuildSection(conf, { total: 73, items: endoFixture(24, 0) });
  ok(wall.querySelector(".cx-proof__eyebrow").textContent === "Recommandé par les experts",
    "CP1: the wall eyebrow renders the localized override");
}

// --- CP2: no payload copy -> conf untouched; degenerate confs never throw -----------
{
  const conf = { ctx: "product", pid: 9, str: Object.assign({}, ENDO_STR) };
  const snapshot = JSON.stringify(conf.str);
  S.endoApplyCopy(conf, { total: 5, items: [] });
  ok(JSON.stringify(conf.str) === snapshot, "CP2: absent data.copy is a no-op");
  S.endoApplyCopy(null, { copy: { oe: "x" } });
  S.endoApplyCopy({ ctx: "product" }, { copy: { oe: "x" } });
  S.endoApplyCopy(conf, null);
  S.endoApplyCopy(conf, { copy: "not-an-object" });
  ok(true, "CP2: degenerate inputs never throw");
}

// ============================================ endorsements overlay (OV, v8.21)
//
// badgeLinkAction "overlay" (island bo:1): the badge link opens a dialog
// via the SHARED lightbox machinery instead of scrolling — methodology
// note (ov -> od -> desc), the full card list, Show more pagination.

// --- OV1: click opens the overlay; structure + strings ------------------------------
{
  S.PF_LB_OPENED.length = 0;
  const badge = S.endoBadgeBuild(badgeConf({ bo: 1 }), { total: 73, items: endoFixture(24, 0) });
  const wallStub = S.document.createElement("div");
  wallStub.setAttribute("class", "cx-endo");
  const scrolls = [];
  wallStub.scrollIntoView = function () { scrolls.push(1); };
  S.document.body.appendChild(wallStub);
  S.PF_TRACKS.length = 0;
  click(badge.querySelector(".cx-endo-badge__link"));
  ok(S.PF_LB_OPENED.length === 1, "OV1: click hands the overlay to the lightbox machinery");
  ok(scrolls.length === 0, "OV1: overlay mode never scrolls the page");
  ok(S.PF_TRACKS.length === 1 && S.PF_TRACKS[0][1] === "click",
    "OV1: the click beacon still fires");
  const ov = S.PF_LB_OPENED[0];
  const card = ov.querySelector(".cx-endo-ov__card");
  ok(!!card && card.getAttribute("role") === "dialog" && card.getAttribute("aria-modal") === "true",
    "OV1: dialog semantics on the card");
  const title = ov.querySelector(".cx-endo-ov__title");
  ok(!!title && title.textContent === "Recommended by 73 dermatologists" &&
    !!title.querySelector("strong"),
    "OV1: the title is the badge headline with the bold live count");
  const ovCred = ov.querySelector(".cx-endo-ov__cred-text");
  ok(!!ovCred && ovCred.textContent === "Licensed dermatologists",
    "OV1: the credential line reuses the chip string");
  const ovNote = ov.querySelector(".cx-endo-ov__note");
  ok(!!ovNote && ovNote.textContent ===
    "Verified recommendations from licensed dermatologists.",
    "OV1: the methodology note defaults to the section description");
  ok(ov.querySelectorAll(".cx-endo__card").length === 24,
    "OV1: the full first page of endorsement cards renders");
  const ovProg = ov.querySelector(".cx-endo-ov__progress");
  ok(!!ovProg && ovProg.textContent === "Showing 24 of 73",
    "OV1: shown-of progress line");
  const close = ov.querySelector(".cx-endo-ov__close");
  ok(!!close && close.hasAttribute("data-cx-lb-close") &&
    close.getAttribute("aria-label") === "Close",
    "OV1: close button rides the lightbox close contract with the reused label");
  S.document.body.removeChild(wallStub);
}

// --- OV2: merchant/localized note override + @@N@@ substitution ---------------------
{
  S.PF_LB_OPENED.length = 0;
  const str = Object.assign({}, ENDO_STR, { ov: "All @@N@@ endorsements were independently verified." });
  const badge = S.endoBadgeBuild(badgeConf({ bo: 1, str }), { total: 73, items: endoFixture(24, 0) });
  click(badge.querySelector(".cx-endo-badge__link"));
  const ov2Note = S.PF_LB_OPENED[0].querySelector(".cx-endo-ov__note");
  ok(!!ov2Note && ov2Note.textContent ===
    "All 73 endorsements were independently verified.",
    "OV2: the ov override wins and substitutes the live count");
}

// --- OV3: Show more inside the overlay pages the same proxy -------------------------
{
  S.PF_LB_OPENED.length = 0;
  const badge = S.endoBadgeBuild(badgeConf({ bo: 1 }), { total: 73, items: endoFixture(24, 0) });
  click(badge.querySelector(".cx-endo-badge__link"));
  const ov = S.PF_LB_OPENED[0];
  const more = ov.querySelector(".cx-endo__show-more");
  ok(!!more && !more.hasAttribute("hidden"), "OV3: Show more visible while shown < total");
  S.PF_FETCH_CALLS.length = 0;
  S.PF_FETCH_QUEUE.push({ total: 73, items: endoFixture(24, 24) });
  click(more);
  ok(S.PF_FETCH_CALLS[0].qs === "?type=endorsements&page=2&per=24&product=9",
    "OV3: overlay pagination pins the exact product-scoped page-2 query");
  ok(ov.querySelectorAll(".cx-endo__card").length === 48,
    "OV3: page 2 cards append into the overlay list");
  const ov3Prog = ov.querySelector(".cx-endo-ov__progress");
  ok(!!ov3Prog && ov3Prog.textContent === "Showing 48 of 73",
    "OV3: progress advances");
}

// --- OV4: scroll mode is untouched (no overlay without bo) --------------------------
{
  S.PF_LB_OPENED.length = 0;
  const badge = S.endoBadgeBuild(badgeConf(), { total: 73, items: endoFixture(24, 0) });
  const wallStub = S.document.createElement("div");
  wallStub.setAttribute("class", "cx-endo");
  const scrolls = [];
  wallStub.scrollIntoView = function () { scrolls.push(1); };
  S.document.body.appendChild(wallStub);
  click(badge.querySelector(".cx-endo-badge__link"));
  ok(S.PF_LB_OPENED.length === 0 && scrolls.length === 1,
    "OV4: without bo the link scrolls exactly as before");
  S.document.body.removeChild(wallStub);
}

// v8.22 fixture: the proxy-served overlay-content codes, shared by the
// panel (P) and official-overlay (OF) series.
const OFFICIAL_STR = Object.assign({}, ENDO_STR, {
  oi: "Every endorsement comes from a licensed dermatologist.\n\nAll @@N@@ statements are kept on file.",
  fq: "Common questions",
  f1q: "Who are the dermatologists?", f1a: "All contributors are licensed.\nEach is named.",
  f2q: "How were these collected?", f2a: "Independently.",
  lt: "All @@N@@ dermatologists",
});

// ============================================= panel wall (P, v8.22)
//
// wallStyle "panel" (island ws:1): the official fixed-height wall —
// shield + count headline + credential chip over a horizontal rail of
// BARE cards (no in-place expander), closed by a View-all pill that
// opens the overlay. Density codes are ignored; absent ws keeps the
// classic wall byte-for-byte.

// --- P1: structure + fixed-height contract ------------------------------------------
{
  const conf = { ctx: "product", pid: 9, ws: 1, str: ENDO_STR };
  const panel = S.endoBuildSection(conf, { total: 73, items: endoFixture(24, 0) });
  ok(!!panel && panel.className === "cx-proof cx-endo cx-endo--panel" &&
     panel.getAttribute("data-cx-feature") === "derm_endorsements",
    "P1: ws:1 builds the panel root (cx-endo kept for idempotence + badge scroll target)");
  const headline = panel.querySelector(".cx-endo-panel__headline");
  ok(!!headline && headline.textContent === "Endorsed by 73 dermatologists" &&
     !!headline.querySelector("strong"),
    "P1: count headline with the bold live total");
  ok(!!headline.querySelector(".cx-endo-badge__shield"), "P1: shield leads the headline");
  const chip = panel.querySelector(".cx-endo-panel__chip-text");
  ok(!!chip && chip.textContent === "Licensed dermatologists",
    "P1: credential chip under the headline");
  ok(panel.querySelectorAll(".cx-endo-panel__rail .cx-endo__card").length === 24,
    "P1: all page-1 cards ride the rail");
  ok(!panel.querySelector(".cx-endo__more"),
    "P1: rail cards are BARE — no in-place expander can grow the fixed panel");
  ok(!panel.querySelector(".cx-endo__card--open"),
    "P1: bare cards stay clamped (never the unclamped degrade class)");
  ok(!panel.querySelector(".cx-endo__show-more") && !panel.querySelector(".cx-endo__progress"),
    "P1: no wall pagination machinery inside the panel (View-all owns the rest)");
  ok(!panel.querySelector(".cx-endo__headline") && !panel.querySelector(".cx-endo__desc"),
    "P1: none of the classic wall head pieces leak into the panel");
}

// --- P2: View-all CTA chain + overlay handoff + beacon ------------------------------
{
  const conf = { ctx: "product", pid: 9, ws: 1, str: Object.assign({}, ENDO_STR, { wc: "Read all @@N@@ endorsements" }) };
  const panel = S.endoBuildSection(conf, { total: 73, items: endoFixture(24, 0) });
  const cta = panel.querySelector(".cx-endo-panel__cta");
  ok(!!cta && cta.textContent === "Read all 73 endorsements",
    "P2: the proxy-served wc label wins with the live count substituted");
  S.PF_LB_OPENED.length = 0;
  S.PF_TRACKS.length = 0;
  click(cta);
  ok(S.PF_LB_OPENED.length === 1, "P2: View-all opens the overlay via the lightbox machinery");
  ok(S.PF_TRACKS.length === 1 && S.PF_TRACKS[0][0] === "derm_endorsements" &&
     S.PF_TRACKS[0][1] === "click",
    "P2: the View-all click beacon rides the existing key");
  // fallback chain: no wc -> the badge link label; neither -> Show more
  const noWc = S.endoBuildSection({ ctx: "product", pid: 9, ws: 1, str: ENDO_STR },
    { total: 73, items: endoFixture(24, 0) });
  ok(noWc.querySelector(".cx-endo-panel__cta").textContent === "Read their professional assessments",
    "P2: absent wc falls back to the badge link label");
  const bare = S.endoBuildSection({ ctx: "product", pid: 9, ws: 1, str: { one: "N @@N@@", other: "N @@N@@", more: "Show more" } },
    { total: 73, items: endoFixture(24, 0) });
  ok(bare.querySelector(".cx-endo-panel__cta").textContent === "Show more",
    "P2: last resort is the Show-more label (never a dead panel)");
}

// --- P4: the View-all pill ALWAYS opens the LIST overlay, even under os:1 -----------
// (merchant catch: the panel's clamped cards have no expander, so this
// button is the only route to the full quote texts — the official
// explainer, which carries no quotes, stays the badge link's overlay)
{
  const conf = { ctx: "product", pid: 9, ws: 1, os: 1, str: OFFICIAL_STR };
  const panel = S.endoBuildSection(conf, { total: 73, items: endoFixture(24, 0) });
  S.PF_LB_OPENED.length = 0;
  click(panel.querySelector(".cx-endo-panel__cta"));
  const ov = S.PF_LB_OPENED[0];
  ok(!!ov && ov.querySelectorAll(".cx-endo__card").length === 24 &&
     !ov.querySelector(".cx-endo-ov__card--official") &&
     !ov.querySelector(".cx-endo-ov__doc") && !ov.querySelector(".cx-endo-ov__intro"),
    "P4: panel View-all under os:1 opens the FULL endorsement list, never the explainer");
  ok(ov.querySelectorAll(".cx-endo__more").length > 0,
    "P4: the list's per-card Read-full expanders are reachable from the panel");
  // the badge link still opens the official explainer in the same config
  S.PF_LB_OPENED.length = 0;
  const badge = S.endoBadgeBuild(badgeConf({ bo: 1, os: 1, str: OFFICIAL_STR }), { total: 73, items: endoFixture(24, 0) });
  click(badge.querySelector(".cx-endo-badge__link"));
  ok(!!S.PF_LB_OPENED[0].querySelector(".cx-endo-ov__card--official"),
    "P4: the badge link keeps opening the official explainer alongside");
}

// --- P3: gates — ws absent keeps the classic wall; panel needs a headline -----------
{
  const wall = S.endoBuildSection({ ctx: "brand", pid: 0, str: ENDO_STR }, { total: 60, items: endoFixture(24, 0) });
  ok(!wall.className.includes("cx-endo--panel") && !!wall.querySelector(".cx-endo__wall"),
    "P3: no ws member -> the classic wall exactly as before");
  ok(S.endoBuildSection({ ctx: "product", pid: 9, ws: 1, str: ENDO_STR }, { total: 1, items: [] }) === null,
    "P3: empty payload -> no panel (fail closed)");
  ok(S.endoBuildSection({ ctx: "product", pid: 9, ws: 1, str: { more: "x" } },
    { total: 5, items: endoFixture(3, 0) }) === null,
    "P3: no headline string -> no official panel (fail closed)");
  // density codes are IGNORED under the panel (the panel IS the compact design)
  const cm = S.endoBuildSection({ ctx: "product", pid: 9, ws: 1, cm: 2, str: ENDO_STR },
    { total: 73, items: endoFixture(24, 0) });
  ok(!!cm && cm.className === "cx-proof cx-endo cx-endo--panel" &&
     !cm.className.includes("ultra"),
    "P3: cm codes are ignored under ws:1");
}

// ========================================= official overlay (OF, v8.22)
//
// overlayStyle "official" (island os:1): instead of browsing every
// endorsement one by one, the overlay explains where the recommendations
// come from — proxy-served intro paragraphs, FAQ dropdowns, then the
// dermatologist roster WITHOUT the individual quotes.

// --- OF1: structure — intro paragraphs, FAQ, roster; no quote cards -----------------
{
  S.PF_LB_OPENED.length = 0;
  const badge = S.endoBadgeBuild(badgeConf({ bo: 1, os: 1, str: OFFICIAL_STR }), { total: 73, items: endoFixture(24, 0) });
  click(badge.querySelector(".cx-endo-badge__link"));
  ok(S.PF_LB_OPENED.length === 1, "OF1: the badge link opens the official overlay");
  const ov = S.PF_LB_OPENED[0];
  ok(!!ov.querySelector(".cx-endo-ov__card--official"),
    "OF1: the official modifier rides the dialog card");
  const paras = ov.querySelectorAll(".cx-endo-ov__intro-p");
  ok(paras.length === 2 &&
     paras[0].textContent === "Every endorsement comes from a licensed dermatologist." &&
     paras[1].textContent === "All 73 statements are kept on file.",
    "OF1: intro splits into paragraphs and substitutes the live count");
  const subs = ov.querySelectorAll(".cx-endo-ov__sub");
  ok(subs.length === 2 && subs[0].textContent === "Common questions" &&
     subs[1].textContent === "All 73 dermatologists",
    "OF1: FAQ heading + roster heading (lt substitutes the count)");
  ok(ov.querySelectorAll(".cx-endo-ov__faq-item").length === 2,
    "OF1: only complete Q+A pairs render");
  ok(ov.querySelectorAll(".cx-endo-ov__doc").length === 24,
    "OF1: the roster lists every page-1 dermatologist");
  ok(!ov.querySelector(".cx-endo__card") && !ov.querySelector(".cx-endo-ov__note"),
    "OF1: NO quote cards and no list-mode note in the official overlay");
  const doc0 = ov.querySelectorAll(".cx-endo-ov__doc")[0];
  ok(doc0.querySelector(".cx-endo-ov__doc-name").textContent === "Dr. Anna W0" &&
     doc0.querySelector(".cx-endo-ov__doc-creds").textContent === "MD · Germany" &&
     !!doc0.querySelector(".cx-endo-ov__doc-photo"),
    "OF1: roster row = name + creds · country + real photo");
  const doc1 = ov.querySelectorAll(".cx-endo-ov__doc")[1];
  ok(!doc1.querySelector(".cx-endo-ov__doc-photo") && !doc1.querySelector("span"),
    "OF1: photo-less roster row has NO avatar filler (the monogram rule)");
  ok(ov.querySelectorAll(".cx-endo-ov__body").length === 1 &&
     ov.querySelector(".cx-endo-ov__body").querySelectorAll(".cx-endo-ov__doc").length === 24,
    "OF1: everything under the header lives in the ONE scroll body");
}

// --- OF2: FAQ dropdowns toggle via aria-expanded + [hidden] -------------------------
{
  const faq = S.endoOverlayFaq(OFFICIAL_STR);
  const btn = faq.querySelectorAll(".cx-endo-ov__faq-q")[0];
  const panel = faq.querySelectorAll(".cx-endo-ov__faq-a")[0];
  ok(btn.getAttribute("aria-expanded") === "false" && panel.hasAttribute("hidden"),
    "OF2: dropdowns start closed");
  click(btn);
  ok(btn.getAttribute("aria-expanded") === "true" && !panel.hasAttribute("hidden"),
    "OF2: first press opens");
  ok(panel.querySelectorAll(".cx-endo-ov__faq-a-p").length === 2,
    "OF2: multi-line answers split into paragraphs");
  click(btn);
  ok(btn.getAttribute("aria-expanded") === "false" && panel.hasAttribute("hidden"),
    "OF2: second press closes");
  ok(S.endoOverlayFaq(Object.assign({}, ENDO_STR, { fq: "Questions" })) === null,
    "OF2: zero complete pairs -> no FAQ block (the heading never renders alone)");
  ok(S.endoOverlayFaq(Object.assign({}, ENDO_STR, { f1q: "Question without an answer", f2a: "Answer without a question" })) === null,
    "OF2: half pairs never render (a question needs its answer and vice versa)");
}

// --- OF3: degrades — no content pieces still leaves title + roster ------------------
{
  S.PF_LB_OPENED.length = 0;
  const badge = S.endoBadgeBuild(badgeConf({ bo: 1, os: 1 }), { total: 73, items: endoFixture(24, 0) });
  click(badge.querySelector(".cx-endo-badge__link"));
  const ov = S.PF_LB_OPENED[0];
  ok(!!ov && ov.querySelectorAll(".cx-endo-ov__doc").length === 24,
    "OF3: a stale/absent payload.copy still shows the roster");
  // review catch: blank/absent oi HIDES the intro — no note-chain
  // fallback (the admin promises blank = hidden; the catalog description
  // must never resurrect a piece the merchant removed)
  ok(!ov.querySelector(".cx-endo-ov__intro") && !ov.querySelector(".cx-endo-ov__note"),
    "OF3: absent oi -> NO intro at all (title + roster stand alone)");
  ok(!ov.querySelector(".cx-endo-ov__faq"), "OF3: no FAQ content -> no FAQ block");
}

// --- OF6: proxy-only copy is RAW — entities the merchant typed stay literal ---------
{
  S.PF_LB_OPENED.length = 0;
  const str = Object.assign({}, ENDO_STR, {
    oi: "Our R&amp;D team &lt;independently&gt; reviews.",
    fq: "Q&amp;A",
    f1q: "A &amp; B?", f1a: "Yes &amp; no.",
    lt: "All &lt;26&gt; doctors",
    wc: "See &amp; read all",
  });
  const badge = S.endoBadgeBuild(badgeConf({ bo: 1, os: 1, str }), { total: 73, items: endoFixture(24, 0) });
  click(badge.querySelector(".cx-endo-badge__link"));
  const ov = S.PF_LB_OPENED[0];
  ok(ov.querySelectorAll(".cx-endo-ov__intro-p")[0].textContent ===
     "Our R&amp;D team &lt;independently&gt; reviews.",
    "OF6: intro serves the merchant text VERBATIM (no entity un-escape on raw proxy copy)");
  const subs6 = ov.querySelectorAll(".cx-endo-ov__sub");
  ok(subs6[0].textContent === "Q&amp;A" && subs6[1].textContent === "All &lt;26&gt; doctors",
    "OF6: FAQ + roster headings stay verbatim too");
  const panel6 = S.endoBuildSection({ ctx: "product", pid: 9, ws: 1, str }, { total: 73, items: endoFixture(24, 0) });
  ok(panel6.querySelector(".cx-endo-panel__cta").textContent === "See &amp; read all",
    "OF6: the panel CTA stays verbatim (the ol/bl/more fallbacks keep their t-filter decode)");
}

// --- OF4: pagination appends roster rows (not cards) --------------------------------
{
  S.PF_LB_OPENED.length = 0;
  const badge = S.endoBadgeBuild(badgeConf({ bo: 1, os: 1, str: OFFICIAL_STR }), { total: 73, items: endoFixture(24, 0) });
  click(badge.querySelector(".cx-endo-badge__link"));
  const ov = S.PF_LB_OPENED[0];
  const more = ov.querySelector(".cx-endo__show-more");
  ok(!!more && !more.hasAttribute("hidden"), "OF4: Show more visible while shown < total");
  S.PF_FETCH_QUEUE.push({ total: 73, items: endoFixture(24, 24) });
  click(more);
  ok(ov.querySelectorAll(".cx-endo-ov__doc").length === 48 && !ov.querySelector(".cx-endo__card"),
    "OF4: page 2 appends roster rows, never quote cards");
  const prog = ov.querySelector(".cx-endo-ov__progress");
  ok(!!prog && prog.textContent === "Showing 48 of 73", "OF4: progress advances");
}

// --- OF5: without os the list overlay keeps the v8.21 shape (in the body) -----------
{
  S.PF_LB_OPENED.length = 0;
  const badge = S.endoBadgeBuild(badgeConf({ bo: 1 }), { total: 73, items: endoFixture(24, 0) });
  click(badge.querySelector(".cx-endo-badge__link"));
  const ov = S.PF_LB_OPENED[0];
  ok(ov.querySelectorAll(".cx-endo__card").length === 24 &&
     !ov.querySelector(".cx-endo-ov__doc") && !ov.querySelector(".cx-endo-ov__intro"),
    "OF5: no os member -> the browsable list, no official pieces");
  const body = ov.querySelector(".cx-endo-ov__body");
  ok(!!body && body.querySelectorAll(".cx-endo__card").length === 24 &&
     !!body.querySelector(".cx-endo-ov__note"),
    "OF5: note + list share the ONE scroll body (the mid-line clip fix)");
}

// ======================================= REAL lightbox machinery (LB, v8.21)
//
// OV1-OV4 run against a RECORDING pfLbOpen stub, which is precisely why
// the interior-click tautology hid there (review catch). This block
// executes the REAL pfLbOpen/pfLbClose/pfLbFocusables in a second
// context and drives the actual click/focus semantics.
{
  const LB = extractAll(SRC, {
    vars: ["pfLbState"],
    functions: ["pfLbFocusables", "pfLbClose", "pfLbOpen"],
  });
  const lbDoc = makeDocument();
  lbDoc.addEventListener = function () { /* keydown recorded elsewhere */ };
  lbDoc.removeEventListener = function () { /* noop */ };
  const S2 = { console, document: lbDoc, window: {} };
  vm.createContext(S2);
  vm.runInContext(LB, S2);
  function lbFixture() {
    const root = lbDoc.createElement("div");
    root.setAttribute("class", "cx-endo-ov");
    const card = lbDoc.createElement("div");
    card.setAttribute("class", "cx-endo-ov__card");
    card.setAttribute("tabindex", "-1");
    const inner = lbDoc.createElement("p");
    card.appendChild(inner);
    const closeBtn = lbDoc.createElement("button");
    closeBtn.setAttribute("data-cx-lb-close", "");
    card.appendChild(closeBtn);
    root.appendChild(card);
    return { root, card, inner, closeBtn };
  }
  // --- LB1: open mounts + locks + focuses the OVERLAY card ------------------
  const f1 = lbFixture();
  const focused = [];
  f1.card.focus = function () { focused.push("card"); };
  const trigger = lbDoc.createElement("a");
  trigger.setAttribute("href", "#");
  const trigFocus = [];
  trigger.focus = function () { trigFocus.push(1); };
  S2.pfLbOpen(f1.root, trigger);
  ok(f1.root.parentNode === lbDoc.body && f1.root.id === "cx-proof-lb",
    "LB1: open appends the singleton to body");
  ok(lbDoc.body.style.overflow === "hidden", "LB1: body scroll locks");
  ok(focused.length === 1,
    "LB1: the OVERLAY card receives initial focus (the widened lookup)");
  // --- LB2: interior clicks NEVER close (the tautology regression net) ------
  f1.root._fire("click", { target: f1.inner });
  ok(f1.root.parentNode === lbDoc.body,
    "LB2: a click INSIDE the card keeps the dialog open");
  // --- LB3: a data-cx-lb-close click closes + restores ----------------------
  f1.root._fire("click", { target: f1.closeBtn });
  ok(f1.root.parentNode === null && lbDoc.body.style.overflow === "" &&
    trigFocus.length === 1,
    "LB3: close button closes, unlocks scroll, restores trigger focus");
  // --- LB4: a DIRECT scrim click closes -------------------------------------
  const f2 = lbFixture();
  S2.pfLbOpen(f2.root, null);
  f2.root._fire("click", { target: f2.root });
  ok(f2.root.parentNode === null, "LB4: a direct scrim/gutter click closes");
  // --- LB5: focusables skip hidden + tabindex -1 ----------------------------
  const f3 = lbFixture();
  const hiddenBtn = lbDoc.createElement("button");
  hiddenBtn.setAttribute("hidden", "");
  f3.card.appendChild(hiddenBtn);
  const negTab = lbDoc.createElement("button");
  negTab.setAttribute("tabindex", "-1");
  f3.card.appendChild(negTab);
  const items = S2.pfLbFocusables(f3.card);
  ok(items.length === 1 && items[0] === f3.closeBtn,
    "LB5: hidden and tabindex=-1 controls never join the focus trap");
}

// ---------------------------------------------------------------- mutants
if (!process.env.CX_SKIP_MUTANTS && failures === 0) {
  const failedMutants = runMutants({
    selfPath: __filename,
    srcPath: REAL_SRC,
    mutants: [
      {
        name: "m11-wall-drops-items",
        find: "    for (var i = 0; i < items.length; i++) {\n      var item = items[i];\n      var li = pfEl('li', 'cx-press__wall-card');",
        replace: "    for (var i = 0; i < 1; i++) {\n      var item = items[i];\n      var li = pfEl('li', 'cx-press__wall-card');",
      },
      {
        name: "m12-wall-dispatch-dead",
        find: "    if (conf.ly === 'w') return pressBuildWall(items, s);",
        replace: "",
      },
      {
        name: "m1-https-guard-bypass",
        find: "    return typeof url === 'string' && /^https:\\/\\/\\S+$/i.test(url) ? url : '';",
        replace: "    return typeof url === 'string' ? url : '';",
      },
      {
        name: "m2-banner-inverted",
        find: "    if (pfPosInt(verified)) return { tpl: pfStr(s, 'bv'), n: verified };\n    if (pfPosInt(total)) return { tpl: pfStr(s, 'ba'), n: total };",
        replace: "    if (pfPosInt(total)) return { tpl: pfStr(s, 'ba'), n: total };\n    if (pfPosInt(verified)) return { tpl: pfStr(s, 'bv'), n: verified };",
      },
      {
        // v8.22: the panel gate ignored — ws:1 must NEVER fall through to
        // the classic wall (P-series asserts the panel structure).
        name: "m3-panel-gate-dropped",
        find: "    if (conf.ws === 1) return endoPanelBuild(conf, data);",
        replace: "    if (false) return endoPanelBuild(conf, data);",
      },
      {
        name: "m4-per-cap-dropped",
        find: "        proofFetch('endorsements', pfProductParams(conf, { page: page + 1, per: 24 }), function (next) {",
        replace: "        proofFetch('endorsements', pfProductParams(conf, { page: page + 1 }), function (next) {",
      },
      {
        name: "m5-innerhtml-sink",
        find: "      var q = pfEl('p', 'cx-results__quote');\n      q.textContent = item.text;",
        replace: "      var q = pfEl('p', 'cx-results__quote');\n      q.innerHTML = item.text;",
      },
      {
        name: "m6-imageless-rows-kept",
        find: "      if (!before && !after && !combined) continue; // a visual gallery card needs at least one image",
        replace: "",
      },
      {
        name: "m7-press-cm-gate-inverted",
        find: "    var ultra = !logosOnly && conf.cm === 2;\n    var compact = !logosOnly && conf.cm === 1;\n    var openIdx = -1; // ultra only: which quote is revealed (-1 = collapsed)",
        replace: "    var ultra = !logosOnly && conf.cm !== 2;\n    var compact = !logosOnly && conf.cm === 1;\n    var openIdx = -1; // ultra only: which quote is revealed (-1 = collapsed)",
      },
      {
        name: "m8-press-reveal-broken",
        find: "        show(idx);\n        if (ultra) {\n          quote.removeAttribute('hidden');\n          openIdx = idx;\n        }",
        replace: "        show(idx);\n        if (ultra) {\n          openIdx = idx;\n        }",
      },
      {
        // v8.3 tier confusion: the NEW middle tier silently treated as
        // ultra — the C1 compact case (quote VISIBLE without a tap) and
        // the --compact root-modifier assert both catch it.
        name: "m10-press-tier-confusion",
        find: "    var ultra = !logosOnly && conf.cm === 2;\n    var compact = !logosOnly && conf.cm === 1;\n    var openIdx = -1; // ultra only: which quote is revealed (-1 = collapsed)",
        replace: "    var ultra = !logosOnly && (conf.cm === 2 || conf.cm === 1);\n    var compact = false;\n    var openIdx = -1; // ultra only: which quote is revealed (-1 = collapsed)",
      },
      {
        name: "m13-press-logosonly-dead",
        find: "    var logosOnly = quoted.length === 0;",
        replace: "    var logosOnly = false;",
      },
      {
        name: "m14-press-static-lost",
        find: "      var isBtn = !logosOnly && !!items[i].q;",
        replace: "      var isBtn = true;",
      },
      {
        name: "m15-press-first-quote-lost",
        find: "    show(quoted[0]);\n    return root;",
        replace: "    show(0);\n    return root;",
      },
      {
        // v8.17: badge leaks onto home/collection contexts.
        name: "m16-badge-ctx-gate-dropped",
        find: "    if (conf.bd !== 1 || conf.ctx !== 'product') return null;",
        replace: "    if (conf.bd !== 1) return null;",
      },
      {
        // v8.17: the five-portrait cap silently dropped.
        name: "m17-badge-avatar-cap-dropped",
        find: "    for (var i = 0; i < items.length && shown < max; i++) {",
        replace: "    for (var i = 0; i < items.length; i++) {",
      },
      {
        // v8.17: anchorless pages get a body-appended badge (the exact
        // fail-open the mount contract forbids).
        name: "m18-badge-fail-open-body",
        find: "    // Fail closed: no documented anchor, no render — never body-append.\n    return false;",
        replace: "    document.body.appendChild(node);\n    return true;",
      },
      {
        // v8.17: the count_headline fallback dropped — locales that ship
        // badge_headline blank (el) would lose the badge entirely.
        name: "m19-badge-headline-fallback-dropped",
        find: "    if (!/\\S/.test(headTpl)) headTpl = pfStr(s, total === 1 ? 'one' : 'other');\n    if (!/\\S/.test(headTpl)) return null; // no headline, no badge",
        replace: "    if (!/\\S/.test(headTpl)) return null; // no headline, no badge",
      },
      {
        // v8.17b: single-occurrence substitution regression (the exact
        // pre-review bug) — B5b catches the leftover @@N@@.
        name: "m20-badge-n-first-only",
        find: "    var parts = String(tpl).split('@@N@@');",
        replace: "    var parts = [String(tpl).replace('@@N@@', String(total))];",
      },
      {
        // v8.18: the design gate dropped — every style renders classic.
        name: "m21-badge-style-gate-dropped",
        find: "    var style = conf.bst === 1 ? 'choice' : conf.bst === 2 ? 'slim' : conf.bst === 3 ? 'choice-c' : '';",
        replace: "    var style = '';",
      },
      {
        // v8.18: the slim counter counts the whole pool instead of the
        // spillover — "+73" over three visible portraits misstates.
        name: "m22-badge-plus-overcounts",
        find: "      plus.textContent = '+' + String(total - av.shown);",
        replace: "      plus.textContent = '+' + String(total);",
      },
      {
        // v8.21: the overlay gate dropped — every mode scrolls again.
        name: "m23-overlay-gate-dropped",
        find: "          if (conf.bo === 1) {\n            // v8.21 overlay behavior: browse everything in place.\n            endoOverlayOpen(conf, data, link);",
        replace: "          if (false) {\n            // v8.21 overlay behavior: browse everything in place.\n            endoOverlayOpen(conf, data, link);",
      },
      {
        // v8.21: the note fallback chain dropped — the overlay loses its
        // methodology text whenever no merchant override is set.
        name: "m24-overlay-note-chain-dropped",
        find: "    if (!/\\S/.test(t)) t = endoText(s, 'od', 'desc');",
        replace: "",
      },
      {
        // v8.21 review catch: reverting the gutter fix closes the dialog
        // on any interior click — LB2 catches.
        name: "m25-gutter-tautology-restored",
        find: "        if (event.target === root) pfLbClose();",
        replace: "        if (el === root) pfLbClose();",
      },
      {
        // v8.21: hidden controls back in the trap — LB5 catches.
        name: "m26-hidden-focusable-kept",
        find: "        if (nodes[i].hasAttribute('hidden')) continue;",
        replace: "",
      },
      {
        // v8.22: the official-overlay gate dropped — os:1 silently
        // renders the quote list again (OF1 catches).
        name: "m27-official-gate-dropped",
        find: "    var official = !forceList && conf.os === 1;",
        replace: "    var official = false;",
      },
      {
        // v8.22: half FAQ pairs rendered — a question without its answer
        // would ship a dead dropdown (OF2's half-pair case catches).
        name: "m28-faq-halfpair-rendered",
        find: "      if (/\\S/.test(q) && /\\S/.test(a)) items.push({ q: q, a: a });",
        replace: "      if (/\\S/.test(q) || /\\S/.test(a)) items.push({ q: q, a: a });",
      },
      {
        // v8.22: official pagination regressed to quote cards — the
        // roster would grow cards after page 1 (OF4 catches).
        name: "m29-official-pagination-cards",
        find: "            list.appendChild(official ? endoOverlayDocRow(extra[j]) : endoBuildCard(extra[j], s));",
        replace: "            list.appendChild(endoBuildCard(extra[j], s));",
      },
      {
        // v8.22 review catch: the raw reader regressed to the decoding
        // pfStr — merchant-typed entities would un-escape (OF6 catches).
        name: "m30-raw-decode-regressed",
        find: "      var introText = pfStrRaw(s, 'oi');",
        replace: "      var introText = pfStr(s, 'oi');",
      },
      {
        // v8.22 merchant catch: the panel CTA forced-list flag dropped —
        // under os:1 the pill would open the quoteless explainer and the
        // full endorsement texts would be unreachable (P4 catches).
        name: "m31-panel-cta-opens-explainer",
        find: "        endoOverlayOpen(conf, data, cta, true);",
        replace: "        endoOverlayOpen(conf, data, cta);",
      },
      {
        // v25: resultsClinical's own lab gate dropped — redundant with
        // the resultsValidItems gate through the public path, so it is
        // pinned by R20's DIRECT call (the v21.1 latch-pin precedent).
        name: "m32-clin-secondgate-dropped",
        find: "    if (!item.lab) return null;\n    var rows = item.m;",
        replace: "    var rows = item.m;",
      },
      {
        // v25: the valid-items lab gate dropped — a customer submission
        // carrying a measurements payload would render instrument claims
        // (R20's customer case catches).
        name: "m33-validitems-lab-gate-dropped",
        find: "        m: lab ? resultsValidMeasurements(it.measurements) : [],",
        replace: "        m: resultsValidMeasurements(it.measurements),",
      },
      {
        // v25: the copy whitelist dropped — any proxy field could then
        // overwrite island strings like the banner (R22's HACK catches).
        name: "m34-copy-whitelist-dropped",
        find: "    var keys = ['rp', 'ma', 'vsb', 'mi', 'mp', 'mu', 'aw', 'dr', 'iv', 'zm'];",
        replace: "    var keys = []; for (var ck in data.copy) keys.push(ck);",
      },
      {
        // v25/v26.2: the percent validator bypassed — a fat-fingered
        // 9999% would render as clinical proof (R20's case catches).
        name: "m35-pct-cap-dropped",
        find: "      var pct = resultsValidPct(m.pct) ? m.pct : 0;",
        replace: "      var pct = typeof m.pct === 'number' && m.pct > 0 ? m.pct : 0;",
      },
      {
        // v26.2: the one-decimal bound dropped — 34.25 would render as
        // over-precise fake rigor (R20's 34.25 row catches).
        name: "m37-decimal-unbounded",
        find: "    return typeof v === 'number' && isFinite(v) && v > 0 && v <= 500 && /^\\d+(\\.\\d)?$/.test(String(v));",
        replace: "    return typeof v === 'number' && isFinite(v) && v > 0 && v <= 500;",
      },
      {
        // v25: attribution name regressed to a markup sink (R19's
        // _innerHTML pin catches).
        name: "m36-attr-html-sink",
        find: "    name.textContent = item.an;",
        replace: "    name.innerHTML = item.an;",
      },
      {
        name: "m9-preview-always-verified",
        find: "    try {\n      if (window.sessionStorage.getItem('cx_preview_ok') === '1') return true;\n    } catch (e) { /* noop */ }\n    return false;\n  }",
        replace: "    return true;\n  }",
      },
      {
        // v33: loosened flag reads would let a '1'/true-shaped payload
        // (or a poisoned cache) switch designs (R25's strict case).
        name: "m38-ui-flags-not-strict",
        find: "    return { cs: ui.cs === 1, sl: ui.sl === 1 };",
        replace: "    return { cs: !!ui.cs, sl: !!ui.sl };",
      },
      {
        // v33: the combined column must never render for customer rows,
        // whatever the payload claims (R26's belt case).
        name: "m39-combined-lab-gate-dropped",
        find: "      var combined = lab ? pfHttps(it.combinedUrl) : '';",
        replace: "      var combined = pfHttps(it.combinedUrl);",
      },
      {
        // v33: an unclamped divider would clip outside the stage
        // (R31's clamp cases).
        name: "m40-slider-clamp-dropped",
        find: "    if (p < 0) p = 0;\n    if (p > 100) p = 100;\n    return p;",
        replace: "    return p;",
      },
      {
        // v33: the study band on customer cards would dress customer
        // submissions as clinical studies (R29's customer case).
        name: "m41-study-lab-gate-dropped",
        find: "    if (!o || !o.cs || !item.lab) return null;\n    var label = pfStr(s, 'lb');",
        replace: "    if (!o || !o.cs) return null;\n    var label = pfStr(s, 'lb');",
      },
      {
        // v33: a week stamp on weekless entries would fabricate "After 0
        // weeks" claims (R29's weekless case).
        name: "m42-aftertag-weekless-stamped",
        find: "    if (o && o.cs && item.lab && item.weeks) {",
        replace: "    if (o && o.cs && item.lab) {",
      },
      {
        // v33 review C4: without the capability gate, aspect-ratio-less
        // WebKit renders a zero-height stage pile (R33 catches).
        name: "m43-slider-caps-gate-dropped",
        find: "      if (window.CSS && window.CSS.supports &&\n          (!window.CSS.supports('aspect-ratio', '1 / 1') ||\n            !window.CSS.supports('clip-path', 'inset(0 50% 0 0)'))) {\n        return null;\n      }",
        replace: "",
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
console.log(`ALL ${checks} CHECKS PASSED (v8 proof library — press/wall/gallery vs the real cellexia-proof.js)`);
