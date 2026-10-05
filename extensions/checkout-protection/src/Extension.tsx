import {useEffect, useMemo, useRef, useState} from 'preact/hooks';
import type {JSX} from 'preact';

/**
 * Cellexia AOV & LTV Booster — Checkout Order Protection, migrated to the
 * Polaris web-components / global `shopify` object architecture
 * (api_version 2026-04). Business logic and behavior are unchanged from the
 * pre-migration React version — see the file header comments below (kept
 * verbatim from the original) for the full behavioral contract. This file
 * only replaces the rendering layer and the API-access pattern, mirroring
 * the checkout-trust/checkout-delivery migrations:
 * reactExtension/hooks-from-@shopify/ui-extensions-react ->
 * Preact + <s-*> web components + the `shopify` global's reactive
 * properties and direct mutation methods.
 *
 * API MAPPING NOTES (verified against the installed @shopify/ui-extensions
 * package types, not guessed):
 * - useApi() -> removed; `i18n`/`query`/`extension`/`storage` read directly
 *   off the `shopify` global (StandardApi/CheckoutApi, both always present
 *   for this single-target `purchase.checkout.block.render` extension).
 * - useApplyCartLinesChange()/useApplyDiscountCodeChange() -> the methods
 *   are now called directly: `shopify.applyCartLinesChange(...)`,
 *   `shopify.applyDiscountCodeChange(...)`. The old code read
 *   `applyDiscountCodeChange` defensively (`'applyDiscountCodeChange' in
 *   api`) because useApi()'s generic target type could omit it for other
 *   targets; this extension only ever targets block.render, where
 *   CheckoutApi (and therefore the method) is always present, so the
 *   defensive check is dropped as dead code rather than ported.
 * - useAppMetafields() -> shopify.appMetafields.value
 * - useAttributeValues(keys) -> read shopify.attributes.value and find by
 *   key (same pattern as checkout-trust/checkout-delivery).
 * - useCartLines() -> shopify.lines.value
 * - useDiscountCodes() -> shopify.discountCodes.value
 * - useInstructions() -> shopify.instructions.value
 * - useLocalizationCountry() -> shopify.localization.country.value
 * - useLocalizationMarket() -> shopify.localization.market.value
 * - useStorage() -> shopify.storage (plain object, same read/write methods)
 * - useTranslate() -> shopify.i18n.translate
 *
 * COMPONENT MAPPING NOTES:
 * - BlockStack/InlineLayout/InlineStack -> <s-stack> (direction
 *   block/inline, per the trust/delivery migrations).
 * - Text -> <s-text>; emphasis="bold" -> type="strong"; size="small" ->
 *   color="subdued" context-dependent (see inline comments); appearance
 *   "success"/"critical" map DIRECTLY to the same `tone` values on s-text.
 *   appearance="accent" has NO "accent" tone on s-text either (verified
 *   against the component's type declaration: only
 *   auto/neutral/info/success/warning/critical/custom) — the one place
 *   this extension used it (the price line) renders with type="strong"
 *   alone, no tone override, rather than a semantically-wrong substitute.
 * - Icon -> <s-icon>; appearance="accent" has no "accent" tone on s-icon
 *   either (verified against the component's tone list) -> mapped to
 *   "auto", same substitution as checkout-trust/checkout-delivery. source
 *   "checkmark" -> type "check" (same gap as the other two extensions).
 * - View -> <s-box>; cornerRadius -> borderRadius (same rename as
 *   checkout-delivery's box format).
 * - Badge -> <s-badge> (no prop changes needed — old code used it with no
 *   tone/size override beyond size="small", which stays size="small").
 * - Checkbox -> <s-checkbox>; the label was previously an `<s-text>` child
 *   (slot content) — s-checkbox's `label` slot explicitly supports only an
 *   `s-text` child (verified), so the port is direct, no prop needed.
 *   `onChange` is now `(event: Event) => void` reading
 *   `event.currentTarget.checked`, NOT a plain boolean argument like the
 *   old React onChange(value: boolean) — a real API shape change, not a
 *   stylistic one.
 * - SkeletonText -> <s-skeleton-paragraph> (the old inlineSize="small"/
 *   "large" variants don't exist on the new component — it only takes an
 *   optional `content` string to size itself off; approximated here with
 *   short vs long placeholder content strings to keep a similar two-line
 *   loading silhouette).
 */

const DEFAULT_CONFIG: CheckoutProtectionConfig = {
  enabled: false,
  variantId: '',
  defaultOn: false,
  showRecommended: true,
};

const BENEFIT_KEYS = ['benefit_1', 'benefit_2', 'benefit_3'] as const;

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
  showRecommended: boolean;
}

interface PreviewConfig {
  armed: boolean;
  draftFlags: Record<string, boolean>;
  tokenHash: string;
}

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
  const enabled = section.enabled === true;
  const variantId =
    typeof section.variantId === 'string' && section.variantId.startsWith('gid://')
      ? section.variantId
      : DEFAULT_CONFIG.variantId;
  const defaultOn = section.defaultOn === true;
  const showRecommended = section.showRecommended !== false;
  return {enabled, variantId, defaultOn, showRecommended};
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
  return 'the Order Protection product is unavailable or could not be loaded — check the Checkout features page';
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

function attributeValue(
  attributes: ReadonlyArray<{key: string; value: string}>,
  key: string,
): string | undefined {
  return attributes.find((attribute) => attribute.key === key)?.value;
}

/**
 * Block root: the Order Protection card plus the invisible v14 rewards
 * safety net. The card component is untouched behaviorally (its early
 * returns still decide what the buyer sees); the safety net renders
 * nothing except a merchant-only PreviewDiagnostic line, so live output is
 * unchanged.
 */
export function Extension(): JSX.Element {
  return (
    <>
      <ProtectionCard />
      <RewardsSafetyNet />
    </>
  );
}

// ---------------------------------------------------------------------------
// v14 rewards safety net (SPEC v14 §9)
// ---------------------------------------------------------------------------

const GIFT_ATTRIBUTE = '_cellexia_gift';
const KIT_ATTACHED_KEY = 'cellexia_kit_attached';
const KIT_YIELDED_KEY = 'cellexia_kit_yielded';
const GIFT_REMOVED_PREFIX = 'cellexia_gift_removed_';
const GIFT_HONESTY_DELAY_MS = 1500;

interface RewardsTier {
  count: number;
  pct: number;
  code: string;
}

interface RewardsConfig {
  setSavingsOn: boolean;
  giftTiersOn: boolean;
  tiers: RewardsTier[];
  yieldToCodes: string[];
  blockedCodes: Set<string>;
  includeSubscriptions: boolean;
  samplePoolVariantIds: Set<string>;
  excludedByMarket: Record<string, string[]>;
}

interface RewardsPreviewDraft {
  rehearsal: boolean;
  setSavingsTiers: RewardsTier[] | undefined;
}

const DEFAULT_REWARDS: RewardsConfig = {
  setSavingsOn: false,
  giftTiersOn: false,
  tiers: [],
  yieldToCodes: [],
  blockedCodes: new Set(),
  includeSubscriptions: true,
  samplePoolVariantIds: new Set(),
  excludedByMarket: {},
};

function numericId(value: unknown): string {
  const match = /(\d+)(?:\?.*)?$/.exec(String(value ?? '').trim());
  return match ? match[1] : '';
}

function parseTiers(raw: unknown): RewardsTier[] {
  if (!Array.isArray(raw)) return [];
  const tiers: RewardsTier[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const count = Number(entry.count);
    const pct = Number(entry.pct);
    const code = typeof entry.code === 'string' ? entry.code.trim() : '';
    if (!Number.isInteger(count) || count < 1) continue;
    if (!Number.isFinite(pct) || pct <= 0) continue;
    if (!code) continue;
    tiers.push({count, pct, code});
  }
  return tiers.sort((a, b) => a.count - b.count);
}

function parseYieldToCodes(raw: unknown, tiers: RewardsTier[]): string[] {
  if (!Array.isArray(raw)) return [];
  const ladder = new Set(tiers.map((tier) => tier.code.toUpperCase()));
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const code = entry.trim().toUpperCase();
    if (!code || ladder.has(code) || out.includes(code)) continue;
    out.push(code);
  }
  return out;
}

function parseBlockedCodes(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const code = entry.trim().toUpperCase();
    if (code) out.add(code);
  }
  return out;
}

function resolveRewards(root: Record<string, unknown> | undefined): RewardsConfig {
  if (!root || !isPlainObject(root.rewards)) return DEFAULT_REWARDS;
  const rewards = root.rewards;
  const setSavings = isPlainObject(rewards.setSavings) ? rewards.setSavings : {};
  const giftTiers = isPlainObject(rewards.giftTiers) ? rewards.giftTiers : {};
  const samplePoolVariantIds = new Set<string>();
  if (Array.isArray(giftTiers.samplePool)) {
    for (const entry of giftTiers.samplePool) {
      if (isPlainObject(entry) && typeof entry.variantId === 'string' && entry.variantId) {
        samplePoolVariantIds.add(entry.variantId);
      }
    }
  }
  const excludedByMarket: Record<string, string[]> = {};
  if (isPlainObject(setSavings.setSavingsExcludedByMarket)) {
    for (const [market, ids] of Object.entries(setSavings.setSavingsExcludedByMarket)) {
      if (Array.isArray(ids)) {
        excludedByMarket[market] = ids.map(numericId).filter((id) => id.length > 0);
      }
    }
  }
  const tiers = parseTiers(setSavings.tiers);
  return {
    setSavingsOn: setSavings.enabled === true,
    giftTiersOn: giftTiers.enabled === true,
    tiers,
    yieldToCodes: parseYieldToCodes(setSavings.yieldToCodes, tiers),
    blockedCodes: parseBlockedCodes(setSavings.blockedCodes),
    includeSubscriptions: setSavings.includeSubscriptions !== false,
    samplePoolVariantIds,
    excludedByMarket,
  };
}

function resolveRewardsPreviewDraft(
  root: Record<string, unknown> | undefined,
): RewardsPreviewDraft {
  const inert: RewardsPreviewDraft = {rehearsal: false, setSavingsTiers: undefined};
  if (!root || !isPlainObject(root.preview)) return inert;
  const draftConfig = root.preview.draftConfig;
  if (!isPlainObject(draftConfig)) return inert;
  const rewards = isPlainObject(draftConfig.rewards) ? draftConfig.rewards : {};
  return {
    rehearsal: draftConfig.rehearsal === true,
    setSavingsTiers: Array.isArray(rewards.setSavingsTiers)
      ? parseTiers(rewards.setSavingsTiers)
      : undefined,
  };
}

function qualifyingTier(
  tiers: RewardsTier[],
  distinct: number,
  blocked: Set<string> = new Set(),
): RewardsTier | null {
  let best: RewardsTier | null = null;
  for (const tier of tiers) {
    if (blocked.has(tier.code.trim().toUpperCase())) continue;
    if (tier.count <= distinct && (best === null || tier.count > best.count)) {
      best = tier;
    }
  }
  return best;
}

function isGiftLine(line: {attributes?: {key: string}[]}): boolean {
  return Boolean(line?.attributes?.some((attr) => attr?.key === GIFT_ATTRIBUTE));
}

function excludedFor(
  excludedByMarket: Record<string, string[]>,
  marketHandle: string | undefined,
): string[] {
  if (!marketHandle) return [];
  const ids = excludedByMarket[marketHandle];
  return Array.isArray(ids) ? ids : [];
}

/**
 * Invisible v14 hook (SPEC §9). Gift honesty + KIT attach, both best effort.
 * Renders one merchant-only PreviewDiagnostic line on preview carts when a
 * gift line is present but not free; otherwise nothing.
 */
function RewardsSafetyNet(): JSX.Element | null {
  const metafieldEntries = shopify.appMetafields.value;
  const cartLines = shopify.lines.value;
  const discountCodes = shopify.discountCodes.value;
  const instructions = shopify.instructions.value;
  const storage = shopify.storage;
  const market = shopify.localization.market.value;
  const attributes = shopify.attributes.value;
  const previewAttributeValue = attributeValue(attributes, '_cx_preview');
  const editor = shopify.extension.editor;
  const inEditor = Boolean(editor);
  const applyCartLinesChange = shopify.applyCartLinesChange;
  const applyDiscountCodeChange = shopify.applyDiscountCodeChange;

  const configRoot = useMemo(
    () => parseCellexiaConfig(metafieldEntries),
    [metafieldEntries],
  );
  const rewards = useMemo(() => resolveRewards(configRoot), [configRoot]);
  const preview = useMemo(() => resolvePreview(configRoot), [configRoot]);
  const previewDraft = useMemo(
    () => resolveRewardsPreviewDraft(configRoot),
    [configRoot],
  );
  const previewActive =
    preview.armed === true &&
    preview.tokenHash.length > 0 &&
    previewAttributeValue === preview.tokenHash;
  const previewAttributePresent =
    typeof previewAttributeValue === 'string' && previewAttributeValue.length > 0;
  const marketHandle = market?.handle;

  const giftTiersActive =
    (rewards.giftTiersOn && isAllowedInMarket(configRoot, 'gift_tiers', marketHandle)) ||
    (previewActive && preview.draftFlags.gift_tiers === true);
  const setSavingsActive =
    (rewards.setSavingsOn && isAllowedInMarket(configRoot, 'set_savings', marketHandle)) ||
    (previewActive && preview.draftFlags.set_savings === true);
  const mutationsAllowed = !inEditor && (!previewActive || previewDraft.rehearsal);

  const protectionVariantId = useMemo(
    () => resolveConfig(configRoot).variantId,
    [configRoot],
  );

  const paidGiftLines = useMemo(
    () =>
      cartLines.filter((line) => {
        if (!isGiftLine(line)) return false;
        const amount = Number(line?.cost?.totalAmount?.amount);
        return Number.isFinite(amount) && amount > 0;
      }),
    [cartLines],
  );
  const paidGiftSignature = paidGiftLines.map((line) => line.id).join('|');
  const latestLinesRef = useRef(cartLines);
  latestLinesRef.current = cartLines;
  const removingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!giftTiersActive || !mutationsAllowed || paidGiftSignature === '') return;
    if (instructions?.lines?.canRemoveCartLine === false) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const stillPaid = latestLinesRef.current.filter((line) => {
            if (!isGiftLine(line)) return false;
            const amount = Number(line?.cost?.totalAmount?.amount);
            return Number.isFinite(amount) && amount > 0;
          });
          for (const line of stillPaid) {
            if (removingRef.current.has(line.id)) continue;
            const key = `${GIFT_REMOVED_PREFIX}${line.id}`;
            let stored: unknown;
            try {
              stored = await storage.read(key);
            } catch {
              continue;
            }
            if (stored != null) continue;
            removingRef.current.add(line.id);
            try {
              await storage.write(key, '1');
            } catch {
              // Storage failure: still remove once (in-memory guard holds
              // for this session; a reload may retry — harmless).
            }
            try {
              await applyCartLinesChange({
                type: 'removeCartLine',
                id: line.id,
                quantity: line.quantity,
              });
            } catch {
              // best effort
            }
          }
        } catch {
          // never throw out of the safety net
        }
      })();
    }, GIFT_HONESTY_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [giftTiersActive, mutationsAllowed, paidGiftSignature, instructions?.lines?.canRemoveCartLine]);

  const tiers =
    previewActive && previewDraft.setSavingsTiers ? previewDraft.setSavingsTiers : rewards.tiers;
  const distinctEligible = useMemo(() => {
    const excluded = new Set(excludedFor(rewards.excludedByMarket, marketHandle));
    const products = new Set<string>();
    for (const line of cartLines) {
      if (!line || line.quantity <= 0) continue;
      if (isGiftLine(line)) continue;
      if (line.attributes?.some((attr) => attr?.key === '_cellexia_protection')) continue;
      if (!rewards.includeSubscriptions && line.merchandise?.sellingPlan) continue;
      const variantId = line.merchandise?.id ?? '';
      if (protectionVariantId && variantId === protectionVariantId) continue;
      if (rewards.samplePoolVariantIds.has(variantId)) continue;
      const productId = numericId(line.merchandise?.product?.id);
      if (!productId || excluded.has(productId)) continue;
      products.add(productId);
    }
    return products.size;
  }, [cartLines, rewards, marketHandle, protectionVariantId]);
  const desiredCode = qualifyingTier(tiers, distinctEligible, rewards.blockedCodes)?.code ?? null;
  const canUpdateCodes = instructions?.discounts?.canUpdateDiscountCodes === true;
  const noCodes = Array.isArray(discountCodes) && discountCodes.length === 0;
  const ladderCodesPresent = useMemo(() => {
    if (!Array.isArray(discountCodes)) return [];
    const ladder = new Set(tiers.map((tier) => tier.code.toUpperCase()));
    return discountCodes
      .map((entry) => (typeof entry?.code === 'string' ? entry.code : ''))
      .filter((code) => code && ladder.has(code.toUpperCase()));
  }, [discountCodes, tiers]);
  const yieldCodePresent = useMemo(() => {
    if (!Array.isArray(discountCodes) || rewards.yieldToCodes.length === 0) return false;
    const yields = new Set(rewards.yieldToCodes);
    return discountCodes.some(
      (entry) => typeof entry?.code === 'string' && yields.has(entry.code.trim().toUpperCase()),
    );
  }, [discountCodes, rewards.yieldToCodes]);
  const ladderToYield =
    yieldCodePresent && ladderCodesPresent.length > 0 ? ladderCodesPresent[0] : null;
  const yieldStartedRef = useRef(false);

  useEffect(() => {
    if (!setSavingsActive || !mutationsAllowed || !canUpdateCodes) return;
    if (!ladderToYield) return;
    if (yieldStartedRef.current) return;
    yieldStartedRef.current = true;
    void (async () => {
      try {
        let stored: unknown;
        try {
          stored = await storage.read(KIT_YIELDED_KEY);
        } catch {
          return;
        }
        if (stored != null) return;
        try {
          await storage.write(KIT_YIELDED_KEY, ladderToYield);
        } catch {
          return;
        }
        await applyDiscountCodeChange({type: 'removeDiscountCode', code: ladderToYield});
      } catch {
        // best effort
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSavingsActive, mutationsAllowed, canUpdateCodes, ladderToYield]);

  const kitStartedRef = useRef(false);
  const sawCodesRef = useRef(false);
  if (Array.isArray(discountCodes) && discountCodes.length > 0) {
    sawCodesRef.current = true;
  }

  useEffect(() => {
    if (!setSavingsActive || !mutationsAllowed || !canUpdateCodes || !noCodes) return;
    if (sawCodesRef.current) return;
    if (!desiredCode) return;
    if (kitStartedRef.current) return;
    kitStartedRef.current = true;
    void (async () => {
      try {
        let stored: unknown;
        try {
          stored = await storage.read(KIT_ATTACHED_KEY);
        } catch {
          return;
        }
        if (stored != null) return;
        try {
          await storage.write(KIT_ATTACHED_KEY, desiredCode);
        } catch {
          return;
        }
        await applyDiscountCodeChange({type: 'addDiscountCode', code: desiredCode});
      } catch {
        // best effort
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSavingsActive, mutationsAllowed, canUpdateCodes, noCodes, desiredCode]);

  if (previewAttributePresent && previewActive && paidGiftLines.length > 0) {
    return (
      <PreviewDiagnostic reason="Free gift not free: subtotal below tier or discount not connected" />
    );
  }
  return null;
}

function ProtectionCard(): JSX.Element | null {
  const translate = shopify.i18n.translate;
  const formatCurrency = shopify.i18n.formatCurrency;
  const query = shopify.query;
  const metafieldEntries = shopify.appMetafields.value;
  const cartLines = shopify.lines.value;
  const applyCartLinesChange = shopify.applyCartLinesChange;
  const storage = shopify.storage;
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
    'checkout_protection',
    market?.handle,
  );

  const preview = useMemo(() => resolvePreview(configRoot), [configRoot]);
  const previewActive =
    preview.armed === true &&
    preview.tokenHash.length > 0 &&
    previewAttributeValue === preview.tokenHash;
  const draftEnabled =
    previewActive && preview.draftFlags.checkout_protection === true;
  const featureVisible = (config.enabled && marketAllowed) || draftEnabled;

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
    (featureVisible || inEditor) && config.variantId.length > 0,
  );
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | undefined>(undefined);

  const autoAddStartedRef = useRef(false);
  const mutationInFlightRef = useRef(false);

  useEffect(() => {
    if ((!featureVisible && !inEditor) || !config.variantId) {
      setVariant(undefined);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    query<VariantQueryData>(VARIANT_QUERY, {
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
  }, [
    config.enabled,
    marketAllowed,
    draftEnabled,
    inEditor,
    config.variantId,
    countryCode,
    query,
  ]);

  const protectionLine = useMemo(
    () =>
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

  const offerAllowed = featureVisible && config.variantId.length > 0;

  async function changeProtection(next: boolean): Promise<void> {
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
    if (inEditor) return;
    if (previewActive) return;
    if (!config.enabled || !marketAllowed || !config.defaultOn || !config.variantId) {
      return;
    }
    if (autoAddStartedRef.current) return;
    if (!variant || !variant.availableForSale) return;
    autoAddStartedRef.current = true;
    if (protectionLine) return;
    void (async () => {
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
    inEditor,
    previewActive,
    config.enabled,
    marketAllowed,
    config.defaultOn,
    config.variantId,
    variant,
    protectionLine,
  ]);

  if (!isProtected && !offerAllowed && !inEditor) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  if (loading) {
    return (
      <s-box border="base" borderRadius="base" padding="base">
        <s-stack direction="block" gap="small-100">
          <s-skeleton-paragraph content="Title"></s-skeleton-paragraph>
          <s-skeleton-paragraph content="A representative longer line of placeholder text"></s-skeleton-paragraph>
          {inEditor ? <EditorPreviewCaption /> : null}
        </s-stack>
      </s-box>
    );
  }

  const canOffer = Boolean(variant && variant.availableForSale);
  if (!canOffer && !isProtected && !inEditor) {
    return previewDiagnosis ? <PreviewDiagnostic reason={previewDiagnosis} /> : null;
  }

  let priceText: string | undefined;
  if (variant) {
    const amount = Number.parseFloat(variant.price.amount);
    if (Number.isFinite(amount)) {
      try {
        priceText = formatCurrency(amount, {
          currency: variant.price.currencyCode,
        });
      } catch {
        priceText = `${amount.toFixed(2)} ${variant.price.currencyCode}`;
      }
    }
  }

  return (
    <s-box border="base" borderRadius="base" padding="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {/* ICON NOTE: `accent` has no `s-icon` tone equivalent (verified —
              the icon tone list omits it, unlike s-text's) — mapped to
              `auto`, same substitution as checkout-trust/checkout-delivery. */}
          <s-icon type="lock" tone="auto" />
          <s-text type="strong">{translate('title')}</s-text>
          {config.showRecommended ? (
            <s-badge size="small">{translate('recommended')}</s-badge>
          ) : null}
        </s-stack>
        <s-stack direction="block" gap="small-100">
          {BENEFIT_KEYS.map((benefitKey) => (
            <s-stack key={benefitKey} direction="inline" gap="small-100" alignItems="start">
              {/* ICON NOTE: `checkmark` has no exact new-set equivalent —
                  mapped to `check` (closest match), same as the other
                  migrated extensions. */}
              <s-icon type="check" size="small" tone="auto" />
              <s-text type="small" color="subdued">
                {translate(benefitKey)}
              </s-text>
            </s-stack>
          ))}
        </s-stack>
        {priceText ? (
          <s-stack direction="inline" gap="small-100" alignItems="center">
            {/* TONE NOTE: s-text's tone list has no "accent" value (verified
                against the installed component type — only
                auto/neutral/info/success/warning/critical/custom) — the old
                emphasis="bold" appearance="accent" price line is rendered
                here with type="strong" alone, no tone override, rather than
                picking a semantically-wrong substitute like "success". */}
            <s-text type="strong">
              {`+ ${priceText}`}
            </s-text>
            <s-text type="small" color="subdued">
              {`· ${translate('price_suffix')}`}
            </s-text>
          </s-stack>
        ) : null}
        <s-checkbox
          checked={isProtected}
          disabled={inEditor || busy || (!canOffer && !isProtected)}
          onChange={(event: Event) => {
            // The new component passes a plain DOM Event, not a boolean —
            // read the new state off currentTarget.checked (real API shape
            // change, verified against the component's type declaration).
            const checked = (event.currentTarget as unknown as {checked: boolean})
              .checked;
            if (!checked) {
              void storage.write(PROTECTION_STATE_KEY, 'removed').catch(() => {});
            }
            void changeProtection(checked);
          }}
        >
          <s-text type="strong">{translate('description')}</s-text>
        </s-checkbox>
        {isProtected ? (
          <s-text type="small" tone="success">
            {translate('added')}
          </s-text>
        ) : null}
        {errorText ? (
          <s-text type="small" tone="critical">
            {errorText}
          </s-text>
        ) : null}
        {inEditor ? <EditorPreviewCaption /> : null}
      </s-stack>
    </s-box>
  );
}
