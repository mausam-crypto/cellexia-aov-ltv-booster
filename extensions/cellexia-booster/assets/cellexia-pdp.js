/**
 * Cellexia AOV & LTV Booster — PDP auto-injection.
 *
 * Clones the server-rendered (fully translated) <template> fragments from the
 * pdp-booster app embed into the theme's PDP:
 *   - trust badges / guarantee / trustpilot: inside .pdp__grey after .stock-msg
 *   - subscription nudge: after the sm-rc-widget selling-plan container
 *   - SPEC v3 proof stack (derm survey, clinical study, verified B/A, batch
 *     transparency, empty bottle guarantee): built into a .cx-proof-stack
 *     container inserted before .pdp__tabs — or after it when the embed's
 *     placement setting is below_tabs — falling back to after section.pdp /
 *     .pdp, else a clean no-op. Templates are cloned in CRO order; one
 *     impression beacon fires per widget actually attached to the DOM.
 * Graceful no-op when any selector is missing. ES2019 IIFE, no globals except
 * window.CellexiaBooster.
 *
 * Market awareness: pdp-booster.liquid stamps the current market handle on
 * the #cx-pdp-config script tag as data-cx-market; every impression beacon
 * carries it (omitted when unknown). No scope logic lives in this file —
 * Liquid decides per market which templates exist at all.
 */
(function () {
  'use strict';

  if (window.CellexiaBooster && window.CellexiaBooster.__pdpInit) return;

  // Populated by boot()/init() from #cx-pdp-config (+ data-cx-market attribute).
  var cfg = {};

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

  function routeRoot() {
    try {
      if (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) {
        return window.Shopify.routes.root;
      }
    } catch (e) { /* noop */ }
    return '/';
  }

  function readConfig() {
    var el = document.getElementById('cx-pdp-config');
    if (!el) return {};
    var parsed = {};
    try {
      var raw = JSON.parse(el.textContent || '{}');
      if (raw && typeof raw === 'object') parsed = raw;
    } catch (e) { /* fall through with empty config */ }
    // Market handle precomputed by pdp-booster.liquid for beacon attribution.
    var market = el.getAttribute('data-cx-market');
    parsed.market = typeof market === 'string' ? market : '';
    return parsed;
  }

  function track(feature) {
    if (PREVIEW || BEACONS_OFF) return; // preview/indeterminate-verdict mode: suppress every beacon — no data pollution
    try {
      var payload = { feature: feature, type: 'impression' };
      if (cfg && typeof cfg.market === 'string' && cfg.market) {
        payload.market = cfg.market;
      }
      try {
        if (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) {
          payload.currency = window.Shopify.currency.active;
        }
      } catch (e) { /* noop */ }
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

  function widgetAllowed(tpl, featureKey) {
    var isDraft = tpl.getAttribute && tpl.getAttribute('data-cx-draft') === '1';
    if (!PREVIEW) {
      // Normal mode: armed-preview draft templates stay 100% inert. Live
      // templates behave exactly as before v4 (none carried the marker).
      return !isDraft;
    }
    // Preview mode: server-computed live-in-simulated-market ∪ draft flags
    // — exactly what going live would look like. No scope logic in JS.
    return PREVIEW.live[featureKey] === true || PREVIEW.flags[featureKey] === true;
  }

  function cloneTemplate(id, featureKey) {
    var tpl = document.getElementById(id);
    if (!tpl || !tpl.content) return null;
    if (!widgetAllowed(tpl, featureKey)) return null;
    try {
      var fragment = tpl.content.cloneNode(true);
      return fragment.firstElementChild || null;
    } catch (e) {
      return null;
    }
  }

  function insertAfter(node, reference) {
    if (!node || !reference || !reference.parentNode) return false;
    try {
      if (reference.nextSibling) {
        reference.parentNode.insertBefore(node, reference.nextSibling);
      } else {
        reference.parentNode.appendChild(node);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function isB2B(cfg) {
    return window.isB2BCustomer === true || cfg.b2b === true;
  }

  function productHasSellingPlans() {
    var selectors = document.querySelectorAll('select[sm-rc-plan-selector], [sm-rc-plan-selector]');
    for (var i = 0; i < selectors.length; i++) {
      var options = selectors[i].options;
      if (!options) continue;
      for (var j = 0; j < options.length; j++) {
        var value = String(options[j].value || '').trim();
        if (value !== '' && value.toLowerCase() !== 'false') return true;
      }
    }
    return false;
  }

  function planWidgetContainer() {
    var direct = document.querySelector('[sm-rc-widget]') ||
      document.querySelector('.sm-rc-widget') ||
      document.querySelector('sm-rc-widget');
    if (direct) return direct;
    var selector = document.querySelector('select[sm-rc-plan-selector], [sm-rc-plan-selector]');
    if (selector) {
      var host = selector.closest('[class*="sm-rc"], .pdp__plans, .pdp__options');
      if (host) return host;
      return selector.parentElement;
    }
    return null;
  }

  /**
   * SPEC v3 proof stack — template id / feature key pairs in CRO order.
   * Liquid only renders the templates that survived flag + market +
   * per-product + content gating, so a missing template simply skips.
   */
  var PROOF_ORDER = [
    ['cx-tpl-pdp-survey', 'derm_survey'],
    ['cx-tpl-pdp-study', 'clinical_study'],
    ['cx-tpl-pdp-ba', 'verified_before_after'],
    ['cx-tpl-pdp-batch', 'batch_transparency'],
    ['cx-tpl-pdp-bottle', 'empty_bottle_guarantee']
  ];

  function buildProofStack() {
    try {
      if (document.querySelector('.cx-proof-stack')) return; // idempotent

      var widgets = [];
      for (var i = 0; i < PROOF_ORDER.length; i++) {
        var node = cloneTemplate(PROOF_ORDER[i][0], PROOF_ORDER[i][1]);
        if (node) widgets.push({ node: node, feature: PROOF_ORDER[i][1] });
      }
      if (widgets.length === 0) return;

      var stack = document.createElement('div');
      // Reuse the theme's own container classes so the stack tracks the PDP
      // column (responsive max-widths + padding) at every breakpoint. The
      // stack is a sibling of .pdp__tabs (whose .container lives inside it),
      // so it never nests in another container — no double padding.
      stack.className = 'cx-proof-stack container container--md';
      for (var j = 0; j < widgets.length; j++) {
        stack.appendChild(widgets[j].node);
      }

      var below = cfg && cfg.placement === 'below_tabs';
      var placed = false;
      var tabs = document.querySelector('.pdp__tabs');
      if (tabs && tabs.parentNode) {
        if (below) {
          placed = insertAfter(stack, tabs);
        } else {
          try {
            tabs.parentNode.insertBefore(stack, tabs);
            placed = true;
          } catch (e) { placed = false; }
        }
      }
      if (!placed) {
        var pdp = document.querySelector('section.pdp') || document.querySelector('.pdp');
        if (pdp) placed = insertAfter(stack, pdp);
      }
      if (!placed) return; // final fallback: no-op, stack never attached

      // Beacons only after the stack is actually in the DOM.
      for (var k = 0; k < widgets.length; k++) {
        track(widgets[k].feature);
      }
    } catch (e) { /* never break the theme */ }
  }

  function init() {
    try {
      cfg = readConfig();

      // --- v1 widgets, anchored inside .pdp__grey ---
      var grey = document.querySelector('.pdp__grey');
      if (grey && grey.getAttribute('data-cx-pdp') !== '1') {
        grey.setAttribute('data-cx-pdp', '1'); // idempotent

        // --- badges + guarantee + trustpilot, chained after .stock-msg ---
        var anchor = grey.querySelector('.stock-msg') || grey.querySelector('.pdp__actions--flex');
        if (anchor) {
          var badges = cloneTemplate('cx-tpl-pdp-badges', 'trust_badges');
          if (badges && insertAfter(badges, anchor)) {
            anchor = badges;
            track('trust_badges');
          }
          var guarantee = cloneTemplate('cx-tpl-pdp-guarantee', 'guarantee');
          if (guarantee && insertAfter(guarantee, anchor)) {
            anchor = guarantee;
            track('guarantee');
          }
          var trustpilot = cloneTemplate('cx-tpl-pdp-trustpilot', 'trustpilot');
          if (trustpilot && insertAfter(trustpilot, anchor)) {
            track('trustpilot');
          }
        }

        // --- subscription nudge under the selling-plan widget ---
        if (!isB2B(cfg) && productHasSellingPlans()) {
          var container = planWidgetContainer();
          var nudge = cloneTemplate('cx-tpl-pdp-nudge', 'subscription_nudge');
          if (container && nudge && insertAfter(nudge, container)) {
            track('subscription_nudge');
          }
        }
      }

      // --- SPEC v3 proof stack (has its own anchors + fallbacks) ---
      buildProofStack();
    } catch (e) { /* never break the theme */ }

    window.CellexiaBooster = window.CellexiaBooster || {};
    window.CellexiaBooster.__pdpInit = true;
  }

  // ---------------------------------------------------------- preview boot

  function clearPreviewSession() {
    try {
      window.sessionStorage.removeItem('cx_preview_token');
      window.sessionStorage.removeItem('cx_preview_market');
      window.sessionStorage.removeItem('cx_preview_ok');
    } catch (e) { /* noop */ }
  }

  function injectPreviewBar() {
    try {
      if (document.getElementById('cx-preview-bar')) return; // once per page
      var bar = document.createElement('div');
      bar.id = 'cx-preview-bar';
      bar.className = 'cx-preview-bar';
      bar.setAttribute('role', 'status');
      var label = document.createElement('span');
      label.className = 'cx-preview-bar__label';
      label.textContent = 'Cellexia preview — visible only to you';
      bar.appendChild(label);
      var chip = document.createElement('span');
      chip.className = 'cx-preview-bar__chip';
      chip.textContent = PREVIEW && PREVIEW.market ? PREVIEW.market : 'current market';
      bar.appendChild(chip);
      var exit = document.createElement('button');
      exit.type = 'button';
      exit.className = 'cx-preview-bar__exit';
      exit.textContent = 'Exit preview';
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
    cfg = readConfig();
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
          // Authoritative verdict: rotated/disarmed token — back to normal.
          // The cart runtime owns the missed-session catch-up beacon.
          clearPreviewSession();
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
