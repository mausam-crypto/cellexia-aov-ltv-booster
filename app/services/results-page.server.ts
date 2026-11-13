/**
 * v39 dedicated results page (docs/SPEC-v39-results-page.md).
 *
 * The admin side of "turn one online-store page into the before/after
 * results page". Everything here READS — the app holds only the read-only
 * `read_online_store_pages` scope and never creates, edits or deletes a
 * page (the validation harness pins the absence of every page mutation).
 * The page itself becomes a results page purely because the proof embed's
 * Liquid gate matches its id (settings `beforeAfter.pageId`) and the
 * storefront script draws the gallery under the page's own content.
 *
 * Fail-soft by contract (the listHomeSections precedent): every call
 * returns ok:false with a human reason instead of throwing, so a missing
 * scope or an API hiccup degrades the tab to a clear message.
 */
import { adminRequest } from "./metaobjects.server";
import {
  fetchStorefrontText,
  inspectStorefrontIslands,
  looksPasswordProtected,
} from "./health.server";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/** Any of these lets the app read pages. Only the first is ever requested;
 *  the others are accepted so a broader existing grant is not reported as
 *  "missing" (a write scope implies its read). */
const PAGE_READ_SCOPES = [
  "read_online_store_pages",
  "read_content",
  "write_online_store_pages",
  "write_content",
] as const;

export const RESULTS_PAGE_SCOPE = "read_online_store_pages";

/** How many pages one picker request lists. */
export const RESULTS_PAGE_LIST_SIZE = 50;

export interface StorePage {
  /** Numeric Shopify page id — what settings store and Liquid matches. */
  id: number;
  title: string;
  handle: string;
  isPublished: boolean;
  /** "" = the theme's default page template. */
  templateSuffix: string;
}

export interface StorePageDetail extends StorePage {
  /** Characters of visible text in the page's own content (HTML removed).
   *  Computed here — the body itself never leaves the server. */
  bodyTextLength: number;
  /** The page body embeds images/video/iframes (content with no text). */
  bodyHasMedia: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** "gid://shopify/Page/123" → 123; anything else → 0. */
export function pageIdFromGid(gid: unknown): number {
  if (typeof gid !== "string") return 0;
  const match = /^gid:\/\/shopify\/Page\/(\d{1,16})$/.exec(gid);
  if (!match) return 0;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

export function pageGid(id: number): string {
  return `gid://shopify/Page/${id}`;
}

/** Form value → page id (positive safe integer) or 0. */
export function parsePageId(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d{1,16}$/.test(raw.trim())) return 0;
  const id = Number(raw.trim());
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

/**
 * Free-text search box → a Shopify search-syntax `query` for the pages
 * list. Only letters, digits, spaces, hyphens and underscores survive, so
 * the term can never inject field filters or boolean operators; each word
 * becomes a prefix match on the title.
 */
export function pageSearchQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const words = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0 && /[\p{L}\p{N}]/u.test(word))
    .slice(0, 5);
  return words.map((word) => `title:${word.slice(0, 40)}*`).join(" ");
}

/** Visible-text length + media presence of a page body (HTML). */
export function summarizePageBody(html: unknown): {
  textLength: number;
  hasMedia: boolean;
} {
  if (typeof html !== "string" || html === "") {
    return { textLength: 0, hasMedia: false };
  }
  const hasMedia = /<(img|video|iframe|picture|svg|object|embed)\b/i.test(html);
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&[a-z#0-9]+;/gi, "x")
    .replace(/\s+/g, " ")
    .trim();
  return { textLength: text.length, hasMedia };
}

export type ResultsPageGoLiveBlocker =
  | "no_page"
  | "page_missing"
  | "page_hidden"
  | "feature_off"
  | "no_results";

/**
 * The ONE go-live rule, shared by the tab (to enable/disable the button
 * and say why) and the action (re-checked server-side on the click).
 * Returns the blockers in the order staff should fix them; empty = go.
 */
export function resultsPageGoLiveBlockers(input: {
  pageId: number;
  /** null = the chosen page could not be found any more. */
  page: Pick<StorePage, "isPublished"> | null;
  featureEnabled: boolean;
  approvedResults: number;
}): ResultsPageGoLiveBlocker[] {
  if (input.pageId <= 0) return ["no_page"];
  const blockers: ResultsPageGoLiveBlocker[] = [];
  if (!input.page) blockers.push("page_missing");
  else if (!input.page.isPublished) blockers.push("page_hidden");
  if (!input.featureEnabled) blockers.push("feature_off");
  if (!(input.approvedResults > 0)) blockers.push("no_results");
  return blockers;
}

export const GO_LIVE_BLOCKER_TEXT: Record<ResultsPageGoLiveBlocker, string> = {
  no_page: "Choose a page first.",
  page_missing:
    "The chosen page no longer exists in Shopify. Choose another page.",
  page_hidden:
    "The page is Hidden in Shopify. Set it to Visible first (Online Store → Pages).",
  feature_off:
    "Before/after results are switched off. Turn them on in the Results tab first.",
  no_results:
    "There are no approved results yet. Approve at least one in the Results tab.",
};

// ---------------------------------------------------------------------------
// Admin API reads
// ---------------------------------------------------------------------------

const CONTEXT_QUERY = `#graphql
  query cellexiaResultsPageContext {
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
    shop {
      primaryDomain {
        url
      }
    }
  }
`;

export interface ResultsPageContext {
  ok: boolean;
  error: string;
  /** The app may read online-store pages. */
  canReadPages: boolean;
  /** Storefront origin without a trailing slash ("" when unknown). */
  storefrontOrigin: string;
}

/** Granted scopes (is the page-read permission approved yet?) + the
 *  storefront's public origin, in one round trip. */
export async function getResultsPageContext(
  admin: AdminGraphqlClient,
): Promise<ResultsPageContext> {
  const { data, errors } = await adminRequest<{
    currentAppInstallation?: {
      accessScopes?: { handle?: string | null }[] | null;
    } | null;
    shop?: { primaryDomain?: { url?: string | null } | null } | null;
  }>(admin, CONTEXT_QUERY);
  const scopes = data?.currentAppInstallation?.accessScopes;
  if (!Array.isArray(scopes)) {
    return {
      ok: false,
      error: errors.join("; ") || "Could not read the app's permissions.",
      canReadPages: false,
      storefrontOrigin: "",
    };
  }
  const granted = new Set(
    scopes.map((scope) => (typeof scope?.handle === "string" ? scope.handle : "")),
  );
  const rawOrigin = data?.shop?.primaryDomain?.url;
  return {
    ok: true,
    error: "",
    canReadPages: PAGE_READ_SCOPES.some((scope) => granted.has(scope)),
    storefrontOrigin:
      typeof rawOrigin === "string" && /^https:\/\//i.test(rawOrigin)
        ? rawOrigin.replace(/\/+$/, "")
        : "",
  };
}

interface PageNode {
  id?: string | null;
  title?: string | null;
  handle?: string | null;
  isPublished?: boolean | null;
  templateSuffix?: string | null;
  body?: string | null;
}

function toStorePage(node: PageNode | null | undefined): StorePage | null {
  if (!node) return null;
  const id = pageIdFromGid(node.id);
  if (id === 0 || typeof node.handle !== "string" || node.handle === "") {
    return null;
  }
  return {
    id,
    title:
      typeof node.title === "string" && node.title.trim() !== ""
        ? node.title.trim()
        : node.handle,
    handle: node.handle,
    isPublished: node.isPublished === true,
    templateSuffix:
      typeof node.templateSuffix === "string" ? node.templateSuffix.trim() : "",
  };
}

const PAGES_LIST_QUERY = `#graphql
  query cellexiaResultsPageList($first: Int!, $query: String) {
    pages(first: $first, query: $query, sortKey: TITLE) {
      nodes {
        id
        title
        handle
        isPublished
        templateSuffix
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

export interface StorePageList {
  ok: boolean;
  error: string;
  pages: StorePage[];
  /** More pages match than one request lists — tell staff to search. */
  hasMore: boolean;
}

/** The store's pages (title order), optionally narrowed by a title search. */
export async function listStorePages(
  admin: AdminGraphqlClient,
  search?: string | null,
): Promise<StorePageList> {
  const query = pageSearchQuery(search ?? "");
  const { data, errors } = await adminRequest<{
    pages?: {
      nodes?: PageNode[] | null;
      pageInfo?: { hasNextPage?: boolean | null } | null;
    } | null;
  }>(admin, PAGES_LIST_QUERY, {
    first: RESULTS_PAGE_LIST_SIZE,
    query: query || null,
  });
  const nodes = data?.pages?.nodes;
  if (!Array.isArray(nodes)) {
    return {
      ok: false,
      error: errors.join("; ") || "Shopify did not return the list of pages.",
      pages: [],
      hasMore: false,
    };
  }
  const pages: StorePage[] = [];
  for (const node of nodes) {
    const page = toStorePage(node);
    if (page) pages.push(page);
  }
  return {
    ok: true,
    error: "",
    pages,
    hasMore: data?.pages?.pageInfo?.hasNextPage === true,
  };
}

const PAGE_DETAIL_QUERY = `#graphql
  query cellexiaResultsPageDetail($id: ID!) {
    page(id: $id) {
      id
      title
      handle
      isPublished
      templateSuffix
      body
    }
  }
`;

export interface StorePageLookup {
  /** false = the API call itself failed (page stays UNKNOWN, not missing). */
  ok: boolean;
  error: string;
  /** null with ok:true = Shopify has no such page any more. */
  page: StorePageDetail | null;
}

/** One page by numeric id, with the size of its own content. */
export async function getStorePage(
  admin: AdminGraphqlClient,
  id: number,
): Promise<StorePageLookup> {
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { ok: true, error: "", page: null };
  }
  const { data, errors } = await adminRequest<{ page?: PageNode | null }>(
    admin,
    PAGE_DETAIL_QUERY,
    { id: pageGid(id) },
  );
  if (!data || errors.length > 0) {
    return {
      ok: false,
      error: errors.join("; ") || "Shopify did not return the page.",
      page: null,
    };
  }
  const base = toStorePage(data.page);
  if (!base) return { ok: true, error: "", page: null };
  const body = summarizePageBody(data.page?.body);
  return {
    ok: true,
    error: "",
    page: {
      ...base,
      bodyTextLength: body.textLength,
      bodyHasMedia: body.hasMedia,
    },
  };
}

// ---------------------------------------------------------------------------
// Storefront probe
// ---------------------------------------------------------------------------

export type ResultsPageProbe =
  /** The gallery's config marker is in the page's HTML — it is wired up. */
  | { status: "ready" }
  /** The page loaded but carries no marker (embed off / not synced yet). */
  | { status: "absent" }
  /** The whole storefront sits behind a password page. */
  | { status: "password" }
  /** The page could not be loaded (hidden, deleted, network). */
  | { status: "unreachable" }
  /** Not attempted (no page, or no storefront address). */
  | { status: "skipped" };

/**
 * Loads the chosen page the way a shopper's browser would and looks for the
 * gallery's config marker (#cx-results-config). The embed emits that marker
 * on the chosen page whether it is live or still a draft, so its presence
 * proves — in one check — that the embed is on, the extension is deployed,
 * the settings reached the storefront and the page id matches.
 */
export async function probeResultsPage(
  storefrontOrigin: string,
  handle: string,
): Promise<ResultsPageProbe> {
  if (!storefrontOrigin || !handle) return { status: "skipped" };
  const html = await fetchStorefrontText(
    `${storefrontOrigin}/pages/${encodeURIComponent(handle)}`,
  );
  if (html === null) return { status: "unreachable" };
  if (looksPasswordProtected(html)) return { status: "password" };
  const islands = inspectStorefrontIslands(html, ["cx-results-config"]);
  return { status: islands.length > 0 ? "ready" : "absent" };
}
