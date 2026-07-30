#!/usr/bin/env node
/**
 * validation/sims/dispatch-tz.mjs — dispatch countdown timezone engine sim.
 *
 * vm-extracts the REAL shipped functions (never re-implementations) from
 * BOTH theme engines — extensions/cellexia-booster/assets/cellexia-pdp.js
 * and cellexia-cart.js — and drives them with an injected fixed clock and
 * REAL Intl:
 *
 *   dispatchSchedule      fail-closed validation matrix (cutoff format,
 *                         timezone, days, showWithinHours 1..24, strings)
 *   dispatchRemainingMs   working-day / cutoff / credibility-window matrix,
 *                         second-precision countdown, midnight h24-quirk
 *                         path, invalid-timezone fail-closed
 *   dispatchHiddenReason  closed_day / cutoff_passed / too_early verdicts
 *                         consistent with dispatchRemainingMs on every case
 *   deliveryDispatchUt    DST-safe day-0 (Intl consulted once) + pure
 *                         UTC-midnight calendar-stamp scan across real DST
 *                         transitions (Paris + New York, spring + fall),
 *                         cutoff-exact boundary, 14-day scan cap
 *
 * TWIN GUARANTEE: dispatchRemainingMs / dispatchHiddenReason /
 * deliveryDispatchUt / DISPATCH_ISO are asserted byte-identical between the
 * two theme files (dispatchSchedule legitimately differs: pdp reads
 * cfg.strings, cart reads the STRINGS module global) and the whole behavior
 * matrix runs against BOTH extractions.
 *
 * MUTATION TESTS (applied to an in-memory COPY of the pdp bundle — files on
 * disk are never touched; every mutant must be CAUGHT by the matrix):
 *   M1 cutoff boundary   `nowMinutes >= schedule.cutoffMinutes` -> `>`
 *                        (caught: at-cutoff-exactly must hide)
 *   M2 window unit       `withinMinutes: within * 60` -> `within`
 *                        (caught: in-window instants must be visible)
 *   M3 working-day gate  days.indexOf(iso) `=== -1` -> `=== -2`
 *                        (caught: Sunday must be closed_day, not visible)
 *   M4 second precision  drop `- seconds * 1000` from the countdown
 *                        (caught: 13:59:30 must return 30 000 ms)
 *   M5 day-0 cutoff      deliveryDispatchUt `nowMinutes >= dc.cutoffMinutes`
 *                        -> `>` (caught: at cutoff the dispatch day must
 *                        already be the NEXT dispatch day)
 *   M6 ISO conversion    `((new Date(ut).getUTCDay() + 6) % 7) + 1` ->
 *                        `new Date(ut).getUTCDay() + 1` (caught: Friday
 *                        before cutoff must dispatch same-day)
 *
 * NOTE on the h24 quirk: the engine normalizes `Number(map.hour) % 24`
 * because some ICU builds report midnight as "24:xx" under hour12:false.
 * This machine's ICU reports "00" (probed and printed below), so the
 * midnight test proves the normalized path is correct under either ICU
 * behavior, but a mutant deleting `% 24` is not reliably catchable here and
 * is deliberately NOT part of the mutant set.
 *
 * Offline, deterministic (injected clocks only), node-only.
 */
import {
  readSource,
  extractFunction,
  extractVar,
  fixedDateClass,
  compileEngine,
  makeTap,
} from '../lib/extract.mjs';

const PDP = 'extensions/cellexia-booster/assets/cellexia-pdp.js';
const CART = 'extensions/cellexia-booster/assets/cellexia-cart.js';

const FUNCS = [
  'dispatchSchedule',
  'dispatchRemainingMs',
  'dispatchHiddenReason',
  'deliveryDispatchUt',
];
const TWIN_FUNCS = ['dispatchRemainingMs', 'dispatchHiddenReason', 'deliveryDispatchUt'];

const tap = makeTap('dispatch-tz');

const srcs = { pdp: readSource(PDP), cart: readSource(CART) };

function buildBundle(src) {
  const parts = [extractVar(src, 'DISPATCH_ISO')];
  for (const f of FUNCS) parts.push(extractFunction(src, f));
  return parts.join('\n');
}

const bundles = { pdp: buildBundle(srcs.pdp), cart: buildBundle(srcs.cart) };

// ---------------------------------------------------------------- twins
for (const f of TWIN_FUNCS) {
  tap.check(
    'twin byte-identical: ' + f,
    extractFunction(srcs.pdp, f) === extractFunction(srcs.cart, f),
  );
}
tap.check(
  'twin byte-identical: DISPATCH_ISO',
  extractVar(srcs.pdp, 'DISPATCH_ISO') === extractVar(srcs.cart, 'DISPATCH_ISO'),
);

// ------------------------------------------------------------ machinery
const BASE_STRINGS = {
  'dispatch.within': 'Order within @@HOURS@@h @@MINUTES@@m',
  'dispatch.within_minutes': 'Order within @@MINUTES@@ minutes',
};

function baseCfg(dispatchOverrides, stringsOverride) {
  return {
    strings: stringsOverride === undefined ? Object.assign({}, BASE_STRINGS) : stringsOverride,
    dispatch: Object.assign(
      { cutoff: '14:00', timezone: 'Europe/Paris', days: [1, 2, 3, 4, 5], showWithinHours: 4 },
      dispatchOverrides || {},
    ),
  };
}

function makeFactory(codeByFile) {
  return function engine(file, cfg, nowMs) {
    return compileEngine(codeByFile[file], {
      cfg,
      STRINGS: cfg && cfg.strings ? cfg.strings : {},
      Date: fixedDateClass(nowMs === undefined ? 0 : nowMs),
    });
  };
}

const UT = Date.UTC;

/** The full behavior matrix; run against real bundles AND mutant copies. */
function runMatrix(t, engine, files) {
  for (const file of files) {
    const tag = ' [' + file + ']';

    // -------------------------------------- dispatchSchedule fail-closed
    const schedCases = [
      ['valid base', {}, true],
      ['dispatch missing', null, false],
      ['dispatch non-object', 'x', false],
      ['cutoff 9:00 (no leading zero)', { cutoff: '9:00' }, false],
      ['cutoff 24:00', { cutoff: '24:00' }, false],
      ['cutoff 14:0', { cutoff: '14:0' }, false],
      ['cutoff 14-00', { cutoff: '14-00' }, false],
      ['cutoff numeric 1400', { cutoff: 1400 }, false],
      ['cutoff 23:59 valid', { cutoff: '23:59' }, true],
      ['timezone empty', { timezone: '' }, false],
      ['timezone numeric', { timezone: 5 }, false],
      ['days empty', { days: [] }, false],
      ['days non-array', { days: 'weekdays' }, false],
      ['showWithinHours 0', { showWithinHours: 0 }, false],
      ['showWithinHours 25', { showWithinHours: 25 }, false],
      ['showWithinHours NaN', { showWithinHours: NaN }, false],
      ['showWithinHours 24.6 rounds to 25', { showWithinHours: 24.6 }, false],
      ['showWithinHours "8" string coerces', { showWithinHours: '8' }, true],
      ['showWithinHours 24 valid', { showWithinHours: 24 }, true],
    ];
    for (const [label, over, ok] of schedCases) {
      const cfg = over === null
        ? { strings: Object.assign({}, BASE_STRINGS) }
        : baseCfg(typeof over === 'string' ? undefined : over);
      if (typeof over === 'string') cfg.dispatch = over;
      const ctx = engine(file, cfg, UT(2026, 2, 11, 11, 0, 0));
      const s = ctx.dispatchSchedule();
      t.check('schedule: ' + label + tag, (s !== null) === ok, JSON.stringify(s));
    }
    {
      const ctx = engine(file, baseCfg(), 0);
      const s = ctx.dispatchSchedule();
      t.eq('schedule: cutoffMinutes 14:00 -> 840' + tag, s && s.cutoffMinutes, 840);
      t.eq('schedule: withinMinutes 4h -> 240' + tag, s && s.withinMinutes, 240);
      const s2 = engine(file, baseCfg({ cutoff: '23:59' }), 0).dispatchSchedule();
      t.eq('schedule: cutoffMinutes 23:59 -> 1439' + tag, s2 && s2.cutoffMinutes, 1439);
    }
    // missing translation strings -> null
    for (const missing of ['dispatch.within', 'dispatch.within_minutes']) {
      const strings = Object.assign({}, BASE_STRINGS);
      delete strings[missing];
      const ctx = engine(file, baseCfg({}, strings), 0);
      t.eq('schedule: missing string ' + missing + ' -> null' + tag, ctx.dispatchSchedule(), null);
    }
    if (file === 'pdp') {
      // cart reads the module-global STRINGS map (always an object at boot);
      // only the pdp resolver ever sees cfg.strings entirely absent.
      const ctx = engine(file, baseCfg({}, null), 0);
      t.eq('schedule: strings map absent -> null [pdp]', ctx.dispatchSchedule(), null);
    }

    // -------------------------- working-day / cutoff / window (Paris CET)
    // Wed 2026-03-11: Paris is UTC+1 (DST starts Mar 29). Cutoff 14:00,
    // window 4h, working days Mon-Fri.
    const windowCases = [
      // [label, utcMs, expectedRemainingMs, expectedReason]
      ['12:00 Paris in-window', UT(2026, 2, 11, 11, 0, 0), 120 * 60000, null],
      ['10:00 Paris window opens exactly', UT(2026, 2, 11, 9, 0, 0), 240 * 60000, null],
      ['09:59 Paris too early', UT(2026, 2, 11, 8, 59, 0), null, 'too_early'],
      ['14:00 Paris at cutoff exactly', UT(2026, 2, 11, 13, 0, 0), null, 'cutoff_passed'],
      ['14:01 Paris after cutoff', UT(2026, 2, 11, 13, 1, 0), null, 'cutoff_passed'],
      ['13:59:30 Paris seconds precision', UT(2026, 2, 11, 12, 59, 30), 30000, null],
      ['Sunday 12:00 Paris closed', UT(2026, 2, 15, 11, 0, 0), null, 'closed_day'],
      ['Saturday 12:00 Paris closed', UT(2026, 2, 14, 11, 0, 0), null, 'closed_day'],
    ];
    for (const [label, nowMs, expRemaining, expReason] of windowCases) {
      const ctx = engine(file, baseCfg(), nowMs);
      const s = ctx.dispatchSchedule();
      t.check('window: schedule valid for ' + label + tag, s !== null);
      if (!s) continue;
      t.eq('window: remaining ' + label + tag, ctx.dispatchRemainingMs(s), expRemaining);
      t.eq('window: reason ' + label + tag, ctx.dispatchHiddenReason(s), expReason);
    }

    // ------------------------------------------------- midnight h24 path
    // tz UTC, cutoff 00:30, all days, 1h window. Whatever the ICU build
    // emits for midnight ("00" or the h24 "24"), the % 24 normalization
    // must land on nowMinutes = 0 -> 30 min remaining (minus seconds).
    {
      const cfg = baseCfg({ cutoff: '00:30', timezone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], showWithinHours: 1 });
      const ctx = engine(file, cfg, UT(2026, 2, 11, 0, 0, 30));
      const s = ctx.dispatchSchedule();
      t.check('midnight: schedule valid' + tag, s !== null);
      if (s) {
        t.eq('midnight: 00:00:30 -> 30min - 30s' + tag, ctx.dispatchRemainingMs(s), 30 * 60000 - 30000);
        t.eq('midnight: reason null (visible)' + tag, ctx.dispatchHiddenReason(s), null);
      }
    }

    // ------------------------------------------------ invalid timezones
    for (const tz of ['Mars/Olympus', 'Not A Zone', 'Europe/Nowhere']) {
      const cfg = baseCfg({ timezone: tz });
      const ctx = engine(file, cfg, UT(2026, 2, 11, 11, 0, 0));
      const s = ctx.dispatchSchedule();
      t.check('invalid-tz: schedule still parses (' + tz + ')' + tag, s !== null);
      if (!s) continue;
      t.eq('invalid-tz: remaining null (' + tz + ')' + tag, ctx.dispatchRemainingMs(s), null);
      t.eq('invalid-tz: reason null = invalid verdict (' + tz + ')' + tag, ctx.dispatchHiddenReason(s), null);
      t.eq('invalid-tz: dispatchUt null (' + tz + ')' + tag,
        ctx.deliveryDispatchUt({ cutoffMinutes: 840, timezone: tz, dispatchDays: [1, 2, 3, 4, 5] }), null);
    }
    {
      // Etc/GMT+12 is unusual but VALID IANA — must not fail closed.
      const cfg = baseCfg({ timezone: 'Etc/GMT+12', cutoff: '23:00', showWithinHours: 24 });
      const ctx = engine(file, cfg, UT(2026, 2, 11, 21, 0, 0)); // Wed 09:00 at GMT-12
      const s = ctx.dispatchSchedule();
      t.check('valid-odd-tz: Etc/GMT+12 visible' + tag, s !== null && ctx.dispatchRemainingMs(s) === 14 * 60 * 60000);
    }

    // ---------------------- deliveryDispatchUt: DST-safe day-0 + scan
    const dcParis = { cutoffMinutes: 840, timezone: 'Europe/Paris', dispatchDays: [1, 2, 3, 4, 5] };
    const dcNY = { cutoffMinutes: 840, timezone: 'America/New_York', dispatchDays: [1, 2, 3, 4, 5] };
    const dispatchCases = [
      // [label, dc, nowUtcMs, expected UTC-midnight stamp]
      ['Fri before cutoff -> same day (Paris, pre-DST)', dcParis,
        UT(2026, 2, 27, 12, 0, 0), UT(2026, 2, 27)], // 13:00 Paris
      ['Fri AT cutoff exactly -> next Monday across spring-forward (Paris)', dcParis,
        UT(2026, 2, 27, 13, 0, 0), UT(2026, 2, 30)], // 14:00 Paris sharp
      ['Fri after cutoff -> next Monday across spring-forward (Paris)', dcParis,
        UT(2026, 2, 27, 14, 0, 0), UT(2026, 2, 30)],
      ['Sat evening -> Monday, scan crosses Paris spring-forward Sunday', dcParis,
        UT(2026, 2, 28, 20, 0, 0), UT(2026, 2, 30)],
      ['Sun during Paris fall-back (25 Oct) -> Monday', dcParis,
        UT(2026, 9, 25, 5, 0, 0), UT(2026, 9, 26)],
      ['Fri before cutoff mid-summer (Paris CEST)', dcParis,
        UT(2026, 6, 17, 11, 59, 0), UT(2026, 6, 17)], // 13:59 Paris
      ['NY: Sunday 01:30 EST just after fall-back -> Monday', dcNY,
        UT(2026, 10, 1, 6, 30, 0), UT(2026, 10, 2)],
      ['NY: Fri before cutoff, scan reaches across spring-forward', dcNY,
        UT(2026, 2, 6, 15, 0, 0), UT(2026, 2, 6)], // 10:00 EST Friday
      ['NY: Sat before spring-forward Sunday -> Monday', dcNY,
        UT(2026, 2, 7, 20, 0, 0), UT(2026, 2, 9)],
    ];
    for (const [label, dc, nowMs, expected] of dispatchCases) {
      const ctx = engine(file, baseCfg(), nowMs);
      const got = ctx.deliveryDispatchUt(dc);
      t.eq('dispatchUt: ' + label + tag, got, expected);
      if (got !== null) {
        t.check('dispatchUt: pure UTC-midnight calendar stamp ' + label + tag, got % 86400000 === 0, got);
      }
    }
    {
      // 14-day scan cap: an ISO day that can never match -> null.
      const ctx = engine(file, baseCfg(), UT(2026, 2, 11, 11, 0, 0));
      t.eq('dispatchUt: unreachable dispatch day -> 14-day cap -> null' + tag,
        ctx.deliveryDispatchUt({ cutoffMinutes: 840, timezone: 'Europe/Paris', dispatchDays: [9] }), null);
    }
  }
}

// ------------------------------------------------------------- main run
runMatrix(tap, makeFactory(bundles), ['pdp', 'cart']);

// Document this machine's ICU midnight behavior (informational only).
{
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hour12: false,
  }).formatToParts(new Date(Date.UTC(2026, 2, 11, 0, 0, 30)));
  const hour = (parts.find((p) => p.type === 'hour') || {}).value;
  console.log('info: ICU midnight hour token on this machine = "' + hour + '" (engine normalizes % 24)');
}

// -------------------------------------------------------- mutation tests
const MUTANTS = [
  {
    name: 'M1 cutoff boundary >= -> >',
    find: 'if (nowMinutes >= schedule.cutoffMinutes) return null; // cutoff passed',
    replace: 'if (nowMinutes > schedule.cutoffMinutes) return null; // cutoff passed',
  },
  {
    name: 'M2 window unit within*60 -> within',
    find: 'withinMinutes: within * 60',
    replace: 'withinMinutes: within',
  },
  {
    name: 'M3 working-day gate === -1 -> === -2',
    find: "if (!iso || schedule.days.indexOf(iso) === -1) return null; // not a working day",
    replace: "if (!iso || schedule.days.indexOf(iso) === -2) return null; // not a working day",
  },
  {
    name: 'M4 drop seconds precision',
    find: 'return (schedule.cutoffMinutes - nowMinutes) * 60000 - seconds * 1000;',
    replace: 'return (schedule.cutoffMinutes - nowMinutes) * 60000;',
  },
  {
    name: 'M5 day-0 cutoff >= -> > (deliveryDispatchUt)',
    find: 'if (k === 0 && nowMinutes >= dc.cutoffMinutes) continue; // cutoff passed today',
    replace: 'if (k === 0 && nowMinutes > dc.cutoffMinutes) continue; // cutoff passed today',
  },
  {
    name: 'M6 ISO weekday conversion broken (deliveryDispatchUt)',
    find: 'var iso = ((new Date(ut).getUTCDay() + 6) % 7) + 1;',
    replace: 'var iso = new Date(ut).getUTCDay() + 1;',
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
