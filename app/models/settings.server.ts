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
  | "checkout_customs"
  | "checkout_tracked"
  | "clinical_study"
  | "verified_before_after"
  | "batch_transparency"
  | "empty_bottle_guarantee"
  | "derm_survey"
  | "press"
  | "derm_endorsements"
  | "cart_cross_sell"
  | "dispatch_countdown"
  | "delivery_estimate"
  | "az_buy_box"
  | "az_microcopy"
  | "az_delivery_line"
  | "az_stock_line"
  | "az_ships_from"
  | "az_bought_count"
  | "az_bestseller_badge"
  | "az_fbt"
  | "az_similar_items"
  | "az_cart_free_line"
  | "az_cta_count"
  // v14 rewards (docs/SPEC-v14-rewards.md §1) — appended at the END so every
  // existing index-based consumer keeps its positions.
  | "set_savings"
  | "gift_tiers";

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
  "checkout_customs",
  "checkout_tracked",
  "clinical_study",
  "verified_before_after",
  "batch_transparency",
  "empty_bottle_guarantee",
  "derm_survey",
  "press",
  "derm_endorsements",
  "cart_cross_sell",
  "dispatch_countdown",
  "delivery_estimate",
  "az_buy_box",
  "az_microcopy",
  "az_delivery_line",
  "az_stock_line",
  "az_ships_from",
  "az_bought_count",
  "az_bestseller_badge",
  "az_fbt",
  "az_similar_items",
  "az_cart_free_line",
  "az_cta_count",
  // v14 rewards — appended last (35 → 37 keys).
  "set_savings",
  "gift_tiers",
];

/**
 * The eleven Amazon-pattern feature flags (v6.1; +shipsFrom in v6.8, split
 * out of stockLine), stored as sibling booleans in the single `amazon`
 * settings section — no shared master switch (each key toggles
 * independently, unlike the cart sub-features). The array order mirrors
 * FEATURE_KEYS' az_* order.
 */
export const AMAZON_FLAG_FIELDS = [
  "buyBox",
  "microcopy",
  "deliveryLine",
  "stockLine",
  "shipsFrom",
  "boughtCount",
  "bestsellerBadge",
  "fbt",
  "similarItems",
  "cartFreeLine",
  "ctaCount",
] as const;
export type AmazonFlagField = (typeof AMAZON_FLAG_FIELDS)[number];

/**
 * v14: the two rewards feature flags, stored as `rewards.<field>.enabled`
 * (each sub-section has its own master; no shared switch — the amazon
 * convention). Array order mirrors FEATURE_KEYS' rewards order
 * (set_savings, gift_tiers).
 */
export const REWARDS_FLAG_FIELDS = ["setSavings", "giftTiers"] as const;
export type RewardsFlagField = (typeof REWARDS_FLAG_FIELDS)[number];

/**
 * PDP placement choices for the az_fbt / az_similar_items sections (v6.5).
 * "tabs_below" = directly BELOW the theme's big info-tabs box (the Sleepify
 * `.pdp__tabs` section: overview / science / benefits / compare / FAQs /
 * guarantee) and ABOVE the "Create your ritual" theme section — the
 * merchant-requested spot and the DEFAULT. "buybox" = the classic v6.1
 * position under the buy area (above the proof stack). The storefront JS
 * falls back to "buybox" when the tabs anchor is missing, so a theme
 * update can never make the section vanish because of placement.
 */
export const AMAZON_PLACEMENTS = ["tabs_below", "buybox"] as const;
export type AmazonPlacement = (typeof AMAZON_PLACEMENTS)[number];

/**
 * Display formats for the az_ships_from line (v6.10, merchant-set).
 * "subtle" (default — the pre-v6.10 look): the small gray microline next to
 * the In-Stock line. "prominent": a 15px logistics-green row with a truck
 * icon and the country name in bold — the Amazon-style local-fulfillment
 * signal, recommended when shipping really is local/nearby (the line only
 * renders when a warehouse resolves, so it is a conversion driver there).
 * Both formats render the same translated sentence; only presentation
 * changes. Sanitized against this closed enum (anything else -> "subtle").
 */
export const SHIPS_FROM_FORMATS = ["subtle", "prominent"] as const;
export type ShipsFromFormat = (typeof SHIPS_FROM_FORMATS)[number];

/** The five merchant-selectable derm-survey display formats (v5.8).
 *  v7-LEGACY: the storefront renders a single outcomes-forward per-product
 *  format and no longer reads `dermSurvey.format` — the enum and its
 *  sanitize fallback stay only so stored settings JSON keeps
 *  round-tripping. */
export const DERM_SURVEY_FORMATS = [
  "seal",
  "report",
  "question",
  "tally",
  "strip",
] as const;
export type DermSurveyFormat = (typeof DERM_SURVEY_FORMATS)[number];

/**
 * Display densities for the three v8 proof-library widgets (v8.3,
 * merchant-set, closed enum): "full" (default — the original full-height
 * layout), "compact" (the middle tier — quote and details visible at a
 * fraction of the height) and "ultra" (the v8.2 ultra-compact look —
 * one collapsed row, details on tap). LIVE display-density settings
 * (the v6.5 placement precedent — no draft/preview plumbing). Sanitize
 * coerces non-enum values from the v8.2-legacy `compact` boolean:
 * compact === true → "ultra", anything else → "full" — a shop that
 * enabled ultra-compact on v8.2 keeps ultra behavior.
 */
export const PROOF_DENSITIES = ["full", "compact", "ultra"] as const;
export type ProofDensity = (typeof PROOF_DENSITIES)[number];

/**
 * v8.8: merchant-selected DESIGN for the per-product dermatologist survey
 * widget (LIVE setting — the v6.5/v8.3 no-draft-plumbing convention).
 * "classic" is the v7 outcomes-forward layout and the only design the
 * dermSurvey.compact toggle affects; the three v8.8 designs are inherently
 * mobile-compact while showing the full content: "certificate" (engraved
 * attestation document), "dossier" (clinical lab-report excerpt) and
 * "seal" (notarised seal mark). Same translated strings + per-product
 * numbers in every design — this is presentation only.
 */
export const DERM_SURVEY_DESIGNS = [
  "classic",
  "certificate",
  "dossier",
  "seal",
] as const;
export type DermSurveyDesign = (typeof DERM_SURVEY_DESIGNS)[number];

/**
 * v8.9: per-widget PRODUCT-PAGE placement for the three proof-library
 * widgets (LIVE setting, density convention). Each widget places its own
 * band independently: "below_tabs" (default — after the theme's info-tabs
 * box, the v8.7 position), "above_proof" (immediately above the
 * survey/study/guarantee proof stack, i.e. between the buy area and the
 * stack) and "below_proof" (immediately after that stack, above the info
 * tabs). Home-page rendering is unaffected (end of main content). When the
 * proof stack is absent the JS falls back to the stack's own anchor
 * (before the tabs), then to the below_tabs chain — never nothing.
 */
export const PROOF_PLACEMENTS = [
  "below_tabs",
  "above_proof",
  "below_proof",
] as const;
export type ProofPlacement = (typeof PROOF_PLACEMENTS)[number];

/**
 * v8.10: press band LAYOUT (LIVE setting, the dermSurvey.design pattern).
 * "featured" — the v8 look: grayscale logo strip + ONE large featured
 * quote (rotates on logo tap; density tiers apply). "wall" — every quote
 * visible at once as compact attribution cards (masonry columns on
 * desktop, single tight column on mobile; nothing to tap, nothing hidden;
 * inherently compact, so the density tiers are ignored).
 */
export const PRESS_LAYOUTS = ["featured", "wall"] as const;

/** v8.18 endorsement-badge designs: "classic" = shield + blue link (the
 *  v8.17 look), "choice" = Dermatologists' Choice (laurel + caduceus serif
 *  title, cream panel, bold count, credential chip), "slim" = one-line
 *  conversion bar (3 portraits + "+N" spillover counter), and
 *  "choice_compact" = the Choice look condensed to two tight rows. */
export const BADGE_STYLES = [
  "classic",
  "choice",
  "slim",
  "choice_compact",
] as const;
export type BadgeStyle = (typeof BADGE_STYLES)[number];

/** v8.21 badge link behaviors: "scroll" = smooth-scroll to the wall (the
 *  v8.17 default), "overlay" = open the endorsements overlay (methodology
 *  note + browsable list) without leaving the top of the page. */
export const BADGE_LINK_ACTIONS = ["scroll", "overlay"] as const;
export type BadgeLinkAction = (typeof BADGE_LINK_ACTIONS)[number];
export type PressLayout = (typeof PRESS_LAYOUTS)[number];

/** v8.22 wall designs: "wall" = the v8 masonry wall (density applies),
 *  "panel" = the official fixed-height panel — shield + count headline +
 *  credential chip over a horizontal snap rail of clamped cards and a
 *  View-all pill that opens the overlay (density is ignored: the panel IS
 *  the compact design). */
export const WALL_STYLES = ["wall", "panel"] as const;
export type WallStyle = (typeof WALL_STYLES)[number];

/** v8.22 overlay designs: "list" = the v8.21 browsable endorsement list,
 *  "official" = the explainer overlay — merchant intro text (where the
 *  recommendations come from), FAQ dropdowns, and the full dermatologist
 *  name list WITHOUT the individual quotes. */
export const OVERLAY_STYLES = ["list", "official"] as const;
export type OverlayStyle = (typeof OVERLAY_STYLES)[number];

/**
 * v11: the six checkout-trust display rows, in their DEFAULT display order
 * (the pre-v11 hardcoded render order — a config without rowOrder renders
 * byte-identically to before). The array order IS the default; the extension
 * mirrors this list in extensions/checkout-trust/src/trust-logic.ts
 * (TRUST_ROW_ORDER_DEFAULT — keep the two in sync).
 */
export const CHECKOUT_TRUST_ROWS = [
  "badges",
  "guarantee",
  "customs",
  "tracked",
  "clinical",
  "trustpilot",
] as const;
export type CheckoutTrustRow = (typeof CHECKOUT_TRUST_ROWS)[number];

/**
 * Normalizes a stored/patched trust-row order into a full permutation of
 * CHECKOUT_TRUST_ROWS: unknown entries drop, duplicates keep their first
 * position, missing rows append in default order. Any non-array input
 * yields the default order. Shared by sanitizeSettings (save path) and the
 * Checkout admin page (display of not-yet-sanitized stored blobs).
 */
export function normalizeTrustRowOrder(value: unknown): CheckoutTrustRow[] {
  const out: CheckoutTrustRow[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (
        (CHECKOUT_TRUST_ROWS as readonly string[]).includes(entry as string) &&
        !out.includes(entry as CheckoutTrustRow)
      ) {
        out.push(entry as CheckoutTrustRow);
      }
    }
  }
  for (const key of CHECKOUT_TRUST_ROWS) {
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** The four merchant-selectable delivery-estimate widget formats (v5.9). */
export const DELIVERY_ESTIMATE_FORMATS = [
  "line",
  "range",
  "timeline",
  "box",
] as const;
export type DeliveryEstimateFormat = (typeof DELIVERY_ESTIMATE_FORMATS)[number];

/**
 * Per-country delivery override (v5.9). Every field is OPTIONAL — an entry
 * overrides only what it sets and inherits the rest from the deliveryEstimate
 * defaults. `hidden: true` means the widget is never shown to buyers in that
 * country (e.g. carrier too unpredictable to guarantee anything).
 */
export interface DeliveryCountryOverride {
  minDays?: number;
  maxDays?: number;
  deliveryDays?: number[];
  holidaysEnabled?: boolean;
  hidden?: boolean;
}

/**
 * Per-US-state delivery override (v10). Every field is OPTIONAL — an entry
 * overrides only what it sets and inherits the rest from the resolved US
 * country config (deliveryEstimate defaults + byCountry.US, dispatch
 * defaults + dispatch.byCountry.US). `hidden: true` means the widget is
 * never shown to buyers resolved to that state (checkout included).
 * `cutoff` ("HH:MM" 24h, warehouse time) and `dispatchDays` (ISO weekdays
 * 1=Mon .. 7=Sun) are PARTIAL dispatch overrides — the timezone always
 * inherits (one physical warehouse). `extraHolidays` entries are "MM-DD"
 * (every year) or "YYYY-MM-DD" (one-off).
 */
export interface DeliveryStateOverride {
  minDays?: number;
  maxDays?: number;
  deliveryDays?: number[];
  holidaysEnabled?: boolean;
  hidden?: boolean;
  cutoff?: string;
  dispatchDays?: number[];
  extraHolidays?: string[];
}

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

/**
 * v14 rewards (docs/SPEC-v14-rewards.md §1). A gift option is either ONE
 * specific product variant ("variant") or N sachets drawn from
 * `giftTiers.samplePool` ("samples"). `handle` lets Liquid render live
 * product data via all_products; `variantId` is the GID the storefront adds
 * (may be "" in the shipped defaults until the admin "Load defaults" fills
 * it from the store — the sanitizer keeps handle-only options).
 */
export interface GiftOption {
  /** "variant" = a specific gift product; "samples" = N sachets from samplePool */
  kind: "variant" | "samples";
  variantId: string;
  handle: string;
  /** kind samples: number of sachets (1..6); kind variant: 1 */
  count: number;
}
export interface GiftTier {
  /** Default threshold in EUR (shop currency); per-market amounts live in giftThresholdsByMarket */
  amount: number;
  /** Every slot is granted; within a slot the FIRST available option is used
   *  (fallback order); "choose" mode lets the shopper swap within a slot.
   *  ≤ 3 slots, ≤ 3 options per slot. */
  slots: GiftOption[][];
}
/** A set-savings tier: `count` different eligible products → `pct` % off via code `code`. */
export interface SetSavingsTier {
  count: number;
  pct: number;
  code: string;
}

/**
 * v14.2 ladder presets. `compact` (2/3/4/6 → 5/10/15/20 %) is the shipped
 * default — the store sells 11 full-size products, so a 10-product tier is
 * unreachable for most carts; `extended` (2/3/5/10 → 5/10/20/30 %) is the
 * v14.0 ladder. `custom` means the tier table was hand-edited; the tiers
 * array is always the truth (`ladderPreset` is an admin convenience only).
 *
 * v15: the preset codes are APP-OWNED NEW codes (SET2/SET3/…) — the app
 * never touches a discount it did not create, so it must not reuse the
 * store's historical KIT codes. Those old codes live on untouched and are
 * listed in `yieldToCodes` (the app steps aside when a shopper uses one).
 */
export const LADDER_PRESETS = {
  compact: [
    { count: 2, pct: 5, code: "SET2" },
    { count: 3, pct: 10, code: "SET3" },
    { count: 4, pct: 15, code: "SET4" },
    { count: 6, pct: 20, code: "SET6" },
  ],
  extended: [
    { count: 2, pct: 5, code: "SET2" },
    { count: 3, pct: 10, code: "SET3" },
    { count: 5, pct: 20, code: "SET5" },
    { count: 10, pct: 30, code: "SET10" },
  ],
} satisfies Record<string, SetSavingsTier[]>;
export const LADDER_PRESET_KEYS = ["compact", "extended", "custom"] as const;
export type LadderPreset = (typeof LADDER_PRESET_KEYS)[number];

/**
 * v15 default "step-aside" codes: the store's historical KIT codes. When a
 * shopper uses one of these the app never attaches its own SET code and
 * removes an already-attached one (storefront + checkout). The list is
 * editable in the admin ("Detect my existing KIT codes" suggests entries);
 * the app never creates, updates or deletes these discounts.
 */
export const DEFAULT_YIELD_TO_CODES = ["KIT2", "KIT3", "KIT5", "KIT10"] as const;

const giftVariant = (handle: string): GiftOption => ({
  kind: "variant",
  variantId: "",
  handle,
  count: 1,
});
const giftSamples = (count: number): GiftOption => ({
  kind: "samples",
  variantId: "",
  handle: "",
  count,
});

/**
 * v14.2 gift presets (EUR, cumulative; handles + empty variantIds — the admin
 * "Load defaults" fills GIDs from the store). `value_first` (shipped default)
 * leads with the towel so the €119 headline gift is a value item and the
 * cream (the store's hero SKU) is earned at €200; `cream_first` is the v14.0
 * order. `giftPreset` is informational — the tiers array is always the truth.
 */
export const GIFT_PRESETS = {
  value_first: [
    { amount: 119, slots: [[giftVariant("bamboo-beauty-towel")], [giftSamples(2)]] },
    { amount: 200, slots: [[giftVariant("jawline-contour-tightening-cream")], [giftSamples(2)]] },
    { amount: 350, slots: [[giftVariant("premium-leather-cosmetic-bag")], [giftSamples(3)]] },
  ],
  cream_first: [
    { amount: 119, slots: [[giftVariant("jawline-contour-tightening-cream")], [giftSamples(2)]] },
    { amount: 200, slots: [[giftVariant("bamboo-beauty-towel")], [giftSamples(2)]] },
    { amount: 350, slots: [[giftVariant("premium-leather-cosmetic-bag")], [giftSamples(3)]] },
  ],
} satisfies Record<string, GiftTier[]>;
/** Loadable presets (the "Load defaults" choices); the stored field may also be "custom". */
export const GIFT_PRESET_KEYS = ["value_first", "cream_first"] as const;
export const GIFT_PRESET_VALUES = [...GIFT_PRESET_KEYS, "custom"] as const;
export type GiftPreset = (typeof GIFT_PRESET_VALUES)[number];

/** Closed enums of the v14 gift-tier section (sanitized like the others). */
export const GIFT_CHOICE_MODES = ["auto", "choose"] as const;
export type GiftChoiceMode = (typeof GIFT_CHOICE_MODES)[number];
export const GIFT_SAMPLE_RULES = ["not_in_cart", "rotate", "fixed"] as const;
export type GiftSampleRule = (typeof GIFT_SAMPLE_RULES)[number];

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
    /**
     * v9 trust module V2 rows. Unlike the four legacy show* flags these two
     * ARE FeatureKeys (checkout_customs / checkout_tracked) with their own
     * marketScopes, so each row is per-market targetable. Both ship OFF.
     */
    showCustoms: boolean;
    showTracked: boolean;
    /**
     * v12: per-market product exclusions for the two v9 rows — market
     * handle -> product GIDs ("gid://shopify/Product/<id>"). When the buyer's cart contains
     * a listed product in that market, the row hides (live AND preview
     * draft grants; the preview diagnosis names the reason). The checkout
     * extension reads these from the shop config metafield and matches
     * cart-line product GIDs directly. Dynamic records:
     * replaced wholesale on save (DYNAMIC_RECORD_KEYS).
     */
    customsExcludedByMarket: Record<string, string[]>;
    trackedExcludedByMarket: Record<string, string[]>;
    /**
     * v11 display order of the six trust rows in checkout. Always a full
     * permutation of CHECKOUT_TRUST_ROWS after sanitize (unknown keys drop,
     * duplicates dedupe, missing keys append in default order), so ordering
     * can never hide a row — visibility stays with the show* flags above.
     * LIVE setting (the v6.5 placement precedent): no draft/preview plumbing.
     */
    rowOrder: CheckoutTrustRow[];
  };
  /**
   * PDP trust boosters (SPEC v3). Content lives in per-product metaobjects
   * (Translate & Adapt-native); these sections carry only the master flags
   * and language-neutral numbers.
   */
  clinicalStudy: {
    enabled: boolean;
    /** v8 compact mode — the same study proof in a fraction of the height.
     *  LIVE display-density setting (merchant-set, no draft/preview plumbing
     *  — the v6.5 placement-setting precedent): flipping it changes the live
     *  widget immediately. */
    compact: boolean;
  };
  beforeAfter: {
    enabled: boolean;
    /** v8.2-LEGACY (like dermSurvey.format): the old ultra-compact boolean.
     *  Kept in shape/defaults/sanitize only so stored settings JSON keeps
     *  round-tripping — no UI writes it anymore; `density` (v8.3) is the
     *  live control, and sanitize derives a missing/invalid density from
     *  this flag (true → "ultra"). */
    compact: boolean;
    /** Results-gallery display density (LIVE setting, v8.3): "full" |
     *  "compact" (full-size banner + wrapping chip row + the card rail on
     *  both breakpoints, ~460px) | "ultra" (the v8.2 look: slim one-line
     *  banner, one scrollable chip row, 240px rail). */
    density: ProofDensity;
    /** v8.9 product-page placement (PROOF_PLACEMENTS). */
    placement: ProofPlacement;
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
    /** v8 compact mode — the same guarantee as a single slim band instead of
     *  the full ink panel (the modal keeps the full points). LIVE
     *  display-density setting (merchant-set, no draft/preview plumbing —
     *  the v6.5 placement-setting precedent). */
    compact: boolean;
  };
  dermSurvey: {
    enabled: boolean;
    /** LEGACY (v5.6 and earlier): e.g. 9 (out of `outOf`). Kept for
     *  back-compat; the v5.7 widget no longer displays this ratio. */
    recommend: number;
    outOf: number;
    /** v7-LEGACY: shop-global sample size (total dermatologists surveyed),
     *  e.g. 270. Kept for stored-JSON back-compat only — the v7 storefront
     *  reads per-product numbers from the cellexia_product_survey
     *  metaobject instead. */
    sampleSize: number;
    /** v7-LEGACY: dermatologists who answered "Yes" (of `sampleSize`),
     *  e.g. 248. Same back-compat-only status as `sampleSize` — the v7
     *  widget renders per-product outcome counts, never this number. */
    yesCount: number;
    /** Shop-global DEFAULT methodology text shown in the "How the survey
     *  was conducted" disclosure. "" = the built-in translated explanation.
     *  v7: the per-product metaobject's `methodology` field overrides this
     *  per product when set. v6.11: the tokens {{ total }}, {{ yes }} and
     *  {{ percent }} are substituted with the live survey numbers by the
     *  storefront JS, so a merchant-edited copy of the built-in text keeps
     *  tracking the numbers. */
    methodology: string;
    /** Shop-global DEFAULT verifier (shown on the badge); the per-product
     *  metaobject's `verifier_name` field overrides it per product. */
    verifierName: string;
    /** Shop-global DEFAULT verification link; the per-product metaobject's
     *  `verification_url` field overrides it per product. */
    verificationUrl: string;
    /** v7-LEGACY: merchant-selected display format (v5.8). The v7 widget
     *  renders the outcomes-forward layout in four selectable designs (v8.8); this field (with its enum
     *  and sanitize fallback) is kept only so stored settings JSON keeps
     *  round-tripping. */
    format: DermSurveyFormat;
    /** v8 compact mode — the same survey proof in a fraction of the height
     *  (top outcome inline, the rest behind a disclosure). LIVE
     *  display-density setting (merchant-set, no draft/preview plumbing —
     *  the v6.5 placement-setting precedent). */
    compact: boolean;
    /** v8.8 design (DERM_SURVEY_DESIGNS); compact applies to "classic" only. */
    design: DermSurveyDesign;
  };
  /**
   * "As seen in the press" band (v8). Entry content (publications, quotes,
   * logos) lives in the proof-library database (PressItem rows, served via
   * the app proxy) — this section carries only the master flag.
   */
  press: {
    enabled: boolean;
    /** v8.2-LEGACY (like dermSurvey.format): the old ultra-compact boolean.
     *  Kept in shape/defaults/sanitize only so stored settings JSON keeps
     *  round-tripping — no UI writes it anymore; `density` (v8.3) is the
     *  live control, and sanitize derives a missing/invalid density from
     *  this flag (true → "ultra"). */
    compact: boolean;
    /** Press-band display density (LIVE setting, v8.3): "full" |
     *  "compact" (one-row eyebrow + logo strip with the quote ALWAYS
     *  visible below it, ~130px) | "ultra" (the v8.2 look: one collapsed
     *  row, quote reveals on logo tap). */
    density: ProofDensity;
    /** v8.9 product-page placement (PROOF_PLACEMENTS). */
    placement: ProofPlacement;
    /** v8.10 layout (PRESS_LAYOUTS); density applies to "featured" only. */
    layout: PressLayout;
    /** v8.12: subtle switch cue on the FULL featured layout — a small ink
     *  indicator under the active logo (the learned tab pattern) signals
     *  that the other logos are tappable. Off by default. */
    logoCue: boolean;
    /** v8.15 HOME-page position: "" (default) = end of the home page (the
     *  v8.7 contract), else a home-template SECTION KEY (an entry of
     *  templates/index.json `order`, e.g. "product_slider_FR8JAB") — the
     *  press band inserts itself right AFTER that section's rendered
     *  wrapper. Keys survive theme-editor reordering; a deleted/renamed
     *  key falls back to the end-of-page default. LIVE setting (the v8.9
     *  placement precedent — no draft/preview plumbing). Home page only:
     *  product-page placement stays `placement` above. */
    homeAfterSection: string;
  };
  /**
   * Dermatologist endorsement wall (v8). Entry content lives in the
   * proof-library database (DermEndorsement rows, served via the app proxy)
   * — this section carries only the master flag.
   */
  dermEndorsements: {
    enabled: boolean;
    /** v8.2-LEGACY (like dermSurvey.format): the old ultra-compact boolean.
     *  Kept in shape/defaults/sanitize only so stored settings JSON keeps
     *  round-tripping — no UI writes it anymore; `density` (v8.3) is the
     *  live control, and sanitize derives a missing/invalid density from
     *  this flag (true → "ultra"). */
    compact: boolean;
    /** Endorsement-wall display density (LIVE setting, v8.3): "full" |
     *  "compact" (count headline + inline shown-of over a 280px-card rail,
     *  two-line quotes, ~250px) | "ultra" (the v8.2 look: one composed
     *  head line over a 240px rail). */
    density: ProofDensity;
    /** v8.9 product-page placement (PROOF_PLACEMENTS). */
    placement: ProofPlacement;
    /** v8.17 endorsement BADGE — a compact strip early in the buy box
     *  (product pages only: before the mobile gallery / above the
     *  description) with real endorsement portraits, the dynamic
     *  product+brand endorsement total, and an optional link that scrolls
     *  to the wall. Renders only while the derm_endorsements feature
     *  itself is live (it rides the same island + payload). */
    badgeEnabled: boolean;
    /** Show the badge's "read their assessments" scroll link; false
     *  swaps in the non-link reassurance line (copyBadgeNoLink). */
    badgeShowLink: boolean;
    /** v8.18 badge design (BADGE_STYLES; default "classic"). */
    badgeStyle: BadgeStyle;
    /** v8.21 what the badge link does (BADGE_LINK_ACTIONS; default
     *  "scroll"). */
    badgeLinkAction: BadgeLinkAction;
    /** v8.17 merchant copy overrides — blank = built-in translated
     *  default from the extension locale catalogs. NON-BLANK TEXT IS
     *  SERVED AS ENTERED IN EVERY LANGUAGE (settings copy is never
     *  machine-translated; the methodology precedent). {n} in the two
     *  headline fields is replaced with the live endorsement total. */
    copyEyebrow: string;
    copyHeadline: string;
    copyDescription: string;
    copyBadgeHeadline: string;
    copyBadgeLink: string;
    copyBadgeNoLink: string;
    /** v8.18: the credential-chip text of the Choice designs ("" =
     *  translated "Licensed dermatologists" default; blank catalog string
     *  hides the chip). */
    copyBadgeChip: string;
    /** v8.21: the methodology note at the top of the endorsements overlay
     *  ("" = the section description serves; {n} = the live endorsement
     *  total; DeepL-translated via the copy scope like the others). */
    copyOverlayNote: string;
    /** v8.22 wall design (WALL_STYLES; default "wall"). */
    wallStyle: WallStyle;
    /** v8.22 overlay design (OVERLAY_STYLES; default "list"). */
    overlayStyle: OverlayStyle;
    /** v8.22 OVERLAY-CONTENT COPY. Unlike the v8.17 overrides these have
     *  NON-BLANK ENGLISH DEFAULTS (there is no locale-catalog fallback —
     *  the el.json byte wall forbids new locale keys), so they ship via
     *  the PROXY payload only (never the Liquid island): the proxy
     *  resolves DeepL translation → saved source per field at page 1 and
     *  the storefront merges them like the other copy codes. Blank = the
     *  storefront hides that piece. {n} = the live endorsement total in
     *  copyWallCta / copyOverlayIntro / copyOverlayListTitle. */
    /** The panel wall's View-all pill label (also the overlay trigger). */
    copyWallCta: string;
    /** Official overlay: intro text explaining where the recommendations
     *  come from (blank line = paragraph break). */
    copyOverlayIntro: string;
    /** Official overlay: heading over the FAQ dropdowns. */
    copyOverlayFaqTitle: string;
    /** Official overlay: up to four FAQ dropdowns — a pair renders only
     *  when BOTH its question and answer are non-blank. */
    copyOverlayFaq1Q: string;
    copyOverlayFaq1A: string;
    copyOverlayFaq2Q: string;
    copyOverlayFaq2A: string;
    copyOverlayFaq3Q: string;
    copyOverlayFaq3A: string;
    copyOverlayFaq4Q: string;
    copyOverlayFaq4A: string;
    /** Official overlay: heading over the dermatologist name list. */
    copyOverlayListTitle: string;
  };
  /**
   * Dispatch countdown ("Order within 2h 14m for same-day dispatch").
   * The cutoff is defined in the WAREHOUSE timezone (IANA name); buyers see
   * a single-line live countdown to that cutoff (v5.4: no local-clock
   * suffix), timezone-correct worldwide. Shown only when the next
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
    /**
     * v12: per-market product exclusions — market handle -> product GIDs
     * ("gid://shopify/Product/<id>"). A listed product never shows the countdown on its own
     * product page in that market, and a cart containing one hides the cart
     * line there (live AND preview — the byCountry `hidden` precedent).
     * Dynamic record: replaced wholesale on save (DYNAMIC_RECORD_KEYS
     * "excludedByMarket"); sanitizeExcludedByMarket re-validates entries.
     */
    excludedByMarket: Record<string, string[]>;
  };
  /**
   * PDP delivery estimator + delivery guarantee (v5.9). Renders below/next to
   * the dispatch countdown: the dispatch DATE comes from the `dispatch`
   * schedule above (cutoff + warehouse timezone + dispatch days, including
   * its byCountry override — warehouse config that stays valid even while
   * the dispatch_countdown feature is off), then minDays/maxDays BUSINESS
   * days are counted in the destination country. A day counts only when its
   * ISO weekday is in deliveryDays, it is not one of the global exclusions
   * (Dec 24, Dec 25, Dec 31, Jan 1 — always excluded, not configurable) and,
   * when holidaysEnabled, it is not a known fixed-date public holiday of the
   * destination country (see services/delivery-holidays.server.ts — movable
   * feasts are deliberately excluded from that table). The storefront widget
   * fails closed (renders nothing) on ANY inconsistency: never show a date
   * you cannot stand behind.
   */
  deliveryEstimate: {
    enabled: boolean;
    /** Business days until the earliest delivery (0 = same-day possible). */
    minDays: number;
    /** Business days until the guaranteed latest delivery. */
    maxDays: number;
    /** ISO weekdays deliveries occur (1=Mon .. 7=Sun) — this is how weekends
     *  are excluded; a country doing Saturday delivery adds 6. */
    deliveryDays: number[];
    /** Skip known fixed-date public holidays when counting delivery days. */
    holidaysEnabled: boolean;
    /** Widget presentation on the PRODUCT PAGE: one-liner, date range,
     *  3-step timeline, or guarantee box. All four carry the guarantee
     *  badge. Each surface picks its own format (formatCart /
     *  formatCheckout below). */
    format: DeliveryEstimateFormat;
    /** Widget presentation in the CART DRAWER (v6.0, same enum). */
    formatCart: DeliveryEstimateFormat;
    /** Widget presentation in CHECKOUT (v6.0, same enum). */
    formatCheckout: DeliveryEstimateFormat;
    /** Show on the product page (v6.0 — gated by the master `enabled`,
     *  dispatch precedent). */
    showOnPdp: boolean;
    /** Show in the cart drawer (v6.0). */
    showInCart: boolean;
    /** Show in checkout (v6.0 — the checkout block must also be placed once
     *  in the checkout editor). */
    showInCheckout: boolean;
    /** Per-country (ISO2) overrides; `hidden: true` = never show there. */
    byCountry: Record<string, DeliveryCountryOverride>;
    /**
     * v12: per-market product exclusions — market handle -> product GIDs
     * ("gid://shopify/Product/<id>"). A listed product never shows the delivery promise on its
     * own product page in that market (classic widget AND az_delivery_line),
     * and a cart containing one hides the cart widget and the checkout
     * block there (live AND preview). Dynamic record: replaced wholesale on
     * save (DYNAMIC_RECORD_KEYS "excludedByMarket").
     */
    excludedByMarket: Record<string, string[]>;
    /**
     * United States state-level module (v10). Rides delivery_estimate — no
     * FeatureKey of its own (the boughtOnCards precedent) — and only ever
     * REFINES the US promise: the storefront always renders the US-wide
     * widget first and quietly upgrades it when a state resolves (saved
     * buyer choice, then the self-hosted IP lookup); checkout takes the
     * state ONLY from the typed shipping address. The state layer fails
     * OPEN — any resolution problem degrades to the US-wide promise and
     * must never hide or corrupt the country-level widget (only an explicit
     * per-state `hidden: true` hides).
     */
    usStates: {
      /** Module master switch (default false — safe-by-default). */
      enabled: boolean;
      /** Amazon-style "Deliver to" state selector on the widget (v10
       *  sub-flag convention: default true so the master alone lights it). */
      selector: boolean;
      /**
       * v13 selector sub-flag: until a state resolves, render the selector
       * as the PROMINENT Amazon-style location strip (bordered, with a
       * link-blue "Select your state…" call-to-action line) instead of the
       * quiet one-line link. Once any state resolves — visitor choice or a
       * geo hint — the quiet v10 line returns. Only meaningful while
       * `selector` is on; default true (sub-flag convention). The
       * storefront treats a MISSING key as true (`!== false`) so mirrors
       * saved before v13 light the strip without a re-save.
       */
      selectorPrompt: boolean;
      /** Skip the built-in US federal holiday calendar (fixed dates + the
       *  six computed movable holidays — services/delivery-holidays.server.ts)
       *  when counting delivery days. */
      federalHolidays: boolean;
      /** US-wide extra days off: "MM-DD" (every year) or "YYYY-MM-DD"
       *  (one-off). */
      extraHolidays: string[];
      /** Per-state (USPS code, /^[A-Z]{2}$/) overrides; `hidden: true` =
       *  never show there. */
      byState: Record<string, DeliveryStateOverride>;
    };
  };
  /**
   * Amazon-pattern features (v6.1; eleven flags since the v6.8
   * stock/ships-from split) — independent flags plus the
   * language-neutral "Ships from" warehouse config. We model Amazon's
   * PATTERNS (layout, ordering, color conventions, microcopy structure),
   * never their brand: the storefront templates must not render the words
   * "Amazon"/"Prime"/"Amazon's Choice", the smile mark or their exact badge
   * trade dress. All ten default OFF (safe-by-default).
   */
  amazon: {
    /** az_buy_box — bordered decision card assembled around the theme's buy area. */
    buyBox: boolean;
    /** az_microcopy — terse gray trust rows under the ATC (replaces the PDP trust-badges strip while on). */
    microcopy: boolean;
    /** az_delivery_line — "FREE delivery {date} on orders over {threshold}" + countdown clause. */
    deliveryLine: boolean;
    /** az_stock_line — the green "In Stock" line ONLY (v6.8 split; replaces
     *  the theme's .stock-msg while effective in the buyer's market). */
    stockLine: boolean;
    /**
     * az_ships_from (v6.8, split out of az_stock_line) — the adjacent
     * "Ships from {country}" line, rendered from the warehouse map below
     * via Intl.DisplayNames. Independently toggleable + market-scoped:
     * either line ALONE replaces the theme's .stock-msg while effective;
     * when both are effective both lines render (the pre-split look).
     * Fails closed when no warehouse resolves for the buyer.
     */
    shipsFrom: boolean;
    /** az_bought_count — "{n}+ bought in past month" (per-product merchant data). */
    boughtCount: boolean;
    /**
     * az_bought_count sub-flag (v6.6): also render the bought-in-past-month
     * line on THEME product cards site-wide (collections/home/search, via
     * the cart embed's decorator) under each card's title/price info.
     * Gated by the same az_bought_count feature + market scope, and every
     * count keeps the 45-day freshness rule (the proxy applies the exact
     * PDP epoch math server-side; stale counts never reach a card).
     * Default ON so enabling the bought count covers cards at once.
     */
    boughtOnCards: boolean;
    /** az_bestseller_badge — "#{rank} Bestseller · {category}" pill (per-product merchant data). */
    bestsellerBadge: boolean;
    /**
     * az_bestseller_badge sub-flag (v6.4): also decorate PRODUCT CARDS
     * site-wide — theme cards on collections/home/search (via the cart
     * embed's decorator) and the app's own similar-items/FBT rows — with
     * a compact flag when that product has badge data. Gated by the same
     * az_bestseller_badge feature + market scope; default ON so enabling
     * the badge covers every product reference at once.
     */
    bestsellerOnCards: boolean;
    /** az_fbt — "Frequently bought together" block on the PDP. */
    fbt: boolean;
    /** az_similar_items — horizontal related-items card row under FBT. */
    similarItems: boolean;
    /**
     * Where the FBT section renders on the PDP (v6.5, merchant-set):
     * "tabs_below" (default — below the theme's info-tabs box, above the
     * "Create your ritual" section) or "buybox" (classic v6.1 spot under
     * the buy area). Live setting — previews render at the saved value.
     */
    fbtPlacement: AmazonPlacement;
    /** Where the similar-items row renders (same enum + default as
     *  fbtPlacement; the two widgets are placed independently). */
    similarPlacement: AmazonPlacement;
    /**
     * How the az_ships_from line renders (v6.10, merchant-set): "subtle"
     * (default — the quiet gray microline) or "prominent" (green
     * local-shipping signal with truck icon + bold country). Live setting
     * with a Preview Center draft override (draftConfig.shipsFromFormat).
     */
    shipsFromFormat: ShipsFromFormat;
    /** az_cart_free_line — declarative free-shipping sentence atop the cart booster. */
    cartFreeLine: boolean;
    /** az_cta_count — "Proceed to checkout (N items)" decoration of the theme's button. */
    ctaCount: boolean;
    /**
     * Buyer country ISO2 -> warehouse country ISO2 for the "Ships from" row
     * (e.g. CH -> CH, NL -> NL) — feeds the az_ships_from line AND the
     * az_microcopy "Ships from" row (shared on purpose). The warehouse
     * country NAME renders in the page language via Intl.DisplayNames — no
     * locale strings needed.
     * Dynamic record: replaced wholesale on save (see DYNAMIC_RECORD_KEYS).
     */
    shipsFromByCountry: Record<string, string>;
    /** Fallback warehouse ISO2 for buyers without a map entry ("" = the
     *  "Ships from" row is hidden for unmapped buyers). */
    defaultWarehouse: string;
    /**
     * az_microcopy only: merchant-set plain-text label for the trust
     * microcopy "Ships from {label}" row when NO warehouse country resolves
     * for the buyer (no map entry and no default warehouse). "" = the row is
     * simply hidden for unmapped buyers. Language-neutral merchant text
     * (e.g. a city or warehouse name), trimmed + length-capped on save.
     */
    shipsFromDefault: string;
    /**
     * v12: per-market product exclusions for "Ships from" — market handle
     * -> product GIDs ("gid://shopify/Product/<id>"). On a listed product's page in that
     * market NO ships-from renders: the az_ships_from line AND the
     * az_microcopy ships row (including its shipsFromDefault free-text
     * fallback — the Liquid island suppresses BOTH the `ships` and the
     * `shipsFrom` members). Dynamic record: replaced wholesale on save
     * (DYNAMIC_RECORD_KEYS).
     */
    shipsFromExcludedByMarket: Record<string, string[]>;
  };
  /**
   * v14 rewards (docs/SPEC-v14-rewards.md §1): set savings (SET tiers),
   * gift tiers and the free-shipping guarantee. The Discount Function reads
   * NONE of this directly — metafields.server.ts projects it into the small
   * `$app:cellexia/rewards` shop metafield (numeric ids, short keys).
   */
  rewards: {
    setSavings: {
      /** FeatureKey set_savings master. */
      enabled: boolean;
      /** ≤ 6 tiers, counts strictly increasing, pct 1..90, code
       *  /^[A-Z0-9_-]{2,32}$/ unique. Default LADDER_PRESETS.compact
       *  (2/3/4/6 → 5/10/15/20 %). */
      tiers: SetSavingsTier[];
      /** v14.2: which preset the tier table came from ("custom" once
       *  hand-edited). Informational — `tiers` is always the truth. */
      ladderPreset: LadderPreset;
      /** Subscription lines count + get the saving on the FIRST order only
       *  (Function node: appliesOnSubscription true, recurringCycleLimit 1). */
      includeSubscriptions: boolean;
      /** Per-surface merchandising switches (all default true). */
      surfaces: {
        pdpLine: boolean;
        similarCaption: boolean;
        fbtCaption: boolean;
        cartNudge: boolean;
        crossSellReframe: boolean;
      };
      /** DYNAMIC record: market handle -> product GIDs excluded from
       *  counting + discount in that market (sanitizeExcludedByMarket rule). */
      setSavingsExcludedByMarket: Record<string, string[]>;
      /** "" → Function message "Set savings −{pct}%"; ≤ 60 chars, may contain {pct}. */
      checkoutMessage: string;
      /** v15 "codes we step aside for" (default DEFAULT_YIELD_TO_CODES = the
       *  store's historical KIT codes): when a shopper's cart carries one of
       *  these the app never attaches its own ladder code and removes an
       *  already-attached one (storefront + checkout safety net). ≤ 20
       *  entries, trimmed, upper-cased, /^[A-Z0-9_-]{2,32}$/, deduped; ladder
       *  tier codes are dropped by the sanitizer. The app never creates,
       *  updates or deletes these discounts. */
      yieldToCodes: string[];
      /** v15.1 SERVER-WRITTEN by connectRewardsDiscounts: the ladder tier
       *  codes whose Shopify code is owned by a FOREIGN discount (collision
       *  → foreignCodeMessage). Empty when none. The sanitizer keeps it
       *  (upper/trim/dedupe, ≤ 6, only codes present in the ladder); the
       *  admin shows it read-only; storefront + checkout NEVER attach a
       *  blocked code (that tier is unavailable — the best lower tier whose
       *  code is not blocked wins; none → no code). */
      blockedCodes: string[];
    };
    giftTiers: {
      /** FeatureKey gift_tiers master. */
      enabled: boolean;
      /** A reached tier keeps every lower tier's gifts (default true). */
      cumulative: boolean;
      /** "auto" = first available option per slot; "choose" = shopper may swap. */
      choice: GiftChoiceMode;
      /** Cap on gift lines per cart (1..8, default 6 — v14.1: room for the
       *  variant gift of every reached tier plus samples; the plan orders
       *  variant slots first, then samples, then caps). */
      maxGiftLines: number;
      /** How sample sachets are picked from samplePool. */
      sampleRule: GiftSampleRule;
      /** ≤ 4 tiers, EUR amounts strictly increasing. Default GIFT_PRESETS.value_first. */
      tiers: GiftTier[];
      /** v14.2: which gift preset "Load defaults" applied last ("custom" once
       *  hand-edited). Informational — `tiers` is always the truth. */
      giftPreset: GiftPreset;
      /** DYNAMIC record: market handle -> {amounts (one per tier index),
       *  currencyCode} — explicit per-market amounts in the market currency. */
      giftThresholdsByMarket: Record<string, { amounts: number[]; currencyCode: string }>;
      /** Sachet variants usable as samples: ≤ 9 {variantId, handle} (REWARDS_CAPS.samplePool). */
      samplePool: { variantId: string; handle: string }[];
      /** DYNAMIC record: market handle -> location GIDs that ship that market
       *  (inventory awareness; ≤ 6 locations per market). */
      warehouseByMarket: Record<string, string[]>;
      /** Stock floor: a gift option pauses in a market when available <
       *  max(minUnits, sachet ? 100 : 0). `days` is kept for the future
       *  days-of-cover rule (unused in v14). */
      stockFloor: { days: number; minUnits: number };
      /** Show the meter's free-shipping milestone from freeShipping.byMarket. */
      showShippingMilestone: boolean;
    };
    /** Free-shipping guarantee: an automatic SHIPPING discount run by the
     *  same Function. NOT a FeatureKey — its own MarketScope below. */
    freeShip: {
      enabled: boolean;
      /** Full-size units ≥ minUnits → free standard shipping (0 = rule off). */
      minUnits: number;
      /** Spend ≥ freeShipping.byMarket[market] (explicit entries only, never
       *  the 150 fallback) → free standard shipping. */
      byThreshold: boolean;
      scope: MarketScope;
    };
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
    // v9: the two per-market rows are opt-in — a store upgrading to V2 sees
    // zero new checkout content until it enables them explicitly.
    showCustoms: false,
    showTracked: false,
    customsExcludedByMarket: {},
    trackedExcludedByMarket: {},
    rowOrder: [...CHECKOUT_TRUST_ROWS],
  },
  clinicalStudy: {
    enabled: false,
    compact: false,
  },
  beforeAfter: {
    enabled: false,
    compact: false,
    density: "full",
    placement: "below_tabs",
  },
  batchTransparency: {
    enabled: false,
  },
  emptyBottleGuarantee: {
    enabled: false,
    days: 60,
    container: "jar",
    compact: false,
  },
  dermSurvey: {
    enabled: false,
    recommend: 9,
    outOf: 10,
    sampleSize: 270,
    yesCount: 248,
    methodology: "",
    verifierName: "",
    verificationUrl: "",
    format: "seal",
    compact: false,
    design: "classic",
  },
  press: {
    enabled: false,
    compact: false,
    density: "full",
    placement: "below_tabs",
    layout: "featured",
    logoCue: false,
    homeAfterSection: "",
  },
  dermEndorsements: {
    enabled: false,
    compact: false,
    density: "full",
    placement: "below_tabs",
    badgeEnabled: false,
    badgeShowLink: true,
    badgeStyle: "classic",
    badgeLinkAction: "scroll",
    copyEyebrow: "",
    copyHeadline: "",
    copyDescription: "",
    copyBadgeHeadline: "",
    copyBadgeLink: "",
    copyBadgeNoLink: "",
    copyBadgeChip: "",
    copyOverlayNote: "",
    wallStyle: "wall",
    overlayStyle: "list",
    // v8.22 overlay-content defaults: EDITABLE English starting copy (the
    // admin tells the merchant to review it for accuracy before
    // publishing). Proxy-served + DeepL-translated; never in locale files.
    copyWallCta: "Read all {n} endorsements",
    copyOverlayIntro:
      "Every endorsement in this library comes from a licensed dermatologist who reviewed Cellexia — the formulas, the ingredients and the approach — and shared a written professional assessment in their own words.\n\nRecommendations are published with each dermatologist's name, professional title and country of practice, and are kept on file by Cellexia.",
    copyOverlayFaqTitle: "Common questions",
    copyOverlayFaq1Q: "Who are the dermatologists behind these recommendations?",
    copyOverlayFaq1A:
      "All contributors are licensed dermatologists. Each recommendation is published with the doctor's name, board certification or professional title, and country of practice.",
    copyOverlayFaq2Q: "How were these recommendations collected?",
    copyOverlayFaq2A:
      "Cellexia shared the product and its full ingredient information with practising dermatologists and asked for their independent professional assessment. Their statements are published in their own words.",
    copyOverlayFaq3Q: "Does a recommendation mean the product will suit my skin?",
    copyOverlayFaq3A:
      "No two skins are the same. These assessments describe the formulation approach in general terms — for personal advice about your own skin, please consult your dermatologist or pharmacist.",
    copyOverlayFaq4Q: "",
    copyOverlayFaq4A: "",
    copyOverlayListTitle: "All {n} dermatologists",
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
    excludedByMarket: {},
  },
  deliveryEstimate: {
    enabled: false,
    minDays: 2,
    maxDays: 4,
    deliveryDays: [1, 2, 3, 4, 5],
    holidaysEnabled: true,
    format: "line",
    formatCart: "line",
    formatCheckout: "line",
    showOnPdp: true,
    showInCart: true,
    showInCheckout: true,
    byCountry: {},
    excludedByMarket: {},
    usStates: {
      enabled: false,
      selector: true,
      selectorPrompt: true,
      federalHolidays: true,
      extraHolidays: [],
      byState: {},
    },
  },
  amazon: {
    buyBox: false,
    microcopy: false,
    deliveryLine: false,
    stockLine: false,
    shipsFrom: false,
    boughtCount: false,
    boughtOnCards: true,
    bestsellerBadge: false,
    bestsellerOnCards: true,
    fbt: false,
    similarItems: false,
    fbtPlacement: "tabs_below",
    similarPlacement: "tabs_below",
    shipsFromFormat: "subtle",
    cartFreeLine: false,
    ctaCount: false,
    shipsFromByCountry: {},
    defaultWarehouse: "",
    shipsFromDefault: "",
    shipsFromExcludedByMarket: {},
  },
  // v14 rewards — both masters OFF (safe-by-default); the free-shipping
  // guarantee is opt-in per market. Gift defaults ship with handles + empty
  // variantIds (the admin "Load defaults" fills GIDs from the store).
  // v14.2: ladder = LADDER_PRESETS.compact, gifts = GIFT_PRESETS.value_first.
  rewards: {
    setSavings: {
      enabled: false,
      tiers: structuredClone(LADDER_PRESETS.compact),
      ladderPreset: "compact",
      includeSubscriptions: true,
      surfaces: {
        pdpLine: true,
        similarCaption: true,
        fbtCaption: true,
        cartNudge: true,
        crossSellReframe: true,
      },
      setSavingsExcludedByMarket: {},
      checkoutMessage: "",
      yieldToCodes: [...DEFAULT_YIELD_TO_CODES],
      blockedCodes: [],
    },
    giftTiers: {
      enabled: false,
      cumulative: true,
      choice: "auto",
      maxGiftLines: 6,
      sampleRule: "not_in_cart",
      tiers: structuredClone(GIFT_PRESETS.value_first),
      giftPreset: "value_first",
      giftThresholdsByMarket: {},
      samplePool: [],
      warehouseByMarket: {},
      stockFloor: { days: 3, minUnits: 25 },
      showShippingMilestone: true,
    },
    freeShip: {
      enabled: false,
      minUnits: 2,
      byThreshold: true,
      scope: { mode: "all", markets: [] },
    },
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
const DYNAMIC_RECORD_KEYS = new Set([
  "byMarket",
  "byCountry",
  // amazon.shipsFromByCountry — buyer-ISO2 keyed, default {} (the key-driven
  // merge would silently empty it otherwise; sanitizeSettings re-validates
  // every entry).
  "shipsFromByCountry",
  // deliveryEstimate.usStates.byState — USPS-code keyed, default {} (v10).
  // Matching is by BARE key name anywhere in the tree, so any future record
  // named byState is wholesale-replaced too.
  "byState",
  // v12 per-market product-exclusion records (market-handle keyed, default
  // {}). Four DISTINCT names on purpose: naming one of them after a section
  // ("dispatch") would wholesale-replace that section's merge. Matching is
  // by bare key name, so dispatch.excludedByMarket and
  // deliveryEstimate.excludedByMarket share the first entry.
  "excludedByMarket",
  "customsExcludedByMarket",
  "trackedExcludedByMarket",
  "shipsFromExcludedByMarket",
  // v14 rewards per-market records (market-handle keyed, default {}):
  // rewards.setSavings.setSavingsExcludedByMarket (exclusion rule),
  // rewards.giftTiers.giftThresholdsByMarket ({amounts[], currencyCode}) and
  // rewards.giftTiers.warehouseByMarket (location GID lists). Distinct names
  // on purpose (see the v12 note above).
  "setSavingsExcludedByMarket",
  "giftThresholdsByMarket",
  "warehouseByMarket",
]);

/**
 * v12 shared cleaner for the per-market product-exclusion records
 * (dispatch / deliveryEstimate / checkoutTrust ×2 / amazon). Keys must be
 * Shopify market handles (the freeShipping.byMarket key rule); values
 * become deduped arrays of product GIDs — bare numeric ids self-heal to
 * the GID form (the proxy.proof.tsx coercion precedent). Invalid keys and
 * empty lists are dropped; each market keeps at most 100 products (the
 * settings blob rides two 65,536-char json metafields, and the storefront
 * check is a linear `contains`). All five records share this rule —
 * DYNAMIC_RECORD_KEYS replaces them wholesale on merge, so every entry is
 * re-validated here on every save.
 */
/**
 * v12 market-handle rule shared by the exclusion sanitizer + validator.
 * Shopify market handles are lowercase but NOT ASCII-only ("México" →
 * "méxico"), so the freeShipping.byMarket ASCII slug rule would silently
 * reject real handles the admin card itself offers (review catch). Accept
 * any lowercase, whitespace/quote/angle-free key up to 64 chars, and
 * refuse the prototype-pollution names outright (`clean["__proto__"] = x`
 * on a plain object writes the PROTOTYPE, not an own property).
 */
function isExclusionMarketHandle(handle: string): boolean {
  if (handle.length < 1 || handle.length > 64) return false;
  if (/[\s"'<>\\]/.test(handle)) return false;
  if (handle !== handle.toLowerCase()) return false;
  if (/^(__proto__|constructor|prototype)$/.test(handle)) return false;
  return true;
}

/** v12: per-record ceiling on TOTAL excluded products across all markets.
 *  Five records ride two 65,536-char json metafields next to everything
 *  else (the v10 usStates worst case alone is ~47KB documented), so the
 *  per-market 100-cap is not enough on its own — without a record total, a
 *  legal multi-market save could overflow the metafield and wedge every
 *  later sync (review catch). 150 GIDs ≈ 4.7KB per record worst case. */
const EXCLUSION_RECORD_TOTAL_CAP = 150;

export function sanitizeExcludedByMarket(
  raw: unknown,
): Record<string, string[]> {
  const productGid = /^gid:\/\/shopify\/Product\/[1-9]\d{0,19}$/;
  const numericId = /^\d{1,20}$/;
  const clean: Record<string, string[]> = {};
  if (!isPlainObject(raw)) return clean;
  let total = 0;
  for (const [handle, list] of Object.entries(raw)) {
    if (!isExclusionMarketHandle(handle) || !Array.isArray(list)) continue;
    if (total >= EXCLUSION_RECORD_TOTAL_CAP) break;
    const ids: string[] = [];
    for (const entry of list) {
      let id =
        typeof entry === "string"
          ? entry.trim()
          : typeof entry === "number" && Number.isInteger(entry) && entry > 0
            ? String(entry)
            : "";
      // Numeric self-heal (the proxy.proof.tsx precedent) — leading zeros
      // stripped so "007" can never mint a GID no product ever has.
      if (numericId.test(id)) {
        id = `gid://shopify/Product/${id.replace(/^0+(?=\d)/, "")}`;
      }
      if (productGid.test(id) && !ids.includes(id)) ids.push(id);
      if (ids.length >= 100 || total + ids.length >= EXCLUSION_RECORD_TOTAL_CAP) {
        break;
      }
    }
    if (ids.length > 0) {
      clean[handle] = ids;
      total += ids.length;
    }
  }
  return clean;
}

/**
 * v12 fail-loud validator for an incoming excludedByMarket patch record.
 * The four admin actions call this BEFORE saveSettings so a malformed
 * payload errors loudly instead of being silently trimmed by
 * sanitizeExcludedByMarket (bad market handles / non-product entries are
 * merchant-visible errors here; the bare-numeric-id self-heal is allowed).
 * `undefined`/`null` (field not in the patch) is valid — records are only
 * validated when actually sent.
 */
export function validateExcludedByMarketPatch(
  record: unknown,
  label: string,
): string[] {
  if (record === undefined || record === null) return [];
  if (!isPlainObject(record)) {
    return [`${label}: excluded products must be a map of market handles.`];
  }
  const errors: string[] = [];
  const gidOk = /^gid:\/\/shopify\/Product\/\d{1,20}$/;
  const numericOk = /^\d{1,20}$/;
  let total = 0;
  for (const [handle, list] of Object.entries(record)) {
    if (!isExclusionMarketHandle(handle)) {
      errors.push(`${label}: "${handle}" is not a valid market handle.`);
      continue;
    }
    if (!Array.isArray(list)) {
      errors.push(
        `${label}: the excluded-product list for "${handle}" must be an array.`,
      );
      continue;
    }
    if (list.length > 100) {
      errors.push(
        `${label}: at most 100 excluded products per market ("${handle}").`,
      );
    }
    total += list.length;
    for (const entry of list) {
      const value =
        typeof entry === "number" && Number.isInteger(entry)
          ? String(entry)
          : entry;
      if (
        typeof value !== "string" ||
        !(gidOk.test(value.trim()) || numericOk.test(value.trim()))
      ) {
        errors.push(
          `${label}: "${String(entry)}" is not a product id (market "${handle}").`,
        );
      }
    }
  }
  if (total > EXCLUSION_RECORD_TOTAL_CAP) {
    errors.push(
      `${label}: at most ${EXCLUSION_RECORD_TOTAL_CAP} excluded products in total across markets — remove some before saving (the settings blob rides a size-capped metafield).`,
    );
  }
  return errors;
}

// ---------------------------------------------------------------------------
// v14 rewards sanitizers + fail-loud validators (SPEC v14 §1)
// ---------------------------------------------------------------------------

/** Caps shared by the sanitizers (silent backstop) and the validators (loud). */
export const REWARDS_CAPS = {
  setSavingsTiers: 6,
  giftTiers: 4,
  giftSlots: 3,
  giftOptionsPerSlot: 3,
  samplesPerOption: 6,
  // 9, not 12: the storefront sachet picker renders from an all_products
  // Liquid page capped at 20 unique handles (Shopify's all_products limit),
  // and 11 full-size + 9 sachet handles is exactly that page.
  samplePool: 9,
  thresholdMarkets: 60,
  thresholdAmountMax: 1000000,
  warehouseMarkets: 60,
  warehouseLocations: 6,
  maxGiftLines: 8,
  checkoutMessage: 60,
  /** v15: step-aside codes (rewards.setSavings.yieldToCodes) */
  yieldToCodes: 20,
  /** v15.1: server-written collided ladder codes (≤ one per tier) */
  blockedCodes: 6,
} as const;

const KIT_CODE_PATTERN = /^[A-Z0-9_-]{2,32}$/;
const LOCATION_GID_PATTERN = /^gid:\/\/shopify\/Location\/\d+$/;
const PRODUCT_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-_]{0,254}$/;

/** Numeric variant ids self-heal to the GID form (the exclusion precedent). */
function coerceVariantGid(raw: unknown): string {
  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" && Number.isInteger(raw) && raw > 0
        ? String(raw)
        : "";
  if (/^\d{1,20}$/.test(value)) {
    return `gid://shopify/ProductVariant/${value.replace(/^0+(?=\d)/, "")}`;
  }
  return VARIANT_GID_PATTERN.test(value) ? value : "";
}

/**
 * Set-savings tiers: valid entries only, sorted by count, duplicate counts
 * and duplicate codes dropped (first wins), at most 6. Codes are
 * upper-cased before matching so "kit2" round-trips to "KIT2" (the
 * storefront compares codes case-sensitively against cart.discount_codes,
 * which Shopify reports upper-cased). A non-array falls back to the
 * defaults; an empty array is a real value ("no tiers").
 */
export function sanitizeSetSavingsTiers(raw: unknown): SetSavingsTier[] {
  if (!Array.isArray(raw)) {
    return structuredClone(DEFAULT_SETTINGS.rewards.setSavings.tiers);
  }
  const clean: SetSavingsTier[] = [];
  const seenCounts = new Set<number>();
  const seenCodes = new Set<string>();
  const sorted = raw
    .filter(
      (t): t is Record<string, unknown> =>
        isPlainObject(t) &&
        Number.isInteger(t.count) &&
        (t.count as number) >= 2 &&
        (t.count as number) <= 50 &&
        typeof t.pct === "number" &&
        Number.isFinite(t.pct) &&
        t.pct >= 1 &&
        t.pct <= 90 &&
        typeof t.code === "string",
    )
    .sort((a, b) => (a.count as number) - (b.count as number));
  for (const t of sorted) {
    const code = (t.code as string).trim().toUpperCase();
    const count = t.count as number;
    if (!KIT_CODE_PATTERN.test(code)) continue;
    if (seenCounts.has(count) || seenCodes.has(code)) continue;
    seenCounts.add(count);
    seenCodes.add(code);
    clean.push({ count, pct: Math.round((t.pct as number) * 100) / 100, code });
    if (clean.length >= REWARDS_CAPS.setSavingsTiers) break;
  }
  return clean;
}

/**
 * v15 step-aside codes: trimmed, upper-cased, /^[A-Z0-9_-]{2,32}$/, deduped,
 * at most REWARDS_CAPS.yieldToCodes (20); any code that is one of the ladder
 * tier codes is DROPPED (the app can never step aside for its own code). A
 * non-array falls back to the defaults; an empty array is a real value
 * ("never step aside").
 */
export function sanitizeYieldToCodes(
  raw: unknown,
  ladder: readonly SetSavingsTier[] = [],
): string[] {
  const ladderCodes = new Set(
    ladder.map((t) => (typeof t?.code === "string" ? t.code.trim().toUpperCase() : "")),
  );
  const source: unknown[] = Array.isArray(raw) ? raw : [...DEFAULT_YIELD_TO_CODES];
  const out: string[] = [];
  for (const entry of source) {
    if (typeof entry !== "string") continue;
    const code = entry.trim().toUpperCase();
    if (!KIT_CODE_PATTERN.test(code)) continue;
    if (ladderCodes.has(code) || out.includes(code)) continue;
    out.push(code);
    if (out.length >= REWARDS_CAPS.yieldToCodes) break;
  }
  return out;
}

/**
 * v15.1 blocked codes (SERVER-WRITTEN by connectRewardsDiscounts — the ladder
 * codes whose Shopify code is owned by a foreign discount): trimmed,
 * upper-cased, deduped, at most REWARDS_CAPS.blockedCodes (6), and ONLY codes
 * that are present in the (sanitized) ladder — a code that left the tier
 * table is forgotten. Anything else → [] (nothing blocked).
 */
export function sanitizeBlockedCodes(
  raw: unknown,
  ladder: readonly SetSavingsTier[] = [],
): string[] {
  if (!Array.isArray(raw)) return [];
  const ladderCodes = new Set(
    ladder.map((t) => (typeof t?.code === "string" ? t.code.trim().toUpperCase() : "")),
  );
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const code = entry.trim().toUpperCase();
    if (!code || !ladderCodes.has(code) || out.includes(code)) continue;
    out.push(code);
    if (out.length >= REWARDS_CAPS.blockedCodes) break;
  }
  return out;
}

/** v14.2: which ladder preset a (sanitized) tier table equals — "custom" otherwise. */
export function inferLadderPreset(tiers: SetSavingsTier[]): LadderPreset {
  const key = JSON.stringify(tiers);
  if (key === JSON.stringify(LADDER_PRESETS.compact)) return "compact";
  if (key === JSON.stringify(LADDER_PRESETS.extended)) return "extended";
  return "custom";
}

/** v14.2: which gift preset a tier table equals by amounts + slot shape
 *  (variant handles / sample counts; variantIds ignored — "Load defaults"
 *  fills them from the store) — "custom" otherwise. */
export function inferGiftPreset(tiers: GiftTier[]): GiftPreset {
  const shape = (list: GiftTier[]) =>
    JSON.stringify(
      list.map((t) => [
        t.amount,
        t.slots.map((slot) =>
          slot.map((o) => (o.kind === "variant" ? `v:${o.handle}` : `s:${o.count}`)),
        ),
      ]),
    );
  const key = shape(tiers);
  for (const preset of GIFT_PRESET_KEYS) {
    if (key === shape(GIFT_PRESETS[preset])) return preset;
  }
  return "custom";
}

function sanitizeGiftOption(raw: unknown): GiftOption | null {
  if (!isPlainObject(raw)) return null;
  if (raw.kind === "samples") {
    const count = raw.count;
    if (
      !Number.isInteger(count) ||
      (count as number) < 1 ||
      (count as number) > REWARDS_CAPS.samplesPerOption
    ) {
      return null;
    }
    return { kind: "samples", variantId: "", handle: "", count: count as number };
  }
  if (raw.kind === "variant") {
    const variantId = coerceVariantGid(raw.variantId);
    const handle =
      typeof raw.handle === "string" && PRODUCT_HANDLE_PATTERN.test(raw.handle)
        ? raw.handle
        : "";
    // A variant option needs at least a handle (Liquid all_products lookup);
    // the shipped defaults carry handle-only options until "Load defaults".
    if (!handle && !variantId) return null;
    return { kind: "variant", variantId, handle, count: 1 };
  }
  return null;
}

/**
 * Gift tiers: ≤ 4 tiers sorted by EUR amount (duplicates dropped), each with
 * ≤ 3 non-empty slots of ≤ 3 valid options; a tier left without slots is
 * dropped. A non-array falls back to the defaults.
 */
export function sanitizeGiftTiers(raw: unknown): GiftTier[] {
  if (!Array.isArray(raw)) {
    return structuredClone(DEFAULT_SETTINGS.rewards.giftTiers.tiers);
  }
  const clean: GiftTier[] = [];
  const seen = new Set<number>();
  const sorted = raw
    .filter(
      (t): t is Record<string, unknown> =>
        isPlainObject(t) &&
        typeof t.amount === "number" &&
        Number.isFinite(t.amount) &&
        t.amount >= 0 &&
        t.amount <= REWARDS_CAPS.thresholdAmountMax,
    )
    .sort((a, b) => (a.amount as number) - (b.amount as number));
  for (const t of sorted) {
    const amount = Math.round((t.amount as number) * 100) / 100;
    if (seen.has(amount)) continue;
    const slots: GiftOption[][] = [];
    for (const slot of Array.isArray(t.slots) ? t.slots : []) {
      if (!Array.isArray(slot)) continue;
      const options: GiftOption[] = [];
      for (const option of slot) {
        const clean = sanitizeGiftOption(option);
        if (clean) options.push(clean);
        if (options.length >= REWARDS_CAPS.giftOptionsPerSlot) break;
      }
      if (options.length > 0) slots.push(options);
      if (slots.length >= REWARDS_CAPS.giftSlots) break;
    }
    if (slots.length === 0) continue;
    seen.add(amount);
    clean.push({ amount, slots });
    if (clean.length >= REWARDS_CAPS.giftTiers) break;
  }
  return clean;
}

/** giftThresholdsByMarket: ≤ 60 markets; ISO-4217 currency; amounts (≤ 8)
 *  must ALL be finite, > 0, ≤ 1,000,000 and strictly increasing tier by tier,
 *  otherwise the whole market entry drops (a 0 or a non-increasing amount is
 *  never kept — the Function/storefront would treat it as "reached at 0"). */
export function sanitizeGiftThresholdsByMarket(
  raw: unknown,
): Record<string, { amounts: number[]; currencyCode: string }> {
  const clean: Record<string, { amounts: number[]; currencyCode: string }> = {};
  if (!isPlainObject(raw)) return clean;
  const currencyKey = /^[A-Z]{3}$/;
  let markets = 0;
  for (const [handle, entry] of Object.entries(raw)) {
    if (markets >= REWARDS_CAPS.thresholdMarkets) break;
    if (!isExclusionMarketHandle(handle) || !isPlainObject(entry)) continue;
    const currencyCode =
      typeof entry.currencyCode === "string"
        ? entry.currencyCode.toUpperCase()
        : "";
    if (!currencyKey.test(currencyCode)) continue;
    const rawAmounts = Array.isArray(entry.amounts) ? entry.amounts.slice(0, 8) : [];
    if (rawAmounts.length === 0) continue;
    const amounts: number[] = [];
    let valid = true;
    for (const a of rawAmounts) {
      const rounded =
        typeof a === "number" && Number.isFinite(a) ? Math.round(a * 100) / 100 : NaN;
      if (
        !(rounded > 0) ||
        rounded > REWARDS_CAPS.thresholdAmountMax ||
        (amounts.length > 0 && rounded <= amounts[amounts.length - 1])
      ) {
        valid = false;
        break;
      }
      amounts.push(rounded);
    }
    if (!valid) continue;
    clean[handle] = { amounts, currencyCode };
    markets += 1;
  }
  return clean;
}

/** warehouseByMarket: ≤ 60 markets × ≤ 6 Location GIDs (deduped). */
export function sanitizeWarehouseByMarket(
  raw: unknown,
): Record<string, string[]> {
  const clean: Record<string, string[]> = {};
  if (!isPlainObject(raw)) return clean;
  let markets = 0;
  for (const [handle, list] of Object.entries(raw)) {
    if (markets >= REWARDS_CAPS.warehouseMarkets) break;
    if (!isExclusionMarketHandle(handle) || !Array.isArray(list)) continue;
    const ids: string[] = [];
    for (const entry of list) {
      let id =
        typeof entry === "string"
          ? entry.trim()
          : typeof entry === "number" && Number.isInteger(entry) && entry > 0
            ? String(entry)
            : "";
      if (/^\d{1,20}$/.test(id)) {
        id = `gid://shopify/Location/${id.replace(/^0+(?=\d)/, "")}`;
      }
      if (LOCATION_GID_PATTERN.test(id) && !ids.includes(id)) ids.push(id);
      if (ids.length >= REWARDS_CAPS.warehouseLocations) break;
    }
    if (ids.length > 0) {
      clean[handle] = ids;
      markets += 1;
    }
  }
  return clean;
}

/** samplePool: ≤ REWARDS_CAPS.samplePool (9) {variantId GID, handle} entries, deduped by variant. */
export function sanitizeSamplePool(
  raw: unknown,
): { variantId: string; handle: string }[] {
  if (!Array.isArray(raw)) return [];
  const clean: { variantId: string; handle: string }[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const variantId = coerceVariantGid(entry.variantId);
    const handle =
      typeof entry.handle === "string" && PRODUCT_HANDLE_PATTERN.test(entry.handle)
        ? entry.handle
        : "";
    if (!variantId || !handle || seen.has(variantId)) continue;
    seen.add(variantId);
    clean.push({ variantId, handle });
    if (clean.length >= REWARDS_CAPS.samplePool) break;
  }
  return clean;
}

function sanitizeMarketScope(raw: unknown): MarketScope {
  const marketHandlePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
  if (
    isPlainObject(raw) &&
    raw.mode === "selected" &&
    Array.isArray(raw.markets)
  ) {
    return {
      mode: "selected",
      markets: [
        ...new Set(
          raw.markets.filter(
            (handle): handle is string =>
              typeof handle === "string" && marketHandlePattern.test(handle),
          ),
        ),
      ].slice(0, 50),
    };
  }
  return structuredClone(ALL_MARKETS_SCOPE);
}

/**
 * v14 fail-loud validator for a `rewards.setSavings` PATCH (partial section
 * as sent by the admin action) — the validateExcludedByMarketPatch contract:
 * `undefined`/`null` fields are simply not validated; anything present must
 * be well-formed or the save errors loudly instead of being silently trimmed
 * by sanitizeSettings.
 */
export function validateSetSavingsPatch(patch: unknown): string[] {
  if (patch === undefined || patch === null) return [];
  if (!isPlainObject(patch)) return ["Set savings: settings must be an object."];
  const errors: string[] = [];
  const label = "Set savings";
  if (patch.tiers !== undefined && patch.tiers !== null) {
    if (!Array.isArray(patch.tiers)) {
      errors.push(`${label}: tiers must be a list.`);
    } else {
      if (patch.tiers.length > REWARDS_CAPS.setSavingsTiers) {
        errors.push(`${label}: at most ${REWARDS_CAPS.setSavingsTiers} tiers.`);
      }
      let lastCount = 1;
      const codes = new Set<string>();
      patch.tiers.forEach((t, i) => {
        const n = i + 1;
        if (!isPlainObject(t)) {
          errors.push(`${label}: tier ${n} is malformed.`);
          return;
        }
        if (!Number.isInteger(t.count) || (t.count as number) < 2 || (t.count as number) > 50) {
          errors.push(`${label}: tier ${n} needs a whole product count between 2 and 50.`);
        } else if ((t.count as number) <= lastCount) {
          errors.push(`${label}: tier ${n} product count must be higher than the previous tier's.`);
        } else {
          lastCount = t.count as number;
        }
        if (typeof t.pct !== "number" || !Number.isFinite(t.pct) || t.pct < 1 || t.pct > 90) {
          errors.push(`${label}: tier ${n} percentage must be between 1 and 90.`);
        }
        const code = typeof t.code === "string" ? t.code.trim().toUpperCase() : "";
        if (!KIT_CODE_PATTERN.test(code)) {
          errors.push(`${label}: tier ${n} code must be 2–32 characters (A–Z, 0–9, _ or -).`);
        } else if (codes.has(code)) {
          errors.push(`${label}: code "${code}" is used twice.`);
        } else {
          codes.add(code);
        }
      });
    }
  }
  if (
    patch.checkoutMessage !== undefined &&
    patch.checkoutMessage !== null &&
    (typeof patch.checkoutMessage !== "string" ||
      Array.from(patch.checkoutMessage).length > REWARDS_CAPS.checkoutMessage)
  ) {
    errors.push(`${label}: the checkout message must be text of at most ${REWARDS_CAPS.checkoutMessage} characters.`);
  }
  for (const field of ["enabled", "includeSubscriptions"] as const) {
    if (patch[field] !== undefined && patch[field] !== null && typeof patch[field] !== "boolean") {
      errors.push(`${label}: "${field}" must be true or false.`);
    }
  }
  // v15 step-aside codes: a list of well-formed codes (≤ 20); a code that is
  // also a tier code of the SAME patch is a contradiction (the sanitizer
  // would silently drop it — fail loud instead so the admin shows it).
  if (patch.yieldToCodes !== undefined && patch.yieldToCodes !== null) {
    if (!Array.isArray(patch.yieldToCodes)) {
      errors.push(`${label}: step-aside codes must be a list.`);
    } else {
      if (patch.yieldToCodes.length > REWARDS_CAPS.yieldToCodes) {
        errors.push(`${label}: at most ${REWARDS_CAPS.yieldToCodes} step-aside codes.`);
      }
      const tierCodes = new Set<string>(
        Array.isArray(patch.tiers)
          ? patch.tiers
              .map((t) => (isPlainObject(t) && typeof t.code === "string" ? t.code.trim().toUpperCase() : ""))
              .filter(Boolean)
          : [],
      );
      patch.yieldToCodes.forEach((raw, i) => {
        const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
        if (!KIT_CODE_PATTERN.test(code)) {
          errors.push(`${label}: step-aside code ${i + 1} must be 2–32 characters (A–Z, 0–9, _ or -).`);
        } else if (tierCodes.has(code)) {
          errors.push(`${label}: "${code}" is one of your own discount codes — it cannot also be a step-aside code.`);
        }
      });
    }
  }
  // v15.1 blockedCodes is server-written (Connect) and read-only in the admin;
  // a patch that echoes it back is tolerated as long as it is a list of
  // strings (the sanitizer re-derives it against the ladder anyway).
  if (patch.blockedCodes !== undefined && patch.blockedCodes !== null) {
    if (!Array.isArray(patch.blockedCodes) || patch.blockedCodes.some((c) => typeof c !== "string")) {
      errors.push(`${label}: blocked codes must be a list of codes.`);
    }
  }
  if (patch.surfaces !== undefined && patch.surfaces !== null) {
    if (!isPlainObject(patch.surfaces)) {
      errors.push(`${label}: surfaces must be an object of switches.`);
    } else {
      for (const [k, v] of Object.entries(patch.surfaces)) {
        if (typeof v !== "boolean") errors.push(`${label}: surface "${k}" must be true or false.`);
      }
    }
  }
  errors.push(
    ...validateExcludedByMarketPatch(
      patch.setSavingsExcludedByMarket,
      "Set savings exclusions",
    ),
  );
  return errors;
}

/** v14 fail-loud validator for a `rewards.giftTiers` PATCH (same contract). */
export function validateGiftTiersPatch(patch: unknown): string[] {
  if (patch === undefined || patch === null) return [];
  if (!isPlainObject(patch)) return ["Gift tiers: settings must be an object."];
  const errors: string[] = [];
  const label = "Gift tiers";
  let tierCount: number | null = null;
  if (patch.tiers !== undefined && patch.tiers !== null) {
    if (!Array.isArray(patch.tiers)) {
      errors.push(`${label}: tiers must be a list.`);
    } else {
      tierCount = patch.tiers.length;
      if (patch.tiers.length > REWARDS_CAPS.giftTiers) {
        errors.push(`${label}: at most ${REWARDS_CAPS.giftTiers} tiers.`);
      }
      let last = -1;
      patch.tiers.forEach((t, i) => {
        const n = i + 1;
        if (!isPlainObject(t)) {
          errors.push(`${label}: tier ${n} is malformed.`);
          return;
        }
        if (
          typeof t.amount !== "number" ||
          !Number.isFinite(t.amount) ||
          t.amount < 0 ||
          t.amount > REWARDS_CAPS.thresholdAmountMax
        ) {
          errors.push(`${label}: tier ${n} amount must be between 0 and ${REWARDS_CAPS.thresholdAmountMax}.`);
        } else if (t.amount <= last) {
          errors.push(`${label}: tier ${n} amount must be higher than the previous tier's.`);
        } else {
          last = t.amount;
        }
        if (!Array.isArray(t.slots) || t.slots.length === 0) {
          errors.push(`${label}: tier ${n} needs at least one gift slot.`);
          return;
        }
        if (t.slots.length > REWARDS_CAPS.giftSlots) {
          errors.push(`${label}: tier ${n} has more than ${REWARDS_CAPS.giftSlots} slots.`);
        }
        t.slots.forEach((slot, j) => {
          if (!Array.isArray(slot) || slot.length === 0) {
            errors.push(`${label}: tier ${n} slot ${j + 1} needs at least one option.`);
            return;
          }
          if (slot.length > REWARDS_CAPS.giftOptionsPerSlot) {
            errors.push(`${label}: tier ${n} slot ${j + 1} has more than ${REWARDS_CAPS.giftOptionsPerSlot} options.`);
          }
          slot.forEach((option, k) => {
            const where = `tier ${n} slot ${j + 1} option ${k + 1}`;
            if (!isPlainObject(option)) {
              errors.push(`${label}: ${where} is malformed.`);
              return;
            }
            if (option.kind === "samples") {
              if (
                !Number.isInteger(option.count) ||
                (option.count as number) < 1 ||
                (option.count as number) > REWARDS_CAPS.samplesPerOption
              ) {
                errors.push(`${label}: ${where} sample count must be 1–${REWARDS_CAPS.samplesPerOption}.`);
              }
            } else if (option.kind === "variant") {
              const vid = coerceVariantGid(option.variantId);
              const handle =
                typeof option.handle === "string" &&
                PRODUCT_HANDLE_PATTERN.test(option.handle)
                  ? option.handle
                  : "";
              if (option.variantId && !vid) {
                errors.push(`${label}: ${where} has an invalid variant id.`);
              }
              if (!vid && !handle) {
                errors.push(`${label}: ${where} needs a product (variant or handle).`);
              }
            } else {
              errors.push(`${label}: ${where} kind must be "variant" or "samples".`);
            }
          });
        });
      });
    }
  }
  if (patch.giftThresholdsByMarket !== undefined && patch.giftThresholdsByMarket !== null) {
    if (!isPlainObject(patch.giftThresholdsByMarket)) {
      errors.push(`${label}: per-market amounts must be a map of market handles.`);
    } else {
      const entries = Object.entries(patch.giftThresholdsByMarket);
      if (entries.length > REWARDS_CAPS.thresholdMarkets) {
        errors.push(`${label}: at most ${REWARDS_CAPS.thresholdMarkets} markets with explicit amounts.`);
      }
      for (const [handle, entry] of entries) {
        if (!isExclusionMarketHandle(handle)) {
          errors.push(`${label}: "${handle}" is not a valid market handle.`);
          continue;
        }
        if (!isPlainObject(entry) || !Array.isArray(entry.amounts)) {
          errors.push(`${label}: amounts for "${handle}" must be {amounts, currencyCode}.`);
          continue;
        }
        if (typeof entry.currencyCode !== "string" || !/^[A-Za-z]{3}$/.test(entry.currencyCode)) {
          errors.push(`${label}: "${handle}" needs a 3-letter currency code.`);
        }
        if (tierCount !== null && entry.amounts.length !== tierCount) {
          errors.push(`${label}: "${handle}" needs exactly one amount per tier (${tierCount}).`);
        }
        let previous = 0;
        for (const a of entry.amounts) {
          if (typeof a !== "number" || !Number.isFinite(a) || a <= 0 || a > REWARDS_CAPS.thresholdAmountMax) {
            errors.push(`${label}: "${handle}" amount "${String(a)}" must be greater than 0 and at most ${REWARDS_CAPS.thresholdAmountMax}.`);
            break;
          }
          if (a <= previous) {
            errors.push(`${label}: "${handle}" amounts must increase tier by tier.`);
            break;
          }
          previous = a;
        }
      }
    }
  }
  if (patch.warehouseByMarket !== undefined && patch.warehouseByMarket !== null) {
    if (!isPlainObject(patch.warehouseByMarket)) {
      errors.push(`${label}: the warehouse map must be a map of market handles.`);
    } else {
      const entries = Object.entries(patch.warehouseByMarket);
      if (entries.length > REWARDS_CAPS.warehouseMarkets) {
        errors.push(`${label}: at most ${REWARDS_CAPS.warehouseMarkets} markets in the warehouse map.`);
      }
      for (const [handle, list] of entries) {
        if (!isExclusionMarketHandle(handle)) {
          errors.push(`${label}: "${handle}" is not a valid market handle (warehouse map).`);
          continue;
        }
        if (!Array.isArray(list)) {
          errors.push(`${label}: locations for "${handle}" must be a list.`);
          continue;
        }
        if (list.length > REWARDS_CAPS.warehouseLocations) {
          errors.push(`${label}: at most ${REWARDS_CAPS.warehouseLocations} locations per market ("${handle}").`);
        }
        for (const id of list) {
          const value = typeof id === "number" && Number.isInteger(id) ? String(id) : id;
          if (
            typeof value !== "string" ||
            !(LOCATION_GID_PATTERN.test(value.trim()) || /^\d{1,20}$/.test(value.trim()))
          ) {
            errors.push(`${label}: "${String(id)}" is not a location id (market "${handle}").`);
          }
        }
      }
    }
  }
  if (patch.samplePool !== undefined && patch.samplePool !== null) {
    if (!Array.isArray(patch.samplePool)) {
      errors.push(`${label}: the sample pool must be a list.`);
    } else {
      if (patch.samplePool.length > REWARDS_CAPS.samplePool) {
        errors.push(`${label}: at most ${REWARDS_CAPS.samplePool} sachets in the sample pool.`);
      }
      for (const entry of patch.samplePool) {
        if (
          !isPlainObject(entry) ||
          !coerceVariantGid(entry.variantId) ||
          typeof entry.handle !== "string" ||
          !PRODUCT_HANDLE_PATTERN.test(entry.handle)
        ) {
          errors.push(`${label}: every sample-pool entry needs a variant id and a product handle.`);
          break;
        }
      }
    }
  }
  if (
    patch.maxGiftLines !== undefined &&
    patch.maxGiftLines !== null &&
    (!Number.isInteger(patch.maxGiftLines) ||
      (patch.maxGiftLines as number) < 1 ||
      (patch.maxGiftLines as number) > REWARDS_CAPS.maxGiftLines)
  ) {
    errors.push(`${label}: max gift lines must be a whole number between 1 and ${REWARDS_CAPS.maxGiftLines}.`);
  }
  if (
    patch.choice !== undefined &&
    patch.choice !== null &&
    !(GIFT_CHOICE_MODES as readonly unknown[]).includes(patch.choice)
  ) {
    errors.push(`${label}: choice must be "auto" or "choose".`);
  }
  if (
    patch.sampleRule !== undefined &&
    patch.sampleRule !== null &&
    !(GIFT_SAMPLE_RULES as readonly unknown[]).includes(patch.sampleRule)
  ) {
    errors.push(`${label}: sample rule must be "not_in_cart", "rotate" or "fixed".`);
  }
  if (patch.stockFloor !== undefined && patch.stockFloor !== null) {
    if (!isPlainObject(patch.stockFloor)) {
      errors.push(`${label}: stock floor must be {days, minUnits}.`);
    } else {
      const sf = patch.stockFloor;
      if (sf.days !== undefined && (!Number.isInteger(sf.days) || (sf.days as number) < 0 || (sf.days as number) > 60)) {
        errors.push(`${label}: stock floor days must be a whole number 0–60.`);
      }
      if (
        sf.minUnits !== undefined &&
        (!Number.isInteger(sf.minUnits) || (sf.minUnits as number) < 0 || (sf.minUnits as number) > 100000)
      ) {
        errors.push(`${label}: stock floor minimum units must be a whole number 0–100000.`);
      }
    }
  }
  for (const field of ["enabled", "cumulative", "showShippingMilestone"] as const) {
    if (patch[field] !== undefined && patch[field] !== null && typeof patch[field] !== "boolean") {
      errors.push(`${label}: "${field}" must be true or false.`);
    }
  }
  return errors;
}

/** v14 fail-loud validator for a `rewards.freeShip` PATCH (same contract). */
export function validateFreeShipPatch(patch: unknown): string[] {
  if (patch === undefined || patch === null) return [];
  if (!isPlainObject(patch)) return ["Free-shipping guarantee: settings must be an object."];
  const errors: string[] = [];
  const label = "Free-shipping guarantee";
  for (const field of ["enabled", "byThreshold"] as const) {
    if (patch[field] !== undefined && patch[field] !== null && typeof patch[field] !== "boolean") {
      errors.push(`${label}: "${field}" must be true or false.`);
    }
  }
  if (
    patch.minUnits !== undefined &&
    patch.minUnits !== null &&
    (!Number.isInteger(patch.minUnits) || (patch.minUnits as number) < 0 || (patch.minUnits as number) > 50)
  ) {
    errors.push(`${label}: minimum units must be a whole number between 0 and 50 (0 = rule off).`);
  }
  if (patch.scope !== undefined && patch.scope !== null) {
    const scope = patch.scope;
    if (
      !isPlainObject(scope) ||
      (scope.mode !== "all" && scope.mode !== "selected") ||
      (scope.mode === "selected" &&
        (!Array.isArray(scope.markets) ||
          scope.markets.some(
            (h) => typeof h !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(h),
          )))
    ) {
      errors.push(`${label}: market scope must be {mode: "all" | "selected", markets: [handles]}.`);
    }
  }
  return errors;
}

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

/**
 * v8.3 load-path back-compat twin of the sanitize coercion: mergeSettings
 * fills a MISSING key from the defaults, so stored JSON that predates the
 * density enum (v8.2 and earlier) merges to density "full" — silently
 * dropping the ultra-compact look for shops whose only signal is the
 * legacy `compact: true` boolean. When the RAW stored JSON carries no
 * valid density for a proof-library section, derive it from the legacy
 * boolean — compact === true → "ultra", else "full" (the exact sanitize
 * rule, applied where old JSON actually surfaces). The next save persists
 * the derived value, after which this is a no-op.
 */
export function coerceLegacyProofDensities(
  settings: BoosterSettings,
  raw: unknown,
): BoosterSettings {
  if (!isPlainObject(raw)) return settings;
  const sections = ["press", "dermEndorsements", "beforeAfter"] as const;
  for (const key of sections) {
    const rawSection = (raw as Record<string, unknown>)[key];
    const stored = isPlainObject(rawSection) ? rawSection.density : undefined;
    if (PROOF_DENSITIES.includes(stored as ProofDensity)) continue;
    settings[key].density = settings[key].compact === true ? "ultra" : "full";
  }
  return settings;
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

/** https:// URL with no whitespace, quotes, angle brackets or backslashes —
 *  these values are rendered into href attributes (escaped there too;
 *  defense in depth). */
const SAFE_HTTPS_URL = /^https:\/\/[^\s"'<>\\]+$/;

function isSafeHttpsUrl(value: unknown): value is string {
  return typeof value === "string" && SAFE_HTTPS_URL.test(value);
}

function sanitizeHttpsUrl(
  value: string,
  previous: string,
  fallback: string,
): string {
  if (isSafeHttpsUrl(value)) return value;
  return isSafeHttpsUrl(previous) ? previous : fallback;
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

  // v11: rowOrder is always persisted as a full permutation of
  // CHECKOUT_TRUST_ROWS — ordering can never hide a row.
  next.checkoutTrust.rowOrder = normalizeTrustRowOrder(
    next.checkoutTrust.rowOrder,
  );
  // v12: per-market product exclusions for the customs/tracked rows.
  next.checkoutTrust.customsExcludedByMarket = sanitizeExcludedByMarket(
    next.checkoutTrust.customsExcludedByMarket,
  );
  next.checkoutTrust.trackedExcludedByMarket = sanitizeExcludedByMarket(
    next.checkoutTrust.trackedExcludedByMarket,
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
    // v12: per-market product exclusions (wholesale-replaced record).
    d.excludedByMarket = sanitizeExcludedByMarket(d.excludedByMarket);
  }

  {
    const iso2 = /^[A-Z]{2}$/;
    const de = next.deliveryEstimate;
    /** Ints only; delivery-day counting must never see fractions. */
    const intInRange = (
      value: unknown,
      min: number,
      max: number,
    ): number | null =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= min &&
      value <= max
        ? value
        : null;
    const cleanDeliveryDays = (raw: unknown): number[] =>
      Array.isArray(raw)
        ? [
            ...new Set(
              raw.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7),
            ),
          ].sort() as number[]
        : [];
    de.minDays =
      intInRange(de.minDays, 0, 30) ?? DEFAULT_SETTINGS.deliveryEstimate.minDays;
    de.maxDays =
      intInRange(de.maxDays, 1, 30) ?? DEFAULT_SETTINGS.deliveryEstimate.maxDays;
    // The guarantee date must never precede the earliest estimate.
    de.maxDays = Math.max(de.maxDays, Math.max(1, de.minDays));
    const days = cleanDeliveryDays(de.deliveryDays);
    de.deliveryDays =
      days.length > 0 ? days : [...DEFAULT_SETTINGS.deliveryEstimate.deliveryDays];
    if (typeof de.holidaysEnabled !== "boolean") {
      de.holidaysEnabled = DEFAULT_SETTINGS.deliveryEstimate.holidaysEnabled;
    }
    if (
      !DELIVERY_ESTIMATE_FORMATS.includes(de.format as DeliveryEstimateFormat)
    ) {
      de.format = DEFAULT_SETTINGS.deliveryEstimate.format;
    }
    if (
      !DELIVERY_ESTIMATE_FORMATS.includes(
        de.formatCart as DeliveryEstimateFormat,
      )
    ) {
      de.formatCart = DEFAULT_SETTINGS.deliveryEstimate.formatCart;
    }
    if (
      !DELIVERY_ESTIMATE_FORMATS.includes(
        de.formatCheckout as DeliveryEstimateFormat,
      )
    ) {
      de.formatCheckout = DEFAULT_SETTINGS.deliveryEstimate.formatCheckout;
    }
    if (typeof de.showOnPdp !== "boolean") {
      de.showOnPdp = DEFAULT_SETTINGS.deliveryEstimate.showOnPdp;
    }
    if (typeof de.showInCart !== "boolean") {
      de.showInCart = DEFAULT_SETTINGS.deliveryEstimate.showInCart;
    }
    if (typeof de.showInCheckout !== "boolean") {
      de.showInCheckout = DEFAULT_SETTINGS.deliveryEstimate.showInCheckout;
    }
    // byCountry is a DYNAMIC_RECORD_KEYS record (replaced wholesale by the
    // merge) — every entry is re-validated field by field; entries are
    // PARTIAL by design (override only what they set). Invalid fields are
    // dropped, entries with nothing valid left are removed.
    const cleanByCountry: Record<string, DeliveryCountryOverride> = {};
    for (const [country, entry] of Object.entries(de.byCountry ?? {})) {
      const code = country.toUpperCase();
      if (!iso2.test(code) || !isPlainObject(entry)) continue;
      const clean: DeliveryCountryOverride = {};
      const minDays = intInRange(entry.minDays, 0, 30);
      if (minDays !== null) clean.minDays = minDays;
      let maxDays = intInRange(entry.maxDays, 1, 30);
      if (maxDays !== null) {
        // Within-entry consistency; cross-inheritance inconsistencies (e.g.
        // an override minDays above the inherited default maxDays) fail
        // closed to hidden in the storefront instead of being rewritten.
        if (clean.minDays !== undefined) {
          maxDays = Math.max(maxDays, Math.max(1, clean.minDays));
        }
        clean.maxDays = maxDays;
      }
      const entryDays = cleanDeliveryDays(entry.deliveryDays);
      if (Array.isArray(entry.deliveryDays) && entryDays.length > 0) {
        clean.deliveryDays = entryDays;
      }
      if (typeof entry.holidaysEnabled === "boolean") {
        clean.holidaysEnabled = entry.holidaysEnabled;
      }
      if (typeof entry.hidden === "boolean") clean.hidden = entry.hidden;
      if (Object.keys(clean).length > 0) cleanByCountry[code] = clean;
    }
    de.byCountry = cleanByCountry;
    // v12: per-market product exclusions (wholesale-replaced record).
    de.excludedByMarket = sanitizeExcludedByMarket(de.excludedByMarket);
    // v10 US state module (rides delivery_estimate — no FeatureKey).
    const us = de.usStates;
    const cutoffOk = /^([01]\d|2[0-3]):[0-5]\d$/;
    // Extra days off: "MM-DD" (every year) or "YYYY-MM-DD" (one-off).
    // Invalid entries are dropped, valid ones kept verbatim — an empty
    // array is a real value ("no extra days off"), never rewritten. Counts
    // are capped AFTER filtering (60 US-wide, 40 per state): the settings
    // blob rides two json metafields capped at 65,536 chars on
    // ApiVersion.October25, and 60 + 51×40 dates keeps the worst-case blob
    // near ~47 KB. validateDeliveryPatch fails LOUD at the same numbers;
    // this slice is the silent backstop for payloads that bypass the form.
    const extraDateOk = /^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
    const cleanExtraDates = (raw: unknown, max: number): string[] =>
      Array.isArray(raw)
        ? raw
            .filter(
              (d): d is string => typeof d === "string" && extraDateOk.test(d),
            )
            .slice(0, max)
        : [];
    if (typeof us.enabled !== "boolean") {
      us.enabled = DEFAULT_SETTINGS.deliveryEstimate.usStates.enabled;
    }
    if (typeof us.selector !== "boolean") {
      us.selector = DEFAULT_SETTINGS.deliveryEstimate.usStates.selector;
    }
    if (typeof us.selectorPrompt !== "boolean") {
      us.selectorPrompt =
        DEFAULT_SETTINGS.deliveryEstimate.usStates.selectorPrompt;
    }
    if (typeof us.federalHolidays !== "boolean") {
      us.federalHolidays =
        DEFAULT_SETTINGS.deliveryEstimate.usStates.federalHolidays;
    }
    us.extraHolidays = cleanExtraDates(us.extraHolidays, 60);
    // byState is a DYNAMIC_RECORD_KEYS record (replaced wholesale by the
    // merge) — every entry re-validated field by field; entries are PARTIAL
    // by design, like byCountry above. Keys are any uppercase two-letter
    // code, NOT checked against a state list — unknown codes are harmless
    // because the storefront and checkout only consult codes they resolve.
    const cleanByState: Record<string, DeliveryStateOverride> = {};
    for (const [state, entry] of Object.entries(us.byState ?? {})) {
      const code = state.toUpperCase();
      if (!iso2.test(code) || !isPlainObject(entry)) continue;
      const clean: DeliveryStateOverride = {};
      const minDays = intInRange(entry.minDays, 0, 30);
      if (minDays !== null) clean.minDays = minDays;
      let maxDays = intInRange(entry.maxDays, 1, 30);
      if (maxDays !== null) {
        // Within-entry consistency only. Cross-inheritance inconsistencies
        // (e.g. a state minDays above the inherited US-wide maxDays) are
        // NOT rewritten here, and — unlike the country layer, which fails
        // closed to hidden — the resolvers IGNORE a state entry that merges
        // into an invalid window and keep the US-wide promise: the state
        // layer fails OPEN by doctrine, it must never hide the widget.
        if (clean.minDays !== undefined) {
          maxDays = Math.max(maxDays, Math.max(1, clean.minDays));
        }
        clean.maxDays = maxDays;
      }
      const entryDays = cleanDeliveryDays(entry.deliveryDays);
      if (Array.isArray(entry.deliveryDays) && entryDays.length > 0) {
        clean.deliveryDays = entryDays;
      }
      if (typeof entry.holidaysEnabled === "boolean") {
        clean.holidaysEnabled = entry.holidaysEnabled;
      }
      if (typeof entry.hidden === "boolean") clean.hidden = entry.hidden;
      if (typeof entry.cutoff === "string" && cutoffOk.test(entry.cutoff)) {
        clean.cutoff = entry.cutoff;
      }
      const dispatchDays = cleanDeliveryDays(entry.dispatchDays);
      if (Array.isArray(entry.dispatchDays) && dispatchDays.length > 0) {
        clean.dispatchDays = dispatchDays;
      }
      if (Array.isArray(entry.extraHolidays)) {
        clean.extraHolidays = cleanExtraDates(entry.extraHolidays, 40);
      }
      if (Object.keys(clean).length > 0) cleanByState[code] = clean;
    }
    us.byState = cleanByState;
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
  // v8 compact display-density flags — anything non-boolean falls back to
  // the safe default (full-height widgets).
  if (typeof next.clinicalStudy.compact !== "boolean") {
    next.clinicalStudy.compact = DEFAULT_SETTINGS.clinicalStudy.compact;
  }
  if (typeof next.emptyBottleGuarantee.compact !== "boolean") {
    next.emptyBottleGuarantee.compact =
      DEFAULT_SETTINGS.emptyBottleGuarantee.compact;
  }
  if (
    !DERM_SURVEY_DESIGNS.includes(next.dermSurvey.design as DermSurveyDesign)
  ) {
    next.dermSurvey.design = DEFAULT_SETTINGS.dermSurvey.design;
  }
  if (typeof next.dermSurvey.compact !== "boolean") {
    next.dermSurvey.compact = DEFAULT_SETTINGS.dermSurvey.compact;
  }
  // v8.2-LEGACY ultra-compact flags for the three proof-library widgets —
  // same typeof-boolean discipline as the v8 trio above. Kept ONLY for
  // stored-JSON back-compat + the density coercion below; no UI writes
  // them anymore.
  if (typeof next.press.compact !== "boolean") {
    next.press.compact = DEFAULT_SETTINGS.press.compact;
  }
  if (typeof next.dermEndorsements.compact !== "boolean") {
    next.dermEndorsements.compact = DEFAULT_SETTINGS.dermEndorsements.compact;
  }
  if (typeof next.beforeAfter.compact !== "boolean") {
    next.beforeAfter.compact = DEFAULT_SETTINGS.beforeAfter.compact;
  }
  // v8.3 proof-library display densities — closed enum with BACK-COMPAT
  // COERCION: a missing/invalid density is derived from the (already
  // sanitized) v8.2 legacy boolean, so a shop that enabled ultra-compact
  // on v8.2 keeps ultra behavior the moment v8.3 deploys.
  for (const section of ["press", "dermEndorsements", "beforeAfter"] as const) {
    if (
      !PROOF_PLACEMENTS.includes(next[section].placement as ProofPlacement)
    ) {
      next[section].placement = DEFAULT_SETTINGS[section].placement;
    }
  }
  if (!PRESS_LAYOUTS.includes(next.press.layout as PressLayout)) {
    next.press.layout = DEFAULT_SETTINGS.press.layout;
  }
  if (typeof next.press.logoCue !== "boolean") {
    next.press.logoCue = DEFAULT_SETTINGS.press.logoCue;
  }
  // v8.15 press home anchor: a theme section key ("" = end-of-page
  // default). Section keys are theme-editor-generated [A-Za-z0-9_-] slugs;
  // anything else (wrong type, injection-shaped, oversized) coerces to the
  // default rather than reaching the storefront island.
  if (
    typeof next.press.homeAfterSection !== "string" ||
    !/^[A-Za-z0-9_-]{0,64}$/.test(next.press.homeAfterSection)
  ) {
    next.press.homeAfterSection = DEFAULT_SETTINGS.press.homeAfterSection;
  }
  if (!PROOF_DENSITIES.includes(next.press.density as ProofDensity)) {
    next.press.density = next.press.compact === true ? "ultra" : "full";
  }
  if (
    !PROOF_DENSITIES.includes(next.dermEndorsements.density as ProofDensity)
  ) {
    next.dermEndorsements.density =
      next.dermEndorsements.compact === true ? "ultra" : "full";
  }
  if (!PROOF_DENSITIES.includes(next.beforeAfter.density as ProofDensity)) {
    next.beforeAfter.density =
      next.beforeAfter.compact === true ? "ultra" : "full";
  }
  // v8.17 endorsement badge flags + merchant copy overrides. Booleans keep
  // the typeof discipline; copy fields keep the methodology discipline
  // (typeof-string guard, trim, hard cap) and the two headline fields get
  // the same brace-variant canonicalization as {name} — {N}/{ n }/{{n}}
  // self-heal to the exact "{n}" token the storefront substitutes.
  if (typeof next.dermEndorsements.badgeEnabled !== "boolean") {
    next.dermEndorsements.badgeEnabled =
      DEFAULT_SETTINGS.dermEndorsements.badgeEnabled;
  }
  if (typeof next.dermEndorsements.badgeShowLink !== "boolean") {
    next.dermEndorsements.badgeShowLink =
      DEFAULT_SETTINGS.dermEndorsements.badgeShowLink;
  }
  if (
    !BADGE_STYLES.includes(next.dermEndorsements.badgeStyle as BadgeStyle)
  ) {
    next.dermEndorsements.badgeStyle =
      DEFAULT_SETTINGS.dermEndorsements.badgeStyle;
  }
  if (
    !BADGE_LINK_ACTIONS.includes(
      next.dermEndorsements.badgeLinkAction as BadgeLinkAction,
    )
  ) {
    next.dermEndorsements.badgeLinkAction =
      DEFAULT_SETTINGS.dermEndorsements.badgeLinkAction;
  }
  if (
    !WALL_STYLES.includes(next.dermEndorsements.wallStyle as WallStyle)
  ) {
    next.dermEndorsements.wallStyle =
      DEFAULT_SETTINGS.dermEndorsements.wallStyle;
  }
  if (
    !OVERLAY_STYLES.includes(
      next.dermEndorsements.overlayStyle as OverlayStyle,
    )
  ) {
    next.dermEndorsements.overlayStyle =
      DEFAULT_SETTINGS.dermEndorsements.overlayStyle;
  }
  {
    const endo = next.dermEndorsements;
    const copyCaps = [
      ["copyEyebrow", 120],
      ["copyHeadline", 200],
      ["copyDescription", 1000],
      ["copyBadgeHeadline", 160],
      ["copyBadgeLink", 120],
      ["copyBadgeNoLink", 120],
      ["copyBadgeChip", 120],
      ["copyOverlayNote", 1000],
      // v8.22 overlay-content fields (non-strings become "" = hidden, NOT
      // the default — a merchant who blanks a piece means to hide it).
      ["copyWallCta", 120],
      ["copyOverlayIntro", 1500],
      ["copyOverlayFaqTitle", 120],
      ["copyOverlayFaq1Q", 200],
      ["copyOverlayFaq1A", 1000],
      ["copyOverlayFaq2Q", 200],
      ["copyOverlayFaq2A", 1000],
      ["copyOverlayFaq3Q", 200],
      ["copyOverlayFaq3A", 1000],
      ["copyOverlayFaq4Q", 200],
      ["copyOverlayFaq4A", 1000],
      ["copyOverlayListTitle", 160],
    ] as const;
    for (const [field, cap] of copyCaps) {
      if (typeof endo[field] !== "string") {
        endo[field] = "";
      } else {
        let value = endo[field];
        if (
          field === "copyHeadline" ||
          field === "copyBadgeHeadline" ||
          field === "copyOverlayNote" ||
          field === "copyWallCta" ||
          field === "copyOverlayIntro" ||
          field === "copyOverlayListTitle"
        ) {
          value = value.replace(/\{\{?\s*n\s*\}?\}/gi, "{n}");
        }
        // Cap on CODE POINTS, not UTF-16 units: a plain slice can split a
        // surrogate pair (emoji at the boundary) and the resulting lone
        // surrogate makes the metafield JSON unparseable on Shopify's
        // side — the whole settings save would fail.
        endo[field] = Array.from(value.trim()).slice(0, cap).join("");
      }
    }
  }
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
  // Deliberately NOT clamped against sampleSize: the storefront widget fails
  // closed (renders nothing) when yesCount > sampleSize, and the admin shows
  // an inline warning — silently rewriting the number would hide the problem.
  next.dermSurvey.yesCount = Math.round(
    clampNumber(
      next.dermSurvey.yesCount,
      0,
      100000,
      DEFAULT_SETTINGS.dermSurvey.yesCount,
    ),
  );
  if (typeof next.dermSurvey.methodology !== "string") {
    next.dermSurvey.methodology = "";
  } else {
    // v8.13b: same {name}-variant canonicalization as pdp-content cleanText —
    // the storefront Liquid substitutes the exact lowercase token only.
    next.dermSurvey.methodology = next.dermSurvey.methodology
      .replace(/\{\{?\s*name\s*\}?\}/gi, "{name}")
      .trim()
      .slice(0, 4000);
  }
  if (typeof next.dermSurvey.verifierName !== "string") {
    next.dermSurvey.verifierName = "";
  } else {
    next.dermSurvey.verifierName = next.dermSurvey.verifierName.slice(0, 120);
  }
  if (
    next.dermSurvey.verificationUrl !== "" &&
    !isSafeHttpsUrl(next.dermSurvey.verificationUrl)
  ) {
    next.dermSurvey.verificationUrl = isSafeHttpsUrl(
      previous.dermSurvey?.verificationUrl,
    )
      ? previous.dermSurvey.verificationUrl
      : "";
  }
  if (
    !DERM_SURVEY_FORMATS.includes(
      next.dermSurvey.format as DermSurveyFormat,
    )
  ) {
    next.dermSurvey.format = DEFAULT_SETTINGS.dermSurvey.format;
  }

  {
    const iso2 = /^[A-Z]{2}$/;
    const az = next.amazon;
    // The ten flags are independent booleans — anything non-boolean falls
    // back to the safe default (OFF).
    for (const field of AMAZON_FLAG_FIELDS) {
      if (typeof az[field] !== "boolean") {
        az[field] = DEFAULT_SETTINGS.amazon[field];
      }
    }
    // bestsellerOnCards is a SUB-flag of az_bestseller_badge (not a
    // FeatureKey, so it stays out of AMAZON_FLAG_FIELDS/flip snapshots):
    // anything non-boolean falls back to the default (ON — the badge
    // feature master still gates every card flag).
    if (typeof az.bestsellerOnCards !== "boolean") {
      az.bestsellerOnCards = DEFAULT_SETTINGS.amazon.bestsellerOnCards;
    }
    // boughtOnCards is the same kind of SUB-flag for az_bought_count
    // (v6.6, not a FeatureKey — stays out of AMAZON_FLAG_FIELDS/flip
    // snapshots): anything non-boolean falls back to the default (ON —
    // the bought-count feature master still gates every card line).
    if (typeof az.boughtOnCards !== "boolean") {
      az.boughtOnCards = DEFAULT_SETTINGS.amazon.boughtOnCards;
    }
    // v6.5 per-widget PDP placement enums — anything outside
    // AMAZON_PLACEMENTS falls back to the default ("tabs_below", the
    // merchant-requested spot). Sanitized independently per widget.
    for (const field of ["fbtPlacement", "similarPlacement"] as const) {
      if (!AMAZON_PLACEMENTS.includes(az[field] as AmazonPlacement)) {
        az[field] = DEFAULT_SETTINGS.amazon[field];
      }
    }
    // v6.10 ships-from display format — anything outside SHIPS_FROM_FORMATS
    // falls back to the default ("subtle", the pre-v6.10 look).
    if (!SHIPS_FROM_FORMATS.includes(az.shipsFromFormat as ShipsFromFormat)) {
      az.shipsFromFormat = DEFAULT_SETTINGS.amazon.shipsFromFormat;
    }
    // shipsFromByCountry is a DYNAMIC_RECORD_KEYS record (replaced wholesale
    // by the merge) — keep only ISO2 -> ISO2 entries, uppercased.
    const cleanMap: Record<string, string> = {};
    for (const [buyer, warehouse] of Object.entries(
      az.shipsFromByCountry ?? {},
    )) {
      const buyerCode = buyer.toUpperCase();
      const warehouseCode =
        typeof warehouse === "string" ? warehouse.toUpperCase() : "";
      if (iso2.test(buyerCode) && iso2.test(warehouseCode)) {
        cleanMap[buyerCode] = warehouseCode;
      }
    }
    az.shipsFromByCountry = cleanMap;
    // v12: per-market product exclusions for "Ships from" (wholesale-replaced).
    az.shipsFromExcludedByMarket = sanitizeExcludedByMarket(
      az.shipsFromExcludedByMarket,
    );
    const fallback =
      typeof az.defaultWarehouse === "string"
        ? az.defaultWarehouse.toUpperCase()
        : "";
    az.defaultWarehouse = iso2.test(fallback) ? fallback : "";
    // az_microcopy "Ships from" fallback label: plain merchant text,
    // trimmed and length-capped ("" = row hidden for unmapped buyers).
    az.shipsFromDefault =
      typeof az.shipsFromDefault === "string"
        ? az.shipsFromDefault.trim().slice(0, 80)
        : "";
  }

  // v14 rewards (SPEC v14 §1) — silent backstop for payloads that bypass the
  // admin form (the validate*Patch trio fails loud at the same numbers).
  {
    const D = DEFAULT_SETTINGS.rewards;
    const ss = next.rewards.setSavings;
    if (typeof ss.enabled !== "boolean") ss.enabled = D.setSavings.enabled;
    ss.tiers = sanitizeSetSavingsTiers(ss.tiers);
    // v14.2: closed enum; an unknown/missing value (pre-v14.2 rows) is
    // inferred from the tier table so a stored extended ladder is never
    // labelled "compact" (the admin keeps it consistent from then on).
    if (!LADDER_PRESET_KEYS.includes(ss.ladderPreset as LadderPreset)) {
      ss.ladderPreset = inferLadderPreset(ss.tiers);
    }
    if (typeof ss.includeSubscriptions !== "boolean") {
      ss.includeSubscriptions = D.setSavings.includeSubscriptions;
    }
    if (!isPlainObject(ss.surfaces)) {
      ss.surfaces = structuredClone(D.setSavings.surfaces);
    }
    for (const field of Object.keys(D.setSavings.surfaces) as (keyof typeof D.setSavings.surfaces)[]) {
      if (typeof ss.surfaces[field] !== "boolean") {
        ss.surfaces[field] = D.setSavings.surfaces[field];
      }
    }
    ss.setSavingsExcludedByMarket = sanitizeExcludedByMarket(
      ss.setSavingsExcludedByMarket,
    );
    // Code-point cap (the endorsement-copy precedent) so a boundary emoji
    // can never make the Function's message or the metafield JSON invalid.
    ss.checkoutMessage =
      typeof ss.checkoutMessage === "string"
        ? Array.from(ss.checkoutMessage.trim())
            .slice(0, REWARDS_CAPS.checkoutMessage)
            .join("")
        : "";
    // v15: step-aside codes — well-formed, deduped, capped, and never one of
    // the sanitized ladder codes. Pre-v15 rows may still carry the retired
    // keepLegacyCodes / aliasCodes keys (mergeSettings ignores unknown keys;
    // a spread patch could keep them) — dropped silently here.
    ss.yieldToCodes = sanitizeYieldToCodes(ss.yieldToCodes, ss.tiers);
    // v15.1: server-written collision list — only ladder codes survive.
    ss.blockedCodes = sanitizeBlockedCodes(ss.blockedCodes, ss.tiers);
    delete (ss as Record<string, unknown>).keepLegacyCodes;
    delete (ss as Record<string, unknown>).aliasCodes;

    const gt = next.rewards.giftTiers;
    if (typeof gt.enabled !== "boolean") gt.enabled = D.giftTiers.enabled;
    if (typeof gt.cumulative !== "boolean") gt.cumulative = D.giftTiers.cumulative;
    if (!GIFT_CHOICE_MODES.includes(gt.choice as GiftChoiceMode)) {
      gt.choice = D.giftTiers.choice;
    }
    gt.maxGiftLines = Math.round(
      clampNumber(gt.maxGiftLines, 1, REWARDS_CAPS.maxGiftLines, D.giftTiers.maxGiftLines),
    );
    if (!GIFT_SAMPLE_RULES.includes(gt.sampleRule as GiftSampleRule)) {
      gt.sampleRule = D.giftTiers.sampleRule;
    }
    gt.tiers = sanitizeGiftTiers(gt.tiers);
    if (!GIFT_PRESET_VALUES.includes(gt.giftPreset as GiftPreset)) {
      gt.giftPreset = inferGiftPreset(gt.tiers);
    }
    gt.giftThresholdsByMarket = sanitizeGiftThresholdsByMarket(
      gt.giftThresholdsByMarket,
    );
    gt.samplePool = sanitizeSamplePool(gt.samplePool);
    gt.warehouseByMarket = sanitizeWarehouseByMarket(gt.warehouseByMarket);
    if (!isPlainObject(gt.stockFloor)) {
      gt.stockFloor = structuredClone(D.giftTiers.stockFloor);
    }
    gt.stockFloor = {
      days: Math.round(clampNumber(gt.stockFloor.days, 0, 60, D.giftTiers.stockFloor.days)),
      minUnits: Math.round(
        clampNumber(gt.stockFloor.minUnits, 0, 100000, D.giftTiers.stockFloor.minUnits),
      ),
    };
    if (typeof gt.showShippingMilestone !== "boolean") {
      gt.showShippingMilestone = D.giftTiers.showShippingMilestone;
    }

    const fs = next.rewards.freeShip;
    // v15.3: the free-shipping guarantee is RETIRED — never on, whatever
    // the payload says (Shopify rejects the SHIPPING-class app discount with
    // combinable settings, and the merchant asked to drop the feature).
    fs.enabled = false;
    fs.minUnits = Math.round(clampNumber(fs.minUnits, 0, 50, D.freeShip.minUnits));
    if (typeof fs.byThreshold !== "boolean") fs.byThreshold = D.freeShip.byThreshold;
    fs.scope = sanitizeMarketScope(fs.scope);
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
  // v9 trust rows: cart-style master+sub-flag semantics — enabling a row
  // raises the module master so `set(true)` always resolves live (the
  // flip-test contract). siblings stay [] deliberately: the sibling
  // machinery in applyFlipForMarket is cartUpsell-specific.
  checkout_customs: {
    label: "Customs-free delivery line",
    get: (s) => s.checkoutTrust.enabled && s.checkoutTrust.showCustoms,
    set: (s, on) => {
      if (on) s.checkoutTrust.enabled = true;
      s.checkoutTrust.showCustoms = on;
    },
    siblings: [],
  },
  checkout_tracked: {
    label: "Tracked delivery line",
    get: (s) => s.checkoutTrust.enabled && s.checkoutTrust.showTracked,
    set: (s, on) => {
      if (on) s.checkoutTrust.enabled = true;
      s.checkoutTrust.showTracked = on;
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
    label: "Risk-free trial guarantee",
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
  press: {
    label: "As seen in the press",
    get: (s) => s.press.enabled,
    set: (s, on) => {
      s.press.enabled = on;
    },
    siblings: [],
  },
  derm_endorsements: {
    label: "Dermatologist endorsements",
    get: (s) => s.dermEndorsements.enabled,
    set: (s, on) => {
      s.dermEndorsements.enabled = on;
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
  delivery_estimate: {
    label: "Delivery guarantee",
    get: (s) => s.deliveryEstimate.enabled,
    set: (s, on) => {
      s.deliveryEstimate.enabled = on;
    },
    siblings: [],
  },
  az_buy_box: {
    label: "Buy-box decision card",
    get: (s) => s.amazon.buyBox,
    set: (s, on) => {
      s.amazon.buyBox = on;
    },
    siblings: [],
  },
  az_microcopy: {
    label: "Trust microcopy rows",
    get: (s) => s.amazon.microcopy,
    set: (s, on) => {
      s.amazon.microcopy = on;
    },
    siblings: [],
  },
  az_delivery_line: {
    label: "Compound delivery line",
    get: (s) => s.amazon.deliveryLine,
    set: (s, on) => {
      s.amazon.deliveryLine = on;
    },
    siblings: [],
  },
  az_stock_line: {
    label: "In-stock line",
    get: (s) => s.amazon.stockLine,
    set: (s, on) => {
      s.amazon.stockLine = on;
    },
    siblings: [],
  },
  az_ships_from: {
    label: "Ships from",
    get: (s) => s.amazon.shipsFrom,
    set: (s, on) => {
      s.amazon.shipsFrom = on;
    },
    siblings: [],
  },
  az_bought_count: {
    label: "Bought-in-past-month count",
    get: (s) => s.amazon.boughtCount,
    set: (s, on) => {
      s.amazon.boughtCount = on;
    },
    siblings: [],
  },
  az_bestseller_badge: {
    label: "Bestseller badge",
    get: (s) => s.amazon.bestsellerBadge,
    set: (s, on) => {
      s.amazon.bestsellerBadge = on;
    },
    siblings: [],
  },
  az_fbt: {
    label: "Frequently bought together",
    get: (s) => s.amazon.fbt,
    set: (s, on) => {
      s.amazon.fbt = on;
    },
    siblings: [],
  },
  az_similar_items: {
    label: "Similar items row",
    get: (s) => s.amazon.similarItems,
    set: (s, on) => {
      s.amazon.similarItems = on;
    },
    siblings: [],
  },
  az_cart_free_line: {
    label: "Cart free-shipping sentence",
    get: (s) => s.amazon.cartFreeLine,
    set: (s, on) => {
      s.amazon.cartFreeLine = on;
    },
    siblings: [],
  },
  az_cta_count: {
    label: "Checkout button item count",
    get: (s) => s.amazon.ctaCount,
    set: (s, on) => {
      s.amazon.ctaCount = on;
    },
    siblings: [],
  },
  // v14 rewards: each sub-section owns its master (no shared switch).
  set_savings: {
    label: "Set savings",
    get: (s) => s.rewards.setSavings.enabled,
    set: (s, on) => {
      s.rewards.setSavings.enabled = on;
    },
    siblings: [],
  },
  gift_tiers: {
    label: "Free gifts",
    get: (s) => s.rewards.giftTiers.enabled,
    set: (s, on) => {
      s.rewards.giftTiers.enabled = on;
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
  // v9: the checkout-trust rows render INSIDE the module, so the extension
  // gates them on BOTH the module's scope and the row's own scope
  // (Checkout.tsx: moduleLive && row gate). Mirror that here so reach
  // labels, the experiment wizard and the preview agree with the storefront.
  if (FEATURE_RAW_FIELD[key].kind === "checkoutTrust") {
    const moduleScope = scopeFor(settings, "checkout_trust");
    if (
      moduleScope.mode !== "all" &&
      !moduleScope.markets.includes(marketHandle)
    ) {
      return false;
    }
  }
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

/**
 * v9 checkout-trust row sub-flags stored raw in a FlagsSnapshot.
 * Deliberately EXCLUDES the four legacy show* rows (guarantee/trustpilot/
 * clinical/badges) — those are not FeatureKeys and must stay out of flip
 * snapshots (the bestsellerOnCards precedent).
 */
export const CHECKOUT_TRUST_SUB_FLAG_FIELDS = [
  "showCustoms",
  "showTracked",
] as const;
export type CheckoutTrustSubFlagField =
  (typeof CHECKOUT_TRUST_SUB_FLAG_FIELDS)[number];

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
  "press",
  "dermEndorsements",
  "cartCrossSell",
  "dispatch",
  "deliveryEstimate",
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
  | { kind: "amazon"; field: AmazonFlagField }
  | { kind: "checkoutTrust"; field: CheckoutTrustSubFlagField }
  // v14: rewards.<field>.enabled (setSavings / giftTiers).
  | { kind: "rewards"; field: RewardsFlagField }
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
  checkout_customs: { kind: "checkoutTrust", field: "showCustoms" },
  checkout_tracked: { kind: "checkoutTrust", field: "showTracked" },
  clinical_study: { kind: "section", field: "clinicalStudy" },
  verified_before_after: { kind: "section", field: "beforeAfter" },
  batch_transparency: { kind: "section", field: "batchTransparency" },
  empty_bottle_guarantee: { kind: "section", field: "emptyBottleGuarantee" },
  derm_survey: { kind: "section", field: "dermSurvey" },
  press: { kind: "section", field: "press" },
  derm_endorsements: { kind: "section", field: "dermEndorsements" },
  cart_cross_sell: { kind: "section", field: "cartCrossSell" },
  dispatch_countdown: { kind: "section", field: "dispatch" },
  delivery_estimate: { kind: "section", field: "deliveryEstimate" },
  az_buy_box: { kind: "amazon", field: "buyBox" },
  az_microcopy: { kind: "amazon", field: "microcopy" },
  az_delivery_line: { kind: "amazon", field: "deliveryLine" },
  az_stock_line: { kind: "amazon", field: "stockLine" },
  az_ships_from: { kind: "amazon", field: "shipsFrom" },
  az_bought_count: { kind: "amazon", field: "boughtCount" },
  az_bestseller_badge: { kind: "amazon", field: "bestsellerBadge" },
  az_fbt: { kind: "amazon", field: "fbt" },
  az_similar_items: { kind: "amazon", field: "similarItems" },
  az_cart_free_line: { kind: "amazon", field: "cartFreeLine" },
  az_cta_count: { kind: "amazon", field: "ctaCount" },
  set_savings: { kind: "rewards", field: "setSavings" },
  gift_tiers: { kind: "rewards", field: "giftTiers" },
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
  /** The amazon.* feature flags (v6.1; +shipsFrom v6.8). Optional: snapshots
   *  persisted by older app versions predate the section — restores skip
   *  what is absent (a pre-v6.8 snapshot simply never touches shipsFrom). */
  amazonFlags?: Record<AmazonFlagField, boolean>;
  /** The two v9 checkout-trust row sub-flags. Optional for the same
   *  old-snapshot back-compat reason as amazonFlags. */
  checkoutTrustSubFlags?: Record<CheckoutTrustSubFlagField, boolean>;
  /** v14 rewards masters (rewards.setSavings.enabled / rewards.giftTiers
   *  .enabled). Optional for the same old-snapshot back-compat reason. */
  rewardsFlags?: Record<RewardsFlagField, boolean>;
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
    amazonFlags: Object.fromEntries(
      AMAZON_FLAG_FIELDS.map((field) => [field, settings.amazon[field]]),
    ) as Record<AmazonFlagField, boolean>,
    checkoutTrustSubFlags: Object.fromEntries(
      CHECKOUT_TRUST_SUB_FLAG_FIELDS.map((field) => [
        field,
        settings.checkoutTrust[field],
      ]),
    ) as Record<CheckoutTrustSubFlagField, boolean>,
    rewardsFlags: Object.fromEntries(
      REWARDS_FLAG_FIELDS.map((field) => [
        field,
        settings.rewards[field].enabled,
      ]),
    ) as Record<RewardsFlagField, boolean>,
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
  // Older-shape snapshots (pre-v6.1) carry no amazonFlags — leave the
  // current values untouched rather than zeroing them.
  for (const field of AMAZON_FLAG_FIELDS) {
    const value = snapshot.amazonFlags?.[field];
    if (typeof value === "boolean") settings.amazon[field] = value;
  }
  // Same skip-if-absent contract for pre-v9 snapshots.
  for (const field of CHECKOUT_TRUST_SUB_FLAG_FIELDS) {
    const value = snapshot.checkoutTrustSubFlags?.[field];
    if (typeof value === "boolean") settings.checkoutTrust[field] = value;
  }
  // v14: same skip-if-absent contract for pre-v14 snapshots.
  for (const field of REWARDS_FLAG_FIELDS) {
    const value = snapshot.rewardsFlags?.[field];
    if (typeof value === "boolean") settings.rewards[field].enabled = value;
  }
  settings.marketScopes = structuredClone(snapshot.marketScopes);
  return settings;
}

/**
 * Restores ONLY the raw flags + scopes belonging to `keys` from a snapshot —
 * the rollback primitive for per-market concurrent experiments. Because
 * startExperiment forbids flip-key overlap between running experiments (and
 * treats all cart_* keys as one overlap group — shared master — plus, v9,
 * checkout_trust + its two rows as a second group), touching only these
 * fields can never clobber another running experiment's state.
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
    if (raw?.kind === "amazon") {
      const value = snapshot.amazonFlags?.[raw.field];
      if (typeof value === "boolean") settings.amazon[raw.field] = value;
    }
    if (raw?.kind === "rewards") {
      const value = snapshot.rewardsFlags?.[raw.field];
      if (typeof value === "boolean") settings.rewards[raw.field].enabled = value;
    }
    if (raw?.kind === "checkoutTrust") {
      // The row flip may have force-isolated the dormant SIBLING row, raised
      // the shared master and restricted/widened the MODULE's market scope —
      // put all of it back, not just this key's own flag. Safe: the
      // checkout-trust family is one experiment overlap group, so no
      // concurrent experiment can own any of these fields.
      for (const field of CHECKOUT_TRUST_SUB_FLAG_FIELDS) {
        const value = snapshot.checkoutTrustSubFlags?.[field];
        if (typeof value === "boolean") settings.checkoutTrust[field] = value;
      }
      const master = snapshot.sectionEnabled?.checkoutTrust;
      if (typeof master === "boolean") {
        settings.checkoutTrust.enabled = master;
      }
      const moduleScope = snapshot.marketScopes?.checkout_trust;
      if (
        moduleScope &&
        (moduleScope.mode === "all" || moduleScope.mode === "selected") &&
        Array.isArray(moduleScope.markets)
      ) {
        settings.marketScopes.checkout_trust = structuredClone(moduleScope);
      }
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
    // v9 checkout-trust rows live inside the module: making a row
    // effectively on in `market` needs checkoutTrust.enabled (raised by
    // def.set below) AND the module's scope to allow the market. Captured
    // BEFORE def.set so we can tell master-off from master-on.
    const raw = FEATURE_RAW_FIELD[key];
    const trustMasterWasOff =
      raw.kind === "checkoutTrust" && !settings.checkoutTrust.enabled;
    if (trustMasterWasOff) {
      // The module was live NOWHERE: force the dormant SIBLING row off so
      // raising the master cannot resurrect it (the cart-guard convention;
      // the legacy show* rows are not FeatureKeys — their exposure is
      // contained by the module-scope restriction below).
      for (const field of CHECKOUT_TRUST_SUB_FLAG_FIELDS) {
        if (field !== raw.field) settings.checkoutTrust[field] = false;
      }
    }
    def.set(settings, true);
    if (raw.kind === "checkoutTrust") {
      if (trustMasterWasOff) {
        // Module was effectively off everywhere — restricting its scope to
        // the flip target leaves every other market's state untouched.
        settings.marketScopes.checkout_trust =
          market === "all"
            ? { mode: "all", markets: [] }
            : { mode: "selected", markets: [market] };
      } else if (market === "all") {
        settings.marketScopes.checkout_trust = { mode: "all", markets: [] };
      } else {
        const moduleScope = scopeFor(settings, "checkout_trust");
        if (
          moduleScope.mode === "selected" &&
          !moduleScope.markets.includes(market)
        ) {
          settings.marketScopes.checkout_trust = {
            mode: "selected",
            markets: [...moduleScope.markets, market],
          };
        }
      }
      // restoreFlagsSelective restores the master, BOTH row flags and the
      // module scope; the family is one experiment overlap group, so this
      // widened write set can never clobber a concurrent experiment.
    }
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
    const raw: unknown = JSON.parse(row.data);
    return coerceLegacyProofDensities(
      mergeSettings(structuredClone(DEFAULT_SETTINGS), raw),
      raw,
    );
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
