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
  // v9: checkout_customs / checkout_tracked are intentionally absent — the
  // checkout-trust extension is pure display (verified: no fetch/sendBeacon
  // anywhere in extensions/checkout-trust/src), so its V2 rows send no
  // beacons. Add them here AND to app.analytics.tsx FEATURE_LABELS if that
  // ever changes. (v13.1: this comment used to cite az_cart_free_line as the
  // beacon-free precedent — that claim was the exact misdiagnosis that
  // silently dropped its impressions; see the az entries below. Never assert
  // a widget is beacon-free from memory: grep what the extension fires.)
  // PDP trust boosters (SPEC v3) — impression beacons from the five
  // product-page widgets.
  "clinical_study",
  "verified_before_after",
  "batch_transparency",
  "empty_bottle_guarantee",
  "derm_survey",
  // Proof library (v8) — impression/click beacons from the press band,
  // dermatologist-endorsement wall and results gallery (the gallery reuses
  // the existing verified_before_after key).
  "press",
  "derm_endorsements",
  // Cart drawer cross-sell (v4.8) — impression/click/add_to_cart beacons.
  "cart_cross_sell",
  // Dispatch countdown (v5.0) — impression beacons from the PDP/cart widget.
  "dispatch_countdown",
  // Delivery estimate + guarantee (v5.9) — impression beacons from the PDP
  // widget (all four formats share the key).
  "delivery_estimate",
  // Amazon-pattern boosters (v6.1, split v6.8) — the nine az_* widgets that
  // send impression/click beacons from cellexia-pdp.js. These keys were
  // missing since v6.1, so every az impression was silently dropped here;
  // added in v6.8 alongside the stock/ships split.
  "az_buy_box",
  "az_microcopy",
  "az_delivery_line",
  "az_stock_line",
  "az_ships_from",
  "az_bought_count",
  "az_bestseller_badge",
  "az_fbt",
  "az_similar_items",
  // v13.1: the two cart decorators DO beacon, despite old comments in this
  // file claiming both were beacon-free — renderAzFreeLine returns
  // 'az_cart_free_line' into the cart impression lists, and
  // decorateCtaButtons fires fireDrawerImpressions/firePageImpressions with
  // 'az_cta_count' (cellexia-cart.js:948 and :3487-3488). Both keys were
  // missing here, so every one of their impressions was silently dropped —
  // the v6.1 az_* failure mode, twice more. The DROPPED logging in
  // recordEvent below exists precisely so the next skew cannot stay
  // invisible.
  "az_cart_free_line",
  "az_cta_count",
  // v14 rewards (SPEC v14 §3): the cart meter/nudge/gift sync and the PDP
  // set-savings row beacon under these two keys (impression + the four
  // rewards event types below).
  "set_savings",
  "gift_tiers",
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
  // v14 rewards: a gift tier reached (meta {tier}), a KIT code newly applied
  // to the cart, a free gift auto-added / removed (meta {tier}).
  "tier_reached",
  "code_applied",
  "gift_added",
  "gift_removed",
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

// v13.1: the drop log must survive a junk-beacon flood — the app proxy
// forwards ANY body a visitor POSTs to /apps/cellexia/track with a valid
// signature, so an attacker could otherwise bury the one diagnostic line
// that reveals allowlist skew. One warn per unique (shop, feature, type)
// per process; the Set is capped to bound memory, and repeats stay silent.
const WARNED_DROPS = new Set<string>();
const WARNED_DROPS_MAX = 500;

function warnDropOnce(key: string, message: string): void {
  if (WARNED_DROPS.has(key) || WARNED_DROPS.size >= WARNED_DROPS_MAX) return;
  WARNED_DROPS.add(key);
  console.warn(message);
}

// v13.1: during a database write outage every beacon would print a full
// stack trace (one POST per widget impression) — collapse to at most one
// stack per minute per process, counting what was suppressed in between.
const DB_ERROR_LOG_INTERVAL_MS = 60_000;
let dbErrorLastLoggedAt = 0;
let dbErrorsSuppressed = 0;

export async function recordEvent(
  shop: string,
  input: TrackEventInput,
): Promise<boolean> {
  if (!ALLOWED_FEATURES.has(input.feature) || !ALLOWED_TYPES.has(input.type)) {
    // v13.1: key skew between the deployed extension and this allowlist has
    // silently zeroed features three times (az_* v6.1→v6.8, then
    // az_cart_free_line and az_cta_count until v13.1). The sender is
    // fire-and-forget and the HTTP response is 200 either way, so this log
    // line is the only place the skew can ever surface — it must be loud.
    const feature = input.feature.slice(0, 100);
    const type = input.type.slice(0, 100);
    warnDropOnce(
      `${shop}|allowlist|${feature}|${type}`,
      `[cellexia-track] DROPPED beacon for ${shop}: feature=${JSON.stringify(
        feature,
      )} type=${JSON.stringify(type)} is not in the allowlists. If a ` +
        "deployed widget legitimately sends this key, add it to " +
        "ALLOWED_FEATURES/ALLOWED_TYPES (and FEATURE_LABELS in " +
        "app.analytics.tsx). Repeats of this exact drop are not logged again " +
        "until the server restarts.",
    );
    return false;
  }
  // "session" is exclusively the site-wide beacon; pairing it with widget
  // features (or "site" with funnel types) would skew both the analytics
  // funnels and the experiment tracker's session counts.
  if ((input.feature === "site") !== (input.type === "session")) {
    warnDropOnce(
      `${shop}|mispaired|${input.feature}|${input.type}`,
      `[cellexia-track] DROPPED mispaired beacon for ${shop}: ` +
        `feature="${input.feature}" type="${input.type}" ` +
        '("site" pairs only with "session"). Repeats of this exact drop are ' +
        "not logged again until the server restarts.",
    );
    return false;
  }
  try {
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
  } catch (error) {
    // v13.1: a dead or misconfigured database must not 500 the proxy route
    // (the sender ignores the response anyway) — but it must be loud here,
    // without printing one stack per beacon during an outage.
    const now = Date.now();
    if (now - dbErrorLastLoggedAt >= DB_ERROR_LOG_INTERVAL_MS) {
      const suppressedNote =
        dbErrorsSuppressed > 0
          ? `; ${dbErrorsSuppressed} similar failures suppressed since the last log`
          : "";
      console.error(
        `[cellexia-track] FAILED to store event for ${shop} ` +
          `(feature=${input.feature}, type=${input.type}${suppressedNote}):`,
        error,
      );
      dbErrorLastLoggedAt = now;
      dbErrorsSuppressed = 0;
    } else {
      dbErrorsSuppressed += 1;
    }
    return false;
  }
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
