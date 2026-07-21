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
  InlineStack,
  Layout,
  Page,
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

interface SurveyFormState {
  enabled: boolean;
  recommend: string;
  outOf: string;
  sampleSize: string;
  verifierName: string;
  verificationUrl: string;
  scopes: {
    derm_survey: ScopeState;
  };
}

function initialFormState(settings: BoosterSettings): SurveyFormState {
  const dermSurvey = settings.dermSurvey;
  return {
    enabled: dermSurvey.enabled,
    recommend: String(dermSurvey.recommend),
    outOf: String(dermSurvey.outOf),
    sampleSize: String(dermSurvey.sampleSize),
    verifierName: dermSurvey.verifierName,
    verificationUrl: dermSurvey.verificationUrl,
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

export default function SurveyFeaturePage() {
  const { settings, markets, headerEnabled } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<SurveyFormState>(() =>
    initialFormState(settings),
  );

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

  const outOfValue = parseIntegerInRange(state.outOf, 1, 100);
  const outOfError = outOfValue === null ? "Between 1 and 100" : undefined;
  const recommendValue = parseIntegerInRange(
    state.recommend,
    0,
    outOfValue ?? 100,
  );
  const recommendError =
    recommendValue === null
      ? `Between 0 and ${outOfValue ?? 100}`
      : undefined;
  const sampleSizeValue = parseIntegerInRange(state.sampleSize, 1, 1000000);
  const sampleSizeError =
    sampleSizeValue === null ? "Between 1 and 1,000,000" : undefined;
  const trimmedUrl = state.verificationUrl.trim();
  const urlError =
    trimmedUrl !== "" && !trimmedUrl.startsWith("https://")
      ? "Must start with https:// (or leave empty)"
      : undefined;
  const hasErrors = Boolean(
    outOfError || recommendError || sampleSizeError || urlError,
  );

  const handleSave = () => {
    const patch: DeepPartial<BoosterSettings> = {
      dermSurvey: {
        enabled: state.enabled,
        recommend: recommendValue ?? settings.dermSurvey.recommend,
        outOf: outOfValue ?? settings.dermSurvey.outOf,
        sampleSize: sampleSizeValue ?? settings.dermSurvey.sampleSize,
        verifierName: state.verifierName.trim(),
        verificationUrl: trimmedUrl,
      },
      marketScopes: scopesToPatch(state.scopes),
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  // Preview falls back to the last saved numbers while a field is invalid so
  // the mock never renders "NaN/NaN".
  const previewRecommend = recommendValue ?? settings.dermSurvey.recommend;
  const previewOutOf = outOfValue ?? settings.dermSurvey.outOf;
  const previewSample = (
    sampleSizeValue ?? settings.dermSurvey.sampleSize
  ).toLocaleString("en-US");
  const previewVerifier = state.verifierName.trim();

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
                  a real survey — only publish numbers and a verifier you can
                  substantiate.
                </Text>
                <Checkbox
                  label="Enable the dermatologist survey widget"
                  helpText="Master switch. Market targeting below and per-product opt-outs still apply."
                  checked={state.enabled}
                  onChange={(enabled) =>
                    setState((previous) => ({ ...previous, enabled }))
                  }
                />
                <InlineStack gap="300" wrap>
                  <Box width="160px">
                    <TextField
                      label="Would recommend"
                      type="number"
                      min={0}
                      max={outOfValue ?? 100}
                      value={state.recommend}
                      onChange={(recommend) =>
                        setState((previous) => ({ ...previous, recommend }))
                      }
                      error={recommendError}
                      helpText="e.g. 9"
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="160px">
                    <TextField
                      label="Out of"
                      type="number"
                      min={1}
                      max={100}
                      value={state.outOf}
                      onChange={(outOf) =>
                        setState((previous) => ({ ...previous, outOf }))
                      }
                      error={outOfError}
                      helpText="e.g. 10"
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="200px">
                    <TextField
                      label="Sample size"
                      type="number"
                      min={1}
                      value={state.sampleSize}
                      onChange={(sampleSize) =>
                        setState((previous) => ({ ...previous, sampleSize }))
                      }
                      error={sampleSizeError}
                      helpText="Surveyed dermatologists, e.g. 270"
                      autoComplete="off"
                    />
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
                      helpText="The real third party that verified the survey — named on the seal. Leave empty to hide the “verified by” line."
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
                      helpText="Public link to the survey methodology. Leave empty to hide the link."
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
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
                <div
                  style={{
                    background: "#ffffff",
                    border: "2px solid #f4f4f4",
                    padding: "36px 24px",
                    textAlign: "center",
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
                    }}
                  >
                    Independent survey
                  </div>
                  <div
                    style={{
                      fontSize: "64px",
                      fontWeight: 800,
                      lineHeight: 1.05,
                      margin: "10px 0 6px",
                      fontFamily:
                        "'Arial Black', 'Helvetica Neue', Helvetica, sans-serif",
                    }}
                  >
                    {previewRecommend}/{previewOutOf}
                  </div>
                  <div
                    style={{
                      fontSize: "15px",
                      fontWeight: 600,
                      maxWidth: "340px",
                      margin: "0 auto",
                    }}
                  >
                    dermatologists surveyed would recommend Cellexia
                  </div>
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#6b6b69",
                      marginTop: "6px",
                    }}
                  >
                    Independent survey of {previewSample} board-certified
                    dermatologists
                  </div>
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "8px",
                      marginTop: "16px",
                      background: "#f4f4f4",
                      borderRadius: "999px",
                      padding: "6px 14px",
                      fontSize: "12px",
                      fontWeight: 600,
                    }}
                  >
                    <SealCheckIcon />
                    <span>
                      Third-party verified
                      {previewVerifier
                        ? ` · Survey verified by ${previewVerifier}`
                        : ""}
                    </span>
                  </div>
                  {trimmedUrl.startsWith("https://") ? (
                    <div
                      style={{
                        marginTop: "10px",
                        fontSize: "12px",
                        textDecoration: "underline",
                      }}
                    >
                      See survey methodology
                    </div>
                  ) : null}
                </div>
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
