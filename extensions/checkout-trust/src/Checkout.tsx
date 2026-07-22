import {useMemo} from 'react';
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
  useLocalizationMarket,
  useTranslate,
} from '@shopify/ui-extensions-react/checkout';

/**
 * Cellexia AOV & LTV Booster — Checkout Trust module.
 *
 * Pure display block: money-back guarantee, secure-checkout line, clinical
 * claim and Trustpilot rating (v5.5: the subscription-savings hint was
 * removed on merchant request). All values come from the shop metafield
 * ($app:cellexia / config); no cart mutations, no network calls.
 *
 * SAFE BY DEFAULT: a missing/unparsable config metafield, a missing
 * `checkoutTrust` section, or anything but an explicit `enabled: true`
 * renders nothing. Market targeting is enforced against the checkout's
 * localization market and FAILS CLOSED (mode "selected" + unknown market →
 * hidden): the whole module respects `marketScopes.checkout_trust`.
 *
 * PREVIEW (v5): the cart's `_cx_preview` attribute carries the SHA-256 HEX
 * digest of the preview token, computed server-side by the app — so the
 * preview gate is a plain synchronous string comparison against the
 * (non-empty) `preview.tokenHash` from the shop metafield. No SubtleCrypto
 * dependency (v4 hashed the raw token inside the extension; SubtleCrypto's
 * silent unavailability in some checkout sandboxes disabled preview
 * entirely). When the metafield carries `preview.armed: true` AND the
 * attribute equals the hash, the module additionally counts as enabled when
 * `preview.draftFlags.checkout_trust === true` — bypassing its market gate
 * for the draft grant only (the preview cart belongs to the merchant).
 * Outside preview mode every
 * gate is unchanged — all preview logic sits behind the single
 * `previewActive` boolean.
 *
 * PREVIEW DIAGNOSTICS: when `_cx_preview` is present (merchant preview
 * carts only — real buyers never carry it) and this module would otherwise
 * render nothing, it renders one subdued line explaining why. When the
 * attribute is absent, behavior is byte-identical to before: every
 * diagnostic path sits behind the attribute-present check.
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
    // Default/missing = linked — matches DEFAULT_SETTINGS.trustpilot.showLink,
    // so configs written before the flag existed behave byte-identically.
    showLink: true,
  },
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
  trustpilot: {
    rating: number;
    reviewCount: number;
    profileUrl: string;
    /** false = render the rating as plain text instead of a Link. */
    showLink: boolean;
  };
}

interface PreviewConfig {
  armed: boolean;
  draftFlags: Record<string, boolean>;
  tokenHash: string;
}

/** Inert preview default: disarmed, no draft flags, empty (never-matching) token hash. */
const DEFAULT_PREVIEW: PreviewConfig = {armed: false, draftFlags: {}, tokenHash: ''};

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
 * Builds the merchant-facing reason shown when a preview cart (the
 * `_cx_preview` attribute is present) would otherwise see nothing here.
 * Checks run in order, most fundamental first. Hardcoded English on
 * purpose: this line renders only on merchant preview carts — real buyers
 * never carry the attribute — so it is a merchant tool, not buyer copy.
 */
function trustPreviewDiagnosis(input: {
  configFound: boolean;
  preview: PreviewConfig;
  attributeValue: string | undefined;
  featureVisible: boolean;
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
  return 'all trust module elements are toggled off';
}

/** Single subdued diagnostic line, prefixed so merchants can spot it. */
function PreviewDiagnostic({reason}: {reason: string}) {
  return (
    <Text size="small" appearance="subdued">
      {`Cellexia preview: ${reason}`}
    </Text>
  );
}

/**
 * Caption rendered ONLY inside the checkout editor (`extension.editor` set),
 * under the editor preview of this module. Hardcoded English on purpose:
 * the checkout editor is a merchant-facing admin surface, not buyer copy.
 */
function EditorPreviewCaption() {
  return (
    <Text size="small" appearance="subdued">
      Preview — buyers see this only when the feature is live for their market.
    </Text>
  );
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

/**
 * Second placement: the SAME UI statically anchored immediately before the
 * actions (Pay button) area — the merchant picks either placement in the
 * checkout editor. `reactExtension` registers the target as a call-time
 * side effect (`shopify.extend`), matching the second
 * `[[extensions.targeting]]` entry in shopify.extension.toml (which
 * declares the target but renders nothing without this module-level
 * registration); target name verified against RenderExtensionTargets in
 * @shopify/ui-extensions. Mirrors checkout-upsell's pattern.
 */
export const checkoutActionsRenderBefore = reactExtension(
  'purchase.checkout.actions.render-before',
  () => <Extension />,
);

function Extension() {
  const translate = useTranslate();
  const {i18n, extension} = useApi();
  const metafieldEntries = useAppMetafields();
  const market = useLocalizationMarket();

  // CHECKOUT EDITOR detection (v4.9): `extension.editor` is `{type:
  // 'checkout'}` only while the merchant is inside the checkout editor and
  // undefined in every live checkout (verified against StandardApi in
  // @shopify/ui-extensions). In the editor this module ALWAYS renders a
  // representative preview so the merchant can see, place and move it —
  // every enabled/market/config gate is bypassed strictly behind
  // `inEditor`, so live render paths are byte-identical to before.
  const inEditor = Boolean(extension.editor);

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
  // v5 preview: the single gate for ALL preview behavior. The `_cx_preview`
  // cart attribute (set by the merchant's preview hub) carries the SHA-256
  // hex digest of the preview token, computed server-side — so the gate is
  // a plain synchronous string comparison with no SubtleCrypto dependency.
  // `useAttributeValues` yields `undefined` while the attribute is absent,
  // which can never match a non-empty hash.
  const preview = useMemo(() => resolvePreview(configRoot), [configRoot]);
  const [previewAttributeValue] = useAttributeValues(['_cx_preview']);
  const previewActive =
    preview.armed === true &&
    preview.tokenHash.length > 0 &&
    previewAttributeValue === preview.tokenHash;
  // Draft grants: in preview mode a feature counts as enabled when its draft
  // flag is explicitly true — market gating is bypassed for the draft grant
  // only (the preview cart is the merchant's own). The live paths are
  // untouched: live stays live.
  const trustDraftEnabled =
    previewActive && preview.draftFlags.checkout_trust === true;

  const trustVisible =
    (config.checkoutTrust.enabled && trustAllowedInMarket) || trustDraftEnabled;

  // Merchant preview diagnostics: `_cx_preview` present means a merchant
  // preview cart (real buyers never carry it). Precompute the reason we
  // would show if this module ends up rendering nothing; `undefined` when
  // the attribute is absent keeps every diagnostic path unreachable for
  // real checkouts (byte-identical to pre-diagnostics behavior).
  const previewAttributePresent =
    typeof previewAttributeValue === 'string' && previewAttributeValue.length > 0;
  const previewDiagnosis = previewAttributePresent
    ? trustPreviewDiagnosis({
        configFound: configRoot !== undefined,
        preview,
        attributeValue: previewAttributeValue,
        featureVisible: trustVisible,
      })
    : undefined;

  // Editor mode never bails out: it falls through to the full-module
  // preview below (all display rows forced on).
  if (!trustVisible && !inEditor) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  const {showGuarantee, showTrustpilot, showClinical, showBadges} =
    config.checkoutTrust;

  if (
    !showGuarantee &&
    !showTrustpilot &&
    !showClinical &&
    !showBadges &&
    !inEditor
  ) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  // CHECKOUT EDITOR: force every display row on so the merchant always has
  // something to place and move; values still come from the resolved
  // config (real merchant values where present, defaults otherwise — the
  // sample "4.8/5" Trustpilot fallback surfaces ONLY here, never live).
  // When `inEditor` is false each row renders exactly per its live
  // toggle, as before.
  const renderBadges = showBadges || inEditor;
  const renderGuarantee = showGuarantee || inEditor;
  const renderClinical = showClinical || inEditor;
  const renderTrustpilot = showTrustpilot || inEditor;

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
  // `showLink: false` renders the rating as plain text (undefined URL takes
  // the existing plain-Text branch below). Default/missing = linked.
  const profileUrl =
    config.trustpilot.showLink && /^https:\/\//i.test(config.trustpilot.profileUrl)
      ? config.trustpilot.profileUrl
      : undefined;

  const filledStars = Math.min(5, Math.max(0, Math.round(config.trustpilot.rating)));

  return (
    <BlockStack spacing="tight">
      {renderBadges ? (
        <InlineLayout columns={['auto', 'fill']} spacing="tight" blockAlignment="center">
          <Icon source="lock" appearance="subdued" size="small" />
          <Text size="small">{translate('secure')}</Text>
        </InlineLayout>
      ) : null}
      {renderGuarantee ? (
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
      {renderClinical ? (
        <InlineLayout columns={['auto', 'fill']} spacing="tight" blockAlignment="center">
          <Icon source="checkmark" appearance="subdued" size="small" />
          <Text size="small">{translate('clinical')}</Text>
        </InlineLayout>
      ) : null}
      {renderTrustpilot ? (
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
      {inEditor ? <EditorPreviewCaption /> : null}
    </BlockStack>
  );
}
