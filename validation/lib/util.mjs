/**
 * Shared helpers for the validation suites (prover, harness, sims).
 *
 * House rules: offline (node/npx tsx only), deterministic (no Date.now
 * anywhere in a check), everything repo-resident under validation/ —
 * NEVER in a tmp scratchpad. The previous generation of this suite lived
 * in a session scratchpad and was wiped by OS tmp cleanup; that is why
 * this directory exists inside the repo and ships in the dev ZIP.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Absolute repo root (the directory that holds app/, extensions/, validation/). */
export const ROOT = path.resolve(HERE, "..", "..");

/** Absolute path helper rooted at the repo. */
export const rp = (...parts) => path.join(ROOT, ...parts);

export function read(relPath) {
  return fs.readFileSync(rp(relPath), "utf8");
}

export function exists(relPath) {
  return fs.existsSync(rp(relPath));
}

export function bytesOf(relPath) {
  return fs.statSync(rp(relPath)).size;
}

/** Sorted list of file basenames in a repo-relative dir, filtered by extension. */
export function listFiles(relDir, ext) {
  return fs
    .readdirSync(rp(relDir))
    .filter((f) => (ext ? f.endsWith(ext) : true))
    .sort();
}

/**
 * Line-level normalization used by the equivalence prover: CRLF -> LF,
 * strip trailing whitespace per line, exactly one trailing newline.
 * Deliberately does NOT touch inner whitespace — indentation changes in
 * shipped Liquid/JS are real changes and must go through the allowlist.
 */
export function normalize(text) {
  return (
    text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/u, ""))
      .join("\n")
      .replace(/\n+$/u, "") + "\n"
  );
}

/**
 * Tiny check-counter used by every suite so run-all can trust the
 * "ALL-N-PASSED" convention. Suites must exit non-zero on any failure.
 */
export function makeChecker(suiteLabel) {
  let checks = 0;
  let failures = 0;
  function ok(cond, label) {
    checks += 1;
    if (!cond) {
      failures += 1;
      console.error(`FAIL: ${label}`);
    }
    return !!cond;
  }
  function finish() {
    if (failures > 0) {
      console.error(`\n${failures}/${checks} CHECKS FAILED (${suiteLabel})`);
      process.exit(1);
    }
    console.log(`ALL ${checks} CHECKS PASSED (${suiteLabel})`);
  }
  return { ok, finish, get checks() { return checks; }, get failures() { return failures; } };
}

/**
 * Parse the canonical FEATURE_KEYS array LIVE from
 * app/models/settings.server.ts (source of truth — never a copied list).
 * Self-checking: throws if the anchor or the expected shape is missing.
 */
export function parseFeatureKeys() {
  const src = read("app/models/settings.server.ts");
  const anchor = "export const FEATURE_KEYS: FeatureKey[] = [";
  const start = src.indexOf(anchor);
  if (start === -1) throw new Error("FEATURE_KEYS anchor not found in settings.server.ts");
  const end = src.indexOf("];", start);
  if (end === -1) throw new Error("FEATURE_KEYS array not terminated");
  const body = src.slice(start + anchor.length, end);
  const keys = [...body.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  if (keys.length === 0) throw new Error("FEATURE_KEYS parse yielded zero keys");
  if (new Set(keys).size !== keys.length) throw new Error("FEATURE_KEYS parse yielded duplicates");
  return keys;
}

/**
 * Extract quoted feature-key strings appearing between an anchor string and
 * a terminator in a source file — used to read FEATURE_GROUPS / GROUPS /
 * CONFIGURE_URL literals live from the route files.
 */
export function keysBetween(src, anchor, terminator, keyUniverse) {
  const start = src.indexOf(anchor);
  if (start === -1) throw new Error(`anchor not found: ${anchor}`);
  const end = src.indexOf(terminator, start + anchor.length);
  if (end === -1) throw new Error(`terminator not found after: ${anchor}`);
  const body = src.slice(start + anchor.length, end);
  const universe = new Set(keyUniverse);
  const found = [];
  for (const m of body.matchAll(/["']?([a-z0-9_]+)["']?\s*[:,\]]/g)) {
    if (universe.has(m[1])) found.push(m[1]);
  }
  return found;
}
