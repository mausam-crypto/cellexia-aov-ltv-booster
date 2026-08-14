import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useSubmit,
} from "@remix-run/react";
import type { ShouldRevalidateFunctionArgs } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  Collapsible,
  Divider,
  InlineStack,
  Layout,
  Page,
  RadioButton,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getSettings,
  resolveFeatureFlag,
  saveSettings,
  validateExcludedByMarketPatch,
  type BoosterSettings,
  type DeepPartial,
  type DeliveryCountryOverride,
  type DeliveryStateOverride,
} from "../models/settings.server";
import {
  DELIVERY_HOLIDAYS,
  GLOBAL_DELIVERY_EXCLUSIONS,
  US_FEDERAL_FIXED,
  usFederalMovable,
} from "../services/delivery-holidays.server";
import {
  buildGeoStateDb,
  GEO_ATTRIBUTION,
  getGeoStatus,
  lookupUsState,
} from "../services/geo.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { listMarkets } from "../services/markets.server";
import { getProductTitlesByIds } from "../services/products.server";
import { listProductsWithBoosterStatus } from "../services/pdp-content.server";
import { FeaturePageHeader } from "../components/FeaturePageHeader";
import { MarketProductExclusionsCard } from "../components/MarketExclusions";

/**
 * Delivery estimate + delivery guarantee (v5.9) — feature settings page.
 *
 * Modeled on the dispatch countdown page: the same fail-loud validation
 * (invalid input is refused with an error, never silently "fixed"), the same
 * wholesale byCountry save semantics, and the same credibility stance — the
 * storefront widget NEVER shows a date it cannot stand behind; any
 * inconsistency fails closed to hidden.
 *
 * v10 adds the optional United States state module (deliveryEstimate.usStates
 * — no FeatureKey of its own): per-state overrides, US-wide extra days off,
 * the movable federal holidays, and the self-hosted IP→state database card.
 * The STATE layer fails OPEN, deliberately unlike everything above: a state
 * entry that resolves inconsistently is IGNORED and the buyer keeps the
 * US-wide promise — a state problem must never hide the widget.
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/** "Download & build" / "Test lookup" responses (geoIntent posts). They ride
 *  the same {ok, syncErrors} envelope so the shared toast/Banner contract
 *  holds; the geo card renders them and the save toast skips them. */
type GeoActionResult =
  | { intent: "build" }
  | { intent: "test"; ip: string; state: string | null; error?: string };

interface SettingsSaveResult {
  ok: boolean;
  syncErrors: string[];
  geo?: GeoActionResult;
}

/** v12: the exclusion card's product-search response (the ProofForms picker
 *  shape — the card's fetcher posts to the CURRENT route). Named here only
 *  because this action, unlike dispatch's, annotates its return type. */
interface ProductSearchResult {
  intent: "search_products";
  ok: boolean;
  errors: string[];
  products: {
    gid: string;
    title: string;
    imageUrl: string | null;
    status: string;
  }[];
}

// ---------------------------------------------------------------------------
// Shared validation shapes (mirrored client-side for instant feedback)
// ---------------------------------------------------------------------------

const ISO2_PATTERN = /^[A-Z]{2}$/;

/** Mirrors the dispatch sanitizer in settings.server.ts. */
const CUTOFF_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Extra day off: "MM-DD" (repeats every year) or "YYYY-MM-DD" (one-off).
 *  Mirrors the usStates sanitizer in settings.server.ts. */
const EXTRA_DATE_PATTERN = /^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Extra-days-off count caps — mirror the sanitizer's slice limits in
 *  settings.server.ts: the settings blob rides two json metafields capped at
 *  65,536 chars on ApiVersion.October25, and 60 US-wide + 40 per state keeps
 *  the worst-case blob near ~47 KB. Validation here fails LOUD; the
 *  sanitizer's slice only backstops payloads that bypass this form. */
const US_EXTRA_DATES_MAX = 60;
const STATE_EXTRA_DATES_MAX = 40;

/**
 * The four widget formats (client-safe literal mirror of the server-only
 * DELIVERY_ESTIMATE_FORMATS enum — the settings sanitizer is the
 * authoritative whitelist). All four compute the SAME dates and carry the
 * same guarantee badge; they differ only in presentation mechanism.
 */
const DELIVERY_FORMATS = [
  {
    value: "line",
    label: "One line",
    description:
      "Box icon + “Get it by Thu, Aug 6” + the guarantee badge. Pairs tightest with the dispatch countdown.",
  },
  {
    value: "range",
    label: "Date range",
    description:
      "“Estimated delivery: Tue, Aug 4 – Thu, Aug 6” + badge. Honest span instead of a single promise date.",
  },
  {
    value: "timeline",
    label: "3-step timeline",
    description:
      "Order today → Ships → Delivered by, as connected steps. The most persuasive format: it makes the whole journey concrete.",
  },
  {
    value: "box",
    label: "Guarantee box",
    description:
      "A hairline-bordered card leading with the guarantee itself: “Guaranteed delivery by …” + the refund-or-replacement subline.",
  },
] as const;
type DeliveryFormatValue = (typeof DELIVERY_FORMATS)[number]["value"];

function toFormatValue(value: string): DeliveryFormatValue {
  return DELIVERY_FORMATS.some((format) => format.value === value)
    ? (value as DeliveryFormatValue)
    : "line";
}

/** Compact Select options for the cart/checkout surface format pickers. */
const FORMAT_SELECT_OPTIONS = DELIVERY_FORMATS.map((format) => ({
  label: format.label,
  value: format.value,
}));

function formatDescription(value: DeliveryFormatValue): string {
  return (
    DELIVERY_FORMATS.find((format) => format.value === value)?.description ?? ""
  );
}

function isValidDaysArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
  );
}

function isIntInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/**
 * Fail-loud guard for the deliveryEstimate section of an incoming patch. The
 * generic sanitizer falls back to defaults (or drops byCountry fields)
 * silently; a merchant typing "45" business days must get an error instead
 * of a quietly rewritten window.
 */
function validateDeliveryPatch(patch: DeepPartial<BoosterSettings>): string[] {
  const errors: string[] = [];
  const delivery = patch.deliveryEstimate;
  if (delivery === undefined || delivery === null) return errors;
  if (typeof delivery !== "object" || Array.isArray(delivery)) {
    return ["The delivery settings payload must be an object."];
  }
  if (delivery.minDays !== undefined && !isIntInRange(delivery.minDays, 0, 30)) {
    errors.push(
      "Minimum delivery time must be a whole number of business days from 0 to 30.",
    );
  }
  if (delivery.maxDays !== undefined && !isIntInRange(delivery.maxDays, 1, 30)) {
    errors.push(
      "Maximum delivery time must be a whole number of business days from 1 to 30.",
    );
  }
  if (
    isIntInRange(delivery.minDays, 0, 30) &&
    isIntInRange(delivery.maxDays, 1, 30) &&
    (delivery.maxDays as number) < Math.max(1, delivery.minDays as number)
  ) {
    errors.push(
      "Maximum delivery time cannot be shorter than the minimum — the guarantee date must never precede the earliest estimate.",
    );
  }
  if (delivery.deliveryDays !== undefined && !isValidDaysArray(delivery.deliveryDays)) {
    errors.push("Pick at least one delivery weekday (Monday to Sunday).");
  }
  if (
    delivery.format !== undefined &&
    !DELIVERY_FORMATS.some((format) => format.value === delivery.format)
  ) {
    errors.push("Unknown widget format.");
  }
  if (
    delivery.formatCart !== undefined &&
    !DELIVERY_FORMATS.some((format) => format.value === delivery.formatCart)
  ) {
    errors.push("Unknown cart drawer widget format.");
  }
  if (
    delivery.formatCheckout !== undefined &&
    !DELIVERY_FORMATS.some(
      (format) => format.value === delivery.formatCheckout,
    )
  ) {
    errors.push("Unknown checkout widget format.");
  }
  if (delivery.showOnPdp !== undefined && typeof delivery.showOnPdp !== "boolean") {
    errors.push("The product-page surface switch is malformed.");
  }
  if (delivery.showInCart !== undefined && typeof delivery.showInCart !== "boolean") {
    errors.push("The cart drawer surface switch is malformed.");
  }
  if (
    delivery.showInCheckout !== undefined &&
    typeof delivery.showInCheckout !== "boolean"
  ) {
    errors.push("The checkout surface switch is malformed.");
  }
  if (delivery.byCountry !== undefined) {
    if (
      typeof delivery.byCountry !== "object" ||
      delivery.byCountry === null ||
      Array.isArray(delivery.byCountry)
    ) {
      errors.push("Country overrides must be a map of ISO country codes.");
    } else {
      for (const [code, entry] of Object.entries(delivery.byCountry)) {
        const upper = code.toUpperCase();
        const label = ISO2_PATTERN.test(upper) ? upper : code;
        if (!ISO2_PATTERN.test(upper)) {
          errors.push(
            `"${code}" is not a two-letter ISO country code (e.g. DE, US).`,
          );
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          errors.push(`The override for ${label} is malformed.`);
          continue;
        }
        const override = entry as DeliveryCountryOverride;
        if (
          override.minDays !== undefined &&
          !isIntInRange(override.minDays, 0, 30)
        ) {
          errors.push(
            `The minimum delivery time for ${label} must be 0–30 business days.`,
          );
        }
        if (
          override.maxDays !== undefined &&
          !isIntInRange(override.maxDays, 1, 30)
        ) {
          errors.push(
            `The maximum delivery time for ${label} must be 1–30 business days.`,
          );
        }
        if (
          isIntInRange(override.minDays, 0, 30) &&
          isIntInRange(override.maxDays, 1, 30) &&
          (override.maxDays as number) < Math.max(1, override.minDays as number)
        ) {
          errors.push(
            `The maximum delivery time for ${label} cannot be shorter than its minimum.`,
          );
        }
        if (
          override.deliveryDays !== undefined &&
          !isValidDaysArray(override.deliveryDays)
        ) {
          errors.push(`Pick at least one delivery weekday for ${label}.`);
        }
        if (
          override.holidaysEnabled !== undefined &&
          typeof override.holidaysEnabled !== "boolean"
        ) {
          errors.push(`The holiday setting for ${label} is malformed.`);
        }
        if (override.hidden !== undefined && typeof override.hidden !== "boolean") {
          errors.push(`The hide setting for ${label} is malformed.`);
        }
      }
    }
  }
  if (delivery.usStates !== undefined) {
    const us = delivery.usStates;
    if (typeof us !== "object" || us === null || Array.isArray(us)) {
      errors.push("The US state module payload must be an object.");
      return errors;
    }
    if (us.enabled !== undefined && typeof us.enabled !== "boolean") {
      errors.push("The US state module switch is malformed.");
    }
    if (us.selector !== undefined && typeof us.selector !== "boolean") {
      errors.push("The “Deliver to” selector switch is malformed.");
    }
    if (
      us.selectorPrompt !== undefined &&
      typeof us.selectorPrompt !== "boolean"
    ) {
      errors.push("The state-prompt switch is malformed.");
    }
    if (
      us.federalHolidays !== undefined &&
      typeof us.federalHolidays !== "boolean"
    ) {
      errors.push("The federal holidays switch is malformed.");
    }
    if (us.extraHolidays !== undefined) {
      if (!Array.isArray(us.extraHolidays)) {
        errors.push("US-wide extra days off must be a list of dates.");
      } else {
        if (us.extraHolidays.length > US_EXTRA_DATES_MAX) {
          errors.push(
            `US-wide extra days off can list at most ${US_EXTRA_DATES_MAX} dates.`,
          );
        }
        for (const day of us.extraHolidays) {
          if (typeof day !== "string" || !EXTRA_DATE_PATTERN.test(day)) {
            errors.push(
              `"${String(day)}" is not a valid US-wide extra day off — use MM-DD or YYYY-MM-DD.`,
            );
          }
        }
      }
    }
    if (us.byState !== undefined) {
      if (
        typeof us.byState !== "object" ||
        us.byState === null ||
        Array.isArray(us.byState)
      ) {
        errors.push("State overrides must be a map of USPS state codes.");
        return errors;
      }
      for (const [code, entry] of Object.entries(us.byState)) {
        const upper = code.toUpperCase();
        const label = US_STATE_OPTIONS[upper]
          ? `${US_STATE_OPTIONS[upper]} (${upper})`
          : ISO2_PATTERN.test(upper)
            ? upper
            : code;
        if (!ISO2_PATTERN.test(upper)) {
          errors.push(
            `"${code}" is not a two-letter USPS state code (e.g. CA, NY).`,
          );
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          errors.push(`The override for ${label} is malformed.`);
          continue;
        }
        const override = entry as DeliveryStateOverride;
        if (
          override.minDays !== undefined &&
          !isIntInRange(override.minDays, 0, 30)
        ) {
          errors.push(
            `The minimum delivery time for ${label} must be 0–30 business days.`,
          );
        }
        if (
          override.maxDays !== undefined &&
          !isIntInRange(override.maxDays, 1, 30)
        ) {
          errors.push(
            `The maximum delivery time for ${label} must be 1–30 business days.`,
          );
        }
        if (
          isIntInRange(override.minDays, 0, 30) &&
          isIntInRange(override.maxDays, 1, 30) &&
          (override.maxDays as number) < Math.max(1, override.minDays as number)
        ) {
          errors.push(
            `The maximum delivery time for ${label} cannot be shorter than its minimum.`,
          );
        }
        if (
          override.deliveryDays !== undefined &&
          !isValidDaysArray(override.deliveryDays)
        ) {
          errors.push(`Pick at least one delivery weekday for ${label}.`);
        }
        if (
          override.holidaysEnabled !== undefined &&
          typeof override.holidaysEnabled !== "boolean"
        ) {
          errors.push(`The holiday setting for ${label} is malformed.`);
        }
        if (override.hidden !== undefined && typeof override.hidden !== "boolean") {
          errors.push(`The hide setting for ${label} is malformed.`);
        }
        if (
          override.cutoff !== undefined &&
          (typeof override.cutoff !== "string" ||
            !CUTOFF_PATTERN.test(override.cutoff))
        ) {
          errors.push(
            `The dispatch cutoff for ${label} must be a 24-hour "HH:MM" time.`,
          );
        }
        if (
          override.dispatchDays !== undefined &&
          !isValidDaysArray(override.dispatchDays)
        ) {
          errors.push(`Pick at least one dispatch day for ${label}.`);
        }
        if (override.extraHolidays !== undefined) {
          if (!Array.isArray(override.extraHolidays)) {
            errors.push(`Extra days off for ${label} must be a list of dates.`);
          } else {
            if (override.extraHolidays.length > STATE_EXTRA_DATES_MAX) {
              errors.push(
                `Extra days off for ${label} can list at most ${STATE_EXTRA_DATES_MAX} dates.`,
              );
            }
            for (const day of override.extraHolidays) {
              if (typeof day !== "string" || !EXTRA_DATE_PATTERN.test(day)) {
                errors.push(
                  `"${String(day)}" is not a valid extra day off for ${label} — use MM-DD or YYYY-MM-DD.`,
                );
              }
            }
          }
        }
      }
    }
  }
  // v12: per-market product exclusions (fail-loud shape check — the shared
  // validator lives beside the sanitizer in settings.server.ts).
  errors.push(
    ...validateExcludedByMarketPatch(
      delivery.excludedByMarket,
      "Excluded products",
    ),
  );
  return errors;
}

async function applySettingsPatch(
  shop: string,
  admin: AdminGraphqlClient,
  rawPatch: FormDataEntryValue | null,
): Promise<SettingsSaveResult> {
  if (typeof rawPatch !== "string" || rawPatch.trim() === "") {
    return { ok: false, syncErrors: ["Missing settings payload."] };
  }
  let patch: DeepPartial<BoosterSettings>;
  try {
    const parsed: unknown = JSON.parse(rawPatch);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, syncErrors: ["Settings payload must be an object."] };
    }
    patch = parsed as DeepPartial<BoosterSettings>;
  } catch {
    return { ok: false, syncErrors: ["Settings payload was not valid JSON."] };
  }
  const deliveryErrors = validateDeliveryPatch(patch);
  if (deliveryErrors.length > 0) {
    return { ok: false, syncErrors: deliveryErrors };
  }
  const next = await saveSettings(shop, patch);
  try {
    const sync = await syncSettingsToMetafields(admin, next);
    return { ok: true, syncErrors: sync.errors };
  } catch (error) {
    return {
      ok: true,
      syncErrors: [
        error instanceof Error
          ? error.message
          : "Could not sync settings to storefront metafields.",
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Server-side live example — the SAME rules the storefront widget applies
// ---------------------------------------------------------------------------

const MS_DAY = 86400000;
const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function isoWeekdayUtc(ms: number): number {
  const weekday = new Date(ms).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function mmddUtc(ms: number): string {
  const date = new Date(ms);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Fixed-format date label (e.g. "Thu, Aug 6") — deterministic server-side
 *  string; buyers see the same date via their own locale on the storefront. */
function formatExampleDate(ms: number): string {
  const date = new Date(ms);
  return `${WEEKDAY_SHORT[date.getUTCDay()]}, ${MONTH_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** Current wall clock + calendar date in `timezone` (Intl.formatToParts —
 *  the same machinery as the storefront engine, incl. the h23 "24" quirk).
 *  Returns null on any inconsistency (fail closed). */
function zonedNow(
  timezone: string,
  now: Date,
): { dateMs: number; isoDay: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const map: Record<string, string> = {};
    for (const part of parts) map[part.type] = part.value;
    const isoDay = WEEKDAY_TO_ISO[map.weekday ?? ""];
    const year = Number(map.year);
    const month = Number(map.month);
    const day = Number(map.day);
    const hour = Number(map.hour) % 24;
    const minute = Number(map.minute);
    if (
      !isoDay ||
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      !Number.isInteger(day) ||
      !Number.isFinite(hour) ||
      !Number.isFinite(minute)
    ) {
      return null;
    }
    const dateMs = Date.UTC(year, month - 1, day);
    if (isoWeekdayUtc(dateMs) !== isoDay) return null;
    return { dateMs, isoDay, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

interface DeliveryExample {
  /** ISO2 code, "US-XX" for a US state (v10), or "" for "every other
   *  country" (defaults only). */
  code: string;
  ships: string | null;
  from: string | null;
  to: string | null;
  hiddenReason: string | null;
}

/** Month → movable-federal-holiday name (the six US_FEDERAL_RULES rows) —
 *  keyed by month so the helpText survives any ordering of
 *  usFederalMovable's output. */
const US_FEDERAL_MOVABLE_NAMES: Record<number, string> = {
  1: "Martin Luther King Jr. Day",
  2: "Presidents’ Day",
  5: "Memorial Day",
  9: "Labor Day",
  10: "Columbus / Indigenous Peoples’ Day",
  11: "Thanksgiving",
};

/**
 * Computes the example a buyer in `country` would see right now, with the
 * exact storefront rules: dispatch date from the dispatch schedule (incl.
 * its byCountry override), then business-day counting in the destination
 * country (deliveryDays + global exclusions + fixed-date holidays). With
 * `state` (v10), the US state layer is applied on top with the storefront's
 * fail-OPEN semantics — an entry that merges into an invalid window is
 * ignored and the US-wide values stay.
 */
function computeExample(
  settings: BoosterSettings,
  country: string,
  now: Date,
  state?: string,
): DeliveryExample {
  const code = state ? `${country}-${state}` : country;
  const hidden = (hiddenReason: string): DeliveryExample => ({
    code,
    ships: null,
    from: null,
    to: null,
    hiddenReason,
  });
  const de = settings.deliveryEstimate;
  const override: DeliveryCountryOverride = country
    ? (de.byCountry[country] ?? {})
    : {};
  if (override.hidden === true) {
    return hidden("hidden for this country by your override");
  }
  let minDays = override.minDays ?? de.minDays;
  let maxDays = override.maxDays ?? de.maxDays;
  let deliveryDays = override.deliveryDays ?? de.deliveryDays;
  let holidaysEnabled = override.holidaysEnabled ?? de.holidaysEnabled;
  if (
    !isIntInRange(minDays, 0, 30) ||
    !isIntInRange(maxDays, 1, 30) ||
    maxDays < Math.max(1, minDays) ||
    !isValidDaysArray(deliveryDays)
  ) {
    return hidden("the resolved delivery window is invalid — fails closed");
  }

  // v10 US state layer, applied AFTER the country resolution validated.
  // hidden hides deliberately; anything else fails OPEN: invalid fields are
  // skipped, and an entry whose merged window is impossible is discarded
  // WHOLE (extras, cutoff and dispatch days included) — the buyer keeps the
  // US-wide promise.
  const us = de.usStates;
  const usModule = country === "US" && us.enabled === true;
  let entry: DeliveryStateOverride =
    usModule && state ? (us.byState[state] ?? {}) : {};
  if (entry.hidden === true) {
    return hidden("hidden for this state by your override");
  }
  const entryMin = isIntInRange(entry.minDays, 0, 30) ? entry.minDays : undefined;
  const entryMax = isIntInRange(entry.maxDays, 1, 30) ? entry.maxDays : undefined;
  const candidateMin = entryMin ?? minDays;
  const candidateMax = entryMax ?? maxDays;
  if (candidateMax >= Math.max(1, candidateMin)) {
    minDays = candidateMin;
    maxDays = candidateMax;
    if (isValidDaysArray(entry.deliveryDays)) deliveryDays = entry.deliveryDays;
    if (typeof entry.holidaysEnabled === "boolean") {
      holidaysEnabled = entry.holidaysEnabled;
    }
  } else {
    entry = {};
  }

  // 1. Dispatch day, from the dispatch schedule (warehouse config — used
  //    even while the dispatch_countdown feature itself is off). A state
  //    entry overrides cutoff/dispatch days PARTIALLY; the warehouse
  //    timezone always inherits (one physical warehouse).
  const schedule =
    (country ? settings.dispatch.byCountry[country] : undefined) ??
    settings.dispatch;
  const cutoff =
    typeof entry.cutoff === "string" && CUTOFF_PATTERN.test(entry.cutoff)
      ? entry.cutoff
      : schedule.cutoff;
  const dispatchDays = isValidDaysArray(entry.dispatchDays)
    ? entry.dispatchDays
    : schedule.days;
  const zoned = zonedNow(schedule.timezone, now);
  if (!zoned) {
    return hidden(
      `the warehouse timezone ("${schedule.timezone}") cannot be resolved — fails closed`,
    );
  }
  const cutoffMinutes =
    Number(cutoff.slice(0, 2)) * 60 + Number(cutoff.slice(3, 5));
  let dispatchMs: number | null = null;
  if (
    dispatchDays.includes(zoned.isoDay) &&
    Number.isFinite(cutoffMinutes) &&
    zoned.minutes < cutoffMinutes
  ) {
    dispatchMs = zoned.dateMs;
  } else {
    for (let offset = 1; offset <= 14; offset += 1) {
      const candidate = zoned.dateMs + offset * MS_DAY;
      if (dispatchDays.includes(isoWeekdayUtc(candidate))) {
        dispatchMs = candidate;
        break;
      }
    }
  }
  if (dispatchMs === null) {
    return hidden("no dispatch day within 14 days — fails closed");
  }

  // 2. Delivery dates — count business days in the destination country.
  //    v10: merchant extra days off (module-wide + per-state) and the
  //    movable federal holidays ride the same extra/usFederal split the
  //    storefront and checkout engines use — module extras apply to EVERY
  //    US buyer while the module is on, state or not.
  const holidays =
    holidaysEnabled && country ? (DELIVERY_HOLIDAYS[country] ?? []) : [];
  const extra: string[] = [];
  if (usModule) {
    for (const day of us.extraHolidays) {
      if (EXTRA_DATE_PATTERN.test(day)) extra.push(day);
    }
    for (const day of entry.extraHolidays ?? []) {
      if (EXTRA_DATE_PATTERN.test(day)) extra.push(day);
    }
  }
  const usFederal = usModule && us.federalHolidays !== false && holidaysEnabled;
  const qualifies = (ms: number): boolean => {
    const mmdd = mmddUtc(ms);
    const full = `${new Date(ms).getUTCFullYear()}-${mmdd}`;
    return (
      deliveryDays.includes(isoWeekdayUtc(ms)) &&
      !GLOBAL_DELIVERY_EXCLUSIONS.includes(mmdd) &&
      !holidays.includes(mmdd) &&
      !extra.includes(mmdd) &&
      !extra.includes(full) &&
      !(
        usFederal &&
        (US_FEDERAL_FIXED.includes(mmdd) ||
          usFederalMovable(new Date(ms).getUTCFullYear()).includes(full))
      )
    );
  };
  const advance = (target: number): number | null => {
    let remaining = target;
    if (remaining === 0) {
      // minDays 0: delivery possible the dispatch day itself, but only if
      // that day qualifies; otherwise the next qualifying day.
      if (qualifies(dispatchMs as number)) return dispatchMs as number;
      remaining = 1;
    }
    let cursor = dispatchMs as number;
    let counted = 0;
    for (let steps = 1; steps <= 60; steps += 1) {
      cursor += MS_DAY;
      if (qualifies(cursor)) {
        counted += 1;
        if (counted >= remaining) return cursor;
      }
    }
    return null;
  };
  const minMs = advance(minDays);
  const maxMs = advance(maxDays);
  if (minMs === null || maxMs === null || maxMs < minMs) {
    return hidden("no qualifying delivery day within 60 days — fails closed");
  }
  return {
    code,
    ships: formatExampleDate(dispatchMs),
    from: formatExampleDate(minMs),
    to: formatExampleDate(maxMs),
    hiddenReason: null,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const [settings, markets, geo] = await Promise.all([
    getSettings(session.shop),
    listMarkets(admin),
    getGeoStatus(session.shop),
  ]);
  // v12: readable labels for the stored exclusion GIDs (fail-soft — a
  // failed lookup degrades the tags to "Product <id>", never the page).
  const exclusionTitles = await getProductTitlesByIds(
    admin,
    Object.values(settings.deliveryEstimate.excludedByMarket).flat(),
  ).catch(() => ({}) as Record<string, string>);
  const now = new Date();
  const usStates = settings.deliveryEstimate.usStates;
  const exampleCodes = [
    ...new Set([
      ...Object.keys(DELIVERY_HOLIDAYS),
      ...Object.keys(settings.deliveryEstimate.byCountry),
      ...Object.keys(settings.dispatch.byCountry),
      // v10: configured US states ride along as "US-XX" while the module is
      // on — the sorted union lands them right after "US".
      ...(usStates.enabled
        ? Object.keys(usStates.byState).map((code) => `US-${code}`)
        : []),
    ]),
  ].sort();
  // This year's movable federal dates for the checkbox helpText — computed
  // HERE so the render path never touches new Date().
  const usFederalYear = now.getUTCFullYear();
  const usFederalNote = usFederalMovable(usFederalYear)
    .map((date) => {
      const month = Number(date.slice(5, 7));
      const label = formatExampleDate(
        Date.UTC(
          Number(date.slice(0, 4)),
          month - 1,
          Number(date.slice(8, 10)),
        ),
      );
      return `${US_FEDERAL_MOVABLE_NAMES[month] ?? date} (${label})`;
    })
    .join(", ");
  // Geo card view-model (merged DB row + the in-progress build's live
  // counters — getGeoStatus owns the shape). Dates become fixed labels
  // HERE, never in render.
  const builtAt = geo.builtAt;
  return {
    settings,
    markets,
    exclusionTitles,
    headerEnabled: resolveFeatureFlag(settings, "delivery_estimate"),
    // Canonical holiday data, passed through the loader — the component must
    // never import the .server module directly.
    holidayTable: DELIVERY_HOLIDAYS,
    globalExclusions: [...GLOBAL_DELIVERY_EXCLUSIONS],
    usFederalYear,
    usFederalNote,
    geoAttribution: GEO_ATTRIBUTION,
    geoStatus: {
      status: geo.status,
      source: geo.source,
      builtAtLabel: builtAt
        ? `${MONTH_SHORT[builtAt.getUTCMonth()]} ${builtAt.getUTCDate()}, ${builtAt.getUTCFullYear()}`
        : null,
      rangesV4: geo.rangesV4,
      rangesV6: geo.rangesV6,
      error: geo.error,
      rowsScanned: geo.progress ? geo.progress.rowsScanned : null,
      usRowsKept: geo.progress ? geo.progress.usRowsKept : null,
    },
    // "Ordering right now" examples per country (and US state), computed
    // SERVER-SIDE with the exact storefront rules, from the SAVED settings.
    examples: [
      computeExample(settings, "", now),
      ...exampleCodes.map((code) =>
        code.startsWith("US-")
          ? computeExample(settings, "US", now, code.slice(3))
          : computeExample(settings, code, now),
      ),
    ],
  };
};

/**
 * v12: the exclusion card's product search rides a POST fetcher to this
 * route's action; Remix would revalidate the loader after it, and the
 * loader-data reset would wipe unsaved form edits (including the exclusion
 * row being built — review catch). Searches are read-only lookups: skip
 * revalidation for them, keep it for every real mutation.
 */
export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formData?.get("intent") === "search_products") return false;
  return defaultShouldRevalidate;
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<SettingsSaveResult | ProductSearchResult> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  // v12: the exclusion card's product search (the ProofForms picker
  // convention — the picker's fetcher posts to the CURRENT route).
  if (formData.get("intent") === "search_products") {
    const result = await listProductsWithBoosterStatus(
      admin,
      String(formData.get("q") ?? ""),
    );
    return {
      intent: "search_products" as const,
      ok: result.ok,
      errors: result.errors,
      products: result.products.map((product) => ({
        gid: product.id,
        title: product.title,
        imageUrl: product.imageUrl,
        status: product.status,
      })),
    };
  }
  // v10 geo intents branch BEFORE the settings-patch path — neither touches
  // settings.
  const geoIntent = formData.get("geoIntent");
  if (geoIntent === "build") {
    // Fire-and-forget: the build streams the whole DB-IP monthly CSV, so it
    // must outlive this response. Progress and failures land in the
    // GeoStateDb status row the geo card polls — never in this response.
    buildGeoStateDb(session.shop).catch(() => {});
    return { ok: true, syncErrors: [], geo: { intent: "build" } };
  }
  if (geoIntent === "test") {
    const rawIp = formData.get("ip");
    const ip = typeof rawIp === "string" ? rawIp.trim() : "";
    if (ip === "") {
      return {
        ok: true,
        syncErrors: [],
        geo: {
          intent: "test",
          ip,
          state: null,
          error: "Enter an IP address to test.",
        },
      };
    }
    try {
      const state = await lookupUsState(session.shop, ip);
      return { ok: true, syncErrors: [], geo: { intent: "test", ip, state } };
    } catch (error) {
      return {
        ok: true,
        syncErrors: [],
        geo: {
          intent: "test",
          ip,
          state: null,
          error:
            error instanceof Error ? error.message : "The lookup failed.",
        },
      };
    }
  }
  return applySettingsPatch(session.shop, admin, formData.get("patch"));
};

// ---------------------------------------------------------------------------
// Market targeting card (duplicated across feature pages on purpose — route
// modules do not share UI components)
// ---------------------------------------------------------------------------

interface ScopeState {
  mode: "all" | "selected";
  markets: string[];
}

function toScopeState(
  scope: { mode: "all" | "selected"; markets: string[] } | undefined,
): ScopeState {
  return scope && scope.mode === "selected"
    ? { mode: "selected", markets: [...scope.markets] }
    : { mode: "all", markets: [] };
}

function toScopePatch(scope: ScopeState): ScopeState {
  return scope.mode === "all" ? { mode: "all", markets: [] } : scope;
}

interface MarketOption {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
  primary: boolean;
}

interface MarketScopeCardProps {
  title: string;
  markets: MarketOption[];
  scope: ScopeState;
  onChange: (scope: ScopeState) => void;
}

function MarketScopeCard({
  title,
  markets,
  scope,
  onChange,
}: MarketScopeCardProps) {
  const allHandles = markets.map((market) => market.handle);
  const handleModeChange = (selected: string[]) => {
    const mode = selected[0] === "selected" ? "selected" : "all";
    if (mode === scope.mode) return;
    onChange(
      mode === "all"
        ? { mode: "all", markets: [...scope.markets] }
        : {
            mode: "selected",
            markets:
              scope.markets.length > 0 ? [...scope.markets] : [...allHandles],
          },
    );
  };
  const toggleMarket = (handle: string, checked: boolean) => {
    const set = new Set(scope.markets);
    if (checked) set.add(handle);
    else set.delete(handle);
    const ordered = allHandles.filter((other) => set.has(other));
    for (const other of set) {
      if (!allHandles.includes(other)) ordered.push(other);
    }
    onChange({ mode: "selected", markets: ordered });
  };
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {title}
        </Text>
        <Text as="p" tone="subdued" variant="bodySm">
          Limit which markets can see this feature. It must also be enabled
          above to appear anywhere.
        </Text>
        {markets.length === 0 ? (
          <Text as="p" tone="subdued" variant="bodySm">
            No markets could be loaded — the feature follows the “All markets”
            setting.
          </Text>
        ) : null}
        <ChoiceList
          title="Market visibility"
          titleHidden
          choices={[
            { label: "All markets", value: "all" },
            {
              label: "Selected markets",
              value: "selected",
              renderChildren: (isSelected: boolean) =>
                isSelected ? (
                  <BlockStack gap="100">
                    {markets.map((market) => (
                      <Checkbox
                        key={market.handle}
                        label={
                          market.primary
                            ? `${market.name} (primary)`
                            : market.name
                        }
                        helpText={market.handle}
                        checked={scope.markets.includes(market.handle)}
                        onChange={(checked) =>
                          toggleMarket(market.handle, checked)
                        }
                      />
                    ))}
                    {scope.markets.length === 0 ? (
                      <Text as="p" tone="critical" variant="bodySm">
                        No markets selected — this feature won’t appear
                        anywhere.
                      </Text>
                    ) : null}
                  </BlockStack>
                ) : null,
            },
          ]}
          selected={[scope.mode]}
          onChange={handleModeChange}
        />
      </BlockStack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

const DAY_OPTIONS: { iso: number; label: string }[] = [
  { iso: 1, label: "Mon" },
  { iso: 2, label: "Tue" },
  { iso: 3, label: "Wed" },
  { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" },
  { iso: 6, label: "Sat" },
  { iso: 7, label: "Sun" },
];

/** Names for the countries with a fixed-date holiday table (the add-country
 *  suggestions). Any other ISO2 code can be typed manually. */
const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
  IE: "Ireland",
  FR: "France",
  DE: "Germany",
  AT: "Austria",
  CH: "Switzerland",
  IT: "Italy",
  ES: "Spain",
  PT: "Portugal",
  NL: "Netherlands",
  BE: "Belgium",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland",
  PL: "Poland",
  GR: "Greece",
  CZ: "Czechia",
  HU: "Hungary",
  RO: "Romania",
  JP: "Japan",
  AU: "Australia",
  NZ: "New Zealand",
};

function countryLabel(code: string): string {
  return COUNTRY_NAMES[code] ? `${COUNTRY_NAMES[code]} (${code})` : code;
}

/** USPS code → English name, the 50 states + DC (client-safe literal — the
 *  storefront assets carry their own byte-twinned US_STATE_NAMES copy).
 *  Territories (PR, GU, VI, AS, MP) are deliberately not part of v10. */
const US_STATE_OPTIONS: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

function stateLabel(code: string): string {
  return US_STATE_OPTIONS[code] ? `${US_STATE_OPTIONS[code]} (${code})` : code;
}

/** "US-CA" -> "United States — California"; anything else via countryLabel. */
function exampleLabel(code: string): string {
  if (code.startsWith("US-")) {
    const state = code.slice(3);
    return `United States — ${US_STATE_OPTIONS[state] ?? state}`;
  }
  return countryLabel(code);
}

/** "03-17" -> "Mar 17" (client-safe, no Date involved). */
function mmddLabel(mmdd: string): string {
  const month = Number(mmdd.slice(0, 2));
  const day = Number(mmdd.slice(3, 5));
  return `${MONTH_SHORT[month - 1] ?? "?"} ${day}`;
}

type HolidayMode = "inherit" | "on" | "off";

interface OverrideRowState {
  /** Client-only stable list key — never persisted, stripped from compares. */
  id: number;
  country: string;
  /** "" = inherit the default. */
  minDays: string;
  /** "" = inherit the default. */
  maxDays: string;
  overrideDays: boolean;
  deliveryDays: number[];
  holidays: HolidayMode;
  hidden: boolean;
  /** Client-only UI state for the holiday disclosure. */
  showHolidays: boolean;
}

interface UsStateRowState {
  /** Client-only stable list key — never persisted, stripped from compares. */
  id: number;
  /** USPS code — fixed at add time (the Select covers all 51), never edited. */
  state: string;
  /** "" = inherit the effective US-wide value. */
  minDays: string;
  /** "" = inherit the effective US-wide value. */
  maxDays: string;
  overrideDays: boolean;
  deliveryDays: number[];
  holidays: HolidayMode;
  /** "" = inherit the US dispatch cutoff (timezone always inherits). */
  cutoff: string;
  overrideDispatchDays: boolean;
  dispatchDays: number[];
  /** Comma-separated MM-DD / YYYY-MM-DD entries, free text. */
  extraHolidays: string;
  hidden: boolean;
}

interface DeliveryFormState {
  enabled: boolean;
  minDays: string;
  maxDays: string;
  deliveryDays: number[];
  holidaysEnabled: boolean;
  format: DeliveryFormatValue;
  formatCart: DeliveryFormatValue;
  formatCheckout: DeliveryFormatValue;
  showOnPdp: boolean;
  showInCart: boolean;
  showInCheckout: boolean;
  overrides: OverrideRowState[];
  usEnabled: boolean;
  usSelector: boolean;
  usSelectorPrompt: boolean;
  usFederalHolidays: boolean;
  usExtraHolidays: string;
  usOverrides: UsStateRowState[];
  /** v12: per-market excluded products (market handle -> product GIDs). */
  excluded: Record<string, string[]>;
  scopes: {
    delivery_estimate: ScopeState;
  };
}

function initialFormState(settings: BoosterSettings): DeliveryFormState {
  const delivery = settings.deliveryEstimate;
  const overrides: OverrideRowState[] = Object.entries(delivery.byCountry)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([country, entry], index) => ({
      id: index,
      country,
      minDays: entry.minDays !== undefined ? String(entry.minDays) : "",
      maxDays: entry.maxDays !== undefined ? String(entry.maxDays) : "",
      overrideDays: entry.deliveryDays !== undefined,
      deliveryDays:
        entry.deliveryDays !== undefined
          ? [...entry.deliveryDays]
          : [...delivery.deliveryDays],
      holidays:
        entry.holidaysEnabled === undefined
          ? "inherit"
          : entry.holidaysEnabled
            ? "on"
            : "off",
      hidden: entry.hidden === true,
      showHolidays: false,
    }));
  const us = delivery.usStates;
  // Rows without a delivery-days override seed from the EFFECTIVE US-wide
  // weekdays (the US country override when it sets them, else the defaults)
  // so opening the checkbox starts from what the state actually inherits.
  const usDeliveryDays =
    delivery.byCountry.US?.deliveryDays ?? delivery.deliveryDays;
  const usDispatchDays =
    settings.dispatch.byCountry.US?.days ?? settings.dispatch.days;
  const usOverrides: UsStateRowState[] = Object.entries(us.byState)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stateCode, entry], index) => ({
      id: index,
      state: stateCode,
      minDays: entry.minDays !== undefined ? String(entry.minDays) : "",
      maxDays: entry.maxDays !== undefined ? String(entry.maxDays) : "",
      overrideDays: entry.deliveryDays !== undefined,
      deliveryDays:
        entry.deliveryDays !== undefined
          ? [...entry.deliveryDays]
          : [...usDeliveryDays],
      holidays:
        entry.holidaysEnabled === undefined
          ? "inherit"
          : entry.holidaysEnabled
            ? "on"
            : "off",
      cutoff: entry.cutoff ?? "",
      overrideDispatchDays: entry.dispatchDays !== undefined,
      dispatchDays:
        entry.dispatchDays !== undefined
          ? [...entry.dispatchDays]
          : [...usDispatchDays],
      extraHolidays: (entry.extraHolidays ?? []).join(", "),
      hidden: entry.hidden === true,
    }));
  return {
    enabled: delivery.enabled,
    minDays: String(delivery.minDays),
    maxDays: String(delivery.maxDays),
    deliveryDays: [...delivery.deliveryDays],
    holidaysEnabled: delivery.holidaysEnabled,
    format: toFormatValue(delivery.format),
    formatCart: toFormatValue(delivery.formatCart),
    formatCheckout: toFormatValue(delivery.formatCheckout),
    showOnPdp: delivery.showOnPdp,
    showInCart: delivery.showInCart,
    showInCheckout: delivery.showInCheckout,
    overrides,
    usEnabled: us.enabled,
    usSelector: us.selector,
    usSelectorPrompt: us.selectorPrompt,
    usFederalHolidays: us.federalHolidays,
    usExtraHolidays: us.extraHolidays.join(", "),
    usOverrides,
    excluded: Object.fromEntries(
      Object.entries(delivery.excludedByMarket).map(([handle, gids]) => [
        handle,
        [...gids],
      ]),
    ),
    scopes: {
      delivery_estimate: toScopeState(settings.marketScopes.delivery_estimate),
    },
  };
}

function rowToOverride(row: OverrideRowState): DeliveryCountryOverride {
  const override: DeliveryCountryOverride = {};
  if (row.minDays.trim() !== "") override.minDays = Number(row.minDays);
  if (row.maxDays.trim() !== "") override.maxDays = Number(row.maxDays);
  if (row.overrideDays) {
    override.deliveryDays = [...row.deliveryDays].sort((a, b) => a - b);
  }
  if (row.holidays !== "inherit") override.holidaysEnabled = row.holidays === "on";
  if (row.hidden) override.hidden = true;
  return override;
}

/** Country-row convention: only SET fields are emitted — an omitted field
 *  inherits (delivery byState entries are PARTIAL, unlike dispatch's). */
function rowToStateOverride(row: UsStateRowState): DeliveryStateOverride {
  const override: DeliveryStateOverride = {};
  if (row.minDays.trim() !== "") override.minDays = Number(row.minDays);
  if (row.maxDays.trim() !== "") override.maxDays = Number(row.maxDays);
  if (row.overrideDays) {
    override.deliveryDays = [...row.deliveryDays].sort((a, b) => a - b);
  }
  if (row.holidays !== "inherit") override.holidaysEnabled = row.holidays === "on";
  if (row.hidden) override.hidden = true;
  if (row.cutoff.trim() !== "") override.cutoff = row.cutoff.trim();
  if (row.overrideDispatchDays) {
    override.dispatchDays = [...row.dispatchDays].sort((a, b) => a - b);
  }
  const extraHolidays = parseExtraHolidays(row.extraHolidays);
  if (extraHolidays.length > 0) override.extraHolidays = extraHolidays;
  return override;
}

/** Dirty-check serialization: rows lose their client-only id/disclosure
 *  state and compare by their EFFECTIVE override payload. */
function serializeForCompare(state: DeliveryFormState): string {
  return JSON.stringify({
    enabled: state.enabled,
    minDays: state.minDays.trim(),
    maxDays: state.maxDays.trim(),
    deliveryDays: [...state.deliveryDays].sort((a, b) => a - b),
    holidaysEnabled: state.holidaysEnabled,
    format: state.format,
    formatCart: state.formatCart,
    formatCheckout: state.formatCheckout,
    showOnPdp: state.showOnPdp,
    showInCart: state.showInCart,
    showInCheckout: state.showInCheckout,
    overrides: state.overrides.map((row) => ({
      country: row.country.trim().toUpperCase(),
      ...rowToOverride(row),
    })),
    usStates: {
      enabled: state.usEnabled,
      selector: state.usSelector,
      selectorPrompt: state.usSelectorPrompt,
      federalHolidays: state.usFederalHolidays,
      extraHolidays: parseExtraHolidays(state.usExtraHolidays),
      overrides: state.usOverrides.map((row) => ({
        state: row.state,
        ...rowToStateOverride(row),
      })),
    },
    // Key order normalized so add-then-remove of a market compares clean.
    excluded: Object.fromEntries(
      Object.entries(state.excluded).sort(([a], [b]) => a.localeCompare(b)),
    ),
    scopes: { delivery_estimate: toScopePatch(state.scopes.delivery_estimate) },
  });
}

function parseDaysField(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return parsed;
}

/** "06-19, 2026-11-27" -> ["06-19", "2026-11-27"] (trimmed, empties
 *  dropped) — the canonical form saved AND compared, so "a, b" vs "a,b" is
 *  never dirty. */
function parseExtraHolidays(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** Client mirror of the action's extra-day validation. */
function extraHolidaysError(value: string): string | undefined {
  const bad = parseExtraHolidays(value).find(
    (entry) => !EXTRA_DATE_PATTERN.test(entry),
  );
  return bad === undefined ? undefined : `“${bad}” — use MM-DD or YYYY-MM-DD`;
}

interface WindowErrors {
  minDays?: string;
  maxDays?: string;
  days?: string;
}

/** Client-side mirror of the action's window validation. `required` = the
 *  global defaults (empty not allowed); override rows may leave fields empty
 *  to inherit. */
function windowErrors(
  minDays: string,
  maxDays: string,
  required: boolean,
): Pick<WindowErrors, "minDays" | "maxDays"> {
  const errors: Pick<WindowErrors, "minDays" | "maxDays"> = {};
  const min = parseDaysField(minDays);
  const max = parseDaysField(maxDays);
  if (minDays.trim() === "") {
    if (required) errors.minDays = "Required";
  } else if (min === null || min < 0 || min > 30) {
    errors.minDays = "Whole number, 0–30";
  }
  if (maxDays.trim() === "") {
    if (required) errors.maxDays = "Required";
  } else if (max === null || max < 1 || max > 30) {
    errors.maxDays = "Whole number, 1–30";
  } else if (
    minDays.trim() !== "" &&
    min !== null &&
    min >= 0 &&
    min <= 30 &&
    max < Math.max(1, min)
  ) {
    errors.maxDays = "Must be ≥ the minimum";
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Format mini previews (brand ink #1d1d1b / blue #b1cded, like the survey page)
// ---------------------------------------------------------------------------

const INK = "#1d1d1b";
const BLUE = "#b1cded";

function GuaranteeBadge() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        border: `1px solid ${INK}`,
        borderRadius: 999,
        padding: "1px 8px",
        fontSize: 11,
        fontWeight: 600,
        color: INK,
        background: "#fff",
        whiteSpace: "nowrap",
      }}
    >
      <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true">
        <path
          d="M5.5 0.8 L10 2.4 V6 C10 8.8 8.2 10.5 5.5 11.4 C2.8 10.5 1 8.8 1 6 V2.4 Z"
          fill={BLUE}
          stroke={INK}
          strokeWidth="0.8"
        />
        <path
          d="M3.6 5.9l1.3 1.4 2.6-2.9"
          stroke={INK}
          strokeWidth="1.1"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      Delivery guarantee
    </span>
  );
}

function BoxIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M1.5 4.2 L7 1.5 L12.5 4.2 V9.8 L7 12.5 L1.5 9.8 Z"
        fill="none"
        stroke={INK}
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path
        d="M1.5 4.2 L7 6.9 L12.5 4.2 M7 6.9 V12.5"
        fill="none"
        stroke={INK}
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface FormatPreviewProps {
  format: DeliveryFormatValue;
  ships: string;
  from: string;
  to: string;
}

function FormatMiniPreview({ format, ships, from, to }: FormatPreviewProps) {
  const textStyle = { color: INK, fontSize: 13, lineHeight: "18px" as const };
  if (format === "line") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <BoxIcon />
        <span style={textStyle}>
          Get it by <strong>{to}</strong>
        </span>
        <GuaranteeBadge />
      </div>
    );
  }
  if (format === "range") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={textStyle}>
          Estimated delivery:{" "}
          <strong>
            {from === to ? to : `${from} – ${to}`}
          </strong>
        </span>
        <GuaranteeBadge />
      </div>
    );
  }
  if (format === "timeline") {
    const steps = [
      { label: "Order today", strong: false },
      { label: `Ships ${ships}`, strong: false },
      { label: `Delivered by ${to}`, strong: true },
    ];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {steps.map((step, index) => (
            <span
              key={step.label}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              {index > 0 ? (
                <span
                  style={{
                    display: "inline-block",
                    width: 18,
                    height: 1,
                    background: INK,
                    opacity: 0.4,
                  }}
                />
              ) : null}
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: step.strong ? INK : BLUE,
                  border: `1px solid ${INK}`,
                }}
              />
              <span
                style={{
                  ...textStyle,
                  fontWeight: step.strong ? 700 : 400,
                  fontSize: 12,
                }}
              >
                {step.label}
              </span>
            </span>
          ))}
        </div>
        <GuaranteeBadge />
      </div>
    );
  }
  return (
    <div
      style={{
        border: `1px solid ${INK}`,
        borderRadius: 8,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        maxWidth: 420,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6" fill={BLUE} />
          <path
            d="M4.4 7.2l1.8 1.9 3.4-4"
            stroke={INK}
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span style={{ ...textStyle, fontWeight: 700 }}>
          Guaranteed delivery by {to}
        </span>
        <GuaranteeBadge />
      </div>
      <span style={{ ...textStyle, fontSize: 12, opacity: 0.8 }}>
        …or we refund you or send a free replacement.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function DeliveryFeaturesPage() {
  const {
    settings,
    markets,
    exclusionTitles,
    headerEnabled,
    holidayTable,
    globalExclusions,
    usFederalYear,
    usFederalNote,
    geoAttribution,
    geoStatus,
    examples,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();

  const [state, setState] = useState<DeliveryFormState>(() =>
    initialFormState(settings),
  );
  /** Monotonic id source for new override rows (initial rows use 0..n-1). */
  const [nextRowId, setNextRowId] = useState(
    () => Object.keys(settings.deliveryEstimate.byCountry).length,
  );
  const [nextUsRowId, setNextUsRowId] = useState(
    () => Object.keys(settings.deliveryEstimate.usStates.byState).length,
  );
  const [addCountrySelect, setAddCountrySelect] = useState("");
  const [addStateSelect, setAddStateSelect] = useState("");
  const [exampleCountry, setExampleCountry] = useState("");
  const [testIp, setTestIp] = useState("");

  /** The geo poll below revalidates the loader every 3 s during a build,
   *  which gives `settings` a fresh OBJECT IDENTITY with unchanged content —
   *  the form must reset on saved CONTENT only, or the poll would wipe
   *  unsaved edits. */
  const settingsKey = useMemo(() => JSON.stringify(settings), [settings]);

  useEffect(() => {
    setState(initialFormState(settings));
    setNextRowId(Object.keys(settings.deliveryEstimate.byCountry).length);
    setNextUsRowId(Object.keys(settings.deliveryEstimate.usStates.byState).length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

  // 3 s status polling while a geo build runs — pure revalidation, stopped
  // as soon as the status leaves "building".
  useEffect(() => {
    if (geoStatus.status !== "building") return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(timer);
  }, [geoStatus.status, revalidator]);

  // v12: the action now also answers search_products (picker fetchers) —
  // toast + banner read only settings-save results.
  const saveResult =
    actionData && "syncErrors" in actionData ? actionData : undefined;

  useEffect(() => {
    if (!saveResult) return;
    // Geo intents ride the save envelope but are not saves: the build gets
    // one ack toast (the card polls the rest), test results render inline.
    if (saveResult.geo) {
      if (saveResult.geo.intent === "build") {
        shopify.toast.show("Download started — building in the background");
      }
      return;
    }
    if (!saveResult.ok) {
      shopify.toast.show("Could not save settings", { isError: true });
    } else if (saveResult.syncErrors.length > 0) {
      shopify.toast.show("Saved, but the storefront sync failed", {
        isError: true,
      });
    } else {
      shopify.toast.show("Saved");
    }
  }, [saveResult, shopify]);

  const initial = useMemo(() => initialFormState(settings), [settings]);
  const dirty = serializeForCompare(state) !== serializeForCompare(initial);
  const pendingGeoIntent =
    navigation.state !== "idle" && navigation.formMethod === "POST"
      ? navigation.formData?.get("geoIntent") ?? null
      : null;
  const isSaving =
    navigation.state !== "idle" &&
    navigation.formMethod === "POST" &&
    pendingGeoIntent === null;

  // --- Validation ----------------------------------------------------------
  const defaultWindowErrors: WindowErrors = {
    ...windowErrors(state.minDays, state.maxDays, true),
    days:
      state.deliveryDays.length === 0
        ? "Pick at least one delivery weekday."
        : undefined,
  };
  const countryCounts = new Map<string, number>();
  for (const row of state.overrides) {
    const code = row.country.trim().toUpperCase();
    countryCounts.set(code, (countryCounts.get(code) ?? 0) + 1);
  }
  const overrideErrors = state.overrides.map((row) => {
    const code = row.country.trim().toUpperCase();
    let country: string | undefined;
    if (!ISO2_PATTERN.test(code)) {
      country = "Two-letter ISO code, e.g. DE";
    } else if ((countryCounts.get(code) ?? 0) > 1) {
      country = "Duplicate country code";
    }
    const window = windowErrors(row.minDays, row.maxDays, false);
    const days =
      row.overrideDays && row.deliveryDays.length === 0
        ? "Pick at least one delivery weekday."
        : undefined;
    return { country, ...window, days };
  });
  // Effective US-wide values (defaults overlaid by the US country override,
  // from the LIVE editor state) — what an empty state field inherits, shown
  // as the placeholders. The dispatch pair is edited on the Dispatch page,
  // so its effective values come from the SAVED settings.
  const usCountryRow = state.overrides.find(
    (row) => row.country.trim().toUpperCase() === "US",
  );
  const usEffectiveMin =
    usCountryRow && usCountryRow.minDays.trim() !== ""
      ? usCountryRow.minDays
      : state.minDays;
  const usEffectiveMax =
    usCountryRow && usCountryRow.maxDays.trim() !== ""
      ? usCountryRow.maxDays
      : state.maxDays;
  const usEffectiveHolidays =
    usCountryRow && usCountryRow.holidays !== "inherit"
      ? usCountryRow.holidays === "on"
      : state.holidaysEnabled;
  const usEffectiveCutoff =
    settings.dispatch.byCountry.US?.cutoff ?? settings.dispatch.cutoff;
  const usDispatchDaysDefault =
    settings.dispatch.byCountry.US?.days ?? settings.dispatch.days;

  const usExtraError = extraHolidaysError(state.usExtraHolidays);
  const usOverrideErrors = state.usOverrides.map((row) => {
    const window = windowErrors(row.minDays, row.maxDays, false);
    const days =
      row.overrideDays && row.deliveryDays.length === 0
        ? "Pick at least one delivery weekday."
        : undefined;
    const dispatchDays =
      row.overrideDispatchDays && row.dispatchDays.length === 0
        ? "Pick at least one dispatch day."
        : undefined;
    const cutoff =
      row.cutoff.trim() !== "" && !CUTOFF_PATTERN.test(row.cutoff.trim())
        ? "24-hour time, e.g. 14:00"
        : undefined;
    const extraHolidays = extraHolidaysError(row.extraHolidays);
    return { ...window, days, dispatchDays, cutoff, extraHolidays };
  });
  // Cross-inheritance is deliberately NOT an error: the server accepts it
  // and the storefront fails OPEN (ignores the entry). The caution below
  // tells the merchant so instead of silently letting a dead override sit.
  const usMergeCautions = state.usOverrides.map((row, index) => {
    const errors = usOverrideErrors[index];
    if (errors.minDays || errors.maxDays) return null;
    const min = parseDaysField(
      row.minDays.trim() === "" ? usEffectiveMin : row.minDays,
    );
    const max = parseDaysField(
      row.maxDays.trim() === "" ? usEffectiveMax : row.maxDays,
    );
    if (min === null || max === null) return null;
    if (max >= Math.max(1, min)) return null;
    return `Merged with the US-wide window this reads minimum ${min} / maximum ${max} — an impossible window, so the storefront ignores this override and buyers in ${US_STATE_OPTIONS[row.state] ?? row.state} keep the US-wide promise.`;
  });
  const hasErrors =
    Boolean(
      defaultWindowErrors.minDays ||
        defaultWindowErrors.maxDays ||
        defaultWindowErrors.days,
    ) ||
    overrideErrors.some(
      (errors) => errors.country || errors.minDays || errors.maxDays || errors.days,
    ) ||
    Boolean(usExtraError) ||
    usOverrideErrors.some(
      (errors) =>
        errors.minDays ||
        errors.maxDays ||
        errors.days ||
        errors.dispatchDays ||
        errors.cutoff ||
        errors.extraHolidays,
    );

  // --- Handlers ------------------------------------------------------------
  const setRow = (id: number, next: OverrideRowState) =>
    setState((previous) => ({
      ...previous,
      overrides: previous.overrides.map((row) => (row.id === id ? next : row)),
    }));

  const addOverride = (country: string) => {
    setState((previous) => ({
      ...previous,
      overrides: [
        ...previous.overrides,
        {
          id: nextRowId,
          country,
          minDays: "",
          maxDays: "",
          overrideDays: false,
          deliveryDays: [...previous.deliveryDays],
          holidays: "inherit",
          hidden: false,
          showHolidays: false,
        },
      ],
    }));
    setNextRowId((id) => id + 1);
  };

  const removeOverride = (id: number) =>
    setState((previous) => ({
      ...previous,
      overrides: previous.overrides.filter((row) => row.id !== id),
    }));

  const setUsRow = (id: number, next: UsStateRowState) =>
    setState((previous) => ({
      ...previous,
      usOverrides: previous.usOverrides.map((row) =>
        row.id === id ? next : row,
      ),
    }));

  const addUsOverride = (stateCode: string) => {
    setState((previous) => {
      // Day pickers seed from the EFFECTIVE US-wide days so opening either
      // checkbox starts from what the state actually inherits.
      const usRow = previous.overrides.find(
        (row) => row.country.trim().toUpperCase() === "US",
      );
      return {
        ...previous,
        usOverrides: [
          ...previous.usOverrides,
          {
            id: nextUsRowId,
            state: stateCode,
            minDays: "",
            maxDays: "",
            overrideDays: false,
            deliveryDays:
              usRow && usRow.overrideDays
                ? [...usRow.deliveryDays]
                : [...previous.deliveryDays],
            holidays: "inherit",
            cutoff: "",
            overrideDispatchDays: false,
            dispatchDays: [...usDispatchDaysDefault],
            extraHolidays: "",
            hidden: false,
          },
        ],
      };
    });
    setNextUsRowId((id) => id + 1);
  };

  const removeUsOverride = (id: number) =>
    setState((previous) => ({
      ...previous,
      usOverrides: previous.usOverrides.filter((row) => row.id !== id),
    }));

  const submitGeoBuild = () => {
    const formData = new FormData();
    formData.set("geoIntent", "build");
    submit(formData, { method: "post" });
  };

  const submitGeoTest = () => {
    const formData = new FormData();
    formData.set("geoIntent", "test");
    formData.set("ip", testIp.trim());
    submit(formData, { method: "post" });
  };

  const toggleDefaultDay = (iso: number, checked: boolean) => {
    setState((previous) => {
      const set = new Set(previous.deliveryDays);
      if (checked) set.add(iso);
      else set.delete(iso);
      return { ...previous, deliveryDays: [...set].sort((a, b) => a - b) };
    });
  };

  const handleSave = () => {
    // byCountry AND usStates.byState are dynamic records replaced WHOLESALE
    // by the settings merge — always send the full maps (an empty object
    // clears every override).
    const byCountry = Object.fromEntries(
      state.overrides.map((row) => [
        row.country.trim().toUpperCase(),
        rowToOverride(row),
      ]),
    );
    const byState = Object.fromEntries(
      state.usOverrides.map((row) => [row.state, rowToStateOverride(row)]),
    );
    const patch: DeepPartial<BoosterSettings> = {
      deliveryEstimate: {
        enabled: state.enabled,
        minDays: Number(state.minDays),
        maxDays: Number(state.maxDays),
        deliveryDays: [...state.deliveryDays].sort((a, b) => a - b),
        holidaysEnabled: state.holidaysEnabled,
        format: state.format,
        formatCart: state.formatCart,
        formatCheckout: state.formatCheckout,
        showOnPdp: state.showOnPdp,
        showInCart: state.showInCart,
        showInCheckout: state.showInCheckout,
        byCountry,
        usStates: {
          enabled: state.usEnabled,
          selector: state.usSelector,
          selectorPrompt: state.usSelectorPrompt,
          federalHolidays: state.usFederalHolidays,
          extraHolidays: parseExtraHolidays(state.usExtraHolidays),
          byState,
        },
        // v12: wholesale-replaced record — always send the full map (an
        // empty object clears every exclusion).
        excludedByMarket: state.excluded,
      },
      marketScopes: {
        delivery_estimate: toScopePatch(state.scopes.delivery_estimate),
      },
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  // --- Live example --------------------------------------------------------
  const exampleOptions = [
    { label: "Any other country (defaults)", value: "" },
    ...examples
      .filter((example) => example.code !== "")
      .map((example) => ({
        label: exampleLabel(example.code),
        value: example.code,
      })),
  ];
  const selectedExample =
    examples.find((example) => example.code === exampleCountry) ?? examples[0];

  // --- Geo card ------------------------------------------------------------
  const geoTest =
    saveResult?.geo && saveResult.geo.intent === "test" ? saveResult.geo : null;

  // Sample dates for the format mini previews: the real computed defaults
  // when available, otherwise a clearly generic placeholder.
  const defaultExample = examples.find((example) => example.code === "");
  const sample = {
    ships: defaultExample?.ships ?? "Mon, Aug 3",
    from: defaultExample?.from ?? "Tue, Aug 4",
    to: defaultExample?.to ?? "Thu, Aug 6",
  };

  const globalExclusionLabels = globalExclusions.map(mmddLabel).join(", ");

  return (
    <Page
      title="Delivery guarantee"
      backAction={{ content: "Dashboard", url: "/app" }}
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        disabled: !dirty || hasErrors,
        loading: isSaving,
      }}
      secondaryActions={[
        {
          content: "Discard",
          onAction: () => setState(initial),
          disabled: !dirty || isSaving,
        },
      ]}
    >
      <TitleBar title="Delivery guarantee" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="delivery_estimate"
              enabled={headerEnabled}
            />
          </Card>
        </Layout.Section>

        {saveResult && saveResult.syncErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone={saveResult.ok ? "warning" : "critical"}
              title={
                saveResult.ok
                  ? "Saved, but the storefront sync reported errors"
                  : "Settings could not be saved"
              }
            >
              <BlockStack gap="100">
                {saveResult.syncErrors.map((error) => (
                  <Text as="p" key={error}>
                    {error}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Delivery estimate &amp; guarantee
                </Text>
                <Checkbox
                  label="Enable the delivery estimate + guarantee widget"
                  helpText="“Get it by Thu, Aug 6” with a delivery-guarantee badge on product pages, in the cart drawer and in checkout (pick the surfaces below). Dates are computed from your dispatch schedule, the delivery window below, and public holidays."
                  checked={state.enabled}
                  onChange={(enabled) =>
                    setState((previous) => ({ ...previous, enabled }))
                  }
                />
                <Banner tone="info" title="Only dates you can stand behind">
                  <BlockStack gap="100">
                    <Text as="p">
                      The guarantee badge tells buyers: “Delivered on or before
                      this date — or we refund you or send a free replacement.”
                      That is a real commitment — set the maximum below to what
                      your carrier actually achieves, not to what looks best.
                    </Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                      The widget fails closed: if the schedule, the delivery
                      window or the date math is inconsistent in any way,
                      buyers see nothing at all rather than a wrong promise.
                      Dispatch dates come from your Dispatch countdown schedule
                      (cutoff, warehouse timezone, dispatch days) even while
                      that countdown itself is turned off.
                    </Text>
                  </BlockStack>
                </Banner>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Delivery window
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Used for every buyer without a country override below. Days
                  are counted in DELIVERY days: only the weekdays you check,
                  skipping public holidays.
                </Text>
                <InlineStack gap="300" wrap>
                  <Box width="180px">
                    <TextField
                      label="Minimum (business days)"
                      type="number"
                      value={state.minDays}
                      onChange={(minDays) =>
                        setState((previous) => ({ ...previous, minDays }))
                      }
                      error={defaultWindowErrors.minDays}
                      helpText="Earliest realistic delivery. 0 = same-day possible."
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="180px">
                    <TextField
                      label="Maximum (business days)"
                      type="number"
                      value={state.maxDays}
                      onChange={(maxDays) =>
                        setState((previous) => ({ ...previous, maxDays }))
                      }
                      error={defaultWindowErrors.maxDays}
                      helpText="The guaranteed “on or before” date."
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
                <BlockStack gap="100">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Delivery weekdays (how weekends are excluded — add Sat for
                    countries with Saturday delivery)
                  </Text>
                  <InlineStack gap="300" wrap>
                    {DAY_OPTIONS.map((day) => (
                      <Checkbox
                        key={day.iso}
                        label={day.label}
                        checked={state.deliveryDays.includes(day.iso)}
                        onChange={(checked) => toggleDefaultDay(day.iso, checked)}
                      />
                    ))}
                  </InlineStack>
                  {defaultWindowErrors.days ? (
                    <Text as="p" tone="critical" variant="bodySm">
                      {defaultWindowErrors.days}
                    </Text>
                  ) : null}
                </BlockStack>
                <Checkbox
                  label="Skip public holidays when counting delivery days"
                  checked={state.holidaysEnabled}
                  onChange={(holidaysEnabled) =>
                    setState((previous) => ({ ...previous, holidaysEnabled }))
                  }
                  helpText={`Uses a deliberately conservative table of FIXED-DATE national public holidays per country (see each country override below for its exact list). Movable feasts — Easter, Whit Monday, Thanksgiving, Islamic holidays — are NOT in the table; around those periods, rely on a generous maximum instead. ${globalExclusionLabels} are ALWAYS excluded for every country, even with this off.`}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Where it shows
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    One feature, three surfaces — product page, cart drawer
                    and checkout all compute the same dates and use the same
                    translated wording, so buyers never see two different
                    promises. Each surface picks its own visual format; every
                    format carries the guarantee badge, whose tooltip
                    explains: “Delivered on or before this date — or we
                    refund you or send a free replacement.” All three follow
                    the master switch above.
                  </Text>
                </BlockStack>
                {!state.showOnPdp &&
                !state.showInCart &&
                !state.showInCheckout ? (
                  <Banner tone="warning" title="All surfaces are off">
                    <Text as="p">
                      With every surface unchecked the widget renders nowhere,
                      even while the feature is enabled above.
                    </Text>
                  </Banner>
                ) : null}

                <BlockStack gap="300">
                  <Checkbox
                    label="Show on product pages"
                    helpText="Right below the dispatch countdown on the product page."
                    checked={state.showOnPdp}
                    onChange={(showOnPdp) =>
                      setState((previous) => ({ ...previous, showOnPdp }))
                    }
                  />
                  {state.showOnPdp ? (
                    <Box paddingInlineStart="600">
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          Product page format
                        </Text>
                        <BlockStack gap="200">
                          {DELIVERY_FORMATS.map((format) => (
                            <RadioButton
                              key={format.value}
                              label={format.label}
                              helpText={format.description}
                              checked={state.format === format.value}
                              id={`delivery-format-${format.value}`}
                              name="deliveryFormat"
                              onChange={() =>
                                setState((previous) => ({
                                  ...previous,
                                  format: format.value,
                                }))
                              }
                            />
                          ))}
                        </BlockStack>
                        <Box
                          background="bg-surface-secondary"
                          borderRadius="200"
                          padding="400"
                        >
                          <FormatMiniPreview
                            format={state.format}
                            ships={sample.ships}
                            from={sample.from}
                            to={sample.to}
                          />
                        </Box>
                      </BlockStack>
                    </Box>
                  ) : null}
                </BlockStack>

                <Divider />

                <BlockStack gap="300">
                  <Checkbox
                    label="Show in the cart drawer"
                    helpText="Above the checkout actions in the mini-cart drawer — the same dates and wording as the product page, recomputed live as the buyer shops."
                    checked={state.showInCart}
                    onChange={(showInCart) =>
                      setState((previous) => ({ ...previous, showInCart }))
                    }
                  />
                  {state.showInCart ? (
                    <Box paddingInlineStart="600">
                      <BlockStack gap="200">
                        <Box maxWidth="360px">
                          <Select
                            label="Cart drawer format"
                            options={FORMAT_SELECT_OPTIONS}
                            value={state.formatCart}
                            onChange={(value) =>
                              setState((previous) => ({
                                ...previous,
                                formatCart: toFormatValue(value),
                              }))
                            }
                            helpText={formatDescription(state.formatCart)}
                          />
                        </Box>
                        <Box
                          background="bg-surface-secondary"
                          borderRadius="200"
                          padding="400"
                        >
                          <FormatMiniPreview
                            format={state.formatCart}
                            ships={sample.ships}
                            from={sample.from}
                            to={sample.to}
                          />
                        </Box>
                      </BlockStack>
                    </Box>
                  ) : null}
                </BlockStack>

                <Divider />

                <BlockStack gap="300">
                  <Checkbox
                    label="Show in checkout"
                    helpText="Near the order summary in checkout. The Cellexia delivery block must also be placed ONCE in the checkout editor (Settings → Checkout → Customize) — the app cannot place it for you; until it is placed there, this switch has no visible effect."
                    checked={state.showInCheckout}
                    onChange={(showInCheckout) =>
                      setState((previous) => ({ ...previous, showInCheckout }))
                    }
                  />
                  {state.showInCheckout ? (
                    <Box paddingInlineStart="600">
                      <BlockStack gap="200">
                        <Box maxWidth="360px">
                          <Select
                            label="Checkout format"
                            options={FORMAT_SELECT_OPTIONS}
                            value={state.formatCheckout}
                            onChange={(value) =>
                              setState((previous) => ({
                                ...previous,
                                formatCheckout: toFormatValue(value),
                              }))
                            }
                            helpText={formatDescription(state.formatCheckout)}
                          />
                        </Box>
                        <Box
                          background="bg-surface-secondary"
                          borderRadius="200"
                          padding="400"
                        >
                          <FormatMiniPreview
                            format={state.formatCheckout}
                            ships={sample.ships}
                            from={sample.from}
                            to={sample.to}
                          />
                        </Box>
                      </BlockStack>
                    </Box>
                  ) : null}
                </BlockStack>

                <Divider />
                <BlockStack gap="200">
                  <Text as="p" tone="subdued" variant="bodySm">
                    Mini previews are an approximation with{" "}
                    {defaultExample?.hiddenReason
                      ? "sample dates (the live computation is currently hidden — see the live example below)"
                      : "the real dates a default-schedule buyer would get right now"}
                    . Buyers see dates in their own language, and the widget
                    re-checks every 30 seconds so crossing the dispatch cutoff
                    shifts every date automatically.
                  </Text>
                  <InlineStack>
                    <Button url="/app/preview?feature=delivery_estimate">
                      Preview on your store
                    </Button>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Country overrides
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Give specific destination countries their own delivery
                  window, weekdays or holiday handling — or hide the widget
                  there entirely. Fields left empty inherit the defaults
                  above. Everyone else keeps the defaults.
                </Text>
                {state.overrides.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No overrides — every buyer gets the default window.
                  </Text>
                ) : null}
                {state.overrides.map((row, index) => {
                  const code = row.country.trim().toUpperCase();
                  const holidays = ISO2_PATTERN.test(code)
                    ? (holidayTable[code] ?? [])
                    : [];
                  const errors = overrideErrors[index] ?? {};
                  return (
                    <BlockStack key={row.id} gap="300">
                      {index > 0 ? <Divider /> : null}
                      <InlineStack
                        gap="300"
                        blockAlign="start"
                        align="space-between"
                        wrap
                      >
                        <InlineStack gap="300" blockAlign="start" wrap>
                          <Box width="160px">
                            <TextField
                              label="Country (ISO2)"
                              value={row.country}
                              onChange={(country) =>
                                setRow(row.id, {
                                  ...row,
                                  country: country.toUpperCase(),
                                })
                              }
                              error={errors.country}
                              placeholder="DE"
                              maxLength={2}
                              autoComplete="off"
                              helpText={
                                COUNTRY_NAMES[code] ? COUNTRY_NAMES[code] : undefined
                              }
                            />
                          </Box>
                          <Box width="160px">
                            <TextField
                              label="Minimum (days)"
                              type="number"
                              value={row.minDays}
                              onChange={(minDays) =>
                                setRow(row.id, { ...row, minDays })
                              }
                              error={errors.minDays}
                              placeholder={`Default: ${state.minDays || "?"}`}
                              autoComplete="off"
                            />
                          </Box>
                          <Box width="160px">
                            <TextField
                              label="Maximum (days)"
                              type="number"
                              value={row.maxDays}
                              onChange={(maxDays) =>
                                setRow(row.id, { ...row, maxDays })
                              }
                              error={errors.maxDays}
                              placeholder={`Default: ${state.maxDays || "?"}`}
                              autoComplete="off"
                            />
                          </Box>
                          <Box width="220px">
                            <Select
                              label="Public holidays"
                              options={[
                                {
                                  label: `Inherit (${state.holidaysEnabled ? "skip" : "don’t skip"})`,
                                  value: "inherit",
                                },
                                { label: "Skip holidays", value: "on" },
                                { label: "Don’t skip holidays", value: "off" },
                              ]}
                              value={row.holidays}
                              onChange={(holidays) =>
                                setRow(row.id, {
                                  ...row,
                                  holidays: holidays as HolidayMode,
                                })
                              }
                            />
                          </Box>
                        </InlineStack>
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => removeOverride(row.id)}
                        >
                          Remove
                        </Button>
                      </InlineStack>
                      <Checkbox
                        label="Custom delivery weekdays for this country"
                        checked={row.overrideDays}
                        onChange={(overrideDays) =>
                          setRow(row.id, { ...row, overrideDays })
                        }
                      />
                      {row.overrideDays ? (
                        <BlockStack gap="100">
                          <InlineStack gap="300" wrap>
                            {DAY_OPTIONS.map((day) => (
                              <Checkbox
                                key={day.iso}
                                label={day.label}
                                checked={row.deliveryDays.includes(day.iso)}
                                onChange={(checked) => {
                                  const set = new Set(row.deliveryDays);
                                  if (checked) set.add(day.iso);
                                  else set.delete(day.iso);
                                  setRow(row.id, {
                                    ...row,
                                    deliveryDays: [...set].sort((a, b) => a - b),
                                  });
                                }}
                              />
                            ))}
                          </InlineStack>
                          {errors.days ? (
                            <Text as="p" tone="critical" variant="bodySm">
                              {errors.days}
                            </Text>
                          ) : null}
                        </BlockStack>
                      ) : null}
                      <Checkbox
                        label="Hide the delivery widget for buyers in this country"
                        helpText="For destinations where no date can honestly be guaranteed. Buyers there see nothing — no estimate, no badge."
                        checked={row.hidden}
                        onChange={(hidden) => setRow(row.id, { ...row, hidden })}
                      />
                      <BlockStack gap="100">
                        <InlineStack>
                          <Button
                            variant="plain"
                            disclosure={row.showHolidays ? "up" : "down"}
                            onClick={() =>
                              setRow(row.id, {
                                ...row,
                                showHolidays: !row.showHolidays,
                              })
                            }
                            ariaExpanded={row.showHolidays}
                            ariaControls={`delivery-holidays-${row.id}`}
                          >
                            Which holidays apply here?
                          </Button>
                        </InlineStack>
                        <Collapsible
                          id={`delivery-holidays-${row.id}`}
                          open={row.showHolidays}
                        >
                          <Box
                            background="bg-surface-secondary"
                            borderRadius="200"
                            padding="300"
                          >
                            <BlockStack gap="100">
                              {!ISO2_PATTERN.test(code) ? (
                                <Text as="p" tone="subdued" variant="bodySm">
                                  Enter a valid country code to see its holiday
                                  list.
                                </Text>
                              ) : holidays.length > 0 ? (
                                <Text as="p" variant="bodySm">
                                  Fixed-date public holidays skipped for{" "}
                                  {countryLabel(code)} (when holiday skipping is
                                  on): {holidays.map(mmddLabel).join(", ")}.
                                </Text>
                              ) : (
                                <Text as="p" variant="bodySm">
                                  No fixed-date holiday table for{" "}
                                  {countryLabel(code)} — only the global
                                  exclusions apply.
                                </Text>
                              )}
                              <Text as="p" tone="subdued" variant="bodySm">
                                {globalExclusionLabels} are always excluded, for
                                every country. Movable feasts (Easter,
                                Thanksgiving, …) are deliberately not in the
                                table — pad the maximum around those periods.
                              </Text>
                            </BlockStack>
                          </Box>
                        </Collapsible>
                      </BlockStack>
                    </BlockStack>
                  );
                })}
                <InlineStack gap="300" blockAlign="end" wrap>
                  <Box width="280px">
                    <Select
                      label="Add a country override"
                      options={[
                        { label: "Pick a country…", value: "" },
                        ...Object.keys(COUNTRY_NAMES)
                          .filter(
                            (candidate) =>
                              !state.overrides.some(
                                (row) =>
                                  row.country.trim().toUpperCase() === candidate,
                              ),
                          )
                          .sort((a, b) =>
                            COUNTRY_NAMES[a].localeCompare(COUNTRY_NAMES[b]),
                          )
                          .map((candidate) => ({
                            label: countryLabel(candidate),
                            value: candidate,
                          })),
                        { label: "Other (type the ISO code)", value: "__custom__" },
                      ]}
                      value={addCountrySelect}
                      onChange={(value) => {
                        setAddCountrySelect("");
                        if (value === "") return;
                        addOverride(value === "__custom__" ? "" : value);
                      }}
                    />
                  </Box>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  United States — delivery by state
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  A quiet upgrade on top of the US-wide promise: buyers
                  resolved to a state get state-accurate dates, and anything
                  the state layer cannot resolve keeps the US-wide promise —
                  unlike everything above, this layer never fails to hidden.
                </Text>
                <Checkbox
                  label="Enable per-state delivery promises for US buyers"
                  helpText="Product page and cart use the buyer’s detected or chosen state (build the detection database below); checkout always uses the typed shipping address. The widget never disappears because of a state problem — it falls back to the US-wide promise instead."
                  checked={state.usEnabled}
                  onChange={(usEnabled) =>
                    setState((previous) => ({ ...previous, usEnabled }))
                  }
                />
                {state.usEnabled ? (
                  <Box paddingInlineStart="600">
                    <BlockStack gap="300">
                      <Checkbox
                        label="Show a “Deliver to” state selector on the widget"
                        helpText="Amazon’s location-picker pattern: visitors can correct the detected state, or pick one when detection has nothing. When the shown state came from IP detection, the selector carries the required “IP Geolocation by DB-IP” attribution link."
                        checked={state.usSelector}
                        onChange={(usSelector) =>
                          setState((previous) => ({ ...previous, usSelector }))
                        }
                      />
                      {state.usSelector ? (
                        <Box paddingInlineStart="600">
                          <Checkbox
                            label="Highlight the state prompt until a state is chosen"
                            helpText="Amazon-style location strip: while no state is resolved, the “Deliver to” line renders as a bordered card with a “Select your state for a more accurate delivery date” call-to-action (translated in all store languages). Once the visitor picks a state — or IP detection resolves one — the quiet one-line link returns. Turn off to keep the quiet link at all times."
                            checked={state.usSelectorPrompt}
                            onChange={(usSelectorPrompt) =>
                              setState((previous) => ({
                                ...previous,
                                usSelectorPrompt,
                              }))
                            }
                          />
                        </Box>
                      ) : null}
                      <Checkbox
                        label="Skip US federal holidays when counting delivery days"
                        helpText={`Adds the six movable federal holidays the fixed-date table cannot carry — in ${usFederalYear}: ${usFederalNote}. Juneteenth, Independence Day and Veterans Day are already in the US holiday table; both lists apply only where holiday skipping is on.`}
                        checked={state.usFederalHolidays}
                        onChange={(usFederalHolidays) =>
                          setState((previous) => ({
                            ...previous,
                            usFederalHolidays,
                          }))
                        }
                      />
                      <Box maxWidth="360px">
                        <TextField
                          label="US-wide extra days off"
                          value={state.usExtraHolidays}
                          onChange={(usExtraHolidays) =>
                            setState((previous) => ({
                              ...previous,
                              usExtraHolidays,
                            }))
                          }
                          error={usExtraError}
                          placeholder="11-27, 2026-12-23"
                          helpText={`Comma-separated, at most ${US_EXTRA_DATES_MAX} dates. MM-DD repeats every year, YYYY-MM-DD is a one-off — carrier strikes, warehouse closures, Black Friday backlog. These days never count as delivery days for any US buyer while the module is on.`}
                          autoComplete="off"
                        />
                      </Box>
                      <Divider />
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingSm">
                          State overrides
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          Fields left empty inherit the effective US-wide
                          values — the defaults above overlaid by the US
                          country override when one exists. Every other US
                          buyer keeps the US-wide promise.
                        </Text>
                      </BlockStack>
                      {state.usOverrides.length === 0 ? (
                        <Text as="p" tone="subdued" variant="bodySm">
                          No state overrides — every US buyer gets the
                          US-wide window (plus the days off above).
                        </Text>
                      ) : null}
                      {state.usOverrides.map((row, index) => {
                        const errors = usOverrideErrors[index] ?? {};
                        const caution = usMergeCautions[index];
                        return (
                          <BlockStack key={row.id} gap="300">
                            {index > 0 ? <Divider /> : null}
                            <InlineStack
                              gap="300"
                              blockAlign="start"
                              align="space-between"
                              wrap
                            >
                              <Text as="h3" variant="headingSm">
                                {stateLabel(row.state)}
                              </Text>
                              <Button
                                variant="plain"
                                tone="critical"
                                onClick={() => removeUsOverride(row.id)}
                              >
                                Remove
                              </Button>
                            </InlineStack>
                            <InlineStack gap="300" blockAlign="start" wrap>
                              <Box width="160px">
                                <TextField
                                  label="Minimum (days)"
                                  type="number"
                                  value={row.minDays}
                                  onChange={(minDays) =>
                                    setUsRow(row.id, { ...row, minDays })
                                  }
                                  error={errors.minDays}
                                  placeholder={`US-wide: ${usEffectiveMin || "?"}`}
                                  autoComplete="off"
                                />
                              </Box>
                              <Box width="160px">
                                <TextField
                                  label="Maximum (days)"
                                  type="number"
                                  value={row.maxDays}
                                  onChange={(maxDays) =>
                                    setUsRow(row.id, { ...row, maxDays })
                                  }
                                  error={errors.maxDays}
                                  placeholder={`US-wide: ${usEffectiveMax || "?"}`}
                                  autoComplete="off"
                                />
                              </Box>
                              <Box width="220px">
                                <Select
                                  label="Public holidays"
                                  options={[
                                    {
                                      label: `Inherit (${usEffectiveHolidays ? "skip" : "don’t skip"})`,
                                      value: "inherit",
                                    },
                                    { label: "Skip holidays", value: "on" },
                                    {
                                      label: "Don’t skip holidays",
                                      value: "off",
                                    },
                                  ]}
                                  value={row.holidays}
                                  onChange={(holidays) =>
                                    setUsRow(row.id, {
                                      ...row,
                                      holidays: holidays as HolidayMode,
                                    })
                                  }
                                />
                              </Box>
                              <Box width="160px">
                                <TextField
                                  label="Dispatch cutoff"
                                  value={row.cutoff}
                                  onChange={(cutoff) =>
                                    setUsRow(row.id, { ...row, cutoff })
                                  }
                                  error={errors.cutoff}
                                  placeholder={`US-wide: ${usEffectiveCutoff}`}
                                  helpText="24-hour clock, warehouse time"
                                  autoComplete="off"
                                />
                              </Box>
                            </InlineStack>
                            <Checkbox
                              label="Custom delivery weekdays for this state"
                              checked={row.overrideDays}
                              onChange={(overrideDays) =>
                                setUsRow(row.id, { ...row, overrideDays })
                              }
                            />
                            {row.overrideDays ? (
                              <BlockStack gap="100">
                                <InlineStack gap="300" wrap>
                                  {DAY_OPTIONS.map((day) => (
                                    <Checkbox
                                      key={day.iso}
                                      label={day.label}
                                      checked={row.deliveryDays.includes(
                                        day.iso,
                                      )}
                                      onChange={(checked) => {
                                        const set = new Set(row.deliveryDays);
                                        if (checked) set.add(day.iso);
                                        else set.delete(day.iso);
                                        setUsRow(row.id, {
                                          ...row,
                                          deliveryDays: [...set].sort(
                                            (a, b) => a - b,
                                          ),
                                        });
                                      }}
                                    />
                                  ))}
                                </InlineStack>
                                {errors.days ? (
                                  <Text as="p" tone="critical" variant="bodySm">
                                    {errors.days}
                                  </Text>
                                ) : null}
                              </BlockStack>
                            ) : null}
                            <Checkbox
                              label="Custom dispatch days for this state"
                              helpText="With the cutoff above, a PARTIAL dispatch override — the warehouse timezone always inherits (one physical warehouse)."
                              checked={row.overrideDispatchDays}
                              onChange={(overrideDispatchDays) =>
                                setUsRow(row.id, {
                                  ...row,
                                  overrideDispatchDays,
                                })
                              }
                            />
                            {row.overrideDispatchDays ? (
                              <BlockStack gap="100">
                                <InlineStack gap="300" wrap>
                                  {DAY_OPTIONS.map((day) => (
                                    <Checkbox
                                      key={day.iso}
                                      label={day.label}
                                      checked={row.dispatchDays.includes(
                                        day.iso,
                                      )}
                                      onChange={(checked) => {
                                        const set = new Set(row.dispatchDays);
                                        if (checked) set.add(day.iso);
                                        else set.delete(day.iso);
                                        setUsRow(row.id, {
                                          ...row,
                                          dispatchDays: [...set].sort(
                                            (a, b) => a - b,
                                          ),
                                        });
                                      }}
                                    />
                                  ))}
                                </InlineStack>
                                {errors.dispatchDays ? (
                                  <Text as="p" tone="critical" variant="bodySm">
                                    {errors.dispatchDays}
                                  </Text>
                                ) : null}
                              </BlockStack>
                            ) : null}
                            <Box maxWidth="360px">
                              <TextField
                                label="Extra days off for this state"
                                value={row.extraHolidays}
                                onChange={(extraHolidays) =>
                                  setUsRow(row.id, { ...row, extraHolidays })
                                }
                                error={errors.extraHolidays}
                                placeholder="08-27, 2026-09-14"
                                helpText={`Comma-separated, at most ${STATE_EXTRA_DATES_MAX} dates — on top of the US-wide days off above.`}
                                autoComplete="off"
                              />
                            </Box>
                            <Checkbox
                              label="Hide the delivery widget for buyers in this state"
                              helpText="For destinations where no date can honestly be guaranteed. Buyers resolved to this state see nothing — no estimate, no badge — on every surface, checkout included."
                              checked={row.hidden}
                              onChange={(hidden) =>
                                setUsRow(row.id, { ...row, hidden })
                              }
                            />
                            {caution ? (
                              <Text as="p" tone="caution" variant="bodySm">
                                {caution}
                              </Text>
                            ) : null}
                          </BlockStack>
                        );
                      })}
                      <InlineStack gap="300" blockAlign="end" wrap>
                        <Box width="280px">
                          <Select
                            label="Add a state override"
                            options={[
                              { label: "Pick a state…", value: "" },
                              ...Object.keys(US_STATE_OPTIONS)
                                .filter(
                                  (candidate) =>
                                    !state.usOverrides.some(
                                      (row) => row.state === candidate,
                                    ),
                                )
                                .sort((a, b) =>
                                  US_STATE_OPTIONS[a].localeCompare(
                                    US_STATE_OPTIONS[b],
                                  ),
                                )
                                .map((candidate) => ({
                                  label: stateLabel(candidate),
                                  value: candidate,
                                })),
                            ]}
                            value={addStateSelect}
                            onChange={(value) => {
                              setAddStateSelect("");
                              if (value === "") return;
                              addUsOverride(value);
                            }}
                          />
                        </Box>
                      </InlineStack>
                    </BlockStack>
                  </Box>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  State detection database
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Powers product-page and cart state detection: a self-hosted
                  IP→state table served by your own app. The visitor’s IP is
                  checked against it in memory — never stored, never logged,
                  never sent to a third party.
                </Text>
                {geoStatus.status === "empty" ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Not built yet — US buyers keep the US-wide promise on the
                    product page and in the cart (a state picked in the
                    selector still works).
                  </Text>
                ) : null}
                {geoStatus.status === "building" ? (
                  <Text as="p" variant="bodySm">
                    Building —{" "}
                    {geoStatus.rowsScanned !== null
                      ? `${geoStatus.rowsScanned} rows scanned, ${geoStatus.usRowsKept ?? 0} US rows kept so far.`
                      : "downloading and compiling the DB-IP table."}{" "}
                    This card refreshes automatically.
                  </Text>
                ) : null}
                {geoStatus.status === "ready" ? (
                  <Text as="p" variant="bodySm">
                    Ready — {geoStatus.source || "state table"}:{" "}
                    {geoStatus.rangesV4} IPv4 + {geoStatus.rangesV6} IPv6
                    ranges
                    {geoStatus.builtAtLabel
                      ? `, built ${geoStatus.builtAtLabel}`
                      : ""}
                    .
                  </Text>
                ) : null}
                {geoStatus.status === "error" ? (
                  <Text as="p" tone="critical" variant="bodySm">
                    The last build failed: {geoStatus.error || "unknown error"}.
                    Fix the cause (usually connectivity) and run it again.
                  </Text>
                ) : null}
                <InlineStack gap="300" blockAlign="center" wrap>
                  <Button
                    variant="primary"
                    onClick={submitGeoBuild}
                    loading={pendingGeoIntent === "build"}
                    disabled={geoStatus.status === "building"}
                  >
                    Download &amp; build
                  </Button>
                </InlineStack>
                <InlineStack gap="300" blockAlign="end" wrap>
                  <Box width="220px">
                    <TextField
                      label="Test lookup"
                      value={testIp}
                      onChange={setTestIp}
                      placeholder="203.0.113.7"
                      autoComplete="off"
                    />
                  </Box>
                  <Button
                    onClick={submitGeoTest}
                    loading={pendingGeoIntent === "test"}
                    disabled={geoStatus.status !== "ready"}
                  >
                    Test
                  </Button>
                </InlineStack>
                {geoTest ? (
                  <Text
                    as="p"
                    variant="bodySm"
                    tone={geoTest.error ? "critical" : undefined}
                  >
                    {geoTest.error
                      ? geoTest.error
                      : geoTest.state
                        ? `${geoTest.ip} → ${stateLabel(geoTest.state)}`
                        : `${geoTest.ip} → no state resolved (that buyer keeps the US-wide promise)`}
                  </Text>
                ) : null}
                <Text as="p" tone="subdued" variant="bodySm">
                  {geoAttribution}. DB-IP publishes a new City Lite table
                  every month — rebuild monthly to stay accurate. Without
                  this database the product page simply falls back to the
                  US-wide promise; the checkout state promise works
                  regardless — it uses the typed shipping address.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Live example — saved settings
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Computed on the server with the exact storefront rules, from
                  your SAVED settings (save first to see changes here) at the
                  moment this page loaded.
                </Text>
                <Box width="320px">
                  <Select
                    label="For a buyer in"
                    options={exampleOptions}
                    value={exampleCountry}
                    onChange={setExampleCountry}
                  />
                </Box>
                {selectedExample ? (
                  <Box
                    background="bg-surface-secondary"
                    borderRadius="200"
                    padding="400"
                  >
                    {selectedExample.hiddenReason ? (
                      <BlockStack gap="100">
                        <Text as="p" tone="subdued">
                          The widget is hidden right now because{" "}
                          {selectedExample.hiddenReason}.
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          Fail-closed by design — buyers never see a date the
                          math cannot stand behind.
                        </Text>
                      </BlockStack>
                    ) : (
                      <BlockStack gap="100">
                        <Text as="p" variant="headingSm">
                          Ordering right now: ships {selectedExample.ships},
                          delivered{" "}
                          {selectedExample.from === selectedExample.to
                            ? `on ${selectedExample.to}`
                            : `${selectedExample.from} – ${selectedExample.to}`}
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          Guarantee (badge tooltip): “Delivered on or before{" "}
                          {selectedExample.to} — or we refund you or send a
                          free replacement.”
                        </Text>
                      </BlockStack>
                    )}
                  </Box>
                ) : null}
                {!state.enabled ? (
                  <Text as="p" tone="caution" variant="bodySm">
                    The feature is currently disabled — buyers see nothing
                    until you enable it above and save.
                  </Text>
                ) : null}
              </BlockStack>
            </Card>

            <MarketScopeCard
              title="Markets"
              markets={markets}
              scope={state.scopes.delivery_estimate}
              onChange={(scope) =>
                setState((previous) => ({
                  ...previous,
                  scopes: { ...previous.scopes, delivery_estimate: scope },
                }))
              }
            />

            <MarketProductExclusionsCard
              title="Excluded products"
              description="Products excluded for a market never show the delivery promise on their own product page there, and a cart or checkout containing one hides the delivery promise for that whole order."
              markets={markets}
              value={state.excluded}
              titles={exclusionTitles}
              disabled={isSaving}
              onChange={(next) =>
                setState((previous) => ({ ...previous, excluded: next }))
              }
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
