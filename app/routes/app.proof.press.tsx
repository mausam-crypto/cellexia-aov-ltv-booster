import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  MaxPartSizeExceededError,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useSearchParams,
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
  Collapsible,
  Divider,
  InlineStack,
  Pagination,
  Text,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getSettings,
  saveSettings,
  type BoosterSettings,
  type DeepPartial,
} from "../models/settings.server";
import { syncSettingsToMetafields } from "../services/metafields.server";
import { listMarkets } from "../services/markets.server";
import { stagedImageUpload } from "../services/metaobjects.server";
import { listProductsWithBoosterStatus } from "../services/pdp-content.server";
import {
  deleteProofItem,
  listPressItems,
  reorderProofItem,
  savePressItem,
  setProofStatus,
  toggleProofFeatured,
  type PressItemInput,
} from "../services/proof.server";
import {
  getProofSourceText,
  translatableProofTargets,
  listProofTranslationsForMany,
  proofTranslationStatusFor,
  saveManualProofTranslation,
  translateProofEntries,
} from "../services/proof-translation.server";
import { getTargetLocales, getTranslationConfig } from "../services/translation.server";
import type { PressItem } from "@prisma/client";
import {
  parseProductGidList,
  EMPTY_PRESS_FORM,
  PROOF_MAX_UPLOAD_BYTES,
  FeaturedStarButton,
  MoveButtons,
  PressItemForm,
  ProofTranslationsSection,
  TwoClickDeleteButton,
  type PressFormValues,
  type ProofProductHit,
} from "../components/ProofForms";

/**
 * Press tab of the proof library (docs/SPEC-v8-proof-library.md §5):
 * moderation table + add/edit forms for PressItem rows, plus the market
 * scope card for the `press` feature key. Image uploads reuse the
 * stagedImageUpload multipart intent pattern from app.products.$id.tsx —
 * the resolved Shopify Files CDN URL is what gets stored.
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

const PAGE_STATUSES = ["approved", "hidden"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") ?? "";
  const status = (PAGE_STATUSES as readonly string[]).includes(statusParam)
    ? statusParam
    : undefined;
  const pageParam = url.searchParams.get("page") ?? "";
  const page = /^\d+$/.test(pageParam) ? Number(pageParam) : 1;

  const [list, settings, markets, locales, translationConfig] =
    await Promise.all([
      listPressItems(session.shop, { status, page }),
      getSettings(session.shop),
      listMarkets(admin),
      getTargetLocales(admin),
      getTranslationConfig(session.shop),
    ]);
  const targetLocales = translatableProofTargets(
    locales.primary,
    locales.targets,
  );
  const localesUnavailable = (locales.errors?.length ?? 0) > 0;
  const [translationStatus, itemTranslations] = await Promise.all([
    proofTranslationStatusFor(session.shop, "press", targetLocales),
    listProofTranslationsForMany(
      session.shop,
      "press",
      list.items.map((item) => item.id),
    ),
  ]);
  return {
    list,
    markets,
    scope: settings.marketScopes.press ?? { mode: "all" as const, markets: [] },
    featureEnabled: settings.press.enabled,
    targetLocales,
    translationStatus,
    itemTranslations: Object.fromEntries(itemTranslations),
    localesUnavailable,
    hasDeeplKey: translationConfig.apiKey !== "",
    autoTranslate: translationConfig.autoOnSave,
  };
};

interface FileResultPayload {
  ok: boolean;
  fileGid: string | null;
  url: string | null;
  previewUrl: string | null;
  errors: string[];
}

type PressActionResult =
  | ({ intent: "upload_image" } & FileResultPayload)
  | {
      intent: "search_products";
      ok: boolean;
      errors: string[];
      products: ProofProductHit[];
    }
  | { intent: "save_item"; ok: boolean; errors: string[]; id: string | null }
  | { intent: "delete_item"; ok: boolean; errors: string[] }
  | { intent: "toggle_featured"; ok: boolean; errors: string[] }
  | { intent: "set_status"; ok: boolean; errors: string[] }
  | { intent: "move"; ok: boolean; errors: string[] }
  | { intent: "save_settings"; ok: boolean; errors: string[] }
  | { intent: "translate_proof"; ok: boolean; errors: string[]; translated: number }
  | { intent: "save_translation"; ok: boolean; errors: string[] }
  | { intent: "unknown"; ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<PressActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // Multipart branch (image uploads) — decided BEFORE any body parsing.
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await unstable_parseMultipartFormData(
        request,
        unstable_createMemoryUploadHandler({
          maxPartSize: PROOF_MAX_UPLOAD_BYTES,
        }),
      );
    } catch (error) {
      return {
        intent: "upload_image",
        ok: false,
        fileGid: null,
        url: null,
        previewUrl: null,
        errors: [
          error instanceof MaxPartSizeExceededError
            ? "The file is larger than 10 MB"
            : error instanceof Error
              ? error.message
              : "Could not read the uploaded file",
        ],
      };
    }
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return {
        intent: "upload_image",
        ok: false,
        fileGid: null,
        url: null,
        previewUrl: null,
        errors: ["No file was uploaded"],
      };
    }
    if (!(file.type || "").toLowerCase().startsWith("image/")) {
      return {
        intent: "upload_image",
        ok: false,
        fileGid: null,
        url: null,
        previewUrl: null,
        errors: ["Only images can be uploaded here"],
      };
    }
    const upload = await stagedImageUpload(admin, {
      filename: file.name || "upload",
      mimeType: file.type,
      buffer: new Uint8Array(await file.arrayBuffer()),
    });
    return {
      intent: "upload_image",
      ok: upload.ok,
      fileGid: upload.fileGid,
      url: upload.url,
      previewUrl: upload.previewUrl,
      errors: upload.errors,
    };
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const id = String(formData.get("id") ?? "");

  switch (intent) {
    case "search_products": {
      const result = await listProductsWithBoosterStatus(
        admin,
        String(formData.get("q") ?? ""),
      );
      return {
        intent: "search_products",
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
    case "translate_proof": {
      // optional id → the auto-on-save fast path (just the saved entry)
      const onlyId = String(formData.get("id") ?? "");
      const result = await translateProofEntries(
        session.shop,
        admin,
        ["press"],
        onlyId ? [onlyId] : undefined,
      );
      return {
        intent: "translate_proof",
        ok: result.ok && result.failures.length === 0,
        errors: [
          ...(result.reason ? [result.reason] : []),
          ...result.failures.map((f) => `${f.locale}: ${f.error}`),
        ],
        translated: result.translated,
      };
    }
    case "save_translation": {
      const id = String(formData.get("id") ?? "");
      const locale = String(formData.get("locale") ?? "");
      const field = String(formData.get("field") ?? "");
      const value = String(formData.get("value") ?? "");
      // source text read server-side — never trusted from the client
      const source = await getProofSourceText(session.shop, "press", id, field);
      if (source === null) {
        return { intent: "save_translation", ok: false, errors: ["Entry not found"] };
      }
      const saved = await saveManualProofTranslation(
        session.shop, "press", id, locale, field, value, source,
      );
      return {
        intent: "save_translation",
        ok: saved.ok,
        errors: saved.error ? [saved.error] : [],
      };
    }
    case "save_item": {
      let payload: unknown;
      try {
        payload = JSON.parse(String(formData.get("payload") ?? ""));
      } catch {
        payload = undefined;
      }
      if (!isRecord(payload)) {
        return {
          intent: "save_item",
          ok: false,
          errors: ["Invalid payload"],
          id: null,
        };
      }
      const input: PressItemInput = {
        publication: String(payload.publication ?? ""),
        logoUrl: String(payload.logoUrl ?? ""),
        quote: String(payload.quote ?? ""),
        articleUrl: String(payload.articleUrl ?? ""),
        productGids: Array.isArray(payload.productGids)
          ? payload.productGids.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [],
        marketHandles: Array.isArray(payload.marketHandles)
          ? payload.marketHandles.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [],
        featured: payload.featured === true,
        status: String(payload.status ?? "approved"),
      };
      const itemId =
        typeof payload.id === "string" && payload.id !== "" ? payload.id : null;
      const result = await savePressItem(shop, input, itemId);
      return { intent: "save_item", ...result };
    }
    case "delete_item": {
      const result = await deleteProofItem(shop, "press", id);
      return { intent: "delete_item", ...result };
    }
    case "toggle_featured": {
      const result = await toggleProofFeatured(shop, "press", id);
      return { intent: "toggle_featured", ...result };
    }
    case "set_status": {
      const result = await setProofStatus(
        shop,
        "press",
        id,
        String(formData.get("status") ?? ""),
      );
      return { intent: "set_status", ...result };
    }
    case "move": {
      const direction =
        String(formData.get("direction") ?? "") === "up" ? "up" : "down";
      const result = await reorderProofItem(shop, "press", id, direction);
      return { intent: "move", ...result };
    }
    case "save_settings": {
      const result = await applySettingsPatch(
        shop,
        admin,
        formData.get("patch"),
      );
      return {
        intent: "save_settings",
        ok: result.ok,
        errors: result.syncErrors,
      };
    }
    default:
      return { intent: "unknown", ok: false, errors: ["Unknown action"] };
  }
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Client mirror of proof.server's parseMarketHandles (defensive parse). */
function parseMarketHandleList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function itemToForm(item: PressItem): PressFormValues {
  return {
    publication: item.publication,
    logoUrl: item.logoUrl ?? "",
    quote: item.quote,
    articleUrl: item.articleUrl ?? "",
    productGids: parseProductGidList(item.productGids),
    marketHandles: parseMarketHandleList(item.marketHandles),
    featured: item.featured,
    status: item.status,
  };
}

function formToPayload(values: PressFormValues, id: string | null) {
  return JSON.stringify({
    ...(id ? { id } : {}),
    publication: values.publication.trim(),
    logoUrl: values.logoUrl.trim(),
    quote: values.quote.trim(),
    articleUrl: values.articleUrl.trim(),
    productGids: values.productGids,
    marketHandles: values.marketHandles,
    featured: values.featured,
    status: values.status,
  });
}

function excerpt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export default function ProofPressTab() {
  const {
    list,
    markets,
    scope,
    featureEnabled,
    targetLocales,
    translationStatus,
    itemTranslations,
    localesUnavailable,
    hasDeeplKey,
    autoTranslate,
  } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();

  const saveFetcher = useFetcher<PressActionResult>();
  const rowFetcher = useFetcher<PressActionResult>();
  // v8.11b (review catches ADM-1/2/4): translation traffic gets its OWN
  // fetchers — a long DeepL run must never disable moderation buttons, a
  // manual translation save must never cancel (or be cancelled by) a
  // translate run, and the translate button must reflect ITS OWN flight.
  const translateFetcher = useFetcher<typeof action>();
  const manualFetcher = useFetcher<typeof action>();
  const translating = translateFetcher.state !== "idle";
  const manualSaving = manualFetcher.state !== "idle";
  const scopeFetcher = useFetcher<PressActionResult>();

  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [scopeState, setScopeState] = useState<ScopeState>(() =>
    toScopeState(scope),
  );

  useEffect(() => {
    setScopeState(toScopeState(scope));
  }, [scope]);

  const saving = saveFetcher.state !== "idle";
  const moderating = rowFetcher.state !== "idle";

  useEffect(() => {
    const data = saveFetcher.data;
    if (!data || data.intent !== "save_item") return;
    if (data.ok) {
      shopify.toast.show("Saved");
      setAddOpen(false);
      setEditingId(null);
      // v8.11 auto-translation: fire-and-forget for JUST the saved entry
      // (the boosters' fire-after-save convention — the save stays fast,
      // the translation lands in the background and revalidates the list).
      if (autoTranslate && hasDeeplKey && data.id) {
        const formData = new FormData();
        formData.set("intent", "translate_proof");
        formData.set("id", data.id);
        translateFetcher.submit(formData, { method: "post" });
      }
    } else {
      shopify.toast.show(data.errors[0] ?? "Could not save", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveFetcher.data]);

  useEffect(() => {
    const data = translateFetcher.data;
    if (!data || data.intent !== "translate_proof") return;
    if (data.ok) {
      shopify.toast.show(
        data.translated > 0
          ? `Translated ${data.translated} field${data.translated === 1 ? "" : "s"}`
          : "Everything is already translated",
      );
    } else {
      shopify.toast.show(data.errors[0] ?? "Translation failed", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translateFetcher.data]);

  useEffect(() => {
    const data = manualFetcher.data;
    if (!data || data.intent !== "save_translation") return;
    shopify.toast.show(
      data.ok ? "Translation saved" : (data.errors[0] ?? "Could not save translation"),
      data.ok ? undefined : { isError: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualFetcher.data]);

  useEffect(() => {
    const data = rowFetcher.data;
    if (!data || data.ok) return;
    shopify.toast.show(data.errors[0] ?? "Action failed", { isError: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowFetcher.data]);

  useEffect(() => {
    const data = scopeFetcher.data;
    if (!data || data.intent !== "save_settings") return;
    if (!data.ok) {
      shopify.toast.show("Could not save settings", { isError: true });
    } else if (data.errors.length > 0) {
      shopify.toast.show("Saved, but the storefront sync failed", {
        isError: true,
      });
    } else {
      shopify.toast.show("Saved");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeFetcher.data]);

  const submitSave = (values: PressFormValues, id: string | null) => {
    const formData = new FormData();
    formData.set("intent", "save_item");
    formData.set("payload", formToPayload(values, id));
    saveFetcher.submit(formData, { method: "post" });
  };

  const submitFeatureEnabled = (enabled: boolean) => {
    const formData = new FormData();
    formData.set("intent", "save_settings");
    formData.set("patch", JSON.stringify({ press: { enabled } }));
    rowFetcher.submit(formData, { method: "post" });
  };

  const submitTranslateAll = () => {
    const formData = new FormData();
    formData.set("intent", "translate_proof");
    translateFetcher.submit(formData, { method: "post" });
  };

  const submitTranslation = (
    id: string,
    locale: string,
    field: string,
    value: string,
  ) => {
    const formData = new FormData();
    formData.set("intent", "save_translation");
    formData.set("id", id);
    formData.set("locale", locale);
    formData.set("field", field);
    formData.set("value", value);
    manualFetcher.submit(formData, { method: "post" });
  };

  const submitRow = (fields: Record<string, string>) => {
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      formData.set(key, value);
    }
    rowFetcher.submit(formData, { method: "post" });
  };

  const statusFilter = searchParams.get("status") ?? "";
  const setStatusFilter = (status: string) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (status === "") next.delete("status");
        else next.set("status", status);
        next.delete("page");
        return next;
      },
      { preventScrollReset: true },
    );
  };
  const setPage = (page: number) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (page <= 1) next.delete("page");
        else next.set("page", String(page));
        return next;
      },
      { preventScrollReset: true },
    );
  };
  const totalPages = Math.max(Math.ceil(list.total / list.per), 1);

  const scopeDirty = useMemo(
    () =>
      JSON.stringify(toScopePatch(scopeState)) !==
      JSON.stringify(toScopePatch(toScopeState(scope))),
    [scopeState, scope],
  );
  const saveScope = () => {
    const patch: DeepPartial<BoosterSettings> = {
      marketScopes: { press: toScopePatch(scopeState) },
    };
    const formData = new FormData();
    formData.set("intent", "save_settings");
    formData.set("patch", JSON.stringify(patch));
    scopeFetcher.submit(formData, { method: "post" });
  };

  return (
    <BlockStack gap="400">
      {!list.ok ? (
        <Banner tone="critical" title="Press entries could not be loaded">
          <BlockStack gap="100">
            {list.errors.map((error) => (
              <Text as="p" key={error}>
                {error}
              </Text>
            ))}
          </BlockStack>
        </Banner>
      ) : null}

      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <BlockStack gap="100">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Press quotes
                </Text>
                <Badge tone={featureEnabled ? "success" : undefined}>
                  {featureEnabled ? "Active" : "Off"}
                </Badge>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Publication logo + large quote for the “As seen in the press”
                band. Entries without tagged products are brand-level and show
                wherever the proof band renders (product pages and the home
                page).
              </Text>
            </BlockStack>
            <InlineStack gap="200" blockAlign="center">
              <Button
                onClick={() => submitFeatureEnabled(!featureEnabled)}
                loading={moderating && rowFetcher.formData?.get("intent") === "save_settings"}
                variant={featureEnabled ? "secondary" : "primary"}
              >
                {featureEnabled ? "Disable" : "Enable"}
              </Button>
              <Button
                onClick={submitTranslateAll}
                disabled={!hasDeeplKey || translating || targetLocales.length === 0}
                loading={translating}
              >
                Translate into all languages
              </Button>
              <Button
                variant="primary"
                onClick={() => setAddOpen((previous) => !previous)}
                disclosure={addOpen ? "up" : "down"}
              >
                Add press quote
              </Button>
            </InlineStack>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {localesUnavailable
              ? "Could not load the shop's languages — translation status is unavailable right now (re-open the page to retry)."
              : targetLocales.length === 0
                ? "Your shop has one published language — nothing to translate."
                : hasDeeplKey
                  ? `Quotes auto-translate into ${translationStatus.targetLocales} languages${autoTranslate ? " on save" : ""} — ${translationStatus.fresh} of ${translationStatus.expected} fields translated${translationStatus.outdated > 0 ? `, ${translationStatus.outdated} outdated` : ""}. Review per entry under “Translations”.`
                  : "Add a DeepL key on the Languages page to auto-translate quotes into every published language."}
          </Text>

          <Collapsible id="cx-press-add" open={addOpen}>
            <Box
              padding="300"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              {addOpen ? (
                <PressItemForm
                  initial={EMPTY_PRESS_FORM}
                  busy={saving}
                  submitLabel="Add press quote"
                  markets={markets}
                  onSubmit={(values) => submitSave(values, null)}
                  onCancel={() => setAddOpen(false)}
                />
              ) : null}
            </Box>
          </Collapsible>

          <InlineStack gap="200">
            {[
              { label: "All", value: "" },
              { label: "Approved", value: "approved" },
              { label: "Hidden", value: "hidden" },
            ].map((chip) => (
              <Button
                key={chip.value}
                size="slim"
                pressed={statusFilter === chip.value}
                onClick={() => setStatusFilter(chip.value)}
              >
                {chip.label}
              </Button>
            ))}
          </InlineStack>

          {list.items.length === 0 ? (
            <Text as="p" tone="subdued">
              No press quotes yet — add the first one above.
            </Text>
          ) : (
            <BlockStack gap="300">
              {list.items.map((item, index) => {
                const tagged = parseProductGidList(item.productGids);
                return (
                  <BlockStack gap="300" key={item.id}>
                    <Divider />
                    <InlineStack
                      gap="300"
                      align="space-between"
                      blockAlign="center"
                      wrap
                    >
                      <InlineStack gap="300" blockAlign="center" wrap={false}>
                        <Thumbnail
                          source={item.logoUrl ?? ImageIcon}
                          alt={item.publication}
                          size="small"
                        />
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center" wrap>
                            <Text
                              as="span"
                              variant="bodyMd"
                              fontWeight="semibold"
                            >
                              {item.publication}
                            </Text>
                            <Badge
                              tone={
                                item.status === "approved"
                                  ? "success"
                                  : undefined
                              }
                            >
                              {item.status === "approved"
                                ? "Approved"
                                : "Hidden"}
                            </Badge>
                            {tagged.length > 0 ? (
                              <Badge tone="info">
                                {tagged.length === 1
                                  ? "1 product"
                                  : `${tagged.length} products`}
                              </Badge>
                            ) : (
                              <Badge>Brand-level</Badge>
                            )}
                          </InlineStack>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {excerpt(item.quote, 120)}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                      <InlineStack gap="200" blockAlign="center">
                        <FeaturedStarButton
                          featured={item.featured}
                          disabled={moderating}
                          onToggle={() =>
                            submitRow({ intent: "toggle_featured", id: item.id })
                          }
                        />
                        <MoveButtons
                          disabled={moderating}
                          isFirst={list.page === 1 && index === 0}
                          isLast={
                            index === list.items.length - 1 &&
                            list.page * list.per >= list.total
                          }
                          onMove={(direction) =>
                            submitRow({ intent: "move", id: item.id, direction })
                          }
                        />
                        <Button
                          size="slim"
                          onClick={() =>
                            setEditingId((previous) =>
                              previous === item.id ? null : item.id,
                            )
                          }
                          disclosure={editingId === item.id ? "up" : "down"}
                        >
                          Edit
                        </Button>
                        <TwoClickDeleteButton
                          disabled={moderating}
                          onConfirmedDelete={() =>
                            submitRow({ intent: "delete_item", id: item.id })
                          }
                        />
                      </InlineStack>
                    </InlineStack>
                    <Collapsible
                      id={`cx-press-edit-${item.id}`}
                      open={editingId === item.id}
                    >
                      <Box
                        padding="300"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        {editingId === item.id ? (
                          <PressItemForm
                            // Remount on background revalidation so a moderated
                            // row (Approve/star) never silently reverts on save.
                            key={`${item.id}:${item.updatedAt}`}
                            initial={itemToForm(item)}
                            busy={saving}
                            submitLabel="Save changes"
                            markets={markets}
                            onSubmit={(values) => submitSave(values, item.id)}
                            onCancel={() => setEditingId(null)}
                          />
                        ) : null}
                        {editingId === item.id ? (
                          <Box paddingBlockStart="300">
                            <ProofTranslationsSection
                              fields={[
                                { field: "quote", label: "Quote", sourceText: item.quote },
                              ]}
                              targetLocales={targetLocales}
                              translations={itemTranslations[item.id] ?? []}
                              onSave={(locale, field, value) =>
                                submitTranslation(item.id, locale, field, value)
                              }
                              saving={manualSaving}
                            />
                          </Box>
                        ) : null}
                      </Box>
                    </Collapsible>
                  </BlockStack>
                );
              })}
            </BlockStack>
          )}

          {totalPages > 1 ? (
            <InlineStack align="center">
              <Pagination
                hasPrevious={list.page > 1}
                hasNext={list.page < totalPages}
                onPrevious={() => setPage(list.page - 1)}
                onNext={() => setPage(list.page + 1)}
                label={`Page ${list.page} of ${totalPages}`}
              />
            </InlineStack>
          ) : null}
        </BlockStack>
      </Card>

      <MarketScopeCard
        title="Markets — press band"
        markets={markets}
        scope={scopeState}
        onChange={setScopeState}
      />
      <InlineStack gap="200">
        <Button
          variant="primary"
          onClick={saveScope}
          disabled={!scopeDirty || scopeFetcher.state !== "idle"}
          loading={scopeFetcher.state !== "idle"}
        >
          Save market targeting
        </Button>
      </InlineStack>
    </BlockStack>
  );
}
