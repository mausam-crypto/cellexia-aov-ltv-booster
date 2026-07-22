import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useCallback, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  InlineStack,
  Layout,
  Link as PolarisLink,
  Page,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  deeplTargetForLocale,
  getTranslationConfig,
  saveTranslationConfig,
  verifyDeeplKey,
  type DeeplUsage,
} from "../services/translation.server";

interface ShopLocale {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const response = await admin.graphql(
    `#graphql
      query cellexiaShopLocales {
        shopLocales {
          locale
          name
          primary
          published
        }
      }
    `,
  );
  const json = (await response.json()) as {
    data?: { shopLocales?: ShopLocale[] };
  };
  const locales = (json.data?.shopLocales ?? []).filter(
    (locale): locale is ShopLocale =>
      typeof locale?.locale === "string" && typeof locale?.name === "string",
  );
  const config = await getTranslationConfig(session.shop);
  // Never send the key itself to the browser — only whether one is stored.
  return {
    locales,
    autoTranslate: {
      configured: config.configured,
      autoOnSave: config.autoOnSave,
      unsupported: locales
        .filter((l) => l.published && !l.primary)
        .map((l) => l.locale)
        .filter((locale) => !deeplTargetForLocale(locale)),
    },
  };
};

interface AutoTranslateActionResult {
  ok: boolean;
  errors: string[];
  configured: boolean;
  usage: DeeplUsage | null;
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<AutoTranslateActionResult> => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  if (intent === "clear_deepl_key") {
    await saveTranslationConfig(session.shop, { clearKey: true });
    return { ok: true, errors: [], configured: false, usage: null };
  }
  if (intent !== "save_deepl") {
    return { ok: false, errors: ["Unknown action"], configured: false, usage: null };
  }
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const autoOnSave = String(formData.get("autoOnSave") ?? "") === "true";
  // Verify BEFORE storing a newly-entered key so a typo never sits silently.
  if (apiKey !== "") {
    const usage = await verifyDeeplKey(apiKey);
    if (!usage.ok) {
      const current = await getTranslationConfig(session.shop);
      await saveTranslationConfig(session.shop, { autoOnSave });
      return {
        ok: false,
        errors: [usage.error ?? "DeepL rejected the key"],
        configured: current.configured,
        usage,
      };
    }
    await saveTranslationConfig(session.shop, { apiKey, autoOnSave });
    return { ok: true, errors: [], configured: true, usage };
  }
  const saved = await saveTranslationConfig(session.shop, { autoOnSave });
  const usage = saved.configured ? await verifyDeeplKey(saved.apiKey) : null;
  return { ok: true, errors: [], configured: saved.configured, usage };
};

/** Languages our extensions ship locale files for (matches the theme's locales/). */
const SHIPPED_LOCALES = [
  "ar",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fi",
  "fr",
  "hu",
  "it",
  "ja",
  "nl",
  "no",
  "pl",
  "pt-PT",
  "ro",
  "sv",
] as const;

const LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  fi: "Finnish",
  fr: "French",
  hu: "Hungarian",
  it: "Italian",
  ja: "Japanese",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  "pt-PT": "Portuguese (Portugal)",
  ro: "Romanian",
  sv: "Swedish",
};

function isCovered(locale: string): boolean {
  const normalized = locale.toLowerCase();
  const shipped = SHIPPED_LOCALES.map((code) => code.toLowerCase());
  if (shipped.includes(normalized)) return true;
  // Checkout extensions additionally ship nb.json (Norwegian Bokmål).
  if (normalized === "nb" || normalized.startsWith("nb-")) return true;
  const base = normalized.split("-")[0];
  return shipped.includes(base);
}

const HOW_TO_STEPS: string[] = [
  "Open Translate & Adapt: Shopify admin → Sales channels → Online Store → Translate & Adapt (also reachable via Settings → Languages → Localize).",
  "App embed and app block text overrides you enter in the theme editor appear under Theme content — translate them there per language. The built-in widget strings are already translated and need no work.",
  "Selling-plan names (the Joy “Continuous Treatment Plan”) are native Shopify resources — translate them in Translate & Adapt under Products → Subscription plans.",
  "Checkout extension strings ship translated automatically in every language listed below (plus nb for Norwegian checkout) — nothing to do.",
];

function AutoTranslateCard({
  configured,
  autoOnSave,
  unsupported,
}: {
  configured: boolean;
  autoOnSave: boolean;
  unsupported: string[];
}) {
  const fetcher = useFetcher<AutoTranslateActionResult>();
  const [apiKey, setApiKey] = useState("");
  const [auto, setAuto] = useState(autoOnSave);
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const isConfigured = result ? result.configured : configured;

  const save = useCallback(() => {
    fetcher.submit(
      { intent: "save_deepl", apiKey, autoOnSave: String(auto) },
      { method: "post" },
    );
    setApiKey("");
  }, [fetcher, apiKey, auto]);

  const clearKey = useCallback(() => {
    fetcher.submit({ intent: "clear_deepl_key" }, { method: "post" });
  }, [fetcher]);

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Automatic translation of product booster content
          </Text>
          {isConfigured ? (
            <Badge tone="success">Connected</Badge>
          ) : (
            <Badge tone="attention">Not set up</Badge>
          )}
        </InlineStack>
        <Text as="p" tone="subdued">
          The built-in widget strings ship pre-translated — but the content
          you write per product (clinical study, verifier statements, batch
          intro…) is yours, so Shopify shows it in your primary language
          everywhere until it is translated. Connect a DeepL API key and the
          app translates that content into every published shop language and
          registers the results as native Shopify translations — you can
          review or override any of them in Translate &amp; Adapt afterwards.
        </Text>
        <Text as="p" tone="subdued">
          Names stay untouched by design: labs, clinics, verifier names and
          license numbers, INCI ingredient names, batch codes, dates and URLs
          are never machine-translated.
        </Text>
        {result && result.errors.length > 0 ? (
          <Banner tone="critical" title="DeepL key not saved">
            {result.errors.map((error) => (
              <Text as="p" key={error}>
                {error}
              </Text>
            ))}
          </Banner>
        ) : null}
        {result?.ok && result.usage?.ok ? (
          <Banner tone="success" title="DeepL connected">
            <Text as="p">
              {typeof result.usage.characterCount === "number" &&
              typeof result.usage.characterLimit === "number"
                ? `Quota used this period: ${result.usage.characterCount.toLocaleString("en")} of ${result.usage.characterLimit.toLocaleString("en")} characters.`
                : "The key was verified against the DeepL API."}
            </Text>
          </Banner>
        ) : null}
        <TextField
          label="DeepL API key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={setApiKey}
          placeholder={
            isConfigured ? "A key is stored — enter a new one to replace it" : ""
          }
          helpText={
            <>
              Free at{" "}
              <PolarisLink
                url="https://www.deepl.com/pro-api"
                target="_blank"
              >
                deepl.com/pro-api
              </PolarisLink>{" "}
              — the free tier (500,000 characters/month) covers this store
              many times over. The key is stored on your app server only and
              is never sent to the storefront.
            </>
          }
        />
        <Checkbox
          label="Translate automatically every time booster content is saved"
          checked={auto}
          onChange={setAuto}
          helpText="When off, use the “Translate into all languages” button in each product's booster editor."
        />
        <InlineStack gap="200">
          <Button
            variant="primary"
            onClick={save}
            loading={busy}
            disabled={apiKey.trim() === "" && !isConfigured}
          >
            {apiKey.trim() === "" ? "Save settings" : "Save & verify key"}
          </Button>
          {isConfigured ? (
            <Button tone="critical" variant="plain" onClick={clearKey} disabled={busy}>
              Remove key
            </Button>
          ) : null}
        </InlineStack>
        {unsupported.length > 0 ? (
          <Text as="p" tone="subdued" variant="bodySm">
            Not supported by DeepL and skipped: {unsupported.join(", ")}.
            Translate these languages manually in Translate &amp; Adapt.
          </Text>
        ) : null}
        <Text as="p" tone="subdued" variant="bodySm">
          Machine translation is a strong first pass, not a proofreader —
          review regulated or medical claims per language in Translate &amp;
          Adapt before relying on them.
        </Text>
      </BlockStack>
    </Card>
  );
}

export default function LocalizationPage() {
  const { locales, autoTranslate } = useLoaderData<typeof loader>();

  const rows = locales.map((locale) => [
    locale.name,
    locale.locale,
    <InlineStack key={`${locale.locale}-status`} gap="100">
      {locale.primary ? <Badge tone="info">Primary</Badge> : null}
      {locale.published ? (
        <Badge tone="success">Published</Badge>
      ) : (
        <Badge tone="attention">Unpublished</Badge>
      )}
    </InlineStack>,
    isCovered(locale.locale) ? (
      <Badge key={`${locale.locale}-covered`} tone="success">
        ✓ Included
      </Badge>
    ) : (
      <Text key={`${locale.locale}-uncovered`} as="span" tone="subdued">
        — Falls back to English
      </Text>
    ),
  ]);

  return (
    <Page title="Languages" backAction={{ content: "Dashboard", url: "/app" }}>
      <TitleBar title="Languages" />
      <Layout>
        <Layout.Section>
          <AutoTranslateCard
            configured={autoTranslate.configured}
            autoOnSave={autoTranslate.autoOnSave}
            unsupported={autoTranslate.unsupported}
          />
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Your shop languages
              </Text>
              <Text as="p" tone="subdued">
                Every widget string ships pre-translated for the languages
                marked “Included”. Languages without a match fall back to
                English until you add translations via Translate &amp; Adapt.
              </Text>
              {locales.length === 0 ? (
                <Text as="p" tone="subdued">
                  Could not load the shop languages. Reload the page to try
                  again.
                </Text>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text"]}
                  headings={[
                    "Language",
                    "Locale",
                    "Status",
                    "Widget strings",
                  ]}
                  rows={rows}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Shipped languages (17)
              </Text>
              <InlineStack gap="200" wrap>
                {SHIPPED_LOCALES.map((code) => (
                  <Tag key={code}>
                    {LANGUAGE_NAMES[code] ?? code} ({code})
                  </Tag>
                ))}
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">
                Checkout extensions additionally ship nb (Norwegian Bokmål),
                which Shopify checkout uses for Norwegian.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Translate &amp; Adapt — how to
              </Text>
              <BlockStack gap="200">
                {HOW_TO_STEPS.map((step, index) => (
                  <InlineStack
                    key={`step-${index}`}
                    gap="200"
                    blockAlign="start"
                    wrap={false}
                  >
                    <Badge>{String(index + 1)}</Badge>
                    <Text as="p">{step}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
