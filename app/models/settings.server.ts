import prisma from "../db.server";

/**
 * Canonical settings contract for the Cellexia AOV & LTV Booster.
 *
 * This JSON blob is the single source of truth for feature flags and
 * language-neutral configuration (numbers, product ids, styles). It is
 * stored in the ShopSettings table and mirrored to two metafields on save:
 *
 *   1. App-data metafield  (owner: AppInstallation, namespace "cellexia",
 *      key "config") — read by the THEME APP EXTENSION in Liquid via
 *      {{ app.metafields.cellexia.config.value }}.
 *   2. Shop metafield      (owner: Shop, namespace "$app:cellexia", key
 *      "config") — read by the CHECKOUT UI EXTENSIONS via useAppMetafields.
 *
 * IMPORTANT (i18n / Translate & Adapt): user-facing COPY does not live here.
 * All storefront strings ship as extension locale files (17 languages) and
 * as theme-editor block settings with translatable defaults, so merchants
 * manage translations in Translate & Adapt exactly like theme content.
 * Only language-neutral values (booleans, numbers, ids, URLs) belong in
 * this object.
 */

export interface VolumeOffer {
  /** Number of units for the offer tier (2 or 3 for Cellexia). */
  quantity: number;
  /** Percentage discount applied by the store's pricing for that tier. */
  discountPct: number;
}

export interface ClinicalStat {
  /** Headline number, e.g. 93 */
  value: number;
  /** Suffix rendered after the number, e.g. "%" or "x" */
  suffix: string;
  /**
   * Translation key of the default label (see extension locales,
   * e.g. "clinical.stat_wrinkles"). The theme editor block settings can
   * override the label per block instance; those overrides are translatable
   * via Translate & Adapt as theme content.
   */
  labelKey: string;
}

/**
 * Canonical feature keys — the unit of market targeting, dashboard toggle
 * cards, and experiment flips. Cart sub-features scope independently even
 * though they share the cartUpsell master switch.
 */
export type FeatureKey =
  | "cart_volume_upsell"
  | "free_shipping_bar"
  | "cart_subscription_upsell"
  | "cart_trust_row"
  | "trust_badges"
  | "trustpilot"
  | "guarantee"
  | "clinical_results"
  | "subscription_nudge"
  | "checkout_upsell"
  | "checkout_protection"
  | "checkout_trust"
  | "clinical_study"
  | "verified_before_after"
  | "batch_transparency"
  | "empty_bottle_guarantee"
  | "derm_survey"
  | "cart_cross_sell"
  | "dispatch_countdown";

export const FEATURE_KEYS: FeatureKey[] = [
  "cart_volume_upsell",
  "free_shipping_bar",
  "cart_subscription_upsell",
  "cart_trust_row",
  "trust_badges",
  "trustpilot",
  "guarantee",
  "clinical_results",
  "subscription_nudge",
  "checkout_upsell",
  "checkout_protection",
  "checkout_trust",
  "clinical_study",
  "verified_before_after",
  "batch_transparency",
  "empty_bottle_guarantee",
  "derm_survey",
  "cart_cross_sell",
  "dispatch_countdown",
];

export interface MarketScope {
  /** "all" = every market; "selected" = only the listed market handles. */
  mode: "all" | "selected";
  markets: string[];
}

/** A per-market free-shipping threshold. `currencyCode` tells the storefront
 *  how to compare: equal to the cart's presentment currency → direct compare;
 *  equal to the shop currency → convert via Shopify.currency.rate. */
export interface MarketThreshold {
  amount: number;
  currencyCode: string;
}

export interface BoosterSettings {
  version: number;
  global: {
    /** Legacy/fallback free-shipping threshold in the shop's currency
     *  (used when freeShipping.byMarket has no entry for the market). */
    freeShippingThreshold: number;
    /** Cellexia Blue — used for accents, progress bars, highlights. */
    accentColor: string;
    /** Cellexia ink black — used for text and dark surfaces. */
    inkColor: string;
    /** Light neutral background used by widget surfaces. */
    surfaceColor: string;
  };
  /**
   * Per-market free-shipping thresholds (SPEC v4.5). mode "auto" = detected
   * from the store's delivery profiles (free rates with a minimum-price
   * condition, shop currency); "manual" = merchant-entered per market,
   * typically in the market's own currency. Falls back to
   * global.freeShippingThreshold when a market has no entry.
   */
  freeShipping: {
    mode: "auto" | "manual";
    byMarket: Record<string, MarketThreshold>;
    /** ISO timestamp of the last auto-detection ("" = never). */
    detectedAt: string;
  };
  cartUpsell: {
    enabled: boolean;
    /** Free-shipping progress bar inside the mini-cart drawer. */
    showFreeShippingBar: boolean;
    /**
     * With several qualifying cart lines, at most this many products get
     * full offer groups (highest line value first); the rest collapse
     * behind a "show more" toggle. Keeps the drawer scannable.
     */
    maxOfferGroups: number;
    /** "Upgrade to 2 / 3 units" tier switcher inside the mini-cart. */
    showVolumeUpsell: boolean;
    volumeOffers: VolumeOffer[];
    /** Tier visually highlighted as "Most popular" / "Best value". */
    highlightQuantity: number;
    /** One-click switch of a one-time line to the Joy "Continuous Treatment Plan". */
    showSubscriptionUpsell: boolean;
    subscriptionDiscountPct: number;
    /**
     * Case-insensitive keyword used to find the Joy Subscription selling plan
     * among a product's selling_plan_groups (Joy creates native Shopify
     * selling plans, so they are visible to Liquid and the AJAX cart API).
     */
    sellingPlanKeyword: string;
    /** Compact trust row (guarantee, secure checkout, Trustpilot) in the drawer footer. */
    showTrustRow: boolean;
  };
  /**
   * Cross-sell other products inside the cart drawer (v4.8). Items are
   * hand-picked in the admin; `handle` lets Liquid render live product data
   * (price in the buyer's currency, availability) via all_products.
   */
  cartCrossSell: {
    enabled: boolean;
    /** "auto" = Shopify product recommendations (complementary, then related)
     *  based on the cart contents; "manual" = the hand-picked items below. */
    mode: "auto" | "manual";
    items: { variantId: string; handle: string }[];
    maxItems: number;
  };
  trustBadges: {
    enabled: boolean;
    style: "light" | "dark";
    /**
     * Ordered badge keys. Each key maps to an icon + translated label in the
     * theme extension. Available: secure_checkout, free_shipping_over,
     * money_back, dermatologist_tested, cruelty_free, clinically_proven,
     * ssl_encrypted, easy_returns.
     */
    items: string[];
  };
  trustpilot: {
    enabled: boolean;
    /** Aggregate rating shown in the widget, e.g. 4.8 */
    rating: number;
    reviewCount: number;
    /** Public Trustpilot profile URL the widget links to. */
    profileUrl: string;
    /** Link the widget to the Trustpilot profile (false = plain text/stars). */
    showLink: boolean;
  };
  guarantee: {
    enabled: boolean;
    /** Money-back guarantee window in days. */
    days: number;
  };
  clinicalResults: {
    enabled: boolean;
    stats: ClinicalStat[];
    /** Translation key for the methodology footnote. */
    footnoteKey: string;
  };
  subscriptionNudge: {
    enabled: boolean;
    discountPct: number;
    sellingPlanKeyword: string;
  };
  checkoutUpsell: {
    enabled: boolean;
    /** "auto" = Storefront productRecommendations from the checkout lines;
     *  "manual" = the hand-picked variantIds below. */
    mode: "auto" | "manual";
    /** Product variant GIDs offered in checkout (first in-stock ones are shown). */
    variantIds: string[];
    maxOffers: number;
  };
  checkoutProtection: {
    enabled: boolean;
    /** Variant GID of the "Order Protection" product (create it from the dashboard). */
    variantId: string;
    /** Pre-select the protection toggle for the buyer. */
    defaultOn: boolean;
    /** Show the "Recommended" chip on the checkout card. */
    showRecommended: boolean;
    /**
     * Desired per-market protection prices (round numbers per currency).
     * Applied to Shopify Markets price lists as FIXED prices for the
     * protection variant, so the charged amount equals the displayed one.
     */
    prices: { byMarket: Record<string, MarketThreshold> };
  };
  checkoutTrust: {
    enabled: boolean;
    showGuarantee: boolean;
    showTrustpilot: boolean;
    showClinical: boolean;
    showBadges: boolean;
  };
  /**
   * PDP trust boosters (SPEC v3). Content lives in per-product metaobjects
   * (Translate & Adapt-native); these sections carry only the master flags
   * and language-neutral numbers.
   */
  clinicalStudy: {
    enabled: boolean;
  };
  beforeAfter: {
    enabled: boolean;
  };
  batchTransparency: {
    enabled: boolean;
  };
  emptyBottleGuarantee: {
    enabled: boolean;
    /** Guarantee window in days (return the empty container for a full refund). */
    days: number;
    /**
     * Default container word used in the guarantee copy ("return the empty
     * {{ container }}"). Per-product override via pdp_flags.container.
     */
    container: "bottle" | "jar" | "tube" | "pump" | "product";
  };
  dermSurvey: {
    enabled: boolean;
    /** e.g. 9 (out of `outOf`) dermatologists would recommend. */
    recommend: number;
    outOf: number;
    /** Survey sample size, e.g. 270. */
    sampleSize: number;
    /** Third party that verified the survey (shown on the badge). */
    verifierName: string;
    verificationUrl: string;
  };
  /**
   * Dispatch countdown ("Order within 2h 14m for same-day dispatch").
   * The cutoff is defined in the WAREHOUSE timezone (IANA name); buyers see
   * a live countdown plus the cutoff converted to their own local clock, so
   * the display is timezone-correct worldwide. Shown only when the next
   * cutoff is today (warehouse terms), on a working day, and within
   * showWithinHours — urgency only when it is real. byCountry overrides the
   * default schedule per buyer country (ISO2) for multi-warehouse setups.
   */
  dispatch: {
    enabled: boolean;
    /** "HH:MM" 24h, in `timezone`. */
    cutoff: string;
    /** IANA timezone of the dispatching warehouse, e.g. "Europe/Paris". */
    timezone: string;
    /** ISO weekday numbers with same-day dispatch (1=Mon .. 7=Sun). */
    days: number[];
    /** Only show the countdown when ≤ this many hours remain (1-24). */
    showWithinHours: number;
    /** Show on the product page (next to the stock message). */
    showOnPdp: boolean;
    /** Show in the cart drawer (above the checkout actions). */
    showInCart: boolean;
    byCountry: Record<
      string,
      { cutoff: string; timezone: string; days: number[] }
    >;
  };
  /**
   * Per-feature market targeting. A feature is visible in market M only when
   * its flags are on AND (scope.mode === "all" || scope.markets includes M).
   * Market handles are Shopify Markets handles (e.g. "ireland").
   */
  marketScopes: Record<FeatureKey, MarketScope>;
}

const ALL_MARKETS_SCOPE: MarketScope = { mode: "all", markets: [] };

function defaultMarketScopes(): Record<FeatureKey, MarketScope> {
  return Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, structuredClone(ALL_MARKETS_SCOPE)]),
  ) as Record<FeatureKey, MarketScope>;
}

/**
 * SAFE-BY-DEFAULT: every feature master switch ships OFF, and every render
 * surface treats a missing config metafield as "hidden". Installing (or even
 * deploying + enabling the app embeds) changes NOTHING on the storefront or
 * in checkout until the merchant explicitly enables a feature here.
 * Sub-flags (showX) stay true so a master switch turns its widgets on.
 */
export const DEFAULT_SETTINGS: BoosterSettings = {
  version: 2,
  global: {
    freeShippingThreshold: 150,
    accentColor: "#B2CEED",
    inkColor: "#1D1D1B",
    surfaceColor: "#FFFFFF",
  },
  freeShipping: {
    mode: "auto",
    byMarket: {},
    detectedAt: "",
  },
  cartUpsell: {
    enabled: false,
    showFreeShippingBar: true,
    maxOfferGroups: 2,
    showVolumeUpsell: true,
    volumeOffers: [
      { quantity: 2, discountPct: 15 },
      { quantity: 3, discountPct: 20 },
    ],
    highlightQuantity: 3,
    showSubscriptionUpsell: true,
    subscriptionDiscountPct: 5,
    sellingPlanKeyword: "Continuous Treatment",
    showTrustRow: true,
  },
  cartCrossSell: {
    enabled: false,
    mode: "auto",
    items: [],
    maxItems: 2,
  },
  trustBadges: {
    enabled: false,
    style: "light",
    items: [
      "secure_checkout",
      "free_shipping_over",
      "money_back",
      "clinically_proven",
    ],
  },
  trustpilot: {
    enabled: false,
    rating: 4.8,
    reviewCount: 1000,
    profileUrl: "https://www.trustpilot.com/review/cellexia.com",
    showLink: true,
  },
  guarantee: {
    enabled: false,
    days: 60,
  },
  clinicalResults: {
    enabled: false,
    stats: [
      { value: 93, suffix: "%", labelKey: "clinical.stat_improvement" },
      { value: 89, suffix: "%", labelKey: "clinical.stat_hydration" },
      { value: 4, suffix: "wk", labelKey: "clinical.stat_visible" },
    ],
    footnoteKey: "clinical.footnote",
  },
  subscriptionNudge: {
    enabled: false,
    discountPct: 5,
    sellingPlanKeyword: "Continuous Treatment",
  },
  checkoutUpsell: {
    enabled: false,
    mode: "auto",
    variantIds: [],
    maxOffers: 2,
  },
  checkoutProtection: {
    enabled: false,
    variantId: "",
    defaultOn: false,
    showRecommended: true,
    prices: { byMarket: {} },
  },
  checkoutTrust: {
    enabled: false,
    showGuarantee: true,
    showTrustpilot: true,
    showClinical: false,
    showBadges: true,
  },
  clinicalStudy: {
    enabled: false,
  },
  beforeAfter: {
    enabled: false,
  },
  batchTransparency: {
    enabled: false,
  },
  emptyBottleGuarantee: {
    enabled: false,
    days: 60,
    container: "jar",
  },
  dermSurvey: {
    enabled: false,
    recommend: 9,
    outOf: 10,
    sampleSize: 270,
    verifierName: "",
    verificationUrl: "",
  },
  dispatch: {
    enabled: false,
    cutoff: "14:00",
    timezone: "Europe/Paris",
    days: [1, 2, 3, 4, 5],
    showWithinHours: 8,
    showOnPdp: true,
    showInCart: true,
    byCountry: {},
  },
  marketScopes: defaultMarketScopes(),
};

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? U[]
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Keys whose values are Records with DYNAMIC keys (market handles etc.).
 * The default is `{}`, so the key-driven deep merge below would silently
 * empty them — these are replaced wholesale instead (sanitizeSettings then
 * validates every entry).
 */
const DYNAMIC_RECORD_KEYS = new Set(["byMarket", "byCountry"]);

/** Deep-merge stored/partial settings over defaults so new fields added in
 *  later app versions always have sane values. Arrays are replaced, not merged. */
export function mergeSettings<T>(defaults: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(defaults)) {
    return defaults;
  }
  const out: Record<string, unknown> = { ...(defaults as object) } as Record<
    string,
    unknown
  >;
  for (const [key, defaultValue] of Object.entries(
    defaults as Record<string, unknown>,
  )) {
    const patchValue = (patch as Record<string, unknown>)[key];
    if (patchValue === undefined || patchValue === null) continue;
    if (DYNAMIC_RECORD_KEYS.has(key)) {
      out[key] = isPlainObject(patchValue) ? patchValue : defaultValue;
    } else if (isPlainObject(defaultValue)) {
      out[key] = mergeSettings(defaultValue, patchValue);
    } else if (Array.isArray(defaultValue)) {
      out[key] = Array.isArray(patchValue) ? patchValue : defaultValue;
    } else if (typeof patchValue === typeof defaultValue) {
      out[key] = patchValue;
    }
  }
  return out as T;
}

/** Badge keys the theme extension can render (see trustBadges.items docs). */
const VALID_BADGE_KEYS = new Set([
  "secure_checkout",
  "free_shipping_over",
  "money_back",
  "dermatologist_tested",
  "cruelty_free",
  "clinically_proven",
  "ssl_encrypted",
  "easy_returns",
]);

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;
const VARIANT_GID_PATTERN = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const MAX_CLINICAL_STATS = 4;

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function sanitizeColor(value: string, previous: string, fallback: string): string {
  if (HEX_COLOR_PATTERN.test(value)) return value;
  return HEX_COLOR_PATTERN.test(previous) ? previous : fallback;
}

function sanitizeHttpsUrl(
  value: string,
  previous: string,
  fallback: string,
): string {
  if (typeof value === "string" && value.startsWith("https://")) return value;
  return typeof previous === "string" && previous.startsWith("https://")
    ? previous
    : fallback;
}

/**
 * Bounds-checks the merged settings before they are persisted and mirrored
 * to the storefront metafields. mergeSettings only type-checks primitives
 * (and replaces arrays wholesale), so absurd numbers and malformed array
 * elements would otherwise flow straight into the theme/checkout widgets.
 * Invalid values fall back to the previous settings or the defaults.
 */
export function sanitizeSettings(
  next: BoosterSettings,
  previous: BoosterSettings,
): BoosterSettings {
  next.global.freeShippingThreshold = clampNumber(
    next.global.freeShippingThreshold,
    0,
    100000,
    DEFAULT_SETTINGS.global.freeShippingThreshold,
  );
  next.global.accentColor = sanitizeColor(
    next.global.accentColor,
    previous.global.accentColor,
    DEFAULT_SETTINGS.global.accentColor,
  );
  next.global.inkColor = sanitizeColor(
    next.global.inkColor,
    previous.global.inkColor,
    DEFAULT_SETTINGS.global.inkColor,
  );
  next.global.surfaceColor = sanitizeColor(
    next.global.surfaceColor,
    previous.global.surfaceColor,
    DEFAULT_SETTINGS.global.surfaceColor,
  );

  next.cartUpsell.subscriptionDiscountPct = clampNumber(
    next.cartUpsell.subscriptionDiscountPct,
    0,
    90,
    DEFAULT_SETTINGS.cartUpsell.subscriptionDiscountPct,
  );
  next.cartUpsell.volumeOffers = (next.cartUpsell.volumeOffers ?? [])
    .filter(
      (offer) =>
        isPlainObject(offer) &&
        Number.isInteger(offer.quantity) &&
        offer.quantity >= 2 &&
        offer.quantity <= 6 &&
        typeof offer.discountPct === "number" &&
        Number.isFinite(offer.discountPct) &&
        offer.discountPct >= 0 &&
        offer.discountPct <= 90,
    )
    .map((offer) => ({
      quantity: offer.quantity,
      discountPct: offer.discountPct,
    }));

  next.trustBadges.items = (next.trustBadges.items ?? []).filter(
    (item) => typeof item === "string" && VALID_BADGE_KEYS.has(item),
  );

  next.trustpilot.rating = clampNumber(
    next.trustpilot.rating,
    0,
    5,
    DEFAULT_SETTINGS.trustpilot.rating,
  );
  next.trustpilot.profileUrl = sanitizeHttpsUrl(
    next.trustpilot.profileUrl,
    previous.trustpilot.profileUrl,
    DEFAULT_SETTINGS.trustpilot.profileUrl,
  );

  next.guarantee.days = clampNumber(
    next.guarantee.days,
    1,
    365,
    DEFAULT_SETTINGS.guarantee.days,
  );

  next.clinicalResults.stats = (next.clinicalResults.stats ?? [])
    .filter(
      (stat) =>
        isPlainObject(stat) &&
        typeof stat.value === "number" &&
        Number.isFinite(stat.value) &&
        typeof stat.suffix === "string" &&
        stat.suffix.length <= 4 &&
        typeof stat.labelKey === "string" &&
        stat.labelKey.length <= 64,
    )
    .slice(0, MAX_CLINICAL_STATS)
    .map((stat) => ({
      value: stat.value,
      suffix: stat.suffix,
      labelKey: stat.labelKey,
    }));

  next.subscriptionNudge.discountPct = clampNumber(
    next.subscriptionNudge.discountPct,
    0,
    90,
    DEFAULT_SETTINGS.subscriptionNudge.discountPct,
  );

  next.checkoutUpsell.maxOffers = Math.round(
    clampNumber(
      next.checkoutUpsell.maxOffers,
      1,
      4,
      DEFAULT_SETTINGS.checkoutUpsell.maxOffers,
    ),
  );
  next.checkoutUpsell.variantIds = (next.checkoutUpsell.variantIds ?? []).filter(
    (id) => typeof id === "string" && VARIANT_GID_PATTERN.test(id),
  );

  if (next.freeShipping.mode !== "auto" && next.freeShipping.mode !== "manual") {
    next.freeShipping.mode = DEFAULT_SETTINGS.freeShipping.mode;
  }
  if (typeof next.freeShipping.detectedAt !== "string") {
    next.freeShipping.detectedAt = "";
  }
  {
    const marketHandleKey = /^[a-z0-9][a-z0-9-]{0,63}$/;
    const currencyKey = /^[A-Z]{3}$/;
    const cleanByMarket: Record<string, MarketThreshold> = {};
    for (const [handle, entry] of Object.entries(
      next.freeShipping.byMarket ?? {},
    )) {
      if (!marketHandleKey.test(handle)) continue;
      if (!isPlainObject(entry)) continue;
      const amount = entry.amount;
      const currencyCode =
        typeof entry.currencyCode === "string"
          ? entry.currencyCode.toUpperCase()
          : "";
      if (
        typeof amount === "number" &&
        Number.isFinite(amount) &&
        amount >= 0 &&
        amount <= 100000 &&
        currencyKey.test(currencyCode)
      ) {
        cleanByMarket[handle] = { amount, currencyCode };
      }
    }
    next.freeShipping.byMarket = cleanByMarket;
  }
  next.cartUpsell.maxOfferGroups = Math.round(
    clampNumber(
      next.cartUpsell.maxOfferGroups,
      1,
      4,
      DEFAULT_SETTINGS.cartUpsell.maxOfferGroups,
    ),
  );

  {
    const gid = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
    const handleOk = /^[a-z0-9][a-z0-9-_]{0,254}$/;
    next.cartCrossSell.items = (next.cartCrossSell.items ?? [])
      .filter(
        (item) =>
          isPlainObject(item) &&
          typeof item.variantId === "string" &&
          gid.test(item.variantId) &&
          typeof item.handle === "string" &&
          handleOk.test(item.handle),
      )
      .slice(0, 8)
      .map((item) => ({ variantId: item.variantId, handle: item.handle }));
  }
  next.cartCrossSell.maxItems = Math.round(
    clampNumber(
      next.cartCrossSell.maxItems,
      1,
      4,
      DEFAULT_SETTINGS.cartCrossSell.maxItems,
    ),
  );

  if (next.cartCrossSell.mode !== "auto" && next.cartCrossSell.mode !== "manual") {
    next.cartCrossSell.mode = DEFAULT_SETTINGS.cartCrossSell.mode;
  }
  if (next.checkoutUpsell.mode !== "auto" && next.checkoutUpsell.mode !== "manual") {
    next.checkoutUpsell.mode = DEFAULT_SETTINGS.checkoutUpsell.mode;
  }
  {
    const marketHandleKey = /^[a-z0-9][a-z0-9-]{0,63}$/;
    const currencyKey = /^[A-Z]{3}$/;
    const clean: Record<string, MarketThreshold> = {};
    for (const [handle, entry] of Object.entries(
      next.checkoutProtection.prices?.byMarket ?? {},
    )) {
      if (!marketHandleKey.test(handle) || !isPlainObject(entry)) continue;
      const amount = entry.amount;
      const currencyCode =
        typeof entry.currencyCode === "string"
          ? entry.currencyCode.toUpperCase()
          : "";
      if (
        typeof amount === "number" &&
        Number.isFinite(amount) &&
        amount >= 0 &&
        amount <= 1000 &&
        currencyKey.test(currencyCode)
      ) {
        clean[handle] = { amount, currencyCode };
      }
    }
    next.checkoutProtection.prices = { byMarket: clean };
  }

  {
    const cutoffOk = /^([01]\d|2[0-3]):[0-5]\d$/;
    const tzOk = /^[A-Za-z_]+\/[A-Za-z0-9_+\-\/]+$|^UTC$/;
    const iso2 = /^[A-Z]{2}$/;
    const cleanDays = (raw: unknown): number[] => {
      const days = Array.isArray(raw)
        ? [...new Set(raw.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))]
        : [];
      return days.length > 0 ? (days as number[]).sort() : [];
    };
    const d = next.dispatch;
    if (!cutoffOk.test(d.cutoff)) d.cutoff = DEFAULT_SETTINGS.dispatch.cutoff;
    if (typeof d.timezone !== "string" || !tzOk.test(d.timezone)) {
      d.timezone = DEFAULT_SETTINGS.dispatch.timezone;
    }
    const days = cleanDays(d.days);
    d.days = days.length > 0 ? days : [...DEFAULT_SETTINGS.dispatch.days];
    d.showWithinHours = Math.round(
      clampNumber(d.showWithinHours, 1, 24, DEFAULT_SETTINGS.dispatch.showWithinHours),
    );
    const cleanByCountry: typeof d.byCountry = {};
    for (const [country, entry] of Object.entries(d.byCountry ?? {})) {
      const code = country.toUpperCase();
      if (!iso2.test(code) || !isPlainObject(entry)) continue;
      const cutoff = typeof entry.cutoff === "string" && cutoffOk.test(entry.cutoff)
        ? entry.cutoff
        : null;
      const timezone =
        typeof entry.timezone === "string" && tzOk.test(entry.timezone)
          ? entry.timezone
          : null;
      const entryDays = cleanDays(entry.days);
      if (cutoff && timezone && entryDays.length > 0) {
        cleanByCountry[code] = { cutoff, timezone, days: entryDays };
      }
    }
    d.byCountry = cleanByCountry;
  }

  if (typeof next.trustpilot.showLink !== "boolean") {
    next.trustpilot.showLink = DEFAULT_SETTINGS.trustpilot.showLink;
  }
  {
    const containers = ["bottle", "jar", "tube", "pump", "product"];
    if (!containers.includes(next.emptyBottleGuarantee.container)) {
      next.emptyBottleGuarantee.container =
        DEFAULT_SETTINGS.emptyBottleGuarantee.container;
    }
  }
  next.emptyBottleGuarantee.days = Math.round(
    clampNumber(
      next.emptyBottleGuarantee.days,
      1,
      365,
      DEFAULT_SETTINGS.emptyBottleGuarantee.days,
    ),
  );
  next.dermSurvey.outOf = Math.round(
    clampNumber(next.dermSurvey.outOf, 1, 100, DEFAULT_SETTINGS.dermSurvey.outOf),
  );
  next.dermSurvey.recommend = Math.round(
    clampNumber(
      next.dermSurvey.recommend,
      0,
      next.dermSurvey.outOf,
      Math.min(DEFAULT_SETTINGS.dermSurvey.recommend, next.dermSurvey.outOf),
    ),
  );
  next.dermSurvey.sampleSize = Math.round(
    clampNumber(
      next.dermSurvey.sampleSize,
      1,
      1000000,
      DEFAULT_SETTINGS.dermSurvey.sampleSize,
    ),
  );
  if (typeof next.dermSurvey.verifierName !== "string") {
    next.dermSurvey.verifierName = "";
  } else {
    next.dermSurvey.verifierName = next.dermSurvey.verifierName.slice(0, 120);
  }
  if (
    next.dermSurvey.verificationUrl !== "" &&
    !next.dermSurvey.verificationUrl.startsWith("https://")
  ) {
    next.dermSurvey.verificationUrl = previous.dermSurvey?.verificationUrl?.startsWith(
      "https://",
    )
      ? previous.dermSurvey.verificationUrl
      : "";
  }

  const marketHandlePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const sanitizedScopes = defaultMarketScopes();
  for (const key of FEATURE_KEYS) {
    const scope = next.marketScopes?.[key];
    if (
      isPlainObject(scope) &&
      scope.mode === "selected" &&
      Array.isArray(scope.markets)
    ) {
      sanitizedScopes[key] = {
        mode: "selected",
        markets: [
          ...new Set(
            scope.markets.filter(
              (handle): handle is string =>
                typeof handle === "string" && marketHandlePattern.test(handle),
            ),
          ),
        ].slice(0, 50),
      };
    }
  }
  next.marketScopes = sanitizedScopes;

  return next;
}

// ---------------------------------------------------------------------------
// Feature definitions, market resolution, experiment flips
// ---------------------------------------------------------------------------

interface FeatureDef {
  label: string;
  /** Reads the feature's combined flag state (master && sub-flag). */
  get: (s: BoosterSettings) => boolean;
  /** Sets the feature's flags so the combined state matches `on`. */
  set: (s: BoosterSettings, on: boolean) => void;
  /** Sibling keys sharing the same master switch (cart sub-features). */
  siblings: FeatureKey[];
}

const CART_SIBLINGS: FeatureKey[] = [
  "cart_volume_upsell",
  "free_shipping_bar",
  "cart_subscription_upsell",
  "cart_trust_row",
];

export const FEATURE_DEFS: Record<FeatureKey, FeatureDef> = {
  cart_volume_upsell: {
    label: "Cart volume upgrade",
    get: (s) => s.cartUpsell.enabled && s.cartUpsell.showVolumeUpsell,
    set: (s, on) => {
      if (on) s.cartUpsell.enabled = true;
      s.cartUpsell.showVolumeUpsell = on;
    },
    siblings: CART_SIBLINGS,
  },
  free_shipping_bar: {
    label: "Free-shipping progress bar",
    get: (s) => s.cartUpsell.enabled && s.cartUpsell.showFreeShippingBar,
    set: (s, on) => {
      if (on) s.cartUpsell.enabled = true;
      s.cartUpsell.showFreeShippingBar = on;
    },
    siblings: CART_SIBLINGS,
  },
  cart_subscription_upsell: {
    label: "Cart subscription switch",
    get: (s) => s.cartUpsell.enabled && s.cartUpsell.showSubscriptionUpsell,
    set: (s, on) => {
      if (on) s.cartUpsell.enabled = true;
      s.cartUpsell.showSubscriptionUpsell = on;
    },
    siblings: CART_SIBLINGS,
  },
  cart_trust_row: {
    label: "Cart trust row",
    get: (s) => s.cartUpsell.enabled && s.cartUpsell.showTrustRow,
    set: (s, on) => {
      if (on) s.cartUpsell.enabled = true;
      s.cartUpsell.showTrustRow = on;
    },
    siblings: CART_SIBLINGS,
  },
  trust_badges: {
    label: "Trust badges",
    get: (s) => s.trustBadges.enabled,
    set: (s, on) => {
      s.trustBadges.enabled = on;
    },
    siblings: [],
  },
  trustpilot: {
    label: "Trustpilot widget",
    get: (s) => s.trustpilot.enabled,
    set: (s, on) => {
      s.trustpilot.enabled = on;
    },
    siblings: [],
  },
  guarantee: {
    label: "Money-back guarantee",
    get: (s) => s.guarantee.enabled,
    set: (s, on) => {
      s.guarantee.enabled = on;
    },
    siblings: [],
  },
  clinical_results: {
    label: "Clinical results",
    get: (s) => s.clinicalResults.enabled,
    set: (s, on) => {
      s.clinicalResults.enabled = on;
    },
    siblings: [],
  },
  subscription_nudge: {
    label: "Subscription nudge",
    get: (s) => s.subscriptionNudge.enabled,
    set: (s, on) => {
      s.subscriptionNudge.enabled = on;
    },
    siblings: [],
  },
  checkout_upsell: {
    label: "Checkout upsell",
    get: (s) => s.checkoutUpsell.enabled,
    set: (s, on) => {
      s.checkoutUpsell.enabled = on;
    },
    siblings: [],
  },
  checkout_protection: {
    label: "Order Protection",
    get: (s) => s.checkoutProtection.enabled,
    set: (s, on) => {
      s.checkoutProtection.enabled = on;
    },
    siblings: [],
  },
  checkout_trust: {
    label: "Checkout trust module",
    get: (s) => s.checkoutTrust.enabled,
    set: (s, on) => {
      s.checkoutTrust.enabled = on;
    },
    siblings: [],
  },
  clinical_study: {
    label: "Clinical study (PDP)",
    get: (s) => s.clinicalStudy.enabled,
    set: (s, on) => {
      s.clinicalStudy.enabled = on;
    },
    siblings: [],
  },
  verified_before_after: {
    label: "Verified before/after",
    get: (s) => s.beforeAfter.enabled,
    set: (s, on) => {
      s.beforeAfter.enabled = on;
    },
    siblings: [],
  },
  batch_transparency: {
    label: "Batch transparency",
    get: (s) => s.batchTransparency.enabled,
    set: (s, on) => {
      s.batchTransparency.enabled = on;
    },
    siblings: [],
  },
  empty_bottle_guarantee: {
    label: "Empty bottle guarantee",
    get: (s) => s.emptyBottleGuarantee.enabled,
    set: (s, on) => {
      s.emptyBottleGuarantee.enabled = on;
    },
    siblings: [],
  },
  derm_survey: {
    label: "Dermatologist survey",
    get: (s) => s.dermSurvey.enabled,
    set: (s, on) => {
      s.dermSurvey.enabled = on;
    },
    siblings: [],
  },
  cart_cross_sell: {
    label: "Cart cross-sell",
    get: (s) => s.cartCrossSell.enabled,
    set: (s, on) => {
      s.cartCrossSell.enabled = on;
    },
    siblings: [],
  },
  dispatch_countdown: {
    label: "Dispatch countdown",
    get: (s) => s.dispatch.enabled,
    set: (s, on) => {
      s.dispatch.enabled = on;
    },
    siblings: [],
  },
};

function scopeFor(settings: BoosterSettings, key: FeatureKey): MarketScope {
  const scope = settings.marketScopes?.[key];
  if (!scope || (scope.mode !== "all" && scope.mode !== "selected")) {
    return structuredClone(ALL_MARKETS_SCOPE);
  }
  return scope;
}

/** Combined flag state (ignores market scoping). */
export function resolveFeatureFlag(
  settings: BoosterSettings,
  key: FeatureKey,
): boolean {
  return FEATURE_DEFS[key].get(settings);
}

/** Effective visibility of a feature for a buyer in the given market. */
export function isFeatureOnForMarket(
  settings: BoosterSettings,
  key: FeatureKey,
  marketHandle: string,
): boolean {
  if (!resolveFeatureFlag(settings, key)) return false;
  const scope = scopeFor(settings, key);
  return scope.mode === "all" || scope.markets.includes(marketHandle);
}

/** Cart drawer sub-flags stored raw in a FlagsSnapshot. */
export const CART_SUB_FLAG_FIELDS = [
  "showFreeShippingBar",
  "showVolumeUpsell",
  "showSubscriptionUpsell",
  "showTrustRow",
] as const;
export type CartSubFlagField = (typeof CART_SUB_FLAG_FIELDS)[number];

/** Settings sections with their own standalone `enabled` master flag. */
export const STANDALONE_SECTION_FIELDS = [
  "trustBadges",
  "trustpilot",
  "guarantee",
  "clinicalResults",
  "subscriptionNudge",
  "checkoutUpsell",
  "checkoutProtection",
  "checkoutTrust",
  "clinicalStudy",
  "beforeAfter",
  "batchTransparency",
  "emptyBottleGuarantee",
  "dermSurvey",
  "cartCrossSell",
  "dispatch",
] as const;
export type StandaloneSectionField = (typeof STANDALONE_SECTION_FIELDS)[number];

/**
 * Raw storage location of each feature's own flag — used by
 * restoreFlagsSelective to put back exactly (and only) what an experiment
 * flipped.
 */
export const FEATURE_RAW_FIELD: Record<
  FeatureKey,
  | { kind: "cart"; field: CartSubFlagField }
  | { kind: "section"; field: StandaloneSectionField }
> = {
  cart_volume_upsell: { kind: "cart", field: "showVolumeUpsell" },
  free_shipping_bar: { kind: "cart", field: "showFreeShippingBar" },
  cart_subscription_upsell: { kind: "cart", field: "showSubscriptionUpsell" },
  cart_trust_row: { kind: "cart", field: "showTrustRow" },
  trust_badges: { kind: "section", field: "trustBadges" },
  trustpilot: { kind: "section", field: "trustpilot" },
  guarantee: { kind: "section", field: "guarantee" },
  clinical_results: { kind: "section", field: "clinicalResults" },
  subscription_nudge: { kind: "section", field: "subscriptionNudge" },
  checkout_upsell: { kind: "section", field: "checkoutUpsell" },
  checkout_protection: { kind: "section", field: "checkoutProtection" },
  checkout_trust: { kind: "section", field: "checkoutTrust" },
  clinical_study: { kind: "section", field: "clinicalStudy" },
  verified_before_after: { kind: "section", field: "beforeAfter" },
  batch_transparency: { kind: "section", field: "batchTransparency" },
  empty_bottle_guarantee: { kind: "section", field: "emptyBottleGuarantee" },
  derm_survey: { kind: "section", field: "dermSurvey" },
  cart_cross_sell: { kind: "section", field: "cartCrossSell" },
  dispatch_countdown: { kind: "section", field: "dispatch" },
};

/**
 * Everything an experiment must be able to snapshot and restore.
 *
 * Stores the RAW underlying fields — the cart master, the four cart show*
 * sub-flags, and each standalone section's `enabled` flag — NOT the combined
 * (master AND sub-flag) states. Restoring writes these raw fields back
 * verbatim, so a dormant sub-flag (e.g. showVolumeUpsell true while the cart
 * master is off) survives a snapshot/restore round-trip instead of being
 * zeroed by a combined-state write through FEATURE_DEFS.set.
 */
export interface FlagsSnapshot {
  cartMaster: boolean;
  cartSubFlags: Record<CartSubFlagField, boolean>;
  sectionEnabled: Record<StandaloneSectionField, boolean>;
  marketScopes: Record<FeatureKey, MarketScope>;
}

export function snapshotFlags(settings: BoosterSettings): FlagsSnapshot {
  return {
    cartMaster: settings.cartUpsell.enabled,
    cartSubFlags: Object.fromEntries(
      CART_SUB_FLAG_FIELDS.map((field) => [field, settings.cartUpsell[field]]),
    ) as Record<CartSubFlagField, boolean>,
    sectionEnabled: Object.fromEntries(
      STANDALONE_SECTION_FIELDS.map((field) => [
        field,
        settings[field].enabled,
      ]),
    ) as Record<StandaloneSectionField, boolean>,
    marketScopes: structuredClone(settings.marketScopes),
  };
}

export function restoreFlags(
  settings: BoosterSettings,
  snapshot: FlagsSnapshot,
): BoosterSettings {
  settings.cartUpsell.enabled = snapshot.cartMaster;
  for (const field of CART_SUB_FLAG_FIELDS) {
    settings.cartUpsell[field] = snapshot.cartSubFlags[field];
  }
  for (const field of STANDALONE_SECTION_FIELDS) {
    settings[field].enabled = snapshot.sectionEnabled[field];
  }
  settings.marketScopes = structuredClone(snapshot.marketScopes);
  return settings;
}

/**
 * Restores ONLY the raw flags + scopes belonging to `keys` from a snapshot —
 * the rollback primitive for per-market concurrent experiments. Because
 * startExperiment forbids flip-key overlap between running experiments (and
 * treats all cart_* keys as one overlap group — shared master), touching only
 * these fields can never clobber another running experiment's state.
 *
 * Any cart_* key restores the cart master AND all four cart sub-flags (the
 * flip may have force-isolated dormant siblings when it turned the master on).
 * Fields missing from an (older-shape) snapshot are skipped, never zeroed.
 */
export function restoreFlagsSelective(
  settings: BoosterSettings,
  snapshot: FlagsSnapshot,
  keys: FeatureKey[],
): BoosterSettings {
  const hasCartKey = keys.some(
    (key) => FEATURE_RAW_FIELD[key]?.kind === "cart",
  );
  if (hasCartKey) {
    if (typeof snapshot.cartMaster === "boolean") {
      settings.cartUpsell.enabled = snapshot.cartMaster;
    }
    for (const field of CART_SUB_FLAG_FIELDS) {
      const value = snapshot.cartSubFlags?.[field];
      if (typeof value === "boolean") settings.cartUpsell[field] = value;
    }
  }
  for (const key of keys) {
    const raw = FEATURE_RAW_FIELD[key];
    if (raw?.kind === "section") {
      const value = snapshot.sectionEnabled?.[raw.field];
      if (typeof value === "boolean") settings[raw.field].enabled = value;
    }
    const scope = snapshot.marketScopes?.[key];
    if (
      scope &&
      (scope.mode === "all" || scope.mode === "selected") &&
      Array.isArray(scope.markets)
    ) {
      settings.marketScopes[key] = structuredClone(scope);
    }
  }
  return settings;
}

/**
 * Mutates settings so `key` becomes effectively `to` in `market` (a market
 * handle, or "all") while leaving other markets' effective state untouched.
 * `allMarketHandles` (every market on the shop) is needed to subtract a
 * market from an "all" scope.
 *
 * Turning a cart sub-feature's master ON as a side effect must not resurrect
 * sibling features that were effectively off — their sub-flags are forced
 * off first so the master flip is isolated to the requested key.
 */
export function applyFlipForMarket(
  settings: BoosterSettings,
  key: FeatureKey,
  market: string,
  to: boolean,
  allMarketHandles: string[],
): BoosterSettings {
  const def = FEATURE_DEFS[key];
  const scope = structuredClone(scopeFor(settings, key));

  if (to) {
    const wasOn = def.get(settings);
    const masterWasOff =
      def.siblings.length > 0 && !settings.cartUpsell.enabled;
    if (masterWasOff) {
      for (const sibling of def.siblings) {
        if (sibling !== key && !FEATURE_DEFS[sibling].get(settings)) {
          FEATURE_DEFS[sibling].set(settings, false);
        }
      }
    }
    def.set(settings, true);
    if (market === "all") {
      settings.marketScopes[key] = { mode: "all", markets: [] };
    } else if (!wasOn) {
      // Flags were off, so the feature was live NOWHERE regardless of the
      // stored scope. Restrict to just this market so the flag flip doesn't
      // light up other (dormant) markets as a side effect.
      settings.marketScopes[key] = { mode: "selected", markets: [market] };
    } else if (scope.mode === "all") {
      // Already live everywhere (including this market) — nothing to change.
    } else {
      settings.marketScopes[key] = {
        mode: "selected",
        markets: [...new Set([...scope.markets, market])],
      };
    }
  } else {
    if (market === "all") {
      def.set(settings, false);
    } else if (scope.mode === "all") {
      settings.marketScopes[key] = {
        mode: "selected",
        markets: allMarketHandles.filter((handle) => handle !== market),
      };
    } else {
      settings.marketScopes[key] = {
        mode: "selected",
        markets: scope.markets.filter((handle) => handle !== market),
      };
    }
  }
  return settings;
}

export async function getSettings(shop: string): Promise<BoosterSettings> {
  const row = await prisma.shopSettings.findUnique({ where: { shop } });
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  try {
    return mergeSettings(structuredClone(DEFAULT_SETTINGS), JSON.parse(row.data));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(
  shop: string,
  patch: DeepPartial<BoosterSettings>,
): Promise<BoosterSettings> {
  const current = await getSettings(shop);
  const next = sanitizeSettings(mergeSettings(current, patch), current);
  next.version = DEFAULT_SETTINGS.version;
  await prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, data: JSON.stringify(next) },
    update: { data: JSON.stringify(next) },
  });
  return next;
}

export type { DeepPartial };
