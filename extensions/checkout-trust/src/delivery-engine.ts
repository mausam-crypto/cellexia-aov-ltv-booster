/**
 * Cellexia AOV & LTV Booster — checkout delivery engine (v6.0).
 *
 * PURE TypeScript module: no extension imports, no React, no globals — every
 * function takes `now: Date` as a parameter so the sim can drive it with
 * injected fixtures and REAL Intl (including DST-transition scenarios the
 * stubbed storefront sims cannot see).
 *
 * This is the checkout twin of the v5.9.1 storefront engine in
 * extensions/cellexia-booster/assets/cellexia-pdp.js (deliveryConfig /
 * deliveryDispatchUt / deliveryQualifies / deliveryAdvance /
 * deliveryCompute). The DATE MATH MUST NEVER FORK from that file:
 *
 *  - Dispatch day (DST-SAFE, v5.9.1): Intl is consulted ONCE — for today's
 *    calendar date and wall clock in the WAREHOUSE timezone; every
 *    subsequent day is a pure UTC-midnight calendar stamp (+86400000 ms,
 *    ISO weekday via getUTCDay). A fixed +24h probe re-formatted through a
 *    warehouse DST transition can re-land on (25h day) or skip (23h day) a
 *    calendar day, which could show a dispatch date after the cutoff had
 *    passed — pure calendar stamps are DST-immune by construction.
 *    The Intl h24 "24:xx" midnight quirk is normalized (`hour % 24`).
 *    14-day dispatch scan cap.
 *  - Business-day advance in the DESTINATION country: a day qualifies only
 *    when its ISO weekday is in deliveryDays, it is not one of the four
 *    GLOBAL exclusions (Dec 24, Dec 25, Dec 31, Jan 1 — always applied, not
 *    configurable) and, when holidaysEnabled, it is not a known fixed-date
 *    public holiday of the destination country. minDays 0 = the dispatch
 *    day itself when it qualifies, else the next qualifying day. 60-day
 *    delivery scan cap.
 *  - v10 US state layer: when deliveryEstimate.usStates is enabled and the
 *    destination is US, the CALLER-supplied typed shipping state overlays
 *    the US-wide promise (per-state window/weekdays/holidays plus a
 *    PARTIAL dispatch cutoff/days override — timezone always inherited),
 *    and the config gains merchant extra days off (`extra`) and the six
 *    movable US federal holidays (`usFederal`, computed per candidate day
 *    by usFederalMovable — the twin of deliveryUsFederal in
 *    cellexia-pdp.js / cellexia-cart.js).
 *  - FAIL CLOSED for dates: every function returns null on ANY
 *    inconsistency — invalid/missing config, unresolvable dispatch day,
 *    scan-cap hit, any Intl/Date throw. Never show a delivery date we
 *    cannot stand behind. The v10 STATE LAYER alone fails OPEN instead: a
 *    state entry that cannot be applied degrades to the validated US-wide
 *    promise (only an explicit `hidden: true` state entry hides).
 */

/**
 * Always-excluded delivery dates ("MM-DD"), applied to EVERY country
 * regardless of holidaysEnabled or byCountry overrides. Mirrors
 * GLOBAL_DELIVERY_EXCLUSIONS in app/services/delivery-holidays.server.ts.
 */
export const GLOBAL_DELIVERY_EXCLUSIONS: readonly string[] = [
  '12-24',
  '12-25',
  '12-31',
  '01-01',
];

/**
 * Fixed-date national public holidays by ISO2 country (25 countries).
 * EXACT copy of the canonical table in
 * app/services/delivery-holidays.server.ts (which is itself harness
 * parity-checked against the ES5 mirror in cellexia-pdp.js). Movable feasts
 * (Easter, Thanksgiving, Islamic holidays, …) are DELIBERATELY excluded —
 * a wrong "guaranteed by" date is worse than a slightly pessimistic one.
 * The v6.0 sim byte-compares this copy against the canonical file.
 */
export const DELIVERY_HOLIDAYS: Record<string, string[]> = {
  US: ['06-19', '07-04', '11-11'],
  CA: ['07-01', '12-26'],
  GB: ['12-26'],
  IE: ['03-17', '12-26'],
  FR: ['05-01', '05-08', '07-14', '08-15', '11-01', '11-11'],
  DE: ['05-01', '10-03', '12-26'],
  AT: ['01-06', '05-01', '08-15', '10-26', '11-01', '12-08', '12-26'],
  CH: ['08-01'],
  IT: ['01-06', '04-25', '05-01', '06-02', '08-15', '11-01', '12-08', '12-26'],
  ES: ['01-06', '05-01', '08-15', '10-12', '11-01', '12-06', '12-08'],
  PT: ['04-25', '05-01', '06-10', '08-15', '10-05', '11-01', '12-01', '12-08'],
  NL: ['04-27', '12-26'],
  BE: ['05-01', '07-21', '08-15', '11-01', '11-11'],
  SE: ['01-06', '05-01', '06-06', '12-26'],
  NO: ['05-01', '05-17', '12-26'],
  DK: ['12-26'],
  FI: ['01-06', '05-01', '12-06', '12-26'],
  PL: ['01-06', '05-01', '05-03', '08-15', '11-01', '11-11', '12-26'],
  GR: ['01-06', '03-25', '05-01', '10-28', '12-26'],
  CZ: ['05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-26'],
  HU: ['03-15', '05-01', '08-20', '10-23', '11-01', '12-26'],
  RO: ['01-24', '05-01', '06-01', '08-15', '11-30', '12-01'],
  JP: ['02-11', '02-23', '04-29', '05-03', '05-04', '05-05', '08-11', '11-03', '11-23'],
  AU: ['01-26', '04-25', '12-26'],
  NZ: ['02-06', '04-25', '12-26'],
};

/**
 * Movable US federal holidays as [month 1-12, ISO weekday 1-7, ordinal] —
 * ordinal 5 = the LAST occurrence in the month. Mirrors US_FEDERAL_RULES in
 * app/services/delivery-holidays.server.ts (v10). Independent of the tables
 * above: the fixed-date federal holidays are already the US entry of
 * DELIVERY_HOLIDAYS, so with usStates.federalHolidays on the net addition
 * is exactly these six rules — applied only when
 * ResolvedDeliveryConfig.usFederal is true (see deliveryQualifies).
 */
export const US_FEDERAL_RULES: ReadonlyArray<[number, number, number]> = [
  [1, 1, 3], // MLK Day — 3rd Monday of January
  [2, 1, 3], // Presidents' Day — 3rd Monday of February
  [5, 1, 5], // Memorial Day — LAST Monday of May
  [9, 1, 1], // Labor Day — 1st Monday of September
  [10, 1, 2], // Columbus / Indigenous Peoples' Day — 2nd Monday of October
  [11, 4, 4], // Thanksgiving — 4th Thursday of November
];

/** Intl short-weekday → ISO weekday (1=Mon .. 7=Sun); twin of DISPATCH_ISO. */
const WEEKDAY_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const DAY_MS = 86400000;

/** Fully resolved + validated delivery config (byCountry already applied). */
export interface ResolvedDeliveryConfig {
  /** Business days until the earliest delivery (0 = dispatch day possible). */
  minDays: number;
  /** Business days until the guaranteed latest delivery. */
  maxDays: number;
  /** ISO weekdays deliveries occur in the destination country (1=Mon..7=Sun). */
  deliveryDays: number[];
  /** Skip the destination country's fixed-date public holidays. */
  holidaysEnabled: boolean;
  /** Destination ISO2 country code (uppercase). */
  country: string;
  /** Warehouse cutoff as minutes-of-day in the warehouse timezone. */
  cutoffMinutes: number;
  /** Warehouse IANA timezone. */
  timezone: string;
  /** ISO weekdays orders are dispatched. */
  dispatchDays: number[];
  /**
   * v10: merchant extra days off — usStates.extraHolidays plus the adopted
   * state entry's, each "MM-DD" (every year) or "YYYY-MM-DD" (one-off).
   * Present only when the usStates module applied (may be empty).
   */
  extra?: string[];
  /**
   * v10: exclude the six movable US federal holidays
   * (usStates.federalHolidays not false AND the resolved holidaysEnabled).
   * deliveryQualifies computes them per candidate day via usFederalMovable.
   */
  usFederal?: boolean;
}

/** UTC-midnight calendar stamps (ms) for dispatch / earliest / guaranteed. */
export interface DeliveryResult {
  dispatch: number;
  min: number;
  max: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Non-empty list of ISO weekdays (1=Mon..7=Sun) — the v10 state-entry gate. */
function isWeekdayList(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const day of value) {
    if (!isIntInRange(day, 1, 7)) return false;
  }
  return true;
}

/** v10 merchant extra day off: "MM-DD" (every year) or "YYYY-MM-DD" (one-off). */
const EXTRA_DATE_RE = /^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Resolves + validates the delivery config for one destination country from
 * the raw `$app:cellexia` config root, FAIL CLOSED (null on anything off).
 *
 * Twin of the storefront resolver split across pdp-booster.liquid (country
 * pick, dispatch byCountry wholesale override, Liquid `default:` filters)
 * and deliveryConfig() in cellexia-pdp.js (validation + delivery byCountry
 * partial override + hidden gate):
 *
 *  - `countryCode` must be a two-letter code — the CALLER supplies the
 *    buyer's shipping country; this module NEVER guesses one.
 *  - dispatch schedule: cfg.dispatch.byCountry[COUNTRY] overrides
 *    cutoff/timezone/days WHOLESALE when present (sanitizeSettings
 *    guarantees complete entries; incomplete ones fail validation below).
 *    Base cutoff/timezone get the same '14:00' / 'Europe/Paris' fallbacks
 *    Liquid's `default:` filter applies (missing/empty only — malformed
 *    values still fail closed); `days` has no default, exactly like Liquid.
 *  - delivery byCountry entry is a PARTIAL override (only what it sets);
 *    `hidden: true` → null (never render for that country).
 *  - Validation identical to the ES5 twin: ints in range, max ≥ min AFTER
 *    the override merge (an override maxDays below the inherited minDays
 *    fails closed instead of being rewritten), non-empty ISO weekday list,
 *    boolean holidaysEnabled, HH:MM cutoff, non-empty timezone + dispatch
 *    days. (The ES5 twin also requires its translation strings here; in
 *    checkout the strings live in this extension's own locale files, so
 *    that check belongs to the component, not the engine.)
 *  - v10 US state layer (fail OPEN, the one deliberate contrast): when the
 *    country is US, deliveryEstimate.usStates.enabled === true and the
 *    CALLER-supplied `provinceCode` is a two-letter code (the TYPED
 *    shipping state — never guessed, exactly like the country; anything
 *    else keeps the US-wide promise), the byState entry overlays the
 *    validated US-wide values: per-field keep-if-valid CANDIDATE merge of
 *    minDays/maxDays/deliveryDays/holidaysEnabled plus a PARTIAL dispatch
 *    override (cutoff/dispatchDays only — timezone always inherited, one
 *    physical warehouse). A candidate violating max ≥ min discards the
 *    WHOLE entry (US-wide values stay); `hidden: true` → null is the one
 *    deliberate per-state hide. The module also attaches `extra`
 *    (usStates.extraHolidays + the adopted entry's, regex-validated) and
 *    `usFederal` (federalHolidays not false AND the resolved
 *    holidaysEnabled) for deliveryQualifies.
 */
export function resolveDeliveryConfig(
  root: unknown,
  countryCode: unknown,
  provinceCode?: unknown,
): ResolvedDeliveryConfig | null {
  if (!isPlainObject(root)) return null;
  if (typeof countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(countryCode)) {
    return null; // no/invalid buyer country: never guess, never render
  }
  const country = countryCode.toUpperCase();

  const d = root.deliveryEstimate;
  if (!isPlainObject(d)) return null;

  let min: unknown = d.minDays;
  let max: unknown = d.maxDays;
  let days: unknown = d.deliveryDays;
  let hol: unknown = d.holidaysEnabled;
  const byCountry = isPlainObject(d.byCountry) ? d.byCountry : {};
  const o = byCountry[country];
  if (isPlainObject(o)) {
    if (o.hidden === true) return null; // country hidden: never render
    if (typeof o.minDays === 'number') min = o.minDays;
    if (typeof o.maxDays === 'number') max = o.maxDays;
    if (Array.isArray(o.deliveryDays)) days = o.deliveryDays;
    if (typeof o.holidaysEnabled === 'boolean') hol = o.holidaysEnabled;
  }
  if (!isIntInRange(min, 0, 30)) return null;
  if (!isIntInRange(max, 1, 30)) return null;
  if (max < min) return null;
  if (!Array.isArray(days) || days.length === 0) return null;
  for (const day of days) {
    if (!isIntInRange(day, 1, 7)) return null;
  }
  if (hol !== true && hol !== false) return null;

  const dispatch = root.dispatch;
  if (!isPlainObject(dispatch)) return null;
  // Liquid-parity defaults: `| default:` fires on nil/empty only.
  let cutoff: unknown =
    typeof dispatch.cutoff === 'string' && dispatch.cutoff !== ''
      ? dispatch.cutoff
      : '14:00';
  let timezone: unknown =
    typeof dispatch.timezone === 'string' && dispatch.timezone !== ''
      ? dispatch.timezone
      : 'Europe/Paris';
  let dispatchDays: unknown = dispatch.days;
  const dispatchByCountry = isPlainObject(dispatch.byCountry)
    ? dispatch.byCountry
    : {};
  const dispatchOverride = dispatchByCountry[country];
  if (isPlainObject(dispatchOverride)) {
    // Wholesale override, raw values — exactly like the Liquid assigns.
    cutoff = dispatchOverride.cutoff;
    timezone = dispatchOverride.timezone;
    dispatchDays = dispatchOverride.days;
  }
  if (typeof cutoff !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) {
    return null;
  }
  if (typeof timezone !== 'string' || !timezone) return null;
  if (!Array.isArray(dispatchDays) || dispatchDays.length === 0) return null;

  // The fully validated US-wide config — the v10 state layer below overlays
  // THESE values (never the raw config), so a discarded entry degrades to
  // exactly what every other buyer sees.
  const resolved: ResolvedDeliveryConfig = {
    minDays: min,
    maxDays: max,
    deliveryDays: days.slice() as number[],
    holidaysEnabled: hol,
    country,
    cutoffMinutes:
      Number(cutoff.slice(0, 2)) * 60 + Number(cutoff.slice(3, 5)),
    timezone,
    dispatchDays: dispatchDays.slice() as number[],
  };

  // v10 US state layer — fail OPEN, in deliberate contrast with everything
  // above: a malformed provinceCode, an unknown state, an invalid field or
  // a candidate merge violating max ≥ min all keep the validated US-wide
  // values (the state module must never hide or corrupt the country
  // promise). The ONE deliberate hide is an explicit `hidden: true` entry.
  const usStates = d.usStates;
  if (country === 'US' && isPlainObject(usStates) && usStates.enabled === true) {
    const stateCode =
      typeof provinceCode === 'string' && /^[A-Za-z]{2}$/.test(provinceCode)
        ? provinceCode.toUpperCase()
        : null;
    const byState = isPlainObject(usStates.byState) ? usStates.byState : {};
    const so = stateCode !== null ? byState[stateCode] : undefined;
    let stateExtraHolidays: unknown;
    if (isPlainObject(so)) {
      if (so.hidden === true) return null; // state hidden: never render
      // Per-field keep-if-valid CANDIDATE (the country override above
      // validates AFTER its merge and fails closed; the state layer
      // validates BEFORE so an invalid field degrades instead of hiding).
      const cMin = isIntInRange(so.minDays, 0, 30) ? so.minDays : resolved.minDays;
      const cMax = isIntInRange(so.maxDays, 1, 30) ? so.maxDays : resolved.maxDays;
      const cDays = isWeekdayList(so.deliveryDays)
        ? so.deliveryDays.slice()
        : resolved.deliveryDays;
      const cHol =
        typeof so.holidaysEnabled === 'boolean'
          ? so.holidaysEnabled
          : resolved.holidaysEnabled;
      const cCutoffMinutes =
        typeof so.cutoff === 'string' &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(so.cutoff)
          ? Number(so.cutoff.slice(0, 2)) * 60 + Number(so.cutoff.slice(3, 5))
          : resolved.cutoffMinutes;
      const cDispatchDays = isWeekdayList(so.dispatchDays)
        ? so.dispatchDays.slice()
        : resolved.dispatchDays;
      if (cMax >= cMin) {
        // Adopt the WHOLE entry (extras included) — or none of it.
        resolved.minDays = cMin;
        resolved.maxDays = cMax;
        resolved.deliveryDays = cDays;
        resolved.holidaysEnabled = cHol;
        resolved.cutoffMinutes = cCutoffMinutes;
        resolved.dispatchDays = cDispatchDays;
        stateExtraHolidays = so.extraHolidays;
      }
    }
    const extra: string[] = [];
    for (const list of [usStates.extraHolidays, stateExtraHolidays]) {
      if (!Array.isArray(list)) continue;
      for (const dateStr of list) {
        if (typeof dateStr === 'string' && EXTRA_DATE_RE.test(dateStr)) {
          extra.push(dateStr);
        }
      }
    }
    resolved.extra = extra;
    resolved.usFederal =
      usStates.federalHolidays !== false && resolved.holidaysEnabled;
  }
  return resolved;
}

/**
 * Next dispatch DATE as a UTC-midnight calendar stamp: today when `now` is
 * before the cutoff on a dispatch day in the WAREHOUSE timezone, else the
 * next dispatch day (14-day scan). Twin of deliveryDispatchUt in
 * cellexia-pdp.js — Intl consulted ONCE for day 0, pure UTC stamps after.
 */
export function deliveryDispatchUt(
  dc: ResolvedDeliveryConfig,
  now: Date,
): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: dc.timezone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const map: Record<string, string> = {};
    for (const part of parts) map[part.type] = part.value;
    if (!WEEKDAY_ISO[map.weekday]) return null; // malformed weekday parse
    const todayUt = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
    );
    if (!isFinite(todayUt)) return null;
    // h24 quirk: some ICU builds report midnight as "24:00".
    const nowMinutes = (Number(map.hour) % 24) * 60 + Number(map.minute);
    if (!(nowMinutes >= 0 && nowMinutes < 1440)) return null;
    for (let k = 0; k <= 14; k++) {
      const ut = todayUt + k * DAY_MS;
      const iso = ((new Date(ut).getUTCDay() + 6) % 7) + 1;
      if (dc.dispatchDays.indexOf(iso) === -1) continue; // not a dispatch day
      if (k === 0 && nowMinutes >= dc.cutoffMinutes) continue; // cutoff passed
      return ut;
    }
    return null; // no dispatch day within 14 days: hidden
  } catch {
    return null; // Intl rejected the timezone: hidden, never fake a date
  }
}

/**
 * The six movable US federal holidays of `year` as "YYYY-MM-DD" strings —
 * pure UTC calendar math over US_FEDERAL_RULES, no Intl. Twin of
 * usFederalMovable in app/services/delivery-holidays.server.ts and of
 * deliveryUsFederal in cellexia-pdp.js / cellexia-cart.js (the v10 4-way
 * behavioral parity set).
 */
export function usFederalMovable(year: number): string[] {
  const out: string[] = [];
  for (const [month, weekday, ordinal] of US_FEDERAL_RULES) {
    let day: number;
    if (ordinal === 5) {
      // LAST occurrence: walk back from the month's final day.
      const last = new Date(Date.UTC(year, month, 0));
      const iso = ((last.getUTCDay() + 6) % 7) + 1;
      day = last.getUTCDate() - ((iso - weekday + 7) % 7);
    } else {
      // Nth occurrence: forward from the 1st to the first hit, then weeks.
      const first = new Date(Date.UTC(year, month - 1, 1));
      const iso = ((first.getUTCDay() + 6) % 7) + 1;
      day = 1 + ((weekday - iso + 7) % 7) + (ordinal - 1) * 7;
    }
    out.push(
      year +
        '-' +
        (month < 10 ? '0' + month : '' + month) +
        '-' +
        (day < 10 ? '0' + day : '' + day),
    );
  }
  return out;
}

/**
 * Whether the UTC-midnight stamp is a qualifying delivery day in the
 * destination country. Pure calendar math — no timezone involved. v10: the
 * `extra` merchant days off match on "MM-DD" (every year) or the full
 * "YYYY-MM-DD" (one-off); `usFederal` additionally excludes the six
 * movable US federal holidays of the day's own UTC year (the fixed-date
 * federal holidays are already the US entry of DELIVERY_HOLIDAYS). Twin of
 * deliveryQualifies in cellexia-pdp.js.
 */
export function deliveryQualifies(
  ut: number,
  dc: ResolvedDeliveryConfig,
): boolean {
  const date = new Date(ut);
  const iso = ((date.getUTCDay() + 6) % 7) + 1;
  if (dc.deliveryDays.indexOf(iso) === -1) return false; // no delivery weekday
  const m = date.getUTCMonth() + 1;
  const dd = date.getUTCDate();
  const mmdd =
    (m < 10 ? '0' + m : '' + m) + '-' + (dd < 10 ? '0' + dd : '' + dd);
  if (GLOBAL_DELIVERY_EXCLUSIONS.indexOf(mmdd) !== -1) return false;
  if (dc.holidaysEnabled) {
    const table = DELIVERY_HOLIDAYS[dc.country];
    if (table && table.indexOf(mmdd) !== -1) return false; // public holiday
  }
  const full = date.getUTCFullYear() + '-' + mmdd;
  if (
    dc.extra &&
    (dc.extra.indexOf(mmdd) !== -1 || dc.extra.indexOf(full) !== -1)
  ) {
    return false; // v10 merchant extra day off (recurring or one-off form)
  }
  if (
    dc.usFederal === true &&
    usFederalMovable(date.getUTCFullYear()).indexOf(full) !== -1
  ) {
    return false; // v10 movable US federal holiday
  }
  return true;
}

/**
 * Advance n qualifying delivery days from the dispatch date (day 0).
 * n === 0: the dispatch day itself when it qualifies, else the next
 * qualifying day. Scan capped at 60 calendar days → null (hidden). Twin of
 * deliveryAdvance in cellexia-pdp.js.
 */
export function deliveryAdvance(
  startUt: number,
  n: number,
  dc: ResolvedDeliveryConfig,
): number | null {
  let count = 0;
  for (let i = 0; i <= 60; i++) {
    const ut = startUt + i * DAY_MS;
    if (i === 0 && n > 0) continue; // dispatch day is day zero, not transit
    if (!deliveryQualifies(ut, dc)) continue;
    if (n === 0) return ut;
    count++;
    if (count === n) return ut;
  }
  return null; // 60-day scan cap exceeded: hidden
}

/**
 * Full computation: dispatch stamp + earliest/guaranteed delivery stamps.
 * Null (fail closed) whenever any leg is unresolvable or inconsistent.
 * Twin of deliveryCompute in cellexia-pdp.js.
 */
export function computeDelivery(
  dc: ResolvedDeliveryConfig,
  now: Date,
): DeliveryResult | null {
  const dispatchUt = deliveryDispatchUt(dc, now);
  if (dispatchUt === null) return null;
  const minUt = deliveryAdvance(dispatchUt, dc.minDays, dc);
  const maxUt = deliveryAdvance(dispatchUt, dc.maxDays, dc);
  if (minUt === null || maxUt === null || maxUt < minUt) return null;
  return { dispatch: dispatchUt, min: minUt, max: maxUt };
}

/**
 * v6.0.1 DATE_STYLE — full native date in the CHECKOUT's page language,
 * never the browser locale. Pure twin of deliveryFormatDate in
 * cellexia-pdp.js / cellexia-cart.js (the v601-date-fixtures.json contract):
 *
 *  - base language "ja": { month: 'long', day: 'numeric', weekday: 'short' }
 *    → 7月25日(土) (Japanese e-commerce convention);
 *  - EVERY other base language (known or unknown):
 *    { weekday: 'long', day: 'numeric', month: 'long' } — the locale string
 *    is passed to Intl VERBATIM ("pt-PT" stays "pt-PT") so Intl owns each
 *    language's native order, punctuation, casing, script and digits (ar
 *    keeps its own digits — never forced to Latin).
 *
 * Fallback chain: page-locale long form -> pre-v6.0.1 short browser form
 * (missing locale or Intl rejecting the tag) -> '' ONLY when formatting
 * itself throws (fail closed: hide, never mislabel a date). The UTC
 * calendar stamp is rebuilt as a LOCAL noon Date so formatting can never
 * shift the calendar day, whatever the buyer's UTC offset (unchanged house
 * convention). Kept here (pure module) instead of Checkout.tsx so the sim
 * can assert its output equals the fixtures file with real Intl.
 */
export function deliveryFormatDate(ut: number, locale: string): string {
  const d = new Date(ut);
  const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  const base =
    typeof locale === 'string' && locale
      ? locale.split('-')[0].toLowerCase()
      : '';
  if (base) {
    try {
      const options: Intl.DateTimeFormatOptions =
        base === 'ja'
          ? {month: 'long', day: 'numeric', weekday: 'short'}
          : {weekday: 'long', day: 'numeric', month: 'long'};
      let label = local.toLocaleDateString(locale, options);
      // v6.0.2: careful French writes the first of a month as an ordinal
      // ("vendredi 1er mai") — CLDR emits the cardinal "1".
      if (base === 'fr' && d.getUTCDate() === 1 && typeof label === 'string') {
        label = label.replace(/\b1\b/, '1er');
      }
      if (typeof label === 'string' && label) return label;
    } catch {
      // Intl rejected the locale tag: fall through to the short form
    }
  }
  try {
    const fallback = local.toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
    return typeof fallback === 'string' && fallback ? fallback : '';
  } catch {
    return ''; // formatting itself threw: hidden, never a wrong date
  }
}
