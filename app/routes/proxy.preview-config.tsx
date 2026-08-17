import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  FEATURE_KEYS,
  getSettings,
  isFeatureOnForMarket,
} from "../models/settings.server";
import {
  getPreviewState,
  tokenHashFor,
  verifyToken,
} from "../services/preview.server";

/**
 * Preview runtime config endpoint, reached through the Shopify App Proxy:
 *
 *   https://<shop-domain>/apps/cellexia/preview-config?t=<raw>
 *
 * Called by the theme extension JS when a browser holds a preview token in
 * sessionStorage AND the (tokenless) Liquid config says preview is armed.
 * Plain JSON, NOT liquid — no theme wrapping, no caching.
 *
 * Valid token →
 *   {
 *     valid: true,
 *     armed,                    // PreviewState.armed
 *     draftFlags,               // {} whenever disarmed (defense in depth)
 *     simulatedMarket,          // market handle or null
 *     marketSimulated,          // false → bar shows "current market"
 *     liveEffectiveForMarket,   // Record<FeatureKey, boolean> — what is LIVE
 *                               //   in the simulated market, so the preview
 *                               //   shows live ∪ draft (exactly what going
 *                               //   live would look like). null simulated
 *                               //   market uses the empty handle, which
 *                               //   matches "all"-scoped features but no
 *                               //   "selected"-scope lists — the JS never
 *                               //   does scope logic itself.
 *     tokenHash,                // sha256 hex of the raw token — the exact
 *   }                           //   value the storefront runtime writes to
 *                               //   the `_cx_preview` cart attribute so ANY
 *                               //   path into checkout carries it (checkout
 *                               //   extensions compare attribute ===
 *                               //   preview.tokenHash, plain string
 *                               //   equality). Safe to expose here: only a
 *                               //   verified raw-token bearer receives it,
 *                               //   and checkout sessions already see the
 *                               //   same hash via the shop metafield.
 * Invalid token → { valid: false } with 200 (no detail leakage, no retries).
 *
 * Unexpected server errors → { valid: false, retriable: true } with 503, so
 * the storefront runtime can distinguish "this token is definitively
 * invalid" (drop it) from "the server hiccuped" (keep the token, retry
 * later). A genuinely failed verifyToken stays 200 { valid: false }.
 */

const JSON_HEADERS = { "Cache-Control": "no-store" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return Response.json(
      { valid: false },
      { status: 404, headers: JSON_HEADERS },
    );
  }

  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("t") ?? "";

    const valid = await verifyToken(session.shop, token);
    if (!valid) {
      return Response.json({ valid: false }, { headers: JSON_HEADERS });
    }

    const [state, settings] = await Promise.all([
      getPreviewState(session.shop),
      getSettings(session.shop),
    ]);
    // verifyToken passed, so the row exists; guard anyway (deleted mid-flight).
    if (!state) {
      return Response.json({ valid: false }, { headers: JSON_HEADERS });
    }

    const simulatedMarket = state.simulatedMarket ?? null;
    const liveEffectiveForMarket = Object.fromEntries(
      FEATURE_KEYS.map((key) => [
        key,
        isFeatureOnForMarket(settings, key, simulatedMarket ?? ""),
      ]),
    );

    return Response.json(
      {
        valid: true,
        armed: state.armed,
        draftFlags: state.armed ? state.draftFlags : {},
        simulatedMarket,
        marketSimulated: simulatedMarket !== null && simulatedMarket !== "",
        liveEffectiveForMarket,
        tokenHash: tokenHashFor(state.token),
      },
      { headers: JSON_HEADERS },
    );
  } catch (error) {
    // Server error ≠ invalid token: 503 + retriable so the runtime keeps
    // the token and tries again instead of dropping out of preview mode.
    console.error(
      `preview-config failed for ${session.shop} (transient?):`,
      error,
    );
    return Response.json(
      { valid: false, retriable: true },
      { status: 503, headers: JSON_HEADERS },
    );
  }
};
