/**
 * Cellexia AOV & LTV Booster — cart drawer + cart page widgets.
 *
 * Injected as a sibling between .mini-cart__list and .mini-cart__footer so it
 * survives the theme's refreshMiniCart() (which only rebuilds .mini-cart__list).
 * ES2019, IIFE, no globals except window.CellexiaBooster. Never breaks the theme:
 * every selector is feature-tested and every network call is wrapped.
 *
 * Market awareness: Liquid (cart-booster.liquid) precomputes the per-market
 * effective visibility of each cart widget into cfg.effective — this script
 * only reads those booleans (fail closed: missing => false) and never applies
 * scope logic itself. Every beacon carries cfg.market. The once-per-session
 * "session" beacon does NOT live here: it is an inline script in
 * cart-booster.liquid so it fires whenever the config metafield exists,
 * independent of the cartUpsell master flag that gates this file. Single
 * exception: when a stale preview token is authoritatively rejected,
 * fireMissedSessionBeacon() fires the session event the inline beacon
 * skipped (its suppression keys on the cx_preview_ok flag).
 *
 * v6.1 Amazon-pattern cart features (conventions only, never the brand):
 * az_cart_free_line renders the green declarative threshold sentence at
 * the very TOP of the booster root (same threshold/cart-total machinery
 * as the shipbar; while it renders, the shipbar keeps its bar but drops
 * its text line) and az_cta_count decorates the THEME's checkout buttons
 * with a CLDR-plural-correct "Proceed to checkout (N items)" label —
 * original label stored once (never double-decorated) and restored
 * verbatim whenever the feature stops being effective or its strings are
 * unusable. Both key off the same featureOn()/effective helpers, so
 * verified preview sessions see the replacement while live visitors see
 * the standard widgets.
 */
(function () {
  'use strict';

  if (window.CellexiaBooster && window.CellexiaBooster.__cartInit) return;

  // ---------------------------------------------------------------- helpers

  function routeRoot() {
    try {
      if (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) {
        return window.Shopify.routes.root;
      }
    } catch (e) { /* noop */ }
    return '/';
  }

  function readConfig() {
    var el = document.getElementById('cx-cart-config');
    if (!el) return null;
    try {
      var parsed = JSON.parse(el.textContent || '{}');
      if (!parsed || typeof parsed !== 'object') return null;
      parsed.settings = parsed.settings || {};
      parsed.strings = parsed.strings || {};
      parsed.overrides = parsed.overrides || {};
      parsed.products = parsed.products || {};
      return parsed;
    } catch (e) {
      return null;
    }
  }

  var cfg = readConfig();
  if (!cfg) return;

  var SETTINGS = cfg.settings;
  var STRINGS = cfg.strings;

  // Per-market effective visibility, precomputed by Liquid — keys: volume,
  // shipbar, subscription, trustRow. Anything missing or non-true renders
  // nothing (fail closed). No scope logic lives in this file.
  var EFFECTIVE = cfg.effective && typeof cfg.effective === 'object' ? cfg.effective : {};

  // ---------------------------------------------------------- preview (v4)
  //
  // Real-preview mode is entered ONLY behind the triple gate: the browser
  // holds sessionStorage.cx_preview_token AND the (tokenless) Liquid config
  // says preview is armed AND the app proxy verified the token server-side.
  // PREVIEW stays null on every other path, so real visitors run exactly
  // the same code as before — draft templates stay inert, beacons unchanged.
  var PREVIEW = null; // { flags, live, market } once server-verified

  // FINDING 11: when the preview-config verdict is INDETERMINATE (network
  // failure, non-200 status, unparseable body) we fail SAFE — keep the
  // token for a later retry and render live-normal, but ship NO beacons:
  // this browser might still be the merchant's preview session, so its
  // events must never pollute the experiment data. Only an authoritative
  // 200 {valid:false} clears the stored token instead (FINDING 10).
  var BEACONS_OFF = false;

  // cfg.effective widget key -> canonical FeatureKey used by the server.
  var CART_FEATURE_KEYS = {
    volume: 'cart_volume_upsell',
    shipbar: 'free_shipping_bar',
    subscription: 'cart_subscription_upsell',
    crossSell: 'cart_cross_sell',
    trustRow: 'cart_trust_row',
    dispatch: 'dispatch_countdown',
    delivery: 'delivery_estimate',
    azCartFreeLine: 'az_cart_free_line',
    azCtaCount: 'az_cta_count'
  };

  function featureOn(key) {
    if (PREVIEW) {
      // Server-computed live-in-simulated-market ∪ draft flags — exactly
      // what going live would look like. No scope logic in JS.
      var fk = CART_FEATURE_KEYS[key] || key;
      return PREVIEW.live[fk] === true || PREVIEW.flags[fk] === true;
    }
    return EFFECTIVE[key] === true;
  }

  // Current market handle for beacon attribution ('' when unknown).
  var MARKET = typeof cfg.market === 'string' ? cfg.market : '';

  // Shopify's Liquid `t` filter HTML-escapes translated strings (every key
  // not ending in _html), so the config JSON strings map arrives with
  // entities like &amp; / &#39; baked in. Everything this runtime renders
  // flows through textContent/createTextNode — NEVER innerHTML — so the
  // entities must be decoded once, at the consumption point. The detached
  // <textarea> is an RCDATA element: parsing its content decodes character
  // references but can never create elements or execute scripts. Decoded
  // strings must only ever reach textContent afterwards, never innerHTML.
  var decodeArea = null;
  function decodeEntities(str) {
    if (typeof str !== 'string' || str.indexOf('&') === -1) return str;
    try {
      if (!decodeArea) decodeArea = document.createElement('textarea');
      decodeArea.innerHTML = str;
      return decodeArea.value;
    } catch (e) {
      return str;
    }
  }

  function t(key, params) {
    // Decode the base string BEFORE sentinel/param substitution: the
    // @@TOKENS@@ sentinels are plain ASCII (untouched by the decode) and
    // JS-supplied param values are never entity-encoded, so they must not
    // be run through the decoder.
    var str = typeof STRINGS[key] === 'string' ? decodeEntities(STRINGS[key]) : key;
    if (params) {
      Object.keys(params).forEach(function (p) {
        var value = String(params[p]);
        // Liquid exports placeholder-bearing strings with sentinel params
        // (e.g. t: count: '@@COUNT@@') so Shopify can't strip the
        // placeholders; substitute both the sentinel token and the legacy
        // {{ name }} pattern.
        str = str.split('@@' + p.toUpperCase() + '@@').join(value);
        str = str.replace(new RegExp('\\{\\{\\s*' + p + '\\s*\\}\\}', 'g'), value);
      });
    }
    return str;
  }

  function activeCurrency() {
    try {
      if (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) {
        return window.Shopify.currency.active;
      }
    } catch (e) { /* noop */ }
    return cfg.currency || 'EUR';
  }

  function money(cents) {
    var units = (Number(cents) || 0) / 100;
    try {
      if (window.formatter && typeof window.formatter.format === 'function') {
        return window.formatter.format(units);
      }
    } catch (e) { /* fall through */ }
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: activeCurrency() }).format(units);
    } catch (e) {
      return units.toFixed(2);
    }
  }

  function isB2B() {
    return window.isB2BCustomer === true || cfg.b2b === true;
  }

  function track(feature, type, extra) {
    if (PREVIEW || BEACONS_OFF) return; // preview/indeterminate-verdict mode: suppress every beacon — no data pollution
    try {
      var payload = { feature: feature, type: type, currency: activeCurrency() };
      if (MARKET) payload.market = MARKET;
      if (extra) {
        Object.keys(extra).forEach(function (k) {
          if (extra[k] !== undefined && extra[k] !== null) payload[k] = extra[k];
        });
      }
      var body = JSON.stringify(payload);
      var url = routeRoot() + 'apps/cellexia/track';
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      } else if (window.fetch) {
        window.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true
        }).catch(function () { /* fire and forget */ });
      }
    } catch (e) { /* never block UI */ }
  }

  function fetchJSON(url, options) {
    return window.fetch(url, options).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (text) {
          var err = new Error('HTTP ' + res.status);
          err.body = text;
          throw err;
        });
      }
      return res.json();
    });
  }

  function cartRequest(path, data) {
    return fetchJSON(routeRoot() + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(data)
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // ----------------------------------------------------------------- state

  var state = {
    cart: null,
    products: cfg.products || {},
    busy: false,
    notice: null,
    noticeTimer: null,
    openImpressions: {},
    pageImpressions: {},
    drawerRoot: null,
    pageRoot: null,
    wasOpen: false,
    refreshTimer: null,
    // Latest cart from a quiet refresh whose lines the theme's
    // .mini-cart__list does not reflect yet; consumed on next drawer open.
    themeStale: null,
    // Variant id of the cross-sell item currently being added (its button
    // shows the "adding" label while state.busy).
    crossSellAdding: null,
    // Pending re-queued decoration pass (a decorate request arrived while
    // state.busy — never swallow it, retry until busy clears).
    decorateTimer: null
  };

  function shopRate() {
    // Shopify.currency.rate converts shop-currency amounts into the buyer's
    // presentment currency. Guarded: anything missing/invalid means rate 1.
    var rate = 1;
    try {
      var r = Number(window.Shopify && window.Shopify.currency && window.Shopify.currency.rate);
      if (r > 0) rate = r;
    } catch (e) { /* noop */ }
    return rate;
  }

  function thresholdCents() {
    // SPEC v4.5 — per-market currency-aware threshold. Liquid emits
    // cfg.threshold = { cents, currency }: the freeShipping.byMarket entry
    // for the current market when one exists (typically already in the
    // market's own currency), else the global shop-currency fallback.
    var th = cfg.threshold;
    if (th && typeof th === 'object') {
      var cents = Number(th.cents);
      var currency = typeof th.currency === 'string' ? th.currency : '';
      if (cents > 0) {
        if (currency && currency === activeCurrency()) {
          // Threshold already in the cart's presentment currency — compare
          // directly, NO rate conversion.
          return Math.round(cents);
        }
        // currency === cfg.shopCurrency: a shop-currency threshold, so the
        // guarded Shopify.currency.rate conversion applies (the pre-v4.5
        // behavior). Any OTHER currency: that same shop→presentment rate is
        // the only conversion available client-side, so it doubles as the
        // best-effort path.
        return Math.round(cents * shopRate());
      }
    }
    // Legacy fallbacks — all SHOP-currency semantics: the pre-v4.5 config
    // field (stale cached markup), the theme's data-freeship attribute,
    // then the 15000 last resort.
    var legacy = Number(cfg.thresholdCents);
    if (!(legacy > 0)) {
      var mini = document.querySelector('section.mini-cart[data-freeship], .mini-cart[data-freeship]');
      if (mini) {
        var attr = Number(mini.getAttribute('data-freeship'));
        if (attr > 0) legacy = attr;
      }
    }
    if (!(legacy > 0)) legacy = 15000;
    return Math.round(legacy * shopRate());
  }

  // -------------------------------------------------------------- cart data

  function fetchCart() {
    return fetchJSON(routeRoot() + 'cart.js', { headers: { Accept: 'application/json' } });
  }

  function normalizeProductsPayload(data) {
    if (!data || typeof data !== 'object') return null;
    var map = data.products && typeof data.products === 'object' ? data.products : data;
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    var valid = {};
    var found = false;
    Object.keys(map).forEach(function (key) {
      var entry = map[key];
      if (entry && typeof entry === 'object' && Array.isArray(entry.variants)) {
        valid[String(key)] = entry;
        found = true;
      }
    });
    return found ? valid : null;
  }

  function ensureProductData(cart) {
    var missing = false;
    if (cart && Array.isArray(cart.items)) {
      for (var i = 0; i < cart.items.length; i++) {
        if (!state.products[String(cart.items[i].product_id)]) {
          missing = true;
          break;
        }
      }
    }
    if (!missing) return Promise.resolve();
    return fetchJSON(routeRoot() + 'apps/cellexia/cart-data', { headers: { Accept: 'application/json' } })
      .then(function (data) {
        var normalized = normalizeProductsPayload(data);
        if (normalized) {
          Object.keys(normalized).forEach(function (key) {
            state.products[key] = normalized[key];
          });
        }
      })
      .catch(function () { /* keep whatever data we have */ });
  }

  function refresh() {
    return fetchCart()
      .then(function (cart) {
        state.cart = cart;
        return ensureProductData(cart);
      })
      .then(renderAll)
      .catch(function () { /* silent — never break the theme */ });
  }

  function scheduleRefresh() {
    if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(function () {
      state.refreshTimer = null;
      refresh();
    }, 120);
  }

  // ------------------------------------------------------------ volume math

  function productFor(item) {
    return state.products[String(item.product_id)] || null;
  }

  function variantByPosition(product, position) {
    if (!product || !Array.isArray(product.variants)) return null;
    for (var i = 0; i < product.variants.length; i++) {
      if (Number(product.variants[i].position) === position) return product.variants[i];
    }
    return null;
  }

  function currentVariant(product, variantId) {
    if (!product || !Array.isArray(product.variants)) return null;
    for (var i = 0; i < product.variants.length; i++) {
      if (String(product.variants[i].id) === String(variantId)) return product.variants[i];
    }
    return null;
  }

  function volumeOffers() {
    var offers = Array.isArray(SETTINGS.volumeOffers) ? SETTINGS.volumeOffers : [];
    return offers
      .filter(function (o) { return o && Number(o.quantity) > 1; })
      .sort(function (a, b) { return Number(a.quantity) - Number(b.quantity); });
  }

  function savingsPercent(product, offer, tierVariant) {
    var tier1 = variantByPosition(product, 1);
    var qty = Number(offer.quantity);
    if (tier1 && Number(tier1.price) > 0 && tierVariant && Number(tierVariant.price) > 0) {
      var full = qty * Number(tier1.price);
      if (full > Number(tierVariant.price)) {
        return Math.round(((full - Number(tierVariant.price)) / full) * 100);
      }
    }
    if (tierVariant && Number(tierVariant.compare_at_price) > Number(tierVariant.price)) {
      var cap = Number(tierVariant.compare_at_price);
      return Math.round(((cap - Number(tierVariant.price)) / cap) * 100);
    }
    return Number(offer.discountPct) || 0;
  }

  function variantAllocatesPlan(variant, planId) {
    var allocations = variant && Array.isArray(variant.planAllocations) ? variant.planAllocations : [];
    for (var i = 0; i < allocations.length; i++) {
      var alloc = allocations[i];
      if (alloc && alloc.planId != null && String(alloc.planId) === String(planId)) return true;
    }
    return false;
  }

  function upgradeCandidates(item) {
    if (!featureOn('volume')) return [];
    if (Number(item.quantity) !== 1) return [];
    var product = productFor(item);
    if (!product) return [];
    var current = currentVariant(product, item.variant_id);
    if (!current) return [];
    var currentPos = Number(current.position) || 0;
    // v5.1 LIVE BUG FIX — Joy allocates selling plans PER VARIANT (only the
    // 1-unit variants on this store carry allocations): swapping a
    // subscribed line onto a tier variant that lacks the line's plan makes
    // /cart/add.js 422 ("Cannot apply selling plan to variant"). A tier is
    // a candidate for a subscribed line ONLY when the target variant
    // allocates the line's CURRENT plan — an upgrade must never silently
    // drop a subscription.
    var linePlanId = itemHasPlan(item) ? item.selling_plan_allocation.selling_plan.id : null;
    var out = [];
    volumeOffers().forEach(function (offer) {
      var qty = Number(offer.quantity);
      if (qty <= currentPos) return;
      var tierVariant = variantByPosition(product, qty);
      if (!tierVariant || tierVariant.available === false) return;
      if (linePlanId != null && !variantAllocatesPlan(tierVariant, linePlanId)) return;
      out.push({
        offer: offer,
        variant: tierVariant,
        quantity: qty,
        percent: savingsPercent(product, offer, tierVariant),
        perUnitCents: Math.round(Number(tierVariant.price) / qty)
      });
    });
    return out;
  }

  // ----------------------------------------------------------- subscriptions

  // v4.7 LIVE BUG FIX — Joy Subscription attaches selling plans PER VARIANT:
  // on this store the volume-tier variants (2-Jar/3-Jar) carry NO plan
  // allocations, and /cart/change.js returns 422 ("Cannot apply selling plan
  // to variant") whenever a plan is applied to a variant lacking that
  // allocation. Empirically proven on the live store: allocated plan on an
  // allocated variant = 200; selling_plan: null (remove) = 200; unallocated
  // variant or unallocated plan = 422. Eligibility therefore keys on the
  // line's OWN variant's planAllocations ([{planId, price}], emitted by both
  // the Liquid products map and the proxy cart-data endpoint); the product-
  // level sellingPlanGroups only supply names + discount metadata for the
  // keyword match and the savings display.

  function planMetaById(product) {
    var meta = {};
    var groups = product && Array.isArray(product.sellingPlanGroups) ? product.sellingPlanGroups : [];
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g] || {};
      var plans = Array.isArray(group.plans) ? group.plans : [];
      for (var p = 0; p < plans.length; p++) {
        var plan = plans[p];
        if (plan && plan.id != null) {
          meta[String(plan.id)] = { plan: plan, groupName: String(group.name || '') };
        }
      }
    }
    return meta;
  }

  function findPlanForItem(item) {
    var product = productFor(item);
    if (!product) return null;
    var variant = currentVariant(product, item.variant_id);
    var allocations = variant && Array.isArray(variant.planAllocations) ? variant.planAllocations : [];
    if (!allocations.length) return null;
    var meta = planMetaById(product);
    var keyword = String(SETTINGS.sellingPlanKeyword || '').toLowerCase();
    var fallback = null;
    for (var i = 0; i < allocations.length; i++) {
      var alloc = allocations[i];
      if (!alloc || alloc.planId == null) continue;
      var m = meta[String(alloc.planId)] || null;
      var candidate = {
        id: alloc.planId,
        name: m ? String(m.plan.name || '') : '',
        valueType: m ? m.plan.valueType : null,
        value: m ? m.plan.value : 0,
        // Per-variant subscription price in cents (powers the savings
        // display when present); null when the allocation carries none.
        allocPrice: alloc.price != null && isFinite(Number(alloc.price)) ? Number(alloc.price) : null
      };
      if (!fallback) fallback = candidate;
      if (!keyword || !m) continue;
      var groupName = m.groupName.toLowerCase();
      var planName = String(m.plan.name || '').toLowerCase();
      if (groupName.indexOf(keyword) !== -1 || planName.indexOf(keyword) !== -1) {
        return candidate;
      }
    }
    return fallback;
  }

  function planPercent(plan) {
    if (plan && plan.valueType === 'percentage' && Number(plan.value) > 0) {
      return Number(plan.value);
    }
    return Number(SETTINGS.subscriptionDiscountPct) || 5;
  }

  function linePlanPercent(item, plan) {
    // The variant's own allocation price is the authoritative subscription
    // price — when present and actually lower than the one-time price, the
    // real per-line saving beats any product-level plan metadata.
    if (plan && plan.allocPrice != null && plan.allocPrice > 0) {
      var product = productFor(item);
      var variant = product ? currentVariant(product, item.variant_id) : null;
      var base = variant ? Number(variant.price) : 0;
      if (base > 0 && plan.allocPrice < base) {
        var pct = Math.round(((base - plan.allocPrice) / base) * 100);
        if (pct > 0) return pct;
      }
    }
    return planPercent(plan);
  }

  function itemHasPlan(item) {
    return !!(item && item.selling_plan_allocation && item.selling_plan_allocation.selling_plan &&
      item.selling_plan_allocation.selling_plan.id);
  }

  // ------------------------------------------------------------ mutations

  function setNotice(type, text) {
    state.notice = { type: type, text: text };
    if (state.noticeTimer) window.clearTimeout(state.noticeTimer);
    state.noticeTimer = window.setTimeout(function () {
      state.notice = null;
      state.noticeTimer = null;
      renderAll();
    }, 4000);
    renderAll();
  }

  function themeRefresh(cart) {
    // Any full theme refresh supersedes a pending stale-cart catch-up.
    state.themeStale = null;
    try {
      if (typeof window.refreshMiniCart === 'function') {
        window.refreshMiniCart(cart);
        // refreshMiniCart rebuilds .mini-cart__list SYNCHRONOUSLY — the
        // fresh rows carry no remove-subscription buttons, so decorate
        // right here (the list observer runs another pass on its own tick
        // as a safety net; the pass is idempotent).
        decorateSubscriptionRows();
        return;
      }
    } catch (e) { /* fall through to our own refresh */ }
    // Minimal fallback: keep the drawer open and update what we safely can.
    try {
      var count = cart && typeof cart.item_count === 'number' ? cart.item_count : null;
      if (count !== null) {
        var bubbles = document.querySelectorAll('.cart-count, [data-cart-count]');
        for (var i = 0; i < bubbles.length; i++) bubbles[i].textContent = String(count);
      }
      var subtotalEls = document.querySelectorAll('.mini-cart__footer [data-cart-subtotal], .mini-cart__footer .subtotal, .mini-cart__footer .mini-cart__subtotal');
      if (cart && subtotalEls.length) {
        for (var j = 0; j < subtotalEls.length; j++) subtotalEls[j].textContent = money(cart.items_subtotal_price);
      }
    } catch (e) { /* noop */ }
  }

  function quietRefresh(cart) {
    // Update only the cart-count badge, the theme's subtotal text and our
    // own widgets — never call the theme's refreshMiniCart(), which ends in
    // showMini() and would re-open a drawer the buyer has closed. The
    // theme's .mini-cart__list still shows pre-mutation lines, so remember
    // the cart and let the drawer-open observer catch the theme up.
    try {
      if (cart && typeof cart.item_count === 'number') {
        var badges = document.querySelectorAll('.icon--cart .cart-count span');
        for (var i = 0; i < badges.length; i++) badges[i].textContent = String(cart.item_count);
      }
      if (cart) {
        // v6.1: the az_cta_count decoration wraps the drawer checkout
        // button's label in .cx-azcta-label/.cx-azcta-original spans —
        // exclude them here so a quiet refresh can never overwrite the
        // decorated label (or flatten the stored original) with money
        // text. The theme's own .checkout-subtotal span INSIDE the
        // stored original still matches and stays current for restore.
        var subtotals = document.querySelectorAll('.mini-cart__footer .sub-total .total, .mini-cart__actions .btn span:not(.cx-azcta-label):not(.cx-azcta-original)');
        for (var j = 0; j < subtotals.length; j++) subtotals[j].textContent = money(cart.items_subtotal_price);
        state.themeStale = cart;
      }
    } catch (e) { /* noop */ }
    renderAll();
  }

  function safeThemeRefresh(cart, wasDrawerOpen) {
    // v4.7: a THEME render throw after a SUCCESSFUL cart mutation must never
    // surface the error notice. Every path through the theme refresh is
    // caught here; on throw we fall back to quietRefresh semantics
    // (badge/subtotal/own widgets only — quietRefresh's DOM work is itself
    // internally guarded).
    try {
      if (wasDrawerOpen && drawerIsOpen()) {
        themeRefresh(cart);
      } else {
        // Buyer closed the drawer mid-request — refresh quietly so the
        // theme's refreshMiniCart()/showMini() doesn't force it back open.
        quietRefresh(cart);
      }
    } catch (e) {
      try { quietRefresh(cart); } catch (e2) { /* noop */ }
    }
  }

  function isCartPageContext(node) {
    return !!(state.pageRoot && node && state.pageRoot.contains(node));
  }

  function performUpgrade(item, candidate, sourceNode) {
    if (state.busy) return;
    // Capture context before renderAll() clears the widget roots and
    // detaches sourceNode.
    var onCartPage = isCartPageContext(sourceNode);
    var wasDrawerOpen = drawerIsOpen();
    state.busy = true;
    renderAll();
    var oldLineCents = Number(item.final_line_price != null ? item.final_line_price : item.line_price) || 0;
    var sellingPlanId = itemHasPlan(item) ? item.selling_plan_allocation.selling_plan.id : undefined;
    var addPayload = { id: candidate.variant.id, quantity: 1 };
    if (sellingPlanId) addPayload.selling_plan = sellingPlanId;
    if (item.properties && typeof item.properties === 'object' && Object.keys(item.properties).length) {
      addPayload.properties = item.properties;
    }
    // v5.1: set when the upgrade add failed AND the restore add failed too
    // — the original line is then REALLY gone from the cart, so the error
    // path must resync the THEME's own display as well, never leave a
    // phantom line / phantom-empty drawer behind.
    var restoreFailed = false;
    cartRequest('cart/change.js', { id: item.key, quantity: 0 })
      .then(function () {
        return cartRequest('cart/add.js', addPayload).catch(function (err) {
          // Restore the original line so the buyer never silently loses items.
          var restore = { id: item.variant_id, quantity: item.quantity };
          if (sellingPlanId) restore.selling_plan = sellingPlanId;
          if (addPayload.properties) restore.properties = addPayload.properties;
          return cartRequest('cart/add.js', restore).then(
            function () { throw err; },
            function () { restoreFailed = true; throw err; }
          );
        });
      })
      .then(function () { return fetchCart(); })
      .then(function (cart) {
        state.cart = cart;
        state.busy = false;
        var delta = (Number(candidate.variant.price) - oldLineCents) / 100;
        track('cart_upsell', 'upgrade', {
          quantity: candidate.quantity,
          revenue: Math.round(delta * 100) / 100,
          meta: { from_variant: item.variant_id, to_variant: candidate.variant.id }
        });
        if (onCartPage) {
          window.location.reload();
          return;
        }
        safeThemeRefresh(cart, wasDrawerOpen);
        decorateSubscriptionRows();
        return ensureProductData(cart).then(function () {
          setNotice('success', t('volume.upgraded'));
        });
      })
      .catch(function () {
        state.busy = false;
        refresh().then(function () {
          if (restoreFailed) {
            // v5.1: the cart truly changed (line removed, nothing restored)
            // — refresh() refetched the real cart above; now sync the
            // theme's display too (reload on the cart page, mirroring the
            // success path) so no phantom line lingers.
            if (onCartPage) {
              window.location.reload();
              return;
            }
            safeThemeRefresh(state.cart, wasDrawerOpen);
            decorateSubscriptionRows();
          }
          setNotice('error', t('volume.error'));
        });
      });
  }

  function performSubscribeAll(lines, sourceNode) {
    if (state.busy || !lines || !lines.length) return;
    // Capture context before renderAll() clears the widget roots and
    // detaches sourceNode.
    var onCartPage = isCartPageContext(sourceNode);
    var wasDrawerOpen = drawerIsOpen();
    state.busy = true;
    renderAll();
    var okCount = 0;
    var failCount = 0;
    // SEQUENTIAL promise chain — one /cart/change.js per eligible line, each
    // with that line's OWN allocated plan id. Sequencing is load-bearing:
    // changing a line replaces only that line's key (never reused), so the
    // other lines' captured keys stay valid for the rest of the chain.
    var chain = Promise.resolve();
    lines.forEach(function (line) {
      chain = chain.then(function () {
        return cartRequest('cart/change.js', { id: line.item.key, selling_plan: line.plan.id })
          .then(function () { okCount++; }, function () { failCount++; });
      });
    });
    chain
      .then(function () { return fetchCart().catch(function () { return null; }); })
      .then(function (cart) {
        state.busy = false;
        if (cart && cart.items) state.cart = cart;
        if (okCount > 0) {
          track('subscription_upsell', 'subscribe', { quantity: okCount });
        }
        if (onCartPage) {
          window.location.reload();
          return;
        }
        safeThemeRefresh(cart && cart.items ? cart : state.cart, wasDrawerOpen);
        decorateSubscriptionRows();
        if (okCount > 0 && failCount === 0) {
          setNotice('success', t('subscription.switched'));
        } else {
          setNotice('error', t('subscription.error'));
        }
      })
      .catch(function () {
        // Defensive only: per-line failures are swallowed inside the chain,
        // so this fires solely on unexpected throws — never leave busy stuck.
        state.busy = false;
        refresh().then(function () {
          setNotice('error', t('subscription.error'));
        });
      });
  }

  function performUnsubscribe(lineKey, sourceNode) {
    if (state.busy) return;
    // The remove control lives inside the THEME's own row (not our widget
    // roots), so cart-page context is detected against the cart table —
    // isCartPageContext() only covers our injected pageRoot.
    var onCartPage = false;
    try {
      var table = document.querySelector('.cart__table');
      onCartPage = !!(table && sourceNode && table.contains(sourceNode));
    } catch (e) { onCartPage = false; }
    var wasDrawerOpen = drawerIsOpen();
    state.busy = true;
    renderAll();
    cartRequest('cart/change.js', { id: lineKey, selling_plan: null })
      .then(function (cart) {
        state.busy = false;
        if (cart && cart.items) state.cart = cart;
        if (onCartPage) {
          window.location.reload();
          return;
        }
        safeThemeRefresh(cart && cart.items ? cart : state.cart, wasDrawerOpen);
        decorateSubscriptionRows();
        setNotice('success', t('subscription.removed'));
      })
      .catch(function () {
        state.busy = false;
        refresh().then(function () {
          setNotice('error', t('subscription.error'));
        });
      });
  }

  function performCrossSellAdd(variantId, priceCents, sourceNode) {
    // Cart cross-sell add (v4.8): one-click /cart/add.js with the
    // "_cellexia_upsell": "cart" attribution property — the orders webhook
    // already counts it. Follows the performUpgrade flow: busy-guard,
    // context captured BEFORE renderAll detaches sourceNode, theme refresh
    // through safeThemeRefresh, cart-page reload.
    if (state.busy) return;
    var onCartPage = isCartPageContext(sourceNode);
    var wasDrawerOpen = drawerIsOpen();
    state.busy = true;
    state.crossSellAdding = String(variantId);
    renderAll();
    cartRequest('cart/add.js', { id: Number(variantId), quantity: 1, properties: { _cellexia_upsell: 'cart' } })
      .then(function () { return fetchCart(); })
      .then(function (cart) {
        state.cart = cart;
        state.busy = false;
        state.crossSellAdding = null;
        track('cart_cross_sell', 'add_to_cart', {
          revenue: Math.round(Number(priceCents) || 0) / 100,
          quantity: 1
        });
        if (onCartPage) {
          window.location.reload();
          return;
        }
        safeThemeRefresh(cart, wasDrawerOpen);
        decorateSubscriptionRows();
        return ensureProductData(cart).then(function () {
          setNotice('success', t('crosssell.added'));
        });
      })
      .catch(function () {
        state.busy = false;
        state.crossSellAdding = null;
        refresh().then(function () {
          setNotice('error', t('volume.error'));
        });
      });
  }

  // ------------------------------------------------------------- rendering

  function renderNotice(container) {
    if (!state.notice) return;
    var note = el('div', 'cx-notice cx-notice--' + state.notice.type, state.notice.text);
    note.setAttribute('role', 'status');
    container.appendChild(note);
  }

  // ------------------------------------ Amazon-pattern cart line (v6.1)
  //
  // az_cart_free_line — the green declarative threshold sentence at the
  // very TOP of the booster root ("Your order qualifies for FREE
  // shipping." / "Add X more to qualify for FREE shipping."), computed
  // from the SAME thresholdCents() + items_subtotal_price machinery the
  // shipbar uses so the two can never disagree. The node is JS-built
  // (v6.7 — the old cx-tpl-azfree-cart body rebuilt 1:1) with BOTH
  // states hidden and this renderer reveals exactly one. FAIL CLOSED on
  // anything unusable: feature off, no cfg.af island flag (the old
  // template-emission gate), no threshold, missing or "Translation
  // missing:" strings -> render nothing AND leave the shipbar's own text
  // line alone (renderInto only suppresses that line when this sentence
  // actually rendered).

  function azStr(key) {
    // Amazon-group strings arrive from Liquid even before the locale
    // files carry them (the amazon.* keys are owned by the PDP/locales
    // work): Shopify then bakes "Translation missing: <locale>.<key>"
    // markers into the config JSON. Treat those exactly like a missing
    // string so no broken text can ever reach a buyer.
    var s = STRINGS[key];
    if (typeof s !== 'string' || !s) return null;
    if (s.indexOf('Translation missing') === 0) return null;
    return s;
  }

  function azfreeBuildNode() {
    // v6.7 Liquid diet: 1:1 rebuild of the old cx-tpl-azfree-cart body —
    // both state lines ship hidden exactly like the template did and the
    // caller reveals exactly one. The qualified sentence lands via
    // textContent from the same translated string the template baked.
    var root = cxEl('div', 'cx-azfree', ['data-cx-feature', 'az_cart_free_line']);
    cxSp(root);
    var p1 = cxEl('p', 'cx-azfree__line cx-azfree__line--qualified', ['data-cx-azfree-qualified', '', 'hidden', '']);
    p1.appendChild(cxIcon('check', 14));
    var s1 = cxEl('span', 'cx-azfree__text');
    s1.textContent = t('amazon.qualifies');
    p1.appendChild(s1);
    root.appendChild(p1);
    cxSp(root);
    var p2 = cxEl('p', 'cx-azfree__line cx-azfree__line--unqualified', ['data-cx-azfree-unqualified', '', 'hidden', '']);
    p2.appendChild(cxEl('span', 'cx-azfree__text', ['data-cx-azfree-msg', '']));
    root.appendChild(p2);
    cxSp(root);
    return root;
  }

  function renderAzFreeLine(container) {
    if (!featureOn('azCartFreeLine') || !state.cart) return null;
    var goal = thresholdCents();
    if (!(goal > 0)) return null;
    // v6.7 Liquid diet: the gated cfg.af island flag carries the old
    // template-emission gate; the node itself is JS-built.
    if (cfg.af !== 1) return null;
    var subtotal = Number(state.cart.items_subtotal_price) || 0;
    var qualified = subtotal >= goal;
    // String availability decides renderability BEFORE any DOM work.
    if (qualified && !azStr('amazon.qualifies')) return null;
    if (!qualified && !azStr('amazon.add_more')) return null;
    try {
      var node = azfreeBuildNode();
      var line = node.querySelector(qualified ? '[data-cx-azfree-qualified]' : '[data-cx-azfree-unqualified]');
      if (!line) return null;
      if (!qualified) {
        var slot = line.querySelector('[data-cx-azfree-msg]') || line;
        // Same sentinel split as the shipbar: text + <strong> amount +
        // text, everything through createTextNode/textContent.
        var template = t('amazon.add_more');
        var parts = template.split(/@@AMOUNT@@|\{\{\s*amount\s*\}\}/);
        slot.appendChild(document.createTextNode(parts[0] || ''));
        slot.appendChild(el('strong', 'cx-azfree__amount', money(goal - subtotal)));
        if (parts.length > 1) slot.appendChild(document.createTextNode(parts.slice(1).join('')));
      }
      line.removeAttribute('hidden');
      node.className += qualified ? ' cx-azfree--qualified' : ' cx-azfree--unqualified';
      container.appendChild(node);
      return 'az_cart_free_line';
    } catch (e) {
      return null;
    }
  }

  function renderShipbar(container, suppressMsg) {
    // v6.1: suppressMsg is true when the az_cart_free_line sentence
    // actually rendered above — the Amazon-pattern replacement semantics
    // swap the shipbar's TEXT line for the green sentence while keeping
    // the progress bar itself. Keyed on the RENDERED sentence (not just
    // the flag) so a fail-closed sentence can never leave the shipbar
    // mute with nothing in its place.
    if (!featureOn('shipbar') || !state.cart) return null;
    var goal = thresholdCents();
    if (!(goal > 0)) return null;
    var subtotal = Number(state.cart.items_subtotal_price) || 0;
    var wrap = el('div', 'cx-shipbar');
    wrap.setAttribute('data-cx-feature', 'free_shipping_bar');
    if (subtotal >= goal) wrap.className += ' cx-shipbar--unlocked';
    if (!suppressMsg) {
      var msg = el('p', 'cx-shipbar__msg');
      if (subtotal >= goal) {
        msg.textContent = t('shipbar.unlocked');
      } else {
        var template = t('shipbar.away_html');
        // Liquid renders the translation with amount: '@@AMOUNT@@' so the token
        // is guaranteed to survive; legacy {{ amount }} kept as a fallback.
        var parts = template.split(/@@AMOUNT@@|\{\{\s*amount\s*\}\}/);
        msg.appendChild(document.createTextNode(parts[0] || ''));
        var strong = el('strong', 'cx-shipbar__amount', money(goal - subtotal));
        msg.appendChild(strong);
        if (parts.length > 1) msg.appendChild(document.createTextNode(parts.slice(1).join('')));
      }
      wrap.appendChild(msg);
    }
    var track_ = el('div', 'cx-shipbar__track');
    track_.setAttribute('aria-hidden', 'true');
    var fill = el('div', 'cx-shipbar__fill');
    var pct = goal > 0 ? Math.min(100, Math.round((subtotal / goal) * 100)) : 0;
    fill.style.width = pct + '%';
    track_.appendChild(fill);
    wrap.appendChild(track_);
    container.appendChild(wrap);
    return 'free_shipping_bar';
  }

  // ------------------------------------------------- offer groups (v4.5)
  //
  // With several qualifying cart lines the drawer used to stack every offer
  // with no product attribution. Now: every volume-offer group and every
  // subscription-switch row gets a product label whenever the cart holds
  // more than one distinct product (hidden with only one), eligible lines
  // are ranked by final_line_price DESC, at most settings.maxOfferGroups
  // per offer type render in full, and the rest collapse behind ONE shared
  // "+ N more offers" toggle — a single collapsed container holds both
  // overflow types (volume groups first, then subscription rows). Collapse
  // state intentionally resets on re-render. Impression beacons unchanged:
  // each feature fires only when at least one of its groups is visible
  // (the cap is >= 1, so an eligible type always has a visible group).

  function distinctProductCount() {
    if (!state.cart || !Array.isArray(state.cart.items)) return 0;
    var seen = {};
    var count = 0;
    state.cart.items.forEach(function (item) {
      var pid = String(item.product_id);
      if (!seen[pid]) {
        seen[pid] = true;
        count++;
      }
    });
    return count;
  }

  function maxOfferGroups() {
    var n = Math.floor(Number(SETTINGS.maxOfferGroups));
    return n >= 1 ? n : 2;
  }

  function lineValue(item) {
    var v = Number(item.final_line_price != null ? item.final_line_price : item.line_price);
    return isFinite(v) ? v : 0;
  }

  function byLineValueDesc(a, b) {
    return lineValue(b.item) - lineValue(a.item);
  }

  function productLabel(item) {
    // item.product_title comes from the cart.js AJAX JSON (raw text, never
    // HTML-escaped) and is rendered via textContent — no decode, no markup.
    return el('p', 'cx-offer__product', item.product_title || '');
  }

  function buildVolumeGroup(item, candidates, showLabel) {
    var box = el('div', 'cx-volume');
    box.setAttribute('data-cx-feature', 'cart_upsell');
    if (showLabel) box.appendChild(productLabel(item));
    var title = cfg.overrides.volumeTitle || t('volume.title');
    box.appendChild(el('p', 'cx-volume__title heading--five', title));
    var product = productFor(item);
    var current = product ? currentVariant(product, item.variant_id) : null;
    if (current && current.option1) {
      box.appendChild(el('p', 'cx-volume__current', t('volume.current_pack') + ' — ' + current.option1));
    }
    var tiles = el('div', 'cx-volume__tiles');
    candidates.forEach(function (candidate) {
      var isHighlight = Number(SETTINGS.highlightQuantity) === candidate.quantity;
      var tile = el('button', 'cx-volume__tile' + (isHighlight ? ' cx-volume__tile--highlight' : ''));
      tile.type = 'button';
      tile.disabled = state.busy;
      if (isHighlight) tile.appendChild(el('span', 'cx-volume__chip', t('volume.best_value')));
      tile.appendChild(el('span', 'cx-volume__qty', t('volume.upgrade_to', { count: candidate.quantity })));
      tile.appendChild(el('span', 'cx-volume__unit', t('volume.per_unit', { price: money(candidate.perUnitCents) })));
      if (candidate.percent > 0) {
        tile.appendChild(el('span', 'cx-volume__save', t('volume.save_pct', { percent: candidate.percent })));
      }
      tile.addEventListener('click', function () {
        track('cart_upsell', 'click', { quantity: candidate.quantity });
        performUpgrade(item, candidate, tile);
      });
      tiles.appendChild(tile);
    });
    box.appendChild(tiles);
    return box;
  }

  function buildSubscriptionCard(lines, totalLines) {
    // v4.7 UX redesign: ONE consolidated card for every eligible line —
    // benefits percent is the MAX per-line plan discount, the single CTA
    // switches every eligible line via the sequential chain.
    var maxPct = 0;
    lines.forEach(function (line) {
      var pct = linePlanPercent(line.item, line.plan);
      if (pct > maxPct) maxPct = pct;
    });
    var box = el('div', 'cx-subswitch');
    box.setAttribute('data-cx-feature', 'subscription_upsell');
    var title = cfg.overrides.subscriptionTitle || t('subscription.switch_title');
    var head = el('div', 'cx-subswitch__head d-flex align-center');
    head.appendChild(el('p', 'cx-subswitch__title heading--five', title));
    box.appendChild(head);
    box.appendChild(el('p', 'cx-subswitch__benefits', t('subscription.benefits', { percent: maxPct })));
    if (lines.length < totalLines) {
      box.appendChild(el('p', 'cx-subswitch__partial', t('subscription.partial', { eligible: lines.length, total: totalLines })));
    }
    var ctaKey = lines.length >= 2 ? 'subscription.switch_all_cta' : 'subscription.switch_cta';
    var cta = el('button', 'cx-subswitch__cta btn btn--secondary', t(ctaKey, { percent: maxPct }));
    cta.type = 'button';
    cta.disabled = state.busy;
    cta.addEventListener('click', function () {
      track('subscription_upsell', 'click', { quantity: lines.length });
      performSubscribeAll(lines, cta);
    });
    box.appendChild(cta);
    return box;
  }

  function renderOffers(container, context) {
    var features = [];
    if (!state.cart || !Array.isArray(state.cart.items)) return features;
    var showLabels = distinctProductCount() > 1;
    var cap = maxOfferGroups();
    var overflow = [];

    if (featureOn('volume')) {
      var volumeLines = [];
      state.cart.items.forEach(function (item) {
        var candidates = upgradeCandidates(item);
        if (candidates.length) volumeLines.push({ item: item, candidates: candidates });
      });
      volumeLines.sort(byLineValueDesc);
      volumeLines.forEach(function (line, index) {
        var box = buildVolumeGroup(line.item, line.candidates, showLabels);
        if (index < cap) container.appendChild(box);
        else overflow.push(box);
      });
      if (volumeLines.length) features.push('cart_upsell');
    }

    if (featureOn('subscription') && !isB2B()) {
      var subLines = [];
      state.cart.items.forEach(function (item) {
        if (itemHasPlan(item)) return;
        var plan = findPlanForItem(item);
        if (plan) subLines.push({ item: item, plan: plan });
      });
      // ONE consolidated card (v4.7) — rendered outside the cap/overflow
      // system; highest-value line first so the sequential subscribe chain
      // mutates the most valuable line first.
      subLines.sort(byLineValueDesc);
      if (subLines.length) {
        container.appendChild(buildSubscriptionCard(subLines, state.cart.items.length));
      }
      if (subLines.length) features.push('subscription_upsell');
    }

    if (overflow.length) {
      var panelId = 'cx-offers-overflow-' + context;
      var toggle = el('button', 'cx-offers-more');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', panelId);
      toggle.appendChild(el('span', 'cx-offers-more__label', '+ ' + overflow.length + ' more offers'));
      var chevron = el('span', 'cx-offers-more__chevron');
      chevron.setAttribute('aria-hidden', 'true');
      toggle.appendChild(chevron);
      var panel = el('div', 'cx-offers-overflow');
      panel.id = panelId;
      panel.hidden = true;
      overflow.forEach(function (node) { panel.appendChild(node); });
      toggle.addEventListener('click', function () {
        var expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        panel.hidden = expanded;
      });
      container.appendChild(toggle);
      container.appendChild(panel);
    }

    return features;
  }

  // -------------------------------------------------- cart cross-sell (v4.8)
  //
  // Two modes (settings.crossSellMode, v4.9 — "auto" is the contract
  // default). MANUAL: Liquid resolves the hand-picked items (max 8, live
  // presentment prices via all_products) into the lean gated cfg.csx
  // island and the rows are JS-built (v6.7 Liquid diet — the old
  // cx-tpl-crosssell template markup rebuilt 1:1; island presence carries
  // the old template-emission gate). AUTO: rows are JS-built from Shopify
  // product recommendations (see the auto section below). BOTH modes
  // share pruneCrossSellRows: drop every item whose PRODUCT is already in
  // the cart (product-level exclusion — variant-level is implied), cap
  // the visible rows at settings.crossSellMaxItems and render nothing
  // when zero remain. CRO placement: below the subscription card, above
  // the trust row (proof last). B2B customers DO see it — no
  // subscription involved.

  function crossSellMaxItems() {
    var n = Math.floor(Number(SETTINGS.crossSellMaxItems));
    return n >= 1 ? n : 2;
  }

  function crossSellMode() {
    // v4.9: "auto" is the contract default — anything but an explicit
    // "manual" runs the recommendations pipeline.
    return SETTINGS.crossSellMode === 'manual' ? 'manual' : 'auto';
  }

  function wireCrossSellRow(row) {
    var btn = row.querySelector('.cx-crosssell__add');
    if (!btn) return;
    var vid = row.getAttribute('data-variant-id');
    var priceCents = Number(row.getAttribute('data-price-cents')) || 0;
    btn.disabled = state.busy;
    if (state.busy && state.crossSellAdding === String(vid)) {
      btn.textContent = t('crosssell.adding');
    }
    btn.addEventListener('click', function () {
      performCrossSellAdd(vid, priceCents, btn);
    });
  }

  function crossSellExclusions() {
    var inCartProducts = {};
    var inCartVariants = {};
    if (state.cart && Array.isArray(state.cart.items)) {
      state.cart.items.forEach(function (item) {
        inCartProducts[String(item.product_id)] = true;
        inCartVariants[String(item.variant_id)] = true;
      });
    }
    return { products: inCartProducts, variants: inCartVariants };
  }

  function pruneCrossSellRows(items) {
    // Shared by BOTH modes: removes rows whose product/variant is already
    // in the cart, enforces the display cap, wires the add buttons on the
    // survivors. Returns the visible count.
    var ex = crossSellExclusions();
    var inCartProducts = ex.products;
    var inCartVariants = ex.variants;
    var cap = crossSellMaxItems();
    var visible = 0;
    for (var i = 0; i < items.length; i++) {
      var row = items[i];
      var pid = row.getAttribute('data-product-id');
      var vid = row.getAttribute('data-variant-id');
      var hide = !vid ||
        inCartProducts[String(pid)] === true ||
        inCartVariants[String(vid)] === true ||
        visible >= cap;
      if (hide) {
        if (row.parentNode) row.parentNode.removeChild(row);
        continue;
      }
      visible++;
      wireCrossSellRow(row);
    }
    return visible;
  }

  function crosssellTitleText() {
    // The template's override != blank gate: any non-whitespace override
    // (raw via | json — the old | escape landed back raw in the DOM)
    // wins over the translated default.
    var o = cfg.overrides.crossSellTitle;
    if (typeof o === 'string' && /\S/.test(o)) return o;
    return t('crosssell.title');
  }

  function crosssellMoneyText(row, key, centsKey) {
    // Liquid | money output emitted verbatim in the island. Shops can
    // configure money_format with HTML — the old template rendered that
    // markup as nodes, textContent would show it literally, so any
    // markup falls back to the runtime money() formatter (same
    // window.formatter the theme uses). Plain formats (the norm) land
    // byte-identical, entities decoded exactly like the parser did.
    var s = row && typeof row[key] === 'string' ? row[key] : '';
    if (s && s.indexOf('<') === -1) return decodeEntities(s);
    return money(Number(row && row[centsKey]) || 0);
  }

  function crosssellBuildRow(row) {
    // 1:1 rebuild of the old cx-tpl-crosssell <li> body.
    var li = cxEl('li', 'cx-crosssell__item', ['data-variant-id', String(row.v), 'data-product-id', String(row.p), 'data-price-cents', String(row.c)]);
    if (typeof row.i === 'string' && row.i && typeof row.i2 === 'string' && row.i2) {
      li.appendChild(cxEl('img', 'cx-crosssell__img', ['src', row.i, 'srcset', row.i2 + ' 2x', 'width', '56', 'height', '56', 'alt', cxRawStr(row, 't'), 'loading', 'lazy']));
    }
    var info = cxEl('span', 'cx-crosssell__info');
    cxSp(info);
    var name = cxEl('span', 'cx-crosssell__name');
    name.textContent = cxStr(row, 'n');
    info.appendChild(name);
    cxSp(info);
    var prices = cxEl('span', 'cx-crosssell__prices');
    cxSp(prices);
    var price = cxEl('span', 'cx-crosssell__price');
    price.textContent = crosssellMoneyText(row, 'pf', 'c');
    prices.appendChild(price);
    if (typeof row.cf === 'string' && row.cf) {
      var cmp = cxEl('s', 'cx-crosssell__compare');
      cmp.textContent = crosssellMoneyText(row, 'cf', 'cc');
      prices.appendChild(cmp);
    }
    info.appendChild(prices);
    cxSp(info);
    li.appendChild(info);
    cxSp(li);
    var btn = cxEl('button', null, ['type', 'button', 'class', 'cx-crosssell__add']);
    btn.textContent = t('crosssell.add');
    li.appendChild(btn);
    cxSp(li);
    return li;
  }

  function crosssellBuildBox(rows, items) {
    // 1:1 rebuild of the old template shell; built <li>s are also pushed
    // onto items so the shared prune/wire path sees the same list the
    // cloned fragment used to provide.
    var box = cxEl('div', 'cx-crosssell', ['data-cx-feature', 'cart_cross_sell']);
    cxSp(box);
    var title = cxEl('p', 'cx-crosssell__title heading--five');
    title.textContent = crosssellTitleText();
    box.appendChild(title);
    cxSp(box);
    var list = cxEl('ul', 'cx-crosssell__list list-reset');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || typeof row !== 'object' || row.v == null) continue;
      var node = crosssellBuildRow(row);
      list.appendChild(node);
      if (items) items.push(node);
    }
    box.appendChild(list);
    cxSp(box);
    return box;
  }

  function renderCrossSellManual(container) {
    // v6.7 Liquid diet: rows arrive in the lean gated cfg.csx island
    // (island presence = the old cx_eff/cx_draft template-emission gate)
    // and the DOM is JS-built. Prune/wire/cap semantics unchanged.
    var rows = Array.isArray(cfg.csx) ? cfg.csx : null;
    if (!rows || !rows.length) return null;
    try {
      var items = [];
      var box = crosssellBuildBox(rows, items);
      if (!items.length) return null;
      var visible = pruneCrossSellRows(items);
      if (!visible) return null;
      container.appendChild(box);
      return 'cart_cross_sell';
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------- auto cross-sell (v4.9)
  //
  // mode "auto" (the contract default): no hand-picking — recommend
  // complements of what is already in the cart. Pipeline (every failure
  // silent — render nothing, never break the theme):
  //   1. anchor = the highest-value cart line's product; the second
  //      distinct product is kept as a fallback source; the protection
  //      product never anchors;
  //   2. theme endpoint /recommendations/products.json?product_id=…&limit=8
  //      with intent=complementary, then intent=related on zero results —
  //      complementary/related per source, anchor before fallback, first
  //      non-empty answer wins;
  //   3. recommended handles minus in-cart products minus the protection
  //      product, deduped, up to 6 kept;
  //   4. presentment-correct price/availability enrichment via OUR app
  //      proxy (apps/cellexia/cart-data?handles=… -> productsByHandle,
  //      the exact products-map variant shape); the first available
  //      variant wins. Image + title come from the recommendations
  //      payload — the proxy emits neither;
  //   5. rows are el()-built with the same cx-crosssell classes and go
  //      through the shared prune/wire path, so cap, in-cart hiding, busy
  //      handling, add flow, notices and beacons are identical to manual.
  // The result is cached per cart token + line signature: reopening the
  // drawer never refetches, and any cart mutation changes the signature
  // (invalidating the cache). Fetches only start when the drawer is open
  // or on the cart page, debounced 200 ms, at most one scheduled/in
  // flight per signature. Stale rows keep rendering (re-pruned against
  // the live cart) while the refetch for a new signature is in flight.

  var PROTECTION_HANDLE = 'cellexia-order-protection';

  var autoCrossSell = {
    signature: null, // signature the cached rows were fetched for
    rows: null,      // cached row descriptors ([] = fetched, nothing usable)
    pending: null,   // signature currently scheduled or in flight
    timer: null
  };

  function cartSignature() {
    if (!state.cart || !Array.isArray(state.cart.items)) return '';
    var parts = [];
    state.cart.items.forEach(function (item) {
      parts.push(String(item.variant_id) + 'x' + String(item.quantity));
    });
    parts.sort();
    return String(state.cart.token || '') + '|' + parts.join(',');
  }

  function autoCrossSellAnchors() {
    var lines = state.cart && Array.isArray(state.cart.items) ? state.cart.items.slice() : [];
    lines.sort(function (a, b) { return lineValue(b) - lineValue(a); });
    var anchors = [];
    var seen = {};
    for (var i = 0; i < lines.length && anchors.length < 2; i++) {
      var item = lines[i];
      if (!item || item.product_id == null) continue;
      var pid = String(item.product_id);
      if (seen[pid]) continue;
      seen[pid] = true;
      if (String(item.handle || '') === PROTECTION_HANDLE) continue;
      anchors.push(item);
    }
    return anchors;
  }

  function fetchRecommendations(productId, intent) {
    var url = routeRoot() + 'recommendations/products.json?product_id=' +
      encodeURIComponent(String(productId)) + '&limit=8&intent=' + intent;
    return fetchJSON(url, { headers: { Accept: 'application/json' } })
      .then(function (data) {
        return data && Array.isArray(data.products) ? data.products : [];
      })
      .catch(function () { return []; }); // 404/failure tolerated silently
  }

  function fetchRecommendedProducts(anchors) {
    var attempts = [];
    anchors.forEach(function (item) {
      attempts.push({ id: item.product_id, intent: 'complementary' });
      attempts.push({ id: item.product_id, intent: 'related' });
    });
    var chain = Promise.resolve([]);
    attempts.forEach(function (attempt) {
      chain = chain.then(function (products) {
        if (products.length) return products;
        return fetchRecommendations(attempt.id, attempt.intent);
      });
    });
    return chain;
  }

  function recommendationImage(product) {
    // featured_image is a URL string on the recommendations payload, but
    // tolerate object shapes ({src}/{url}) and fall back to images[0].
    var img = product.featured_image;
    if (img && typeof img === 'object') img = img.src || img.url || null;
    if (!img && Array.isArray(product.images) && product.images.length) {
      img = product.images[0];
      if (img && typeof img === 'object') img = img.src || img.url || null;
    }
    return typeof img === 'string' && img ? img : null;
  }

  function sizedImageUrl(url, width) {
    // Shopify CDN images accept a width query param; anything unexpected
    // is returned untouched (the CSS still sizes the box).
    try {
      if (!/^(https?:)?\/\//.test(url)) return url;
      return url + (url.indexOf('?') === -1 ? '?' : '&') + 'width=' + width;
    } catch (e) { return url; }
  }

  function firstAvailableVariant(entry) {
    if (!entry || !Array.isArray(entry.variants)) return null;
    for (var i = 0; i < entry.variants.length; i++) {
      var v = entry.variants[i];
      if (v && v.id != null && v.available !== false) return v;
    }
    return null;
  }

  function fetchHandleData(handles) {
    return fetchJSON(routeRoot() + 'apps/cellexia/cart-data?handles=' + encodeURIComponent(handles.join(',')), { headers: { Accept: 'application/json' } })
      .then(function (data) {
        // The proxy always includes the cart products map too — merge it
        // opportunistically (same shape ensureProductData consumes).
        var normalized = normalizeProductsPayload(data);
        if (normalized) {
          Object.keys(normalized).forEach(function (key) {
            state.products[key] = normalized[key];
          });
        }
        return data && data.productsByHandle && typeof data.productsByHandle === 'object' ? data.productsByHandle : {};
      });
  }

  function buildAutoCrossSellRows() {
    var anchors = autoCrossSellAnchors();
    if (!anchors.length) return Promise.resolve([]);
    var ex = crossSellExclusions();
    return fetchRecommendedProducts(anchors).then(function (products) {
      var picks = [];
      var seen = {};
      for (var i = 0; i < products.length && picks.length < 6; i++) {
        var p = products[i];
        if (!p || typeof p.handle !== 'string' || !p.handle) continue;
        if (p.handle === PROTECTION_HANDLE) continue;
        if (p.id != null && ex.products[String(p.id)] === true) continue;
        if (seen[p.handle]) continue;
        seen[p.handle] = true;
        picks.push({
          handle: p.handle,
          productId: p.id,
          title: typeof p.title === 'string' ? p.title : '',
          image: recommendationImage(p)
        });
      }
      if (!picks.length) return [];
      return fetchHandleData(picks.map(function (pick) { return pick.handle; })).then(function (byHandle) {
        var rows = [];
        picks.forEach(function (pick) {
          var variant = firstAvailableVariant(byHandle[pick.handle]);
          if (!variant) return; // unknown handle / every variant sold out
          rows.push({
            handle: pick.handle,
            productId: pick.productId,
            title: pick.title,
            image: pick.image,
            variantId: variant.id,
            priceCents: Number(variant.price) || 0,
            compareAtCents: variant.compare_at_price != null ? Number(variant.compare_at_price) || 0 : 0
          });
        });
        return rows;
      });
    });
  }

  function fetchAutoCrossSell(sig) {
    buildAutoCrossSellRows()
      .then(function (rows) {
        if (autoCrossSell.pending === sig) autoCrossSell.pending = null;
        if (cartSignature() === sig) { // commit only for the cart we fetched for
          autoCrossSell.signature = sig;
          autoCrossSell.rows = rows;
          renderAll();
        }
      })
      .catch(function () {
        if (autoCrossSell.pending === sig) autoCrossSell.pending = null;
        if (cartSignature() === sig) {
          // Silent failure: cache the empty result so nothing renders and
          // nothing re-hammers the endpoints until the cart changes.
          autoCrossSell.signature = sig;
          autoCrossSell.rows = [];
        }
      });
  }

  function scheduleAutoCrossSell(sig) {
    if (autoCrossSell.pending === sig) return; // scheduled or in flight
    autoCrossSell.pending = sig;
    if (autoCrossSell.timer) window.clearTimeout(autoCrossSell.timer);
    autoCrossSell.timer = window.setTimeout(function () {
      autoCrossSell.timer = null;
      fetchAutoCrossSell(sig);
    }, 200);
  }

  function buildAutoCrossSellRow(row) {
    var li = el('li', 'cx-crosssell__item');
    li.setAttribute('data-variant-id', String(row.variantId));
    if (row.productId != null) li.setAttribute('data-product-id', String(row.productId));
    li.setAttribute('data-price-cents', String(row.priceCents));
    if (row.image) {
      var img = el('img', 'cx-crosssell__img');
      img.src = sizedImageUrl(row.image, 112);
      img.width = 56;
      img.height = 56;
      img.alt = row.title || '';
      img.loading = 'lazy';
      li.appendChild(img);
    }
    var info = el('span', 'cx-crosssell__info');
    info.appendChild(el('span', 'cx-crosssell__name', row.title || ''));
    var prices = el('span', 'cx-crosssell__prices');
    prices.appendChild(el('span', 'cx-crosssell__price', money(row.priceCents)));
    if (Number(row.compareAtCents) > Number(row.priceCents)) {
      prices.appendChild(el('s', 'cx-crosssell__compare', money(row.compareAtCents)));
    }
    info.appendChild(prices);
    li.appendChild(info);
    var btn = el('button', 'cx-crosssell__add', t('crosssell.add'));
    btn.type = 'button';
    li.appendChild(btn);
    return li;
  }

  function renderCrossSellAuto(container) {
    var sig = cartSignature();
    if (!sig) return null;
    if (autoCrossSell.signature !== sig && (drawerIsOpen() || isCartPageContext(container))) {
      scheduleAutoCrossSell(sig);
    }
    var cached = Array.isArray(autoCrossSell.rows) ? autoCrossSell.rows : null;
    if (!cached || !cached.length) return null;
    try {
      var box = el('div', 'cx-crosssell');
      box.setAttribute('data-cx-feature', 'cart_cross_sell');
      box.appendChild(el('p', 'cx-crosssell__title heading--five', cfg.overrides.crossSellTitle || t('crosssell.title')));
      var list = el('ul', 'cx-crosssell__list list-reset');
      var items = [];
      for (var i = 0; i < cached.length; i++) {
        var node = buildAutoCrossSellRow(cached[i]);
        list.appendChild(node);
        items.push(node);
      }
      var visible = pruneCrossSellRows(items);
      if (!visible) return null;
      box.appendChild(list);
      container.appendChild(box);
      return 'cart_cross_sell';
    } catch (e) {
      return null;
    }
  }

  function renderCrossSell(container) {
    if (!featureOn('crossSell') || !state.cart) return null;
    if (crossSellMode() === 'auto') return renderCrossSellAuto(container);
    return renderCrossSellManual(container);
  }

  // v6.7 Liquid diet: the cart trust row (cx-tpl-trust-row) is JS-built
  // now — a 1:1 rebuild of the old template body. The two badge cells use
  // the strings that already shipped in cfg.strings (secure_checkout +
  // days-baked money_back); the Trustpilot cell reads the lean gated
  // cfg.tpr island member (aria/label precomposed server-side with the
  // exact template/snippet filters, rating clamped for the stars). The
  // stars themselves are a JS port of snippets/cx-trustpilot-stars.liquid.

  function cxStarsSvgs(rating, uid, size) {
    // Same clamp/percent/gradient-id math as the snippet; pct is
    // Math.round-derived and uid/size are code literals, so no dynamic
    // value ever reaches the innerHTML this string is written to.
    var r = Number(rating);
    if (!isFinite(r)) r = 0;
    if (r > 5) r = 5;
    if (r < 0) r = 0;
    var s = '';
    for (var i = 1; i <= 5; i++) {
      var part = r - (i - 1);
      if (part > 1) part = 1;
      if (part < 0) part = 0;
      var pct = Math.round(part * 100);
      var gid = 'cxtp-' + uid + '-' + i + '-' + pct;
      s += '<svg class="cx-stars__star" width="' + size + '" height="' + size + '" viewBox="0 0 20 20" aria-hidden="true" focusable="false"> <defs> <linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="0"> <stop offset="' + pct + '%" stop-color="#00b67a"/> <stop offset="' + pct + '%" stop-color="#d8d8d8"/> </linearGradient> </defs> <path fill="url(#' + gid + ')" d="M10 1.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L1.6 7.7l5.8-.8z"/> </svg>';
    }
    return s;
  }

  function cxStarsNode(rating, uid, size, aria) {
    var span = cxEl('span', 'cx-stars', ['role', 'img', 'aria-label', aria]);
    span.innerHTML = cxStarsSvgs(rating, uid, size);
    return span;
  }

  function trustRowBuildNode() {
    var root = cxEl('div', 'cx-trust-row', ['data-cx-feature', 'trust_badges']);
    cxSp(root);
    var item1 = cxEl('span', 'cx-trust-row__item d-flex align-center');
    item1.appendChild(cxIcon('lock', 16));
    var s1 = document.createElement('span');
    s1.textContent = t('badges.secure_checkout');
    item1.appendChild(s1);
    cxSp(item1);
    root.appendChild(item1);
    cxSp(root);
    var item2 = cxEl('span', 'cx-trust-row__item d-flex align-center');
    item2.appendChild(cxIcon('shield-check', 16));
    var s2 = document.createElement('span');
    s2.textContent = t('badges.money_back');
    item2.appendChild(s2);
    cxSp(item2);
    root.appendChild(item2);
    var tp = cfg.tpr;
    if (SETTINGS.trustpilotEnabled === true && tp && typeof tp === 'object') {
      // the old cx_tp_on branch: settings.trustpilotEnabled IS cx_tp_on
      var item3;
      if (tp.link === false) {
        item3 = cxEl('span', 'cx-trust-row__item d-flex align-center no-dec');
      } else {
        item3 = cxEl('a', 'cx-trust-row__item cx-trust-row__item--link d-flex align-center no-dec', ['href', cxRawStr(tp, 'url'), 'target', '_blank', 'rel', 'noopener nofollow']);
      }
      item3.appendChild(cxStarsNode(tp.r, 'cart-trust', 14, cxStr(tp, 'aria')));
      var s3 = document.createElement('span');
      s3.textContent = cxStr(tp, 'label');
      item3.appendChild(s3);
      cxSp(item3);
      root.appendChild(item3);
    }
    return root;
  }

  function renderTrustRow(container) {
    if (!featureOn('trustRow')) return null;
    // v6.7 Liquid diet: the gated cfg.tpr island member carries the old
    // template-emission gate; the row itself is JS-built.
    if (!cfg.tpr || typeof cfg.tpr !== 'object') return null;
    try {
      container.appendChild(trustRowBuildNode());
      return 'trust_badges';
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------- dispatch countdown (v5.0)
  //
  // "Order within Xh Ym for same-day dispatch" — REAL urgency only.
  // Liquid resolves the buyer country's schedule (cutoff "HH:MM" + IANA
  // WAREHOUSE timezone + ISO working days 1-7) into cfg.dispatch; this
  // engine decides VISIBILITY: shown only when today is a working day in
  // the warehouse timezone AND the cutoff is still ahead today AND no
  // more than showWithinHours remain. The widget is a SINGLE line (v5.4:
  // the buyer-local clock suffix was removed on merchant request) — all
  // math still runs in the warehouse timezone, so it stays correct
  // worldwide with no tz library.
  // Any invalid schedule, missing string or Intl throw (bad timezone)
  // hides the widget — fail closed, never fabricate urgency. ONE module
  // interval (guarded by dispatchTimer) re-evaluates every mounted node
  // each 30s tick — the widget hides itself the moment the cutoff passes
  // or the window is exceeded — and self-clears when none remain, so
  // drawer re-renders can never leak intervals.
  var DISPATCH_ISO = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  var dispatchTimer = null;

  function dispatchSchedule() {
    var d = cfg.dispatch;
    if (!d || typeof d !== 'object') return null;
    if (typeof d.cutoff !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.cutoff)) return null;
    if (typeof d.timezone !== 'string' || !d.timezone) return null;
    if (!Array.isArray(d.days) || d.days.length === 0) return null;
    var within = Math.round(Number(d.showWithinHours));
    if (!(within >= 1 && within <= 24)) return null;
    if (typeof STRINGS['dispatch.within'] !== 'string' ||
        typeof STRINGS['dispatch.within_minutes'] !== 'string') return null;
    var cutoffMinutes = Number(d.cutoff.slice(0, 2)) * 60 + Number(d.cutoff.slice(3, 5));
    var days = d.days;
    // v10 per-state dispatch override (SPEC-v10): deliveryConfig()
    // already resolved the state-adjusted cutoff/dispatch days (with
    // the fail-open discard rules), so a resolved state substitutes
    // them here — the countdown and the promised dates read separate
    // config copies and must never disagree. Timezone always inherits.
    if (cfg.delivery && cfg.delivery.us) {
      var dcUs = deliveryConfig();
      if (dcUs && dcUs.us && dcUs.us.state) {
        cutoffMinutes = dcUs.cutoffMinutes;
        days = dcUs.dispatchDays;
      }
    }
    return {
      cutoffMinutes: cutoffMinutes,
      timezone: d.timezone,
      days: days,
      withinMinutes: within * 60
    };
  }

  function dispatchRemainingMs(schedule) {
    // Milliseconds until today's cutoff in the WAREHOUSE timezone, or null
    // (= hidden) when outside the credibility window. ANY throw -> null.
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: schedule.timezone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).formatToParts(new Date());
      var map = {};
      for (var i = 0; i < parts.length; i++) map[parts[i].type] = parts[i].value;
      var iso = DISPATCH_ISO[map.weekday];
      if (!iso || schedule.days.indexOf(iso) === -1) return null; // not a working day
      var nowMinutes = (Number(map.hour) % 24) * 60 + Number(map.minute);
      if (!(nowMinutes >= 0 && nowMinutes < 1440)) return null;
      if (nowMinutes >= schedule.cutoffMinutes) return null; // cutoff passed
      if (schedule.cutoffMinutes - nowMinutes > schedule.withinMinutes) return null; // too early
      var seconds = Number(map.second);
      if (!(seconds >= 0 && seconds < 60)) seconds = 0;
      return (schedule.cutoffMinutes - nowMinutes) * 60000 - seconds * 1000;
    } catch (e) {
      return null; // invalid/unsupported timezone: hidden, never fake urgency
    }
  }

  function dispatchHiddenReason(schedule) {
    // v5.3 PREVIEW-only diagnostics: WHY dispatchRemainingMs said null,
    // recomputed with the SAME Intl warehouse wall-clock math (including
    // the h24 "24:xx" normalization quirk). Returns 'closed_day' |
    // 'cutoff_passed' | 'too_early', or null when the widget is visible
    // OR the Intl/wall-clock math itself failed — callers treat reason
    // null WITH remaining null as invalid schedule config (fail closed).
    // Only ever called from PREVIEW-gated code, never on visitor paths.
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: schedule.timezone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).formatToParts(new Date());
      var map = {};
      for (var i = 0; i < parts.length; i++) map[parts[i].type] = parts[i].value;
      var iso = DISPATCH_ISO[map.weekday];
      if (!iso || schedule.days.indexOf(iso) === -1) return 'closed_day';
      var nowMinutes = (Number(map.hour) % 24) * 60 + Number(map.minute);
      if (!(nowMinutes >= 0 && nowMinutes < 1440)) return null;
      if (nowMinutes >= schedule.cutoffMinutes) return 'cutoff_passed';
      if (schedule.cutoffMinutes - nowMinutes > schedule.withinMinutes) return 'too_early';
      return null; // visible right now
    } catch (e) {
      return null; // Intl rejected the timezone: same fail-closed verdict
    }
  }

  function dispatchSetText(node, remainingMs) {
    var totalMin = Math.floor(remainingMs / 60000);
    var text;
    if (totalMin >= 60) {
      text = t('dispatch.within', { hours: Math.floor(totalMin / 60), minutes: totalMin % 60 });
    } else {
      // Sub-hour reads more urgent; ceil so "0 minutes" can never render.
      text = t('dispatch.within_minutes', { minutes: Math.max(1, Math.ceil(remainingMs / 60000)) });
    }
    var main = node.querySelector('.cx-dispatch__main');
    if (main) main.textContent = text;
  }

  // ------------------------------------ dispatch preview aids (v5.3)
  //
  // MERCHANT-facing, English-only by design (same precedent as the
  // preview bar strings — never locale files). Everything below is
  // PREVIEW-gated: real visitors can never reach or render any of it,
  // and no beacon ever fires from these paths (track() no-ops in
  // preview). The sample countdown exists ONLY inside a verified
  // preview session and ONLY with the explanatory note attached —
  // real visitors keep the fail-closed v5.0 behavior byte-for-byte.
  var DISPATCH_PREVIEW_INVALID = 'Dispatch countdown can\'t render: the schedule is invalid or its translations are missing — check Features → Dispatch countdown in the app.';

  function dispatchPreviewNoteText(reason) {
    var d = cfg.dispatch && typeof cfg.dispatch === 'object' ? cfg.dispatch : {};
    var cutoff = typeof d.cutoff === 'string' ? d.cutoff : '?';
    var hours = Math.round(Number(d.showWithinHours)) || 0;
    var rule = ' Real visitors see it on dispatch days during the final ' + hours + ' h before the ' + cutoff + ' cutoff.';
    if (reason === 'closed_day') {
      return 'Preview sample — hidden for real visitors right now: today is not a dispatch day in the warehouse timezone.' + rule;
    }
    if (reason === 'cutoff_passed') {
      return 'Preview sample — hidden for real visitors right now: today\'s ' + cutoff + ' cutoff (warehouse time) has passed.' + rule;
    }
    if (reason === 'too_early') {
      return 'Preview sample — hidden for real visitors right now: more than ' + hours + ' h remain before today\'s ' + cutoff + ' cutoff (warehouse time).' + rule;
    }
    return 'Preview: real visitors see this right now.';
  }

  function dispatchPreviewNoteAfter(node, text, warn) {
    // Sibling note right after the widget node with a stable
    // data-cx-note hook, so 30s ticks update the text in place and can
    // never duplicate nodes.
    if (!PREVIEW) return; // preview-only: never touch real-visitor DOM
    try {
      var parent = node.parentNode;
      if (!parent) return;
      var note = node.nextElementSibling;
      if (!note || !note.getAttribute || note.getAttribute('data-cx-note') !== 'dispatch') {
        note = document.createElement('div');
        note.setAttribute('data-cx-note', 'dispatch');
        if (node.nextSibling) parent.insertBefore(note, node.nextSibling);
        else parent.appendChild(note);
      }
      note.className = warn ? 'cx-preview-note cx-preview-note--warn' : 'cx-preview-note';
      note.textContent = text;
    } catch (e) { /* never break the theme */ }
  }

  function dispatchPreviewSync(node, schedule, remaining) {
    // Real state -> real countdown + reassurance note; hidden state ->
    // SAMPLE countdown (half the show window, marked data-cx-sample)
    // + a note naming the REAL reason. Flips both ways on every tick.
    if (!PREVIEW) return; // preview-only: real visitors keep v5.0 behavior
    try {
      if (remaining !== null) {
        node.removeAttribute('data-cx-sample');
        dispatchSetText(node, remaining);
        dispatchPreviewNoteAfter(node, dispatchPreviewNoteText(null), false);
      } else {
        var reason = dispatchHiddenReason(schedule);
        node.setAttribute('data-cx-sample', '1');
        dispatchSetText(node, schedule.withinMinutes * 60000 / 2);
        dispatchPreviewNoteAfter(node, reason ? dispatchPreviewNoteText(reason) : DISPATCH_PREVIEW_INVALID, true);
      }
    } catch (e) { /* never break the theme */ }
  }

  function dispatchTick() {
    // Re-run the WHOLE visibility computation for every mounted node —
    // no cached node or schedule state survives between ticks.
    var nodes = document.querySelectorAll('.cx-dispatch--cart');
    if (!nodes.length) {
      if (dispatchTimer) { window.clearInterval(dispatchTimer); dispatchTimer = null; }
      return;
    }
    var schedule = dispatchSchedule();
    var remaining = schedule ? dispatchRemainingMs(schedule) : null;
    if (PREVIEW) {
      // v5.3: preview never hides dispatch nodes — re-sync real vs
      // sample each tick so the merchant always sees a truthful state
      // (a sample flips to the real countdown the moment the window
      // opens, and back the moment it closes).
      if (schedule) {
        for (var p = 0; p < nodes.length; p++) dispatchPreviewSync(nodes[p], schedule, remaining);
      }
      return;
    }
    for (var i = 0; i < nodes.length; i++) {
      if (remaining === null) {
        try {
          if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
        } catch (e) { /* noop */ }
      } else {
        dispatchSetText(nodes[i], remaining);
      }
    }
    if (remaining === null && dispatchTimer) {
      window.clearInterval(dispatchTimer);
      dispatchTimer = null;
    }
  }

  function dispatchEnsureTimer() {
    if (dispatchTimer) return; // single guarded interval, never stacked
    dispatchTimer = window.setInterval(dispatchTick, 30000);
  }

  function dispatchBuildNode() {
    // v6.7 Liquid diet: the cart dispatch shell (cx-tpl-dispatch-cart) is
    // JS-built now — a 1:1 rebuild of the old template body, the cart
    // sibling of the pdp dispatchBuildNode (same shape, cart surface
    // variant class). The ticking text still lands exclusively via
    // textContent from the frozen dispatch engine.
    var root = cxEl('div', 'cx-dispatch cx-dispatch--cart', ['data-cx-feature', 'dispatch_countdown']);
    cxSp(root);
    root.appendChild(cxEl('span', 'cx-dispatch__dot', ['aria-hidden', 'true']));
    root.appendChild(cxIcon('truck', 16));
    var text = cxEl('span', 'cx-dispatch__text');
    text.appendChild(cxEl('strong', 'cx-dispatch__main'));
    root.appendChild(text);
    cxSp(root);
    return root;
  }

  function renderDispatch(container) {
    if (!featureOn('dispatch')) return null;
    // v6.7 Liquid diet: the gated cfg.dc island flag carries the old
    // template-emission gate; the shell itself is JS-built.
    if (cfg.dc !== 1) return null;
    if (PREVIEW) return renderDispatchPreview(container); // v5.3 merchant preview
    var schedule = dispatchSchedule();
    if (!schedule) return null;
    var remaining = dispatchRemainingMs(schedule);
    if (remaining === null) return null;
    try {
      var node = dispatchBuildNode();
      dispatchSetText(node, remaining);
      container.appendChild(node);
      dispatchEnsureTimer();
      return 'dispatch_countdown';
    } catch (e) {
      return null;
    }
  }

  function renderDispatchPreview(container) {
    // v5.3 PREVIEW-only: the merchant always gets an answer — the real
    // countdown (plus a reassurance note), an explained SAMPLE when the
    // credibility engine hides it for real visitors, or an invalid-
    // config diagnostic. renderDispatch only calls this when PREVIEW is
    // set AND the feature is on (live-in-simulated-market or draft).
    if (!PREVIEW) return null; // hard gate: never render for real visitors
    try {
      var schedule = dispatchSchedule();
      var remaining = schedule ? dispatchRemainingMs(schedule) : null;
      var reason = schedule && remaining === null ? dispatchHiddenReason(schedule) : null;
      if (!schedule || (remaining === null && reason === null)) {
        // Invalid schedule/strings, or Intl rejected the timezone: no
        // widget — a diagnostic note only, never a fake countdown.
        var note = el('div', 'cx-preview-note cx-preview-note--warn', DISPATCH_PREVIEW_INVALID);
        note.setAttribute('data-cx-note', 'dispatch');
        container.appendChild(note);
        return null;
      }
      var node = dispatchBuildNode();
      container.appendChild(node);
      dispatchPreviewSync(node, schedule, remaining);
      dispatchEnsureTimer();
      return 'dispatch_countdown'; // impression dedupe only — track() no-ops in preview
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------- delivery estimate (v6.0)
  //
  // CART twin of the v5.9 PDP delivery estimator + DELIVERY GUARANTEE
  // widget (cellexia-pdp.js, v5.9.1 DST-SAFE). The ENGINE block below —
  // DELIVERY_GLOBAL_EXCLUSIONS through deliveryTexts, including the
  // conservative fixed-date DELIVERY_HOLIDAYS mirror of the canonical
  // app/services/delivery-holidays.server.ts table — is byte-matched to
  // the PDP one the same way DISPATCH_ISO..dispatchSetText is:
  // cart-booster.liquid emits cfg.delivery and cfg.deliveryStrings with
  // the exact same shape the PDP block emits, so the resolver, the
  // Intl-once UTC-midnight calendar math and the holiday table never
  // fork (the validation harness parity-checks the mirrors).
  //
  // FAIL CLOSED on ANY inconsistency: invalid/missing config, hidden
  // country, unresolvable dispatch day, scan caps, missing translation,
  // any Intl/Date throw — hide, NEVER show a delivery date we cannot
  // stand behind.
  var DELIVERY_GLOBAL_EXCLUSIONS = ['12-24', '12-25', '12-31', '01-01'];
  var DELIVERY_HOLIDAYS = {
    US: ['06-19', '07-04', '11-11'],
    CA: ['07-01', '12-26'],
    GB: ['12-26'],
    IE: ['03-17', '12-26'],
    FR: ['05-01', '05-08', '07-14', '08-15', '11-01', '11-11'],
    DE: ['05-01', '10-03', '12-26'],
    AT: ['01-06', '05-01', '08-15', '10-26', '11-01', '12-08', '12-26'],
    CH: ['08-01'],
    IT: ['01-06', '04-25', '05-01', '06-02', '08-15', '11-01', '12-08', '12-26'],
    ES: ['01-06', '05-01', '08-15', '10-12', '11-01', '12-06', '12-08'],
    PT: ['04-25', '05-01', '06-10', '08-15', '10-05', '11-01', '12-01', '12-08'],
    NL: ['04-27', '12-26'],
    BE: ['05-01', '07-21', '08-15', '11-01', '11-11'],
    SE: ['01-06', '05-01', '06-06', '12-26'],
    NO: ['05-01', '05-17', '12-26'],
    DK: ['12-26'],
    FI: ['01-06', '05-01', '12-06', '12-26'],
    PL: ['01-06', '05-01', '05-03', '08-15', '11-01', '11-11', '12-26'],
    GR: ['01-06', '03-25', '05-01', '10-28', '12-26'],
    CZ: ['05-01', '05-08', '07-05', '07-06', '09-28', '10-28', '11-17', '12-26'],
    HU: ['03-15', '05-01', '08-20', '10-23', '11-01', '12-26'],
    RO: ['01-24', '05-01', '06-01', '08-15', '11-30', '12-01'],
    JP: ['02-11', '02-23', '04-29', '05-03', '05-04', '05-05', '08-11', '11-03', '11-23'],
    AU: ['01-26', '04-25', '12-26'],
    NZ: ['02-06', '04-25', '12-26']
  };

  function deliveryT(key, params) {
    // Same sentinel-substitution + decodeEntities convention as dispatchT,
    // over the deliveryStrings map; '' (never the raw key) on a miss so
    // every caller can fail closed.
    var map = cfg && cfg.deliveryStrings && typeof cfg.deliveryStrings === 'object' ? cfg.deliveryStrings : {};
    var str = typeof map[key] === 'string' ? decodeEntities(map[key]) : '';
    if (!str) return '';
    if (params) {
      Object.keys(params).forEach(function (p) {
        var value = String(params[p]);
        str = str.split('@@' + p.toUpperCase() + '@@').join(value);
        str = str.replace(new RegExp('\\{\\{\\s*' + p + '\\s*\\}\\}', 'g'), value);
      });
    }
    return str;
  }

  function deliveryConfig() {
    // Resolve + validate cfg.delivery, fail closed. Liquid pre-picks the
    // buyer country's byCountry row as .override (dynamic record keys are
    // Liquid-only); this resolver applies it so ONE place owns the merge.
    var d = cfg.delivery;
    if (!d || typeof d !== 'object') return null;
    var min = d.minDays;
    var max = d.maxDays;
    var days = d.deliveryDays;
    var hol = d.holidaysEnabled;
    var country = typeof d.country === 'string' ? d.country.toUpperCase() : '';
    var o = d.override;
    if (o && typeof o === 'object') {
      if (o.hidden === true) return null; // country hidden: never render
      if (typeof o.minDays === 'number') min = o.minDays;
      if (typeof o.maxDays === 'number') max = o.maxDays;
      if (Array.isArray(o.deliveryDays)) days = o.deliveryDays;
      if (typeof o.holidaysEnabled === 'boolean') hol = o.holidaysEnabled;
    }
    if (typeof min !== 'number' || min !== Math.floor(min) || !(min >= 0 && min <= 30)) return null;
    if (typeof max !== 'number' || max !== Math.floor(max) || !(max >= 1 && max <= 30)) return null;
    if (max < min) return null;
    if (!Array.isArray(days) || days.length === 0) return null;
    for (var i = 0; i < days.length; i++) {
      if (days[i] !== Math.floor(days[i]) || days[i] < 1 || days[i] > 7) return null;
    }
    if (hol !== true && hol !== false) return null;
    var s = d.schedule;
    if (!s || typeof s !== 'object') return null;
    if (typeof s.cutoff !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.cutoff)) return null;
    if (typeof s.timezone !== 'string' || !s.timezone) return null;
    if (!Array.isArray(s.days) || s.days.length === 0) return null;
    var map = cfg.deliveryStrings;
    if (!map || typeof map !== 'object') return null;
    var req = ['delivery.line', 'delivery.range', 'delivery.range_same', 'delivery.timeline_ship', 'delivery.timeline_delivered', 'delivery.box_title', 'delivery.tooltip'];
    for (var k = 0; k < req.length; k++) {
      if (typeof map[req[k]] !== 'string' || !map[req[k]]) return null;
    }
    var dc = {
      minDays: min,
      maxDays: max,
      deliveryDays: days,
      holidaysEnabled: hol,
      country: country,
      pageLocale: typeof d.pageLocale === 'string' ? d.pageLocale : '',
      cutoffMinutes: Number(s.cutoff.slice(0, 2)) * 60 + Number(s.cutoff.slice(3, 5)),
      timezone: s.timezone,
      dispatchDays: s.days
    };
    // v10 US state layer (SPEC-v10). Doctrine inversion, on purpose: the
    // COUNTRY resolution above fails closed, the STATE layer fails OPEN
    // — a malformed module, unknown state or invalid entry keeps the
    // US-wide promise just resolved; ONLY an explicit hidden:true state
    // override may hide. Dates stay fail-closed: the adopted values
    // re-enter the same engine unchanged.
    var us = d.us;
    if (!us || typeof us !== 'object' || us.enabled !== true) return dc;
    var st = deliveryUsCurrent(us);
    var e = st && us.byState && typeof us.byState === 'object' ? us.byState[st] : null;
    if (!e || typeof e !== 'object') e = null;
    if (e) {
      if (e.hidden === true) return null; // state hidden: deliberate hide
      // CANDIDATE merge — per-field keep-if-valid; an incoherent merged
      // window discards the WHOLE entry (never a half-applied state).
      var cMin = dc.minDays;
      var cMax = dc.maxDays;
      var cDays = dc.deliveryDays;
      var cHol = dc.holidaysEnabled;
      if (typeof e.minDays === 'number' && e.minDays === Math.floor(e.minDays) && e.minDays >= 0 && e.minDays <= 30) cMin = e.minDays;
      if (typeof e.maxDays === 'number' && e.maxDays === Math.floor(e.maxDays) && e.maxDays >= 1 && e.maxDays <= 30) cMax = e.maxDays;
      if (Array.isArray(e.deliveryDays) && e.deliveryDays.length > 0) {
        var dOk = true;
        for (var di = 0; di < e.deliveryDays.length; di++) {
          if (e.deliveryDays[di] !== Math.floor(e.deliveryDays[di]) || e.deliveryDays[di] < 1 || e.deliveryDays[di] > 7) dOk = false;
        }
        if (dOk) cDays = e.deliveryDays;
      }
      if (typeof e.holidaysEnabled === 'boolean') cHol = e.holidaysEnabled;
      if (cMax >= cMin) {
        dc.minDays = cMin;
        dc.maxDays = cMax;
        dc.deliveryDays = cDays;
        dc.holidaysEnabled = cHol;
        if (typeof e.cutoff === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(e.cutoff)) {
          dc.cutoffMinutes = Number(e.cutoff.slice(0, 2)) * 60 + Number(e.cutoff.slice(3, 5));
        }
        if (Array.isArray(e.dispatchDays) && e.dispatchDays.length > 0) {
          var pOk = true;
          for (var pi = 0; pi < e.dispatchDays.length; pi++) {
            if (e.dispatchDays[pi] !== Math.floor(e.dispatchDays[pi]) || e.dispatchDays[pi] < 1 || e.dispatchDays[pi] > 7) pOk = false;
          }
          if (pOk) dc.dispatchDays = e.dispatchDays;
        }
      } else {
        e = null; // incoherent window: whole entry ignored (fail open)
      }
    }
    // Merchant extra days off — module-wide + state, "MM-DD" (every
    // year) or "YYYY-MM-DD" (one-off), invalid entries dropped. The
    // federal dates are NOT materialized here: deliveryQualifies
    // computes them per candidate day via deliveryUsFederal, so this
    // resolver stays clock-free.
    var extra = [];
    var eRe = /^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
    var lists = [us.extraHolidays, e ? e.extraHolidays : null];
    for (var li = 0; li < lists.length; li++) {
      if (!Array.isArray(lists[li])) continue;
      for (var xi = 0; xi < lists[li].length; xi++) {
        if (typeof lists[li][xi] === 'string' && eRe.test(lists[li][xi])) extra.push(lists[li][xi]);
      }
    }
    if (extra.length) dc.extra = extra;
    dc.usFederal = us.federalHolidays !== false && dc.holidaysEnabled === true;
    dc.us = { sel: us.selector === true, state: st || null };
    return dc;
  }

  function deliveryDispatchUt(dc) {
    // Next dispatch DATE as a UTC-midnight calendar stamp: today when now
    // is before the cutoff on a dispatch day in the WAREHOUSE timezone,
    // else the next dispatch day (14-day scan). Same Intl wall-clock
    // machinery and h24 "24:xx" normalization as dispatchRemainingMs.
    try {
      // Intl is consulted ONCE — for today's warehouse calendar date and
      // wall clock; subsequent days are pure calendar stamps (UTC midnight
      // + 24h, ISO weekday via getUTCDay). DST-immune by construction: a
      // fixed +24h probe formatted through a warehouse DST transition can
      // re-land on (25h day) or skip (23h day) a calendar day, which
      // could show a dispatch date after the cutoff had passed.
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: dc.timezone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).formatToParts(new Date());
      var map = {};
      for (var i = 0; i < parts.length; i++) map[parts[i].type] = parts[i].value;
      if (!DISPATCH_ISO[map.weekday]) return null; // malformed weekday parse
      var todayUt = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day));
      if (!isFinite(todayUt)) return null;
      var nowMinutes = (Number(map.hour) % 24) * 60 + Number(map.minute);
      if (!(nowMinutes >= 0 && nowMinutes < 1440)) return null;
      for (var k = 0; k <= 14; k++) {
        var ut = todayUt + k * 86400000;
        var iso = ((new Date(ut).getUTCDay() + 6) % 7) + 1;
        if (dc.dispatchDays.indexOf(iso) === -1) continue; // not a dispatch day
        if (k === 0 && nowMinutes >= dc.cutoffMinutes) continue; // cutoff passed today
        return ut;
      }
      return null; // no dispatch day within 14 days: hidden
    } catch (e) {
      return null; // Intl rejected the timezone: hidden, never fake a date
    }
  }

  function deliveryQualifies(ut, dc) {
    // Pure calendar math on the UTC stamp — no timezone involved.
    var date = new Date(ut);
    var iso = ((date.getUTCDay() + 6) % 7) + 1;
    if (dc.deliveryDays.indexOf(iso) === -1) return false; // no delivery weekday
    var m = date.getUTCMonth() + 1;
    var dd = date.getUTCDate();
    var mmdd = (m < 10 ? '0' + m : '' + m) + '-' + (dd < 10 ? '0' + dd : '' + dd);
    if (DELIVERY_GLOBAL_EXCLUSIONS.indexOf(mmdd) !== -1) return false; // Dec 24/25/31 + Jan 1
    if (dc.holidaysEnabled) {
      var table = DELIVERY_HOLIDAYS[dc.country];
      if (table && table.indexOf(mmdd) !== -1) return false; // public holiday
    }
    // v10 US layer: merchant days off (both date forms) and the six
    // movable federal holidays, computed for the candidate day's own
    // UTC year (6 pure-math rules — cheap over the <= 74-day window).
    if (dc.extra || dc.usFederal === true) {
      var y = date.getUTCFullYear();
      var full = y + '-' + mmdd;
      if (dc.extra && (dc.extra.indexOf(mmdd) !== -1 || dc.extra.indexOf(full) !== -1)) return false; // merchant day off
      if (dc.usFederal === true && deliveryUsFederal(y).indexOf(full) !== -1) return false; // movable federal holiday
    }
    return true;
  }

  function deliveryAdvance(startUt, n, dc) {
    // Advance n qualifying delivery days from the dispatch date (day 0).
    // n === 0: the dispatch day itself when it qualifies, else the next
    // qualifying day. Scan capped at 60 calendar days -> null (hidden).
    var count = 0;
    for (var i = 0; i <= 60; i++) {
      var ut = startUt + i * 86400000;
      if (i === 0 && n > 0) continue; // dispatch day is day zero, not transit
      if (!deliveryQualifies(ut, dc)) continue;
      if (n === 0) return ut;
      count++;
      if (count === n) return ut;
    }
    return null; // 60-day scan cap exceeded: hidden
  }

  function deliveryCompute(dc) {
    var dispatchUt = deliveryDispatchUt(dc);
    if (dispatchUt === null) return null;
    var minUt = deliveryAdvance(dispatchUt, dc.minDays, dc);
    var maxUt = deliveryAdvance(dispatchUt, dc.maxDays, dc);
    if (minUt === null || maxUt === null || maxUt < minUt) return null;
    return { dispatch: dispatchUt, min: minUt, max: maxUt };
  }

  function deliveryFormatDate(ut, locale) {
    // v6.0.1 DATE_STYLE — full native date in the PAGE language, never the
    // browser locale. Base language ja keeps the Japanese e-commerce
    // convention 7月25日(土) (month long + day + weekday short); EVERY
    // other base language (known or unknown) renders weekday long + day +
    // month long. The page locale string is passed to Intl VERBATIM
    // ("pt-PT" stays "pt-PT") so Intl owns each language's native order,
    // punctuation, casing, script and digits (ar keeps its own digits —
    // never forced to Latin). Fallback chain: page-locale long form ->
    // pre-v6.0.1 short browser form (missing pageLocale or Intl rejecting
    // the tag) -> '' ONLY when formatting itself throws (fail closed:
    // hide, never mislabel a date). The UTC calendar stamp is rebuilt as
    // a LOCAL noon Date so formatting can never shift the calendar day,
    // whatever the buyer's UTC offset (unchanged house convention).
    var d = new Date(ut);
    var local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
    var base = typeof locale === 'string' && locale ? locale.split('-')[0].toLowerCase() : '';
    if (base) {
      try {
        var label = local.toLocaleDateString(locale, base === 'ja'
          ? { month: 'long', day: 'numeric', weekday: 'short' }
          : { weekday: 'long', day: 'numeric', month: 'long' });
        // v6.0.2: careful French writes the FIRST of a month as an ordinal
        // ("vendredi 1er mai") — CLDR emits the cardinal "1", so the single
        // digit day token is upgraded for base language fr only.
        if (base === 'fr' && d.getUTCDate() === 1 && typeof label === 'string') {
          label = label.replace(/\b1\b/, '1er');
        }
        if (typeof label === 'string' && label) return label;
      } catch (e) { /* Intl rejected the locale tag: fall through */ }
    }
    try {
      var label2 = local.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      return typeof label2 === 'string' && label2 ? label2 : '';
    } catch (e2) {
      return ''; // formatting itself threw: hidden, never a wrong date
    }
  }

  function deliveryTexts(result, dc) {
    // Every string the four formats can render — null when ANY piece is
    // missing (fail closed; the widget never shows a half-filled promise).
    // The range collapses to range_same when minDate === maxDate. Dates
    // are v6.0.1 full native forms in the PAGE language (dc.pageLocale).
    var shipL = deliveryFormatDate(result.dispatch, dc.pageLocale);
    var minL = deliveryFormatDate(result.min, dc.pageLocale);
    var maxL = deliveryFormatDate(result.max, dc.pageLocale);
    if (!shipL || !minL || !maxL) return null;
    var texts = {
      line: deliveryT('delivery.line', { date: maxL }),
      range: result.min === result.max
        ? deliveryT('delivery.range_same', { date: maxL })
        : deliveryT('delivery.range', { from: minL, to: maxL }),
      ship: deliveryT('delivery.timeline_ship', { date: shipL }),
      delivered: deliveryT('delivery.timeline_delivered', { date: maxL }),
      title: deliveryT('delivery.box_title', { date: maxL }),
      tooltip: deliveryT('delivery.tooltip', { date: maxL })
    };
    if (!texts.line || !texts.range || !texts.ship || !texts.delivered || !texts.title || !texts.tooltip) return null;
    return texts;
  }

  // --------------------------------------------- US state overlay (v10)
  //
  // SPEC-v10 sub-module of the delivery estimate: per-US-state overrides
  // (window / delivery days / holidays / dispatch cutoff), merchant extra
  // days off, the six movable US federal holidays and the Amazon-style
  // "Deliver to" state selector. The state resolves from the visitor's
  // explicit choice (localStorage cx:us_state) else the self-hosted IP
  // hint (sessionStorage cx_geo:1 — our own app proxy, never a third
  // party); precedence is choice > geo > none. The LAYER fails OPEN: any
  // malformed piece degrades to the validated US-wide promise and ONLY
  // an explicit hidden:true state override may hide the widget — while
  // every DATE shown still comes from the fail-closed engine above.
  // Everything from US_STATE_NAMES through deliveryUsGeoKick is
  // byte-twinned between cellexia-pdp.js and cellexia-cart.js (the
  // validation harness compares the copies).
  //
  // State names are ENGLISH proper nouns in the JS asset on purpose (the
  // AZ_SHIPS_FORMS precedent: locale files are byte-capped and US place
  // names stay untranslated by e-commerce convention). No territories.
  var US_STATE_NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

  var deliveryUsGeoState = null; // geo-resolved USPS code, this page only
  var deliveryUsGeoPromise = null; // single-flight: ONE geo fetch per page
  var deliveryUsDocBound = false; // selector close listeners bound once
  var deliveryUsEventToken = {}; // this bundle's identity on cx:us-state (never loops)

  function deliveryUsFederal(year) {
    // The six MOVABLE US federal holidays of a year as "YYYY-MM-DD" (the
    // fixed-date ones already ride DELIVERY_HOLIDAYS.US and the global
    // exclusions). Rules are [month, ISO weekday, ordinal] with ordinal
    // 5 = last — pure UTC calendar math, no Intl, a behavioral mirror of
    // usFederalMovable in app/services/delivery-holidays.server.ts and
    // the checkout engines (the sims compare all four copies).
    var rules = [[1, 1, 3], [2, 1, 3], [5, 1, 5], [9, 1, 1], [10, 1, 2], [11, 4, 4]];
    var out = [];
    for (var i = 0; i < rules.length; i++) {
      var month = rules[i][0];
      var wd = rules[i][1];
      var ord = rules[i][2];
      var day;
      if (ord === 5) {
        var last = new Date(Date.UTC(year, month, 0));
        var lastIso = ((last.getUTCDay() + 6) % 7) + 1;
        day = last.getUTCDate() - ((lastIso - wd + 7) % 7);
      } else {
        var firstIso = ((new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7) + 1;
        day = 1 + ((wd - firstIso + 7) % 7) + (ord - 1) * 7;
      }
      out.push(year + '-' + (month < 10 ? '0' + month : '' + month) + '-' + (day < 10 ? '0' + day : '' + day));
    }
    return out;
  }

  function deliveryUsChoiceGet() {
    // The visitor's explicit "Deliver to" choice. First localStorage use
    // in this file — private mode / disabled storage must stay silent —
    // and only a known state code is ever honored.
    try {
      var v = window.localStorage ? window.localStorage.getItem('cx:us_state') : null;
      if (typeof v === 'string' && /^[A-Z]{2}$/.test(v) && US_STATE_NAMES[v]) return v;
    } catch (e) { /* noop */ }
    return null;
  }

  function deliveryUsChoiceSet(code) {
    // Persist the explicit choice — an invalid/empty code CLEARS it (the
    // placeholder option is the visitor's way back to the geo hint).
    // Best-effort: storage failures are silent.
    try {
      if (typeof code === 'string' && /^[A-Z]{2}$/.test(code) && US_STATE_NAMES[code]) {
        window.localStorage.setItem('cx:us_state', code);
      } else {
        window.localStorage.removeItem('cx:us_state');
      }
    } catch (e) { /* noop */ }
  }

  function deliveryUsCurrent(us) {
    // Effective state code — the explicit choice wins over the geo hint,
    // null (US-wide promise) when neither resolved. The module object is
    // required so a disabled/absent module can never resolve a state.
    if (!us || typeof us !== 'object') return null;
    var choice = deliveryUsChoiceGet();
    if (choice) return choice;
    var g = deliveryUsGeoState;
    if (typeof g === 'string' && /^[A-Z]{2}$/.test(g) && US_STATE_NAMES[g]) return g;
    return null;
  }

  function deliveryUsDeliverTo() {
    // The deliver_to label — '' on a miss OR a Shopify "Translation
    // missing" marker (the azT rule), so an incomplete locale hides ONLY
    // the selector, never the promise.
    var str = deliveryT('delivery.deliver_to');
    if (!str || str.indexOf('Translation missing') === 0) return '';
    return str;
  }

  function deliveryUsLabel() {
    // "Deliver to<NBSP>California" — the deliver_to string carries each
    // language's own punctuation convention (a locale-file fact), the
    // place name rides after an NBSP so the pair never line-breaks
    // apart. No resolved state: the country name in the page language
    // via Intl.DisplayNames, English fallback.
    var t = deliveryUsDeliverTo();
    if (!t) return '';
    var us = cfg && cfg.delivery && typeof cfg.delivery === 'object' ? cfg.delivery.us : null;
    var st = deliveryUsCurrent(us);
    var place = st && US_STATE_NAMES[st] ? US_STATE_NAMES[st] : '';
    if (!place) {
      place = 'United States';
      try {
        if (window.Intl && Intl.DisplayNames) {
          var loc = cfg.delivery && typeof cfg.delivery.pageLocale === 'string' && cfg.delivery.pageLocale ? cfg.delivery.pageLocale : 'en';
          var name = new Intl.DisplayNames([loc], { type: 'region' }).of('US');
          if (typeof name === 'string' && name) place = name;
        }
      } catch (e) { /* keep the English fallback */ }
    }
    return t + '\u00a0' + place;
  }

  function deliveryUsPointerCoarse() {
    // The selector's close semantics split on this: coarse-pointer
    // native pickers fire ONE change per commit (change may close), a
    // fine pointer arrow-browses a closed <select> firing change per
    // keystroke, so closing must wait for blur/outside-click/Escape. A
    // matchMedia miss counts as fine — the keyboard-safe default.
    try {
      return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch (e) { return false; }
  }

  function deliveryUsPopToggle(root, open) {
    var btn = root.querySelector('.cx-usloc__btn');
    var pop = root.querySelector('.cx-usloc__pop');
    if (!btn || !pop) return;
    if (open) {
      pop.removeAttribute('hidden');
      btn.setAttribute('aria-expanded', 'true');
    } else {
      pop.setAttribute('hidden', '');
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  function deliveryUsPopCloseAll() {
    var nodes = document.querySelectorAll('.cx-usloc');
    for (var i = 0; i < nodes.length; i++) deliveryUsPopToggle(nodes[i], false);
  }

  function deliveryUsDocBind() {
    // Document-level selector wiring, bound ONCE (cart re-renders
    // re-create the nodes; the bindings must never stack). Outside-click
    // + Escape close both exit before any DOM walk while no popover is
    // open; Escape must return focus to the open popover's button —
    // keyboard focus never falls to <body>. The cx:us-state listener is
    // the cross-bundle half of the state fan-out: pdp + cart are
    // separate closures on one page, so a change in either must re-run
    // the OTHER's local prime + ticks; deliveryUsEventToken identifies
    // this bundle's own dispatches (skipped — its ticks already ran).
    if (deliveryUsDocBound) return;
    deliveryUsDocBound = true;
    document.addEventListener('click', function (event) {
      if (!document.querySelector('.cx-usloc__pop:not([hidden])')) return;
      var t = event.target;
      if (t && t.nodeType === 1 && typeof t.closest === 'function' && t.closest('.cx-usloc')) return;
      deliveryUsPopCloseAll();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' && event.key !== 'Esc') return;
      var open = document.querySelector('.cx-usloc__pop:not([hidden])');
      if (!open) return;
      deliveryUsPopCloseAll();
      var btn = open.parentNode && typeof open.parentNode.querySelector === 'function' ? open.parentNode.querySelector('.cx-usloc__btn') : null;
      if (btn) { try { btn.focus(); } catch (e) { /* noop */ } }
    });
    document.addEventListener('cx:us-state', function (event) {
      if (event && event.detail === deliveryUsEventToken) return; // own dispatch: local ticks already ran
      deliveryUsPrime();
      deliveryUsTicks();
    });
  }

  function deliveryUsSelectorFill(root) {
    // Refresh ONE selector's label, selection and attribution from the
    // current resolution (storage/module vars — never DOM state, so cart
    // re-renders and geo upgrades always converge). The db-ip.com credit
    // is REQUIRED (CC BY 4.0) exactly while the shown state came from
    // the geo hint; a manual choice needs no attribution.
    var us = cfg && cfg.delivery && typeof cfg.delivery === 'object' ? cfg.delivery.us : null;
    var st = deliveryUsCurrent(us);
    var label = root.querySelector('.cx-usloc__label');
    if (label) label.textContent = deliveryUsLabel();
    var sel = root.querySelector('.cx-usloc__select');
    if (sel) sel.value = st || '';
    var attr = root.querySelector('.cx-usloc__attr');
    if (attr) {
      if (st && !deliveryUsChoiceGet()) attr.removeAttribute('hidden');
      else attr.setAttribute('hidden', '');
    }
  }

  function deliveryUsSelectorSync() {
    var nodes = document.querySelectorAll('.cx-usloc');
    for (var i = 0; i < nodes.length; i++) deliveryUsSelectorFill(nodes[i]);
  }

  function deliveryUsTicks() {
    // The quiet-upgrade fan-out: a state change re-runs the mounted
    // widgets through their NORMAL tick paths (in-place text swap, no
    // rebuild, and no beacon — ticks never call track()). azDeliveryTick
    // exists only in the PDP bundle; typeof-guarded so the twins stay
    // byte-identical.
    deliveryTick();
    dispatchTick();
    if (typeof azDeliveryTick === 'function') azDeliveryTick();
    deliveryUsSelectorSync();
  }

  function deliveryUsBroadcast() {
    // The cross-bundle half of a state change: the sibling bundle holds
    // its own closures and intervals, so only a document event reaches
    // it (the deliveryUsDocBind listener). The shared storage halves
    // are written BEFORE any dispatch, so the sibling re-primes to the
    // same state. No CustomEvent: the 30s intervals catch up instead.
    try {
      if (typeof window.CustomEvent !== 'function') return;
      document.dispatchEvent(new window.CustomEvent('cx:us-state', { detail: deliveryUsEventToken }));
    } catch (e) { /* best effort */ }
  }

  function deliveryUsSelectorNode() {
    // "Deliver to: California ▾" — the Amazon location-line pattern,
    // deliberately quiet under the promise line. createElement /
    // textContent ONLY (no config text can ever reach markup); the
    // native <select> doubles as the native mobile picker. Idempotent by
    // construction: selection state lives in storage/module vars, so a
    // rebuilt node always re-derives it via deliveryUsSelectorFill.
    var t = deliveryUsDeliverTo();
    if (!t) return null;
    var us = cfg && cfg.delivery && typeof cfg.delivery === 'object' ? cfg.delivery.us : null;
    var by = us && typeof us === 'object' && us.byState && typeof us.byState === 'object' ? us.byState : null;
    var inRoot = false; // mousedown-inside flag for the blur close path
    var root = cxEl('div', 'cx-usloc');
    var btn = cxEl('button', null, ['type', 'button', 'class', 'cx-usloc__btn', 'aria-haspopup', 'true', 'aria-expanded', 'false']);
    btn.appendChild(cxIcon('pin', 12));
    btn.appendChild(cxEl('span', 'cx-usloc__label'));
    var caret = cxEl('span', 'cx-usloc__caret', ['aria-hidden', 'true']);
    caret.textContent = '▾';
    btn.appendChild(caret);
    root.appendChild(btn);
    var pop = cxEl('div', 'cx-usloc__pop', ['hidden', '']);
    var sel = cxEl('select', 'cx-usloc__select', ['aria-label', t]);
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = t;
    sel.appendChild(ph);
    var codes = Object.keys(US_STATE_NAMES);
    codes.sort(function (a, b) { return US_STATE_NAMES[a] < US_STATE_NAMES[b] ? -1 : 1; });
    for (var i = 0; i < codes.length; i++) {
      // A merchant-hidden state must never be CHOOSABLE: offering it
      // would trade the widget for a stored choice that hides every
      // surface. Geo may still resolve it — hiding a state's own
      // locals is the merchant's stated intent; the dropdown is not.
      var entry = by ? by[codes[i]] : null;
      if (entry && typeof entry === 'object' && entry.hidden === true) continue;
      var opt = document.createElement('option');
      opt.value = codes[i];
      opt.textContent = US_STATE_NAMES[codes[i]];
      sel.appendChild(opt);
    }
    pop.appendChild(sel);
    var attr = cxEl('a', 'cx-usloc__attr', ['href', 'https://db-ip.com', 'rel', 'noopener', 'target', '_blank', 'hidden', '']);
    attr.textContent = 'IP Geolocation by DB-IP';
    pop.appendChild(attr);
    root.appendChild(pop);
    btn.addEventListener('click', function () {
      // Toggle THIS popover; any sibling instance (drawer + cart page)
      // closes first so only one can ever be open.
      var wasHidden = pop.hasAttribute('hidden');
      deliveryUsPopCloseAll();
      if (wasHidden) deliveryUsPopToggle(root, true);
    });
    sel.addEventListener('change', function () {
      // Coarse pointers: the native picker fires ONE change per commit,
      // so change may also close. Fine pointers fire change per arrow
      // keystroke on a closed <select> — the popover must stay open (a
      // live date preview) and close on blur/outside-click/Escape.
      deliveryUsChoiceSet(sel.value);
      if (deliveryUsPointerCoarse()) deliveryUsPopToggle(root, false);
      deliveryUsTicks();
      deliveryUsBroadcast();
    });
    root.addEventListener('mousedown', function () {
      // Safari never focuses a clicked <button>, so a click inside the
      // selector can blur the select with relatedTarget null — this
      // one-task flag keeps such blurs from closing (the click's own
      // handler decides), while true outside blurs still close below.
      inRoot = true;
      window.setTimeout(function () { inRoot = false; }, 0);
    });
    sel.addEventListener('blur', function (event) {
      // Fine-pointer close path: the commit ends when the select loses
      // focus. Focus moving WITHIN the selector never closes; focus
      // falling to <body> returns to the button (keyboard users are
      // never stranded); focus moving to another control is left alone.
      if (deliveryUsPointerCoarse()) return;
      if (pop.hasAttribute('hidden')) return;
      if (inRoot) return;
      var to = event && event.relatedTarget;
      if (to && typeof root.contains === 'function' && root.contains(to)) return;
      deliveryUsPopToggle(root, false);
      if (!to) { try { btn.focus(); } catch (e) { /* noop */ } }
    });
    deliveryUsSelectorFill(root);
    return root;
  }

  function deliveryUsSelectorAttach(node) {
    // Append the selector as the LAST child of a mounted delivery node —
    // only when the module resolved (dc.us), the merchant kept the
    // selector on and the deliver_to string exists (a missing string
    // hides ONLY the selector, never the promise). Safe to call on every
    // (re-)mount: fresh nodes get a fresh selector, mounted ones keep
    // theirs.
    try {
      if (!node || node.querySelector('.cx-usloc')) return;
      var dc = deliveryConfig();
      if (!dc || !dc.us || dc.us.sel !== true) return;
      var sel = deliveryUsSelectorNode();
      if (!sel) return;
      node.appendChild(sel);
      deliveryUsDocBind();
    } catch (e) { /* never break the theme */ }
  }

  function deliveryUsGeoApply(s) {
    // Adopt a geo verdict; when the EFFECTIVE state actually changed (an
    // explicit choice masks geo entirely), fan out the quiet upgrade.
    // Never called with an unvalidated code. The sessionStorage verdict
    // is already written by every caller, so the cross-bundle broadcast
    // finds the same state when the sibling re-primes.
    var us = cfg && cfg.delivery && typeof cfg.delivery === 'object' ? cfg.delivery.us : null;
    var before = deliveryUsCurrent(us);
    deliveryUsGeoState = s;
    if (deliveryUsCurrent(us) !== before) {
      deliveryUsTicks();
      deliveryUsBroadcast();
    }
  }

  function deliveryUsPrime() {
    // The SYNCHRONOUS half of the state resolution — MUST run before
    // any delivery/dispatch/az mount decision, and never touches the
    // network (deliveryUsGeoKick owns that half). Beacon honesty: a
    // fresh cached geo verdict has to be effective ahead of the first
    // paint so a hidden state never mounts a widget whose impression
    // beacon then counts a removed-before-paint node. Self-heal: a
    // stored CHOICE now resolving to hidden:true is auto-CLEARED (the
    // selector no longer offers hidden states) — the visitor falls
    // back to geo, which re-hides a genuine hidden-state local.
    try {
      var us = cfg && cfg.delivery && typeof cfg.delivery === 'object' ? cfg.delivery.us : null;
      if (!us || typeof us !== 'object' || us.enabled !== true) return;
      var choice = deliveryUsChoiceGet();
      if (choice) {
        var entry = us.byState && typeof us.byState === 'object' ? us.byState[choice] : null;
        if (entry && typeof entry === 'object' && entry.hidden === true) deliveryUsChoiceSet('');
        else return; // a live choice masks geo: nothing to prime
      }
      var raw = window.sessionStorage ? window.sessionStorage.getItem('cx_geo:1') : null;
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.t !== 'number' ||
          Date.now() - parsed.t >= 21600000) return;
      var cs = parsed.s;
      if (typeof cs === 'string' && /^[A-Z]{2}$/.test(cs) && US_STATE_NAMES[cs]) deliveryUsGeoState = cs;
    } catch (e) { /* fail open: US-wide */ }
  }

  function deliveryUsGeoKick() {
    // SPEC-v10 IP-to-state hint: at most ONE self-hosted app-proxy fetch
    // per page, kicked AFTER a delivery mount so it can only quietly
    // upgrade an already-painted US-wide promise, never gate one. Every
    // failure is silent and the 6h sessionStorage verdict is cached
    // NEGATIVELY too (a null verdict stops refetch storms). The
    // visitor's IP never reaches a third party and no beacon ever rides
    // this path.
    try {
      if (deliveryUsGeoPromise) return; // single-flight
      var dc = deliveryConfig();
      if (!dc || !dc.us) return; // module off / invalid config: nothing to upgrade
      if (deliveryUsChoiceGet()) return; // explicit choice masks geo: skip
      var cached = null;
      try {
        var raw = window.sessionStorage ? window.sessionStorage.getItem('cx_geo:1') : null;
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && typeof parsed.t === 'number' &&
              Date.now() - parsed.t < 21600000) cached = parsed;
        }
      } catch (e) { cached = null; }
      if (cached) {
        var cs = cached.s;
        if (typeof cs === 'string' && /^[A-Z]{2}$/.test(cs) && US_STATE_NAMES[cs]) deliveryUsGeoApply(cs);
        return; // fresh verdict (positive or negative): no fetch
      }
      if (!window.fetch) return;
      deliveryUsGeoPromise = window.fetch(routeRoot() + 'apps/cellexia/geo', { cache: 'no-store', headers: { Accept: 'application/json' } })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var s = data && typeof data.s === 'string' && /^[A-Z]{2}$/.test(data.s) && US_STATE_NAMES[data.s] ? data.s : null;
          try { window.sessionStorage.setItem('cx_geo:1', JSON.stringify({ s: s, t: Date.now() })); } catch (e) { /* best effort */ }
          if (s) deliveryUsGeoApply(s);
        })
        .catch(function () {
          // Network/parse trouble: negative-cache the miss, keep US-wide.
          try { window.sessionStorage.setItem('cx_geo:1', JSON.stringify({ s: null, t: Date.now() })); } catch (e) { /* best effort */ }
        });
    } catch (e) { /* never break the theme */ }
  }

  // ------------------------------------------- delivery DOM layer (v6.0)
  //
  // Cart-specific: template ids are surface-specific (cx-tpl-delivery-cart
  // / -cart-alt — this embed renders on product pages too, where the PDP
  // block owns cx-tpl-delivery), the tick queries .cx-delivery--cart only
  // (the PDP engine owns its own nodes), and every clone gets a unique
  // tooltip id because the widget can mount twice at once (drawer + cart
  // page). deliverySetText and bindDeliveryTooltip are byte-copies of the
  // PDP ones — same data-cx-tip-pos / data-cx-tip-align conventions.
  var deliveryTimer = null;
  var deliveryTipUid = 0;

  function deliverySetText(node, texts) {
    // Populate whichever format slots exist on this node — textContent
    // ONLY (the strings passed through decodeEntities in deliveryT).
    var pairs = [
      ['[data-cx-delivery-line]', texts.line],
      ['[data-cx-delivery-range]', texts.range],
      ['[data-cx-delivery-ship]', texts.ship],
      ['[data-cx-delivery-done]', texts.delivered],
      ['[data-cx-delivery-title]', texts.title],
      ['[data-cx-delivery-tip]', texts.tooltip]
    ];
    for (var i = 0; i < pairs.length; i++) {
      var el = node.querySelector(pairs[i][0]);
      if (el) el.textContent = pairs[i][1];
    }
  }

  function bindDeliveryTooltip(node) {
    // Guarantee-badge explainer: a true tooltip (role="tooltip" +
    // aria-describedby ship in the markup). Fine pointers: opens on hover
    // AND on keyboard focus; touch/coarse: tap toggles. Escape always
    // closes and refocuses the badge. Positioned above the badge by CSS,
    // flipped below via data-cx-tip-pos when the viewport has no room.
    try {
      var btn = node.querySelector('[data-cx-delivery-badge]');
      var tip = node.querySelector('[data-cx-delivery-tip]');
      if (!btn || !tip) return;
      var hoverFine = false;
      try {
        hoverFine = !!(window.matchMedia &&
          window.matchMedia('(hover: hover)').matches &&
          window.matchMedia('(pointer: fine)').matches);
      } catch (e) { hoverFine = false; }
      function place() {
        try {
          tip.setAttribute('data-cx-tip-pos', 'above');
          tip.removeAttribute('data-cx-tip-align');
          var rect = tip.getBoundingClientRect();
          if (rect.top < 4) tip.setAttribute('data-cx-tip-pos', 'below');
          // Horizontal: if the start-anchored tip crosses either viewport
          // edge (narrow screens, RTL), anchor it to the badge's inline
          // end instead; revert when that is no better.
          var vw = window.innerWidth || document.documentElement.clientWidth || 0;
          rect = tip.getBoundingClientRect();
          if (vw && (rect.right > vw - 8 || rect.left < 8)) {
            tip.setAttribute('data-cx-tip-align', 'end');
            rect = tip.getBoundingClientRect();
            if (rect.right > vw - 8 || rect.left < 8) {
              tip.removeAttribute('data-cx-tip-align');
            }
          }
        } catch (e) { /* noop */ }
      }
      function setOpen(open) {
        if (open) {
          tip.removeAttribute('hidden');
          place();
        } else {
          tip.setAttribute('hidden', '');
        }
      }
      function isOpen() {
        return !tip.hasAttribute('hidden');
      }
      if (hoverFine) {
        btn.addEventListener('mouseenter', function () { setOpen(true); });
        btn.addEventListener('mouseleave', function () { setOpen(false); });
        btn.addEventListener('focus', function () { setOpen(true); });
        btn.addEventListener('blur', function () { setOpen(false); });
      } else {
        btn.addEventListener('click', function () { setOpen(!isOpen()); });
      }
      node.addEventListener('keydown', function (event) {
        if ((event.key === 'Escape' || event.key === 'Esc') && isOpen()) {
          setOpen(false);
          try { btn.focus(); } catch (e) { /* noop */ }
        }
      });
    } catch (e) { /* never break the theme */ }
  }

  // v6.2 Liquid diet: the cart delivery shells (cx-tpl-delivery-cart + alt,
  // four formats) are JS-built now. cxIcon/cxEl and the deliveryBuild*
  // functions below are BYTE-TWIN copies of the cellexia-pdp.js ones (the
  // prover enforces cross-file byte-parity); only CX_AZ_ICONS carries the
  // cart-needed subset of the icon data and deliveryCartClass is the
  // cart-specific wiring (surface variant class). Same preview convention
  // as before: inside a verified preview session the merchant's armed
  // DRAFT cart format (shipped in cfg.preview.deliveryFormat — tokenless,
  // armed-only) wins over the live format, exactly what the alt-template
  // preference used to produce. Every dynamic value still lands via
  // textContent from the fail-closed engine.

  var CX_AZ_ICONS = {
    // cart subset: the icons the JS-built cart widgets render (delivery
    // shells + v6.7 trust-row/dispatch/azfree) — byte-equal twins of the
    // cx-icons snippet cases
    box: ['1.5', '<path d="m10 2.2 7 3.5v8.6l-7 3.5-7-3.5V5.7z"/><path d="M3 5.7l7 3.5 7-3.5"/><path d="M10 9.2v8.6"/><path d="m6.5 3.95 7 3.5"/>'],
    check: ['2', '<path d="m3.5 10.5 4.2 4.2 8.8-9.4"/>'],
    'shield-check': ['1.5', '<path d="M10 1.8 3.5 4.2v5c0 4.2 2.8 7.3 6.5 8.9 3.7-1.6 6.5-4.7 6.5-8.9v-5z"/><path d="m7 9.8 2.2 2.2L13.2 8"/>'],
    lock: ['1.5', '<rect x="3.5" y="8.5" width="13" height="9" rx="2"/><path d="M6.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5"/><circle cx="10" cy="13" r="1.25" fill="currentColor" stroke="none"/>'],
    truck: ['1.5', '<path d="M1.5 4.5h10v9h-10z"/><path d="M11.5 7.5h3.2l3.3 3.3v2.7h-6.5"/><circle cx="5.5" cy="15" r="1.75"/><circle cx="14.5" cy="15" r="1.75"/>'],
    // v10 US state module: location pin on the "Deliver to" selector —
    // same entry rides the cellexia-pdp.js icon table.
    pin: ['1.5', '<path d="M10 18.2S4.4 12.9 4.4 8.6a5.6 5.6 0 0 1 11.2 0c0 4.3-5.6 9.6-5.6 9.6Z"/><circle cx="10" cy="8.4" r="2.1"/>']
  };

  function cxIcon(name, size) {
    // Static-markup twin of {% render 'cx-icons', icon: name, size: n %}
    // for the icons the JS-built widgets use. No dynamic value ever
    // reaches this innerHTML.
    var spec = CX_AZ_ICONS[name];
    if (!spec) return document.createTextNode('');
    var wrap = document.createElement('div');
    wrap.innerHTML = '<svg class="cx-icon" width="' + size + '" height="' + size +
      '" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="' + spec[0] +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + spec[1] + '</svg>';
    return wrap.firstChild || document.createTextNode('');
  }

  function cxEl(tag, cls, attrs) {
    // class first (template attribute order), then attrs as flat
    // [name, value, ...] pairs.
    var el = document.createElement(tag);
    if (cls) el.setAttribute('class', cls);
    if (attrs) {
      for (var i = 0; i < attrs.length; i += 2) el.setAttribute(attrs[i], attrs[i + 1]);
    }
    return el;
  }

  function cxSp(el) {
    // The single collapsed space an old template newline rendered as.
    el.appendChild(document.createTextNode(' '));
    return el;
  }

  function cxRawStr(o, k) {
    // RAW config read for values the old templates piped through
    // | escape or emitted inside src/srcset/href attributes: the HTML
    // parser returned them verbatim, so no decodeEntities at consumption
    // (decoding would double-decode merchant text like "&amp;").
    return o && typeof o[k] === 'string' ? o[k] : '';
  }

  function cxStr(o, k) {
    // Decoded config read for values the old templates emitted as RAW
    // text nodes ({{ value }} / {{ value | money }} with no | escape):
    // the HTML parser decoded any character references in them (money
    // formats routinely carry &nbsp;), so consumption must decode once
    // to land the identical DOM text via textContent.
    return o && typeof o[k] === 'string' ? decodeEntities(o[k]) : '';
  }

  function deliveryBuildBadge() {
    var badge = cxEl('span', 'cx-delivery__badge');
    var btn = cxEl('button', null, ['type', 'button', 'class', 'cx-delivery__badge-btn', 'data-cx-delivery-badge', '', 'aria-describedby', 'cx-delivery-tip']);
    btn.appendChild(cxIcon('shield-check', 12));
    var label = document.createElement('span');
    label.textContent = deliveryT('delivery.badge');
    btn.appendChild(label);
    badge.appendChild(btn);
    badge.appendChild(cxEl('span', 'cx-delivery__tip', ['id', 'cx-delivery-tip', 'role', 'tooltip', 'hidden', '', 'data-cx-delivery-tip', '']));
    return badge;
  }

  function deliveryBuildNode(fmt) {
    var root;
    if (fmt === 'range') {
      root = cxEl('div', 'cx-delivery cx-delivery--range', ['data-cx-feature', 'delivery_estimate']);
      root.appendChild(cxEl('span', 'cx-delivery__range', ['data-cx-delivery-range', '']));
      root.appendChild(deliveryBuildBadge());
    } else if (fmt === 'timeline') {
      root = cxEl('div', 'cx-delivery cx-delivery--timeline', ['data-cx-feature', 'delivery_estimate']);
      var ol = cxEl('ol', 'cx-delivery__steps list-reset');
      var li1 = cxEl('li', 'cx-delivery__step');
      li1.textContent = deliveryT('delivery.timeline_order');
      ol.appendChild(li1);
      ol.appendChild(cxEl('li', 'cx-delivery__step', ['data-cx-delivery-ship', '']));
      ol.appendChild(cxEl('li', 'cx-delivery__step', ['data-cx-delivery-done', '']));
      root.appendChild(ol);
      root.appendChild(deliveryBuildBadge());
    } else if (fmt === 'box') {
      root = cxEl('div', 'cx-delivery cx-delivery--box', ['data-cx-feature', 'delivery_estimate']);
      root.appendChild(cxIcon('check', 16));
      var copy = cxEl('span', 'cx-delivery__box-copy');
      copy.appendChild(cxEl('strong', 'cx-delivery__box-title', ['data-cx-delivery-title', '']));
      copy.appendChild(document.createTextNode(' '));
      var sub = cxEl('span', 'cx-delivery__box-sub');
      sub.textContent = deliveryT('delivery.box_sub');
      copy.appendChild(sub);
      copy.appendChild(document.createTextNode(' '));
      copy.appendChild(deliveryBuildBadge());
      root.appendChild(copy);
    } else {
      root = cxEl('div', 'cx-delivery cx-delivery--line', ['data-cx-feature', 'delivery_estimate']);
      root.appendChild(cxIcon('box', 15));
      root.appendChild(cxEl('span', 'cx-delivery__line', ['data-cx-delivery-line', '']));
      root.appendChild(deliveryBuildBadge());
    }
    return root;
  }

  function deliveryValidFormat(f) {
    return f === 'line' || f === 'range' || f === 'timeline' || f === 'box';
  }

  function deliveryBuildFormat() {
    var fmt = cfg && cfg.delivery && typeof cfg.delivery.format === 'string' && deliveryValidFormat(cfg.delivery.format)
      ? cfg.delivery.format : 'line';
    if (PREVIEW) {
      var draft = cfg && cfg.preview && typeof cfg.preview.deliveryFormat === 'string' ? cfg.preview.deliveryFormat : '';
      if (deliveryValidFormat(draft)) fmt = draft;
    }
    return fmt;
  }

  function deliveryCartClass(node) {
    // Cart-specific wiring, OUTSIDE the byte-twin builder block: the old
    // cart template bodies carried the cx-delivery--cart surface variant
    // class right after the base class (deliveryTick and the CSS key off
    // it). Splicing it here keeps the shared builders byte-identical to
    // the PDP file.
    node.className = node.className.replace('cx-delivery ', 'cx-delivery cx-delivery--cart ');
    return node;
  }

  function deliveryTick() {
    // Same guarded-interval pattern as dispatchTick above (the two widgets
    // stack but never share a timer, so neither can starve the other):
    // re-run the WHOLE computation each 30s tick — crossing the cutoff
    // shifts every date — and remove the node the moment anything stops
    // being defensible. Self-clears when no nodes remain, so drawer
    // re-renders can never leak intervals.
    var nodes = document.querySelectorAll('.cx-delivery--cart');
    if (!nodes.length) {
      if (deliveryTimer) { window.clearInterval(deliveryTimer); deliveryTimer = null; }
      return;
    }
    var dc = deliveryConfig();
    var result = dc ? deliveryCompute(dc) : null;
    var texts = result ? deliveryTexts(result, dc) : null;
    for (var i = 0; i < nodes.length; i++) {
      if (texts === null) {
        try {
          if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
        } catch (e) { /* noop */ }
      } else {
        deliverySetText(nodes[i], texts);
      }
    }
    if (texts === null && deliveryTimer) {
      window.clearInterval(deliveryTimer);
      deliveryTimer = null;
    }
  }

  function deliveryEnsureTimer() {
    if (deliveryTimer) return; // single guarded interval, never stacked
    deliveryTimer = window.setInterval(deliveryTick, 30000);
  }

  function renderDelivery(container) {
    // CART twin of the PDP mountDelivery: called by renderInto directly
    // AFTER renderDispatch (CRO order: urgency then reassurance, both
    // above the shipbar). Every gate fails closed: feature off (featureOn
    // carries the live/draft gate the template emission used to enforce),
    // invalid/hidden config, no computable dates, missing strings ->
    // render nothing. v6.2: the shell is JS-built (byte-twin builders
    // above) instead of cloned from a Liquid template.
    if (!featureOn('delivery')) return null;
    var dc = deliveryConfig();
    if (!dc) return null; // invalid/hidden config: fail closed
    var result = deliveryCompute(dc);
    if (!result) return null; // no defensible dates: fail closed
    var texts = deliveryTexts(result, dc);
    if (!texts) return null; // missing strings: fail closed
    try {
      var node = deliveryCartClass(deliveryBuildNode(deliveryBuildFormat()));
      if (!node) return null;
      // Unique tooltip id per clone — drawer and cart page can both
      // mount, and aria-describedby must never point at a twin's tip.
      var tip = node.querySelector('[data-cx-delivery-tip]');
      var badge = node.querySelector('[data-cx-delivery-badge]');
      if (tip && badge) {
        deliveryTipUid += 1;
        var tipId = 'cx-delivery-tip-cart-' + deliveryTipUid;
        tip.id = tipId;
        badge.setAttribute('aria-describedby', tipId);
      }
      deliverySetText(node, texts);
      container.appendChild(node);
      bindDeliveryTooltip(node);
      deliveryUsSelectorAttach(node); // v10 "Deliver to" selector — self-gated
      deliveryEnsureTimer();
      // v10: the geo hint fires only AFTER a delivery node exists — it
      // can quietly upgrade the painted US-wide promise, never gate it.
      deliveryUsGeoKick();
      return 'delivery_estimate';
    } catch (e) {
      return null;
    }
  }

  function renderInto(root, context) {
    if (!root) return [];
    // v10: the synchronous state half (stored choice + fresh geo cache)
    // must be resolved BEFORE the render decisions below — a cached
    // hidden verdict vetoes renderDispatch/renderDelivery themselves
    // (no node, no impression), never removes an already-counted one.
    deliveryUsPrime();
    root.textContent = '';
    if (state.busy) root.classList.add('cx-busy');
    else root.classList.remove('cx-busy');
    if (state.busy) root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');
    var features = [];
    // Amazon-pattern threshold sentence (v6.1) — the very TOP of the
    // booster root, per the pattern (Amazon's green line sits above
    // everything in the order summary). Its return value drives the
    // shipbar text-line suppression below.
    var azFree = renderAzFreeLine(root);
    if (azFree) features.push(azFree);
    renderNotice(root);
    var f;
    // Dispatch countdown next — above the shipbar.
    f = renderDispatch(root); if (f) features.push(f);
    // Delivery estimate directly after it (v6.0) — CRO order: urgency,
    // then reassurance, both above the shipbar.
    f = renderDelivery(root); if (f) features.push(f);
    // v6.1 replacement semantics: while the az sentence RENDERED, the
    // shipbar keeps its progress bar but drops its own message line.
    f = renderShipbar(root, !!azFree); if (f) features.push(f);
    var offerFeatures = renderOffers(root, context);
    for (var i = 0; i < offerFeatures.length; i++) features.push(offerFeatures[i]);
    // CRO order: offers, then cross-sell, then social proof last.
    f = renderCrossSell(root); if (f) features.push(f);
    f = renderTrustRow(root); if (f) features.push(f);
    root.setAttribute('data-cx-context', context);
    return features;
  }

  function drawerIsOpen() {
    var mini = document.querySelector('.mini-cart');
    return !!(mini && mini.classList.contains('is-open'));
  }

  function fireDrawerImpressions(features) {
    if (!drawerIsOpen()) return;
    features.forEach(function (feature) {
      if (state.openImpressions[feature]) return;
      state.openImpressions[feature] = true;
      track(feature, 'impression');
    });
  }

  function firePageImpressions(features) {
    features.forEach(function (feature) {
      if (state.pageImpressions[feature]) return;
      state.pageImpressions[feature] = true;
      track(feature, 'impression');
    });
  }

  function ensureDrawerRoot() {
    var content = document.querySelector('.mini-cart__content');
    if (!content) return null;
    if (state.drawerRoot && state.drawerRoot.isConnected && content.contains(state.drawerRoot)) {
      return state.drawerRoot;
    }
    var existing = content.querySelector(':scope > .cx-cart-booster');
    if (existing) {
      state.drawerRoot = existing;
      return existing;
    }
    var root = el('div', 'cx-cart-booster');
    var list = content.querySelector('.mini-cart__list');
    var footer = content.querySelector('.mini-cart__footer');
    if (footer && footer.parentNode === content) {
      content.insertBefore(root, footer);
    } else if (list && list.parentNode === content && list.nextSibling) {
      content.insertBefore(root, list.nextSibling);
    } else if (list && list.parentNode === content) {
      content.appendChild(root);
    } else {
      return null;
    }
    state.drawerRoot = root;
    return root;
  }

  function ensurePageRoot() {
    if (!SETTINGS.cartPage) return null;
    var table = document.querySelector('.cart__table');
    if (!table || !table.parentNode) return null;
    if (state.pageRoot && state.pageRoot.isConnected) return state.pageRoot;
    var existing = table.parentNode.querySelector(':scope > .cx-cart-booster--page');
    if (existing) {
      state.pageRoot = existing;
      return existing;
    }
    var root = el('div', 'cx-cart-booster cx-cart-booster--page');
    if (table.nextSibling) table.parentNode.insertBefore(root, table.nextSibling);
    else table.parentNode.appendChild(root);
    state.pageRoot = root;
    return root;
  }

  function decorateSubscriptionRows() {
    // v4.7 per-line remove, hardened in v4.8: after every theme re-render
    // (refreshMiniCart rebuilds the drawer's .product--cart rows from
    // scratch, dropping anything we added), inject a "Remove subscription"
    // control under each subscribed row's .delivery span — drawer rows AND
    // the cart page's tr.cart-row (col__product context) alike. The button
    // sits inside its OWN block row (div.cx-sub-remove-row) inserted as a
    // sibling right after .delivery, so the theme's stacked .title column
    // (h3 / .var / .delivery / .unit-price) keeps flowing naturally.
    // Idempotent via the data-cx-decorated marker; row -> cart line
    // matching re-reads the CURRENT state.cart on every pass (no node or
    // line references are cached anywhere — rebuilt rows arrive without
    // markers because the marker lives on the row element itself);
    // everything null-guarded.
    try {
      if (!featureOn('subscription')) return;
      // Never decorate mid-mutation: a button minted disabled would stay
      // disabled forever behind the idempotency marker. v4.8: RE-QUEUE the
      // pass instead of swallowing it — a decorate request during a
      // mutation retries until busy clears, so no path can permanently
      // skip decoration.
      if (state.busy) {
        if (!state.decorateTimer) {
          state.decorateTimer = window.setTimeout(function () {
            state.decorateTimer = null;
            decorateSubscriptionRows();
          }, 150);
        }
        return;
      }
      if (!state.cart || !Array.isArray(state.cart.items)) return;
      var rows = document.querySelectorAll('.product--cart, .cart-row');
      if (!rows.length) return;
      var used = {};
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (!row || row.getAttribute('data-cx-decorated') === '1') continue;
        var delivery = row.querySelector('.delivery');
        if (!delivery || !delivery.parentNode) continue;
        var varid = row.getAttribute('data-varid');
        if (!varid) continue;
        var line = null;
        for (var j = 0; j < state.cart.items.length; j++) {
          var item = state.cart.items[j];
          if (!item || !item.key || used[item.key]) continue;
          if (String(item.variant_id) === String(varid) && itemHasPlan(item)) {
            line = item;
            break;
          }
        }
        if (!line) continue;
        used[line.key] = true;
        row.setAttribute('data-cx-decorated', '1');
        var btn = el('button', 'cx-sub-remove');
        btn.type = 'button';
        var glyph = el('span', 'cx-sub-remove__x', '×');
        glyph.setAttribute('aria-hidden', 'true');
        btn.appendChild(glyph);
        btn.appendChild(document.createTextNode(' ' + (cfg.overrides.removeLabel || t('subscription.remove'))));
        (function (lineKey, node) {
          node.addEventListener('click', function () {
            performUnsubscribe(lineKey, node);
          });
        })(line.key, btn);
        // v4.8 display fix: the button used to wedge inline between the
        // plan name and the price — wrap it in a block row so it renders
        // on its own line between .delivery and .unit-price.
        var wrap = el('div', 'cx-sub-remove-row');
        wrap.appendChild(btn);
        if (delivery.nextSibling) delivery.parentNode.insertBefore(wrap, delivery.nextSibling);
        else delivery.parentNode.appendChild(wrap);
      }
    } catch (e) { /* never break the theme */ }
  }

  // --------------------------- Amazon-pattern checkout CTA count (v6.1)
  //
  // az_cta_count decorates the THEME's checkout buttons — drawer
  // (.mini-cart__actions) and cart page (div.checkout), selectors per
  // docs/theme-integration.md — with a CLDR-plural-correct
  // "Proceed to checkout (N items)" label. TEXT swap only: the button
  // keeps 100% theme styling. The original label nodes are MOVED (never
  // cloned) into a hidden .cx-azcta-original span on first decoration —
  // stored once, the data-cx-azcta marker prevents double-decoration —
  // and moved back verbatim the moment the feature stops being effective
  // or its strings are unusable. Keeping the original subtree alive in
  // the DOM keeps the theme's own .checkout-subtotal updater working
  // against it, so a restored label is always current. The pass re-runs
  // from renderAll() on every cart mutation (the existing refresh hooks);
  // refreshMiniCart only rebuilds .mini-cart__list, so the buttons
  // survive re-renders and only the count text needs updating.

  var azCtaEverDecorated = false;

  var AZ_CTA_SELECTOR = '.mini-cart__actions a.btn--primary[href*="checkout"], .checkout a.btn--primary[href*="checkout"]';

  function azCtaLabel(count) {
    // CLDR plural selection in the PAGE language via Intl.PluralRules.
    // The Liquid config ships one string per category
    // ("amazon.cta_count.<cat>", sentinel @@COUNT@@); categories a
    // language does not define arrive as "Translation missing" markers
    // and azStr discards them. "other" is mandatory in CLDR — without a
    // usable "other" the label is unbuildable: null (fail closed, the
    // theme label stays/returns).
    if (!azStr('amazon.cta_count.other')) return null;
    var n = Math.floor(Number(count));
    if (!(n >= 0)) return null;
    var locale = typeof cfg.pageLocale === 'string' && cfg.pageLocale ? cfg.pageLocale : undefined;
    var cat = 'other';
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function') {
        cat = new Intl.PluralRules(locale).select(n);
      } else {
        cat = n === 1 ? 'one' : 'other';
      }
    } catch (e) {
      // Intl rejected the locale tag: browser-default rules beat the
      // two-way fallback, which beats giving up.
      try { cat = new Intl.PluralRules().select(n); } catch (e2) { cat = n === 1 ? 'one' : 'other'; }
    }
    if (!azStr('amazon.cta_count.' + cat)) cat = 'other';
    // Digits in the page locale too (ar keeps Arabic-Indic digits);
    // PluralRules got the raw number above.
    var display = String(n);
    try { display = n.toLocaleString(locale); } catch (e3) { display = String(n); }
    return t('amazon.cta_count.' + cat, { count: display });
  }

  function restoreAzCtaButton(node) {
    try {
      if (!node || node.getAttribute('data-cx-azcta') !== '1') return;
      var lbl = node.querySelector('.cx-azcta-label');
      var orig = node.querySelector('.cx-azcta-original');
      if (lbl && lbl.parentNode) lbl.parentNode.removeChild(lbl);
      if (orig && orig.parentNode === node) {
        while (orig.firstChild) node.insertBefore(orig.firstChild, orig);
        node.removeChild(orig);
      }
      node.removeAttribute('data-cx-azcta');
    } catch (e) { /* never break the theme */ }
  }

  function decorateCtaButtons() {
    try {
      var effective = featureOn('azCtaCount') && state.cart && typeof state.cart.item_count === 'number';
      var label = effective ? azCtaLabel(state.cart.item_count) : null;
      // Fast exit for real visitors with the feature off: never touched
      // a button, nothing to scan or restore.
      if (label === null && !azCtaEverDecorated) return;
      var nodes = document.querySelectorAll(AZ_CTA_SELECTOR);
      if (!nodes.length) return;
      var drawerHit = false;
      var pageHit = false;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (label === null) {
          restoreAzCtaButton(node);
          continue;
        }
        if (node.getAttribute('data-cx-azcta') !== '1') {
          var orig = el('span', 'cx-azcta-original');
          orig.setAttribute('hidden', '');
          while (node.firstChild) orig.appendChild(node.firstChild);
          node.appendChild(el('span', 'cx-azcta-label'));
          node.appendChild(orig);
          node.setAttribute('data-cx-azcta', '1');
          azCtaEverDecorated = true;
        }
        var lbl = node.querySelector('.cx-azcta-label');
        if (lbl) lbl.textContent = label;
        var inDrawer = false;
        try { inDrawer = !!(node.closest && node.closest('.mini-cart')); } catch (e2) { inDrawer = false; }
        if (inDrawer) drawerHit = true;
        else pageHit = true;
      }
      if (label !== null) {
        // Impression semantics match the widget roots: drawer counts per
        // open (fireDrawerImpressions guards drawerIsOpen + the per-open
        // reset), page counts once per page view.
        if (drawerHit) fireDrawerImpressions(['az_cta_count']);
        if (pageHit) firePageImpressions(['az_cta_count']);
      }
    } catch (e) { /* never break the theme */ }
  }

  // -------------------------------------- az card flags + bought lines
  //
  // v6.4 badge-everywhere: THEME product cards (collections, home,
  // search, related sliders — this file loads SITE-WIDE via the cart
  // embed) get a compact corner-overlay variant of the PDP bestseller
  // flag whenever their product carries badge data. v6.6 adds the
  // second card element: a small "{n}+ bought in past month" line under
  // the card's title/price info (az_bought_count on cards). Contract:
  //  - gates: cfg.badgeCards / cfg.boughtCards {setting, live} are
  //    precomputed by Liquid (amazon.bestsellerOnCards resp.
  //    amazon.boughtOnCards setting + the feature's market scope; live
  //    additionally requires the az_bestseller_badge resp.
  //    az_bought_count master). Verified preview follows the featureOn()
  //    convention on the same flag via the shared cardGateOn() helper;
  //    the merchant's setting still binds. Fail closed on every miss.
  //  - data: network capped at TWO app-proxy calls per page — one
  //    initial batched cart-data?handles= request (the proxy caps a
  //    batch at 20) plus at most ONE follow-up batch for handles a
  //    later client-side render (Boost PFS filter/sort/pagination,
  //    slick clones) introduced that the merged map has never seen.
  //    Each entry's "bestseller" field is rank + the LOCALIZED category
  //    (the proxy renders through Liquid, so Shopify serves the
  //    translatable category metafield in the page language).
  //    sessionStorage cache keyed by page locale + a hash of the handle
  //    batch, 10-minute TTL — cache hits never touch the network.
  //  - v6.4.1 re-scan: the Sleepify collection grid is Boost PFS
  //    territory (client-side re-render on load and on every filter
  //    action) and home carousels are slick-cloned, so a one-shot scan
  //    either decorates nodes Boost immediately throws away or never
  //    sees the rendered cards at all. A debounced document-level
  //    childList observer re-runs scan+decorate from the merged map;
  //    the data-cx-cardflag marks keep every re-entry idempotent.
  //  - v6.6 REPLACEMENT RULE (merchant directive, supersedes the v6.4.1
  //    skip rule): when OUR flag renders on a card, the theme's own
  //    .product__tag pill (or a POPULATED .badges overlay) is hidden in
  //    the SAME pass via the cx-az-tagswap class — ours replaces theirs
  //    while on. Never hidden without our flag inserted; cards without
  //    badge data keep their theme tags untouched; with the gates off
  //    nothing is written, so a page rendered gates-off never carries
  //    the class.
  //  - beacon-free BY CONTRACT (decoration, not a tracked widget: no
  //    track() call on any path) and NEVER in checkout — theme app
  //    embeds cannot run there, and the explicit guard keeps that true
  //    even if this asset were ever included by hand.
  //  - dynamic values land via textContent only; any unusable string,
  //    missing datum or failed fetch writes NOTHING to the DOM.

  var cardFlagsBooted = false;
  var cardFlagMap = null;     // merged handle -> {rank,category}|null verdicts
  var cardFlagPending = {};   // handles owned by an in-flight fetch
  var cardFlagFetches = 0;    // network calls spent (cache hits are free)
  var CARD_FLAG_FETCH_MAX = 2; // initial batch + one follow-up, per page

  function cardGateOn(gate, featureKey) {
    // Shared two-key card gate (v6.6 generalization of badgeCardsOn —
    // badge behavior unchanged): the Liquid-precomputed {setting, live}
    // pair + the standard verified-preview union on the feature flag.
    // The merchant's on-cards setting binds in preview too.
    if (!gate || typeof gate !== 'object' || gate.setting !== true) return false;
    if (PREVIEW) {
      return PREVIEW.live[featureKey] === true || PREVIEW.flags[featureKey] === true;
    }
    return gate.live === true;
  }

  function badgeCardsOn() {
    return cardGateOn(cfg.badgeCards, 'az_bestseller_badge');
  }

  function boughtCardsOn() {
    return cardGateOn(cfg.boughtCards, 'az_bought_count');
  }

  function cardFlagInCheckout() {
    try {
      if (window.Shopify && window.Shopify.Checkout) return true;
      var path = window.location && typeof window.location.pathname === 'string' ? window.location.pathname : '';
      if (path.indexOf('/checkout') !== -1) return true;
    } catch (e) { /* noop */ }
    return false;
  }

  function cardFlagHandle(href) {
    // /products/<handle> extraction — locale prefixes (/fr/products/x),
    // collection-scoped urls (/collections/y/products/x) and trailing
    // query/fragment/variant segments all tolerated.
    if (typeof href !== 'string' || !href) return '';
    var path = href.split('#')[0].split('?')[0];
    var m = /\/products\/([A-Za-z0-9_-]+)/.exec(path);
    return m ? m[1].toLowerCase() : '';
  }

  // Sleepify card containers (docs/theme-integration.md + the theme
  // sources): `.product--default .product__image` is the standard card
  // image block (collections, home sliders, search, related);
  // `.boost-pfs-filter-product-item-image` is the Boost PFS filtered
  // collection grid. Anything else: graceful no-op. Our own widgets
  // never render these theme classes, so they cannot double-flag.
  var CARD_FLAG_CONTAINERS = '.product--default .product__image, .boost-pfs-filter-product-item-image';

  function cardFlagAnchors() {
    var out = [];
    var boxes;
    try { boxes = document.querySelectorAll(CARD_FLAG_CONTAINERS); } catch (e) { return out; }
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      try {
        if (box.getAttribute('data-cx-cardflag') !== null) continue; // idempotent
        var link = box.querySelector('a[href*="/products/"]');
        if (!link) continue;
        var handle = cardFlagHandle(link.getAttribute('href'));
        if (!handle) continue;
        out.push({ box: box, handle: handle });
      } catch (e2) { /* skip this card, never break the loop */ }
    }
    return out;
  }

  function cardFlagHash(str) {
    // djb2 (unsigned) — tiny and stable; the locale rides the key
    // verbatim, the hash only compresses the handle batch.
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = (h * 33 + str.charCodeAt(i)) >>> 0;
    return String(h);
  }

  function cardFlagCacheKey(handles) {
    var locale = typeof cfg.pageLocale === 'string' ? cfg.pageLocale : '';
    // v6.6 bumped the map-entry shape ({badge, bought}) — the "2"
    // segment retires v6.4 {rank, category} cache entries wholesale.
    return 'cx_az_cardflags:2:' + locale + ':' + cardFlagHash(handles.slice().sort().join(','));
  }

  function cardFlagCacheGet(key) {
    try {
      var store = window.sessionStorage;
      if (!store) return null;
      var raw = store.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.t !== 'number') return null;
      if (Date.now() - parsed.t > 600000) return null; // 10-minute TTL
      return parsed.map && typeof parsed.map === 'object' ? parsed.map : null;
    } catch (e) { return null; }
  }

  function cardFlagCachePut(key, map) {
    try {
      var store = window.sessionStorage;
      if (store) store.setItem(key, JSON.stringify({ t: Date.now(), map: map }));
    } catch (e) { /* quota/private mode: the cache is best-effort */ }
  }

  function cardFlagFetch(handles) {
    return fetchJSON(routeRoot() + 'apps/cellexia/cart-data?handles=' + encodeURIComponent(handles.join(',')), { headers: { Accept: 'application/json' } })
      .then(function (data) {
        var by = data && data.productsByHandle && typeof data.productsByHandle === 'object' ? data.productsByHandle : {};
        var map = {};
        // Every REQUESTED handle gets a verdict (null = nothing to
        // render) so an unknown product converges to the "0" mark
        // instead of being re-asked on every later pass.
        for (var i = 0; i < handles.length; i++) map[handles[i]] = null;
        Object.keys(by).forEach(function (handle) {
          var entry = by[handle];
          var b = entry && entry.bestseller;
          var badge = b && typeof b === 'object' && typeof b.rank === 'number' && b.rank > 0 &&
            typeof b.category === 'string' && b.category
            ? { rank: b.rank, category: b.category }
            : null;
          // "bought" is present ONLY when the proxy's Liquid freshness
          // gate passed (same 3 888 000 s epoch math as the PDP embed) —
          // absent/invalid means no line, ever.
          var bought = entry && typeof entry.bought === 'number' && isFinite(entry.bought) && entry.bought > 0
            ? Math.floor(entry.bought)
            : 0;
          map[handle] = badge || bought > 0 ? { badge: badge, bought: bought } : null;
        });
        return map;
      });
  }

  function buildCardFlag(badge) {
    // Compact overlay flag: localized "#N Bestseller" pill + the (already
    // localized) category riding beneath it. textContent only.
    if (!azStr('amazon.bestseller')) return null;
    var txt = t('amazon.bestseller', { rank: badge.rank });
    if (!txt || typeof txt !== 'string') return null;
    var root = el('span', 'cx-az-cardflag cx-az-cardflag--overlay');
    root.appendChild(el('span', 'cx-az-cardflag__pill', txt));
    root.appendChild(el('span', 'cx-az-cardflag__cat', badge.category));
    return root;
  }

  function azPageLocale() {
    // Cart-side shim so the azCompact TWIN below stays byte-identical to
    // the cellexia-pdp.js original (which resolves its az config island
    // the same way); this file's page locale rides the cart config.
    return cfg && typeof cfg.pageLocale === 'string' && cfg.pageLocale ? cfg.pageLocale : '';
  }

  // v6.6 TWIN: azCompact is BYTE-IDENTICAL to cellexia-pdp.js#azCompact
  // (twin convention — the harness compares the two blocks byte-for-byte;
  // edit BOTH files or neither). It carries the da/fi/hu grouped-digit
  // opt-out and the honesty pre-floor.
  function azCompact(n) {
    // "{n}+ bought" compact figure in the PAGE locale. The "+" claims
    // AT LEAST the shown figure, so the value is floored to the
    // compact precision before formatting (1 940 -> "1K", never "2K");
    // roundingMode floor is passed for locales whose compact unit
    // differs (ja 万) — older engines ignore the unknown option, and
    // the pre-floor keeps the common Latin K/M case honest everywhere.
    var anchor = n;
    if (n >= 1000000) anchor = Math.floor(n / 1000000) * 1000000;
    else if (n >= 1000) anchor = Math.floor(n / 1000) * 1000;
    // Per-locale readability opt-out: the CLDR short-compact unit is
    // cryptic/ambiguous in a trust claim for da ("2 t+" — t also means
    // hours), fi ("2 t.+") and hu ("2 E+"), so below 10 000 those pages
    // get plain grouped digits ("2 000+") instead; from 10 000 up the
    // longer figure gives the unit enough context. Honesty unchanged —
    // the anchor is already floored above.
    var azLang = (azPageLocale() || '').split('-')[0].toLowerCase();
    if ((azLang === 'da' || azLang === 'fi' || azLang === 'hu') && anchor < 10000) {
      try {
        var grouped = new Intl.NumberFormat(azPageLocale(), { maximumFractionDigits: 0 }).format(anchor);
        if (typeof grouped === 'string' && grouped) return grouped;
      } catch (e0) { /* fall through to compact */ }
    }
    try {
      var opts = { notation: 'compact', maximumFractionDigits: 0, roundingMode: 'floor' };
      var s = new Intl.NumberFormat(azPageLocale() || undefined, opts).format(anchor);
      if (typeof s === 'string' && s) return s;
    } catch (e) { /* fall through */ }
    try {
      var s2 = new Intl.NumberFormat(azPageLocale() || undefined, { notation: 'compact', maximumFractionDigits: 0 }).format(anchor);
      if (typeof s2 === 'string' && s2) return s2;
    } catch (e2) { /* fall through */ }
    return String(anchor);
  }

  function cardBoughtLabel(n) {
    // Bought line text: CLDR plural category in the PAGE language via
    // Intl.PluralRules on the RAW count (azCtaLabel's exact ladder), the
    // figure itself compacted by the azCompact twin. The Liquid config
    // ships one string per category ("amazon.bought_count.<cat>",
    // sentinel @@N@@); categories a language does not define arrive as
    // "Translation missing" markers and azStr discards them. Without a
    // usable "other" the line is unbuildable: null (fail closed).
    if (!azStr('amazon.bought_count.other')) return null;
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return null;
    var locale = typeof cfg.pageLocale === 'string' && cfg.pageLocale ? cfg.pageLocale : undefined;
    var cat = 'other';
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function') {
        cat = new Intl.PluralRules(locale).select(n);
      } else {
        cat = n === 1 ? 'one' : 'other';
      }
    } catch (e) {
      try { cat = new Intl.PluralRules().select(n); } catch (e2) { cat = n === 1 ? 'one' : 'other'; }
    }
    if (!azStr('amazon.bought_count.' + cat)) cat = 'other';
    var compact = azCompact(n);
    if (!compact || typeof compact !== 'string') return null;
    return t('amazon.bought_count.' + cat, { n: compact });
  }

  function buildCardBought(n) {
    var label = cardBoughtLabel(n);
    if (!label || typeof label !== 'string') return null;
    // Block line, textContent only — normal flow, no absolute
    // positioning, so the card grid never shifts badly.
    return el('p', 'cx-az-cardbought', label);
  }

  function swapThemeTag(box) {
    // v6.6 replacement rule: OUR flag now owns the image corner, so the
    // theme's own .product__tag pill (or a POPULATED .badges overlay —
    // the always-present EMPTY .badges container is left alone) is
    // hidden with the cx-az-tagswap class (CSS: display none). Called
    // ONLY right after a flag insertion on the same card — a card whose
    // flag did not render keeps its theme tag untouched, and gates-off
    // pages never reach this code at all.
    try {
      var tag = box.querySelector('.product__tag');
      if (!tag) {
        var badges = box.querySelector('.badges');
        if (badges && badges.children && badges.children.length) tag = badges;
      }
      if (tag && tag.classList) tag.classList.add('cx-az-tagswap');
    } catch (e) { /* best-effort: worst case the two badges stack */ }
  }

  function insertCardBought(box, line) {
    // Sleepify card anatomy (captured live collection markup):
    // .product.product--default > .product__image (our anchor box) +
    // .product__info (title/blurb/price/stars). The line lands at the
    // END of .product__info — under the card's title/price; grids
    // without that container (Boost PFS boxes, future themes) get it
    // right after the image box instead. Returns true only when the
    // line actually entered the DOM.
    try {
      var root = null;
      var n = box;
      for (var i = 0; i < 4 && n; i++) {
        if (n.classList && n.classList.contains('product--default')) { root = n; break; }
        n = n.parentNode;
      }
      var info = root ? root.querySelector('.product__info') : null;
      if (info) {
        info.appendChild(line);
        return true;
      }
      if (box.parentNode) {
        if (box.nextSibling) box.parentNode.insertBefore(line, box.nextSibling);
        else box.parentNode.appendChild(line);
        return true;
      }
    } catch (e) { /* fail closed */ }
    return false;
  }

  function decorateCardFlags(anchors, map) {
    // v6.6: ONE pass decides BOTH card elements from the merged verdict
    // ({badge, bought} | null). The bestseller flag applies the
    // replacement rule (swapThemeTag in the SAME pass as the insertion,
    // never without it — the v6.4.1 theme-tag SKIP is retired); the
    // bought line rides under the card's product info. Re-passes stay
    // idempotent via the data-cx-cardflag mark; a Boost grid re-render
    // rebuilds cards from scratch, so a re-added theme tag is re-swapped
    // exactly when our flag re-renders on the fresh node.
    var wantBadge = badgeCardsOn() && !!azStr('amazon.bestseller');
    var wantBought = boughtCardsOn() && !!azStr('amazon.bought_count.other');
    if (!wantBadge && !wantBought) return;
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      try {
        if (anchor.box.getAttribute('data-cx-cardflag') !== null) continue; // re-entry safety
        var verdict = map && Object.prototype.hasOwnProperty.call(map, anchor.handle) ? map[anchor.handle] : null;
        if (!verdict) { anchor.box.setAttribute('data-cx-cardflag', '0'); continue; }
        var did = false;
        if (wantBadge && verdict.badge) {
          var node = buildCardFlag(verdict.badge);
          if (node) {
            try {
              // the overlay needs a positioned ancestor; the theme's image
              // block usually is one already (its own badges overlay too).
              if (typeof window.getComputedStyle === 'function') {
                var st = window.getComputedStyle(anchor.box);
                if (st && st.position === 'static') anchor.box.style.position = 'relative';
              }
            } catch (e0) { /* best-effort */ }
            anchor.box.appendChild(node);
            did = true;
            // replacement rule: hide the theme's pill ONLY now that our
            // flag is actually in this card's DOM.
            swapThemeTag(anchor.box);
          }
        }
        if (wantBought && verdict.bought > 0) {
          var line = buildCardBought(verdict.bought);
          if (line && insertCardBought(anchor.box, line)) did = true;
        }
        anchor.box.setAttribute('data-cx-cardflag', did ? '1' : '0');
      } catch (e) { /* skip this card */ }
    }
  }

  function cardFlagKnown(handle) {
    return cardFlagMap !== null && Object.prototype.hasOwnProperty.call(cardFlagMap, handle);
  }

  function mergeCardFlagMap(map) {
    if (!map || typeof map !== 'object') return;
    if (cardFlagMap === null) cardFlagMap = {};
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) cardFlagMap[k] = map[k];
    }
  }

  function cardFlagPass(decorateOnly) {
    // One pass = scan the CURRENT DOM (never captured nodes — Boost PFS
    // may have replaced the grid since any earlier scan), decorate every
    // anchor whose verdict the merged map already holds, then — unless
    // decorateOnly — resolve the still-unknown handles: per-batch
    // sessionStorage cache first, one budgeted network fetch otherwise.
    var anchors = cardFlagAnchors();
    if (!anchors.length) return;
    var known = [];
    var unknown = [];
    var seen = {};
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      if (cardFlagKnown(anchor.handle)) { known.push(anchor); continue; }
      if (cardFlagPending[anchor.handle]) continue; // an in-flight fetch owns it
      if (!seen[anchor.handle]) { seen[anchor.handle] = true; unknown.push(anchor.handle); }
    }
    if (known.length) decorateCardFlags(known, cardFlagMap);
    if (decorateOnly || !unknown.length) return;
    var handles = unknown.slice(0, 20); // the proxy's own batch cap
    var key = cardFlagCacheKey(handles);
    var cached = cardFlagCacheGet(key);
    if (cached) {
      mergeCardFlagMap(cached);
      cardFlagPass(true); // decorate-only recursion: no fetch, no loop
      return;
    }
    if (cardFlagFetches >= CARD_FLAG_FETCH_MAX) return; // budget spent — leave untouched
    cardFlagFetches++;
    var j;
    for (j = 0; j < handles.length; j++) cardFlagPending[handles[j]] = true;
    cardFlagFetch(handles)
      .then(function (map) {
        cardFlagCachePut(key, map);
        mergeCardFlagMap(map);
        for (var j2 = 0; j2 < handles.length; j2++) delete cardFlagPending[handles[j2]];
        // Fresh re-scan at resolve time: if Boost re-rendered while the
        // request was in flight, the captured anchors are detached — the
        // new scan decorates the LIVE cards from the merged map.
        cardFlagPass(true);
      })
      .catch(function () {
        // fail closed: cards stay untouched (the budget slot stays spent).
        for (var j3 = 0; j3 < handles.length; j3++) delete cardFlagPending[handles[j3]];
      });
  }

  function setupCardFlagObserver() {
    // Boost PFS re-renders the collection grid client-side (skeletons ->
    // cards on load, full grid swap on every filter/sort/pagination) and
    // slick clones carousel cards after boot — a debounced document-level
    // childList observer re-runs the pass so decorations survive. The
    // data-cx-cardflag marks make every re-entry idempotent, and passes
    // beyond the network budget decorate purely from the merged map.
    if (typeof MutationObserver !== 'function') return;
    if (!document.body) return;
    var timer = null;
    var observer = new MutationObserver(function (records) {
      // Skip wakeups our own decoration caused: batches whose added
      // elements are all our own card nodes (cx-az-cardflag overlays or
      // cx-az-cardbought lines — the shared cx-az-card prefix) need no
      // re-scan.
      var relevant = false;
      try {
        for (var i = 0; i < records.length && !relevant; i++) {
          var added = records[i].addedNodes;
          if (!added) continue;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (!node || node.nodeType !== 1) continue;
            var cls = typeof node.className === 'string' ? node.className : '';
            if (cls.indexOf('cx-az-card') !== -1) continue;
            relevant = true;
            break;
          }
        }
      } catch (e) { relevant = true; }
      if (!relevant) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        timer = null;
        try { cardFlagPass(false); } catch (e2) { /* never break the theme */ }
      }, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function initCardFlags() {
    // Boot once per page: gates first (fail closed, zero DOM writes on any
    // miss), then an initial pass, then the re-scan observer. Network is
    // capped at CARD_FLAG_FETCH_MAX batched proxy calls per page; every
    // later re-render decorates from the in-memory/sessionStorage map.
    try {
      if (cardFlagsBooted) return;
      cardFlagsBooted = true;
      if (cardFlagInCheckout()) return;
      // v6.6: boot when EITHER card element is renderable — gate on AND
      // usable strings per element (an element whose gate or strings
      // fail simply never renders; both failing = zero DOM writes).
      var wantBadge = badgeCardsOn() && !!azStr('amazon.bestseller');
      var wantBought = boughtCardsOn() && !!azStr('amazon.bought_count.other');
      if (!wantBadge && !wantBought) return;
      if (!window.fetch || typeof Promise === 'undefined') return;
      cardFlagMap = {};
      cardFlagPass(false);
      setupCardFlagObserver();
    } catch (e) { /* never break the theme */ }
  }

  function renderAll() {
    try {
      var drawerRoot = ensureDrawerRoot();
      if (drawerRoot) {
        var drawerFeatures = renderInto(drawerRoot, 'drawer');
        fireDrawerImpressions(drawerFeatures);
      }
      var pageRoot = ensurePageRoot();
      if (pageRoot) {
        var pageFeatures = renderInto(pageRoot, 'page');
        firePageImpressions(pageFeatures);
      }
      decorateSubscriptionRows();
      decorateCtaButtons();
    } catch (e) { /* never break the theme */ }
  }

  // -------------------------------------------------------------- observers

  function setupObservers() {
    if (typeof MutationObserver !== 'function') return;
    var mini = document.querySelector('.mini-cart');
    if (mini) {
      var classObserver = new MutationObserver(function () {
        var open = mini.classList.contains('is-open');
        if (open && !state.wasOpen) {
          state.openImpressions = {};
          if (state.themeStale) {
            // A quiet refresh left the theme's list stale — rebuild it now
            // that the drawer is open (showMini() is a no-op on an already
            // open drawer, so this can't fight the buyer).
            var staleCart = state.themeStale;
            state.themeStale = null;
            try {
              if (typeof window.refreshMiniCart === 'function') {
                window.refreshMiniCart(staleCart);
                // The rebuilt rows need their remove-subscription buttons
                // back immediately (idempotent; observer re-runs it too).
                decorateSubscriptionRows();
              }
            } catch (e) { /* noop */ }
          }
          scheduleRefresh();
        }
        state.wasOpen = open;
      });
      classObserver.observe(mini, { attributes: true, attributeFilter: ['class'] });
      state.wasOpen = mini.classList.contains('is-open');
    }
    var list = document.querySelector('.mini-cart__list');
    if (list) {
      var listObserver = new MutationObserver(function () {
        // Decorate immediately with the cart we already hold (mutation
        // handlers update state.cart before the theme re-renders), then let
        // the debounced refresh reconcile with a fresh cart fetch.
        decorateSubscriptionRows();
        scheduleRefresh();
      });
      listObserver.observe(list, { childList: true });
    }
  }

  // ---------------------------------------------------------- preview boot

  function clearPreviewSession() {
    try {
      window.sessionStorage.removeItem('cx_preview_token');
      window.sessionStorage.removeItem('cx_preview_market');
      window.sessionStorage.removeItem('cx_preview_ok');
      window.sessionStorage.removeItem('cx_preview_tagged');
    } catch (e) { /* noop */ }
  }

  // v4.6: keep the preview cart tagged so ANY route into checkout (drawer
  // button, /cart page, direct /checkout) carries the `_cx_preview`
  // attribute the checkout extensions verify — not just the hub's button.
  // The attribute value is the token HASH (server-computed, returned by
  // preview-config to verified sessions); extensions compare it with plain
  // string equality. Fire-and-forget; a failed tag just means the merchant
  // falls back to the hub button.
  function setPreviewCartTag(value, keepalive) {
    try {
      if (!window.fetch) return;
      window.fetch(routeRoot() + 'cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ attributes: { _cx_preview: value } }),
        keepalive: keepalive === true
      }).catch(function () { /* fire and forget */ });
    } catch (e) { /* never break the theme */ }
  }

  function ensurePreviewCartTag(tokenHash) {
    if (typeof tokenHash !== 'string' || !tokenHash) return;
    try {
      var store = window.sessionStorage;
      if (store && store.getItem('cx_preview_tagged') === tokenHash) return;
      setPreviewCartTag(tokenHash, false);
      if (store) store.setItem('cx_preview_tagged', tokenHash);
    } catch (e) { /* noop */ }
  }

  function fireMissedSessionBeacon() {
    // FINDING 10: this browser held a stale preview token, so the entry
    // page's cx_preview_ok flag suppressed the inline session beacon. The
    // server just ruled the token authoritatively invalid — this is a REAL
    // visitor whose session must be counted. Same dedupe + write-check as
    // the inline beacon; PREVIEW is null and BEACONS_OFF is false on this
    // path, so track() actually sends (feature 'site', type 'session',
    // market/currency added by track itself).
    try {
      var store = window.sessionStorage;
      if (!store || store.getItem('cx_session_sent')) return;
      store.setItem('cx_session_sent', '1');
      if (store.getItem('cx_session_sent') !== '1') return; // write silently dropped
    } catch (e) { return; }
    track('site', 'session');
  }

  function injectPreviewBar() {
    try {
      if (document.getElementById('cx-preview-bar')) return; // once per page
      var bar = el('div', 'cx-preview-bar');
      bar.id = 'cx-preview-bar';
      bar.setAttribute('role', 'status');
      bar.appendChild(el('span', 'cx-preview-bar__label', 'Cellexia preview — visible only to you'));
      bar.appendChild(el('span', 'cx-preview-bar__chip', PREVIEW && PREVIEW.market ? PREVIEW.market : 'current market'));
      var exit = el('button', 'cx-preview-bar__exit', 'Exit preview');
      exit.type = 'button';
      exit.addEventListener('click', function () {
        // Best-effort untag (keepalive survives the reload) so the
        // merchant's next REAL checkout from this browser carries no
        // preview attribute at all.
        setPreviewCartTag('', true);
        clearPreviewSession();
        window.location.reload();
      });
      bar.appendChild(exit);
      if (document.body && !document.getElementById('cx-preview-bar')) {
        document.body.appendChild(bar);
      }
    } catch (e) { /* never break the theme */ }
  }

  function boot() {
    // Triple gate: sessionStorage token + Liquid-armed + server-verified.
    // Any miss falls straight through to init() — the exact pre-v4 path.
    var token = null;
    try {
      token = window.sessionStorage ? window.sessionStorage.getItem('cx_preview_token') : null;
    } catch (e) { token = null; }
    var armed = !!(cfg.preview && cfg.preview.armed === true);
    if (!token || !armed || !window.fetch) {
      init();
      return;
    }
    // Verify server-side BEFORE the first render so no impression beacon
    // can fire ahead of the preview verdict.
    var url = routeRoot() + 'apps/cellexia/preview-config?t=' + encodeURIComponent(token);
    window.fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().then(function (data) { return { status: res.status, body: data }; });
      })
      .then(function (out) {
        if (out.status === 200 && out.body && out.body.valid === true) {
          var data = out.body;
          PREVIEW = {
            flags: data.draftFlags && typeof data.draftFlags === 'object' ? data.draftFlags : {},
            live: data.liveEffectiveForMarket && typeof data.liveEffectiveForMarket === 'object' ? data.liveEffectiveForMarket : {},
            market: typeof data.simulatedMarket === 'string' && data.simulatedMarket ? data.simulatedMarket : ''
          };
          try { window.sessionStorage.setItem('cx_preview_ok', '1'); } catch (e) { /* noop */ }
          injectPreviewBar();
          // v4.6: auto-tag the cart with the server-supplied token hash so
          // every path into checkout previews the checkout blocks too.
          ensurePreviewCartTag(typeof data.tokenHash === 'string' ? data.tokenHash : '');
        } else if (out.status === 200 && out.body && out.body.valid === false) {
          // Authoritative verdict: rotated/disarmed token — back to normal,
          // and count the session the inline beacon skipped (FINDING 10).
          // Also untag the cart so the stale attribute doesn't linger on a
          // real visitor's future orders (webhook tolerates it, hygiene).
          setPreviewCartTag('', false);
          clearPreviewSession();
          fireMissedSessionBeacon();
        } else {
          // Indeterminate (unexpected status/body): fail SAFE — keep the
          // token for retry, render live-normal, ship no beacons (FINDING 11).
          BEACONS_OFF = true;
        }
        init();
      })
      .catch(function () {
        // Network trouble / unparseable body: fail SAFE — keep the token,
        // render live-normal, ship no beacons (FINDING 11).
        BEACONS_OFF = true;
        init();
      });
  }

  // ------------------------------------------------------------------ init

  function anyEffectiveLive() {
    var keys = Object.keys(EFFECTIVE);
    for (var i = 0; i < keys.length; i++) {
      if (EFFECTIVE[keys[i]]) return true;
    }
    return false;
  }

  function init() {
    window.CellexiaBooster = window.CellexiaBooster || {};
    window.CellexiaBooster.__cartInit = true;
    // v6.4: the site-wide bestseller card decorator runs STANDALONE —
    // before (and independent of) the cart-runtime bail below, so a
    // badge-only configuration never boots the cart machinery (no cart
    // fetch, no observers) and a cart-only configuration never scans
    // cards. Beacon-free, self-gated, fail closed.
    initCardFlags();
    // FINDINGS 9+12: the block can render for draft-only reasons (armed
    // preview, live master off) or with every cart widget scoped out of
    // this market. Real visitors then have zero live widgets — skip the
    // whole runtime (no cart fetch, no product-data fetch, no observers,
    // no root injection, nothing registered) while keeping the __cartInit
    // guard. Verified preview sessions (PREVIEW set) still boot fully.
    if (!PREVIEW && !anyEffectiveLive()) return;
    setupObservers();
    refresh();
    window.CellexiaBooster.refreshCart = scheduleRefresh;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
