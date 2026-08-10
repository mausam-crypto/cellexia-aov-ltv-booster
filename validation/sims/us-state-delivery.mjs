#!/usr/bin/env node
/**
 * validation/sims/us-state-delivery.mjs — v10 "US delivery promise by state"
 * sim (SPEC-v10-us-state-delivery.md §9.1).
 *
 * vm-extracts the REAL shipped code from BOTH theme engines (cellexia-pdp.js
 * + cellexia-cart.js) and drives it with injected fixed clocks, REAL Intl,
 * stubbed storage/fetch and the shared mini-DOM. Coverage:
 *
 *   TWINS      byte-identity pdp vs cart for every NEW v10 symbol only —
 *              US_STATE_NAMES, the four module vars and the 19 deliveryUs*
 *              functions (incl. the v10 fix trio Prime/Broadcast/
 *              PointerCoarse + the deliveryUsEventToken var), plus
 *              per-entry CX_AZ_ICONS parity (the cart table is a
 *              deliberate SUBSET, so whole-var compare would be wrong).
 *              deliveryConfig/deliveryQualifies twins stay owned by
 *              sims/delivery-businessdays.mjs (one owner, no dupes).
 *   PRIME      deliveryUsPrime — the SYNCHRONOUS state half that must run
 *              before any mount decision (source-order pins on the pdp
 *              init() / cart renderInto() hooks): fresh cached geo verdict
 *              applied with zero fetch/ticks/beacons; a cached hidden
 *              verdict resolves deliveryConfig() to null BEFORE any mount;
 *              a stored CHOICE of a now-hidden state AUTO-CLEARS and falls
 *              back to geo; expired cache ignored (fail open) with the
 *              kick still owning the refetch; a live choice masks geo.
 *   DISPATCH   dispatchSchedule (per-file edit, NOT byte-twinned) SPEC §4c
 *              coherence on BOTH bundles: a resolved state substitutes the
 *              RESOLVER's cutoffMinutes/dispatchDays (never deliveryDays);
 *              a discarded entry contributes nothing; hidden keeps the
 *              country schedule; no resolved state reads cfg.dispatch raw.
 *   FEDERAL    4-way behavioral parity of the movable-federal-holiday math:
 *              usFederalMovable (app/services/delivery-holidays.server.ts)
 *              vs usFederalMovable (extensions/checkout-delivery/src/
 *              delivery-engine.ts) vs deliveryUsFederal extracted from BOTH
 *              theme bundles — identical arrays for 2024..2030 + the 2026
 *              oracle (01-19, 02-16, 05-25, 09-07, 10-12, 11-26) +
 *              US_FEDERAL_RULES equality between the server and checkout
 *              copies.
 *   OVERLAY    the fail-OPEN state layer through the extracted engine:
 *              module-absent inert; module-on-no-state ({sel,state:null},
 *              module extras + usFederal apply); state override applied
 *              (incl. cutoff -> cutoffMinutes + dispatchDays); choice beats
 *              geo; hidden -> null; incoherent candidate discards the WHOLE
 *              entry (no extras/cutoff from a discarded entry); per-field
 *              keep-if-valid; extras module-first-then-state; both date
 *              forms with year scoping; usFederal = federalHolidays !==
 *              false && POST-merge holidaysEnabled; Thanksgiving 2026-11-26
 *              excluded end-to-end through deliveryCompute.
 *   GEO        deliveryUsGeoKick unit (stubbed fetch + storage): single
 *              flight, 6h TTL + expiry refetch, negative cache on {s:null}
 *              AND on a rejected fetch, tick fan-out on an applied state,
 *              no track() beacon, explicit choice skips the fetch entirely,
 *              malformed verdicts ({s:'CAX'}, {s:12}, non-JSON) -> null
 *              cached.
 *   SELECTOR   deliveryUsSelectorNode/Attach in the mini-DOM: label =
 *              deliver_to + NBSP + state name (Intl.DisplayNames country
 *              fallback), placeholder + 51 name-sorted USPS-code options
 *              (hidden:true states DROPPED — never choosable), non-empty
 *              pin icon svg on the button, popover [hidden] toggling,
 *              change -> choice + ticks + broadcast, attribution link
 *              visible (hidden ATTRIBUTE — the node always exists) ONLY
 *              while the state came from geo, missing deliver_to hides
 *              only the selector, idempotent re-attach, once-bound
 *              document listeners, sibling-close.
 *   POINTER    the close-semantics split (deliveryUsPointerCoarse): coarse
 *              pointers close on change (native picker = one commit); fine
 *              pointers keep the popover open on change (arrow-browse
 *              fires change per keystroke) and close on blur/Escape/
 *              outside click, restoring focus to the button; blur within
 *              the selector and the mousedown-inside Safari guard never
 *              close.
 *   FANOUT     cross-bundle 'cx:us-state' CustomEvent: two closures over
 *              ONE document + shared storage (the real pdp+cart page) —
 *              a change/geo apply in one bundle ticks the sibling exactly
 *              once, the deliveryUsEventToken guard skips the origin, the
 *              sibling re-primes its module-local geo state from shared
 *              storage, and nothing re-broadcasts (no loop).
 *
 * MUTATION TESTS (in-memory COPY of the pdp bundle, the dispatch-tz
 * precedent — silenced second tap, all must be caught semantically):
 *   M1 extra-clause dropped        merchant days off stop excluding
 *   M2 usFederal-clause dropped    Thanksgiving 2026-11-26 qualifies again
 *   M3 whole-entry discard gone    an incoherent state entry gets adopted
 *   M4 choice precedence flipped   geo beats the explicit choice
 *   M5 single-flight removed       two kicks -> two fetches
 *   M6 TTL check dropped           an expired cache verdict never refetches
 *   M7 countdown days swap         dispatchSchedule adopts deliveryDays
 *   M8 countdown gate weakened     substitution no longer needs a state
 *
 * Offline, deterministic (injected clocks, stubbed fetch/storage), node-only.
 */
import { createRequire } from 'node:module';
import vm from 'node:vm';
import {
  readSource,
  extractFunction,
  extractVar,
  extractTsConstValue,
  fixedDateClass,
  compileEngine,
} from '../lib/extract.mjs';

const require = createRequire(import.meta.url);
const { makeDocument } = require('./lib/mini-dom.cjs');

const PDP = 'extensions/cellexia-booster/assets/cellexia-pdp.js';
const CART = 'extensions/cellexia-booster/assets/cellexia-cart.js';
const SERVER_TS = 'app/services/delivery-holidays.server.ts';
const CHECKOUT_TS = 'extensions/checkout-delivery/src/delivery-engine.ts';

// ------------------------------------------------------------- local tap
// Local ok()-style tap printing "FAIL: " (mutants.cjs-greppable) and the
// live-counted ALL <n> CHECKS PASSED line — never a hardcoded count. The
// mutant runs reuse it silenced (the catching check lives on the parent).
function makeUsTap(name) {
  const state = { run: 0, failed: 0, silent: false };
  return {
    check(label, cond, detail) {
      state.run += 1;
      if (!cond) {
        state.failed += 1;
        if (!state.silent) {
          console.error(
            'FAIL: ' + label + (detail !== undefined ? ' :: ' + String(detail) : ''),
          );
        }
      }
    },
    eq(label, actual, expected) {
      this.check(
        label,
        Object.is(actual, expected) ||
          JSON.stringify(actual) === JSON.stringify(expected),
        'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected),
      );
    },
    beginSilent() { state.silent = true; },
    get run() { return state.run; },
    get failed() { return state.failed; },
    finish() {
      if (state.run === 0) {
        console.error(name + ': VACUOUS — zero checks executed');
        process.exit(1);
      }
      if (state.failed > 0) {
        console.error('\n' + state.failed + '/' + state.run + ' CHECKS FAILED (' + name + ')');
        process.exit(1);
      }
      console.log('ALL ' + state.run + ' CHECKS PASSED (' + name + ')');
    },
  };
}

const tap = makeUsTap('us-state-delivery: twins + 4-way federal + overlay + geo + selector + mutants');
const srcs = { pdp: readSource(PDP), cart: readSource(CART) };

// -------------------------------------------------- extraction extensions
/**
 * The whole `var <name> = ...;` LINE of a scalar module var (extractVar
 * only takes object/array literals). Fails loudly on missing/ambiguous
 * names; the leading 2-space IIFE indent is stripped for the vm bundle.
 */
function extractVarLine(src, name) {
  const sig = '  var ' + name + ' = ';
  const idx = src.indexOf(sig);
  if (idx === -1) throw new Error('extractVarLine: not found: ' + name);
  if (src.indexOf(sig, idx + sig.length) !== -1) {
    throw new Error('extractVarLine: ambiguous (multiple definitions): ' + name);
  }
  return src.slice(idx + 2, src.indexOf('\n', idx));
}

/**
 * Slice `function <name>(...) {...}` out of a TYPESCRIPT source (the
 * extract.mjs extractFunction compile-checks its slice as JS, which TS
 * annotations fail). String/comment/template-aware brace matcher; the
 * template literals in the sliced functions carry only balanced `${...}`
 * braces, and the post-strip new Function() compile check below fails
 * loudly if the shape ever drifts.
 */
function sliceTsFunction(src, name) {
  const sig = 'function ' + name + '(';
  const idx = src.indexOf(sig);
  if (idx === -1) throw new Error('sliceTsFunction: not found: ' + name);
  if (src.indexOf(sig, idx + sig.length) !== -1) {
    throw new Error('sliceTsFunction: ambiguous (multiple definitions): ' + name);
  }
  const open = src.indexOf('{', idx);
  let depth = 0;
  let mode = 'code'; // code | line | block | single | double | template
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; i += 1; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; i += 1; continue; }
      if (ch === "'") { mode = 'single'; continue; }
      if (ch === '"') { mode = 'double'; continue; }
      if (ch === '`') { mode = 'template'; continue; }
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(idx, i + 1);
      }
    } else if (mode === 'line') {
      if (ch === '\n') mode = 'code';
    } else if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; i += 1; }
    } else if (mode === 'single') {
      if (ch === '\\') i += 1;
      else if (ch === "'") mode = 'code';
    } else if (mode === 'double') {
      if (ch === '\\') i += 1;
      else if (ch === '"') mode = 'code';
    } else if (mode === 'template') {
      if (ch === '\\') i += 1;
      else if (ch === '`') mode = 'code';
    }
  }
  throw new Error('sliceTsFunction: unterminated: ' + name);
}

/** Strip the known TS annotations of the two usFederalMovable mirrors. */
function tsFnToJs(text) {
  return text
    .replace('(year: number): string[] {', '(year) {')
    .replace(': string[] = [];', ' = [];')
    .replace('let day: number;', 'let day;');
}

// ------------------------------------------------ twin byte-identity (v10)
const FUNCS_US = [
  'deliveryUsFederal',
  'deliveryUsChoiceGet',
  'deliveryUsChoiceSet',
  'deliveryUsCurrent',
  'deliveryUsDeliverTo',
  'deliveryUsLabel',
  'deliveryUsPopToggle',
  'deliveryUsPopCloseAll',
  'deliveryUsDocBind',
  'deliveryUsSelectorFill',
  'deliveryUsSelectorSync',
  'deliveryUsTicks',
  'deliveryUsSelectorNode',
  'deliveryUsSelectorAttach',
  'deliveryUsGeoApply',
  'deliveryUsPrime',
  'deliveryUsGeoKick',
  'deliveryUsPointerCoarse',
  'deliveryUsBroadcast',
];
const VARS_US = [
  'deliveryUsGeoState',
  'deliveryUsGeoPromise',
  'deliveryUsDocBound',
  'deliveryUsEventToken',
];

for (const f of FUNCS_US) {
  tap.check('twin byte-identical: ' + f,
    extractFunction(srcs.pdp, f) === extractFunction(srcs.cart, f));
}
for (const v of VARS_US) {
  tap.check('twin byte-identical: var ' + v,
    extractVarLine(srcs.pdp, v) === extractVarLine(srcs.cart, v));
}
tap.check('twin byte-identical: US_STATE_NAMES',
  extractVar(srcs.pdp, 'US_STATE_NAMES') === extractVar(srcs.cart, 'US_STATE_NAMES'));

// CX_AZ_ICONS is a deliberate cart SUBSET of the pdp table, so the twin law
// is per-entry: every icon spec the cart ships must equal its pdp
// counterpart (v10 added 'pin' — the selector-button icon — to BOTH).
{
  const iconsOf = (src) =>
    // eslint-disable-next-line no-new-func
    new Function(extractVar(src, 'CX_AZ_ICONS') + ' return CX_AZ_ICONS;')();
  const pdpIcons = iconsOf(srcs.pdp);
  const cartIcons = iconsOf(srcs.cart);
  for (const key of Object.keys(cartIcons)) {
    tap.check('twin CX_AZ_ICONS entry identical: ' + key,
      JSON.stringify(cartIcons[key]) === JSON.stringify(pdpIcons[key]),
      JSON.stringify({ cart: cartIcons[key], pdp: pdpIcons[key] }));
  }
  tap.check("CX_AZ_ICONS 'pin' present in both twins with a non-empty path",
    Array.isArray(pdpIcons.pin) && typeof pdpIcons.pin[1] === 'string' &&
      pdpIcons.pin[1].length > 0 && cartIcons.pin !== undefined);
}

// Prime-before-mount hooks (beacon honesty): the SYNCHRONOUS state half
// must be resolved before any mount/render decides to paint or beacon —
// pin the call ORDER at both hook sites (the behavioral prime coverage
// lives in the matrix below; these keep the hooks from drifting after it).
{
  const initIdx = srcs.pdp.indexOf('function init() {');
  const cfgIdx = srcs.pdp.indexOf('cfg = readConfig();', initIdx);
  const primeIdx = srcs.pdp.indexOf('deliveryUsPrime();', initIdx);
  const mountIdx = srcs.pdp.indexOf('mountDispatch();', initIdx);
  tap.check('prime hook: pdp init() primes after readConfig, before the first mount',
    initIdx !== -1 && cfgIdx !== -1 && primeIdx !== -1 && mountIdx !== -1 &&
      cfgIdx < primeIdx && primeIdx < mountIdx);
  const renderIdx = srcs.cart.indexOf('function renderInto(root');
  const cartPrimeIdx = srcs.cart.indexOf('deliveryUsPrime();', renderIdx);
  const cartDispatchIdx = srcs.cart.indexOf('renderDispatch(root)', renderIdx);
  tap.check('prime hook: cart renderInto() primes before the render decisions',
    renderIdx !== -1 && cartPrimeIdx !== -1 && cartDispatchIdx !== -1 &&
      cartPrimeIdx < cartDispatchIdx);
}

// The state-name table itself: 51 entries (50 states + DC), unique 2-letter
// USPS keys, non-empty English names.
{
  // eslint-disable-next-line no-new-func
  const names = new Function(extractVar(srcs.pdp, 'US_STATE_NAMES') + ' return US_STATE_NAMES;')();
  const keys = Object.keys(names);
  tap.eq('US_STATE_NAMES has 51 entries', keys.length, 51);
  tap.check('US_STATE_NAMES keys are unique 2-letter USPS codes',
    keys.every((k) => /^[A-Z]{2}$/.test(k)) && new Set(keys).size === keys.length);
  tap.check('US_STATE_NAMES carries DC and non-empty names',
    names.DC === 'District of Columbia' &&
      Object.values(names).every((n) => typeof n === 'string' && n.length > 0));
}

// ------------------------------------- 4-way federal behavioral parity
{
  const serverSrc = readSource(SERVER_TS);
  const checkoutSrc = readSource(CHECKOUT_TS);
  const serverRules = extractTsConstValue(serverSrc, 'US_FEDERAL_RULES');
  const checkoutRules = extractTsConstValue(checkoutSrc, 'US_FEDERAL_RULES');
  tap.eq('US_FEDERAL_RULES: 6 movable rules (server)', serverRules.length, 6);
  tap.check('US_FEDERAL_RULES parity: server-ts == checkout-ts',
    JSON.stringify(serverRules) === JSON.stringify(checkoutRules),
    JSON.stringify(checkoutRules));

  const compileTs = (src, rules) => {
    const js = tsFnToJs(sliceTsFunction(src, 'usFederalMovable'));
    // eslint-disable-next-line no-new-func
    return new Function('US_FEDERAL_RULES', js + '\nreturn usFederalMovable;')(rules);
  };
  const compileEs5 = (src) => {
    // eslint-disable-next-line no-new-func
    return new Function(extractFunction(src, 'deliveryUsFederal') + '\nreturn deliveryUsFederal;')();
  };
  const mirrors = {
    'server-ts': compileTs(serverSrc, serverRules),
    'checkout-ts': compileTs(checkoutSrc, checkoutRules),
    'pdp-es5': compileEs5(srcs.pdp),
    'cart-es5': compileEs5(srcs.cart),
  };

  const ORACLE_2026 = ['2026-01-19', '2026-02-16', '2026-05-25', '2026-09-07', '2026-10-12', '2026-11-26'];
  for (const [copy, fn] of Object.entries(mirrors)) {
    tap.eq('federal 2026 oracle: ' + copy, fn(2026), ORACLE_2026);
  }
  for (let year = 2024; year <= 2030; year++) {
    const canonical = JSON.stringify(mirrors['server-ts'](year));
    tap.check('federal ' + year + ': 6 well-formed dates (server-ts)',
      mirrors['server-ts'](year).length === 6 &&
        mirrors['server-ts'](year).every((d) => new RegExp('^' + year + '-\\d{2}-\\d{2}$').test(d)),
      canonical);
    for (const copy of ['checkout-ts', 'pdp-es5', 'cart-es5']) {
      tap.check('federal parity ' + year + ': server-ts == ' + copy,
        JSON.stringify(mirrors[copy](year)) === canonical,
        JSON.stringify(mirrors[copy](year)) + ' != ' + canonical);
    }
  }
}

// ------------------------------------------------------------ machinery
// The behavioral bundle: the v10 twins plus the engine functions they hook
// into (deliveryConfig/deliveryQualifies/... are extracted here only to
// DRIVE the state layer — their twin pins belong to delivery-businessdays).
const FUNCS_ENGINE = [
  'deliveryT',
  'deliveryConfig',
  'deliveryDispatchUt',
  'deliveryQualifies',
  'deliveryAdvance',
  'deliveryCompute',
  'dispatchSchedule',
  'cxEl',
  'cxIcon',
];

function buildBundle(src) {
  const parts = [
    extractVar(src, 'DISPATCH_ISO'),
    extractVar(src, 'DELIVERY_GLOBAL_EXCLUSIONS'),
    extractVar(src, 'DELIVERY_HOLIDAYS'),
    extractVar(src, 'CX_AZ_ICONS'),
    extractVar(src, 'US_STATE_NAMES'),
  ];
  // The cart file's dispatchSchedule reads the module-level STRINGS alias
  // (pdp reads cfg.strings directly) — carry the REAL line when present so
  // the extracted countdown runs unmodified.
  if (src.indexOf('  var STRINGS = ') !== -1) parts.push(extractVarLine(src, 'STRINGS'));
  for (const v of VARS_US) parts.push(extractVarLine(src, v));
  for (const f of FUNCS_ENGINE) parts.push(extractFunction(src, f));
  for (const f of FUNCS_US) parts.push(extractFunction(src, f));
  return parts.join('\n');
}

const bundles = { pdp: buildBundle(srcs.pdp), cart: buildBundle(srcs.cart) };

const UT = Date.UTC;
const NOW_DEFAULT = UT(2026, 6, 15, 8, 0, 0); // Wed Jul 15 2026 04:00 New York

const STRINGS = {
  'delivery.line': 'line @@DATE@@',
  'delivery.range': 'range @@FROM@@ @@TO@@',
  'delivery.range_same': 'same @@DATE@@',
  'delivery.timeline_ship': 'ship @@DATE@@',
  'delivery.timeline_delivered': 'done @@DATE@@',
  'delivery.box_title': 'title @@DATE@@',
  'delivery.tooltip': 'tip @@DATE@@',
  'delivery.deliver_to': 'Deliver to:',
};

/** A valid US-country cfg; `us` becomes cfg.delivery.us when provided. */
function usCfg(us, deliveryOver, stringsOver) {
  const delivery = Object.assign(
    {
      minDays: 2,
      maxDays: 5,
      deliveryDays: [1, 2, 3, 4, 5],
      holidaysEnabled: true,
      country: 'US',
      pageLocale: 'en',
      schedule: { cutoff: '14:00', timezone: 'America/New_York', days: [1, 2, 3, 4, 5] },
    },
    deliveryOver || {},
  );
  if (us !== undefined) delivery.us = us;
  return { delivery, deliveryStrings: Object.assign({}, STRINGS, stringsOver || {}) };
}

/**
 * usCfg + a country dispatch block for the §4c countdown-coherence checks.
 * `cutoff` may DIVERGE from the delivery schedule copy ('14:00') so the
 * substitution's READ PATH is observable: with no resolved state the
 * countdown must read cfg.dispatch raw; with one it must read the
 * resolver's output (which derives from the schedule copy).
 */
function usDispatchCfg(us, cutoff) {
  const c = usCfg(us);
  c.dispatch = {
    cutoff: cutoff || '14:00',
    timezone: 'America/New_York',
    days: [1, 2, 3, 4, 5],
    showWithinHours: 8,
  };
  c.strings = { 'dispatch.within': 'w @@TIME@@', 'dispatch.within_minutes': 'wm @@TIME@@' };
  return c;
}

function storageStub(init) {
  const map = Object.assign({}, init || {});
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem(k, v) { map[k] = String(v); },
    removeItem(k) { delete map[k]; },
    _map: map,
  };
}

/**
 * A mini-DOM document extended with EXACTLY the browser behavior the v10
 * selector/fan-out code relies on and mini-dom.cjs deliberately lacks —
 * share-able across two vm contexts (the two-bundle page):
 *  - document addEventListener/dispatchEvent (listener arrays exposed;
 *    dispatched events recorded so broadcast re-entrancy is assertable);
 *  - the one ':not([hidden])' compound the close guards query (the stock
 *    selector engine skips unknown selectors — fail-closed — which would
 *    blind the Escape/outside-click close paths);
 *  - an innerHTML micro-parse of cxIcon's static '<svg ...>...</svg>'
 *    wrapper (mini-dom stores innerHTML verbatim, which would turn every
 *    icon into an empty text node and void the non-empty-icon assertion).
 */
function makeDom() {
  const doc = makeDocument();
  const listeners = {};
  const dispatched = [];
  doc.addEventListener = (type, fn) => {
    (listeners[type] = listeners[type] || []).push(fn);
  };
  doc.dispatchEvent = (event) => {
    dispatched.push(event);
    for (const fn of (listeners[event.type] || []).slice()) fn(event);
  };
  const rawCreate = doc.createElement;
  doc.createElement = (tag) => {
    const el = rawCreate.call(doc, tag);
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._innerHTML || ''; },
      set(v) {
        this._innerHTML = String(v);
        this.childNodes = [];
        const m = /^<svg[^>]*>([\s\S]+)<\/svg>$/.exec(this._innerHTML);
        if (m) {
          const svg = rawCreate.call(doc, 'svg');
          svg._text = m[1];
          svg.parentNode = this;
          this.childNodes.push(svg);
        }
      },
    });
    return el;
  };
  const NOT_HIDDEN = /^(.+):not\(\[hidden\]\)$/;
  const rawQsa = doc.querySelectorAll;
  doc.querySelectorAll = (sel) => {
    const m = NOT_HIDDEN.exec(String(sel).trim());
    if (m) return rawQsa.call(doc, m[1]).filter((el) => !el.hasAttribute('hidden'));
    return rawQsa.call(doc, sel);
  };
  doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
  return { doc, listeners, dispatched };
}

/**
 * A fresh vm context over an extracted bundle: mini-DOM document (makeDom
 * above; pass `dom`/`localStore`/`sessionStore` to SHARE document + storage
 * between two contexts), stubbed window storage + fetch (offline — every
 * request is recorded, never sent), injected fixed clock, tick/track spies,
 * a stubbed routeRoot, collected window.setTimeout callbacks (flushTimeouts
 * runs them) and an optional coarse-pointer matchMedia (absent by default —
 * the fine-pointer, keyboard-safe branch). Real Intl.
 */
function makeCtx(bundle, opts) {
  const o = opts || {};
  const dom = o.dom || makeDom();
  const doc = dom.doc;
  const spies = { deliveryTick: 0, dispatchTick: 0, track: 0 };
  const fetchLog = [];
  const timeouts = [];
  const local = o.localStore || storageStub(o.local);
  const session = o.sessionStore || storageStub(o.session);
  const sandbox = {
    cfg: o.cfg || {},
    Date: fixedDateClass(o.nowMs === undefined ? NOW_DEFAULT : o.nowMs),
    document: doc,
    window: {
      Intl,
      localStorage: local,
      sessionStorage: session,
      matchMedia: o.coarse
        ? (q) => ({ matches: q === '(pointer: coarse)' })
        : undefined,
      CustomEvent: function CustomEvent(type, init) {
        this.type = type;
        this.detail = init ? init.detail : undefined;
      },
      setTimeout(fn) { timeouts.push(fn); return timeouts.length; },
      fetch(url, init) {
        fetchLog.push({ url, init });
        if (o.fetchImpl) return o.fetchImpl(url, init);
        return Promise.resolve({
          json: () => Promise.resolve(o.fetchJson === undefined ? { s: null } : o.fetchJson),
        });
      },
    },
    routeRoot: () => '/',
    decodeEntities: (s) => s,
    deliveryTick: () => { spies.deliveryTick += 1; },
    dispatchTick: () => { spies.dispatchTick += 1; },
    track: () => { spies.track += 1; },
  };
  const ctx = compileEngine(bundle, sandbox);
  const flushTimeouts = () => { while (timeouts.length) timeouts.shift()(); };
  return {
    ctx, doc, spies, fetchLog, local, session,
    docListeners: dom.listeners, dispatched: dom.dispatched, flushTimeouts,
  };
}

// ------------------------------------------------------ behavioral matrix
async function runBehavior(t, bundle, tag0) {
  const tag = ' [' + tag0 + ']';

  // ------------------------------------------ overlay: fail-OPEN state layer
  {
    // module absent: the resolver output is byte-for-byte the US-wide one.
    const { ctx } = makeCtx(bundle, { cfg: usCfg(undefined) });
    const dc = ctx.deliveryConfig();
    t.check('overlay: module absent is inert' + tag,
      dc !== null && dc.us === undefined && dc.usFederal === undefined &&
        dc.extra === undefined && dc.minDays === 2 && dc.maxDays === 5 &&
        dc.cutoffMinutes === 840, JSON.stringify(dc));
  }
  {
    // module present but enabled !== true: still inert (strict gate).
    const { ctx } = makeCtx(bundle, { cfg: usCfg({ enabled: 'true', selector: true }) });
    const dc = ctx.deliveryConfig();
    t.check('overlay: enabled must be === true' + tag,
      dc !== null && dc.us === undefined && dc.usFederal === undefined, JSON.stringify(dc));
  }
  {
    // module on, no resolved state: {sel, state:null}, module extras +
    // usFederal apply — the always-on part of the layer (SPEC §4a step 2).
    const { ctx } = makeCtx(bundle, {
      cfg: usCfg({
        enabled: true,
        selector: true,
        federalHolidays: true,
        extraHolidays: ['11-27'],
        byState: { CA: { minDays: 1 } },
      }),
    });
    const dc = ctx.deliveryConfig();
    t.eq('overlay: no-state dc.us' + tag, dc && dc.us, { sel: true, state: null });
    t.check('overlay: no-state keeps US-wide window (byState not applied)' + tag,
      dc && dc.minDays === 2 && dc.maxDays === 5, JSON.stringify(dc));
    t.eq('overlay: module extras apply without a state' + tag, dc && dc.extra, ['11-27']);
    t.eq('overlay: usFederal on (module default + holidaysEnabled)' + tag, dc && dc.usFederal, true);
  }
  {
    // Resolved state: full override incl. the PARTIAL dispatch override
    // (cutoff -> cutoffMinutes, dispatchDays; timezone always inherits).
    const { ctx, spies } = makeCtx(bundle, {
      cfg: usCfg({
        enabled: true,
        selector: true,
        byState: { CA: { minDays: 1, maxDays: 2, deliveryDays: [1, 2, 3], cutoff: '12:30', dispatchDays: [2, 3] } },
      }),
    });
    ctx.deliveryUsGeoApply('CA');
    t.check('overlay: geo apply fans out the quiet-upgrade ticks' + tag,
      spies.deliveryTick === 1 && spies.dispatchTick === 1,
      JSON.stringify(spies));
    const dc = ctx.deliveryConfig();
    t.check('overlay: CA override applied' + tag,
      dc !== null && dc.minDays === 1 && dc.maxDays === 2 &&
        JSON.stringify(dc.deliveryDays) === '[1,2,3]', JSON.stringify(dc));
    t.eq('overlay: state cutoff 12:30 -> cutoffMinutes 750' + tag, dc && dc.cutoffMinutes, 750);
    t.eq('overlay: state dispatchDays adopted' + tag, dc && dc.dispatchDays, [2, 3]);
    t.eq('overlay: timezone inherited (never a state field)' + tag, dc && dc.timezone, 'America/New_York');
    t.eq('overlay: dc.us carries the resolved state' + tag, dc && dc.us, { sel: true, state: 'CA' });
  }
  {
    // Explicit choice beats geo — the NY entry applies, not CA's.
    const { ctx } = makeCtx(bundle, {
      cfg: usCfg({
        enabled: true,
        selector: true,
        byState: { NY: { minDays: 3, maxDays: 4 }, CA: { minDays: 1, maxDays: 2 } },
      }),
      local: { 'cx:us_state': 'NY' },
    });
    ctx.deliveryUsGeoApply('CA');
    const dc = ctx.deliveryConfig();
    t.eq('overlay: choice beats geo (state)' + tag, dc && dc.us && dc.us.state, 'NY');
    t.check('overlay: choice beats geo (window)' + tag,
      dc && dc.minDays === 3 && dc.maxDays === 4, JSON.stringify(dc));
  }
  {
    // hidden:true is the ONE deliberate hide of the fail-open layer.
    const { ctx } = makeCtx(bundle, {
      cfg: usCfg({ enabled: true, byState: { CA: { hidden: true } } }),
    });
    ctx.deliveryUsGeoApply('CA');
    t.eq('overlay: hidden state -> null (deliberate hide)' + tag, ctx.deliveryConfig(), null);
  }
  {
    // Same hidden entry with NO resolved state: the widget stays.
    const { ctx } = makeCtx(bundle, {
      cfg: usCfg({ enabled: true, byState: { CA: { hidden: true } } }),
    });
    t.check('overlay: hidden entry without a resolved state never hides' + tag,
      ctx.deliveryConfig() !== null);
  }
  {
    // Incoherent candidate (max < min): the WHOLE entry is discarded —
    // window, cutoff, dispatchDays AND its extraHolidays contribute nothing.
    const { ctx } = makeCtx(bundle, {
      cfg: usCfg({
        enabled: true,
        extraHolidays: ['01-15'],
        byState: { CA: { minDays: 9, maxDays: 3, cutoff: '09:00', dispatchDays: [6], extraHolidays: ['07-16'] } },
      }),
    });
    ctx.deliveryUsGeoApply('CA');
    const dc = ctx.deliveryConfig();
    t.check('overlay: incoherent entry wholly discarded (window)' + tag,
      dc !== null && dc.minDays === 2 && dc.maxDays === 5, JSON.stringify(dc));
    t.eq('overlay: discarded entry adopts NO cutoff' + tag, dc && dc.cutoffMinutes, 840);
    t.eq('overlay: discarded entry adopts NO dispatchDays' + tag, dc && dc.dispatchDays, [1, 2, 3, 4, 5]);
    t.eq('overlay: discarded entry contributes NO extras (module only)' + tag, dc && dc.extra, ['01-15']);
    t.eq('overlay: the state itself still resolves' + tag, dc && dc.us && dc.us.state, 'CA');
  }
  {
    // Per-field keep-if-valid: an invalid field degrades to the inherited
    // value while the valid siblings still apply.
    const { ctx } = makeCtx(bundle, {
      cfg: usCfg({
        enabled: true,
        byState: { CA: { minDays: 1.5, maxDays: 4, deliveryDays: [1, 8], cutoff: '9:00' } },
      }),
    });
    ctx.deliveryUsGeoApply('CA');
    const dc = ctx.deliveryConfig();
    t.check('overlay: per-field keep-if-valid (bad min/days/cutoff skipped, max adopted)' + tag,
      dc !== null && dc.minDays === 2 && dc.maxDays === 4 &&
        JSON.stringify(dc.deliveryDays) === '[1,2,3,4,5]' && dc.cutoffMinutes === 840,
      JSON.stringify(dc));
  }
  {
    // Extras: module first, then the adopted state entry; invalid entries
    // dropped by the shape regex ('02-30' deliberately shape-passes).
    const { ctx } = makeCtx(bundle, {
      cfg: usCfg({
        enabled: true,
        extraHolidays: ['13-40', '01-15', '2026-02-30'],
        byState: { CA: { extraHolidays: ['02-20', 'junk'] } },
      }),
    });
    ctx.deliveryUsGeoApply('CA');
    const dc = ctx.deliveryConfig();
    t.eq('overlay: extras module-first-then-state, regex-validated' + tag,
      dc && dc.extra, ['01-15', '2026-02-30', '02-20']);
  }
  {
    // usFederal gate 1: module federalHolidays === false switches it off.
    const { ctx } = makeCtx(bundle, {
      cfg: usCfg({ enabled: true, federalHolidays: false }),
    });
    const dc = ctx.deliveryConfig();
    t.eq('overlay: federalHolidays false -> usFederal false' + tag, dc && dc.usFederal, false);
  }
  {
    // usFederal gate 2: the POST-merge holidaysEnabled decides — a state
    // entry turning holidays off turns the federal calendar off with it.
    const { ctx } = makeCtx(bundle, {
      cfg: usCfg({
        enabled: true,
        federalHolidays: true,
        byState: { CA: { holidaysEnabled: false } },
      }),
    });
    ctx.deliveryUsGeoApply('CA');
    const dc = ctx.deliveryConfig();
    t.check('overlay: POST-merge holidaysEnabled false -> usFederal false' + tag,
      dc !== null && dc.holidaysEnabled === false && dc.usFederal === false,
      JSON.stringify(dc));
  }
  {
    // deliveryQualifies: both merchant date forms with year scoping, and
    // the movable federal holiday computed for the candidate day's year.
    const { ctx } = makeCtx(bundle, {
      cfg: usCfg({ enabled: true, extraHolidays: ['07-15', '2026-07-16'] }),
    });
    const dc = ctx.deliveryConfig();
    t.eq('qualify: recurring MM-DD excluded this year' + tag,
      ctx.deliveryQualifies(UT(2026, 6, 15), dc), false);
    t.eq('qualify: recurring MM-DD excluded next year too' + tag,
      ctx.deliveryQualifies(UT(2027, 6, 15), dc), false);
    t.eq('qualify: one-off YYYY-MM-DD excluded in its year' + tag,
      ctx.deliveryQualifies(UT(2026, 6, 16), dc), false);
    t.eq('qualify: one-off YYYY-MM-DD clean the year after' + tag,
      ctx.deliveryQualifies(UT(2027, 6, 16), dc), true);
    t.eq('qualify: Thanksgiving 2026-11-26 excluded (movable federal)' + tag,
      ctx.deliveryQualifies(UT(2026, 10, 26), dc), false);
    t.eq('qualify: Thanksgiving 2027-11-25 excluded (own-year computation)' + tag,
      ctx.deliveryQualifies(UT(2027, 10, 25), dc), false);
    t.eq('qualify: plain Thursday stays clean' + tag,
      ctx.deliveryQualifies(UT(2026, 10, 19), dc), true);
  }
  {
    // Federal off: the same Thanksgiving qualifies again.
    const { ctx } = makeCtx(bundle, {
      cfg: usCfg({ enabled: true, federalHolidays: false }),
    });
    const dc = ctx.deliveryConfig();
    t.eq('qualify: federalHolidays false readmits Thanksgiving' + tag,
      ctx.deliveryQualifies(UT(2026, 10, 26), dc), true);
  }
  {
    // End-to-end through deliveryCompute (REAL Intl, injected clock):
    // Mon Nov 23 2026 10:00 New York, cutoff 14:00 — dispatch Mon, min
    // lands Wed Nov 25, and the maxDays=3 leg must SKIP Thanksgiving
    // (Thu Nov 26) to Fri Nov 27 exactly when the module is on.
    const now = UT(2026, 10, 23, 15, 0, 0);
    const on = makeCtx(bundle, { cfg: usCfg({ enabled: true }, { minDays: 2, maxDays: 3 }), nowMs: now });
    const dcOn = on.ctx.deliveryConfig();
    t.eq('compute: Thanksgiving skipped end-to-end (module on)' + tag,
      on.ctx.deliveryCompute(dcOn),
      { dispatch: UT(2026, 10, 23), min: UT(2026, 10, 25), max: UT(2026, 10, 27) });
    const off = makeCtx(bundle, { cfg: usCfg(undefined, { minDays: 2, maxDays: 3 }), nowMs: now });
    const dcOff = off.ctx.deliveryConfig();
    t.eq('compute: module absent delivers ON Thanksgiving (contrast)' + tag,
      off.ctx.deliveryCompute(dcOff),
      { dispatch: UT(2026, 10, 23), min: UT(2026, 10, 25), max: UT(2026, 10, 26) });
  }

  // ------------------------- dispatch countdown coherence (SPEC §4c)
  {
    // Resolved state: the countdown substitutes the RESOLVER's output —
    // cutoffMinutes + dispatchDays, never deliveryDays; timezone inherits.
    const c = makeCtx(bundle, {
      cfg: usDispatchCfg({
        enabled: true,
        byState: { CA: { deliveryDays: [1, 2, 3], cutoff: '12:30', dispatchDays: [2, 3] } },
      }),
    });
    c.ctx.deliveryUsGeoApply('CA');
    const dc = c.ctx.deliveryConfig();
    const sched = c.ctx.dispatchSchedule();
    t.check('dispatch: resolved state adopts the resolver cutoff' + tag,
      sched !== null && dc !== null && sched.cutoffMinutes === 750 &&
        sched.cutoffMinutes === dc.cutoffMinutes, JSON.stringify(sched));
    t.check('dispatch: resolved state adopts the resolver dispatchDays (never deliveryDays)' + tag,
      sched !== null && JSON.stringify(sched.days) === '[2,3]' &&
        JSON.stringify(sched.days) === JSON.stringify(dc && dc.dispatchDays),
      JSON.stringify(sched));
    t.eq('dispatch: timezone always inherits' + tag, sched && sched.timezone, 'America/New_York');
  }
  {
    // Discarded entry: the substitution re-reads deliveryConfig(), so the
    // fail-open discard reaches the countdown too — the entry's own
    // cutoff/dispatchDays must never surface.
    const c = makeCtx(bundle, {
      cfg: usDispatchCfg({
        enabled: true,
        byState: { CA: { minDays: 9, maxDays: 3, cutoff: '09:00', dispatchDays: [6] } },
      }),
    });
    c.ctx.deliveryUsGeoApply('CA');
    const sched = c.ctx.dispatchSchedule();
    t.check('dispatch: discarded entry leaves the countdown on US-wide cutoff/days' + tag,
      sched !== null && sched.cutoffMinutes === 840 &&
        JSON.stringify(sched.days) === '[1,2,3,4,5]', JSON.stringify(sched));
  }
  {
    // Hidden state: deliveryConfig() null hides the DATES; the countdown
    // keeps the country schedule (its mount gate owns the visibility).
    const c = makeCtx(bundle, {
      cfg: usDispatchCfg({ enabled: true, byState: { CA: { hidden: true } } }),
    });
    c.ctx.deliveryUsGeoApply('CA');
    const sched = c.ctx.dispatchSchedule();
    t.check('dispatch: hidden state keeps the country schedule' + tag,
      sched !== null && sched.cutoffMinutes === 840 &&
        JSON.stringify(sched.days) === '[1,2,3,4,5]', JSON.stringify(sched));
  }
  {
    // No resolved state: NO substitution — the countdown reads the raw
    // cfg.dispatch copy (13:00 here) even though the resolver's schedule
    // copy says 14:00. The gate needs dc.us.state, not merely dc.us.
    const c = makeCtx(bundle, {
      cfg: usDispatchCfg({ enabled: true, byState: { CA: { cutoff: '12:30' } } }, '13:00'),
    });
    const sched = c.ctx.dispatchSchedule();
    t.check('dispatch: no-state countdown reads cfg.dispatch untouched' + tag,
      sched !== null && sched.cutoffMinutes === 780 &&
        JSON.stringify(sched.days) === '[1,2,3,4,5]', JSON.stringify(sched));
  }

  // --------------------------------------------------- geo fetch unit
  const GEO_US = () => ({ enabled: true, selector: true });
  {
    // Single-flight + verdict cache + tick fan-out + config upgrade.
    const c = makeCtx(bundle, { cfg: usCfg(GEO_US()), fetchJson: { s: 'CA' } });
    c.ctx.deliveryUsGeoKick();
    c.ctx.deliveryUsGeoKick();
    t.eq('geo: two kicks -> ONE fetch (single-flight)' + tag, c.fetchLog.length, 1);
    t.check('geo: proxy path + no-store' + tag,
      c.fetchLog[0].url === '/apps/cellexia/geo' && c.fetchLog[0].init.cache === 'no-store',
      JSON.stringify(c.fetchLog[0]));
    await c.ctx.deliveryUsGeoPromise;
    t.eq('geo: verdict applied' + tag, c.ctx.deliveryUsGeoState, 'CA');
    const cached = JSON.parse(c.session._map['cx_geo:1']);
    t.check('geo: verdict cached {s, t} with the injected clock' + tag,
      cached.s === 'CA' && cached.t === NOW_DEFAULT, JSON.stringify(cached));
    t.check('geo: applied state fans out the ticks' + tag,
      c.spies.deliveryTick >= 1 && c.spies.dispatchTick >= 1, JSON.stringify(c.spies));
    const dc = c.ctx.deliveryConfig();
    t.eq('geo: resolver upgraded to the geo state' + tag, dc && dc.us && dc.us.state, 'CA');
    t.eq('geo: no track() beacon ever rides this path' + tag, c.spies.track, 0);
  }
  {
    // Fresh cache (6h TTL minus 1ms): applied WITHOUT a fetch.
    const c = makeCtx(bundle, {
      cfg: usCfg(GEO_US()),
      session: { 'cx_geo:1': JSON.stringify({ s: 'CA', t: NOW_DEFAULT - 21599999 }) },
    });
    c.ctx.deliveryUsGeoKick();
    t.eq('geo: fresh cached verdict -> no fetch' + tag, c.fetchLog.length, 0);
    t.eq('geo: fresh cached verdict applied on this page load' + tag,
      c.ctx.deliveryUsGeoState, 'CA');
  }
  {
    // Expired cache (exactly 6h old): the TTL gate refetches.
    const c = makeCtx(bundle, {
      cfg: usCfg(GEO_US()),
      session: { 'cx_geo:1': JSON.stringify({ s: 'CA', t: NOW_DEFAULT - 21600000 }) },
      fetchJson: { s: 'WA' },
    });
    c.ctx.deliveryUsGeoKick();
    t.eq('geo: expired cache -> refetch' + tag, c.fetchLog.length, 1);
    await c.ctx.deliveryUsGeoPromise;
    t.eq('geo: refetched verdict replaces the stale one' + tag, c.ctx.deliveryUsGeoState, 'WA');
  }
  {
    // Negative cache: a fresh {s:null} verdict stops the refetch storm.
    const c = makeCtx(bundle, {
      cfg: usCfg(GEO_US()),
      session: { 'cx_geo:1': JSON.stringify({ s: null, t: NOW_DEFAULT - 1 }) },
    });
    c.ctx.deliveryUsGeoKick();
    t.eq('geo: fresh negative verdict -> no fetch' + tag, c.fetchLog.length, 0);
    t.eq('geo: negative verdict applies no state' + tag, c.ctx.deliveryUsGeoState, null);
  }
  {
    // A null server verdict is CACHED negatively.
    const c = makeCtx(bundle, { cfg: usCfg(GEO_US()), fetchJson: { s: null } });
    c.ctx.deliveryUsGeoKick();
    await c.ctx.deliveryUsGeoPromise;
    t.eq('geo: null verdict negative-cached' + tag,
      JSON.parse(c.session._map['cx_geo:1']).s, null);
    t.check('geo: null verdict never ticks' + tag,
      c.spies.deliveryTick === 0 && c.spies.dispatchTick === 0, JSON.stringify(c.spies));
  }
  {
    // A REJECTED fetch negative-caches too (silent .catch path).
    const c = makeCtx(bundle, {
      cfg: usCfg(GEO_US()),
      fetchImpl: () => Promise.reject(new Error('offline')),
    });
    c.ctx.deliveryUsGeoKick();
    await c.ctx.deliveryUsGeoPromise;
    t.eq('geo: rejected fetch negative-cached' + tag,
      JSON.parse(c.session._map['cx_geo:1']).s, null);
    t.eq('geo: rejected fetch applies no state' + tag, c.ctx.deliveryUsGeoState, null);
  }
  {
    // Explicit choice masks geo entirely: no fetch, ever.
    const c = makeCtx(bundle, {
      cfg: usCfg(GEO_US()),
      local: { 'cx:us_state': 'NY' },
      fetchJson: { s: 'CA' },
    });
    c.ctx.deliveryUsGeoKick();
    t.eq('geo: explicit choice skips the fetch entirely' + tag, c.fetchLog.length, 0);
  }
  {
    // Module off / island absent: nothing to upgrade, no fetch.
    const c = makeCtx(bundle, { cfg: usCfg(undefined) });
    c.ctx.deliveryUsGeoKick();
    t.eq('geo: module absent -> no fetch' + tag, c.fetchLog.length, 0);
  }
  {
    // Malformed verdicts: wrong shape/type/parse all -> null, cached.
    for (const [label, opts] of [
      ["{s:'CAX'}", { fetchJson: { s: 'CAX' } }],
      ['{s:12}', { fetchJson: { s: 12 } }],
      ['non-JSON body', { fetchImpl: () => Promise.resolve({ json: () => Promise.reject(new Error('bad json')) }) }],
    ]) {
      const c = makeCtx(bundle, Object.assign({ cfg: usCfg(GEO_US()) }, opts));
      c.ctx.deliveryUsGeoKick();
      await c.ctx.deliveryUsGeoPromise;
      t.check('geo: malformed verdict ' + label + ' -> null cached' + tag,
        c.ctx.deliveryUsGeoState === null &&
          JSON.parse(c.session._map['cx_geo:1']).s === null,
        c.session._map['cx_geo:1']);
    }
  }

  // ------------------------- prime: the synchronous pre-mount half
  {
    // Fresh cached verdict applied with ZERO network/ticks/beacons — the
    // silent half a mount gate may consult before painting.
    const c = makeCtx(bundle, {
      cfg: usCfg(GEO_US()),
      session: { 'cx_geo:1': JSON.stringify({ s: 'CA', t: NOW_DEFAULT - 1000 }) },
    });
    c.ctx.deliveryUsPrime();
    t.eq('prime: fresh cached geo applied synchronously' + tag, c.ctx.deliveryUsGeoState, 'CA');
    t.check('prime: zero fetch, zero ticks, zero beacons' + tag,
      c.fetchLog.length === 0 && c.spies.deliveryTick === 0 &&
        c.spies.dispatchTick === 0 && c.spies.track === 0, JSON.stringify(c.spies));
    c.ctx.deliveryUsGeoKick();
    t.eq('prime: the later kick sees the fresh cache (still no fetch)' + tag,
      c.fetchLog.length, 0);
  }
  {
    // A cached HIDDEN verdict resolves deliveryConfig() to null BEFORE any
    // mount decision — no node, no impression beacon (the C1 fix).
    const c = makeCtx(bundle, {
      cfg: usCfg({ enabled: true, selector: true, byState: { CA: { hidden: true } } }),
      session: { 'cx_geo:1': JSON.stringify({ s: 'CA', t: NOW_DEFAULT - 1000 }) },
    });
    c.ctx.deliveryUsPrime();
    t.eq('prime: cached hidden verdict -> deliveryConfig() null pre-mount' + tag,
      c.ctx.deliveryConfig(), null);
    t.check('prime: the hidden veto rides zero ticks/beacons' + tag,
      c.spies.deliveryTick === 0 && c.spies.dispatchTick === 0 && c.spies.track === 0,
      JSON.stringify(c.spies));
  }
  {
    // Expired cache ignored (fail open); the kick still owns the refetch.
    const c = makeCtx(bundle, {
      cfg: usCfg(GEO_US()),
      session: { 'cx_geo:1': JSON.stringify({ s: 'CA', t: NOW_DEFAULT - 21600000 }) },
      fetchJson: { s: 'WA' },
    });
    c.ctx.deliveryUsPrime();
    t.eq('prime: expired cache ignored (fail open)' + tag, c.ctx.deliveryUsGeoState, null);
    c.ctx.deliveryUsGeoKick();
    t.eq('prime: the kick still refetches after a stale prime' + tag, c.fetchLog.length, 1);
    await c.ctx.deliveryUsGeoPromise;
    t.eq('prime: the kick verdict upgrades post-prime' + tag, c.ctx.deliveryUsGeoState, 'WA');
  }
  {
    // A live (non-hidden) choice masks geo: nothing primed, choice kept.
    const c = makeCtx(bundle, {
      cfg: usCfg({ enabled: true, selector: true, byState: { NY: { minDays: 3 } } }),
      local: { 'cx:us_state': 'NY' },
      session: { 'cx_geo:1': JSON.stringify({ s: 'CA', t: NOW_DEFAULT - 1000 }) },
    });
    c.ctx.deliveryUsPrime();
    t.eq('prime: a live choice masks the cached geo verdict' + tag,
      c.ctx.deliveryUsGeoState, null);
    t.eq('prime: the live choice survives untouched' + tag,
      c.local._map['cx:us_state'], 'NY');
  }
  {
    // Stored CHOICE of a now-hidden state AUTO-CLEARS (the C2 self-heal:
    // the selector no longer offers hidden states) and falls back to geo.
    const c = makeCtx(bundle, {
      cfg: usCfg({ enabled: true, selector: true, byState: { CA: { hidden: true } } }),
      local: { 'cx:us_state': 'CA' },
      session: { 'cx_geo:1': JSON.stringify({ s: 'WA', t: NOW_DEFAULT - 1000 }) },
    });
    c.ctx.deliveryUsPrime();
    t.eq('prime: stored hidden choice auto-cleared' + tag,
      c.local._map['cx:us_state'], undefined);
    t.eq('prime: cleared choice falls back to the cached geo state' + tag,
      c.ctx.deliveryUsGeoState, 'WA');
    const dc = c.ctx.deliveryConfig();
    t.eq('prime: resolver follows the geo fallback' + tag, dc && dc.us && dc.us.state, 'WA');
  }
  {
    // Hidden choice + cached geo of the SAME hidden state: a genuine
    // hidden-state local stays hidden through the fallback.
    const c = makeCtx(bundle, {
      cfg: usCfg({ enabled: true, selector: true, byState: { CA: { hidden: true } } }),
      local: { 'cx:us_state': 'CA' },
      session: { 'cx_geo:1': JSON.stringify({ s: 'CA', t: NOW_DEFAULT - 1000 }) },
    });
    c.ctx.deliveryUsPrime();
    t.check('prime: hidden-state local re-hidden by the geo fallback' + tag,
      c.local._map['cx:us_state'] === undefined && c.ctx.deliveryConfig() === null,
      JSON.stringify({ choice: c.local._map['cx:us_state'] }));
  }
  {
    // Module off: prime never resolves a state, whatever the cache says.
    const c = makeCtx(bundle, {
      cfg: usCfg(undefined),
      session: { 'cx_geo:1': JSON.stringify({ s: 'CA', t: NOW_DEFAULT - 1000 }) },
    });
    c.ctx.deliveryUsPrime();
    t.eq('prime: module absent never resolves a state' + tag,
      c.ctx.deliveryUsGeoState, null);
  }

  // ------------------------------------------------------- selector DOM
  {
    const c = makeCtx(bundle, { cfg: usCfg({ enabled: true, selector: true }) });
    c.ctx.deliveryUsGeoApply('CA'); // geo-sourced state
    const host = c.doc.createElement('div');
    c.doc.body.appendChild(host);
    c.ctx.deliveryUsSelectorAttach(host);
    const root = host.querySelector('.cx-usloc');
    t.check('selector: attached under the delivery node' + tag, root !== null);
    if (!root) return; // everything below needs the node
    const label = root.querySelector('.cx-usloc__label');
    t.eq('selector: label = deliver_to + NBSP + state name' + tag,
      label && label.textContent, 'Deliver to: California');
    const sel = root.querySelector('.cx-usloc__select');
    t.eq('selector: aria-label is the raw deliver_to string' + tag,
      sel && sel.getAttribute('aria-label'), 'Deliver to:');
    const opts = sel ? sel.childNodes : [];
    t.eq('selector: placeholder + 51 state options' + tag, opts.length, 52);
    t.check('selector: placeholder option is the deliver_to string' + tag,
      opts[0] && opts[0].value === '' && opts[0].textContent === 'Deliver to:');
    const codes = opts.slice(1).map((o) => o.value);
    const names = opts.slice(1).map((o) => o.textContent);
    t.check('selector: option values are USPS codes' + tag,
      codes.length === 51 && codes.every((v) => /^[A-Z]{2}$/.test(v)) &&
        new Set(codes).size === 51);
    t.check('selector: options sorted by English state name' + tag,
      JSON.stringify(names) === JSON.stringify([...names].sort()) &&
        names[0] === 'Alabama' && names[50] === 'Wyoming');
    t.check('selector: DC listed, no territories' + tag,
      codes.includes('DC') && !codes.includes('PR') && !codes.includes('GU'));
    t.eq('selector: pre-set to the current state' + tag, sel && sel.value, 'CA');
    const pop = root.querySelector('.cx-usloc__pop');
    const btn = root.querySelector('.cx-usloc__btn');
    t.check('selector: popover starts hidden, button collapsed' + tag,
      pop && pop.hasAttribute('hidden') && btn &&
        btn.getAttribute('aria-expanded') === 'false');
    btn._fire('click');
    t.check('selector: click opens (hidden removed + aria-expanded)' + tag,
      !pop.hasAttribute('hidden') && btn.getAttribute('aria-expanded') === 'true');
    btn._fire('click');
    t.check('selector: second click closes' + tag,
      pop.hasAttribute('hidden') && btn.getAttribute('aria-expanded') === 'false');
    // The pin icon rides CX_AZ_ICONS.pin through cxIcon (micro-parsed svg
    // — see makeDom): a dropped/renamed entry degrades to an empty text
    // node, which this catches.
    const icon = btn.querySelector('svg');
    t.check('selector: button carries a non-empty pin icon svg' + tag,
      icon !== null && icon.textContent.length > 0);
    // Attribution: the node ALWAYS exists; the hidden ATTRIBUTE is the
    // contract (storefront deviation 1) — visible ONLY for a geo state.
    const attr = root.querySelector('.cx-usloc__attr');
    t.check('selector: db-ip attribution node present with the CC BY link' + tag,
      attr !== null && attr.getAttribute('href') === 'https://db-ip.com' &&
        attr.textContent === 'IP Geolocation by DB-IP');
    t.check('selector: attribution VISIBLE while the state is geo-sourced' + tag,
      attr && !attr.hasAttribute('hidden'));
    // change -> choice persisted + tick fan-out + label/attr refresh. NO
    // matchMedia in this ctx => FINE pointer: change must NOT close (a
    // closed <select> fires change per arrow keystroke); the coarse close
    // and the fine blur/Escape/outside-click paths are pinned below.
    btn._fire('click');
    const ticksBefore = c.spies.deliveryTick;
    sel.value = 'TX';
    sel._fire('change');
    t.eq('selector: change persists the choice' + tag, c.local._map['cx:us_state'], 'TX');
    t.check('selector: fine-pointer change keeps the popover open (live preview)' + tag,
      !pop.hasAttribute('hidden'));
    t.check('selector: change fans out the ticks' + tag,
      c.spies.deliveryTick === ticksBefore + 1 && c.spies.dispatchTick >= 1,
      JSON.stringify(c.spies));
    t.eq('selector: label refreshed to the chosen state' + tag,
      label.textContent, 'Deliver to: Texas');
    t.check('selector: attribution HIDDEN for a manual choice' + tag,
      attr.hasAttribute('hidden'));
    btn._fire('click'); // close the (still-open) popover — toggle stays coherent
    t.check('selector: toggle close after a fine-pointer change' + tag,
      pop.hasAttribute('hidden') && btn.getAttribute('aria-expanded') === 'false');
    // Idempotence + once-bound document listeners + sibling close.
    c.ctx.deliveryUsSelectorAttach(host);
    t.eq('selector: re-attach is idempotent (one node)' + tag,
      host.querySelectorAll('.cx-usloc').length, 1);
    const host2 = c.doc.createElement('div');
    c.doc.body.appendChild(host2);
    c.ctx.deliveryUsSelectorAttach(host2);
    const root2 = host2.querySelector('.cx-usloc');
    t.check('selector: second instance attaches' + tag, root2 !== null);
    t.check('selector: document listeners bound ONCE (click/keydown/cx:us-state)' + tag,
      (c.docListeners.click || []).length === 1 &&
        (c.docListeners.keydown || []).length === 1 &&
        (c.docListeners['cx:us-state'] || []).length === 1,
      JSON.stringify(Object.keys(c.docListeners)));
    btn._fire('click'); // open #1
    root2.querySelector('.cx-usloc__btn')._fire('click'); // open #2 closes #1
    t.check('selector: opening a sibling closes the first popover' + tag,
      pop.hasAttribute('hidden') &&
        !root2.querySelector('.cx-usloc__pop').hasAttribute('hidden'));
  }
  {
    // A merchant-hidden state is never CHOOSABLE (offering it would trade
    // the widget for a stored choice that hides every surface); geo may
    // still resolve it — hiding a state's own locals is merchant intent.
    const c = makeCtx(bundle, {
      cfg: usCfg({
        enabled: true,
        selector: true,
        byState: { HI: { hidden: true }, AK: { minDays: 5 } },
      }),
    });
    const host = c.doc.createElement('div');
    c.doc.body.appendChild(host);
    c.ctx.deliveryUsSelectorAttach(host);
    const sel = host.querySelector('.cx-usloc__select');
    const codes = sel ? sel.childNodes.slice(1).map((o) => o.value) : [];
    t.eq('selector: hidden state dropped from the options' + tag, codes.length, 50);
    t.check('selector: HI unchoosable, non-hidden override states still listed' + tag,
      !codes.includes('HI') && codes.includes('AK') && codes.includes('CA'));
  }
  {
    // Coarse pointer: the native picker fires ONE change per commit, so
    // change also closes (and still persists + ticks).
    const c = makeCtx(bundle, {
      cfg: usCfg({ enabled: true, selector: true }),
      coarse: true,
    });
    const host = c.doc.createElement('div');
    c.doc.body.appendChild(host);
    c.ctx.deliveryUsSelectorAttach(host);
    const root = host.querySelector('.cx-usloc');
    const btn = root.querySelector('.cx-usloc__btn');
    const pop = root.querySelector('.cx-usloc__pop');
    const sel = root.querySelector('.cx-usloc__select');
    btn._fire('click');
    sel.value = 'TX';
    sel._fire('change');
    t.check('pointer: coarse change closes the popover' + tag,
      pop.hasAttribute('hidden') && btn.getAttribute('aria-expanded') === 'false');
    t.eq('pointer: coarse change still persists the choice' + tag,
      c.local._map['cx:us_state'], 'TX');
    t.check('pointer: coarse change still ticks' + tag, c.spies.deliveryTick >= 1);
  }
  {
    // Fine pointer close paths: blur/Escape/outside click close and keep
    // keyboard focus anchored on the button; blur inside the selector and
    // the mousedown-inside Safari guard never close.
    const c = makeCtx(bundle, { cfg: usCfg({ enabled: true, selector: true }) });
    const host = c.doc.createElement('div');
    c.doc.body.appendChild(host);
    c.ctx.deliveryUsSelectorAttach(host);
    const root = host.querySelector('.cx-usloc');
    const btn = root.querySelector('.cx-usloc__btn');
    const pop = root.querySelector('.cx-usloc__pop');
    const sel = root.querySelector('.cx-usloc__select');
    // Test-side element affordances mini-dom lacks: focus/contains/closest.
    let focused = null;
    btn.focus = () => { focused = btn; };
    root.contains = function (n) {
      while (n) {
        if (n === root) return true;
        n = n.parentNode;
      }
      return false;
    };
    btn._fire('click');
    sel._fire('blur', { relatedTarget: null });
    t.check('pointer: blur to <body> closes and refocuses the button' + tag,
      pop.hasAttribute('hidden') && focused === btn);
    btn._fire('click'); // reopen
    sel._fire('blur', { relatedTarget: btn });
    t.check('pointer: blur within the selector never closes' + tag,
      !pop.hasAttribute('hidden'));
    root._fire('mousedown'); // Safari: click inside blurs with relatedTarget null
    sel._fire('blur', { relatedTarget: null });
    t.check('pointer: mousedown-inside blur never closes (Safari toggle race)' + tag,
      !pop.hasAttribute('hidden'));
    c.flushTimeouts(); // the one-task inRoot flag resets
    focused = null;
    (c.docListeners.keydown || []).forEach((fn) => fn({ key: 'Escape' }));
    t.check('pointer: Escape closes and refocuses the button' + tag,
      pop.hasAttribute('hidden') && focused === btn);
    btn._fire('click'); // reopen for the click paths
    sel.closest = (q) => (q === '.cx-usloc' ? root : null);
    (c.docListeners.click || []).forEach((fn) => fn({ target: sel }));
    t.check('pointer: click inside the selector never closes' + tag,
      !pop.hasAttribute('hidden'));
    const outside = c.doc.createElement('div');
    outside.closest = () => null;
    (c.docListeners.click || []).forEach((fn) => fn({ target: outside }));
    t.check('pointer: outside click closes' + tag, pop.hasAttribute('hidden'));
  }
  {
    // No resolved state: Intl.DisplayNames country fallback, empty select,
    // attribution hidden.
    const c = makeCtx(bundle, { cfg: usCfg({ enabled: true, selector: true }) });
    const host = c.doc.createElement('div');
    c.doc.body.appendChild(host);
    c.ctx.deliveryUsSelectorAttach(host);
    const root = host.querySelector('.cx-usloc');
    t.check('selector: attaches with no state' + tag, root !== null);
    t.eq('selector: no-state label falls back to the country name' + tag,
      root && root.querySelector('.cx-usloc__label').textContent,
      'Deliver to: United States');
    t.eq('selector: no-state select shows the placeholder' + tag,
      root && root.querySelector('.cx-usloc__select').value, '');
    t.check('selector: no-state attribution hidden' + tag,
      root && root.querySelector('.cx-usloc__attr').hasAttribute('hidden'));
  }
  {
    // The self-gates: selector flag off, missing deliver_to string and a
    // Shopify "Translation missing" marker each hide ONLY the selector.
    const offFlag = makeCtx(bundle, { cfg: usCfg({ enabled: true, selector: false }) });
    const h1 = offFlag.doc.createElement('div');
    offFlag.doc.body.appendChild(h1);
    offFlag.ctx.deliveryUsSelectorAttach(h1);
    t.eq('selector: dc.us.sel false -> no selector' + tag,
      h1.querySelectorAll('.cx-usloc').length, 0);
    t.check('selector: dc.us.sel false leaves the promise resolvable' + tag,
      offFlag.ctx.deliveryConfig() !== null);
    const noStr = makeCtx(bundle, {
      cfg: usCfg({ enabled: true, selector: true }, undefined, { 'delivery.deliver_to': '' }),
    });
    t.eq('selector: empty deliver_to -> builder yields null' + tag,
      noStr.ctx.deliveryUsSelectorNode(), null);
    t.check('selector: empty deliver_to leaves the promise resolvable' + tag,
      noStr.ctx.deliveryConfig() !== null);
    const missStr = makeCtx(bundle, {
      cfg: usCfg({ enabled: true, selector: true }, undefined, {
        'delivery.deliver_to': 'Translation missing: en.delivery.deliver_to',
      }),
    });
    t.eq('selector: Translation-missing marker -> builder yields null' + tag,
      missStr.ctx.deliveryUsSelectorNode(), null);
  }

  // -------------------------------------------- cross-bundle fan-out
  await runFanout(t, bundle, bundle, tag0);
}

/**
 * Two vm closures over ONE document + shared storage — the real pdp+cart
 * page. A state change in either bundle must reach the sibling exactly
 * once via the 'cx:us-state' CustomEvent (deliveryUsBroadcast → the
 * deliveryUsDocBind listener): the deliveryUsEventToken guard skips the
 * origin bundle, the listener re-primes the sibling's module-local geo
 * state from the shared storage halves and re-ticks, and nothing
 * re-broadcasts (loop-free by construction — asserted via the dispatch
 * count).
 */
async function runFanout(t, bundleA, bundleB, tag0) {
  const tag = ' [' + tag0 + ' fanout]';
  const dom = makeDom();
  const local = storageStub();
  const session = storageStub();
  const cfgOf = () =>
    usCfg({ enabled: true, selector: true, byState: { CA: { minDays: 1 } } });
  const a = makeCtx(bundleA, { cfg: cfgOf(), dom, localStore: local, sessionStore: session });
  const b = makeCtx(bundleB, { cfg: cfgOf(), dom, localStore: local, sessionStore: session });
  const hostA = dom.doc.createElement('div');
  dom.doc.body.appendChild(hostA);
  a.ctx.deliveryUsSelectorAttach(hostA);
  const hostB = dom.doc.createElement('div');
  dom.doc.body.appendChild(hostB);
  b.ctx.deliveryUsSelectorAttach(hostB);
  t.eq('fanout: each bundle binds its own cx:us-state listener' + tag,
    (dom.listeners['cx:us-state'] || []).length, 2);
  const selA = hostA.querySelector('.cx-usloc__select');
  t.check('fanout: both selectors attached' + tag,
    selA !== null && hostB.querySelector('.cx-usloc__select') !== null);
  if (!selA) return;
  selA.value = 'TX';
  selA._fire('change');
  t.check('fanout: a change ticks the sibling bundle exactly once' + tag,
    b.spies.deliveryTick === 1 && b.spies.dispatchTick === 1,
    JSON.stringify(b.spies));
  t.eq('fanout: the origin ran its own ticks once (token skips the echo)' + tag,
    a.spies.deliveryTick, 1);
  t.eq('fanout: one broadcast, no re-entrant loop' + tag, dom.dispatched.length, 1);
  const dcB = b.ctx.deliveryConfig();
  t.eq('fanout: sibling resolver converges on the choice' + tag,
    dcB && dcB.us && dcB.us.state, 'TX');
  // Geo half: A's cache-hit kick applies + broadcasts; B re-primes its
  // module-local geo state from the shared sessionStorage verdict.
  a.ctx.deliveryUsChoiceSet(''); // back to the geo hint (storage-only, no event)
  session.setItem('cx_geo:1', JSON.stringify({ s: 'CA', t: NOW_DEFAULT - 5 }));
  a.ctx.deliveryUsGeoKick();
  t.eq('fanout: a geo apply re-primes the sibling geo state' + tag,
    b.ctx.deliveryUsGeoState, 'CA');
  t.check('fanout: the geo fan-out ticks the sibling once more, still no loop' + tag,
    b.spies.deliveryTick === 2 && dom.dispatched.length === 2,
    JSON.stringify({ spies: b.spies, dispatched: dom.dispatched.length }));
}

// ------------------------------------------------------------- main run
await runBehavior(tap, bundles.pdp, 'pdp');
await runBehavior(tap, bundles.cart, 'cart');
// The real two-file pairing (runBehavior fans out same-bundle pairs — the
// twins are byte-verified above, but the shipped page runs pdp WITH cart).
await runFanout(tap, bundles.pdp, bundles.cart, 'pdp+cart');

// -------------------------------------------------------- mutation tests
// In-memory mutants on the extracted pdp bundle (the dispatch-tz /
// delivery-businessdays precedent): mutate, re-run the full behavioral
// matrix on a SILENCED tap, assert failures were recorded. Anchors are
// asserted present first, so a refactor can never turn a mutant into a
// silent no-op; a mutant that CRASHES the run is a failure, not a catch.
const MUTANTS = [
  {
    name: 'M1 extra-clause dropped from deliveryQualifies',
    find: "      if (dc.extra && (dc.extra.indexOf(mmdd) !== -1 || dc.extra.indexOf(full) !== -1)) return false; // merchant day off",
    replace: ';',
  },
  {
    name: 'M2 usFederal-clause dropped from deliveryQualifies',
    find: "      if (dc.usFederal === true && deliveryUsFederal(y).indexOf(full) !== -1) return false; // movable federal holiday",
    replace: ';',
  },
  {
    name: 'M3 whole-entry discard inverted (adopts the invalid candidate)',
    find: '      if (cMax >= cMin) {',
    replace: '      if (true) {',
  },
  {
    name: 'M4 choice precedence flipped (geo beats choice)',
    find: '    if (choice) return choice;',
    replace: '    if (choice && deliveryUsGeoState === null) return choice;',
  },
  {
    name: 'M5 single-flight removed (two kicks, two fetches)',
    find: '      if (deliveryUsGeoPromise) return; // single-flight',
    replace: ';',
  },
  {
    name: 'M6 TTL check dropped (stale cache lives forever)',
    find: 'Date.now() - parsed.t < 21600000',
    replace: 'true',
  },
  {
    name: 'M7 countdown substitution swaps dispatchDays for deliveryDays',
    find: '        days = dcUs.dispatchDays;',
    replace: '        days = dcUs.deliveryDays;',
  },
  {
    name: 'M8 countdown substitution gate no longer requires a resolved state',
    find: '      if (dcUs && dcUs.us && dcUs.us.state) {',
    replace: '      if (dcUs && dcUs.us) {',
  },
];

for (const mutant of MUTANTS) {
  const occurrences = bundles.pdp.split(mutant.find).length - 1;
  tap.check('mutant anchor present: ' + mutant.name, occurrences >= 1,
    'find-string not in extracted bundle: ' + mutant.find);
  if (occurrences < 1) continue;
  const mutated = bundles.pdp.split(mutant.find).join(mutant.replace);
  const silent = makeUsTap('mutant:' + mutant.name);
  silent.beginSilent();
  let crashed = null;
  try {
    await runBehavior(silent, mutated, 'pdp-mutant');
  } catch (e) {
    crashed = e;
  }
  tap.check('mutant run completes without crashing: ' + mutant.name, crashed === null,
    crashed && crashed.message);
  if (crashed) continue;
  tap.check('mutant CAUGHT: ' + mutant.name, silent.failed > 0,
    'mutant survived ' + silent.run + ' checks');
}

tap.finish();
