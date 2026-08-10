/**
 * run-all — single entry point for the whole validation suite.
 *
 *   node validation/run-all.mjs                (strict — the default)
 *   node validation/run-all.mjs --no-strict    (build phase: registered
 *                                               suites that have not landed
 *                                               yet count as loud SKIPs)
 *   npm run validate                           (alias of the strict run)
 *
 * Prints a per-suite scoreboard + totals; exits non-zero on any failure,
 * and — in strict mode — on any registered-but-absent suite. Strict is the
 * default so a deleted suite can never pass silently; agents rebuilding
 * the suite may pass --no-strict until every registered suite has landed.
 *
 * Suites are registered by BASENAME; the runner resolves the extension
 * (.mjs/.js/.cjs -> node, .ts/.tsx -> npx tsx), so a sim may land in
 * whichever module flavor its extraction needs. House rules: offline,
 * deterministic, total runtime under ~3 minutes.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// --strict is the default; it is still recognized explicitly so that a
// future change to the default can never silently ignore callers who
// passed it. --strict wins over --no-strict/--build-phase if both appear.
const argv = process.argv.slice(2);
const STRICT =
  argv.includes("--strict") ||
  (!argv.includes("--no-strict") && !argv.includes("--build-phase"));

/** Registered suites, in run order. dir is relative to validation/. */
const SUITES = [
  { name: "prover", dir: ".", base: "prover" },
  { name: "harness", dir: ".", base: "harness" },
  { name: "settings-derivation", dir: ".", base: "settings-derivation" },
  { name: "sims/dispatch-tz", dir: "sims", base: "dispatch-tz" },
  { name: "sims/delivery-businessdays", dir: "sims", base: "delivery-businessdays" },
  { name: "sims/us-state-delivery", dir: "sims", base: "us-state-delivery" },
  { name: "sims/checkout-delivery-engine", dir: "sims", base: "checkout-delivery-engine" },
  { name: "sims/checkout-trust", dir: "sims", base: "checkout-trust" },
  { name: "sims/geo-lookup", dir: "sims", base: "geo-lookup" },
  { name: "sims/native-dates", dir: "sims", base: "native-dates" },
  { name: "sims/plurals", dir: "sims", base: "plurals" },
  { name: "sims/translation-service", dir: "sims", base: "translation-service" },
  { name: "sims/crosssell-pipeline", dir: "sims", base: "crosssell-pipeline" },
  { name: "sims/fbt", dir: "sims", base: "fbt" },
  { name: "sims/badge-cards", dir: "sims", base: "badge-cards" },
  { name: "sims/az-split", dir: "sims", base: "az-split" },
  { name: "sims/subscribed-upgrade", dir: "sims", base: "subscribed-upgrade" },
  { name: "sims/survey-methodology", dir: "sims", base: "survey-methodology" },
  { name: "sims/proof-gallery", dir: "sims", base: "proof-gallery" },
  { name: "sims/proof-placement", dir: "sims", base: "proof-placement" },
  { name: "sims/proof-server", dir: "sims", base: "proof-server" },
  { name: "sims/proof-translation", dir: "sims", base: "proof-translation" },
  { name: "sims/threshold-snap", dir: "sims", base: "threshold-snap" },
  { name: "sims/flip-test", dir: "sims", base: "flip-test" },
];

const EXT_ORDER = [".mjs", ".js", ".cjs", ".ts", ".tsx"];

function resolveSuite(suite) {
  for (const ext of EXT_ORDER) {
    const p = path.join(HERE, suite.dir, suite.base + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// tsx is a declared devDependency so `npm ci` vendors it — prefer the
// vendored CLI entry (run with the current node, cross-platform, fully
// offline). `npx tsx` remains only as a last-resort fallback for trees
// where node_modules has not been installed.
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function runnerFor(file) {
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) {
    return { cmd: process.execPath, args: [file] };
  }
  return fs.existsSync(TSX_CLI)
    ? { cmd: process.execPath, args: [TSX_CLI, file] }
    : { cmd: "npx", args: ["tsx", file] };
}

const rows = [];
let failures = 0;
let skips = 0;
let totalChecks = 0;
const t0 = process.hrtime.bigint();

for (const suite of SUITES) {
  const file = resolveSuite(suite);
  if (!file) {
    skips += 1;
    rows.push({ name: suite.name, status: "SKIP", checks: "-", ms: 0 });
    console.log(`\n=== ${suite.name} — SKIP (not landed yet: validation/${suite.dir}/${suite.base}.*)`);
    continue;
  }
  console.log(`\n=== ${suite.name} (${path.relative(ROOT, file)})`);
  const { cmd, args } = runnerFor(file);
  const s0 = process.hrtime.bigint();
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  const ms = Number((process.hrtime.bigint() - s0) / 1_000_000n);
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  process.stdout.write(res.stdout || "");
  if (res.status !== 0) process.stderr.write(res.stderr || "");

  const m =
    out.match(/ALL[ -](\d+)[ -]CHECKS[ -]PASSED/i) || out.match(/ALL[ -](\d+)[ -]PASSED/i);
  const checks = m ? Number(m[1]) : null;
  const passed = res.status === 0 && checks !== null;
  let checksLabel = checks ?? "?";
  if (!passed) {
    failures += 1;
    if (res.status === 0) {
      console.error(
        `run-all: ${suite.name} exited 0 but never printed its ALL-N-PASSED line — treating as FAILURE (vacuity guard)`,
      );
    }
    // Failed suites print "N/M CHECKS FAILED" — surface passed/total on the
    // scoreboard instead of "?" so triage does not require scrolling back.
    const f = out.match(/(\d+)\/(\d+) CHECKS FAILED/);
    if (f) checksLabel = `${Number(f[2]) - Number(f[1])}/${f[2]}`;
  } else {
    totalChecks += checks;
  }
  rows.push({ name: suite.name, status: passed ? "PASS" : "FAIL", checks: checksLabel, ms });
}

const totalMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);

console.log("\n================ VALIDATION SCOREBOARD ================");
for (const r of rows) {
  console.log(
    `  ${r.status.padEnd(4)}  ${r.name.padEnd(32)} ${String(r.checks).padStart(6)} checks  ${String(r.ms).padStart(6)} ms`,
  );
}
console.log("  -----------------------------------------------------");
const ran = rows.filter((r) => r.status !== "SKIP").length;
console.log(
  `  suites: ${ran} ran, ${skips} skipped, ${failures} failed — ${totalChecks} checks total in ${(totalMs / 1000).toFixed(1)}s (${STRICT ? "strict" : "build-phase"} mode)`,
);

if (failures > 0) {
  console.error("\nVALIDATION FAILED");
  process.exit(1);
}
if (skips > 0 && STRICT) {
  console.error(
    `\nVALIDATION FAILED (strict): ${skips} registered suite(s) have not landed. ` +
      "During the rebuild phase run with --no-strict; once every suite has landed, strict is the only acceptable mode.",
  );
  process.exit(1);
}
if (skips > 0) {
  console.warn(`\nWARNING: ${skips} registered suite(s) SKIPPED — the suite is NOT complete yet.`);
}
console.log("\nVALIDATION GREEN");
