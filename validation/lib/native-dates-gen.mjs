/**
 * validation/lib/native-dates-gen.mjs — independent generator for the
 * v6.0.1 DATE_STYLE fixtures.
 *
 * This is NOT the shipped implementation: it re-derives the documented
 * contract through a DIFFERENT API path (Intl.DateTimeFormat.format instead
 * of Date#toLocaleDateString) so a drift in the shipped engines' option
 * objects, ja convention, verbatim-locale passing, local-noon rebuild or
 * fr "1er" upgrade is caught by comparison instead of being reproduced.
 *
 * Contract (docs in cellexia-pdp.js#deliveryFormatDate and
 * extensions/checkout-delivery/src/delivery-engine.ts#deliveryFormatDate):
 *  - base language ja  -> { month:'long', day:'numeric', weekday:'short' }
 *  - every other base  -> { weekday:'long', day:'numeric', month:'long' }
 *  - the page-locale tag is passed to Intl VERBATIM ("pt-PT" stays "pt-PT")
 *  - the UTC calendar stamp is rebuilt as a LOCAL noon Date so formatting
 *    can never shift the calendar day
 *  - base language fr upgrades a day-1 cardinal "1" to the ordinal "1er"
 */

export function expectedNativeDate(ut, locale) {
  const d = new Date(ut);
  const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  const base = typeof locale === 'string' && locale ? locale.split('-')[0].toLowerCase() : '';
  if (!base) return expectedShortFallback(ut);
  const options = base === 'ja'
    ? { month: 'long', day: 'numeric', weekday: 'short' }
    : { weekday: 'long', day: 'numeric', month: 'long' };
  let label;
  try {
    label = new Intl.DateTimeFormat(locale, options).format(local);
  } catch {
    return expectedShortFallback(ut); // Intl rejected the tag: short form
  }
  if (base === 'fr' && d.getUTCDate() === 1) {
    label = label.replace(/\b1\b/, '1er');
  }
  return label;
}

/** The pre-v6.0.1 short browser-locale form (fallback leg of the chain). */
export function expectedShortFallback(ut) {
  const d = new Date(ut);
  const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(local);
}

/**
 * Fixture stamp set: day 1 of every 2026 month (twelve fr-"1er" probes,
 * spread across months) + one full Mon..Sun week (2026-07-20..26, all seven
 * ISO weekdays) + a month-boundary date. All UTC-midnight calendar stamps.
 */
export function fixtureStamps() {
  const stamps = [];
  for (let m = 0; m < 12; m++) stamps.push(Date.UTC(2026, m, 1));
  for (let d = 20; d <= 26; d++) stamps.push(Date.UTC(2026, 6, d));
  stamps.push(Date.UTC(2026, 7, 31));
  return stamps;
}

/** Freshly generate the full fixtures object for the given locale tags. */
export function generateFixtures(locales) {
  const entries = [];
  for (const locale of locales) {
    for (const ut of fixtureStamps()) {
      entries.push({
        locale,
        ut,
        iso: new Date(ut).toISOString().slice(0, 10),
        label: expectedNativeDate(ut, locale),
      });
    }
  }
  return {
    contract: 'v6.0.1 DATE_STYLE (ja convention + fr 1er + verbatim locale + local-noon rebuild)',
    node: process.version,
    icu: process.versions.icu || 'unknown',
    entries,
  };
}
