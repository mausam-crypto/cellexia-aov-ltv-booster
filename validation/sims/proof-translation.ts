/**
 * v8.11 proof-translation sim — runs the REAL proof-translation.server.ts
 * (never a re-implementation) against an in-memory prisma stub, a mocked
 * DeepL batch (captures every outbound payload) and a fixed shop-locales
 * admin. Proves the translation contract the metaobject booster system
 * established, on the proof tables:
 *
 *   T1  full run translates every prose field into every target locale
 *       (press quote / endorsement quote + credentials / result
 *       testimonial), rows stored with the source digest;
 *   T2  INCREMENTAL — an unchanged second run sends ZERO texts to DeepL;
 *   T3  a changed source re-translates exactly that field;
 *   T4  manual rows are NEVER overwritten (even with a changed source);
 *   T5  per-locale independence — a failing locale records a failure while
 *       the other locales' rows still land;
 *   T6  NEVER-TRANSLATE allowlist — no publication, name, URL or ISO code
 *       ever appears in an outbound DeepL payload;
 *   T7  ids narrowing (the auto-on-save fast path) touches only the one
 *       entry;
 *   T8  overlay: exact locale beats base ("pt-pt" over "pt"); a regional
 *       request falls back to its base ("fr-ca" → stored "fr"); missing
 *       fields stay absent (the proxy falls back to source text);
 *   T9  manual save: blank value DELETES (fallback to source), invalid
 *       field/locale rejected;
 *   T10 same-base targets are skipped (primary en → en-gb sends nothing).
 *   CU1 v15.5 CURATED copy (the real copy-curated.server.ts): dictionary
 *       completeness (every locale × every English source, {n} + the
 *       two-paragraph intro preserved, no em dash), serve-time ranking
 *       fresh manual > curated > fresh auto > source, exact-source
 *       matching (an edited source never gets curated text), copy scope
 *       only, base-locale + nb/no + pt-PT resolution;
 *   CU2 the translate run WRITES curated rows (never billed to DeepL),
 *       refreshes a differing auto row, is a no-op when fresh, counts as
 *       fresh coverage, shows as "built-in" in the reviewer, and never
 *       touches a manual row.
 *
 * MUTATION TESTS (all must be CAUGHT):
 *   m1-digest-check-dropped   outdated rows never re-translate (T3)
 *   m2-manual-flag-ignored    auto overwrites manual rows (T4)
 *   m3-overlay-rank-flipped   base-language rows beat exact rows (T8)
 *   m5-curated-serve-dropped  shoppers keep the DeepL rows (CU1)
 *   m6-curated-beats-manual   curated overrides the merchant's manual (CU1)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_SRC = path.join(ROOT, "app", "services", "proof-translation.server.ts");
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;

let checks = 0;
let failures = 0;
function ok(cond: boolean, label: string): void {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error("FAIL: " + label);
  }
}

// ------------------------------------------------------------ prisma stub
type StubRow = Record<string, any>;

function matches(row: StubRow, where: StubRow): boolean {
  for (const [key, value] of Object.entries(where ?? {})) {
    if (value && typeof value === "object" && Array.isArray(value.in)) {
      if (!value.in.includes(row[key])) return false;
    } else if (row[key] !== value) {
      return false;
    }
  }
  return true;
}

function makeStub() {
  const tables: Record<string, StubRow[]> = {
    pressItem: [],
    dermEndorsement: [],
    customerResult: [],
    proofTranslation: [],
  };
  let seq = 0;
  function model(name: string) {
    return {
      async findMany(args: StubRow = {}) {
        return tables[name].filter((row) => matches(row, args.where ?? {}));
      },
      async findFirst(args: StubRow = {}) {
        return tables[name].find((row) => matches(row, args.where ?? {})) ?? null;
      },
      async upsert(args: StubRow) {
        // the composite-unique `where` shape { name_of_unique: {...fields} }
        const key = Object.values(args.where)[0] as StubRow;
        const existing = tables[name].find((row) => matches(row, key));
        if (existing) {
          Object.assign(existing, args.update);
          return existing;
        }
        seq += 1;
        const created = { id: `${name}-${seq}`, ...args.create };
        tables[name].push(created);
        return created;
      },
      async updateMany(args: StubRow) {
        let count = 0;
        for (const row of tables[name]) {
          if (matches(row, args.where ?? {})) {
            Object.assign(row, args.data);
            count += 1;
          }
        }
        return { count };
      },
      async create(args: StubRow) {
        // enforce the composite unique like the real DB would
        const dup = tables[name].find((row) =>
          ["shop", "resourceType", "resourceId", "locale", "field"].every(
            (k) => !(k in args.data) || row[k] === args.data[k],
          ) && name === "proofTranslation",
        );
        if (name === "proofTranslation" && dup) {
          throw new Error("unique violation");
        }
        seq += 1;
        const created = { id: `${name}-${seq}`, ...args.data };
        tables[name].push(created);
        return created;
      },
      async deleteMany(args: StubRow = {}) {
        const before = tables[name].length;
        tables[name] = tables[name].filter((row) => !matches(row, args.where ?? {}));
        return { count: before - tables[name].length };
      },
    };
  }
  return {
    pressItem: model("pressItem"),
    dermEndorsement: model("dermEndorsement"),
    customerResult: model("customerResult"),
    proofTranslation: model("proofTranslation"),
    _tables: tables,
    _seed(name: string, row: StubRow): StubRow {
      seq += 1;
      const full = { id: `${name}-${seq}`, ...row };
      tables[name].push(full);
      return full;
    },
  };
}

const db = makeStub();
(globalThis as any).__CX_PT_PRISMA = db;

// --------------------------------------------------- translation.server mock
interface Capture {
  texts: string[];
  targetLang: string;
  /** v8.19: the protectPlaceholders flag of this batch (copy=true, prose=false). */
  protect: boolean | undefined;
}
const captures: Capture[] = [];
let failLocales = new Set<string>();
(globalThis as any).__CX_PT_TRANSLATION = {
  deeplTranslateBatch: async (
    _key: string,
    texts: string[],
    targetLang: string,
    _source?: unknown,
    options?: { protectPlaceholders?: boolean },
  ) => {
    captures.push({ texts: [...texts], targetLang, protect: options?.protectPlaceholders });
    const hook = (globalThis as any).__CX_PT_MIDRUN;
    if (hook) await hook(targetLang, texts);
    if (failLocales.has(targetLang)) {
      return { ok: false, translations: [], error: "mock quota exceeded" };
    }
    const failNth = (globalThis as any).__CX_PT_FAIL_CHUNK;
    if (failNth && typeof failNth === "object") {
      failNth.count = (failNth.count ?? 0) + 1;
      if (failNth.count >= failNth.n) {
        return { ok: false, translations: [], error: "mock chunk failure" };
      }
    }
    const blanks = (globalThis as any).__CX_PT_BLANK_FOR ?? new Set();
    return {
      ok: true,
      translations: texts.map((t) => (blanks.has(t) ? "   " : `[${targetLang}] ${t}`)),
    };
  },
  deeplTargetForLocale: (locale: string) => {
    const map: Record<string, string> = {
      fr: "FR", de: "DE", "pt-pt": "PT-PT", "en-gb": "EN-GB", pt: "PT-PT",
    };
    return map[locale] ?? null;
  },
  deeplSourceForLocale: (locale: string) =>
    locale.split("-")[0] === "en" ? "EN" : undefined,
  getTargetLocales: async () => (globalThis as any).__CX_PT_LOCALES,
  getTranslationConfig: async () => ({
    provider: "deepl",
    apiKey: "mock-key",
    autoOnSave: true,
  }),
};
(globalThis as any).__CX_PT_LOCALES = {
  locales: [],
  primary: "en",
  targets: ["fr", "de", "pt-PT"],
  errors: undefined,
};

// v8.19: injectable settings blob for the copy scope — blank by default so
// the T-series counts are untouched; the C-series sets fields explicitly.
const copyState: Record<string, string> = {
  copyEyebrow: "", copyHeadline: "", copyDescription: "",
  copyBadgeHeadline: "", copyBadgeLink: "", copyBadgeNoLink: "",
  copyBadgeChip: "", copyOverlayNote: "",
};
(globalThis as any).__CX_PT_SETTINGS = async () => ({
  dermEndorsements: { ...copyState },
});

// ------------------------------------------------------------------- loader
const PRISMA_IMPORT = 'import prisma from "../db.server";';
const PRISMA_STUB = [
  "// validation stub — the real import is prisma from ../db.server",
  "const prisma: any = (globalThis as any).__CX_PT_PRISMA;",
  'if (!prisma) throw new Error("validation: proof-translation prisma stub not injected");',
].join("\n");

const TRANSLATION_IMPORT = [
  "import {",
  "  chunk,",
  "  deeplTranslateBatch,",
  "  deeplTargetForLocale,",
  "  getTargetLocales,",
  "  getTranslationConfig,",
  '} from "./translation.server";',
].join("\n");
const TRANSLATION_STUB = [
  "// validation stub — the DeepL batch + shop locales are mocked; the",
  "// capture list proves exactly which texts leave the app.",
  "const __t: any = (globalThis as any).__CX_PT_TRANSLATION;",
  "const chunk = <T>(items: readonly T[], size: number): T[][] => {",
  "  const out: T[][] = [];",
  "  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);",
  "  return out;",
  "};",
  "const deeplTranslateBatch: any = __t.deeplTranslateBatch;",
  "const deeplSourceForLocale: any = __t.deeplSourceForLocale;",
  "const deeplTargetForLocale: any = __t.deeplTargetForLocale;",
  "const getTargetLocales: any = __t.getTargetLocales;",
  "const getTranslationConfig: any = __t.getTranslationConfig;",
].join("\n");

const PROOF_TYPE_IMPORT = 'import type { ProofType } from "./proof.server";';
const PROOF_TYPE_REPOINT = 'import type { ProofType } from "../../../app/services/proof.server";';

// v15.5: the curated copy dictionary is a PURE module (no prisma, no
// network) — the sim runs the REAL one, repointed like ProofType.
const CURATED_IMPORT = [
  "import {",
  "  curatedCopyTranslation,",
  "  curatedTranslationsFor,",
  '} from "./copy-curated.server";',
].join("\n");
const CURATED_REPOINT = [
  "import {",
  "  curatedCopyTranslation,",
  "  curatedTranslationsFor,",
  '} from "../../../app/services/copy-curated.server";',
].join("\n");

// v8.19: the copy scope reads settings — inject an in-memory blob so the
// sim controls the merchant copy sources.
const SETTINGS_IMPORT = 'import { getSettings } from "../models/settings.server";';
const SETTINGS_STUB = [
  "// validation stub — the copy-scope sources come from an injectable blob",
  "const getSettings: any = (globalThis as any).__CX_PT_SETTINGS;",
  'if (!getSettings) throw new Error("validation: proof-translation settings stub not injected");',
].join("\n");

async function loadModel(): Promise<any> {
  const src = fs.readFileSync(SRC_PATH, "utf8");
  for (const anchor of [PRISMA_IMPORT, TRANSLATION_IMPORT, PROOF_TYPE_IMPORT, SETTINGS_IMPORT, CURATED_IMPORT]) {
    if (!src.includes(anchor)) {
      throw new Error(
        "proof-translation loader: import anchor not found — update the loader: " + anchor,
      );
    }
  }
  const stubbed = src
    .replace(PRISMA_IMPORT, PRISMA_STUB)
    .replace(TRANSLATION_IMPORT, TRANSLATION_STUB)
    .replace(PROOF_TYPE_IMPORT, PROOF_TYPE_REPOINT)
    .replace(SETTINGS_IMPORT, SETTINGS_STUB)
    .replace(CURATED_IMPORT, CURATED_REPOINT);
  const genDir = path.join(ROOT, "validation", "lib", ".gen");
  fs.mkdirSync(genDir, { recursive: true });
  // Mutant child runs write a SEPARATE basename so the repo-resident
  // proof-translation.server.real.ts never carries a mutant's source (v9 fix).
  const outPath = path.join(
    genDir,
    process.env.CX_SIM_SRC
      ? "proof-translation.server.mutant.ts"
      : "proof-translation.server.real.ts",
  );
  if (!fs.existsSync(outPath) || fs.readFileSync(outPath, "utf8") !== stubbed) {
    fs.writeFileSync(outPath, stubbed);
  }
  return await import(pathToFileURL(outPath).href);
}

const T = await loadModel();
const SHOP = "sim.myshopify.com";
const ADMIN: any = { graphql: async () => ({ json: async () => ({}) }) };

// ---------------------------------------------------------------- seeding
const press1 = db._seed("pressItem", {
  shop: SHOP, status: "approved", publication: "Vogue",
  logoUrl: "https://cdn/vogue.svg", quote: "A quiet revolution in skincare.",
  articleUrl: "https://vogue.example/a", productGids: "[]", marketHandles: "[]",
});
const press2 = db._seed("pressItem", {
  shop: SHOP, status: "approved", publication: "Elle", logoUrl: null,
  quote: "Proof-first beauty done right.", articleUrl: null,
  productGids: "[]", marketHandles: "[]",
});
const endo1 = db._seed("dermEndorsement", {
  shop: SHOP, status: "approved", name: "Dr. Anna Weiss",
  credentials: "MD, Board-certified dermatologist", country: "FR",
  quote: "The clinical data is rigorous.", imageUrl: null, productGids: "[]",
});
const result1 = db._seed("customerResult", {
  shop: SHOP, status: "approved", source: "customer", verified: true,
  beforeUrl: "https://cdn/b.jpg", afterUrl: "https://cdn/a.jpg",
  ageRange: "45-54", skinType: "dry", concern: "wrinkles", durationWeeks: 8,
  country: "DE", testimonial: "My skin looks years younger.",
  videoUrl: null, productGids: "[]", legacyGid: null,
});

// --------------------------------------------------------------- T1: full run
{
  const run = await T.translateProofEntries(SHOP, ADMIN);
  ok(run.ok === true && run.failures.length === 0, "T1: full run ok");
  // 5 prose fields (2 press quotes, endo quote + credentials, testimonial)
  // × 3 locales = 15 rows
  ok(db._tables.proofTranslation.length === 15,
    "T1: 5 fields x 3 locales stored (got " + db._tables.proofTranslation.length + ")");
  const frQuote = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceId === press1.id && r.locale === "fr" && r.field === "quote");
  ok(!!frQuote && frQuote.value === "[FR] A quiet revolution in skincare.",
    "T1: press quote translated for fr");
  ok(!!frQuote && frQuote.sourceDigest === T.proofSourceDigest(press1.quote),
    "T1: row carries the source digest");
  ok(db._tables.proofTranslation.every((r: StubRow) => r.manual === false),
    "T1: auto rows are not manual");
}

// -------------------------------------------------------- T6: allowlist purity
{
  const sent = captures.flatMap((c) => c.texts).join("\n");
  ok(!sent.includes("Vogue") && !sent.includes("Elle"),
    "T6: publications never sent to DeepL");
  ok(!sent.includes("Dr. Anna Weiss"), "T6: names never sent");
  ok(!sent.includes("https://"), "T6: URLs never sent");
  ok(!/\bFR\b|\bDE\b/.test(sent.replace(/\[.*?\]/g, "")),
    "T6: ISO country codes never sent");
}

// -------------------------------------------------------- T2: incremental
{
  const before = captures.length;
  const run = await T.translateProofEntries(SHOP, ADMIN);
  ok(run.ok === true && captures.length === before,
    "T2: unchanged second run sends nothing to DeepL");
}

// ------------------------------------------------- T3: source change re-runs
{
  press2.quote = "Proof-first beauty, refined.";
  const before = captures.length;
  const run = await T.translateProofEntries(SHOP, ADMIN);
  ok(run.translated === 3, "T3: changed quote re-translated into 3 locales (got " + run.translated + ")");
  ok(captures.length === before + 3, "T3: exactly one batch per locale");
  const de = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceId === press2.id && r.locale === "de" && r.field === "quote");
  ok(!!de && de.value === "[DE] Proof-first beauty, refined.", "T3: new value stored");
}

// ------------------------------------------------------ T4: manual preserved
{
  const manualSave = await T.saveManualProofTranslation(
    SHOP, "press", press1.id, "fr", "quote",
    "Une révolution discrète du soin.", press1.quote);
  ok(manualSave.ok === true, "T4: manual save ok");
  press1.quote = "A quiet revolution in skincare, proven.";
  await T.translateProofEntries(SHOP, ADMIN);
  const fr = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceId === press1.id && r.locale === "fr" && r.field === "quote");
  ok(!!fr && fr.manual === true && fr.value === "Une révolution discrète du soin.",
    "T4: manual row survives auto-translation after a source change");
  const de = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceId === press1.id && r.locale === "de" && r.field === "quote");
  ok(!!de && de.value === "[DE] A quiet revolution in skincare, proven.",
    "T4: non-manual locales still updated");
}

// ------------------------------------------- T5: per-locale independence
{
  press2.quote = "Proof-first beauty, perfected.";
  failLocales = new Set(["DE"]);
  const run = await T.translateProofEntries(SHOP, ADMIN);
  failLocales = new Set();
  ok(run.failures.length === 1 && run.failures[0].locale === "de",
    "T5: the failing locale is reported");
  const fr = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceId === press2.id && r.locale === "fr" && r.field === "quote");
  ok(!!fr && fr.value === "[FR] Proof-first beauty, perfected.",
    "T5: other locales still landed");
  const de = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceId === press2.id && r.locale === "de" && r.field === "quote");
  ok(!!de && de.value === "[DE] Proof-first beauty, refined.",
    "T5: the failed locale keeps its previous value");
  await T.translateProofEntries(SHOP, ADMIN); // heal for later cases
}

// ------------------------------------------------------- T7: ids narrowing
{
  endo1.quote = "The clinical data is exceptionally rigorous.";
  result1.testimonial = "My skin looks a decade younger.";
  const before = db._tables.proofTranslation.map((r: StubRow) => r.value).join("|");
  await T.translateProofEntries(SHOP, ADMIN, ["endorsements", "results"], [endo1.id]);
  const endoDe = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceId === endo1.id && r.locale === "de" && r.field === "quote");
  ok(!!endoDe && endoDe.value === "[DE] The clinical data is exceptionally rigorous.",
    "T7: narrowed run updates the named entry");
  const resFr = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceId === result1.id && r.locale === "fr" && r.field === "testimonial");
  ok(!!resFr && resFr.value === "[FR] My skin looks years younger.",
    "T7: entries outside the ids filter untouched");
  void before;
  await T.translateProofEntries(SHOP, ADMIN); // heal
}

// ------------------------------------------------------------ T8: overlay
{
  // seed a pt base row + a pt-pt exact row for the same field
  db._seed("proofTranslation", {
    shop: SHOP, resourceType: "press", resourceId: press1.id,
    locale: "pt", field: "quote", value: "PT BASE", sourceDigest: "x", manual: false,
  });
  const overlay = await T.getProofTranslationOverlay(SHOP, "press", [press1.id], "pt-pt");
  ok(overlay.get(press1.id)?.quote === "[PT-PT] A quiet revolution in skincare, proven.",
    "T8: exact locale beats the base row");
  const fallback = await T.getProofTranslationOverlay(SHOP, "press", [press1.id], "fr-ca");
  ok(fallback.get(press1.id)?.quote === "Une révolution discrète du soin.",
    "T8: regional request falls back to the stored base language");
  const missing = await T.getProofTranslationOverlay(SHOP, "press", [press1.id], "ja");
  ok(!missing.get(press1.id), "T8: unknown locale -> empty overlay (source text serves)");
}

// -------------------------------------------------------- T9: manual save edge
{
  const bad = await T.saveManualProofTranslation(
    SHOP, "press", press1.id, "fr", "publication", "X", "Vogue");
  ok(bad.ok === false, "T9: non-allowlisted field rejected");
  const badLocale = await T.saveManualProofTranslation(
    SHOP, "press", press1.id, "not a locale", "quote", "X", press1.quote);
  ok(badLocale.ok === false, "T9: malformed locale rejected");
  const cleared = await T.saveManualProofTranslation(
    SHOP, "press", press1.id, "fr", "quote", "   ", press1.quote);
  ok(cleared.ok === true, "T9: blank save accepted as a clear");
  const fr = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceId === press1.id && r.locale === "fr" && r.field === "quote");
  ok(!fr, "T9: blank value DELETES the row (source text serves)");
}

// ---------------------------------------------------- T10: same-base skip
{
  (globalThis as any).__CX_PT_LOCALES = {
    locales: [], primary: "en", targets: ["en-GB"], errors: undefined,
  };
  const before = captures.length;
  const run = await T.translateProofEntries(SHOP, ADMIN);
  ok(run.ok === true && captures.length === before,
    "T10: same-base target sends nothing to DeepL");
  (globalThis as any).__CX_PT_LOCALES = {
    locales: [], primary: "en", targets: ["fr", "de", "pt-PT"], errors: undefined,
  };
}

// --- T11: RACE — a manual row saved MID-RUN is never clobbered ------------------------
{
  press2.quote = "Proof-first beauty, race edition.";
  let fired = false;
  (globalThis as any).__CX_PT_MIDRUN = async (targetLang: string) => {
    if (targetLang === "FR" && !fired) {
      fired = true;
      // a merchant saves a manual French quote while the run is in flight
      await T.saveManualProofTranslation(
        SHOP, "press", press2.id, "fr", "quote",
        "La beauté par la preuve.", press2.quote);
    }
  };
  await T.translateProofEntries(SHOP, ADMIN, ["press"]);
  (globalThis as any).__CX_PT_MIDRUN = null;
  const fr = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceId === press2.id && r.locale === "fr" && r.field === "quote");
  ok(!!fr && fr.manual === true && fr.value === "La beauté par la preuve.",
    "T11: mid-run manual save survives the in-flight auto run");
  await T.translateProofEntries(SHOP, ADMIN); // heal other locales
}

// --- T12: whitespace-only result stores the SOURCE (never re-billed) ------------------
{
  press2.quote = "Proof-first beauty, blank edition.";
  (globalThis as any).__CX_PT_BLANK_FOR = new Set([press2.quote]);
  await T.translateProofEntries(SHOP, ADMIN, ["press"]);
  (globalThis as any).__CX_PT_BLANK_FOR = null;
  const de = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceId === press2.id && r.locale === "de" && r.field === "quote");
  ok(!!de && de.value === press2.quote,
    "T12: blank DeepL result stores the source text");
  const before = captures.length;
  await T.translateProofEntries(SHOP, ADMIN, ["press"]);
  ok(captures.length === before, "T12b: nothing re-sent (digest stops the re-bill)");
}

// --- T13: chunked persistence — an early chunk survives a later chunk's failure -------
{
  const bulkShop = "bulk.myshopify.com";
  for (let i = 0; i < 55; i += 1) {
    db._seed("pressItem", {
      shop: bulkShop, status: "approved", publication: "P" + i, logoUrl: null,
      quote: "Bulk quote number " + i + ".", articleUrl: null,
      productGids: "[]", marketHandles: "[]",
    });
  }
  (globalThis as any).__CX_PT_LOCALES = {
    locales: [], primary: "en", targets: ["fr"], errors: undefined,
  };
  (globalThis as any).__CX_PT_FAIL_CHUNK = { n: 2, count: 0 }; // second 50-text chunk fails
  const run = await T.translateProofEntries(bulkShop, ADMIN, ["press"]);
  (globalThis as any).__CX_PT_FAIL_CHUNK = undefined;
  const stored = db._tables.proofTranslation.filter(
    (r: StubRow) => r.shop === bulkShop && r.locale === "fr");
  ok(stored.length === 50,
    "T13: the first chunk's 50 rows persist despite the second chunk failing (got " + stored.length + ")");
  ok(run.failures.length === 1, "T13b: the failed chunk is reported");
  const before = captures.length;
  const resume = await T.translateProofEntries(bulkShop, ADMIN, ["press"]);
  ok(resume.translated === 5 && captures.length === before + 1,
    "T13c: the retry resumes with ONLY the missing 5 texts (one small chunk)");
  (globalThis as any).__CX_PT_LOCALES = {
    locales: [], primary: "en", targets: ["fr", "de", "pt-PT"], errors: undefined,
  };
}

// --- T14: overlay staleness guard + 3-letter locales ----------------------------------
{
  // stale: source changed after translation; overlay given current sources skips the row
  const sources = new Map([[press1.id, { quote: "A COMPLETELY NEW QUOTE." }]]);
  const stale = await T.getProofTranslationOverlay(SHOP, "press", [press1.id], "de", sources);
  ok(!stale.get(press1.id)?.quote,
    "T14: digest-mismatched row is skipped (new source text serves)");
  const fresh = await T.getProofTranslationOverlay(
    SHOP, "press", [press1.id], "de",
    new Map([[press1.id, { quote: press1.quote }]]));
  ok(!!fresh.get(press1.id)?.quote, "T14b: matching digest still serves");
  // 3-letter Shopify locale accepted for manual review (e.g. fil)
  const fil = await T.saveManualProofTranslation(
    SHOP, "press", press1.id, "fil", "quote", "Sipi ng balita.", press1.quote);
  ok(fil.ok === true, "T14c: 3-letter locale accepted");
  // targets filter: same-base excluded
  const filtered = T.translatableProofTargets("en", ["fr", "en-GB", "de"]);
  ok(filtered.join(",") === "fr,de",
    "T14d: same-base-as-primary targets excluded from admin coverage");
}

// ==================================================== copy scope (C, v8.19)
//
// The merchant endorsement-copy overrides ride the SAME system: settings-
// backed sources, resourceType "copy", {n} protected through DeepL while
// proof prose stays unprotected, digest staleness, manual saves.

// --- C1: copy fields translate into every locale, {n} protected ---------------------
{
  copyState.copyHeadline = "Loved by {n} experts";
  copyState.copyBadgeChip = "Certified specialists";
  const before = db._tables.proofTranslation.length;
  const run = await T.translateProofEntries(SHOP, ADMIN, ["copy"]);
  ok(run.ok === true && run.failures.length === 0, "C1: copy run ok");
  ok(db._tables.proofTranslation.length === before + 6,
    "C1: 2 non-blank copy fields x 3 locales stored (got +" +
    (db._tables.proofTranslation.length - before) + ")");
  const frHead = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceType === "copy" && r.resourceId === T.COPY_RESOURCE_ID &&
      r.locale === "fr" && r.field === "copyHeadline");
  ok(!!frHead && frHead.value === "[FR] Loved by {n} experts",
    "C1: copy row stored under resourceType copy / the fixed resourceId");
  ok(!!frHead && frHead.sourceDigest === T.proofSourceDigest("Loved by {n} experts"),
    "C1: copy row carries the source digest");
  const copyBatches = captures.filter((c) => c.texts.includes("Loved by {n} experts"));
  ok(copyBatches.length === 3 && copyBatches.every((c) => c.protect === true),
    "C1: copy batches run WITH placeholder protection ({n} must survive DeepL)");
}

// --- C2: incremental — an unchanged copy run sends nothing --------------------------
{
  const before = captures.length;
  const run = await T.translateProofEntries(SHOP, ADMIN, ["copy"]);
  ok(run.ok === true && captures.length === before,
    "C2: unchanged copy run sends nothing to DeepL");
}

// --- C3: mixed run — prose stays UNprotected while copy is protected ----------------
{
  endo1.quote = "The {trial} data is rigorous."; // brace-styled PROSE word
  copyState.copyBadgeHeadline = "Backed by {n} pros";
  await T.translateProofEntries(SHOP, ADMIN, ["endorsements", "copy"]);
  const proseBatch = captures.find((c) => c.texts.includes("The {trial} data is rigorous."));
  const copyBatch = captures.find((c) => c.texts.includes("Backed by {n} pros"));
  ok(!!proseBatch && proseBatch.protect === false,
    "C3: prose batches stay unprotected (brace-styled words must translate)");
  ok(!!copyBatch && copyBatch.protect === true, "C3: copy batches stay protected");
  ok(!proseBatch || !proseBatch.texts.includes("Backed by {n} pros"),
    "C3: prose and copy never share a batch");
}

// --- C4: overlay freshness — stale copy serves the new primary text -----------------
{
  const overlay = await T.getProofTranslationOverlay(
    SHOP, "copy", [T.COPY_RESOURCE_ID], "fr",
    new Map([[T.COPY_RESOURCE_ID, { copyHeadline: "Loved by {n} experts" }]]),
  );
  ok(overlay.get(T.COPY_RESOURCE_ID)?.copyHeadline === "[FR] Loved by {n} experts",
    "C4: fresh copy translation serves");
  const stale = await T.getProofTranslationOverlay(
    SHOP, "copy", [T.COPY_RESOURCE_ID], "fr",
    new Map([[T.COPY_RESOURCE_ID, { copyHeadline: "EDITED source" }]]),
  );
  ok(stale.get(T.COPY_RESOURCE_ID)?.copyHeadline === undefined,
    "C4: digest-stale copy row is skipped (new primary text serves)");
}

// --- C5: manual copy translations — save, protect from auto, blank deletes ----------
{
  const saved = await T.saveManualProofTranslation(
    SHOP, "copy", T.COPY_RESOURCE_ID, "fr", "copyHeadline",
    "Adoré par {n} experts", "Loved by {n} experts");
  ok(saved.ok === true, "C5: manual copy translation saves");
  const before = captures.length;
  copyState.copyHeadline = "Loved by {n} skin experts"; // source changes
  await T.translateProofEntries(SHOP, ADMIN, ["copy"]);
  const frRow = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceType === "copy" && r.locale === "fr" && r.field === "copyHeadline");
  ok(!!frRow && frRow.value === "Adoré par {n} experts" && frRow.manual === true,
    "C5: manual copy row survives a source change + re-run");
  ok(captures.length > before, "C5: the other locales still re-translated");
  const bad = await T.saveManualProofTranslation(
    SHOP, "copy", T.COPY_RESOURCE_ID, "fr", "badgeStyle", "x", "y");
  ok(bad.ok === false, "C5: non-copy field rejected");
  const cleared = await T.saveManualProofTranslation(
    SHOP, "copy", T.COPY_RESOURCE_ID, "fr", "copyHeadline", "", "whatever");
  ok(cleared.ok === true && !db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceType === "copy" && r.locale === "fr" && r.field === "copyHeadline"),
    "C5: blank manual value deletes the row (source serves)");
}

// --- C7: emission mapping — island codes, @@N@@ mirror, blank-source guard ----------
{
  const sources = {
    copyEyebrow: "Trusted", copyHeadline: "Loved by {n} of {n} experts",
    copyDescription: "Desc", copyBadgeHeadline: "Backed by {n} pros",
    copyBadgeLink: "See {n} reviews", copyBadgeNoLink: "Verified", copyBadgeChip: "Chip",
    copyOverlayNote: "All {n} endorsements verified",
  };
  const translated = {
    copyEyebrow: "FR-eyebrow", copyHeadline: "Aimé par {n} sur {n} experts",
    copyDescription: "FR-desc", copyBadgeHeadline: "Soutenu par {n} pros",
    copyBadgeLink: "Voir les {n} avis", copyBadgeNoLink: "FR-verified", copyBadgeChip: "FR-chip",
    copyOverlayNote: "Les {n} recommandations vérifiées",
  };
  const out = T.copyOverlayToIslandCodes(translated, sources);
  ok(JSON.stringify(Object.keys(out).sort()) === JSON.stringify(["ob", "oc", "od", "oe", "oh", "ol", "on", "ov"]),
    "C7: every field emits under its island code");
  ok(out.oh === "Aimé par @@N@@ sur @@N@@ experts" && out.ob === "Soutenu par @@N@@ pros",
    "C7: BOTH headline fields mirror every {n} to @@N@@");
  ok(out.ov === "Les @@N@@ recommandations vérifiées",
    "C7: the overlay note mirrors {n} to @@N@@ too (v8.21)");
  ok(out.ol === "Voir les {n} avis",
    "C7: non-headline fields keep {n} verbatim (no consumer)");
  const blankedOut = T.copyOverlayToIslandCodes(translated, { ...sources, copyHeadline: "" });
  ok(blankedOut.oh === undefined && blankedOut.oe === "FR-eyebrow",
    "C7: a BLANKED source field never emits (its old translation is dead)");
  const blankValue = T.copyOverlayToIslandCodes({ ...translated, copyEyebrow: "   " }, sources);
  ok(blankValue.oe === undefined, "C7: blank translated values never emit");
}

// --- OC1: v8.22 overlay-content emission — translated-else-source, {n} mirror -------
{
  const sources = {
    copyWallCta: "Read all {n} endorsements",
    copyOverlayIntro: "Where the {n} recommendations come from.",
    copyOverlayFaqTitle: "Common questions",
    copyOverlayFaq1Q: "Who?", copyOverlayFaq1A: "Licensed dermatologists.",
    copyOverlayFaq2Q: "", copyOverlayFaq2A: "",
    copyOverlayFaq3Q: "", copyOverlayFaq3A: "",
    copyOverlayFaq4Q: "", copyOverlayFaq4A: "",
    copyOverlayListTitle: "All {n} dermatologists",
  };
  const translated = {
    copyOverlayIntro: "D'où viennent les {n} recommandations.",
    copyOverlayFaq1Q: "Qui ?",
  };
  const out = T.overlayContentToIslandCodes(sources, translated);
  ok(JSON.stringify(Object.keys(out).sort()) === JSON.stringify(["f1a", "f1q", "fq", "lt", "oi", "wc"]),
    "OC1: only non-blank sources emit, each under its island code");
  ok(out.oi === "D'où viennent les @@N@@ recommandations.",
    "OC1: a translated value wins and mirrors {n} to @@N@@");
  ok(out.wc === "Read all @@N@@ endorsements" && out.lt === "All @@N@@ dermatologists",
    "OC1: untranslated fields serve their SOURCE (the proxy is the only carrier) with the mirror");
  ok(out.f1q === "Qui ?" && out.f1a === "Licensed dermatologists.",
    "OC1: FAQ fields resolve independently (translated q, source a) and keep {n}-free text verbatim");
  const blankT = T.overlayContentToIslandCodes(sources, { copyOverlayFaqTitle: "   " });
  ok(blankT.fq === "Common questions",
    "OC1: a blank translated value falls back to the source, never emits blank");
  const hidden = T.overlayContentToIslandCodes({ ...sources, copyOverlayIntro: "" }, translated);
  ok(hidden.oi === undefined,
    "OC1: a BLANKED source hides the piece — its old translation can never resurrect it");
}

// --- C8: blanked source digest-mismatches its stored row (overlay belt) -------------
{
  const stale = await T.getProofTranslationOverlay(
    SHOP, "copy", [T.COPY_RESOURCE_ID], "de",
    new Map([[T.COPY_RESOURCE_ID, { copyBadgeChip: "" }]]),
  );
  ok(stale.get(T.COPY_RESOURCE_ID)?.copyBadgeChip === undefined,
    "C8: blank-source digest mismatch skips the stored chip row");
  const dead = await T.deleteCopyTranslationsForFields(SHOP, ["copyBadgeChip", "notAField"]);
  ok(dead === undefined && !db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceType === "copy" && r.field === "copyBadgeChip"),
    "C8: blank-save cleanup deletes the field's copy rows (unknown fields ignored)");
}

// --- CU1: v15.5 CURATED copy — serve-time ranking manual > curated > auto > source --
const CUR = await import(
  pathToFileURL(path.join(ROOT, "app", "services", "copy-curated.server.ts")).href
);
{
  const SRC = "Common questions"; // a real curated source (overlay FAQ heading)
  const frCurated = CUR.curatedCopyTranslation("fr", SRC);
  ok(typeof frCurated === "string" && frCurated.length > 0 && frCurated !== SRC,
    "CU1: the real dictionary carries a French translation of the FAQ heading");
  ok(CUR.curatedCopyTranslation("fr", "Some text nobody curated") === null,
    "CU1: an unknown source text has no curated translation (DeepL path)");
  ok(CUR.curatedCopyTranslation("FR", SRC) === frCurated &&
     CUR.curatedCopyTranslation("fr-ca", SRC) === frCurated,
    "CU1: locale lookup is case-insensitive and falls back to the base language");
  ok(CUR.curatedCopyTranslation("pt-PT", SRC) !== null && CUR.curatedCopyTranslation("nb", SRC) !== null &&
     CUR.curatedCopyTranslation("no", SRC) === CUR.curatedCopyTranslation("nb", SRC),
    "CU1: regional (pt-PT) and Norwegian twins (nb/no) resolve");
  ok(!/—/.test(JSON.stringify(CUR.CURATED_COPY_TRANSLATIONS)) &&
     !/—/.test(JSON.stringify(CUR.CURATED_COPY_SOURCES)),
    "CU1: no em dash anywhere in the curated dictionary or its English sources");
  // every locale table covers every English source, {n} preserved
  const srcTexts: string[] = Object.values(CUR.CURATED_COPY_SOURCES);
  let complete = true;
  let tokensOk = true;
  for (const [loc, table] of Object.entries(CUR.CURATED_COPY_TRANSLATIONS) as [string, Record<string, string>][]) {
    for (const s of srcTexts) {
      const v = table[s];
      if (typeof v !== "string" || !/\S/.test(v)) { complete = false; console.error("CU1 missing", loc, s.slice(0, 30)); }
      else if ((s.includes("{n}") ? 1 : 0) !== (v.split("{n}").length - 1 > 0 ? 1 : 0)) { tokensOk = false; console.error("CU1 token", loc, s.slice(0, 30)); }
      if (s.includes("\n\n") && typeof v === "string" && v.split("\n\n").length !== 2) { tokensOk = false; console.error("CU1 paragraphs", loc); }
    }
  }
  ok(complete, "CU1: every curated locale table translates every English source");
  ok(tokensOk, "CU1: {n} tokens and the two-paragraph intro survive in every curated string");

  // seed an OLD auto (DeepL) row for fr with a different value — the
  // storefront must serve the curated text instead
  db._seed("proofTranslation", {
    shop: SHOP, resourceType: "copy", resourceId: T.COPY_RESOURCE_ID, locale: "fr",
    field: "copyOverlayFaqTitle", value: "[FR] Common questions",
    sourceDigest: T.proofSourceDigest(SRC), manual: false,
  });
  const served = await T.getProofTranslationOverlay(
    SHOP, "copy", [T.COPY_RESOURCE_ID], "fr",
    new Map([[T.COPY_RESOURCE_ID, { copyOverlayFaqTitle: SRC }]]),
  );
  ok(served.get(T.COPY_RESOURCE_ID)?.copyOverlayFaqTitle === frCurated,
    "CU1: curated beats a fresh auto (DeepL) row at serve time");
  const noRow = await T.getProofTranslationOverlay(
    SHOP, "copy", [T.COPY_RESOURCE_ID], "de",
    new Map([[T.COPY_RESOURCE_ID, { copyOverlayFaqTitle: SRC }]]),
  );
  ok(noRow.get(T.COPY_RESOURCE_ID)?.copyOverlayFaqTitle === CUR.curatedCopyTranslation("de", SRC),
    "CU1: curated serves even when NO row exists (a deploy fixes shoppers at once)");
  const edited = await T.getProofTranslationOverlay(
    SHOP, "copy", [T.COPY_RESOURCE_ID], "de",
    new Map([[T.COPY_RESOURCE_ID, { copyOverlayFaqTitle: "Common questions (edited)" }]]),
  );
  ok(edited.get(T.COPY_RESOURCE_ID)?.copyOverlayFaqTitle === undefined,
    "CU1: an EDITED source stops matching — curated never serves for merchant wording");
  const prose = await T.getProofTranslationOverlay(
    SHOP, "endorsements", [endo1.id], "fr",
    new Map([[endo1.id, { quote: SRC }]]),
  );
  ok(prose.get(endo1.id)?.quote === undefined,
    "CU1: curated applies to the copy scope only (a quote equal to a source text is untouched)");
  // manual wins over curated; blank-delete falls back to curated
  await T.saveManualProofTranslation(
    SHOP, "copy", T.COPY_RESOURCE_ID, "fr", "copyOverlayFaqTitle", "Vos questions", SRC);
  const manual = await T.getProofTranslationOverlay(
    SHOP, "copy", [T.COPY_RESOURCE_ID], "fr",
    new Map([[T.COPY_RESOURCE_ID, { copyOverlayFaqTitle: SRC }]]),
  );
  ok(manual.get(T.COPY_RESOURCE_ID)?.copyOverlayFaqTitle === "Vos questions",
    "CU1: a fresh MANUAL row beats curated");
  await T.saveManualProofTranslation(
    SHOP, "copy", T.COPY_RESOURCE_ID, "fr", "copyOverlayFaqTitle", "", SRC);
  const back = await T.getProofTranslationOverlay(
    SHOP, "copy", [T.COPY_RESOURCE_ID], "fr",
    new Map([[T.COPY_RESOURCE_ID, { copyOverlayFaqTitle: SRC }]]),
  );
  ok(back.get(T.COPY_RESOURCE_ID)?.copyOverlayFaqTitle === frCurated,
    "CU1: clearing the manual row falls back to curated");
}

// --- CU2: v15.5 CURATED copy — translate run writes curated, never bills DeepL ------
{
  const SRC = "Common questions";
  copyState.copyOverlayFaqTitle = SRC;
  const before = captures.length;
  const run = await T.translateProofEntries(SHOP, ADMIN, ["copy"], [T.COPY_RESOURCE_ID]);
  ok(run.ok === true, "CU2: copy run ok");
  const sent = captures.slice(before).flatMap((c) => c.texts);
  ok(!sent.includes(SRC), "CU2: a curated source is never sent to DeepL");
  const rows = db._tables.proofTranslation.filter(
    (r: StubRow) => r.resourceType === "copy" && r.field === "copyOverlayFaqTitle");
  const locales = rows.map((r: StubRow) => r.locale).sort().join(",");
  ok(locales === "de,fr,pt-pt", "CU2: curated auto rows written for every target locale (" + locales + ")");
  ok(rows.every((r: StubRow) => r.manual === false &&
       r.value === CUR.curatedCopyTranslation(r.locale, SRC) &&
       r.sourceDigest === T.proofSourceDigest(SRC)),
    "CU2: rows carry the curated value + current digest (the reviewer and the storefront agree)");
  const before2 = captures.length;
  const run2 = await T.translateProofEntries(SHOP, ADMIN, ["copy"], [T.COPY_RESOURCE_ID]);
  ok(run2.translated === 0 && captures.length === before2,
    "CU2: an unchanged second run is a no-op (curated rows are fresh)");
  // status + reviewer views
  const status = await T.proofTranslationStatusFor(SHOP, "copy", ["fr", "de", "pt-PT"]);
  ok(status.outdated === 0 && status.fresh >= 3,
    "CU2: curated coverage counts as fresh");
  const listed = await T.listProofTranslationsForMany(SHOP, "copy", [T.COPY_RESOURCE_ID]);
  const frRow = (listed.get(T.COPY_RESOURCE_ID) ?? []).find(
    (r: any) => r.locale === "fr" && r.field === "copyOverlayFaqTitle");
  ok(!!frRow && frRow.curated === true && frRow.value === CUR.curatedCopyTranslation("fr", SRC),
    "CU2: the reviewer shows the built-in translation");
  await T.saveManualProofTranslation(
    SHOP, "copy", T.COPY_RESOURCE_ID, "fr", "copyOverlayFaqTitle", "Vos questions", SRC);
  const listed2 = await T.listProofTranslationsForMany(SHOP, "copy", [T.COPY_RESOURCE_ID]);
  const frRow2 = (listed2.get(T.COPY_RESOURCE_ID) ?? []).find(
    (r: any) => r.locale === "fr" && r.field === "copyOverlayFaqTitle");
  ok(!!frRow2 && frRow2.manual === true && !frRow2.curated && frRow2.value === "Vos questions",
    "CU2: a manual row is shown as manual (never overlaid by curated)");
  const before3 = captures.length;
  await T.translateProofEntries(SHOP, ADMIN, ["copy"], [T.COPY_RESOURCE_ID]);
  const frAfter = db._tables.proofTranslation.find(
    (r: StubRow) => r.resourceType === "copy" && r.locale === "fr" && r.field === "copyOverlayFaqTitle");
  ok(!!frAfter && frAfter.manual === true && frAfter.value === "Vos questions" && captures.length === before3,
    "CU2: a translate run never overwrites the manual row with curated");
  // cleanup for the later cases
  await T.saveManualProofTranslation(
    SHOP, "copy", T.COPY_RESOURCE_ID, "fr", "copyOverlayFaqTitle", "", SRC);
  await T.deleteCopyTranslationsForFields(SHOP, ["copyOverlayFaqTitle"]);
  delete copyState.copyOverlayFaqTitle;
}

// --- C6: id narrowing keeps the fast paths disjoint ---------------------------------
{
  copyState.copyEyebrow = "Trusted by experts";
  const before = captures.length;
  await T.translateProofEntries(SHOP, ADMIN, ["endorsements", "copy"], [endo1.id]);
  const sentAfter = captures.slice(before).flatMap((c) => c.texts).join("\n");
  ok(!sentAfter.includes("Trusted by experts"),
    "C6: an entry-scoped run never sends copy fields");
  const before2 = captures.length;
  await T.translateProofEntries(SHOP, ADMIN, ["endorsements", "copy"], [T.COPY_RESOURCE_ID]);
  const sentAfter2 = captures.slice(before2).flatMap((c) => c.texts).join("\n");
  ok(sentAfter2.includes("Trusted by experts") && !sentAfter2.includes("rigorous"),
    "C6: a copy-scoped run sends only copy fields");
}

// ----------------------------------------------------------------- mutants
if (!process.env.CX_SIM_SRC) {
  const { createRequire } = await import("node:module");
  const require2 = createRequire(import.meta.url);
  const { runMutants } = require2("./lib/mutants.cjs");
  const shimPath = path.join(ROOT, "validation", "sims", "lib", "tsx-shim.cjs");
  process.env.CX_TSX_SUITE = fileURLToPath(import.meta.url);
  const failed = runMutants({
    selfPath: shimPath,
    srcPath: REAL_SRC,
    mutants: [
      {
        name: "m1-digest-check-dropped",
        find: "row.sourceDigest === proofSourceDigest(source.text)",
        replace: "true",
      },
      {
        // v8.19: copy loses its {n} protection — C1/C3 pin the flag.
        name: "m4-copy-protect-dropped",
        find: "        rows: pending.filter((source) => source.resourceType === \"copy\"),\n        protect: true,",
        replace: "        rows: pending.filter((source) => source.resourceType === \"copy\"),\n        protect: false,",
      },
      {
        // v8.19b: the blank-source emission guard dropped — a blanked
        // override would resurrect its old translation (C7 catches).
        name: "m5-copy-blank-source-emitted",
        find: "    if (!/\\S/.test(sources[field] ?? \"\")) continue;",
        replace: "",
      },
      {
        name: "m2-manual-flag-ignored",
        find: "      if (row && row.manual) {\n        skipped += 1;\n        continue;\n      }",
        replace: "      if (row && row.manual && false) {\n        skipped += 1;\n        continue;\n      }",
      },
      {
        name: "m4-race-write-unconditional",
        find: "    const updated = await prisma.proofTranslation.updateMany({\n      where: { ...where, manual: false },",
        replace: "    const updated = await prisma.proofTranslation.updateMany({\n      where: { ...where },",
      },
      {
        name: "m3-overlay-rank-flipped",
        find: "(a, b) => Number(a.locale === wanted) - Number(b.locale === wanted),",
        replace: "(a, b) => Number(b.locale === wanted) - Number(a.locale === wanted),",
      },
      {
        // v15.5: serve-time curated overlay dropped — shoppers would keep
        // reading the old DeepL rows (CU1 catches).
        name: "m5-curated-serve-dropped",
        find: "        const curated = curatedCopyTranslation(wanted, sourceText);\n        if (curated === null) continue;",
        replace: "        const curated: string | null = null;\n        if (curated === null) continue;",
      },
      {
        // v15.5: curated must never lose to a manual row (CU1 catches).
        name: "m6-curated-beats-manual",
        find: "        if (manualWon.has(`${resourceId}\\u0000${field}`)) continue;",
        replace: "        if (false) continue;",
      },
    ],
  });
  if (failed > 0) process.exit(1);
  // The mutant children wrote their own .gen basename — remove the residue.
  try {
    fs.unlinkSync(
      path.join(ROOT, "validation", "lib", ".gen", "proof-translation.server.mutant.ts"),
    );
  } catch {
    // best-effort cleanup
  }
}

if (failures > 0) {
  console.error(
    `${failures}/${checks} CHECKS FAILED (v8.11 proof translations vs the real proof-translation.server.ts)`,
  );
  process.exit(1);
}
console.log(
  `ALL ${checks} CHECKS PASSED (v8.11 proof translations vs the real proof-translation.server.ts)`,
);
