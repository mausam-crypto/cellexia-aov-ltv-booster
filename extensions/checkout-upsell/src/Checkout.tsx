import {useEffect, useMemo, useRef, useState} from 'react';
import {
  BlockStack,
  Button,
  Heading,
  Image,
  InlineLayout,
  InlineStack,
  SkeletonImage,
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
  useSettings,
  useTranslate,
} from '@shopify/ui-extensions-react/checkout';

/**
 * Cellexia AOV & LTV Booster — Checkout Upsell ("Complete your routine").
 *
 * Reads `checkoutUpsell` from the shop metafield ($app:cellexia / config),
 * loads the configured variants via the Storefront API, filters out variants
 * that are unavailable or already in the cart, and renders up to `maxOffers`
 * compact one-tap offer rows.
 *
 * SAFE BY DEFAULT: a missing/unparsable config metafield, a missing
 * `checkoutUpsell` section, or anything but an explicit `enabled: true`
 * renders nothing. Market targeting (`marketScopes.checkout_upsell`) is
 * enforced against the checkout's localization market and FAILS CLOSED:
 * with mode "selected", an unknown market hides the block.
 *
 * PREVIEW (v5): the cart's `_cx_preview` attribute carries the SHA-256 HEX
 * digest of the preview token, computed server-side by the app — so the
 * preview gate is a plain synchronous string comparison against the
 * (non-empty) `preview.tokenHash` from the shop metafield. No SubtleCrypto
 * dependency (v4 hashed the raw token inside the extension; SubtleCrypto's
 * silent unavailability in some checkout sandboxes disabled preview
 * entirely). When the metafield carries `preview.armed: true` AND the
 * attribute equals the hash, the block additionally treats the feature as
 * enabled when `preview.draftFlags.checkout_upsell === true`, bypassing
 * market gating for that draft grant only (the preview cart belongs to the
 * merchant). Outside preview mode every gate is unchanged — all preview
 * logic sits behind the single `previewActive` boolean.
 *
 * PREVIEW DIAGNOSTICS: when `_cx_preview` is present (merchant preview
 * carts only — real buyers never carry it) and this block would otherwise
 * render nothing, it renders one subdued line explaining why. When the
 * attribute is absent, behavior is byte-identical to before: every
 * diagnostic path sits behind the attribute-present check.
 */

/** Mirrors DEFAULT_SETTINGS.checkoutUpsell in app/models/settings.server.ts. */
const DEFAULT_CONFIG: CheckoutUpsellConfig = {
  enabled: false,
  variantIds: [],
  maxOffers: 2,
};

const MAX_OFFERS_CAP = 10;

const VARIANTS_QUERY = /* GraphQL */ `
  query CellexiaUpsellVariants($ids: [ID!]!, $country: CountryCode)
  @inContext(country: $country) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        availableForSale
        price {
          amount
          currencyCode
        }
        compareAtPrice {
          amount
        }
        image {
          url
        }
        product {
          title
          featuredImage {
            url
          }
        }
      }
    }
  }
`;

interface CheckoutUpsellConfig {
  enabled: boolean;
  variantIds: string[];
  maxOffers: number;
}

interface PreviewConfig {
  armed: boolean;
  draftFlags: Record<string, boolean>;
  tokenHash: string;
}

/** Inert preview default: disarmed, no draft flags, empty (never-matching) token hash. */
const DEFAULT_PREVIEW: PreviewConfig = {armed: false, draftFlags: {}, tokenHash: ''};

interface MoneyLike {
  amount: string;
  currencyCode: string;
}

interface OfferVariant {
  id: string;
  title: string;
  availableForSale: boolean;
  price: MoneyLike;
  compareAtPrice: {amount: string} | null;
  image: {url: string} | null;
  product: {title: string; featuredImage: {url: string} | null} | null;
}

interface VariantsQueryData {
  nodes?: Array<Partial<OfferVariant> | null> | null;
}

type OfferState = 'idle' | 'adding' | 'added';

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

function resolveConfig(root: Record<string, unknown> | undefined): CheckoutUpsellConfig {
  if (!root || !isPlainObject(root.checkoutUpsell)) return DEFAULT_CONFIG;
  const section = root.checkoutUpsell;
  // Safe default: the feature is ON only when the metafield explicitly says
  // `enabled: true`. Missing, malformed or falsy values all mean OFF.
  const enabled = section.enabled === true;
  const variantIds = Array.isArray(section.variantIds)
    ? section.variantIds.filter(
        (id): id is string => typeof id === 'string' && id.startsWith('gid://'),
      )
    : DEFAULT_CONFIG.variantIds;
  const rawMax =
    typeof section.maxOffers === 'number' && Number.isFinite(section.maxOffers)
      ? Math.floor(section.maxOffers)
      : DEFAULT_CONFIG.maxOffers;
  const maxOffers = Math.min(Math.max(rawMax, 1), MAX_OFFERS_CAP);
  return {enabled, variantIds, maxOffers};
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
function upsellPreviewDiagnosis(input: {
  configFound: boolean;
  preview: PreviewConfig;
  attributeValue: string | undefined;
  featureVisible: boolean;
  hasVariantIds: boolean;
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
    return 'the checkout upsell feature is not draft-enabled for this preview';
  }
  if (!input.hasVariantIds) {
    return 'no upsell products selected — pick them on the Checkout features page';
  }
  return 'all selected upsell products are already in the cart or unavailable';
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

function isOfferVariant(node: Partial<OfferVariant> | null | undefined): node is OfferVariant {
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

function offerTitle(variant: OfferVariant): string {
  const productTitle = variant.product?.title?.trim() ?? '';
  const variantTitle = typeof variant.title === 'string' ? variant.title.trim() : '';
  if (!productTitle) return variantTitle;
  if (!variantTitle || variantTitle === 'Default Title') return productTitle;
  return `${productTitle} — ${variantTitle}`;
}

function offerImageUrl(variant: OfferVariant): string | undefined {
  return variant.image?.url ?? variant.product?.featuredImage?.url ?? undefined;
}

function savingsPercent(variant: OfferVariant): number | undefined {
  const price = Number.parseFloat(variant.price.amount);
  const compareAt = variant.compareAtPrice
    ? Number.parseFloat(variant.compareAtPrice.amount)
    : Number.NaN;
  if (!Number.isFinite(price) || !Number.isFinite(compareAt)) return undefined;
  if (compareAt <= 0 || compareAt <= price) return undefined;
  const percent = Math.round((1 - price / compareAt) * 100);
  return percent >= 1 ? percent : undefined;
}

export default reactExtension('purchase.checkout.block.render', () => <Extension />);

function Extension() {
  const translate = useTranslate();
  const {i18n, query} = useApi();
  const metafieldEntries = useAppMetafields();
  const cartLines = useCartLines();
  const applyCartLinesChange = useApplyCartLinesChange();
  const settings = useSettings();
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
    'checkout_upsell',
    market?.handle,
  );
  const variantIdsKey = config.variantIds.join(',');

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
  // Draft grant: in preview mode the feature counts as enabled when its
  // draft flag is explicitly true — market gating is bypassed for the draft
  // grant only (the preview cart is the merchant's own). The live path is
  // untouched: live stays live.
  const draftEnabled = previewActive && preview.draftFlags.checkout_upsell === true;
  const visible = (config.enabled && marketAllowed) || draftEnabled;

  // Merchant preview diagnostics: `_cx_preview` present means a merchant
  // preview cart (real buyers never carry it). Precompute the reason we
  // would show if this block ends up rendering nothing; `undefined` when
  // the attribute is absent keeps every diagnostic path unreachable for
  // real checkouts (byte-identical to pre-diagnostics behavior).
  const previewAttributePresent =
    typeof previewAttributeValue === 'string' && previewAttributeValue.length > 0;
  const previewDiagnosis = previewAttributePresent
    ? upsellPreviewDiagnosis({
        configFound: configRoot !== undefined,
        preview,
        attributeValue: previewAttributeValue,
        featureVisible: visible,
        hasVariantIds: config.variantIds.length > 0,
      })
    : undefined;

  const [variants, setVariants] = useState<OfferVariant[]>([]);
  const [loading, setLoading] = useState<boolean>(
    visible && config.variantIds.length > 0,
  );
  const [offerStates, setOfferStates] = useState<Record<string, OfferState>>({});
  const [errorText, setErrorText] = useState<string | undefined>(undefined);

  /** Prevents overlapping cart mutations (offer state updates async). */
  const addInFlightRef = useRef(false);

  useEffect(() => {
    if (!visible || config.variantIds.length === 0) {
      setVariants([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    query<VariantsQueryData>(VARIANTS_QUERY, {
      // `@inContext` localizes prices to the buyer's market; omit the
      // variable entirely while the checkout country is still unknown.
      variables: countryCode
        ? {ids: config.variantIds, country: countryCode}
        : {ids: config.variantIds},
    })
      .then((result) => {
        if (cancelled) return;
        const nodes = result?.data?.nodes ?? [];
        setVariants(nodes.filter(isOfferVariant));
      })
      .catch(() => {
        if (!cancelled) setVariants([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.enabled, marketAllowed, draftEnabled, variantIdsKey, countryCode, query]);

  const inCartVariantIds = useMemo(() => {
    const ids = new Set<string>();
    for (const line of cartLines) {
      if (line?.merchandise?.id) ids.add(line.merchandise.id);
    }
    return ids;
  }, [cartLines]);

  const offers = useMemo(
    () =>
      variants
        .filter((variant) => variant.availableForSale)
        .filter(
          (variant) =>
            !inCartVariantIds.has(variant.id) || offerStates[variant.id] === 'added',
        )
        .slice(0, config.maxOffers),
    [variants, inCartVariantIds, offerStates, config.maxOffers],
  );

  const anyBusy = useMemo(
    () => Object.values(offerStates).includes('adding'),
    [offerStates],
  );

  const customTitle =
    typeof settings.title === 'string' && settings.title.trim().length > 0
      ? settings.title.trim()
      : undefined;
  const heading = customTitle ?? translate('title');

  function formatAmount(amount: string, currencyCode: string): string {
    const value = Number.parseFloat(amount);
    if (!Number.isFinite(value)) return '';
    try {
      return i18n.formatCurrency(value, {currency: currencyCode});
    } catch {
      return `${value.toFixed(2)} ${currencyCode}`;
    }
  }

  async function handleAdd(variantId: string): Promise<void> {
    // The ref guards synchronously against double-taps; `anyBusy` only
    // updates on the next render, so it alone can't prevent re-entry.
    if (addInFlightRef.current) return;
    if (anyBusy || offerStates[variantId] === 'added') return;
    addInFlightRef.current = true;
    setOfferStates((previous) => ({...previous, [variantId]: 'adding'}));
    setErrorText(undefined);
    try {
      const result = await applyCartLinesChange({
        type: 'addCartLine',
        merchandiseId: variantId,
        quantity: 1,
        attributes: [{key: '_cellexia_upsell', value: 'checkout'}],
      });
      if (result.type === 'error') {
        setOfferStates((previous) => ({...previous, [variantId]: 'idle'}));
        setErrorText(translate('error'));
      } else {
        setOfferStates((previous) => ({...previous, [variantId]: 'added'}));
      }
    } catch {
      setOfferStates((previous) => ({...previous, [variantId]: 'idle'}));
      setErrorText(translate('error'));
    } finally {
      addInFlightRef.current = false;
    }
  }

  if (!visible || config.variantIds.length === 0) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  if (loading) {
    const skeletonRows = Math.max(
      1,
      Math.min(config.maxOffers, config.variantIds.length),
    );
    return (
      <BlockStack spacing="base">
        <BlockStack spacing="extraTight">
          <Heading level={2}>{heading}</Heading>
          <Text size="small" appearance="subdued">
            {translate('subtitle')}
          </Text>
        </BlockStack>
        {Array.from({length: skeletonRows}, (_, index) => (
          <InlineLayout
            key={`skeleton-${index}`}
            columns={[60, 'fill', 'auto']}
            spacing="base"
            blockAlignment="center"
          >
            <SkeletonImage aspectRatio={1} />
            <BlockStack spacing="extraTight">
              <SkeletonText inlineSize="large" />
              <SkeletonText inlineSize="small" />
            </BlockStack>
            <SkeletonText inlineSize="small" />
          </InlineLayout>
        ))}
      </BlockStack>
    );
  }

  if (offers.length === 0) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  return (
    <BlockStack spacing="base">
      <BlockStack spacing="extraTight">
        <Heading level={2}>{heading}</Heading>
        <Text size="small" appearance="subdued">
          {translate('subtitle')}
        </Text>
      </BlockStack>
      {errorText ? (
        <Text size="small" appearance="critical">
          {errorText}
        </Text>
      ) : null}
      {offers.map((variant) => {
        const title = offerTitle(variant);
        const imageUrl = offerImageUrl(variant);
        const priceText = formatAmount(
          variant.price.amount,
          variant.price.currencyCode,
        );
        const percent = savingsPercent(variant);
        const compareAtText =
          percent !== undefined && variant.compareAtPrice
            ? formatAmount(
                variant.compareAtPrice.amount,
                variant.price.currencyCode,
              )
            : undefined;
        const state = offerStates[variant.id] ?? 'idle';
        const buttonLabel =
          state === 'added'
            ? translate('added')
            : state === 'adding'
              ? translate('adding')
              : translate('add');
        return (
          <InlineLayout
            key={variant.id}
            columns={[60, 'fill', 'auto']}
            spacing="base"
            blockAlignment="center"
          >
            {imageUrl ? (
              <Image
                source={imageUrl}
                accessibilityDescription={title}
                aspectRatio={1}
                fit="cover"
                cornerRadius="base"
                border="base"
              />
            ) : (
              <View border="base" cornerRadius="base" minBlockSize={60} />
            )}
            <BlockStack spacing="none">
              <Text size="small" emphasis="bold">
                {title}
              </Text>
              <InlineStack spacing="extraTight" blockAlignment="baseline">
                <Text size="small">{priceText}</Text>
                {compareAtText ? (
                  <Text
                    size="small"
                    appearance="subdued"
                    accessibilityRole="deletion"
                  >
                    {compareAtText}
                  </Text>
                ) : null}
                {percent !== undefined ? (
                  <Text size="small" appearance="accent" emphasis="bold">
                    {translate('save_pct', {percent})}
                  </Text>
                ) : null}
              </InlineStack>
            </BlockStack>
            <Button
              kind="secondary"
              loading={state === 'adding'}
              disabled={state === 'added' || anyBusy}
              accessibilityLabel={`${buttonLabel} — ${title}`}
              onPress={() => {
                void handleAdd(variant.id);
              }}
            >
              {buttonLabel}
            </Button>
          </InlineLayout>
        );
      })}
    </BlockStack>
  );
}
