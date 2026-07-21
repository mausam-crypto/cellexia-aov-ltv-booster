import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  Outlet,
  useActionData,
  useLoaderData,
  useMatches,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Spinner,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getSettings,
  resolveFeatureFlag,
  saveSettings,
  type BoosterSettings,
  type DeepPartial,
  type FeatureKey,
  type MarketScope,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { ensurePdpDefinitions } from "../services/metaobjects.server";
import { FeaturePageHeader } from "../components/FeaturePageHeader";
import {
  listProductsWithBoosterStatus,
  type ProductBoosterStatus,
} from "../services/pdp-content.server";

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

/**
 * Shops whose PDP metaobject/metafield definitions were verified this server
 * lifetime. ensurePdpDefinitions is idempotent, but there is no reason to
 * re-run its lookup on every navigation — cache success per shop and retry on
 * the next load only when it reported errors.
 */
const ensuredShops = new Set<string>();

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";

  // This file is also the flat-routes layout for /app/products/:id — when a
  // child route matches, the component renders only the <Outlet /> and this
  // loader skips its work (the child loader runs ensurePdpDefinitions itself).
  const isIndex = url.pathname.replace(/\/+$/, "") === "/app/products";
  if (!isIndex) {
    return {
      settings: null,
      q,
      products: [] as ProductBoosterStatus[],
      productErrors: [] as string[],
      definitionErrors: [] as string[],
      headerEnabled: false,
    };
  }

  let definitionErrors: string[] = [];
  if (!ensuredShops.has(session.shop)) {
    const ensured = await ensurePdpDefinitions(admin);
    if (ensured.ok) {
      ensuredShops.add(session.shop);
    }
    definitionErrors = ensured.errors;
  }

  const [settings, list] = await Promise.all([
    getSettings(session.shop),
    listProductsWithBoosterStatus(admin, q),
  ]);

  return {
    settings,
    q,
    products: list.products,
    productErrors: list.ok ? [] : list.errors,
    definitionErrors,
    // Representative combined flag for the shared page header (cheap —
    // settings are already loaded).
    headerEnabled: resolveFeatureFlag(settings, "clinical_study"),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  return applySettingsPatch(session.shop, admin, formData.get("patch"));
};

// ---------------------------------------------------------------------------
// The five PDP booster master toggles
// ---------------------------------------------------------------------------

interface PdpFeatureDefinition {
  key: FeatureKey;
  title: string;
  description: string;
  perProductContent: boolean;
  isEnabled: (settings: BoosterSettings) => boolean;
  buildPatch: (enabled: boolean) => DeepPartial<BoosterSettings>;
}

const PDP_FEATURES: PdpFeatureDefinition[] = [
  {
    key: "clinical_study",
    title: "Clinical study",
    description:
      "Independent clinical study block — headline result, instrument-measured stats and methodology small print.",
    perProductContent: true,
    isEnabled: (settings) => settings.clinicalStudy.enabled,
    buildPatch: (enabled) => ({ clinicalStudy: { enabled } }),
  },
  {
    key: "verified_before_after",
    title: "Verified before/after",
    description:
      "Unretouched before/after images with real dates, verified by a named professional with license number.",
    perProductContent: true,
    isEnabled: (settings) => settings.beforeAfter.enabled,
    buildPatch: (enabled) => ({ beforeAfter: { enabled } }),
  },
  {
    key: "batch_transparency",
    title: "Batch transparency",
    description:
      "Exact ingredient concentrations plus downloadable certificates of analysis per batch.",
    perProductContent: true,
    isEnabled: (settings) => settings.batchTransparency.enabled,
    buildPatch: (enabled) => ({ batchTransparency: { enabled } }),
  },
  {
    key: "empty_bottle_guarantee",
    title: "Empty bottle guarantee",
    description:
      "“Use every last drop” risk-reversal panel. Needs no per-product content — only the per-product opt-out below.",
    perProductContent: false,
    isEnabled: (settings) => settings.emptyBottleGuarantee.enabled,
    buildPatch: (enabled) => ({ emptyBottleGuarantee: { enabled } }),
  },
  {
    key: "derm_survey",
    title: "Dermatologist survey",
    description:
      "“9/10 dermatologists surveyed would recommend Cellexia” with a third-party verification seal. Shown on every product page.",
    perProductContent: false,
    isEnabled: (settings) => settings.dermSurvey.enabled,
    buildPatch: (enabled) => ({ dermSurvey: { enabled } }),
  },
];

function marketReachCaption(scope: MarketScope | undefined): string {
  if (!scope || scope.mode === "all") return "All markets";
  if (scope.markets.length === 0) return "No markets selected";
  return scope.markets.length === 1
    ? "1 market"
    : `${scope.markets.length} markets`;
}

// ---------------------------------------------------------------------------
// Product table status badges
// ---------------------------------------------------------------------------

type BoosterStatus = "on" | "off" | "unset";

function contentStatus(configured: boolean, flagOn: boolean): BoosterStatus {
  if (!configured) return "unset";
  return flagOn ? "on" : "off";
}

function StatusBadge({
  label,
  status,
}: {
  label: string;
  status: BoosterStatus;
}) {
  const tone =
    status === "on" ? "success" : status === "off" ? "warning" : undefined;
  const suffix =
    status === "on" ? "on" : status === "off" ? "off" : "not set";
  return <Badge tone={tone}>{`${label} · ${suffix}`}</Badge>;
}

function numericProductId(gid: string): string {
  return gid.split("/").pop() ?? "";
}

function ProductRow({ product }: { product: ProductBoosterStatus }) {
  const { boosters } = product;
  return (
    <BlockStack gap="300">
      <Divider />
      <InlineStack gap="300" align="space-between" blockAlign="center" wrap>
        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <Thumbnail
            source={product.imageUrl ?? ImageIcon}
            alt={product.title}
            size="small"
          />
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {product.title}
              </Text>
              {product.status !== "ACTIVE" ? (
                <Badge tone="info">
                  {product.status === "DRAFT" ? "Draft" : "Archived"}
                </Badge>
              ) : null}
            </InlineStack>
            <InlineStack gap="100" wrap>
              <StatusBadge
                label="Study"
                status={contentStatus(
                  boosters.clinical_study,
                  boosters.flags.clinical_study,
                )}
              />
              <StatusBadge
                label={
                  boosters.verified_before_after > 0
                    ? `Before/after (${boosters.verified_before_after})`
                    : "Before/after"
                }
                status={contentStatus(
                  boosters.verified_before_after > 0,
                  boosters.flags.verified_before_after,
                )}
              />
              <StatusBadge
                label="Batch"
                status={contentStatus(
                  boosters.batch_transparency,
                  boosters.flags.batch_transparency,
                )}
              />
              <StatusBadge
                label="Guarantee"
                status={boosters.flags.empty_bottle_guarantee ? "on" : "off"}
              />
              <StatusBadge
                label="Survey"
                status={boosters.flags.derm_survey ? "on" : "off"}
              />
            </InlineStack>
          </BlockStack>
        </InlineStack>
        <Button url={`/app/products/${numericProductId(product.id)}`}>
          Configure
        </Button>
      </InlineStack>
    </BlockStack>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProductBoostersRoute() {
  // This route is also the flat-routes layout for /app/products/:id — hand
  // rendering over to the child when one matches. The index page lives in its
  // own component so its hooks never run in layout mode.
  const matches = useMatches();
  const childActive = matches.some((match) =>
    match.id.startsWith("routes/app.products."),
  );
  if (childActive) {
    return <Outlet />;
  }
  return <ProductBoostersIndexPage />;
}

function ProductBoostersIndexPage() {
  const { settings, q, products, productErrors, definitionErrors, headerEnabled } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const [, setSearchParams] = useSearchParams();

  const [query, setQuery] = useState(q);
  const [guaranteeDays, setGuaranteeDays] = useState(
    String(settings?.emptyBottleGuarantee.days ?? 60),
  );

  // Reset the days field only when the persisted value actually changed (a
  // save landed) — unrelated revalidations must not wipe an in-progress edit.
  const persistedDays = settings?.emptyBottleGuarantee.days ?? 60;
  useEffect(() => {
    setGuaranteeDays(String(persistedDays));
  }, [persistedDays]);

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

  // Debounced title search — the loader re-runs with ?q=.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === q.trim()) return;
    const handle = setTimeout(() => {
      setSearchParams(trimmed === "" ? {} : { q: trimmed }, {
        replace: true,
        preventScrollReset: true,
      });
    }, 350);
    return () => clearTimeout(handle);
  }, [query, q, setSearchParams]);

  const pendingFeature =
    navigation.state !== "idle" && navigation.formData
      ? navigation.formData.get("feature")
      : null;
  const searching = navigation.state === "loading";

  const toggleFeature = (
    feature: PdpFeatureDefinition,
    nextEnabled: boolean,
  ) => {
    const formData = new FormData();
    formData.set("feature", feature.key);
    formData.set("patch", JSON.stringify(feature.buildPatch(nextEnabled)));
    submit(formData, { method: "post" });
  };

  const daysValue = Number(guaranteeDays);
  const daysValid =
    guaranteeDays.trim() !== "" &&
    Number.isFinite(daysValue) &&
    Math.round(daysValue) >= 1 &&
    Math.round(daysValue) <= 365;
  const daysDirty = guaranteeDays.trim() !== String(persistedDays);

  const saveGuaranteeDays = () => {
    const formData = new FormData();
    formData.set("feature", "empty_bottle_guarantee_days");
    formData.set(
      "patch",
      JSON.stringify({
        emptyBottleGuarantee: { days: Math.round(daysValue) },
      }),
    );
    submit(formData, { method: "post" });
  };

  if (!settings) {
    // Transient only: the loader returns null settings while a child route
    // owns the URL, and the wrapper renders the <Outlet /> in that case.
    return null;
  }

  return (
    <Page
      title="Product boosters"
      subtitle="Per-product trust widgets for product pages"
      backAction={{ content: "Dashboard", url: "/app" }}
    >
      <TitleBar title="Product boosters" />
      <Layout>
        <Layout.Section>
          <Card>
            <FeaturePageHeader
              featureKey="clinical_study"
              enabled={headerEnabled}
              reachCaption="PDP trust boosters"
            />
          </Card>
        </Layout.Section>

        {definitionErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone="critical"
              title="Could not prepare the booster content model"
            >
              <BlockStack gap="100">
                <Text as="p">
                  Some Shopify metaobject or metafield definitions could not be
                  created. Editors below may fail to save until this is
                  resolved — reload the page to retry.
                </Text>
                {definitionErrors.map((error) => (
                  <Text as="p" key={error} variant="bodySm">
                    {error}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          </Layout.Section>
        ) : null}

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
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <InlineStack gap="300" align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Global switches
                  </Text>
                  <Button variant="plain" url="/app/markets">
                    Market targeting matrix
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Master toggles for the five product-page trust boosters. A
                  widget renders only when its master toggle is on, the market
                  matches, the product hasn’t opted out, and (for content
                  widgets) the product has content.
                </Text>
              </BlockStack>
              {PDP_FEATURES.map((feature) => {
                const enabled = feature.isEnabled(settings);
                return (
                  <BlockStack key={feature.key} gap="400">
                    <Divider />
                    <InlineStack
                      gap="300"
                      align="space-between"
                      blockAlign="center"
                      wrap
                    >
                      <Box maxWidth="60ch">
                        <BlockStack gap="050">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="h3" variant="headingSm">
                              {feature.title}
                            </Text>
                            <Badge tone={enabled ? "success" : undefined}>
                              {enabled ? "Active" : "Off"}
                            </Badge>
                          </InlineStack>
                          <Text as="p" tone="subdued" variant="bodySm">
                            {feature.description}
                          </Text>
                          <Text as="p" tone="subdued" variant="bodySm">
                            Market reach:{" "}
                            {marketReachCaption(
                              settings.marketScopes[feature.key],
                            )}
                          </Text>
                        </BlockStack>
                      </Box>
                      <InlineStack gap="200" blockAlign="center">
                        {feature.key === "derm_survey" ? (
                          <Button variant="plain" url="/app/features/survey">
                            Survey settings
                          </Button>
                        ) : null}
                        <Button
                          onClick={() => toggleFeature(feature, !enabled)}
                          loading={pendingFeature === feature.key}
                          variant={enabled ? "secondary" : "primary"}
                        >
                          {enabled ? "Disable" : "Enable"}
                        </Button>
                      </InlineStack>
                    </InlineStack>
                    {feature.key === "empty_bottle_guarantee" ? (
                      <InlineStack gap="200" blockAlign="end" wrap>
                        <Box width="180px">
                          <TextField
                            label="Guarantee window"
                            type="number"
                            min={1}
                            max={365}
                            suffix="days"
                            value={guaranteeDays}
                            onChange={setGuaranteeDays}
                            error={
                              daysValid ? undefined : "Between 1 and 365"
                            }
                            helpText="“Take N days…” in the panel copy."
                            autoComplete="off"
                          />
                        </Box>
                        <Button
                          size="slim"
                          onClick={saveGuaranteeDays}
                          disabled={!daysDirty || !daysValid}
                          loading={
                            pendingFeature === "empty_bottle_guarantee_days"
                          }
                        >
                          Save days
                        </Button>
                      </InlineStack>
                    ) : null}
                  </BlockStack>
                );
              })}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Products
                </Text>
                <Text as="p" tone="subdued">
                  Configure clinical studies, verified before/afters, batch
                  transparency and per-product opt-outs. Showing the first 25
                  products by title — search to narrow down.
                </Text>
              </BlockStack>
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <Box width="100%">
                  <TextField
                    label="Search products"
                    labelHidden
                    placeholder="Search by product title"
                    value={query}
                    onChange={setQuery}
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setQuery("")}
                  />
                </Box>
                {searching ? (
                  <Spinner size="small" accessibilityLabel="Searching products" />
                ) : null}
              </InlineStack>

              {productErrors.length > 0 ? (
                <Banner tone="critical" title="Could not load products">
                  <BlockStack gap="100">
                    {productErrors.map((error) => (
                      <Text as="p" key={error}>
                        {error}
                      </Text>
                    ))}
                  </BlockStack>
                </Banner>
              ) : null}

              {productErrors.length === 0 && products.length === 0 ? (
                <Text as="p" tone="subdued">
                  {q.trim() === ""
                    ? "No products found in this store."
                    : `No products matched “${q.trim()}”.`}
                </Text>
              ) : null}

              {products.map((product) => (
                <ProductRow key={product.id} product={product} />
              ))}

              {products.length > 0 ? (
                <Text as="p" tone="subdued" variant="bodySm">
                  on = configured (where content applies) and the product is
                  opted in · off = the product opted out · not set = no content
                  yet. The global switches and market scopes above still gate
                  what shoppers see.
                </Text>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
