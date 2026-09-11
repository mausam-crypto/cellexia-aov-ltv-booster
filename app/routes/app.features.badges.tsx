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
  Page,
  RangeSlider,
  Text,
  TextField,
} from "@shopify/polaris";
import { ArrowDownIcon, ArrowUpIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getSettings,
  resolveFeatureFlag,
  saveSettings,
  IMAGE_BADGE_BASE_PX,
  IMAGE_BADGE_DEFAULT_SCALE,
  IMAGE_BADGE_MAX_IMAGE_SHARE,
  IMAGE_BADGE_MAX_ROW_SHARE,
  IMAGE_BADGE_SCALE_MAX,
  IMAGE_BADGE_SCALE_MIN,
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
    // Combined flag for the shared page header (cheap — settings loaded).
    headerEnabled: resolveFeatureFlag(settings, "trust_badges"),
    // v20: the storefront's sizing constants travel through the loader —
    // a route's client bundle may not reference settings.server at module
    // scope (the v8.3 build lesson).
    imageBadgeCaps: {
      basePx: IMAGE_BADGE_BASE_PX,
      scaleMin: IMAGE_BADGE_SCALE_MIN,
      scaleMax: IMAGE_BADGE_SCALE_MAX,
      defaultScale: IMAGE_BADGE_DEFAULT_SCALE,
      maxImageShare: IMAGE_BADGE_MAX_IMAGE_SHARE,
      maxRowShare: IMAGE_BADGE_MAX_ROW_SHARE,
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

/**
 * Canonical badge catalog. Keys map to icons + translated labels in the theme
 * extension (`badges.*` locale strings); amounts and day counts are filled in
 * automatically from the free-shipping threshold and guarantee settings.
 */
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

/**
 * v20 — what the storefront will actually do, computed for a REFERENCE
 * phone so the merchant can see the result before going live.
 *
 * Geometry measured on the live Sleepify PDP (2026-09-11), and linear in the
 * viewport across the whole phone range (320/375/414 px all agree):
 *   image column  = viewport - 2 x 20px page gutter
 *   product image = that column - 2 x 12px slide padding
 *   badge row     = right-anchored 15px inside the column (theme CSS)
 * The clamp itself is the storefront's (cellexia-pdp.js ibSizeFor): a badge
 * never wider than `maxImageShare` of the image, a row never wider than
 * `maxRowShare` of it or past the image's left edge, and never smaller than
 * the theme's own size.
 */
const IMAGE_BADGE_REFERENCE_VW = 375;
/** Width of the to-scale mock in the admin, in CSS px. */
const PREVIEW_BOX_PX = 180;

interface ImageBadgeCaps {
  basePx: number;
  scaleMin: number;
  scaleMax: number;
  defaultScale: number;
  maxImageShare: number;
  maxRowShare: number;
}

interface ImageBadgePreview {
  /** Width one badge will get, in CSS px. */
  px: number;
  /** The product image's width on the reference phone, in CSS px. */
  imageWidth: number;
  /** Share of the image width the whole row takes, 0-1. */
  rowShare: number;
  /** True when the clamp — not the merchant's percentage — decided the size. */
  clamped: boolean;
}

function imageBadgePreview(
  scale: number,
  badgeCount: number,
  caps: ImageBadgeCaps,
  viewport: number = IMAGE_BADGE_REFERENCE_VW,
): ImageBadgePreview {
  const column = viewport - 40;
  const imageWidth = column - 24;
  const imageLeft = 20 + 12;
  const imageRight = imageLeft + imageWidth;
  const rowRight = 20 + column - 15;
  const inset = Math.max(0, imageRight - rowRight);
  const room = rowRight - imageLeft - inset;
  const maxRow = Math.min(room, imageWidth * caps.maxRowShare);
  const maxOne = Math.min(imageWidth * caps.maxImageShare, maxRow / badgeCount);
  const want = (caps.basePx * scale) / 100;
  const px = Math.max(caps.basePx, Math.floor(Math.min(want, maxOne)));
  return {
    px,
    imageWidth,
    rowShare: (px * badgeCount) / imageWidth,
    clamped: px < Math.floor(want),
  };
}

interface BadgesFormState {
  badgesEnabled: boolean;
  style: "light" | "dark";
  items: string[];
  trustpilotEnabled: boolean;
  rating: number;
  reviewCount: string;
  profileUrl: string;
  showLink: boolean;
  guaranteeEnabled: boolean;
  days: string;
  imageBadgesEnabled: boolean;
  imageBadgesScale: number;
  scopes: {
    trust_badges: ScopeState;
    trustpilot: ScopeState;
    guarantee: ScopeState;
    image_badges: ScopeState;
  };
}

function initialFormState(settings: BoosterSettings): BadgesFormState {
  return {
    badgesEnabled: settings.trustBadges.enabled,
    style: settings.trustBadges.style === "dark" ? "dark" : "light",
    items: [...settings.trustBadges.items],
    trustpilotEnabled: settings.trustpilot.enabled,
    rating: settings.trustpilot.rating,
    reviewCount: String(settings.trustpilot.reviewCount),
    profileUrl: settings.trustpilot.profileUrl,
    showLink: settings.trustpilot.showLink,
    guaranteeEnabled: settings.guarantee.enabled,
    days: String(settings.guarantee.days),
    imageBadgesEnabled: settings.imageBadges.enabled,
    imageBadgesScale: settings.imageBadges.scale,
    scopes: {
      trust_badges: toScopeState(settings.marketScopes.trust_badges),
      trustpilot: toScopeState(settings.marketScopes.trustpilot),
      guarantee: toScopeState(settings.marketScopes.guarantee),
      image_badges: toScopeState(settings.marketScopes.image_badges),
    },
  };
}

export default function BadgesFeaturesPage() {
  const { settings, markets, headerEnabled, imageBadgeCaps } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<BadgesFormState>(() =>
    initialFormState(settings),
  );
  // Preview-only: how many badges this product carries. Not persisted — the
  // badge list lives in the THEME's own metafields, per product and market.
  const [previewBadgeCount, setPreviewBadgeCount] = useState(3);

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
    JSON.stringify({ ...state, scopes: scopesToPatch(state.scopes) }) !==
    JSON.stringify({ ...initial, scopes: scopesToPatch(initial.scopes) });
  const isSaving =
    navigation.state !== "idle" && navigation.formMethod === "POST";

  const reviewCountError =
    state.reviewCount.trim() === "" ||
    !Number.isInteger(Number(state.reviewCount)) ||
    Number(state.reviewCount) < 0
      ? "Enter a whole number of reviews"
      : undefined;
  const profileUrlError =
    state.trustpilotEnabled &&
    !/^https?:\/\/.+/.test(state.profileUrl.trim())
      ? "Enter a full URL, e.g. https://www.trustpilot.com/review/cellexia.com"
      : undefined;
  const daysError =
    state.days.trim() === "" ||
    !Number.isInteger(Number(state.days)) ||
    Number(state.days) < 1 ||
    Number(state.days) > 365
      ? "Between 1 and 365 days"
      : undefined;
  const itemsError =
    state.badgesEnabled && state.items.length === 0
      ? "Select at least one badge or disable the badge row."
      : undefined;

  const hasErrors = Boolean(
    reviewCountError || profileUrlError || daysError || itemsError,
  );

  const setScope = (
    key: keyof BadgesFormState["scopes"],
    scope: ScopeState,
  ) => {
    setState((previous) => ({
      ...previous,
      scopes: { ...previous.scopes, [key]: scope },
    }));
  };

  const toggleBadge = (key: string) => {
    setState((previous) => ({
      ...previous,
      items: previous.items.includes(key)
        ? previous.items.filter((item) => item !== key)
        : [...previous.items, key],
    }));
  };

  const moveBadge = (index: number, direction: -1 | 1) => {
    setState((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.items.length) return previous;
      const items = [...previous.items];
      const [moved] = items.splice(index, 1);
      items.splice(target, 0, moved);
      return { ...previous, items };
    });
  };

  const handleSave = () => {
    const patch: DeepPartial<BoosterSettings> = {
      trustBadges: {
        enabled: state.badgesEnabled,
        style: state.style,
        items: state.items,
      },
      trustpilot: {
        enabled: state.trustpilotEnabled,
        rating: Math.round(state.rating * 10) / 10,
        reviewCount: Number(state.reviewCount),
        profileUrl: state.profileUrl.trim(),
        showLink: state.showLink,
      },
      guarantee: {
        enabled: state.guaranteeEnabled,
        days: Number(state.days),
      },
      imageBadges: {
        enabled: state.imageBadgesEnabled,
        scale: Math.round(state.imageBadgesScale),
      },
      marketScopes: scopesToPatch(state.scopes),
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  const availableBadges = BADGE_OPTIONS.filter(
    (option) => !state.items.includes(option.key),
  );

  // v20 preview: the exact storefront clamp, run for the reference phone.
  const badgePreview = imageBadgePreview(
    state.imageBadgesScale,
    previewBadgeCount,
    imageBadgeCaps,
  );
  const themeSharePct = Math.round(
    (imageBadgeCaps.basePx / badgePreview.imageWidth) * 100,
  );
  const previewFactor = PREVIEW_BOX_PX / badgePreview.imageWidth;
  const previewBadgePx =
    (state.imageBadgesScale <= 100 ? imageBadgeCaps.basePx : badgePreview.px) *
    previewFactor;

  return (
    <Page
      title="Trust & badges"
      backAction={{ content: "Dashboard", url: "/app" }}
      primaryAction={{
        content: "Save",
        onAction: handleSave,
        disabled: !dirty || hasErrors,
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
      <TitleBar title="Trust & badges" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="trust_badges"
              enabled={headerEnabled}
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
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Trust badges
                </Text>
                <Checkbox
                  label="Enable the badge row"
                  helpText="Shown on product pages (auto-injected) and via the Trust badges app block. Labels ship translated in 17 languages."
                  checked={state.badgesEnabled}
                  onChange={(badgesEnabled) =>
                    setState((previous) => ({ ...previous, badgesEnabled }))
                  }
                />
                <ChoiceList
                  title="Style"
                  choices={[
                    { label: "Light — for light backgrounds", value: "light" },
                    { label: "Dark — for dark backgrounds", value: "dark" },
                  ]}
                  selected={[state.style]}
                  onChange={(selectedValues) =>
                    setState((previous) => ({
                      ...previous,
                      style: selectedValues[0] === "dark" ? "dark" : "light",
                    }))
                  }
                />
                <Divider />
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Selected badges (display order)
                  </Text>
                  {state.items.length === 0 ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      No badges selected.
                    </Text>
                  ) : null}
                  {state.items.map((key, index) => (
                    <InlineStack
                      key={key}
                      gap="200"
                      align="space-between"
                      blockAlign="center"
                      wrap={false}
                    >
                      <Checkbox
                        label={badgeLabel(key)}
                        checked
                        onChange={() => toggleBadge(key)}
                      />
                      <InlineStack gap="100">
                        <Button
                          icon={ArrowUpIcon}
                          variant="tertiary"
                          accessibilityLabel={`Move ${badgeLabel(key)} up`}
                          disabled={index === 0}
                          onClick={() => moveBadge(index, -1)}
                        />
                        <Button
                          icon={ArrowDownIcon}
                          variant="tertiary"
                          accessibilityLabel={`Move ${badgeLabel(key)} down`}
                          disabled={index === state.items.length - 1}
                          onClick={() => moveBadge(index, 1)}
                        />
                      </InlineStack>
                    </InlineStack>
                  ))}
                  {itemsError ? (
                    <Text as="p" tone="critical" variant="bodySm">
                      {itemsError}
                    </Text>
                  ) : null}
                  {availableBadges.length > 0 ? (
                    <>
                      <Divider />
                      <Text as="h3" variant="headingSm">
                        Available badges
                      </Text>
                      {availableBadges.map((option) => (
                        <Checkbox
                          key={option.key}
                          label={option.label}
                          checked={false}
                          onChange={() => toggleBadge(option.key)}
                        />
                      ))}
                    </>
                  ) : null}
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Trustpilot
                </Text>
                <Checkbox
                  label="Enable the Trustpilot widget"
                  helpText="Config-driven star strip (rating, count and link below). No Trustpilot integration is required."
                  checked={state.trustpilotEnabled}
                  onChange={(trustpilotEnabled) =>
                    setState((previous) => ({ ...previous, trustpilotEnabled }))
                  }
                />
                <RangeSlider
                  label={`Rating: ${state.rating.toFixed(1)} / 5`}
                  min={0}
                  max={5}
                  step={0.1}
                  value={state.rating}
                  output
                  onChange={(value) =>
                    setState((previous) => ({
                      ...previous,
                      rating:
                        Math.round(
                          (typeof value === "number" ? value : value[0]) * 10,
                        ) / 10,
                    }))
                  }
                />
                <InlineStack gap="300" wrap>
                  <Box width="200px">
                    <TextField
                      label="Review count"
                      type="number"
                      min={0}
                      value={state.reviewCount}
                      onChange={(reviewCount) =>
                        setState((previous) => ({ ...previous, reviewCount }))
                      }
                      error={reviewCountError}
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="320px">
                    <TextField
                      label="Trustpilot profile URL"
                      type="url"
                      value={state.profileUrl}
                      onChange={(profileUrl) =>
                        setState((previous) => ({ ...previous, profileUrl }))
                      }
                      error={profileUrlError}
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
                <Checkbox
                  label="Link the widget to your Trustpilot profile"
                  helpText="Turn off to show the rating without linking out — the stars and review count render as plain text."
                  checked={state.showLink}
                  onChange={(showLink) =>
                    setState((previous) => ({ ...previous, showLink }))
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Money-back guarantee
                </Text>
                <Checkbox
                  label="Enable the guarantee card"
                  helpText="Shown on product pages, in the cart trust row and in checkout (when the checkout trust module is on)."
                  checked={state.guaranteeEnabled}
                  onChange={(guaranteeEnabled) =>
                    setState((previous) => ({ ...previous, guaranteeEnabled }))
                  }
                />
                <Box width="200px">
                  <TextField
                    label="Guarantee window"
                    type="number"
                    min={1}
                    max={365}
                    suffix="days"
                    value={state.days}
                    onChange={(days) =>
                      setState((previous) => ({ ...previous, days }))
                    }
                    error={daysError}
                    autoComplete="off"
                  />
                </Box>
              </BlockStack>
            </Card>


            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Image badges on mobile
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  The award and certification badges your theme lays over the
                  product image are pinned to {imageBadgeCaps.basePx} px on
                  phones — about {themeSharePct}% of the picture, against
                  17-21% from tablet width up, where you are happy with them.
                  This widens those same badges on phones. It adds, removes
                  and restyles nothing, and above 576 px the theme keeps full
                  control.
                </Text>
                <Checkbox
                  label="Enlarge the product-image badges on phones"
                  helpText="Off by default. Arm it in the Preview Center to see it on the live store before anyone else does."
                  checked={state.imageBadgesEnabled}
                  onChange={(imageBadgesEnabled) =>
                    setState((previous) => ({
                      ...previous,
                      imageBadgesEnabled,
                    }))
                  }
                />
                <RangeSlider
                  label={`Size: ${state.imageBadgesScale}% of the theme's own badge width`}
                  min={imageBadgeCaps.scaleMin}
                  max={imageBadgeCaps.scaleMax}
                  step={5}
                  value={state.imageBadgesScale}
                  output
                  helpText={
                    state.imageBadgesScale <= 100
                      ? "100% is the theme's own size — nothing changes until you raise it."
                      : `On a ${IMAGE_BADGE_REFERENCE_VW} px phone: ${imageBadgeCaps.basePx} px → ${badgePreview.px} px per badge. ${previewBadgeCount} badges then fill ${Math.round(
                          badgePreview.rowShare * 100,
                        )}% of the image width.${
                          badgePreview.clamped
                            ? " Capped here so the row stays inside the image."
                            : ""
                        }`
                  }
                  onChange={(value) =>
                    setState((previous) => ({
                      ...previous,
                      imageBadgesScale: Math.round(
                        typeof value === "number" ? value : value[0],
                      ),
                    }))
                  }
                />
                <InlineStack gap="400" blockAlign="start" wrap>
                  <BlockStack gap="150">
                    <div
                      style={{
                        position: "relative",
                        width: PREVIEW_BOX_PX,
                        height: PREVIEW_BOX_PX,
                        background: "#f6f6f7",
                        border: "1px solid #e3e3e3",
                        borderRadius: 8,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          top: 15 * previewFactor,
                          right: 3 * previewFactor,
                          display: "flex",
                          alignItems: "center",
                        }}
                      >
                        {Array.from({ length: previewBadgeCount }).map(
                          (_, index) => (
                            <div
                              key={index}
                              style={{
                                width: previewBadgePx,
                                height: previewBadgePx,
                                borderRadius: "50%",
                                background: "#b1cded",
                                border: "1px solid #8fb4e0",
                                boxSizing: "border-box",
                              }}
                            />
                          ),
                        )}
                      </div>
                    </div>
                    <Text as="span" tone="subdued" variant="bodySm">
                      To scale, {IMAGE_BADGE_REFERENCE_VW} px phone
                    </Text>
                  </BlockStack>
                  <Box width="220px">
                    <ChoiceList
                      title="Badges on the product"
                      choices={[2, 3, 4, 5].map((count) => ({
                        label: `${count} badges`,
                        value: String(count),
                      }))}
                      selected={[String(previewBadgeCount)]}
                      onChange={(selected) =>
                        setPreviewBadgeCount(Number(selected[0]) || 3)
                      }
                    />
                    <Box paddingBlockStart="200">
                      <Text as="p" tone="subdued" variant="bodySm">
                        Preview only — each product (and market) carries its
                        own badges, set in the theme. The storefront measures
                        the real image and shrinks the badges to fit whenever
                        a product carries more of them.
                      </Text>
                    </Box>
                  </Box>
                </InlineStack>
              </BlockStack>
            </Card>

            <MarketScopeCard
              title="Markets — Trust badges"
              markets={markets}
              scope={state.scopes.trust_badges}
              onChange={(scope) => setScope("trust_badges", scope)}
            />
            <MarketScopeCard
              title="Markets — Trustpilot"
              markets={markets}
              scope={state.scopes.trustpilot}
              onChange={(scope) => setScope("trustpilot", scope)}
            />
            <MarketScopeCard
              title="Markets — Guarantee"
              markets={markets}
              scope={state.scopes.guarantee}
              onChange={(scope) => setScope("guarantee", scope)}
            />
            <MarketScopeCard
              title="Markets — Image badges on mobile"
              markets={markets}
              scope={state.scopes.image_badges}
              onChange={(scope) => setScope("image_badges", scope)}
            />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
