import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
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
  Page,
  Select,
  Spinner,
  Tag,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
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
import {
  ensureProtectionProduct,
  getVariantsByIds,
  type VariantSummary,
} from "../services/products.server";
import { listMarkets } from "../services/markets.server";
import { FeaturePageHeader } from "../components/FeaturePageHeader";
import type { loader as variantsLoader } from "./app.api.variants";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface ProtectionResult {
  variantId: string | null;
  created: boolean;
  errors: string[];
}

interface CheckoutActionResult {
  ok: boolean;
  syncErrors: string[];
  protection: ProtectionResult | null;
}

async function applySettingsPatch(
  shop: string,
  admin: AdminGraphqlClient,
  rawPatch: FormDataEntryValue | null,
): Promise<CheckoutActionResult> {
  if (typeof rawPatch !== "string" || rawPatch.trim() === "") {
    return { ok: false, syncErrors: ["Missing settings payload."], protection: null };
  }
  let patch: DeepPartial<BoosterSettings>;
  try {
    const parsed: unknown = JSON.parse(rawPatch);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        syncErrors: ["Settings payload must be an object."],
        protection: null,
      };
    }
    patch = parsed as DeepPartial<BoosterSettings>;
  } catch {
    return {
      ok: false,
      syncErrors: ["Settings payload was not valid JSON."],
      protection: null,
    };
  }
  const next = await saveSettings(shop, patch);
  try {
    const sync = await syncSettingsToMetafields(admin, next);
    return { ok: true, syncErrors: sync.errors, protection: null };
  } catch (error) {
    return {
      ok: true,
      syncErrors: [
        error instanceof Error
          ? error.message
          : "Could not sync settings to storefront metafields.",
      ],
      protection: null,
    };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  const [upsellVariants, protectionVariants, markets] = await Promise.all([
    getVariantsByIds(admin, settings.checkoutUpsell.variantIds),
    settings.checkoutProtection.variantId
      ? getVariantsByIds(admin, [settings.checkoutProtection.variantId])
      : Promise.resolve([] as VariantSummary[]),
    listMarkets(admin),
  ]);
  return {
    settings,
    upsellVariants,
    protectionVariant: protectionVariants[0] ?? null,
    markets,
    // Combined flag for the shared page header (cheap — settings loaded).
    headerEnabled: resolveFeatureFlag(settings, "checkout_upsell"),
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<CheckoutActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "ensure_protection") {
    const price = String(formData.get("price") ?? "").trim();
    if (!/^\d+(\.\d{1,2})?$/.test(price) || Number(price) <= 0) {
      return {
        ok: false,
        syncErrors: [],
        protection: {
          variantId: null,
          created: false,
          errors: ["Enter a valid price, for example 2.95."],
        },
      };
    }
    const result = await ensureProtectionProduct(admin, price);
    if (!result.variantId) {
      return {
        ok: false,
        syncErrors: [],
        protection: {
          variantId: null,
          created: false,
          errors:
            result.errors.length > 0
              ? result.errors
              : ["Could not create or find the Order Protection product."],
        },
      };
    }
    const next = await saveSettings(session.shop, {
      checkoutProtection: { variantId: result.variantId },
    });
    let syncErrors: string[] = [];
    try {
      const sync = await syncSettingsToMetafields(admin, next);
      syncErrors = sync.errors;
    } catch (error) {
      syncErrors = [
        error instanceof Error
          ? error.message
          : "Could not sync settings to storefront metafields.",
      ];
    }
    return { ok: true, syncErrors, protection: result };
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

interface CheckoutFormState {
  upsellEnabled: boolean;
  maxOffers: string;
  protectionEnabled: boolean;
  defaultOn: boolean;
  trustEnabled: boolean;
  showGuarantee: boolean;
  showTrustpilot: boolean;
  showClinical: boolean;
  showBadges: boolean;
  scopes: {
    checkout_upsell: ScopeState;
    checkout_protection: ScopeState;
    checkout_trust: ScopeState;
  };
}

function initialFormState(settings: BoosterSettings): CheckoutFormState {
  return {
    upsellEnabled: settings.checkoutUpsell.enabled,
    maxOffers: String(settings.checkoutUpsell.maxOffers),
    protectionEnabled: settings.checkoutProtection.enabled,
    defaultOn: settings.checkoutProtection.defaultOn,
    trustEnabled: settings.checkoutTrust.enabled,
    showGuarantee: settings.checkoutTrust.showGuarantee,
    showTrustpilot: settings.checkoutTrust.showTrustpilot,
    showClinical: settings.checkoutTrust.showClinical,
    showBadges: settings.checkoutTrust.showBadges,
    scopes: {
      checkout_upsell: toScopeState(settings.marketScopes.checkout_upsell),
      checkout_protection: toScopeState(
        settings.marketScopes.checkout_protection,
      ),
      checkout_trust: toScopeState(settings.marketScopes.checkout_trust),
    },
  };
}

function variantLabel(variant: VariantSummary): string {
  return variant.title && variant.title !== "Default Title"
    ? `${variant.productTitle} — ${variant.title}`
    : variant.productTitle;
}

export default function CheckoutFeaturesPage() {
  const { settings, upsellVariants, protectionVariant, markets, headerEnabled } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<CheckoutFormState>(() =>
    initialFormState(settings),
  );
  const [selected, setSelected] = useState<VariantSummary[]>(upsellVariants);
  const [query, setQuery] = useState("");
  const [protectionPrice, setProtectionPrice] = useState(
    protectionVariant?.price ?? "2.95",
  );

  const initial = useMemo(() => initialFormState(settings), [settings]);
  const initialIds = useMemo(
    () => upsellVariants.map((variant) => variant.id).join(","),
    [upsellVariants],
  );
  const selectedIds = selected.map((variant) => variant.id).join(",");
  const dirty =
    JSON.stringify({ ...state, scopes: scopesToPatch(state.scopes) }) !==
      JSON.stringify({ ...initial, scopes: scopesToPatch(initial.scopes) }) ||
    selectedIds !== initialIds;

  /** Intent of the most recent submission, so the revalidation effect below
   *  knows whether fresh loader data may replace in-progress edits. */
  const lastSubmittedIntentRef = useRef<string | null>(null);

  useEffect(() => {
    const intent = lastSubmittedIntentRef.current;
    lastSubmittedIntentRef.current = null;
    if (intent === "ensure_protection") {
      // A successful create/verify only changes the protection product —
      // merge just that variant's data from the fresh loader and preserve
      // every other in-progress edit (and the dirty flag).
      if (actionData?.protection && actionData.protection.errors.length === 0) {
        setProtectionPrice(protectionVariant?.price ?? "2.95");
      }
      return;
    }
    // Adopt fresh loader data wholesale only after a completed save, or when
    // there are no unsaved edits to lose (e.g. a background revalidation).
    if ((intent === "save" && actionData?.ok !== false) || !dirty) {
      setState(initialFormState(settings));
      setSelected(upsellVariants);
      setProtectionPrice(protectionVariant?.price ?? "2.95");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, upsellVariants, protectionVariant]);

  useEffect(() => {
    if (!actionData) return;
    if (actionData.protection) {
      if (actionData.protection.errors.length > 0) {
        shopify.toast.show("Order Protection setup failed", { isError: true });
      } else {
        shopify.toast.show(
          actionData.protection.created
            ? "Order Protection product created"
            : "Order Protection product verified",
        );
      }
      return;
    }
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

  // Variant search via the /app/api/variants resource route.
  const variantSearch = useFetcher<typeof variantsLoader>();
  const loadVariants = variantSearch.load;
  const lastQueryRef = useRef("");
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "" || trimmed === lastQueryRef.current) return;
    const handle = setTimeout(() => {
      lastQueryRef.current = trimmed;
      loadVariants(`/app/api/variants?q=${encodeURIComponent(trimmed)}`);
    }, 350);
    return () => clearTimeout(handle);
  }, [query, loadVariants]);

  const searchResults = variantSearch.data?.variants ?? [];

  const pendingIntent =
    navigation.state !== "idle" && navigation.formData
      ? navigation.formData.get("intent")
      : null;
  const isSaving = pendingIntent === "save";
  const isEnsuringProtection = pendingIntent === "ensure_protection";

  const addVariant = (variant: VariantSummary) => {
    setSelected((previous) =>
      previous.some((existing) => existing.id === variant.id)
        ? previous
        : [...previous, variant],
    );
  };

  const removeVariant = (variantId: string) => {
    setSelected((previous) =>
      previous.filter((variant) => variant.id !== variantId),
    );
  };

  const setScope = (
    key: keyof CheckoutFormState["scopes"],
    scope: ScopeState,
  ) => {
    setState((previous) => ({
      ...previous,
      scopes: { ...previous.scopes, [key]: scope },
    }));
  };

  const handleSave = () => {
    const patch: DeepPartial<BoosterSettings> = {
      checkoutUpsell: {
        enabled: state.upsellEnabled,
        variantIds: selected.map((variant) => variant.id),
        maxOffers: Number(state.maxOffers) || 2,
      },
      checkoutProtection: {
        enabled: state.protectionEnabled,
        defaultOn: state.defaultOn,
      },
      checkoutTrust: {
        enabled: state.trustEnabled,
        showGuarantee: state.showGuarantee,
        showTrustpilot: state.showTrustpilot,
        showClinical: state.showClinical,
        showBadges: state.showBadges,
      },
      marketScopes: scopesToPatch(state.scopes),
    };
    const formData = new FormData();
    formData.set("intent", "save");
    formData.set("patch", JSON.stringify(patch));
    lastSubmittedIntentRef.current = "save";
    submit(formData, { method: "post" });
  };

  const handleDiscard = () => {
    setState(initial);
    setSelected(upsellVariants);
  };

  const handleEnsureProtection = () => {
    const formData = new FormData();
    formData.set("intent", "ensure_protection");
    formData.set("price", protectionPrice.trim());
    lastSubmittedIntentRef.current = "ensure_protection";
    submit(formData, { method: "post" });
  };

  const priceValid = /^\d+(\.\d{1,2})?$/.test(protectionPrice.trim());
  const protectionConnected = Boolean(settings.checkoutProtection.variantId);

  return (
    <Page
      title="Checkout"
      backAction={{ content: "Dashboard", url: "/app" }}
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        disabled: !dirty,
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
      <TitleBar title="Checkout" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="checkout_upsell"
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
                    Checkout upsell
                  </Text>
                  <Badge tone={state.upsellEnabled ? "success" : undefined}>
                    {state.upsellEnabled ? "Active" : "Off"}
                  </Badge>
                </InlineStack>
                <Checkbox
                  label="Enable checkout upsell offers"
                  helpText="“Complete your routine” offers rendered by the checkout UI extension. Variants already in the cart or out of stock are filtered out automatically."
                  checked={state.upsellEnabled}
                  onChange={(upsellEnabled) =>
                    setState((previous) => ({ ...previous, upsellEnabled }))
                  }
                />
                <Divider />
                <TextField
                  label="Search products to offer"
                  placeholder="Search by product title"
                  value={query}
                  onChange={setQuery}
                  autoComplete="off"
                  helpText="Pick the variants offered in checkout. The extension shows the first in-stock ones, up to the maximum below."
                />
                {variantSearch.state !== "idle" ? (
                  <InlineStack align="center">
                    <Spinner
                      size="small"
                      accessibilityLabel="Searching products"
                    />
                  </InlineStack>
                ) : null}
                {query.trim() !== "" && variantSearch.state === "idle" ? (
                  <BlockStack gap="200">
                    {searchResults.length === 0 && variantSearch.data ? (
                      <Text as="p" tone="subdued" variant="bodySm">
                        No variants matched “{query.trim()}”.
                      </Text>
                    ) : null}
                    {searchResults.map((variant) => {
                      const alreadySelected = selected.some(
                        (existing) => existing.id === variant.id,
                      );
                      return (
                        <InlineStack
                          key={variant.id}
                          gap="300"
                          align="space-between"
                          blockAlign="center"
                          wrap={false}
                        >
                          <InlineStack gap="300" blockAlign="center" wrap={false}>
                            <Thumbnail
                              source={variant.imageUrl ?? ImageIcon}
                              alt={variantLabel(variant)}
                              size="small"
                            />
                            <BlockStack gap="050">
                              <Text as="span" variant="bodyMd">
                                {variantLabel(variant)}
                              </Text>
                              <Text as="span" tone="subdued" variant="bodySm">
                                {variant.price}
                                {variant.availableForSale === false
                                  ? " · Out of stock"
                                  : ""}
                              </Text>
                            </BlockStack>
                          </InlineStack>
                          <Button
                            size="slim"
                            onClick={() => addVariant(variant)}
                            disabled={alreadySelected}
                          >
                            {alreadySelected ? "Added" : "Add"}
                          </Button>
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                ) : null}
                {selected.length > 0 ? (
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      Selected variants
                    </Text>
                    <InlineStack gap="200" wrap>
                      {selected.map((variant) => (
                        <Tag
                          key={variant.id}
                          onRemove={() => removeVariant(variant.id)}
                        >
                          {variantLabel(variant)}
                        </Tag>
                      ))}
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No variants selected yet — the checkout upsell stays hidden
                    until you pick at least one.
                  </Text>
                )}
                <Box maxWidth="200px">
                  <Select
                    label="Maximum offers shown"
                    options={[
                      { label: "1 offer", value: "1" },
                      { label: "2 offers", value: "2" },
                      { label: "3 offers", value: "3" },
                      { label: "4 offers", value: "4" },
                    ]}
                    value={state.maxOffers}
                    onChange={(maxOffers) =>
                      setState((previous) => ({ ...previous, maxOffers }))
                    }
                  />
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Order protection
                  </Text>
                  {protectionConnected ? (
                    protectionVariant ? (
                      <Badge tone="success">Product connected</Badge>
                    ) : (
                      <Badge tone="attention">Saved variant not found</Badge>
                    )
                  ) : (
                    <Badge tone="attention">No product yet</Badge>
                  )}
                </InlineStack>
                {actionData?.protection ? (
                  actionData.protection.errors.length > 0 ? (
                    <Banner
                      tone="critical"
                      title="Order Protection product setup failed"
                    >
                      <BlockStack gap="100">
                        {actionData.protection.errors.map((error) => (
                          <Text as="p" key={error}>
                            {error}
                          </Text>
                        ))}
                      </BlockStack>
                    </Banner>
                  ) : (
                    <Banner tone="success">
                      <Text as="p">
                        {actionData.protection.created
                          ? "Order Protection product created and connected to checkout."
                          : "Existing Order Protection product verified and connected to checkout."}
                      </Text>
                    </Banner>
                  )
                ) : null}
                {state.protectionEnabled && !protectionConnected ? (
                  <Banner tone="warning">
                    <Text as="p">
                      Order protection is enabled but no protection product is
                      connected yet — create or verify it below, then save.
                    </Text>
                  </Banner>
                ) : null}
                <Checkbox
                  label="Enable order protection in checkout"
                  helpText="Buyers can add loss, theft and damage protection with one tap."
                  checked={state.protectionEnabled}
                  onChange={(protectionEnabled) =>
                    setState((previous) => ({ ...previous, protectionEnabled }))
                  }
                />
                <Checkbox
                  label="Pre-select protection for the buyer"
                  helpText="Adds the protection line automatically once per checkout; buyers can always remove it."
                  checked={state.defaultOn}
                  onChange={(defaultOn) =>
                    setState((previous) => ({ ...previous, defaultOn }))
                  }
                />
                {protectionVariant ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Connected product: {variantLabel(protectionVariant)} —
                    current price {protectionVariant.price}.
                  </Text>
                ) : null}
                <InlineStack gap="300" blockAlign="end" wrap>
                  <Box width="200px">
                    <TextField
                      label="Protection price"
                      type="text"
                      value={protectionPrice}
                      onChange={setProtectionPrice}
                      error={
                        priceValid
                          ? undefined
                          : "Enter a price like 2.95 (shop currency)"
                      }
                      helpText="Used when the product is created. If it already exists, its current price is kept — edit it on the product page."
                      autoComplete="off"
                    />
                  </Box>
                  <Button
                    onClick={handleEnsureProtection}
                    loading={isEnsuringProtection}
                    disabled={!priceValid}
                  >
                    Create / verify protection product
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  The product is created as an active, non-taxable product
                  titled “Order Protection” and published to the Online Store
                  sales channel so checkout can add it as a cart line. Keep it
                  published — removing it from the channel breaks the checkout
                  toggle. To keep it out of sight, exclude it from your
                  collections, navigation and search results in the theme
                  instead.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Checkout trust module
                  </Text>
                  <Badge tone={state.trustEnabled ? "success" : undefined}>
                    {state.trustEnabled ? "Active" : "Off"}
                  </Badge>
                </InlineStack>
                <Checkbox
                  label="Enable the trust module"
                  helpText="Compact reassurance block (display only, no cart changes)."
                  checked={state.trustEnabled}
                  onChange={(trustEnabled) =>
                    setState((previous) => ({ ...previous, trustEnabled }))
                  }
                />
                <Divider />
                <Checkbox
                  label="Money-back guarantee line"
                  checked={state.showGuarantee}
                  onChange={(showGuarantee) =>
                    setState((previous) => ({ ...previous, showGuarantee }))
                  }
                />
                <Checkbox
                  label="Trustpilot rating line"
                  checked={state.showTrustpilot}
                  onChange={(showTrustpilot) =>
                    setState((previous) => ({ ...previous, showTrustpilot }))
                  }
                />
                <Checkbox
                  label="Clinically proven line"
                  checked={state.showClinical}
                  onChange={(showClinical) =>
                    setState((previous) => ({ ...previous, showClinical }))
                  }
                />
                <Checkbox
                  label="Secure checkout badges"
                  checked={state.showBadges}
                  onChange={(showBadges) =>
                    setState((previous) => ({ ...previous, showBadges }))
                  }
                />
              </BlockStack>
            </Card>

            <MarketScopeCard
              title="Markets — Checkout upsell"
              markets={markets}
              scope={state.scopes.checkout_upsell}
              onChange={(scope) => setScope("checkout_upsell", scope)}
            />
            <MarketScopeCard
              title="Markets — Order protection"
              markets={markets}
              scope={state.scopes.checkout_protection}
              onChange={(scope) => setScope("checkout_protection", scope)}
            />
            <MarketScopeCard
              title="Markets — Trust module"
              markets={markets}
              scope={state.scopes.checkout_trust}
              onChange={(scope) => setScope("checkout_trust", scope)}
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
