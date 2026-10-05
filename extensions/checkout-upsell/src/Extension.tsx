import {useEffect, useMemo, useRef, useState} from 'preact/hooks';
import type {JSX} from 'preact';

/**
 * Cellexia AOV & LTV Booster — Checkout Upsell ("Complete your routine"),
 * migrated to the Polaris web-components / global `shopify` object
 * architecture (api_version 2026-04). Business logic and behavior are
 * unchanged from the pre-migration React version. This file only replaces
 * the rendering layer and the API-access pattern, mirroring the other
 * three migrated extensions in this app.
 *
 * API MAPPING NOTES (verified against the installed @shopify/ui-extensions
 * package types):
 * - useApi() -> removed; i18n/query/extension read off the `shopify`
 *   global, same as checkout-protection.
 * - useApplyCartLinesChange() -> shopify.applyCartLinesChange(...)
 * - useAppMetafields() -> shopify.appMetafields.value
 * - useAttributeValues(keys) -> shopify.attributes.value, found by key
 * - useCartLines() -> shopify.lines.value
 * - useLocalizationCountry() -> shopify.localization.country.value
 * - useLocalizationMarket() -> shopify.localization.market.value
 * - useSettings() -> shopify.settings.value
 * - useTranslate() -> shopify.i18n.translate
 *
 * COMPONENT MAPPING NOTES:
 * - BlockStack/InlineLayout/InlineStack -> <s-stack> for one-dimensional
 *   layout (headings, vertical grouping). The old product-row
 *   `columns={[60, 'fill', 'auto']}` fixed/fill/auto column sizing has NO
 *   equivalent on s-stack (it's one-dimensional, no per-item track sizing)
 *   -> ported to <s-grid gridTemplateColumns="60px 1fr auto">, which DOES
 *   support exact per-column track sizing (verified against the installed
 *   Grid component type — gridTemplateColumns is a plain CSS grid-template
 *   string), restoring the original fixed-thumbnail/fill-title/auto-button
 *   proportions exactly, for every product row (loading skeleton, editor
 *   sample, and real offers).
 * - Text -> <s-text>, same type/color/tone mapping as the other three
 *   extensions (size="small" -> type="small"; emphasis="bold" ->
 *   type="strong"; appearance="subdued" -> color="subdued";
 *   appearance="accent" has NO "accent" tone on s-text (verified) -> no
 *   tone override, type="strong" carries the emphasis alone;
 *   appearance="critical" -> tone="critical", a direct, verified match).
 * - Heading -> <s-heading>; the old `level={2}` prop has no equivalent
 *   (verified — s-heading takes no level/size attribute) — dropped, no
 *   behavioral impact (single heading per block).
 * - Image -> <s-image>; prop renames (verified against the component's
 *   type declaration): `source` -> `src`, `accessibilityDescription` ->
 *   `alt`, `fit` -> `objectFit`, `cornerRadius` -> `borderRadius`.
 * - View -> <s-box>; cornerRadius -> borderRadius (same as the other
 *   extensions' box usage).
 * - Button -> <s-button>; `kind` -> `variant`, `onPress` -> `onClick`
 *   (event-based now, but the handler here takes no args either way, so
 *   the call site is unchanged).
 * - SkeletonText -> <s-skeleton-paragraph> (same as checkout-protection).
 * - SkeletonImage -> NO equivalent exists in the new component set
 *   (verified — only s-skeleton-paragraph exists, no image/thumbnail
 *   skeleton). Reused this file's own existing "no image available"
 *   fallback pattern (a plain bordered <s-box>) for the loading-state
 *   thumbnail placeholder too, rather than inventing a new one.
 */

const DEFAULT_CONFIG: CheckoutUpsellConfig = {
  enabled: false,
  mode: 'auto',
  variantIds: [],
  maxOffers: 2,
};

const MAX_OFFERS_CAP = 10;
const MAX_SEED_PRODUCTS = 2;

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

const RECOMMENDATION_PRODUCT_FIELDS = /* GraphQL */ `
  id
  title
  featuredImage {
    url
  }
  variants(first: 5) {
    nodes {
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
    }
  }
`;

const RECOMMENDATIONS_QUERY = /* GraphQL */ `
  query CellexiaUpsellRecommendations(
    $productId: ID!
    $intent: ProductRecommendationIntent
    $country: CountryCode
  ) @inContext(country: $country) {
    productRecommendations(productId: $productId, intent: $intent) {
      ${RECOMMENDATION_PRODUCT_FIELDS}
    }
  }
`;

const RECOMMENDATIONS_QUERY_NO_INTENT = /* GraphQL */ `
  query CellexiaUpsellRecommendationsDefault($productId: ID!, $country: CountryCode)
  @inContext(country: $country) {
    productRecommendations(productId: $productId) {
      ${RECOMMENDATION_PRODUCT_FIELDS}
    }
  }
`;

interface CheckoutUpsellConfig {
  enabled: boolean;
  mode: 'auto' | 'manual';
  variantIds: string[];
  maxOffers: number;
}

interface PreviewConfig {
  armed: boolean;
  draftFlags: Record<string, boolean>;
  tokenHash: string;
}

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

interface RecommendedVariantNode {
  id?: string | null;
  title?: string | null;
  availableForSale?: boolean | null;
  price?: {amount?: string | null; currencyCode?: string | null} | null;
  compareAtPrice?: {amount?: string | null} | null;
  image?: {url?: string | null} | null;
}

interface RecommendedProductNode {
  id?: string | null;
  title?: string | null;
  featuredImage?: {url?: string | null} | null;
  variants?: {nodes?: Array<RecommendedVariantNode | null> | null} | null;
}

interface RecommendationsQueryData {
  productRecommendations?: Array<RecommendedProductNode | null> | null;
}

type OfferState = 'idle' | 'adding' | 'added';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  const enabled = section.enabled === true;
  const mode: CheckoutUpsellConfig['mode'] =
    section.mode === 'manual' ? 'manual' : 'auto';
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
  return {enabled, mode, variantIds, maxOffers};
}

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

function upsellPreviewDiagnosis(input: {
  configFound: boolean;
  preview: PreviewConfig;
  attributeValue: string | undefined;
  featureVisible: boolean;
  mode: CheckoutUpsellConfig['mode'];
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
  if (input.mode === 'auto') {
    return 'no recommendations available for the current cart';
  }
  if (!input.hasVariantIds) {
    return 'no upsell products selected — pick them on the Checkout features page';
  }
  return 'all selected upsell products are already in the cart or unavailable';
}

function PreviewDiagnostic({reason}: {reason: string}) {
  return (
    <s-text type="small" color="subdued">
      {`Cellexia preview: ${reason}`}
    </s-text>
  );
}

function EditorPreviewCaption() {
  return (
    <s-text type="small" color="subdued">
      Preview — buyers see this only when the feature is live for their market.
    </s-text>
  );
}

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

function toOfferVariant(
  product: RecommendedProductNode,
  excludedVariantId: string,
): OfferVariant | undefined {
  const nodes = product.variants?.nodes ?? [];
  for (const node of nodes) {
    if (!node || node.availableForSale !== true) continue;
    if (typeof node.id !== 'string' || node.id.length === 0) continue;
    if (excludedVariantId && node.id === excludedVariantId) continue;
    const candidate: Partial<OfferVariant> = {
      id: node.id,
      title: typeof node.title === 'string' ? node.title : '',
      availableForSale: true,
      price:
        node.price &&
        typeof node.price.amount === 'string' &&
        typeof node.price.currencyCode === 'string'
          ? {amount: node.price.amount, currencyCode: node.price.currencyCode}
          : undefined,
      compareAtPrice:
        node.compareAtPrice && typeof node.compareAtPrice.amount === 'string'
          ? {amount: node.compareAtPrice.amount}
          : null,
      image: node.image && typeof node.image.url === 'string' ? {url: node.image.url} : null,
      product: {
        title: typeof product.title === 'string' ? product.title : '',
        featuredImage:
          product.featuredImage && typeof product.featuredImage.url === 'string'
            ? {url: product.featuredImage.url}
            : null,
      },
    };
    if (isOfferVariant(candidate)) return candidate;
  }
  return undefined;
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

function attributeValue(
  attributes: ReadonlyArray<{key: string; value: string}>,
  key: string,
): string | undefined {
  return attributes.find((attribute) => attribute.key === key)?.value;
}

export function Extension(): JSX.Element | null {
  const translate = shopify.i18n.translate;
  const formatCurrency = shopify.i18n.formatCurrency;
  const query = shopify.query;
  const metafieldEntries = shopify.appMetafields.value;
  const cartLines = shopify.lines.value;
  const applyCartLinesChange = shopify.applyCartLinesChange;
  const settings = shopify.settings.value;
  const country = shopify.localization.country.value;
  const countryCode = country?.isoCode;
  const market = shopify.localization.market.value;
  const attributes = shopify.attributes.value;
  const previewAttributeValue = attributeValue(attributes, '_cx_preview');

  const editor = shopify.extension.editor;
  const inEditor = Boolean(editor);

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

  const protectionVariantId = useMemo(() => {
    if (!configRoot || !isPlainObject(configRoot.checkoutProtection)) return '';
    const raw = configRoot.checkoutProtection.variantId;
    return typeof raw === 'string' && raw.startsWith('gid://') ? raw : '';
  }, [configRoot]);

  const seedProductIds = useMemo(() => {
    if (config.mode !== 'auto') return [] as string[];
    const bestLineValue = new Map<string, number>();
    for (const line of cartLines) {
      const productId = line?.merchandise?.product?.id;
      if (!productId) continue;
      if (protectionVariantId && line.merchandise.id === protectionVariantId) {
        continue;
      }
      if (
        line.attributes?.some(
          (attr) =>
            attr?.key === '_cellexia_upsell' || attr?.key === '_cellexia_protection',
        )
      ) {
        continue;
      }
      const amount = line.cost?.totalAmount?.amount;
      const value =
        typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
      bestLineValue.set(
        productId,
        Math.max(bestLineValue.get(productId) ?? 0, value),
      );
    }
    return [...bestLineValue.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SEED_PRODUCTS)
      .map(([productId]) => productId);
  }, [config.mode, cartLines, protectionVariantId]);
  const seedKey = seedProductIds.join(',');

  const cartProductIds = useMemo(() => {
    const ids = new Set<string>();
    for (const line of cartLines) {
      const productId = line?.merchandise?.product?.id;
      if (productId) ids.add(productId);
    }
    return ids;
  }, [cartLines]);
  const cartProductIdsRef = useRef(cartProductIds);
  cartProductIdsRef.current = cartProductIds;

  const hasOfferSource =
    config.mode === 'auto' ? seedProductIds.length > 0 : config.variantIds.length > 0;

  const preview = useMemo(() => resolvePreview(configRoot), [configRoot]);
  const previewActive =
    preview.armed === true &&
    preview.tokenHash.length > 0 &&
    previewAttributeValue === preview.tokenHash;
  const draftEnabled = previewActive && preview.draftFlags.checkout_upsell === true;
  const visible = (config.enabled && marketAllowed) || draftEnabled;

  const previewAttributePresent =
    typeof previewAttributeValue === 'string' && previewAttributeValue.length > 0;
  const previewDiagnosis = previewAttributePresent
    ? upsellPreviewDiagnosis({
        configFound: configRoot !== undefined,
        preview,
        attributeValue: previewAttributeValue,
        featureVisible: visible,
        mode: config.mode,
        hasVariantIds: config.variantIds.length > 0,
      })
    : undefined;

  const [variants, setVariants] = useState<OfferVariant[]>([]);
  const [loading, setLoading] = useState<boolean>(
    (visible || inEditor) && hasOfferSource,
  );
  const [offerStates, setOfferStates] = useState<Record<string, OfferState>>({});
  const [errorText, setErrorText] = useState<string | undefined>(undefined);

  const addInFlightRef = useRef(false);

  useEffect(() => {
    if ((!visible && !inEditor) || !hasOfferSource) {
      setVariants([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    async function runQuery<Data>(
      graphql: string,
      variables: Record<string, unknown>,
    ): Promise<{data: Data | undefined; errored: boolean}> {
      try {
        const result = await query<Data>(graphql, {variables});
        const errors = result?.errors;
        return {
          data: result?.data,
          errored: Array.isArray(errors) && errors.length > 0,
        };
      } catch {
        return {data: undefined, errored: true};
      }
    }

    async function loadManualOffers(): Promise<OfferVariant[]> {
      const result = await runQuery<VariantsQueryData>(VARIANTS_QUERY, {
        ids: config.variantIds,
        ...(countryCode ? {country: countryCode} : {}),
      });
      const nodes = result.data?.nodes ?? [];
      return nodes.filter(isOfferVariant);
    }

    async function fetchRecommendationLists(
      intent: 'COMPLEMENTARY' | 'RELATED' | undefined,
    ): Promise<{lists: RecommendedProductNode[][]; allErrored: boolean}> {
      const results = await Promise.all(
        seedProductIds.map((productId) =>
          runQuery<RecommendationsQueryData>(
            intent ? RECOMMENDATIONS_QUERY : RECOMMENDATIONS_QUERY_NO_INTENT,
            {
              productId,
              ...(intent ? {intent} : {}),
              ...(countryCode ? {country: countryCode} : {}),
            },
          ),
        ),
      );
      const lists = results.map((result) => {
        const list = result.data?.productRecommendations;
        return Array.isArray(list)
          ? list.filter(
              (product): product is RecommendedProductNode =>
                typeof product === 'object' && product !== null,
            )
          : [];
      });
      const allErrored =
        results.length > 0 &&
        results.every(
          (result) =>
            result.errored &&
            !Array.isArray(result.data?.productRecommendations),
        );
      return {lists, allErrored};
    }

    async function loadAutoOffers(): Promise<OfferVariant[]> {
      let attempt = await fetchRecommendationLists('COMPLEMENTARY');
      if (attempt.allErrored) {
        attempt = await fetchRecommendationLists(undefined);
      } else if (attempt.lists.every((list) => list.length === 0)) {
        const related = await fetchRecommendationLists('RELATED');
        if (!related.allErrored && related.lists.some((list) => list.length > 0)) {
          attempt = related;
        }
      }
      const excludedProductIds = cartProductIdsRef.current;
      const seenProductIds = new Set<string>();
      const offers: OfferVariant[] = [];
      const longestList = Math.max(0, ...attempt.lists.map((list) => list.length));
      for (let index = 0; index < longestList; index++) {
        for (const list of attempt.lists) {
          if (offers.length >= MAX_OFFERS_CAP) return offers;
          const product = list[index];
          if (!product || typeof product.id !== 'string') continue;
          if (seenProductIds.has(product.id)) continue;
          seenProductIds.add(product.id);
          if (excludedProductIds.has(product.id)) continue;
          const offer = toOfferVariant(product, protectionVariantId);
          if (offer) offers.push(offer);
        }
      }
      return offers;
    }

    (config.mode === 'auto' ? loadAutoOffers() : loadManualOffers())
      .then((nextVariants) => {
        if (!cancelled) setVariants(nextVariants);
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
  }, [
    config.enabled,
    marketAllowed,
    draftEnabled,
    inEditor,
    config.mode,
    variantIdsKey,
    seedKey,
    countryCode,
    query,
  ]);

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
      return formatCurrency(value, {currency: currencyCode});
    } catch {
      return `${value.toFixed(2)} ${currencyCode}`;
    }
  }

  async function handleAdd(variantId: string): Promise<void> {
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

  if ((!visible || !hasOfferSource) && !inEditor) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  if (loading) {
    const skeletonRows = Math.max(
      1,
      config.mode === 'auto'
        ? config.maxOffers
        : Math.min(config.maxOffers, config.variantIds.length),
    );
    return (
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-100">
          <s-heading>{heading}</s-heading>
          <s-text type="small" color="subdued">
            {translate('subtitle')}
          </s-text>
        </s-stack>
        {Array.from({length: skeletonRows}, (_, index) => (
          <s-grid key={`skeleton-${index}`} gridTemplateColumns="60px 1fr auto" gap="base" alignItems="center">
            {/* No image-skeleton component exists in the new set — reuses
                the plain bordered box pattern used below for "no image
                available", see file header. */}
            <s-box border="base" borderRadius="base" minBlockSize="60px" minInlineSize="60px" />
            <s-stack direction="block" gap="small-100">
              <s-skeleton-paragraph content="A representative longer line of placeholder text"></s-skeleton-paragraph>
              <s-skeleton-paragraph content="Short"></s-skeleton-paragraph>
            </s-stack>
            <s-skeleton-paragraph content="Short"></s-skeleton-paragraph>
          </s-grid>
        ))}
        {inEditor ? <EditorPreviewCaption /> : null}
      </s-stack>
    );
  }

  if (offers.length === 0) {
    if (!inEditor) {
      return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
    }
    return (
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-100">
          <s-heading>{heading}</s-heading>
          <s-text type="small" color="subdued">
            {translate('subtitle')}
          </s-text>
        </s-stack>
        <s-grid gridTemplateColumns="60px 1fr auto" gap="base" alignItems="center">
          <s-box border="base" borderRadius="base" minBlockSize="60px" minInlineSize="60px" />
          <s-stack direction="block" gap="none">
            <s-text type="strong">
              Example product — recommendations appear here
            </s-text>
          </s-stack>
          <s-button
            variant="secondary"
            disabled
            accessibilityLabel={`${translate('add')} — example product`}
          >
            {translate('add')}
          </s-button>
        </s-grid>
        <EditorPreviewCaption />
      </s-stack>
    );
  }

  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="block" gap="small-100">
        <s-heading>{heading}</s-heading>
        <s-text type="small" color="subdued">
          {translate('subtitle')}
        </s-text>
      </s-stack>
      {errorText ? (
        <s-text type="small" tone="critical">
          {errorText}
        </s-text>
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
          <s-grid key={variant.id} gridTemplateColumns="60px 1fr auto" gap="base" alignItems="center">
            {imageUrl ? (
              <s-image
                src={imageUrl}
                alt={title}
                aspectRatio="1"
                objectFit="cover"
                borderRadius="base"
                border="base"
              />
            ) : (
              <s-box border="base" borderRadius="base" minBlockSize="60px" minInlineSize="60px" />
            )}
            <s-stack direction="block" gap="none">
              <s-text type="strong">
                {title}
              </s-text>
              <s-stack direction="inline" gap="small-100" alignItems="center">
                <s-text type="small">{priceText}</s-text>
                {compareAtText ? (
                  <s-text type="redundant" color="subdued">
                    {compareAtText}
                  </s-text>
                ) : null}
                {percent !== undefined ? (
                  <s-text type="strong">
                    {translate('save_pct', {percent})}
                  </s-text>
                ) : null}
              </s-stack>
            </s-stack>
            <s-button
              variant="secondary"
              loading={state === 'adding'}
              disabled={state === 'added' || anyBusy}
              accessibilityLabel={`${buttonLabel} — ${title}`}
              onClick={() => {
                void handleAdd(variant.id);
              }}
            >
              {buttonLabel}
            </s-button>
          </s-grid>
        );
      })}
      {inEditor ? <EditorPreviewCaption /> : null}
    </s-stack>
  );
}
