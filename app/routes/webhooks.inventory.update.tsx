import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getSettings } from "../models/settings.server";
import {
  getRewardsState,
  giftVariantGids,
  refreshGiftStock,
} from "../services/rewards.server";

/**
 * v14 rewards gift-stock watcher (docs/SPEC-v14-rewards.md §3):
 * `inventory_levels/update` → refreshGiftStock, debounced 60 s per shop
 * (in-memory; a trailing run is scheduled so the LAST update in a burst is
 * never lost) and only when the inventory item belongs to a gift/sample
 * variant — known from RewardsState.giftStock.items (inventoryItemId →
 * variantId, written by every refresh) or, before the first refresh, when
 * the settings configure any gift variant at all (bootstrap run).
 *
 * Always acknowledges with 200 immediately (the refresh itself runs
 * detached): Shopify would otherwise retry and eventually drop the
 * subscription. Every step is best-effort and isolated.
 */

interface InventoryLevelPayload {
  inventory_item_id?: number | string | null;
  location_id?: number | string | null;
  available?: number | null;
}

const DEBOUNCE_MS = 60 * 1000;
const lastRunAt = new Map<string, number>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

async function runRefresh(
  admin: NonNullable<Awaited<ReturnType<typeof authenticate.webhook>>["admin"]>,
  shop: string,
): Promise<void> {
  lastRunAt.set(shop, Date.now());
  try {
    const settings = await getSettings(shop);
    const result = await refreshGiftStock(admin, shop, settings);
    if (!result.ok) {
      console.warn(`[cellexia-rewards] gift stock refresh for ${shop}: ${result.errors.join("; ")}`);
    }
  } catch (error) {
    console.error(`[cellexia-rewards] gift stock refresh crashed for ${shop}:`, error);
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  // authenticate.webhook only provides an admin client when an offline
  // session exists for the shop; without one there is nothing to refresh.
  if (!admin) return new Response();

  const level = payload as unknown as InventoryLevelPayload;
  const itemId = String(level?.inventory_item_id ?? "").replace(/\D/g, "");
  if (!itemId) return new Response();

  try {
    const state = await getRewardsState(shop);
    const known = Object.keys(state.giftStock.items).length > 0;
    if (known) {
      if (!state.giftStock.items[itemId]) return new Response();
    } else {
      // Never refreshed yet: bootstrap only when gifts are configured.
      const settings = await getSettings(shop);
      if (giftVariantGids(settings).length === 0) return new Response();
    }

    const elapsed = Date.now() - (lastRunAt.get(shop) ?? 0);
    if (elapsed >= DEBOUNCE_MS) {
      // Fire-and-forget: the refresh does several Admin calls; Shopify wants
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
    console.error(`[cellexia-rewards] inventory webhook failed for ${shop}:`, error);
  }
  return new Response();
};
