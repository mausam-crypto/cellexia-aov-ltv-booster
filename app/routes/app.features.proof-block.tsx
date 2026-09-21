import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
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
  Link,
  Page,
  RangeSlider,
  Text,
} from "@shopify/polaris";
import { ArrowDownIcon, ArrowUpIcon, DeleteIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  BUY_BOX_PROOF_MAX_BADGES,
  BUY_BOX_RATING_SCALE_MAX,
  BUY_BOX_RATING_SCALE_MIN,
  getSettings,
  resolveFeatureFlag,
  saveSettings,
  type BoosterSettings,
  type DeepPartial,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { listMarkets } from "../services/markets.server";
import { FeaturePageHeader } from "../components/FeaturePageHeader";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface SettingsSaveResult {
  ok: boolean;
  syncErrors: string[];
}

async function applySettingsPatch(
  shop: string,
  admin: AdminGraphqlClient,
  rawPatch: FormDataEntryValue | null,
): Promise<SettingsSaveResult> {
  if (typeof rawPatch !== "string" || rawPatch.trim() === "") {
    return { ok: false, syncErrors: ["Missing settings payload."] };
  }
  let patch: DeepPartial<BoosterSettings>;
  try {
    const parsed: unknown = JSON.parse(rawPatch);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, syncErrors: ["Settings payload must be an object."] };
    }
    patch = parsed as DeepPartial<BoosterSettings>;
  } catch {
    return { ok: false, syncErrors: ["Settings payload was not valid JSON."] };
  }
  const next = await saveSettings(shop, patch);
  try {
    const sync = await syncSettingsToMetafields(admin, next);
    return { ok: true, syncErrors: sync.errors };
  } catch (error) {
    return {
      ok: true,
      syncErrors: [
        error instanceof Error
          ? error.message
          : "Could not sync settings to storefront metafields.",
      ],
    };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const [settings, markets] = await Promise.all([
    getSettings(session.shop),
    listMarkets(admin),
  ]);
  return {
    settings,
    markets,
    // v22: the origin the parameter-gate example links are built on. The
    // .myshopify domain always resolves and keeps the query string through
    // the redirect to a custom domain, so it works without a second query.
    storeUrl: `https://${session.shop}`,
    headerEnabled: resolveFeatureFlag(settings, "buy_box_proof"),
    // The sanitizer's caps travel through the loader: a route's CLIENT
    // bundle may not reference settings.server VALUES at module scope
    // (the v8.3 build lesson), only its types.
    caps: {
      badges: BUY_BOX_PROOF_MAX_BADGES,
      // v30 rating-row size slider bounds (min doubles as the default).
      ratingScaleMin: BUY_BOX_RATING_SCALE_MIN,
      ratingScaleMax: BUY_BOX_RATING_SCALE_MAX,
    },
    // Every fact the block borrows, surfaced so the merchant can see WHY a
    // row would stay hidden without leaving this page (the v13.2 lesson:
    // controls that live far from the toggle they govern are unfindable).
    sources: {
      warehouseMapped:
        Object.keys(settings.amazon.shipsFromByCountry).length > 0 ||
        settings.amazon.defaultWarehouse !== "",
      deliveryConfigured:
        settings.deliveryEstimate.maxDays >= settings.deliveryEstimate.minDays &&
        settings.deliveryEstimate.deliveryDays.length > 0,
      guaranteeDays: settings.guarantee.days,
      rating: settings.trustpilot.rating,
      reviewCount: settings.trustpilot.reviewCount,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
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

function toScopePatch(scope: ScopeState): ScopeState {
  return scope.mode === "all" ? { mode: "all", markets: [] } : scope;
}

interface MarketOption {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
  primary: boolean;
}

function MarketScopeCard({
  markets,
  scope,
  onChange,
}: {
  markets: MarketOption[];
  scope: ScopeState;
  onChange: (scope: ScopeState) => void;
}) {
  const allHandles = markets.map((market) => market.handle);
  const handleModeChange = (selected: string[]) => {
    const mode = selected[0] === "selected" ? "selected" : "all";
    if (mode === scope.mode) return;
    onChange(
      mode === "all"
        ? { mode: "all", markets: [...scope.markets] }
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
          Markets
        </Text>
        <Text as="p" tone="subdued" variant="bodySm">
          Limit which markets can see the block. Selections save even while the
          block is off, so targeting can be set up before it goes live.
        </Text>
        {markets.length === 0 ? (
          <Text as="p" tone="subdued" variant="bodySm">
            No markets could be loaded — the block follows the “All markets”
            default.
          </Text>
        ) : (
          <>
            <ChoiceList
              title="Market reach"
              titleHidden
              choices={[
                { label: "All markets", value: "all" },
                { label: "Selected markets", value: "selected" },
              ]}
              selected={[scope.mode]}
              onChange={handleModeChange}
            />
            {scope.mode === "selected" ? (
              <Box paddingInlineStart="400">
                <BlockStack gap="150">
                  {markets.map((market) => (
                    <Checkbox
                      key={market.handle}
                      label={
                        market.primary ? `${market.name} (primary)` : market.name
                      }
                      checked={scope.markets.includes(market.handle)}
                      onChange={(checked) =>
                        toggleMarket(market.handle, checked)
                      }
                    />
                  ))}
                </BlockStack>
              </Box>
            ) : null}
          </>
        )}
      </BlockStack>
    </Card>
  );
}

// ---------------------------------------------------------------------------

const BADGE_OPTIONS: { key: string; label: string }[] = [
  { key: "secure_checkout", label: "Secure checkout" },
  { key: "free_shipping_over", label: "Free shipping over threshold" },
  { key: "money_back", label: "Money-back guarantee" },
  { key: "dermatologist_tested", label: "Dermatologist tested" },
  { key: "cruelty_free", label: "Cruelty free" },
  { key: "clinically_proven", label: "Clinically proven" },
  { key: "ssl_encrypted", label: "SSL-encrypted payment" },
  { key: "easy_returns", label: "Easy returns" },
];

function badgeLabel(key: string): string {
  return BADGE_OPTIONS.find((option) => option.key === key)?.label ?? key;
}

interface ProofBlockFormState {
  enabled: boolean;
  showShipsFrom: boolean;
  showDelivery: boolean;
  showDeliveryBadge: boolean;
  badges: string[];
  showGuarantee: boolean;
  showRating: boolean;
  /** v30: whole percent of the designed rating-row size (100 = as today). */
  ratingScale: number;
  scope: ScopeState;
}

function initialFormState(settings: BoosterSettings): ProofBlockFormState {
  const block = settings.buyBoxProof;
  return {
    enabled: block.enabled,
    showShipsFrom: block.showShipsFrom,
    showDelivery: block.showDelivery,
    showDeliveryBadge: block.showDeliveryBadge,
    badges: [...block.badges],
    showGuarantee: block.showGuarantee,
    showRating: block.showRating,
    // v30: sanitize clamps this server-side, but a stored blob predating
    // the field still reaches the loader — default it so state stays typed.
    ratingScale:
      typeof block.ratingScale === "number" && Number.isFinite(block.ratingScale)
        ? Math.round(block.ratingScale)
        : 100,
    scope: toScopeState(settings.marketScopes.buy_box_proof),
  };
}

/**
 * v30: to-scale mock of the storefront rating row, drawn with the SAME pixel
 * formulas the stylesheet derives from `--cxtp` (stars 17px, star gap 2px,
 * score 15px, count 13px, wordmark 14px + its 15px star, row gap 6×10px —
 * each × factor) and the storefront's own star artwork and colors, so the
 * slider is honest about what saves. Typeface aside (the storefront uses the
 * theme's fonts), what you see is what ships.
 */
function RatingRowMock({
  factor,
  rating,
  reviewCount,
}: {
  factor: number;
  rating: number;
  reviewCount: number;
}) {
  const starPath =
    "M10 1.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L1.6 7.7l5.8-.8z";
  const clamped = Math.min(5, Math.max(0, rating));
  // v30.1 Trustpilot display rule (twinned with cxStarsSvgs): the star
  // IMAGE snaps to the nearest half star — 4.8 previews five FULL stars —
  // while the score text beside it keeps the raw value.
  const snapped = Math.round(clamped * 2) / 2;
  const stars = Array.from({ length: 5 }, (_, index) => {
    const part = Math.min(1, Math.max(0, snapped - index));
    const pct = Math.round(part * 100);
    const gid = `cx-admin-tp-${index}-${pct}`;
    const size = Math.round(17 * factor);
    return (
      <svg
        key={index}
        width={size}
        height={size}
        viewBox="0 0 20 20"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
            <stop offset={`${pct}%`} stopColor="#00b67a" />
            <stop offset={`${pct}%`} stopColor="#d8d8d8" />
          </linearGradient>
        </defs>
        <path fill={`url(#${gid})`} d={starPath} />
      </svg>
    );
  });
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: `${6 * factor}px ${10 * factor}px`,
        padding: 12,
        background: "#fff",
        border: "1px solid #e3e3e3",
        borderRadius: 8,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 2 * factor,
          lineHeight: 0,
        }}
      >
        {stars}
      </span>
      <span style={{ fontWeight: 700, fontSize: 15 * factor }}>
        {`${rating}/5`}
      </span>
      <span style={{ fontSize: 13 * factor, color: "#565959" }}>
        {`${reviewCount} reviews on`}
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4 * factor,
          fontWeight: 700,
          fontSize: 14 * factor,
          color: "#1d1d1b",
        }}
      >
        <svg
          width={Math.round(15 * factor)}
          height={Math.round(15 * factor)}
          viewBox="0 0 20 20"
          fill="#00b67a"
          aria-hidden="true"
          focusable="false"
        >
          <path d={starPath} />
        </svg>
        Trustpilot
      </span>
    </div>
  );
}

export default function ProofBlockPage() {
  const { settings, markets, headerEnabled, sources, caps, storeUrl } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<ProofBlockFormState>(() =>
    initialFormState(settings),
  );

  useEffect(() => {
    setState(initialFormState(settings));
  }, [settings]);

  useEffect(() => {
    if (!actionData) return;
    if (!actionData.ok) {
      shopify.toast.show("Could not save settings", { isError: true });
    } else if (actionData.syncErrors.length > 0) {
      shopify.toast.show("Saved, but the storefront sync failed", {
        isError: true,
      });
    } else {
      shopify.toast.show("Saved");
    }
  }, [actionData, shopify]);

  const initial = useMemo(() => initialFormState(settings), [settings]);
  const dirty =
    JSON.stringify({ ...state, scope: toScopePatch(state.scope) }) !==
    JSON.stringify({ ...initial, scope: toScopePatch(initial.scope) });
  const isSaving =
    navigation.state !== "idle" && navigation.formMethod === "POST";

  const toggleBadge = (key: string) => {
    setState((previous) => ({
      ...previous,
      badges: previous.badges.includes(key)
        ? previous.badges.filter((item) => item !== key)
        : previous.badges.length >= caps.badges
          ? previous.badges
          : [...previous.badges, key],
    }));
  };

  const moveBadge = (index: number, direction: -1 | 1) => {
    setState((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.badges.length) return previous;
      const badges = [...previous.badges];
      const [moved] = badges.splice(index, 1);
      badges.splice(target, 0, moved);
      return { ...previous, badges };
    });
  };

  const handleSave = () => {
    const patch: DeepPartial<BoosterSettings> = {
      buyBoxProof: {
        enabled: state.enabled,
        showShipsFrom: state.showShipsFrom,
        showDelivery: state.showDelivery,
        showDeliveryBadge: state.showDeliveryBadge,
        badges: state.badges,
        showGuarantee: state.showGuarantee,
        showRating: state.showRating,
        ratingScale: state.ratingScale,
      },
      marketScopes: { buy_box_proof: toScopePatch(state.scope) },
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  const availableBadges = BADGE_OPTIONS.filter(
    (option) => !state.badges.includes(option.key),
  );

  return (
    <Page
      title="Buy-box proof block"
      backAction={{ content: "Dashboard", url: "/app" }}
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        disabled: !dirty,
        loading: isSaving,
      }}
      secondaryActions={[
        {
          content: "Discard",
          onAction: () => setState(initial),
          disabled: !dirty || isSaving,
        },
      ]}
    >
      <TitleBar title="Buy-box proof block" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="buy_box_proof"
              enabled={headerEnabled}
              reachCaption={
                state.scope.mode === "all"
                  ? "All markets"
                  : `${state.scope.markets.length} market${state.scope.markets.length === 1 ? "" : "s"}`
              }
            />
          </Card>
        </Layout.Section>

        {actionData && actionData.syncErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone={actionData.ok ? "warning" : "critical"}
              title={
                actionData.ok
                  ? "Saved, but the storefront sync reported errors"
                  : "Settings could not be saved"
              }
            >
              <BlockStack gap="100">
                {actionData.syncErrors.map((error) => (
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
            <Banner tone="info" title="This block takes over the buy-box area">
              <BlockStack gap="200">
                <Text as="p">
                  While it is live on a product page it renders the ships-from
                  line, the delivery date, the icon row, the money-back card and
                  the rating row itself — so the older single widgets are hidden
                  there to avoid duplicates: <b>Trust badges</b>,{" "}
                  <b>Trustpilot</b>, <b>Money-back guarantee</b>, the product-page{" "}
                  <b>Delivery guarantee</b> widget, and the Amazon{" "}
                  <b>Trust microcopy</b> and <b>Ships from</b> lines. They keep
                  their own settings and stay live everywhere else (cart,
                  checkout). The dispatch countdown is untouched.
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Nothing is duplicated in the data either — the numbers come
                  from the features that already own them.{" "}
                  <Link url="/app/features/amazon">Warehouse map</Link>,{" "}
                  <Link url="/app/features/delivery">delivery estimate</Link> and{" "}
                  <Link url="/app/features/badges">
                    guarantee, rating and badge labels
                  </Link>{" "}
                  are edited on their own pages.
                </Text>
              </BlockStack>
            </Banner>

            <Card>
              <BlockStack gap="300">
                <Checkbox
                  label="Show the buy-box proof block on product pages"
                  helpText="Renders under the Add-to-cart panel, above the product accordions. Preview it before going live."
                  checked={state.enabled}
                  onChange={(enabled) =>
                    setState((previous) => ({ ...previous, enabled }))
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Delivery rows
                </Text>
                <Checkbox
                  label="Ships from — country line"
                  helpText="Uses the shared warehouse map on the Amazon patterns page. The country name is translated automatically and stays grammatical in every language; no warehouse for a buyer's country means the row is simply hidden."
                  checked={state.showShipsFrom}
                  onChange={(showShipsFrom) =>
                    setState((previous) => ({ ...previous, showShipsFrom }))
                  }
                />
                {state.showShipsFrom && !sources.warehouseMapped ? (
                  <Banner tone="warning">
                    <Text as="p">
                      No warehouse is mapped yet, so this row will not appear.
                      Set one on the{" "}
                      <Link url="/app/features/amazon">Amazon patterns</Link>{" "}
                      page (“Ships from”).
                    </Text>
                  </Banner>
                ) : null}
                <Checkbox
                  label="Get it by — delivery date"
                  helpText="Computed by the shared delivery engine (cut-off, dispatch days, destination holidays). No defensible date means no row — it never shows a vague promise."
                  checked={state.showDelivery}
                  onChange={(showDelivery) =>
                    setState((previous) => ({ ...previous, showDelivery }))
                  }
                />
                {state.showDelivery && !sources.deliveryConfigured ? (
                  <Banner tone="warning">
                    <Text as="p">
                      The delivery windows look incomplete, so this row may stay
                      hidden. Check the{" "}
                      <Link url="/app/features/delivery">Delivery</Link> page.
                    </Text>
                  </Banner>
                ) : null}
                <Box paddingInlineStart="600">
                  <Checkbox
                    label="“Delivery guarantee” pill next to the date"
                    checked={state.showDeliveryBadge}
                    disabled={!state.showDelivery}
                    onChange={(showDeliveryBadge) =>
                      setState((previous) => ({
                        ...previous,
                        showDeliveryBadge,
                      }))
                    }
                  />
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Icon row
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Up to {caps.badges} badges, in this order. Labels
                  are translated by the theme extension; amounts and day counts
                  fill in automatically.
                </Text>
                {state.badges.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No badges selected — the icon row is hidden.
                  </Text>
                ) : (
                  <BlockStack gap="150">
                    {state.badges.map((key, index) => (
                      <InlineStack
                        key={key}
                        gap="200"
                        blockAlign="center"
                        align="space-between"
                      >
                        <Text as="span">{badgeLabel(key)}</Text>
                        <InlineStack gap="100">
                          <Button
                            icon={ArrowUpIcon}
                            accessibilityLabel={`Move ${badgeLabel(key)} up`}
                            disabled={index === 0}
                            onClick={() => moveBadge(index, -1)}
                          />
                          <Button
                            icon={ArrowDownIcon}
                            accessibilityLabel={`Move ${badgeLabel(key)} down`}
                            disabled={index === state.badges.length - 1}
                            onClick={() => moveBadge(index, 1)}
                          />
                          <Button
                            icon={DeleteIcon}
                            accessibilityLabel={`Remove ${badgeLabel(key)}`}
                            onClick={() => toggleBadge(key)}
                          />
                        </InlineStack>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
                {availableBadges.length > 0 &&
                state.badges.length < caps.badges ? (
                  <>
                    <Divider />
                    <InlineStack gap="200" wrap>
                      {availableBadges.map((option) => (
                        <Button
                          key={option.key}
                          onClick={() => toggleBadge(option.key)}
                        >
                          {`Add ${option.label}`}
                        </Button>
                      ))}
                    </InlineStack>
                  </>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Guarantee and rating
                </Text>
                <Checkbox
                  label={`Money-back card (${sources.guaranteeDays}-day window)`}
                  helpText="The window comes from the guarantee setting on the Trust & badges page."
                  checked={state.showGuarantee}
                  onChange={(showGuarantee) =>
                    setState((previous) => ({ ...previous, showGuarantee }))
                  }
                />
                <Checkbox
                  label={`Rating row (${sources.rating}/5, ${sources.reviewCount} reviews)`}
                  helpText="Stars, score, review count and the review-platform link all come from the Trustpilot settings on the Trust & badges page."
                  checked={state.showRating}
                  onChange={(showRating) =>
                    setState((previous) => ({ ...previous, showRating }))
                  }
                />
                <RangeSlider
                  label={`Rating row size: ${state.ratingScale}%`}
                  min={caps.ratingScaleMin}
                  max={caps.ratingScaleMax}
                  step={5}
                  value={state.ratingScale}
                  output
                  helpText={
                    state.ratingScale <= 100
                      ? "100% is the current design — nothing changes until you raise it."
                      : "Stars, score, review count and the Trustpilot wordmark scale together. Applies live after you save."
                  }
                  onChange={(value) =>
                    setState((previous) => ({
                      ...previous,
                      ratingScale: Math.round(
                        typeof value === "number" ? value : value[0],
                      ),
                    }))
                  }
                />
                <BlockStack gap="150">
                  <RatingRowMock
                    factor={state.ratingScale / 100}
                    rating={sources.rating}
                    reviewCount={sources.reviewCount}
                  />
                  <Text as="span" tone="subdued" variant="bodySm">
                    To scale — exact storefront sizes and colors (the
                    storefront uses your theme&rsquo;s typeface, and the row
                    text follows the buyer&rsquo;s language).
                  </Text>
                </BlockStack>
              </BlockStack>
            </Card>

            <Banner tone="info" title="The research band and the award strip are their own features now">
              <Text as="p" variant="bodySm">
                They still render directly under this block on the product
                page (award strip first, then the research band), but each
                has its own switch, market targeting, preview flag and
                tagged-link control on its own page:{" "}
                <Link url="/app/features/award-strip">Award strip</Link> and{" "}
                <Link url="/app/features/research-band">Research band</Link>.
                Neither needs this block to be on.
              </Text>
            </Banner>

            <MarketScopeCard
              markets={markets}
              scope={state.scope}
              onChange={(scope) =>
                setState((previous) => ({ ...previous, scope }))
              }
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
