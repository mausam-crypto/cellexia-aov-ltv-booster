import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
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
  Link as PolarisLink,
  List,
  Page,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSettings, type FeatureKey } from "../models/settings.server";
import { listMarkets } from "../services/markets.server";
import {
  featureFlipOptions,
  listRunningExperiments,
  lockedFeatureMap,
  parseFlips,
  periodMetrics,
  startExperiment,
} from "../services/experiments.server";

const BASELINE_CHOICES = [7, 14, 21, 28] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * New-experiment wizard: one route, client-side steps. Market and baseline
 * length mirror into the URL so the loader recomputes the live baseline
 * preview and per-market effective feature states on every change.
 *
 * Concurrency (SPEC v3 §B): one experiment per market, concurrent across
 * markets. Markets with a running experiment (and "All markets" whenever
 * anything runs) are disabled in the Select; features flipped by running
 * experiments are locked in the flip table.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  const [settings, markets, runningRows] = await Promise.all([
    getSettings(session.shop),
    listMarkets(admin),
    listRunningExperiments(session.shop),
  ]);

  const marketLabelOf = (handle: string) =>
    handle === "all"
      ? "All markets"
      : (markets.find((m) => m.handle === handle)?.name ?? handle);

  const running = runningRows.map((experiment) => ({
    id: experiment.id,
    name: experiment.name,
    market: experiment.market,
    marketLabel: marketLabelOf(experiment.market),
  }));
  const anyRunning = running.length > 0;
  const allMarketsBusy = running.some((r) => r.market === "all");
  const busyHandles = new Set(running.map((r) => r.market));
  const marketBusy = (handle: string) =>
    handle === "all"
      ? anyRunning
      : allMarketsBusy || busyHandles.has(handle);
  // Nothing startable: an all-markets experiment runs, or every market is
  // taken (the "all" option is unavailable whenever anything runs).
  const blocked =
    allMarketsBusy ||
    (anyRunning &&
      (markets.length === 0 || markets.every((m) => busyHandles.has(m.handle))));

  const handles = new Set(markets.map((m) => m.handle));
  const marketParam = url.searchParams.get("market") ?? "all";
  let market =
    marketParam === "all" || handles.has(marketParam) ? marketParam : "all";
  if (marketBusy(market) && !blocked) {
    // The requested market already hosts an experiment — fall to the first
    // startable option so the wizard never operates on a disabled market.
    market =
      markets.find((m) => !marketBusy(m.handle))?.handle ??
      (anyRunning ? market : "all");
  }

  const daysParam = Number(url.searchParams.get("days"));
  const days = (BASELINE_CHOICES as readonly number[]).includes(daysParam)
    ? daysParam
    : 14;

  const now = new Date();
  const preview = await periodMetrics(
    session.shop,
    market,
    new Date(now.getTime() - days * DAY_MS),
    now,
  );

  // Feature keys locked by running experiments (cart_* keys lock as a group —
  // shared master switch), annotated for the flip table captions.
  const locks = lockedFeatureMap(runningRows);

  return {
    markets: markets.map((m) => ({
      handle: m.handle,
      name: m.name,
      primary: m.primary,
    })),
    running,
    blocked,
    market,
    days,
    preview: {
      sessions: preview.sessions,
      orders: preview.orders,
      revenue: preview.revenue,
      aov: preview.aov,
      conversionRate: preview.conversionRate,
      subscriptionRate: preview.subscriptionRate,
      protectionAttachRate: preview.protectionAttachRate,
      unitsPerOrder: preview.unitsPerOrder,
      currency: preview.currency,
    },
    features: featureFlipOptions(settings, market).map((feature) => {
      const lock = locks[feature.key];
      return {
        ...feature,
        lockedBy: lock
          ? {
              name: lock.experimentName,
              marketLabel: marketLabelOf(lock.market),
            }
          : null,
      };
    }),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  // Flip objects (key/from/to) exactly as shown on the review screen —
  // startExperiment validates each `from` against the current effective
  // state and rejects when settings changed since the merchant reviewed.
  const flips = parseFlips(String(formData.get("flips") ?? "[]"));

  const result = await startExperiment({
    shop: session.shop,
    admin,
    name: String(formData.get("name") ?? ""),
    market: String(formData.get("market") ?? ""),
    flips,
    baselineDays: Number(formData.get("baselineDays") ?? 0),
  });
  if (!result.ok) {
    return { error: result.error, syncErrors: [] as string[] };
  }
  return redirect(`/app/experiments/${result.id}`);
};

const STEP_TITLES = [
  "Name & market",
  "Baseline window",
  "Feature flips",
  "Review & start",
];

function formatMoney(value: number | null, currency: string | null): string {
  if (value === null) return "n/a";
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

function formatRate(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export default function NewExperimentPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigation = useNavigation();
  const submit = useSubmit();

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [selectedFlips, setSelectedFlips] = useState<FeatureKey[]>([]);
  const [stepError, setStepError] = useState<string | null>(null);

  const isPreviewLoading = navigation.state === "loading";
  const isStarting =
    navigation.state !== "idle" && navigation.formMethod === "POST";

  const running = data.running;
  const blocked = data.blocked;
  const anyRunning = running.length > 0;
  const allMarketsBusy = running.some((r) => r.market === "all");
  const busyHandles = new Set(running.map((r) => r.market));

  // One experiment per market: markets already hosting an experiment are
  // disabled, and "All markets" is unavailable whenever anything runs.
  const marketOptions = [
    { label: "All markets", value: "all", disabled: anyRunning },
    ...data.markets.map((m) => ({
      label: m.name,
      value: m.handle,
      disabled: allMarketsBusy || busyHandles.has(m.handle),
    })),
  ];

  const busyMarketNotes = running
    .map((r) => `${r.marketLabel} — running “${r.name}”`)
    .join("; ");
  const marketHelpText = anyRunning
    ? `Within any market there is only ever one live configuration, so markets with a running experiment are disabled: ${busyMarketNotes}. “All markets” is unavailable while any experiment is running.`
    : "One experiment per market: within any market there is only ever one live configuration — concurrency is across markets only.";

  const marketLabel =
    data.market === "all"
      ? "All markets"
      : (data.markets.find((m) => m.handle === data.market)?.name ??
        data.market);

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const trimmedName = name.trim();
  const nameError =
    trimmedName.length === 0
      ? "Enter a name."
      : trimmedName.length > 80
        ? "Keep it under 80 characters."
        : null;

  const lockedKeys = new Set(
    data.features.filter((f) => f.lockedBy !== null).map((f) => f.key),
  );
  // Flips the merchant selected that are still available (a feature can
  // become locked between renders when another experiment starts).
  const availableSelectedFlips = selectedFlips.filter(
    (key) => !lockedKeys.has(key),
  );

  const toggleFlip = (key: FeatureKey, checked: boolean) => {
    if (lockedKeys.has(key)) return;
    setStepError(null);
    setSelectedFlips((previous) =>
      checked ? [...new Set([...previous, key])] : previous.filter((k) => k !== key),
    );
  };

  const goNext = () => {
    setStepError(null);
    if (step === 0) {
      if (blocked) {
        setStepError(
          "Every market already has a running experiment — conclude one first. Each market hosts one experiment at a time.",
        );
        return;
      }
      if (nameError) {
        setStepError(nameError);
        return;
      }
    }
    if (step === 2 && availableSelectedFlips.length === 0) {
      setStepError("Pick at least one feature to flip.");
      return;
    }
    setStep((s) => Math.min(s + 1, STEP_TITLES.length - 1));
  };

  const goBack = () => {
    setStepError(null);
    setStep((s) => Math.max(s - 1, 0));
  };

  const handleStart = () => {
    // Submit the flips exactly as reviewed (key/from/to) so the server can
    // reject if settings changed between render and Start. Locked features
    // are filtered defensively — the server re-checks the overlap guard.
    const reviewedFlips = data.features
      .filter(
        (feature) =>
          availableSelectedFlips.includes(feature.key) &&
          feature.lockedBy === null,
      )
      .map((feature) => ({
        key: feature.key,
        from: feature.effective,
        to: !feature.effective,
      }));
    const formData = new FormData();
    formData.set("name", trimmedName);
    formData.set("market", data.market);
    formData.set("baselineDays", String(data.days));
    formData.set("flips", JSON.stringify(reviewedFlips));
    submit(formData, { method: "post" });
  };

  const flipSummaries = data.features
    .filter((feature) => availableSelectedFlips.includes(feature.key))
    .map((feature) => ({
      key: feature.key,
      label: feature.label,
      direction: feature.effective ? "On → Off" : "Off → On",
    }));

  const now = Date.now();
  const formatDate = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  const previewStats: { label: string; value: string }[] = [
    { label: "Sessions", value: String(data.preview.sessions) },
    { label: "Orders", value: String(data.preview.orders) },
    {
      label: "Revenue",
      value: formatMoney(data.preview.revenue, data.preview.currency),
    },
    {
      label: "Average order value",
      value: formatMoney(data.preview.aov, data.preview.currency),
    },
    {
      label: "Conversion rate",
      value: formatRate(data.preview.conversionRate),
    },
    {
      label: "Subscription rate",
      value: formatRate(data.preview.subscriptionRate),
    },
    {
      label: "Protection attach rate",
      value: formatRate(data.preview.protectionAttachRate),
    },
    {
      label: "Units per order",
      value:
        data.preview.unitsPerOrder === null
          ? "n/a"
          : data.preview.unitsPerOrder.toFixed(2),
    },
  ];

  return (
    <Page
      title="New experiment"
      backAction={{ content: "Experiments", url: "/app/experiments" }}
    >
      <TitleBar title="New experiment" />
      <Layout>
        {actionData?.error ? (
          <Layout.Section>
            <Banner tone="critical" title="Could not start the experiment">
              <Text as="p">{actionData.error}</Text>
            </Banner>
          </Layout.Section>
        ) : null}

        {blocked ? (
          <Layout.Section>
            <Banner tone="warning" title="No market is available right now">
              <BlockStack gap="200">
                <Text as="p">
                  Each market hosts one experiment at a time
                  {allMarketsBusy
                    ? ", and an all-markets experiment blocks every market"
                    : ", and every market already has one running"}
                  . Conclude one of these first:
                </Text>
                <List>
                  {running.map((r) => (
                    <List.Item key={r.id}>
                      <PolarisLink url={`/app/experiments/${r.id}`}>
                        {r.name}
                      </PolarisLink>{" "}
                      ({r.marketLabel})
                    </List.Item>
                  ))}
                </List>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : anyRunning ? (
          <Layout.Section>
            <Banner tone="info" title="Experiments running in other markets">
              <BlockStack gap="200">
                <Text as="p">
                  Experiments run concurrently, one per market. Their markets
                  and flipped features are locked below; free markets and
                  features stay available.
                </Text>
                <List>
                  {running.map((r) => (
                    <List.Item key={r.id}>
                      <PolarisLink url={`/app/experiments/${r.id}`}>
                        {r.name}
                      </PolarisLink>{" "}
                      ({r.marketLabel})
                    </List.Item>
                  ))}
                </List>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="200" blockAlign="center" wrap>
                {STEP_TITLES.map((title, index) => (
                  <InlineStack key={title} gap="200" blockAlign="center">
                    <Badge
                      tone={
                        index === step
                          ? "info"
                          : index < step
                            ? "success"
                            : undefined
                      }
                    >
                      {`${index + 1}. ${title}`}
                    </Badge>
                    {index < STEP_TITLES.length - 1 ? (
                      <Text as="span" tone="subdued">
                        →
                      </Text>
                    ) : null}
                  </InlineStack>
                ))}
              </InlineStack>
              <Divider />

              {step === 0 ? (
                <BlockStack gap="400">
                  <Text as="p" tone="subdued">
                    Experiments are sequential: the change goes live for
                    everyone in the chosen market at once and is compared
                    against the days before. This is never an A/B split —
                    within any market there is only ever one live
                    configuration. Experiments can run concurrently, but only
                    across different markets.
                  </Text>
                  <TextField
                    label="Experiment name"
                    value={name}
                    onChange={(value) => {
                      setStepError(null);
                      setName(value);
                    }}
                    placeholder="e.g. Trust badges in Ireland"
                    maxLength={80}
                    showCharacterCount
                    autoComplete="off"
                  />
                  <Select
                    label="Market"
                    options={marketOptions}
                    value={data.market}
                    disabled={blocked}
                    onChange={(value) => {
                      setStepError(null);
                      updateParam("market", value);
                    }}
                    helpText={marketHelpText}
                  />
                </BlockStack>
              ) : null}

              {step === 1 ? (
                <BlockStack gap="400">
                  <ChoiceList
                    title="Baseline length"
                    choices={BASELINE_CHOICES.map((value) => ({
                      label: `${value} days`,
                      value: String(value),
                    }))}
                    selected={[String(data.days)]}
                    onChange={(selected) =>
                      updateParam("days", selected[0] ?? "14")
                    }
                  />
                  <Text as="p" tone="subdued">
                    The experiment runs the same number of days as the
                    baseline, so both comparison windows are equal length.
                  </Text>
                  {data.preview.orders < 30 ? (
                    <Banner tone="warning" title="Thin baseline data">
                      <Text as="p">
                        Only {data.preview.orders} orders in the last{" "}
                        {data.days} days for {marketLabel}. Statistical tests
                        need volume — with fewer than 30 baseline orders the
                        early-warning checks stay off and results will read
                        “n/a — not enough data”. Consider a longer baseline.
                      </Text>
                    </Banner>
                  ) : null}
                  {data.preview.sessions === 0 ? (
                    <Banner tone="warning" title="No session data yet">
                      <Text as="p">
                        No storefront sessions recorded for this window —
                        conversion rate will be n/a until the storefront
                        session beacon has data. Order-based metrics (AOV,
                        revenue, subscription rate) still work.
                      </Text>
                    </Banner>
                  ) : null}
                  <Card background="bg-surface-secondary">
                    <BlockStack gap="300">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="h3" variant="headingSm">
                          Baseline preview — {marketLabel}, last {data.days}{" "}
                          days
                        </Text>
                        {isPreviewLoading ? (
                          <Spinner
                            size="small"
                            accessibilityLabel="Loading baseline preview"
                          />
                        ) : null}
                      </InlineStack>
                      <InlineStack gap="400" wrap>
                        {previewStats.map((stat) => (
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
                    </BlockStack>
                  </Card>
                </BlockStack>
              ) : null}

              {step === 2 ? (
                <BlockStack gap="300">
                  <Text as="p" tone="subdued">
                    Current state is the effective visibility in {marketLabel}
                    (master toggle + market targeting). Check “Flip” to turn a
                    feature the other way for the experiment — at least one
                    flip is required. Features flipped by a running experiment
                    are locked (cart features lock as one group — they share a
                    master switch).
                  </Text>
                  <BlockStack gap="0">
                    {data.features.map((feature, index) => (
                      <Box
                        key={feature.key}
                        paddingBlockStart="200"
                        paddingBlockEnd="200"
                        borderBlockEndWidth={
                          index < data.features.length - 1 ? "025" : "0"
                        }
                        borderColor="border"
                      >
                        <InlineStack
                          align="space-between"
                          blockAlign="center"
                          gap="300"
                          wrap={false}
                        >
                          <InlineStack gap="200" blockAlign="center">
                            <Text
                              as="span"
                              variant="bodyMd"
                              tone={feature.lockedBy ? "subdued" : undefined}
                            >
                              {feature.label}
                            </Text>
                            <Badge
                              tone={feature.effective ? "success" : undefined}
                            >
                              {feature.effective ? "On" : "Off"}
                            </Badge>
                          </InlineStack>
                          {feature.lockedBy ? (
                            <BlockStack gap="050" inlineAlign="end">
                              <Checkbox
                                label="Flip"
                                checked={false}
                                disabled
                                onChange={() => {}}
                              />
                              <Text
                                as="span"
                                variant="bodySm"
                                tone="subdued"
                              >
                                In use by: {feature.lockedBy.name} (
                                {feature.lockedBy.marketLabel})
                              </Text>
                            </BlockStack>
                          ) : (
                            <Checkbox
                              label={
                                feature.effective
                                  ? "Flip — will turn OFF"
                                  : "Flip — will turn ON"
                              }
                              checked={availableSelectedFlips.includes(
                                feature.key,
                              )}
                              onChange={(checked) =>
                                toggleFlip(feature.key, checked)
                              }
                            />
                          )}
                        </InlineStack>
                      </Box>
                    ))}
                  </BlockStack>
                </BlockStack>
              ) : null}

              {step === 3 ? (
                <BlockStack gap="400">
                  <Banner tone="info" title="Sequential rollout — never an A/B split">
                    <Text as="p">
                      Everyone in {marketLabel} sees the new version
                      immediately. Results compare the next {data.days} days
                      against the previous {data.days} days, so time-based
                      factors (seasonality, promotions, ad changes) can
                      influence the comparison.
                    </Text>
                  </Banner>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      {trimmedName || "Untitled experiment"}
                    </Text>
                    <Text as="p">
                      Market: <strong>{marketLabel}</strong>
                    </Text>
                    <Text as="p">
                      Baseline window:{" "}
                      {formatDate(now - data.days * DAY_MS)} – {formatDate(now)}{" "}
                      · Experiment window: {formatDate(now)} –{" "}
                      {formatDate(now + data.days * DAY_MS)} ({data.days} days)
                    </Text>
                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Changes going live in {marketLabel}
                    </Text>
                    <BlockStack gap="100">
                      {flipSummaries.map((flip) => (
                        <InlineStack key={flip.key} gap="200">
                          <Text as="span">{flip.label}:</Text>
                          <Text as="span" fontWeight="semibold">
                            {flip.direction}
                          </Text>
                        </InlineStack>
                      ))}
                    </BlockStack>
                    <Text as="p" tone="subdued" variant="bodySm">
                      Starting snapshots the current feature settings —
                      concluding with roll back restores exactly the features
                      this experiment flips (flags and market targeting) to
                      this state. Experiments in other markets are never
                      touched by that rollback.
                    </Text>
                  </BlockStack>
                </BlockStack>
              ) : null}

              {stepError ? (
                <Text as="p" tone="critical">
                  {stepError}
                </Text>
              ) : null}

              <Divider />
              <InlineStack align="space-between">
                <Button onClick={goBack} disabled={step === 0 || isStarting}>
                  Back
                </Button>
                {step < STEP_TITLES.length - 1 ? (
                  <Button variant="primary" onClick={goNext}>
                    Next
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={handleStart}
                    loading={isStarting}
                    disabled={blocked || availableSelectedFlips.length === 0}
                  >
                    Start experiment
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
