import crypto from "node:crypto";
import prisma from "../db.server";
import {
  DELIVERY_ESTIMATE_FORMATS,
  FEATURE_KEYS,
  SHIPS_FROM_FORMATS,
  getSettings,
  type BoosterSettings,
  type DeliveryEstimateFormat,
  type FeatureKey,
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
}

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
  const sync = await resyncMetafields(admin, state);
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
  return { ready: true, reason: surfaceNote + hiddenNote + scheduleWarning };
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
  if (count === undefined) {
    return {
      ready: true,
      reason: `Shows the approved ${pluralLabel} from your Proof library — manage them under Proof library.`,
    };
  }
  if (count <= 0) {
    return {
      ready: false,
      reason: `No ${pluralLabel} yet — add them under Proof library.`,
    };
  }
  return {
    ready: true,
    reason: `${count} approved ${count === 1 ? singularLabel : pluralLabel}.`,
  };
}

/**
 * Per-feature preview readiness. "Not ready" never blocks draft-toggling —
 * the Preview Center shows the reason as a warning so the merchant knows why
 * a widget would render empty (or not at all) in the preview.
 */
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
  readiness.dispatch_countdown = dispatchReadiness(settings.dispatch);
  readiness.delivery_estimate = deliveryReadiness(settings);

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
  readiness.az_microcopy = {
    ready: true,
    reason:
      "Replaces the app-injected PDP trust-badges strip while on. A trust-badges block placed manually in the theme editor cannot be auto-removed — remove that block by hand if you placed one." +
      embedNote,
  };
  readiness.az_delivery_line = {
    ready: true,
    reason:
      "Replaces the standard delivery widget AND the PDP dispatch countdown line while on. Uses the same dispatch schedule and per-country delivery config as those features and stands alone: the Amazon embed ships that config itself, so this line renders even when the delivery estimate or dispatch countdown is switched off, hidden on product pages, or scoped to other markets. It still fails closed when the delivery settings are incomplete or the buyer's country is hidden for the delivery estimate. The free-shipping threshold clause follows the per-market thresholds." +
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
        : {
            ready: true,
            reason:
              `Replaces the theme's stock line while on (next to the “In Stock” line when that feature is also on). ${
                settings.amazon.defaultWarehouse
                  ? `Uses ${mapped} country mapping${mapped === 1 ? "" : "s"} with a default warehouse fallback.`
                  : `Renders only for the ${mapped} mapped buyer countr${mapped === 1 ? "y" : "ies"} (no default warehouse set).`
              } Renders in the saved display style — currently “${settings.amazon.shipsFromFormat}” (subtle = quiet gray microline, prominent = green local-shipping signal with the country in bold); the Preview Center can try either style without changing the live site.` +
              embedNote,
          };
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
  return readiness;
}
