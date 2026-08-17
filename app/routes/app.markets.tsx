import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
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
  Divider,
  Icon,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  FEATURE_KEYS,
  getSettings,
  resolveFeatureFlag,
  saveSettings,
  type BoosterSettings,
  type DeepPartial,
  type FeatureKey,
  type MarketScope,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { listMarkets } from "../services/markets.server";

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
  const [markets, settings] = await Promise.all([
    listMarkets(admin),
    getSettings(session.shop),
  ]);
  // Combined flag state (master && sub-flag) computed server-side through the
  // canonical helpers — the client never re-derives flag paths for reads.
  const featureStates = Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, resolveFeatureFlag(settings, key)]),
  ) as Record<FeatureKey, boolean>;
  return { markets, settings, featureStates };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  return applySettingsPatch(session.shop, admin, formData.get("patch"));
};

interface MatrixFeature {
  key: FeatureKey;
  label: string;
}

const MATRIX_GROUPS: { title: string; features: MatrixFeature[] }[] = [
  {
    title: "Cart drawer",
    features: [
      { key: "cart_volume_upsell", label: "Cart volume upgrade" },
      { key: "free_shipping_bar", label: "Free-shipping progress bar" },
      { key: "cart_subscription_upsell", label: "Cart subscription switch" },
      { key: "cart_trust_row", label: "Cart trust row" },
      // Standalone master flag (cartCrossSell.enabled) — listed with the
      // cart drawer widgets for the merchant, but it does NOT share the
      // cartUpsell master switch (not part of CART_KEYS).
      { key: "cart_cross_sell", label: "Cart cross-sell" },
      // Standalone master flag (dispatch.enabled) — the countdown shows in
      // the cart drawer AND on product pages, but it is grouped here for the
      // merchant. Not part of CART_KEYS either.
      { key: "dispatch_countdown", label: "Dispatch countdown" },
    ],
  },
  {
    title: "Product page & blocks",
    features: [
      { key: "trust_badges", label: "Trust badges" },
      { key: "trustpilot", label: "Trustpilot widget" },
      { key: "guarantee", label: "Money-back guarantee" },
      { key: "clinical_results", label: "Clinical results" },
      { key: "subscription_nudge", label: "Subscription nudge" },
      // Standalone master flag (deliveryEstimate.enabled) — the delivery
      // estimate + guarantee widget renders on product pages below the
      // dispatch countdown.
      { key: "delivery_estimate", label: "Delivery guarantee" },
    ],
  },
  // v8.6: the per-product PDP trust boosters, proof-library widgets and
  // Amazon patterns were MISSING from this matrix since their launches —
  // their marketScopes existed and gated the storefront, but no admin
  // surface could edit them (the dashboards only DISPLAY "Market reach").
  {
    title: "Product page — trust boosters",
    features: [
      { key: "clinical_study", label: "Clinical study" },
      { key: "verified_before_after", label: "Results gallery" },
      { key: "batch_transparency", label: "Batch transparency" },
      { key: "empty_bottle_guarantee", label: "Risk-free trial guarantee" },
      { key: "derm_survey", label: "Dermatologist survey" },
    ],
  },
  {
    title: "Proof library",
    features: [
      { key: "press", label: "As seen in the press" },
      { key: "derm_endorsements", label: "Dermatologist endorsements" },
    ],
  },
  {
    title: "Amazon patterns",
    features: [
      { key: "az_buy_box", label: "Buy-box decision card" },
      { key: "az_microcopy", label: "Trust microcopy rows" },
      { key: "az_delivery_line", label: "Compound delivery line" },
      { key: "az_stock_line", label: "In-stock line" },
      { key: "az_ships_from", label: "Ships-from line" },
      { key: "az_bought_count", label: "Bought-in-past-month count" },
      { key: "az_bestseller_badge", label: "Bestseller badge" },
      { key: "az_fbt", label: "Frequently bought together" },
      { key: "az_similar_items", label: "Similar items row" },
      { key: "az_cart_free_line", label: "Cart free-shipping sentence" },
      { key: "az_cta_count", label: "Checkout button item count" },
    ],
  },
  {
    title: "Checkout",
    features: [
      { key: "checkout_upsell", label: "Checkout upsell" },
      { key: "checkout_protection", label: "Order Protection" },
      { key: "checkout_trust", label: "Checkout trust module" },
      // v9 trust module V2 rows — sub-flags of the trust module (shared
      // checkoutTrust master, cart-style), each with its own market scope.
      { key: "checkout_customs", label: "Customs-free delivery line" },
      { key: "checkout_tracked", label: "Tracked delivery line" },
    ],
  },
];

// v8.6 safety net (same contract as the Preview Center + Features hub
// pickers): a FeatureKey missing from the MATRIX_GROUPS literal still gets a
// matrix row, in an automatic trailing group, so no booster can ever lose its
// market-targeting control again. The key inventory comes from the LOADER's
// featureStates (built server-side from the real FEATURE_KEYS) — importing
// the settings.server VALUE into module-scope client code breaks the Remix
// build (the v8.3 DENSITY_VALUES lesson). The validation harness fails when
// the literal drifts, so this group should never actually appear.
const CURATED_MATRIX_KEYS = new Set<string>(
  MATRIX_GROUPS.flatMap((group) => group.features.map(({ key }) => key)),
);
function buildRenderGroups(
  featureStates: Record<FeatureKey, boolean>,
): { title: string; features: MatrixFeature[] }[] {
  const ungroupedMatrixFeatures: MatrixFeature[] = (
    Object.keys(featureStates) as FeatureKey[]
  )
    .filter((key) => !CURATED_MATRIX_KEYS.has(key))
    .map((key) => ({
      key,
      label: key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
    }));
  return ungroupedMatrixFeatures.length > 0
    ? [
        ...MATRIX_GROUPS,
        { title: "Other boosters", features: ungroupedMatrixFeatures },
      ]
    : MATRIX_GROUPS;
}



const CART_KEYS = [
  "cart_volume_upsell",
  "free_shipping_bar",
  "cart_subscription_upsell",
  "cart_trust_row",
] as const;

/** Amazon-pattern rows + their amazon.* flag field (client-safe mirror of
 *  the Amazon page's AZ_FLAG_FIELD; the action validates server-side). */
const AZ_MATRIX_KEYS = [
  "az_buy_box",
  "az_microcopy",
  "az_delivery_line",
  "az_stock_line",
  "az_ships_from",
  "az_bought_count",
  "az_bestseller_badge",
  "az_fbt",
  "az_similar_items",
  "az_cart_free_line",
  "az_cta_count",
] as const;
type AzMatrixKey = (typeof AZ_MATRIX_KEYS)[number];
const AZ_FLAG_FIELD = {
  az_buy_box: "buyBox",
  az_microcopy: "microcopy",
  az_delivery_line: "deliveryLine",
  az_stock_line: "stockLine",
  az_ships_from: "shipsFrom",
  az_bought_count: "boughtCount",
  az_bestseller_badge: "bestsellerBadge",
  az_fbt: "fbt",
  az_similar_items: "similarItems",
  az_cart_free_line: "cartFreeLine",
  az_cta_count: "ctaCount",
} as const satisfies Record<AzMatrixKey, string>;

interface RowState {
  /** Combined flag state (master && sub-flag) for this feature. */
  on: boolean;
  mode: "all" | "selected";
  markets: string[];
}

type MatrixState = Record<FeatureKey, RowState>;

function initialMatrixState(
  featureStates: Record<FeatureKey, boolean>,
  marketScopes: Record<FeatureKey, MarketScope>,
): MatrixState {
  return Object.fromEntries(
    (Object.keys(featureStates) as FeatureKey[]).map((key) => {
      const scope = marketScopes[key];
      return [
        key,
        {
          on: featureStates[key],
          mode: scope?.mode === "selected" ? "selected" : "all",
          markets: scope?.mode === "selected" ? [...scope.markets] : [],
        } satisfies RowState,
      ];
    }),
  ) as MatrixState;
}

/** Serialization used for dirty checks only. Market handle order carries no
 *  meaning (scopes are sets), and the stored order can differ from the
 *  canonical order normalizeHandles produces — so both sides are sorted
 *  before comparison, or toggling a cell back would leave a stuck
 *  "Unsaved changes" banner. */
function serializeMatrixForCompare(matrix: MatrixState): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(matrix).map(([key, row]) => [
        key,
        { ...row, markets: [...row.markets].sort() },
      ]),
    ),
  );
}

// v8.13 master-detail layout (merchant ask: the 33-row × N-market checkbox
// grid was unusable on stores with many markets). Left pane = searchable
// grouped feature list; right pane = the selected feature's market
// targeting. ALL save semantics are unchanged from the grid era: the same
// MatrixState, the same changed-only patch mapping in handleSave, and
// toggleCell still converts all→selected so scopes stay editable whether or
// not the feature is enabled.

const listRowStyle: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "10px 12px",
  border: "none",
  borderLeft: "3px solid transparent",
  borderBottom: "1px solid #f1f1f1",
  background: "transparent",
  cursor: "pointer",
};

const listRowSelectedStyle: CSSProperties = {
  background: "#f1f8f5",
  borderLeftColor: "#29845a",
};

const groupHeaderStyle: CSSProperties = {
  padding: "12px 12px 4px",
  position: "sticky",
  top: 0,
  background: "#ffffff",
  zIndex: 1,
};

export default function MarketsPage() {
  const { markets, settings, featureStates } = useLoaderData<typeof loader>();
  const renderGroups = useMemo(
    () => buildRenderGroups(featureStates),
    [featureStates],
  );
  const allFeatures = useMemo(
    () => renderGroups.flatMap((group) => group.features),
    [renderGroups],
  );
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<MatrixState>(() =>
    initialMatrixState(featureStates, settings.marketScopes),
  );
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<FeatureKey | null>(
    () => allFeatures[0]?.key ?? null,
  );

  useEffect(() => {
    setState(initialMatrixState(featureStates, settings.marketScopes));
  }, [featureStates, settings]);

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

  const initial = useMemo(
    () => initialMatrixState(featureStates, settings.marketScopes),
    [featureStates, settings],
  );
  const dirty =
    serializeMatrixForCompare(state) !== serializeMatrixForCompare(initial);
  const isSaving =
    navigation.state !== "idle" && navigation.formMethod === "POST";

  const allHandles = markets.map((market) => market.handle);

  /** Keeps selected handles in the canonical market order (plus any saved
   *  handles for since-deleted markets, appended at the end). */
  const normalizeHandles = (handles: Set<string>): string[] => {
    const ordered = allHandles.filter((handle) => handles.has(handle));
    for (const handle of handles) {
      if (!allHandles.includes(handle)) ordered.push(handle);
    }
    return ordered;
  };

  const setRow = (key: FeatureKey, updater: (row: RowState) => RowState) => {
    setState((previous) => ({ ...previous, [key]: updater(previous[key]) }));
  };

  const toggleMaster = (key: FeatureKey) => {
    setRow(key, (row) => ({ ...row, on: !row.on }));
  };

  const setAllMarkets = (key: FeatureKey, checked: boolean) => {
    // With no market list loaded, "selected" would pre-check ZERO markets —
    // an invisible feature-wide off switch (review v8.13 F2). Refuse; the
    // checkbox is also disabled in this state.
    if (!checked && allHandles.length === 0) return;
    setRow(key, (row) =>
      checked
        ? { ...row, mode: "all", markets: [] }
        : // Switching to "selected" pre-checks every market so the effective
          // visibility does not change until individual cells are unchecked.
          { ...row, mode: "selected", markets: [...allHandles] },
    );
  };

  const toggleCell = (key: FeatureKey, handle: string, checked: boolean) => {
    setRow(key, (row) => {
      const set = new Set(row.mode === "all" ? allHandles : row.markets);
      if (checked) set.add(handle);
      else set.delete(handle);
      return { ...row, mode: "selected", markets: normalizeHandles(set) };
    });
  };

  /** Check every current market but STAY in selected mode (unlike the "All
   *  markets" checkbox, this list does not auto-include future markets). */
  const selectAllMarkets = (key: FeatureKey) => {
    setRow(key, (row) =>
      row.mode === "all"
        ? row
        : { ...row, mode: "selected", markets: [...allHandles] },
    );
  };

  const clearMarkets = (key: FeatureKey) => {
    setRow(key, (row) => ({ ...row, mode: "selected", markets: [] }));
  };

  const handleSave = () => {
    const marketScopes = Object.fromEntries(
      allFeatures.map(({ key }) => {
        const row = state[key];
        return [
          key,
          row.mode === "all"
            ? { mode: "all" as const, markets: [] }
            : { mode: "selected" as const, markets: row.markets },
        ];
      }),
    ) as Record<FeatureKey, MarketScope>;

    const patch: DeepPartial<BoosterSettings> = { marketScopes };

    // Cart sub-features share the cartUpsell master switch: turning any of
    // them on must set the master on + its show-flag; turning one off clears
    // only its show-flag (mirrors FEATURE_DEFS set semantics). Writing all
    // four show-flags keeps dormant siblings from resurfacing when the
    // master flips on.
    const cartChanged = CART_KEYS.some(
      (key) => state[key].on !== initial[key].on,
    );
    if (cartChanged) {
      const anyCartOn = CART_KEYS.some((key) => state[key].on);
      patch.cartUpsell = {
        ...(anyCartOn ? { enabled: true } : {}),
        showVolumeUpsell: state.cart_volume_upsell.on,
        showFreeShippingBar: state.free_shipping_bar.on,
        showSubscriptionUpsell: state.cart_subscription_upsell.on,
        showTrustRow: state.cart_trust_row.on,
      };
    }

    if (state.trust_badges.on !== initial.trust_badges.on) {
      patch.trustBadges = { enabled: state.trust_badges.on };
    }
    if (state.trustpilot.on !== initial.trustpilot.on) {
      patch.trustpilot = { enabled: state.trustpilot.on };
    }
    if (state.guarantee.on !== initial.guarantee.on) {
      patch.guarantee = { enabled: state.guarantee.on };
    }
    if (state.clinical_results.on !== initial.clinical_results.on) {
      patch.clinicalResults = { enabled: state.clinical_results.on };
    }
    if (state.subscription_nudge.on !== initial.subscription_nudge.on) {
      patch.subscriptionNudge = { enabled: state.subscription_nudge.on };
    }
    if (state.checkout_upsell.on !== initial.checkout_upsell.on) {
      patch.checkoutUpsell = { enabled: state.checkout_upsell.on };
    }
    if (state.checkout_protection.on !== initial.checkout_protection.on) {
      patch.checkoutProtection = { enabled: state.checkout_protection.on };
    }
    if (state.checkout_trust.on !== initial.checkout_trust.on) {
      patch.checkoutTrust = { enabled: state.checkout_trust.on };
    }
    // v9 trust rows share the checkoutTrust master switch (the cart-rows
    // contract above): turning a row on must set the master on + its
    // show-flag; turning one off clears only its show-flag. Both show-flags
    // are written together so a dormant row can't resurface when the master
    // flips on. Spread order matters: a row newly turned ON wins over an
    // `enabled: false` written by the module row above (FEATURE_DEFS set
    // semantics — enabling a sub-feature implies its master).
    const TRUST_ROW_KEYS = ["checkout_customs", "checkout_tracked"] as const;
    const trustRowsChanged = TRUST_ROW_KEYS.some(
      (key) => state[key].on !== initial[key].on,
    );
    if (trustRowsChanged) {
      const anyRowTurnedOn = TRUST_ROW_KEYS.some(
        (key) => state[key].on && !initial[key].on,
      );
      patch.checkoutTrust = {
        ...(patch.checkoutTrust ?? {}),
        ...(anyRowTurnedOn ? { enabled: true } : {}),
        showCustoms: state.checkout_customs.on,
        showTracked: state.checkout_tracked.on,
      };
    }
    if (state.cart_cross_sell.on !== initial.cart_cross_sell.on) {
      patch.cartCrossSell = { enabled: state.cart_cross_sell.on };
    }
    if (state.dispatch_countdown.on !== initial.dispatch_countdown.on) {
      patch.dispatch = { enabled: state.dispatch_countdown.on };
    }
    if (state.delivery_estimate.on !== initial.delivery_estimate.on) {
      patch.deliveryEstimate = { enabled: state.delivery_estimate.on };
    }

    // v8.6 rows — simple one-boolean sections (client-safe mirror of the
    // dashboard buildPatch literals; the action validates server-side).
    const SIMPLE_SECTIONS = [
      ["clinical_study", "clinicalStudy"],
      ["verified_before_after", "beforeAfter"],
      ["batch_transparency", "batchTransparency"],
      ["empty_bottle_guarantee", "emptyBottleGuarantee"],
      ["derm_survey", "dermSurvey"],
      ["press", "press"],
      ["derm_endorsements", "dermEndorsements"],
    ] as const;
    for (const [key, section] of SIMPLE_SECTIONS) {
      if (state[key].on !== initial[key].on) {
        (patch as Record<string, unknown>)[section] = {
          enabled: state[key].on,
        };
      }
    }

    // Amazon patterns are INDEPENDENT flags — there is NO shared master
    // switch (unlike the cart rows' cartUpsell; see AMAZON_FLAG_FIELDS in
    // settings.server.ts: "each key toggles independently"). Write only the
    // rows the merchant actually changed, the same changed-only discipline
    // as SIMPLE_SECTIONS above — a stale tab must never rewrite untouched
    // az flags.
    const azChangedKeys = AZ_MATRIX_KEYS.filter(
      (key) => state[key].on !== initial[key].on,
    );
    if (azChangedKeys.length > 0) {
      patch.amazon = Object.fromEntries(
        azChangedKeys.map((key) => [AZ_FLAG_FIELD[key], state[key].on]),
      ) as Partial<Record<(typeof AZ_FLAG_FIELD)[AzMatrixKey], boolean>>;
    }

    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  const handleDiscard = () => {
    setState(initial);
  };

  /** Row-level dirty flag for the "Edited" badge in the list (markets are
   *  sets — compare order-insensitively, same as the global dirty check). */
  const rowDirty = (key: FeatureKey): boolean => {
    const a = state[key];
    const b = initial[key];
    // A key can appear in revalidated loader data one render before the
    // state-reset effect re-seeds MatrixState (review v8.13 F5).
    if (!a || !b) return false;
    return (
      a.on !== b.on ||
      a.mode !== b.mode ||
      [...a.markets].sort().join("\u0000") !==
        [...b.markets].sort().join("\u0000")
    );
  };

  /** How many CURRENT markets the row reaches (stale handles for deleted
   *  markets are kept in the save payload but not counted here). */
  const effectiveCount = (row: RowState): number =>
    row.mode === "all"
      ? markets.length
      : row.markets.filter((handle) => allHandles.includes(handle)).length;

  const reachLabel = (row: RowState): string => {
    if (row.mode === "all") return "All markets";
    if (markets.length === 0) return "Selected markets";
    return `${effectiveCount(row)} of ${markets.length} markets`;
  };

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return renderGroups;
    return renderGroups
      .map((group) => ({
        ...group,
        features: group.features.filter(
          ({ key, label }) =>
            label.toLowerCase().includes(q) ||
            key.includes(q) ||
            group.title.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.features.length > 0);
  }, [renderGroups, query]);

  const selectedFeature =
    allFeatures.find(({ key }) => key === selectedKey) ?? null;
  const selectedGroupTitle = selectedFeature
    ? renderGroups.find((group) =>
        group.features.some(({ key }) => key === selectedFeature.key),
      )?.title ?? ""
    : "";
  const selectedRow = selectedFeature ? state[selectedFeature.key] : null;

  return (
    <Page
      fullWidth
      title="Markets"
      subtitle="Per-market feature targeting"
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
      <TitleBar title="Markets" />
      <Layout>
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

        {dirty ? (
          <Layout.Section>
            <Banner tone="warning" title="Unsaved changes">
              <BlockStack gap="200">
                <Text as="p">
                  Your market targeting changes are not saved yet — nothing
                  has changed on the storefront.
                </Text>
                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    onClick={handleSave}
                    loading={isSaving}
                  >
                    Save
                  </Button>
                  <Button onClick={handleDiscard} disabled={isSaving}>
                    Discard
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {markets.length === 0 ? (
          <Layout.Section>
            <Banner tone="info" title="No markets loaded">
              <Text as="p">
                Your shop’s markets could not be loaded (the read_markets
                scope may still need approval, or the shop has no active
                markets). Features keep working with their “All markets”
                scope in the meantime.
              </Text>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)",
              gap: 16,
              alignItems: "start",
            }}
          >
            <Card padding="0">
              <Box padding="300" borderBlockEndWidth="025" borderColor="border">
                <TextField
                  label="Search features"
                  labelHidden
                  placeholder="Search features"
                  value={query}
                  onChange={setQuery}
                  autoComplete="off"
                  prefix={<Icon source={SearchIcon} tone="subdued" />}
                  clearButton
                  onClearButtonClick={() => setQuery("")}
                />
              </Box>
              <div style={{ maxHeight: 620, overflowY: "auto" }}>
                {visibleGroups.map((group) => (
                  <div key={group.title}>
                    <div style={groupHeaderStyle}>
                      <Text as="h3" variant="headingXs" tone="subdued">
                        {group.title}
                      </Text>
                    </div>
                    {group.features.map(({ key, label }) => {
                      // Fallback for the one-render window where a freshly
                      // revalidated key exists before the state-reset effect
                      // re-seeds MatrixState (review v8.13 F5).
                      const row = state[key] ?? {
                        on: featureStates[key],
                        mode: "all" as const,
                        markets: [],
                      };
                      const selected = key === selectedKey;
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-current={selected ? "true" : undefined}
                          onClick={() => setSelectedKey(key)}
                          style={{
                            ...listRowStyle,
                            ...(selected ? listRowSelectedStyle : {}),
                          }}
                        >
                          <InlineStack
                            gap="200"
                            blockAlign="center"
                            align="space-between"
                            wrap={false}
                          >
                            <BlockStack gap="050">
                              <Text
                                as="span"
                                variant="bodyMd"
                                fontWeight={selected ? "semibold" : "regular"}
                              >
                                {label}
                              </Text>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {reachLabel(row)}
                              </Text>
                            </BlockStack>
                            <InlineStack gap="100" wrap={false}>
                              {rowDirty(key) ? (
                                <Badge tone="attention" size="small">
                                  Edited
                                </Badge>
                              ) : null}
                              <Badge
                                tone={row.on ? "success" : undefined}
                                size="small"
                              >
                                {row.on ? "Active" : "Off"}
                              </Badge>
                            </InlineStack>
                          </InlineStack>
                        </button>
                      );
                    })}
                  </div>
                ))}
                {visibleGroups.length === 0 ? (
                  <Box padding="400">
                    <Text as="p" variant="bodySm" tone="subdued">
                      No features match “{query.trim()}”.
                    </Text>
                  </Box>
                ) : null}
              </div>
            </Card>

            <Card>
              {selectedFeature && selectedRow ? (
                <BlockStack gap="400">
                  <InlineStack
                    gap="200"
                    blockAlign="start"
                    align="space-between"
                  >
                    <BlockStack gap="100">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="h2" variant="headingMd">
                          {selectedFeature.label}
                        </Text>
                        <Badge tone={selectedRow.on ? "success" : undefined}>
                          {selectedRow.on ? "Active" : "Off"}
                        </Badge>
                      </InlineStack>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {selectedGroupTitle}
                      </Text>
                    </BlockStack>
                    <Button
                      onClick={() => toggleMaster(selectedFeature.key)}
                      variant={selectedRow.on ? undefined : "primary"}
                      disabled={isSaving}
                    >
                      {selectedRow.on ? "Turn off" : "Turn on"}
                    </Button>
                  </InlineStack>

                  {!selectedRow.on ? (
                    <Banner tone="info">
                      <Text as="p" variant="bodySm">
                        Off — selections save now, apply when enabled. Set the
                        market targeting first, turn the feature on whenever
                        you’re ready.
                      </Text>
                    </Banner>
                  ) : null}

                  <Divider />

                  <Checkbox
                    label="All markets"
                    helpText={
                      markets.length === 0
                        ? "The market list is unavailable, so hand-picking markets is disabled — the feature keeps its all-markets scope."
                        : "Show in every market, including markets you add later. Uncheck to hand-pick markets below."
                    }
                    checked={selectedRow.mode === "all"}
                    disabled={
                      isSaving ||
                      (markets.length === 0 && selectedRow.mode === "all")
                    }
                    onChange={(checked) =>
                      setAllMarkets(selectedFeature.key, checked)
                    }
                  />

                  {markets.length > 0 ? (
                    <BlockStack gap="200">
                      <InlineStack
                        gap="200"
                        blockAlign="center"
                        align="space-between"
                      >
                        <Text as="h3" variant="headingSm">
                          Markets ({effectiveCount(selectedRow)}/
                          {markets.length})
                        </Text>
                        <InlineStack gap="200">
                          <Button
                            variant="plain"
                            size="slim"
                            disabled={isSaving}
                            onClick={() =>
                              selectAllMarkets(selectedFeature.key)
                            }
                          >
                            Select all
                          </Button>
                          <Button
                            variant="plain"
                            size="slim"
                            disabled={isSaving}
                            onClick={() => clearMarkets(selectedFeature.key)}
                          >
                            Clear
                          </Button>
                        </InlineStack>
                      </InlineStack>
                      <InlineStack gap="150" wrap>
                        {markets.map((market) => {
                          const checked =
                            selectedRow.mode === "all" ||
                            selectedRow.markets.includes(market.handle);
                          return (
                            <Button
                              key={market.id}
                              size="slim"
                              pressed={checked}
                              variant={checked ? "primary" : undefined}
                              disabled={isSaving}
                              onClick={() =>
                                toggleCell(
                                  selectedFeature.key,
                                  market.handle,
                                  !checked,
                                )
                              }
                              accessibilityLabel={`Show ${selectedFeature.label} in ${market.name}`}
                            >
                              {market.name +
                                (market.primary ? " · primary" : "") +
                                (market.enabled ? "" : " · inactive")}
                            </Button>
                          );
                        })}
                      </InlineStack>
                    </BlockStack>
                  ) : null}
                  {/* Outside the markets.length > 0 gate so a saved
                      selected-mode row still warns when the market list
                      fails to load (review v8.13 F2). With no list loaded,
                      only a truly EMPTY selection warns — saved handles for
                      real-but-unloaded markets are not a false alarm. */}
                  {selectedRow.mode === "selected" &&
                  (markets.length > 0
                    ? effectiveCount(selectedRow) === 0
                    : selectedRow.markets.length === 0) ? (
                    <Text as="p" variant="bodySm" tone="caution">
                      No markets selected — this feature won’t appear
                      anywhere, even when enabled.
                    </Text>
                  ) : null}
                </BlockStack>
              ) : (
                <Text as="p" tone="subdued">
                  Pick a feature on the left to edit its market targeting.
                </Text>
              )}
            </Card>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
