#!/usr/bin/env node
/**
 * deploy-safety (v8.23) — tripwires for the "the deploy blanked the whole
 * storefront while the admin looked normal" incident classes that are
 * machine-checkable from the source tree:
 *
 *   1. ES5 WHOLE-FILE PARSE — one accidental arrow function / const /
 *      template literal makes an older browser throw a SyntaxError for the
 *      ENTIRE asset: every widget that file drives goes dark at once.
 *      acorn parses every theme-extension JS asset as ecmaVersion 5.
 *
 *   2. ISLAND JSON MATRIX — every widget boots from JSON.parse of a
 *      <script type="application/json"> island; pfIsland/cxIsland return
 *      null on a parse error and the widget silently never renders. A
 *      misplaced comma inside a {% if %} branch only breaks SOME settings
 *      combinations, which is exactly how it slips reviews. This section
 *      expands every island body across its branch combinations
 *      (all-off, all-first, all-last, each-branch-alone, each-group-off-
 *      with-the-rest-on) and JSON.parses every expansion.
 *
 *   3. ASSET REFERENCES — every `| asset_url` name in blocks/snippets
 *      must exist in assets/ (a renamed asset 404s and kills its widgets).
 *
 *   4. LOCALE FILE CAP — Shopify hard-rejects locale files over 15,360B at
 *      deploy time (the el.json wall). Every extension locale file must
 *      stay under 15,300B.
 *
 *   5. EMISSION SIZE — the config metafield carrier (the serialized
 *      settings emission) must keep generous headroom under Shopify's
 *      65,536-char metafield value cap: a too-big blob makes the SAVE
 *      fail and the storefront serve stale (or no) config.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const acorn = require("acorn");

const ROOT = path.resolve(__dirname, "..", "..");
const EXT = path.join(ROOT, "extensions", "cellexia-booster");

let checks = 0, failures = 0;
function ok(cond, label) {
  checks++;
  if (!cond) { failures++; console.error("FAIL: " + label); }
}
function read(p) { return fs.readFileSync(p, "utf8"); }
function listFiles(dir, ext) {
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(ext)).sort()
    : [];
}

// ------------------------------------------------ 1. ES5 whole-file parse
{
  const assetsDir = path.join(EXT, "assets");
  const jsFiles = listFiles(assetsDir, ".js");
  ok(jsFiles.length >= 3, `es5: found the theme JS assets (${jsFiles.join(", ")})`);
  for (const f of jsFiles) {
    let parsed = false, error = "";
    try {
      acorn.parse(read(path.join(assetsDir, f)), {
        ecmaVersion: 5,
        sourceType: "script",
      });
      parsed = true;
    } catch (e) {
      error = String(e && e.message);
    }
    ok(parsed, `es5: ${f} parses as ES5 (a syntax error darkens EVERY widget in the file): ${error}`);
  }
}

// ------------------------------------------------ 2. island JSON matrix
//
// Minimal Liquid-tag structure parser for the island BODIES only: text,
// {{ output }}, and {% if/elsif/else/endif %} groups (nesting supported).
// Non-if tags ({% assign %}, {% comment %}…) render as ''.

function tokenize(src) {
  return src.split(/(\{%-?[\s\S]*?-?%\}|\{\{-?[\s\S]*?-?\}\})/).filter((s) => s !== "");
}

function tagKind(tok) {
  if (/^\{\{/.test(tok)) return "output";
  if (!/^\{%/.test(tok)) return "text";
  const inner = tok.replace(/^\{%-?\s*/, "").replace(/\s*-?%\}$/, "");
  const word = inner.split(/\s+/)[0];
  if (word === "if") return "if";
  if (word === "unless") return "unless";
  if (word === "elsif") return "elsif";
  if (word === "else") return "else";
  if (word === "endif") return "endif";
  if (word === "endunless") return "endunless";
  if (word === "for") return "for";
  if (word === "endfor") return "endfor";
  if (word === "comment") return "comment";
  if (word === "endcomment") return "endcomment";
  if (word === "case" || word === "tablerow") return "unsupported";
  return "other";
}

function tagCondition(tok) {
  const inner = tok.replace(/^\{%-?\s*/, "").replace(/\s*-?%\}$/, "");
  return inner.split(/\s+/).slice(1).join(" ");
}

/** true when every branch of the group is pure separator text ("," or ""). */
function isSeparatorGuard(group) {
  return group.branches.every((branch) =>
    branch.every((node) => node.t === "text") &&
    /^[,\s]*$/.test(branch.map((node) => node.v).join("")),
  );
}

/**
 * Parse tokens into a tree; returns { children, groups, unsupported }.
 *
 * Loops render as TWO iterations (review catch: single-iteration
 * expansion could never see a missing comma BETWEEN rows). Guard groups
 * resolve at RENDER time per iteration instead of joining the matrix:
 *   - kind "forloop": condition mentions forloop.first/last — evaluated
 *     against the iteration context (iter 1: first, iter 2: last).
 *   - kind "sepflag": every branch is pure separator text and the
 *     condition is a bare flag variable — its `assign <flag> = true|false`
 *     initializer is read from the island (review catch: a polarity
 *     FLIP, `= false`, makes the separator leading — and now fails);
 *     iteration 2 sees the body's reassignment, i.e. the flipped value.
 *   - kind null (plain): enumerable — joins the combination matrix with
 *     its ancestor path recorded, so branches nested inside another
 *     group's body get their own targeted combos (review catch: the
 *     dossier elsif branch had zero coverage).
 */
function parseBody(tokens) {
  const groups = [];
  const stack = [];
  let unsupported = null;
  let i = 0;
  function parseChildren(stopKinds) {
    const children = [];
    while (i < tokens.length) {
      const tok = tokens[i];
      const kind = tagKind(tok);
      if (stopKinds.includes(kind)) return children;
      i++;
      if (kind === "text") children.push({ t: "text", v: tok });
      else if (kind === "output") children.push({ t: "out", v: tok });
      else if (kind === "unsupported") unsupported = tok.slice(0, 40);
      else if (kind === "comment") {
        while (i < tokens.length && tagKind(tokens[i]) !== "endcomment") i++;
        i++; // consume endcomment
      } else if (kind === "for") {
        const body = parseChildren(["endfor"]);
        i++; // consume endfor
        children.push({ t: "loop", children: body });
      } else if (kind === "if" || kind === "unless") {
        const inverted = kind === "unless";
        const endTag = inverted ? "endunless" : "endif";
        const cond = tagCondition(tok);
        const group = {
          t: "if",
          branches: [],
          hasElse: false,
          guard: null, // {kind, inverted, negated, on: 'first'|'last', initTruthy}
          path: stack.slice(),
        };
        for (;;) {
          stack.push({ group, branch: group.branches.length });
          const branch = parseChildren(["elsif", "else", endTag]);
          stack.pop();
          group.branches.push(branch);
          const stopped = tokens[i];
          i++; // consume elsif/else/end*
          const stoppedKind = tagKind(stopped);
          if (stoppedKind === endTag) break;
          if (stoppedKind === "else") {
            group.hasElse = true;
            stack.push({ group, branch: group.branches.length });
            group.branches.push(parseChildren([endTag]));
            stack.pop();
            i++; // consume end*
            break;
          }
          // elsif: loop continues into the next branch
        }
        const negated = /!=\s*true|==\s*false/.test(cond);
        if (/forloop\./.test(cond)) {
          group.guard = {
            kind: "forloop",
            inverted,
            negated,
            on: /forloop\.last/.test(cond) ? "last" : "first",
          };
        } else if (isSeparatorGuard(group)) {
          const flag = (/^([A-Za-z_]\w*)\s*$/.exec(cond) || [])[1] || null;
          let initTruthy = true; // the universal separator idiom
          if (flag) {
            const initRe = new RegExp(
              "assign\\s+" + flag + "\\s*=\\s*(true|false)\\b",
            );
            for (const t of tokens) {
              if (tagKind(t) !== "other") continue;
              const mm = initRe.exec(t);
              if (mm) { initTruthy = mm[1] === "true"; break; }
            }
          }
          group.guard = { kind: "sepflag", inverted, negated, initTruthy };
        } else {
          groups.push(group);
        }
        children.push(group);
      }
      // "other" tags (assign, break, continue, …) render as ''
    }
    return children;
  }
  const children = parseChildren([]);
  return { children, groups, unsupported };
}

/** Replace one {{ output }} with a placeholder. mode "json" targets JSON
 *  islands ("x"/0); mode "js" targets inline scripts — the bare
 *  placeholder must survive IDENTIFIER position (w.__cxSeen.{{ key }}). */
function renderOutput(tok, mode) {
  const inner = tok.replace(/^\{\{-?\s*/, "").replace(/\s*-?\}\}$/, "");
  if (/\|\s*json\s*$/.test(inner)) return '"x"';
  return mode === "js" ? "x1" : "0";
}

/** Resolve a render-time guard under the iteration context (null ctx =
 *  outside any loop: first === last === true). */
function guardChoice(group, ctx) {
  const g = group.guard;
  let truthy;
  if (g.kind === "forloop") {
    truthy = ctx === null ? true : g.on === "last" ? ctx.last : ctx.first;
    if (g.negated) truthy = !truthy;
  } else {
    // sepflag: the initializer's value on the first pass; the body
    // reassigns, so later iterations see the flipped value.
    const flagValue = ctx === null || ctx.first ? g.initTruthy : !g.initTruthy;
    truthy = g.negated ? !flagValue : flagValue;
  }
  if (g.inverted) truthy = !truthy;
  return truthy ? 0 : -1;
}

/**
 * Render the tree under a choice function (plain group object -> requested
 * branch; -1 = "condition false"). A REAL Liquid render of an if/else
 * always yields one branch, so -1 on a hasElse group resolves to its else
 * branch — "off" is only reachable for groups without else. Loops render
 * their body TWICE: iteration 1 (first) and iteration 2 (last).
 */
function renderTree(children, choose, ctx, mode) {
  let out = "";
  for (const node of children) {
    if (node.t === "text") out += node.v;
    else if (node.t === "out") out += renderOutput(node.v, mode);
    else if (node.t === "loop") {
      out += renderTree(node.children, choose, { first: true, last: false }, mode);
      out += renderTree(node.children, choose, { first: false, last: true }, mode);
    } else if (node.t === "if") {
      let idx = node.guard !== null ? guardChoice(node, ctx) : choose(node);
      if (idx === -1 && node.hasElse) idx = node.branches.length - 1;
      if (idx >= 0 && idx < node.branches.length) {
        out += renderTree(node.branches[idx], choose, ctx, mode);
      }
    }
  }
  return out;
}

{
  const dirs = [path.join(EXT, "blocks"), path.join(EXT, "snippets")];
  let islands = 0;
  for (const dir of dirs) {
    for (const f of listFiles(dir, ".liquid")) {
      const src = read(path.join(dir, f));
      const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
      let m;
      let fileIslands = 0;
      while ((m = re.exec(src)) !== null) {
        islands++;
        fileIslands++;
        const body = m[1];
        const { children, groups, unsupported } = parseBody(tokenize(body));
        ok(
          unsupported === null,
          `island-json: ${f} island #${fileIslands} uses only supported Liquid structures (found ${unsupported} — extend the expander before shipping it)`,
        );
        const combos = [];
        combos.push({ label: "all-off", pick: () => -1 });
        combos.push({ label: "all-first", pick: () => 0 });
        combos.push({
          label: "all-last",
          pick: (g) => g.branches.length - 1,
        });
        groups.forEach((group, gi) => {
          for (let b = 0; b < group.branches.length; b++) {
            // Targeted per-branch combo: force THIS branch plus every
            // ancestor branch on its path (a nested group is unreachable
            // unless its enclosing branches are chosen — review catch).
            const forced = new Map([[group, b]]);
            for (const frame of group.path) forced.set(frame.group, frame.branch);
            combos.push({
              label: `g${gi}b${b}+ancestors`,
              pick: (g) => (forced.has(g) ? forced.get(g) : -1),
            });
          }
          combos.push({
            label: `all-on-except g${gi}`,
            pick: (g) => (g === group ? -1 : 0),
          });
        });
        let allValid = true;
        let firstError = "";
        for (const combo of combos) {
          const rendered = renderTree(children, combo.pick, null, "json").trim();
          if (rendered === "") continue;
          try {
            JSON.parse(rendered);
          } catch (e) {
            allValid = false;
            if (!firstError) {
              // V8's message embeds the offending snippet (with real
              // newlines) — flatten it so the check output stays one line.
              const msg = String(e && e.message).replace(/\s+/g, " ");
              firstError = `${combo.label}: ${msg.slice(0, 260)}`;
            }
          }
        }
        ok(
          allValid,
          `island-json: ${f} island #${fileIslands} valid across ${combos.length} branch combos${firstError ? ` — ${firstError}` : ""}`,
        );
      }
    }
  }
  ok(islands >= 9, `island-json: full island inventory swept (found ${islands}, expected >= 9 — pdp 4, proof 3, cart 1, amazon 1)`);
}

// ------------------------------------------ 2a. expander SELF-TEST
//
// Vacuity guard: the matrix is only worth its 100+ green checks if it
// still FAILS on the bug classes it claims to catch. Synthetic bodies:
{
  function comboSweep(body) {
    const { children, groups } = parseBody(tokenize(body));
    const combos = [
      () => -1,
      () => 0,
      (g) => g.branches.length - 1,
    ];
    groups.forEach((group) => {
      for (let b = 0; b < group.branches.length; b++) {
        const forced = new Map([[group, b]]);
        for (const frame of group.path) forced.set(frame.group, frame.branch);
        combos.push((g) => (forced.has(g) ? forced.get(g) : -1));
      }
    });
    let invalid = 0;
    for (const pick of combos) {
      const rendered = renderTree(children, pick, null, "json").trim();
      if (rendered === "") continue;
      try { JSON.parse(rendered); } catch (e) { invalid++; }
    }
    return invalid;
  }
  ok(
    comboSweep('[{% for x in y %}{"a":1}{% endfor %}]') > 0,
    "self-test: a loop MISSING its row separator fails (two-iteration render)",
  );
  ok(
    comboSweep('[{% assign f = false %}{% for x in y %}{% unless f %},{% endunless %}{% assign f = false %}{"a":1}{% endfor %}]') > 0,
    "self-test: a polarity-FLIPPED separator flag (init false -> leading comma) fails",
  );
  ok(
    comboSweep('[{% assign f = true %}{% for x in y %}{% unless f %},{% endunless %}{% assign f = false %}{"a":1}{% endfor %}]') === 0,
    "self-test: the healthy assign-flag separator idiom stays green",
  );
  ok(
    comboSweep('{"a":1{% if z %}{% if w %},"b"{% endif %}{% endif %}}') > 0,
    "self-test: a broken branch NESTED inside another group's body is reached (ancestor forcing)",
  );
  ok(
    comboSweep('{"a": {% if z %}1{% else %}2{% endif %}}') === 0,
    "self-test: if/else value branches resolve like real Liquid (else on -1)",
  );
}

// ------------------------------ 2a2. bare-output fail-safe initialization
//
// The matrix substitutes placeholders for outputs, so it can never see the
// nil class: a BARE (non-|json) output whose variable is nil renders as
// EMPTY on real Shopify — '"live": ,' — invalid JSON, dark widget. The
// islands' defense is a hand-maintained convention: every bare output
// either carries `| default:` inline or reads a variable the file
// explicitly assigns a LITERAL fail-safe (true/false/number) before use.
// This section makes that convention a tripwire.
{
  const dirs = [path.join(EXT, "blocks"), path.join(EXT, "snippets")];
  let bareOutputs = 0;
  for (const dir of dirs) {
    for (const f of listFiles(dir, ".liquid")) {
      const src = read(path.join(dir, f));
      const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        for (const tok of tokenize(m[1])) {
          if (tagKind(tok) !== "output") continue;
          const inner = tok.replace(/^\{\{-?\s*/, "").replace(/\s*-?\}\}$/, "");
          if (/\|\s*json\s*$/.test(inner)) continue; // json filter emits null for nil — safe
          bareOutputs++;
          const root = (/^([A-Za-z_][\w.]*)/.exec(inner) || [])[1] || "";
          const rootVar = root.split(".")[0];
          const failSafe =
            // default in the output itself
            /\|\s*default:/.test(inner) ||
            // arithmetic filters coerce nil to 0 in Shopify Liquid
            /\|\s*(?:times|plus|minus|divided_by|modulo|round|ceil|floor|abs|at_least|at_most)\b/.test(inner) ||
            // forloop.* is never nil inside its loop
            rootVar === "forloop" ||
            // for-loop variables are never nil inside the loop body
            new RegExp("\\{%-?\\s*for\\s+" + rootVar + "\\s+in\\b").test(src) ||
            // the root var's assign carries a literal or | default: fail-safe
            new RegExp(
              "assign\\s+" + rootVar + "\\s*=\\s*(?:true|false|\\d|[^%]*\\|\\s*default:)",
            ).test(src);
          ok(
            failSafe,
            `bare-output: ${f} {{ ${inner.slice(0, 48)} }} needs a nil fail-safe (| default:, arithmetic coercion, or a literal/defaulted assign) — a nil bare output renders EMPTY on real Shopify and breaks the island JSON`,
          );
        }
      }
    }
  }
  ok(bareOutputs >= 5, `bare-output: inventory swept (${bareOutputs} bare outputs found)`);
}

// ------------------------------------------ 2b. inline <script> ES5 parse
//
// The Liquid-embedded inline scripts (cart-booster's session beacon,
// snippets/cx-impression.liquid's impression beacon — the very events the
// storefront-pulse dead-man arms on) live in NEITHER assets/*.js NOR the
// JSON islands. A syntax slip there silently kills the beacons while the
// widgets keep rendering — the pulse would then cry incident on a healthy
// storefront. Expand each with the same Liquid expander (outputs become
// identifier-safe placeholders: `w.__cxSeen.{{ key }}` must survive) and
// ES5-parse both the all-off and all-first branch renders.
{
  const dirs = [path.join(EXT, "blocks"), path.join(EXT, "snippets")];
  let inlineScripts = 0;
  for (const dir of dirs) {
    for (const f of listFiles(dir, ".liquid")) {
      const src = read(path.join(dir, f));
      const re = /<script(?![^>]*\btype=)[^>]*>([\s\S]*?)<\/script>/g;
      let m;
      let fileScripts = 0;
      while ((m = re.exec(src)) !== null) {
        if (/\bsrc=/.test(m[0])) continue; // external tag, no body
        if (!/\S/.test(m[1])) continue;
        inlineScripts++;
        fileScripts++;
        const { children, unsupported } = parseBody(tokenize(m[1]));
        ok(
          unsupported === null,
          `inline-es5: ${f} inline script #${fileScripts} uses only supported Liquid structures`,
        );
        for (const [label, pick] of [
          ["all-off", () => -1],
          ["all-first", () => 0],
        ]) {
          const rendered = renderTree(children, pick, null, "js");
          let parsed = false, error = "";
          try {
            acorn.parse(rendered, { ecmaVersion: 5, sourceType: "script" });
            parsed = true;
          } catch (e) {
            error = String(e && e.message).replace(/\s+/g, " ").slice(0, 160);
          }
          ok(
            parsed,
            `inline-es5: ${f} inline script #${fileScripts} (${label}) parses as ES5: ${error}`,
          );
        }
      }
    }
  }
  ok(
    inlineScripts >= 2,
    `inline-es5: inline script inventory swept (found ${inlineScripts}, expected >= 2 — the session + impression beacons)`,
  );
}

// ------------------------------------------------ 3. asset references
{
  const assetsDir = path.join(EXT, "assets");
  const have = new Set(listFiles(assetsDir, ".js").concat(listFiles(assetsDir, ".css")));
  const dirs = [path.join(EXT, "blocks"), path.join(EXT, "snippets")];
  let refs = 0;
  for (const dir of dirs) {
    for (const f of listFiles(dir, ".liquid")) {
      const src = read(path.join(dir, f));
      const re = /'([^']+\.(?:js|css))'\s*\|\s*asset_url/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        refs++;
        ok(have.has(m[1]), `asset-ref: ${f} references existing asset ${m[1]}`);
      }
    }
  }
  ok(refs >= 4, `asset-ref: asset references swept (found ${refs}, expected >= 4)`);
}

// ------------------------------------------------ 4. locale file caps
{
  const extRoot = path.join(ROOT, "extensions");
  let localeFiles = 0;
  for (const extName of fs.readdirSync(extRoot)) {
    const locDir = path.join(extRoot, extName, "locales");
    for (const f of listFiles(locDir, ".json")) {
      localeFiles++;
      const size = fs.statSync(path.join(locDir, f)).size;
      ok(
        size <= 15300,
        `locale-cap: ${extName}/locales/${f} is ${size}B — Shopify hard-rejects files over 15,360B at deploy time`,
      );
    }
  }
  ok(localeFiles >= 30, `locale-cap: locale inventory swept (${localeFiles} files)`);
}

// ------------------------------------------------ 5. emission size headroom
{
  let out = "";
  let spawned = false;
  // Vendored tsx CLI first (the run-all convention: offline/deterministic);
  // npx only as a last resort.
  const vendoredTsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const emitter = path.join(ROOT, "validation/lib/emit-default-settings.ts");
  const attempts = fs.existsSync(vendoredTsx)
    ? [[process.execPath, [vendoredTsx, emitter]], ["npx", ["tsx", emitter]]]
    : [["npx", ["tsx", emitter]]];
  for (const [cmd, args] of attempts) {
    try {
      out = execFileSync(cmd, args, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      spawned = true;
      break;
    } catch (e) {
      // try the next runner
    }
  }
  ok(spawned, "emission-size: the live settings model executed");
  if (spawned) {
    const parsed = JSON.parse(out);
    ok(parsed && typeof parsed === "object", "emission-size: emission parses as JSON");
    ok(
      out.length <= 45000,
      `emission-size: default emission is ${out.length} chars — must keep generous headroom under Shopify's 65,536-char metafield cap (merchant text, byCountry records and future waves all grow it; an over-cap blob makes every settings save fail on sync)`,
    );
  }
}

// Debug hook: `node -e "const d = require('./validation/sims/deploy-safety.cjs'); …"`
// re-uses the REAL expander on a body of your choosing (the suite's own
// checks still print, but only a direct run exits the process).
module.exports = { tokenize, parseBody, renderTree };

if (require.main === module) {
  if (failures > 0) {
    console.error(`\n${failures}/${checks} CHECKS FAILED`);
    process.exit(1);
  }
  console.log(`ALL ${checks} CHECKS PASSED (deploy-safety: ES5 assets, island JSON matrix, asset refs, locale caps, emission headroom)`);
} else if (failures > 0) {
  console.error(`(required as a module with ${failures} failing checks)`);
}
