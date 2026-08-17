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
 * used by the az similar-items/FBT enrichment and the site-wide bestseller
 * card decorator; the cart map is always included.
 *
 * v6.4: every productsByHandle entry additionally carries
 *   "bestseller": {rank, category} | null
 * — rank from the pdp_flags JSON metafield (bestsellerLabel.rank), category
 * METAFIELD-FIRST from product.metafields.cellexia.bestseller_category
 * (single_line_text_field, a TRANSLATABLE resource Shopify serves LOCALIZED
 * for the requesting storefront language automatically) with the legacy
 * pdp_flags bestsellerLabel.category as fallback. null unless BOTH a rank>0
 * and a nonblank category exist (the storefront honesty gate).
 *
 * v6.6: a productsByHandle entry gains "bought": <int> ONLY when the
 * per-product pdp_flags.boughtCount is > 0 AND boughtCountSetAt is within
 * 45 days — the freshness is computed HERE in the rendered Liquid with the
 * exact epoch math amazon-booster.liquid uses (age >= 0 and <= 3888000 s),
 * so a stale or absent count simply OMITS the field and the card decorator
 * can never render an outdated claim.
 *
 * v14: every entry (cart map AND productsByHandle) gains `"s": 1` when the
 * product carries the `sample-sachet` tag — the storefront's sachet flag
 * (excluded from set-savings counting, FBT/similar picks and cross-sell;
 * mirrors the cart-booster.liquid "products" map).
 *
 * v15: every productsByHandle entry additionally carries `"t"` (product
 * title) and `"h"` (handle) — the cart runtime resolves the gift-tier
 * products (option handles + samplePool) through this endpoint lazily
 * instead of an all_products loop inside the cart island (the v15 island
 * isolation); the cart map is unchanged.
 */

const sanitizeHandle = (handle: string) =>
  handle.toLowerCase().replace(/[^a-z0-9-_]/g, "");

/** v15 handles-mode identity: product title + handle (the cart runtime's
 *  lazy gift-product lookup; the recommendations payload never reaches
 *  the cart, so the proxy is the only title source there). */
const TITLE_LIQUID = (accessor: string) => `,
        "t": {{ ${accessor}.title | json }}, "h": {{ ${accessor}.handle | json }}`;

/** Per-product bestseller flag data (v6.4, handles mode only — see the
 *  contract note above). Rendered through Liquid, so the metafield value
 *  arrives already localized for the request's storefront language. */
const BESTSELLER_LIQUID = (accessor: string) => `,
        "bestseller": {%- assign cx_bs_flags = ${accessor}.metafields.cellexia.pdp_flags.value -%}{%- assign cx_bs_rank = cx_bs_flags.bestsellerLabel.rank | default: 0 -%}{%- assign cx_bs_cat = ${accessor}.metafields.cellexia.bestseller_category.value | default: cx_bs_flags.bestsellerLabel.category | default: '' -%}{%- if cx_bs_rank > 0 and cx_bs_cat != blank -%}{"rank": {{ cx_bs_rank }}, "category": {{ cx_bs_cat | json }}}{%- else -%}null{%- endif -%}${BOUGHT_LIQUID}`;

/** v6.6 bought-count freshness, evaluated in the SAME Liquid render (reuses
 *  the cx_bs_flags assign above): the exact amazon-booster.liquid epoch math
 *  — '%s' epochs, age >= 0 and <= 3888000 (45 days). Fresh -> ", \"bought\": n";
 *  stale/absent -> the field is omitted entirely (fail closed). */
const BOUGHT_LIQUID = `{%- assign cx_bt_n = cx_bs_flags.boughtCount | default: 0 -%}{%- assign cx_bt_set = 0 -%}{%- if cx_bs_flags.boughtCountSetAt -%}{%- assign cx_bt_set = cx_bs_flags.boughtCountSetAt | date: '%s' | plus: 0 -%}{%- endif -%}{%- assign cx_bt_now = 'now' | date: '%s' | plus: 0 -%}{%- if cx_bt_n > 0 and cx_bt_set > 0 -%}{%- assign cx_bt_age = cx_bt_now | minus: cx_bt_set -%}{%- if cx_bt_age >= 0 and cx_bt_age <= 3888000 -%}, "bought": {{ cx_bt_n }}{%- endif -%}{%- endif -%}`;

const PRODUCT_BODY_LIQUID = (accessor: string, withBestseller = false) => `{
        "variants": [
          {%- for variant in ${accessor}.variants -%}
            {"id": {{ variant.id | json }}, "option1": {{ variant.option1 | json }}, "price": {{ variant.price | json }}, "compare_at_price": {{ variant.compare_at_price | default: 'null' }}, "available": {{ variant.available | json }}, "position": {{ forloop.index }}, "planAllocations": [
              {%- for alloc in variant.selling_plan_allocations -%}
                {"planId": {{ alloc.selling_plan.id | json }}, "price": {{ alloc.price | json }}}{%- unless forloop.last -%},{%- endunless -%}
              {%- endfor -%}
            ]}{%- unless forloop.last -%},{%- endunless -%}
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
        ]{%- if ${accessor}.tags contains 'sample-sachet' -%}, "s": 1{%- endif -%}${withBestseller ? TITLE_LIQUID(accessor) + BESTSELLER_LIQUID(accessor) : ""}
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
      return `"${handle}": {% if ${accessor}.id %}${PRODUCT_BODY_LIQUID(accessor, true)}{% else %}null{% endif %}`;
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
