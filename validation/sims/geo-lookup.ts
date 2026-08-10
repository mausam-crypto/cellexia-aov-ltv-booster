#!/usr/bin/env node --experimental-strip-types
/**
 * validation/sims/geo-lookup.ts — v10 server geo half
 * (docs/SPEC-v10-us-state-delivery.md §6): behavioral coverage of the REAL
 * app/services/geo.server.ts, loaded via the settings-loader
 * anchor-replacement pattern — the single prisma import is swapped for an
 * in-memory GeoStateDb row store (exported as __geoRows so scenarios can
 * seed/inspect rows), global fetch is stubbed to serve a gzipped synthetic
 * CSV fixture, and NOTHING else is forked: build, pack, lookup and status
 * all run the shipped code.
 *
 * Coverage:
 *  - FORMAT PINS — US_STATE_CODES exact content AND order (51, sorted; the
 *    stateIdx bytes in the stored blobs index this array — it IS the
 *    on-disk format, and a reorder misattributes every stored range);
 *    US_STATE_NAME_TO_CODE covers the 51 storefront US_STATE_NAMES entries
 *    (cross-extracted from cellexia-pdp.js) + the DC feed variants.
 *  - BUILD — buildGeoStateDb streams the gzipped fixture through the REAL
 *    fetch→gunzip→readline→pack pipeline: US filter, unknown-name skip
 *    (territories), RFC-4180 quoted "Washington, D.C.", adjacent
 *    same-state merge (range counts pinned), v4+v6 tables, and the
 *    out-of-order fallback (repackSorted) on a deliberately shuffled
 *    fixture.
 *  - LOOKUP — lookupUsState boundary matrix: first/last IP of a range,
 *    one-off-each-end misses, ::ffff: v4-mapped text onto the v4 table,
 *    v6 boundaries, garbage/empty/malformed input -> null (fail open).
 *  - STATUS / HEAL (v10 fix C4+C5) — a row persisted as "building" with NO
 *    live build reports the healed error status (exact interrupted string,
 *    progress null), the lazy heal converges the stored row without
 *    touching builtAt/blobs, buildGeoStateDb is WILLING to restart over an
 *    orphaned row, and serve-last-good: a row on status "error" with valid
 *    blobs still answers lookups.
 *  - PROXY PIN — proxy.geo.tsx takes the FIRST x-forwarded-for entry (the
 *    buyer IP; hosts append hops) — source anchor on the split.
 *
 * MUTATION TESTS (in-memory mutated copies of geo.server.ts through the
 * same loader, silenced tap — both must be caught semantically):
 *  G1 binary-search upper-boundary break (end compare > becomes >=):
 *     the last IP of every range stops resolving
 *  G2 stateIdx off-by-one in the code-table read: every hit returns the
 *     NEXT state's code
 *
 * Offline, deterministic (the fetch stub never touches the network; the
 * only Date use feeds the source-tag URL, which is never asserted on).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { readSource, extractVar } from "../lib/extract.mjs";

// Local tap in the mutation-compatible output format ("FAIL: " lines + the
// live-counted ALL-N trailer; mutant sub-runs reuse it silenced — the
// catching check lives on the parent).
function makeGeoTap(name: string) {
  const state = { run: 0, failed: 0, silent: false };
  return {
    check(label: string, cond: boolean, detail?: unknown) {
      state.run += 1;
      if (!cond) {
        state.failed += 1;
        if (!state.silent) {
          console.error(
            "FAIL: " + label + (detail !== undefined ? " :: " + String(detail) : ""),
          );
        }
      }
    },
    eq(label: string, actual: unknown, expected: unknown) {
      this.check(
        label,
        Object.is(actual, expected) ||
          JSON.stringify(actual) === JSON.stringify(expected),
        "actual=" + JSON.stringify(actual) + " expected=" + JSON.stringify(expected),
      );
    },
    beginSilent() { state.silent = true; },
    get run() { return state.run; },
    get failed() { return state.failed; },
    finish() {
      if (state.run === 0) {
        console.error(name + ": VACUOUS — zero checks executed");
        process.exit(1);
      }
      if (state.failed > 0) {
        console.error("\n" + state.failed + "/" + state.run + " CHECKS FAILED (" + name + ")");
        process.exit(1);
      }
      console.log("ALL " + state.run + " CHECKS PASSED (" + name + ")");
    },
  };
}

const tap = makeGeoTap("geo-lookup");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

// ------------------------------------------ module loader (prisma stubbed)
const PRISMA_IMPORT = 'import prisma from "../db.server";';
const PRISMA_STUB = [
  '// validation stub — the real import is `import prisma from "../db.server";`',
  "// In-memory GeoStateDb row store, exported so the sim can seed/inspect",
  "// rows; only the operations geo.server.ts performs are implemented.",
  "export const __geoRows = new Map<string, any>();",
  "function __geoDefaults(shop: string) {",
  '  return { shop, status: "empty", source: "", error: "", rangesV4: 0,',
  "    rangesV6: 0, dataV4: null, dataV6: null, builtAt: null };",
  "}",
  "const prisma: any = {",
  "  geoStateDb: {",
  "    async findUnique({ where }: any) {",
  "      const row = __geoRows.get(where.shop);",
  "      return row ? { ...row } : null;",
  "    },",
  "    async upsert({ where, update, create }: any) {",
  "      const row = __geoRows.get(where.shop);",
  "      if (row) Object.assign(row, update);",
  "      else __geoRows.set(where.shop, Object.assign(__geoDefaults(where.shop), create));",
  "      return { ...__geoRows.get(where.shop) };",
  "    },",
  "    async update({ where, data }: any) {",
  "      const row = __geoRows.get(where.shop);",
  '      if (!row) throw new Error("update: no GeoStateDb row for " + where.shop);',
  "      Object.assign(row, data);",
  "      return { ...row };",
  "    },",
  "  },",
  "};",
].join("\n");

interface GeoMutation { slug: string; find: string; replace: string }

/** Loads app/services/geo.server.ts with the prisma anchor replaced (and an
 *  optional mutation applied) via a .gen copy — separate basenames per
 *  variant so the ESM cache never serves a mutant as the real module. */
async function loadGeoModule(mutation?: GeoMutation): Promise<any> {
  const srcPath = path.join(ROOT, "app", "services", "geo.server.ts");
  let src = fs.readFileSync(srcPath, "utf8");
  if (!src.includes(PRISMA_IMPORT)) {
    throw new Error(
      "geo-lookup: prisma import anchor not found in geo.server.ts — update PRISMA_IMPORT",
    );
  }
  src = src.replace(PRISMA_IMPORT, PRISMA_STUB);
  if (mutation) src = src.split(mutation.find).join(mutation.replace);
  const genDir = path.join(ROOT, "validation", "lib", ".gen");
  fs.mkdirSync(genDir, { recursive: true });
  const outPath = path.join(
    genDir,
    mutation ? `geo.server.mutant-${mutation.slug}.ts` : "geo.server.real.ts",
  );
  if (!fs.existsSync(outPath) || fs.readFileSync(outPath, "utf8") !== src) {
    fs.writeFileSync(outPath, src);
  }
  return await import(pathToFileURL(outPath).href);
}

// -------------------------------------------------- fetch stub + fixtures
/** Points global fetch at a gzipped copy of `csv`; returns the call log. */
function stubFetch(csv: string): string[] {
  const gz = gzipSync(Buffer.from(csv, "utf8"));
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: unknown) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      body: Readable.toWeb(Readable.from([gz])),
    };
  };
  return calls;
}

// Columns: ip_start, ip_end, continent, country, stateprov, city. Rows 1+2
// are adjacent same-state (the inline merge unions them); the quoted
// "Washington, D.C." row exercises the RFC-4180 parse + a DC name variant;
// the Puerto Rico row is a real US row with an unmapped region name
// (territories dropped by design); the FR row must be filtered out.
const CSV_MAIN = [
  "1.0.0.0,1.0.0.255,NA,US,California,Los Angeles",
  "1.0.1.0,1.0.1.255,NA,US,California,San Diego",
  "2.0.0.0,2.0.0.255,NA,US,New York,New York City",
  "3.0.0.0,3.0.0.10,NA,US,Texas,Austin",
  '4.0.0.0,4.0.0.255,NA,US,"Washington, D.C.",Washington',
  "8.0.0.0,8.0.0.255,NA,US,Puerto Rico,San Juan",
  "9.0.0.0,9.0.0.255,EU,FR,Ile-de-France,Paris",
  "2001:db8::,2001:db8::ffff,NA,US,California,San Francisco",
  "2001:db9::,2001:db9::ffff,NA,US,New York,Buffalo",
].join("\n");

// Deliberately OUT of order: packerAppend counts the violation and
// packerFinish must fall back to repackSorted (sort + re-merge — the two
// adjacent Ohio 3.0.x rows union; the 5.x row stays separate).
const CSV_SHUFFLED = [
  "5.0.0.0,5.0.0.255,NA,US,Ohio,Columbus",
  "1.0.0.0,1.0.0.255,NA,US,California,Los Angeles",
  "3.0.0.0,3.0.0.255,NA,US,Ohio,Cleveland",
  "3.0.1.0,3.0.1.255,NA,US,Ohio,Toledo",
].join("\n");

// ------------------------------------------------- boundary lookup matrix
const MAIN_LOOKUPS: Array<[string, string | null, string]> = [
  ["1.0.0.0", "CA", "first IP of the merged CA range"],
  ["1.0.1.255", "CA", "last IP of the merged CA range (adjacent-merge union)"],
  ["0.255.255.255", null, "one below the CA range start"],
  ["1.0.2.0", null, "one past the CA range end"],
  ["2.0.0.0", "NY", "first IP of the NY range"],
  ["2.0.0.255", "NY", "last IP of the NY range"],
  ["1.255.255.255", null, "one below the NY range start"],
  ["2.0.1.0", null, "one past the NY range end"],
  ["3.0.0.10", "TX", "last IP of the narrow TX range"],
  ["3.0.0.11", null, "one past the TX range end"],
  ["4.0.0.128", "DC", 'inside the quoted "Washington, D.C." row'],
  ["8.0.0.5", null, "territory row dropped (unmapped name)"],
  ["9.0.0.5", null, "non-US row filtered"],
  ["::ffff:1.0.0.5", "CA", "v4-mapped v6 text resolves on the v4 table"],
  ["::FFFF:1.0.1.255", "CA", "v4-mapped uppercase + range-end boundary"],
  ["2001:db8::", "CA", "first IP of the v6 CA range"],
  ["2001:db8::ffff", "CA", "last IP of the v6 CA range"],
  ["2001:db8::1:0", null, "one past the v6 CA range end"],
  ["2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", null, "one below the v6 CA range start"],
  ["2001:db9::5", "NY", "inside the v6 NY range"],
  ["not-an-ip", null, "garbage text"],
  ["999.1.1.1", null, "octet out of range"],
  ["1.0.0", null, "truncated dotted quad"],
  ["", null, "empty string"],
  ["::gggg", null, "invalid hex group"],
];

async function runLookupChecks(
  t: ReturnType<typeof makeGeoTap>,
  M: any,
  shop: string,
) {
  for (const [ip, expected, why] of MAIN_LOOKUPS) {
    t.eq(`lookup: ${JSON.stringify(ip)} -> ${JSON.stringify(expected)} (${why})`,
      await M.lookupUsState(shop, ip), expected);
  }
}

/** Lets getGeoStatus's fire-and-forget heal write settle (it is a plain
 *  async IIFE over the in-memory stub — one macrotask is plenty). */
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------- format pins
const G = await loadGeoModule();
{
  // The stored blobs' stateIdx bytes index THIS array in THIS order — the
  // exact literal is the format pin (geo.server.ts says "never reorder").
  const EXPECTED_CODES = [
    "AK", "AL", "AR", "AZ", "CA", "CO", "CT", "DC", "DE", "FL",
    "GA", "HI", "IA", "ID", "IL", "IN", "KS", "KY", "LA", "MA",
    "MD", "ME", "MI", "MN", "MO", "MS", "MT", "NC", "ND", "NE",
    "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR", "PA", "RI",
    "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV",
    "WY",
  ];
  tap.eq("US_STATE_CODES: 51 entries", G.US_STATE_CODES.length, 51);
  tap.eq("US_STATE_CODES: exact content AND order (the on-disk format)",
    G.US_STATE_CODES, EXPECTED_CODES);
  tap.check("US_STATE_CODES: sorted ascending",
    JSON.stringify([...G.US_STATE_CODES].sort()) === JSON.stringify([...G.US_STATE_CODES]));

  // The importer map must reach every code and agree with the storefront
  // US_STATE_NAMES twins (extracted from the shipped pdp asset) name-for-
  // name, plus the DC feed variants.
  const codesCovered = new Set(Object.values(G.US_STATE_NAME_TO_CODE));
  tap.check("US_STATE_NAME_TO_CODE: every state code reachable",
    EXPECTED_CODES.every((code) => codesCovered.has(code)));
  const namesSrc = extractVar(
    readSource("extensions/cellexia-booster/assets/cellexia-pdp.js"),
    "US_STATE_NAMES",
  );
  // eslint-disable-next-line no-new-func
  const usStateNames: Record<string, string> =
    new Function(namesSrc + " return US_STATE_NAMES;")();
  for (const [code, name] of Object.entries(usStateNames)) {
    tap.eq(`US_STATE_NAME_TO_CODE: ${JSON.stringify(name)} -> ${code} (storefront parity)`,
      G.US_STATE_NAME_TO_CODE[name], code);
  }
  for (const variant of ["Washington, D.C.", "Washington D.C.", "Washington DC"]) {
    tap.eq(`US_STATE_NAME_TO_CODE: DC variant ${JSON.stringify(variant)}`,
      G.US_STATE_NAME_TO_CODE[variant], "DC");
  }
}

// ------------------------------------------------------- proxy source pin
{
  const src = readSource("app/routes/proxy.geo.tsx");
  tap.check("proxy.geo reads the x-forwarded-for header",
    src.includes('request.headers.get("x-forwarded-for")'));
  tap.check("proxy.geo takes the FIRST XFF entry (buyer IP; hosts append hops)",
    src.includes('forwarded.split(",")[0].trim()'));
}

// -------------------------------------------------- build + lookup matrix
const SHOP = "sim-shop-main";
{
  const calls = stubFetch(CSV_MAIN);
  await G.buildGeoStateDb(SHOP);
  tap.eq("build: exactly one source download", calls.length, 1);
  tap.check("build: DB-IP monthly URL shape",
    /^https:\/\/download\.db-ip\.com\/free\/dbip-city-lite-\d{4}-\d{2}\.csv\.gz$/.test(calls[0] ?? ""),
    calls[0]);
  const status = await G.getGeoStatus(SHOP);
  tap.eq("build: status ready", status.status, "ready");
  tap.check("build: source tag recorded",
    /^dbip-city-lite-\d{4}-\d{2}$/.test(status.source), status.source);
  tap.eq("build: v4 range count (adjacent same-state rows merged)",
    status.rangesV4, 4);
  tap.eq("build: v6 range count", status.rangesV6, 2);
  tap.check("build: builtAt set, no live progress",
    status.builtAt instanceof Date && status.progress === null);
  await runLookupChecks(tap, G, SHOP);
}

// -------------------------------- out-of-order source -> repackSorted path
{
  const shop = "sim-shop-shuffled";
  stubFetch(CSV_SHUFFLED);
  await G.buildGeoStateDb(shop);
  const status = await G.getGeoStatus(shop);
  tap.eq("repack: status ready on an out-of-order source", status.status, "ready");
  tap.eq("repack: sorted + re-merged range count (3.0.x union, 5.x apart)",
    status.rangesV4, 3);
  for (const [ip, expected] of [
    ["1.0.0.100", "CA"],
    ["3.0.0.1", "OH"],
    ["3.0.1.255", "OH"],
    ["3.0.2.0", null],
    ["5.0.0.5", "OH"],
    ["2.0.0.1", null],
    ["2001:db8::1", null],
  ] as Array<[string, string | null]>) {
    tap.eq(`repack: lookup ${ip} -> ${JSON.stringify(expected)}`,
      await G.lookupUsState(shop, ip), expected);
  }
}

// ------------------------- status heal (C4/C5) + serve-last-good doctrine
{
  const GEO_BUILD_INTERRUPTED = "build interrupted — run Download & build again";
  tap.eq("status: unknown shop reports empty",
    (await G.getGeoStatus("sim-shop-nowhere")).status, "empty");

  // Failed refresh: status error, blobs kept -> lookups keep answering.
  const row = G.__geoRows.get(SHOP);
  tap.check("scenario precondition: main row exists", !!row);
  row.status = "error";
  row.error = "source download failed (HTTP 503)";
  tap.eq("serve-last-good: status error still answers lookups",
    await G.lookupUsState(SHOP, "1.0.0.5"), "CA");
  const errStatus = await G.getGeoStatus(SHOP);
  tap.check("serve-last-good: the error status itself is reported honestly",
    errStatus.status === "error" && errStatus.error.includes("HTTP 503"));

  // Orphaned "building" row (process died mid-build): no live build in
  // this process, so the status heals to the interrupted error — and the
  // heal touches status/error ONLY (builtAt + blobs keep serving).
  const builtAtBefore = row.builtAt;
  row.status = "building";
  row.error = "";
  const healed = await G.getGeoStatus(SHOP);
  tap.eq("heal: orphaned building row reports error", healed.status, "error");
  tap.eq("heal: the exact interrupted message", healed.error, GEO_BUILD_INTERRUPTED);
  tap.eq("heal: no live progress on an orphaned row", healed.progress, null);
  await drain();
  tap.check("heal: the stored row converged (lazy fire-and-forget write)",
    row.status === "error" && row.error === GEO_BUILD_INTERRUPTED,
    JSON.stringify({ status: row.status, error: row.error }));
  tap.check("heal: builtAt and blobs untouched",
    row.builtAt === builtAtBefore && row.dataV4 != null);
  tap.eq("heal: lookups keep serving through the orphan",
    await G.lookupUsState(SHOP, "2.0.0.5"), "NY");

  // The restart path: buildGeoStateDb gates only on the in-memory map, so
  // it must be WILLING to start over the (still-orphaned-looking) row.
  row.status = "building"; // re-orphan without a status read first
  const calls = stubFetch(CSV_MAIN);
  await G.buildGeoStateDb(SHOP);
  tap.eq("restart: an orphaned building row never blocks a fresh build",
    calls.length, 1);
  tap.eq("restart: the fresh build lands ready",
    (await G.getGeoStatus(SHOP)).status, "ready");
  tap.eq("restart: lookups answer from the fresh table",
    await G.lookupUsState(SHOP, "1.0.1.255"), "CA");
}

// ------------------------------------------------------------- mutants
const GEO_MUTANTS: GeoMutation[] = [
  {
    slug: "search-boundary",
    // Binary-search upper-boundary break: the record-end compare admits
    // equality, so the LAST IP of every range stops resolving.
    find: "else if (cmpBytes(addr, 0, data, off + addrLen, addrLen) > 0) {",
    replace: "else if (cmpBytes(addr, 0, data, off + addrLen, addrLen) >= 0) {",
  },
  {
    slug: "stateidx-off-by-one",
    // Unpack off-by-one: every hit returns the NEXT code in the table.
    find: "return US_STATE_CODES[stateIdx] ?? null;",
    replace: "return US_STATE_CODES[stateIdx + 1] ?? null;",
  },
];

const realSrc = fs.readFileSync(
  path.join(ROOT, "app", "services", "geo.server.ts"),
  "utf8",
);
for (const mutation of GEO_MUTANTS) {
  tap.check(`mutant anchor present: ${mutation.slug}`,
    realSrc.includes(mutation.find), mutation.find);
  if (!realSrc.includes(mutation.find)) continue;
  const M = await loadGeoModule(mutation);
  stubFetch(CSV_MAIN);
  await M.buildGeoStateDb("sim-shop-mutant");
  const silent = makeGeoTap("mutant:" + mutation.slug);
  silent.beginSilent();
  let crashed: unknown = null;
  try {
    await runLookupChecks(silent, M, "sim-shop-mutant");
  } catch (error) {
    crashed = error;
  }
  tap.check(`mutant run completes without crashing: ${mutation.slug}`,
    crashed === null, crashed instanceof Error ? crashed.message : crashed);
  if (crashed) continue;
  tap.check(`mutant CAUGHT: ${mutation.slug}`, silent.failed > 0,
    `mutant survived ${silent.run} checks`);
}

tap.finish();
