import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { marketCountryMap } from "../services/markets.server";

interface OrderLineItem {
  quantity: number;
  title?: string;
  sku?: string | null;
  product_id?: number | null;
  selling_plan_allocation?: { selling_plan?: { id?: number } } | null;
  properties?: { name: string; value: string }[] | null;
}

interface OrderAddress {
  country_code?: string | null;
}

interface OrderPayload {
  id: number;
  total_price?: string;
  total_price_set?: {
    shop_money?: { amount?: string; currency_code?: string } | null;
  } | null;
  currency?: string;
  processed_at?: string;
  created_at?: string;
  line_items?: OrderLineItem[];
  note_attributes?: { name: string; value: string }[] | null;
  shipping_address?: OrderAddress | null;
  billing_address?: OrderAddress | null;
}

const COUNTRY_CODE_PATTERN = /^[A-Za-z]{2}$/;

/**
 * Rolls each paid order into an OrderStat row so the dashboard can report
 * AOV, units per order, subscription rate, protection attach rate and
 * upsell-attributed order share — without persisting order payloads.
 *
 * v2: additionally attributes the order to a Shopify Market by resolving the
 * shipping (fallback: billing) country through the markets regions map, so
 * the experiment tracker can compute per-market metrics. Attribution is
 * best-effort — any failure leaves market/country null and never fails the
 * webhook (Shopify would otherwise retry and eventually drop the delivery).
 *
 * v4: orders placed through a merchant preview checkout carry the
 * `_cx_preview` cart attribute (surfaced by Shopify as an order note
 * attribute) and are skipped entirely — preview checkouts must never
 * pollute analytics or experiments. The skip requires an exact match
 * against the CURRENT PreviewState token: cart attributes are settable by
 * any buyer via the public cart API, so a mere non-empty `_cx_preview`
 * must never be enough to hide an order from analytics.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const order = payload as unknown as OrderPayload;

  // v4 preview guard: skip ONLY when the `_cx_preview` note attribute
  // exactly equals the shop's current PreviewState token (row exists, token
  // non-empty). Anything else — missing row, empty token, mismatch, or a
  // failed lookup — counts the order: a buyer-forgeable attribute must not
  // be able to suppress analytics. On a genuine match, acknowledge the
  // webhook (200, so Shopify does not retry) WITHOUT writing an OrderStat.
  const previewAttribute =
    (order.note_attributes ?? []).find(
      (a) => a.name === "_cx_preview" && a.value,
    )?.value ?? "";
  if (previewAttribute) {
    try {
      const previewState = await db.previewState.findUnique({
        where: { shop },
      });
      if (
        previewState &&
        typeof previewState.token === "string" &&
        previewState.token.length > 0 &&
        previewState.token === previewAttribute
      ) {
        console.log(
          `Skipping OrderStat for preview order ${order.id} on ${shop} (_cx_preview attribute matches the current preview token)`,
        );
        return new Response();
      }
      console.log(
        `Counting order ${order.id} on ${shop} despite _cx_preview attribute (it does not match the current preview token)`,
      );
    } catch (error) {
      // Lookup failure → count the order (never let an unverifiable
      // attribute hide revenue from analytics).
      console.error(
        `Preview-token lookup failed for order ${order.id} on ${shop} — counting the order:`,
        error,
      );
    }
  }

  const lineItems = order.line_items ?? [];

  const unitCount = lineItems.reduce((sum, li) => sum + (li.quantity || 0), 0);
  const hasSubscription = lineItems.some(
    (li) => li.selling_plan_allocation?.selling_plan,
  );
  const hasProtection = lineItems.some(
    (li) =>
      li.title?.toLowerCase().includes("order protection") ||
      (li.properties ?? []).some((p) => p.name === "_cellexia_protection"),
  );
  const upsellAttributed =
    lineItems.some((li) =>
      (li.properties ?? []).some((p) => p.name === "_cellexia_upsell"),
    ) ||
    (order.note_attributes ?? []).some((a) => a.name === "_cellexia_upsell");

  const processedAt = order.processed_at ?? order.created_at;

  // Prefer shop_money so every OrderStat row is in the one shop currency —
  // total_price/currency are in the (potentially varying) presentment currency.
  const shopMoney = order.total_price_set?.shop_money;

  // --- Market attribution (best-effort, never fails the webhook) -----------
  let market: string | null = null;
  let countryCode: string | null = null;
  try {
    const rawCountry =
      order.shipping_address?.country_code ??
      order.billing_address?.country_code ??
      null;
    if (typeof rawCountry === "string" && COUNTRY_CODE_PATTERN.test(rawCountry)) {
      countryCode = rawCountry.toUpperCase();
    }
    // authenticate.webhook only provides an admin client when an offline
    // session exists for the shop; without one we simply skip attribution.
    if (admin && countryCode) {
      const map = await marketCountryMap(admin, shop);
      market = map.byCountry.get(countryCode) ?? null;
    }
  } catch (error) {
    console.error(`Market attribution failed for ${shop}:`, error);
  }

  await db.orderStat.upsert({
    where: { orderId: String(order.id) },
    create: {
      shop,
      orderId: String(order.id),
      totalPrice: parseFloat(shopMoney?.amount ?? order.total_price ?? "0") || 0,
      currency: shopMoney?.currency_code ?? order.currency ?? "",
      lineCount: lineItems.length,
      unitCount,
      hasSubscription,
      hasProtection,
      upsellAttributed,
      market,
      countryCode,
      processedAt: processedAt ? new Date(processedAt) : new Date(),
    },
    update: {},
  });

  return new Response();
};
