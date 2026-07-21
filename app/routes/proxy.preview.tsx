import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  sanitizeMarketHandle,
  sanitizeProductHandle,
  verifyToken,
} from "../services/preview.server";

/**
 * Preview entry point, reached through the Shopify App Proxy:
 *
 *   https://<shop-domain>/apps/cellexia/preview?t=<raw>&product=<h>&market=<m>
 *
 * Returns `application/liquid`. On a VALID token the body deliberately does
 * NOT use {% layout none %}: Shopify wraps it in the REAL published theme
 * layout (header, footer, mini-cart drawer, all theme CSS/JS — and therefore
 * our app embeds), which is the whole point of the preview system: real
 * rendering only. The body is the "Cellexia Preview Hub" panel whose inline
 * script seeds sessionStorage with the preview token before the embeds boot.
 *
 * TOKEN RULES: the raw token is interpolated ONLY into inline <script>
 * strings on this page — the previewing merchant's own browser, which is the
 * entry-URL bearer anyway. It never reaches the app-data metafield or any
 * page a real visitor can load without the token. The inline script also
 * strips the token-bearing query string from the address bar
 * (history.replaceState) right after seeding sessionStorage, so third-party
 * trackers in the theme layout cannot pick it up via page_location/referrer.
 *
 * All copy is hardcoded English: this is a merchant-facing tool, not buyer
 * UI, so it stays out of the 17-language locale pipeline on purpose.
 */

const LIQUID_HEADERS = {
  "Content-Type": "application/liquid",
  "Cache-Control": "no-store",
};

/** JSON-stringify for safe embedding inside an inline <script>. */
const jsString = (value: string) =>
  JSON.stringify(value).replace(/</g, "\\u003c");

const INVALID_BODY = `{% layout none %}<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Preview unavailable</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1D1D1B;">
  <div style="max-width:420px;margin:24px;padding:32px;background:#fff;border:1px solid #e5e5e5;border-radius:16px;text-align:center;">
    <p style="margin:0 0 8px;font-size:18px;font-weight:700;">This preview link is no longer valid.</p>
    <p style="margin:0;font-size:14px;color:#6b6b69;">Ask for a fresh link from the Cellexia Booster Preview Center (the token may have been rotated or the preview disarmed).</p>
  </div>
</body>
</html>`;

const buildHubBody = (
  token: string,
  productHandle: string,
  market: string,
): string => {
  const tokenJs = jsString(token);
  const marketJs = jsString(market);

  // `cx_preview_ok` is the key the storefront runtime keys its inline
  // session-beacon suppression on. This page only renders after a
  // SERVER-SIDE verifyToken pass, so seeding it optimistically is correct.
  const sessionScript = `<script>
(function () {
  try {
    sessionStorage.setItem('cx_preview_token', ${tokenJs});
    sessionStorage.setItem('cx_preview_ok', '1');
    ${
      market
        ? `sessionStorage.setItem('cx_preview_market', ${marketJs});`
        : `sessionStorage.removeItem('cx_preview_market');`
    }
    history.replaceState(null, '', location.pathname);
  } catch (e) {
    /* storage unavailable — preview widgets simply will not activate */
  }
})();
</script>`;

  const productAssign = productHandle
    ? `{%- assign cx_preview_product = all_products['${productHandle}'] -%}\n`
    : "";

  const actionStyle =
    "display:block;padding:12px 16px;border:1px solid #1D1D1B;border-radius:10px;text-decoration:none;color:#1D1D1B;font-weight:600;font-size:15px;text-align:center;background:#fff;";
  const mutedStyle =
    "display:block;padding:12px 16px;border:1px dashed #c9c9c7;border-radius:10px;color:#6b6b69;font-size:14px;text-align:center;";

  const productAction = productHandle
    ? `{% if cx_preview_product.id %}
        <a class="cx-preview-hub__action cx-preview-hub__action--product" style="${actionStyle}" href="{{ cx_preview_product.url }}">View product page — {{ cx_preview_product.title | escape }}</a>
      {% else %}
        <span class="cx-preview-hub__action cx-preview-hub__action--missing" style="${mutedStyle}">Preview product "${productHandle}" was not found — pick another in the Preview Center.</span>
      {% endif %}`
    : `<span class="cx-preview-hub__action cx-preview-hub__action--missing" style="${mutedStyle}">No preview product selected — choose one in the Preview Center.</span>`;

  const variantIdLiquid = productHandle
    ? `{% if cx_preview_product.first_available_variant %}{{ cx_preview_product.first_available_variant.id | json }}{% elsif cx_preview_product.variants.first %}{{ cx_preview_product.variants.first.id | json }}{% else %}null{% endif %}`
    : "null";

  const checkoutScript = `<script>
(function () {
  var btn = document.getElementById('cx-preview-checkout');
  if (!btn) return;
  var token = ${tokenJs};
  var variantId = ${variantIdLiquid};
  var idle = btn.textContent;
  btn.addEventListener('click', function () {
    if (!variantId) {
      alert('Pick a preview product in the Preview Center first — the checkout preview needs a product it can add to the cart.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Preparing checkout\\u2026';
    fetch('/cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('adding the product failed (' + res.status + ')');
        return fetch('/cart/update.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attributes: { _cx_preview: token } })
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error('tagging the cart failed (' + res.status + ')');
        window.location.href = '/checkout';
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = idle;
        alert('Could not prepare the preview checkout: ' + (err && err.message ? err.message : err));
      });
  });
})();
</script>`;

  return `${productAssign}${sessionScript}
<div class="cx-preview-hub" style="margin:40px auto;max-width:560px;padding:0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1D1D1B;">
  <div class="cx-preview-hub__card" style="background:#fff;border:1px solid #e5e5e5;border-radius:16px;padding:32px;box-shadow:0 10px 30px rgba(29,29,27,0.08);">
    <span class="cx-preview-hub__badge" style="display:inline-block;background:#B2CEED;color:#1D1D1B;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:4px 10px;border-radius:999px;">Preview mode</span>
    <h1 class="cx-preview-hub__title" style="margin:14px 0 8px;font-size:24px;line-height:1.2;">Cellexia preview is active in this tab</h1>
    <p class="cx-preview-hub__copy" style="margin:0 0 10px;font-size:15px;line-height:1.5;color:#3f3f3d;">You are browsing the real storefront with draft Cellexia widgets switched on for this browser only. Real visitors see no change, and no analytics are recorded while you preview.</p>
    <p class="cx-preview-hub__note" style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#6b6b69;">Look for the Cellexia preview bar at the bottom of storefront pages — it confirms preview is on and lets you exit.</p>
    ${
      market
        ? `<p class="cx-preview-hub__market" style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#6b6b69;">Simulating market: <strong style="color:#1D1D1B;">${market}</strong></p>`
        : ""
    }
    <div class="cx-preview-hub__actions" style="display:flex;flex-direction:column;gap:10px;margin-top:20px;">
      ${productAction}
      <a class="cx-preview-hub__action cx-preview-hub__action--browse" style="${actionStyle}" href="/">Browse the store</a>
      <button id="cx-preview-checkout" type="button" class="cx-preview-hub__action cx-preview-hub__action--checkout" style="display:block;width:100%;padding:12px 16px;border:1px solid #1D1D1B;border-radius:10px;background:#1D1D1B;color:#fff;font-weight:600;font-size:15px;text-align:center;cursor:pointer;">Preview checkout</button>
    </div>
    <p class="cx-preview-hub__hint" style="margin:14px 0 0;font-size:12px;line-height:1.5;color:#8a8a88;">"Preview checkout" adds the preview product to your cart, tags the cart as a preview (so the order is excluded from analytics), and opens the real checkout.</p>
  </div>
</div>
${checkoutScript}`;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("t") ?? "";
  const productHandle = sanitizeProductHandle(url.searchParams.get("product"));
  const market = sanitizeMarketHandle(url.searchParams.get("market"));

  const valid = await verifyToken(session.shop, token);
  if (!valid) {
    return new Response(INVALID_BODY, { headers: LIQUID_HEADERS });
  }

  return new Response(buildHubBody(token, productHandle, market), {
    headers: LIQUID_HEADERS,
  });
};
