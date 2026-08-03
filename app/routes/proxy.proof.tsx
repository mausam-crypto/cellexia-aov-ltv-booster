import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  DURATION_BUCKETS,
  PROXY_PER_DEFAULT,
  PROXY_PER_MAX,
  getPublicEndorsements,
  getPublicPress,
  getPublicResults,
} from "../services/proof.server";
import type { PublicResultsFilters } from "../services/proof.server";

/**
 * Public proof-library endpoint, reached through the Shopify App Proxy
 * (docs/SPEC-v8-proof-library.md §2):
 *
 *   https://<shop-domain>/apps/cellexia/proof  ->  <app-url>/proxy/proof
 *
 * GET only. authenticate.public.appProxy verifies the request signature, so
 * only requests genuinely proxied by Shopify for this shop are accepted —
 * the shop is taken from the verified session, never from a parameter.
 *
 * Query: `type=press|endorsements|results` (required); common `product`
 * (numeric product id or gid — normalised to a gid); results-only filters
 * `concern`, `age`, `skin`, `duration` (lt8|8to12|gt12); `page` (1-based)
 * and `per` (max 24) for endorsements + results. Responses are JSON with
 * `Cache-Control: public, max-age=60, s-maxage=300` so Shopify's CDN absorbs
 * storefront traffic.
 *
 * Serving rules (enforced in proof.server.ts): approved rows only; ordering
 * featured desc, sortWeight asc, createdAt desc; with `product`, items tagged
 * with that product first, then brand-level ([]) items, items tagged for
 * OTHER products excluded. Results add `verifiedTotal` (approved AND
 * verified over the unfiltered product-scoped set — the honest scale-banner
 * number) and `facets` computed over the same unfiltered set so filter-chip
 * counts stay stable. Pending/hidden rows, the shop column and admin fields
 * (status, featured, sortWeight, productGids, legacyGid) never leave the
 * server. All strings are served raw — the storefront renders exclusively
 * via textContent.
 */

const PROOF_CACHE_CONTROL = "public, max-age=60, s-maxage=300";

const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/\d+$/;

/** Numeric product id or full gid -> gid; anything else -> null (ignored). */
function normalizeProductParam(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "") return null;
  if (/^\d+$/.test(value)) return `gid://shopify/Product/${value}`;
  return PRODUCT_GID_PATTERN.test(value) ? value : null;
}

function positiveInt(raw: string | null): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Market handle (v8.1 press scoping) — settings marketHandlePattern twin. */
function normalizeMarketParam(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) ? value : null;
}

function jsonResponse(body: unknown, cacheable: boolean, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": cacheable ? PROOF_CACHE_CONTROL : "no-store",
    },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return jsonResponse({ error: "unauthorized" }, false, 401);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonResponse({ error: "method not allowed" }, false, 405);
  }
  const shop = session.shop;

  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  const product = normalizeProductParam(url.searchParams.get("product"));
  const page = positiveInt(url.searchParams.get("page")) ?? 1;
  const per = Math.min(
    positiveInt(url.searchParams.get("per")) ?? PROXY_PER_DEFAULT,
    PROXY_PER_MAX,
  );

  try {
    switch (type) {
      case "press": {
        const market = normalizeMarketParam(url.searchParams.get("market"));
        const payload = await getPublicPress(shop, product, market);
        return jsonResponse(payload, true);
      }
      case "endorsements": {
        const payload = await getPublicEndorsements(shop, product, page, per);
        return jsonResponse(payload, true);
      }
      case "results": {
        const filters: PublicResultsFilters = {};
        const concern = (url.searchParams.get("concern") ?? "").trim();
        if (concern !== "") filters.concern = concern.toLowerCase();
        const age = (url.searchParams.get("age") ?? "").trim();
        if (age !== "") filters.age = age;
        const skin = (url.searchParams.get("skin") ?? "").trim();
        if (skin !== "") filters.skin = skin;
        const duration = (url.searchParams.get("duration") ?? "").trim();
        if ((DURATION_BUCKETS as readonly string[]).includes(duration)) {
          filters.duration = duration;
        }
        const payload = await getPublicResults(shop, product, filters, page, per);
        return jsonResponse(payload, true);
      }
      default:
        return jsonResponse(
          { error: "type must be press, endorsements or results" },
          false,
          400,
        );
    }
  } catch {
    // Never leak internals to the storefront; the widget fails closed.
    return jsonResponse({ error: "unavailable" }, false, 500);
  }
};
