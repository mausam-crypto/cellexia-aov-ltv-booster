/**
 * Cellexia AOV & LTV Booster — checkout trust module V2 pure logic (v9).
 *
 * PURE TypeScript module: no extension imports, no React, no globals — so
 * validation/sims/checkout-trust.ts can import it directly and drive every
 * gate with fixtures (the delivery-engine.ts convention). Checkout.tsx keeps
 * only the React components and hooks.
 *
 * Everything here FAILS CLOSED: a missing/malformed config section resolves
 * to the safe default (module off, rows off, preview inert), and the market
 * gate hides mode-"selected" features whenever the buyer's market is
 * unknown (Google Ads compliance — never show a feature in a market it
 * wasn't enabled for).
 */

/**
 * v11: the six display rows in their DEFAULT display order — the pre-v11
 * hardcoded render order, so a config without `rowOrder` renders
 * byte-identically to before. Mirrors CHECKOUT_TRUST_ROWS in
 * app/models/settings.server.ts (keep the two lists in sync).
 */
export const TRUST_ROW_ORDER_DEFAULT = [
  'badges',
  'guarantee',
  'customs',
  'tracked',
  'clinical',
  'trustpilot',
] as const;
export type TrustRowKey = (typeof TRUST_ROW_ORDER_DEFAULT)[number];

export interface TrustModuleConfig {
  checkoutTrust: {
    enabled: boolean;
    showGuarantee: boolean;
    showTrustpilot: boolean;
    showClinical: boolean;
    showBadges: boolean;
    /** v9 rows — FeatureKeys checkout_customs / checkout_tracked. Unlike the
     *  four legacy rows these default OFF: a config written before V2 must
     *  render byte-identically to before (no new rows appear unbidden). */
    showCustoms: boolean;
    showTracked: boolean;
    /** v11 display order — resolveConfig guarantees a FULL permutation of
     *  TRUST_ROW_ORDER_DEFAULT (ordering can never hide a row; visibility
     *  stays with the show* flags and the per-row market gates). */
    rowOrder: TrustRowKey[];
  };
  guarantee: {days: number};
  trustpilot: {
    rating: number;
    reviewCount: number;
    profileUrl: string;
    /** false = render the rating as plain text instead of a Link. */
    showLink: boolean;
  };
}

/** Mirrors the relevant slices of DEFAULT_SETTINGS in app/models/settings.server.ts. */
export const DEFAULT_CONFIG: TrustModuleConfig = {
  checkoutTrust: {
    enabled: false,
    showGuarantee: true,
    showTrustpilot: true,
    showClinical: false,
    showBadges: true,
    showCustoms: false,
    showTracked: false,
    rowOrder: [...TRUST_ROW_ORDER_DEFAULT],
  },
  guarantee: {days: 60},
  trustpilot: {
    rating: 4.8,
    reviewCount: 1000,
    profileUrl: 'https://www.trustpilot.com/review/cellexia.com',
    // Default/missing = linked — matches DEFAULT_SETTINGS.trustpilot.showLink,
    // so configs written before the flag existed behave byte-identically.
    showLink: true,
  },
};

export interface PreviewConfig {
  armed: boolean;
  draftFlags: Record<string, boolean>;
  tokenHash: string;
}

/** Inert preview default: disarmed, no draft flags, empty (never-matching) token hash. */
export const DEFAULT_PREVIEW: PreviewConfig = {
  armed: false,
  draftFlags: {},
  tokenHash: '',
};

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoolean(source: unknown, key: string, fallback: boolean): boolean {
  if (isPlainObject(source) && typeof source[key] === 'boolean') {
    return source[key] as boolean;
  }
  return fallback;
}

function readNumber(source: unknown, key: string, fallback: number): number {
  if (isPlainObject(source)) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return fallback;
}

function readString(source: unknown, key: string, fallback: string): string {
  if (isPlainObject(source) && typeof source[key] === 'string') {
    return source[key] as string;
  }
  return fallback;
}

/**
 * v11: normalizes `checkoutTrust.rowOrder` into a FULL permutation of
 * TRUST_ROW_ORDER_DEFAULT — unknown entries drop, duplicates keep their
 * first position, missing rows append in default order, and any non-array
 * input (including a pre-v11 config without the key) yields the default
 * order. FAILS SAFE, not closed: a malformed order can reshuffle rows but
 * can never hide one — visibility belongs to the show* flags alone.
 * Twin of normalizeTrustRowOrder in app/models/settings.server.ts.
 */
export function normalizeRowOrder(value: unknown): TrustRowKey[] {
  const out: TrustRowKey[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (
        (TRUST_ROW_ORDER_DEFAULT as readonly string[]).includes(
          entry as string,
        ) &&
        !out.includes(entry as TrustRowKey)
      ) {
        out.push(entry as TrustRowKey);
      }
    }
  }
  for (const key of TRUST_ROW_ORDER_DEFAULT) {
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Locates the `config` JSON metafield among the app metafield entries.
 * The namespace is declared as `$app:cellexia`; at runtime it may surface as
 * `$app:cellexia`, `cellexia` or `app--<id>--cellexia`, so we match on the
 * `cellexia` suffix as the stable part. (Shared by checkout-trust and
 * checkout-delivery.)
 */
export function parseCellexiaConfig(
  entries: ReadonlyArray<{
    metafield: {namespace: string; key: string; value: string | number | boolean};
  }>,
): Record<string, unknown> | undefined {
  for (const entry of entries) {
    const metafield = entry?.metafield;
    if (!metafield || metafield.key !== 'config') continue;
    const namespace =
      typeof metafield.namespace === 'string' ? metafield.namespace : '';
    if (!namespace.endsWith('cellexia')) continue;
    const raw: unknown = metafield.value;
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isPlainObject(parsed)) return parsed;
      } catch {
        return undefined;
      }
    } else if (isPlainObject(raw)) {
      return raw;
    }
  }
  return undefined;
}

export function resolveConfig(
  root: Record<string, unknown> | undefined,
): TrustModuleConfig {
  if (!root) return DEFAULT_CONFIG;
  const trust = root.checkoutTrust;
  const guarantee = root.guarantee;
  const trustpilot = root.trustpilot;
  const defaults = DEFAULT_CONFIG;
  return {
    checkoutTrust: {
      // Safe default: ON only when the metafield explicitly says
      // `enabled: true`. Missing, malformed or falsy values all mean OFF.
      enabled: isPlainObject(trust) && trust.enabled === true,
      showGuarantee: readBoolean(
        trust,
        'showGuarantee',
        defaults.checkoutTrust.showGuarantee,
      ),
      showTrustpilot: readBoolean(
        trust,
        'showTrustpilot',
        defaults.checkoutTrust.showTrustpilot,
      ),
      showClinical: readBoolean(
        trust,
        'showClinical',
        defaults.checkoutTrust.showClinical,
      ),
      showBadges: readBoolean(trust, 'showBadges', defaults.checkoutTrust.showBadges),
      // v9 rows fail CLOSED: anything but an explicit `true` (including a
      // pre-V2 config that lacks the keys entirely) keeps the row hidden.
      // (Kept single-line: the sim's mutation anchors target these lines.)
      showCustoms: readBoolean(trust, 'showCustoms', defaults.checkoutTrust.showCustoms),
      showTracked: readBoolean(trust, 'showTracked', defaults.checkoutTrust.showTracked),
      // v11: always a full permutation — order can reshuffle, never hide.
      rowOrder: normalizeRowOrder(isPlainObject(trust) ? trust.rowOrder : undefined),
    },
    guarantee: {
      days: Math.max(1, Math.round(readNumber(guarantee, 'days', defaults.guarantee.days))),
    },
    trustpilot: {
      rating: Math.min(
        5,
        Math.max(0, readNumber(trustpilot, 'rating', defaults.trustpilot.rating)),
      ),
      reviewCount: Math.max(
        0,
        Math.round(
          readNumber(trustpilot, 'reviewCount', defaults.trustpilot.reviewCount),
        ),
      ),
      profileUrl: readString(trustpilot, 'profileUrl', defaults.trustpilot.profileUrl),
      // Missing/malformed = true (linked): behavior is byte-identical for
      // every config written before this flag existed.
      showLink: readBoolean(trustpilot, 'showLink', defaults.trustpilot.showLink),
    },
  };
}

/**
 * Resolves the `preview` section from the shop metafield config (v5). Safe
 * default: preview is INERT (disarmed, no flags, empty token hash) whenever
 * the section is missing or malformed. Only the SHA-256 hex digest of the
 * preview token (`tokenHash`) ever reaches the checkout: the shop metafield
 * carries it here, and the merchant's `_cx_preview` cart attribute carries
 * the same digest (computed server-side) — the raw token never leaves the
 * app. A legacy `preview.token` field, if present, is ignored.
 */
export function resolvePreview(
  root: Record<string, unknown> | undefined,
): PreviewConfig {
  if (!root || !isPlainObject(root.preview)) return DEFAULT_PREVIEW;
  const section = root.preview;
  const armed = section.armed === true;
  const tokenHash =
    typeof section.tokenHash === 'string' ? section.tokenHash : '';
  const draftFlags: Record<string, boolean> = {};
  if (isPlainObject(section.draftFlags)) {
    for (const [key, value] of Object.entries(section.draftFlags)) {
      if (typeof value === 'boolean') draftFlags[key] = value;
    }
  }
  return {armed, draftFlags, tokenHash};
}

/**
 * Evaluates `cfg.marketScopes[featureKey]` against the buyer's market.
 * Mirrors `isFeatureOnForMarket` in app/models/settings.server.ts: a missing
 * or malformed scope, or mode "all", is visible everywhere (flags
 * permitting); mode "selected" is visible ONLY when the buyer's market
 * handle is known AND listed. Unknown market + "selected" FAILS CLOSED
 * (hidden) — Google Ads compliance: never show a feature in a market it
 * wasn't enabled for.
 */
export function isAllowedInMarket(
  root: Record<string, unknown> | undefined,
  featureKey: string,
  marketHandle: string | undefined,
): boolean {
  if (!root) return true;
  const scopes = root.marketScopes;
  if (!isPlainObject(scopes)) return true;
  const scope = scopes[featureKey];
  if (!isPlainObject(scope)) return true;
  if (scope.mode !== 'selected') return true;
  if (!marketHandle) return false;
  const markets = scope.markets;
  if (!Array.isArray(markets)) return false;
  return markets.includes(marketHandle);
}

/**
 * Builds the merchant-facing reason shown when a preview cart (the
 * `_cx_preview` attribute is present) would otherwise see nothing here.
 * Checks run in order, most fundamental first. Hardcoded English on
 * purpose: this line renders only on merchant preview carts — real buyers
 * never carry the attribute — so it is a merchant tool, not buyer copy.
 */
export function trustPreviewDiagnosis(input: {
  configFound: boolean;
  preview: PreviewConfig;
  attributeValue: string | undefined;
  featureVisible: boolean;
  /** The tracked row is wanted (flag/market/draft gates passed) … */
  trackedWanted: boolean;
  /** … but the buyer country is not known yet … */
  countryCode: string | undefined;
  /** … or the fail-closed date chain produced no formattable label. */
  trackedDateLabel: string;
}): string {
  if (!input.configFound) {
    return 'config metafield not found — save Settings once in the app and check Setup & health';
  }
  if (!input.preview.armed) {
    return "preview is not armed — arm it in the app's Preview page";
  }
  if (input.attributeValue !== input.preview.tokenHash) {
    return 'preview link is stale — reopen the preview from the app (token rotated?)';
  }
  if (!input.featureVisible) {
    return 'the checkout trust feature is not draft-enabled for this preview';
  }
  // v9: when the tracked row is the element that should render but its
  // fail-closed date chain hides it, saying "toggled off" would be false —
  // mirror the delivery extension's date-chain diagnostics instead.
  if (input.trackedWanted && !input.countryCode) {
    return 'no shipping country yet — enter a shipping address to see the tracked-delivery date';
  }
  if (input.trackedWanted && input.trackedDateLabel === '') {
    return `no delivery date can be computed for ${input.countryCode} — country hidden, invalid schedule, no qualifying delivery day in range, or unformattable date`;
  }
  return 'all trust module elements are toggled off';
}

/**
 * v9 COMPACT DATE_STYLE for the tracked-delivery row — the compact sibling
 * of the delivery guarantee's full form (deliveryFormatDate in
 * ./delivery-engine.ts, the v6.0.1 contract). Same house rules, minus the
 * weekday (the row must stay one short line next to its label):
 *
 *  - options are ALWAYS { day: 'numeric', month: 'long' } and the locale
 *    string is passed to Intl VERBATIM ("pt-PT" stays "pt-PT") so Intl owns
 *    each language's native order, punctuation, casing, script and digits —
 *    en "August 13", fr "13 août", de "13. August", ja "8月13日", el
 *    "13 Αυγούστου" (genitive), ar keeps its own digits;
 *  - v6.0.2 French ordinal rule: day 1 renders "1er" ("1er mai");
 *  - fallback chain: verbatim-locale compact form -> short browser form
 *    (missing locale or Intl rejecting the tag) -> '' ONLY when formatting
 *    itself throws (fail closed: hide the row, never mislabel a date);
 *  - the UTC calendar stamp is rebuilt as a LOCAL noon Date so formatting
 *    can never shift the calendar day, whatever the buyer's UTC offset
 *    (unchanged house convention).
 */
export function trustFormatDateCompact(ut: number, locale: string): string {
  const d = new Date(ut);
  const local = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  const base =
    typeof locale === 'string' && locale
      ? locale.split('-')[0].toLowerCase()
      : '';
  if (base) {
    try {
      // Kept single-line: the sim's mutation anchor targets the options.
      let label = local.toLocaleDateString(locale, {day: 'numeric', month: 'long'});
      if (base === 'fr' && d.getUTCDate() === 1 && typeof label === 'string') {
        label = label.replace(/\b1\b/, '1er');
      }
      if (typeof label === 'string' && label) return label;
    } catch {
      // Intl rejected the locale tag: fall through to the short form
    }
  }
  try {
    const fallback = local.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });
    return typeof fallback === 'string' && fallback ? fallback : '';
  } catch {
    return ''; // formatting itself threw: hidden, never a wrong date
  }
}
