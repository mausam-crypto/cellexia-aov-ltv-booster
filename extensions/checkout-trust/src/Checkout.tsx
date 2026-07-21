import {useEffect, useMemo, useState} from 'react';
import {
  BlockStack,
  Icon,
  InlineLayout,
  InlineStack,
  Link,
  Text,
  reactExtension,
  useApi,
  useAppMetafields,
  useAttributeValues,
  useCartLines,
  useLocalizationMarket,
  useSubscription,
  useTranslate,
} from '@shopify/ui-extensions-react/checkout';
import type {PurchasingCompany} from '@shopify/ui-extensions/checkout';

/**
 * Cellexia AOV & LTV Booster — Checkout Trust module.
 *
 * Pure display block: money-back guarantee, secure-checkout line, clinical
 * claim, Trustpilot rating and an optional subscription hint (hidden when the
 * cart already contains a subscription line, and for B2B buyers purchasing on
 * behalf of a company — B2B never sees subscription offers). All values come
 * from the shop metafield ($app:cellexia / config); no cart mutations, no
 * network calls.
 *
 * SAFE BY DEFAULT: a missing/unparsable config metafield, a missing
 * `checkoutTrust` section, or anything but an explicit `enabled: true`
 * renders nothing. Market targeting is enforced against the checkout's
 * localization market and FAILS CLOSED (mode "selected" + unknown market →
 * hidden): the whole module respects `marketScopes.checkout_trust`, and the
 * subscription hint ADDITIONALLY respects `marketScopes.subscription_nudge`
 * because it displays subscription_nudge content.
 *
 * PREVIEW (v4): when the shop metafield carries `preview.armed: true` AND
 * the SHA-256 digest of the cart's `_cx_preview` attribute (the raw preview
 * token) equals the (non-empty) `preview.tokenHash`, the module additionally
 * counts as enabled when
 * `preview.draftFlags.checkout_trust === true`, and the subscription hint
 * when `preview.draftFlags.subscription_nudge === true` — each bypassing its
 * market gate for the draft grant only (the preview cart belongs to the
 * merchant). The hint's contextual suppressions (existing subscription line,
 * B2B purchasing company) still apply in preview. Outside preview mode every
 * gate is byte-identical to v3 — all preview logic sits behind the single
 * `previewActive` boolean, which requires the exact hash match.
 */

/** Mirrors the relevant slices of DEFAULT_SETTINGS in app/models/settings.server.ts. */
const DEFAULT_CONFIG: TrustModuleConfig = {
  checkoutTrust: {
    enabled: false,
    showGuarantee: true,
    showTrustpilot: true,
    showClinical: false,
    showBadges: true,
  },
  guarantee: {days: 60},
  trustpilot: {
    rating: 4.8,
    reviewCount: 1000,
    profileUrl: 'https://www.trustpilot.com/review/cellexia.com',
  },
  subscriptionNudge: {enabled: false, discountPct: 5},
};

interface TrustModuleConfig {
  checkoutTrust: {
    enabled: boolean;
    showGuarantee: boolean;
    showTrustpilot: boolean;
    showClinical: boolean;
    showBadges: boolean;
  };
  guarantee: {days: number};
  trustpilot: {rating: number; reviewCount: number; profileUrl: string};
  subscriptionNudge: {enabled: boolean; discountPct: number};
}

interface PreviewConfig {
  armed: boolean;
  draftFlags: Record<string, boolean>;
  tokenHash: string;
}

/** Inert preview default: disarmed, no draft flags, empty (never-matching) token hash. */
const DEFAULT_PREVIEW: PreviewConfig = {armed: false, draftFlags: {}, tokenHash: ''};

/**
 * Stand-in subscribable used when `buyerIdentity` is unavailable (the app
 * lacks protected customer data access). Reads as "no purchasing company",
 * so B2B detection fails open and regular consumers still see the hint.
 */
const NO_PURCHASING_COMPANY = {
  current: undefined as PurchasingCompany | undefined,
  subscribe: () => () => {},
  destroy: () => Promise.resolve(),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
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
 * Locates the `config` JSON metafield among the app metafield entries.
 * The namespace is declared as `$app:cellexia`; at runtime it may surface as
 * `$app:cellexia`, `cellexia` or `app--<id>--cellexia`, so we match on the
 * `cellexia` suffix as the stable part.
 */
function parseCellexiaConfig(
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

function resolveConfig(root: Record<string, unknown> | undefined): TrustModuleConfig {
  if (!root) return DEFAULT_CONFIG;
  const trust = root.checkoutTrust;
  const guarantee = root.guarantee;
  const trustpilot = root.trustpilot;
  const nudge = root.subscriptionNudge;
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
    },
    subscriptionNudge: {
      // Same explicit-true rule as checkoutTrust.enabled.
      enabled: isPlainObject(nudge) && nudge.enabled === true,
      discountPct: Math.max(
        0,
        readNumber(nudge, 'discountPct', defaults.subscriptionNudge.discountPct),
      ),
    },
  };
}

/**
 * Resolves the `preview` section from the shop metafield config (v4). Safe
 * default: preview is INERT (disarmed, no flags, empty token hash) whenever
 * the section is missing or malformed. Only the SHA-256 hex digest of the
 * preview token (`tokenHash`) reaches this extension via the checkout-only
 * shop metafield — the raw token travels solely in the merchant's own
 * `_cx_preview` cart attribute. A legacy `preview.token` field, if present,
 * is ignored.
 */
function resolvePreview(root: Record<string, unknown> | undefined): PreviewConfig {
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
 * SHA-256 hex digest of a UTF-8 string via SubtleCrypto (available in the
 * checkout web-worker sandbox). Resolves to undefined when SubtleCrypto is
 * unavailable so callers fail closed (preview stays inactive).
 */
async function sha256Hex(value: string): Promise<string | undefined> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return undefined;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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
function isAllowedInMarket(
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

export default reactExtension('purchase.checkout.block.render', () => <Extension />);

function Extension() {
  const translate = useTranslate();
  const {i18n, buyerIdentity} = useApi();
  const metafieldEntries = useAppMetafields();
  const cartLines = useCartLines();
  const market = useLocalizationMarket();

  /**
   * The company the buyer is purchasing on behalf of during a B2B checkout.
   * `buyerIdentity` requires protected customer data access, so it may be
   * undefined at runtime — in that case this reads as undefined (fail open).
   */
  const purchasingCompany = useSubscription(
    buyerIdentity?.purchasingCompany ?? NO_PURCHASING_COMPANY,
  );

  const configRoot = useMemo(
    () => parseCellexiaConfig(metafieldEntries),
    [metafieldEntries],
  );
  const config = useMemo(() => resolveConfig(configRoot), [configRoot]);
  const marketHandle = market?.handle;
  const trustAllowedInMarket = isAllowedInMarket(
    configRoot,
    'checkout_trust',
    marketHandle,
  );
  /**
   * The hint renders subscription_nudge content, so it must respect that
   * feature's market scope too — same fail-closed rule, key
   * 'subscription_nudge'.
   */
  const nudgeAllowedInMarket = isAllowedInMarket(
    configRoot,
    'subscription_nudge',
    marketHandle,
  );

  // v4 preview: the single gate for ALL preview behavior. Requires the shop
  // metafield to be armed, a non-empty token hash AND that the SHA-256
  // digest of the cart's `_cx_preview` attribute (set by the merchant's
  // preview hub, carrying the raw token) equals that hash. The digest is
  // async, so the match lives in state and starts false (fail closed): a
  // preview cart renders live-only for a frame until the digest resolves,
  // which is acceptable. `useAttributeValues` yields `undefined` while
  // attributes are absent, which can never match a non-empty hash.
  const preview = useMemo(() => resolvePreview(configRoot), [configRoot]);
  const [previewAttributeValue] = useAttributeValues(['_cx_preview']);
  const [previewTokenMatches, setPreviewTokenMatches] = useState(false);
  useEffect(() => {
    // Fail closed while inputs are unusable or the digest is pending.
    setPreviewTokenMatches(false);
    const tokenHash = preview.tokenHash;
    if (tokenHash.length === 0) return;
    if (
      typeof previewAttributeValue !== 'string' ||
      previewAttributeValue.length === 0
    ) {
      return;
    }
    let cancelled = false;
    void sha256Hex(previewAttributeValue).then((hex) => {
      if (!cancelled) {
        setPreviewTokenMatches(hex !== undefined && hex === tokenHash);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [previewAttributeValue, preview.tokenHash]);
  const previewActive =
    preview.armed && preview.tokenHash.length > 0 && previewTokenMatches;
  // Draft grants: in preview mode a feature counts as enabled when its draft
  // flag is explicitly true — market gating is bypassed for the draft grant
  // only (the preview cart is the merchant's own). The live paths are
  // untouched: live stays live. The subscription hint uses its own key,
  // `subscription_nudge`, because it renders that feature's content.
  const trustDraftEnabled =
    previewActive && preview.draftFlags.checkout_trust === true;
  const nudgeDraftEnabled =
    previewActive && preview.draftFlags.subscription_nudge === true;

  /**
   * True when any cart line is already on a selling plan. The checkout cart
   * line merchandise exposes `sellingPlan` when present; if the field is
   * absent (older data), detection fails open and the hint stays visible
   * whenever the nudge is enabled.
   */
  const hasSubscriptionLine = useMemo(
    () =>
      cartLines.some((line) => {
        const merchandise = line?.merchandise as
          | {sellingPlan?: unknown}
          | undefined;
        const sellingPlan = merchandise?.sellingPlan;
        return typeof sellingPlan === 'object' && sellingPlan !== null;
      }),
    [cartLines],
  );

  const trustVisible =
    (config.checkoutTrust.enabled && trustAllowedInMarket) || trustDraftEnabled;
  if (!trustVisible) return null;

  const {showGuarantee, showTrustpilot, showClinical, showBadges} =
    config.checkoutTrust;
  // The hint's contextual suppressions (existing subscription line, B2B
  // purchasing company) apply in preview too — only the enabled flag and
  // market gate are draft-overridable.
  const showHint =
    ((config.subscriptionNudge.enabled && nudgeAllowedInMarket) ||
      nudgeDraftEnabled) &&
    !hasSubscriptionLine &&
    !purchasingCompany;

  if (!showGuarantee && !showTrustpilot && !showClinical && !showBadges && !showHint) {
    return null;
  }

  function formatNumberSafe(value: number, options?: Intl.NumberFormatOptions): string {
    try {
      return i18n.formatNumber(value, options);
    } catch {
      return String(value);
    }
  }

  const ratingText = formatNumberSafe(config.trustpilot.rating, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const countText = formatNumberSafe(config.trustpilot.reviewCount);
  const trustpilotLabel = translate('trustpilot', {
    rating: ratingText,
    count: countText,
  });
  const profileUrl = /^https:\/\//i.test(config.trustpilot.profileUrl)
    ? config.trustpilot.profileUrl
    : undefined;

  const filledStars = Math.min(5, Math.max(0, Math.round(config.trustpilot.rating)));

  return (
    <BlockStack spacing="tight">
      {showBadges ? (
        <InlineLayout columns={['auto', 'fill']} spacing="tight" blockAlignment="center">
          <Icon source="lock" appearance="subdued" size="small" />
          <Text size="small">{translate('secure')}</Text>
        </InlineLayout>
      ) : null}
      {showGuarantee ? (
        <InlineLayout columns={['auto', 'fill']} spacing="tight" blockAlignment="start">
          <Icon source="success" appearance="subdued" size="small" />
          <BlockStack spacing="none">
            <Text size="small" emphasis="bold">
              {translate('guarantee_title', {days: config.guarantee.days})}
            </Text>
            <Text size="small" appearance="subdued">
              {translate('guarantee_body')}
            </Text>
          </BlockStack>
        </InlineLayout>
      ) : null}
      {showClinical ? (
        <InlineLayout columns={['auto', 'fill']} spacing="tight" blockAlignment="center">
          <Icon source="checkmark" appearance="subdued" size="small" />
          <Text size="small">{translate('clinical')}</Text>
        </InlineLayout>
      ) : null}
      {showTrustpilot ? (
        <InlineLayout columns={['auto', 'fill']} spacing="tight" blockAlignment="center">
          {/* Decorative: unlabeled Icons are not announced, so screen
              readers only hear the rating text next to the stars. */}
          <InlineStack spacing="none">
            {Array.from({length: 5}, (_, index) => (
              <Icon
                key={`star-${index}`}
                source={index < filledStars ? 'starFill' : 'star'}
                appearance={index < filledStars ? 'accent' : 'subdued'}
                size="small"
              />
            ))}
          </InlineStack>
          {profileUrl ? (
            <Link to={profileUrl} external>
              <Text size="small">{trustpilotLabel}</Text>
            </Link>
          ) : (
            <Text size="small">{trustpilotLabel}</Text>
          )}
        </InlineLayout>
      ) : null}
      {showHint ? (
        <InlineLayout columns={['auto', 'fill']} spacing="tight" blockAlignment="center">
          <Icon source="discount" appearance="subdued" size="small" />
          <Text size="small" appearance="subdued">
            {translate('subscription_hint', {
              percent: config.subscriptionNudge.discountPct,
            })}
          </Text>
        </InlineLayout>
      ) : null}
    </BlockStack>
  );
}
