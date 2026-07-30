import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  Divider,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getSettings,
  resolveFeatureFlag,
  saveSettings,
  type BoosterSettings,
  type DeepPartial,
  type FeatureKey,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { listMarkets } from "../services/markets.server";
import { ensurePdpDefinitions } from "../services/metaobjects.server";
import {
  BOUGHT_COUNT_STALE_DAYS,
  getProductBoosters,
  listProductsWithBoosterStatus,
  savePdpFlags,
  type FbtManualItem,
  type PdpFlagsPatch,
} from "../services/pdp-content.server";
import {
  collectAllowedMetafieldGids,
  collectBoosterResourceGids,
  getTargetLocales,
  getTranslationConfig,
  translateResources,
} from "../services/translation.server";
import type { loader as variantsLoader } from "./app.api.variants";

/**
 * Amazon patterns hub (v6.1) — one page for all eleven az_* features:
 *
 *   - per-feature cards (toggle + a short "how the pattern works" note +
 *     what the feature REPLACES while effective + a Preview deep link),
 *   - the az_ships_from warehouse map (buyer ISO2 -> warehouse ISO2 +
 *     default warehouse; v6.8 — the map moved with the split-out
 *     Ships-from feature),
 *   - the "Amazon data" bulk table: per-product bought count (set date is
 *     auto-stamped server-side on save; >45-day-old counts are flagged
 *     stale and hidden by the storefront), bestseller rank/category and the
 *     manual "Frequently bought together" override picker,
 *   - per-feature market targeting,
 *   - the app-embed-enable reminder.
 *
 * BRAND RULE (non-negotiable): we model marketplace PATTERNS — layout,
 * ordering, color conventions, microcopy structure. The rendered storefront
 * output never contains the words "Amazon"/"Prime"/"Amazon's Choice", the
 * smile mark or their exact badge trade dress. This admin page may name
 * Amazon (merchant-facing only).
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

const ISO2_PATTERN = /^[A-Z]{2}$/;

/**
 * Client-safe literal mirrors of BOUGHT_COUNT_STALE_DAYS /
 * MAX_FBT_MANUAL_ITEMS in services/pdp-content.server.ts — the component
 * must not reference *.server modules (the loader uses the canonical
 * constants; keep the pairs in sync).
 */
const STALE_DAYS = 45;
const MAX_FBT_ITEMS = 3;

/** The eleven Amazon-pattern feature keys in canonical order (client-safe
 *  literal — the component must not import the server-only settings model). */
const AZ_KEYS = [
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
] as const;
type AzKey = (typeof AZ_KEYS)[number];

/** amazon.* flag field per feature key (client-safe mirror of
 *  FEATURE_RAW_FIELD's amazon entries — the action validates server-side). */
const AZ_FLAG_FIELD: Record<AzKey, AzFlagField> = {
  az_buy_box: "buyBox",
  az_microcopy: "microcopy",
  az_delivery_line: "deliveryLine",
  az_stock_line: "stockLine",
  az_ships_from: "shipsFrom",
  az_bought_count: "boughtCount",
  az_bestseller_badge: "bestsellerBadge",
  az_fbt: "fbt",
  az_similar_items: "similarItems",
  az_cart_free_line: "cartFreeLine",
  az_cta_count: "ctaCount",
};
type AzFlagField =
  | "buyBox"
  | "microcopy"
  | "deliveryLine"
  | "stockLine"
  | "shipsFrom"
  | "boughtCount"
  | "bestsellerBadge"
  | "fbt"
  | "similarItems"
  | "cartFreeLine"
  | "ctaCount";

interface AzFeatureCardCopy {
  key: AzKey;
  title: string;
  toggleLabel: string;
  /** Short "how the marketplace pattern works" note. */
  how: string;
  /** What the feature suppresses while effective (live or verified preview). */
  replaces: string | null;
}

const AZ_FEATURE_COPY: AzFeatureCardCopy[] = [
  {
    key: "az_buy_box",
    title: "Buy-box decision card",
    toggleLabel: "Enable the buy-box decision card",
    how: "The pattern: one bordered card (hairline border, 8px radius) stacking price, delivery line, green stock line, quantity and the buy buttons in a fixed decision order. Assembled around the theme's existing buy area — Cellexia buttons keep their own styling; if the theme anchors are missing the card gracefully no-ops.",
    replaces: null,
  },
  {
    key: "az_microcopy",
    title: "Trust microcopy rows",
    toggleLabel: "Enable the trust microcopy rows",
    how: "The pattern: terse 12px gray label rows under the add-to-cart button — a lock with “Secure transaction”, “Ships from {warehouse}” (from the warehouse map below), and a “FREE returns” row that expands to the guarantee sentence (reuses your guarantee days).",
    replaces:
      "Replaces the app-injected PDP trust-badges strip while on. A trust-badges block you placed manually in the theme editor cannot be auto-removed — remove that block by hand.",
  },
  {
    key: "az_delivery_line",
    title: "Compound delivery line",
    toggleLabel: "Enable the compound delivery line",
    how: "The pattern: “FREE delivery {date} on orders over {threshold}” with the date in bold, plus a live “Order within Xh Ym” countdown clause. The threshold clause is mandatory whenever a per-market threshold exists; dates come from your existing delivery + dispatch engines in the page language.",
    replaces:
      "Replaces the standard PDP delivery widget AND the PDP dispatch countdown line while on.",
  },
  {
    key: "az_stock_line",
    title: "In-stock line",
    toggleLabel: "Enable the in-stock line",
    how: "The pattern: a green “In Stock” line above the quantity control. Honest by construction: it renders only when the theme's real inventory data says available; low-stock states pass through untouched. The “Ships from {country}” row is its own feature below — turn both on for the combined marketplace look.",
    replaces:
      "Replaces the theme's stock line while on — the theme message is hidden and this line renders in its place (alongside the Ships-from line when that feature is also on); the original is restored the moment the feature is off.",
  },
  {
    key: "az_ships_from",
    title: "Ships-from line",
    toggleLabel: "Enable the ships-from line",
    how: "The pattern: a small “Ships from {country}” row next to the In-Stock line (or standalone when that feature is off), from the warehouse map below — the country name is translated automatically into the page language. No warehouse mapping and no default warehouse = no line (fail closed). Toggle and market targeting are independent of the In-Stock line, so you can e.g. run both globally but show Ships-from only in selected markets.",
    replaces:
      "Replaces the theme's stock line while on — even without the In-Stock line, this row renders in the theme message's place; the original is restored the moment the feature is off.",
  },
  {
    key: "az_bought_count",
    title: "Bought-in-past-month count",
    toggleLabel: "Enable the bought count",
    how: "The pattern: “{n}+ bought in past month” directly under the title/ratings area, count in bold, compact notation (2K+) in the page locale. n is YOUR number, set per product per month in the table below — nothing is ever fabricated, and numbers older than 45 days are hidden automatically.",
    replaces: null,
  },
  {
    key: "az_bestseller_badge",
    title: "Bestseller badge",
    toggleLabel: "Enable the bestseller badge",
    how: "The pattern: a small dark pill left-anchored above the title — “#1 Bestseller · Anti-aging” — rank and category set per product below. It never renders without merchant-entered data. The category is stored as a translatable metafield and served per storefront language automatically — auto-translated on save when DeepL is connected (Languages page), or per row via the Translate button below.",
    replaces: null,
  },
  {
    key: "az_fbt",
    title: "Frequently bought together",
    toggleLabel: "Enable Frequently bought together",
    how: "The pattern: thumbnails joined by “+” glyphs, one checkbox row per item (“This item:” locked on the first row), a live combined “Total price” and one add-all button. Items come from Shopify's complementary recommendations by default, or a per-product manual list below.",
    replaces:
      "Nothing in this app (the cart cross-sell stays). A theme-native “related products” section is a theme setting — disable it in the theme editor if the page gets crowded.",
  },
  {
    key: "az_similar_items",
    title: "Similar items row",
    toggleLabel: "Enable the similar items row",
    how: "The pattern: a horizontal scroll row of compact cards (image, 2-line clamped title, stars when available, price) directly under Frequently bought together — designed to sit under it, but renders standalone too. Automatic related recommendations only.",
    replaces: null,
  },
  {
    key: "az_cart_free_line",
    title: "Cart free-shipping sentence",
    toggleLabel: "Enable the cart free-shipping sentence",
    how: "The pattern: a green declarative sentence at the very top of the cart booster — “Your order qualifies for FREE shipping.” or “Add {amount} more to qualify for FREE shipping.” — using your existing per-market thresholds and the live cart total.",
    replaces:
      "Replaces the free-shipping bar's text line while on; the progress bar itself stays below the sentence.",
  },
  {
    key: "az_cta_count",
    title: "Checkout button item count",
    toggleLabel: "Enable the checkout button count",
    how: "The pattern: the checkout button reads “Proceed to checkout (3 items)” — the count comes from the live cart, plural-correct in all 18 languages, re-decorated on every cart change.",
    replaces:
      "Replaces the theme button's own label while on; the original label is restored verbatim when turned off.",
  },
];

/**
 * Curated country options for the warehouse map Selects (label + ISO2).
 * Static labels on purpose: Intl.DisplayNames output can differ between the
 * server and browser ICU builds, which would cause hydration mismatches.
 */
const COUNTRY_OPTIONS: { label: string; value: string }[] = [
  { label: "Austria (AT)", value: "AT" },
  { label: "Australia (AU)", value: "AU" },
  { label: "Belgium (BE)", value: "BE" },
  { label: "Bulgaria (BG)", value: "BG" },
  { label: "Brazil (BR)", value: "BR" },
  { label: "Canada (CA)", value: "CA" },
  { label: "Switzerland (CH)", value: "CH" },
  { label: "Czechia (CZ)", value: "CZ" },
  { label: "Germany (DE)", value: "DE" },
  { label: "Denmark (DK)", value: "DK" },
  { label: "Estonia (EE)", value: "EE" },
  { label: "Spain (ES)", value: "ES" },
  { label: "Finland (FI)", value: "FI" },
  { label: "France (FR)", value: "FR" },
  { label: "United Kingdom (GB)", value: "GB" },
  { label: "Greece (GR)", value: "GR" },
  { label: "Croatia (HR)", value: "HR" },
  { label: "Hungary (HU)", value: "HU" },
  { label: "Ireland (IE)", value: "IE" },
  { label: "Israel (IL)", value: "IL" },
  { label: "Italy (IT)", value: "IT" },
  { label: "Japan (JP)", value: "JP" },
  { label: "South Korea (KR)", value: "KR" },
  { label: "Lithuania (LT)", value: "LT" },
  { label: "Luxembourg (LU)", value: "LU" },
  { label: "Latvia (LV)", value: "LV" },
  { label: "Mexico (MX)", value: "MX" },
  { label: "Netherlands (NL)", value: "NL" },
  { label: "Norway (NO)", value: "NO" },
  { label: "New Zealand (NZ)", value: "NZ" },
  { label: "Poland (PL)", value: "PL" },
  { label: "Portugal (PT)", value: "PT" },
  { label: "Romania (RO)", value: "RO" },
  { label: "Sweden (SE)", value: "SE" },
  { label: "Singapore (SG)", value: "SG" },
  { label: "Slovenia (SI)", value: "SI" },
  { label: "Slovakia (SK)", value: "SK" },
  { label: "United States (US)", value: "US" },
];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

interface AmazonProductRow {
  id: string;
  title: string;
  status: string;
  imageUrl: string | null;
  boughtCount: number | null;
  boughtCountSetAt: string | null;
  /** Whole days since the count was set (null when never set). */
  boughtCountAgeDays: number | null;
  bestsellerRank: number | null;
  bestsellerCategory: string;
  fbtManual: FbtManualItem[];
}

/**
 * Shops whose PDP metaobject/metafield definitions were verified this server
 * lifetime (same pattern as app.products.tsx). The bestseller-category
 * metafield MUST be definition-backed before Shopify exposes it as a
 * translatable resource — and this page is the v6.4 primary write path
 * (bulk-table save + auto/one-click translate), so on an upgraded install
 * a merchant who lands here first would otherwise write categories that
 * the DeepL run silently skips until some Products page ran the ensure.
 */
const ensuredShops = new Set<string>();

async function ensureDefinitionsOnce(
  shop: string,
  admin: Parameters<typeof ensurePdpDefinitions>[0],
): Promise<string[]> {
  if (ensuredShops.has(shop)) return [];
  const ensured = await ensurePdpDefinitions(admin);
  if (ensured.ok) ensuredShops.add(shop);
  return ensured.errors;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  // Sequential on purpose: definitions must exist before the product list
  // reads metafield-backed categories on a fresh install.
  const definitionErrors = await ensureDefinitionsOnce(session.shop, admin);
  const [settings, markets, productList, translationConfig, targetLocales] =
    await Promise.all([
      getSettings(session.shop),
      listMarkets(admin).catch(() => []),
      listProductsWithBoosterStatus(admin, q),
      getTranslationConfig(session.shop),
      getTargetLocales(admin),
    ]);

  // Staleness is computed SERVER-SIDE so the rendered text is deterministic
  // (a client Date.now() would hydrate differently).
  const todayMs = Date.parse(new Date().toISOString().slice(0, 10));
  const products: AmazonProductRow[] = productList.products.map((product) => {
    const flags = product.boosters.flags;
    const setAt = flags.boughtCountSetAt ?? null;
    const setAtMs = setAt ? Date.parse(setAt) : Number.NaN;
    return {
      id: product.id,
      title: product.title,
      status: product.status,
      imageUrl: product.imageUrl,
      boughtCount: flags.boughtCount ?? null,
      boughtCountSetAt: setAt,
      boughtCountAgeDays: Number.isFinite(setAtMs)
        ? Math.max(0, Math.round((todayMs - setAtMs) / 86_400_000))
        : null,
      bestsellerRank: flags.bestsellerLabel?.rank ?? null,
      bestsellerCategory: flags.bestsellerLabel?.category ?? "",
      fbtManual: flags.fbtManual ?? [],
    };
  });

  const features = Object.fromEntries(
    AZ_KEYS.map((key) => [key, resolveFeatureFlag(settings, key as FeatureKey)]),
  ) as Record<AzKey, boolean>;

  return {
    features,
    amazon: settings.amazon,
    scopes: Object.fromEntries(
      AZ_KEYS.map((key) => [
        key,
        settings.marketScopes[key as FeatureKey] ?? {
          mode: "all" as const,
          markets: [],
        },
      ]),
    ) as Record<AzKey, { mode: "all" | "selected"; markets: string[] }>,
    markets,
    products,
    productErrors: [
      ...definitionErrors,
      ...(productList.ok ? [] : productList.errors),
    ],
    // The DeepL key itself never leaves the server — booleans/counts only.
    translation: {
      configured: translationConfig.configured,
      autoOnSave: translationConfig.autoOnSave,
      targetCount: targetLocales.targets.length,
    },
  };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

type AmazonActionData =
  | { intent: "save_settings"; ok: boolean; syncErrors: string[] }
  | { intent: "save_product"; ok: boolean; errors: string[]; productId: string }
  | {
      /** v6.4: per-product DeepL run for the bestseller-category metafield
       *  (and any booster content) — same intent name as the product editor. */
      intent: "translate_boosters";
      ok: boolean;
      errors: string[];
      productId: string;
      /** Locales that completed ("done"). */
      doneCount: number;
      /** Locales that failed, "locale: message" style. */
      localeErrors: string[];
    }
  | { intent: "unknown"; ok: false; errors: string[] };

/**
 * Fail-loud guard for the amazon section of a settings patch: a malformed
 * country code must produce an error, not a silently dropped map entry.
 */
function validateAmazonPatch(patch: DeepPartial<BoosterSettings>): string[] {
  const errors: string[] = [];
  const amazon = patch.amazon;
  if (amazon === undefined || amazon === null) return errors;
  if (typeof amazon !== "object" || Array.isArray(amazon)) {
    return ["The Amazon settings payload must be an object."];
  }
  if (amazon.shipsFromByCountry !== undefined) {
    if (
      typeof amazon.shipsFromByCountry !== "object" ||
      amazon.shipsFromByCountry === null ||
      Array.isArray(amazon.shipsFromByCountry)
    ) {
      errors.push("The warehouse map must be a map of ISO country codes.");
    } else {
      for (const [buyer, warehouse] of Object.entries(
        amazon.shipsFromByCountry,
      )) {
        if (!ISO2_PATTERN.test(buyer.toUpperCase())) {
          errors.push(
            `"${buyer}" is not a two-letter ISO country code (e.g. CH, NL).`,
          );
        }
        if (
          typeof warehouse !== "string" ||
          !ISO2_PATTERN.test(warehouse.toUpperCase())
        ) {
          errors.push(
            `The warehouse for ${buyer} must be a two-letter ISO country code.`,
          );
        }
      }
    }
  }
  if (
    amazon.defaultWarehouse !== undefined &&
    amazon.defaultWarehouse !== "" &&
    (typeof amazon.defaultWarehouse !== "string" ||
      !ISO2_PATTERN.test(amazon.defaultWarehouse.toUpperCase()))
  ) {
    errors.push(
      "The default warehouse must be a two-letter ISO country code, or empty.",
    );
  }
  // v6.5 placement enums — fail loud on anything the sanitizer would
  // silently coerce (a UI bug must surface, not save a surprise default).
  for (const field of ["fbtPlacement", "similarPlacement"] as const) {
    const value = amazon[field];
    if (value !== undefined && value !== "tabs_below" && value !== "buybox") {
      errors.push(
        `The ${field === "fbtPlacement" ? "Frequently-bought-together" : "similar-items"} placement must be “tabs_below” or “buybox”.`,
      );
    }
  }
  if (
    amazon.shipsFromDefault !== undefined &&
    typeof amazon.shipsFromDefault !== "string"
  ) {
    errors.push("The “Ships from” fallback label must be plain text.");
  } else if (
    typeof amazon.shipsFromDefault === "string" &&
    amazon.shipsFromDefault.trim().length > 80
  ) {
    errors.push(
      "The “Ships from” fallback label is limited to 80 characters.",
    );
  }
  return errors;
}

async function applySettingsPatch(
  shop: string,
  admin: AdminGraphqlClient,
  rawPatch: FormDataEntryValue | null,
): Promise<AmazonActionData> {
  const intent = "save_settings" as const;
  if (typeof rawPatch !== "string" || rawPatch.trim() === "") {
    return { intent, ok: false, syncErrors: ["Missing settings payload."] };
  }
  let patch: DeepPartial<BoosterSettings>;
  try {
    const parsed: unknown = JSON.parse(rawPatch);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        intent,
        ok: false,
        syncErrors: ["Settings payload must be an object."],
      };
    }
    patch = parsed as DeepPartial<BoosterSettings>;
  } catch {
    return {
      intent,
      ok: false,
      syncErrors: ["Settings payload was not valid JSON."],
    };
  }
  const amazonErrors = validateAmazonPatch(patch);
  if (amazonErrors.length > 0) {
    return { intent, ok: false, syncErrors: amazonErrors };
  }
  const next = await saveSettings(shop, patch);
  try {
    const sync = await syncSettingsToMetafields(admin, next);
    return { intent, ok: true, syncErrors: sync.errors };
  } catch (error) {
    return {
      intent,
      ok: true,
      syncErrors: [
        error instanceof Error
          ? error.message
          : "Could not sync settings to storefront metafields.",
      ],
    };
  }
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<AmazonActionData> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "save_settings") {
    return applySettingsPatch(session.shop, admin, formData.get("patch"));
  }

  if (intent === "save_product") {
    const productId = String(formData.get("productId") ?? "");
    let payload: unknown = null;
    try {
      payload = JSON.parse(String(formData.get("payload") ?? "null"));
    } catch {
      payload = null;
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return {
        intent: "save_product",
        ok: false,
        errors: ["Invalid product data payload"],
        productId,
      };
    }
    // Only the three Amazon-data keys are forwarded, and each ONLY when the
    // client actually sent it — savePdpFlags treats absent keys as
    // untouched, so a rank-only edit can never restamp the bought count.
    const raw = payload as Record<string, unknown>;
    const patch: PdpFlagsPatch = {};
    if ("boughtCount" in raw) {
      patch.boughtCount = raw.boughtCount as number | null;
    }
    if ("bestsellerLabel" in raw) {
      patch.bestsellerLabel =
        raw.bestsellerLabel as PdpFlagsPatch["bestsellerLabel"];
    }
    if ("fbtManual" in raw) {
      patch.fbtManual = raw.fbtManual as PdpFlagsPatch["fbtManual"];
    }
    // Definition-backed metafields only are translatable — make sure the
    // bestseller-category definition exists before the category write, even
    // when this server never rendered the loader (best-effort, cached).
    await ensureDefinitionsOnce(session.shop, admin);
    const result = await savePdpFlags(admin, productId, patch);
    return {
      intent: "save_product",
      ok: result.ok,
      errors: result.errors,
      productId,
    };
  }

  if (intent === "translate_boosters") {
    const productId = String(formData.get("productId") ?? "");
    const failure = (errors: string[]): AmazonActionData => ({
      intent: "translate_boosters",
      ok: false,
      errors,
      productId,
      doneCount: 0,
      localeErrors: [],
    });
    const config = await getTranslationConfig(session.shop);
    if (!config.configured) {
      return failure([
        "Connect a DeepL API key on the Languages page to enable auto-translation.",
      ]);
    }
    // Same guarantee for the translate run itself: without the definition,
    // translatableResourcesByIds returns no "value" content for the
    // category metafield and the run would silently skip it.
    await ensureDefinitionsOnce(session.shop, admin);
    const boosters = await getProductBoosters(admin, productId);
    if (!boosters.ok) return failure(boosters.errors);
    const targets = await getTargetLocales(admin);
    if (targets.errors.length) return failure(targets.errors);
    const summary = await translateResources(
      admin,
      config.apiKey,
      collectBoosterResourceGids(boosters),
      targets.targets,
      // Scoped admission: ONLY the bestseller-category metafield's "value"
      // key may translate — no other metafield ever joins the run.
      { metafieldValueGids: collectAllowedMetafieldGids(boosters) },
    );
    return {
      intent: "translate_boosters",
      ok: summary.ok,
      errors: summary.errors,
      productId,
      doneCount: summary.locales.filter((l) => l.status === "done").length,
      localeErrors: summary.locales
        .filter((l) => l.status === "error")
        .map((l) => `${l.locale}: ${l.error ?? "failed"}`),
    };
  }

  return { intent: "unknown", ok: false, errors: ["Unknown action"] };
};

// ---------------------------------------------------------------------------
// Client-side form state
// ---------------------------------------------------------------------------

interface ScopeState {
  mode: "all" | "selected";
  markets: string[];
}

interface WarehouseRowState {
  id: number;
  buyer: string;
  warehouse: string;
}

/** PDP placement for the FBT / similar-items sections (v6.5, client-safe
 *  mirror of AMAZON_PLACEMENTS — the server sanitizes on save). */
type AzPlacementValue = "tabs_below" | "buybox";

const PLACEMENT_OPTIONS: { label: string; value: AzPlacementValue }[] = [
  { label: "Below the info tabs (recommended)", value: "tabs_below" },
  { label: "Under the buy box", value: "buybox" },
];

function toPlacement(value: unknown): AzPlacementValue {
  return value === "buybox" ? "buybox" : "tabs_below";
}

interface AmazonFormState {
  flags: Record<AzKey, boolean>;
  warehouseRows: WarehouseRowState[];
  defaultWarehouse: string;
  /** az_microcopy "Ships from" fallback label for unmapped buyer countries
   *  ("" = the row hides for them). */
  shipsFromDefault: string;
  /** az_bestseller_badge sub-flag (v6.4): also flag this product's cards
   *  site-wide (collections/home/search + the app's own recommendation
   *  rows). */
  bestsellerOnCards: boolean;
  /** az_bought_count sub-flag (v6.6): also render the bought-in-past-month
   *  line under a product's title/price on its cards site-wide (same
   *  45-day freshness rule as the PDP line). */
  boughtOnCards: boolean;
  /** v6.5 per-widget PDP placement (az_fbt / az_similar_items cards). */
  fbtPlacement: AzPlacementValue;
  similarPlacement: AzPlacementValue;
  scopes: Record<AzKey, ScopeState>;
}

function toScopeState(scope: {
  mode: "all" | "selected";
  markets: string[];
}): ScopeState {
  return scope.mode === "selected"
    ? { mode: "selected", markets: [...scope.markets] }
    : { mode: "all", markets: [] };
}

function toScopePatch(scope: ScopeState): ScopeState {
  return scope.mode === "all" ? { mode: "all", markets: [] } : scope;
}

interface LoaderShape {
  features: Record<AzKey, boolean>;
  amazon: {
    shipsFromByCountry: Record<string, string>;
    defaultWarehouse: string;
    shipsFromDefault: string;
    bestsellerOnCards: boolean;
    boughtOnCards: boolean;
    fbtPlacement: string;
    similarPlacement: string;
  } & Record<AzFlagField, boolean>;
  scopes: Record<AzKey, { mode: "all" | "selected"; markets: string[] }>;
}

function initialFormState(data: LoaderShape): AmazonFormState {
  return {
    flags: Object.fromEntries(
      AZ_KEYS.map((key) => [key, data.amazon[AZ_FLAG_FIELD[key]]]),
    ) as Record<AzKey, boolean>,
    warehouseRows: Object.entries(data.amazon.shipsFromByCountry)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([buyer, warehouse], index) => ({ id: index, buyer, warehouse })),
    defaultWarehouse: data.amazon.defaultWarehouse,
    shipsFromDefault: data.amazon.shipsFromDefault ?? "",
    bestsellerOnCards: data.amazon.bestsellerOnCards !== false,
    boughtOnCards: data.amazon.boughtOnCards !== false,
    fbtPlacement: toPlacement(data.amazon.fbtPlacement),
    similarPlacement: toPlacement(data.amazon.similarPlacement),
    scopes: Object.fromEntries(
      AZ_KEYS.map((key) => [key, toScopeState(data.scopes[key])]),
    ) as Record<AzKey, ScopeState>,
  };
}

/** Dirty-check serialization: warehouse rows lose their client-only ids and
 *  compare in sorted order; "all" scopes drop their remembered market list. */
function serializeForCompare(state: AmazonFormState): string {
  return JSON.stringify({
    flags: state.flags,
    warehouses: state.warehouseRows
      .map((row) => [row.buyer.trim().toUpperCase(), row.warehouse])
      .sort((a, b) => a[0].localeCompare(b[0])),
    defaultWarehouse: state.defaultWarehouse,
    shipsFromDefault: state.shipsFromDefault.trim(),
    bestsellerOnCards: state.bestsellerOnCards,
    boughtOnCards: state.boughtOnCards,
    fbtPlacement: state.fbtPlacement,
    similarPlacement: state.similarPlacement,
    scopes: Object.fromEntries(
      AZ_KEYS.map((key) => [key, toScopePatch(state.scopes[key])]),
    ),
  });
}

/** Per-product editable row state ("" fields = cleared). */
interface RowEditState {
  boughtCount: string;
  rank: string;
  category: string;
  fbt: FbtManualItem[];
}

function rowFromProduct(product: AmazonProductRow): RowEditState {
  return {
    boughtCount:
      product.boughtCount === null ? "" : String(product.boughtCount),
    rank: product.bestsellerRank === null ? "" : String(product.bestsellerRank),
    category: product.bestsellerCategory,
    fbt: product.fbtManual.map((item) => ({ ...item })),
  };
}

function rowsEqual(a: RowEditState, b: RowEditState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface RowValidation {
  boughtCountError?: string;
  bestsellerError?: string;
}

function validateRow(row: RowEditState): RowValidation {
  const errors: RowValidation = {};
  const count = row.boughtCount.trim();
  if (count !== "") {
    const parsed = Number(count);
    if (
      !Number.isInteger(parsed) ||
      parsed < 0 ||
      parsed > 10_000_000
    ) {
      errors.boughtCountError = "Whole number (0 clears)";
    }
  }
  const rank = row.rank.trim();
  const category = row.category.trim();
  if (rank !== "" || category !== "") {
    const parsedRank = Number(rank);
    if (
      rank === "" ||
      !Number.isInteger(parsedRank) ||
      parsedRank < 1 ||
      parsedRank > 99
    ) {
      errors.bestsellerError = "Rank must be 1–99";
    } else if (category === "") {
      errors.bestsellerError = "Category required with a rank";
    } else if (category.length > 60) {
      errors.bestsellerError = "Category is limited to 60 characters";
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function AmazonFeaturesPage() {
  const {
    features,
    amazon,
    scopes,
    markets,
    products,
    productErrors,
    translation,
  } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();

  const loaderShape: LoaderShape = { features, amazon, scopes };
  const initial = useMemo(
    () => initialFormState({ features, amazon, scopes }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [features, amazon, scopes],
  );
  const [state, setState] = useState<AmazonFormState>(() =>
    initialFormState(loaderShape),
  );
  const [nextRowId, setNextRowId] = useState(
    () => Object.keys(amazon.shipsFromByCountry).length,
  );

  useEffect(() => {
    setState(initial);
    setNextRowId(initial.warehouseRows.length);
  }, [initial]);

  // ---- settings save -------------------------------------------------------
  const settingsFetcher = useFetcher<typeof action>();
  useEffect(() => {
    const data = settingsFetcher.data;
    if (!data || data.intent !== "save_settings") return;
    if (!data.ok) {
      shopify.toast.show("Could not save settings", { isError: true });
    } else if (data.syncErrors.length > 0) {
      shopify.toast.show("Saved, but the storefront sync failed", {
        isError: true,
      });
    } else {
      shopify.toast.show("Saved");
    }
  }, [settingsFetcher.data, shopify]);

  const dirty = serializeForCompare(state) !== serializeForCompare(initial);
  const isSaving = settingsFetcher.state !== "idle";

  const warehouseCounts = new Map<string, number>();
  for (const row of state.warehouseRows) {
    const code = row.buyer.trim().toUpperCase();
    warehouseCounts.set(code, (warehouseCounts.get(code) ?? 0) + 1);
  }
  const warehouseErrors = state.warehouseRows.map((row) => {
    const code = row.buyer.trim().toUpperCase();
    if (!ISO2_PATTERN.test(code)) return "Pick a buyer country";
    if ((warehouseCounts.get(code) ?? 0) > 1) return "Duplicate buyer country";
    if (!ISO2_PATTERN.test(row.warehouse)) return "Pick a warehouse country";
    return undefined;
  });
  const hasErrors = warehouseErrors.some((error) => error !== undefined);

  const handleSave = () => {
    const shipsFromByCountry = Object.fromEntries(
      state.warehouseRows.map((row) => [
        row.buyer.trim().toUpperCase(),
        row.warehouse.toUpperCase(),
      ]),
    );
    const patch: DeepPartial<BoosterSettings> = {
      amazon: {
        ...(Object.fromEntries(
          AZ_KEYS.map((key) => [AZ_FLAG_FIELD[key], state.flags[key]]),
        ) as Record<AzFlagField, boolean>),
        shipsFromByCountry,
        defaultWarehouse: state.defaultWarehouse,
        shipsFromDefault: state.shipsFromDefault.trim(),
        bestsellerOnCards: state.bestsellerOnCards,
        boughtOnCards: state.boughtOnCards,
        fbtPlacement: state.fbtPlacement,
        similarPlacement: state.similarPlacement,
      },
      marketScopes: Object.fromEntries(
        AZ_KEYS.map((key) => [key, toScopePatch(state.scopes[key])]),
      ) as Partial<Record<FeatureKey, ScopeState>>,
    };
    const formData = new FormData();
    formData.set("intent", "save_settings");
    formData.set("patch", JSON.stringify(patch));
    settingsFetcher.submit(formData, { method: "post" });
  };

  // ---- product rows --------------------------------------------------------
  /** Local edits per product id; absent = shows the loader's saved values. */
  const [rowEdits, setRowEdits] = useState<Record<string, RowEditState>>({});
  const [expandedFbtId, setExpandedFbtId] = useState<string | null>(null);
  const productFetcher = useFetcher<typeof action>();
  const pendingProductId =
    productFetcher.state !== "idle" && productFetcher.formData
      ? String(productFetcher.formData.get("productId") ?? "")
      : null;

  // v6.4: per-row translate runs (bestseller-category metafield + boosters).
  const translateFetcher = useFetcher<typeof action>();
  const pendingTranslateId =
    translateFetcher.state !== "idle" && translateFetcher.formData
      ? String(translateFetcher.formData.get("productId") ?? "")
      : null;
  const canTranslate =
    translation.configured && translation.targetCount > 0;
  const runRowTranslate = (productId: string) => {
    if (translateFetcher.state !== "idle") return;
    translateFetcher.submit(
      { intent: "translate_boosters", productId },
      { method: "post" },
    );
  };
  /** True when the LAST submitted row save SET a bestseller label — only
   *  that makes the save worth an autoOnSave translate run. */
  const rowSaveSetLabelRef = useRef(false);
  const translateSeenRef = useRef<unknown>(null);

  useEffect(() => {
    const data = translateFetcher.data;
    if (!data || data.intent !== "translate_boosters") return;
    if (data === translateSeenRef.current) return;
    translateSeenRef.current = data;
    shopify.toast.show(
      data.ok
        ? `Category translated into ${data.doneCount} ${data.doneCount === 1 ? "language" : "languages"}`
        : (data.errors[0] ??
            data.localeErrors[0] ??
            "Translation did not complete"),
      { isError: !data.ok },
    );
  }, [translateFetcher.data, shopify]);

  useEffect(() => {
    const data = productFetcher.data;
    if (!data || data.intent !== "save_product") return;
    if (data.ok) {
      shopify.toast.show("Product data saved");
      // Drop the local edit so the row re-seeds from the revalidated loader
      // data (including the freshly stamped set-date).
      setRowEdits((previous) => {
        const next = { ...previous };
        delete next[data.productId];
        return next;
      });
      // autoOnSave hook (v6.4): a saved bestseller label puts its category
      // in the translatable metafield — fire the same per-product translate
      // run the product editor uses. Cleared labels / count-only edits
      // never spend a run.
      if (
        rowSaveSetLabelRef.current &&
        translation.autoOnSave &&
        canTranslate
      ) {
        rowSaveSetLabelRef.current = false;
        runRowTranslate(data.productId);
      }
    } else {
      shopify.toast.show(
        data.errors[0] ?? "Could not save the product data",
        { isError: true },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productFetcher.data, shopify]);

  const initialRows = useMemo(() => {
    const map: Record<string, RowEditState> = {};
    for (const product of products) map[product.id] = rowFromProduct(product);
    return map;
  }, [products]);

  const rowState = (product: AmazonProductRow): RowEditState =>
    rowEdits[product.id] ?? initialRows[product.id];

  const setRow = (productId: string, next: RowEditState) =>
    setRowEdits((previous) => ({ ...previous, [productId]: next }));

  const saveRow = (product: AmazonProductRow) => {
    const row = rowState(product);
    const before = initialRows[product.id];
    // Only CHANGED fields go in the payload — an unchanged bought count is
    // never re-sent, so its freshness date is never restamped accidentally.
    const payload: Record<string, unknown> = {};
    if (row.boughtCount.trim() !== before.boughtCount.trim()) {
      const trimmed = row.boughtCount.trim();
      payload.boughtCount = trimmed === "" ? null : Number(trimmed);
    }
    if (
      row.rank.trim() !== before.rank.trim() ||
      row.category.trim() !== before.category.trim()
    ) {
      const rank = Number(row.rank.trim());
      payload.bestsellerLabel =
        row.rank.trim() === "" && row.category.trim() === ""
          ? null
          : { rank, category: row.category.trim() };
    }
    if (JSON.stringify(row.fbt) !== JSON.stringify(before.fbt)) {
      payload.fbtManual = row.fbt;
    }
    // Feeds the autoOnSave hook: only a SET label (rank + category) makes
    // this save worth an auto-translate run of the category metafield.
    rowSaveSetLabelRef.current =
      payload.bestsellerLabel !== undefined && payload.bestsellerLabel !== null;
    const formData = new FormData();
    formData.set("intent", "save_product");
    formData.set("productId", product.id);
    formData.set("payload", JSON.stringify(payload));
    productFetcher.submit(formData, { method: "post" });
  };

  // ---- FBT variant search --------------------------------------------------
  const variantSearch = useFetcher<typeof variantsLoader>();
  const loadVariants = variantSearch.load;
  const [fbtQuery, setFbtQuery] = useState("");
  const lastQueryRef = useRef("");
  useEffect(() => {
    const trimmed = fbtQuery.trim();
    if (trimmed === "" || trimmed === lastQueryRef.current) return;
    const handle = setTimeout(() => {
      lastQueryRef.current = trimmed;
      loadVariants(`/app/api/variants?q=${encodeURIComponent(trimmed)}`);
    }, 350);
    return () => clearTimeout(handle);
  }, [fbtQuery, loadVariants]);
  const searchResults = variantSearch.data?.variants ?? [];

  // ---- product table search ------------------------------------------------
  const [productQuery, setProductQuery] = useState(
    searchParams.get("q") ?? "",
  );
  const applyProductSearch = () => {
    const params = new URLSearchParams(searchParams);
    const trimmed = productQuery.trim();
    if (trimmed === "") params.delete("q");
    else params.set("q", trimmed);
    setSearchParams(params, { replace: true });
  };

  const isNavigating = navigation.state !== "idle";

  return (
    <Page
      title="Amazon patterns"
      subtitle="Familiar marketplace patterns, adapted to Cellexia branding — patterns only, never their brand"
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
          onAction: () => setState(initial),
          disabled: !dirty || isSaving,
        },
      ]}
    >
      <TitleBar title="Amazon patterns" />
      <Layout>
        <Layout.Section>
          <Banner
            tone="warning"
            title="One-time setup: enable the new app embed"
          >
            <BlockStack gap="100">
              <Text as="p">
                The product-page patterns ship in a NEW app embed named
                “Cellexia Amazon patterns”. It must be enabled once in the
                theme editor: Online Store → Themes → Customize → App embeds →
                turn on “Cellexia Amazon patterns” → Save. Until then the
                eight product-page features render nothing (the two cart
                features use the existing cart booster embed). The app cannot
                detect the embed state automatically — if nothing shows in a
                preview, check the embed first.
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Everything on this page is OFF by default and changes nothing
                on the storefront until you enable a feature and save.
              </Text>
            </BlockStack>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Banner tone="info" title="Patterns, not their brand">
            <Text as="p">
              These widgets reproduce marketplace CONVENTIONS — layout order,
              green logistics text, terse gray microcopy, compact counts — so
              shoppers feel at home. The words “Amazon”, “Prime” or “Amazon's
              Choice”, their logo and their exact badge artwork never appear
              in your storefront, and buttons keep Cellexia styling. Nothing
              may claim or imply affiliation.
            </Text>
          </Banner>
        </Layout.Section>

        {settingsFetcher.data?.intent === "save_settings" &&
        settingsFetcher.data.syncErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone={settingsFetcher.data.ok ? "warning" : "critical"}
              title={
                settingsFetcher.data.ok
                  ? "Saved, but the storefront sync reported errors"
                  : "Settings could not be saved"
              }
            >
              <BlockStack gap="100">
                {settingsFetcher.data.syncErrors.map((error) => (
                  <Text as="p" key={error}>
                    {error}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <BlockStack gap="400">
            {AZ_FEATURE_COPY.map((feature) => (
              <Card key={feature.key}>
                <BlockStack gap="300">
                  <InlineStack
                    gap="200"
                    align="space-between"
                    blockAlign="center"
                    wrap
                  >
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        {feature.title}
                      </Text>
                      <Badge
                        tone={features[feature.key] ? "success" : undefined}
                      >
                        {features[feature.key] ? "Active" : "Off"}
                      </Badge>
                    </InlineStack>
                    <Button
                      variant="plain"
                      url={`/app/preview?feature=${encodeURIComponent(feature.key)}`}
                    >
                      Preview on your store
                    </Button>
                  </InlineStack>
                  <Checkbox
                    label={feature.toggleLabel}
                    checked={state.flags[feature.key]}
                    onChange={(checked) =>
                      setState((previous) => ({
                        ...previous,
                        flags: { ...previous.flags, [feature.key]: checked },
                      }))
                    }
                  />
                  <Text as="p" tone="subdued" variant="bodySm">
                    {feature.how}
                  </Text>
                  {feature.replaces ? (
                    <Text as="p" variant="bodySm">
                      While on: {feature.replaces}
                    </Text>
                  ) : null}

                  {feature.key === "az_fbt" ||
                  feature.key === "az_similar_items" ? (
                    <BlockStack gap="300">
                      <Divider />
                      <Box width="360px">
                        <Select
                          label="Placement"
                          options={PLACEMENT_OPTIONS}
                          value={
                            feature.key === "az_fbt"
                              ? state.fbtPlacement
                              : state.similarPlacement
                          }
                          onChange={(value) =>
                            setState((previous) =>
                              feature.key === "az_fbt"
                                ? {
                                    ...previous,
                                    fbtPlacement: toPlacement(value),
                                  }
                                : {
                                    ...previous,
                                    similarPlacement: toPlacement(value),
                                  },
                            )
                          }
                          helpText="“Below the info tabs” renders the section after the theme's overview/science/FAQ tabs box and above the “Create your ritual” section (recommended). “Under the buy box” is the classic spot right below the purchase area. Each section is placed independently; if a theme update removes the tabs section, the buy-box spot is used automatically. This is a live setting — storefront previews render at the saved placement."
                        />
                      </Box>
                    </BlockStack>
                  ) : null}

                  {feature.key === "az_bought_count" ? (
                    <BlockStack gap="300">
                      <Divider />
                      <Checkbox
                        label="Also show the count on product cards site-wide"
                        checked={state.boughtOnCards}
                        onChange={(boughtOnCards) =>
                          setState((previous) => ({
                            ...previous,
                            boughtOnCards,
                          }))
                        }
                        helpText="Adds a small “{n}+ bought in past month” line under a product's title and price on its cards everywhere it is referenced — collection pages, the home page and search results. Uses the same per-product monthly counts below (compact notation in the page language); counts older than 45 days stay hidden automatically."
                      />
                    </BlockStack>
                  ) : null}

                  {feature.key === "az_bestseller_badge" ? (
                    <BlockStack gap="300">
                      <Divider />
                      <Checkbox
                        label="Also show the flag on product cards site-wide"
                        checked={state.bestsellerOnCards}
                        onChange={(bestsellerOnCards) =>
                          setState((previous) => ({
                            ...previous,
                            bestsellerOnCards,
                          }))
                        }
                        helpText="Adds a compact corner flag to a flagged product's cards everywhere it is referenced — collection pages, the home page, search results and this app's own recommendation rows. Uses the same per-product rank and category below (category shown in the page language); products without badge data never show a flag. Note: while the flag shows on a card, the theme's own tag pill on that card (e.g. a manually-set “#1 Bestseller” or “Instant Results”) is hidden so badges never stack — it returns as soon as this is turned off."
                      />
                    </BlockStack>
                  ) : null}

                  {feature.key === "az_microcopy" ? (
                    <BlockStack gap="300">
                      <Divider />
                      <Box width="360px">
                        <TextField
                          label="“Ships from” fallback label"
                          value={state.shipsFromDefault}
                          onChange={(shipsFromDefault) =>
                            setState((previous) => ({
                              ...previous,
                              shipsFromDefault,
                            }))
                          }
                          maxLength={80}
                          autoComplete="off"
                          helpText="Shown in the microcopy “Ships from …” row when the buyer's country has no warehouse mapping and no default warehouse is set (see the map under the Ships-from line feature). Leave empty to hide the row for unmapped buyers. Plain text, rendered as entered in every language. The standalone Ships-from line never uses this label — it needs a real country."
                        />
                      </Box>
                    </BlockStack>
                  ) : null}

                  {feature.key === "az_ships_from" ? (
                    <BlockStack gap="300">
                      <Divider />
                      <Text as="h3" variant="headingSm">
                        “Ships from” warehouse map
                      </Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Buyers in a mapped country see “Ships from
                        {" {country}"}” (the country name is translated
                        automatically into the page language). Unmapped
                        buyers fall back to the default warehouse — or see
                        no “Ships from” line when none is set. This map
                        also feeds the trust microcopy rows.
                      </Text>
                      {state.warehouseRows.map((row, index) => (
                        <InlineStack
                          key={row.id}
                          gap="300"
                          blockAlign="start"
                          wrap
                        >
                          <Box width="260px">
                            <Select
                              label="Buyer country"
                              options={COUNTRY_OPTIONS}
                              placeholder="Pick a country"
                              value={row.buyer}
                              onChange={(buyer) =>
                                setState((previous) => ({
                                  ...previous,
                                  warehouseRows: previous.warehouseRows.map(
                                    (other) =>
                                      other.id === row.id
                                        ? { ...other, buyer }
                                        : other,
                                  ),
                                }))
                              }
                              error={warehouseErrors[index]}
                            />
                          </Box>
                          <Box width="260px">
                            <Select
                              label="Ships from warehouse in"
                              options={COUNTRY_OPTIONS}
                              placeholder="Pick a country"
                              value={row.warehouse}
                              onChange={(warehouse) =>
                                setState((previous) => ({
                                  ...previous,
                                  warehouseRows: previous.warehouseRows.map(
                                    (other) =>
                                      other.id === row.id
                                        ? { ...other, warehouse }
                                        : other,
                                  ),
                                }))
                              }
                            />
                          </Box>
                          <Box paddingBlockStart="600">
                            <Button
                              variant="plain"
                              tone="critical"
                              onClick={() =>
                                setState((previous) => ({
                                  ...previous,
                                  warehouseRows:
                                    previous.warehouseRows.filter(
                                      (other) => other.id !== row.id,
                                    ),
                                }))
                              }
                            >
                              Remove
                            </Button>
                          </Box>
                        </InlineStack>
                      ))}
                      <InlineStack gap="300" blockAlign="end" wrap>
                        <Button
                          onClick={() => {
                            setState((previous) => ({
                              ...previous,
                              warehouseRows: [
                                ...previous.warehouseRows,
                                { id: nextRowId, buyer: "", warehouse: "" },
                              ],
                            }));
                            setNextRowId((id) => id + 1);
                          }}
                        >
                          Add country mapping
                        </Button>
                        <Box width="260px">
                          <Select
                            label="Default warehouse (fallback)"
                            options={[
                              {
                                label: "None — hide “Ships from” when unmapped",
                                value: "",
                              },
                              ...COUNTRY_OPTIONS,
                            ]}
                            value={state.defaultWarehouse}
                            onChange={(defaultWarehouse) =>
                              setState((previous) => ({
                                ...previous,
                                defaultWarehouse,
                              }))
                            }
                          />
                        </Box>
                      </InlineStack>
                    </BlockStack>
                  ) : null}
                </BlockStack>
              </Card>
            ))}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Amazon data — per product
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                The bought count and bestseller badge NEVER render without a
                number you set here — honesty first. The “set” date is
                stamped automatically when you save a count; counts older
                than {STALE_DAYS} days are flagged below and
                hidden on the storefront until you refresh them. Saving the
                same number again re-attests it for a new month. These
                fields are also editable per product under Product boosters.
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                The bestseller category is stored as a translatable
                metafield and served in each storefront language
                automatically.{" "}
                {translation.configured
                  ? translation.autoOnSave
                    ? "Auto-translation is ON: saving a row translates the category into all published shop languages; the Translate button re-runs it any time."
                    : "Auto-translate on save is off — use the per-row Translate button after editing."
                  : "Connect a free DeepL key on the Languages page for one-click translation, or translate it in Translate & Adapt."}
              </Text>
              {productErrors.length > 0 ? (
                <Banner tone="critical" title="Could not load products">
                  {productErrors.map((error) => (
                    <Text as="p" key={error}>
                      {error}
                    </Text>
                  ))}
                </Banner>
              ) : null}
              <InlineStack gap="200" blockAlign="end" wrap>
                <Box width="320px">
                  <TextField
                    label="Search products"
                    labelHidden
                    placeholder="Search products by title"
                    value={productQuery}
                    onChange={setProductQuery}
                    autoComplete="off"
                  />
                </Box>
                <Button onClick={applyProductSearch} loading={isNavigating}>
                  Search
                </Button>
              </InlineStack>
              {products.length === 0 ? (
                <Text as="p" tone="subdued" variant="bodySm">
                  No products found.
                </Text>
              ) : null}
              {products.map((product) => {
                const row = rowState(product);
                const before = initialRows[product.id];
                const rowDirty = !rowsEqual(row, before);
                const errors = validateRow(row);
                const rowHasErrors =
                  errors.boughtCountError !== undefined ||
                  errors.bestsellerError !== undefined;
                const stale =
                  product.boughtCount !== null &&
                  (product.boughtCountAgeDays === null ||
                    product.boughtCountAgeDays > STALE_DAYS);
                const fbtOpen = expandedFbtId === product.id;
                return (
                  <BlockStack key={product.id} gap="300">
                    <Divider />
                    <InlineStack gap="300" blockAlign="center" wrap>
                      {product.imageUrl ? (
                        <Thumbnail
                          source={product.imageUrl}
                          alt=""
                          size="small"
                        />
                      ) : null}
                      <BlockStack gap="050">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="h3" variant="headingSm">
                            {product.title}
                          </Text>
                          {product.status !== "ACTIVE" ? (
                            <Badge>{product.status.toLowerCase()}</Badge>
                          ) : null}
                          {stale ? (
                            <Badge tone="attention">
                              {`Count stale (>${STALE_DAYS} days) — hidden on the storefront`}
                            </Badge>
                          ) : null}
                        </InlineStack>
                        {product.boughtCountSetAt ? (
                          <Text as="p" tone="subdued" variant="bodySm">
                            Bought count set on {product.boughtCountSetAt}
                            {product.boughtCountAgeDays !== null
                              ? ` (${product.boughtCountAgeDays} day${product.boughtCountAgeDays === 1 ? "" : "s"} ago)`
                              : ""}
                          </Text>
                        ) : null}
                      </BlockStack>
                    </InlineStack>
                    <InlineStack gap="300" blockAlign="start" wrap>
                      <Box width="180px">
                        <TextField
                          label="Bought last month"
                          value={row.boughtCount}
                          onChange={(boughtCount) =>
                            setRow(product.id, { ...row, boughtCount })
                          }
                          error={errors.boughtCountError}
                          placeholder="e.g. 2000"
                          helpText="Empty or 0 hides it"
                          autoComplete="off"
                        />
                      </Box>
                      <Box width="120px">
                        <TextField
                          label="Bestseller rank"
                          value={row.rank}
                          onChange={(rank) =>
                            setRow(product.id, { ...row, rank })
                          }
                          placeholder="1"
                          autoComplete="off"
                        />
                      </Box>
                      <Box width="240px">
                        <TextField
                          label="Bestseller category"
                          value={row.category}
                          onChange={(category) =>
                            setRow(product.id, { ...row, category })
                          }
                          error={errors.bestsellerError}
                          placeholder="Anti-aging"
                          maxLength={60}
                          autoComplete="off"
                        />
                      </Box>
                      <Box paddingBlockStart="600">
                        <InlineStack gap="200">
                          <Button
                            onClick={() =>
                              setExpandedFbtId(fbtOpen ? null : product.id)
                            }
                            disclosure={fbtOpen ? "up" : "down"}
                          >
                            {`Bought-together override (${row.fbt.length === 0 ? "auto" : row.fbt.length})`}
                          </Button>
                          <Button
                            variant="primary"
                            onClick={() => saveRow(product)}
                            disabled={
                              !rowDirty ||
                              rowHasErrors ||
                              // One shared fetcher: a second submit would
                              // cancel an in-flight row save.
                              (productFetcher.state !== "idle" &&
                                pendingProductId !== product.id)
                            }
                            loading={pendingProductId === product.id}
                          >
                            Save
                          </Button>
                          <Button
                            onClick={() => runRowTranslate(product.id)}
                            disabled={
                              !canTranslate ||
                              // Translate what is SAVED — a dirty row would
                              // silently translate the old category.
                              rowDirty ||
                              product.bestsellerCategory.trim() === "" ||
                              (translateFetcher.state !== "idle" &&
                                pendingTranslateId !== product.id)
                            }
                            loading={pendingTranslateId === product.id}
                          >
                            Translate
                          </Button>
                        </InlineStack>
                      </Box>
                    </InlineStack>
                    {fbtOpen ? (
                      <Box
                        background="bg-surface-secondary"
                        borderRadius="200"
                        padding="300"
                      >
                        <BlockStack gap="300">
                          <Text as="p" tone="subdued" variant="bodySm">
                            Hand-pick up to {MAX_FBT_ITEMS} products
                            for “Frequently bought together” on this product
                            page. Leave the list empty for automatic
                            complementary recommendations.
                          </Text>
                          {row.fbt.length === 0 ? (
                            <Text as="p" tone="subdued" variant="bodySm">
                              No manual items — automatic recommendations.
                            </Text>
                          ) : (
                            <BlockStack gap="100">
                              {row.fbt.map((item) => (
                                <InlineStack
                                  key={item.variantId}
                                  gap="200"
                                  blockAlign="center"
                                >
                                  <Text as="span" variant="bodySm">
                                    {item.handle}
                                  </Text>
                                  <Button
                                    variant="plain"
                                    tone="critical"
                                    onClick={() =>
                                      setRow(product.id, {
                                        ...row,
                                        fbt: row.fbt.filter(
                                          (other) =>
                                            other.variantId !== item.variantId,
                                        ),
                                      })
                                    }
                                  >
                                    Remove
                                  </Button>
                                </InlineStack>
                              ))}
                            </BlockStack>
                          )}
                          <Box width="320px">
                            <TextField
                              label="Add a product"
                              labelHidden
                              placeholder="Search products to add"
                              value={fbtQuery}
                              onChange={setFbtQuery}
                              autoComplete="off"
                            />
                          </Box>
                          {fbtQuery.trim() !== "" ? (
                            <BlockStack gap="100">
                              {searchResults.slice(0, 6).map((variant) => {
                                const already = row.fbt.some(
                                  (item) => item.variantId === variant.id,
                                );
                                const full =
                                  row.fbt.length >= MAX_FBT_ITEMS;
                                return (
                                  <InlineStack
                                    key={variant.id}
                                    gap="200"
                                    blockAlign="center"
                                  >
                                    <Button
                                      variant="plain"
                                      disabled={already || full}
                                      onClick={() =>
                                        setRow(product.id, {
                                          ...row,
                                          fbt: [
                                            ...row.fbt,
                                            {
                                              variantId: variant.id,
                                              handle: variant.productHandle,
                                            },
                                          ],
                                        })
                                      }
                                    >
                                      {already
                                        ? "Added"
                                        : full
                                          ? "List full"
                                          : "Add"}
                                    </Button>
                                    <Text as="span" variant="bodySm">
                                      {variant.productTitle}
                                      {variant.title !== "Default Title"
                                        ? ` — ${variant.title}`
                                        : ""}
                                    </Text>
                                  </InlineStack>
                                );
                              })}
                              {variantSearch.state === "idle" &&
                              searchResults.length === 0 ? (
                                <Text as="p" tone="subdued" variant="bodySm">
                                  No matches.
                                </Text>
                              ) : null}
                            </BlockStack>
                          ) : null}
                          <Text as="p" tone="subdued" variant="bodySm">
                            Remember to press Save on this row — the override
                            is stored with the product.
                          </Text>
                        </BlockStack>
                      </Box>
                    ) : null}
                  </BlockStack>
                );
              })}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Market targeting
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Limit each pattern to selected markets. A feature must also be
                enabled above to appear anywhere.
              </Text>
              {markets.length === 0 ? (
                <Text as="p" tone="subdued" variant="bodySm">
                  No markets could be loaded — the features follow their “All
                  markets” setting.
                </Text>
              ) : null}
              {AZ_FEATURE_COPY.map((feature) => {
                const scope = state.scopes[feature.key];
                return (
                  <BlockStack key={feature.key} gap="200">
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
                                    checked={scope.markets.includes(
                                      market.handle,
                                    )}
                                    onChange={(checked) =>
                                      setState((previous) => {
                                        const set = new Set(
                                          previous.scopes[feature.key].markets,
                                        );
                                        if (checked) set.add(market.handle);
                                        else set.delete(market.handle);
                                        return {
                                          ...previous,
                                          scopes: {
                                            ...previous.scopes,
                                            [feature.key]: {
                                              mode: "selected",
                                              markets: [...set],
                                            },
                                          },
                                        };
                                      })
                                    }
                                  />
                                ))}
                                {scope.markets.length === 0 ? (
                                  <Text
                                    as="p"
                                    tone="critical"
                                    variant="bodySm"
                                  >
                                    No markets selected — this pattern won't
                                    appear anywhere.
                                  </Text>
                                ) : null}
                              </BlockStack>
                            ) : null,
                        },
                      ]}
                      selected={[scope.mode]}
                      onChange={(selected) => {
                        const mode =
                          selected[0] === "selected" ? "selected" : "all";
                        setState((previous) => ({
                          ...previous,
                          scopes: {
                            ...previous.scopes,
                            [feature.key]: {
                              mode,
                              // Keep the hand-picked list in local state so
                              // switching back restores it; the save patch
                              // strips it for "all".
                              markets: [
                                ...previous.scopes[feature.key].markets,
                              ],
                            },
                          },
                        }));
                      }}
                    />
                  </BlockStack>
                );
              })}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
