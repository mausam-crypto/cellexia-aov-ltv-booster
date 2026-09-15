import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSettings, GATE_IDS } from "../models/settings.server";
import { gateOnDigest, gateOffDigest } from "../models/gate-digest";
import {
  GATE_COOKIE_NAME,
  gateExpiry,
  parseGateValue,
  readCookie,
  serializeGateValue,
  GATE_TTL_SECONDS,
  type GateUnlocks,
} from "../models/gate-cookie";

/**
 * v22 parameter gates — the durable-cookie endpoint, reached through the
 * Shopify App Proxy:
 *
 *   https://<shop-domain>/apps/cellexia/gate  ->  <app-url>/proxy/gate
 *
 * WHY this exists at all: the extension already wrote the unlock to
 * localStorage and to document.cookie before calling here, so the feature
 * works with this route unreachable. What it adds is longevity — Safari's
 * ITP caps a cookie written by JavaScript at 7 days regardless of how long
 * a Max-Age it asks for, while a cookie set by a first-party response like
 * this one keeps the full 90. The extension calls it once per unlock (and
 * again only if it later finds the cookie gone but the localStorage mirror
 * alive), never on an ordinary page view.
 *
 * The client sends DIGESTS, not gate ids, so this endpoint cannot be used to
 * unlock a gate without already knowing the parameter — it maps each digest
 * back through the shop's own gates and ignores anything that does not match.
 */

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_DIGESTS = 16;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    // Same failure mode the track beacon documents (v13.1): with no offline
    // session row this returns 401 to a fire-and-forget caller that will
    // never notice, so the log line is the only place it can surface.
    const shopParam =
      new URL(request.url).searchParams.get("shop") ?? "unknown shop";
    console.warn(
      `[cellexia-gate] request rejected for ${shopParam}: no offline session ` +
        "for this shop — open the app once from the Shopify admin (or " +
        "reinstall it) to restore the session row.",
    );
    return Response.json({ ok: false }, { status: 401, headers: NO_STORE });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { ok: false, error: "invalid json" },
      { status: 400, headers: NO_STORE },
    );
  }

  const sent = Array.isArray(body.d)
    ? body.d
        .filter((item): item is string => typeof item === "string")
        .slice(0, MAX_DIGESTS)
    : [];
  if (sent.length === 0) {
    return Response.json({ ok: true, gates: [] }, { headers: NO_STORE });
  }

  const settings = await getSettings(session.shop);
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Start from what the visitor already carries, so unlocking a second gate
  // never drops the first and never resets the first one's clock.
  const unlocks: GateUnlocks = parseGateValue(
    readCookie(request.headers.get("cookie"), GATE_COOKIE_NAME),
    nowSeconds,
  );

  const opened: string[] = [];
  for (const id of GATE_IDS) {
    const gate = settings.paramGates?.[id];
    if (!gate || gate.enabled !== true || !gate.param || !gate.token) continue;
    if (sent.includes(gateOffDigest(gate.param))) {
      // The clear digest wins over the open digest: a URL carrying both is
      // nonsense, and refusing to open is the safe reading of it.
      delete unlocks[id];
      continue;
    }
    if (sent.includes(gateOnDigest(gate.param, gate.token))) {
      unlocks[id] = gateExpiry(nowSeconds);
      opened.push(id);
    }
  }

  const value = serializeGateValue(unlocks, nowSeconds);
  const headers = new Headers(NO_STORE);
  // No Domain attribute: it must default to the storefront host the proxy
  // was reached on, so the cookie stays first-party. Not HttpOnly — the
  // extension has to read it back on the next page view.
  headers.append(
    "Set-Cookie",
    value === ""
      ? `${GATE_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax; Secure`
      : `${GATE_COOKIE_NAME}=${value}; Path=/; Max-Age=${GATE_TTL_SECONDS}; SameSite=Lax; Secure`,
  );
  return Response.json({ ok: true, gates: opened }, { headers });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return Response.json(
    { ok: true, service: "cellexia-booster" },
    { headers: NO_STORE },
  );
};

