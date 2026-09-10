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
  Divider,
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
  BUY_BOX_PROOF_MAX_BADGES,
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
    headerEnabled: resolveFeatureFlag(settings, "buy_box_proof"),
    // The sanitizer's caps travel through the loader: a route's CLIENT
    // bundle may not reference settings.server VALUES at module scope
    // (the v8.3 build lesson), only its types.
    caps: {
      badges: BUY_BOX_PROOF_MAX_BADGES,
      institutions: BUY_BOX_PROOF_MAX_INSTITUTIONS,
    },
    // Every fact the block borrows, surfaced so the merchant can see WHY a
    // row would stay hidden without leaving this page (the v13.2 lesson:
    // controls that live far from the toggle they govern are unfindable).
    sources: {
      warehouseMapped:
        Object.keys(settings.amazon.shipsFromByCountry).length > 0 ||
        settings.amazon.defaultWarehouse !== "",
      deliveryConfigured:
        settings.deliveryEstimate.maxDays >= settings.deliveryEstimate.minDays &&
        settings.deliveryEstimate.deliveryDays.length > 0,
      guaranteeDays: settings.guarantee.days,
      rating: settings.trustpilot.rating,
      reviewCount: settings.trustpilot.reviewCount,
    },
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
          Limit which markets can see the block. Selections save even while the
          block is off, so targeting can be set up before it goes live.
        </Text>
        {markets.length === 0 ? (
          <Text as="p" tone="subdued" variant="bodySm">
            No markets could be loaded — the block follows the “All markets”
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

const BADGE_OPTIONS: { key: string; label: string }[] = [
  { key: "secure_checkout", label: "Secure checkout" },
  { key: "free_shipping_over", label: "Free shipping over threshold" },
  { key: "money_back", label: "Money-back guarantee" },
  { key: "dermatologist_tested", label: "Dermatologist tested" },
  { key: "cruelty_free", label: "Cruelty free" },
  { key: "clinically_proven", label: "Clinically proven" },
  { key: "ssl_encrypted", label: "SSL-encrypted payment" },
  { key: "easy_returns", label: "Easy returns" },
];

function badgeLabel(key: string): string {
  return BADGE_OPTIONS.find((option) => option.key === key)?.label ?? key;
}

interface InstitutionRow {
  name: string;
  imageUrl: string;
}

interface ProofBlockFormState {
  enabled: boolean;
  showShipsFrom: boolean;
  showDelivery: boolean;
  showDeliveryBadge: boolean;
  badges: string[];
  showGuarantee: boolean;
  showRating: boolean;
  researchEnabled: boolean;
  institutions: InstitutionRow[];
  sealEnabled: boolean;
  sealImageUrl: string;
  scope: ScopeState;
}

function initialFormState(settings: BoosterSettings): ProofBlockFormState {
  const block = settings.buyBoxProof;
  return {
    enabled: block.enabled,
    showShipsFrom: block.showShipsFrom,
    showDelivery: block.showDelivery,
    showDeliveryBadge: block.showDeliveryBadge,
    badges: [...block.badges],
    showGuarantee: block.showGuarantee,
    showRating: block.showRating,
    researchEnabled: block.research.enabled,
    institutions: block.research.institutions.map((item) => ({
      name: item.name,
      imageUrl: item.imageUrl,
    })),
    sealEnabled: block.seal.enabled,
    sealImageUrl: block.seal.imageUrl,
    scope: toScopeState(settings.marketScopes.buy_box_proof),
  };
}

const HTTPS_URL = /^https:\/\/[^\s"'<>\\]+$/;

export default function ProofBlockPage() {
  const { settings, markets, headerEnabled, sources, caps } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<ProofBlockFormState>(() =>
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

  const toggleBadge = (key: string) => {
    setState((previous) => ({
      ...previous,
      badges: previous.badges.includes(key)
        ? previous.badges.filter((item) => item !== key)
        : previous.badges.length >= caps.badges
          ? previous.badges
          : [...previous.badges, key],
    }));
  };

  const moveBadge = (index: number, direction: -1 | 1) => {
    setState((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.badges.length) return previous;
      const badges = [...previous.badges];
      const [moved] = badges.splice(index, 1);
      badges.splice(target, 0, moved);
      return { ...previous, badges };
    });
  };

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
      buyBoxProof: {
        enabled: state.enabled,
        showShipsFrom: state.showShipsFrom,
        showDelivery: state.showDelivery,
        showDeliveryBadge: state.showDeliveryBadge,
        badges: state.badges,
        showGuarantee: state.showGuarantee,
        showRating: state.showRating,
        research: {
          enabled: state.researchEnabled,
          institutions: state.institutions.map((row) => ({
            name: row.name.trim(),
            imageUrl: row.imageUrl.trim(),
          })),
        },
        seal: {
          enabled: state.sealEnabled,
          imageUrl: state.sealImageUrl.trim(),
        },
      },
      marketScopes: { buy_box_proof: toScopePatch(state.scope) },
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  const availableBadges = BADGE_OPTIONS.filter(
    (option) => !state.badges.includes(option.key),
  );

  return (
    <Page
      title="Buy-box proof block"
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
      <TitleBar title="Buy-box proof block" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="buy_box_proof"
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
            <Banner tone="info" title="This block takes over the buy-box area">
              <BlockStack gap="200">
                <Text as="p">
                  While it is live on a product page it renders the ships-from
                  line, the delivery date, the icon row, the money-back card and
                  the rating row itself — so the older single widgets are hidden
                  there to avoid duplicates: <b>Trust badges</b>,{" "}
                  <b>Trustpilot</b>, <b>Money-back guarantee</b>, the product-page{" "}
                  <b>Delivery guarantee</b> widget, and the Amazon{" "}
                  <b>Trust microcopy</b> and <b>Ships from</b> lines. They keep
                  their own settings and stay live everywhere else (cart,
                  checkout). The dispatch countdown is untouched.
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Nothing is duplicated in the data either — the numbers come
                  from the features that already own them.{" "}
                  <Link url="/app/features/amazon">Warehouse map</Link>,{" "}
                  <Link url="/app/features/delivery">delivery estimate</Link> and{" "}
                  <Link url="/app/features/badges">
                    guarantee, rating and badge labels
                  </Link>{" "}
                  are edited on their own pages.
                </Text>
              </BlockStack>
            </Banner>

            <Card>
              <BlockStack gap="300">
                <Checkbox
                  label="Show the buy-box proof block on product pages"
                  helpText="Renders under the Add-to-cart panel, above the product accordions. Preview it before going live."
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
                  Delivery rows
                </Text>
                <Checkbox
                  label="Ships from — country line"
                  helpText="Uses the shared warehouse map on the Amazon patterns page. The country name is translated automatically and stays grammatical in every language; no warehouse for a buyer's country means the row is simply hidden."
                  checked={state.showShipsFrom}
                  onChange={(showShipsFrom) =>
                    setState((previous) => ({ ...previous, showShipsFrom }))
                  }
                />
                {state.showShipsFrom && !sources.warehouseMapped ? (
                  <Banner tone="warning">
                    <Text as="p">
                      No warehouse is mapped yet, so this row will not appear.
                      Set one on the{" "}
                      <Link url="/app/features/amazon">Amazon patterns</Link>{" "}
                      page (“Ships from”).
                    </Text>
                  </Banner>
                ) : null}
                <Checkbox
                  label="Get it by — delivery date"
                  helpText="Computed by the shared delivery engine (cut-off, dispatch days, destination holidays). No defensible date means no row — it never shows a vague promise."
                  checked={state.showDelivery}
                  onChange={(showDelivery) =>
                    setState((previous) => ({ ...previous, showDelivery }))
                  }
                />
                {state.showDelivery && !sources.deliveryConfigured ? (
                  <Banner tone="warning">
                    <Text as="p">
                      The delivery windows look incomplete, so this row may stay
                      hidden. Check the{" "}
                      <Link url="/app/features/delivery">Delivery</Link> page.
                    </Text>
                  </Banner>
                ) : null}
                <Box paddingInlineStart="600">
                  <Checkbox
                    label="“Delivery guarantee” pill next to the date"
                    checked={state.showDeliveryBadge}
                    disabled={!state.showDelivery}
                    onChange={(showDeliveryBadge) =>
                      setState((previous) => ({
                        ...previous,
                        showDeliveryBadge,
                      }))
                    }
                  />
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Icon row
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Up to {caps.badges} badges, in this order. Labels
                  are translated by the theme extension; amounts and day counts
                  fill in automatically.
                </Text>
                {state.badges.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No badges selected — the icon row is hidden.
                  </Text>
                ) : (
                  <BlockStack gap="150">
                    {state.badges.map((key, index) => (
                      <InlineStack
                        key={key}
                        gap="200"
                        blockAlign="center"
                        align="space-between"
                      >
                        <Text as="span">{badgeLabel(key)}</Text>
                        <InlineStack gap="100">
                          <Button
                            icon={ArrowUpIcon}
                            accessibilityLabel={`Move ${badgeLabel(key)} up`}
                            disabled={index === 0}
                            onClick={() => moveBadge(index, -1)}
                          />
                          <Button
                            icon={ArrowDownIcon}
                            accessibilityLabel={`Move ${badgeLabel(key)} down`}
                            disabled={index === state.badges.length - 1}
                            onClick={() => moveBadge(index, 1)}
                          />
                          <Button
                            icon={DeleteIcon}
                            accessibilityLabel={`Remove ${badgeLabel(key)}`}
                            onClick={() => toggleBadge(key)}
                          />
                        </InlineStack>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
                {availableBadges.length > 0 &&
                state.badges.length < caps.badges ? (
                  <>
                    <Divider />
                    <InlineStack gap="200" wrap>
                      {availableBadges.map((option) => (
                        <Button
                          key={option.key}
                          onClick={() => toggleBadge(option.key)}
                        >
                          {`Add ${option.label}`}
                        </Button>
                      ))}
                    </InlineStack>
                  </>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Guarantee and rating
                </Text>
                <Checkbox
                  label={`Money-back card (${sources.guaranteeDays}-day window)`}
                  helpText="The window comes from the guarantee setting on the Trust & badges page."
                  checked={state.showGuarantee}
                  onChange={(showGuarantee) =>
                    setState((previous) => ({ ...previous, showGuarantee }))
                  }
                />
                <Checkbox
                  label={`Rating row (${sources.rating}/5, ${sources.reviewCount} reviews)`}
                  helpText="Stars, score, review count and the review-platform link all come from the Trustpilot settings on the Trust & badges page."
                  checked={state.showRating}
                  onChange={(showRating) =>
                    setState((previous) => ({ ...previous, showRating }))
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Research band
                </Text>
                <Checkbox
                  label="Show “Based on published research from”"
                  helpText="The heading is translated in every store language. Institution names are your own text and stay as written (proper nouns are not translated)."
                  checked={state.researchEnabled}
                  onChange={(researchEnabled) =>
                    setState((previous) => ({ ...previous, researchEnabled }))
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
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Certification seal
                </Text>
                <Checkbox
                  label="Show the certification seal"
                  helpText="Ships with the DermaCert artwork drawn by the app (sharp at any size, no extra request). The caption beside it is translated in every store language."
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
