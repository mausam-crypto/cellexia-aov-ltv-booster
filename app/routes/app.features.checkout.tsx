import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import type { ShouldRevalidateFunctionArgs } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  Divider,
  InlineStack,
  Layout,
  Page,
  Select,
  Spinner,
  Tag,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { ArrowDownIcon, ArrowUpIcon, ImageIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getSettings,
  normalizeTrustRowOrder,
  resolveFeatureFlag,
  saveSettings,
  validateExcludedByMarketPatch,
  type BoosterSettings,
  type CheckoutTrustRow,
  type DeepPartial,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import {
  ensureProtectionProduct,
  getProductTitlesByIds,
  getVariantsByIds,
  type VariantSummary,
} from "../services/products.server";
import { listMarkets } from "../services/markets.server";
import { listProductsWithBoosterStatus } from "../services/pdp-content.server";
import {
  applyProtectionPrices,
  readbackProtectionPrices,
  type ApplyProtectionPricesResult,
  type ProtectionMarketPrice,
} from "../services/protection-pricing.server";
import { FeaturePageHeader } from "../components/FeaturePageHeader";
import { MarketProductExclusionsCard } from "../components/MarketExclusions";
import type { loader as variantsLoader } from "./app.api.variants";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface ProtectionResult {
  variantId: string | null;
  created: boolean;
  errors: string[];
}

interface CheckoutActionResult {
  ok: boolean;
  syncErrors: string[];
  protection: ProtectionResult | null;
  /** Result of the "Apply to Shopify Markets" protection-pricing intent. */
  apply: ApplyProtectionPricesResult | null;
}

/** v12: response of the exclusion cards' `search_products` intent (the
 *  ProofForms picker convention — picker fetchers post to the CURRENT
 *  route). */
interface SearchProductsResult {
  intent: "search_products";
  ok: boolean;
  errors: string[];
  products: {
    gid: string;
    title: string;
    imageUrl: string | null;
    status: string;
  }[];
}

async function applySettingsPatch(
  shop: string,
  admin: AdminGraphqlClient,
  rawPatch: FormDataEntryValue | null,
): Promise<CheckoutActionResult> {
  if (typeof rawPatch !== "string" || rawPatch.trim() === "") {
    return {
      ok: false,
      syncErrors: ["Missing settings payload."],
      protection: null,
      apply: null,
    };
  }
  let patch: DeepPartial<BoosterSettings>;
  try {
    const parsed: unknown = JSON.parse(rawPatch);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        syncErrors: ["Settings payload must be an object."],
        protection: null,
        apply: null,
      };
    }
    patch = parsed as DeepPartial<BoosterSettings>;
  } catch {
    return {
      ok: false,
      syncErrors: ["Settings payload was not valid JSON."],
      protection: null,
      apply: null,
    };
  }
  // v12: fail-loud validation of the two exclusion records BEFORE the save
  // (mirrors validateDispatchPatch on the dispatch page) — a malformed
  // payload must error loudly, never be silently trimmed by the sanitizer.
  const exclusionErrors = [
    ...validateExcludedByMarketPatch(
      patch.checkoutTrust?.customsExcludedByMarket,
      "Customs-row excluded products",
    ),
    ...validateExcludedByMarketPatch(
      patch.checkoutTrust?.trackedExcludedByMarket,
      "Tracked-row excluded products",
    ),
  ];
  if (exclusionErrors.length > 0) {
    return { ok: false, syncErrors: exclusionErrors, protection: null, apply: null };
  }
  const next = await saveSettings(shop, patch);
  try {
    const sync = await syncSettingsToMetafields(admin, next);
    return { ok: true, syncErrors: sync.errors, protection: null, apply: null };
  } catch (error) {
    return {
      ok: true,
      syncErrors: [
        error instanceof Error
          ? error.message
          : "Could not sync settings to storefront metafields.",
      ],
      protection: null,
      apply: null,
    };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);
  // v11: getSettings merges but does not sanitize — normalize the trust-row
  // order SERVER-SIDE so the client always receives a full permutation of
  // the six lines, even from a stored blob predating rowOrder (or carrying
  // junk). Must stay in the loader: normalizeTrustRowOrder is a .server
  // VALUE, and calling it from component code puts settings.server in the
  // client module graph and breaks the Vite build (the v8.3 build-break
  // lesson — see app.features._index.tsx).
  settings.checkoutTrust.rowOrder = normalizeTrustRowOrder(
    settings.checkoutTrust.rowOrder,
  );
  const [upsellVariants, protectionVariants, markets, priceReadback] =
    await Promise.all([
      getVariantsByIds(admin, settings.checkoutUpsell.variantIds),
      settings.checkoutProtection.variantId
        ? getVariantsByIds(admin, [settings.checkoutProtection.variantId])
        : Promise.resolve([] as VariantSummary[]),
      listMarkets(admin),
      // Current FIXED prices of the protection variant on each market's
      // price list — display-only; readback failures degrade to {}.
      readbackProtectionPrices(admin, settings.checkoutProtection.variantId),
    ]);
  // v12: readable labels for the stored exclusion GIDs of BOTH trust-row
  // records — one combined map (fail-soft: a failed lookup degrades the
  // tags to "Product <id>", never the page).
  const exclusionTitles = await getProductTitlesByIds(admin, [
    ...Object.values(settings.checkoutTrust.customsExcludedByMarket).flat(),
    ...Object.values(settings.checkoutTrust.trackedExcludedByMarket).flat(),
  ]).catch(() => ({}) as Record<string, string>);
  return {
    settings,
    upsellVariants,
    protectionVariant: protectionVariants[0] ?? null,
    markets,
    exclusionTitles,
    currentFixedPrices: priceReadback.byMarket,
    // Combined flag for the shared page header (cheap — settings loaded).
    headerEnabled: resolveFeatureFlag(settings, "checkout_upsell"),
  };
};

/**
 * v12: the exclusion card's product search rides a POST fetcher to this
 * route's action; Remix would revalidate the loader after it, and the
 * loader-data reset would wipe unsaved form edits (including the exclusion
 * row being built — review catch). Searches are read-only lookups: skip
 * revalidation for them, keep it for every real mutation.
 */
export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formData?.get("intent") === "search_products") return false;
  return defaultShouldRevalidate;
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<CheckoutActionResult | SearchProductsResult> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "ensure_protection") {
    const price = String(formData.get("price") ?? "").trim();
    if (!/^\d+(\.\d{1,2})?$/.test(price) || Number(price) <= 0) {
      return {
        ok: false,
        syncErrors: [],
        protection: {
          variantId: null,
          created: false,
          errors: ["Enter a valid price, for example 2.95."],
        },
        apply: null,
      };
    }
    const result = await ensureProtectionProduct(admin, price);
    if (!result.variantId) {
      return {
        ok: false,
        syncErrors: [],
        protection: {
          variantId: null,
          created: false,
          errors:
            result.errors.length > 0
              ? result.errors
              : ["Could not create or find the Order Protection product."],
        },
        apply: null,
      };
    }
    const next = await saveSettings(session.shop, {
      checkoutProtection: { variantId: result.variantId },
    });
    let syncErrors: string[] = [];
    try {
      const sync = await syncSettingsToMetafields(admin, next);
      syncErrors = sync.errors;
    } catch (error) {
      syncErrors = [
        error instanceof Error
          ? error.message
          : "Could not sync settings to storefront metafields.",
      ];
    }
    return { ok: true, syncErrors, protection: result, apply: null };
  }

  if (intent === "apply_protection_prices") {
    // The button submits the per-market amounts currently in the form so a
    // single click can't apply stale values. They are persisted FIRST
    // (saveSettings sanitizes every entry) and the SAVED map is what gets
    // written to Shopify — app config and Shopify Markets never diverge.
    let byMarket: Record<string, ProtectionMarketPrice> = {};
    try {
      const parsed: unknown = JSON.parse(String(formData.get("prices") ?? ""));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        byMarket = parsed as Record<string, ProtectionMarketPrice>;
      }
    } catch {
      // Malformed payload — fall through with {}; applyProtectionPrices
      // degrades it into a readable top-level error.
    }
    const next = await saveSettings(session.shop, {
      checkoutProtection: { prices: { byMarket } },
    });
    let syncErrors: string[] = [];
    try {
      const sync = await syncSettingsToMetafields(admin, next);
      syncErrors = sync.errors;
    } catch (error) {
      syncErrors = [
        error instanceof Error
          ? error.message
          : "Could not sync settings to storefront metafields.",
      ];
    }
    const apply = await applyProtectionPrices(admin, {
      variantId: next.checkoutProtection.variantId,
      byMarket: next.checkoutProtection.prices.byMarket,
    });
    return { ok: true, syncErrors, protection: null, apply };
  }

  // v12: the exclusion cards' product search (the ProofForms picker
  // convention — the picker's fetcher posts to the CURRENT route).
  if (intent === "search_products") {
    const result = await listProductsWithBoosterStatus(
      admin,
      String(formData.get("q") ?? ""),
    );
    return {
      intent: "search_products" as const,
      ok: result.ok,
      errors: result.errors,
      products: result.products.map((product) => ({
        gid: product.id,
        title: product.title,
        imageUrl: product.imageUrl,
        status: product.status,
      })),
    };
  }

  return applySettingsPatch(session.shop, admin, formData.get("patch"));
};

// ---------------------------------------------------------------------------
// Market targeting card (duplicated across feature pages on purpose — route
// modules do not share UI components)
// ---------------------------------------------------------------------------

interface ScopeState {
  mode: "all" | "selected";
  markets: string[];
}

function toScopeState(
  scope: { mode: "all" | "selected"; markets: string[] } | undefined,
): ScopeState {
  return scope && scope.mode === "selected"
    ? { mode: "selected", markets: [...scope.markets] }
    : { mode: "all", markets: [] };
}

/** Scope as persisted — an "all" scope never stores a markets list. The UI
 *  keeps the previous hand-picked list in local state so flipping back to
 *  "Selected markets" restores it; only the save patch strips it. */
function toScopePatch(scope: ScopeState): ScopeState {
  return scope.mode === "all" ? { mode: "all", markets: [] } : scope;
}

function scopesToPatch<K extends string>(
  scopes: Record<K, ScopeState>,
): Record<K, ScopeState> {
  return Object.fromEntries(
    (Object.entries(scopes) as [K, ScopeState][]).map(([key, scope]) => [
      key,
      toScopePatch(scope),
    ]),
  ) as Record<K, ScopeState>;
}

interface MarketOption {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
  primary: boolean;
}

interface MarketScopeCardProps {
  title: string;
  markets: MarketOption[];
  scope: ScopeState;
  onChange: (scope: ScopeState) => void;
}

function MarketScopeCard({
  title,
  markets,
  scope,
  onChange,
}: MarketScopeCardProps) {
  const allHandles = markets.map((market) => market.handle);
  const handleModeChange = (selected: string[]) => {
    const mode = selected[0] === "selected" ? "selected" : "all";
    if (mode === scope.mode) return;
    onChange(
      mode === "all"
        ? // Keep the hand-picked list in local state so switching back to
          // "Selected markets" restores it — the save patch strips it.
          { mode: "all", markets: [...scope.markets] }
        : {
            mode: "selected",
            markets:
              scope.markets.length > 0 ? [...scope.markets] : [...allHandles],
          },
    );
  };
  const toggleMarket = (handle: string, checked: boolean) => {
    const set = new Set(scope.markets);
    if (checked) set.add(handle);
    else set.delete(handle);
    const ordered = allHandles.filter((other) => set.has(other));
    for (const other of set) {
      if (!allHandles.includes(other)) ordered.push(other);
    }
    onChange({ mode: "selected", markets: ordered });
  };
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {title}
        </Text>
        <Text as="p" tone="subdued" variant="bodySm">
          Limit which markets can see this feature. It must also be enabled
          above to appear anywhere.
        </Text>
        {markets.length === 0 ? (
          <Text as="p" tone="subdued" variant="bodySm">
            No markets could be loaded — the feature follows the “All markets”
            setting.
          </Text>
        ) : null}
        <ChoiceList
          title="Market visibility"
          titleHidden
          choices={[
            { label: "All markets", value: "all" },
            {
              label: "Selected markets",
              value: "selected",
              renderChildren: (isSelected: boolean) =>
                isSelected ? (
                  <BlockStack gap="100">
                    {markets.map((market) => (
                      <Checkbox
                        key={market.handle}
                        label={
                          market.primary
                            ? `${market.name} (primary)`
                            : market.name
                        }
                        helpText={market.handle}
                        checked={scope.markets.includes(market.handle)}
                        onChange={(checked) =>
                          toggleMarket(market.handle, checked)
                        }
                      />
                    ))}
                    {scope.markets.length === 0 ? (
                      <Text as="p" tone="critical" variant="bodySm">
                        No markets selected — this feature won’t appear
                        anywhere.
                      </Text>
                    ) : null}
                  </BlockStack>
                ) : null,
            },
          ]}
          selected={[scope.mode]}
          onChange={handleModeChange}
        />
      </BlockStack>
    </Card>
  );
}

interface CheckoutFormState {
  upsellEnabled: boolean;
  upsellMode: "auto" | "manual";
  maxOffers: string;
  protectionEnabled: boolean;
  defaultOn: boolean;
  showRecommended: boolean;
  /** market handle -> protection amount as typed (string; "" = no price). */
  protectionPrices: Record<string, string>;
  trustEnabled: boolean;
  showGuarantee: boolean;
  showTrustpilot: boolean;
  showClinical: boolean;
  showBadges: boolean;
  /** v9 trust rows — FeatureKeys with their own market scopes below. */
  showCustoms: boolean;
  showTracked: boolean;
  /** v11: display order of the six trust lines (always a full permutation —
   *  normalized server-side in the loader, sanitized on save). */
  rowOrder: CheckoutTrustRow[];
  /** v12: per-market excluded products for the customs-free row
   *  (market handle -> product GIDs). */
  customsExcluded: Record<string, string[]>;
  /** v12: per-market excluded products for the tracked-delivery row
   *  (market handle -> product GIDs). */
  trackedExcluded: Record<string, string[]>;
  scopes: {
    checkout_upsell: ScopeState;
    checkout_protection: ScopeState;
    checkout_trust: ScopeState;
    checkout_customs: ScopeState;
    checkout_tracked: ScopeState;
  };
}

function protectionPricesToState(
  settings: BoosterSettings,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(settings.checkoutProtection.prices.byMarket).map(
      ([handle, entry]) => [handle, String(entry.amount)],
    ),
  );
}

function initialFormState(settings: BoosterSettings): CheckoutFormState {
  return {
    upsellEnabled: settings.checkoutUpsell.enabled,
    upsellMode: settings.checkoutUpsell.mode === "manual" ? "manual" : "auto",
    maxOffers: String(settings.checkoutUpsell.maxOffers),
    protectionEnabled: settings.checkoutProtection.enabled,
    defaultOn: settings.checkoutProtection.defaultOn,
    showRecommended: settings.checkoutProtection.showRecommended,
    protectionPrices: protectionPricesToState(settings),
    trustEnabled: settings.checkoutTrust.enabled,
    showGuarantee: settings.checkoutTrust.showGuarantee,
    showTrustpilot: settings.checkoutTrust.showTrustpilot,
    showClinical: settings.checkoutTrust.showClinical,
    showBadges: settings.checkoutTrust.showBadges,
    showCustoms: settings.checkoutTrust.showCustoms,
    showTracked: settings.checkoutTrust.showTracked,
    // Already normalized to a full permutation by the LOADER (server-side —
    // normalizeTrustRowOrder is a .server value and must never run in
    // client code). Fresh array copy so state edits never alias the source.
    rowOrder: [...settings.checkoutTrust.rowOrder],
    // v12: deep copies — state edits must never alias the loader settings.
    customsExcluded: Object.fromEntries(
      Object.entries(settings.checkoutTrust.customsExcludedByMarket).map(
        ([handle, gids]) => [handle, [...gids]],
      ),
    ),
    trackedExcluded: Object.fromEntries(
      Object.entries(settings.checkoutTrust.trackedExcludedByMarket).map(
        ([handle, gids]) => [handle, [...gids]],
      ),
    ),
    scopes: {
      checkout_upsell: toScopeState(settings.marketScopes.checkout_upsell),
      checkout_protection: toScopeState(
        settings.marketScopes.checkout_protection,
      ),
      checkout_trust: toScopeState(settings.marketScopes.checkout_trust),
      checkout_customs: toScopeState(settings.marketScopes.checkout_customs),
      checkout_tracked: toScopeState(settings.marketScopes.checkout_tracked),
    },
  };
}

/**
 * v11: label/help copy for each trust line plus the CheckoutFormState flag it
 * toggles. The card renders these in `state.rowOrder` order — the exact order
 * buyers see in checkout — with arrow buttons to reorder (the badges-page
 * pattern). Copy unchanged from the pre-v11 fixed checkboxes.
 */
const TRUST_LINE_META: Record<
  CheckoutTrustRow,
  {
    label: string;
    helpText?: string;
    field:
      | "showBadges"
      | "showGuarantee"
      | "showCustoms"
      | "showTracked"
      | "showClinical"
      | "showTrustpilot";
  }
> = {
  badges: { label: "Secure checkout badges", field: "showBadges" },
  guarantee: { label: "Money-back guarantee line", field: "showGuarantee" },
  customs: {
    label: "“No customs or additional fees” line",
    helpText:
      "V2 row with its own market targeting below — enable it only for markets where you genuinely cover customs and import fees.",
    field: "showCustoms",
  },
  tracked: {
    label: "Tracked delivery line with the guaranteed date",
    helpText:
      "V2 row: “Tracked Delivery · Guaranteed by …” — the date is the SAME guaranteed-by date as the Delivery guarantee (its schedule, country overrides and holidays), shown in the buyer's language. Hidden automatically until the buyer's shipping country is known and a date is computable. Own market targeting below. Stands alone: the row keeps rendering even while the Delivery guarantee feature is switched off (only the schedule values are shared) — turn this row off to stop the promise.",
    field: "showTracked",
  },
  clinical: { label: "Clinically proven line", field: "showClinical" },
  trustpilot: { label: "Trustpilot rating line", field: "showTrustpilot" },
};

const PROTECTION_PRICE_PATTERN = /^\d+(\.\d{1,2})?$/;

/** v12: key-order-normalized copy of an exclusion record so add-then-remove
 *  of a market compares clean in the dirty check. */
function sortedExclusionRecord(
  record: Record<string, string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Canonical [handle, amount] pairs for dirty comparison — empty rows are
 *  equivalent to missing rows, and typing order must not matter. */
function normalizedPriceEntries(
  prices: Record<string, string>,
): [string, string][] {
  return Object.entries(prices)
    .map(([handle, value]) => [handle, value.trim()] as [string, string])
    .filter(([, value]) => value !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Nearest ".90 / .00"-ending amount — suggested COPY only (the merchant
 *  picks the equivalent round number per currency; no FX math happens). */
function suggestRoundPrice(base: string | null | undefined): string | null {
  const value = Number(base);
  if (!Number.isFinite(value) || value <= 0) return null;
  const floor = Math.floor(value);
  const candidates = [floor - 0.1, floor, floor + 0.9, floor + 1].filter(
    (candidate) => candidate >= 0.9,
  );
  let best = candidates[0] ?? 0.9;
  for (const candidate of candidates) {
    if (Math.abs(candidate - value) < Math.abs(best - value)) best = candidate;
  }
  return best.toFixed(2);
}

function variantLabel(variant: VariantSummary): string {
  return variant.title && variant.title !== "Default Title"
    ? `${variant.productTitle} — ${variant.title}`
    : variant.productTitle;
}

export default function CheckoutFeaturesPage() {
  const {
    settings,
    upsellVariants,
    protectionVariant,
    markets,
    exclusionTitles,
    currentFixedPrices,
    headerEnabled,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<CheckoutFormState>(() =>
    initialFormState(settings),
  );
  const [selected, setSelected] = useState<VariantSummary[]>(upsellVariants);
  const [query, setQuery] = useState("");
  const [protectionPrice, setProtectionPrice] = useState(
    protectionVariant?.price ?? "2.95",
  );

  const initial = useMemo(() => initialFormState(settings), [settings]);
  const initialIds = useMemo(
    () => upsellVariants.map((variant) => variant.id).join(","),
    [upsellVariants],
  );
  const selectedIds = selected.map((variant) => variant.id).join(",");
  const dirty =
    JSON.stringify({
      ...state,
      scopes: scopesToPatch(state.scopes),
      protectionPrices: normalizedPriceEntries(state.protectionPrices),
      // v12: key order normalized so add-then-remove of a market compares
      // clean.
      customsExcluded: sortedExclusionRecord(state.customsExcluded),
      trackedExcluded: sortedExclusionRecord(state.trackedExcluded),
    }) !==
      JSON.stringify({
        ...initial,
        scopes: scopesToPatch(initial.scopes),
        protectionPrices: normalizedPriceEntries(initial.protectionPrices),
        // v12: same normalization on the baseline side.
        customsExcluded: sortedExclusionRecord(initial.customsExcluded),
        trackedExcluded: sortedExclusionRecord(initial.trackedExcluded),
      }) ||
    selectedIds !== initialIds;

  // v12: the action now also answers search_products (picker fetchers) —
  // toast + banner + adoption effects read only settings-save results.
  const saveResult =
    actionData && "syncErrors" in actionData ? actionData : undefined;

  /** Intent of the most recent submission, so the revalidation effect below
   *  knows whether fresh loader data may replace in-progress edits. */
  const lastSubmittedIntentRef = useRef<string | null>(null);
  /** v11: JSON snapshot of exactly what the last "save" submitted, so the
   *  post-save adoption below can tell "form unchanged since submit" (adopt
   *  fresh loader data wholesale) from "merchant kept editing during the
   *  round-trip" (keep the edits — they stay dirty against the fresh
   *  baseline). Without this, arrows clicked while a save was in flight
   *  were silently reverted when revalidation landed. */
  const submittedSnapshotRef = useRef<string | null>(null);

  useEffect(() => {
    const intent = lastSubmittedIntentRef.current;
    lastSubmittedIntentRef.current = null;
    if (intent === "ensure_protection") {
      // A successful create/verify only changes the protection product —
      // merge just that variant's data from the fresh loader and preserve
      // every other in-progress edit (and the dirty flag).
      // v12: read via saveResult — search_products responses carry none of
      // the settings-save fields.
      if (saveResult?.protection && saveResult.protection.errors.length === 0) {
        setProtectionPrice(protectionVariant?.price ?? "2.95");
      }
      return;
    }
    if (intent === "apply_protection_prices") {
      // The apply action persisted (a sanitized copy of) the submitted
      // per-market prices — adopt just that map from the fresh settings and
      // preserve every other in-progress edit.
      setState((previous) => ({
        ...previous,
        protectionPrices: protectionPricesToState(settings),
      }));
      return;
    }
    // Adopt fresh loader data wholesale only after a completed save whose
    // form has not been edited since submit, or when there are no unsaved
    // edits to lose (e.g. a background revalidation). Edits made WHILE the
    // save was in flight survive — they remain dirty against the fresh
    // baseline so the merchant can save again (the same
    // preserve-in-progress-edits behavior as the two intents above).
    if (intent === "save" && actionData?.ok !== false) {
      const snapshot = submittedSnapshotRef.current;
      submittedSnapshotRef.current = null;
      if (
        snapshot === null ||
        snapshot === JSON.stringify({ state, selectedIds })
      ) {
        setState(initialFormState(settings));
        setSelected(upsellVariants);
        setProtectionPrice(protectionVariant?.price ?? "2.95");
      }
      return;
    }
    if (!dirty) {
      setState(initialFormState(settings));
      setSelected(upsellVariants);
      setProtectionPrice(protectionVariant?.price ?? "2.95");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, upsellVariants, protectionVariant]);

  useEffect(() => {
    // v12: saveResult, not actionData — the search_products responses of
    // the exclusion pickers must never trigger a settings toast.
    if (!saveResult) return;
    if (saveResult.apply) {
      const applyFailed =
        saveResult.apply.errors.length > 0 ||
        saveResult.apply.results.some((result) => result.status === "failed");
      shopify.toast.show(
        applyFailed
          ? "Some protection prices could not be applied"
          : "Protection prices saved and applied to Shopify Markets",
        { isError: applyFailed },
      );
      return;
    }
    if (saveResult.protection) {
      if (saveResult.protection.errors.length > 0) {
        shopify.toast.show("Order Protection setup failed", { isError: true });
      } else {
        shopify.toast.show(
          saveResult.protection.created
            ? "Order Protection product created"
            : "Order Protection product verified",
        );
      }
      return;
    }
    if (!saveResult.ok) {
      shopify.toast.show("Could not save settings", { isError: true });
    } else if (saveResult.syncErrors.length > 0) {
      shopify.toast.show("Saved, but the storefront sync failed", {
        isError: true,
      });
    } else {
      shopify.toast.show("Saved");
    }
  }, [saveResult, shopify]);

  // Variant search via the /app/api/variants resource route.
  const variantSearch = useFetcher<typeof variantsLoader>();
  const loadVariants = variantSearch.load;
  const lastQueryRef = useRef("");
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "" || trimmed === lastQueryRef.current) return;
    const handle = setTimeout(() => {
      lastQueryRef.current = trimmed;
      loadVariants(`/app/api/variants?q=${encodeURIComponent(trimmed)}`);
    }, 350);
    return () => clearTimeout(handle);
  }, [query, loadVariants]);

  const searchResults = variantSearch.data?.variants ?? [];

  const pendingIntent =
    navigation.state !== "idle" && navigation.formData
      ? navigation.formData.get("intent")
      : null;
  const isSaving = pendingIntent === "save";
  const isEnsuringProtection = pendingIntent === "ensure_protection";
  const isApplyingPrices = pendingIntent === "apply_protection_prices";

  const addVariant = (variant: VariantSummary) => {
    setSelected((previous) =>
      previous.some((existing) => existing.id === variant.id)
        ? previous
        : [...previous, variant],
    );
  };

  const removeVariant = (variantId: string) => {
    setSelected((previous) =>
      previous.filter((variant) => variant.id !== variantId),
    );
  };

  /** v11: swap the trust line at `index` with its neighbor (badges-page
   *  moveBadge pattern) — rowOrder always stays a full permutation. */
  const moveTrustLine = (index: number, direction: -1 | 1) => {
    setState((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.rowOrder.length) return previous;
      const rowOrder = [...previous.rowOrder];
      const [moved] = rowOrder.splice(index, 1);
      rowOrder.splice(target, 0, moved);
      return { ...previous, rowOrder };
    });
  };

  const setScope = (
    key: keyof CheckoutFormState["scopes"],
    scope: ScopeState,
  ) => {
    setState((previous) => ({
      ...previous,
      scopes: { ...previous.scopes, [key]: scope },
    }));
  };

  // Per-market protection price validation + patch payload ------------------
  const protectionPriceErrors: Record<string, string | undefined> = {};
  for (const market of markets) {
    const raw = (state.protectionPrices[market.handle] ?? "").trim();
    if (
      raw !== "" &&
      (!PROTECTION_PRICE_PATTERN.test(raw) || Number(raw) > 1000)
    ) {
      protectionPriceErrors[market.handle] = "Enter a price like 4.90";
    }
  }
  const hasPriceErrors = Object.values(protectionPriceErrors).some(Boolean);

  const buildPricesByMarket = (): Record<
    string,
    { amount: number; currencyCode: string }
  > => {
    const byMarket: Record<string, { amount: number; currencyCode: string }> =
      {};
    for (const market of markets) {
      const raw = (state.protectionPrices[market.handle] ?? "").trim();
      if (raw === "" || !PROTECTION_PRICE_PATTERN.test(raw)) continue;
      if (!market.currencyCode) continue;
      byMarket[market.handle] = {
        amount: Number(raw),
        currencyCode: market.currencyCode,
      };
    }
    return byMarket;
  };

  const setProtectionMarketPrice = (handle: string, amount: string) => {
    setState((previous) => ({
      ...previous,
      protectionPrices: { ...previous.protectionPrices, [handle]: amount },
    }));
  };

  const handleSave = () => {
    const patch: DeepPartial<BoosterSettings> = {
      checkoutUpsell: {
        enabled: state.upsellEnabled,
        mode: state.upsellMode,
        variantIds: selected.map((variant) => variant.id),
        maxOffers: Number(state.maxOffers) || 2,
      },
      checkoutProtection: {
        enabled: state.protectionEnabled,
        defaultOn: state.defaultOn,
        showRecommended: state.showRecommended,
        // byMarket is replaced wholesale on save; omit it entirely when the
        // market list failed to load so a Save can't wipe existing prices.
        ...(markets.length > 0
          ? { prices: { byMarket: buildPricesByMarket() } }
          : {}),
      },
      checkoutTrust: {
        enabled: state.trustEnabled,
        showGuarantee: state.showGuarantee,
        showTrustpilot: state.showTrustpilot,
        showClinical: state.showClinical,
        showBadges: state.showBadges,
        showCustoms: state.showCustoms,
        showTracked: state.showTracked,
        rowOrder: state.rowOrder,
        // v12: wholesale-replaced records — always send the full maps (an
        // empty object clears every exclusion).
        customsExcludedByMarket: state.customsExcluded,
        trackedExcludedByMarket: state.trackedExcluded,
      },
      marketScopes: scopesToPatch(state.scopes),
    };
    const formData = new FormData();
    formData.set("intent", "save");
    formData.set("patch", JSON.stringify(patch));
    lastSubmittedIntentRef.current = "save";
    // Same shape as the adoption effect's comparison — a mismatch there
    // means the merchant kept editing during the save round-trip.
    submittedSnapshotRef.current = JSON.stringify({ state, selectedIds });
    submit(formData, { method: "post" });
  };

  const handleDiscard = () => {
    setState(initial);
    setSelected(upsellVariants);
  };

  const handleEnsureProtection = () => {
    const formData = new FormData();
    formData.set("intent", "ensure_protection");
    formData.set("price", protectionPrice.trim());
    lastSubmittedIntentRef.current = "ensure_protection";
    submit(formData, { method: "post" });
  };

  const handleApplyPrices = () => {
    const formData = new FormData();
    formData.set("intent", "apply_protection_prices");
    formData.set("prices", JSON.stringify(buildPricesByMarket()));
    lastSubmittedIntentRef.current = "apply_protection_prices";
    submit(formData, { method: "post" });
  };

  const priceValid = /^\d+(\.\d{1,2})?$/.test(protectionPrice.trim());
  const protectionConnected = Boolean(settings.checkoutProtection.variantId);
  const suggestedRoundPrice = suggestRoundPrice(protectionVariant?.price);
  const marketPriceCount = Object.keys(buildPricesByMarket()).length;
  // v12: read via saveResult (search_products responses carry no `apply`).
  const applyResult = saveResult?.apply ?? null;
  const applyTone: "success" | "warning" | "critical" | undefined = applyResult
    ? applyResult.errors.length > 0 ||
      applyResult.results.some((result) => result.status === "failed")
      ? "critical"
      : applyResult.results.some((result) => result.status === "skipped")
        ? "warning"
        : "success"
    : undefined;
  const marketNameByHandle = new Map(
    markets.map((market) => [market.handle, market.name]),
  );

  return (
    <Page
      title="Checkout"
      backAction={{ content: "Dashboard", url: "/app" }}
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        disabled: !dirty || hasPriceErrors,
        loading: isSaving,
      }}
      secondaryActions={[
        {
          content: "Discard",
          onAction: handleDiscard,
          disabled: !dirty || isSaving,
        },
      ]}
    >
      <TitleBar title="Checkout" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="checkout_upsell"
              enabled={headerEnabled}
            />
          </Card>
        </Layout.Section>

        {saveResult && saveResult.syncErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone={saveResult.ok ? "warning" : "critical"}
              title={
                saveResult.ok
                  ? "Saved, but the storefront sync reported errors"
                  : "Settings could not be saved"
              }
            >
              <BlockStack gap="100">
                {saveResult.syncErrors.map((error) => (
                  <Text as="p" key={error}>
                    {error}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Checkout upsell
                  </Text>
                  <Badge tone={state.upsellEnabled ? "success" : undefined}>
                    {state.upsellEnabled ? "Active" : "Off"}
                  </Badge>
                </InlineStack>
                <Checkbox
                  label="Enable checkout upsell offers"
                  helpText="“Complete your routine” offers rendered by the checkout UI extension. Variants already in the cart or out of stock are filtered out automatically."
                  checked={state.upsellEnabled}
                  onChange={(upsellEnabled) =>
                    setState((previous) => ({ ...previous, upsellEnabled }))
                  }
                />
                <Divider />
                <ChoiceList
                  title="Offer selection"
                  choices={[
                    {
                      label: "Automatic (recommended)",
                      value: "auto",
                      helpText:
                        "Offers are recommended from what's already in the checkout, powered by Shopify's recommendation engine. Curate complementary products in the Search & Discovery app to influence the results.",
                    },
                    {
                      label: "Hand-picked",
                      value: "manual",
                      helpText: "Offer exactly the variants you pick below.",
                    },
                  ]}
                  selected={[state.upsellMode]}
                  onChange={(selection) =>
                    setState((previous) => ({
                      ...previous,
                      upsellMode:
                        selection[0] === "manual" ? "manual" : "auto",
                    }))
                  }
                />
                {state.upsellMode === "manual" ? (
                  <>
                    <TextField
                      label="Search products to offer"
                      placeholder="Search by product title"
                      value={query}
                      onChange={setQuery}
                      autoComplete="off"
                      helpText="Pick the variants offered in checkout. The extension shows the first in-stock ones, up to the maximum below."
                    />
                    {variantSearch.state !== "idle" ? (
                      <InlineStack align="center">
                        <Spinner
                          size="small"
                          accessibilityLabel="Searching products"
                        />
                      </InlineStack>
                    ) : null}
                    {query.trim() !== "" && variantSearch.state === "idle" ? (
                      <BlockStack gap="200">
                        {searchResults.length === 0 && variantSearch.data ? (
                          <Text as="p" tone="subdued" variant="bodySm">
                            No variants matched “{query.trim()}”.
                          </Text>
                        ) : null}
                        {searchResults.map((variant) => {
                          const alreadySelected = selected.some(
                            (existing) => existing.id === variant.id,
                          );
                          return (
                            <InlineStack
                              key={variant.id}
                              gap="300"
                              align="space-between"
                              blockAlign="center"
                              wrap={false}
                            >
                              <InlineStack
                                gap="300"
                                blockAlign="center"
                                wrap={false}
                              >
                                <Thumbnail
                                  source={variant.imageUrl ?? ImageIcon}
                                  alt={variantLabel(variant)}
                                  size="small"
                                />
                                <BlockStack gap="050">
                                  <Text as="span" variant="bodyMd">
                                    {variantLabel(variant)}
                                  </Text>
                                  <Text
                                    as="span"
                                    tone="subdued"
                                    variant="bodySm"
                                  >
                                    {variant.price}
                                    {variant.availableForSale === false
                                      ? " · Out of stock"
                                      : ""}
                                  </Text>
                                </BlockStack>
                              </InlineStack>
                              <Button
                                size="slim"
                                onClick={() => addVariant(variant)}
                                disabled={alreadySelected}
                              >
                                {alreadySelected ? "Added" : "Add"}
                              </Button>
                            </InlineStack>
                          );
                        })}
                      </BlockStack>
                    ) : null}
                    {selected.length > 0 ? (
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          Selected variants
                        </Text>
                        <InlineStack gap="200" wrap>
                          {selected.map((variant) => (
                            <Tag
                              key={variant.id}
                              onRemove={() => removeVariant(variant.id)}
                            >
                              {variantLabel(variant)}
                            </Tag>
                          ))}
                        </InlineStack>
                      </BlockStack>
                    ) : (
                      <Text as="p" tone="subdued" variant="bodySm">
                        No variants selected yet — the checkout upsell stays
                        hidden until you pick at least one (or switch to
                        automatic recommendations).
                      </Text>
                    )}
                  </>
                ) : null}
                <Box maxWidth="200px">
                  <Select
                    label="Maximum offers shown"
                    options={[
                      { label: "1 offer", value: "1" },
                      { label: "2 offers", value: "2" },
                      { label: "3 offers", value: "3" },
                      { label: "4 offers", value: "4" },
                    ]}
                    value={state.maxOffers}
                    onChange={(maxOffers) =>
                      setState((previous) => ({ ...previous, maxOffers }))
                    }
                  />
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Order protection
                  </Text>
                  {protectionConnected ? (
                    protectionVariant ? (
                      <Badge tone="success">Product connected</Badge>
                    ) : (
                      <Badge tone="attention">Saved variant not found</Badge>
                    )
                  ) : (
                    <Badge tone="attention">No product yet</Badge>
                  )}
                </InlineStack>
                {saveResult?.protection ? (
                  saveResult.protection.errors.length > 0 ? (
                    <Banner
                      tone="critical"
                      title="Order Protection product setup failed"
                    >
                      <BlockStack gap="100">
                        {saveResult.protection.errors.map((error) => (
                          <Text as="p" key={error}>
                            {error}
                          </Text>
                        ))}
                      </BlockStack>
                    </Banner>
                  ) : (
                    <Banner tone="success">
                      <Text as="p">
                        {saveResult.protection.created
                          ? "Order Protection product created and connected to checkout."
                          : "Existing Order Protection product verified and connected to checkout."}
                      </Text>
                    </Banner>
                  )
                ) : null}
                {state.protectionEnabled && !protectionConnected ? (
                  <Banner tone="warning">
                    <Text as="p">
                      Order protection is enabled but no protection product is
                      connected yet — create or verify it below, then save.
                    </Text>
                  </Banner>
                ) : null}
                <Checkbox
                  label="Enable order protection in checkout"
                  helpText="Buyers can add loss, theft and damage protection with one tap."
                  checked={state.protectionEnabled}
                  onChange={(protectionEnabled) =>
                    setState((previous) => ({ ...previous, protectionEnabled }))
                  }
                />
                <Checkbox
                  label="Pre-select protection for the buyer"
                  helpText="Adds the protection line automatically once per checkout; buyers can always remove it."
                  checked={state.defaultOn}
                  onChange={(defaultOn) =>
                    setState((previous) => ({ ...previous, defaultOn }))
                  }
                />
                <Checkbox
                  label="Show the “Recommended” chip"
                  helpText="Displays a small “Recommended” badge on the protection offer in checkout."
                  checked={state.showRecommended}
                  onChange={(showRecommended) =>
                    setState((previous) => ({ ...previous, showRecommended }))
                  }
                />
                {protectionVariant ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Connected product: {variantLabel(protectionVariant)} —
                    current price {protectionVariant.price}.
                  </Text>
                ) : null}
                <InlineStack gap="300" blockAlign="end" wrap>
                  <Box width="200px">
                    <TextField
                      label="Protection price"
                      type="text"
                      value={protectionPrice}
                      onChange={setProtectionPrice}
                      error={
                        priceValid
                          ? undefined
                          : "Enter a price like 2.95 (shop currency)"
                      }
                      helpText="Used when the product is created. If it already exists, its current price is kept — edit it on the product page."
                      autoComplete="off"
                    />
                  </Box>
                  <Button
                    onClick={handleEnsureProtection}
                    loading={isEnsuringProtection}
                    disabled={!priceValid}
                  >
                    Create / verify protection product
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  The product is created as an active, non-taxable product
                  titled “Order Protection” and published to the Online Store
                  sales channel so checkout can add it as a cart line. Keep it
                  published — removing it from the channel breaks the checkout
                  toggle. To keep it out of sight, exclude it from your
                  collections, navigation and search results in the theme
                  instead.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Protection pricing per market
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Give each currency a round protection price. The amounts are
                  written to Shopify Markets as fixed prices on each market’s
                  price list, so the price displayed in checkout and the
                  amount charged match exactly — no FX conversion drift.
                </Text>
                {applyResult ? (
                  <Banner tone={applyTone} title="Shopify Markets price update">
                    <BlockStack gap="100">
                      {applyResult.errors.map((error) => (
                        <Text as="p" key={error}>
                          {error}
                        </Text>
                      ))}
                      {applyResult.results.map((result) => (
                        <Text as="p" key={result.market}>
                          {marketNameByHandle.get(result.market) ??
                            result.market}
                          {" — "}
                          {result.status === "applied"
                            ? "Applied"
                            : result.status === "failed"
                              ? "Failed"
                              : "Skipped"}
                          : {result.detail}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                ) : null}
                {markets.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No markets could be loaded — per-market prices are
                    unavailable right now.
                  </Text>
                ) : (
                  <BlockStack gap="300">
                    {markets.map((market) => {
                      const currentPrice = currentFixedPrices[market.handle];
                      const helpParts: string[] = [];
                      if (currentPrice) {
                        helpParts.push(
                          `Current fixed price on Shopify: ${currentPrice.amount} ${currentPrice.currencyCode}.`,
                        );
                      }
                      if (suggestedRoundPrice && protectionVariant) {
                        helpParts.push(
                          `Suggested: ${suggestedRoundPrice} (base price ${protectionVariant.price} rounded to a .90/.00 ending — pick the equivalent round number in ${market.currencyCode || "the market currency"}).`,
                        );
                      }
                      return (
                        <InlineStack
                          key={market.handle}
                          gap="300"
                          blockAlign="start"
                          wrap={false}
                        >
                          <Box width="220px" paddingBlockStart="150">
                            <BlockStack gap="050">
                              <Text as="span" variant="bodyMd">
                                {market.primary
                                  ? `${market.name} (primary)`
                                  : market.name}
                              </Text>
                              <Text as="span" tone="subdued" variant="bodySm">
                                {market.handle}
                              </Text>
                            </BlockStack>
                          </Box>
                          <Box width="260px">
                            <TextField
                              label={`Protection price — ${market.name}`}
                              labelHidden
                              type="text"
                              prefix={market.currencyCode || "—"}
                              placeholder={suggestedRoundPrice ?? ""}
                              value={
                                state.protectionPrices[market.handle] ?? ""
                              }
                              onChange={(amount) =>
                                setProtectionMarketPrice(market.handle, amount)
                              }
                              error={protectionPriceErrors[market.handle]}
                              disabled={!market.currencyCode}
                              helpText={
                                market.currencyCode
                                  ? helpParts.join(" ")
                                  : "Market currency unknown — refresh the page or check the market's settings."
                              }
                              autoComplete="off"
                            />
                          </Box>
                        </InlineStack>
                      );
                    })}
                    <InlineStack gap="300" blockAlign="center" wrap>
                      <Button
                        onClick={handleApplyPrices}
                        loading={isApplyingPrices}
                        disabled={
                          !protectionConnected ||
                          hasPriceErrors ||
                          marketPriceCount === 0
                        }
                      >
                        Apply to Shopify Markets
                      </Button>
                      <Text as="span" tone="subdued" variant="bodySm">
                        Saves the amounts above and writes them as fixed
                        prices to each market’s price list.
                      </Text>
                    </InlineStack>
                    {!protectionConnected ? (
                      <Text as="p" tone="subdued" variant="bodySm">
                        Connect the Order Protection product above before
                        applying prices.
                      </Text>
                    ) : null}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Checkout trust module
                  </Text>
                  <Badge tone={state.trustEnabled ? "success" : undefined}>
                    {state.trustEnabled ? "Active" : "Off"}
                  </Badge>
                </InlineStack>
                <Checkbox
                  label="Enable the trust module"
                  helpText="Compact reassurance block (display only, no cart changes)."
                  checked={state.trustEnabled}
                  onChange={(trustEnabled) =>
                    setState((previous) => ({ ...previous, trustEnabled }))
                  }
                />
                <Divider />
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Lines (display order)
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Buyers see the checked lines in this order — use the
                    arrows to reorder. The order applies live after you save.
                  </Text>
                  {state.rowOrder.map((rowKey, index) => {
                    const meta = TRUST_LINE_META[rowKey];
                    return (
                      <InlineStack
                        key={rowKey}
                        gap="200"
                        align="space-between"
                        blockAlign="start"
                        wrap={false}
                      >
                        <Checkbox
                          label={meta.label}
                          helpText={meta.helpText}
                          checked={state[meta.field]}
                          onChange={(checked) =>
                            setState((previous) => ({
                              ...previous,
                              [meta.field]: checked,
                            }))
                          }
                        />
                        <InlineStack gap="100" wrap={false}>
                          <Button
                            icon={ArrowUpIcon}
                            variant="tertiary"
                            accessibilityLabel={`Move “${meta.label}” up`}
                            disabled={index === 0}
                            onClick={() => moveTrustLine(index, -1)}
                          />
                          <Button
                            icon={ArrowDownIcon}
                            variant="tertiary"
                            accessibilityLabel={`Move “${meta.label}” down`}
                            disabled={index === state.rowOrder.length - 1}
                            onClick={() => moveTrustLine(index, 1)}
                          />
                        </InlineStack>
                      </InlineStack>
                    );
                  })}
                </BlockStack>
              </BlockStack>
            </Card>

            <MarketScopeCard
              title="Markets — Checkout upsell"
              markets={markets}
              scope={state.scopes.checkout_upsell}
              onChange={(scope) => setScope("checkout_upsell", scope)}
            />
            <MarketScopeCard
              title="Markets — Order protection"
              markets={markets}
              scope={state.scopes.checkout_protection}
              onChange={(scope) => setScope("checkout_protection", scope)}
            />
            <MarketScopeCard
              title="Markets — Trust module"
              markets={markets}
              scope={state.scopes.checkout_trust}
              onChange={(scope) => setScope("checkout_trust", scope)}
            />
            <MarketScopeCard
              title="Markets — Customs-free delivery line"
              markets={markets}
              scope={state.scopes.checkout_customs}
              onChange={(scope) => setScope("checkout_customs", scope)}
            />
            <MarketScopeCard
              title="Markets — Tracked delivery line"
              markets={markets}
              scope={state.scopes.checkout_tracked}
              onChange={(scope) => setScope("checkout_tracked", scope)}
            />

            {/* v12: per-market product exclusions for the two V2 trust rows */}
            <MarketProductExclusionsCard
              title="Excluded products — customs-free row"
              description="When a cart contains one of these products in that market, buyers do not see the customs-free line at checkout."
              markets={markets}
              value={state.customsExcluded}
              titles={exclusionTitles}
              disabled={isSaving}
              onChange={(next) =>
                setState((previous) => ({ ...previous, customsExcluded: next }))
              }
            />
            <MarketProductExclusionsCard
              title="Excluded products — tracked-delivery row"
              description="When a cart contains one of these products in that market, buyers do not see the tracked-delivery promise at checkout."
              markets={markets}
              value={state.trackedExcluded}
              titles={exclusionTitles}
              disabled={isSaving}
              onChange={(next) =>
                setState((previous) => ({ ...previous, trackedExcluded: next }))
              }
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
