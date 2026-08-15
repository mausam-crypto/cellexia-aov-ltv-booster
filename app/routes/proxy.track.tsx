import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { recordEvent } from "../services/analytics.server";

/**
 * Storefront analytics endpoint, reached through the Shopify App Proxy:
 *
 *   https://<shop-domain>/apps/cellexia/track  ->  <app-url>/proxy/track
 *
 * The theme app extension posts widget impressions/clicks/upgrades here.
 * authenticate.public.appProxy verifies the request signature, so only
 * requests genuinely proxied by Shopify for this shop are accepted.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    // v13.1: no offline session row for this shop means EVERY beacon dies
    // here, and the fire-and-forget sender never notices. Log it so a
    // session-storage wipe (db reset, sqlite→postgres move without the
    // Session rows) shows up in the server logs instead of as silent zeros.
    const shopParam =
      new URL(request.url).searchParams.get("shop") ?? "unknown shop";
    console.warn(
      `[cellexia-track] beacon rejected for ${shopParam}: no offline session ` +
        "for this shop — open the app once from the Shopify admin (or " +
        "reinstall it) to restore the session row.",
    );
    return Response.json({ ok: false }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const ok = await recordEvent(session.shop, {
    feature: String(body.feature ?? ""),
    type: String(body.type ?? ""),
    quantity:
      typeof body.quantity === "number" ? body.quantity : undefined,
    revenue: typeof body.revenue === "number" ? body.revenue : undefined,
    currency:
      typeof body.currency === "string" ? body.currency : undefined,
    market: typeof body.market === "string" ? body.market : undefined,
    meta: typeof body.meta === "string" ? body.meta : undefined,
  });

  return Response.json({ ok });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return Response.json({ ok: true, service: "cellexia-booster" });
};
