/**
 * Shared vm-extraction helpers for the feature sims (house convention:
 * every sim executes the REAL shipped functions, sliced verbatim out of
 * the theme JS — never re-implementations).
 *
 * Functions in both theme assets are declared at 2-space indent inside
 * the IIFE ("  function name("), module state as "  var name = ...;".
 * Extraction is brace-balanced and FAILS LOUDLY when an anchor is
 * missing, so a refactor that moves/renames a function breaks the sim
 * instead of silently testing nothing.
 */
"use strict";

function extractFunction(src, name) {
  const marker = `  function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`function ${name} not found in source`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function extractVar(src, name) {
  const marker = `  var ${name} = `;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`var ${name} not found in source`);
  const eq = start + marker.length;
  const first = src[eq];
  if (first === "{" || first === "[") {
    const open = first;
    const close = first === "{" ? "}" : "]";
    let depth = 0;
    for (let i = eq; i < src.length; i++) {
      const ch = src[i];
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return src.slice(start, i + 2); // include ";"
      }
    }
    throw new Error(`unbalanced ${open}${close} extracting var ${name}`);
  }
  // Simple initializer: cut at the first ";" (values in the shipped files
  // never contain one; trailing same-line comments are dropped).
  const end = src.indexOf(";", eq);
  if (end === -1) throw new Error(`no terminator for var ${name}`);
  return src.slice(start, end + 1);
}

function extractAll(src, { functions = [], vars = [] } = {}) {
  const parts = [];
  for (const v of vars) parts.push(extractVar(src, v));
  for (const f of functions) parts.push(extractFunction(src, f));
  return parts.join("\n\n");
}

module.exports = { extractFunction, extractVar, extractAll };
