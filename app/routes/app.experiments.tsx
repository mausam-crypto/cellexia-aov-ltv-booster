import type { LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLoaderData, useMatches } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineStack,
  Layout,
  Link as PolarisLink,
  List,
  Page,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { listMarkets } from "../services/markets.server";
import {
  experimentDay,
  getRunningQuickStats,
  listExperiments,
  type RunningQuickStats,
} from "../services/experiments.server";

interface RunningExperimentCard {
  id: number;
  name: string;
  marketLabel: string;
  day: number;
  baselineDays: number;
  severity: "none" | "caution" | "critical";
  /** Whole days in each comparison window so far (0 during the first 24 h). */
  daysCompared: number;
  /** Quick numbers vs baseline so far — null-safe when data is thin. */
  ordersBaseline: number | null;
  ordersCurrent: number | null;
  conversionDelta: number | null;
  aovDelta: number | null;
}

interface ConcludedExperimentRow {
  id: number;
  name: string;
  marketLabel: string;
  status: string;
  outcome: string | null;
  day: number;
  baselineDays: number;
  concludedAt: string | null;
}

/**
 * Experiments index — one card per RUNNING experiment (they run concurrently,
 * one per market) with quick comparison numbers, then a table of concluded
 * experiments. This file is also the flat-routes layout for
 * /app/experiments/new and /app/experiments/:id — when a child route matches,
 * the component renders only the <Outlet /> and the loader skips its work.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const isIndex =
    url.pathname.replace(/\/+$/, "") === "/app/experiments" ||
    url.pathname.replace(/\/+$/, "") === "";
  if (!isIndex) {
    return {
      running: [] as RunningExperimentCard[],
      concluded: [] as ConcludedExperimentRow[],
    };
  }

  const now = new Date();
  const [experiments, markets] = await Promise.all([
    listExperiments(session.shop),
    listMarkets(admin).catch(() => []),
  ]);
  const marketNames = new Map(markets.map((m) => [m.handle, m.name]));
  const marketLabelOf = (handle: string) =>
    handle === "all" ? "All markets" : (marketNames.get(handle) ?? handle);

  // Severity + quick comparison numbers come from ONE cached payload per
  // experiment (6 h TTL inside warningJson — same machinery as the detail
  // page and dashboard), and the per-experiment work runs in parallel.
  // n/a-safe: before the first full experiment day (or on failure)
  // everything stays null.
  const running: RunningExperimentCard[] = await Promise.all(
    experiments
      .filter((experiment) => experiment.status === "running")
      .map(async (experiment) => {
        let quick: RunningQuickStats = {
          severity: "none",
          daysCompared: 0,
          ordersBaseline: null,
          ordersCurrent: null,
          conversionDelta: null,
          aovDelta: null,
        };
        try {
          quick = await getRunningQuickStats(experiment, now);
        } catch (error) {
          console.error(
            `Quick-stats computation failed for experiment ${experiment.id}:`,
            error,
          );
        }
        return {
          id: experiment.id,
          name: experiment.name,
          marketLabel: marketLabelOf(experiment.market),
          day: experimentDay(experiment, now),
          baselineDays: experiment.baselineDays,
          severity: quick.severity,
          daysCompared: quick.daysCompared,
          ordersBaseline: quick.ordersBaseline,
          ordersCurrent: quick.ordersCurrent,
          conversionDelta: quick.conversionDelta,
          aovDelta: quick.aovDelta,
        };
      }),
  );
  const concluded: ConcludedExperimentRow[] = experiments
    .filter((experiment) => experiment.status !== "running")
    .map((experiment) => ({
      id: experiment.id,
      name: experiment.name,
      marketLabel: marketLabelOf(experiment.market),
      status: experiment.status,
      outcome: experiment.outcome,
      day: experimentDay(experiment, now),
      baselineDays: experiment.baselineDays,
      concludedAt: experiment.concludedAt?.toISOString() ?? null,
    }));
  return { running, concluded };
};

function warningChip(severity: RunningExperimentCard["severity"]) {
  if (severity === "critical") {
    return <Badge tone="critical">Early warning</Badge>;
  }
  if (severity === "caution") {
    return <Badge tone="attention">Caution</Badge>;
  }
  return null;
}

function formatDelta(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const pct = value * 100;
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
}

function formatCount(value: number | null): string {
  return value === null || !Number.isFinite(value)
    ? "n/a"
    : String(Math.round(value));
}

function concludedProgress(row: ConcludedExperimentRow): string {
  return row.status === "completed"
    ? `Full ${row.baselineDays} days`
    : `Day ${row.day} of ${row.baselineDays}`;
}

function concludedStatus(row: ConcludedExperimentRow): string {
  return row.status === "completed" ? "Completed" : "Stopped early";
}

function concludedOutcome(row: ConcludedExperimentRow) {
  if (row.outcome === "kept") return <Badge tone="success">Changes kept</Badge>;
  if (row.outcome === "rolled_back") return <Badge>Rolled back</Badge>;
  return <Text as="span">—</Text>;
}

function RunningCard({ item }: { item: RunningExperimentCard }) {
  const stats: { label: string; value: string }[] = [
    {
      label: "Orders (baseline → now)",
      value:
        item.ordersBaseline === null && item.ordersCurrent === null
          ? "n/a"
          : `${formatCount(item.ordersBaseline)} → ${formatCount(item.ordersCurrent)}`,
    },
    { label: "Conversion vs baseline", value: formatDelta(item.conversionDelta) },
    { label: "AOV vs baseline", value: formatDelta(item.aovDelta) },
  ];
  const progressPercent = Math.min(
    100,
    Math.round((item.day / item.baselineDays) * 100),
  );

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
          <InlineStack gap="200" blockAlign="center" wrap>
            <Text as="h3" variant="headingMd">
              {item.name}
            </Text>
            <Badge tone="info">{item.marketLabel}</Badge>
            {warningChip(item.severity)}
          </InlineStack>
          <Button url={`/app/experiments/${item.id}`} variant="plain">
            View
          </Button>
        </InlineStack>
        <BlockStack gap="100">
          <ProgressBar progress={progressPercent} size="small" />
          <Text as="span" variant="bodySm" tone="subdued">
            Day {item.day} of {item.baselineDays}
          </Text>
        </BlockStack>
        {item.daysCompared === 0 ? (
          <Text as="p" variant="bodySm" tone="subdued">
            No full experiment day yet — the live comparison starts after the
            first 24 h.
          </Text>
        ) : (
          <InlineStack gap="400" wrap>
            {stats.map((stat) => (
              <Box key={stat.label} minWidth="150px">
                <BlockStack gap="050">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {stat.label}
                  </Text>
                  <Text as="span" variant="headingMd">
                    {stat.value}
                  </Text>
                </BlockStack>
              </Box>
            ))}
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}

export default function ExperimentsPage() {
  const { running, concluded } = useLoaderData<typeof loader>();
  const matches = useMatches();
  const childActive = matches.some((match) =>
    match.id.startsWith("routes/app.experiments."),
  );
  if (childActive) {
    return <Outlet />;
  }

  const criticals = running.filter((item) => item.severity === "critical");
  const hasAny = running.length > 0 || concluded.length > 0;

  const concludedRows = concluded.map((row) => [
    <PolarisLink key={row.id} url={`/app/experiments/${row.id}`} removeUnderline>
      {row.name}
    </PolarisLink>,
    row.marketLabel,
    concludedProgress(row),
    concludedStatus(row),
    concludedOutcome(row),
  ]);

  return (
    <Page
      title="Experiments"
      backAction={{ content: "Dashboard", url: "/app" }}
      primaryAction={{ content: "New experiment", url: "/app/experiments/new" }}
    >
      <TitleBar title="Experiments" />
      <Layout>
        {criticals.length > 0 ? (
          <Layout.Section>
            <Banner
              tone="critical"
              title="Early warning: significant negative movement detected"
            >
              <BlockStack gap="200">
                <Text as="p">
                  These running experiments show a statistically significant
                  drop. Open them to review the numbers and decide whether to
                  stop and roll back:
                </Text>
                <List>
                  {criticals.map((item) => (
                    <List.Item key={item.id}>
                      <PolarisLink url={`/app/experiments/${item.id}`}>
                        {item.name}
                      </PolarisLink>{" "}
                      ({item.marketLabel}, day {item.day} of {item.baselineDays}
                      )
                    </List.Item>
                  ))}
                </List>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Sequential experiments — not A/B tests
              </Text>
              <Text as="p">
                An experiment flips features for one market and compares the
                following days against the days immediately before. Every
                visitor in a market always sees the same version — experiments
                change a market for everyone, never a percentage split.
                Experiments run concurrently across markets, but each market
                hosts at most one at a time: within any market there is only
                ever one live configuration. Rolling back restores exactly the
                features an experiment flipped, so concurrent experiments never
                disturb each other.
              </Text>
              <Text as="p" tone="subdued">
                That makes them safe for Google Ads: landing pages stay
                identical for every visitor in a market, with no per-visitor
                variation or cloaking. The trade-off is that the two windows
                are different time periods, so seasonality, promotions and ad
                changes can influence results — the reports state significance
                honestly instead of declaring winners.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {!hasAny ? (
          <Layout.Section>
            <Card>
              <EmptyState
                heading="Run your first experiment"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                action={{
                  content: "New experiment",
                  url: "/app/experiments/new",
                }}
              >
                <p>
                  Pick a market, flip one or more features, and the tracker
                  compares the experiment window against the preceding baseline
                  — with early warnings if key metrics drop significantly.
                </p>
              </EmptyState>
            </Card>
          </Layout.Section>
        ) : null}

        {running.length > 0 ? (
          <Layout.Section>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Running ({running.length})
              </Text>
              {running.map((item) => (
                <RunningCard key={item.id} item={item} />
              ))}
            </BlockStack>
          </Layout.Section>
        ) : null}

        {concluded.length > 0 ? (
          <Layout.Section>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Concluded
              </Text>
              <Card padding="0">
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text"]}
                  headings={[
                    "Experiment",
                    "Market",
                    "Progress",
                    "Status",
                    "Outcome",
                  ]}
                  rows={concludedRows}
                />
              </Card>
            </BlockStack>
          </Layout.Section>
        ) : null}
      </Layout>
    </Page>
  );
}
