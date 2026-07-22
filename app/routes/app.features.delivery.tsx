import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
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
  type BoosterSettings,
  type DeepPartial,
  type DeliveryCountryOverride,
} from "../models/settings.server";
import {
  DELIVERY_HOLIDAYS,
  GLOBAL_DELIVERY_EXCLUSIONS,
} from "../services/delivery-holidays.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { listMarkets } from "../services/markets.server";
import { FeaturePageHeader } from "../components/FeaturePageHeader";

/**
 * Delivery estimate + delivery guarantee (v5.9) — feature settings page.
 *
 * Modeled on the dispatch countdown page: the same fail-loud validation
 * (invalid input is refused with an error, never silently "fixed"), the same
 * wholesale byCountry save semantics, and the same credibility stance — the
 * storefront widget NEVER shows a date it cannot stand behind; any
 * inconsistency fails closed to hidden.
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface SettingsSaveResult {
  ok: boolean;
  syncErrors: string[];
}

// ---------------------------------------------------------------------------
// Shared validation shapes (mirrored client-side for instant feedback)
// ---------------------------------------------------------------------------

const ISO2_PATTERN = /^[A-Z]{2}$/;

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
  /** ISO2 code, or "" for "every other country" (defaults only). */
  code: string;
  ships: string | null;
  from: string | null;
  to: string | null;
  hiddenReason: string | null;
}

/**
 * Computes the example a buyer in `country` would see right now, with the
 * exact storefront rules: dispatch date from the dispatch schedule (incl.
 * its byCountry override), then business-day counting in the destination
 * country (deliveryDays + global exclusions + fixed-date holidays).
 */
function computeExample(
  settings: BoosterSettings,
  country: string,
  now: Date,
): DeliveryExample {
  const hidden = (hiddenReason: string): DeliveryExample => ({
    code: country,
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
  const minDays = override.minDays ?? de.minDays;
  const maxDays = override.maxDays ?? de.maxDays;
  const deliveryDays = override.deliveryDays ?? de.deliveryDays;
  const holidaysEnabled = override.holidaysEnabled ?? de.holidaysEnabled;
  if (
    !isIntInRange(minDays, 0, 30) ||
    !isIntInRange(maxDays, 1, 30) ||
    maxDays < Math.max(1, minDays) ||
    !isValidDaysArray(deliveryDays)
  ) {
    return hidden("the resolved delivery window is invalid — fails closed");
  }

  // 1. Dispatch day, from the dispatch schedule (warehouse config — used
  //    even while the dispatch_countdown feature itself is off).
  const schedule =
    (country ? settings.dispatch.byCountry[country] : undefined) ??
    settings.dispatch;
  const zoned = zonedNow(schedule.timezone, now);
  if (!zoned) {
    return hidden(
      `the warehouse timezone ("${schedule.timezone}") cannot be resolved — fails closed`,
    );
  }
  const cutoffMinutes =
    Number(schedule.cutoff.slice(0, 2)) * 60 + Number(schedule.cutoff.slice(3, 5));
  let dispatchMs: number | null = null;
  if (
    schedule.days.includes(zoned.isoDay) &&
    Number.isFinite(cutoffMinutes) &&
    zoned.minutes < cutoffMinutes
  ) {
    dispatchMs = zoned.dateMs;
  } else {
    for (let offset = 1; offset <= 14; offset += 1) {
      const candidate = zoned.dateMs + offset * MS_DAY;
      if (schedule.days.includes(isoWeekdayUtc(candidate))) {
        dispatchMs = candidate;
        break;
      }
    }
  }
  if (dispatchMs === null) {
    return hidden("no dispatch day within 14 days — fails closed");
  }

  // 2. Delivery dates — count business days in the destination country.
  const holidays =
    holidaysEnabled && country ? (DELIVERY_HOLIDAYS[country] ?? []) : [];
  const qualifies = (ms: number): boolean => {
    const mmdd = mmddUtc(ms);
    return (
      deliveryDays.includes(isoWeekdayUtc(ms)) &&
      !GLOBAL_DELIVERY_EXCLUSIONS.includes(mmdd) &&
      !holidays.includes(mmdd)
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
    code: country,
    ships: formatExampleDate(dispatchMs),
    from: formatExampleDate(minMs),
    to: formatExampleDate(maxMs),
    hiddenReason: null,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const [settings, markets] = await Promise.all([
    getSettings(session.shop),
    listMarkets(admin),
  ]);
  const now = new Date();
  const exampleCodes = [
    ...new Set([
      ...Object.keys(DELIVERY_HOLIDAYS),
      ...Object.keys(settings.deliveryEstimate.byCountry),
      ...Object.keys(settings.dispatch.byCountry),
    ]),
  ].sort();
  return {
    settings,
    markets,
    headerEnabled: resolveFeatureFlag(settings, "delivery_estimate"),
    // Canonical holiday data, passed through the loader — the component must
    // never import the .server module directly.
    holidayTable: DELIVERY_HOLIDAYS,
    globalExclusions: [...GLOBAL_DELIVERY_EXCLUSIONS],
    // "Ordering right now" examples per country, computed SERVER-SIDE with
    // the exact storefront rules, from the SAVED settings.
    examples: [
      computeExample(settings, "", now),
      ...exampleCodes.map((code) => computeExample(settings, code, now)),
    ],
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
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
    scopes: { delivery_estimate: toScopePatch(state.scopes.delivery_estimate) },
  });
}

function parseDaysField(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return parsed;
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
  const { settings, markets, headerEnabled, holidayTable, globalExclusions, examples } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<DeliveryFormState>(() =>
    initialFormState(settings),
  );
  /** Monotonic id source for new override rows (initial rows use 0..n-1). */
  const [nextRowId, setNextRowId] = useState(
    () => Object.keys(settings.deliveryEstimate.byCountry).length,
  );
  const [addCountrySelect, setAddCountrySelect] = useState("");
  const [exampleCountry, setExampleCountry] = useState("");

  useEffect(() => {
    setState(initialFormState(settings));
    setNextRowId(Object.keys(settings.deliveryEstimate.byCountry).length);
  }, [settings]);

  useEffect(() => {
    if (!actionData) return;
    if (!actionData.ok) {
      shopify.toast.show("Could not save settings", { isError: true });
    } else if (actionData.syncErrors.length > 0) {
      shopify.toast.show("Saved, but the storefront sync failed", {
        isError: true,
      });
    } else {
      shopify.toast.show("Saved");
    }
  }, [actionData, shopify]);

  const initial = useMemo(() => initialFormState(settings), [settings]);
  const dirty = serializeForCompare(state) !== serializeForCompare(initial);
  const isSaving =
    navigation.state !== "idle" && navigation.formMethod === "POST";

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
  const hasErrors =
    Boolean(
      defaultWindowErrors.minDays ||
        defaultWindowErrors.maxDays ||
        defaultWindowErrors.days,
    ) ||
    overrideErrors.some(
      (errors) => errors.country || errors.minDays || errors.maxDays || errors.days,
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

  const toggleDefaultDay = (iso: number, checked: boolean) => {
    setState((previous) => {
      const set = new Set(previous.deliveryDays);
      if (checked) set.add(iso);
      else set.delete(iso);
      return { ...previous, deliveryDays: [...set].sort((a, b) => a - b) };
    });
  };

  const handleSave = () => {
    // byCountry is a dynamic record replaced WHOLESALE by the settings merge
    // — always send the full map (an empty object clears every override).
    const byCountry = Object.fromEntries(
      state.overrides.map((row) => [
        row.country.trim().toUpperCase(),
        rowToOverride(row),
      ]),
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
        label: countryLabel(example.code),
        value: example.code,
      })),
  ];
  const selectedExample =
    examples.find((example) => example.code === exampleCountry) ?? examples[0];

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

        {actionData && actionData.syncErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone={actionData.ok ? "warning" : "critical"}
              title={
                actionData.ok
                  ? "Saved, but the storefront sync reported errors"
                  : "Settings could not be saved"
              }
            >
              <BlockStack gap="100">
                {actionData.syncErrors.map((error) => (
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
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
