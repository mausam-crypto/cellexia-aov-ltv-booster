import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  Collapsible,
  InlineStack,
  Layout,
  Page,
  RadioButton,
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
    headerEnabled: resolveFeatureFlag(settings, "derm_survey"),
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
// Page
// ---------------------------------------------------------------------------

/**
 * The five display formats (client-safe literal mirror of the server-only
 * DERM_SURVEY_FORMATS enum — the settings sanitizer is the authoritative
 * whitelist). Each presents the SAME numbers through a different trust
 * mechanism; none imitates a certification mark.
 */
const SURVEY_FORMATS = [
  {
    value: "seal",
    label: "Authority seal",
    description:
      "A large circular proof seal — the ring arc fills to your exact percentage.",
  },
  {
    value: "report",
    label: "Data transparency",
    description:
      "A clinical results panel — the raw numbers in ruled label/value rows.",
  },
  {
    value: "question",
    label: "The exact question asked",
    description:
      "The verbatim survey question as a large quote, with the result as the payoff.",
  },
  {
    value: "tally",
    label: "One dot per dermatologist",
    description:
      "A dot matrix — every dermatologist surveyed is one dot; “Yes” answers are filled.",
  },
  {
    value: "strip",
    label: "Understated line",
    description:
      "One restrained line with the percentage between hairline rules. No graphics.",
  },
] as const;
type SurveyFormatValue = (typeof SURVEY_FORMATS)[number]["value"];

function toFormatValue(value: string): SurveyFormatValue {
  return SURVEY_FORMATS.some((format) => format.value === value)
    ? (value as SurveyFormatValue)
    : "seal";
}

interface SurveyFormState {
  enabled: boolean;
  /** Total dermatologists surveyed (settings.dermSurvey.sampleSize). */
  sampleSize: string;
  /** Dermatologists who answered "Yes" (settings.dermSurvey.yesCount). */
  yesCount: string;
  verifierName: string;
  verificationUrl: string;
  methodology: string;
  format: SurveyFormatValue;
  scopes: {
    derm_survey: ScopeState;
  };
}

function initialFormState(settings: BoosterSettings): SurveyFormState {
  const dermSurvey = settings.dermSurvey;
  return {
    enabled: dermSurvey.enabled,
    sampleSize: String(dermSurvey.sampleSize),
    yesCount: String(dermSurvey.yesCount),
    verifierName: dermSurvey.verifierName,
    verificationUrl: dermSurvey.verificationUrl,
    methodology: dermSurvey.methodology,
    format: toFormatValue(dermSurvey.format),
    scopes: {
      derm_survey: toScopeState(settings.marketScopes.derm_survey),
    },
  };
}

function parseIntegerInRange(
  value: string,
  min: number,
  max: number,
): number | null {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

/** Inline "seal-check" mark mimicking the storefront `cx-icons` seal. */
function SealCheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="5.4" fill="#b1cded" />
      <path
        d="M5.6 8.1l1.7 1.7 3.1-3.6"
        stroke="#1d1d1b"
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.1 5.1c-.9 1.9-.9 3.9 0 5.8"
        stroke="#1d1d1b"
        strokeWidth="1"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M13.9 5.1c.9 1.9.9 3.9 0 5.8"
        stroke="#1d1d1b"
        strokeWidth="1"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Admin mirror of the storefront circular proof seal: an SVG ring whose arc
 *  fills to the survey percentage (data-honest — dash length proportional to
 *  the percent), with the percent large in the center. */
function ProofSealPreview({ percent }: { percent: number }) {
  const size = 132;
  const strokeWidth = 9;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = (clamped / 100) * circumference;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${clamped}% of dermatologists surveyed`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="#ffffff"
        stroke="#eef0f2"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="#b1cded"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${circumference - filled}`}
        strokeDashoffset={circumference / 4}
      />
      <text
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
        style={{
          fontSize: "34px",
          fontWeight: 800,
          fill: "#1d1d1b",
          fontFamily: "'Arial Black', 'Helvetica Neue', Helvetica, sans-serif",
        }}
      >
        {clamped}%
      </text>
    </svg>
  );
}

/** Built-in (English) methodology paragraphs — mirrors the extension locale
 *  keys survey.methodology_p1..p5 with the live numbers substituted. */
function builtInMethodology(
  total: string,
  yes: string,
  percent: number,
): string[] {
  return [
    `In May 2026, an independent healthcare research firm surveyed ${total} licensed dermatologists across the United States, United Kingdom, France, Germany, Italy and Spain.`,
    "Each dermatologist reviewed a standardised overview of Cellexia, including its product range, ingredient information, intended uses and supporting product evidence. They were then asked:",
    "“Based on the information reviewed, would you recommend Cellexia to an appropriate patient seeking skincare for visible signs of ageing?”",
    `All ${total} dermatologists answered the question. ${yes} selected “Yes,” representing ${percent}% of respondents.`,
    "The survey was commissioned by Cellexia and conducted independently. Respondents were recruited and responses were collected and analysed by the research firm. Cellexia did not select participants or alter individual responses.",
  ];
}

const TITLE_PCT_EN =
  "of board-certified dermatologists surveyed would recommend Cellexia";
const QUESTION_EN =
  "“Based on the information reviewed, would you recommend Cellexia to an appropriate patient seeking skincare for visible signs of ageing?”";

interface FormatPreviewProps {
  percent: number;
  total: number;
  previewTotal: string;
  previewYes: string;
}

/** "report" — raw-data transparency: ruled label/value rows, tabular numerals. */
function ReportFormatPreview({
  previewTotal,
  previewYes,
  percent,
}: Omit<FormatPreviewProps, "total">) {
  const rows: [string, string][] = [
    ["Dermatologists surveyed", previewTotal],
    ["Answered “Yes”", previewYes],
    ["Would recommend Cellexia", `${percent}%`],
  ];
  return (
    <div
      style={{
        maxWidth: "420px",
        margin: "0 auto",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <div
        style={{
          fontSize: "12px",
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          borderBottom: "2px solid #1d1d1b",
          paddingBottom: "8px",
        }}
      >
        Survey results
      </div>
      {rows.map(([label, value]) => (
        <div
          key={label}
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "16px",
            padding: "10px 0",
            borderBottom: "1px solid #e6e6e4",
            fontSize: "13px",
          }}
        >
          <span style={{ color: "#3d3d3b" }}>{label}</span>
          <span style={{ fontWeight: 700 }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

/** "question" — verbatim disclosure: the exact survey question as the hero. */
function QuestionFormatPreview({
  previewTotal,
  previewYes,
  percent,
}: Omit<FormatPreviewProps, "total">) {
  return (
    <div style={{ maxWidth: "520px", margin: "0 auto", textAlign: "center" }}>
      <div style={{ fontSize: "13px", color: "#3d3d3b" }}>
        {previewTotal} licensed dermatologists were asked:
      </div>
      <blockquote
        style={{
          margin: "14px 0",
          padding: 0,
          fontSize: "17px",
          fontWeight: 600,
          fontStyle: "italic",
          lineHeight: 1.45,
        }}
      >
        {QUESTION_EN}
      </blockquote>
      <div style={{ fontSize: "14px", fontWeight: 700 }}>
        {previewYes} answered “Yes” — {percent}% of respondents.
      </div>
    </div>
  );
}

/** "tally" — concrete sample: one dot per dermatologist (fail-safe: no dots
 *  above 400, count line only — same rule as the storefront builder). */
function TallyFormatPreview({
  percent,
  total,
  yes,
  previewTotal,
  previewYes,
}: FormatPreviewProps & { yes: number }) {
  return (
    <div style={{ maxWidth: "460px", margin: "0 auto", textAlign: "center" }}>
      <div style={{ fontSize: "26px", fontWeight: 800 }}>
        {percent}%{" "}
        <span style={{ fontSize: "13px", fontWeight: 400, color: "#6b6b69" }}>
          — {previewYes} of {previewTotal} dermatologists surveyed
        </span>
      </div>
      {total <= 400 ? (
        <div
          aria-hidden="true"
          style={{
            marginTop: "14px",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(10px, 1fr))",
            gap: "4px",
          }}
        >
          {Array.from({ length: total }, (_, index) => (
            <span
              key={index}
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: index < yes ? "#b1cded" : "transparent",
                border: `1px solid ${index < yes ? "#b1cded" : "#c9c9c7"}`,
                display: "inline-block",
              }}
            />
          ))}
        </div>
      ) : (
        <div style={{ marginTop: "10px", fontSize: "12px", color: "#6b6b69" }}>
          (More than 400 surveyed — the storefront shows the count line
          without dots.)
        </div>
      )}
      <div style={{ marginTop: "10px", fontSize: "12px", color: "#6b6b69" }}>
        Each dot represents one dermatologist surveyed.
      </div>
    </div>
  );
}

/** "strip" — premium understatement: one restrained hairline-ruled line. */
function StripFormatPreview({
  percent,
}: Pick<FormatPreviewProps, "percent">) {
  return (
    <div
      style={{
        borderTop: "1px solid #e2e2e0",
        borderBottom: "1px solid #e2e2e0",
        padding: "18px 8px",
        display: "flex",
        gap: "10px",
        alignItems: "baseline",
        justifyContent: "center",
        flexWrap: "wrap",
        textAlign: "center",
      }}
    >
      <span style={{ fontSize: "22px", fontWeight: 800 }}>{percent}%</span>
      <span style={{ fontSize: "13px" }}>{TITLE_PCT_EN}</span>
    </div>
  );
}

export default function SurveyFeaturePage() {
  const { settings, markets, headerEnabled } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<SurveyFormState>(() =>
    initialFormState(settings),
  );
  const [methodologyOpen, setMethodologyOpen] = useState(false);

  useEffect(() => {
    setState(initialFormState(settings));
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
  const dirty =
    JSON.stringify({ ...state, scopes: scopesToPatch(state.scopes) }) !==
    JSON.stringify({ ...initial, scopes: scopesToPatch(initial.scopes) });
  const isSaving =
    navigation.state !== "idle" && navigation.formMethod === "POST";

  const sampleSizeValue = parseIntegerInRange(state.sampleSize, 1, 1000000);
  const sampleSizeError =
    sampleSizeValue === null ? "Between 1 and 1,000,000" : undefined;
  const yesCountValue = parseIntegerInRange(state.yesCount, 0, 100000);
  const yesCountError =
    yesCountValue === null ? "Between 0 and 100,000" : undefined;
  const trimmedUrl = state.verificationUrl.trim();
  const urlError =
    trimmedUrl !== "" && !trimmedUrl.startsWith("https://")
      ? "Must start with https:// (or leave empty)"
      : undefined;
  const hasErrors = Boolean(sampleSizeError || yesCountError || urlError);

  const handleSave = () => {
    const patch: DeepPartial<BoosterSettings> = {
      // Legacy recommend/outOf stay untouched in the stored shape — the v5.7
      // widget no longer displays them, so this page no longer edits them.
      dermSurvey: {
        enabled: state.enabled,
        sampleSize: sampleSizeValue ?? settings.dermSurvey.sampleSize,
        yesCount: yesCountValue ?? settings.dermSurvey.yesCount,
        verifierName: state.verifierName.trim(),
        verificationUrl: trimmedUrl,
        methodology: state.methodology.trim(),
        format: state.format,
      },
      marketScopes: scopesToPatch(state.scopes),
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  // Effective numbers: fall back to the last saved values while a field is
  // invalid so the computed percent and preview never render "NaN".
  const effectiveTotal = sampleSizeValue ?? settings.dermSurvey.sampleSize;
  const effectiveYes = yesCountValue ?? settings.dermSurvey.yesCount;
  // Mirrors the storefront fail-closed rule exactly: hidden when the total
  // or the Yes count is not positive, or when Yes exceeds the total.
  const inconsistent =
    effectiveTotal <= 0 || effectiveYes <= 0 || effectiveYes > effectiveTotal;
  const percent =
    effectiveTotal > 0
      ? Math.round((effectiveYes / effectiveTotal) * 100)
      : 0;
  const previewTotal = effectiveTotal.toLocaleString("en-US");
  const previewYes = effectiveYes.toLocaleString("en-US");
  const previewVerifier = state.verifierName.trim();
  const customMethodology = state.methodology.trim();
  const methodologyParagraphs =
    customMethodology !== ""
      ? customMethodology.split(/\n+/).filter((line) => line.trim() !== "")
      : builtInMethodology(previewTotal, previewYes, percent);

  return (
    <Page
      title="Dermatologist survey"
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
      <TitleBar title="Dermatologist survey" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="derm_survey"
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
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Dermatologist survey widget
                  </Text>
                  <Badge tone={state.enabled ? "success" : undefined}>
                    {state.enabled ? "Active" : "Off"}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Shown on every product page (products can opt out
                  individually on the Product boosters page). The widget cites
                  a real survey — only publish numbers, a methodology and a
                  verifier you can substantiate.
                </Text>
                <Checkbox
                  label="Enable the dermatologist survey widget"
                  helpText="Master switch. Market targeting below and per-product opt-outs still apply."
                  checked={state.enabled}
                  onChange={(enabled) =>
                    setState((previous) => ({ ...previous, enabled }))
                  }
                />
                {inconsistent ? (
                  <Banner tone="warning" title="The widget is hidden on the storefront">
                    <Text as="p">
                      “Answered Yes” cannot be greater than “Total surveyed”,
                      and both must be at least 1. The widget fails closed and
                      stays hidden until the numbers are fixed — it never
                      shows inconsistent data.
                    </Text>
                  </Banner>
                ) : null}
                <InlineStack gap="300" wrap blockAlign="start">
                  <Box width="180px">
                    <TextField
                      label="Total surveyed"
                      type="number"
                      min={1}
                      value={state.sampleSize}
                      onChange={(sampleSize) =>
                        setState((previous) => ({ ...previous, sampleSize }))
                      }
                      error={sampleSizeError}
                      helpText="Dermatologists surveyed, e.g. 270"
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="180px">
                    <TextField
                      label="Answered Yes"
                      type="number"
                      min={0}
                      value={state.yesCount}
                      onChange={(yesCount) =>
                        setState((previous) => ({ ...previous, yesCount }))
                      }
                      error={yesCountError}
                      helpText="Would recommend, e.g. 248"
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="180px" paddingBlockStart="100">
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Displayed percentage
                      </Text>
                      <Text
                        as="p"
                        variant="headingLg"
                        tone={inconsistent ? "critical" : undefined}
                      >
                        {inconsistent ? "—" : `${percent}%`}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Answered Yes ÷ Total, rounded
                      </Text>
                    </BlockStack>
                  </Box>
                </InlineStack>
                <InlineStack gap="300" wrap>
                  <Box minWidth="280px">
                    <TextField
                      label="Survey verifier"
                      value={state.verifierName}
                      maxLength={120}
                      onChange={(verifierName) =>
                        setState((previous) => ({ ...previous, verifierName }))
                      }
                      helpText="The real third party that verified the survey — named in the widget. Leave empty to hide the “Third-party verified” chip."
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="320px">
                    <TextField
                      label="Verification / methodology URL"
                      value={state.verificationUrl}
                      onChange={(verificationUrl) =>
                        setState((previous) => ({
                          ...previous,
                          verificationUrl,
                        }))
                      }
                      error={urlError}
                      placeholder="https://…"
                      helpText="Public link to the survey methodology, shown inside the “How the survey was conducted” panel. Leave empty to hide the link."
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
                <TextField
                  label="Survey methodology (optional)"
                  value={state.methodology}
                  multiline={5}
                  maxLength={4000}
                  showCharacterCount
                  onChange={(methodology) =>
                    setState((previous) => ({ ...previous, methodology }))
                  }
                  placeholder="Leave empty to use the built-in explanation, already translated into all 17 additional languages."
                  helpText="Shown in the “How the survey was conducted” panel. Leave empty to use the built-in explanation (translated into all 17 additional languages). Custom text appears exactly as written in every language — it is not translated. Separate paragraphs with line breaks."
                  autoComplete="off"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Display format
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Five ways to present the same survey data — each builds
                  trust through a different mechanism. Every format shares
                  your numbers, the “How the survey was conducted” disclosure
                  and the fail-closed rules.
                </Text>
                <BlockStack gap="200">
                  {SURVEY_FORMATS.map((format) => (
                    <RadioButton
                      key={format.value}
                      label={format.label}
                      helpText={format.description}
                      checked={state.format === format.value}
                      id={`survey-format-${format.value}`}
                      name="surveyFormat"
                      onChange={() =>
                        setState((previous) => ({
                          ...previous,
                          format: format.value,
                        }))
                      }
                    />
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Live preview
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  How the widget renders on the storefront, with your numbers.
                  Shoppers see the copy translated into their language; this
                  preview shows the English defaults.
                </Text>
                {inconsistent ? (
                  <div
                    style={{
                      border: "2px dashed #d0d0d0",
                      padding: "36px 24px",
                      textAlign: "center",
                      color: "#6b6b69",
                      fontSize: "13px",
                    }}
                  >
                    Nothing to preview — the widget fails closed and renders
                    nothing while the survey numbers are inconsistent.
                  </div>
                ) : (
                  <div
                    style={{
                      background: "#ffffff",
                      border: "2px solid #f4f4f4",
                      padding: "32px 28px",
                      color: "#1d1d1b",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "11px",
                        letterSpacing: "0.16em",
                        textTransform: "uppercase",
                        fontWeight: 600,
                        color: "#6b6b69",
                        textAlign: "center",
                        marginBottom: "20px",
                      }}
                    >
                      Independent dermatologist survey
                    </div>
                    {state.format === "seal" ? (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "24px",
                        }}
                      >
                        <div style={{ textAlign: "center" }}>
                          <ProofSealPreview percent={percent} />
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#6b6b69",
                              marginTop: "6px",
                            }}
                          >
                            {previewYes} of {previewTotal} dermatologists
                            surveyed
                          </div>
                        </div>
                        <div style={{ maxWidth: "320px" }}>
                          <div
                            style={{
                              fontSize: "16px",
                              fontWeight: 700,
                              lineHeight: 1.35,
                              textTransform: "uppercase",
                              letterSpacing: "0.02em",
                            }}
                          >
                            {TITLE_PCT_EN}
                          </div>
                        </div>
                      </div>
                    ) : state.format === "report" ? (
                      <ReportFormatPreview
                        previewTotal={previewTotal}
                        previewYes={previewYes}
                        percent={percent}
                      />
                    ) : state.format === "question" ? (
                      <QuestionFormatPreview
                        previewTotal={previewTotal}
                        previewYes={previewYes}
                        percent={percent}
                      />
                    ) : state.format === "tally" ? (
                      <TallyFormatPreview
                        percent={percent}
                        total={effectiveTotal}
                        yes={effectiveYes}
                        previewTotal={previewTotal}
                        previewYes={previewYes}
                      />
                    ) : (
                      <StripFormatPreview percent={percent} />
                    )}
                    {previewVerifier ? (
                      <div style={{ textAlign: "center", marginTop: "16px" }}>
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "8px",
                            background: "#f4f4f4",
                            borderRadius: "999px",
                            padding: "6px 14px",
                            fontSize: "12px",
                            fontWeight: 600,
                          }}
                        >
                          <SealCheckIcon />
                          <span>Third-party verified</span>
                        </div>
                      </div>
                    ) : null}
                    <div style={{ marginTop: "20px", textAlign: "center" }}>
                      <Button
                        variant="plain"
                        disclosure={methodologyOpen ? "up" : "down"}
                        onClick={() =>
                          setMethodologyOpen((previous) => !previous)
                        }
                        ariaExpanded={methodologyOpen}
                        ariaControls="cx-survey-methodology-preview"
                      >
                        How the survey was conducted
                      </Button>
                    </div>
                    <Collapsible
                      id="cx-survey-methodology-preview"
                      open={methodologyOpen}
                    >
                      <div
                        style={{
                          marginTop: "12px",
                          padding: "16px 18px",
                          background: "#fafafa",
                          fontSize: "13px",
                          lineHeight: 1.55,
                          color: "#3d3d3b",
                          textAlign: "left",
                        }}
                      >
                        {methodologyParagraphs.map((paragraph, index) => (
                          <p
                            key={index}
                            style={{
                              margin: index === 0 ? 0 : "10px 0 0",
                            }}
                          >
                            {paragraph}
                          </p>
                        ))}
                        {previewVerifier ? (
                          <p style={{ margin: "10px 0 0", fontWeight: 600 }}>
                            Survey verified by {previewVerifier}
                          </p>
                        ) : null}
                        {trimmedUrl.startsWith("https://") ? (
                          <p
                            style={{
                              margin: "10px 0 0",
                              textDecoration: "underline",
                            }}
                          >
                            See survey methodology
                          </p>
                        ) : null}
                      </div>
                    </Collapsible>
                  </div>
                )}
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Button url="/app/preview?feature=derm_survey">
                    Preview on your store
                  </Button>
                  <Text as="span" tone="subdued" variant="bodySm">
                    See any format on the real storefront via the Preview
                    Center — visitors keep seeing the saved format until you
                    save a change here.
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>

            <MarketScopeCard
              title="Markets"
              markets={markets}
              scope={state.scopes.derm_survey}
              onChange={(scope) =>
                setState((previous) => ({
                  ...previous,
                  scopes: { ...previous.scopes, derm_survey: scope },
                }))
              }
            />

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Per-product control
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  The survey needs no per-product content — it renders on every
                  product page when enabled. To hide it on specific products,
                  use the per-product toggle on the Product boosters page.
                </Text>
                <InlineStack gap="300">
                  <Button variant="plain" url="/app/products">
                    Open Product boosters
                  </Button>
                  <Button variant="plain" url="/app/markets">
                    Market targeting matrix
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
