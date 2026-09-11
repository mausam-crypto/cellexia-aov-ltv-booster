/**
 * v20 image-badge sizing sim — runs the REAL widening machinery
 * vm-extracted from extensions/cellexia-booster/assets/cellexia-pdp.js:
 *
 *  - the live/draft gate (pdpMemberAllowed): live on its own, draft ONLY
 *    inside a verified preview session, and the market verdict the proxy
 *    hands a preview session;
 *  - the clamp (ibSizeFor): the merchant's percentage of the THEME's own
 *    badge width, capped so no badge passes a quarter of the product image,
 *    no row passes three quarters of it or the image's left edge, and the
 *    result is never smaller than what the theme already renders;
 *  - fail-closed rules: no member, no badges, an unmeasurable image, a
 *    hidden row (the theme ships a desktop AND a mobile copy), a viewport
 *    above the stylesheet's 576px breakpoint;
 *  - idempotence: re-running never compounds the scale, and turning the
 *    feature off (or rotating to a wide viewport) restores the theme's own
 *    size by removing the property and the class.
 *
 * Geometry fixtures are the REAL measurements taken on the live Sleepify
 * PDP (2026-09-11) at 320 / 375 / 414 px, plus the 600px tablet case where
 * the theme already sizes badges well.
 *
 * Documented stubs: mini-dom elements gain getBoundingClientRect (fixture
 * rects) and a style object with setProperty/removeProperty — the two DOM
 * surfaces this feature touches. matchMedia is scripted from the fixture
 * viewport. No timers run: ibBind's listeners are captured, not fired.
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
// The mutation runner re-runs this suite against a mutated COPY of the real
// asset through CX_SIM_SRC; everything else reads the shipped file.
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;
const SRC = fs.readFileSync(SRC_PATH, "utf8");

const EXTRACTED = extractAll(SRC, {
  vars: ["CX_IB_BASE_PX", "CX_IB_MAX_IMAGE_SHARE", "CX_IB_MAX_ROW_SHARE", "CX_IB_MAX_VW", "ibBound", "ibTimer"],
  functions: [
    "pdpMember",
    "pdpMemberAllowed",
    "ibData",
    "ibAllowed",
    "ibScale",
    "ibPhone",
    "ibImageBox",
    "ibBasePx",
    "ibClear",
    "ibSizeFor",
    "ibApply",
    "ibBind",
    "mountImageBadges",
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

// ---------------------------------------------------------------- fixtures
//
// Live Sleepify geometry, measured 2026-09-11. The image column is the
// viewport minus the 20px page gutters; the product image is that column
// minus the 12px slide padding on each side; the badge row is right-anchored
// 15px inside the column. Badges are 45px below 577px and 100px above it.
const LIVE = {
  320: { column: 280, image: 256, badge: 45 },
  375: { column: 335, image: 311, badge: 45 },
  414: { column: 374, image: 350, badge: 45 },
  600: { column: 506, image: 482, badge: 100 },
};

function rect(left, top, width, height) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

/** One .pdp > .pdp__images--X > (.badges + .pdp__slider--main) subtree with
 *  fixture rects, mirroring the theme's real DOM. */
function makeRow(doc, opts) {
  const o = Object.assign(
    { vw: 375, badges: 3, visible: true, imageMeasurable: true, gutter: 20 },
    opts,
  );
  const geo = LIVE[o.vw] || LIVE[375];
  const columnLeft = o.gutter;
  const imageLeft = columnLeft + 12;
  const rowRight = columnLeft + geo.column - 15;

  const host = new El("div");
  host.className = "pdp__images pdp__images--default pdp__images--mobile";
  host.getBoundingClientRect = () => rect(columnLeft, 0, o.visible ? geo.column : 0, o.visible ? geo.column : 0);

  const slider = new El("div");
  slider.className = "pdp__slider--main";
  const slide = new El("div");
  slide.className = "slick-protect slick-current";
  const img = new El("img");
  const measurable = o.visible && o.imageMeasurable;
  img.getBoundingClientRect = () =>
    measurable ? rect(imageLeft, 0, geo.image, geo.image) : rect(0, 0, 0, 0);
  slide.appendChild(img);
  slider.appendChild(slide);

  const wrap = new El("div");
  wrap.className = "badges d-flex align-center";
  // The row is absolutely positioned with `right: 15px`: its RIGHT edge is
  // fixed by the theme however wide the badges get.
  wrap.getBoundingClientRect = () => rect(rowRight - 1, 15, o.visible ? 1 : 0, o.visible ? 1 : 0);
  wrap.style = styleStub();
  for (let i = 0; i < o.badges; i++) {
    const badge = new El("div");
    badge.className = "badge badge--";
    // A badge measures at the theme's own width until the stylesheet rule
    // takes over — which needs BOTH the marker class and a viewport inside
    // the media query, exactly like the browser.
    badge.getBoundingClientRect = () => {
      if (!o.visible) return rect(0, 0, 0, 0);
      const applied =
        o.vw <= 576 && wrap.classList.contains("cx-ib-on")
          ? parseFloat(wrap.style.getPropertyValue("--cx-ib-w"))
          : NaN;
      const width = isFinite(applied) && applied > 0 ? applied : geo.badge;
      return rect(0, 15, width, width);
    };
    wrap.appendChild(badge);
  }

  host.appendChild(wrap);
  host.appendChild(slider);
  const pdp = doc.querySelector(".pdp") || (() => {
    const section = new El("section");
    section.className = "pdp pdp--default";
    doc.body.appendChild(section);
    return section;
  })();
  pdp.appendChild(host);
  return { host, wrap, img, slider };
}

function styleStub() {
  const props = {};
  return {
    props,
    setProperty(name, value) {
      props[name] = value;
    },
    removeProperty(name) {
      delete props[name];
    },
    getPropertyValue(name) {
      return props[name] || "";
    },
  };
}

function run(opts) {
  const o = Object.assign({ vw: 375, scale: 140, live: true }, opts);
  const doc = makeDocument();
  const rows = (o.rows || [{}]).map((rowOpts) =>
    makeRow(doc, Object.assign({ vw: o.vw }, rowOpts)),
  );
  const cfg =
    o.member === null
      ? {}
      : { ib: Object.assign({ live: o.live, s: o.scale }, o.member || {}) };
  const listeners = [];
  const sandbox = {
    document: doc,
    JSON,
    console,
    cfg,
    PREVIEW: o.preview || null,
    window: {
      innerWidth: o.vw,
      matchMedia: o.noMatchMedia
        ? undefined
        : (query) => ({ matches: o.vw <= Number(/(\d+)px/.exec(query)[1]) }),
      addEventListener: (type, fn) => listeners.push(type),
      setTimeout: () => 1,
      clearTimeout: () => {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox, { filename: "extracted-ib-module.js" });
  vm.runInContext("mountImageBadges()", sandbox);
  return { doc, rows, sandbox, listeners };
}

const widthOf = (row) => row.wrap.style.getPropertyValue("--cx-ib-w");
const onOf = (row) => row.wrap.classList.contains("cx-ib-on");
const pxOf = (row) => parseFloat(widthOf(row) || "0") || 0;

// ------------------------------------------------- A. the merchant's size
{
  const { rows } = run({ vw: 375, scale: 140 });
  ok(onOf(rows[0]), "A1 a live, scaled row is marked for the stylesheet");
  ok(pxOf(rows[0]) === 63, `A1 375px phone, 140% of 45px -> 63px (got ${pxOf(rows[0])})`);
  ok(widthOf(rows[0]) === "63px", "A1 the property carries a px unit");

  ok(pxOf(run({ vw: 375, scale: 120 }).rows[0]) === 54, "A2 120% -> 54px");
  ok(pxOf(run({ vw: 375, scale: 160 }).rows[0]) === 72, "A2 160% -> 72px");
  ok(pxOf(run({ vw: 320, scale: 140 }).rows[0]) === 63, "A3 320px phone: same 63px (the cap is not reached)");
  ok(pxOf(run({ vw: 414, scale: 140 }).rows[0]) === 63, "A3 414px phone: same 63px");
}

// ------------------------------------------------------------- B. the cap
{
  // 200% of 45px is 90px, but a quarter of the 311px image is 77px.
  const { rows } = run({ vw: 375, scale: 200 });
  ok(pxOf(rows[0]) === 77, `B1 200% is capped to a quarter of the image (got ${pxOf(rows[0])})`);
  ok(pxOf(run({ vw: 320, scale: 200 }).rows[0]) === 64, "B1 the cap follows the image: 320px phone -> 64px");
  ok(pxOf(run({ vw: 414, scale: 200 }).rows[0]) === 87, "B1 414px phone -> 87px");

  // More badges: the ROW cap (and the image's left edge) binds first.
  const five = run({ vw: 375, scale: 200, rows: [{ badges: 5 }] }).rows[0];
  ok(pxOf(five) === 46, `B2 five badges at 200% shrink to 46px (got ${pxOf(five)})`);
  const six = run({ vw: 375, scale: 200, rows: [{ badges: 6 }] }).rows[0];
  ok(pxOf(six) === 0 && !onOf(six), "B2 six badges cannot grow at all — the theme's own size stands");

  // Whatever the count, a row WE size stays inside the picture — and a row
  // we cannot size keeps exactly what the theme renders today (a crowded
  // 5-badge row at the theme's own 45px is the theme's business, not ours).
  for (const vw of [320, 375, 414]) {
    for (const badges of [2, 3, 4, 5, 6]) {
      const row = run({ vw, scale: 200, rows: [{ badges }] }).rows[0];
      const px = pxOf(row);
      const geo = LIVE[vw];
      const imageLeft = 32;
      const rowRight = 20 + geo.column - 15;
      if (px === 0) {
        ok(!onOf(row), `B3 ${vw}px x${badges}: no room to grow -> the theme's own size, unmarked`);
        continue;
      }
      ok(px > geo.badge, `B3 ${vw}px x${badges}: a sized badge is always BIGGER than the theme's`);
      ok(
        px * badges <= rowRight - imageLeft,
        `B3 ${vw}px x${badges}: row (${px * badges}px) stays inside the image box`,
      );
      ok(
        px * badges <= geo.image * 0.75 + 0.5,
        `B3 ${vw}px x${badges}: row is at most three quarters of the image`,
      );
      ok(px <= geo.image * 0.25 + 0.5, `B3 ${vw}px x${badges}: one badge is at most a quarter of the image`);
    }
  }
}

// -------------------------------------------------------- C. fail closed
{
  ok(!onOf(run({ scale: 100 }).rows[0]), "C1 100% is a no-op — the theme's own size, no class");
  ok(!onOf(run({ scale: 0 }).rows[0]), "C1 a zero scale paints nothing");
  ok(!onOf(run({ member: null }).rows[0]), "C2 no island member (feature off in Liquid) -> untouched");
  ok(!onOf(run({ live: false }).rows[0]), "C3 a draft-only member outside a preview session -> untouched");
  ok(
    !onOf(run({ vw: 600, scale: 140 }).rows[0]),
    "C4 above the 576px breakpoint the theme keeps control",
  );
  ok(
    !onOf(run({ rows: [{ imageMeasurable: false }] }).rows[0]),
    "C5 an image that cannot be measured yet leaves the theme alone",
  );
  ok(!onOf(run({ rows: [{ badges: 0 }] }).rows[0]), "C6 a row with no badges is skipped");
  ok(
    !onOf(run({ rows: [{ visible: false }] }).rows[0]),
    "C7 the theme's hidden desktop copy of the row is never sized",
  );
  const scaleNaN = run({ scale: "140" });
  ok(!onOf(scaleNaN.rows[0]), "C8 a non-numeric scale fails closed");
}

// ---------------------------------------- D. both copies of the badge row
{
  // The theme renders the row TWICE (desktop + mobile); only the visible
  // one can be measured, and the hidden one must stay untouched.
  const { rows } = run({
    vw: 375,
    scale: 140,
    rows: [{ visible: false }, { visible: true }],
  });
  ok(!onOf(rows[0]), "D1 the hidden copy stays at the theme's size");
  ok(onOf(rows[1]) && pxOf(rows[1]) === 63, "D1 the visible copy is sized");
}

// ------------------------------------------------- E. preview (live/draft)
{
  const draftOn = run({
    live: false,
    scale: 140,
    preview: { live: {}, flags: { image_badges: true } },
  });
  ok(onOf(draftOn.rows[0]), "E1 a verified preview session renders the DRAFT flag");
  const draftOff = run({
    live: false,
    scale: 140,
    preview: { live: {}, flags: {} },
  });
  ok(!onOf(draftOff.rows[0]), "E2 a preview session without the flag renders nothing");
  const liveElsewhere = run({
    live: false,
    scale: 140,
    preview: { live: { image_badges: true }, flags: {} },
  });
  ok(
    onOf(liveElsewhere.rows[0]),
    "E3 preview honours the proxy's per-market LIVE verdict, not the page's own flag",
  );
}

// ------------------------------------------------ F. idempotence + reset
{
  const { rows, sandbox } = run({ vw: 375, scale: 140 });
  const first = pxOf(rows[0]);
  vm.runInContext("ibApply(); ibApply();", sandbox);
  ok(pxOf(rows[0]) === first, `F1 re-applying never compounds the scale (${first}px -> ${pxOf(rows[0])}px)`);
  ok(
    rows[0].wrap.getAttribute("data-cx-ib-base") === "45",
    "F1 the theme's own width is remembered from the FIRST measurement",
  );

  // Turning the feature off mid-session (or rotating past the breakpoint)
  // must restore the theme exactly.
  vm.runInContext("cfg.ib.live = false; ibApply();", sandbox);
  ok(!onOf(rows[0]) && widthOf(rows[0]) === "", "F2 switching off removes BOTH the class and the property");

  const wide = run({ vw: 375, scale: 140 });
  vm.runInContext("window.innerWidth = 900; window.matchMedia = function () { return { matches: false }; }; ibApply();", wide.sandbox);
  ok(!onOf(wide.rows[0]), "F3 growing past the breakpoint restores the theme's size");
}

// -------------------------------------------------------- G. re-measuring
{
  const { listeners } = run({ vw: 375, scale: 140 });
  ok(listeners.indexOf("resize") !== -1, "G1 re-measures on resize");
  ok(listeners.indexOf("orientationchange") !== -1, "G1 re-measures on rotation");
  const nomm = run({ vw: 375, scale: 140, noMatchMedia: true });
  ok(onOf(nomm.rows[0]), "G2 a browser without matchMedia falls back to the viewport width");
}

// ------------------------------------------------------------ H. twinning
{
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(EXTRACTED, sandbox, { filename: "extracted-ib-module.js" });
  const settings = fs.readFileSync(
    path.join(__dirname, "..", "..", "app", "models", "settings.server.ts"),
    "utf8",
  );
  const pin = (name) => {
    const m = new RegExp(`export const ${name} = ([0-9.]+);`).exec(settings);
    return m ? Number(m[1]) : NaN;
  };
  ok(sandbox.CX_IB_BASE_PX === pin("IMAGE_BADGE_BASE_PX"), "H1 base width twins the settings model");
  ok(
    sandbox.CX_IB_MAX_IMAGE_SHARE === pin("IMAGE_BADGE_MAX_IMAGE_SHARE"),
    "H1 per-badge cap twins the settings model",
  );
  ok(
    sandbox.CX_IB_MAX_ROW_SHARE === pin("IMAGE_BADGE_MAX_ROW_SHARE"),
    "H1 row cap twins the settings model",
  );
  const css = fs.readFileSync(
    path.join(__dirname, "..", "..", "extensions", "cellexia-booster", "assets", "cellexia-booster.css"),
    "utf8",
  );
  ok(
    css.includes(`@media screen and (max-width: ${sandbox.CX_IB_MAX_VW}px)`) &&
      css.includes(".pdp .badges.cx-ib-on .badge"),
    "H2 the stylesheet rule uses the same breakpoint the JS measures at",
  );
  ok(
    sandbox.ibScale({ s: 260 }) === 200,
    "H3 a scale above the admin maximum is clamped by the storefront too",
  );
}

console.log(
  failures === 0
    ? `ALL ${checks} CHECKS PASSED (v20 image badges vs the real cellexia-pdp.js clamp)`
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
        // Without the per-badge cap a 200% row would swallow the picture.
        name: "m1-drops-image-share-cap",
        find: "    var maxOne = Math.min(box.width * CX_IB_MAX_IMAGE_SHARE, maxRow / badges.length);",
        replace: "    var maxOne = maxRow / badges.length;",
      },
      {
        // Without the row cap, five badges would run to the image's edge.
        name: "m2-drops-row-cap",
        find: "    var maxRow = Math.min(room, box.width * CX_IB_MAX_ROW_SHARE);",
        replace: "    var maxRow = room;",
      },
      {
        // Measuring the SLIDER box instead of the image would overstate the
        // room by the slide padding on both sides.
        name: "m3-never-remembers-base",
        find: "    var stored = parseFloat(wrap.getAttribute('data-cx-ib-base') || '');\n    if (isFinite(stored) && stored > 0) return stored;",
        replace: "    var stored = NaN;\n    if (isFinite(stored) && stored > 0) return stored;",
      },
      {
        // A feature that can SHRINK the theme's badges is a regression.
        name: "m4-allows-shrinking",
        find: "    return px > base ? px : 0; // only ever bigger than the theme's own size",
        replace: "    return px > 0 ? px : 0; // only ever bigger than the theme's own size",
      },
      {
        name: "m5-ignores-breakpoint",
        find: "      var on = scale > 0 && ibPhone();",
        replace: "      var on = scale > 0;",
      },
      {
        name: "m6-draft-leaks-live",
        find: "  function ibAllowed(d) {",
        replace: "  function ibAllowed(d) {\n    if (d && typeof d.s === 'number') return true;",
      },
      {
        // Leaving the property behind when the feature goes off would keep
        // the size after a disarm or a rotation to desktop.
        name: "m7-never-clears",
        find: "  function ibClear(wrap) {\n    wrap.classList.remove('cx-ib-on');\n    wrap.style.removeProperty('--cx-ib-w');\n  }",
        replace: "  function ibClear(wrap) {\n    return wrap;\n  }",
      },
    ],
  });
  if (bad > 0) {
    console.log(`\n${bad} MUTANT(S) NOT CAUGHT (image-badges)`);
    process.exitCode = 1;
  } else {
    console.log("ALL 7 MUTANTS CAUGHT (image-badges)");
  }
}
