import prisma from "../db.server";
import type { BoosterSettings } from "../models/settings.server";
import { LEGACY_KIT_CODES, aliasCodesFor } from "../models/settings.server";
import type { MarketSummary } from "./markets.server";
import { listMarkets } from "./markets.server";
import {
  syncSettingsToMetafields,
  writeGiftStockMetafield,
} from "./metafields.server";

/**
 * v14 rewards server service (docs/SPEC-v14-rewards.md §3).
 *
 *  - RewardsState (prisma): per-shop Discount Function id, discount node ids,
 *    the ladder unit map / variant→product map (so the metafield sync never
 *    calls the Admin API) and the gift-stock watcher state.
 *  - connectRewardsDiscounts: creates/updates the KIT code discounts + the two
 *    automatic discounts ("Cellexia free gifts" / "Cellexia free shipping")
 *    backed by the deployed "Cellexia rewards" Discount Function.
 *  - suggestGiftThresholds: pricing-aware per-market gift amounts.
 *  - refreshGiftStock: inventoryLevels per warehouse → paused gift options per
 *    market → RewardsState.giftStock + the `cellexia/gift_stock` metafield.
 *
 * Every mutation checks userErrors; every entry point returns
 * {ok, errors, summary} and never throws for merchant-facing failures.
 * GraphQL field names verified against the Admin API 2025-10 schema
 * (validate_graphql_codeblocks, 2026-08-16).
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/** Title of the Discount Function extension (extensions/cellexia-rewards). */
export const REWARDS_FUNCTION_TITLE = "Cellexia rewards";
/** Extension handle (shopify.extension.toml) — Admin API 2025-10 prefers
 *  functionHandle over the deprecated functionId in DiscountCodeAppInput /
 *  DiscountAutomaticAppInput. */
export const REWARDS_FUNCTION_HANDLE = "cellexia-rewards";
/** Our app handle (shopify.app.toml) — second match key for the function. */
export const REWARDS_APP_HANDLE = "cellexia-aov-ltv-booster";
export const GIFT_DISCOUNT_TITLE = "Cellexia free gifts";
export const SHIP_DISCOUNT_TITLE = "Cellexia free shipping";
/** Products tagged this way are sachets (SPEC v14 §0). */
export const SACHET_TAG = "sample-sachet";
/** Sachets pause below max(minUnits, this) units. */
export const SACHET_STOCK_FLOOR = 100;

export interface RewardsNodes {
  /** KIT code -> DiscountCodeNode GID */
  kit: Record<string, string>;
  /** "Cellexia free gifts" DiscountAutomaticNode GID ("" = not connected) */
  gift: string;
  /** "Cellexia free shipping" DiscountAutomaticNode GID ("" = not connected) */
  ship: string;
  /** numeric variantId -> ladder units (only entries > 1) */
  units: Record<string, number>;
  /** numeric variantId -> numeric productId (every active product's variants) */
  vp: Record<string, string>;
  /** numeric productId -> product handle (active products) */
  handles: Record<string, string>;
}

export interface GiftStockEntry {
  avail: number;
  paused: boolean;
}

export interface GiftStockState {
  /** ISO timestamp of the last refresh ("" = never) */
  t: string;
  /** market handle -> numeric variantId -> {avail, paused} */
  byMarket: Record<string, Record<string, GiftStockEntry>>;
  /** numeric inventoryItemId -> numeric variantId (webhook membership test) */
  items: Record<string, string>;
}

export interface RewardsStateSnapshot {
  shop: string;
  functionId: string;
  nodes: RewardsNodes;
  giftStock: GiftStockState;
  updatedAt: Date | null;
}

export interface RewardsResult<T = undefined> {
  ok: boolean;
  errors: string[];
  summary: string;
  data?: T;
}

function emptyNodes(): RewardsNodes {
  return { kit: {}, gift: "", ship: "", units: {}, vp: {}, handles: {} };
}

function emptyGiftStock(): GiftStockState {
  return { t: "", byMarket: {}, items: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "gid://shopify/ProductVariant/123" -> "123" (already-numeric ids pass through). */
export function numericId(gid: string): string {
  const match = /(\d+)(?:\?.*)?$/.exec(String(gid ?? "").trim());
  return match ? match[1] : "";
}

function parseNodes(raw: string): RewardsNodes {
  const out = emptyNodes();
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!isRecord(parsed)) return out;
    if (isRecord(parsed.kit)) {
      for (const [code, id] of Object.entries(parsed.kit)) {
        if (typeof id === "string" && id) out.kit[code] = id;
      }
    }
    if (typeof parsed.gift === "string") out.gift = parsed.gift;
    if (typeof parsed.ship === "string") out.ship = parsed.ship;
    if (isRecord(parsed.units)) {
      for (const [vid, units] of Object.entries(parsed.units)) {
        if (typeof units === "number" && Number.isInteger(units) && units > 1) {
          out.units[vid] = units;
        }
      }
    }
    if (isRecord(parsed.vp)) {
      for (const [vid, pid] of Object.entries(parsed.vp)) {
        if (typeof pid === "string" && /^\d+$/.test(pid)) out.vp[vid] = pid;
      }
    }
    if (isRecord(parsed.handles)) {
      for (const [pid, handle] of Object.entries(parsed.handles)) {
        if (typeof handle === "string" && handle) out.handles[pid] = handle;
      }
    }
  } catch {
    // unreadable json → empty state (Connect rebuilds it)
  }
  return out;
}

function parseGiftStock(raw: string): GiftStockState {
  const out = emptyGiftStock();
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!isRecord(parsed)) return out;
    if (typeof parsed.t === "string") out.t = parsed.t;
    if (isRecord(parsed.byMarket)) {
      for (const [market, entries] of Object.entries(parsed.byMarket)) {
        if (!isRecord(entries)) continue;
        const clean: Record<string, GiftStockEntry> = {};
        for (const [vid, entry] of Object.entries(entries)) {
          if (
            isRecord(entry) &&
            typeof entry.avail === "number" &&
            typeof entry.paused === "boolean"
          ) {
            clean[vid] = { avail: entry.avail, paused: entry.paused };
          }
        }
        out.byMarket[market] = clean;
      }
    }
    if (isRecord(parsed.items)) {
      for (const [item, vid] of Object.entries(parsed.items)) {
        if (typeof vid === "string" && vid) out.items[item] = vid;
      }
    }
  } catch {
    // unreadable json → empty state
  }
  return out;
}

export async function getRewardsState(shop: string): Promise<RewardsStateSnapshot> {
  const row = await prisma.rewardsState.findUnique({ where: { shop } });
  if (!row) {
    return {
      shop,
      functionId: "",
      nodes: emptyNodes(),
      giftStock: emptyGiftStock(),
      updatedAt: null,
    };
  }
  return {
    shop,
    functionId: row.functionId,
    nodes: parseNodes(row.nodes),
    giftStock: parseGiftStock(row.giftStock),
    updatedAt: row.updatedAt,
  };
}

export async function saveRewardsState(
  shop: string,
  patch: {
    functionId?: string;
    nodes?: RewardsNodes;
    giftStock?: GiftStockState;
  },
): Promise<RewardsStateSnapshot> {
  const data: { functionId?: string; nodes?: string; giftStock?: string } = {};
  if (typeof patch.functionId === "string") data.functionId = patch.functionId;
  if (patch.nodes) data.nodes = JSON.stringify(patch.nodes);
  if (patch.giftStock) data.giftStock = JSON.stringify(patch.giftStock);
  await prisma.rewardsState.upsert({
    where: { shop },
    create: { shop, ...data },
    update: data,
  });
  return getRewardsState(shop);
}

/** The paused-set projection Liquid/the storefront read (SPEC §2.3). */
export function pausedByMarket(
  giftStock: GiftStockState,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [market, entries] of Object.entries(giftStock.byMarket)) {
    const paused = Object.entries(entries)
      .filter(([, e]) => e.paused)
      .map(([vid]) => vid)
      .sort();
    if (paused.length > 0) out[market] = paused;
  }
  return out;
}

// ---------------------------------------------------------------------------
// GraphQL helpers
// ---------------------------------------------------------------------------

async function gql<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(
    query,
    variables ? { variables } : undefined,
  );
  const json = (await response.json()) as T & {
    errors?: { message: string }[];
  };
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json;
}

function userErrorMessages(
  errors: { field?: string[] | null; message: string }[] | undefined,
): string[] {
  return (errors ?? []).map((e) =>
    e.field && e.field.length ? `${e.field.join(".")}: ${e.message}` : e.message,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Unit map (ladder positions) — Connect / Rewards-page save
// ---------------------------------------------------------------------------

const UNIT_MAP_QUERY = `#graphql
  query cellexiaUnitMap($cursor: String) {
    products(first: 50, after: $cursor, query: "status:active") {
      nodes {
        id
        handle
        tags
        variants(first: 10) {
          nodes { id position }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export interface UnitMap {
  /** numeric variantId -> units (only entries > 1) */
  units: Record<string, number>;
  /** numeric variantId -> numeric productId */
  vp: Record<string, string>;
  /** numeric productId -> handle */
  handles: Record<string, string>;
  /** numeric productIds tagged sample-sachet */
  sachetPids: string[];
}

/**
 * Units of a ladder variant = its 1-based position (index + 1 when Shopify
 * omits it) — the ladder is "1 jar / 2 jars / 3 jars" by construction, and a
 * title regex misread titles like "50ml" or "3-in-1". Only entries > 1 are
 * kept (SPEC §0). 50 active products × 10 variants per page keeps the query
 * cost under the 1,000-point single-query ceiling (100 × 10 costs ~1,302);
 * up to 6 pages = 300 products, the Cellexia catalogue is 11 full-size
 * products so page 2 is fetched only when Shopify reports one.
 */
export async function buildUnitMap(admin: AdminGraphqlClient): Promise<UnitMap> {
  const out: UnitMap = { units: {}, vp: {}, handles: {}, sachetPids: [] };
  let cursor: string | null = null;
  for (let page = 0; page < 6; page += 1) {
    const json: {
      data?: {
        products?: {
          nodes?: {
            id: string;
            handle: string;
            tags?: string[];
            variants?: {
              nodes?: { id: string; position?: number }[];
            };
          }[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      };
    } = await gql(admin, UNIT_MAP_QUERY, cursor ? { cursor } : undefined);
    const products = json.data?.products?.nodes ?? [];
    for (const product of products) {
      const pid = numericId(product.id);
      if (!pid) continue;
      out.handles[pid] = product.handle;
      if ((product.tags ?? []).includes(SACHET_TAG)) out.sachetPids.push(pid);
      const variants = product.variants?.nodes ?? [];
      variants.forEach((variant, index) => {
        const vid = numericId(variant.id);
        if (!vid) return;
        out.vp[vid] = pid;
        const units =
          typeof variant.position === "number" && variant.position > 0 ? variant.position : index + 1;
        if (units > 1) out.units[vid] = units;
      });
    }
    const pageInfo = json.data?.products?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }
  return out;
}

/**
 * Rebuilds the unit/variant→product maps into RewardsState.nodes (keeps the
 * discount node ids). Called by Connect and by the Rewards page save so the
 * metafield projection is always current without an API call at sync time.
 */
export async function refreshUnitMap(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<RewardsResult<UnitMap>> {
  try {
    const map = await buildUnitMap(admin);
    const state = await getRewardsState(shop);
    await saveRewardsState(shop, {
      nodes: {
        ...state.nodes,
        units: map.units,
        vp: map.vp,
        handles: map.handles,
      },
    });
    return {
      ok: true,
      errors: [],
      summary: `${Object.keys(map.units).length} ladder variants mapped.`,
      data: map,
    };
  } catch (error) {
    return {
      ok: false,
      errors: [`Could not read the product ladder: ${errorMessage(error)}`],
      summary: "Unit map not refreshed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Discount nodes
// ---------------------------------------------------------------------------

const FUNCTIONS_QUERY = `#graphql
  query cellexiaRewardsFunctions {
    shopifyFunctions(first: 25) {
      nodes { id apiType title app { handle } }
    }
  }
`;

const CODE_BY_CODE_QUERY = `#graphql
  query cellexiaCodeByCode($code: String!) {
    codeDiscountNodeByCode(code: $code) {
      id
      codeDiscount {
        __typename
        ... on DiscountCodeApp {
          title
          status
          appDiscountType { functionId }
        }
        ... on DiscountCodeBasic { status }
        ... on DiscountCodeBxgy { status }
        ... on DiscountCodeFreeShipping { status }
      }
    }
  }
`;

/** Shape returned by CODE_BY_CODE_QUERY (shared by Connect + the legacy sweep). */
interface CodeNodeLookup {
  data?: {
    codeDiscountNodeByCode?: {
      id: string;
      codeDiscount?: {
        __typename?: string;
        status?: string;
        appDiscountType?: { functionId?: string } | null;
      } | null;
    } | null;
  };
}

const CODE_APP_CREATE = `#graphql
  mutation cellexiaCodeAppCreate($codeAppDiscount: DiscountCodeAppInput!) {
    discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
      codeAppDiscount { discountId status }
      userErrors { field message code }
    }
  }
`;

const CODE_APP_UPDATE = `#graphql
  mutation cellexiaCodeAppUpdate($id: ID!, $codeAppDiscount: DiscountCodeAppInput!) {
    discountCodeAppUpdate(id: $id, codeAppDiscount: $codeAppDiscount) {
      codeAppDiscount { discountId status }
      userErrors { field message code }
    }
  }
`;

const CODE_DELETE = `#graphql
  mutation cellexiaCodeDelete($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedCodeDiscountId
      userErrors { field message code }
    }
  }
`;

/** v14.2: legacy basic KIT codes are DEACTIVATED, never deleted (a live cart
 *  may still carry them; the merchant can reactivate by hand). Verified
 *  against Admin API 2025-10 (validate_graphql_codeblocks, 2026-08-16). */
const CODE_DEACTIVATE = `#graphql
  mutation cellexiaCodeDeactivate($id: ID!) {
    discountCodeDeactivate(id: $id) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }
`;

const AUTO_APP_CREATE = `#graphql
  mutation cellexiaAutoAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
      automaticAppDiscount { discountId status }
      userErrors { field message code }
    }
  }
`;

const AUTO_APP_UPDATE = `#graphql
  mutation cellexiaAutoAppUpdate($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
      automaticAppDiscount { discountId status }
      userErrors { field message code }
    }
  }
`;

const DISCOUNT_NODES_QUERY = `#graphql
  query cellexiaDiscountNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      id
      ... on DiscountCodeNode {
        codeDiscount {
          ... on DiscountCodeApp { status title appDiscountType { functionId } }
        }
      }
      ... on DiscountAutomaticNode {
        automaticDiscount {
          ... on DiscountAutomaticApp { status title appDiscountType { functionId } }
        }
      }
    }
  }
`;

const COMBINES_WITH_ALL = {
  orderDiscounts: true,
  productDiscounts: true,
  shippingDiscounts: true,
};

/** Resolves the deployed "Cellexia rewards" discount function id ("" = none). */
export async function findRewardsFunctionId(
  admin: AdminGraphqlClient,
): Promise<string> {
  const json = await gql<{
    data?: {
      shopifyFunctions?: {
        nodes?: {
          id: string;
          apiType: string;
          title: string;
          app?: { handle?: string | null } | null;
        }[];
      };
    };
  }>(admin, FUNCTIONS_QUERY);
  const candidates = (json.data?.shopifyFunctions?.nodes ?? []).filter(
    (fn) => fn.apiType === "discount",
  );
  const byTitle = candidates.find(
    (fn) => fn.title.trim().toLowerCase() === REWARDS_FUNCTION_TITLE.toLowerCase(),
  );
  if (byTitle) return byTitle.id;
  const byApp = candidates.find((fn) => fn.app?.handle === REWARDS_APP_HANDLE);
  return byApp?.id ?? "";
}

export interface DiscountNodeStatus {
  id: string;
  exists: boolean;
  status: string;
  title: string;
  functionId: string;
}

/** Reads status/functionId of the given discount node ids (health check + Connect). */
export async function readDiscountNodes(
  admin: AdminGraphqlClient,
  ids: string[],
): Promise<Record<string, DiscountNodeStatus>> {
  const out: Record<string, DiscountNodeStatus> = {};
  const wanted = ids.filter(Boolean);
  if (wanted.length === 0) return out;
  const json = await gql<{
    data?: {
      nodes?: ({
        id: string;
        codeDiscount?: {
          status?: string;
          title?: string;
          appDiscountType?: { functionId?: string };
        } | null;
        automaticDiscount?: {
          status?: string;
          title?: string;
          appDiscountType?: { functionId?: string };
        } | null;
      } | null)[];
    };
  }>(admin, DISCOUNT_NODES_QUERY, { ids: wanted });
  for (const id of wanted) out[id] = { id, exists: false, status: "", title: "", functionId: "" };
  for (const node of json.data?.nodes ?? []) {
    if (!node) continue;
    const d = node.codeDiscount ?? node.automaticDiscount ?? null;
    out[node.id] = {
      id: node.id,
      exists: true,
      status: d?.status ?? "",
      title: d?.title ?? "",
      functionId: d?.appDiscountType?.functionId ?? "",
    };
  }
  return out;
}

/**
 * Connects the discount nodes (SPEC §3): the KIT code discounts (one per
 * set-savings tier) and the two automatic discounts. All created ACTIVE but
 * inert until the rewards metafield says `on`. `replaceExisting` deletes a
 * same-code discount that is NOT ours (e.g. a manual KIT2 the merchant made
 * earlier); without it such a code is reported as an error and skipped.
 * v14.3: every LEGACY_KIT_CODES entry that is NOT in the ladder is an ALIAS
 * code while `keepLegacyCodes` is on — created/updated through the very same
 * code path as the ladder codes (title "Set savings alias KITn"; the
 * Function grants the qualifying tier for it). Only when `keepLegacyCodes`
 * is OFF does the v14.2 legacy sweep run: with `replaceExisting` it
 * DEACTIVATES legacy basic KIT codes that are not ours and not in the ladder
 * — reported as "deactivated legacy code X".
 */
export async function connectRewardsDiscounts(
  admin: AdminGraphqlClient,
  shop: string,
  settings: BoosterSettings,
  options: { replaceExisting?: boolean } = {},
): Promise<RewardsResult<RewardsStateSnapshot>> {
  const errors: string[] = [];
  const notes: string[] = [];
  let functionId = "";
  try {
    functionId = await findRewardsFunctionId(admin);
  } catch (error) {
    return {
      ok: false,
      errors: [`Could not list Shopify Functions: ${errorMessage(error)}`],
      summary: "Not connected.",
    };
  }
  if (!functionId) {
    return {
      ok: false,
      errors: [
        "The Cellexia rewards discount function is not deployed. Deploy the extensions first (npm run deploy), then connect again.",
      ],
      summary: "Not connected.",
    };
  }

  const state = await getRewardsState(shop);
  const nodes: RewardsNodes = { ...state.nodes, kit: { ...state.nodes.kit } };
  const startsAt = new Date().toISOString();
  const ss = settings.rewards.setSavings;

  // 2. KIT code discounts (ladder tiers + v14.3 alias codes, ONE code path) --
  const aliasCodes = aliasCodesFor(settings);
  const codeJobs: { code: string; title: string; alias: boolean }[] = [
    ...ss.tiers.map((tier) => ({
      code: tier.code,
      title: `Set savings KIT${tier.count}`,
      alias: false,
    })),
    ...aliasCodes.map((code) => ({
      code,
      title: `Set savings alias ${code}`,
      alias: true,
    })),
  ];
  const wantedCodes = new Set(codeJobs.map((j) => j.code));
  for (const job of codeJobs) {
    const input = {
      title: job.title,
      code: job.code,
      functionHandle: REWARDS_FUNCTION_HANDLE,
      startsAt,
      combinesWith: COMBINES_WITH_ALL,
      discountClasses: ["PRODUCT"],
      appliesOnSubscription: ss.includeSubscriptions,
      appliesOnOneTimePurchase: true,
      // recurringCycleLimit is only meaningful (and only accepted) with
      // subscriptions on — DiscountCodeAppInput 2025-10.
      ...(ss.includeSubscriptions ? { recurringCycleLimit: 1 } : {}),
      usageLimit: null,
      appliesOncePerCustomer: false,
    };
    const label = job.alias ? `alias code ${job.code}` : job.code;
    try {
      const existing = await gql<CodeNodeLookup>(admin, CODE_BY_CODE_QUERY, { code: job.code });
      const node = existing.data?.codeDiscountNodeByCode ?? null;
      let updateId = "";
      if (node) {
        const ours =
          node.codeDiscount?.__typename === "DiscountCodeApp" &&
          node.codeDiscount.appDiscountType?.functionId === functionId;
        if (ours) {
          updateId = node.id;
        } else if (options.replaceExisting) {
          const del = await gql<{
            data?: {
              discountCodeDelete?: {
                deletedCodeDiscountId?: string | null;
                userErrors?: { field?: string[] | null; message: string }[];
              };
            };
          }>(admin, CODE_DELETE, { id: node.id });
          const delErrors = userErrorMessages(del.data?.discountCodeDelete?.userErrors);
          if (delErrors.length) {
            errors.push(`${job.code}: could not replace the existing discount — ${delErrors.join("; ")}`);
            continue;
          }
          notes.push(`${job.code}: replaced an existing non-Cellexia discount.`);
        } else {
          errors.push(
            `${job.code}: a discount with this code already exists and is not managed by Cellexia. Tick "Replace existing KIT codes" to replace it, or change the tier code.`,
          );
          continue;
        }
      }
      if (updateId) {
        const upd = await gql<{
          data?: {
            discountCodeAppUpdate?: {
              codeAppDiscount?: { discountId: string } | null;
              userErrors?: { field?: string[] | null; message: string }[];
            };
          };
        }>(admin, CODE_APP_UPDATE, { id: updateId, codeAppDiscount: input });
        const updErrors = userErrorMessages(upd.data?.discountCodeAppUpdate?.userErrors);
        if (updErrors.length) {
          errors.push(`${job.code}: update failed — ${updErrors.join("; ")}`);
          continue;
        }
        nodes.kit[job.code] = upd.data?.discountCodeAppUpdate?.codeAppDiscount?.discountId ?? updateId;
        notes.push(job.alias ? `updated ${label}.` : `${job.code}: updated.`);
      } else {
        const created = await gql<{
          data?: {
            discountCodeAppCreate?: {
              codeAppDiscount?: { discountId: string } | null;
              userErrors?: { field?: string[] | null; message: string }[];
            };
          };
        }>(admin, CODE_APP_CREATE, { codeAppDiscount: input });
        const createErrors = userErrorMessages(created.data?.discountCodeAppCreate?.userErrors);
        const id = created.data?.discountCodeAppCreate?.codeAppDiscount?.discountId;
        if (createErrors.length || !id) {
          errors.push(`${job.code}: create failed — ${createErrors.join("; ") || "no id returned"}`);
          continue;
        }
        nodes.kit[job.code] = id;
        notes.push(job.alias ? `created ${label}.` : `${job.code}: created.`);
      }
    } catch (error) {
      errors.push(`${job.code}: ${errorMessage(error)}`);
    }
  }
  // Codes removed from the tier table / alias list are forgotten (not
  // deleted — a live cart may still carry them; the Function refuses codes
  // that no longer match a tier or alias, so they are inert).
  for (const code of Object.keys(nodes.kit)) {
    if (!wantedCodes.has(code)) delete nodes.kit[code];
  }

  // 2b. v14.2 legacy sweep — v14.3: ONLY when "Keep legacy codes" is OFF
  // (otherwise those codes are aliases we just connected) and "Replace
  // existing" is ticked: a merchant who switched ladder preset (say extended
  // → compact) still has manual basic KIT5/KIT10 codes live; a shopper typing
  // one would get the old saving on top of ours. Deactivate (never delete)
  // every LEGACY_KIT_CODE that exists, is NOT our DiscountCodeApp and is NOT
  // in the configured ladder. Already-inactive codes are left alone.
  if (!ss.keepLegacyCodes && options.replaceExisting) {
    for (const code of LEGACY_KIT_CODES) {
      if (wantedCodes.has(code)) continue;
      try {
        const existing = await gql<CodeNodeLookup>(admin, CODE_BY_CODE_QUERY, { code });
        const node = existing.data?.codeDiscountNodeByCode ?? null;
        if (!node) continue;
        const kind = node.codeDiscount?.__typename ?? "";
        const oursApp =
          kind === "DiscountCodeApp" &&
          node.codeDiscount?.appDiscountType?.functionId === functionId;
        if (oursApp) continue;
        const status = (node.codeDiscount?.status ?? "").toUpperCase();
        if (status && status !== "ACTIVE" && status !== "SCHEDULED") continue;
        const off = await gql<{
          data?: {
            discountCodeDeactivate?: {
              codeDiscountNode?: { id: string } | null;
              userErrors?: { field?: string[] | null; message: string }[];
            };
          };
        }>(admin, CODE_DEACTIVATE, { id: node.id });
        const offErrors = userErrorMessages(off.data?.discountCodeDeactivate?.userErrors);
        if (offErrors.length) {
          errors.push(`${code}: could not deactivate the legacy discount — ${offErrors.join("; ")}`);
          continue;
        }
        notes.push(`deactivated legacy code ${code}.`);
      } catch (error) {
        errors.push(`${code}: legacy sweep failed — ${errorMessage(error)}`);
      }
    }
  }

  // 3. automatic discounts ----------------------------------------------------
  const upsertAutomatic = async (
    key: "gift" | "ship",
    title: string,
    discountClass: "PRODUCT" | "SHIPPING",
  ) => {
    const input = {
      title,
      functionHandle: REWARDS_FUNCTION_HANDLE,
      startsAt,
      combinesWith: COMBINES_WITH_ALL,
      discountClasses: [discountClass],
      // Gifts / free shipping apply to subscription and one-time lines alike;
      // first cycle only (DiscountAutomaticAppInput 2025-10 fields, validated
      // against the Admin schema).
      appliesOnSubscription: true,
      appliesOnOneTimePurchase: true,
      recurringCycleLimit: 1,
    };
    try {
      let existingId = nodes[key];
      if (existingId) {
        const status = await readDiscountNodes(admin, [existingId]);
        if (!status[existingId]?.exists) existingId = "";
      }
      if (existingId) {
        const upd = await gql<{
          data?: {
            discountAutomaticAppUpdate?: {
              automaticAppDiscount?: { discountId: string } | null;
              userErrors?: { field?: string[] | null; message: string }[];
            };
          };
        }>(admin, AUTO_APP_UPDATE, { id: existingId, automaticAppDiscount: input });
        const updErrors = userErrorMessages(upd.data?.discountAutomaticAppUpdate?.userErrors);
        if (updErrors.length) {
          errors.push(`${title}: update failed — ${updErrors.join("; ")}`);
          return;
        }
        nodes[key] = upd.data?.discountAutomaticAppUpdate?.automaticAppDiscount?.discountId ?? existingId;
        notes.push(`${title}: updated.`);
      } else {
        const created = await gql<{
          data?: {
            discountAutomaticAppCreate?: {
              automaticAppDiscount?: { discountId: string } | null;
              userErrors?: { field?: string[] | null; message: string }[];
            };
          };
        }>(admin, AUTO_APP_CREATE, { automaticAppDiscount: input });
        const createErrors = userErrorMessages(created.data?.discountAutomaticAppCreate?.userErrors);
        const id = created.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
        if (createErrors.length || !id) {
          errors.push(`${title}: create failed — ${createErrors.join("; ") || "no id returned"}`);
          return;
        }
        nodes[key] = id;
        notes.push(`${title}: created.`);
      }
    } catch (error) {
      errors.push(`${title}: ${errorMessage(error)}`);
    }
  };
  await upsertAutomatic("gift", GIFT_DISCOUNT_TITLE, "PRODUCT");
  await upsertAutomatic("ship", SHIP_DISCOUNT_TITLE, "SHIPPING");

  // 4. persist + unit map + rewards metafield --------------------------------
  try {
    const map = await buildUnitMap(admin);
    nodes.units = map.units;
    nodes.vp = map.vp;
    nodes.handles = map.handles;
  } catch (error) {
    errors.push(`Ladder unit map not refreshed: ${errorMessage(error)}`);
  }
  const saved = await saveRewardsState(shop, { functionId, nodes });
  try {
    const sync = await syncSettingsToMetafields(admin, settings);
    if (!sync.ok) errors.push(...sync.errors.map((e) => `Metafield sync: ${e}`));
  } catch (error) {
    errors.push(`Metafield sync: ${errorMessage(error)}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    summary: notes.join(" ") || "Nothing to connect.",
    data: saved,
  };
}

// ---------------------------------------------------------------------------
// Suggested per-market gift amounts (pricing-aware)
// ---------------------------------------------------------------------------

const REFERENCE_PRODUCTS_QUERY = `#graphql
  query cellexiaReferenceProducts {
    shop { currencyCode }
    products(first: 50, query: "status:active") {
      nodes {
        id
        handle
        tags
        variants(first: 3) { nodes { id price } }
      }
    }
  }
`;

const MARKET_FIRST_REGION_QUERY = `#graphql
  query cellexiaMarketFirstRegion {
    markets(first: 50) {
      nodes {
        handle
        regions(first: 1) { nodes { ... on MarketRegionCountry { code } } }
      }
    }
  }
`;

/** Markets priced in several currencies — EUR defaults stay unchanged. */
const MULTI_CURRENCY_MARKETS = new Set(["eu", "rest-of-world"]);
const REFERENCE_HANDLE = "jawline-contour-tightening-cream";
const PROTECTION_HANDLE = "cellexia-order-protection";

/** ≥1000 → nearest 10; ≥100 → nearest 5; else nearest 1 (SPEC §3). */
export function niceRound(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1000) return Math.round(value / 10) * 10;
  if (value >= 100) return Math.round(value / 5) * 5;
  return Math.round(value);
}

export async function suggestGiftThresholds(
  admin: AdminGraphqlClient,
  settings: BoosterSettings,
  markets: MarketSummary[],
): Promise<RewardsResult<Record<string, { amounts: number[]; currencyCode: string }>>> {
  const errors: string[] = [];
  const eur = settings.rewards.giftTiers.tiers.map((t) => t.amount);
  const gt = settings.rewards.giftTiers;
  const giftHandles = new Set<string>();
  for (const tier of gt.tiers) {
    for (const slot of tier.slots) {
      for (const option of slot) if (option.handle) giftHandles.add(option.handle);
    }
  }
  for (const entry of gt.samplePool) giftHandles.add(entry.handle);

  let shopCurrency = "";
  let referenceVariantId = "";
  let basePrice = 0;
  try {
    const json = await gql<{
      data?: {
        shop?: { currencyCode?: string };
        products?: {
          nodes?: {
            id: string;
            handle: string;
            tags?: string[];
            variants?: { nodes?: { id: string; price: string }[] };
          }[];
        };
      };
    }>(admin, REFERENCE_PRODUCTS_QUERY);
    shopCurrency = json.data?.shop?.currencyCode ?? "";
    const products = (json.data?.products?.nodes ?? []).filter(
      (p) =>
        !(p.tags ?? []).includes(SACHET_TAG) &&
        !giftHandles.has(p.handle) &&
        p.handle !== PROTECTION_HANDLE,
    );
    const preferred = products.find((p) => p.handle === REFERENCE_HANDLE);
    const reference =
      (preferred && (preferred.variants?.nodes?.length ?? 0) >= 3 ? preferred : null) ??
      products.find((p) => (p.variants?.nodes?.length ?? 0) >= 3) ??
      preferred ??
      products[0];
    const variant = reference?.variants?.nodes?.[0];
    if (variant) {
      referenceVariantId = variant.id;
      basePrice = parseFloat(variant.price) || 0;
    }
  } catch (error) {
    errors.push(`Could not read a reference product: ${errorMessage(error)}`);
  }

  const out: Record<string, { amounts: number[]; currencyCode: string }> = {};
  const enabled = markets.filter((m) => m.enabled);
  const needsPricing = enabled.filter(
    (m) =>
      !MULTI_CURRENCY_MARKETS.has(m.handle) &&
      m.currencyCode &&
      m.currencyCode !== shopCurrency,
  );
  for (const m of enabled) {
    if (!needsPricing.includes(m)) {
      out[m.handle] = { amounts: [...eur], currencyCode: shopCurrency || m.currencyCode || "EUR" };
    }
  }

  if (needsPricing.length > 0 && referenceVariantId && basePrice > 0) {
    // First region country per market (one uncached query — the admin
    // button is rare; marketCountryMap's per-shop cache needs a shop key).
    let countryOf = new Map<string, string>();
    try {
      const json = await gql<{
        data?: {
          markets?: {
            nodes?: {
              handle: string;
              regions?: { nodes?: ({ code?: string } | null)[] } | null;
            }[];
          };
        };
      }>(admin, MARKET_FIRST_REGION_QUERY);
      for (const m of json.data?.markets?.nodes ?? []) {
        const code = m.regions?.nodes?.[0]?.code;
        if (code) countryOf.set(m.handle, code);
      }
    } catch (error) {
      errors.push(`Could not read market regions: ${errorMessage(error)}`);
      countryOf = new Map();
    }
    const aliases: string[] = [];
    const aliasMarket: Record<string, MarketSummary> = {};
    needsPricing.forEach((m, i) => {
      const iso = countryOf.get(m.handle);
      if (!iso || !/^[A-Z]{2}$/.test(iso)) {
        errors.push(`${m.name}: no region country found — kept the EUR amounts.`);
        out[m.handle] = { amounts: [...eur], currencyCode: m.currencyCode };
        return;
      }
      const alias = `m${i}`;
      aliasMarket[alias] = m;
      aliases.push(
        `${alias}: productVariant(id: $id) { contextualPricing(context: {country: ${iso}}) { price { amount currencyCode } } }`,
      );
    });
    if (aliases.length > 0) {
      try {
        const json = await gql<{
          data?: Record<
            string,
            { contextualPricing?: { price?: { amount?: string; currencyCode?: string } | null } | null } | null
          >;
        }>(admin, `query cellexiaContextualPrices($id: ID!) { ${aliases.join(" ")} }`, {
          id: referenceVariantId,
        });
        for (const [alias, m] of Object.entries(aliasMarket)) {
          const price = json.data?.[alias]?.contextualPricing?.price;
          const amount = parseFloat(price?.amount ?? "") || 0;
          const currencyCode = price?.currencyCode || m.currencyCode;
          if (amount > 0) {
            const ratio = amount / basePrice;
            out[m.handle] = { amounts: eur.map((v) => niceRound(v * ratio)), currencyCode };
          } else {
            errors.push(`${m.name}: no contextual price — kept the EUR amounts.`);
            out[m.handle] = { amounts: [...eur], currencyCode: m.currencyCode };
          }
        }
      } catch (error) {
        errors.push(`Contextual pricing failed: ${errorMessage(error)}`);
        for (const m of Object.values(aliasMarket)) {
          out[m.handle] = { amounts: [...eur], currencyCode: m.currencyCode };
        }
      }
    }
  } else {
    for (const m of needsPricing) {
      out[m.handle] = { amounts: [...eur], currencyCode: m.currencyCode };
    }
    if (needsPricing.length > 0) {
      errors.push("No reference product with a price was found — EUR amounts were kept for every market.");
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    summary: `${Object.keys(out).length} markets suggested.`,
    data: out,
  };
}

// ---------------------------------------------------------------------------
// Gift stock watcher
// ---------------------------------------------------------------------------

const GIFT_STOCK_QUERY = `#graphql
  query cellexiaGiftStock($ids: [ID!]!) {
    nodes(ids: $ids) {
      id
      ... on ProductVariant {
        id
        product { id tags }
        inventoryItem {
          id
          tracked
          inventoryLevels(first: 20) {
            nodes {
              location { id isActive }
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      }
    }
  }
`;

/** nodes(ids:) is capped per call — 15 variants × 20 levels stays far under the query-cost ceiling. */
const GIFT_STOCK_BATCH = 15;
/** Sentinel "available" for a variant whose inventory is not tracked (never paused, shown as plentiful). */
export const UNTRACKED_AVAIL = 999999;

/** Every gift-pool + samplePool variant GID of the settings (deduped). */
export function giftVariantGids(settings: BoosterSettings): string[] {
  const ids = new Set<string>();
  for (const tier of settings.rewards.giftTiers.tiers) {
    for (const slot of tier.slots) {
      for (const option of slot) {
        if (option.kind === "variant" && option.variantId) ids.add(option.variantId);
      }
    }
  }
  for (const entry of settings.rewards.giftTiers.samplePool) ids.add(entry.variantId);
  return [...ids];
}

/**
 * Reads inventoryLevels of every gift variant, computes per-market
 * availability at the mapped warehouses (fallback: every active location)
 * and pauses an option where avail < floor (floor = max(minUnits, sachet ?
 * 100 : 0)). Persists RewardsState.giftStock and, when the paused set
 * changed, writes the `cellexia/gift_stock` metafield.
 */
export async function refreshGiftStock(
  admin: AdminGraphqlClient,
  shop: string,
  settings: BoosterSettings,
): Promise<RewardsResult<GiftStockState>> {
  const errors: string[] = [];
  const gt = settings.rewards.giftTiers;
  const gids = giftVariantGids(settings);
  const previous = await getRewardsState(shop);
  const next: GiftStockState = { t: new Date().toISOString(), byMarket: {}, items: {} };
  if (gids.length === 0) {
    const saved = await saveRewardsState(shop, { giftStock: next });
    if (Object.keys(pausedByMarket(previous.giftStock)).length > 0) {
      try {
        await writeGiftStockMetafield(admin, {});
      } catch (error) {
        errors.push(`gift_stock metafield: ${errorMessage(error)}`);
      }
    }
    return { ok: errors.length === 0, errors, summary: "No gift variants configured.", data: saved.giftStock };
  }

  const sachetVids = new Set(gt.samplePool.map((e) => numericId(e.variantId)));
  interface VariantStock {
    vid: string;
    sachet: boolean;
    /** false = Shopify does not track this item's inventory → never paused */
    tracked: boolean;
    byLocation: Record<string, number>;
  }
  const stocks: VariantStock[] = [];
  const activeLocations = new Set<string>();
  try {
    type StockNode = {
      id: string;
      product?: { id: string; tags?: string[] } | null;
      inventoryItem?: {
        id: string;
        tracked?: boolean | null;
        inventoryLevels?: {
          nodes?: {
            location?: { id: string; isActive?: boolean } | null;
            quantities?: { name: string; quantity: number }[];
          }[];
        } | null;
      } | null;
    } | null;
    const nodes: StockNode[] = [];
    for (let i = 0; i < gids.length; i += GIFT_STOCK_BATCH) {
      const json = await gql<{ data?: { nodes?: StockNode[] } }>(admin, GIFT_STOCK_QUERY, {
        ids: gids.slice(i, i + GIFT_STOCK_BATCH),
      });
      nodes.push(...(json.data?.nodes ?? []));
    }
    for (const node of nodes) {
      if (!node?.inventoryItem) continue;
      const vid = numericId(node.id);
      const sachet =
        sachetVids.has(vid) || (node.product?.tags ?? []).includes(SACHET_TAG);
      const byLocation: Record<string, number> = {};
      for (const level of node.inventoryItem.inventoryLevels?.nodes ?? []) {
        const locId = level.location?.id;
        if (!locId || level.location?.isActive === false) continue;
        activeLocations.add(locId);
        const available =
          level.quantities?.find((q) => q.name === "available")?.quantity ?? 0;
        byLocation[locId] = (byLocation[locId] ?? 0) + available;
      }
      next.items[numericId(node.inventoryItem.id)] = vid;
      stocks.push({ vid, sachet, tracked: node.inventoryItem.tracked !== false, byLocation });
    }
  } catch (error) {
    return {
      ok: false,
      errors: [`Could not read gift inventory: ${errorMessage(error)}`],
      summary: "Gift stock not refreshed.",
      data: previous.giftStock,
    };
  }

  let marketHandles: string[] = [];
  try {
    marketHandles = (await listMarkets(admin)).filter((m) => m.enabled).map((m) => m.handle);
  } catch (error) {
    errors.push(`Could not list markets: ${errorMessage(error)}`);
  }
  for (const handle of Object.keys(gt.warehouseByMarket)) {
    if (!marketHandles.includes(handle)) marketHandles.push(handle);
  }
  if (marketHandles.length === 0) marketHandles = Object.keys(previous.giftStock.byMarket);

  for (const market of marketHandles) {
    const locs = gt.warehouseByMarket[market]?.length
      ? gt.warehouseByMarket[market]
      : [...activeLocations];
    const entries: Record<string, GiftStockEntry> = {};
    for (const stock of stocks) {
      if (!stock.tracked) {
        // Untracked inventory reports 0 everywhere — never pause it.
        entries[stock.vid] = { avail: UNTRACKED_AVAIL, paused: false };
        continue;
      }
      const avail = locs.reduce((sum, loc) => sum + (stock.byLocation[loc] ?? 0), 0);
      const floor = Math.max(gt.stockFloor.minUnits, stock.sachet ? SACHET_STOCK_FLOOR : 0);
      entries[stock.vid] = { avail, paused: avail < floor };
    }
    next.byMarket[market] = entries;
  }

  const saved = await saveRewardsState(shop, { giftStock: next });
  const before = JSON.stringify(pausedByMarket(previous.giftStock));
  const after = pausedByMarket(next);
  if (before !== JSON.stringify(after)) {
    try {
      const result = await writeGiftStockMetafield(admin, after);
      if (!result.ok) errors.push(...result.errors.map((e) => `gift_stock metafield: ${e}`));
    } catch (error) {
      errors.push(`gift_stock metafield: ${errorMessage(error)}`);
    }
  }
  const pausedCount = Object.values(after).reduce((n, list) => n + list.length, 0);
  return {
    ok: errors.length === 0,
    errors,
    summary: `${stocks.length} gift variants checked across ${marketHandles.length} markets; ${pausedCount} paused option(s).`,
    data: saved.giftStock,
  };
}

/** True when the last stock refresh is older than `maxAgeMs` (or never ran). */
export function giftStockIsStale(
  giftStock: GiftStockState,
  maxAgeMs = 15 * 60 * 1000,
): boolean {
  if (!giftStock.t) return true;
  const t = Date.parse(giftStock.t);
  return !Number.isFinite(t) || Date.now() - t > maxAgeMs;
}
