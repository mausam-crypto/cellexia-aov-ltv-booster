import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  Checkbox,
  ChoiceList,
  InlineStack,
  Layout,
  List,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
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
import {
  QSEL_UNIT_TYPES,
  isQselUnitType,
  listProductsWithBoosterStatus,
  savePdpFlags,
} from "../services/pdp-content.server";
import { FeaturePageHeader } from "../components/FeaturePageHeader";

/**
 * v26 — Quantity selector cards (docs/SPEC-v26-quantity-selector.md).
 *
 * One master switch: the design, badges and math-honesty rules are fixed by
 * the spec (picture cards, per-unit price, struck 1-unit baseline, computed
 * save chip; the second tier carries the house "Most popular", the last one
 * the house "Best value"). The storefront relays every card tap to the
 * theme's own hidden pill buttons, so pricing, subscriptions and
 * add-to-cart behave exactly as before — only the picker's face changes.
 * v27 adds the per-product unit-type mapping (pdp_flags.unitType): the card
 * labels compose as "{n} {unit}" with curated native plural forms in all 18
 * languages once a product is mapped; unmapped products keep their variant
 * titles (already localized via Translate & Adapt).
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
  const [settings, markets, productList] = await Promise.all([
    getSettings(session.shop),
    listMarkets(admin),
    // The amazon bulk-table convention: the picker query with an empty
    // search covers this catalog (11 products, cap 25); the card says so
    // if the store ever outgrows it.
    listProductsWithBoosterStatus(admin, ""),
  ]);
  return {
    settings,
    markets,
    headerEnabled: resolveFeatureFlag(settings, "quantity_selector"),
    products: productList.products.map((product) => ({
      id: product.id,
      title: product.title,
      status: product.status,
      unitType: product.boosters.flags.unitType ?? "",
    })),
    productErrors: productList.ok ? [] : productList.errors,
    productListCapped: productList.products.length >= 25,
    // v8.3 rule: server VALUES ride the loader, never a client-bundle import.
    unitTypes: [...QSEL_UNIT_TYPES],
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  if (intent === "save_unit_type") {
    const productId = String(formData.get("productId") ?? "");
    const rawUnit = String(formData.get("unitType") ?? "");
    // "" = back to the product's own variant titles (clears the override);
    // anything else must be a catalog unit — fail loud, never coerce.
    if (rawUnit !== "" && !isQselUnitType(rawUnit)) {
      return {
        intent: "save_unit_type" as const,
        ok: false,
        errors: ["Unknown unit type"],
        productId,
      };
    }
    const saved = await savePdpFlags(admin, productId, {
      unitType: rawUnit === "" ? null : rawUnit,
    });
    return {
      intent: "save_unit_type" as const,
      ok: saved.ok,
      errors: saved.errors,
      productId,
    };
  }
  return {
    intent: "save_settings" as const,
    ...(await applySettingsPatch(session.shop, admin, formData.get("patch"))),
  };
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

interface QuantityFormState {
  enabled: boolean;
  freeShipTag: boolean;
  scope: ScopeState;
}

function initialFormState(settings: BoosterSettings): QuantityFormState {
  return {
    enabled: settings.quantitySelector.enabled,
    freeShipTag: settings.quantitySelector.freeShipTag !== false,
    scope: toScopeState(settings.marketScopes.quantity_selector),
  };
}

export default function QuantityFeaturePage() {
  const {
    settings,
    markets,
    headerEnabled,
    products,
    productErrors,
    productListCapped,
    unitTypes,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  // Per-row unit saves ride their own fetcher so a row change never
  // interferes with the page's Save button (the v8.11 dedicated-fetcher
  // rule). Optimistic value = the in-flight submission for that row.
  const unitFetcher = useFetcher<typeof action>();
  const unitLabel = (unit: string) =>
    unit.charAt(0).toUpperCase() + unit.slice(1);
  const unitOptions = [
    { label: "Default (variant titles)", value: "" },
    ...unitTypes.map((unit) => ({
      label: unitLabel(unit) + (unit === "jar" ? " (recommended default)" : ""),
      value: unit,
    })),
  ];
  const pendingUnit =
    unitFetcher.state !== "idle" && unitFetcher.formData
      ? {
          productId: String(unitFetcher.formData.get("productId") ?? ""),
          unitType: String(unitFetcher.formData.get("unitType") ?? ""),
        }
      : null;
  const saveUnit = (productId: string, unitType: string) => {
    const formData = new FormData();
    formData.set("intent", "save_unit_type");
    formData.set("productId", productId);
    formData.set("unitType", unitType);
    unitFetcher.submit(formData, { method: "post" });
  };
  const initial = useMemo(() => initialFormState(settings), [settings]);
  const [state, setState] = useState<QuantityFormState>(initial);
  const [savedKey, setSavedKey] = useState("");

  const stateKey = JSON.stringify(state);
  const dirty = stateKey !== JSON.stringify(initial) && stateKey !== savedKey;
  const isSaving = false;

  const handleSave = () => {
    const patch: DeepPartial<BoosterSettings> = {
      quantitySelector: {
        enabled: state.enabled,
        freeShipTag: state.freeShipTag,
      },
      marketScopes: {
        quantity_selector: toScopePatch(state.scope),
      } as BoosterSettings["marketScopes"],
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    setSavedKey(stateKey);
    submit(formData, { method: "post" });
  };

  return (
    <Page
      title="Quantity selector"
      subtitle="Picture cards instead of the theme's text-pill size picker — per-unit prices, the struck 1-jar baseline and a computed saving on every tier."
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        disabled: !dirty,
        loading: isSaving,
      }}
      secondaryActions={[
        {
          content: "Discard",
          onAction: () => setState(initial),
          disabled: !dirty,
        },
      ]}
    >
      <TitleBar title="Quantity selector" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="quantity_selector"
              enabled={headerEnabled}
            />
          </Card>
        </Layout.Section>

        {actionData &&
        actionData.intent === "save_settings" &&
        actionData.syncErrors.length > 0 ? (
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
                  Quantity selector cards
                </Text>
                <Checkbox
                  label="Replace the size pills with picture cards"
                  helpText="Product pages only. Works on every product whose variants are quantity tiers (1 Jar / 2 Jars / 3 Jars…); any other product keeps the theme's own picker automatically. 1 unit stays the pre-selected option."
                  checked={state.enabled}
                  onChange={(enabled) =>
                    setState((previous) => ({ ...previous, enabled }))
                  }
                />
                <Text as="p" tone="subdued" variant="bodySm">
                  Each card shows small product photos (fanned once per unit),
                  the tier name without the “- 15% Off” text, the per-unit
                  price next to the struck 1-unit price, and the exact amount
                  saved — computed from the live prices in the shopper’s
                  currency, so it stays truthful even where a variant title
                  overstates its discount. The second tier carries a
                  “Most popular” badge and the last one “Best value” (the
                  cart tiles’ own wording), in all 18 storefront languages.
                </Text>
                <Checkbox
                  label="Show a green “Free shipping” line on qualifying tiers"
                  helpText="Computed per market from your free-shipping threshold (the same one the trust badges and the cart bar use): a tier gets the line only when its own price clears the threshold — on most products that is the 2- and 3-unit tiers. Markets without a safe threshold amount show no line at all, so it can never promise something checkout won’t honor. Adds no card height."
                  checked={state.freeShipTag}
                  onChange={(freeShipTag) =>
                    setState((previous) => ({ ...previous, freeShipTag }))
                  }
                />
                <List type="bullet">
                  <List.Item>
                    Selection still runs through the theme’s own picker
                    machinery, so prices, subscriptions and add-to-cart behave
                    exactly as before.
                  </List.Item>
                  <List.Item>
                    Preview it safely from the Preview Center while it stays
                    off for real visitors, then go live here or per market.
                  </List.Item>
                  <List.Item>
                    Optional: upload a variant image (a real 2-jar or 3-jar
                    render) to any tier and the card shows it instead of the
                    fanned copies.
                  </List.Item>
                </List>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Unit type per product
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  “Default” keeps the product’s own variant titles on the
                  cards (already translated per language). Picking a unit
                  switches that product’s cards to clean “2 Syringes”-style
                  labels with correct native plural forms in all 18
                  languages — use it where the variant titles say the wrong
                  container (the wrinkle filler gel sells syringes, not
                  tubes). Saves immediately.
                </Text>
                {unitFetcher.data &&
                unitFetcher.data.intent === "save_unit_type" &&
                !unitFetcher.data.ok ? (
                  <Banner tone="critical" title="The unit type could not be saved">
                    <BlockStack gap="100">
                      {unitFetcher.data.errors.map((error) => (
                        <Text as="p" key={error}>
                          {error}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                ) : null}
                {productErrors.length > 0 ? (
                  <Banner tone="warning" title="Some products could not be loaded">
                    <BlockStack gap="100">
                      {productErrors.map((error) => (
                        <Text as="p" key={error}>
                          {error}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                ) : null}
                <BlockStack gap="200">
                  {products.map((product) => (
                    <InlineStack
                      key={product.id}
                      align="space-between"
                      blockAlign="center"
                      gap="300"
                      wrap={false}
                    >
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {product.title}
                        </Text>
                        {product.status !== "ACTIVE" ? (
                          <Badge tone="info">{product.status.toLowerCase()}</Badge>
                        ) : null}
                      </InlineStack>
                      <div style={{ minWidth: 220 }}>
                        <Select
                          label={`Unit type for ${product.title}`}
                          labelHidden
                          options={unitOptions}
                          value={
                            pendingUnit && pendingUnit.productId === product.id
                              ? pendingUnit.unitType
                              : product.unitType
                          }
                          disabled={unitFetcher.state !== "idle"}
                          onChange={(unitType) => saveUnit(product.id, unitType)}
                        />
                      </div>
                    </InlineStack>
                  ))}
                  {products.length === 0 ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      No products could be loaded.
                    </Text>
                  ) : null}
                  {productListCapped ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Showing the first 25 products. Ask us to add search here
                      if the catalog grows past that.
                    </Text>
                  ) : null}
                </BlockStack>
              </BlockStack>
            </Card>

            <MarketScopeCard
              title="Markets — Quantity selector"
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
