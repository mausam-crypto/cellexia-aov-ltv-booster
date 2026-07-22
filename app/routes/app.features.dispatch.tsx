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
  Divider,
  InlineStack,
  Layout,
  Page,
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
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { listMarkets } from "../services/markets.server";
import { FeaturePageHeader } from "../components/FeaturePageHeader";

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
// Dispatch schedule validation (shared shapes between action and client)
// ---------------------------------------------------------------------------

/** "HH:MM", 24-hour clock. Mirrors the sanitizer in settings.server.ts. */
const CUTOFF_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** IANA region/city names (plus bare "UTC") — the storefront runtime only
 *  trusts this shape, so anything else must be rejected loudly here rather
 *  than silently replaced by the sanitizer. */
const TIMEZONE_SHAPE_PATTERN = /^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$|^UTC$/;
const ISO2_PATTERN = /^[A-Z]{2}$/;

/**
 * The authoritative timezone check: the Intl probe accepts exactly what the
 * storefront's Intl.DateTimeFormat-based countdown can resolve, and the shape
 * pattern keeps legacy aliases ("EST", "GMT") out so the stored value always
 * survives the settings sanitizer unchanged.
 */
function isUsableTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !TIMEZONE_SHAPE_PATTERN.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isValidDaysArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
  );
}

/**
 * Fail-loud guard for the dispatch section of an incoming patch. The generic
 * sanitizer would fall back to defaults (or drop byCountry entries) silently;
 * a merchant typing a bad IANA name must get an error instead of a schedule
 * that quietly points at Europe/Paris.
 */
function validateDispatchPatch(patch: DeepPartial<BoosterSettings>): string[] {
  const errors: string[] = [];
  const dispatch = patch.dispatch;
  if (dispatch === undefined || dispatch === null) return errors;
  if (typeof dispatch !== "object" || Array.isArray(dispatch)) {
    return ["The dispatch settings payload must be an object."];
  }
  if (
    dispatch.cutoff !== undefined &&
    (typeof dispatch.cutoff !== "string" || !CUTOFF_PATTERN.test(dispatch.cutoff))
  ) {
    errors.push("The default cutoff must be a 24-hour time like 14:00.");
  }
  if (dispatch.timezone !== undefined && !isUsableTimeZone(dispatch.timezone)) {
    errors.push(
      `"${String(dispatch.timezone)}" is not a valid IANA timezone — use a Region/City name like Europe/Paris, or UTC.`,
    );
  }
  if (dispatch.days !== undefined && !isValidDaysArray(dispatch.days)) {
    errors.push("Pick at least one dispatch day (Monday to Sunday).");
  }
  if (
    dispatch.showWithinHours !== undefined &&
    (typeof dispatch.showWithinHours !== "number" ||
      !Number.isInteger(dispatch.showWithinHours) ||
      dispatch.showWithinHours < 1 ||
      dispatch.showWithinHours > 24)
  ) {
    errors.push("The display window must be a whole number of hours from 1 to 24.");
  }
  if (dispatch.byCountry !== undefined) {
    if (
      typeof dispatch.byCountry !== "object" ||
      dispatch.byCountry === null ||
      Array.isArray(dispatch.byCountry)
    ) {
      errors.push("Country overrides must be a map of ISO country codes.");
    } else {
      for (const [code, entry] of Object.entries(dispatch.byCountry)) {
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
        // byCountry is replaced wholesale on save, so every entry must be
        // complete — a partial entry would be dropped silently by the
        // sanitizer and the merchant would never know.
        if (
          typeof entry.cutoff !== "string" ||
          !CUTOFF_PATTERN.test(entry.cutoff)
        ) {
          errors.push(
            `The cutoff for ${label} must be a 24-hour time like 14:00.`,
          );
        }
        if (!isUsableTimeZone(entry.timezone)) {
          errors.push(
            `The timezone for ${label} ("${String(entry.timezone)}") is not a valid IANA timezone — use a Region/City name like America/New_York.`,
          );
        }
        if (!isValidDaysArray(entry.days)) {
          errors.push(`Pick at least one dispatch day for ${label}.`);
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
  // Dispatch-specific validation runs BEFORE the save: invalid schedules must
  // never be stored (the storefront fails closed to hidden, but the merchant
  // deserves a loud error, not a silently "fixed" schedule).
  const dispatchErrors = validateDispatchPatch(patch);
  if (dispatchErrors.length > 0) {
    return { ok: false, syncErrors: dispatchErrors };
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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const [settings, markets] = await Promise.all([
    getSettings(session.shop),
    listMarkets(admin),
  ]);
  return {
    settings,
    markets,
    // Combined flag for the shared page header (cheap — settings loaded).
    headerEnabled: resolveFeatureFlag(settings, "dispatch_countdown"),
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

/** Scope as persisted — an "all" scope never stores a markets list. The UI
 *  keeps the previous hand-picked list in local state so flipping back to
 *  "Selected markets" restores it; only the save patch strips it. */
function toScopePatch(scope: ScopeState): ScopeState {
  return scope.mode === "all" ? { mode: "all", markets: [] } : scope;
}

function scopesToPatch<K extends string>(
  scopes: Record<K, ScopeState>,
): Record<K, ScopeState> {
  return Object.fromEntries(
    (Object.entries(scopes) as [K, ScopeState][]).map(([key, scope]) => [
      key,
      toScopePatch(scope),
    ]),
  ) as Record<K, ScopeState>;
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
        ? // Keep the hand-picked list in local state so switching back to
          // "Selected markets" restores it — the save patch strips it.
          { mode: "all", markets: [...scope.markets] }
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
// Schedule form state + shared editor
// ---------------------------------------------------------------------------

/** Sentinel value of the timezone Select's free-text escape hatch. */
const OTHER_TIMEZONE = "__other__";

const TIMEZONE_GROUPS: { title: string; zones: string[] }[] = [
  {
    title: "Europe",
    zones: [
      "Europe/Paris",
      "Europe/London",
      "Europe/Berlin",
      "Europe/Madrid",
      "Europe/Rome",
      "Europe/Amsterdam",
      "Europe/Brussels",
      "Europe/Dublin",
      "Europe/Stockholm",
      "Europe/Warsaw",
      "Europe/Lisbon",
      "Europe/Athens",
    ],
  },
  {
    title: "Americas",
    zones: [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "America/Toronto",
      "America/Vancouver",
      "America/Mexico_City",
      "America/Sao_Paulo",
    ],
  },
  {
    title: "Asia-Pacific",
    zones: [
      "Asia/Tokyo",
      "Asia/Shanghai",
      "Asia/Hong_Kong",
      "Asia/Singapore",
      "Asia/Seoul",
      "Asia/Kolkata",
      "Asia/Dubai",
      "Australia/Sydney",
      "Australia/Melbourne",
      "Pacific/Auckland",
    ],
  },
];

const KNOWN_TIMEZONES = new Set(
  TIMEZONE_GROUPS.flatMap((group) => group.zones),
);

const TIMEZONE_SELECT_OPTIONS = [
  ...TIMEZONE_GROUPS.map((group) => ({
    title: group.title,
    options: group.zones.map((zone) => ({ label: zone, value: zone })),
  })),
  {
    title: "Custom",
    options: [{ label: "Other (type IANA name)", value: OTHER_TIMEZONE }],
  },
];

const DAY_OPTIONS: { iso: number; label: string }[] = [
  { iso: 1, label: "Mon" },
  { iso: 2, label: "Tue" },
  { iso: 3, label: "Wed" },
  { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" },
  { iso: 6, label: "Sat" },
  { iso: 7, label: "Sun" },
];

const SHOW_WITHIN_OPTIONS = ["2", "4", "6", "8", "12", "24"].map((hours) => ({
  label: `${hours} hours before the cutoff`,
  value: hours,
}));

interface ScheduleFieldsState {
  cutoff: string;
  /** A known zone from the Select, or OTHER_TIMEZONE. */
  timezoneSelect: string;
  /** Free-text IANA name, used only when timezoneSelect is OTHER_TIMEZONE. */
  timezoneCustom: string;
  days: number[];
}

interface OverrideRowState extends ScheduleFieldsState {
  /** Client-only stable list key — never persisted, stripped from compares. */
  id: number;
  country: string;
}

interface DispatchFormState {
  enabled: boolean;
  schedule: ScheduleFieldsState;
  showWithinHours: string;
  showOnPdp: boolean;
  showInCart: boolean;
  overrides: OverrideRowState[];
  scopes: {
    dispatch_countdown: ScopeState;
  };
}

function effectiveTimezone(fields: ScheduleFieldsState): string {
  return fields.timezoneSelect === OTHER_TIMEZONE
    ? fields.timezoneCustom.trim()
    : fields.timezoneSelect;
}

function toScheduleFields(cutoff: string, timezone: string): ScheduleFieldsState {
  return KNOWN_TIMEZONES.has(timezone)
    ? { cutoff, timezoneSelect: timezone, timezoneCustom: "", days: [] }
    : {
        cutoff,
        timezoneSelect: OTHER_TIMEZONE,
        timezoneCustom: timezone,
        days: [],
      };
}

function initialFormState(settings: BoosterSettings): DispatchFormState {
  const dispatch = settings.dispatch;
  const overrides: OverrideRowState[] = Object.entries(dispatch.byCountry)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([country, entry], index) => ({
      ...toScheduleFields(entry.cutoff, entry.timezone),
      days: [...entry.days],
      id: index,
      country,
    }));
  return {
    enabled: dispatch.enabled,
    schedule: {
      ...toScheduleFields(dispatch.cutoff, dispatch.timezone),
      days: [...dispatch.days],
    },
    showWithinHours: String(dispatch.showWithinHours),
    showOnPdp: dispatch.showOnPdp,
    showInCart: dispatch.showInCart,
    overrides,
    scopes: {
      dispatch_countdown: toScopeState(settings.marketScopes.dispatch_countdown),
    },
  };
}

/** Dirty-check serialization: schedules compare by their EFFECTIVE values
 *  (picking "Other" and typing Europe/Paris equals selecting it directly) and
 *  override rows lose their client-only ids, so add-then-remove is clean. */
function serializeForCompare(state: DispatchFormState): string {
  const schedule = (fields: ScheduleFieldsState) => ({
    cutoff: fields.cutoff,
    timezone: effectiveTimezone(fields),
    days: [...fields.days].sort((a, b) => a - b),
  });
  return JSON.stringify({
    enabled: state.enabled,
    schedule: schedule(state.schedule),
    showWithinHours: state.showWithinHours,
    showOnPdp: state.showOnPdp,
    showInCart: state.showInCart,
    overrides: state.overrides.map((row) => ({
      country: row.country.trim().toUpperCase(),
      ...schedule(row),
    })),
    scopes: scopesToPatch(state.scopes),
  });
}

interface ScheduleErrors {
  cutoff?: string;
  timezone?: string;
  days?: string;
}

/** Client-side mirror of the action's schedule validation (the browser has
 *  the same Intl probe, so feedback is immediate). */
function scheduleErrors(fields: ScheduleFieldsState): ScheduleErrors {
  const errors: ScheduleErrors = {};
  if (!CUTOFF_PATTERN.test(fields.cutoff)) {
    errors.cutoff = "24-hour time, e.g. 14:00";
  }
  const timezone = effectiveTimezone(fields);
  if (timezone === "") {
    errors.timezone = "Type an IANA timezone, e.g. Europe/Paris";
  } else if (!isUsableTimeZone(timezone)) {
    errors.timezone = `"${timezone}" is not a valid IANA timezone`;
  }
  if (fields.days.length === 0) {
    errors.days = "Pick at least one dispatch day.";
  }
  return errors;
}

function hasScheduleErrors(errors: ScheduleErrors): boolean {
  return Boolean(errors.cutoff || errors.timezone || errors.days);
}

interface ScheduleFieldsEditorProps {
  fields: ScheduleFieldsState;
  errors: ScheduleErrors;
  onChange: (next: ScheduleFieldsState) => void;
  /** Compact rows (country overrides) hide the day-error under the group. */
  dayLabelPrefix: string;
}

function ScheduleFieldsEditor({
  fields,
  errors,
  onChange,
  dayLabelPrefix,
}: ScheduleFieldsEditorProps) {
  const toggleDay = (iso: number, checked: boolean) => {
    const set = new Set(fields.days);
    if (checked) set.add(iso);
    else set.delete(iso);
    onChange({ ...fields, days: [...set].sort((a, b) => a - b) });
  };
  return (
    <BlockStack gap="300">
      <InlineStack gap="300" wrap>
        <Box width="160px">
          <TextField
            label="Cutoff time"
            value={fields.cutoff}
            onChange={(cutoff) => onChange({ ...fields, cutoff })}
            error={errors.cutoff}
            placeholder="14:00"
            helpText="24-hour clock, warehouse time"
            autoComplete="off"
          />
        </Box>
        <Box width="280px">
          <Select
            label="Warehouse timezone"
            options={TIMEZONE_SELECT_OPTIONS}
            value={fields.timezoneSelect}
            onChange={(timezoneSelect) => onChange({ ...fields, timezoneSelect })}
            error={
              fields.timezoneSelect === OTHER_TIMEZONE
                ? undefined
                : errors.timezone
            }
          />
        </Box>
        {fields.timezoneSelect === OTHER_TIMEZONE ? (
          <Box width="280px">
            <TextField
              label="IANA timezone name"
              value={fields.timezoneCustom}
              onChange={(timezoneCustom) =>
                onChange({ ...fields, timezoneCustom })
              }
              error={errors.timezone}
              placeholder="Europe/Paris"
              helpText="Region/City name, e.g. Africa/Casablanca"
              autoComplete="off"
            />
          </Box>
        ) : null}
      </InlineStack>
      <BlockStack gap="100">
        <Text as="span" variant="bodySm" tone="subdued">
          {dayLabelPrefix} dispatch days
        </Text>
        <InlineStack gap="300" wrap>
          {DAY_OPTIONS.map((day) => (
            <Checkbox
              key={day.iso}
              label={day.label}
              checked={fields.days.includes(day.iso)}
              onChange={(checked) => toggleDay(day.iso, checked)}
            />
          ))}
        </InlineStack>
        {errors.days ? (
          <Text as="p" tone="critical" variant="bodySm">
            {errors.days}
          </Text>
        ) : null}
      </BlockStack>
    </BlockStack>
  );
}

// ---------------------------------------------------------------------------
// Live preview — the exact credibility-rule evaluation a buyer's browser runs
// ---------------------------------------------------------------------------

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Current wall-clock in `timezone` via Intl.formatToParts — the same logic
 *  the storefront widget uses; a bad timezone returns null (fail closed). */
function zonedNowParts(
  timezone: string,
  now: Date,
): { isoDay: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    let weekday = "";
    let hour = -1;
    let minute = -1;
    for (const part of parts) {
      if (part.type === "weekday") weekday = part.value;
      else if (part.type === "hour") hour = Number(part.value);
      else if (part.type === "minute") minute = Number(part.value);
    }
    const isoDay = WEEKDAY_TO_ISO[weekday];
    if (
      !isoDay ||
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23 ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    ) {
      return null;
    }
    return { isoDay, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

type PreviewStatus =
  | { kind: "visible"; remainingMinutes: number; localCutoffText: string }
  | { kind: "hidden"; reason: string };

/**
 * CREDIBILITY RULES (absolute): visible ONLY when the next cutoff is TODAY in
 * the schedule's timezone, today is a configured dispatch day, and no more
 * than showWithinHours remain. Any invalid configuration fails closed to
 * hidden — never fabricate urgency.
 */
function dispatchPreviewStatus(
  schedule: {
    cutoff: string;
    timezone: string;
    days: number[];
    showWithinHours: number;
  },
  now: Date,
): PreviewStatus {
  if (!CUTOFF_PATTERN.test(schedule.cutoff)) {
    return {
      kind: "hidden",
      reason: "the cutoff time is invalid, so the countdown fails closed",
    };
  }
  if (schedule.days.length === 0) {
    return {
      kind: "hidden",
      reason: "no dispatch days are selected, so the countdown fails closed",
    };
  }
  const zoned = zonedNowParts(schedule.timezone, now);
  if (!zoned) {
    return {
      kind: "hidden",
      reason: `"${schedule.timezone}" is not a resolvable timezone, so the countdown fails closed`,
    };
  }
  if (!schedule.days.includes(zoned.isoDay)) {
    return {
      kind: "hidden",
      reason: `today is not a dispatch day in ${schedule.timezone}`,
    };
  }
  const [hours, minutes] = schedule.cutoff.split(":").map(Number);
  const remaining = hours * 60 + minutes - zoned.minutes;
  if (remaining <= 0) {
    return {
      kind: "hidden",
      reason: `today's ${schedule.cutoff} cutoff (${schedule.timezone}) has already passed`,
    };
  }
  if (remaining > schedule.showWithinHours * 60) {
    return {
      kind: "hidden",
      reason: `more than ${schedule.showWithinHours} hours remain before the ${schedule.cutoff} cutoff — the countdown appears once ${schedule.showWithinHours} hours or less remain`,
    };
  }
  // The remaining minutes are timezone-independent, so the cutoff instant is
  // simply now + remaining — formatted in the viewer's local clock exactly
  // like the storefront widget does for buyers.
  const cutoffInstant = new Date(now.getTime() + remaining * 60000);
  let localCutoffText: string;
  try {
    localCutoffText = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(cutoffInstant);
  } catch {
    localCutoffText = schedule.cutoff;
  }
  return { kind: "visible", remainingMinutes: remaining, localCutoffText };
}

function formatRemaining(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function DispatchFeaturesPage() {
  const { settings, markets, headerEnabled } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<DispatchFormState>(() =>
    initialFormState(settings),
  );
  /** Monotonic id source for new override rows (initial rows use 0..n-1). */
  const [nextRowId, setNextRowId] = useState(
    () => Object.keys(settings.dispatch.byCountry).length,
  );

  useEffect(() => {
    setState(initialFormState(settings));
    // Re-seed the row-id counter past the rebuilt rows (ids 0..n-1) so a row
    // added after a revalidation can never collide with an initial row.
    setNextRowId(Object.keys(settings.dispatch.byCountry).length);
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

  // Live clock for the preview card — set on mount only (a server-rendered
  // "now" would hydrate differently and mismatch), then ticked every 15s.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(timer);
  }, []);

  const initial = useMemo(() => initialFormState(settings), [settings]);
  const dirty = serializeForCompare(state) !== serializeForCompare(initial);
  const isSaving =
    navigation.state !== "idle" && navigation.formMethod === "POST";

  // --- Validation ----------------------------------------------------------
  const defaultErrors = scheduleErrors(state.schedule);
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
    return { country, schedule: scheduleErrors(row) };
  });
  const hasErrors =
    hasScheduleErrors(defaultErrors) ||
    overrideErrors.some(
      (errors) => errors.country || hasScheduleErrors(errors.schedule),
    );

  // --- Handlers ------------------------------------------------------------
  const setSchedule = (schedule: ScheduleFieldsState) =>
    setState((previous) => ({ ...previous, schedule }));

  const setOverride = (id: number, next: OverrideRowState) =>
    setState((previous) => ({
      ...previous,
      overrides: previous.overrides.map((row) => (row.id === id ? next : row)),
    }));

  const addOverride = () => {
    setState((previous) => ({
      ...previous,
      overrides: [
        ...previous.overrides,
        {
          // New rows start from the current default schedule — the common
          // case is "same cutoff, different timezone".
          id: nextRowId,
          country: "",
          cutoff: previous.schedule.cutoff,
          timezoneSelect: previous.schedule.timezoneSelect,
          timezoneCustom: previous.schedule.timezoneCustom,
          days: [...previous.schedule.days],
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

  const handleSave = () => {
    // byCountry is a dynamic record replaced WHOLESALE by the settings merge
    // — always send the full map (an empty object clears every override).
    const byCountry = Object.fromEntries(
      state.overrides.map((row) => [
        row.country.trim().toUpperCase(),
        {
          cutoff: row.cutoff,
          timezone: effectiveTimezone(row),
          days: [...row.days].sort((a, b) => a - b),
        },
      ]),
    );
    const patch: DeepPartial<BoosterSettings> = {
      dispatch: {
        enabled: state.enabled,
        cutoff: state.schedule.cutoff,
        timezone: effectiveTimezone(state.schedule),
        days: [...state.schedule.days].sort((a, b) => a - b),
        showWithinHours: Number(state.showWithinHours),
        showOnPdp: state.showOnPdp,
        showInCart: state.showInCart,
        byCountry,
      },
      marketScopes: scopesToPatch(state.scopes),
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  // --- Live preview --------------------------------------------------------
  const previewStatus = now
    ? dispatchPreviewStatus(
        {
          cutoff: state.schedule.cutoff,
          timezone: effectiveTimezone(state.schedule),
          days: state.schedule.days,
          showWithinHours: Number(state.showWithinHours) || 8,
        },
        now,
      )
    : null;

  return (
    <Page
      title="Dispatch countdown"
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
      <TitleBar title="Dispatch countdown" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="dispatch_countdown"
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
                  Dispatch countdown
                </Text>
                <Checkbox
                  label="Enable the dispatch countdown"
                  helpText="“Order within 2h 14m for same-day dispatch” on product pages and in the cart drawer. The cutoff is defined in your warehouse timezone; buyers also see it converted to their own local clock."
                  checked={state.enabled}
                  onChange={(enabled) =>
                    setState((previous) => ({ ...previous, enabled }))
                  }
                />
                <Banner tone="info" title="Only real urgency is ever shown">
                  <BlockStack gap="100">
                    <Text as="p">
                      The countdown appears ONLY when all three are true: the
                      next cutoff is today in the schedule’s timezone, today is
                      one of your dispatch days, and the remaining time is
                      within the display window below. Outside that window —
                      evenings, weekends, holidays you unchecked — buyers see
                      nothing at all.
                    </Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                      An invalid schedule (bad time or timezone) also renders
                      nothing: the widget fails closed to hidden rather than
                      showing a wrong promise. Fabricated urgency is never an
                      option.
                    </Text>
                  </BlockStack>
                </Banner>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Default schedule
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Used for every buyer without a country override below.
                </Text>
                <ScheduleFieldsEditor
                  fields={state.schedule}
                  errors={defaultErrors}
                  onChange={setSchedule}
                  dayLabelPrefix="Same-day"
                />
                <Divider />
                <InlineStack gap="300" wrap>
                  <Box width="280px">
                    <Select
                      label="Show the countdown only within"
                      options={SHOW_WITHIN_OPTIONS}
                      value={state.showWithinHours}
                      onChange={(showWithinHours) =>
                        setState((previous) => ({
                          ...previous,
                          showWithinHours,
                        }))
                      }
                      helpText="A countdown far from the deadline is noise, not urgency."
                    />
                  </Box>
                </InlineStack>
                <BlockStack gap="100">
                  <Checkbox
                    label="Show on product pages"
                    helpText="Next to the stock message."
                    checked={state.showOnPdp}
                    onChange={(showOnPdp) =>
                      setState((previous) => ({ ...previous, showOnPdp }))
                    }
                  />
                  <Checkbox
                    label="Show in the cart drawer"
                    helpText="Above the checkout actions."
                    checked={state.showInCart}
                    onChange={(showInCart) =>
                      setState((previous) => ({ ...previous, showInCart }))
                    }
                  />
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Country overrides
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  For multi-warehouse setups: buyers in these countries get
                  their own cutoff, timezone and dispatch days instead of the
                  default schedule. Everyone else keeps the default.
                </Text>
                {state.overrides.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No overrides — every buyer follows the default schedule.
                  </Text>
                ) : null}
                {state.overrides.map((row, index) => (
                  <BlockStack key={row.id} gap="300">
                    {index > 0 ? <Divider /> : null}
                    <InlineStack
                      gap="300"
                      blockAlign="start"
                      align="space-between"
                      wrap
                    >
                      <Box width="160px">
                        <TextField
                          label="Country (ISO2)"
                          value={row.country}
                          onChange={(country) =>
                            setOverride(row.id, {
                              ...row,
                              country: country.toUpperCase(),
                            })
                          }
                          error={overrideErrors[index]?.country}
                          placeholder="DE"
                          maxLength={2}
                          autoComplete="off"
                        />
                      </Box>
                      <Button
                        variant="plain"
                        tone="critical"
                        onClick={() => removeOverride(row.id)}
                      >
                        Remove
                      </Button>
                    </InlineStack>
                    <ScheduleFieldsEditor
                      fields={row}
                      errors={overrideErrors[index]?.schedule ?? {}}
                      onChange={(fields) =>
                        setOverride(row.id, { ...row, ...fields })
                      }
                      dayLabelPrefix="Same-day"
                    />
                  </BlockStack>
                ))}
                <InlineStack>
                  <Button onClick={addOverride}>Add country override</Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Live preview — default schedule
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Exactly what a buyer on the default schedule would see right
                  now, evaluated with the same rules as the storefront widget.
                </Text>
                {!previewStatus ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Computing the live preview…
                  </Text>
                ) : previewStatus.kind === "visible" ? (
                  <BlockStack gap="200">
                    <Box
                      background="bg-surface-secondary"
                      borderRadius="200"
                      padding="400"
                    >
                      <BlockStack gap="100">
                        <Text as="p" variant="headingSm">
                          Order within{" "}
                          {formatRemaining(previewStatus.remainingMinutes)} for
                          same-day dispatch
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          Cutoff {state.schedule.cutoff} (
                          {effectiveTimezone(state.schedule)}) —{" "}
                          {previewStatus.localCutoffText} in your local time.
                        </Text>
                      </BlockStack>
                    </Box>
                    {!state.enabled ? (
                      <Text as="p" tone="caution" variant="bodySm">
                        The feature is currently disabled — buyers see nothing
                        until you enable it above and save.
                      </Text>
                    ) : null}
                  </BlockStack>
                ) : (
                  <BlockStack gap="200">
                    <Box
                      background="bg-surface-secondary"
                      borderRadius="200"
                      padding="400"
                    >
                      <Text as="p" tone="subdued">
                        Hidden right now because {previewStatus.reason}.
                      </Text>
                    </Box>
                    <Text as="p" tone="subdued" variant="bodySm">
                      This is by design, not a bug: the countdown only appears
                      when same-day dispatch is genuinely available and the
                      deadline is close enough to matter. It will show again
                      automatically once the conditions are met.
                    </Text>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <MarketScopeCard
              title="Markets"
              markets={markets}
              scope={state.scopes.dispatch_countdown}
              onChange={(scope) =>
                setState((previous) => ({
                  ...previous,
                  scopes: { ...previous.scopes, dispatch_countdown: scope },
                }))
              }
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
