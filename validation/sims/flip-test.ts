/**
 * Flip-test — the 31-FeatureKey flip / scope / snapshot / selective-restore
 * tripwire, executed against the REAL app/models/settings.server.ts
 * (imported directly — the prisma client is constructed but never queried).
 *
 * Per key (all 31):
 *  - FEATURE_DEFS get/set round-trip surfaces through resolveFeatureFlag;
 *  - FEATURE_RAW_FIELD arm exists and its raw field is the one the def
 *    actually flips;
 *  - market scoping: selected-scope on/off via isFeatureOnForMarket;
 *  - snapshotFlags/restoreFlags round-trips a flipped key;
 *  - applyFlipForMarket ON in one market restricts a dark feature's scope
 *    to that market; OFF in one market subtracts it from an "all" scope.
 * Plus the cross-key invariants: selective restore touches ONLY its keys,
 * any cart_* key restores the master + all four sub-flags, dormant
 * sub-flags survive snapshot/restore, older-shape snapshots never zero
 * the amazon flags, and the cart-master flip isolation rule.
 */
import {
  AMAZON_FLAG_FIELDS,
  DEFAULT_SETTINGS,
  FEATURE_DEFS,
  FEATURE_KEYS,
  FEATURE_RAW_FIELD,
  applyFlipForMarket,
  isFeatureOnForMarket,
  resolveFeatureFlag,
  restoreFlags,
  restoreFlagsSelective,
  snapshotFlags,
  type BoosterSettings,
  type FeatureKey,
} from "../../app/models/settings.server";

let checks = 0;
let failures = 0;
function ok(cond: boolean, label: string) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  }
}
const clone = <T>(x: T): T => structuredClone(x);
const MARKETS = ["ch", "eu", "us"];

// --- inventory ---------------------------------------------------------------
ok(FEATURE_KEYS.length === 31, `31 FeatureKeys (got ${FEATURE_KEYS.length})`);
ok(new Set(FEATURE_KEYS).size === FEATURE_KEYS.length, "no duplicate keys");
ok(AMAZON_FLAG_FIELDS.length === FEATURE_KEYS.filter((k) => k.startsWith("az_")).length,
  "one amazon flag field per az_* key");

function rawValue(s: BoosterSettings, key: FeatureKey): boolean {
  const raw = FEATURE_RAW_FIELD[key];
  if (raw.kind === "cart") return s.cartUpsell[raw.field];
  if (raw.kind === "section") return s[raw.field].enabled;
  return s.amazon[raw.field];
}

// --- per-key: flip, raw-field arm, scope, snapshot round-trip -------------------
for (const key of FEATURE_KEYS) {
  const s = clone(DEFAULT_SETTINGS);

  // flip round-trip through the def + combined resolution
  FEATURE_DEFS[key].set(s, true);
  ok(resolveFeatureFlag(s, key) === true, `${key}: set(true) resolves on`);
  ok(rawValue(s, key) === true, `${key}: raw field followed the def`);
  FEATURE_DEFS[key].set(s, false);
  ok(resolveFeatureFlag(s, key) === false, `${key}: set(false) resolves off`);

  // market scope: selected-mode gates per market, flag still binds
  FEATURE_DEFS[key].set(s, true);
  s.marketScopes[key] = { mode: "selected", markets: ["ch"] };
  ok(isFeatureOnForMarket(s, key, "ch") === true, `${key}: on in the selected market`);
  ok(isFeatureOnForMarket(s, key, "eu") === false, `${key}: off outside the scope`);
  FEATURE_DEFS[key].set(s, false);
  ok(isFeatureOnForMarket(s, key, "ch") === false, `${key}: scope never overrides an off flag`);

  // snapshot / full restore round-trip
  FEATURE_DEFS[key].set(s, true);
  s.marketScopes[key] = { mode: "selected", markets: ["eu"] };
  const snap = snapshotFlags(s);
  FEATURE_DEFS[key].set(s, false);
  s.marketScopes[key] = { mode: "all", markets: [] };
  restoreFlags(s, snap);
  ok(resolveFeatureFlag(s, key) === true &&
     s.marketScopes[key].mode === "selected" &&
     s.marketScopes[key].markets.join(",") === "eu",
    `${key}: snapshot/restore round-trips flag + scope`);

  // applyFlipForMarket: dark feature turned ON in one market -> scope
  // restricted to exactly that market (no dormant-market side effects).
  const dark = clone(DEFAULT_SETTINGS);
  FEATURE_DEFS[key].set(dark, false);
  applyFlipForMarket(dark, key, "ch", true, MARKETS);
  ok(resolveFeatureFlag(dark, key) === true &&
     dark.marketScopes[key].mode === "selected" &&
     dark.marketScopes[key].markets.join(",") === "ch",
    `${key}: flip-on in one market lights up ONLY that market`);
  ok(isFeatureOnForMarket(dark, key, "eu") === false,
    `${key}: other markets stay dark after the scoped flip`);

  // applyFlipForMarket: ON everywhere, then OFF in one market subtracts it.
  const lit = clone(DEFAULT_SETTINGS);
  FEATURE_DEFS[key].set(lit, true);
  lit.marketScopes[key] = { mode: "all", markets: [] };
  applyFlipForMarket(lit, key, "eu", false, MARKETS);
  ok(resolveFeatureFlag(lit, key) === true, `${key}: flag survives a single-market off flip`);
  ok(isFeatureOnForMarket(lit, key, "eu") === false &&
     isFeatureOnForMarket(lit, key, "ch") === true &&
     isFeatureOnForMarket(lit, key, "us") === true,
    `${key}: "all" scope minus the flipped market`);

  // applyFlipForMarket: OFF for market "all" kills the flag itself.
  applyFlipForMarket(lit, key, "all", false, MARKETS);
  ok(resolveFeatureFlag(lit, key) === false, `${key}: flip-off for all markets clears the flag`);
}

// --- selective restore: only its keys, never the neighbours ---------------------
{
  const s = clone(DEFAULT_SETTINGS);
  FEATURE_DEFS.trustpilot.set(s, true);
  FEATURE_DEFS.az_fbt.set(s, true);
  s.marketScopes.az_fbt = { mode: "selected", markets: ["ch"] };
  const snap = snapshotFlags(s);
  // both keys drift after the snapshot
  FEATURE_DEFS.trustpilot.set(s, false);
  FEATURE_DEFS.az_fbt.set(s, false);
  s.marketScopes.az_fbt = { mode: "all", markets: [] };
  restoreFlagsSelective(s, snap, ["az_fbt"]);
  ok(resolveFeatureFlag(s, "az_fbt") === true &&
     s.marketScopes.az_fbt.mode === "selected" &&
     s.marketScopes.az_fbt.markets.join(",") === "ch",
    "selective restore puts back the requested amazon key + scope");
  ok(resolveFeatureFlag(s, "trustpilot") === false,
    "selective restore NEVER touches a key outside the list");
}

// --- cart group: any cart_* key restores master + all four sub-flags -------------
{
  const s = clone(DEFAULT_SETTINGS);
  s.cartUpsell.enabled = true;
  s.cartUpsell.showVolumeUpsell = true;
  s.cartUpsell.showFreeShippingBar = false;
  s.cartUpsell.showSubscriptionUpsell = true;
  s.cartUpsell.showTrustRow = false;
  const snap = snapshotFlags(s);
  s.cartUpsell.enabled = false;
  s.cartUpsell.showVolumeUpsell = false;
  s.cartUpsell.showFreeShippingBar = true;
  s.cartUpsell.showSubscriptionUpsell = false;
  s.cartUpsell.showTrustRow = true;
  restoreFlagsSelective(s, snap, ["cart_volume_upsell"]);
  ok(s.cartUpsell.enabled === true &&
     s.cartUpsell.showVolumeUpsell === true &&
     s.cartUpsell.showFreeShippingBar === false &&
     s.cartUpsell.showSubscriptionUpsell === true &&
     s.cartUpsell.showTrustRow === false,
    "one cart_* key restores the shared master AND all four sub-flags (overlap group)");
}

// --- dormant sub-flag survives a snapshot/restore --------------------------------
{
  const s = clone(DEFAULT_SETTINGS);
  s.cartUpsell.enabled = false;         // master off
  s.cartUpsell.showVolumeUpsell = true; // dormant sub-flag
  const snap = snapshotFlags(s);
  s.cartUpsell.showVolumeUpsell = false;
  restoreFlags(s, snap);
  ok(s.cartUpsell.enabled === false && s.cartUpsell.showVolumeUpsell === true,
    "dormant sub-flag (master off) survives the RAW-field snapshot/restore");
  ok(resolveFeatureFlag(s, "cart_volume_upsell") === false,
    "combined state still off while the master is off");
}

// --- cart-master flip isolation ---------------------------------------------------
{
  const s = clone(DEFAULT_SETTINGS);
  s.cartUpsell.enabled = false;
  s.cartUpsell.showFreeShippingBar = true; // dormant sibling
  s.cartUpsell.showVolumeUpsell = true;    // dormant target
  applyFlipForMarket(s, "cart_volume_upsell", "all", true, MARKETS);
  ok(resolveFeatureFlag(s, "cart_volume_upsell") === true,
    "flip-on turned the cart master on for the target");
  ok(resolveFeatureFlag(s, "free_shipping_bar") === false &&
     s.cartUpsell.showFreeShippingBar === false,
    "dormant siblings forced off so the master flip is isolated to the flipped key");
}

// --- older-shape snapshots ----------------------------------------------------------
{
  const s = clone(DEFAULT_SETTINGS);
  s.amazon.fbt = true;
  const snap = snapshotFlags(s);
  const old = clone(snap) as Partial<typeof snap>;
  delete old.amazonFlags; // pre-v6.1 persisted shape
  s.amazon.fbt = true;
  restoreFlags(s, old as typeof snap);
  ok(s.amazon.fbt === true, "restoreFlags: old-shape snapshot never zeroes amazon flags");
  s.amazon.fbt = true;
  restoreFlagsSelective(s, old as typeof snap, ["az_fbt"]);
  ok(s.amazon.fbt === true, "restoreFlagsSelective: missing snapshot fields are skipped, never zeroed");
}

// --- snapshot completeness (every raw field is captured) -----------------------------
{
  const s = clone(DEFAULT_SETTINGS);
  const snap = snapshotFlags(s);
  for (const key of FEATURE_KEYS) {
    const raw = FEATURE_RAW_FIELD[key];
    const captured =
      raw.kind === "cart"
        ? typeof snap.cartSubFlags[raw.field] === "boolean"
        : raw.kind === "section"
          ? typeof snap.sectionEnabled[raw.field] === "boolean"
          : typeof snap.amazonFlags?.[raw.field] === "boolean";
    ok(captured, `snapshot captures the raw field of ${key}`);
  }
  ok(typeof snap.cartMaster === "boolean", "snapshot captures the cart master");
  ok(Object.keys(snap.marketScopes).length === FEATURE_KEYS.length,
    "snapshot captures a scope for every key");
}

if (failures > 0) {
  console.error(`\n${failures}/${checks} CHECKS FAILED`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED (31-key flip/scope/snapshot/selective-restore vs the real settings.server.ts)`);
