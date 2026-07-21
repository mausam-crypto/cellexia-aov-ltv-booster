# Sleepify Theme — Integration Facts (source of truth for widget code)

Theme root: `../existing-shopify-theme` (Sleepless Media "Sleepify" v1.0.1, heavily customized for Cellexia).

## Cart stack
- **CartJS 1.1.0 + jQuery** (both global). `CartJS.init({{ cart | json }})` in `snippets/script-tags.liquid`.
- All cart mutations are AJAX (`/cart/add.js`, `/cart/change.js`, `/cart/update.js`) via `CartJS.addItem/updateItem/removeItem`.
- Global money formatter: `formatter` (an `Intl.NumberFormat`, defined in `sections/footer.liquid`). Use it when present, fall back to `Intl.NumberFormat` with `Shopify.currency.active`.
- `window.Shopify.routes.root` is available and must prefix cart endpoints (locale-aware URLs!).

## Mini-cart drawer (`sections/mini-cart.liquid`)
```
section.mini-cart[data-freeship="{{ settings.free_ship | times: 100 }}"]   <- threshold in cents (currently 150.00)
 └ .mini-cart__content
    ├ .mini-cart__header
    ├ .mini-cart__list        <- ONLY this node's innerHTML is rebuilt by refreshMiniCart()
    ├ .mini-cart__footer      <- subtotal panel (bg #f4f4f4)
    └ .mini-cart__actions     <- checkout + view-cart buttons
```
- Open/close: `showMini()` / `closeMini()` toggle `.mini-cart.is-open` + `body.cart-open` (in `assets/_sleepify.authored.bundle.js`).
- After add-to-cart the theme calls `jQuery.getJSON(Shopify.routes.root + 'cart.js', cart => refreshMiniCart(cart))`. `refreshMiniCart` is a global function; it replaces `.mini-cart__list` HTML, updates totals and calls `showMini()`.
- **Widgets must be injected as SIBLINGS between `.mini-cart__list` and `.mini-cart__footer`** so they survive re-renders. React to cart changes by observing `.mini-cart` class/childList mutations (the theme itself uses a MutationObserver on the `class` attribute).
- Pre-wired theme handler (reusable, zero JS needed): clicks on `.mini-cart__upsell .action--atc` add `closest('.upsell').attr('data-id')` as variant id, qty 1, then refresh. 
- Line rows are `.product.product--cart` with `data-lineid` (1-based index) and `data-varid`.
- Cart page (`sections/cart.liquid`): table `.cart-table`, rows `tr.cart-row[data-varid][data-lineid]`; insertion point between `.cart__table` and `.cart__footer`.

## Volume pricing = VARIANTS (critical)
Products sell 1/2/3-unit tiers as **variants of one option** (discounts baked into variant price vs compare_at_price: 2u = −15 %, 3u = −20 %).
`snippets/pdp-options.liquid` renders tier buttons with `data-units="{{ forloop.index }}"` — i.e. **variant position = unit count**.
An in-cart "upgrade to 2/3 units" therefore means **swapping the cart line to the higher-tier variant** (`/cart/change.js` qty 0 on the old line + `/cart/add.js` with the new variant id, preserving `selling_plan`), NOT bumping quantity.

## Subscriptions = Joy (Avada) via NATIVE selling plans
- Joy Subscription app embed is enabled (`joy-subscription` in settings_data.json). Plans are native Shopify selling plans, fully visible to Liquid (`product.selling_plan_groups`) and the AJAX cart API (`selling_plan` param on `/cart/add.js`, `/cart/change.js`).
- Discount is dynamic: `selling_plan.price_adjustments[0].value` (percentage). Do not hardcode 5 % — read it from the plan; 5 % is only the default.
- Cart lines show plan via `line_item.selling_plan_allocation.selling_plan.name`; drawer renders it in `<span class="delivery">`.
- **B2B customers must NOT see subscription offers**: check `window.isB2BCustomer === true` (set by `layout/theme.liquid`); body also gets `customer--b2b`.
- The PDP plan selector is the theme's own `sm-rc-widget` (hidden `select[sm-rc-plan-selector]`, `[name="selling_plan"]`).

## Design tokens (compiled CSS — no CSS variables in the theme; hardcode to match)
- Fonts: headings `"Gobold", sans-serif` (bold, uppercase feel); body `"argumentum", sans-serif` (Typekit, already loaded by the theme). The brand PDF also names "Atami", but the live theme uses Gobold + Argumentum.
- Colors: ink `#1d1d1b` (text/primary buttons/borders), light-blue accent `#b1cded` (brand PDF: `#B2CEED` — theme uses `#b1cded`; use `#b1cded` for consistency), panel grey `#f4f4f4`, border grey `#d8d8d8`, muted `#808080`, white.
- Buttons: pills — `padding:15px 20px; font-weight:600; font-size:14px; letter-spacing:1px; border-radius:70px; min-height:50px;`
  - `.btn--primary` ink bg/white text (hover inverts), `.btn--secondary` `#b1cded` bg, `.btn--tert` transparent + ink border.
- Headings: `.heading--two` 25px, `.heading--four` 16px, `.heading--five` 14px (all Gobold 700). `.eyebrow` = 14px, letter-spacing 5px; `.eyebrow--sm` smaller.
- Cards: `padding:15px; border:2px solid #f4f4f4; margin-bottom:15px;` (mini-cart products). Panels: `#f4f4f4`, padding 20px. Inputs: pill radius 40px, height 45px.
- Reusable utility classes: `.d-flex .align-center .justify-between .justify-center .text-center .list-reset .no-dec .trans .sr-only`, `.container .container--md .container--sm`.
- Reuse theme classes on our markup where possible: `btn btn--primary`, `btn--tert`, `heading--four`, `eyebrow eyebrow--sm`.

## PDP structure (`sections/pdp.liquid` + `templates/product.liquid`)
- ATC button: `button[sm-rc-add-to-cart].btn.btn--primary.btn--atc` inside `.pdp__grey > .pdp__actions--flex`; stock row `.stock-msg` follows inside `.pdp__grey`.
- **Trust badge injection point: inside `.pdp__grey`, immediately after `.stock-msg`** (grey `#f4f4f4` panel).
- Below hero: `<section class="pdp__tabs">` (tabs incl. a "science" tab with `.persona-science-target`), then `pdp-related`, videos, opinions, reviews.
- **Clinical results injection point: after `{% section 'pdp' %}` / before `.pdp__tabs`**, or inside the science tab.
- The `pdp` section schema does NOT accept `@app` blocks — PDP widgets are auto-injected by our app embed JS at the selectors above (with graceful no-op if selectors are missing).

## Reviews / other apps
- Active review platform: **Stamped.io** (`.stamped-product-reviews-badge`, `#stamped-main-widget`; metafields `product.metafields.stamped.reviews_count/reviews_average`). No Trustpilot today — our Trustpilot widget is config-driven (rating/count/URL entered in dashboard).
- Also installed: Fast Bundle, Klaviyo, Triple Whale, Littledata, Growave (loyalty page), Shopify Forms.

## Checkout
- No `checkout.liquid`. Shopify Plus (B2B market + checkout branding present). Checkout customization = Checkout UI Extensions only.
- Checkout branding: sidebar `#f4f4f4`, white inputs — extensions use native checkout tokens, so they inherit this automatically.

## Localization
- 17 locale files: `ar da de el en(.default) es fi fr hu it ja nl no pl pt-PT ro sv`. Everything user-facing goes through `{{ 'key' | t }}`.
- Markets: `ireland`, `b2b-market` (+ default). Multi-currency (€/$) — never parse money strings; compute from cents.
- Free shipping threshold: theme setting `free_ship` = **150** (currency units); mirrored on `section.mini-cart[data-freeship]` in cents. Our config metafield is the primary source; fall back to `data-freeship`.
- `ar` is RTL — widget CSS must use logical properties (`margin-inline-start`, etc.) or `[dir="rtl"]` overrides.
