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
  ChoiceList,
  DataTable,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getSettings,
  saveSettings,
  type BoosterSettings,
  type DeepPartial,
  type MarketThreshold,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { listMarkets, type MarketSummary } from "../services/markets.server";
import { detectFreeShippingThresholds } from "../services/shipping.server";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface DetectionSummary {
  ok: boolean;
  errors: string[];
  unmatchedZones: number;
  detectedCount: number;
}

interface SettingsActionResult {
  ok: boolean;
  syncErrors: string[];
  resynced: boolean;
  detection?: DetectionSummary;
}

const UTC_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Fixed-format, timezone-independent timestamp (e.g. "Jul 21, 2026, 09:15
 * UTC"), built SERVER-SIDE in the loader and rendered verbatim — a
 * client-side toLocaleString() would hydrate differently from the server
 * render and trigger a React hydration mismatch.
 */
function formatUtcTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${UTC_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

async function applySettingsPatch(
  shop: string,
  admin: AdminGraphqlClient,
  rawPatch: FormDataEntryValue | null,
): Promise<SettingsActionResult> {
  if (typeof rawPatch !== "string" || rawPatch.trim() === "") {
    return { ok: false, syncErrors: ["Missing settings payload."], resynced: false };
  }
  let patch: DeepPartial<BoosterSettings>;
  try {
    const parsed: unknown = JSON.parse(rawPatch);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        syncErrors: ["Settings payload must be an object."],
        resynced: false,
      };
    }
    patch = parsed as DeepPartial<BoosterSettings>;
  } catch {
    return {
      ok: false,
      syncErrors: ["Settings payload was not valid JSON."],
      resynced: false,
    };
  }
  const next = await saveSettings(shop, patch);
  try {
    const sync = await syncSettingsToMetafields(admin, next);
    return { ok: true, syncErrors: sync.errors, resynced: false };
  } catch (error) {
    return {
      ok: true,
      syncErrors: [
        error instanceof Error
          ? error.message
          : "Could not sync settings to storefront metafields.",
      ],
      resynced: false,
    };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const [settings, markets] = await Promise.all([
    getSettings(session.shop),
    listMarkets(admin).catch(() => [] as MarketSummary[]),
  ]);
  let currencyCode = "";
  try {
    const response = await admin.graphql(
      `#graphql
        query cellexiaShopCurrency {
          shop {
            currencyCode
          }
        }
      `,
    );
    const json = (await response.json()) as {
      data?: { shop?: { currencyCode?: string } };
    };
    currencyCode = json.data?.shop?.currencyCode ?? "";
  } catch {
    currencyCode = "";
  }
  const storePrefix = session.shop.replace(".myshopify.com", "");
  return {
    settings,
    markets,
    currencyCode,
    // Pre-formatted server-side (fixed UTC format) so SSR and hydration
    // render the identical string — never toLocaleString() in the client.
    detectedAtText: settings.freeShipping.detectedAt
      ? formatUtcTimestamp(settings.freeShipping.detectedAt)
      : null,
    themeEditorUrl: `https://admin.shopify.com/store/${storePrefix}/themes/current/editor?context=apps`,
    checkoutEditorUrl: `https://admin.shopify.com/store/${storePrefix}/settings/checkout/editor`,
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<SettingsActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "resync") {
    const current = await getSettings(session.shop);
    try {
      const sync = await syncSettingsToMetafields(admin, current);
      return { ok: sync.ok, syncErrors: sync.errors, resynced: true };
    } catch (error) {
      return {
        ok: false,
        syncErrors: [
          error instanceof Error
            ? error.message
            : "Could not sync settings to storefront metafields.",
        ],
        resynced: true,
      };
    }
  }

  if (formData.get("intent") === "detect_shipping") {
    const detection = await detectFreeShippingThresholds(admin, session.shop);
    const summary: DetectionSummary = {
      ok: detection.ok,
      errors:
        detection.errors.length > 0 || detection.ok
          ? detection.errors
          : ["Could not read the store's shipping rates."],
      unmatchedZones: detection.unmatchedZones,
      detectedCount: Object.keys(detection.byMarket).length,
    };
    if (!detection.ok) {
      return { ok: false, syncErrors: [], resynced: false, detection: summary };
    }
    const next = await saveSettings(session.shop, {
      freeShipping: {
        mode: "auto",
        byMarket: detection.byMarket,
        detectedAt: new Date().toISOString(),
      },
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
    return { ok: true, syncErrors, resynced: false, detection: summary };
  }

  return applySettingsPatch(session.shop, admin, formData.get("patch"));
};

const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

/** Mirrors DEFAULT_SETTINGS.global (kept local: server modules must not be
 *  referenced from client-rendered code). */
const COLOR_DEFAULTS = {
  accentColor: "#B2CEED",
  inkColor: "#1D1D1B",
  surfaceColor: "#FFFFFF",
} as const;

interface MarketThresholdRow {
  handle: string;
  name: string;
  amount: string;
  currencyCode: string;
}

interface GlobalFormState {
  freeShippingMode: "auto" | "manual";
  marketRows: MarketThresholdRow[];
  freeShippingThreshold: string;
  accentColor: string;
  inkColor: string;
  surfaceColor: string;
}

function initialFormState(
  settings: BoosterSettings,
  markets: MarketSummary[],
  shopCurrency: string,
): GlobalFormState {
  return {
    freeShippingMode: settings.freeShipping.mode,
    marketRows: markets.map((market) => {
      const entry = settings.freeShipping.byMarket[market.handle];
      return {
        handle: market.handle,
        name: market.name,
        amount: entry ? String(entry.amount) : "",
        currencyCode:
          entry?.currencyCode || market.currencyCode || shopCurrency || "",
      };
    }),
    freeShippingThreshold: String(settings.global.freeShippingThreshold),
    accentColor: settings.global.accentColor,
    inkColor: settings.global.inkColor,
    surfaceColor: settings.global.surfaceColor,
  };
}

function ColorSwatch({ color }: { color: string }) {
  return (
    <div
      aria-hidden
      style={{
        width: 20,
        height: 20,
        borderRadius: 4,
        border: "1px solid #d8d8d8",
        background: HEX_COLOR_PATTERN.test(color) ? color : "#ffffff",
      }}
    />
  );
}

export default function SettingsPage() {
  const {
    settings,
    markets,
    currencyCode,
    detectedAtText,
    themeEditorUrl,
    checkoutEditorUrl,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<GlobalFormState>(() =>
    initialFormState(settings, markets, currencyCode),
  );

  useEffect(() => {
    setState(initialFormState(settings, markets, currencyCode));
  }, [settings, markets, currencyCode]);

  useEffect(() => {
    if (!actionData) return;
    if (actionData.detection) {
      if (!actionData.detection.ok) {
        shopify.toast.show("Threshold detection failed", { isError: true });
      } else if (actionData.syncErrors.length > 0) {
        shopify.toast.show("Detected, but the storefront sync failed", {
          isError: true,
        });
      } else {
        const count = actionData.detection.detectedCount;
        shopify.toast.show(
          count === 0
            ? "No free-shipping rates with a minimum amount found"
            : `Detected thresholds for ${count} market${count === 1 ? "" : "s"}`,
        );
      }
      return;
    }
    if (actionData.resynced) {
      if (actionData.ok && actionData.syncErrors.length === 0) {
        shopify.toast.show("Storefront config re-synced");
      } else {
        shopify.toast.show("Storefront re-sync failed", { isError: true });
      }
      return;
    }
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

  const initial = useMemo(
    () => initialFormState(settings, markets, currencyCode),
    [settings, markets, currencyCode],
  );
  const dirty = JSON.stringify(state) !== JSON.stringify(initial);

  const pendingIntent =
    navigation.state !== "idle" && navigation.formData
      ? navigation.formData.get("intent")
      : null;
  const isSaving =
    navigation.state !== "idle" &&
    navigation.formMethod === "POST" &&
    pendingIntent === null;
  const isResyncing = pendingIntent === "resync";
  const isDetecting = pendingIntent === "detect_shipping";

  const thresholdValue = Number(state.freeShippingThreshold);
  const thresholdError =
    state.freeShippingThreshold.trim() === "" ||
    !Number.isFinite(thresholdValue) ||
    thresholdValue < 0
      ? "Enter a positive amount"
      : undefined;

  const marketRowErrors = state.marketRows.map(
    (row): { amountError?: string; currencyError?: string } => {
      // An empty amount means "no per-market threshold" — the market uses
      // the global fallback, so the currency field is not validated either.
      if (row.amount.trim() === "") return {};
      const amount = Number(row.amount);
      return {
        amountError:
          !Number.isFinite(amount) || amount < 0 || amount > 100000
            ? "Between 0 and 100000"
            : undefined,
        currencyError: CURRENCY_PATTERN.test(row.currencyCode.trim())
          ? undefined
          : "3-letter code",
      };
    },
  );
  const hasManualErrors =
    state.freeShippingMode === "manual" &&
    marketRowErrors.some((row) => row.amountError || row.currencyError);

  const colorError = (value: string): string | undefined =>
    HEX_COLOR_PATTERN.test(value)
      ? undefined
      : "Enter a hex color like #B2CEED";

  const hasErrors = Boolean(
    thresholdError ||
      hasManualErrors ||
      colorError(state.accentColor) ||
      colorError(state.inkColor) ||
      colorError(state.surfaceColor),
  );

  const handleSave = () => {
    const patch: DeepPartial<BoosterSettings> = {
      global: {
        freeShippingThreshold: thresholdValue,
        accentColor: state.accentColor.trim(),
        inkColor: state.inkColor.trim(),
        surfaceColor: state.surfaceColor.trim(),
      },
      // byMarket is merged wholesale (DYNAMIC_RECORD_KEYS), so it is only
      // included for manual saves — auto mode keeps the detected entries.
      freeShipping: { mode: state.freeShippingMode },
    };
    if (state.freeShippingMode === "manual") {
      const byMarket: Record<string, MarketThreshold> = {};
      for (const row of state.marketRows) {
        if (row.amount.trim() === "") continue;
        const amount = Number(row.amount);
        if (!Number.isFinite(amount)) continue;
        byMarket[row.handle] = {
          amount,
          currencyCode: row.currencyCode.trim().toUpperCase(),
        };
      }
      patch.freeShipping = { mode: "manual", byMarket };
    }
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  const handleResync = () => {
    const formData = new FormData();
    formData.set("intent", "resync");
    submit(formData, { method: "post" });
  };

  const handleDetect = () => {
    const formData = new FormData();
    formData.set("intent", "detect_shipping");
    submit(formData, { method: "post" });
  };

  const updateMarketRow = (
    index: number,
    update: Partial<MarketThresholdRow>,
  ) => {
    setState((previous) => ({
      ...previous,
      marketRows: previous.marketRows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...update } : row,
      ),
    }));
  };

  // Read-only view of the PERSISTED thresholds (auto mode) — detected values
  // are saved by the detect action, so the table reflects loader data.
  const knownHandles = new Set(markets.map((market) => market.handle));
  const autoRows: string[][] = [
    ...markets.map((market) => {
      const entry = settings.freeShipping.byMarket[market.handle];
      return entry
        ? [market.name, String(entry.amount), entry.currencyCode, "Detected"]
        : [
            market.name,
            String(settings.global.freeShippingThreshold),
            currencyCode || "shop currency",
            "Fallback",
          ];
    }),
    ...Object.entries(settings.freeShipping.byMarket)
      .filter(([handle]) => !knownHandles.has(handle))
      .map(([handle, entry]) => [
        handle,
        String(entry.amount),
        entry.currencyCode,
        "Detected",
      ]),
  ];

  const detection = actionData?.detection;
  const showDetectionBanner = Boolean(
    detection &&
      (detection.errors.length > 0 ||
        detection.unmatchedZones > 0 ||
        (detection.ok && detection.detectedCount === 0)),
  );

  const colorFields: {
    key: keyof Pick<
      GlobalFormState,
      "accentColor" | "inkColor" | "surfaceColor"
    >;
    label: string;
    helpText: string;
    fallback: string;
  }[] = [
    {
      key: "accentColor",
      label: "Accent color",
      helpText: `Cellexia Blue — progress bars and highlights (default ${COLOR_DEFAULTS.accentColor}).`,
      fallback: COLOR_DEFAULTS.accentColor,
    },
    {
      key: "inkColor",
      label: "Ink color",
      helpText: `Text and dark surfaces (default ${COLOR_DEFAULTS.inkColor}).`,
      fallback: COLOR_DEFAULTS.inkColor,
    },
    {
      key: "surfaceColor",
      label: "Surface color",
      helpText: `Widget surface background (default ${COLOR_DEFAULTS.surfaceColor}).`,
      fallback: COLOR_DEFAULTS.surfaceColor,
    },
  ];

  return (
    <Page
      title="Settings"
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
      <TitleBar title="Settings" />
      <Layout>
        {actionData && actionData.syncErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone={actionData.ok ? "warning" : "critical"}
              title={
                actionData.resynced
                  ? "Storefront re-sync reported errors"
                  : actionData.ok
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
        {actionData?.resynced &&
        actionData.ok &&
        actionData.syncErrors.length === 0 ? (
          <Layout.Section>
            <Banner tone="success" title="Storefront config re-synced">
              <Text as="p">
                Both metafields (theme extension and checkout extensions) now
                hold the latest settings.
              </Text>
            </Banner>
          </Layout.Section>
        ) : null}
        {detection && showDetectionBanner ? (
          <Layout.Section>
            <Banner
              tone={detection.ok ? "warning" : "critical"}
              title={
                detection.ok
                  ? "Threshold detection finished with notes"
                  : "Could not detect free-shipping thresholds"
              }
            >
              <BlockStack gap="100">
                {detection.ok && detection.detectedCount === 0 ? (
                  <Text as="p">
                    No active free rate with a “minimum order amount”
                    condition was found in your shipping profiles — all
                    markets keep using the fallback threshold below.
                  </Text>
                ) : null}
                {detection.unmatchedZones > 0 ? (
                  <Text as="p">
                    {detection.unmatchedZones} shipping zone
                    {detection.unmatchedZones === 1 ? "" : "s"} (rest of world
                    or countries outside your markets) could not be matched to
                    a market — buyers there use the fallback threshold.
                  </Text>
                ) : null}
                {detection.errors.map((error) => (
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
                  Free shipping thresholds
                </Text>
                <Text as="p" tone="subdued">
                  Used by the free-shipping progress bar and the “Free
                  shipping over …” badge. Per-market thresholds keep the bar
                  honest in every market.
                </Text>
                <ChoiceList
                  title="Threshold source"
                  titleHidden
                  choices={[
                    {
                      label: "Auto-detect from shipping rates",
                      value: "auto",
                      helpText:
                        "Reads your shipping profiles for active free rates with a “minimum order amount” condition (thresholds are in the shop currency).",
                    },
                    {
                      label: "Manual per market",
                      value: "manual",
                      helpText:
                        "Enter a threshold per market, typically in the market's own currency.",
                    },
                  ]}
                  selected={[state.freeShippingMode]}
                  onChange={(selected) =>
                    setState((previous) => ({
                      ...previous,
                      freeShippingMode:
                        selected[0] === "manual" ? "manual" : "auto",
                    }))
                  }
                />

                {state.freeShippingMode === "auto" ? (
                  <BlockStack gap="300">
                    <InlineStack gap="300" blockAlign="center">
                      <Button
                        onClick={handleDetect}
                        loading={isDetecting}
                        disabled={isSaving || isResyncing}
                      >
                        Detect now
                      </Button>
                      <Text as="span" tone="subdued" variant="bodySm">
                        {detectedAtText
                          ? `Last detected: ${detectedAtText}`
                          : "Not detected yet — run “Detect now” after changing shipping rates."}
                      </Text>
                    </InlineStack>
                    {autoRows.length > 0 ? (
                      <DataTable
                        columnContentTypes={[
                          "text",
                          "numeric",
                          "text",
                          "text",
                        ]}
                        headings={["Market", "Threshold", "Currency", "Source"]}
                        rows={autoRows}
                      />
                    ) : (
                      <Text as="p" tone="subdued" variant="bodySm">
                        No markets could be loaded — the storefront uses the
                        fallback threshold below.
                      </Text>
                    )}
                  </BlockStack>
                ) : (
                  <BlockStack gap="300">
                    {state.marketRows.length === 0 ? (
                      <Text as="p" tone="subdued" variant="bodySm">
                        No markets could be loaded — the storefront uses the
                        fallback threshold below.
                      </Text>
                    ) : (
                      <BlockStack gap="200">
                        <Text as="p" tone="subdued" variant="bodySm">
                          Leave a market empty to use the fallback threshold
                          below.
                        </Text>
                        {state.marketRows.map((row, index) => (
                          <InlineStack
                            key={row.handle}
                            gap="300"
                            blockAlign="start"
                            wrap={false}
                          >
                            <Box width="240px">
                              <TextField
                                label={row.name}
                                type="number"
                                min={0}
                                value={row.amount}
                                onChange={(amount) =>
                                  updateMarketRow(index, { amount })
                                }
                                placeholder="Fallback"
                                error={marketRowErrors[index]?.amountError}
                                autoComplete="off"
                              />
                            </Box>
                            <Box width="120px">
                              <TextField
                                label="Currency"
                                value={row.currencyCode}
                                onChange={(value) =>
                                  updateMarketRow(index, {
                                    currencyCode: value.toUpperCase(),
                                  })
                                }
                                maxLength={3}
                                error={marketRowErrors[index]?.currencyError}
                                autoComplete="off"
                              />
                            </Box>
                          </InlineStack>
                        ))}
                      </BlockStack>
                    )}
                  </BlockStack>
                )}

                <Divider />
                <Box maxWidth="260px">
                  <TextField
                    label="Other markets / fallback"
                    type="number"
                    min={0}
                    value={state.freeShippingThreshold}
                    onChange={(freeShippingThreshold) =>
                      setState((previous) => ({
                        ...previous,
                        freeShippingThreshold,
                      }))
                    }
                    suffix={currencyCode || "shop currency"}
                    error={thresholdError}
                    helpText="Used for markets without a threshold above. Keep it in sync with the theme’s free-shipping setting (150) and your shipping rates."
                    autoComplete="off"
                  />
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Brand colors
                </Text>
                <Text as="p" tone="subdued">
                  Used by the storefront widgets. The defaults match the
                  Cellexia theme tokens.
                </Text>
                <InlineStack gap="300" wrap>
                  {colorFields.map((field) => (
                    <Box key={field.key} width="240px">
                      <TextField
                        label={field.label}
                        value={state[field.key]}
                        onChange={(value) =>
                          setState((previous) => ({
                            ...previous,
                            [field.key]: value,
                          }))
                        }
                        prefix={<ColorSwatch color={state[field.key]} />}
                        placeholder={field.fallback}
                        error={colorError(state[field.key])}
                        helpText={field.helpText}
                        autoComplete="off"
                      />
                    </Box>
                  ))}
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Storefront sync
                </Text>
                <Text as="p" tone="subdued">
                  Settings are mirrored automatically on every save to the app
                  metafield read by the theme extension and to the shop
                  metafield read by the checkout extensions. Use re-sync if a
                  save reported sync errors or after reinstalling the app.
                </Text>
                <InlineStack>
                  <Button onClick={handleResync} loading={isResyncing}>
                    Re-sync storefront config
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Setup links
                </Text>
                <Text as="p" tone="subdued">
                  The storefront widgets render only after the “Cellexia
                  Booster” app embeds are enabled under App embeds in the theme
                  editor. Checkout blocks are placed in the checkout editor
                  (Shopify Plus).
                </Text>
                <InlineStack gap="300">
                  <Button url={themeEditorUrl} target="_blank">
                    Open theme editor (app embeds)
                  </Button>
                  <Button url={checkoutEditorUrl} target="_blank">
                    Open checkout editor
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
