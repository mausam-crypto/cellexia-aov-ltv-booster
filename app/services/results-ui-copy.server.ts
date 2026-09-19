/**
 * v25 — fixed UI strings for the results gallery's clinical redesign,
 * served through the proof proxy (`payload.copy`, island codes below).
 *
 * WHY NOT LOCALE FILES: `el.json`/`ar.json` sit against Shopify's
 * per-locale-file byte cap (harness pin 15,200B), so new storefront
 * strings cannot ride the extension catalogs (the v24 "zero new locale
 * keys" rule). These six strings are fixed widget chrome, not merchant
 * copy, so they also don't belong in settings + DeepL (the v8.19 "copy"
 * scope is for merchant-EDITED text). They live here as a curated,
 * reviewable table — one entry per published theme language, written
 * native (no em dashes, correct register per file), mirroring each
 * catalog's existing results.* conventions (ar dodges number agreement
 * the way `weeks_of_use` does; pl uses the catalog's "tyg." brevity).
 *
 * The storefront merges them via resultsApplyCopy (whitelisted codes,
 * pfStrRaw reads — they never pass Liquid's t-filter escaping) and every
 * dependent element fails soft when a code is missing: no tagline, no
 * panel header, no trust-mark row — never broken text.
 *
 * Island codes (must stay distinct from the #cx-results-config str keys):
 *   rp  tagline under the scale banner ("Real people. Real results.")
 *   ma  clinical panel header; @@N@@ = the entry's durationWeeks
 *   vsb panel header's comparison tag ("vs. baseline")
 *   mi/mp/mu  the three trust-mark labels (instrument / same patient /
 *             unretouched) — rendered only for marks the merchant checked
 */

export interface ResultsUiCopy {
  rp: string;
  ma: string;
  vsb: string;
  mi: string;
  mp: string;
  mu: string;
}

export const RESULTS_UI_COPY_CODES = [
  "rp",
  "ma",
  "vsb",
  "mi",
  "mp",
  "mu",
] as const;

const NO_TABLE: ResultsUiCopy = {
  rp: "Ekte mennesker. Ekte resultater.",
  ma: "Klinisk målt etter @@N@@ uker",
  vsb: "mot utgangspunktet",
  mi: "Målt med instrumenter",
  mp: "Samme person",
  mu: "Uretusjerte bilder",
};

/** Keyed by NORMALIZED (lowercase) storefront locale — the proxy
 *  normalizes `request.locale.iso_code` before the lookup. `nb`/`no` are
 *  twins, `pt-pt` is the catalog's Portuguese (the house conventions). */
export const RESULTS_UI_COPY: Record<string, ResultsUiCopy> = {
  en: {
    rp: "Real people. Real results.",
    ma: "Clinically measured at @@N@@ weeks",
    vsb: "vs. baseline",
    mi: "Instrument measured",
    mp: "Same patient",
    mu: "Unretouched images",
  },
  ar: {
    rp: "أشخاص حقيقيون. نتائج حقيقية.",
    ma: "قياس سريري في الأسبوع @@N@@",
    vsb: "مقارنة بالقياس الأولي",
    mi: "قياس بالأجهزة",
    mp: "الشخص نفسه",
    mu: "صور غير معدلة",
  },
  da: {
    rp: "Ægte mennesker. Ægte resultater.",
    ma: "Klinisk målt efter @@N@@ uger",
    vsb: "ift. udgangspunktet",
    mi: "Målt med instrumenter",
    mp: "Samme person",
    mu: "Uretoucherede billeder",
  },
  de: {
    rp: "Echte Menschen. Echte Ergebnisse.",
    ma: "Klinisch gemessen nach @@N@@ Wochen",
    vsb: "vs. Ausgangswert",
    mi: "Instrumentell gemessen",
    mp: "Dieselbe Person",
    mu: "Unretuschierte Bilder",
  },
  el: {
    rp: "Αληθινοί άνθρωποι. Αληθινά αποτελέσματα.",
    ma: "Κλινική μέτρηση στις @@N@@ εβδομάδες",
    vsb: "έναντι αρχικής τιμής",
    mi: "Μέτρηση με όργανα",
    mp: "Το ίδιο άτομο",
    mu: "Φωτογραφίες χωρίς ρετούς",
  },
  es: {
    rp: "Personas reales. Resultados reales.",
    ma: "Medición clínica a las @@N@@ semanas",
    vsb: "vs. valor inicial",
    mi: "Medido con instrumentos",
    mp: "La misma persona",
    mu: "Imágenes sin retocar",
  },
  fi: {
    rp: "Aitoja ihmisiä. Aitoja tuloksia.",
    ma: "Kliinisesti mitattu @@N@@ viikon kohdalla",
    vsb: "vs. lähtötaso",
    mi: "Mitattu mittalaitteilla",
    mp: "Sama henkilö",
    mu: "Muokkaamattomat kuvat",
  },
  fr: {
    rp: "De vraies personnes. De vrais résultats.",
    ma: "Mesuré cliniquement à @@N@@ semaines",
    vsb: "vs état initial",
    mi: "Mesuré par instruments",
    mp: "Même personne",
    mu: "Photos non retouchées",
  },
  hu: {
    rp: "Valódi emberek. Valódi eredmények.",
    ma: "Klinikai mérés @@N@@ hét után",
    vsb: "a kiinduláshoz képest",
    mi: "Műszeres mérés",
    mp: "Ugyanaz a személy",
    mu: "Retusálatlan képek",
  },
  it: {
    rp: "Persone vere. Risultati veri.",
    ma: "Misurazione clinica a @@N@@ settimane",
    vsb: "vs. valore iniziale",
    mi: "Misurato con strumenti",
    mp: "Stessa persona",
    mu: "Immagini non ritoccate",
  },
  ja: {
    rp: "実際の使用者による、本物の結果。",
    ma: "@@N@@週時点の臨床測定",
    vsb: "開始時との比較",
    mi: "機器測定",
    mp: "同一人物",
    mu: "無加工の写真",
  },
  nb: NO_TABLE,
  nl: {
    rp: "Echte mensen. Echte resultaten.",
    ma: "Klinisch gemeten na @@N@@ weken",
    vsb: "t.o.v. beginwaarde",
    mi: "Instrumenteel gemeten",
    mp: "Dezelfde persoon",
    mu: "Onbewerkte foto's",
  },
  no: NO_TABLE,
  pl: {
    rp: "Prawdziwi ludzie. Prawdziwe efekty.",
    ma: "Pomiar kliniczny po @@N@@ tyg.",
    vsb: "vs. stan wyjściowy",
    mi: "Pomiar aparaturą",
    mp: "Ta sama osoba",
    mu: "Zdjęcia bez retuszu",
  },
  "pt-pt": {
    rp: "Pessoas reais. Resultados reais.",
    ma: "Medição clínica às @@N@@ semanas",
    vsb: "vs. valor inicial",
    mi: "Medido com instrumentos",
    mp: "A mesma pessoa",
    mu: "Imagens não retocadas",
  },
  ro: {
    rp: "Oameni reali. Rezultate reale.",
    ma: "Măsurat clinic la @@N@@ săptămâni",
    vsb: "vs. valoarea inițială",
    mi: "Măsurat cu instrumente",
    mp: "Aceeași persoană",
    mu: "Imagini neretușate",
  },
  sv: {
    rp: "Riktiga människor. Riktiga resultat.",
    ma: "Kliniskt uppmätt efter @@N@@ veckor",
    vsb: "mot utgångsläget",
    mi: "Uppmätt med instrument",
    mp: "Samma person",
    mu: "Oretuscherade bilder",
  },
};

/** Region variants fall back to their base language ("de-at" -> de); a
 *  bare or regional Portuguese falls back to the pt-pt table. */
const BASE_ALIASES: Record<string, string> = { pt: "pt-pt" };

/**
 * Resolve the copy table for a storefront locale: exact match, then the
 * base language (aliases applied), then English. Always returns a full
 * table — a missing translation must degrade to readable English, never
 * to blank widget chrome.
 */
export function resultsUiCopy(locale: string | null | undefined): ResultsUiCopy {
  const normalized = typeof locale === "string" ? locale.trim().toLowerCase() : "";
  if (normalized !== "") {
    const exact = RESULTS_UI_COPY[normalized];
    if (exact) return exact;
    const base = normalized.split("-")[0];
    const alias = BASE_ALIASES[base] ?? base;
    const byBase = RESULTS_UI_COPY[alias];
    if (byBase) return byBase;
  }
  return RESULTS_UI_COPY.en;
}
