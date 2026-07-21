import {useEffect, useMemo, useRef, useState} from 'react';
import {
  BlockStack,
  Checkbox,
  Icon,
  InlineLayout,
  InlineStack,
  SkeletonText,
  Text,
  View,
  reactExtension,
  useApi,
  useAppMetafields,
  useApplyCartLinesChange,
  useAttributeValues,
  useCartLines,
  useLocalizationCountry,
  useLocalizationMarket,
  useStorage,
  useTranslate,
} from '@shopify/ui-extensions-react/checkout';

/**
 * Cellexia AOV & LTV Booster — Checkout Order Protection.
 *
 * Reads `checkoutProtection` from the shop metafield ($app:cellexia / config),
 * loads the protection variant's price via the Storefront API and renders a
 * bordered opt-in card. Checking the box adds the protection variant to the
 * cart (with a `_cellexia_protection` line attribute); unchecking removes it.
 * With `defaultOn`, the protection line is auto-added once per checkout —
 * tracked in extension storage so it survives page reloads — and never
 * re-added after the buyer removes it manually.
 *
 * SAFE BY DEFAULT: a missing/unparsable config metafield, a missing
 * `checkoutProtection` section, or anything but an explicit `enabled: true`
 * renders nothing. Market targeting (`marketScopes.checkout_protection`) is
 * enforced against the checkout's localization market and FAILS CLOSED: with
 * mode "selected", an unknown market never sees the offer and the `defaultOn`
 * auto-add never runs. The single exception: when a protection line is
 * ALREADY in the cart (recognized primarily by its `_cellexia_protection`
 * line attribute, with a variantId match as fallback), the card stays
 * visible so the buyer can remove it — regardless of the enabled flag, the
 * configured variantId or the market scope. Removal-only: no variant fetch,
 * it can never (re-)offer or auto-add, and it disappears once the line is
 * gone.
 *
 * PREVIEW (v5): the cart's `_cx_preview` attribute carries the SHA-256 HEX
 * digest of the preview token, computed server-side by the app — so the
 * preview gate is a plain synchronous string comparison against the
 * (non-empty) `preview.tokenHash` from the shop metafield. No SubtleCrypto
 * dependency (v4 hashed the raw token inside the extension; SubtleCrypto's
 * silent unavailability in some checkout sandboxes disabled preview
 * entirely). When the metafield carries `preview.armed: true` AND the
 * attribute equals the hash, the offer additionally counts as enabled when
 * `preview.draftFlags.checkout_protection === true`, bypassing market
 * gating for that draft grant only (the preview cart belongs to the
 * merchant). The `defaultOn` auto-add is SUPPRESSED entirely in preview
 * mode — a preview cart is never auto-mutated; the manual toggle still
 * works. Outside preview mode every gate is unchanged — all preview logic
 * sits behind the single `previewActive` boolean.
 *
 * PREVIEW DIAGNOSTICS: when `_cx_preview` is present (merchant preview
 * carts only — real buyers never carry it) and this block would otherwise
 * render nothing, it renders one subdued line explaining why. When the
 * attribute is absent, behavior is byte-identical to before: every
 * diagnostic path sits behind the attribute-present check.
 */

/** Mirrors DEFAULT_SETTINGS.checkoutProtection in app/models/settings.server.ts. */
const DEFAULT_CONFIG: CheckoutProtectionConfig = {
  enabled: false,
  variantId: '',
  defaultOn: false,
};

/**
 * Extension-storage key recording the defaultOn auto-add outcome for this
 * checkout: 'auto_added' once the auto-add ran, 'removed' once the buyer
 * manually removed protection. Any stored value blocks further auto-adds.
 */
const PROTECTION_STATE_KEY = 'cellexia_protection_state';

const VARIANT_QUERY = /* GraphQL */ `
  query CellexiaProtectionVariant($id: ID!, $country: CountryCode)
  @inContext(country: $country) {
    node(id: $id) {
      ... on ProductVariant {
        id
        availableForSale
        price {
          amount
          currencyCode
        }
      }
    }
  }
`;

interface CheckoutProtectionConfig {
  enabled: boolean;
  variantId: string;
  defaultOn: boolean;
}

interface PreviewConfig {
  armed: boolean;
  draftFlags: Record<string, boolean>;
  tokenHash: string;
}

/** Inert preview default: disarmed, no draft flags, empty (never-matching) token hash. */
const DEFAULT_PREVIEW: PreviewConfig = {armed: false, draftFlags: {}, tokenHash: ''};

interface ProtectionVariant {
  id: string;
  availableForSale: boolean;
  price: {amount: string; currencyCode: string};
}

interface VariantQueryData {
  node?: Partial<ProtectionVariant> | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function resolveConfig(
  root: Record<string, unknown> | undefined,
): CheckoutProtectionConfig {
  if (!root || !isPlainObject(root.checkoutProtection)) return DEFAULT_CONFIG;
  const section = root.checkoutProtection;
  // Safe default: the feature is ON only when the metafield explicitly says
  // `enabled: true`. Missing, malformed or falsy values all mean OFF.
  const enabled = section.enabled === true;
  const variantId =
    typeof section.variantId === 'string' && section.variantId.startsWith('gid://')
      ? section.variantId
      : DEFAULT_CONFIG.variantId;
  // Same explicit-true rule for the auto-add flag: never pre-select the
  // protection line unless the metafield explicitly opted in.
  const defaultOn = section.defaultOn === true;
  return {enabled, variantId, defaultOn};
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
function protectionPreviewDiagnosis(input: {
  configFound: boolean;
  preview: PreviewConfig;
  attributeValue: string | undefined;
  featureVisible: boolean;
  hasVariantId: boolean;
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
    return 'the order protection feature is not draft-enabled for this preview';
  }
  if (!input.hasVariantId) {
    return 'the Order Protection product has not been created — use the Checkout features page';
  }
  // Only remaining nothing-to-show path: the configured variant could not
  // be loaded or is not available for sale.
  return 'the Order Protection product is unavailable or could not be loaded — check the Checkout features page';
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

function isProtectionVariant(
  node: Partial<ProtectionVariant> | null | undefined,
): node is ProtectionVariant {
  return Boolean(
    node &&
      typeof node.id === 'string' &&
      node.id.length > 0 &&
      typeof node.availableForSale === 'boolean' &&
      node.price &&
      typeof node.price.amount === 'string' &&
      typeof node.price.currencyCode === 'string',
  );
}

export default reactExtension('purchase.checkout.block.render', () => <Extension />);

function Extension() {
  const translate = useTranslate();
  const {i18n, query} = useApi();
  const metafieldEntries = useAppMetafields();
  const cartLines = useCartLines();
  const applyCartLinesChange = useApplyCartLinesChange();
  const storage = useStorage();
  const country = useLocalizationCountry();
  const countryCode = country?.isoCode;
  const market = useLocalizationMarket();

  const configRoot = useMemo(
    () => parseCellexiaConfig(metafieldEntries),
    [metafieldEntries],
  );
  const config = useMemo(() => resolveConfig(configRoot), [configRoot]);
  const marketAllowed = isAllowedInMarket(
    configRoot,
    'checkout_protection',
    market?.handle,
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
  // Draft grant: in preview mode the offer counts as enabled when its draft
  // flag is explicitly true — market gating is bypassed for the draft grant
  // only (the preview cart is the merchant's own). The live path is
  // untouched: live stays live. The defaultOn auto-add is handled
  // separately: it is suppressed whenever previewActive is true.
  const draftEnabled =
    previewActive && preview.draftFlags.checkout_protection === true;
  const featureVisible = (config.enabled && marketAllowed) || draftEnabled;

  // Merchant preview diagnostics: `_cx_preview` present means a merchant
  // preview cart (real buyers never carry it). Precompute the reason we
  // would show if this block ends up rendering nothing; `undefined` when
  // the attribute is absent keeps every diagnostic path unreachable for
  // real checkouts (byte-identical to pre-diagnostics behavior).
  const previewAttributePresent =
    typeof previewAttributeValue === 'string' && previewAttributeValue.length > 0;
  const previewDiagnosis = previewAttributePresent
    ? protectionPreviewDiagnosis({
        configFound: configRoot !== undefined,
        preview,
        attributeValue: previewAttributeValue,
        featureVisible,
        hasVariantId: config.variantId.length > 0,
      })
    : undefined;

  const [variant, setVariant] = useState<ProtectionVariant | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(
    featureVisible && config.variantId.length > 0,
  );
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | undefined>(undefined);

  /** True once the defaultOn auto-add flow has started this session. */
  const autoAddStartedRef = useRef(false);
  /** Prevents overlapping cart mutations (busy state updates async). */
  const mutationInFlightRef = useRef(false);

  useEffect(() => {
    if (!featureVisible || !config.variantId) {
      setVariant(undefined);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    query<VariantQueryData>(VARIANT_QUERY, {
      // `@inContext` localizes the price to the buyer's market; omit the
      // variable entirely while the checkout country is still unknown.
      variables: countryCode
        ? {id: config.variantId, country: countryCode}
        : {id: config.variantId},
    })
      .then((result) => {
        if (cancelled) return;
        const node = result?.data?.node;
        setVariant(isProtectionVariant(node) ? node : undefined);
      })
      .catch(() => {
        if (!cancelled) setVariant(undefined);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.enabled, marketAllowed, draftEnabled, config.variantId, countryCode, query]);

  const protectionLine = useMemo(
    () =>
      // PRIMARY: the `_cellexia_protection` line attribute set on add — it
      // survives the feature being disabled or the configured variant
      // changing. FALLBACK: a variantId match, for lines added before the
      // attribute existed.
      cartLines.find((line) =>
        line?.attributes?.some((attr) => attr?.key === '_cellexia_protection'),
      ) ??
      (config.variantId
        ? cartLines.find((line) => line?.merchandise?.id === config.variantId)
        : undefined) ??
      undefined,
    [cartLines, config.variantId],
  );
  const isProtected = Boolean(protectionLine);

  /**
   * All gates for OFFERING protection; removal ignores every one of them.
   * `featureVisible` is the v3 live gate (enabled && marketAllowed) OR the
   * v4 preview draft grant — so in preview mode the merchant can manually
   * toggle protection on even before going live.
   */
  const offerAllowed = featureVisible && config.variantId.length > 0;

  async function changeProtection(next: boolean): Promise<void> {
    // Defense in depth: adding protection is never allowed when any offer
    // gate fails — disabled feature, missing variant or failing market
    // scope (removal always is, so buyers can undo an existing line).
    if (next && !offerAllowed) return;
    if (mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setBusy(true);
    setErrorText(undefined);
    try {
      if (next) {
        if (!protectionLine) {
          const result = await applyCartLinesChange({
            type: 'addCartLine',
            merchandiseId: config.variantId,
            quantity: 1,
            attributes: [{key: '_cellexia_protection', value: '1'}],
          });
          if (result.type === 'error') setErrorText(translate('error'));
        }
      } else if (protectionLine) {
        const result = await applyCartLinesChange({
          type: 'removeCartLine',
          id: protectionLine.id,
          quantity: protectionLine.quantity,
        });
        if (result.type === 'error') setErrorText(translate('error'));
      }
    } catch {
      setErrorText(translate('error'));
    } finally {
      mutationInFlightRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    // v4 preview gate FIRST: a preview cart is NEVER auto-mutated — the
    // defaultOn auto-add is suppressed entirely while previewing (the
    // manual toggle still works). Live carts are unaffected: previewActive
    // requires the exact preview-token attribute match.
    if (previewActive) return;
    // Market gate next and fail closed: never auto-add when the scope check
    // fails or the market is unknown under mode "selected". The variant is
    // only fetched when the market is allowed, so this is doubly guarded.
    if (!config.enabled || !marketAllowed || !config.defaultOn || !config.variantId) {
      return;
    }
    if (autoAddStartedRef.current) return;
    if (!variant || !variant.availableForSale) return;
    autoAddStartedRef.current = true;
    if (protectionLine) return;
    void (async () => {
      // Read the persisted state first: any stored value means the auto-add
      // already ran ('auto_added') or the buyer removed protection
      // ('removed') — in either case, never auto-add again. Storage
      // failures fail closed (no auto-add) so a reload can't re-add a line
      // the buyer explicitly removed.
      let stored: unknown;
      try {
        stored = await storage.read(PROTECTION_STATE_KEY);
      } catch {
        return;
      }
      if (stored != null) return;
      try {
        await storage.write(PROTECTION_STATE_KEY, 'auto_added');
      } catch {
        return;
      }
      await changeProtection(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    previewActive,
    config.enabled,
    marketAllowed,
    config.defaultOn,
    config.variantId,
    variant,
    protectionLine,
  ]);

  // Removal-only affordance FIRST: a protection line already in the cart
  // (e.g. the buyer opted in, then the merchant disabled the feature or
  // swapped the variant, or the buyer switched shipping country) must stay
  // removable, so `isProtected` overrides EVERY offer gate — enabled flag,
  // variantId and market scope. Without the variant fetch the card can't
  // offer, and once the line is removed the component disappears entirely.
  // The normal offer flow keeps all gates (fail closed).
  if (!isProtected && !offerAllowed) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  if (loading) {
    return (
      <View border="base" cornerRadius="base" padding="base">
        <BlockStack spacing="extraTight">
          <SkeletonText inlineSize="small" />
          <SkeletonText inlineSize="large" />
        </BlockStack>
      </View>
    );
  }

  const canOffer = Boolean(variant && variant.availableForSale);
  // If the variant can't be offered and there is nothing in the cart to
  // remove, disappear silently rather than showing a broken card — except
  // on merchant preview carts, where the diagnostic explains the gap.
  if (!canOffer && !isProtected) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  let priceText: string | undefined;
  if (variant) {
    const amount = Number.parseFloat(variant.price.amount);
    if (Number.isFinite(amount)) {
      try {
        priceText = i18n.formatCurrency(amount, {
          currency: variant.price.currencyCode,
        });
      } catch {
        priceText = `${amount.toFixed(2)} ${variant.price.currencyCode}`;
      }
    }
  }

  return (
    <View border="base" cornerRadius="base" padding="base">
      <InlineLayout columns={['auto', 'fill', 'auto']} spacing="base" blockAlignment="start">
        <Icon source="delivery" appearance="subdued" />
        <BlockStack spacing="extraTight">
          <InlineStack spacing="extraTight" blockAlignment="baseline">
            <Text emphasis="bold">{translate('title')}</Text>
            {priceText ? (
              <Text size="small" appearance="subdued">
                {translate('price_label', {price: priceText})}
              </Text>
            ) : null}
          </InlineStack>
          <Text size="small" appearance="subdued">
            {translate('description')}
          </Text>
          {isProtected ? (
            <Text size="small" appearance="success">
              {translate('added')}
            </Text>
          ) : null}
          {errorText ? (
            <Text size="small" appearance="critical">
              {errorText}
            </Text>
          ) : null}
        </BlockStack>
        <Checkbox
          checked={isProtected}
          disabled={busy || (!canOffer && !isProtected)}
          accessibilityLabel={translate('title')}
          onChange={(value: boolean) => {
            if (!value) {
              // Persist the removal so a page reload never auto re-adds.
              void storage.write(PROTECTION_STATE_KEY, 'removed').catch(() => {});
            }
            void changeProtection(value);
          }}
        />
      </InlineLayout>
    </View>
  );
}
