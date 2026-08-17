import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
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
  Divider,
  InlineStack,
  Layout,
  Link,
  List,
  Page,
  RadioButton,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  FEATURE_DEFS,
  FEATURE_KEYS,
  applyFlipForMarket,
  getSettings,
  isFeatureOnForMarket,
  resolveFeatureFlag,
  sanitizeGiftThresholdsByMarket,
  sanitizeGiftTiers,
  sanitizeSetSavingsTiers,
  type FeatureKey,
  type GiftTier,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { listMarkets, type MarketSummary } from "../services/markets.server";
import { listProductsWithBoosterStatus } from "../services/pdp-content.server";
import { getProofCounts } from "../services/proof.server";
import {
  getSettingsWith,
  listGuardedExperiments,
  lockedFeatureMap,
  listRunningExperiments,
  saveSettingsWith,
  type RunningExperimentSummary,
} from "../services/experiments.server";
import {
  PREVIEWABLE_FEATURE_KEYS,
  armPreview,
  buildPreviewEntryUrl,
  disarmPreview,
  ensurePreviewState,
  featureReadiness,
  getPreviewState,
  rotateToken,
  sanitizeMarketHandle,
  simCartChips,
  type FeatureReadinessExtras,
  type SimCartChip,
} from "../services/preview.server";

/**
 * Preview Center (SPEC v4 §C.3) — the app's centerpiece workflow:
 *   1. pick draft features (with per-feature readiness),
 *   2. choose a preview context (market simulation + product),
 *   3. arm & launch the real-storefront preview,
 *   4. go live per market with an exact, experiment-guarded diff.
 *
 * The raw preview token appears in admin responses ONLY inside the entry URL
 * (its one sanctioned page-facing home) — never as a standalone field.
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

const FEATURE_GROUPS: { title: string; keys: FeatureKey[] }[] = [
  {
    title: "Cart drawer",
    keys: [
      "cart_volume_upsell",
      "free_shipping_bar",
      "cart_subscription_upsell",
      "cart_trust_row",
      "cart_cross_sell",
      "dispatch_countdown",
      "set_savings",
      "gift_tiers",
    ],
  },
  {
    title: "Product page",
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
      "press",
      "derm_endorsements",
      "delivery_estimate",
    ],
  },
  {
    title: "Checkout",
    keys: [
      "checkout_upsell",
      "checkout_protection",
      "checkout_trust",
      "checkout_customs",
      "checkout_tracked",
    ],
  },
  {
    title: "Amazon patterns",
    keys: [
      "az_buy_box",
      "az_microcopy",
      "az_delivery_line",
      "az_stock_line",
      "az_ships_from",
      "az_bought_count",
      "az_bestseller_badge",
      "az_fbt",
      "az_similar_items",
      "az_cart_free_line",
      "az_cta_count",
    ],
  },
];

/**
 * Client-safe ordered key list (all 19). The component must not reference
 * FEATURE_KEYS — that would pull the server-only settings model into the
 * client bundle; the loader asserts the two lists stay in sync.
 */
const ALL_FEATURE_KEYS: FeatureKey[] = FEATURE_GROUPS.flatMap(
  (group) => group.keys,
);

/**
 * Features that CANNOT be previewed: clinical_results renders only through
 * its theme-editor app block, so the preview runtime has no draft template to
 * activate for it. It stays visible in the picker as a disabled row (with an
 * explanation), is stripped from arm payloads and apply diffs defensively,
 * and goes live only via the normal dashboard/Markets flows.
 *
 * Client-safe mirror of the server's PREVIEWABLE_FEATURE_KEYS allow-list
 * (preview.server.ts) — the component must not reference *.server modules,
 * so the exclusion is duplicated here and the loader asserts in dev that the
 * two stay in sync (same pattern as ALL_FEATURE_KEYS vs FEATURE_KEYS).
 */
const UNPREVIEWABLE_FEATURE_KEYS: ReadonlySet<FeatureKey> = new Set<FeatureKey>(
  ["clinical_results"],
);

/**
 * Where a merchant fixes a not-ready feature (client-safe literal map — the
 * component must not touch the server-only FEATURE_KEYS/FEATURE_DEFS). The
 * checkout features are configured on the Checkout features page; the four
 * PDP content widgets need per-product content under Product boosters.
 * Readiness reasons come from the loader (featureReadiness); this map only
 * supplies the destination link per not-ready-capable feature.
 */
/**
 * The four delivery-estimate widget formats with short mechanism labels
 * (client-safe literal mirror of DELIVERY_ESTIMATE_FORMATS in the
 * server-only settings model — same pattern as ALL_FEATURE_KEYS; the
 * arm action validates against the canonical enum via sanitizeDraftConfig).
 */
const DELIVERY_FORMAT_OPTIONS: { label: string; value: string }[] = [
  { label: "One line — “Get it by …” + badge", value: "line" },
  { label: "Date range — “Estimated delivery: … – …”", value: "range" },
  { label: "Timeline — Order → Ships → Delivered", value: "timeline" },
  { label: "Guarantee box — bordered promise card", value: "box" },
];

/**
 * The two az_ships_from display styles with short mechanism labels (v6.10,
 * client-safe literal mirror of SHIPS_FROM_FORMATS in the server-only
 * settings model — same pattern as DELIVERY_FORMAT_OPTIONS; the arm action
 * validates against the canonical enum via sanitizeDraftConfig).
 */
const SHIPS_FORMAT_OPTIONS: { label: string; value: string }[] = [
  { label: "Subtle — quiet microline (current)", value: "subtle" },
  {
    label:
      "Prominent — green local-shipping signal (recommended when fulfillment is local)",
    value: "prominent",
  },
];

const NOT_READY_FIX_LINKS: Partial<
  Record<FeatureKey, { url: string; label: string }>
> = {
  checkout_upsell: {
    url: "/app/features/checkout",
    label: "Configure on the Checkout features page",
  },
  checkout_protection: {
    url: "/app/features/checkout",
    label: "Configure on the Checkout features page",
  },
  checkout_customs: {
    url: "/app/features/checkout",
    label: "Configure on the Checkout features page",
  },
  checkout_tracked: {
    url: "/app/features/checkout",
    label: "Configure on the Checkout features page",
  },
  cart_cross_sell: {
    url: "/app/features/cart",
    label: "Configure on the Cart upsells page",
  },
  dispatch_countdown: {
    url: "/app/features/dispatch",
    label: "Configure on the Dispatch countdown page",
  },
  delivery_estimate: {
    url: "/app/features/delivery",
    label: "Configure on the Delivery guarantee page",
  },
  clinical_study: {
    url: "/app/products",
    label: "Add content under Product boosters",
  },
  // v8: the results gallery's entries live in the proof library, so its
  // not-ready fix points there (the legacy BA metaobjects only feed the
  // one-time import) — same home as the two new proof-library features.
  verified_before_after: {
    url: "/app/proof",
    label: "Add entries under Proof library",
  },
  batch_transparency: {
    url: "/app/products",
    label: "Add content under Product boosters",
  },
  derm_survey: {
    url: "/app/products",
    label: "Add content under Product boosters",
  },
  press: {
    url: "/app/proof",
    label: "Add entries under Proof library",
  },
  derm_endorsements: {
    url: "/app/proof",
    label: "Add entries under Proof library",
  },
  set_savings: {
    url: "/app/features/rewards",
    label: "Configure on the Rewards page",
  },
  gift_tiers: {
    url: "/app/features/rewards",
    label: "Configure on the Rewards page",
  },
};

/**
 * v14 cart simulator (SPEC §10) — client-safe copies of the server bounds
 * (SIM_CART_MAX_* in preview.server.ts; the arm action re-clamps).
 */
const SIM_COUNT_MAX = 20;
const SIM_SPEND_MAX = 1_000_000;

/** v14: one row of the draft set-savings tier table (strings while editing). */
interface SsDraftRow {
  count: string;
  pct: string;
  code: string;
}

/** Parses the editable set-savings rows; invalid rows are dropped (the server sanitizer is authoritative). */
function parseSsRows(rows: SsDraftRow[]): { count: number; pct: number; code: string }[] {
  return rows
    .map((row) => ({
      count: Math.floor(Number(row.count)),
      pct: Number(row.pct),
      code: row.code.trim().toUpperCase(),
    }))
    .filter(
      (row) =>
        Number.isInteger(row.count) && row.count >= 1 && Number.isFinite(row.pct) && row.pct > 0 && row.code !== "",
    );
}

function parseAmounts(values: string[]): number[] {
  return values.map((value) => {
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? amount : 0;
  });
}

function formatMoney(cents: number, currency: string): string {
  const major = cents / 100;
  const text = Number.isInteger(major) ? String(major) : major.toFixed(2);
  return currency ? `${text} ${currency}` : text;
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

interface FeatureRowData {
  key: FeatureKey;
  label: string;
  /** Combined live flag (master AND sub-flag), market scoping ignored. */
  on: boolean;
  scopeMode: "all" | "selected";
  scopeMarkets: string[];
  ready: boolean;
  readinessNote: string | null;
}

interface ProductOption {
  handle: string;
  title: string;
  hasContent: boolean;
}

function marketPhrase(market: string): string {
  return market === "all" ? "all markets" : market;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const featureRaw = url.searchParams.get("feature") ?? "";
  const featureParam = (FEATURE_KEYS as string[]).includes(featureRaw)
    ? (featureRaw as FeatureKey)
    : null;

  const [settings, state, productList, runningExperiments, proofCounts] =
    await Promise.all([
      getSettings(session.shop),
      ensurePreviewState(session.shop),
      listProductsWithBoosterStatus(admin, q),
      listRunningExperiments(session.shop),
      // Proof-library entry counts (press / endorsements / results) are
      // best-effort: on error the readiness for those features degrades to
      // its informational note instead of failing the whole page load.
      getProofCounts(session.shop).catch(() => undefined),
    ]);
  let markets: MarketSummary[] = [];
  let marketErrors: string[] = [];
  try {
    markets = await listMarkets(admin);
  } catch (error) {
    marketErrors = [
      error instanceof Error ? error.message : "Could not load markets.",
    ];
  }

  const products: ProductOption[] = productList.products.map((product) => ({
    handle: product.handle,
    title: product.title,
    hasContent:
      product.boosters.clinical_study ||
      product.boosters.verified_before_after > 0 ||
      product.boosters.batch_transparency ||
      product.boosters.derm_survey,
  }));

  // Content counts back featureReadiness for the per-product content
  // widgets. They come from the SAME single products query as the picker
  // (first 25). While a search narrows the list the counts stop representing
  // the store, so we pass no counts (readiness degrades to "ready with
  // note"), and when the page maxes out at 25 the counts are flagged as
  // partial ("at least N"). The v8 proof-library counts (press /
  // endorsements / results gallery) come from the app database instead and
  // are exact — a product search never invalidates them.
  const searching = q.trim() !== "";
  const countsPartial = products.length >= 25;
  const extras: FeatureReadinessExtras = {
    ...(searching || !productList.ok
      ? {}
      : {
          productsWithContent: {
            clinical: productList.products.filter(
              (p) => p.boosters.clinical_study,
            ).length,
            ba: productList.products.filter(
              (p) => p.boosters.verified_before_after > 0,
            ).length,
            batch: productList.products.filter(
              (p) => p.boosters.batch_transparency,
            ).length,
            survey: productList.products.filter(
              (p) => p.boosters.derm_survey,
            ).length,
          },
        }),
    ...(proofCounts ? { proofCounts } : {}),
  };
  const readiness = featureReadiness(settings, extras);

  const features = Object.fromEntries(
    FEATURE_KEYS.map((key) => {
      const scope = settings.marketScopes[key] ?? {
        mode: "all" as const,
        markets: [],
      };
      return [
        key,
        {
          key,
          label: FEATURE_DEFS[key].label,
          on: resolveFeatureFlag(settings, key),
          scopeMode: scope.mode,
          scopeMarkets: scope.markets,
          ready: readiness[key].ready,
          readinessNote: readiness[key].reason ?? null,
        } satisfies FeatureRowData,
      ];
    }),
  ) as Record<FeatureKey, FeatureRowData>;

  if (process.env.NODE_ENV !== "production") {
    // Keeps the client-safe FEATURE_GROUPS list honest against the canonical
    // FEATURE_KEYS (see ALL_FEATURE_KEYS above).
    const grouped = new Set<string>(ALL_FEATURE_KEYS);
    for (const key of FEATURE_KEYS) {
      if (!grouped.has(key)) {
        console.warn(`Preview Center: "${key}" is missing from FEATURE_GROUPS`);
      }
      // Keeps the client-safe UNPREVIEWABLE_FEATURE_KEYS mirror honest
      // against the server's PREVIEWABLE_FEATURE_KEYS allow-list.
      if (
        PREVIEWABLE_FEATURE_KEYS.has(key) === UNPREVIEWABLE_FEATURE_KEYS.has(key)
      ) {
        console.warn(
          `Preview Center: "${key}" previewability is out of sync with PREVIEWABLE_FEATURE_KEYS`,
        );
      }
    }
  }

  // v14: cart-simulator presets per market (live + ARMED draft config; the
  // client re-arms to refresh them) and the live rewards tiers the draft
  // editors start from. Pure computations — no extra API calls.
  const armedDraftConfig = state.armed ? state.draftConfig : {};
  const chipsByMarket: Record<string, { currency: string; chips: SimCartChip[] }> = {
    "": simCartChips(settings, armedDraftConfig, ""),
  };
  for (const market of markets) {
    chipsByMarket[market.handle] = simCartChips(settings, armedDraftConfig, market.handle);
  }
  const rewardsPreview = {
    liveSsTiers: settings.rewards.setSavings.tiers.map((tier) => ({
      count: tier.count,
      pct: tier.pct,
      code: tier.code,
    })),
    liveGtEur: settings.rewards.giftTiers.tiers.map((tier) => tier.amount),
    gtLabels: settings.rewards.giftTiers.tiers.map((tier) => {
      const first = tier.slots[0]?.[0];
      if (!first) return "(empty tier)";
      return first.kind === "samples" ? `${first.count} samples` : first.handle || "gift";
    }),
    liveGtByMarket: settings.rewards.giftTiers.giftThresholdsByMarket,
    chipsByMarket,
  };

  const defaultProductHandle =
    state.productHandle ??
    products.find((product) => product.hasContent)?.handle ??
    products[0]?.handle ??
    "";

  const featureLocks = lockedFeatureMap(runningExperiments);

  return {
    q,
    featureParam,
    features,
    markets: markets.map((market) => ({
      handle: market.handle,
      name: market.name,
      enabled: market.enabled,
      primary: market.primary,
      currencyCode: market.currencyCode,
    })),
    marketErrors,
    rewardsPreview,
    products,
    productErrors: productList.ok ? [] : productList.errors,
    countsPartial: countsPartial && !searching,
    preview: {
      armed: state.armed,
      // Pre-formatted server-side (fixed UTC format) so SSR and hydration
      // render the identical string — never toLocaleString() in the client.
      armedAtText: state.armedAt ? formatUtcTimestamp(state.armedAt) : null,
      draftFlags: state.draftFlags,
      draftConfig: state.draftConfig,
      simulatedMarket: state.simulatedMarket,
      productHandle: state.productHandle,
    },
    // The formats saved on the Delivery guarantee page — each Select's
    // default, so "preview without touching anything" starts from what is
    // really live. One per surface (v6.0): product page, cart drawer,
    // checkout.
    liveDeliveryFormat: settings.deliveryEstimate.format,
    liveDeliveryFormatCart: settings.deliveryEstimate.formatCart,
    liveDeliveryFormatCheckout: settings.deliveryEstimate.formatCheckout,
    // Same contract for the az_ships_from display style (v6.10).
    liveShipsFromFormat: settings.amazon.shipsFromFormat,
    defaultProductHandle,
    // The one sanctioned page-facing home of the raw token: the entry URL.
    entryUrl: state.armed
      ? buildPreviewEntryUrl(session.shop, state.token, {
          productHandle: state.productHandle,
          market: state.simulatedMarket,
        })
      : null,
    featureLocks: Object.fromEntries(
      Object.entries(featureLocks).map(([key, lock]) => [
        key,
        { experimentName: lock!.experimentName, market: lock!.market },
      ]),
    ) as Partial<
      Record<FeatureKey, { experimentName: string; market: string }>
    >,
    runningExperiments: runningExperiments.map((experiment) => ({
      name: experiment.name,
      market: experiment.market,
    })),
  };
};

interface ActionResult {
  intent: string;
  ok: boolean;
  errors: string[];
  syncErrors: string[];
  applied?: { label: string; market: string }[];
  skipped?: number;
  disarmed?: boolean;
}

function failure(intent: string, errors: string[]): ActionResult {
  return { intent, ok: false, errors, syncErrors: [] };
}

/**
 * The two apply guards, shared by the pre-flight check and the
 * in-transaction re-check (mirrors startExperiment/findStartConflict): never
 * mutate a market — or a feature key — a guarded experiment owns; that would
 * corrupt its baseline and drift detection. "Guarded" covers running AND
 * mid-conclusion ("concluding") experiments: a concluding row's flips are
 * still live until its final status write.
 */
function findApplyConflicts(
  guarded: RunningExperimentSummary[],
  targets: string[],
  draftKeys: FeatureKey[],
): string[] {
  const conflicts: string[] = [];
  for (const target of targets) {
    for (const experiment of guarded) {
      if (
        experiment.market === "all" ||
        target === "all" ||
        experiment.market === target
      ) {
        conflicts.push(
          `Market “${marketPhrase(target)}” is locked by the running experiment “${experiment.name}” (${marketPhrase(experiment.market)}) — conclude it before going live there.`,
        );
      }
    }
  }
  const locks = lockedFeatureMap(guarded);
  for (const key of draftKeys) {
    const lock = locks[key];
    if (lock) {
      conflicts.push(
        `“${FEATURE_DEFS[key].label}” is being flipped by the running experiment “${lock.experimentName}” (${marketPhrase(lock.market)}) — a feature in a running experiment cannot be changed.`,
      );
    }
  }
  return [...new Set(conflicts)];
}

/**
 * v14: writes the armed draft rewards tiers/amounts into the settings object
 * (mutating, inside handleApply's transaction). Returns human labels of what
 * changed ("Set savings tiers", "Gift tier amounts (EUR)", "Gift amounts —
 * <market>"); empty when nothing differs. The draft was sanitized at arm
 * time; saveSettingsWith re-sanitizes the whole blob anyway.
 */
function applyDraftRewards(
  settings: Awaited<ReturnType<typeof getSettingsWith>>,
  draft: Record<string, unknown> | undefined,
  allow: { setSavings: boolean; giftTiers: boolean },
  simulatedMarket: string | null,
): string[] {
  if (!draft) return [];
  const labels: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (allow.setSavings && Array.isArray(draft.setSavingsTiers)) {
    // Set-savings: the draft array replaces the live ladder, but only when
    // it is a full valid ladder (sanitizer keeps only complete rows).
    const tiers = sanitizeSetSavingsTiers(draft.setSavingsTiers);
    if (tiers.length > 0 && !same(tiers, settings.rewards.setSavings.tiers)) {
      settings.rewards.setSavings.tiers = tiers;
      labels.push("Set savings tiers");
    }
  }
  if (allow.giftTiers) {
    if (Array.isArray(draft.giftTiers)) {
      // Gift tiers: only the EUR amount is applied, BY INDEX onto the LIVE
      // tiers — the live slots (product picks) are never replaced by the
      // draft's copy of them.
      const drafted = sanitizeGiftTiers(draft.giftTiers);
      const live = settings.rewards.giftTiers.tiers;
      if (drafted.length === live.length) {
        const merged = live.map((tier, index) => ({
          ...tier,
          amount: drafted[index].amount,
        }));
        if (!same(merged.map((tier) => tier.amount), live.map((tier) => tier.amount))) {
          settings.rewards.giftTiers.tiers = merged;
          labels.push("Gift tier amounts (EUR)");
        }
      }
    }
    if (
      simulatedMarket &&
      typeof draft.giftAmountsByMarket === "object" &&
      draft.giftAmountsByMarket !== null &&
      !Array.isArray(draft.giftAmountsByMarket)
    ) {
      // Per-market: only the drafted (simulated) market's entry may go live;
      // the other markets in the draft record are a snapshot of the saved
      // values at arm time and must not clobber later edits.
      const record = sanitizeGiftThresholdsByMarket(draft.giftAmountsByMarket);
      const live = settings.rewards.giftTiers.giftThresholdsByMarket;
      const entry = record[simulatedMarket];
      if (entry && !same(entry, live[simulatedMarket])) {
        settings.rewards.giftTiers.giftThresholdsByMarket = {
          ...live,
          [simulatedMarket]: entry,
        };
        labels.push(`Gift amounts — ${simulatedMarket}`);
      }
    }
  }
  return labels;
}

async function handleApply(
  shop: string,
  admin: AdminGraphqlClient,
  formData: FormData,
): Promise<ActionResult> {
  const state = await getPreviewState(shop);
  if (!state?.armed) {
    return failure("apply", [
      "Preview is not armed — arm it with the features you want before going live.",
    ]);
  }
  // Unpreviewable keys are stripped at arm time; filter them out of the
  // apply diff again defensively — going live with them happens only via the
  // normal dashboard/Markets flows, never from a preview apply.
  const draftKeys = FEATURE_KEYS.filter(
    (key) =>
      state.draftFlags[key] === true && PREVIEWABLE_FEATURE_KEYS.has(key),
  );
  if (draftKeys.length === 0) {
    return failure("apply", [
      "The armed preview has no draft-enabled features — nothing to apply.",
    ]);
  }

  let requested: string[];
  try {
    const parsed: unknown = JSON.parse(String(formData.get("markets") ?? ""));
    if (!Array.isArray(parsed)) throw new Error("not an array");
    requested = parsed.map(String);
  } catch {
    return failure("apply", ["Invalid market selection payload."]);
  }

  const markets = await listMarkets(admin);
  const allHandles = markets.map((market) => market.handle);
  let targets: string[];
  if (requested.includes("all")) {
    targets = ["all"];
  } else {
    targets = [
      ...new Set(
        requested
          .map((handle) => sanitizeMarketHandle(handle))
          .filter((handle) => handle !== ""),
      ),
    ];
    const unknown = targets.filter((handle) => !allHandles.includes(handle));
    if (unknown.length > 0) {
      return failure("apply", [
        `Unknown market${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
      ]);
    }
  }
  if (targets.length === 0) {
    return failure("apply", ["Pick at least one target market."]);
  }

  // Pre-flight guard: fast-fail on conflicts before opening a transaction.
  // The authoritative re-check runs inside the transaction below.
  const guarded = await listGuardedExperiments(shop);
  const preflightConflicts = findApplyConflicts(guarded, targets, draftKeys);
  if (preflightConflicts.length > 0) {
    return failure("apply", preflightConflicts);
  }

  // Exact diff + persist, atomically (mirrors startExperiment's pattern):
  // guard re-check, settings re-read, the applyFlipForMarket loop (the ONE
  // sanctioned mutation path for market-scoped flags) and the settings save
  // are a single transaction, so a racing experiment start — or a second
  // apply — can never interleave between the guard check and the write. The
  // storefront metafield mirror runs after the commit (network call).
  let raceConflicts: string[] | null = null;
  const committed = await prisma.$transaction(async (tx) => {
    const stillGuarded = await listGuardedExperiments(shop, tx);
    const conflicts = findApplyConflicts(stillGuarded, targets, draftKeys);
    if (conflicts.length > 0) {
      raceConflicts = conflicts;
      return null;
    }
    const settings = await getSettingsWith(tx, shop);
    const changes: { key: FeatureKey; market: string }[] = [];
    // v14: draft rewards tiers/amounts go live in the SAME transaction as
    // the flag flips (SPEC §10) — only for the feature whose draft flag is
    // armed, so a set-savings-only preview never rewrites gift amounts.
    const tierChanges = applyDraftRewards(settings, state.draftConfig.rewards, {
      setSavings: draftKeys.includes("set_savings"),
      giftTiers: draftKeys.includes("gift_tiers"),
    }, state.simulatedMarket);
    for (const key of draftKeys) {
      for (const target of targets) {
        const scope = settings.marketScopes[key] ?? {
          mode: "all" as const,
          markets: [],
        };
        const already =
          target === "all"
            ? resolveFeatureFlag(settings, key) && scope.mode === "all"
            : isFeatureOnForMarket(settings, key, target);
        if (already) continue;
        applyFlipForMarket(settings, key, target, true, allHandles);
        changes.push({ key, market: target });
      }
    }
    if (changes.length === 0 && tierChanges.length === 0) {
      // Nothing to write — commit an empty result rather than rolling back.
      return { changes, tierChanges, saved: null };
    }
    const saved = await saveSettingsWith(tx, shop, settings);
    return { changes, tierChanges, saved };
  });
  if (!committed) {
    return failure(
      "apply",
      raceConflicts ?? [
        "Another change landed at the same time — review the running experiments and try again.",
      ],
    );
  }
  const changes = committed.changes;
  const tierChanges = committed.tierChanges;

  const syncErrors: string[] = [];
  if (committed.saved) {
    try {
      const sync = await syncSettingsToMetafields(admin, committed.saved);
      syncErrors.push(...sync.errors);
    } catch (error) {
      syncErrors.push(
        error instanceof Error
          ? error.message
          : "Could not sync settings to storefront metafields.",
      );
    }
  }

  let disarmed = false;
  if (
    formData.get("disarmAfter") === "1" &&
    (changes.length > 0 || tierChanges.length > 0)
  ) {
    try {
      const result = await disarmPreview(shop, admin);
      syncErrors.push(...result.sync.errors);
      disarmed = true;
    } catch (error) {
      syncErrors.push(
        error instanceof Error
          ? error.message
          : "Applied, but the preview could not be disarmed.",
      );
    }
  }

  const marketName = (handle: string): string =>
    handle === "all"
      ? "all markets"
      : (markets.find((market) => market.handle === handle)?.name ?? handle);

  return {
    intent: "apply",
    ok: true,
    errors: [],
    syncErrors: [...new Set(syncErrors)],
    applied: [
      ...changes.map((change) => ({
        label: FEATURE_DEFS[change.key].label,
        market: marketName(change.market),
      })),
      ...tierChanges.map((label) => ({ label, market: "all markets" })),
    ],
    skipped: draftKeys.length * targets.length - changes.length,
    disarmed,
  };
}

/**
 * v14: turns the Preview Center's compact rewards draft payload into the
 * PreviewDraftConfig.rewards shape (SPEC §10). Payload (JSON):
 *   { setSavingsTiers?: {count,pct,code}[], giftEurAmounts?: number[],
 *     giftMarketAmounts?: {market, amounts:number[], currencyCode} }
 * Gift tiers keep the SAVED slots — only the EUR amount changes; a market
 * record replaces/creates that market's entry on top of the saved record
 * (other markets untouched). Returns null when nothing is drafted.
 */
async function buildRewardsDraft(
  shop: string,
  raw: string,
): Promise<Record<string, unknown> | null> {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const payload = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (Array.isArray(payload.setSavingsTiers)) {
    out.setSavingsTiers = sanitizeSetSavingsTiers(payload.setSavingsTiers);
  }
  const needsSettings =
    Array.isArray(payload.giftEurAmounts) ||
    (typeof payload.giftMarketAmounts === "object" && payload.giftMarketAmounts !== null);
  if (needsSettings) {
    const settings = await getSettings(shop);
    const liveTiers = settings.rewards.giftTiers.tiers;
    if (Array.isArray(payload.giftEurAmounts)) {
      const amounts = payload.giftEurAmounts.map((value) => Number(value));
      const drafted: GiftTier[] = liveTiers.map((tier, index) => ({
        amount:
          Number.isFinite(amounts[index]) && amounts[index] > 0 ? amounts[index] : tier.amount,
        slots: tier.slots.map((slot) => slot.map((option) => ({ ...option }))),
      }));
      out.giftTiers = sanitizeGiftTiers(drafted);
    }
    const marketAmounts = payload.giftMarketAmounts;
    if (
      typeof marketAmounts === "object" &&
      marketAmounts !== null &&
      !Array.isArray(marketAmounts)
    ) {
      const entry = marketAmounts as Record<string, unknown>;
      const market = sanitizeMarketHandle(entry.market);
      // All-or-nothing: the market column is accepted only when it has one
      // finite amount > 0 per live tier; anything partial is dropped.
      const marketAmounts_ = Array.isArray(entry.amounts)
        ? entry.amounts.map((value) => Number(value))
        : null;
      const marketComplete =
        marketAmounts_ !== null &&
        marketAmounts_.length === liveTiers.length &&
        marketAmounts_.every((amount) => Number.isFinite(amount) && amount > 0);
      if (market && marketAmounts_ && marketComplete) {
        const record = {
          ...settings.rewards.giftTiers.giftThresholdsByMarket,
          [market]: {
            amounts: marketAmounts_,
            currencyCode: String(entry.currencyCode ?? ""),
          },
        };
        out.giftAmountsByMarket = sanitizeGiftThresholdsByMarket(record);
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "arm") {
      let draftFlags: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(
          String(formData.get("draftFlags") ?? ""),
        );
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        draftFlags = parsed as Record<string, unknown>;
      } catch {
        return failure("arm", ["Invalid draft feature payload."]);
      }
      // Unpreviewable features (no draft runtime) must never be armed —
      // strip them even from hand-crafted payloads.
      for (const key of FEATURE_KEYS) {
        if (!PREVIEWABLE_FEATURE_KEYS.has(key)) {
          delete draftFlags[key];
        }
      }
      // Draft config overrides (the three per-surface delivery-estimate
      // formats + the ships-from style). Malformed payloads degrade to {} —
      // armPreview's sanitizeDraftConfig is the authoritative enum
      // validation.
      let draftConfig: unknown = {};
      try {
        draftConfig = JSON.parse(String(formData.get("draftConfig") ?? "{}"));
      } catch {
        draftConfig = {};
      }
      // v14 draft rewards tiers: the client sends only what it edited
      // (set-savings rows, gift EUR amounts, one market's amounts); the
      // full GiftTier objects (slots included) are rebuilt here from the
      // saved settings so the draft never carries hand-crafted slots.
      // armPreview's sanitizeDraftConfig re-sanitizes everything.
      const rewardsDraft = await buildRewardsDraft(
        session.shop,
        String(formData.get("rewardsDraft") ?? ""),
      );
      if (rewardsDraft) {
        const base =
          typeof draftConfig === "object" && draftConfig !== null && !Array.isArray(draftConfig)
            ? (draftConfig as Record<string, unknown>)
            : {};
        draftConfig = { ...base, rewards: rewardsDraft };
      }
      const { sync } = await armPreview(session.shop, admin, {
        draftFlags,
        draftConfig,
        simulatedMarket: String(formData.get("simulatedMarket") ?? ""),
        productHandle: String(formData.get("productHandle") ?? ""),
      });
      return {
        intent: "arm",
        ok: true,
        errors: [],
        syncErrors: sync.errors,
      } satisfies ActionResult;
    }

    if (intent === "disarm") {
      const { sync } = await disarmPreview(session.shop, admin);
      return {
        intent: "disarm",
        ok: true,
        errors: [],
        syncErrors: sync.errors,
      } satisfies ActionResult;
    }

    if (intent === "rotate") {
      const { sync } = await rotateToken(session.shop, admin);
      return {
        intent: "rotate",
        ok: true,
        errors: [],
        syncErrors: sync?.errors ?? [],
      } satisfies ActionResult;
    }

    if (intent === "apply") {
      return await handleApply(session.shop, admin, formData);
    }
  } catch (error) {
    return failure(intent || "unknown", [
      error instanceof Error ? error.message : "The action failed unexpectedly.",
    ]);
  }

  return failure(intent || "unknown", ["Unknown action."]);
};

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

function reachCaption(feature: FeatureRowData): string {
  if (!feature.on) return "Currently off everywhere";
  if (feature.scopeMode === "all") return "Currently live in all markets";
  if (feature.scopeMarkets.length === 0) {
    return "Currently live nowhere (no market selected)";
  }
  return feature.scopeMarkets.length === 1
    ? `Currently live in 1 market (${feature.scopeMarkets[0]})`
    : `Currently live in ${feature.scopeMarkets.length} markets`;
}

function isLiveInMarket(feature: FeatureRowData, target: string): boolean {
  if (!feature.on) return false;
  if (target === "all") return feature.scopeMode === "all";
  return (
    feature.scopeMode === "all" || feature.scopeMarkets.includes(target)
  );
}

export default function PreviewCenter() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [, setSearchParams] = useSearchParams();

  const {
    q,
    featureParam,
    features,
    markets,
    marketErrors,
    products,
    productErrors,
    countsPartial,
    preview,
    defaultProductHandle,
    entryUrl,
    featureLocks,
    runningExperiments,
    liveDeliveryFormat,
    liveDeliveryFormatCart,
    liveDeliveryFormatCheckout,
    liveShipsFromFormat,
    rewardsPreview,
  } = data;

  // v5.4 safety net: a FeatureKey missing from the FEATURE_GROUPS literal
  // can never disappear from the picker — anything the loader knows about
  // but no group lists renders in an automatic trailing group. The
  // validation harness ALSO fails when the literal drifts from
  // FEATURE_KEYS, so in practice this group never appears; it exists so a
  // future omission degrades to "oddly grouped" instead of "unpickable".
  const groupedPickerKeys = new Set<string>(
    FEATURE_GROUPS.flatMap((group) => group.keys),
  );
  const ungroupedPickerKeys = (Object.keys(features) as FeatureKey[]).filter(
    (key) => !groupedPickerKeys.has(key),
  );
  const pickerGroups =
    ungroupedPickerKeys.length > 0
      ? [
          ...FEATURE_GROUPS,
          { title: "Other boosters", keys: ungroupedPickerKeys },
        ]
      : FEATURE_GROUPS;

  // Canonical key list for every derived selection below. ALL_FEATURE_KEYS
  // provides ordering only — a key that exists solely in the fallback
  // "Other boosters" group must still flow into checkedKeys / draftKeys /
  // arm payloads, otherwise the fallback renders a checkbox whose selection
  // is silently dropped at submit time (worse than unpickable).
  const orderedFeatureKeys: FeatureKey[] =
    ungroupedPickerKeys.length > 0
      ? [...ALL_FEATURE_KEYS, ...ungroupedPickerKeys]
      : ALL_FEATURE_KEYS;

  // --- 1. Feature picker state -------------------------------------------
  const initialChecked = useMemo(() => {
    const set = new Set<FeatureKey>(
      orderedFeatureKeys.filter(
        (key) =>
          preview.draftFlags[key] === true &&
          !UNPREVIEWABLE_FEATURE_KEYS.has(key),
      ),
    );
    if (featureParam && !UNPREVIEWABLE_FEATURE_KEYS.has(featureParam)) {
      set.add(featureParam);
    }
    return set;
    // Intentionally initial-only: user edits own this state afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [checked, setChecked] = useState<Set<FeatureKey>>(initialChecked);

  // --- 2. Context state ----------------------------------------------------
  const [simulatedMarket, setSimulatedMarket] = useState(
    preview.simulatedMarket ?? "",
  );
  const [productHandle, setProductHandle] = useState(defaultProductHandle);
  const [query, setQuery] = useState(q);
  // Delivery-estimate widget formats for the preview session — one per
  // surface (v6.0): each starts from the armed draft (when re-arming) or
  // the saved live format of ITS surface.
  const [deliveryFormat, setDeliveryFormat] = useState<string>(
    preview.draftConfig?.deliveryFormat ?? liveDeliveryFormat,
  );
  const [deliveryFormatCart, setDeliveryFormatCart] = useState<string>(
    preview.draftConfig?.deliveryFormatCart ?? liveDeliveryFormatCart,
  );
  const [deliveryFormatCheckout, setDeliveryFormatCheckout] = useState<string>(
    preview.draftConfig?.deliveryFormatCheckout ?? liveDeliveryFormatCheckout,
  );
  // az_ships_from display style for the preview session (v6.10) — same
  // contract: starts from the armed draft or the saved live style.
  const [shipsFromFormat, setShipsFromFormat] = useState<string>(
    preview.draftConfig?.shipsFromFormat ?? liveShipsFromFormat,
  );
  // --- v14 cart simulator + rehearsal + draft tiers (SPEC §10) -----------
  // Each starts from the armed draft (when re-arming) or the live settings.
  const armedSim = preview.draftConfig?.simCart ?? null;
  const [simEnabled, setSimEnabled] = useState<boolean>(armedSim !== null);
  const [simSpend, setSimSpend] = useState<string>(
    armedSim ? String(armedSim.spendCents / 100) : "",
  );
  const [simCount, setSimCount] = useState<number>(armedSim ? armedSim.count : 1);
  const [rehearsal, setRehearsal] = useState<boolean>(
    preview.draftConfig?.rehearsal === true,
  );
  const armedRewards = preview.draftConfig?.rewards;
  const [ssRows, setSsRows] = useState<SsDraftRow[]>(() =>
    (armedRewards?.setSavingsTiers ?? rewardsPreview.liveSsTiers).map((tier) => ({
      count: String(tier.count),
      pct: String(tier.pct),
      code: tier.code,
    })),
  );
  const [gtEur, setGtEur] = useState<string[]>(() =>
    (armedRewards?.giftTiers
      ? armedRewards.giftTiers.map((tier) => tier.amount)
      : rewardsPreview.liveGtEur
    ).map((amount) => String(amount)),
  );
  // Per-market gift amounts for the SIMULATED market only (one row set;
  // switching the market reloads the row from the armed draft / live record).
  const marketGiftRecord = (market: string) =>
    (armedRewards?.giftAmountsByMarket?.[market] ??
      rewardsPreview.liveGtByMarket[market]) ?? null;
  const [gtMarket, setGtMarket] = useState<string[]>(() => {
    const record = marketGiftRecord(preview.simulatedMarket ?? "");
    return rewardsPreview.liveGtEur.map((_, index) =>
      record && Number.isFinite(record.amounts[index]) ? String(record.amounts[index]) : "",
    );
  });
  useEffect(() => {
    const record = marketGiftRecord(simulatedMarket);
    setGtMarket(
      rewardsPreview.liveGtEur.map((_, index) =>
        record && Number.isFinite(record.amounts[index]) ? String(record.amounts[index]) : "",
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulatedMarket]);
  const simulatedMarketInfo = markets.find((market) => market.handle === simulatedMarket);
  const marketCurrency =
    marketGiftRecord(simulatedMarket)?.currencyCode ||
    simulatedMarketInfo?.currencyCode ||
    "EUR";
  const simChips = rewardsPreview.chipsByMarket[simulatedMarket] ??
    rewardsPreview.chipsByMarket[""] ?? { currency: "EUR", chips: [] };

  // Debounced product search — reloads the loader with ?q= (same pattern as
  // the Product boosters page).
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === q.trim()) return;
    const handle = setTimeout(() => {
      const params: Record<string, string> = {};
      if (trimmed !== "") params.q = trimmed;
      if (featureParam) params.feature = featureParam;
      setSearchParams(params, { replace: true, preventScrollReset: true });
    }, 350);
    return () => clearTimeout(handle);
  }, [query, q, featureParam, setSearchParams]);

  // --- 3. Go-live state ----------------------------------------------------
  const [targetAll, setTargetAll] = useState(false);
  const [targetMarkets, setTargetMarkets] = useState<Set<string>>(new Set());
  const [disarmAfter, setDisarmAfter] = useState(true);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  const pendingIntent =
    navigation.state !== "idle" && navigation.formData
      ? String(navigation.formData.get("intent") ?? "")
      : "";
  const searchingProducts =
    navigation.state === "loading" && pendingIntent === "";

  useEffect(() => {
    if (!actionData) return;
    setConfirmingRotate(false);
    if (!actionData.ok) {
      shopify.toast.show(
        actionData.errors[0] ?? "The action failed",
        { isError: true },
      );
      return;
    }
    if (actionData.syncErrors.length > 0) {
      shopify.toast.show("Saved, but the storefront sync reported errors", {
        isError: true,
      });
      return;
    }
    if (actionData.intent === "arm") shopify.toast.show("Preview armed");
    if (actionData.intent === "disarm") shopify.toast.show("Preview disarmed");
    if (actionData.intent === "rotate") {
      shopify.toast.show("Token rotated — previous preview links are dead");
    }
    if (actionData.intent === "apply") {
      shopify.toast.show(
        actionData.applied && actionData.applied.length > 0
          ? "Features are now live"
          : "Nothing to change — already live",
      );
    }
  }, [actionData, shopify]);

  // --- Derived data ---------------------------------------------------------
  // Unpreviewable keys are filtered everywhere: they cannot be checked, are
  // never armed, and never appear in a go-live diff from this page.
  const checkedKeys = orderedFeatureKeys.filter(
    (key) => checked.has(key) && !UNPREVIEWABLE_FEATURE_KEYS.has(key),
  );
  const draftKeys = orderedFeatureKeys.filter(
    (key) =>
      preview.draftFlags[key] === true && !UNPREVIEWABLE_FEATURE_KEYS.has(key),
  );
  const selectionMatchesArmed =
    preview.armed &&
    draftKeys.length === checkedKeys.length &&
    draftKeys.every((key) => checked.has(key));

  // Draft-flagged features that are not ready render NOTHING in a preview
  // session (e.g. a checkout upsell with no variants selected) — the classic
  // "checkout preview looks broken" trap. Union of the armed draft flags and
  // the current selection, so the warning covers both the launch buttons
  // (armed drafts) and what "Arm/Update preview" is about to flag.
  const notReadyPreviewKeys = orderedFeatureKeys.filter(
    (key) =>
      (checked.has(key) || preview.draftFlags[key] === true) &&
      !UNPREVIEWABLE_FEATURE_KEYS.has(key) &&
      !features[key].ready,
  );

  const marketLockedBy = (handle: string): string[] =>
    runningExperiments
      .filter(
        (experiment) =>
          experiment.market === "all" ||
          handle === "all" ||
          experiment.market === handle,
      )
      .map(
        (experiment) =>
          `${experiment.name} (${marketPhrase(experiment.market)})`,
      );

  const selectedTargets: string[] = targetAll
    ? ["all"]
    : markets
        .filter((market) => targetMarkets.has(market.handle))
        .map((market) => market.handle);

  const lockedDraftKeys = draftKeys.filter((key) => featureLocks[key]);

  const diff = useMemo(() => {
    const changes: { key: FeatureKey; label: string; market: string }[] = [];
    let alreadyLive = 0;
    for (const key of draftKeys) {
      for (const target of selectedTargets) {
        if (isLiveInMarket(features[key], target)) {
          alreadyLive += 1;
        } else {
          changes.push({
            key,
            label: features[key].label,
            market:
              target === "all"
                ? "all markets"
                : (markets.find((m) => m.handle === target)?.name ?? target),
          });
        }
      }
    }
    return { changes, alreadyLive };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKeys.join("|"), selectedTargets.join("|"), features, markets]);

  const selectedLocked = selectedTargets.some(
    (target) => marketLockedBy(target).length > 0,
  );

  const canApply =
    preview.armed &&
    draftKeys.length > 0 &&
    selectedTargets.length > 0 &&
    !selectedLocked &&
    lockedDraftKeys.length === 0 &&
    diff.changes.length > 0;

  // --- Submitters -----------------------------------------------------------
  const submitArm = () => {
    const formData = new FormData();
    formData.set("intent", "arm");
    formData.set(
      "draftFlags",
      JSON.stringify(Object.fromEntries(checkedKeys.map((key) => [key, true]))),
    );
    const rewardsChecked = checked.has("set_savings") || checked.has("gift_tiers");
    const spendNumber = Number(simSpend);
    formData.set(
      "draftConfig",
      JSON.stringify({
        ...(checked.has("delivery_estimate")
          ? { deliveryFormat, deliveryFormatCart, deliveryFormatCheckout }
          : {}),
        ...(checked.has("az_ships_from") ? { shipsFromFormat } : {}),
        // v14: simulator + rehearsal ride along only while a rewards feature
        // is checked (an unchecked feature leaves no stale simulator behind).
        ...(rewardsChecked && simEnabled && Number.isFinite(spendNumber)
          ? {
              simCart: {
                spendCents: Math.round(Math.max(0, spendNumber) * 100),
                count: simCount,
              },
            }
          : {}),
        ...(rewardsChecked && rehearsal ? { rehearsal: true } : {}),
      }),
    );
    // v14 draft tiers: only what differs from the live values is sent.
    if (rewardsChecked) {
      const draft: Record<string, unknown> = {};
      if (checked.has("set_savings")) {
        const rows = parseSsRows(ssRows);
        if (JSON.stringify(rows) !== JSON.stringify(rewardsPreview.liveSsTiers)) {
          draft.setSavingsTiers = rows;
        }
      }
      if (checked.has("gift_tiers")) {
        const eur = parseAmounts(gtEur);
        if (JSON.stringify(eur) !== JSON.stringify(rewardsPreview.liveGtEur)) {
          draft.giftEurAmounts = eur;
        }
        // The per-market column is all-or-nothing: every tier cell must hold
        // a finite amount > 0, or the whole column stays blank (untouched).
        const marketFilled = gtMarket.filter((value) => value.trim() !== "").length;
        if (simulatedMarket && marketFilled > 0) {
          const complete =
            marketFilled === gtMarket.length &&
            gtMarket.every((value) => {
              const amount = Number(value);
              return Number.isFinite(amount) && amount > 0;
            });
          if (!complete) {
            shopify.toast.show("Fill every market amount or leave the column blank", {
              isError: true,
            });
            return;
          }
          const amounts = parseAmounts(gtMarket);
          const live = rewardsPreview.liveGtByMarket[simulatedMarket];
          if (
            !live ||
            live.currencyCode !== marketCurrency ||
            JSON.stringify(live.amounts) !== JSON.stringify(amounts)
          ) {
            draft.giftMarketAmounts = {
              market: simulatedMarket,
              amounts,
              currencyCode: marketCurrency,
            };
          }
        }
      }
      if (Object.keys(draft).length > 0) {
        formData.set("rewardsDraft", JSON.stringify(draft));
      }
    }
    formData.set("simulatedMarket", simulatedMarket);
    formData.set("productHandle", productHandle);
    submit(formData, { method: "post" });
  };

  const submitSimple = (intent: "disarm" | "rotate") => {
    const formData = new FormData();
    formData.set("intent", intent);
    submit(formData, { method: "post" });
  };

  const submitApply = () => {
    const formData = new FormData();
    formData.set("intent", "apply");
    formData.set("markets", JSON.stringify(selectedTargets));
    formData.set("disarmAfter", disarmAfter ? "1" : "0");
    submit(formData, { method: "post" });
  };

  const copyEntryUrl = async () => {
    if (!entryUrl) return;
    try {
      await navigator.clipboard.writeText(entryUrl);
      shopify.toast.show("Preview link copied");
    } catch {
      shopify.toast.show("Copy failed — select the link text and copy manually", {
        isError: true,
      });
    }
  };

  const marketOptions = [
    { label: "Current / default (no market simulation)", value: "" },
    ...markets.map((market) => ({
      label: `${market.name}${market.primary ? " · primary" : ""}`,
      value: market.handle,
    })),
  ];

  // Pre-formatted UTC string from the loader, rendered verbatim — formatting
  // it here with toLocaleString() would cause a hydration mismatch.
  const armedAtText = preview.armedAtText;

  // ---------------------------------------------------------------------------

  return (
    <Page
      title="Preview Center"
      subtitle="See draft features on the real storefront — invisible to visitors"
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <TitleBar title="Preview Center" />
      <Layout>
        {preview.armed ? (
          <Layout.Section>
            <Banner tone="info" title="Preview is armed">
              <BlockStack gap="200">
                <Text as="p">
                  Armed{armedAtText ? ` since ${armedAtText}` : ""} with{" "}
                  {draftKeys.length} draft feature
                  {draftKeys.length === 1 ? "" : "s"}. Only browsers that open
                  your preview link see the drafts — real visitors receive
                  inert hidden templates and no behavioral change.
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  There is no automatic disarm — remember to disarm when you
                  are done (Setup &amp; health flags previews armed for more
                  than 48 hours).
                </Text>
                <InlineStack gap="200">
                  <Button
                    onClick={() => submitSimple("disarm")}
                    loading={pendingIntent === "disarm"}
                  >
                    Disarm preview
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {actionData && !actionData.ok && actionData.errors.length > 0 ? (
          <Layout.Section>
            <Banner tone="critical" title="The action was refused">
              <BlockStack gap="100">
                {actionData.errors.map((error) => (
                  <Text as="p" key={error}>
                    {error}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {actionData && actionData.ok && actionData.syncErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone="warning"
              title="Saved, but the storefront sync reported errors"
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

        {actionData?.intent === "apply" && actionData.ok ? (
          <Layout.Section>
            <Banner
              tone="success"
              title={
                actionData.applied && actionData.applied.length > 0
                  ? `Applied ${actionData.applied.length} change${actionData.applied.length === 1 ? "" : "s"}${actionData.disarmed ? " — preview disarmed" : ""}`
                  : "Nothing to change — everything selected was already live"
              }
            >
              <BlockStack gap="100">
                {(actionData.applied ?? []).map((change) => (
                  <Text as="p" key={`${change.label}-${change.market}`}>
                    {change.label} → live in {change.market}
                  </Text>
                ))}
                {actionData.skipped && actionData.skipped > 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    {actionData.skipped} feature/market pair
                    {actionData.skipped === 1 ? " was" : "s were"} already live
                    and skipped.
                  </Text>
                ) : null}
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {productErrors.length > 0 || marketErrors.length > 0 ? (
          <Layout.Section>
            <Banner tone="warning" title="Some data could not be loaded">
              <BlockStack gap="100">
                {[...productErrors, ...marketErrors].map((error) => (
                  <Text as="p" key={error}>
                    {error}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {/* 1 — Feature picker */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  1 · Pick features to preview
                </Text>
                <Text as="p" tone="subdued">
                  Checked features render as drafts in your preview session —
                  on top of whatever is already live. Not-ready features can
                  still be previewed, but may render empty.
                </Text>
              </BlockStack>
              {pickerGroups.map((group) => (
                <BlockStack key={group.title} gap="300">
                  <Divider />
                  <Text as="h3" variant="headingSm">
                    {group.title}
                  </Text>
                  {group.keys.map((key) => {
                    const feature = features[key];
                    const lock = featureLocks[key];
                    if (UNPREVIEWABLE_FEATURE_KEYS.has(key)) {
                      // No draft runtime exists for this feature (it renders
                      // only via its theme-editor app block) — list it for
                      // discoverability, but keep it un-checkable.
                      return (
                        <BlockStack key={key} gap="050">
                          <Checkbox
                            label={feature.label}
                            checked={false}
                            disabled
                          />
                          <Box paddingInlineStart="600">
                            <BlockStack gap="050">
                              <Text as="p" tone="subdued" variant="bodySm">
                                {reachCaption(feature)}
                              </Text>
                              <Text as="p" tone="subdued" variant="bodySm">
                                Can’t be previewed: this widget renders only
                                through its theme-editor app block, so there
                                is no draft version to show in a preview
                                session. Configure it on its feature page and
                                go live from the dashboard or the Markets
                                page instead.
                              </Text>
                            </BlockStack>
                          </Box>
                        </BlockStack>
                      );
                    }
                    return (
                      <BlockStack key={key} gap="050">
                        <Checkbox
                          label={feature.label}
                          checked={checked.has(key)}
                          onChange={(value) => {
                            setChecked((previous) => {
                              const next = new Set(previous);
                              if (value) next.add(key);
                              else next.delete(key);
                              return next;
                            });
                          }}
                        />
                        <Box paddingInlineStart="600">
                          <BlockStack gap="050">
                            <Text as="p" tone="subdued" variant="bodySm">
                              {reachCaption(feature)}
                            </Text>
                            {feature.readinessNote ? (
                              <Text
                                as="p"
                                tone={feature.ready ? "subdued" : "caution"}
                                variant="bodySm"
                              >
                                {feature.ready ? "" : "Not ready: "}
                                {feature.readinessNote}
                                {!feature.ready
                                  ? " You can still preview it, but it may render nothing."
                                  : ""}
                              </Text>
                            ) : null}
                            {lock ? (
                              <Text as="p" tone="caution" variant="bodySm">
                                In experiment: “{lock.experimentName}” (
                                {marketPhrase(lock.market)}) — previewing is
                                fine, but Go live will refuse this feature
                                until the experiment concludes.
                              </Text>
                            ) : null}
                          </BlockStack>
                        </Box>
                      </BlockStack>
                    );
                  })}
                </BlockStack>
              ))}
              {countsPartial ? (
                <Text as="p" tone="subdued" variant="bodySm">
                  Content counts are based on the first 25 products — treat
                  them as “at least”.
                </Text>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* 2 — Context */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  2 · Preview context
                </Text>
                <Text as="p" tone="subdued">
                  Simulate a market (affects which live features show alongside
                  your drafts) and pick the product page to preview on.
                </Text>
              </BlockStack>
              <Select
                label="Simulated market"
                options={marketOptions}
                value={simulatedMarket}
                onChange={setSimulatedMarket}
                helpText="“Current / default” previews with no market simulation: features scoped to selected markets only will not show as live."
              />
              {checked.has("delivery_estimate") ? (
                <BlockStack gap="100">
                  <InlineStack gap="300" wrap>
                    <Box minWidth="220px">
                      <Select
                        label="Delivery format — product page"
                        options={DELIVERY_FORMAT_OPTIONS}
                        value={deliveryFormat}
                        onChange={setDeliveryFormat}
                      />
                    </Box>
                    <Box minWidth="220px">
                      <Select
                        label="Delivery format — cart drawer"
                        options={DELIVERY_FORMAT_OPTIONS}
                        value={deliveryFormatCart}
                        onChange={setDeliveryFormatCart}
                      />
                    </Box>
                    <Box minWidth="220px">
                      <Select
                        label="Delivery format — checkout"
                        options={DELIVERY_FORMAT_OPTIONS}
                        value={deliveryFormatCheckout}
                        onChange={setDeliveryFormatCheckout}
                      />
                    </Box>
                  </InlineStack>
                  <Text as="p" tone="subdued" variant="bodySm">
                    How the delivery estimate + guarantee widget presents the
                    same dates on each surface in this preview session.
                    Previewing a format never changes your live site — real
                    visitors keep seeing the saved formats. To adopt a format,
                    save it on the{" "}
                    <Link url="/app/features/delivery">
                      Delivery guarantee page
                    </Link>
                    .
                  </Text>
                </BlockStack>
              ) : null}
              {checked.has("az_ships_from") ? (
                <BlockStack gap="100">
                  <Select
                    label="Ships-from style"
                    options={SHIPS_FORMAT_OPTIONS}
                    value={shipsFromFormat}
                    onChange={setShipsFromFormat}
                    helpText="How the “Ships from {country}” line presents itself in this preview session — the quiet gray microline or the prominent green local-shipping signal with the country in bold."
                  />
                  <Text as="p" tone="subdued" variant="bodySm">
                    Previewing a style never changes your live site — real
                    visitors keep seeing the saved style. To adopt a style,
                    save it on the{" "}
                    <Link url="/app/features/amazon">Amazon patterns page</Link>
                    .
                  </Text>
                </BlockStack>
              ) : null}
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  <Box width="100%">
                    <TextField
                      label="Preview product"
                      labelHidden={false}
                      placeholder="Search products by title"
                      value={query}
                      onChange={setQuery}
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={() => setQuery("")}
                    />
                  </Box>
                  {searchingProducts ? (
                    <Spinner
                      size="small"
                      accessibilityLabel="Searching products"
                    />
                  ) : null}
                </InlineStack>
                {products.length === 0 ? (
                  <Text as="p" tone="subdued">
                    {q.trim() === ""
                      ? "No products found in this store."
                      : `No products matched “${q.trim()}”.`}
                  </Text>
                ) : (
                  <BlockStack gap="100">
                    {products.map((product) => (
                      <InlineStack
                        key={product.handle}
                        gap="200"
                        blockAlign="center"
                      >
                        <RadioButton
                          label={product.title}
                          checked={productHandle === product.handle}
                          id={`preview-product-${product.handle}`}
                          name="previewProduct"
                          onChange={() => setProductHandle(product.handle)}
                        />
                        {product.hasContent ? (
                          <Badge tone="info">Has booster content</Badge>
                        ) : null}
                      </InlineStack>
                    ))}
                    <Text as="p" tone="subdued" variant="bodySm">
                      Showing the first 25 products by title — search to
                      narrow down. Products with booster content make the best
                      preview targets.
                    </Text>
                    {productHandle &&
                    !products.some((p) => p.handle === productHandle) ? (
                      <Text as="p" tone="subdued" variant="bodySm">
                        Currently selected: “{productHandle}” (not in the list
                        above — clear the search to see it, or pick another).
                      </Text>
                    ) : null}
                  </BlockStack>
                )}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>


        {/* 2b — v14 cart simulator, rehearsal and draft tiers (SPEC §10) */}
        {checked.has("set_savings") || checked.has("gift_tiers") ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Simulate cart
                  </Text>
                  <Text as="p" tone="subdued">
                    Walk the reward tiers without touching a real cart: while
                    the simulator is on, the storefront preview draws the
                    meter, nudges, captions and set maths from these values
                    and never adds a gift line or a KIT code. The storefront
                    preview bar has the same controls (they override these for
                    that browser tab).
                  </Text>
                </BlockStack>
                <Checkbox
                  label="Simulate a cart total and product count"
                  checked={simEnabled}
                  onChange={setSimEnabled}
                  helpText={
                    simulatedMarket
                      ? `Enter the spend in ${marketCurrency} — the currency the ${simulatedMarketInfo?.name ?? simulatedMarket} market shows. Open the preview link on that market's storefront URL so the cart is priced in that currency.`
                      : "No market simulated — enter the spend in your shop currency (EUR) and preview on the default storefront."
                  }
                />
                {simEnabled ? (
                  <BlockStack gap="300">
                    <InlineStack gap="300" wrap blockAlign="end">
                      <Box minWidth="220px">
                        <TextField
                          label={`Cart spend (${marketCurrency})`}
                          type="number"
                          min={0}
                          max={SIM_SPEND_MAX}
                          step={1}
                          value={simSpend}
                          onChange={setSimSpend}
                          autoComplete="off"
                          helpText="Sum of the products' prices before discounts (gift lines and order protection never count)."
                        />
                      </Box>
                      <Box minWidth="180px">
                        <TextField
                          label="Different products in cart"
                          type="number"
                          min={0}
                          max={SIM_COUNT_MAX}
                          step={1}
                          value={String(simCount)}
                          onChange={(value) => {
                            const next = Math.floor(Number(value));
                            setSimCount(
                              Number.isFinite(next)
                                ? Math.min(SIM_COUNT_MAX, Math.max(0, next))
                                : 0,
                            );
                          }}
                          autoComplete="off"
                          helpText="Distinct eligible products (drives the KIT tier)."
                        />
                      </Box>
                    </InlineStack>
                    {simChips.chips.length > 0 ? (
                      <BlockStack gap="100">
                        <Text as="p" variant="bodySm" tone="subdued">
                          Quick presets (from the live tiers
                          {preview.armed ? " + armed draft" : ""}; amounts in{" "}
                          {simChips.currency}
                          {simChips.currency !== marketCurrency
                            ? ` — the storefront converts these EUR defaults into ${marketCurrency} at the shop rate; enter the ${marketCurrency} spend accordingly`
                            : ""}
                          ):
                        </Text>
                        <InlineStack gap="200" wrap>
                          {simChips.chips.map((chip) => (
                            <Button
                              key={chip.label}
                              size="slim"
                              onClick={() => {
                                if (chip.spendCents !== undefined) {
                                  setSimSpend(String(chip.spendCents / 100));
                                }
                                if (chip.count !== undefined) {
                                  setSimCount(
                                    Math.min(SIM_COUNT_MAX, Math.max(0, chip.count)),
                                  );
                                }
                              }}
                            >
                              {chip.spendCents !== undefined
                                ? `${chip.label} · ${formatMoney(chip.spendCents, simChips.currency)}`
                                : chip.label}
                            </Button>
                          ))}
                        </InlineStack>
                      </BlockStack>
                    ) : null}
                  </BlockStack>
                ) : null}
                <Divider />
                <Checkbox
                  label="Live rehearsal — really add gifts and KIT codes to my preview cart"
                  checked={rehearsal}
                  onChange={setRehearsal}
                />
                <Text as="p" tone="caution" variant="bodySm">
                  Warning: with live rehearsal on, your own preview cart is
                  really mutated (gift lines added and removed, KIT codes
                  applied) — in the drawer and in checkout. A completed
                  rehearsal checkout is a REAL order that deducts real gift
                  stock unless you cancel it or use a test payment. The
                  simulator above wins while it is on: turn it off to
                  rehearse with your real cart. Real visitors are never
                  affected.
                </Text>
                <Divider />
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Draft tier amounts (preview only until “Go live”)
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Change amounts here to see them in the preview — the
                    storefront AND the checkout discount honour the draft on
                    your preview cart. Nothing changes for real visitors until
                    you press “Apply — go live” below (which writes these
                    values into the Rewards settings together with the flag
                    flips). Blank or invalid rows are ignored.
                  </Text>
                  {checked.has("set_savings") ? (
                    <BlockStack gap="200">
                      <Text as="p" fontWeight="semibold" variant="bodySm">
                        Set savings tiers (different products → % off → code)
                      </Text>
                      {ssRows.map((row, index) => (
                        <InlineStack key={index} gap="200" wrap blockAlign="end">
                          <Box minWidth="120px">
                            <TextField
                              label="Products"
                              labelHidden={index > 0}
                              type="number"
                              min={1}
                              step={1}
                              value={row.count}
                              onChange={(value) =>
                                setSsRows((rows) =>
                                  rows.map((r, i) => (i === index ? { ...r, count: value } : r)),
                                )
                              }
                              autoComplete="off"
                            />
                          </Box>
                          <Box minWidth="120px">
                            <TextField
                              label="% off"
                              labelHidden={index > 0}
                              type="number"
                              min={1}
                              max={90}
                              step={1}
                              value={row.pct}
                              onChange={(value) =>
                                setSsRows((rows) =>
                                  rows.map((r, i) => (i === index ? { ...r, pct: value } : r)),
                                )
                              }
                              autoComplete="off"
                            />
                          </Box>
                          <Box minWidth="160px">
                            <TextField
                              label="Code"
                              labelHidden={index > 0}
                              value={row.code}
                              onChange={(value) =>
                                setSsRows((rows) =>
                                  rows.map((r, i) =>
                                    i === index ? { ...r, code: value.toUpperCase() } : r,
                                  ),
                                )
                              }
                              autoComplete="off"
                            />
                          </Box>
                          <Button
                            variant="plain"
                            tone="critical"
                            onClick={() =>
                              setSsRows((rows) => rows.filter((_, i) => i !== index))
                            }
                          >
                            Remove
                          </Button>
                        </InlineStack>
                      ))}
                      <InlineStack gap="200">
                        <Button
                          size="slim"
                          disabled={ssRows.length >= 6}
                          onClick={() =>
                            setSsRows((rows) => [...rows, { count: "", pct: "", code: "" }])
                          }
                        >
                          Add tier
                        </Button>
                        <Button
                          size="slim"
                          variant="plain"
                          onClick={() =>
                            setSsRows(
                              rewardsPreview.liveSsTiers.map((tier) => ({
                                count: String(tier.count),
                                pct: String(tier.pct),
                                code: tier.code,
                              })),
                            )
                          }
                        >
                          Reset to live
                        </Button>
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        A KIT code drafted here must also exist as a discount
                        in Shopify for the checkout discount to apply — “Connect
                        KIT codes &amp; discounts” on the Rewards page after
                        going live.
                      </Text>
                    </BlockStack>
                  ) : null}
                  {checked.has("gift_tiers") ? (
                    <BlockStack gap="200">
                      <Text as="p" fontWeight="semibold" variant="bodySm">
                        Gift tier thresholds
                        {rewardsPreview.liveGtEur.length === 0
                          ? " — no gift tiers configured yet (add them on the Rewards page)"
                          : ""}
                      </Text>
                      {rewardsPreview.liveGtEur.map((_, index) => (
                        <InlineStack key={index} gap="200" wrap blockAlign="end">
                          <Box minWidth="180px">
                            <Text as="p" variant="bodySm">
                              Tier {index + 1} · {rewardsPreview.gtLabels[index]}
                            </Text>
                          </Box>
                          <Box minWidth="140px">
                            <TextField
                              label="EUR (default)"
                              labelHidden={index > 0}
                              type="number"
                              min={0}
                              step={1}
                              value={gtEur[index] ?? ""}
                              onChange={(value) =>
                                setGtEur((values) =>
                                  values.map((v, i) => (i === index ? value : v)),
                                )
                              }
                              autoComplete="off"
                            />
                          </Box>
                          {simulatedMarket ? (
                            <Box minWidth="140px">
                              <TextField
                                label={`${simulatedMarketInfo?.name ?? simulatedMarket} (${marketCurrency})`}
                                labelHidden={index > 0}
                                type="number"
                                min={0}
                                step={1}
                                value={gtMarket[index] ?? ""}
                                onChange={(value) =>
                                  setGtMarket((values) =>
                                    values.map((v, i) => (i === index ? value : v)),
                                  )
                                }
                                autoComplete="off"
                                placeholder="EUR × rate"
                              />
                            </Box>
                          ) : null}
                        </InlineStack>
                      ))}
                      <Text as="p" tone="subdued" variant="bodySm">
                        {simulatedMarket
                          ? `Leave the ${marketCurrency} column blank to keep converting the EUR default at the shop rate; fill every row to draft explicit ${marketCurrency} amounts for this market.`
                          : "Simulate a market above to draft that market's own amounts in its currency."}
                      </Text>
                    </BlockStack>
                  ) : null}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        {/* 3 — Arm & launch */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  3 · Arm &amp; launch
                </Text>
                <Text as="p" tone="subdued">
                  Arming stores your draft selection and enables the preview
                  entry link. Visitors see zero change; the drafts exist only
                  as inert hidden templates until a browser holding the link
                  activates them.
                </Text>
              </BlockStack>
              {notReadyPreviewKeys.length > 0 ? (
                <Banner
                  tone="warning"
                  title="These previewed features will render nothing until configured:"
                >
                  <List>
                    {notReadyPreviewKeys.map((key) => {
                      const fix = NOT_READY_FIX_LINKS[key];
                      return (
                        <List.Item key={key}>
                          <Text as="span" fontWeight="semibold">
                            {features[key].label}
                          </Text>{" "}
                          — {features[key].readinessNote ??
                            "Not configured yet."}{" "}
                          {fix ? <Link url={fix.url}>{fix.label}</Link> : null}
                        </List.Item>
                      );
                    })}
                  </List>
                </Banner>
              ) : null}
              <InlineStack gap="200" blockAlign="center" wrap>
                <Button
                  variant="primary"
                  onClick={submitArm}
                  disabled={checkedKeys.length === 0}
                  loading={pendingIntent === "arm"}
                >
                  {preview.armed ? "Update preview" : "Arm preview"}
                </Button>
                {checkedKeys.length === 0 ? (
                  <Text as="span" tone="subdued" variant="bodySm">
                    Select at least one feature above to arm the preview.
                  </Text>
                ) : preview.armed && !selectionMatchesArmed ? (
                  <Text as="span" tone="caution" variant="bodySm">
                    Your selection differs from the armed preview — press
                    “Update preview” to apply it.
                  </Text>
                ) : null}
              </InlineStack>

              {preview.armed && entryUrl ? (
                <BlockStack gap="300">
                  <Divider />
                  <Text as="h3" variant="headingSm">
                    Launch the preview
                  </Text>
                  <BlockStack gap="200">
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Button url={entryUrl} target="_blank">
                        Product page
                      </Button>
                      <Text as="span" tone="subdued" variant="bodySm">
                        Opens the preview hub on your storefront — follow its
                        product link to review the product-page widgets.
                      </Text>
                    </InlineStack>
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Button url={entryUrl} target="_blank">
                        Cart drawer
                      </Button>
                      <Text as="span" tone="subdued" variant="bodySm">
                        Same entry link — add the product to cart to open the
                        drawer with the cart widgets.
                      </Text>
                    </InlineStack>
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Button url={entryUrl} target="_blank">
                        Checkout preview
                      </Button>
                      <Text as="span" tone="subdued" variant="bodySm">
                        The hub's “Preview checkout” button builds a tagged
                        preview cart (excluded from analytics) and opens the
                        real checkout. Blocks must be placed in the checkout
                        editor once (Settings → Checkout → Customize) —
                        placement cannot be done by the app.
                      </Text>
                    </InlineStack>
                  </BlockStack>
                  <TextField
                    label="Shareable preview link"
                    value={entryUrl}
                    readOnly
                    autoComplete="off"
                    connectedRight={
                      <Button onClick={copyEntryUrl}>Copy</Button>
                    }
                    helpText="Anyone with this link sees the draft widgets in their own browser — share it only with your team. Rotating the token kills every previously shared link."
                  />
                  <InlineStack gap="200" blockAlign="center" wrap>
                    {confirmingRotate ? (
                      <>
                        <Button
                          tone="critical"
                          onClick={() => submitSimple("rotate")}
                          loading={pendingIntent === "rotate"}
                        >
                          Yes, rotate — old links die
                        </Button>
                        <Button
                          variant="plain"
                          onClick={() => setConfirmingRotate(false)}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="plain"
                        onClick={() => setConfirmingRotate(true)}
                      >
                        Rotate token
                      </Button>
                    )}
                    <Text as="span" tone="subdued" variant="bodySm">
                      Rotating immediately invalidates every shared preview
                      link and issues a fresh one.
                    </Text>
                  </InlineStack>
                </BlockStack>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* 4 — Go live */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  4 · Go live
                </Text>
                <Text as="p" tone="subdued">
                  Turn the armed draft features on for real visitors in the
                  markets you pick — through the exact same flag mechanics as
                  the Markets page, nothing new to learn.
                </Text>
              </BlockStack>

              {!preview.armed || draftKeys.length === 0 ? (
                <Text as="p" tone="subdued">
                  Arm a preview with at least one draft feature first — Go
                  live applies exactly what the armed preview shows.
                </Text>
              ) : (
                <BlockStack gap="300">
                  <Text as="p" variant="bodySm">
                    Draft features to apply:{" "}
                    {draftKeys.map((key) => features[key].label).join(", ")}
                  </Text>
                  {lockedDraftKeys.length > 0 ? (
                    <Banner tone="warning" title="Locked by running experiments">
                      <BlockStack gap="100">
                        {lockedDraftKeys.map((key) => {
                          const lock = featureLocks[key]!;
                          return (
                            <Text as="p" key={key}>
                              “{features[key].label}” is being flipped by “
                              {lock.experimentName}” (
                              {marketPhrase(lock.market)}) — conclude that
                              experiment before applying.
                            </Text>
                          );
                        })}
                      </BlockStack>
                    </Banner>
                  ) : null}

                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      Target markets
                    </Text>
                    <Checkbox
                      label="All markets"
                      checked={targetAll}
                      disabled={marketLockedBy("all").length > 0}
                      helpText={
                        marketLockedBy("all").length > 0
                          ? `Locked while experiments run: ${marketLockedBy("all").join(", ")}`
                          : undefined
                      }
                      onChange={(value) => {
                        setTargetAll(value);
                        if (value) setTargetMarkets(new Set());
                      }}
                    />
                    {markets.map((market) => {
                      const lockedBy = marketLockedBy(market.handle);
                      return (
                        <Checkbox
                          key={market.handle}
                          label={`${market.name}${market.primary ? " · primary" : ""}${market.enabled ? "" : " · inactive"}`}
                          checked={
                            !targetAll && targetMarkets.has(market.handle)
                          }
                          disabled={targetAll || lockedBy.length > 0}
                          helpText={
                            lockedBy.length > 0
                              ? `Locked by running experiment: ${lockedBy.join(", ")}`
                              : undefined
                          }
                          onChange={(value) => {
                            setTargetMarkets((previous) => {
                              const next = new Set(previous);
                              if (value) next.add(market.handle);
                              else next.delete(market.handle);
                              return next;
                            });
                          }}
                        />
                      );
                    })}
                  </BlockStack>

                  {selectedTargets.length > 0 ? (
                    <BlockStack gap="200">
                      <Divider />
                      <Text as="h3" variant="headingSm">
                        Exactly what will change
                      </Text>
                      {diff.changes.length === 0 ? (
                        <Text as="p" tone="subdued">
                          Nothing — every selected feature is already live in
                          the selected market
                          {selectedTargets.length === 1 ? "" : "s"}.
                        </Text>
                      ) : (
                        <List>
                          {diff.changes.map((change) => (
                            <List.Item key={`${change.key}-${change.market}`}>
                              {change.label} — will turn ON in {change.market}
                            </List.Item>
                          ))}
                        </List>
                      )}
                      {diff.alreadyLive > 0 ? (
                        <Text as="p" tone="subdued" variant="bodySm">
                          {diff.alreadyLive} feature/market pair
                          {diff.alreadyLive === 1 ? " is" : "s are"} already
                          live and will be skipped.
                        </Text>
                      ) : null}
                    </BlockStack>
                  ) : (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Pick at least one target market to see the exact diff.
                    </Text>
                  )}

                  <Checkbox
                    label="Disarm preview after applying"
                    checked={disarmAfter}
                    onChange={setDisarmAfter}
                    helpText="Recommended — once the features are live there is nothing left to preview."
                  />
                  <InlineStack gap="200" blockAlign="center">
                    <Button
                      variant="primary"
                      tone="success"
                      onClick={submitApply}
                      disabled={!canApply}
                      loading={pendingIntent === "apply"}
                    >
                      Apply — go live
                    </Button>
                    {!canApply && selectedTargets.length > 0 ? (
                      <Text as="span" tone="subdued" variant="bodySm">
                        {selectedLocked || lockedDraftKeys.length > 0
                          ? "Resolve the experiment locks above first."
                          : diff.changes.length === 0
                            ? "Everything selected is already live."
                            : ""}
                      </Text>
                    ) : null}
                  </InlineStack>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
