#!/usr/bin/env node
/**
 * validation/sims/native-dates.mjs — v6.0.1 DATE_STYLE native-date sim.
 *
 * FRESHLY generates the date fixtures on every run (into
 * validation/fixtures/native-dates-fixtures.json, committed for human
 * inspection) via the independent generator in
 * validation/lib/native-dates-gen.mjs — Intl.DateTimeFormat.format, NOT the
 * shipped toLocaleDateString path — then asserts that the REAL vm-extracted
 * deliveryFormatDate from BOTH theme engines (cellexia-pdp.js +
 * cellexia-cart.js) reproduces every fixture byte-for-byte.
 *
 * Coverage:
 *  - all 18 shipped theme locales, tags taken LIVE from
 *    extensions/cellexia-booster/locales/*.json (en.default.json -> "en",
 *    pt-PT.json stays regional — the verbatim-tag rule)
 *  - day 1 of all twelve 2026 months + one full Mon..Sun week (all seven
 *    ISO weekdays) + a month boundary — 20 stamps x 18 locales
 *  - the fr "1er" ordinal upgrade (day-1 labels for base language fr,
 *    including the hard expectation "vendredi 1er mai"), and its absence on
 *    fr day 21 (no \b1\b false positive) and on every non-fr locale
 *  - the ja e-commerce convention (month-day-weekday, e.g. 7月25日(土))
 *  - fallback chain: empty locale and Intl-rejected tags -> the short
 *    browser form; both engines equal the independently computed fallback
 *  - TWIN GUARANTEE: deliveryFormatDate byte-identical in both theme files
 *    (the checkout TS twin is asserted against the same generator in
 *    validation/sims/checkout-delivery-engine.ts)
 *
 * Offline, deterministic (fixed calendar stamps; Intl output is stable per
 * ICU build and the fixtures are regenerated with the local ICU each run).
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
import {
  expectedNativeDate,
  expectedShortFallback,
  generateFixtures,
} from '../lib/native-dates-gen.mjs';

const PDP = 'extensions/cellexia-booster/assets/cellexia-pdp.js';
const CART = 'extensions/cellexia-booster/assets/cellexia-cart.js';
const LOCALES_DIR = 'extensions/cellexia-booster/locales';
const FIXTURES_PATH = path.join(REPO_ROOT, 'validation', 'fixtures', 'native-dates-fixtures.json');

const tap = makeTap('native-dates');

// ------------------------------------------------ live locale inventory
const localeFiles = fs
  .readdirSync(path.join(REPO_ROOT, LOCALES_DIR))
  .filter((f) => f.endsWith('.json'))
  .sort();
const locales = localeFiles.map((f) => f.replace(/\.default\.json$|\.json$/, ''));
tap.eq('theme ships exactly 18 locale files', locales.length, 18);
tap.check('en present via en.default.json', locales.includes('en'));
tap.check('regional tag pt-PT kept verbatim', locales.includes('pt-PT'));

// --------------------------------------------------- engine extraction
const srcs = { pdp: readSource(PDP), cart: readSource(CART) };
const fnPdp = extractFunction(srcs.pdp, 'deliveryFormatDate');
const fnCart = extractFunction(srcs.cart, 'deliveryFormatDate');
tap.check('twin byte-identical: deliveryFormatDate', fnPdp === fnCart);

const engines = {
  pdp: compileEngine(fnPdp, { Date }),
  cart: compileEngine(fnCart, { Date }),
};

// ------------------------------------- fresh fixtures, then comparison
const fixtures = generateFixtures(locales);
fs.mkdirSync(path.dirname(FIXTURES_PATH), { recursive: true });
fs.writeFileSync(FIXTURES_PATH, JSON.stringify(fixtures, null, 2) + '\n');
tap.check('fixtures freshly generated', fixtures.entries.length === locales.length * 20,
  fixtures.entries.length);

// Weekday coverage sanity: the stamp set must span all seven ISO weekdays.
{
  const isoDays = new Set(fixtures.entries.map((e) => new Date(e.ut).getUTCDay()));
  tap.eq('stamp set covers all seven weekdays', isoDays.size, 7);
}

for (const entry of fixtures.entries) {
  for (const file of ['pdp', 'cart']) {
    const got = engines[file].deliveryFormatDate(entry.ut, entry.locale);
    tap.check(
      'native date ' + entry.locale + ' ' + entry.iso + ' [' + file + ']',
      got === entry.label,
      'got=' + JSON.stringify(got) + ' expected=' + JSON.stringify(entry.label),
    );
  }
}

// ----------------------------------------------------- fr "1er" rule
for (const entry of fixtures.entries) {
  const base = entry.locale.split('-')[0].toLowerCase();
  const day = new Date(entry.ut).getUTCDate();
  if (base === 'fr' && day === 1) {
    tap.check('fr day-1 label carries 1er (' + entry.iso + ')', /\b1er\b/.test(entry.label), entry.label);
  } else {
    tap.check('no stray 1er: ' + entry.locale + ' ' + entry.iso, !/1er/.test(entry.label), entry.label);
  }
}
{
  const may1 = engines.pdp.deliveryFormatDate(Date.UTC(2026, 4, 1), 'fr');
  tap.eq('fr hard expectation: 2026-05-01', may1, 'vendredi 1er mai');
  const jul21 = engines.pdp.deliveryFormatDate(Date.UTC(2026, 6, 21), 'fr');
  tap.check('fr day 21: the digit 1 in 21 is not upgraded', !/1er/.test(jul21), jul21);
}

// ------------------------------------------------------ ja convention
{
  const ja = engines.pdp.deliveryFormatDate(Date.UTC(2026, 6, 25), 'ja');
  tap.eq('ja hard expectation: 2026-07-25 (Sat)', ja, '7月25日(土)');
  for (const entry of fixtures.entries.filter((e) => e.locale === 'ja')) {
    tap.check('ja convention month-day form ' + entry.iso, /月.*日/.test(entry.label), entry.label);
  }
}

// ---------------------------------------------------- fallback chain
{
  const ut = Date.UTC(2026, 6, 22);
  const short = expectedShortFallback(ut);
  for (const file of ['pdp', 'cart']) {
    tap.eq('fallback: empty locale -> short form [' + file + ']',
      engines[file].deliveryFormatDate(ut, ''), short);
    tap.eq('fallback: non-string locale -> short form [' + file + ']',
      engines[file].deliveryFormatDate(ut, null), short);
    tap.eq('fallback: Intl-rejected tag -> short form [' + file + ']',
      engines[file].deliveryFormatDate(ut, 'no way!'), short);
  }
  // Generator and engine agree on the rejected-tag path too.
  tap.eq('generator models the rejected-tag fallback', expectedNativeDate(ut, 'no way!'), short);
}

// -------------------------------------- verbatim regional tag behavior
{
  // pt-PT must be passed through untouched — assert the label equals what
  // Intl produces for the FULL tag (not the base language pt).
  const ut = Date.UTC(2026, 2, 1); // Sunday
  const viaFullTag = expectedNativeDate(ut, 'pt-PT');
  tap.eq('pt-PT passed verbatim to Intl', engines.pdp.deliveryFormatDate(ut, 'pt-PT'), viaFullTag);
}

tap.finish();
