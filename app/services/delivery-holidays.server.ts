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
