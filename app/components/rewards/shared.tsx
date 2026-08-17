import type { VariantSummary } from "../../services/products.server";

/**
 * Rewards admin (v15, docs/SPEC-v14-rewards.md §11 + the v15 section) —
 * client-safe types, caps, validators and small helpers shared by the route
 * `app/routes/app.features.rewards.tsx` and the tab components in this
 * folder. NOTHING here imports a `.server` VALUE (types only) — the presets
 * ride the route loader.
 */

// ---------------------------------------------------------------------------
// Caps (mirrored from settings.server.ts — the authoritative validators run
// server-side before saveSettings)
// ---------------------------------------------------------------------------

export const CODE_PATTERN = /^[A-Z0-9_-]{2,32}$/;
export const CAPS = {
  setSavingsTiers: 6,
  giftTiers: 4,
  giftSlots: 3,
  giftOptionsPerSlot: 3,
  samplesPerOption: 6,
  /** 9 — MUST equal REWARDS_CAPS.samplePool (settings.server.ts); the route
   *  loader also ships the server value as `caps.samplePool` and the page
   *  uses that at runtime, so a drift here only affects the fallback. */
  samplePool: 9,
  thresholdAmountMax: 1000000,
  warehouseLocations: 6,
  maxGiftLines: 8,
  checkoutMessage: 60,
  yieldToCodes: 20,
} as const;

// ---------------------------------------------------------------------------
// Presets (values ride the loader)
// ---------------------------------------------------------------------------

export type LadderPresetKey = "compact" | "extended" | "custom";
export type LoadableGiftPreset = "value_first" | "cream_first";
export type GiftPresetKey = LoadableGiftPreset | "custom";

export interface PresetTables {
  ladderKeys: readonly LadderPresetKey[];
  ladders: Record<Exclude<LadderPresetKey, "custom">, { count: number; pct: number; code: string }[]>;
  giftKeys: readonly LoadableGiftPreset[];
}

export const LADDER_PRESET_LABELS: Record<LadderPresetKey, string> = {
  compact: "Compact — 2/3/4/6 different products → 5/10/15/20 % off (recommended)",
  extended: "Extended — 2/3/5/10 different products → 5/10/20/30 % off",
  custom: "Custom — I set the tiers myself",
};

export const GIFT_PRESET_LABELS: Record<GiftPresetKey, string> = {
  value_first:
    "Value first (recommended): €119 towels + 2 samples · €200 Jawline cream + 2 samples · €350 cosmetic bag + 3 samples",
  cream_first:
    "Cream first: €119 Jawline cream + 2 samples · €200 towels + 2 samples · €350 cosmetic bag + 3 samples",
  custom: "Custom",
};

export const GIFT_PRESET_BADGES: Record<GiftPresetKey, string> = {
  value_first: "Value first",
  cream_first: "Cream first",
  custom: "Custom",
};

export function isLoadableGiftPreset(
  value: unknown,
  keys: readonly string[],
): value is LoadableGiftPreset {
  return keys.includes(String(value));
}

// ---------------------------------------------------------------------------
// Markets / scopes
// ---------------------------------------------------------------------------

export interface MarketOption {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
  primary: boolean;
  currencyCode: string;
}

export interface ScopeState {
  mode: "all" | "selected";
  markets: string[];
}

export function toScopeState(
  scope: { mode: "all" | "selected"; markets: string[] } | undefined,
): ScopeState {
  return scope && scope.mode === "selected"
    ? { mode: "selected", markets: [...scope.markets] }
    : { mode: "all", markets: [] };
}

/** Scope as persisted — an "all" scope never stores a markets list. */
export function toScopePatch(scope: ScopeState): ScopeState {
  return scope.mode === "all" ? { mode: "all", markets: [] } : scope;
}

/** Number of markets a scope reaches (0 when nothing is selected). */
export function scopeMarketCount(scope: ScopeState, markets: MarketOption[]): number {
  if (scope.mode !== "selected") return markets.length;
  const known = new Set(markets.map((m) => m.handle));
  return scope.markets.filter((h) => known.has(h)).length;
}

/** "All markets", "N markets: names", or the hidden-everywhere warning. */
export function reachCaption(
  scope: ScopeState,
  markets: { handle: string; name: string }[],
): string {
  if (scope.mode !== "selected") return "All markets";
  if (scope.markets.length === 0) return "No markets selected — hidden everywhere";
  const nameByHandle = new Map(markets.map((m) => [m.handle, m.name]));
  if (markets.length > 0 && scope.markets.every((handle) => !nameByHandle.has(handle))) {
    return "No markets selected — hidden everywhere";
  }
  const names = [...scope.markets]
    .sort()
    .map((handle) =>
      markets.length === 0 ? handle : (nameByHandle.get(handle) ?? `${handle} (market not found)`),
    );
  const count = names.length === 1 ? "1 market" : `${names.length} markets`;
  return `${count}: ${names.join(", ")}`;
}

export type RewardsKey = "set_savings" | "gift_tiers";

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

export interface SetSavingsTierRow {
  count: string;
  pct: string;
  code: string;
}

export interface GiftOptionRow {
  kind: "variant" | "samples";
  variantId: string;
  handle: string;
  count: string;
}

export interface GiftTierRow {
  amount: string;
  slots: GiftOptionRow[][];
}

export interface ThresholdRow {
  amounts: string[];
  currencyCode: string;
}

export type GiftChoice = "auto" | "choose";
export type SampleRule = "not_in_cart" | "rotate" | "fixed";

export interface RewardsFormState {
  ss: {
    enabled: boolean;
    ladderPreset: LadderPresetKey;
    tiers: SetSavingsTierRow[];
    yieldToCodes: string[];
    includeSubscriptions: boolean;
    surfaces: {
      pdpLine: boolean;
      similarCaption: boolean;
      fbtCaption: boolean;
      cartNudge: boolean;
      crossSellReframe: boolean;
    };
    checkoutMessage: string;
    excluded: Record<string, string[]>;
  };
  gt: {
    enabled: boolean;
    giftPreset: GiftPresetKey;
    cumulative: boolean;
    choice: GiftChoice;
    maxGiftLines: string;
    sampleRule: SampleRule;
    showShippingMilestone: boolean;
    tiers: GiftTierRow[];
    /** market handle -> per-tier amount strings ("" = no explicit amount) */
    thresholds: Record<string, ThresholdRow>;
    samplePool: { variantId: string; handle: string }[];
    warehouse: Record<string, string[]>;
    stockFloorDays: string;
    stockFloorMinUnits: string;
  };
  fs: {
    enabled: boolean;
    minUnits: string;
    byThreshold: boolean;
    scope: ScopeState;
  };
  scopes: Record<RewardsKey, ScopeState>;
}

export interface DiscountNodesView {
  kit: Record<string, string>;
  gift: string;
  ship: string;
}

export interface StockView {
  t: string;
  byMarket: Record<string, Record<string, { avail: number; paused: boolean }>>;
}

export interface LocationOption {
  id: string;
  name: string;
  countryCode: string;
}

// ---------------------------------------------------------------------------
// Client-side validation (mirrors settings.server.ts)
// ---------------------------------------------------------------------------

export function intError(
  value: string,
  min: number,
  max: number,
  label = "Whole number",
): string | undefined {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed)) return `${label} ${min}–${max}`;
  if (parsed < min || parsed > max) return `${label} ${min}–${max}`;
  return undefined;
}

export function numberError(value: string, min: number, max: number): string | undefined {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed)) return "Enter a number";
  if (parsed < min || parsed > max) return `Between ${min} and ${max}`;
  return undefined;
}

export interface SetSavingsRowErrors {
  count?: string;
  pct?: string;
  code?: string;
}

export function validateSetSavingsRows(rows: SetSavingsTierRow[]): {
  rowErrors: SetSavingsRowErrors[];
  formErrors: string[];
} {
  const formErrors: string[] = [];
  if (rows.length > CAPS.setSavingsTiers) {
    formErrors.push(`At most ${CAPS.setSavingsTiers} tiers.`);
  }
  const codes = new Set<string>();
  let lastCount = 1;
  const rowErrors = rows.map((row) => {
    const errors: SetSavingsRowErrors = {};
    errors.count = intError(row.count, 2, 50, "Products");
    const count = Number(row.count);
    if (!errors.count) {
      if (count <= lastCount) errors.count = "Must be more than the tier above";
      else lastCount = count;
    }
    errors.pct = numberError(row.pct, 1, 90);
    const code = row.code.trim().toUpperCase();
    if (!CODE_PATTERN.test(code)) {
      errors.code = "2–32 characters: A–Z, 0–9, _ or -";
    } else if (codes.has(code)) {
      errors.code = "Code used twice";
    } else {
      codes.add(code);
    }
    return errors;
  });
  return { rowErrors, formErrors };
}

/** Step-aside codes: trimmed, upper-cased, valid pattern, deduped, never a
 *  tier code. Returns the cleaned list + a message when something was dropped. */
export function normalizeYieldCodes(
  raw: string[],
  tierRows: readonly { code: string }[],
): { codes: string[]; error?: string } {
  const ladder = new Set(tierRows.map((t) => t.code.trim().toUpperCase()));
  const out: string[] = [];
  const dropped: string[] = [];
  for (const entry of raw) {
    const code = entry.trim().toUpperCase();
    if (code === "") continue;
    if (!CODE_PATTERN.test(code)) {
      dropped.push(entry.trim());
      continue;
    }
    if (ladder.has(code) || out.includes(code)) continue;
    out.push(code);
  }
  return {
    codes: out.slice(0, CAPS.yieldToCodes),
    error:
      dropped.length > 0
        ? `Ignored (letters, digits, _ or - only, 2–32 characters): ${dropped.join(", ")}`
        : out.length > CAPS.yieldToCodes
          ? `Only the first ${CAPS.yieldToCodes} codes are kept.`
          : undefined,
  };
}

export interface GiftTierErrors {
  amount?: string;
  slots: string[][];
  tier?: string;
}

export function validateGiftTierRows(rows: GiftTierRow[]): {
  tierErrors: GiftTierErrors[];
  formErrors: string[];
} {
  const formErrors: string[] = [];
  if (rows.length > CAPS.giftTiers) formErrors.push(`At most ${CAPS.giftTiers} gift tiers.`);
  let last = -1;
  const tierErrors = rows.map((row) => {
    const errors: GiftTierErrors = { slots: [] };
    errors.amount = numberError(row.amount, 0, CAPS.thresholdAmountMax);
    const amount = Number(row.amount);
    if (!errors.amount) {
      if (amount <= last) errors.amount = "Must be more than the tier above";
      else last = amount;
    }
    if (row.slots.length === 0) errors.tier = "Add at least one gift.";
    else if (row.slots.length > CAPS.giftSlots) errors.tier = `At most ${CAPS.giftSlots} gifts per tier.`;
    errors.slots = row.slots.map((slot) => {
      if (slot.length === 0) return ["Pick a product or a sample count."];
      if (slot.length > CAPS.giftOptionsPerSlot) return [`At most ${CAPS.giftOptionsPerSlot} backups.`];
      return slot.map((option) => {
        if (option.kind === "samples") {
          return intError(option.count, 1, CAPS.samplesPerOption, "Sachets") ?? "";
        }
        return option.variantId === "" && option.handle === "" ? "Pick a product" : "";
      });
    });
    return errors;
  });
  return { tierErrors, formErrors };
}

/** Per-market amount rows: blank row = defaults; a partly filled row or a
 *  non-numeric amount is refused. Returns market handle -> message. */
export function validateThresholdRows(
  thresholds: Record<string, ThresholdRow>,
  tierCount: number,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [handle, row] of Object.entries(thresholds)) {
    const filled = row.amounts.filter((a) => a.trim() !== "");
    if (filled.length === 0) continue;
    if (row.amounts.length !== tierCount || filled.length !== tierCount) {
      errors[handle] = "Fill every tier or leave the whole row blank";
      continue;
    }
    // Mirrors validateGiftTiersPatch: every amount > 0, at most the cap, and
    // strictly increasing tier by tier.
    let previous = 0;
    for (const a of row.amounts) {
      const err = numberError(a, 0, CAPS.thresholdAmountMax);
      if (err) {
        errors[handle] = err;
        break;
      }
      const n = Number(a);
      if (n <= 0) {
        errors[handle] = "Every amount must be more than 0";
        break;
      }
      if (n <= previous) {
        errors[handle] = "Amounts must increase tier by tier";
        break;
      }
      previous = n;
    }
  }
  return errors;
}

/** Sample pool: at most CAPS.samplePool (server REWARDS_CAPS.samplePool)
 *  entries. Returns the message when the pool is over the cap. */
export function samplePoolError(
  pool: readonly unknown[],
  cap: number = CAPS.samplePool,
): string | undefined {
  return pool.length > cap
    ? `At most ${cap} sachets in the sample pool — remove ${pool.length - cap} before saving.`
    : undefined;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function variantLabel(variant: VariantSummary): string {
  return variant.title && variant.title !== "Default Title"
    ? `${variant.productTitle} — ${variant.title}`
    : variant.productTitle;
}

/** "gid://shopify/ProductVariant/123" -> "123" (client-safe twin of
 *  rewards.server.ts numericId). */
export function numericId(gid: string): string {
  const match = /(\d+)(?:\?.*)?$/.exec(String(gid ?? "").trim());
  return match ? match[1] : "";
}

export function shortGid(gid: string): string {
  const id = numericId(gid);
  return id ? `#${id}` : gid;
}

/** Worst-case stacking: several percentages applied one after the other. */
export function stackedPct(parts: number[]): string {
  const remaining = parts.reduce((acc, pct) => acc * (1 - pct / 100), 1);
  return `${((1 - remaining) * 100).toFixed(1)}%`;
}

export function formatEur(amount: string | number): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return "€…";
  return `€${Number.isInteger(n) ? String(n) : n.toFixed(2)}`;
}

/** Human label of a gift option ("Bamboo towels", "2 sample sachets"). */
export function giftOptionLabel(
  option: GiftOptionRow,
  variantIndex: Record<string, VariantSummary>,
): string {
  if (option.kind === "samples") {
    const n = option.count.trim();
    return `${n || "?"} sample sachet${n === "1" ? "" : "s"}`;
  }
  const known = variantIndex[option.variantId];
  if (known) return known.productTitle;
  if (option.handle) return option.handle.replace(/-/g, " ");
  return option.variantId ? shortGid(option.variantId) : "No product picked";
}
