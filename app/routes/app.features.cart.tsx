import { useEffect, useMemo, useState, type CSSProperties } from "react";
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
import { DeleteIcon, PlusIcon } from "@shopify/polaris-icons";
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
    // Representative combined flag for the shared page header (cheap —
    // settings are already loaded).
    headerEnabled: resolveFeatureFlag(settings, "cart_volume_upsell"),
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

interface OfferRowState {
  quantity: string;
  discountPct: string;
}

interface CartFormState {
  enabled: boolean;
  showFreeShippingBar: boolean;
  showVolumeUpsell: boolean;
  offers: OfferRowState[];
  highlightQuantity: string;
  showSubscriptionUpsell: boolean;
  subscriptionDiscountPct: string;
  sellingPlanKeyword: string;
  showTrustRow: boolean;
  scopes: {
    cart_volume_upsell: ScopeState;
    free_shipping_bar: ScopeState;
    cart_subscription_upsell: ScopeState;
    cart_trust_row: ScopeState;
  };
}

function initialFormState(settings: BoosterSettings): CartFormState {
  const cartUpsell = settings.cartUpsell;
  return {
    enabled: cartUpsell.enabled,
    showFreeShippingBar: cartUpsell.showFreeShippingBar,
    showVolumeUpsell: cartUpsell.showVolumeUpsell,
    offers: cartUpsell.volumeOffers.map((offer) => ({
      quantity: String(offer.quantity),
      discountPct: String(offer.discountPct),
    })),
    highlightQuantity: String(cartUpsell.highlightQuantity),
    showSubscriptionUpsell: cartUpsell.showSubscriptionUpsell,
    subscriptionDiscountPct: String(cartUpsell.subscriptionDiscountPct),
    sellingPlanKeyword: cartUpsell.sellingPlanKeyword,
    showTrustRow: cartUpsell.showTrustRow,
    scopes: {
      cart_volume_upsell: toScopeState(settings.marketScopes.cart_volume_upsell),
      free_shipping_bar: toScopeState(settings.marketScopes.free_shipping_bar),
      cart_subscription_upsell: toScopeState(
        settings.marketScopes.cart_subscription_upsell,
      ),
      cart_trust_row: toScopeState(settings.marketScopes.cart_trust_row),
    },
  };
}

interface OfferRowErrors {
  quantityError?: string;
  discountError?: string;
}

function validateOffers(offers: OfferRowState[]): {
  rowErrors: OfferRowErrors[];
  formError: string | null;
} {
  const rowErrors = offers.map((offer) => {
    const errors: OfferRowErrors = {};
    const quantity = Number(offer.quantity);
    if (
      offer.quantity.trim() === "" ||
      !Number.isInteger(quantity) ||
      quantity < 2 ||
      quantity > 6
    ) {
      errors.quantityError = "Whole number between 2 and 6";
    }
    const discount = Number(offer.discountPct);
    if (
      offer.discountPct.trim() === "" ||
      !Number.isFinite(discount) ||
      discount < 0 ||
      discount > 90
    ) {
      errors.discountError = "Between 0 and 90";
    }
    return errors;
  });

  let formError: string | null = null;
  for (let index = 1; index < offers.length; index += 1) {
    const previous = Number(offers[index - 1].quantity);
    const current = Number(offers[index].quantity);
    if (
      Number.isFinite(previous) &&
      Number.isFinite(current) &&
      current <= previous
    ) {
      formError = "Tier quantities must be unique and in ascending order.";
      break;
    }
  }
  return { rowErrors, formError };
}

function validateNumberField(
  value: string,
  min: number,
  max: number,
): string | undefined {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) {
    return "Enter a number";
  }
  if (parsed < min || parsed > max) {
    return `Between ${min} and ${max}`;
  }
  return undefined;
}

export default function CartFeaturesPage() {
  const { settings, markets, headerEnabled } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<CartFormState>(() =>
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

  const setScope = (
    key: keyof CartFormState["scopes"],
    scope: ScopeState,
  ) => {
    setState((previous) => ({
      ...previous,
      scopes: { ...previous.scopes, [key]: scope },
    }));
  };
  const dirty =
    JSON.stringify({ ...state, scopes: scopesToPatch(state.scopes) }) !==
    JSON.stringify({ ...initial, scopes: scopesToPatch(initial.scopes) });
  const isSaving =
    navigation.state !== "idle" && navigation.formMethod === "POST";

  const { rowErrors, formError } = validateOffers(state.offers);
  const subscriptionPctError = validateNumberField(
    state.subscriptionDiscountPct,
    0,
    90,
  );
  const hasErrors =
    formError !== null ||
    rowErrors.some((row) => row.quantityError || row.discountError) ||
    subscriptionPctError !== undefined;

  const applyOffers = (offers: OfferRowState[]) => {
    setState((previous) => {
      const quantities = offers.map((offer) => offer.quantity);
      const highlightQuantity = quantities.includes(previous.highlightQuantity)
        ? previous.highlightQuantity
        : (quantities[quantities.length - 1] ?? "");
      return { ...previous, offers, highlightQuantity };
    });
  };

  const updateOffer = (index: number, update: Partial<OfferRowState>) => {
    applyOffers(
      state.offers.map((offer, offerIndex) =>
        offerIndex === index ? { ...offer, ...update } : offer,
      ),
    );
  };

  const removeOffer = (index: number) => {
    applyOffers(state.offers.filter((_, offerIndex) => offerIndex !== index));
  };

  const addOffer = () => {
    const used = new Set(state.offers.map((offer) => offer.quantity));
    let nextQuantity = 2;
    while (nextQuantity <= 6 && used.has(String(nextQuantity))) {
      nextQuantity += 1;
    }
    applyOffers([
      ...state.offers,
      {
        quantity: nextQuantity <= 6 ? String(nextQuantity) : "",
        discountPct: "",
      },
    ]);
  };

  const highlightOptions = state.offers
    .filter((offer) => {
      const quantity = Number(offer.quantity);
      return Number.isInteger(quantity) && quantity >= 2 && quantity <= 6;
    })
    .map((offer) => ({
      label: `${offer.quantity} units`,
      value: offer.quantity,
    }));

  const handleSave = () => {
    const offers = state.offers.map((offer) => ({
      quantity: Number(offer.quantity),
      discountPct: Number(offer.discountPct),
    }));
    const fallbackHighlight =
      offers.length > 0
        ? offers[offers.length - 1].quantity
        : settings.cartUpsell.highlightQuantity;
    const highlight = Number(state.highlightQuantity);
    const patch: DeepPartial<BoosterSettings> = {
      cartUpsell: {
        enabled: state.enabled,
        showFreeShippingBar: state.showFreeShippingBar,
        showVolumeUpsell: state.showVolumeUpsell,
        volumeOffers: offers,
        highlightQuantity:
          Number.isInteger(highlight) && highlight >= 2
            ? highlight
            : fallbackHighlight,
        showSubscriptionUpsell: state.showSubscriptionUpsell,
        subscriptionDiscountPct: Number(state.subscriptionDiscountPct),
        sellingPlanKeyword: state.sellingPlanKeyword.trim(),
        showTrustRow: state.showTrustRow,
      },
      marketScopes: scopesToPatch(state.scopes),
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  const handleDiscard = () => {
    setState(initial);
  };

  // ---- Preview helpers (sample data, brand-styled) -------------------------
  const accent = settings.global.accentColor || "#B2CEED";
  const ink = settings.global.inkColor || "#1D1D1B";
  const threshold = settings.global.freeShippingThreshold;
  const awayAmount = (threshold * 0.25).toFixed(2);
  const sampleUnitPrice = 49;
  const subscriptionPct =
    Number(state.subscriptionDiscountPct) >= 0 &&
    Number.isFinite(Number(state.subscriptionDiscountPct))
      ? Number(state.subscriptionDiscountPct)
      : settings.cartUpsell.subscriptionDiscountPct;

  const previewTiers = state.offers
    .filter(
      (offer, index) =>
        !rowErrors[index]?.quantityError && !rowErrors[index]?.discountError,
    )
    .map((offer) => {
      const quantity = Number(offer.quantity);
      const discount = Number(offer.discountPct);
      const perUnit = sampleUnitPrice * (1 - discount / 100);
      return {
        quantity,
        discount,
        perUnit: perUnit.toFixed(2),
        highlighted: offer.quantity === state.highlightQuantity,
      };
    });

  const pillButtonStyle: CSSProperties = {
    display: "inline-block",
    padding: "10px 18px",
    fontWeight: 600,
    fontSize: 12,
    letterSpacing: 1,
    borderRadius: 70,
    background: ink,
    color: "#ffffff",
    textTransform: "uppercase",
  };

  return (
    <Page
      title="Cart upsells"
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
          onAction: handleDiscard,
          disabled: !dirty || isSaving,
        },
      ]}
    >
      <TitleBar title="Cart upsells" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="cart_volume_upsell"
              enabled={headerEnabled}
              reachCaption="Cart drawer widgets"
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
                  Cart drawer booster
                </Text>
                <Checkbox
                  label="Enable cart upsells"
                  helpText="Master switch for all widgets injected into the mini-cart drawer."
                  checked={state.enabled}
                  onChange={(enabled) =>
                    setState((previous) => ({ ...previous, enabled }))
                  }
                />
                <Divider />
                <Checkbox
                  label="Free-shipping progress bar"
                  helpText={`Shows progress toward the ${threshold} free-shipping threshold (edit the threshold in Settings).`}
                  checked={state.showFreeShippingBar}
                  onChange={(showFreeShippingBar) =>
                    setState((previous) => ({
                      ...previous,
                      showFreeShippingBar,
                    }))
                  }
                />
                <Checkbox
                  label="Trust row"
                  helpText="Compact secure-checkout, guarantee and Trustpilot row above the checkout button."
                  checked={state.showTrustRow}
                  onChange={(showTrustRow) =>
                    setState((previous) => ({ ...previous, showTrustRow }))
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Volume upsell
                </Text>
                <Checkbox
                  label="Offer pack upgrades in the cart"
                  helpText="Offers a swap to the higher-unit variant (2 or 3 units) of the same product. Savings are computed from real variant prices; the percentages below are fallbacks."
                  checked={state.showVolumeUpsell}
                  onChange={(showVolumeUpsell) =>
                    setState((previous) => ({ ...previous, showVolumeUpsell }))
                  }
                />
                <BlockStack gap="300">
                  {state.offers.map((offer, index) => (
                    <InlineStack
                      key={`tier-${index}`}
                      gap="300"
                      blockAlign="start"
                      wrap={false}
                    >
                      <Box width="140px">
                        <TextField
                          label="Units"
                          type="number"
                          min={2}
                          max={6}
                          value={offer.quantity}
                          onChange={(quantity) =>
                            updateOffer(index, { quantity })
                          }
                          error={rowErrors[index]?.quantityError}
                          autoComplete="off"
                        />
                      </Box>
                      <Box width="160px">
                        <TextField
                          label="Fallback discount"
                          type="number"
                          suffix="%"
                          min={0}
                          max={90}
                          value={offer.discountPct}
                          onChange={(discountPct) =>
                            updateOffer(index, { discountPct })
                          }
                          error={rowErrors[index]?.discountError}
                          autoComplete="off"
                        />
                      </Box>
                      <Box paddingBlockStart="600">
                        <Button
                          icon={DeleteIcon}
                          variant="tertiary"
                          accessibilityLabel={`Remove tier ${index + 1}`}
                          onClick={() => removeOffer(index)}
                        />
                      </Box>
                    </InlineStack>
                  ))}
                  {formError ? (
                    <Text as="p" tone="critical" variant="bodySm">
                      {formError}
                    </Text>
                  ) : null}
                  <InlineStack>
                    <Button
                      icon={PlusIcon}
                      onClick={addOffer}
                      disabled={state.offers.length >= 5}
                    >
                      Add tier
                    </Button>
                  </InlineStack>
                </BlockStack>
                <Select
                  label="Highlighted tier"
                  helpText="Shown with the “Best value” flag."
                  options={
                    highlightOptions.length > 0
                      ? highlightOptions
                      : [{ label: "—", value: "" }]
                  }
                  value={state.highlightQuantity}
                  disabled={highlightOptions.length === 0}
                  onChange={(highlightQuantity) =>
                    setState((previous) => ({ ...previous, highlightQuantity }))
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Subscription switch
                </Text>
                <Checkbox
                  label="Offer a one-click switch to the Continuous Treatment Plan"
                  helpText="Shown for one-time lines whose product has a Joy selling plan. Hidden for B2B customers."
                  checked={state.showSubscriptionUpsell}
                  onChange={(showSubscriptionUpsell) =>
                    setState((previous) => ({
                      ...previous,
                      showSubscriptionUpsell,
                    }))
                  }
                />
                <InlineStack gap="300" wrap>
                  <Box width="200px">
                    <TextField
                      label="Fallback discount"
                      type="number"
                      suffix="%"
                      min={0}
                      max={90}
                      value={state.subscriptionDiscountPct}
                      onChange={(subscriptionDiscountPct) =>
                        setState((previous) => ({
                          ...previous,
                          subscriptionDiscountPct,
                        }))
                      }
                      error={subscriptionPctError}
                      helpText="The widget always shows the real discount read from the selling plan; this value is only used if the plan has no percentage adjustment."
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="260px">
                    <TextField
                      label="Selling plan keyword"
                      value={state.sellingPlanKeyword}
                      onChange={(sellingPlanKeyword) =>
                        setState((previous) => ({
                          ...previous,
                          sellingPlanKeyword,
                        }))
                      }
                      helpText="Case-insensitive match against the product’s selling plan group and plan names. Leave empty to use the first plan."
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
              </BlockStack>
            </Card>

            <MarketScopeCard
              title="Markets — Volume upsell"
              markets={markets}
              scope={state.scopes.cart_volume_upsell}
              onChange={(scope) => setScope("cart_volume_upsell", scope)}
            />
            <MarketScopeCard
              title="Markets — Free-shipping bar"
              markets={markets}
              scope={state.scopes.free_shipping_bar}
              onChange={(scope) => setScope("free_shipping_bar", scope)}
            />
            <MarketScopeCard
              title="Markets — Subscription switch"
              markets={markets}
              scope={state.scopes.cart_subscription_upsell}
              onChange={(scope) => setScope("cart_subscription_upsell", scope)}
            />
            <MarketScopeCard
              title="Markets — Trust row"
              markets={markets}
              scope={state.scopes.cart_trust_row}
              onChange={(scope) => setScope("cart_trust_row", scope)}
            />
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Drawer preview
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Static preview with sample prices. Storefront copy ships
                translated in 17 languages.
              </Text>
              <div
                style={{
                  border: "1px solid #d8d8d8",
                  borderRadius: 8,
                  padding: 16,
                  background: "#ffffff",
                  color: ink,
                  fontFamily:
                    '"argumentum", "Helvetica Neue", Arial, sans-serif',
                }}
              >
                {state.showFreeShippingBar ? (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 13, marginBottom: 6 }}>
                      You're {awayAmount} away from free shipping
                    </div>
                    <div
                      style={{
                        height: 6,
                        borderRadius: 70,
                        background: "#f4f4f4",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: "75%",
                          height: "100%",
                          borderRadius: 70,
                          background: accent,
                        }}
                      />
                    </div>
                  </div>
                ) : null}

                <div
                  style={{
                    padding: 15,
                    border: "2px solid #f4f4f4",
                    marginBottom: 15,
                    fontSize: 13,
                  }}
                >
                  Cellexia Serum — 1 unit · {sampleUnitPrice.toFixed(2)}
                </div>

                {state.showVolumeUpsell && previewTiers.length > 0 ? (
                  <div style={{ marginBottom: 15 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 14,
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        marginBottom: 8,
                      }}
                    >
                      Save more per unit
                    </div>
                    {previewTiers.map((tier) => (
                      <div
                        key={tier.quantity}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 8,
                          padding: "10px 14px",
                          marginBottom: 8,
                          border: tier.highlighted
                            ? `2px solid ${ink}`
                            : "2px solid #f4f4f4",
                          borderRadius: 8,
                          background: tier.highlighted ? accent : "#ffffff",
                          fontSize: 13,
                        }}
                      >
                        <span>
                          Upgrade to {tier.quantity} units ·{" "}
                          {tier.perUnit} / unit
                        </span>
                        <span style={{ fontWeight: 700 }}>
                          {tier.highlighted
                            ? `Best value · Save ${tier.discount}%`
                            : `Save ${tier.discount}%`}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {state.showSubscriptionUpsell ? (
                  <div
                    style={{
                      background: "#f4f4f4",
                      padding: 14,
                      marginBottom: 15,
                      fontSize: 13,
                    }}
                  >
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      Make it a Continuous Treatment Plan
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      Save {subscriptionPct}% on every delivery. Skip, pause or
                      cancel anytime.
                    </div>
                    <span style={pillButtonStyle}>
                      Switch &amp; save {subscriptionPct}%
                    </span>
                  </div>
                ) : null}

                {state.showTrustRow ? (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 6,
                      fontSize: 12,
                      color: "#808080",
                    }}
                  >
                    <span>Secure checkout</span>
                    <span>·</span>
                    <span>
                      {settings.guarantee.days}-day money-back guarantee
                    </span>
                    {settings.trustpilot.enabled ? (
                      <>
                        <span>·</span>
                        <span>★ {settings.trustpilot.rating.toFixed(1)}</span>
                      </>
                    ) : null}
                  </div>
                ) : null}

                {!state.enabled ? (
                  <div
                    style={{
                      marginTop: 12,
                      fontSize: 12,
                      color: "#808080",
                    }}
                  >
                    Cart upsells are currently disabled — nothing renders in
                    the drawer.
                  </div>
                ) : null}
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
