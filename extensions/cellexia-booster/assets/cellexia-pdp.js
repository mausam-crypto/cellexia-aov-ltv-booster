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

  // v6.1: two app embeds (pdp-booster + amazon-booster) both load this
  // asset with their own <script> tag when active together. The first
  // evaluation wins outright — the flag is set at load time (not in
  // init) so a second evaluation can never race the async preview boot
  // into a double fetch / double init.
  window.CellexiaBooster = window.CellexiaBooster || {};
  if (window.CellexiaBooster.__pdpLoaded) return;
  window.CellexiaBooster.__pdpLoaded = true;

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
  // in-page modal built by gcheckTplNode from the server-translated
  // #cx-bottle-config island (v6.7 — formerly cloned from the
  // cx-tpl-guarantee-check template; no navigation, no external URL).
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
      // v6.7: the modal body is JS-built from the #cx-bottle-config island
      // (gcheckTplNode) instead of cloned from the removed template — the
      // a11y wiring below is unchanged and works on the built node.
      var root = gcheckTplNode();
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
  // more than showWithinHours remain. The widget is a SINGLE line (v5.4:
  // the buyer-local clock suffix was removed on merchant request) — all
  // math still runs in the warehouse timezone, so it stays correct
  // worldwide with no tz library.
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
        typeof strings['dispatch.within_minutes'] !== 'string') return null;
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
      text = dispatchT('dispatch.within', { hours: Math.floor(totalMin / 60), minutes: totalMin % 60 });
    } else {
      // Sub-hour reads more urgent; ceil so "0 minutes" can never render.
      text = dispatchT('dispatch.within_minutes', { minutes: Math.max(1, Math.ceil(remainingMs / 60000)) });
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
    var nodes = document.querySelectorAll('.cx-dispatch--pdp');
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

  // v6.2 Liquid diet: the PDP dispatch shell (cx-tpl-dispatch) is JS-built
  // now — a 1:1 rebuild of the old template body; the ticking text still
  // lands exclusively via textContent from the frozen dispatch engine.
  // dispatchAllowed carries the exact cloneTemplate/widgetAllowed gate the
  // template used: live-effective for real visitors (server-computed
  // cfg.dispatch.live under the same show_dispatch/cx_draft_dispatch
  // emission gate), the verified live∪draft set inside a preview session.

  function dispatchAllowed() {
    if (PREVIEW) {
      return PREVIEW.live.dispatch_countdown === true || PREVIEW.flags.dispatch_countdown === true;
    }
    return !!(cfg && cfg.dispatch && cfg.dispatch.live === true);
  }

  function dispatchBuildNode() {
    var root = cxEl('div', 'cx-dispatch cx-dispatch--pdp', ['data-cx-feature', 'dispatch_countdown']);
    cxSp(root);
    root.appendChild(cxEl('span', 'cx-dispatch__dot', ['aria-hidden', 'true']));
    root.appendChild(cxIcon('truck', 16));
    var text = cxEl('span', 'cx-dispatch__text');
    text.appendChild(cxEl('strong', 'cx-dispatch__main'));
    root.appendChild(text);
    cxSp(root);
    return root;
  }

  function mountDispatch() {
    // Injected directly after the .stock-msg row inside .pdp__grey
    // (fallback: after .pdp__actions--flex) — BEFORE the badge chain's
    // insertions, so it reads as part of the stock-message rhythm.
    // Graceful no-op when the anchors are missing.
    try {
      if (document.querySelector('.cx-dispatch--pdp')) return; // idempotent
      if (PREVIEW) { mountDispatchPreview(); return; } // v5.3 merchant preview
      var schedule = dispatchSchedule();
      if (!schedule) return;
      var remaining = dispatchRemainingMs(schedule);
      if (remaining === null) return;
      if (!dispatchAllowed()) return; // live gate (v6.2 JS-built shell)
      var node = dispatchBuildNode();
      if (!node) return;
      var grey = document.querySelector('.pdp__grey');
      if (!grey) return;
      var anchor = grey.querySelector('.stock-msg') || grey.querySelector('.pdp__actions--flex');
      if (!anchor || !insertAfter(node, anchor)) return;
      dispatchSetText(node, remaining);
      dispatchEnsureTimer();
      // Impression honesty (v6.1): when az_delivery_line will replace
      // this widget later in the SAME task (removed before paint), no
      // beacon — a widget never seen must never be recorded as seen.
      if (!azReplacesDelivery()) track('dispatch_countdown');
    } catch (e) { /* never break the theme */ }
  }

  function mountDispatchPreview() {
    // v5.3 PREVIEW-only twin of the cart's renderDispatchPreview: same
    // anchor logic as the real mount, but the merchant always gets an
    // answer — the real countdown (plus a reassurance note), an
    // explained SAMPLE when the credibility engine hides it for real
    // visitors, or an invalid-config diagnostic. dispatchAllowed keeps
    // the full draft/preview gating (never weakened).
    if (!PREVIEW) return; // hard gate: never render for real visitors
    try {
      if (!dispatchAllowed()) return; // feature off (live∪draft in preview)
      var grey = document.querySelector('.pdp__grey');
      if (!grey) return;
      // Idempotency scoped to the PDP surface: the cart engine stamps the
      // same data-cx-note value on its own notes inside the (possibly
      // hidden) mini-cart drawer, and a document-wide query would let that
      // drawer note suppress the PDP mount entirely.
      if (grey.querySelector('[data-cx-note="dispatch"]')) return; // idempotent
      var anchor = grey.querySelector('.stock-msg') || grey.querySelector('.pdp__actions--flex');
      if (!anchor) return;
      var schedule = dispatchSchedule();
      var remaining = schedule ? dispatchRemainingMs(schedule) : null;
      var reason = schedule && remaining === null ? dispatchHiddenReason(schedule) : null;
      if (!schedule || (remaining === null && reason === null)) {
        // Invalid schedule/strings, or Intl rejected the timezone: no
        // widget — a diagnostic note only, never a fake countdown.
        var note = document.createElement('div');
        note.className = 'cx-preview-note cx-preview-note--warn';
        note.setAttribute('data-cx-note', 'dispatch');
        note.textContent = DISPATCH_PREVIEW_INVALID;
        insertAfter(note, anchor);
        return;
      }
      var node = dispatchBuildNode();
      if (!node) return;
      if (!insertAfter(node, anchor)) return;
      dispatchPreviewSync(node, schedule, remaining);
      dispatchEnsureTimer();
      track('dispatch_countdown'); // no-op in preview: beacons suppressed
    } catch (e) { /* never break the theme */ }
  }

  // ---------------------------------------------- delivery estimate (v5.9)
  //
  // PDP delivery estimator + DELIVERY GUARANTEE widget. Reuses the dispatch
  // schedule from the config (cutoff + IANA warehouse timezone + dispatch
  // days — warehouse facts that stay valid even while the dispatch_countdown
  // feature is off) to find the next dispatch DAY, then counts qualifying
  // delivery days in the DESTINATION country's calendar: a day qualifies
  // only when (a) its ISO weekday is in the resolved deliveryDays, (b) it is
  // not one of the four GLOBAL exclusions (Dec 24, Dec 25, Dec 31, Jan 1 —
  // always excluded, not configurable), and (c) when holidaysEnabled, it is
  // not a known public holiday of the destination country. The holiday
  // table is deliberately conservative — FIXED-DATE national holidays only;
  // movable feasts (Easter, Thanksgiving, Islamic holidays, …) are NOT
  // modeled — and is a byte-parity mirror of the canonical
  // app/services/delivery-holidays.server.ts table (the validation harness
  // parses and compares both, so they can never drift).
  //
  // FAIL CLOSED on ANY inconsistency: invalid/missing config, unresolvable
  // dispatch day (14-day scan), 60-calendar-day delivery scan cap, missing
  // translation string, any Intl/Date throw — hide, NEVER show a delivery
  // date we cannot stand behind. Warehouse wall-clock reads use the same
  // Intl.formatToParts minutes-of-day convention as the dispatch engine
  // above, including the h24 "24:xx" midnight quirk normalization — the
  // two must never fork.
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
    return {
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

  // ------------------------------------------- delivery DOM layer (v5.9)
  var deliveryTimer = null;

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

  // v6.2 Liquid diet: the PDP delivery shells (cx-tpl-delivery + alt, four
  // formats) are JS-built now. Same preview convention as before: inside a
  // verified preview session the merchant's armed DRAFT format (shipped in
  // cfg.preview.deliveryFormat — tokenless, armed-only) wins over the live
  // format, exactly what the alt-template preference used to produce. The
  // markup is a 1:1 rebuild of the old capture bodies; every dynamic value
  // still lands via textContent from the fail-closed engine.

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

  function deliveryAllowed() {
    // The exact cloneTemplate/widgetAllowed gate the old template carried:
    // live-effective for real visitors (server-computed cfg.delivery.live),
    // the verified live∪draft set inside a preview session.
    if (PREVIEW) {
      return PREVIEW.live.delivery_estimate === true || PREVIEW.flags.delivery_estimate === true;
    }
    return !!(cfg && cfg.delivery && cfg.delivery.live === true);
  }

  function deliveryTick() {
    // Same guarded-interval pattern as dispatchTick (the two widgets stack
    // but never share a timer, so neither can starve the other): re-run
    // the WHOLE computation each 30s tick — crossing the cutoff shifts
    // every date — and remove the node the moment anything stops being
    // defensible. Self-clears when no nodes remain.
    var nodes = document.querySelectorAll('.cx-delivery');
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

  function mountDelivery() {
    // Mounted directly after the dispatch countdown node when that widget
    // is visible (the two stack — countdown first), else after the same
    // .stock-msg / .pdp__actions--flex anchor mountDispatch uses. The
    // widget never DEPENDS on the countdown being visible. Every gate
    // fails closed: no config, no computable dates, no template (live +
    // draft gating via cloneTemplate/widgetAllowed), no anchor -> no-op.
    try {
      if (document.querySelector('.cx-delivery')) return; // idempotent
      var dc = deliveryConfig();
      if (!dc) return; // invalid/hidden config: fail closed
      var result = deliveryCompute(dc);
      if (!result) return; // no defensible dates: fail closed
      var texts = deliveryTexts(result, dc);
      if (!texts) return; // missing strings: fail closed
      if (!deliveryAllowed()) return; // live/preview gate (v6.2 JS-built shell)
      var node = deliveryBuildNode(deliveryBuildFormat());
      if (!node) return;
      var grey = document.querySelector('.pdp__grey');
      if (!grey) return;
      var anchor = grey.querySelector('.cx-dispatch--pdp') ||
        grey.querySelector('.stock-msg') ||
        grey.querySelector('.pdp__actions--flex');
      if (!anchor || !insertAfter(node, anchor)) return;
      deliverySetText(node, texts);
      bindDeliveryTooltip(node);
      deliveryEnsureTimer();
      // Impression honesty (v6.1): no beacon when the az delivery line
      // will replace this widget before paint (same rule as dispatch).
      if (!azReplacesDelivery()) track('delivery_estimate');
    } catch (e) { /* never break the theme */ }
  }

  // --------------------------------- derm survey (v7, per-product outcomes)
  //
  // v7: the five v5.8 display formats are retired — one outcomes-forward
  // PER-PRODUCT widget remains. Data + page-static strings still ride
  // #cx-pdp-config (cfg.survey / cfg.surveyStrings, emitted under the
  // exact show_survey/cx_draft_survey gate): total is the product's own
  // sample size, rec the validated "would recommend" count when present,
  // o the outcome rows {s: statement, y: yes count}. All outcome math
  // happens here — pct = Math.round(y / total * 100) — with the same
  // fail-closed rules the Liquid gate applies: invalid rows (y outside
  // 0 < y <= total, blank statement) are dropped, and zero valid rows
  // with no valid rec renders nothing at all. The accessible "How the
  // survey was conducted" disclosure and its methodology panel carry
  // over from v6.11 unchanged (merchant token substitution intact,
  // numbers now per-product). No config text ever reaches innerHTML.
  //
  // v8: an optional COMPACT display mode (cfg.dermSurvey.compact — a
  // LIVE setting riding the survey member as a lean "cm": 1) collapses
  // the section to one headline row, the top outcome inline and a
  // "+ N more outcomes" disclosure over the full outcome list, which is
  // built ONCE by the same row code and parked behind [hidden].

  function surveyData() {
    return cfg && cfg.survey && typeof cfg.survey === 'object' ? cfg.survey : null;
  }

  function surveyStr(key) {
    var map = cfg && cfg.surveyStrings && typeof cfg.surveyStrings === 'object' ? cfg.surveyStrings : {};
    return typeof map[key] === 'string' ? decodeEntities(map[key]) : '';
  }

  function surveyAllowed() {
    if (PREVIEW) {
      return PREVIEW.live.derm_survey === true || PREVIEW.flags.derm_survey === true;
    }
    return !!(cfg && cfg.survey && cfg.survey.live === true);
  }

  function surveyBuildPanel(panel) {
    var d = surveyData();
    var method = d && typeof d.method === 'string' ? d.method : '';
    var verifier = d && typeof d.verifier === 'string' ? d.verifier.replace(/^\s+|\s+$/g, '') : '';
    var url = d && typeof d.url === 'string' ? d.url.replace(/^\s+|\s+$/g, '') : '';
    var p, i;
    if (method.replace(/\s+/g, '') !== '') {
      // Merchant methodology: one <p> per non-blank line (the old
      // escape|newline_to_br|split path — flush <p>s, textContent only).
      // v6.11: the built-in text's live-number tokens ({{ total }},
      // {{ yes }}, {{ percent }}) are substituted so a merchant who edits
      // the full built-in text keeps numbers in sync — v7: with the
      // product's own survey content (total = sample size, yes/percent =
      // the validated would-recommend count). A product WITHOUT a valid
      // rec count has no truthful yes/percent, so lines using those
      // tokens are DROPPED rather than filled with fabricated zeros —
      // the same per-line fail-closed rule the built-in p4 follows.
      var yes = d && typeof d.rec === 'number' && isFinite(d.rec) ? d.rec : 0;
      var total = d && typeof d.total === 'number' && isFinite(d.total) ? d.total : 0;
      var pct = yes > 0 && total > 0 ? Math.round(yes / total * 100) : 0;
      var lines = method.split(/\r?\n/);
      for (i = 0; i < lines.length; i++) {
        var lineText = lines[i].replace(/^\s+|\s+$/g, '');
        if (!lineText) continue;
        if (yes <= 0 && /\{\{\s*(yes|percent)\s*\}\}/.test(lineText)) continue;
        lineText = lineText
          .replace(/\{\{\s*total\s*\}\}/g, String(total))
          .replace(/\{\{\s*yes\s*\}\}/g, String(yes))
          .replace(/\{\{\s*percent\s*\}\}/g, String(pct));
        p = document.createElement('p');
        p.textContent = lineText;
        panel.appendChild(p);
      }
    } else {
      // Built-in translated path. p4 (the answer-count sentence) is only
      // emitted by the Liquid when the product has a valid would-recommend
      // count — absent keys are skipped, never rendered empty.
      var defaults = [['p1', ''], ['p2', ''], ['p3', 'cx-survey__panel-q'], ['p4', ''], ['p5', '']];
      var appended = 0;
      for (i = 0; i < defaults.length; i++) {
        var text = surveyStr(defaults[i][0]);
        if (!text) continue;
        if (appended > 0) panel.appendChild(document.createTextNode(' '));
        p = defaults[i][1] ? cxEl('p', defaults[i][1]) : document.createElement('p');
        p.textContent = text;
        panel.appendChild(p);
        appended++;
      }
    }
    if (verifier) {
      var verify = cxEl('p', 'cx-survey__panel-verify');
      if (url) {
        var a = cxEl('a', 'cx-proof__link no-dec', ['href', url, 'target', '_blank', 'rel', 'noopener nofollow']);
        a.textContent = surveyStr('verified_by');
        verify.appendChild(a);
      } else {
        verify.appendChild(document.createTextNode(surveyStr('verified_by')));
      }
      panel.appendChild(verify);
    }
  }

  function surveyBuildHow() {
    var d = surveyData();
    var verifier = d && typeof d.verifier === 'string' ? d.verifier.replace(/^\s+|\s+$/g, '') : '';
    var root = cxEl('div', 'cx-survey__how', ['data-cx-survey-how', '']);
    cxSp(root);
    var row = cxEl('div', 'cx-survey__how-row');
    cxSp(row);
    var btn = cxEl('button', null, ['type', 'button', 'class', 'cx-survey__how-btn', 'data-cx-survey-toggle', '', 'aria-expanded', 'false', 'aria-controls', 'cx-survey-method']);
    btn.appendChild(cxIcon('question', 15));
    var howLabel = document.createElement('span');
    howLabel.textContent = surveyStr('how');
    btn.appendChild(howLabel);
    cxSp(btn);
    row.appendChild(btn);
    if (verifier) {
      var chip = cxEl('span', 'cx-survey__chip');
      chip.appendChild(cxIcon('seal-check', 13));
      var chipLabel = document.createElement('span');
      chipLabel.textContent = surveyStr('verified_badge');
      chip.appendChild(chipLabel);
      row.appendChild(chip);
    }
    root.appendChild(row);
    cxSp(root);
    var panel = cxEl('div', 'cx-survey__panel', ['id', 'cx-survey-method', 'hidden', '']);
    cxSp(panel);
    surveyBuildPanel(panel);
    cxSp(panel);
    root.appendChild(panel);
    cxSp(root);
    return root;
  }

  function surveyEyebrow() {
    var p = cxEl('p', 'cx-proof__eyebrow eyebrow eyebrow--sm');
    p.textContent = surveyStr('eyebrow');
    return p;
  }

  function surveyBuildOutcomes(rows, total) {
    // The outcome list — ONE builder for both display modes (v8): full
    // mode renders it in place; compact mode builds the SAME list once
    // and parks it behind [hidden] for the "+ N more outcomes" button.
    var ul = cxEl('ul', 'cx-survey__outcomes list-reset');
    cxSp(ul);
    var el;
    for (var r = 0; r < rows.length; r++) {
      var li = cxEl('li', 'cx-survey__outcome');
      cxSp(li);
      var rowEl = cxEl('div', 'cx-survey__outcome-row');
      var st = cxEl('span', 'cx-survey__outcome-statement');
      st.textContent = decodeEntities(rows[r].s);
      rowEl.appendChild(st);
      cxSp(rowEl);
      el = cxEl('span', 'cx-survey__outcome-pct');
      el.textContent = rows[r].pct + '%';
      rowEl.appendChild(el);
      li.appendChild(rowEl);
      cxSp(li);
      // The bar is decorative (the percent is already text); its fill
      // width is built from the derived number only — never from config
      // strings — so nothing unescaped can reach the style attribute.
      var bar = cxEl('div', 'cx-survey__bar', ['aria-hidden', 'true']);
      var fill = cxEl('div', 'cx-survey__bar-fill');
      fill.style.width = rows[r].pct + '%';
      bar.appendChild(fill);
      li.appendChild(bar);
      cxSp(li);
      el = cxEl('span', 'cx-survey__outcome-n');
      el.textContent = surveyStr('outcome_agree').replace('@@YES@@', String(rows[r].y)).replace('@@TOTAL@@', String(total));
      li.appendChild(el);
      cxSp(li);
      ul.appendChild(li);
      cxSp(ul);
    }
    return ul;
  }

  function surveyBuildSection() {
    var d = surveyData();
    if (!d) return null;
    var total = typeof d.total === 'number' && isFinite(d.total) && d.total > 0 ? d.total : 0;
    if (!total) return null;
    var rec = typeof d.rec === 'number' && isFinite(d.rec) && d.rec > 0 && d.rec <= total ? d.rec : 0;
    var list = Array.isArray(d.o) ? d.o : [];
    var rows = [];
    for (var i = 0; i < list.length; i++) {
      var o = list[i] && typeof list[i] === 'object' ? list[i] : {};
      var y = typeof o.y === 'number' && isFinite(o.y) ? o.y : 0;
      if (y > 0 && y <= total && typeof o.s === 'string' && /\S/.test(o.s)) {
        rows.push({ s: o.s, y: y, pct: Math.round(y / total * 100) });
      }
    }
    // Fail closed: no valid rec headline AND no valid outcome rows means
    // there is nothing truthful to show — render nothing at all.
    if (!rec && rows.length === 0) return null;
    var compact = d.cm === 1; // v8 display density (LIVE setting, no draft plumbing)
    var title = typeof d.t === 'string' && /\S/.test(d.t) ? bottleStr(d, 't') : '';
    var root = cxEl('section', 'cx-proof cx-survey' + (compact ? ' cx-survey--compact' : ''), ['data-cx-feature', 'derm_survey']);
    cxSp(root);
    root.appendChild(surveyEyebrow());
    cxSp(root);
    var el;
    if (rec) {
      var head = cxEl('div', 'cx-survey__headnum');
      cxSp(head);
      el = cxEl('span', 'cx-survey__rec-pct');
      el.textContent = Math.round(rec / total * 100) + '%';
      head.appendChild(el);
      cxSp(head);
      el = cxEl('h2', 'cx-survey__headline');
      el.textContent = title || surveyStr('rec_line');
      head.appendChild(el);
      cxSp(head);
      root.appendChild(head);
      cxSp(root);
    } else if (title) {
      el = cxEl('h2', 'cx-survey__headline');
      el.textContent = title;
      root.appendChild(el);
      cxSp(root);
    }
    // v8 compact drops the long-form middle (quoted question, intro): the
    // vertical diet is the point. Full mode is byte-for-byte the v7 DOM.
    if (!compact && typeof d.q === 'string' && /\S/.test(d.q)) {
      el = cxEl('blockquote', 'cx-survey__quote');
      el.textContent = bottleStr(d, 'q');
      root.appendChild(el);
      cxSp(root);
    }
    if (rows.length > 0) {
      if (compact) {
        // The TOP outcome (the merchant's first valid row) inline —
        // "91% — Skin looked visibly firmer".
        var top = cxEl('p', 'cx-survey__top-line');
        var tp = cxEl('strong', 'cx-survey__top-pct');
        tp.textContent = rows[0].pct + '%';
        top.appendChild(tp);
        top.appendChild(document.createTextNode(' — ' + decodeEntities(rows[0].s)));
        root.appendChild(top);
        cxSp(root);
        if (rows.length > 1) {
          var moreLabel = surveyStr('more_outcomes');
          var full = surveyBuildOutcomes(rows, total);
          if (/\S/.test(moreLabel)) {
            var more = cxEl('button', null, ['type', 'button', 'class', 'cx-survey__more-btn', 'data-cx-survey-more', '', 'aria-expanded', 'false', 'aria-controls', 'cx-survey-outcomes']);
            more.textContent = moreLabel.replace('@@N@@', String(rows.length - 1));
            root.appendChild(more);
            cxSp(root);
            full.setAttribute('id', 'cx-survey-outcomes');
            full.setAttribute('hidden', '');
          }
          // Stale-island degrade: no more_outcomes string means no working
          // disclosure, so the list ships visible rather than unreachable.
          root.appendChild(full);
          cxSp(root);
        }
      } else {
        el = cxEl('p', 'cx-survey__intro');
        el.textContent = typeof d.intro === 'string' && /\S/.test(d.intro) ? bottleStr(d, 'intro') : surveyStr('outcomes_intro');
        root.appendChild(el);
        cxSp(root);
        root.appendChild(surveyBuildOutcomes(rows, total));
        cxSp(root);
      }
    }
    root.appendChild(surveyBuildHow());
    cxSp(root);
    return root;
  }

  function surveyTplNode() {
    // v7 replacement for the v6.2 format dispatch: same live/preview gate,
    // same emission gate (payload presence) — one outcomes-forward builder.
    try {
      if (!surveyData() || !surveyAllowed()) return null;
      return surveyBuildSection();
    } catch (e) {
      return null;
    }
  }

  function bindSurveyDisclosure(widget) {
    // Accessible disclosure: a real <button> with aria-expanded /
    // aria-controls. CLICK/TAP ONLY on every device (v5.8.2: the desktop
    // hover-open was removed on merchant request — it felt janky; a
    // deliberate tap/click reads calmer and can't flicker). One press
    // opens, another closes; Escape closes and refocuses the trigger.
    // The panel is inline below the trigger — never floating. Bound
    // AFTER cloning, so it works identically on the live template and
    // the preview alt template.
    try {
      var btn = widget.querySelector('[data-cx-survey-toggle]');
      if (!btn) return;
      var panel = null;
      var panelId = btn.getAttribute('aria-controls');
      if (panelId) panel = widget.querySelector('#' + panelId);
      if (!panel) panel = widget.querySelector('.cx-survey__panel');
      if (!panel) return;
      function setOpen(open) {
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
      }
      function isOpen() {
        return btn.getAttribute('aria-expanded') === 'true';
      }
      btn.addEventListener('click', function () {
        setOpen(!isOpen());
      });
      widget.addEventListener('keydown', function (event) {
        if ((event.key === 'Escape' || event.key === 'Esc') && isOpen()) {
          setOpen(false);
          try { btn.focus(); } catch (e) { /* noop */ }
        }
      });
    } catch (e) { /* never break the theme */ }
  }

  function bindSurveyMore(widget) {
    // v8 compact: "+ N more outcomes" toggles the full outcome list the
    // builder parked behind [hidden] (backed by the CSS
    // display:none !important guard — the v6.8.1 lesson: the list's own
    // display rule beats the UA [hidden] default, so the guard must win
    // explicitly). Same disclosure manners as the methodology panel:
    // a real <button>, aria-expanded, click/tap only. No-op outside
    // compact mode — the button simply isn't there.
    try {
      var btn = widget.querySelector('[data-cx-survey-more]');
      if (!btn) return;
      var list = null;
      var listId = btn.getAttribute('aria-controls');
      if (listId) list = widget.querySelector('#' + listId);
      if (!list) list = widget.querySelector('.cx-survey__outcomes');
      if (!list) return;
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
        if (open) list.setAttribute('hidden', '');
        else list.removeAttribute('hidden');
      });
    } catch (e) { /* never break the theme */ }
  }

  // ------------------------------------------ empty bottle guarantee (v6.2)
  //
  // v6.2 Liquid diet: cx-tpl-pdp-bottle is JS-built now, a 1:1 rebuild of
  // the old template body. The server-translated strings (title incl. the
  // merchant override, body with the pluralized days label + container
  // word baked in, the three points, the guarantee-check button label)
  // ship in the #cx-bottle-config island, emitted under the exact
  // show_bottle/cx_draft_bottle gate the template used, with "live"
  // carrying the data-cx-draft distinction. Everything lands via
  // textContent (decodeEntities at the consumption point, same as
  // surveyStr); v6.7: the modal is JS-built too (gcheckBuildNode reads
  // the island's gc block via gcheckTplNode) and its gcheck wiring is
  // untouched — it operates on the built node.

  function bottleData() {
    try {
      var el = document.getElementById('cx-bottle-config');
      if (!el) return null; // Liquid gate emitted nothing: fail closed
      var data = JSON.parse(el.textContent || 'null');
      return data && typeof data === 'object' ? data : null;
    } catch (e) {
      return null;
    }
  }

  function bottleStr(data, key) {
    return typeof data[key] === 'string' ? decodeEntities(data[key]) : '';
  }

  function bottleAllowed(data) {
    // The exact cloneTemplate/widgetAllowed gate the old template carried.
    if (PREVIEW) {
      return PREVIEW.live.empty_bottle_guarantee === true || PREVIEW.flags.empty_bottle_guarantee === true;
    }
    return data.live === true;
  }

  function bottleBuildNode(data) {
    // v8: cfg.emptyBottleGuarantee.compact (island "cm": 1) renders a
    // single slim band instead of the big ink panel: check icon, title
    // and the guarantee-check trigger on one row. Body and points are
    // omitted — they live in the modal, which is unchanged.
    var compact = data.cm === 1;
    var root = cxEl('section', 'cx-proof cx-bottle' + (compact ? ' cx-bottle--compact' : ''), ['data-cx-feature', 'empty_bottle_guarantee']);
    cxSp(root);
    var icon = cxEl('div', 'cx-bottle__icon', ['aria-hidden', 'true']);
    icon.appendChild(compact ? cxIcon('check', 16) : cxIcon('bottle', 26));
    root.appendChild(icon);
    cxSp(root);
    if (compact) {
      var ch2 = cxEl('h2', 'cx-bottle__title');
      ch2.textContent = bottleStr(data, 'title');
      root.appendChild(ch2);
      cxSp(root);
      var cbtn = cxEl('button', null, ['type', 'button', 'class', 'cx-bottle__check', 'data-cx-guarantee-check', '']);
      cbtn.textContent = bottleStr(data, 'check');
      root.appendChild(cbtn);
      cxSp(root);
      return root;
    }
    var content = cxEl('div', 'cx-bottle__content');
    cxSp(content);
    var h2 = cxEl('h2', 'cx-bottle__title');
    h2.textContent = bottleStr(data, 'title');
    content.appendChild(h2);
    var body = cxEl('p', 'cx-bottle__body');
    body.textContent = bottleStr(data, 'body');
    content.appendChild(body);
    cxSp(content);
    var ul = cxEl('ul', 'cx-bottle__points list-reset');
    cxSp(ul);
    var keys = ['p1', 'p2', 'p3'];
    for (var i = 0; i < keys.length; i++) {
      var li = cxEl('li', 'cx-bottle__point');
      li.appendChild(cxIcon('check', 16));
      var span = document.createElement('span');
      span.textContent = bottleStr(data, keys[i]);
      li.appendChild(span);
      ul.appendChild(li);
      cxSp(ul);
    }
    content.appendChild(ul);
    cxSp(content);
    var btn = cxEl('button', null, ['type', 'button', 'class', 'cx-bottle__check', 'data-cx-guarantee-check', '']);
    btn.textContent = bottleStr(data, 'check');
    content.appendChild(btn);
    cxSp(content);
    root.appendChild(content);
    cxSp(root);
    return root;
  }

  function bottleTplNode() {
    // v6.2 replacement for cloneTemplate('cx-tpl-pdp-bottle',
    // 'empty_bottle_guarantee'): same live/preview gate, same emission
    // gate (island presence).
    try {
      var data = bottleData();
      if (!data || !bottleAllowed(data)) return null;
      return bottleBuildNode(data);
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------- guarantee-check modal body (v6.7)
  //
  // v6.7 Liquid diet: cx-tpl-guarantee-check is JS-built now — a 1:1
  // rebuild of the old never-draft-marked template body. The strings ride
  // the existing #cx-bottle-config island: root body/p1/p2/p3 are shared
  // with the bottle widget (the modal always reused those exact
  // translations) plus a lean "gc" sub-object (close/title/mech/trust/
  // foot + the four merchant company facts). Facts were | escape'd in the
  // template, so they are consumed RAW (cxRawStr — the parser handed the
  // original text back) and blank ones are filtered in JS exactly like
  // the template's != blank gates: all four blank hides the trust
  // section. The gcheck wiring (focus trap, ESC/backdrop/close-button
  // dismissal, scroll lock, focus restore) is untouched and operates on
  // the built node — role/aria-modal/aria-labelledby/tabindex live here.

  function cxRawStr(o, k) {
    // RAW config read for values the old templates piped through
    // | escape or emitted inside src/srcset/href attributes: the HTML
    // parser returned them verbatim, so no decodeEntities at consumption
    // (decoding would double-decode merchant text like "&amp;").
    return o && typeof o[k] === 'string' ? o[k] : '';
  }

  function gcheckBuildNode(data) {
    var gc = data.gc;
    var root = cxEl('div', 'cx-guarantee-modal');
    cxSp(root);
    root.appendChild(cxEl('div', 'cx-guarantee-modal__backdrop', ['data-cx-gcheck-close', '']));
    cxSp(root);
    var card = cxEl('div', 'cx-guarantee-modal__card', ['role', 'dialog', 'aria-modal', 'true', 'aria-labelledby', 'cx-gcheck-title', 'tabindex', '-1']);
    cxSp(card);
    var close = cxEl('button', null, ['type', 'button', 'class', 'cx-guarantee-modal__close', 'data-cx-gcheck-close', '', 'aria-label', bottleStr(gc, 'close')]);
    cxSp(close);
    var x = cxEl('span', null, ['aria-hidden', 'true']);
    x.textContent = '×'; // the template's &times; — identical DOM text after parsing
    close.appendChild(x);
    cxSp(close);
    card.appendChild(close);
    cxSp(card);
    var h2 = cxEl('h2', 'cx-guarantee-modal__title', ['id', 'cx-gcheck-title']);
    h2.textContent = bottleStr(gc, 'title');
    card.appendChild(h2);
    cxSp(card);
    var mech = cxEl('h3', 'cx-guarantee-modal__section');
    mech.textContent = bottleStr(gc, 'mech');
    card.appendChild(mech);
    cxSp(card);
    var days = cxEl('p', 'cx-guarantee-modal__days');
    days.textContent = bottleStr(data, 'body');
    card.appendChild(days);
    cxSp(card);
    var points = cxEl('ul', 'cx-guarantee-modal__points list-reset');
    cxSp(points);
    var keys = ['p1', 'p2', 'p3'];
    for (var i = 0; i < keys.length; i++) {
      var li = cxEl('li', 'cx-guarantee-modal__point');
      li.appendChild(cxIcon('check', 16));
      var span = document.createElement('span');
      span.textContent = bottleStr(data, keys[i]);
      li.appendChild(span);
      points.appendChild(li);
      cxSp(points);
    }
    card.appendChild(points);
    var facts = [];
    var raw = gc && gc.facts;
    if (raw && raw.length) {
      for (var f = 0; f < raw.length && f < 4; f++) {
        // the template's != blank gate: strings with any non-whitespace
        if (typeof raw[f] === 'string' && /\S/.test(raw[f])) facts.push(raw[f]);
      }
    }
    if (facts.length) {
      var trust = cxEl('h3', 'cx-guarantee-modal__section');
      trust.textContent = bottleStr(gc, 'trust');
      card.appendChild(trust);
      cxSp(card);
      var list = cxEl('ul', 'cx-guarantee-modal__facts list-reset');
      for (var g = 0; g < facts.length; g++) {
        var fact = cxEl('li', 'cx-guarantee-modal__fact');
        fact.textContent = facts[g]; // | escape twin: raw value, textContent only
        list.appendChild(fact);
      }
      card.appendChild(list);
    }
    var foot = cxEl('p', 'cx-guarantee-modal__footnote');
    foot.textContent = bottleStr(gc, 'foot');
    card.appendChild(foot);
    cxSp(card);
    root.appendChild(card);
    cxSp(root);
    return root;
  }

  function gcheckTplNode() {
    // v6.7 replacement for cloning #cx-tpl-guarantee-check: the modal was
    // never draft-marked, so the only gate is emission — the island (and
    // its gc block) exists exactly when the template used to be emitted
    // (show_bottle or cx_draft_bottle).
    try {
      var data = bottleData();
      if (!data || !data.gc || typeof data.gc !== 'object') return null;
      return gcheckBuildNode(data);
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------- clinical study (v6.7)
  //
  // v6.7 Liquid diet: cx-tpl-pdp-study is JS-built now, a 1:1 rebuild of
  // the old template body. Per-product metaobject content ships in the
  // lean #cx-study-config island (emitted under the exact show_study/
  // cx_draft_study gate, "live" carrying the data-cx-draft distinction):
  // title/concern raw, results as {v,s,l} rows (the template's
  // integral-floor collapse — 37.0 -> "37" — runs in studyNum),
  // study URL raw for the href, merchant footnote key only when
  // non-blank with the translated default shipped alongside. First result
  // renders as the hero, the rest as grid stats with the grid <ul> only
  // when more than one result exists — exactly the template's
  // forloop.first/last shape.
  //
  // v7: the study binds to THIS product — a subject line always renders
  // after the eyebrow (per-product "sub" override, else str.sub composed
  // server-side with the localized product title), and the composed m1/m2
  // methodology paragraphs are retired in favor of protocol fact chips
  // built from whichever lean members the island carries: pn (sample
  // size, gates the str.fn "N participants" chip), pw (precomposed weeks
  // label), pl (lab name) and pi (pre-interpolated instruments line).

  function studyData() {
    try {
      var el = document.getElementById('cx-study-config');
      if (!el) return null; // Liquid gate emitted nothing: fail closed
      var data = JSON.parse(el.textContent || 'null');
      return data && typeof data === 'object' ? data : null;
    } catch (e) {
      return null;
    }
  }

  function studyAllowed(data) {
    // The exact cloneTemplate/widgetAllowed gate the old template carried.
    if (PREVIEW) {
      return PREVIEW.live.clinical_study === true || PREVIEW.flags.clinical_study === true;
    }
    return data.live === true;
  }

  function studyNum(v) {
    // The template's floor collapse: {{ value | floor }} replaces the
    // value when numerically integral, so 37.0 renders "37" while 37.5
    // stays "37.5". Non-numeric island values pass through as text.
    if (typeof v === 'number' && isFinite(v)) {
      return String(v === Math.floor(v) ? Math.floor(v) : v);
    }
    return typeof v === 'string' ? decodeEntities(v) : '';
  }

  function studyValSpan(cls, sufCls, e) {
    var span = cxEl('span', cls);
    span.appendChild(document.createTextNode(studyNum(e.v)));
    var suf = cxEl('span', sufCls);
    suf.textContent = bottleStr(e, 's');
    span.appendChild(suf);
    return span;
  }

  function studyBuildSection(data) {
    var s = data.str || {};
    var results = Array.isArray(data.r) ? data.r : [];
    // v8: cfg.clinicalStudy.compact (island "cm": 1) is a pure CSS
    // recomposition — same DOM, the --compact modifier inlines the hero
    // with its label (32px numeral), collapses the stat grid to one
    // wrapping mini-stat row and tightens the chips into the same flow.
    var root = cxEl('section', 'cx-proof cx-study' + (data.cm === 1 ? ' cx-study--compact' : ''), ['data-cx-feature', 'clinical_study']);
    cxSp(root);
    var eb = cxEl('p', 'cx-proof__eyebrow eyebrow eyebrow--sm');
    eb.textContent = bottleStr(s, 'eyebrow');
    root.appendChild(eb);
    // v7: the product-binding line — the study reads as conducted on THIS
    // product. Per-product override wins, else the server-composed default
    // (str.sub already carries the localized product title). Always
    // rendered: the binding is the point of the widget.
    var subj = cxEl('p', 'cx-study__subject');
    subj.textContent = typeof data.sub === 'string' && /\S/.test(data.sub) ? bottleStr(data, 'sub') : bottleStr(s, 'sub');
    root.appendChild(subj);
    if (typeof data.t === 'string' && /\S/.test(data.t)) {
      var h2 = cxEl('h2', 'cx-study__heading heading--two');
      h2.textContent = bottleStr(data, 't');
      root.appendChild(h2);
    }
    if (typeof data.c === 'string' && /\S/.test(data.c)) {
      var concern = cxEl('p', 'cx-study__concern');
      concern.textContent = bottleStr(data, 'c');
      root.appendChild(concern);
    }
    if (results.length > 0) {
      var e0 = results[0] && typeof results[0] === 'object' ? results[0] : {};
      var hero = cxEl('div', 'cx-study__hero');
      cxSp(hero);
      hero.appendChild(studyValSpan('cx-study__hero-value', 'cx-study__hero-suffix', e0));
      if (typeof e0.l === 'string' && /\S/.test(e0.l)) {
        var hl = cxEl('span', 'cx-study__hero-label');
        hl.textContent = bottleStr(e0, 'l');
        hero.appendChild(hl);
      }
      root.appendChild(hero);
      if (results.length > 1) {
        var grid = cxEl('ul', 'cx-study__grid list-reset');
        for (var i = 1; i < results.length; i++) {
          var e = results[i] && typeof results[i] === 'object' ? results[i] : {};
          var li = cxEl('li', 'cx-study__stat');
          cxSp(li);
          li.appendChild(studyValSpan('cx-study__stat-value', 'cx-study__stat-suffix', e));
          if (typeof e.l === 'string' && /\S/.test(e.l)) {
            var sl = cxEl('span', 'cx-study__stat-label');
            sl.textContent = bottleStr(e, 'l');
            li.appendChild(sl);
          }
          grid.appendChild(li);
        }
        root.appendChild(grid);
      }
    }
    // v7: protocol facts as quiet chips, built only from present members —
    // absent members simply skip, zero facts renders no list at all.
    var facts = [];
    if (typeof data.pn === 'number' && isFinite(data.pn) && data.pn > 0 && typeof s.fn === 'string' && /\S/.test(s.fn)) facts.push(bottleStr(s, 'fn'));
    if (typeof data.pw === 'string' && /\S/.test(data.pw)) facts.push(bottleStr(data, 'pw'));
    if (typeof data.pl === 'string' && /\S/.test(data.pl)) facts.push(bottleStr(data, 'pl'));
    if (typeof data.pi === 'string' && /\S/.test(data.pi)) facts.push(bottleStr(data, 'pi'));
    if (facts.length > 0) {
      var factList = cxEl('ul', 'cx-study__facts list-reset');
      for (var fi = 0; fi < facts.length; fi++) {
        var fact = cxEl('li', 'cx-study__fact');
        fact.textContent = facts[fi];
        factList.appendChild(fact);
      }
      root.appendChild(factList);
    }
    var url = cxRawStr(data, 'u');
    if (/\S/.test(url)) {
      var lp = cxEl('p', 'cx-study__method');
      var a = cxEl('a', 'cx-proof__link no-dec', ['href', url, 'target', '_blank', 'rel', 'noopener nofollow']);
      a.textContent = bottleStr(s, 'view');
      lp.appendChild(a);
      root.appendChild(lp);
    }
    var foot = cxEl('p', 'cx-study__footnote');
    foot.textContent = typeof data.f === 'string' ? bottleStr(data, 'f') : bottleStr(s, 'foot');
    root.appendChild(foot);
    return root;
  }

  function studyTplNode() {
    // v6.7 replacement for cloneTemplate('cx-tpl-pdp-study',
    // 'clinical_study'): same live/preview gate, same emission gate
    // (island presence).
    try {
      var data = studyData();
      if (!data || !studyAllowed(data)) return null;
      return studyBuildSection(data);
    } catch (e) {
      return null;
    }
  }

  // -------------------------------------------- batch transparency (v6.7)
  //
  // v6.7 Liquid diet: cx-tpl-pdp-batch is JS-built now, a 1:1 rebuild of
  // the old template body. Per-product metaobject content ships in the
  // lean #cx-batch-config island (emitted under the exact show_batch/
  // cx_draft_batch gate, "live" carrying the data-cx-draft distinction):
  // intro raw (JS splits newlines into text + <br> exactly like
  // newline_to_br), ingredient rows {n,note,c,f} with the template's
  // integral-floor collapse run in batchConcText and the &nbsp;%
  // suffix as the identical   text, CoA rows with batch_no/
  // tested_by pre-t'd server-side, dates pre-formatted, and the
  // document_url -> document.value.url fallback resolved in Liquid.
  // Optional CoA keys exist exactly when the template's gates held (key
  // presence = branch decision). Section gating mirrors the template:
  // table only with >0 ingredient rows, CoA list only with >0
  // certificates.

  function batchData() {
    try {
      var el = document.getElementById('cx-batch-config');
      if (!el) return null; // Liquid gate emitted nothing: fail closed
      var data = JSON.parse(el.textContent || 'null');
      return data && typeof data === 'object' ? data : null;
    } catch (e) {
      return null;
    }
  }

  function batchAllowed(data) {
    // The exact cloneTemplate/widgetAllowed gate the old template carried.
    if (PREVIEW) {
      return PREVIEW.live.batch_transparency === true || PREVIEW.flags.batch_transparency === true;
    }
    return data.live === true;
  }

  function batchIntroP(raw) {
    // {{ intro | newline_to_br }} twin: the filter rewrites \r?\n as
    // "<br />\n", so the parsed DOM is text / <br> / "\n"-led text runs.
    // Split the RAW value first (an encoded &#10; must stay text, exactly
    // as the template rendered it), decode per line at consumption.
    var p = cxEl('p', 'cx-batch__intro');
    var lines = String(raw).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      if (i === 0) {
        p.appendChild(document.createTextNode(decodeEntities(lines[i])));
      } else {
        p.appendChild(cxEl('br'));
        p.appendChild(document.createTextNode('\n' + decodeEntities(lines[i])));
      }
    }
    return p;
  }

  function batchConcText(c) {
    // The template's floor collapse ({{ conc | floor }} when integral —
    // 2.0 renders "2", 0.5 stays "0.5") + its != blank cell gate:
    // null/empty/whitespace-only means an EMPTY cell, but 0 renders.
    if (typeof c === 'number' && isFinite(c)) {
      return String(c === Math.floor(c) ? Math.floor(c) : c);
    }
    if (typeof c === 'string' && /\S/.test(c)) return decodeEntities(c);
    return null;
  }

  function batchBuildRow(ing) {
    var tr = cxEl('tr');
    cxSp(tr);
    var td1 = cxEl('td');
    cxSp(td1);
    td1.appendChild(document.createTextNode(bottleStr(ing, 'n')));
    if (typeof ing.note === 'string' && /\S/.test(ing.note)) {
      var note = cxEl('span', 'cx-batch__note');
      note.textContent = bottleStr(ing, 'note');
      td1.appendChild(note);
    }
    tr.appendChild(td1);
    cxSp(tr);
    var td2 = cxEl('td', 'cx-batch__conc');
    var conc = batchConcText(ing.c);
    if (conc !== null) td2.textContent = conc + ' %';
    tr.appendChild(td2);
    cxSp(tr);
    var td3 = cxEl('td');
    td3.textContent = bottleStr(ing, 'f');
    tr.appendChild(td3);
    cxSp(tr);
    return tr;
  }

  function batchBuildCoa(coa, s) {
    var li = cxEl('li', 'cx-batch__coa');
    cxSp(li);
    var b = cxEl('span', 'cx-batch__coa-batch');
    b.textContent = bottleStr(coa, 'b');
    li.appendChild(b);
    if (typeof coa.d === 'string') {
      var meta = cxEl('span', 'cx-batch__coa-meta');
      meta.appendChild(cxIcon('calendar', 14));
      var d = document.createElement('span');
      d.textContent = bottleStr(coa, 'd');
      meta.appendChild(d);
      cxSp(meta);
      li.appendChild(meta);
    }
    if (typeof coa.l === 'string') {
      var lab = cxEl('span', 'cx-batch__coa-meta');
      lab.textContent = bottleStr(coa, 'l');
      li.appendChild(lab);
    }
    var url = cxRawStr(coa, 'u');
    if (url) {
      var a = cxEl('a', 'cx-batch__coa-link cx-proof__link no-dec', ['href', url, 'target', '_blank', 'rel', 'noopener nofollow']);
      a.appendChild(cxIcon('download', 14));
      var dl = document.createElement('span');
      dl.textContent = bottleStr(s, 'dl');
      a.appendChild(dl);
      cxSp(a);
      li.appendChild(a);
    }
    return li;
  }

  function batchBuildSection(data) {
    var s = data.str || {};
    var ing = Array.isArray(data.ing) ? data.ing : [];
    var coas = Array.isArray(data.coa) ? data.coa : [];
    var root = cxEl('section', 'cx-proof cx-batch', ['data-cx-feature', 'batch_transparency']);
    cxSp(root);
    var eb = cxEl('p', 'cx-proof__eyebrow eyebrow eyebrow--sm');
    eb.textContent = bottleStr(s, 'eyebrow');
    root.appendChild(eb);
    cxSp(root);
    var h2 = cxEl('h2', 'cx-batch__title heading--two');
    h2.textContent = bottleStr(s, 'title');
    root.appendChild(h2);
    if (typeof data.i === 'string' && /\S/.test(data.i)) {
      root.appendChild(batchIntroP(data.i));
    }
    if (ing.length > 0) {
      var wrap = cxEl('div', 'cx-batch__table-wrap');
      cxSp(wrap);
      var table = cxEl('table', 'cx-batch__table');
      cxSp(table);
      var thead = cxEl('thead');
      cxSp(thead);
      var trh = cxEl('tr');
      cxSp(trh);
      var ths = ['ci', 'cc', 'cf'];
      for (var h = 0; h < ths.length; h++) {
        var th = cxEl('th', null, ['scope', 'col']);
        th.textContent = bottleStr(s, ths[h]);
        trh.appendChild(th);
        cxSp(trh);
      }
      thead.appendChild(trh);
      cxSp(thead);
      table.appendChild(thead);
      cxSp(table);
      var tbody = cxEl('tbody');
      for (var i = 0; i < ing.length; i++) {
        if (ing[i] && typeof ing[i] === 'object') tbody.appendChild(batchBuildRow(ing[i]));
      }
      table.appendChild(tbody);
      cxSp(table);
      wrap.appendChild(table);
      cxSp(wrap);
      root.appendChild(wrap);
    }
    if (coas.length > 0) {
      var h3 = cxEl('h3', 'cx-batch__coa-title heading--five');
      h3.textContent = bottleStr(s, 'coaTitle');
      root.appendChild(h3);
      cxSp(root);
      var ul = cxEl('ul', 'cx-batch__coas list-reset');
      for (var j = 0; j < coas.length; j++) {
        if (coas[j] && typeof coas[j] === 'object') ul.appendChild(batchBuildCoa(coas[j], s));
      }
      root.appendChild(ul);
    }
    var hon = cxEl('p', 'cx-batch__honesty');
    hon.textContent = bottleStr(s, 'hon');
    root.appendChild(hon);
    cxSp(root);
    return root;
  }

  function batchTplNode() {
    // v6.7 replacement for cloneTemplate('cx-tpl-pdp-batch',
    // 'batch_transparency'): same live/preview gate, same emission gate
    // (island presence).
    try {
      var data = batchData();
      if (!data || !batchAllowed(data)) return null;
      return batchBuildSection(data);
    } catch (e) {
      return null;
    }
  }

  // ------------------------------ v1 PDP strip widgets (v6.7, extended batch)
  //
  // v6.7 Liquid diet, extended PDP batch: the four remaining PDP
  // templates (cx-tpl-pdp-badges / -guarantee / -trustpilot / -nudge)
  // are JS-built now — 1:1 rebuilds of the old template bodies. Their
  // page-static, server-translated strings ride the existing
  // #cx-pdp-config island as lean gated members ("badges" / "g" / "tp" /
  // "n"), each emitted under the exact show_X/cx_draft_X gate its
  // template used, with "live" carrying the data-cx-draft distinction.
  // Strings land via textContent after decodeEntities (bottleStr);
  // URL-context values the template | escape'd stay RAW (cxRawStr +
  // setAttribute). The stars cell is the same JS port of
  // snippets/cx-trustpilot-stars.liquid that cellexia-cart.js ships
  // (twin-parity copy: cxStarsSvgs/cxStarsNode); the badge/guarantee/
  // nudge icons come from CX_AZ_ICONS specs and the Trustpilot brand
  // star from cxStarIcon (the one FILLED icon shell).

  function pdpMember(key) {
    // Island gate: the member is emitted exactly when the old template
    // used to be. Missing member -> fail closed (no node).
    return cfg && cfg[key] && typeof cfg[key] === 'object' ? cfg[key] : null;
  }

  function pdpMemberAllowed(d, featureKey) {
    // The exact cloneTemplate/widgetAllowed gate the old templates carried.
    if (PREVIEW) {
      return PREVIEW.live[featureKey] === true || PREVIEW.flags[featureKey] === true;
    }
    return d.live === true;
  }

  function badgeIconNode(key) {
    // The old template's key -> icon case chain. Literal-only cxIcon call
    // sites (the no-variable-ever-reaches-cxIcon invariant, harness
    // section 8): a catalog key can only SELECT among these constants.
    if (key === 'secure_checkout' || key === 'ssl_encrypted') return cxIcon('lock', 18);
    if (key === 'free_shipping_over') return cxIcon('truck', 18);
    if (key === 'money_back') return cxIcon('shield-check', 18);
    if (key === 'dermatologist_tested') return cxIcon('droplet', 18);
    if (key === 'cruelty_free') return cxIcon('leaf', 18);
    if (key === 'easy_returns') return cxIcon('refresh', 18);
    return cxIcon('check', 18); // clinically_proven + the template's default
  }

  function badgesBuildNode(d) {
    // Catalog from the old template, index-aligned with the "l" label
    // array the island emits (labels pre-translated server-side,
    // free_shipping_over amount + money_back days baked in).
    var catalog = ['secure_checkout', 'free_shipping_over', 'money_back', 'dermatologist_tested', 'cruelty_free', 'clinically_proven', 'ssl_encrypted', 'easy_returns'];
    var keys = d.k;
    if (typeof keys === 'string') keys = keys === '' ? [] : [keys]; // Liquid iterates a string as one item
    if (!keys || !keys.length) return null; // the old badge_keys.size > 0 emission gate
    var labels = d.l;
    var root = cxEl('div', 'cx-pdp-badges', ['data-cx-feature', 'trust_badges']);
    cxSp(root);
    var ul = cxEl('ul', 'cx-badges__list cx-badges__list--pdp list-reset d-flex');
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i] == null ? '' : String(keys[i]).replace(/^\s+|\s+$/g, ''); // | strip twin
      if (key === 'free_shipping_over' && d.fs !== true) continue; // no safe amount: skip
      var idx = -1;
      for (var c = 0; c < catalog.length; c++) { if (catalog[c] === key) { idx = c; break; } }
      if (idx === -1) continue; // the old "catalog contains badge_key" gate
      var li = cxEl('li', 'cx-badges__item d-flex align-center');
      cxSp(li);
      li.appendChild(badgeIconNode(key));
      cxSp(li);
      var label = cxEl('span', 'cx-badges__label');
      label.textContent = labels && typeof labels[idx] === 'string' ? decodeEntities(labels[idx]) : '';
      li.appendChild(label);
      cxSp(li);
      ul.appendChild(li);
    }
    root.appendChild(ul);
    cxSp(root);
    return root;
  }

  function badgesTplNode() {
    // v6.7 replacement for cloneTemplate('cx-tpl-pdp-badges',
    // 'trust_badges'): same live/preview gate, same emission gates
    // (member presence + non-empty key list).
    try {
      var d = pdpMember('badges');
      if (!d || !pdpMemberAllowed(d, 'trust_badges')) return null;
      return badgesBuildNode(d);
    } catch (e) {
      return null;
    }
  }

  function pdpGuaranteeBuildNode(d) {
    var root = cxEl('div', 'cx-guarantee cx-guarantee--compact cx-guarantee--pdp', ['data-cx-feature', 'guarantee']);
    cxSp(root);
    var icon = cxEl('div', 'cx-guarantee__icon', ['aria-hidden', 'true']);
    cxSp(icon);
    icon.appendChild(cxIcon('shield-check', 22));
    cxSp(icon);
    root.appendChild(icon);
    cxSp(root);
    var content = cxEl('div', 'cx-guarantee__content');
    cxSp(content);
    var h3 = cxEl('h3', 'cx-guarantee__title heading--five');
    h3.textContent = bottleStr(d, 't');
    content.appendChild(h3);
    cxSp(content);
    root.appendChild(content);
    cxSp(root);
    return root;
  }

  function pdpGuaranteeTplNode() {
    // v6.7 replacement for cloneTemplate('cx-tpl-pdp-guarantee',
    // 'guarantee'): same live/preview gate, same emission gate (member
    // presence).
    try {
      var d = pdpMember('g');
      if (!d || !pdpMemberAllowed(d, 'guarantee')) return null;
      return pdpGuaranteeBuildNode(d);
    } catch (e) {
      return null;
    }
  }

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

  function cxStarIcon(size) {
    // Static-markup twin of {% render 'cx-icons', icon: 'star', size: n,
    // class: 'cx-trustpilot__brand-star' %} — the one FILLED icon (its
    // shell differs from cxIcon's stroked shell). No dynamic value ever
    // reaches this innerHTML.
    var wrap = document.createElement('div');
    wrap.innerHTML = '<svg class="cx-icon cx-trustpilot__brand-star" width="' + size + '" height="' + size + '" viewBox="0 0 20 20" fill="currentColor" stroke="none" aria-hidden="true" focusable="false"><path d="M10 1.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L1.6 7.7l5.8-.8z"/></svg>';
    return wrap.firstChild || document.createTextNode('');
  }

  function pdpTrustpilotBuildNode(d) {
    var root = cxEl('div', 'cx-trustpilot cx-trustpilot--pdp', ['data-cx-feature', 'trustpilot']);
    cxSp(root);
    var main = cxEl('div', 'cx-trustpilot__main d-flex align-center');
    cxSp(main);
    main.appendChild(cxStarsNode(d.r, 'pdp', 16, bottleStr(d, 'aria')));
    cxSp(main);
    var rating = cxEl('span', 'cx-trustpilot__rating');
    rating.textContent = bottleStr(d, 'label');
    main.appendChild(rating);
    cxSp(main);
    var count = cxEl('span', 'cx-trustpilot__count');
    count.textContent = bottleStr(d, 'cnt');
    main.appendChild(count);
    cxSp(main);
    var brand = cxEl('span', 'cx-trustpilot__brand d-flex align-center');
    cxSp(brand);
    brand.appendChild(cxStarIcon(14));
    cxSp(brand);
    var brandName = document.createElement('span');
    brandName.textContent = 'Trustpilot';
    brand.appendChild(brandName);
    cxSp(brand);
    main.appendChild(brand);
    cxSp(main);
    root.appendChild(main);
    // The old showLink == false / tp_url != blank branches ("link" is
    // emitted like the cart tpr member; blank = no non-whitespace char).
    if (d.link !== false && typeof d.url === 'string' && /\S/.test(d.url)) {
      var a = cxEl('a', 'cx-trustpilot__link no-dec', ['href', cxRawStr(d, 'url'), 'target', '_blank', 'rel', 'noopener nofollow']);
      a.textContent = bottleStr(d, 'view');
      root.appendChild(a);
    }
    return root;
  }

  function pdpTrustpilotTplNode() {
    // v6.7 replacement for cloneTemplate('cx-tpl-pdp-trustpilot',
    // 'trustpilot'): same live/preview gate, same emission gate (member
    // presence).
    try {
      var d = pdpMember('tp');
      if (!d || !pdpMemberAllowed(d, 'trustpilot')) return null;
      return pdpTrustpilotBuildNode(d);
    } catch (e) {
      return null;
    }
  }

  function nudgeBuildNode(d) {
    var root = cxEl('div', 'cx-nudge cx-nudge--panel cx-nudge--pdp', ['data-cx-feature', 'subscription_nudge']);
    cxSp(root);
    var icon = cxEl('div', 'cx-nudge__icon', ['aria-hidden', 'true']);
    cxSp(icon);
    icon.appendChild(cxIcon('refresh', 22));
    cxSp(icon);
    root.appendChild(icon);
    cxSp(root);
    var content = cxEl('div', 'cx-nudge__content');
    cxSp(content);
    var h3 = cxEl('h3', 'cx-nudge__title heading--five');
    h3.textContent = bottleStr(d, 't');
    content.appendChild(h3);
    cxSp(content);
    var p = cxEl('p', 'cx-nudge__body');
    p.textContent = bottleStr(d, 'b');
    content.appendChild(p);
    cxSp(content);
    root.appendChild(content);
    cxSp(root);
    return root;
  }

  function nudgeTplNode() {
    // v6.7 replacement for cloneTemplate('cx-tpl-pdp-nudge',
    // 'subscription_nudge'): same live/preview gate, same emission gate
    // (member presence). The b2b + selling-plan mount conditions are
    // unchanged in init().
    try {
      var d = pdpMember('n');
      if (!d || !pdpMemberAllowed(d, 'subscription_nudge')) return null;
      return nudgeBuildNode(d);
    } catch (e) {
      return null;
    }
  }

  /**
   * SPEC v3 proof stack — template id / feature key pairs in CRO order.
   * Liquid only renders the templates that survived flag + market +
   * per-product + content gating, so a missing template simply skips.
   *
   * v8: the verified_before_after row is retired — the browsable results
   * gallery (blocks/results-gallery.liquid + cellexia-proof.js) replaces
   * the old PDP before/after widget as a standalone merchant-placed
   * block, and the feature's marker lives in cellexia-proof.js now.
   */
  var PROOF_ORDER = [
    ['cx-tpl-pdp-survey', 'derm_survey'],
    ['cx-tpl-pdp-study', 'clinical_study'],
    ['cx-tpl-pdp-batch', 'batch_transparency'],
    ['cx-tpl-pdp-bottle', 'empty_bottle_guarantee']
  ];

  function buildProofStack() {
    try {
      if (document.querySelector('.cx-proof-stack')) return; // idempotent

      var widgets = [];
      for (var i = 0; i < PROOF_ORDER.length; i++) {
        var feature = PROOF_ORDER[i][1];
        var node;
        // v6.2: the survey and bottle slots are JS-built (their templates
        // migrated to builders); v6.7 adds the study/ba/batch slots,
        // completing the proof stack; v8 retires the ba slot (results
        // gallery, see PROOF_ORDER). The cloneTemplate fallback stays for
        // safety but no proof-stack template remains in Liquid.
        if (feature === 'derm_survey') node = surveyTplNode();
        else if (feature === 'clinical_study') node = studyTplNode();
        else if (feature === 'batch_transparency') node = batchTplNode();
        else if (feature === 'empty_bottle_guarantee') node = bottleTplNode();
        else node = cloneTemplate(PROOF_ORDER[i][0], feature);
        if (node) {
          if (feature === 'derm_survey') {
            bindSurveyDisclosure(node);
            bindSurveyMore(node);
          }
          widgets.push({ node: node, feature: feature });
        }
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

  // ================================================================
  // Amazon-pattern widgets (v6.1) — the az module.
  //
  // Eight PDP features carried by the amazon-booster app embed
  // (#cx-az-config + cx-tpl-az-* templates). Everything reuses this
  // file's existing machinery unchanged: cloneTemplate/widgetAllowed
  // for draft gating, the dispatch + delivery engines for the compound
  // delivery line, deliveryFormatDate for page-locale dates,
  // decodeEntities for every t-filtered string, track() for beacons
  // (auto-suppressed in preview). Replacement suppression keys on the
  // same effective/preview helpers (azOn), so a verified preview
  // session sees the swap exactly as live visitors would.
  //
  // We render Amazon's PATTERNS, never their brand — every visible
  // string is a translator-owned `amazon` locale key; nothing in this
  // module composes brand words. Honesty guards re-checked here:
  // bought count hidden when unset/stale (>45 days), stock line only
  // from the theme's real variant availability, delivery line only
  // with a formattable threshold (the over-X clause is mandatory).
  // ================================================================

  var AZ_CFG = null;      // parsed #cx-az-config (cached)
  var AZ_CFG_READ = false;
  var AZ_PROTECTION = 'cellexia-order-protection';

  function azReadConfig() {
    if (AZ_CFG_READ) return AZ_CFG;
    AZ_CFG_READ = true;
    var el = document.getElementById('cx-az-config');
    if (!el) return null;
    try {
      var raw = JSON.parse(el.textContent || '{}');
      if (raw && typeof raw === 'object') {
        var market = el.getAttribute('data-cx-market');
        raw.market = typeof market === 'string' ? market : '';
        AZ_CFG = raw;
      }
    } catch (e) { AZ_CFG = null; }
    return AZ_CFG;
  }

  function azPreviewArmed() {
    var c = azReadConfig();
    return !!(c && c.preview && c.preview.armed === true);
  }

  function azOn(key) {
    // The az twin of the cart's featureOn(): server-computed live
    // effectiveness for real visitors, live-in-simulated-market ∪ draft
    // flags inside a verified preview session. No scope logic in JS.
    if (PREVIEW) {
      return PREVIEW.live[key] === true || PREVIEW.flags[key] === true;
    }
    return !!(AZ_CFG && AZ_CFG.effective && AZ_CFG.effective[key] === true);
  }

  function azCardsOn() {
    // v6.4 mini-flag gate for the app's OWN similar/FBT cards. Liquid
    // emits badgeCards ONLY when the bestsellerOnCards setting + embed
    // checkbox + market scope all hold (setting:true) with the live
    // az_bestseller_badge master baked into .live — deliberately WITHOUT
    // the current product's own badge-data gate (each card's flag keys on
    // that card's product data). Preview follows the azOn() convention on
    // the feature flag; the setting gate still binds (a preview never
    // un-hides a merchant-disabled surface). Fail closed on any miss.
    var bc = AZ_CFG && AZ_CFG.badgeCards;
    if (!bc || typeof bc !== 'object' || bc.setting !== true) return false;
    if (PREVIEW) {
      return PREVIEW.live.az_bestseller_badge === true || PREVIEW.flags.az_bestseller_badge === true;
    }
    return bc.live === true;
  }

  function azT(key, params) {
    // Sentinel-param substitution over the az strings map — the exact
    // dispatchT/deliveryT convention ('' on a miss so callers fail
    // closed; decode BEFORE substitution; textContent-only consumers).
    // Shopify bakes "Translation missing: <locale>.<key>" markers into
    // the config JSON when a locale file lacks the key — treat those
    // exactly like a missing string (the cart-side azStr rule) so no
    // broken text can ever reach a buyer.
    var map = AZ_CFG && AZ_CFG.strings && typeof AZ_CFG.strings === 'object' ? AZ_CFG.strings : {};
    var raw = typeof map[key] === 'string' ? map[key] : '';
    if (!raw || raw.indexOf('Translation missing') === 0) return '';
    var str = decodeEntities(raw);
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

  function azMoney(cents) {
    // Mirrors cellexia-cart.js money(): the theme's own Intl formatter
    // when present, else Intl with the active presentment currency.
    var units = (Number(cents) || 0) / 100;
    try {
      if (window.formatter && typeof window.formatter.format === 'function') {
        return window.formatter.format(units);
      }
    } catch (e) { /* fall through */ }
    var currency = '';
    try {
      if (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) {
        currency = window.Shopify.currency.active;
      }
    } catch (e) { /* noop */ }
    if (!currency && AZ_CFG && typeof AZ_CFG.currency === 'string') currency = AZ_CFG.currency;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(units);
    } catch (e2) {
      return units.toFixed(2);
    }
  }

  function azPageLocale() {
    return AZ_CFG && typeof AZ_CFG.pageLocale === 'string' && AZ_CFG.pageLocale ? AZ_CFG.pageLocale : '';
  }

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

  function azFetchJSON(url, options) {
    return window.fetch(url, options || { headers: { Accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function azRemoveAll(selector) {
    try {
      var nodes = document.querySelectorAll(selector);
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
      }
    } catch (e) { /* noop */ }
  }

  function azWillReplace(key) {
    // True when the az replacement for `key` is on for this session AND
    // its (v6.2 JS-built) widget would render — i.e. azInit() (which
    // runs later in the same task) will suppress the classic widget the
    // key replaces. Used to keep the classic impression beacons honest:
    // a widget removed before paint must never be recorded as seen.
    // Same gates as azTpl(): azOn (the old widgetAllowed rule) + the
    // az_any_*-gated config payload (the old template-emission gate).
    try {
      azReadConfig();
      if (!azOn(key)) return false;
      return azTplPayload(key);
    } catch (e) { return false; }
  }

  function azReplacesDelivery() {
    // az_delivery_line additionally requires a renderable line (the same
    // fail-closed azDeliveryData gate its mount uses): when the az line
    // cannot render, the classic widgets stay in place and their beacons
    // must fire normally. Gap-fill first so the shared engines see the
    // az embed's config even before azInit() ran.
    try {
      if (!azWillReplace('az_delivery_line')) return false;
      azGapFillConfig();
      return azDeliveryData() !== null;
    } catch (e) { return false; }
  }

  // ------------------------------------------------ product / variant data

  function azProductData() {
    return AZ_CFG && AZ_CFG.product && typeof AZ_CFG.product === 'object' ? AZ_CFG.product : null;
  }

  function azCurrentVariantId() {
    // Theme truth first: the sm-rc hidden variant selector, then the
    // active tier button, then the Liquid-baked initial selection.
    try {
      var sel = document.querySelector('select[sm-rc-variant-selector]');
      if (sel && sel.selectedIndex >= 0 && sel.options && sel.options[sel.selectedIndex]) {
        var v = sel.options[sel.selectedIndex].value;
        if (v) return String(v);
      }
    } catch (e) { /* noop */ }
    try {
      var btn = document.querySelector('.option__wrap .active[data-val-id]');
      if (btn) {
        var b = btn.getAttribute('data-val-id');
        if (b) return String(b);
      }
    } catch (e) { /* noop */ }
    var p = azProductData();
    return p && p.selectedVariant != null ? String(p.selectedVariant) : '';
  }

  function azVariantInfo(id) {
    var p = azProductData();
    if (!p || !p.variants || typeof p.variants !== 'object') return null;
    var v = p.variants[String(id)];
    return v && typeof v === 'object' ? v : null;
  }

  function azRegionName(code) {
    // Country NAME in the PAGE language via Intl.DisplayNames
    // (auto-translated, no locale strings needed). '' on any miss —
    // callers fail closed to hiding the row.
    try {
      var wh = typeof code === 'string' ? code.toUpperCase() : '';
      if (!/^[A-Z]{2}$/.test(wh)) return '';
      if (!window.Intl || typeof Intl.DisplayNames !== 'function') return '';
      var locale = azPageLocale();
      if (!locale) return '';
      var name = new Intl.DisplayNames([locale], { type: 'region' }).of(wh);
      return typeof name === 'string' ? name : '';
    } catch (e) {
      return '';
    }
  }

  function azWarehouseName() {
    // az_microcopy's warehouse source: the shared shipsFrom member.
    var sf = AZ_CFG && AZ_CFG.shipsFrom;
    return azRegionName(sf && typeof sf.warehouse === 'string' ? sf.warehouse : '');
  }

  function azShipsWarehouseName() {
    // az_ships_from's warehouse source (v6.8 split): the feature's own
    // gated `ships` config member carries the resolved warehouse. No
    // merchant free-text fallback here — no resolvable country, no line.
    var sh = AZ_CFG && AZ_CFG.ships;
    return azRegionName(sh && typeof sh.warehouse === 'string' ? sh.warehouse : '');
  }

  function azShipsFormat() {
    // v6.10 merchant-selectable ships-from display format, decoded
    // fail-closed from the lean code the Liquid ships member carries
    // ('p' = prominent; anything else — including old metafield mirrors
    // without the member — renders the subtle pre-v6.10 default).
    // Inside a VERIFIED preview session the armed DRAFT code
    // (preview.sf, tokenless closed enum) wins — the survey alt-format
    // convention; real visitors never read the draft.
    var f = AZ_CFG && AZ_CFG.ships && typeof AZ_CFG.ships.f === 'string' ? AZ_CFG.ships.f : '';
    if (PREVIEW) {
      var draft = AZ_CFG && AZ_CFG.preview && typeof AZ_CFG.preview.sf === 'string' ? AZ_CFG.preview.sf : '';
      if (draft === 's' || draft === 'p') f = draft;
    }
    return f === 'p' ? 'p' : 's';
  }

  // ------------------------------------------------- az_bestseller_badge

  function azMountBestseller() {
    try {
      if (document.querySelector('.cx-az-bestseller')) return; // idempotent
      var node = azTpl('az_bestseller_badge');
      if (!node) return;
      var heading = document.querySelector('.pdp__info .pdp__heading') || document.querySelector('.pdp__heading');
      if (!heading || !heading.parentNode) return;
      try { heading.parentNode.insertBefore(node, heading); } catch (e) { return; }
      track('az_bestseller_badge');
    } catch (e) { /* never break the theme */ }
  }

  // ---------------------------------------------------- az_bought_count

  function azMountBought() {
    try {
      if (document.querySelector('.cx-az-bought')) return; // idempotent
      var node = azTpl('az_bought_count');
      if (!node) return;
      var n = parseInt(node.getAttribute('data-cx-az-n'), 10);
      var set = parseInt(node.getAttribute('data-cx-az-set'), 10);
      if (!isFinite(n) || n <= 0 || !isFinite(set) || set <= 0) return;
      // Honesty guard re-checked client-side: entered more than 45 days
      // ago (page cache included) -> hidden, never an outdated claim.
      var age = Math.floor(Date.now() / 1000) - set;
      if (age < 0 || age > 45 * 86400) return;
      var str = azT('amazon.bought_count');
      if (!str) return;
      var compact = azCompact(n);
      if (!compact) return;
      var parts = str.split('@@N@@');
      if (parts.length >= 2) {
        node.appendChild(document.createTextNode(parts[0]));
        var strong = document.createElement('strong');
        strong.className = 'cx-az-bought__n';
        strong.textContent = compact;
        node.appendChild(strong);
        node.appendChild(document.createTextNode(parts.slice(1).join('@@N@@')));
      } else {
        node.textContent = azT('amazon.bought_count', { n: compact });
      }
      var anchor = document.querySelector('.pdp__reviews') || document.querySelector('.pdp__heading');
      if (!anchor || !insertAfter(node, anchor)) return;
      track('az_bought_count');
    } catch (e) { /* never break the theme */ }
  }

  // ------------------------------ az_stock_line + az_ships_from (v6.8)
  //
  // The v6.8 split: two independently toggleable, independently
  // market-scoped features sharing the one .cx-az-stock container —
  // az_stock_line owns the green "In Stock" line, az_ships_from owns
  // the "Ships from {country}" line. EITHER line alone replaces the
  // theme's own .stock-msg while effective; when both are effective
  // both lines render (the pre-split combined look). Restore semantics
  // unchanged: the swap still keys on the selected variant's real
  // availability, and the theme message comes back verbatim.

  var azStockState = null; // { node, themeMsg, prevDisplay, stockOn, shipsOn, tracked, trackedShips }

  function azStockAllowed() {
    // The green "In Stock" line on its own key — the standard
    // effective/draft gate (azOn) + the feature's gated config payload.
    return azOn('az_stock_line') && azTplPayload('az_stock_line');
  }

  function azShipsAllowed() {
    // The "Ships from" line on its OWN key (v6.8). The caller still
    // requires a resolvable warehouse name — no warehouse, no line
    // (fail closed), even while the feature is on.
    return azOn('az_ships_from') && azTplPayload('az_ships_from');
  }

  function azStockSync() {
    // Honest swap: the replacement lines show ONLY while the currently
    // selected variant is really available (theme variant data baked
    // into the az config); otherwise the theme's own .stock-msg is
    // restored untouched. Re-run on every variant change. Each line
    // logs its OWN impression, once, and only when actually shown.
    var st = azStockState;
    if (!st) return;
    try {
      var info = azVariantInfo(azCurrentVariantId());
      var available = !!(info && info.available === true);
      if (available) {
        st.node.removeAttribute('hidden');
        if (st.themeMsg) st.themeMsg.style.display = 'none';
        if (st.stockOn && !st.tracked) {
          st.tracked = true;
          track('az_stock_line');
        }
        if (st.shipsOn && !st.trackedShips) {
          st.trackedShips = true;
          track('az_ships_from');
        }
      } else {
        st.node.setAttribute('hidden', '');
        if (st.themeMsg) st.themeMsg.style.display = st.prevDisplay;
      }
    } catch (e) { /* never break the theme */ }
  }

  function azMountStock() {
    try {
      if (document.querySelector('.cx-az-stock')) return; // idempotent
      azReadConfig();
      var stockOn = azStockAllowed() && !!azT('amazon.in_stock');
      var shipsLine = '';
      var shipsName = '';
      if (azShipsAllowed()) {
        shipsName = azShipsWarehouseName();
        if (shipsName) shipsLine = azT('amazon.ships_from', { country: shipsName });
      }
      // Neither line renders -> the theme's stock message stays
      // untouched (a replacement must never leave a hole).
      if (!stockOn && !shipsLine) return;
      var grey = document.querySelector('.pdp__grey');
      if (!grey) return;
      var themeMsg = grey.querySelector('.stock-msg');
      var anchor = themeMsg || grey.querySelector('.pdp__actions--flex');
      if (!anchor) return;
      var node = azBuildStock(stockOn, shipsLine, shipsName);
      if (!insertAfter(node, anchor)) return;
      azStockState = {
        node: node,
        themeMsg: themeMsg,
        prevDisplay: themeMsg ? themeMsg.style.display || '' : '',
        stockOn: stockOn,
        shipsOn: !!shipsLine,
        tracked: false,
        trackedShips: false
      };
      azStockSync();
    } catch (e) { /* never break the theme */ }
  }

  // -------------------------------------------------- az_delivery_line
  //
  // The compound Amazon-structure line: "FREE delivery {bold date} on
  // orders over {threshold}" + the bold ticking "Order within ..."
  // clause. Dates and countdown come from the EXISTING delivery +
  // dispatch engines above (never forked); the threshold clause is
  // resolved server-side in the buyer's presentment currency and is
  // mandatory — no formattable threshold, no line (fail closed).

  var azDeliveryTimer = null;

  function azDeliveryData() {
    if (!AZ_CFG || AZ_CFG.thresholdOk !== true) return null;
    var dc = deliveryConfig();
    if (!dc) return null;
    var result = deliveryCompute(dc);
    if (!result) return null;
    var dateL = deliveryFormatDate(result.max, dc.pageLocale);
    if (!dateL) return null;
    var free = azT('amazon.free_delivery');
    var over = azT('amazon.over_threshold');
    if (!free || !over) return null;
    return { date: dateL, free: free, over: over };
  }

  function azDeliveryRender(node) {
    var data = azDeliveryData();
    if (!data) return false;
    var line = node.querySelector('[data-cx-az-del-line]');
    if (!line) return false;
    while (line.firstChild) line.removeChild(line.firstChild);
    line.appendChild(document.createTextNode(data.free + ' '));
    var strong = document.createElement('strong');
    strong.className = 'cx-az-delivery__date';
    strong.textContent = data.date;
    line.appendChild(strong);
    // Threshold clause joined with a plain space UNLESS the translation
    // starts with its own punctuation (fi leads with ", kun ..." — the
    // comma must hug the date, not float after a space).
    line.appendChild(document.createTextNode((data.over.charAt(0) === ',' ? '' : ' ') + data.over));
    // The live countdown clause reuses the dispatch ENGINE wholesale
    // (same credibility window, same fail-closed rules) but prefers the
    // terse Amazon-pattern string amazon.order_within ("Order within
    // 4 hrs 12 mins") over the purpose-tailed dispatch.within sentence;
    // the dispatch strings remain the fallback so the clause never goes
    // mute when a locale lacks the amazon key.
    var count = node.querySelector('[data-cx-az-del-count]');
    if (count) {
      var text = '';
      var schedule = dispatchSchedule();
      var remaining = schedule ? dispatchRemainingMs(schedule) : null;
      if (remaining !== null) {
        var totalMin = Math.floor(remaining / 60000);
        if (totalMin >= 60) {
          text = azT('amazon.order_within', { hours: Math.floor(totalMin / 60), minutes: totalMin % 60 });
          if (!text) text = dispatchT('dispatch.within', { hours: Math.floor(totalMin / 60), minutes: totalMin % 60 });
        } else {
          text = dispatchT('dispatch.within_minutes', { minutes: Math.max(1, Math.ceil(remaining / 60000)) });
        }
      }
      if (text) {
        count.textContent = text;
        count.removeAttribute('hidden');
      } else {
        count.textContent = '';
        count.setAttribute('hidden', '');
      }
    }
    return true;
  }

  function azDeliveryTick() {
    var nodes = document.querySelectorAll('.cx-az-delivery');
    if (!nodes.length) {
      if (azDeliveryTimer) { window.clearInterval(azDeliveryTimer); azDeliveryTimer = null; }
      return;
    }
    for (var i = 0; i < nodes.length; i++) {
      if (!azDeliveryRender(nodes[i])) {
        try {
          if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
        } catch (e) { /* noop */ }
      }
    }
  }

  function azMountDeliveryLine() {
    try {
      if (document.querySelector('.cx-az-delivery')) return; // idempotent
      var node = azTpl('az_delivery_line');
      if (!node) return;
      if (!azDeliveryRender(node)) return; // fail closed: no defensible line
      var grey = document.querySelector('.pdp__grey');
      if (!grey) return;
      // Amazon ordering: the delivery line sits ABOVE the stock line.
      var placed = false;
      var stockNode = grey.querySelector('.stock-msg') || grey.querySelector('.cx-az-stock');
      if (stockNode && stockNode.parentNode === grey) {
        try {
          grey.insertBefore(node, stockNode);
          placed = true;
        } catch (e) { placed = false; }
      }
      if (!placed) {
        var anchor = grey.querySelector('.pdp__actions--flex');
        if (!anchor || !insertAfter(node, anchor)) return;
      }
      // Replacement contract: the standard PDP delivery_estimate widget
      // AND the PDP dispatch_countdown line are suppressed while
      // az_delivery_line is effective (preview sessions included) —
      // but ONLY now that the az line rendered AND was placed. The cart
      // rule applied to the PDP: a fail-closed replacement must never
      // leave the standard widgets mute with nothing in their place.
      azRemoveAll('.pdp__grey .cx-dispatch--pdp');
      azRemoveAll('.pdp__grey .cx-delivery');
      azRemoveAll('.pdp__grey [data-cx-note="dispatch"]');
      if (!azDeliveryTimer) azDeliveryTimer = window.setInterval(azDeliveryTick, 30000);
      track('az_delivery_line');
    } catch (e) { /* never break the theme */ }
  }

  // ------------------------------------------------------ az_microcopy

  function azMountMicrocopy() {
    try {
      if (document.querySelector('.cx-az-micro')) return; // idempotent
      var node = azTpl('az_microcopy');
      if (!node) return;
      var grey = document.querySelector('.pdp__grey');
      if (!grey) return;
      var anchor = grey.querySelector('.pdp__actions--flex') || grey.querySelector('.stock-msg');
      if (!anchor) return;
      // Ships-from row: warehouse country name in the page language,
      // falling back to the merchant-set default label; no label, no row.
      // v6.8.1: when the dedicated az_ships_from line is effective it OWNS
      // "Ships from" — the microcopy row yields so the buy box never says
      // it twice.
      var label = '';
      if (!azShipsAllowed()) {
        label = azWarehouseName();
        if (!label && AZ_CFG && AZ_CFG.shipsFrom && typeof AZ_CFG.shipsFrom.defaultLabel === 'string') {
          label = AZ_CFG.shipsFrom.defaultLabel.replace(/^\s+|\s+$/g, '');
        }
      }
      if (label) {
        var row = node.querySelector('[data-cx-az-micro-ships]');
        var slot = node.querySelector('[data-cx-az-ships-slot]');
        var line = azT('amazon.ships_from', { country: label });
        if (row && slot && line) {
          slot.textContent = line;
          row.removeAttribute('hidden');
        }
      }
      // FREE returns reveal — same accessible disclosure pattern as the
      // survey "how" toggle (click toggles, Escape closes + refocuses).
      var btn = node.querySelector('[data-cx-az-returns]');
      var panel = node.querySelector('.cx-az-micro__panel');
      if (btn && panel) {
        btn.addEventListener('click', function () {
          var open = btn.getAttribute('aria-expanded') === 'true';
          btn.setAttribute('aria-expanded', open ? 'false' : 'true');
          if (open) panel.setAttribute('hidden', '');
          else panel.removeAttribute('hidden');
        });
        node.addEventListener('keydown', function (event) {
          if ((event.key === 'Escape' || event.key === 'Esc') && btn.getAttribute('aria-expanded') === 'true') {
            btn.setAttribute('aria-expanded', 'false');
            panel.setAttribute('hidden', '');
            try { btn.focus(); } catch (e) { /* noop */ }
          }
        });
      }
      if (!insertAfter(node, anchor)) return;
      // Replacement contract: the app-injected PDP trust-badges strip is
      // suppressed while az_microcopy is effective. Theme-editor-placed
      // trust blocks cannot be auto-removed (admin help says so).
      azRemoveAll('.cx-pdp-badges');
      track('az_microcopy');
    } catch (e) { /* never break the theme */ }
  }

  // ------------------------------------------- az_fbt + az_similar_items

  function azPlacement(key) {
    // v6.5 merchant-set placement per widget ('fbt' / 'sim'), carried as
    // single-letter codes in the Liquid config ("place":{"fbt":"t",...}):
    // 't' = tabs_below (directly below the theme's info-tabs box — the
    // default), 'b' = buybox (the classic v6.1 spot under the buy area).
    // Missing/unknown codes (old metafield mirrors) = the default.
    var c = azReadConfig();
    var place = c && c.place;
    return place && place[key] === 'b' ? 'buybox' : 'tabs_below';
  }

  function azFindSections(place) {
    // Attribute compared in JS (not an attribute-value selector) so a
    // shared location container is found across re-mounts.
    var all = document.querySelectorAll('.cx-az-sections');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-cx-az-place') === place) return all[i];
    }
    return null;
  }

  function azNewSections(place) {
    // Same container classes as the proof stack so the wrap tracks the
    // PDP column (responsive max-widths + padding) at every breakpoint.
    var wrap = document.createElement('div');
    wrap.className = 'cx-az-sections container container--md';
    wrap.setAttribute('data-cx-az-place', place);
    return wrap;
  }

  function azSectionsContainer(placement) {
    // ONE container per resolved location; FBT and similar share it when
    // their placements agree (azFbtFinish keeps FBT first inside it).
    // "tabs_below": directly AFTER the theme's .pdp__tabs section (above
    // the "Create your ritual" section). FALLBACK: no tabs anchor (or a
    // failed insert) degrades to the buy-box placement — a placement
    // setting must never cost the merchant the whole section.
    if (placement === 'tabs_below') {
      var tabs = document.querySelector('.pdp__tabs');
      if (tabs && tabs.parentNode) {
        var found = azFindSections('tabs_below');
        if (found) return found;
        var below = azNewSections('tabs_below');
        if (insertAfter(below, tabs)) return below;
      }
    }
    // "buybox" — the classic v6.1 anchor chain: ABOVE the proof stack
    // (FBT reads as part of the buy decision, proof below), else before
    // the tabs, else after the PDP hero section.
    var existing = azFindSections('buybox');
    if (existing) return existing;
    var wrap = azNewSections('buybox');
    var stack = document.querySelector('.cx-proof-stack');
    if (stack && stack.parentNode) {
      try {
        stack.parentNode.insertBefore(wrap, stack);
        return wrap;
      } catch (e) { /* fall through */ }
    }
    var tabs2 = document.querySelector('.pdp__tabs');
    if (tabs2 && tabs2.parentNode) {
      try {
        tabs2.parentNode.insertBefore(wrap, tabs2);
        return wrap;
      } catch (e) { /* fall through */ }
    }
    var pdp = document.querySelector('section.pdp') || document.querySelector('.pdp');
    if (pdp && insertAfter(wrap, pdp)) return wrap;
    return null;
  }

  function azRecImage(product) {
    var img = product.featured_image;
    if (img && typeof img === 'object') img = img.src || img.url || null;
    if (!img && Array.isArray(product.images) && product.images.length) {
      img = product.images[0];
      if (img && typeof img === 'object') img = img.src || img.url || null;
    }
    return typeof img === 'string' && img ? img : null;
  }

  function azSizedImage(url, width) {
    try {
      if (!/^(https?:)?\/\//.test(url)) return url;
      return url + (url.indexOf('?') === -1 ? '?' : '&') + 'width=' + width;
    } catch (e) { return url; }
  }

  function azFetchRecs(productId, intent) {
    var url = routeRoot() + 'recommendations/products.json?product_id=' +
      encodeURIComponent(String(productId)) + '&limit=8&intent=' + intent;
    return azFetchJSON(url)
      .then(function (data) {
        return data && Array.isArray(data.products) ? data.products : [];
      })
      .catch(function () { return []; });
  }

  function azFetchHandleData(handles) {
    // Presentment-correct price/availability via OUR app proxy — the
    // same enrichment source as the cart cross-sell (recommendations
    // payloads are only trusted for handle/title/image/url).
    return azFetchJSON(routeRoot() + 'apps/cellexia/cart-data?handles=' + encodeURIComponent(handles.join(',')))
      .then(function (data) {
        return data && data.productsByHandle && typeof data.productsByHandle === 'object' ? data.productsByHandle : {};
      })
      .catch(function () { return {}; });
  }

  function azFirstAvailableVariant(entry) {
    if (!entry || !Array.isArray(entry.variants)) return null;
    for (var i = 0; i < entry.variants.length; i++) {
      var v = entry.variants[i];
      if (v && v.id != null && v.available !== false && typeof v.price === 'number') return v;
    }
    return null;
  }

  var azFbtBusy = false;

  function azFbtRows(node) {
    return node.querySelectorAll('[data-cx-az-fbt-row]');
  }

  function azFbtUpdate(node) {
    // Live checkbox math: total + button label recomputed on every
    // check/uncheck. Label = "Add both to cart" for exactly two (where
    // the language ships the both form), else the count plural.
    try {
      var rows = azFbtRows(node);
      var total = 0;
      var count = 0;
      for (var i = 0; i < rows.length; i++) {
        var check = rows[i].querySelector('.cx-az-fbt__check');
        if (!check || !check.checked) continue;
        count++;
        total += Number(rows[i].getAttribute('data-price-cents')) || 0;
      }
      var totalEl = node.querySelector('[data-cx-az-fbt-total]');
      if (totalEl) totalEl.textContent = azMoney(total);
      var btn = node.querySelector('[data-cx-az-fbt-add]');
      if (btn) {
        var label = '';
        if (count === 2) label = azT('amazon.fbt_add_both');
        if (!label) label = azT('amazon.fbt_add_' + Math.min(Math.max(count, 1), 4));
        if (label) btn.textContent = label;
        btn.disabled = count < 1 || azFbtBusy;
      }
    } catch (e) { /* never break the theme */ }
  }

  function azFbtSyncThis(node) {
    // The "This item:" row tracks the theme's currently selected
    // variant (tier switches change price) — honest totals always.
    try {
      var row = node.querySelector('[data-cx-this]');
      if (!row) return;
      var vid = azCurrentVariantId();
      var info = vid ? azVariantInfo(vid) : null;
      if (!info || typeof info.price !== 'number') return;
      row.setAttribute('data-variant-id', vid);
      row.setAttribute('data-price-cents', String(info.price));
      var priceEl = row.querySelector('[data-cx-az-fbt-price]');
      if (priceEl) priceEl.textContent = azMoney(info.price);
      azFbtUpdate(node);
    } catch (e) { /* never break the theme */ }
  }

  function azFbtAdd(node) {
    if (azFbtBusy) return;
    var rows = azFbtRows(node);
    var items = [];
    for (var i = 0; i < rows.length; i++) {
      var check = rows[i].querySelector('.cx-az-fbt__check');
      if (!check || !check.checked) continue;
      var id = Number(rows[i].getAttribute('data-variant-id'));
      if (!isFinite(id) || id <= 0) continue;
      items.push({ id: id, quantity: 1, properties: { _cellexia_upsell: 'fbt' } });
    }
    if (!items.length || !window.fetch) return;
    azFbtBusy = true;
    azFbtUpdate(node);
    var done = function () {
      azFbtBusy = false;
      azFbtUpdate(node);
    };
    window.fetch(routeRoot() + 'cart/add.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: items })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function () {
        // Theme refresh convention: refetch the cart and hand it to the
        // theme's own refreshMiniCart (rebuilds the drawer + opens it).
        return azFetchJSON(routeRoot() + 'cart.js').then(function (cart) {
          try {
            if (typeof window.refreshMiniCart === 'function') window.refreshMiniCart(cart);
          } catch (e) { /* noop */ }
        });
      })
      .then(function () {
        track('az_fbt', 'click');
        done();
      })
      .catch(function () {
        done();
      });
  }

  function azFbtFinish(node) {
    // Shared tail for manual (server-rendered rows) and auto (JS-built
    // rows): thumbnail strip joined by "+" glyphs, checkbox math, add
    // button, attachment + beacon. Fewer than two rows = nothing to
    // bundle = no section (no orphan headings).
    try {
      var rows = azFbtRows(node);
      if (rows.length < 2) return;
      azFbtSyncThis(node);
      var strip = node.querySelector('[data-cx-az-fbt-strip]');
      if (strip) {
        var first = true;
        for (var i = 0; i < rows.length; i++) {
          var src = rows[i].getAttribute('data-cx-img');
          if (!src) continue;
          if (!first) {
            var plus = document.createElement('span');
            plus.className = 'cx-az-fbt__plus';
            plus.textContent = '+';
            strip.appendChild(plus);
          }
          var img = document.createElement('img');
          img.className = 'cx-az-fbt__thumb';
          img.src = src;
          img.alt = '';
          img.loading = 'lazy';
          img.width = 100;
          img.height = 100;
          strip.appendChild(img);
          first = false;
        }
      }
      node.addEventListener('change', function (event) {
        var el = event.target;
        if (el && el.className && String(el.className).indexOf('cx-az-fbt__check') !== -1) {
          azFbtUpdate(node);
        }
      });
      var btn = node.querySelector('[data-cx-az-fbt-add]');
      if (btn) {
        btn.addEventListener('click', function () { azFbtAdd(node); });
      }
      azFbtUpdate(node);
      var host = azSectionsContainer(azPlacement('fbt'));
      if (!host) return;
      // FBT always precedes the similar-items row WITHIN a shared
      // container, whichever resolved first (similar is async too);
      // per-widget placements may put them in different containers.
      var similar = host.querySelector('.cx-az-similar');
      if (similar) host.insertBefore(node, similar);
      else host.appendChild(node);
      track('az_fbt');
    } catch (e) { /* never break the theme */ }
  }

  function azFbtRowEl(row) {
    var li = document.createElement('li');
    li.className = 'cx-az-fbt__row';
    li.setAttribute('data-cx-az-fbt-row', '');
    li.setAttribute('data-variant-id', String(row.variantId));
    li.setAttribute('data-price-cents', String(row.priceCents));
    if (row.image) li.setAttribute('data-cx-img', azSizedImage(row.image, 250));
    var label = document.createElement('label');
    label.className = 'cx-az-fbt__label';
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cx-az-fbt__check';
    input.checked = true;
    var text = document.createElement('span');
    text.className = 'cx-az-fbt__text';
    text.textContent = row.title;
    if (row.badge && azCardsOn()) {
      var flag = azBuildRowFlag(row.badge.rank);
      if (flag) text.appendChild(flag);
    }
    label.appendChild(input);
    label.appendChild(text);
    var price = document.createElement('span');
    price.className = 'cx-az-fbt__price';
    price.textContent = azMoney(row.priceCents);
    li.appendChild(label);
    li.appendChild(price);
    return li;
  }

  // FBT <-> similar-items coordination (v6.3): FBT resolves FIRST and
  // publishes the product identities its rows consumed; the similar row
  // awaits them so the page never shows the identical product twice
  // back-to-back. The promise NEVER rejects and every fail-closed path
  // (feature off, manual with no usable rows, fetch missing, network
  // failure) resolves empty sets so similar is never blocked. Module
  // scope only — no new globals.
  var azFbtPicksPromise = null;

  function azFbtEmptyPicks() {
    return { ids: {}, handles: {}, variantIds: {} };
  }

  function azFbtPicks() {
    return azFbtPicksPromise || Promise.resolve(azFbtEmptyPicks());
  }

  function azFbtCollect(products, p, picks, seen) {
    // Shared complementary/related pick filter: dedupe by product id AND
    // handle (`seen` persists across the two fetches so the related
    // fill can never repeat a complementary pick), never the current
    // product or the protection product, title required — capped at the
    // shipped row limit (2 rec rows + the "This item:" row).
    for (var i = 0; i < products.length && picks.length < 2; i++) {
      var pr = products[i];
      if (!pr || typeof pr.handle !== 'string' || !pr.handle) continue;
      if (pr.handle === p.handle || pr.handle === AZ_PROTECTION) continue;
      if (pr.id != null && p.id != null && String(pr.id) === String(p.id)) continue;
      if (seen[pr.handle]) continue;
      if (pr.id != null && seen['#' + String(pr.id)]) continue;
      var title = typeof pr.title === 'string' ? pr.title : '';
      if (!title) continue;
      seen[pr.handle] = true;
      if (pr.id != null) seen['#' + String(pr.id)] = true;
      picks.push({
        handle: pr.handle,
        productId: pr.id != null ? String(pr.id) : '',
        title: title,
        image: azRecImage(pr)
      });
    }
  }

  function azFbtEnrich(picks) {
    // Availability gate: presentment-correct price + first available
    // variant via the app proxy; unavailable/unknown picks drop silently.
    if (!picks.length) return Promise.resolve([]);
    return azFetchHandleData(picks.map(function (pick) { return pick.handle; })).then(function (byHandle) {
      var rows = [];
      picks.forEach(function (pick) {
        var entry = byHandle[pick.handle];
        var variant = azFirstAvailableVariant(entry);
        if (!variant) return;
        rows.push({
          variantId: variant.id,
          priceCents: variant.price,
          title: pick.title,
          image: pick.image,
          handle: pick.handle,
          productId: pick.productId,
          badge: azCardBadge(entry)
        });
      });
      return rows;
    });
  }

  function azMountFbt() {
    try {
      if (document.querySelector('.cx-az-fbt')) return; // idempotent
      var node = azTpl('az_fbt');
      if (!node) return;
      if (node.getAttribute('data-cx-az-mode') === 'manual') {
        // Manual list takes ABSOLUTE precedence — no fetches, no auto
        // fallback. The payload rows only carry variant identity, so
        // that is what similar-items gets to dedupe against.
        try {
          if (typeof Promise !== 'undefined') {
            var mUsed = azFbtEmptyPicks();
            var mRows = azFbtRows(node);
            for (var m = 0; m < mRows.length; m++) {
              if (mRows[m].getAttribute('data-cx-this')) continue;
              var mvid = mRows[m].getAttribute('data-variant-id');
              if (mvid) mUsed.variantIds[String(mvid)] = true;
            }
            azFbtPicksPromise = Promise.resolve(mUsed);
          }
        } catch (e0) { /* similar simply skips the dedupe */ }
        azFbtDecorateManual(node);
        azFbtFinish(node);
        return;
      }
      // Auto: Shopify complementary recommendations for THIS product,
      // enriched through the app proxy — the cart cross-sell's API
      // family. Complementary is EMPTY on stores without Search &
      // Discovery curation, so it falls back to intent=related exactly
      // like the v4.9 cart cross-sell; both empty = no section.
      if (!window.fetch) return;
      var p = azProductData();
      if (!p || p.id == null) return;
      var seen = {};
      var used = azFbtEmptyPicks();
      azFbtPicksPromise = azFetchRecs(p.id, 'complementary')
        .then(function (products) {
          var picks = [];
          azFbtCollect(products, p, picks, seen);
          return azFbtEnrich(picks);
        })
        .then(function (rows) {
          if (rows.length >= 1) return rows;
          // Zero USABLE complementary items (empty payload, or every
          // candidate filtered/unavailable): fetch related and fill.
          // `seen` already holds the complementary picks, so the fill
          // is deduped by product id against them.
          return azFetchRecs(p.id, 'related').then(function (products) {
            var picks = [];
            azFbtCollect(products, p, picks, seen);
            return azFbtEnrich(picks);
          });
        })
        .then(function (rows) {
          var list = rows.length ? node.querySelector('[data-cx-az-fbt-rows]') : null;
          if (list) {
            for (var i = 0; i < rows.length; i++) {
              list.appendChild(azFbtRowEl(rows[i]));
              used.handles[rows[i].handle] = true;
              if (rows[i].productId) used.ids[rows[i].productId] = true;
              if (rows[i].variantId != null) used.variantIds[String(rows[i].variantId)] = true;
            }
            azFbtFinish(node);
          }
          return used;
        })
        .catch(function () { return used; }); // fail closed: no section
    } catch (e) { /* never break the theme */ }
  }

  function azSimilarOverlaps(pick, entry, used) {
    // True when this similar-items candidate is already one of the FBT
    // rows: product id or handle match (auto FBT picks), else any
    // variant-id match (manual FBT rows only carry variant identity;
    // `entry` is the pick's app-proxy product record, so ANY of its
    // variants matching a manual row means the same product).
    if (!used) return false;
    if (used.handles && used.handles[pick.handle] === true) return true;
    if (used.ids && pick.productId && used.ids[pick.productId] === true) return true;
    if (used.variantIds && entry && Array.isArray(entry.variants)) {
      for (var i = 0; i < entry.variants.length; i++) {
        var v = entry.variants[i];
        if (v && v.id != null && used.variantIds[String(v.id)] === true) return true;
      }
    }
    return false;
  }

  function azMountSimilar() {
    try {
      if (document.querySelector('.cx-az-similar')) return; // idempotent
      var node = azTpl('az_similar_items');
      if (!node) return;
      if (!window.fetch) return;
      var p = azProductData();
      if (!p || p.id == null) return;
      // FBT resolves FIRST (its promise never rejects — every FBT
      // fail-closed path resolves empty sets) and similar consumes its
      // picks, so the two sections never repeat a product.
      azFbtPicks()
        .then(function (used) {
          return azFetchRecs(p.id, 'related').then(function (products) {
            var picks = [];
            var seen = {};
            for (var i = 0; i < products.length && picks.length < 6; i++) {
              var pr = products[i];
              if (!pr || typeof pr.handle !== 'string' || !pr.handle) continue;
              if (pr.handle === p.handle || pr.handle === AZ_PROTECTION) continue;
              if (seen[pr.handle]) continue;
              var title = typeof pr.title === 'string' ? pr.title : '';
              if (!title) continue;
              seen[pr.handle] = true;
              picks.push({
                handle: pr.handle,
                productId: pr.id != null ? String(pr.id) : '',
                title: title,
                image: azRecImage(pr),
                url: typeof pr.url === 'string' && pr.url.charAt(0) === '/' ? pr.url : '/products/' + pr.handle
              });
            }
            if (!picks.length) return null;
            return azFetchHandleData(picks.map(function (pick) { return pick.handle; })).then(function (byHandle) {
              var cards = [];
              var overlap = [];
              picks.forEach(function (pick) {
                var entry = byHandle[pick.handle];
                var variant = azFirstAvailableVariant(entry);
                if (!variant) return;
                var card = { pick: pick, priceCents: variant.price, badge: azCardBadge(entry) };
                if (azSimilarOverlaps(pick, entry, used)) overlap.push(card);
                else cards.push(card);
              });
              // Dedupe across the two sections — but a row with the
              // overlap beats an empty row (availability > purity).
              return cards.length ? cards : overlap;
            });
          });
        })
        .then(function (cards) {
          if (!cards || !cards.length) return;
          var list = node.querySelector('[data-cx-az-similar-list]');
          if (!list) return;
          for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            var li = document.createElement('li');
            li.className = 'cx-az-similar__card';
            var a = document.createElement('a');
            a.className = 'cx-az-similar__link no-dec';
            a.href = card.pick.url;
            if (card.pick.image) {
              var img = document.createElement('img');
              img.className = 'cx-az-similar__img';
              img.src = azSizedImage(card.pick.image, 320);
              img.alt = card.pick.title;
              img.loading = 'lazy';
              img.width = 150;
              img.height = 150;
              a.appendChild(img);
            }
            var title = document.createElement('span');
            title.className = 'cx-az-similar__name';
            title.textContent = card.pick.title;
            a.appendChild(title);
            var price = document.createElement('span');
            price.className = 'cx-az-similar__price';
            price.textContent = azMoney(card.priceCents);
            a.appendChild(price);
            if (card.badge && azCardsOn()) {
              var flag = azBuildCardFlag(card.badge.rank, card.badge.category);
              if (flag) a.insertBefore(flag, a.firstChild);
            }
            li.appendChild(a);
            list.appendChild(li);
          }
          var host = azSectionsContainer(azPlacement('sim'));
          if (!host) return;
          host.appendChild(node);
          track('az_similar_items');
        })
        .catch(function () { /* fail closed: no section */ });
    } catch (e) { /* never break the theme */ }
  }

  // -------------------------------------------------------- az_buy_box
  //
  // DOM surgery on the theme's own buy area: .pdp__grey becomes the
  // bordered decision card, the theme's price block + variant options
  // are pulled inside (moved nodes keep their jQuery bindings), and the
  // card's direct children are re-ordered to the Amazon pattern: price,
  // delivery line(s), stock line, variant control, quantity + ATC,
  // microcopy rows. Runs LAST so it sees every mounted widget. Any
  // missing anchor degrades gracefully (chrome only, or full no-op).

  var AZ_BUYBOX_ORDER = [
    '.pdp__price',
    '.cx-az-delivery',
    '.cx-dispatch--pdp',
    '.cx-delivery',
    '.cx-az-stock',
    '.stock-msg',
    '.pdp__options',
    '.pdp__actions--flex',
    '.cx-az-micro',
    '.cx-pdp-badges'
  ];

  function azMountBuyBox() {
    try {
      if (!azOn('az_buy_box')) return;
      var grey = document.querySelector('.pdp__grey');
      if (!grey) return; // graceful no-op: anchor missing
      if (grey.getAttribute('data-cx-az-buybox') === '1') return; // idempotent
      grey.setAttribute('data-cx-az-buybox', '1');
      grey.classList.add('cx-az-buybox');
      grey.setAttribute('data-cx-feature', 'az_buy_box');
      try {
        var price = document.querySelector('.pdp__info .pdp__price') || document.querySelector('.pdp__price');
        if (price && !grey.contains(price)) grey.insertBefore(price, grey.firstChild);
        var opts = document.querySelector('.pdp__info .pdp__options') || document.querySelector('.pdp__options');
        if (opts && !grey.contains(opts)) grey.appendChild(opts);
        var anchor = document.createComment('cx-az-order');
        grey.insertBefore(anchor, grey.firstChild);
        for (var i = 0; i < AZ_BUYBOX_ORDER.length; i++) {
          var nodes = grey.querySelectorAll(AZ_BUYBOX_ORDER[i]);
          for (var j = 0; j < nodes.length; j++) {
            if (nodes[j].parentNode === grey) grey.insertBefore(nodes[j], anchor);
          }
        }
        grey.removeChild(anchor);
      } catch (e) { /* chrome without reorder is still a valid card */ }
      track('az_buy_box');
    } catch (e) { /* never break the theme */ }
  }

  // -------------------------------------------------- variant re-sync

  var azVariantBound = false;

  function azVariantSync() {
    try { azStockSync(); } catch (e) { /* noop */ }
    try {
      var fbt = document.querySelector('.cx-az-fbt');
      if (fbt) azFbtSyncThis(fbt);
    } catch (e) { /* noop */ }
  }

  function azBindVariantSync() {
    if (azVariantBound) return;
    azVariantBound = true;
    try {
      // The theme swaps variants via tier buttons + a hidden sm-rc
      // selector; re-sync shortly after either signal (delegated, so
      // late-rendered controls are covered).
      document.addEventListener('click', function (event) {
        var el = event.target;
        while (el && el.nodeType === 1) {
          if (el.matches && el.matches('.option__wrap button')) {
            window.setTimeout(azVariantSync, 80);
            return;
          }
          el = el.parentNode;
        }
      });
      document.addEventListener('change', function (event) {
        var el = event.target;
        if (el && el.matches && el.matches('select[sm-rc-variant-selector], [sm-rc-variant-selector]')) {
          window.setTimeout(azVariantSync, 0);
        }
      });
    } catch (e) { /* noop */ }
  }

  // ================================================================
  // v6.2 Liquid diet — JS-built az widget markup.
  //
  // The az PDP widgets' <template> fragments moved out of
  // amazon-booster.liquid (Shopify caps an extension's total Liquid at
  // 100KB). Each builder reproduces the old template body 1:1 — same
  // tags, classes and attributes in the same order, single-space text
  // nodes where the template's newlines rendered — and every dynamic
  // value still reaches the DOM via textContent / setAttribute only
  // (cxIcon's innerHTML sees exclusively the static icon constants).
  // Gating is unchanged in effect: azTpl(key) requires azOn(key) — the
  // exact widgetAllowed() live/preview rule — AND the widget's
  // az_any_*-gated config payload, which the Liquid emits precisely
  // when it used to emit the template (embed setting + honesty data
  // gates included), so disarmed pages and previews behave as before.

  var CX_AZ_ICONS = {
    // stroke-width + inner markup; outer <svg> shell is composed in
    // cxIcon and is byte-equal to the cx-icons snippet output.
    lock: ['1.5', '<rect x="3.5" y="8.5" width="13" height="9" rx="2"/><path d="M6.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5"/><circle cx="10" cy="13" r="1.25" fill="currentColor" stroke="none"/>'],
    truck: ['1.5', '<path d="M1.5 4.5h10v9h-10z"/><path d="M11.5 7.5h3.2l3.3 3.3v2.7h-6.5"/><circle cx="5.5" cy="15" r="1.75"/><circle cx="14.5" cy="15" r="1.75"/>'],
    bottle: ['1.5', '<rect x="7.8" y="1.8" width="4.4" height="2.6" rx="0.8"/><path d="M8.6 4.4v1.8M11.4 4.4v1.8"/><path d="M8.6 6.2h2.8c1.7.5 2.8 2 2.8 3.9v5.7a2.2 2.2 0 0 1-2.2 2.2H8a2.2 2.2 0 0 1-2.2-2.2v-5.7c0-1.9 1.1-3.4 2.8-3.9Z"/><path d="M5.8 12.4h8.4"/>'],
    refresh: ['1.5', '<path d="M16.5 8A6.8 6.8 0 0 0 4.2 6.2L2.8 7.9"/><path d="M2.8 3.9v4h4"/><path d="M3.5 12a6.8 6.8 0 0 0 12.3 1.8l1.4-1.7"/><path d="M17.2 16.1v-4h-4"/>'],
    box: ['1.5', '<path d="m10 2.2 7 3.5v8.6l-7 3.5-7-3.5V5.7z"/><path d="M3 5.7l7 3.5 7-3.5"/><path d="M10 9.2v8.6"/><path d="m6.5 3.95 7 3.5"/>'],
    check: ['2', '<path d="m3.5 10.5 4.2 4.2 8.8-9.4"/>'],
    'shield-check': ['1.5', '<path d="M10 1.8 3.5 4.2v5c0 4.2 2.8 7.3 6.5 8.9 3.7-1.6 6.5-4.7 6.5-8.9v-5z"/><path d="m7 9.8 2.2 2.2L13.2 8"/>'],
    question: ['1.5', '<circle cx="10" cy="10" r="7.5"/><path d="M7.8 7.8a2.2 2.2 0 1 1 3.1 2.4c-.7.3-.9.8-.9 1.5"/><circle cx="10" cy="14.1" r="0.9" fill="currentColor" stroke="none"/>'],
    'seal-check': ['1.5', '<circle cx="10" cy="8" r="4.6"/><path d="m8.1 8.1 1.4 1.4 2.4-2.8"/><path d="M4.6 11.4c-1.2 1.4-1.8 3.2-1.7 5 1.7 0 3.3-.7 4.6-1.9"/><path d="M15.4 11.4c1.2 1.4 1.8 3.2 1.7 5-1.7 0-3.3-.7-4.6-1.9"/><path d="m6.2 14.7.9 1"/><path d="m13.8 14.7-.9 1"/>'],
    // v6.7 Liquid diet: icons used only by the migrated ba/batch content
    // widgets — byte-equal twins of the cx-icons snippet cases.
    calendar: ['1.5', '<rect x="2.8" y="4.2" width="14.4" height="13" rx="2"/><path d="M2.8 8.4h14.4"/><path d="M6.8 2.2v3.6M13.2 2.2v3.6"/>'],
    download: ['1.5', '<path d="M10 2.8v9.4"/><path d="m6.4 8.8 3.6 3.6 3.6-3.6"/><path d="M3.5 16.8h13"/>'],
    // v6.7 extended PDP batch: icons used only by the migrated badges
    // widget — byte-equal twins of the cx-icons snippet cases.
    droplet: ['1.5', '<path d="M10 2.2S4.6 8 4.6 12a5.4 5.4 0 0 0 10.8 0c0-4-5.4-9.8-5.4-9.8Z"/><path d="M7.4 12.4a2.6 2.6 0 0 0 2.1 2.5"/>'],
    leaf: ['1.5', '<path d="M16.8 3.2c.3 6.8-2.6 12.4-8.4 12.4-2.3 0-4.2-1.4-4.9-3.3C5 8 9.6 3.9 16.8 3.2Z"/><path d="M3.5 16.5C6 12.5 9.5 9.5 13 7.7"/>']
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

  function cxSvg(tag, cls, attrs) {
    // SVG-namespaced twin of cxEl (the old templates' <svg> markup was
    // namespaced by the HTML parser; createElementNS keeps that true).
    var el = document.createElementNS
      ? document.createElementNS('http://www.w3.org/2000/svg', tag)
      : document.createElement(tag);
    if (cls) el.setAttribute('class', cls);
    if (attrs) {
      for (var i = 0; i < attrs.length; i += 2) el.setAttribute(attrs[i], attrs[i + 1]);
    }
    return el;
  }

  function azHasStr(key) {
    return !!(AZ_CFG && AZ_CFG.strings && typeof AZ_CFG.strings[key] === 'string');
  }

  function azBuildDelivery() {
    var root = cxEl('div', 'cx-az-delivery', ['data-cx-feature', 'az_delivery_line']);
    cxSp(root);
    root.appendChild(cxEl('span', 'cx-az-delivery__line', ['data-cx-az-del-line', '']));
    cxSp(root);
    root.appendChild(cxEl('strong', 'cx-az-delivery__countdown', ['data-cx-az-del-count', '', 'hidden', '']));
    cxSp(root);
    return root;
  }

  function azBuildStock(stockOn, shipsLine, shipsName) {
    // v6.8 split builder: the container renders ONLY the lines whose
    // feature is allowed — In Stock iff az_stock_line (stockOn), Ships
    // from iff az_ships_from resolved a warehouse (shipsLine = the
    // composed text, '' = omit; shipsName = the resolved country name
    // for the v6.10 prominent format). Subtle classes/markup unchanged
    // (CSS + buy-box ordering untouched); each line root carries its
    // own data-cx-feature.
    var root = cxEl('div', 'cx-az-stock', ['hidden', '']);
    cxSp(root);
    if (stockOn) {
      var instock = cxEl('span', 'cx-az-stock__instock', ['data-cx-feature', 'az_stock_line']);
      instock.textContent = azT('amazon.in_stock');
      root.appendChild(instock);
      cxSp(root);
    }
    if (shipsLine) {
      if (azShipsFormat() === 'p') {
        // v6.10 prominent format: the logistics-green row in the
        // In-Stock family — truck icon + the SAME translated sentence
        // with the country name bold. azT WITHOUT params returns the
        // template with its @@COUNTRY@@ sentinel intact, so the split
        // renders prefix span + <strong>country</strong> + suffix span
        // (textContent-only) and stays correct for locales where the
        // country leads or sits mid-sentence (empty prefix/suffix
        // spans collapse). A template missing the sentinel falls back
        // to the composed plain line — never a broken sentence. RTL
        // safety lives in the CSS logical properties.
        var shipsP = cxEl('span', 'cx-az-stock__ships cx-az-stock__ships--prominent', ['data-cx-feature', 'az_ships_from', 'data-cx-az-stock-ships', '']);
        shipsP.appendChild(cxIcon('truck', 15));
        var shipsText = cxEl('span', 'cx-az-stock__ships-text');
        var shipsTpl = azT('amazon.ships_from');
        var shipsParts = shipsTpl.split('@@COUNTRY@@');
        if (shipsParts.length >= 2 && shipsName) {
          var shipsPre = document.createElement('span');
          shipsPre.textContent = shipsParts[0];
          shipsText.appendChild(shipsPre);
          var shipsCountry = cxEl('strong', 'cx-az-stock__ships-country');
          shipsCountry.textContent = shipsName;
          shipsText.appendChild(shipsCountry);
          var shipsSuf = document.createElement('span');
          shipsSuf.textContent = shipsParts.slice(1).join(shipsName);
          shipsText.appendChild(shipsSuf);
        } else {
          shipsText.textContent = shipsLine;
        }
        shipsP.appendChild(shipsText);
        root.appendChild(shipsP);
        cxSp(root);
      } else {
        var ships = cxEl('span', 'cx-az-stock__ships', ['data-cx-feature', 'az_ships_from', 'data-cx-az-stock-ships', '']);
        ships.textContent = shipsLine;
        root.appendChild(ships);
        cxSp(root);
      }
    }
    return root;
  }

  function azBuildMicro() {
    var root = cxEl('div', 'cx-az-micro', ['data-cx-feature', 'az_microcopy']);
    cxSp(root);
    var row1 = cxEl('div', 'cx-az-micro__row');
    row1.appendChild(cxIcon('lock', 13));
    var secure = document.createElement('span');
    secure.textContent = azT('amazon.secure');
    row1.appendChild(secure);
    cxSp(row1);
    root.appendChild(row1);
    cxSp(root);
    var row2 = cxEl('div', 'cx-az-micro__row', ['data-cx-az-micro-ships', '', 'hidden', '']);
    row2.appendChild(cxIcon('truck', 13));
    row2.appendChild(cxEl('span', null, ['data-cx-az-ships-slot', '']));
    cxSp(row2);
    root.appendChild(row2);
    cxSp(root);
    var row3 = cxEl('div', 'cx-az-micro__row cx-az-micro__row--returns');
    cxSp(row3);
    var btn = cxEl('button', null, ['type', 'button', 'class', 'cx-az-micro__reveal', 'data-cx-az-returns', '', 'aria-expanded', 'false', 'aria-controls', 'cx-az-returns-panel']);
    btn.appendChild(cxIcon('refresh', 13));
    var ret = document.createElement('span');
    ret.textContent = azT('amazon.free_returns');
    btn.appendChild(ret);
    cxSp(btn);
    row3.appendChild(btn);
    cxSp(row3);
    var panel = cxEl('div', 'cx-az-micro__panel', ['id', 'cx-az-returns-panel', 'hidden', '']);
    panel.textContent = azT('guarantee.title');
    row3.appendChild(panel);
    cxSp(row3);
    root.appendChild(row3);
    cxSp(root);
    return root;
  }

  function azBuildBought() {
    var b = AZ_CFG.bought;
    return cxEl('p', 'cx-az-bought', ['data-cx-feature', 'az_bought_count', 'data-cx-az-n', String(b.n), 'data-cx-az-set', String(b.set)]);
  }

  function azBuildBest() {
    var root = cxEl('p', 'cx-az-bestseller', ['data-cx-feature', 'az_bestseller_badge']);
    cxSp(root);
    var pill = cxEl('span', 'cx-az-bestseller__pill');
    pill.textContent = azT('amazon.bestseller');
    root.appendChild(pill);
    cxSp(root);
    var cat = cxEl('span', 'cx-az-bestseller__cat');
    cat.textContent = typeof AZ_CFG.bestCat === 'string' ? AZ_CFG.bestCat : '';
    root.appendChild(cat);
    cxSp(root);
    return root;
  }

  // v6.4 badge-everywhere: compact variants of the bestseller flag for
  // product CARDS (the app's own similar-items/FBT rows here; theme cards
  // site-wide get the byte-twin overlay from cellexia-cart.js). NOT part
  // of a v6.2 template migration — these elements never existed in the
  // Liquid templates; azCardsOn() + per-product badge data gate them.
  // All dynamic values land via textContent.

  function azBuildCardFlag(rank, category) {
    // Overlay variant for image-corner placement (similar cards).
    var txt = azT('amazon.bestseller_tpl', { rank: rank });
    if (!txt) return null;
    var root = cxEl('span', 'cx-az-cardflag cx-az-cardflag--overlay');
    var pill = cxEl('span', 'cx-az-cardflag__pill');
    pill.textContent = txt;
    root.appendChild(pill);
    var cat = typeof category === 'string' ? category : '';
    if (cat) {
      var catEl = cxEl('span', 'cx-az-cardflag__cat');
      catEl.textContent = cat;
      root.appendChild(catEl);
    }
    return root;
  }

  function azBuildRowFlag(rank) {
    // Inline variant for the dense FBT text rows (pill only — the
    // category still gates the flag upstream, honesty parity with the
    // PDP badge, but the row has no room for the gray suffix).
    var txt = azT('amazon.bestseller_tpl', { rank: rank });
    if (!txt) return null;
    var root = cxEl('span', 'cx-az-cardflag cx-az-cardflag--inline');
    var pill = cxEl('span', 'cx-az-cardflag__pill');
    pill.textContent = txt;
    root.appendChild(pill);
    return root;
  }

  function azCardBadge(entry) {
    // {rank, category} from an app-proxy productsByHandle entry (v6.4
    // payload — category arrives LOCALIZED, metafield-first server-side);
    // null unless the honesty gate (rank>0 + nonblank category) holds.
    var b = entry && entry.bestseller;
    if (b && typeof b === 'object' && typeof b.rank === 'number' && b.rank > 0 &&
        typeof b.category === 'string' && b.category) {
      return { rank: b.rank, category: b.category };
    }
    return null;
  }

  function azFbtDecorateManual(node) {
    // Manual FBT rows are azBuildFbt()-built from the Liquid payload —
    // their badge data (bRank/bCat, category metafield-first) rides the
    // same payload rows. Post-build decoration keeps the builder output
    // byte-identical to the migrated v6.1 template (prover Tier-3).
    try {
      if (!azCardsOn()) return;
      var f = AZ_CFG && AZ_CFG.fbt;
      var rows = f && f.rows && f.rows.length ? f.rows : null;
      if (!rows) return;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r || typeof r !== 'object') continue;
        var rank = Number(r.bRank);
        var cat = typeof r.bCat === 'string' ? r.bCat : '';
        if (!(rank > 0) || !cat) continue;
        var li = node.querySelector('[data-variant-id="' + String(r.id) + '"]');
        if (!li || li.getAttribute('data-cx-this')) continue;
        var text = li.querySelector('.cx-az-fbt__text');
        if (!text || text.querySelector('.cx-az-cardflag')) continue; // idempotent
        var flag = azBuildRowFlag(rank);
        if (flag) text.appendChild(flag);
      }
    } catch (e) { /* never break the theme */ }
  }

  function azBuildFbtRowLi(row, isThis) {
    var li = document.createElement('li');
    li.setAttribute('class', 'cx-az-fbt__row');
    li.setAttribute('data-cx-az-fbt-row', '');
    if (isThis) li.setAttribute('data-cx-this', '1');
    li.setAttribute('data-variant-id', String(row.id));
    li.setAttribute('data-price-cents', String(row.price));
    if (row.img) li.setAttribute('data-cx-img', String(row.img));
    cxSp(li);
    var label = cxEl('label', 'cx-az-fbt__label');
    cxSp(label);
    var input = cxEl('input', null, ['type', 'checkbox', 'class', 'cx-az-fbt__check', 'checked', '']);
    if (isThis) input.setAttribute('disabled', '');
    label.appendChild(input);
    cxSp(label);
    var text = cxEl('span', 'cx-az-fbt__text');
    if (isThis) {
      var strong = cxEl('strong', 'cx-az-fbt__this');
      strong.textContent = azT('amazon.fbt_this_item');
      text.appendChild(strong);
      text.appendChild(document.createTextNode(' ' + String(row.title)));
    } else {
      text.textContent = String(row.title);
    }
    label.appendChild(text);
    cxSp(label);
    li.appendChild(label);
    cxSp(li);
    var price = isThis
      ? cxEl('span', 'cx-az-fbt__price', ['data-cx-az-fbt-price', ''])
      : cxEl('span', 'cx-az-fbt__price');
    price.textContent = String(row.priceFmt);
    li.appendChild(price);
    cxSp(li);
    return li;
  }

  function azBuildFbt() {
    var f = AZ_CFG.fbt;
    var p = azProductData();
    if (!f || typeof f !== 'object' || !p) return null;
    var mode = f.mode === 'manual' ? 'manual' : 'auto';
    var vid = p.selectedVariant != null ? String(p.selectedVariant) : '';
    var info = azVariantInfo(vid);
    var root = cxEl('section', 'cx-az-fbt', ['data-cx-feature', 'az_fbt', 'data-cx-az-mode', mode]);
    cxSp(root);
    var h = cxEl('h2', 'cx-az-fbt__title heading--four');
    h.textContent = azT('amazon.fbt_title');
    root.appendChild(h);
    cxSp(root);
    root.appendChild(cxEl('div', 'cx-az-fbt__strip', ['data-cx-az-fbt-strip', '', 'aria-hidden', 'true']));
    cxSp(root);
    var ul = cxEl('ul', 'cx-az-fbt__rows list-reset', ['data-cx-az-fbt-rows', '']);
    cxSp(ul);
    ul.appendChild(azBuildFbtRowLi({
      id: vid,
      price: info && typeof info.price === 'number' ? info.price : '',
      priceFmt: typeof f.priceFmt === 'string' ? f.priceFmt : '',
      title: typeof f.title === 'string' ? f.title : '',
      img: typeof f.img === 'string' ? f.img : ''
    }, true));
    if (mode === 'manual' && f.rows && f.rows.length) {
      for (var i = 0; i < f.rows.length && i < 3; i++) {
        var r = f.rows[i];
        if (r && typeof r === 'object') ul.appendChild(azBuildFbtRowLi(r, false));
      }
    }
    root.appendChild(ul);
    cxSp(root);
    var summary = cxEl('div', 'cx-az-fbt__summary');
    cxSp(summary);
    var totalLabel = cxEl('span', 'cx-az-fbt__total-label');
    totalLabel.textContent = azT('amazon.fbt_total');
    summary.appendChild(totalLabel);
    cxSp(summary);
    summary.appendChild(cxEl('strong', 'cx-az-fbt__total', ['data-cx-az-fbt-total', '']));
    cxSp(summary);
    root.appendChild(summary);
    cxSp(root);
    root.appendChild(cxEl('button', null, ['type', 'button', 'class', 'btn btn--primary cx-az-fbt__add', 'data-cx-az-fbt-add', '']));
    cxSp(root);
    return root;
  }

  function azBuildSimilar() {
    var root = cxEl('section', 'cx-az-similar', ['data-cx-feature', 'az_similar_items']);
    cxSp(root);
    var h = cxEl('h2', 'cx-az-similar__title heading--four');
    h.textContent = azT('amazon.similar_title');
    root.appendChild(h);
    cxSp(root);
    var scroll = cxEl('div', 'cx-az-similar__scroll');
    cxSp(scroll);
    scroll.appendChild(cxEl('ul', 'cx-az-similar__list list-reset', ['data-cx-az-similar-list', '']));
    cxSp(scroll);
    root.appendChild(scroll);
    cxSp(root);
    return root;
  }

  function azTplPayload(key) {
    // The server used to gate each <template> emission on az_any_* — the
    // same booleans now gate the widget's config payload, so payload
    // presence IS template presence (embed settings + honesty gates
    // included). Missing payload = fail closed, exactly like a missing
    // template.
    if (!AZ_CFG) return false;
    if (key === 'az_delivery_line') return AZ_CFG.thresholdOk === true;
    if (key === 'az_stock_line') return !!(AZ_CFG.stock && typeof AZ_CFG.stock === 'object') && azHasStr('amazon.in_stock');
    if (key === 'az_ships_from') return !!(AZ_CFG.ships && typeof AZ_CFG.ships === 'object') && azHasStr('amazon.ships_from');
    if (key === 'az_microcopy') return azHasStr('amazon.secure');
    if (key === 'az_bought_count') return !!(AZ_CFG.bought && typeof AZ_CFG.bought === 'object');
    if (key === 'az_bestseller_badge') return azHasStr('amazon.bestseller');
    if (key === 'az_fbt') return !!(AZ_CFG.fbt && typeof AZ_CFG.fbt === 'object');
    if (key === 'az_similar_items') return azHasStr('amazon.similar_title');
    return false;
  }

  function azTpl(key) {
    // v6.2 replacement for cloneTemplate('cx-tpl-az-*', key): same
    // effective/draft gate (azOn === widgetAllowed semantics), same
    // server emission gate (azTplPayload), fresh built node or null.
    try {
      azReadConfig();
      if (!azOn(key) || !azTplPayload(key)) return null;
      if (key === 'az_delivery_line') return azBuildDelivery();
      // az_stock_line / az_ships_from: not served here — azMountStock
      // gates each line on its own key and calls azBuildStock directly
      // (v6.8 split; the builder needs both lines' verdicts at once).
      if (key === 'az_microcopy') return azBuildMicro();
      if (key === 'az_bought_count') return azBuildBought();
      if (key === 'az_bestseller_badge') return azBuildBest();
      if (key === 'az_fbt') return azBuildFbt();
      if (key === 'az_similar_items') return azBuildSimilar();
      return null;
    } catch (e) {
      return null;
    }
  }

  // -------------------------------------------------------- az entry

  function azGapFillConfig() {
    // Gap-fill the classic config so the shared engines run when the
    // amazon-booster embed is the only one emitting anything. Never
    // overrides a value the classic block already provided. Idempotent
    // — shared by azInit() and the pre-mount beacon-honesty checks.
    var c = azReadConfig();
    if (!c) return false; // embed absent / config missing: nothing to do
    if (!cfg || typeof cfg !== 'object') cfg = {};
    if (!cfg.market && typeof c.market === 'string') cfg.market = c.market;
    if (!cfg.dispatch && c.dispatch) cfg.dispatch = c.dispatch;
    if (!cfg.delivery && c.delivery) cfg.delivery = c.delivery;
    if (!cfg.deliveryStrings && c.deliveryStrings) cfg.deliveryStrings = c.deliveryStrings;
    if (c.strings && typeof c.strings === 'object') {
      if (!cfg.strings || typeof cfg.strings !== 'object') cfg.strings = {};
      if (typeof cfg.strings['dispatch.within'] !== 'string' && typeof c.strings['dispatch.within'] === 'string') {
        cfg.strings['dispatch.within'] = c.strings['dispatch.within'];
      }
      if (typeof cfg.strings['dispatch.within_minutes'] !== 'string' && typeof c.strings['dispatch.within_minutes'] === 'string') {
        cfg.strings['dispatch.within_minutes'] = c.strings['dispatch.within_minutes'];
      }
    }
    return true;
  }

  function azInit() {
    try {
      if (!azGapFillConfig()) return; // embed absent / config missing
      azMountBestseller();
      azMountBought();
      azMountStock();
      azMountDeliveryLine();
      azMountMicrocopy();
      azMountFbt();
      azMountSimilar();
      azMountBuyBox();
      azBindVariantSync();
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
          var badges = badgesTplNode();
          if (badges && insertAfter(badges, anchor)) {
            anchor = badges;
            // Impression honesty (v6.1): azMountMicrocopy removes this
            // strip later in the SAME task while az_microcopy is
            // effective — removed before paint means no beacon.
            if (!azWillReplace('az_microcopy')) track('trust_badges');
          }
          var guarantee = pdpGuaranteeTplNode();
          if (guarantee && insertAfter(guarantee, anchor)) {
            anchor = guarantee;
            track('guarantee');
          }
          var trustpilot = pdpTrustpilotTplNode();
          if (trustpilot && insertAfter(trustpilot, anchor)) {
            track('trustpilot');
          }
        }

        // --- subscription nudge under the selling-plan widget ---
        if (!isB2B(cfg) && productHasSellingPlans()) {
          var container = planWidgetContainer();
          var nudge = nudgeTplNode();
          if (container && nudge && insertAfter(nudge, container)) {
            track('subscription_nudge');
          }
        }
      }

      // --- dispatch countdown (v5.0), directly after .stock-msg ---
      mountDispatch();

      // --- delivery estimate (v5.9), stacked right after the countdown ---
      mountDelivery();

      // --- SPEC v3 proof stack (has its own anchors + fallbacks) ---
      buildProofStack();

      // --- guarantee-check modal trigger (v4.9) ---
      bindGuaranteeCheck();

      // --- Amazon-pattern widgets (v6.1) — after the classic mounts so
      // the replacement suppressions see the final standard DOM ---
      azInit();
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
    // v6.1: the amazon-booster embed arms preview independently of the
    // classic block (it may be the only embed emitting anything).
    var armed = !!(cfg.preview && cfg.preview.armed === true) || azPreviewArmed();
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
          // v8: cellexia-proof.js (press/endorsements/results blocks) reads
          // this flag to suppress beacons and admit draft-only islands in a
          // VERIFIED preview session — it has no access to PREVIEW itself.
          window.CellexiaBooster.__preview = true;
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
