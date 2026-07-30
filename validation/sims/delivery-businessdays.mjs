#!/usr/bin/env node
/**
 * validation/sims/delivery-businessdays.mjs — delivery estimator business-day
 * engine sim.
 *
 * vm-extracts the REAL shipped functions from BOTH theme engines
 * (cellexia-pdp.js + cellexia-cart.js) and drives them with injected fixed
 * clocks and REAL Intl:
 *
 *   deliveryConfig     fail-closed resolver matrix: int ranges, max >= min
 *                      AFTER the byCountry partial-override merge, hidden
 *                      gate, schedule + required-strings validation
 *   deliveryQualifies  weekday gate, four GLOBAL exclusions (Dec 24/25/31 +
 *                      Jan 1 — always, even holidaysEnabled:false), per-
 *                      country fixed-date holidays only when enabled,
 *                      unknown countries get globals only
 *   deliveryAdvance    n=0 dispatch-day-qualifies rule, transit counting,
 *                      60-calendar-day scan cap -> null
 *   deliveryCompute    integration incl. REAL-Intl DST probes: Paris
 *                      spring-forward (2026-03-29) + fall-back (2026-10-25),
 *                      New York spring-forward (2026-03-08) + fall-back
 *                      (2026-11-01), each crossing the transition weekend
 *
 * 4-WAY HOLIDAY-TABLE PARITY: the canonical table in
 * app/services/delivery-holidays.server.ts is parsed and deep-compared
 * (values AND key order) against the two ES5 mirrors (cellexia-pdp.js,
 * cellexia-cart.js) and the checkout TS copy
 * (extensions/checkout-delivery/src/delivery-engine.ts); same for the
 * GLOBAL_DELIVERY_EXCLUSIONS lists. Any drift in any copy fails the suite.
 *
 * MUTATION TESTS (in-memory COPY of the pdp bundle; all must be caught):
 *   D1 dispatch-day-as-transit   delete `if (i === 0 && n > 0) continue;`
 *                                (caught: n=1 from a qualifying Friday must
 *                                land Monday, not Friday)
 *   D2 global exclusions dropped delete the DELIVERY_GLOBAL_EXCLUSIONS gate
 *                                (caught: Dec 25 must never qualify)
 *   D3 scan cap 60 -> 600        (caught: Mondays-only n=30 must be null)
 *   D4 holiday gate inverted     `if (dc.holidaysEnabled)` -> `if (!...)`
 *                                (caught: FR May 1 must flip with the flag)
 *   D5 MM padding dropped        `(m < 10 ? '0' + m : '' + m)` -> `('' + m)`
 *                                (caught: FR May 1 = '05-01' stops matching)
 *
 * Offline, deterministic (injected clocks only), node-only.
 */
import {
  readSource,
  extractFunction,
  extractVar,
  extractTsConstValue,
  fixedDateClass,
  compileEngine,
  makeTap,
} from '../lib/extract.mjs';

const PDP = 'extensions/cellexia-booster/assets/cellexia-pdp.js';
const CART = 'extensions/cellexia-booster/assets/cellexia-cart.js';
const SERVER_TS = 'app/services/delivery-holidays.server.ts';
const CHECKOUT_TS = 'extensions/checkout-delivery/src/delivery-engine.ts';

const FUNCS = [
  'deliveryConfig',
  'deliveryDispatchUt',
  'deliveryQualifies',
  'deliveryAdvance',
  'deliveryCompute',
];

const tap = makeTap('delivery-businessdays');
const srcs = { pdp: readSource(PDP), cart: readSource(CART) };

function buildBundle(src) {
  const parts = [
    extractVar(src, 'DISPATCH_ISO'),
    extractVar(src, 'DELIVERY_GLOBAL_EXCLUSIONS'),
    extractVar(src, 'DELIVERY_HOLIDAYS'),
  ];
  for (const f of FUNCS) parts.push(extractFunction(src, f));
  return parts.join('\n');
}

const bundles = { pdp: buildBundle(srcs.pdp), cart: buildBundle(srcs.cart) };

// ------------------------------------------------ twin byte-identity
for (const f of FUNCS) {
  tap.check(
    'twin byte-identical: ' + f,
    extractFunction(srcs.pdp, f) === extractFunction(srcs.cart, f),
  );
}

// ------------------------------------------- 4-way holiday-table parity
function es5Value(src, name) {
  const stmt = extractVar(src, name); // "var NAME = <literal>;"
  const literal = stmt.slice(stmt.indexOf('=') + 1).replace(/;\s*$/, '');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + literal + ');')();
}

const tables = {
  'server-ts': extractTsConstValue(readSource(SERVER_TS), 'DELIVERY_HOLIDAYS'),
  'pdp-es5': es5Value(srcs.pdp, 'DELIVERY_HOLIDAYS'),
  'cart-es5': es5Value(srcs.cart, 'DELIVERY_HOLIDAYS'),
  'checkout-ts': extractTsConstValue(readSource(CHECKOUT_TS), 'DELIVERY_HOLIDAYS'),
};
const exclusions = {
  'server-ts': extractTsConstValue(readSource(SERVER_TS), 'GLOBAL_DELIVERY_EXCLUSIONS'),
  'pdp-es5': es5Value(srcs.pdp, 'DELIVERY_GLOBAL_EXCLUSIONS'),
  'cart-es5': es5Value(srcs.cart, 'DELIVERY_GLOBAL_EXCLUSIONS'),
  'checkout-ts': extractTsConstValue(readSource(CHECKOUT_TS), 'GLOBAL_DELIVERY_EXCLUSIONS'),
};

const canonicalTable = JSON.stringify(tables['server-ts']);
const canonicalExcl = JSON.stringify(exclusions['server-ts']);
tap.check('canonical holiday table has 25 countries',
  Object.keys(tables['server-ts']).length === 25);
tap.eq('canonical global exclusions', canonicalExcl, '["12-24","12-25","12-31","01-01"]');
for (const copy of ['pdp-es5', 'cart-es5', 'checkout-ts']) {
  tap.check('holiday-table parity: server-ts == ' + copy,
    JSON.stringify(tables[copy]) === canonicalTable);
  tap.check('global-exclusions parity: server-ts == ' + copy,
    JSON.stringify(exclusions[copy]) === canonicalExcl);
}

// ------------------------------------------------------------ machinery
const DELIVERY_STRINGS = {
  'delivery.line': 'line @@DATE@@',
  'delivery.range': 'range @@FROM@@ @@TO@@',
  'delivery.range_same': 'same @@DATE@@',
  'delivery.timeline_ship': 'ship @@DATE@@',
  'delivery.timeline_delivered': 'done @@DATE@@',
  'delivery.box_title': 'title @@DATE@@',
  'delivery.tooltip': 'tip @@DATE@@',
};

function baseDelivery(overrides) {
  return Object.assign(
    {
      minDays: 2,
      maxDays: 5,
      deliveryDays: [1, 2, 3, 4, 5],
      holidaysEnabled: true,
      country: 'fr',
      pageLocale: 'fr',
      schedule: { cutoff: '14:00', timezone: 'Europe/Paris', days: [1, 2, 3, 4, 5] },
    },
    overrides || {},
  );
}

function makeFactory(codeByFile) {
  return function engine(file, delivery, nowMs) {
    const cfg = { delivery, deliveryStrings: Object.assign({}, DELIVERY_STRINGS) };
    if (delivery && delivery.__noStrings) {
      delete delivery.__noStrings;
      delete cfg.deliveryStrings;
    }
    if (delivery && delivery.__dropString) {
      delete cfg.deliveryStrings[delivery.__dropString];
      delete delivery.__dropString;
    }
    return compileEngine(codeByFile[file], {
      cfg,
      Date: fixedDateClass(nowMs === undefined ? 0 : nowMs),
    });
  };
}

const UT = Date.UTC;

function dcFor(over) {
  // A resolved config object shaped like deliveryConfig()'s return value,
  // for driving deliveryQualifies/deliveryAdvance directly.
  return Object.assign(
    {
      minDays: 2, maxDays: 5, deliveryDays: [1, 2, 3, 4, 5], holidaysEnabled: true,
      country: 'FR', pageLocale: 'fr', cutoffMinutes: 840,
      timezone: 'Europe/Paris', dispatchDays: [1, 2, 3, 4, 5],
    },
    over || {},
  );
}

function runMatrix(t, engine, files) {
  for (const file of files) {
    const tag = ' [' + file + ']';
    const now = UT(2026, 6, 15, 8, 0, 0); // Wed 10:00 Paris — inert default

    // --------------------------------------- deliveryConfig fail-closed
    const cfgCases = [
      ['valid base', {}, true],
      ['delivery missing', null, false],
      ['minDays -1', { minDays: -1 }, false],
      ['minDays 31', { minDays: 31 }, false],
      ['minDays 1.5', { minDays: 1.5 }, false],
      ['minDays 0 valid', { minDays: 0 }, true],
      ['maxDays 0', { maxDays: 0 }, false],
      ['maxDays 31', { maxDays: 31 }, false],
      ['max < min', { minDays: 5, maxDays: 2 }, false],
      ['deliveryDays empty', { deliveryDays: [] }, false],
      ['deliveryDays [0]', { deliveryDays: [0] }, false],
      ['deliveryDays [8]', { deliveryDays: [8] }, false],
      ['deliveryDays [1.5]', { deliveryDays: [1.5] }, false],
      ['holidaysEnabled string', { holidaysEnabled: 'true' }, false],
      ['holidaysEnabled missing', { holidaysEnabled: undefined }, false],
      ['schedule missing', { schedule: undefined }, false],
      ['schedule cutoff 25:00', { schedule: { cutoff: '25:00', timezone: 'Europe/Paris', days: [1] } }, false],
      ['schedule timezone empty', { schedule: { cutoff: '14:00', timezone: '', days: [1] } }, false],
      ['schedule days empty', { schedule: { cutoff: '14:00', timezone: 'Europe/Paris', days: [] } }, false],
      ['override hidden -> null', { override: { hidden: true } }, false],
      ['override maxDays below min -> null', { override: { maxDays: 1 } }, false],
      ['override partial applies', { override: { minDays: 0 } }, true],
      ['strings map missing', { __noStrings: true }, false],
      ['one required string missing', { __dropString: 'delivery.tooltip' }, false],
    ];
    for (const [label, over, ok] of cfgCases) {
      const delivery = over === null ? undefined : baseDelivery(over);
      const ctx = engine(file, delivery, now);
      const dc = ctx.deliveryConfig();
      t.check('config: ' + label + tag, (dc !== null) === ok, JSON.stringify(dc));
    }
    {
      const ctx = engine(file, baseDelivery({
        override: { minDays: 1, maxDays: 3, deliveryDays: [2, 4], holidaysEnabled: false },
      }), now);
      const dc = ctx.deliveryConfig();
      t.check('config: override merge wins on all four fields' + tag,
        dc !== null && dc.minDays === 1 && dc.maxDays === 3 &&
        JSON.stringify(dc.deliveryDays) === '[2,4]' && dc.holidaysEnabled === false);
      t.eq('config: country uppercased' + tag, dc && dc.country, 'FR');
      t.eq('config: cutoffMinutes 840' + tag, dc && dc.cutoffMinutes, 840);
    }

    // -------------------------------------------------- deliveryQualifies
    const ctxQ = engine(file, baseDelivery(), now);
    const qualifyCases = [
      // [label, ut, dcOver, expected]
      ['FR May 1 (Fri) holiday, enabled -> false', UT(2026, 4, 1), { country: 'FR' }, false],
      ['FR May 1, holidays disabled -> true', UT(2026, 4, 1), { country: 'FR', holidaysEnabled: false }, true],
      ['Dec 25 (Fri) GLOBAL even with holidays disabled', UT(2026, 11, 25), { country: 'XX', holidaysEnabled: false }, false],
      ['Dec 24 (Thu) GLOBAL', UT(2026, 11, 24), { country: 'XX', holidaysEnabled: false }, false],
      ['Dec 31 (Thu) GLOBAL', UT(2026, 11, 31), { country: 'XX', holidaysEnabled: false }, false],
      ['Jan 1 2027 (Fri) GLOBAL', UT(2027, 0, 1), { country: 'XX', holidaysEnabled: false }, false],
      ['US Jul 4 (Sat) holiday when Sat delivers', UT(2026, 6, 4), { country: 'US', deliveryDays: [1, 2, 3, 4, 5, 6] }, false],
      ['US Jul 4 with holidays disabled', UT(2026, 6, 4), { country: 'US', deliveryDays: [1, 2, 3, 4, 5, 6], holidaysEnabled: false }, true],
      ['unknown country only global rules', UT(2026, 4, 1), { country: 'ZZ' }, true],
      ['Saturday not a delivery weekday', UT(2026, 6, 4), { country: 'XX' }, false],
      ['Sunday not a delivery weekday', UT(2026, 6, 5), { country: 'XX' }, false],
      ['plain Wednesday qualifies', UT(2026, 6, 15), { country: 'FR' }, true],
      ['GB Dec 26 2026 is Saturday: weekday gate already blocks', UT(2026, 11, 26), { country: 'GB' }, false],
      ['GB Dec 28 2026 Monday qualifies (Boxing Day fixed-date only)', UT(2026, 11, 28), { country: 'GB' }, true],
    ];
    for (const [label, ut, over, expected] of qualifyCases) {
      t.eq('qualify: ' + label + tag, ctxQ.deliveryQualifies(ut, dcFor(over)), expected);
    }

    // ---------------------------------------------------- deliveryAdvance
    const advanceCases = [
      // [label, startUt, n, dcOver, expected]
      ['n=0 qualifying Friday -> same day', UT(2026, 6, 3), 0, { country: 'US' }, UT(2026, 6, 3)],
      ['n=0 Saturday start -> next Monday', UT(2026, 6, 4), 0, { country: 'US' }, UT(2026, 6, 6)],
      ['n=1 from Fri Jul 3 -> Mon Jul 6 (US)', UT(2026, 6, 3), 1, { country: 'US' }, UT(2026, 6, 6)],
      ['n=3 from Fri Jul 3 -> Wed Jul 8 (US)', UT(2026, 6, 3), 3, { country: 'US' }, UT(2026, 6, 8)],
      ['Christmas window: n=1 from Wed Dec 23 -> Mon Dec 28 (GB)', UT(2026, 11, 23), 1, { country: 'GB' }, UT(2026, 11, 28)],
      ['Christmas window: n=2 -> Tue Dec 29 (GB)', UT(2026, 11, 23), 2, { country: 'GB' }, UT(2026, 11, 29)],
      ['New-year window: n=4 skips Dec 31 + Jan 1 -> Mon Jan 4 (GB)', UT(2026, 11, 23), 4, { country: 'GB' }, UT(2027, 0, 4)],
      ['Mondays-only n=8 lands day 56', UT(2026, 6, 6), 8, { country: 'ZZ', deliveryDays: [1], holidaysEnabled: false }, UT(2026, 7, 31)],
      ['Mondays-only n=30 exceeds 60-day cap -> null', UT(2026, 6, 6), 30, { country: 'ZZ', deliveryDays: [1], holidaysEnabled: false }, null],
    ];
    for (const [label, startUt, n, over, expected] of advanceCases) {
      t.eq('advance: ' + label + tag, ctxQ.deliveryAdvance(startUt, n, dcFor(over)), expected);
    }

    // ------------------------- deliveryCompute + REAL-Intl DST probes
    const computeCases = [
      // [label, nowUtcMs, dcOver, expected {dispatch,min,max}]
      ['Paris spring-forward weekend crossed (Fri 11:00 local, FR)',
        UT(2026, 2, 27, 10, 0, 0), { minDays: 1, maxDays: 3 },
        { dispatch: UT(2026, 2, 27), min: UT(2026, 2, 30), max: UT(2026, 3, 1) }],
      ['Paris spring-forward, after cutoff Friday -> Monday dispatch',
        UT(2026, 2, 27, 14, 0, 0), { minDays: 1, maxDays: 3 },
        { dispatch: UT(2026, 2, 30), min: UT(2026, 2, 31), max: UT(2026, 3, 2) }],
      ['Paris fall-back weekend crossed (Fri 12:00 CEST, Oct 23)',
        UT(2026, 9, 23, 10, 0, 0), { minDays: 1, maxDays: 3 },
        { dispatch: UT(2026, 9, 23), min: UT(2026, 9, 26), max: UT(2026, 9, 28) }],
      ['New York fall-back weekend crossed (Fri 11:00 EDT, US)',
        UT(2026, 9, 30, 15, 0, 0),
        { minDays: 1, maxDays: 3, country: 'US', timezone: 'America/New_York' },
        { dispatch: UT(2026, 9, 30), min: UT(2026, 10, 2), max: UT(2026, 10, 4) }],
      ['New York spring-forward weekend crossed (Fri 10:00 EST, US)',
        UT(2026, 2, 6, 15, 0, 0),
        { minDays: 1, maxDays: 3, country: 'US', timezone: 'America/New_York' },
        { dispatch: UT(2026, 2, 6), min: UT(2026, 2, 9), max: UT(2026, 2, 11) }],
      ['minDays 0: dispatch day itself is the earliest delivery',
        UT(2026, 6, 15, 8, 0, 0), { minDays: 0, maxDays: 2 },
        { dispatch: UT(2026, 6, 15), min: UT(2026, 6, 15), max: UT(2026, 6, 17) }],
      ['min == max collapses to one date',
        UT(2026, 6, 15, 8, 0, 0), { minDays: 2, maxDays: 2 },
        { dispatch: UT(2026, 6, 15), min: UT(2026, 6, 17), max: UT(2026, 6, 17) }],
      ['Mondays-only maxDays 30 hits the 60-day cap -> null',
        UT(2026, 6, 15, 8, 0, 0), { minDays: 1, maxDays: 30, deliveryDays: [1] },
        null],
      ['invalid warehouse timezone -> null',
        UT(2026, 6, 15, 8, 0, 0), { timezone: 'Mars/Olympus' },
        null],
    ];
    for (const [label, nowMs, over, expected] of computeCases) {
      const ctx = engine(file, baseDelivery(), nowMs);
      const got = ctx.deliveryCompute(dcFor(over));
      t.eq('compute: ' + label + tag, got, expected);
      if (got) {
        t.check('compute: stamps are UTC midnights ' + label + tag,
          got.dispatch % 86400000 === 0 && got.min % 86400000 === 0 && got.max % 86400000 === 0);
        t.check('compute: min <= max ' + label + tag, got.min <= got.max);
      }
    }
  }
}

// ------------------------------------------------------------- main run
runMatrix(tap, makeFactory(bundles), ['pdp', 'cart']);

// -------------------------------------------------------- mutation tests
const MUTANTS = [
  {
    name: 'D1 dispatch day counted as transit',
    find: 'if (i === 0 && n > 0) continue; // dispatch day is day zero, not transit',
    replace: ';',
  },
  {
    name: 'D2 global exclusions dropped',
    find: "if (DELIVERY_GLOBAL_EXCLUSIONS.indexOf(mmdd) !== -1) return false; // Dec 24/25/31 + Jan 1",
    replace: ';',
  },
  {
    name: 'D3 scan cap 60 -> 600',
    find: 'for (var i = 0; i <= 60; i++) {',
    replace: 'for (var i = 0; i <= 600; i++) {',
  },
  {
    name: 'D4 holiday gate inverted',
    find: 'if (dc.holidaysEnabled) {',
    replace: 'if (!dc.holidaysEnabled) {',
  },
  {
    name: 'D5 month zero-padding dropped',
    find: "var mmdd = (m < 10 ? '0' + m : '' + m) + '-' + (dd < 10 ? '0' + dd : '' + dd);",
    replace: "var mmdd = ('' + m) + '-' + (dd < 10 ? '0' + dd : '' + dd);",
  },
];

for (const mutant of MUTANTS) {
  const occurrences = bundles.pdp.split(mutant.find).length - 1;
  tap.check('mutant anchor present: ' + mutant.name, occurrences >= 1,
    'find-string not in extracted bundle: ' + mutant.find);
  if (occurrences < 1) continue;
  const mutated = bundles.pdp.split(mutant.find).join(mutant.replace);
  const silent = makeTap('mutant:' + mutant.name);
  silent.beginSilent();
  runMatrix(silent, makeFactory({ pdp: mutated }), ['pdp']);
  tap.check('mutant CAUGHT: ' + mutant.name, silent.failed > 0,
    'mutant survived ' + silent.run + ' checks');
}

tap.finish();
