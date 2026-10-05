import {useEffect, useMemo, useState} from 'preact/hooks';
import type {JSX} from 'preact';
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
  trustStarShapes,
  type PreviewConfig,
  type TrustRowKey,
} from './trust-logic';

/**
 * Cellexia AOV & LTV Booster — Checkout Trust module V2 (v9), migrated to
 * the Polaris web-components / global `shopify` object architecture
 * (api_version 2026-04). Business logic and behavior are unchanged from
 * the pre-migration React version — see ./trust-logic.ts and
 * ./delivery-engine.ts (both pure, framework-agnostic, untouched by this
 * migration) for the full contract documentation. This file only replaces
 * the rendering layer: reactExtension/JSX-from-@shopify/ui-extensions-react
 * -> Preact + <s-*> web components + the `shopify` global's reactive
 * properties, per
 * https://shopify.dev/docs/apps/build/checkout/migrate-to-web-components.
 *
 * ICON NOTE: the new reduced icon set has no exact equivalents for the old
 * `success`, `orderBox` and `checkmark` icon sources. Mapped here to
 * `check-circle`, `order` and `check` respectively (closest semantic
 * match) — flagged for visual review, not a documented 1:1 rename like the
 * star icons (`starFill`/`starHalf`/`star` -> `star-filled`/`star-half`/`star`).
 *
 * TEXT STYLING NOTE: the old `<Text size="small" emphasis="bold">` (the
 * guarantee title) can't be expressed as a single `<s-text>` attribute —
 * `type` is a single enum (small OR strong, not both) in the new component.
 * Resolved here as `type="strong"` (hierarchy over size) for the guarantee
 * title, and `color="subdued"` (not `type="small"`) for the rest of the
 * module's body text, matching the old `appearance="subdued"` intent.
 */

function EditorPreviewCaption() {
  return (
    <s-text type="small" color="subdued">
      Preview — buyers see this only when the feature is live for their market.
    </s-text>
  );
}

function PreviewDiagnostic({reason}: {reason: string}) {
  return (
    <s-text type="small" color="subdued">
      {`Cellexia preview: ${reason}`}
    </s-text>
  );
}

function attributeValue(
  attributes: ReadonlyArray<{key: string; value: string}>,
  key: string,
): string | undefined {
  return attributes.find((attribute) => attribute.key === key)?.value;
}

export function Extension(): JSX.Element | null {
  const translate = shopify.i18n.translate;
  const formatNumber = shopify.i18n.formatNumber;
  const metafieldEntries = shopify.appMetafields.value;
  const market = shopify.localization.market.value;
  // v9 tracked row: the checkout's own localization language (reactive
  // isoCode like "fr" / "pt-PT") — the same source the delivery extension
  // uses. NOT the checkout i18n date formatter: the compact DATE_STYLE spec
  // needs structure control (see trustFormatDateCompact in trust-logic.ts).
  const language = shopify.localization.language.value;
  // Buyer country comes ONLY from the shipping address — undefined means
  // "not entered yet" and the tracked row stays hidden (never guess a
  // country). v10: the US state rides the SAME contract (typed
  // provinceCode only) but fails OPEN in the engine — no/unknown state on
  // a US order keeps the US-wide promise. Same contract as
  // checkout-delivery.
  const shippingAddress = shopify.shippingAddress?.value;
  // v12 exclusions read the cart lines — product ids arrive as full GIDs
  // ("gid://shopify/Product/<id>"), the exact form the settings store.
  const cartLines = shopify.lines.value;
  const attributes = shopify.attributes.value;

  // CHECKOUT EDITOR detection (v4.9): `shopify.extension.editor` is
  // `{type: 'checkout'}` only while the merchant is inside the checkout
  // editor and undefined in every live checkout. In the editor this module
  // ALWAYS renders a representative preview so the merchant can see, place
  // and move it — every enabled/market/config gate is bypassed strictly
  // behind `inEditor`, so live render paths are byte-identical to before.
  const editor = shopify.extension.editor;
  const inEditor = Boolean(editor);

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
  // `attributeValue` yields `undefined` while the attribute is absent,
  // which can never match a non-empty hash.
  const preview: PreviewConfig = useMemo(
    () => resolvePreview(configRoot),
    [configRoot],
  );
  const previewAttributeValue = attributeValue(attributes, '_cx_preview');
  const usStateAttributeValue = attributeValue(attributes, '_cx_us_state');
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
      return formatNumber(value, options);
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

  // v30.1: star glyphs follow Trustpilot's own display rule — the image
  // rounds to the NEAREST HALF star (4.8 → five FULL stars, halves drawn
  // with the star-half icon) while the label keeps the raw score. Pure and
  // sim-tested in trust-logic.ts, twinned with the storefront renderers.
  const starShapes = trustStarShapes(config.trustpilot.rating);

  // v30: filled-star color. The merchant-facing config enum stays
  // 'accent' | 'green' (unchanged — it's a stored metafield contract, not a
  // UI attribute). "accent" maps to the `s-icon` `auto` tone (the closest
  // available default/theme-following tone — `s-icon` has no literal
  // "accent" tone); "green" maps to `success`, the closest checkout UI
  // extensions allow to Trustpilot's own star green (extensions cannot use
  // arbitrary hex — exact #00b67a would need an externally hosted image, a
  // dependency this module deliberately avoids). Empty stars stay subdued
  // either way.
  const starTone =
    config.checkoutTrust.trustpilotStars === 'green' ? 'success' : 'auto';

  // v11 MERCHANT-ORDERED ROWS: rowOrder is a normalized FULL permutation of
  // the six row keys (resolveConfig guarantees it — unknown keys dropped,
  // missing keys appended), so the map below renders every row exactly once,
  // each still gated by its OWN render flag: ordering can reshuffle rows but
  // can never hide, duplicate or reveal one. A config without rowOrder gets
  // the default order = the pre-v11 hardcoded sequence (byte-identical
  // render). The editor caption stays pinned after the rows.
  const rowsByKey: Record<TrustRowKey, JSX.Element | null> = {
    badges: renderBadges ? (
      <s-stack key="badges" direction="inline" gap="small-200" alignItems="center">
        <s-icon type="lock" tone="neutral" size="small" />
        <s-text type="small" color="subdued">{translate('secure')}</s-text>
      </s-stack>
    ) : null,
    guarantee: renderGuarantee ? (
      <s-stack key="guarantee" direction="inline" gap="small-200" alignItems="start">
        {/* ICON NOTE: `success` has no exact new-set equivalent — mapped to
            `check-circle` (closest semantic match), see file header. */}
        <s-icon type="check-circle" tone="neutral" size="small" />
        <s-stack direction="block" gap="none">
          {/* v9.1: `count` drives CLDR plural selection in the locales
              whose day-word inflects (ro/ar/pl/… ship plural objects);
              {{days}} stays the interpolated number in every form. */}
          <s-text type="strong">
            {translate('guarantee_title', {
              days: config.guarantee.days,
              count: config.guarantee.days,
            })}
          </s-text>
          <s-text type="small" color="subdued">
            {translate('guarantee_body', {
              days: config.guarantee.days,
              count: config.guarantee.days,
            })}
          </s-text>
        </s-stack>
      </s-stack>
    ) : null,
    customs: renderCustoms ? (
      <s-stack key="customs" direction="inline" gap="small-200" alignItems="center">
        {/* ICON NOTE: `orderBox` has no exact new-set equivalent — mapped to
            `order` (closest match), see file header. */}
        <s-icon type="order" tone="neutral" size="small" />
        <s-text type="small" color="subdued">{translate('customs')}</s-text>
      </s-stack>
    ) : null,
    tracked: renderTracked ? (
      <s-stack key="tracked" direction="inline" gap="small-200" alignItems="center">
        <s-icon type="truck" tone="neutral" size="small" />
        <s-text type="small" color="subdued">{translate('tracked', {date: trackedDateLabel})}</s-text>
      </s-stack>
    ) : null,
    clinical: renderClinical ? (
      <s-stack key="clinical" direction="inline" gap="small-200" alignItems="center">
        {/* ICON NOTE: `checkmark` has no exact new-set equivalent — mapped
            to `check` (closest match), see file header. */}
        <s-icon type="check" tone="neutral" size="small" />
        <s-text type="small" color="subdued">{translate('clinical')}</s-text>
      </s-stack>
    ) : null,
    trustpilot: renderTrustpilot ? (
      <s-stack key="trustpilot" direction="inline" gap="small-200" alignItems="center">
        {/* Decorative: unlabeled Icons are not announced, so screen
            readers only hear the rating text next to the stars. */}
        <s-stack direction="inline" gap="none">
          {starShapes.map((shape, index) => (
            <s-icon
              key={`star-${index}`}
              type={shape === 'full' ? 'star-filled' : shape === 'half' ? 'star-half' : 'star'}
              tone={shape === 'empty' ? 'neutral' : starTone}
              size="small"
            />
          ))}
        </s-stack>
        {profileUrl ? (
          <s-link href={profileUrl} target="_blank">
            <s-text type="small" color="subdued">{trustpilotLabel}</s-text>
          </s-link>
        ) : (
          <s-text type="small" color="subdued">{trustpilotLabel}</s-text>
        )}
      </s-stack>
    ) : null,
  };

  return (
    <s-stack direction="block" gap="small-200">
      {config.checkoutTrust.rowOrder.map((rowKey) => rowsByKey[rowKey])}
      {inEditor ? <EditorPreviewCaption /> : null}
    </s-stack>
  );
}
