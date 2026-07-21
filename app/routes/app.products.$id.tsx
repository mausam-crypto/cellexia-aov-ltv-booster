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
  Page,
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
  getProductBoosters,
  saveBatchTransparency,
  saveBeforeAfters,
  saveClinicalStudy,
  savePdpFlags,
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
} from "../services/pdp-content.server";

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

  const [settings, boosters] = await Promise.all([
    getSettings(session.shop),
    getProductBoosters(admin, productGid),
  ]);
  const storePrefix = session.shop.replace(".myshopify.com", "");

  return {
    boosters,
    definitionErrors,
    guaranteeDays: settings.emptyBottleGuarantee.days,
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
    },
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
  | { intent: "save_flags"; ok: boolean; errors: string[] }
  | { intent: "save_clinical"; ok: boolean; errors: string[] }
  | { intent: "delete_clinical"; ok: boolean; errors: string[] }
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
  const { admin } = await authenticate.admin(request);
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
    case "save_flags": {
      const key = String(formData.get("key") ?? "");
      const value = String(formData.get("value") ?? "");
      if (!(PDP_FLAG_KEYS as readonly string[]).includes(key)) {
        return { intent: "save_flags", ok: false, errors: ["Unknown booster flag"] };
      }
      const result = await savePdpFlags(admin, productGid, {
        [key]: value === "true",
      } as Partial<Record<PdpFlagKey, boolean>>);
      return { intent: "save_flags", ok: result.ok, errors: result.errors };
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
const MAX_BA_ENTRIES = 20;
const MAX_INGREDIENTS = 60;
const MAX_CERTIFICATES = 60;

function clinicalToState(view: ClinicalStudyView | null): ClinicalFormState {
  if (!view) {
    return {
      title: "",
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
    definitionErrors,
    guaranteeDays,
    globalFlags,
    metaobjectsUrl,
  } = useLoaderData<typeof loader>();
  const shopify = useAppBridge();

  const clinicalFetcher = useFetcher<typeof action>();
  const baFetcher = useFetcher<typeof action>();
  const batchFetcher = useFetcher<typeof action>();
  const flagsFetcher = useFetcher<typeof action>();

  const initialClinical = useMemo(
    () => clinicalToState(boosters.clinicalStudy),
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
  const [baEntries, setBaEntries] = useState<BaEntryState[]>(initialBa);
  const [batchState, setBatchState] = useState<BatchFormState>(initialBatch);
  const [confirmDelete, setConfirmDelete] = useState<
    null | "clinical" | "batch"
  >(null);

  const keyCounterRef = useRef(0);
  const nextKey = () => {
    keyCounterRef.current += 1;
    return `new-${keyCounterRef.current}`;
  };

  const clinicalDirty =
    JSON.stringify(clinicalState) !== JSON.stringify(initialClinical);
  const baDirty =
    JSON.stringify(baProjection(baEntries)) !==
    JSON.stringify(baProjection(initialBa));
  const batchDirty =
    JSON.stringify(batchProjection(batchState)) !==
    JSON.stringify(batchProjection(initialBatch));

  const dirtyRef = useRef({ clinical: false, ba: false, batch: false });
  dirtyRef.current = {
    clinical: clinicalDirty,
    ba: baDirty,
    batch: batchDirty,
  };

  /** True while any card save/delete is in flight — its own completion
   *  effect owns that revalidation's adoption, so the background branch
   *  below must not touch any card. */
  const cardSavePendingRef = useRef(false);
  cardSavePendingRef.current =
    clinicalFetcher.state !== "idle" ||
    baFetcher.state !== "idle" ||
    batchFetcher.state !== "idle";

  /** Metaobject GIDs each card's form was seeded from (the `knownIds`
   *  concurrent-edit contract) — updated on every adoption below. */
  const clinicalSeedIdsRef = useRef<string[]>(
    clinicalKnownIds(boosters.clinicalStudy),
  );
  const baSeedIdsRef = useRef<string[]>(baKnownIds(boosters.beforeAfters));
  const batchSeedIdsRef = useRef<string[]>(
    batchKnownIds(boosters.batchTransparency),
  );

  /** Cards whose next loader-data arrival must reseed the form regardless of
   *  local edits (the stale-content Reload button). */
  const forceAdoptRef = useRef({ clinical: false, ba: false, batch: false });

  const revalidator = useRevalidator();
  const [staleReloaded, setStaleReloaded] = useState<{
    clinical: unknown;
    ba: unknown;
    batch: unknown;
  }>({ clinical: null, ba: null, batch: null });

  const adoptClinical = () => {
    clinicalSeedIdsRef.current = clinicalKnownIds(boosters.clinicalStudy);
    setClinicalState(initialClinical);
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
    forceAdoptRef.current = { clinical: false, ba: false, batch: false };
    const savePending = cardSavePendingRef.current;
    if (forced.clinical || (!savePending && !dirtyRef.current.clinical)) {
      adoptClinical();
    }
    if (forced.ba || (!savePending && !dirtyRef.current.ba)) {
      adoptBa();
    }
    if (forced.batch || (!savePending && !dirtyRef.current.batch)) {
      adoptBatch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boosters]);

  const reloadStaleCard = (card: "clinical" | "ba" | "batch") => {
    const data =
      card === "clinical"
        ? clinicalFetcher.data
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

  const savingClinical = clinicalFetcher.state !== "idle";
  const savingBa = baFetcher.state !== "idle";
  const savingBatch = batchFetcher.state !== "idle";
  const clinicalPendingIntent =
    savingClinical && clinicalFetcher.formData
      ? clinicalFetcher.formData.get("intent")
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
          <Banner tone="info" title="Translate this content">
            <BlockStack gap="200">
              <Text as="p">
                Everything you save here (study titles, verifier statements,
                ingredient names, footnotes) is stored as Shopify metaobjects.
                Translate it in Translate &amp; Adapt under Content →
                Metaobjects — exactly like theme content. Shoppers always see
                the translated version for their language.
              </Text>
              <InlineStack gap="200">
                <Button url={metaobjectsUrl} target="_blank">
                  Open Content → Metaobjects
                </Button>
              </InlineStack>
            </BlockStack>
          </Banner>
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
                      helpText="e.g. 112"
                      autoComplete="off"
                    />
                  </Box>
                  <Box minWidth="260px">
                    <TextField
                      label="Lab name"
                      value={clinicalState.labName}
                      onChange={(labName) => setClinicalField({ labName })}
                      disabled={savingClinical}
                      helpText="The independent lab that ran the study."
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
                      helpText="Comma-separated, e.g. “corneometer, VISIA”."
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
                    the rest appear in the results grid. Up to {MAX_RESULTS}.
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
                      <Button
                        icon={DeleteIcon}
                        tone="critical"
                        accessibilityLabel={`Remove result ${index + 1}`}
                        onClick={() => removeResult(index)}
                        disabled={savingClinical}
                      />
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
                  label="Show verified before/afters on this product"
                  helpText="Per-product opt-out. The global switch, market scope and saved entries still gate the widget."
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
                    No entries yet — add the first verified before/after.
                  </Text>
                ) : null}
                {initialBa.length > 0 && baEntries.length === 0 ? (
                  <Banner tone="warning">
                    <Text as="p">
                      Saving now removes all published before/after entries for
                      this product.
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

            {/* ---------------- Guarantee + survey (global content) -------- */}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Empty bottle guarantee
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
                  “Use every last drop — take {guaranteeDays} days. If you
                  don’t love your results, return the empty bottle for a full
                  refund.” The panel needs no per-product content; copy and the
                  day count are global.
                </Text>
                <Checkbox
                  label="Show the guarantee panel on this product"
                  checked={flagChecked("empty_bottle_guarantee")}
                  onChange={(checked) =>
                    toggleFlag("empty_bottle_guarantee", checked)
                  }
                  disabled={flagsFetcher.state !== "idle"}
                />
                <InlineStack>
                  <Button variant="plain" url="/app/products">
                    Global switch &amp; day count
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Dermatologist survey
                  </Text>
                  <Badge tone={globalFlags.derm_survey ? "success" : "attention"}>
                    {globalFlags.derm_survey
                      ? "Global switch on"
                      : "Global switch off"}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  The survey widget shows on every product page using the
                  global numbers and verifier — this product only opts in or
                  out.
                </Text>
                <Checkbox
                  label="Show the dermatologist survey on this product"
                  checked={flagChecked("derm_survey")}
                  onChange={(checked) => toggleFlag("derm_survey", checked)}
                  disabled={flagsFetcher.state !== "idle"}
                />
                <InlineStack>
                  <Button variant="plain" url="/app/features/survey">
                    Survey settings &amp; preview
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
