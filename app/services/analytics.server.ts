import prisma from "../db.server";

export interface TrackEventInput {
  feature: string;
  type: string;
  quantity?: number;
  revenue?: number;
  currency?: string;
  /** Shopify Markets handle the visitor browsed in (from the Liquid config). */
  market?: string;
  meta?: string;
}

const ALLOWED_FEATURES = new Set([
  "cart_upsell",
  "free_shipping_bar",
  "subscription_upsell",
  "subscription_nudge",
  "trust_badges",
  "trustpilot",
  "guarantee",
  "clinical_results",
  "checkout_upsell",
  "checkout_protection",
  "checkout_trust",
  // PDP trust boosters (SPEC v3) — impression beacons from the five
  // product-page widgets.
  "clinical_study",
  "verified_before_after",
  "batch_transparency",
  "empty_bottle_guarantee",
  "derm_survey",
  // Cart drawer cross-sell (v4.8) — impression/click/add_to_cart beacons.
  "cart_cross_sell",
  // Dispatch countdown (v5.0) — impression beacons from the PDP/cart widget.
  "dispatch_countdown",
  // Delivery estimate + guarantee (v5.9) — impression beacons from the PDP
  // widget (all four formats share the key).
  "delivery_estimate",
  // Site-wide session beacon (one per browser session) — powers the
  // experiment tracker's conversion-rate denominator.
  "site",
]);

const ALLOWED_TYPES = new Set([
  "impression",
  "click",
  "upgrade",
  "subscribe",
  "add_to_cart",
  "protect_on",
  "protect_off",
  "conversion",
  "session",
]);

const MAX_QUANTITY = 10000;
const MAX_REVENUE = 100000;
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

/** Client-supplied count: whole units only, 0..10000, anything else is dropped. */
function sanitizeQuantity(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated >= 0 && truncated <= MAX_QUANTITY ? truncated : null;
}

/** Client-supplied amount: negatives/NaN are dropped, huge values capped. */
function sanitizeRevenue(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.min(value, MAX_REVENUE);
}

function sanitizeCurrency(value: string | undefined): string | null {
  if (typeof value !== "string" || !CURRENCY_PATTERN.test(value)) return null;
  return value.toUpperCase();
}

/** Shopify market handles: lowercase alphanumerics + dashes, max 64 chars. */
const MARKET_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function sanitizeMarket(value: string | undefined): string | null {
  if (typeof value !== "string" || !MARKET_HANDLE_PATTERN.test(value)) {
    return null;
  }
  return value;
}

export async function recordEvent(
  shop: string,
  input: TrackEventInput,
): Promise<boolean> {
  if (!ALLOWED_FEATURES.has(input.feature) || !ALLOWED_TYPES.has(input.type)) {
    return false;
  }
  // "session" is exclusively the site-wide beacon; pairing it with widget
  // features (or "site" with funnel types) would skew both the analytics
  // funnels and the experiment tracker's session counts.
  if ((input.feature === "site") !== (input.type === "session")) {
    return false;
  }
  await prisma.event.create({
    data: {
      shop,
      feature: input.feature,
      type: input.type,
      quantity: sanitizeQuantity(input.quantity),
      revenue: sanitizeRevenue(input.revenue),
      currency: sanitizeCurrency(input.currency),
      market: sanitizeMarket(input.market),
      meta: input.meta?.slice(0, 500) ?? null,
    },
  });
  return true;
}

export interface FeatureFunnel {
  feature: string;
  impressions: number;
  clicks: number;
  conversions: number;
  /** Beacon-reported revenue per ISO currency code ("unknown" when untagged). */
  revenueByCurrency: Record<string, number>;
}

export interface AnalyticsSummary {
  days: number;
  currency: string | null;
  orders: number;
  aov: number;
  unitsPerOrder: number;
  subscriptionRate: number;
  protectionAttachRate: number;
  upsellAttributionRate: number;
  funnels: FeatureFunnel[];
}

function totalFunnelRevenue(funnel: FeatureFunnel): number {
  return Object.values(funnel.revenueByCurrency).reduce(
    (sum, value) => sum + value,
    0,
  );
}

export async function getAnalyticsSummary(
  shop: string,
  days = 30,
): Promise<AnalyticsSummary> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [eventGroups, orders] = await Promise.all([
    prisma.event.groupBy({
      by: ["feature", "type", "currency"],
      // Session beacons ("site") are a traffic denominator, not a widget
      // funnel — keep them out of the feature funnel table.
      where: { shop, feature: { not: "site" }, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { revenue: true },
    }),
    prisma.orderStat.findMany({
      where: { shop, processedAt: { gte: since } },
      select: {
        totalPrice: true,
        currency: true,
        unitCount: true,
        hasSubscription: true,
        hasProtection: true,
        upsellAttributed: true,
      },
    }),
  ]);

  const funnelMap = new Map<string, FeatureFunnel>();
  for (const group of eventGroups) {
    const funnel = funnelMap.get(group.feature) ?? {
      feature: group.feature,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      revenueByCurrency: {},
    };
    const count = group._count._all;
    if (group.type === "impression") funnel.impressions += count;
    else if (group.type === "click") funnel.clicks += count;
    else funnel.conversions += count;
    const revenue = group._sum.revenue ?? 0;
    if (revenue > 0) {
      const key = group.currency ?? "unknown";
      funnel.revenueByCurrency[key] =
        (funnel.revenueByCurrency[key] ?? 0) + revenue;
    }
    funnelMap.set(group.feature, funnel);
  }

  const orderCount = orders.length;
  const totalRevenue = orders.reduce((sum, o) => sum + o.totalPrice, 0);
  const totalUnits = orders.reduce((sum, o) => sum + o.unitCount, 0);

  return {
    days,
    // OrderStat rows are recorded in the shop currency (orders/paid webhook
    // uses total_price_set.shop_money), so any row's currency labels the
    // order-level aggregates consistently.
    currency: orders.find((o) => o.currency)?.currency ?? null,
    orders: orderCount,
    aov: orderCount ? totalRevenue / orderCount : 0,
    unitsPerOrder: orderCount ? totalUnits / orderCount : 0,
    subscriptionRate: orderCount
      ? orders.filter((o) => o.hasSubscription).length / orderCount
      : 0,
    protectionAttachRate: orderCount
      ? orders.filter((o) => o.hasProtection).length / orderCount
      : 0,
    upsellAttributionRate: orderCount
      ? orders.filter((o) => o.upsellAttributed).length / orderCount
      : 0,
    funnels: [...funnelMap.values()].sort(
      (a, b) => totalFunnelRevenue(b) - totalFunnelRevenue(a),
    ),
  };
}
