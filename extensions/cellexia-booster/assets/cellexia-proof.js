/**
 * Cellexia AOV/LTV Booster — proof-library runtime (v8).
 *
 * Renders the three proof-library surfaces from their JSON config islands
 * plus the /apps/cellexia/proof app-proxy endpoint:
 *
 *   #cx-press-config    → "As seen in the press" band     (feature: press)
 *   #cx-endo-config     → dermatologist endorsement wall  (feature: derm_endorsements)
 *   #cx-results-config  → verified results gallery        (feature: verified_before_after)
 *
 * Same discipline as cellexia-pdp.js: ES5 IIFE, textContent-only sinks,
 * try/catch fail-closed everywhere, and NO markup-string sink anywhere in
 * this file — SVG is built via createElementNS (pfSvg) and entity decode
 * is a bounded, ordered replace chain (pfDecode), not the textarea trick,
 * so the harness escape-discipline count for this file is zero. Every URL
 * the API serves passes the pfHttps gate before it may reach el.src/href.
 * API-served text (quotes, testimonials, names) is RAW — it goes straight
 * to textContent, never decoded, never parsed.
 *
 * Helpers are pf-prefixed twins of the pdp helpers (pfEl/pfSp/pfSvg/
 * pfDecode/pfTrack…) so the sims that extract cxEl/cxSp/decodeEntities/
 * track from cellexia-pdp.js by name never meet duplicates here.
 *
 * Beacon suppression contract (mirrors PREVIEW/BEACONS_OFF): cellexia-
 * pdp.js boot() sets window.CellexiaBooster.__preview = true once a
 * preview session is server-verified; pfBeaconsOff() additionally treats
 * a present sessionStorage cx_preview_token as "possibly the merchant's
 * preview session" (the indeterminate-verdict window) and stays silent.
 */
(function () {
  'use strict';

  if (!window.JSON || !document.querySelector || !document.addEventListener) return;

  window.CellexiaBooster = window.CellexiaBooster || {};
  if (window.CellexiaBooster.__proofLoaded) return;
  window.CellexiaBooster.__proofLoaded = true;

  // Market handle for beacon attribution — read from the first config
  // island that carries data-cx-market (all islands on a page agree).
  var PF_MARKET = '';

  // ------------------------------------------------------------ helpers

  function pfRouteRoot() {
    try {
      if (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) {
        return window.Shopify.routes.root;
      }
    } catch (e) { /* noop */ }
    return '/';
  }

  function pfEl(tag, cls, attrs) {
    // class first (template attribute order), then attrs as flat
    // [name, value, ...] pairs — pf twin of cxEl.
    var el = document.createElement(tag);
    if (cls) el.setAttribute('class', cls);
    if (attrs) {
      for (var i = 0; i < attrs.length; i += 2) el.setAttribute(attrs[i], attrs[i + 1]);
    }
    return el;
  }

  function pfSp(el) {
    // Single collapsed-space text node (the pdp builders' spacing
    // convention) — pf twin of cxSp.
    el.appendChild(document.createTextNode(' '));
    return el;
  }

  function pfSvg(tag, cls, attrs) {
    // SVG-namespaced twin of pfEl. No markup-string icon trick in this
    // file: every SVG node is composed element-by-element.
    var el = document.createElementNS
      ? document.createElementNS('http://www.w3.org/2000/svg', tag)
      : document.createElement(tag);
    if (cls) el.setAttribute('class', cls);
    if (attrs) {
      for (var i = 0; i < attrs.length; i += 2) el.setAttribute(attrs[i], attrs[i + 1]);
    }
    return el;
  }

  function pfDecode(str) {
    // The islands' str maps carry Liquid t-filter output, which HTML-
    // escapes exactly the five HTML-significant characters before | json
    // wraps it. A bounded, ordered replace chain decodes them without any
    // markup-parsing trick; &amp; is decoded LAST so double-escaped
    // input collapses one level only (no over-decode). Decoded output
    // may reach textContent (and aria-label, the gcheck precedent) —
    // never a markup sink, never a URL attribute.
    if (typeof str !== 'string' || str.indexOf('&') === -1) return str;
    return str
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function pfStr(map, key) {
    // Decoded island-string reader (bottleStr's shape): '' on any miss so
    // callers can degrade per-string instead of throwing.
    return map && typeof map[key] === 'string' ? pfDecode(map[key]) : '';
  }

  function pfHttps(url) {
    // THE gate for every URL that may reach el.src / href / <video src>:
    // string, https scheme, no whitespace — anything else becomes '' and
    // the caller drops the image/link entirely. Kills javascript:, data:,
    // protocol-relative and http-only URLs in one place.
    return typeof url === 'string' && /^https:\/\/\S+$/i.test(url) ? url : '';
  }

  function pfVideoFile(url) {
    // Direct media files get an inline <video controls>; anything else
    // (a YouTube page, a portfolio link) is a plain link-out. Extension
    // check runs on the path only — query/hash stripped first.
    if (!pfHttps(url)) return false;
    var path = url.split('#')[0].split('?')[0];
    return /\.(mp4|webm|ogv|ogg|mov|m4v)$/i.test(path);
  }

  function pfPosInt(v) {
    return typeof v === 'number' && isFinite(v) && v > 0 && Math.floor(v) === v;
  }

  function pfPageLocale() {
    try {
      var lang = document.documentElement && document.documentElement.lang;
      if (typeof lang === 'string' && lang) return lang;
    } catch (e) { /* noop */ }
    return 'en';
  }

  function pfRegionName(code) {
    // Country name in the PAGE language via Intl.DisplayNames, with the
    // RAW ISO2 code as fallback — the gallery microline would rather show
    // "DE" than silently drop a datum (azRegionName in the pdp asset
    // fails closed instead because its whole row is optional).
    var cc = typeof code === 'string' ? code.toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(cc)) return '';
    try {
      if (window.Intl && typeof Intl.DisplayNames === 'function') {
        var name = new Intl.DisplayNames([pfPageLocale()], { type: 'region' }).of(cc);
        if (typeof name === 'string' && name) return name;
      }
    } catch (e) { /* fall through to the raw code */ }
    return cc;
  }

  // ------------------------------------------------------------- beacons

  function pfBeaconsOff() {
    // window.CellexiaBooster.__preview: set by cellexia-pdp.js boot()
    // when the preview session is SERVER-VERIFIED. The sessionStorage
    // token check covers the indeterminate window (token present, no
    // verified verdict yet / network trouble): this browser might be the
    // merchant's preview session, so its events must never pollute the
    // data — exactly the pdp BEACONS_OFF fail-safe.
    try {
      if (window.CellexiaBooster && window.CellexiaBooster.__preview) return true;
    } catch (e) { /* noop */ }
    try {
      if (window.sessionStorage && window.sessionStorage.getItem('cx_preview_token')) return true;
    } catch (e) { /* noop */ }
    return false;
  }

  function pfTrack(feature, type) {
    if (pfBeaconsOff()) return;
    try {
      var payload = { feature: feature, type: type || 'impression' };
      if (PF_MARKET) payload.market = PF_MARKET;
      try {
        if (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) {
          payload.currency = window.Shopify.currency.active;
        }
      } catch (e) { /* noop */ }
      var body = JSON.stringify(payload);
      var url = pfRouteRoot() + 'apps/cellexia/track';
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

  // ------------------------------------------------------------- fetch

  function pfQuery(params) {
    // Param object → query-string tail. Skips empty/null/undefined so
    // cleared filters simply vanish from the URL; both key and value are
    // URI-encoded. Returns '' or '&k=v&k2=v2' (proofFetch already opens
    // the query with ?type=).
    var out = [];
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      var v = params[k];
      if (v === null || typeof v === 'undefined' || v === '') continue;
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
    return out.length ? '&' + out.join('&') : '';
  }

  function proofFetch(type, params, cb) {
    // GET /apps/cellexia/proof?type=…&… — JSON only, 8s timeout, ONE
    // retry, then fail closed: cb(null) and the caller renders nothing
    // (or leaves what is already on screen). cb fires exactly once.
    if (!window.fetch) { cb(null); return; }
    var url = pfRouteRoot() + 'apps/cellexia/proof?type=' + encodeURIComponent(type) + pfQuery(params || {});
    function attempt(retriesLeft) {
      var done = false;
      var timer = window.setTimeout(function () { fail(); }, 8000);
      function fail() {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        if (retriesLeft > 0) attempt(retriesLeft - 1);
        else cb(null);
      }
      try {
        window.fetch(url, { headers: { Accept: 'application/json' } })
          .then(function (res) {
            if (!res || !res.ok) { fail(); return null; }
            return res.json();
          })
          .then(function (data) {
            if (done || data === null) return;
            done = true;
            window.clearTimeout(timer);
            cb(data && typeof data === 'object' ? data : null);
          })
          .catch(function () { fail(); });
      } catch (e) { fail(); }
    }
    attempt(1);
  }

  // ------------------------------------------------- island + mount glue

  function pfIsland(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try {
      var raw = JSON.parse(el.textContent || 'null');
      if (!raw || typeof raw !== 'object') return null;
      var market = el.getAttribute('data-cx-market');
      if (typeof market === 'string' && market && !PF_MARKET) PF_MARKET = market;
      return { el: el, conf: raw };
    } catch (e) {
      return null;
    }
  }

  function pfPreviewVerified() {
    // Evidence of a SERVER-verified preview session. Two sources: the live
    // flag cellexia-pdp.js sets after its verification round-trip (product
    // pages), and the cx_preview_ok sessionStorage marker that same
    // verification persists — which is what lets draft-only proof blocks
    // render on NON-product pages (home) visited later in the session.
    // Never true for a normal visitor.
    try {
      if (window.CellexiaBooster && window.CellexiaBooster.__preview) return true;
    } catch (e) { /* noop */ }
    try {
      if (window.sessionStorage.getItem('cx_preview_ok') === '1') return true;
    } catch (e) { /* noop */ }
    return false;
  }

  function pfWhenAllowed(conf, cb) {
    // live:true islands render immediately. live:false islands are
    // draft-only emissions (armed preview): render ONLY on server-verified
    // evidence (pfPreviewVerified) — checked immediately, then polled
    // briefly because the pdp verification is async on product pages.
    if (conf.live === true) { cb(); return; }
    if (pfPreviewVerified()) { cb(); return; }
    var tries = 0;
    var timer = window.setInterval(function () {
      tries += 1;
      if (pfPreviewVerified()) {
        window.clearInterval(timer);
        cb();
      } else if (tries >= 20) {
        window.clearInterval(timer);
      }
    }, 500);
  }

  // v8.7: the widgets ship as ONE app embed ("Cellexia proof library") —
  // this store's legacy Liquid templates cannot take section app blocks
  // (merchant-verified), so the embed emits the config islands at the end
  // of <body> and each widget PLACES ITSELF via the shared band below.
  var PF_SLOT_ORDER = ['press', 'endorsements', 'results'];

  function pfPastCxSiblings(anchor) {
    // Deterministic order at a contended anchor: the pdp embed's proof
    // stack (below_tabs placement) and the Amazon sections (tabs_below)
    // insert at this same nextSibling position at different times — the
    // band must always land AFTER any of them that already arrived, never
    // between the anchor and a merchant-placed widget. (Whichever arrives
    // later also walks past the band's own class-mates safely.)
    var ref = anchor;
    while (
      ref.nextElementSibling &&
      typeof ref.nextElementSibling.className === 'string' &&
      (ref.nextElementSibling.className.indexOf('cx-proof-stack') !== -1 ||
        ref.nextElementSibling.className.indexOf('cx-az-sections') !== -1 ||
        ref.nextElementSibling.className.indexOf('cx-proof-band') !== -1)
    ) {
      ref = ref.nextElementSibling;
    }
    return ref;
  }

  function pfInsertAfter(node, reference) {
    try {
      if (!reference || !reference.parentNode) return false;
      reference.parentNode.insertBefore(node, reference.nextSibling);
      return true;
    } catch (e) {
      return false;
    }
  }

  function pfNewBand(key) {
    var band = document.createElement('div');
    // Theme container classes so the band tracks the content column
    // (responsive max-widths + padding) — the .cx-proof-stack convention.
    band.className = 'cx-proof-band container container--md';
    band.setAttribute('data-cx-band', key);
    for (var i = 0; i < PF_SLOT_ORDER.length; i++) {
      var slot = document.createElement('div');
      slot.className = 'cx-proof-band__slot';
      slot.setAttribute('data-cx-slot', PF_SLOT_ORDER[i]);
      band.appendChild(slot);
    }
    return band;
  }

  function pfBandBelowTabs(band) {
    var placed = false;
    var tabs = document.querySelector('.pdp__tabs');
    if (tabs) placed = pfInsertAfter(band, pfPastCxSiblings(tabs));
    if (!placed) {
      var pdp = document.querySelector('section.pdp') || document.querySelector('.pdp');
      if (pdp) placed = pfInsertAfter(band, pfPastCxSiblings(pdp));
    }
    if (!placed) {
      var main = document.getElementById('main') ||
        document.getElementById('MainContent') ||
        document.querySelector('main');
      if (main) {
        try {
          main.appendChild(band);
          placed = true;
        } catch (e) {
          placed = false;
        }
      }
    }
    return placed;
  }

  function pfBandAt(key) {
    // v8.9: ONE ordered band PER PLACEMENT — each widget picks its band
    // via the island's lean "pl" code ('a' above_proof / 'b' below_proof /
    // absent = below_tabs). Slots are created synchronously in fixed order
    // (press → endorsements → results) so async fetch completion can never
    // scramble the visual order inside a band. Anchors (product pages):
    //   below_tabs  — after the theme's .pdp__tabs info box (v8.7);
    //   above_proof — immediately BEFORE the pdp embed's proof stack
    //                 (survey/study/guarantee); stack absent → before the
    //                 tabs (where the stack would sit) → below_tabs chain;
    //   below_proof — immediately AFTER that stack; same fallbacks.
    // Any other page: end of <main> (all keys — placement is a PDP
    // concept). No anchor = no render (never append to <body>).
    var band = document.querySelector('.cx-proof-band[data-cx-band="' + key + '"]');
    if (band) return band;
    band = pfNewBand(key);
    var placed = false;
    var stack = document.querySelector('.cx-proof-stack');
    var tabs = document.querySelector('.pdp__tabs');
    if (key === 'above_proof') {
      if (stack && stack.parentNode) {
        try {
          stack.parentNode.insertBefore(band, stack);
          placed = true;
        } catch (e) { placed = false; }
      }
      if (!placed && tabs && tabs.parentNode) {
        try {
          tabs.parentNode.insertBefore(band, tabs);
          placed = true;
        } catch (e) { placed = false; }
      }
    } else if (key === 'below_proof') {
      if (stack) placed = pfInsertAfter(band, stack);
      if (!placed && tabs && tabs.parentNode) {
        try {
          tabs.parentNode.insertBefore(band, tabs);
          placed = true;
        } catch (e) { placed = false; }
      }
    }
    if (!placed) placed = pfBandBelowTabs(band);
    if (!placed) return null;
    pfSortBandRun(band);
    return band;
  }

  function pfPlacementKey(conf) {
    // Placement is a PRODUCT-PAGE concept: off product pages every widget
    // collapses to the single below_tabs band, preserving the v8.7 home
    // contract (one band, fixed press → endorsements → results order —
    // review catch: distinct keys would fragment into fetch-ordered bands).
    if (!conf || conf.ctx !== 'product') return 'below_tabs';
    var pl = typeof conf.pl === 'string' ? conf.pl : '';
    if (pl === 'a') return 'above_proof';
    if (pl === 'b') return 'below_proof';
    return 'below_tabs';
  }

  var PF_BAND_RANK = { above_proof: 0, below_proof: 1, below_tabs: 2 };

  function pfSortBandRun(band) {
    // Deterministic cross-band order (review catch): when two bands share
    // an anchor (e.g. both fall back to before .pdp__tabs with no stack),
    // arrival order is fetch-completion order — nondeterministic. After
    // every insertion, the maximal contiguous run of sibling bands
    // containing this band is re-ordered by placement rank
    // (above_proof < below_proof < below_tabs), so the final DOM order is
    // identical regardless of which fetch resolved first.
    try {
      var first = band;
      while (
        first.previousElementSibling &&
        typeof first.previousElementSibling.className === 'string' &&
        first.previousElementSibling.className.indexOf('cx-proof-band') !== -1
      ) {
        first = first.previousElementSibling;
      }
      var run = [];
      var node = first;
      while (
        node &&
        typeof node.className === 'string' &&
        node.className.indexOf('cx-proof-band') !== -1
      ) {
        run.push(node);
        node = node.nextElementSibling;
      }
      if (run.length < 2) return;
      var sorted = run.slice().sort(function (a, b) {
        var ra = PF_BAND_RANK[a.getAttribute('data-cx-band')] || 0;
        var rb = PF_BAND_RANK[b.getAttribute('data-cx-band')] || 0;
        return ra - rb;
      });
      var anchorNext = run[run.length - 1].nextSibling;
      var parent = run[0].parentNode;
      if (!parent) return;
      for (var i = 0; i < sorted.length; i++) {
        parent.insertBefore(sorted[i], anchorNext);
      }
    } catch (e) { /* order pass is best-effort; the bands stay attached */ }
  }

  function pfMount(name, island, node, conf) {
    // Legacy hook kept first: a data-cx-mount container wins if a future
    // surface ever provides one (none does today — the v8 section blocks
    // that emitted them are retired).
    var mount = document.querySelector('[data-cx-mount="' + name + '"]');
    if (mount) {
      mount.appendChild(node);
      return true;
    }
    var band = pfBandAt(pfPlacementKey(conf));
    if (band) {
      var slot = band.querySelector('[data-cx-slot="' + name + '"]');
      if (slot) {
        slot.appendChild(node);
        return true;
      }
    }
    // Fail closed: an island at the end of <body> is NOT a placement — the
    // widget would render under the footer. No anchor, no render.
    return false;
  }

  function pfProductParams(conf, params) {
    if (conf && conf.ctx === 'product' && pfPosInt(conf.pid)) params.product = conf.pid;
    return params;
  }

  // ------------------------------------------------------ press band (v8)
  //
  // Quiet full-width band: eyebrow, grayscale logo strip (horizontally
  // scrollable on mobile), ONE large featured quote below. Quotes rotate
  // on logo click/tap only — no autoplay. The API orders items featured-
  // first, so item 0 is the merchant's featured quote.

  function pressItems(data) {
    // Client-side re-validation: the API is trusted for ORDER, never for
    // content safety. Rows need a publication + a quote; URLs pass
    // pfHttps or drop to '' (text-only logo / no article link).
    if (!data || !Array.isArray(data.items)) return [];
    var out = [];
    for (var i = 0; i < data.items.length; i++) {
      var it = data.items[i] && typeof data.items[i] === 'object' ? data.items[i] : {};
      var pub = typeof it.publication === 'string' && /\S/.test(it.publication) ? it.publication : '';
      var quote = typeof it.quote === 'string' && /\S/.test(it.quote) ? it.quote : '';
      if (!pub || !quote) continue;
      out.push({ p: pub, q: quote, logo: pfHttps(it.logoUrl), url: pfHttps(it.articleUrl) });
    }
    return out;
  }

  // v8.10 WALL layout (island "ly":"w" — LIVE press.layout setting): every
  // quote visible at once as compact attribution cards. Nothing to tap,
  // nothing [hidden]; masonry columns on desktop, one tight column on
  // mobile (pure CSS — the DOM is a flat list). Density tiers are ignored
  // (the wall is inherently compact). Same validated items, same string
  // catalog — no new locale keys.
  function pressBuildWall(items, s) {
    var root = pfEl('section', 'cx-proof cx-press cx-press--wall', ['data-cx-feature', 'press']);
    pfSp(root);
    var eyebrow = pfEl('p', 'cx-proof__eyebrow eyebrow eyebrow--sm');
    eyebrow.textContent = pfStr(s, 'eyebrow');
    root.appendChild(eyebrow);
    pfSp(root);
    var list = pfEl('ul', 'cx-press__wall list-reset', ['role', 'list']);
    pfSp(list);
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var li = pfEl('li', 'cx-press__wall-card');
      pfSp(li);
      var hadLogo = false;
      if (item.logo) {
        var img = pfEl('img', 'cx-press__wall-logo', ['src', item.logo, 'alt', item.p, 'loading', 'lazy', 'width', '240', 'height', '48']);
        li.appendChild(img);
        hadLogo = true;
      } else {
        var name = pfEl('span', 'cx-press__wall-name');
        name.textContent = item.p;
        li.appendChild(name);
      }
      pfSp(li);
      var quote = pfEl('blockquote', 'cx-press__wall-quote');
      quote.textContent = item.q;
      li.appendChild(quote);
      pfSp(li);
      // Footer attribution only when the header was a logo IMAGE — the
      // name-fallback header IS the attribution (no duplicate wordmark).
      var readLabel = pfStr(s, 'read');
      var wantLink = item.url && /\S/.test(readLabel);
      if (hadLogo || wantLink) {
        var foot = pfEl('div', 'cx-press__wall-foot');
        if (hadLogo) {
          var pub = pfEl('span', 'cx-press__pub');
          pub.textContent = item.p;
          foot.appendChild(pub);
        }
        if (wantLink) {
          if (hadLogo) pfSp(foot);
          var a = pfEl('a', 'cx-proof__link no-dec', ['href', item.url, 'target', '_blank', 'rel', 'noopener nofollow']);
          a.textContent = readLabel;
          foot.appendChild(a);
        }
        li.appendChild(foot);
        pfSp(li);
      }
      list.appendChild(li);
      pfSp(list);
    }
    root.appendChild(list);
    pfSp(root);
    return root;
  }

  function pressBuildSection(conf, data) {
    var items = pressItems(data);
    if (items.length === 0) return null; // fail closed: no press, no band
    var s = conf.str || {};
    if (conf.ly === 'w') return pressBuildWall(items, s);
    // v8.3 three-tier density (LIVE setting, island "cm" member — lean
    // two-code convention): cm 2 = ULTRA (the v8.2 look — the band
    // collapses to ONE row, inline eyebrow + logo strip, and the quote
    // starts [hidden], revealing on logo tap); cm 1 = COMPACT (the same
    // one-row eyebrow + logo strip, but the quote is ALWAYS visible below
    // it — sized down, single-line source — and logo taps rotate quotes
    // exactly like full mode); absent = full.
    var ultra = conf.cm === 2;
    var compact = conf.cm === 1;
    var openIdx = -1; // ultra only: which quote is revealed (-1 = collapsed)
    var root = pfEl('section', 'cx-proof cx-press' + (ultra ? ' cx-press--ultra' : compact ? ' cx-press--compact' : ''), ['data-cx-feature', 'press']);
    pfSp(root);
    var eyebrow = pfEl('p', 'cx-proof__eyebrow eyebrow eyebrow--sm');
    eyebrow.textContent = pfStr(s, 'eyebrow');
    root.appendChild(eyebrow);
    pfSp(root);

    var strip = pfEl('div', 'cx-press__logos', ['role', 'group', 'aria-label', pfStr(s, 'aria')]);
    var buttons = [];
    var quoteText = pfEl('p', 'cx-press__quote-text');
    var pubName = pfEl('span', 'cx-press__pub');
    var readLink = pfEl('a', 'cx-proof__link no-dec', ['target', '_blank', 'rel', 'noopener nofollow', 'hidden', '']);
    readLink.textContent = pfStr(s, 'read');

    function show(idx) {
      var item = items[idx];
      if (!item) return;
      quoteText.textContent = item.q;
      pubName.textContent = item.p;
      if (item.url && /\S/.test(readLink.textContent)) {
        readLink.setAttribute('href', item.url);
        readLink.removeAttribute('hidden');
      } else {
        readLink.setAttribute('hidden', '');
        readLink.removeAttribute('href');
      }
      for (var b = 0; b < buttons.length; b++) {
        buttons[b].setAttribute('aria-pressed', b === idx ? 'true' : 'false');
      }
    }

    function bindLogo(btn, idx) {
      btn.addEventListener('click', function () {
        if (ultra && idx === openIdx) {
          // v8.2 ultra: a second tap on the ACTIVE logo re-hides the
          // quote — the band collapses back to its one-row height.
          quote.setAttribute('hidden', '');
          openIdx = -1;
          for (var b = 0; b < buttons.length; b++) buttons[b].setAttribute('aria-pressed', 'false');
          return;
        }
        show(idx);
        if (ultra) {
          quote.removeAttribute('hidden');
          openIdx = idx;
        }
      });
    }

    for (var i = 0; i < items.length; i++) {
      var btn = pfEl('button', 'cx-press__logo', ['type', 'button', 'aria-pressed', i === 0 ? 'true' : 'false']);
      if (items[i].logo) {
        var img = pfEl('img', 'cx-press__logo-img', ['alt', '', 'aria-hidden', 'true', 'loading', 'lazy']);
        img.src = items[i].logo;
        btn.appendChild(img);
        var srName = pfEl('span', 'sr-only');
        srName.textContent = items[i].p;
        btn.appendChild(srName);
      } else {
        var nameSpan = pfEl('span', 'cx-press__logo-name');
        nameSpan.textContent = items[i].p;
        btn.appendChild(nameSpan);
      }
      bindLogo(btn, i);
      buttons.push(btn);
      strip.appendChild(btn);
    }
    root.appendChild(strip);
    pfSp(root);

    var quote = pfEl('blockquote', 'cx-press__quote', ['aria-live', 'polite']);
    if (ultra) quote.setAttribute('hidden', ''); // ultra starts collapsed; logo tap reveals (compact/full always show it)
    pfSp(quote);
    quote.appendChild(quoteText);
    pfSp(quote);
    var source = pfEl('div', 'cx-press__source');
    source.appendChild(pubName);
    pfSp(source);
    source.appendChild(readLink);
    quote.appendChild(source);
    pfSp(quote);
    root.appendChild(quote);
    pfSp(root);
    show(0);
    return root;
  }

  function pressInit() {
    var isl = pfIsland('cx-press-config');
    if (!isl) return;
    pfWhenAllowed(isl.conf, function () {
      if (document.querySelector('.cx-press')) return; // idempotent
      // v8.1: press is market-scoped — the buyer's market rides the request
      // so each market sees only its own publications (plus market-agnostic
      // items). The other proof types stay market-agnostic.
      var pressParams = pfProductParams(isl.conf, {});
      if (PF_MARKET) pressParams.market = PF_MARKET;
      proofFetch('press', pressParams, function (data) {
        try {
          if (document.querySelector('.cx-press')) return;
          var node = pressBuildSection(isl.conf, data);
          if (!node) return;
          if (pfMount('press', isl.el, node, isl.conf)) pfTrack('press');
        } catch (e) { /* fail closed */ }
      });
    });
  }

  // -------------------------------------------- endorsement wall (v8)
  //
  // THE WALL: static count headline (credible, not animated), dense
  // multi-column card wall (CSS columns 1/2/3/4), 44px portrait circle or
  // initials monogram, one-line clamped quote expanding in place, and a
  // "Showing X of N" progress line + Show more pagination (24 per page).

  function endoInitials(name) {
    // Monogram fallback: first + last "real" token initials — tokens
    // ending in '.' (Dr., Prof.) are skipped when anything else remains,
    // so "Dr. Anna Weiss" → AW. '' when the name has no usable token
    // (callers then skip the monogram entirely).
    var parts = String(name || '').split(/\s+/);
    var keep = [];
    var i;
    for (i = 0; i < parts.length; i++) {
      if (parts[i] && !/\.$/.test(parts[i])) keep.push(parts[i]);
    }
    if (keep.length === 0) {
      for (i = 0; i < parts.length; i++) {
        if (parts[i]) keep.push(parts[i]);
      }
    }
    if (keep.length === 0) return '';
    var out = keep[0].charAt(0);
    if (keep.length > 1) out += keep[keep.length - 1].charAt(0);
    return out.toUpperCase();
  }

  function endoValidItems(data) {
    if (!data || !Array.isArray(data.items)) return [];
    var out = [];
    for (var i = 0; i < data.items.length; i++) {
      var it = data.items[i] && typeof data.items[i] === 'object' ? data.items[i] : {};
      var name = typeof it.name === 'string' && /\S/.test(it.name) ? it.name : '';
      var quote = typeof it.quote === 'string' && /\S/.test(it.quote) ? it.quote : '';
      if (!name || !quote) continue; // fail closed per row
      out.push({
        n: name,
        q: quote,
        c: typeof it.credentials === 'string' && /\S/.test(it.credentials) ? it.credentials : '',
        cc: typeof it.country === 'string' ? it.country : '',
        img: pfHttps(it.imageUrl)
      });
    }
    return out;
  }

  function endoBuildCard(item, s) {
    var card = pfEl('div', 'cx-endo__card');
    pfSp(card);
    var head = pfEl('div', 'cx-endo__head');
    if (item.img) {
      var img = pfEl('img', 'cx-endo__photo', ['alt', '', 'aria-hidden', 'true', 'loading', 'lazy']);
      img.src = item.img;
      head.appendChild(img);
    } else {
      var initials = endoInitials(item.n);
      if (initials) {
        var mono = pfEl('span', 'cx-endo__monogram', ['aria-hidden', 'true']);
        mono.textContent = initials;
        head.appendChild(mono);
      }
    }
    pfSp(head);
    var id = pfEl('div', 'cx-endo__id');
    var nm = pfEl('p', 'cx-endo__name');
    nm.textContent = item.n;
    id.appendChild(nm);
    var credsBits = [];
    if (item.c) credsBits.push(item.c);
    var country = pfRegionName(item.cc);
    if (country) credsBits.push(country);
    if (credsBits.length > 0) {
      var creds = pfEl('p', 'cx-endo__creds');
      creds.textContent = credsBits.join(' · ');
      id.appendChild(creds);
    }
    head.appendChild(id);
    card.appendChild(head);
    pfSp(card);
    var quote = pfEl('p', 'cx-endo__quote');
    quote.textContent = item.q;
    card.appendChild(quote);
    pfSp(card);
    var readLabel = pfStr(s, 'read');
    if (readLabel) {
      var more = pfEl('button', 'cx-endo__more', ['type', 'button', 'aria-expanded', 'false']);
      more.textContent = readLabel;
      more.addEventListener('click', function () {
        var open = more.getAttribute('aria-expanded') === 'true';
        more.setAttribute('aria-expanded', open ? 'false' : 'true');
        card.className = open ? 'cx-endo__card' : 'cx-endo__card cx-endo__card--open';
      });
      card.appendChild(more);
      pfSp(card);
    } else {
      // Stale-island degrade: no expander label means no working
      // disclosure, so the full quote ships unclamped instead of
      // unreachable (the compact-survey lesson).
      card.className = 'cx-endo__card cx-endo__card--open';
    }
    return card;
  }

  function endoBuildSection(conf, data) {
    var items = endoValidItems(data);
    if (items.length === 0) return null; // fail closed: an empty wall is no wall
    var s = conf.str || {};
    // v8.3 three-tier density (LIVE setting, island "cm" member — lean
    // two-code convention): cm 2 = ULTRA (the v8.2 look — one composed
    // head row, count headline + " · " + shown_of, over a horizontal
    // scroll-snap rail of the SAME cards; CSS restyles the wall under
    // --ultra); cm 1 = COMPACT (same composed head line but H2-weight,
    // slightly smaller than the full headline, shown_of inline after it;
    // the rail carries 280px cards with two-line quotes under --compact);
    // absent = full. Show more appends into the rail in both tiers.
    var ultra = conf.cm === 2;
    var compact = conf.cm === 1;
    var total = pfPosInt(data.total) ? data.total : items.length;
    if (total < items.length) total = items.length; // never claim less than shown
    var shown = items.length;
    var page = 1;

    function endoHeadText() {
      // Compact head-row composition — both parts optional, joined with
      // the creds-line middot so a missing string degrades per part.
      var bits = [];
      var ht = pfStr(s, total === 1 ? 'one' : 'other');
      if (/\S/.test(ht)) bits.push(ht.replace('@@N@@', String(total)));
      var st = pfStr(s, 'shown');
      if (/\S/.test(st)) bits.push(st.replace('@@SHOWN@@', String(shown)).replace('@@TOTAL@@', String(total)));
      return bits.join(' · ');
    }

    var root = pfEl('section', 'cx-proof cx-endo' + (ultra ? ' cx-endo--ultra' : compact ? ' cx-endo--compact' : ''), ['data-cx-feature', 'derm_endorsements']);
    pfSp(root);
    var eyebrow = pfEl('p', 'cx-proof__eyebrow eyebrow eyebrow--sm');
    eyebrow.textContent = pfStr(s, 'eyebrow');
    if (!compact && !ultra) { // compact/ultra: the head line carries the section
      root.appendChild(eyebrow);
      pfSp(root);
    }
    var headline = null;
    if (compact || ultra) {
      var headText = endoHeadText();
      if (/\S/.test(headText)) {
        // ultra: the v8.2 one-line p row; compact: an H2 headline line
        // (slightly smaller than full via CSS) with shown_of inline.
        headline = pfEl(ultra ? 'p' : 'h2', 'cx-endo__headline');
        headline.textContent = headText;
        root.appendChild(headline);
        pfSp(root);
      }
    } else {
      var headTpl = pfStr(s, total === 1 ? 'one' : 'other');
      if (/\S/.test(headTpl)) {
        headline = pfEl('h2', 'cx-endo__headline');
        headline.textContent = headTpl.replace('@@N@@', String(total));
        root.appendChild(headline);
        pfSp(root);
      }
    }
    var wall = pfEl('div', 'cx-endo__wall');
    for (var i = 0; i < items.length; i++) wall.appendChild(endoBuildCard(items[i], s));
    root.appendChild(wall);
    pfSp(root);

    var progress = pfEl('p', 'cx-endo__progress');
    function setProgress() {
      if (compact || ultra) {
        // compact/ultra: re-compose the single head line instead of a
        // separate progress element (shown/total advance with Show more).
        if (headline) headline.textContent = endoHeadText();
        return;
      }
      var tpl = pfStr(s, 'shown');
      if (!/\S/.test(tpl)) return;
      progress.textContent = tpl.replace('@@SHOWN@@', String(shown)).replace('@@TOTAL@@', String(total));
    }
    setProgress();
    if (!compact && !ultra) {
      root.appendChild(progress);
      pfSp(root);
    }

    var moreLabel = pfStr(s, 'more');
    var moreBtn = null;
    function syncMore() {
      if (!moreBtn) return;
      if (shown >= total) moreBtn.setAttribute('hidden', '');
      else moreBtn.removeAttribute('hidden');
    }
    if (moreLabel) {
      moreBtn = pfEl('button', 'cx-endo__show-more', ['type', 'button']);
      moreBtn.textContent = moreLabel;
      moreBtn.addEventListener('click', function () {
        if (moreBtn.hasAttribute('disabled')) return;
        moreBtn.setAttribute('disabled', '');
        proofFetch('endorsements', pfProductParams(conf, { page: page + 1, per: 24 }), function (next) {
          moreBtn.removeAttribute('disabled');
          var extra = endoValidItems(next);
          if (extra.length === 0) {
            // Nothing further (or the fetch failed): stop offering more.
            moreBtn.setAttribute('hidden', '');
            return;
          }
          page += 1;
          for (var j = 0; j < extra.length; j++) wall.appendChild(endoBuildCard(extra[j], s));
          shown += extra.length;
          if (shown > total) total = shown;
          setProgress();
          syncMore();
        });
      });
      root.appendChild(moreBtn);
      pfSp(root);
      syncMore();
    }
    return root;
  }

  function endoInit() {
    var isl = pfIsland('cx-endo-config');
    if (!isl) return;
    pfWhenAllowed(isl.conf, function () {
      if (document.querySelector('.cx-endo')) return; // idempotent
      proofFetch('endorsements', pfProductParams(isl.conf, { page: 1, per: 24 }), function (data) {
        try {
          if (document.querySelector('.cx-endo')) return;
          var node = endoBuildSection(isl.conf, data);
          if (!node) return;
          if (pfMount('endorsements', isl.el, node, isl.conf)) pfTrack('derm_endorsements');
        } catch (e) { /* fail closed */ }
      });
    });
  }

  // ---------------------------------------------- results gallery (v8)
  //
  // Replaces the retired PDP before/after widget. Fixed-height band, never
  // a tall stack: scale banner, filter chips (bottom-sheet drawer on
  // mobile / inline panel ≥900px), swipeable scroll-snap card rail
  // (4-col grid ≥900px), lightbox with side-by-side images + full
  // metadata, Show more pagination. PDP passes pid → product-prioritised
  // order; brand/home context shows everything.

  function resultsBannerData(s, total, verified) {
    // Scale-banner fallback chain: verifiedTotal → banner_verified;
    // else total → banner_all; else null and the WHOLE module renders
    // nothing (fail closed — a gallery with zero results is not proof).
    if (pfPosInt(verified)) return { tpl: pfStr(s, 'bv'), n: verified };
    if (pfPosInt(total)) return { tpl: pfStr(s, 'ba'), n: total };
    return null;
  }

  var RESULTS_SKIN_KEYS = { dry: 'sd', oily: 'so', combination: 'sc', sensitive: 'ss', normal: 'sn' };
  var RESULTS_DURATION_KEYS = { lt8: 'd1', '8to12': 'd2', gt12: 'd3' };

  function resultsFacetLabel(group, value, s) {
    // Facet value → display label. Skin types and duration buckets map to
    // locale strings (raw value fallback keeps unknown data honest);
    // age ranges compose with the localized years label; concerns are
    // merchant slugs shown as data.
    var v = typeof value === 'string' ? value : '';
    if (!v) return '';
    if (group === 'skins') return pfStr(s, RESULTS_SKIN_KEYS[v] || '') || v;
    if (group === 'durations') return pfStr(s, RESULTS_DURATION_KEYS[v] || '') || v;
    if (group === 'ages') {
      var tpl = pfStr(s, 'ay');
      return tpl.indexOf('@@R@@') !== -1 ? tpl.replace('@@R@@', v) : v;
    }
    return v;
  }

  function resultsParams(conf, st) {
    // Filter state → query params (pfQuery serializes; empty values are
    // skipped there, so cleared filters vanish from the URL).
    return pfProductParams(conf, {
      concern: st.concern,
      age: st.age,
      skin: st.skin,
      duration: st.duration,
      page: st.page,
      per: 12
    });
  }

  function resultsValidItems(data) {
    if (!data || !Array.isArray(data.items)) return [];
    var out = [];
    for (var i = 0; i < data.items.length; i++) {
      var it = data.items[i] && typeof data.items[i] === 'object' ? data.items[i] : {};
      var before = pfHttps(it.beforeUrl);
      var after = pfHttps(it.afterUrl);
      if (!before && !after) continue; // a visual gallery card needs at least one image
      out.push({
        b: before,
        a: after,
        video: pfHttps(it.videoUrl),
        age: typeof it.ageRange === 'string' && /\S/.test(it.ageRange) ? it.ageRange : '',
        skin: typeof it.skinType === 'string' && /\S/.test(it.skinType) ? it.skinType : '',
        concern: typeof it.concern === 'string' && /\S/.test(it.concern) ? it.concern : '',
        weeks: pfPosInt(it.durationWeeks) ? it.durationWeeks : 0,
        country: typeof it.country === 'string' ? it.country : '',
        text: typeof it.testimonial === 'string' && /\S/.test(it.testimonial) ? it.testimonial : '',
        verified: it.verified === true,
        lab: it.source === 'lab'
      });
    }
    return out;
  }

  function resultsMetaLine(item, s) {
    // age · skin · concern · weeks of use · country — present fields only.
    var bits = [];
    if (item.age) bits.push(resultsFacetLabel('ages', item.age, s));
    if (item.skin) bits.push(resultsFacetLabel('skins', item.skin, s));
    if (item.concern) bits.push(item.concern);
    if (item.weeks) {
      var wk = pfStr(s, 'wk');
      if (/\S/.test(wk)) bits.push(wk.replace('@@N@@', String(item.weeks)));
    }
    if (item.country) {
      var cn = pfRegionName(item.country);
      if (cn) bits.push(cn);
    }
    return bits.join(' · ');
  }

  function resultsBadges(item, s) {
    // Verified-purchase / lab badges — shared by card and lightbox; null
    // when the item earns none.
    var wrap = null;
    function add(mod, label) {
      if (!/\S/.test(label)) return;
      if (!wrap) wrap = pfEl('div', 'cx-results__badges');
      var b = pfEl('span', 'cx-results__badge ' + mod);
      b.textContent = label;
      wrap.appendChild(b);
      pfSp(wrap);
    }
    if (item.verified) add('cx-results__badge--verified', pfStr(s, 'vb'));
    if (item.lab) add('cx-results__badge--lab', pfStr(s, 'lb'));
    return wrap;
  }

  function resultsBuildFrame(url, tag) {
    var frame = pfEl('div', 'cx-results__frame');
    var img = pfEl('img', 'cx-results__thumb', ['alt', '', 'loading', 'lazy']);
    img.src = url;
    frame.appendChild(img);
    if (/\S/.test(tag)) {
      var t = pfEl('span', 'cx-results__tag');
      t.textContent = tag;
      frame.appendChild(t);
    }
    return frame;
  }

  function resultsBuildCard(item, s) {
    var card = pfEl('div', 'cx-results__card');
    pfSp(card);
    var media = pfEl('button', 'cx-results__media', ['type', 'button']);
    if (item.b) media.appendChild(resultsBuildFrame(item.b, pfStr(s, 'bef')));
    if (item.a) media.appendChild(resultsBuildFrame(item.a, pfStr(s, 'aft')));
    if (item.video) {
      var play = pfEl('span', 'cx-results__play', ['aria-hidden', 'true']);
      var svg = pfSvg('svg', null, ['viewBox', '0 0 20 20', 'width', '12', 'height', '12', 'fill', 'currentColor', 'focusable', 'false', 'aria-hidden', 'true']);
      svg.appendChild(pfSvg('path', null, ['d', 'M7 4.5 15.5 10 7 15.5Z']));
      play.appendChild(svg);
      media.appendChild(play);
      var vidLabel = pfStr(s, 'vid');
      if (/\S/.test(vidLabel)) {
        var vidSr = pfEl('span', 'sr-only');
        vidSr.textContent = vidLabel;
        media.appendChild(vidSr);
      }
    }
    media.addEventListener('click', function () {
      pfLbOpen(resultsBuildLightbox(item, s), media);
      pfTrack('verified_before_after', 'click');
    });
    card.appendChild(media);
    pfSp(card);
    var badges = resultsBadges(item, s);
    if (badges) {
      card.appendChild(badges);
      pfSp(card);
    }
    var meta = resultsMetaLine(item, s);
    if (meta) {
      var m = pfEl('p', 'cx-results__meta');
      m.textContent = meta;
      card.appendChild(m);
      pfSp(card);
    }
    if (item.text) {
      var q = pfEl('p', 'cx-results__quote');
      q.textContent = item.text;
      card.appendChild(q);
      pfSp(card);
    }
    return card;
  }

  function resultsBuildLightbox(item, s) {
    var root = pfEl('div', 'cx-lightbox');
    pfSp(root);
    root.appendChild(pfEl('div', 'cx-lightbox__backdrop', ['data-cx-lb-close', '']));
    pfSp(root);
    var card = pfEl('div', 'cx-lightbox__card', ['role', 'dialog', 'aria-modal', 'true', 'tabindex', '-1']);
    pfSp(card);
    var close = pfEl('button', 'cx-lightbox__close', ['type', 'button', 'data-cx-lb-close', '', 'aria-label', pfStr(s, 'close')]);
    var x = pfEl('span', null, ['aria-hidden', 'true']);
    x.textContent = '×';
    close.appendChild(x);
    card.appendChild(close);
    pfSp(card);
    var imgs = pfEl('div', 'cx-lightbox__imgs');
    function fig(url, capText) {
      var f = pfEl('figure', 'cx-lightbox__fig');
      var img = pfEl('img', 'cx-lightbox__img', ['alt', '', 'loading', 'lazy']);
      img.src = url;
      f.appendChild(img);
      if (/\S/.test(capText)) {
        var cap = pfEl('figcaption', 'cx-lightbox__cap');
        cap.textContent = capText;
        f.appendChild(cap);
      }
      return f;
    }
    if (item.b) imgs.appendChild(fig(item.b, pfStr(s, 'bef')));
    if (item.a) imgs.appendChild(fig(item.a, pfStr(s, 'aft')));
    card.appendChild(imgs);
    pfSp(card);
    if (item.video) {
      if (pfVideoFile(item.video)) {
        // Direct media file → inline player. src is pfHttps-vetted.
        var video = pfEl('video', 'cx-lightbox__video', ['controls', '', 'preload', 'metadata', 'playsinline', '']);
        video.src = item.video;
        card.appendChild(video);
      } else {
        // Anything else → plain link-out, never embedded.
        var vrow = pfEl('p', 'cx-lightbox__link');
        var vlink = pfEl('a', 'cx-proof__link no-dec', ['href', item.video, 'target', '_blank', 'rel', 'noopener nofollow']);
        vlink.textContent = pfStr(s, 'vid');
        vrow.appendChild(vlink);
        card.appendChild(vrow);
      }
      pfSp(card);
    }
    var badges = resultsBadges(item, s);
    if (badges) {
      card.appendChild(badges);
      pfSp(card);
    }
    if (item.text) {
      var q = pfEl('p', 'cx-lightbox__quote');
      q.textContent = item.text;
      card.appendChild(q);
      pfSp(card);
    }
    var meta = resultsMetaLine(item, s);
    if (meta) {
      var m = pfEl('p', 'cx-lightbox__meta');
      m.textContent = meta;
      card.appendChild(m);
      pfSp(card);
    }
    root.appendChild(card);
    pfSp(root);
    return root;
  }

  // Lightbox open/close machinery — same accessible-dialog conventions as
  // the guarantee-check modal (focus to the card on open, Tab loop over
  // focusables, ESC + backdrop + close button, body scroll lock, focus
  // back to the trigger on close). Singleton via #cx-proof-lb.
  var pfLbState = null;

  function pfLbFocusables(card) {
    var out = [];
    try {
      var nodes = card.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], [tabindex]'
      );
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute('tabindex') === '-1') continue;
        out.push(nodes[i]);
      }
    } catch (e) { /* noop */ }
    return out;
  }

  function pfLbClose() {
    var state = pfLbState;
    if (!state) return;
    pfLbState = null;
    try { document.removeEventListener('keydown', state.onKeydown, true); } catch (e) { /* noop */ }
    try {
      if (state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root);
    } catch (e) { /* noop */ }
    try { document.body.style.overflow = state.prevOverflow; } catch (e) { /* noop */ }
    try {
      if (state.trigger && state.trigger.focus) state.trigger.focus();
    } catch (e) { /* noop */ }
  }

  function pfLbOpen(root, trigger) {
    try {
      if (pfLbState || document.getElementById('cx-proof-lb')) return; // singleton
      if (!root) return;
      root.id = 'cx-proof-lb';
      var card = root.querySelector('.cx-lightbox__card') || root;

      var onKeydown = function (event) {
        if (event.key === 'Escape' || event.key === 'Esc') {
          event.preventDefault();
          pfLbClose();
          return;
        }
        if (event.key !== 'Tab') return;
        var items = pfLbFocusables(card);
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
          if (el.hasAttribute && el.hasAttribute('data-cx-lb-close')) {
            pfLbClose();
            return;
          }
          el = el.parentNode;
        }
        if (el === root) pfLbClose(); // the flex gutter around the card
      });

      var prevOverflow = '';
      try { prevOverflow = document.body.style.overflow || ''; } catch (e) { /* noop */ }
      document.body.appendChild(root);
      try { document.body.style.overflow = 'hidden'; } catch (e) { /* noop */ }
      document.addEventListener('keydown', onKeydown, true);
      pfLbState = {
        root: root,
        trigger: trigger && trigger.focus ? trigger : null,
        prevOverflow: prevOverflow,
        onKeydown: onKeydown
      };
      try { card.focus(); } catch (e) { /* noop */ }
    } catch (e) { /* never break the theme */ }
  }

  function resultsFacetGroups(data) {
    // The 4 facet groups in display order — only those with at least one
    // valid option ship UI. Facets come from the UNfiltered product-
    // scoped set, so option counts stay stable while filtering.
    var f = data && data.facets && typeof data.facets === 'object' ? data.facets : {};
    var defs = [
      { id: 'concerns', param: 'concern', label: 'fc' },
      { id: 'ages', param: 'age', label: 'fa' },
      { id: 'skins', param: 'skin', label: 'fs' },
      { id: 'durations', param: 'duration', label: 'fd' }
    ];
    var out = [];
    for (var i = 0; i < defs.length; i++) {
      var list = Array.isArray(f[defs[i].id]) ? f[defs[i].id] : [];
      var opts = [];
      for (var j = 0; j < list.length; j++) {
        var o = list[j] && typeof list[j] === 'object' ? list[j] : {};
        if (typeof o.value === 'string' && /\S/.test(o.value)) {
          opts.push({ value: o.value, count: pfPosInt(o.count) ? o.count : 0 });
        }
      }
      if (opts.length > 0) out.push({ id: defs[i].id, param: defs[i].param, label: defs[i].label, opts: opts });
    }
    return out;
  }

  function resultsBuildSection(conf, data) {
    var s = conf.str || {};
    var banner = resultsBannerData(s, data ? data.total : 0, data ? data.verifiedTotal : 0);
    if (!banner) return null; // 0 total → the whole module fails closed
    var items = resultsValidItems(data);
    if (items.length === 0) return null; // a banner with no cards is broken proof
    var groups = resultsFacetGroups(data);
    var st = { concern: '', age: '', skin: '', duration: '', page: 1 };
    var filteredTotal = pfPosInt(data.total) ? data.total : items.length;
    var shown = items.length;

    // v8.3 three-tier density (LIVE setting, island "cm" member — lean
    // two-code convention): both modifiers are pure CSS leverage. cm 2 =
    // ULTRA (the v8.2 look — slimmer one-line banner, the four chips in
    // ONE horizontally scrollable row, 240px scroll-snap rail on BOTH
    // breakpoints); cm 1 = COMPACT (full-size banner, the normal wrapping
    // chip row, and the rail on both breakpoints with the FULL-size 270px
    // cards + two-line testimonial clamp); absent = full. Same DOM, same
    // filters, same drawer, same lightbox in every tier.
    var ultra = conf.cm === 2;
    var compact = conf.cm === 1;
    var root = pfEl('section', 'cx-proof cx-results' + (ultra ? ' cx-results--ultra' : compact ? ' cx-results--compact' : ''), ['data-cx-feature', 'verified_before_after']);
    pfSp(root);

    // Scale banner — the number rides its own <strong> so it can carry
    // the Gobold treatment. Numbers stay text, never markup.
    var bannerP = pfEl('p', 'cx-results__banner');
    var parts = banner.tpl.split('@@N@@');
    bannerP.appendChild(document.createTextNode(parts[0] || ''));
    var count = pfEl('strong', 'cx-results__count');
    count.textContent = String(banner.n);
    bannerP.appendChild(count);
    bannerP.appendChild(document.createTextNode(parts.length > 1 ? parts[1] : ''));
    root.appendChild(bannerP);
    pfSp(root);

    var rail = pfEl('div', 'cx-results__rail');
    var emptyP = pfEl('p', 'cx-results__empty', ['hidden', '']);
    emptyP.textContent = pfStr(s, 'empty');
    var moreBtn = null;

    function appendCards(list) {
      for (var i = 0; i < list.length; i++) rail.appendChild(resultsBuildCard(list[i], s));
    }

    function renderList(list) {
      while (rail.firstChild) rail.removeChild(rail.firstChild);
      if (list.length === 0) {
        emptyP.removeAttribute('hidden');
        rail.setAttribute('hidden', '');
      } else {
        emptyP.setAttribute('hidden', '');
        rail.removeAttribute('hidden');
        appendCards(list);
      }
    }

    function syncMore() {
      if (!moreBtn) return;
      if (shown >= filteredTotal || rail.hasAttribute('hidden')) moreBtn.setAttribute('hidden', '');
      else moreBtn.removeAttribute('hidden');
    }

    // ---- filters (chips row + drawer/panel), only when facets exist ----
    var chips = [];
    var optBtns = []; // { btn, param, value }
    var drawer = null;
    var scrim = null;
    var drawerOpen = false;
    var prevOverflow = '';

    function isMobile() {
      try {
        return !(window.matchMedia && window.matchMedia('(min-width: 900px)').matches);
      } catch (e) {
        return true;
      }
    }

    function syncDrawerA11y() {
      for (var i = 0; i < chips.length; i++) {
        chips[i].btn.setAttribute('aria-expanded', drawerOpen ? 'true' : 'false');
      }
    }

    function openDrawer() {
      if (!drawer || drawerOpen) return;
      drawerOpen = true;
      drawer.removeAttribute('hidden');
      scrim.removeAttribute('hidden');
      if (isMobile()) {
        try {
          prevOverflow = document.body.style.overflow || '';
          document.body.style.overflow = 'hidden'; // bottom-sheet scroll lock
        } catch (e) { /* noop */ }
      }
      syncDrawerA11y();
    }

    function closeDrawer() {
      if (!drawer || !drawerOpen) return;
      drawerOpen = false;
      drawer.setAttribute('hidden', '');
      scrim.setAttribute('hidden', '');
      try { document.body.style.overflow = prevOverflow; } catch (e) { /* noop */ }
      syncDrawerA11y();
    }

    function anyActive() {
      return !!(st.concern || st.age || st.skin || st.duration);
    }

    function chipLabel(g) {
      var base = pfStr(s, g.label);
      var v = st[g.param];
      if (v) {
        var vl = resultsFacetLabel(g.id, v, s);
        return base ? base + ': ' + vl : vl;
      }
      return base || '';
    }

    var clearChip = null;

    function syncChips() {
      for (var i = 0; i < chips.length; i++) {
        var g = chips[i].group;
        chips[i].btn.textContent = chipLabel(g);
        chips[i].btn.className = st[g.param]
          ? 'cx-results__chip cx-results__chip--on'
          : 'cx-results__chip';
      }
      if (clearChip) {
        if (anyActive()) clearChip.removeAttribute('hidden');
        else clearChip.setAttribute('hidden', '');
      }
      for (var j = 0; j < optBtns.length; j++) {
        optBtns[j].btn.setAttribute('aria-pressed', st[optBtns[j].param] === optBtns[j].value ? 'true' : 'false');
      }
    }

    function refetch(append) {
      // Sequence guard: proofFetch can take up to ~16s (timeout + retry),
      // so responses may complete out of order. Only the LATEST request's
      // response may touch state — a stale slow response is discarded, and
      // an in-flight Show-more can never mix with a newer filter change.
      st.seq = (st.seq || 0) + 1;
      var seq = st.seq;
      if (moreBtn) moreBtn.disabled = true;
      proofFetch('results', resultsParams(conf, st), function (next) {
        if (seq !== st.seq) return; // superseded — drop silently
        if (moreBtn) moreBtn.disabled = false;
        if (!next) {
          // Fetch failed: keep what is on screen (never fake an empty
          // state), roll a speculative page bump back.
          if (append && st.page > 1) st.page -= 1;
          return;
        }
        var list = resultsValidItems(next);
        filteredTotal = pfPosInt(next.total) ? next.total : (append ? shown + list.length : list.length);
        if (append) {
          appendCards(list);
          shown += list.length;
          if (list.length === 0 && st.page > 1) st.page -= 1;
        } else {
          renderList(list);
          shown = list.length;
        }
        syncMore();
      });
    }

    function pickOption(g, value) {
      st[g.param] = st[g.param] === value ? '' : value; // tap again clears
      st.page = 1;
      syncChips();
      closeDrawer();
      refetch(false);
    }

    function clearFilters() {
      st.concern = '';
      st.age = '';
      st.skin = '';
      st.duration = '';
      st.page = 1;
      syncChips();
      closeDrawer();
      refetch(false);
    }

    function bindChip(btn) {
      btn.addEventListener('click', function () {
        if (drawerOpen) closeDrawer();
        else openDrawer();
      });
    }

    function bindOpt(g, value, btn) {
      btn.addEventListener('click', function () { pickOption(g, value); });
    }

    if (groups.length > 0) {
      var filters = pfEl('div', 'cx-results__filters');
      var gi;
      for (gi = 0; gi < groups.length; gi++) {
        var chip = pfEl('button', 'cx-results__chip', ['type', 'button', 'aria-expanded', 'false', 'aria-controls', 'cx-results-drawer']);
        bindChip(chip);
        chips.push({ btn: chip, group: groups[gi] });
        filters.appendChild(chip);
        pfSp(filters);
      }
      clearChip = pfEl('button', 'cx-results__chip cx-results__chip--clear', ['type', 'button', 'hidden', '']);
      clearChip.textContent = pfStr(s, 'clear');
      clearChip.addEventListener('click', clearFilters);
      filters.appendChild(clearChip);
      root.appendChild(filters);
      pfSp(root);

      scrim = pfEl('div', 'cx-results__scrim', ['data-cx-drawer-close', '', 'hidden', '']);
      drawer = pfEl('div', 'cx-results__drawer', ['id', 'cx-results-drawer', 'hidden', '']);
      pfSp(drawer);
      var dClose = pfEl('button', 'cx-results__drawer-close', ['type', 'button', 'data-cx-drawer-close', '', 'aria-label', pfStr(s, 'close')]);
      var dx = pfEl('span', null, ['aria-hidden', 'true']);
      dx.textContent = '×';
      dClose.appendChild(dx);
      drawer.appendChild(dClose);
      pfSp(drawer);
      for (gi = 0; gi < groups.length; gi++) {
        var g = groups[gi];
        var groupEl = pfEl('div', 'cx-results__group');
        var title = pfEl('h3', 'cx-results__group-title');
        title.textContent = pfStr(s, g.label);
        groupEl.appendChild(title);
        var opts = pfEl('div', 'cx-results__opts');
        for (var oi = 0; oi < g.opts.length; oi++) {
          var opt = g.opts[oi];
          var optBtn = pfEl('button', 'cx-results__opt', ['type', 'button', 'aria-pressed', 'false']);
          optBtn.appendChild(document.createTextNode(resultsFacetLabel(g.id, opt.value, s)));
          if (opt.count > 0) {
            pfSp(optBtn);
            var n = pfEl('span', 'cx-results__opt-n');
            n.textContent = String(opt.count);
            optBtn.appendChild(n);
          }
          bindOpt(g, opt.value, optBtn);
          optBtns.push({ btn: optBtn, param: g.param, value: opt.value });
          opts.appendChild(optBtn);
          pfSp(opts);
        }
        groupEl.appendChild(opts);
        drawer.appendChild(groupEl);
        pfSp(drawer);
      }
      root.appendChild(scrim);
      pfSp(root);
      root.appendChild(drawer);
      pfSp(root);

      // Scrim / drawer-close taps + Escape while focus is inside.
      root.addEventListener('click', function (event) {
        var el = event.target;
        while (el && el !== root && el.nodeType === 1) {
          if (el.hasAttribute && el.hasAttribute('data-cx-drawer-close')) {
            closeDrawer();
            return;
          }
          el = el.parentNode;
        }
      });
      root.addEventListener('keydown', function (event) {
        if ((event.key === 'Escape' || event.key === 'Esc') && drawerOpen) {
          closeDrawer();
        }
      });
    }

    root.appendChild(rail);
    pfSp(root);
    root.appendChild(emptyP);
    pfSp(root);

    var moreLabel = pfStr(s, 'more');
    if (moreLabel) {
      moreBtn = pfEl('button', 'cx-results__more', ['type', 'button']);
      moreBtn.textContent = moreLabel;
      moreBtn.addEventListener('click', function () {
        st.page += 1;
        refetch(true);
      });
      root.appendChild(moreBtn);
      pfSp(root);
    }

    appendCards(items);
    syncChips();
    syncMore();
    return root;
  }

  function resultsInit() {
    var isl = pfIsland('cx-results-config');
    if (!isl) return;
    pfWhenAllowed(isl.conf, function () {
      if (document.querySelector('.cx-results')) return; // idempotent
      proofFetch('results', resultsParams(isl.conf, { concern: '', age: '', skin: '', duration: '', page: 1 }), function (data) {
        try {
          if (document.querySelector('.cx-results')) return;
          var node = resultsBuildSection(isl.conf, data);
          if (!node) return;
          if (pfMount('results', isl.el, node, isl.conf)) pfTrack('verified_before_after');
        } catch (e) { /* fail closed */ }
      });
    });
  }

  // --------------------------------------------------------------- boot

  function pfInit() {
    try { pressInit(); } catch (e) { /* noop */ }
    try { endoInit(); } catch (e) { /* noop */ }
    try { resultsInit(); } catch (e) { /* noop */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pfInit);
  } else {
    pfInit();
  }
})();
