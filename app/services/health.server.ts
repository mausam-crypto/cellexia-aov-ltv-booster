import prisma from "../db.server";
import {
  getSettings,
  FEATURE_DEFS,
  type BoosterSettings,
} from "../models/settings.server";
import { PDP_METAOBJECT_TYPES } from "./metaobjects.server";
import { getPreviewState } from "./preview.server";
import { listMarkets } from "./markets.server";
import {
  findRewardsFunctionId,
  getRewardsState,
  pausedByMarket,
  readDiscountNodes,
} from "./rewards.server";

/**
 * Setup & health checks (SPEC v4 §B).
 *
 * runHealthChecks(admin, session) returns the SEVENTEEN ordered checks (v14:
 * + rewards-discounts, gift-products; v15: + storefront-islands), always
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

type ParsedConfig = Record<string, unknown>;

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

/** Key-order-independent structural equality (sync-time serialization and
 *  getSettings() merge order are not guaranteed identical). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a as object);
  const keysB = Object.keys(b as object);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    deepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ),
  );
}

/**
 * v8.23 (review catch): the old fingerprint was version + ONE flag —
 * version is a constant, so a metafield stale in any OTHER section (a
 * failed sync after a market-scope edit, a feature toggle, the v8.22
 * copy fields) read back as "in sync" forever. Now the WHOLE metafield
 * content must structurally equal the saved settings; the `preview` key
 * is the sync-time injection (armed state) and is excluded.
 */
function configMatches(
  parsed: ParsedConfig | null,
  settings: BoosterSettings,
): boolean {
  if (parsed === null) return false;
  const { preview: _preview, ...content } = parsed;
  return deepEqual(content, settings as unknown as Record<string, unknown>);
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
    currentAppInstallation {
      app {
        handle
      }
    }
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
  /** v8.23: OUR app's handle (the apps/<handle> segment of legit embed
   *  entries) — null when the API did not return it. */
  appHandle: string | null;
}

async function fetchThemeFiles(
  admin: AdminGraphqlClient,
): Promise<ThemeFilesResult> {
  try {
    const json = await graphqlJson<{
      data?: {
        currentAppInstallation?: {
          app?: { handle?: string | null } | null;
        } | null;
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

    const rawHandle = json.data?.currentAppInstallation?.app?.handle;
    const appHandle =
      typeof rawHandle === "string" && rawHandle !== "" ? rawHandle : null;
    const theme = json.data?.themes?.nodes?.[0];
    if (!theme) {
      const reason =
        json.errors?.map((e) => e.message).filter(Boolean).join("; ") ||
        "no published theme returned (is the read_themes scope granted?)";
      return { ok: false, error: reason, contents: new Map(), appHandle };
    }
    const contents = new Map<string, string>();
    for (const file of theme.files?.nodes ?? []) {
      if (typeof file.body?.content === "string") {
        contents.set(file.filename, file.body.content);
      }
    }
    return { ok: true, error: "", contents, appHandle };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      contents: new Map(),
      appHandle: null,
    };
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
  /** v8.23: ALL matching settings_data block types
   *  ("shopify://apps/<app-handle>/blocks/<extension-handle>/<uuid>") —
   *  disabled leftovers from re-linked/dev apps linger in settings_data,
   *  so a single first-match would let a dead entry shadow the live one
   *  (review catch). enabledTypes carries only the non-disabled ones. */
  types: string[];
  enabledTypes: string[];
}

/**
 * App-embed detection: EVERY `current.blocks` entry whose type carries our
 * embed handle as a full path segment ("…/blocks/cart-booster/<uuid>").
 * `current` may be a preset name string — resolve via `presets`. Collects
 * all matches: settings_data keeps one entry per app per embed and
 * disabled leftovers persist, so "the first match" is not "the live one".
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
  const none: EmbedStatus = { found: false, enabled: false, types: [], enabledTypes: [] };
  if (typeof current !== "object" || current === null) return none;
  const blocks = (current as Record<string, unknown>).blocks;
  if (typeof blocks !== "object" || blocks === null) return none;
  const types: string[] = [];
  const enabledTypes: string[] = [];
  for (const entry of Object.values(blocks as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const block = entry as { type?: unknown; disabled?: unknown };
    if (typeof block.type === "string" && block.type.includes(`${needle}/`)) {
      types.push(block.type);
      if (block.disabled !== true) enabledTypes.push(block.type);
    }
  }
  return { found: types.length > 0, enabled: enabledTypes.length > 0, types, enabledTypes };
}

/** v8.23: the apps/<handle> segment of an embed block type. */
function embedAppHandle(type: string | null): string | null {
  const match = /^shopify:\/\/apps\/([^/]+)\/blocks\//.exec(type ?? "");
  return match ? match[1] : null;
}

interface EmbedsSnapshot {
  cart: boolean;
  pdp: boolean;
  any: boolean;
}

/**
 * v8.23: shared enabled-status snapshot for the OTHER checks (the
 * deployed-extension escalation). null = the theme could not be read, so
 * nothing should escalate on the strength of it.
 */
function embedsEnabledFromTheme(theme: ThemeFilesResult): EmbedsSnapshot | null {
  if (!theme.ok) return null;
  const raw = theme.contents.get("config/settings_data.json");
  const settingsData = raw ? parseSettingsData(raw) : null;
  if (!settingsData) return null;
  const cart = detectEmbed(settingsData, "blocks/cart-booster");
  const pdp = detectEmbed(settingsData, "blocks/pdp-booster");
  return {
    cart: cart.found && cart.enabled,
    pdp: pdp.found && pdp.enabled,
    any: (cart.found && cart.enabled) || (pdp.found && pdp.enabled),
  };
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
    // v8.23 (deploy-incident class): the theme's embed entries carry the
    // OWNING APP's handle — if the extensions were last deployed under a
    // DIFFERENT app (a re-linked fork, a dev app, a fresh `config link`),
    // the storefront reads THAT app's config metafield, which this admin
    // never writes: every widget goes dark while every admin page (and the
    // config check above) stays green. Compare each entry's app segment
    // against the app this admin session belongs to.
    if (theme.appHandle) {
      // Judge only the ENABLED entries: settings_data keeps disabled
      // leftovers (dev apps, past re-links) forever, and those are inert.
      // An enabled entry under a foreign app IS the incident: the
      // storefront reads THAT app's (empty) config while this admin stays
      // green. An enabled OURS alongside a foreign one is fine — ours
      // renders.
      const foreign = [
        ["Cart booster", cart.enabledTypes],
        ["PDP booster", pdp.enabledTypes],
      ] as const;
      const problems2: string[] = [];
      for (const [label, enabledTypes] of foreign) {
        const handles = enabledTypes
          .map((type) => embedAppHandle(type))
          .filter((handle): handle is string => typeof handle === "string");
        const ours = handles.some(
          (handle) => handle.toLowerCase() === theme.appHandle!.toLowerCase(),
        );
        const others = handles.filter(
          (handle) => handle.toLowerCase() !== theme.appHandle!.toLowerCase(),
        );
        if (!ours && others.length > 0) {
          problems2.push(`${label} embed belongs to app "${others[0]}"`);
        }
      }
      if (problems2.length > 0) {
        return {
          status: "fail" as const,
          detail: `The published theme's ${problems2.join(" and ")}, but this admin is app "${theme.appHandle}". The storefront reads the OTHER app's (empty) config, so every widget renders nothing while this admin looks normal — the signature of a deploy made under the wrong app.`,
          fixHint:
            "Redeploy the extensions from the production app (the shopify.app.toml whose client_id belongs to THIS admin app), or re-enable this app's embeds in the theme editor and remove the foreign ones. Never `shopify app config link` to a new app before deploying. (If the app itself was recently RENAMED, its handle changed — re-toggle the embeds once to refresh the recorded reference.)",
          fixUrl: themeEditorUrl,
        };
      }
    }
    // v8.7: the proof-library widgets (press / endorsements / results) ride
    // their own embed. Its absence only matters when those features are
    // used, so it degrades to warn — but silently-invisible widgets cost a
    // real merchant a confused preview session, hence the explicit probe.
    const proof = detectEmbed(settingsData, "blocks/proof-booster");
    if (!proof.found || !proof.enabled) {
      return {
        status: "warn" as const,
        detail: `Cart and PDP booster embeds are enabled, but the "Cellexia proof library" embed is ${proof.found ? "disabled" : "not added"} — the press band, endorsement wall and results gallery cannot render (even in preview) until it is on.`,
        fixHint:
          "Only needed if you use the proof-library widgets: theme editor → App embeds → enable “Cellexia proof library”, then save the theme.",
        fixUrl: themeEditorUrl,
      };
    }
    return {
      status: "pass" as const,
      detail:
        "Cart booster, PDP booster and proof library app embeds are present and enabled on the published theme.",
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
// 10. app-proxy (end-to-end probe)
// ---------------------------------------------------------------------------

/**
 * Probes the storefront App Proxy path end-to-end: fetches
 * https://<shop>/apps/cellexia/track, which Shopify must forward (signed) to
 * this app's /proxy/track loader — that loader answers
 * {"ok":true,"service":"cellexia-booster"}. This is the wiring behind preview
 * links, analytics beacons and the cart-data endpoint; a placeholder or
 * missing [app_proxy] configuration is invisible everywhere else in the
 * admin, so this check exists to make it loud.
 */
async function checkAppProxy(shop: string): Promise<HealthCheck> {
  return runCheck("app-proxy", "App proxy reachable", async () => {
    const probeUrl = `https://${shop}/apps/cellexia/track`;
    // Render.com injects RENDER_EXTERNAL_URL — same fallback chain as the
    // appUrl in shopify.server.ts, so the hint matches what the app runs on.
    const expectedUpstream = `${(process.env.SHOPIFY_APP_URL || process.env.RENDER_EXTERNAL_URL || "https://<your-app-host>").replace(/\/+$/, "")}/proxy`;
    const fixHint =
      `The App Proxy must forward /apps/cellexia to ${expectedUpstream}. ` +
      `Set [app_proxy] url = "${expectedUpstream}" (prefix "apps", subpath "cellexia") in shopify.app.toml and run npm run deploy — ` +
      `or configure it in the Partner Dashboard under App setup → App proxy.`;

    let response: Response;
    let text = "";
    try {
      response = await fetch(probeUrl, {
        redirect: "follow",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      text = await response.text();
    } catch (error) {
      return {
        status: "warn" as const,
        detail: `Could not reach ${probeUrl} from the app server (${errorMessage(error)}). Open it in a browser: it should return {"ok":true,"service":"cellexia-booster"}.`,
        fixHint,
      };
    }

    let parsed: { ok?: unknown; service?: unknown } | null = null;
    try {
      parsed = JSON.parse(text) as { ok?: unknown; service?: unknown };
    } catch {
      parsed = null;
    }

    if (parsed?.service === "cellexia-booster") {
      return {
        status: "pass" as const,
        detail:
          "The storefront /apps/cellexia path reaches this app — preview links, beacons and cart data are wired.",
        fixHint: "Nothing to do.",
      };
    }
    if (
      response.status === 200 &&
      /password/i.test(text) &&
      text.includes("<html")
    ) {
      return {
        status: "warn" as const,
        detail:
          "The store appears to be password-protected, so the proxy could not be verified from the server. Open the probe URL in a browser while logged in to the storefront.",
        fixHint,
      };
    }
    if (response.status === 404) {
      return {
        status: "fail" as const,
        detail: `Shopify returned 404 for ${probeUrl} — the App Proxy is not registered (or was dropped by a config link). Preview links, analytics beacons and cart data ALL depend on it.`,
        fixHint,
      };
    }
    return {
      status: "fail" as const,
      detail: `${probeUrl} answered HTTP ${response.status} with something that is not this app — the App Proxy likely points at the wrong host or path (it must target ${expectedUpstream}, note the /proxy suffix).`,
      fixHint,
    };
  });
}

// ---------------------------------------------------------------------------
// 11. deployed-extension (info-grade drift probe)
// ---------------------------------------------------------------------------

/**
 * Shopify serves theme-extension assets under
 * /extensions/<uuid>/<version-label>/assets/<file>. The middle segment is
 * the APP VERSION LABEL the deploying party chose (`shopify app deploy`
 * defaults to "<app-name>-<N>", but CI pipelines pass --version and real
 * stores serve git SHAs there) — this repo does not control it and MUST
 * NOT match on it (review catch: the old pattern hard-coded
 * "cellexia-aov-ltv-booster-<N>" and would have false-alarmed forever on
 * any relabeled deploy). Presence detection anchors on OUR OWN asset
 * filenames; the label is only reported opportunistically.
 */
const EXTENSION_ASSET_PATTERN =
  /\/extensions\/[^"']+\/([^/"']+)\/assets\/cellexia-(?:booster\.css|pdp\.js|cart\.js|proof\.js)/;

/** Secondary presence signals this repo ships: the config islands and the
 *  cart embed's session beacon (emitted on every page the embed renders). */
const EXTENSION_MARKUP_SIGNALS = [
  'id="cx-pdp-config"',
  'id="cx-cart-config"',
  "apps/cellexia/track",
] as const;

function extensionPresence(html: string | null): {
  present: boolean;
  label: string | null;
} {
  if (!html) return { present: false, label: null };
  const match = html.match(EXTENSION_ASSET_PATTERN);
  if (match) return { present: true, label: match[1] };
  return {
    present: EXTENSION_MARKUP_SIGNALS.some((signal) => html.includes(signal)),
    label: null,
  };
}

async function fetchStorefrontText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { Accept: "text/html,application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/** v8.23: any THEME-side feature on? (checkout_* features render in the
 *  checkout, not through the theme embeds — they must never make a blank
 *  storefront page look like an incident.) */
function anyThemeFeatureOn(settings: BoosterSettings): boolean {
  return Object.entries(FEATURE_DEFS).some(
    ([key, def]) => !key.startsWith("checkout") && def.get(settings),
  );
}

/** Password-protected storefronts serve a 200 password page — no embed
 *  markup there is not an incident. */
function looksPasswordProtected(html: string): boolean {
  return html.includes('action="/password"') || html.includes("id=\"password\"");
}

/**
 * Detects the theme-extension build number the storefront actually serves.
 * Tries the home page first, then falls back to the first product page.
 *
 * v8.23 ESCALATION (the "deploy blanked the site while the admin looked
 * normal" incident): when the PRODUCT page was fetched successfully, is not
 * password-protected, theme features are enabled AND the theme check says
 * the embeds are on — yet the page carries ZERO Cellexia extension markup —
 * that is no longer a soft warn: it is the incident signature (config
 * carrier gone, wrong-app deploy, or a dead extension reference) and FAILS
 * loudly. Every fetch/read failure still degrades to `warn`.
 */
/**
 * v15: the storefront HTML both page-level checks read — fetched ONCE per
 * health run (deployed-extension + storefront-islands share it). `home` and
 * `product` are null when the fetch failed; `product` is also null when the
 * store has no product / products.json is unreachable.
 */
export interface StorefrontPages {
  home: string | null;
  product: string | null;
  productHandle: string | null;
}

async function loadStorefrontPages(shop: string): Promise<StorefrontPages> {
  const home = await fetchStorefrontText(`https://${shop}/`);
  let handle: string | null = null;
  const productsJson = await fetchStorefrontText(`https://${shop}/products.json?limit=1`);
  if (productsJson) {
    try {
      const parsed = JSON.parse(productsJson) as { products?: { handle?: unknown }[] };
      const first = parsed.products?.[0]?.handle;
      handle = typeof first === "string" && first !== "" ? first : null;
    } catch {
      handle = null;
    }
  }
  const product = handle
    ? await fetchStorefrontText(`https://${shop}/products/${encodeURIComponent(handle)}`)
    : null;
  return { home, product, productHandle: handle };
}

async function checkDeployedExtension(
  shop: string,
  settings: BoosterSettings | null,
  embeds: EmbedsSnapshot | null,
  pages: StorefrontPages | Promise<StorefrontPages>,
): Promise<HealthCheck> {
  return runCheck(
    "deployed-extension",
    "Deployed extension build",
    async () => {
      const fixHint =
        "Presence is detected from this app's own asset filenames (cellexia-*.js/css) and markup — the /extensions/<uuid>/<label>/ path segment is the deploy version label the deploying pipeline chooses. Preview and checkout changes ship in TWO halves: the extensions (deploy) AND the app server — redeploy BOTH, or the storefront serves a build that no longer matches the server's behavior.";
      const warnResult = {
        status: "warn" as const,
        detail:
          "could not detect the deployed extension on the storefront (page fetch failed or embed disabled)",
        fixHint,
      };
      try {
        const { home, product: productPage } = await pages;
        let presence = extensionPresence(home);
        if (!presence.present) {
          // Fallback: the first product page (embeds also render there, and
          // some themes only load our assets on product templates).
          presence = extensionPresence(productPage);
        }

        if (presence.present) {
          const buildNum = presence.label
            ? (/-(\d+)$/.exec(presence.label) ?? [])[1]
            : undefined;
          return {
            status: "pass" as const,
            detail: buildNum
              ? `Storefront serves extension build -${buildNum}`
              : presence.label
                ? `Storefront serves extension version label "${presence.label}"`
                : "Storefront carries Cellexia extension markup (version label not visible on the fetched page)",
            fixHint,
          };
        }
        // v8.23 ESCALATION (the "deploy blanked the site while the admin
        // looked normal" incident): a real product page with ZERO Cellexia
        // markup — no assets, no config islands, not even the cart embed's
        // session beacon (which renders on every page the embed is on) —
        // while the theme says the embeds are enabled. That is no soft
        // warn; it is the incident signature.
        if (
          productPage &&
          !looksPasswordProtected(productPage) &&
          embeds !== null &&
          embeds.any &&
          settings !== null
        ) {
          return {
            status: "fail" as const,
            detail:
              "A real product page was fetched and carries ZERO Cellexia extension markup (no assets, no config islands, no session beacon), although the theme's app embeds are enabled. This is the signature of a deploy that blanked the storefront: the released app version no longer contains the theme extension, it was deployed under a different app, or the theme references a dead extension version. The admin looks normal because it reads its own data.",
            fixHint:
              "Revert to the previous app/extension version in the Partner Dashboard FIRST, then diagnose — and redeploy from the production app (the shopify.app.toml/client_id this admin belongs to). See INSTALL.md → 'After every deploy'.",
          };
        }
        return warnResult;
      } catch {
        // Any unexpected crash degrades to warn, never fail.
        return warnResult;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// v15. storefront-islands — every Cellexia config island on the fetched pages
// must be valid JSON (the "cart became empty" incident detector)
// ---------------------------------------------------------------------------

/** The JSON islands this app's theme extension emits (id → owner). */
export const STOREFRONT_ISLAND_IDS = [
  "cx-cart-config",
  "cx-rw-config",
  "cx-az-config",
  "cx-pdp-config",
] as const;

/**
 * Pure: finds every `<script type="application/json" id="<id>">…</script>`
 * island in `html` and JSON.parses its text. Returns one entry per island
 * present (absent islands are simply not listed — a page that does not
 * render a feature has nothing to validate). On a parse failure the entry
 * carries the parser message and a 160-char excerpt around the failure
 * position (a "Liquid error" substring is called out — the v15 incident:
 * one Liquid problem inside a shared island invalidates the WHOLE island and
 * every widget that reads it vanishes).
 */
export function inspectStorefrontIslands(
  html: string,
  ids: readonly string[] = STOREFRONT_ISLAND_IDS,
): { id: string; ok: boolean; detail: string }[] {
  const out: { id: string; ok: boolean; detail: string }[] = [];
  for (const id of ids) {
    const open = new RegExp(
      `<script[^>]*\\bid=["']${id}["'][^>]*>`,
      "i",
    );
    const m = open.exec(html);
    if (!m) continue;
    const start = m.index + m[0].length;
    const end = html.indexOf("</script>", start);
    const text = end === -1 ? html.slice(start) : html.slice(start, end);
    try {
      JSON.parse(text);
      out.push({ id, ok: true, detail: `#${id} parses (${text.length} chars)` });
    } catch (error) {
      const message = errorMessage(error);
      const posMatch = /position (\d+)/i.exec(message);
      const pos = posMatch ? Number(posMatch[1]) : -1;
      let excerptAt = pos;
      if (excerptAt < 0) {
        const liquidAt = text.indexOf("Liquid error");
        excerptAt = liquidAt >= 0 ? liquidAt : 0;
      }
      const from = Math.max(0, excerptAt - 80);
      const excerpt = text
        .slice(from, from + 160)
        .replace(/\s+/g, " ")
        .trim();
      const liquid = text.includes("Liquid error")
        ? " The island text contains a Liquid error message — a Liquid problem inside the island invalidated the whole JSON."
        : "";
      out.push({
        id,
        ok: false,
        detail: `#${id} is not valid JSON: ${message}.${liquid} Excerpt: …${excerpt}…`,
      });
    }
  }
  return out;
}

async function checkStorefrontIslands(
  pages: StorefrontPages | Promise<StorefrontPages>,
): Promise<HealthCheck> {
  return runCheck("storefront-islands", "Storefront config islands parse", async () => {
    const fixHint =
      "Disarm the preview / turn the affected feature off in Markets and re-run; send this message to support.";
    const { home, product } = await pages;
    if (home === null && product === null) {
      return {
        status: "warn" as const,
        detail:
          "could not fetch the storefront home or product page (network / password page) — nothing to inspect",
        fixHint: "Re-run the checks; if the store is password-protected this check cannot see the pages.",
      };
    }
    const results: { page: string; id: string; ok: boolean; detail: string }[] = [];
    if (home !== null) {
      for (const r of inspectStorefrontIslands(home)) results.push({ page: "home", ...r });
    }
    if (product !== null) {
      for (const r of inspectStorefrontIslands(product)) results.push({ page: "product page", ...r });
    }
    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
      return {
        status: "fail" as const,
        detail: failures.map((f) => `${f.page}: ${f.detail}`).join(" | "),
        fixHint,
      };
    }
    if (results.length === 0) {
      return {
        status: "pass" as const,
        detail: "No Cellexia config island on the fetched pages (features off or embeds disabled) — nothing to parse.",
        fixHint: "Nothing to do.",
      };
    }
    const seen = [...new Set(results.map((r) => `#${r.id}`))].join(", ");
    return {
      status: "pass" as const,
      detail: `${results.length} island(s) parse as valid JSON on the fetched pages (${seen}).`,
      fixHint: "Nothing to do.",
    };
  });
}

/**
 * v8.4: the proof library (press / endorsements / results) lives in three
 * Prisma tables, and the two ways a deploy can break them produce the same
 * cryptic storefront error ("Cannot read properties of undefined (reading
 * 'count')"). This check tells them apart and gives each its own fix:
 *
 *   1. STALE GENERATED CLIENT — the running server's Prisma Client was
 *      generated from a pre-v8 schema, so the model properties are simply
 *      absent from the client object. Fix is a rebuild with this version's
 *      schema (generate runs in the build/postinstall scripts).
 *   2. MISSING TABLES — the client is current but the database was never
 *      pushed, so a trivial count() throws (Prisma P2021). Fix is db push
 *      (Postgres) / migrate deploy (SQLite) against the production DB.
 *
 * v8.5 adds the third — and sneakiest — failure: WRONG DATABASE ENTIRELY.
 * A client generated from the dev schema ignores DATABASE_URL and runs
 * against a local SQLite file where counts succeed, so the two probes above
 * pass green while production data sits untouched in Postgres. The engine
 * probe below asks the connected database what it IS (sqlite_version() only
 * exists on SQLite) and fails the check when DATABASE_URL says Postgres.
 */
async function detectDatabaseEngine(): Promise<"sqlite" | "postgresql" | "unknown"> {
  try {
    await prisma.$queryRawUnsafe("select sqlite_version()");
    return "sqlite";
  } catch {
    // fall through
  }
  try {
    await prisma.$queryRawUnsafe("select version()");
    return "postgresql";
  } catch {
    return "unknown";
  }
}

async function checkProofDatabase(): Promise<HealthCheck> {
  return runCheck("proof-database", "Proof library database", async () => {
    const missing = (
      ["pressItem", "dermEndorsement", "customerResult"] as const
    ).filter((model) => !(prisma as unknown as Record<string, unknown>)[model]);
    if (missing.length > 0) {
      return {
        status: "fail" as const,
        detail: `The running server's generated Prisma Client predates the v8 schema — missing model(s): ${missing.join(", ")}.`,
        fixHint:
          "Deploy with THIS version's prisma schemas and make sure the build regenerates the client — this version's npm build and postinstall scripts do that automatically (they auto-select prisma/schema.postgres.prisma when DATABASE_URL is Postgres). A one-off `npx prisma generate` in a host shell does NOT persist into the running service on most platforms. Rebuild, restart, then re-run the checks.",
      };
    }
    const wantsPostgres = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
    const engine = await detectDatabaseEngine();
    if (wantsPostgres && engine === "sqlite") {
      return {
        status: "fail" as const,
        detail:
          "WRONG DATABASE: DATABASE_URL points at Postgres but this server is actually connected to a local SQLite file — everything it reads and writes lives on ephemeral disk and disappears on restart, while the real production data sits untouched in Postgres.",
        fixHint:
          "The Prisma Client was generated from the dev (SQLite) schema. Rebuild with DATABASE_URL present in the BUILD environment (`npm ci && npm run build` auto-selects prisma/schema.postgres.prisma), or set PRISMA_SCHEMA=prisma/schema.postgres.prisma where the build cannot see DATABASE_URL, then redeploy and re-run the checks.",
      };
    }
    try {
      const [press, endorsements, results] = await Promise.all([
        prisma.pressItem.count(),
        prisma.dermEndorsement.count(),
        prisma.customerResult.count(),
      ]);
      return {
        status: "pass" as const,
        detail: `Press, endorsement and result tables are reachable on ${engine} (${press} / ${endorsements} / ${results} rows).`,
        fixHint:
          "Nothing to fix — the generated Prisma Client and the database both carry the v8 proof tables.",
      };
    } catch (error) {
      return {
        status: "fail" as const,
        detail: `The generated client is current but the proof tables are missing or unreachable: ${errorMessage(error)}`,
        fixHint:
          "The DATABASE is missing the v8 tables. Run `npx prisma db push` against the production DATABASE_URL (Postgres — the bundled migrations are SQLite-dialect; on SQLite use `npx prisma migrate deploy`), then restart and re-run the checks.",
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * v8.23: STOREFRONT PULSE — the dead-man switch for every "the site went
 * dark but the admin looked normal" class at once. Whatever kills the
 * widgets (wrong-app deploy, dead embed reference, broken config carrier,
 * a fatal JS build, a dropped app proxy), the impression beacons stop —
 * so a store that USED to beacon and suddenly does not is failing, no
 * matter how green everything else looks.
 *
 * Guards against false alarms: brand-new installs (no baseline) and shops
 * whose baseline is too thin to be meaningful pass with a note; a merchant
 * who turned every theme feature off is not an incident.
 */
const PULSE_BASELINE_DAYS = 7;
const PULSE_MIN_BASELINE = 70; // ~10 impressions/day before the check arms

async function checkStorefrontPulse(
  shop: string,
  settings: BoosterSettings,
): Promise<HealthCheck> {
  return runCheck("storefront-pulse", "Storefront pulse (beacons)", async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const recentStart = new Date(now - dayMs);
    const baselineStart = new Date(
      now - (PULSE_BASELINE_DAYS + 1) * dayMs,
    );
    const [recent, baseline] = await Promise.all([
      prisma.event.count({
        where: { shop, type: "impression", createdAt: { gte: recentStart } },
      }),
      prisma.event.count({
        where: {
          shop,
          type: "impression",
          createdAt: { gte: baselineStart, lt: recentStart },
        },
      }),
    ]);
    const dailyAvg = baseline / PULSE_BASELINE_DAYS;
    if (!anyThemeFeatureOn(settings)) {
      return {
        status: "pass" as const,
        detail:
          "No theme-side feature is enabled, so no storefront beacons are expected.",
        fixHint: "Nothing to do.",
      };
    }
    if (baseline < PULSE_MIN_BASELINE) {
      // Review catch: after ~8 silent days the rolling baseline itself
      // drains to zero and the dead-man would DISARM in the middle of the
      // very outage it exists to catch. Anchor the arming test at the
      // LAST impression ever seen: if the 7 days before it were healthy,
      // the store is not "new" — it is silent.
      if (recent === 0) {
        const last = await prisma.event.findFirst({
          where: { shop, type: "impression" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        if (last) {
          const anchored = await prisma.event.count({
            where: {
              shop,
              type: "impression",
              createdAt: {
                gte: new Date(last.createdAt.getTime() - PULSE_BASELINE_DAYS * dayMs),
                lte: last.createdAt,
              },
            },
          });
          if (anchored >= PULSE_MIN_BASELINE) {
            const silentDays = Math.floor(
              (now - last.createdAt.getTime()) / dayMs,
            );
            return {
              status: "fail" as const,
              detail: `The storefront has been SILENT for ${silentDays} day${silentDays === 1 ? "" : "s"}: the last impression beacon arrived ${last.createdAt.toISOString().slice(0, 10)}, after ~${Math.round(anchored / PULSE_BASELINE_DAYS)}/day before it went quiet. Real visitors are not seeing the widgets (or the beacons cannot reach the app).`,
              fixHint:
                "Open the storefront in an incognito window and check for Cellexia widgets. If they are missing, revert/redeploy the extensions from the production app (INSTALL.md → 'After every deploy'); if they show, fix the App Proxy (beacons ride it).",
            };
          }
        }
      }
      return {
        status: "pass" as const,
        detail: `Not enough beacon history to monitor yet (${baseline} impressions over the last ${PULSE_BASELINE_DAYS} days; the check arms at ${PULSE_MIN_BASELINE}). Recent 24h: ${recent}.`,
        fixHint: "Nothing to do — the pulse arms itself as traffic accrues.",
      };
    }
    if (recent === 0) {
      return {
        status: "fail" as const,
        detail: `The storefront went SILENT: zero impression beacons in the last 24h after averaging ~${Math.round(dailyAvg)}/day over the prior ${PULSE_BASELINE_DAYS} days. Real visitors are not seeing the widgets (or the beacons cannot reach the app). Typical causes: the last deploy shipped under the wrong app, the theme lost the embeds, the config metafield stopped resolving, or the App Proxy was dropped — see the checks above to tell them apart.`,
        fixHint:
          "Open the storefront in an incognito window and check for Cellexia widgets. If they are missing, revert/redeploy the extensions from the production app (INSTALL.md → 'After every deploy'); if they show, fix the App Proxy (beacons ride it).",
      };
    }
    if (recent < dailyAvg * 0.15) {
      return {
        status: "warn" as const,
        detail: `Beacon volume dropped hard: ${recent} impressions in the last 24h vs ~${Math.round(dailyAvg)}/day before. Could be traffic, could be a partially-dark storefront (one embed off, one market gated).`,
        fixHint:
          "Spot-check the storefront and the Markets matrix; re-run the checks after a few hours of traffic.",
      };
    }
    return {
      status: "pass" as const,
      detail: `Beacons flowing: ${recent} impressions in the last 24h (~${Math.round(dailyAvg)}/day baseline).`,
      fixHint: "Nothing to do.",
    };
  });
}

/**
 * v8.23 (review catch): a feature can be ON yet market-scoped to ZERO live
 * markets — "selected" mode whose handles no longer exist (markets get
 * renamed/deleted) or were never picked. Every gate then fails on the
 * storefront while every toggle looks on in the admin: dark by
 * configuration. On a low-traffic store the pulse takes days to notice;
 * this check reads the configuration directly.
 */
async function checkMarketReach(
  admin: AdminGraphqlClient,
  settings: BoosterSettings,
): Promise<HealthCheck> {
  return runCheck("market-reach", "Features reach a live market", async () => {
    const enabledKeys = Object.entries(FEATURE_DEFS)
      .filter(([key, def]) => !key.startsWith("checkout") && def.get(settings))
      .map(([key]) => key);
    if (enabledKeys.length === 0) {
      return {
        status: "pass" as const,
        detail: "No theme-side feature is enabled — nothing to target.",
        fixHint: "Nothing to do.",
      };
    }
    let liveHandles: Set<string>;
    try {
      const markets = await listMarkets(admin);
      liveHandles = new Set(
        markets.filter((m) => m.enabled !== false).map((m) => m.handle),
      );
      if (liveHandles.size === 0) {
        return {
          status: "warn" as const,
          detail: "Could not read any live market from the API — market targeting could not be verified.",
          fixHint: "Re-run the checks; if it persists, verify the read_markets scope.",
        };
      }
    } catch (error) {
      return {
        status: "warn" as const,
        detail: `Could not read the markets list (${errorMessage(error)}) — market targeting could not be verified.`,
        fixHint: "Re-run the checks; if it persists, verify the read_markets scope.",
      };
    }
    const unreachable = enabledKeys.filter((key) => {
      const scope = settings.marketScopes[key as keyof typeof settings.marketScopes];
      return (
        scope &&
        scope.mode === "selected" &&
        !scope.markets.some((handle) => liveHandles.has(handle))
      );
    });
    if (unreachable.length === enabledKeys.length) {
      return {
        status: "fail" as const,
        detail: `EVERY enabled feature (${unreachable.join(", ")}) is market-scoped to zero live markets — the storefront is dark by configuration, not by deploy. The selected market handles no longer match any live market.`,
        fixHint:
          "Open the Markets page and re-select live markets for each feature (or switch them to 'All markets').",
        fixUrl: "/app/markets",
      };
    }
    if (unreachable.length > 0) {
      return {
        status: "warn" as const,
        detail: `${unreachable.length} enabled feature${unreachable.length === 1 ? " is" : "s are"} market-scoped to zero live markets and will never render: ${unreachable.join(", ")}.`,
        fixHint:
          "Open the Markets page and re-select live markets for the listed features.",
        fixUrl: "/app/markets",
      };
    }
    return {
      status: "pass" as const,
      detail: `All ${enabledKeys.length} enabled theme-side features reach at least one live market.`,
      fixHint: "Nothing to do.",
    };
  });
}

// ---------------------------------------------------------------------------
// 15. rewards-discounts (v14 — SPEC v14 §3)
// ---------------------------------------------------------------------------

async function checkRewardsDiscounts(
  admin: AdminGraphqlClient,
  shop: string,
  settings: BoosterSettings,
): Promise<HealthCheck> {
  return runCheck("rewards-discounts", "Discount codes", async () => {
    const rw = settings.rewards;
    const wantSs = rw.setSavings.enabled;
    const wantGt = rw.giftTiers.enabled;
    const wantFs = rw.freeShip.enabled;
    const state = await getRewardsState(shop);
    const nodes = state.nodes;
    const anyNode =
      Object.keys(nodes.kit).length > 0 || Boolean(nodes.gift) || Boolean(nodes.ship);
    if (!wantSs && !wantGt && !wantFs && !anyNode) {
      return {
        status: "pass" as const,
        detail: "Set savings, gift tiers and the free-shipping guarantee are off — nothing to verify.",
        fixHint:
          "When you enable one, press “Create discount codes” on the Rewards page.",
      };
    }
    let deployedFunctionId = "";
    try {
      deployedFunctionId = await findRewardsFunctionId(admin);
    } catch (error) {
      return {
        status: "warn" as const,
        detail: `Could not list Shopify Functions (${errorMessage(error)}).`,
        fixHint: "Re-run the checks; if it persists, verify the write_discounts scope was granted.",
        fixUrl: "/app/features/rewards",
      };
    }
    if (!deployedFunctionId) {
      return {
        status: "fail" as const,
        detail:
          "The Cellexia rewards discount function is not deployed, so no set-savings code, free gift or free-shipping discount can apply at checkout.",
        fixHint: "Deploy the extensions (npm run deploy), then press “Create discount codes” on the Rewards page.",
        fixUrl: "/app/features/rewards",
      };
    }
    const problems: string[] = [];
    if (state.functionId && state.functionId !== deployedFunctionId) {
      problems.push(
        "the connected discounts point at a different function id than the deployed one — press “Create discount codes” again",
      );
    }
    const missing: string[] = [];
    // v15.1: codes Connect found owned by another discount (server-written
    // rewards.setSavings.blockedCodes) — the app never attaches them; the
    // tier is simply unavailable until the merchant changes the code.
    const blocked = new Set(rw.setSavings.blockedCodes ?? []);
    if (wantSs) {
      for (const tier of rw.setSavings.tiers) {
        if (blocked.has(tier.code)) {
          problems.push(
            `code ${tier.code} is already used by another discount in your store, so that tier is skipped (change the code in the table or delete that discount yourself)`,
          );
        } else if (!nodes.kit[tier.code]) missing.push(`code ${tier.code}`);
      }
      // v15: no alias requirement — the store's historical codes are never
      // ours; the app steps aside for them (yieldToCodes) instead.
    }
    if (wantGt && !nodes.gift) missing.push("“Cellexia free gifts”");
    if (wantFs && !nodes.ship) missing.push("“Cellexia free shipping”");
    const ids = [...Object.values(nodes.kit), nodes.gift, nodes.ship].filter(Boolean);
    if (ids.length > 0) {
      let statuses: Awaited<ReturnType<typeof readDiscountNodes>>;
      try {
        statuses = await readDiscountNodes(admin, ids);
      } catch (error) {
        // Most often a missing read/write_discounts scope on an older install.
        return {
          status: "warn" as const,
          detail: `Could not read the discount nodes from Shopify: ${errorMessage(error)}`,
          fixHint:
            "Grant the write_discounts scope (open the app once so Shopify asks for the new permission, or reinstall) and re-run the health check.",
          fixUrl: "/app/features/rewards",
        };
      }
      for (const [code, id] of Object.entries(nodes.kit)) {
        const st = statuses[id];
        if (!st?.exists) missing.push(`code ${code} (deleted in Shopify)`);
        else if (st.status !== "ACTIVE") problems.push(`code ${code} is ${st.status}`);
        else if (st.functionId && st.functionId !== deployedFunctionId) {
          problems.push(`code ${code} points at another function`);
        }
      }
      for (const [key, label] of [
        ["gift", "“Cellexia free gifts”"],
        ["ship", "“Cellexia free shipping”"],
      ] as const) {
        const id = nodes[key];
        if (!id) continue;
        const st = statuses[id];
        if (!st?.exists) missing.push(`${label} (deleted in Shopify)`);
        else if (st.status !== "ACTIVE") problems.push(`${label} is ${st.status}`);
        else if (st.functionId && st.functionId !== deployedFunctionId) {
          problems.push(`${label} points at another function`);
        }
      }
    }
    if (missing.length > 0 || problems.length > 0) {
      const enabledButMissing = missing.length > 0;
      return {
        status: enabledButMissing ? ("fail" as const) : ("warn" as const),
        detail: [
          missing.length ? `Missing discounts: ${missing.join(", ")}.` : "",
          problems.length ? `Problems: ${problems.join("; ")}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        fixHint:
          "Open the Rewards page and press “Create discount codes”. If a code is already used by another discount in your store, change the code in the table or delete that discount yourself — the app never touches discounts it did not create.",
        fixUrl: "/app/features/rewards",
      };
    }
    return {
      status: "pass" as const,
      detail: `${Object.keys(nodes.kit).length} set-savings code discount(s), the free-gift and free-shipping automatic discounts are ACTIVE and bound to the deployed function.`,
      fixHint: "Nothing to do.",
    };
  });
}

// ---------------------------------------------------------------------------
// 16. gift-products (v14 — every gift option / sachet must be sellable)
// ---------------------------------------------------------------------------

const GIFT_PRODUCTS_QUERY = `#graphql
  query cellexiaHealthGiftProducts($query: String!) {
    products(first: 50, query: $query) {
      nodes { id handle status publishedAt }
    }
  }
`;

async function checkGiftProducts(
  admin: AdminGraphqlClient,
  shop: string,
  settings: BoosterSettings,
): Promise<HealthCheck> {
  return runCheck("gift-products", "Gift products sellable", async () => {
    const gt = settings.rewards.giftTiers;
    if (!gt.enabled) {
      return {
        status: "pass" as const,
        detail: "Gift tiers are off — nothing to verify.",
        fixHint: "Nothing to do.",
      };
    }
    const handles = new Set<string>();
    let handleless = 0;
    for (const tier of gt.tiers) {
      for (const slot of tier.slots) {
        for (const option of slot) {
          if (option.kind !== "variant") continue;
          if (option.handle) handles.add(option.handle);
          else handleless += 1;
        }
      }
    }
    for (const entry of gt.samplePool) handles.add(entry.handle);
    if (handles.size === 0) {
      return {
        status: gt.tiers.length === 0 ? ("fail" as const) : ("warn" as const),
        detail:
          gt.tiers.length === 0
            ? "Gift tiers are enabled but no tier is configured — the meter has nothing to show."
            : "Gift tiers hold no product option (samples only) and the sample pool is empty — nothing can be given.",
        fixHint: "Open the Rewards page: add gift products or load the sachet pool.",
        fixUrl: "/app/features/rewards",
      };
    }
    const query = [...handles].map((h) => `handle:${h}`).join(" OR ");
    const json = await graphqlJson<{
      data?: {
        products?: {
          nodes?: { id: string; handle: string; status: string; publishedAt: string | null }[];
        };
      };
    }>(admin, GIFT_PRODUCTS_QUERY, { query });
    const found = new Map(
      (json.data?.products?.nodes ?? []).map((p) => [p.handle, p] as const),
    );
    const missing = [...handles].filter((h) => !found.has(h));
    const inactive = [...found.values()].filter((p) => p.status !== "ACTIVE").map((p) => p.handle);
    const unpublished = [...found.values()]
      .filter((p) => p.status === "ACTIVE" && !p.publishedAt)
      .map((p) => p.handle);
    const state = await getRewardsState(shop);
    const paused = pausedByMarket(state.giftStock);
    const pausedMarkets = Object.keys(paused);
    if (missing.length || inactive.length || unpublished.length) {
      return {
        status: "fail" as const,
        detail: [
          missing.length ? `Not found: ${missing.join(", ")}.` : "",
          inactive.length ? `Not active: ${inactive.join(", ")}.` : "",
          unpublished.length
            ? `Not published to the Online Store (the storefront cannot add them): ${unpublished.join(", ")}.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        fixHint:
          "Make every gift product Active and published to the Online Store (hidden from search/collections is fine), or replace the option on the Rewards page.",
        fixUrl: "/app/features/rewards",
      };
    }
    if (handleless > 0 || pausedMarkets.length > 0) {
      return {
        status: "warn" as const,
        detail: [
          handleless > 0
            ? `${handleless} gift option(s) have no product handle and cannot render.`
            : "",
          pausedMarkets.length > 0
            ? `Gift options are paused for low stock in: ${pausedMarkets.join(", ")}.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        fixHint:
          "Review the gift options and the stock table on the Rewards page (paused options un-pause by themselves when stock returns).",
        fixUrl: "/app/features/rewards",
      };
    }
    return {
      status: "pass" as const,
      detail: `All ${handles.size} gift/sample products exist, are Active and published; no option is paused for stock.`,
      fixHint: "Nothing to do.",
    };
  });
}

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
    const pages = loadStorefrontPages(shop);
    return [
      crashed,
      await checkAppProxy(shop),
      await checkDeployedExtension(shop, null, embedsEnabledFromTheme(theme), pages),
      {
        id: "storefront-pulse",
        label: "Storefront pulse (beacons)",
        status: "fail",
        detail: "Skipped — settings could not be loaded.",
        fixHint: "Fix the settings load error above first.",
      },
      {
        id: "market-reach",
        label: "Features reach a live market",
        status: "fail",
        detail: "Skipped — settings could not be loaded.",
        fixHint: "Fix the settings load error above first.",
      },
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
      await checkProofDatabase(),
      {
        id: "rewards-discounts",
        label: "Discount codes",
        status: "fail",
        detail: "Skipped — settings could not be loaded.",
        fixHint: "Fix the settings load error above first.",
      },
      {
        id: "gift-products",
        label: "Gift products sellable",
        status: "fail",
        detail: "Skipped — settings could not be loaded.",
        fixHint: "Fix the settings load error above first.",
      },
      await checkStorefrontIslands(pages),
    ];
  }

  const theme = await fetchThemeFiles(admin);
  // v15: one storefront fetch (home + first product page) shared by the
  // deployed-extension probe and the storefront-islands parser.
  const pages = loadStorefrontPages(shop);
  const [
    configMetafields,
    appProxy,
    deployedExtension,
    storefrontPulse,
    marketReach,
    themeEmbeds,
    themeCompat,
    webhooks,
    protectionProduct,
    metaobjectDefinitions,
    locales,
    ordersData,
    previewHygiene,
    proofDatabase,
    rewardsDiscounts,
    giftProducts,
    storefrontIslands,
  ] = await Promise.all([
    checkConfigMetafields(admin, shop, settings),
    checkAppProxy(shop),
    checkDeployedExtension(shop, settings, embedsEnabledFromTheme(theme), pages),
    checkStorefrontPulse(shop, settings),
    checkMarketReach(admin, settings),
    checkThemeEmbeds(theme, themeEditorUrl),
    checkThemeCompat(theme),
    checkWebhooks(admin, shop),
    checkProtectionProduct(admin, settings),
    checkMetaobjectDefinitions(admin),
    checkLocales(admin),
    checkOrdersData(shop),
    checkPreviewHygiene(shop),
    checkProofDatabase(),
    checkRewardsDiscounts(admin, shop, settings),
    checkGiftProducts(admin, shop, settings),
    checkStorefrontIslands(pages),
  ]);

  return [
    configMetafields,
    appProxy,
    deployedExtension,
    storefrontPulse,
    marketReach,
    themeEmbeds,
    themeCompat,
    webhooks,
    protectionProduct,
    metaobjectDefinitions,
    locales,
    ordersData,
    previewHygiene,
    proofDatabase,
    rewardsDiscounts,
    giftProducts,
    storefrontIslands,
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
