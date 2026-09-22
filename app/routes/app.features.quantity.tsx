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
  Button,
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
  readVolumeConfig,
  refreshVolumePricing,
  volumeRateRows,
  volumeStatus,
} from "../services/volume-pricing.server";
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
 *
 * v31 (docs/SPEC-v31-qty-sync-atc.md) adds the two buy-box companions to
 * this page, each its own FeatureKey + market scope (the v21 cart-page
 * precedent): `quantity_sync` (the theme's +/- stepper counts units and
 * drives the same hidden tier pills the cards relay into; 4+ composes
 * whole top-tier bundles plus the best remaining tier in one add) and
 * `atc_button` (the ATC restyle: icon + bigger label + price slot).
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
  // v32: volume-pricing status + the per-market rate table, read-only from
  // the mirrored config (never a price fetch on page load). A stale sync
  // (>24 h) is refreshed lazily in the background here — fire and forget,
  // the page renders with whatever is mirrored now.
  const [volume, volumeRates] = await Promise.all([
    volumeStatus(admin, session.shop, settings).catch(() => null),
    readVolumeConfig(admin)
      .then(({ cfg }) => volumeRateRows(admin, session.shop, cfg))
      .catch(() => []),
  ]);
  if (volume && volume.configured && volume.stale && settings.quantitySync.volume) {
    void refreshVolumePricing(admin, session.shop, settings).catch(() => undefined);
  }
  return {
    volume,
    volumeRates,
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
  if (intent === "volume_refresh") {
    // v32: the explicit "Refresh prices now" button — a forced full sync.
    const settings = await getSettings(session.shop);
    const result = await refreshVolumePricing(admin, session.shop, settings, { force: true });
    return {
      intent: "volume_refresh" as const,
      ok: result.ok,
      errors: result.errors,
      notes: result.notes,
    };
  }
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
  const saved = await applySettingsPatch(session.shop, admin, formData.get("patch"));
  // v32: a save that touches the sync feature or its scope runs the FULL
  // volume refresh (price fetch + discount ensure + metafield write) with
  // the freshly saved settings, so flipping the sub-flag on this page arms
  // or disarms the discount in the same click. Refresh problems ride the
  // same banner as sync errors.
  if (saved.ok) {
    let touchesVolume = false;
    try {
      const raw = formData.get("patch");
      const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const scopes = parsed.marketScopes as Record<string, unknown> | undefined;
      touchesVolume =
        parsed.quantitySync !== undefined || (scopes ? scopes.quantity_sync !== undefined : false);
    } catch {
      touchesVolume = false;
    }
    if (touchesVolume) {
      try {
        const fresh = await getSettings(session.shop);
        const result = await refreshVolumePricing(admin, session.shop, fresh);
        saved.syncErrors.push(...result.errors);
      } catch (error) {
        saved.syncErrors.push(
          error instanceof Error ? error.message : "Volume pricing refresh failed.",
        );
      }
    }
  }
  return {
    intent: "save_settings" as const,
    ...saved,
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
  /** v31 — quantity stepper sync (own FeatureKey + scope). */
  syncEnabled: boolean;
  syncScope: ScopeState;
  /** v32 — automatic 4+ pricing via the app-owned discount. */
  syncVolume: boolean;
  /** v31 — add-to-cart button v2 (own FeatureKey + scope). */
  atcEnabled: boolean;
  atcScope: ScopeState;
}

function initialFormState(settings: BoosterSettings): QuantityFormState {
  return {
    enabled: settings.quantitySelector.enabled,
    freeShipTag: settings.quantitySelector.freeShipTag !== false,
    scope: toScopeState(settings.marketScopes.quantity_selector),
    syncEnabled: settings.quantitySync.enabled,
    syncScope: toScopeState(settings.marketScopes.quantity_sync),
    syncVolume: settings.quantitySync.volume === true,
    atcEnabled: settings.atcButton.enabled,
    atcScope: toScopeState(settings.marketScopes.atc_button),
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
    volume,
    volumeRates,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  // Per-row unit saves ride their own fetcher so a row change never
  // interferes with the page's Save button (the v8.11 dedicated-fetcher
  // rule). Optimistic value = the in-flight submission for that row.
  const unitFetcher = useFetcher<typeof action>();
  // v32: the volume "Refresh prices now" button rides its own fetcher for
  // the same isolation reason.
  const volumeFetcher = useFetcher<typeof action>();
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
      quantitySync: { enabled: state.syncEnabled, volume: state.syncVolume },
      atcButton: { enabled: state.atcEnabled },
      marketScopes: {
        quantity_selector: toScopePatch(state.scope),
        quantity_sync: toScopePatch(state.syncScope),
        atc_button: toScopePatch(state.atcScope),
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
      subtitle="Picture cards instead of the theme's text-pill size picker, plus the stepper sync and the restyled add-to-cart button (each its own switch and market scope)."
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
              previewFeatureKeys={[
                "quantity_selector",
                "quantity_sync",
                "atc_button",
              ]}
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

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Quantity stepper sync
                </Text>
                <Checkbox
                  label="Connect the +/- stepper to the quantity tiers"
                  helpText="The theme's stepper today never changes the price or the selected tier. With this on it counts units: 1, 2 and 3 select the matching tier (the add-to-cart price follows instantly), and 4+ keeps the 3-pack price per unit by buying whole 3-packs plus the best remaining tier in one add. Picking a tier card moves the stepper too."
                  checked={state.syncEnabled}
                  onChange={(syncEnabled) =>
                    setState((previous) => ({ ...previous, syncEnabled }))
                  }
                />
                <Text as="p" tone="subdued" variant="bodySm">
                  A small “Save …” tag on the stepper mirrors the cards’ own
                  savings chip (same wording, all 18 languages) whenever the
                  chosen count carries a discount. Shows only on products
                  whose variants are consecutive 1..N unit tiers and while
                  the minimum order quantity is 1; anywhere else (including
                  B2B minimums) the theme’s own stepper stays untouched.
                  While a subscription is selected the stepper caps at the
                  top tier, so plan pricing always stays exact.
                </Text>

                <Checkbox
                  label="Charge the top-tier rate automatically at 4 and up"
                  helpText="Creates one automatic Shopify discount the app owns. At 4+ the cart carries one line of the single-unit product and the discount reduces it to exactly the 3-pack price per unit — computed per market from your own live prices, so what the button shows is what checkout charges, in every currency. Discount codes may stack on top (your decision, 2026-09-21). Without this, 4+ is composed from whole packs instead."
                  checked={state.syncVolume}
                  onChange={(syncVolume) =>
                    setState((previous) => ({ ...previous, syncVolume }))
                  }
                />
                {state.syncVolume && !state.syncEnabled ? (
                  <Text as="p" tone="caution" variant="bodySm">
                    The stepper sync above is off, so this will sync prices
                    but stay dormant: the discount arms only while both
                    switches are on.
                  </Text>
                ) : null}
                {volume && volume.configured ? (
                  <BlockStack gap="100">
                    <Text as="p" tone="subdued" variant="bodySm">
                      {volume.on
                        ? `Armed: ${volume.products} products across ${volume.countries} countries.`
                        : "Synced but not armed (discount inert)."}
                      {volume.syncedAt
                        ? ` Prices last synced ${new Date(volume.syncedAt).toLocaleString()}.`
                        : ""}
                      {" Prices re-sync automatically when you edit products."}
                    </Text>
                    {volume.missingCountries.length > 0 ? (
                      <Text as="p" tone="caution" variant="bodySm">
                        {`${volume.missingCountries.length} in-scope countries have no synced prices yet (${volume.missingCountries.slice(0, 6).join(", ")}${volume.missingCountries.length > 6 ? "…" : ""}) — shoppers there simply pay full price at 4+ until the next sync. Use “Refresh prices now”.`}
                      </Text>
                    ) : null}
                  </BlockStack>
                ) : (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Never synced yet — turn it on and Save to run the first
                    price sync and create the discount.
                  </Text>
                )}
                {volumeRates.length > 0 ? (
                  <BlockStack gap="050">
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      Effective 4+ discount per market (from your live prices)
                    </Text>
                    {volumeRates.slice(0, 10).map((row) => (
                      <Text
                        as="span"
                        tone="subdued"
                        variant="bodySm"
                        key={row.market + row.country + row.currency}
                      >
                        {`${row.market || row.country} (${row.currency}): ${row.pct}% off each unit at 4+`}
                      </Text>
                    ))}
                    {volumeRates.length > 10 ? (
                      <Text as="span" tone="subdued" variant="bodySm">
                        {`…and ${volumeRates.length - 10} more market price points.`}
                      </Text>
                    ) : null}
                  </BlockStack>
                ) : null}
                <InlineStack gap="200">
                  <Button
                    onClick={() => {
                      const formData = new FormData();
                      formData.set("intent", "volume_refresh");
                      volumeFetcher.submit(formData, { method: "post" });
                    }}
                    loading={volumeFetcher.state !== "idle"}
                    disabled={volumeFetcher.state !== "idle"}
                  >
                    Refresh prices now
                  </Button>
                </InlineStack>
                {volumeFetcher.data && volumeFetcher.data.intent === "volume_refresh" ? (
                  <Banner
                    tone={volumeFetcher.data.ok ? "success" : "critical"}
                    title={
                      volumeFetcher.data.ok
                        ? volumeFetcher.data.notes.join(" ") || "Prices synced."
                        : "The price sync reported problems"
                    }
                  >
                    {volumeFetcher.data.errors.length > 0 ? (
                      <BlockStack gap="100">
                        {volumeFetcher.data.errors.map((error) => (
                          <Text as="p" key={error}>
                            {error}
                          </Text>
                        ))}
                      </BlockStack>
                    ) : null}
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>

            <MarketScopeCard
              title="Markets — Quantity stepper sync"
              markets={markets}
              scope={state.syncScope}
              onChange={(syncScope) =>
                setState((previous) => ({ ...previous, syncScope }))
              }
            />

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Add-to-cart button v2
                </Text>
                <Checkbox
                  label="Restyle the add-to-cart button"
                  helpText="Same button, new face: a cart icon, a bigger label in the heading font, and the live price seated at the right behind a thin divider. The theme keeps writing the price and the sold-out state into the exact same elements, so nothing about adding to cart changes."
                  checked={state.atcEnabled}
                  onChange={(atcEnabled) =>
                    setState((previous) => ({ ...previous, atcEnabled }))
                  }
                />
                <Text as="p" tone="subdued" variant="bodySm">
                  Products that show the notify-me button instead of
                  add-to-cart keep it exactly as it is. Works with or without
                  the stepper sync; with both on, the button price always
                  reflects the chosen unit count.
                </Text>
              </BlockStack>
            </Card>

            <MarketScopeCard
              title="Markets — Add-to-cart button v2"
              markets={markets}
              scope={state.atcScope}
              onChange={(atcScope) =>
                setState((previous) => ({ ...previous, atcScope }))
              }
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
