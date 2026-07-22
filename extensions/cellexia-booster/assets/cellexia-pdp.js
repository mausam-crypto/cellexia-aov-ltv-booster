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

  // ------------------------------------------------- entity decode (v4.5)
  //
  // Shopify's Liquid `t` filter HTML-escapes translated strings (every key
  // not ending in _html). v4.5 AUDIT of this file: every translated string
  // on the PDP is server-rendered inside the <template> fragments (entities
  // are correct in HTML context and the fragments are cloned as DOM nodes),
  // the #cx-pdp-config JSON carries no t-filtered strings (only b2b /
  // currency / placement / preview), the preview-bar strings are JS
  // literals, and data-cx-market is decoded by the HTML parser before
  // getAttribute returns it — so no t-filtered string reaches textContent
  // in this file today. The helper mirrors cellexia-cart.js so any future
  // JS-composed translated string is decoded at its consumption point. The
  // detached <textarea> is an RCDATA element: parsing its content decodes
  // character references but can never create elements or execute scripts.
  // Decoded strings must only ever reach textContent, never innerHTML.
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

  function track(feature, type) {
    if (PREVIEW || BEACONS_OFF) return; // preview/indeterminate-verdict mode: suppress every beacon — no data pollution
    try {
      var payload = { feature: feature, type: type || 'impression' };
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

  // ------------------------------------------ guarantee-check modal (v4.9)
  //
  // The empty-bottle-guarantee widget's "Guarantee check" button opens an
  // in-page modal cloned from the hidden, server-translated
  // #cx-tpl-guarantee-check template (no navigation, no external URL).
  // Lightweight accessible dialog: role="dialog"/aria-modal/aria-labelledby
  // live in the template markup; JS adds focus handling (move to the card
  // on open, back to the trigger on close), a minimal Tab loop over the
  // card's focusable elements, ESC + backdrop + close-button dismissal and
  // a body scroll lock. Singleton — guarded by the #cx-gcheck id.
  var gcheckState = null; // { root, trigger, prevOverflow, onKeydown } while open

  function gcheckFocusables(card) {
    var out = [];
    try {
      var nodes = card.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]'
      );
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute('tabindex') === '-1') continue;
        out.push(nodes[i]);
      }
    } catch (e) { /* noop */ }
    return out;
  }

  function gcheckClose() {
    var state = gcheckState;
    if (!state) return;
    gcheckState = null;
    try { document.removeEventListener('keydown', state.onKeydown, true); } catch (e) { /* noop */ }
    try {
      if (state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root);
    } catch (e) { /* noop */ }
    try { document.body.style.overflow = state.prevOverflow; } catch (e) { /* noop */ }
    try {
      if (state.trigger && state.trigger.focus) state.trigger.focus();
    } catch (e) { /* noop */ }
  }

  function gcheckOpen(trigger) {
    try {
      if (gcheckState || document.getElementById('cx-gcheck')) return; // singleton
      var tpl = document.getElementById('cx-tpl-guarantee-check');
      if (!tpl || !tpl.content) return;
      var root = tpl.content.cloneNode(true).firstElementChild;
      if (!root) return;
      root.id = 'cx-gcheck';
      var card = root.querySelector('.cx-guarantee-modal__card') || root;

      var onKeydown = function (event) {
        if (event.key === 'Escape' || event.key === 'Esc') {
          event.preventDefault();
          gcheckClose();
          return;
        }
        if (event.key !== 'Tab') return;
        var items = gcheckFocusables(card);
        if (items.length === 0) {
          event.preventDefault();
          try { card.focus(); } catch (e) { /* noop */ }
          return;
        }
        var active = document.activeElement;
        if (event.shiftKey) {
          if (active === items[0] || !root.contains(active)) {
            event.preventDefault();
            try { items[items.length - 1].focus(); } catch (e) { /* noop */ }
          }
        } else if (active === items[items.length - 1] || !root.contains(active)) {
          event.preventDefault();
          try { items[0].focus(); } catch (e) { /* noop */ }
        }
      };

      root.addEventListener('click', function (event) {
        var el = event.target;
        while (el && el !== root && el.nodeType === 1) {
          if (el.hasAttribute && el.hasAttribute('data-cx-gcheck-close')) {
            gcheckClose();
            return;
          }
          el = el.parentNode;
        }
      });

      var prevOverflow = '';
      try { prevOverflow = document.body.style.overflow || ''; } catch (e) { /* noop */ }
      document.body.appendChild(root);
      try { document.body.style.overflow = 'hidden'; } catch (e) { /* noop */ }
      document.addEventListener('keydown', onKeydown, true);
      gcheckState = {
        root: root,
        trigger: trigger && trigger.focus ? trigger : null,
        prevOverflow: prevOverflow,
        onKeydown: onKeydown
      };
      try { card.focus(); } catch (e) { /* noop */ }
      // Click beacon — track() already suppresses it in preview /
      // indeterminate-verdict mode, so preview sessions stay silent.
      track('empty_bottle_guarantee', 'click');
    } catch (e) { /* never break the theme */ }
  }

  var gcheckBound = false;
  function bindGuaranteeCheck() {
    if (gcheckBound) return;
    gcheckBound = true;
    try {
      // Document-level delegation: the trigger button is cloned into the
      // proof stack after this script runs, so bind once on the document.
      document.addEventListener('click', function (event) {
        var el = event.target;
        while (el && el.nodeType === 1) {
          if (el.hasAttribute && el.hasAttribute('data-cx-guarantee-check')) {
            event.preventDefault();
            gcheckOpen(el);
            return;
          }
          el = el.parentNode;
        }
      });
    } catch (e) { /* noop */ }
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

  // ------------------------------------------- dispatch countdown (v5.0)
  //
  // "Order within Xh Ym for same-day dispatch" — REAL urgency only.
  // Liquid resolves the buyer country's schedule (cutoff "HH:MM" + IANA
  // WAREHOUSE timezone + ISO working days 1-7) into cfg.dispatch; this
  // engine decides VISIBILITY: shown only when today is a working day in
  // the warehouse timezone AND the cutoff is still ahead today AND no
  // more than showWithinHours remain. The clock suffix converts the
  // cutoff into the buyer's OWN timezone/locale (Date#toLocaleTimeString
  // on now + remaining — timezone-correct worldwide with no tz library).
  // Any invalid schedule, missing string or Intl throw (bad timezone)
  // hides the widget — fail closed, never fabricate urgency. ONE module
  // interval (guarded by dispatchTimer) re-evaluates the mounted node
  // each 30s tick — the widget hides itself the moment the cutoff passes
  // or the window is exceeded — and self-clears when none remain.
  var DISPATCH_ISO = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  var dispatchTimer = null;

  function dispatchT(key, params) {
    // Sentinel-param substitution over the #cx-pdp-config strings map
    // (mirrors cellexia-cart.js t(); '' — never the raw key — on a miss so
    // the caller can fail closed). Decode BEFORE substitution: the
    // @@TOKENS@@ are plain ASCII and params are JS-supplied numbers/times.
    var map = cfg && cfg.strings && typeof cfg.strings === 'object' ? cfg.strings : {};
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

  function dispatchSchedule() {
    var d = cfg.dispatch;
    if (!d || typeof d !== 'object') return null;
    if (typeof d.cutoff !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.cutoff)) return null;
    if (typeof d.timezone !== 'string' || !d.timezone) return null;
    if (!Array.isArray(d.days) || d.days.length === 0) return null;
    var within = Math.round(Number(d.showWithinHours));
    if (!(within >= 1 && within <= 24)) return null;
    var strings = cfg.strings;
    if (!strings || typeof strings !== 'object' ||
        typeof strings['dispatch.within'] !== 'string' ||
        typeof strings['dispatch.within_minutes'] !== 'string' ||
        typeof strings['dispatch.local_time'] !== 'string') return null;
    return {
      cutoffMinutes: Number(d.cutoff.slice(0, 2)) * 60 + Number(d.cutoff.slice(3, 5)),
      timezone: d.timezone,
      days: d.days,
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

  function dispatchSetText(node, remainingMs) {
    var totalMin = Math.floor(remainingMs / 60000);
    var text;
    if (totalMin >= 60) {
      text = dispatchT('dispatch.within', { hours: Math.floor(totalMin / 60), minutes: totalMin % 60 });
    } else {
      // Sub-hour reads more urgent; ceil so "0 minutes" can never render.
      text = dispatchT('dispatch.within_minutes', { minutes: Math.max(1, Math.ceil(remainingMs / 60000)) });
    }
    var main = node.querySelector('.cx-dispatch__main');
    if (main) main.textContent = text;
    var local = node.querySelector('.cx-dispatch__local');
    if (local) {
      var clock = '';
      try {
        clock = new Date(Date.now() + remainingMs)
          .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      } catch (e) { clock = ''; }
      local.textContent = clock ? dispatchT('dispatch.local_time', { time: clock }) : '';
    }
  }

  function dispatchTick() {
    // Re-run the WHOLE visibility computation for every mounted node —
    // no cached node or schedule state survives between ticks.
    var nodes = document.querySelectorAll('.cx-dispatch--pdp');
    if (!nodes.length) {
      if (dispatchTimer) { window.clearInterval(dispatchTimer); dispatchTimer = null; }
      return;
    }
    var schedule = dispatchSchedule();
    var remaining = schedule ? dispatchRemainingMs(schedule) : null;
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

  function mountDispatch() {
    // Injected directly after the .stock-msg row inside .pdp__grey
    // (fallback: after .pdp__actions--flex) — BEFORE the badge chain's
    // insertions, so it reads as part of the stock-message rhythm.
    // Graceful no-op when the anchors are missing.
    try {
      if (document.querySelector('.cx-dispatch--pdp')) return; // idempotent
      var schedule = dispatchSchedule();
      if (!schedule) return;
      var remaining = dispatchRemainingMs(schedule);
      if (remaining === null) return;
      var node = cloneTemplate('cx-tpl-dispatch', 'dispatch_countdown');
      if (!node) return;
      var grey = document.querySelector('.pdp__grey');
      if (!grey) return;
      var anchor = grey.querySelector('.stock-msg') || grey.querySelector('.pdp__actions--flex');
      if (!anchor || !insertAfter(node, anchor)) return;
      dispatchSetText(node, remaining);
      dispatchEnsureTimer();
      track('dispatch_countdown');
    } catch (e) { /* never break the theme */ }
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

      // --- dispatch countdown (v5.0), directly after .stock-msg ---
      mountDispatch();

      // --- SPEC v3 proof stack (has its own anchors + fallbacks) ---
      buildProofStack();

      // --- guarantee-check modal trigger (v4.9) ---
      bindGuaranteeCheck();
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
