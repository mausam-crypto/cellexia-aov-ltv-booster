import { useEffect, useState } from "react";
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
  DataTable,
  Divider,
  InlineStack,
  Layout,
  List,
  Page,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getSettings, FEATURE_DEFS } from "../models/settings.server";
import { listMarkets } from "../services/markets.server";
import {
  buildReport,
  concludeExperiment,
  experimentDay,
  getEarlyWarning,
  getExperiment,
  isSettingsDrifted,
  parseFlips,
  parseReport,
  parseStartSyncErrors,
  retryStartSync,
  type EarlyWarning,
  type ExperimentReport,
  type ReportRow,
  type WarningSignal,
} from "../services/experiments.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) {
    throw new Response("Not found", { status: 404 });
  }
  const experiment = await getExperiment(session.shop, id);
  if (!experiment) {
    throw new Response("Not found", { status: 404 });
  }

  const now = new Date();
  const running = experiment.status === "running";

  const [settings, markets] = await Promise.all([
    getSettings(session.shop),
    listMarkets(admin).catch(() => []),
  ]);

  let warning: EarlyWarning | null = null;
  let report: ExperimentReport;
  if (running) {
    try {
      warning = await getEarlyWarning(experiment, now);
    } catch (error) {
      console.error(
        `Early-warning evaluation failed for experiment ${experiment.id}:`,
        error,
      );
    }
    report = await buildReport(experiment, now);
  } else {
    // Concluded: use the report cached at conclusion (rebuild only if the
    // cache is somehow missing/corrupt).
    report =
      parseReport(experiment.reportJson) ??
      (await buildReport(experiment, experiment.concludedAt ?? now));
  }

  const flips = parseFlips(experiment.flips).map((flip) => ({
    ...flip,
    label: FEATURE_DEFS[flip.key].label,
  }));

  return {
    experiment: {
      id: experiment.id,
      name: experiment.name,
      market: experiment.market,
      marketLabel:
        experiment.market === "all"
          ? "All markets"
          : (markets.find((m) => m.handle === experiment.market)?.name ??
            experiment.market),
      status: experiment.status,
      outcome: experiment.outcome,
      baselineDays: experiment.baselineDays,
      startedAt: experiment.startedAt.toISOString(),
      endsAt: experiment.endsAt.toISOString(),
      concludedAt: experiment.concludedAt?.toISOString() ?? null,
      pastEnd: now.getTime() >= experiment.endsAt.getTime(),
    },
    day: experimentDay(experiment, now),
    warning,
    report,
    drifted: running ? isSettingsDrifted(experiment, settings) : false,
    flips,
    startSyncErrors: parseStartSyncErrors(experiment.startSyncErrors),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) {
    return {
      ok: false as const,
      intent: "conclude" as const,
      error: "Experiment not found.",
      syncErrors: [] as string[],
    };
  }
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "retry-sync") {
    const result = await retryStartSync({ shop: session.shop, id, admin });
    if (!result.ok) {
      return {
        ok: false as const,
        intent: "retry-sync" as const,
        error: result.error,
        syncErrors: [] as string[],
      };
    }
    return {
      ok: true as const,
      intent: "retry-sync" as const,
      error: null,
      syncErrors: result.syncErrors,
    };
  }

  if (intent !== "conclude") {
    return {
      ok: false as const,
      intent: "conclude" as const,
      error: "Unknown action.",
      syncErrors: [] as string[],
    };
  }
  const mode = formData.get("mode") === "rollback" ? "rollback" : "keep";
  const result = await concludeExperiment({
    shop: session.shop,
    id,
    mode,
    admin,
  });
  if (!result.ok) {
    return {
      ok: false as const,
      intent: "conclude" as const,
      error: result.error,
      syncErrors: [] as string[],
    };
  }
  return {
    ok: true as const,
    intent: "conclude" as const,
    error: null,
    syncErrors: result.syncErrors,
  };
};

function formatValue(
  value: number | null,
  format: ReportRow["format"],
  currency: string | null,
): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  switch (format) {
    case "count":
      return String(Math.round(value));
    case "money":
      if (!currency) return value.toFixed(2);
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency,
        }).format(value);
      } catch {
        return `${value.toFixed(2)} ${currency}`;
      }
    case "rate":
      return `${(value * 100).toFixed(1)}%`;
    case "decimal":
      return value.toFixed(2);
  }
}

function formatChange(relativeChange: number | null): string {
  if (relativeChange === null || !Number.isFinite(relativeChange)) return "n/a";
  const pct = relativeChange * 100;
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function signalLine(signal: WarningSignal): string {
  return `${signal.label}: ${formatChange(signal.relativeChange)} — ${signal.significance} (${signal.sampleNote})`;
}

export default function ExperimentDetailPage() {
  const { experiment, day, warning, report, drifted, flips, startSyncErrors } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const [pendingMode, setPendingMode] = useState<"keep" | "rollback" | null>(
    null,
  );

  const isSubmitting =
    navigation.state !== "idle" && navigation.formMethod === "POST";
  const running = experiment.status === "running";

  useEffect(() => {
    if (!actionData?.ok) return;
    if (actionData.intent === "retry-sync") {
      shopify.toast.show(
        actionData.syncErrors.length > 0
          ? "Sync failed again — see the banner"
          : "Storefront configuration synced",
        { isError: actionData.syncErrors.length > 0 },
      );
      return;
    }
    setPendingMode(null);
    shopify.toast.show("Experiment concluded");
  }, [actionData, shopify]);

  const confirmConclude = (mode: "keep" | "rollback") => {
    const formData = new FormData();
    formData.set("intent", "conclude");
    formData.set("mode", mode);
    submit(formData, { method: "post" });
  };

  const retrySync = () => {
    const formData = new FormData();
    formData.set("intent", "retry-sync");
    submit(formData, { method: "post" });
  };

  const tableRows = report.rows.map((row) => [
    row.label,
    formatValue(row.baseline, row.format, report.currency),
    formatValue(row.current, row.format, report.currency),
    formatChange(row.relativeChange),
    row.tested ? row.significance : "—",
    row.sampleNote,
  ]);

  const progressPercent = Math.min(
    100,
    Math.round((day / experiment.baselineDays) * 100),
  );

  const concludeVerb = experiment.pastEnd ? "Conclude" : "Stop early";

  const statusBadge = running ? (
    <Badge tone="info">Running</Badge>
  ) : experiment.status === "completed" ? (
    <Badge tone="success">Completed</Badge>
  ) : (
    <Badge tone="attention">Stopped early</Badge>
  );
  const outcomeBadge =
    experiment.outcome === "kept" ? (
      <Badge tone="success">Changes kept</Badge>
    ) : experiment.outcome === "rolled_back" ? (
      <Badge>Rolled back</Badge>
    ) : null;

  return (
    <Page
      title={experiment.name}
      subtitle={`${experiment.marketLabel} · ${
        running
          ? `Day ${day} of ${experiment.baselineDays}`
          : experiment.status === "completed"
            ? `Ran the full ${experiment.baselineDays} days`
            : `Stopped on day ${day} of ${experiment.baselineDays}`
      }`}
      backAction={{ content: "Experiments", url: "/app/experiments" }}
    >
      <TitleBar title={experiment.name} />
      <Layout>
        {actionData && !actionData.ok && actionData.error ? (
          <Layout.Section>
            <Banner tone="critical" title="Could not conclude the experiment">
              <Text as="p">{actionData.error}</Text>
            </Banner>
          </Layout.Section>
        ) : null}
        {actionData?.ok &&
        actionData.intent === "conclude" &&
        actionData.syncErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone="warning"
              title="Concluded, but the storefront sync reported errors"
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

        {startSyncErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone="critical"
              title="The storefront configuration may not have updated when this experiment started"
              action={{
                content: "Retry sync",
                onAction: retrySync,
                loading: isSubmitting,
              }}
            >
              <BlockStack gap="100">
                <Text as="p">
                  The metafield sync failed when the experiment started, so the
                  storefront may still be serving the old configuration — the
                  experiment window could be measuring unchanged behavior.
                </Text>
                {startSyncErrors.map((error) => (
                  <Text as="p" key={error} tone="subdued">
                    {error}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {running && warning && warning.severity === "critical" ? (
          <Layout.Section>
            <Banner
              tone="critical"
              title="Early warning: significant negative movement"
              action={{
                content: "Stop experiment now",
                onAction: () => setPendingMode("rollback"),
              }}
            >
              <BlockStack gap="200">
                <List>
                  {warning.warnings.map((signal) => (
                    <List.Item key={signal.metric}>
                      {signalLine(signal)}
                    </List.Item>
                  ))}
                </List>
                <Text as="p" variant="bodySm">
                  Recommendation: stop now and roll back. (Stopping always asks
                  whether to keep or roll back the changes.)
                </Text>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}
        {running && warning && warning.severity === "caution" ? (
          <Layout.Section>
            <Banner tone="warning" title="Caution: negative movement detected">
              <List>
                {warning.warnings.map((signal) => (
                  <List.Item key={signal.metric}>{signalLine(signal)}</List.Item>
                ))}
              </List>
            </Banner>
          </Layout.Section>
        ) : null}
        {running && warning && warning.goodNews.length > 0 ? (
          <Layout.Section>
            <Banner tone="success" title="Significant positive movement">
              <List>
                {warning.goodNews.map((signal) => (
                  <List.Item key={signal.metric}>{signalLine(signal)}</List.Item>
                ))}
              </List>
            </Banner>
          </Layout.Section>
        ) : null}
        {running && drifted ? (
          <Layout.Section>
            <Banner
              tone="warning"
              title="Settings changed outside this experiment"
            >
              <Text as="p">
                The flags or market targeting of the features THIS experiment
                flipped no longer match the snapshot taken right after it
                started, so the experiment window mixes configurations and
                results may be misleading. (Experiments in other markets never
                trigger this — only changes to this experiment&apos;s own
                features do.) Consider stopping the experiment — rolling back
                restores those features&apos; pre-experiment state, which
                would also undo the outside changes.
              </Text>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  {statusBadge}
                  {outcomeBadge}
                </InlineStack>
                <Text as="span" variant="bodySm" tone="subdued">
                  {formatDate(experiment.startedAt)} –{" "}
                  {formatDate(
                    experiment.concludedAt && !running
                      ? experiment.concludedAt
                      : experiment.endsAt,
                  )}
                </Text>
              </InlineStack>
              {running ? (
                <BlockStack gap="100">
                  <ProgressBar progress={progressPercent} size="small" />
                  <Text as="span" variant="bodySm" tone="subdued">
                    Day {day} of {experiment.baselineDays} — scheduled to end on{" "}
                    {formatDate(experiment.endsAt)}
                  </Text>
                </BlockStack>
              ) : null}
              {running && warning && !warning.eligible && warning.reason ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  {warning.reason}
                </Text>
              ) : null}
              <Divider />
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">
                  Feature flips ({experiment.marketLabel})
                </Text>
                {flips.map((flip) => (
                  <InlineStack key={flip.key} gap="200">
                    <Text as="span">{flip.label}:</Text>
                    <Text as="span" fontWeight="semibold">
                      {flip.from ? "On → Off" : "Off → On"}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {report.daysCompared === 0
                  ? running
                    ? "Baseline vs experiment so far"
                    : "Final report"
                  : running
                    ? `Baseline vs experiment so far (${report.daysCompared}-day windows)`
                    : `Final report (${report.daysCompared}-day windows)`}
              </Text>
              {report.daysCompared === 0 ? (
                <Banner tone="info">
                  <Text as="p">
                    No full experiment day yet - live comparison starts after
                    the first 24 h. Comparing a partial experiment day against
                    a full baseline day would be misleading.
                  </Text>
                </Banner>
              ) : (
                <>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Baseline: {formatDate(report.baselineWindow.from)} –{" "}
                    {formatDate(report.baselineWindow.to)} · Experiment:{" "}
                    {formatDate(report.experimentWindow.from)} –{" "}
                    {formatDate(report.experimentWindow.to)}
                    {running
                      ? " — partial data, updates as days complete."
                      : report.partial
                        ? " — stopped early; windows truncated to equal length."
                        : ""}
                  </Text>
                  <DataTable
                    columnContentTypes={[
                      "text",
                      "numeric",
                      "numeric",
                      "numeric",
                      "text",
                      "text",
                    ]}
                    headings={[
                      "Metric",
                      "Baseline",
                      "Experiment",
                      "Change",
                      "Significance",
                      "Sample",
                    ]}
                    rows={tableRows}
                  />
                  <Text as="p" variant="bodySm" tone="subdued">
                    Sequential comparison: the two windows are different time
                    periods, so seasonality, promotions and ad-spend changes
                    can influence results as much as the feature changes. Every
                    visitor in the market saw the same version throughout —
                    there was no per-visitor split. Other markets may run their
                    own experiments; metrics here are for this market only.
                  </Text>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {running ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  {concludeVerb}
                </Text>
                <Text as="p">
                  {experiment.pastEnd
                    ? "The experiment window is complete. Concluding locks in the final report and asks what to do with the changes:"
                    : "Stopping before the planned end truncates both windows to equal length for the final report and asks what to do with the changes:"}
                </Text>
                <InlineStack gap="300" wrap>
                  <Box minWidth="260px">
                    <Card background="bg-surface-secondary">
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          Keep the changes
                        </Text>
                        <Text as="p" variant="bodySm">
                          The flipped features stay exactly as they are now —
                          the experiment configuration becomes the new normal
                          for {experiment.marketLabel}.
                        </Text>
                        <Box>
                          <Button
                            onClick={() => setPendingMode("keep")}
                            disabled={isSubmitting}
                          >
                            {`${concludeVerb} — keep changes`}
                          </Button>
                        </Box>
                      </BlockStack>
                    </Card>
                  </Box>
                  <Box minWidth="260px">
                    <Card background="bg-surface-secondary">
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          Roll back
                        </Text>
                        <Text as="p" variant="bodySm">
                          The features this experiment flipped — their flags
                          and market targeting — return to the exact snapshot
                          taken when the experiment started, and the storefront
                          config is re-synced. Experiments running in other
                          markets are not touched.
                        </Text>
                        <Box>
                          <Button
                            onClick={() => setPendingMode("rollback")}
                            disabled={isSubmitting}
                          >
                            {`${concludeVerb} — roll back`}
                          </Button>
                        </Box>
                      </BlockStack>
                    </Card>
                  </Box>
                </InlineStack>
                {pendingMode ? (
                  <Banner
                    tone="warning"
                    title={
                      pendingMode === "keep"
                        ? "Conclude and keep the changes?"
                        : "Conclude and roll back?"
                    }
                    onDismiss={() => setPendingMode(null)}
                  >
                    <BlockStack gap="200">
                      <Text as="p">
                        {pendingMode === "keep"
                          ? `This ends the experiment now and leaves the flipped features live in ${experiment.marketLabel}. The final report is locked in. This cannot be undone.`
                          : `This ends the experiment now and restores the features it flipped (flags and market targeting) to the snapshot taken at start. Other features — including experiments running in other markets — are untouched. The final report is locked in. This cannot be undone.`}
                      </Text>
                      <InlineStack gap="200">
                        <Button
                          variant="primary"
                          tone={
                            pendingMode === "rollback" ? "critical" : undefined
                          }
                          loading={isSubmitting}
                          onClick={() => confirmConclude(pendingMode)}
                        >
                          {pendingMode === "keep"
                            ? "Confirm — keep changes"
                            : "Confirm — roll back"}
                        </Button>
                        <Button
                          onClick={() => setPendingMode(null)}
                          disabled={isSubmitting}
                        >
                          Cancel
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Outcome
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  {outcomeBadge}
                  <Text as="span" variant="bodySm" tone="subdued">
                    Concluded on{" "}
                    {experiment.concludedAt
                      ? formatDate(experiment.concludedAt)
                      : "—"}
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {experiment.outcome === "kept"
                    ? "The experiment configuration was kept and is live for this market."
                    : "The features this experiment flipped were restored to their pre-experiment state."}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
