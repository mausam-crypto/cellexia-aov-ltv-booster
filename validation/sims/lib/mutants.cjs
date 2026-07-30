/**
 * Mutation-test harness shared by the safety-critical sims.
 *
 * Each mutant is a targeted single-substitution over a COPY of the real
 * shipped source (the copy lives under validation/.generated/mutants/ —
 * repo-resident, never tmp — and is deleted after the run). The suite
 * re-runs ITSELF against the mutant copy via the CX_SIM_SRC env override
 * and must exit non-zero for every mutant, proving the checks are not
 * vacuous. A find-anchor that no longer matches the real source fails
 * the suite loudly instead of skipping the mutant.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function runMutants({ selfPath, srcPath, mutants }) {
  const src = fs.readFileSync(srcPath, "utf8");
  const genDir = path.join(__dirname, "..", "..", ".generated", "mutants");
  fs.mkdirSync(genDir, { recursive: true });
  let failed = 0;
  for (const m of mutants) {
    if (!src.includes(m.find)) {
      console.error(`MUTANT ${m.name}: find-anchor no longer matches the real source`);
      failed++;
      continue;
    }
    const mutated = src.replace(m.find, m.replace);
    if (mutated === src) {
      console.error(`MUTANT ${m.name}: replacement produced identical source`);
      failed++;
      continue;
    }
    const file = path.join(genDir, `${path.basename(selfPath)}.${m.name}.js`);
    fs.writeFileSync(file, mutated);
    const r = spawnSync(process.execPath, [selfPath], {
      env: { ...process.env, CX_SIM_SRC: file, CX_SKIP_MUTANTS: "1" },
      encoding: "utf8",
      timeout: 60000,
    });
    try { fs.unlinkSync(file); } catch (e) { /* best-effort cleanup */ }
    // A caught mutant must fail SEMANTICALLY: non-zero exit AND at least one
    // "FAIL:" check line (or the N/M CHECKS FAILED trailer). A sub-run that
    // merely crashes (e.g. broken extraction) proves nothing about the
    // checks, so it is recorded as a crash, not a catch.
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    const semantic = /FAIL: /.test(out) || /\d+\/\d+ CHECKS FAILED/.test(out);
    if (r.status === 0) {
      console.error(`MUTANT NOT CAUGHT: ${m.name}`);
      failed++;
    } else if (!semantic) {
      console.error(`MUTANT ${m.name}: sub-run crashed without any FAIL: check line — not a semantic catch`);
      failed++;
    } else {
      console.log(`mutant caught: ${m.name}`);
    }
  }
  return failed;
}

module.exports = { runMutants };
