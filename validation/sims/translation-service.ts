/**
 * Translation-service sim (v5.2 + v6.4) — executes the REAL
 * app/services/translation.server.ts against a mock DeepL (globalThis.fetch
 * intercepted — the suite is offline by construction) and a mock Admin
 * GraphQL client. Proves:
 *
 *  - ALLOWLISTS: only TRANSLATABLE_FIELD_KEYS fields with real language
 *    reach DeepL — proper nouns/identifiers (lab_name, INCI, licenses),
 *    URLs, ISO dates, letter-less strings and empties never do; the
 *    metaobject "value" field (study-result numbers) stays out;
 *  - SCOPED METAFIELD ADMISSION (v6.4): a metafield's "value" joins the
 *    run only for the exact GIDs passed by the caller (the product's
 *    cellexia.bestseller_category), never for any other metafield;
 *  - INCREMENTAL / OUTDATED-ONLY: fields with a CURRENT translation are
 *    skipped (zero quota), outdated ones re-translate; identical source
 *    strings deduplicate per run;
 *  - MANUAL-EDIT PRESERVATION: a current Translate & Adapt entry (Shopify
 *    does not distinguish authors) is never overwritten;
 *  - per-language independence: unsupported locale reported, same-base
 *    locale skipped without quota, a 403 in one language never blocks the
 *    others; registrations carry the source digest and drop empties.
 */
import {
  TRANSLATABLE_FIELD_KEYS,
  aliasForLocale,
  chunk,
  collectAllowedMetafieldGids,
  collectBoosterResourceGids,
  deeplEndpointForKey,
  deeplSourceForLocale,
  deeplTargetForLocale,
  shouldTranslateField,
  shouldTranslateMetafieldValue,
  translateResources,
  verifyDeeplKey,
} from "../../app/services/translation.server";
import type { ProductBoostersResult } from "../../app/services/pdp-content.server";

let checks = 0;
let failures = 0;
function ok(cond: boolean, label: string) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  }
}

// ---------------------------------------------------------------- unit layer
ok(deeplEndpointForKey("abc:fx") === "https://api-free.deepl.com", "':fx' key -> free host");
ok(deeplEndpointForKey("abc") === "https://api.deepl.com", "paid key -> paid host");
ok(deeplTargetForLocale("fr") === "FR", "fr -> FR");
ok(deeplTargetForLocale("pt") === "PT-PT", "pt -> PT-PT");
ok(deeplTargetForLocale("pt-BR") === "PT-BR", "pt-BR -> PT-BR");
ok(deeplTargetForLocale("no") === "NB", "no -> NB");
ok(deeplTargetForLocale("zh-TW") === "ZH-HANT", "zh-TW -> ZH-HANT");
ok(deeplTargetForLocale("de-CH") === "DE", "regional variant falls back to the base");
ok(deeplTargetForLocale("tlh") === null, "unsupported locale -> null");
ok(deeplSourceForLocale("en-US") === "EN", "source: en-US -> EN");
ok(deeplSourceForLocale("tlh") === undefined, "source: unknown -> auto-detect");
ok(aliasForLocale("pt-PT") === "t_pt_PT", "locale alias sanitized");
ok(chunk([1, 2, 3, 4, 5], 2).map((c) => c.join("")).join("|") === "12|34|5", "chunk splits");

ok(shouldTranslateField("title", "Wrinkle depth study") === true, "allowlisted key + language admitted");
ok(shouldTranslateField("lab_name", "Dermatest GmbH") === false, "lab_name never admitted (proper noun)");
ok(shouldTranslateField("value", "93") === false, "'value' is NOT in the field allowlist");
ok(shouldTranslateField("note", "https://example.com/coa.pdf") === false, "URL value rejected");
ok(shouldTranslateField("note", "2024-06-01 batch") === false, "ISO-date-leading value rejected");
ok(shouldTranslateField("suffix", "%") === false, "letter-less value rejected");
ok(shouldTranslateField("intro", "   ") === false, "blank value rejected");
ok(TRANSLATABLE_FIELD_KEYS.has("statement") && !TRANSLATABLE_FIELD_KEYS.has("verifier_license"),
  "allowlist carries copy keys, never identifiers");

const MF_GID = "gid://shopify/Metafield/777";
const ALLOW = new Set([MF_GID]);
ok(shouldTranslateMetafieldValue(MF_GID, "value", "Anti-ageing serums", ALLOW) === true,
  "allowlisted metafield 'value' admitted");
ok(shouldTranslateMetafieldValue("gid://shopify/Metafield/888", "value", "Casual text", ALLOW) === false,
  "metafield OUTSIDE the exact-GID allowlist never admitted");
ok(shouldTranslateMetafieldValue(MF_GID, "type", "Anti-ageing serums", ALLOW) === false,
  "only the 'value' key of an allowlisted metafield is admitted");
ok(shouldTranslateMetafieldValue(MF_GID, "value", "12345", ALLOW) === false,
  "value guards apply to metafields too (letter-less rejected)");

// collect* over a booster result shape
const boosters = {
  ok: true,
  errors: [],
  product: null,
  clinicalStudy: { id: "gid://shopify/Metaobject/1", results: [{ id: "gid://shopify/Metaobject/2" }] },
  beforeAfters: [{ id: "gid://shopify/Metaobject/3" }],
  batchTransparency: {
    id: "gid://shopify/Metaobject/4",
    ingredients: [{ id: "gid://shopify/Metaobject/5" }],
    certificates: [{ id: "not-a-gid" }],
  },
  flags: {},
  bestsellerCategoryMetafieldId: MF_GID,
} as unknown as ProductBoostersResult;
{
  const gids = collectBoosterResourceGids(boosters);
  ok(gids.length === 6 && gids.includes(MF_GID) && !gids.includes("not-a-gid"),
    "collectBoosterResourceGids: parents + leaves + category metafield, non-GIDs dropped");
  const allowed = collectAllowedMetafieldGids(boosters);
  ok(allowed.size === 1 && allowed.has(MF_GID),
    "collectAllowedMetafieldGids: exactly the bestseller-category metafield");
}

// ------------------------------------------------------------- mock DeepL
interface FetchLog {
  url: string;
  body: Record<string, unknown> | null;
}

function installDeepl(behavior?: {
  statusFor?: (targetLang: string) => number;
}) {
  const log: FetchLog[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://api.deepl.com") && !url.startsWith("https://api-free.deepl.com")) {
      throw new Error("sim firewall: unexpected outbound fetch " + url);
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    log.push({ url, body });
    if (url.endsWith("/v2/usage")) {
      return new Response(JSON.stringify({ character_count: 1234, character_limit: 500000 }));
    }
    const target = String(body?.target_lang ?? "");
    const status = behavior?.statusFor ? behavior.statusFor(target) : 200;
    if (status !== 200) return new Response("nope", { status });
    const texts = body?.text as string[];
    return new Response(JSON.stringify({
      translations: texts.map((t) => ({ text: `[${target}] ${t}` })),
    }));
  }) as typeof fetch;
  return log;
}

// ------------------------------------------------------------- mock admin
interface NodeFixture {
  resourceId: string;
  content: { key: string; value: string; digest: string | null; locale: string }[];
  /** locale -> existing translations */
  existing?: Record<string, { key: string; outdated: boolean }[]>;
}

function mockAdmin(nodes: NodeFixture[]) {
  const registered: { id: string; translations: { key: string; locale: string; value: string; translatableContentDigest: string }[] }[] = [];
  const admin = {
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      if (query.includes("translatableResourcesByIds")) {
        const ids = (options?.variables?.ids ?? []) as string[];
        const out = nodes
          .filter((n) => ids.includes(n.resourceId))
          .map((n) => {
            const node: Record<string, unknown> = {
              resourceId: n.resourceId,
              translatableContent: n.content,
            };
            for (const [locale, translations] of Object.entries(n.existing ?? {})) {
              node[aliasForLocale(locale)] = translations;
            }
            return node;
          });
        return new Response(JSON.stringify({ data: { translatableResourcesByIds: { nodes: out } } }));
      }
      if (query.includes("translationsRegister")) {
        registered.push(options?.variables as (typeof registered)[number]);
        return new Response(JSON.stringify({ data: { translationsRegister: { userErrors: [] } } }));
      }
      throw new Error("unexpected admin query");
    },
  };
  return { admin, registered };
}

async function main() {
  // --- verifyDeeplKey ---------------------------------------------------------
  {
    installDeepl();
    const usage = await verifyDeeplKey("k");
    ok(usage.ok === true && usage.characterCount === 1234 && usage.characterLimit === 500000,
      "verifyDeeplKey parses /v2/usage");
    installDeepl({ statusFor: () => 403 });
    // usage endpoint ignores statusFor above (only /translate), so simulate
    // directly: a 403 usage probe reports the key error.
    globalThis.fetch = (async () => new Response("no", { status: 403 })) as typeof fetch;
    const bad = await verifyDeeplKey("k");
    ok(bad.ok === false && /403/.test(bad.error ?? ""), "verifyDeeplKey surfaces the 403 hint");
  }

  // --- full run: admission + dedupe + register --------------------------------
  {
    const log = installDeepl();
    const { admin, registered } = mockAdmin([
      {
        resourceId: "gid://shopify/Metaobject/1", // clinical study
        content: [
          { key: "title", value: "Wrinkle depth study", digest: "d1", locale: "en" },
          { key: "concern", value: "Wrinkle depth study", digest: "d2", locale: "en" }, // duplicate source text
          { key: "lab_name", value: "Dermatest GmbH", digest: "d3", locale: "en" },     // identifier: out
          { key: "footnote", value: "", digest: "d4", locale: "en" },                    // empty: out
          { key: "instruments", value: "Visioscan device", digest: null, locale: "en" }, // no digest: out
        ],
      },
      {
        resourceId: "gid://shopify/Metaobject/2", // study result
        content: [
          { key: "value", value: "Ninety-three", digest: "d5", locale: "en" }, // metaobject "value": out
          { key: "label", value: "less visible wrinkles", digest: "d6", locale: "en" },
        ],
      },
      {
        resourceId: MF_GID, // bestseller category metafield
        content: [{ key: "value", value: "Anti-ageing serums", digest: "d7", locale: "en" }],
      },
      {
        resourceId: "gid://shopify/Metafield/888", // NOT in the allowlist
        content: [{ key: "value", value: "Sneaky copy", digest: "d8", locale: "en" }],
      },
    ]);
    const summary = await translateResources(
      admin,
      "key",
      ["gid://shopify/Metaobject/1", "gid://shopify/Metaobject/2", MF_GID, "gid://shopify/Metafield/888"],
      ["fr", "de"],
      { metafieldValueGids: [MF_GID] },
    );
    ok(summary.ok === true, "run ok");
    ok(summary.fieldCount === 4,
      `admitted exactly title+concern+label+category (got ${summary.fieldCount})`);
    const frCall = log.find((l) => l.body?.target_lang === "FR");
    ok(!!frCall, "DeepL called for fr");
    const frTexts = (frCall?.body?.text ?? []) as string[];
    ok(frTexts.length === 3 &&
       frTexts.includes("Wrinkle depth study") &&
       frTexts.includes("less visible wrinkles") &&
       frTexts.includes("Anti-ageing serums"),
      "identical source strings deduplicated per run (3 unique texts, not 4)");
    ok(frCall?.body?.source_lang === "EN", "source_lang derived from the content locale");
    ok(log.every((l) => !(l.body?.text as string[] | undefined)?.some((t) => t.includes("Dermatest") || t.includes("Sneaky") || t === "Ninety-three")),
      "identifiers, numeric 'value' fields and non-allowlisted metafields NEVER reach DeepL");
    ok(summary.characterCount ===
       2 * ("Wrinkle depth study".length + "less visible wrinkles".length + "Anti-ageing serums".length),
      "quota estimate counts unique texts per language");
    // registrations
    const study = registered.filter((r) => r.id === "gid://shopify/Metaobject/1");
    ok(study.length === 2, "study registered once per locale");
    const frStudy = study.find((r) => r.translations[0]?.locale === "fr");
    ok(!!frStudy && frStudy.translations.length === 2 &&
       frStudy.translations.every((t) => t.value === "[FR] Wrinkle depth study") &&
       frStudy.translations.map((t) => t.key).sort().join(",") === "concern,title",
      "duplicate source text fans back out to both fields");
    ok(registered.every((r) => r.translations.every((t) => typeof t.translatableContentDigest === "string" && t.translatableContentDigest.startsWith("d"))),
      "every registration carries the source-field digest");
    ok(registered.some((r) => r.id === MF_GID), "category metafield translation registered");
    ok(!registered.some((r) => r.id === "gid://shopify/Metafield/888"),
      "non-allowlisted metafield never registered");
    ok(summary.locales.every((l) => l.status === "done"), "both locales report done");
  }

  // --- incremental: current kept (manual edits preserved), outdated redone -------
  {
    const log = installDeepl();
    const { admin, registered } = mockAdmin([
      {
        resourceId: "gid://shopify/Metaobject/1",
        content: [
          { key: "title", value: "Wrinkle depth study", digest: "d1", locale: "en" },
          { key: "footnote", value: "Self-assessment after 8 weeks", digest: "d2", locale: "en" },
        ],
        existing: {
          // fr: title current (e.g. a manual Translate & Adapt edit) —
          // footnote outdated (source text changed since).
          fr: [{ key: "title", outdated: false }, { key: "footnote", outdated: true }],
          // de: everything current — the whole language is a no-op.
          de: [{ key: "title", outdated: false }, { key: "footnote", outdated: false }],
        },
      },
    ]);
    const summary = await translateResources(admin, "key", ["gid://shopify/Metaobject/1"], ["fr", "de"]);
    ok(summary.ok === true, "incremental run ok");
    const frCall = log.find((l) => l.body?.target_lang === "FR");
    const frTexts = (frCall?.body?.text ?? []) as string[];
    ok(frTexts.length === 1 && frTexts[0] === "Self-assessment after 8 weeks",
      "fr: ONLY the outdated field re-translates — the current (manual) title is untouched");
    ok(!log.some((l) => l.body?.target_lang === "DE"),
      "de: fully current -> zero DeepL calls, zero quota");
    ok(summary.locales.find((l) => l.locale === "de")?.status === "done",
      "fully-current language still reports done");
    const frReg = registered.find((r) => r.translations[0]?.locale === "fr");
    ok(!!frReg && frReg.translations.length === 1 && frReg.translations[0].key === "footnote",
      "fr registration touches only the re-translated field (manual edit preserved)");
  }

  // --- per-language independence ---------------------------------------------------
  {
    const log = installDeepl({ statusFor: (target) => (target === "DE" ? 403 : 200) });
    const { admin } = mockAdmin([
      {
        resourceId: "gid://shopify/Metaobject/1",
        content: [{ key: "title", value: "Wrinkle depth study", digest: "d1", locale: "en" }],
      },
    ]);
    const summary = await translateResources(
      admin, "key", ["gid://shopify/Metaobject/1"],
      ["tlh", "en-US", "de", "fr"],
    );
    const by = Object.fromEntries(summary.locales.map((l) => [l.locale, l]));
    ok(by.tlh.status === "unsupported", "unsupported locale reported, run continues");
    ok(by["en-US"].status === "skipped",
      "same-base-as-source locale skipped (Shopify falls back to the primary text)");
    ok(by.de.status === "error" && /403/.test(by.de.error ?? ""),
      "403 in one language reported with the key hint");
    ok(by.fr.status === "done", "a failed language never blocks the next one");
    ok(summary.ok === true, "run counts as ok when at least one language landed");
    ok(log.filter((l) => l.body?.target_lang === "DE").length === 1,
      "403 fails fast — no retry burns the quota");
    ok(!log.some((l) => (l.body?.target_lang as string | undefined)?.startsWith("EN")),
      "skipped locale spends nothing");
  }

  // --- guard rails --------------------------------------------------------------------
  {
    installDeepl();
    const { admin } = mockAdmin([]);
    const none = await translateResources(admin, "key", [], ["fr"]);
    ok(none.ok === false && none.errors.some((e) => e.includes("no booster content")),
      "zero resources: explained, not thrown");
    const noLang = await translateResources(admin, "key", ["gid://shopify/Metaobject/1"], []);
    ok(noLang.ok === false && noLang.errors.some((e) => e.includes("no published extra languages")),
      "zero target locales: explained, not thrown");
    const { admin: admin2 } = mockAdmin([
      {
        resourceId: "gid://shopify/Metaobject/1",
        content: [{ key: "lab_name", value: "Dermatest GmbH", digest: "d1", locale: "en" }],
      },
    ]);
    const noFields = await translateResources(admin2, "key", ["gid://shopify/Metaobject/1"], ["fr"]);
    ok(noFields.ok === false && noFields.errors.some((e) => e.includes("No translatable text")),
      "only-identifier content: explained, nothing sent");
  }

  if (failures > 0) {
    console.error(`\n${failures}/${checks} CHECKS FAILED`);
    process.exit(1);
  }
  console.log(`ALL ${checks} CHECKS PASSED (translation service vs the real translation.server.ts, mock DeepL + admin)`);
}

main().catch((e) => {
  console.error("SIM CRASHED:", e);
  process.exit(1);
});
