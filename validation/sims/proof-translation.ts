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
 *
 * MUTATION TESTS (all must be CAUGHT):
 *   m1-digest-check-dropped   outdated rows never re-translate (T3)
 *   m2-manual-flag-ignored    auto overwrites manual rows (T4)
 *   m3-overlay-rank-flipped   base-language rows beat exact rows (T8)
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
}
const captures: Capture[] = [];
let failLocales = new Set<string>();
(globalThis as any).__CX_PT_TRANSLATION = {
  deeplTranslateBatch: async (
    _key: string,
    texts: string[],
    targetLang: string,
  ) => {
    captures.push({ texts: [...texts], targetLang });
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

async function loadModel(): Promise<any> {
  const src = fs.readFileSync(SRC_PATH, "utf8");
  for (const anchor of [PRISMA_IMPORT, TRANSLATION_IMPORT, PROOF_TYPE_IMPORT]) {
    if (!src.includes(anchor)) {
      throw new Error(
        "proof-translation loader: import anchor not found — update the loader: " + anchor,
      );
    }
  }
  const stubbed = src
    .replace(PRISMA_IMPORT, PRISMA_STUB)
    .replace(TRANSLATION_IMPORT, TRANSLATION_STUB)
    .replace(PROOF_TYPE_IMPORT, PROOF_TYPE_REPOINT);
  const genDir = path.join(ROOT, "validation", "lib", ".gen");
  fs.mkdirSync(genDir, { recursive: true });
  const outPath = path.join(genDir, "proof-translation.server.real.ts");
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
        name: "m2-manual-flag-ignored",
        find: "if (row && (row.manual || row.sourceDigest === proofSourceDigest(source.text))) {",
        replace: "if (row && row.sourceDigest === proofSourceDigest(source.text)) {",
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
    ],
  });
  if (failed > 0) process.exit(1);
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
