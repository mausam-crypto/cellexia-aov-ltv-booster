/**
 * Settings-derivation + 35-key flip proof (repo-resident port of the
 * surviving scratchpad proof v68-settings-derivation-proof.ts — the rest
 * of that suite was wiped by OS tmp cleanup, which is why this file lives
 * in validation/ now).
 *
 * Executes the REAL app/models/settings.server.ts (loaded live via
 * validation/lib/settings-loader.ts, prisma stubbed with a throwing proxy
 * — no mocks of the model itself) and proves:
 *   1. FEATURE_KEYS has 35 keys (v9: checkout_customs + checkout_tracked),
 *      az_ships_from right after az_stock_line;
 *   2. AMAZON_FLAG_FIELDS carries shipsFrom in the FEATURE_KEYS az_* order;
 *   3. DEFAULT_SETTINGS.amazon.shipsFrom === false (safe-by-default) and
 *      defaultMarketScopes covers the new key (mode "all");
 *   4. every cfg path the v6.8 Liquid gates read resolves in the real
 *      emission object (cfg.amazon.shipsFrom, cfg.marketScopes.az_ships_from
 *      .mode/.markets, plus the untouched shared warehouse paths);
 *   5. sanitize: non-boolean shipsFrom falls back to false; a boolean
 *      survives; marketScopes.az_ships_from selected-mode round-trips;
 *   6. FEATURE_DEFS get/set round-trip + FEATURE_RAW_FIELD arm for ALL 35
 *      keys (the flip-test count tripwire, 31 -> 33 in v8, 33 -> 35 in v9);
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
  sanitizeExcludedByMarket,
  snapshotFlags,
  validateExcludedByMarketPatch,
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
ok(FEATURE_KEYS.length === 35, `FEATURE_KEYS has 35 keys (got ${FEATURE_KEYS.length})`);
ok(FEATURE_KEYS.includes("az_ships_from"), "az_ships_from is a FeatureKey");
ok(
  FEATURE_KEYS.indexOf("az_ships_from") === FEATURE_KEYS.indexOf("az_stock_line") + 1,
  "az_ships_from sits right after az_stock_line",
);
ok(new Set(FEATURE_KEYS).size === 35, "FEATURE_KEYS has no duplicates");
// v9 trust-module V2 rows sit right after the module key, mirroring the
// checkout block's order in the union.
ok(
  FEATURE_KEYS.indexOf("checkout_customs") ===
    FEATURE_KEYS.indexOf("checkout_trust") + 1 &&
    FEATURE_KEYS.indexOf("checkout_tracked") ===
      FEATURE_KEYS.indexOf("checkout_customs") + 1,
  "checkout_customs / checkout_tracked sit right after checkout_trust",
);

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
  // v9: the checkout-trust V2 gates read these from the shop metafield
  // (full-settings spread — same emission object).
  "checkoutTrust.showCustoms",
  "checkoutTrust.showTracked",
  // v11: the trust extension's ordered render reads this path.
  "checkoutTrust.rowOrder",
  "marketScopes.checkout_customs.mode",
  "marketScopes.checkout_customs.markets",
  "marketScopes.checkout_tracked.mode",
]) {
  ok(resolves(path), `cfg path resolves in the real emission: ${path}`);
}

// --- 4b. v9 checkout-trust V2 row flags -------------------------------------
{
  ok(
    DEFAULT_SETTINGS.checkoutTrust.showCustoms === false &&
      DEFAULT_SETTINGS.checkoutTrust.showTracked === false,
    "v9 rows default OFF (a pre-V2 store upgrades with zero new checkout content)",
  );
  // Back-compat: a stored pre-v9 blob (no row keys) merges to the off
  // defaults — existing stores keep today's module untouched.
  const stored = clone(DEFAULT_SETTINGS) as any;
  stored.checkoutTrust.enabled = true;
  delete stored.checkoutTrust.showCustoms;
  delete stored.checkoutTrust.showTracked;
  const merged = mergeSettings(clone(DEFAULT_SETTINGS), stored);
  ok(
    merged.checkoutTrust.showCustoms === false &&
      merged.checkoutTrust.showTracked === false &&
      merged.checkoutTrust.enabled === true,
    "pre-v9 store merges to rows-off with the master preserved",
  );
  // Non-boolean garbage coerces back to the defaults through the merge
  // typeof guard (the checkoutTrust BOOLEAN flags have no bespoke sanitize
  // block — v11 added one for rowOrder only, see 4c).
  const dirty = clone(DEFAULT_SETTINGS) as any;
  dirty.checkoutTrust.showCustoms = "yes";
  dirty.checkoutTrust.showTracked = 1;
  const cleaned = mergeSettings(clone(DEFAULT_SETTINGS), dirty);
  ok(
    cleaned.checkoutTrust.showCustoms === false &&
      cleaned.checkoutTrust.showTracked === false,
    "non-boolean v9 row flags coerce to the off defaults",
  );
}

// --- 4c. v11 checkout-trust rowOrder ----------------------------------------
{
  const { CHECKOUT_TRUST_ROWS, normalizeTrustRowOrder } = M;
  const DEFAULT_ORDER = [
    "badges",
    "guarantee",
    "customs",
    "tracked",
    "clinical",
    "trustpilot",
  ];
  ok(
    JSON.stringify([...CHECKOUT_TRUST_ROWS]) === JSON.stringify(DEFAULT_ORDER),
    "CHECKOUT_TRUST_ROWS is the six-key pre-v11 render order",
  );
  ok(
    JSON.stringify(DEFAULT_SETTINGS.checkoutTrust.rowOrder) ===
      JSON.stringify(DEFAULT_ORDER),
    "rowOrder defaults to the pre-v11 hardcoded order (upgrade renders byte-identically)",
  );
  // Back-compat: a stored pre-v11 blob (no rowOrder key) merges to the
  // default order.
  const stored = clone(DEFAULT_SETTINGS) as any;
  delete stored.checkoutTrust.rowOrder;
  const merged = mergeSettings(clone(DEFAULT_SETTINGS), stored);
  ok(
    JSON.stringify(merged.checkoutTrust.rowOrder) === JSON.stringify(DEFAULT_ORDER),
    "pre-v11 store merges to the default row order",
  );
  // A stored custom order replaces wholesale (arrays replace on merge) and a
  // valid full permutation survives sanitize unchanged.
  const custom = clone(DEFAULT_SETTINGS) as any;
  custom.checkoutTrust.rowOrder = [
    "trustpilot", "clinical", "tracked", "customs", "guarantee", "badges",
  ];
  const kept = sanitizeSettings(
    mergeSettings(clone(DEFAULT_SETTINGS), custom),
    clone(DEFAULT_SETTINGS),
  );
  ok(
    JSON.stringify(kept.checkoutTrust.rowOrder) ===
      JSON.stringify(["trustpilot", "clinical", "tracked", "customs", "guarantee", "badges"]),
    "a full custom permutation round-trips merge + sanitize verbatim",
  );
  // Sanitize normalizes garbage: unknown keys drop, duplicates dedupe,
  // missing keys append in default order — ordering can never hide a row.
  const junk = clone(DEFAULT_SETTINGS) as any;
  junk.checkoutTrust.rowOrder = ["clinical", "amazon", "clinical", 7, null, "badges"];
  const cleanedOrder = sanitizeSettings(junk, clone(DEFAULT_SETTINGS));
  ok(
    JSON.stringify(cleanedOrder.checkoutTrust.rowOrder) ===
      JSON.stringify(["clinical", "badges", "guarantee", "customs", "tracked", "trustpilot"]),
    "sanitize keeps known keys in listed order and appends the missing rows",
  );
  // Non-array garbage resets to the default order via the same block.
  const notArray = clone(DEFAULT_SETTINGS) as any;
  notArray.checkoutTrust.rowOrder = "badges";
  const reset = sanitizeSettings(notArray, clone(DEFAULT_SETTINGS));
  ok(
    JSON.stringify(reset.checkoutTrust.rowOrder) === JSON.stringify(DEFAULT_ORDER),
    "non-array rowOrder sanitizes to the default order",
  );
  // The exported normalizer (shared by the admin page's load path) agrees.
  ok(
    JSON.stringify(normalizeTrustRowOrder(undefined)) === JSON.stringify(DEFAULT_ORDER) &&
      JSON.stringify(normalizeTrustRowOrder(["tracked"])) ===
        JSON.stringify(["tracked", "badges", "guarantee", "customs", "clinical", "trustpilot"]),
    "normalizeTrustRowOrder: undefined -> default; partial -> listed first, rest appended",
  );
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
// v8.15: press home-page anchor — a theme section-key slug ("" = the
// end-of-page default). Sanitize is shape-gated (slug charset + 64-char
// cap), so nothing injection-shaped ever reaches the storefront island.
{
  ok(
    DEFAULT_SETTINGS.press.homeAfterSection === "",
    "press.homeAfterSection defaults to '' (end of the home page)",
  );
  const valid = clone(DEFAULT_SETTINGS);
  valid.press.homeAfterSection = "product_slider_FR8JAB";
  ok(
    sanitizeSettings(valid, DEFAULT_SETTINGS).press.homeAfterSection ===
      "product_slider_FR8JAB",
    "sanitize: a section-key slug survives",
  );
  for (const bad of [
    'x"y',
    "a b",
    "<script>",
    7,
    null,
    "x".repeat(65),
  ] as const) {
    const dirty = clone(DEFAULT_SETTINGS) as any;
    dirty.press.homeAfterSection = bad;
    ok(
      sanitizeSettings(dirty, DEFAULT_SETTINGS).press.homeAfterSection === "",
      `sanitize: malformed home anchor ${JSON.stringify(bad)} -> '' (default)`,
    );
  }
  // Back-compat: a stored pre-v8.15 blob (no homeAfterSection) merges to
  // the default — existing stores keep the end-of-page position untouched.
  const stored = clone(DEFAULT_SETTINGS) as any;
  delete stored.press.homeAfterSection;
  ok(
    mergeSettings(clone(DEFAULT_SETTINGS), stored).press.homeAfterSection === "",
    "pre-v8.15 store merges to the end-of-page default",
  );
}
// v8.17: endorsement badge flags + merchant copy overrides.
{
  ok(
    DEFAULT_SETTINGS.dermEndorsements.badgeEnabled === false &&
      DEFAULT_SETTINGS.dermEndorsements.badgeShowLink === true,
    "badge defaults: off, link on",
  );
  const copyFields = [
    "copyEyebrow",
    "copyHeadline",
    "copyDescription",
    "copyBadgeHeadline",
    "copyBadgeLink",
    "copyBadgeNoLink",
    "copyBadgeChip",
    "copyOverlayNote",
  ] as const;
  for (const field of copyFields) {
    ok(
      (DEFAULT_SETTINGS.dermEndorsements as any)[field] === "",
      `dermEndorsements.${field} defaults to '' (translated built-in copy)`,
    );
    const dirty = clone(DEFAULT_SETTINGS) as any;
    dirty.dermEndorsements[field] = 7;
    ok(
      sanitizeSettings(dirty, DEFAULT_SETTINGS).dermEndorsements[field] === "",
      `sanitize: non-string ${field} -> ''`,
    );
    const padded = clone(DEFAULT_SETTINGS) as any;
    padded.dermEndorsements[field] = "  padded copy  ";
    ok(
      sanitizeSettings(padded, DEFAULT_SETTINGS).dermEndorsements[field] ===
        "padded copy",
      `sanitize: ${field} is trimmed`,
    );
  }
  for (const flag of ["badgeEnabled", "badgeShowLink"] as const) {
    const dirty = clone(DEFAULT_SETTINGS) as any;
    dirty.dermEndorsements[flag] = "yes";
    ok(
      sanitizeSettings(dirty, DEFAULT_SETTINGS).dermEndorsements[flag] ===
        DEFAULT_SETTINGS.dermEndorsements[flag],
      `sanitize: non-boolean ${flag} -> default`,
    );
  }
  // {n} canonicalization on the two headline fields ONLY: {N}/{ n }/{{n}}/
  // {{ N }} all self-heal to the exact token Liquid substitutes; the same
  // variants in the non-headline fields are merchant text, left alone.
  const variants = clone(DEFAULT_SETTINGS) as any;
  variants.dermEndorsements.copyHeadline = "{N} experts, { n } fans, {{n}} docs, {{ N }} pros";
  variants.dermEndorsements.copyBadgeHeadline = "Backed by {{ n }} experts";
  variants.dermEndorsements.copyBadgeLink = "See all { n } reviews";
  variants.dermEndorsements.copyOverlayNote = "All {{n}} were verified";
  const healed = sanitizeSettings(variants, DEFAULT_SETTINGS).dermEndorsements;
  ok(
    healed.copyHeadline === "{n} experts, {n} fans, {n} docs, {n} pros",
    "sanitize: copyHeadline brace variants canonicalize to {n}",
  );
  ok(
    healed.copyBadgeHeadline === "Backed by {n} experts",
    "sanitize: copyBadgeHeadline brace variants canonicalize to {n}",
  );
  ok(
    healed.copyBadgeLink === "See all { n } reviews",
    "sanitize: non-headline copy keeps its braces verbatim",
  );
  ok(
    healed.copyOverlayNote === "All {n} were verified",
    "sanitize: copyOverlayNote brace variants canonicalize to {n} (v8.21)",
  );
  // {name} tokens must NOT be eaten by the {n} regex.
  const named = clone(DEFAULT_SETTINGS) as any;
  named.dermEndorsements.copyHeadline = "{n} recommend {name}";
  ok(
    sanitizeSettings(named, DEFAULT_SETTINGS).dermEndorsements.copyHeadline ===
      "{n} recommend {name}",
    "sanitize: {name} survives the {n} canonicalization",
  );
  // Caps: single-line 120/160/200, description 1000.
  const capped = clone(DEFAULT_SETTINGS) as any;
  capped.dermEndorsements.copyEyebrow = "x".repeat(500);
  capped.dermEndorsements.copyHeadline = "x".repeat(500);
  capped.dermEndorsements.copyBadgeHeadline = "x".repeat(500);
  capped.dermEndorsements.copyDescription = "x".repeat(5000);
  const cut = sanitizeSettings(capped, DEFAULT_SETTINGS).dermEndorsements;
  ok(
    cut.copyEyebrow.length === 120 &&
      cut.copyHeadline.length === 200 &&
      cut.copyBadgeHeadline.length === 160 &&
      cut.copyDescription.length === 1000,
    "sanitize: copy caps enforced (120/200/160/1000)",
  );
  // The cap counts CODE POINTS: an astral char (emoji) straddling the cap
  // boundary must never be split into a lone surrogate — that would make
  // the settings blob unserializable as metafield JSON (review catch).
  const emoji = clone(DEFAULT_SETTINGS) as any;
  emoji.dermEndorsements.copyEyebrow = "x".repeat(119) + "💜💜";
  const kept = sanitizeSettings(emoji, DEFAULT_SETTINGS).dermEndorsements
    .copyEyebrow;
  ok(
    Array.from(kept).length === 120 &&
      kept.endsWith("💜") &&
      JSON.parse(JSON.stringify(kept)) === kept,
    "sanitize: caps count code points — no lone surrogate at the boundary",
  );
  // Back-compat: a stored pre-v8.17 blob (none of the new fields) merges
  // to the safe defaults — badge stays OFF, copy stays built-in.
  const stored = clone(DEFAULT_SETTINGS) as any;
  delete stored.dermEndorsements.badgeEnabled;
  delete stored.dermEndorsements.badgeShowLink;
  for (const field of copyFields) delete stored.dermEndorsements[field];
  const merged = mergeSettings(clone(DEFAULT_SETTINGS), stored).dermEndorsements;
  ok(
    merged.badgeEnabled === false &&
      merged.badgeShowLink === true &&
      merged.copyEyebrow === "",
    "pre-v8.17 store merges to badge-off + built-in copy",
  );
  // v8.18 badge design enum — closed set, fail-closed to classic.
  ok(
    DEFAULT_SETTINGS.dermEndorsements.badgeStyle === "classic",
    "badgeStyle defaults to classic",
  );
  for (const style of ["choice", "slim", "choice_compact"] as const) {
    const pick = clone(DEFAULT_SETTINGS) as any;
    pick.dermEndorsements.badgeStyle = style;
    ok(
      sanitizeSettings(pick, DEFAULT_SETTINGS).dermEndorsements.badgeStyle ===
        style,
      `sanitize: badgeStyle "${style}" survives`,
    );
  }
  for (const bad of ["fancy", 7, null, "", "CHOICE"] as const) {
    const dirty = clone(DEFAULT_SETTINGS) as any;
    dirty.dermEndorsements.badgeStyle = bad;
    ok(
      sanitizeSettings(dirty, DEFAULT_SETTINGS).dermEndorsements.badgeStyle ===
        "classic",
      `sanitize: badgeStyle ${JSON.stringify(bad)} -> classic`,
    );
  }
  const storedStyle = clone(DEFAULT_SETTINGS) as any;
  delete storedStyle.dermEndorsements.badgeStyle;
  delete storedStyle.dermEndorsements.copyBadgeChip;
  const mergedStyle = mergeSettings(
    clone(DEFAULT_SETTINGS),
    storedStyle,
  ).dermEndorsements;
  ok(
    mergedStyle.badgeStyle === "classic" && mergedStyle.copyBadgeChip === "",
    "pre-v8.18 store merges to classic + built-in chip",
  );
  // v8.21 badge link action — closed enum, fail-closed to scroll.
  ok(
    DEFAULT_SETTINGS.dermEndorsements.badgeLinkAction === "scroll",
    "badgeLinkAction defaults to scroll",
  );
  const overlayPick = clone(DEFAULT_SETTINGS) as any;
  overlayPick.dermEndorsements.badgeLinkAction = "overlay";
  ok(
    sanitizeSettings(overlayPick, DEFAULT_SETTINGS).dermEndorsements
      .badgeLinkAction === "overlay",
    'sanitize: badgeLinkAction "overlay" survives',
  );
  for (const bad of ["popup", 1, null, ""] as const) {
    const dirty = clone(DEFAULT_SETTINGS) as any;
    dirty.dermEndorsements.badgeLinkAction = bad;
    ok(
      sanitizeSettings(dirty, DEFAULT_SETTINGS).dermEndorsements
        .badgeLinkAction === "scroll",
      `sanitize: badgeLinkAction ${JSON.stringify(bad)} -> scroll`,
    );
  }
  const storedAction = clone(DEFAULT_SETTINGS) as any;
  delete storedAction.dermEndorsements.badgeLinkAction;
  delete storedAction.dermEndorsements.copyOverlayNote;
  const mergedAction = mergeSettings(
    clone(DEFAULT_SETTINGS),
    storedAction,
  ).dermEndorsements;
  ok(
    mergedAction.badgeLinkAction === "scroll" &&
      mergedAction.copyOverlayNote === "",
    "pre-v8.21 store merges to scroll + built-in overlay note",
  );
}

// v8.22: wall/overlay designs + proxy-served overlay content.
{
  ok(
    DEFAULT_SETTINGS.dermEndorsements.wallStyle === "wall" &&
      DEFAULT_SETTINGS.dermEndorsements.overlayStyle === "list",
    "v8.22 designs default to the classic wall + list overlay",
  );
  for (const [field, good, bad] of [
    ["wallStyle", "panel", "wall"],
    ["overlayStyle", "official", "list"],
  ] as const) {
    const pick = clone(DEFAULT_SETTINGS) as any;
    pick.dermEndorsements[field] = good;
    ok(
      sanitizeSettings(pick, DEFAULT_SETTINGS).dermEndorsements[field] === good,
      `sanitize: ${field} "${good}" survives`,
    );
    for (const junk of ["masonry", 1, null, ""]) {
      const dirty = clone(DEFAULT_SETTINGS) as any;
      dirty.dermEndorsements[field] = junk;
      ok(
        sanitizeSettings(dirty, DEFAULT_SETTINGS).dermEndorsements[field] === bad,
        `sanitize: ${field} ${JSON.stringify(junk)} -> ${bad} (fail closed)`,
      );
    }
  }
  // The overlay-content fields ship NON-BLANK English defaults (no
  // locale-catalog fallback exists) except FAQ slot 4.
  ok(
    DEFAULT_SETTINGS.dermEndorsements.copyWallCta === "Read all {n} endorsements" &&
      /\S/.test(DEFAULT_SETTINGS.dermEndorsements.copyOverlayIntro) &&
      DEFAULT_SETTINGS.dermEndorsements.copyOverlayFaqTitle === "Common questions" &&
      /\S/.test(DEFAULT_SETTINGS.dermEndorsements.copyOverlayFaq1Q) &&
      /\S/.test(DEFAULT_SETTINGS.dermEndorsements.copyOverlayFaq3A) &&
      DEFAULT_SETTINGS.dermEndorsements.copyOverlayFaq4Q === "" &&
      DEFAULT_SETTINGS.dermEndorsements.copyOverlayFaq4A === "" &&
      DEFAULT_SETTINGS.dermEndorsements.copyOverlayListTitle === "All {n} dermatologists",
    "v8.22 overlay-content defaults: editable English starting copy, FAQ 4 empty",
  );
  // A merchant who BLANKS a piece means to hide it — sanitize must keep
  // "" and never resurrect the default.
  const hiddenPiece = clone(DEFAULT_SETTINGS) as any;
  hiddenPiece.dermEndorsements.copyOverlayIntro = "   ";
  ok(
    sanitizeSettings(hiddenPiece, DEFAULT_SETTINGS).dermEndorsements
      .copyOverlayIntro === "",
    "sanitize: a blanked overlay-content field stays blank (hidden, not defaulted)",
  );
  // Caps: CTA/FAQ-title 120, intro 1500, questions 200, answers 1000,
  // list title 160 — all code points.
  const capped22 = clone(DEFAULT_SETTINGS) as any;
  capped22.dermEndorsements.copyWallCta = "x".repeat(500);
  capped22.dermEndorsements.copyOverlayIntro = "x".repeat(5000);
  capped22.dermEndorsements.copyOverlayFaqTitle = "x".repeat(500);
  capped22.dermEndorsements.copyOverlayFaq2Q = "x".repeat(500);
  capped22.dermEndorsements.copyOverlayFaq2A = "x".repeat(5000);
  capped22.dermEndorsements.copyOverlayListTitle = "x".repeat(500);
  const cut22 = sanitizeSettings(capped22, DEFAULT_SETTINGS).dermEndorsements;
  ok(
    cut22.copyWallCta.length === 120 &&
      cut22.copyOverlayIntro.length === 1500 &&
      cut22.copyOverlayFaqTitle.length === 120 &&
      cut22.copyOverlayFaq2Q.length === 200 &&
      cut22.copyOverlayFaq2A.length === 1000 &&
      cut22.copyOverlayListTitle.length === 160,
    "sanitize: v8.22 copy caps enforced (120/1500/120/200/1000/160)",
  );
  // {n} canonicalization covers the three new count-bearing fields; FAQ
  // text keeps merchant braces verbatim.
  const braces22 = clone(DEFAULT_SETTINGS) as any;
  braces22.dermEndorsements.copyWallCta = "See {{ n }} endorsements";
  braces22.dermEndorsements.copyOverlayIntro = "All { N } are on file";
  braces22.dermEndorsements.copyOverlayListTitle = "The {{n}} doctors";
  braces22.dermEndorsements.copyOverlayFaq1A = "About { n } of them";
  const healed22 = sanitizeSettings(braces22, DEFAULT_SETTINGS).dermEndorsements;
  ok(
    healed22.copyWallCta === "See {n} endorsements" &&
      healed22.copyOverlayIntro === "All {n} are on file" &&
      healed22.copyOverlayListTitle === "The {n} doctors" &&
      healed22.copyOverlayFaq1A === "About { n } of them",
    "sanitize: {n} canonicalization on CTA/intro/list title only (v8.22)",
  );
  // Non-strings become "" (hidden), never the default — the intro default
  // must not sneak back through the junk path.
  const junk22 = clone(DEFAULT_SETTINGS) as any;
  junk22.dermEndorsements.copyOverlayFaq1Q = 7;
  ok(
    sanitizeSettings(junk22, DEFAULT_SETTINGS).dermEndorsements
      .copyOverlayFaq1Q === "",
    "sanitize: non-string overlay-content field -> '' (hidden)",
  );
  // Upgrade path: a stored pre-v8.22 blob (none of the new fields) merges
  // to the classic designs + the English starting copy.
  const stored22 = clone(DEFAULT_SETTINGS) as any;
  delete stored22.dermEndorsements.wallStyle;
  delete stored22.dermEndorsements.overlayStyle;
  delete stored22.dermEndorsements.copyWallCta;
  delete stored22.dermEndorsements.copyOverlayIntro;
  delete stored22.dermEndorsements.copyOverlayFaq1Q;
  const merged22 = mergeSettings(clone(DEFAULT_SETTINGS), stored22).dermEndorsements;
  ok(
    merged22.wallStyle === "wall" &&
      merged22.overlayStyle === "list" &&
      merged22.copyWallCta === DEFAULT_SETTINGS.dermEndorsements.copyWallCta &&
      merged22.copyOverlayIntro === DEFAULT_SETTINGS.dermEndorsements.copyOverlayIntro &&
      merged22.copyOverlayFaq1Q === DEFAULT_SETTINGS.dermEndorsements.copyOverlayFaq1Q,
    "pre-v8.22 store merges to classic designs + the English starting copy",
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

// --- 5b. v10 deliveryEstimate.usStates (US state delivery sub-module) -------
// The state layer rides delivery_estimate as a SUB-module (the boughtOnCards
// precedent — no FeatureKey, none of the 35-count pins move). Sanitize is
// shape-only by SPEC design: '02-30'-style calendar-impossible dates pass
// (same philosophy as the cutoff regex), keys are any AA..ZZ code (never
// checked against a state list server-side), and the resolvers — not the
// sanitizer — own the fail-OPEN discard of incoherent merged windows.
{
  // Inert defaults: module OFF, selector + federal calendar pre-armed.
  const us = DEFAULT_SETTINGS.deliveryEstimate.usStates;
  ok(
    us.enabled === false &&
      us.selector === true &&
      us.selectorPrompt === true &&
      us.federalHolidays === true &&
      Array.isArray(us.extraHolidays) &&
      us.extraHolidays.length === 0 &&
      typeof us.byState === "object" &&
      Object.keys(us.byState).length === 0,
    "v10: usStates defaults are the inert module (off / selector on / prompt on / federal on / no extras / no states)",
  );
  for (const path of [
    "deliveryEstimate.usStates.enabled",
    "deliveryEstimate.usStates.selector",
    "deliveryEstimate.usStates.selectorPrompt",
    "deliveryEstimate.usStates.federalHolidays",
    "deliveryEstimate.usStates.extraHolidays",
    "deliveryEstimate.usStates.byState",
  ]) {
    ok(resolves(path), `v10: cfg path resolves in the real emission: ${path}`);
  }

  // Module switches: non-boolean garbage coerces back to the defaults;
  // module extraHolidays keep only shape-valid dates ('02-30' passes by
  // design, '13-40'/junk/non-strings drop, empty array is a real value).
  {
    const dirty = clone(DEFAULT_SETTINGS) as any;
    dirty.deliveryEstimate.usStates.enabled = "yes";
    dirty.deliveryEstimate.usStates.selector = 1;
    dirty.deliveryEstimate.usStates.selectorPrompt = "on";
    dirty.deliveryEstimate.usStates.federalHolidays = "false";
    dirty.deliveryEstimate.usStates.extraHolidays = [
      "13-40",
      "01-15",
      "02-30",
      "2026-02-30",
      "2026-13-01",
      "junk",
      7,
    ];
    const cleaned = sanitizeSettings(dirty, DEFAULT_SETTINGS);
    ok(
      cleaned.deliveryEstimate.usStates.enabled === false &&
        cleaned.deliveryEstimate.usStates.selector === true &&
        cleaned.deliveryEstimate.usStates.selectorPrompt === true &&
        cleaned.deliveryEstimate.usStates.federalHolidays === true,
      "v10 sanitize: non-boolean module switches -> defaults",
    );
    ok(
      JSON.stringify(cleaned.deliveryEstimate.usStates.extraHolidays) ===
        JSON.stringify(["01-15", "02-30", "2026-02-30"]),
      "v10 sanitize: module extraHolidays shape-validated ('02-30' passes, junk drops)",
    );
  }

  // byState entries: per-field keep-if-valid, PARTIAL by design.
  {
    const dirty = clone(DEFAULT_SETTINGS) as any;
    dirty.deliveryEstimate.usStates.byState = {
      ca: { minDays: 1, cutoff: "25:00" }, // lowercase key + invalid cutoff
      C: { minDays: 1 }, // 1-letter key
      NY: { minDays: 1.5, cutoff: "12:30" }, // fractional min dropped, cutoff kept
      TX: { minDays: 5, maxDays: 2 }, // within-entry repair
      FL: {}, // empty entry
      WA: { minDays: "3", maxDays: 99 }, // nothing valid left
      AK: { extraHolidays: [] }, // ONLY an empty extras array: a real value
      NV: { extraHolidays: ["13-01", "02-30", "2026-05-06", "junk"] },
    };
    const by = sanitizeSettings(dirty, DEFAULT_SETTINGS).deliveryEstimate
      .usStates.byState;
    ok(
      JSON.stringify(by.CA) === JSON.stringify({ minDays: 1 }) && !("ca" in by),
      "v10 sanitize: lowercase key upcased, bad cutoff dropped from the entry",
    );
    ok(!("C" in by), "v10 sanitize: 1-letter key dropped");
    ok(
      JSON.stringify(by.NY) === JSON.stringify({ cutoff: "12:30" }),
      "v10 sanitize: fractional minDays dropped while the valid cutoff survives",
    );
    ok(
      JSON.stringify(by.TX) === JSON.stringify({ minDays: 5, maxDays: 5 }),
      "v10 sanitize: within-entry maxDays repaired up to minDays",
    );
    ok(!("FL" in by), "v10 sanitize: empty entry dropped");
    ok(!("WA" in by), "v10 sanitize: entry with nothing valid left dropped");
    ok(
      JSON.stringify(by.AK) === JSON.stringify({ extraHolidays: [] }),
      "v10 sanitize: an entry with ONLY extraHolidays: [] is KEPT (a real value)",
    );
    ok(
      JSON.stringify(by.NV) === JSON.stringify({ extraHolidays: ["02-30", "2026-05-06"] }),
      "v10 sanitize: per-entry extraHolidays shape-validated ('02-30' passes)",
    );
  }

  // extraHolidays caps (review fix C6): shape-filter FIRST, then slice —
  // 60 US-wide / 40 per state, so the settings blob can never grow past the
  // json-metafield value cap through these lists (invalid entries never
  // consume cap slots).
  {
    const dirty = clone(DEFAULT_SETTINGS) as any;
    const dates = (n: number, junkFirst: boolean) => {
      const out: string[] = junkFirst ? ["junk", "13-40"] : [];
      for (let i = 0; i < n; i += 1) {
        out.push(`${2030 + Math.floor(i / 28)}-01-${String((i % 28) + 1).padStart(2, "0")}`);
      }
      return out;
    };
    dirty.deliveryEstimate.usStates.extraHolidays = dates(61, true);
    dirty.deliveryEstimate.usStates.byState = { CA: { extraHolidays: dates(41, true) } };
    const capped = sanitizeSettings(dirty, DEFAULT_SETTINGS).deliveryEstimate.usStates;
    ok(
      capped.extraHolidays.length === 60 &&
        capped.extraHolidays[0] === "2030-01-01" &&
        capped.extraHolidays[59] === "2032-01-04",
      "v10 sanitize: module extraHolidays capped at 60 AFTER shape filtering (first 60 valid kept, junk costs nothing)",
    );
    ok(
      (capped.byState.CA.extraHolidays as string[]).length === 40 &&
        (capped.byState.CA.extraHolidays as string[])[39] === "2031-01-12",
      "v10 sanitize: per-state extraHolidays capped at 40 AFTER shape filtering",
    );
  }

  // byState is a DYNAMIC_RECORD_KEYS record: the merge replaces it
  // WHOLESALE (editors always send the FULL map) — never per-key deep.
  {
    const base = clone(DEFAULT_SETTINGS) as any;
    base.deliveryEstimate.usStates.byState = {
      CA: { minDays: 2, maxDays: 9 },
      NY: { minDays: 3 },
    };
    const patch = clone(DEFAULT_SETTINGS) as any;
    patch.deliveryEstimate.usStates.byState = { CA: { maxDays: 5 } };
    const merged = mergeSettings(base, patch);
    ok(
      JSON.stringify(merged.deliveryEstimate.usStates.byState) ===
        JSON.stringify({ CA: { maxDays: 5 } }),
      "v10 merge: byState replaced wholesale (stale NY row and CA.minDays gone)",
    );
  }

  // Back-compat: a stored pre-v10 blob (no usStates at all) merges to the
  // inert defaults — existing stores upgrade with the module OFF.
  {
    const stored = clone(DEFAULT_SETTINGS) as any;
    delete stored.deliveryEstimate.usStates;
    const merged = mergeSettings(clone(DEFAULT_SETTINGS), stored);
    ok(
      merged.deliveryEstimate.usStates.enabled === false &&
        merged.deliveryEstimate.usStates.selector === true &&
        merged.deliveryEstimate.usStates.federalHolidays === true &&
        Object.keys(merged.deliveryEstimate.usStates.byState).length === 0,
      "v10: pre-v10 store merges to the inert usStates defaults",
    );
  }
}

// --- 5c. v12 per-market product exclusions ---------------------------------
// Five wholesale-replaced records (DYNAMIC_RECORD_KEYS: excludedByMarket ×2,
// customsExcludedByMarket, trackedExcludedByMarket, shipsFromExcludedByMarket)
// share ONE sanitizer. No FeatureKey — the usStates/boughtOnCards sub-module
// precedent; none of the 35-count pins move.
{
  const RECORDS = [
    ["dispatch", "excludedByMarket"],
    ["deliveryEstimate", "excludedByMarket"],
    ["checkoutTrust", "customsExcludedByMarket"],
    ["checkoutTrust", "trackedExcludedByMarket"],
    ["amazon", "shipsFromExcludedByMarket"],
  ] as const;

  // Inert defaults: all five records arrive EMPTY (opt-in, zero behavior
  // change) and resolve in the real emission.
  for (const [section, key] of RECORDS) {
    const record = (DEFAULT_SETTINGS as any)[section][key];
    ok(
      typeof record === "object" &&
        record !== null &&
        Object.keys(record).length === 0,
      `v12: ${section}.${key} defaults empty`,
    );
    ok(resolves(`${section}.${key}`), `v12: cfg path resolves in the real emission: ${section}.${key}`);
  }

  // Shared sanitizer: bad handles/entries drop, bare numeric ids self-heal
  // to GIDs, duplicates collapse, empty lists vanish, >100 truncates.
  {
    const cleaned = sanitizeExcludedByMarket({
      "us": [
        "gid://shopify/Product/111",
        "gid://shopify/Product/111", // dupe
        222, // bare numeric -> self-heals
        "333", // numeric string -> self-heals
        "gid://shopify/ProductVariant/9", // wrong resource
        "junk",
        null,
      ],
      "eu-market": ["gid://shopify/Product/444"],
      "BAD HANDLE": ["gid://shopify/Product/555"], // invalid key
      "empty": ["junk-only"], // nothing valid left -> entry vanishes
      "notalist": "gid://shopify/Product/666",
    });
    ok(
      JSON.stringify(cleaned) ===
        JSON.stringify({
          us: [
            "gid://shopify/Product/111",
            "gid://shopify/Product/222",
            "gid://shopify/Product/333",
          ],
          "eu-market": ["gid://shopify/Product/444"],
        }),
      "v12 sanitize: dedupe + numeric self-heal + bad keys/entries/empties dropped",
    );
    ok(
      JSON.stringify(sanitizeExcludedByMarket(null)) === "{}" &&
        JSON.stringify(sanitizeExcludedByMarket(["x"])) === "{}" &&
        JSON.stringify(sanitizeExcludedByMarket("x")) === "{}",
      "v12 sanitize: non-object input -> empty record",
    );
    const oversized = sanitizeExcludedByMarket({
      us: Array.from({ length: 150 }, (_, i) => `gid://shopify/Product/${i + 1}`),
    });
    ok(
      oversized.us.length === 100 &&
        oversized.us[0] === "gid://shopify/Product/1" &&
        oversized.us[99] === "gid://shopify/Product/100",
      "v12 sanitize: per-market list caps at 100 (first-listed win)",
    );
  }

  // The sanitizer runs at all five sites through sanitizeSettings.
  {
    const dirty = clone(DEFAULT_SETTINGS) as any;
    for (const [section, key] of RECORDS) {
      dirty[section][key] = {
        us: ["gid://shopify/Product/12345", "junk"],
        "BAD KEY": ["gid://shopify/Product/9"],
      };
    }
    const cleaned = sanitizeSettings(dirty, DEFAULT_SETTINGS) as any;
    for (const [section, key] of RECORDS) {
      ok(
        JSON.stringify(cleaned[section][key]) ===
          JSON.stringify({ us: ["gid://shopify/Product/12345"] }),
        `v12 sanitize wired: ${section}.${key} cleaned on save`,
      );
    }
  }

  // Wholesale replace: a patch record REPLACES the stored one (the
  // DYNAMIC_RECORD_KEYS contract) — and the four distinct key names never
  // collide with section names (dispatch's own merge stays key-driven).
  {
    const base = clone(DEFAULT_SETTINGS) as any;
    base.dispatch.excludedByMarket = {
      us: ["gid://shopify/Product/1"],
      "eu-market": ["gid://shopify/Product/2"],
    };
    base.dispatch.cutoff = "09:30";
    const patch = clone(DEFAULT_SETTINGS) as any;
    patch.dispatch.excludedByMarket = { us: ["gid://shopify/Product/3"] };
    delete patch.dispatch.cutoff;
    const merged = mergeSettings(base, patch) as any;
    ok(
      JSON.stringify(merged.dispatch.excludedByMarket) ===
        JSON.stringify({ us: ["gid://shopify/Product/3"] }),
      "v12 merge: excludedByMarket replaced wholesale (stale eu-market row gone)",
    );
    ok(
      merged.dispatch.cutoff === "09:30",
      "v12 merge: the dispatch SECTION still deep-merges (record key names never collide with section names)",
    );
  }

  // Back-compat: a stored pre-v12 blob (no exclusion records) merges to
  // empty records — existing stores upgrade with zero behavior change.
  {
    const stored = clone(DEFAULT_SETTINGS) as any;
    for (const [section, key] of RECORDS) delete stored[section][key];
    const merged = mergeSettings(clone(DEFAULT_SETTINGS), stored) as any;
    for (const [section, key] of RECORDS) {
      ok(
        JSON.stringify(merged[section][key]) === "{}",
        `v12: pre-v12 store merges to empty ${section}.${key}`,
      );
    }
  }

  // Fail-loud admin validator: undefined passes, malformed shapes error,
  // the numeric self-heal is legal, >100 errors.
  {
    ok(
      validateExcludedByMarketPatch(undefined, "L").length === 0 &&
        validateExcludedByMarketPatch(null, "L").length === 0,
      "v12 validate: absent record -> no errors",
    );
    ok(
      validateExcludedByMarketPatch("x", "L").length === 1 &&
        validateExcludedByMarketPatch({ "BAD KEY": [] }, "L").length === 1 &&
        validateExcludedByMarketPatch({ us: "x" }, "L").length === 1 &&
        validateExcludedByMarketPatch({ us: ["junk"] }, "L").length === 1,
      "v12 validate: malformed shapes fail loud",
    );
    ok(
      validateExcludedByMarketPatch(
        { us: ["gid://shopify/Product/1", "22", 33] },
        "L",
      ).length === 0,
      "v12 validate: GIDs + self-healing numeric ids are legal",
    );
    ok(
      validateExcludedByMarketPatch(
        {
          us: Array.from(
            { length: 101 },
            (_, i) => `gid://shopify/Product/${i + 1}`,
          ),
        },
        "L",
      ).length === 1,
      "v12 validate: >100 per market fails loud (total 101 stays under the record cap)",
    );
  }

  // Review fixes (v12b): real Shopify market handles are lowercase but NOT
  // ASCII-only; prototype-pollution keys must never become record keys;
  // leading-zero numerics self-heal to canonical GIDs; and each record has
  // a TOTAL cap so a legal multi-market save can't overflow the metafield.
  {
    const accented = sanitizeExcludedByMarket({
      "méxico": ["gid://shopify/Product/1"],
    });
    ok(
      JSON.stringify(accented) ===
        JSON.stringify({ "méxico": ["gid://shopify/Product/1"] }),
      "v12b sanitize: accented lowercase market handle accepted",
    );
    ok(
      validateExcludedByMarketPatch(
        { "méxico": ["gid://shopify/Product/1"] },
        "L",
      ).length === 0,
      "v12b validate: accented lowercase market handle accepted",
    );
    const polluted = sanitizeExcludedByMarket({
      ["__proto__"]: ["gid://shopify/Product/1"],
      constructor: ["gid://shopify/Product/2"],
      us: ["gid://shopify/Product/3"],
    });
    ok(
      JSON.stringify(polluted) ===
        JSON.stringify({ us: ["gid://shopify/Product/3"] }) &&
        Object.getPrototypeOf(polluted) === Object.prototype,
      "v12b sanitize: __proto__/constructor keys dropped, prototype intact",
    );
    const healed = sanitizeExcludedByMarket({ us: ["007", 8] });
    ok(
      JSON.stringify(healed) ===
        JSON.stringify({
          us: ["gid://shopify/Product/7", "gid://shopify/Product/8"],
        }),
      "v12b sanitize: leading-zero numerics heal to canonical GIDs (never a dead entry)",
    );
    const capped = sanitizeExcludedByMarket({
      "a-market": Array.from(
        { length: 100 },
        (_, i) => `gid://shopify/Product/${i + 1}`,
      ),
      "b-market": Array.from(
        { length: 100 },
        (_, i) => `gid://shopify/Product/${i + 1001}`,
      ),
    });
    const cappedTotal = Object.values(capped).reduce(
      (n, ids) => n + ids.length,
      0,
    );
    ok(
      cappedTotal === 150 && capped["a-market"].length === 100,
      "v12b sanitize: record TOTAL caps at 150 across markets (metafield budget)",
    );
    ok(
      validateExcludedByMarketPatch(
        {
          "a-market": Array.from(
            { length: 90 },
            (_, i) => `gid://shopify/Product/${i + 1}`,
          ),
          "b-market": Array.from(
            { length: 90 },
            (_, i) => `gid://shopify/Product/${i + 1001}`,
          ),
        },
        "L",
      ).some((e) => e.includes("in total")),
      "v12b validate: record total >150 fails loud with the metafield reason",
    );
  }
}

// --- 6. the 35-key flip round-trip (rebuilt flip-test tripwire) -------------
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
console.log(`ALL ${checks} CHECKS PASSED (settings derivation + 35-key flip proof)`);
