import crypto from "node:crypto";
import prisma from "../db.server";
import {
  DELIVERY_ESTIMATE_FORMATS,
  SHIPS_FROM_FORMATS,
  aliasCodesFor,
  sanitizeGiftThresholdsByMarket,
  sanitizeGiftTiers,
  sanitizeSetSavingsTiers,
  type BoosterSettings,
  type MarketScope,
} from "../models/settings.server";
import { marketCountryMap } from "./markets.server";

/**
 * Mirrors the settings blob to the two places extensions read it from:
 *
 *  - App-data metafield (owner: AppInstallation, namespace "cellexia",
 *    key "config"): the theme app extension reads it in Liquid via
 *    {{ app.metafields.cellexia.config.value }} — no scopes required.
 *
 *  - Shop metafield (owner: Shop, namespace "$app:cellexia", key "config"):
 *    the checkout UI extensions declare it in shopify.extension.toml and
 *    read it with useAppMetafields().
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

const OWNER_IDS_QUERY = `#graphql
  query cellexiaOwnerIds {
    currentAppInstallation {
      id
    }
    shop {
      id
      myshopifyDomain
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation cellexiaSetConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Preview payload split (SPEC v4): the app-data metafield feeds page-visible
 * Liquid and must NEVER carry the preview token (raw or hashed); the shop
 * metafield is only reachable by our checkout extensions and carries the
 * sha256 HASH of the token (`tokenHash`) so checkout can validate the
 * `_cx_preview` cart attribute (extensions compare sha256(attribute) ===
 * tokenHash) — the raw token never ships to a buyer's checkout session.
 */
export interface PreviewSyncPayload {
  armed: boolean;
  draftFlags: Record<string, boolean>;
  /**
   * Draft, preview-session-only config overrides (v5.8) — the three
   * per-surface delivery-estimate formats (`deliveryFormat` /
   * `deliveryFormatCart` / `deliveryFormatCheckout`, v6.0) plus the
   * az_ships_from style (v6.10); the derm-survey format override retired
   * in v7. Tokenless by construction (closed-enum values only), so it is
   * safe for the page-visible app-data metafield AND the checkout shop
   * metafield while the preview is armed.
   */
  draftConfig: Record<string, unknown>;
  /**
   * RAW preview token (input only) — hashed at write time; only its sha256
   * hex digest is ever written, and only to the shop metafield.
   */
  token: string;
}

// ---------------------------------------------------------------------------
// v14 rewards metafield (SPEC v14 §2.2) — the Discount Function's ONLY config
// ---------------------------------------------------------------------------

/** "gid://shopify/Product/123" -> "123" (numeric ids pass through; "" stays ""). */
function numeric(gid: string): string {
  const match = /(\d+)(?:\?.*)?$/.exec(String(gid ?? "").trim());
  return match ? match[1] : "";
}

/** Extra inputs the projection needs that do not live in settings. */
export interface RewardsMetafieldContext {
  /** numeric variantId -> ladder units (> 1) — RewardsState.nodes.units */
  units?: Record<string, number>;
  /** numeric variantId -> numeric productId — RewardsState.nodes.vp */
  vp?: Record<string, string>;
  /** country ISO2 -> market handle — marketCountryMap().byCountry */
  cm?: Record<string, string>;
}

export interface RewardsMetafieldLive {
  ss: {
    on: boolean;
    tiers: { n: number; p: number; c: string }[];
    sub: boolean;
    scope: MarketScope;
    excl: Record<string, string[]>;
    msg: string;
    /** v14.3 alias codes (LEGACY_KIT_CODES minus the ladder when
     *  keepLegacyCodes): typed by a shopper they grant the qualifying tier. */
    alias: string[];
  };
  gt: {
    on: boolean;
    cum: boolean;
    max: number;
    tiers: {
      eur: number;
      slots: ({ k: "v"; vid: string } | { k: "s"; n: number })[][];
    }[];
    bm: Record<string, { a: number[]; c: string }>;
    pool: string[];
    scope: MarketScope;
  };
  fs: {
    on: boolean;
    min: number;
    th: boolean;
    bm: Record<string, { a: number; c: string }>;
    scope: MarketScope;
  };
  units: Record<string, number>;
  prot: string;
  giftPids: string[];
  cm: Record<string, string>;
}

export interface RewardsMetafield {
  v: 1;
  ph: string;
  live: RewardsMetafieldLive;
  draft: RewardsMetafieldLive | null;
}

function scopeOf(scope: MarketScope | undefined): MarketScope {
  return scope && scope.mode === "selected"
    ? { mode: "selected", markets: [...scope.markets] }
    : { mode: "all", markets: [] };
}

function projectRewards(
  settings: BoosterSettings,
  ctx: RewardsMetafieldContext,
  overrides: {
    ssOn?: boolean;
    gtOn?: boolean;
    ssTiers?: BoosterSettings["rewards"]["setSavings"]["tiers"];
    gtTiers?: BoosterSettings["rewards"]["giftTiers"]["tiers"];
    gtBm?: BoosterSettings["rewards"]["giftTiers"]["giftThresholdsByMarket"];
  } = {},
): RewardsMetafieldLive {
  const rw = settings.rewards;
  const ssTiers = overrides.ssTiers ?? rw.setSavings.tiers;
  const gtTiers = overrides.gtTiers ?? rw.giftTiers.tiers;
  const gtBm = overrides.gtBm ?? rw.giftTiers.giftThresholdsByMarket;
  const vp = ctx.vp ?? {};
  const excl: Record<string, string[]> = {};
  for (const [market, gids] of Object.entries(
    rw.setSavings.setSavingsExcludedByMarket,
  )) {
    const ids = gids.map(numeric).filter(Boolean);
    if (ids.length) excl[market] = ids;
  }
  const bm: Record<string, { a: number[]; c: string }> = {};
  for (const [market, entry] of Object.entries(gtBm)) {
    bm[market] = { a: [...entry.amounts], c: entry.currencyCode };
  }
  const fsBm: Record<string, { a: number; c: string }> = {};
  for (const [market, entry] of Object.entries(settings.freeShipping.byMarket)) {
    fsBm[market] = { a: entry.amount, c: entry.currencyCode };
  }
  const giftPids = new Set<string>();
  const giftVids = new Set<string>();
  for (const tier of gtTiers) {
    for (const slot of tier.slots) {
      for (const option of slot) {
        if (option.kind === "variant" && option.variantId) {
          giftVids.add(numeric(option.variantId));
        }
      }
    }
  }
  const pool = rw.giftTiers.samplePool.map((e) => numeric(e.variantId)).filter(Boolean);
  for (const vid of pool) giftVids.add(vid);
  for (const vid of giftVids) {
    const pid = vp[vid];
    if (pid) giftPids.add(pid);
  }
  const protVid = numeric(settings.checkoutProtection.variantId);
  return {
    ss: {
      on: overrides.ssOn ?? rw.setSavings.enabled,
      tiers: ssTiers.map((t) => ({ n: t.count, p: t.pct, c: t.code })),
      sub: rw.setSavings.includeSubscriptions,
      scope: scopeOf(settings.marketScopes?.set_savings),
      excl,
      msg: rw.setSavings.checkoutMessage,
      // Recomputed against the (possibly draft-overridden) ladder so a draft
      // ladder never leaves a ladder code listed as an alias.
      alias: aliasCodesFor({
        rewards: {
          setSavings: {
            keepLegacyCodes: rw.setSavings.keepLegacyCodes,
            tiers: ssTiers,
          },
        },
      }),
    },
    gt: {
      on: overrides.gtOn ?? rw.giftTiers.enabled,
      cum: rw.giftTiers.cumulative,
      max: rw.giftTiers.maxGiftLines,
      tiers: gtTiers.map((tier) => ({
        eur: tier.amount,
        slots: tier.slots.map((slot) =>
          slot.map((option) =>
            option.kind === "samples"
              ? { k: "s" as const, n: option.count }
              : { k: "v" as const, vid: numeric(option.variantId) },
          ),
        ),
      })),
      bm,
      pool,
      scope: scopeOf(settings.marketScopes?.gift_tiers),
    },
    fs: {
      on: rw.freeShip.enabled,
      min: rw.freeShip.minUnits,
      th: rw.freeShip.byThreshold,
      bm: fsBm,
      scope: scopeOf(rw.freeShip.scope),
    },
    units: { ...(ctx.units ?? {}) },
    prot: (protVid && vp[protVid]) || "",
    giftPids: [...giftPids].sort(),
    cm: { ...(ctx.cm ?? {}) },
  };
}

/**
 * Builds the `$app:cellexia/rewards` shop metafield value (SPEC §2.2): a
 * small numeric-id projection of the rewards settings the Discount Function
 * reads as its only config, plus a `draft` twin while a preview is armed
 * (draftFlags override the two masters; draftConfig.rewards overrides
 * tiers/amounts — re-sanitized here with the settings sanitizers, so a
 * malformed draft can never reach the Function). `ph` = sha256 of the raw
 * preview token when armed (the Function compares it to the `_cx_preview`
 * cart attribute), else "".
 */
export function buildRewardsMetafield(
  settings: BoosterSettings,
  previewDraft?: PreviewSyncPayload | null,
  ctx: RewardsMetafieldContext = {},
): RewardsMetafield {
  const live = projectRewards(settings, ctx);
  const armed = Boolean(previewDraft?.armed);
  let draft: RewardsMetafieldLive | null = null;
  if (armed && previewDraft) {
    const flags = previewDraft.draftFlags ?? {};
    const raw = previewDraft.draftConfig?.rewards;
    const rewards =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    draft = projectRewards(settings, ctx, {
      ssOn: typeof flags.set_savings === "boolean" ? flags.set_savings : undefined,
      gtOn: typeof flags.gift_tiers === "boolean" ? flags.gift_tiers : undefined,
      ssTiers: Array.isArray(rewards.setSavingsTiers)
        ? sanitizeSetSavingsTiers(rewards.setSavingsTiers)
        : undefined,
      gtTiers: Array.isArray(rewards.giftTiers)
        ? sanitizeGiftTiers(rewards.giftTiers)
        : undefined,
      gtBm:
        rewards.giftAmountsByMarket &&
        typeof rewards.giftAmountsByMarket === "object"
          ? sanitizeGiftThresholdsByMarket(rewards.giftAmountsByMarket)
          : undefined,
    });
  }
  return {
    v: 1,
    ph: armed && previewDraft?.token ? sha256Hex(previewDraft.token) : "",
    live,
    draft,
  };
}

/**
 * Loads the unit / variant→product maps from RewardsState (written by
 * rewards.server's buildUnitMap at Connect / Rewards-page save) — read
 * directly from prisma so this module does not import rewards.server
 * (which imports this one). Missing row → empty maps (units default to 1).
 */
async function loadRewardsMaps(
  shop: string,
): Promise<Pick<RewardsMetafieldContext, "units" | "vp">> {
  try {
    const row = await prisma.rewardsState.findUnique({ where: { shop } });
    if (!row) return {};
    const parsed: unknown = JSON.parse(row.nodes || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const nodes = parsed as Record<string, unknown>;
    const units: Record<string, number> = {};
    const vp: Record<string, string> = {};
    if (nodes.units && typeof nodes.units === "object") {
      for (const [vid, u] of Object.entries(nodes.units as Record<string, unknown>)) {
        if (typeof u === "number" && Number.isInteger(u) && u > 1) units[vid] = u;
      }
    }
    if (nodes.vp && typeof nodes.vp === "object") {
      for (const [vid, pid] of Object.entries(nodes.vp as Record<string, unknown>)) {
        if (typeof pid === "string" && /^\d+$/.test(pid)) vp[vid] = pid;
      }
    }
    return { units, vp };
  } catch {
    return {};
  }
}

const GIFT_STOCK_OWNER_QUERY = `#graphql
  query cellexiaGiftStockOwner {
    currentAppInstallation { id }
  }
`;

/**
 * Writes the `cellexia/gift_stock` app-data metafield (SPEC §2.3):
 * {"t": ISO, "paused": {"<market>": ["<numeric variantId>", ...]}} — read by
 * Liquid (island `gsp`). Called by the stock watcher only when the paused
 * set changed. The Function ignores stock on purpose.
 */
export async function writeGiftStockMetafield(
  admin: AdminGraphqlClient,
  paused: Record<string, string[]>,
): Promise<{ ok: boolean; errors: string[] }> {
  const ownerResponse = await admin.graphql(GIFT_STOCK_OWNER_QUERY);
  const ownerJson = (await ownerResponse.json()) as {
    data?: { currentAppInstallation?: { id: string } };
  };
  const appInstallationId = ownerJson.data?.currentAppInstallation?.id;
  if (!appInstallationId) {
    return { ok: false, errors: ["Could not resolve the app installation id"] };
  }
  const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: appInstallationId,
          namespace: "cellexia",
          key: "gift_stock",
          type: "json",
          value: JSON.stringify({ t: new Date().toISOString(), paused }),
        },
      ],
    },
  });
  const json = (await response.json()) as {
    data?: {
      metafieldsSet?: {
        userErrors?: { field?: string[] | null; message: string }[];
      };
    };
  };
  const errors = (json.data?.metafieldsSet?.userErrors ?? []).map((e) => e.message);
  return { ok: errors.length === 0, errors };
}

/** sha256 hex digest of the raw preview token (checkout-side comparator). */
function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Loads the current preview state for a shop so that EVERY settings sync
 * preserves an armed preview (feature pages, experiments etc. call
 * syncSettingsToMetafields without a preview argument — omitting this lookup
 * would silently disarm the storefront side of an armed preview).
 */
async function loadPreviewPayload(shop: string): Promise<PreviewSyncPayload> {
  try {
    const row = await prisma.previewState.findUnique({ where: { shop } });
    if (!row) return { armed: false, draftFlags: {}, draftConfig: {}, token: "" };
    let draftFlags: Record<string, boolean> = {};
    try {
      const parsed = JSON.parse(row.draftFlags);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "boolean") draftFlags[key] = value;
        }
      }
    } catch {
      draftFlags = {};
    }
    // Mirrors preview.server's sanitizeDraftConfig (not imported — that
    // module imports this one, so the tiny validation is duplicated here to
    // avoid a cycle): only known keys with closed-enum values survive.
    let draftConfig: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.draftConfig);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const deliveryFormat = (parsed as Record<string, unknown>)
          .deliveryFormat;
        if (
          typeof deliveryFormat === "string" &&
          (DELIVERY_ESTIMATE_FORMATS as readonly string[]).includes(
            deliveryFormat,
          )
        ) {
          draftConfig.deliveryFormat = deliveryFormat;
        }
        const deliveryFormatCart = (parsed as Record<string, unknown>)
          .deliveryFormatCart;
        if (
          typeof deliveryFormatCart === "string" &&
          (DELIVERY_ESTIMATE_FORMATS as readonly string[]).includes(
            deliveryFormatCart,
          )
        ) {
          draftConfig.deliveryFormatCart = deliveryFormatCart;
        }
        const deliveryFormatCheckout = (parsed as Record<string, unknown>)
          .deliveryFormatCheckout;
        if (
          typeof deliveryFormatCheckout === "string" &&
          (DELIVERY_ESTIMATE_FORMATS as readonly string[]).includes(
            deliveryFormatCheckout,
          )
        ) {
          draftConfig.deliveryFormatCheckout = deliveryFormatCheckout;
        }
        const shipsFromFormat = (parsed as Record<string, unknown>)
          .shipsFromFormat;
        if (
          typeof shipsFromFormat === "string" &&
          (SHIPS_FROM_FORMATS as readonly string[]).includes(shipsFromFormat)
        ) {
          draftConfig.shipsFromFormat = shipsFromFormat;
        }
        // v14 (SPEC §10) — BYTE-EQUIVALENT in behaviour with preview.server's
        // sanitizeDraftConfig: bounded simCart, rehearsal only when true,
        // rewards drafts re-sanitized with the settings sanitizers.
        const simCart = (parsed as Record<string, unknown>).simCart;
        if (typeof simCart === "object" && simCart !== null && !Array.isArray(simCart)) {
          const spend = Number((simCart as Record<string, unknown>).spendCents);
          const count = Number((simCart as Record<string, unknown>).count);
          if (Number.isFinite(spend) && Number.isFinite(count)) {
            draftConfig.simCart = {
              spendCents: Math.min(100_000_000, Math.max(0, Math.floor(spend))),
              count: Math.min(50, Math.max(0, Math.floor(count))),
            };
          }
        }
        if ((parsed as Record<string, unknown>).rehearsal === true) {
          draftConfig.rehearsal = true;
        }
        const rewards = (parsed as Record<string, unknown>).rewards;
        if (typeof rewards === "object" && rewards !== null && !Array.isArray(rewards)) {
          const rw = rewards as Record<string, unknown>;
          const draft: Record<string, unknown> = {};
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
          if (Object.keys(draft).length > 0) draftConfig.rewards = draft;
        }
      }
    } catch {
      draftConfig = {};
    }
    return { armed: row.armed, draftFlags, draftConfig, token: row.token };
  } catch {
    return { armed: false, draftFlags: {}, draftConfig: {}, token: "" };
  }
}

export async function syncSettingsToMetafields(
  admin: AdminGraphqlClient,
  settings: BoosterSettings,
  preview?: PreviewSyncPayload,
): Promise<{ ok: boolean; errors: string[] }> {
  const ownerResponse = await admin.graphql(OWNER_IDS_QUERY);
  const ownerJson = (await ownerResponse.json()) as {
    data?: {
      currentAppInstallation?: { id: string };
      shop?: { id: string; myshopifyDomain?: string };
    };
  };

  const appInstallationId = ownerJson.data?.currentAppInstallation?.id;
  const shopId = ownerJson.data?.shop?.id;
  if (!appInstallationId || !shopId) {
    return { ok: false, errors: ["Could not resolve metafield owner ids"] };
  }

  const shopDomain = ownerJson.data?.shop?.myshopifyDomain ?? "";
  const effectivePreview =
    preview ??
    (shopDomain
      ? await loadPreviewPayload(shopDomain)
      : { armed: false, draftFlags: {}, draftConfig: {}, token: "" });

  // Defense in depth: a disarmed preview never ships draft flags (or draft
  // config overrides) anywhere.
  const draftFlags = effectivePreview.armed ? effectivePreview.draftFlags : {};
  const draftConfig = effectivePreview.armed
    ? effectivePreview.draftConfig
    : {};
  const liquidValue = JSON.stringify({
    ...settings,
    preview: { armed: effectivePreview.armed, draftFlags, draftConfig },
  });
  // draftConfig is tokenless by construction (closed-enum values only —
  // validated in loadPreviewPayload / preview.server's sanitizeDraftConfig),
  // so it is safe to mirror into BOTH payloads: the checkout extension needs
  // it (v6.0) to honor a previewed delivery format, exactly like Liquid does.
  const checkoutValue = JSON.stringify({
    ...settings,
    preview: {
      armed: effectivePreview.armed,
      draftFlags,
      draftConfig,
      tokenHash:
        effectivePreview.armed && effectivePreview.token
          ? sha256Hex(effectivePreview.token)
          : "",
    },
  });

  // v14: the THIRD entry — the Discount Function's rewards projection (SPEC
  // §2.2). Unit/variant maps come from RewardsState (no API call); the
  // country→market map from marketCountryMap (per-shop 1 h cache). Both
  // degrade to empty maps rather than failing the whole settings sync.
  let cm: Record<string, string> = {};
  let maps: Pick<RewardsMetafieldContext, "units" | "vp"> = {};
  if (shopDomain) {
    maps = await loadRewardsMaps(shopDomain);
    try {
      const map = await marketCountryMap(admin, shopDomain);
      cm = Object.fromEntries(map.byCountry);
    } catch {
      cm = {};
    }
  }
  const rewardsValue = JSON.stringify(
    buildRewardsMetafield(settings, effectivePreview, { ...maps, cm }),
  );

  const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: appInstallationId,
          namespace: "cellexia",
          key: "config",
          type: "json",
          value: liquidValue,
        },
        {
          ownerId: shopId,
          namespace: "$app:cellexia",
          key: "config",
          type: "json",
          value: checkoutValue,
        },
        {
          ownerId: shopId,
          namespace: "$app:cellexia",
          key: "rewards",
          type: "json",
          value: rewardsValue,
        },
      ],
    },
  });

  const json = (await response.json()) as {
    data?: {
      metafieldsSet?: {
        userErrors?: { field?: string[] | null; message: string }[];
      };
    };
  };
  const errors = (json.data?.metafieldsSet?.userErrors ?? []).map(
    (e) => e.message,
  );
  return { ok: errors.length === 0, errors };
}
