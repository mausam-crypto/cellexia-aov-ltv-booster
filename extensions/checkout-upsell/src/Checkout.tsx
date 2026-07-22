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
 * loads offer variants via the Storefront API, filters out variants that are
 * unavailable or already in the cart, and renders up to `maxOffers` compact
 * one-tap offer rows.
 *
 * TWO SOURCING MODES (v4.9, `checkoutUpsell.mode`):
 *   - "auto" (default, also when the field is absent): seeds Shopify's
 *     `productRecommendations` Storefront field with the up-to-2
 *     highest-value cart lines' products (intent COMPLEMENTARY, falling
 *     back to RELATED when complementary returns nothing, and to an
 *     intent-less query if the argument is rejected), then maps each
 *     recommended product to its first in-stock variant. Products already
 *     in the cart and the Order Protection variant are never offered.
 *     Lines this app added itself (`_cellexia_upsell` /
 *     `_cellexia_protection` attributes) never seed recommendations, which
 *     also keeps the fetch stable after a buyer accepts an offer.
 *   - "manual": the hand-picked `variantIds` below, unchanged from v1.
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
  mode: 'auto',
  variantIds: [],
  maxOffers: 2,
};

const MAX_OFFERS_CAP = 10;

/** Auto mode: at most this many cart lines seed productRecommendations. */
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

/**
 * Auto-mode recommendation queries. The selection set mirrors what the
 * manual VARIANTS_QUERY loads per variant, so both modes feed the same
 * OfferVariant shape. `productRecommendations(productId:, intent:)` and the
 * `ProductRecommendationIntent` enum (RELATED | COMPLEMENTARY) are verified
 * against the 2025-07 Storefront API schema; the intent-less variant exists
 * purely as a runtime fallback should the argument ever be rejected (the
 * field then defaults to RELATED).
 */
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
  // v4.9 contract: "auto" is the default — anything but an explicit
  // "manual" (including an absent field on pre-4.9 configs) means auto.
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
    // Auto mode's only remaining nothing-to-show path: the recommendation
    // engine produced no offerable products for this cart's seed lines.
    return 'no recommendations available for the current cart';
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
 * Caption rendered ONLY inside the checkout editor (`extension.editor` set),
 * under the editor preview of this block. Hardcoded English on purpose:
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

/**
 * Auto mode: maps one recommended product to the offer-row shape by picking
 * its first in-stock variant (of the first 5), skipping the Order
 * Protection variant. Returns undefined when nothing is offerable.
 */
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

export default reactExtension('purchase.checkout.block.render', () => <Extension />);

/**
 * Second placement (v4.9): the SAME UI statically anchored immediately
 * before the actions (Pay button) area — the merchant picks either
 * placement in the checkout editor. `reactExtension` registers the target
 * as a call-time side effect (`shopify.extend`), matching the second
 * `[[extensions.targeting]]` entry in shopify.extension.toml; target name
 * verified against RenderExtensionTargets in @shopify/ui-extensions.
 */
export const checkoutActionsRenderBefore = reactExtension(
  'purchase.checkout.actions.render-before',
  () => <Extension />,
);

function Extension() {
  const translate = useTranslate();
  const {i18n, query, extension} = useApi();
  const metafieldEntries = useAppMetafields();
  const cartLines = useCartLines();
  const applyCartLinesChange = useApplyCartLinesChange();
  const settings = useSettings();
  const country = useLocalizationCountry();
  const countryCode = country?.isoCode;
  const market = useLocalizationMarket();

  // CHECKOUT EDITOR detection (v4.9): `extension.editor` is `{type:
  // 'checkout'}` only while the merchant is inside the checkout editor and
  // undefined in every live checkout (verified against StandardApi in
  // @shopify/ui-extensions). In the editor this block ALWAYS renders a
  // representative preview so the merchant can see, place and move it —
  // every enabled/market/config/preview gate is bypassed strictly behind
  // `inEditor`, so live render paths are byte-identical to before.
  const inEditor = Boolean(extension.editor);

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

  // Order Protection variant (same config blob) — never offered as an
  // upsell, and protection lines never seed recommendations.
  const protectionVariantId = useMemo(() => {
    if (!configRoot || !isPlainObject(configRoot.checkoutProtection)) return '';
    const raw = configRoot.checkoutProtection.variantId;
    return typeof raw === 'string' && raw.startsWith('gid://') ? raw : '';
  }, [configRoot]);

  // Auto-mode seeds: the up-to-2 highest-value cart lines' product ids.
  // Protection lines and lines this app added itself (`_cellexia_upsell` /
  // `_cellexia_protection` attributes) never seed — that also keeps the
  // seed set (and therefore the fetch) stable when a buyer accepts an
  // offer, so an "Added" row doesn't churn away mid-checkout.
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

  // Latest cart product ids, read at FETCH time through a ref so cart
  // mutations don't re-trigger the recommendations fetch (the render-time
  // filter below already handles products that enter the cart later).
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

  // Whether the current mode has anything to offer from at all.
  const hasOfferSource =
    config.mode === 'auto' ? seedProductIds.length > 0 : config.variantIds.length > 0;

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
        mode: config.mode,
        hasVariantIds: config.variantIds.length > 0,
      })
    : undefined;

  const [variants, setVariants] = useState<OfferVariant[]>([]);
  // In the editor the fetch also runs while the feature is not yet live
  // (`inEditor` is false in every live checkout, so live is unchanged).
  const [loading, setLoading] = useState<boolean>(
    (visible || inEditor) && hasOfferSource,
  );
  const [offerStates, setOfferStates] = useState<Record<string, OfferState>>({});
  const [errorText, setErrorText] = useState<string | undefined>(undefined);

  /** Prevents overlapping cart mutations (offer state updates async). */
  const addInFlightRef = useRef(false);

  useEffect(() => {
    // Editor mode fetches through the normal pipeline too (so the merchant
    // sees real offers when the pipeline yields them); live behavior is
    // untouched because `inEditor` is always false outside the editor.
    if ((!visible && !inEditor) || !hasOfferSource) {
      setVariants([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    /** query() wrapper that folds thrown/`errors` failures into one flag. */
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

    /** Manual mode: the hand-picked variantIds path, unchanged from v1. */
    async function loadManualOffers(): Promise<OfferVariant[]> {
      // `@inContext` localizes prices to the buyer's market; omit the
      // variable entirely while the checkout country is still unknown.
      const result = await runQuery<VariantsQueryData>(VARIANTS_QUERY, {
        ids: config.variantIds,
        ...(countryCode ? {country: countryCode} : {}),
      });
      const nodes = result.data?.nodes ?? [];
      return nodes.filter(isOfferVariant);
    }

    /** One productRecommendations call per seed product, in parallel. */
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

    /**
     * Auto mode: COMPLEMENTARY recommendations first ("goes well with"),
     * RELATED when complementary has nothing, and an intent-less query
     * (server default: RELATED) if the intent argument is ever rejected.
     */
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
      // Interleave the per-seed lists (each seed's best recommendation
      // first), dedupe by product id, drop products already in the cart,
      // then map each product to its first sellable variant (never the
      // protection variant).
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

  // Editor mode never bails out here: it falls through to the loading
  // skeleton, real offers, or the representative sample row below.
  if ((!visible || !hasOfferSource) && !inEditor) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  if (loading) {
    // Auto mode doesn't know the candidate count up front — show a full
    // maxOffers skeleton; manual keeps the tighter selected-count bound.
    const skeletonRows = Math.max(
      1,
      config.mode === 'auto'
        ? config.maxOffers
        : Math.min(config.maxOffers, config.variantIds.length),
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
        {inEditor ? <EditorPreviewCaption /> : null}
      </BlockStack>
    );
  }

  if (offers.length === 0) {
    if (!inEditor) {
      return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
    }
    // Editor with nothing offerable: one representative sample row (real
    // header/subtitle, skeleton thumb, hardcoded sample title, no price,
    // disabled Add) so the merchant can always see and place the block.
    return (
      <BlockStack spacing="base">
        <BlockStack spacing="extraTight">
          <Heading level={2}>{heading}</Heading>
          <Text size="small" appearance="subdued">
            {translate('subtitle')}
          </Text>
        </BlockStack>
        <InlineLayout
          columns={[60, 'fill', 'auto']}
          spacing="base"
          blockAlignment="center"
        >
          <SkeletonImage aspectRatio={1} />
          <BlockStack spacing="none">
            <Text size="small" emphasis="bold">
              Example product — recommendations appear here
            </Text>
          </BlockStack>
          <Button
            kind="secondary"
            disabled
            accessibilityLabel={`${translate('add')} — example product`}
          >
            {translate('add')}
          </Button>
        </InlineLayout>
        <EditorPreviewCaption />
      </BlockStack>
    );
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
      {inEditor ? <EditorPreviewCaption /> : null}
    </BlockStack>
  );
}
