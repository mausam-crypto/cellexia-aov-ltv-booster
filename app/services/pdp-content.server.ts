/**
 * Per-product PDP booster content (SPEC v3).
 *
 * Reads and writes the four "cellexia" product metafields and the metaobjects
 * they reference:
 *
 *   - clinical_study      metaobject_reference       -> cellexia_clinical_study
 *                         (nested list of cellexia_study_result)
 *   - before_afters       list.metaobject_reference  -> cellexia_before_after
 *   - batch_transparency  metaobject_reference       -> cellexia_batch_transparency
 *                         (nested cellexia_ingredient + cellexia_coa lists)
 *   - pdp_flags           json                       -> per-product opt-in/out
 *
 * Saves are diff-based upserts: nested metaobjects with a known id are
 * updated, new ones are created, and metaobjects dropped from the incoming
 * ordered list are deleted AFTER the parent/metafield has been repointed (so
 * a failed delete never leaves a dangling reference). When the client passes
 * the ids it loaded (`knownIds`), saves abort with STALE_CONTENT_ERROR rather
 * than orphan-delete server content the client never saw. All inputs are
 * validated server-side (finite numbers, length-capped strings, GID/date/URL
 * shape checks). Every function resolves with { ok, errors, ... } and never
 * throws on userErrors.
 */

import {
  adminRequest,
  createMetaobject,
  deleteMetaobject,
  updateMetaobject,
  CELLEXIA_NAMESPACE,
  PDP_METAFIELD_KEYS,
  PDP_METAOBJECT_TYPES,
} from "./metaobjects.server";
import type {
  AdminGraphqlClient,
  MetaobjectFieldInput,
} from "./metaobjects.server";

export type { AdminGraphqlClient } from "./metaobjects.server";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The five per-product opt-in/out flags. Missing key = true (opted in). */
export const PDP_FLAG_KEYS = [
  "clinical_study",
  "verified_before_after",
  "batch_transparency",
  "empty_bottle_guarantee",
  "derm_survey",
] as const;
export type PdpFlagKey = (typeof PDP_FLAG_KEYS)[number];
export type PdpFlags = Record<PdpFlagKey, boolean>;

export interface ProductSummary {
  id: string;
  title: string;
  handle: string;
  /** Shopify product status: ACTIVE | DRAFT | ARCHIVED. */
  status: string;
  imageUrl: string | null;
}

export interface StudyResultView {
  id: string;
  value: number | null;
  suffix: string;
  label: string;
}

export interface ClinicalStudyView {
  id: string;
  title: string;
  concern: string;
  durationWeeks: number | null;
  sampleSize: number | null;
  labName: string;
  instruments: string;
  studyUrl: string;
  footnote: string;
  results: StudyResultView[];
}

export interface BeforeAfterView {
  id: string;
  beforeImageGid: string;
  beforeImageUrl: string | null;
  afterImageGid: string;
  afterImageUrl: string | null;
  beforeDate: string;
  afterDate: string;
  weeks: number | null;
  clinic: string;
  imaging: string;
  verifierName: string;
  verifierLicense: string;
  statement: string;
  verificationUrl: string;
}

export interface IngredientView {
  id: string;
  name: string;
  concentration: number | null;
  form: string;
  note: string;
}

export interface CoaView {
  id: string;
  batch: string;
  issued: string;
  lab: string;
  documentUrl: string;
  documentGid: string;
  /** CDN URL of the uploaded document file (when `document` is set). */
  documentFileUrl: string | null;
}

export interface BatchTransparencyView {
  id: string;
  intro: string;
  ingredients: IngredientView[];
  certificates: CoaView[];
}

export interface ProductBoostersResult {
  ok: boolean;
  errors: string[];
  product: ProductSummary | null;
  clinicalStudy: ClinicalStudyView | null;
  beforeAfters: BeforeAfterView[];
  batchTransparency: BatchTransparencyView | null;
  flags: PdpFlags;
}

export interface StudyResultInput {
  /** Existing cellexia_study_result GID to update; omit/null to create. */
  id?: string | null;
  value: number;
  suffix: string;
  label: string;
}

export interface ClinicalStudyInput {
  title: string;
  concern: string;
  durationWeeks: number;
  sampleSize: number;
  labName: string;
  instruments: string;
  studyUrl: string;
  footnote: string;
  /** Ordered — becomes the metaobject's `results` list order. */
  results: StudyResultInput[];
}

export interface BeforeAfterInput {
  /** Existing cellexia_before_after GID to update; omit/null to create. */
  id?: string | null;
  beforeImageGid: string;
  afterImageGid: string;
  beforeDate: string;
  afterDate: string;
  weeks: number;
  clinic: string;
  imaging: string;
  verifierName: string;
  verifierLicense: string;
  statement: string;
  verificationUrl: string;
}

export interface IngredientInput {
  id?: string | null;
  name: string;
  concentration: number;
  form: string;
  note: string;
}

export interface CoaInput {
  id?: string | null;
  batch: string;
  issued: string;
  lab: string;
  documentUrl: string;
  /** GenericFile/MediaImage GID of an uploaded document (optional). */
  documentGid?: string | null;
}

export interface BatchTransparencyInput {
  intro: string;
  ingredients: IngredientInput[];
  certificates: CoaInput[];
}

export interface SaveMetaobjectResult {
  ok: boolean;
  errors: string[];
  /**
   * Non-fatal problems on an otherwise successful save (e.g. orphaned
   * metaobjects that could not be deleted after the metafield was repointed).
   */
  warnings?: string[];
  /** GID of the parent metaobject after the save (null on failure). */
  metaobjectId: string | null;
}

export interface SaveBeforeAftersResult {
  ok: boolean;
  errors: string[];
  /**
   * Non-fatal problems on an otherwise successful save (e.g. orphaned
   * metaobjects that could not be deleted after the metafield was repointed).
   */
  warnings?: string[];
  /** Ordered cellexia_before_after GIDs now referenced by the metafield. */
  metaobjectIds: string[];
}

export interface SavePdpFlagsResult {
  ok: boolean;
  errors: string[];
  /** The full five-key flag object that was written. */
  flags: PdpFlags;
}

export interface DeleteResult {
  ok: boolean;
  errors: string[];
}

export interface DeleteBeforeAfterResult {
  ok: boolean;
  errors: string[];
  /** Ordered GIDs still referenced by the metafield after the removal. */
  remainingIds: string[];
}

export interface ProductBoosterStatus {
  id: string;
  title: string;
  handle: string;
  status: string;
  imageUrl: string | null;
  boosters: {
    clinical_study: boolean;
    /** Number of verified before/after entries. */
    verified_before_after: number;
    batch_transparency: boolean;
    flags: PdpFlags;
  };
}

export interface ListProductsResult {
  ok: boolean;
  errors: string[];
  products: ProductBoosterStatus[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SINGLE_LINE_MAX = 255;
const MULTI_LINE_MAX = 5000;
const URL_MAX = 255;
const MAX_STUDY_RESULTS = 25;
const MAX_BEFORE_AFTERS = 20;
const MAX_INGREDIENTS = 60;
const MAX_CERTIFICATES = 60;

const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/\d+$/;
const METAOBJECT_GID_PATTERN = /^gid:\/\/shopify\/Metaobject\/\d+$/;
const MEDIA_IMAGE_GID_PATTERN = /^gid:\/\/shopify\/MediaImage\/\d+$/;
const FILE_GID_PATTERN = /^gid:\/\/shopify\/(GenericFile|MediaImage)\/\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Optional https(s) URL: "" passes; anything else must be http(s). */
function cleanUrl(value: unknown, label: string, errors: string[]): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return "";
  if (text.length > URL_MAX) {
    errors.push(`${label} must be at most ${URL_MAX} characters`);
    return "";
  }
  if (!/^https?:\/\/\S+$/.test(text)) {
    errors.push(`${label} must be an http(s) URL`);
    return "";
  }
  return text;
}

/** Optional date: "" passes; anything else must be YYYY-MM-DD. */
function cleanDate(value: unknown, label: string, errors: string[]): string {
  const text = cleanText(value, 10);
  if (text === "") return "";
  if (!DATE_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    errors.push(`${label} must be a valid YYYY-MM-DD date`);
    return "";
  }
  return text;
}

function requireFiniteNumber(
  value: unknown,
  label: string,
  errors: string[],
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${label} must be a finite number`);
    return 0;
  }
  return value;
}

function requireNonNegativeInt(
  value: unknown,
  label: string,
  errors: string[],
): number {
  const finite = requireFiniteNumber(value, label, errors);
  if (finite < 0) {
    errors.push(`${label} must be >= 0`);
    return 0;
  }
  if (!Number.isInteger(finite)) {
    errors.push(`${label} must be a whole number`);
    return 0;
  }
  return finite;
}

/** Keeps an incoming id only when it is a well-formed metaobject GID. */
function cleanMetaobjectId(value: unknown): string | null {
  return typeof value === "string" && METAOBJECT_GID_PATTERN.test(value)
    ? value
    : null;
}

/**
 * Stable error surfaced by the routes when a save would orphan-delete
 * server-side content the client never loaded (concurrent edit).
 */
export const STALE_CONTENT_ERROR =
  "content changed since you loaded this page — reload before saving";

/**
 * Concurrent-edit guard for full-list saves: a current server-side id that is
 * absent from BOTH the incoming payload ids AND the ids the client loaded
 * (`knownIds`) is content the client never saw — deleting it would silently
 * drop another session's work. Ids present in `knownIds` but absent from the
 * payload are legitimate merchant deletions.
 */
function hasUnseenServerIds(
  currentIds: string[],
  payloadIds: (string | null)[],
  knownIds: string[],
): boolean {
  const seen = new Set<string>(knownIds);
  for (const id of payloadIds) {
    if (id) seen.add(id);
  }
  return currentIds.some((id) => !seen.has(id));
}

// ---------------------------------------------------------------------------
// Shared parsing + metafield helpers
// ---------------------------------------------------------------------------

interface RawField {
  key: string;
  value: string | null;
}

function toFieldMap(fields: RawField[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of fields ?? []) map[entry.key] = entry.value ?? "";
  return map;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parses a list.metaobject_reference metafield/field value (JSON GID array). */
function parseGidList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is string =>
        typeof entry === "string" && METAOBJECT_GID_PATTERN.test(entry),
    );
  } catch {
    return [];
  }
}

function parseFlags(value: string | null | undefined): PdpFlags {
  let parsed: unknown = null;
  if (value) {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  const source =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    PDP_FLAG_KEYS.map((key) => [key, source[key] !== false]),
  ) as PdpFlags;
}

function defaultFlags(): PdpFlags {
  return parseFlags(null);
}

const METAFIELDS_SET_MUTATION = `#graphql
  mutation cellexiaPdpMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id key }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_DELETE_MUTATION = `#graphql
  mutation cellexiaPdpMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key }
      userErrors { field message }
    }
  }
`;

interface MetafieldsSetData {
  metafieldsSet: {
    metafields: { id: string; key: string }[] | null;
    userErrors: { field?: string[] | null; message: string }[];
  } | null;
}

interface MetafieldsDeleteData {
  metafieldsDelete: {
    deletedMetafields: { key: string }[] | null;
    userErrors: { field?: string[] | null; message: string }[];
  } | null;
}

async function setProductMetafield(
  admin: AdminGraphqlClient,
  productGid: string,
  key: string,
  type: string,
  value: string,
): Promise<string[]> {
  const result = await adminRequest<MetafieldsSetData>(
    admin,
    METAFIELDS_SET_MUTATION,
    {
      metafields: [
        {
          ownerId: productGid,
          namespace: CELLEXIA_NAMESPACE,
          key,
          type,
          value,
        },
      ],
    },
  );
  return [
    ...(result.data?.metafieldsSet?.userErrors ?? []).map((e) => e.message),
    ...result.errors,
  ];
}

async function deleteProductMetafield(
  admin: AdminGraphqlClient,
  productGid: string,
  key: string,
): Promise<string[]> {
  const result = await adminRequest<MetafieldsDeleteData>(
    admin,
    METAFIELDS_DELETE_MUTATION,
    {
      metafields: [
        { ownerId: productGid, namespace: CELLEXIA_NAMESPACE, key },
      ],
    },
  );
  return [
    ...(result.data?.metafieldsDelete?.userErrors ?? []).map((e) => e.message),
    ...result.errors,
  ];
}

async function deleteMetaobjects(
  admin: AdminGraphqlClient,
  ids: string[],
): Promise<string[]> {
  const errors: string[] = [];
  for (const id of ids) {
    const result = await deleteMetaobject(admin, id);
    if (!result.ok) errors.push(...result.errors);
  }
  return errors;
}

interface NestedListItem {
  /** Existing metaobject GID to update, or null to create. */
  id: string | null;
  fields: MetaobjectFieldInput[];
}

interface SyncListResult {
  ok: boolean;
  /** Metaobject GIDs in the incoming order. */
  ids: string[];
  /** Previously-referenced GIDs no longer in the list (delete after repoint). */
  orphanIds: string[];
  errors: string[];
}

/**
 * Diff-based sync of an ordered metaobject list: items with an id that is
 * still present in `existingIds` are updated in place, everything else is
 * created. Returns the new ordered GID list plus the orphans the caller must
 * delete AFTER repointing the parent/metafield. Fails fast on the first
 * create/update error; metaobjects created earlier in the same call are
 * best-effort deleted before returning so a mid-list failure never leaks
 * unreferenced metaobjects.
 */
async function syncMetaobjectList(
  admin: AdminGraphqlClient,
  type: string,
  existingIds: string[],
  incoming: NestedListItem[],
): Promise<SyncListResult> {
  const existing = new Set(existingIds);
  const kept = new Set<string>();
  const ids: string[] = [];
  const createdThisCall: string[] = [];
  for (const item of incoming) {
    if (item.id && existing.has(item.id)) {
      const result = await updateMetaobject(admin, item.id, item.fields);
      if (!result.ok) {
        await deleteMetaobjects(admin, createdThisCall);
        return { ok: false, ids, orphanIds: [], errors: result.errors };
      }
      ids.push(item.id);
      kept.add(item.id);
    } else {
      const result = await createMetaobject(admin, type, item.fields);
      if (!result.ok || !result.id) {
        await deleteMetaobjects(admin, createdThisCall);
        return { ok: false, ids, orphanIds: [], errors: result.errors };
      }
      ids.push(result.id);
      createdThisCall.push(result.id);
    }
  }
  return {
    ok: true,
    ids,
    orphanIds: existingIds.filter((id) => !kept.has(id)),
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// getProductBoosters
// ---------------------------------------------------------------------------

const PRODUCT_BOOSTERS_QUERY = `#graphql
  query cellexiaProductBoosters($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      featuredImage { url }
      clinicalStudy: metafield(namespace: "cellexia", key: "clinical_study") {
        reference {
          ... on Metaobject {
            id
            fields { key value }
            resultsField: field(key: "results") {
              references(first: 25) {
                nodes {
                  ... on Metaobject { id fields { key value } }
                }
              }
            }
          }
        }
      }
      beforeAfters: metafield(namespace: "cellexia", key: "before_afters") {
        references(first: 20) {
          nodes {
            ... on Metaobject {
              id
              fields { key value }
              beforeImageField: field(key: "before_image") {
                reference {
                  ... on MediaImage { id image { url } preview { image { url } } }
                }
              }
              afterImageField: field(key: "after_image") {
                reference {
                  ... on MediaImage { id image { url } preview { image { url } } }
                }
              }
            }
          }
        }
      }
      batchTransparency: metafield(namespace: "cellexia", key: "batch_transparency") {
        reference {
          ... on Metaobject {
            id
            fields { key value }
            ingredientsField: field(key: "ingredients") {
              references(first: 60) {
                nodes {
                  ... on Metaobject { id fields { key value } }
                }
              }
            }
            certificatesField: field(key: "certificates") {
              references(first: 60) {
                nodes {
                  ... on Metaobject {
                    id
                    fields { key value }
                    documentField: field(key: "document") {
                      reference {
                        ... on GenericFile { id url }
                        ... on MediaImage { id image { url } }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      pdpFlags: metafield(namespace: "cellexia", key: "pdp_flags") { value }
    }
  }
`;

interface RawMetaobjectNode {
  id?: string;
  fields?: RawField[];
}

interface RawImageReference {
  id?: string;
  url?: string | null;
  image?: { url: string } | null;
  preview?: { image: { url: string } | null } | null;
}

interface RawBeforeAfterNode extends RawMetaobjectNode {
  beforeImageField?: { reference: RawImageReference | null } | null;
  afterImageField?: { reference: RawImageReference | null } | null;
}

interface RawCoaNode extends RawMetaobjectNode {
  documentField?: { reference: RawImageReference | null } | null;
}

interface ProductBoostersData {
  product: {
    id: string;
    title: string;
    handle: string;
    status: string;
    featuredImage: { url: string } | null;
    clinicalStudy: {
      reference:
        | (RawMetaobjectNode & {
            resultsField?: {
              references: { nodes: RawMetaobjectNode[] } | null;
            } | null;
          })
        | null;
    } | null;
    beforeAfters: {
      references: { nodes: RawBeforeAfterNode[] } | null;
    } | null;
    batchTransparency: {
      reference:
        | (RawMetaobjectNode & {
            ingredientsField?: {
              references: { nodes: RawMetaobjectNode[] } | null;
            } | null;
            certificatesField?: {
              references: { nodes: RawCoaNode[] } | null;
            } | null;
          })
        | null;
    } | null;
    pdpFlags: { value: string } | null;
  } | null;
}

function imageUrlOf(reference: RawImageReference | null | undefined): string | null {
  if (!reference) return null;
  return (
    reference.image?.url ??
    reference.url ??
    reference.preview?.image?.url ??
    null
  );
}

function toStudyResultViews(nodes: RawMetaobjectNode[] | undefined): StudyResultView[] {
  return (nodes ?? [])
    .filter((node): node is Required<RawMetaobjectNode> =>
      Boolean(node.id && node.fields),
    )
    .map((node) => {
      const map = toFieldMap(node.fields);
      return {
        id: node.id,
        value: toNumber(map.value),
        suffix: map.suffix ?? "",
        label: map.label ?? "",
      };
    });
}

/**
 * Hydrated view of a product's four cellexia metafields (single GraphQL
 * query, referenced metaobjects and nested lists included).
 */
export async function getProductBoosters(
  admin: AdminGraphqlClient,
  productGid: string,
): Promise<ProductBoostersResult> {
  const empty = {
    product: null,
    clinicalStudy: null,
    beforeAfters: [],
    batchTransparency: null,
    flags: defaultFlags(),
  };
  if (!PRODUCT_GID_PATTERN.test(productGid)) {
    return { ok: false, errors: ["Invalid product id"], ...empty };
  }

  const result = await adminRequest<ProductBoostersData>(
    admin,
    PRODUCT_BOOSTERS_QUERY,
    { id: productGid },
  );
  const product = result.data?.product ?? null;
  if (!product) {
    return {
      ok: false,
      errors: result.errors.length ? result.errors : ["Product not found"],
      ...empty,
    };
  }

  // Clinical study
  let clinicalStudy: ClinicalStudyView | null = null;
  const studyNode = product.clinicalStudy?.reference ?? null;
  if (studyNode?.id) {
    const map = toFieldMap(studyNode.fields);
    clinicalStudy = {
      id: studyNode.id,
      title: map.title ?? "",
      concern: map.concern ?? "",
      durationWeeks: toNumber(map.duration_weeks),
      sampleSize: toNumber(map.sample_size),
      labName: map.lab_name ?? "",
      instruments: map.instruments ?? "",
      studyUrl: map.study_url ?? "",
      footnote: map.footnote ?? "",
      results: toStudyResultViews(studyNode.resultsField?.references?.nodes),
    };
  }

  // Verified before/afters
  const beforeAfters: BeforeAfterView[] = (
    product.beforeAfters?.references?.nodes ?? []
  )
    .filter((node): node is RawBeforeAfterNode & { id: string } =>
      Boolean(node.id),
    )
    .map((node) => {
      const map = toFieldMap(node.fields);
      return {
        id: node.id,
        beforeImageGid: map.before_image ?? "",
        beforeImageUrl: imageUrlOf(node.beforeImageField?.reference),
        afterImageGid: map.after_image ?? "",
        afterImageUrl: imageUrlOf(node.afterImageField?.reference),
        beforeDate: map.before_date ?? "",
        afterDate: map.after_date ?? "",
        weeks: toNumber(map.weeks),
        clinic: map.clinic ?? "",
        imaging: map.imaging ?? "",
        verifierName: map.verifier_name ?? "",
        verifierLicense: map.verifier_license ?? "",
        statement: map.statement ?? "",
        verificationUrl: map.verification_url ?? "",
      };
    });

  // Batch transparency
  let batchTransparency: BatchTransparencyView | null = null;
  const batchNode = product.batchTransparency?.reference ?? null;
  if (batchNode?.id) {
    const map = toFieldMap(batchNode.fields);
    const ingredients: IngredientView[] = (
      batchNode.ingredientsField?.references?.nodes ?? []
    )
      .filter((node): node is Required<RawMetaobjectNode> =>
        Boolean(node.id && node.fields),
      )
      .map((node) => {
        const fields = toFieldMap(node.fields);
        return {
          id: node.id,
          name: fields.name ?? "",
          concentration: toNumber(fields.concentration),
          form: fields.form ?? "",
          note: fields.note ?? "",
        };
      });
    const certificates: CoaView[] = (
      batchNode.certificatesField?.references?.nodes ?? []
    )
      .filter((node): node is RawCoaNode & { id: string } => Boolean(node.id))
      .map((node) => {
        const fields = toFieldMap(node.fields);
        return {
          id: node.id,
          batch: fields.batch ?? "",
          issued: fields.issued ?? "",
          lab: fields.lab ?? "",
          documentUrl: fields.document_url ?? "",
          documentGid: fields.document ?? "",
          documentFileUrl: imageUrlOf(node.documentField?.reference),
        };
      });
    batchTransparency = {
      id: batchNode.id,
      intro: map.intro ?? "",
      ingredients,
      certificates,
    };
  }

  return {
    ok: true,
    errors: [],
    product: {
      id: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      imageUrl: product.featuredImage?.url ?? null,
    },
    clinicalStudy,
    beforeAfters,
    batchTransparency,
    flags: parseFlags(product.pdpFlags?.value),
  };
}

// ---------------------------------------------------------------------------
// saveClinicalStudy
// ---------------------------------------------------------------------------

const CLINICAL_STUDY_STATE_QUERY = `#graphql
  query cellexiaClinicalStudyState($id: ID!) {
    product(id: $id) {
      id
      metafield(namespace: "cellexia", key: "clinical_study") {
        id
        reference {
          ... on Metaobject {
            id
            resultsField: field(key: "results") { value }
          }
        }
      }
    }
  }
`;

interface ClinicalStudyStateData {
  product: {
    id: string;
    metafield: {
      id: string;
      reference: {
        id?: string;
        resultsField?: { value: string | null } | null;
      } | null;
    } | null;
  } | null;
}

interface CleanClinicalStudy {
  title: string;
  concern: string;
  durationWeeks: number;
  sampleSize: number;
  labName: string;
  instruments: string;
  studyUrl: string;
  footnote: string;
  results: { id: string | null; value: number; suffix: string; label: string }[];
}

function validateClinicalStudy(data: ClinicalStudyInput): {
  errors: string[];
  clean: CleanClinicalStudy;
} {
  const errors: string[] = [];
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length > MAX_STUDY_RESULTS) {
    errors.push(`At most ${MAX_STUDY_RESULTS} study results are allowed`);
  }
  const clean: CleanClinicalStudy = {
    title: cleanText(data.title, SINGLE_LINE_MAX),
    concern: cleanText(data.concern, SINGLE_LINE_MAX),
    durationWeeks: requireNonNegativeInt(
      data.durationWeeks,
      "Study duration (weeks)",
      errors,
    ),
    sampleSize: requireNonNegativeInt(data.sampleSize, "Sample size", errors),
    labName: cleanText(data.labName, SINGLE_LINE_MAX),
    instruments: cleanText(data.instruments, SINGLE_LINE_MAX),
    studyUrl: cleanUrl(data.studyUrl, "Study URL", errors),
    footnote: cleanText(data.footnote, MULTI_LINE_MAX),
    results: results.slice(0, MAX_STUDY_RESULTS).map((entry, index) => ({
      id: cleanMetaobjectId(entry.id),
      value: requireFiniteNumber(entry.value, `Result ${index + 1} value`, errors),
      suffix: cleanText(entry.suffix, 8),
      label: cleanText(entry.label, SINGLE_LINE_MAX),
    })),
  };
  return { errors, clean };
}

/**
 * Diff-based upsert of a product's clinical study: syncs the nested ordered
 * result metaobjects (update/create/delete), updates or creates the parent
 * cellexia_clinical_study metaobject, then points the product's
 * cellexia.clinical_study metafield at it.
 *
 * `knownIds` — the nested metaobject GIDs the client loaded. When provided,
 * the save aborts with STALE_CONTENT_ERROR if the server holds ids absent
 * from both the payload and `knownIds` (concurrent edit protection).
 */
export async function saveClinicalStudy(
  admin: AdminGraphqlClient,
  productGid: string,
  data: ClinicalStudyInput,
  knownIds?: string[],
): Promise<SaveMetaobjectResult> {
  if (!PRODUCT_GID_PATTERN.test(productGid)) {
    return { ok: false, errors: ["Invalid product id"], metaobjectId: null };
  }
  const { errors: validationErrors, clean } = validateClinicalStudy(data);
  if (validationErrors.length > 0) {
    return { ok: false, errors: validationErrors, metaobjectId: null };
  }

  const state = await adminRequest<ClinicalStudyStateData>(
    admin,
    CLINICAL_STUDY_STATE_QUERY,
    { id: productGid },
  );
  if (!state.data?.product) {
    return {
      ok: false,
      errors: state.errors.length ? state.errors : ["Product not found"],
      metaobjectId: null,
    };
  }
  const existingReference = state.data.product.metafield?.reference ?? null;
  const existingParentId = existingReference?.id ?? null;
  const existingResultIds = parseGidList(
    existingReference?.resultsField?.value,
  );

  if (
    knownIds &&
    hasUnseenServerIds(
      existingResultIds,
      clean.results.map((entry) => entry.id),
      knownIds,
    )
  ) {
    return {
      ok: false,
      errors: [STALE_CONTENT_ERROR],
      metaobjectId: existingParentId,
    };
  }

  const sync = await syncMetaobjectList(
    admin,
    PDP_METAOBJECT_TYPES.studyResult,
    existingResultIds,
    clean.results.map((entry) => ({
      id: entry.id,
      fields: [
        { key: "value", value: String(entry.value) },
        { key: "suffix", value: entry.suffix },
        { key: "label", value: entry.label },
      ],
    })),
  );
  if (!sync.ok) {
    return { ok: false, errors: sync.errors, metaobjectId: existingParentId };
  }

  const parentFields: MetaobjectFieldInput[] = [
    { key: "title", value: clean.title },
    { key: "concern", value: clean.concern },
    { key: "duration_weeks", value: String(clean.durationWeeks) },
    { key: "sample_size", value: String(clean.sampleSize) },
    { key: "lab_name", value: clean.labName },
    { key: "instruments", value: clean.instruments },
    { key: "study_url", value: clean.studyUrl },
    { key: "results", value: JSON.stringify(sync.ids) },
    { key: "footnote", value: clean.footnote },
  ];

  let parentId = existingParentId;
  if (parentId) {
    const updated = await updateMetaobject(admin, parentId, parentFields);
    if (!updated.ok) {
      return { ok: false, errors: updated.errors, metaobjectId: parentId };
    }
  } else {
    const created = await createMetaobject(
      admin,
      PDP_METAOBJECT_TYPES.clinicalStudy,
      parentFields,
    );
    if (!created.ok || !created.id) {
      return { ok: false, errors: created.errors, metaobjectId: null };
    }
    parentId = created.id;
  }

  const setErrors = await setProductMetafield(
    admin,
    productGid,
    PDP_METAFIELD_KEYS.clinicalStudy,
    "metaobject_reference",
    parentId,
  );
  if (setErrors.length > 0) {
    // A parent created by THIS call is unreferenced — best-effort delete it
    // so the failed save does not leak a metaobject.
    if (!existingParentId) {
      await deleteMetaobject(admin, parentId);
      return { ok: false, errors: setErrors, metaobjectId: null };
    }
    return { ok: false, errors: setErrors, metaobjectId: parentId };
  }

  // The metafield now points at the new content; a failed orphan cleanup is
  // non-fatal (the save itself persisted) and surfaces as warnings.
  const deleteErrors = await deleteMetaobjects(admin, sync.orphanIds);
  return {
    ok: true,
    errors: [],
    warnings: deleteErrors,
    metaobjectId: parentId,
  };
}

// ---------------------------------------------------------------------------
// saveBeforeAfters
// ---------------------------------------------------------------------------

const BEFORE_AFTERS_STATE_QUERY = `#graphql
  query cellexiaBeforeAftersState($id: ID!) {
    product(id: $id) {
      id
      metafield(namespace: "cellexia", key: "before_afters") {
        id
        value
      }
    }
  }
`;

interface MetafieldValueStateData {
  product: {
    id: string;
    metafield: { id: string; value: string } | null;
  } | null;
}

interface CleanBeforeAfter {
  id: string | null;
  beforeImageGid: string;
  afterImageGid: string;
  beforeDate: string;
  afterDate: string;
  weeks: number;
  clinic: string;
  imaging: string;
  verifierName: string;
  verifierLicense: string;
  statement: string;
  verificationUrl: string;
}

function validateBeforeAfters(entries: BeforeAfterInput[]): {
  errors: string[];
  clean: CleanBeforeAfter[];
} {
  const errors: string[] = [];
  const list = Array.isArray(entries) ? entries : [];
  if (list.length > MAX_BEFORE_AFTERS) {
    errors.push(`At most ${MAX_BEFORE_AFTERS} before/after entries are allowed`);
  }
  const clean = list.slice(0, MAX_BEFORE_AFTERS).map((entry, index) => {
    const label = `Entry ${index + 1}`;
    if (
      typeof entry.beforeImageGid !== "string" ||
      !MEDIA_IMAGE_GID_PATTERN.test(entry.beforeImageGid)
    ) {
      errors.push(`${label}: a before image is required`);
    }
    if (
      typeof entry.afterImageGid !== "string" ||
      !MEDIA_IMAGE_GID_PATTERN.test(entry.afterImageGid)
    ) {
      errors.push(`${label}: an after image is required`);
    }
    return {
      id: cleanMetaobjectId(entry.id),
      beforeImageGid: entry.beforeImageGid,
      afterImageGid: entry.afterImageGid,
      beforeDate: cleanDate(entry.beforeDate, `${label} before date`, errors),
      afterDate: cleanDate(entry.afterDate, `${label} after date`, errors),
      weeks: requireNonNegativeInt(entry.weeks, `${label} weeks`, errors),
      clinic: cleanText(entry.clinic, SINGLE_LINE_MAX),
      imaging: cleanText(entry.imaging, SINGLE_LINE_MAX),
      verifierName: cleanText(entry.verifierName, SINGLE_LINE_MAX),
      verifierLicense: cleanText(entry.verifierLicense, SINGLE_LINE_MAX),
      statement: cleanText(entry.statement, MULTI_LINE_MAX),
      verificationUrl: cleanUrl(
        entry.verificationUrl,
        `${label} verification URL`,
        errors,
      ),
    };
  });
  return { errors, clean };
}

/**
 * Diff-based upsert of the ordered verified before/after list. Entries with a
 * known id are updated, new ones created, dropped ones deleted; the
 * cellexia.before_afters list metafield is repointed to the new order (and
 * removed entirely when `entries` is empty).
 *
 * `knownIds` — the metaobject GIDs the client loaded. When provided, the save
 * aborts with STALE_CONTENT_ERROR if the server holds ids absent from both
 * the payload and `knownIds` (concurrent edit protection).
 */
export async function saveBeforeAfters(
  admin: AdminGraphqlClient,
  productGid: string,
  entries: BeforeAfterInput[],
  knownIds?: string[],
): Promise<SaveBeforeAftersResult> {
  if (!PRODUCT_GID_PATTERN.test(productGid)) {
    return { ok: false, errors: ["Invalid product id"], metaobjectIds: [] };
  }
  const { errors: validationErrors, clean } = validateBeforeAfters(entries);
  if (validationErrors.length > 0) {
    return { ok: false, errors: validationErrors, metaobjectIds: [] };
  }

  const state = await adminRequest<MetafieldValueStateData>(
    admin,
    BEFORE_AFTERS_STATE_QUERY,
    { id: productGid },
  );
  if (!state.data?.product) {
    return {
      ok: false,
      errors: state.errors.length ? state.errors : ["Product not found"],
      metaobjectIds: [],
    };
  }
  const metafield = state.data.product.metafield;
  const existingIds = parseGidList(metafield?.value);

  if (
    knownIds &&
    hasUnseenServerIds(
      existingIds,
      clean.map((entry) => entry.id),
      knownIds,
    )
  ) {
    return { ok: false, errors: [STALE_CONTENT_ERROR], metaobjectIds: [] };
  }

  const sync = await syncMetaobjectList(
    admin,
    PDP_METAOBJECT_TYPES.beforeAfter,
    existingIds,
    clean.map((entry) => ({
      id: entry.id,
      fields: [
        { key: "before_image", value: entry.beforeImageGid },
        { key: "after_image", value: entry.afterImageGid },
        { key: "before_date", value: entry.beforeDate },
        { key: "after_date", value: entry.afterDate },
        { key: "weeks", value: String(entry.weeks) },
        { key: "clinic", value: entry.clinic },
        { key: "imaging", value: entry.imaging },
        { key: "verifier_name", value: entry.verifierName },
        { key: "verifier_license", value: entry.verifierLicense },
        { key: "statement", value: entry.statement },
        { key: "verification_url", value: entry.verificationUrl },
      ],
    })),
  );
  if (!sync.ok) {
    return { ok: false, errors: sync.errors, metaobjectIds: [] };
  }

  let metafieldErrors: string[] = [];
  if (sync.ids.length > 0) {
    metafieldErrors = await setProductMetafield(
      admin,
      productGid,
      PDP_METAFIELD_KEYS.beforeAfters,
      "list.metaobject_reference",
      JSON.stringify(sync.ids),
    );
  } else if (metafield) {
    metafieldErrors = await deleteProductMetafield(
      admin,
      productGid,
      PDP_METAFIELD_KEYS.beforeAfters,
    );
  }
  if (metafieldErrors.length > 0) {
    return { ok: false, errors: metafieldErrors, metaobjectIds: sync.ids };
  }

  // The metafield now points at the new content; a failed orphan cleanup is
  // non-fatal (the save itself persisted) and surfaces as warnings.
  const deleteErrors = await deleteMetaobjects(admin, sync.orphanIds);
  return {
    ok: true,
    errors: [],
    warnings: deleteErrors,
    metaobjectIds: sync.ids,
  };
}

// ---------------------------------------------------------------------------
// saveBatchTransparency
// ---------------------------------------------------------------------------

const BATCH_TRANSPARENCY_STATE_QUERY = `#graphql
  query cellexiaBatchTransparencyState($id: ID!) {
    product(id: $id) {
      id
      metafield(namespace: "cellexia", key: "batch_transparency") {
        id
        reference {
          ... on Metaobject {
            id
            ingredientsField: field(key: "ingredients") { value }
            certificatesField: field(key: "certificates") { value }
          }
        }
      }
    }
  }
`;

interface BatchTransparencyStateData {
  product: {
    id: string;
    metafield: {
      id: string;
      reference: {
        id?: string;
        ingredientsField?: { value: string | null } | null;
        certificatesField?: { value: string | null } | null;
      } | null;
    } | null;
  } | null;
}

interface CleanBatchTransparency {
  intro: string;
  ingredients: {
    id: string | null;
    name: string;
    concentration: number;
    form: string;
    note: string;
  }[];
  certificates: {
    id: string | null;
    batch: string;
    issued: string;
    lab: string;
    documentUrl: string;
    documentGid: string;
  }[];
}

function validateBatchTransparency(data: BatchTransparencyInput): {
  errors: string[];
  clean: CleanBatchTransparency;
} {
  const errors: string[] = [];
  const ingredients = Array.isArray(data.ingredients) ? data.ingredients : [];
  const certificates = Array.isArray(data.certificates)
    ? data.certificates
    : [];
  if (ingredients.length > MAX_INGREDIENTS) {
    errors.push(`At most ${MAX_INGREDIENTS} ingredients are allowed`);
  }
  if (certificates.length > MAX_CERTIFICATES) {
    errors.push(`At most ${MAX_CERTIFICATES} certificates are allowed`);
  }
  const clean: CleanBatchTransparency = {
    intro: cleanText(data.intro, MULTI_LINE_MAX),
    ingredients: ingredients.slice(0, MAX_INGREDIENTS).map((entry, index) => {
      const name = cleanText(entry.name, SINGLE_LINE_MAX);
      if (name === "") {
        errors.push(`Ingredient ${index + 1}: a name is required`);
      }
      const concentration = requireFiniteNumber(
        entry.concentration,
        `Ingredient ${index + 1} concentration`,
        errors,
      );
      if (concentration < 0) {
        errors.push(`Ingredient ${index + 1} concentration must be >= 0`);
      }
      return {
        id: cleanMetaobjectId(entry.id),
        name,
        concentration,
        form: cleanText(entry.form, SINGLE_LINE_MAX),
        note: cleanText(entry.note, SINGLE_LINE_MAX),
      };
    }),
    certificates: certificates
      .slice(0, MAX_CERTIFICATES)
      .map((entry, index) => {
        const label = `Certificate ${index + 1}`;
        let documentGid = "";
        if (entry.documentGid) {
          if (
            typeof entry.documentGid === "string" &&
            FILE_GID_PATTERN.test(entry.documentGid)
          ) {
            documentGid = entry.documentGid;
          } else {
            errors.push(`${label}: invalid document file reference`);
          }
        }
        return {
          id: cleanMetaobjectId(entry.id),
          batch: cleanText(entry.batch, SINGLE_LINE_MAX),
          issued: cleanDate(entry.issued, `${label} issue date`, errors),
          lab: cleanText(entry.lab, SINGLE_LINE_MAX),
          documentUrl: cleanUrl(
            entry.documentUrl,
            `${label} document URL`,
            errors,
          ),
          documentGid,
        };
      }),
  };
  return { errors, clean };
}

/**
 * Diff-based upsert of a product's batch transparency block: syncs the
 * nested ingredient and certificate lists, updates or creates the parent
 * cellexia_batch_transparency metaobject, then points the product's
 * cellexia.batch_transparency metafield at it.
 *
 * `knownIds` — the nested metaobject GIDs the client loaded (ingredients and
 * certificates together). When provided, the save aborts with
 * STALE_CONTENT_ERROR if the server holds ids absent from both the payload
 * and `knownIds` (concurrent edit protection).
 */
export async function saveBatchTransparency(
  admin: AdminGraphqlClient,
  productGid: string,
  data: BatchTransparencyInput,
  knownIds?: string[],
): Promise<SaveMetaobjectResult> {
  if (!PRODUCT_GID_PATTERN.test(productGid)) {
    return { ok: false, errors: ["Invalid product id"], metaobjectId: null };
  }
  const { errors: validationErrors, clean } = validateBatchTransparency(data);
  if (validationErrors.length > 0) {
    return { ok: false, errors: validationErrors, metaobjectId: null };
  }

  const state = await adminRequest<BatchTransparencyStateData>(
    admin,
    BATCH_TRANSPARENCY_STATE_QUERY,
    { id: productGid },
  );
  if (!state.data?.product) {
    return {
      ok: false,
      errors: state.errors.length ? state.errors : ["Product not found"],
      metaobjectId: null,
    };
  }
  const existingReference = state.data.product.metafield?.reference ?? null;
  const existingParentId = existingReference?.id ?? null;
  const existingIngredientIds = parseGidList(
    existingReference?.ingredientsField?.value,
  );
  const existingCertificateIds = parseGidList(
    existingReference?.certificatesField?.value,
  );

  if (
    knownIds &&
    hasUnseenServerIds(
      [...existingIngredientIds, ...existingCertificateIds],
      [
        ...clean.ingredients.map((entry) => entry.id),
        ...clean.certificates.map((entry) => entry.id),
      ],
      knownIds,
    )
  ) {
    return {
      ok: false,
      errors: [STALE_CONTENT_ERROR],
      metaobjectId: existingParentId,
    };
  }

  const ingredientSync = await syncMetaobjectList(
    admin,
    PDP_METAOBJECT_TYPES.ingredient,
    existingIngredientIds,
    clean.ingredients.map((entry) => ({
      id: entry.id,
      fields: [
        { key: "name", value: entry.name },
        { key: "concentration", value: String(entry.concentration) },
        { key: "form", value: entry.form },
        { key: "note", value: entry.note },
      ],
    })),
  );
  if (!ingredientSync.ok) {
    return {
      ok: false,
      errors: ingredientSync.errors,
      metaobjectId: existingParentId,
    };
  }

  const certificateSync = await syncMetaobjectList(
    admin,
    PDP_METAOBJECT_TYPES.coa,
    existingCertificateIds,
    clean.certificates.map((entry) => ({
      id: entry.id,
      fields: [
        { key: "batch", value: entry.batch },
        { key: "issued", value: entry.issued },
        { key: "lab", value: entry.lab },
        { key: "document_url", value: entry.documentUrl },
        { key: "document", value: entry.documentGid },
      ],
    })),
  );
  if (!certificateSync.ok) {
    return {
      ok: false,
      errors: certificateSync.errors,
      metaobjectId: existingParentId,
    };
  }

  const parentFields: MetaobjectFieldInput[] = [
    { key: "intro", value: clean.intro },
    { key: "ingredients", value: JSON.stringify(ingredientSync.ids) },
    { key: "certificates", value: JSON.stringify(certificateSync.ids) },
  ];

  let parentId = existingParentId;
  if (parentId) {
    const updated = await updateMetaobject(admin, parentId, parentFields);
    if (!updated.ok) {
      return { ok: false, errors: updated.errors, metaobjectId: parentId };
    }
  } else {
    const created = await createMetaobject(
      admin,
      PDP_METAOBJECT_TYPES.batchTransparency,
      parentFields,
    );
    if (!created.ok || !created.id) {
      return { ok: false, errors: created.errors, metaobjectId: null };
    }
    parentId = created.id;
  }

  const setErrors = await setProductMetafield(
    admin,
    productGid,
    PDP_METAFIELD_KEYS.batchTransparency,
    "metaobject_reference",
    parentId,
  );
  if (setErrors.length > 0) {
    // A parent created by THIS call is unreferenced — best-effort delete it
    // so the failed save does not leak a metaobject.
    if (!existingParentId) {
      await deleteMetaobject(admin, parentId);
      return { ok: false, errors: setErrors, metaobjectId: null };
    }
    return { ok: false, errors: setErrors, metaobjectId: parentId };
  }

  // The metafield now points at the new content; a failed orphan cleanup is
  // non-fatal (the save itself persisted) and surfaces as warnings.
  const deleteErrors = await deleteMetaobjects(admin, [
    ...ingredientSync.orphanIds,
    ...certificateSync.orphanIds,
  ]);
  return {
    ok: true,
    errors: [],
    warnings: deleteErrors,
    metaobjectId: parentId,
  };
}

// ---------------------------------------------------------------------------
// savePdpFlags
// ---------------------------------------------------------------------------

const PDP_FLAGS_STATE_QUERY = `#graphql
  query cellexiaPdpFlagsState($id: ID!) {
    product(id: $id) {
      id
      metafield(namespace: "cellexia", key: "pdp_flags") {
        id
        value
      }
    }
  }
`;

/**
 * Merges the given flags over the product's current pdp_flags and writes the
 * full five-key JSON object. Only the five known keys are accepted; anything
 * that is not a boolean is ignored.
 */
export async function savePdpFlags(
  admin: AdminGraphqlClient,
  productGid: string,
  flags: Partial<Record<PdpFlagKey, boolean>>,
): Promise<SavePdpFlagsResult> {
  if (!PRODUCT_GID_PATTERN.test(productGid)) {
    return { ok: false, errors: ["Invalid product id"], flags: defaultFlags() };
  }

  const state = await adminRequest<MetafieldValueStateData>(
    admin,
    PDP_FLAGS_STATE_QUERY,
    { id: productGid },
  );
  if (!state.data?.product) {
    return {
      ok: false,
      errors: state.errors.length ? state.errors : ["Product not found"],
      flags: defaultFlags(),
    };
  }

  const next = parseFlags(state.data.product.metafield?.value);
  for (const key of PDP_FLAG_KEYS) {
    const value = flags?.[key];
    if (typeof value === "boolean") next[key] = value;
  }

  const errors = await setProductMetafield(
    admin,
    productGid,
    PDP_METAFIELD_KEYS.pdpFlags,
    "json",
    JSON.stringify(next),
  );
  return { ok: errors.length === 0, errors, flags: next };
}

// ---------------------------------------------------------------------------
// Deletions
// ---------------------------------------------------------------------------

/**
 * Removes a product's clinical study entirely: clears the metafield first
 * (so the storefront never sees a dangling reference), then deletes the
 * parent metaobject and its nested result metaobjects.
 */
export async function deleteClinicalStudy(
  admin: AdminGraphqlClient,
  productGid: string,
): Promise<DeleteResult> {
  if (!PRODUCT_GID_PATTERN.test(productGid)) {
    return { ok: false, errors: ["Invalid product id"] };
  }
  const state = await adminRequest<ClinicalStudyStateData>(
    admin,
    CLINICAL_STUDY_STATE_QUERY,
    { id: productGid },
  );
  if (!state.data?.product) {
    return {
      ok: false,
      errors: state.errors.length ? state.errors : ["Product not found"],
    };
  }
  const metafield = state.data.product.metafield;
  if (!metafield) return { ok: true, errors: [] };

  const parentId = metafield.reference?.id ?? null;
  const resultIds = parseGidList(metafield.reference?.resultsField?.value);

  const errors: string[] = [];
  errors.push(
    ...(await deleteProductMetafield(
      admin,
      productGid,
      PDP_METAFIELD_KEYS.clinicalStudy,
    )),
  );
  if (parentId) {
    const deleted = await deleteMetaobject(admin, parentId);
    if (!deleted.ok) errors.push(...deleted.errors);
  }
  errors.push(...(await deleteMetaobjects(admin, resultIds)));
  return { ok: errors.length === 0, errors };
}

/**
 * Removes a product's batch transparency block: clears the metafield, then
 * deletes the parent metaobject and its nested ingredient/CoA metaobjects.
 */
export async function deleteBatchTransparency(
  admin: AdminGraphqlClient,
  productGid: string,
): Promise<DeleteResult> {
  if (!PRODUCT_GID_PATTERN.test(productGid)) {
    return { ok: false, errors: ["Invalid product id"] };
  }
  const state = await adminRequest<BatchTransparencyStateData>(
    admin,
    BATCH_TRANSPARENCY_STATE_QUERY,
    { id: productGid },
  );
  if (!state.data?.product) {
    return {
      ok: false,
      errors: state.errors.length ? state.errors : ["Product not found"],
    };
  }
  const metafield = state.data.product.metafield;
  if (!metafield) return { ok: true, errors: [] };

  const parentId = metafield.reference?.id ?? null;
  const nestedIds = [
    ...parseGidList(metafield.reference?.ingredientsField?.value),
    ...parseGidList(metafield.reference?.certificatesField?.value),
  ];

  const errors: string[] = [];
  errors.push(
    ...(await deleteProductMetafield(
      admin,
      productGid,
      PDP_METAFIELD_KEYS.batchTransparency,
    )),
  );
  if (parentId) {
    const deleted = await deleteMetaobject(admin, parentId);
    if (!deleted.ok) errors.push(...deleted.errors);
  }
  errors.push(...(await deleteMetaobjects(admin, nestedIds)));
  return { ok: errors.length === 0, errors };
}

/**
 * Removes ONE verified before/after entry: patches the list metafield to the
 * remaining ordered GIDs (or removes it when the list becomes empty), then
 * deletes the entry's metaobject.
 */
export async function deleteBeforeAfter(
  admin: AdminGraphqlClient,
  productGid: string,
  entryGid: string,
): Promise<DeleteBeforeAfterResult> {
  if (!PRODUCT_GID_PATTERN.test(productGid)) {
    return { ok: false, errors: ["Invalid product id"], remainingIds: [] };
  }
  if (!METAOBJECT_GID_PATTERN.test(entryGid)) {
    return {
      ok: false,
      errors: ["Invalid before/after entry id"],
      remainingIds: [],
    };
  }

  const state = await adminRequest<MetafieldValueStateData>(
    admin,
    BEFORE_AFTERS_STATE_QUERY,
    { id: productGid },
  );
  if (!state.data?.product) {
    return {
      ok: false,
      errors: state.errors.length ? state.errors : ["Product not found"],
      remainingIds: [],
    };
  }
  const metafield = state.data.product.metafield;
  const currentIds = parseGidList(metafield?.value);
  const remainingIds = currentIds.filter((id) => id !== entryGid);

  const errors: string[] = [];
  if (metafield && remainingIds.length !== currentIds.length) {
    if (remainingIds.length > 0) {
      errors.push(
        ...(await setProductMetafield(
          admin,
          productGid,
          PDP_METAFIELD_KEYS.beforeAfters,
          "list.metaobject_reference",
          JSON.stringify(remainingIds),
        )),
      );
    } else {
      errors.push(
        ...(await deleteProductMetafield(
          admin,
          productGid,
          PDP_METAFIELD_KEYS.beforeAfters,
        )),
      );
    }
  }

  const deleted = await deleteMetaobject(admin, entryGid);
  if (!deleted.ok) errors.push(...deleted.errors);
  return { ok: errors.length === 0, errors, remainingIds };
}

// ---------------------------------------------------------------------------
// listProductsWithBoosterStatus
// ---------------------------------------------------------------------------

const LIST_PRODUCTS_QUERY = `#graphql
  query cellexiaBoosterProducts($query: String) {
    products(first: 25, query: $query, sortKey: TITLE) {
      nodes {
        id
        title
        handle
        status
        featuredImage { url }
        clinicalStudy: metafield(namespace: "cellexia", key: "clinical_study") { id }
        beforeAfters: metafield(namespace: "cellexia", key: "before_afters") { value }
        batchTransparency: metafield(namespace: "cellexia", key: "batch_transparency") { id }
        pdpFlags: metafield(namespace: "cellexia", key: "pdp_flags") { value }
      }
    }
  }
`;

interface ListProductsData {
  products: {
    nodes: {
      id: string;
      title: string;
      handle: string;
      status: string;
      featuredImage: { url: string } | null;
      clinicalStudy: { id: string } | null;
      beforeAfters: { value: string } | null;
      batchTransparency: { id: string } | null;
      pdpFlags: { value: string } | null;
    }[];
  } | null;
}

/**
 * Products for the "Product boosters" picker table: first 25 title matches
 * with per-booster configured state and the per-product flags.
 */
export async function listProductsWithBoosterStatus(
  admin: AdminGraphqlClient,
  search: string,
): Promise<ListProductsResult> {
  const cleaned = (search ?? "").replace(/["\\]/g, "").trim();
  // ANDed per-token wildcard clauses so partially typed trailing words still
  // match (an exact quoted phrase would require every word to be complete).
  const query =
    cleaned === ""
      ? ""
      : cleaned
          .split(/\s+/)
          .map((token) => `title:*${token}*`)
          .join(" ");

  const result = await adminRequest<ListProductsData>(
    admin,
    LIST_PRODUCTS_QUERY,
    { query },
  );
  if (!result.data?.products) {
    return {
      ok: false,
      errors: result.errors.length ? result.errors : ["Could not load products"],
      products: [],
    };
  }

  const products: ProductBoosterStatus[] = result.data.products.nodes.map(
    (node) => ({
      id: node.id,
      title: node.title,
      handle: node.handle,
      status: node.status,
      imageUrl: node.featuredImage?.url ?? null,
      boosters: {
        clinical_study: Boolean(node.clinicalStudy?.id),
        verified_before_after: parseGidList(node.beforeAfters?.value).length,
        batch_transparency: Boolean(node.batchTransparency?.id),
        flags: parseFlags(node.pdpFlags?.value),
      },
    }),
  );
  return { ok: true, errors: [], products };
}
