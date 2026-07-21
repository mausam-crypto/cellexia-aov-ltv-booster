import { createHash } from "node:crypto";
import type { Experiment, Prisma } from "@prisma/client";
import prisma from "../db.server";
import {
  CART_SUB_FLAG_FIELDS,
  DEFAULT_SETTINGS,
  FEATURE_DEFS,
  FEATURE_KEYS,
  FEATURE_RAW_FIELD,
  STANDALONE_SECTION_FIELDS,
  applyFlipForMarket,
  getSettings,
  isFeatureOnForMarket,
  mergeSettings,
  restoreFlagsSelective,
  sanitizeSettings,
  saveSettings,
  snapshotFlags,
  type BoosterSettings,
  type FeatureKey,
  type FlagsSnapshot,
} from "../models/settings.server";
import { listMarkets } from "./markets.server";
import { syncSettingsToMetafields } from "./metafields.server";
import { twoProportionZTest, welchTTest } from "./stats.server";

/**
 * Sequential experiment tracker (SPEC v2 §3, concurrency per SPEC v3 §B).
 *
 * This is explicitly NOT an A/B tool: an experiment flips features for one
 * market (or all markets) for EVERY visitor at once, then compares an
 * equal-length window of days against the immediately-preceding baseline
 * window.
 *
 * Concurrency model (SPEC v3 §B): ONE experiment per market, concurrent
 * across markets. Two guards make that safe:
 *
 *   1. Market isolation — no second experiment in the same market, and an
 *      "all"-markets experiment conflicts with every running experiment
 *      (and vice versa). Within any market there is only ever one live
 *      configuration.
 *   2. No flip-key overlap — a feature flipped by a running experiment is
 *      locked for new experiments in ANY market, and all cart_* keys count
 *      as one overlap group because they share the cartUpsell master switch.
 *
 * Because flip keys never overlap between running experiments, rollback can
 * use restoreFlagsSelective (only the experiment's own raw flags + scopes)
 * without ever clobbering another running experiment's state, and drift
 * detection hashes only the experiment's own keys so another market's
 * experiment never triggers a false drift warning.
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WARNING_TTL_MS = 6 * 60 * 60 * 1000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

// ---------------------------------------------------------------------------
// Period metrics
// ---------------------------------------------------------------------------

export interface PeriodMetrics {
  from: string;
  to: string;
  /** Whole days spanned by [from, to). */
  days: number;
  /** Site session beacons (feature "site" / type "session"). */
  sessions: number;
  orders: number;
  revenue: number;
  /** Null when the window has no orders. */
  aov: number | null;
  unitsPerOrder: number | null;
  /** orders / sessions — null when no sessions were recorded. */
  conversionRate: number | null;
  subscriptionRate: number | null;
  protectionAttachRate: number | null;
  upsellAttributionRate: number | null;
  subscriptionOrders: number;
  protectionOrders: number;
  upsellOrders: number;
  /** Order totals (shop currency) — the sample for the AOV Welch test. */
  perOrderTotals: number[];
  /** Orders per day, zero-filled across the whole window. */
  dailyOrders: number[];
  /** Revenue per day, zero-filled across the whole window. */
  dailyRevenue: number[];
  currency: string | null;
}

/**
 * Aggregates sessions + order stats for one market over [from, to).
 * Market "all" applies no market filter (includes unattributed rows);
 * a market handle matches only rows attributed to that market.
 */
export async function periodMetrics(
  shop: string,
  market: string,
  from: Date,
  to: Date,
): Promise<PeriodMetrics> {
  const marketFilter = market === "all" ? {} : { market };
  const [sessions, orderRows] = await Promise.all([
    prisma.event.count({
      where: {
        shop,
        feature: "site",
        type: "session",
        createdAt: { gte: from, lt: to },
        ...marketFilter,
      },
    }),
    prisma.orderStat.findMany({
      where: {
        shop,
        processedAt: { gte: from, lt: to },
        ...marketFilter,
      },
      select: {
        totalPrice: true,
        currency: true,
        unitCount: true,
        hasSubscription: true,
        hasProtection: true,
        upsellAttributed: true,
        processedAt: true,
      },
    }),
  ]);

  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  const dailyOrders = new Array<number>(days).fill(0);
  const dailyRevenue = new Array<number>(days).fill(0);
  const perOrderTotals: number[] = [];
  let revenue = 0;
  let units = 0;
  let subscriptionOrders = 0;
  let protectionOrders = 0;
  let upsellOrders = 0;

  for (const order of orderRows) {
    perOrderTotals.push(order.totalPrice);
    revenue += order.totalPrice;
    units += order.unitCount;
    if (order.hasSubscription) subscriptionOrders += 1;
    if (order.hasProtection) protectionOrders += 1;
    if (order.upsellAttributed) upsellOrders += 1;
    const bucket = Math.min(
      days - 1,
      Math.max(
        0,
        Math.floor((order.processedAt.getTime() - from.getTime()) / DAY_MS),
      ),
    );
    dailyOrders[bucket] += 1;
    dailyRevenue[bucket] += order.totalPrice;
  }

  const orders = orderRows.length;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    days,
    sessions,
    orders,
    revenue,
    aov: orders > 0 ? revenue / orders : null,
    unitsPerOrder: orders > 0 ? units / orders : null,
    conversionRate: sessions > 0 ? orders / sessions : null,
    subscriptionRate: orders > 0 ? subscriptionOrders / orders : null,
    protectionAttachRate: orders > 0 ? protectionOrders / orders : null,
    upsellAttributionRate: orders > 0 ? upsellOrders / orders : null,
    subscriptionOrders,
    protectionOrders,
    upsellOrders,
    perOrderTotals,
    dailyOrders,
    dailyRevenue,
    currency: orderRows.find((o) => o.currency)?.currency ?? null,
  };
}

// ---------------------------------------------------------------------------
// Metric battery (shared by early warning + report)
// ---------------------------------------------------------------------------

export type MetricFormat = "count" | "money" | "rate" | "decimal";

export interface ReportRow {
  metric: string;
  label: string;
  format: MetricFormat;
  baseline: number | null;
  current: number | null;
  /** (current - baseline) / baseline, or null when either side is missing. */
  relativeChange: number | null;
  /** Two-sided p-value, null when the test could not run (or none exists). */
  p: number | null;
  /** Whether a statistical test exists for this metric. */
  tested: boolean;
  /** Whether the metric participates in early-warning evaluation. */
  warnable: boolean;
  /** Plain-language significance, e.g. "very unlikely to be random (p = 0.008)". */
  significance: string;
  /** Sample sizes backing the comparison, e.g. "210 vs 187 orders". */
  sampleNote: string;
}

function formatP(p: number): string {
  return p < 0.001 ? "< 0.001" : `= ${p.toFixed(3)}`;
}

/** Plain-language rendering of a two-sided p-value for merchants. */
export function describeSignificance(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "n/a — not enough data";
  if (p < 0.01) return `very unlikely to be random (p ${formatP(p)})`;
  if (p < 0.05) return `unlikely to be random (p ${formatP(p)})`;
  return `could be random noise (p ${formatP(p)})`;
}

function relativeChange(
  baseline: number | null,
  current: number | null,
): number | null {
  if (baseline === null || current === null) return null;
  if (!Number.isFinite(baseline) || !Number.isFinite(current)) return null;
  if (baseline === 0) return null;
  return (current - baseline) / baseline;
}

interface MetricSpec {
  metric: string;
  label: string;
  format: MetricFormat;
  warnable: boolean;
  value: (m: PeriodMetrics) => number | null;
  /** Returns the two-sided p-value, or null when the test cannot run. */
  test:
    | ((current: PeriodMetrics, baseline: PeriodMetrics) => number | null)
    | null;
  sampleNote: (current: PeriodMetrics, baseline: PeriodMetrics) => string;
}

const METRIC_SPECS: MetricSpec[] = [
  {
    metric: "sessions",
    label: "Sessions",
    format: "count",
    warnable: false,
    value: (m) => m.sessions,
    test: null,
    sampleNote: (c, b) => `${b.sessions} vs ${c.sessions} sessions`,
  },
  {
    metric: "orders",
    label: "Orders",
    format: "count",
    warnable: true,
    value: (m) => m.orders,
    // Equal-length windows, so total-order change == orders/day change; the
    // Welch test runs on the daily order counts.
    test: (c, b) => welchTTest(c.dailyOrders, b.dailyOrders)?.pTwoSided ?? null,
    sampleNote: (c, b) => `${b.days} vs ${c.days} days`,
  },
  {
    metric: "conversionRate",
    label: "Conversion rate",
    format: "rate",
    warnable: true,
    value: (m) => m.conversionRate,
    test: (c, b) =>
      c.sessions > 0 && b.sessions > 0
        ? (twoProportionZTest(c.orders, c.sessions, b.orders, b.sessions)
            ?.pTwoSided ?? null)
        : null,
    sampleNote: (c, b) =>
      `${b.orders}/${b.sessions} vs ${c.orders}/${c.sessions} sessions`,
  },
  {
    metric: "aov",
    label: "Average order value",
    format: "money",
    warnable: true,
    value: (m) => m.aov,
    test: (c, b) =>
      welchTTest(c.perOrderTotals, b.perOrderTotals)?.pTwoSided ?? null,
    sampleNote: (c, b) => `${b.orders} vs ${c.orders} orders`,
  },
  {
    metric: "revenuePerDay",
    label: "Revenue per day",
    format: "money",
    warnable: true,
    value: (m) => (m.days > 0 ? m.revenue / m.days : null),
    test: (c, b) =>
      welchTTest(c.dailyRevenue, b.dailyRevenue)?.pTwoSided ?? null,
    sampleNote: (c, b) => `${b.days} vs ${c.days} days`,
  },
  {
    metric: "unitsPerOrder",
    label: "Units per order",
    format: "decimal",
    warnable: false,
    value: (m) => m.unitsPerOrder,
    test: null,
    sampleNote: (c, b) => `${b.orders} vs ${c.orders} orders`,
  },
  {
    metric: "subscriptionRate",
    label: "Subscription rate",
    format: "rate",
    warnable: true,
    value: (m) => m.subscriptionRate,
    test: (c, b) =>
      c.orders > 0 && b.orders > 0
        ? (twoProportionZTest(
            c.subscriptionOrders,
            c.orders,
            b.subscriptionOrders,
            b.orders,
          )?.pTwoSided ?? null)
        : null,
    sampleNote: (c, b) =>
      `${b.subscriptionOrders}/${b.orders} vs ${c.subscriptionOrders}/${c.orders} orders`,
  },
  {
    metric: "protectionAttachRate",
    label: "Protection attach rate",
    format: "rate",
    warnable: true,
    value: (m) => m.protectionAttachRate,
    test: (c, b) =>
      c.orders > 0 && b.orders > 0
        ? (twoProportionZTest(
            c.protectionOrders,
            c.orders,
            b.protectionOrders,
            b.orders,
          )?.pTwoSided ?? null)
        : null,
    sampleNote: (c, b) =>
      `${b.protectionOrders}/${b.orders} vs ${c.protectionOrders}/${c.orders} orders`,
  },
  {
    metric: "upsellAttributionRate",
    label: "Upsell-attributed orders",
    format: "rate",
    // Informational in reports; not part of the early-warning battery.
    warnable: false,
    value: (m) => m.upsellAttributionRate,
    test: (c, b) =>
      c.orders > 0 && b.orders > 0
        ? (twoProportionZTest(
            c.upsellOrders,
            c.orders,
            b.upsellOrders,
            b.orders,
          )?.pTwoSided ?? null)
        : null,
    sampleNote: (c, b) =>
      `${b.upsellOrders}/${b.orders} vs ${c.upsellOrders}/${c.orders} orders`,
  },
];

function buildComparisonRows(
  baseline: PeriodMetrics,
  current: PeriodMetrics,
): ReportRow[] {
  return METRIC_SPECS.map((spec) => {
    const baseValue = spec.value(baseline);
    const currentValue = spec.value(current);
    const p = spec.test ? spec.test(current, baseline) : null;
    return {
      metric: spec.metric,
      label: spec.label,
      format: spec.format,
      baseline: baseValue,
      current: currentValue,
      relativeChange: relativeChange(baseValue, currentValue),
      p,
      tested: spec.test !== null,
      warnable: spec.warnable,
      significance: spec.test ? describeSignificance(p) : "not tested",
      sampleNote: spec.sampleNote(current, baseline),
    };
  });
}

// ---------------------------------------------------------------------------
// Session coverage (conversion-rate guard)
// ---------------------------------------------------------------------------

const SESSION_COVERAGE_TOLERANCE_MS = 6 * 60 * 60 * 1000;

const SESSION_COVERAGE_NOTE =
  "n/a - session tracking did not cover the full baseline window";

/**
 * True when session tracking does NOT span the experiment's full baseline
 * window: the first session beacon for the shop/market (or none at all)
 * arrived later than baselineFrom plus a 6-hour tolerance. A partial
 * denominator would understate baseline sessions and inflate the baseline
 * conversion rate, so conversion comparisons are suppressed in that case.
 */
async function hasPartialSessionCoverage(
  experiment: Experiment,
): Promise<boolean> {
  const first = await prisma.event.findFirst({
    where: {
      shop: experiment.shop,
      feature: "site",
      type: "session",
      ...(experiment.market === "all" ? {} : { market: experiment.market }),
    },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (!first) return true;
  return (
    first.createdAt.getTime() >
    experiment.baselineFrom.getTime() + SESSION_COVERAGE_TOLERANCE_MS
  );
}

/** Blanks the conversion-rate row (values, p, warnability) with the coverage note. */
function suppressConversionRow(row: ReportRow): ReportRow {
  if (row.metric !== "conversionRate") return row;
  return {
    ...row,
    baseline: null,
    current: null,
    relativeChange: null,
    p: null,
    warnable: false,
    significance: SESSION_COVERAGE_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Early warning
// ---------------------------------------------------------------------------

export type WarningSeverity = "caution" | "critical";

export interface WarningSignal extends ReportRow {
  /** Null for good-news entries. */
  severity: WarningSeverity | null;
}

export interface EarlyWarning {
  computedAt: string;
  eligible: boolean;
  /** Why the evaluation did not run, when ineligible. */
  reason: string | null;
  /** Length (days) of each comparison window. */
  daysCompared: number;
  /** Full experiment days elapsed at evaluation time. */
  elapsedDays: number;
  /** Orders in the FULL baseline window (eligibility gate). */
  baselineOrders: number;
  warnings: WarningSignal[];
  goodNews: WarningSignal[];
  severity: "none" | WarningSeverity;
}

const WARNING_DROP_THRESHOLD = -0.05;
const WARNING_P_THRESHOLD = 0.05;
const CRITICAL_P_THRESHOLD = 0.01;
const CRITICAL_DROP_THRESHOLD = -0.15;

/**
 * Number of whole days each comparison window covers right now. Zero during
 * the first 24 h — there is no full experiment day to compare yet, and a
 * partial experiment day must never be compared against a full baseline day.
 */
function comparisonDays(experiment: Experiment, now: Date): number {
  const reference =
    experiment.status === "running"
      ? now
      : (experiment.concludedAt ?? now);
  const end = Math.min(reference.getTime(), experiment.endsAt.getTime());
  const elapsed = Math.floor((end - experiment.startedAt.getTime()) / DAY_MS);
  return Math.max(0, Math.min(elapsed, experiment.baselineDays));
}

/**
 * Evaluates the early-warning battery per SPEC v2: requires >= 3 full
 * experiment days and >= 30 orders in the full baseline window; compares
 * equal-length windows counted from each window's START; a metric warns when
 * its direction is negative, the relative drop is worse than -5%, and
 * p < 0.05 ("critical" when p < 0.01 or the drop is worse than -15%).
 * Significant positive movements are reported separately as good news.
 */
export async function evaluateEarlyWarning(
  experiment: Experiment,
  now: Date = new Date(),
): Promise<EarlyWarning> {
  const elapsedDays = Math.max(
    0,
    Math.floor((now.getTime() - experiment.startedAt.getTime()) / DAY_MS),
  );
  const daysCompared = Math.max(
    1,
    Math.min(elapsedDays, experiment.baselineDays),
  );
  const baselineFull = await periodMetrics(
    experiment.shop,
    experiment.market,
    experiment.baselineFrom,
    experiment.baselineTo,
  );
  const base: Omit<
    EarlyWarning,
    "eligible" | "reason" | "warnings" | "goodNews" | "severity"
  > = {
    computedAt: now.toISOString(),
    daysCompared,
    elapsedDays,
    baselineOrders: baselineFull.orders,
  };

  if (elapsedDays < 3) {
    return {
      ...base,
      eligible: false,
      reason: `Early-warning checks start after 3 full experiment days (currently ${elapsedDays}).`,
      warnings: [],
      goodNews: [],
      severity: "none",
    };
  }
  if (baselineFull.orders < 30) {
    return {
      ...base,
      eligible: false,
      reason: `Early-warning checks need at least 30 baseline orders (currently ${baselineFull.orders}).`,
      warnings: [],
      goodNews: [],
      severity: "none",
    };
  }

  const baselineWindow =
    daysCompared === experiment.baselineDays
      ? baselineFull
      : await periodMetrics(
          experiment.shop,
          experiment.market,
          experiment.baselineFrom,
          addDays(experiment.baselineFrom, daysCompared),
        );
  const experimentWindow = await periodMetrics(
    experiment.shop,
    experiment.market,
    experiment.startedAt,
    addDays(experiment.startedAt, daysCompared),
  );

  let rows = buildComparisonRows(baselineWindow, experimentWindow);
  if (await hasPartialSessionCoverage(experiment)) {
    // Partial session coverage: the conversion test compares against an
    // understated baseline denominator, so it never warns (or celebrates).
    rows = rows.map(suppressConversionRow);
  }
  const warnings: WarningSignal[] = [];
  const goodNews: WarningSignal[] = [];
  for (const row of rows) {
    if (!row.warnable || row.p === null || row.relativeChange === null) {
      continue;
    }
    if (
      row.relativeChange < WARNING_DROP_THRESHOLD &&
      row.p < WARNING_P_THRESHOLD
    ) {
      warnings.push({
        ...row,
        severity:
          row.p < CRITICAL_P_THRESHOLD ||
          row.relativeChange < CRITICAL_DROP_THRESHOLD
            ? "critical"
            : "caution",
      });
    } else if (
      row.relativeChange > -WARNING_DROP_THRESHOLD &&
      row.p < WARNING_P_THRESHOLD
    ) {
      goodNews.push({ ...row, severity: null });
    }
  }

  return {
    ...base,
    eligible: true,
    reason: null,
    warnings,
    goodNews,
    severity: warnings.some((w) => w.severity === "critical")
      ? "critical"
      : warnings.length > 0
        ? "caution"
        : "none",
  };
}

function parseEarlyWarning(json: string | null): EarlyWarning | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as EarlyWarning;
    if (
      typeof parsed?.computedAt === "string" &&
      typeof parsed?.daysCompared === "number" &&
      Array.isArray(parsed?.warnings) &&
      Array.isArray(parsed?.goodNews)
    ) {
      return parsed;
    }
  } catch {
    // Fall through to recompute.
  }
  return null;
}

/** Cache key for warningJson: full experiment days, clamped like the TTL check. */
function warningCacheKeyDays(experiment: Experiment, now: Date): number {
  return Math.max(
    1,
    Math.min(
      Math.max(
        0,
        Math.floor((now.getTime() - experiment.startedAt.getTime()) / DAY_MS),
      ),
      experiment.baselineDays,
    ),
  );
}

/**
 * Cached early warning: reuses the persisted evaluation unless it is older
 * than 6 hours or the comparison-window day count has changed since it was
 * computed (i.e. another full experiment day has elapsed).
 */
export async function getEarlyWarning(
  experiment: Experiment,
  now: Date = new Date(),
): Promise<EarlyWarning> {
  const daysCompared = warningCacheKeyDays(experiment, now);
  const stored = parseEarlyWarning(experiment.warningJson);
  if (
    stored &&
    stored.daysCompared === daysCompared &&
    now.getTime() - Date.parse(stored.computedAt) < WARNING_TTL_MS
  ) {
    return stored;
  }
  const fresh = await evaluateEarlyWarning(experiment, now);
  await prisma.experiment.update({
    where: { id: experiment.id },
    data: { warningJson: JSON.stringify(fresh) },
  });
  return fresh;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface ReportWindow {
  from: string;
  to: string;
  days: number;
  sessions: number;
  orders: number;
  revenue: number;
}

export interface ExperimentReport {
  computedAt: string;
  /** Length (days) of each comparison window. */
  daysCompared: number;
  /** True when the experiment ran shorter than its planned length. */
  partial: boolean;
  baselineWindow: ReportWindow;
  experimentWindow: ReportWindow;
  currency: string | null;
  rows: ReportRow[];
}

function summarizeWindow(metrics: PeriodMetrics): ReportWindow {
  return {
    from: metrics.from,
    to: metrics.to,
    days: metrics.days,
    sessions: metrics.sessions,
    orders: metrics.orders,
    revenue: metrics.revenue,
  };
}

const NO_FULL_DAY_NOTE =
  "No full experiment day yet - live comparison starts after the first 24 h";

/**
 * Full metric battery over two equal-length windows: for early stops the
 * windows are truncated to min(elapsedDays, baselineDays) whole days counted
 * from each window's START, so baseline and experiment always cover the same
 * number of days. Before the first full experiment day there is no honest
 * equal-window comparison, so the report refuses one: every metric renders
 * n/a with an explanation instead of comparing a partial experiment day
 * against a full baseline day.
 */
export async function buildReport(
  experiment: Experiment,
  now: Date = new Date(),
): Promise<ExperimentReport> {
  const daysCompared = comparisonDays(experiment, now);
  if (daysCompared < 1) {
    const baselineFull = await periodMetrics(
      experiment.shop,
      experiment.market,
      experiment.baselineFrom,
      experiment.baselineTo,
    );
    return {
      computedAt: now.toISOString(),
      daysCompared: 0,
      partial: true,
      baselineWindow: summarizeWindow(baselineFull),
      experimentWindow: {
        from: experiment.startedAt.toISOString(),
        to: experiment.startedAt.toISOString(),
        days: 0,
        sessions: 0,
        orders: 0,
        revenue: 0,
      },
      currency: baselineFull.currency,
      rows: METRIC_SPECS.map((spec) => ({
        metric: spec.metric,
        label: spec.label,
        format: spec.format,
        baseline: null,
        current: null,
        relativeChange: null,
        p: null,
        tested: spec.test !== null,
        warnable: false,
        significance: NO_FULL_DAY_NOTE,
        sampleNote: "—",
      })),
    };
  }

  const baseline = await periodMetrics(
    experiment.shop,
    experiment.market,
    experiment.baselineFrom,
    addDays(experiment.baselineFrom, daysCompared),
  );
  const current = await periodMetrics(
    experiment.shop,
    experiment.market,
    experiment.startedAt,
    addDays(experiment.startedAt, daysCompared),
  );
  let rows = buildComparisonRows(baseline, current);
  if (await hasPartialSessionCoverage(experiment)) {
    rows = rows.map(suppressConversionRow);
  }
  return {
    computedAt: now.toISOString(),
    daysCompared,
    partial: daysCompared < experiment.baselineDays,
    baselineWindow: summarizeWindow(baseline),
    experimentWindow: summarizeWindow(current),
    currency: current.currency ?? baseline.currency,
    rows,
  };
}

export function parseReport(json: string | null): ExperimentReport | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as ExperimentReport;
    if (
      typeof parsed?.computedAt === "string" &&
      Array.isArray(parsed?.rows) &&
      typeof parsed?.daysCompared === "number"
    ) {
      return parsed;
    }
  } catch {
    // Fall through.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Quick stats for the experiments index (cached inside warningJson)
// ---------------------------------------------------------------------------

/** The experiments-index quick numbers, derived from a full report. */
export interface QuickReport {
  /** Whole days in each comparison window (0 during the first 24 h). */
  daysCompared: number;
  ordersBaseline: number | null;
  ordersCurrent: number | null;
  conversionDelta: number | null;
  aovDelta: number | null;
}

export interface RunningQuickStats extends QuickReport {
  severity: EarlyWarning["severity"];
}

function quickReportOf(report: ExperimentReport): QuickReport {
  const ordersRow = report.rows.find((row) => row.metric === "orders");
  return {
    daysCompared: report.daysCompared,
    ordersBaseline: ordersRow?.baseline ?? null,
    ordersCurrent: ordersRow?.current ?? null,
    conversionDelta:
      report.rows.find((row) => row.metric === "conversionRate")
        ?.relativeChange ?? null,
    aovDelta:
      report.rows.find((row) => row.metric === "aov")?.relativeChange ?? null,
  };
}

function parseQuickReport(value: unknown): QuickReport | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const quick = value as Record<string, unknown>;
  const numberOrNull = (entry: unknown): entry is number | null =>
    entry === null || typeof entry === "number";
  if (typeof quick.daysCompared !== "number") return null;
  if (!numberOrNull(quick.ordersBaseline)) return null;
  if (!numberOrNull(quick.ordersCurrent)) return null;
  if (!numberOrNull(quick.conversionDelta)) return null;
  if (!numberOrNull(quick.aovDelta)) return null;
  return {
    daysCompared: quick.daysCompared,
    ordersBaseline: quick.ordersBaseline,
    ordersCurrent: quick.ordersCurrent,
    conversionDelta: quick.conversionDelta,
    aovDelta: quick.aovDelta,
  };
}

/**
 * Early-warning severity + quick comparison numbers for a running
 * experiment's index card, cached so a page view does not re-run the full
 * periodMetrics sweeps per experiment.
 *
 * Storage choice (no schema migration): the quick numbers ride along INSIDE
 * the cached warningJson payload as an extra `quickReport` field — old
 * payloads (and getEarlyWarning rewrites, which drop the field) simply miss
 * it and trigger a one-off recompute here. Invalidation reuses the existing
 * warningJson pattern: 6 h TTL keyed on computedAt, plus the clamped
 * comparison-day count.
 */
export async function getRunningQuickStats(
  experiment: Experiment,
  now: Date = new Date(),
): Promise<RunningQuickStats> {
  const daysCompared = warningCacheKeyDays(experiment, now);
  const stored = parseEarlyWarning(experiment.warningJson) as
    | (EarlyWarning & { quickReport?: unknown })
    | null;
  const storedFresh =
    stored !== null &&
    stored.daysCompared === daysCompared &&
    now.getTime() - Date.parse(stored.computedAt) < WARNING_TTL_MS;
  const storedQuick = storedFresh ? parseQuickReport(stored.quickReport) : null;
  if (storedFresh && storedQuick) {
    return { severity: stored.severity ?? "none", ...storedQuick };
  }
  // A fresh stored warning only misses its quick numbers — recompute just
  // the report and graft them on (keeping the stored computedAt, so they
  // refresh no later than the warning itself would).
  const [warning, report] = storedFresh
    ? [stored as EarlyWarning, await buildReport(experiment, now)]
    : await Promise.all([
        evaluateEarlyWarning(experiment, now),
        buildReport(experiment, now),
      ]);
  const quickReport = quickReportOf(report);
  await prisma.experiment.update({
    where: { id: experiment.id },
    data: { warningJson: JSON.stringify({ ...warning, quickReport }) },
  });
  return { severity: warning.severity ?? "none", ...quickReport };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface ExperimentFlip {
  key: FeatureKey;
  from: boolean;
  to: boolean;
}

export function parseFlips(json: string): ExperimentFlip[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (flip): flip is ExperimentFlip =>
        typeof flip === "object" &&
        flip !== null &&
        FEATURE_KEYS.includes(flip.key) &&
        typeof flip.from === "boolean" &&
        typeof flip.to === "boolean",
    );
  } catch {
    return [];
  }
}

/**
 * Current effective state of a feature for the experiment's audience.
 * A market handle checks that market; "all" is true only when the feature is
 * live in EVERY market (flags on + scope mode "all") — flipping it ON via
 * applyFlipForMarket then makes it live everywhere.
 */
export function effectiveStateForMarket(
  settings: BoosterSettings,
  key: FeatureKey,
  market: string,
): boolean {
  // "" matches no selected-markets list, so it reduces to flags && mode "all".
  return isFeatureOnForMarket(settings, key, market === "all" ? "" : market);
}

/** All cart_* feature keys — one drift/lock group (shared master switch). */
const CART_GROUP_KEYS: FeatureKey[] = FEATURE_KEYS.filter(
  (key) => FEATURE_RAW_FIELD[key].kind === "cart",
);

/**
 * Canonical hashed object shared by the current and the previous
 * per-experiment hash compositions. `includeCartSiblingScopes` is the ONLY
 * difference between them: the previous composition hashed cart sibling
 * SUB-FLAGS but not sibling SCOPES, so a sibling scope change that altered
 * the experiment market's drawer never tripped drift.
 */
function hashCanonical(
  snapshot: FlagsSnapshot,
  keys: FeatureKey[],
  includeCartSiblingScopes: boolean,
) {
  const sortedKeys = [...new Set(keys)].sort();
  const hasCartKey = sortedKeys.some(
    (key) => FEATURE_RAW_FIELD[key]?.kind === "cart",
  );
  const scopeKeys =
    hasCartKey && includeCartSiblingScopes
      ? [...new Set([...sortedKeys, ...CART_GROUP_KEYS])].sort()
      : sortedKeys;
  return {
    cartMaster: hasCartKey ? snapshot.cartMaster : null,
    cartSubFlags: hasCartKey
      ? CART_SUB_FLAG_FIELDS.map((field) => ({
          field,
          on: snapshot.cartSubFlags[field],
        }))
      : [],
    sections: sortedKeys.flatMap((key) => {
      const raw = FEATURE_RAW_FIELD[key];
      return raw?.kind === "section"
        ? [{ field: raw.field, on: snapshot.sectionEnabled[raw.field] }]
        : [];
    }),
    scopes: scopeKeys.map((key) => ({
      key,
      mode: snapshot.marketScopes[key]?.mode ?? "all",
      markets: [...(snapshot.marketScopes[key]?.markets ?? [])].sort(),
    })),
  };
}

/**
 * Stable hash of the parts of a flag/scope snapshot that BELONG TO the given
 * flip keys — used for per-experiment settings-drift detection. Covers only:
 *
 *   - each flipped key's raw flag (via FEATURE_RAW_FIELD), where any cart_*
 *     key pulls in the cart master AND all four cart sub-flags (they share
 *     one master switch, so a sibling sub-flag change alters the cart drawer
 *     in the experiment's market too),
 *   - each flipped key's market scope, and
 *   - for cart experiments, every cart_* key's market scope (a sibling
 *     scope change alters the drawer in the experiment's market just like a
 *     sibling sub-flag change does).
 *
 * Everything else — other features' flags and scopes — is deliberately
 * excluded so a concurrent experiment in another market never triggers a
 * drift warning here.
 */
export function computeSettingsHash(
  snapshot: FlagsSnapshot,
  keys: FeatureKey[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(hashCanonical(snapshot, keys, true)))
    .digest("hex");
}

/**
 * The previous per-experiment composition (no cart sibling scopes). Kept so
 * cart experiments already running when the composition gained sibling
 * scopes don't fabricate a drift warning: their stored hash still matches an
 * unchanged snapshot, and isSettingsDrifted migrates it forward on read.
 * For experiments without cart keys the two compositions are identical.
 */
function computePreviousSettingsHash(
  snapshot: FlagsSnapshot,
  keys: FeatureKey[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(hashCanonical(snapshot, keys, false)))
    .digest("hex");
}

/**
 * The v2 whole-shop hash format. Kept ONLY so experiments that were already
 * running when the app upgraded to per-experiment hashing don't all fabricate
 * a drift warning: their stored hash is in this format, so an unchanged
 * snapshot still matches it.
 */
function computeLegacySettingsHash(snapshot: FlagsSnapshot): string {
  const canonical = {
    cartMaster: snapshot.cartMaster,
    cartSubFlags: CART_SUB_FLAG_FIELDS.map((field) => ({
      field,
      on: snapshot.cartSubFlags[field],
    })),
    sectionEnabled: STANDALONE_SECTION_FIELDS.map((field) => ({
      field,
      on: snapshot.sectionEnabled[field],
    })),
    scopes: FEATURE_KEYS.map((key) => ({
      key,
      mode: snapshot.marketScopes[key]?.mode ?? "all",
      markets: [...(snapshot.marketScopes[key]?.markets ?? [])].sort(),
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * True when THIS experiment's flipped keys' raw flags or scopes changed since
 * the experiment snapshotted them (for cart experiments: including sibling
 * cart scopes). Changes to other features — including a concurrent
 * experiment's flips in another market — never trip this.
 */
export function isSettingsDrifted(
  experiment: Experiment,
  settings: BoosterSettings,
): boolean {
  if (!experiment.settingsHash) return false;
  const keys = parseFlips(experiment.flips).map((flip) => flip.key);
  if (keys.length === 0) return false;
  const snapshot = snapshotFlags(settings);
  const currentHash = computeSettingsHash(snapshot, keys);
  if (currentHash === experiment.settingsHash) {
    return false;
  }
  // Rows hashed before cart sibling scopes joined the composition store the
  // previous per-experiment hash — an unchanged snapshot still matches it.
  // Migrate on read: silently rewrite to the current composition (best
  // effort, off the request path) instead of fabricating a drift warning.
  if (computePreviousSettingsHash(snapshot, keys) === experiment.settingsHash) {
    experiment.settingsHash = currentHash;
    void prisma.experiment
      .update({
        where: { id: experiment.id },
        data: { settingsHash: currentHash },
      })
      .catch(() => {});
    return false;
  }
  // Rows written before per-experiment hashing store the legacy whole-shop
  // hash — match that too so upgrading mid-experiment doesn't fake a drift.
  return computeLegacySettingsHash(snapshot) !== experiment.settingsHash;
}

/** 1-based experiment day for progress display ("Day X of N"). */
export function experimentDay(
  experiment: Experiment,
  now: Date = new Date(),
): number {
  const reference =
    experiment.status === "running"
      ? now
      : (experiment.concludedAt ?? experiment.endsAt);
  const elapsed = Math.floor(
    (reference.getTime() - experiment.startedAt.getTime()) / DAY_MS,
  );
  return Math.max(1, Math.min(elapsed + 1, experiment.baselineDays));
}

/**
 * Statuses that hold a market/flip-key lock for the start/apply guards. A row
 * is "concluding" only while one concludeExperiment call owns it (the atomic
 * claim below) — its flips are still live until the final status write, so it
 * must keep blocking new experiments (and Preview Center applies) exactly
 * like a running one.
 */
export const GUARDED_EXPERIMENT_STATUSES = ["running", "concluding"];

/** How long a row may sit in "concluding" before it is presumed crashed. */
const CONCLUDING_STALE_MS = 10 * 60 * 1000;

/**
 * Crash recovery: concludeExperiment claims a row ("running" → "concluding")
 * before doing any work; if the process dies mid-conclusion, the release in
 * its catch never runs and the stranded row would hold its market and
 * flip-key locks forever. Any row still "concluding" after 10 minutes is
 * presumed crashed and released back to "running" so the merchant can simply
 * retry the conclusion. Wired into every experiment read entry point below so
 * ALL consumers (lists, detail page, guards) self-heal on their next load.
 */
export async function releaseStaleConcluding(shop: string): Promise<number> {
  const result = await prisma.experiment.updateMany({
    where: {
      shop,
      status: "concluding",
      updatedAt: { lt: new Date(Date.now() - CONCLUDING_STALE_MS) },
    },
    data: { status: "running" },
  });
  return result.count;
}

export async function listExperiments(shop: string): Promise<Experiment[]> {
  await releaseStaleConcluding(shop);
  return prisma.experiment.findMany({
    where: { shop },
    orderBy: { startedAt: "desc" },
  });
}

export async function listRunningExperiments(
  shop: string,
): Promise<Experiment[]> {
  await releaseStaleConcluding(shop);
  return prisma.experiment.findMany({
    where: { shop, status: "running" },
    orderBy: { startedAt: "desc" },
  });
}

export async function getExperiment(
  shop: string,
  id: number,
): Promise<Experiment | null> {
  await releaseStaleConcluding(shop);
  return prisma.experiment.findFirst({ where: { id, shop } });
}

/**
 * Experiments whose status holds a market/flip-key lock ("running" plus
 * mid-conclusion "concluding" rows — GUARDED_EXPERIMENT_STATUSES), as the
 * summaries the guard helpers consume. Accepts a transaction client so an
 * atomic guard re-check reads the same snapshot it will write; the default
 * (non-transactional) path first releases crash-stranded "concluding" rows.
 */
export async function listGuardedExperiments(
  shop: string,
  tx?: Prisma.TransactionClient,
): Promise<RunningExperimentSummary[]> {
  if (!tx) await releaseStaleConcluding(shop);
  const db = tx ?? prisma;
  return db.experiment.findMany({
    where: { shop, status: { in: GUARDED_EXPERIMENT_STATUSES } },
    select: { name: true, market: true, flips: true },
  });
}

export interface StartExperimentInput {
  shop: string;
  admin: AdminGraphqlClient;
  name: string;
  /** Market handle, or "all". */
  market: string;
  /**
   * Flips exactly as reviewed in the wizard: each `from` is the effective
   * state the merchant SAW, validated against the current state at POST time
   * so a settings change between render and Start can't silently invert the
   * experiment.
   */
  flips: ExperimentFlip[];
  baselineDays: number;
}

export type StartExperimentResult =
  | { ok: true; id: number; syncErrors: string[] }
  | { ok: false; error: string };

/** The slice of a guarded Experiment row the start/apply guards need. */
export type RunningExperimentSummary = Pick<
  Experiment,
  "name" | "market" | "flips"
>;

export interface FeatureLock {
  /** Name of the running experiment holding the lock. */
  experimentName: string;
  /** Market handle of that experiment, or "all". */
  market: string;
}

function marketPhrase(market: string): string {
  return market === "all" ? "all markets" : market;
}

/**
 * Which feature keys are locked by running experiments (the flip-key overlap
 * guard, in map form for the wizard). A cart_* key flipped by any running
 * experiment locks ALL cart_* keys — they share the cartUpsell master switch,
 * so two experiments flipping different cart sub-features would fight over
 * (and selectively restore) the same master flag.
 */
export function lockedFeatureMap(
  running: RunningExperimentSummary[],
): Partial<Record<FeatureKey, FeatureLock>> {
  const locks: Partial<Record<FeatureKey, FeatureLock>> = {};
  for (const experiment of running) {
    for (const flip of parseFlips(experiment.flips)) {
      const lock: FeatureLock = {
        experimentName: experiment.name,
        market: experiment.market,
      };
      if (FEATURE_RAW_FIELD[flip.key].kind === "cart") {
        for (const key of FEATURE_KEYS) {
          if (FEATURE_RAW_FIELD[key].kind === "cart" && !locks[key]) {
            locks[key] = lock;
          }
        }
      } else if (!locks[flip.key]) {
        locks[flip.key] = lock;
      }
    }
  }
  return locks;
}

/**
 * The two start guards (SPEC v3 §B), shared by the pre-flight check and the
 * in-transaction re-check. Returns a merchant-readable conflict message, or
 * null when the experiment may start:
 *
 *   (a) Market isolation — same-market conflict; "all" conflicts with any
 *       running experiment and vice versa.
 *   (b) Flip-key overlap — a key flipped by any running experiment (in any
 *       market) is locked; all cart_* keys form one overlap group.
 */
export function findStartConflict(
  market: string,
  flipKeys: FeatureKey[],
  running: RunningExperimentSummary[],
): string | null {
  for (const experiment of running) {
    if (experiment.market === "all") {
      return `“${experiment.name}” is running for all markets, so no other experiment can start until it concludes.`;
    }
    if (market === "all") {
      return `An all-markets experiment conflicts with every running experiment — “${experiment.name}” (${marketPhrase(experiment.market)}) is still running. Conclude it first, or target a single free market.`;
    }
    if (experiment.market === market) {
      return `“${experiment.name}” is already running in this market — each market hosts one experiment at a time. Conclude it first, or pick a different market.`;
    }
  }
  const locks = lockedFeatureMap(running);
  for (const key of flipKeys) {
    const lock = locks[key];
    if (!lock) continue;
    if (FEATURE_RAW_FIELD[key].kind === "cart") {
      return `Cart features share one master switch, so they count as a single group across experiments — “${lock.experimentName}” (${marketPhrase(lock.market)}) is already flipping a cart feature. Conclude it first, or drop the cart flips.`;
    }
    return `“${FEATURE_DEFS[key].label}” is already being flipped by “${lock.experimentName}” (${marketPhrase(lock.market)}) — a feature can only be part of one running experiment at a time.`;
  }
  return null;
}

/**
 * getSettings, but through the given transaction client — so the settings
 * read that start-experiment (or the Preview Center's apply transaction)
 * validates and mutates is the same snapshot the transaction will write.
 * Mirrors models/settings.server.ts getSettings.
 */
export async function getSettingsWith(
  tx: Prisma.TransactionClient,
  shop: string,
): Promise<BoosterSettings> {
  const row = await tx.shopSettings.findUnique({ where: { shop } });
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  try {
    return mergeSettings(
      structuredClone(DEFAULT_SETTINGS),
      JSON.parse(row.data),
    );
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/**
 * saveSettings, but through the given transaction client — same
 * merge + sanitize + version-stamp pipeline, so a settings write from inside
 * the start transaction (or the Preview Center's apply transaction) is
 * byte-equivalent to one through saveSettings.
 */
export async function saveSettingsWith(
  tx: Prisma.TransactionClient,
  shop: string,
  patch: BoosterSettings,
): Promise<BoosterSettings> {
  const current = await getSettingsWith(tx, shop);
  const next = sanitizeSettings(mergeSettings(current, patch), current);
  next.version = DEFAULT_SETTINGS.version;
  await tx.shopSettings.upsert({
    where: { shop },
    create: { shop, data: JSON.stringify(next) },
    update: { data: JSON.stringify(next) },
  });
  return next;
}

/**
 * Starts an experiment: snapshots the current flags/scopes as the revert
 * state, applies every flip through applyFlipForMarket (the ONLY sanctioned
 * mutation path for market-scoped flags), persists the settings, and creates
 * the running Experiment row with baselineTo == startedAt — all in ONE
 * transaction, so a start rejected by the in-transaction guard leaves the
 * settings completely untouched. The storefront metafield mirror runs after
 * the commit (it is a network call and can be retried via retryStartSync).
 *
 * Experiments run concurrently, ONE per market (SPEC v3 §B): findStartConflict
 * enforces market isolation plus no flip-key overlap, which is exactly what
 * makes selective rollback and per-experiment drift hashing safe. Both guards
 * are re-checked inside the transaction to close the double-submit race.
 */
export async function startExperiment(
  input: StartExperimentInput,
): Promise<StartExperimentResult> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) {
    return { ok: false, error: "Name must be between 1 and 80 characters." };
  }
  if (
    !Number.isInteger(input.baselineDays) ||
    input.baselineDays < 7 ||
    input.baselineDays > 28
  ) {
    return { ok: false, error: "Baseline length must be 7 to 28 days." };
  }
  const flips = input.flips;
  if (flips.length === 0) {
    return { ok: false, error: "Pick at least one feature to flip." };
  }
  const flipKeys = flips.map((flip) => flip.key);
  if (new Set(flipKeys).size !== flipKeys.length) {
    return { ok: false, error: "Duplicate feature key in flips." };
  }
  if (flipKeys.some((key) => !FEATURE_KEYS.includes(key))) {
    return { ok: false, error: "Unknown feature key in flips." };
  }
  if (flips.some((flip) => flip.to !== !flip.from)) {
    return {
      ok: false,
      error: "Each flip must invert the feature's current state.",
    };
  }

  // Pre-flight guard: fast-fail on conflicts before any admin API round
  // trips. The authoritative check runs inside the transaction below.
  const running = await listGuardedExperiments(input.shop);
  const conflict = findStartConflict(input.market, flipKeys, running);
  if (conflict) {
    return { ok: false, error: conflict };
  }

  const markets = await listMarkets(input.admin);
  const allMarketHandles = markets.map((m) => m.handle);
  if (input.market !== "all" && !allMarketHandles.includes(input.market)) {
    return { ok: false, error: "Unknown market." };
  }

  const now = new Date();
  let failure: string | null = null;
  // Guard re-check, from-state validation, settings flip + persist, and row
  // creation are ONE atomic unit: a racer rejected here has written NOTHING
  // — no flips left live without an experiment row, and no stale settings
  // write that could clobber the winner's flips.
  const committed = await prisma.$transaction(async (tx) => {
    // Re-check BOTH start guards right before create: two overlapping Start
    // submissions can each pass the pre-flight check, but only a combination
    // that would also have been allowed sequentially may create a row.
    const stillRunning = await listGuardedExperiments(input.shop, tx);
    const raceConflict = findStartConflict(input.market, flipKeys, stillRunning);
    if (raceConflict) {
      failure = raceConflict;
      return null;
    }

    // Re-read the settings inside the transaction and re-validate every
    // `from` against them — the flips are applied to exactly the state the
    // merchant is shown to have reviewed, or not at all.
    const settings = await getSettingsWith(tx, input.shop);
    for (const flip of flips) {
      const current = effectiveStateForMarket(settings, flip.key, input.market);
      if (current !== flip.from) {
        failure =
          "Settings changed while you were reviewing - please review again.";
        return null;
      }
    }

    const revertState = snapshotFlags(settings);
    for (const flip of flips) {
      applyFlipForMarket(
        settings,
        flip.key,
        input.market,
        flip.to,
        allMarketHandles,
      );
    }
    const saved = await saveSettingsWith(tx, input.shop, settings);
    const settingsHash = computeSettingsHash(snapshotFlags(saved), flipKeys);
    const row = await tx.experiment.create({
      data: {
        shop: input.shop,
        name,
        market: input.market,
        flips: JSON.stringify(flips),
        revertState: JSON.stringify(revertState),
        settingsHash,
        baselineDays: input.baselineDays,
        baselineFrom: addDays(now, -input.baselineDays),
        baselineTo: now,
        startedAt: now,
        endsAt: addDays(now, input.baselineDays),
        status: "running",
        startSyncErrors: null,
      },
    });
    return { row, saved };
  });
  if (!committed) {
    return {
      ok: false,
      error:
        failure ??
        "Another experiment was started at the same time — review the running experiments and try again.",
    };
  }

  // Mirror the committed settings to the storefront metafields OUTSIDE the
  // transaction (network call). Failures are persisted to startSyncErrors so
  // the banner + retryStartSync flow stays honest.
  let syncErrors: string[] = [];
  try {
    syncErrors = (
      await syncSettingsToMetafields(input.admin, committed.saved)
    ).errors;
  } catch (error) {
    syncErrors = [
      error instanceof Error
        ? error.message
        : "Could not sync settings to storefront metafields.",
    ];
  }
  if (syncErrors.length > 0) {
    await prisma.experiment.update({
      where: { id: committed.row.id },
      data: { startSyncErrors: JSON.stringify(syncErrors) },
    });
  }
  return { ok: true, id: committed.row.id, syncErrors };
}

export interface ConcludeExperimentInput {
  shop: string;
  id: number;
  mode: "keep" | "rollback";
  admin: AdminGraphqlClient;
}

export type ConcludeExperimentResult =
  | { ok: true; status: "completed" | "stopped"; syncErrors: string[] }
  | { ok: false; error: string };

/**
 * Concludes a running experiment. "keep" leaves the flipped settings live;
 * "rollback" restores ONLY the experiment's own flipped keys' raw flags +
 * scopes from the FlagsSnapshot taken at start, via restoreFlagsSelective
 * (and re-mirrors the metafields) — the snapshot is whole-shop, but the
 * selective restore reads just the relevant parts, so a concurrent
 * experiment in another market keeps its flips. Status becomes "completed"
 * past endsAt, else "stopped". The final report is computed over equal
 * windows and cached in reportJson.
 *
 * Concurrency: the conclusion is CLAIMED atomically (status "running" ->
 * "concluding") before any work — two concurrent concludes, even with
 * different modes, resolve to exactly one execution; the loser reports
 * "already concluded". Every failure path releases the claim back to
 * "running" so the merchant can simply retry.
 */
export async function concludeExperiment(
  input: ConcludeExperimentInput,
): Promise<ConcludeExperimentResult> {
  const experiment = await getExperiment(input.shop, input.id);
  if (!experiment) {
    return { ok: false, error: "Experiment not found." };
  }
  if (experiment.status !== "running") {
    return { ok: false, error: "This experiment has already been concluded." };
  }

  // Atomic claim: both racers pass the read check above, but only ONE
  // updateMany can move the row out of "running" — the other matches zero
  // rows and must not restore or report anything.
  const claimed = await prisma.experiment.updateMany({
    where: { id: experiment.id, shop: input.shop, status: "running" },
    data: { status: "concluding" },
  });
  if (claimed.count === 0) {
    return { ok: false, error: "This experiment has already been concluded." };
  }
  const releaseClaim = async () => {
    await prisma.experiment.updateMany({
      where: { id: experiment.id, shop: input.shop, status: "concluding" },
      data: { status: "running" },
    });
  };

  try {
    const now = new Date();
    let syncErrors: string[] = [];
    if (input.mode === "rollback") {
      const flippedKeys = parseFlips(experiment.flips).map((flip) => flip.key);
      if (flippedKeys.length === 0) {
        await releaseClaim();
        return {
          ok: false,
          error:
            "The saved flip list is unreadable — settings were NOT changed. Adjust features manually, then conclude with “Keep the changes”.",
        };
      }
      const flippedRawFields = flippedKeys.map((key) => FEATURE_RAW_FIELD[key]);
      const needsCart = flippedRawFields.some((raw) => raw.kind === "cart");
      let snapshot: FlagsSnapshot;
      try {
        snapshot = JSON.parse(experiment.revertState) as FlagsSnapshot;
        // Validate only the parts the selective restore will actually read for
        // THIS experiment's keys — restoreFlagsSelective tolerates unrelated
        // missing fields, but silently skipping a field we need would turn
        // "roll back" into a no-op, so those must be present and well-typed.
        if (
          !snapshot ||
          typeof snapshot !== "object" ||
          (needsCart &&
            (typeof snapshot.cartMaster !== "boolean" ||
              !snapshot.cartSubFlags ||
              CART_SUB_FLAG_FIELDS.some(
                (field) => typeof snapshot.cartSubFlags[field] !== "boolean",
              ))) ||
          flippedRawFields.some(
            (raw) =>
              raw.kind === "section" &&
              typeof snapshot.sectionEnabled?.[raw.field] !== "boolean",
          ) ||
          flippedKeys.some((key) => {
            const scope = snapshot.marketScopes?.[key];
            return (
              !scope ||
              (scope.mode !== "all" && scope.mode !== "selected") ||
              !Array.isArray(scope.markets)
            );
          })
        ) {
          throw new Error("Malformed revert snapshot.");
        }
      } catch {
        await releaseClaim();
        return {
          ok: false,
          error:
            "The saved revert snapshot is unreadable — settings were NOT changed. Adjust features manually, then conclude with “Keep the changes”.",
        };
      }
      const settings = restoreFlagsSelective(
        await getSettings(input.shop),
        snapshot,
        flippedKeys,
      );
      const saved = await saveSettings(input.shop, settings);
      try {
        syncErrors = (await syncSettingsToMetafields(input.admin, saved)).errors;
      } catch (error) {
        syncErrors = [
          error instanceof Error
            ? error.message
            : "Could not sync settings to storefront metafields.",
        ];
      }
    }

    const report = await buildReport(experiment, now);
    const status: "completed" | "stopped" =
      now.getTime() >= experiment.endsAt.getTime() ? "completed" : "stopped";
    await prisma.experiment.update({
      where: { id: experiment.id },
      data: {
        status,
        outcome: input.mode === "keep" ? "kept" : "rolled_back",
        concludedAt: now,
        reportJson: JSON.stringify(report),
      },
    });
    return { ok: true, status, syncErrors };
  } catch (error) {
    // Unexpected failure mid-conclusion: release the claim so the experiment
    // is still running and the merchant can retry, then surface the error.
    await releaseClaim().catch(() => {});
    throw error;
  }
}

/** Parses the startSyncErrors column (JSON string array, or null). */
export function parseStartSyncErrors(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

export type RetryStartSyncResult =
  | { ok: true; syncErrors: string[] }
  | { ok: false; error: string };

/**
 * Re-runs the storefront metafield mirror for the CURRENT settings after a
 * failed sync at experiment start. Clears startSyncErrors on success;
 * on another failure it stores the fresh errors so the banner stays honest.
 */
export async function retryStartSync(input: {
  shop: string;
  id: number;
  admin: AdminGraphqlClient;
}): Promise<RetryStartSyncResult> {
  const experiment = await getExperiment(input.shop, input.id);
  if (!experiment) {
    return { ok: false, error: "Experiment not found." };
  }
  const settings = await getSettings(input.shop);
  let syncErrors: string[] = [];
  try {
    syncErrors = (await syncSettingsToMetafields(input.admin, settings)).errors;
  } catch (error) {
    syncErrors = [
      error instanceof Error
        ? error.message
        : "Could not sync settings to storefront metafields.",
    ];
  }
  await prisma.experiment.update({
    where: { id: experiment.id },
    data: {
      startSyncErrors:
        syncErrors.length > 0 ? JSON.stringify(syncErrors) : null,
    },
  });
  return { ok: true, syncErrors };
}

/**
 * Feature list for the wizard's flips table: label + current effective state
 * for the chosen market, in canonical FEATURE_KEYS order.
 */
export function featureFlipOptions(
  settings: BoosterSettings,
  market: string,
): { key: FeatureKey; label: string; effective: boolean }[] {
  return FEATURE_KEYS.map((key) => ({
    key,
    label: FEATURE_DEFS[key].label,
    effective: effectiveStateForMarket(settings, key, market),
  }));
}
