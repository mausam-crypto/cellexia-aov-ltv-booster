/**
 * validation/lib/extract.mjs — shared vm-extraction toolkit for the sims.
 *
 * The engine sims NEVER re-implement shipped logic: they slice the REAL
 * function bodies out of the shipped sources (extensions/cellexia-booster/
 * assets/*.js) by name, compile them in an isolated vm context with an
 * injected fixed clock, and drive them with fixtures. If a function is
 * renamed, moved, or duplicated, extraction fails loudly — the suite can
 * never silently test a stale or wrong copy.
 *
 * The brace matcher is string/comment-aware (the shipped ES5 contains
 * braces inside quoted RegExp sources like '\\{\\{\\s*'). Regex-literal
 * state is deliberately not modeled: none of the extracted functions
 * contains a regex literal with quotes, braces or comment openers, and
 * every extraction is compile-checked with new Function() so a future
 * violation fails the suite instead of corrupting it.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

/** Index of the brace that closes the one at `openIdx` (which must be `{` or `[`). */
function matchBrace(src, openIdx) {
  const open = src[openIdx];
  const close = open === '{' ? '}' : ']';
  if (open !== '{' && open !== '[') {
    throw new Error('matchBrace: not an opener at ' + openIdx + ': ' + open);
  }
  let depth = 0;
  let i = openIdx;
  let mode = 'code'; // code | line-comment | block-comment | single | double
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line-comment'; i += 2; continue; }
      if (ch === '/' && next === '*') { mode = 'block-comment'; i += 2; continue; }
      if (ch === "'") { mode = 'single'; i++; continue; }
      if (ch === '"') { mode = 'double'; i++; continue; }
      if (ch === open) depth++;
      if (ch === close) {
        depth--;
        if (depth === 0) return i;
      }
    } else if (mode === 'line-comment') {
      if (ch === '\n') mode = 'code';
    } else if (mode === 'block-comment') {
      if (ch === '*' && next === '/') { mode = 'code'; i += 2; continue; }
    } else if (mode === 'single') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") mode = 'code';
    } else if (mode === 'double') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') mode = 'code';
    }
    i++;
  }
  throw new Error('matchBrace: unterminated from index ' + openIdx);
}

/**
 * Extract `function <name>(...) {...}` source text. Throws when the name is
 * missing or ambiguous, and compile-checks the slice.
 */
export function extractFunction(src, name) {
  const sig = 'function ' + name + '(';
  const idx = src.indexOf(sig);
  if (idx === -1) throw new Error('extractFunction: not found: ' + name);
  if (src.indexOf(sig, idx + sig.length) !== -1) {
    throw new Error('extractFunction: ambiguous (multiple definitions): ' + name);
  }
  const braceStart = src.indexOf('{', idx + sig.length - 1);
  const end = matchBrace(src, braceStart);
  const text = src.slice(idx, end + 1);
  // Compile check: a corrupted slice must fail HERE, not mid-suite.
  // eslint-disable-next-line no-new-func
  new Function(text);
  return text;
}

/**
 * Extract `var <NAME> = {...};` / `var <NAME> = [...];` literal statements.
 */
export function extractVar(src, name) {
  const sig = 'var ' + name + ' = ';
  const idx = src.indexOf(sig);
  if (idx === -1) throw new Error('extractVar: not found: ' + name);
  if (src.indexOf(sig, idx + sig.length) !== -1) {
    throw new Error('extractVar: ambiguous (multiple definitions): ' + name);
  }
  const openIdx = idx + sig.length;
  const opener = src[openIdx];
  if (opener !== '{' && opener !== '[') {
    throw new Error('extractVar: ' + name + ' is not an object/array literal');
  }
  const end = matchBrace(src, openIdx);
  const text = src.slice(idx, end + 1) + ';';
  // eslint-disable-next-line no-new-func
  new Function(text);
  return text;
}

/**
 * Extract `export const <NAME>[: type] = {...};` / `= [...];` from a
 * TypeScript source and RETURN THE PARSED VALUE (the literal is plain JSON-
 * compatible data in the delivery tables).
 */
export function extractTsConstValue(src, name) {
  const sig = 'export const ' + name;
  const idx = src.indexOf(sig);
  if (idx === -1) throw new Error('extractTsConstValue: not found: ' + name);
  const eq = src.indexOf('=', idx);
  if (eq === -1) throw new Error('extractTsConstValue: no assignment: ' + name);
  let openIdx = eq + 1;
  while (openIdx < src.length && /\s/.test(src[openIdx])) openIdx++;
  const opener = src[openIdx];
  if (opener !== '{' && opener !== '[') {
    throw new Error('extractTsConstValue: ' + name + ' is not a literal');
  }
  const end = matchBrace(src, openIdx);
  const literal = src.slice(openIdx, end + 1);
  // eslint-disable-next-line no-new-func
  return new Function('return (' + literal + ');')();
}

/**
 * A Date class whose zero-argument construction (and .now()) is pinned to
 * `fixedMs` — the injected deterministic clock. Argument construction and
 * all statics delegate to the REAL host Date, so Intl interop, getUTC*()
 * and Date.UTC() behave exactly as in production.
 */
export function fixedDateClass(fixedMs) {
  const RealDate = Date;
  function FixedDate(...args) {
    if (args.length === 0) return new RealDate(fixedMs);
    return new RealDate(...args);
  }
  FixedDate.UTC = RealDate.UTC.bind(RealDate);
  FixedDate.parse = RealDate.parse.bind(RealDate);
  FixedDate.now = () => fixedMs;
  FixedDate.prototype = RealDate.prototype;
  return FixedDate;
}

/**
 * Compile a bundle of extracted statements in a fresh vm context and return
 * the context (the extracted functions live on it as globals).
 *
 * `sandbox` entries become globals of the context; `Date` defaults to the
 * host Date unless a fixed clock is supplied.
 */
export function compileEngine(code, sandbox) {
  const ctx = vm.createContext(Object.assign({}, sandbox));
  vm.runInContext(code, ctx, { filename: 'extracted-engine.js' });
  return ctx;
}

/**
 * Tiny self-checking test API shared by the sims. checksRun is asserted
 * > 0 by every suite before printing ALL-N-PASSED (anti-vacuity).
 */
export function makeTap(suiteName) {
  const state = { name: suiteName, run: 0, failed: 0, failures: [], silent: false };
  return {
    check(label, cond, detail) {
      state.run++;
      if (!cond) {
        state.failed++;
        state.failures.push(label + (detail !== undefined ? ' :: ' + String(detail) : ''));
        if (!state.silent) {
          console.error('FAIL  ' + label + (detail !== undefined ? '\n      ' + String(detail) : ''));
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
    endSilent() { state.silent = false; },
    get run() { return state.run; },
    get failed() { return state.failed; },
    get failures() { return state.failures.slice(); },
    reset() { state.run = 0; state.failed = 0; state.failures = []; },
    finish() {
      if (state.run === 0) {
        console.error(state.name + ': VACUOUS — zero checks executed');
        process.exit(1);
      }
      if (state.failed > 0) {
        console.error(state.name + ': ' + state.failed + ' of ' + state.run + ' checks FAILED');
        process.exit(1);
      }
      console.log('ALL-' + state.run + '-PASSED (' + state.name + ')');
    },
  };
}
