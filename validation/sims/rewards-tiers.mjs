#!/usr/bin/env node
/**
 * validation/sims/rewards-tiers.mjs — v14 "Rewards" shared tier helpers
 * (SPEC-v14-rewards §6 / §12).
 *
 * vm-extracts the REAL cxRwTier / cxRwNext out of BOTH theme engines
 * (cellexia-cart.js + cellexia-pdp.js) by name — never a re-implementation —
 * and proves:
 *
 *   TWINS     the two helpers are byte-identical across the two assets
 *             (per-function AND the contiguous cxRwTier..cxRwNext slice, so
 *             the whitespace between them is pinned too), and each asset
 *             still carries its "shared tier helpers (TWIN of <sibling>)"
 *             region header (the extraction target can never move silently).
 *   TIERS     the settings-shape tiers [{count, pct, code}] through the
 *             extracted engines of BOTH bundles: the SPEC default ladder
 *             2/3/5/10 -> 5/10/20/30 for every count 0..12 (reached tier =
 *             highest count <= n, next tier = lowest count > n); unsorted
 *             tiers resolve identically to sorted ones (no order dependence);
 *             empty / null / undefined tiers -> null; malformed entries
 *             (null, missing count, count 0, negative, non-numeric, string
 *             counts) are skipped without throwing; a string count "3"
 *             coerces via Number(); duplicate counts pick a deterministic
 *             winner (first wins for reached, first wins for next).
 *   CART-ONLY the v12 per-file rule: the cart mutation/render helpers
 *             (rwSpendCents, rwEligibleLines, rwDistinctCount, rwUnits,
 *             rwGiftLines, rwDesiredCode, rwSyncCode, rwSyncGifts,
 *             rwRenderMeter, rwRenderNudge, rwDecorateGiftRows) are declared
 *             in cellexia-cart.js and appear NOWHERE in cellexia-pdp.js —
 *             the PDP never mutates the cart (SPEC §6: the KIT code is
 *             attached by the cart runtime, the Function is the referee).
 *
 * Offline, deterministic (pure functions, no clock, no DOM), node-only.
 */
import { readSource, extractFunction, compileEngine } from '../lib/extract.mjs';
import { makeChecker } from '../lib/util.mjs';

const { ok, finish } = makeChecker('sims/rewards-tiers: cxRwTier/cxRwNext twins + tier fixtures + cart-only helpers');

const CART = 'extensions/cellexia-booster/assets/cellexia-cart.js';
const PDP = 'extensions/cellexia-booster/assets/cellexia-pdp.js';
const cartSrc = readSource(CART);
const pdpSrc = readSource(PDP);

// ------------------------------------------------------------------ TWINS
const CART_HEADER = '// ---- v14 rewards: shared tier helpers (TWIN of cellexia-pdp.js)';
const PDP_HEADER = '// ---- v14 rewards: shared tier helpers (TWIN of cellexia-cart.js)';
ok(cartSrc.includes(CART_HEADER), `cart.js carries the twin region header (${CART_HEADER})`);
ok(pdpSrc.includes(PDP_HEADER), `pdp.js carries the twin region header (${PDP_HEADER})`);
ok(cartSrc.includes('  function cxRwTier(') && cartSrc.includes('  function cxRwNext('),
  'cart.js declares cxRwTier + cxRwNext at the 2-space IIFE indent');
ok(pdpSrc.includes('  function cxRwTier(') && pdpSrc.includes('  function cxRwNext('),
  'pdp.js declares cxRwTier + cxRwNext at the 2-space IIFE indent');

// The header must precede the helpers in each file (region membership).
ok(cartSrc.indexOf(CART_HEADER) < cartSrc.indexOf('  function cxRwTier('),
  'cart.js: cxRwTier sits after its twin-region header');
ok(pdpSrc.indexOf(PDP_HEADER) < pdpSrc.indexOf('  function cxRwTier('),
  'pdp.js: cxRwTier sits after its twin-region header');

const cartTier = extractFunction(cartSrc, 'cxRwTier');
const cartNext = extractFunction(cartSrc, 'cxRwNext');
const pdpTier = extractFunction(pdpSrc, 'cxRwTier');
const pdpNext = extractFunction(pdpSrc, 'cxRwNext');
ok(cartTier === pdpTier, 'TWIN: cxRwTier byte-identical in cart.js and pdp.js');
ok(cartNext === pdpNext, 'TWIN: cxRwNext byte-identical in cart.js and pdp.js');
ok(cartTier.length > 100 && cartNext.length > 100, 'TWIN: extracted helpers are non-trivial (anti-vacuity)');

/** Contiguous slice from `function cxRwTier(` to the end of cxRwNext. */
function twinSlice(src, nextText) {
  const start = src.indexOf('  function cxRwTier(');
  const nextIdx = src.indexOf(nextText, start);
  return src.slice(start, nextIdx + nextText.length);
}
const cartSlice = twinSlice(cartSrc, cartNext);
const pdpSlice = twinSlice(pdpSrc, pdpNext);
ok(cartSlice === pdpSlice, 'TWIN: the contiguous cxRwTier..cxRwNext slice is byte-identical (inter-function whitespace pinned)');
ok(cartSlice.startsWith('  function cxRwTier(') && cartSlice.endsWith('}'),
  'TWIN: slice bounds are the two helpers exactly');

// The helpers must read the settings tier shape (SPEC §1 {count, pct, code})
// — the PDP agent's contract deviation note: `.count`, never `.n`.
ok(cartTier.includes('.count') && !/\.n\b/.test(cartTier), 'cxRwTier reads tier.count (settings shape), never .n');
ok(cartNext.includes('.count') && !/\.n\b/.test(cartNext), 'cxRwNext reads tier.count (settings shape), never .n');
// ES5 discipline on the twins (deploy-safety pins the whole file; this
// keeps the twin itself honest even if extracted elsewhere).
ok(!/=>|`|\blet\b|\bconst\b/.test(cartSlice), 'twin slice is ES5 (no arrows/template literals/let/const)');

// ------------------------------------------------------------- ENGINES
const cartEngine = compileEngine(cartTier + '\n' + cartNext, {});
const pdpEngine = compileEngine(pdpTier + '\n' + pdpNext, {});
const ENGINES = [
  ['cart', cartEngine],
  ['pdp', pdpEngine],
];

const TIERS = [
  { count: 2, pct: 5, code: 'KIT2' },
  { count: 3, pct: 10, code: 'KIT3' },
  { count: 5, pct: 20, code: 'KIT5' },
  { count: 10, pct: 30, code: 'KIT10' },
];
// count -> [reached code | null, next code | null]
const EXPECTED = {
  0: [null, 'KIT2'],
  1: [null, 'KIT2'],
  2: ['KIT2', 'KIT3'],
  3: ['KIT3', 'KIT5'],
  4: ['KIT3', 'KIT5'],
  5: ['KIT5', 'KIT10'],
  6: ['KIT5', 'KIT10'],
  7: ['KIT5', 'KIT10'],
  8: ['KIT5', 'KIT10'],
  9: ['KIT5', 'KIT10'],
  10: ['KIT10', null],
  11: ['KIT10', null],
  12: ['KIT10', null],
};
const codeOf = (t) => (t ? t.code : null);

for (const [name, eng] of ENGINES) {
  // The default ladder, counts 0..12.
  for (let n = 0; n <= 12; n++) {
    const [tier, next] = EXPECTED[n];
    ok(codeOf(eng.cxRwTier(TIERS, n)) === tier,
      `${name}: cxRwTier(default ladder, ${n}) = ${tier}`);
    ok(codeOf(eng.cxRwNext(TIERS, n)) === next,
      `${name}: cxRwNext(default ladder, ${n}) = ${next}`);
  }
  // Reached tier returns the tier OBJECT itself (pct/code ride along).
  const t3 = eng.cxRwTier(TIERS, 4);
  ok(t3 === TIERS[1] && t3.pct === 10, `${name}: cxRwTier returns the tier object (pct 10 at count 4)`);
  const n3 = eng.cxRwNext(TIERS, 3);
  ok(n3 === TIERS[2] && n3.pct === 20, `${name}: cxRwNext returns the tier object (pct 20 next after 3)`);

  // Unsorted tiers resolve identically (no order dependence).
  const unsorted = [TIERS[2], TIERS[0], TIERS[3], TIERS[1]];
  let same = true;
  for (let n = 0; n <= 12; n++) {
    if (codeOf(eng.cxRwTier(unsorted, n)) !== codeOf(eng.cxRwTier(TIERS, n))) same = false;
    if (codeOf(eng.cxRwNext(unsorted, n)) !== codeOf(eng.cxRwNext(TIERS, n))) same = false;
  }
  ok(same, `${name}: unsorted tiers resolve identically to sorted (0..12)`);

  // Empty / absent tiers -> null, never throws.
  ok(eng.cxRwTier([], 5) === null && eng.cxRwNext([], 5) === null, `${name}: empty tiers -> null/null`);
  ok(eng.cxRwTier(null, 5) === null && eng.cxRwNext(null, 5) === null, `${name}: null tiers -> null/null`);
  ok(eng.cxRwTier(undefined, 5) === null && eng.cxRwNext(undefined, 5) === null, `${name}: undefined tiers -> null/null`);

  // Malformed entries are skipped, never thrown on.
  const malformed = [
    null,
    undefined,
    {},
    { count: 0, pct: 99, code: 'ZERO' },
    { count: -3, pct: 99, code: 'NEG' },
    { count: 'abc', pct: 99, code: 'NAN' },
    { pct: 99, code: 'NOCOUNT' },
    { count: '3', pct: 10, code: 'STR3' },
    { count: 5, pct: 20, code: 'KIT5' },
  ];
  let threw = false;
  let reached4 = null;
  let next4 = null;
  let reached0 = null;
  let next0 = null;
  try {
    reached4 = eng.cxRwTier(malformed, 4);
    next4 = eng.cxRwNext(malformed, 4);
    reached0 = eng.cxRwTier(malformed, 0);
    next0 = eng.cxRwNext(malformed, 0);
  } catch (e) {
    threw = true;
  }
  ok(!threw, `${name}: malformed entries never throw`);
  ok(codeOf(reached4) === 'STR3', `${name}: string count "3" coerces (Number) — reached at 4 is STR3, junk skipped`);
  ok(codeOf(next4) === 'KIT5', `${name}: next after 4 among malformed entries is KIT5`);
  ok(reached0 === null, `${name}: count 0 / negative / NaN entries never count as reached (0 -> null)`);
  ok(codeOf(next0) === 'STR3', `${name}: next after 0 skips count-0/negative/NaN entries (STR3)`);

  // Non-numeric count argument: nothing is <= NaN or > NaN -> null.
  ok(eng.cxRwTier(TIERS, NaN) === null && eng.cxRwNext(TIERS, NaN) === null, `${name}: NaN count -> null/null`);
  // Duplicate counts: first-wins deterministically (strict > / < comparisons).
  const dup = [
    { count: 3, pct: 10, code: 'A' },
    { count: 3, pct: 12, code: 'B' },
  ];
  ok(codeOf(eng.cxRwTier(dup, 3)) === 'A' && codeOf(eng.cxRwNext(dup, 2)) === 'A',
    `${name}: duplicate counts resolve first-wins for both reached and next`);
  // Boundary: exactly at a tier count is reached, one below is not.
  ok(codeOf(eng.cxRwTier(TIERS, 10)) === 'KIT10' && codeOf(eng.cxRwTier(TIERS, 9.99)) === 'KIT5',
    `${name}: boundary — 10 reaches KIT10, 9.99 stays at KIT5`);
  // Single-tier ladder.
  const one = [{ count: 2, pct: 5, code: 'ONLY' }];
  ok(codeOf(eng.cxRwTier(one, 1)) === null && codeOf(eng.cxRwNext(one, 1)) === 'ONLY' &&
     codeOf(eng.cxRwTier(one, 2)) === 'ONLY' && codeOf(eng.cxRwNext(one, 2)) === null,
    `${name}: single-tier ladder — below/next then reached/none`);
}

// Cross-engine parity on a randomized-but-fixed sweep (deterministic LCG).
{
  let seed = 20260816;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let parity = true;
  for (let i = 0; i < 200; i++) {
    const tiers = [];
    const k = 1 + Math.floor(rnd() * 6);
    for (let j = 0; j < k; j++) tiers.push({ count: 2 + Math.floor(rnd() * 12), pct: 5, code: 'C' + j });
    const n = Math.floor(rnd() * 15);
    if (codeOf(cartEngine.cxRwTier(tiers, n)) !== codeOf(pdpEngine.cxRwTier(tiers, n))) parity = false;
    if (codeOf(cartEngine.cxRwNext(tiers, n)) !== codeOf(pdpEngine.cxRwNext(tiers, n))) parity = false;
  }
  ok(parity, 'cart and pdp engines agree on 200 seeded random ladders (reached + next)');
}

// ------------------------------------------------------------ CART-ONLY
// The v12 per-file rule (cartExcludedAny precedent): cart mutation/render
// helpers are declared in cellexia-cart.js and never leak into the PDP
// bundle. Declared = the 2-space `  function <name>(` anchor.
const CART_ONLY = [
  'rwSpendCents',
  'rwEligibleLines',
  'rwDistinctCount',
  'rwUnits',
  'rwGiftLines',
  'rwDesiredCode',
  'rwSyncCode',
  'rwSyncGifts',
  'rwRenderMeter',
  'rwRenderNudge',
  'rwDecorateGiftRows',
];
for (const name of CART_ONLY) {
  ok(cartSrc.includes(`  function ${name}(`), `cart-only: ${name} declared in cellexia-cart.js`);
  ok(!pdpSrc.includes(name), `cart-only: ${name} absent from cellexia-pdp.js`);
}
// And the PDP-only helpers stay PDP-only (the mirror image).
for (const name of ['azRwSkip', 'azRwFbtApply', 'azBuildRwPdp', 'azMountRwPdp']) {
  ok(pdpSrc.includes(`  function ${name}(`), `pdp-only: ${name} declared in cellexia-pdp.js`);
  ok(!cartSrc.includes(name), `pdp-only: ${name} absent from cellexia-cart.js`);
}
// Each asset carries the inline English RW_DEFAULTS table (el/ar locale
// fallback, SPEC §7) — the pdp keeps its 5 PDP keys, the cart its 21.
ok(pdpSrc.includes('  var RW_DEFAULTS = {') && cartSrc.includes('  var RW_DEFAULTS = {'),
  'both assets carry an inline RW_DEFAULTS English fallback table');

finish();
