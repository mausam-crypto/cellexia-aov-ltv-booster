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

interface BadgesFormState {
  badgesEnabled: boolean;
  style: "light" | "dark";
  items: string[];
  trustpilotEnabled: boolean;
  rating: number;
  reviewCount: string;
  profileUrl: string;
  guaranteeEnabled: boolean;
  days: string;
  scopes: {
    trust_badges: ScopeState;
    trustpilot: ScopeState;
    guarantee: ScopeState;
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
    guaranteeEnabled: settings.guarantee.enabled,
    days: String(settings.guarantee.days),
    scopes: {
      trust_badges: toScopeState(settings.marketScopes.trust_badges),
      trustpilot: toScopeState(settings.marketScopes.trustpilot),
      guarantee: toScopeState(settings.marketScopes.guarantee),
    },
  };
}

export default function BadgesFeaturesPage() {
  const { settings, markets, headerEnabled } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<BadgesFormState>(() =>
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
      },
      guarantee: {
        enabled: state.guaranteeEnabled,
        days: Number(state.days),
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
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
