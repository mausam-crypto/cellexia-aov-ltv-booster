import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { lookupUsState } from "../services/geo.server";

/**
 * IP→US-state lookup for the storefront delivery widget, reached through the
 * Shopify App Proxy (docs/SPEC-v10-us-state-delivery.md §6):
 *
 *   https://<shop-domain>/apps/cellexia/geo  ->  <app-url>/proxy/geo
 *
 * GET/HEAD only. authenticate.public.appProxy verifies the request
 * signature, so only requests genuinely proxied by Shopify for this shop are
 * accepted — the shop comes from the verified session, never from a
 * parameter. No query parameters are read.
 *
 * PRIVACY CONTRACT (SPEC doctrine #3): the client IP is the FIRST entry of
 * x-forwarded-for — Shopify sends the buyer IP there; hosting platforms may
 * append their own hops. It is resolved against the self-hosted DB-IP table
 * (geo.server.ts) and discarded: never stored, never logged, and never
 * echoed back — the response body is only {s}.
 *
 * EVERY response is `Cache-Control: no-store`: the answer is per-IP, so any
 * shared cache between the visitor and this loader (Shopify's CDN, a
 * merchant-fronting CDN, the browser) would cross-serve one visitor's state
 * to every other visitor behind the same URL.
 *
 * Lookup problems return 200 {s:null}: the storefront treats a non-state as
 * "keep the US-wide promise" (fail-open, SPEC doctrine #1), and a 200 keeps
 * VPN/unknown-range visitors from filling the console with errors.
 */

function geoResponse(state: string | null, status = 200) {
  return Response.json(
    { s: state },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return geoResponse(null, 401);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return geoResponse(null, 405);
  }
  try {
    const forwarded = request.headers.get("x-forwarded-for") ?? "";
    const ip = forwarded.split(",")[0].trim();
    if (ip === "") {
      return geoResponse(null);
    }
    return geoResponse(await lookupUsState(session.shop, ip));
  } catch {
    // Never leak internals; the state layer fails open to US-wide.
    return geoResponse(null);
  }
};
