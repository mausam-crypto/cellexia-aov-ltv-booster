import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import type { ShouldRevalidateFunctionArgs } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  DataTable,
  Divider,
  InlineStack,
  Layout,
  Page,
  Select,
  Spinner,
  Tag,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { DeleteIcon, ImageIcon, PlusIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  GIFT_PRESETS,
  GIFT_PRESET_KEYS,
  LADDER_PRESETS,
  LADDER_PRESET_KEYS,
  LEGACY_KIT_CODES,
  getSettings,
  resolveFeatureFlag,
  saveSettings,
  validateFreeShipPatch,
  validateGiftTiersPatch,
  validateSetSavingsPatch,
  type BoosterSettings,
  type DeepPartial,
  type GiftTier,
  type GiftChoiceMode,
  type GiftSampleRule,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import {
  connectRewardsDiscounts,
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
import { MarketProductExclusionsCard } from "../components/MarketExclusions";
import type { loader as variantsLoader } from "./app.api.variants";

/**
 * Rewards (v14, docs/SPEC-v14-rewards.md §11) — feature settings page for
 * the three `rewards.*` sections: set savings (KIT tier codes), gift tiers
 * (spend-based free gifts, per-market amounts, stock awareness) and the
 * free-shipping guarantee. Modeled on the cart / delivery pages: the same
 * fail-loud validation (the settings.server.ts validators run BEFORE
 * saveSettings — invalid input is refused, never silently trimmed), the same
 * save bar + serializeForCompare dirty tracking, the same duplicated
 * MarketScopeCard, the same exclusions card + search_products fetcher.
 *
 * Extra intents on this action (each returns its own `intent`-tagged
 * envelope; the toast/Banner contract reads only settings-save results):
 *   connect_rewards    — connectRewardsDiscounts (KIT codes + automatic nodes)
 *   suggest_thresholds — pricing-aware per-market gift amounts (fills the
 *                        form, unsaved until Save)
 *   refresh_stock      — refreshGiftStock (stock table)
 *   load_defaults      — a GIFT_PRESETS entry (form field `preset`, default
 *                        value_first) with live GIDs
 *   load_sachets       — products tagged sample-sachet → samplePool
 *
 * Every settings save runs refreshUnitMap BEFORE syncSettingsToMetafields
 * (units / prot / giftPids current in the rewards metafield) and
 * refreshGiftStock AFTER (the paused set follows the new pool).
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
  products: {
    gid: string;
    title: string;
    imageUrl: string | null;
    status: string;
  }[];
}

interface DiscountNodesView {
  kit: Record<string, string>;
  gift: string;
  ship: string;
}

interface StockView {
  t: string;
  byMarket: Record<string, Record<string, { avail: number; paused: boolean }>>;
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
    };

type ActionResult =
  | SettingsSaveResult
  | ProductSearchResult
  | RewardsIntentResult;

// ---------------------------------------------------------------------------
// Shared validation shapes (mirrored client-side for instant feedback —
// the authoritative validators live in settings.server.ts)
// ---------------------------------------------------------------------------

const KIT_CODE_PATTERN = /^[A-Z0-9_-]{2,32}$/;
const CAPS = {
  setSavingsTiers: 6,
  giftTiers: 4,
  giftSlots: 3,
  giftOptionsPerSlot: 3,
  samplesPerOption: 6,
  samplePool: 12,
  thresholdAmountMax: 1000000,
  warehouseLocations: 6,
  maxGiftLines: 8,
  checkoutMessage: 60,
} as const;

/** Ladder preset keys the admin can pick ("custom" = the table is the truth). */
type LadderPresetKey = (typeof LADDER_PRESET_KEYS)[number];
/** Gift preset keys ("custom" once any tier is edited by hand). */
type GiftPresetKey = (typeof GIFT_PRESET_KEYS)[number] | "custom";
/** The two loadable gift presets (settings.server.ts GIFT_PRESETS). */
type LoadableGiftPreset = (typeof GIFT_PRESET_KEYS)[number];

const LADDER_PRESET_LABELS: Record<LadderPresetKey, string> = {
  compact: "Compact ladder — 2/3/4/6 products → 5/10/15/20 % (recommended, default)",
  extended: "Extended ladder — 2/3/5/10 products → 5/10/20/30 %",
  custom: "Custom (edit the table below)",
};

const LADDER_PRESET_RATIONALE: Record<LadderPresetKey, string> = {
  compact:
    "Compact: every next tier is at most two products away and the maximum stack stays under ~40 % together with the volume ladder.",
  extended: "Extended: the original brief's 30 % top tier (10 different products).",
  custom: "Custom: your own counts, percentages and codes — Connect creates whichever codes are listed.",
};

const GIFT_PRESET_LABELS: Record<GiftPresetKey, string> = {
  value_first:
    "Value-first (recommended): 119 € towels + 2 samples · 200 € Jawline cream + 2 samples · 350 € cosmetic bag + 3 samples",
  cream_first:
    "Cream-first: 119 € Jawline cream + 2 samples · 200 € towels + 2 samples · 350 € cosmetic bag + 3 samples",
  custom: "Custom",
};

const GIFT_PRESET_BADGES: Record<GiftPresetKey, string> = {
  value_first: "Value-first",
  cream_first: "Cream-first",
  custom: "Custom",
};

/** Client-safe preset tables (the settings.server.ts values ride the loader —
 *  a route module must not use server-module VALUES in client code). */
interface PresetTables {
  ladderKeys: readonly LadderPresetKey[];
  ladders: Record<Exclude<LadderPresetKey, "custom">, { count: number; pct: number; code: string }[]>;
  giftKeys: readonly LoadableGiftPreset[];
  /** v14.3: every KIT code that ever shipped in a ladder preset (settings.server.ts LEGACY_KIT_CODES). */
  legacyCodes: readonly string[];
}

/** v14.3 alias rule, mirrored from the server: legacy codes minus the ladder
 *  codes (upper-cased, deduped) when keepLegacyCodes is on, else none. */
function computeAliasCodes(
  legacyCodes: readonly string[],
  tiers: readonly { code: string }[],
  keepLegacyCodes: boolean,
): string[] {
  if (!keepLegacyCodes) return [];
  const ladder = new Set(tiers.map((t) => t.code.trim().toUpperCase()));
  const out: string[] = [];
  for (const raw of legacyCodes) {
    const code = raw.trim().toUpperCase();
    if (code && !ladder.has(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

function isLoadableGiftPreset(
  value: unknown,
  keys: readonly string[],
): value is LoadableGiftPreset {
  return keys.includes(String(value));
}

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
  // Unit map FIRST so the rewards metafield projects current units / prot /
  // giftPids (SPEC §2.2) — fail-soft: a failed refresh keeps the last map.
  try {
    const units = await refreshUnitMap(admin, shop);
    if (!units.ok) syncErrors.push(...units.errors);
  } catch (error) {
    syncErrors.push(
      error instanceof Error
        ? `Unit map: ${error.message}`
        : "Could not refresh the product unit map.",
    );
  }
  try {
    const sync = await syncSettingsToMetafields(admin, next);
    syncErrors.push(...sync.errors);
  } catch (error) {
    syncErrors.push(
      error instanceof Error
        ? error.message
        : "Could not sync settings to storefront metafields.",
    );
  }
  // Stock AFTER the save: the paused set follows the new gift pool /
  // warehouse map / floor.
  try {
    const stock = await refreshGiftStock(admin, shop, next);
    if (!stock.ok) syncErrors.push(...stock.errors);
  } catch (error) {
    syncErrors.push(
      error instanceof Error
        ? `Gift stock: ${error.message}`
        : "Could not refresh gift stock.",
    );
  }
  return { ok: true, syncErrors };
}

// ---------------------------------------------------------------------------
// Admin API helpers local to this route (Load defaults / Load sachets /
// locations) — small queries; nothing here is shared with other routes.
// ---------------------------------------------------------------------------

const LOCATIONS_QUERY = `#graphql
  query cellexiaRewardsLocations {
    locations(first: 20, query: "active:true") {
      nodes {
        id
        name
        address { countryCode }
      }
    }
  }
`;

const PRODUCT_BY_HANDLE_QUERY = `#graphql
  query cellexiaRewardsProductByHandle($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      handle
      status
      featuredImage { url }
      variants(first: 1) {
        nodes { id title price availableForSale image { url } }
      }
    }
  }
`;

const SACHET_PRODUCTS_QUERY = `#graphql
  query cellexiaRewardsSachets {
    products(first: 12, query: "tag:sample-sachet status:active") {
      nodes {
        id
        title
        handle
        featuredImage { url }
        variants(first: 1) {
          nodes { id title price availableForSale image { url } }
        }
      }
    }
  }
`;

interface LocationOption {
  id: string;
  name: string;
  countryCode: string;
}

interface ProductNode {
  id: string;
  title: string;
  handle: string;
  status?: string;
  featuredImage: { url: string } | null;
  variants: {
    nodes: {
      id: string;
      title: string;
      price: string;
      availableForSale: boolean;
      image: { url: string } | null;
    }[];
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
        locations?: {
          nodes?: {
            id: string;
            name: string;
            address?: { countryCode?: string | null } | null;
          }[];
        };
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

async function productByHandle(
  admin: AdminGraphqlClient,
  handle: string,
): Promise<ProductNode | null> {
  const response = await admin.graphql(PRODUCT_BY_HANDLE_QUERY, {
    variables: { handle },
  });
  const json = (await response.json()) as {
    data?: { productByHandle?: ProductNode | null };
  };
  return json.data?.productByHandle ?? null;
}

/** Resolve the handles of a GIFT_PRESETS entry to live variant GIDs; the
 *  preset shape (amounts, slot order, sample counts) is kept as shipped. */
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
              errors.push(`Product "${option.handle}" was not found in the store — the tier keeps the handle only.`);
            } else {
              variantId = summary.id;
              variants.push(summary);
              handleCache.set(option.handle, summary.id);
              if (product.status && product.status !== "ACTIVE") {
                errors.push(`Product "${option.handle}" is ${product.status.toLowerCase()} — publish it before going live.`);
              }
            }
          } catch (error) {
            errors.push(
              `Lookup of "${option.handle}" failed: ${error instanceof Error ? error.message : String(error)}`,
            );
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

async function loadSachetPool(
  admin: AdminGraphqlClient,
): Promise<{ pool: { variantId: string; handle: string }[]; variants: VariantSummary[]; errors: string[] }> {
  try {
    const response = await admin.graphql(SACHET_PRODUCTS_QUERY);
    const json = (await response.json()) as {
      data?: { products?: { nodes?: ProductNode[] } };
      errors?: { message: string }[];
    };
    if (json.errors?.length) {
      return { pool: [], variants: [], errors: json.errors.map((e) => e.message) };
    }
    const variants: VariantSummary[] = [];
    const pool: { variantId: string; handle: string }[] = [];
    for (const product of json.data?.products?.nodes ?? []) {
      const summary = firstVariantSummary(product);
      if (!summary) continue;
      variants.push(summary);
      pool.push({ variantId: summary.id, handle: product.handle });
      if (pool.length >= CAPS.samplePool) break;
    }
    return {
      pool,
      variants,
      errors:
        pool.length === 0
          ? ["No active product carries the sample-sachet tag."]
          : [],
    };
  } catch (error) {
    return {
      pool: [],
      variants: [],
      errors: [error instanceof Error ? error.message : "Could not list sachets."],
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
  // Lazy stock refresh (SPEC §3: "lazily from the Rewards loader when older
  // than 15 min") — fail-soft: a failed refresh keeps the stored table.
  if (giftStockIsStale(rewardsState.giftStock)) {
    try {
      const refreshed = await refreshGiftStock(admin, session.shop, settings);
      if (refreshed.data) {
        rewardsState = { ...rewardsState, giftStock: refreshed.data };
      }
      if (!refreshed.ok) stockNote = refreshed.errors.join(" ");
    } catch (error) {
      stockNote = error instanceof Error ? error.message : "Stock refresh failed.";
    }
  }
  const [exclusionTitles, giftVariants] = await Promise.all([
    getProductTitlesByIds(
      admin,
      Object.values(settings.rewards.setSavings.setSavingsExcludedByMarket).flat(),
    ).catch(() => ({}) as Record<string, string>),
    getVariantsByIds(admin, giftVariantGids(settings)).catch(
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
      legacyCodes: LEGACY_KIT_CODES,
    } satisfies PresetTables,
    nodes: {
      kit: rewardsState.nodes.kit,
      gift: rewardsState.nodes.gift,
      ship: rewardsState.nodes.ship,
    } satisfies DiscountNodesView,
    functionId: rewardsState.functionId,
    giftStock: {
      t: rewardsState.giftStock.t,
      byMarket: rewardsState.giftStock.byMarket,
    } satisfies StockView,
    stockNote,
    headerEnabled: ssOn || gtOn,
    headerLabel:
      ssOn && gtOn
        ? "Both active"
        : ssOn
          ? "Set savings active"
          : gtOn
            ? "Gift tiers active"
            : "Off",
  };
};

/**
 * Picker searches and the form-filling intents (suggest / load defaults /
 * load sachets) are read-only lookups whose results land in UNSAVED form
 * state — a loader revalidation after them would reset the form. Connect and
 * refresh_stock mutate RewardsState and DO revalidate (the form only resets
 * on saved-settings CONTENT changes, see settingsKey below).
 */
export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  const intent = formData?.get("intent");
  if (
    intent === "search_products" ||
    intent === "suggest_thresholds" ||
    intent === "load_defaults" ||
    intent === "load_sachets"
  ) {
    return false;
  }
  return defaultShouldRevalidate;
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent === "search_products") {
    const result = await listProductsWithBoosterStatus(
      admin,
      String(formData.get("q") ?? ""),
    );
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
    const result = await connectRewardsDiscounts(admin, session.shop, settings, {
      replaceExisting: formData.get("replaceExisting") === "1",
    });
    const state = result.data ?? (await getRewardsState(session.shop));
    return {
      intent: "connect_rewards" as const,
      ok: result.ok,
      errors: result.errors,
      summary: result.summary,
      nodes: {
        kit: state.nodes.kit,
        gift: state.nodes.gift,
        ship: state.nodes.ship,
      },
    };
  }
  if (intent === "suggest_thresholds") {
    const settings = await getSettings(session.shop);
    // The suggestion follows the EUR amounts currently in the form (unsaved
    // edits included) so the merchant reviews one coherent table.
    const rawEur = formData.get("eurAmounts");
    if (typeof rawEur === "string" && rawEur.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(rawEur);
        if (
          Array.isArray(parsed) &&
          parsed.length === settings.rewards.giftTiers.tiers.length &&
          parsed.every((n) => typeof n === "number" && Number.isFinite(n))
        ) {
          settings.rewards.giftTiers.tiers = settings.rewards.giftTiers.tiers.map(
            (tier, index) => ({ ...tier, amount: parsed[index] as number }),
          );
        } else if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number")) {
          // Tier count changed in the form: build placeholder tiers so the
          // ratio math still yields one amount per form tier.
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
    const stock: GiftStockState =
      result.data ?? (await getRewardsState(session.shop)).giftStock;
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
    const preset: LoadableGiftPreset = isLoadableGiftPreset(rawPreset, GIFT_PRESET_KEYS)
      ? rawPreset
      : "value_first";
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
    };
  }
  return applySettingsPatch(session.shop, admin, formData.get("patch"));
};

// ---------------------------------------------------------------------------
// Market targeting card (duplicated across feature pages on purpose — route
// modules do not share UI components)
// ---------------------------------------------------------------------------

interface ScopeState {
  mode: "all" | "selected";
  markets: string[];
}

function toScopeState(
  scope: { mode: "all" | "selected"; markets: string[] } | undefined,
): ScopeState {
  return scope && scope.mode === "selected"
    ? { mode: "selected", markets: [...scope.markets] }
    : { mode: "all", markets: [] };
}

/** Scope as persisted — an "all" scope never stores a markets list. The UI
 *  keeps the previous hand-picked list in local state so flipping back to
 *  "Selected markets" restores it; only the save patch strips it. */
function toScopePatch(scope: ScopeState): ScopeState {
  return scope.mode === "all" ? { mode: "all", markets: [] } : scope;
}

interface MarketOption {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
  primary: boolean;
  currencyCode: string;
}

interface MarketScopeCardProps {
  title: string;
  markets: MarketOption[];
  scope: ScopeState;
  onChange: (scope: ScopeState) => void;
}

function MarketScopeCard({
  title,
  markets,
  scope,
  onChange,
}: MarketScopeCardProps) {
  const allHandles = markets.map((market) => market.handle);
  const handleModeChange = (selected: string[]) => {
    const mode = selected[0] === "selected" ? "selected" : "all";
    if (mode === scope.mode) return;
    onChange(
      mode === "all"
        ? // Keep the hand-picked list in local state so switching back to
          // "Selected markets" restores it — the save patch strips it.
          { mode: "all", markets: [...scope.markets] }
        : {
            mode: "selected",
            markets:
              scope.markets.length > 0 ? [...scope.markets] : [...allHandles],
          },
    );
  };
  const toggleMarket = (handle: string, checked: boolean) => {
    const set = new Set(scope.markets);
    if (checked) set.add(handle);
    else set.delete(handle);
    const ordered = allHandles.filter((other) => set.has(other));
    for (const other of set) {
      if (!allHandles.includes(other)) ordered.push(other);
    }
    onChange({ mode: "selected", markets: ordered });
  };
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {title}
        </Text>
        <Text as="p" tone="subdued" variant="bodySm">
          Limit which markets can see this feature. It must also be enabled
          above to appear anywhere.
        </Text>
        {markets.length === 0 ? (
          <Text as="p" tone="subdued" variant="bodySm">
            No markets could be loaded — the feature follows the “All markets”
            setting.
          </Text>
        ) : null}
        <ChoiceList
          title="Market visibility"
          titleHidden
          choices={[
            { label: "All markets", value: "all" },
            {
              label: "Selected markets",
              value: "selected",
              renderChildren: (isSelected: boolean) =>
                isSelected ? (
                  <BlockStack gap="100">
                    {markets.map((market) => (
                      <Checkbox
                        key={market.handle}
                        label={
                          market.primary
                            ? `${market.name} (primary)`
                            : market.name
                        }
                        helpText={market.handle}
                        checked={scope.markets.includes(market.handle)}
                        onChange={(checked) =>
                          toggleMarket(market.handle, checked)
                        }
                      />
                    ))}
                    {scope.markets.length === 0 ? (
                      <Text as="p" tone="critical" variant="bodySm">
                        No markets selected — this feature won’t appear
                        anywhere.
                      </Text>
                    ) : null}
                  </BlockStack>
                ) : null,
            },
          ]}
          selected={[scope.mode]}
          onChange={handleModeChange}
        />
      </BlockStack>
    </Card>
  );
}

/** Reach caption (the Amazon page's azReachCaption wording): "All markets",
 *  "N markets: names", or the hidden-everywhere warning. */
function reachCaption(
  scope: ScopeState,
  markets: { handle: string; name: string }[],
): string {
  if (scope.mode !== "selected") return "All markets";
  if (scope.markets.length === 0) return "No markets selected — hidden everywhere";
  const nameByHandle = new Map(markets.map((m) => [m.handle, m.name]));
  if (
    markets.length > 0 &&
    scope.markets.every((handle) => !nameByHandle.has(handle))
  ) {
    return "No markets selected — hidden everywhere";
  }
  const names = [...scope.markets]
    .sort()
    .map((handle) =>
      markets.length === 0
        ? handle
        : (nameByHandle.get(handle) ?? `${handle} (market not found)`),
    );
  const count = names.length === 1 ? "1 market" : `${names.length} markets`;
  return `${count}: ${names.join(", ")}`;
}

type RewardsKey = "set_savings" | "gift_tiers";

function marketAnchorId(key: RewardsKey): string {
  return `market-${key}`;
}

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface SetSavingsTierRow {
  count: string;
  pct: string;
  code: string;
}

interface GiftOptionRow {
  kind: "variant" | "samples";
  variantId: string;
  handle: string;
  count: string;
}

interface GiftTierRow {
  amount: string;
  slots: GiftOptionRow[][];
}

interface ThresholdRow {
  amounts: string[];
  currencyCode: string;
}

interface RewardsFormState {
  ss: {
    enabled: boolean;
    ladderPreset: LadderPresetKey;
    tiers: SetSavingsTierRow[];
    keepLegacyCodes: boolean;
    includeSubscriptions: boolean;
    surfaces: {
      pdpLine: boolean;
      similarCaption: boolean;
      fbtCaption: boolean;
      cartNudge: boolean;
      crossSellReframe: boolean;
    };
    checkoutMessage: string;
    excluded: Record<string, string[]>;
  };
  gt: {
    enabled: boolean;
    giftPreset: GiftPresetKey;
    cumulative: boolean;
    choice: GiftChoiceMode;
    maxGiftLines: string;
    sampleRule: GiftSampleRule;
    showShippingMilestone: boolean;
    tiers: GiftTierRow[];
    /** market handle -> per-tier amount strings ("" = no explicit amount) */
    thresholds: Record<string, ThresholdRow>;
    samplePool: { variantId: string; handle: string }[];
    warehouse: Record<string, string[]>;
    stockFloorDays: string;
    stockFloorMinUnits: string;
  };
  fs: {
    enabled: boolean;
    minUnits: string;
    byThreshold: boolean;
    scope: ScopeState;
  };
  scopes: Record<RewardsKey, ScopeState>;
}

function initialFormState(settings: BoosterSettings): RewardsFormState {
  const ss = settings.rewards.setSavings;
  const gt = settings.rewards.giftTiers;
  const fs = settings.rewards.freeShip;
  return {
    ss: {
      enabled: ss.enabled,
      ladderPreset: ss.ladderPreset,
      tiers: ss.tiers.map((tier) => ({
        count: String(tier.count),
        pct: String(tier.pct),
        code: tier.code,
      })),
      keepLegacyCodes: ss.keepLegacyCodes,
      includeSubscriptions: ss.includeSubscriptions,
      surfaces: { ...ss.surfaces },
      checkoutMessage: ss.checkoutMessage,
      excluded: Object.fromEntries(
        Object.entries(ss.setSavingsExcludedByMarket).map(([handle, gids]) => [
          handle,
          [...gids],
        ]),
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
          {
            amounts: entry.amounts.map((a) => String(a)),
            currencyCode: entry.currencyCode,
          },
        ]),
      ),
      samplePool: gt.samplePool.map((entry) => ({ ...entry })),
      warehouse: Object.fromEntries(
        Object.entries(gt.warehouseByMarket).map(([handle, ids]) => [
          handle,
          [...ids],
        ]),
      ),
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
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Dirty-check serialization: trimmed strings, upper-cased codes, records
 *  key-sorted so add-then-remove compares clean; scopes as persisted. */
function serializeForCompare(state: RewardsFormState): string {
  return JSON.stringify({
    ss: {
      ...state.ss,
      ladderPreset: state.ss.ladderPreset,
      keepLegacyCodes: state.ss.keepLegacyCodes,
      tiers: state.ss.tiers.map((t) => ({
        count: t.count.trim(),
        pct: t.pct.trim(),
        code: t.code.trim().toUpperCase(),
      })),
      checkoutMessage: state.ss.checkoutMessage.trim(),
      excluded: sortedRecord(state.ss.excluded),
    },
    gt: {
      ...state.gt,
      giftPreset: state.gt.giftPreset,
      tiers: state.gt.tiers.map((t) => ({
        amount: t.amount.trim(),
        slots: t.slots.map((slot) =>
          slot.map((o) => ({ ...o, count: o.count.trim() })),
        ),
      })),
      thresholds: sortedRecord(
        Object.fromEntries(
          Object.entries(state.gt.thresholds)
            .map(([handle, row]) => [
              handle,
              {
                amounts: row.amounts.map((a) => a.trim()),
                currencyCode: row.currencyCode,
              },
            ])
            // A row with no amount at all is "no explicit amounts".
            .filter(([, row]) =>
              (row as ThresholdRow).amounts.some((a) => a !== ""),
            ),
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
    fs: {
      ...state.fs,
      minUnits: state.fs.minUnits.trim(),
      scope: toScopePatch(state.fs.scope),
    },
    scopes: {
      set_savings: toScopePatch(state.scopes.set_savings),
      gift_tiers: toScopePatch(state.scopes.gift_tiers),
    },
  });
}

// ---------------------------------------------------------------------------
// Client-side validation (mirrors settings.server.ts)
// ---------------------------------------------------------------------------

function intError(
  value: string,
  min: number,
  max: number,
  label = "Whole number",
): string | undefined {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed)) return `${label} ${min}–${max}`;
  if (parsed < min || parsed > max) return `${label} ${min}–${max}`;
  return undefined;
}

function numberError(value: string, min: number, max: number): string | undefined {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) return "Enter a number";
  if (parsed < min || parsed > max) return `Between ${min} and ${max}`;
  return undefined;
}

interface SetSavingsRowErrors {
  count?: string;
  pct?: string;
  code?: string;
}

function validateSetSavingsRows(rows: SetSavingsTierRow[]): {
  rowErrors: SetSavingsRowErrors[];
  formErrors: string[];
} {
  const formErrors: string[] = [];
  if (rows.length > CAPS.setSavingsTiers) {
    formErrors.push(`At most ${CAPS.setSavingsTiers} tiers.`);
  }
  const codes = new Set<string>();
  let lastCount = 1;
  const rowErrors = rows.map((row) => {
    const errors: SetSavingsRowErrors = {};
    errors.count = intError(row.count, 2, 50, "Products");
    const count = Number(row.count);
    if (!errors.count) {
      if (count <= lastCount) errors.count = "Must exceed the previous tier";
      else lastCount = count;
    }
    errors.pct = numberError(row.pct, 1, 90);
    const code = row.code.trim().toUpperCase();
    if (!KIT_CODE_PATTERN.test(code)) {
      errors.code = "2–32 chars: A–Z, 0–9, _ or -";
    } else if (codes.has(code)) {
      errors.code = "Code used twice";
    } else {
      codes.add(code);
    }
    return errors;
  });
  return { rowErrors, formErrors };
}

interface GiftTierErrors {
  amount?: string;
  slots: string[][];
  tier?: string;
}

function validateGiftTierRows(rows: GiftTierRow[]): {
  tierErrors: GiftTierErrors[];
  formErrors: string[];
} {
  const formErrors: string[] = [];
  if (rows.length > CAPS.giftTiers) formErrors.push(`At most ${CAPS.giftTiers} gift tiers.`);
  let last = -1;
  const tierErrors = rows.map((row) => {
    const errors: GiftTierErrors = { slots: [] };
    errors.amount = numberError(row.amount, 0, CAPS.thresholdAmountMax);
    const amount = Number(row.amount);
    if (!errors.amount) {
      if (amount <= last) errors.amount = "Must exceed the previous tier";
      else last = amount;
    }
    if (row.slots.length === 0) errors.tier = "Add at least one gift slot.";
    else if (row.slots.length > CAPS.giftSlots) errors.tier = `At most ${CAPS.giftSlots} slots.`;
    errors.slots = row.slots.map((slot) => {
      if (slot.length === 0) return ["Add at least one option."];
      if (slot.length > CAPS.giftOptionsPerSlot) return [`At most ${CAPS.giftOptionsPerSlot} options.`];
      return slot.map((option) => {
        if (option.kind === "samples") {
          return intError(option.count, 1, CAPS.samplesPerOption, "Sachets") ?? "";
        }
        return option.variantId === "" && option.handle === ""
          ? "Pick a product"
          : "";
      });
    });
    return errors;
  });
  return { tierErrors, formErrors };
}

/** Per-market amount rows: blank row = defaults; a partly filled row or a
 *  non-numeric amount is refused (the server validator needs one amount per
 *  tier). Returns market handle -> message. */
function validateThresholdRows(
  thresholds: Record<string, ThresholdRow>,
  tierCount: number,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [handle, row] of Object.entries(thresholds)) {
    const filled = row.amounts.filter((a) => a.trim() !== "");
    if (filled.length === 0) continue;
    if (row.amounts.length !== tierCount || filled.length !== tierCount) {
      errors[handle] = "Fill every tier or leave the whole row blank";
      continue;
    }
    for (const a of row.amounts) {
      const err = numberError(a, 0, CAPS.thresholdAmountMax);
      if (err) {
        errors[handle] = err;
        break;
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------------

function variantLabel(variant: VariantSummary): string {
  return variant.title && variant.title !== "Default Title"
    ? `${variant.productTitle} — ${variant.title}`
    : variant.productTitle;
}

/** "gid://shopify/ProductVariant/123" -> "123" (client-safe twin of
 *  rewards.server.ts numericId — .server modules never reach the bundle). */
function numericId(gid: string): string {
  const match = /(\d+)(?:\?.*)?$/.exec(String(gid ?? "").trim());
  return match ? match[1] : "";
}

function shortGid(gid: string): string {
  const id = numericId(gid);
  return id ? `#${id}` : gid;
}

/** Worst-case stacking (SPEC intent): the volume ladder (2 jars / 3 jars
 *  percent-off variants), a KIT tier code and a 5 % Joy code all multiply
 *  on the same line. Read-only guidance for the merchant. */
function stackedPct(parts: number[]): string {
  const remaining = parts.reduce((acc, pct) => acc * (1 - pct / 100), 1);
  return `${((1 - remaining) * 100).toFixed(1)}%`;
}

const JOY_WORST_CASE_PCT = 5;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type PickerTarget =
  | { kind: "option"; tier: number; slot: number; option: number }
  | { kind: "pool" };

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
    giftStock,
    stockNote,
    headerEnabled,
    headerLabel,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<RewardsFormState>(() =>
    initialFormState(settings),
  );
  /** Variant labels/thumbnails by GID — seeded from the loader, merged with
   *  every picker / load result so newly picked options render properly. */
  const [variantIndex, setVariantIndex] = useState<Record<string, VariantSummary>>(
    () => Object.fromEntries(giftVariants.map((v) => [v.id, v])),
  );
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);
  /** Gift preset picked in the Select (the button loads it); starts on the
   *  saved preset when it is loadable, else the recommended value_first. */
  const [giftPresetChoice, setGiftPresetChoice] = useState<LoadableGiftPreset>(() =>
    isLoadableGiftPreset(settings.rewards.giftTiers.giftPreset, presets.giftKeys)
      ? settings.rewards.giftTiers.giftPreset
      : "value_first",
  );
  const [stockView, setStockView] = useState<StockView>(giftStock);
  const [nodesView, setNodesView] = useState<DiscountNodesView>(nodes);

  /** Connect / refresh revalidate the loader, which gives `settings` a fresh
   *  OBJECT IDENTITY with unchanged content — the form must reset on saved
   *  CONTENT only, or those buttons would wipe unsaved edits. */
  const settingsKey = useMemo(() => JSON.stringify(settings), [settings]);
  useEffect(() => {
    setState(initialFormState(settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);
  useEffect(() => {
    setVariantIndex((previous) => ({
      ...previous,
      ...Object.fromEntries(giftVariants.map((v) => [v.id, v])),
    }));
  }, [giftVariants]);
  useEffect(() => {
    setStockView(giftStock);
  }, [giftStock]);
  useEffect(() => {
    setNodesView(nodes);
  }, [nodes]);

  // The action also answers picker searches + the rewards intents — toast +
  // banner read only settings-save results.
  const saveResult =
    actionData && "syncErrors" in actionData ? actionData : undefined;
  useEffect(() => {
    if (!saveResult) return;
    if (!saveResult.ok) {
      shopify.toast.show("Could not save settings", { isError: true });
    } else if (saveResult.syncErrors.length > 0) {
      shopify.toast.show("Saved, but the storefront sync reported errors", {
        isError: true,
      });
    } else {
      shopify.toast.show("Saved");
    }
  }, [saveResult, shopify]);

  const initial = useMemo(() => initialFormState(settings), [settings]);
  const dirty = serializeForCompare(state) !== serializeForCompare(initial);
  const aliasCodes = computeAliasCodes(presets.legacyCodes, state.ss.tiers, state.ss.keepLegacyCodes);
  const isSaving =
    navigation.state !== "idle" && navigation.formMethod === "POST";

  // ---- Intent fetchers ----------------------------------------------------
  const connectFetcher = useFetcher<typeof action>();
  const suggestFetcher = useFetcher<typeof action>();
  const stockFetcher = useFetcher<typeof action>();
  const defaultsFetcher = useFetcher<typeof action>();
  const sachetsFetcher = useFetcher<typeof action>();

  const connectResult =
    connectFetcher.data && "intent" in connectFetcher.data &&
    connectFetcher.data.intent === "connect_rewards"
      ? connectFetcher.data
      : null;
  const suggestResult =
    suggestFetcher.data && "intent" in suggestFetcher.data &&
    suggestFetcher.data.intent === "suggest_thresholds"
      ? suggestFetcher.data
      : null;
  const stockResult =
    stockFetcher.data && "intent" in stockFetcher.data &&
    stockFetcher.data.intent === "refresh_stock"
      ? stockFetcher.data
      : null;
  const defaultsResult =
    defaultsFetcher.data && "intent" in defaultsFetcher.data &&
    defaultsFetcher.data.intent === "load_defaults"
      ? defaultsFetcher.data
      : null;
  const sachetsResult =
    sachetsFetcher.data && "intent" in sachetsFetcher.data &&
    sachetsFetcher.data.intent === "load_sachets"
      ? sachetsFetcher.data
      : null;

  // Each intent result is applied ONCE (fetcher.data persists across renders).
  const appliedRef = useRef<{ suggest?: unknown; stock?: unknown; defaults?: unknown; sachets?: unknown; connect?: unknown }>({});
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
              {
                amounts: entry.amounts.map((a) => String(a)),
                currencyCode: entry.currencyCode,
              },
            ]),
          ),
        },
      },
    }));
    shopify.toast.show("Suggested amounts filled — review, then Save");
  }, [suggestResult, shopify]);
  useEffect(() => {
    if (!stockResult || appliedRef.current.stock === stockResult) return;
    appliedRef.current.stock = stockResult;
    setStockView(stockResult.giftStock);
    shopify.toast.show(
      stockResult.ok ? "Gift stock refreshed" : "Gift stock refresh reported errors",
      { isError: !stockResult.ok },
    );
  }, [stockResult, shopify]);
  useEffect(() => {
    if (!defaultsResult || appliedRef.current.defaults === defaultsResult) return;
    appliedRef.current.defaults = defaultsResult;
    setVariantIndex((previous) => ({
      ...previous,
      ...Object.fromEntries(defaultsResult.variants.map((v) => [v.id, v])),
    }));
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
          // Per-market amount columns stay index-aligned to the tiers.
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
    shopify.toast.show(
      `${GIFT_PRESET_BADGES[defaultsResult.preset]} gift tiers loaded — review, then Save`,
    );
  }, [defaultsResult, shopify]);
  useEffect(() => {
    if (!sachetsResult || appliedRef.current.sachets === sachetsResult) return;
    appliedRef.current.sachets = sachetsResult;
    if (sachetsResult.pool.length === 0) {
      shopify.toast.show("No sample-sachet products found", { isError: true });
      return;
    }
    setVariantIndex((previous) => ({
      ...previous,
      ...Object.fromEntries(sachetsResult.variants.map((v) => [v.id, v])),
    }));
    setState((previous) => {
      const known = new Set(previous.gt.samplePool.map((e) => e.variantId));
      const merged = [
        ...previous.gt.samplePool,
        ...sachetsResult.pool.filter((e) => !known.has(e.variantId)),
      ].slice(0, CAPS.samplePool);
      return { ...previous, gt: { ...previous.gt, samplePool: merged } };
    });
    shopify.toast.show("Sachets loaded — review, then Save");
  }, [sachetsResult, shopify]);
  useEffect(() => {
    if (!connectResult || appliedRef.current.connect === connectResult) return;
    appliedRef.current.connect = connectResult;
    setNodesView(connectResult.nodes);
  }, [connectResult]);

  // ---- Variant picker (the cart page's /app/api/variants search) ---------
  const variantSearch = useFetcher<typeof variantsLoader>();
  const loadVariants = variantSearch.load;
  const lastQueryRef = useRef("");
  useEffect(() => {
    const trimmed = pickerQuery.trim();
    if (trimmed === "" || trimmed === lastQueryRef.current) return;
    const handle = setTimeout(() => {
      lastQueryRef.current = trimmed;
      loadVariants(`/app/api/variants?q=${encodeURIComponent(trimmed)}`);
    }, 350);
    return () => clearTimeout(handle);
  }, [pickerQuery, loadVariants]);
  const searchResults = variantSearch.data?.variants ?? [];

  const pickVariant = (variant: VariantSummary) => {
    if (!pickerTarget) return;
    setVariantIndex((previous) => ({ ...previous, [variant.id]: variant }));
    if (pickerTarget.kind === "pool") {
      setState((previous) => {
        if (previous.gt.samplePool.some((e) => e.variantId === variant.id)) return previous;
        if (previous.gt.samplePool.length >= CAPS.samplePool) return previous;
        return {
          ...previous,
          gt: {
            ...previous.gt,
            samplePool: [
              ...previous.gt.samplePool,
              { variantId: variant.id, handle: variant.productHandle },
            ],
          },
        };
      });
    } else {
      const { tier, slot, option } = pickerTarget;
      updateOption(tier, slot, option, {
        kind: "variant",
        variantId: variant.id,
        handle: variant.productHandle,
        count: "1",
      });
    }
    setPickerTarget(null);
    setPickerQuery("");
  };

  // ---- Set-savings tier helpers ------------------------------------------
  const setSs = (patch: Partial<RewardsFormState["ss"]>) =>
    setState((previous) => ({ ...previous, ss: { ...previous.ss, ...patch } }));
  const setGt = (patch: Partial<RewardsFormState["gt"]>) =>
    setState((previous) => ({ ...previous, gt: { ...previous.gt, ...patch } }));
  const setFs = (patch: Partial<RewardsFormState["fs"]>) =>
    setState((previous) => ({ ...previous, fs: { ...previous.fs, ...patch } }));
  const setScope = (key: RewardsKey, scope: ScopeState) =>
    setState((previous) => ({
      ...previous,
      scopes: { ...previous.scopes, [key]: scope },
    }));

  // Any manual edit of the tier table turns the ladder preset into "custom";
  // picking compact/extended replaces the rows with the preset (unsaved
  // until Save).
  const updateSsTier = (index: number, update: Partial<SetSavingsTierRow>) =>
    setSs({
      ladderPreset: "custom",
      tiers: state.ss.tiers.map((row, i) => (i === index ? { ...row, ...update } : row)),
    });
  const removeSsTier = (index: number) =>
    setSs({ ladderPreset: "custom", tiers: state.ss.tiers.filter((_, i) => i !== index) });
  const addSsTier = () => {
    const lastCount = Number(state.ss.tiers[state.ss.tiers.length - 1]?.count ?? "1");
    const nextCount = Number.isInteger(lastCount) ? lastCount + 1 : 2;
    setSs({
      ladderPreset: "custom",
      tiers: [
        ...state.ss.tiers,
        { count: String(nextCount), pct: "", code: `KIT${nextCount}` },
      ],
    });
  };
  const applyLadderPreset = (preset: LadderPresetKey) => {
    if (preset === "custom") {
      setSs({ ladderPreset: "custom" });
      return;
    }
    setSs({
      ladderPreset: preset,
      tiers: presets.ladders[preset].map((tier) => ({
        count: String(tier.count),
        pct: String(tier.pct),
        code: tier.code,
      })),
    });
  };

  // ---- Gift tier helpers --------------------------------------------------
  // Any manual tier edit (amount, slots, options, samples, add/remove) makes
  // the gift preset "custom" — the tiers array is always the truth.
  const updateGtTier = (index: number, update: Partial<GiftTierRow>) =>
    setGt({
      giftPreset: "custom",
      tiers: state.gt.tiers.map((row, i) => (i === index ? { ...row, ...update } : row)),
    });
  const removeGtTier = (index: number) => {
    // Per-market amount columns are index-aligned to tiers: drop the column.
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
  };
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
          Object.entries(previous.gt.thresholds).map(([handle, row]) => [
            handle,
            { ...row, amounts: [...row.amounts, ""] },
          ]),
        ),
      },
    }));
  };
  const updateSlots = (tier: number, slots: GiftOptionRow[][]) =>
    updateGtTier(tier, { slots });
  const updateOption = (
    tier: number,
    slot: number,
    option: number,
    update: Partial<GiftOptionRow>,
  ) =>
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
                  si !== slot
                    ? s
                    : s.map((o, oi) => (oi !== option ? o : { ...o, ...update })),
                ),
              },
        ),
      },
    }));

  const setThresholdAmount = (handle: string, currencyCode: string, index: number, value: string) =>
    setState((previous) => {
      const row = previous.gt.thresholds[handle] ?? {
        amounts: previous.gt.tiers.map(() => ""),
        currencyCode,
      };
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

  const toggleWarehouse = (handle: string, locationId: string, checked: boolean) =>
    setState((previous) => {
      const current = new Set(previous.gt.warehouse[handle] ?? []);
      if (checked) current.add(locationId);
      else current.delete(locationId);
      const ordered = locations
        .map((l) => l.id)
        .filter((id) => current.has(id))
        .slice(0, CAPS.warehouseLocations);
      const warehouse = { ...previous.gt.warehouse };
      if (ordered.length === 0) delete warehouse[handle];
      else warehouse[handle] = ordered;
      return { ...previous, gt: { ...previous.gt, warehouse } };
    });

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
  const fsMinUnitsError = intError(state.fs.minUnits, 0, 50);
  const hasErrors =
    ssValidation.formErrors.length > 0 ||
    ssValidation.rowErrors.some((r) => r.count || r.pct || r.code) ||
    checkoutMessageError !== undefined ||
    gtValidation.formErrors.length > 0 ||
    gtValidation.tierErrors.some(
      (t) => t.amount || t.tier || t.slots.some((s) => s.some((o) => o !== "")),
    ) ||
    Object.keys(thresholdErrors).length > 0 ||
    maxGiftLinesError !== undefined ||
    stockDaysError !== undefined ||
    stockMinError !== undefined ||
    fsMinUnitsError !== undefined;

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
          keepLegacyCodes: state.ss.keepLegacyCodes,
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
                {
                  amounts: row.amounts.slice(0, tierCount).map((a) => Number(a)),
                  currencyCode: row.currencyCode,
                },
              ]),
          ),
          samplePool: state.gt.samplePool.map((entry) => ({ ...entry })),
          warehouseByMarket: Object.fromEntries(
            Object.entries(state.gt.warehouse).filter(([, ids]) => ids.length > 0),
          ),
          stockFloor: {
            days: Number(state.gt.stockFloorDays),
            minUnits: Number(state.gt.stockFloorMinUnits),
          },
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

  const handleDiscard = () => {
    setState(initial);
    setPickerTarget(null);
    setPickerQuery("");
  };

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

  const scrollToMarketAnchor = (id: string) => {
    if (typeof document === "undefined") return;
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (hash === "#market-targeting" || hash.startsWith("#market-")) {
      scrollToMarketAnchor(hash.slice(1));
    }
  }, []);

  // ---- Derived views ------------------------------------------------------
  const ladderPcts = (() => {
    const pcts = settings.cartUpsell.volumeOffers
      .map((offer) => offer.discountPct)
      .filter((pct) => Number.isFinite(pct) && pct > 0);
    return pcts.length > 0 ? pcts : [15, 20];
  })();
  const validSsTiers = state.ss.tiers
    .filter((row, i) => !ssValidation.rowErrors[i]?.pct && !ssValidation.rowErrors[i]?.count)
    .map((row) => ({ count: Number(row.count), pct: Number(row.pct), code: row.code.trim().toUpperCase() }));
  const stackingRows = validSsTiers.map((tier) => [
    `${tier.code} (${tier.count}+ products, ${tier.pct}%)`,
    ...ladderPcts.map((ladder) => stackedPct([ladder, tier.pct])),
    ...ladderPcts.map((ladder) => stackedPct([ladder, tier.pct, JOY_WORST_CASE_PCT])),
  ]);
  const stackingHeadings = [
    "KIT tier",
    ...ladderPcts.map((l) => `+ ${l}% ladder`),
    ...ladderPcts.map((l) => `+ ${l}% ladder + Joy ${JOY_WORST_CASE_PCT}%`),
  ];

  const kitCodes = state.ss.tiers.map((row) => row.code.trim().toUpperCase());
  const connectedKit = Object.keys(nodesView.kit).filter((code) => nodesView.kit[code]);
  const missingKit = kitCodes.filter((code) => KIT_CODE_PATTERN.test(code) && !nodesView.kit[code]);

  const giftLabel = (option: GiftOptionRow): string => {
    if (option.kind === "samples") return `${option.count || "?"} sample sachet(s)`;
    const known = variantIndex[option.variantId];
    if (known) return variantLabel(known);
    if (option.handle) return `${option.handle}${option.variantId ? "" : " (variant not loaded yet)"}`;
    return option.variantId ? shortGid(option.variantId) : "No product picked";
  };
  const giftThumb = (option: GiftOptionRow): string | undefined =>
    option.kind === "variant" ? (variantIndex[option.variantId]?.imageUrl ?? undefined) : undefined;

  /** Stock table columns: every gift variant + pool sachet, by numeric id. */
  const stockColumns = (() => {
    const seen = new Map<string, string>();
    for (const tier of state.gt.tiers) {
      for (const slot of tier.slots) {
        for (const option of slot) {
          if (option.kind === "variant" && option.variantId) {
            const nid = numericId(option.variantId);
            if (nid && !seen.has(nid)) {
              const v = variantIndex[option.variantId];
              seen.set(nid, v ? variantLabel(v) : option.handle || shortGid(option.variantId));
            }
          }
        }
      }
    }
    for (const entry of state.gt.samplePool) {
      const nid = numericId(entry.variantId);
      if (nid && !seen.has(nid)) {
        const v = variantIndex[entry.variantId];
        seen.set(nid, `${v ? variantLabel(v) : entry.handle} (sachet)`);
      }
    }
    // Variants only present in the stored stock table (removed from the form).
    for (const entries of Object.values(stockView.byMarket)) {
      for (const nid of Object.keys(entries)) {
        if (!seen.has(nid)) seen.set(nid, `#${nid}`);
      }
    }
    return [...seen.entries()];
  })();
  const stockMarkets = Object.keys(stockView.byMarket).sort();
  const marketName = (handle: string) =>
    markets.find((m) => m.handle === handle)?.name ?? handle;
  const stockRows = stockMarkets.map((handle) => [
    marketName(handle),
    ...stockColumns.map(([nid]) => {
      const entry = stockView.byMarket[handle]?.[nid];
      if (!entry) return "—";
      return entry.paused ? `${entry.avail} · PAUSED` : String(entry.avail);
    }),
  ]);
  const pausedTotal = stockMarkets.reduce(
    (n, handle) =>
      n + Object.values(stockView.byMarket[handle] ?? {}).filter((e) => e.paused).length,
    0,
  );

  const explicitFreeShipMarkets = Object.entries(settings.freeShipping.byMarket)
    .map(([handle, t]) => `${marketName(handle)}: ${t.amount} ${t.currencyCode}`)
    .slice(0, 8);

  const anyPickerBusy = variantSearch.state !== "idle";

  const renderPicker = () => (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingSm">
            {pickerTarget?.kind === "pool"
              ? "Add a sachet to the sample pool"
              : "Pick the gift product"}
          </Text>
          <Button
            variant="plain"
            onClick={() => {
              setPickerTarget(null);
              setPickerQuery("");
            }}
          >
            Close
          </Button>
        </InlineStack>
        <TextField
          label="Search products"
          placeholder="Search by product title"
          value={pickerQuery}
          onChange={setPickerQuery}
          autoComplete="off"
          autoFocus
        />
        {anyPickerBusy ? (
          <InlineStack align="center">
            <Spinner size="small" accessibilityLabel="Searching products" />
          </InlineStack>
        ) : null}
        {pickerQuery.trim() !== "" && !anyPickerBusy ? (
          <BlockStack gap="200">
            {searchResults.length === 0 && variantSearch.data ? (
              <Text as="p" tone="subdued" variant="bodySm">
                No variants matched “{pickerQuery.trim()}”.
              </Text>
            ) : null}
            {searchResults.map((variant) => (
              <InlineStack
                key={variant.id}
                gap="300"
                align="space-between"
                blockAlign="center"
                wrap={false}
              >
                <InlineStack gap="300" blockAlign="center" wrap={false}>
                  <Thumbnail
                    source={variant.imageUrl ?? ImageIcon}
                    alt={variantLabel(variant)}
                    size="small"
                  />
                  <BlockStack gap="050">
                    <Text as="span" variant="bodyMd">
                      {variantLabel(variant)}
                    </Text>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {variant.price}
                      {variant.availableForSale === false ? " · Out of stock" : ""}
                      {" · "}
                      {variant.productHandle}
                    </Text>
                  </BlockStack>
                </InlineStack>
                <Button size="slim" onClick={() => pickVariant(variant)}>
                  Use
                </Button>
              </InlineStack>
            ))}
          </BlockStack>
        ) : null}
      </BlockStack>
    </Card>
  );

  return (
    <Page
      title="Rewards"
      subtitle="Set savings (KIT tiers), free-gift tiers and the free-shipping guarantee"
      backAction={{ content: "Features", url: "/app/features" }}
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        disabled: !dirty || hasErrors,
        loading: isSaving,
      }}
      secondaryActions={[
        {
          content: "Discard",
          onAction: handleDiscard,
          disabled: !dirty || isSaving,
        },
      ]}
    >
      <TitleBar title="Rewards" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="set_savings"
              enabled={headerEnabled}
              statusLabel={headerLabel}
              reachCaption={`Set savings: ${reachCaption(state.scopes.set_savings, markets)} · Gift tiers: ${reachCaption(state.scopes.gift_tiers, markets)}`}
            />
          </Card>
        </Layout.Section>

        {saveResult && saveResult.syncErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone={saveResult.ok ? "warning" : "critical"}
              title={
                saveResult.ok
                  ? "Saved, but the storefront sync reported errors"
                  : "Settings could not be saved"
              }
            >
              <BlockStack gap="100">
                {saveResult.syncErrors.map((error) => (
                  <Text as="p" key={error}>
                    {error}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        {!functionId && !nodesView.gift ? (
          <Layout.Section>
            <Banner tone="info" title="Discounts not connected yet">
              <Text as="p">
                The KIT codes, the free-gift discount and the free-shipping
                discount are Shopify discounts backed by the “Cellexia
                rewards” Discount Function. Deploy the extensions, save your
                settings, then press “Connect KIT codes & discounts” below —
                until then the storefront shows the tiers but Shopify does not
                take anything off.
              </Text>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <BlockStack gap="400">
            {/* ============================ SET SAVINGS ============================ */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h2" variant="headingMd">
                    Set savings (KIT tiers)
                  </Text>
                  <Badge tone={state.ss.enabled ? "success" : undefined}>
                    {state.ss.enabled ? "On" : "Off"}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Buy more different products, save a growing percentage on
                  the whole set. The storefront applies the matching KIT code
                  automatically; the Discount Function grants the percentage
                  only when the cart really holds that many different
                  products.
                </Text>
                <Checkbox
                  label="Enable set savings"
                  helpText="Master switch (FeatureKey set_savings). Cart nudge, product-page lines and the KIT code sync all follow it."
                  checked={state.ss.enabled}
                  onChange={(enabled) => setSs({ enabled })}
                />
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Market reach: {reachCaption(state.scopes.set_savings, markets)}
                  </Text>
                  <Button
                    variant="plain"
                    onClick={() => scrollToMarketAnchor(marketAnchorId("set_savings"))}
                  >
                    Edit markets
                  </Button>
                </InlineStack>
                <Divider />
                <ChoiceList
                  title="Tier ladder"
                  choices={presets.ladderKeys.map((key) => ({
                    label: LADDER_PRESET_LABELS[key],
                    value: key,
                  }))}
                  selected={[state.ss.ladderPreset]}
                  onChange={(selection) => {
                    const next = selection[0];
                    if (next === "compact" || next === "extended" || next === "custom") {
                      applyLadderPreset(next);
                    }
                  }}
                />
                <Text as="p" tone="subdued" variant="bodySm">
                  {LADDER_PRESET_RATIONALE[state.ss.ladderPreset]}
                </Text>
                <Checkbox
                  label="Keep legacy KIT codes working (recommended)"
                  helpText="Codes from the other ladder (e.g. KIT5 and KIT10 with the compact ladder) stay valid: typed at checkout they give the shopper the tier the cart qualifies for, never on top of the auto-applied code."
                  checked={state.ss.keepLegacyCodes}
                  onChange={(keepLegacyCodes) => setSs({ keepLegacyCodes })}
                />
                <Text as="p" tone="subdued" variant="bodySm">
                  {aliasCodes.length > 0 ? `Aliases: ${aliasCodes.join(", ")}` : "Aliases: none"}
                </Text>
                <Text as="h3" variant="headingSm">
                  Tiers
                </Text>
                <BlockStack gap="300">
                  {state.ss.tiers.map((row, index) => (
                    <InlineStack
                      key={`ss-tier-${index}`}
                      gap="300"
                      blockAlign="start"
                      wrap={false}
                    >
                      <Box width="150px">
                        <TextField
                          label="Different products"
                          type="number"
                          min={2}
                          max={50}
                          value={row.count}
                          onChange={(count) => updateSsTier(index, { count })}
                          error={ssValidation.rowErrors[index]?.count}
                          autoComplete="off"
                        />
                      </Box>
                      <Box width="120px">
                        <TextField
                          label="Discount"
                          type="number"
                          suffix="%"
                          min={1}
                          max={90}
                          value={row.pct}
                          onChange={(pct) => updateSsTier(index, { pct })}
                          error={ssValidation.rowErrors[index]?.pct}
                          autoComplete="off"
                        />
                      </Box>
                      <Box width="180px">
                        <TextField
                          label="Code"
                          value={row.code}
                          onChange={(code) =>
                            updateSsTier(index, { code: code.toUpperCase().replace(/\s+/g, "") })
                          }
                          error={ssValidation.rowErrors[index]?.code}
                          autoComplete="off"
                          helpText={
                            nodesView.kit[row.code.trim().toUpperCase()]
                              ? "Connected"
                              : "Not connected"
                          }
                        />
                      </Box>
                      <Box paddingBlockStart="600">
                        <Button
                          icon={DeleteIcon}
                          variant="tertiary"
                          accessibilityLabel={`Remove tier ${index + 1}`}
                          onClick={() => removeSsTier(index)}
                        />
                      </Box>
                    </InlineStack>
                  ))}
                  {ssValidation.formErrors.map((error) => (
                    <Text as="p" tone="critical" variant="bodySm" key={error}>
                      {error}
                    </Text>
                  ))}
                  <InlineStack>
                    <Button
                      icon={PlusIcon}
                      onClick={addSsTier}
                      disabled={state.ss.tiers.length >= CAPS.setSavingsTiers}
                    >
                      Add tier
                    </Button>
                  </InlineStack>
                </BlockStack>
                <Checkbox
                  label="Subscription lines count and get the saving (first order only)"
                  helpText="The KIT discount applies to subscription lines on the first order only (recurringCycleLimit 1). Off = subscription lines neither count nor get the percentage."
                  checked={state.ss.includeSubscriptions}
                  onChange={(includeSubscriptions) => setSs({ includeSubscriptions })}
                />
                <TextField
                  label="Checkout line text"
                  helpText='Shown next to the discount at checkout. Leave blank for "Set savings −{pct}%". You may use {pct}.'
                  value={state.ss.checkoutMessage}
                  onChange={(checkoutMessage) => setSs({ checkoutMessage })}
                  error={checkoutMessageError}
                  maxLength={CAPS.checkoutMessage}
                  showCharacterCount
                  autoComplete="off"
                />
                <Divider />
                <Text as="h3" variant="headingSm">
                  Surfaces
                </Text>
                <Checkbox
                  label="Product page line (“Add any second product, save X% on both”)"
                  checked={state.ss.surfaces.pdpLine}
                  onChange={(pdpLine) => setSs({ surfaces: { ...state.ss.surfaces, pdpLine } })}
                />
                <Checkbox
                  label="Similar-items caption"
                  checked={state.ss.surfaces.similarCaption}
                  onChange={(similarCaption) =>
                    setSs({ surfaces: { ...state.ss.surfaces, similarCaption } })
                  }
                />
                <Checkbox
                  label="Frequently-bought-together caption + discounted total"
                  checked={state.ss.surfaces.fbtCaption}
                  onChange={(fbtCaption) => setSs({ surfaces: { ...state.ss.surfaces, fbtCaption } })}
                />
                <Checkbox
                  label="Cart nudge (“Add 1 more product to save X% on everything”)"
                  checked={state.ss.surfaces.cartNudge}
                  onChange={(cartNudge) => setSs({ surfaces: { ...state.ss.surfaces, cartNudge } })}
                />
                <Checkbox
                  label="Cross-sell reframe (“Complete your set & save X%”, discounted prices)"
                  checked={state.ss.surfaces.crossSellReframe}
                  onChange={(crossSellReframe) =>
                    setSs({ surfaces: { ...state.ss.surfaces, crossSellReframe } })
                  }
                />
                <Divider />
                <Text as="h3" variant="headingSm">
                  Worst-case stacking
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  KIT codes combine with product, order and shipping discounts.
                  A line already discounted by the volume ladder ({ladderPcts.join("% / ")}%
                  variants) plus a KIT code plus a {JOY_WORST_CASE_PCT}% Joy code
                  ends up at the effective discount below (multiplicative).
                </Text>
                {stackingRows.length > 0 ? (
                  <Box overflowX="scroll">
                    <DataTable
                      columnContentTypes={stackingHeadings.map(() => "text")}
                      headings={stackingHeadings}
                      rows={stackingRows}
                      increasedTableDensity
                    />
                  </Box>
                ) : (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Add a valid tier to see the stacking table.
                  </Text>
                )}
                <Divider />
                <Text as="h3" variant="headingSm">
                  Shopify discounts
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {connectedKit.length > 0
                    ? `Connected KIT codes: ${connectedKit.join(", ")}.`
                    : "No KIT code is connected yet."}{" "}
                  {nodesView.gift ? "Free-gift discount connected. " : "Free-gift discount not connected. "}
                  {nodesView.ship ? "Free-shipping discount connected." : "Free-shipping discount not connected."}
                  {missingKit.length > 0 && connectedKit.length > 0
                    ? ` Missing: ${missingKit.join(", ")}.`
                    : ""}
                </Text>
                <Checkbox
                  label="Replace existing KIT codes that are not ours"
                  helpText='A discount code with the same name as a ladder or alias code, created outside this app, is deleted and recreated as a Function discount. Only when "Keep legacy KIT codes" is off does Connect also deactivate legacy KIT codes that are not in the ladder. Off = such codes are reported and skipped.'
                  checked={replaceExisting}
                  onChange={setReplaceExisting}
                />
                <InlineStack gap="300" blockAlign="center" wrap>
                  <Button
                    onClick={() =>
                      runIntent(connectFetcher, "connect_rewards", {
                        replaceExisting: replaceExisting ? "1" : "0",
                      })
                    }
                    loading={connectFetcher.state !== "idle"}
                    disabled={dirty || isSaving}
                  >
                    Connect KIT codes & discounts
                  </Button>
                  {dirty ? (
                    <Text as="span" tone="subdued" variant="bodySm">
                      Save your changes first — Connect uses the saved tiers.
                    </Text>
                  ) : null}
                </InlineStack>
                {connectResult ? (
                  <Banner
                    tone={connectResult.ok ? "success" : "critical"}
                    title={connectResult.ok ? "Discounts connected" : "Connect reported errors"}
                  >
                    <BlockStack gap="100">
                      <Text as="p">{connectResult.summary}</Text>
                      {Object.entries(connectResult.nodes.kit).map(([code, gid]) => (
                        <Text as="p" variant="bodySm" key={code}>
                          {code}: {gid ? shortGid(gid) : "not created"}
                        </Text>
                      ))}
                      <Text as="p" variant="bodySm">
                        Free gifts: {connectResult.nodes.gift ? shortGid(connectResult.nodes.gift) : "not created"}
                        {" · "}
                        Free shipping: {connectResult.nodes.ship ? shortGid(connectResult.nodes.ship) : "not created"}
                      </Text>
                      {connectResult.errors.map((error) => (
                        <Text as="p" tone="critical" key={error}>
                          {error}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                ) : null}
              </BlockStack>
            </Card>

            <MarketProductExclusionsCard
              title="Excluded products — set savings"
              description="Products excluded for a market neither count toward the KIT tiers nor receive the KIT percentage in that market (the Discount Function applies the same rule)."
              markets={markets}
              value={state.ss.excluded}
              titles={exclusionTitles}
              disabled={isSaving}
              onChange={(next) => setSs({ excluded: next })}
            />

            {/* ============================= GIFT TIERS ============================ */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h2" variant="headingMd">
                    Gift tiers
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={state.gt.giftPreset === "custom" ? "info" : "attention"}>
                      {GIFT_PRESET_BADGES[state.gt.giftPreset]}
                    </Badge>
                    <Badge tone={state.gt.enabled ? "success" : undefined}>
                      {state.gt.enabled ? "On" : "Off"}
                    </Badge>
                  </InlineStack>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Spend-based free gifts: the cart meter shows the next gift,
                  the storefront adds the gift line at 100% off, the Discount
                  Function keeps it free, and out-of-stock gifts pause per
                  market.
                </Text>
                <Checkbox
                  label="Enable gift tiers"
                  helpText="Master switch (FeatureKey gift_tiers)."
                  checked={state.gt.enabled}
                  onChange={(enabled) => setGt({ enabled })}
                />
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Market reach: {reachCaption(state.scopes.gift_tiers, markets)}
                  </Text>
                  <Button
                    variant="plain"
                    onClick={() => scrollToMarketAnchor(marketAnchorId("gift_tiers"))}
                  >
                    Edit markets
                  </Button>
                </InlineStack>
                <Divider />
                <Checkbox
                  label="Cumulative — a reached tier keeps every lower tier's gifts"
                  checked={state.gt.cumulative}
                  onChange={(cumulative) => setGt({ cumulative })}
                />
                <ChoiceList
                  title="Gift selection"
                  choices={[
                    {
                      label: "Automatic",
                      value: "auto",
                      helpText: "First available option of each slot is added.",
                    },
                    {
                      label: "Let the shopper choose",
                      value: "choose",
                      helpText: "The gift row offers a “Swap gift” link when the slot has another available option.",
                    },
                  ]}
                  selected={[state.gt.choice]}
                  onChange={(selection) =>
                    setGt({ choice: selection[0] === "choose" ? "choose" : "auto" })
                  }
                />
                <InlineStack gap="300" wrap>
                  <Box width="180px">
                    <TextField
                      label="Max gift lines per cart"
                      type="number"
                      min={1}
                      max={CAPS.maxGiftLines}
                      value={state.gt.maxGiftLines}
                      onChange={(maxGiftLines) => setGt({ maxGiftLines })}
                      error={maxGiftLinesError}
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="260px">
                    <Select
                      label="Sample sachets are picked"
                      options={[
                        { label: "Not already in the cart (then rotate)", value: "not_in_cart" },
                        { label: "Rotate by cart", value: "rotate" },
                        { label: "Fixed — first N of the pool", value: "fixed" },
                      ]}
                      value={state.gt.sampleRule}
                      onChange={(sampleRule) =>
                        setGt({ sampleRule: sampleRule as GiftSampleRule })
                      }
                    />
                  </Box>
                </InlineStack>
                <Checkbox
                  label="Show the free-shipping milestone on the meter"
                  helpText="Uses the market's free-shipping threshold (Settings → Free shipping)."
                  checked={state.gt.showShippingMilestone}
                  onChange={(showShippingMilestone) => setGt({ showShippingMilestone })}
                />
                <Divider />
                <Text as="h3" variant="headingSm">
                  Tiers (EUR default amounts)
                </Text>
                <InlineStack gap="300" blockAlign="end" wrap>
                  <Box minWidth="320px">
                    <Select
                      label="Gift preset"
                      options={presets.giftKeys.map((key) => ({
                        label: GIFT_PRESET_LABELS[key],
                        value: key,
                      }))}
                      value={giftPresetChoice}
                      onChange={(value) => {
                        if (isLoadableGiftPreset(value, presets.giftKeys)) setGiftPresetChoice(value);
                      }}
                    />
                  </Box>
                  <Button
                    onClick={() =>
                      runIntent(defaultsFetcher, "load_defaults", { preset: giftPresetChoice })
                    }
                    loading={defaultsFetcher.state !== "idle"}
                  >
                    Load preset
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Loading a preset replaces the tiers below with the preset's
                  gifts (variant ids resolved from the store) — unsaved until
                  Save. The tiers stay fully editable; any edit marks the
                  preset as Custom.
                </Text>
                {defaultsResult && defaultsResult.errors.length > 0 ? (
                  <Banner tone="warning" title="Defaults loaded with notes">
                    <BlockStack gap="100">
                      {defaultsResult.errors.map((error) => (
                        <Text as="p" key={error}>
                          {error}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                ) : null}
                <Text as="p" tone="subdued" variant="bodySm">
                  Every slot is granted; within a slot the first available
                  option is used (fallback order). Per-market amounts below
                  override the EUR default in that market.
                </Text>
                {state.gt.tiers.map((tier, ti) => {
                  const errors = gtValidation.tierErrors[ti];
                  return (
                    <Box
                      key={`gt-tier-${ti}`}
                      padding="300"
                      borderColor="border"
                      borderWidth="025"
                      borderRadius="200"
                    >
                      <BlockStack gap="300">
                        <InlineStack gap="300" blockAlign="start" wrap={false}>
                          <Box width="180px">
                            <TextField
                              label={`Tier ${ti + 1} — spend from`}
                              type="number"
                              suffix="EUR"
                              min={0}
                              value={tier.amount}
                              onChange={(amount) => updateGtTier(ti, { amount })}
                              error={errors?.amount}
                              autoComplete="off"
                            />
                          </Box>
                          <Box paddingBlockStart="600">
                            <Button
                              icon={DeleteIcon}
                              variant="tertiary"
                              accessibilityLabel={`Remove gift tier ${ti + 1}`}
                              onClick={() => removeGtTier(ti)}
                            />
                          </Box>
                        </InlineStack>
                        {errors?.tier ? (
                          <Text as="p" tone="critical" variant="bodySm">
                            {errors.tier}
                          </Text>
                        ) : null}
                        {tier.slots.map((slot, si) => (
                          <Box
                            key={`gt-slot-${ti}-${si}`}
                            padding="200"
                            background="bg-surface-secondary"
                            borderRadius="200"
                          >
                            <BlockStack gap="200">
                              <InlineStack align="space-between" blockAlign="center">
                                <Text as="h4" variant="headingXs">
                                  Slot {si + 1}
                                </Text>
                                <Button
                                  variant="plain"
                                  tone="critical"
                                  onClick={() =>
                                    updateSlots(ti, tier.slots.filter((_, i) => i !== si))
                                  }
                                >
                                  Remove slot
                                </Button>
                              </InlineStack>
                              {slot.map((option, oi) => {
                                const optionError = errors?.slots[si]?.[oi] ?? "";
                                const isPicking =
                                  pickerTarget?.kind === "option" &&
                                  pickerTarget.tier === ti &&
                                  pickerTarget.slot === si &&
                                  pickerTarget.option === oi;
                                return (
                                  <BlockStack gap="100" key={`gt-opt-${ti}-${si}-${oi}`}>
                                    <InlineStack gap="300" blockAlign="center" wrap>
                                      <Box width="150px">
                                        <Select
                                          label={`Option ${oi + 1}`}
                                          labelHidden
                                          options={[
                                            { label: "Product", value: "variant" },
                                            { label: "Sample sachets", value: "samples" },
                                          ]}
                                          value={option.kind}
                                          onChange={(kind) =>
                                            updateOption(ti, si, oi, {
                                              kind: kind === "samples" ? "samples" : "variant",
                                              ...(kind === "samples"
                                                ? { variantId: "", handle: "", count: option.count || "2" }
                                                : { count: "1" }),
                                            })
                                          }
                                        />
                                      </Box>
                                      {option.kind === "samples" ? (
                                        <Box width="120px">
                                          <TextField
                                            label="Sachets"
                                            labelHidden
                                            type="number"
                                            min={1}
                                            max={CAPS.samplesPerOption}
                                            suffix="sachets"
                                            value={option.count}
                                            onChange={(count) => updateOption(ti, si, oi, { count })}
                                            autoComplete="off"
                                          />
                                        </Box>
                                      ) : (
                                        <InlineStack gap="200" blockAlign="center" wrap={false}>
                                          <Thumbnail
                                            source={giftThumb(option) ?? ImageIcon}
                                            alt={giftLabel(option)}
                                            size="small"
                                          />
                                          <Text as="span" variant="bodySm">
                                            {giftLabel(option)}
                                          </Text>
                                          <Button
                                            size="slim"
                                            onClick={() => {
                                              setPickerTarget(
                                                isPicking
                                                  ? null
                                                  : { kind: "option", tier: ti, slot: si, option: oi },
                                              );
                                              setPickerQuery("");
                                            }}
                                          >
                                            {isPicking ? "Cancel" : option.variantId || option.handle ? "Change" : "Pick"}
                                          </Button>
                                        </InlineStack>
                                      )}
                                      <Button
                                        icon={DeleteIcon}
                                        variant="tertiary"
                                        accessibilityLabel="Remove option"
                                        onClick={() =>
                                          updateSlots(
                                            ti,
                                            tier.slots.map((s, i) =>
                                              i === si ? s.filter((_, k) => k !== oi) : s,
                                            ),
                                          )
                                        }
                                      />
                                    </InlineStack>
                                    {optionError ? (
                                      <Text as="p" tone="critical" variant="bodySm">
                                        {optionError}
                                      </Text>
                                    ) : null}
                                    {isPicking ? renderPicker() : null}
                                  </BlockStack>
                                );
                              })}
                              <InlineStack>
                                <Button
                                  size="slim"
                                  icon={PlusIcon}
                                  disabled={slot.length >= CAPS.giftOptionsPerSlot}
                                  onClick={() =>
                                    updateSlots(
                                      ti,
                                      tier.slots.map((s, i) =>
                                        i === si
                                          ? [...s, { kind: "variant", variantId: "", handle: "", count: "1" }]
                                          : s,
                                      ),
                                    )
                                  }
                                >
                                  Add fallback option
                                </Button>
                              </InlineStack>
                            </BlockStack>
                          </Box>
                        ))}
                        <InlineStack>
                          <Button
                            size="slim"
                            icon={PlusIcon}
                            disabled={tier.slots.length >= CAPS.giftSlots}
                            onClick={() =>
                              updateSlots(ti, [
                                ...tier.slots,
                                [{ kind: "variant", variantId: "", handle: "", count: "1" }],
                              ])
                            }
                          >
                            Add slot
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </Box>
                  );
                })}
                {gtValidation.formErrors.map((error) => (
                  <Text as="p" tone="critical" variant="bodySm" key={error}>
                    {error}
                  </Text>
                ))}
                <InlineStack>
                  <Button
                    icon={PlusIcon}
                    onClick={addGtTier}
                    disabled={state.gt.tiers.length >= CAPS.giftTiers}
                  >
                    Add gift tier
                  </Button>
                </InlineStack>

                <Divider />
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h3" variant="headingSm">
                    Sample pool (sachets)
                  </Text>
                  <InlineStack gap="200">
                    <Button
                      size="slim"
                      onClick={() => runIntent(sachetsFetcher, "load_sachets")}
                      loading={sachetsFetcher.state !== "idle"}
                    >
                      Load sachets
                    </Button>
                    <Button
                      size="slim"
                      disabled={state.gt.samplePool.length >= CAPS.samplePool}
                      onClick={() => {
                        setPickerTarget(pickerTarget?.kind === "pool" ? null : { kind: "pool" });
                        setPickerQuery("");
                      }}
                    >
                      {pickerTarget?.kind === "pool" ? "Cancel" : "Add sachet"}
                    </Button>
                  </InlineStack>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  “Load sachets” adds every active product tagged
                  sample-sachet (first variant). Sachets pause below 100 units.
                  Keep the pool small (≤ 9) — the storefront looks every gift
                  product up on the cart page.
                </Text>
                {sachetsResult && sachetsResult.errors.length > 0 ? (
                  <Text as="p" tone="critical" variant="bodySm">
                    {sachetsResult.errors.join(" ")}
                  </Text>
                ) : null}
                {state.gt.samplePool.length > 0 ? (
                  <InlineStack gap="200" wrap>
                    {state.gt.samplePool.map((entry) => {
                      const v = variantIndex[entry.variantId];
                      return (
                        <Tag
                          key={entry.variantId}
                          onRemove={() =>
                            setGt({
                              samplePool: state.gt.samplePool.filter(
                                (e) => e.variantId !== entry.variantId,
                              ),
                            })
                          }
                        >
                          {v ? variantLabel(v) : entry.handle}
                        </Tag>
                      );
                    })}
                  </InlineStack>
                ) : (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No sachets in the pool — “sample sachets” options grant
                    nothing until you add some.
                  </Text>
                )}
                {pickerTarget?.kind === "pool" ? renderPicker() : null}

                <Divider />
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h3" variant="headingSm">
                    Per-market amounts
                  </Text>
                  <Button
                    size="slim"
                    onClick={() =>
                      runIntent(suggestFetcher, "suggest_thresholds", {
                        eurAmounts: JSON.stringify(
                          state.gt.tiers.map((t) => Number(t.amount) || 0),
                        ),
                      })
                    }
                    loading={suggestFetcher.state !== "idle"}
                    disabled={state.gt.tiers.length === 0}
                  >
                    Suggest amounts
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Amounts in the market's base currency (locked to the market
                  currency). Blank rows use the EUR defaults converted at
                  Shopify's rate. “Suggest amounts” scales the EUR defaults by
                  the market's real price ratio for the reference product and
                  rounds them nicely — nothing is saved until you press Save.
                </Text>
                {suggestResult && suggestResult.errors.length > 0 ? (
                  <Banner tone="warning" title="Suggestion notes">
                    <BlockStack gap="100">
                      {suggestResult.errors.map((error) => (
                        <Text as="p" key={error}>
                          {error}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                ) : null}
                {markets.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No markets could be loaded.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {markets.map((market) => {
                      const currency = market.currencyCode || "EUR";
                      const row = state.gt.thresholds[market.handle];
                      const error = thresholdErrors[market.handle];
                      return (
                        <InlineStack
                          key={market.handle}
                          gap="300"
                          blockAlign="start"
                          wrap
                        >
                          <Box width="200px" paddingBlockStart="200">
                            <Text as="span" variant="bodyMd">
                              {market.name}
                              {market.primary ? " (primary)" : ""}
                            </Text>
                            <Text as="p" tone="subdued" variant="bodySm">
                              {market.handle} · {currency}
                              {!market.enabled ? " · inactive" : ""}
                            </Text>
                          </Box>
                          {state.gt.tiers.map((_, ti) => (
                            <Box width="130px" key={`th-${market.handle}-${ti}`}>
                              <TextField
                                label={`Tier ${ti + 1}`}
                                labelHidden
                                type="number"
                                min={0}
                                suffix={currency}
                                placeholder={state.gt.tiers[ti]?.amount || "—"}
                                value={row?.amounts[ti] ?? ""}
                                onChange={(value) =>
                                  setThresholdAmount(market.handle, currency, ti, value)
                                }
                                error={ti === 0 ? error : undefined}
                                autoComplete="off"
                              />
                            </Box>
                          ))}
                          {row && row.amounts.some((a) => a.trim() !== "") ? (
                            <Box paddingBlockStart="100">
                              <Button
                                variant="plain"
                                onClick={() =>
                                  setState((previous) => {
                                    const thresholds = { ...previous.gt.thresholds };
                                    delete thresholds[market.handle];
                                    return { ...previous, gt: { ...previous.gt, thresholds } };
                                  })
                                }
                              >
                                Use defaults
                              </Button>
                            </Box>
                          ) : null}
                        </InlineStack>
                      );
                    })}
                    {Object.entries(state.gt.thresholds)
                      .filter(([handle]) => !markets.some((m) => m.handle === handle))
                      .map(([handle, row]) => (
                        <Text as="p" tone="subdued" variant="bodySm" key={handle}>
                          Stored amounts for “{handle}” (market not found):{" "}
                          {row.amounts.join(" / ")} {row.currencyCode} — kept until you clear them.{" "}
                          <Button
                            variant="plain"
                            onClick={() =>
                              setState((previous) => {
                                const thresholds = { ...previous.gt.thresholds };
                                delete thresholds[handle];
                                return { ...previous, gt: { ...previous.gt, thresholds } };
                              })
                            }
                          >
                            Clear
                          </Button>
                        </Text>
                      ))}
                  </BlockStack>
                )}

                <Divider />
                <Text as="h3" variant="headingSm">
                  Warehouses & stock floor
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Tick the locations that ship each market so gift stock is
                  read where it matters. Markets with no tick use every active
                  location. A gift option pauses in a market when its
                  available stock is below the floor (sachets: at least 100).
                </Text>
                <InlineStack gap="300" wrap>
                  <Box width="160px">
                    <TextField
                      label="Minimum units"
                      type="number"
                      min={0}
                      value={state.gt.stockFloorMinUnits}
                      onChange={(stockFloorMinUnits) => setGt({ stockFloorMinUnits })}
                      error={stockMinError}
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="160px">
                    <TextField
                      label="Days of cover"
                      type="number"
                      min={0}
                      max={60}
                      helpText="Reserved for a later version."
                      value={state.gt.stockFloorDays}
                      onChange={(stockFloorDays) => setGt({ stockFloorDays })}
                      error={stockDaysError}
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
                {locations.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No locations could be loaded (the read_locations scope may
                    not be granted yet) — every market reads all active
                    locations.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {markets.map((market) => (
                      <BlockStack gap="100" key={`wh-${market.handle}`}>
                        <Text as="span" variant="bodyMd">
                          {market.name}
                          <Text as="span" tone="subdued" variant="bodySm">
                            {" "}
                            ({state.gt.warehouse[market.handle]?.length
                              ? `${state.gt.warehouse[market.handle].length} location(s)`
                              : "all active locations"})
                          </Text>
                        </Text>
                        <InlineStack gap="300" wrap>
                          {locations.map((location) => (
                            <Checkbox
                              key={`${market.handle}-${location.id}`}
                              label={
                                location.countryCode
                                  ? `${location.name} (${location.countryCode})`
                                  : location.name
                              }
                              checked={(state.gt.warehouse[market.handle] ?? []).includes(location.id)}
                              disabled={
                                !(state.gt.warehouse[market.handle] ?? []).includes(location.id) &&
                                (state.gt.warehouse[market.handle] ?? []).length >= CAPS.warehouseLocations
                              }
                              onChange={(checked) =>
                                toggleWarehouse(market.handle, location.id, checked)
                              }
                            />
                          ))}
                        </InlineStack>
                      </BlockStack>
                    ))}
                  </BlockStack>
                )}

                <Divider />
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h3" variant="headingSm">
                    Gift stock by market
                  </Text>
                  <Button
                    size="slim"
                    onClick={() => runIntent(stockFetcher, "refresh_stock")}
                    loading={stockFetcher.state !== "idle"}
                  >
                    Refresh gift stock
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  {stockView.t
                    ? `Last refreshed ${stockView.t.replace("T", " ").slice(0, 16)} UTC · ${pausedTotal} paused option(s).`
                    : "Not refreshed yet."}{" "}
                  Reads the saved gift pool; save first after changing gifts.
                  Refreshes automatically every 15 minutes and on inventory
                  updates.
                </Text>
                {stockNote ? (
                  <Text as="p" tone="critical" variant="bodySm">
                    {stockNote}
                  </Text>
                ) : null}
                {stockResult && stockResult.errors.length > 0 ? (
                  <Text as="p" tone="critical" variant="bodySm">
                    {stockResult.errors.join(" ")}
                  </Text>
                ) : null}
                {stockRows.length > 0 && stockColumns.length > 0 ? (
                  <Box overflowX="scroll">
                    <DataTable
                      columnContentTypes={["text", ...stockColumns.map(() => "text" as const)]}
                      headings={["Market", ...stockColumns.map(([, label]) => label)]}
                      rows={stockRows}
                      increasedTableDensity
                    />
                  </Box>
                ) : (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No stock data yet — configure gift products, save, then refresh.
                  </Text>
                )}
              </BlockStack>
            </Card>

            {/* ======================= FREE-SHIPPING GUARANTEE ===================== */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h2" variant="headingMd">
                    Free-shipping guarantee
                  </Text>
                  <Badge tone={state.fs.enabled ? "success" : undefined}>
                    {state.fs.enabled ? "On" : "Off"}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  An automatic shipping discount (100% off the cheapest paid
                  option) run by the same Function. Not a feature key — it has
                  its own market scope below.
                </Text>
                <Checkbox
                  label="Enable the free-shipping guarantee"
                  checked={state.fs.enabled}
                  onChange={(enabled) => setFs({ enabled })}
                />
                <Box width="200px">
                  <TextField
                    label="Free from this many full-size units"
                    type="number"
                    min={0}
                    max={50}
                    helpText="0 = units rule off. Ladder variants count their units (2 Jars = 2)."
                    value={state.fs.minUnits}
                    onChange={(minUnits) => setFs({ minUnits })}
                    error={fsMinUnitsError}
                    autoComplete="off"
                  />
                </Box>
                <Checkbox
                  label="Also free when the spend meets the market's free-shipping threshold"
                  helpText={
                    explicitFreeShipMarkets.length > 0
                      ? `Explicit thresholds only (never the fallback): ${explicitFreeShipMarkets.join(", ")}${
                          Object.keys(settings.freeShipping.byMarket).length > 8 ? ", …" : ""
                        }`
                      : "No explicit per-market threshold is configured yet (Settings → Free shipping) — this rule grants nothing until one exists."
                  }
                  checked={state.fs.byThreshold}
                  onChange={(byThreshold) => setFs({ byThreshold })}
                />
              </BlockStack>
            </Card>
            <MarketScopeCard
              title="Markets — Free-shipping guarantee"
              markets={markets}
              scope={state.fs.scope}
              onChange={(scope) => setFs({ scope })}
            />

            {/* ========================= MARKET TARGETING ========================== */}
            <div id="market-targeting">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Market targeting
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Limit each feature to selected markets. “All markets” is
                    the default. A feature must also be enabled above to appear
                    anywhere. The same controls also live on the app's Markets
                    page.
                  </Text>
                  {markets.length === 0 ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      No markets could be loaded — the features follow their
                      “All markets” setting.
                    </Text>
                  ) : null}
                  {(
                    [
                      { key: "set_savings", title: "Set savings (KIT tiers)" },
                      { key: "gift_tiers", title: "Gift tiers" },
                    ] as { key: RewardsKey; title: string }[]
                  ).map((feature) => {
                    const scope = state.scopes[feature.key];
                    return (
                      <div key={feature.key} id={marketAnchorId(feature.key)}>
                        <BlockStack gap="200">
                          <Divider />
                          <Text as="h3" variant="headingSm">
                            {feature.title}
                          </Text>
                          <ChoiceList
                            title="Market visibility"
                            titleHidden
                            choices={[
                              { label: "All markets", value: "all" },
                              {
                                label: "Selected markets",
                                value: "selected",
                                renderChildren: (isSelected: boolean) =>
                                  isSelected ? (
                                    <BlockStack gap="100">
                                      {markets.map((market) => (
                                        <Checkbox
                                          key={market.handle}
                                          label={
                                            market.primary
                                              ? `${market.name} (primary)`
                                              : market.name
                                          }
                                          helpText={market.handle}
                                          checked={scope.markets.includes(market.handle)}
                                          onChange={(checked) => {
                                            const set = new Set(scope.markets);
                                            if (checked) set.add(market.handle);
                                            else set.delete(market.handle);
                                            setScope(feature.key, {
                                              mode: "selected",
                                              markets: [...set],
                                            });
                                          }}
                                        />
                                      ))}
                                      {scope.markets.length === 0 ? (
                                        <Text as="p" tone="critical" variant="bodySm">
                                          No markets selected — this feature
                                          won’t appear anywhere.
                                        </Text>
                                      ) : null}
                                    </BlockStack>
                                  ) : null,
                              },
                            ]}
                            selected={[scope.mode]}
                            onChange={(selected) => {
                              const mode = selected[0] === "selected" ? "selected" : "all";
                              if (mode === scope.mode) return;
                              setScope(
                                feature.key,
                                mode === "all"
                                  ? { mode: "all", markets: [...scope.markets] }
                                  : {
                                      mode: "selected",
                                      markets:
                                        scope.markets.length > 0
                                          ? [...scope.markets]
                                          : markets.map((m) => m.handle),
                                    },
                              );
                            }}
                          />
                        </BlockStack>
                      </div>
                    );
                  })}
                </BlockStack>
              </Card>
            </div>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
