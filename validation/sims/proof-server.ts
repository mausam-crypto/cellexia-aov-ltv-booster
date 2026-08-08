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
  const tables: Record<string, StubRow[]> = { pressItem: [], dermEndorsement: [], customerResult: [] };
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
  const outPath = path.join(genDir, "proof.server.real.ts");
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
    ageRange: null,
    skinType: null,
    concern: null,
    durationWeeks: null,
    country: null,
    testimonial: null,
    videoUrl: null,
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
      "afterUrl,ageRange,beforeUrl,concern,country,durationWeeks,id,skinType,source,testimonial,verified,videoUrl",
    "PR4: public result items carry EXACTLY the twelve public fields",
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
        find: "  const renderable = rows.filter(\n    (row) => row.beforeUrl !== null || row.afterUrl !== null,\n  );",
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
    ],
  });
  if (failedMutants > 0) {
    console.error(`\n${failedMutants} MUTANT(S) NOT CAUGHT`);
    process.exit(1);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${checks} CHECKS FAILED`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED (v8 proof server — public projections vs the real proof.server.ts)`);
