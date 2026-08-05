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
 * v7: the survey numbers, outcomes and display live PER PRODUCT (the
 * cellexia_product_survey metaobject, edited under Product boosters). This
 * page keeps the master switch, market targeting and the SHOP-GLOBAL
 * DEFAULTS a product can override per field: verifier name, verification
 * URL and the "How the survey was conducted" text. The legacy
 * sampleSize/yesCount/format settings stay stored for back-compat but are
 * no longer edited here or read by the storefront.
 */
interface SurveyFormState {
  enabled: boolean;
  design: DesignValue;
  verifierName: string;
  verificationUrl: string;
  methodology: string;
  scopes: {
    derm_survey: ScopeState;
  };
}

function initialFormState(settings: BoosterSettings): SurveyFormState {
  const dermSurvey = settings.dermSurvey;
  return {
    enabled: dermSurvey.enabled,
    design: dermSurvey.design,
    verifierName: dermSurvey.verifierName,
    verificationUrl: dermSurvey.verificationUrl,
    methodology: dermSurvey.methodology,
    scopes: {
      derm_survey: toScopeState(settings.marketScopes.derm_survey),
    },
  };
}

/**
 * Example numbers for the methodology token preview below. The real numbers
 * are per-product now — the preview only demonstrates how {{ total }},
 * {{ yes }} and {{ percent }} are substituted, and is labeled as example
 * values in the UI.
 */
/** Client-safe mirror of DERM_SURVEY_DESIGNS in settings.server.ts — the
 *  server VALUE must not be imported into client code (Remix build breaks;
 *  the v8.3 DENSITY_VALUES lesson). The harness pins the two in sync. */
const DESIGN_VALUES = ["classic", "certificate", "dossier", "seal"] as const;
type DesignValue = (typeof DESIGN_VALUES)[number];
const DESIGN_OPTIONS: { value: DesignValue; label: string; helpText: string }[] = [
  {
    value: "classic",
    label: "Classic — outcomes list",
    helpText:
      "The current layout: percentage headline, intro, outcome bars. The only design the Display density compact toggle affects.",
  },
  {
    value: "certificate",
    label: "Certificate — engraved attestation",
    helpText:
      "Official document look: fine double border, centered header between rules, large percentage, outcomes as a ruled figures table. Inherently short on mobile.",
  },
  {
    value: "dossier",
    label: "Clinical dossier — lab-report excerpt",
    helpText:
      "Data-forward: dark header band with the verified mark, numbered outcome rows with fine gauges and right-aligned figures. Inherently short on mobile.",
  },
  {
    value: "seal",
    label: "Verified seal — notarised mark",
    helpText:
      "A die-cut seal holds the percentage and verified label; outcomes as tight stat cards beside it. Inherently short on mobile.",
  },
];

const EXAMPLE_TOTAL = 270;
const EXAMPLE_YES = 248;

/** Built-in (English) methodology paragraphs with live-number tokens —
 *  MUST stay verbatim-identical to the extension locale keys
 *  survey.methodology_p1..p5 in extensions/cellexia-booster/locales/
 *  en.default.json (the harness pins this sync). Merchants can load this
 *  text into the editor and change any part of it; {{ total }}, {{ yes }}
 *  and {{ percent }} keep tracking the live survey numbers (substituted
 *  by the storefront JS and by substituteMethodologyTokens here). */
const BUILT_IN_METHODOLOGY = [
  "In May 2026, an independent cosmetic research firm surveyed {{ total }} licensed dermatologists across the United States, United Kingdom, France, Germany, Italy and Spain.",
  "Each dermatologist received all Cellexia products, tested them with at least 5 patients for at least 8 weeks and reviewed a detailed overview of Cellexia, including its product range, ingredient information, intended uses and supporting clinical evidence. They were then asked:",
  "“Based on the information reviewed and your patients’ experience, would you recommend Cellexia to an appropriate patient seeking skincare for visible signs of ageing?”",
  "All {{ total }} dermatologists answered the question. {{ yes }} selected “Yes,” representing {{ percent }}% of respondents.",
  "The survey was requested by Cellexia and conducted independently. Respondents were recruited and responses were collected and analysed by the research firm. Cellexia did not select participants or alter individual responses.",
];

/** Mirrors the storefront's surveyBuildPanel token substitution exactly
 *  (cellexia-pdp.js): {{ total }} / {{ yes }} / {{ percent }}, flexible
 *  inner whitespace, global. */
function substituteMethodologyTokens(
  text: string,
  total: string,
  yes: string,
  percent: number,
): string {
  return text
    .replace(/\{\{\s*total\s*\}\}/g, total)
    .replace(/\{\{\s*yes\s*\}\}/g, yes)
    .replace(/\{\{\s*percent\s*\}\}/g, String(percent));
}

function builtInMethodology(
  total: string,
  yes: string,
  percent: number,
): string[] {
  return BUILT_IN_METHODOLOGY.map((paragraph) =>
    substituteMethodologyTokens(paragraph, total, yes, percent),
  );
}

/** What a save stores: an untouched copy of the built-in text collapses to
 *  "" — the built-in path keeps all 17 translations and the rendered
 *  English is identical. Only an actually-edited text becomes a
 *  (untranslated) custom override. Shared by handleSave and the dirty
 *  flag so loading the built-in text alone never arms a no-op save. */
function normalizeMethodologyForSave(methodology: string): string {
  const trimmed = methodology.trim();
  return trimmed === BUILT_IN_METHODOLOGY.join("\n\n") ? "" : trimmed;
}

/** v7: the five-format widget is gone, but this mirror of the built-in
 *  disclosure's verbatim question (BUILT_IN_METHODOLOGY[2] = the locale
 *  string survey.methodology_p3) stays — the harness pins all three copies
 *  to each other, and per-product `question` overrides are measured against
 *  this default. Keep it verbatim-identical. */
const QUESTION_EN =
  "“Based on the information reviewed and your patients’ experience, would you recommend Cellexia to an appropriate patient seeking skincare for visible signs of ageing?”";

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
  // The dirty flag compares what a save would STORE (same scopesToPatch
  // convention): loading the built-in text into the editor is not a change,
  // because handleSave normalizes an untouched copy back to "".
  const dirty =
    JSON.stringify({
      ...state,
      methodology: normalizeMethodologyForSave(state.methodology),
      scopes: scopesToPatch(state.scopes),
    }) !==
    JSON.stringify({
      ...initial,
      methodology: normalizeMethodologyForSave(initial.methodology),
      scopes: scopesToPatch(initial.scopes),
    });
  const isSaving =
    navigation.state !== "idle" && navigation.formMethod === "POST";

  const trimmedUrl = state.verificationUrl.trim();
  const urlError =
    trimmedUrl !== "" && !trimmedUrl.startsWith("https://")
      ? "Must start with https:// (or leave empty)"
      : undefined;
  const hasErrors = Boolean(urlError);

  const handleSave = () => {
    const methodologyToStore = normalizeMethodologyForSave(state.methodology);
    const patch: DeepPartial<BoosterSettings> = {
      // Legacy recommend/outOf (v5.6) and sampleSize/yesCount/format (v7:
      // the numbers and display moved into per-product metaobjects) stay
      // untouched in the stored shape — this page only edits the master
      // switch and the shop-global defaults a product can override.
      dermSurvey: {
        enabled: state.enabled,
        design: state.design,
        verifierName: state.verifierName.trim(),
        verificationUrl: trimmedUrl,
        methodology: methodologyToStore,
      },
      marketScopes: scopesToPatch(state.scopes),
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  // Example numbers for the token preview — the real totals live on each
  // product now, so the percent here only demonstrates the substitution.
  const percent = Math.round((EXAMPLE_YES / EXAMPLE_TOTAL) * 100);
  // Raw digits, exactly as the storefront renders them: the Liquid t-params
  // and the JS token substitution both interpolate unformatted numbers
  // (String(total)), so the preview must never comma-group.
  const previewTotal = String(EXAMPLE_TOTAL);
  const previewYes = String(EXAMPLE_YES);
  const previewVerifier = state.verifierName.trim();
  const customMethodology = state.methodology.trim();
  const methodologyParagraphs =
    customMethodology !== ""
      ? customMethodology
          .split(/\n+/)
          .filter((line) => line.trim() !== "")
          .map((line) =>
            substituteMethodologyTokens(
              line.trim(),
              previewTotal,
              previewYes,
              percent,
            ),
          )
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
                  Renders only on products with saved survey content — the
                  numbers, outcome statements and question live on each
                  product. The widget cites a real survey — only publish
                  numbers, a methodology and a verifier you can substantiate.
                </Text>
                <Checkbox
                  label="Enable the dermatologist survey widget"
                  helpText="Master switch. Market targeting below, per-product opt-outs and per-product content still apply."
                  checked={state.enabled}
                  onChange={(enabled) =>
                    setState((previous) => ({ ...previous, enabled }))
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Widget design
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Presentation only — every design shows the full survey:
                    the percentage headline, the per-product question and
                    intro, every outcome row with its count, the methodology
                    disclosure and the verifier, from the same translated
                    strings and per-product numbers. This is a live setting:
                    the saved design applies to real visitors immediately
                    wherever the widget is already live.
                  </Text>
                </BlockStack>
                <ChoiceList
                  title="Design"
                  titleHidden
                  choices={DESIGN_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                    helpText: option.helpText,
                  }))}
                  selected={[state.design]}
                  onChange={(selected) =>
                    setState((previous) => ({
                      ...previous,
                      design: (selected[0] ?? "classic") as DesignValue,
                    }))
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Survey content is per-product now
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Each product carries its own survey: how many dermatologists
                  were surveyed, how many would recommend it and the unique
                  outcome statements they rated. A product without saved
                  survey content shows nothing — add its numbers and outcomes
                  in the product’s editor under Product boosters.
                </Text>
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Button url="/app/products" variant="primary">
                    Add content under Product boosters
                  </Button>
                  <Button
                    url="/app/preview?feature=derm_survey"
                    variant="plain"
                  >
                    Preview on your store
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Global defaults
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Used wherever a product doesn’t set its own — every product
                  can override the verifier, the link and the disclosure text
                  in its editor.
                </Text>
                <InlineStack gap="300" wrap>
                  <Box minWidth="280px">
                    <TextField
                      label="Survey verifier"
                      value={state.verifierName}
                      maxLength={120}
                      onChange={(verifierName) =>
                        setState((previous) => ({ ...previous, verifierName }))
                      }
                      helpText="Default third party named in the widget when a product doesn’t set its own verifier. Leave empty to hide the “Third-party verified” chip."
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
                      helpText="Default public link to the survey methodology, shown inside the “How the survey was conducted” panel. Leave empty to hide the link."
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
                <TextField
                  label="“How the survey was conducted” text (optional)"
                  value={state.methodology}
                  multiline={8}
                  maxLength={4000}
                  showCharacterCount
                  onChange={(methodology) =>
                    setState((previous) => ({ ...previous, methodology }))
                  }
                  placeholder="Leave empty to use the built-in explanation, already translated into all 17 additional languages."
                  helpText={
                    "The full text shown in the “How the survey was conducted” panel. Leave empty to use the built-in explanation (translated into all 17 additional languages). Custom text appears exactly as written in every language — it is not translated. Separate paragraphs with line breaks. The placeholders {{ total }}, {{ yes }} and {{ percent }} are replaced with each product's own survey numbers on the storefront; lines using {{ yes }} or {{ percent }} appear only on products with a Would-recommend count."
                  }
                  autoComplete="off"
                />
                <InlineStack gap="200" blockAlign="center">
                  <Button
                    onClick={() =>
                      setState((previous) => ({
                        ...previous,
                        methodology: BUILT_IN_METHODOLOGY.join("\n\n"),
                      }))
                    }
                    disabled={
                      state.methodology.trim() ===
                      BUILT_IN_METHODOLOGY.join("\n\n")
                    }
                  >
                    {customMethodology === ""
                      ? "Edit the built-in text"
                      : "Reset to the built-in text"}
                  </Button>
                  <Text as="span" tone="subdued" variant="bodySm">
                    Loads the built-in explanation into the editor so you can
                    change any part of it.
                  </Text>
                </InlineStack>
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center" wrap>
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
                    <Text as="span" tone="subdued" variant="bodySm">
                      Preview with example values ({previewTotal} surveyed,{" "}
                      {previewYes} “Yes” — {percent}%). On the storefront the
                      placeholders track each product’s real numbers.
                    </Text>
                  </InlineStack>
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
                </BlockStack>
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
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
