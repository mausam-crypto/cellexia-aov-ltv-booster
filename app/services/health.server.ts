import prisma from "../db.server";
import {
  getSettings,
  type BoosterSettings,
} from "../models/settings.server";
import { PDP_METAOBJECT_TYPES } from "./metaobjects.server";
import { getPreviewState } from "./preview.server";

/**
 * Setup & health checks (SPEC v4 §B).
 *
 * runHealthChecks(admin, session) returns the NINE ordered checks, always
 * fresh (the Setup page uses it). getCachedHealth(admin, session) is the
 * cheap variant for high-traffic surfaces (dashboard banner): it reuses a
 * per-shop summary for up to five minutes; invalidateHealthCache(shop)
 * drops the entry after anything health-relevant changes.
 *
 * Every check is individually try/caught and never breaks the page: a check
 * that throws a TRANSIENT error (network/transport/GraphQL throttling)
 * reports `warn` with a "temporary — re-run" detail; anything else reports
 * `fail` with the error message (theme reads degrade to `warn` — the
 * read_themes scope may simply not be granted yet).
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface SessionLike {
  shop: string;
}

export type HealthStatus = "pass" | "warn" | "fail";

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
  fixHint: string;
  /** Internal route ("/app/...") or absolute admin URL ("https://..."). */
  fixUrl?: string;
}

export interface HealthSummary {
  passing: number;
  total: number;
  failing: number;
  warnings: number;
}

export function summarizeHealth(checks: HealthCheck[]): HealthSummary {
  return {
    passing: checks.filter((check) => check.status === "pass").length,
    total: checks.length,
    failing: checks.filter((check) => check.status === "fail").length,
    warnings: checks.filter((check) => check.status === "warn").length,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Heuristic for transient GraphQL/transport failures (network drops, DNS
 * blips, timeouts, throttling, 5xx). These must surface as `warn` — a
 * momentary API hiccup is not a broken setup.
 */
function isTransientError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && (status === 429 || status >= 500)) {
    return true;
  }
  const message = errorMessage(error).toLowerCase();
  return [
    "fetch failed",
    "network",
    "socket hang up",
    "econnreset",
    "econnrefused",
    "etimedout",
    "enotfound",
    "eai_again",
    "epipe",
    "timeout",
    "timed out",
    "aborted",
    "throttl",
    "too many requests",
    "rate limit",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    "internal server error",
  ].some((needle) => message.includes(needle));
}

/**
 * Runs one check body; a transient throw becomes a `warn` ("temporary —
 * re-run"), any other throw becomes a `fail` with the error message.
 */
async function runCheck(
  id: string,
  label: string,
  body: () => Promise<Omit<HealthCheck, "id" | "label">>,
): Promise<HealthCheck> {
  try {
    return { id, label, ...(await body()) };
  } catch (error) {
    if (isTransientError(error)) {
      return {
        id,
        label,
        status: "warn",
        detail: `Temporary error while checking (${errorMessage(error)}) — re-run the checks.`,
        fixHint:
          "Usually a passing network or API hiccup — re-run the checks in a moment.",
      };
    }
    return {
      id,
      label,
      status: "fail",
      detail: `Check crashed: ${errorMessage(error)}`,
      fixHint: "Re-run the checks; if this persists, check the app logs.",
    };
  }
}

async function graphqlJson<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(
    query,
    variables ? { variables } : undefined,
  );
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// 1. config-metafields
// ---------------------------------------------------------------------------

const METAFIELDS_READBACK_QUERY = `#graphql
  query cellexiaHealthMetafields {
    currentAppInstallation {
      metafield(namespace: "cellexia", key: "config") {
        value
      }
    }
    shop {
      metafield(namespace: "$app:cellexia", key: "config") {
        value
      }
    }
  }
`;

interface ParsedConfig {
  version?: unknown;
  cartUpsell?: { enabled?: unknown };
}

function parseConfig(value: string | null | undefined): ParsedConfig | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as ParsedConfig;
  } catch {
    return null;
  }
}

/** version + a cheap settings fingerprint, compared against the DB truth. */
function configMatches(
  parsed: ParsedConfig | null,
  settings: BoosterSettings,
): boolean {
  return (
    parsed !== null &&
    parsed.version === settings.version &&
    parsed.cartUpsell?.enabled === settings.cartUpsell.enabled
  );
}

async function checkConfigMetafields(
  admin: AdminGraphqlClient,
  shop: string,
  settings: BoosterSettings,
): Promise<HealthCheck> {
  return runCheck(
    "config-metafields",
    "Config metafields in sync",
    async () => {
      const json = await graphqlJson<{
        data?: {
          currentAppInstallation?: { metafield?: { value?: string } | null };
          shop?: { metafield?: { value?: string } | null };
        };
      }>(admin, METAFIELDS_READBACK_QUERY);

      const liquidValue =
        json.data?.currentAppInstallation?.metafield?.value ?? null;
      const checkoutValue = json.data?.shop?.metafield?.value ?? null;
      const liquidParsed = parseConfig(liquidValue);
      const checkoutParsed = parseConfig(checkoutValue);

      const problems: string[] = [];
      if (!liquidParsed) {
        problems.push("the app-data metafield (theme widgets) is missing");
      } else if (!configMatches(liquidParsed, settings)) {
        problems.push("the app-data metafield (theme widgets) is stale");
      }
      if (!checkoutParsed) {
        problems.push("the shop metafield (checkout blocks) is missing");
      } else if (!configMatches(checkoutParsed, settings)) {
        problems.push("the shop metafield (checkout blocks) is stale");
      }

      // Security invariant (SPEC v4 preview principles): the raw preview
      // token must never reach the page-visible app-data metafield.
      const previewState = await getPreviewState(shop);
      if (
        previewState &&
        previewState.token &&
        typeof liquidValue === "string" &&
        liquidValue.includes(previewState.token)
      ) {
        problems.push(
          "SECURITY: the preview token leaked into the page-visible app-data metafield",
        );
      }

      if (problems.length > 0) {
        return {
          status: "fail" as const,
          detail: `Config readback mismatch: ${problems.join("; ")}.`,
          fixHint:
            "Save any setting (Settings page → Save) to re-sync both metafields, then re-run the checks.",
          fixUrl: "/app/settings",
        };
      }
      return {
        status: "pass" as const,
        detail:
          "Both config metafields exist and match the saved settings (version + fingerprint).",
        fixHint: "Nothing to do.",
      };
    },
  );
}

// ---------------------------------------------------------------------------
// 2 + 3. theme-embeds / theme-compat (one shared theme files query)
// ---------------------------------------------------------------------------

const THEME_FILES = [
  "config/settings_data.json",
  "sections/mini-cart.liquid",
  "sections/pdp.liquid",
] as const;

const THEME_FILES_QUERY = `#graphql
  query cellexiaHealthTheme($filenames: [String!]!) {
    themes(first: 5, roles: [MAIN]) {
      nodes {
        id
        files(filenames: $filenames, first: 10) {
          nodes {
            filename
            body {
              ... on OnlineStoreThemeFileBodyText {
                content
              }
            }
          }
        }
      }
    }
  }
`;

interface ThemeFilesResult {
  ok: boolean;
  error: string;
  /** filename -> text content (only files that came back as text). */
  contents: Map<string, string>;
}

async function fetchThemeFiles(
  admin: AdminGraphqlClient,
): Promise<ThemeFilesResult> {
  try {
    const json = await graphqlJson<{
      data?: {
        themes?: {
          nodes?: {
            id: string;
            files?: {
              nodes?: {
                filename: string;
                body?: { content?: string } | null;
              }[];
            } | null;
          }[];
        };
      };
      errors?: { message?: string }[];
    }>(admin, THEME_FILES_QUERY, { filenames: [...THEME_FILES] });

    const theme = json.data?.themes?.nodes?.[0];
    if (!theme) {
      const reason =
        json.errors?.map((e) => e.message).filter(Boolean).join("; ") ||
        "no published theme returned (is the read_themes scope granted?)";
      return { ok: false, error: reason, contents: new Map() };
    }
    const contents = new Map<string, string>();
    for (const file of theme.files?.nodes ?? []) {
      if (typeof file.body?.content === "string") {
        contents.set(file.filename, file.body.content);
      }
    }
    return { ok: true, error: "", contents };
  } catch (error) {
    return { ok: false, error: errorMessage(error), contents: new Map() };
  }
}

/** settings_data.json may carry a leading Liquid-style comment block. */
function parseSettingsData(content: string): Record<string, unknown> | null {
  try {
    const stripped = content.replace(/^\s*\/\*[\s\S]*?\*\//, "").trim();
    const parsed: unknown = JSON.parse(stripped);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface EmbedStatus {
  found: boolean;
  enabled: boolean;
}

/**
 * App-embed detection: `current.blocks` entries whose type includes our
 * embed handle ("blocks/cart-booster" / "blocks/pdp-booster") and are not
 * disabled. `current` may be a preset name string — resolve via `presets`.
 */
function detectEmbed(
  settingsData: Record<string, unknown>,
  needle: string,
): EmbedStatus {
  let current: unknown = settingsData.current;
  if (typeof current === "string") {
    const presets = settingsData.presets;
    current =
      typeof presets === "object" && presets !== null
        ? (presets as Record<string, unknown>)[current]
        : null;
  }
  if (typeof current !== "object" || current === null) {
    return { found: false, enabled: false };
  }
  const blocks = (current as Record<string, unknown>).blocks;
  if (typeof blocks !== "object" || blocks === null) {
    return { found: false, enabled: false };
  }
  for (const entry of Object.values(blocks as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const block = entry as { type?: unknown; disabled?: unknown };
    if (typeof block.type === "string" && block.type.includes(needle)) {
      return { found: true, enabled: block.disabled !== true };
    }
  }
  return { found: false, enabled: false };
}

async function checkThemeEmbeds(
  theme: ThemeFilesResult,
  themeEditorUrl: string,
): Promise<HealthCheck> {
  return runCheck("theme-embeds", "Theme app embeds enabled", async () => {
    if (!theme.ok) {
      return {
        status: "warn" as const,
        detail: `Could not read the published theme (${theme.error}).`,
        fixHint:
          "Verify the app embeds manually in the theme editor (Apps section) — Cart booster and PDP booster must be enabled.",
        fixUrl: themeEditorUrl,
      };
    }
    const raw = theme.contents.get("config/settings_data.json");
    const settingsData = raw ? parseSettingsData(raw) : null;
    if (!settingsData) {
      return {
        status: "warn" as const,
        detail:
          "Could not read config/settings_data.json from the published theme.",
        fixHint:
          "Verify the app embeds manually in the theme editor (Apps section).",
        fixUrl: themeEditorUrl,
      };
    }
    const cart = detectEmbed(settingsData, "blocks/cart-booster");
    const pdp = detectEmbed(settingsData, "blocks/pdp-booster");
    const problems: string[] = [];
    if (!cart.found) problems.push("Cart booster embed is not added");
    else if (!cart.enabled) problems.push("Cart booster embed is disabled");
    if (!pdp.found) problems.push("PDP booster embed is not added");
    else if (!pdp.enabled) problems.push("PDP booster embed is disabled");
    if (problems.length > 0) {
      return {
        status: "fail" as const,
        detail: `${problems.join("; ")}. Without the embeds, no cart or product-page widget can render.`,
        fixHint:
          "Open the theme editor's App embeds panel and enable Cart booster and PDP booster, then save the theme.",
        fixUrl: themeEditorUrl,
      };
    }
    return {
      status: "pass" as const,
      detail:
        "Cart booster and PDP booster app embeds are present and enabled on the published theme.",
      fixHint: "Nothing to do.",
    };
  });
}

async function checkThemeCompat(theme: ThemeFilesResult): Promise<HealthCheck> {
  return runCheck("theme-compat", "Theme selectors compatible", async () => {
    if (!theme.ok) {
      return {
        status: "warn" as const,
        detail: `Could not read the published theme (${theme.error}).`,
        fixHint:
          "Once theme access works, this check verifies the selectors the widgets attach to (mini-cart__list, pdp__grey).",
      };
    }
    const problems: string[] = [];
    const miniCart = theme.contents.get("sections/mini-cart.liquid");
    if (!miniCart) {
      problems.push("sections/mini-cart.liquid was not found");
    } else if (!miniCart.includes("mini-cart__list")) {
      problems.push(
        'sections/mini-cart.liquid no longer contains "mini-cart__list" (cart widgets anchor there)',
      );
    }
    const pdp = theme.contents.get("sections/pdp.liquid");
    if (!pdp) {
      problems.push("sections/pdp.liquid was not found");
    } else if (!pdp.includes("pdp__grey")) {
      problems.push(
        'sections/pdp.liquid no longer contains "pdp__grey" (PDP widgets anchor there)',
      );
    }
    if (problems.length > 0) {
      return {
        status: "warn" as const,
        detail: `${problems.join("; ")}.`,
        fixHint:
          "The widgets fall back to app-block placement, but check the storefront visually after theme changes.",
      };
    }
    return {
      status: "pass" as const,
      detail:
        "The published theme still contains the selectors the widgets target (mini-cart__list, pdp__grey).",
      fixHint: "Nothing to do.",
    };
  });
}

// ---------------------------------------------------------------------------
// 4. webhooks
// ---------------------------------------------------------------------------

const WEBHOOKS_QUERY = `#graphql
  query cellexiaHealthWebhooks {
    webhookSubscriptions(first: 25) {
      nodes {
        topic
      }
    }
  }
`;

/** How recent an OrderStat row must be to count as delivery evidence. */
const WEBHOOK_DELIVERY_EVIDENCE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * TOML-managed (app-specific) webhook subscriptions do NOT appear in the
 * shop-scoped `webhookSubscriptions` query — only API-created, shop-specific
 * subscriptions do. So an empty result is EXPECTED for this app and must not
 * fail the check: fall back to delivery evidence (a recent OrderStat row
 * proves orders/paid deliveries are flowing end-to-end).
 */
async function checkWebhooks(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<HealthCheck> {
  return runCheck("webhooks", "Webhooks registered", async () => {
    const json = await graphqlJson<{
      data?: { webhookSubscriptions?: { nodes?: { topic: string }[] } };
    }>(admin, WEBHOOKS_QUERY);
    const topics = new Set(
      (json.data?.webhookSubscriptions?.nodes ?? []).map((node) => node.topic),
    );
    if (topics.has("ORDERS_PAID") && topics.has("APP_UNINSTALLED")) {
      return {
        status: "pass" as const,
        detail: "orders/paid and app/uninstalled subscriptions are registered.",
        fixHint: "Nothing to do.",
      };
    }

    const latestOrderStat = await prisma.orderStat.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (
      latestOrderStat &&
      Date.now() - latestOrderStat.createdAt.getTime() <=
        WEBHOOK_DELIVERY_EVIDENCE_MS
    ) {
      return {
        status: "pass" as const,
        detail: `Webhooks verified by delivery: the orders/paid webhook recorded an order on ${latestOrderStat.createdAt.toISOString().slice(0, 10)} (app-specific subscriptions are declared in the app configuration and do not appear in the shop-scoped subscription list).`,
        fixHint: "Nothing to do.",
      };
    }
    return {
      status: "warn" as const,
      detail:
        "Webhooks are declared in the app configuration and register at deploy; delivery will be verified after the first paid order.",
      fixHint:
        "Nothing to fix for a new store. For production, Shopify's Protected customer data approval is required before orders/paid deliveries flow — request it in the Partner Dashboard (App setup → Protected customer data access).",
    };
  });
}

// ---------------------------------------------------------------------------
// 5. protection-product (read-only)
// ---------------------------------------------------------------------------

const PROTECTION_HANDLE = "cellexia-order-protection";

const PROTECTION_QUERY = `#graphql
  query cellexiaHealthProtection($query: String!) {
    products(first: 1, query: $query) {
      nodes {
        id
        status
        publishedAt
      }
    }
  }
`;

async function checkProtectionProduct(
  admin: AdminGraphqlClient,
  settings: BoosterSettings,
): Promise<HealthCheck> {
  return runCheck(
    "protection-product",
    "Order Protection product",
    async () => {
      if (!settings.checkoutProtection.enabled) {
        return {
          status: "pass" as const,
          detail: "Order Protection is disabled — nothing to verify.",
          fixHint:
            "If you enable it later, the Checkout features page creates the product for you.",
        };
      }
      if (!settings.checkoutProtection.variantId) {
        return {
          status: "fail" as const,
          detail:
            "Order Protection is enabled but no protection variant is configured, so checkout has nothing to sell.",
          fixHint:
            "Open the Checkout features page and create/select the Order Protection product.",
          fixUrl: "/app/features/checkout",
        };
      }
      const json = await graphqlJson<{
        data?: {
          products?: {
            nodes?: { id: string; status: string; publishedAt: string | null }[];
          };
        };
      }>(admin, PROTECTION_QUERY, { query: `handle:${PROTECTION_HANDLE}` });
      const product = json.data?.products?.nodes?.[0];
      if (!product) {
        return {
          status: "fail" as const,
          detail: `No product with handle "${PROTECTION_HANDLE}" exists.`,
          fixHint:
            "Open the Checkout features page and use “Create protection product”.",
          fixUrl: "/app/features/checkout",
        };
      }
      if (product.status !== "ACTIVE") {
        return {
          status: "fail" as const,
          detail: `The Order Protection product exists but its status is ${product.status}, so checkout cannot sell it.`,
          fixHint:
            "Set the product to Active in the Shopify admin, then re-run the checks.",
          fixUrl: "/app/features/checkout",
        };
      }
      if (!product.publishedAt) {
        return {
          status: "fail" as const,
          detail:
            "The Order Protection product is not published to the Online Store channel, so checkout cannot add it to the cart.",
          fixHint:
            "Re-run “Create protection product” on the Checkout features page (it publishes the product), or publish it manually.",
          fixUrl: "/app/features/checkout",
        };
      }
      return {
        status: "pass" as const,
        detail:
          "The Order Protection product exists, is Active, and is published to the Online Store.",
        fixHint: "Nothing to do.",
      };
    },
  );
}

// ---------------------------------------------------------------------------
// 6. metaobject-definitions
// ---------------------------------------------------------------------------

const METAOBJECT_DEFS_QUERY = `#graphql
  query cellexiaHealthMetaobjectDefs {
    studyResult: metaobjectDefinitionByType(type: "${PDP_METAOBJECT_TYPES.studyResult}") { id }
    clinicalStudy: metaobjectDefinitionByType(type: "${PDP_METAOBJECT_TYPES.clinicalStudy}") { id }
    beforeAfter: metaobjectDefinitionByType(type: "${PDP_METAOBJECT_TYPES.beforeAfter}") { id }
    ingredient: metaobjectDefinitionByType(type: "${PDP_METAOBJECT_TYPES.ingredient}") { id }
    coa: metaobjectDefinitionByType(type: "${PDP_METAOBJECT_TYPES.coa}") { id }
    batchTransparency: metaobjectDefinitionByType(type: "${PDP_METAOBJECT_TYPES.batchTransparency}") { id }
  }
`;

async function checkMetaobjectDefinitions(
  admin: AdminGraphqlClient,
): Promise<HealthCheck> {
  return runCheck(
    "metaobject-definitions",
    "Booster content model",
    async () => {
      const json = await graphqlJson<{
        data?: Record<string, { id: string } | null | undefined>;
      }>(admin, METAOBJECT_DEFS_QUERY);
      const aliasToType: Record<string, string> = {
        studyResult: PDP_METAOBJECT_TYPES.studyResult,
        clinicalStudy: PDP_METAOBJECT_TYPES.clinicalStudy,
        beforeAfter: PDP_METAOBJECT_TYPES.beforeAfter,
        ingredient: PDP_METAOBJECT_TYPES.ingredient,
        coa: PDP_METAOBJECT_TYPES.coa,
        batchTransparency: PDP_METAOBJECT_TYPES.batchTransparency,
      };
      const missing = Object.entries(aliasToType)
        .filter(([alias]) => !json.data?.[alias]?.id)
        .map(([, type]) => type);
      if (missing.length > 0) {
        return {
          status: "fail" as const,
          detail: `Missing metaobject definitions: ${missing.join(", ")}. Product booster content cannot be saved or rendered without them.`,
          fixHint:
            "Open the Product boosters page once — it creates all six definitions automatically.",
          fixUrl: "/app/products",
        };
      }
      return {
        status: "pass" as const,
        detail: "All six Cellexia metaobject definitions exist.",
        fixHint: "Nothing to do.",
      };
    },
  );
}

// ---------------------------------------------------------------------------
// 7. locales
// ---------------------------------------------------------------------------

/** Languages our extensions ship locale files for (see app.localization). */
const SHIPPED_LOCALES = [
  "ar",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fi",
  "fr",
  "hu",
  "it",
  "ja",
  "nl",
  "no",
  "pl",
  "pt-PT",
  "ro",
  "sv",
] as const;

function isLocaleCovered(locale: string): boolean {
  const normalized = locale.toLowerCase();
  const shipped = SHIPPED_LOCALES.map((code) => code.toLowerCase());
  if (shipped.includes(normalized)) return true;
  // Checkout extensions additionally ship nb.json (Norwegian Bokmål).
  if (normalized === "nb" || normalized.startsWith("nb-")) return true;
  const base = normalized.split("-")[0];
  return shipped.includes(base);
}

const SHOP_LOCALES_QUERY = `#graphql
  query cellexiaHealthLocales {
    shopLocales {
      locale
      published
    }
  }
`;

async function checkLocales(admin: AdminGraphqlClient): Promise<HealthCheck> {
  return runCheck("locales", "Storefront languages covered", async () => {
    const json = await graphqlJson<{
      data?: { shopLocales?: { locale: string; published: boolean }[] };
    }>(admin, SHOP_LOCALES_QUERY);
    const published = (json.data?.shopLocales ?? []).filter(
      (locale) => locale.published,
    );
    const gaps = published
      .map((locale) => locale.locale)
      .filter((locale) => !isLocaleCovered(locale));
    if (gaps.length > 0) {
      return {
        status: "warn" as const,
        detail: `Published languages without shipped widget translations: ${gaps.join(", ")}. Widgets fall back to English there.`,
        fixHint:
          "Add translations via Translate & Adapt, or request new locale files for these languages.",
        fixUrl: "/app/localization",
      };
    }
    return {
      status: "pass" as const,
      detail: `All ${published.length} published storefront language${published.length === 1 ? "" : "s"} are covered by the shipped translations.`,
      fixHint: "Nothing to do.",
    };
  });
}

// ---------------------------------------------------------------------------
// 8. orders-data
// ---------------------------------------------------------------------------

async function checkOrdersData(shop: string): Promise<HealthCheck> {
  return runCheck("orders-data", "Order analytics data", async () => {
    const count = await prisma.orderStat.count({ where: { shop } });
    if (count === 0) {
      return {
        status: "warn" as const,
        detail:
          "No order data recorded yet — analytics and experiment reports populate after the first paid order reaches the orders/paid webhook.",
        fixHint:
          "Nothing to fix if the store is new. For production, Shopify's Protected customer data approval is required for order webhooks.",
      };
    }
    return {
      status: "pass" as const,
      detail: `${count} order${count === 1 ? "" : "s"} recorded — analytics are flowing.`,
      fixHint: "Nothing to do.",
    };
  });
}

// ---------------------------------------------------------------------------
// 9. preview-hygiene
// ---------------------------------------------------------------------------

const PREVIEW_STALE_MS = 48 * 60 * 60 * 1000;

async function checkPreviewHygiene(shop: string): Promise<HealthCheck> {
  return runCheck("preview-hygiene", "Preview hygiene", async () => {
    const state = await getPreviewState(shop);
    if (!state || !state.armed) {
      return {
        status: "pass" as const,
        detail: "Preview is disarmed — real visitors get the pure live rendering.",
        fixHint: "Nothing to do.",
      };
    }
    const armedAt = state.armedAt ? new Date(state.armedAt).getTime() : NaN;
    const ageMs = Number.isFinite(armedAt) ? Date.now() - armedAt : Infinity;
    if (ageMs > PREVIEW_STALE_MS) {
      const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      return {
        status: "warn" as const,
        detail: `Preview has been armed for ${Number.isFinite(ageMs) ? `${days} day${days === 1 ? "" : "s"}` : "an unknown time"}. Armed previews ship inert draft templates to real visitors — harmless but unnecessary.`,
        fixHint: "Disarm the preview from the Preview Center when you are done.",
        fixUrl: "/app/preview",
      };
    }
    return {
      status: "pass" as const,
      detail: `Preview is armed (since ${state.armedAt ? new Date(state.armedAt).toISOString() : "recently"}) — fine while you are actively previewing.`,
      fixHint: "Disarm from the Preview Center when you finish previewing.",
      fixUrl: "/app/preview",
    };
  });
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runHealthChecks(
  admin: AdminGraphqlClient,
  session: SessionLike,
): Promise<HealthCheck[]> {
  const shop = session.shop;
  const storePrefix = shop.replace(".myshopify.com", "");
  const themeEditorUrl = `https://admin.shopify.com/store/${storePrefix}/themes/current/editor?context=apps`;

  let settings: BoosterSettings;
  try {
    settings = await getSettings(shop);
  } catch (error) {
    // Without settings, most comparisons are meaningless — report the crash
    // on check 1 and still run the settings-independent checks.
    const crashed: HealthCheck = {
      id: "config-metafields",
      label: "Config metafields in sync",
      status: "fail",
      detail: `Could not load settings from the database: ${errorMessage(error)}`,
      fixHint: "Check the app database, then re-run the checks.",
    };
    const theme = await fetchThemeFiles(admin);
    return [
      crashed,
      await checkThemeEmbeds(theme, themeEditorUrl),
      await checkThemeCompat(theme),
      await checkWebhooks(admin, shop),
      {
        id: "protection-product",
        label: "Order Protection product",
        status: "fail",
        detail: "Skipped — settings could not be loaded.",
        fixHint: "Fix the settings load error above first.",
      },
      await checkMetaobjectDefinitions(admin),
      await checkLocales(admin),
      await checkOrdersData(shop),
      await checkPreviewHygiene(shop),
    ];
  }

  const theme = await fetchThemeFiles(admin);
  const [
    configMetafields,
    themeEmbeds,
    themeCompat,
    webhooks,
    protectionProduct,
    metaobjectDefinitions,
    locales,
    ordersData,
    previewHygiene,
  ] = await Promise.all([
    checkConfigMetafields(admin, shop, settings),
    checkThemeEmbeds(theme, themeEditorUrl),
    checkThemeCompat(theme),
    checkWebhooks(admin, shop),
    checkProtectionProduct(admin, settings),
    checkMetaobjectDefinitions(admin),
    checkLocales(admin),
    checkOrdersData(shop),
    checkPreviewHygiene(shop),
  ]);

  return [
    configMetafields,
    themeEmbeds,
    themeCompat,
    webhooks,
    protectionProduct,
    metaobjectDefinitions,
    locales,
    ordersData,
    previewHygiene,
  ];
}

// ---------------------------------------------------------------------------
// Cached runner (dashboard banner etc. — runHealthChecks stays fresh-always)
// ---------------------------------------------------------------------------

interface CachedHealthEntry {
  at: number;
  summary: HealthSummary;
}

const healthSummaryCache = new Map<string, CachedHealthEntry>();

/**
 * Returns the shop's health summary, re-running the full checks only when
 * the cached summary is older than `maxAgeMs` (default five minutes). Meant
 * for surfaces rendered on every navigation (dashboard banner) — the Setup
 * page keeps calling runHealthChecks directly for always-fresh results.
 */
export async function getCachedHealth(
  admin: AdminGraphqlClient,
  session: SessionLike,
  { maxAgeMs = 5 * 60 * 1000 }: { maxAgeMs?: number } = {},
): Promise<HealthSummary> {
  const cached = healthSummaryCache.get(session.shop);
  if (cached && Date.now() - cached.at <= maxAgeMs) {
    return cached.summary;
  }
  const summary = summarizeHealth(await runHealthChecks(admin, session));
  healthSummaryCache.set(session.shop, { at: Date.now(), summary });
  return summary;
}

/**
 * Drops the cached summary for a shop — call after anything that can change
 * a check's outcome (settings save, preview arm/disarm, deploy actions).
 */
export function invalidateHealthCache(shop: string): void {
  healthSummaryCache.delete(shop);
}
