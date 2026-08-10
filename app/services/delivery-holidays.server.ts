/**
 * Canonical public-holiday table for the delivery estimator (v5.9).
 *
 * SCOPE — deliberately conservative: FIXED-DATE national public holidays
 * only. Movable feasts (Easter/Whit Monday, Thanksgiving, Islamic holidays,
 * Chinese New Year, Midsummer Eve, …) are DELIBERATELY EXCLUDED — computing
 * them client-side is error-prone, and a wrong "guaranteed by" date is worse
 * than a slightly pessimistic one that skips a normal working day never and
 * a real holiday almost always. Countries not listed here get only the
 * global exclusions below.
 *
 * GLOBAL EXCLUSIONS (always applied, NOT configurable, independent of this
 * table and of deliveryEstimate.holidaysEnabled): Dec 24, Dec 25, Dec 31,
 * Jan 1 — no carrier anywhere delivers reliably on those days.
 *
 * MIRRORING — this table is mirrored as an ES5 literal in the storefront
 * asset (cellexia-pdp.js). The validation harness byte-compares the parsed
 * data of both copies, so they can never drift: change one, change both.
 *
 * Keys are ISO2 country codes; values are "MM-DD" strings.
 */
export const DELIVERY_HOLIDAYS: Record<string, string[]> = {
  US: ["06-19", "07-04", "11-11"],
  CA: ["07-01", "12-26"],
  GB: ["12-26"],
  IE: ["03-17", "12-26"],
  FR: ["05-01", "05-08", "07-14", "08-15", "11-01", "11-11"],
  DE: ["05-01", "10-03", "12-26"],
  AT: ["01-06", "05-01", "08-15", "10-26", "11-01", "12-08", "12-26"],
  CH: ["08-01"],
  IT: [
    "01-06",
    "04-25",
    "05-01",
    "06-02",
    "08-15",
    "11-01",
    "12-08",
    "12-26",
  ],
  ES: ["01-06", "05-01", "08-15", "10-12", "11-01", "12-06", "12-08"],
  PT: [
    "04-25",
    "05-01",
    "06-10",
    "08-15",
    "10-05",
    "11-01",
    "12-01",
    "12-08",
  ],
  NL: ["04-27", "12-26"],
  BE: ["05-01", "07-21", "08-15", "11-01", "11-11"],
  SE: ["01-06", "05-01", "06-06", "12-26"],
  NO: ["05-01", "05-17", "12-26"],
  DK: ["12-26"],
  FI: ["01-06", "05-01", "12-06", "12-26"],
  PL: ["01-06", "05-01", "05-03", "08-15", "11-01", "11-11", "12-26"],
  GR: ["01-06", "03-25", "05-01", "10-28", "12-26"],
  CZ: [
    "05-01",
    "05-08",
    "07-05",
    "07-06",
    "09-28",
    "10-28",
    "11-17",
    "12-26",
  ],
  HU: ["03-15", "05-01", "08-20", "10-23", "11-01", "12-26"],
  RO: ["01-24", "05-01", "06-01", "08-15", "11-30", "12-01"],
  JP: [
    "02-11",
    "02-23",
    "04-29",
    "05-03",
    "05-04",
    "05-05",
    "08-11",
    "11-03",
    "11-23",
  ],
  AU: ["01-26", "04-25", "12-26"],
  NZ: ["02-06", "04-25", "12-26"],
};

/**
 * Always-excluded delivery dates ("MM-DD"), applied to EVERY country
 * regardless of holidaysEnabled or byCountry overrides.
 */
export const GLOBAL_DELIVERY_EXCLUSIONS: readonly string[] = [
  "12-24",
  "12-25",
  "12-31",
  "01-01",
];

/**
 * US federal holiday calendar for the v10 US-state delivery module (applied
 * only while deliveryEstimate.usStates is enabled with federalHolidays on).
 *
 * SCOPE — the calendar splits in two. The FIXED dates below are deliberately
 * identical to the US row of DELIVERY_HOLIDAYS (Dec 25 and Jan 1 are omitted
 * because the global exclusions above already cover them) but the two lists
 * stay independent — never reference one from the other. The six MOVABLE
 * nth-weekday holidays are computed by usFederalMovable(): the v5.9 "no
 * movable feasts" rule stands for the 25-country table, but nth-weekday-of-
 * month is exact calendar arithmetic, not an approximation, so the US module
 * may compute these safely.
 *
 * MIRRORING — this calendar (data + computation) is mirrored in FOUR places
 * the validation harness byte-/behavior-compares: the ES5 twins
 * `deliveryUsFederal` in cellexia-pdp.js and cellexia-cart.js, and the
 * `usFederalMovable` helper in extensions/checkout-delivery/src/delivery-engine.ts
 * plus its byte-identical copy in extensions/checkout-trust/src/
 * delivery-engine.ts. Change one, change all.
 */
/** Fixed-date US federal holidays not already globally excluded. MM-DD. */
export const US_FEDERAL_FIXED = ["06-19", "07-04", "11-11"];
/** Movable federal holidays as [month(1-12), weekday(ISO 1-7), ordinal] — ordinal 5 = last. */
export const US_FEDERAL_RULES: Array<[number, number, number]> = [
  [1, 1, 3], // MLK — 3rd Monday of January
  [2, 1, 3], // Presidents' Day — 3rd Monday of February
  [5, 1, 5], // Memorial Day — LAST Monday of May
  [9, 1, 1], // Labor Day — 1st Monday of September
  [10, 1, 2], // Columbus / Indigenous Peoples' Day — 2nd Monday of October
  [11, 4, 4], // Thanksgiving — 4th Thursday of November
];

/**
 * The six movable US federal holidays of `year` as "YYYY-MM-DD" strings, in
 * US_FEDERAL_RULES order. Pure UTC calendar math (Date.UTC + getUTC* only —
 * no Intl, no timezone: an nth-weekday-of-month date is the same in every
 * zone).
 */
export function usFederalMovable(year: number): string[] {
  const dates: string[] = [];
  for (const [month, weekday, ordinal] of US_FEDERAL_RULES) {
    // ISO weekday (1=Mon .. 7=Sun) of the 1st of the month.
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay() || 7;
    let day = 1 + ((weekday - first + 7) % 7) + (ordinal - 1) * 7;
    // Ordinal 5 = "last": only there can `day` overflow the month; step back
    // a week until it fits (day 0 of the next month = this month's length).
    const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
    while (day > monthDays) day -= 7;
    const mm = month < 10 ? `0${month}` : `${month}`;
    const dd = day < 10 ? `0${day}` : `${day}`;
    dates.push(`${year}-${mm}-${dd}`);
  }
  return dates;
}
