#!/usr/bin/env node
/**
 * validation/sims/plurals.mjs — CLDR plural selection + compact-number sim.
 *
 * vm-extracts the REAL shipped functions (never re-implementations):
 *   from cellexia-cart.js: t, azStr, azPageLocale, azCompact, azCtaLabel
 *                          (az_cta_count), cardBoughtLabel (az_bought_count
 *                          on cards)
 *   from cellexia-pdp.js:  azT, azMoney, azPageLocale, azCompact, azFbtRows,
 *                          azFbtUpdate (the FBT add-button plural ladder,
 *                          driven through a minimal fake DOM node)
 *
 * The config-strings maps are baked EXACTLY the way the Liquid emitters
 * bake them from the REAL locale files:
 *   cart-booster.liquid  -> amazon.cta_count.{zero,one,two,few,many,other}
 *                           (sentinel @@COUNT@@) and
 *                           amazon.bought_count.{one,two,few,many,other}
 *                           (sentinel @@N@@ — NO zero row, per the Liquid
 *                           loop) with Shopify's "Translation missing:
 *                           <locale>.<key>" markers for absent categories
 *   amazon-booster.liquid -> amazon.fbt_add_1..4 pre-pluralized server-side
 *                           (t: count: N) + amazon.fbt_add_both
 *
 * Expectations are computed INDEPENDENTLY from the locale files +
 * Intl.PluralRules / Intl.NumberFormat, for en/fr/pl/ar/ro/ja at counts
 * 1/2/3/5/11/21/101/2000 (+ 0 and fractions on the fail-closed edges):
 * category selection in the PAGE language, missing-category fallback to
 * "other", page-locale digits (ar keeps Arabic-Indic digits), and the
 * azCompact contract — honesty pre-floor to the compact anchor (1940 ->
 * "1K", never "2K") and the da/fi/hu grouped-digits opt-out below 10 000.
 * azCompact is also asserted byte-identical between the two theme files
 * (the v6.6 twin convention).
 *
 * MUTATION TESTS (in-memory COPY of the bundles; all must be caught):
 *   P1 select(n) -> select(1)        [azCtaLabel + cardBoughtLabel]
 *                                    (caught: pl count 5 must use "many")
 *   P2 honesty pre-floor dropped     anchor = n
 *                                    (caught: da 1940 must render "1.000")
 *   P3 da/fi/hu opt-out 10000 -> 1000 (caught: da 2000 must stay grouped)
 *   P4 FBT clamp Math.max(count,1) dropped
 *                                    (caught: 0 checked must label add_1)
 *   P5 cta "other"-guard dropped     (caught: unusable "other" must yield
 *                                    null, never a raw key on the button)
 *
 * Offline, deterministic, node-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  readSource,
  extractFunction,
  compileEngine,
  makeTap,
} from '../lib/extract.mjs';

const PDP = 'extensions/cellexia-booster/assets/cellexia-pdp.js';
const CART = 'extensions/cellexia-booster/assets/cellexia-cart.js';
const LOCALES_DIR = 'extensions/cellexia-booster/locales';

const tap = makeTap('plurals');
const srcs = { pdp: readSource(PDP), cart: readSource(CART) };

// ------------------------------------------------------- twin guarantee
tap.check('twin byte-identical: azCompact (pdp == cart)',
  extractFunction(srcs.pdp, 'azCompact') === extractFunction(srcs.cart, 'azCompact'));

// ------------------------------------------------------- real locales
const LOCALES = ['en', 'fr', 'pl', 'ar', 'ro', 'ja'];
const COUNTS = [1, 2, 3, 5, 11, 21, 101, 2000];
const CATS = ['zero', 'one', 'two', 'few', 'many', 'other'];

function localeFile(tag) {
  const file = tag === 'en' ? 'en.default.json' : tag + '.json';
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, LOCALES_DIR, file), 'utf8'));
}
const amazonByLocale = {};
for (const tag of LOCALES) {
  amazonByLocale[tag] = localeFile(tag).amazon;
  tap.check('locale file has amazon group: ' + tag,
    amazonByLocale[tag] && typeof amazonByLocale[tag] === 'object');
}

// ------------------------------------ Liquid config-strings emulation
function missingMarker(tag, key) {
  // Shopify bakes "Translation missing: <locale>.<key>" into the config
  // JSON when a locale file lacks the key (see azStr/azT doc comments).
  return 'Translation missing: ' + tag + '.cellexia.' + key;
}

function bakeCartStrings(tag) {
  const az = amazonByLocale[tag];
  const out = {};
  for (const cat of CATS) {
    const v = az.cta_count && az.cta_count[cat];
    out['amazon.cta_count.' + cat] = typeof v === 'string'
      ? v.split('{{ count }}').join('@@COUNT@@')
      : missingMarker(tag, 'amazon.cta_count.' + cat);
  }
  // cart-booster.liquid bakes bought_count for one,two,few,many,other ONLY.
  for (const cat of ['one', 'two', 'few', 'many', 'other']) {
    const v = az.bought_count && az.bought_count[cat];
    out['amazon.bought_count.' + cat] = typeof v === 'string'
      ? v.split('{{ n }}').join('@@N@@')
      : missingMarker(tag, 'amazon.bought_count.' + cat);
  }
  return out;
}

function bakeFbtStrings(tag) {
  // amazon-booster.liquid pre-pluralizes fbt_add server-side: Shopify's t
  // filter selects the CLDR category for the literal count.
  const az = amazonByLocale[tag];
  const out = {};
  for (let n = 1; n <= 4; n++) {
    const cat = new Intl.PluralRules(tag).select(n);
    const v = (az.fbt_add && (az.fbt_add[cat] !== undefined ? az.fbt_add[cat] : az.fbt_add.other)) || '';
    out['amazon.fbt_add_' + n] = v.split('{{ count }}').join(String(n));
  }
  out['amazon.fbt_add_both'] = az.fbt_add_both;
  return out;
}

// -------------------------------------------- independent expectations
function expectedCompact(n, locale) {
  let anchor = n;
  if (n >= 1000000) anchor = Math.floor(n / 1000000) * 1000000;
  else if (n >= 1000) anchor = Math.floor(n / 1000) * 1000;
  const lang = (locale || '').split('-')[0].toLowerCase();
  if ((lang === 'da' || lang === 'fi' || lang === 'hu') && anchor < 10000) {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(anchor);
  }
  return new Intl.NumberFormat(locale || undefined, {
    notation: 'compact', maximumFractionDigits: 0, roundingMode: 'floor',
  }).format(anchor);
}

function expectedCta(tag, n) {
  const cta = amazonByLocale[tag].cta_count;
  let cat = new Intl.PluralRules(tag).select(n);
  if (typeof cta[cat] !== 'string') cat = 'other';
  return cta[cat].split('{{ count }}').join(n.toLocaleString(tag));
}

function expectedBought(tag, n) {
  const bc = amazonByLocale[tag].bought_count;
  let cat = new Intl.PluralRules(tag).select(n);
  if (cat === 'zero' || typeof bc[cat] !== 'string') cat = 'other'; // zero is never baked
  return bc[cat].split('{{ n }}').join(expectedCompact(n, tag));
}

// ------------------------------------------------------ engine builders
function buildCartBundle(src) {
  return [
    'var decodeArea = null;',
    extractFunction(src, 'decodeEntities'),
    extractFunction(src, 't'),
    extractFunction(src, 'azStr'),
    extractFunction(src, 'azPageLocale'),
    extractFunction(src, 'azCompact'),
    extractFunction(src, 'azCtaLabel'),
    extractFunction(src, 'cardBoughtLabel'),
  ].join('\n');
}

function buildPdpFbtBundle(src) {
  return [
    'var decodeArea = null;',
    'var azFbtBusy = false;',
    extractFunction(src, 'decodeEntities'),
    extractFunction(src, 'azT'),
    extractFunction(src, 'azMoney'),
    extractFunction(src, 'azPageLocale'),
    extractFunction(src, 'azCompact'),
    extractFunction(src, 'azFbtRows'),
    extractFunction(src, 'azFbtUpdate'),
  ].join('\n');
}

const cartBundle = buildCartBundle(srcs.cart);
const pdpFbtBundle = buildPdpFbtBundle(srcs.pdp);

function cartEngine(bundle, tag, stringsOverride) {
  const strings = stringsOverride === undefined ? bakeCartStrings(tag) : stringsOverride;
  return compileEngine(bundle, {
    cfg: { pageLocale: tag, strings },
    STRINGS: strings,
    window: {},
  });
}

/** Minimal fake FBT node: 5 rows, first `checked` boxes ticked. */
function fakeFbtNode(pricesCents, checkedCount) {
  const rows = pricesCents.map((cents, i) => ({
    __attrs: { 'data-price-cents': String(cents) },
    __check: { checked: i < checkedCount },
    querySelector(sel) { return sel === '.cx-az-fbt__check' ? this.__check : null; },
    getAttribute(name) { return this.__attrs[name]; },
  }));
  const totalEl = { textContent: 'TOTAL-SENTINEL' };
  const btn = { textContent: 'LABEL-SENTINEL', disabled: null };
  const node = {
    querySelectorAll(sel) { return sel === '[data-cx-az-fbt-row]' ? rows : []; },
    querySelector(sel) {
      if (sel === '[data-cx-az-fbt-total]') return totalEl;
      if (sel === '[data-cx-az-fbt-add]') return btn;
      return null;
    },
  };
  return { node, totalEl, btn };
}

function expectedMoneyEUR(cents) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

// ---------------------------------------------------- behavior matrix
function runCta(t, bundle) {
  for (const tag of LOCALES) {
    const ctx = cartEngine(bundle, tag);
    for (const n of COUNTS) {
      t.eq('cta ' + tag + ' n=' + n, ctx.azCtaLabel(n), expectedCta(tag, n));
    }
    t.eq('cta ' + tag + ' n=0 allowed', ctx.azCtaLabel(0), expectedCta(tag, 0));
    t.eq('cta ' + tag + ' n=2.7 floors to 2', ctx.azCtaLabel(2.7), expectedCta(tag, 2));
    t.eq('cta ' + tag + ' n=-1 -> null', ctx.azCtaLabel(-1), null);
    t.eq('cta ' + tag + ' n=NaN -> null', ctx.azCtaLabel(NaN), null);
  }
  {
    // Unusable "other" (missing marker) -> null, never a raw key.
    const strings = bakeCartStrings('en');
    strings['amazon.cta_count.other'] = missingMarker('en', 'amazon.cta_count.other');
    const ctx = cartEngine(bundle, 'en', strings);
    t.eq('cta fail-closed: unusable other -> null', ctx.azCtaLabel(3), null);
  }
  {
    // Page-locale digits rule: the rendered figure must be exactly what
    // toLocaleString produces for the PAGE locale (on ICU builds where
    // "ar" resolves to Arabic-Indic digits that means ١٠١ — never a
    // hardcoded Latin fallback of the engine's own making).
    const ctx = cartEngine(bundle, 'ar');
    const label = ctx.azCtaLabel(101);
    t.check('cta ar uses page-locale digits', typeof label === 'string' &&
      label.indexOf((101).toLocaleString('ar')) !== -1, label);
  }
}

function runBought(t, bundle) {
  for (const tag of LOCALES) {
    const ctx = cartEngine(bundle, tag);
    for (const n of COUNTS) {
      t.eq('bought ' + tag + ' n=' + n, ctx.cardBoughtLabel(n), expectedBought(tag, n));
    }
    t.eq('bought ' + tag + ' n=0 -> null', ctx.cardBoughtLabel(0), null);
    t.eq('bought ' + tag + ' n=-5 -> null', ctx.cardBoughtLabel(-5), null);
    t.eq('bought ' + tag + ' n=NaN -> null', ctx.cardBoughtLabel(NaN), null);
  }
  {
    const strings = bakeCartStrings('en');
    strings['amazon.bought_count.other'] = missingMarker('en', 'amazon.bought_count.other');
    const ctx = cartEngine(bundle, 'en', strings);
    t.eq('bought fail-closed: unusable other -> null', ctx.cardBoughtLabel(5), null);
  }
}

function runCompact(t, bundle) {
  const values = [1, 950, 999, 1000, 1940, 1999, 2000, 9999, 10000, 15000, 123456, 999999, 1000000, 1940000, 2500000];
  const compactLocales = ['en', 'ja', 'da', 'fi', 'hu', 'fr', 'ar', 'pl'];
  for (const tag of compactLocales) {
    // azCompact never touches the strings map — an empty one keeps the
    // baking path (which only exists for the six plural locales) out.
    const ctx = cartEngine(bundle, tag, {});
    for (const v of values) {
      t.eq('compact ' + tag + ' ' + v, ctx.azCompact(v), expectedCompact(v, tag));
    }
  }
  // Hard honesty expectations (en): the "+" may only ever under-claim.
  const en = cartEngine(bundle, 'en', {});
  const hard = [[950, '950'], [1940, '1K'], [1999, '1K'], [2000, '2K'], [999999, '999K'], [1940000, '1M'], [2500000, '2M']];
  for (const [v, expected] of hard) {
    t.eq('compact en hard: ' + v + ' -> ' + expected, en.azCompact(v), expected);
  }
  // da/fi/hu grouped-digit opt-out below 10 000, floored anchor first.
  for (const tag of ['da', 'fi', 'hu']) {
    const ctx = cartEngine(bundle, tag, {});
    t.eq('compact ' + tag + ' 1940 -> grouped floor(1000)', ctx.azCompact(1940),
      new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }).format(1000));
    t.eq('compact ' + tag + ' 2000 -> grouped 2000', ctx.azCompact(2000),
      new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }).format(2000));
    t.check('compact ' + tag + ' 15000 uses the compact unit (opt-out ends at 10000)',
      ctx.azCompact(15000) === expectedCompact(15000, tag) &&
      ctx.azCompact(15000) !== new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }).format(15000));
  }
}

function runFbt(t, bundle) {
  const prices = [1999, 2450, 999, 1500, 3000];
  for (const tag of LOCALES) {
    const strings = bakeFbtStrings(tag);
    for (let checked = 0; checked <= 5; checked++) {
      const ctx = compileEngine(bundle, {
        AZ_CFG: { strings, pageLocale: tag, currency: 'EUR' },
        window: {},
      });
      const { node, totalEl, btn } = fakeFbtNode(prices, checked);
      ctx.azFbtUpdate(node);
      const label = checked === 2
        ? strings['amazon.fbt_add_both']
        : strings['amazon.fbt_add_' + Math.min(Math.max(checked, 1), 4)];
      t.eq('fbt ' + tag + ' checked=' + checked + ' label', btn.textContent, label);
      t.eq('fbt ' + tag + ' checked=' + checked + ' disabled', btn.disabled, checked < 1);
      const cents = prices.slice(0, checked).reduce((a, b) => a + b, 0);
      t.eq('fbt ' + tag + ' checked=' + checked + ' total', totalEl.textContent, expectedMoneyEUR(cents));
    }
  }
  {
    // A language without the "both" form falls to the count plural.
    const strings = bakeFbtStrings('en');
    strings['amazon.fbt_add_both'] = ''; // azT treats '' as unusable
    const ctx = compileEngine(bundle, { AZ_CFG: { strings, pageLocale: 'en', currency: 'EUR' }, window: {} });
    const { node, btn } = fakeFbtNode(prices, 2);
    ctx.azFbtUpdate(node);
    t.eq('fbt fallback: missing both-form -> count plural', btn.textContent, strings['amazon.fbt_add_2']);
  }
}

// ------------------------------------------------------------- main run
runCta(tap, cartBundle);
runBought(tap, cartBundle);
runCompact(tap, cartBundle);
runFbt(tap, pdpFbtBundle);

// -------------------------------------------------------- mutation tests
const MUTANTS = [
  {
    name: 'P1 PluralRules select(n) -> select(1)',
    bundle: 'cart',
    find: 'cat = new Intl.PluralRules(locale).select(n);',
    replace: 'cat = new Intl.PluralRules(locale).select(1);',
    rerun: (t, code) => { runCta(t, code); runBought(t, code); },
  },
  {
    name: 'P2 honesty pre-floor dropped (anchor = n)',
    bundle: 'cart',
    find: 'else if (n >= 1000) anchor = Math.floor(n / 1000) * 1000;',
    replace: 'else if (n >= 1000) anchor = n;',
    rerun: (t, code) => { runCompact(t, code); },
  },
  {
    name: 'P3 da/fi/hu grouped opt-out threshold 10000 -> 1000',
    bundle: 'cart',
    find: "if ((azLang === 'da' || azLang === 'fi' || azLang === 'hu') && anchor < 10000) {",
    replace: "if ((azLang === 'da' || azLang === 'fi' || azLang === 'hu') && anchor < 1000) {",
    rerun: (t, code) => { runCompact(t, code); },
  },
  {
    name: 'P4 FBT clamp Math.max(count, 1) dropped',
    bundle: 'pdp',
    find: "if (!label) label = azT('amazon.fbt_add_' + Math.min(Math.max(count, 1), 4));",
    replace: "if (!label) label = azT('amazon.fbt_add_' + Math.min(count, 4));",
    rerun: (t, code) => { runFbt(t, code); },
  },
  {
    name: 'P5 cta other-guard dropped',
    bundle: 'cart',
    find: "if (!azStr('amazon.cta_count.other')) return null;",
    replace: ';',
    rerun: (t, code) => { runCta(t, code); },
  },
];

for (const mutant of MUTANTS) {
  const source = mutant.bundle === 'cart' ? cartBundle : pdpFbtBundle;
  const occurrences = source.split(mutant.find).length - 1;
  tap.check('mutant anchor present: ' + mutant.name, occurrences >= 1,
    'find-string not in extracted bundle: ' + mutant.find);
  if (occurrences < 1) continue;
  const mutated = source.split(mutant.find).join(mutant.replace);
  const silent = makeTap('mutant:' + mutant.name);
  silent.beginSilent();
  mutant.rerun(silent, mutated);
  tap.check('mutant CAUGHT: ' + mutant.name, silent.failed > 0,
    'mutant survived ' + silent.run + ' checks');
}

tap.finish();
