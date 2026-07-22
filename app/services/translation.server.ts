/**
 * Machine translation for per-product booster content (SPEC v5.2).
 *
 * The five PDP boosters store their per-product copy in TRANSLATABLE
 * METAOBJECTS (cellexia_clinical_study etc.). Shopify serves per-language
 * values automatically once translations are registered — but Translate &
 * Adapt only fills them in when a human does it by hand, so every language
 * showed the primary-locale text until then. This service closes that gap:
 * it machine-translates the merchant's booster copy with DeepL (merchant's
 * own API key, free tier is plenty) and registers the results as NATIVE
 * Shopify translations via translationsRegister. They behave exactly like
 * Translate & Adapt entries afterwards: visible there, editable there, and
 * a manual edit in T&A simply overwrites ours.
 *
 * Hard rules:
 * - The DeepL key lives in the TranslationConfig table ONLY. It must never
 *   be copied into BoosterSettings — that blob is mirrored to metafields
 *   the storefront can read.
 * - Only fields in TRANSLATABLE_FIELD_KEYS are ever sent to DeepL. Proper
 *   nouns and identifiers (lab names, clinics, verifier names/licenses,
 *   INCI ingredient names, batch codes, dates, URLs) are NEVER machine
 *   translated — mangling a license number or an INCI name would damage
 *   exactly the credibility these widgets exist to build.
 * - Fail closed and report per language: an unsupported language or a
 *   failed DeepL call never blocks the other languages.
 */

import prisma from "../db.server";
import { adminRequest, type AdminGraphqlClient } from "./metaobjects.server";
import type { ProductBoostersResult } from "./pdp-content.server";

// ---------------------------------------------------------------------------
// Config (Prisma-backed; key is server-only)
// ---------------------------------------------------------------------------

export interface TranslationConfig {
  provider: string;
  apiKey: string;
  autoOnSave: boolean;
  /** true when an API key is present. */
  configured: boolean;
}

const DEFAULT_CONFIG: TranslationConfig = {
  provider: "deepl",
  apiKey: "",
  autoOnSave: true,
  configured: false,
};

export async function getTranslationConfig(
  shop: string,
): Promise<TranslationConfig> {
  const row = await prisma.translationConfig.findUnique({ where: { shop } });
  if (!row) return { ...DEFAULT_CONFIG };
  return {
    provider: row.provider || "deepl",
    apiKey: row.apiKey,
    autoOnSave: row.autoOnSave,
    configured: row.apiKey.trim() !== "",
  };
}

export async function saveTranslationConfig(
  shop: string,
  patch: { apiKey?: string; autoOnSave?: boolean; clearKey?: boolean },
): Promise<TranslationConfig> {
  const current = await prisma.translationConfig.findUnique({
    where: { shop },
  });
  const nextKey = patch.clearKey
    ? ""
    : typeof patch.apiKey === "string" && patch.apiKey.trim() !== ""
      ? patch.apiKey.trim()
      : (current?.apiKey ?? "");
  const nextAuto =
    typeof patch.autoOnSave === "boolean"
      ? patch.autoOnSave
      : (current?.autoOnSave ?? true);
  const row = await prisma.translationConfig.upsert({
    where: { shop },
    create: { shop, provider: "deepl", apiKey: nextKey, autoOnSave: nextAuto },
    update: { apiKey: nextKey, autoOnSave: nextAuto },
  });
  return {
    provider: row.provider || "deepl",
    apiKey: row.apiKey,
    autoOnSave: row.autoOnSave,
    configured: row.apiKey.trim() !== "",
  };
}

// ---------------------------------------------------------------------------
// DeepL client
// ---------------------------------------------------------------------------

/** DeepL free-tier keys end in ":fx" and use the api-free host. */
export function deeplEndpointForKey(apiKey: string): string {
  return apiKey.trim().endsWith(":fx")
    ? "https://api-free.deepl.com"
    : "https://api.deepl.com";
}

/**
 * Shop locale (lowercased) -> DeepL target_lang. Covers every language the
 * store ships plus the rest of DeepL's published target list; anything not
 * here is reported as "unsupported" for that language and skipped.
 */
const DEEPL_TARGETS: Record<string, string> = {
  ar: "AR",
  bg: "BG",
  cs: "CS",
  da: "DA",
  de: "DE",
  el: "EL",
  en: "EN-GB",
  "en-us": "EN-US",
  "en-gb": "EN-GB",
  es: "ES",
  et: "ET",
  fi: "FI",
  fr: "FR",
  hu: "HU",
  id: "ID",
  it: "IT",
  ja: "JA",
  ko: "KO",
  lt: "LT",
  lv: "LV",
  nb: "NB",
  no: "NB",
  nl: "NL",
  pl: "PL",
  pt: "PT-PT",
  "pt-pt": "PT-PT",
  "pt-br": "PT-BR",
  ro: "RO",
  ru: "RU",
  sk: "SK",
  sl: "SL",
  sv: "SV",
  tr: "TR",
  uk: "UK",
  zh: "ZH",
  "zh-cn": "ZH-HANS",
  "zh-tw": "ZH-HANT",
};

const DEEPL_SOURCES = new Set([
  "AR", "BG", "CS", "DA", "DE", "EL", "EN", "ES", "ET", "FI", "FR", "HU",
  "ID", "IT", "JA", "KO", "LT", "LV", "NB", "NL", "PL", "PT", "RO", "RU",
  "SK", "SL", "SV", "TR", "UK", "ZH",
]);

export function deeplTargetForLocale(locale: string): string | null {
  const normalized = locale.trim().toLowerCase();
  return (
    DEEPL_TARGETS[normalized] ??
    DEEPL_TARGETS[normalized.split("-")[0]] ??
    null
  );
}

/** source_lang for DeepL, or undefined to let it auto-detect. */
export function deeplSourceForLocale(locale: string): string | undefined {
  const base = locale.trim().split("-")[0].toUpperCase();
  return DEEPL_SOURCES.has(base) ? base : undefined;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

interface DeeplBatchResult {
  ok: boolean;
  translations: string[];
  error?: string;
}

/** DeepL caps one request at 50 texts. */
const DEEPL_TEXTS_PER_REQUEST = 50;
const DEEPL_TIMEOUT_MS = 20_000;

async function deeplFetch(
  apiKey: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEEPL_TIMEOUT_MS);
  try {
    return await fetch(`${deeplEndpointForKey(apiKey)}${path}`, {
      ...init,
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey.trim()}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function deeplErrorForStatus(status: number): string {
  if (status === 403) return "DeepL rejected the API key (403) — check it on the Languages page";
  if (status === 456) return "The DeepL character quota for this billing period is used up (456)";
  if (status === 429) return "DeepL rate limit hit (429) — try again in a minute";
  return `DeepL returned HTTP ${status}`;
}

async function deeplTranslateBatch(
  apiKey: string,
  texts: string[],
  targetLang: string,
  sourceLang: string | undefined,
): Promise<DeeplBatchResult> {
  const out: string[] = [];
  for (const slice of chunk(texts, DEEPL_TEXTS_PER_REQUEST)) {
    let lastError = "";
    let translated: string[] | null = null;
    for (let attempt = 0; attempt < 2 && !translated; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
      try {
        const response = await deeplFetch(apiKey, "/v2/translate", {
          method: "POST",
          body: JSON.stringify({
            text: slice,
            target_lang: targetLang,
            ...(sourceLang ? { source_lang: sourceLang } : {}),
            preserve_formatting: true,
          }),
        });
        if (!response.ok) {
          lastError = deeplErrorForStatus(response.status);
          // Key/quota problems will not fix themselves on retry.
          if (response.status === 403 || response.status === 456) {
            return { ok: false, translations: [], error: lastError };
          }
          continue;
        }
        const json = (await response.json()) as {
          translations?: { text: string }[];
        };
        const batch = (json.translations ?? []).map((t) => t.text ?? "");
        if (batch.length !== slice.length) {
          lastError = "DeepL returned an unexpected number of translations";
          continue;
        }
        translated = batch;
      } catch (error) {
        lastError =
          error instanceof Error && error.name === "AbortError"
            ? "DeepL did not respond within 20 seconds"
            : error instanceof Error
              ? error.message
              : "Could not reach DeepL";
      }
    }
    if (!translated) return { ok: false, translations: [], error: lastError };
    out.push(...translated);
  }
  return { ok: true, translations: out };
}

export interface DeeplUsage {
  ok: boolean;
  characterCount: number | null;
  characterLimit: number | null;
  error?: string;
}

/** GET /v2/usage — doubles as the "is this key valid" probe. */
export async function verifyDeeplKey(apiKey: string): Promise<DeeplUsage> {
  try {
    const response = await deeplFetch(apiKey, "/v2/usage", { method: "GET" });
    if (!response.ok) {
      return {
        ok: false,
        characterCount: null,
        characterLimit: null,
        error: deeplErrorForStatus(response.status),
      };
    }
    const json = (await response.json()) as {
      character_count?: number;
      character_limit?: number;
    };
    return {
      ok: true,
      characterCount:
        typeof json.character_count === "number" ? json.character_count : null,
      characterLimit:
        typeof json.character_limit === "number" ? json.character_limit : null,
    };
  } catch (error) {
    return {
      ok: false,
      characterCount: null,
      characterLimit: null,
      error:
        error instanceof Error && error.name === "AbortError"
          ? "DeepL did not respond within 20 seconds"
          : "Could not reach DeepL — check the server's outbound network access",
    };
  }
}

// ---------------------------------------------------------------------------
// What gets translated
// ---------------------------------------------------------------------------

/**
 * Metaobject field keys whose values are real copy. Everything else
 * (lab_name, clinic, verifier_name, verifier_license, ingredient name/INCI,
 * batch, dates, URLs, numbers) is deliberately left untranslated.
 */
export const TRANSLATABLE_FIELD_KEYS = new Set([
  "title", // clinical study title
  "concern", // clinical study concern
  "instruments", // clinical study instruments description
  "footnote", // clinical study footnote
  "label", // study result label
  "suffix", // study result suffix (letter-less ones are skipped anyway)
  "statement", // verified B/A verifier statement
  "form", // ingredient form ("encapsulated", ...)
  "note", // ingredient note
  "intro", // batch transparency intro
]);

const URL_VALUE = /^https?:\/\//i;
const ISO_DATE_VALUE = /^\d{4}-\d{2}-\d{2}/;
const HAS_LETTERS = /\p{L}/u;

/** Allowlisted key AND a value that actually contains language. */
export function shouldTranslateField(key: string, value: string): boolean {
  if (!TRANSLATABLE_FIELD_KEYS.has(key)) return false;
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (URL_VALUE.test(trimmed)) return false;
  if (ISO_DATE_VALUE.test(trimmed)) return false;
  if (!HAS_LETTERS.test(trimmed)) return false;
  return true;
}

/** Every booster metaobject GID attached to a product (parents + leaves). */
export function collectBoosterResourceGids(
  boosters: ProductBoostersResult,
): string[] {
  const gids: string[] = [];
  if (boosters.clinicalStudy) {
    gids.push(boosters.clinicalStudy.id);
    for (const result of boosters.clinicalStudy.results) gids.push(result.id);
  }
  for (const ba of boosters.beforeAfters) gids.push(ba.id);
  if (boosters.batchTransparency) {
    gids.push(boosters.batchTransparency.id);
    for (const ing of boosters.batchTransparency.ingredients) gids.push(ing.id);
    for (const coa of boosters.batchTransparency.certificates) gids.push(coa.id);
  }
  return gids.filter((gid) => typeof gid === "string" && gid.startsWith("gid://"));
}

// ---------------------------------------------------------------------------
// Shopify translations plumbing
// ---------------------------------------------------------------------------

export interface ShopLocaleInfo {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
}

const SHOP_LOCALES_QUERY = `#graphql
  query cellexiaTranslationShopLocales {
    shopLocales { locale name primary published }
  }
`;

export interface TargetLocalesResult {
  locales: ShopLocaleInfo[];
  primary: string | null;
  /** Published, non-primary locales — the translation targets. */
  targets: string[];
  errors: string[];
}

export async function getTargetLocales(
  admin: AdminGraphqlClient,
): Promise<TargetLocalesResult> {
  const result = await adminRequest<{ shopLocales: ShopLocaleInfo[] | null }>(
    admin,
    SHOP_LOCALES_QUERY,
    {},
  );
  const locales = (result.data?.shopLocales ?? []).filter(
    (l): l is ShopLocaleInfo => typeof l?.locale === "string",
  );
  return {
    locales,
    primary: locales.find((l) => l.primary)?.locale ?? null,
    targets: locales
      .filter((l) => l.published && !l.primary)
      .map((l) => l.locale),
    errors: result.errors,
  };
}

/** GraphQL alias for a locale's existing-translations lookup. */
export function aliasForLocale(locale: string): string {
  return `t_${locale.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

/**
 * Built dynamically so ONE query fetches, per resource, the source content
 * AND the existing translations for every target locale (aliased). Locales
 * come from Shopify's shopLocales and are validated before interpolation.
 */
function translatableByIdsQuery(locales: string[]): string {
  const aliases = locales
    .filter((locale) => /^[a-zA-Z0-9-]+$/.test(locale))
    .map(
      (locale) =>
        `${aliasForLocale(locale)}: translations(locale: "${locale}") { key outdated }`,
    )
    .join("\n        ");
  return `#graphql
  query cellexiaTranslatableByIds($ids: [ID!]!) {
    translatableResourcesByIds(first: 250, resourceIds: $ids) {
      nodes {
        resourceId
        translatableContent { key value digest locale }
        ${aliases}
      }
    }
  }
`;
}

const TRANSLATIONS_REGISTER_MUTATION = `#graphql
  mutation cellexiaTranslationsRegister($id: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $id, translations: $translations) {
      userErrors { field message }
    }
  }
`;

interface TranslatableNode {
  resourceId: string;
  translatableContent: {
    key: string;
    value: string | null;
    digest: string | null;
    locale: string;
  }[];
  /** Aliased per-locale existing translations (t_fr, t_pt_PT, ...). */
  [alias: string]: unknown;
}

interface ExistingTranslation {
  key: string;
  outdated: boolean;
}

function existingCurrentKeys(
  node: TranslatableNode,
  locale: string,
): Set<string> {
  const raw = node[aliasForLocale(locale)];
  if (!Array.isArray(raw)) return new Set();
  return new Set(
    (raw as ExistingTranslation[])
      .filter((t) => t && typeof t.key === "string" && t.outdated === false)
      .map((t) => t.key),
  );
}

interface RegisterData {
  translationsRegister: {
    userErrors: { field?: string[] | null; message: string }[];
  } | null;
}

export interface LocaleRunReport {
  locale: string;
  status: "done" | "unsupported" | "skipped" | "error";
  error?: string;
}

export interface TranslateRunSummary {
  ok: boolean;
  errors: string[];
  /** Source fields that qualified for translation. */
  fieldCount: number;
  resourceCount: number;
  /** Characters submitted to DeepL across all languages (quota estimate). */
  characterCount: number;
  locales: LocaleRunReport[];
}

/**
 * Translate the allowlisted fields of the given metaobjects into every
 * target locale and register the results as Shopify translations.
 *
 * Incremental by design: a field that already has a CURRENT translation in
 * a locale (machine or manually edited in Translate & Adapt — Shopify does
 * not distinguish) is left untouched, so manual edits are preserved and
 * re-runs cost no quota. A field is re-translated only when its source text
 * changed (Shopify marks the old translation `outdated`). Identical source
 * strings are deduplicated per run, and each language succeeds or fails
 * independently.
 */
export async function translateResources(
  admin: AdminGraphqlClient,
  apiKey: string,
  resourceGids: string[],
  targetLocales: string[],
): Promise<TranslateRunSummary> {
  const summary: TranslateRunSummary = {
    ok: false,
    errors: [],
    fieldCount: 0,
    resourceCount: 0,
    characterCount: 0,
    locales: [],
  };
  if (resourceGids.length === 0) {
    summary.errors.push(
      "This product has no booster content yet — save a clinical study, before/after or batch section first.",
    );
    return summary;
  }
  if (targetLocales.length === 0) {
    summary.errors.push(
      "The shop has no published extra languages — add languages in Shopify Settings → Languages first.",
    );
    return summary;
  }

  // 1. Current source content + digests + existing per-locale translations,
  //    in one query (digests are per-field versions; a changed source marks
  //    old translations `outdated`, which is what triggers a re-translate).
  const query = translatableByIdsQuery(targetLocales);
  const nodes: TranslatableNode[] = [];
  for (const slice of chunk(resourceGids, 250)) {
    const result = await adminRequest<{
      translatableResourcesByIds: { nodes: TranslatableNode[] } | null;
    }>(admin, query, { ids: slice });
    if (result.errors.length) {
      summary.errors.push(...result.errors);
      return summary;
    }
    nodes.push(...(result.data?.translatableResourcesByIds?.nodes ?? []));
  }

  interface WorkField {
    resourceId: string;
    key: string;
    value: string;
    digest: string;
  }
  const fields: WorkField[] = [];
  let sourceLocale: string | null = null;
  for (const node of nodes) {
    for (const content of node.translatableContent ?? []) {
      if (!content.digest || typeof content.value !== "string") continue;
      if (!shouldTranslateField(content.key, content.value)) continue;
      sourceLocale = sourceLocale ?? content.locale;
      fields.push({
        resourceId: node.resourceId,
        key: content.key,
        value: content.value,
        digest: content.digest,
      });
    }
  }
  summary.resourceCount = nodes.length;
  summary.fieldCount = fields.length;
  if (fields.length === 0) {
    summary.errors.push(
      "No translatable text found in this product's booster content.",
    );
    return summary;
  }

  const sourceLang = sourceLocale
    ? deeplSourceForLocale(sourceLocale)
    : undefined;
  const nodeByResource = new Map(nodes.map((n) => [n.resourceId, n]));

  // 2. Per language: translate only the fields with no CURRENT translation
  //    (missing or outdated), deduplicated, then register per resource. One
  //    failed language never blocks the others.
  for (const locale of targetLocales) {
    const targetLang = deeplTargetForLocale(locale);
    if (!targetLang) {
      summary.locales.push({ locale, status: "unsupported" });
      continue;
    }
    // Same base language as the source (e.g. an en-US market language on an
    // en shop): DeepL would just echo the input and Shopify already falls
    // back to the primary text — skip the quota spend entirely.
    if (sourceLang && targetLang.split("-")[0] === sourceLang) {
      summary.locales.push({ locale, status: "skipped" });
      continue;
    }
    const currentKeys = new Map<string, Set<string>>();
    for (const [resourceId, node] of nodeByResource) {
      currentKeys.set(resourceId, existingCurrentKeys(node, locale));
    }
    const needed = fields.filter(
      (field) => !currentKeys.get(field.resourceId)?.has(field.key),
    );
    if (needed.length === 0) {
      // Everything already has an up-to-date translation (ours or a manual
      // Translate & Adapt edit) — nothing to spend or overwrite.
      summary.locales.push({ locale, status: "done" });
      continue;
    }
    const uniqueTexts = [...new Set(needed.map((f) => f.value))];
    const batch = await deeplTranslateBatch(
      apiKey,
      uniqueTexts,
      targetLang,
      sourceLang,
    );
    if (!batch.ok) {
      summary.locales.push({
        locale,
        status: "error",
        error: batch.error ?? "DeepL request failed",
      });
      continue;
    }
    summary.characterCount += uniqueTexts.reduce((n, t) => n + t.length, 0);
    const translatedByText = new Map<string, string>();
    uniqueTexts.forEach((text, index) => {
      translatedByText.set(text, batch.translations[index] ?? "");
    });

    const byResource = new Map<string, WorkField[]>();
    for (const field of needed) {
      const list = byResource.get(field.resourceId) ?? [];
      list.push(field);
      byResource.set(field.resourceId, list);
    }
    const registerErrors: string[] = [];
    for (const [resourceId, resourceFields] of byResource) {
      const inputs = resourceFields
        .map((field) => ({
          key: field.key,
          locale,
          value: translatedByText.get(field.value) ?? "",
          translatableContentDigest: field.digest,
        }))
        .filter((input) => input.value.trim() !== "");
      for (const slice of chunk(inputs, 100)) {
        const result = await adminRequest<RegisterData>(
          admin,
          TRANSLATIONS_REGISTER_MUTATION,
          { id: resourceId, translations: slice },
        );
        registerErrors.push(
          ...(result.data?.translationsRegister?.userErrors ?? []).map(
            (e) => e.message,
          ),
          ...result.errors,
        );
      }
    }
    if (registerErrors.length) {
      summary.locales.push({
        locale,
        status: "error",
        error: `Shopify rejected some translations: ${[...new Set(registerErrors)].slice(0, 3).join("; ")}`,
      });
    } else {
      summary.locales.push({ locale, status: "done" });
    }
  }

  summary.ok =
    summary.locales.some((l) => l.status === "done") ||
    (summary.locales.some((l) => l.status === "skipped") &&
      !summary.locales.some((l) => l.status === "error"));
  return summary;
}
