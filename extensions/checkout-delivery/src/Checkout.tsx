import {useEffect, useMemo, useState} from 'react';
import {
  BlockStack,
  Icon,
  InlineLayout,
  Pressable,
  Text,
  View,
  reactExtension,
  useApi,
  useAppMetafields,
  useAttributeValues,
  useLocalizationMarket,
  useShippingAddress,
  useTranslate,
} from '@shopify/ui-extensions-react/checkout';
import {
  computeDelivery,
  resolveDeliveryConfig,
  type DeliveryResult,
} from './delivery-engine';

/**
 * Cellexia AOV & LTV Booster — Checkout Delivery module (v6.0).
 *
 * Checkout surface of the ONE delivery_estimate feature ("Delivery
 * guarantee"): the same date engine as the v5.9.1 storefront widget (see
 * src/delivery-engine.ts — the pure twin of cellexia-pdp.js), the same
 * translated strings (this extension's locale files MATCH the theme
 * extension's "delivery" group per language), rendered with native checkout
 * UI components in the merchant's chosen `formatCheckout` (line | range |
 * timeline | box). Two placements: statically under the shipping-option
 * list, or as a freely placeable block — the merchant picks in the editor.
 *
 * SAFE BY DEFAULT / FAIL CLOSED: renders nothing unless
 * `deliveryEstimate.enabled === true` AND `showInCheckout !== false` AND the
 * market gate passes (`marketScopes.delivery_estimate`, unknown market +
 * "selected" = hidden), OR the feature is draft-granted inside a VERIFIED
 * preview (`preview.draftFlags.delivery_estimate === true`). The buyer
 * country comes ONLY from the shipping address — no address yet means no
 * widget (we never guess a country), and any invalid config / uncomputable
 * date renders nothing.
 *
 * GUARANTEE EXPLAINER — checkout has no hover tooltips, so instead of the
 * storefront's badge tooltip:
 *  - box format: the refund-or-replace sentence (`box_sub`) is an
 *    ALWAYS-VISIBLE subdued line inside the box (it is the widget's whole
 *    point there — hiding it behind a tap would gut the format);
 *  - line / range / timeline: a Pressable "Delivery guarantee" marker
 *    toggles the subdued explainer line (`tooltip`) underneath. Pressable
 *    was chosen over Disclosure because it renders plain button semantics
 *    (keyboard + screen-reader accessible via the visible text) with none
 *    of Disclosure's view-id plumbing — the most native, quiet fit.
 *
 * PREVIEW (same contract as checkout-trust): `_cx_preview` cart attribute
 * vs `preview.tokenHash`, plain string equality. When verified, the ARMED
 * payload's tokenless `preview.draftConfig.deliveryFormatCheckout` (when
 * valid) overrides the live format so the merchant can preview a draft
 * format without touching live buyers. Preview diagnostics render one
 * subdued line when the attribute is present and the module would
 * otherwise show nothing. In the checkout editor a representative preview
 * always renders (sample dates when real ones are not computable).
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
 * Builds the merchant-facing reason shown when a preview cart (the
 * `_cx_preview` attribute present) would otherwise see nothing here.
 * Hardcoded English on purpose: merchant tool, never buyer copy.
 */
function deliveryPreviewDiagnosis(input: {
  configFound: boolean;
  preview: PreviewConfig;
  attributeValue: string | undefined;
  featureVisible: boolean;
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
    <Text size="small" appearance="subdued">
      {`Cellexia preview: ${reason}`}
    </Text>
  );
}

/**
 * Caption rendered ONLY inside the checkout editor (`extension.editor`
 * set). Hardcoded English on purpose: merchant-facing admin surface.
 */
function EditorPreviewCaption() {
  return (
    <Text size="small" appearance="subdued">
      Preview — buyers see this only when the Delivery guarantee is live for
      their market and a delivery date is computable for their address.
    </Text>
  );
}

export default reactExtension(
  'purchase.checkout.shipping-option-list.render-after',
  () => <Extension />,
);

/**
 * Second placement: the SAME UI as a freely placeable block — the merchant
 * picks either placement in the checkout editor. `reactExtension` registers
 * the target as a call-time side effect, matching the second
 * `[[extensions.targeting]]` entry in shopify.extension.toml (which
 * declares the target but renders nothing without this module-level
 * registration). Mirrors checkout-trust's pattern.
 */
export const checkoutBlockRender = reactExtension(
  'purchase.checkout.block.render',
  () => <Extension />,
);

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
    <BlockStack spacing="extraTight">
      <Pressable onPress={() => setOpen((value) => !value)}>
        <InlineLayout
          columns={['auto', 'fill']}
          spacing="extraTight"
          blockAlignment="center"
        >
          <Icon source="success" appearance="subdued" size="small" />
          <Text size="small" appearance="subdued">
            {label}
          </Text>
        </InlineLayout>
      </Pressable>
      {open ? (
        <Text size="small" appearance="subdued">
          {explainer}
        </Text>
      ) : null}
    </BlockStack>
  );
}

function Extension() {
  const translate = useTranslate();
  const {i18n, extension} = useApi();
  const metafieldEntries = useAppMetafields();
  const market = useLocalizationMarket();
  const shippingAddress = useShippingAddress();

  // CHECKOUT EDITOR detection (v4.9 lesson): extensions rendering null when
  // disabled are UNPLACEABLE in the checkout editor — inside the editor
  // this module always renders a representative preview, strictly behind
  // `inEditor`, so live render paths are byte-identical.
  const inEditor = Boolean(extension.editor);

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

  // Verified-preview gate: plain string equality between the `_cx_preview`
  // cart attribute (SHA-256 hex of the token, computed server-side) and the
  // metafield's preview.tokenHash — the checkout-trust contract exactly.
  const preview = useMemo(() => resolvePreview(configRoot), [configRoot]);
  const [previewAttributeValue] = useAttributeValues(['_cx_preview']);
  const previewActive =
    preview.armed === true &&
    preview.tokenHash.length > 0 &&
    previewAttributeValue === preview.tokenHash;
  const draftEnabled =
    previewActive && preview.draftFlags.delivery_estimate === true;

  // showInCheckout stays authoritative even for the armed draft preview,
  // matching the cart surface's draft-gating convention (showInCart gates
  // every cart draft path).
  const featureVisible =
    (config.enabled && config.showInCheckout && allowedInMarket) ||
    (draftEnabled && config.showInCheckout);

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
  const countryCode = shippingAddress?.countryCode;

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
    const dc = resolveDeliveryConfig(configRoot, countryCode);
    if (!dc) return null;
    return computeDelivery(dc, now);
  }, [configRoot, countryCode, now]);

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

  // Buyer-locale date labels, matching the storefront convention exactly:
  // weekday short, day numeric, month short. The UTC calendar stamp is
  // rebuilt as a LOCAL noon Date so formatting can never shift the day.
  function dateLabel(ut: number): string {
    try {
      const d = new Date(ut);
      const localNoon = new Date(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        12,
      );
      const options: Intl.DateTimeFormatOptions = {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      };
      try {
        const label = i18n.formatDate(localNoon, options);
        if (typeof label === 'string' && label) return label;
      } catch {
        // fall through to toLocaleDateString
      }
      const fallback = localNoon.toLocaleDateString(undefined, options);
      return typeof fallback === 'string' ? fallback : '';
    } catch {
      return '';
    }
  }

  const shipLabel = dateLabel(effective.dispatch);
  const minLabel = dateLabel(effective.min);
  const maxLabel = dateLabel(effective.max);
  // Fail closed on any unformatted date — never show a half-filled promise.
  if (!shipLabel || !minLabel || !maxLabel) {
    if (inEditor) return <EditorPreviewCaption />;
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  const badgeLabel = translate('badge');
  const tooltipText = translate('tooltip', {date: maxLabel});

  let body;
  if (format === 'range') {
    const rangeText =
      effective.min === effective.max
        ? translate('range_same', {date: maxLabel})
        : translate('range', {from: minLabel, to: maxLabel});
    body = (
      <BlockStack spacing="extraTight">
        <Text size="small">{rangeText}</Text>
        <GuaranteeMarker label={badgeLabel} explainer={tooltipText} />
      </BlockStack>
    );
  } else if (format === 'timeline') {
    body = (
      <BlockStack spacing="extraTight">
        <InlineLayout
          columns={['auto', 'fill']}
          spacing="tight"
          blockAlignment="center"
        >
          <Icon source="checkmark" appearance="subdued" size="small" />
          <Text size="small">{translate('timeline_order')}</Text>
        </InlineLayout>
        <InlineLayout
          columns={['auto', 'fill']}
          spacing="tight"
          blockAlignment="center"
        >
          <Icon source="checkmark" appearance="subdued" size="small" />
          <Text size="small">{translate('timeline_ship', {date: shipLabel})}</Text>
        </InlineLayout>
        <InlineLayout
          columns={['auto', 'fill']}
          spacing="tight"
          blockAlignment="center"
        >
          <Icon source="checkmark" appearance="subdued" size="small" />
          <Text size="small" emphasis="bold">
            {translate('timeline_delivered', {date: maxLabel})}
          </Text>
        </InlineLayout>
        <GuaranteeMarker label={badgeLabel} explainer={tooltipText} />
      </BlockStack>
    );
  } else if (format === 'box') {
    // Guarantee box: subtle border, bold title, ALWAYS-VISIBLE refund
    // sentence (box_sub) — the explainer is the format's whole point, so it
    // is never hidden behind a tap here.
    body = (
      <View border="base" cornerRadius="base" padding="base">
        <BlockStack spacing="extraTight">
          <InlineLayout
            columns={['auto', 'fill']}
            spacing="tight"
            blockAlignment="center"
          >
            <Icon source="success" appearance="accent" size="small" />
            <Text size="small" emphasis="bold">
              {translate('box_title', {date: maxLabel})}
            </Text>
          </InlineLayout>
          <Text size="small" appearance="subdued">
            {translate('box_sub')}
          </Text>
          <InlineLayout
            columns={['auto', 'fill']}
            spacing="extraTight"
            blockAlignment="center"
          >
            <Icon source="success" appearance="subdued" size="small" />
            <Text size="small" appearance="subdued">
              {badgeLabel}
            </Text>
          </InlineLayout>
        </BlockStack>
      </View>
    );
  } else {
    // "line" — the default single-line format.
    body = (
      <BlockStack spacing="extraTight">
        <Text size="small">{translate('line', {date: maxLabel})}</Text>
        <GuaranteeMarker label={badgeLabel} explainer={tooltipText} />
      </BlockStack>
    );
  }

  return (
    <BlockStack spacing="extraTight">
      {body}
      {inEditor ? <EditorPreviewCaption /> : null}
    </BlockStack>
  );
}
