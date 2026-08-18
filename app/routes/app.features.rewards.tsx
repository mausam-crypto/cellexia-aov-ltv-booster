import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import type { ShouldRevalidateFunctionArgs } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  Tabs,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  GIFT_PRESETS,
  GIFT_PRESET_KEYS,
  LADDER_PRESETS,
  LADDER_PRESET_KEYS,
  REWARDS_CAPS,
  getSettings,
  resolveFeatureFlag,
  saveSettings,
  validateFreeShipPatch,
  validateGiftTiersPatch,
  validateSetSavingsPatch,
  type BoosterSettings,
  type DeepPartial,
  type GiftTier,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import {
  connectRewardsDiscounts,
  detectStoreCodes,
  getRewardsState,
  giftStockIsStale,
  giftVariantGids,
  refreshGiftStock,
  refreshUnitMap,
  suggestGiftThresholds,
  type GiftStockState,
} from "../services/rewards.server";
import { listMarkets } from "../services/markets.server";
import {
  getProductTitlesByIds,
  getVariantsByIds,
  type VariantSummary,
} from "../services/products.server";
import { listProductsWithBoosterStatus } from "../services/pdp-content.server";
import { FeaturePageHeader } from "../components/FeaturePageHeader";
import { ReadinessCard, type ReadinessRow } from "../components/rewards/ReadinessCard";
import { SetSavingsTab } from "../components/rewards/SetSavingsTab";
import { GiftsTab } from "../components/rewards/GiftsTab";
import { MarketsTab } from "../components/rewards/MarketsTab";
import {
  CAPS,
  CODE_PATTERN,
  GIFT_PRESET_BADGES,
  intError,
  isLoadableGiftPreset,
  normalizeYieldCodes,
  reachCaption,
  samplePoolError,
  scopeMarketCount,
  toScopePatch,
  toScopeState,
  validateGiftTierRows,
  validateSetSavingsRows,
  validateThresholdRows,
  type DiscountNodesView,
  type GiftOptionRow,
  type GiftTierRow,
  type LadderPresetKey,
  type LoadableGiftPreset,
  type LocationOption,
  type PresetTables,
  type RewardsFormState,
  type RewardsKey,
  type ScopeState,
  type SetSavingsTierRow,
  type StockView,
} from "../components/rewards/shared";

/**
 * Rewards (v15, docs/SPEC-v14-rewards.md §11 + v15 section) — the guided
 * settings page for the three `rewards.*` sections: set savings (app-owned
 * SETn discount codes), free gifts (spend tiers, per-market amounts, stock
 * awareness) and the free-shipping guarantee.
 *
 * v15 layout: a "Ready to go live?" checklist card, then Polaris Tabs
 * ("Set savings" | "Free gifts" | "Free shipping" | "Markets & go live") —
 * the tab UIs live in app/components/rewards/*. This route keeps the loader,
 * the action (settings save + intents), the form state and the validators.
 * Same fail-loud validation as the other feature pages: the
 * settings.server.ts validators run BEFORE saveSettings.
 *
 * Intents (each returns its own `intent`-tagged envelope; toast/Banner read
 * only settings-save results):
 *   search_products    — exclusions picker
 *   connect_rewards    — connectRewardsDiscounts (create/update OUR discounts
 *                        only; foreign codes are reported, never touched)
 *   suggest_thresholds — pricing-aware per-market gift amounts
 *   refresh_stock      — refreshGiftStock (stock table)
 *   load_defaults      — a GIFT_PRESETS entry (form field `preset`)
 *   load_sachets       — products tagged sample-sachet → samplePool
 *   detect_codes       — v15 detectStoreCodes(prefixes) → step-aside suggestions
 *
 * Every settings save runs refreshUnitMap BEFORE syncSettingsToMetafields
 * and refreshGiftStock AFTER (the paused set follows the new pool).
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface SettingsSaveResult {
  ok: boolean;
  syncErrors: string[];
}

interface ProductSearchResult {
  intent: "search_products";
  ok: boolean;
  errors: string[];
  products: { gid: string; title: string; imageUrl: string | null; status: string }[];
}

interface ThresholdRecord {
  amounts: number[];
  currencyCode: string;
}

type RewardsIntentResult =
  | {
      intent: "connect_rewards";
      ok: boolean;
      errors: string[];
      summary: string;
      nodes: DiscountNodesView;
    }
  | {
      intent: "suggest_thresholds";
      ok: boolean;
      errors: string[];
      summary: string;
      thresholds: Record<string, ThresholdRecord>;
    }
  | {
      intent: "refresh_stock";
      ok: boolean;
      errors: string[];
      summary: string;
      giftStock: StockView;
    }
  | {
      intent: "load_defaults";
      ok: boolean;
      errors: string[];
      preset: LoadableGiftPreset;
      tiers: GiftTier[];
      variants: VariantSummary[];
    }
  | {
      intent: "load_sachets";
      ok: boolean;
      errors: string[];
      pool: { variantId: string; handle: string }[];
      variants: VariantSummary[];
      /** v15.1: the store has more sachets than the pool cap — only the first
       *  REWARDS_CAPS.samplePool were returned. */
      truncated: boolean;
    }
  | {
      intent: "detect_codes";
      ok: boolean;
      errors: string[];
      codes: string[];
    };

type ActionResult = SettingsSaveResult | ProductSearchResult | RewardsIntentResult;

function validateRewardsPatch(patch: DeepPartial<BoosterSettings>): string[] {
  const rewards = patch.rewards;
  if (rewards === undefined || rewards === null) return [];
  if (typeof rewards !== "object" || Array.isArray(rewards)) {
    return ["Rewards: settings must be an object."];
  }
  return [
    ...validateSetSavingsPatch(rewards.setSavings),
    ...validateGiftTiersPatch(rewards.giftTiers),
    ...validateFreeShipPatch(rewards.freeShip),
  ];
}

async function applySettingsPatch(
  shop: string,
  admin: AdminGraphqlClient,
  rawPatch: FormDataEntryValue | null,
): Promise<SettingsSaveResult> {
  if (typeof rawPatch !== "string" || rawPatch.trim() === "") {
    return { ok: false, syncErrors: ["Missing settings payload."] };
  }
  let patch: DeepPartial<BoosterSettings>;
  try {
    const parsed: unknown = JSON.parse(rawPatch);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, syncErrors: ["Settings payload must be an object."] };
    }
    patch = parsed as DeepPartial<BoosterSettings>;
  } catch {
    return { ok: false, syncErrors: ["Settings payload was not valid JSON."] };
  }
  const rewardsErrors = validateRewardsPatch(patch);
  if (rewardsErrors.length > 0) {
    return { ok: false, syncErrors: rewardsErrors };
  }
  const next = await saveSettings(shop, patch);
  const syncErrors: string[] = [];
  try {
    const units = await refreshUnitMap(admin, shop);
    if (!units.ok) syncErrors.push(...units.errors);
  } catch (error) {
    syncErrors.push(
      error instanceof Error ? `Unit map: ${error.message}` : "Could not refresh the product unit map.",
    );
  }
  try {
    const sync = await syncSettingsToMetafields(admin, next);
    syncErrors.push(...sync.errors);
    syncErrors.push(...syncWarnings(sync));
  } catch (error) {
    syncErrors.push(
      error instanceof Error ? error.message : "Could not sync settings to storefront metafields.",
    );
  }
  try {
    const stock = await refreshGiftStock(admin, shop, next);
    if (!stock.ok) syncErrors.push(...stock.errors);
  } catch (error) {
    syncErrors.push(error instanceof Error ? `Gift stock: ${error.message}` : "Could not refresh gift stock.");
  }
  return { ok: true, syncErrors };
}

/** v15: the rewards metafield write is a separate call whose failure comes
 *  back as a warning (contract item 3) — surface it, never swallow it. */
function syncWarnings(sync: { warnings?: unknown }): string[] {
  return Array.isArray(sync.warnings)
    ? sync.warnings.filter((w): w is string => typeof w === "string")
    : [];
}

// ---------------------------------------------------------------------------
// Admin API helpers local to this route
// ---------------------------------------------------------------------------

const LOCATIONS_QUERY = `#graphql
  query cellexiaRewardsLocations {
    locations(first: 20, query: "active:true") {
      nodes { id name address { countryCode } }
    }
  }
`;

const PRODUCT_BY_HANDLE_QUERY = `#graphql
  query cellexiaRewardsProductByHandle($handle: String!) {
    productByHandle(handle: $handle) {
      id title handle status
      featuredImage { url }
      variants(first: 1) { nodes { id title price availableForSale image { url } } }
    }
  }
`;

// first: cap + 1 so the loader can tell the merchant when the store carries
// more sachets than the pool allows (REWARDS_CAPS.samplePool = 9).
const SACHET_PRODUCTS_QUERY = `#graphql
  query cellexiaRewardsSachets($first: Int!) {
    products(first: $first, query: "tag:sample-sachet status:active") {
      nodes {
        id title handle
        featuredImage { url }
        variants(first: 1) { nodes { id title price availableForSale image { url } } }
      }
    }
  }
`;

interface ProductNode {
  id: string;
  title: string;
  handle: string;
  status?: string;
  featuredImage: { url: string } | null;
  variants: {
    nodes: { id: string; title: string; price: string; availableForSale: boolean; image: { url: string } | null }[];
  };
}

function firstVariantSummary(product: ProductNode): VariantSummary | null {
  const variant = product.variants?.nodes?.[0];
  if (!variant) return null;
  return {
    id: variant.id,
    title: variant.title,
    price: variant.price,
    productTitle: product.title,
    productHandle: product.handle,
    imageUrl: variant.image?.url ?? product.featuredImage?.url ?? null,
    availableForSale: variant.availableForSale,
  };
}

async function listLocations(admin: AdminGraphqlClient): Promise<LocationOption[]> {
  try {
    const response = await admin.graphql(LOCATIONS_QUERY);
    const json = (await response.json()) as {
      data?: {
        locations?: { nodes?: { id: string; name: string; address?: { countryCode?: string | null } | null }[] };
      };
    };
    return (json.data?.locations?.nodes ?? []).map((node) => ({
      id: node.id,
      name: node.name,
      countryCode: node.address?.countryCode ?? "",
    }));
  } catch {
    return [];
  }
}

async function productByHandle(admin: AdminGraphqlClient, handle: string): Promise<ProductNode | null> {
  const response = await admin.graphql(PRODUCT_BY_HANDLE_QUERY, { variables: { handle } });
  const json = (await response.json()) as { data?: { productByHandle?: ProductNode | null } };
  return json.data?.productByHandle ?? null;
}

/** Resolve the handles of a GIFT_PRESETS entry to live variant GIDs. */
async function loadDefaultGiftTiers(
  admin: AdminGraphqlClient,
  preset: LoadableGiftPreset,
): Promise<{ tiers: GiftTier[]; variants: VariantSummary[]; errors: string[] }> {
  const errors: string[] = [];
  const variants: VariantSummary[] = [];
  const tiers: GiftTier[] = [];
  const handleCache = new Map<string, string>();
  for (const shape of GIFT_PRESETS[preset]) {
    const slots: GiftTier["slots"] = [];
    for (const slot of shape.slots) {
      const options: GiftTier["slots"][number] = [];
      for (const option of slot) {
        if (option.kind !== "variant" || option.handle === "") {
          options.push({ ...option });
          continue;
        }
        let variantId = option.variantId;
        if (handleCache.has(option.handle)) {
          variantId = handleCache.get(option.handle) ?? variantId;
        } else {
          try {
            const product = await productByHandle(admin, option.handle);
            const summary = product ? firstVariantSummary(product) : null;
            if (!product || !summary) {
              errors.push(`Product "${option.handle}" was not found in your store — pick another gift for that tier.`);
            } else {
              variantId = summary.id;
              variants.push(summary);
              handleCache.set(option.handle, summary.id);
              if (product.status && product.status !== "ACTIVE") {
                errors.push(`Product "${option.handle}" is ${product.status.toLowerCase()} — publish it before going live.`);
              }
            }
          } catch (error) {
            errors.push(`Lookup of "${option.handle}" failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        options.push({ ...option, variantId });
      }
      slots.push(options);
    }
    tiers.push({ amount: shape.amount, slots });
  }
  return { tiers, variants, errors };
}

async function loadSachetPool(admin: AdminGraphqlClient): Promise<{
  pool: { variantId: string; handle: string }[];
  variants: VariantSummary[];
  errors: string[];
  truncated: boolean;
}> {
  const cap = REWARDS_CAPS.samplePool;
  try {
    const response = await admin.graphql(SACHET_PRODUCTS_QUERY, { variables: { first: cap + 1 } });
    const json = (await response.json()) as {
      data?: { products?: { nodes?: ProductNode[] } };
      errors?: { message: string }[];
    };
    if (json.errors?.length) {
      return { pool: [], variants: [], errors: json.errors.map((e) => e.message), truncated: false };
    }
    const variants: VariantSummary[] = [];
    const pool: { variantId: string; handle: string }[] = [];
    let truncated = false;
    for (const product of json.data?.products?.nodes ?? []) {
      const summary = firstVariantSummary(product);
      if (!summary) continue;
      if (pool.length >= cap) {
        truncated = true;
        break;
      }
      variants.push(summary);
      pool.push({ variantId: summary.id, handle: product.handle });
    }
    const errors: string[] = [];
    if (pool.length === 0) errors.push("No active product carries the sample-sachet tag.");
    if (truncated) {
      errors.push(
        `Your store has more than ${cap} products tagged sample-sachet; only the first ${cap} were loaded (the pool holds at most ${cap}). Remove the tag from the ones you do not want as samples, or remove entries from the pool below.`,
      );
    }
    return { pool, variants, errors, truncated };
  } catch (error) {
    return {
      pool: [],
      variants: [],
      errors: [error instanceof Error ? error.message : "Could not list sachets."],
      truncated: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Loader / action
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const [settings, markets, locations] = await Promise.all([
    getSettings(session.shop),
    listMarkets(admin),
    listLocations(admin),
  ]);
  let rewardsState = await getRewardsState(session.shop);
  let stockNote: string | null = null;
  if (giftStockIsStale(rewardsState.giftStock)) {
    try {
      const refreshed = await refreshGiftStock(admin, session.shop, settings);
      if (refreshed.data) rewardsState = { ...rewardsState, giftStock: refreshed.data };
      if (!refreshed.ok) stockNote = refreshed.errors.join(" ");
    } catch (error) {
      stockNote = error instanceof Error ? error.message : "Stock check failed.";
    }
  }
  const [exclusionTitles, giftVariants] = await Promise.all([
    getProductTitlesByIds(
      admin,
      Object.values(settings.rewards.setSavings.setSavingsExcludedByMarket).flat(),
    ).catch(() => ({}) as Record<string, string>),
    // v15.1: handle-only gift options resolve through nodes.hv (first variant
    // by position at the last unit-map refresh) so the readiness card and the
    // gift labels know the real product.
    getVariantsByIds(admin, giftVariantGids(settings, rewardsState.nodes.hv)).catch(
      () => [] as VariantSummary[],
    ),
  ]);
  const ssOn = resolveFeatureFlag(settings, "set_savings");
  const gtOn = resolveFeatureFlag(settings, "gift_tiers");
  return {
    settings,
    markets,
    locations,
    exclusionTitles,
    giftVariants,
    presets: {
      ladderKeys: LADDER_PRESET_KEYS,
      ladders: LADDER_PRESETS,
      giftKeys: GIFT_PRESET_KEYS,
    } satisfies PresetTables,
    nodes: {
      kit: rewardsState.nodes.kit,
      gift: rewardsState.nodes.gift,
      ship: rewardsState.nodes.ship,
    } satisfies DiscountNodesView,
    functionId: rewardsState.functionId,
    /** handle -> numeric variant id (v15.1 hv) — resolves handle-only gifts client-side. */
    hv: rewardsState.nodes.hv,
    /** Server caps the client must respect (REWARDS_CAPS is the authority). */
    caps: { samplePool: REWARDS_CAPS.samplePool },
    giftStock: { t: rewardsState.giftStock.t, byMarket: rewardsState.giftStock.byMarket } satisfies StockView,
    stockNote,
    headerEnabled: ssOn || gtOn,
    headerLabel: ssOn && gtOn ? "Both active" : ssOn ? "Set savings active" : gtOn ? "Free gifts active" : "Off",
  };
};

/** Read-only lookups whose results land in UNSAVED form state must not
 *  revalidate (a loader revalidation would reset the form). */
export function shouldRevalidate({ formData, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  const intent = formData?.get("intent");
  if (
    intent === "search_products" ||
    intent === "suggest_thresholds" ||
    intent === "load_defaults" ||
    intent === "load_sachets" ||
    intent === "detect_codes"
  ) {
    return false;
  }
  return defaultShouldRevalidate;
}

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent === "search_products") {
    const result = await listProductsWithBoosterStatus(admin, String(formData.get("q") ?? ""));
    return {
      intent: "search_products" as const,
      ok: result.ok,
      errors: result.errors,
      products: result.products.map((product) => ({
        gid: product.id,
        title: product.title,
        imageUrl: product.imageUrl,
        status: product.status,
      })),
    };
  }
  if (intent === "connect_rewards") {
    const settings = await getSettings(session.shop);
    const result = await connectRewardsDiscounts(admin, session.shop, settings);
    const state = result.data ?? (await getRewardsState(session.shop));
    return {
      intent: "connect_rewards" as const,
      ok: result.ok,
      errors: result.errors,
      summary: result.summary,
      nodes: { kit: state.nodes.kit, gift: state.nodes.gift, ship: state.nodes.ship },
    };
  }
  if (intent === "detect_codes") {
    const prefixes = String(formData.get("prefixes") ?? "KIT")
      .split(/[\s,;]+/)
      .map((p) => p.trim().toUpperCase())
      .filter((p) => p !== "")
      .slice(0, 5);
    try {
      const state = await getRewardsState(session.shop);
      const codes = await detectStoreCodes(admin, prefixes.length > 0 ? prefixes : ["KIT"], {
        functionId: state.functionId,
      });
      return { intent: "detect_codes" as const, ok: true, errors: [], codes };
    } catch (error) {
      return {
        intent: "detect_codes" as const,
        ok: false,
        errors: [error instanceof Error ? error.message : "Could not list your discount codes."],
        codes: [],
      };
    }
  }
  if (intent === "suggest_thresholds") {
    const settings = await getSettings(session.shop);
    const rawEur = formData.get("eurAmounts");
    if (typeof rawEur === "string" && rawEur.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(rawEur);
        if (
          Array.isArray(parsed) &&
          parsed.length === settings.rewards.giftTiers.tiers.length &&
          parsed.every((n) => typeof n === "number" && Number.isFinite(n))
        ) {
          settings.rewards.giftTiers.tiers = settings.rewards.giftTiers.tiers.map((tier, index) => ({
            ...tier,
            amount: parsed[index] as number,
          }));
        } else if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number")) {
          settings.rewards.giftTiers.tiers = (parsed as number[]).map((amount, index) => ({
            amount,
            slots: settings.rewards.giftTiers.tiers[index]?.slots ?? [
              [{ kind: "samples", variantId: "", handle: "", count: 1 }],
            ],
          }));
        }
      } catch {
        // ignore — saved amounts are used
      }
    }
    const markets = await listMarkets(admin);
    const result = await suggestGiftThresholds(admin, settings, markets);
    return {
      intent: "suggest_thresholds" as const,
      ok: result.ok,
      errors: result.errors,
      summary: result.summary,
      thresholds: result.data ?? {},
    };
  }
  if (intent === "refresh_stock") {
    const settings = await getSettings(session.shop);
    const result = await refreshGiftStock(admin, session.shop, settings);
    const stock: GiftStockState = result.data ?? (await getRewardsState(session.shop)).giftStock;
    return {
      intent: "refresh_stock" as const,
      ok: result.ok,
      errors: result.errors,
      summary: result.summary,
      giftStock: { t: stock.t, byMarket: stock.byMarket },
    };
  }
  if (intent === "load_defaults") {
    const rawPreset = formData.get("preset");
    const preset: LoadableGiftPreset = isLoadableGiftPreset(rawPreset, GIFT_PRESET_KEYS) ? rawPreset : "value_first";
    const result = await loadDefaultGiftTiers(admin, preset);
    return {
      intent: "load_defaults" as const,
      ok: result.errors.length === 0,
      errors: result.errors,
      preset,
      tiers: result.tiers,
      variants: result.variants,
    };
  }
  if (intent === "load_sachets") {
    const result = await loadSachetPool(admin);
    return {
      intent: "load_sachets" as const,
      ok: result.errors.length === 0,
      errors: result.errors,
      pool: result.pool,
      variants: result.variants,
      truncated: result.truncated,
    };
  }
  return applySettingsPatch(session.shop, admin, formData.get("patch"));
};

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

function initialFormState(settings: BoosterSettings): RewardsFormState {
  const ss = settings.rewards.setSavings;
  const gt = settings.rewards.giftTiers;
  const fs = settings.rewards.freeShip;
  return {
    ss: {
      enabled: ss.enabled,
      ladderPreset: ss.ladderPreset,
      tiers: ss.tiers.map((tier) => ({ count: String(tier.count), pct: String(tier.pct), code: tier.code })),
      yieldToCodes: [...ss.yieldToCodes],
      includeSubscriptions: ss.includeSubscriptions,
      surfaces: { ...ss.surfaces },
      checkoutMessage: ss.checkoutMessage,
      excluded: Object.fromEntries(
        Object.entries(ss.setSavingsExcludedByMarket).map(([handle, gids]) => [handle, [...gids]]),
      ),
    },
    gt: {
      enabled: gt.enabled,
      giftPreset: gt.giftPreset,
      cumulative: gt.cumulative,
      choice: gt.choice,
      maxGiftLines: String(gt.maxGiftLines),
      sampleRule: gt.sampleRule,
      showShippingMilestone: gt.showShippingMilestone,
      tiers: gt.tiers.map((tier) => ({
        amount: String(tier.amount),
        slots: tier.slots.map((slot) =>
          slot.map((option) => ({
            kind: option.kind,
            variantId: option.variantId,
            handle: option.handle,
            count: String(option.count),
          })),
        ),
      })),
      thresholds: Object.fromEntries(
        Object.entries(gt.giftThresholdsByMarket).map(([handle, entry]) => [
          handle,
          { amounts: entry.amounts.map((a) => String(a)), currencyCode: entry.currencyCode },
        ]),
      ),
      samplePool: gt.samplePool.map((entry) => ({ ...entry })),
      warehouse: Object.fromEntries(Object.entries(gt.warehouseByMarket).map(([handle, ids]) => [handle, [...ids]])),
      stockFloorDays: String(gt.stockFloor.days),
      stockFloorMinUnits: String(gt.stockFloor.minUnits),
    },
    fs: {
      enabled: fs.enabled,
      minUnits: String(fs.minUnits),
      byThreshold: fs.byThreshold,
      scope: toScopeState(fs.scope),
    },
    scopes: {
      set_savings: toScopeState(settings.marketScopes.set_savings),
      gift_tiers: toScopeState(settings.marketScopes.gift_tiers),
    },
  };
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** Dirty-check serialization: trimmed strings, upper-cased codes, records
 *  key-sorted; scopes as persisted. */
function serializeForCompare(state: RewardsFormState): string {
  return JSON.stringify({
    ss: {
      ...state.ss,
      tiers: state.ss.tiers.map((t) => ({ count: t.count.trim(), pct: t.pct.trim(), code: t.code.trim().toUpperCase() })),
      yieldToCodes: normalizeYieldCodes(state.ss.yieldToCodes, state.ss.tiers).codes,
      checkoutMessage: state.ss.checkoutMessage.trim(),
      excluded: sortedRecord(state.ss.excluded),
    },
    gt: {
      ...state.gt,
      tiers: state.gt.tiers.map((t) => ({
        amount: t.amount.trim(),
        slots: t.slots.map((slot) => slot.map((o) => ({ ...o, count: o.count.trim() }))),
      })),
      thresholds: sortedRecord(
        Object.fromEntries(
          Object.entries(state.gt.thresholds)
            .map(([handle, row]) => [handle, { amounts: row.amounts.map((a) => a.trim()), currencyCode: row.currencyCode }])
            .filter(([, row]) => (row as { amounts: string[] }).amounts.some((a) => a !== "")),
        ),
      ),
      warehouse: sortedRecord(
        Object.fromEntries(
          Object.entries(state.gt.warehouse)
            .map(([handle, ids]) => [handle, [...ids].sort()])
            .filter(([, ids]) => (ids as string[]).length > 0),
        ),
      ),
      maxGiftLines: state.gt.maxGiftLines.trim(),
      stockFloorDays: state.gt.stockFloorDays.trim(),
      stockFloorMinUnits: state.gt.stockFloorMinUnits.trim(),
    },
    fs: { ...state.fs, minUnits: state.fs.minUnits.trim(), scope: toScopePatch(state.fs.scope) },
    scopes: {
      set_savings: toScopePatch(state.scopes.set_savings),
      gift_tiers: toScopePatch(state.scopes.gift_tiers),
    },
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const TAB_IDS = ["set-savings", "gifts", "markets"] as const;
type TabId = (typeof TAB_IDS)[number];
const TABS: { id: TabId; content: string; panelID: string }[] = [
  { id: "set-savings", content: "Set savings", panelID: "rw-panel-ss" },
  { id: "gifts", content: "Free gifts", panelID: "rw-panel-gt" },
  { id: "markets", content: "Markets & go live", panelID: "rw-panel-mk" },
];

function tabFromHash(hash: string): number {
  if (hash === "#market-targeting" || hash.startsWith("#market-")) return 2;
  if (hash === "#gifts") return 1;
  return 0;
}

export default function RewardsFeaturesPage() {
  const {
    settings,
    markets,
    locations,
    exclusionTitles,
    giftVariants,
    presets,
    nodes,
    functionId,
    hv,
    caps,
    giftStock,
    stockNote,
    headerEnabled,
    headerLabel,
  } = useLoaderData<typeof loader>();
  const poolCap = caps.samplePool;
  /** v15.1: server-written collisions (Connect) — read-only in the admin. */
  const blockedCodes: string[] = Array.isArray(settings.rewards.setSavings.blockedCodes)
    ? settings.rewards.setSavings.blockedCodes
    : [];
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<RewardsFormState>(() => initialFormState(settings));
  const [variantIndex, setVariantIndex] = useState<Record<string, VariantSummary>>(() =>
    Object.fromEntries(giftVariants.map((v) => [v.id, v])),
  );
  const [giftPresetChoice, setGiftPresetChoice] = useState<LoadableGiftPreset>(() =>
    isLoadableGiftPreset(settings.rewards.giftTiers.giftPreset, presets.giftKeys)
      ? settings.rewards.giftTiers.giftPreset
      : "value_first",
  );
  const [stockView, setStockView] = useState<StockView>(giftStock);
  const [nodesView, setNodesView] = useState<DiscountNodesView>(nodes);
  const [tab, setTab] = useState(0);
  /** Bumped when the "Fix these before saving" banner opens a tab whose
   *  problem sits inside a collapsed Advanced section — the tab opens it. */
  const [advancedSignal, setAdvancedSignal] = useState(0);
  /** v15.1: inline note under the sample pool (cap reached / entries dropped). */
  const [poolNote, setPoolNote] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const initialTab = tabFromHash(window.location.hash);
    if (initialTab !== 0) setTab(initialTab);
  }, []);

  /** The form resets on saved-settings CONTENT changes only (Connect /
   *  stock refresh revalidate the loader with a new object identity). */
  const settingsKey = useMemo(() => JSON.stringify(settings), [settings]);
  useEffect(() => {
    setState(initialFormState(settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);
  useEffect(() => {
    setVariantIndex((previous) => ({ ...previous, ...Object.fromEntries(giftVariants.map((v) => [v.id, v])) }));
  }, [giftVariants]);
  useEffect(() => setStockView(giftStock), [giftStock]);
  useEffect(() => setNodesView(nodes), [nodes]);

  const saveResult = actionData && "syncErrors" in actionData ? actionData : undefined;
  useEffect(() => {
    if (!saveResult) return;
    if (!saveResult.ok) {
      shopify.toast.show("Could not save — check the messages on the page", { isError: true });
    } else if (saveResult.syncErrors.length > 0) {
      shopify.toast.show("Saved, but the storefront could not be fully updated", { isError: true });
    } else {
      shopify.toast.show("Saved");
    }
  }, [saveResult, shopify]);

  const initial = useMemo(() => initialFormState(settings), [settings]);
  const dirty = serializeForCompare(state) !== serializeForCompare(initial);
  const isSaving = navigation.state !== "idle" && navigation.formMethod === "POST";

  // ---- Intent fetchers ----------------------------------------------------
  const connectFetcher = useFetcher<typeof action>();
  const suggestFetcher = useFetcher<typeof action>();
  const stockFetcher = useFetcher<typeof action>();
  const defaultsFetcher = useFetcher<typeof action>();
  const sachetsFetcher = useFetcher<typeof action>();
  const detectFetcher = useFetcher<typeof action>();

  const pick = <K extends RewardsIntentResult["intent"]>(
    fetcher: { data?: ActionResult },
    intent: K,
  ): Extract<RewardsIntentResult, { intent: K }> | null =>
    fetcher.data && "intent" in fetcher.data && fetcher.data.intent === intent
      ? (fetcher.data as Extract<RewardsIntentResult, { intent: K }>)
      : null;
  const connectResult = pick(connectFetcher, "connect_rewards");
  const suggestResult = pick(suggestFetcher, "suggest_thresholds");
  const stockResult = pick(stockFetcher, "refresh_stock");
  const defaultsResult = pick(defaultsFetcher, "load_defaults");
  const sachetsResult = pick(sachetsFetcher, "load_sachets");
  const detectResult = pick(detectFetcher, "detect_codes");

  // Each intent result is applied ONCE (fetcher.data persists across renders).
  const appliedRef = useRef<Record<string, unknown>>({});
  useEffect(() => {
    if (!suggestResult || appliedRef.current.suggest === suggestResult) return;
    appliedRef.current.suggest = suggestResult;
    if (!suggestResult.ok && Object.keys(suggestResult.thresholds).length === 0) return;
    setState((previous) => ({
      ...previous,
      gt: {
        ...previous.gt,
        thresholds: {
          ...previous.gt.thresholds,
          ...Object.fromEntries(
            Object.entries(suggestResult.thresholds).map(([handle, entry]) => [
              handle,
              { amounts: entry.amounts.map((a) => String(a)), currencyCode: entry.currencyCode },
            ]),
          ),
        },
      },
    }));
    shopify.toast.show("Suggested amounts filled in — review, then Save");
  }, [suggestResult, shopify]);
  useEffect(() => {
    if (!stockResult || appliedRef.current.stock === stockResult) return;
    appliedRef.current.stock = stockResult;
    setStockView(stockResult.giftStock);
    shopify.toast.show(stockResult.ok ? "Gift stock checked" : "Stock check reported problems", {
      isError: !stockResult.ok,
    });
  }, [stockResult, shopify]);
  useEffect(() => {
    if (!defaultsResult || appliedRef.current.defaults === defaultsResult) return;
    appliedRef.current.defaults = defaultsResult;
    setVariantIndex((previous) => ({ ...previous, ...Object.fromEntries(defaultsResult.variants.map((v) => [v.id, v])) }));
    setState((previous) => {
      const tierCount = defaultsResult.tiers.length;
      return {
        ...previous,
        gt: {
          ...previous.gt,
          giftPreset: defaultsResult.preset,
          tiers: defaultsResult.tiers.map((tier) => ({
            amount: String(tier.amount),
            slots: tier.slots.map((slot) =>
              slot.map((option) => ({
                kind: option.kind,
                variantId: option.variantId,
                handle: option.handle,
                count: String(option.count),
              })),
            ),
          })),
          thresholds: Object.fromEntries(
            Object.entries(previous.gt.thresholds).map(([handle, row]) => {
              const amounts = row.amounts.slice(0, tierCount);
              while (amounts.length < tierCount) amounts.push("");
              return [handle, { ...row, amounts }];
            }),
          ),
        },
      };
    });
    shopify.toast.show(`${GIFT_PRESET_BADGES[defaultsResult.preset]} gifts loaded — review, then Save`);
  }, [defaultsResult, shopify]);
  useEffect(() => {
    if (!sachetsResult || appliedRef.current.sachets === sachetsResult) return;
    appliedRef.current.sachets = sachetsResult;
    if (sachetsResult.pool.length === 0) {
      shopify.toast.show("No sample-sachet products found", { isError: true });
      return;
    }
    setVariantIndex((previous) => ({ ...previous, ...Object.fromEntries(sachetsResult.variants.map((v) => [v.id, v])) }));
    let dropped = 0;
    setState((previous) => {
      const known = new Set(previous.gt.samplePool.map((e) => e.variantId));
      const all = [...previous.gt.samplePool, ...sachetsResult.pool.filter((e) => !known.has(e.variantId))];
      const merged = all.slice(0, poolCap);
      dropped = all.length - merged.length;
      return { ...previous, gt: { ...previous.gt, samplePool: merged } };
    });
    setPoolNote(
      dropped > 0
        ? `The pool holds at most ${poolCap} sachets — ${dropped} of the loaded sachet${dropped === 1 ? " was" : "s were"} not added. Remove an entry to make room.`
        : undefined,
    );
    shopify.toast.show("Sachets loaded — review, then Save");
  }, [sachetsResult, shopify, poolCap]);
  useEffect(() => {
    if (!connectResult || appliedRef.current.connect === connectResult) return;
    appliedRef.current.connect = connectResult;
    setNodesView(connectResult.nodes);
    shopify.toast.show(
      connectResult.ok ? "Discount codes are ready" : "Some discount codes could not be created",
      { isError: !connectResult.ok },
    );
  }, [connectResult, shopify]);

  // ---- State helpers ------------------------------------------------------
  const setSs = (patch: Partial<RewardsFormState["ss"]>) =>
    setState((previous) => ({ ...previous, ss: { ...previous.ss, ...patch } }));
  const setGt = (patch: Partial<RewardsFormState["gt"]>) =>
    setState((previous) => ({ ...previous, gt: { ...previous.gt, ...patch } }));
  const setFs = (patch: Partial<RewardsFormState["fs"]>) =>
    setState((previous) => ({ ...previous, fs: { ...previous.fs, ...patch } }));
  const setScope = (key: RewardsKey, scope: ScopeState) =>
    setState((previous) => ({ ...previous, scopes: { ...previous.scopes, [key]: scope } }));

  const updateSsTier = (index: number, update: Partial<SetSavingsTierRow>) =>
    setSs({ ladderPreset: "custom", tiers: state.ss.tiers.map((row, i) => (i === index ? { ...row, ...update } : row)) });
  const removeSsTier = (index: number) =>
    setSs({ ladderPreset: "custom", tiers: state.ss.tiers.filter((_, i) => i !== index) });
  const addSsTier = () => {
    const lastCount = Number(state.ss.tiers[state.ss.tiers.length - 1]?.count ?? "1");
    const nextCount = Number.isInteger(lastCount) ? lastCount + 1 : 2;
    setSs({
      ladderPreset: "custom",
      tiers: [...state.ss.tiers, { count: String(nextCount), pct: "", code: `SET${nextCount}` }],
    });
  };
  const applyLadderPreset = (preset: LadderPresetKey) => {
    if (preset === "custom") {
      setSs({ ladderPreset: "custom" });
      return;
    }
    setSs({
      ladderPreset: preset,
      tiers: presets.ladders[preset].map((tier) => ({ count: String(tier.count), pct: String(tier.pct), code: tier.code })),
    });
  };

  const updateGtTier = (index: number, update: Partial<GiftTierRow>) =>
    setGt({ giftPreset: "custom", tiers: state.gt.tiers.map((row, i) => (i === index ? { ...row, ...update } : row)) });
  const removeGtTier = (index: number) =>
    setState((previous) => ({
      ...previous,
      gt: {
        ...previous.gt,
        giftPreset: "custom",
        tiers: previous.gt.tiers.filter((_, i) => i !== index),
        thresholds: Object.fromEntries(
          Object.entries(previous.gt.thresholds).map(([handle, row]) => [
            handle,
            { ...row, amounts: row.amounts.filter((_, i) => i !== index) },
          ]),
        ),
      },
    }));
  const addGtTier = () => {
    const last = Number(state.gt.tiers[state.gt.tiers.length - 1]?.amount ?? "0");
    setState((previous) => ({
      ...previous,
      gt: {
        ...previous.gt,
        giftPreset: "custom",
        tiers: [
          ...previous.gt.tiers,
          {
            amount: Number.isFinite(last) && last > 0 ? String(Math.round(last * 1.5)) : "",
            slots: [[{ kind: "samples", variantId: "", handle: "", count: "2" }]],
          },
        ],
        thresholds: Object.fromEntries(
          Object.entries(previous.gt.thresholds).map(([handle, row]) => [handle, { ...row, amounts: [...row.amounts, ""] }]),
        ),
      },
    }));
  };
  const updateSlots = (tier: number, slots: GiftOptionRow[][]) => updateGtTier(tier, { slots });
  const updateOption = (tier: number, slot: number, option: number, update: Partial<GiftOptionRow>) =>
    setState((previous) => ({
      ...previous,
      gt: {
        ...previous.gt,
        giftPreset: "custom",
        tiers: previous.gt.tiers.map((row, ti) =>
          ti !== tier
            ? row
            : {
                ...row,
                slots: row.slots.map((s, si) =>
                  si !== slot ? s : s.map((o, oi) => (oi !== option ? o : { ...o, ...update })),
                ),
              },
        ),
      },
    }));
  const setThresholdAmount = (handle: string, currencyCode: string, index: number, value: string) =>
    setState((previous) => {
      const row = previous.gt.thresholds[handle] ?? { amounts: previous.gt.tiers.map(() => ""), currencyCode };
      const amounts = [...row.amounts];
      while (amounts.length < previous.gt.tiers.length) amounts.push("");
      amounts[index] = value;
      return {
        ...previous,
        gt: {
          ...previous.gt,
          thresholds: {
            ...previous.gt.thresholds,
            [handle]: { amounts: amounts.slice(0, previous.gt.tiers.length), currencyCode },
          },
        },
      };
    });
  const clearThreshold = (handle: string) =>
    setState((previous) => {
      const thresholds = { ...previous.gt.thresholds };
      delete thresholds[handle];
      return { ...previous, gt: { ...previous.gt, thresholds } };
    });
  const toggleWarehouse = (handle: string, locationId: string, checked: boolean) =>
    setState((previous) => {
      const current = new Set(previous.gt.warehouse[handle] ?? []);
      if (checked) current.add(locationId);
      else current.delete(locationId);
      const ordered = locations.map((l) => l.id).filter((id) => current.has(id)).slice(0, CAPS.warehouseLocations);
      const warehouse = { ...previous.gt.warehouse };
      if (ordered.length === 0) delete warehouse[handle];
      else warehouse[handle] = ordered;
      return { ...previous, gt: { ...previous.gt, warehouse } };
    });
  const registerVariant = (variant: VariantSummary) =>
    setVariantIndex((previous) => ({ ...previous, [variant.id]: variant }));

  // ---- Validation ---------------------------------------------------------
  const ssValidation = validateSetSavingsRows(state.ss.tiers);
  const checkoutMessageError =
    Array.from(state.ss.checkoutMessage).length > CAPS.checkoutMessage
      ? `At most ${CAPS.checkoutMessage} characters`
      : undefined;
  const gtValidation = validateGiftTierRows(state.gt.tiers);
  const thresholdErrors = validateThresholdRows(state.gt.thresholds, state.gt.tiers.length);
  const maxGiftLinesError = intError(state.gt.maxGiftLines, 1, CAPS.maxGiftLines);
  const stockDaysError = intError(state.gt.stockFloorDays, 0, 60);
  const stockMinError = intError(state.gt.stockFloorMinUnits, 0, 100000);
  const poolError = samplePoolError(state.gt.samplePool, poolCap);

  /** Every problem that disables Save, with the tab (and Advanced section)
   *  that holds it — the "Fix these before saving" banner (F2). */
  const saveProblems: { tab: number; advanced: boolean; label: string }[] = [];
  if (ssValidation.formErrors.length > 0 || ssValidation.rowErrors.some((r) => r.count || r.pct || r.code)) {
    saveProblems.push({ tab: 0, advanced: false, label: "Set savings → Tiers table" });
  }
  if (checkoutMessageError !== undefined) {
    saveProblems.push({ tab: 0, advanced: true, label: "Set savings → Advanced → Checkout line text" });
  }
  if (gtValidation.formErrors.length > 0 || gtValidation.tierErrors.some((t) => t.amount || t.tier || t.slots.some((s) => s.some((o) => o !== "")))) {
    saveProblems.push({ tab: 1, advanced: false, label: "Free gifts → Tiers" });
  }
  if (Object.keys(thresholdErrors).length > 0) {
    saveProblems.push({ tab: 1, advanced: true, label: "Free gifts → Advanced → Amounts per market" });
  }
  if (maxGiftLinesError !== undefined) {
    saveProblems.push({ tab: 1, advanced: true, label: "Free gifts → Advanced → Maximum gift lines" });
  }
  if (stockDaysError !== undefined || stockMinError !== undefined) {
    saveProblems.push({ tab: 1, advanced: true, label: "Free gifts → Advanced → Stock floor" });
  }
  if (poolError !== undefined) {
    saveProblems.push({ tab: 1, advanced: true, label: "Free gifts → Advanced → Sample pool" });
  }
  const hasErrors = saveProblems.length > 0;
  const openProblem = (problem: { tab: number; advanced: boolean }) => {
    setTab(problem.tab);
    if (problem.advanced) setAdvancedSignal((n) => n + 1);
  };

  // ---- Save / discard -----------------------------------------------------
  const handleSave = () => {
    const tierCount = state.gt.tiers.length;
    const patch: DeepPartial<BoosterSettings> = {
      rewards: {
        setSavings: {
          enabled: state.ss.enabled,
          ladderPreset: state.ss.ladderPreset,
          tiers: state.ss.tiers.map((row) => ({
            count: Number(row.count),
            pct: Number(row.pct),
            code: row.code.trim().toUpperCase(),
          })),
          yieldToCodes: normalizeYieldCodes(state.ss.yieldToCodes, state.ss.tiers).codes,
          includeSubscriptions: state.ss.includeSubscriptions,
          surfaces: { ...state.ss.surfaces },
          setSavingsExcludedByMarket: state.ss.excluded,
          checkoutMessage: state.ss.checkoutMessage.trim(),
        },
        giftTiers: {
          enabled: state.gt.enabled,
          giftPreset: state.gt.giftPreset,
          cumulative: state.gt.cumulative,
          choice: state.gt.choice,
          maxGiftLines: Number(state.gt.maxGiftLines),
          sampleRule: state.gt.sampleRule,
          showShippingMilestone: state.gt.showShippingMilestone,
          tiers: state.gt.tiers.map((row) => ({
            amount: Number(row.amount),
            slots: row.slots.map((slot) =>
              slot.map((option) =>
                option.kind === "samples"
                  ? { kind: "samples" as const, variantId: "", handle: "", count: Number(option.count) }
                  : { kind: "variant" as const, variantId: option.variantId, handle: option.handle, count: 1 },
              ),
            ),
          })),
          giftThresholdsByMarket: Object.fromEntries(
            Object.entries(state.gt.thresholds)
              .filter(([, row]) => row.amounts.some((a) => a.trim() !== ""))
              .map(([handle, row]) => [
                handle,
                { amounts: row.amounts.slice(0, tierCount).map((a) => Number(a)), currencyCode: row.currencyCode },
              ]),
          ),
          samplePool: state.gt.samplePool.map((entry) => ({ ...entry })),
          warehouseByMarket: Object.fromEntries(Object.entries(state.gt.warehouse).filter(([, ids]) => ids.length > 0)),
          stockFloor: { days: Number(state.gt.stockFloorDays), minUnits: Number(state.gt.stockFloorMinUnits) },
        },
        freeShip: {
          enabled: state.fs.enabled,
          minUnits: Number(state.fs.minUnits),
          byThreshold: state.fs.byThreshold,
          scope: toScopePatch(state.fs.scope),
        },
      },
      marketScopes: {
        set_savings: toScopePatch(state.scopes.set_savings),
        gift_tiers: toScopePatch(state.scopes.gift_tiers),
      },
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };
  const handleDiscard = () => setState(initial);

  const runIntent = (
    fetcher: ReturnType<typeof useFetcher<typeof action>>,
    intent: string,
    extra: Record<string, string> = {},
  ) => {
    const formData = new FormData();
    formData.set("intent", intent);
    for (const [key, value] of Object.entries(extra)) formData.set(key, value);
    fetcher.submit(formData, { method: "post" });
  };

  const goToMarkets = () => {
    setTab(2);
    if (typeof document !== "undefined") {
      setTimeout(() => document.getElementById("market-targeting")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  };
  const openPreview = () => navigate("/app/preview?feature=set_savings,gift_tiers");

  // ---- Readiness checklist ------------------------------------------------
  const ladderCodes = state.ss.tiers.map((row) => row.code.trim().toUpperCase()).filter((c) => CODE_PATTERN.test(c));
  const missingCodes = ladderCodes.filter((code) => !nodesView.kit[code]);
  const codesReady = missingCodes.length === 0 && nodesView.gift !== "";
  // Collisions: the fresh Connect result when there is one, else the
  // persisted server-written list (rewards.setSavings.blockedCodes).
  const collisionErrors =
    connectResult && connectResult.errors.length > 0
      ? connectResult.errors
      : blockedCodes.map(
          (code) =>
            `Code ${code} is used by another discount in your store — not created; change it in the Set savings tab (the app never touches that discount).`,
        );

  const giftOptions = state.gt.tiers.flatMap((t) => t.slots.flatMap((s) => s));
  /** v15.1 (F3): a handle-only option (presets ship handles) is CONFIGURED —
   *  the server resolves it through hv and the storefront through cart-data;
   *  it is "unresolved" only when it names nothing at all or a variant the
   *  store no longer knows. */
  const handleKnown = (handle: string) =>
    Boolean(hv[handle]) || Object.values(variantIndex).some((v) => v.productHandle === handle);
  const unresolvedGifts = giftOptions.filter(
    (o) =>
      o.kind === "variant" &&
      (o.variantId !== "" ? !variantIndex[o.variantId] && !handleKnown(o.handle) : o.handle === ""),
  );
  const handleOnlyGifts = giftOptions.filter((o) => o.kind === "variant" && o.variantId === "" && o.handle !== "");
  const giftsConfigured = state.gt.tiers.length > 0 && unresolvedGifts.length === 0 && !gtValidation.tierErrors.some((t) => t.amount || t.tier);
  const stockChecked = stockView.t !== "";
  const usePresetNow = () => {
    setTab(1);
    runIntent(defaultsFetcher, "load_defaults", { preset: giftPresetChoice });
  };

  const ssLive = state.ss.enabled ? scopeMarketCount(state.scopes.set_savings, markets) : 0;
  const gtLive = state.gt.enabled ? scopeMarketCount(state.scopes.gift_tiers, markets) : 0;
  const liveMarkets = new Set<string>();
  if (state.ss.enabled) {
    (state.scopes.set_savings.mode === "all" ? markets.map((m) => m.handle) : state.scopes.set_savings.markets).forEach((h) =>
      liveMarkets.add(h),
    );
  }
  if (state.gt.enabled) {
    (state.scopes.gift_tiers.mode === "all" ? markets.map((m) => m.handle) : state.scopes.gift_tiers.markets).forEach((h) =>
      liveMarkets.add(h),
    );
  }
  const liveCount = [...liveMarkets].filter((h) => markets.some((m) => m.handle === h)).length;

  const readinessRows: ReadinessRow[] = [
    {
      id: "codes",
      title: "Discount codes created",
      tone: codesReady ? "success" : connectResult && !connectResult.ok ? "critical" : "attention",
      badge: codesReady ? "Done" : "To do",
      sentence: codesReady
        ? `Shopify knows ${ladderCodes.join(", ")} plus the free-gift discount. Press the button again after changing a tier.`
        : !functionId && !nodesView.gift
          ? "The app's discounts do not exist in Shopify yet — press the button once. Nothing works at checkout until then."
          : `Missing: ${[...missingCodes, ...(nodesView.gift ? [] : ["free gifts"])].join(", ") || "nothing"} — press the button to create them.`,
      details: [
        `Codes the app will create or update: ${ladderCodes.length > 0 ? ladderCodes.join(", ") : "none (add a tier first)"}; plus one automatic free-gift discount.`,
        "Discounts you created yourself (for example KIT2 or KIT5) are never changed or deleted. If one of them uses the same code as a tier, you will see it here — change the code in the tier table, or delete that discount yourself.",
        ...(connectResult && connectResult.ok ? [connectResult.summary] : []),
      ],
      errors: collisionErrors,
      action: {
        label: codesReady ? "Update discount codes" : "Create discount codes",
        onClick: () => runIntent(connectFetcher, "connect_rewards"),
        loading: connectFetcher.state !== "idle",
        disabled: dirty || isSaving,
        disabledReason: dirty ? "Save your changes first — the button uses the saved tiers." : undefined,
      },
    },
    {
      id: "gifts",
      title: "Gifts configured",
      tone: state.gt.tiers.length === 0 ? "attention" : giftsConfigured && stockChecked ? "success" : "attention",
      badge: giftsConfigured && stockChecked ? "Done" : "To do",
      sentence:
        state.gt.tiers.length === 0
          ? "No gift tier yet — press “Use this preset” to load the recommended gifts, then Save."
          : unresolvedGifts.length > 0
            ? `${unresolvedGifts.length} gift${unresolvedGifts.length === 1 ? "" : "s"} still point${unresolvedGifts.length === 1 ? "s" : ""} to no product — open the Free gifts tab and pick a product for each.`
            : handleOnlyGifts.length > 0 && !stockChecked
              ? `${handleOnlyGifts.length} gift${handleOnlyGifts.length === 1 ? " is" : "s are"} named by product and looked up in your store automatically — press “Use this preset” once to pin them to your real products, then Save.`
              : !stockChecked
                ? "Every gift is a real product; stock has not been checked yet — save, then use “Check stock now” under Advanced in the Free gifts tab."
                : `${state.gt.tiers.length} tier${state.gt.tiers.length === 1 ? "" : "s"}, every gift is a real product, stock checked ${stockView.t.replace("T", " ").slice(0, 16)} UTC.`,
      action:
        state.gt.tiers.length === 0 || (handleOnlyGifts.length > 0 && unresolvedGifts.length === 0)
          ? {
              label: "Use this preset",
              onClick: usePresetNow,
              loading: defaultsFetcher.state !== "idle",
              disabled: isSaving,
            }
          : { label: "Open Free gifts", onClick: () => setTab(1) },
    },
    {
      id: "preview",
      title: "Preview looks right",
      tone: "info",
      badge: "Check",
      sentence:
        "Open the preview and walk through a cart. Previews only show in your own browser session — live shoppers never see them.",
      action: { label: "Open the preview", onClick: openPreview },
    },
    {
      id: "live",
      title: `Live in ${liveCount} market${liveCount === 1 ? "" : "s"}`,
      tone: liveCount > 0 ? "success" : "attention",
      badge: liveCount > 0 ? "Live" : "Not live",
      sentence:
        liveCount > 0
          ? `Set savings: ${ssLive} market${ssLive === 1 ? "" : "s"} · Free gifts: ${gtLive} market${gtLive === 1 ? "" : "s"}${dirty ? " (after you Save)" : ""}.`
          : "Nothing is live yet — turn a feature on in its tab, tick its markets, then Save.",
      action: { label: "Open Markets & go live", onClick: goToMarkets },
    },
  ];

  const volumePcts = (() => {
    const pcts = settings.cartUpsell.volumeOffers.map((offer) => offer.discountPct).filter((pct) => Number.isFinite(pct) && pct > 0);
    return pcts.length > 0 ? pcts : [15, 20];
  })();
  const marketName = (handle: string) => markets.find((m) => m.handle === handle)?.name ?? handle;
  const explicitFreeShip = Object.entries(settings.freeShipping.byMarket)
    .map(([handle, t]) => `${marketName(handle)}: ${t.amount} ${t.currencyCode}`)
    .slice(0, 8);

  return (
    <Page
      title="Rewards"
      subtitle="Set savings and free gifts"
      backAction={{ content: "Features", url: "/app/features" }}
      primaryAction={{ content: "Save", onAction: handleSave, disabled: !dirty || hasErrors, loading: isSaving }}
      secondaryActions={[{ content: "Discard", onAction: handleDiscard, disabled: !dirty || isSaving }]}
    >
      <TitleBar title="Rewards" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="set_savings"
              previewFeatureKeys={["set_savings", "gift_tiers"]}
              enabled={headerEnabled}
              statusLabel={headerLabel}
              reachCaption={`Set savings: ${reachCaption(state.scopes.set_savings, markets)} · Free gifts: ${reachCaption(state.scopes.gift_tiers, markets)}`}
            />
          </Card>
        </Layout.Section>

        {saveResult && saveResult.syncErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone={saveResult.ok ? "warning" : "critical"}
              title={saveResult.ok ? "Saved, but the storefront could not be fully updated" : "Settings could not be saved"}
            >
              <BlockStack gap="100">
                {saveResult.syncErrors.map((error) => (
                  <Text as="p" key={error}>
                    {error}
                  </Text>
                ))}
                {saveResult.ok ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Press Save again in a moment; if it keeps failing, send this message to support.
                  </Text>
                ) : null}
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <ReadinessCard rows={readinessRows} />
        </Layout.Section>

        {hasErrors ? (
          <Layout.Section>
            <Banner tone="warning" title="Fix these before saving">
              <BlockStack gap="100">
                {saveProblems.map((problem) => (
                  <InlineStack key={problem.label} gap="200" blockAlign="center">
                    <Button variant="plain" onClick={() => openProblem(problem)}>
                      {problem.label}
                    </Button>
                  </InlineStack>
                ))}
                <Text as="p" tone="subdued" variant="bodySm">
                  Save stays off until every field above is valid. Click a line to open it.
                </Text>
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <div id="market-targeting">
            <Tabs tabs={TABS} selected={tab} onSelect={setTab}>
              <Box paddingBlockStart="400">
                {tab === 0 ? (
                  <SetSavingsTab
                    ss={state.ss}
                    setSs={setSs}
                    updateTier={updateSsTier}
                    removeTier={removeSsTier}
                    addTier={addSsTier}
                    applyLadderPreset={applyLadderPreset}
                    presets={presets}
                    rowErrors={ssValidation.rowErrors}
                    formErrors={ssValidation.formErrors}
                    checkoutMessageError={checkoutMessageError}
                    blockedCodes={blockedCodes}
                    advancedSignal={advancedSignal}
                    nodes={nodesView}
                    markets={markets}
                    reach={reachCaption(state.scopes.set_savings, markets)}
                    onEditMarkets={goToMarkets}
                    exclusionTitles={exclusionTitles}
                    disabled={isSaving}
                    volumePcts={volumePcts}
                    onDetectCodes={(prefixes) => runIntent(detectFetcher, "detect_codes", { prefixes })}
                    detectLoading={detectFetcher.state !== "idle"}
                    detectResult={detectResult ? { ok: detectResult.ok, codes: detectResult.codes, errors: detectResult.errors } : null}
                  />
                ) : null}
                {tab === 1 ? (
                  <GiftsTab
                    gt={state.gt}
                    setGt={setGt}
                    presets={presets}
                    variantIndex={variantIndex}
                    registerVariant={registerVariant}
                    updateTier={updateGtTier}
                    removeTier={removeGtTier}
                    addTier={addGtTier}
                    updateSlots={updateSlots}
                    updateOption={updateOption}
                    setThresholdAmount={setThresholdAmount}
                    clearThreshold={clearThreshold}
                    toggleWarehouse={toggleWarehouse}
                    tierErrors={gtValidation.tierErrors}
                    formErrors={gtValidation.formErrors}
                    thresholdErrors={thresholdErrors}
                    maxGiftLinesError={maxGiftLinesError}
                    stockDaysError={stockDaysError}
                    stockMinError={stockMinError}
                    poolError={poolError}
                    poolNote={poolNote}
                    poolCap={poolCap}
                    advancedSignal={advancedSignal}
                    markets={markets}
                    locations={locations}
                    reach={reachCaption(state.scopes.gift_tiers, markets)}
                    onEditMarkets={goToMarkets}
                    giftPresetChoice={giftPresetChoice}
                    setGiftPresetChoice={setGiftPresetChoice}
                    onLoadPreset={(preset) => runIntent(defaultsFetcher, "load_defaults", { preset })}
                    presetLoading={defaultsFetcher.state !== "idle"}
                    presetNotes={defaultsResult?.errors ?? []}
                    onLoadSachets={() => runIntent(sachetsFetcher, "load_sachets")}
                    sachetsLoading={sachetsFetcher.state !== "idle"}
                    sachetsErrors={sachetsResult?.errors ?? []}
                    onSuggestAmounts={() =>
                      runIntent(suggestFetcher, "suggest_thresholds", {
                        eurAmounts: JSON.stringify(state.gt.tiers.map((t) => Number(t.amount) || 0)),
                      })
                    }
                    suggestLoading={suggestFetcher.state !== "idle"}
                    suggestNotes={suggestResult?.errors ?? []}
                    onRefreshStock={() => runIntent(stockFetcher, "refresh_stock")}
                    stockLoading={stockFetcher.state !== "idle"}
                    stockView={stockView}
                    stockNote={stockNote}
                    stockErrors={stockResult?.errors ?? []}
                  />
                ) : null}
                {tab === 2 ? (
                  <MarketsTab
                    markets={markets}
                    scopes={state.scopes}
                    setScope={setScope}
                    ssEnabled={state.ss.enabled}
                    gtEnabled={state.gt.enabled}
                    fsEnabled={state.fs.enabled}
                    fsScope={state.fs.scope}
                    onPreview={openPreview}
                  />
                ) : null}
              </Box>
            </Tabs>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
