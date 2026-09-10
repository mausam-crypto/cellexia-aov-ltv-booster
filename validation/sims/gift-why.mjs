#!/usr/bin/env node
/**
 * validation/sims/gift-why.mjs — v18 "why did no gift land" diagnostic.
 *
 * vm-extracts the REAL rwGiftWhy out of the shipped cart engine
 * (extensions/cellexia-booster/assets/cellexia-cart.js) by name — never a
 * re-implementation — and drives it through every branch with stubbed
 * collaborators.
 *
 * Why this suite exists: before v18 every stand-down in rwSyncGifts was
 * SILENT, so the preview simulator quietly cancelling the "Test with my real
 * cart" rehearsal was indistinguishable from a broken feature. The merchant
 * reported it as "gifts never get added in preview". The diagnostic is only
 * worth anything if its ORDER is right, so the order is pinned here:
 *
 *   CODES     the closed set of reason codes the shipped function can return
 *             (a new branch without a test fails this suite).
 *   BRANCHES  every code is reachable and returns a non-empty sentence.
 *   ORDER     the four orderings that carry the debugging narrative:
 *               no_tier  BEFORE sim           (distance first: raising the
 *                                              simulator past the threshold is
 *                                              what reveals the sim message)
 *               sim      BEFORE no_rehearsal  (the simulator is the nearer
 *                                              cause when both are set)
 *               b2b      BEFORE loading       (a wholesale cart earns nothing
 *                                              however the fetch resolves)
 *               unfree   BEFORE declined      (the session churn guard is the
 *                                              real reason, not the removal)
 *   COPY      no em dashes anywhere in the merchant-facing sentences
 *             (standing merchant rule), and the no_tier sentence carries the
 *             money gap so the number is actionable.
 *
 * Offline, deterministic (pure decision tree over injected stubs, no clock,
 * no DOM, no network), node-only.
 */
import { readSource, extractFunction, compileEngine } from '../lib/extract.mjs';
import { makeChecker } from '../lib/util.mjs';

const { ok, finish } = makeChecker('sims/gift-why: rwGiftWhy reason codes + order');

const CART = 'extensions/cellexia-booster/assets/cellexia-cart.js';
const src = readSource(CART);
const fnText = extractFunction(src, 'rwGiftWhy');

// ---------------------------------------------------------------- 1. CODES
// The closed set the shipped source can return. A new branch that is not
// listed here fails the suite rather than shipping untested.
const EXPECTED_CODES = [
  'adding',
  'b2b',
  'busy',
  'declined',
  'in_cart',
  'loading',
  'no_rehearsal',
  'no_tier',
  'off',
  'sim',
  'unavailable',
  'unfree',
];

const foundCodes = [...new Set(
  [...fnText.matchAll(/code:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]),
)].sort();

ok(
  JSON.stringify(foundCodes) === JSON.stringify(EXPECTED_CODES),
  `codes: shipped rwGiftWhy returns exactly ${EXPECTED_CODES.length} known reason codes ` +
    `(got ${JSON.stringify(foundCodes)})`,
);

// ------------------------------------------------------------- 2. harness
/** Everything rwGiftWhy reads, defaulted to "a cart that has earned a gift". */
function run(over) {
  const o = over || {};
  const plan = Object.assign(
    { reached: 0, wanted: [{ vid: '1', tier: 1, slot: 0 }], back: [], add: [], remove: [], reset: [], unfree: [] },
    o.plan || {},
  );
  const sandbox = {
    RW: 'RW' in o ? o.RW : {},
    PREVIEW: 'PREVIEW' in o ? o.PREVIEW : null,
    state: Object.assign({ busy: false }, o.state || {}),
    rwGift: Object.assign({ busy: false }, o.rwGift || {}),
    rwCode: Object.assign({ busy: false }, o.rwCode || {}),
    rwGt: () => ('gt' in o ? o.gt : {}),
    featureOn: () => ('featureOn' in o ? o.featureOn : true),
    isB2B: () => o.b2b === true,
    rwGiftsReady: () => o.ready !== false,
    rwGiftPlan: () => plan,
    rwMilestones: () => o.milestones || [],
    rwSpendCents: () => (typeof o.spend === 'number' ? o.spend : 0),
    rwSim: () => o.sim || null,
    rwGiftOff: () => o.giftOff === true,
    money: (c) => '€' + (Number(c) / 100).toFixed(2),
  };
  const ctx = compileEngine(fnText + '\nvar __out = rwGiftWhy();', sandbox);
  return ctx.__out;
}

// ------------------------------------------------------------ 3. BRANCHES
const cases = [
  ['off', { RW: null }, 'no rewards island at all'],
  ['off', { gt: null }, 'island present but no gift config'],
  ['off', { featureOn: false }, 'gift tiers off for this market'],
  ['b2b', { b2b: true }, 'wholesale cart'],
  ['loading', { ready: false }, 'gift product data still in flight'],
  ['no_tier', { plan: { reached: -1 } }, 'nothing earned yet'],
  ['sim', { plan: { reached: 0 }, PREVIEW: { rehearsal: true }, sim: { spend: 20000, count: 3 } }, 'simulator blocks the write'],
  ['no_rehearsal', { PREVIEW: { rehearsal: false } }, 'preview without the rehearsal tick'],
  ['unfree', { giftOff: true }, 'session churn guard after a not-free gift'],
  ['unfree', { plan: { unfree: [{ key: 'k' }] } }, 'a gift line is not free right now'],
  ['declined', { plan: { wanted: [], back: [{ vid: '1', tier: 1 }] } }, 'shopper removed it earlier'],
  ['unavailable', { plan: { wanted: [], back: [] } }, 'earned but nothing grantable'],
  ['busy', { state: { busy: true } }, 'mid-mutation'],
  ['in_cart', { plan: { add: [], remove: [], reset: [] } }, 'gift already present'],
  ['adding', { plan: { add: [{ vid: '1', tier: 1, slot: 0 }] } }, 'about to add'],
];

for (const [expected, over, label] of cases) {
  const out = run(over);
  ok(out && out.code === expected, `branch: ${label} -> ${expected} (got ${out && out.code})`);
  ok(
    out && typeof out.msg === 'string' && out.msg.trim().length > 10,
    `branch: ${expected} carries a real sentence`,
  );
}

// --------------------------------------------------------------- 4. ORDER
// The orderings that make the diagnostic a narrative instead of a lottery.
ok(
  run({ plan: { reached: -1 }, PREVIEW: { rehearsal: true }, sim: { spend: 100, count: 1 } }).code === 'no_tier',
  'order: below the threshold, the distance wins over the simulator notice',
);
ok(
  run({ plan: { reached: 0 }, PREVIEW: { rehearsal: false }, sim: { spend: 20000, count: 3 } }).code === 'sim',
  'order: simulator wins over the missing rehearsal tick',
);
ok(
  run({ b2b: true, ready: false }).code === 'b2b',
  'order: a wholesale cart is refused before the loading state',
);
ok(
  run({ giftOff: true, plan: { wanted: [], back: [{ vid: '1', tier: 1 }] } }).code === 'unfree',
  'order: the churn guard is reported ahead of the removal memory',
);
ok(
  run({ featureOn: false, b2b: true }).code === 'off',
  'order: a feature that is off short-circuits everything below it',
);

// ---------------------------------------------------------------- 5. COPY
const messages = cases.map(([, over]) => run(over).msg);
ok(
  messages.every((m) => !m.includes('—') && !m.includes('--')),
  'copy: no em dashes in any merchant-facing sentence (standing merchant rule)',
);
ok(
  run({ plan: { reached: -1 }, spend: 15000, milestones: [{ kind: 'gift', cents: 20000, i: 0, done: false }] })
    .msg.includes('€50.00'),
  'copy: the no_tier sentence names the money gap to the next reward',
);
ok(
  run({ PREVIEW: { rehearsal: false } }).msg.includes('Test with my real cart'),
  'copy: the no_rehearsal sentence names the exact Preview Center control to tick',
);
ok(
  run({ plan: { reached: 0 }, PREVIEW: { rehearsal: true }, sim: { spend: 20000, count: 3 } })
    .msg.includes('Real cart'),
  'copy: the sim sentence names the exact preview-bar button that clears it',
);

// The live-page escape hatch must stay wired, or "works in preview, not live"
// is unanswerable without a deploy.
ok(
  src.includes('window.CellexiaBooster.giftWhy = rwGiftWhy;'),
  'wiring: rwGiftWhy is exposed live as window.CellexiaBooster.giftWhy',
);
ok(
  src.includes("rwUpdateWhy(); // v18: keep the preview status line tracking the cart"),
  'wiring: renderAll refreshes the preview status line after every gift pass',
);

finish();
