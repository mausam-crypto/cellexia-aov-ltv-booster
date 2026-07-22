import { useEffect } from "react";
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
  Divider,
  InlineStack,
  Layout,
  Link as PolarisLink,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  FEATURE_KEYS,
  getSettings,
  resolveFeatureFlag,
  saveSettings,
  snapshotFlags,
  type BoosterSettings,
  type DeepPartial,
  type FeatureKey,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { getAnalyticsSummary } from "../services/analytics.server";
import {
  experimentDay,
  getEarlyWarning,
  listRunningExperiments,
} from "../services/experiments.server";
import { getCachedHealth } from "../services/health.server";
import { getPreviewState } from "../services/preview.server";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

const UTC_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Fixed-format, timezone-independent timestamp (e.g. "Jul 21, 2026, 09:15
 * UTC"), built SERVER-SIDE in the loader and rendered verbatim — a
 * client-side toLocaleString() would hydrate differently from the server
 * render and trigger a React hydration mismatch.
 */
function formatUtcTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${UTC_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
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
  const [settings, summary, runningExperiments, healthSummary, previewState] =
    await Promise.all([
      getSettings(session.shop),
      getAnalyticsSummary(session.shop, 30),
      listRunningExperiments(session.shop),
      // Cached (5-min TTL): the dashboard must not re-run the full health
      // suite — theme file reads included — on every load/revalidation. The
      // Setup & health page keeps calling runHealthChecks for fresh results.
      getCachedHealth(admin, session),
      getPreviewState(session.shop),
    ]);
  const storePrefix = session.shop.replace(".myshopify.com", "");
  // Onboarding banner condition: every feature master flag is off (computed
  // through the canonical snapshot helper, never by re-deriving flag paths).
  const snapshot = snapshotFlags(settings);
  const allFeaturesOff =
    !snapshot.cartMaster &&
    Object.values(snapshot.sectionEnabled).every((enabled) => !enabled);
  // Canonical combined flag (master AND sub-flag) per feature, for the card
  // status badges — a sub-flag alone must never read as "Active".
  const combinedFlags = Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, resolveFeatureFlag(settings, key)]),
  ) as Record<FeatureKey, boolean>;
  // Early warnings for running experiments (same lazy-recompute cache as the
  // experiments pages) — surface critical ones at the top of the dashboard.
  const now = new Date();
  const experimentAlerts: { id: number; name: string; day: number }[] = [];
  for (const experiment of runningExperiments) {
    try {
      const warning = await getEarlyWarning(experiment, now);
      if (warning.severity === "critical") {
        experimentAlerts.push({
          id: experiment.id,
          name: experiment.name,
          day: experimentDay(experiment, now),
        });
      }
    } catch (error) {
      console.error(
        `Early-warning evaluation failed for experiment ${experiment.id}:`,
        error,
      );
    }
  }
  return {
    settings,
    summary,
    allFeaturesOff,
    combinedFlags,
    experimentAlerts,
    health: {
      passing: healthSummary.passing,
      total: healthSummary.total,
      anyFail: healthSummary.failing > 0,
    },
    previewArmed:
      previewState?.armed === true
        ? {
            // Pre-formatted server-side (fixed UTC format) so SSR and
            // hydration render the identical string.
            armedAtText: previewState.armedAt
              ? formatUtcTimestamp(previewState.armedAt)
              : null,
            draftCount: Object.values(previewState.draftFlags).filter(Boolean)
              .length,
          }
        : null,
    themeEditorUrl: `https://admin.shopify.com/store/${storePrefix}/themes/current/editor?context=apps`,
    checkoutEditorUrl: `https://admin.shopify.com/store/${storePrefix}/settings/checkout/editor`,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  return applySettingsPatch(session.shop, admin, formData.get("patch"));
};

interface FeatureDefinition {
  key: string;
  title: string;
  description: string;
  configureUrl: string;
  /** FeatureKeys whose market scopes this card summarizes. */
  scopeKeys: FeatureKey[];
  /**
   * Canonical FeatureKey for the status badge. Cards backed by a cart
   * sub-flag set this so the badge reflects the COMBINED state (master AND
   * sub-flag) via resolveFeatureFlag — the toggle still flips only the
   * sub-flag (isEnabled/buildPatch).
   */
  statusFlagKey?: FeatureKey;
  isEnabled: (settings: BoosterSettings) => boolean;
  buildPatch: (enabled: boolean) => DeepPartial<BoosterSettings>;
}

/**
 * Human summary of a card's market reach, computed from marketScopes.
 * Cards backed by several FeatureKeys (the cart master) report "Varies by
 * widget" when their sub-features target different market sets.
 */
function marketReach(
  scopes: Record<FeatureKey, { mode: "all" | "selected"; markets: string[] }>,
  keys: FeatureKey[],
): string {
  const resolved = keys.map(
    (key) => scopes[key] ?? { mode: "all" as const, markets: [] },
  );
  const signatures = new Set(
    resolved.map((scope) =>
      scope.mode === "all" ? "all" : [...scope.markets].sort().join("|"),
    ),
  );
  if (signatures.size > 1) return "Varies by widget";
  const scope = resolved[0];
  if (!scope || scope.mode === "all") return "All markets";
  if (scope.markets.length === 0) return "No markets selected";
  return scope.markets.length === 1
    ? "1 market"
    : `${scope.markets.length} markets`;
}

const FEATURES: FeatureDefinition[] = [
  {
    key: "cart_upsell",
    title: "Cart upsells",
    description:
      "Master switch for the cart drawer booster: volume upgrades, free-shipping bar, subscription switch and trust row.",
    configureUrl: "/app/features/cart",
    scopeKeys: [
      "cart_volume_upsell",
      "free_shipping_bar",
      "cart_subscription_upsell",
      "cart_trust_row",
    ],
    isEnabled: (settings) => settings.cartUpsell.enabled,
    buildPatch: (enabled) => ({ cartUpsell: { enabled } }),
  },
  {
    key: "free_shipping_bar",
    title: "Free-shipping bar",
    description:
      "Progress bar toward the free-shipping threshold in the cart drawer. Shown only while Cart upsells is active.",
    configureUrl: "/app/features/cart",
    scopeKeys: ["free_shipping_bar"],
    statusFlagKey: "free_shipping_bar",
    isEnabled: (settings) => settings.cartUpsell.showFreeShippingBar,
    buildPatch: (enabled) => ({
      cartUpsell: { showFreeShippingBar: enabled },
    }),
  },
  {
    key: "subscription_switch",
    title: "Subscription switch",
    description:
      "One-click switch of one-time cart lines to the Continuous Treatment Plan. Shown only while Cart upsells is active.",
    configureUrl: "/app/features/cart",
    scopeKeys: ["cart_subscription_upsell"],
    statusFlagKey: "cart_subscription_upsell",
    isEnabled: (settings) => settings.cartUpsell.showSubscriptionUpsell,
    buildPatch: (enabled) => ({
      cartUpsell: { showSubscriptionUpsell: enabled },
    }),
  },
  {
    key: "cart_cross_sell",
    title: "Cart cross-sell",
    description:
      "Hand-picked complementary products offered in the cart drawer below the subscription offer. Products already in the cart are hidden automatically.",
    configureUrl: "/app/features/cart",
    scopeKeys: ["cart_cross_sell"],
    statusFlagKey: "cart_cross_sell",
    isEnabled: (settings) => settings.cartCrossSell.enabled,
    buildPatch: (enabled) => ({ cartCrossSell: { enabled } }),
  },
  {
    key: "dispatch_countdown",
    title: "Dispatch countdown",
    description:
      "“Order within 2h 14m for same-day dispatch” on product pages and in the cart drawer — shown only when the cutoff is genuinely today, on a dispatch day, and close enough to matter.",
    configureUrl: "/app/features/dispatch",
    scopeKeys: ["dispatch_countdown"],
    statusFlagKey: "dispatch_countdown",
    isEnabled: (settings) => settings.dispatch.enabled,
    buildPatch: (enabled) => ({ dispatch: { enabled } }),
  },
  {
    key: "trust_badges",
    title: "Trust badges",
    description:
      "Reassurance badge row on product pages and anywhere via the Trust badges app block.",
    configureUrl: "/app/features/badges",
    scopeKeys: ["trust_badges"],
    isEnabled: (settings) => settings.trustBadges.enabled,
    buildPatch: (enabled) => ({ trustBadges: { enabled } }),
  },
  {
    key: "trustpilot",
    title: "Trustpilot",
    description:
      "Star-rating strip with your Trustpilot score, review count and profile link.",
    configureUrl: "/app/features/badges",
    scopeKeys: ["trustpilot"],
    isEnabled: (settings) => settings.trustpilot.enabled,
    buildPatch: (enabled) => ({ trustpilot: { enabled } }),
  },
  {
    key: "guarantee",
    title: "Guarantee",
    description:
      "Money-back guarantee card on product pages and as an app block.",
    configureUrl: "/app/features/badges",
    scopeKeys: ["guarantee"],
    isEnabled: (settings) => settings.guarantee.enabled,
    buildPatch: (enabled) => ({ guarantee: { enabled } }),
  },
  {
    key: "clinical_results",
    title: "Clinical results",
    description:
      "“Proven by science” stat band app block with translated labels.",
    configureUrl: "/app/features/clinical",
    scopeKeys: ["clinical_results"],
    isEnabled: (settings) => settings.clinicalResults.enabled,
    buildPatch: (enabled) => ({ clinicalResults: { enabled } }),
  },
  {
    key: "subscription_nudge",
    title: "Subscription nudge",
    description:
      "“Never run out” card promoting the Continuous Treatment Plan on product pages.",
    configureUrl: "/app/features/subscriptions",
    scopeKeys: ["subscription_nudge"],
    isEnabled: (settings) => settings.subscriptionNudge.enabled,
    buildPatch: (enabled) => ({ subscriptionNudge: { enabled } }),
  },
  {
    key: "checkout_upsell",
    title: "Checkout upsell",
    description:
      "“Complete your routine” product offers in checkout (Shopify Plus).",
    configureUrl: "/app/features/checkout",
    scopeKeys: ["checkout_upsell"],
    isEnabled: (settings) => settings.checkoutUpsell.enabled,
    buildPatch: (enabled) => ({ checkoutUpsell: { enabled } }),
  },
  {
    key: "checkout_protection",
    title: "Order protection",
    description:
      "Optional shipping-protection add-on the buyer can toggle in checkout.",
    configureUrl: "/app/features/checkout",
    scopeKeys: ["checkout_protection"],
    isEnabled: (settings) => settings.checkoutProtection.enabled,
    buildPatch: (enabled) => ({ checkoutProtection: { enabled } }),
  },
  {
    key: "checkout_trust",
    title: "Checkout trust",
    description:
      "Guarantee, secure-checkout and Trustpilot reassurance module in checkout.",
    configureUrl: "/app/features/checkout",
    scopeKeys: ["checkout_trust"],
    isEnabled: (settings) => settings.checkoutTrust.enabled,
    buildPatch: (enabled) => ({ checkoutTrust: { enabled } }),
  },
];

/**
 * SPEC v3 PDP trust boosters — separate "Product page — trust boosters" card
 * group. Content for the first four lives per product (Product boosters
 * page); the survey uses global settings.
 */
const PDP_FEATURES: FeatureDefinition[] = [
  {
    key: "clinical_study",
    title: "Clinical study",
    description:
      "Independent clinical study block on product pages — headline result, instrument-measured stats and methodology small print.",
    configureUrl: "/app/products",
    scopeKeys: ["clinical_study"],
    statusFlagKey: "clinical_study",
    isEnabled: (settings) => settings.clinicalStudy.enabled,
    buildPatch: (enabled) => ({ clinicalStudy: { enabled } }),
  },
  {
    key: "verified_before_after",
    title: "Verified before/after",
    description:
      "Unretouched before/after images with real dates, verified by a named professional with license number.",
    configureUrl: "/app/products",
    scopeKeys: ["verified_before_after"],
    statusFlagKey: "verified_before_after",
    isEnabled: (settings) => settings.beforeAfter.enabled,
    buildPatch: (enabled) => ({ beforeAfter: { enabled } }),
  },
  {
    key: "batch_transparency",
    title: "Batch transparency",
    description:
      "Exact ingredient concentrations and downloadable certificates of analysis per batch.",
    configureUrl: "/app/products",
    scopeKeys: ["batch_transparency"],
    statusFlagKey: "batch_transparency",
    isEnabled: (settings) => settings.batchTransparency.enabled,
    buildPatch: (enabled) => ({ batchTransparency: { enabled } }),
  },
  {
    key: "empty_bottle_guarantee",
    title: "Empty bottle guarantee",
    description:
      "“Use every last drop” risk-reversal panel — return the empty bottle for a full refund.",
    configureUrl: "/app/products",
    scopeKeys: ["empty_bottle_guarantee"],
    statusFlagKey: "empty_bottle_guarantee",
    isEnabled: (settings) => settings.emptyBottleGuarantee.enabled,
    buildPatch: (enabled) => ({ emptyBottleGuarantee: { enabled } }),
  },
  {
    key: "derm_survey",
    title: "Dermatologist survey",
    description:
      "“9/10 dermatologists surveyed would recommend Cellexia” with a third-party verification seal, on every product page.",
    configureUrl: "/app/features/survey",
    scopeKeys: ["derm_survey"],
    statusFlagKey: "derm_survey",
    isEnabled: (settings) => settings.dermSurvey.enabled,
    buildPatch: (enabled) => ({ dermSurvey: { enabled } }),
  },
];

interface FeatureToggleRowProps {
  feature: FeatureDefinition;
  settings: BoosterSettings;
  combinedFlags: Record<FeatureKey, boolean>;
  pendingFeature: FormDataEntryValue | null;
  onToggle: (feature: FeatureDefinition, nextEnabled: boolean) => void;
}

function FeatureToggleRow({
  feature,
  settings,
  combinedFlags,
  pendingFeature,
  onToggle,
}: FeatureToggleRowProps) {
  const enabled = feature.isEnabled(settings);
  // Status uses the canonical combined flag (master AND sub-flag): a
  // sub-flag that is on while its master is off is "waiting", not Active.
  const live = feature.statusFlagKey
    ? combinedFlags[feature.statusFlagKey]
    : enabled;
  const waiting = enabled && !live;
  return (
    <BlockStack gap="400">
      <Divider />
      <InlineStack gap="300" align="space-between" blockAlign="center" wrap>
        <Box maxWidth="60ch">
          <BlockStack gap="050">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">
                {feature.title}
              </Text>
              <Badge tone={live ? "success" : undefined}>
                {live
                  ? "Active"
                  : waiting
                    ? "Waiting for Cart upsells"
                    : "Off"}
              </Badge>
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              {feature.description}
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Market reach:{" "}
              {marketReach(settings.marketScopes, feature.scopeKeys)}
            </Text>
          </BlockStack>
        </Box>
        <InlineStack gap="200" blockAlign="center">
          <Button variant="plain" url={feature.configureUrl}>
            Configure
          </Button>
          <Button
            onClick={() => onToggle(feature, !enabled)}
            loading={pendingFeature === feature.key}
            variant={enabled ? "secondary" : "primary"}
          >
            {enabled ? "Disable" : "Enable"}
          </Button>
        </InlineStack>
      </InlineStack>
    </BlockStack>
  );
}

function formatMoney(value: number, currency: string | null): string {
  if (!currency) return value.toFixed(2);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export default function Dashboard() {
  const {
    settings,
    summary,
    allFeaturesOff,
    combinedFlags,
    experimentAlerts,
    health,
    previewArmed,
    themeEditorUrl,
    checkoutEditorUrl,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const pendingFeature =
    navigation.state !== "idle" && navigation.formData
      ? navigation.formData.get("feature")
      : null;

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

  const toggleFeature = (feature: FeatureDefinition, nextEnabled: boolean) => {
    const formData = new FormData();
    formData.set("feature", feature.key);
    formData.set("patch", JSON.stringify(feature.buildPatch(nextEnabled)));
    submit(formData, { method: "post" });
  };

  const stats = [
    {
      label: "Average order value (30 days)",
      value: formatMoney(summary.aov, summary.currency),
    },
    { label: "Units per order", value: summary.unitsPerOrder.toFixed(2) },
    {
      label: "Subscription rate",
      value: formatPercent(summary.subscriptionRate),
    },
    {
      label: "Protection attach rate",
      value: formatPercent(summary.protectionAttachRate),
    },
  ];

  return (
    <Page title="Dashboard" subtitle="Cellexia AOV & LTV Booster">
      <TitleBar title="Dashboard" />
      <Layout>
        {health.anyFail ? (
          <Layout.Section>
            <Banner
              tone="critical"
              title={`Setup: ${health.passing}/${health.total} checks passing`}
            >
              <BlockStack gap="200">
                <Text as="p">
                  At least one setup check is failing — widgets may not render
                  (or may render stale settings) until it is fixed.
                </Text>
                <InlineStack gap="200">
                  <Button url="/app/setup">Open Setup &amp; health</Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {previewArmed ? (
          <Layout.Section>
            <Banner tone="info" title="Preview is armed">
              <BlockStack gap="200">
                <Text as="p">
                  {previewArmed.draftCount} draft feature
                  {previewArmed.draftCount === 1 ? "" : "s"} armed
                  {previewArmed.armedAtText
                    ? ` since ${previewArmed.armedAtText}`
                    : ""}
                  . Real visitors see no change — only browsers holding your
                  preview link see the drafts. Disarm from the Preview Center
                  when you are done.
                </Text>
                <InlineStack gap="200">
                  <Button url="/app/preview">Open Preview Center</Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {experimentAlerts.length > 0 ? (
          <Layout.Section>
            <Banner
              tone="critical"
              title="Early warning: a running experiment shows significant negative movement"
            >
              <BlockStack gap="200">
                <Text as="p">
                  Open the experiment to review the numbers and decide whether
                  to stop and roll back:
                </Text>
                <List>
                  {experimentAlerts.map((alert) => (
                    <List.Item key={alert.id}>
                      <PolarisLink url={`/app/experiments/${alert.id}`}>
                        {alert.name}
                      </PolarisLink>{" "}
                      (day {alert.day})
                    </List.Item>
                  ))}
                </List>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

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

        {allFeaturesOff && !health.anyFail ? (
          <Layout.Section>
            <Banner
              tone="info"
              title="Cellexia Booster is installed but not live anywhere yet"
            >
              <BlockStack gap="200">
                <Text as="p">
                  Nothing changes on your store until you go live. Three steps:
                </Text>
                <List type="number">
                  <List.Item>
                    Get{" "}
                    <PolarisLink url="/app/setup">Setup &amp; health</PolarisLink>{" "}
                    green — every check verified ({health.passing}/
                    {health.total} passing).
                  </List.Item>
                  <List.Item>
                    Preview features on the real storefront in the{" "}
                    <PolarisLink url="/app/preview">Preview Center</PolarisLink>{" "}
                    — visible only to you, never to visitors.
                  </List.Item>
                  <List.Item>
                    Go live per market from the same page — the exact diff is
                    shown before anything changes.
                  </List.Item>
                </List>
                <InlineStack gap="200">
                  <Button url="/app/preview">Open the Preview Center</Button>
                  <Button url="/app/features" variant="plain">
                    Browse all features
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <BlockStack gap="200">
            <InlineStack gap="400" wrap>
              {stats.map((stat) => (
                <Box key={stat.label} minWidth="200px">
                  <Card>
                    <BlockStack gap="100">
                      <Text as="span" variant="bodySm" tone="subdued">
                        {stat.label}
                      </Text>
                      <Text as="p" variant="headingLg">
                        {stat.value}
                      </Text>
                    </BlockStack>
                  </Card>
                </Box>
              ))}
            </InlineStack>
            {summary.orders === 0 ? (
              <Text as="p" tone="subdued" variant="bodySm">
                Order stats appear once the first orders are tracked (
                {summary.days}-day window).
              </Text>
            ) : null}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Features
                </Text>
                <Text as="p" tone="subdued">
                  Toggle each booster on or off, or open its configuration
                  page.
                </Text>
              </BlockStack>
              {FEATURES.map((feature) => (
                <FeatureToggleRow
                  key={feature.key}
                  feature={feature}
                  settings={settings}
                  combinedFlags={combinedFlags}
                  pendingFeature={pendingFeature}
                  onToggle={toggleFeature}
                />
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Product page — trust boosters
                </Text>
                <Text as="p" tone="subdued">
                  Precision-trust widgets on product pages: clinical study,
                  verified before/after, batch transparency, empty bottle
                  guarantee and the dermatologist survey. Content is managed
                  per product on the Product boosters page.
                </Text>
              </BlockStack>
              {PDP_FEATURES.map((feature) => (
                <FeatureToggleRow
                  key={feature.key}
                  feature={feature}
                  settings={settings}
                  combinedFlags={combinedFlags}
                  pendingFeature={pendingFeature}
                  onToggle={toggleFeature}
                />
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Storefront setup
              </Text>
              <Text as="p" tone="subdued">
                Enable the Cellexia Booster app embeds in the theme editor and
                place the checkout blocks in the checkout editor.
              </Text>
              <InlineStack gap="300">
                <Button url={themeEditorUrl} target="_blank">
                  Open theme editor
                </Button>
                <Button url={checkoutEditorUrl} target="_blank">
                  Open checkout editor
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
