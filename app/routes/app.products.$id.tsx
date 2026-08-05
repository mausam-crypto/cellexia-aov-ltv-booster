import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  MaxPartSizeExceededError,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "@remix-run/node";
import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  DropZone,
  InlineStack,
  Layout,
  Link,
  Page,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DeleteIcon,
} from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getSettings,
  resolveFeatureFlag,
} from "../models/settings.server";
import {
  adminRequest,
  ensurePdpDefinitions,
  stagedImageUpload,
} from "../services/metaobjects.server";
import {
  deleteBatchTransparency,
  deleteClinicalStudy,
  deleteProductSurvey,
  getProductBoosters,
  isPdpContainer,
  saveBatchTransparency,
  saveBeforeAfters,
  saveClinicalStudy,
  savePdpFlags,
  saveProductSurvey,
  PDP_FLAG_KEYS,
} from "../services/pdp-content.server";
import type {
  BatchTransparencyInput,
  BatchTransparencyView,
  BeforeAfterInput,
  BeforeAfterView,
  ClinicalStudyInput,
  ClinicalStudyView,
  PdpFlagKey,
  PdpFlagsPatch,
  ProductSurveyInput,
  ProductSurveyView,
} from "../services/pdp-content.server";
import { getVariantsByIds } from "../services/products.server";
import type { loader as variantsLoader } from "./app.api.variants";
import {
  collectAllowedMetafieldGids,
  collectBoosterResourceGids,
  getTargetLocales,
  getTranslationConfig,
  translateResources,
  type TranslateRunSummary,
} from "../services/translation.server";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Shops whose PDP metaobject/metafield definitions were verified this server
 * lifetime (successes only, so a failed attempt retries on the next load).
 */
const ensuredShops = new Set<string>();

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const numericId = params.id ?? "";
  if (!/^\d+$/.test(numericId)) {
    throw new Response("Product not found", { status: 404 });
  }
  const productGid = `gid://shopify/Product/${numericId}`;

  let definitionErrors: string[] = [];
  if (!ensuredShops.has(session.shop)) {
    const ensured = await ensurePdpDefinitions(admin);
    if (ensured.ok) {
      ensuredShops.add(session.shop);
    }
    definitionErrors = ensured.errors;
  }

  const [settings, boosters, translationConfig, targetLocales] =
    await Promise.all([
      getSettings(session.shop),
      getProductBoosters(admin, productGid),
      getTranslationConfig(session.shop),
      getTargetLocales(admin),
    ]);
  const storePrefix = session.shop.replace(".myshopify.com", "");

  // Hydrate the saved manual FBT selections with live variant data so the
  // picker can show titles instead of raw handles (max 4 ids — cheap).
  const fbtManual = boosters.flags.fbtManual ?? [];
  const fbtVariants =
    fbtManual.length > 0
      ? await getVariantsByIds(
          admin,
          fbtManual.map((item) => item.variantId),
        ).catch(() => [])
      : [];

  // Bought-count staleness, computed SERVER-SIDE (a client Date.now() would
  // hydrate differently). Same 45-day rule as the storefront honesty guard.
  const setAt = boosters.flags.boughtCountSetAt ?? null;
  const setAtMs = setAt ? Date.parse(setAt) : Number.NaN;
  const boughtCountAgeDays = Number.isFinite(setAtMs)
    ? Math.max(
        0,
        Math.round(
          (Date.parse(new Date().toISOString().slice(0, 10)) - setAtMs) /
            86_400_000,
        ),
      )
    : null;

  return {
    boosters,
    // The DeepL key itself never leaves the server — booleans/counts only.
    translation: {
      configured: translationConfig.configured,
      autoOnSave: translationConfig.autoOnSave,
      targetCount: targetLocales.targets.length,
    },
    definitionErrors,
    guaranteeDays: settings.emptyBottleGuarantee.days,
    guaranteeContainer: settings.emptyBottleGuarantee.container,
    globalFlags: {
      clinical_study: resolveFeatureFlag(settings, "clinical_study"),
      verified_before_after: resolveFeatureFlag(
        settings,
        "verified_before_after",
      ),
      batch_transparency: resolveFeatureFlag(settings, "batch_transparency"),
      empty_bottle_guarantee: resolveFeatureFlag(
        settings,
        "empty_bottle_guarantee",
      ),
      derm_survey: resolveFeatureFlag(settings, "derm_survey"),
      press: resolveFeatureFlag(settings, "press"),
      derm_endorsements: resolveFeatureFlag(settings, "derm_endorsements"),
    },
    amazonGlobalFlags: {
      az_bought_count: resolveFeatureFlag(settings, "az_bought_count"),
      az_bestseller_badge: resolveFeatureFlag(settings, "az_bestseller_badge"),
      az_fbt: resolveFeatureFlag(settings, "az_fbt"),
    },
    fbtVariants,
    boughtCountAgeDays,
    metaobjectsUrl: `https://admin.shopify.com/store/${storePrefix}/content/metaobjects`,
  };
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

interface FileResultPayload {
  ok: boolean;
  fileGid: string | null;
  url: string | null;
  previewUrl: string | null;
  errors: string[];
}

type ProductBoosterActionResult =
  | ({ intent: "upload_image" } & FileResultPayload)
  | ({ intent: "import_image_url" } & FileResultPayload)
  | {
      intent: "translate_boosters";
      ok: boolean;
      errors: string[];
      summary: TranslateRunSummary | null;
    }
  | { intent: "save_flags"; ok: boolean; errors: string[] }
  | { intent: "save_amazon"; ok: boolean; errors: string[] }
  | { intent: "save_clinical"; ok: boolean; errors: string[] }
  | { intent: "delete_clinical"; ok: boolean; errors: string[] }
  | { intent: "save_survey"; ok: boolean; errors: string[] }
  | { intent: "delete_survey"; ok: boolean; errors: string[] }
  | { intent: "save_ba"; ok: boolean; errors: string[] }
  | { intent: "save_batch"; ok: boolean; errors: string[] }
  | { intent: "delete_batch"; ok: boolean; errors: string[] }
  | { intent: "unknown"; ok: false; errors: string[] };

function fileFailure(
  intent: "upload_image" | "import_image_url",
  errors: string[],
): ProductBoosterActionResult {
  return { intent, ok: false, fileGid: null, url: null, previewUrl: null, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * `knownIds` formData field: JSON array of every metaobject GID the client's
 * form was seeded from. Passed to the save services so a stale full-list save
 * cannot silently delete entries created by another session. Undefined (old
 * or malformed submissions) disables the staleness check server-side.
 */
function parseKnownIds(raw: FormDataEntryValue | null): string[] | undefined {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return undefined;
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fileCreate from an external https URL (image URL paste for before/after
 * entries — their file_reference fields need a MediaImage GID, so an external
 * URL must be imported into Shopify Files first). Uses the exported
 * adminRequest plumbing from metaobjects.server.
 */
const ROUTE_FILE_CREATE_MUTATION = `#graphql
  mutation cellexiaPdpRouteFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus }
      userErrors { field message code }
    }
  }
`;

const ROUTE_FILE_STATUS_QUERY = `#graphql
  query cellexiaPdpRouteFileStatus($id: ID!) {
    node(id: $id) {
      ... on MediaImage {
        id
        fileStatus
        image { url }
        preview { image { url } }
      }
      ... on GenericFile {
        id
        fileStatus
        url
        preview { image { url } }
      }
    }
  }
`;

interface RouteFileCreateData {
  fileCreate: {
    files: { id: string; fileStatus: string }[] | null;
    userErrors: { field?: string[] | null; message: string; code?: string | null }[];
  } | null;
}

interface RouteFileStatusData {
  node: {
    id?: string;
    fileStatus?: string;
    url?: string | null;
    image?: { url: string } | null;
    preview?: { image: { url: string } | null } | null;
  } | null;
}

async function importImageFromUrl(
  admin: Parameters<typeof adminRequest>[0],
  sourceUrl: string,
): Promise<ProductBoosterActionResult> {
  const intent = "import_image_url" as const;
  const created = await adminRequest<RouteFileCreateData>(
    admin,
    ROUTE_FILE_CREATE_MUTATION,
    {
      files: [
        {
          contentType: "IMAGE",
          originalSource: sourceUrl,
          duplicateResolutionMode: "APPEND_UUID",
        },
      ],
    },
  );
  const userErrors = created.data?.fileCreate?.userErrors ?? [];
  const fileGid = created.data?.fileCreate?.files?.[0]?.id ?? null;
  const errors = [...userErrors.map((e) => e.message), ...created.errors];
  if (!fileGid || errors.length > 0) {
    return fileFailure(
      intent,
      errors.length ? errors : ["Shopify did not accept the image URL"],
    );
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt > 0) await sleep(500);
    const status = await adminRequest<RouteFileStatusData>(
      admin,
      ROUTE_FILE_STATUS_QUERY,
      { id: fileGid },
    );
    const node = status.data?.node ?? null;
    if (!node?.fileStatus) continue;
    if (node.fileStatus === "FAILED") {
      return {
        intent,
        ok: false,
        fileGid,
        url: null,
        previewUrl: null,
        errors: [
          "Shopify could not process an image from that URL — make sure it links directly to an image file",
        ],
      };
    }
    if (node.fileStatus === "READY") {
      const url = node.image?.url ?? node.url ?? null;
      return {
        intent,
        ok: true,
        fileGid,
        url,
        previewUrl: node.preview?.image?.url ?? url,
        errors: [],
      };
    }
  }
  // Still processing — the GID is valid and safe to store.
  return { intent, ok: true, fileGid, url: null, previewUrl: null, errors: [] };
}

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<ProductBoosterActionResult> => {
  const { session, admin } = await authenticate.admin(request);
  const numericId = params.id ?? "";
  if (!/^\d+$/.test(numericId)) {
    return { intent: "unknown", ok: false, errors: ["Invalid product id"] };
  }
  const productGid = `gid://shopify/Product/${numericId}`;

  // Multipart branch (file uploads) — decided BEFORE any body parsing.
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await unstable_parseMultipartFormData(
        request,
        unstable_createMemoryUploadHandler({ maxPartSize: MAX_UPLOAD_BYTES }),
      );
    } catch (error) {
      return fileFailure("upload_image", [
        error instanceof MaxPartSizeExceededError
          ? "The file is larger than 10 MB"
          : error instanceof Error
            ? error.message
            : "Could not read the uploaded file",
      ]);
    }
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return fileFailure("upload_image", ["No file was uploaded"]);
    }
    const mime = (file.type || "").toLowerCase();
    if (!mime.startsWith("image/") && mime !== "application/pdf") {
      return fileFailure("upload_image", [
        "Only images and PDF documents can be uploaded",
      ]);
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

  switch (intent) {
    case "import_image_url": {
      const sourceUrl = String(formData.get("url") ?? "").trim();
      if (!/^https:\/\/\S+$/.test(sourceUrl)) {
        return fileFailure("import_image_url", [
          "Enter an https:// image URL",
        ]);
      }
      return importImageFromUrl(admin, sourceUrl);
    }
    case "translate_boosters": {
      const config = await getTranslationConfig(session.shop);
      if (!config.configured) {
        return {
          intent: "translate_boosters",
          ok: false,
          errors: [
            "Connect a DeepL API key on the Languages page to enable auto-translation.",
          ],
          summary: null,
        };
      }
      const boosters = await getProductBoosters(admin, productGid);
      const gids = collectBoosterResourceGids(boosters);
      const targets = await getTargetLocales(admin);
      if (targets.errors.length) {
        return {
          intent: "translate_boosters",
          ok: false,
          errors: targets.errors,
          summary: null,
        };
      }
      const summary = await translateResources(
        admin,
        config.apiKey,
        gids,
        targets.targets,
        // Scoped admission: ONLY the bestseller-category metafield's "value"
        // key may translate — no other metafield ever joins the run.
        { metafieldValueGids: collectAllowedMetafieldGids(boosters) },
      );
      return {
        intent: "translate_boosters",
        ok: summary.ok,
        errors: summary.errors,
        summary,
      };
    }
    case "save_flags": {
      const key = String(formData.get("key") ?? "");
      const value = String(formData.get("value") ?? "");
      // Per-product container override for the empty-bottle guarantee copy:
      // a valid container sets it, "inherit" clears it (fall back to the
      // global emptyBottleGuarantee.container).
      if (key === "container") {
        if (value !== "inherit" && !isPdpContainer(value)) {
          return {
            intent: "save_flags",
            ok: false,
            errors: ["Unknown container type"],
          };
        }
        const result = await savePdpFlags(admin, productGid, {
          container: value === "inherit" ? null : value,
        });
        return { intent: "save_flags", ok: result.ok, errors: result.errors };
      }
      if (!(PDP_FLAG_KEYS as readonly string[]).includes(key)) {
        return { intent: "save_flags", ok: false, errors: ["Unknown booster flag"] };
      }
      const result = await savePdpFlags(admin, productGid, {
        [key]: value === "true",
      } as Partial<Record<PdpFlagKey, boolean>>);
      return { intent: "save_flags", ok: result.ok, errors: result.errors };
    }
    case "save_amazon": {
      const payload = parseJson(formData.get("payload"));
      if (!isRecord(payload)) {
        return {
          intent: "save_amazon",
          ok: false,
          errors: ["Invalid form payload"],
        };
      }
      // Only the three Amazon-data keys are forwarded, and each ONLY when
      // present in the payload — savePdpFlags treats absent keys as
      // untouched, so a bestseller-only edit never restamps the bought
      // count's freshness date.
      const patch: PdpFlagsPatch = {};
      if ("boughtCount" in payload) {
        patch.boughtCount = payload.boughtCount as number | null;
      }
      if ("bestsellerLabel" in payload) {
        patch.bestsellerLabel =
          payload.bestsellerLabel as PdpFlagsPatch["bestsellerLabel"];
      }
      if ("fbtManual" in payload) {
        patch.fbtManual = payload.fbtManual as PdpFlagsPatch["fbtManual"];
      }
      const result = await savePdpFlags(admin, productGid, patch);
      return { intent: "save_amazon", ok: result.ok, errors: result.errors };
    }
    case "save_clinical": {
      const payload = parseJson(formData.get("payload"));
      if (!isRecord(payload)) {
        return {
          intent: "save_clinical",
          ok: false,
          errors: ["Invalid form payload"],
        };
      }
      const result = await saveClinicalStudy(
        admin,
        productGid,
        payload as unknown as ClinicalStudyInput,
        parseKnownIds(formData.get("knownIds")),
      );
      return { intent: "save_clinical", ok: result.ok, errors: result.errors };
    }
    case "delete_clinical": {
      const result = await deleteClinicalStudy(admin, productGid);
      return { intent: "delete_clinical", ok: result.ok, errors: result.errors };
    }
    case "save_survey": {
      const payload = parseJson(formData.get("payload"));
      if (!isRecord(payload)) {
        return {
          intent: "save_survey",
          ok: false,
          errors: ["Invalid form payload"],
        };
      }
      const result = await saveProductSurvey(
        admin,
        productGid,
        payload as unknown as ProductSurveyInput,
        parseKnownIds(formData.get("knownIds")),
      );
      return { intent: "save_survey", ok: result.ok, errors: result.errors };
    }
    case "delete_survey": {
      const result = await deleteProductSurvey(admin, productGid);
      return { intent: "delete_survey", ok: result.ok, errors: result.errors };
    }
    case "save_ba": {
      const payload = parseJson(formData.get("payload"));
      if (!Array.isArray(payload)) {
        return { intent: "save_ba", ok: false, errors: ["Invalid form payload"] };
      }
      const result = await saveBeforeAfters(
        admin,
        productGid,
        payload as unknown as BeforeAfterInput[],
        parseKnownIds(formData.get("knownIds")),
      );
      return { intent: "save_ba", ok: result.ok, errors: result.errors };
    }
    case "save_batch": {
      const payload = parseJson(formData.get("payload"));
      if (!isRecord(payload)) {
        return {
          intent: "save_batch",
          ok: false,
          errors: ["Invalid form payload"],
        };
      }
      const result = await saveBatchTransparency(
        admin,
        productGid,
        payload as unknown as BatchTransparencyInput,
        parseKnownIds(formData.get("knownIds")),
      );
      return { intent: "save_batch", ok: result.ok, errors: result.errors };
    }
    case "delete_batch": {
      const result = await deleteBatchTransparency(admin, productGid);
      return { intent: "delete_batch", ok: result.ok, errors: result.errors };
    }
    default:
      return { intent: "unknown", ok: false, errors: ["Unknown action"] };
  }
};

// ---------------------------------------------------------------------------
// Client-side form state
// ---------------------------------------------------------------------------

interface StudyResultState {
  id: string | null;
  value: string;
  suffix: string;
  label: string;
}

interface ClinicalFormState {
  title: string;
  subject: string;
  concern: string;
  durationWeeks: string;
  sampleSize: string;
  labName: string;
  instruments: string;
  studyUrl: string;
  footnote: string;
  results: StudyResultState[];
}

const MAX_RESULTS = 6;
const MAX_OUTCOMES = 6;
const MAX_BA_ENTRIES = 20;
const MAX_INGREDIENTS = 60;
const MAX_CERTIFICATES = 60;

/** Options for the per-product guarantee container Select — "inherit" means
 *  no override is stored (the global emptyBottleGuarantee.container applies). */
const CONTAINER_SELECT_OPTIONS = [
  { label: "Inherit default", value: "inherit" },
  { label: "Bottle", value: "bottle" },
  { label: "Jar", value: "jar" },
  { label: "Tube", value: "tube" },
  { label: "Pump", value: "pump" },
  { label: "Product", value: "product" },
];

/**
 * Client-safe literal mirrors of BOUGHT_COUNT_STALE_DAYS /
 * MAX_FBT_MANUAL_ITEMS in services/pdp-content.server.ts — component code
 * must not reference *.server modules; keep the pairs in sync.
 */
const AZ_STALE_DAYS = 45;
const AZ_MAX_FBT_ITEMS = 3;

interface FbtItemState {
  variantId: string;
  handle: string;
  /** Display-only product title (hydrated when available, else the handle). */
  label: string;
}

interface AmazonEditState {
  boughtCount: string;
  rank: string;
  category: string;
  fbt: FbtItemState[];
}

/** Payload-relevant projection so display labels never make the card dirty. */
function amazonProjection(state: AmazonEditState) {
  return {
    boughtCount: state.boughtCount.trim(),
    rank: state.rank.trim(),
    category: state.category.trim(),
    fbt: state.fbt.map((item) => item.variantId),
  };
}

interface AmazonEditErrors {
  boughtCountError?: string;
  bestsellerError?: string;
}

function validateAmazonEdit(state: AmazonEditState): AmazonEditErrors {
  const errors: AmazonEditErrors = {};
  const count = state.boughtCount.trim();
  if (count !== "") {
    const parsed = Number(count);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000_000) {
      errors.boughtCountError = "Whole number (0 clears)";
    }
  }
  const rank = state.rank.trim();
  const category = state.category.trim();
  if (rank !== "" || category !== "") {
    const parsedRank = Number(rank);
    if (
      rank === "" ||
      !Number.isInteger(parsedRank) ||
      parsedRank < 1 ||
      parsedRank > 99
    ) {
      errors.bestsellerError = "Rank must be 1–99";
    } else if (category === "") {
      errors.bestsellerError = "Category required with a rank";
    } else if (category.length > 60) {
      errors.bestsellerError = "Category is limited to 60 characters";
    }
  }
  return errors;
}

function clinicalToState(view: ClinicalStudyView | null): ClinicalFormState {
  if (!view) {
    return {
      title: "",
      subject: "",
      concern: "",
      durationWeeks: "",
      sampleSize: "",
      labName: "",
      instruments: "",
      studyUrl: "",
      footnote: "",
      results: [],
    };
  }
  return {
    title: view.title,
    subject: view.subject,
    concern: view.concern,
    durationWeeks: view.durationWeeks === null ? "" : String(view.durationWeeks),
    sampleSize: view.sampleSize === null ? "" : String(view.sampleSize),
    labName: view.labName,
    instruments: view.instruments,
    studyUrl: view.studyUrl,
    footnote: view.footnote,
    results: view.results.map((result) => ({
      id: result.id,
      value: result.value === null ? "" : String(result.value),
      suffix: result.suffix,
      label: result.label,
    })),
  };
}

interface SurveyOutcomeState {
  key: string;
  id: string | null;
  statement: string;
  yesCount: string;
}

interface SurveyFormState {
  title: string;
  sampleSize: string;
  /** Empty string = no "would recommend" headline (null in the payload —
   *  never a fabricated 0). */
  recommendYes: string;
  question: string;
  intro: string;
  methodology: string;
  verifierName: string;
  verificationUrl: string;
  outcomes: SurveyOutcomeState[];
}

function surveyToState(view: ProductSurveyView | null): SurveyFormState {
  if (!view) {
    return {
      title: "",
      sampleSize: "",
      recommendYes: "",
      question: "",
      intro: "",
      methodology: "",
      verifierName: "",
      verificationUrl: "",
      outcomes: [],
    };
  }
  return {
    title: view.title,
    sampleSize: view.sampleSize === null ? "" : String(view.sampleSize),
    recommendYes: view.recommendYes === null ? "" : String(view.recommendYes),
    question: view.question,
    intro: view.intro,
    methodology: view.methodology,
    verifierName: view.verifierName,
    verificationUrl: view.verificationUrl,
    outcomes: view.outcomes.map((outcome) => ({
      key: outcome.id,
      id: outcome.id,
      statement: outcome.statement,
      yesCount: outcome.yesCount === null ? "" : String(outcome.yesCount),
    })),
  };
}

/** Payload-relevant projection so client row keys never make the card look
 *  dirty. */
function surveyProjection(state: SurveyFormState) {
  return {
    title: state.title,
    sampleSize: state.sampleSize,
    recommendYes: state.recommendYes,
    question: state.question,
    intro: state.intro,
    methodology: state.methodology,
    verifierName: state.verifierName,
    verificationUrl: state.verificationUrl,
    outcomes: state.outcomes.map((outcome) => ({
      id: outcome.id,
      statement: outcome.statement,
      yesCount: outcome.yesCount,
    })),
  };
}

interface BaEntryState {
  key: string;
  id: string | null;
  beforeImageGid: string;
  beforePreviewUrl: string | null;
  afterImageGid: string;
  afterPreviewUrl: string | null;
  beforeDate: string;
  afterDate: string;
  weeks: string;
  clinic: string;
  imaging: string;
  verifierName: string;
  verifierLicense: string;
  statement: string;
  verificationUrl: string;
}

function baToState(views: BeforeAfterView[]): BaEntryState[] {
  return views.map((view) => ({
    key: view.id,
    id: view.id,
    beforeImageGid: view.beforeImageGid,
    beforePreviewUrl: view.beforeImageUrl,
    afterImageGid: view.afterImageGid,
    afterPreviewUrl: view.afterImageUrl,
    beforeDate: view.beforeDate,
    afterDate: view.afterDate,
    weeks: view.weeks === null ? "" : String(view.weeks),
    clinic: view.clinic,
    imaging: view.imaging,
    verifierName: view.verifierName,
    verifierLicense: view.verifierLicense,
    statement: view.statement,
    verificationUrl: view.verificationUrl,
  }));
}

/** Payload-relevant projection so preview URLs and client keys never make a
 *  card look dirty. */
function baProjection(entries: BaEntryState[]) {
  return entries.map((entry) => ({
    id: entry.id,
    beforeImageGid: entry.beforeImageGid,
    afterImageGid: entry.afterImageGid,
    beforeDate: entry.beforeDate,
    afterDate: entry.afterDate,
    weeks: entry.weeks,
    clinic: entry.clinic,
    imaging: entry.imaging,
    verifierName: entry.verifierName,
    verifierLicense: entry.verifierLicense,
    statement: entry.statement,
    verificationUrl: entry.verificationUrl,
  }));
}

interface IngredientState {
  key: string;
  id: string | null;
  name: string;
  concentration: string;
  form: string;
  note: string;
}

interface CertificateState {
  key: string;
  id: string | null;
  batch: string;
  issued: string;
  lab: string;
  documentUrl: string;
  documentGid: string;
  documentFileUrl: string | null;
}

interface BatchFormState {
  intro: string;
  ingredients: IngredientState[];
  certificates: CertificateState[];
}

function batchToState(view: BatchTransparencyView | null): BatchFormState {
  if (!view) return { intro: "", ingredients: [], certificates: [] };
  return {
    intro: view.intro,
    ingredients: view.ingredients.map((ingredient) => ({
      key: ingredient.id,
      id: ingredient.id,
      name: ingredient.name,
      concentration:
        ingredient.concentration === null ? "" : String(ingredient.concentration),
      form: ingredient.form,
      note: ingredient.note,
    })),
    certificates: view.certificates.map((certificate) => ({
      key: certificate.id,
      id: certificate.id,
      batch: certificate.batch,
      issued: certificate.issued,
      lab: certificate.lab,
      documentUrl: certificate.documentUrl,
      documentGid: certificate.documentGid,
      documentFileUrl: certificate.documentFileUrl,
    })),
  };
}

function batchProjection(state: BatchFormState) {
  return {
    intro: state.intro,
    ingredients: state.ingredients.map((entry) => ({
      id: entry.id,
      name: entry.name,
      concentration: entry.concentration,
      form: entry.form,
      note: entry.note,
    })),
    certificates: state.certificates.map((entry) => ({
      id: entry.id,
      batch: entry.batch,
      issued: entry.issued,
      lab: entry.lab,
      documentUrl: entry.documentUrl,
      documentGid: entry.documentGid,
    })),
  };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function weeksBetween(beforeDate: string, afterDate: string): number | null {
  if (!DATE_PATTERN.test(beforeDate) || !DATE_PATTERN.test(afterDate)) {
    return null;
  }
  const before = Date.parse(beforeDate);
  const after = Date.parse(afterDate);
  if (Number.isNaN(before) || Number.isNaN(after) || after < before) {
    return null;
  }
  return Math.round((after - before) / (7 * 24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Numeric validation + concurrent-edit helpers
// ---------------------------------------------------------------------------

/**
 * Parses a numeric text input, accepting comma decimals ("1,5" → 1.5).
 * Returns null when the field is empty or not a number — callers must never
 * substitute a fabricated 0 (it would render false storefront claims like
 * "n = 0 participants" or a giant "0%").
 */
function parseNumericInput(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Inline error for a required numeric TextField, or undefined when valid. */
function numericError(
  raw: string,
  options: { integer?: boolean; min?: number } = {},
): string | undefined {
  const value = parseNumericInput(raw);
  if (value === null) {
    return raw.trim() === "" ? "Required" : "Enter a number";
  }
  if (options.min !== undefined && value < options.min) {
    return `Must be ${options.min} or more`;
  }
  if (options.integer && !Number.isInteger(value)) {
    return "Must be a whole number";
  }
  return undefined;
}

/**
 * Mirror of STALE_CONTENT_ERROR in app/services/pdp-content.server.ts — that
 * module is server-only, so the constant cannot be imported into client code.
 * Keep the two strings byte-identical.
 */
const STALE_CONTENT_MESSAGE =
  "content changed since you loaded this page — reload before saving";

function isStaleResult(
  data: ProductBoosterActionResult | undefined,
  intents: string[],
): boolean {
  return Boolean(
    data &&
      intents.includes(data.intent) &&
      !data.ok &&
      data.errors.includes(STALE_CONTENT_MESSAGE),
  );
}

/** All metaobject GIDs a card's form was seeded from — submitted as
 *  `knownIds` with the card's save so the server can detect concurrent
 *  edits (see hasUnseenServerIds in pdp-content.server.ts). */
function clinicalKnownIds(view: ClinicalStudyView | null): string[] {
  if (!view) return [];
  return [view.id, ...view.results.map((result) => result.id)];
}

function surveyKnownIds(view: ProductSurveyView | null): string[] {
  if (!view) return [];
  return [view.id, ...view.outcomes.map((outcome) => outcome.id)];
}

function baKnownIds(views: BeforeAfterView[]): string[] {
  return views.map((view) => view.id);
}

function batchKnownIds(view: BatchTransparencyView | null): string[] {
  if (!view) return [];
  return [
    view.id,
    ...view.ingredients.map((entry) => entry.id),
    ...view.certificates.map((entry) => entry.id),
  ];
}

// ---------------------------------------------------------------------------
// Upload widgets (per-instance fetchers so concurrent uploads never collide)
// ---------------------------------------------------------------------------

interface ImageFieldProps {
  label: string;
  imageGid: string;
  previewUrl: string | null;
  disabled: boolean;
  onSelect: (gid: string, previewUrl: string | null) => void;
  onClear: () => void;
}

function ImageField({
  label,
  imageGid,
  previewUrl,
  disabled,
  onSelect,
  onClear,
}: ImageFieldProps) {
  const shopify = useAppBridge();
  const upload = useFetcher<typeof action>();
  const importer = useFetcher<typeof action>();
  const [urlText, setUrlText] = useState("");
  const busy = upload.state !== "idle" || importer.state !== "idle";

  useEffect(() => {
    const data = upload.data;
    if (!data || data.intent !== "upload_image") return;
    if (data.ok && data.fileGid) {
      onSelect(data.fileGid, data.previewUrl ?? data.url);
      shopify.toast.show(
        data.previewUrl ?? data.url
          ? "Image uploaded"
          : "Image uploaded — the preview is still processing",
      );
    } else {
      shopify.toast.show(data.errors[0] ?? "Upload failed", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upload.data]);

  useEffect(() => {
    const data = importer.data;
    if (!data || data.intent !== "import_image_url") return;
    if (data.ok && data.fileGid) {
      onSelect(data.fileGid, data.previewUrl ?? data.url);
      setUrlText("");
      shopify.toast.show("Image imported to Shopify Files");
    } else {
      shopify.toast.show(data.errors[0] ?? "Image import failed", {
        isError: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importer.data]);

  const handleDrop = (_dropped: File[], accepted: File[]) => {
    const file = accepted[0];
    if (!file) {
      shopify.toast.show("That file type can’t be used here", { isError: true });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      shopify.toast.show("The file is larger than 10 MB", { isError: true });
      return;
    }
    const formData = new FormData();
    formData.set("intent", "upload_image");
    formData.set("file", file, file.name);
    upload.submit(formData, {
      method: "post",
      encType: "multipart/form-data",
    });
  };

  const handleImport = () => {
    const formData = new FormData();
    formData.set("intent", "import_image_url");
    formData.set("url", urlText.trim());
    importer.submit(formData, { method: "post" });
  };

  const urlValid = /^https:\/\/\S+$/.test(urlText.trim());

  return (
    <Box minWidth="240px" maxWidth="280px">
      <BlockStack gap="200">
        <Text as="span" variant="bodySm" fontWeight="semibold">
          {label}
        </Text>
        <DropZone
          accept="image/*"
          type="image"
          allowMultiple={false}
          onDrop={handleDrop}
          disabled={disabled || busy}
          label={label}
          labelHidden
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={label}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
          ) : imageGid ? (
            <Box padding="300">
              <Text as="p" variant="bodySm" tone="subdued">
                Image saved — preview processing. Drop a file to replace it.
              </Text>
            </Box>
          ) : (
            <DropZone.FileUpload
              actionTitle="Add image"
              actionHint="or drop a file (max 10 MB)"
            />
          )}
        </DropZone>
        {busy ? (
          <InlineStack gap="100" blockAlign="center">
            <Spinner size="small" accessibilityLabel="Uploading image" />
            <Text as="span" variant="bodySm" tone="subdued">
              Uploading…
            </Text>
          </InlineStack>
        ) : null}
        <TextField
          label={`${label} URL`}
          labelHidden
          placeholder="…or paste an https:// image URL"
          value={urlText}
          onChange={setUrlText}
          autoComplete="off"
          disabled={disabled || busy}
          connectedRight={
            <Button
              onClick={handleImport}
              disabled={disabled || busy || !urlValid}
            >
              Import
            </Button>
          }
        />
        {imageGid ? (
          <Button
            variant="plain"
            tone="critical"
            onClick={onClear}
            disabled={disabled || busy}
          >
            Remove image
          </Button>
        ) : null}
      </BlockStack>
    </Box>
  );
}

interface DocumentFieldProps {
  documentGid: string;
  documentFileUrl: string | null;
  disabled: boolean;
  onSelect: (gid: string, fileUrl: string | null) => void;
  onClear: () => void;
}

function DocumentField({
  documentGid,
  documentFileUrl,
  disabled,
  onSelect,
  onClear,
}: DocumentFieldProps) {
  const shopify = useAppBridge();
  const upload = useFetcher<typeof action>();
  const busy = upload.state !== "idle";

  useEffect(() => {
    const data = upload.data;
    if (!data || data.intent !== "upload_image") return;
    if (data.ok && data.fileGid) {
      onSelect(data.fileGid, data.url);
      shopify.toast.show("Document uploaded");
    } else {
      shopify.toast.show(data.errors[0] ?? "Upload failed", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upload.data]);

  const handleDrop = (_dropped: File[], accepted: File[]) => {
    const file = accepted[0];
    if (!file) {
      shopify.toast.show("Only PDF documents can be uploaded here", {
        isError: true,
      });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      shopify.toast.show("The file is larger than 10 MB", { isError: true });
      return;
    }
    const formData = new FormData();
    formData.set("intent", "upload_image");
    formData.set("file", file, file.name);
    upload.submit(formData, {
      method: "post",
      encType: "multipart/form-data",
    });
  };

  return (
    <BlockStack gap="100">
      <Box maxWidth="240px">
        <DropZone
          accept="application/pdf"
          type="file"
          allowMultiple={false}
          onDrop={handleDrop}
          disabled={disabled || busy}
          label="Certificate PDF"
          labelHidden
        >
          <DropZone.FileUpload
            actionTitle={documentGid ? "Replace PDF" : "Upload PDF"}
            actionHint="max 10 MB"
          />
        </DropZone>
      </Box>
      {busy ? (
        <InlineStack gap="100" blockAlign="center">
          <Spinner size="small" accessibilityLabel="Uploading document" />
          <Text as="span" variant="bodySm" tone="subdued">
            Uploading…
          </Text>
        </InlineStack>
      ) : null}
      {documentGid ? (
        <InlineStack gap="200" blockAlign="center">
          {documentFileUrl ? (
            <Button variant="plain" url={documentFileUrl} target="_blank">
              View uploaded PDF
            </Button>
          ) : (
            <Text as="span" variant="bodySm" tone="subdued">
              PDF saved — link processing
            </Text>
          )}
          <Button
            variant="plain"
            tone="critical"
            onClick={onClear}
            disabled={disabled || busy}
          >
            Remove PDF
          </Button>
        </InlineStack>
      ) : null}
    </BlockStack>
  );
}

// ---------------------------------------------------------------------------
// Before/after entry editor
// ---------------------------------------------------------------------------

interface BeforeAfterEntryEditorProps {
  entry: BaEntryState;
  index: number;
  total: number;
  disabled: boolean;
  onChange: (patch: Partial<BaEntryState>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}

function BeforeAfterEntryEditor({
  entry,
  index,
  total,
  disabled,
  onChange,
  onRemove,
  onMove,
}: BeforeAfterEntryEditorProps) {
  const setDates = (patch: { beforeDate?: string; afterDate?: string }) => {
    const beforeDate = patch.beforeDate ?? entry.beforeDate;
    const afterDate = patch.afterDate ?? entry.afterDate;
    const auto = weeksBetween(beforeDate, afterDate);
    onChange(auto === null ? patch : { ...patch, weeks: String(auto) });
  };
  const autoWeeks = weeksBetween(entry.beforeDate, entry.afterDate);

  return (
    <Box
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
      padding="300"
    >
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingSm">
            Entry {index + 1}
          </Text>
          <InlineStack gap="100">
            <Button
              size="slim"
              icon={ArrowUpIcon}
              accessibilityLabel={`Move entry ${index + 1} up`}
              onClick={() => onMove(-1)}
              disabled={disabled || index === 0}
            />
            <Button
              size="slim"
              icon={ArrowDownIcon}
              accessibilityLabel={`Move entry ${index + 1} down`}
              onClick={() => onMove(1)}
              disabled={disabled || index === total - 1}
            />
            <Button
              size="slim"
              icon={DeleteIcon}
              tone="critical"
              accessibilityLabel={`Remove entry ${index + 1}`}
              onClick={onRemove}
              disabled={disabled}
            />
          </InlineStack>
        </InlineStack>
        <InlineStack gap="400" wrap>
          <ImageField
            label="Before image"
            imageGid={entry.beforeImageGid}
            previewUrl={entry.beforePreviewUrl}
            disabled={disabled}
            onSelect={(gid, previewUrl) =>
              onChange({ beforeImageGid: gid, beforePreviewUrl: previewUrl })
            }
            onClear={() =>
              onChange({ beforeImageGid: "", beforePreviewUrl: null })
            }
          />
          <ImageField
            label="After image"
            imageGid={entry.afterImageGid}
            previewUrl={entry.afterPreviewUrl}
            disabled={disabled}
            onSelect={(gid, previewUrl) =>
              onChange({ afterImageGid: gid, afterPreviewUrl: previewUrl })
            }
            onClear={() =>
              onChange({ afterImageGid: "", afterPreviewUrl: null })
            }
          />
        </InlineStack>
        {!entry.beforeImageGid || !entry.afterImageGid ? (
          <Text as="p" tone="critical" variant="bodySm">
            Both a before and an after image are required before saving.
          </Text>
        ) : null}
        <InlineStack gap="300" wrap>
          <Box width="170px">
            <TextField
              label="Before date"
              type="date"
              value={entry.beforeDate}
              onChange={(beforeDate) => setDates({ beforeDate })}
              disabled={disabled}
              autoComplete="off"
            />
          </Box>
          <Box width="170px">
            <TextField
              label="After date"
              type="date"
              value={entry.afterDate}
              onChange={(afterDate) => setDates({ afterDate })}
              disabled={disabled}
              autoComplete="off"
            />
          </Box>
          <Box width="150px">
            <TextField
              label="Weeks between"
              type="number"
              min={0}
              value={entry.weeks}
              onChange={(weeks) => onChange({ weeks })}
              disabled={disabled}
              error={numericError(entry.weeks, { integer: true, min: 0 })}
              autoComplete="off"
              helpText={
                autoWeeks !== null
                  ? `≈ ${autoWeeks} weeks from the dates`
                  : "Filled automatically from the dates"
              }
            />
          </Box>
        </InlineStack>
        <InlineStack gap="300" wrap>
          <Box minWidth="260px">
            <TextField
              label="Clinic"
              value={entry.clinic}
              onChange={(clinic) => onChange({ clinic })}
              disabled={disabled}
              helpText="Where the images were captured, e.g. “Clinique Dermatologique de Lyon”."
              autoComplete="off"
            />
          </Box>
          <Box width="200px">
            <TextField
              label="Imaging system"
              value={entry.imaging}
              onChange={(imaging) => onChange({ imaging })}
              disabled={disabled}
              helpText="e.g. VISIA"
              autoComplete="off"
            />
          </Box>
        </InlineStack>
        <InlineStack gap="300" wrap>
          <Box minWidth="260px">
            <TextField
              label="Verifier name"
              value={entry.verifierName}
              onChange={(verifierName) => onChange({ verifierName })}
              disabled={disabled}
              helpText="The professional who verified this result, e.g. “Dr. Anne Moreau”."
              autoComplete="off"
            />
          </Box>
          <Box width="220px">
            <TextField
              label="Verifier license #"
              value={entry.verifierLicense}
              onChange={(verifierLicense) => onChange({ verifierLicense })}
              disabled={disabled}
              autoComplete="off"
            />
          </Box>
        </InlineStack>
        <TextField
          label="Verifier statement"
          value={entry.statement}
          onChange={(statement) => onChange({ statement })}
          multiline={2}
          disabled={disabled}
          helpText="Quoted next to the shield icon, e.g. “I confirm these images are unretouched and from the same patient.”"
          autoComplete="off"
        />
        <TextField
          label="Verification URL"
          value={entry.verificationUrl}
          onChange={(verificationUrl) => onChange({ verificationUrl })}
          placeholder="https://…"
          disabled={disabled}
          helpText="Public “View verification” link. Leave empty to hide it."
          autoComplete="off"
        />
      </BlockStack>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProductBoosterDetailPage() {
  const {
    boosters,
    translation,
    definitionErrors,
    guaranteeDays,
    guaranteeContainer,
    globalFlags,
    amazonGlobalFlags,
    fbtVariants,
    boughtCountAgeDays,
    metaobjectsUrl,
  } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();

  const clinicalFetcher = useFetcher<typeof action>();
  const surveyFetcher = useFetcher<typeof action>();
  const baFetcher = useFetcher<typeof action>();
  const batchFetcher = useFetcher<typeof action>();
  const flagsFetcher = useFetcher<typeof action>();
  const amazonFetcher = useFetcher<typeof action>();
  const translateFetcher = useFetcher<typeof action>();

  // ---------------------- auto-translation plumbing -----------------------
  const translating = translateFetcher.state !== "idle";
  /** A save landed while a translation run was in flight — run once more so
   *  the final text is what gets translated. */
  const translateQueuedRef = useRef(false);

  const runTranslate = () => {
    if (translateFetcher.state === "idle") {
      translateFetcher.submit(
        { intent: "translate_boosters" },
        { method: "post" },
      );
    } else {
      translateQueuedRef.current = true;
    }
  };
  const runTranslateRef = useRef(runTranslate);
  runTranslateRef.current = runTranslate;

  useEffect(() => {
    if (translateFetcher.state === "idle" && translateQueuedRef.current) {
      translateQueuedRef.current = false;
      translateFetcher.submit(
        { intent: "translate_boosters" },
        { method: "post" },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translateFetcher.state]);

  // Auto-fire after every successful content save (never after deletes —
  // a removed metaobject takes its translations with it). Each fetcher's
  // last-handled result is tracked by identity so one save = one run.
  // v6.4: an Amazon-data save joins the candidates too, but ONLY when it
  // actually SET a bestseller label — the category metafield is the sole
  // translatable piece of that card, so a bought-count edit or a cleared
  // label never spends a run.
  const amazonSaveSetLabelRef = useRef(false);
  const autoSeenRef = useRef<{
    clinical: unknown;
    survey: unknown;
    ba: unknown;
    batch: unknown;
    amazon: unknown;
  }>({ clinical: null, survey: null, ba: null, batch: null, amazon: null });
  useEffect(() => {
    const candidates = [
      { slot: "clinical" as const, data: clinicalFetcher.data, intent: "save_clinical" },
      { slot: "survey" as const, data: surveyFetcher.data, intent: "save_survey" },
      { slot: "ba" as const, data: baFetcher.data, intent: "save_ba" },
      { slot: "batch" as const, data: batchFetcher.data, intent: "save_batch" },
    ];
    let fire = false;
    for (const { slot, data, intent } of candidates) {
      if (!data || data === autoSeenRef.current[slot]) continue;
      autoSeenRef.current[slot] = data;
      if (data.intent === intent && data.ok) fire = true;
    }
    const amazonData = amazonFetcher.data;
    if (amazonData && amazonData !== autoSeenRef.current.amazon) {
      autoSeenRef.current.amazon = amazonData;
      if (
        amazonData.intent === "save_amazon" &&
        amazonData.ok &&
        amazonSaveSetLabelRef.current
      ) {
        fire = true;
      }
    }
    if (
      fire &&
      translation.configured &&
      translation.autoOnSave &&
      translation.targetCount > 0
    ) {
      runTranslateRef.current();
    }
  }, [
    clinicalFetcher.data,
    surveyFetcher.data,
    baFetcher.data,
    batchFetcher.data,
    amazonFetcher.data,
    translation.configured,
    translation.autoOnSave,
    translation.targetCount,
  ]);

  const initialClinical = useMemo(
    () => clinicalToState(boosters.clinicalStudy),
    [boosters],
  );
  const initialSurvey = useMemo(
    () => surveyToState(boosters.productSurvey),
    [boosters],
  );
  const initialBa = useMemo(() => baToState(boosters.beforeAfters), [boosters]);
  const initialBatch = useMemo(
    () => batchToState(boosters.batchTransparency),
    [boosters],
  );

  const [clinicalState, setClinicalState] = useState<ClinicalFormState>(
    initialClinical,
  );
  const [surveyState, setSurveyState] = useState<SurveyFormState>(
    initialSurvey,
  );
  const [baEntries, setBaEntries] = useState<BaEntryState[]>(initialBa);
  const [batchState, setBatchState] = useState<BatchFormState>(initialBatch);
  const [confirmDelete, setConfirmDelete] = useState<
    null | "clinical" | "survey" | "batch"
  >(null);

  const keyCounterRef = useRef(0);
  const nextKey = () => {
    keyCounterRef.current += 1;
    return `new-${keyCounterRef.current}`;
  };

  const clinicalDirty =
    JSON.stringify(clinicalState) !== JSON.stringify(initialClinical);
  const surveyDirty =
    JSON.stringify(surveyProjection(surveyState)) !==
    JSON.stringify(surveyProjection(initialSurvey));
  const baDirty =
    JSON.stringify(baProjection(baEntries)) !==
    JSON.stringify(baProjection(initialBa));
  const batchDirty =
    JSON.stringify(batchProjection(batchState)) !==
    JSON.stringify(batchProjection(initialBatch));

  const dirtyRef = useRef({
    clinical: false,
    survey: false,
    ba: false,
    batch: false,
  });
  dirtyRef.current = {
    clinical: clinicalDirty,
    survey: surveyDirty,
    ba: baDirty,
    batch: batchDirty,
  };

  /** True while any card save/delete is in flight — its own completion
   *  effect owns that revalidation's adoption, so the background branch
   *  below must not touch any card. */
  const cardSavePendingRef = useRef(false);
  cardSavePendingRef.current =
    clinicalFetcher.state !== "idle" ||
    surveyFetcher.state !== "idle" ||
    baFetcher.state !== "idle" ||
    batchFetcher.state !== "idle";

  /** Metaobject GIDs each card's form was seeded from (the `knownIds`
   *  concurrent-edit contract) — updated on every adoption below. */
  const clinicalSeedIdsRef = useRef<string[]>(
    clinicalKnownIds(boosters.clinicalStudy),
  );
  const surveySeedIdsRef = useRef<string[]>(
    surveyKnownIds(boosters.productSurvey),
  );
  const baSeedIdsRef = useRef<string[]>(baKnownIds(boosters.beforeAfters));
  const batchSeedIdsRef = useRef<string[]>(
    batchKnownIds(boosters.batchTransparency),
  );

  /** Cards whose next loader-data arrival must reseed the form regardless of
   *  local edits (the stale-content Reload button). */
  const forceAdoptRef = useRef({
    clinical: false,
    survey: false,
    ba: false,
    batch: false,
  });

  const revalidator = useRevalidator();
  const [staleReloaded, setStaleReloaded] = useState<{
    clinical: unknown;
    survey: unknown;
    ba: unknown;
    batch: unknown;
  }>({ clinical: null, survey: null, ba: null, batch: null });

  const adoptClinical = () => {
    clinicalSeedIdsRef.current = clinicalKnownIds(boosters.clinicalStudy);
    setClinicalState(initialClinical);
  };
  const adoptSurvey = () => {
    surveySeedIdsRef.current = surveyKnownIds(boosters.productSurvey);
    setSurveyState(initialSurvey);
  };
  const adoptBa = () => {
    baSeedIdsRef.current = baKnownIds(boosters.beforeAfters);
    setBaEntries(initialBa);
  };
  const adoptBatch = () => {
    batchSeedIdsRef.current = batchKnownIds(boosters.batchTransparency);
    setBatchState(initialBatch);
  };

  // Post-save adoption is tracked PER FETCHER: a card adopts fresh loader
  // data only when its OWN fetcher returns to idle with a matching, successful
  // intent — concurrent submissions (card save + flag toggle, two card saves,
  // a save overlapping an upload revalidation) can never mis-route adoption.
  useEffect(() => {
    const data = clinicalFetcher.data;
    if (clinicalFetcher.state !== "idle" || !data) return;
    if (data.intent !== "save_clinical" && data.intent !== "delete_clinical") {
      return;
    }
    if (data.ok === false) return;
    adoptClinical();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicalFetcher.state, clinicalFetcher.data]);

  useEffect(() => {
    const data = surveyFetcher.data;
    if (surveyFetcher.state !== "idle" || !data) return;
    if (data.intent !== "save_survey" && data.intent !== "delete_survey") {
      return;
    }
    if (data.ok === false) return;
    adoptSurvey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyFetcher.state, surveyFetcher.data]);

  useEffect(() => {
    const data = baFetcher.data;
    if (baFetcher.state !== "idle" || !data) return;
    if (data.intent !== "save_ba") return;
    if (data.ok === false) return;
    adoptBa();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baFetcher.state, baFetcher.data]);

  useEffect(() => {
    const data = batchFetcher.data;
    if (batchFetcher.state !== "idle" || !data) return;
    if (data.intent !== "save_batch" && data.intent !== "delete_batch") return;
    if (data.ok === false) return;
    adoptBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchFetcher.state, batchFetcher.data]);

  // Background revalidations (uploads, flag toggles elsewhere): refresh only
  // the cards without unsaved edits, and only while no card save/delete is in
  // flight. Forced adoptions (stale-content Reload) always reseed their card.
  useEffect(() => {
    const forced = forceAdoptRef.current;
    forceAdoptRef.current = {
      clinical: false,
      survey: false,
      ba: false,
      batch: false,
    };
    const savePending = cardSavePendingRef.current;
    if (forced.clinical || (!savePending && !dirtyRef.current.clinical)) {
      adoptClinical();
    }
    if (forced.survey || (!savePending && !dirtyRef.current.survey)) {
      adoptSurvey();
    }
    if (forced.ba || (!savePending && !dirtyRef.current.ba)) {
      adoptBa();
    }
    if (forced.batch || (!savePending && !dirtyRef.current.batch)) {
      adoptBatch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boosters]);

  const reloadStaleCard = (card: "clinical" | "survey" | "ba" | "batch") => {
    const data =
      card === "clinical"
        ? clinicalFetcher.data
        : card === "survey"
          ? surveyFetcher.data
          : card === "ba"
            ? baFetcher.data
            : batchFetcher.data;
    setStaleReloaded((previous) => ({ ...previous, [card]: data ?? null }));
    forceAdoptRef.current[card] = true;
    revalidator.revalidate();
  };

  useEffect(() => {
    if (!confirmDelete) return;
    const handle = setTimeout(() => setConfirmDelete(null), 4000);
    return () => clearTimeout(handle);
  }, [confirmDelete]);

  // Toasts per card fetcher.
  useEffect(() => {
    const data = clinicalFetcher.data;
    if (!data) return;
    if (data.intent === "save_clinical") {
      shopify.toast.show(
        data.ok ? "Clinical study saved" : "Could not save the clinical study",
        { isError: !data.ok },
      );
    } else if (data.intent === "delete_clinical") {
      shopify.toast.show(
        data.ok ? "Clinical study removed" : "Could not remove the study",
        { isError: !data.ok },
      );
    }
  }, [clinicalFetcher.data, shopify]);

  useEffect(() => {
    const data = surveyFetcher.data;
    if (!data) return;
    if (data.intent === "save_survey") {
      shopify.toast.show(
        data.ok
          ? "Dermatologist survey saved"
          : "Could not save the dermatologist survey",
        { isError: !data.ok },
      );
    } else if (data.intent === "delete_survey") {
      shopify.toast.show(
        data.ok
          ? "Dermatologist survey removed"
          : "Could not remove the survey",
        { isError: !data.ok },
      );
    }
  }, [surveyFetcher.data, shopify]);

  useEffect(() => {
    const data = baFetcher.data;
    if (!data || data.intent !== "save_ba") return;
    shopify.toast.show(
      data.ok
        ? "Before/after entries saved"
        : "Could not save the before/after entries",
      { isError: !data.ok },
    );
  }, [baFetcher.data, shopify]);

  useEffect(() => {
    const data = batchFetcher.data;
    if (!data) return;
    if (data.intent === "save_batch") {
      shopify.toast.show(
        data.ok ? "Batch transparency saved" : "Could not save batch transparency",
        { isError: !data.ok },
      );
    } else if (data.intent === "delete_batch") {
      shopify.toast.show(
        data.ok
          ? "Batch transparency removed"
          : "Could not remove batch transparency",
        { isError: !data.ok },
      );
    }
  }, [batchFetcher.data, shopify]);

  useEffect(() => {
    const data = flagsFetcher.data;
    if (!data || data.intent !== "save_flags") return;
    if (!data.ok) {
      shopify.toast.show("Could not update the booster visibility", {
        isError: true,
      });
    }
  }, [flagsFetcher.data, shopify]);

  useEffect(() => {
    const data = translateFetcher.data;
    if (!data || data.intent !== "translate_boosters") return;
    const done =
      data.summary?.locales.filter((l) => l.status === "done").length ?? 0;
    shopify.toast.show(
      data.ok
        ? `Booster content translated into ${done} ${done === 1 ? "language" : "languages"}`
        : "Translation did not complete — see the Translations card",
      { isError: !data.ok },
    );
  }, [translateFetcher.data, shopify]);

  // ------- flags (derived from the loader, optimistic while submitting) ----
  const pendingFlagKey =
    flagsFetcher.state !== "idle" && flagsFetcher.formData
      ? flagsFetcher.formData.get("key")
      : null;
  const pendingFlagValue =
    flagsFetcher.state !== "idle" && flagsFetcher.formData
      ? flagsFetcher.formData.get("value") === "true"
      : null;

  const flagChecked = (key: PdpFlagKey): boolean =>
    pendingFlagKey === key && pendingFlagValue !== null
      ? pendingFlagValue
      : boosters.flags[key];

  const toggleFlag = (key: PdpFlagKey, checked: boolean) => {
    flagsFetcher.submit(
      { intent: "save_flags", key, value: String(checked) },
      { method: "post" },
    );
  };

  // Container override Select (optimistic while its submission is in flight).
  // "inherit" = no per-product override — the flags json carries no
  // `container` key and the global default applies.
  const pendingContainer =
    pendingFlagKey === "container" && flagsFetcher.formData
      ? String(flagsFetcher.formData.get("value") ?? "")
      : null;
  const containerValue =
    pendingContainer ?? boosters.flags.container ?? "inherit";

  const setContainer = (value: string) => {
    flagsFetcher.submit(
      { intent: "save_flags", key: "container", value },
      { method: "post" },
    );
  };

  // ------- Amazon data (v6.1: bought count, bestseller, FBT override) ------
  const initialAmazon = useMemo<AmazonEditState>(
    () => ({
      boughtCount:
        boosters.flags.boughtCount === undefined
          ? ""
          : String(boosters.flags.boughtCount),
      rank:
        boosters.flags.bestsellerLabel === undefined
          ? ""
          : String(boosters.flags.bestsellerLabel.rank),
      category: boosters.flags.bestsellerLabel?.category ?? "",
      fbt: (boosters.flags.fbtManual ?? []).map((item) => ({
        variantId: item.variantId,
        handle: item.handle,
        label:
          fbtVariants.find((variant) => variant.id === item.variantId)
            ?.productTitle ?? item.handle,
      })),
    }),
    [boosters, fbtVariants],
  );
  const [amazonState, setAmazonState] = useState<AmazonEditState>(
    initialAmazon,
  );
  const amazonDirty =
    JSON.stringify(amazonProjection(amazonState)) !==
    JSON.stringify(amazonProjection(initialAmazon));
  const amazonDirtyRef = useRef(amazonDirty);
  amazonDirtyRef.current = amazonDirty;
  // Adopt fresh loader data whenever the card has no unsaved edits — after a
  // successful save the local edits EQUAL the new initial, so this also
  // clears the dirty state (and picks up the freshly stamped set-date).
  useEffect(() => {
    if (!amazonDirtyRef.current) setAmazonState(initialAmazon);
  }, [initialAmazon]);

  useEffect(() => {
    const data = amazonFetcher.data;
    if (!data || data.intent !== "save_amazon") return;
    shopify.toast.show(
      data.ok
        ? "Amazon data saved"
        : (data.errors[0] ?? "Could not save the Amazon data"),
      { isError: !data.ok },
    );
  }, [amazonFetcher.data, shopify]);

  const amazonErrors = validateAmazonEdit(amazonState);
  const amazonHasErrors =
    amazonErrors.boughtCountError !== undefined ||
    amazonErrors.bestsellerError !== undefined;

  const saveAmazon = () => {
    // Only CHANGED groups go in the payload — an unchanged bought count is
    // never re-sent, so its freshness date is never restamped accidentally.
    const payload: Record<string, unknown> = {};
    if (amazonState.boughtCount.trim() !== initialAmazon.boughtCount.trim()) {
      const trimmed = amazonState.boughtCount.trim();
      payload.boughtCount = trimmed === "" ? null : Number(trimmed);
    }
    if (
      amazonState.rank.trim() !== initialAmazon.rank.trim() ||
      amazonState.category.trim() !== initialAmazon.category.trim()
    ) {
      payload.bestsellerLabel =
        amazonState.rank.trim() === "" && amazonState.category.trim() === ""
          ? null
          : {
              rank: Number(amazonState.rank.trim()),
              category: amazonState.category.trim(),
            };
    }
    if (
      JSON.stringify(amazonState.fbt.map((item) => item.variantId)) !==
      JSON.stringify(initialAmazon.fbt.map((item) => item.variantId))
    ) {
      payload.fbtManual = amazonState.fbt.map((item) => ({
        variantId: item.variantId,
        handle: item.handle,
      }));
    }
    // Feeds the autoOnSave hook: only a SET label (rank + category) makes
    // this save worth an auto-translate run of the category metafield.
    amazonSaveSetLabelRef.current =
      payload.bestsellerLabel !== undefined && payload.bestsellerLabel !== null;
    amazonFetcher.submit(
      { intent: "save_amazon", payload: JSON.stringify(payload) },
      { method: "post" },
    );
  };

  // FBT variant search (same resource route as the cart cross-sell picker).
  const fbtSearch = useFetcher<typeof variantsLoader>();
  const loadFbtVariants = fbtSearch.load;
  const [fbtQuery, setFbtQuery] = useState("");
  const lastFbtQueryRef = useRef("");
  useEffect(() => {
    const trimmed = fbtQuery.trim();
    if (trimmed === "" || trimmed === lastFbtQueryRef.current) return;
    const handle = setTimeout(() => {
      lastFbtQueryRef.current = trimmed;
      loadFbtVariants(`/app/api/variants?q=${encodeURIComponent(trimmed)}`);
    }, 350);
    return () => clearTimeout(handle);
  }, [fbtQuery, loadFbtVariants]);
  const fbtSearchResults = fbtSearch.data?.variants ?? [];

  const boughtCountStale =
    boosters.flags.boughtCount !== undefined &&
    (boughtCountAgeDays === null || boughtCountAgeDays > AZ_STALE_DAYS);

  if (!boosters.product) {
    return (
      <Page
        title="Product boosters"
        backAction={{ content: "Product boosters", url: "/app/products" }}
      >
        <TitleBar title="Product boosters" />
        <Layout>
          <Layout.Section>
            <Banner tone="critical" title="Could not load this product">
              <BlockStack gap="100">
                {(boosters.errors.length
                  ? boosters.errors
                  : ["The product may have been deleted."]
                ).map((error) => (
                  <Text as="p" key={error}>
                    {error}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          </Layout.Section>
          <Layout.Section>
            <Button url="/app/products">Back to Product boosters</Button>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const product = boosters.product;

  const translateResult =
    translateFetcher.data?.intent === "translate_boosters"
      ? translateFetcher.data
      : null;
  const translateLocaleErrors = [
    ...new Set(
      (translateResult?.summary?.locales ?? [])
        .filter((entry) => entry.status === "error" && entry.error)
        .map((entry) => `${entry.locale}: ${entry.error}`),
    ),
  ];

  const savingClinical = clinicalFetcher.state !== "idle";
  const savingSurvey = surveyFetcher.state !== "idle";
  const savingBa = baFetcher.state !== "idle";
  const savingBatch = batchFetcher.state !== "idle";
  const clinicalPendingIntent =
    savingClinical && clinicalFetcher.formData
      ? clinicalFetcher.formData.get("intent")
      : null;
  const surveyPendingIntent =
    savingSurvey && surveyFetcher.formData
      ? surveyFetcher.formData.get("intent")
      : null;
  const batchPendingIntent =
    savingBatch && batchFetcher.formData
      ? batchFetcher.formData.get("intent")
      : null;

  // ------------------------------- clinical -------------------------------
  const clinicalConfigured = Boolean(boosters.clinicalStudy);

  const setClinicalField = (patch: Partial<ClinicalFormState>) =>
    setClinicalState((previous) => ({ ...previous, ...patch }));

  const setResult = (index: number, patch: Partial<StudyResultState>) =>
    setClinicalState((previous) => ({
      ...previous,
      results: previous.results.map((result, i) =>
        i === index ? { ...result, ...patch } : result,
      ),
    }));

  const addResult = () =>
    setClinicalState((previous) => ({
      ...previous,
      results: [
        ...previous.results,
        { id: null, value: "", suffix: "%", label: "" },
      ],
    }));

  const removeResult = (index: number) =>
    setClinicalState((previous) => ({
      ...previous,
      results: previous.results.filter((_, i) => i !== index),
    }));

  const moveResult = (index: number, direction: -1 | 1) =>
    setClinicalState((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.results.length) return previous;
      const next = [...previous.results];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return { ...previous, results: next };
    });

  const saveClinical = () => {
    const durationWeeks = parseNumericInput(clinicalState.durationWeeks);
    const sampleSize = parseNumericInput(clinicalState.sampleSize);
    const resultValues = clinicalState.results.map((result) =>
      parseNumericInput(result.value),
    );
    if (
      durationWeeks === null ||
      sampleSize === null ||
      resultValues.some((value) => value === null)
    ) {
      return; // Save is disabled while invalid — never submit a fabricated 0.
    }
    const payload = {
      title: clinicalState.title,
      subject: clinicalState.subject,
      concern: clinicalState.concern,
      durationWeeks,
      sampleSize,
      labName: clinicalState.labName,
      instruments: clinicalState.instruments,
      studyUrl: clinicalState.studyUrl.trim(),
      footnote: clinicalState.footnote,
      results: clinicalState.results.map((result, index) => ({
        id: result.id,
        value: resultValues[index] as number,
        suffix: result.suffix,
        label: result.label,
      })),
    };
    clinicalFetcher.submit(
      {
        intent: "save_clinical",
        payload: JSON.stringify(payload),
        knownIds: JSON.stringify(clinicalSeedIdsRef.current),
      },
      { method: "post" },
    );
  };

  const deleteClinical = () => {
    if (confirmDelete !== "clinical") {
      setConfirmDelete("clinical");
      return;
    }
    setConfirmDelete(null);
    clinicalFetcher.submit({ intent: "delete_clinical" }, { method: "post" });
  };

  const clinicalStudyUrlInvalid =
    clinicalState.studyUrl.trim() !== "" &&
    !/^https?:\/\/\S+$/.test(clinicalState.studyUrl.trim());
  const clinicalDurationError = numericError(clinicalState.durationWeeks, {
    integer: true,
    min: 0,
  });
  const clinicalSampleSizeError = numericError(clinicalState.sampleSize, {
    integer: true,
    min: 0,
  });
  const clinicalNumbersInvalid =
    Boolean(clinicalDurationError || clinicalSampleSizeError) ||
    clinicalState.results.some((result) => numericError(result.value));

  // ---------------------------- survey (v7) --------------------------------
  const surveyConfigured = Boolean(boosters.productSurvey);

  const setSurveyField = (patch: Partial<SurveyFormState>) =>
    setSurveyState((previous) => ({ ...previous, ...patch }));

  const setOutcome = (index: number, patch: Partial<SurveyOutcomeState>) =>
    setSurveyState((previous) => ({
      ...previous,
      outcomes: previous.outcomes.map((outcome, i) =>
        i === index ? { ...outcome, ...patch } : outcome,
      ),
    }));

  const addOutcome = () =>
    setSurveyState((previous) => ({
      ...previous,
      outcomes: [
        ...previous.outcomes,
        { key: nextKey(), id: null, statement: "", yesCount: "" },
      ],
    }));

  const removeOutcome = (index: number) =>
    setSurveyState((previous) => ({
      ...previous,
      outcomes: previous.outcomes.filter((_, i) => i !== index),
    }));

  const moveOutcome = (index: number, direction: -1 | 1) =>
    setSurveyState((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.outcomes.length) return previous;
      const next = [...previous.outcomes];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return { ...previous, outcomes: next };
    });

  const saveSurvey = () => {
    const sampleSize = parseNumericInput(surveyState.sampleSize);
    // Blank = deliberately no "would recommend" headline — submitted as null,
    // NEVER as a fabricated 0.
    const recommendYes =
      surveyState.recommendYes.trim() === ""
        ? null
        : parseNumericInput(surveyState.recommendYes);
    const outcomeYesValues = surveyState.outcomes.map((outcome) =>
      parseNumericInput(outcome.yesCount),
    );
    if (
      sampleSize === null ||
      (surveyState.recommendYes.trim() !== "" && recommendYes === null) ||
      outcomeYesValues.some((value) => value === null)
    ) {
      return; // Save is disabled while invalid — never submit a fabricated 0.
    }
    const payload = {
      title: surveyState.title,
      sampleSize,
      recommendYes,
      question: surveyState.question,
      intro: surveyState.intro,
      methodology: surveyState.methodology,
      verifierName: surveyState.verifierName,
      verificationUrl: surveyState.verificationUrl.trim(),
      outcomes: surveyState.outcomes.map((outcome, index) => ({
        id: outcome.id,
        statement: outcome.statement,
        yesCount: outcomeYesValues[index] as number,
      })),
    };
    surveyFetcher.submit(
      {
        intent: "save_survey",
        payload: JSON.stringify(payload),
        knownIds: JSON.stringify(surveySeedIdsRef.current),
      },
      { method: "post" },
    );
  };

  const deleteSurvey = () => {
    if (confirmDelete !== "survey") {
      setConfirmDelete("survey");
      return;
    }
    setConfirmDelete(null);
    surveyFetcher.submit({ intent: "delete_survey" }, { method: "post" });
  };

  const surveySampleValue = parseNumericInput(surveyState.sampleSize);
  const surveyRecommendValue = parseNumericInput(surveyState.recommendYes);
  const surveySampleError = numericError(surveyState.sampleSize, {
    integer: true,
    min: 1,
  });
  // Optional field: only validate when something was entered; the server
  // rejects a recommend count above the sample size, so mirror that here.
  const surveyRecommendError =
    surveyState.recommendYes.trim() === ""
      ? undefined
      : (numericError(surveyState.recommendYes, { integer: true, min: 0 }) ??
        (surveySampleValue !== null &&
        surveyRecommendValue !== null &&
        surveyRecommendValue > surveySampleValue
          ? "Cannot exceed the surveyed count"
          : undefined));
  const surveyUrlTrimmed = surveyState.verificationUrl.trim();
  const surveyUrlInvalid =
    surveyUrlTrimmed !== "" && !surveyUrlTrimmed.startsWith("https://");
  const surveyStatementMissing = surveyState.outcomes.some(
    (outcome) => outcome.statement.trim() === "",
  );
  const surveyNumbersInvalid =
    Boolean(surveySampleError || surveyRecommendError) ||
    surveyState.outcomes.some((outcome) =>
      numericError(outcome.yesCount, { integer: true, min: 0 }),
    );
  // Storefront fail-closed mirror: the widget renders only with a sample size
  // and at least one visible outcome (0 < agree <= sample) OR a valid
  // recommend count. Out-of-range rows are dropped, never shown.
  const surveyValidOutcomeCount = surveyState.outcomes.filter((outcome) => {
    const yes = parseNumericInput(outcome.yesCount);
    return (
      surveySampleValue !== null &&
      yes !== null &&
      yes > 0 &&
      yes <= surveySampleValue
    );
  }).length;
  const surveyRecommendVisible =
    surveySampleValue !== null &&
    surveyRecommendValue !== null &&
    surveyRecommendValue > 0 &&
    surveyRecommendValue <= surveySampleValue;
  const surveyWouldHide =
    (surveyConfigured || surveyDirty) &&
    surveyValidOutcomeCount === 0 &&
    !surveyRecommendVisible;
  const surveyRecommendPct = surveyRecommendVisible
    ? Math.round(
        ((surveyRecommendValue as number) / (surveySampleValue as number)) *
          100,
      )
    : null;

  // ---------------------------- before/afters -----------------------------
  const setBaEntry = (index: number, patch: Partial<BaEntryState>) =>
    setBaEntries((previous) =>
      previous.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );

  const addBaEntry = () =>
    setBaEntries((previous) => [
      ...previous,
      {
        key: nextKey(),
        id: null,
        beforeImageGid: "",
        beforePreviewUrl: null,
        afterImageGid: "",
        afterPreviewUrl: null,
        beforeDate: "",
        afterDate: "",
        weeks: "",
        clinic: "",
        imaging: "VISIA",
        verifierName: "",
        verifierLicense: "",
        statement: "",
        verificationUrl: "",
      },
    ]);

  const removeBaEntry = (index: number) =>
    setBaEntries((previous) => previous.filter((_, i) => i !== index));

  const moveBaEntry = (index: number, direction: -1 | 1) =>
    setBaEntries((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });

  const baMissingImages = baEntries.some(
    (entry) => !entry.beforeImageGid || !entry.afterImageGid,
  );
  const baWeeksInvalid = baEntries.some((entry) =>
    numericError(entry.weeks, { integer: true, min: 0 }),
  );

  const saveBa = () => {
    const weekValues = baEntries.map((entry) => parseNumericInput(entry.weeks));
    if (weekValues.some((value) => value === null)) {
      return; // Save is disabled while invalid — never submit a fabricated 0.
    }
    const payload = baEntries.map((entry, index) => ({
      id: entry.id,
      beforeImageGid: entry.beforeImageGid,
      afterImageGid: entry.afterImageGid,
      beforeDate: entry.beforeDate,
      afterDate: entry.afterDate,
      weeks: weekValues[index] as number,
      clinic: entry.clinic,
      imaging: entry.imaging,
      verifierName: entry.verifierName,
      verifierLicense: entry.verifierLicense,
      statement: entry.statement,
      verificationUrl: entry.verificationUrl.trim(),
    }));
    baFetcher.submit(
      {
        intent: "save_ba",
        payload: JSON.stringify(payload),
        knownIds: JSON.stringify(baSeedIdsRef.current),
      },
      { method: "post" },
    );
  };

  // -------------------------------- batch ---------------------------------
  const batchConfigured = Boolean(boosters.batchTransparency);

  const setIngredient = (index: number, patch: Partial<IngredientState>) =>
    setBatchState((previous) => ({
      ...previous,
      ingredients: previous.ingredients.map((entry, i) =>
        i === index ? { ...entry, ...patch } : entry,
      ),
    }));

  const addIngredient = () =>
    setBatchState((previous) => ({
      ...previous,
      ingredients: [
        ...previous.ingredients,
        { key: nextKey(), id: null, name: "", concentration: "", form: "", note: "" },
      ],
    }));

  const removeIngredient = (index: number) =>
    setBatchState((previous) => ({
      ...previous,
      ingredients: previous.ingredients.filter((_, i) => i !== index),
    }));

  const setCertificate = (index: number, patch: Partial<CertificateState>) =>
    setBatchState((previous) => ({
      ...previous,
      certificates: previous.certificates.map((entry, i) =>
        i === index ? { ...entry, ...patch } : entry,
      ),
    }));

  const addCertificate = () =>
    setBatchState((previous) => ({
      ...previous,
      certificates: [
        ...previous.certificates,
        {
          key: nextKey(),
          id: null,
          batch: "",
          issued: "",
          lab: "",
          documentUrl: "",
          documentGid: "",
          documentFileUrl: null,
        },
      ],
    }));

  const removeCertificate = (index: number) =>
    setBatchState((previous) => ({
      ...previous,
      certificates: previous.certificates.filter((_, i) => i !== index),
    }));

  const batchIngredientInvalid = batchState.ingredients.some(
    (entry) => entry.name.trim() === "",
  );
  const batchConcentrationInvalid = batchState.ingredients.some((entry) =>
    numericError(entry.concentration, { min: 0 }),
  );

  const saveBatch = () => {
    const concentrations = batchState.ingredients.map((entry) =>
      parseNumericInput(entry.concentration),
    );
    if (concentrations.some((value) => value === null)) {
      return; // Save is disabled while invalid — never submit a fabricated 0.
    }
    const payload = {
      intro: batchState.intro,
      ingredients: batchState.ingredients.map((entry, index) => ({
        id: entry.id,
        name: entry.name,
        concentration: concentrations[index] as number,
        form: entry.form,
        note: entry.note,
      })),
      certificates: batchState.certificates.map((entry) => ({
        id: entry.id,
        batch: entry.batch,
        issued: entry.issued,
        lab: entry.lab,
        documentUrl: entry.documentUrl.trim(),
        documentGid: entry.documentGid || null,
      })),
    };
    batchFetcher.submit(
      {
        intent: "save_batch",
        payload: JSON.stringify(payload),
        knownIds: JSON.stringify(batchSeedIdsRef.current),
      },
      { method: "post" },
    );
  };

  const deleteBatch = () => {
    if (confirmDelete !== "batch") {
      setConfirmDelete("batch");
      return;
    }
    setConfirmDelete(null);
    batchFetcher.submit({ intent: "delete_batch" }, { method: "post" });
  };

  const cardErrors = (
    data: ProductBoosterActionResult | undefined,
    intents: string[],
  ): string[] =>
    data && intents.includes(data.intent) && !data.ok
      ? // The stale-content error renders as its own dedicated warning banner.
        data.errors.filter((error) => error !== STALE_CONTENT_MESSAGE)
      : [];

  const clinicalStale =
    isStaleResult(clinicalFetcher.data, ["save_clinical"]) &&
    staleReloaded.clinical !== clinicalFetcher.data;
  const surveyStale =
    isStaleResult(surveyFetcher.data, ["save_survey"]) &&
    staleReloaded.survey !== surveyFetcher.data;
  const baStale =
    isStaleResult(baFetcher.data, ["save_ba"]) &&
    staleReloaded.ba !== baFetcher.data;
  const batchStale =
    isStaleResult(batchFetcher.data, ["save_batch"]) &&
    staleReloaded.batch !== batchFetcher.data;

  return (
    <Page
      title={product.title}
      subtitle={`Product boosters · ${product.handle}`}
      backAction={{ content: "Product boosters", url: "/app/products" }}
    >
      <TitleBar title="Product boosters" />
      <Layout>
        {definitionErrors.length > 0 ? (
          <Layout.Section>
            <Banner
              tone="critical"
              title="Could not prepare the booster content model"
            >
              <BlockStack gap="100">
                <Text as="p">
                  Some Shopify metaobject or metafield definitions could not be
                  created — saving below may fail. Reload the page to retry.
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

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Translations
                </Text>
                {translation.configured ? (
                  <Badge tone="success">Auto-translation on</Badge>
                ) : (
                  <Badge tone="attention">Manual only</Badge>
                )}
              </InlineStack>
              {translation.configured ? (
                <BlockStack gap="300">
                  <Text as="p" tone="subdued">
                    {translation.autoOnSave
                      ? "Every save on this page is translated into all published shop languages automatically. You can also re-run it any time:"
                      : "Auto-translate on save is turned off — run it manually after editing:"}
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Button
                      onClick={runTranslate}
                      loading={translating}
                      disabled={translation.targetCount === 0}
                    >
                      {`Translate into all languages (${translation.targetCount})`}
                    </Button>
                    <Button url="/app/localization" variant="plain">
                      Translation settings
                    </Button>
                  </InlineStack>
                  {translation.targetCount === 0 ? (
                    <Text as="p" tone="subdued">
                      The shop has no published extra languages yet — add them
                      in Shopify Settings → Languages.
                    </Text>
                  ) : null}
                  {translateResult ? (
                    <BlockStack gap="200">
                      {translateResult.errors.map((error) => (
                        <Text as="p" tone="critical" key={error}>
                          {error}
                        </Text>
                      ))}
                      {translateResult.summary ? (
                        <InlineStack gap="100" wrap>
                          {translateResult.summary.locales.map((entry) => (
                            <Badge
                              key={entry.locale}
                              tone={
                                entry.status === "done"
                                  ? "success"
                                  : entry.status === "error"
                                    ? "critical"
                                    : undefined
                              }
                            >
                              {entry.status === "done"
                                ? `${entry.locale} ✓`
                                : entry.status === "unsupported"
                                  ? `${entry.locale} — not supported`
                                  : entry.status === "skipped"
                                    ? `${entry.locale} — same language`
                                    : `${entry.locale} ✕`}
                            </Badge>
                          ))}
                        </InlineStack>
                      ) : null}
                      {translateLocaleErrors.length > 0 ? (
                        <BlockStack gap="100">
                          {translateLocaleErrors.map((message) => (
                            <Text
                              as="p"
                              tone="critical"
                              variant="bodySm"
                              key={message}
                            >
                              {message}
                            </Text>
                          ))}
                        </BlockStack>
                      ) : null}
                    </BlockStack>
                  ) : null}
                  <Text as="p" tone="subdued" variant="bodySm">
                    Lab and clinic names, verifier names and licenses, INCI
                    ingredient names, batch codes, dates and URLs are never
                    machine-translated. Review or override any translation in
                    Translate &amp; Adapt (Content → Metaobjects) — existing
                    translations, including your manual edits, are never
                    overwritten; a field is only re-translated after you
                    change its source text here.
                  </Text>
                </BlockStack>
              ) : (
                <BlockStack gap="300">
                  <Text as="p" tone="subdued">
                    The content you write here is stored per product, so
                    shoppers in other languages see your primary language
                    until it is translated. Connect a free DeepL API key once
                    and the app translates everything you save here into all
                    published shop languages automatically.
                  </Text>
                  <InlineStack gap="200">
                    <Button url="/app/localization" variant="primary">
                      Set up auto-translation
                    </Button>
                    <Button url={metaobjectsUrl} target="_blank" variant="plain">
                      Translate manually (Content → Metaobjects)
                    </Button>
                  </InlineStack>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="400">
            {/* ------------------------ Clinical study ------------------- */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Independent clinical study
                  </Text>
                  <Badge tone={clinicalConfigured ? "success" : undefined}>
                    {clinicalConfigured ? "Configured" : "Not configured"}
                  </Badge>
                  {!globalFlags.clinical_study ? (
                    <Badge tone="attention">Global switch off</Badge>
                  ) : null}
                </InlineStack>
                {clinicalStale ? (
                  <Banner tone="warning" title="Content changed elsewhere">
                    <BlockStack gap="200">
                      <Text as="p">
                        This content changed since you loaded the page (another
                        tab or teammate). Reload to see the latest before
                        saving.
                      </Text>
                      <InlineStack>
                        <Button
                          onClick={() => reloadStaleCard("clinical")}
                          loading={revalidator.state !== "idle"}
                        >
                          Reload
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Banner>
                ) : null}
                {cardErrors(clinicalFetcher.data, [
                  "save_clinical",
                  "delete_clinical",
                ]).length > 0 ? (
                  <Banner tone="critical" title="Clinical study not saved">
                    <BlockStack gap="100">
                      {cardErrors(clinicalFetcher.data, [
                        "save_clinical",
                        "delete_clinical",
                      ]).map((error) => (
                        <Text as="p" key={error}>
                          {error}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                ) : null}
                <Checkbox
                  label="Show the clinical study on this product"
                  helpText="Per-product opt-out. The global switch, market scope and saved content still gate the widget."
                  checked={flagChecked("clinical_study")}
                  onChange={(checked) => toggleFlag("clinical_study", checked)}
                  disabled={flagsFetcher.state !== "idle"}
                />
                <Divider />
                <InlineStack gap="300" wrap>
                  <Box minWidth="280px">
                    <TextField
                      label="Study title"
                      value={clinicalState.title}
                      onChange={(title) => setClinicalField({ title })}
                      disabled={savingClinical}
                      helpText="Internal display name, e.g. “8-week wrinkle depth study”."
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="240px">
                    <TextField
                      label="Concern"
                      value={clinicalState.concern}
                      onChange={(concern) => setClinicalField({ concern })}
                      disabled={savingClinical}
                      helpText="e.g. “Wrinkle depth”"
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
                <TextField
                  label="Study subject"
                  value={clinicalState.subject}
                  onChange={(subject) => setClinicalField({ subject })}
                  disabled={savingClinical}
                  helpText="Replaces the ENTIRE “Tested on … itself — the exact formula on this page.” line under the eyebrow, word for word. Leave empty for the built-in line with the product title. Plain language wins with skeptical shoppers."
                  autoComplete="off"
                />
                <Text as="p" tone="subdued" variant="bodySm">
                  The four fields below become small fact chips on the
                  product page (“34 participants · 8-week study · …”). Each
                  chip only appears when its field is filled — leave any that
                  don’t apply empty and no chip shows.
                </Text>
                <InlineStack gap="300" wrap>
                  <Box width="170px">
                    <TextField
                      label="Duration (weeks)"
                      type="number"
                      min={0}
                      value={clinicalState.durationWeeks}
                      onChange={(durationWeeks) =>
                        setClinicalField({ durationWeeks })
                      }
                      disabled={savingClinical}
                      error={clinicalDurationError}
                      helpText="Empty = no chip."
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="170px">
                    <TextField
                      label="Sample size (n)"
                      type="number"
                      min={0}
                      value={clinicalState.sampleSize}
                      onChange={(sampleSize) =>
                        setClinicalField({ sampleSize })
                      }
                      disabled={savingClinical}
                      error={clinicalSampleSizeError}
                      helpText="e.g. 112. Empty = no chip."
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="260px">
                    <TextField
                      label="Lab name"
                      value={clinicalState.labName}
                      onChange={(labName) => setClinicalField({ labName })}
                      disabled={savingClinical}
                      helpText="The independent lab that ran the study. Empty = no chip."
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
                <InlineStack gap="300" wrap>
                  <Box minWidth="280px">
                    <TextField
                      label="Instruments"
                      value={clinicalState.instruments}
                      onChange={(instruments) =>
                        setClinicalField({ instruments })
                      }
                      disabled={savingClinical}
                      helpText="Shown to shoppers as “Measured with …” — plain words beat lab jargon (e.g. “skin-firmness meter” rather than a bare model number). Empty = no chip."
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="280px">
                    <TextField
                      label="Study summary URL"
                      value={clinicalState.studyUrl}
                      onChange={(studyUrl) => setClinicalField({ studyUrl })}
                      placeholder="https://…"
                      disabled={savingClinical}
                      error={
                        clinicalStudyUrlInvalid
                          ? "Must be an http(s) URL"
                          : undefined
                      }
                      helpText="“View study summary” link. Leave empty to hide it."
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>

                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Results
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    The first result renders as the huge headline number;
                    the rest appear in the results grid. Move a result up or
                    down to reorder — the first row is the headline stat.
                    Up to {MAX_RESULTS}.
                  </Text>
                  {clinicalState.results.map((result, index) => (
                    <InlineStack
                      key={result.id ?? `new-result-${index}`}
                      gap="200"
                      blockAlign="end"
                      wrap
                    >
                      <Box width="130px">
                        <TextField
                          label={index === 0 ? "Value (headline)" : "Value"}
                          type="number"
                          value={result.value}
                          onChange={(value) => setResult(index, { value })}
                          disabled={savingClinical}
                          error={numericError(result.value)}
                          autoComplete="off"
                        />
                      </Box>
                      <Box width="110px">
                        <TextField
                          label="Suffix"
                          value={result.suffix}
                          maxLength={8}
                          onChange={(suffix) => setResult(index, { suffix })}
                          disabled={savingClinical}
                          helpText="e.g. %"
                          autoComplete="off"
                        />
                      </Box>
                      <Box minWidth="260px">
                        <TextField
                          label="Label"
                          value={result.label}
                          onChange={(label) => setResult(index, { label })}
                          disabled={savingClinical}
                          helpText="e.g. “reduction in wrinkle depth”"
                          autoComplete="off"
                        />
                      </Box>
                      <InlineStack gap="100">
                        <Button
                          size="slim"
                          icon={ArrowUpIcon}
                          accessibilityLabel={`Move result ${index + 1} up`}
                          onClick={() => moveResult(index, -1)}
                          disabled={savingClinical || index === 0}
                        />
                        <Button
                          size="slim"
                          icon={ArrowDownIcon}
                          accessibilityLabel={`Move result ${index + 1} down`}
                          onClick={() => moveResult(index, 1)}
                          disabled={
                            savingClinical ||
                            index === clinicalState.results.length - 1
                          }
                        />
                        <Button
                          size="slim"
                          icon={DeleteIcon}
                          tone="critical"
                          accessibilityLabel={`Remove result ${index + 1}`}
                          onClick={() => removeResult(index)}
                          disabled={savingClinical}
                        />
                      </InlineStack>
                    </InlineStack>
                  ))}
                  <InlineStack>
                    <Button
                      onClick={addResult}
                      disabled={
                        savingClinical ||
                        clinicalState.results.length >= MAX_RESULTS
                      }
                    >
                      Add result
                    </Button>
                  </InlineStack>
                </BlockStack>

                <TextField
                  label="Footnote"
                  value={clinicalState.footnote}
                  onChange={(footnote) => setClinicalField({ footnote })}
                  multiline={2}
                  disabled={savingClinical}
                  helpText="Methodology small print, e.g. “Measured under dermatological control. Individual results may vary.”"
                  autoComplete="off"
                />

                <InlineStack gap="200" align="end">
                  {clinicalConfigured ? (
                    <Button
                      tone="critical"
                      variant="secondary"
                      onClick={deleteClinical}
                      loading={clinicalPendingIntent === "delete_clinical"}
                      disabled={savingClinical}
                    >
                      {confirmDelete === "clinical"
                        ? "Click again to remove"
                        : "Remove study"}
                    </Button>
                  ) : null}
                  <Button
                    variant="primary"
                    onClick={saveClinical}
                    loading={clinicalPendingIntent === "save_clinical"}
                    disabled={
                      savingClinical ||
                      !clinicalDirty ||
                      clinicalStudyUrlInvalid ||
                      clinicalNumbersInvalid
                    }
                  >
                    Save clinical study
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* --------------------- Verified before/after ---------------- */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Verified before/after
                  </Text>
                  <Badge
                    tone={boosters.beforeAfters.length > 0 ? "success" : undefined}
                  >
                    {boosters.beforeAfters.length > 0
                      ? `${boosters.beforeAfters.length} ${
                          boosters.beforeAfters.length === 1
                            ? "entry"
                            : "entries"
                        }`
                      : "Not configured"}
                  </Badge>
                  {!globalFlags.verified_before_after ? (
                    <Badge tone="attention">Global switch off</Badge>
                  ) : null}
                </InlineStack>
                <Banner tone="info">
                  <Text as="p">
                    Legacy content since v8 — these entries are no longer
                    rendered on the product page directly. The Results gallery
                    (Proof library) replaced the widget; use{" "}
                    <Link url="/app/proof/results">
                      Proof library → Import legacy before/afters
                    </Link>{" "}
                    to carry these entries over. They remain editable here as
                    the import source.
                  </Text>
                </Banner>
                <Text as="p" tone="subdued" variant="bodySm">
                  One verified before/after beats twenty unverified ones — use
                  unretouched images with real dates and a named verifier.
                </Text>
                {baStale ? (
                  <Banner tone="warning" title="Content changed elsewhere">
                    <BlockStack gap="200">
                      <Text as="p">
                        This content changed since you loaded the page (another
                        tab or teammate). Reload to see the latest before
                        saving.
                      </Text>
                      <InlineStack>
                        <Button
                          onClick={() => reloadStaleCard("ba")}
                          loading={revalidator.state !== "idle"}
                        >
                          Reload
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Banner>
                ) : null}
                {cardErrors(baFetcher.data, ["save_ba"]).length > 0 ? (
                  <Banner
                    tone="critical"
                    title="Before/after entries not saved"
                  >
                    <BlockStack gap="100">
                      {cardErrors(baFetcher.data, ["save_ba"]).map((error) => (
                        <Text as="p" key={error}>
                          {error}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                ) : null}
                <Checkbox
                  label="Show the results gallery on this product"
                  helpText="Per-product opt-out for the results gallery widget in the proof-library embed (the feature key these legacy entries shared). The global switch and market scope still apply."
                  checked={flagChecked("verified_before_after")}
                  onChange={(checked) =>
                    toggleFlag("verified_before_after", checked)
                  }
                  disabled={flagsFetcher.state !== "idle"}
                />
                <Divider />
                {baEntries.map((entry, index) => (
                  <BeforeAfterEntryEditor
                    key={entry.key}
                    entry={entry}
                    index={index}
                    total={baEntries.length}
                    disabled={savingBa}
                    onChange={(patch) => setBaEntry(index, patch)}
                    onRemove={() => removeBaEntry(index)}
                    onMove={(direction) => moveBaEntry(index, direction)}
                  />
                ))}
                {baEntries.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No legacy entries. New results are added directly under
                    Proof library → Results.
                  </Text>
                ) : null}
                {initialBa.length > 0 && baEntries.length === 0 ? (
                  <Banner tone="warning">
                    <Text as="p">
                      Saving now deletes this product’s legacy before/after
                      entries. Results already imported into the gallery are
                      not affected.
                    </Text>
                  </Banner>
                ) : null}
                <InlineStack gap="200" align="space-between" blockAlign="center">
                  <Button
                    onClick={addBaEntry}
                    disabled={savingBa || baEntries.length >= MAX_BA_ENTRIES}
                  >
                    Add entry
                  </Button>
                  <Button
                    variant="primary"
                    onClick={saveBa}
                    loading={savingBa}
                    disabled={
                      savingBa || !baDirty || baMissingImages || baWeeksInvalid
                    }
                  >
                    Save before/afters
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ------------------------ Batch transparency ---------------- */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Batch transparency
                  </Text>
                  <Badge tone={batchConfigured ? "success" : undefined}>
                    {batchConfigured ? "Configured" : "Not configured"}
                  </Badge>
                  {!globalFlags.batch_transparency ? (
                    <Badge tone="attention">Global switch off</Badge>
                  ) : null}
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Exact concentrations and published certificates of analysis.
                  “Every batch is independently tested and published. Judge for
                  yourself.”
                </Text>
                {batchStale ? (
                  <Banner tone="warning" title="Content changed elsewhere">
                    <BlockStack gap="200">
                      <Text as="p">
                        This content changed since you loaded the page (another
                        tab or teammate). Reload to see the latest before
                        saving.
                      </Text>
                      <InlineStack>
                        <Button
                          onClick={() => reloadStaleCard("batch")}
                          loading={revalidator.state !== "idle"}
                        >
                          Reload
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Banner>
                ) : null}
                {cardErrors(batchFetcher.data, ["save_batch", "delete_batch"])
                  .length > 0 ? (
                  <Banner tone="critical" title="Batch transparency not saved">
                    <BlockStack gap="100">
                      {cardErrors(batchFetcher.data, [
                        "save_batch",
                        "delete_batch",
                      ]).map((error) => (
                        <Text as="p" key={error}>
                          {error}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                ) : null}
                <Checkbox
                  label="Show batch transparency on this product"
                  helpText="Per-product opt-out. The global switch, market scope and saved content still gate the widget."
                  checked={flagChecked("batch_transparency")}
                  onChange={(checked) =>
                    toggleFlag("batch_transparency", checked)
                  }
                  disabled={flagsFetcher.state !== "idle"}
                />
                <Divider />
                <TextField
                  label="Intro"
                  value={batchState.intro}
                  onChange={(intro) =>
                    setBatchState((previous) => ({ ...previous, intro }))
                  }
                  multiline={2}
                  disabled={savingBatch}
                  helpText="Optional line above the ingredient table."
                  autoComplete="off"
                />

                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Ingredients
                  </Text>
                  {batchState.ingredients.map((ingredient, index) => (
                    <InlineStack
                      key={ingredient.key}
                      gap="200"
                      blockAlign="end"
                      wrap
                    >
                      <Box minWidth="220px">
                        <TextField
                          label="Ingredient"
                          value={ingredient.name}
                          onChange={(name) => setIngredient(index, { name })}
                          disabled={savingBatch}
                          error={
                            ingredient.name.trim() === ""
                              ? "Required"
                              : undefined
                          }
                          autoComplete="off"
                        />
                      </Box>
                      <Box width="160px">
                        <TextField
                          label="Concentration"
                          type="number"
                          min={0}
                          suffix="%"
                          value={ingredient.concentration}
                          onChange={(concentration) =>
                            setIngredient(index, { concentration })
                          }
                          disabled={savingBatch}
                          error={numericError(ingredient.concentration, {
                            min: 0,
                          })}
                          autoComplete="off"
                        />
                      </Box>
                      <Box width="180px">
                        <TextField
                          label="Form"
                          value={ingredient.form}
                          onChange={(form) => setIngredient(index, { form })}
                          disabled={savingBatch}
                          helpText="e.g. “encapsulated”"
                          autoComplete="off"
                        />
                      </Box>
                      <Box minWidth="180px">
                        <TextField
                          label="Note"
                          value={ingredient.note}
                          onChange={(note) => setIngredient(index, { note })}
                          disabled={savingBatch}
                          autoComplete="off"
                        />
                      </Box>
                      <Button
                        icon={DeleteIcon}
                        tone="critical"
                        accessibilityLabel={`Remove ingredient ${index + 1}`}
                        onClick={() => removeIngredient(index)}
                        disabled={savingBatch}
                      />
                    </InlineStack>
                  ))}
                  <InlineStack>
                    <Button
                      onClick={addIngredient}
                      disabled={
                        savingBatch ||
                        batchState.ingredients.length >= MAX_INGREDIENTS
                      }
                    >
                      Add ingredient
                    </Button>
                  </InlineStack>
                </BlockStack>

                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Certificates of analysis
                  </Text>
                  {batchState.certificates.map((certificate, index) => (
                    <Box
                      key={certificate.key}
                      borderColor="border"
                      borderWidth="025"
                      borderRadius="200"
                      padding="300"
                    >
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h4" variant="headingSm">
                            Certificate {index + 1}
                          </Text>
                          <Button
                            size="slim"
                            icon={DeleteIcon}
                            tone="critical"
                            accessibilityLabel={`Remove certificate ${index + 1}`}
                            onClick={() => removeCertificate(index)}
                            disabled={savingBatch}
                          />
                        </InlineStack>
                        <InlineStack gap="200" wrap>
                          <Box width="180px">
                            <TextField
                              label="Batch #"
                              value={certificate.batch}
                              onChange={(batch) =>
                                setCertificate(index, { batch })
                              }
                              disabled={savingBatch}
                              autoComplete="off"
                            />
                          </Box>
                          <Box width="170px">
                            <TextField
                              label="Issued on"
                              type="date"
                              value={certificate.issued}
                              onChange={(issued) =>
                                setCertificate(index, { issued })
                              }
                              disabled={savingBatch}
                              autoComplete="off"
                            />
                          </Box>
                          <Box minWidth="220px">
                            <TextField
                              label="Testing lab"
                              value={certificate.lab}
                              onChange={(lab) => setCertificate(index, { lab })}
                              disabled={savingBatch}
                              autoComplete="off"
                            />
                          </Box>
                        </InlineStack>
                        <InlineStack gap="400" blockAlign="start" wrap>
                          <Box minWidth="280px">
                            <TextField
                              label="Document URL"
                              value={certificate.documentUrl}
                              onChange={(documentUrl) =>
                                setCertificate(index, { documentUrl })
                              }
                              placeholder="https://…"
                              disabled={savingBatch}
                              helpText="Public link to the PDF — used when no file is uploaded."
                              autoComplete="off"
                            />
                          </Box>
                          <DocumentField
                            documentGid={certificate.documentGid}
                            documentFileUrl={certificate.documentFileUrl}
                            disabled={savingBatch}
                            onSelect={(gid, fileUrl) =>
                              setCertificate(index, {
                                documentGid: gid,
                                documentFileUrl: fileUrl,
                              })
                            }
                            onClear={() =>
                              setCertificate(index, {
                                documentGid: "",
                                documentFileUrl: null,
                              })
                            }
                          />
                        </InlineStack>
                      </BlockStack>
                    </Box>
                  ))}
                  <InlineStack>
                    <Button
                      onClick={addCertificate}
                      disabled={
                        savingBatch ||
                        batchState.certificates.length >= MAX_CERTIFICATES
                      }
                    >
                      Add certificate
                    </Button>
                  </InlineStack>
                </BlockStack>

                <InlineStack gap="200" align="end">
                  {batchConfigured ? (
                    <Button
                      tone="critical"
                      variant="secondary"
                      onClick={deleteBatch}
                      loading={batchPendingIntent === "delete_batch"}
                      disabled={savingBatch}
                    >
                      {confirmDelete === "batch"
                        ? "Click again to remove"
                        : "Remove batch transparency"}
                    </Button>
                  ) : null}
                  <Button
                    variant="primary"
                    onClick={saveBatch}
                    loading={batchPendingIntent === "save_batch"}
                    disabled={
                      savingBatch ||
                      !batchDirty ||
                      batchIngredientInvalid ||
                      batchConcentrationInvalid
                    }
                  >
                    Save batch transparency
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ---------------- Amazon data (v6.1) ------------------------- */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="h2" variant="headingMd">
                    Amazon data
                  </Text>
                  <Badge
                    tone={
                      amazonGlobalFlags.az_bought_count ||
                      amazonGlobalFlags.az_bestseller_badge ||
                      amazonGlobalFlags.az_fbt
                        ? "success"
                        : "attention"
                    }
                  >
                    {amazonGlobalFlags.az_bought_count ||
                    amazonGlobalFlags.az_bestseller_badge ||
                    amazonGlobalFlags.az_fbt
                      ? "Pattern switches on"
                      : "Pattern switches off"}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Per-product data for the Amazon-pattern widgets: the
                  “bought in past month” count, the bestseller badge and the
                  manual “Frequently bought together” list. The count and
                  badge NEVER render without a value you set here; the
                  count's set-date is stamped automatically on save and
                  counts older than {AZ_STALE_DAYS} days are hidden on the
                  storefront until refreshed. Global switches live on the
                  Amazon patterns page.
                </Text>
                {boosters.flags.boughtCountSetAt ? (
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="p" tone="subdued" variant="bodySm">
                      Bought count set on {boosters.flags.boughtCountSetAt}
                      {boughtCountAgeDays !== null
                        ? ` (${boughtCountAgeDays} day${boughtCountAgeDays === 1 ? "" : "s"} ago)`
                        : ""}
                    </Text>
                    {boughtCountStale ? (
                      <Badge tone="attention">
                        {`Stale (>${AZ_STALE_DAYS} days) — hidden on the storefront`}
                      </Badge>
                    ) : null}
                  </InlineStack>
                ) : null}
                <InlineStack gap="300" blockAlign="start" wrap>
                  <Box width="180px">
                    <TextField
                      label="Bought last month"
                      value={amazonState.boughtCount}
                      onChange={(boughtCount) =>
                        setAmazonState((previous) => ({
                          ...previous,
                          boughtCount,
                        }))
                      }
                      error={amazonErrors.boughtCountError}
                      placeholder="e.g. 2000"
                      helpText="Empty or 0 hides it"
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="120px">
                    <TextField
                      label="Bestseller rank"
                      value={amazonState.rank}
                      onChange={(rank) =>
                        setAmazonState((previous) => ({ ...previous, rank }))
                      }
                      placeholder="1"
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="260px">
                    <TextField
                      label="Bestseller category"
                      value={amazonState.category}
                      onChange={(category) =>
                        setAmazonState((previous) => ({
                          ...previous,
                          category,
                        }))
                      }
                      error={amazonErrors.bestsellerError}
                      placeholder="Anti-aging"
                      maxLength={60}
                      helpText="Stored as a translatable metafield — auto-translated on save when DeepL is connected (see the Translations card)"
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
                <Divider />
                <Text as="h3" variant="headingSm">
                  Frequently bought together — manual override
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Hand-pick up to {AZ_MAX_FBT_ITEMS} products shown with this
                  one; leave empty for automatic complementary
                  recommendations.
                </Text>
                {amazonState.fbt.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No manual items — automatic recommendations.
                  </Text>
                ) : (
                  <BlockStack gap="100">
                    {amazonState.fbt.map((item) => (
                      <InlineStack
                        key={item.variantId}
                        gap="200"
                        blockAlign="center"
                      >
                        <Text as="span" variant="bodySm">
                          {item.label}
                        </Text>
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() =>
                            setAmazonState((previous) => ({
                              ...previous,
                              fbt: previous.fbt.filter(
                                (other) => other.variantId !== item.variantId,
                              ),
                            }))
                          }
                        >
                          Remove
                        </Button>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
                <Box maxWidth="360px">
                  <TextField
                    label="Add a product"
                    labelHidden
                    placeholder="Search products to add"
                    value={fbtQuery}
                    onChange={setFbtQuery}
                    autoComplete="off"
                  />
                </Box>
                {fbtQuery.trim() !== "" ? (
                  <BlockStack gap="100">
                    {fbtSearchResults.slice(0, 6).map((variant) => {
                      const already = amazonState.fbt.some(
                        (item) => item.variantId === variant.id,
                      );
                      const full =
                        amazonState.fbt.length >= AZ_MAX_FBT_ITEMS;
                      return (
                        <InlineStack
                          key={variant.id}
                          gap="200"
                          blockAlign="center"
                        >
                          <Button
                            variant="plain"
                            disabled={already || full}
                            onClick={() =>
                              setAmazonState((previous) => ({
                                ...previous,
                                fbt: [
                                  ...previous.fbt,
                                  {
                                    variantId: variant.id,
                                    handle: variant.productHandle,
                                    label: variant.productTitle,
                                  },
                                ],
                              }))
                            }
                          >
                            {already ? "Added" : full ? "List full" : "Add"}
                          </Button>
                          <Text as="span" variant="bodySm">
                            {variant.productTitle}
                            {variant.title !== "Default Title"
                              ? ` — ${variant.title}`
                              : ""}
                          </Text>
                        </InlineStack>
                      );
                    })}
                    {fbtSearch.state === "idle" &&
                    fbtSearchResults.length === 0 ? (
                      <Text as="p" tone="subdued" variant="bodySm">
                        No matches.
                      </Text>
                    ) : null}
                  </BlockStack>
                ) : null}
                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    onClick={saveAmazon}
                    disabled={!amazonDirty || amazonHasErrors}
                    loading={amazonFetcher.state !== "idle"}
                  >
                    Save Amazon data
                  </Button>
                  <Button variant="plain" url="/app/features/amazon">
                    Amazon patterns settings
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ---------------- Risk-free trial guarantee ------------------ */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Risk-free trial guarantee
                  </Text>
                  <Badge
                    tone={globalFlags.empty_bottle_guarantee ? "success" : "attention"}
                  >
                    {globalFlags.empty_bottle_guarantee
                      ? "Global switch on"
                      : "Global switch off"}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  “Try it for {guaranteeDays} days, completely risk-free — if
                  you don’t love your results, return the empty{" "}
                  {containerValue === "inherit"
                    ? guaranteeContainer
                    : containerValue}{" "}
                  for a full refund.” The panel needs no per-product content;
                  the day count is global and copy overrides live in the
                  theme editor.
                </Text>
                <Checkbox
                  label="Show the guarantee panel on this product"
                  checked={flagChecked("empty_bottle_guarantee")}
                  onChange={(checked) =>
                    toggleFlag("empty_bottle_guarantee", checked)
                  }
                  disabled={flagsFetcher.state !== "idle"}
                />
                <Box maxWidth="280px">
                  <Select
                    label="Container type"
                    options={CONTAINER_SELECT_OPTIONS}
                    value={containerValue}
                    onChange={setContainer}
                    disabled={flagsFetcher.state !== "idle"}
                    helpText={`The word used in this product’s guarantee copy. “Inherit default” uses the global setting (${guaranteeContainer}).`}
                  />
                </Box>
                <InlineStack>
                  <Button variant="plain" url="/app/products">
                    Global switch &amp; day count
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ---------------- Dermatologist survey (v7) ------------------ */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Dermatologist survey
                  </Text>
                  <Badge tone={surveyConfigured ? "success" : undefined}>
                    {surveyConfigured ? "Configured" : "Not configured"}
                  </Badge>
                  {!globalFlags.derm_survey ? (
                    <Badge tone="attention">Global switch off</Badge>
                  ) : null}
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Per-product outcomes survey — the statements dermatologists
                  rated for this exact product. The widget stays hidden on
                  this product until you save survey content here.
                </Text>
                {surveyStale ? (
                  <Banner tone="warning" title="Content changed elsewhere">
                    <BlockStack gap="200">
                      <Text as="p">
                        This content changed since you loaded the page (another
                        tab or teammate). Reload to see the latest before
                        saving.
                      </Text>
                      <InlineStack>
                        <Button
                          onClick={() => reloadStaleCard("survey")}
                          loading={revalidator.state !== "idle"}
                        >
                          Reload
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Banner>
                ) : null}
                {cardErrors(surveyFetcher.data, [
                  "save_survey",
                  "delete_survey",
                ]).length > 0 ? (
                  <Banner tone="critical" title="Dermatologist survey not saved">
                    <BlockStack gap="100">
                      {cardErrors(surveyFetcher.data, [
                        "save_survey",
                        "delete_survey",
                      ]).map((error) => (
                        <Text as="p" key={error}>
                          {error}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                ) : null}
                <Checkbox
                  label="Show the dermatologist survey on this product"
                  helpText="Per-product opt-out. The global switch, market scope and saved survey content still gate the widget."
                  checked={flagChecked("derm_survey")}
                  onChange={(checked) => toggleFlag("derm_survey", checked)}
                  disabled={flagsFetcher.state !== "idle"}
                />
                <Divider />
                <InlineStack gap="300" wrap>
                  <Box minWidth="280px">
                    <TextField
                      label="Headline override"
                      value={surveyState.title}
                      onChange={(title) => setSurveyField({ title })}
                      disabled={savingSurvey}
                      helpText="Optional. Leave empty for the built-in “NN% would recommend” headline."
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="200px">
                    <TextField
                      label="Dermatologists surveyed"
                      type="number"
                      min={1}
                      value={surveyState.sampleSize}
                      onChange={(sampleSize) => setSurveyField({ sampleSize })}
                      disabled={savingSurvey}
                      error={surveySampleError}
                      helpText="For this product, e.g. 34"
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="200px">
                    <TextField
                      label="Would recommend (Yes)"
                      type="number"
                      min={0}
                      value={surveyState.recommendYes}
                      onChange={(recommendYes) =>
                        setSurveyField({ recommendYes })
                      }
                      disabled={savingSurvey}
                      error={surveyRecommendError}
                      helpText={
                        surveyRecommendPct !== null
                          ? `Headline: “${surveyRecommendPct}% would recommend”`
                          : "Optional — empty means no percentage headline"
                      }
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
                <TextField
                  label="Exact question asked"
                  value={surveyState.question}
                  onChange={(question) => setSurveyField({ question })}
                  disabled={savingSurvey}
                  helpText="Optional — quoted verbatim in the widget. Only publish the question the dermatologists were actually asked."
                  autoComplete="off"
                />
                <TextField
                  label="Outcomes intro override"
                  value={surveyState.intro}
                  onChange={(intro) => setSurveyField({ intro })}
                  disabled={savingSurvey}
                  helpText="Optional. Leave empty for the built-in intro line with the product title."
                  autoComplete="off"
                />

                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Outcomes
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    The outcome statements the dermatologists rated, each with
                    how many agreed. Rows render as bars in saved order — a
                    row only shows when its agree count is between 1 and the
                    surveyed count (the widget never shows inconsistent
                    numbers). Up to {MAX_OUTCOMES}.
                  </Text>
                  {surveyState.outcomes.map((outcome, index) => {
                    const yes = parseNumericInput(outcome.yesCount);
                    const rowVisible =
                      surveySampleValue !== null &&
                      yes !== null &&
                      yes > 0 &&
                      yes <= surveySampleValue;
                    return (
                      <InlineStack
                        key={outcome.key}
                        gap="200"
                        blockAlign="end"
                        wrap
                      >
                        <Box minWidth="260px">
                          <TextField
                            label="Outcome statement"
                            value={outcome.statement}
                            onChange={(statement) =>
                              setOutcome(index, { statement })
                            }
                            disabled={savingSurvey}
                            error={
                              outcome.statement.trim() === ""
                                ? "Required"
                                : undefined
                            }
                            helpText="e.g. “Visibly firmer skin after 8 weeks of use”"
                            autoComplete="off"
                          />
                        </Box>
                        <Box width="130px">
                          <TextField
                            label="Agreed"
                            type="number"
                            min={0}
                            value={outcome.yesCount}
                            onChange={(yesCount) =>
                              setOutcome(index, { yesCount })
                            }
                            disabled={savingSurvey}
                            error={numericError(outcome.yesCount, {
                              integer: true,
                              min: 0,
                            })}
                            autoComplete="off"
                          />
                        </Box>
                        <Box paddingBlockEnd="100">
                          <Badge tone={rowVisible ? undefined : "attention"}>
                            {rowVisible
                              ? `${Math.round(
                                  ((yes as number) /
                                    (surveySampleValue as number)) *
                                    100,
                                )}%`
                              : "Hidden"}
                          </Badge>
                        </Box>
                        <InlineStack gap="100">
                          <Button
                            size="slim"
                            icon={ArrowUpIcon}
                            accessibilityLabel={`Move outcome ${index + 1} up`}
                            onClick={() => moveOutcome(index, -1)}
                            disabled={savingSurvey || index === 0}
                          />
                          <Button
                            size="slim"
                            icon={ArrowDownIcon}
                            accessibilityLabel={`Move outcome ${index + 1} down`}
                            onClick={() => moveOutcome(index, 1)}
                            disabled={
                              savingSurvey ||
                              index === surveyState.outcomes.length - 1
                            }
                          />
                          <Button
                            size="slim"
                            icon={DeleteIcon}
                            tone="critical"
                            accessibilityLabel={`Remove outcome ${index + 1}`}
                            onClick={() => removeOutcome(index)}
                            disabled={savingSurvey}
                          />
                        </InlineStack>
                      </InlineStack>
                    );
                  })}
                  <InlineStack>
                    <Button
                      onClick={addOutcome}
                      disabled={
                        savingSurvey ||
                        surveyState.outcomes.length >= MAX_OUTCOMES
                      }
                    >
                      Add outcome
                    </Button>
                  </InlineStack>
                </BlockStack>

                {surveyWouldHide ? (
                  <Banner
                    tone="warning"
                    title="The survey would be hidden on this product"
                  >
                    <Text as="p">
                      The widget fails closed: it needs the surveyed count
                      plus at least one visible outcome or a valid
                      would-recommend count. Until then it renders nothing —
                      it never shows inconsistent data.
                    </Text>
                  </Banner>
                ) : null}

                <TextField
                  label="“How the survey was conducted” override"
                  value={surveyState.methodology}
                  onChange={(methodology) => setSurveyField({ methodology })}
                  multiline={6}
                  disabled={savingSurvey}
                  helpText="Optional per-product disclosure — overrides the global text from the survey defaults page. The placeholders {{ total }}, {{ yes }} and {{ percent }} track this product’s numbers; lines using {{ yes }} or {{ percent }} appear only when a Would-recommend count is set."
                  autoComplete="off"
                />
                <InlineStack gap="300" wrap>
                  <Box minWidth="260px">
                    <TextField
                      label="Verifier name"
                      value={surveyState.verifierName}
                      onChange={(verifierName) =>
                        setSurveyField({ verifierName })
                      }
                      disabled={savingSurvey}
                      helpText="Optional — overrides the global default verifier for this product. Never machine-translated."
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="280px">
                    <TextField
                      label="Verification URL"
                      value={surveyState.verificationUrl}
                      onChange={(verificationUrl) =>
                        setSurveyField({ verificationUrl })
                      }
                      placeholder="https://…"
                      disabled={savingSurvey}
                      error={
                        surveyUrlInvalid
                          ? "Must start with https:// (or leave empty)"
                          : undefined
                      }
                      helpText="Optional — overrides the global verification link for this product."
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>

                <InlineStack gap="200" align="space-between" blockAlign="center">
                  <Button variant="plain" url="/app/features/survey">
                    Survey defaults &amp; master switch
                  </Button>
                  <InlineStack gap="200">
                    {surveyConfigured ? (
                      <Button
                        tone="critical"
                        variant="secondary"
                        onClick={deleteSurvey}
                        loading={surveyPendingIntent === "delete_survey"}
                        disabled={savingSurvey}
                      >
                        {confirmDelete === "survey"
                          ? "Click again to remove"
                          : "Remove survey"}
                      </Button>
                    ) : null}
                    <Button
                      variant="primary"
                      onClick={saveSurvey}
                      loading={surveyPendingIntent === "save_survey"}
                      disabled={
                        savingSurvey ||
                        !surveyDirty ||
                        surveyUrlInvalid ||
                        surveyStatementMissing ||
                        surveyNumbersInvalid
                      }
                    >
                      Save dermatologist survey
                    </Button>
                  </InlineStack>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* ---------------- Brand proof on this product (v8) ----------- */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="h2" variant="headingMd">
                    Brand proof on this product
                  </Text>
                  {!globalFlags.press ? (
                    <Badge tone="attention">Press global switch off</Badge>
                  ) : null}
                  {!globalFlags.derm_endorsements ? (
                    <Badge tone="attention">
                      Endorsements global switch off
                    </Badge>
                  ) : null}
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Press quotes and dermatologist endorsements come from your
                  shop-wide Proof library and show on every product page
                  (entries tagged to this product appear first). These
                  switches only opt this product out.
                </Text>
                <Checkbox
                  label="Show “As seen in the press” on this product"
                  helpText="Brand-level module — shown on every product unless switched off here. Entries are managed under Proof library."
                  checked={flagChecked("press")}
                  onChange={(checked) => toggleFlag("press", checked)}
                  disabled={flagsFetcher.state !== "idle"}
                />
                <Checkbox
                  label="Show dermatologist endorsements on this product"
                  helpText="Brand-level module — shown on every product unless switched off here. Entries are managed under Proof library."
                  checked={flagChecked("derm_endorsements")}
                  onChange={(checked) =>
                    toggleFlag("derm_endorsements", checked)
                  }
                  disabled={flagsFetcher.state !== "idle"}
                />
                <InlineStack>
                  <Button variant="plain" url="/app/proof">
                    Manage entries under Proof library
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
