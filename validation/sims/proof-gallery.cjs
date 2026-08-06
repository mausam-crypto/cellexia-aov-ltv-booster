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
  vars: ["RESULTS_SKIN_KEYS", "RESULTS_DURATION_KEYS"],
  functions: [
    "pfEl", "pfSp", "pfSvg", "pfDecode", "pfStr", "pfHttps", "pfVideoFile",
    "pfPosInt", "pfPageLocale", "pfRegionName", "pfQuery", "pfProductParams",
    "pfPreviewVerified", "pfBeaconsOff", "pfWhenAllowed", // v8.2: preview contract (V)
    "pressItems", "pressBuildWall", "pressBuildSection",
    "endoInitials", "endoValidItems", "endoBuildCard", "endoBuildSection",
    "resultsBannerData", "resultsFacetLabel", "resultsParams",
    "resultsValidItems", "resultsMetaLine", "resultsBadges",
    "resultsBuildFrame", "resultsBuildCard", "resultsBuildLightbox",
    "resultsFacetGroups", "resultsBuildSection",
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
  bv: "See results from @@N@@ verified Cellexia customers.",
  ba: "See results from @@N@@ Cellexia customers.",
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
ok(S.pressBuildSection({ str: PRESS_STR }, { items: [{ publication: "X" }] }) === null,
  "P4: quote-less rows dropped -> no band");

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

// --- W1: monogram initials -----------------------------------------------------------
ok(S.endoInitials("Dr. Anna Weiss") === "AW", "W1: abbreviation tokens (Dr.) skipped");
ok(S.endoInitials("prof. dr. maria van der berg") === "MB", "W1: multi-abbreviation names");
ok(S.endoInitials("Cher") === "C", "W1: single-token name");
ok(S.endoInitials("Dr.") === "D", "W1: only-abbreviation name falls back to itself");
ok(S.endoInitials("") === "" && S.endoInitials("   ") === "", "W1: degenerate names -> no monogram");

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

// --- W6: portrait vs monogram per card -----------------------------------------------
{
  const withImg = S.endoBuildCard({ n: "Dr. Anna Weiss", q: "Q", c: "MD", cc: "DE", img: "https://cdn/p.jpg" }, ENDO_STR);
  const photo = withImg.querySelector(".cx-endo__photo");
  ok(!!photo && photo.src === "https://cdn/p.jpg", "W6: https portrait used when present");
  ok(!withImg.querySelector(".cx-endo__monogram"), "W6: no monogram beside a photo");
  const noImg = S.endoBuildCard({ n: "Dr. Anna Weiss", q: "Q", c: "MD", cc: "DE", img: "" }, ENDO_STR);
  const mono = noImg.querySelector(".cx-endo__monogram");
  ok(!!mono && mono.textContent === "AW", "W6: monogram fallback without a portrait");
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
  ok(section.querySelector(".cx-results__banner").textContent === "See results from 25 verified Cellexia customers.",
    "R8: verified wording with verifiedTotal");
}

// --- R9: verifiedTotal 0 falls back to banner_all ------------------------------------
{
  const fx = resultsFixture();
  fx.verifiedTotal = 0;
  const section = S.resultsBuildSection({ ctx: "brand", pid: 0, str: STR }, fx);
  ok(section.querySelector(".cx-results__banner").textContent === "See results from 40 Cellexia customers.",
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
    "See results from 25 verified Cellexia customers.",
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
    "See results from 25 verified Cellexia customers.",
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
        name: "m3-monogram-abbrev-kept",
        find: "      if (parts[i] && !/\\.$/.test(parts[i])) keep.push(parts[i]);",
        replace: "      if (parts[i]) keep.push(parts[i]);",
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
        find: "      if (!before && !after) continue; // a visual gallery card needs at least one image",
        replace: "",
      },
      {
        name: "m7-press-cm-gate-inverted",
        find: "    var ultra = conf.cm === 2;\n    var compact = conf.cm === 1;\n    var openIdx = -1; // ultra only: which quote is revealed (-1 = collapsed)",
        replace: "    var ultra = conf.cm !== 2;\n    var compact = conf.cm === 1;\n    var openIdx = -1; // ultra only: which quote is revealed (-1 = collapsed)",
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
        find: "    var ultra = conf.cm === 2;\n    var compact = conf.cm === 1;\n    var openIdx = -1; // ultra only: which quote is revealed (-1 = collapsed)",
        replace: "    var ultra = conf.cm === 2 || conf.cm === 1;\n    var compact = false;\n    var openIdx = -1; // ultra only: which quote is revealed (-1 = collapsed)",
      },
      {
        name: "m9-preview-always-verified",
        find: "    try {\n      if (window.sessionStorage.getItem('cx_preview_ok') === '1') return true;\n    } catch (e) { /* noop */ }\n    return false;\n  }",
        replace: "    return true;\n  }",
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
