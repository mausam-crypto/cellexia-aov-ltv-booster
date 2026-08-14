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
  useLanguage,
  useLocalizationMarket,
  useShippingAddress,
  useTranslate,
} from '@shopify/ui-extensions-react/checkout';
import {
  computeDelivery,
  resolveDeliveryConfig,
  type DeliveryResult,
} from './delivery-engine';
import {
  excludedProductInCart,
  isAllowedInMarket,
  parseCellexiaConfig,
  resolveConfig,
  resolvePreview,
  trustFormatDateCompact,
  trustPreviewDiagnosis,
  type PreviewConfig,
  type TrustRowKey,
} from './trust-logic';
import type {ReactElement} from 'react';

/**
 * Cellexia AOV & LTV Booster — Checkout Trust module V2 (v9).
 *
 * Display block: secure-checkout line, money-back guarantee, the two v9
 * per-market rows — customs-free delivery (checkout_customs) and tracked
 * delivery with the guaranteed-by date (checkout_tracked) — plus the
 * clinical claim and Trustpilot rating. No cart mutations, no network
 * calls. All pure logic lives in ./trust-logic.ts (sim-tested); the date
 * math for the tracked row comes from ./delivery-engine.ts, the
 * BYTE-IDENTICAL twin of checkout-delivery's engine, so the tracked row
 * always promises exactly the delivery_estimate guarantee date.
 *
 * v11 ROW ORDER: the rows render in `checkoutTrust.rowOrder` (merchant-set
 * on the Checkout admin page, arrow reorder). resolveConfig normalizes the
 * order to a FULL permutation of the six row keys, so ordering can never
 * hide, duplicate or reveal a row — visibility stays with the show* flags
 * and the per-row market gates. Missing/pre-v11 config = default order =
 * the pre-v11 hardcoded sequence (byte-identical render).
 *
 * SAFE BY DEFAULT: a missing/unparsable config metafield, a missing
 * `checkoutTrust` section, or anything but an explicit `enabled: true`
 * renders nothing. Market targeting is enforced against the checkout's
 * localization market and FAILS CLOSED (mode "selected" + unknown market →
 * hidden). The module respects `marketScopes.checkout_trust`; the customs
 * and tracked ROWS additionally respect their OWN scopes
 * (`marketScopes.checkout_customs` / `marketScopes.checkout_tracked`), so
 * each can be turned on or off per market independently of the module.
 *
 * TRACKED ROW FAIL-CLOSED CHAIN: no shipping country yet, an uncomputable
 * delivery date, or an unformattable label each hide ONLY the tracked row —
 * the rest of the module renders normally. The row re-computes on a 30s
 * tick (crossing the warehouse cutoff mid-checkout shifts the date, and a
 * stale "guaranteed by" promise is worse than none).
 *
 * PREVIEW (v5 contract): the cart's `_cx_preview` attribute carries the
 * SHA-256 HEX digest of the preview token; the gate is a plain synchronous
 * string comparison against `preview.tokenHash` from the shop metafield.
 * When verified, `preview.draftFlags.checkout_trust` draft-enables the
 * module, and `checkout_customs` / `checkout_tracked` draft-enable their
 * rows (implying the module for the draft grant only — the preview cart
 * belongs to the merchant). Outside preview mode every gate is unchanged.
 *
 * PREVIEW DIAGNOSTICS: when `_cx_preview` is present (merchant preview
 * carts only — real buyers never carry it) and this module would otherwise
 * render nothing, it renders one subdued line explaining why. When the
 * attribute is absent, behavior is byte-identical to before: every
 * diagnostic path sits behind the attribute-present check.
 */

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

/** Single subdued diagnostic line, prefixed so merchants can spot it. */
function PreviewDiagnostic({reason}: {reason: string}) {
  return (
    <Text size="small" appearance="subdued">
      {`Cellexia preview: ${reason}`}
    </Text>
  );
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
  // v9 tracked row: the checkout's own localization language (reactive
  // isoCode like "fr" / "pt-PT") — the same source the delivery extension
  // uses. NOT the checkout i18n date formatter: the compact DATE_STYLE spec
  // needs structure control (see trustFormatDateCompact in trust-logic.ts).
  const language = useLanguage();
  // Buyer country comes ONLY from the shipping address — undefined means
  // "not entered yet" and the tracked row stays hidden (never guess a
  // country). v10: the US state rides the SAME contract (typed
  // provinceCode only) but fails OPEN in the engine — no/unknown state on
  // a US order keeps the US-wide promise. Same contract as
  // checkout-delivery.
  const shippingAddress = useShippingAddress();
  // v12 exclusions read the cart lines — product ids arrive as full GIDs
  // ("gid://shopify/Product/<id>"), the exact form the settings store.
  const cartLines = useCartLines();

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
  // v9 per-market row gates — each row has its own FeatureKey scope, so a
  // market can carry the customs promise without the tracked one and vice
  // versa. Same fail-closed semantics as the module gate.
  const customsAllowedInMarket = isAllowedInMarket(
    configRoot,
    'checkout_customs',
    marketHandle,
  );
  const trackedAllowedInMarket = isAllowedInMarket(
    configRoot,
    'checkout_tracked',
    marketHandle,
  );
  // v12 per-market product exclusions: a cart line whose product is listed
  // for the buyer's market hides the row (fail-open on malformed config /
  // unknown market — see excludedProductInCart in trust-logic.ts).
  const cartProductIds = useMemo(() => {
    const ids: string[] = [];
    for (const line of cartLines) {
      const id = line?.merchandise?.product?.id;
      if (typeof id === 'string' && id) ids.push(id);
      // Bundles: the top-level line carries the bundle PARENT's product —
      // an excluded product sold inside a bundle appears only in
      // lineComponents, so those are inspected too (review catch).
      for (const component of line?.lineComponents ?? []) {
        const componentId = component?.merchandise?.product?.id;
        if (typeof componentId === 'string' && componentId) {
          ids.push(componentId);
        }
      }
    }
    return ids;
  }, [cartLines]);
  const customsExcluded = excludedProductInCart(
    configRoot?.checkoutTrust,
    'customsExcludedByMarket',
    marketHandle,
    cartProductIds,
  );
  const trackedExcluded = excludedProductInCart(
    configRoot?.checkoutTrust,
    'trackedExcludedByMarket',
    marketHandle,
    cartProductIds,
  );
  // v5 preview: the single gate for ALL preview behavior. The `_cx_preview`
  // cart attribute (set by the merchant's preview hub) carries the SHA-256
  // hex digest of the preview token, computed server-side — so the gate is
  // a plain synchronous string comparison with no SubtleCrypto dependency.
  // `useAttributeValues` yields `undefined` while the attribute is absent,
  // which can never match a non-empty hash.
  const preview: PreviewConfig = useMemo(
    () => resolvePreview(configRoot),
    [configRoot],
  );
  const [previewAttributeValue, usStateAttributeValue] = useAttributeValues([
    '_cx_preview',
    '_cx_us_state',
  ]);
  const previewActive =
    preview.armed === true &&
    preview.tokenHash.length > 0 &&
    previewAttributeValue === preview.tokenHash;
  // Draft grants: in preview mode a feature counts as enabled when its draft
  // flag is explicitly true — market gating is bypassed for the draft grant
  // only (the preview cart is the merchant's own). The live paths are
  // untouched: live stays live. A row grant implies the module chrome so
  // the merchant can actually see the drafted row.
  const trustDraftEnabled =
    previewActive && preview.draftFlags.checkout_trust === true;
  const customsDraftEnabled =
    previewActive && preview.draftFlags.checkout_customs === true;
  const trackedDraftEnabled =
    previewActive && preview.draftFlags.checkout_tracked === true;

  const moduleLive = config.checkoutTrust.enabled && trustAllowedInMarket;
  const trustVisible =
    moduleLive || trustDraftEnabled || customsDraftEnabled || trackedDraftEnabled;

  const {showGuarantee, showTrustpilot, showClinical, showBadges} =
    config.checkoutTrust;

  // v9 row visibility: live = module visible AND the row's flag AND the
  // row's own market gate; a verified draft grant shows the row regardless
  // (merchant preview). The tracked row additionally needs a computable,
  // formattable date — resolved below.
  // v12: the exclusion verdict applies to draft grants too — the merchant
  // preview shows the truth, and the preview diagnosis names the reason.
  // The pre-exclusion "wanted" halves are kept as their own values so the
  // diagnosis can report ONLY a wanted-but-excluded row (an exclusion is
  // never blamed for a row that was toggled/scoped off anyway).
  const customsWantedBase =
    (trustVisible && config.checkoutTrust.showCustoms && customsAllowedInMarket) ||
    customsDraftEnabled;
  const trackedWantedBase =
    (trustVisible && config.checkoutTrust.showTracked && trackedAllowedInMarket) ||
    trackedDraftEnabled;
  const customsVisible = customsWantedBase && !customsExcluded;
  const trackedWanted = trackedWantedBase && !trackedExcluded;

  // Tracked-row delivery date: the delivery_estimate engine twin, driven by
  // the shipping-address country. Re-run every 30s (the delivery widget's
  // tick): crossing the warehouse cutoff mid-checkout shifts the date.
  // v13: until the typed address carries a provinceCode, a US promise may
  // seed from the `_cx_us_state` cart attribute — the buyer's EXPLICIT
  // "Deliver to" choice mirrored by the storefront selector (never a geo
  // guess). The typed address always wins, non-US destinations ignore the
  // attribute, and the engine stays fail-open on unknown codes. Same
  // contract as checkout-delivery.
  const countryCode = shippingAddress?.countryCode;
  const typedProvinceCode = shippingAddress?.provinceCode;
  const chosenUsState =
    typeof usStateAttributeValue === 'string' &&
    /^[A-Z]{2}$/.test(usStateAttributeValue)
      ? usStateAttributeValue
      : undefined;
  // `||`, not `??`: an EMPTY typed provinceCode ('' while the buyer is
  // mid-address) is "no typed state yet" — the chosen-state seed applies.
  const provinceCode =
    typedProvinceCode ||
    (countryCode === 'US' ? chosenUsState : undefined);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);
  const deliveryResult: DeliveryResult | null = useMemo(() => {
    if (!trackedWanted && !inEditor) return null; // never compute unused dates
    if (!countryCode) return null;
    const dc = resolveDeliveryConfig(configRoot, countryCode, provinceCode);
    if (!dc) return null;
    return computeDelivery(dc, now);
  }, [configRoot, countryCode, provinceCode, now, trackedWanted, inEditor]);

  // Representative sample for the editor when nothing real is computable:
  // guaranteed in 5 days (calendar stamps only — the sample renders
  // exclusively inside the checkout editor, mirroring checkout-delivery).
  const guaranteedUt = deliveryResult
    ? deliveryResult.max
    : inEditor
      ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) +
        5 * 86400000
      : null;
  const trackedDateLabel =
    guaranteedUt !== null
      ? trustFormatDateCompact(guaranteedUt, language.isoCode)
      : '';
  // Fail closed on any unformatted date — never show a half-filled promise.
  const trackedVisible = trackedWanted && trackedDateLabel !== '';

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
        trackedWanted,
        countryCode,
        trackedDateLabel,
        excludedRows:
          (customsWantedBase && customsExcluded) ||
          (trackedWantedBase && trackedExcluded),
      })
    : undefined;

  // Editor mode never bails out: it falls through to the full-module
  // preview below (all display rows forced on).
  if (!trustVisible && !inEditor) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  if (
    !showGuarantee &&
    !showTrustpilot &&
    !showClinical &&
    !showBadges &&
    !customsVisible &&
    !trackedVisible &&
    !inEditor
  ) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  // CHECKOUT EDITOR: force every display row on so the merchant always has
  // something to place and move; values still come from the resolved
  // config (real merchant values where present, defaults otherwise — the
  // sample "4.8/5" Trustpilot fallback and the sample tracked date surface
  // ONLY here, never live). When `inEditor` is false each row renders
  // exactly per its live toggle, as before.
  const renderBadges = showBadges || inEditor;
  const renderGuarantee = showGuarantee || inEditor;
  const renderCustoms = customsVisible || inEditor;
  const renderTracked =
    trackedVisible || (inEditor && trackedDateLabel !== '');
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

  // v11 MERCHANT-ORDERED ROWS: rowOrder is a normalized FULL permutation of
  // the six row keys (resolveConfig guarantees it — unknown keys dropped,
  // missing keys appended), so the map below renders every row exactly once,
  // each still gated by its OWN render flag: ordering can reshuffle rows but
  // can never hide, duplicate or reveal one. A config without rowOrder gets
  // the default order = the pre-v11 hardcoded sequence (byte-identical
  // render). The editor caption stays pinned after the rows.
  const rowsByKey: Record<TrustRowKey, ReactElement | null> = {
    badges: renderBadges ? (
      <InlineLayout key="badges" columns={['auto', 'fill']} spacing="tight" blockAlignment="center">
        <Icon source="lock" appearance="subdued" size="small" />
        <Text size="small">{translate('secure')}</Text>
      </InlineLayout>
    ) : null,
    guarantee: renderGuarantee ? (
      <InlineLayout key="guarantee" columns={['auto', 'fill']} spacing="tight" blockAlignment="start">
        <Icon source="success" appearance="subdued" size="small" />
        <BlockStack spacing="none">
          {/* v9.1: `count` drives CLDR plural selection in the locales
              whose day-word inflects (ro/ar/pl/… ship plural objects);
              {{days}} stays the interpolated number in every form. */}
          <Text size="small" emphasis="bold">
            {translate('guarantee_title', {
              days: config.guarantee.days,
              count: config.guarantee.days,
            })}
          </Text>
          <Text size="small" appearance="subdued">
            {translate('guarantee_body', {
              days: config.guarantee.days,
              count: config.guarantee.days,
            })}
          </Text>
        </BlockStack>
      </InlineLayout>
    ) : null,
    customs: renderCustoms ? (
      <InlineLayout key="customs" columns={['auto', 'fill']} spacing="tight" blockAlignment="center">
        <Icon source="orderBox" appearance="subdued" size="small" />
        <Text size="small">{translate('customs')}</Text>
      </InlineLayout>
    ) : null,
    tracked: renderTracked ? (
      <InlineLayout key="tracked" columns={['auto', 'fill']} spacing="tight" blockAlignment="center">
        <Icon source="truck" appearance="subdued" size="small" />
        <Text size="small">{translate('tracked', {date: trackedDateLabel})}</Text>
      </InlineLayout>
    ) : null,
    clinical: renderClinical ? (
      <InlineLayout key="clinical" columns={['auto', 'fill']} spacing="tight" blockAlignment="center">
        <Icon source="checkmark" appearance="subdued" size="small" />
        <Text size="small">{translate('clinical')}</Text>
      </InlineLayout>
    ) : null,
    trustpilot: renderTrustpilot ? (
      <InlineLayout key="trustpilot" columns={['auto', 'fill']} spacing="tight" blockAlignment="center">
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
    ) : null,
  };

  return (
    <BlockStack spacing="tight">
      {config.checkoutTrust.rowOrder.map((rowKey) => rowsByKey[rowKey])}
      {inEditor ? <EditorPreviewCaption /> : null}
    </BlockStack>
  );
}
