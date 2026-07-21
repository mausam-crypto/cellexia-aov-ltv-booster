import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * Storefront data endpoint, reached through the Shopify App Proxy:
 *
 *   https://<shop-domain>/apps/cellexia/cart-data  ->  <app-url>/proxy/cart-data
 *
 * Returns `application/liquid`, which Shopify renders IN STOREFRONT CONTEXT
 * (with access to the buyer's cart, customer and presentment currency) before
 * returning it to the browser. The theme extension's cellexia-cart.js calls
 * this whenever the cart contains products missing from its server-rendered
 * config map (e.g. added after page load).
 *
 * CONTRACT (must stay in sync with extensions/cellexia-booster/blocks/
 * cart-booster.liquid "products" map and assets/cellexia-cart.js
 * normalizeProductsPayload): top-level { "products": { "<productId>": {
 * variants: [{id, option1, price, compare_at_price, available, position}],
 * sellingPlanGroups: [{id, name, plans: [{id, name, valueType, value}]}] } } }
 *
 * Optional ?handles=a,b,c adds a "productsByHandle" map (all_products, max 20)
 * for future use; the cart map is always included.
 */

const sanitizeHandle = (handle: string) =>
  handle.toLowerCase().replace(/[^a-z0-9-_]/g, "");

const PRODUCT_BODY_LIQUID = (accessor: string) => `{
        "variants": [
          {%- for variant in ${accessor}.variants -%}
            {"id": {{ variant.id | json }}, "option1": {{ variant.option1 | json }}, "price": {{ variant.price | json }}, "compare_at_price": {{ variant.compare_at_price | default: 'null' }}, "available": {{ variant.available | json }}, "position": {{ forloop.index }}}{%- unless forloop.last -%},{%- endunless -%}
          {%- endfor -%}
        ],
        "sellingPlanGroups": [
          {%- for group in ${accessor}.selling_plan_groups -%}
            {"id": {{ group.id | json }}, "name": {{ group.name | json }}, "plans": [
              {%- for plan in group.selling_plans -%}
                {"id": {{ plan.id | json }}, "name": {{ plan.name | json }}, "valueType": {{ plan.price_adjustments[0].value_type | json }}, "value": {{ plan.price_adjustments[0].value | default: 0 }}}{%- unless forloop.last -%},{%- endunless -%}
              {%- endfor -%}
            ]}{%- unless forloop.last -%},{%- endunless -%}
          {%- endfor -%}
        ]
      }`;

const CART_PRODUCTS_LIQUID = `"products": {
    {%- assign cx_seen = ',' -%}
    {%- assign cx_first = true -%}
    {%- for item in cart.items -%}
      {%- assign cx_pid = item.product_id | append: '' -%}
      {%- assign cx_tok = ',' | append: cx_pid | append: ',' -%}
      {%- unless cx_seen contains cx_tok -%}
        {%- assign cx_seen = cx_seen | append: cx_pid | append: ',' -%}
        {%- unless cx_first -%},{%- endunless -%}
        {%- assign cx_first = false -%}
        {{ cx_pid | json }}: ${PRODUCT_BODY_LIQUID("item.product")}
      {%- endunless -%}
    {%- endfor -%}
  }`;

const handlesLiquid = (handles: string[]) => {
  const entries = handles
    .map((handle) => {
      const accessor = `all_products['${handle}']`;
      return `"${handle}": {% if ${accessor}.id %}${PRODUCT_BODY_LIQUID(accessor)}{% else %}null{% endif %}`;
    })
    .join(",\n    ");
  return `,
  "productsByHandle": {
    ${entries}
  }`;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const handlesParam = url.searchParams.get("handles");
  const handles = handlesParam
    ? handlesParam.split(",").map(sanitizeHandle).filter(Boolean).slice(0, 20)
    : [];

  const body = `{% layout none %}{
  "b2b": {% if customer.b2b? %}true{% else %}false{% endif %},
  "currency": {{ cart.currency.iso_code | json }},
  ${CART_PRODUCTS_LIQUID}${handles.length ? handlesLiquid(handles) : ""}
}`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/liquid",
      "Cache-Control": "no-store",
    },
  });
};
