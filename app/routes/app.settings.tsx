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
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface SettingsActionResult {
  ok: boolean;
  syncErrors: string[];
  resynced: boolean;
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
  const settings = await getSettings(session.shop);
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
    currencyCode,
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

  return applySettingsPatch(session.shop, admin, formData.get("patch"));
};

const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Mirrors DEFAULT_SETTINGS.global (kept local: server modules must not be
 *  referenced from client-rendered code). */
const COLOR_DEFAULTS = {
  accentColor: "#B2CEED",
  inkColor: "#1D1D1B",
  surfaceColor: "#FFFFFF",
} as const;

interface GlobalFormState {
  freeShippingThreshold: string;
  accentColor: string;
  inkColor: string;
  surfaceColor: string;
}

function initialFormState(global: BoosterSettings["global"]): GlobalFormState {
  return {
    freeShippingThreshold: String(global.freeShippingThreshold),
    accentColor: global.accentColor,
    inkColor: global.inkColor,
    surfaceColor: global.surfaceColor,
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
  const { settings, currencyCode, themeEditorUrl, checkoutEditorUrl } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [state, setState] = useState<GlobalFormState>(() =>
    initialFormState(settings.global),
  );

  useEffect(() => {
    setState(initialFormState(settings.global));
  }, [settings]);

  useEffect(() => {
    if (!actionData) return;
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

  const initial = useMemo(() => initialFormState(settings.global), [settings]);
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

  const thresholdValue = Number(state.freeShippingThreshold);
  const thresholdError =
    state.freeShippingThreshold.trim() === "" ||
    !Number.isFinite(thresholdValue) ||
    thresholdValue < 0
      ? "Enter a positive amount"
      : undefined;

  const colorError = (value: string): string | undefined =>
    HEX_COLOR_PATTERN.test(value)
      ? undefined
      : "Enter a hex color like #B2CEED";

  const hasErrors = Boolean(
    thresholdError ||
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
    };
    const formData = new FormData();
    formData.set("patch", JSON.stringify(patch));
    submit(formData, { method: "post" });
  };

  const handleResync = () => {
    const formData = new FormData();
    formData.set("intent", "resync");
    submit(formData, { method: "post" });
  };

  const colorFields: {
    key: keyof Omit<GlobalFormState, "freeShippingThreshold">;
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

        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Free shipping
                </Text>
                <Box maxWidth="260px">
                  <TextField
                    label="Free-shipping threshold"
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
                    helpText="Used by the free-shipping progress bar and the “Free shipping over …” badge. Keep it in sync with the theme’s free-shipping setting (150) and your shipping rates."
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
