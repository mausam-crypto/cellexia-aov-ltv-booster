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
 * PREVIEW (v4): when the shop metafield carries `preview.armed: true` AND
 * the SHA-256 digest of the cart's `_cx_preview` attribute (the raw preview
 * token) equals the (non-empty) `preview.tokenHash`, the block additionally
 * treats the feature as enabled when
 * `preview.draftFlags.checkout_upsell === true`, bypassing market gating for
 * that draft grant only (the preview cart belongs to the merchant). Outside
 * preview mode every gate is byte-identical to v3 — all preview logic sits
 * behind the single `previewActive` boolean, which requires the exact hash
 * match.
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
  // Draft grant: in preview mode the feature counts as enabled when its
  // draft flag is explicitly true — market gating is bypassed for the draft
  // grant only (the preview cart is the merchant's own). The live path is
  // untouched: live stays live.
  const draftEnabled = previewActive && preview.draftFlags.checkout_upsell === true;
  const visible = (config.enabled && marketAllowed) || draftEnabled;

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
    return null;
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

  if (offers.length === 0) return null;

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
