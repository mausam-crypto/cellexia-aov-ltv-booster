/**
 * v39.1 — product names for the dedicated results page
 * (docs/SPEC-v39-results-page.md, "v39.1").
 *
 * The page shows which product each before/after belongs to and lets
 * shoppers filter by product. The results table only stores product GIDs,
 * so the proof proxy resolves them here: title (in the shopper's language
 * when Shopify holds a translation), handle, featured image, and whether
 * the product is on the Online Store (only then does the storefront link
 * to it).
 *
 * READ-ONLY, one query. Cached in memory per shop + language so a busy
 * results page costs one Admin call every few minutes, not one per
 * shopper. Fail-soft by contract: any failure returns {} and the page
 * simply shows no product names and no product filter, never an error.
 */
import { adminRequest } from "./metaobjects.server";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/** Storefront shape, lean keys (it rides every results-page response):
 *  t title, h handle, i featured image URL, u 1 = on the Online Store. */
export interface ResultProductInfo {
  t: string;
  h: string;
  i?: string;
  u?: 1;
}

export type ResultProductMap = Record<string, ResultProductInfo>;

/** `nodes(ids:)` accepts up to 250 ids per call. */
export const RESULT_PRODUCTS_MAX = 250;
const TTL_OK_MS = 10 * 60 * 1000;
/** A failed lookup is remembered briefly so an outage is not retried on
 *  every shopper request. */
const TTL_FAIL_MS = 60 * 1000;
const CACHE_MAX_KEYS = 200;

const PRODUCTS_QUERY = `#graphql
  query cellexiaResultProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
        onlineStoreUrl
        featuredImage {
          url
        }
      }
    }
  }
`;

const PRODUCTS_TRANSLATED_QUERY = `#graphql
  query cellexiaResultProductsTranslated($ids: [ID!]!, $locale: String!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
        onlineStoreUrl
        featuredImage {
          url
        }
        translations(locale: $locale) {
          key
          value
        }
      }
    }
  }
`;

interface ProductNode {
  id?: unknown;
  title?: unknown;
  handle?: unknown;
  onlineStoreUrl?: unknown;
  featuredImage?: { url?: unknown } | null;
  translations?: { key?: unknown; value?: unknown }[] | null;
}

/**
 * The proxy lowercases the storefront locale ("pt-pt"); Shopify's locale
 * codes carry an upper-case region ("pt-PT"). Returns null for anything
 * that is not a plain language or language-region code.
 */
export function shopifyLocaleCode(
  locale: string | null | undefined,
): string | null {
  if (typeof locale !== "string") return null;
  const match = /^([a-z]{2,3})(?:-([a-z0-9]{2,8}))?$/i.exec(locale.trim());
  if (!match) return null;
  const language = match[1].toLowerCase();
  return match[2] ? `${language}-${match[2].toUpperCase()}` : language;
}

/** Numeric ids only, deduped, capped. */
export function cleanProductIds(ids: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !/^\d{1,20}$/.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
    if (out.length >= RESULT_PRODUCTS_MAX) break;
  }
  return out;
}

/**
 * Admin nodes -> storefront map (pure; the sim drives it directly).
 * Unknown or deleted ids come back as null nodes and drop out. A product
 * without a usable title or handle drops out too, so the storefront never
 * renders an empty label or a broken link.
 */
export function buildResultProductMap(
  nodes: readonly (ProductNode | null | undefined)[],
): ResultProductMap {
  const map: ResultProductMap = {};
  for (const node of nodes) {
    if (!node || typeof node.id !== "string") continue;
    const idMatch = /^gid:\/\/shopify\/Product\/(\d+)$/.exec(node.id);
    if (!idMatch) continue;
    const translated = Array.isArray(node.translations)
      ? node.translations.find(
          (row) =>
            row &&
            row.key === "title" &&
            typeof row.value === "string" &&
            /\S/.test(row.value),
        )
      : undefined;
    const rawTitle =
      translated && typeof translated.value === "string"
        ? translated.value
        : typeof node.title === "string"
          ? node.title
          : "";
    const title = rawTitle.trim().slice(0, 120);
    const handle = typeof node.handle === "string" ? node.handle.trim() : "";
    if (title === "" || handle === "" || /[\s/?#]/.test(handle)) continue;
    const info: ResultProductInfo = { t: title, h: handle.slice(0, 255) };
    const image = node.featuredImage?.url;
    if (typeof image === "string" && /^https:\/\/\S+$/.test(image)) {
      info.i = image;
    }
    if (typeof node.onlineStoreUrl === "string" && node.onlineStoreUrl !== "") {
      info.u = 1;
    }
    map[idMatch[1]] = info;
  }
  return map;
}

interface CacheEntry {
  at: number;
  ok: boolean;
  /** Every id this entry was asked for (found or not). */
  asked: Set<string>;
  map: ResultProductMap;
}

const cache = new Map<string, CacheEntry>();

/** Test hook: the sim resets the cache between cases. */
export function clearResultProductsCache(): void {
  cache.clear();
}

function pick(map: ResultProductMap, ids: string[]): ResultProductMap {
  const out: ResultProductMap = {};
  for (const id of ids) {
    if (map[id]) out[id] = map[id];
  }
  return out;
}

/**
 * Product info for the given numeric product ids, in the shopper's
 * language when a title translation exists. Never throws.
 */
export async function getResultProducts(
  admin: AdminGraphqlClient | null | undefined,
  shop: string,
  productIds: readonly unknown[],
  locale: string | null | undefined,
  now: number = Date.now(),
): Promise<ResultProductMap> {
  const ids = cleanProductIds(productIds);
  if (!admin || ids.length === 0) return {};
  const localeCode = shopifyLocaleCode(locale);
  const key = `${shop}|${localeCode ?? ""}`;
  const hit = cache.get(key);
  if (
    hit &&
    now - hit.at < (hit.ok ? TTL_OK_MS : TTL_FAIL_MS) &&
    ids.every((id) => hit.asked.has(id))
  ) {
    return pick(hit.map, ids);
  }

  const gids = ids.map((id) => `gid://shopify/Product/${id}`);
  let nodes: (ProductNode | null)[] | null = null;
  if (localeCode) {
    const translated = await adminRequest<{ nodes: (ProductNode | null)[] }>(
      admin,
      PRODUCTS_TRANSLATED_QUERY,
      { ids: gids, locale: localeCode },
    );
    if (translated.errors.length === 0 && translated.data?.nodes) {
      nodes = translated.data.nodes;
    }
  }
  if (!nodes) {
    // No locale, or the translated read failed (a language the shop does
    // not publish, a missing read_translations grant): the primary-
    // language titles still serve.
    const plain = await adminRequest<{ nodes: (ProductNode | null)[] }>(
      admin,
      PRODUCTS_QUERY,
      { ids: gids },
    );
    if (plain.errors.length === 0 && plain.data?.nodes) {
      nodes = plain.data.nodes;
    }
  }

  if (cache.size >= CACHE_MAX_KEYS && !cache.has(key)) cache.clear();
  const entry: CacheEntry = {
    at: now,
    ok: nodes !== null,
    asked: new Set(ids),
    map: nodes ? buildResultProductMap(nodes) : {},
  };
  cache.set(key, entry);
  return pick(entry.map, ids);
}
