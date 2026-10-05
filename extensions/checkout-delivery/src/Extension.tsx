import {useEffect, useMemo, useState} from 'preact/hooks';
import type {JSX} from 'preact';
import {
  computeDelivery,
  deliveryFormatDate,
  resolveDeliveryConfig,
  type DeliveryResult,
} from './delivery-engine';

/**
 * Cellexia AOV & LTV Booster — Checkout Delivery module (v6.0), migrated to
 * the Polaris web-components / global `shopify` object architecture
 * (api_version 2026-04). Business logic and behavior are unchanged from the
 * pre-migration React version — see ./delivery-engine.ts (pure,
 * framework-agnostic, untouched by this migration) for the full date-math
 * contract. This file only replaces the rendering layer, mirroring the
 * checkout-trust migration (../checkout-trust/src/Extension.tsx):
 * reactExtension/JSX-from-@shopify/ui-extensions-react ->
 * Preact + <s-*> web components + the `shopify` global's reactive
 * properties.
 *
 * ICON NOTE (same gap as checkout-trust): the new reduced icon set has no
 * exact equivalents for the old `success` and `checkmark` icon sources.
 * Mapped here to `check-circle` and `check` respectively (closest semantic
 * match) — flagged for visual review.
 *
 * COMPONENT NOTE: `Pressable` -> `<s-clickable onClick={...}>` and
 * `View` -> `<s-box>` (old `cornerRadius` prop is now `borderRadius` on
 * `s-box`; `border`/`padding` keep the same prop names).
 *
 * TEXT STYLING NOTE (same gap as checkout-trust): the old
 * `size="small" emphasis="bold"` combo can't be expressed as a single
 * `<s-text>` attribute (`type` is a single enum). Resolved as
 * `type="strong"` for titled/bold lines and `color="subdued"` (not
 * `type="small"`) for subdued body text, matching the old
 * `appearance="subdued"` intent.
 */

const DELIVERY_FORMATS = ['line', 'range', 'timeline', 'box'] as const;
type DeliveryFormat = (typeof DELIVERY_FORMATS)[number];

function isDeliveryFormat(value: unknown): value is DeliveryFormat {
  return (
    typeof value === 'string' &&
    (DELIVERY_FORMATS as readonly string[]).includes(value)
  );
}

interface DeliverySurfaceConfig {
  enabled: boolean;
  showInCheckout: boolean;
  formatCheckout: DeliveryFormat;
}

interface PreviewConfig {
  armed: boolean;
  draftFlags: Record<string, boolean>;
  draftConfig: Record<string, string>;
  tokenHash: string;
}

/** Inert preview default: disarmed, no drafts, never-matching token hash. */
const DEFAULT_PREVIEW: PreviewConfig = {
  armed: false,
  draftFlags: {},
  draftConfig: {},
  tokenHash: '',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Locates the `config` JSON metafield among the app metafield entries.
 * The namespace is declared as `$app:cellexia`; at runtime it may surface as
 * `$app:cellexia`, `cellexia` or `app--<id>--cellexia`, so we match on the
 * `cellexia` suffix as the stable part. (Same helper as checkout-trust.)
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

/**
 * Resolves the checkout-facing slice of `deliveryEstimate`. Safe defaults
 * mirror DEFAULT_SETTINGS + sanitize in app/models/settings.server.ts:
 * `enabled` must be EXPLICITLY true; `showInCheckout` missing/malformed =
 * true (surface flags default on, gated by the master switch, which ships
 * OFF); `formatCheckout` missing/invalid = "line".
 */
function resolveSurfaceConfig(
  root: Record<string, unknown> | undefined,
): DeliverySurfaceConfig {
  const section = root?.deliveryEstimate;
  const enabled = isPlainObject(section) && section.enabled === true;
  const showInCheckout = !(
    isPlainObject(section) && section.showInCheckout === false
  );
  const formatCheckout =
    isPlainObject(section) && isDeliveryFormat(section.formatCheckout)
      ? section.formatCheckout
      : 'line';
  return {enabled, showInCheckout, formatCheckout};
}

/**
 * Resolves the `preview` section from the shop metafield config. Safe
 * default: INERT. Only the SHA-256 hex digest of the preview token
 * (`tokenHash`) ever reaches the checkout; `draftConfig` (v6.0, tokenless)
 * carries draft presentation overrides like `deliveryFormatCheckout` —
 * string values only, honored ONLY behind the verified-preview gate.
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
  const draftConfig: Record<string, string> = {};
  if (isPlainObject(section.draftConfig)) {
    for (const [key, value] of Object.entries(section.draftConfig)) {
      if (typeof value === 'string') draftConfig[key] = value;
    }
  }
  return {armed, draftFlags, draftConfig, tokenHash};
}

/**
 * Evaluates `cfg.marketScopes[featureKey]` against the buyer's market.
 * Mirrors `isFeatureOnForMarket` in app/models/settings.server.ts; mode
 * "selected" + unknown market FAILS CLOSED. (Same helper as checkout-trust.)
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

/**
 * v12 per-market product exclusions against
 * `deliveryEstimate.excludedByMarket` (market handle -> product GIDs): the
 * widget hides when ANY cart line's product is listed for the buyer's
 * market. FAIL-OPEN on malformed config or unknown market — an exclusion
 * is a targeted subtraction, never a reason to hide elsewhere. (Same
 * helper as checkout-trust's excludedProductInCart in trust-logic.ts.)
 */
function excludedProductInCart(
  section: unknown,
  recordKey: string,
  marketHandle: string | undefined,
  productIds: ReadonlyArray<string>,
): boolean {
  if (!marketHandle || productIds.length === 0) return false;
  if (!isPlainObject(section)) return false;
  const record = section[recordKey];
  if (!isPlainObject(record)) return false;
  const list = record[marketHandle];
  if (!Array.isArray(list)) return false;
  for (const id of productIds) {
    if (list.includes(id)) return true;
  }
  return false;
}

/**
 * Builds the merchant-facing reason shown when a preview cart (the
 * `_cx_preview` attribute present) would otherwise see nothing here.
 * Hardcoded English on purpose: merchant tool, never buyer copy.
 */
function deliveryPreviewDiagnosis(input: {
  configFound: boolean;
  preview: PreviewConfig;
  attributeValue: string | undefined;
  featureVisible: boolean;
  /** v12: hidden because the preview cart holds an excluded product. */
  excluded: boolean;
  countryCode: string | undefined;
  computed: boolean;
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
  // v12: an exclusion-hidden widget must never read as "not enabled" —
  // name the real reason first.
  if (input.excluded) {
    return 'this cart contains a product excluded for this market (Delivery guarantee → Excluded products) — the delivery promise stays hidden';
  }
  if (!input.featureVisible) {
    return 'the delivery guarantee feature is not draft-enabled for this preview';
  }
  if (!input.countryCode) {
    return 'no shipping country yet — enter a shipping address to see the delivery estimate';
  }
  if (!input.computed) {
    return `no delivery date can be computed for ${input.countryCode} — country hidden, invalid schedule, or no qualifying delivery day in range`;
  }
  return 'the delivery estimate is hidden for an unknown reason';
}

/** Single subdued diagnostic line, prefixed so merchants can spot it. */
function PreviewDiagnostic({reason}: {reason: string}) {
  return (
    <s-text type="small" color="subdued">
      {`Cellexia preview: ${reason}`}
    </s-text>
  );
}

/**
 * Caption rendered ONLY inside the checkout editor (`shopify.extension.editor`
 * set). Hardcoded English on purpose: merchant-facing admin surface.
 */
function EditorPreviewCaption() {
  return (
    <s-text type="small" color="subdued">
      Preview — buyers see this only when the Delivery guarantee is live for
      their market and a delivery date is computable for their address.
    </s-text>
  );
}

/**
 * The "Delivery guarantee" marker with its tap-to-reveal explainer (line /
 * range / timeline formats). The box format does NOT use this component —
 * it shows the refund sentence always-visible instead (see below).
 */
function GuaranteeMarker({
  label,
  explainer,
}: {
  label: string;
  explainer: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <s-stack direction="block" gap="small-100">
      <s-clickable onClick={() => setOpen((value) => !value)}>
        <s-stack direction="inline" gap="small-100" alignItems="center">
          {/* ICON NOTE: `success` has no exact new-set equivalent — mapped
              to `check-circle` (closest match), see file header. */}
          <s-icon type="check-circle" tone="neutral" size="small" />
          <s-text type="small" color="subdued">
            {label}
          </s-text>
        </s-stack>
      </s-clickable>
      {open ? (
        <s-text type="small" color="subdued">
          {explainer}
        </s-text>
      ) : null}
    </s-stack>
  );
}

export function Extension(): JSX.Element | null {
  const translate = shopify.i18n.translate;
  const metafieldEntries = shopify.appMetafields.value;
  const market = shopify.localization.market.value;
  const shippingAddress = shopify.shippingAddress?.value;
  // v12 exclusions read the cart lines — product ids arrive as full GIDs
  // ("gid://shopify/Product/<id>"), the exact form the settings store.
  const cartLines = shopify.lines.value;
  const attributes = shopify.attributes.value;
  // v6.0.1: the CHECKOUT's own localization language (reactive isoCode like
  // "fr" / "pt-PT" / "fr-CA"), the checkout twin of the storefront's
  // request.locale.iso_code pageLocale. NOT the checkout i18n date
  // formatter: the DATE_STYLE spec needs per-base-language STRUCTURE
  // control (the ja special case + verbatim-locale rule) and byte-equality
  // with v601-date-fixtures.json, so the pure engine formatter calls Intl
  // directly with this locale.
  const language = shopify.localization.language.value;

  // CHECKOUT EDITOR detection (v4.9 lesson): extensions rendering null when
  // disabled are UNPLACEABLE in the checkout editor — inside the editor
  // this module always renders a representative preview, strictly behind
  // `inEditor`, so live render paths are byte-identical.
  const editor = shopify.extension.editor;
  const inEditor = Boolean(editor);

  const configRoot = useMemo(
    () => parseCellexiaConfig(metafieldEntries),
    [metafieldEntries],
  );
  const config = useMemo(() => resolveSurfaceConfig(configRoot), [configRoot]);
  const marketHandle = market?.handle;
  const allowedInMarket = isAllowedInMarket(
    configRoot,
    'delivery_estimate',
    marketHandle,
  );

  function attributeValue(key: string): string | undefined {
    return attributes.find((attribute) => attribute.key === key)?.value;
  }

  // Verified-preview gate: plain string equality between the `_cx_preview`
  // cart attribute (SHA-256 hex of the token, computed server-side) and the
  // metafield's preview.tokenHash — the checkout-trust contract exactly.
  const preview = useMemo(() => resolvePreview(configRoot), [configRoot]);
  const previewAttributeValue = attributeValue('_cx_preview');
  const usStateAttributeValue = attributeValue('_cx_us_state');
  const previewActive =
    preview.armed === true &&
    preview.tokenHash.length > 0 &&
    previewAttributeValue === preview.tokenHash;
  const draftEnabled =
    previewActive && preview.draftFlags.delivery_estimate === true;

  // v12 per-market product exclusions: a cart line whose product is listed
  // for the buyer's market hides the widget — draft grants included (the
  // merchant preview shows the truth; the diagnosis names the reason).
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
  const deliveryExcluded = excludedProductInCart(
    configRoot?.deliveryEstimate,
    'excludedByMarket',
    marketHandle,
    cartProductIds,
  );

  // showInCheckout stays authoritative even for the armed draft preview,
  // matching the cart surface's draft-gating convention (showInCart gates
  // every cart draft path).
  const featureVisible =
    ((config.enabled && config.showInCheckout && allowedInMarket) ||
      (draftEnabled && config.showInCheckout)) &&
    !deliveryExcluded;

  // Surface format: live formatCheckout, overridden by the verified
  // preview's draft format when valid (never for real buyers — previewActive
  // is unreachable without the merchant's hashed cart attribute).
  const draftFormat = previewActive
    ? preview.draftConfig.deliveryFormatCheckout
    : undefined;
  const format: DeliveryFormat = isDeliveryFormat(draftFormat)
    ? draftFormat
    : config.formatCheckout;

  // Buyer country comes ONLY from the shipping address — undefined means
  // "not entered yet" and the widget stays hidden (never guess a country).
  // v10: the US state fails OPEN in the engine — an absent/unknown
  // provinceCode on a US order means the US-wide promise, never hidden.
  // v13: until the typed address carries a provinceCode, a US promise may
  // seed from the `_cx_us_state` cart attribute — the buyer's EXPLICIT
  // "Deliver to" choice mirrored by the storefront selector (never a geo
  // guess, so the never-guess rule holds). The typed address always wins
  // and non-US destinations ignore the attribute. Same contract as
  // checkout-trust.
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

  // Re-run the whole computation every 30s (the storefront widget's tick
  // interval): crossing the warehouse cutoff mid-checkout shifts every
  // date, and a stale "guaranteed by" promise is worse than none.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const result: DeliveryResult | null = useMemo(() => {
    if (!countryCode) return null;
    const dc = resolveDeliveryConfig(configRoot, countryCode, provinceCode);
    if (!dc) return null;
    return computeDelivery(dc, now);
  }, [configRoot, countryCode, provinceCode, now]);

  // Preview diagnostics: only reachable when the merchant's preview cart
  // attribute is present — real buyers never carry it.
  const previewAttributePresent =
    typeof previewAttributeValue === 'string' && previewAttributeValue.length > 0;
  const previewDiagnosis =
    previewAttributePresent && (!featureVisible || result === null)
      ? deliveryPreviewDiagnosis({
          configFound: configRoot !== undefined,
          preview,
          attributeValue: previewAttributeValue,
          featureVisible,
          excluded: deliveryExcluded,
          countryCode,
          computed: result !== null,
        })
      : undefined;

  // Editor mode never bails out: it falls through to the representative
  // preview below (sample dates when real ones are not computable).
  if ((!featureVisible || result === null) && !inEditor) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  // Representative sample for the editor when nothing real is computable:
  // dispatch today, delivered in 3–5 days (calendar stamps only — the
  // sample renders exclusively inside the checkout editor).
  const effective: DeliveryResult = result ?? {
    dispatch: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    min:
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) +
      3 * 86400000,
    max:
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) +
      5 * 86400000,
  };

  // v6.0.1 page-language date labels, matching the storefront convention
  // exactly: the shared DATE_STYLE spec (ja special case, verbatim-locale
  // rule, long-form default, short-form fallback chain, local-noon rebuild)
  // lives in the PURE engine module so the sim asserts fixture conformance.
  function dateLabel(ut: number): string {
    return deliveryFormatDate(ut, language.isoCode);
  }

  const shipLabel = dateLabel(effective.dispatch);
  const minLabel = dateLabel(effective.min);
  const maxLabel = dateLabel(effective.max);
  // Fail closed on any unformatted date — never show a half-filled promise.
  if (!shipLabel || !minLabel || !maxLabel) {
    if (inEditor) return <EditorPreviewCaption />;
    // This bail is only reachable with featureVisible true AND a computed
    // result, so previewDiagnosis (computed for the opposite states) is
    // always undefined here — a preview cart deserves its own reason
    // instead of silent nothing (v12 review catch; pre-existing gap).
    if (previewAttributePresent) {
      return (
        <PreviewDiagnostic reason="a delivery date was computed but could not be formatted for this language — the widget fails closed" />
      );
    }
    return null;
  }

  const badgeLabel = translate('badge');
  const tooltipText = translate('tooltip', {date: maxLabel});

  let body: JSX.Element;
  if (format === 'range') {
    const rangeText =
      effective.min === effective.max
        ? translate('range_same', {date: maxLabel})
        : translate('range', {from: minLabel, to: maxLabel});
    body = (
      <s-stack direction="block" gap="small-100">
        <s-text type="small">{rangeText}</s-text>
        <GuaranteeMarker label={badgeLabel} explainer={tooltipText} />
      </s-stack>
    );
  } else if (format === 'timeline') {
    body = (
      <s-stack direction="block" gap="small-100">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {/* ICON NOTE: `checkmark` has no exact new-set equivalent —
              mapped to `check` (closest match), see file header. */}
          <s-icon type="check" tone="neutral" size="small" />
          <s-text type="small">{translate('timeline_order')}</s-text>
        </s-stack>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-icon type="check" tone="neutral" size="small" />
          <s-text type="small">{translate('timeline_ship', {date: shipLabel})}</s-text>
        </s-stack>
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-icon type="check" tone="neutral" size="small" />
          <s-text type="strong">
            {translate('timeline_delivered', {date: maxLabel})}
          </s-text>
        </s-stack>
        <GuaranteeMarker label={badgeLabel} explainer={tooltipText} />
      </s-stack>
    );
  } else if (format === 'box') {
    // Guarantee box: subtle border, bold title, ALWAYS-VISIBLE refund
    // sentence (box_sub) — the explainer is the format's whole point, so it
    // is never hidden behind a tap here.
    body = (
      <s-box border="base" borderRadius="base" padding="base">
        <s-stack direction="block" gap="small-100">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            {/* ICON NOTE: old `appearance="accent"` has no `s-icon`
                equivalent — `auto` is the closest theme-following tone,
                same mapping as checkout-trust's Trustpilot stars. */}
            <s-icon type="check-circle" tone="auto" size="small" />
            <s-text type="strong">
              {translate('box_title', {date: maxLabel})}
            </s-text>
          </s-stack>
          <s-text type="small" color="subdued">
            {translate('box_sub')}
          </s-text>
          <s-stack direction="inline" gap="small-100" alignItems="center">
            <s-icon type="check-circle" tone="neutral" size="small" />
            <s-text type="small" color="subdued">
              {badgeLabel}
            </s-text>
          </s-stack>
        </s-stack>
      </s-box>
    );
  } else {
    // "line" — the default single-line format.
    body = (
      <s-stack direction="block" gap="small-100">
        <s-text type="small">{translate('line', {date: maxLabel})}</s-text>
        <GuaranteeMarker label={badgeLabel} explainer={tooltipText} />
      </s-stack>
    );
  }

  return (
    <s-stack direction="block" gap="small-100">
      {body}
      {inEditor ? <EditorPreviewCaption /> : null}
    </s-stack>
  );
}
