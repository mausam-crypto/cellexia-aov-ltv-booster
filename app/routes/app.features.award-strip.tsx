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
  Checkbox,
  Card,
  ChoiceList,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  AWARD_COUNT_MAX,
  AWARD_COUNT_MIN,
  AWARD_RANK_MAX,
  AWARD_RANK_MIN,
  AWARD_YEAR_MAX,
  AWARD_YEAR_MIN,
  getSettings,
  resolveFeatureFlag,
  saveSettings,
  type BoosterSettings,
  type DeepPartial,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { listMarkets } from "../services/markets.server";
import { FeaturePageHeader } from "../components/FeaturePageHeader";
import { ParamGateCard } from "../components/ParamGateCard";

/**
 * v29 (docs/SPEC-v29-proof-split.md): the "Rated #1" award strip as its
 * OWN feature — split out of the buy-box proof block so it can be
 * switched, market-scoped, gated and PREVIEWED independently. It renders
 * exactly where it always did: the FIRST card directly under the theme's
 * Add-to-cart panel, ahead of the research band, whatever the proof
 * block's flag says. Full design contract: docs/SPEC-v28-award-strip.md.
 */

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
    storeUrl: `https://${session.shop}`,
    headerEnabled: resolveFeatureFlag(settings, "award_strip"),
    // The sanitizer's ranges travel through the loader (the v8.3 rule: a
    // route's CLIENT bundle may not reference settings.server VALUES), so
    // the form can flag a value the server would silently clamp.
    caps: {
      rankMin: AWARD_RANK_MIN,
      rankMax: AWARD_RANK_MAX,
      countMin: AWARD_COUNT_MIN,
      countMax: AWARD_COUNT_MAX,
      yearMin: AWARD_YEAR_MIN,
      yearMax: AWARD_YEAR_MAX,
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
          Limit which markets can see the strip. Selections save even while
          the strip is off, so targeting can be set up before it goes live.
        </Text>
        {markets.length === 0 ? (
          <Text as="p" tone="subdued" variant="bodySm">
            No markets could be loaded — the strip follows the “All markets”
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

// The award strip's closed category catalog (AWARD_CATEGORY_KEYS on the
// server; labels are admin-only copy, the BADGE_OPTIONS precedent). The
// storefront noun is curated per locale in the extension asset, so each
// language stays grammatical — which merchant free text could not.
const AWARD_CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "wrinkle", label: "Wrinkle treatments" },
  { value: "cellulite", label: "Cellulite treatments" },
  { value: "antiaging", label: "Anti-aging creams" },
  { value: "firming", label: "Skin-firming creams" },
  { value: "darkspot", label: "Dark spot correctors" },
  { value: "serum", label: "Facial serums" },
  { value: "eye", label: "Eye creams" },
  { value: "lip", label: "Lip care products" },
  { value: "hair", label: "Hair serums" },
  { value: "skincare", label: "Skincare products" },
];

// The English wording, for the live preview under the fields. Twins of the
// extension's CX_BBP_AWARD "en" entry (harness-pinned, so they cannot
// drift apart).
const AWARD_EN_L1 = "Rated #{r} of {n}+ {c}";
const AWARD_EN_L2 = "in independent lab testing";

function awardPreviewLine(rank: string, count: string, category: string): string {
  const cat =
    AWARD_CATEGORY_OPTIONS.find((option) => option.value === category)?.label ??
    category;
  return AWARD_EN_L1.split("{r}")
    .join(rank.trim() || "1")
    .split("{n}")
    .join(count.trim() || "100")
    .split("{c}")
    .join(cat.toLowerCase());
}

interface AwardStripFormState {
  enabled: boolean;
  // The numeric fields are STRINGS while edited (Polaris TextField
  // contract); the save converts and the server clamps.
  rank: string;
  count: string;
  category: string;
  publication: string;
  imageUrl: string;
  year: string;
  scope: ScopeState;
  // v22 gate — param/token are read-only: minted server-side, cleared
  // (never typed) to ask for a fresh pair.
  gateAward: boolean;
  gateAwardParam: string;
  gateAwardToken: string;
}

function initialFormState(settings: BoosterSettings): AwardStripFormState {
  const strip = settings.awardStrip;
  return {
    enabled: strip.enabled,
    rank: String(strip.rank),
    count: String(strip.count),
    category: strip.category,
    publication: strip.publication,
    imageUrl: strip.imageUrl,
    year: String(strip.year),
    scope: toScopeState(settings.marketScopes.award_strip),
    gateAward: strip.gate === "ba" && settings.paramGates.ba.enabled,
    gateAwardParam: settings.paramGates.ba.param,
    gateAwardToken: settings.paramGates.ba.token,
  };
}

const HTTPS_URL = /^https:\/\/[^\s"'<>\\]+$/;

export default function AwardStripPage() {
  const { settings, markets, headerEnabled, caps, storeUrl } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<AwardStripFormState>(() =>
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

  // The server clamps silently, so out-of-range input is flagged HERE,
  // where the merchant can still see what they typed.
  const numberError = (
    value: string,
    min: number,
    max: number,
  ): string | undefined => {
    const n = Number(value.trim());
    return value.trim() === "" || !Number.isFinite(n) || n < min || n > max || !Number.isInteger(n)
      ? `Enter a whole number between ${min} and ${max}`
      : undefined;
  };
  const rankError = numberError(state.rank, caps.rankMin, caps.rankMax);
  const countError = numberError(state.count, caps.countMin, caps.countMax);
  const yearError = numberError(state.year, caps.yearMin, caps.yearMax);
  const publicationError =
    state.enabled && state.publication.trim() === ""
      ? "Required — the strip does not render without a named source"
      : undefined;
  const urlError =
    state.imageUrl.trim() !== "" && !HTTPS_URL.test(state.imageUrl.trim())
      ? "Enter a full https:// URL (upload the file in Settings → Files)"
      : undefined;
  const hasErrors = Boolean(
    rankError || countError || yearError || publicationError || urlError,
  );

  const handleSave = () => {
    const patch: DeepPartial<BoosterSettings> = {
      awardStrip: {
        enabled: state.enabled,
        // "" = everyone, "ba" = tagged links only. The minted parameter
        // survives in paramGates, so re-ticking reuses it and old links
        // keep working.
        gate: state.gateAward ? "ba" : "",
        rank: Number(state.rank.trim()),
        count: Number(state.count.trim()),
        category: state.category,
        publication: state.publication.trim(),
        imageUrl: state.imageUrl.trim(),
        year: Number(state.year.trim()),
      },
      paramGates: {
        ba: {
          enabled: state.gateAward,
          param: state.gateAwardParam,
          token: state.gateAwardToken,
        },
      },
      marketScopes: { award_strip: toScopePatch(state.scope) },
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  return (
    <Page
      title="Award strip"
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
      <TitleBar title="Award strip" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="award_strip"
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
            <Card>
              <BlockStack gap="300">
                <Checkbox
                  label="Show the “Rated #1” award strip"
                  helpText="A compact endorsement card that sits directly under the Add-to-cart panel — first, above the research band. It does not need the buy-box proof block to be on, and it can be previewed on its own in the Preview Center. The sentence is translated in every store language; the publication name stays as written (proper nouns are not translated)."
                  checked={state.enabled}
                  onChange={(enabled) =>
                    setState((previous) => ({ ...previous, enabled }))
                  }
                />
                <Banner tone="warning">
                  <Text as="p" variant="bodySm">
                    Show only a rating or award that was actually published, and
                    name the publication exactly. This claim is yours, not the
                    app&rsquo;s — and the app renders exactly the logo file you
                    upload, so use the official mark only where you are licensed
                    to.
                  </Text>
                </Banner>
                <InlineStack gap="300" wrap>
                  <Box minWidth="120px">
                    <TextField
                      label="Rank"
                      type="number"
                      value={state.rank}
                      onChange={(rank) =>
                        setState((previous) => ({ ...previous, rank }))
                      }
                      error={rankError}
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="160px">
                    <TextField
                      label="Products tested"
                      type="number"
                      helpText="Shown as “of 100+”"
                      value={state.count}
                      onChange={(count) =>
                        setState((previous) => ({ ...previous, count }))
                      }
                      error={countError}
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="120px">
                    <TextField
                      label="Year"
                      type="number"
                      value={state.year}
                      onChange={(year) =>
                        setState((previous) => ({ ...previous, year }))
                      }
                      error={yearError}
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
                <Select
                  label="Product category"
                  options={AWARD_CATEGORY_OPTIONS}
                  helpText="A fixed list so the sentence stays grammatical in every language — each language carries its own wording for the category. Need one that is missing? It is a small code addition."
                  value={state.category}
                  onChange={(category) =>
                    setState((previous) => ({ ...previous, category }))
                  }
                />
                <TextField
                  label="Publication name"
                  helpText="The source of the rating (for example a consumer-test magazine). Free text, shown as written in every language."
                  value={state.publication}
                  onChange={(publication) =>
                    setState((previous) => ({ ...previous, publication }))
                  }
                  error={publicationError}
                  autoComplete="off"
                />
                <TextField
                  label="Publication logo URL (optional)"
                  helpText="Shopify admin → Content → Files → Upload, then paste the file link. Leave blank to show the built-in lockup: the small red-over-yellow colour bar beside the name."
                  value={state.imageUrl}
                  onChange={(imageUrl) =>
                    setState((previous) => ({ ...previous, imageUrl }))
                  }
                  error={urlError}
                  autoComplete="off"
                />
                {state.imageUrl.trim() !== "" && !urlError ? (
                  <InlineStack gap="200" blockAlign="center">
                    <Box padding="200" background="bg-surface" borderRadius="200">
                      {/* Same box the storefront gives the mark: what you
                          see here is what the strip renders. */}
                      <img
                        src={state.imageUrl.trim()}
                        alt={`${state.publication || "Publication"} logo preview`}
                        style={{
                          display: "block",
                          width: 88,
                          height: 40,
                          objectFit: "contain",
                        }}
                      />
                    </Box>
                    <Text as="span" tone="subdued" variant="bodySm">
                      Storefront size
                    </Text>
                  </InlineStack>
                ) : null}
                <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Storefront wording (English shown; every store language
                      has its own translation):
                    </Text>
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {awardPreviewLine(state.rank, state.count, state.category)}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {AWARD_EN_L2}
                      {" · "}
                      {state.publication.trim() || "Publication"}
                      {" · "}
                      {state.year.trim() || "Year"}
                    </Text>
                  </BlockStack>
                </Box>
                <ParamGateCard
                  pieceLabel="the award strip"
                  enabled={state.gateAward}
                  param={state.gateAwardParam}
                  token={state.gateAwardToken}
                  featureEnabled={state.enabled}
                  storeUrl={storeUrl}
                  onToggle={(gateAward) =>
                    setState((previous) => ({ ...previous, gateAward }))
                  }
                  onRegenerate={() =>
                    setState((previous) => ({
                      ...previous,
                      gateAwardParam: "",
                      gateAwardToken: "",
                    }))
                  }
                />
              </BlockStack>
            </Card>

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
