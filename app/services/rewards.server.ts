import prisma from "../db.server";
import {
  saveSettings,
  roundThreshold,
  toCountryCode,
  clusterForCountry,
  REWARDS_CAPS,
  type BoosterSettings,
} from "../models/settings.server";
import { buildGiftPlan } from "./gift-plan.server";
import type { MarketSummary } from "./markets.server";
import { listMarkets } from "./markets.server";
import {
  syncSettingsToMetafields,
  writeGiftPlanMetafield,
} from "./metafields.server";

/**
 * v14 rewards server service (docs/SPEC-v14-rewards.md §3).
 *
 *  - RewardsState (prisma): per-shop Discount Function id, discount node ids,
 *    the ladder unit map / variant→product map (so the metafield sync never
 *    calls the Admin API) and the gift-stock watcher state.
 *  - connectRewardsDiscounts: creates/updates the app-owned SET code
 *    discounts + the two automatic discounts ("Cellexia free gifts" /
 *    "Cellexia free shipping") backed by the deployed "Cellexia rewards"
 *    Discount Function. v15 RULE: the routine NEVER deletes, deactivates or
 *    updates a discount that is not ours (ours = a DiscountCodeApp /
 *    DiscountAutomaticApp whose id is recorded in RewardsState.nodes OR whose
 *    appDiscountType.functionId equals our function) — a foreign discount
 *    that owns one of our codes is reported and skipped. There is no
 *    "replace existing" option any more; the discount delete / deactivate
 *    mutations are gone from this module on purpose (the harness pins the
 *    absence of their names).
 *  - detectStoreCodes: lists existing store codes by prefix (admin
 *    "Detect my existing KIT codes" → yieldToCodes suggestions). Read-only.
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
  /** ladder (SET) code -> DiscountCodeNode GID (the key is kept "kit" for
   *  stored-row compatibility) */
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
  /** v15: product handle -> numeric variantId of the FIRST AVAILABLE variant
   *  (first variant when none is available) — resolves gift options that
   *  carry a handle but no variantId at sync time (SPEC v15 §5), the same
   *  rule the storefront applies to the cart-data variants list. */
  hv: Record<string, string>;
}

export interface GiftStockEntry {
  avail: number;
  paused: boolean;
}

export interface GiftStockState {
  /** ISO timestamp of the last refresh ("" = never) */
  t: string;
  /** v18: cluster id -> numeric variantId -> {avail, paused} */
  byCluster: Record<string, Record<string, GiftStockEntry>>;
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
  return { kit: {}, gift: "", ship: "", units: {}, vp: {}, handles: {}, hv: {} };
}

function emptyGiftStock(): GiftStockState {
  return { t: "", byCluster: {}, items: {} };
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
    if (isRecord(parsed.hv)) {
      for (const [handle, vid] of Object.entries(parsed.hv)) {
        if (typeof vid === "string" && /^\d+$/.test(vid)) out.hv[handle] = vid;
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
    if (isRecord(parsed.byCluster)) {
      for (const [cluster, entries] of Object.entries(parsed.byCluster)) {
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
        out.byCluster[cluster] = clean;
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

let rewardsStateWarned = false;

export async function getRewardsState(shop: string): Promise<RewardsStateSnapshot> {
  // v15.2: NEVER throw. A production database that has not received the
  // v14 `RewardsState` table yet (prisma db push not run) or a stale Prisma
  // client (no `rewardsState` delegate) must degrade to "no rewards state"
  // — the app, its proxies and every other feature keep working; only the
  // rewards features stay dark until the migration lands.
  let row: { functionId: string; nodes: string; giftStock: string; updatedAt: Date } | null = null;
  try {
    row = await prisma.rewardsState.findUnique({ where: { shop } });
  } catch (error) {
    if (!rewardsStateWarned) {
      rewardsStateWarned = true;
      console.error(
        "[rewards] RewardsState is not readable — run `npx prisma db push` (see UPDATE.md §2/§3); rewards stay dark until then:",
        error instanceof Error ? error.message : error,
      );
    }
    row = null;
  }
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
  try {
    await prisma.rewardsState.upsert({
      where: { shop },
      create: { shop, ...data },
      update: data,
    });
  } catch (error) {
    // v15.2: surface as a plain Error the callers already report in their
    // banners (Connect / Refresh stock) instead of a 500.
    throw new Error(
      `Rewards storage is not ready (run \`npx prisma db push\` on the production database, see UPDATE.md §2): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return getRewardsState(shop);
}

/** v18: the paused-set projection, keyed by CLUSTER id, that the gift plan
 *  metafield carries and the storefront reads for its own country. */
export function pausedByCluster(
  giftStock: GiftStockState,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [cluster, entries] of Object.entries(giftStock.byCluster)) {
    const paused = Object.entries(entries)
      .filter(([, e]) => e.paused)
      .map(([vid]) => vid)
      .sort();
    if (paused.length > 0) out[cluster] = paused;
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
  /** v15.1: handle -> numeric variantId of the FIRST variant by position (availability ignored) */
  hv: Record<string, string>;
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
  const out: UnitMap = { units: {}, vp: {}, handles: {}, hv: {}, sachetPids: [] };
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
      let firstVid = "";
      variants.forEach((variant, index) => {
        const vid = numericId(variant.id);
        if (!vid) return;
        out.vp[vid] = pid;
        if (!firstVid) firstVid = vid;
        const units =
          typeof variant.position === "number" && variant.position > 0 ? variant.position : index + 1;
        if (units > 1) out.units[vid] = units;
      });
      // v15.1: FIRST VARIANT BY POSITION, regardless of availability — the
      // deterministic twin of the storefront's cart-data pick for
      // handle-only gift options (the storefront still refuses to add an
      // unavailable variant and falls to the next option, exactly as the
      // Function would not grant it either).
      const resolved = firstVid;
      if (product.handle && resolved) out.hv[product.handle] = resolved;
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
        hv: map.hv,
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

/** Shape returned by CODE_BY_CODE_QUERY (Connect ownership test). */
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
 * v15 ownership test for a code-discount node found by code: ours when it is
 * a DiscountCodeApp bound to our deployed Function OR its id is one we
 * recorded in RewardsState.nodes.kit (a node we created earlier, even if the
 * function id changed after a redeploy). Everything else is FOREIGN and is
 * never touched.
 */
export function isOurCodeNode(
  node: { id: string; codeDiscount?: { __typename?: string; appDiscountType?: { functionId?: string } | null } | null },
  functionId: string,
  knownIds: Iterable<string>,
): boolean {
  if (node.codeDiscount?.__typename === "DiscountCodeApp") {
    const fid = node.codeDiscount.appDiscountType?.functionId ?? "";
    if (fid && fid === functionId) return true;
    for (const id of knownIds) if (id && id === node.id) return true;
  }
  return false;
}

/** The exact merchant-facing message for a code owned by a foreign discount (pinned by the harness + admin). */
export function foreignCodeMessage(code: string): string {
  return `Code ${code} is already used by another discount in your store. Change the code in the table or delete that discount yourself; the app never touches discounts it did not create.`;
}

/**
 * Connects the discount nodes (SPEC §3, v15 rules): one app-owned code
 * discount per set-savings tier (SET2/SET3/…) and the two automatic
 * discounts. All created ACTIVE but inert until the rewards metafield says
 * `on`. NO options: the routine never deletes, deactivates or updates a
 * discount it does not own — a foreign discount that already uses one of
 * the ladder codes is reported with foreignCodeMessage() and skipped; the
 * merchant changes the code in the table or removes that discount by hand.
 * The store's historical KIT codes are untouched by design: the app steps
 * aside for them (rewards.setSavings.yieldToCodes) instead of replacing them.
 * v15.1: the collided codes are PERSISTED as rewards.setSavings.blockedCodes
 * (empty when none) before the metafield sync so the storefront + checkout
 * never attach a code the app does not own (that tier is unavailable).
 */
export async function connectRewardsDiscounts(
  admin: AdminGraphqlClient,
  shop: string,
  settings: BoosterSettings,
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
        "The Cellexia rewards discount function is not deployed. Deploy the extensions first (npm run deploy), then create the discount codes again.",
      ],
      summary: "Not connected.",
    };
  }

  const state = await getRewardsState(shop);
  const nodes: RewardsNodes = { ...state.nodes, kit: { ...state.nodes.kit } };
  const knownIds = new Set(Object.values(state.nodes.kit));
  const startsAt = new Date().toISOString();
  const ss = settings.rewards.setSavings;

  // 2. ladder code discounts (ours only) ------------------------------------
  const wantedCodes = new Set(ss.tiers.map((tier) => tier.code));
  // v15.1: ladder codes whose Shopify code belongs to a foreign discount.
  const blockedCodes: string[] = [];
  for (const tier of ss.tiers) {
    const code = tier.code;
    const input = {
      title: `Set savings ${code}`,
      code,
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
    try {
      const existing = await gql<CodeNodeLookup>(admin, CODE_BY_CODE_QUERY, { code });
      const node = existing.data?.codeDiscountNodeByCode ?? null;
      let updateId = "";
      if (node) {
        if (isOurCodeNode(node, functionId, knownIds)) {
          updateId = node.id;
        } else {
          // FOREIGN discount owns this code: report + skip. Never delete,
          // deactivate or update it.
          errors.push(foreignCodeMessage(code));
          delete nodes.kit[code];
          blockedCodes.push(code);
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
          errors.push(`${code}: update failed — ${updErrors.join("; ")}`);
          continue;
        }
        nodes.kit[code] = upd.data?.discountCodeAppUpdate?.codeAppDiscount?.discountId ?? updateId;
        notes.push(`${code}: updated.`);
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
          errors.push(`${code}: create failed — ${createErrors.join("; ") || "no id returned"}`);
          continue;
        }
        nodes.kit[code] = id;
        notes.push(`${code}: created.`);
      }
    } catch (error) {
      errors.push(`${code}: ${errorMessage(error)}`);
    }
  }
  // Codes removed from the tier table are forgotten (not deleted — a live
  // cart may still carry them; the Function refuses codes that no longer
  // match a tier, so they are inert; the merchant may delete them by hand).
  for (const code of Object.keys(nodes.kit)) {
    if (!wantedCodes.has(code)) delete nodes.kit[code];
  }

  // 3. automatic discounts (ours only: the id we recorded in RewardsState is
  //    updated; a node the merchant deleted by hand is recreated; nothing
  //    else in the store is ever looked at) --------------------------------
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
  // v15.3: the free-shipping guarantee is RETIRED (merchant decision — it
  // added complexity, and Shopify rejects a SHIPPING-class app discount that
  // "combines with shipping discounts": "automaticAppDiscount: is not
  // supported with these combines_with settings"). No shipping node is
  // created or updated any more; an existing "Cellexia free shipping" node
  // from an earlier Connect is left untouched (the Function's delivery
  // target stays inert because rewards.freeShip.enabled is forced off).

  // 4. persist + unit map + rewards metafield --------------------------------
  try {
    const map = await buildUnitMap(admin);
    nodes.units = map.units;
    nodes.vp = map.vp;
    nodes.handles = map.handles;
    nodes.hv = map.hv;
  } catch (error) {
    errors.push(`Ladder unit map not refreshed: ${errorMessage(error)}`);
  }
  const saved = await saveRewardsState(shop, { functionId, nodes });
  // v15.1: persist the collision list (empty when every code is ours) so
  // the storefront + checkout skip blocked tiers; the sync below mirrors the
  // UPDATED settings (blockedCodes rides in the config mirrors / rw island).
  let synced: BoosterSettings = settings;
  try {
    synced = await saveSettings(shop, {
      rewards: { setSavings: { blockedCodes } },
    });
  } catch (error) {
    errors.push(`Blocked codes not saved: ${errorMessage(error)}`);
  }
  try {
    const sync = await syncSettingsToMetafields(admin, synced);
    if (!sync.ok) errors.push(...sync.errors.map((e) => `Metafield sync: ${e}`));
    // v15: the rewards metafield is written in its own call and reported as
    // a warning by the sync — for Connect it IS the point (the Function's
    // only config), so surface it as an error here.
    errors.push(...sync.warnings.map((w) => `Metafield sync: ${w}`));
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
// v15 detectStoreCodes — read-only listing of existing store codes by prefix
// (admin "Detect my existing KIT codes" → yieldToCodes suggestions)
// ---------------------------------------------------------------------------

/**
 * `discountNodes(query: "method:code")` with the per-type `codes` connection
 * — the Admin API search syntax has no dedicated `code:` filter (verified
 * against the 2025-10 docs: default/title/status/type/method/... only), so
 * codes are matched client-side. Up to 4 pages × 50 discounts, 5 codes each
 * (bulk-code discounts carry more, but a redeem-code list is not what a
 * shopper types by hand). Query validated with validate_graphql_codeblocks
 * (2026-08-17).
 */
const DETECT_CODES_QUERY = `#graphql
  query cellexiaDetectCodes($query: String!, $cursor: String) {
    discountNodes(first: 50, after: $cursor, query: $query) {
      nodes {
        id
        discount {
          __typename
          ... on DiscountCodeBasic { status codes(first: 5) { nodes { code } } }
          ... on DiscountCodeBxgy { status codes(first: 5) { nodes { code } } }
          ... on DiscountCodeFreeShipping { status codes(first: 5) { nodes { code } } }
          ... on DiscountCodeApp { status codes(first: 5) { nodes { code } } appDiscountType { functionId } }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Prefix normaliser shared with the admin: trimmed, upper-cased, code characters only. */
export function normalizeCodePrefixes(prefixes: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of prefixes) {
    if (typeof raw !== "string") continue;
    const p = raw.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,32}$/.test(p) || out.includes(p)) continue;
    out.push(p);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * Existing discount CODES in the store (up to 25, upper-cased, deduped,
 * sorted) that start with any of `prefixes` — READ-ONLY. Our own
 * Function-backed codes are skipped (a shop never steps aside for itself);
 * expired discounts are skipped too (a shopper cannot apply them), scheduled
 * ones are kept. Throws on transport/GraphQL errors (callers report).
 */
export async function detectStoreCodes(
  admin: AdminGraphqlClient,
  prefixes: string[],
  options: { functionId?: string } = {},
): Promise<string[]> {
  const wanted = normalizeCodePrefixes(prefixes);
  if (wanted.length === 0) return [];
  const found = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 4 && found.size < 25; page += 1) {
    const json: {
      data?: {
        discountNodes?: {
          nodes?: {
            id: string;
            discount?: {
              __typename?: string;
              status?: string;
              codes?: { nodes?: { code?: string }[] } | null;
              appDiscountType?: { functionId?: string } | null;
            } | null;
          }[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      };
    } = await gql(admin, DETECT_CODES_QUERY, { query: "method:code", cursor });
    for (const node of json.data?.discountNodes?.nodes ?? []) {
      const d = node.discount;
      if (!d) continue;
      if ((d.status ?? "").toUpperCase() === "EXPIRED") continue;
      if (
        d.__typename === "DiscountCodeApp" &&
        options.functionId &&
        d.appDiscountType?.functionId === options.functionId
      ) {
        continue;
      }
      for (const entry of d.codes?.nodes ?? []) {
        const code = String(entry?.code ?? "").trim().toUpperCase();
        if (!code || !wanted.some((p) => code.startsWith(p))) continue;
        found.add(code);
      }
    }
    const pageInfo = json.data?.discountNodes?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }
  return [...found].sort().slice(0, 25);
}

// ---------------------------------------------------------------------------
// v18: suggested per-COUNTRY gift amounts, scaled to local price
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

const REFERENCE_HANDLE = "jawline-contour-tightening-cream";
const PROTECTION_HANDLE = "cellexia-order-protection";
/** How many products the ratio is sampled from (median wins). See below. */
const REFERENCE_SAMPLE = 3;
/** Countries aliased into one contextualPricing query. */
const CONTEXTUAL_BATCH = 40;

/** ≥1000 → nearest 10; ≥100 → nearest 5; else nearest 1. Kept for the
 *  free-shipping suggester, which has its own expectations. */
export function niceRound(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1000) return Math.round(value / 10) * 10;
  if (value >= 100) return Math.round(value / 5) * 5;
  return Math.round(value);
}

/** The median of a non-empty numeric list. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface CountryThresholdSuggestion {
  amounts: number[];
  currencyCode: string;
  /** localPrice / basePrice. NOT a price premium: it bundles the exchange
   *  rate with the market's own price-list adjustment, and is only ever the
   *  right multiplier because the threshold is denominated in the same
   *  currency as the price it came from. Surfaced so the admin can show
   *  where a surprising number came from. */
  ratio: number;
  /** The cluster whose ladder this country scales. */
  clusterId: string;
}

/**
 * Per-country gift amounts, scaled by that country's own price level.
 *
 * Each country's EUR ladder comes from ITS cluster, then every amount is
 * multiplied by `localPrice / basePrice` and rounded. Requiring the same
 * number of jars everywhere is the point: a €150 tier on a €57 product is
 * about 2.6 units, and a country paying 20 % more should reach its gift on
 * the same basket, not on 20 % fewer products.
 *
 * Three things this fixes versus the v14 per-market version:
 *
 *  1. It no longer skips countries whose currency equals the shop currency.
 *     Finland carries an explicit +15 % price-list adjustment in EUR and was
 *     silently keeping the flat EUR ladder, handing out gifts materially
 *     cheaper than intended. Same for the euro-denominated Rest Of World
 *     countries at +20 %.
 *  2. It no longer skips the multi-currency markets (`eu`, `rest-of-world`),
 *     which is where most of the non-European countries actually live.
 *  3. It resolves per COUNTRY, which is what clusters are keyed by anyway.
 *
 * The ratio is the MEDIAN over up to three reference products, because a
 * market can override individual products with fixed prices (Ireland has 27,
 * the UK 9) and a single sampled variant would then swing a whole country's
 * ladder.
 */
export async function suggestGiftThresholds(
  admin: AdminGraphqlClient,
  settings: BoosterSettings,
  countries: string[],
): Promise<RewardsResult<Record<string, CountryThresholdSuggestion>>> {
  const errors: string[] = [];
  const gt = settings.rewards.giftTiers;
  const out: Record<string, CountryThresholdSuggestion> = {};

  const wanted = [...new Set(countries.map((c) => toCountryCode(c)).filter(Boolean))].slice(
    0,
    REWARDS_CAPS.thresholdCountries,
  );
  if (wanted.length === 0) {
    return { ok: true, errors, summary: "No countries to price.", data: out };
  }

  // Reference products: active, not a sachet, not a gift, not the protection
  // product. The jawline cream is preferred (it is the store's hero SKU and
  // exists in every market), then any other product with a full ladder.
  const giftHandles = new Set<string>();
  for (const cluster of gt.clusters) {
    for (const tier of cluster.tiers) {
      for (const slot of tier.slots) {
        for (const option of slot) if (option.handle) giftHandles.add(option.handle);
      }
    }
  }
  for (const entry of gt.samplePool) giftHandles.add(entry.handle);

  let shopCurrency = "";
  const references: { id: string; price: number }[] = [];
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
        p.handle !== PROTECTION_HANDLE &&
        (p.variants?.nodes?.length ?? 0) > 0,
    );
    const ordered = [
      ...products.filter((p) => p.handle === REFERENCE_HANDLE),
      ...products.filter((p) => p.handle !== REFERENCE_HANDLE),
    ];
    for (const product of ordered) {
      const variant = product.variants?.nodes?.[0];
      const price = parseFloat(variant?.price ?? "");
      if (!variant || !(price > 0)) continue;
      references.push({ id: variant.id, price });
      if (references.length >= REFERENCE_SAMPLE) break;
    }
  } catch (error) {
    errors.push(`Could not read reference products: ${errorMessage(error)}`);
  }

  if (references.length === 0) {
    errors.push("No reference product with a price was found, so no amounts could be suggested.");
    return { ok: false, errors, summary: "Nothing suggested.", data: out };
  }

  // One contextual-pricing call per reference product, aliased over every
  // country, so the whole table costs at most three round trips.
  const priceByCountry = new Map<string, number[]>();
  const currencyByCountry = new Map<string, string>();
  for (const reference of references) {
    for (let i = 0; i < wanted.length; i += CONTEXTUAL_BATCH) {
      const slice = wanted.slice(i, i + CONTEXTUAL_BATCH);
      const aliases = slice.map(
        (code, n) =>
          `c${n}: productVariant(id: $id) { contextualPricing(context: {country: ${code}}) { price { amount currencyCode } } }`,
      );
      try {
        const json = await gql<{
          data?: Record<
            string,
            { contextualPricing?: { price?: { amount?: string; currencyCode?: string } | null } | null } | null
          >;
        }>(admin, `query cellexiaContextualPrices($id: ID!) { ${aliases.join(" ")} }`, {
          id: reference.id,
        });
        slice.forEach((code, n) => {
          const price = json.data?.[`c${n}`]?.contextualPricing?.price;
          const amount = parseFloat(price?.amount ?? "");
          if (!(amount > 0)) return;
          const ratios = priceByCountry.get(code) ?? [];
          ratios.push(amount / reference.price);
          priceByCountry.set(code, ratios);
          const currency = price?.currencyCode || "";
          if (currency) currencyByCountry.set(code, currency);
        });
      } catch (error) {
        errors.push(`Contextual pricing failed: ${errorMessage(error)}`);
      }
    }
  }

  for (const code of wanted) {
    const cluster = clusterForCountry(gt.clusters, code);
    if (!cluster || cluster.tiers.length === 0) continue;
    const eur = cluster.tiers.map((t) => t.amount);
    const ratios = priceByCountry.get(code) ?? [];
    const currencyCode = currencyByCountry.get(code) || shopCurrency || "EUR";
    if (ratios.length === 0) {
      errors.push(`${code}: no contextual price, so the cluster's own amounts were kept.`);
      out[code] = { amounts: [...eur], currencyCode, ratio: 1, clusterId: cluster.id };
      continue;
    }
    const ratio = median(ratios);
    // Strictly increasing after rounding: two neighbouring tiers can round
    // onto the same step in a big-number currency, and an equal pair would be
    // refused by the sanitizer and drop the whole country.
    const amounts: number[] = [];
    for (const value of eur) {
      let rounded = roundThreshold(value * ratio);
      const previous = amounts[amounts.length - 1];
      if (previous !== undefined && rounded <= previous) rounded = previous + 1;
      amounts.push(rounded);
    }
    out[code] = { amounts, currencyCode, ratio, clusterId: cluster.id };
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: `${Object.keys(out).length} countries priced from ${references.length} reference product(s).`,
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
/** v18: "Shopify has no inventory record here". Never pauses; the admin
 *  renders it as "unknown" so it reads differently from a checked low count. */
export const UNKNOWN_AVAIL = -1;

/**
 * Every gift-pool + samplePool variant GID of the settings (deduped). v15:
 * a variant option with an empty variantId but a handle resolves through
 * `hv` (RewardsState.nodes.hv — v15.1: FIRST variant by position at the last
 * unit-map refresh, availability ignored) so the stock watcher, the metafield
 * and the storefront see the same variant.
 */
export function giftVariantGids(
  settings: BoosterSettings,
  hv: Record<string, string> = {},
): string[] {
  const ids = new Set<string>();
  // v18: every cluster's ladder, not one flat table.
  for (const cluster of settings.rewards.giftTiers.clusters) {
    for (const tier of cluster.tiers) {
      for (const slot of tier.slots) {
        for (const option of slot) {
          if (option.kind !== "variant") continue;
          if (option.variantId) ids.add(option.variantId);
          else if (option.handle && hv[option.handle]) {
            ids.add(`gid://shopify/ProductVariant/${hv[option.handle]}`);
          }
        }
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
  const previous = await getRewardsState(shop);
  const gids = giftVariantGids(settings, previous.nodes.hv);
  const next: GiftStockState = { t: new Date().toISOString(), byCluster: {}, items: {} };
  if (gids.length === 0) {
    const saved = await saveRewardsState(shop, { giftStock: next });
    if (Object.keys(pausedByCluster(previous.giftStock)).length > 0) {
      try {
        await writeGiftPlanMetafield(admin, buildGiftPlan(settings, {}, previous.nodes.hv));
      } catch (error) {
        errors.push(`gift plan metafield: ${errorMessage(error)}`);
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

  // v18: availability is per CLUSTER (a cluster is a fulfilment centre), so
  // the locations come from the cluster itself. A cluster that names none
  // falls back to every active location.
  for (const cluster of gt.clusters) {
    const locs = cluster.locations.length ? cluster.locations : [...activeLocations];
    const entries: Record<string, GiftStockEntry> = {};
    for (const stock of stocks) {
      if (!stock.tracked) {
        // Untracked inventory reports 0 everywhere: never pause it.
        entries[stock.vid] = { avail: UNTRACKED_AVAIL, paused: false };
        continue;
      }
      // v18 FAIL OPEN. Only locations that actually reported a level count.
      // Shopify returns a row with quantity 0 for a location that is genuinely
      // empty, and NO row at all for one it has no record for, and third-party
      // warehouses routinely have no record. Treating "no record" as zero
      // paused real gifts and silently deleted whole tiers from the ladder,
      // so unknown is now unknown and never pauses.
      const known = locs.filter((loc) => stock.byLocation[loc] !== undefined);
      if (known.length === 0) {
        entries[stock.vid] = { avail: UNKNOWN_AVAIL, paused: false };
        continue;
      }
      const avail = known.reduce((sum, loc) => sum + (stock.byLocation[loc] ?? 0), 0);
      const floor = Math.max(gt.stockFloor.minUnits, stock.sachet ? SACHET_STOCK_FLOOR : 0);
      entries[stock.vid] = { avail, paused: avail < floor };
    }
    next.byCluster[cluster.id] = entries;
  }

  const saved = await saveRewardsState(shop, { giftStock: next });
  const after = pausedByCluster(next);
  // v18: the plan is written EVERY refresh, not only when the paused set
  // moved. It now carries the clusters, the country map and the per-country
  // amounts as well as the pauses, so gating on stock alone would leave the
  // storefront reading a stale ladder after any settings-only save. This runs
  // on a save, on "Refresh stock", on a debounced inventory webhook and at
  // most every 15 minutes from the loader, so the extra write is cheap.
  try {
    const result = await writeGiftPlanMetafield(
      admin,
      buildGiftPlan(settings, after, previous.nodes.hv),
    );
    if (!result.ok) errors.push(...result.errors.map((e: string) => `gift plan metafield: ${e}`));
  } catch (error) {
    errors.push(`gift plan metafield: ${errorMessage(error)}`);
  }
  const pausedCount = Object.values(after).reduce((n, list) => n + list.length, 0);
  return {
    ok: errors.length === 0,
    errors,
    summary: `${stocks.length} gift variants checked across ${gt.clusters.length} clusters; ${pausedCount} paused option(s).`,
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
