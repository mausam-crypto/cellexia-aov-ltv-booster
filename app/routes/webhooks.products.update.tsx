import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSettings } from "../models/settings.server";
import { refreshVolumePricing } from "../services/volume-pricing.server";
import { syncSettingsToMetafields } from "../services/metafields.server";

/**
 * v32 volume pricing — price-change watcher
 * (docs/SPEC-v32-volume-pricing.md §2.5): `products/update` → a full
 * volume refresh, debounced 120 s per shop (in-memory; a trailing run is
 * scheduled so the LAST update in an edit burst is never lost), and only
 * while the merchant has the volume sub-flag on (the p1 staleness anchor
 * already fail-closes the discount in the gap between a price edit and
 * this refresh — a stale config can only UNDER-apply, never mischarge).
 *
 * Always acknowledges with 200 immediately (the refresh itself runs
 * detached): Shopify would otherwise retry and eventually drop the
 * subscription. Every step is best-effort and isolated — the
 * webhooks.inventory.update.tsx pattern.
 */

const DEBOUNCE_MS = 120 * 1000;
const lastRunAt = new Map<string, number>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

async function runRefresh(
  admin: NonNullable<Awaited<ReturnType<typeof authenticate.webhook>>["admin"]>,
  shop: string,
): Promise<void> {
  lastRunAt.set(shop, Date.now());
  try {
    const settings = await getSettings(shop);
    if (settings.quantitySync.volume !== true) return;
    const result = await refreshVolumePricing(admin, shop, settings, { force: false });
    if (!result.ok) {
      console.warn(`[cellexia-volume] price refresh for ${shop}: ${result.errors.join("; ")}`);
    }
    // v32.1: mirror the storefront's volumeLive verdict from the refreshed
    // volume config (best-effort like everything in this route).
    try {
      await syncSettingsToMetafields(admin, settings);
    } catch (error) {
      console.warn(`[cellexia-volume] post-refresh sync for ${shop}:`, error);
    }
  } catch (error) {
    console.error(`[cellexia-volume] price refresh crashed for ${shop}:`, error);
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  // authenticate.webhook only provides an admin client when an offline
  // session exists for the shop; without one there is nothing to refresh.
  if (!admin) return new Response();

  try {
    const settings = await getSettings(shop);
    if (settings.quantitySync.volume !== true) return new Response();

    const elapsed = Date.now() - (lastRunAt.get(shop) ?? 0);
    if (elapsed >= DEBOUNCE_MS) {
      // Fire-and-forget: the refresh does many Admin calls; Shopify wants
      // the 200 within seconds. runRefresh never rejects (it logs).
      void runRefresh(admin, shop);
    } else if (!pending.has(shop)) {
      // Trailing edge: one run when the quiet window ends.
      const timer = setTimeout(() => {
        pending.delete(shop);
        void runRefresh(admin, shop);
      }, DEBOUNCE_MS - elapsed);
      timer.unref?.();
      pending.set(shop, timer);
    }
  } catch (error) {
    console.error(`[cellexia-volume] products webhook failed for ${shop}:`, error);
  }
  return new Response();
};
