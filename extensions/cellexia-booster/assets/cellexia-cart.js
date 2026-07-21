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
    trustRow: 'cart_trust_row'
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
    themeStale: null
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

  function upgradeCandidates(item) {
    if (!featureOn('volume')) return [];
    if (Number(item.quantity) !== 1) return [];
    var product = productFor(item);
    if (!product) return [];
    var current = currentVariant(product, item.variant_id);
    if (!current) return [];
    var currentPos = Number(current.position) || 0;
    var out = [];
    volumeOffers().forEach(function (offer) {
      var qty = Number(offer.quantity);
      if (qty <= currentPos) return;
      var tierVariant = variantByPosition(product, qty);
      if (!tierVariant || tierVariant.available === false) return;
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
        var subtotals = document.querySelectorAll('.mini-cart__footer .sub-total .total, .mini-cart__actions .btn span');
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
    cartRequest('cart/change.js', { id: item.key, quantity: 0 })
      .then(function () {
        return cartRequest('cart/add.js', addPayload).catch(function (err) {
          // Restore the original line so the buyer never silently loses items.
          var restore = { id: item.variant_id, quantity: item.quantity };
          if (sellingPlanId) restore.selling_plan = sellingPlanId;
          if (addPayload.properties) restore.properties = addPayload.properties;
          return cartRequest('cart/add.js', restore).then(function () { throw err; }, function () { throw err; });
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
        return ensureProductData(cart).then(function () {
          setNotice('success', t('volume.upgraded'));
        });
      })
      .catch(function () {
        state.busy = false;
        refresh().then(function () {
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
        setNotice('success', t('subscription.removed'));
      })
      .catch(function () {
        state.busy = false;
        refresh().then(function () {
          setNotice('error', t('subscription.error'));
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

  function renderShipbar(container) {
    if (!featureOn('shipbar') || !state.cart) return null;
    var goal = thresholdCents();
    if (!(goal > 0)) return null;
    var subtotal = Number(state.cart.items_subtotal_price) || 0;
    var wrap = el('div', 'cx-shipbar');
    wrap.setAttribute('data-cx-feature', 'free_shipping_bar');
    var msg = el('p', 'cx-shipbar__msg');
    if (subtotal >= goal) {
      wrap.className += ' cx-shipbar--unlocked';
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

  function renderTrustRow(container) {
    if (!featureOn('trustRow')) return null;
    var tpl = document.getElementById('cx-tpl-trust-row');
    if (!tpl || !tpl.content) return null;
    try {
      container.appendChild(tpl.content.cloneNode(true));
      return 'trust_badges';
    } catch (e) {
      return null;
    }
  }

  function renderInto(root, context) {
    if (!root) return [];
    root.textContent = '';
    if (state.busy) root.classList.add('cx-busy');
    else root.classList.remove('cx-busy');
    if (state.busy) root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');
    var features = [];
    renderNotice(root);
    var f;
    f = renderShipbar(root); if (f) features.push(f);
    var offerFeatures = renderOffers(root, context);
    for (var i = 0; i < offerFeatures.length; i++) features.push(offerFeatures[i]);
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
    // v4.7 per-line remove: after every theme re-render (refreshMiniCart
    // rebuilds the .product--cart rows from scratch, dropping anything we
    // added), inject a small "Remove subscription" text-button next to each
    // subscribed row's .delivery span — drawer rows and the cart page table
    // rows alike (wherever .delivery exists). Idempotent via the
    // data-cx-decorated marker; row -> cart line matching by data-varid +
    // selling-plan presence (first unused match); everything null-guarded.
    try {
      if (!featureOn('subscription')) return;
      // Never decorate mid-mutation: a button minted disabled would stay
      // disabled forever behind the idempotency marker. The completion
      // renderAll (setNotice / quietRefresh) runs this pass again with
      // busy=false immediately after.
      if (state.busy) return;
      if (!state.cart || !Array.isArray(state.cart.items)) return;
      var rows = document.querySelectorAll('.product--cart');
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
        btn.appendChild(document.createTextNode(' ' + t('subscription.remove')));
        (function (lineKey, node) {
          node.addEventListener('click', function () {
            performUnsubscribe(lineKey, node);
          });
        })(line.key, btn);
        if (delivery.nextSibling) delivery.parentNode.insertBefore(btn, delivery.nextSibling);
        else delivery.parentNode.appendChild(btn);
      }
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
