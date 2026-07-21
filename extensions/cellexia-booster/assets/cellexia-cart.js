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

  function t(key, params) {
    var str = typeof STRINGS[key] === 'string' ? STRINGS[key] : key;
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

  function thresholdCents() {
    var cents = Number(cfg.thresholdCents);
    if (!(cents > 0)) {
      var mini = document.querySelector('section.mini-cart[data-freeship], .mini-cart[data-freeship]');
      if (mini) {
        var attr = Number(mini.getAttribute('data-freeship'));
        if (attr > 0) cents = attr;
      }
    }
    if (!(cents > 0)) cents = 15000;
    // The config/data-freeship threshold is in the SHOP's currency, but the
    // cart's items_subtotal_price is in the buyer's presentment currency —
    // convert so the comparison happens in presentment cents.
    var rate = 1;
    try {
      var r = Number(window.Shopify && window.Shopify.currency && window.Shopify.currency.rate);
      if (r > 0) rate = r;
    } catch (e) { /* noop */ }
    return Math.round(cents * rate);
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

  function findPlanForItem(item) {
    var product = productFor(item);
    if (!product || !Array.isArray(product.sellingPlanGroups) || product.sellingPlanGroups.length === 0) {
      return null;
    }
    var keyword = String(SETTINGS.sellingPlanKeyword || '').toLowerCase();
    var fallback = null;
    for (var g = 0; g < product.sellingPlanGroups.length; g++) {
      var group = product.sellingPlanGroups[g] || {};
      var plans = Array.isArray(group.plans) ? group.plans : [];
      for (var p = 0; p < plans.length; p++) {
        var plan = plans[p];
        if (!plan || !plan.id) continue;
        if (!fallback) fallback = plan;
        if (!keyword) continue;
        var groupName = String(group.name || '').toLowerCase();
        var planName = String(plan.name || '').toLowerCase();
        if (groupName.indexOf(keyword) !== -1 || planName.indexOf(keyword) !== -1) {
          return plan;
        }
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
        if (wasDrawerOpen && drawerIsOpen()) {
          themeRefresh(cart);
        } else {
          // Buyer closed the drawer mid-request — refresh quietly so the
          // theme's refreshMiniCart()/showMini() doesn't force it back open.
          quietRefresh(cart);
        }
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

  function performSubscribe(item, plan, sourceNode) {
    if (state.busy) return;
    // Capture context before renderAll() clears the widget roots and
    // detaches sourceNode.
    var onCartPage = isCartPageContext(sourceNode);
    var wasDrawerOpen = drawerIsOpen();
    state.busy = true;
    renderAll();
    cartRequest('cart/change.js', { id: item.key, selling_plan: plan.id })
      .then(function (cart) {
        state.cart = cart && cart.items ? cart : state.cart;
        state.busy = false;
        track('subscription_upsell', 'subscribe', {
          quantity: item.quantity,
          meta: { variant: item.variant_id, plan: plan.id }
        });
        if (onCartPage) {
          window.location.reload();
          return;
        }
        if (cart && cart.items) {
          if (wasDrawerOpen && drawerIsOpen()) {
            themeRefresh(cart);
          } else {
            // Buyer closed the drawer mid-request — refresh quietly so the
            // theme's refreshMiniCart()/showMini() doesn't force it back open.
            quietRefresh(cart);
          }
          setNotice('success', t('subscription.switched'));
        } else {
          refresh().then(function () { setNotice('success', t('subscription.switched')); });
        }
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

  function renderVolume(container) {
    if (!featureOn('volume') || !state.cart || !Array.isArray(state.cart.items)) return null;
    var rendered = false;
    state.cart.items.forEach(function (item) {
      var candidates = upgradeCandidates(item);
      if (!candidates.length) return;
      rendered = true;
      var box = el('div', 'cx-volume');
      box.setAttribute('data-cx-feature', 'cart_upsell');
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
      container.appendChild(box);
    });
    return rendered ? 'cart_upsell' : null;
  }

  function renderSubscriptionSwitch(container) {
    if (!featureOn('subscription') || isB2B()) return null;
    if (!state.cart || !Array.isArray(state.cart.items)) return null;
    var rendered = false;
    state.cart.items.forEach(function (item) {
      if (itemHasPlan(item)) return;
      var plan = findPlanForItem(item);
      if (!plan) return;
      rendered = true;
      var pct = planPercent(plan);
      var box = el('div', 'cx-subswitch');
      box.setAttribute('data-cx-feature', 'subscription_upsell');
      var title = cfg.overrides.subscriptionTitle || t('subscription.switch_title');
      var head = el('div', 'cx-subswitch__head d-flex align-center');
      head.appendChild(el('p', 'cx-subswitch__title heading--five', title));
      box.appendChild(head);
      box.appendChild(el('p', 'cx-subswitch__product', item.product_title || ''));
      box.appendChild(el('p', 'cx-subswitch__benefits', t('subscription.benefits', { percent: pct })));
      var cta = el('button', 'cx-subswitch__cta btn btn--secondary', t('subscription.switch_cta', { percent: pct }));
      cta.type = 'button';
      cta.disabled = state.busy;
      cta.addEventListener('click', function () {
        track('subscription_upsell', 'click', { meta: { plan: plan.id } });
        performSubscribe(item, plan, cta);
      });
      box.appendChild(cta);
      container.appendChild(box);
    });
    return rendered ? 'subscription_upsell' : null;
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
    f = renderVolume(root); if (f) features.push(f);
    f = renderSubscriptionSwitch(root); if (f) features.push(f);
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
        } else if (out.status === 200 && out.body && out.body.valid === false) {
          // Authoritative verdict: rotated/disarmed token — back to normal,
          // and count the session the inline beacon skipped (FINDING 10).
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
