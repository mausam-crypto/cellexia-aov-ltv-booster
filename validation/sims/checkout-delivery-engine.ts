#!/usr/bin/env node --experimental-strip-types
/**
 * validation/sims/checkout-delivery-engine.ts — checkout delivery engine sim.
 *
 * Runs under `node --experimental-strip-types` (the strip-types recipe the
 * retired scripts/proofs runner pioneered) and imports the REAL shipped module
 * extensions/checkout-delivery/src/delivery-engine.ts — never a copy — with
 * REAL Intl and injected `now` Dates (the module takes the clock as a
 * parameter by design).
 *
 * Coverage:
 *  - resolveDeliveryConfig: caller-supplied ISO2 country (never guessed),
 *    deliveryEstimate.byCountry PARTIAL override + hidden gate, dispatch
 *    byCountry WHOLESALE override (incomplete entries fail closed), the
 *    Liquid-parity '14:00' / 'Europe/Paris' defaults (empty/missing ONLY —
 *    malformed still fails), max >= min AFTER the merge, int-range and
 *    weekday validation
 *  - deliveryDispatchUt / deliveryAdvance / computeDelivery with REAL-Intl
 *    DST probes (Paris + New York, spring-forward and fall-back), the
 *    at-cutoff boundary, 14-day and 60-day scan caps — the expected UTC
 *    stamps are the SAME constants asserted against the storefront twins in
 *    validation/sims/delivery-businessdays.mjs, so the two engines are
 *    pinned to each other through shared fixtures
 *  - holiday tables: DELIVERY_HOLIDAYS + GLOBAL_DELIVERY_EXCLUSIONS deep-
 *    equal the canonical app/services/delivery-holidays.server.ts tables
 *  - v10 US state layer (SPEC §5): provinceCode third argument (typed
 *    state only, case-insensitive, inert for non-US countries and when the
 *    module is off), state override applied / hidden -> null / invalid or
 *    inconsistent entry discarded (fail OPEN to the US-wide values),
 *    per-state cutoff + dispatchDays PARTIAL dispatch override (timezone
 *    inherited), merchant extra dates in both "MM-DD" and "YYYY-MM-DD"
 *    forms, and the six movable US federal holidays via usFederalMovable
 *    (2026 oracle incl. Thanksgiving 11-26)
 *  - deliveryFormatDate: byte-identity of behavior with the storefront
 *    twins via the shared independent generator
 *    (validation/lib/native-dates-gen.mjs) across representative locales,
 *    the fr 1er rule, the ja convention and the fallback chain
 *  - Checkout.tsx source anchors: the typed provinceCode threads from the
 *    shipping address into the 3-arg engine resolve (2-arg calls stay
 *    type-valid, so only these pins keep the wiring — the checkout-trust
 *    sim carries the same pair for ITS component)
 *
 * Offline, deterministic (injected `now`), node-only.
 */
import {
  resolveDeliveryConfig,
  deliveryDispatchUt,
  deliveryQualifies,
  deliveryAdvance,
  computeDelivery,
  deliveryFormatDate,
  usFederalMovable,
  DELIVERY_HOLIDAYS,
  GLOBAL_DELIVERY_EXCLUSIONS,
  type ResolvedDeliveryConfig,
} from '../../extensions/checkout-delivery/src/delivery-engine.ts';
import {
  readSource,
  extractTsConstValue,
  makeTap,
} from '../lib/extract.mjs';
import {
  expectedNativeDate,
  expectedShortFallback,
  fixtureStamps,
} from '../lib/native-dates-gen.mjs';

const tap = makeTap('checkout-delivery-engine');
const UT = Date.UTC;

// ------------------------------------------ canonical-table parity
{
  const serverSrc = readSource('app/services/delivery-holidays.server.ts');
  const serverTable = extractTsConstValue(serverSrc, 'DELIVERY_HOLIDAYS');
  const serverExcl = extractTsConstValue(serverSrc, 'GLOBAL_DELIVERY_EXCLUSIONS');
  tap.check('DELIVERY_HOLIDAYS parity with canonical server table',
    JSON.stringify(DELIVERY_HOLIDAYS) === JSON.stringify(serverTable));
  tap.check('GLOBAL_DELIVERY_EXCLUSIONS parity with canonical server list',
    JSON.stringify(GLOBAL_DELIVERY_EXCLUSIONS) === JSON.stringify(serverExcl));
  tap.eq('25 countries in the table', Object.keys(DELIVERY_HOLIDAYS).length, 25);
}

// -------------------------------------------- resolveDeliveryConfig
function baseRoot(): Record<string, unknown> {
  return {
    deliveryEstimate: {
      minDays: 2,
      maxDays: 5,
      deliveryDays: [1, 2, 3, 4, 5],
      holidaysEnabled: true,
      byCountry: {
        DE: { minDays: 1 },
        GB: { hidden: true },
        IT: { maxDays: 1 },
        NL: { deliveryDays: [2, 4], holidaysEnabled: false },
      },
    },
    dispatch: {
      cutoff: '14:00',
      timezone: 'Europe/Paris',
      days: [1, 2, 3, 4, 5],
      byCountry: {
        US: { cutoff: '16:00', timezone: 'America/New_York', days: [1, 2, 3] },
        CA: { cutoff: '16:00' }, // incomplete wholesale entry -> fail closed
      },
    },
  };
}

{
  const fr = resolveDeliveryConfig(baseRoot(), 'FR');
  tap.check('FR resolves', fr !== null);
  if (fr) {
    tap.eq('FR minDays', fr.minDays, 2);
    tap.eq('FR maxDays', fr.maxDays, 5);
    tap.eq('FR cutoffMinutes', fr.cutoffMinutes, 840);
    tap.eq('FR timezone', fr.timezone, 'Europe/Paris');
    tap.eq('FR country uppercased from caller value', fr.country, 'FR');
  }
  const frLower = resolveDeliveryConfig(baseRoot(), 'fr');
  tap.check('lowercase country accepted and uppercased', frLower !== null && frLower.country === 'FR');

  tap.eq('no country -> null (never guess)', resolveDeliveryConfig(baseRoot(), undefined), null);
  tap.eq('empty country -> null', resolveDeliveryConfig(baseRoot(), ''), null);
  tap.eq('three-letter country -> null', resolveDeliveryConfig(baseRoot(), 'FRA'), null);
  tap.eq('digit country -> null', resolveDeliveryConfig(baseRoot(), 'F1'), null);
  tap.eq('non-string country -> null', resolveDeliveryConfig(baseRoot(), 12), null);
  tap.eq('non-object root -> null', resolveDeliveryConfig(null, 'FR'), null);
  tap.eq('missing deliveryEstimate -> null', resolveDeliveryConfig({ dispatch: {} }, 'FR'), null);

  const de = resolveDeliveryConfig(baseRoot(), 'DE');
  tap.check('DE partial override: minDays 1, maxDays inherited 5',
    de !== null && de.minDays === 1 && de.maxDays === 5);
  tap.eq('GB hidden -> null', resolveDeliveryConfig(baseRoot(), 'GB'), null);
  tap.eq('IT override maxDays 1 < inherited minDays 2 -> null',
    resolveDeliveryConfig(baseRoot(), 'IT'), null);
  const nl = resolveDeliveryConfig(baseRoot(), 'NL');
  tap.check('NL override replaces deliveryDays + holidaysEnabled',
    nl !== null && JSON.stringify(nl.deliveryDays) === '[2,4]' && nl.holidaysEnabled === false);

  const us = resolveDeliveryConfig(baseRoot(), 'US');
  tap.check('US wholesale dispatch override (cutoff+tz+days)',
    us !== null && us.cutoffMinutes === 960 && us.timezone === 'America/New_York' &&
    JSON.stringify(us.dispatchDays) === '[1,2,3]');
  tap.eq('CA incomplete wholesale dispatch override -> null',
    resolveDeliveryConfig(baseRoot(), 'CA'), null);
}

{
  // Liquid-parity defaults: fire on missing/empty ONLY.
  const root = baseRoot();
  delete (root.dispatch as Record<string, unknown>).cutoff;
  const dc = resolveDeliveryConfig(root, 'FR');
  tap.check('missing cutoff -> default 14:00', dc !== null && dc.cutoffMinutes === 840);

  const root2 = baseRoot();
  (root2.dispatch as Record<string, unknown>).cutoff = '';
  const dc2 = resolveDeliveryConfig(root2, 'FR');
  tap.check('empty cutoff -> default 14:00', dc2 !== null && dc2.cutoffMinutes === 840);

  const root3 = baseRoot();
  (root3.dispatch as Record<string, unknown>).timezone = '';
  const dc3 = resolveDeliveryConfig(root3, 'FR');
  tap.check('empty timezone -> default Europe/Paris', dc3 !== null && dc3.timezone === 'Europe/Paris');

  const root4 = baseRoot();
  (root4.dispatch as Record<string, unknown>).cutoff = '9:00';
  tap.eq('malformed cutoff 9:00 -> null (default only on empty)',
    resolveDeliveryConfig(root4, 'FR'), null);

  const root5 = baseRoot();
  delete (root5.dispatch as Record<string, unknown>).days;
  tap.eq('dispatch days have NO default -> null', resolveDeliveryConfig(root5, 'FR'), null);

  const root6 = baseRoot();
  (root6.deliveryEstimate as Record<string, unknown>).minDays = 1.5;
  tap.eq('minDays 1.5 -> null', resolveDeliveryConfig(root6, 'FR'), null);

  const root7 = baseRoot();
  (root7.deliveryEstimate as Record<string, unknown>).deliveryDays = [1, 8];
  tap.eq('deliveryDays containing 8 -> null', resolveDeliveryConfig(root7, 'FR'), null);
}

// -------------------------------------- v10 US state layer (fail OPEN)
function usRoot(): Record<string, unknown> {
  const root = baseRoot();
  (root.deliveryEstimate as Record<string, unknown>).usStates = {
    enabled: true,
    selector: true,
    federalHolidays: true,
    // '13-40' fails the date regex: dropped, never fails the layer.
    extraHolidays: ['07-06', '2026-08-14', '13-40'],
    byState: {
      CA: { minDays: 1, maxDays: 3, cutoff: '11:00', extraHolidays: ['09-09'] },
      NY: { hidden: true },
      TX: { minDays: 25 }, // valid field, candidate 25 > inherited max 5
      WA: { cutoff: 'late' }, // invalid field -> not merged
      FL: { dispatchDays: [6, 7] },
      NV: { holidaysEnabled: false },
    },
  };
  return root;
}

{
  const us = resolveDeliveryConfig(usRoot(), 'US', undefined);
  tap.check('US module on, no provinceCode -> US-wide values, never hidden',
    us !== null && us.minDays === 2 && us.maxDays === 5 && us.cutoffMinutes === 960);
  tap.check('module extras validated (bad entry dropped) + federal flag on',
    us !== null && JSON.stringify(us.extra) === '["07-06","2026-08-14"]' && us.usFederal === true);

  const ca = resolveDeliveryConfig(usRoot(), 'US', 'CA');
  tap.check('CA override applied: min/max + cutoff, timezone + days inherited',
    ca !== null && ca.minDays === 1 && ca.maxDays === 3 && ca.cutoffMinutes === 660 &&
    ca.timezone === 'America/New_York' && JSON.stringify(ca.dispatchDays) === '[1,2,3]');
  tap.check('CA state extras ride behind the module extras',
    ca !== null && JSON.stringify(ca.extra) === '["07-06","2026-08-14","09-09"]');
  const caLower = resolveDeliveryConfig(usRoot(), 'US', 'ca');
  tap.check('provinceCode is case-insensitive ("ca" == "CA")',
    caLower !== null && caLower.minDays === 1 && caLower.cutoffMinutes === 660);

  tap.eq('NY hidden state -> null (the one deliberate state hide)',
    resolveDeliveryConfig(usRoot(), 'US', 'NY'), null);
  const tx = resolveDeliveryConfig(usRoot(), 'US', 'TX');
  tap.check('TX candidate min 25 > max 5 -> WHOLE entry discarded, US-wide stays',
    tx !== null && tx.minDays === 2 && tx.maxDays === 5);
  const wa = resolveDeliveryConfig(usRoot(), 'US', 'WA');
  tap.check('WA invalid cutoff field ignored -> US-wide values',
    wa !== null && wa.cutoffMinutes === 960 && wa.minDays === 2);
  const fl = resolveDeliveryConfig(usRoot(), 'US', 'FL');
  tap.check('FL PARTIAL dispatchDays override, cutoff inherited',
    fl !== null && JSON.stringify(fl.dispatchDays) === '[6,7]' && fl.cutoffMinutes === 960);
  const nv = resolveDeliveryConfig(usRoot(), 'US', 'NV');
  tap.check('NV holidaysEnabled false -> usFederal off (federal rides holidays)',
    nv !== null && nv.holidaysEnabled === false && nv.usFederal === false);

  const fr = resolveDeliveryConfig(usRoot(), 'FR', 'CA');
  tap.check('non-US country ignores provinceCode + carries no state members',
    fr !== null && fr.minDays === 2 && fr.extra === undefined && fr.usFederal === undefined);
  const plainUs = resolveDeliveryConfig(baseRoot(), 'US', 'CA');
  tap.check('module absent -> provinceCode inert, no state members',
    plainUs !== null && plainUs.extra === undefined && plainUs.usFederal === undefined);

  tap.eq('usFederalMovable(2026) — the six movable dates',
    usFederalMovable(2026),
    ['2026-01-19', '2026-02-16', '2026-05-25', '2026-09-07', '2026-10-12', '2026-11-26']);
  if (us && ca) {
    tap.eq('qualify: Thanksgiving 2026-11-26 (Thu) excluded when usFederal',
      deliveryQualifies(UT(2026, 10, 26), us), false);
    tap.eq('qualify: Labor Day 2026-09-07 (Mon) excluded when usFederal',
      deliveryQualifies(UT(2026, 8, 7), us), false);
    tap.eq('qualify: module extra 07-06 recurs — 2026-07-06 (Mon) excluded',
      deliveryQualifies(UT(2026, 6, 6), us), false);
    tap.eq('qualify: module extra 07-06 recurs — 2027-07-06 (Tue) excluded',
      deliveryQualifies(UT(2027, 6, 6), us), false);
    tap.eq('qualify: one-off 2026-08-14 (Fri) excluded in its year',
      deliveryQualifies(UT(2026, 7, 14), us), false);
    tap.eq('qualify: one-off 2026-08-14 does NOT recur — 2028-08-14 (Mon) fine',
      deliveryQualifies(UT(2028, 7, 14), us), true);
    tap.eq('qualify: CA state extra 09-09 excluded with the entry adopted',
      deliveryQualifies(UT(2026, 8, 9), ca), false);
    tap.eq('qualify: state extra 09-09 does not leak into the no-state config',
      deliveryQualifies(UT(2026, 8, 9), us), true);
    // Mon 2026-07-20 17:00Z = 13:00 EDT: before the US-wide 16:00 cutoff,
    // after CA's 11:00 — the state cutoff shifts dispatch to Tuesday.
    tap.eq('dispatchUt: US-wide 16:00 cutoff not passed -> same-day dispatch',
      deliveryDispatchUt(us, new Date(UT(2026, 6, 20, 17, 0, 0))), UT(2026, 6, 20));
    tap.eq('dispatchUt: CA 11:00 cutoff passed -> next dispatch day',
      deliveryDispatchUt(ca, new Date(UT(2026, 6, 20, 17, 0, 0))), UT(2026, 6, 21));
  }
  const offRoot = usRoot();
  const offUsStates = (offRoot.deliveryEstimate as Record<string, unknown>)
    .usStates as Record<string, unknown>;
  offUsStates.federalHolidays = false;
  const usOff = resolveDeliveryConfig(offRoot, 'US', undefined);
  tap.check('federalHolidays false -> usFederal false, Thanksgiving qualifies',
    usOff !== null && usOff.usFederal === false &&
    deliveryQualifies(UT(2026, 10, 26), usOff));
}

// --------------------------------------------- engine + DST probes
function dcFor(over: Partial<ResolvedDeliveryConfig>): ResolvedDeliveryConfig {
  return Object.assign(
    {
      minDays: 2, maxDays: 5, deliveryDays: [1, 2, 3, 4, 5], holidaysEnabled: true,
      country: 'FR', cutoffMinutes: 840, timezone: 'Europe/Paris',
      dispatchDays: [1, 2, 3, 4, 5],
    },
    over,
  );
}

// SAME shared fixture constants as validation/sims/delivery-businessdays.mjs
// — the storefront and checkout engines are pinned to each other here.
const computeCases: Array<[string, number, Partial<ResolvedDeliveryConfig>, { dispatch: number; min: number; max: number } | null]> = [
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
  const got = computeDelivery(dcFor(over), new Date(nowMs));
  tap.eq('compute: ' + label, got, expected);
  if (got) {
    tap.check('compute: UTC-midnight stamps ' + label,
      got.dispatch % 86400000 === 0 && got.min % 86400000 === 0 && got.max % 86400000 === 0);
  }
}

{
  // At-cutoff boundary + 14-day scan cap, mirrored from the dispatch sim.
  const dc = dcFor({});
  tap.eq('dispatchUt: Fri AT cutoff exactly -> Monday',
    deliveryDispatchUt(dc, new Date(UT(2026, 2, 27, 13, 0, 0))), UT(2026, 2, 30));
  tap.eq('dispatchUt: Fri just before cutoff -> same day',
    deliveryDispatchUt(dc, new Date(UT(2026, 2, 27, 12, 59, 0))), UT(2026, 2, 27));
  tap.eq('dispatchUt: unreachable dispatch day -> 14-day cap -> null',
    deliveryDispatchUt(dcFor({ dispatchDays: [9] }), new Date(UT(2026, 2, 27, 12, 0, 0))), null);
}

{
  // Qualify spot checks shared with the storefront sim.
  tap.eq('qualify: FR May 1 holiday', deliveryQualifies(UT(2026, 4, 1), dcFor({})), false);
  tap.eq('qualify: FR May 1 holidays off',
    deliveryQualifies(UT(2026, 4, 1), dcFor({ holidaysEnabled: false })), true);
  tap.eq('qualify: Dec 25 global even with holidays off',
    deliveryQualifies(UT(2026, 11, 25), dcFor({ country: 'XX', holidaysEnabled: false })), false);
  tap.eq('advance: Christmas n=1 from Wed Dec 23 -> Mon Dec 28 (GB)',
    deliveryAdvance(UT(2026, 11, 23), 1, dcFor({ country: 'GB' })), UT(2026, 11, 28));
  tap.eq('advance: Mondays-only n=30 -> 60-day cap null',
    deliveryAdvance(UT(2026, 6, 6), 30, dcFor({ country: 'ZZ', deliveryDays: [1], holidaysEnabled: false })), null);
}

// ------------------------------- deliveryFormatDate twin via generator
{
  const locales = ['en', 'fr', 'ja', 'ar', 'pt-PT', 'pl', 'de', 'el'];
  for (const locale of locales) {
    for (const ut of fixtureStamps()) {
      const got = deliveryFormatDate(ut, locale);
      const expected = expectedNativeDate(ut, locale);
      tap.check(
        'format ' + locale + ' ' + new Date(ut).toISOString().slice(0, 10),
        got === expected,
        'got=' + JSON.stringify(got) + ' expected=' + JSON.stringify(expected),
      );
    }
  }
  tap.eq('fr hard expectation 2026-05-01', deliveryFormatDate(UT(2026, 4, 1), 'fr'), 'vendredi 1er mai');
  tap.eq('ja hard expectation 2026-07-25', deliveryFormatDate(UT(2026, 6, 25), 'ja'), '7月25日(土)');
  const ut = UT(2026, 6, 22);
  tap.eq('fallback: empty locale -> short form', deliveryFormatDate(ut, ''), expectedShortFallback(ut));
  tap.eq('fallback: rejected tag -> short form', deliveryFormatDate(ut, 'no way!'), expectedShortFallback(ut));
}

// ------------------------- Checkout.tsx pins (checkout-delivery component)
{
  // resolveDeliveryConfig keeps 2-arg calls type-valid (provinceCode is
  // optional by design, SPEC §5), so tsc cannot catch a dropped third
  // argument — a source anchor is the only guard that the PRIMARY checkout
  // delivery widget threads the typed state. Mirrors checkout-trust's T5
  // pair against ITS Checkout.tsx.
  const src = readSource('extensions/checkout-delivery/src/Checkout.tsx');
  for (const anchor of [
    'resolveDeliveryConfig(configRoot, countryCode, provinceCode)',
    'shippingAddress?.provinceCode',
    // v12 per-market product exclusions: the widget reads the cart lines,
    // checks deliveryEstimate.excludedByMarket for the buyer's market, the
    // veto rides featureVisible (draft grants included), and the preview
    // diagnosis names exclusion instead of "not enabled".
    'useCartLines()',
    "excludedProductInCart(",
    "'excludedByMarket'",
    '!deliveryExcluded',
    'excluded: deliveryExcluded',
  ]) {
    tap.check(`Checkout.tsx anchor present: ${anchor}`, src.includes(anchor));
  }
}

tap.finish();
