import type { LoaderFunctionArgs } from "@remix-run/node";
import {
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
import {
  BlockStack,
  Box,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  Layout,
  Page,
  Select,
  Spinner,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getAnalyticsSummary } from "../services/analytics.server";

const PERIODS = [7, 30, 90] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const daysParam = Number(url.searchParams.get("days"));
  const days = (PERIODS as readonly number[]).includes(daysParam)
    ? daysParam
    : 30;
  const summary = await getAnalyticsSummary(session.shop, days);
  return { summary };
};

const FEATURE_LABELS: Record<string, string> = {
  cart_upsell: "Cart upsells",
  free_shipping_bar: "Free-shipping bar",
  subscription_upsell: "Subscription switch",
  subscription_nudge: "Subscription nudge",
  trust_badges: "Trust badges",
  trustpilot: "Trustpilot",
  guarantee: "Guarantee",
  clinical_results: "Clinical results",
  checkout_upsell: "Checkout upsell",
  checkout_protection: "Order protection",
  checkout_trust: "Checkout trust",
};

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

/** Renders per-currency beacon revenue, e.g. "€1,234.50 · $567.00". */
function formatFunnelRevenue(
  revenueByCurrency: Record<string, number>,
  fallbackCurrency: string | null,
): string {
  const entries = Object.entries(revenueByCurrency).sort(
    ([, a], [, b]) => b - a,
  );
  if (entries.length === 0) return formatMoney(0, fallbackCurrency);
  return entries
    .map(([currency, amount]) =>
      currency === "unknown"
        ? amount.toFixed(2)
        : formatMoney(amount, currency),
    )
    .join(" · ");
}

export default function AnalyticsPage() {
  const { summary } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();

  const handlePeriodChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("days", value);
    setSearchParams(next, { replace: true });
  };

  const isLoading = navigation.state === "loading";

  const stats = [
    { label: "Orders", value: String(summary.orders) },
    {
      label: "Average order value",
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
    {
      label: "Upsell-attributed orders",
      value: formatPercent(summary.upsellAttributionRate),
    },
  ];

  const rows: (string | number)[][] = summary.funnels.map((funnel) => [
    FEATURE_LABELS[funnel.feature] ?? funnel.feature,
    funnel.impressions,
    funnel.clicks,
    funnel.conversions,
    formatFunnelRevenue(funnel.revenueByCurrency, summary.currency),
  ]);

  return (
    <Page title="Analytics" backAction={{ content: "Dashboard", url: "/app" }}>
      <TitleBar title="Analytics" />
      <Layout>
        <Layout.Section>
          <InlineStack gap="300" blockAlign="center">
            <Box minWidth="180px">
              <Select
                label="Period"
                options={[
                  { label: "Last 7 days", value: "7" },
                  { label: "Last 30 days", value: "30" },
                  { label: "Last 90 days", value: "90" },
                ]}
                value={String(summary.days)}
                onChange={handlePeriodChange}
              />
            </Box>
            {isLoading ? (
              <Box paddingBlockStart="600">
                <Spinner size="small" accessibilityLabel="Loading analytics" />
              </Box>
            ) : null}
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="400" wrap>
            {stats.map((stat) => (
              <Box key={stat.label} minWidth="180px">
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
        </Layout.Section>

        <Layout.Section>
          {summary.funnels.length === 0 ? (
            <Card>
              <EmptyState
                heading="No analytics yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                action={{ content: "Open setup links", url: "/app/settings" }}
              >
                <p>
                  Impressions, clicks and conversions appear here once the
                  Cellexia Booster app embed is live in your theme and shoppers
                  start seeing the widgets. Beacons flow automatically — no
                  extra setup needed.
                </p>
              </EmptyState>
            </Card>
          ) : (
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Feature funnels ({summary.days} days)
                </Text>
                <DataTable
                  columnContentTypes={[
                    "text",
                    "numeric",
                    "numeric",
                    "numeric",
                    "numeric",
                  ]}
                  headings={[
                    "Feature",
                    "Impressions",
                    "Clicks",
                    "Conversions",
                    "Revenue",
                  ]}
                  rows={rows}
                />
                <Text as="p" tone="subdued" variant="bodySm">
                  Conversions include upgrades, plan switches, add-to-carts and
                  protection opt-ins. Revenue is the incremental value reported
                  by each widget’s beacons.
                </Text>
              </BlockStack>
            </Card>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
