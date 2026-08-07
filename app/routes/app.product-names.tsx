import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { ensurePdpDefinitions } from "../services/metaobjects.server";
import { listProductsWithBoosterStatus } from "../services/pdp-content.server";
import {
  getProductDisplayName,
  saveProductDisplayName,
} from "../services/product-names.server";
import { getTargetLocales } from "../services/translation.server";

/**
 * v8.13 Product names page: manual per-language display names for the
 * widgets that speak the product's name mid-sentence (dermatologist survey
 * rec/intro lines, clinical study subject). Values live in the translatable
 * cellexia.display_name product metafield; each language is registered as a
 * NATIVE Shopify translation on that metafield, so the storefront serves
 * the right name per locale with zero runtime cost. This surface is
 * manual-entry ONLY — display names are never machine-translated (the
 * DeepL metafield allowlist excludes cellexia.display_name by design).
 */

// Same once-per-shop definition-ensure as app.products.tsx: a merchant may
// open this tab FIRST after upgrading, before any page that would otherwise
// create the cellexia.display_name definition (review v8.13 F9).
const ensuredShops = new Set<string>();

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  if (!ensuredShops.has(session.shop)) {
    const ensured = await ensurePdpDefinitions(admin);
    if (ensured.ok) ensuredShops.add(session.shop);
  }
  const locales = await getTargetLocales(admin);
  return {
    locales: locales.locales
      .filter((l) => l.published && !l.primary)
      .map((l) => ({ locale: l.locale, name: l.name })),
    primary: locales.primary,
    localeErrors: locales.errors,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  switch (intent) {
    case "search_products": {
      const result = await listProductsWithBoosterStatus(
        admin,
        String(formData.get("q") ?? ""),
      );
      return {
        intent: "search_products" as const,
        ok: result.ok,
        errors: result.errors,
        products: result.products.map((product) => ({
          gid: product.id,
          title: product.title,
          imageUrl: product.imageUrl,
          status: product.status,
        })),
      };
    }
    case "load_names": {
      const gid = String(formData.get("gid") ?? "");
      const locales = await getTargetLocales(admin);
      const state = await getProductDisplayName(
        admin,
        gid,
        locales.locales
          .filter((l) => l.published && !l.primary)
          .map((l) => l.locale),
      );
      return { intent: "load_names" as const, ...state };
    }
    case "save_names": {
      const gid = String(formData.get("gid") ?? "");
      const baseName = String(formData.get("baseName") ?? "");
      let perLocale: Record<string, string> = {};
      try {
        const parsed: unknown = JSON.parse(String(formData.get("perLocale") ?? "{}"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          for (const [locale, value] of Object.entries(parsed)) {
            if (typeof value === "string") perLocale[locale] = value;
          }
        }
      } catch {
        return {
          intent: "save_names" as const,
          ok: false,
          errors: ["Names payload was not valid JSON."],
        };
      }
      const result = await saveProductDisplayName(admin, gid, baseName, perLocale);
      return { intent: "save_names" as const, ok: result.ok, errors: result.errors };
    }
    default:
      return { intent: "unknown" as const, ok: false, errors: ["Unknown intent"] };
  }
};

type ActionData = Awaited<ReturnType<typeof action>>;

interface ProductHit {
  gid: string;
  title: string;
  imageUrl: string | null;
  status: string;
}

export default function ProductNamesPage() {
  const { locales, localeErrors } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();

  const searchFetcher = useFetcher<ActionData>();
  const loadFetcher = useFetcher<ActionData>();
  const saveFetcher = useFetcher<ActionData>();

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ProductHit | null>(null);
  const [baseName, setBaseName] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  // Snapshot of the last loaded/saved state, for the dirty check.
  const cleanRef = useRef<string>("");
  // What the in-flight save actually submitted — the success effect marks
  // THIS clean, not whatever is on screen when the response lands.
  const submittedRef = useRef<string>("");
  // Read through a ref inside the hydrate effect: every fetcher POST makes
  // Remix revalidate the loader, which mints a new `locales` array identity —
  // with `locales` in the deps the effect would re-run with the STALE
  // load_names data and revert the merchant's edits after each save
  // (review v8.13 F7).
  const localesRef = useRef(locales);
  localesRef.current = locales;

  const searching = searchFetcher.state !== "idle";
  const loading = loadFetcher.state !== "idle";
  const saving = saveFetcher.state !== "idle";

  const hits = useMemo<ProductHit[]>(() => {
    const data = searchFetcher.data;
    if (!data || data.intent !== "search_products" || !data.ok) return [];
    return data.products ?? [];
  }, [searchFetcher.data]);

  // Loaded state → hydrate the editor.
  useEffect(() => {
    const data = loadFetcher.data;
    if (!data || data.intent !== "load_names") return;
    if (!data.ok) return;
    const next: Record<string, string> = {};
    for (const { locale } of localesRef.current) {
      next[locale] = data.perLocale[locale.toLowerCase()] ?? "";
    }
    setBaseName(data.baseName);
    setNames(next);
    cleanRef.current = JSON.stringify({ baseName: data.baseName, names: next });
  }, [loadFetcher.data]);

  // Save result → toast + mark the SUBMITTED snapshot clean.
  useEffect(() => {
    const data = saveFetcher.data;
    if (!data || data.intent !== "save_names") return;
    if (data.ok) {
      shopify.toast.show("Product names saved");
      cleanRef.current = submittedRef.current;
    }
    // Errors render in the banner below; no toast for those.
  }, [saveFetcher.data, shopify]);

  const dirty =
    selected !== null &&
    cleanRef.current !== "" &&
    cleanRef.current !== JSON.stringify({ baseName, names });

  const runSearch = () => {
    const formData = new FormData();
    formData.set("intent", "search_products");
    formData.set("q", query.trim());
    searchFetcher.submit(formData, { method: "post" });
  };

  const pickProduct = (hit: ProductHit) => {
    setSelected(hit);
    setBaseName("");
    setNames({});
    cleanRef.current = "";
    const formData = new FormData();
    formData.set("intent", "load_names");
    formData.set("gid", hit.gid);
    loadFetcher.submit(formData, { method: "post" });
  };

  const save = () => {
    if (!selected) return;
    submittedRef.current = JSON.stringify({ baseName, names });
    const formData = new FormData();
    formData.set("intent", "save_names");
    formData.set("gid", selected.gid);
    formData.set("baseName", baseName);
    formData.set("perLocale", JSON.stringify(names));
    saveFetcher.submit(formData, { method: "post" });
  };

  const loadError =
    loadFetcher.data && loadFetcher.data.intent === "load_names" && !loadFetcher.data.ok
      ? loadFetcher.data.errors[0] ?? "Could not load this product's names"
      : null;
  const saveErrors =
    saveFetcher.data && saveFetcher.data.intent === "save_names" && !saveFetcher.data.ok
      ? saveFetcher.data.errors
      : [];

  const fallbackName = baseName.trim() || selected?.title || "";

  return (
    <Page>
      <TitleBar title="Product names" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              <Text as="p" variant="bodyMd">
                The dermatologist survey and clinical study widgets mention your
                product by name inside a sentence. By default they use the
                product title, which can appear untranslated (or awkwardly
                machine-translated) on localized pages. Set the exact name to
                use in each language here — these names are never
                machine-translated.
              </Text>
            </Banner>
            {localeErrors.length > 0 ? (
              <Banner tone="warning" title="Could not load the shop's languages">
                <Text as="p" variant="bodySm">
                  {localeErrors[0]}
                </Text>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  1. Pick a product
                </Text>
                <TextField
                  label="Search products"
                  labelHidden
                  placeholder="Search products by title"
                  value={query}
                  onChange={setQuery}
                  autoComplete="off"
                  connectedRight={
                    <Button onClick={runSearch} loading={searching}>
                      Search
                    </Button>
                  }
                />
                {hits.length > 0 ? (
                  <BlockStack gap="100">
                    {hits.map((hit) => (
                      <InlineStack
                        key={hit.gid}
                        gap="200"
                        blockAlign="center"
                        align="space-between"
                      >
                        <InlineStack gap="200" blockAlign="center">
                          <Thumbnail
                            source={hit.imageUrl ?? ImageIcon}
                            alt={hit.title}
                            size="extraSmall"
                          />
                          <Text as="span" variant="bodySm">
                            {hit.title}
                          </Text>
                          {hit.status !== "ACTIVE" ? (
                            <Badge tone="info" size="small">
                              {hit.status === "DRAFT" ? "Draft" : "Archived"}
                            </Badge>
                          ) : null}
                        </InlineStack>
                        <Button
                          size="slim"
                          onClick={() => pickProduct(hit)}
                          disabled={loading || saving}
                          variant={
                            selected?.gid === hit.gid ? "primary" : undefined
                          }
                        >
                          {selected?.gid === hit.gid ? "Selected" : "Edit names"}
                        </Button>
                      </InlineStack>
                    ))}
                  </BlockStack>
                ) : null}
                {searchFetcher.data &&
                searchFetcher.data.intent === "search_products" &&
                !searchFetcher.data.ok ? (
                  <Text as="p" variant="bodySm" tone="critical">
                    {searchFetcher.data.errors[0] ?? "Product search failed"}
                  </Text>
                ) : null}
              </BlockStack>
            </Card>

            {selected ? (
              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center" align="space-between">
                    <InlineStack gap="200" blockAlign="center">
                      <Thumbnail
                        source={selected.imageUrl ?? ImageIcon}
                        alt={selected.title}
                        size="small"
                      />
                      <BlockStack gap="050">
                        <Text as="h2" variant="headingMd">
                          2. Names for “{selected.title}”
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          Leave a field blank to fall back to the name above
                          it (base name, then product title).
                        </Text>
                      </BlockStack>
                    </InlineStack>
                    <Button
                      variant="primary"
                      onClick={save}
                      loading={saving}
                      disabled={loading || !dirty}
                    >
                      Save names
                    </Button>
                  </InlineStack>

                  {loadError ? (
                    <Banner tone="critical" title="Could not load names">
                      <Text as="p" variant="bodySm">
                        {loadError}
                      </Text>
                    </Banner>
                  ) : null}
                  {saveErrors.length > 0 ? (
                    <Banner tone="critical" title="Save failed">
                      <BlockStack gap="100">
                        {saveErrors.map((message, index) => (
                          <Text key={index} as="p" variant="bodySm">
                            {message}
                          </Text>
                        ))}
                      </BlockStack>
                    </Banner>
                  ) : null}

                  <TextField
                    label="Base name (default language)"
                    value={baseName}
                    onChange={setBaseName}
                    autoComplete="off"
                    disabled={loading || saving}
                    placeholder={selected.title}
                    helpText="Used everywhere no language-specific name is set. Blank = use the product title."
                    maxLength={255}
                  />

                  {locales.length > 0 ? (
                    <>
                      <Divider />
                      <Text as="h3" variant="headingSm">
                        Per-language names
                      </Text>
                      {locales.map(({ locale, name }) => (
                        <TextField
                          key={locale}
                          label={`${name} (${locale})`}
                          value={names[locale] ?? ""}
                          onChange={(value) =>
                            setNames((prev) => ({ ...prev, [locale]: value }))
                          }
                          autoComplete="off"
                          disabled={loading || saving}
                          placeholder={fallbackName}
                          maxLength={255}
                        />
                      ))}
                    </>
                  ) : (
                    <Text as="p" variant="bodySm" tone="subdued">
                      The shop has no extra published languages, so only the
                      base name applies. Add languages in Shopify Settings →
                      Languages to unlock per-language names.
                    </Text>
                  )}
                  {locales.length > 0 && !baseName.trim() ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Note: per-language names need a base name — enter one
                      above (the product title is a good default) so the
                      translations have a source value to attach to.
                    </Text>
                  ) : null}
                </BlockStack>
              </Card>
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
