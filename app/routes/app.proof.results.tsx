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
  bulkApprovePendingResults,
  deleteProofItem,
  importLegacyBeforeAfters,
  listResults,
  reorderProofItem,
  saveResult,
  setProofStatus,
  toggleProofFeatured,
  type ResultInput,
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
import type { CustomerResult } from "@prisma/client";
import {
  parseProductGidList,
  EMPTY_RESULT_FORM,
  PROOF_MAX_UPLOAD_BYTES,
  FeaturedStarButton,
  MoveButtons,
  ResultForm,
  ProofTranslationsSection,
  TwoClickDeleteButton,
  type ProofProductHit,
  type ResultFormValues,
} from "../components/ProofForms";

/**
 * Results tab of the proof library (docs/SPEC-v8-proof-library.md §5): the
 * before/after results gallery moderation surface — pending/approved filter
 * chips (customer submissions arrive pending), facet fields, verified flag,
 * lab|customer source, video URL, and the one-click legacy import that moves
 * the v3 PDP before/after metaobjects into this library exactly once
 * (legacyGid unique). Market scope card patches
 * marketScopes.verified_before_after (the gallery reuses the existing key).
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

const PAGE_STATUSES = ["pending", "approved", "hidden"] as const;

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
      listResults(session.shop, { status, page }),
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
    proofTranslationStatusFor(session.shop, "results", targetLocales),
    listProofTranslationsForMany(
      session.shop,
      "results",
      list.items.map((item) => item.id),
    ),
  ]);
  return {
    list,
    markets,
    scope:
      settings.marketScopes.verified_before_after ?? {
        mode: "all" as const,
        markets: [],
      },
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

type ResultsActionResult =
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
  | {
      intent: "import_legacy";
      ok: boolean;
      errors: string[];
      imported: number;
      skipped: number;
    }
  | { intent: "bulk_approve"; ok: boolean; errors: string[]; approved: number }
  | { intent: "unknown"; ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ResultsActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // Multipart branch (before/after uploads) — decided BEFORE any body parsing.
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
        ["results"],
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
      const source = await getProofSourceText(session.shop, "results", id, field);
      if (source === null) {
        return { intent: "save_translation", ok: false, errors: ["Entry not found"] };
      }
      const saved = await saveManualProofTranslation(
        session.shop, "results", id, locale, field, value, source,
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
      const rawDuration = payload.durationWeeks;
      const input: ResultInput = {
        source: String(payload.source ?? "customer"),
        verified: payload.verified === true,
        beforeUrl: String(payload.beforeUrl ?? ""),
        afterUrl: String(payload.afterUrl ?? ""),
        ageRange: String(payload.ageRange ?? ""),
        skinType: String(payload.skinType ?? ""),
        concern: String(payload.concern ?? ""),
        durationWeeks:
          typeof rawDuration === "number" && Number.isFinite(rawDuration)
            ? rawDuration
            : null,
        country: String(payload.country ?? ""),
        testimonial: String(payload.testimonial ?? ""),
        videoUrl: String(payload.videoUrl ?? ""),
        productGids: Array.isArray(payload.productGids)
          ? payload.productGids.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [],
        featured: payload.featured === true,
        status: String(payload.status ?? "pending"),
      };
      const itemId =
        typeof payload.id === "string" && payload.id !== "" ? payload.id : null;
      const result = await saveResult(shop, input, itemId);
      return { intent: "save_item", ...result };
    }
    case "delete_item": {
      const result = await deleteProofItem(shop, "results", id);
      return { intent: "delete_item", ...result };
    }
    case "toggle_featured": {
      const result = await toggleProofFeatured(shop, "results", id);
      return { intent: "toggle_featured", ...result };
    }
    case "set_status": {
      const result = await setProofStatus(
        shop,
        "results",
        id,
        String(formData.get("status") ?? ""),
      );
      return { intent: "set_status", ...result };
    }
    case "move": {
      const direction =
        String(formData.get("direction") ?? "") === "up" ? "up" : "down";
      const result = await reorderProofItem(shop, "results", id, direction);
      return { intent: "move", ...result };
    }
    case "import_legacy": {
      const result = await importLegacyBeforeAfters(admin, shop);
      return {
        intent: "import_legacy",
        ok: result.ok,
        errors: result.errors,
        imported: result.imported,
        skipped: result.skipped,
      };
    }
    case "bulk_approve": {
      const result = await bulkApprovePendingResults(shop);
      return {
        intent: "bulk_approve",
        ok: result.ok,
        errors: result.errors,
        approved: result.approved,
      };
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

function itemToForm(item: CustomerResult): ResultFormValues {
  return {
    source: item.source,
    verified: item.verified,
    beforeUrl: item.beforeUrl ?? "",
    afterUrl: item.afterUrl ?? "",
    ageRange: item.ageRange ?? "",
    skinType: item.skinType ?? "",
    concern: item.concern ?? "",
    durationWeeks:
      item.durationWeeks === null ? "" : String(item.durationWeeks),
    country: item.country ?? "",
    testimonial: item.testimonial ?? "",
    videoUrl: item.videoUrl ?? "",
    productGids: parseProductGidList(item.productGids),
    featured: item.featured,
    status: item.status,
  };
}

function formToPayload(values: ResultFormValues, id: string | null) {
  const duration = values.durationWeeks.trim();
  return JSON.stringify({
    ...(id ? { id } : {}),
    source: values.source,
    verified: values.verified,
    beforeUrl: values.beforeUrl.trim(),
    afterUrl: values.afterUrl.trim(),
    ageRange: values.ageRange,
    skinType: values.skinType,
    concern: values.concern.trim(),
    durationWeeks: /^\d+$/.test(duration) ? Number(duration) : null,
    country: values.country.trim(),
    testimonial: values.testimonial.trim(),
    videoUrl: values.videoUrl.trim(),
    productGids: values.productGids,
    featured: values.featured,
    status: values.status,
  });
}

function excerpt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function metaLine(item: CustomerResult): string {
  const parts: string[] = [];
  if (item.ageRange) parts.push(item.ageRange);
  if (item.skinType) parts.push(item.skinType);
  if (item.concern) parts.push(item.concern);
  if (item.durationWeeks !== null) parts.push(`${item.durationWeeks} wks`);
  if (item.country) parts.push(item.country);
  return parts.join(" · ");
}

export default function ProofResultsTab() {
  const {
    list,
    markets,
    scope,
    targetLocales,
    translationStatus,
    itemTranslations,
    localesUnavailable,
    hasDeeplKey,
    autoTranslate,
  } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();

  const saveFetcher = useFetcher<ResultsActionResult>();
  const rowFetcher = useFetcher<ResultsActionResult>();
  // v8.11b (review catches ADM-1/2/4): translation traffic gets its OWN
  // fetchers — a long DeepL run must never disable moderation buttons, a
  // manual translation save must never cancel (or be cancelled by) a
  // translate run, and the translate button must reflect ITS OWN flight.
  const translateFetcher = useFetcher<typeof action>();
  const manualFetcher = useFetcher<typeof action>();
  const translating = translateFetcher.state !== "idle";
  const manualSaving = manualFetcher.state !== "idle";
  const scopeFetcher = useFetcher<ResultsActionResult>();
  const importFetcher = useFetcher<ResultsActionResult>();

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
  const importing = importFetcher.state !== "idle";

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
    if (!data) return;
    if (!data.ok) {
      shopify.toast.show(data.errors[0] ?? "Action failed", { isError: true });
    } else if (data.intent === "bulk_approve") {
      shopify.toast.show(
        data.approved === 1
          ? "1 result approved"
          : `${data.approved} results approved`,
      );
    }
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

  const submitSave = (values: ResultFormValues, id: string | null) => {
    const formData = new FormData();
    formData.set("intent", "save_item");
    formData.set("payload", formToPayload(values, id));
    saveFetcher.submit(formData, { method: "post" });
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

  const runImport = () => {
    const formData = new FormData();
    formData.set("intent", "import_legacy");
    importFetcher.submit(formData, { method: "post" });
  };
  const importResult =
    importFetcher.data && importFetcher.data.intent === "import_legacy"
      ? importFetcher.data
      : null;

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
      marketScopes: { verified_before_after: toScopePatch(scopeState) },
    };
    const formData = new FormData();
    formData.set("intent", "save_settings");
    formData.set("patch", JSON.stringify(patch));
    scopeFetcher.submit(formData, { method: "post" });
  };

  return (
    <BlockStack gap="400">
      {!list.ok ? (
        <Banner tone="critical" title="Results could not be loaded">
          <BlockStack gap="100">
            {list.errors.map((error) => (
              <Text as="p" key={error}>
                {error}
              </Text>
            ))}
          </BlockStack>
        </Banner>
      ) : null}

      {importResult ? (
        <Banner
          tone={importResult.ok ? "success" : "warning"}
          title={
            importResult.ok
              ? `Legacy import finished — ${importResult.imported} imported, ${importResult.skipped} already imported`
              : `Legacy import finished with errors — ${importResult.imported} imported, ${importResult.skipped} already imported`
          }
        >
          <BlockStack gap="100">
            {importResult.errors.map((error) => (
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
              <Text as="h2" variant="headingMd">
                Results gallery
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Before/after results at any scale — lab data and customer
                submissions. Only approved entries reach the storefront;
                “Verified purchase” entries feed the honest scale banner.
              </Text>
            </BlockStack>
            <InlineStack gap="200">
              <Button
                onClick={() => submitRow({ intent: "bulk_approve" })}
                disabled={moderating}
              >
                Approve all pending
              </Button>
              <Button
                onClick={runImport}
                loading={importing}
                disabled={importing}
              >
                Import legacy before/afters
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
                Add result
              </Button>
            </InlineStack>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {localesUnavailable
              ? "Could not load the shop's languages — translation status is unavailable right now (re-open the page to retry)."
              : targetLocales.length === 0
                ? "Your shop has one published language — nothing to translate."
                : hasDeeplKey
                  ? `Testimonials auto-translate into ${translationStatus.targetLocales} languages${autoTranslate ? " on save" : ""} — ${translationStatus.fresh} of ${translationStatus.expected} fields translated${translationStatus.outdated > 0 ? `, ${translationStatus.outdated} outdated` : ""}. Review per entry under “Translations”.`
                  : "Add a DeepL key on the Languages page to auto-translate testimonials into every published language."}
          </Text>

          <Collapsible id="cx-results-add" open={addOpen}>
            <Box
              padding="300"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              {addOpen ? (
                <ResultForm
                  initial={EMPTY_RESULT_FORM}
                  busy={saving}
                  submitLabel="Add result"
                  onSubmit={(values) => submitSave(values, null)}
                  onCancel={() => setAddOpen(false)}
                />
              ) : null}
            </Box>
          </Collapsible>

          <InlineStack gap="200">
            {[
              { label: "All", value: "" },
              { label: "Pending", value: "pending" },
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
              {statusFilter === ""
                ? "No results yet — add one above or import the legacy before/after entries."
                : "No results with this status."}
            </Text>
          ) : (
            <BlockStack gap="300">
              {list.items.map((item, index) => {
                const tagged = parseProductGidList(item.productGids);
                const meta = metaLine(item);
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
                        <InlineStack gap="100" wrap={false}>
                          <Thumbnail
                            source={item.beforeUrl ?? ImageIcon}
                            alt="Before"
                            size="small"
                          />
                          <Thumbnail
                            source={item.afterUrl ?? ImageIcon}
                            alt="After"
                            size="small"
                          />
                        </InlineStack>
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center" wrap>
                            <Badge
                              tone={
                                item.status === "approved"
                                  ? "success"
                                  : item.status === "pending"
                                    ? "attention"
                                    : undefined
                              }
                            >
                              {item.status === "approved"
                                ? "Approved"
                                : item.status === "pending"
                                  ? "Pending"
                                  : "Hidden"}
                            </Badge>
                            <Badge tone={item.source === "lab" ? "info" : undefined}>
                              {item.source === "lab" ? "Lab" : "Customer"}
                            </Badge>
                            {item.verified ? (
                              <Badge tone="success">Verified</Badge>
                            ) : null}
                            {item.videoUrl ? <Badge>Video</Badge> : null}
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
                          {meta !== "" ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              {meta}
                            </Text>
                          ) : null}
                          {item.testimonial ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              {excerpt(item.testimonial, 110)}
                            </Text>
                          ) : null}
                        </BlockStack>
                      </InlineStack>
                      <InlineStack gap="200" blockAlign="center">
                        {item.status === "pending" ? (
                          <Button
                            size="slim"
                            variant="primary"
                            onClick={() =>
                              submitRow({
                                intent: "set_status",
                                id: item.id,
                                status: "approved",
                              })
                            }
                            disabled={moderating}
                          >
                            Approve
                          </Button>
                        ) : null}
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
                      id={`cx-results-edit-${item.id}`}
                      open={editingId === item.id}
                    >
                      <Box
                        padding="300"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        {editingId === item.id ? (
                          <ResultForm
                            // Remount on background revalidation so a moderated
                            // row (Approve/star) never silently reverts on save.
                            key={`${item.id}:${item.updatedAt}`}
                            initial={itemToForm(item)}
                            busy={saving}
                            submitLabel="Save changes"
                            onSubmit={(values) => submitSave(values, item.id)}
                            onCancel={() => setEditingId(null)}
                          />
                        ) : null}
                        {editingId === item.id ? (
                          <Box paddingBlockStart="300">
                            <ProofTranslationsSection
                              fields={[
                                { field: "testimonial", label: "Testimonial", sourceText: item.testimonial ?? "" },
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
        title="Markets — results gallery"
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
