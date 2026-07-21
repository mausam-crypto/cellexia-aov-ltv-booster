import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  FEATURE_DEFS,
  FEATURE_KEYS,
  getSettings,
  resolveFeatureFlag,
  type FeatureKey,
} from "../models/settings.server";
import { getPreviewState } from "../services/preview.server";

/**
 * Features hub (SPEC v4 §C): all 17 features as cards grouped by surface,
 * each with live status, market reach, a preview-draft chip, its Configure
 * page and a Preview Center deep link.
 *
 * Flat-routes note: this file maps to /app/features EXACTLY — the existing
 * feature pages (app.features.cart etc.) are SIBLING routes, so no <Outlet>
 * is needed and none of them change behavior.
 */

const CONFIGURE_URL: Record<FeatureKey, string> = {
  cart_volume_upsell: "/app/features/cart",
  free_shipping_bar: "/app/features/cart",
  cart_subscription_upsell: "/app/features/cart",
  cart_trust_row: "/app/features/cart",
  trust_badges: "/app/features/badges",
  trustpilot: "/app/features/badges",
  guarantee: "/app/features/badges",
  clinical_results: "/app/features/clinical",
  subscription_nudge: "/app/features/subscriptions",
  checkout_upsell: "/app/features/checkout",
  checkout_protection: "/app/features/checkout",
  checkout_trust: "/app/features/checkout",
  clinical_study: "/app/products",
  verified_before_after: "/app/products",
  batch_transparency: "/app/products",
  empty_bottle_guarantee: "/app/products",
  derm_survey: "/app/features/survey",
};

const GROUPS: { title: string; description: string; keys: FeatureKey[] }[] = [
  {
    title: "Cart drawer",
    description:
      "Widgets inside the mini-cart drawer: volume upgrades, free-shipping progress, subscription switch and the trust row.",
    keys: [
      "cart_volume_upsell",
      "free_shipping_bar",
      "cart_subscription_upsell",
      "cart_trust_row",
    ],
  },
  {
    title: "Product page",
    description:
      "Trust and conversion widgets on product pages — badge rows, social proof, clinical evidence and per-product trust boosters.",
    keys: [
      "trust_badges",
      "trustpilot",
      "guarantee",
      "clinical_results",
      "subscription_nudge",
      "clinical_study",
      "verified_before_after",
      "batch_transparency",
      "empty_bottle_guarantee",
      "derm_survey",
    ],
  },
  {
    title: "Checkout",
    description:
      "Checkout UI extensions (Shopify Plus): last-step upsells, order protection and the reassurance module.",
    keys: ["checkout_upsell", "checkout_protection", "checkout_trust"],
  },
];

interface FeatureCardData {
  key: FeatureKey;
  label: string;
  on: boolean;
  reach: string;
  draft: boolean;
  configureUrl: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [settings, previewState] = await Promise.all([
    getSettings(session.shop),
    getPreviewState(session.shop),
  ]);

  const previewArmed = previewState?.armed === true;
  const draftFlags = previewArmed ? previewState!.draftFlags : {};

  const features = Object.fromEntries(
    FEATURE_KEYS.map((key) => {
      const scope = settings.marketScopes[key] ?? {
        mode: "all" as const,
        markets: [],
      };
      const reach =
        scope.mode === "all"
          ? "All markets"
          : scope.markets.length === 0
            ? "No markets selected"
            : scope.markets.length === 1
              ? `1 market (${scope.markets[0]})`
              : `${scope.markets.length} markets`;
      return [
        key,
        {
          key,
          label: FEATURE_DEFS[key].label,
          on: resolveFeatureFlag(settings, key),
          reach,
          draft: draftFlags[key] === true,
          configureUrl: CONFIGURE_URL[key],
        } satisfies FeatureCardData,
      ];
    }),
  ) as Record<FeatureKey, FeatureCardData>;

  return { features, previewArmed };
};

function FeatureRow({ feature }: { feature: FeatureCardData }) {
  return (
    <BlockStack gap="300">
      <Divider />
      <InlineStack gap="300" align="space-between" blockAlign="center" wrap>
        <Box maxWidth="60ch">
          <BlockStack gap="050">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">
                {feature.label}
              </Text>
              <Badge tone={feature.on ? "success" : undefined}>
                {feature.on ? "Active" : "Off"}
              </Badge>
              {feature.draft ? (
                <Badge tone="attention">Draft in preview</Badge>
              ) : null}
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              Market reach: {feature.reach}
            </Text>
          </BlockStack>
        </Box>
        <InlineStack gap="200" blockAlign="center">
          <Button variant="plain" url={feature.configureUrl}>
            Configure
          </Button>
          <Button
            variant="plain"
            url={`/app/preview?feature=${encodeURIComponent(feature.key)}`}
          >
            Preview
          </Button>
        </InlineStack>
      </InlineStack>
    </BlockStack>
  );
}

export default function FeaturesHub() {
  const { features, previewArmed } = useLoaderData<typeof loader>();

  return (
    <Page
      title="Features"
      subtitle="All 17 boosters — status, reach, configuration and preview"
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <TitleBar title="Features" />
      <Layout>
        {previewArmed ? (
          <Layout.Section>
            <Card>
              <InlineStack gap="200" blockAlign="center" wrap>
                <Badge tone="attention">Preview armed</Badge>
                <Text as="span" tone="subdued" variant="bodySm">
                  Features marked “Draft in preview” are visible to preview
                  sessions only.
                </Text>
                <Button variant="plain" url="/app/preview">
                  Open Preview Center
                </Button>
              </InlineStack>
            </Card>
          </Layout.Section>
        ) : null}

        {GROUPS.map((group) => (
          <Layout.Section key={group.title}>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    {group.title}
                  </Text>
                  <Text as="p" tone="subdued">
                    {group.description}
                  </Text>
                </BlockStack>
                {group.keys.map((key) => (
                  <FeatureRow key={key} feature={features[key]} />
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        ))}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Related settings
              </Text>
              <Text as="p" tone="subdued">
                Everything else that shapes what shoppers see.
              </Text>
              <InlineStack gap="200" wrap>
                <Button url="/app/localization" variant="plain">
                  Localization &amp; languages
                </Button>
                <Button url="/app/features/survey" variant="plain">
                  Dermatologist survey settings
                </Button>
                <Button url="/app/markets" variant="plain">
                  Market targeting matrix
                </Button>
                <Button url="/app/products" variant="plain">
                  Product boosters (per-product content)
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
