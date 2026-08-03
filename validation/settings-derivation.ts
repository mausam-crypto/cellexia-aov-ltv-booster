/**
 * Settings-derivation + 33-key flip proof (repo-resident port of the
 * surviving scratchpad proof v68-settings-derivation-proof.ts — the rest
 * of that suite was wiped by OS tmp cleanup, which is why this file lives
 * in validation/ now).
 *
 * Executes the REAL app/models/settings.server.ts (loaded live via
 * validation/lib/settings-loader.ts, prisma stubbed with a throwing proxy
 * — no mocks of the model itself) and proves:
 *   1. FEATURE_KEYS has 33 keys (v8: press + derm_endorsements),
 *      az_ships_from right after az_stock_line;
 *   2. AMAZON_FLAG_FIELDS carries shipsFrom in the FEATURE_KEYS az_* order;
 *   3. DEFAULT_SETTINGS.amazon.shipsFrom === false (safe-by-default) and
 *      defaultMarketScopes covers the new key (mode "all");
 *   4. every cfg path the v6.8 Liquid gates read resolves in the real
 *      emission object (cfg.amazon.shipsFrom, cfg.marketScopes.az_ships_from
 *      .mode/.markets, plus the untouched shared warehouse paths);
 *   5. sanitize: non-boolean shipsFrom falls back to false; a boolean
 *      survives; marketScopes.az_ships_from selected-mode round-trips;
 *   6. FEATURE_DEFS get/set round-trip + FEATURE_RAW_FIELD arm for ALL 33
 *      keys (the flip-test count tripwire, 31 -> 33 in v8);
 *   7. snapshotFlags/restoreFlags round-trips shipsFrom, and an older
 *      snapshot without amazonFlags leaves shipsFrom untouched;
 *   8. mergeSettings over a stored pre-v6.8 blob yields shipsFrom:false
 *      (back-compat: existing stores show ONLY In Stock until enabled).
 *
 * Run: npx tsx validation/settings-derivation.ts
 */
import { loadSettingsModel } from "./lib/settings-loader";

const M = await loadSettingsModel();
const {
  AMAZON_FLAG_FIELDS,
  DEFAULT_SETTINGS,
  FEATURE_DEFS,
  FEATURE_KEYS,
  FEATURE_RAW_FIELD,
  isFeatureOnForMarket,
  mergeSettings,
  resolveFeatureFlag,
  restoreFlags,
  sanitizeSettings,
  snapshotFlags,
} = M;

let checks = 0;
let failures = 0;
function ok(cond: boolean, label: string) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  }
}

const clone = <T,>(x: T): T => structuredClone(x);

// --- 1. key inventory ------------------------------------------------------
ok(FEATURE_KEYS.length === 33, `FEATURE_KEYS has 33 keys (got ${FEATURE_KEYS.length})`);
ok(FEATURE_KEYS.includes("az_ships_from"), "az_ships_from is a FeatureKey");
ok(
  FEATURE_KEYS.indexOf("az_ships_from") === FEATURE_KEYS.indexOf("az_stock_line") + 1,
  "az_ships_from sits right after az_stock_line",
);
ok(new Set(FEATURE_KEYS).size === 33, "FEATURE_KEYS has no duplicates");

// --- 2. amazon flag fields mirror the az_* order ---------------------------
const azKeys = FEATURE_KEYS.filter((k: string) => k.startsWith("az_"));
ok(azKeys.length === AMAZON_FLAG_FIELDS.length, "one amazon flag field per az_* key");
azKeys.forEach((key: string, i: number) => {
  const field = AMAZON_FLAG_FIELDS[i];
  const raw = FEATURE_RAW_FIELD[key];
  ok(
    raw.kind === "amazon" && raw.field === field,
    `AMAZON_FLAG_FIELDS[${i}]=${field} mirrors ${key}`,
  );
});
ok(AMAZON_FLAG_FIELDS.includes("shipsFrom"), "shipsFrom in AMAZON_FLAG_FIELDS");

// --- 3. safe defaults ------------------------------------------------------
ok(DEFAULT_SETTINGS.amazon.shipsFrom === false, "amazon.shipsFrom defaults OFF");
ok(
  DEFAULT_SETTINGS.marketScopes.az_ships_from?.mode === "all",
  "default market scope for az_ships_from is all-markets",
);

// --- 4. every cfg path the v6.8 Liquid gates read resolves ------------------
// The gates in amazon-booster.liquid read (v6.8 additions):
//   cfg.amazon.shipsFrom == true
//   cfg.marketScopes.az_ships_from.mode / .markets
// and the ships member re-uses the untouched shared paths:
//   cfg.amazon.shipsFromByCountry[ISO2] / cfg.amazon.defaultWarehouse
//   cfg.amazon.shipsFromDefault (microcopy member only)
const emission = clone(DEFAULT_SETTINGS) as Record<string, any>;
function resolves(path: string): boolean {
  let node: any = emission;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object" || !(part in node)) return false;
    node = node[part];
  }
  return true;
}
for (const path of [
  "amazon.shipsFrom",
  "amazon.stockLine",
  "amazon.shipsFromByCountry",
  "amazon.defaultWarehouse",
  "amazon.shipsFromDefault",
  // v6.10: the ships member's lean format code source
  "amazon.shipsFromFormat",
  "marketScopes.az_ships_from.mode",
  "marketScopes.az_ships_from.markets",
  "marketScopes.az_stock_line.mode",
]) {
  ok(resolves(path), `cfg path resolves in the real emission: ${path}`);
}

// --- 5. sanitize -----------------------------------------------------------
{
  const dirty = clone(DEFAULT_SETTINGS) as any;
  dirty.amazon.shipsFrom = "yes"; // non-boolean
  const cleaned = sanitizeSettings(dirty, DEFAULT_SETTINGS);
  ok(cleaned.amazon.shipsFrom === false, "sanitize: non-boolean shipsFrom -> false");
}
{
  const on = clone(DEFAULT_SETTINGS);
  on.amazon.shipsFrom = true;
  const cleaned = sanitizeSettings(on, DEFAULT_SETTINGS);
  ok(cleaned.amazon.shipsFrom === true, "sanitize: boolean shipsFrom survives");
}
// v6.10: the ships-from display format is a closed enum, sanitized to the
// subtle default (the pre-v6.10 look) on anything out of range.
{
  ok(
    Array.isArray(M.SHIPS_FROM_FORMATS) &&
      M.SHIPS_FROM_FORMATS.join(",") === "subtle,prominent",
    "SHIPS_FROM_FORMATS is the closed subtle/prominent enum",
  );
  ok(
    DEFAULT_SETTINGS.amazon.shipsFromFormat === "subtle",
    "amazon.shipsFromFormat defaults to subtle",
  );
  const dirty = clone(DEFAULT_SETTINGS) as any;
  dirty.amazon.shipsFromFormat = "loud"; // out of enum
  ok(
    sanitizeSettings(dirty, DEFAULT_SETTINGS).amazon.shipsFromFormat ===
      "subtle",
    "sanitize: out-of-enum shipsFromFormat -> subtle",
  );
  const nonString = clone(DEFAULT_SETTINGS) as any;
  nonString.amazon.shipsFromFormat = 7;
  ok(
    sanitizeSettings(nonString, DEFAULT_SETTINGS).amazon.shipsFromFormat ===
      "subtle",
    "sanitize: non-string shipsFromFormat -> subtle",
  );
  const prominent = clone(DEFAULT_SETTINGS);
  prominent.amazon.shipsFromFormat = "prominent";
  ok(
    sanitizeSettings(prominent, DEFAULT_SETTINGS).amazon.shipsFromFormat ===
      "prominent",
    "sanitize: prominent survives",
  );
  // Back-compat: a stored pre-v6.10 blob (no shipsFromFormat) merges to
  // the subtle default — existing stores keep today's look untouched.
  const stored = clone(DEFAULT_SETTINGS) as any;
  delete stored.amazon.shipsFromFormat;
  ok(
    mergeSettings(clone(DEFAULT_SETTINGS), stored).amazon.shipsFromFormat ===
      "subtle",
    "pre-v6.10 store merges to the subtle default",
  );
}
{
  const scoped = clone(DEFAULT_SETTINGS);
  scoped.marketScopes.az_ships_from = { mode: "selected", markets: ["switzerland"] };
  const cleaned = sanitizeSettings(scoped, DEFAULT_SETTINGS);
  ok(
    cleaned.marketScopes.az_ships_from.mode === "selected" &&
      cleaned.marketScopes.az_ships_from.markets.length === 1 &&
      cleaned.marketScopes.az_ships_from.markets[0] === "switzerland",
    "sanitize: az_ships_from selected-market scope round-trips",
  );
  // Per-market resolution — the merchant's example: on globally, shown
  // only in selected markets.
  cleaned.amazon.shipsFrom = true;
  ok(
    isFeatureOnForMarket(cleaned, "az_ships_from", "switzerland") === true,
    "isFeatureOnForMarket: on in the selected market",
  );
  ok(
    isFeatureOnForMarket(cleaned, "az_ships_from", "germany") === false,
    "isFeatureOnForMarket: off outside the selected market",
  );
  ok(
    isFeatureOnForMarket(cleaned, "az_stock_line", "germany") === false &&
      (cleaned.amazon.stockLine = true) &&
      isFeatureOnForMarket(cleaned, "az_stock_line", "germany") === true,
    "az_stock_line scope resolves independently of az_ships_from",
  );
}

// --- 6. the 33-key flip round-trip (rebuilt flip-test tripwire) -------------
for (const key of FEATURE_KEYS) {
  const s = clone(DEFAULT_SETTINGS);
  FEATURE_DEFS[key].set(s, true);
  const on = resolveFeatureFlag(s, key);
  FEATURE_DEFS[key].set(s, false);
  const off = resolveFeatureFlag(s, key);
  ok(on === true && off === false, `flip round-trip: ${key}`);
  ok(FEATURE_RAW_FIELD[key] !== undefined, `FEATURE_RAW_FIELD arm exists: ${key}`);
}
{
  // The raw-field arm actually points at the flag the def flips.
  const s = clone(DEFAULT_SETTINGS);
  FEATURE_DEFS.az_ships_from.set(s, true);
  ok(s.amazon.shipsFrom === true, "az_ships_from def writes amazon.shipsFrom");
  const raw = FEATURE_RAW_FIELD.az_ships_from;
  ok(
    raw.kind === "amazon" && raw.field === "shipsFrom",
    "FEATURE_RAW_FIELD.az_ships_from = {amazon, shipsFrom}",
  );
}

// --- 7. snapshot / restore --------------------------------------------------
{
  const s = clone(DEFAULT_SETTINGS);
  s.amazon.shipsFrom = true;
  const snap = snapshotFlags(s);
  ok(snap.amazonFlags?.shipsFrom === true, "snapshotFlags captures shipsFrom");
  s.amazon.shipsFrom = false;
  restoreFlags(s, snap);
  ok(s.amazon.shipsFrom === true, "restoreFlags puts shipsFrom back");
  // Older snapshot (pre-v6.1 shape): leaves the current value untouched.
  const old = clone(snap);
  delete (old as any).amazonFlags;
  s.amazon.shipsFrom = true;
  restoreFlags(s, old);
  ok(s.amazon.shipsFrom === true, "old-shape snapshot never zeroes shipsFrom");
}

// --- 8. back-compat merge over a stored pre-v6.8 blob -----------------------
{
  const stored = clone(DEFAULT_SETTINGS) as any;
  delete stored.amazon.shipsFrom; // what a pre-v6.8 DB row looks like
  stored.amazon.stockLine = true; // combined feature was ON
  const merged = mergeSettings(clone(DEFAULT_SETTINGS), stored);
  ok(
    merged.amazon.stockLine === true && merged.amazon.shipsFrom === false,
    "pre-v6.8 store with the combined feature on: In Stock stays on, Ships-from arrives OFF",
  );
}

if (failures > 0) {
  console.error(`\n${failures}/${checks} CHECKS FAILED`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED (settings derivation + 33-key flip proof)`);
