import { useEffect, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
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
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  FEATURE_DEFS,
  FEATURE_KEYS,
  getSettings,
  resolveFeatureFlag,
  saveSettings,
  type BoosterSettings,
  type DeepPartial,
  type FeatureKey,
  type ProofDensity,
} from "../models/settings.server";
import { getPreviewState } from "../services/preview.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import {
  listHomeSections,
  type HomeSectionsResult,
} from "../services/home-sections.server";

/**
 * Features hub (SPEC v4 §C): all 19 features as cards grouped by surface,
 * each with live status, market reach, a preview-draft chip, its Configure
 * page and a Preview Center deep link.
 *
 * Flat-routes note: this file maps to /app/features EXACTLY — the existing
 * feature pages (app.features.cart etc.) are SIBLING routes, so no <Outlet>
 * is needed and none of them change behavior.
 */

const CONFIGURE_URL: Record<FeatureKey, string> = {
  cart_volume_upsell: "/app/features/cart",
  free_shipping_bar: "/app/features/cart",
  cart_subscription_upsell: "/app/features/cart",
  cart_trust_row: "/app/features/cart",
  trust_badges: "/app/features/badges",
  trustpilot: "/app/features/badges",
  guarantee: "/app/features/badges",
  clinical_results: "/app/features/clinical",
  subscription_nudge: "/app/features/subscriptions",
  checkout_upsell: "/app/features/checkout",
  checkout_protection: "/app/features/checkout",
  checkout_trust: "/app/features/checkout",
  checkout_customs: "/app/features/checkout",
  checkout_tracked: "/app/features/checkout",
  clinical_study: "/app/products",
  verified_before_after: "/app/proof/results",
  batch_transparency: "/app/products",
  empty_bottle_guarantee: "/app/products",
  derm_survey: "/app/products",
  press: "/app/proof",
  derm_endorsements: "/app/proof",
  cart_cross_sell: "/app/features/cart",
  dispatch_countdown: "/app/features/dispatch",
  delivery_estimate: "/app/features/delivery",
  az_buy_box: "/app/features/amazon",
  az_microcopy: "/app/features/amazon",
  az_delivery_line: "/app/features/amazon",
  az_stock_line: "/app/features/amazon",
  az_ships_from: "/app/features/amazon",
  az_bought_count: "/app/features/amazon",
  az_bestseller_badge: "/app/features/amazon",
  az_fbt: "/app/features/amazon",
  az_similar_items: "/app/features/amazon",
  az_cart_free_line: "/app/features/amazon",
  az_cta_count: "/app/features/amazon",
  // v14 rewards (SPEC v14 §11): both features configure on the Rewards page.
  set_savings: "/app/features/rewards",
  gift_tiers: "/app/features/rewards",
};

const GROUPS: { title: string; description: string; keys: FeatureKey[] }[] = [
  {
    title: "Cart drawer",
    description:
      "Widgets inside the mini-cart drawer: volume upgrades, free-shipping progress, subscription switch and the trust row.",
    keys: [
      "cart_volume_upsell",
      "free_shipping_bar",
      "cart_subscription_upsell",
      "cart_trust_row",
      "cart_cross_sell",
      "dispatch_countdown",
    ],
  },
  {
    title: "Product page",
    description:
      "Trust and conversion widgets on product pages — badge rows, social proof, clinical evidence and per-product trust boosters.",
    keys: [
      "trust_badges",
      "trustpilot",
      "guarantee",
      "clinical_results",
      "subscription_nudge",
      "clinical_study",
      "verified_before_after",
      "batch_transparency",
      "empty_bottle_guarantee",
      "derm_survey",
      "press",
      "derm_endorsements",
      "delivery_estimate",
    ],
  },
  {
    title: "Checkout",
    description:
      "Checkout UI extensions (Shopify Plus): last-step upsells, order protection and the reassurance module with its per-market customs-free and tracked-delivery rows.",
    keys: [
      "checkout_upsell",
      "checkout_protection",
      "checkout_trust",
      "checkout_customs",
      "checkout_tracked",
    ],
  },
  {
    title: "Amazon patterns",
    description:
      "Familiar marketplace patterns — layout, ordering and color conventions shoppers know — adapted to Cellexia branding. Patterns only, never their brand.",
    keys: [
      "az_buy_box",
      "az_microcopy",
      "az_delivery_line",
      "az_stock_line",
      "az_ships_from",
      "az_bought_count",
      "az_bestseller_badge",
      "az_fbt",
      "az_similar_items",
      "az_cart_free_line",
      "az_cta_count",
    ],
  },
  {
    title: "Rewards",
    description:
      "Set savings (app-owned SET discount codes — buy more different products, save a growing percentage; your existing codes are never touched), spend-based free gifts with per-market amounts and stock awareness, and a free-shipping guarantee.",
    keys: ["set_savings", "gift_tiers"],
  },
];

interface FeatureCardData {
  key: FeatureKey;
  label: string;
  on: boolean;
  reach: string;
  draft: boolean;
  configureUrl: string;
}

/**
 * The "Display density" card (SPEC v8 §3c + the v8.2/v8.3 merchant asks):
 * one compact-mode toggle per v7 PDP widget (two densities — checkbox) and
 * one THREE-density picker per v8 proof-library widget (full | compact |
 * ultra — ChoiceList, v8.3). These are LIVE display-density settings (the
 * v6.5 placement precedent — no draft/preview plumbing): saving flips the
 * live widget for real visitors immediately. `feature` is only the
 * pending-spinner discriminator, mirroring app.products.tsx's toggle
 * convention (kept per-widget).
 */
const DENSITY_TOGGLES: {
  feature: string;
  label: string;
  description: string;
  isOn: (density: DensityState) => boolean;
  buildPatch: (compact: boolean) => DeepPartial<BoosterSettings>;
}[] = [
  {
    feature: "density_survey",
    label: "Dermatologist survey — compact",
    description:
      "Compact mode — the same survey proof in a fraction of the height; outcomes beyond the first sit behind a “more outcomes” disclosure. Applies to the Classic design only — the v8.8 designs (Survey page → Widget design) are inherently compact.",
    isOn: (density) => density.survey,
    buildPatch: (compact) => ({ dermSurvey: { compact } }),
  },
  {
    feature: "density_study",
    label: "Clinical study — compact",
    description:
      "Compact mode — the same study data in a fraction of the height; the hero number moves inline and stats become one wrapping row.",
    isOn: (density) => density.study,
    buildPatch: (compact) => ({ clinicalStudy: { compact } }),
  },
  {
    feature: "density_guarantee",
    label: "Risk-free trial guarantee — compact",
    description:
      "Compact mode — the same guarantee as one slim band; the full guarantee points stay in the “Guarantee check” modal.",
    isOn: (density) => density.guarantee,
    buildPatch: (compact) => ({ emptyBottleGuarantee: { compact } }),
  },
];

/** Client-safe literal mirror of settings.server's PROOF_DENSITIES (the
 *  SURVEY_FORMAT_OPTIONS convention — route client code must not import
 *  .server module VALUES; the server enum stays authoritative in
 *  sanitizeSettings). */
const DENSITY_VALUES = ["full", "compact", "ultra"] as const;

/**
 * v8.3: the three proof-library widgets each get a full | compact | ultra
 * picker. Patches write { <section>: { density } } — the v8.2 legacy
 * `compact` booleans are never written by the UI anymore (sanitize keeps
 * coercing them for stored-JSON back-compat).
 */
const DENSITY_PICKERS: {
  feature: string;
  label: string;
  /** The v8.2 ultra wording, verbatim — shown under the Ultra choice. */
  ultraDescription: string;
  value: (density: DensityState) => ProofDensity;
  buildPatch: (density: ProofDensity) => DeepPartial<BoosterSettings>;
}[] = [
  {
    feature: "density_press",
    label: "As seen in the press",
    ultraDescription:
      "Same proof, a fraction of the height — one collapsed row of logos; the quote appears on logo tap.",
    value: (density) => density.press,
    buildPatch: (density) => ({ press: { density } }),
  },
  {
    feature: "density_endorsements",
    label: "Dermatologist endorsements",
    ultraDescription:
      "Same proof, a fraction of the height — a one-line count headline over a swipeable card rail.",
    value: (density) => density.endorsements,
    buildPatch: (density) => ({ dermEndorsements: { density } }),
  },
  {
    feature: "density_results",
    label: "Results gallery",
    ultraDescription:
      "Same proof, a fraction of the height — a slimmer banner, one scrollable filter row and the swipeable card rail on desktop too.",
    value: (density) => density.results,
    buildPatch: (density) => ({ beforeAfter: { density } }),
  },
];

/** Client-safe mirror of PROOF_PLACEMENTS in settings.server.ts (the
 *  v8.3 lesson — never import the .server VALUE into client code; the
 *  harness pins the two in sync). */
/** Client-safe mirror of PRESS_LAYOUTS in settings.server.ts. */
const PRESS_LAYOUT_VALUES = ["featured", "wall"] as const;
type PressLayoutValue = (typeof PRESS_LAYOUT_VALUES)[number];

const PLACEMENT_VALUES = ["below_tabs", "above_proof", "below_proof"] as const;
type ProofPlacementValue = (typeof PLACEMENT_VALUES)[number];
const PLACEMENT_OPTIONS: { label: string; value: ProofPlacementValue }[] = [
  {
    label: "Below the info tabs (default) — after the overview/science tab box",
    value: "below_tabs",
  },
  {
    label: "Above the proof stack — right before the dermatologist survey",
    value: "above_proof",
  },
  {
    label: "Below the proof stack — after the survey / study / guarantee",
    value: "below_proof",
  },
];
const PLACEMENT_PICKERS: {
  feature: string;
  label: string;
  section: "press" | "dermEndorsements" | "beforeAfter";
  value: (placement: PlacementState) => ProofPlacementValue;
}[] = [
  {
    feature: "placement_press",
    label: "As seen in the press",
    section: "press",
    value: (placement) => placement.press,
  },
  {
    feature: "placement_endorsements",
    label: "Dermatologist endorsements",
    section: "dermEndorsements",
    value: (placement) => placement.endorsements,
  },
  {
    feature: "placement_results",
    label: "Results gallery",
    section: "beforeAfter",
    value: (placement) => placement.results,
  },
];

interface PlacementState {
  press: ProofPlacementValue;
  endorsements: ProofPlacementValue;
  results: ProofPlacementValue;
}

interface DensityState {
  survey: boolean;
  study: boolean;
  guarantee: boolean;
  press: ProofDensity;
  endorsements: ProofDensity;
  results: ProofDensity;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const [settings, previewState, homeSections] = await Promise.all([
    getSettings(session.shop),
    getPreviewState(session.shop),
    // v8.15 press home-position picker — fail-soft: an unreadable theme
    // degrades the picker, never the page.
    listHomeSections(admin),
  ]);

  const previewArmed = previewState?.armed === true;
  const draftFlags = previewArmed ? previewState!.draftFlags : {};

  const features = Object.fromEntries(
    FEATURE_KEYS.map((key) => {
      const scope = settings.marketScopes[key] ?? {
        mode: "all" as const,
        markets: [],
      };
      const reach =
        scope.mode === "all"
          ? "All markets"
          : scope.markets.length === 0
            ? "No markets selected"
            : scope.markets.length === 1
              ? `1 market (${scope.markets[0]})`
              : `${scope.markets.length} markets`;
      return [
        key,
        {
          key,
          label: FEATURE_DEFS[key].label,
          on: resolveFeatureFlag(settings, key),
          reach,
          draft: draftFlags[key] === true,
          configureUrl: CONFIGURE_URL[key],
        } satisfies FeatureCardData,
      ];
    }),
  ) as Record<FeatureKey, FeatureCardData>;

  const density: DensityState = {
    survey: settings.dermSurvey.compact,
    study: settings.clinicalStudy.compact,
    guarantee: settings.emptyBottleGuarantee.compact,
    press: settings.press.density,
    endorsements: settings.dermEndorsements.density,
    results: settings.beforeAfter.density,
  };

  const placement: PlacementState = {
    press: settings.press.placement,
    endorsements: settings.dermEndorsements.placement,
    results: settings.beforeAfter.placement,
  };

  const pressLayout: PressLayoutValue = settings.press.layout;
  const pressLogoCue: boolean = settings.press.logoCue;
  const pressHomeAfter: string = settings.press.homeAfterSection;

  return {
    features,
    previewArmed,
    density,
    placement,
    pressLayout,
    pressLogoCue,
    pressHomeAfter,
    homeSections,
  };
};

/**
 * Settings-patch action for the Display density card — the same
 * formData(`feature`, `patch`) convention as app.products.tsx (patch = JSON
 * DeepPartial<BoosterSettings>; saveSettings sanitizes, then the storefront
 * metafields are re-synced; sync failures are reported but never lose the
 * save).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const rawPatch = formData.get("patch");
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
  const next = await saveSettings(session.shop, patch);
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
};

function FeatureRow({ feature }: { feature: FeatureCardData }) {
  return (
    <BlockStack gap="300">
      <Divider />
      <InlineStack gap="300" align="space-between" blockAlign="center" wrap>
        <Box maxWidth="60ch">
          <BlockStack gap="050">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">
                {feature.label}
              </Text>
              <Badge tone={feature.on ? "success" : undefined}>
                {feature.on ? "Active" : "Off"}
              </Badge>
              {feature.draft ? (
                <Badge tone="attention">Draft in preview</Badge>
              ) : null}
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              Market reach: {feature.reach}
            </Text>
          </BlockStack>
        </Box>
        <InlineStack gap="200" blockAlign="center">
          <Button variant="plain" url={feature.configureUrl}>
            Configure
          </Button>
          <Button
            variant="plain"
            url={`/app/preview?feature=${encodeURIComponent(feature.key)}`}
          >
            Preview
          </Button>
        </InlineStack>
      </InlineStack>
    </BlockStack>
  );
}

/** v8.15: the press home-position anchor is a theme-generated section-key
 *  slug — the same shape gate sanitizeSettings applies server-side. */
const HOME_ANCHOR_SLUG = /^[A-Za-z0-9_-]{1,64}$/;

function buildHomePositionOptions(
  homeSections: HomeSectionsResult,
  current: string,
): { label: string; value: string }[] {
  const options = [
    { label: "End of the home page (default)", value: "" },
    ...homeSections.sections.map((section) => ({
      label: `After: ${section.label}`,
      value: section.key,
    })),
  ];
  // A saved anchor whose section is gone (removed/renamed, or the theme
  // was unreadable) stays selectable so the Select shows the truth instead
  // of silently jumping to the default.
  if (current !== "" && !options.some((option) => option.value === current)) {
    options.push({
      label: `After: ${current} (section not found — currently showing at the end of the page)`,
      value: current,
    });
  }
  return options;
}

export default function FeaturesHub() {
  const {
    features,
    previewArmed,
    density,
    placement,
    pressLayout,
    pressLogoCue,
    pressHomeAfter,
    homeSections,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const pendingFeature =
    navigation.state !== "idle" && navigation.formData
      ? navigation.formData.get("feature")
      : null;
  const densitySaving = pendingFeature !== null;

  const toggleDensity = (
    toggle: (typeof DENSITY_TOGGLES)[number],
    compact: boolean,
  ) => {
    const formData = new FormData();
    formData.set("feature", toggle.feature);
    formData.set("patch", JSON.stringify(toggle.buildPatch(compact)));
    submit(formData, { method: "post" });
  };

  const pickDensity = (
    picker: (typeof DENSITY_PICKERS)[number],
    selected: string[],
  ) => {
    const value = selected[0];
    if (!DENSITY_VALUES.includes(value as ProofDensity)) return;
    const formData = new FormData();
    formData.set("feature", picker.feature);
    formData.set("patch", JSON.stringify(picker.buildPatch(value as ProofDensity)));
    submit(formData, { method: "post" });
  };

  const pickPlacement = (
    picker: (typeof PLACEMENT_PICKERS)[number],
    selected: string,
  ) => {
    if (!PLACEMENT_VALUES.includes(selected as ProofPlacementValue)) return;
    const formData = new FormData();
    formData.set("feature", picker.feature);
    formData.set(
      "patch",
      JSON.stringify({ [picker.section]: { placement: selected } }),
    );
    submit(formData, { method: "post" });
  };

  const pickPressHomePosition = (selected: string) => {
    if (selected !== "" && !HOME_ANCHOR_SLUG.test(selected)) return;
    const formData = new FormData();
    formData.set("feature", "press_home_position");
    formData.set(
      "patch",
      JSON.stringify({ press: { homeAfterSection: selected } }),
    );
    submit(formData, { method: "post" });
  };

  const pickPressLayout = (selected: string[]) => {
    const value = selected[0];
    if (!PRESS_LAYOUT_VALUES.includes(value as PressLayoutValue)) return;
    const formData = new FormData();
    formData.set("feature", "press_layout");
    formData.set("patch", JSON.stringify({ press: { layout: value } }));
    submit(formData, { method: "post" });
  };

  // v5.4 safety net (same contract as the Preview Center picker): a
  // FeatureKey missing from the GROUPS literal still renders, in an
  // automatic trailing group, so no booster can ever lose its Configure /
  // Preview buttons. The validation harness fails when the literal drifts,
  // so this group should never actually appear.
  const groupedHubKeys = new Set<string>(GROUPS.flatMap((g) => g.keys));
  const ungroupedHubKeys = (
    Object.keys(features) as (keyof typeof features)[]
  ).filter((key) => !groupedHubKeys.has(key));
  const hubGroups =
    ungroupedHubKeys.length > 0
      ? [
          ...GROUPS,
          {
            title: "Other boosters",
            description:
              "Boosters not yet assigned to a section — fully functional, listed here automatically.",
            keys: ungroupedHubKeys as FeatureKey[],
          },
        ]
      : GROUPS;
  const boosterCount = Object.keys(features).length;

  // v8.6: deep-link scroll for /app/features#display-density (the density
  // card sits at the bottom of a long page — links from the Proof library
  // and Product boosters pages land directly on it).
  const densityCardRef = useRef<HTMLDivElement>(null);
  const placementCardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash === "#display-density") {
      densityCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (window.location.hash === "#proof-placement") {
      placementCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return (
    <Page
      title="Features"
      subtitle={`All ${boosterCount} boosters — status, reach, configuration and preview`}
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <TitleBar title="Features" />
      <Layout>
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

        {previewArmed ? (
          <Layout.Section>
            <Card>
              <InlineStack gap="200" blockAlign="center" wrap>
                <Badge tone="attention">Preview armed</Badge>
                <Text as="span" tone="subdued" variant="bodySm">
                  Features marked “Draft in preview” are visible to preview
                  sessions only.
                </Text>
                <Button variant="plain" url="/app/preview">
                  Open Preview Center
                </Button>
              </InlineStack>
            </Card>
          </Layout.Section>
        ) : null}

        {hubGroups.map((group) => (
          <Layout.Section key={group.title}>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    {group.title}
                  </Text>
                  <Text as="p" tone="subdued">
                    {group.description}
                  </Text>
                </BlockStack>
                {group.keys.map((key) => (
                  <FeatureRow key={key} feature={features[key]} />
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        ))}

        <Layout.Section>
          {/* v8.6: anchor target for the "Display density" links on the
              Proof library and Product boosters pages. */}
          <div id="display-density" ref={densityCardRef}>
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Display density
                </Text>
                <Text as="p" tone="subdued">
                  Compact modes for the tallest proof widgets — on mobile and
                  desktop. The proof-library widgets offer three density
                  levels. These are live settings — a change applies to real
                  visitors as soon as it saves (nothing else about the widgets
                  changes).
                </Text>
              </BlockStack>
              {DENSITY_TOGGLES.map((toggle) => (
                <Checkbox
                  key={toggle.feature}
                  label={toggle.label}
                  helpText={toggle.description}
                  checked={toggle.isOn(density)}
                  disabled={densitySaving}
                  onChange={(checked) => toggleDensity(toggle, checked)}
                />
              ))}
              <Checkbox
                label="As seen in the press — logo switch cue"
                helpText="Featured layout only: a small ink indicator under the active logo (the familiar tab pattern), so visitors see the other logos are tappable to switch quotes. No arrows, no extra text."
                checked={pressLogoCue}
                disabled={densitySaving}
                onChange={(checked) => {
                  const formData = new FormData();
                  formData.set("feature", "press_logo_cue");
                  formData.set(
                    "patch",
                    JSON.stringify({ press: { logoCue: checked } }),
                  );
                  submit(formData, { method: "post" });
                }}
              />
              <ChoiceList
                title="As seen in the press — layout"
                choices={[
                  {
                    label: "Featured quote",
                    value: "featured",
                    helpText:
                      "The logo strip with one large quote; tapping a logo swaps the quote. The density tiers below apply to this layout.",
                    disabled: densitySaving,
                  },
                  {
                    label: "All quotes visible — compact cards",
                    value: "wall",
                    helpText:
                      "Every quote shown at once as compact attribution cards (masonry columns on desktop, one tight column on mobile). Nothing to tap; inherently compact, so the density tiers are ignored.",
                    disabled: densitySaving,
                  },
                ]}
                selected={[pressLayout]}
                onChange={pickPressLayout}
              />
              {DENSITY_PICKERS.map((picker) => (
                <ChoiceList
                  key={picker.feature}
                  title={picker.label}
                  choices={[
                    {
                      label: "Full",
                      value: "full",
                      helpText: "The original full-height layout.",
                      disabled: densitySaving,
                    },
                    {
                      label: "Compact",
                      value: "compact",
                      helpText:
                        "Quote and details visible at a fraction of the height.",
                      disabled: densitySaving,
                    },
                    {
                      label: "Ultra compact",
                      value: "ultra",
                      helpText: picker.ultraDescription,
                      disabled: densitySaving,
                    },
                  ]}
                  selected={[picker.value(density)]}
                  onChange={(selected) => pickDensity(picker, selected)}
                />
              ))}
            </BlockStack>
          </Card>
          </div>
        </Layout.Section>

        <Layout.Section>
          {/* v8.9: per-widget product-page placement for the proof-library
              widgets (anchor target for the Proof library page link).
              v8.15: the same card carries the press HOME-page position. */}
          <div id="proof-placement" ref={placementCardRef}>
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Product-page placement
                </Text>
                <Text as="p" tone="subdued">
                  Where each proof-library widget sits on product pages —
                  independently per widget. “Proof stack” means the
                  dermatologist survey / clinical study / guarantee group.
                  The home page is controlled separately below. Live settings
                  — a change applies to real visitors as soon as it saves.
                </Text>
              </BlockStack>
              {PLACEMENT_PICKERS.map((picker) => (
                <Select
                  key={picker.feature}
                  label={picker.label}
                  options={PLACEMENT_OPTIONS}
                  value={picker.value(placement)}
                  disabled={densitySaving}
                  onChange={(selected) => pickPlacement(picker, selected)}
                />
              ))}
              <Divider />
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">
                  Home-page position — As seen in the press
                </Text>
                <Text as="p" tone="subdued">
                  Where the press band sits on the home page. Pick a home
                  section to slot the band right after it — the band follows
                  that section if you reorder the home page in the theme
                  editor, and falls back to the end of the page if the
                  section is removed. Endorsements and the results gallery
                  keep the end-of-page position.
                </Text>
                {!homeSections.ok ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Couldn’t read the home template from the live theme (
                    {homeSections.error}) — showing the saved value only.
                  </Text>
                ) : null}
              </BlockStack>
              <Select
                label="Position on the home page"
                labelHidden
                options={buildHomePositionOptions(homeSections, pressHomeAfter)}
                value={pressHomeAfter}
                disabled={densitySaving}
                onChange={pickPressHomePosition}
              />
            </BlockStack>
          </Card>
          </div>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Related settings
              </Text>
              <Text as="p" tone="subdued">
                Everything else that shapes what shoppers see.
              </Text>
              <InlineStack gap="200" wrap>
                <Button url="/app/localization" variant="plain">
                  Localization &amp; languages
                </Button>
                <Button url="/app/features/survey" variant="plain">
                  Dermatologist survey settings
                </Button>
                <Button url="/app/markets" variant="plain">
                  Market targeting matrix
                </Button>
                <Button url="/app/products" variant="plain">
                  Product boosters (per-product content)
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
