/**
 * v8/v8.1 proof-SERVER sim — the server-side behavioral suite the v8
 * review proved missing: it executes the REAL app/services/proof.server.ts
 * (never a re-implementation) against an in-memory prisma stub and proves
 * the PUBLIC projections the storefront proof asset trusts blindly.
 *
 * LOADER (settings-loader convention, adapted): proof.server.ts imports
 * prisma AND two pdp-content functions, so the suite generates a stubbed
 * copy into validation/lib/.gen/proof.server.real.ts — the prisma import
 * becomes a read of globalThis.__CX_PROOF_PRISMA (injected below before
 * the import), the pdp-content import becomes throwing stubs (the legacy
 * importer is outside this surface and must fail loudly if reached), and
 * the type-only metaobjects import is re-pointed so editors resolve it.
 * The SOURCE path honors CX_SIM_SRC — that is how lib/mutants.cjs feeds
 * mutant copies of proof.server.ts through the SAME loader; because
 * mutants.cjs re-runs suites with plain `node`, this .ts suite hands it
 * lib/tsx-shim.cjs as selfPath (CX_TSX_SUITE carries this file's path).
 *
 * PRISMA STUB: pressItem / dermEndorsement / customerResult delegates over
 * plain arrays — findMany (where equality + OR/contains, multi-term
 * orderBy incl. boolean desc + Date, skip/take/select), findFirst,
 * findUnique, create (injected deterministic clock — no Date.now),
 * update, updateMany, delete, count, groupBy, $transaction. Every
 * findMany records its `take` so the PUBLIC_ROW_CEILING contract is
 * asserted, not assumed.
 *
 * Cases:
 *  PM  getPublicPress market matrix (v8.1): agnostic-only without a
 *      market; agnostic+matching with one; NEVER another market's items;
 *      hidden rows never served; ceiling take pinned.
 *  PP  product prioritisation: tagged-first, brand-second, tagged-for-
 *      OTHER-products excluded, featured pinned first within each band,
 *      no-product context serves everything in canonical order.
 *  PE  getPublicEndorsements: page slicing vs the ALL-matching total (the
 *      storefront scale number), hidden rows excluded, prioritisation
 *      before pagination, exact public field set.
 *  PR  getPublicResults: approved-only (pending AND hidden excluded),
 *      image-less rows excluded from items AND totals AND facets, exact
 *      public field set (no shop/status/featured/sortWeight/productGids/
 *      marketHandles/legacyGid leak), filters vs facet/verifiedTotal
 *      stability, facet canonical ordering, product-scoped facets,
 *      pagination, bulk-approve flips pending rows into the projection.
 *  MH  cleanMarketHandles (via savePressItem) + parseMarketHandles
 *      round-trips and defensive parses.
 *  SV  savePressItem validation: required fields, https gates, optional
 *      articleUrl, GID rules, market handles, status enum fallback,
 *      create sortWeight sequence, update/ownership paths, trim+cap.
 *
 * MUTATION TESTS (lib/mutants.cjs over a COPY of proof.server.ts; all
 * must be caught — the m1 anchor is the exact dead-code the v8 review
 * proved no suite would catch):
 *   m1-market-filter-dead-code   getPublicPress serves rows instead of
 *                                marketScoped (PM agnostic-only case)
 *   m2-imageless-served          the >=1-image renderable filter dropped
 *                                (PR totals/facets cases)
 *   m3-press-status-pin-dropped  public press loses status:"approved"
 *                                (PM hidden-row case)
 *   m4-tagged-other-kept         prioritiseForProduct serves items tagged
 *                                for OTHER products (PP exclusion case)
 *   m5-endo-total-page-scoped    endorsement total collapses to the page
 *                                size (PE scale-number case)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const REAL_SRC = path.join(ROOT, "app", "services", "proof.server.ts");
const SRC_PATH = process.env.CX_SIM_SRC || REAL_SRC;

let checks = 0;
let failures = 0;
function ok(cond: unknown, label: string) {
  checks += 1;
  if (!cond) {
    failures += 1;
    console.error("FAIL: " + label);
  }
}

// --------------------------------------------------------------- prisma stub

interface StubRow {
  [key: string]: unknown;
}

interface FindManyCall {
  model: string;
  take: number | undefined;
}

function pick(row: StubRow, select: Record<string, boolean>): StubRow {
  const out: StubRow = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
  return out;
}

function matchesWhere(row: StubRow, where: Record<string, unknown> | undefined): boolean {
  for (const [k, v] of Object.entries(where || {})) {
    if (k === "OR") {
      if (!(v as Record<string, unknown>[]).some((cond) => matchesWhere(row, cond))) return false;
      continue;
    }
    if (v !== null && typeof v === "object") {
      const op = v as Record<string, unknown>;
      if ("contains" in op) {
        if (String(row[k] ?? "").indexOf(String(op.contains)) === -1) return false;
        continue;
      }
      throw new Error("prisma stub: unsupported where operator " + JSON.stringify(v));
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function rank(v: unknown): number | string {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as number | string;
}

function orderRows(rows: StubRow[], orderBy: unknown): StubRow[] {
  const terms = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, "asc" | "desc">[];
  return [...rows].sort((a, b) => {
    for (const term of terms) {
      for (const [field, dir] of Object.entries(term)) {
        const av = rank(a[field]);
        const bv = rank(b[field]);
        if (av < bv) return dir === "asc" ? -1 : 1;
        if (av > bv) return dir === "asc" ? 1 : -1;
      }
    }
    return 0;
  });
}

function makeStub() {
  // Injected deterministic clock — the house no-Date.now rule.
  let tick = 1_700_000_000_000;
  let seq = 0;
  const clock = () => new Date((tick += 60_000));
  const tables: Record<string, StubRow[]> = { pressItem: [], dermEndorsement: [], customerResult: [], resultPreset: [] };
  const findManyCalls: FindManyCall[] = [];

  function delegate(model: string) {
    const rows = () => tables[model];
    return {
      async findMany(args: any = {}) {
        findManyCalls.push({ model, take: args.take });
        let out = rows().filter((r) => matchesWhere(r, args.where));
        if (args.orderBy) out = orderRows(out, args.orderBy);
        if (typeof args.skip === "number") out = out.slice(args.skip);
        if (typeof args.take === "number") out = out.slice(0, args.take);
        return out.map((r) => (args.select ? pick(r, args.select) : { ...r }));
      },
      async findFirst(args: any = {}) {
        const hit = rows().find((r) => matchesWhere(r, args.where));
        return hit ? { ...hit } : null;
      },
      async findUnique(args: any = {}) {
        const hit = rows().find((r) => matchesWhere(r, args.where));
        return hit ? { ...hit } : null;
      },
      async create(args: any) {
        seq += 1;
        const row: StubRow = { id: `${model}-${seq}`, createdAt: clock(), ...args.data };
        rows().push(row);
        return { ...row };
      },
      async update(args: any) {
        const hit = rows().find((r) => matchesWhere(r, args.where));
        if (!hit) throw new Error("prisma stub: update target not found");
        Object.assign(hit, args.data);
        return { ...hit };
      },
      async updateMany(args: any) {
        const hits = rows().filter((r) => matchesWhere(r, args.where));
        for (const hit of hits) Object.assign(hit, args.data);
        return { count: hits.length };
      },
      async delete(args: any) {
        const i = rows().findIndex((r) => matchesWhere(r, args.where));
        if (i === -1) throw new Error("prisma stub: delete target not found");
        return { ...(rows().splice(i, 1)[0]) };
      },
      async count(args: any = {}) {
        return rows().filter((r) => matchesWhere(r, args.where)).length;
      },
      async groupBy(args: any) {
        const groups = new Map<string, number>();
        const key = args.by[0] as string;
        for (const r of rows().filter((x) => matchesWhere(x, args.where))) {
          const v = String(r[key]);
          groups.set(v, (groups.get(v) ?? 0) + 1);
        }
        return [...groups.entries()].map(([value, n]) => ({ [key]: value, _count: { _all: n } }));
      },
    };
  }

  return {
    pressItem: delegate("pressItem"),
    dermEndorsement: delegate("dermEndorsement"),
    customerResult: delegate("customerResult"),
    resultPreset: delegate("resultPreset"),
    async $transaction(ops: Promise<unknown>[]) {
      return Promise.all(ops);
    },
    _tables: tables,
    _findManyCalls: findManyCalls,
    _seed(model: string, row: StubRow): StubRow {
      seq += 1;
      const full: StubRow = { id: `${model}-${seq}`, createdAt: clock(), featured: false, sortWeight: seq, ...row };
      tables[model].push(full);
      return full;
    },
    _lastTake(model: string): number | undefined {
      const mine = findManyCalls.filter((c) => c.model === model);
      return mine.length ? mine[mine.length - 1].take : undefined;
    },
  };
}

const db = makeStub();
(globalThis as any).__CX_PROOF_PRISMA = db;

// ------------------------------------------------------------------- loader

const PRISMA_IMPORT = 'import prisma from "../db.server";';
const PRISMA_STUB = [
  '// validation stub — the real import is `import prisma from "../db.server";`',
  "const prisma: any = (globalThis as any).__CX_PROOF_PRISMA;",
  'if (!prisma) throw new Error("validation: proof prisma stub not injected before import");',
].join("\n");

const PDP_IMPORT = [
  "import {",
  "  getProductBoosters,",
  "  listProductsWithBoosterStatus,",
  '} from "./pdp-content.server";',
].join("\n");
const PDP_STUB = [
  "// validation stub — pdp-content is outside this suite's surface; the",
  "// legacy importer is not exercised here and must fail loudly if reached.",
  "const getProductBoosters: any = () => {",
  '  throw new Error("validation: getProductBoosters is stubbed in the proof-server sim");',
  "};",
  "const listProductsWithBoosterStatus: any = getProductBoosters;",
  "void listProductsWithBoosterStatus;",
].join("\n");

const METAOBJECTS_TYPE_IMPORT = 'from "./metaobjects.server";';
const PT_IMPORT = 'import { deleteProofTranslationsFor } from "./proof-translation.server";';
const PT_STUB = [
  "// validation stub — translation cleanup is outside this suite's surface",
  "const deleteProofTranslationsFor: any = async () => {};",
  "void deleteProofTranslationsFor;",
].join("\n");
const METAOBJECTS_TYPE_REPOINT = 'from "../../../app/services/metaobjects.server";';

async function loadProofModel(): Promise<any> {
  const src = fs.readFileSync(SRC_PATH, "utf8");
  for (const anchor of [PRISMA_IMPORT, PDP_IMPORT, METAOBJECTS_TYPE_IMPORT, PT_IMPORT]) {
    if (!src.includes(anchor)) {
      throw new Error(
        "proof-server loader: import anchor not found in proof.server.ts — update the loader: " + anchor,
      );
    }
  }
  const stubbed = src
    .replace(PRISMA_IMPORT, PRISMA_STUB)
    .replace(PDP_IMPORT, PDP_STUB)
    .replace(METAOBJECTS_TYPE_IMPORT, METAOBJECTS_TYPE_REPOINT)
    .replace(PT_IMPORT, PT_STUB);
  const genDir = path.join(ROOT, "validation", "lib", ".gen");
  fs.mkdirSync(genDir, { recursive: true });
  // Mutant child runs write a SEPARATE basename so the repo-resident
  // proof.server.real.ts never ends up carrying a mutant's source (v9 fix).
  const outPath = path.join(
    genDir,
    process.env.CX_SIM_SRC ? "proof.server.mutant.ts" : "proof.server.real.ts",
  );
  if (!fs.existsSync(outPath) || fs.readFileSync(outPath, "utf8") !== stubbed) {
    fs.writeFileSync(outPath, stubbed);
  }
  return await import(pathToFileURL(outPath).href);
}

const P = await loadProofModel();

// ------------------------------------------------------------ seed helpers

const GID_P = "gid://shopify/Product/111";
const GID_Q = "gid://shopify/Product/222";

function seedPress(shop: string, over: StubRow): StubRow {
  return db._seed("pressItem", {
    shop,
    status: "approved",
    publication: "Pub",
    logoUrl: null,
    quote: "Quote",
    articleUrl: null,
    productGids: "[]",
    marketHandles: "[]",
    ...over,
  });
}

function seedEndo(shop: string, over: StubRow): StubRow {
  return db._seed("dermEndorsement", {
    shop,
    status: "approved",
    name: "Dr. N",
    credentials: null,
    country: null,
    quote: "Q",
    imageUrl: null,
    productGids: "[]",
    ...over,
  });
}

function seedResult(shop: string, over: StubRow): StubRow {
  return db._seed("customerResult", {
    shop,
    status: "approved",
    source: "customer",
    verified: false,
    beforeUrl: null,
    afterUrl: null,
    combinedUrl: null,
    ageRange: null,
    skinType: null,
    concern: null,
    durationWeeks: null,
    country: null,
    testimonial: null,
    videoUrl: null,
    measurements: "[]",
    markInstrument: false,
    markSamePatient: false,
    markUnretouched: false,
    attributionName: null,
    attributionRole: null,
    study: null,
    productGids: "[]",
    marketHandles: undefined,
    legacyGid: null,
    ...over,
  });
}

function pubs(res: { items: { publication: string }[] }): string[] {
  return res.items.map((i) => i.publication);
}

// ================================================= PM: press market matrix

{
  const shop = "market.myshopify.com";
  seedPress(shop, { publication: "AGN" }); // market-agnostic
  seedPress(shop, { publication: "EU", marketHandles: '["eu"]' });
  seedPress(shop, { publication: "US", marketHandles: '["us"]' });
  seedPress(shop, { publication: "EUFR", marketHandles: '["eu","fr"]' });
  seedPress(shop, { publication: "HID", status: "hidden" });

  const noMarket = await P.getPublicPress(shop, null, null);
  ok(noMarket.total === 1 && pubs(noMarket).join(",") === "AGN",
    "PM1: no market -> ONLY market-agnostic items (never another market's press)");

  const eu = await P.getPublicPress(shop, null, "eu");
  ok(pubs(eu).sort().join(",") === "AGN,EU,EUFR" && eu.total === 3,
    "PM2: market eu -> agnostic + eu-limited items");
  ok(!pubs(eu).includes("US"), "PM2: eu request NEVER sees the us-limited item");

  const us = await P.getPublicPress(shop, null, "us");
  ok(pubs(us).sort().join(",") === "AGN,US" && us.total === 2,
    "PM3: market us -> agnostic + us-limited items only");

  const fr = await P.getPublicPress(shop, null, "fr");
  ok(pubs(fr).sort().join(",") === "AGN,EUFR",
    "PM4: multi-market item serves every listed market");

  const de = await P.getPublicPress(shop, null, "de");
  ok(pubs(de).join(",") === "AGN", "PM5: unknown market -> agnostic items only");

  for (const res of [noMarket, eu, us, fr, de]) {
    ok(!pubs(res).includes("HID"), "PM6: hidden press never serves (status pin)");
  }
  ok(P.PUBLIC_ROW_CEILING === 5000, "PM7: PUBLIC_ROW_CEILING is the documented 5000");
  ok(db._lastTake("pressItem") === P.PUBLIC_ROW_CEILING,
    "PM7: public press query passes take=PUBLIC_ROW_CEILING (never unbounded)");
}

// ============================================ PP: product prioritisation

{
  const shop = "prio.myshopify.com";
  seedPress(shop, { publication: "TAGGED", productGids: JSON.stringify([GID_P]) });
  seedPress(shop, { publication: "BRAND" });
  seedPress(shop, { publication: "OTHER", productGids: JSON.stringify([GID_Q]) });
  seedPress(shop, { publication: "BOTH", productGids: JSON.stringify([GID_P, GID_Q]) });
  seedPress(shop, { publication: "FEATBRAND", featured: true });

  const forP = await P.getPublicPress(shop, GID_P, null);
  ok(pubs(forP).join(",") === "TAGGED,BOTH,FEATBRAND,BRAND",
    "PP1: tagged-for-THIS-product first, then brand-level (featured pinned inside its band)");
  ok(!pubs(forP).includes("OTHER"), "PP2: items tagged only for OTHER products are excluded");
  ok(forP.total === 4, "PP3: total counts the prioritised set, not the raw table");

  const forQ = await P.getPublicPress(shop, GID_Q, null);
  ok(pubs(forQ).join(",") === "OTHER,BOTH,FEATBRAND,BRAND",
    "PP4: the other product sees ITS tagged band first");

  const noProduct = await P.getPublicPress(shop, null, null);
  ok(pubs(noProduct).join(",") === "FEATBRAND,TAGGED,BRAND,OTHER,BOTH",
    "PP5: no product -> everything in canonical featured/sortWeight/createdAt order");
  ok(noProduct.total === 5, "PP5: brand/home total spans every approved item");

  const item = forP.items[0];
  ok(
    Object.keys(item).sort().join(",") === "articleUrl,id,logoUrl,publication,quote",
    "PP6: public press items carry EXACTLY the five public fields",
  );
  for (const leak of ["shop", "status", "featured", "sortWeight", "productGids", "marketHandles"]) {
    ok(!(leak in item), `PP6: press projection never leaks ${leak}`);
  }
}

// ========================================== PE: endorsement pagination

{
  const shop = "endo.myshopify.com";
  for (let i = 0; i < 30; i += 1) seedEndo(shop, { name: `Dr. ${String(i).padStart(2, "0")}` });
  seedEndo(shop, { name: "Dr. HIDDEN", status: "hidden" });
  seedEndo(shop, { name: "Dr. LAST-TAGGED", productGids: JSON.stringify([GID_P]) });

  const p1 = await P.getPublicEndorsements(shop, null, 1, 24);
  ok(p1.items.length === 24, "PE1: page 1 serves the requested 24");
  ok(p1.total === 31, "PE1: total stays the ALL-matching count (the storefront scale number)");
  ok(p1.items[0].name === "Dr. 00", "PE1: canonical order starts the page");

  const p2 = await P.getPublicEndorsements(shop, null, 2, 24);
  ok(p2.items.length === 7 && p2.total === 31,
    "PE2: page 2 serves the remainder with the SAME total");
  ok(p2.items[0].name === "Dr. 24", "PE2: page 2 starts where page 1 ended (no overlap)");

  const p3 = await P.getPublicEndorsements(shop, null, 3, 24);
  ok(p3.items.length === 0 && p3.total === 31,
    "PE3: past-the-end page is empty but keeps the truthful total");

  const small = await P.getPublicEndorsements(shop, null, 2, 10);
  ok(small.items.length === 10 && small.items[0].name === "Dr. 10",
    "PE4: per drives the slice arithmetic ((page-1)*per)");

  const names = [...p1.items, ...p2.items].map((i: { name: string }) => i.name);
  ok(!names.includes("Dr. HIDDEN"), "PE5: hidden endorsements never serve");

  const forP = await P.getPublicEndorsements(shop, GID_P, 1, 24);
  ok(forP.items[0].name === "Dr. LAST-TAGGED",
    "PE6: product prioritisation runs BEFORE pagination (tagged row leads page 1)");

  const item = p1.items[0];
  ok(
    Object.keys(item).sort().join(",") === "country,credentials,id,imageUrl,name,quote",
    "PE7: public endorsement items carry EXACTLY the six public fields",
  );
  ok(db._lastTake("dermEndorsement") === P.PUBLIC_ROW_CEILING,
    "PE8: public endorsement query passes take=PUBLIC_ROW_CEILING");
}

// ================================================ PR: results projection

{
  const shop = "results.myshopify.com";
  seedResult(shop, {
    beforeUrl: "https://cdn/b1.jpg", afterUrl: "https://cdn/a1.jpg", verified: true,
    concern: "wrinkles", ageRange: "25-34", skinType: "dry", durationWeeks: 10,
    country: "DE", testimonial: "T1",
  });
  seedResult(shop, {
    afterUrl: "https://cdn/a2.jpg", source: "lab",
    concern: "firmness", ageRange: "25-34", skinType: "oily", durationWeeks: 4,
  });
  seedResult(shop, { testimonial: "imageless", verified: true, concern: "ghost" });
  seedResult(shop, {
    beforeUrl: "https://cdn/b4.jpg", verified: true,
    concern: "wrinkles", skinType: "dry", durationWeeks: 16,
  });
  seedResult(shop, { beforeUrl: "https://cdn/b5.jpg", status: "hidden", concern: "hiddenconcern" });
  const pending = seedResult(shop, {
    beforeUrl: "https://cdn/b6.jpg", status: "pending", concern: "pendingconcern",
  });
  seedResult(shop, {
    beforeUrl: "https://cdn/b7.jpg", productGids: JSON.stringify([GID_Q]),
    concern: "otherproductconcern",
  });

  const all = await P.getPublicResults(shop, null, {}, 1, 12);
  ok(all.total === 4 && all.items.length === 4,
    "PR1: image-less + hidden + pending rows excluded from items AND total");
  ok(all.verifiedTotal === 2,
    "PR1: verifiedTotal counts RENDERABLE verified rows only (imageless verified excluded)");
  const concerns = all.facets.concerns.map((f: { value: string; count: number }) => `${f.value}:${f.count}`);
  ok(concerns.join(",") === "wrinkles:2,firmness:1,otherproductconcern:1",
    "PR2: concern facet = most-common first then alphabetical, from renderable rows only");
  for (const gone of ["ghost", "hiddenconcern", "pendingconcern"]) {
    ok(!concerns.some((c: string) => c.startsWith(gone + ":")),
      `PR2: facet never counts a non-servable row (${gone})`);
  }
  ok(all.facets.skins.map((f: { value: string }) => f.value).join(",") === "dry,oily",
    "PR3: skin facet follows the canonical SKIN_TYPES order");
  ok(all.facets.durations.map((f: { value: string }) => f.value).join(",") === "lt8,8to12,gt12",
    "PR3: duration facet follows the canonical bucket order");
  ok(all.facets.ages.length === 1 && all.facets.ages[0].value === "25-34" && all.facets.ages[0].count === 2,
    "PR3: age facet counts renderable rows in canonical order");

  const item = all.items.find((i: { testimonial: string | null }) => i.testimonial === "T1");
  ok(!!item, "PR4: the full fixture row is served");
  ok(
    Object.keys(item).sort().join(",") ===
      "afterUrl,ageRange,attributionName,attributionRole,beforeUrl,combinedUrl,concern,country," +
      "durationWeeks,id,markInstrument,markSamePatient,markUnretouched,measurements," +
      "skinType,source,study,testimonial,verified,videoUrl",
    "PR4: public result items carry EXACTLY the twenty public fields (v25 + v33 combinedUrl + v35 study)",
  );
  for (const leak of ["shop", "status", "featured", "sortWeight", "productGids", "marketHandles", "legacyGid", "createdAt"]) {
    ok(!(leak in item), `PR4: result projection never leaks ${leak}`);
  }

  const filtered = await P.getPublicResults(shop, null, { concern: "wrinkles" }, 1, 12);
  ok(filtered.total === 2 && filtered.items.length === 2,
    "PR5: concern filter narrows total to matching renderable rows");
  ok(
    filtered.facets.concerns.map((f: { value: string; count: number }) => `${f.value}:${f.count}`).join(",") ===
      "wrinkles:2,firmness:1,otherproductconcern:1",
    "PR5: facets stay STABLE while filtering (chip counts never collapse)",
  );
  ok(filtered.verifiedTotal === 2, "PR5: verifiedTotal stays the scale banner number while filtering");

  const lt8 = await P.getPublicResults(shop, null, { duration: "lt8" }, 1, 12);
  ok(lt8.total === 1 && lt8.items[0].concern === "firmness",
    "PR6: duration filter banding matches durationBucketOf");
  ok(P.durationBucketOf(7) === "lt8" && P.durationBucketOf(8) === "8to12" &&
    P.durationBucketOf(12) === "8to12" && P.durationBucketOf(13) === "gt12" &&
    P.durationBucketOf(null) === null,
    "PR6: durationBucketOf edges (8 and 12 belong to the middle bucket)");

  const combo = await P.getPublicResults(shop, null, { skin: "dry", age: "25-34" }, 1, 12);
  ok(combo.total === 1 && combo.items[0].testimonial === "T1",
    "PR7: filters compose with AND semantics");

  const page2 = await P.getPublicResults(shop, null, {}, 2, 2);
  ok(page2.items.length === 2 && page2.total === 4,
    "PR8: results pagination slices without touching the total");

  const forP = await P.getPublicResults(shop, GID_P, {}, 1, 12);
  ok(!forP.facets.concerns.some((f: { value: string }) => f.value === "otherproductconcern"),
    "PR9: facets are computed over the PRODUCT-scoped set (other-product rows drop out)");
  ok(forP.total === 3, "PR9: product scoping excludes other-product rows from the total");
  ok(db._lastTake("customerResult") === P.PUBLIC_ROW_CEILING,
    "PR10: public results query passes take=PUBLIC_ROW_CEILING");

  const bulk = await P.bulkApprovePendingResults(shop);
  ok(bulk.ok === true && bulk.approved === 1, "PR11: bulk-approve reports the pending row it flipped");
  const afterBulk = await P.getPublicResults(shop, null, {}, 1, 12);
  ok(afterBulk.total === 5 &&
    afterBulk.facets.concerns.some((f: { value: string }) => f.value === "pendingconcern"),
    "PR11: an approved row (and only then) enters items + facets");
  void pending;
}

// ===================== SR: v25 clinical fields — save validation + serving

{
  const shop = "clinical.myshopify.com";
  const base = {
    source: "lab",
    verified: false,
    beforeUrl: "https://cdn/b.jpg",
    afterUrl: "https://cdn/a.jpg",
    combinedUrl: "",
    ageRange: "",
    skinType: "",
    concern: "",
    durationWeeks: 7,
    country: "",
    testimonial: "  I confirm the images are unretouched.  ",
    videoUrl: "",
    measurements: [
      { label: "  Under-eye wrinkle depth  ", dir: "down", pct: 18, info: " PRIMOS scan. " },
      { label: "Skin firmness", dir: "up", pct: 14.3, info: "" },
    ],
    markInstrument: true,
    markSamePatient: true,
    markUnretouched: false,
    attributionName: "  Dr. Lauren Bennett ",
    attributionRole: " Consultant Dermatologist ",
    productGids: [] as string[],
    featured: false,
    status: "approved",
  };
  const saved = await P.saveResult(shop, base);
  ok(saved.ok === true, "SR1: a valid lab entry with measurements saves");
  const served = await P.getPublicResults(shop, null, {}, 1, 12);
  const it = served.items[0];
  ok(
    JSON.stringify(it.measurements) ===
      JSON.stringify([
        { label: "Under-eye wrinkle depth", dir: "down", pct: 18, info: "PRIMOS scan." },
        { label: "Skin firmness", dir: "up", pct: 14.3 },
      ]),
    "SR1: measurements serve trimmed, one-decimal percents exact, info omitted when blank",
  );
  ok(it.markInstrument === true && it.markSamePatient === true && it.markUnretouched === false,
    "SR1: trust marks serve exactly as checked");
  ok(it.attributionName === "Dr. Lauren Bennett" && it.attributionRole === "Consultant Dermatologist",
    "SR1: attribution serves trimmed");

  const flipped = await P.saveResult(shop, { ...base, source: "customer" }, saved.id);
  ok(flipped.ok === true, "SR2: flipping a lab entry to customer saves");
  const servedFlip = await P.getPublicResults(shop, null, {}, 1, 12);
  ok(
    servedFlip.items[0].measurements.length === 0 &&
      servedFlip.items[0].markInstrument === false &&
      servedFlip.items[0].markSamePatient === false,
    "SR2: the flip CLEARS instrument claims (customer rows can never carry them)",
  );
  ok(servedFlip.items[0].attributionName === "Dr. Lauren Bennett",
    "SR2: attribution survives the flip (it is not a lab claim)");

  // serve-time belt: a drifted CUSTOMER row whose columns somehow hold
  // clinical data must still serve none of it
  seedResult(shop, {
    beforeUrl: "https://cdn/drift.jpg",
    measurements: '[{"label":"Drift","dir":"down","pct":9}]',
    markInstrument: true,
    markUnretouched: true,
  });
  const drift = await P.getPublicResults(shop, null, {}, 1, 12);
  const driftRow = drift.items.find((r: { beforeUrl: string | null }) => r.beforeUrl === "https://cdn/drift.jpg");
  ok(!!driftRow && driftRow.measurements.length === 0 && driftRow.markInstrument === false &&
    driftRow.markUnretouched === false,
    "SR3: serve-time lab belt zeroes drifted customer clinical columns");

  const badPct = await P.saveResult(shop, {
    ...base,
    measurements: [{ label: "X", dir: "down", pct: 0 }],
  });
  ok(badPct.ok === false && badPct.errors.some((e: string) => e.includes("between 0.1 and 500")),
    "SR4: percent outside 0.1-500 is a save error, never silently dropped");
  const twoDecimals = await P.saveResult(shop, {
    ...base,
    measurements: [{ label: "X", dir: "down", pct: 34.25 }],
  });
  ok(twoDecimals.ok === false && twoDecimals.errors.some((e: string) => e.includes("one decimal")),
    "SR4: more than one decimal place is a save error (34.25 is fake rigor)");
  const badDir = await P.saveResult(shop, {
    ...base,
    measurements: [{ label: "X", dir: "sideways", pct: 5 }],
  });
  ok(badDir.ok === false && badDir.errors.some((e: string) => e.includes("direction")),
    "SR4: unknown direction is a save error");
  const malformed = await P.saveResult(shop, {
    ...base,
    measurements: ["nope"],
  });
  ok(malformed.ok === false && malformed.errors.some((e: string) => e.includes("malformed")),
    "SR4: a non-object row is a save error");
  const tooMany = await P.saveResult(shop, {
    ...base,
    measurements: Array.from({ length: 7 }, (_, i) => ({ label: `M${i}`, dir: "up", pct: 5 })),
  });
  ok(tooMany.ok === false && tooMany.errors.some((e: string) => e.includes("No more than 6")),
    "SR4: more than 6 measurement rows is a save error");
  const noDuration = await P.saveResult(shop, {
    ...base,
    durationWeeks: null,
  });
  ok(noDuration.ok === false && noDuration.errors.some((e: string) => e.includes("Duration")),
    "SR4: measurements without a duration are refused (the panel states when)");
  const capPct = await P.saveResult(shop, {
    ...base,
    measurements: [{ label: "X", dir: "up", pct: 501 }],
  });
  ok(capPct.ok === false, "SR4: percent above 500 is refused");
}

// =========== SR5/PR12: v33 combined before/after photo (lab-only layout)

{
  const shop = "combined.myshopify.com";
  const base = {
    source: "lab",
    verified: true,
    beforeUrl: "",
    afterUrl: "",
    combinedUrl: "https://cdn/combo.jpg",
    ageRange: "",
    skinType: "",
    concern: "",
    durationWeeks: 8,
    country: "",
    testimonial: "",
    videoUrl: "",
    measurements: [] as unknown[],
    markInstrument: false,
    markSamePatient: false,
    markUnretouched: false,
    attributionName: "",
    attributionRole: "",
    productGids: [] as string[],
    featured: false,
    status: "approved",
  };
  const saved = await P.saveResult(shop, base);
  ok(saved.ok === true, "SR5: a combined-only lab entry meets the image requirement");
  const served = await P.getPublicResults(shop, null, {}, 1, 12);
  ok(served.total === 1 && served.items[0].combinedUrl === "https://cdn/combo.jpg",
    "PR12: a combined-only lab row is renderable and serves combinedUrl");

  // combined WINS: the separate pair is cleared, never served alongside
  const both = await P.saveResult(shop, {
    ...base, beforeUrl: "https://cdn/b.jpg", afterUrl: "https://cdn/a.jpg",
  }, saved.id);
  ok(both.ok === true, "SR5: pair + combined together still saves");
  const servedBoth = await P.getPublicResults(shop, null, {}, 1, 12);
  ok(servedBoth.items[0].combinedUrl === "https://cdn/combo.jpg" &&
    servedBoth.items[0].beforeUrl === null && servedBoth.items[0].afterUrl === null,
    "SR5: combined wins — the pair stores as null (one layout per row)");

  // lab-only, layer 1 (save): a customer flip drops the combined photo
  const flipped = await P.saveResult(shop, { ...base, source: "customer" }, saved.id);
  ok(flipped.ok === false && flipped.errors.some((e: string) => e.includes("at least an image")),
    "SR5: the flip clears the combined photo, so an otherwise-empty flip is refused");
  const flipKept = await P.saveResult(shop, {
    ...base, source: "customer", beforeUrl: "https://cdn/b.jpg",
  }, saved.id);
  ok(flipKept.ok === true, "SR5: the flip saves once a pair image replaces it");
  const servedFlip = await P.getPublicResults(shop, null, {}, 1, 12);
  ok(servedFlip.items[0].combinedUrl === null &&
    servedFlip.items[0].beforeUrl === "https://cdn/b.jpg",
    "SR5: after the flip the combined column serves null");

  const badUrl = await P.saveResult(shop, { ...base, combinedUrl: "http://cdn/x.jpg" });
  ok(badUrl.ok === false &&
    badUrl.errors.some((e: string) => e.includes("Combined before/after image")),
    "SR5: the combined URL passes the https gate or errors");

  // layer 2 (serve belt) + the lab-aware renderable gate: a drifted
  // CUSTOMER row with ONLY a combined photo would never render, so it
  // must not enter items/totals/facets at all.
  seedResult(shop, { combinedUrl: "https://cdn/drift-combo.jpg" });
  const drift = await P.getPublicResults(shop, null, {}, 1, 12);
  ok(drift.total === 1 &&
    !drift.items.some((r: { combinedUrl: string | null }) => r.combinedUrl === "https://cdn/drift-combo.jpg"),
    "PR12: a customer row with only a drifted combined photo is fully excluded");
  seedResult(shop, { source: "lab", combinedUrl: "https://cdn/lab-drift.jpg" });
  seedResult(shop, { beforeUrl: "https://cdn/pairb.jpg", combinedUrl: "https://cdn/cust-drift.jpg" });
  const drift2 = await P.getPublicResults(shop, null, {}, 1, 12);
  const labDrift = drift2.items.find((r: { combinedUrl: string | null }) => r.combinedUrl === "https://cdn/lab-drift.jpg");
  const custDrift = drift2.items.find((r: { beforeUrl: string | null }) => r.beforeUrl === "https://cdn/pairb.jpg");
  ok(drift2.total === 3 && !!labDrift, "PR12: a lab row's combined photo serves");
  ok(!!custDrift && custDrift.combinedUrl === null,
    "PR12: the serve belt nulls a customer row's drifted combined column");
}

// ===================== PS: v34 study presets (admin-only batch templates)

{
  const shop = "presets.myshopify.com";
  const other = "otherpresets.myshopify.com";
  const base = {
    name: "  8-week wrinkle study ",
    testimonial: "  Protocol quote.  ",
    attributionName: " Dr. Lauren Bennett ",
    attributionRole: " Consultant Dermatologist ",
    durationWeeks: 8,
    measurements: [
      { label: " Wrinkle depth ", dir: "down", info: " PRIMOS scan. ", pct: 34.2 },
      { label: "Skin firmness", dir: "up", info: "" },
    ],
    markInstrument: true,
    markSamePatient: true,
    markUnretouched: false,
  };
  const saved = await P.saveResultPreset(shop, base);
  ok(saved.ok === true && typeof saved.id === "string", "PS1: a valid preset saves");
  const listed = await P.listResultPresets(shop);
  ok(listed.length === 1 && listed[0].name === "8-week wrinkle study",
    "PS1: listed by trimmed name");
  ok(
    JSON.stringify(listed[0].fields.measurements) ===
      JSON.stringify([
        { label: "Wrinkle depth", dir: "down", info: "PRIMOS scan." },
        { label: "Skin firmness", dir: "up" },
      ]),
    "PS1: rows store label/dir/info trimmed — the sent pct is DROPPED (percents are per-entry numbers)",
  );
  ok(listed[0].fields.attributionName === "Dr. Lauren Bennett" &&
    listed[0].fields.durationWeeks === 8 && listed[0].fields.markInstrument === true &&
    listed[0].fields.markUnretouched === false,
    "PS1: study constants round-trip trimmed");

  const renamedQuote = await P.saveResultPreset(shop, { ...base, testimonial: "Updated quote." });
  ok(renamedQuote.ok === true && renamedQuote.id === saved.id,
    "PS2: re-saving the same name UPDATES that preset in place");
  const afterUpdate = await P.listResultPresets(shop);
  ok(afterUpdate.length === 1 && afterUpdate[0].fields.testimonial === "Updated quote.",
    "PS2: no duplicate row, refreshed payload");

  const noName = await P.saveResultPreset(shop, { ...base, name: "   " });
  ok(noName.ok === false && noName.errors.some((e: string) => e.includes("name")),
    "PS3: a blank name is refused");
  const badRow = await P.saveResultPreset(shop, {
    ...base, name: "Bad rows", measurements: [{ label: "", dir: "sideways" }],
  });
  ok(badRow.ok === false &&
    badRow.errors.some((e: string) => e.includes("label")) &&
    badRow.errors.some((e: string) => e.includes("direction")),
    "PS3: label + direction problems are reported, never silently dropped");
  const tooMany = await P.saveResultPreset(shop, {
    ...base, name: "Too many",
    measurements: Array.from({ length: 7 }, (_, i) => ({ label: `M${i}`, dir: "up" })),
  });
  ok(tooMany.ok === false && tooMany.errors.some((e: string) => e.includes("No more than 6")),
    "PS3: more than 6 rows is refused");
  const badWeeks = await P.saveResultPreset(shop, { ...base, name: "Weeks", durationWeeks: 521 });
  ok(badWeeks.ok === false && badWeeks.errors.some((e: string) => e.includes("Duration")),
    "PS3: out-of-range duration is refused");

  await P.saveResultPreset(other, { ...base, name: "Their study" });
  const mine = await P.listResultPresets(shop);
  ok(mine.length === 1 && mine.every((p: { name: string }) => p.name !== "Their study"),
    "PS4: presets are shop-scoped");
  const crossDelete = await P.deleteResultPreset(shop, (await P.listResultPresets(other))[0].id);
  ok(crossDelete.ok === false && crossDelete.errors[0] === "Preset not found",
    "PS4: cross-shop delete is refused");
  const del = await P.deleteResultPreset(shop, saved.id as string);
  ok(del.ok === true && (await P.listResultPresets(shop)).length === 0,
    "PS4: own delete removes the preset");

  const capShop = "capped.myshopify.com";
  for (let i = 0; i < P.MAX_RESULT_PRESETS; i++) {
    const fill = await P.saveResultPreset(capShop, { ...base, name: `Study ${i}` });
    if (!fill.ok) { ok(false, `PS5: fill save ${i} unexpectedly failed`); break; }
  }
  const over = await P.saveResultPreset(capShop, { ...base, name: "One too many" });
  ok(over.ok === false && over.errors.some((e: string) => e.includes(`No more than ${P.MAX_RESULT_PRESETS}`)),
    "PS5: the preset cap refuses number 51");
  const still = await P.saveResultPreset(capShop, { ...base, name: "Study 0", testimonial: "Refreshed." });
  ok(still.ok === true, "PS5: same-name updates still work at the cap");

  db._seed("resultPreset", { shop, name: "Corrupt", payload: "not json" });
  const tolerant = await P.listResultPresets(shop);
  const corrupt = tolerant.find((p: { name: string }) => p.name === "Corrupt");
  ok(!!corrupt && corrupt.fields.measurements.length === 0 && corrupt.fields.testimonial === "",
    "PS6: a corrupt payload degrades to empty fields, never throws");
  ok(JSON.stringify(P.parseResultPresetFields(null)) === JSON.stringify(P.parseResultPresetFields("{bad")),
    "PS6: null and corrupt parse identically (empty)");
}

// =============== ST: v35 study tag — lab-only save + serve belt + cap

{
  const shop = "study.myshopify.com";
  const base = {
    source: "lab",
    verified: false,
    beforeUrl: "https://cdn/sb.jpg",
    afterUrl: "https://cdn/sa.jpg",
    combinedUrl: "",
    ageRange: "",
    skinType: "",
    concern: "",
    durationWeeks: null,
    country: "",
    testimonial: "",
    videoUrl: "",
    measurements: [],
    markInstrument: false,
    markSamePatient: false,
    markUnretouched: false,
    attributionName: "",
    attributionRole: "",
    study: "  Helsinki 8-week study  ",
    productGids: [] as string[],
    featured: false,
    status: "approved",
  };
  const saved = await P.saveResult(shop, base);
  ok(saved.ok === true, "ST1: a lab entry with a study tag saves");
  const served = await P.getPublicResults(shop, null, {}, 1, 12);
  ok(served.items[0].study === "Helsinki 8-week study",
    "ST1: the study tag serves trimmed");

  const flipped = await P.saveResult(shop, { ...base, source: "customer" }, saved.id);
  ok(flipped.ok === true, "ST2: flipping to customer saves");
  const servedFlip = await P.getPublicResults(shop, null, {}, 1, 12);
  ok(servedFlip.items[0].study === null,
    "ST2: the flip CLEARS the study tag (lab-only study constant)");

  // serve-time belt: a drifted CUSTOMER row with a study column serves null
  seedResult(shop, { beforeUrl: "https://cdn/drift-study.jpg", study: "Drifted" });
  const drift = await P.getPublicResults(shop, null, {}, 1, 12);
  const driftItem = drift.items.find(
    (i: { beforeUrl: string | null }) => i.beforeUrl === "https://cdn/drift-study.jpg",
  );
  ok(!!driftItem && driftItem.study === null,
    "ST3: a drifted customer study column never serves (serve belt)");

  const long = await P.saveResult(shop, { ...base, study: "x".repeat(200) });
  ok(long.ok === true, "ST4: an over-long study name saves (capped, never errors)");
  const servedLong = await P.getPublicResults(shop, null, {}, 1, 12);
  const longItem = servedLong.items.find(
    (i: { study: string | null }) => i.study !== null && i.study.startsWith("xxx"),
  );
  ok(!!longItem && longItem.study.length === 80,
    "ST4: the study tag caps at RESULT_STUDY_MAX (80, the preset-name twin)");
}

// ====== GO: v35 gallery order — mix round-robin, newest, bands, paging

{
  const shop = "order.myshopify.com";
  const seedOrdered = (t: string, over: Record<string, unknown>) =>
    seedResult(shop, { beforeUrl: "https://cdn/" + t + ".jpg", testimonial: t, ...over });
  seedOrdered("A1", { source: "lab", study: "A" });
  seedOrdered("A2", { source: "lab", study: "A" });
  seedOrdered("A3", { source: "lab", study: "A" });
  seedOrdered("B1", { source: "lab", study: "B" });
  seedOrdered("B2", { source: "lab", study: "B" });
  seedOrdered("C1", {});
  seedOrdered("D1", { source: "lab", study: "D", featured: true });
  const names = (res: { items: { testimonial: string | null }[] }) =>
    res.items.map((i) => i.testimonial).join(",");

  const curated = await P.getPublicResults(shop, null, {}, 1, 12);
  ok(names(curated) === "D1,A1,A2,A3,B1,B2,C1",
    "GO1: default (curated) = featured first, then manual order — the pre-v35 sequence");
  const explicit = await P.getPublicResults(shop, null, {}, 1, 12, "curated");
  ok(names(explicit) === "D1,A1,A2,A3,B1,B2,C1", "GO1: explicit curated identical");
  const junk = await P.getPublicResults(shop, null, {}, 1, 12, "bogus");
  ok(names(junk) === "D1,A1,A2,A3,B1,B2,C1",
    "GO1: junk order coerces to curated (fail closed)");

  const mix = await P.getPublicResults(shop, null, {}, 1, 12, "mix");
  ok(names(mix) === "D1,A1,B1,C1,A2,B2,A3",
    "GO2: mix = one result from EVERY study first (round-robin, study-less rows share one group, featured pulls its study to the front)");
  ok(mix.total === 7 && mix.verifiedTotal === curated.verifiedTotal,
    "GO2: ordering never changes totals or the scale banner");

  // paging must agree with the one-shot sequence (Show-more contract)
  const p1 = await P.getPublicResults(shop, null, {}, 1, 3, "mix");
  const p2 = await P.getPublicResults(shop, null, {}, 2, 3, "mix");
  const p3 = await P.getPublicResults(shop, null, {}, 3, 3, "mix");
  ok(names(p1) + "," + names(p2) + "," + names(p3) === "D1,A1,B1,C1,A2,B2,A3",
    "GO3: mix pages concatenate to the exact one-shot sequence (no dup, no gap)");

  const newest = await P.getPublicResults(shop, null, {}, 1, 12, "newest");
  ok(names(newest) === "D1,C1,B2,B1,A3,A2,A1",
    "GO4: newest = createdAt desc, featured pin deliberately ignored");

  // mix composes with filters: the filtered subsequence interleaves
  const mixDry = await P.getPublicResults(shop, null, { skin: "dry" }, 1, 12, "mix");
  ok(mixDry.total === 0 || mixDry.items.length === mixDry.total,
    "GO5: filters + mix stay consistent (filtered set interleaves)");

  // drifted CUSTOMER study columns group into the catch-all, never a study
  const shop2 = "order2.myshopify.com";
  const seed2 = (t: string, over: Record<string, unknown>) =>
    seedResult(shop2, { beforeUrl: "https://cdn/" + t + ".jpg", testimonial: t, ...over });
  seed2("A1", { source: "lab", study: "A" });
  seed2("A2", { source: "lab", study: "A" });
  seed2("CX", { study: "A" }); // drifted customer row
  seed2("CY", {});
  const mix2 = await P.getPublicResults(shop2, null, {}, 1, 12, "mix");
  ok(names(mix2) === "A1,CX,A2,CY",
    "GO6: a drifted customer study column cannot join the study's group (lab-gated key)");

  // product bands reorder INTERNALLY — tagged rows never sink below brand
  const shop3 = "order3.myshopify.com";
  const seed3 = (t: string, over: Record<string, unknown>) =>
    seedResult(shop3, { beforeUrl: "https://cdn/" + t + ".jpg", testimonial: t, ...over });
  seed3("b1", { source: "lab", study: "X" });
  seed3("t1", { source: "lab", study: "Y", productGids: JSON.stringify([GID_P]) });
  seed3("b2", {});
  seed3("t2", { source: "lab", study: "Y", productGids: JSON.stringify([GID_P]) });
  seed3("t3", { source: "lab", study: "Z", productGids: JSON.stringify([GID_P]) });
  const mixP = await P.getPublicResults(shop3, GID_P, {}, 1, 12, "mix");
  ok(names(mixP) === "t1,t3,t2,b1,b2",
    "GO7: mix interleaves INSIDE each product band (tagged first, brand after — spec §2 holds)");
  const newestP = await P.getPublicResults(shop3, GID_P, {}, 1, 12, "newest");
  ok(names(newestP) === "t3,t2,t1,b2,b1",
    "GO7: newest sorts inside each band too");
}

// ========== SB: v35 study batches — one study, many rows, one validation

{
  const shop = "batch.myshopify.com";
  const baseBatch = {
    study: "  Oslo Trial  ",
    testimonial: " Clinically documented. ",
    attributionName: " Dr. X ",
    attributionRole: " Dermatologist ",
    durationWeeks: 8,
    measurements: [
      { label: " Depth ", dir: "down", info: " scan " },
      { label: "Firmness", dir: "up", info: "" },
    ],
    markInstrument: true,
    markSamePatient: false,
    markUnretouched: true,
    verified: true,
    country: "no",
    concern: "Wrinkles!",
    productGids: [] as string[],
    status: "approved",
    savePreset: true,
    rows: [
      { beforeUrl: "https://cdn/1b.jpg", afterUrl: "https://cdn/1a.jpg", combinedUrl: "", pcts: [18, 14.3], ageRange: "25-34", skinType: "dry" },
      { beforeUrl: "https://cdn/2b.jpg", afterUrl: "https://cdn/2a.jpg", combinedUrl: "", pcts: [21.4, 9], ageRange: "", skinType: "" },
      { beforeUrl: "https://cdn/3b.jpg", afterUrl: "https://cdn/3a.jpg", combinedUrl: "", pcts: [2, 3], ageRange: "", skinType: "" },
    ],
  };
  const batch = await P.saveResultBatch(shop, baseBatch);
  ok(batch.ok === true && batch.created === 3 && batch.total === 3,
    "SB1: a valid 3-row batch creates every row");
  ok(batch.presetSaved === true, "SB1: the study constants upsert as a preset");
  const served = await P.getPublicResults(shop, null, {}, 1, 12);
  ok(served.total === 3, "SB1: all three rows serve");
  ok(served.items.map((i: { beforeUrl: string | null }) => i.beforeUrl).join(",") ===
      "https://cdn/1b.jpg,https://cdn/2b.jpg,https://cdn/3b.jpg",
    "SB1: the batch keeps its on-screen order in the curated sequence (one sortWeight run)");
  const first = served.items[0];
  ok(first.source === "lab" && first.study === "Oslo Trial" && first.verified === true,
    "SB1: rows are lab entries tagged with the trimmed study name");
  ok(JSON.stringify(first.measurements) === JSON.stringify([
      { label: "Depth", dir: "down", pct: 18, info: "scan" },
      { label: "Firmness", dir: "up", pct: 14.3 },
    ]),
    "SB1: shared definitions zip with the row's OWN percents (trimmed, info omitted when blank)");
  ok(served.items[1].measurements[0].pct === 21.4 && served.items[2].measurements[1].pct === 3,
    "SB1: every row carries its own numbers");
  ok(first.country === "NO" && first.concern === "wrinkles" &&
      first.attributionName === "Dr. X" && first.markInstrument === true &&
      first.markSamePatient === false && first.markUnretouched === true,
    "SB1: study-level constants land on every row through the shared cleaners");
  ok(first.ageRange === "25-34" && served.items[1].ageRange === null,
    "SB1: per-row facets stay per-row");

  const presets = await P.listResultPresets(shop);
  const oslo = presets.find((p: { name: string }) => p.name === "Oslo Trial");
  ok(!!oslo && oslo.fields.measurements.length === 2 &&
      !("pct" in (oslo.fields.measurements[0] as Record<string, unknown>)),
    "SB2: the upserted preset is pct-free (the v34 rule)");

  // all-or-nothing: ONE bad percent refuses the WHOLE batch
  const bad = await P.saveResultBatch(shop, {
    ...baseBatch,
    study: "Bad Pct Study",
    rows: [
      baseBatch.rows[0],
      { ...baseBatch.rows[1], pcts: [3.25, 9] },
    ],
  });
  ok(bad.ok === false && bad.created === 0,
    "SB3: one invalid percent refuses the whole batch (all-or-nothing)");
  ok(bad.errors.some((e: string) => e.startsWith("Row 2: Measurement 1 needs a percent")),
    "SB3: errors are row-numbered");
  const afterBad = await P.getPublicResults(shop, null, {}, 1, 24);
  ok(afterBad.total === 3 && !afterBad.items.some((i: { study: string | null }) => i.study === "Bad Pct Study"),
    "SB3: a refused batch writes NOTHING");

  // photo rule: every row needs its active layout's photo(s)
  const onePhoto = await P.saveResultBatch(shop, {
    ...baseBatch,
    study: "One Photo Study",
    rows: [{ beforeUrl: "https://cdn/x.jpg", afterUrl: "", combinedUrl: "", pcts: [1, 2], ageRange: "", skinType: "" }],
  });
  ok(onePhoto.ok === false &&
      onePhoto.errors.some((e: string) => e === "Row 1: needs both a before and an after photo (or one combined photo)"),
    "SB4: a pair row missing one photo is refused with the row number");
  const combined = await P.saveResultBatch(shop, {
    ...baseBatch,
    study: "Combined Study",
    savePreset: false,
    rows: [{ beforeUrl: "", afterUrl: "", combinedUrl: "https://cdn/combo.jpg", pcts: [1, 2], ageRange: "", skinType: "" }],
  });
  ok(combined.ok === true && combined.created === 1,
    "SB4: a combined-photo row satisfies the photo rule");
  ok(combined.presetSaved === false &&
      !(await P.listResultPresets(shop)).some((p: { name: string }) => p.name === "Combined Study"),
    "SB4: savePreset off -> no preset row");
  const servedCombined = await P.getPublicResults(shop, null, {}, 1, 24);
  const comboItem = servedCombined.items.find(
    (i: { study: string | null }) => i.study === "Combined Study",
  );
  ok(!!comboItem && comboItem.combinedUrl === "https://cdn/combo.jpg" && comboItem.beforeUrl === null,
    "SB4: the combined row serves through the v33 combined-wins contract");

  // header validation
  const noStudy = await P.saveResultBatch(shop, { ...baseBatch, study: "   " });
  ok(noStudy.ok === false && noStudy.errors.includes("Study name is required"),
    "SB5: a batch needs its study name");
  const noRows = await P.saveResultBatch(shop, { ...baseBatch, study: "Empty", rows: [] });
  ok(noRows.ok === false && noRows.errors.includes("Add at least one before/after row"),
    "SB5: a batch needs rows");
  const tooMany = await P.saveResultBatch(shop, {
    ...baseBatch,
    study: "Huge",
    rows: Array.from({ length: 101 }, () => baseBatch.rows[0]),
  });
  ok(tooMany.ok === false && tooMany.errors.includes("No more than 100 rows per batch"),
    "SB5: the row cap holds");

  // error cap: a systematic mistake stays readable
  const noisy = await P.saveResultBatch(shop, {
    ...baseBatch,
    study: "Noisy",
    rows: Array.from({ length: 13 }, () => ({
      beforeUrl: "", afterUrl: "", combinedUrl: "", pcts: [1, 2] as unknown[], ageRange: "", skinType: "",
    })),
  });
  ok(noisy.ok === false && noisy.errors.length === 13 &&
      noisy.errors[12].startsWith("…and ") && noisy.errors[12].includes("more problem"),
    "SB6: row errors cap at 12 + an honest overflow line");
}

// ===================== UC: v25 results-ui-copy table (18 native locales)

{
  // Pure module, no imports — load the REAL file directly.
  const UC = await import(
    pathToFileURL(path.join(ROOT, "app", "services", "results-ui-copy.server.ts")).href
  );
  const table = UC.RESULTS_UI_COPY as Record<string, Record<string, string>>;
  const locales = Object.keys(table).sort();
  // Must cover exactly the extension's published theme languages
  // (en.default.json -> "en"; pt-PT normalizes to "pt-pt").
  const catalogs = fs
    .readdirSync(path.join(ROOT, "extensions", "cellexia-booster", "locales"))
    .filter((f: string) => f.endsWith(".json"))
    .map((f: string) => f.replace(".default", "").replace(".json", "").toLowerCase())
    .sort();
  ok(locales.join(",") === catalogs.join(","),
    `UC1: copy table covers EXACTLY the 18 catalog languages (${locales.length})`);
  const codes = ["rp", "ma", "vsb", "mi", "mp", "mu", "aw", "dr", "iv", "zm"];
  ok(JSON.stringify([...UC.RESULTS_UI_COPY_CODES]) === JSON.stringify(codes),
    "UC1: exported code list matches the storefront whitelist");
  for (const locale of locales) {
    for (const code of codes) {
      const value = table[locale][code];
      ok(typeof value === "string" && /\S/.test(value),
        `UC2: ${locale}.${code} is non-blank`);
      ok(!value.includes("\u2014"),
        `UC2: ${locale}.${code} carries no em dash (merchant rule)`);
    }
    ok(table[locale].ma.includes("@@N@@"),
      `UC2: ${locale}.ma carries the @@N@@ weeks sentinel`);
    ok(table[locale].aw.includes("@@N@@"),
      `UC2: ${locale}.aw carries the @@N@@ weeks sentinel (v33)`);
  }
  ok(table.nb === table.no, "UC3: nb/no are twins (house convention)");
  ok(UC.resultsUiCopy("el") === table.el, "UC4: exact locale resolves");
  ok(UC.resultsUiCopy("de-AT") === table.de, "UC4: regional falls back to base");
  ok(UC.resultsUiCopy("pt") === table["pt-pt"], "UC4: bare pt aliases to pt-pt");
  ok(UC.resultsUiCopy("pt-BR") === table["pt-pt"], "UC4: pt-br aliases to pt-pt");
  ok(UC.resultsUiCopy("xx") === table.en && UC.resultsUiCopy(null) === table.en &&
    UC.resultsUiCopy("") === table.en,
    "UC4: unknown/blank locale serves English, never blank chrome");
  ok(table.en.rp === "Real people. Real results." &&
    table.en.ma === "Clinically measured at @@N@@ weeks" &&
    table.en.vsb === "vs. baseline" && table.en.mi === "Instrument measured" &&
    table.en.mp === "Same patient" && table.en.mu === "Unretouched images",
    "UC5: the English source strings are the mock's exact wording");
  ok(table.en.aw === "After @@N@@ weeks" && table.en.dr === "Drag to compare" &&
    table.en.iv === "Individual results may vary." && table.en.zm === "View larger",
    "UC5: the v33 English source strings are pinned");
}

// ==================================== MH: market-handle clean/parse trips

{
  const shop = "handles.myshopify.com";
  ok(JSON.stringify(P.parseMarketHandles(null)) === "[]", "MH1: null column -> every market");
  ok(JSON.stringify(P.parseMarketHandles("")) === "[]", "MH1: empty column -> every market");
  ok(JSON.stringify(P.parseMarketHandles("not json")) === "[]", "MH1: corrupt JSON -> every market (defensive)");
  ok(JSON.stringify(P.parseMarketHandles('"eu"')) === "[]", "MH1: non-array JSON -> every market");
  ok(
    JSON.stringify(P.parseMarketHandles('["eu","EU!","x y",3,"ok-1"]')) === '["eu","ok-1"]',
    "MH2: parse filters entries that fail the market-handle pattern",
  );

  const saved = await P.savePressItem(shop, {
    publication: "RT", logoUrl: "", quote: "Q", articleUrl: "",
    productGids: [], marketHandles: ["EU", " eu ", "us-east"], featured: false, status: "approved",
  });
  ok(saved.ok === true, "MH3: mixed-case/whitespace handles sanitize instead of failing");
  const row = db._tables.pressItem.find((r) => r.id === saved.id);
  ok(!!row && row.marketHandles === '["eu","us-east"]',
    "MH3: stored column is the lowercased deduped JSON");
  ok(JSON.stringify(P.parseMarketHandles((row as StubRow).marketHandles as string)) === '["eu","us-east"]',
    "MH3: clean -> store -> parse round-trips exactly");
  const served = await P.getPublicPress(shop, null, "us-east");
  ok(served.items.some((i: { publication: string }) => i.publication === "RT"),
    "MH3: the saved item serves on its cleaned market");

  const bad = await P.savePressItem(shop, {
    publication: "X", logoUrl: "", quote: "Q", articleUrl: "",
    productGids: [], marketHandles: ["Bad_Handle!"], featured: false, status: "approved",
  });
  ok(bad.ok === false && bad.errors.some((e: string) => e.startsWith("Not a valid market handle")),
    "MH4: an invalid handle fails the save with the exact error");

  const many = await P.savePressItem(shop, {
    publication: "X", logoUrl: "", quote: "Q", articleUrl: "",
    productGids: [], marketHandles: Array.from({ length: 51 }, (_, i) => `m${i}`),
    featured: false, status: "approved",
  });
  ok(many.ok === false && many.errors.includes("No more than 50 markets"),
    "MH5: the 50-market cap is enforced");
}

// ========================================= SV: savePressItem validation

{
  const shop = "save.myshopify.com";
  const base = {
    publication: "Vogue", logoUrl: "https://cdn/logo.svg", quote: "Q",
    articleUrl: "https://vogue.com/a", productGids: [], marketHandles: [],
    featured: false, status: "approved",
  };

  const noPub = await P.savePressItem(shop, { ...base, publication: "  " });
  ok(noPub.ok === false && noPub.errors.includes("A publication name is required"),
    "SV1: whitespace publication rejected");
  const httpLogo = await P.savePressItem(shop, { ...base, logoUrl: "http://cdn/logo.svg" });
  ok(httpLogo.ok === false && httpLogo.errors.includes("Logo image must be an https:// URL"),
    "SV2: http logo rejected by the https gate");
  const jsLink = await P.savePressItem(shop, { ...base, articleUrl: "javascript:alert(1)" });
  ok(jsLink.ok === false && jsLink.errors.includes("Article link must be an https:// URL"),
    "SV2: javascript: article link rejected");

  const first = await P.savePressItem(shop, { ...base, articleUrl: "" });
  ok(first.ok === true && typeof first.id === "string", "SV3: valid save without a link succeeds");
  const firstRow = db._tables.pressItem.find((r) => r.id === first.id) as StubRow;
  ok(firstRow.articleUrl === null,
    "SV3: optional articleUrl stores NULL (quote-without-link, the v8.1 admin story)");
  ok(firstRow.logoUrl === "https://cdn/logo.svg" && firstRow.sortWeight === 0,
    "SV3: first row of a fresh shop takes sortWeight 0");
  const second = await P.savePressItem(shop, base);
  const secondRow = db._tables.pressItem.find((r) => r.id === second.id) as StubRow;
  ok(secondRow.sortWeight === 1, "SV3: the next row appends after the current max weight");

  // v8.14: the quote is OPTIONAL — a publication alone is a logo-only
  // mention. Whitespace normalizes to "" and is STORED (the column is
  // non-nullable; the translation layer skips blank sources).
  const logoOnly = await P.savePressItem(shop, { ...base, quote: "   " });
  ok(logoOnly.ok === true && typeof logoOnly.id === "string",
    "SV3b: quote-less entry saves (v8.14 logo-only mention)");
  const logoOnlyRow = db._tables.pressItem.find((r) => r.id === logoOnly.id) as StubRow;
  ok(logoOnlyRow.quote === "" && logoOnlyRow.sortWeight === 2,
    "SV3b: whitespace quote stores '' and the row appends normally");

  const badGid = await P.savePressItem(shop, { ...base, productGids: ["gid://shopify/Collection/1"] });
  ok(badGid.ok === false && badGid.errors.includes("Tagged products must be Shopify product GIDs"),
    "SV4: non-product GID rejected");
  const dupGid = await P.savePressItem(shop, { ...base, productGids: [GID_P, GID_P, GID_Q] });
  const dupRow = db._tables.pressItem.find((r) => r.id === dupGid.id) as StubRow;
  ok(dupGid.ok === true && dupRow.productGids === JSON.stringify([GID_P, GID_Q]),
    "SV4: duplicate GIDs dedupe silently");
  const manyGids = await P.savePressItem(shop, {
    ...base,
    productGids: Array.from({ length: 21 }, (_, i) => `gid://shopify/Product/${i + 1}`),
  });
  ok(manyGids.ok === false && manyGids.errors.includes("No more than 20 tagged products"),
    "SV4: the 20-product cap is enforced");

  const weird = await P.savePressItem(shop, { ...base, status: "weird" });
  const weirdRow = db._tables.pressItem.find((r) => r.id === weird.id) as StubRow;
  ok(weird.ok === true && weirdRow.status === "approved",
    "SV5: unknown status falls back to approved (closed enum)");
  const hidden = await P.savePressItem(shop, { ...base, status: "hidden" });
  const hiddenRow = db._tables.pressItem.find((r) => r.id === hidden.id) as StubRow;
  ok(hiddenRow.status === "hidden", "SV5: hidden is a legal press status");

  const ghost = await P.savePressItem(shop, base, "no-such-id");
  ok(ghost.ok === false && ghost.errors.includes("Entry not found"),
    "SV6: updating an unknown id fails closed");
  const foreign = await P.savePressItem("other.myshopify.com", base, first.id);
  ok(foreign.ok === false && foreign.errors.includes("Entry not found"),
    "SV6: another shop can never update this shop's entry (ownership check)");
  const updated = await P.savePressItem(shop, { ...base, publication: "Elle" }, first.id);
  ok(updated.ok === true && (db._tables.pressItem.find((r) => r.id === first.id) as StubRow).publication === "Elle",
    "SV6: a legal update mutates the row in place");

  const long = await P.savePressItem(shop, { ...base, publication: "x".repeat(300) });
  const longRow = db._tables.pressItem.find((r) => r.id === long.id) as StubRow;
  ok(long.ok === true && (longRow.publication as string).length === 255,
    "SV7: single-line fields cap at 255 chars");
}

// ======================================== moderation counts (groupBy path)

{
  const shop = "counts.myshopify.com";
  seedPress(shop, {});
  seedPress(shop, {});
  seedPress(shop, { status: "hidden" });
  seedResult(shop, { beforeUrl: "https://cdn/b.jpg", status: "pending" });
  const counts = await P.getProofModerationCounts(shop);
  ok(counts.ok === true && counts.press.total === 3 && counts.press.approved === 2 && counts.press.pending === 0,
    "MC1: moderation counts group press rows by status");
  ok(counts.results.total === 1 && counts.results.pending === 1,
    "MC1: pending results counted for the hub badge");
  const flat = await P.getProofCounts(shop);
  ok(!!flat && flat.press === 2 && flat.results === 0 && flat.endorsements === 0,
    "MC2: readiness counts are APPROVED-only flat numbers");
}

// ------------------------------------------------------------------ mutants

if (!process.env.CX_SKIP_MUTANTS && failures === 0) {
  const require2 = createRequire(import.meta.url);
  const { runMutants } = require2("./lib/mutants.cjs");
  // mutants.cjs re-runs suites with plain `node`; hand it the tsx bridge
  // and export this suite's path for it (see lib/tsx-shim.cjs header).
  process.env.CX_TSX_SUITE = fileURLToPath(import.meta.url);
  const failedMutants = runMutants({
    selfPath: path.join(HERE, "lib", "tsx-shim.cjs"),
    srcPath: REAL_SRC,
    mutants: [
      {
        name: "m1-market-filter-dead-code",
        find: "  const scoped = prioritiseForProduct(marketScoped, productGid);",
        replace: "  const scoped = prioritiseForProduct(rows, productGid);",
      },
      {
        name: "m2-imageless-served",
        find: "  const renderable = rows.filter(\n    (row) =>\n      row.beforeUrl !== null ||\n      row.afterUrl !== null ||\n      // v33: the combined figure counts only where it will actually serve\n      // (lab rows — the belt below nulls it for customer rows, and a row\n      // counted here but never rendered would drift totals/pagination).\n      (row.source === \"lab\" && row.combinedUrl !== null),\n  );",
        replace: "  const renderable = rows;",
      },
      {
        name: "m3-press-status-pin-dropped",
        find: "  const rows = await prisma.pressItem.findMany({\n    where: { shop, status: \"approved\" },",
        replace: "  const rows = await prisma.pressItem.findMany({\n    where: { shop },",
      },
      {
        name: "m4-tagged-other-kept",
        find: "    if (gids.length === 0) brand.push(row);\n    else if (gids.includes(productGid)) tagged.push(row);\n    // tagged for other products only -> excluded",
        replace: "    if (gids.length === 0) brand.push(row);\n    else tagged.push(row);",
      },
      {
        name: "m5-endo-total-page-scoped",
        find: "    // ALL approved matching — the storefront scale number.\n    total: scoped.length,",
        replace: "    total: scoped.slice(start, start + per).length,",
      },
      {
        // v25: the serve-time lab belt dropped — drifted customer rows
        // would serve instrument claims (SR3 catches).
        name: "m6-serve-lab-belt-dropped",
        find: "        measurements: lab ? parseResultMeasurements(row.measurements) : [],",
        replace: "        measurements: parseResultMeasurements(row.measurements),",
      },
      {
        // v25: the measurements-need-duration rule dropped — a panel
        // could claim measurements with no "at N weeks" (SR4 catches).
        name: "m7-clin-duration-req-dropped",
        find: "  if (measurements.length > 0 && (durationWeeks === null || durationWeeks < 1)) {",
        replace: "  if (false) {",
      },
      {
        // v33: the combined serve belt dropped — a drifted customer row
        // would serve its combined photo (PR12 catches).
        name: "m8-combined-belt-dropped",
        find: "        combinedUrl: lab ? row.combinedUrl : null,",
        replace: "        combinedUrl: row.combinedUrl,",
      },
      {
        // v33: the save-side lab gate dropped — customer entries could
        // keep a combined photo (SR5's refused-flip catches).
        name: "m9-combined-save-gate-dropped",
        find: "  const combinedUrl = isLab\n    ? cleanHttpsUrl(input.combinedUrl, \"Combined before/after image\", errors)\n    : \"\";",
        replace: "  const combinedUrl = cleanHttpsUrl(input.combinedUrl, \"Combined before/after image\", errors);",
      },
      {
        // v33: "combined wins" dropped — a row could carry BOTH layouts
        // and render twice (SR5's pair-null catch).
        name: "m10-combined-wins-dropped",
        find: "    beforeUrl: beforeUrl === \"\" || combinedUrl !== \"\" ? null : beforeUrl,\n    afterUrl: afterUrl === \"\" || combinedUrl !== \"\" ? null : afterUrl,",
        replace: "    beforeUrl: beforeUrl === \"\" ? null : beforeUrl,\n    afterUrl: afterUrl === \"\" ? null : afterUrl,",
      },
      {
        // v34: the preset list's shop scope dropped — one shop's study
        // templates would leak into every other admin (PS4 catches).
        name: "m11-preset-shop-scope-dropped",
        find: "  const rows = await prisma.resultPreset.findMany({\n    where: { shop },\n    orderBy: { name: \"asc\" },",
        replace: "  const rows = await prisma.resultPreset.findMany({\n    where: {},\n    orderBy: { name: \"asc\" },",
      },
      {
        // v34: same-name upsert dropped — every re-save would pile up a
        // duplicate preset until the cap (PS2's single-row catch).
        name: "m12-preset-upsert-dropped",
        find: "    const existing = await prisma.resultPreset.findFirst({\n      where: { shop, name },\n    });",
        replace: "    const existing = null as { id: string } | null;",
      },
      {
        // v35: the gallery order ignored — "mix"/"newest" would silently
        // serve the curated sequence (GO2/GO4 catch).
        name: "m13-gallery-order-ignored",
        find: "  const served = applyGalleryOrder(\n    filtered,\n    cleanEnum(order, RESULTS_GALLERY_ORDERS, \"curated\") as ResultsGalleryOrder,\n    productGid,\n  );",
        replace: "  const served = filtered;",
      },
      {
        // v35: the study serve belt dropped — a drifted customer row
        // would flaunt a study tag (ST3 catches).
        name: "m14-study-belt-dropped",
        find: "        study: lab ? row.study : null,",
        replace: "        study: row.study,",
      },
      {
        // v35: all-or-nothing dropped — a batch with a bad row would
        // half-import and the merchant would trust a wrong library
        // (SB3's refused-batch + writes-nothing catches).
        name: "m15-batch-partial-write",
        find: "  if (errors.length > 0) {\n    return {\n      ok: false,\n      created: 0,\n      total,\n      presetSaved: false,\n      errors: capBatchErrors(errors),\n    };\n  }",
        replace: "  errors.length = 0;",
      },
      {
        // v35: the mix key's lab gate dropped — a drifted customer study
        // column would join a study's group (GO6 catches).
        name: "m16-mix-lab-gate-dropped",
        find: "    const key = row.source === \"lab\" && row.study ? `s:${row.study}` : \"\";",
        replace: "    const key = row.study ? `s:${row.study}` : \"\";",
      },
    ],
  });
  if (failedMutants > 0) {
    console.error(`\n${failedMutants} MUTANT(S) NOT CAUGHT`);
    process.exit(1);
  }
  // The mutant children wrote their own .gen basename — remove the residue.
  try {
    fs.unlinkSync(path.join(ROOT, "validation", "lib", ".gen", "proof.server.mutant.ts"));
  } catch {
    // best-effort cleanup
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${checks} CHECKS FAILED`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED (v8 proof server — public projections vs the real proof.server.ts)`);
