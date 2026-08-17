// Ships-from grammar codegen (v8.16/v8.16b) — run: node scripts/gen-ships-from-grammar.mjs
//
// Maintains the whole ships-from grammar surface from the override maps
// below (hand-written articles / case / fused prepositions; base names from
// this machine's ICU — the same CLDR family the storefront's
// Intl.DisplayNames uses):
//   1. every extension locale file gets the natural `amazon.ships_from`
//      sentence + the label-style `amazon.ships_from_fallback` (any stale
//      `ships_from_c` group is REMOVED — see 3);
//   2. locale files listed in MINIFIED_LOCALES are written as single-line
//      JSON: Shopify HARD-CAPS each extension locale file at 15,360 bytes
//      and el.json sits near the cap on its Greek copy alone (2-byte
//      chars); the script FAILS if any file exceeds LOCALE_BYTE_BUDGET;
//   3. the full [pageLocale][ISO2] country-form tables are spliced into
//      assets/cellexia-pdp.js as the generated single-line AZ_SHIPS_FORMS
//      literal — v8.16 shipped them as locale keys and the deploy was
//      REJECTED on the ar/el file caps, so the tables live in the (uncapped)
//      JS asset instead; country names were never locale-file copy anyway
//      (pre-v8.16 they came from Intl.DisplayNames at runtime).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "extensions", "cellexia-booster", "locales");
const PDP_JS = path.join(ROOT, "extensions", "cellexia-booster", "assets", "cellexia-pdp.js");

// Shopify's per-file cap is 15,360B; keep 360B of margin so a growing
// language trips HERE (and in the validation harness) before a deploy fails.
const LOCALE_BYTE_BUDGET = 15200; // v14 (2026-08-16): matches the harness v8.16b locale pin (ar.json 15,087B / el.json 15,123B ship minified; Shopify hard cap 15,360B)
// v8.17: ar.json joined el.json — the endorsement-badge copy took the
// pretty-printed file over budget; minified it has ~1.2KB of headroom.
const MINIFIED_LOCALES = ["ar.json", "el.json"];

const COUNTRIES = ["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","CH","NO","IS","LI","GB","MC","AD","TR","UA","RS","US","CA","MX","BR","AU","NZ","JP","CN","HK","TW","KR","SG","TH","VN","MY","ID","PH","IN","AE","IL","ZA","MA"];

// file basename (w/o .json) -> [Intl locale, template, fallback, overrides]
const LANGS = {
  "en.default": {
    intl: "en",
    tpl: "Ships from {{ country }}",
    fb: "Ships from: {{ country }}",
    o: {
      US: "the United States", GB: "the United Kingdom", NL: "the Netherlands",
      AE: "the United Arab Emirates", PH: "the Philippines", HK: "Hong Kong",
    },
  },
  fr: {
    intl: "fr",
    tpl: "Expédié depuis {{ country }}",
    fb: "Expédié depuis : {{ country }}",
    o: {
      AT: "l'Autriche", BE: "la Belgique", BG: "la Bulgarie", HR: "la Croatie",
      CY: "Chypre", CZ: "la Tchéquie", DK: "le Danemark", EE: "l'Estonie",
      FI: "la Finlande", FR: "la France", DE: "l'Allemagne", GR: "la Grèce",
      HU: "la Hongrie", IE: "l'Irlande", IT: "l'Italie", LV: "la Lettonie",
      LT: "la Lituanie", LU: "le Luxembourg", MT: "Malte", NL: "les Pays-Bas",
      PL: "la Pologne", PT: "le Portugal", RO: "la Roumanie", SK: "la Slovaquie",
      SI: "la Slovénie", ES: "l'Espagne", SE: "la Suède", CH: "la Suisse",
      NO: "la Norvège", IS: "l'Islande", LI: "le Liechtenstein",
      GB: "le Royaume-Uni", MC: "Monaco", AD: "Andorre", TR: "la Turquie",
      UA: "l'Ukraine", RS: "la Serbie", US: "les États-Unis", CA: "le Canada",
      MX: "le Mexique", BR: "le Brésil", AU: "l'Australie",
      NZ: "la Nouvelle-Zélande", JP: "le Japon", CN: "la Chine", HK: "Hong Kong",
      TW: "Taïwan", KR: "la Corée du Sud", SG: "Singapour", TH: "la Thaïlande",
      VN: "le Viêt Nam", MY: "la Malaisie", ID: "l'Indonésie",
      PH: "les Philippines", IN: "l'Inde", AE: "les Émirats arabes unis",
      IL: "Israël", ZA: "l'Afrique du Sud", MA: "le Maroc",
    },
  },
  de: {
    intl: "de",
    tpl: "Versand aus {{ country }}",
    fb: "Versand aus: {{ country }}",
    o: {
      CH: "der Schweiz", TR: "der Türkei", UA: "der Ukraine", SK: "der Slowakei",
      NL: "den Niederlanden", US: "den Vereinigten Staaten",
      GB: "dem Vereinigten Königreich", AE: "den Vereinigten Arabischen Emiraten",
      PH: "den Philippinen", HK: "Hongkong",
    },
  },
  es: {
    intl: "es",
    tpl: "Enviado desde {{ country }}",
    fb: "Enviado desde: {{ country }}",
    o: {
      GB: "el Reino Unido", NL: "los Países Bajos",
      AE: "los Emiratos Árabes Unidos", HK: "Hong Kong",
    },
  },
  it: {
    intl: "it",
    tpl: "Spedito {{ country }}",
    fb: "Spedito da: {{ country }}",
    o: {
      AT: "dall'Austria", BE: "dal Belgio", BG: "dalla Bulgaria",
      HR: "dalla Croazia", CY: "da Cipro", CZ: "dalla Cechia",
      DK: "dalla Danimarca", EE: "dall'Estonia", FI: "dalla Finlandia",
      FR: "dalla Francia", DE: "dalla Germania", GR: "dalla Grecia",
      HU: "dall'Ungheria", IE: "dall'Irlanda", IT: "dall'Italia",
      LV: "dalla Lettonia", LT: "dalla Lituania", LU: "dal Lussemburgo",
      MT: "da Malta", NL: "dai Paesi Bassi", PL: "dalla Polonia",
      PT: "dal Portogallo", RO: "dalla Romania", SK: "dalla Slovacchia",
      SI: "dalla Slovenia", ES: "dalla Spagna", SE: "dalla Svezia",
      CH: "dalla Svizzera", NO: "dalla Norvegia", IS: "dall'Islanda",
      LI: "dal Liechtenstein", GB: "dal Regno Unito", MC: "da Monaco",
      AD: "da Andorra", TR: "dalla Turchia", UA: "dall'Ucraina",
      RS: "dalla Serbia", US: "dagli Stati Uniti", CA: "dal Canada",
      MX: "dal Messico", BR: "dal Brasile", AU: "dall'Australia",
      NZ: "dalla Nuova Zelanda", JP: "dal Giappone", CN: "dalla Cina",
      HK: "da Hong Kong", TW: "da Taiwan", KR: "dalla Corea del Sud",
      SG: "da Singapore", TH: "dalla Thailandia", VN: "dal Vietnam",
      MY: "dalla Malaysia", ID: "dall'Indonesia", PH: "dalle Filippine",
      IN: "dall'India", AE: "dagli Emirati Arabi Uniti", IL: "da Israele",
      ZA: "dal Sudafrica", MA: "dal Marocco",
    },
  },
  "pt-PT": {
    intl: "pt-PT",
    tpl: "Enviado {{ country }}",
    fb: "Enviado de: {{ country }}",
    o: {
      AT: "da Áustria", BE: "da Bélgica", BG: "da Bulgária", HR: "da Croácia",
      CY: "de Chipre", CZ: "da Chéquia", DK: "da Dinamarca", EE: "da Estónia",
      FI: "da Finlândia", FR: "de França", DE: "da Alemanha", GR: "da Grécia",
      HU: "da Hungria", IE: "da Irlanda", IT: "de Itália", LV: "da Letónia",
      LT: "da Lituânia", LU: "do Luxemburgo", MT: "de Malta",
      NL: "dos Países Baixos", PL: "da Polónia", PT: "de Portugal",
      RO: "da Roménia", SK: "da Eslováquia", SI: "da Eslovénia",
      ES: "de Espanha", SE: "da Suécia", CH: "da Suíça", NO: "da Noruega",
      IS: "da Islândia", LI: "do Listenstaine", GB: "do Reino Unido",
      MC: "do Mónaco", AD: "de Andorra", TR: "da Turquia", UA: "da Ucrânia",
      RS: "da Sérvia", US: "dos Estados Unidos", CA: "do Canadá",
      MX: "do México", BR: "do Brasil", AU: "da Austrália",
      NZ: "da Nova Zelândia", JP: "do Japão", CN: "da China",
      HK: "de Hong Kong", TW: "de Taiwan", KR: "da Coreia do Sul",
      SG: "de Singapura", TH: "da Tailândia", VN: "do Vietname",
      MY: "da Malásia", ID: "da Indonésia", PH: "das Filipinas",
      IN: "da Índia", AE: "dos Emirados Árabes Unidos", IL: "de Israel",
      ZA: "da África do Sul", MA: "de Marrocos",
    },
  },
  nl: {
    intl: "nl",
    tpl: "Verzonden vanuit {{ country }}",
    fb: "Verzonden vanuit: {{ country }}",
    o: {
      US: "de Verenigde Staten", GB: "het Verenigd Koninkrijk",
      AE: "de Verenigde Arabische Emiraten", PH: "de Filipijnen", HK: "Hongkong",
    },
  },
  da: { intl: "da", tpl: "Sendes fra {{ country }}", fb: "Sendes fra: {{ country }}", o: { HK: "Hongkong" } },
  sv: { intl: "sv", tpl: "Skickas från {{ country }}", fb: "Skickas från: {{ country }}", o: { HK: "Hongkong" } },
  nb: { intl: "nb", tpl: "Sendes fra {{ country }}", fb: "Sendes fra: {{ country }}", o: { HK: "Hongkong" } },
  no: { intl: "nb", tpl: "Sendes fra {{ country }}", fb: "Sendes fra: {{ country }}", o: { HK: "Hongkong" } },
  fi: {
    intl: "fi",
    tpl: "Lähetetään {{ country }}",
    fb: "Lähetysmaa: {{ country }}",
    o: {
      AT: "Itävallasta", BE: "Belgiasta", BG: "Bulgariasta", HR: "Kroatiasta",
      CY: "Kyprokselta", CZ: "Tšekistä", DK: "Tanskasta", EE: "Virosta",
      FI: "Suomesta", FR: "Ranskasta", DE: "Saksasta", GR: "Kreikasta",
      HU: "Unkarista", IE: "Irlannista", IT: "Italiasta", LV: "Latviasta",
      LT: "Liettuasta", LU: "Luxemburgista", MT: "Maltalta",
      NL: "Alankomaista", PL: "Puolasta", PT: "Portugalista",
      RO: "Romaniasta", SK: "Slovakiasta", SI: "Sloveniasta",
      ES: "Espanjasta", SE: "Ruotsista", CH: "Sveitsistä", NO: "Norjasta",
      IS: "Islannista", LI: "Liechtensteinista", GB: "Isosta-Britanniasta",
      MC: "Monacosta", AD: "Andorrasta", TR: "Turkista", UA: "Ukrainasta",
      RS: "Serbiasta", US: "Yhdysvalloista", CA: "Kanadasta",
      MX: "Meksikosta", BR: "Brasiliasta", AU: "Australiasta",
      NZ: "Uudesta-Seelannista", JP: "Japanista", CN: "Kiinasta",
      HK: "Hongkongista", TW: "Taiwanista", KR: "Etelä-Koreasta",
      SG: "Singaporesta", TH: "Thaimaasta", VN: "Vietnamista",
      MY: "Malesiasta", ID: "Indonesiasta", PH: "Filippiineiltä",
      IN: "Intiasta", AE: "Arabiemiirikunnista", IL: "Israelista",
      ZA: "Etelä-Afrikasta", MA: "Marokosta",
    },
  },
  pl: {
    intl: "pl",
    tpl: "Wysyłka {{ country }}",
    fb: "Kraj wysyłki: {{ country }}",
    o: {
      AT: "z Austrii", BE: "z Belgii", BG: "z Bułgarii", HR: "z Chorwacji",
      CY: "z Cypru", CZ: "z Czech", DK: "z Danii", EE: "z Estonii",
      FI: "z Finlandii", FR: "z Francji", DE: "z Niemiec", GR: "z Grecji",
      HU: "z Węgier", IE: "z Irlandii", IT: "z Włoch", LV: "z Łotwy",
      LT: "z Litwy", LU: "z Luksemburga", MT: "z Malty", NL: "z Holandii",
      PL: "z Polski", PT: "z Portugalii", RO: "z Rumunii", SK: "ze Słowacji",
      SI: "ze Słowenii", ES: "z Hiszpanii", SE: "ze Szwecji",
      CH: "ze Szwajcarii", NO: "z Norwegii", IS: "z Islandii",
      LI: "z Liechtensteinu", GB: "z Wielkiej Brytanii", MC: "z Monako",
      AD: "z Andory", TR: "z Turcji", UA: "z Ukrainy", RS: "z Serbii",
      US: "ze Stanów Zjednoczonych", CA: "z Kanady", MX: "z Meksyku",
      BR: "z Brazylii", AU: "z Australii", NZ: "z Nowej Zelandii",
      JP: "z Japonii", CN: "z Chin", HK: "z Hongkongu", TW: "z Tajwanu",
      KR: "z Korei Południowej", SG: "z Singapuru", TH: "z Tajlandii",
      VN: "z Wietnamu", MY: "z Malezji", ID: "z Indonezji", PH: "z Filipin",
      IN: "z Indii", AE: "ze Zjednoczonych Emiratów Arabskich",
      IL: "z Izraela", ZA: "z Republiki Południowej Afryki", MA: "z Maroka",
    },
  },
  hu: {
    intl: "hu",
    tpl: "Szállítás {{ country }}",
    fb: "Feladás helye: {{ country }}",
    o: {
      AT: "Ausztriából", BE: "Belgiumból", BG: "Bulgáriából",
      HR: "Horvátországból", CY: "Ciprusról", CZ: "Csehországból",
      DK: "Dániából", EE: "Észtországból", FI: "Finnországból",
      FR: "Franciaországból", DE: "Németországból", GR: "Görögországból",
      HU: "Magyarországról", IE: "Írországból", IT: "Olaszországból",
      LV: "Lettországból", LT: "Litvániából", LU: "Luxemburgból",
      MT: "Máltáról", NL: "Hollandiából", PL: "Lengyelországból",
      PT: "Portugáliából", RO: "Romániából", SK: "Szlovákiából",
      SI: "Szlovéniából", ES: "Spanyolországból", SE: "Svédországból",
      CH: "Svájcból", NO: "Norvégiából", IS: "Izlandról",
      LI: "Liechtensteinből", GB: "az Egyesült Királyságból",
      MC: "Monacóból", AD: "Andorrából", TR: "Törökországból",
      UA: "Ukrajnából", RS: "Szerbiából", US: "az Egyesült Államokból",
      CA: "Kanadából", MX: "Mexikóból", BR: "Brazíliából",
      AU: "Ausztráliából", NZ: "Új-Zélandról", JP: "Japánból",
      CN: "Kínából", HK: "Hongkongból", TW: "Tajvanról",
      KR: "Dél-Koreából", SG: "Szingapúrból", TH: "Thaiföldről",
      VN: "Vietnámból", MY: "Malajziából", ID: "Indonéziából",
      PH: "a Fülöp-szigetekről", IN: "Indiából",
      AE: "az Egyesült Arab Emírségekből", IL: "Izraelből",
      ZA: "a Dél-afrikai Köztársaságból", MA: "Marokkóból",
    },
  },
  el: {
    intl: "el",
    tpl: "Αποστολή από {{ country }}",
    fb: "Χώρα αποστολής: {{ country }}",
    o: {
      AT: "την Αυστρία", BE: "το Βέλγιο", BG: "τη Βουλγαρία",
      HR: "την Κροατία", CY: "την Κύπρο", CZ: "την Τσεχία", DK: "τη Δανία",
      EE: "την Εσθονία", FI: "τη Φινλανδία", FR: "τη Γαλλία",
      DE: "τη Γερμανία", GR: "την Ελλάδα", HU: "την Ουγγαρία",
      IE: "την Ιρλανδία", IT: "την Ιταλία", LV: "τη Λετονία",
      LT: "τη Λιθουανία", LU: "το Λουξεμβούργο", MT: "τη Μάλτα",
      NL: "τις Κάτω Χώρες", PL: "την Πολωνία", PT: "την Πορτογαλία",
      RO: "τη Ρουμανία", SK: "τη Σλοβακία", SI: "τη Σλοβενία",
      ES: "την Ισπανία", SE: "τη Σουηδία", CH: "την Ελβετία",
      NO: "τη Νορβηγία", IS: "την Ισλανδία", LI: "το Λιχτενστάιν",
      GB: "το Ηνωμένο Βασίλειο", MC: "το Μονακό", AD: "την Ανδόρα",
      TR: "την Τουρκία", UA: "την Ουκρανία", RS: "τη Σερβία",
      US: "τις Ηνωμένες Πολιτείες", CA: "τον Καναδά", MX: "το Μεξικό",
      BR: "τη Βραζιλία", AU: "την Αυστραλία", NZ: "τη Νέα Ζηλανδία",
      JP: "την Ιαπωνία", CN: "την Κίνα", HK: "το Χονγκ Κονγκ",
      TW: "την Ταϊβάν", KR: "τη Νότια Κορέα", SG: "τη Σιγκαπούρη",
      TH: "την Ταϊλάνδη", VN: "το Βιετνάμ", MY: "τη Μαλαισία",
      ID: "την Ινδονησία", PH: "τις Φιλιππίνες", IN: "την Ινδία",
      AE: "τα Ηνωμένα Αραβικά Εμιράτα", IL: "το Ισραήλ",
      ZA: "τη Νότια Αφρική", MA: "το Μαρόκο",
    },
  },
  ro: {
    intl: "ro",
    tpl: "Expediat din {{ country }}",
    fb: "Expediat din: {{ country }}",
    o: { US: "Statele Unite", HK: "Hong Kong" },
  },
  ar: {
    intl: "ar",
    tpl: "يُشحن من {{ country }}",
    fb: "الشحن من: {{ country }}",
    o: { HK: "هونغ كونغ" },
  },
  ja: {
    intl: "ja",
    tpl: "{{ country }}から発送",
    fb: "発送元: {{ country }}",
    o: { HK: "香港", US: "アメリカ" },
  },
};

let filesTouched = 0;
const forms = {};
for (const [base, spec] of Object.entries(LANGS)) {
  const fileName = `${base === "en.default" ? "en.default" : base}.json`;
  const file = path.join(DIR, fileName);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data.amazon || typeof data.amazon.ships_from !== "string") {
    throw new Error(`${base}: amazon.ships_from missing`);
  }
  const dn = new Intl.DisplayNames([spec.intl], { type: "region" });
  const table = {};
  for (const code of COUNTRIES) {
    const form = spec.o[code] ?? dn.of(code);
    if (typeof form !== "string" || !form) throw new Error(`${base}:${code}`);
    table[code] = form;
  }
  // JS-table key = the page locale (request.locale.iso_code) this file
  // serves: the file basename minus the ".default" marker.
  forms[base === "en.default" ? "en" : base] = table;
  // Rebuild the amazon group: natural template + fallback right after
  // ships_from; any stale in-file table removed (v8.16b — tables live in
  // the JS asset now, see the header).
  const amazon = {};
  for (const [k, v] of Object.entries(data.amazon)) {
    if (k === "ships_from_c" || k === "ships_from_fallback") continue;
    amazon[k] = k === "ships_from" ? spec.tpl : v;
    if (k === "ships_from") amazon.ships_from_fallback = spec.fb;
  }
  data.amazon = amazon;
  const out = MINIFIED_LOCALES.includes(fileName)
    ? JSON.stringify(data) + "\n"
    : JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(file, out);
  filesTouched += 1;
}

// Splice the generated single-line literal into the theme JS.
const pdpSrc = fs.readFileSync(PDP_JS, "utf8");
const LITERAL_RE = /  var AZ_SHIPS_FORMS = \{[^\n]*\};\n/;
if (!LITERAL_RE.test(pdpSrc)) {
  throw new Error("AZ_SHIPS_FORMS single-line literal not found in cellexia-pdp.js");
}
fs.writeFileSync(
  PDP_JS,
  pdpSrc.replace(LITERAL_RE, `  var AZ_SHIPS_FORMS = ${JSON.stringify(forms)};\n`),
);

// Byte gate: fail HERE rather than at deploy time (Shopify cap 15,360/file).
let worst = 0;
for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
  const size = fs.statSync(path.join(DIR, f)).size;
  worst = Math.max(worst, size);
  if (size > LOCALE_BYTE_BUDGET) {
    throw new Error(
      `${f} is ${size}B > ${LOCALE_BYTE_BUDGET}B budget (Shopify cap 15,360) — add it to MINIFIED_LOCALES or trim copy`,
    );
  }
  console.log(`  ${f}: ${size}B`);
}
console.log(
  `${filesTouched} locale files updated (${COUNTRIES.length} countries per language, tables in cellexia-pdp.js); largest file ${worst}B <= ${LOCALE_BYTE_BUDGET}B`,
);
