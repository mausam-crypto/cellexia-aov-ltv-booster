/**
 * app/services/gift-plan.server.ts — v18 gift plan.
 *
 * The single source of truth for "what does a shopper in country X see and
 * earn". Lives in its own module because BOTH the live path
 * (metafields.server -> the cellexia/gift_plan metafield -> Liquid) and the
 * preview path (preview.server -> the token-verified proxy) must produce a
 * byte-identical shape, and importing one from the other would close a cycle.
 *
 * The design follows the pattern this codebase already uses for
 * gift_stock.paused[market]: the SERVER precomputes, LIQUID indexes by the
 * shopper's country, and the browser only ever receives its own cluster.
 * That keeps one country's offers out of another country's page source and
 * keeps the cart island small.
 */
import type { BoosterSettings } from "../models/settings.server";
import { toCountryCode } from "../models/settings.server";

/** "gid://shopify/ProductVariant/123" -> "123". */
function numeric(gid: string): string {
  const match = /(\d+)(?:\?.*)?$/.exec(String(gid ?? "").trim());
  return match ? match[1] : "";
}

/**
 * v18 gift plan: everything the storefront needs to render and grant gifts
 * for ONE country, precomputed per cluster so Liquid can slice it.
 *
 * This is the `gift_stock.paused[market]` pattern generalised. The cart and
 * product-page islands index it by `cx_country`, so a browser only ever
 * receives its own cluster instead of the whole settings section, which both
 * shrinks the page and stops one country's offers leaking into another's.
 */
export interface GiftPlanMetafield {
  /** ISO timestamp of the last write. */
  t: string;
  /** ISO-3166 alpha-2 -> cluster id. Named clusters only. */
  cc: Record<string, string>;
  /** The catch-all cluster id, used for every country not in `cc`. */
  rest: string;
  /** Cluster id -> the whole storefront config for that cluster. The globals
   *  ride inside each entry so one Liquid lookup covers everything. */
  cl: Record<
    string,
    {
      name: string;
      /** Per-tier EUR amounts (the fallback when a country has no override). */
      a: number[];
      /** Per-tier slots, options resolved to numeric variant ids. */
      t: ({ k: "v"; vid: string; h: string } | { k: "s"; n: number })[][][];
      /** Numeric variant ids paused for low stock in THIS cluster. */
      p: string[];
      cum: boolean;
      max: number;
      choice: string;
      rule: string;
      pool: { vid: string; h: string }[];
      ship: boolean;
    }
  >;
  /** ISO-3166 alpha-2 -> explicit local amounts. */
  bc: Record<string, { a: number[]; c: string }>;
  /** The product-page surface: on/off plus which of the three placements. */
  pdp: { on: boolean; style: string };
}

/** Builds the gift plan from settings plus the cluster-keyed paused sets. */
export function buildGiftPlan(
  settings: BoosterSettings,
  pausedByCluster: Record<string, string[]>,
  hv: Record<string, string> = {},
): GiftPlanMetafield {
  const gt = settings.rewards.giftTiers;
  const vidOf = (option: { variantId: string; handle: string }): string =>
    numeric(option.variantId) || (option.handle && hv[option.handle]) || "";
  const cl: GiftPlanMetafield["cl"] = {};
  for (const cluster of gt.clusters) {
    cl[cluster.id] = {
      name: cluster.name,
      a: cluster.tiers.map((tier) => tier.amount),
      t: cluster.tiers.map((tier) =>
        tier.slots.map((slot) =>
          slot.map((option) =>
            option.kind === "samples"
              ? { k: "s" as const, n: option.count }
              : { k: "v" as const, vid: vidOf(option), h: option.handle },
          ),
        ),
      ),
      p: [...(pausedByCluster[cluster.id] ?? [])],
      cum: gt.cumulative,
      max: gt.maxGiftLines,
      choice: gt.choice,
      rule: gt.sampleRule,
      pool: gt.samplePool.map((e) => ({ vid: numeric(e.variantId), h: e.handle })),
      ship: gt.showShippingMilestone,
    };
  }
  const cc: Record<string, string> = {};
  for (const cluster of gt.clusters) {
    if (cluster.rest) continue;
    for (const code of cluster.countries) cc[code] = cluster.id;
  }
  const bc: Record<string, { a: number[]; c: string }> = {};
  for (const [code, entry] of Object.entries(gt.thresholdsByCountry)) {
    bc[code] = { a: [...entry.amounts], c: entry.currencyCode };
  }
  return {
    t: new Date().toISOString(),
    cc,
    rest: (gt.clusters.find((c) => c.rest) ?? gt.clusters[gt.clusters.length - 1])?.id ?? "",
    cl,
    bc,
    pdp: { on: gt.pdp.enabled, style: gt.pdp.style },
  };
}


/** One cluster's storefront config: exactly what the island carries as `gt`. */
export type GiftClusterSlice = GiftPlanMetafield["cl"][string];

/**
 * The slice for one country: its cluster's config plus that country's own
 * local amounts (null when it has none and the EUR ladder should be
 * converted at runtime instead). Live Liquid does these two lookups itself;
 * preview calls this so the two paths cannot drift.
 */
export function giftPlanForCountry(
  plan: GiftPlanMetafield,
  country: string,
): { gt: GiftClusterSlice | null; gb: { a: number[]; c: string } | null } {
  const code = toCountryCode(country);
  const clusterId = (code && plan.cc[code]) || plan.rest;
  return {
    gt: (clusterId && plan.cl[clusterId]) || null,
    gb: (code && plan.bc[code]) || null,
  };
}
