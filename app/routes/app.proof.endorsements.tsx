import { useEffect, useMemo, useRef, useState } from "react";
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
  Select,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { PersonIcon } from "@shopify/polaris-icons";
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
  listEndorsements,
  reorderProofItem,
  saveEndorsement,
  setProofStatus,
  toggleProofFeatured,
  type EndorsementInput,
} from "../services/proof.server";
import {
  COPY_RESOURCE_ID,
  deleteCopyTranslationsForFields,
  getProofSourceText,
  translatableProofTargets,
  listProofTranslationsForMany,
  proofTranslationStatusFor,
  saveManualProofTranslation,
  translateProofEntries,
} from "../services/proof-translation.server";
import { getTargetLocales, getTranslationConfig } from "../services/translation.server";
import type { DermEndorsement } from "@prisma/client";
import {
  parseProductGidList,
  EMPTY_ENDORSEMENT_FORM,
  PROOF_MAX_UPLOAD_BYTES,
  EndorsementForm,
  ProofTranslationsSection,
  FeaturedStarButton,
  MoveButtons,
  TwoClickDeleteButton,
  type EndorsementFormValues,
  type ProofProductHit,
} from "../components/ProofForms";

/**
 * Endorsements tab of the proof library (docs/SPEC-v8-proof-library.md §5):
 * moderation table + add/edit forms for DermEndorsement rows — built for
 * DOZENS/HUNDREDS of entries (paginated table, search-free quick filters) —
 * plus the market scope card for the `derm_endorsements` feature key.
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
  // v8.19b: a save that BLANKED copy fields must also drop their stored
  // translations — dead rows would otherwise keep serving the old text on
  // localized storefronts (invisible to the admin reviewer, which hides
  // blank-source fields).
  const patchedEndo = patch.dermEndorsements;
  if (patchedEndo && typeof patchedEndo === "object") {
    const blanked = Object.keys(patchedEndo).filter(
      (field) =>
        field.startsWith("copy") &&
        !/\S/.test(
          (next.dermEndorsements as unknown as Record<string, string>)[field] ?? "",
        ),
    );
    if (blanked.length > 0) {
      await deleteCopyTranslationsForFields(shop, blanked);
    }
  }
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

// Client-safe literal of COPY_RESOURCE_ID in proof-translation.server.ts
// (never import a .server VALUE into client code — the v8.3 build-break
// lesson). The harness pins the two in sync.
const COPY_ID = "dermEndorsements";

// Client-safe mirror of BADGE_STYLES in settings.server.ts (never import a
// .server VALUE into client code — the v8.3 build-break lesson). The
// harness pins the two in sync.
const BADGE_STYLE_OPTIONS = [
  { label: "Classic — shield, portraits and link", value: "classic" },
  {
    label: "Dermatologists' Choice — laurel title, credential chip",
    value: "choice",
  },
  { label: "Slim bar — one line with a +N counter", value: "slim" },
  {
    label: "Choice compact — title and chip, two tight rows",
    value: "choice_compact",
  },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") ?? "";
  const status = (PAGE_STATUSES as readonly string[]).includes(statusParam)
    ? statusParam
    : undefined;
  const pageParam = url.searchParams.get("page") ?? "";
  const page = /^\d+$/.test(pageParam) ? Number(pageParam) : 1;
  const q = url.searchParams.get("q") ?? "";

  const [list, settings, markets, locales, translationConfig] =
    await Promise.all([
      listEndorsements(session.shop, { status, page, search: q }),
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
  const [translationStatus, itemTranslations, copyStatus, copyTranslations] =
    await Promise.all([
      proofTranslationStatusFor(session.shop, "endorsements", targetLocales),
      listProofTranslationsForMany(
        session.shop,
        "endorsements",
        list.items.map((item) => item.id),
      ),
      // v8.19: the merchant copy overrides ride the same DeepL system.
      proofTranslationStatusFor(session.shop, "copy", targetLocales),
      listProofTranslationsForMany(session.shop, "copy", [COPY_RESOURCE_ID]),
    ]);
  return {
    list,
    q,
    markets,
    scope:
      settings.marketScopes.derm_endorsements ?? {
        mode: "all" as const,
        markets: [],
      },
    featureEnabled: settings.dermEndorsements.enabled,
    // v8.17 badge + copy overrides (edited in the Display & copy card).
    display: {
      badgeEnabled: settings.dermEndorsements.badgeEnabled,
      badgeShowLink: settings.dermEndorsements.badgeShowLink,
      badgeStyle: settings.dermEndorsements.badgeStyle,
      copyEyebrow: settings.dermEndorsements.copyEyebrow,
      copyHeadline: settings.dermEndorsements.copyHeadline,
      copyDescription: settings.dermEndorsements.copyDescription,
      copyBadgeHeadline: settings.dermEndorsements.copyBadgeHeadline,
      copyBadgeLink: settings.dermEndorsements.copyBadgeLink,
      copyBadgeNoLink: settings.dermEndorsements.copyBadgeNoLink,
      copyBadgeChip: settings.dermEndorsements.copyBadgeChip,
    },
    targetLocales,
    translationStatus,
    itemTranslations: Object.fromEntries(itemTranslations),
    copyStatus,
    copyTranslations: copyTranslations.get(COPY_RESOURCE_ID) ?? [],
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

type EndorsementActionResult =
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
}: ActionFunctionArgs): Promise<EndorsementActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // Multipart branch (portrait uploads) — decided BEFORE any body parsing.
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
      // optional id → the auto-on-save fast path (just the saved entry;
      // COPY_RESOURCE_ID narrows to the v8.19 copy scope the same way)
      const onlyId = String(formData.get("id") ?? "");
      const result = await translateProofEntries(
        session.shop,
        admin,
        ["endorsements", "copy"],
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
      // v8.19: the copy scope's fixed id routes to the settings-backed
      // sources; everything else stays an endorsement entry.
      const scope = id === COPY_RESOURCE_ID ? ("copy" as const) : ("endorsements" as const);
      // v8.19b (review catch): only real target locales may store rows —
      // a primary-locale row would be served by the proxy but invisible
      // to the admin reviewer (which lists target locales only).
      const shopLocales = await getTargetLocales(admin);
      const validTargets = translatableProofTargets(
        shopLocales.primary,
        shopLocales.targets,
      );
      if (!validTargets.includes(locale.trim().toLowerCase())) {
        return {
          intent: "save_translation",
          ok: false,
          errors: ["Not a published target language of this shop"],
        };
      }
      // source text read server-side — never trusted from the client
      const source = await getProofSourceText(session.shop, scope, id, field);
      if (source === null) {
        return { intent: "save_translation", ok: false, errors: ["Entry not found"] };
      }
      const saved = await saveManualProofTranslation(
        session.shop, scope, id, locale, field, value, source,
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
      const input: EndorsementInput = {
        name: String(payload.name ?? ""),
        credentials: String(payload.credentials ?? ""),
        country: String(payload.country ?? ""),
        quote: String(payload.quote ?? ""),
        imageUrl: String(payload.imageUrl ?? ""),
        productGids: Array.isArray(payload.productGids)
          ? payload.productGids.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [],
        featured: payload.featured === true,
        status: String(payload.status ?? "approved"),
      };
      const itemId =
        typeof payload.id === "string" && payload.id !== "" ? payload.id : null;
      const result = await saveEndorsement(shop, input, itemId);
      return { intent: "save_item", ...result };
    }
    case "delete_item": {
      const result = await deleteProofItem(shop, "endorsements", id);
      return { intent: "delete_item", ...result };
    }
    case "toggle_featured": {
      const result = await toggleProofFeatured(shop, "endorsements", id);
      return { intent: "toggle_featured", ...result };
    }
    case "set_status": {
      const result = await setProofStatus(
        shop,
        "endorsements",
        id,
        String(formData.get("status") ?? ""),
      );
      return { intent: "set_status", ...result };
    }
    case "move": {
      const direction =
        String(formData.get("direction") ?? "") === "up" ? "up" : "down";
      const result = await reorderProofItem(shop, "endorsements", id, direction);
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

function itemToForm(item: DermEndorsement): EndorsementFormValues {
  return {
    name: item.name,
    credentials: item.credentials ?? "",
    country: item.country ?? "",
    quote: item.quote,
    imageUrl: item.imageUrl ?? "",
    productGids: parseProductGidList(item.productGids),
    featured: item.featured,
    status: item.status,
  };
}

function formToPayload(values: EndorsementFormValues, id: string | null) {
  return JSON.stringify({
    ...(id ? { id } : {}),
    name: values.name.trim(),
    credentials: values.credentials.trim(),
    country: values.country.trim(),
    quote: values.quote.trim(),
    imageUrl: values.imageUrl.trim(),
    productGids: values.productGids,
    featured: values.featured,
    status: values.status,
  });
}

function excerpt(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export default function ProofEndorsementsTab() {
  const {
    list,
    markets,
    scope,
    featureEnabled,
    display,
    targetLocales,
    translationStatus,
    itemTranslations,
    copyStatus,
    copyTranslations,
    localesUnavailable,
    hasDeeplKey,
    autoTranslate,
  } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();

  const saveFetcher = useFetcher<EndorsementActionResult>();
  const rowFetcher = useFetcher<EndorsementActionResult>();
  // v8.11b (review catches ADM-1/2/4): translation traffic gets its OWN
  // fetchers — a long DeepL run must never disable moderation buttons, a
  // manual translation save must never cancel (or be cancelled by) a
  // translate run, and the translate button must reflect ITS OWN flight.
  const translateFetcher = useFetcher<typeof action>();
  const manualFetcher = useFetcher<typeof action>();
  const translating = translateFetcher.state !== "idle";
  const manualSaving = manualFetcher.state !== "idle";
  const scopeFetcher = useFetcher<EndorsementActionResult>();

  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [scopeState, setScopeState] = useState<ScopeState>(() =>
    toScopeState(scope),
  );

  useEffect(() => {
    setScopeState(toScopeState(scope));
  }, [scope]);

  // v8.17 badge + copy card. Its OWN fetcher (the v8.11b lesson: sharing
  // rowFetcher would freeze moderation and cross-cancel saves).
  const displayFetcher = useFetcher<EndorsementActionResult>();
  // v8.19b: the copy auto-translate gets its OWN fetcher too — riding
  // translateFetcher would client-abort an in-flight entry/all-languages
  // DeepL run (the same v8.11b lesson one level deeper).
  const copyTranslateFetcher = useFetcher<EndorsementActionResult>();
  const [displayState, setDisplayState] = useState(display);
  // v8.19: did the LAST copy-card save touch translatable text?
  const copyTouchedRef = useRef(false);

  // Resync on VALUE change, not loader-object identity: every fetcher on
  // this page revalidates the loader (moderation, translate, scope saves,
  // the background auto-translate), and an identity-keyed effect would
  // clobber in-flight copy edits each time. Value-keyed, it fires only
  // when the persisted settings actually changed (this card's own save
  // landing its server-side trim/cap/{n} canonicalization included).
  const displayJson = JSON.stringify(display);
  useEffect(() => {
    setDisplayState(JSON.parse(displayJson));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayJson]);

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

  useEffect(() => {
    const data = displayFetcher.data;
    if (!data || data.intent !== "save_settings") return;
    if (!data.ok) {
      shopify.toast.show("Could not save settings", { isError: true });
      return;
    }
    // v8.19 auto-translation: fires on EVERY persisted save that touched
    // copy text — including a save whose metafield sync failed (review
    // catch: the DB text IS what feeds translation; skipping would leave
    // no retrigger since the card is no longer dirty).
    if (copyTouchedRef.current && autoTranslate && hasDeeplKey) {
      const formData = new FormData();
      formData.set("intent", "translate_proof");
      formData.set("id", COPY_ID);
      copyTranslateFetcher.submit(formData, { method: "post" });
    }
    copyTouchedRef.current = false;
    if (data.errors.length > 0) {
      shopify.toast.show("Saved, but the storefront sync failed", {
        isError: true,
      });
    } else {
      shopify.toast.show("Saved");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayFetcher.data]);

  useEffect(() => {
    const data = copyTranslateFetcher.data;
    if (!data || data.intent !== "translate_proof") return;
    if (!data.ok) {
      shopify.toast.show(data.errors[0] ?? "Copy translation failed", {
        isError: true,
      });
    }
    // success is silent — the coverage line and Translations section
    // revalidate on their own; a second "Translated N fields" toast right
    // after "Saved" would just stack noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copyTranslateFetcher.data]);

  const submitSave = (values: EndorsementFormValues, id: string | null) => {
    const formData = new FormData();
    formData.set("intent", "save_item");
    formData.set("payload", formToPayload(values, id));
    saveFetcher.submit(formData, { method: "post" });
  };

  const submitFeatureEnabled = (enabled: boolean) => {
    const formData = new FormData();
    formData.set("intent", "save_settings");
    formData.set("patch", JSON.stringify({ dermEndorsements: { enabled } }));
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
      marketScopes: { derm_endorsements: toScopePatch(scopeState) },
    };
    const formData = new FormData();
    formData.set("intent", "save_settings");
    formData.set("patch", JSON.stringify(patch));
    scopeFetcher.submit(formData, { method: "post" });
  };

  const displayDirty = useMemo(
    () => JSON.stringify(displayState) !== JSON.stringify(display),
    [displayState, display],
  );
  const saveDisplay = () => {
    // Changed-only patch (the v8.6 stale-tab lesson: never rewrite
    // untouched fields on save).
    const section: Record<string, boolean | string> = {};
    for (const key of Object.keys(display) as (keyof typeof display)[]) {
      if (displayState[key] !== display[key]) section[key] = displayState[key];
    }
    if (Object.keys(section).length === 0) return;
    copyTouchedRef.current = Object.keys(section).some((key) =>
      key.startsWith("copy"),
    );
    const formData = new FormData();
    formData.set("intent", "save_settings");
    formData.set("patch", JSON.stringify({ dermEndorsements: section }));
    displayFetcher.submit(formData, { method: "post" });
  };
  const setDisplayField = <K extends keyof typeof display>(
    key: K,
    value: (typeof display)[K],
  ) => setDisplayState((previous) => ({ ...previous, [key]: value }));

  return (
    <BlockStack gap="400">
      {!list.ok ? (
        <Banner tone="critical" title="Endorsements could not be loaded">
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
                  Dermatologist endorsements
                </Text>
                <Badge tone={featureEnabled ? "success" : undefined}>
                  {featureEnabled ? "Active" : "Off"}
                </Badge>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                The endorsement wall is built for dozens or hundreds of
                entries — the storefront headline counts every approved
                endorsement. A portrait is optional (initials show otherwise).
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
                Add endorsement
              </Button>
            </InlineStack>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {localesUnavailable
              ? "Could not load the shop's languages — translation status is unavailable right now (re-open the page to retry)."
              : targetLocales.length === 0
                ? "Your shop has one published language — nothing to translate."
                : hasDeeplKey
                  ? `Quotes, credentials and custom copy auto-translate into ${translationStatus.targetLocales} languages${autoTranslate ? " on save" : ""} — ${translationStatus.fresh + copyStatus.fresh} of ${translationStatus.expected + copyStatus.expected} fields translated${translationStatus.outdated + copyStatus.outdated > 0 ? `, ${translationStatus.outdated + copyStatus.outdated} outdated` : ""}. Review under “Translations”.`
                  : "Add a DeepL key on the Languages page to auto-translate into every published language."}
          </Text>

          <Collapsible id="cx-endo-add" open={addOpen}>
            <Box
              padding="300"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              {addOpen ? (
                <EndorsementForm
                  initial={EMPTY_ENDORSEMENT_FORM}
                  busy={saving}
                  submitLabel="Add endorsement"
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
              No endorsements yet — add the first one above.
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
                          source={item.imageUrl ?? PersonIcon}
                          alt={item.name}
                          size="small"
                        />
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center" wrap>
                            <Text
                              as="span"
                              variant="bodyMd"
                              fontWeight="semibold"
                            >
                              {item.name}
                            </Text>
                            {item.credentials ? (
                              <Text as="span" variant="bodySm" tone="subdued">
                                {item.credentials}
                              </Text>
                            ) : null}
                            {item.country ? (
                              <Badge>{item.country}</Badge>
                            ) : null}
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
                      id={`cx-endo-edit-${item.id}`}
                      open={editingId === item.id}
                    >
                      <Box
                        padding="300"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        {editingId === item.id ? (
                          <EndorsementForm
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
                                { field: "quote", label: "Quote", sourceText: item.quote },
                                { field: "credentials", label: "Credentials", sourceText: item.credentials ?? "" },
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

      <Card>
        <BlockStack gap="300">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">
              Buy-box badge & section copy
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              The badge is a compact strip on product pages, right under the
              price (above the description on desktop): real endorsement
              portraits, the live endorsement count and an optional link
              that scrolls to the wall. It renders only while the feature
              above is enabled and the product has endorsements to show.
            </Text>
          </BlockStack>
          <Checkbox
            label="Show the endorsement badge on product pages"
            checked={displayState.badgeEnabled}
            onChange={(value) => setDisplayField("badgeEnabled", value)}
          />
          <Select
            label="Badge design"
            options={[...BADGE_STYLE_OPTIONS]}
            value={displayState.badgeStyle}
            onChange={(value) =>
              setDisplayField(
                "badgeStyle",
                value as (typeof display)["badgeStyle"],
              )
            }
            helpText="Classic keeps the blue shield look. The Choice designs use the cream panel with the laurel-and-caduceus title (the section eyebrow doubles as the title) and the credential chip. Slim is a single-line bar for the tightest buy box."
          />
          <Checkbox
            label="Show the assessments link on the badge"
            checked={displayState.badgeShowLink}
            onChange={(value) => setDisplayField("badgeShowLink", value)}
            helpText="Off: the badge shows the no-link line instead (edit it below)."
          />
          <Divider />
          <BlockStack gap="100">
            <Text as="h3" variant="headingSm">
              Copy
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Blank fields use the built-in copy, translated into all 18
              storefront languages. Custom text auto-translates into every
              published language through DeepL (key on the Languages page)
              when you save — review or hand-edit each language under
              Translations below. {"{n}"} in the two headline fields inserts
              the live endorsement count and survives translation.
            </Text>
          </BlockStack>
          <TextField
            label="Section eyebrow"
            value={displayState.copyEyebrow}
            onChange={(value) => setDisplayField("copyEyebrow", value)}
            placeholder="Dermatologist recommended"
            autoComplete="off"
          />
          <TextField
            label="Section headline"
            value={displayState.copyHeadline}
            onChange={(value) => setDisplayField("copyHeadline", value)}
            placeholder="{n} dermatologists recommend Cellexia"
            helpText="Use {n} to insert the endorsement count."
            autoComplete="off"
          />
          <TextField
            label="Section description"
            value={displayState.copyDescription}
            onChange={(value) => setDisplayField("copyDescription", value)}
            placeholder="Verified recommendations from licensed dermatologists. Read what they have to say about the product, Cellexia and its approach to skincare."
            multiline={3}
            helpText="Shown under the headline (full display density only)."
            autoComplete="off"
          />
          <TextField
            label="Badge headline"
            value={displayState.copyBadgeHeadline}
            onChange={(value) => setDisplayField("copyBadgeHeadline", value)}
            placeholder="Recommended by {n} dermatologists"
            helpText="Use {n} to insert the endorsement count."
            autoComplete="off"
          />
          <TextField
            label="Badge link text"
            value={displayState.copyBadgeLink}
            onChange={(value) => setDisplayField("copyBadgeLink", value)}
            placeholder="Read their professional assessments"
            autoComplete="off"
          />
          <TextField
            label="Badge no-link text"
            value={displayState.copyBadgeNoLink}
            onChange={(value) => setDisplayField("copyBadgeNoLink", value)}
            placeholder="Verified professional assessments"
            helpText="Shown instead of the link when the link is off."
            autoComplete="off"
          />
          <TextField
            label="Badge chip text"
            value={displayState.copyBadgeChip}
            onChange={(value) => setDisplayField("copyBadgeChip", value)}
            placeholder="Licensed dermatologists"
            helpText="The credential chip on the Choice designs."
            autoComplete="off"
          />
          <InlineStack gap="200">
            <Button
              variant="primary"
              onClick={saveDisplay}
              disabled={!displayDirty || displayFetcher.state !== "idle"}
              loading={displayFetcher.state !== "idle"}
            >
              Save badge & copy
            </Button>
          </InlineStack>
          <ProofTranslationsSection
            fields={[
              { field: "copyEyebrow", label: "Section eyebrow", sourceText: display.copyEyebrow },
              { field: "copyHeadline", label: "Section headline", sourceText: display.copyHeadline },
              { field: "copyDescription", label: "Section description", sourceText: display.copyDescription },
              { field: "copyBadgeHeadline", label: "Badge headline", sourceText: display.copyBadgeHeadline },
              { field: "copyBadgeLink", label: "Badge link text", sourceText: display.copyBadgeLink },
              { field: "copyBadgeNoLink", label: "Badge no-link text", sourceText: display.copyBadgeNoLink },
              { field: "copyBadgeChip", label: "Badge chip text", sourceText: display.copyBadgeChip },
            ]}
            targetLocales={targetLocales}
            translations={copyTranslations}
            onSave={(locale, field, value) =>
              submitTranslation(COPY_ID, locale, field, value)
            }
            saving={manualSaving}
          />
        </BlockStack>
      </Card>

      <MarketScopeCard
        title="Markets — endorsement wall"
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
