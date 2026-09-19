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
  Link,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { ArrowDownIcon, ArrowUpIcon, DeleteIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  BUY_BOX_PROOF_MAX_INSTITUTIONS,
  getSettings,
  resolveFeatureFlag,
  saveSettings,
  type BoosterSettings,
  type DeepPartial,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { listMarkets } from "../services/markets.server";
import { FeaturePageHeader } from "../components/FeaturePageHeader";
import { ParamGateCard } from "../components/ParamGateCard";

/**
 * v29 (docs/SPEC-v29-proof-split.md): the "Based on published research
 * from" band as its OWN feature — split out of the buy-box proof block so
 * it can be switched, market-scoped, gated and PREVIEWED independently.
 * It renders exactly where it always did: its own card directly under the
 * theme's Add-to-cart panel (after the award strip when both are on),
 * whatever the proof block's flag says.
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
    storeUrl: `https://${session.shop}`,
    headerEnabled: resolveFeatureFlag(settings, "research_band"),
    // The sanitizer's caps travel through the loader (the v8.3 rule: a
    // route's CLIENT bundle may not reference settings.server VALUES).
    caps: { institutions: BUY_BOX_PROOF_MAX_INSTITUTIONS },
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

function MarketScopeCard({
  markets,
  scope,
  onChange,
}: {
  markets: MarketOption[];
  scope: ScopeState;
  onChange: (scope: ScopeState) => void;
}) {
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
          Markets
        </Text>
        <Text as="p" tone="subdued" variant="bodySm">
          Limit which markets can see the band. Selections save even while the
          band is off, so targeting can be set up before it goes live.
        </Text>
        {markets.length === 0 ? (
          <Text as="p" tone="subdued" variant="bodySm">
            No markets could be loaded — the band follows the “All markets”
            default.
          </Text>
        ) : (
          <>
            <ChoiceList
              title="Market reach"
              titleHidden
              choices={[
                { label: "All markets", value: "all" },
                { label: "Selected markets", value: "selected" },
              ]}
              selected={[scope.mode]}
              onChange={handleModeChange}
            />
            {scope.mode === "selected" ? (
              <Box paddingInlineStart="400">
                <BlockStack gap="150">
                  {markets.map((market) => (
                    <Checkbox
                      key={market.handle}
                      label={
                        market.primary ? `${market.name} (primary)` : market.name
                      }
                      checked={scope.markets.includes(market.handle)}
                      onChange={(checked) =>
                        toggleMarket(market.handle, checked)
                      }
                    />
                  ))}
                </BlockStack>
              </Box>
            ) : null}
          </>
        )}
      </BlockStack>
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface InstitutionRow {
  name: string;
  imageUrl: string;
}

interface ResearchBandFormState {
  enabled: boolean;
  showResearch: boolean;
  institutions: InstitutionRow[];
  sealEnabled: boolean;
  sealImageUrl: string;
  scope: ScopeState;
  // v22 — the two URL parameter gates. `gate*Param`/`gate*Token` are read
  // only: minted server-side, shown so the merchant can copy them, and
  // cleared (never typed) to ask for a fresh pair.
  gateResearch: boolean;
  gateResearchParam: string;
  gateResearchToken: string;
  gateSeal: boolean;
  gateSealParam: string;
  gateSealToken: string;
}

function initialFormState(settings: BoosterSettings): ResearchBandFormState {
  const band = settings.researchBand;
  return {
    enabled: band.enabled,
    showResearch: band.showResearch,
    institutions: band.institutions.map((item) => ({
      name: item.name,
      imageUrl: item.imageUrl,
    })),
    sealEnabled: band.seal.enabled,
    sealImageUrl: band.seal.imageUrl,
    scope: toScopeState(settings.marketScopes.research_band),
    gateResearch: band.gate === "br" && settings.paramGates.br.enabled,
    gateResearchParam: settings.paramGates.br.param,
    gateResearchToken: settings.paramGates.br.token,
    gateSeal: band.seal.gate === "bs" && settings.paramGates.bs.enabled,
    gateSealParam: settings.paramGates.bs.param,
    gateSealToken: settings.paramGates.bs.token,
  };
}

const HTTPS_URL = /^https:\/\/[^\s"'<>\\]+$/;

export default function ResearchBandPage() {
  const { settings, markets, headerEnabled, caps, storeUrl } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<ResearchBandFormState>(() =>
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
    JSON.stringify({ ...state, scope: toScopePatch(state.scope) }) !==
    JSON.stringify({ ...initial, scope: toScopePatch(initial.scope) });
  const isSaving =
    navigation.state !== "idle" && navigation.formMethod === "POST";

  const sealUrlError =
    state.sealImageUrl.trim() !== "" && !HTTPS_URL.test(state.sealImageUrl.trim())
      ? "Enter a full https:// URL (upload the file in Settings → Files)"
      : undefined;
  const institutionErrors = state.institutions.map((row) =>
    row.imageUrl.trim() !== "" && !HTTPS_URL.test(row.imageUrl.trim())
      ? "Enter a full https:// URL"
      : undefined,
  );
  const emptyNameIndex = state.institutions.findIndex(
    (row) => row.name.trim() === "",
  );
  const institutionsError =
    emptyNameIndex >= 0 ? "Every row needs a name" : undefined;
  const hasErrors = Boolean(
    sealUrlError || institutionsError || institutionErrors.some(Boolean),
  );

  const setInstitution = (index: number, patch: Partial<InstitutionRow>) => {
    setState((previous) => ({
      ...previous,
      institutions: previous.institutions.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    }));
  };

  const moveInstitution = (index: number, direction: -1 | 1) => {
    setState((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.institutions.length) return previous;
      const institutions = [...previous.institutions];
      const [moved] = institutions.splice(index, 1);
      institutions.splice(target, 0, moved);
      return { ...previous, institutions };
    });
  };

  const handleSave = () => {
    const patch: DeepPartial<BoosterSettings> = {
      researchBand: {
        enabled: state.enabled,
        showResearch: state.showResearch,
        // The reference IS the merchant's intent: "" = everyone, "br" =
        // tagged links only. Unticking must give the piece back to every
        // visitor, so it clears here. The minted parameter survives in
        // paramGates, so re-ticking reuses it and old links keep working.
        gate: state.gateResearch ? "br" : "",
        institutions: state.institutions.map((row) => ({
          name: row.name.trim(),
          imageUrl: row.imageUrl.trim(),
        })),
        seal: {
          enabled: state.sealEnabled,
          gate: state.gateSeal ? "bs" : "",
          imageUrl: state.sealImageUrl.trim(),
        },
      },
      // An empty param/token asks the sanitizer to mint a fresh pair; a kept
      // one survives the round trip untouched.
      paramGates: {
        br: {
          enabled: state.gateResearch,
          param: state.gateResearchParam,
          token: state.gateResearchToken,
        },
        bs: {
          enabled: state.gateSeal,
          param: state.gateSealParam,
          token: state.gateSealToken,
        },
      },
      marketScopes: { research_band: toScopePatch(state.scope) },
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  return (
    <Page
      title="Research band"
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
      <TitleBar title="Research band" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="research_band"
              enabled={headerEnabled}
              reachCaption={
                state.scope.mode === "all"
                  ? "All markets"
                  : `${state.scope.markets.length} market${state.scope.markets.length === 1 ? "" : "s"}`
              }
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
                <Checkbox
                  label="Show the “Based on published research from” band"
                  helpText="Its own card directly under the Add-to-cart panel (after the award strip when both are on). It does not need the buy-box proof block to be on, and it can be previewed on its own in the Preview Center. The heading is translated in every store language; institution names stay as written (proper nouns are not translated)."
                  checked={state.enabled}
                  onChange={(enabled) =>
                    setState((previous) => ({ ...previous, enabled }))
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Institutions
                </Text>
                <Checkbox
                  label="Show the institution logos"
                  helpText="The band can also carry the certification seal alone — untick this to show only the seal."
                  checked={state.showResearch}
                  onChange={(showResearch) =>
                    setState((previous) => ({ ...previous, showResearch }))
                  }
                />
                <Banner tone="warning">
                  <BlockStack gap="150">
                    <Text as="p" variant="bodySm">
                      The app renders exactly the logo files you upload — it
                      ships no third-party logo artwork of its own. Harvard,
                      Oxford and The Lancet marks are trademarks: use the
                      official files, and only where you are licensed to.
                    </Text>
                    <Text as="p" variant="bodySm">
                      List only institutions whose published research you can
                      actually cite. This claim is yours, not the app&rsquo;s.
                    </Text>
                  </BlockStack>
                </Banner>
                <BlockStack gap="300">
                  {state.institutions.map((row, index) => (
                    <Box
                      key={`institution-${index}`}
                      padding="300"
                      background="bg-surface-secondary"
                      borderRadius="200"
                    >
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                          <Badge>{`Row ${index + 1}`}</Badge>
                          <InlineStack gap="100">
                            <Button
                              icon={ArrowUpIcon}
                              accessibilityLabel={`Move row ${index + 1} up`}
                              disabled={index === 0}
                              onClick={() => moveInstitution(index, -1)}
                            />
                            <Button
                              icon={ArrowDownIcon}
                              accessibilityLabel={`Move row ${index + 1} down`}
                              disabled={index === state.institutions.length - 1}
                              onClick={() => moveInstitution(index, 1)}
                            />
                            <Button
                              icon={DeleteIcon}
                              accessibilityLabel={`Remove row ${index + 1}`}
                              onClick={() =>
                                setState((previous) => ({
                                  ...previous,
                                  institutions: previous.institutions.filter(
                                    (_, i) => i !== index,
                                  ),
                                }))
                              }
                            />
                          </InlineStack>
                        </InlineStack>
                        <TextField
                          label="Name"
                          value={row.name}
                          onChange={(name) => setInstitution(index, { name })}
                          error={
                            row.name.trim() === "" ? "Required" : undefined
                          }
                          autoComplete="off"
                        />
                        <TextField
                          label="Logo file URL"
                          helpText="Shopify admin → Content → Files → Upload, then copy the file link and paste it here. Use the official logo file you are licensed to display. Leave blank to show the name as a plain wordmark instead."
                          value={row.imageUrl}
                          onChange={(imageUrl) =>
                            setInstitution(index, { imageUrl })
                          }
                          error={institutionErrors[index]}
                          autoComplete="off"
                        />
                        {row.imageUrl.trim() !== "" &&
                        !institutionErrors[index] ? (
                          <InlineStack gap="200" blockAlign="center">
                            <Box
                              padding="200"
                              background="bg-surface"
                              borderRadius="200"
                            >
                              {/* Same box the storefront gives each logo:
                                  what you see here is what the band renders. */}
                              <img
                                src={row.imageUrl.trim()}
                                alt={`${row.name || "Institution"} logo preview`}
                                style={{
                                  display: "block",
                                  width: 150,
                                  height: 48,
                                  objectFit: "contain",
                                }}
                              />
                            </Box>
                            <Text as="span" tone="subdued" variant="bodySm">
                              Storefront size
                            </Text>
                          </InlineStack>
                        ) : null}
                      </BlockStack>
                    </Box>
                  ))}
                </BlockStack>
                {state.institutions.length < caps.institutions ? (
                  <Box>
                    <Button
                      onClick={() =>
                        setState((previous) => ({
                          ...previous,
                          institutions: [
                            ...previous.institutions,
                            { name: "", imageUrl: "" },
                          ],
                        }))
                      }
                    >
                      Add institution
                    </Button>
                  </Box>
                ) : null}
                <ParamGateCard
                  pieceLabel="the institution logos"
                  enabled={state.gateResearch}
                  param={state.gateResearchParam}
                  token={state.gateResearchToken}
                  featureEnabled={state.enabled && state.showResearch}
                  storeUrl={storeUrl}
                  onToggle={(gateResearch) =>
                    setState((previous) => ({ ...previous, gateResearch }))
                  }
                  onRegenerate={() =>
                    setState((previous) => ({
                      ...previous,
                      gateResearchParam: "",
                      gateResearchToken: "",
                    }))
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Certification seal
                </Text>
                <Checkbox
                  label="Show the certification seal"
                  helpText="Ships with the DermaCert artwork drawn by the app (sharp at any size, no extra request). The seal is a mark: its wording is part of the artwork and stays as issued in every language, and it carries no caption."
                  checked={state.sealEnabled}
                  onChange={(sealEnabled) =>
                    setState((previous) => ({ ...previous, sealEnabled }))
                  }
                />
                <TextField
                  label="Seal image URL (optional)"
                  helpText="Upload your own seal in Settings → Files and paste its https:// link to replace the built-in artwork."
                  value={state.sealImageUrl}
                  onChange={(sealImageUrl) =>
                    setState((previous) => ({ ...previous, sealImageUrl }))
                  }
                  error={sealUrlError}
                  disabled={!state.sealEnabled}
                  autoComplete="off"
                />
                <ParamGateCard
                  pieceLabel="the certification seal"
                  enabled={state.gateSeal}
                  param={state.gateSealParam}
                  token={state.gateSealToken}
                  featureEnabled={state.enabled && state.sealEnabled}
                  storeUrl={storeUrl}
                  onToggle={(gateSeal) =>
                    setState((previous) => ({ ...previous, gateSeal }))
                  }
                  onRegenerate={() =>
                    setState((previous) => ({
                      ...previous,
                      gateSealParam: "",
                      gateSealToken: "",
                    }))
                  }
                />
              </BlockStack>
            </Card>

            <MarketScopeCard
              markets={markets}
              scope={state.scope}
              onChange={(scope) =>
                setState((previous) => ({ ...previous, scope }))
              }
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
