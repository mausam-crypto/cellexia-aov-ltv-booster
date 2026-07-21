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
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon, PlusIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getSettings,
  mergeSettings,
  resolveFeatureFlag,
  sanitizeSettings,
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
  // Never persist an enabled clinical-results block with no stats: preview
  // the merged + sanitized result (sanitizing can drop malformed stats) and
  // reject before anything is saved or mirrored to the storefront.
  const current = await getSettings(shop);
  const merged = sanitizeSettings(mergeSettings(current, patch), current);
  if (merged.clinicalResults.enabled && merged.clinicalResults.stats.length === 0) {
    return {
      ok: false,
      syncErrors: [
        "Clinical results can’t be enabled without at least one stat — add a stat or disable the feature.",
      ],
    };
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
    headerEnabled: resolveFeatureFlag(settings, "clinical_results"),
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

const MAX_STATS = 4;

/**
 * Preset labels map to the theme extension locale keys (translated in all 17
 * languages). "custom" keeps the key out of the preset set — the merchant
 * writes the label per block instance in the theme editor instead.
 */
const LABEL_OPTIONS = [
  {
    label: "“saw visibly improved skin”",
    value: "clinical.stat_improvement",
  },
  {
    label: "“reported deeper hydration”",
    value: "clinical.stat_hydration",
  },
  {
    label: "“weeks to first visible results”",
    value: "clinical.stat_visible",
  },
  {
    label: "Custom (set per block in the theme editor)",
    value: "custom",
  },
];

interface StatRowState {
  value: string;
  suffix: string;
  labelKey: string;
}

interface ClinicalFormState {
  enabled: boolean;
  stats: StatRowState[];
  scopes: {
    clinical_results: ScopeState;
  };
}

function initialFormState(settings: BoosterSettings): ClinicalFormState {
  const clinicalResults = settings.clinicalResults;
  return {
    enabled: clinicalResults.enabled,
    stats: clinicalResults.stats.slice(0, MAX_STATS).map((stat) => ({
      value: String(stat.value),
      suffix: stat.suffix,
      labelKey: LABEL_OPTIONS.some((option) => option.value === stat.labelKey)
        ? stat.labelKey
        : "custom",
    })),
    scopes: {
      clinical_results: toScopeState(settings.marketScopes.clinical_results),
    },
  };
}

function statValueError(value: string): string | undefined {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) {
    return "Enter a number";
  }
  if (parsed < 0 || parsed > 9999) {
    return "Between 0 and 9999";
  }
  return undefined;
}

export default function ClinicalFeaturesPage() {
  const { settings, markets, headerEnabled } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<ClinicalFormState>(() =>
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

  const valueErrors = state.stats.map((stat) => statValueError(stat.value));
  const statsError =
    state.enabled && state.stats.length === 0
      ? "Add at least one stat, or disable clinical results."
      : undefined;
  const hasErrors =
    valueErrors.some((error) => error !== undefined) || Boolean(statsError);

  const updateStat = (index: number, update: Partial<StatRowState>) => {
    setState((previous) => ({
      ...previous,
      stats: previous.stats.map((stat, statIndex) =>
        statIndex === index ? { ...stat, ...update } : stat,
      ),
    }));
  };

  const removeStat = (index: number) => {
    setState((previous) => ({
      ...previous,
      stats: previous.stats.filter((_, statIndex) => statIndex !== index),
    }));
  };

  const addStat = () => {
    setState((previous) =>
      previous.stats.length >= MAX_STATS
        ? previous
        : {
            ...previous,
            stats: [
              ...previous.stats,
              { value: "", suffix: "%", labelKey: LABEL_OPTIONS[0].value },
            ],
          },
    );
  };

  const handleSave = () => {
    const patch: DeepPartial<BoosterSettings> = {
      clinicalResults: {
        enabled: state.enabled,
        stats: state.stats.map((stat) => ({
          value: Number(stat.value),
          suffix: stat.suffix.slice(0, 3),
          labelKey: stat.labelKey,
        })),
      },
      marketScopes: scopesToPatch(state.scopes),
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  return (
    <Page
      title="Clinical results"
      backAction={{ content: "Dashboard", url: "/app" }}
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        disabled: !dirty || hasErrors,
        loading: isSaving,
        helpText: statsError,
      }}
      secondaryActions={[
        {
          content: "Discard",
          onAction: () => setState(initial),
          disabled: !dirty || isSaving,
        },
      ]}
    >
      <TitleBar title="Clinical results" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="clinical_results"
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
                  “Proven by science” stat band
                </Text>
                <Checkbox
                  label="Enable clinical results"
                  helpText="Merchants place the Clinical results app block via the theme editor; it reads the stats below."
                  checked={state.enabled}
                  onChange={(enabled) =>
                    setState((previous) => ({ ...previous, enabled }))
                  }
                />
                <BlockStack gap="300">
                  {state.stats.map((stat, index) => (
                    <InlineStack
                      key={`stat-${index}`}
                      gap="300"
                      blockAlign="start"
                      wrap
                    >
                      <Box width="130px">
                        <TextField
                          label="Value"
                          type="number"
                          min={0}
                          max={9999}
                          value={stat.value}
                          onChange={(value) => updateStat(index, { value })}
                          error={valueErrors[index]}
                          autoComplete="off"
                        />
                      </Box>
                      <Box width="110px">
                        <TextField
                          label="Suffix"
                          value={stat.suffix}
                          maxLength={3}
                          onChange={(suffix) =>
                            updateStat(index, { suffix: suffix.slice(0, 3) })
                          }
                          helpText="e.g. % or wk"
                          autoComplete="off"
                        />
                      </Box>
                      <Box minWidth="280px">
                        <Select
                          label="Label"
                          options={LABEL_OPTIONS}
                          value={stat.labelKey}
                          onChange={(labelKey) =>
                            updateStat(index, { labelKey })
                          }
                          helpText={
                            stat.labelKey === "custom"
                              ? "Custom labels are entered on the Clinical results block in the theme editor and are translatable in Translate & Adapt."
                              : undefined
                          }
                        />
                      </Box>
                      <Box paddingBlockStart="600">
                        <Button
                          icon={DeleteIcon}
                          variant="tertiary"
                          accessibilityLabel={`Remove stat ${index + 1}`}
                          onClick={() => removeStat(index)}
                        />
                      </Box>
                    </InlineStack>
                  ))}
                  {statsError ? (
                    <Text as="p" tone="critical" variant="bodySm">
                      {statsError}
                    </Text>
                  ) : null}
                  <InlineStack>
                    <Button
                      icon={PlusIcon}
                      onClick={addStat}
                      disabled={state.stats.length >= MAX_STATS}
                    >
                      Add stat
                    </Button>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            <MarketScopeCard
              title="Markets"
              markets={markets}
              scope={state.scopes.clinical_results}
              onChange={(scope) =>
                setState((previous) => ({
                  ...previous,
                  scopes: { ...previous.scopes, clinical_results: scope },
                }))
              }
            />

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Translations
                </Text>
                <Text as="p" tone="subdued">
                  The three preset labels and the footnote (“Results from an
                  independent clinical study.”) ship pre-translated in all 17
                  storefront languages — nothing to configure.
                </Text>
                <Text as="p" tone="subdued">
                  Pick “Custom” to write your own label per block instance in
                  the theme editor. Those overrides are theme content, so they
                  are translatable in Translate &amp; Adapt like any other
                  theme text.
                </Text>
                <InlineStack>
                  <Button variant="plain" url="/app/localization">
                    Open the translation guide
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
