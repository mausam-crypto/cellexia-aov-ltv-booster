/**
 * tsx-shim — lets mutants.cjs re-run a TypeScript suite.
 *
 * mutants.cjs re-executes a suite with `spawnSync(process.execPath,
 * [selfPath])`, i.e. plain `node`, which cannot run .ts directly on this
 * toolchain. A .ts suite therefore passes THIS file as `selfPath` and
 * exports the real suite path via the CX_TSX_SUITE env var (spawnSync
 * forwards the parent env): the shim bridges to the vendored tsx CLI
 * (run-all's runner convention — `npx tsx` only as a last-resort
 * fallback) with stdio inherited, so the FAIL:/CHECKS FAILED lines the
 * mutation harness greps for flow straight through, and exits with the
 * suite's status. CX_SIM_SRC / CX_SKIP_MUTANTS ride the env untouched.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const suite = process.env.CX_TSX_SUITE;
if (!suite || !fs.existsSync(suite)) {
  console.error(
    "tsx-shim: CX_TSX_SUITE not set or missing (" + String(suite) + ") — " +
      "the calling suite must export its own absolute path before runMutants",
  );
  process.exit(2);
}

const TSX_CLI = path.join(__dirname, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const run = fs.existsSync(TSX_CLI)
  ? spawnSync(process.execPath, [TSX_CLI, suite], { stdio: "inherit", env: process.env })
  : spawnSync("npx", ["tsx", suite], { stdio: "inherit", env: process.env });
process.exit(run.status === null ? 1 : run.status);
