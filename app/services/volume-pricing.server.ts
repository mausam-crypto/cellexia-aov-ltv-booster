/**
 * v32 volume pricing — the server half of docs/SPEC-v32-volume-pricing.md.
 *
 * Owns everything around the "Cellexia volume pricing" Discount Function:
 *
 *  - deriving the tier catalog (the server twin of the widget's
 *    consecutive-1..K rule: variant titles' leading integers by position),
 *  - fetching per-COUNTRY presentment prices for the 1-unit and top-tier
 *    variants (aliased contextualPricing batches — the v18 gifts pattern),
 *  - building + writing the function's config metafield
 *    ($app:cellexia/volume) with the market scope of `quantity_sync`
 *    applied (only in-scope countries are mirrored),
 *  - creating/finding the app-owned automatic discount (created ACTIVE
 *    but inert until the config says `on` — the v14 rewards pattern; the
 *    routine never reads or touches any other discount in the store),
 *  - the freshness discipline: a full refresh runs from the Quantity page
 *    save, the products/update webhook (debounced there) and a 24 h lazy
 *    check; `projectVolumeScope` is the CHEAP re-projection (on-flag +
 *    scope filter over the already-mirrored prices) that every settings
 *    sync applies so a Markets-matrix scope flip is honored immediately.
 *
 * State lives INSIDE the metafield (`_s: {h, t, d}` = inputs hash, synced
 * ISO time, discount GID) — no Prisma model, no migration; the function
 * ignores unknown keys. Every failure path reports and leaves `on` as it
 * was or false, never a half-armed config.
 */
import crypto from "node:crypto";
import type { BoosterSettings } from "../models/settings.server";
import { listMarkets, marketCountryMap } from "./markets.server";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/** ISO 4217 exceptions to the 2-decimal default (the widget's island cents
 *  are Shopify minor units, so the mirror must use the same factor). */
const MINOR_PER_UNIT: Record<string, 1 | 1000> = {
  BIF: 1, CLP: 1, DJF: 1, GNF: 1, ISK: 1, JPY: 1, KMF: 1, KRW: 1,
  PYG: 1, RWF: 1, UGX: 1, VND: 1, VUV: 1, XAF: 1, XOF: 1, XPF: 1,
  BHD: 1000, IQD: 1000, JOD: 1000, KWD: 1000, LYD: 1000, OMR: 1000, TND: 1000,
};

export function minorPerUnit(currency: string): 1 | 100 | 1000 {
  return MINOR_PER_UNIT[currency] ?? 100;
}

/** Decimal amount string -> integer minor units (round-half-up); NaN -> -1. */
export function amountToMinor(amount: string | undefined, m: 1 | 100 | 1000): number {
  const n = Number(amount);
  if (!isFinite(n) || n < 0) return -1;
  return Math.round(n * m);
}

const VOLUME_NS = "$app:cellexia";
const VOLUME_KEY = "volume";
export const VOLUME_FUNCTION_HANDLE = "cellexia-volume";
export const VOLUME_DISCOUNT_TITLE = "Cellexia volume pricing";
/** Full refreshes older than this are re-run lazily from the admin loader. */
export const VOLUME_SYNC_TTL_MS = 24 * 60 * 60 * 1000;
/** Aliases per contextualPricing call — 20 (half the rewards batch): the
 *  cost per call stays well under the throttle bucket even mid-burst. */
const CONTEXTUAL_BATCH = 20;
/** Variant-title unit parse, the qselQty server twin (leading int 1..24). */
export function unitCount(title: string | undefined): number {
  const m = /^\s*(\d{1,2})(?!\d)/.exec(typeof title === "string" ? title : "");
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 24 ? n : 0;
}

export interface TierProduct {
  /** numeric product id */
  pid: string;
  title: string;
  k: number;
  /** numeric + gid of the 1-unit and top-tier variants */
  v1: string;
  v1Gid: string;
  vTopGid: string;
}

export interface VolumeCountryEntry {
  c: string;
  m: 1 | 100 | 1000;
  p1: number;
  p3: number;
}

export interface VolumeConfig {
  v: 1;
  on: boolean;
  p: Record<string, { k: number; v1: string; cc: Record<string, VolumeCountryEntry> }>;
  /** Server state (the function ignores it): inputs hash, synced ISO time,
   *  discount GID, last refresh outcome + reasons (v32.1 — so the admin
   *  page can SAY why arming was refused instead of leaving the merchant
   *  to guess). */
  _s: { h: string; t: string; d: string; ok?: boolean; e?: string[] };
}

export interface VolumeStatus {
  configured: boolean;
  on: boolean;
  discountId: string;
  syncedAt: string;
  products: number;
  countries: number;
  /** in-scope countries that have NO mirrored prices yet (await a full refresh) */
  missingCountries: string[];
  stale: boolean;
  /** v32.1 — the persisted reasons of the last refresh (empty = clean). */
  lastErrors: string[];
}

export interface VolumeResult {
  ok: boolean;
  errors: string[];
  notes: string[];
}

function numericId(gid: string | undefined | null): string {
  if (!gid) return "";
  const s = String(gid);
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function gql<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  return (await response.json()) as T;
}

// ---------------------------------------------------------------- queries

const SHOP_ID_QUERY = `#graphql
  query cellexiaVolumeShopId {
    shop { id }
    currentAppInstallation { id }
  }
`;

const VOLUME_METAFIELD_QUERY = `#graphql
  query cellexiaVolumeMetafield($ns: String!) {
    shop {
      id
      metafield(namespace: $ns, key: "${VOLUME_KEY}") {
        value
      }
    }
  }
`;

const APP_NS_QUERY = `#graphql
  query cellexiaVolumeAppNs {
    currentAppInstallation { app { id } }
  }
`;

/**
 * v32.2 (field incident 2): the "$app:cellexia" shorthand is PROVEN for
 * writes (metafieldsSet) and for function/checkout reads, but the Admin
 * API READ of the same namespace came back empty on the live store — the
 * app could not see its own config, treated every sync as the first one,
 * and died on "Title must be unique" re-creating its own discount. The
 * concrete reserved form ("app--{numeric app id}--cellexia") is resolved
 * once per process and used as the read fallback.
 */
let concreteNamespaceCache: string | null = null;
async function concreteVolumeNamespace(admin: AdminGraphqlClient): Promise<string | null> {
  if (concreteNamespaceCache) return concreteNamespaceCache;
  try {
    const json = await gql<{
      data?: { currentAppInstallation?: { app?: { id?: string } | null } | null };
    }>(admin, APP_NS_QUERY);
    const num = numericId(json.data?.currentAppInstallation?.app?.id ?? "");
    if (num) {
      concreteNamespaceCache = `app--${num}--cellexia`;
      return concreteNamespaceCache;
    }
  } catch {
    /* fall through */
  }
  return null;
}

const METAFIELDS_SET = `#graphql
  mutation cellexiaVolumeMetafieldSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

const TIER_PRODUCTS_QUERY = `#graphql
  query cellexiaVolumeProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      nodes {
        id
        title
        isGiftCard
        variants(first: 10) {
          nodes { id title position }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const AUTO_APP_CREATE = `#graphql
  mutation cellexiaVolumeAutoCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
      automaticAppDiscount { discountId status }
      userErrors { field message code }
    }
  }
`;

const AUTO_APP_UPDATE = `#graphql
  mutation cellexiaVolumeAutoUpdate($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
      automaticAppDiscount { discountId status }
      userErrors { field message code }
    }
  }
`;

const DISCOUNT_NODE_QUERY = `#graphql
  query cellexiaVolumeDiscountNode($id: ID!) {
    node(id: $id) {
      id
      ... on DiscountAutomaticNode {
        automaticDiscount {
          ... on DiscountAutomaticApp { title status }
        }
      }
    }
  }
`;

const AUTO_LIST_QUERY = `#graphql
  query cellexiaVolumeAutoList {
    automaticDiscountNodes(first: 50) {
      nodes {
        id
        automaticDiscount {
          __typename
          ... on DiscountAutomaticApp {
            title
            appDiscountType { functionId }
          }
        }
      }
    }
  }
`;

const OWN_FUNCTIONS_QUERY = `#graphql
  query cellexiaVolumeFunctions {
    shopifyFunctions(first: 25) {
      nodes { id title apiType }
    }
  }
`;

// The stacking decision (merchant, 2026-09-21): codes may stack — all-true,
// the same shape rewards uses.
const COMBINES_WITH_ALL = {
  orderDiscounts: true,
  productDiscounts: true,
  shippingDiscounts: true,
};

// ---------------------------------------------------------- tier catalog

/**
 * Every product whose variants are the store's tier shape: 2..6 variants,
 * position-ordered, each title's leading integer == its 1-based position
 * (the widget's qselQty rule, server-side on default-locale titles).
 * Gift cards and anything that misses a beat are skipped — fail closed.
 */
export async function deriveTierProducts(admin: AdminGraphqlClient): Promise<TierProduct[]> {
  const out: TierProduct[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 6; page += 1) {
    const json: {
      data?: {
        products?: {
          nodes?: {
            id: string;
            title?: string;
            isGiftCard?: boolean;
            variants?: { nodes?: { id: string; title?: string; position?: number }[] };
          }[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      };
    } = await gql(admin, TIER_PRODUCTS_QUERY, cursor ? { cursor } : undefined);
    for (const product of json.data?.products?.nodes ?? []) {
      if (product.isGiftCard) continue;
      const variants = [...(product.variants?.nodes ?? [])].sort(
        (a, b) => (a.position ?? 0) - (b.position ?? 0),
      );
      if (variants.length < 2 || variants.length > 6) continue;
      let tiered = true;
      for (let i = 0; i < variants.length; i += 1) {
        if (unitCount(variants[i].title) !== i + 1) {
          tiered = false;
          break;
        }
      }
      if (!tiered) continue;
      const pid = numericId(product.id);
      const first = variants[0];
      const top = variants[variants.length - 1];
      if (!pid || !first?.id || !top?.id) continue;
      out.push({
        pid,
        title: product.title ?? pid,
        k: variants.length,
        v1: numericId(first.id),
        v1Gid: first.id,
        vTopGid: top.id,
      });
    }
    const pageInfo = json.data?.products?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
    cursor = pageInfo.endCursor;
  }
  return out;
}

// ------------------------------------------------------- country pricing

/** Pause between pricing calls — aliased contextualPricing is cost-heavy
 *  and the v32.0 field failure was exactly this: unpaced bursts hit the
 *  GraphQL throttle mid-run and left silent per-country gaps. (v32.2:
 *  150 ms with the per-product variant PAIR in parallel — the v32.1
 *  fully-sequential 250 ms run felt like the button hung.) */
const PRICE_CALL_SPACING_MS = 150;
const THROTTLE_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottled(errors: { message?: string; extensions?: { code?: string } }[] | undefined): boolean {
  for (const e of errors ?? []) {
    if (e?.extensions?.code === "THROTTLED") return true;
    if (typeof e?.message === "string" && e.message.toLowerCase().includes("throttl")) return true;
  }
  return false;
}

/**
 * contextualPricing for one variant across many countries, aliased
 * CONTEXTUAL_BATCH per call (the v18 gifts pattern), PACED and
 * throttle-retried (v32.1). Throws on a batch that still fails after the
 * retries — a silent gap must never masquerade as "no price for that
 * country" (the caller decides per product what a failure means).
 */
async function fetchVariantCountryPrices(
  admin: AdminGraphqlClient,
  variantGid: string,
  countries: string[],
): Promise<Map<string, { currency: string; amount: string }>> {
  const out = new Map<string, { currency: string; amount: string }>();
  for (let i = 0; i < countries.length; i += CONTEXTUAL_BATCH) {
    const slice = countries.slice(i, i + CONTEXTUAL_BATCH);
    const aliases = slice.map(
      (code, n) =>
        `c${n}: productVariant(id: $id) { contextualPricing(context: {country: ${code}}) { price { amount currencyCode } } }`,
    );
    let json:
      | {
          data?: Record<
            string,
            { contextualPricing?: { price?: { amount?: string; currencyCode?: string } | null } | null } | null
          >;
          errors?: { message?: string; extensions?: { code?: string } }[];
        }
      | null = null;
    for (let attempt = 0; attempt <= THROTTLE_RETRIES; attempt += 1) {
      if (i > 0 || attempt > 0) await sleep(attempt === 0 ? PRICE_CALL_SPACING_MS : 1000 * Math.pow(2, attempt - 1));
      json = await gql(admin, `query cellexiaVolumePrices($id: ID!) { ${aliases.join(" ")} }`, {
        id: variantGid,
      });
      if (!isThrottled(json?.errors)) break;
      json = null;
    }
    if (!json || (json.errors && json.errors.length && !json.data)) {
      const msg = json?.errors?.map((e) => e.message).join("; ") || "throttled after retries";
      throw new Error(`contextualPricing batch failed: ${msg}`);
    }
    slice.forEach((code, n) => {
      const price = json?.data?.[`c${n}`]?.contextualPricing?.price;
      if (price?.amount && price.currencyCode) {
        out.set(code, { currency: price.currencyCode, amount: price.amount });
      }
    });
  }
  return out;
}

// ----------------------------------------------------------- scope logic

/** ISO2 country list the quantity_sync market scope admits (sorted). */
export async function scopedCountries(
  admin: AdminGraphqlClient,
  shop: string,
  settings: BoosterSettings,
): Promise<string[]> {
  const map = await marketCountryMap(admin, shop);
  const scope = settings.marketScopes.quantity_sync;
  const selected =
    scope && scope.mode === "selected" ? new Set(scope.markets) : null;
  const out: string[] = [];
  for (const [country, market] of map.byCountry.entries()) {
    if (!selected || selected.has(market)) out.push(country);
  }
  return out.sort();
}

export function volumeArmed(settings: BoosterSettings): boolean {
  return settings.quantitySync.enabled === true && settings.quantitySync.volume === true;
}

// ------------------------------------------------------- metafield read/write

export async function readVolumeConfig(
  admin: AdminGraphqlClient,
): Promise<{ shopId: string; cfg: VolumeConfig | null }> {
  let shopId = "";
  const tryRead = async (ns: string): Promise<VolumeConfig | null> => {
    const json = await gql<{
      data?: { shop?: { id?: string; metafield?: { value?: string } | null } };
    }>(admin, VOLUME_METAFIELD_QUERY, { ns });
    shopId = json.data?.shop?.id || shopId;
    const raw = json.data?.shop?.metafield?.value;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as VolumeConfig;
      if (parsed && typeof parsed === "object" && parsed.v === 1 && parsed.p) {
        return parsed;
      }
    } catch {
      /* malformed = absent */
    }
    return null;
  };
  let cfg = await tryRead(VOLUME_NS);
  if (!cfg) {
    // v32.2: the shorthand read came back empty on the live store — retry
    // with the concrete reserved namespace before concluding "never synced".
    const concrete = await concreteVolumeNamespace(admin);
    if (concrete) cfg = await tryRead(concrete);
  }
  return { shopId, cfg };
}

async function writeVolumeConfig(
  admin: AdminGraphqlClient,
  shopId: string,
  cfg: VolumeConfig,
): Promise<string[]> {
  const json = await gql<{
    data?: { metafieldsSet?: { userErrors?: { message: string }[] } };
    errors?: { message: string }[];
  }>(admin, METAFIELDS_SET, {
    metafields: [
      {
        ownerId: shopId,
        namespace: VOLUME_NS,
        key: VOLUME_KEY,
        type: "json",
        value: JSON.stringify(cfg),
      },
    ],
  });
  return [
    ...(json.errors ?? []).map((e) => e.message),
    ...(json.data?.metafieldsSet?.userErrors ?? []).map((e) => e.message),
  ];
}

// ------------------------------------------------------------- discount

function volumeDiscountInput(): Record<string, unknown> {
  return {
    title: VOLUME_DISCOUNT_TITLE,
    functionHandle: VOLUME_FUNCTION_HANDLE,
    startsAt: "2026-01-01T00:00:00Z",
    combinesWith: COMBINES_WITH_ALL,
    discountClasses: ["PRODUCT"],
    // One-time lines only would be ideal, but the function itself already
    // refuses plan lines; applying on both keeps the input future-proof.
    appliesOnSubscription: true,
    appliesOnOneTimePurchase: true,
    recurringCycleLimit: 1,
  };
}

async function updateVolumeDiscount(
  admin: AdminGraphqlClient,
  id: string,
  errors: string[],
): Promise<string> {
  const upd = await gql<{
    data?: {
      discountAutomaticAppUpdate?: {
        automaticAppDiscount?: { discountId: string } | null;
        userErrors?: { message: string }[];
      };
    };
  }>(admin, AUTO_APP_UPDATE, { id, automaticAppDiscount: volumeDiscountInput() });
  const updErrors = (upd.data?.discountAutomaticAppUpdate?.userErrors ?? []).map((e) => e.message);
  if (updErrors.length) {
    errors.push(`${VOLUME_DISCOUNT_TITLE}: update failed — ${updErrors.join("; ")}`);
    return id;
  }
  return upd.data?.discountAutomaticAppUpdate?.automaticAppDiscount?.discountId ?? id;
}

/**
 * v32.2 (field incident 2): find OUR discount by its exact title when the
 * recorded id is missing/stale — the live store hit "Title must be unique"
 * because the config read came back empty and the app re-created its own
 * discount blind. Adoption is guarded: only a function-backed
 * DiscountAutomaticApp node with the EXACT title, and when the shop's
 * function list resolves, only one backed by THIS app's functions.
 * Anything else in the store's discounts is never touched.
 */
async function findVolumeDiscountByTitle(
  admin: AdminGraphqlClient,
  notes: string[],
): Promise<string> {
  const [list, fns] = await Promise.all([
    gql<{
      data?: {
        automaticDiscountNodes?: {
          nodes?: {
            id: string;
            automaticDiscount?: {
              __typename?: string;
              title?: string;
              appDiscountType?: { functionId?: string } | null;
            } | null;
          }[];
        };
      };
    }>(admin, AUTO_LIST_QUERY),
    gql<{ data?: { shopifyFunctions?: { nodes?: { id: string }[] } } }>(admin, OWN_FUNCTIONS_QUERY).catch(
      () => ({ data: undefined }),
    ),
  ]);
  const ours = new Set((fns.data?.shopifyFunctions?.nodes ?? []).map((n) => n.id));
  for (const node of list.data?.automaticDiscountNodes?.nodes ?? []) {
    const d = node.automaticDiscount;
    if (d?.__typename !== "DiscountAutomaticApp") continue;
    if (d.title !== VOLUME_DISCOUNT_TITLE) continue;
    const fid = d.appDiscountType?.functionId ?? "";
    if (ours.size > 0 && fid && !ours.has(fid)) continue; // another app's — never touch
    if (ours.size === 0 || !fid) {
      notes.push("Existing volume discount adopted by its exact title (function id not verifiable).");
    }
    return node.id;
  }
  return "";
}

/**
 * Finds (by the id recorded in `_s.d`, then by exact title) or creates the
 * automatic app discount. Created ACTIVE but inert until cfg.on (the v14
 * pattern); nothing else in the store's discounts is ever read or touched.
 */
async function ensureVolumeDiscount(
  admin: AdminGraphqlClient,
  knownId: string,
  errors: string[],
  notes: string[],
): Promise<string> {
  if (knownId) {
    try {
      const found = await gql<{
        data?: { node?: { id?: string; automaticDiscount?: { title?: string } | null } | null };
      }>(admin, DISCOUNT_NODE_QUERY, { id: knownId });
      if (found.data?.node?.id === knownId) {
        return await updateVolumeDiscount(admin, knownId, errors);
      }
    } catch (error) {
      errors.push(`${VOLUME_DISCOUNT_TITLE}: lookup failed — ${errorMessage(error)}`);
      return knownId;
    }
  }
  // v32.2: BEFORE creating, adopt an existing node with our exact title —
  // the id can be lost (a wiped config, a failed write) while the discount
  // lives on, and a blind create dies on the unique-title rule.
  try {
    const adopted = await findVolumeDiscountByTitle(admin, notes);
    if (adopted) {
      return await updateVolumeDiscount(admin, adopted, errors);
    }
  } catch (error) {
    errors.push(`${VOLUME_DISCOUNT_TITLE}: title lookup failed — ${errorMessage(error)}`);
  }
  try {
    const created = await gql<{
      data?: {
        discountAutomaticAppCreate?: {
          automaticAppDiscount?: { discountId: string } | null;
          userErrors?: { message: string }[];
        };
      };
    }>(admin, AUTO_APP_CREATE, { automaticAppDiscount: volumeDiscountInput() });
    const createErrors = (created.data?.discountAutomaticAppCreate?.userErrors ?? []).map((e) => e.message);
    const id = created.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
    if (createErrors.length || !id) {
      const joined = createErrors.join("; ") || "no id returned";
      if (/unique/i.test(joined)) {
        // The unique-title rule proves the discount EXISTS — one more
        // adoption pass (search lag), then an honest manual path.
        try {
          const retry = await findVolumeDiscountByTitle(admin, notes);
          if (retry) return await updateVolumeDiscount(admin, retry, errors);
        } catch {
          /* fall through to the honest error */
        }
        errors.push(
          `${VOLUME_DISCOUNT_TITLE}: a discount with this title already exists but could not be looked up. ` +
            `Delete "${VOLUME_DISCOUNT_TITLE}" in Shopify Admin -> Discounts, then press Refresh prices now.`,
        );
        return "";
      }
      // The deploy hint ONLY when the error is actually about the function
      // (the v32.1 blanket hint misled the merchant).
      const hint = /function/i.test(joined)
        ? " Deploy the extensions first (npm run deploy) so the cellexia-volume function exists, then save again."
        : "";
      errors.push(`${VOLUME_DISCOUNT_TITLE}: create failed — ${joined}.${hint}`);
      return "";
    }
    return id;
  } catch (error) {
    errors.push(`${VOLUME_DISCOUNT_TITLE}: ${errorMessage(error)}`);
    return "";
  }
}

// ------------------------------------------------------------ full refresh

/**
 * The FULL pipeline: catalog scan -> per-country prices for the in-scope
 * countries -> config build -> discount ensure -> metafield write. The
 * inputs hash short-circuits an unchanged world (unless `force`). A
 * pipeline that cannot complete never arms: `on` is written true only
 * when the whole build succeeded.
 */
export async function refreshVolumePricing(
  admin: AdminGraphqlClient,
  shop: string,
  settings: BoosterSettings,
  options: { force?: boolean } = {},
): Promise<VolumeResult> {
  const errors: string[] = [];
  const notes: string[] = [];
  const armed = volumeArmed(settings);
  let shopId = "";
  let previous: VolumeConfig | null = null;
  try {
    const read = await readVolumeConfig(admin);
    shopId = read.shopId;
    previous = read.cfg;
  } catch (error) {
    return { ok: false, errors: [`Volume config read failed: ${errorMessage(error)}`], notes };
  }
  if (!shopId) {
    return { ok: false, errors: ["Could not resolve the shop id for the volume config."], notes };
  }
  if (!armed && !previous) {
    // Never synced and not armed: nothing to build yet.
    return { ok: true, errors, notes: ["Volume pricing is off and has never been synced — nothing to do."] };
  }

  let tierProducts: TierProduct[] = [];
  let countries: string[] = [];
  try {
    [tierProducts, countries] = await Promise.all([
      deriveTierProducts(admin),
      scopedCountries(admin, shop, settings),
    ]);
  } catch (error) {
    return { ok: false, errors: [`Volume catalog scan failed: ${errorMessage(error)}`], notes };
  }
  if (tierProducts.length === 0) {
    errors.push("No tier-shaped products (consecutive 1..K unit variants) were found.");
  }
  if (countries.length === 0) {
    errors.push("The quantity-sync market scope admits no countries.");
  }

  // v32.1: PER-PRODUCT arming (the v32.0 all-or-nothing refused the whole
  // feature over one transient failure; every anchor in the function is
  // per line, so a product with clean data is safe to arm regardless of a
  // sibling's fetch trouble). Fetches run SEQUENTIALLY and paced; a
  // product whose fetch still fails after the throttle retries is skipped
  // WITH a recorded reason, never silently.
  const p: VolumeConfig["p"] = {};
  const skipped: string[] = [];
  for (const product of tierProducts) {
    try {
      const [ones, tops] = await Promise.all([
        fetchVariantCountryPrices(admin, product.v1Gid, countries),
        fetchVariantCountryPrices(admin, product.vTopGid, countries),
      ]);
      const cc: Record<string, VolumeCountryEntry> = {};
      for (const code of countries) {
        const one = ones.get(code);
        const top = tops.get(code);
        if (!one || !top || one.currency !== top.currency) continue;
        const m = minorPerUnit(one.currency);
        const p1 = amountToMinor(one.amount, m);
        const p3 = amountToMinor(top.amount, m);
        // Sanity: real prices, and a top tier that genuinely discounts —
        // p3 >= k*p1 would mean a negative/zero "discount": skip closed.
        if (p1 <= 0 || p3 <= 0 || p3 >= product.k * p1) continue;
        cc[code] = { c: one.currency, m, p1, p3 };
      }
      if (Object.keys(cc).length > 0) {
        p[product.pid] = { k: product.k, v1: product.v1, cc };
      } else {
        skipped.push(`${product.title}: no usable price points in the scoped countries.`);
      }
    } catch (error) {
      skipped.push(`${product.title}: ${errorMessage(error)}`);
    }
  }
  errors.push(...skipped);

  const on = armed && Object.keys(p).length > 0;
  if (armed && Object.keys(p).length === 0) {
    errors.push(
      "Volume pricing was NOT armed: no product ended up with usable prices. Fix the reasons above and press Refresh prices now.",
    );
  }

  const hash = sha256Hex(
    JSON.stringify({ p, on, countries, scope: settings.marketScopes.quantity_sync }),
  );
  if (!options.force && previous && previous._s?.h === hash && previous._s?.d && previous._s?.ok === (errors.length === 0)) {
    return { ok: errors.length === 0, errors, notes: ["Volume config unchanged — nothing to write."] };
  }

  const discountId = await ensureVolumeDiscount(admin, previous?._s?.d ?? "", errors, notes);
  if (on && !discountId) {
    errors.push("Volume pricing was NOT armed: the automatic discount could not be created.");
  }
  const cfg: VolumeConfig = {
    v: 1,
    on: on && !!discountId,
    p,
    _s: {
      h: hash,
      t: new Date().toISOString(),
      d: discountId,
      ok: errors.length === 0,
      e: errors.slice(0, 8).map((e) => e.slice(0, 200)),
    },
  };
  try {
    const writeErrors = await writeVolumeConfig(admin, shopId, cfg);
    if (writeErrors.length) {
      errors.push(...writeErrors.map((e) => `Volume config write: ${e}`));
    } else {
      notes.push(
        cfg.on
          ? `Volume pricing armed: ${Object.keys(p).length} products across ${countries.length} countries.`
          : "Volume config synced (not armed).",
      );
    }
  } catch (error) {
    errors.push(`Volume config write: ${errorMessage(error)}`);
  }
  return { ok: errors.length === 0, errors, notes };
}

// ------------------------------------------------------ cheap re-projection

export interface VolumePlan {
  shopId: string;
  current: VolumeConfig | null;
  /** The re-projected config to write (null when nothing was ever mirrored). */
  next: VolumeConfig | null;
  /**
   * The VERIFIED armed verdict — what the storefront blob mirrors as
   * `quantitySync.volumeLive` (v32.1). This is the fix for the v32.0 field
   * incident: the widget's 4+ mode must follow what checkout will actually
   * honor, never the raw admin switch, so a refused/incomplete arming can
   * only ever fall back to the v31 whole-packs composition (correct
   * charges, no function needed) instead of showing a discount that never
   * applies.
   */
  on: boolean;
  warnings: string[];
}

/**
 * The settings-sync half 1: re-derives `on` and the scope filter over the
 * ALREADY-mirrored prices (no Admin price fetch), so a scope flip or a
 * feature toggle from any admin page is honored in the same save. Newly
 * scoped countries without mirrored prices stay excluded (fail closed)
 * until the next full refresh; volumeStatus() surfaces them. Pure
 * read+compute — commitVolumePlan() writes.
 */
export async function planVolumeScope(
  admin: AdminGraphqlClient,
  shop: string,
  settings: BoosterSettings,
): Promise<VolumePlan> {
  const plan: VolumePlan = { shopId: "", current: null, next: null, on: false, warnings: [] };
  try {
    const read = await readVolumeConfig(admin);
    plan.shopId = read.shopId;
    plan.current = read.cfg;
  } catch (error) {
    plan.warnings.push(`Volume re-projection read failed: ${errorMessage(error)}`);
    return plan;
  }
  if (!plan.current || !plan.shopId) return plan; // never synced
  let wanted: Set<string>;
  try {
    wanted = new Set(await scopedCountries(admin, shop, settings));
  } catch (error) {
    plan.warnings.push(`Volume re-projection scope failed: ${errorMessage(error)}`);
    return plan;
  }
  const p: VolumeConfig["p"] = {};
  for (const [pid, entry] of Object.entries(plan.current.p)) {
    const cc: Record<string, VolumeCountryEntry> = {};
    for (const [code, ce] of Object.entries(entry.cc)) {
      if (wanted.has(code)) cc[code] = ce;
    }
    if (Object.keys(cc).length > 0) p[pid] = { k: entry.k, v1: entry.v1, cc };
  }
  plan.on = volumeArmed(settings) && Object.keys(p).length > 0 && !!plan.current._s?.d;
  plan.next = { v: 1, on: plan.on, p, _s: plan.current._s };
  return plan;
}

/** The settings-sync half 2: write the plan's next config when it differs. */
export async function commitVolumePlan(
  admin: AdminGraphqlClient,
  plan: VolumePlan,
): Promise<string[]> {
  const warnings = [...plan.warnings];
  if (!plan.next || !plan.shopId || !plan.current) return warnings;
  if (JSON.stringify(plan.next) === JSON.stringify(plan.current)) return warnings;
  try {
    const writeErrors = await writeVolumeConfig(admin, plan.shopId, plan.next);
    warnings.push(...writeErrors.map((e) => `Volume re-projection write: ${e}`));
  } catch (error) {
    warnings.push(`Volume re-projection write: ${errorMessage(error)}`);
  }
  return warnings;
}

// ---------------------------------------------------------------- status

/** Read-only admin status (no price fetch). */
export async function volumeStatus(
  admin: AdminGraphqlClient,
  shop: string,
  settings: BoosterSettings,
): Promise<VolumeStatus> {
  const status: VolumeStatus = {
    configured: false,
    on: false,
    discountId: "",
    syncedAt: "",
    products: 0,
    countries: 0,
    missingCountries: [],
    stale: false,
    lastErrors: [],
  };
  let cfg: VolumeConfig | null = null;
  try {
    cfg = (await readVolumeConfig(admin)).cfg;
  } catch {
    return status;
  }
  if (!cfg) return status;
  status.configured = true;
  status.on = cfg.on === true;
  status.discountId = cfg._s?.d ?? "";
  status.syncedAt = cfg._s?.t ?? "";
  status.lastErrors = Array.isArray(cfg._s?.e) ? cfg._s.e.filter((e) => typeof e === "string") : [];
  status.products = Object.keys(cfg.p).length;
  const covered = new Set<string>();
  for (const entry of Object.values(cfg.p)) {
    for (const code of Object.keys(entry.cc)) covered.add(code);
  }
  status.countries = covered.size;
  try {
    const wanted = await scopedCountries(admin, shop, settings);
    status.missingCountries = wanted.filter((code) => !covered.has(code));
  } catch {
    /* leave empty */
  }
  const syncedMs = Date.parse(status.syncedAt);
  status.stale = !isFinite(syncedMs) || Date.now() - syncedMs > VOLUME_SYNC_TTL_MS;
  return status;
}

/** Per-market rate rows for the admin table (from the mirrored config). */
export async function volumeRateRows(
  admin: AdminGraphqlClient,
  shop: string,
  cfg: VolumeConfig | null,
): Promise<{ market: string; country: string; currency: string; pct: string }[]> {
  if (!cfg) return [];
  const first = Object.values(cfg.p)[0];
  if (!first) return [];
  const map = await marketCountryMap(admin, shop);
  const markets = await listMarkets(admin).catch(() => []);
  const nameByHandle = new Map(markets.map((m) => [m.handle, m.name] as const));
  const seen = new Set<string>();
  const rows: { market: string; country: string; currency: string; pct: string }[] = [];
  for (const [code, ce] of Object.entries(first.cc)) {
    const handle = map.byCountry.get(code) ?? "";
    if (seen.has(handle + "|" + ce.c + "|" + ce.p1 + "|" + ce.p3)) continue;
    seen.add(handle + "|" + ce.c + "|" + ce.p1 + "|" + ce.p3);
    const k = first.k;
    const pct = (1 - ce.p3 / (k * ce.p1)) * 100;
    rows.push({
      market: nameByHandle.get(handle) ?? handle ?? code,
      country: code,
      currency: ce.c,
      pct: pct.toFixed(1),
    });
  }
  rows.sort((a, b) => a.market.localeCompare(b.market) || a.country.localeCompare(b.country));
  return rows;
}
