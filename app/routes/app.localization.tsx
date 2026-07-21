import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Card,
  DataTable,
  InlineStack,
  Layout,
  Page,
  Tag,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

interface ShopLocale {
  locale: string;
  name: string;
  primary: boolean;
  published: boolean;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
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
  return { locales };
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

export default function LocalizationPage() {
  const { locales } = useLoaderData<typeof loader>();

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
