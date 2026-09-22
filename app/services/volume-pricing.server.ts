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
/** Aliases per contextualPricing call (the rewards CONTEXTUAL_BATCH twin). */
const CONTEXTUAL_BATCH = 40;
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
  _s: { h: string; t: string; d: string };
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
  query cellexiaVolumeMetafield {
    shop {
      id
      metafield(namespace: "${VOLUME_NS}", key: "${VOLUME_KEY}") {
        value
      }
    }
  }
`;

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

/**
 * contextualPricing for one variant across many countries, aliased 40 per
 * call (the v18 gifts pattern). Returns ISO2 -> {currency, amount}.
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
    const json = await gql<{
      data?: Record<
        string,
        { contextualPricing?: { price?: { amount?: string; currencyCode?: string } | null } | null } | null
      >;
    }>(admin, `query cellexiaVolumePrices($id: ID!) { ${aliases.join(" ")} }`, {
      id: variantGid,
    });
    slice.forEach((code, n) => {
      const price = json.data?.[`c${n}`]?.contextualPricing?.price;
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
  const json = await gql<{
    data?: { shop?: { id?: string; metafield?: { value?: string } | null } };
  }>(admin, VOLUME_METAFIELD_QUERY);
  const shopId = json.data?.shop?.id ?? "";
  const raw = json.data?.shop?.metafield?.value;
  if (!raw) return { shopId, cfg: null };
  try {
    const parsed = JSON.parse(raw) as VolumeConfig;
    if (parsed && typeof parsed === "object" && parsed.v === 1 && parsed.p) {
      return { shopId, cfg: parsed };
    }
  } catch {
    /* malformed = absent */
  }
  return { shopId, cfg: null };
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

/**
 * Finds (by the id recorded in `_s.d`) or creates the automatic app
 * discount. Created ACTIVE but inert until cfg.on (the v14 pattern);
 * nothing else in the store's discounts is ever read or touched.
 */
async function ensureVolumeDiscount(
  admin: AdminGraphqlClient,
  knownId: string,
  errors: string[],
): Promise<string> {
  const input = {
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
  if (knownId) {
    try {
      const found = await gql<{
        data?: { node?: { id?: string; automaticDiscount?: { title?: string } | null } | null };
      }>(admin, DISCOUNT_NODE_QUERY, { id: knownId });
      if (found.data?.node?.id === knownId) {
        const upd = await gql<{
          data?: {
            discountAutomaticAppUpdate?: {
              automaticAppDiscount?: { discountId: string } | null;
              userErrors?: { message: string }[];
            };
          };
        }>(admin, AUTO_APP_UPDATE, { id: knownId, automaticAppDiscount: input });
        const updErrors = (upd.data?.discountAutomaticAppUpdate?.userErrors ?? []).map((e) => e.message);
        if (updErrors.length) {
          errors.push(`${VOLUME_DISCOUNT_TITLE}: update failed — ${updErrors.join("; ")}`);
          return knownId;
        }
        return upd.data?.discountAutomaticAppUpdate?.automaticAppDiscount?.discountId ?? knownId;
      }
    } catch (error) {
      errors.push(`${VOLUME_DISCOUNT_TITLE}: lookup failed — ${errorMessage(error)}`);
      return knownId;
    }
  }
  try {
    const created = await gql<{
      data?: {
        discountAutomaticAppCreate?: {
          automaticAppDiscount?: { discountId: string } | null;
          userErrors?: { message: string }[];
        };
      };
    }>(admin, AUTO_APP_CREATE, { automaticAppDiscount: input });
    const createErrors = (created.data?.discountAutomaticAppCreate?.userErrors ?? []).map((e) => e.message);
    const id = created.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
    if (createErrors.length || !id) {
      errors.push(
        `${VOLUME_DISCOUNT_TITLE}: create failed — ${createErrors.join("; ") || "no id returned"}. ` +
          "Deploy the extensions first (npm run deploy) so the cellexia-volume function exists, then save again.",
      );
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

  const p: VolumeConfig["p"] = {};
  let priceFailures = 0;
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
      }
    } catch (error) {
      priceFailures += 1;
      errors.push(`Prices for ${product.title}: ${errorMessage(error)}`);
    }
  }

  const buildComplete = errors.length === 0 && priceFailures === 0 && Object.keys(p).length > 0;
  const on = armed && buildComplete;
  if (armed && !buildComplete) {
    errors.push(
      "Volume pricing was NOT armed: the price sync did not complete cleanly. Fix the errors above and save again.",
    );
  }

  const hash = sha256Hex(
    JSON.stringify({ p, on, countries, scope: settings.marketScopes.quantity_sync }),
  );
  if (!options.force && previous && previous._s?.h === hash && previous._s?.d) {
    return { ok: errors.length === 0, errors, notes: ["Volume config unchanged — nothing to write."] };
  }

  const discountId = await ensureVolumeDiscount(admin, previous?._s?.d ?? "", errors);
  const cfg: VolumeConfig = {
    v: 1,
    on: on && !!discountId,
    p,
    _s: { h: hash, t: new Date().toISOString(), d: discountId },
  };
  if (on && !discountId) {
    errors.push("Volume pricing was NOT armed: the automatic discount could not be created.");
  }
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

/**
 * The settings-sync hook: re-derives `on` and the scope filter over the
 * ALREADY-mirrored prices (no Admin price fetch), so a scope flip or a
 * feature toggle from any admin page is honored in the same save. Newly
 * scoped countries without mirrored prices stay excluded (fail closed)
 * until the next full refresh; volumeStatus() surfaces them.
 */
export async function projectVolumeScope(
  admin: AdminGraphqlClient,
  shop: string,
  settings: BoosterSettings,
): Promise<string[]> {
  const warnings: string[] = [];
  let shopId = "";
  let cfg: VolumeConfig | null = null;
  try {
    const read = await readVolumeConfig(admin);
    shopId = read.shopId;
    cfg = read.cfg;
  } catch (error) {
    return [`Volume re-projection read failed: ${errorMessage(error)}`];
  }
  if (!cfg || !shopId) return warnings; // never synced: nothing to re-project
  let wanted: Set<string>;
  try {
    wanted = new Set(await scopedCountries(admin, shop, settings));
  } catch (error) {
    return [`Volume re-projection scope failed: ${errorMessage(error)}`];
  }
  const p: VolumeConfig["p"] = {};
  for (const [pid, entry] of Object.entries(cfg.p)) {
    const cc: Record<string, VolumeCountryEntry> = {};
    for (const [code, ce] of Object.entries(entry.cc)) {
      if (wanted.has(code)) cc[code] = ce;
    }
    if (Object.keys(cc).length > 0) p[pid] = { k: entry.k, v1: entry.v1, cc };
  }
  const on = volumeArmed(settings) && Object.keys(p).length > 0 && !!cfg._s?.d;
  const next: VolumeConfig = { v: 1, on, p, _s: cfg._s };
  if (JSON.stringify(next) === JSON.stringify(cfg)) return warnings;
  try {
    const writeErrors = await writeVolumeConfig(admin, shopId, next);
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
