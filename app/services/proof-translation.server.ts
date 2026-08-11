/**
 * v8.11: translations for proof-library entry TEXT — the proof twin of the
 * metaobject booster translation system (translation.server.ts). The proof
 * entries live in the app's OWN database (PressItem / DermEndorsement /
 * CustomerResult), so Shopify's Translations API and Translate & Adapt can
 * never see them; this module reproduces the same contract on the
 * ProofTranslation table instead:
 *
 *   - DeepL via the merchant's key (TranslationConfig — server-only);
 *   - INCREMENTAL: sourceDigest (sha256 of the source text) versions each
 *     row; only missing/outdated fields are sent, and rows marked `manual`
 *     are NEVER overwritten by auto-translation;
 *   - per-locale independent success (one failing locale never blocks the
 *     rest);
 *   - the allowlist rule: only merchant/customer PROSE is translated —
 *     names, publications, URLs, ISO country codes and concern slugs are
 *     never sent to DeepL (same spirit as TRANSLATABLE_FIELD_KEYS).
 *
 * Serving: the public proxy overlays translations by the storefront page
 * locale (exact match, then base-language prefix), falling back to the
 * source text per field — a missing translation can never blank a quote.
 */

import { createHash } from "node:crypto";
import prisma from "../db.server";
import {
  chunk,
  deeplTranslateBatch,
  deeplTargetForLocale,
  getTargetLocales,
  getTranslationConfig,
} from "./translation.server";
import { getSettings } from "../models/settings.server";
import type { ProofType } from "./proof.server";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/** v8.19: the translation system also covers the MERCHANT-EDITED
 *  endorsement copy overrides (settings.dermEndorsements.copy*) — the
 *  "copy" scope. Those live in the settings blob, not a proof table, so
 *  they get a fixed resourceId and their sources load from getSettings. */
export type ProofScope = ProofType | "copy";

/** The single resourceId of the "copy" scope (one settings section). */
export const COPY_RESOURCE_ID = "dermEndorsements";

/** Which entry fields are prose (translatable). Everything else — names,
 *  publication wordmarks, URLs, ISO codes, concern slugs — never leaves
 *  the shop's primary language. */
export const TRANSLATABLE_PROOF_FIELDS: Record<ProofScope, string[]> = {
  press: ["quote"],
  endorsements: ["quote", "credentials"],
  results: ["testimonial"],
  copy: [
    "copyEyebrow",
    "copyHeadline",
    "copyDescription",
    "copyBadgeHeadline",
    "copyBadgeLink",
    "copyBadgeNoLink",
    "copyBadgeChip",
    "copyOverlayNote",
    "copyWallCta",
    "copyOverlayIntro",
    "copyOverlayFaqTitle",
    "copyOverlayFaq1Q",
    "copyOverlayFaq1A",
    "copyOverlayFaq2Q",
    "copyOverlayFaq2A",
    "copyOverlayFaq3Q",
    "copyOverlayFaq3A",
    "copyOverlayFaq4Q",
    "copyOverlayFaq4A",
    "copyOverlayListTitle",
  ],
};

/** DB resourceType keys (singular, stable) per public proof type. */
const RESOURCE_TYPE: Record<ProofScope, string> = {
  press: "press",
  endorsements: "endorsement",
  results: "result",
  copy: "copy",
};

export function proofSourceDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function normalizeProofLocale(locale: string): string {
  return locale.trim().toLowerCase();
}

/** Shopify locales are 2-3 letter primary subtags with optional region
 *  ("fr", "pt-PT", "fil"). */
export const PROOF_LOCALE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]+)?$/;

/** Targets auto-translation can actually serve: same-base-as-primary
 *  locales (en primary → en-GB) are excluded — the source already reads
 *  natively, and counting them makes coverage look permanently short
 *  (review catch PT-3). The admin loaders use this for status + editors. */
export function translatableProofTargets(
  primary: string | null,
  targets: string[],
): string[] {
  const primaryBase = normalizeProofLocale(primary ?? "en").split("-")[0];
  return targets
    .map(normalizeProofLocale)
    .filter((locale) => locale.split("-")[0] !== primaryBase);
}

interface SourceField {
  resourceType: string;
  resourceId: string;
  field: string;
  text: string;
}

async function loadSourceFields(
  shop: string,
  types: ProofScope[],
  ids?: string[],
): Promise<SourceField[]> {
  const out: SourceField[] = [];
  const idFilter = ids && ids.length > 0 ? { id: { in: ids } } : {};
  // v8.19 "copy" scope: sources are the SAVED settings values (the same
  // canonical funnel the storefront island and the proxy overlay read, so
  // digests always agree). Blank fields have nothing to translate.
  if (
    types.includes("copy") &&
    (!ids || ids.length === 0 || ids.includes(COPY_RESOURCE_ID))
  ) {
    const endo = (await getSettings(shop)).dermEndorsements;
    for (const field of TRANSLATABLE_PROOF_FIELDS.copy) {
      const text = (endo as unknown as Record<string, unknown>)[field];
      if (typeof text === "string" && /\S/.test(text)) {
        out.push({
          resourceType: "copy",
          resourceId: COPY_RESOURCE_ID,
          field,
          text,
        });
      }
    }
  }
  if (types.includes("press")) {
    for (const row of await prisma.pressItem.findMany({ where: { shop, ...idFilter } })) {
      if (/\S/.test(row.quote)) {
        out.push({ resourceType: "press", resourceId: row.id, field: "quote", text: row.quote });
      }
    }
  }
  if (types.includes("endorsements")) {
    for (const row of await prisma.dermEndorsement.findMany({ where: { shop, ...idFilter } })) {
      if (/\S/.test(row.quote)) {
        out.push({ resourceType: "endorsement", resourceId: row.id, field: "quote", text: row.quote });
      }
      if (row.credentials && /\S/.test(row.credentials)) {
        out.push({ resourceType: "endorsement", resourceId: row.id, field: "credentials", text: row.credentials });
      }
    }
  }
  if (types.includes("results")) {
    for (const row of await prisma.customerResult.findMany({ where: { shop, ...idFilter } })) {
      if (row.testimonial && /\S/.test(row.testimonial)) {
        out.push({ resourceType: "result", resourceId: row.id, field: "testimonial", text: row.testimonial });
      }
    }
  }
  return out;
}

export interface ProofTranslateResult {
  ok: boolean;
  /** Human-readable blocking reason when ok is false (no key, no targets). */
  reason?: string;
  translated: number;
  skipped: number;
  /** Per-locale failures — the other locales still completed. */
  failures: { locale: string; error: string }[];
}

/**
 * Translate every missing/outdated proof field into every published
 * non-primary shop locale. Incremental and manual-preserving; per-locale
 * independent. `types` narrows the run (a tab's button translates its own
 * type; the auto-on-save hook passes the one type it just saved).
 */
export async function translateProofEntries(
  shop: string,
  admin: AdminGraphqlClient,
  types: ProofScope[] = ["press", "endorsements", "results", "copy"],
  /** Narrow to specific entry ids (the auto-on-save hook translates just
   *  the entry that was saved — keeps the save request fast; the copy
   *  scope's id is COPY_RESOURCE_ID). */
  ids?: string[],
): Promise<ProofTranslateResult> {
  const config = await getTranslationConfig(shop);
  if (!config.apiKey) {
    return { ok: false, reason: "No DeepL API key — add one on the Languages page.", translated: 0, skipped: 0, failures: [] };
  }
  const localesResult = await getTargetLocales(admin);
  const primary = localesResult.primary ?? "en";
  const targets = localesResult.targets.map(normalizeProofLocale);
  if (targets.length === 0) {
    return { ok: false, reason: "The shop has no published non-primary languages.", translated: 0, skipped: 0, failures: [] };
  }
  const sources = await loadSourceFields(shop, types, ids);
  if (sources.length === 0) {
    return { ok: true, translated: 0, skipped: 0, failures: [] };
  }
  const existing = await prisma.proofTranslation.findMany({
    where: {
      shop,
      ...(ids && ids.length > 0 ? { resourceId: { in: ids } } : {}),
    },
  });
  const byKey = new Map(
    existing.map((row) => [
      `${row.resourceType}\u0000${row.resourceId}\u0000${row.locale}\u0000${row.field}`,
      row,
    ]),
  );

  let translated = 0;
  let skipped = 0;
  const failures: { locale: string; error: string }[] = [];

  for (const locale of targets) {
    const targetLang = deeplTargetForLocale(locale);
    if (!targetLang) {
      skipped += sources.length;
      continue;
    }
    // Same-base target (e.g. primary en, target en-GB): the source already
    // reads natively — mirror translateResources' skip.
    if (
      normalizeProofLocale(primary).split("-")[0] === locale.split("-")[0]
    ) {
      skipped += sources.length;
      continue;
    }
    const pending: SourceField[] = [];
    for (const source of sources) {
      const row = byKey.get(
        `${source.resourceType}\u0000${source.resourceId}\u0000${locale}\u0000${source.field}`,
      );
      if (row && (row.manual || row.sourceDigest === proofSourceDigest(source.text))) {
        skipped += 1;
        continue;
      }
      pending.push(source);
    }
    if (pending.length === 0) continue;
    // Paid work must always persist (review catch PT-2): translate + WRITE
    // per 50-text chunk, so a later chunk's failure (quota, throttle,
    // timeout) never discards earlier chunks' already-billed results. A
    // failed chunk fails the LOCALE (remaining chunks skipped — a quota
    // error would fail them all anyway); the digest logic makes the retry
    // resume exactly where it stopped.
    // source_lang is deliberately OMITTED (review catch SRV-2): press
    // quotes are market-scoped, so the library legitimately mixes source
    // languages — DeepL detects per text; forcing the shop primary would
    // corrupt quotes already written in the target language.
    // v8.19: prose and copy batch SEPARATELY — proof prose must translate
    // brace-styled words (protectPlaceholders:false, v8.13b), while the
    // copy overrides carry the {n} count token that must survive DeepL
    // verbatim (protectPlaceholders:true, the metaobject convention).
    const groups = [
      {
        rows: pending.filter((source) => source.resourceType !== "copy"),
        protect: false,
      },
      {
        rows: pending.filter((source) => source.resourceType === "copy"),
        protect: true,
      },
    ];
    let localeFailed = false;
    for (const group of groups) {
      if (localeFailed) break;
      for (const slice of chunk(group.rows, 50)) {
        const batch = await deeplTranslateBatch(
          config.apiKey,
          slice.map((source) => source.text),
          targetLang,
          undefined,
          { protectPlaceholders: group.protect },
        );
        if (!batch.ok || batch.translations.length !== slice.length) {
          failures.push({ locale, error: batch.error ?? "translation batch failed" });
          localeFailed = true;
          break;
        }
        for (let i = 0; i < slice.length; i += 1) {
          const source = slice[i];
          // A whitespace-only result would re-bill forever if left unwritten
          // (review catch PT-5): store the SOURCE text instead — it is what
          // the storefront would serve anyway; the digest stops resends.
          const value = /\S/.test(batch.translations[i])
            ? batch.translations[i]
            : source.text;
          const written = await writeAutoTranslation(shop, source, locale, value);
          if (written === "written") translated += 1;
          else if (written === "manual") skipped += 1;
          else {
            failures.push({
              locale,
              error: `could not store ${source.field} for ${source.resourceId}`,
            });
          }
        }
      }
    }
  }
  return { ok: true, translated, skipped, failures };
}

/**
 * Race-safe auto write (review catch PT-1): a manual translation saved at
 * ANY point — including while a long translate run is between its snapshot
 * and its writes — must never be overwritten. The update is conditional on
 * manual:false; when nothing matches, a manual row either exists (skip) or
 * no row exists (create, tolerating the unique-violation race by retrying
 * the conditional update once).
 */
async function writeAutoTranslation(
  shop: string,
  source: SourceField,
  locale: string,
  value: string,
): Promise<"written" | "manual" | "error"> {
  const data = {
    value,
    sourceDigest: proofSourceDigest(source.text),
    manual: false,
  };
  const where = {
    shop,
    resourceType: source.resourceType,
    resourceId: source.resourceId,
    locale,
    field: source.field,
  };
  try {
    const updated = await prisma.proofTranslation.updateMany({
      where: { ...where, manual: false },
      data,
    });
    if (updated.count > 0) return "written";
    const existing = await prisma.proofTranslation.findFirst({ where });
    if (existing) return "manual"; // a manual row won the race — keep it
    try {
      await prisma.proofTranslation.create({ data: { ...where, ...data } });
      return "written";
    } catch {
      // unique violation: a row appeared concurrently — one conditional
      // retry; if that row is manual, updateMany matches nothing (correct).
      const retried = await prisma.proofTranslation.updateMany({
        where: { ...where, manual: false },
        data,
      });
      return retried.count > 0 ? "written" : "manual";
    }
  } catch {
    return "error";
  }
}

export interface ProofTranslationStatus {
  /** Translatable (source-present) fields × target locales. */
  expected: number;
  /** Rows present AND fresh (digest matches the current source). */
  fresh: number;
  /** Rows present but outdated (source changed since translation). */
  outdated: number;
  targetLocales: number;
}

/** Coverage counts for a tab's header line — cheap, DB-only (the caller
 *  supplies the target-locale count from getTargetLocales). */
export async function proofTranslationStatusFor(
  shop: string,
  type: ProofScope,
  targetLocales: string[],
): Promise<ProofTranslationStatus> {
  const targets = targetLocales.map(normalizeProofLocale);
  const sources = await loadSourceFields(shop, [type]);
  const rows = await prisma.proofTranslation.findMany({
    where: { shop, resourceType: RESOURCE_TYPE[type] },
  });
  const byKey = new Map(
    rows.map((row) => [
      `${row.resourceId}\u0000${row.locale}\u0000${row.field}`,
      row,
    ]),
  );
  let fresh = 0;
  let outdated = 0;
  for (const source of sources) {
    for (const locale of targets) {
      const row = byKey.get(`${source.resourceId}\u0000${locale}\u0000${source.field}`);
      if (!row) continue;
      if (row.manual || row.sourceDigest === proofSourceDigest(source.text)) fresh += 1;
      else outdated += 1;
    }
  }
  return {
    expected: sources.length * targets.length,
    fresh,
    outdated,
    targetLocales: targets.length,
  };
}

/**
 * Public-proxy overlay: translations for the given rendered ids in the
 * storefront page locale. Exact locale first, then base-language prefix
 * ("fr-ca" falls back to a stored "fr"). Returns
 * Map<resourceId, Record<field, value>> — absent fields fall back to the
 * source text at the call site, so a missing translation can never blank
 * an entry.
 */
export async function getProofTranslationOverlay(
  shop: string,
  type: ProofScope,
  ids: string[],
  locale: string,
  /** Current source text per (id, field) — when provided, rows whose
   *  sourceDigest no longer matches are SKIPPED (review catch SRV-1: an
   *  edited entry must serve its new primary text, never a translation of
   *  the old text, until re-translated). */
  sources?: Map<string, Record<string, string>>,
): Promise<Map<string, Record<string, string>>> {
  const overlay = new Map<string, Record<string, string>>();
  if (ids.length === 0) return overlay;
  const wanted = normalizeProofLocale(locale);
  if (!wanted) return overlay;
  const base = wanted.split("-")[0];
  const rows = await prisma.proofTranslation.findMany({
    where: {
      shop,
      resourceType: RESOURCE_TYPE[type],
      resourceId: { in: ids },
      locale: wanted === base ? wanted : { in: [wanted, base] },
    },
  });
  // exact-locale rows win: process base-language rows first so an exact
  // row written later overwrites the same field
  const ranked = rows.sort(
    (a, b) => Number(a.locale === wanted) - Number(b.locale === wanted),
  );
  for (const row of ranked) {
    if (sources) {
      const current = sources.get(row.resourceId)?.[row.field];
      if (
        typeof current === "string" &&
        proofSourceDigest(current) !== row.sourceDigest
      ) {
        continue; // stale — the (new) source text serves until re-translated
      }
    }
    const fields = overlay.get(row.resourceId) ?? {};
    fields[row.field] = row.value;
    overlay.set(row.resourceId, fields);
  }
  return overlay;
}

/** Manual review: save (or clear) one translation. Blank value DELETES the
 *  row (the storefront falls back to the source text); a saved value is
 *  marked manual and auto-translation never touches it again. */
export async function saveManualProofTranslation(
  shop: string,
  type: ProofScope,
  resourceId: string,
  locale: string,
  field: string,
  value: string,
  sourceText: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!TRANSLATABLE_PROOF_FIELDS[type]?.includes(field)) {
    return { ok: false, error: `"${field}" is not a translatable ${type} field` };
  }
  const normalized = normalizeProofLocale(locale);
  if (!PROOF_LOCALE_PATTERN.test(normalized)) {
    return { ok: false, error: "Invalid locale" };
  }
  const trimmed = value.trim();
  const where = {
    shop_resourceType_resourceId_locale_field: {
      shop,
      resourceType: RESOURCE_TYPE[type],
      resourceId,
      locale: normalized,
      field,
    },
  };
  if (trimmed === "") {
    await prisma.proofTranslation.deleteMany({
      where: {
        shop,
        resourceType: RESOURCE_TYPE[type],
        resourceId,
        locale: normalized,
        field,
      },
    });
    return { ok: true };
  }
  await prisma.proofTranslation.upsert({
    where,
    create: {
      shop,
      resourceType: RESOURCE_TYPE[type],
      resourceId,
      locale: normalized,
      field,
      value: trimmed.slice(0, 5000),
      sourceDigest: proofSourceDigest(sourceText),
      manual: true,
    },
    update: {
      value: trimmed.slice(0, 5000),
      sourceDigest: proofSourceDigest(sourceText),
      manual: true,
    },
  });
  return { ok: true };
}

/** Every stored translation for one entry (the per-item review editor). */
export async function listProofTranslationsFor(
  shop: string,
  type: ProofScope,
  resourceId: string,
): Promise<{ locale: string; field: string; value: string; manual: boolean; sourceDigest: string }[]> {
  const rows = await prisma.proofTranslation.findMany({
    where: { shop, resourceType: RESOURCE_TYPE[type], resourceId },
    orderBy: [{ locale: "asc" }, { field: "asc" }],
  });
  return rows.map((row) => ({
    locale: row.locale,
    field: row.field,
    value: row.value,
    manual: row.manual,
    sourceDigest: row.sourceDigest,
  }));
}

/** The CURRENT source text of one translatable field — read server-side by
 *  the manual-save intent so the digest is never client-trusted. */
export async function getProofSourceText(
  shop: string,
  type: ProofScope,
  resourceId: string,
  field: string,
): Promise<string | null> {
  if (!TRANSLATABLE_PROOF_FIELDS[type]?.includes(field)) return null;
  if (type === "copy") {
    if (resourceId !== COPY_RESOURCE_ID) return null;
    const endo = (await getSettings(shop)).dermEndorsements;
    const text = (endo as unknown as Record<string, unknown>)[field];
    return typeof text === "string" ? text : null;
  }
  if (type === "press") {
    const row = await prisma.pressItem.findFirst({ where: { id: resourceId, shop } });
    return row ? row.quote : null;
  }
  if (type === "endorsements") {
    const row = await prisma.dermEndorsement.findFirst({ where: { id: resourceId, shop } });
    if (!row) return null;
    return field === "credentials" ? (row.credentials ?? "") : row.quote;
  }
  const row = await prisma.customerResult.findFirst({ where: { id: resourceId, shop } });
  return row ? (row.testimonial ?? "") : null;
}

/** Batched per-item translations for a listed admin page (one query). */
export interface ProofTranslationListRow {
  locale: string;
  field: string;
  value: string;
  manual: boolean;
  /** The SOURCE changed since this row was written (review catch ADM-7 —
   *  the per-entry editor labels these; the storefront already skips them). */
  outdated: boolean;
}

export async function listProofTranslationsForMany(
  shop: string,
  type: ProofScope,
  resourceIds: string[],
): Promise<Map<string, ProofTranslationListRow[]>> {
  const out = new Map<string, ProofTranslationListRow[]>();
  if (resourceIds.length === 0) return out;
  const [rows, sources] = await Promise.all([
    prisma.proofTranslation.findMany({
      where: { shop, resourceType: RESOURCE_TYPE[type], resourceId: { in: resourceIds } },
      orderBy: [{ locale: "asc" }, { field: "asc" }],
    }),
    loadSourceFields(shop, [type], resourceIds),
  ]);
  const digestByKey = new Map(
    sources.map((s) => [`${s.resourceId} ${s.field}`, proofSourceDigest(s.text)]),
  );
  for (const row of rows) {
    const list = out.get(row.resourceId) ?? [];
    const currentDigest = digestByKey.get(`${row.resourceId} ${row.field}`);
    list.push({
      locale: row.locale,
      field: row.field,
      value: row.value,
      manual: row.manual,
      outdated: currentDigest !== undefined && currentDigest !== row.sourceDigest,
    });
    out.set(row.resourceId, list);
  }
  return out;
}

/** v8.19b: the island codes each copy field ships under — the single
 *  source of truth shared by the proxy emission and (via the storefront
 *  whitelist) endoApplyCopy. The two headline fields carry the {n} count
 *  token, mirrored to the island's @@N@@ sentinel at emission time. */
export const COPY_FIELD_ISLAND_CODES: Record<string, string> = {
  copyEyebrow: "oe",
  copyHeadline: "oh",
  copyDescription: "od",
  copyBadgeHeadline: "ob",
  copyBadgeLink: "ol",
  copyBadgeNoLink: "on",
  copyBadgeChip: "oc",
  copyOverlayNote: "ov",
};

/**
 * v8.19b: turn a copy-scope overlay result into the lean payload.copy
 * member (island codes). PURE — behaviorally pinned by the sim. Rules:
 *   - a field emits ONLY while its CURRENT source is non-blank (a blanked
 *     override must never resurrect its old translation — the storefront
 *     falls back to the catalog default);
 *   - blank translated values never emit;
 *   - the two headline fields mirror Liquid's {n} → @@N@@ replace, so the
 *     storefront JS keeps its single sentinel-substitution path.
 */
export function copyOverlayToIslandCodes(
  translated: Record<string, string>,
  sources: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, code] of Object.entries(COPY_FIELD_ISLAND_CODES)) {
    if (!/\S/.test(sources[field] ?? "")) continue;
    let value = translated[field];
    if (typeof value !== "string" || !/\S/.test(value)) continue;
    if (
      field === "copyHeadline" ||
      field === "copyBadgeHeadline" ||
      field === "copyOverlayNote"
    ) {
      value = value.split("{n}").join("@@N@@");
    }
    out[code] = value;
  }
  return out;
}

/** v8.22: the island codes of the OVERLAY-CONTENT copy fields. These have
 *  non-blank English DEFAULTS and NO locale-catalog fallback (the el.json
 *  byte wall forbids new locale keys), so — unlike COPY_FIELD_ISLAND_CODES,
 *  whose fields the Liquid island already carries in the primary language —
 *  the PROXY is their only carrier: it must serve them in EVERY language,
 *  translated when a DeepL row exists, the saved source otherwise. */
export const OVERLAY_CONTENT_ISLAND_CODES: Record<string, string> = {
  copyWallCta: "wc",
  copyOverlayIntro: "oi",
  copyOverlayFaqTitle: "fq",
  copyOverlayFaq1Q: "f1q",
  copyOverlayFaq1A: "f1a",
  copyOverlayFaq2Q: "f2q",
  copyOverlayFaq2A: "f2a",
  copyOverlayFaq3Q: "f3q",
  copyOverlayFaq3A: "f3a",
  copyOverlayFaq4Q: "f4q",
  copyOverlayFaq4A: "f4a",
  copyOverlayListTitle: "lt",
};

/**
 * v8.22: turn the overlay-content fields into payload.copy members (island
 * codes). PURE — behaviorally pinned by the sim. Rules:
 *   - a field emits ONLY while its CURRENT source is non-blank (blank =
 *     the merchant hid that piece; a stale translation must never
 *     resurrect it);
 *   - the translated value serves when non-blank, else the SOURCE serves
 *     (the proxy is the only carrier — there is no island fallback);
 *   - the three {n} fields mirror Liquid's {n} → @@N@@ replace, so the
 *     storefront JS keeps its single sentinel-substitution path.
 */
export function overlayContentToIslandCodes(
  sources: Record<string, string>,
  translated: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, code] of Object.entries(OVERLAY_CONTENT_ISLAND_CODES)) {
    const source = sources[field] ?? "";
    if (!/\S/.test(source)) continue;
    const t = translated[field];
    let value = typeof t === "string" && /\S/.test(t) ? t : source;
    if (
      field === "copyWallCta" ||
      field === "copyOverlayIntro" ||
      field === "copyOverlayListTitle"
    ) {
      value = value.split("{n}").join("@@N@@");
    }
    out[code] = value;
  }
  return out;
}

/** v8.19b: drop stored copy translations for fields a settings save just
 *  BLANKED — dead rows must not linger (they are invisible to the admin
 *  reviewer, which hides blank-source fields). */
export async function deleteCopyTranslationsForFields(
  shop: string,
  fields: string[],
): Promise<void> {
  const known = fields.filter((field) =>
    TRANSLATABLE_PROOF_FIELDS.copy.includes(field),
  );
  if (known.length === 0) return;
  await prisma.proofTranslation.deleteMany({
    where: {
      shop,
      resourceType: RESOURCE_TYPE.copy,
      resourceId: COPY_RESOURCE_ID,
      field: { in: known },
    },
  });
}

/** Entry deletion cleanup — called by proof.server's delete path. */
export async function deleteProofTranslationsFor(
  shop: string,
  type: ProofType,
  resourceId: string,
): Promise<void> {
  await prisma.proofTranslation.deleteMany({
    where: { shop, resourceType: RESOURCE_TYPE[type], resourceId },
  });
}
