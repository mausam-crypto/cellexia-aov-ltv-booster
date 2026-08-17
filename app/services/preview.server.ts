import crypto from "node:crypto";
import prisma from "../db.server";
import {
  DELIVERY_ESTIMATE_FORMATS,
  FEATURE_KEYS,
  SHIPS_FROM_FORMATS,
  getSettings,
  sanitizeGiftThresholdsByMarket,
  sanitizeGiftTiers,
  sanitizeSetSavingsTiers,
  type BoosterSettings,
  type DeliveryEstimateFormat,
  type FeatureKey,
  type GiftTier,
  type SetSavingsTier,
  type ShipsFromFormat,
} from "../models/settings.server";
import {
  syncSettingsToMetafields,
  type PreviewSyncPayload,
} from "./metafields.server";

/**
 * Preview system server core (SPEC v4 §Server).
 *
 * TOKEN HANDLING RULES (non-negotiable, see SPEC v4 preview principles):
 *  - The raw token lives in: this DB (raw-at-rest is the DELIBERATE design —
 *    custom single-merchant app on our own server/DB; it keeps the shareable
 *    entry URL rebuildable), the entry URL (stripped from the address bar via
 *    history.replaceState as soon as the hub seeds sessionStorage), and
 *    sessionStorage of the previewing browser.
 *  - The checkout-only shop metafield carries ONLY the sha256 hash of the
 *    token (`tokenHash`, computed at write time in syncSettingsToMetafields).
 *    The `_cx_preview` cart attribute carries the SAME hash (tokenHashFor,
 *    computed server-side), so checkout extensions compare
 *    attribute === preview.tokenHash with plain string equality — no
 *    client-side crypto in extension runtimes.
 *  - Neither the token nor its hash is EVER written to the app-data
 *    metafield (page-visible Liquid config) — that split is enforced inside
 *    syncSettingsToMetafields.
 *  - Proxy endpoints verify the raw token SERVER-SIDE via timing-safe
 *    comparison against PreviewState.token.
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/**
 * Draft, preview-session-only configuration overrides (v5.8). Unlike
 * draftFlags (which feature is visible), draftConfig carries HOW a feature
 * renders in the preview session — the delivery-estimate widget formats
 * (v5.9/v6.0) and the az_ships_from style (v6.10). The v5.8 derm-survey
 * format override retired in v7 (the survey renders one per-product
 * outcomes format). Tokenless by construction (validated against closed
 * enums), so it is safe to mirror into the page-visible Liquid config
 * while armed.
 */
export interface PreviewDraftConfig {
  /** Delivery-estimate widget format previewed on the PRODUCT PAGE. */
  deliveryFormat?: DeliveryEstimateFormat;
  /** Delivery-estimate widget format previewed in the CART DRAWER (v6.0). */
  deliveryFormatCart?: DeliveryEstimateFormat;
  /** Delivery-estimate widget format previewed in CHECKOUT (v6.0). */
  deliveryFormatCheckout?: DeliveryEstimateFormat;
  /** az_ships_from display format previewed on the PRODUCT PAGE (v6.10). */
  shipsFromFormat?: ShipsFromFormat;
  /**
   * v14 cart simulator: the storefront's rwSpendCents()/rwDistinctCount()
   * return these values inside the preview session and NO cart mutation
   * happens. spendCents is in the cart's presentment currency
   * (0..100,000,000), count 0..50.
   */
  simCart?: { spendCents: number; count: number };
  /**
   * v14 live rehearsal: real cart mutations (gift lines, SET codes) are
   * allowed on the merchant's preview cart — storefront AND checkout
   * safety net. Only ever `true` (absent = off).
   */
  rehearsal?: boolean;
  /**
   * v14 draft rewards tiers/amounts, sanitized with the SAME settings
   * sanitizers (bounded, tokenless). buildRewardsMetafield re-sanitizes
   * them into the rewards metafield `draft` while armed.
   */
  rewards?: {
    setSavingsTiers?: SetSavingsTier[];
    giftTiers?: GiftTier[];
    giftAmountsByMarket?: Record<string, { amounts: number[]; currencyCode: string }>;
  };
}

/** v14 simCart bounds (SPEC §10). */
export const SIM_CART_MAX_SPEND_CENTS = 100_000_000;
export const SIM_CART_MAX_COUNT = 50;

/** Parsed, validated snapshot of a shop's PreviewState row. */
export interface PreviewSnapshot {
  shop: string;
  /** Raw preview token (server-side only — never put in Liquid config). */
  token: string;
  armed: boolean;
  armedAt: Date | null;
  draftFlags: Partial<Record<FeatureKey, boolean>>;
  draftConfig: PreviewDraftConfig;
  simulatedMarket: string | null;
  productHandle: string | null;
  updatedAt: Date;
  createdAt: Date;
}

export interface ArmPreviewOptions {
  draftFlags: Record<string, unknown>;
  draftConfig?: unknown;
  simulatedMarket?: string | null;
  productHandle?: string | null;
}

export interface PreviewSyncResult {
  ok: boolean;
  errors: string[];
  /** v15: the config mirrors landed (armed/disarmed as requested) but the
   *  separate rewards-metafield write failed — the Preview Center MUST show
   *  these in its banner (never silently). */
  warnings: string[];
}

const FEATURE_KEY_SET = new Set<string>(FEATURE_KEYS);

/** Same patterns the settings sanitizer / cart-data proxy use. */
const MARKET_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function sanitizeProductHandle(handle: unknown): string {
  if (typeof handle !== "string") return "";
  return handle.toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 255);
}

export function sanitizeMarketHandle(handle: unknown): string {
  if (typeof handle !== "string") return "";
  const cleaned = handle.toLowerCase().trim();
  return MARKET_HANDLE_PATTERN.test(cleaned) ? cleaned : "";
}

function newRawToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * sha256 hex digest of a raw preview token — the ONLY form of the token that
 * may reach buyer-visible surfaces (the `_cx_preview` cart attribute and the
 * shop metafield's `preview.tokenHash`). Checkout extensions compare the
 * cart attribute against `preview.tokenHash` with plain string equality;
 * hashing happens exclusively server-side (node:crypto) because SubtleCrypto
 * is not reliably available in extension runtimes.
 */
export function tokenHashFor(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Keeps only known FeatureKeys with strictly-boolean values. */
export function sanitizeDraftFlags(
  raw: unknown,
): Partial<Record<FeatureKey, boolean>> {
  const out: Partial<Record<FeatureKey, boolean>> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return out;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (FEATURE_KEY_SET.has(key) && typeof value === "boolean") {
      out[key as FeatureKey] = value;
    }
  }
  return out;
}

/**
 * Keeps only the known draftConfig keys with valid enum values — anything
 * else (unknown keys, wrong types, out-of-enum strings) is dropped.
 */
export function sanitizeDraftConfig(raw: unknown): PreviewDraftConfig {
  const out: PreviewDraftConfig = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return out;
  }
  const deliveryFormat = (raw as Record<string, unknown>).deliveryFormat;
  if (
    typeof deliveryFormat === "string" &&
    (DELIVERY_ESTIMATE_FORMATS as readonly string[]).includes(deliveryFormat)
  ) {
    out.deliveryFormat = deliveryFormat as DeliveryEstimateFormat;
  }
  const deliveryFormatCart = (raw as Record<string, unknown>)
    .deliveryFormatCart;
  if (
    typeof deliveryFormatCart === "string" &&
    (DELIVERY_ESTIMATE_FORMATS as readonly string[]).includes(
      deliveryFormatCart,
    )
  ) {
    out.deliveryFormatCart = deliveryFormatCart as DeliveryEstimateFormat;
  }
  const deliveryFormatCheckout = (raw as Record<string, unknown>)
    .deliveryFormatCheckout;
  if (
    typeof deliveryFormatCheckout === "string" &&
    (DELIVERY_ESTIMATE_FORMATS as readonly string[]).includes(
      deliveryFormatCheckout,
    )
  ) {
    out.deliveryFormatCheckout =
      deliveryFormatCheckout as DeliveryEstimateFormat;
  }
  const shipsFromFormat = (raw as Record<string, unknown>).shipsFromFormat;
  if (
    typeof shipsFromFormat === "string" &&
    (SHIPS_FROM_FORMATS as readonly string[]).includes(shipsFromFormat)
  ) {
    out.shipsFromFormat = shipsFromFormat as ShipsFromFormat;
  }
  // v14 (SPEC §10) — keep BYTE-EQUIVALENT in behaviour with the twin inside
  // metafields.server's loadPreviewPayload (which cannot import this module).
  const simCart = (raw as Record<string, unknown>).simCart;
  if (typeof simCart === "object" && simCart !== null && !Array.isArray(simCart)) {
    const spend = Number((simCart as Record<string, unknown>).spendCents);
    const count = Number((simCart as Record<string, unknown>).count);
    if (Number.isFinite(spend) && Number.isFinite(count)) {
      out.simCart = {
        spendCents: Math.min(SIM_CART_MAX_SPEND_CENTS, Math.max(0, Math.floor(spend))),
        count: Math.min(SIM_CART_MAX_COUNT, Math.max(0, Math.floor(count))),
      };
    }
  }
  if ((raw as Record<string, unknown>).rehearsal === true) {
    out.rehearsal = true;
  }
  const rewards = (raw as Record<string, unknown>).rewards;
  if (typeof rewards === "object" && rewards !== null && !Array.isArray(rewards)) {
    const rw = rewards as Record<string, unknown>;
    const draft: NonNullable<PreviewDraftConfig["rewards"]> = {};
    if (Array.isArray(rw.setSavingsTiers)) {
      draft.setSavingsTiers = sanitizeSetSavingsTiers(rw.setSavingsTiers);
    }
    if (Array.isArray(rw.giftTiers)) {
      draft.giftTiers = sanitizeGiftTiers(rw.giftTiers);
    }
    if (
      typeof rw.giftAmountsByMarket === "object" &&
      rw.giftAmountsByMarket !== null &&
      !Array.isArray(rw.giftAmountsByMarket)
    ) {
      draft.giftAmountsByMarket = sanitizeGiftThresholdsByMarket(rw.giftAmountsByMarket);
    }
    if (Object.keys(draft).length > 0) out.rewards = draft;
  }
  return out;
}

type PreviewStateRow = {
  shop: string;
  token: string;
  armed: boolean;
  armedAt: Date | null;
  draftFlags: string;
  draftConfig: string;
  simulatedMarket: string | null;
  productHandle: string | null;
  updatedAt: Date;
  createdAt: Date;
};

function toSnapshot(row: PreviewStateRow): PreviewSnapshot {
  let draftFlags: Partial<Record<FeatureKey, boolean>> = {};
  try {
    draftFlags = sanitizeDraftFlags(JSON.parse(row.draftFlags));
  } catch {
    draftFlags = {};
  }
  let draftConfig: PreviewDraftConfig = {};
  try {
    draftConfig = sanitizeDraftConfig(JSON.parse(row.draftConfig));
  } catch {
    draftConfig = {};
  }
  return {
    shop: row.shop,
    token: row.token,
    armed: row.armed,
    armedAt: row.armedAt,
    draftFlags,
    draftConfig,
    simulatedMarket: row.simulatedMarket,
    productHandle: row.productHandle,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

/** Returns the shop's preview state, or null when none exists yet. */
export async function getPreviewState(
  shop: string,
): Promise<PreviewSnapshot | null> {
  const row = await prisma.previewState.findUnique({ where: { shop } });
  return row ? toSnapshot(row) : null;
}

/**
 * Returns the shop's preview state, creating a disarmed row with a fresh
 * token on first use. Safe under concurrent calls (unique shop constraint —
 * the loser of a create race re-reads the winner's row).
 */
export async function ensurePreviewState(
  shop: string,
): Promise<PreviewSnapshot> {
  const existing = await prisma.previewState.findUnique({ where: { shop } });
  if (existing) return toSnapshot(existing);
  try {
    const created = await prisma.previewState.create({
      data: { shop, token: newRawToken() },
    });
    return toSnapshot(created);
  } catch (error) {
    // Unique-constraint race: another request created the row first.
    const row = await prisma.previewState.findUnique({ where: { shop } });
    if (row) return toSnapshot(row);
    throw error;
  }
}

function previewSyncPayload(state: PreviewSnapshot): PreviewSyncPayload {
  return {
    armed: state.armed,
    draftFlags: state.armed ? { ...state.draftFlags } : {},
    draftConfig: state.armed ? { ...state.draftConfig } : {},
    token: state.token,
  };
}

async function resyncMetafields(
  admin: AdminGraphqlClient,
  state: PreviewSnapshot,
): Promise<PreviewSyncResult> {
  try {
    const settings = await getSettings(state.shop);
    return await syncSettingsToMetafields(
      admin,
      settings,
      previewSyncPayload(state),
    );
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: [],
    };
  }
}

/**
 * Arms (or re-arms with updated drafts/context) the preview for a shop and
 * re-syncs both config metafields so the storefront + checkout sides see the
 * new preview payload immediately.
 */
export async function armPreview(
  shop: string,
  admin: AdminGraphqlClient,
  options: ArmPreviewOptions,
): Promise<{ state: PreviewSnapshot; sync: PreviewSyncResult }> {
  await ensurePreviewState(shop);
  const draftFlags = sanitizeDraftFlags(options.draftFlags);
  const draftConfig = sanitizeDraftConfig(options.draftConfig);
  const simulatedMarket = sanitizeMarketHandle(options.simulatedMarket) || null;
  const productHandle = sanitizeProductHandle(options.productHandle) || null;
  const row = await prisma.previewState.update({
    where: { shop },
    data: {
      armed: true,
      armedAt: new Date(),
      draftFlags: JSON.stringify(draftFlags),
      draftConfig: JSON.stringify(draftConfig),
      simulatedMarket,
      productHandle,
    },
  });
  const state = toSnapshot(row);
  const sync = await resyncMetafields(admin, state);
  return { state, sync };
}

/**
 * Disarms the preview (clears draft flags AND draft config — defense in
 * depth) and re-syncs so real visitors immediately return to the
 * byte-identical live rendering.
 */
export async function disarmPreview(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<{ state: PreviewSnapshot; sync: PreviewSyncResult }> {
  await ensurePreviewState(shop);
  const row = await prisma.previewState.update({
    where: { shop },
    data: { armed: false, draftFlags: "{}", draftConfig: "{}" },
  });
  const state = toSnapshot(row);
  // v15.1: the DB row is disarmed BEFORE the mirror write; if the write of
  // the config mirrors fails (throttle / transport / userError) the
  // storefront is still armed while the admin says "off" — retry ONCE before
  // reporting, and the caller MUST surface sync.ok (never "shoppers are safe"
  // on a failed mirror write).
  let sync = await resyncMetafields(admin, state);
  if (!sync.ok) {
    const retry = await resyncMetafields(admin, state);
    sync = retry.ok
      ? retry
      : { ...retry, errors: [...sync.errors, ...retry.errors.filter((e) => !sync.errors.includes(e))] };
  }
  return { state, sync };
}

/**
 * Rotates the preview token, invalidating every previously shared entry URL.
 * Returns the new RAW token (for immediate URL building). Re-syncs the
 * metafields only when armed — a disarmed preview never ships a token.
 */
export async function rotateToken(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<{ token: string; sync: PreviewSyncResult | null }> {
  await ensurePreviewState(shop);
  const row = await prisma.previewState.update({
    where: { shop },
    data: { token: newRawToken() },
  });
  const state = toSnapshot(row);
  const sync = state.armed ? await resyncMetafields(admin, state) : null;
  return { token: state.token, sync };
}

/**
 * Timing-safe check of a raw token from a proxy request against the stored
 * token. False on any absence, length mismatch, or comparison failure —
 * never throws.
 */
export async function verifyToken(
  shop: string,
  rawToken: unknown,
): Promise<boolean> {
  if (typeof rawToken !== "string" || rawToken.length === 0) return false;
  try {
    const row = await prisma.previewState.findUnique({ where: { shop } });
    if (!row || typeof row.token !== "string" || row.token.length === 0) {
      return false;
    }
    const expected = Buffer.from(row.token, "utf8");
    const provided = Buffer.from(rawToken, "utf8");
    if (expected.length !== provided.length) return false;
    return crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

/**
 * Builds the shareable preview entry URL (the ONLY page-facing place the raw
 * token is allowed to appear):
 *   https://<shop-domain>/apps/cellexia/preview?t=<raw>&product=<h>&market=<m>
 */
export function buildPreviewEntryUrl(
  shopDomain: string,
  rawToken: string,
  options: { productHandle?: string | null; market?: string | null } = {},
): string {
  const domain = shopDomain
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .trim();
  const params = new URLSearchParams();
  params.set("t", rawToken);
  const productHandle = sanitizeProductHandle(options.productHandle);
  if (productHandle) params.set("product", productHandle);
  const market = sanitizeMarketHandle(options.market);
  if (market) params.set("market", market);
  return `https://${domain}/apps/cellexia/preview?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// v14 rewards preview helpers (SPEC §10) — pure, shared by preview-config
// (storefront runtime) and the Preview Center (simulator chips)
// ---------------------------------------------------------------------------

export interface RewardsForMarket {
  /** Set-savings tiers the preview session uses (draft wins over live). */
  ssTiers: SetSavingsTier[];
  /**
   * Gift-tier amounts for the simulated market: the market's own record
   * (draft giftAmountsByMarket, else settings giftThresholdsByMarket) with
   * its currency, else the EUR defaults (draft giftTiers, else live). The
   * storefront applies its thresholdCents() rule: amounts in the presentment
   * currency are used as-is, EUR defaults are converted by the shop rate.
   */
  gtAmounts: { a: number[]; c: string };
  /** Every gift option variant + samplePool entry ({vid, handle, title}). */
  gifts: { vid: string; handle: string; title: string }[];
}

/**
 * Resolves the rewards config the preview session should show for one
 * market: live settings with the armed draftConfig overrides applied. Pure;
 * `draftConfig` should be `{}` whenever the preview is disarmed. Titles are
 * the product handles (no API call here — v15: the storefront fetches real
 * titles/prices from cart-data at runtime). Kept for backward compat; the
 * v15 storefront reads `rw` (rewardsPreviewSections) instead.
 */
export function rewardsForMarket(
  settings: BoosterSettings,
  draftConfig: PreviewDraftConfig,
  market: string,
): RewardsForMarket {
  const rw = settings.rewards;
  const draft = draftConfig.rewards ?? {};
  const ssTiers = (draft.setSavingsTiers ?? rw.setSavings.tiers).map((tier) => ({
    count: tier.count,
    pct: tier.pct,
    code: tier.code,
  }));
  const gtTiers = draft.giftTiers ?? rw.giftTiers.tiers;
  const record =
    (market && draft.giftAmountsByMarket?.[market]) ||
    (market && rw.giftTiers.giftThresholdsByMarket[market]) ||
    null;
  const gtAmounts =
    record && Array.isArray(record.amounts) && record.amounts.length >= gtTiers.length
      ? { a: gtTiers.map((_, i) => Number(record.amounts[i]) || 0), c: record.currencyCode }
      : { a: gtTiers.map((tier) => tier.amount), c: "EUR" };
  const gifts: RewardsForMarket["gifts"] = [];
  const seen = new Set<string>();
  const push = (variantId: string, handle: string) => {
    const vid = /(\d+)$/.exec(variantId ?? "")?.[1] ?? "";
    const key = vid || handle;
    if (!key || seen.has(key)) return;
    seen.add(key);
    gifts.push({ vid, handle, title: handle });
  };
  for (const tier of gtTiers) {
    for (const slot of tier.slots) {
      for (const option of slot) {
        if (option.kind === "variant") push(option.variantId, option.handle);
      }
    }
  }
  for (const entry of rw.giftTiers.samplePool) push(entry.variantId, entry.handle);
  return { ssTiers, gtAmounts, gifts };
}

/**
 * v15 preview-config "rw" field (SPEC v15 §7): the RAW `rewards.setSavings`
 * / `rewards.giftTiers` settings sections — the same shape the live
 * `#cx-rw-config` island carries (`{"ss": setSavings, "gt": giftTiers,
 * "paused": [...]}`) — with the armed draft tiers / amounts merged in, plus
 * the paused gift variants of the simulated market. This is the ONLY way
 * draft rewards data reaches a storefront: through the token-verified
 * preview-config endpoint, never through Liquid (the v15 incident). Pure.
 */
export interface RewardsPreviewSections {
  ss: BoosterSettings["rewards"]["setSavings"];
  gt: BoosterSettings["rewards"]["giftTiers"];
  /** paused gift variant ids (numeric) for `market`, [] when none */
  paused: string[];
  market: string;
}

export function rewardsPreviewSections(
  settings: BoosterSettings,
  draftConfig: PreviewDraftConfig,
  market: string,
  pausedByMarket: Record<string, string[]> = {},
): RewardsPreviewSections {
  const rw = settings.rewards;
  const draft = draftConfig.rewards ?? {};
  const ss: RewardsPreviewSections["ss"] = {
    ...rw.setSavings,
    tiers: (draft.setSavingsTiers ?? rw.setSavings.tiers).map((tier) => ({
      count: tier.count,
      pct: tier.pct,
      code: tier.code,
    })),
    surfaces: { ...rw.setSavings.surfaces },
    setSavingsExcludedByMarket: { ...rw.setSavings.setSavingsExcludedByMarket },
    yieldToCodes: [...rw.setSavings.yieldToCodes],
  };
  const gt: RewardsPreviewSections["gt"] = {
    ...rw.giftTiers,
    tiers: JSON.parse(JSON.stringify(draft.giftTiers ?? rw.giftTiers.tiers)),
    giftThresholdsByMarket: {
      ...rw.giftTiers.giftThresholdsByMarket,
      ...(draft.giftAmountsByMarket ?? {}),
    },
    samplePool: rw.giftTiers.samplePool.map((e) => ({ ...e })),
    warehouseByMarket: { ...rw.giftTiers.warehouseByMarket },
    stockFloor: { ...rw.giftTiers.stockFloor },
  };
  const paused = market && Array.isArray(pausedByMarket[market]) ? [...pausedByMarket[market]] : [];
  return { ss, gt, paused, market };
}

export interface SimCartChip {
  label: string;
  /** Spend to set (cents, presentment currency) — undefined = keep. */
  spendCents?: number;
  /** Product count to set — undefined = keep. */
  count?: number;
}

/**
 * Quick simulator presets for one market, computed from live + draft config:
 * "Just below tier 1", "At tier N" (one per gift tier), "At free shipping"
 * (the market's explicit free-shipping threshold when its currency matches
 * the gift amounts' currency, else the shop-currency fallback only when the
 * amounts are in the shop currency), and one "N products" chip per
 * set-savings tier. All amounts are in `currency` (= gtAmounts.c).
 */
export function simCartChips(
  settings: BoosterSettings,
  draftConfig: PreviewDraftConfig,
  market: string,
): { currency: string; chips: SimCartChip[] } {
  const { ssTiers, gtAmounts } = rewardsForMarket(settings, draftConfig, market);
  const currency = gtAmounts.c;
  const chips: SimCartChip[] = [];
  const amounts = gtAmounts.a.filter((amount) => Number.isFinite(amount) && amount > 0);
  if (amounts.length > 0) {
    chips.push({
      label: "Just below tier 1",
      spendCents: Math.max(0, Math.round(amounts[0] * 100) - 100),
      count: 1,
    });
    amounts.forEach((amount, index) => {
      chips.push({
        label: `At tier ${index + 1}`,
        spendCents: Math.round(amount * 100),
        count: Math.max(1, index + 1),
      });
    });
  }
  const fs = market ? settings.freeShipping.byMarket[market] : undefined;
  let freeShip: number | null = null;
  if (fs && fs.currencyCode === currency && fs.amount > 0) {
    freeShip = fs.amount;
  } else if (!fs && currency === "EUR" && settings.global.freeShippingThreshold > 0) {
    freeShip = settings.global.freeShippingThreshold;
  }
  if (freeShip !== null) {
    chips.push({
      label: "At free shipping",
      spendCents: Math.round(freeShip * 100),
    });
  }
  for (const tier of ssTiers) {
    chips.push({ label: `${tier.count} products (${tier.code})`, count: tier.count });
  }
  return { currency, chips };
}

// ---------------------------------------------------------------------------
// Feature readiness (consumed by the Preview Center feature picker)
// ---------------------------------------------------------------------------

export interface FeatureReadiness {
  ready: boolean;
  /** Warning (when not ready) or informational note (when ready). */
  reason?: string;
}

/**
 * Feature keys the live preview can actually demonstrate. `clinical_results`
 * is placed as a theme-editor block (not injected by the app embeds), so the
 * app's live preview cannot show it — the Preview Center uses this set to
 * keep it out of the draft-toggle flow.
 */
export const PREVIEWABLE_FEATURE_KEYS: ReadonlySet<FeatureKey> = new Set(
  FEATURE_KEYS.filter((key) => key !== "clinical_results"),
);

export interface FeatureReadinessExtras {
  /** Counts of products carrying PDP booster content, when known. */
  productsWithContent?: {
    clinical: number;
    ba: number;
    batch: number;
    survey: number;
  };
  /**
   * v8 proof-library entry counts (approved rows only), when known. These
   * feed the press band, the dermatologist-endorsement wall and the results
   * gallery — content lives in the proof-library database, not per-product
   * metaobjects, so their readiness points at /app/proof.
   */
  proofCounts?: {
    press: number;
    endorsements: number;
    results: number;
  };
}

/** Short weekday name (Intl 'en-US') -> ISO weekday number, matching the
 *  DISPATCH_ISO map in the storefront engines (cellexia-cart.js /
 *  cellexia-pdp.js). */
const DISPATCH_ISO_DAYS: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * Readiness for the dispatch countdown. The storefront credibility engine
 * hides the widget outside its window (not a dispatch day / cutoff passed /
 * too early), so the readiness note tells the merchant EXACTLY what the
 * preview will show right now: the real countdown (window open), or a
 * labeled sample plus an explanation (window closed). It never claims the
 * widget is shown to real visitors when it is not.
 *
 * The window state is computed with the SAME warehouse-timezone
 * minutes-of-day math the storefront uses (Intl.DateTimeFormat
 * formatToParts); any throw degrades to ready with a generic note.
 */
function dispatchReadiness(
  dispatch: BoosterSettings["dispatch"],
): FeatureReadiness {
  if (!dispatch.showInCart && !dispatch.showOnPdp) {
    return {
      ready: false,
      reason:
        "Both surfaces are turned off in Features → Dispatch countdown — enable “Show in cart” and/or “Show on product page” or the widget renders nowhere.",
    };
  }
  const byCountryNote =
    Object.keys(dispatch.byCountry ?? {}).length > 0
      ? " Some countries use custom schedules — the preview follows the schedule for the simulated market's country when one applies."
      : "";
  const cutoff = dispatch.cutoff;
  const windowHours = dispatch.showWithinHours;
  try {
    // Same math as dispatchRemainingMs in the storefront engines.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: dispatch.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const map: Record<string, string> = {};
    for (const part of parts) map[part.type] = part.value;
    const iso = DISPATCH_ISO_DAYS[map.weekday ?? ""];
    const nowMinutes = (Number(map.hour) % 24) * 60 + Number(map.minute);
    const cutoffMinutes =
      Number(cutoff.slice(0, 2)) * 60 + Number(cutoff.slice(3, 5));
    if (
      !iso ||
      !Number.isFinite(nowMinutes) ||
      !Number.isFinite(cutoffMinutes)
    ) {
      throw new Error("dispatch schedule could not be evaluated");
    }
    let why: string | null = null;
    if (!dispatch.days.includes(iso)) {
      why = "today isn't a dispatch day in the warehouse timezone";
    } else if (nowMinutes >= cutoffMinutes) {
      why = `today's ${cutoff} cutoff (warehouse time) has passed`;
    } else if (cutoffMinutes - nowMinutes > windowHours * 60) {
      why = `more than ${windowHours} h remain before today's ${cutoff} cutoff`;
    }
    if (why === null) {
      return {
        ready: true,
        reason:
          "Live window is open right now — the preview shows the real countdown." +
          byCountryNote,
      };
    }
    return {
      ready: true,
      reason:
        `Outside the display window right now (${why}) — the preview shows a labeled sample plus an explanation; real visitors see it on dispatch days during the final ${windowHours} h before the ${cutoff} cutoff (warehouse time).` +
        byCountryNote,
    };
  } catch {
    return {
      ready: true,
      reason:
        `The warehouse timezone ("${dispatch.timezone}") could not be evaluated on this server — the preview still works: it shows the real countdown when the display window is open, otherwise a labeled sample plus an explanation.` +
        byCountryNote,
    };
  }
}

/**
 * Readiness for the delivery estimator (v5.9, three surfaces since v6.0).
 * Not ready only when all three surfaces (product page, cart drawer,
 * checkout) are turned off — the widget then renders nowhere, dispatch
 * precedent. Otherwise ready: the reason lists which surfaces are on and
 * describes the CURRENT computed state — which countries are hidden by
 * override, and whether the dispatch schedule (the anchor of every delivery
 * date) can be resolved at all.
 */
function deliveryReadiness(settings: BoosterSettings): FeatureReadiness {
  const de = settings.deliveryEstimate;
  const surfacesOn = [
    de.showOnPdp ? "product page" : null,
    de.showInCart ? "cart drawer" : null,
    de.showInCheckout ? "checkout" : null,
  ].filter((surface): surface is string => surface !== null);
  if (surfacesOn.length === 0) {
    return {
      ready: false,
      reason:
        "All three surfaces are turned off in Features → Delivery guarantee — enable “Show on product pages”, “Show in the cart drawer” and/or “Show in checkout” or the widget renders nowhere.",
    };
  }
  const surfaceNote = `Shows on: ${surfacesOn.join(", ")}${
    de.showInCheckout
      ? " (the checkout block must also be placed once in the checkout editor)"
      : ""
  }. `;
  const hiddenCountries = Object.entries(
    settings.deliveryEstimate.byCountry ?? {},
  )
    .filter(([, entry]) => entry?.hidden === true)
    .map(([code]) => code)
    .sort();
  const hiddenNote =
    hiddenCountries.length > 0
      ? `Hidden by country override for ${hiddenCountries.join(", ")} — buyers there never see the widget; everyone else gets real dates.`
      : "Estimates render for every country (any without a fixed-date holiday table just skip the global Dec 24/25/31 + Jan 1 exclusions).";
  // v10 US state module — static wording only (featureReadiness stays sync,
  // never reads the database); the live geo-database status lives on the
  // Delivery page itself.
  const usStates = settings.deliveryEstimate.usStates;
  const usStatesNote = usStates.enabled
    ? ` US state module on — ${Object.keys(usStates.byState ?? {}).length} state overrides; product-page detection needs the IP database (build it on the Delivery page).`
    : "";
  // The dispatch schedule anchors every delivery date; if its warehouse
  // timezone cannot be evaluated the storefront fails closed to hidden.
  let scheduleWarning = "";
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: settings.dispatch.timezone,
    }).format(new Date());
  } catch {
    scheduleWarning = ` Warning: the warehouse timezone ("${settings.dispatch.timezone}") on the Dispatch countdown page cannot be resolved — the delivery widget fails closed (renders nothing) until it is fixed.`;
  }
  return {
    ready: true,
    reason: surfaceNote + hiddenNote + usStatesNote + scheduleWarning,
  };
}

function contentReadiness(
  count: number | undefined,
  contentLabel: string,
): FeatureReadiness {
  if (count === undefined) {
    return {
      ready: true,
      reason: `Shows only on products with ${contentLabel} content — add it under Product boosters.`,
    };
  }
  if (count <= 0) {
    return {
      ready: false,
      reason: `No products have ${contentLabel} content yet — add it under Product boosters.`,
    };
  }
  return {
    ready: true,
    reason: `${count} product${count === 1 ? " has" : "s have"} ${contentLabel} content.`,
  };
}

/**
 * v8 proof-library twin of contentReadiness — same honest three-state
 * wording, but the entry content for these features lives in the
 * proof-library database (not per-product metaobjects), so the fix-it
 * pointer is "under Proof library" (/app/proof), never Product boosters.
 */
function proofReadiness(
  count: number | undefined,
  singularLabel: string,
  pluralLabel: string,
): FeatureReadiness {
  // v8.7: all three widgets ride ONE app embed — the store's legacy Liquid
  // templates cannot take section app blocks (merchant-verified; the v8
  // section blocks are retired), so the "Cellexia proof library" embed
  // self-inserts them on product pages and the home page. With content
  // added and the feature armed, the storefront still shows NOTHING until
  // the embed is enabled once — the reason string is where the merchant
  // looks when that happens.
  const placement = `Renders through the “Cellexia proof library” app embed — enable it once in the theme editor's App embeds panel; the widgets place themselves on product pages and the home page. Without the embed, nothing shows, even in preview.`;
  if (count === undefined) {
    return {
      ready: true,
      reason: `Shows the approved ${pluralLabel} from your Proof library — manage them under Proof library. ${placement}`,
    };
  }
  if (count <= 0) {
    return {
      ready: false,
      reason: `No ${pluralLabel} yet — add them under Proof library. ${placement}`,
    };
  }
  return {
    ready: true,
    reason: `${count} approved ${count === 1 ? singularLabel : pluralLabel}. ${placement}`,
  };
}

/**
 * Per-feature preview readiness. "Not ready" never blocks draft-toggling —
 * the Preview Center shows the reason as a warning so the merchant knows why
 * a widget would render empty (or not at all) in the preview.
 */
/**
 * v12: one-line disclosure of a per-market product-exclusion record
 * ("" when empty). Excluded products render nothing — live AND preview
 * (the byCountry-hidden precedent) — so the Preview Center must say so
 * instead of leaving a merchant staring at a blank widget.
 */
function exclusionNote(
  record: Record<string, string[]>,
  what: string,
): string {
  const entries = Object.entries(record ?? {}).filter(
    ([, ids]) => Array.isArray(ids) && ids.length > 0,
  );
  if (entries.length === 0) return "";
  const parts = entries
    .map(([handle, ids]) => `${handle}: ${ids.length}`)
    .join(", ");
  return ` Note: excluded products never show ${what} (per-market counts — ${parts}); this applies in the preview too, though exclusions always follow the market you are actually browsing — the Preview Center's market simulation does not re-evaluate them, so verify an exclusion on that market's real storefront URL. Edit the list on the feature page's Excluded products card.`;
}

/** Appends the v12 exclusion disclosure to a readiness entry when active. */
function withExclusionNote(
  entry: FeatureReadiness,
  record: Record<string, string[]>,
  what: string,
): FeatureReadiness {
  const note = exclusionNote(record, what);
  if (!note) return entry;
  return {
    ready: entry.ready,
    reason: entry.reason ? entry.reason + note : note.trimStart(),
  };
}

export function featureReadiness(
  settings: BoosterSettings,
  extras: FeatureReadinessExtras = {},
): Record<FeatureKey, FeatureReadiness> {
  const counts = extras.productsWithContent;
  const readiness = Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, { ready: true } as FeatureReadiness]),
  ) as Record<FeatureKey, FeatureReadiness>;

  // Auto mode is always demonstrable — Shopify's recommendation engine picks
  // the offers from the cart/checkout contents, no hand-picked items needed.
  if (settings.checkoutUpsell.mode === "auto") {
    readiness.checkout_upsell = {
      ready: true,
      reason:
        "Automatic recommendations — offers are picked from the checkout contents by Shopify's recommendation engine.",
    };
  } else if (settings.checkoutUpsell.variantIds.length === 0) {
    readiness.checkout_upsell = {
      ready: false,
      reason:
        "Hand-picked mode with no upsell variants selected — pick at least one product on the Checkout features page, or switch to automatic recommendations.",
    };
  }
  if (settings.cartCrossSell.mode === "auto") {
    readiness.cart_cross_sell = {
      ready: true,
      reason:
        "Automatic recommendations — products are picked from the cart contents by Shopify's recommendation engine.",
    };
  } else if (settings.cartCrossSell.items.length === 0) {
    readiness.cart_cross_sell = {
      ready: false,
      reason:
        "Hand-picked mode with no cross-sell products selected — pick at least one on the Cart features page, or switch to automatic recommendations.",
    };
  }
  if (!settings.checkoutProtection.variantId) {
    readiness.checkout_protection = {
      ready: false,
      reason:
        "No Order Protection product configured — create or select its variant on the Checkout features page.",
    };
  }
  readiness.clinical_results = {
    ready: true,
    reason:
      "Placed as a theme-editor block — not shown in the app's live preview. Use the theme editor preview for placement; market toggles still apply.",
  };
  readiness.dispatch_countdown = withExclusionNote(
    dispatchReadiness(settings.dispatch),
    settings.dispatch.excludedByMarket,
    "the countdown (product page + cart)",
  );
  readiness.delivery_estimate = withExclusionNote(
    deliveryReadiness(settings),
    settings.deliveryEstimate.excludedByMarket,
    "the delivery promise (product page, cart and checkout)",
  );

  // --- v9 checkout-trust V2 rows ------------------------------------------
  // Both render inside the checkout-trust module block (placed once in the
  // checkout editor); a preview draft grant on a row implies the module
  // chrome, so they stay previewable even while the module master is off.
  readiness.checkout_customs = withExclusionNote(
    {
      ready: true,
      reason:
        "Renders as a row inside the Checkout trust module block — the trust module block must be placed once in the checkout editor. Enable it only for markets where you genuinely cover customs and import fees.",
    },
    settings.checkoutTrust.customsExcludedByMarket,
    "this row while one of them is in the cart",
  );
  {
    // The tracked row shares the delivery guarantee's date engine, so its
    // honesty mirrors deliveryReadiness: an unresolvable warehouse timezone
    // fails the row closed.
    let scheduleWarning = "";
    try {
      new Intl.DateTimeFormat("en-US", {
        timeZone: settings.dispatch.timezone,
      }).format(new Date());
    } catch {
      scheduleWarning = ` Warning: the warehouse timezone ("${settings.dispatch.timezone}") on the Dispatch countdown page cannot be resolved — the tracked-delivery row fails closed (renders nothing) until it is fixed.`;
    }
    readiness.checkout_tracked = withExclusionNote(
      {
        ready: true,
        reason:
          "Renders inside the Checkout trust module block with the Delivery guarantee's guaranteed-by date (same schedule, country overrides and holidays), in the buyer's language. The row appears only after the buyer enters a shipping address whose country a date can be computed for. It stands alone: it keeps rendering even while the Delivery guarantee feature is off — turn this row off to stop the promise." +
          scheduleWarning,
      },
      settings.checkoutTrust.trackedExcludedByMarket,
      "this row while one of them is in the cart",
    );
  }

  // --- Amazon-pattern features (v6.1) --------------------------------------
  // The eight PDP az_* widgets ship in the separate "Cellexia Amazon
  // patterns" app embed, which must be enabled ONCE in the theme editor. The
  // app cannot currently detect embed state server-side, so the reminder is
  // static and honest about that.
  const embedNote =
    " Requires the “Cellexia Amazon patterns” app embed to be enabled once in the theme editor (Theme editor → App embeds) — the app cannot detect that automatically, so if nothing renders, check the embed first.";
  readiness.az_buy_box = {
    ready: true,
    reason:
      "Assembles a bordered decision card around the theme's existing buy area. If a product template lacks the expected theme anchors the card gracefully no-ops (nothing renders)." +
      embedNote,
  };
  readiness.az_microcopy = withExclusionNote(
    {
      ready: true,
      reason:
        "Replaces the app-injected PDP trust-badges strip while on. A trust-badges block placed manually in the theme editor cannot be auto-removed — remove that block by hand if you placed one." +
        embedNote,
    },
    // v12: the strip's "Ships from" ROW follows the ships-from exclusions
    // even while az_ships_from itself is off — a microcopy-only merchant
    // must not have to open the az_ships_from entry to learn that.
    settings.amazon.shipsFromExcludedByMarket,
    "the strip's Ships-from row (including the fallback label)",
  );
  readiness.az_delivery_line = {
    ready: true,
    reason:
      "Replaces the standard delivery widget AND the PDP dispatch countdown line while on. Uses the same dispatch schedule and per-country delivery config as those features and stands alone: the Amazon embed ships that config itself, so this line renders even when the delivery estimate or dispatch countdown is switched off, hidden on product pages, or scoped to other markets. It still fails closed when the delivery settings are incomplete or the buyer's country is hidden for the delivery estimate. The free-shipping threshold clause follows the per-market thresholds." +
      // v12: the line bundles both promises, so EITHER exclusion hides it.
      (Object.values(settings.deliveryEstimate.excludedByMarket).some(
        (ids) => ids.length > 0,
      ) ||
      Object.values(settings.dispatch.excludedByMarket).some(
        (ids) => ids.length > 0,
      )
        ? " Note: products excluded from the delivery promise OR the dispatch countdown (Excluded products cards) never show this line on their product page — in the preview too."
        : "") +
      embedNote,
  };
  readiness.az_stock_line = {
    ready: true,
    reason:
      "Replaces the theme's stock line while on. Honest by construction: “In Stock” renders only when the theme's real inventory data says available; low-stock states pass through untouched. The “Ships from {country}” row is its own feature (v6.8 split) with its own toggle and market targeting." +
      embedNote,
  };
  {
    // v6.8: az_ships_from fails closed without a resolvable warehouse —
    // no mapping AND no default warehouse means the line can never
    // render, so the preview would show nothing (not-ready, honest).
    const mapped = Object.keys(settings.amazon.shipsFromByCountry ?? {}).length;
    readiness.az_ships_from =
      mapped === 0 && !settings.amazon.defaultWarehouse
        ? {
            ready: false,
            reason:
              "No warehouse mapping and no default warehouse configured — the “Ships from” line renders nothing (fail closed). Add at least one country mapping or a default warehouse on the Amazon patterns page.",
          }
        : withExclusionNote(
            {
              ready: true,
              reason:
                `Replaces the theme's stock line while on (next to the “In Stock” line when that feature is also on). ${
                  settings.amazon.defaultWarehouse
                    ? `Uses ${mapped} country mapping${mapped === 1 ? "" : "s"} with a default warehouse fallback.`
                    : `Renders only for the ${mapped} mapped buyer countr${mapped === 1 ? "y" : "ies"} (no default warehouse set).`
                } Renders in the saved display style — currently “${settings.amazon.shipsFromFormat}” (subtle = quiet gray microline, prominent = green local-shipping signal with the country in bold); the Preview Center can try either style without changing the live site.` +
                embedNote,
            },
            settings.amazon.shipsFromExcludedByMarket,
            "ANY Ships-from line on their product page (this line and the microcopy row, including its fallback label)",
          );
  }
  readiness.az_bought_count = {
    ready: true,
    reason:
      "Renders only on products with a fresh merchant-set number — counts unset, zero or older than 45 days are hidden (honesty guard). Set numbers on the Amazon patterns page." +
      embedNote,
  };
  readiness.az_bestseller_badge = {
    ready: true,
    reason:
      "Never renders without a merchant-entered rank + category (per product, on the Amazon patterns page). The category renders exactly as entered." +
      embedNote,
  };
  readiness.az_fbt = {
    ready: true,
    reason:
      "Automatic complementary recommendations by default; per-product manual overrides on the Amazon patterns page. The cart cross-sell stays independent; a theme-native related-products section is a theme setting you can disable in the theme editor. Placement (below the info tabs by default, or under the buy box) is a LIVE setting on the Amazon patterns page — the preview renders at the saved placement." +
      embedNote,
  };
  readiness.az_similar_items = {
    ready: true,
    reason:
      "Automatic related-intent recommendations only — renders under “Frequently bought together” when both share a placement, or standalone. Placement (below the info tabs by default, or under the buy box) is a LIVE setting on the Amazon patterns page — the preview renders at the saved placement." +
      embedNote,
  };
  readiness.az_cart_free_line = {
    ready: true,
    reason:
      "Replaces the free-shipping bar's TEXT line while on — the progress bar itself stays below the sentence. Uses the existing per-market threshold and live cart total.",
  };
  readiness.az_cta_count = {
    ready: true,
    reason:
      "Relabels the theme's cart checkout button with a live, plural-correct item count; the theme's original label is restored the moment the feature is turned off or the preview ends.",
  };
  readiness.clinical_study = contentReadiness(counts?.clinical, "clinical study");
  readiness.derm_survey = contentReadiness(
    counts?.survey,
    "dermatologist survey",
  );
  // v8: the results gallery replaced the per-product BA widget — its
  // readiness is fed by proof-library CustomerResult counts, not the legacy
  // BA metaobject count (which now only matters for the one-time import).
  readiness.verified_before_after = proofReadiness(
    extras.proofCounts?.results,
    "customer result",
    "customer results",
    );
  readiness.batch_transparency = contentReadiness(
    counts?.batch,
    "batch transparency",
  );
  readiness.press = proofReadiness(
    extras.proofCounts?.press,
    "press item",
    "press items",
    );
  readiness.derm_endorsements = proofReadiness(
    extras.proofCounts?.endorsements,
    "dermatologist endorsement",
    "dermatologist endorsements",
    );

  // --- v14 rewards (SPEC §10) ---------------------------------------------
  // Both render in the cart drawer from the cart's contents; the preview
  // cart is never mutated (no gift lines, no SET code) unless "Test with
  // my real cart" is ticked, so the Preview Center's cart simulator is the
  // honest way to walk the tiers without touching a real cart. The tier
  // maths itself (the discount and the free gift line) needs the Discount
  // Function's discounts connected on the Rewards page.
  {
    const ss = settings.rewards.setSavings;
    const ssTiers = ss.tiers;
    if (ssTiers.length === 0) {
      readiness.set_savings = {
        ready: false,
        reason:
          "No set-savings tiers configured — add at least one tier (products → % → code) on the Rewards page, or the nudge, captions and discount code have nothing to show.",
      };
    } else {
      const surfaces = [
        ss.surfaces.cartNudge ? "cart nudge" : null,
        ss.surfaces.crossSellReframe ? "cross-sell reframe" : null,
        ss.surfaces.pdpLine ? "product-page line" : null,
        ss.surfaces.fbtCaption ? "FBT caption" : null,
        ss.surfaces.similarCaption ? "similar-items caption" : null,
      ].filter((surface): surface is string => surface !== null);
      readiness.set_savings = withExclusionNote(
        {
          ready: true,
          reason:
            `Shows: ${surfaces.length > 0 ? surfaces.join(", ") : "no surface (all five switches are off on the Rewards page)"} — ${ssTiers.length} tier${ssTiers.length === 1 ? "" : "s"} (${ssTiers.map((tier) => `${tier.count}→${tier.pct}% ${tier.code}`).join(", ")}). ` +
            "In the preview the discount code is NOT applied to your cart unless “Test with my real cart” is ticked — use the cart simulator below to walk the product counts; the real discount at checkout needs “Create discount codes” on the Rewards page (see Setup & health → Discount codes).",
        },
        ss.setSavingsExcludedByMarket,
        "the set-savings count or discount",
      );
    }
    const gt = settings.rewards.giftTiers;
    if (gt.tiers.length === 0) {
      readiness.gift_tiers = {
        ready: false,
        reason:
          "No gift tiers configured — add at least one tier (spend threshold + gift) on the Rewards page, or the meter has no milestones.",
      };
    } else {
      const missingVariants = gt.tiers.some((tier) =>
        tier.slots.some((slot) =>
          slot.some((option) => option.kind === "variant" && !option.variantId),
        ),
      );
      const marketsWithAmounts = Object.keys(gt.giftThresholdsByMarket).length;
      readiness.gift_tiers = {
        ready: !missingVariants,
        reason:
          `Shows the reward meter in the cart drawer with ${gt.tiers.length} gift tier${gt.tiers.length === 1 ? "" : "s"} (EUR ${gt.tiers.map((tier) => tier.amount).join(" / ")}${marketsWithAmounts > 0 ? `; ${marketsWithAmounts} market${marketsWithAmounts === 1 ? "" : "s"} with own amounts` : "; no per-market amounts yet — other currencies convert the EUR defaults"}). ` +
          (missingVariants
            ? "Some gift options have no product variant selected yet (press “Load defaults” or pick variants on the Rewards page) — those slots render nothing. "
            : "") +
          "In the preview the free gift is shown as a sample row and NOT added to your cart unless “Test with my real cart” is ticked — use the cart simulator below to walk the spend thresholds; the real free-gift discount at checkout needs “Create discount codes” on the Rewards page.",
      };
    }
  }
  return readiness;
}
