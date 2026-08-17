/**
 * Equivalence prover — successor of the wiped scratchpad prover, simplified
 * but honest.
 *
 * Compares the CURRENT extensions/cellexia-booster tree (blocks/, snippets/,
 * assets/*.js) against the committed baseline validation/baselines/v68 under
 * line-level normalization (CRLF->LF, trailing-whitespace strip, single
 * trailing newline — inner whitespace is significant). Any divergence must
 * be acknowledged in validation/allowlist.json with a reason and a wave tag;
 * stale allowlist entries (file no longer diverges, or file unknown) fail
 * too, so the allowlist can only describe reality.
 *
 * Also carries:
 *   - the TEMPLATE/BUILDER REGISTRY for future Liquid->JS migrations: each
 *     entry pins the JS builder anchor that replaced a Liquid template, so
 *     a migration cannot silently lose its builder. Empty today (all v6.7
 *     migrations are already IN the v68 baseline); future waves append.
 *   - the BYTE METER: per-file and total Liquid bytes vs the 102,400
 *     Shopify cap and the project's own 95,000 budget (the budget itself
 *     is ENFORCED by harness.mjs; the meter here is the visible gauge).
 *
 * On an untouched tree this suite passes trivially — by design: the
 * baseline was snapshotted from this exact tree.
 */
import fs from "node:fs";
import { rp, read, exists, normalize, listFiles, makeChecker } from "./lib/util.mjs";

const { ok, finish } = makeChecker("prover: v68 normalized equivalence + registry + byte meter");

const BASE = "validation/baselines/v68";
const LIVE = "extensions/cellexia-booster";

// The baselined surface (binding: blocks/, snippets/, assets/*.js).
const SURFACES = [
  { dir: "blocks", ext: ".liquid" },
  { dir: "snippets", ext: ".liquid" },
  { dir: "assets", ext: ".js" },
];

// ---------------------------------------------------------------- allowlist
const allowlist = JSON.parse(read("validation/allowlist.json"));
ok(Array.isArray(allowlist.entries), "allowlist.json has an entries array");
for (const e of allowlist.entries) {
  ok(
    typeof e.file === "string" && typeof e.reason === "string" && typeof e.wave === "string",
    `allowlist entry well-formed (file/reason/wave): ${JSON.stringify(e)}`,
  );
}
const allowed = new Set(allowlist.entries.map((e) => e.file));
const allowedUsed = new Set();

// ------------------------------------------------- normalized equivalence
for (const { dir, ext } of SURFACES) {
  const baseFiles = listFiles(`${BASE}/${dir}`, ext);
  const liveFiles = listFiles(`${LIVE}/${dir}`, ext);
  ok(baseFiles.length > 0, `baseline ${dir}/ is non-empty`);

  for (const f of baseFiles) {
    const liveRel = `${LIVE}/${dir}/${f}`;
    if (!exists(liveRel)) {
      if (allowed.has(liveRel)) {
        allowedUsed.add(liveRel);
        console.log(`  allowlisted deletion: ${liveRel}`);
        continue;
      }
      ok(false, `baselined file deleted without allowlist entry: ${liveRel}`);
      continue;
    }
    const same = normalize(read(`${BASE}/${dir}/${f}`)) === normalize(read(liveRel));
    if (!same && allowed.has(liveRel)) {
      allowedUsed.add(liveRel);
      console.log(`  allowlisted divergence: ${liveRel}`);
      continue;
    }
    ok(same, `normalized-equivalent to v68 baseline: ${liveRel}`);
    if (same && allowed.has(liveRel)) {
      allowedUsed.add(liveRel);
      ok(false, `STALE allowlist entry — file matches baseline again: ${liveRel}`);
    }
  }

  for (const f of liveFiles) {
    if (baseFiles.includes(f)) continue;
    const liveRel = `${LIVE}/${dir}/${f}`;
    if (allowed.has(liveRel)) {
      allowedUsed.add(liveRel);
      console.log(`  allowlisted new file: ${liveRel}`);
      continue;
    }
    ok(false, `new file not in v68 baseline and not allowlisted: ${liveRel}`);
  }
}

for (const file of allowed) {
  ok(allowedUsed.has(file), `allowlist entry is live (used this run): ${file}`);
}

// ------------------------------------------- template / builder registry
/**
 * Future Liquid->JS template migrations register here:
 *   { name, liquidGone: {file, pattern}, builder: {file, anchor}, wave }
 * - `liquidGone.pattern` must NO LONGER match in `liquidGone.file`
 *   (the template really left the Liquid), and
 * - `builder.anchor` must be present in `builder.file`
 *   (the replacement builder really exists).
 * The v6.7 migrations predate the v68 baseline and are therefore already
 * proven by plain equivalence above; the registry starts empty.
 */
const TEMPLATE_REGISTRY = [];

ok(Array.isArray(TEMPLATE_REGISTRY), "template/builder registry present");
for (const entry of TEMPLATE_REGISTRY) {
  const { name, liquidGone, builder } = entry;
  ok(
    typeof name === "string" && liquidGone && builder && typeof entry.wave === "string",
    `registry entry well-formed: ${name}`,
  );
  const liquidSrc = read(liquidGone.file);
  ok(
    !new RegExp(liquidGone.pattern).test(liquidSrc),
    `registry ${name}: migrated template no longer in ${liquidGone.file}`,
  );
  const builderSrc = read(builder.file);
  ok(
    builderSrc.includes(builder.anchor),
    `registry ${name}: builder anchor present in ${builder.file}`,
  );
}

// ---------------------------------------------------------------- byte meter
const SHOPIFY_CAP = 102_400;
const BUDGET = 95_000;
let totalLiquid = 0;
console.log("\n  byte meter (Liquid):");
for (const dir of ["blocks", "snippets"]) {
  for (const f of listFiles(`${LIVE}/${dir}`, ".liquid")) {
    const n = fs.statSync(rp(`${LIVE}/${dir}/${f}`)).size;
    totalLiquid += n;
    console.log(`    ${String(n).padStart(7)}  ${dir}/${f}`);
  }
}
console.log(
  `    ${String(totalLiquid).padStart(7)}  TOTAL  (budget ${BUDGET}, Shopify cap ${SHOPIFY_CAP}, ` +
    `headroom ${SHOPIFY_CAP - totalLiquid})\n`,
);
ok(totalLiquid > 0, "byte meter measured a non-empty Liquid surface");

finish();
