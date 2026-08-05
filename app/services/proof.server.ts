/**
 * v8 proof library (docs/SPEC-v8-proof-library.md §1–§2, §5).
 *
 * Three Prisma tables — PressItem, DermEndorsement, CustomerResult — hold the
 * merchant's press quotes, dermatologist endorsements and before/after results
 * at a scale Liquid JSON islands cannot (hundreds/thousands of rows). This
 * module is the single home for:
 *
 *   - typed CRUD + moderation (list w/ status filter + search + pagination,
 *     counts, featured toggle, status set, neighbour-swap reorder, delete)
 *     used by the /app/proof admin tabs;
 *   - the PUBLIC projections served by /apps/cellexia/proof (proxy.proof.tsx):
 *     approved rows only, admin/shop fields stripped, product prioritisation
 *     (tagged-first-then-brand, tagged-for-OTHER-products excluded), results
 *     facets computed over the UNfiltered product-scoped set;
 *   - importLegacyBeforeAfters: exactly-once migration of the v3 PDP
 *     before/after metaobjects into CustomerResult rows (source=lab,
 *     verified=true) keyed by the metaobject GID (legacyGid @unique).
 *
 * Entry content is merchant/customer text served exactly as entered (never
 * machine-translated); the storefront renders every string via textContent
 * only. All functions resolve with { ok, errors, ... } and never throw on
 * expected failures.
 */

import prisma from "../db.server";
import type { CustomerResult, DermEndorsement, PressItem } from "@prisma/client";

/**
 * Deploy-time self-diagnosis (v8.4). If the RUNNING server's generated
 * Prisma Client predates the v8 schema, the three proof models are simply
 * absent from the client object and every access dies with the cryptic
 * "Cannot read properties of undefined (reading 'count')". This guard
 * turns that into an actionable message. Root causes in the wild: the
 * host's build reused cached node_modules (generate never re-ran), or
 * `npx prisma generate` was run in a ONE-OFF HOST SHELL — which does not
 * persist into the running service's filesystem on most PaaS hosts — or
 * the deployment carries a pre-v8 schema.prisma (e.g. an old locally
 * patched copy). The v8.4 package.json runs `prisma generate` in both
 * postinstall and the build script, so a normal rebuild always fixes it.
 */
export function assertProofModels(): void {
  const missing = (["pressItem", "dermEndorsement", "customerResult"] as const).filter(
    (model) => !(prisma as unknown as Record<string, unknown>)[model],
  );
  if (missing.length > 0) {
    throw new Error(
      `The server is running a Prisma Client generated BEFORE the v8 schema — missing model(s): ${missing.join(", ")}. ` +
        "Fix: rebuild with this version's scripts — the build auto-selects the right schema from DATABASE_URL " +
        "(prisma/schema.postgres.prisma on Postgres) and regenerates the client during the BUILD " +
        "(a one-off shell run on the host does NOT persist), then run " +
        "`npx prisma db push --schema prisma/schema.postgres.prisma` against the production database and restart.",
    );
  }
}
import {
  getProductBoosters,
  listProductsWithBoosterStatus,
} from "./pdp-content.server";
import type { AdminGraphqlClient } from "./metaobjects.server";

// ---------------------------------------------------------------------------
// Public types + enums
// ---------------------------------------------------------------------------

export type ProofType = "press" | "endorsements" | "results";

export const PROOF_TYPES: ProofType[] = ["press", "endorsements", "results"];

/** press + endorsements statuses. Results additionally have "pending". */
export const PROOF_STATUSES = ["approved", "hidden"] as const;
export const RESULT_STATUSES = ["pending", "approved", "hidden"] as const;

export const RESULT_SOURCES = ["lab", "customer"] as const;

export const AGE_RANGES = [
  "18-24",
  "25-34",
  "35-44",
  "45-54",
  "55-64",
  "65+",
] as const;

export const SKIN_TYPES = [
  "dry",
  "oily",
  "combination",
  "sensitive",
  "normal",
] as const;

/** Duration facet buckets (proxy `duration` param values). */
export const DURATION_BUCKETS = ["lt8", "8to12", "gt12"] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

export interface PressItemInput {
  publication: string;
  logoUrl: string;
  quote: string;
  /** Optional — a press item without a link renders quote + name only. */
  articleUrl: string;
  productGids: string[];
  /** Market handles this item is limited to; [] = every market (v8.1). */
  marketHandles: string[];
  featured: boolean;
  status: string;
}

export interface EndorsementInput {
  name: string;
  credentials: string;
  country: string;
  quote: string;
  imageUrl: string;
  productGids: string[];
  featured: boolean;
  status: string;
}

export interface ResultInput {
  source: string;
  verified: boolean;
  beforeUrl: string;
  afterUrl: string;
  ageRange: string;
  skinType: string;
  concern: string;
  durationWeeks: number | null;
  country: string;
  testimonial: string;
  videoUrl: string;
  productGids: string[];
  featured: boolean;
  status: string;
}

export interface ProofWriteResult {
  ok: boolean;
  id: string | null;
  errors: string[];
}

export interface ProofListOptions {
  /** Exact status filter; undefined = all statuses. */
  status?: string;
  /** Case-insensitive-ish contains search (SQLite `contains` is used). */
  search?: string;
  /** 1-based. */
  page?: number;
  per?: number;
}

export interface ProofListResult<T> {
  ok: boolean;
  errors: string[];
  items: T[];
  /** Rows matching the status/search filter (pagination total). */
  total: number;
  page: number;
  per: number;
}

export interface ProofTypeCounts {
  total: number;
  approved: number;
  pending: number;
}

export type ProofCounts = Record<ProofType, ProofTypeCounts>;

export interface ImportLegacyResult {
  ok: boolean;
  imported: number;
  skipped: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SINGLE_LINE_MAX = 255;
const MULTI_LINE_MAX = 5000;
const URL_MAX = 512;
export const MAX_PRODUCT_TAGS = 20;
const MAX_DURATION_WEEKS = 520;

const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/\d+$/;
const HTTPS_URL_PATTERN = /^https:\/\/[^\s"'<>\\]+$/;
const ISO2_PATTERN = /^[A-Za-z]{2}$/;

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** "" passes (field cleared); anything else must be a safe https:// URL. */
function cleanHttpsUrl(value: unknown, label: string, errors: string[]): string {
  const text = cleanText(value, URL_MAX);
  if (text === "") return "";
  if (!HTTPS_URL_PATTERN.test(text) || text.length > URL_MAX) {
    errors.push(`${label} must be an https:// URL`);
    return "";
  }
  return text;
}

function cleanCountry(value: unknown, errors: string[]): string {
  const text = cleanText(value, 2);
  if (text === "") return "";
  if (!ISO2_PATTERN.test(text)) {
    errors.push("Country must be a 2-letter ISO code (e.g. US)");
    return "";
  }
  return text.toUpperCase();
}

function cleanProductGids(value: unknown, errors: string[]): string {
  if (!Array.isArray(value)) return "[]";
  const seen = new Set<string>();
  const gids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const gid = entry.trim();
    if (!PRODUCT_GID_PATTERN.test(gid)) {
      errors.push("Tagged products must be Shopify product GIDs");
      continue;
    }
    if (seen.has(gid)) continue;
    seen.add(gid);
    gids.push(gid);
  }
  if (gids.length > MAX_PRODUCT_TAGS) {
    errors.push(`No more than ${MAX_PRODUCT_TAGS} tagged products`);
    return JSON.stringify(gids.slice(0, MAX_PRODUCT_TAGS));
  }
  return JSON.stringify(gids);
}

function cleanEnum(
  value: unknown,
  allowed: readonly string[],
  fallback: string,
): string {
  return typeof value === "string" && allowed.includes(value)
    ? value
    : fallback;
}

/** Mirrors settings.server.ts marketHandlePattern — keep the two identical. */
const MARKET_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_MARKET_TAGS = 50;

function cleanMarketHandles(value: unknown, errors: string[]): string {
  if (!Array.isArray(value)) return "[]";
  const handles: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const handle = entry.trim().toLowerCase();
    if (handle === "" || !MARKET_HANDLE_PATTERN.test(handle)) {
      errors.push(`Not a valid market handle: ${String(entry).slice(0, 40)}`);
      continue;
    }
    if (handles.includes(handle)) continue;
    handles.push(handle);
  }
  if (handles.length > MAX_MARKET_TAGS) {
    errors.push(`No more than ${MAX_MARKET_TAGS} markets`);
    return JSON.stringify(handles.slice(0, MAX_MARKET_TAGS));
  }
  return JSON.stringify(handles);
}

/** Parse the marketHandles JSON column defensively (bad rows = all markets). */
export function parseMarketHandles(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is string =>
            typeof entry === "string" && MARKET_HANDLE_PATTERN.test(entry),
        )
      : [];
  } catch {
    return [];
  }
}

/** Parse the productGids JSON column defensively (bad rows = brand-level). */
export function parseProductGids(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is string =>
            typeof entry === "string" && PRODUCT_GID_PATTERN.test(entry),
        )
      : [];
  } catch {
    return [];
  }
}

export function durationBucketOf(
  durationWeeks: number | null,
): DurationBucket | null {
  if (typeof durationWeeks !== "number" || !Number.isFinite(durationWeeks)) {
    return null;
  }
  if (durationWeeks < 8) return "lt8";
  if (durationWeeks <= 12) return "8to12";
  return "gt12";
}

// ---------------------------------------------------------------------------
// Moderation delegate — the shared shape of the three Prisma models
// ---------------------------------------------------------------------------

/**
 * Every proof table shares shop/status/featured/sortWeight/createdAt, which is
 * all the moderation operations (reorder, feature, status, delete, counts)
 * touch. The three generated delegates are structurally compatible with this
 * narrow interface; the cast in `delegateFor` is the single place that
 * bridges them so the operations exist once instead of three times.
 */
interface ModerationRow {
  id: string;
  shop: string;
  status: string;
  featured: boolean;
  sortWeight: number;
  createdAt: Date;
}

interface ModerationDelegate {
  findFirst(args: {
    where: { id: string; shop: string };
  }): Promise<ModerationRow | null>;
  findMany(args: {
    where: { shop: string };
    orderBy: { sortWeight: "asc" | "desc" }[] | Record<string, "asc" | "desc">[];
    select: { id: boolean; sortWeight: boolean };
  }): Promise<{ id: string; sortWeight: number }[]>;
  update(args: {
    where: { id: string };
    data: Partial<Pick<ModerationRow, "status" | "featured" | "sortWeight">>;
  }): Promise<unknown>;
  delete(args: { where: { id: string } }): Promise<unknown>;
  groupBy(args: {
    by: ["status"];
    where: { shop: string };
    _count: { _all: true };
  }): Promise<{ status: string; _count: { _all: number } }[]>;
}

function delegateFor(type: ProofType): ModerationDelegate {
  assertProofModels();
  switch (type) {
    case "press":
      return prisma.pressItem as unknown as ModerationDelegate;
    case "endorsements":
      return prisma.dermEndorsement as unknown as ModerationDelegate;
    case "results":
      return prisma.customerResult as unknown as ModerationDelegate;
  }
}

function statusesFor(type: ProofType): readonly string[] {
  return type === "results" ? RESULT_STATUSES : PROOF_STATUSES;
}

/** One orderBy term — literal subsets of every model's OrderBy input, kept
 *  mutable so the arrays below feed Prisma findMany calls directly. */
interface ProofOrderTerm {
  featured?: "desc";
  sortWeight?: "asc";
  createdAt?: "desc";
}

/**
 * Serve order for the PUBLIC proxy (spec §2): featured desc, sortWeight asc,
 * createdAt desc — featured entries pin first at serve time.
 */
const PUBLIC_ORDER_BY: ProofOrderTerm[] = [
  { featured: "desc" },
  { sortWeight: "asc" },
  { createdAt: "desc" },
];

/**
 * Admin table order: plain sortWeight asc, createdAt desc — WITHOUT the
 * featured-first pin, so Move up/down (a sortWeight neighbour swap) always
 * moves a row past its visible neighbour. Featured is a star badge in the
 * table, and only the storefront pins it first.
 */
const ADMIN_ORDER_BY: ProofOrderTerm[] = [
  { sortWeight: "asc" },
  { createdAt: "desc" },
];

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/**
 * Full per-type moderation counts for the /app/proof hub badges
 * (total / approved / pending per table).
 */
export async function getProofModerationCounts(
  shop: string,
): Promise<ProofCounts & { ok: boolean }> {
  const counts: ProofCounts & { ok: boolean } = {
    ok: true,
    press: { total: 0, approved: 0, pending: 0 },
    endorsements: { total: 0, approved: 0, pending: 0 },
    results: { total: 0, approved: 0, pending: 0 },
  };
  for (const type of PROOF_TYPES) {
    try {
      const groups = await delegateFor(type).groupBy({
        by: ["status"],
        where: { shop },
        _count: { _all: true },
      });
      for (const group of groups) {
        counts[type].total += group._count._all;
        if (group.status === "approved") {
          counts[type].approved = group._count._all;
        } else if (group.status === "pending") {
          counts[type].pending = group._count._all;
        }
      }
    } catch {
      // A DB error must never masquerade as "zero entries" (v8 review):
      // consumers check `ok` and show "counts unavailable" instead of 0.
      counts.ok = false;
    }
  }
  return counts;
}

/**
 * APPROVED entry counts per type — the FeatureReadinessExtras.proofCounts
 * contract (preview.server.ts): flat numbers, approved rows only, because
 * readiness measures what the storefront can actually show. On a DB error
 * returns undefined — contentReadiness(undefined) words readiness safely
 * ("shows once entries exist") instead of asserting "No entries yet".
 */
export async function getProofCounts(shop: string): Promise<
  | {
      press: number;
      endorsements: number;
      results: number;
    }
  | undefined
> {
  const counts = await getProofModerationCounts(shop);
  if (!counts.ok) return undefined;
  return {
    press: counts.press.approved,
    endorsements: counts.endorsements.approved,
    results: counts.results.approved,
  };
}

// ---------------------------------------------------------------------------
// Admin lists
// ---------------------------------------------------------------------------

const ADMIN_PER_DEFAULT = 20;
const ADMIN_PER_MAX = 50;

function clampPage(page: number | undefined): number {
  return Number.isInteger(page) && (page as number) > 0 ? (page as number) : 1;
}

function clampPer(per: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(per) || (per as number) <= 0) return fallback;
  return Math.min(per as number, max);
}

/** Shared list plumbing — the per-type functions close over their own typed
 *  Prisma where/orderBy so this helper never widens Prisma's input types. */
async function listRows<T>(
  find: (skip: number, take: number) => Promise<T[]>,
  count: () => Promise<number>,
  options: ProofListOptions,
): Promise<ProofListResult<T>> {
  const page = clampPage(options.page);
  const per = clampPer(options.per, ADMIN_PER_DEFAULT, ADMIN_PER_MAX);
  try {
    const [total, items] = await Promise.all([
      count(),
      find((page - 1) * per, per),
    ]);
    return { ok: true, errors: [], items, total, page, per };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "Could not load entries"],
      items: [],
      total: 0,
      page,
      per,
    };
  }
}

export async function listPressItems(
  shop: string,
  options: ProofListOptions = {},
): Promise<ProofListResult<PressItem>> {
  assertProofModels();
  const search = cleanText(options.search, SINGLE_LINE_MAX);
  const where = {
    shop,
    ...(options.status ? { status: options.status } : {}),
    ...(search !== ""
      ? {
          OR: [
            { publication: { contains: search } },
            { quote: { contains: search } },
          ],
        }
      : {}),
  };
  return listRows(
    (skip, take) =>
      prisma.pressItem.findMany({ where, orderBy: ADMIN_ORDER_BY, skip, take }),
    () => prisma.pressItem.count({ where }),
    options,
  );
}

export async function listEndorsements(
  shop: string,
  options: ProofListOptions = {},
): Promise<ProofListResult<DermEndorsement>> {
  assertProofModels();
  const search = cleanText(options.search, SINGLE_LINE_MAX);
  const where = {
    shop,
    ...(options.status ? { status: options.status } : {}),
    ...(search !== ""
      ? {
          OR: [
            { name: { contains: search } },
            { credentials: { contains: search } },
            { quote: { contains: search } },
          ],
        }
      : {}),
  };
  return listRows(
    (skip, take) =>
      prisma.dermEndorsement.findMany({
        where,
        orderBy: ADMIN_ORDER_BY,
        skip,
        take,
      }),
    () => prisma.dermEndorsement.count({ where }),
    options,
  );
}

export async function listResults(
  shop: string,
  options: ProofListOptions = {},
): Promise<ProofListResult<CustomerResult>> {
  assertProofModels();
  const search = cleanText(options.search, SINGLE_LINE_MAX);
  const where = {
    shop,
    ...(options.status ? { status: options.status } : {}),
    ...(search !== ""
      ? {
          OR: [
            { testimonial: { contains: search } },
            { concern: { contains: search } },
            { country: { contains: search } },
          ],
        }
      : {}),
  };
  return listRows(
    (skip, take) =>
      prisma.customerResult.findMany({
        where,
        orderBy: ADMIN_ORDER_BY,
        skip,
        take,
      }),
    () => prisma.customerResult.count({ where }),
    options,
  );
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async function nextSortWeight(type: ProofType, shop: string): Promise<number> {
  const rows = await delegateFor(type).findMany({
    where: { shop },
    orderBy: [{ sortWeight: "desc" }],
    select: { id: true, sortWeight: true },
  });
  return rows.length > 0 ? rows[0].sortWeight + 1 : 0;
}

export async function savePressItem(
  shop: string,
  input: PressItemInput,
  id?: string | null,
): Promise<ProofWriteResult> {
  assertProofModels();
  const errors: string[] = [];
  const publication = cleanText(input.publication, SINGLE_LINE_MAX);
  if (publication === "") errors.push("A publication name is required");
  const quote = cleanText(input.quote, MULTI_LINE_MAX);
  if (quote === "") errors.push("A quote is required");
  const logoUrl = cleanHttpsUrl(input.logoUrl, "Logo image", errors);
  const articleUrl = cleanHttpsUrl(input.articleUrl, "Article link", errors);
  const productGids = cleanProductGids(input.productGids, errors);
  const marketHandles = cleanMarketHandles(input.marketHandles, errors);
  const status = cleanEnum(input.status, PROOF_STATUSES, "approved");
  if (errors.length > 0) return { ok: false, id: id ?? null, errors };

  const data = {
    publication,
    quote,
    logoUrl: logoUrl === "" ? null : logoUrl,
    articleUrl: articleUrl === "" ? null : articleUrl,
    productGids,
    marketHandles,
    featured: Boolean(input.featured),
    status,
  };
  try {
    if (id) {
      const existing = await prisma.pressItem.findFirst({ where: { id, shop } });
      if (!existing) return { ok: false, id, errors: ["Entry not found"] };
      await prisma.pressItem.update({ where: { id }, data });
      return { ok: true, id, errors: [] };
    }
    const created = await prisma.pressItem.create({
      data: { ...data, shop, sortWeight: await nextSortWeight("press", shop) },
    });
    return { ok: true, id: created.id, errors: [] };
  } catch (error) {
    return {
      ok: false,
      id: id ?? null,
      errors: [error instanceof Error ? error.message : "Could not save entry"],
    };
  }
}

export async function saveEndorsement(
  shop: string,
  input: EndorsementInput,
  id?: string | null,
): Promise<ProofWriteResult> {
  assertProofModels();
  const errors: string[] = [];
  const name = cleanText(input.name, SINGLE_LINE_MAX);
  if (name === "") errors.push("A name is required");
  const quote = cleanText(input.quote, MULTI_LINE_MAX);
  if (quote === "") errors.push("A quote is required");
  const credentials = cleanText(input.credentials, SINGLE_LINE_MAX);
  const country = cleanCountry(input.country, errors);
  const imageUrl = cleanHttpsUrl(input.imageUrl, "Portrait image", errors);
  const productGids = cleanProductGids(input.productGids, errors);
  const status = cleanEnum(input.status, PROOF_STATUSES, "approved");
  if (errors.length > 0) return { ok: false, id: id ?? null, errors };

  const data = {
    name,
    quote,
    credentials: credentials === "" ? null : credentials,
    country: country === "" ? null : country,
    imageUrl: imageUrl === "" ? null : imageUrl,
    productGids,
    featured: Boolean(input.featured),
    status,
  };
  try {
    if (id) {
      const existing = await prisma.dermEndorsement.findFirst({
        where: { id, shop },
      });
      if (!existing) return { ok: false, id, errors: ["Entry not found"] };
      await prisma.dermEndorsement.update({ where: { id }, data });
      return { ok: true, id, errors: [] };
    }
    const created = await prisma.dermEndorsement.create({
      data: {
        ...data,
        shop,
        sortWeight: await nextSortWeight("endorsements", shop),
      },
    });
    return { ok: true, id: created.id, errors: [] };
  } catch (error) {
    return {
      ok: false,
      id: id ?? null,
      errors: [error instanceof Error ? error.message : "Could not save entry"],
    };
  }
}

export async function saveResult(
  shop: string,
  input: ResultInput,
  id?: string | null,
): Promise<ProofWriteResult> {
  assertProofModels();
  const errors: string[] = [];
  const source = cleanEnum(input.source, RESULT_SOURCES, "customer");
  const beforeUrl = cleanHttpsUrl(input.beforeUrl, "Before image", errors);
  const afterUrl = cleanHttpsUrl(input.afterUrl, "After image", errors);
  const videoUrl = cleanHttpsUrl(input.videoUrl, "Video URL", errors);
  const testimonial = cleanText(input.testimonial, MULTI_LINE_MAX);
  if (beforeUrl === "" && afterUrl === "" && testimonial === "" && videoUrl === "") {
    errors.push("Add at least an image, a testimonial or a video");
  }
  const ageRange = cleanEnum(input.ageRange, [...AGE_RANGES, ""], "");
  const skinType = cleanEnum(input.skinType, [...SKIN_TYPES, ""], "");
  const concern = cleanText(input.concern, 60)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  let durationWeeks: number | null = null;
  if (input.durationWeeks !== null && input.durationWeeks !== undefined) {
    if (
      !Number.isInteger(input.durationWeeks) ||
      input.durationWeeks < 0 ||
      input.durationWeeks > MAX_DURATION_WEEKS
    ) {
      errors.push(`Duration must be 0–${MAX_DURATION_WEEKS} weeks`);
    } else {
      durationWeeks = input.durationWeeks;
    }
  }
  const country = cleanCountry(input.country, errors);
  const productGids = cleanProductGids(input.productGids, errors);
  const status = cleanEnum(input.status, RESULT_STATUSES, "pending");
  if (errors.length > 0) return { ok: false, id: id ?? null, errors };

  const data = {
    source,
    verified: Boolean(input.verified),
    beforeUrl: beforeUrl === "" ? null : beforeUrl,
    afterUrl: afterUrl === "" ? null : afterUrl,
    ageRange: ageRange === "" ? null : ageRange,
    skinType: skinType === "" ? null : skinType,
    concern: concern === "" ? null : concern,
    durationWeeks,
    country: country === "" ? null : country,
    testimonial: testimonial === "" ? null : testimonial,
    videoUrl: videoUrl === "" ? null : videoUrl,
    productGids,
    featured: Boolean(input.featured),
    status,
  };
  try {
    if (id) {
      const existing = await prisma.customerResult.findFirst({
        where: { id, shop },
      });
      if (!existing) return { ok: false, id, errors: ["Entry not found"] };
      await prisma.customerResult.update({ where: { id }, data });
      return { ok: true, id, errors: [] };
    }
    const created = await prisma.customerResult.create({
      data: {
        ...data,
        shop,
        sortWeight: await nextSortWeight("results", shop),
      },
    });
    return { ok: true, id: created.id, errors: [] };
  } catch (error) {
    return {
      ok: false,
      id: id ?? null,
      errors: [error instanceof Error ? error.message : "Could not save entry"],
    };
  }
}

// ---------------------------------------------------------------------------
// Moderation (shared across the three tables)
// ---------------------------------------------------------------------------

export interface ProofModerationResult {
  ok: boolean;
  errors: string[];
}

export async function deleteProofItem(
  shop: string,
  type: ProofType,
  id: string,
): Promise<ProofModerationResult> {
  try {
    const delegate = delegateFor(type);
    const existing = await delegate.findFirst({ where: { id, shop } });
    if (!existing) return { ok: false, errors: ["Entry not found"] };
    await delegate.delete({ where: { id } });
    return { ok: true, errors: [] };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "Could not delete entry"],
    };
  }
}

export async function setProofStatus(
  shop: string,
  type: ProofType,
  id: string,
  status: string,
): Promise<ProofModerationResult> {
  if (!statusesFor(type).includes(status)) {
    return { ok: false, errors: ["Unknown status"] };
  }
  try {
    const delegate = delegateFor(type);
    const existing = await delegate.findFirst({ where: { id, shop } });
    if (!existing) return { ok: false, errors: ["Entry not found"] };
    await delegate.update({ where: { id }, data: { status } });
    return { ok: true, errors: [] };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "Could not update entry"],
    };
  }
}

export async function toggleProofFeatured(
  shop: string,
  type: ProofType,
  id: string,
): Promise<ProofModerationResult> {
  try {
    const delegate = delegateFor(type);
    const existing = await delegate.findFirst({ where: { id, shop } });
    if (!existing) return { ok: false, errors: ["Entry not found"] };
    await delegate.update({
      where: { id },
      data: { featured: !existing.featured },
    });
    return { ok: true, errors: [] };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "Could not update entry"],
    };
  }
}

export interface BulkApproveResult {
  ok: boolean;
  approved: number;
  errors: string[];
}

/** Bulk moderation: approve every pending customer result in one click
 *  (spec §5 — customer submissions arrive pending at scale). */
export async function bulkApprovePendingResults(
  shop: string,
): Promise<BulkApproveResult> {
  try {
    const updated = await prisma.customerResult.updateMany({
      where: { shop, status: "pending" },
      data: { status: "approved" },
    });
    return { ok: true, approved: updated.count, errors: [] };
  } catch (error) {
    return {
      ok: false,
      approved: 0,
      errors: [
        error instanceof Error ? error.message : "Could not approve entries",
      ],
    };
  }
}

/**
 * Move an entry one position up or down by swapping sortWeight with its
 * neighbour in (sortWeight asc, createdAt desc) order. Fresh installs where
 * every row still carries the default weight 0 get a one-time renumber
 * (0..n-1 in display order) inside the same transaction so the swap is
 * meaningful; after that, moves are two writes.
 */
export async function reorderProofItem(
  shop: string,
  type: ProofType,
  id: string,
  direction: "up" | "down",
): Promise<ProofModerationResult> {
  try {
    const delegate = delegateFor(type);
    const rows = await delegate.findMany({
      where: { shop },
      orderBy: [{ sortWeight: "asc" }, { createdAt: "desc" }],
      select: { id: true, sortWeight: true },
    });
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) return { ok: false, errors: ["Entry not found"] };
    const neighbourIndex = direction === "up" ? index - 1 : index + 1;
    if (neighbourIndex < 0 || neighbourIndex >= rows.length) {
      return { ok: true, errors: [] }; // already at the edge — no-op
    }
    const weights = rows.map((row) => row.sortWeight);
    const hasDuplicateWeights = new Set(weights).size !== weights.length;
    if (hasDuplicateWeights) {
      // Renumber to the current display order, with the moved pair swapped.
      const order = rows.map((row) => row.id);
      [order[index], order[neighbourIndex]] = [
        order[neighbourIndex],
        order[index],
      ];
      await prisma.$transaction(
        order.map((rowId, position) =>
          (delegate.update({
            where: { id: rowId },
            data: { sortWeight: position },
          }) as never),
        ),
      );
      return { ok: true, errors: [] };
    }
    const current = rows[index];
    const neighbour = rows[neighbourIndex];
    await prisma.$transaction([
      delegate.update({
        where: { id: current.id },
        data: { sortWeight: neighbour.sortWeight },
      }) as never,
      delegate.update({
        where: { id: neighbour.id },
        data: { sortWeight: current.sortWeight },
      }) as never,
    ]);
    return { ok: true, errors: [] };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : "Could not reorder"],
    };
  }
}

// ---------------------------------------------------------------------------
// Public (proxy) projections — approved rows only, admin fields stripped
// ---------------------------------------------------------------------------

export interface PublicPressItem {
  id: string;
  publication: string;
  logoUrl: string | null;
  quote: string;
  articleUrl: string | null;
}

export interface PublicEndorsement {
  id: string;
  name: string;
  credentials: string | null;
  country: string | null;
  quote: string;
  imageUrl: string | null;
}

export interface PublicResult {
  id: string;
  source: string;
  verified: boolean;
  beforeUrl: string | null;
  afterUrl: string | null;
  ageRange: string | null;
  skinType: string | null;
  concern: string | null;
  durationWeeks: number | null;
  country: string | null;
  testimonial: string | null;
  videoUrl: string | null;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface PublicResultsFacets {
  concerns: FacetCount[];
  ages: FacetCount[];
  skins: FacetCount[];
  durations: FacetCount[];
}

export interface PublicResultsFilters {
  concern?: string;
  age?: string;
  skin?: string;
  duration?: string;
}

export const PROXY_PER_DEFAULT = 24;
export const PROXY_PER_MAX = 24;

/** Hard ceiling on rows loaded per public request (v8 review: the public
 *  proxy must never materialise an unbounded table — facets/banding are
 *  in-memory). Far above any realistic proof library; documented in the
 *  proxy header. Applied to all three public queries. */
export const PUBLIC_ROW_CEILING = 5000;

interface TaggableRow {
  productGids: string;
}

/**
 * Product prioritisation (spec §2): with a product, items tagged with THAT
 * product come first, brand-level ([]) items follow, and items tagged only
 * for OTHER products are excluded. Without a product every approved item is
 * served (brand/home context). Rows arrive already in canonical order
 * (featured desc, sortWeight asc, createdAt desc), which also satisfies
 * "featured pinned first within each band".
 */
function prioritiseForProduct<T extends TaggableRow>(
  rows: T[],
  productGid: string | null,
): T[] {
  if (!productGid) return rows;
  const tagged: T[] = [];
  const brand: T[] = [];
  for (const row of rows) {
    const gids = parseProductGids(row.productGids);
    if (gids.length === 0) brand.push(row);
    else if (gids.includes(productGid)) tagged.push(row);
    // tagged for other products only -> excluded
  }
  return [...tagged, ...brand];
}

export async function getPublicPress(
  shop: string,
  productGid: string | null,
  marketHandle: string | null,
): Promise<{ total: number; items: PublicPressItem[] }> {
  assertProofModels();
  const rows = await prisma.pressItem.findMany({
    where: { shop, status: "approved" },
    orderBy: PUBLIC_ORDER_BY,
    take: PUBLIC_ROW_CEILING,
  });
  // v8.1 market scoping: market-agnostic items ([]) always serve; items
  // limited to markets serve only when the request's market matches. A
  // request without a market (direct API call) gets ONLY market-agnostic
  // items — never another market's press.
  const marketScoped = rows.filter((row) => {
    const handles = parseMarketHandles(row.marketHandles);
    if (handles.length === 0) return true;
    return marketHandle !== null && handles.includes(marketHandle);
  });
  const scoped = prioritiseForProduct(marketScoped, productGid);
  return {
    total: scoped.length,
    items: scoped.map((row) => ({
      id: row.id,
      publication: row.publication,
      logoUrl: row.logoUrl,
      quote: row.quote,
      articleUrl: row.articleUrl,
    })),
  };
}

export async function getPublicEndorsements(
  shop: string,
  productGid: string | null,
  page: number,
  per: number,
): Promise<{ total: number; items: PublicEndorsement[] }> {
  assertProofModels();
  const rows = await prisma.dermEndorsement.findMany({
    where: { shop, status: "approved" },
    orderBy: PUBLIC_ORDER_BY,
    take: PUBLIC_ROW_CEILING,
  });
  const scoped = prioritiseForProduct(rows, productGid);
  const start = (page - 1) * per;
  return {
    // ALL approved matching — the storefront scale number.
    total: scoped.length,
    items: scoped.slice(start, start + per).map((row) => ({
      id: row.id,
      name: row.name,
      credentials: row.credentials,
      country: row.country,
      quote: row.quote,
      imageUrl: row.imageUrl,
    })),
  };
}

function matchesResultFilters(
  row: CustomerResult,
  filters: PublicResultsFilters,
): boolean {
  if (filters.concern && (row.concern ?? "") !== filters.concern) return false;
  if (filters.age && (row.ageRange ?? "") !== filters.age) return false;
  if (filters.skin && (row.skinType ?? "") !== filters.skin) return false;
  if (filters.duration) {
    if (durationBucketOf(row.durationWeeks) !== filters.duration) return false;
  }
  return true;
}

function facetCounts(
  rows: CustomerResult[],
  valueOf: (row: CustomerResult) => string | null,
  canonicalOrder: readonly string[] | null,
): FacetCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = valueOf(row);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  if (canonicalOrder) {
    return canonicalOrder
      .filter((value) => counts.has(value))
      .map((value) => ({ value, count: counts.get(value) as number }));
  }
  // Free-form values (concerns): most common first, then alphabetical.
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, count }));
}

export async function getPublicResults(
  shop: string,
  productGid: string | null,
  filters: PublicResultsFilters,
  page: number,
  per: number,
): Promise<{
  total: number;
  verifiedTotal: number;
  items: PublicResult[];
  facets: PublicResultsFacets;
}> {
  assertProofModels();
  const rows = await prisma.customerResult.findMany({
    where: { shop, status: "approved" },
    orderBy: PUBLIC_ORDER_BY,
    take: PUBLIC_ROW_CEILING,
  });
  // The gallery card design REQUIRES at least one image; image-less rows
  // are admin-storable (testimonial/video-only) but never served publicly —
  // otherwise totals, pagination and the empty state drift from what the
  // client can actually render (v8 review finding).
  const renderable = rows.filter(
    (row) => row.beforeUrl !== null || row.afterUrl !== null,
  );
  const scoped = prioritiseForProduct(renderable, productGid);
  // Facets + verifiedTotal come from the UNfiltered product-scoped set so
  // the chip counts and the scale banner stay stable while filtering.
  const facets: PublicResultsFacets = {
    concerns: facetCounts(scoped, (row) => row.concern, null),
    ages: facetCounts(scoped, (row) => row.ageRange, AGE_RANGES),
    skins: facetCounts(scoped, (row) => row.skinType, SKIN_TYPES),
    durations: facetCounts(
      scoped,
      (row) => durationBucketOf(row.durationWeeks),
      DURATION_BUCKETS,
    ),
  };
  const verifiedTotal = scoped.filter((row) => row.verified).length;
  const filtered = scoped.filter((row) => matchesResultFilters(row, filters));
  const start = (page - 1) * per;
  return {
    // Rows matching the current filters (no filters = the full scoped set).
    total: filtered.length,
    verifiedTotal,
    items: filtered.slice(start, start + per).map((row) => ({
      id: row.id,
      source: row.source,
      verified: row.verified,
      beforeUrl: row.beforeUrl,
      afterUrl: row.afterUrl,
      ageRange: row.ageRange,
      skinType: row.skinType,
      concern: row.concern,
      durationWeeks: row.durationWeeks,
      country: row.country,
      testimonial: row.testimonial,
      videoUrl: row.videoUrl,
    })),
    facets,
  };
}

// ---------------------------------------------------------------------------
// Legacy before/after import
// ---------------------------------------------------------------------------

/**
 * One-click migration of the v3 PDP before/after metaobjects into the results
 * library: every entry becomes a CustomerResult (source=lab, verified=true,
 * approved, tagged with its product). Exactly-once per metaobject via the
 * legacyGid @unique column — re-running skips existing rows, so the button is
 * always safe to press again. Reads products through the house
 * listProductsWithBoosterStatus window (first 25, title-sorted) +
 * getProductBoosters per product.
 */
export async function importLegacyBeforeAfters(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<ImportLegacyResult> {
  assertProofModels();
  const errors: string[] = [];
  let imported = 0;
  let skipped = 0;

  // v8 review fix: cursor-paginate the WHOLE catalog (the old single
  // listProductsWithBoosterStatus call silently capped the import at the
  // first 25 products by title). Lean query: only products that actually
  // carry the legacy before_afters metafield are visited.
  const LEGACY_PAGE_QUERY = `#graphql
    query LegacyBaProducts($cursor: String) {
      products(first: 50, after: $cursor, sortKey: TITLE) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          beforeAfters: metafield(namespace: "cellexia", key: "before_afters") { id }
        }
      }
    }`;
  const withContent: { id: string; title: string }[] = [];
  let cursor: string | null = null;
  // 200 pages × 50 = 10,000 products — a safety stop, not a real limit.
  for (let pageN = 0; pageN < 200; pageN += 1) {
    const response = await admin.graphql(LEGACY_PAGE_QUERY, {
      variables: { cursor },
    });
    const body = (await response.json()) as {
      data?: {
        products?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: { id: string; title: string; beforeAfters: { id: string } | null }[];
        };
      };
      errors?: { message?: string }[];
    };
    if (body.errors?.length || !body.data?.products) {
      return {
        ok: false,
        imported,
        skipped,
        errors: [body.errors?.[0]?.message ?? "Could not enumerate products"],
      };
    }
    for (const node of body.data.products.nodes ?? []) {
      if (node.beforeAfters) withContent.push({ id: node.id, title: node.title });
    }
    if (!body.data.products.pageInfo?.hasNextPage) break;
    cursor = body.data.products.pageInfo.endCursor ?? null;
    if (!cursor) break;
  }

  for (const product of withContent) {
    const boosters = await getProductBoosters(admin, product.id);
    if (!boosters.ok) {
      errors.push(
        `${product.title}: ${boosters.errors[0] ?? "could not load before/after content"}`,
      );
      continue;
    }
    for (const entry of boosters.beforeAfters) {
      try {
        const existing = await prisma.customerResult.findUnique({
          where: { legacyGid: entry.id },
        });
        if (existing) {
          skipped += 1;
          continue;
        }
        await prisma.customerResult.create({
          data: {
            shop,
            status: "approved",
            source: "lab",
            verified: true,
            beforeUrl: entry.beforeImageUrl,
            afterUrl: entry.afterImageUrl,
            durationWeeks: entry.weeks,
            testimonial: entry.statement === "" ? null : entry.statement,
            productGids: JSON.stringify([product.id]),
            legacyGid: entry.id,
            sortWeight: await nextSortWeight("results", shop),
          },
        });
        imported += 1;
      } catch (error) {
        // A concurrent import can hit the unique constraint — that is the
        // exactly-once guarantee doing its job, not a failure.
        if (
          error instanceof Error &&
          /unique/i.test(error.message)
        ) {
          skipped += 1;
        } else {
          errors.push(
            `${product.title}: ${error instanceof Error ? error.message : "could not import an entry"}`,
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, imported, skipped, errors };
}
