/**
 * v39.4: the results gallery's NATIVE GLOSSARY: hand-written translations
 * for the short labels machine translation gets wrong.
 *
 * WHY: v39.3 sent every short label to DeepL. A one- or two-word label has
 * no sentence around it, so DeepL picks the everyday sense of the word
 * instead of the skincare one. Read on the live store on 2026-11-14:
 *   - "Hydration" became fluid intake (de "Flüssigkeitszufuhr", nl
 *     "Vochtinname", da "Væskeindtag", sv "Vätskeintag", ja "水分補給");
 *   - "Radiance" became radiation in Dutch ("Straling") and a ray of light
 *     in Finnish ("Säde");
 *   - "frown-lines" and "forehead-lines" both became "Rides du front" in
 *     French, so the Concern filter listed the same label twice;
 *   - Dutch "Cellulitis" is the bacterial infection, not cellulite;
 *   - Romanian "Ridurile de întrebuințare" and Norwegian "Henge under
 *     kinnene" are not phrases at all;
 *   - job titles came out masculine for every doctor ("Facharzt",
 *     "Dermatólogo") and as "advisor" in Danish and Swedish ("Konsulent").
 * Labels were also translated once PER ENTRY, so the same English label
 * showed up to four different wordings in one gallery.
 *
 * WHAT: three small closed vocabularies, one table per storefront language:
 *   concern   the concern tag ("loss-of-firmness") shown in the card line
 *             and as a Concern filter option
 *   measure   a measurement tile's label ("Wrinkle Depth")
 *   role      the professional title after a doctor's name
 * Free text (study names, measurement notes, testimonials) stays with
 * DeepL: full phrases translate well.
 *
 * CONTRACT (the v15.5 copy-curated.server.ts contract, reused):
 *   - keyed by LOCALE (lowercase; nb/no are twins, a bare "pt" reads the
 *     European table) then by the ENGLISH source, matched loosely: case,
 *     hyphens, underscores and spacing are ignored, so the tag
 *     "loss-of-firmness", its spelled-out form "Loss of firmness" and a
 *     label typed "lip-volume" all hit;
 *   - ranking (proof-translation.server.ts): a MANUAL translation saved in
 *     the app always wins, then this glossary, then a DeepL row, then the
 *     source text. Applied at SERVE time (a deploy fixes shoppers at once)
 *     and WRITTEN by the translate run (never billed to DeepL);
 *   - a term that is not listed here returns null and DeepL translates it,
 *     now with a context hint and once per distinct label;
 *   - PURE module (no prisma, no network): the sims run the real thing.
 *
 * WRITING RULES (every table):
 *   - the term a native skincare shopper would use, not a word-for-word
 *     rendering ("Pattes d'oie", "Krähenfüße", "Ovale du visage");
 *   - sentence case, no article, no trailing period, no em dash;
 *   - concern and measure labels start with a capital (they stand alone);
 *   - role titles start in lower case where the language writes job titles
 *     as common nouns after a name ("Dr. X, dermatologue"); German keeps
 *     its noun capitals;
 *   - role titles never state a gender. The app does not know a doctor's
 *     gender, so languages that mark it use the speciality instead of the
 *     person noun ("especialista en dermatología", "Klinische
 *     Dermatologie", "طب الأمراض الجلدية").
 *
 * ADDING A TERM: add the English key to the kind's key list and a
 * translation to EVERY locale table (the sim fails on a missing entry).
 * Do not edit the extension locale files for these: el.json and ar.json
 * sit at Shopify's per-file byte cap.
 */

export type ResultGlossaryKind = "concern" | "measure" | "role";

export const RESULT_GLOSSARY_KINDS: ResultGlossaryKind[] = [
  "concern",
  "measure",
  "role",
];

/** The English sources, in their normalized form (see resultGlossaryKey). */
export const RESULT_GLOSSARY_KEYS = {
  concern: [
    "dullness",
    "eye corner lines",
    "forehead lines",
    "lip volume",
    "dehydration",
    "cellulite",
    "loss of firmness",
    "neck lines",
    "uneven tone",
    "jawline",
    "nose to mouth lines",
    "dark spots",
    "frown lines",
    "hair thinning",
    "hair density",
    "jowls",
    "chest wrinkles",
    "hand wrinkles",
    "under eye",
    "neck sagging",
    "glow",
    "elbow wrinkles",
    "lip lines",
  ],
  measure: [
    "wrinkle depth",
    "skin firmness",
    "hydration",
    "skin elasticity",
    "skin density",
    "radiance",
    "pigmentation",
    "hair density",
    "anagen hair ratio",
    "texture smoothness",
    "skin brightness",
    "dermal fat protrusion depth",
    "skin roughness",
    "lip volume",
    "jawline definition",
    "transepidermal water loss",
  ],
  role: [
    "consultant dermatologist",
    "board certified dermatologist",
    "dermatologist",
    "board certified dermatologist and clinical researcher",
    "dermatologist and cosmetic physician",
    "dermatologist and trichologist",
    "clinical dermatologist and trichologist",
    "clinical dermatologist",
    "dermatologist and medical cosmetics specialist",
    "clinical and aesthetic dermatologist",
    "dermatologist and aesthetic physician",
    "specialist in dermatology and venereology",
  ],
} as const;

type Table = Record<ResultGlossaryKind, Record<string, string>>;

/**
 * Loose match key for an English source: lower case, hyphens/underscores
 * and runs of whitespace become one space. "Board-Certified Dermatologist"
 * and "board certified dermatologist" are the same term.
 */
export function resultGlossaryKey(text: string): string {
  return typeof text === "string"
    ? text.toLowerCase().replace(/[-_\s]+/g, " ").trim()
    : "";
}

const FR: Table = {
  concern: {
    "dullness": "Teint terne",
    "eye corner lines": "Pattes d'oie",
    "forehead lines": "Rides du front",
    "lip volume": "Volume des lèvres",
    "dehydration": "Déshydratation",
    "cellulite": "Cellulite",
    "loss of firmness": "Perte de fermeté",
    "neck lines": "Rides du cou",
    "uneven tone": "Teint irrégulier",
    "jawline": "Ovale du visage",
    "nose to mouth lines": "Sillons nasogéniens",
    "dark spots": "Taches brunes",
    "frown lines": "Rides du lion",
    "hair thinning": "Cheveux clairsemés",
    "hair density": "Densité capillaire",
    "jowls": "Bajoues",
    "chest wrinkles": "Rides du décolleté",
    "hand wrinkles": "Rides des mains",
    "under eye": "Contour des yeux",
    "neck sagging": "Relâchement du cou",
    "glow": "Éclat",
    "elbow wrinkles": "Rides des coudes",
    "lip lines": "Rides du contour des lèvres",
  },
  measure: {
    "wrinkle depth": "Profondeur des rides",
    "skin firmness": "Fermeté de la peau",
    "hydration": "Hydratation",
    "skin elasticity": "Élasticité de la peau",
    "skin density": "Densité de la peau",
    "radiance": "Éclat",
    "pigmentation": "Pigmentation",
    "hair density": "Densité capillaire",
    "anagen hair ratio": "Cheveux en phase de croissance",
    "texture smoothness": "Lissé de la peau",
    "skin brightness": "Luminosité du teint",
    "dermal fat protrusion depth": "Profondeur des capitons",
    "skin roughness": "Rugosité de la peau",
    "lip volume": "Volume des lèvres",
    "jawline definition": "Définition de l'ovale du visage",
    "transepidermal water loss": "Perte insensible en eau",
  },
  role: {
    "consultant dermatologist": "dermatologue",
    "board certified dermatologist": "médecin spécialiste en dermatologie",
    "dermatologist": "dermatologue",
    "board certified dermatologist and clinical researcher":
      "médecin spécialiste en dermatologie, recherche clinique",
    "dermatologist and cosmetic physician": "dermatologue et médecin esthétique",
    "dermatologist and trichologist": "dermatologue et trichologue",
    "clinical dermatologist and trichologist":
      "spécialiste en dermatologie clinique et trichologue",
    "clinical dermatologist": "spécialiste en dermatologie clinique",
    "dermatologist and medical cosmetics specialist":
      "dermatologue, spécialiste en dermocosmétique",
    "clinical and aesthetic dermatologist":
      "spécialiste en dermatologie clinique et esthétique",
    "dermatologist and aesthetic physician": "dermatologue et médecin esthétique",
    "specialist in dermatology and venereology":
      "spécialiste en dermatologie et vénéréologie",
  },
};

const ES: Table = {
  concern: {
    "dullness": "Piel apagada",
    "eye corner lines": "Patas de gallo",
    "forehead lines": "Arrugas de la frente",
    "lip volume": "Volumen de los labios",
    "dehydration": "Deshidratación",
    "cellulite": "Celulitis",
    "loss of firmness": "Pérdida de firmeza",
    "neck lines": "Arrugas del cuello",
    "uneven tone": "Tono desigual",
    "jawline": "Óvalo facial",
    "nose to mouth lines": "Surcos nasogenianos",
    "dark spots": "Manchas oscuras",
    "frown lines": "Arrugas del entrecejo",
    "hair thinning": "Pérdida de densidad capilar",
    "hair density": "Densidad capilar",
    "jowls": "Mejillas caídas",
    "chest wrinkles": "Arrugas del escote",
    "hand wrinkles": "Arrugas de las manos",
    "under eye": "Contorno de ojos",
    "neck sagging": "Flacidez del cuello",
    "glow": "Luminosidad",
    "elbow wrinkles": "Arrugas de los codos",
    "lip lines": "Arrugas del contorno de labios",
  },
  measure: {
    "wrinkle depth": "Profundidad de las arrugas",
    "skin firmness": "Firmeza de la piel",
    "hydration": "Hidratación",
    "skin elasticity": "Elasticidad de la piel",
    "skin density": "Densidad de la piel",
    "radiance": "Luminosidad",
    "pigmentation": "Pigmentación",
    "hair density": "Densidad capilar",
    "anagen hair ratio": "Cabello en fase de crecimiento",
    "texture smoothness": "Suavidad de la piel",
    "skin brightness": "Claridad del tono",
    "dermal fat protrusion depth": "Protrusión de grasa en la dermis",
    "skin roughness": "Rugosidad de la piel",
    "lip volume": "Volumen de los labios",
    "jawline definition": "Definición del óvalo facial",
    "transepidermal water loss": "Pérdida de agua transepidérmica",
  },
  role: {
    "consultant dermatologist": "especialista en dermatología",
    "board certified dermatologist":
      "especialista en dermatología con certificación oficial",
    "dermatologist": "especialista en dermatología",
    "board certified dermatologist and clinical researcher":
      "especialista en dermatología con certificación oficial, investigación clínica",
    "dermatologist and cosmetic physician":
      "especialista en dermatología y medicina estética",
    "dermatologist and trichologist": "especialista en dermatología y tricología",
    "clinical dermatologist and trichologist":
      "especialista en dermatología clínica y tricología",
    "clinical dermatologist": "especialista en dermatología clínica",
    "dermatologist and medical cosmetics specialist":
      "especialista en dermatología y dermocosmética",
    "clinical and aesthetic dermatologist":
      "especialista en dermatología clínica y estética",
    "dermatologist and aesthetic physician":
      "especialista en dermatología y medicina estética",
    "specialist in dermatology and venereology":
      "especialista en dermatología y venereología",
  },
};

const IT: Table = {
  concern: {
    "dullness": "Pelle spenta",
    "eye corner lines": "Zampe di gallina",
    "forehead lines": "Rughe della fronte",
    "lip volume": "Volume delle labbra",
    "dehydration": "Disidratazione",
    "cellulite": "Cellulite",
    "loss of firmness": "Perdita di compattezza",
    "neck lines": "Rughe del collo",
    "uneven tone": "Incarnato non uniforme",
    "jawline": "Ovale del viso",
    "nose to mouth lines": "Rughe naso-labiali",
    "dark spots": "Macchie scure",
    "frown lines": "Rughe tra le sopracciglia",
    "hair thinning": "Diradamento dei capelli",
    "hair density": "Densità dei capelli",
    "jowls": "Guance cadenti",
    "chest wrinkles": "Rughe del décolleté",
    "hand wrinkles": "Rughe delle mani",
    "under eye": "Contorno occhi",
    "neck sagging": "Rilassamento del collo",
    "glow": "Luminosità",
    "elbow wrinkles": "Rughe dei gomiti",
    "lip lines": "Rughe del contorno labbra",
  },
  measure: {
    "wrinkle depth": "Profondità delle rughe",
    "skin firmness": "Compattezza della pelle",
    "hydration": "Idratazione",
    "skin elasticity": "Elasticità della pelle",
    "skin density": "Densità della pelle",
    "radiance": "Radiosità",
    "pigmentation": "Pigmentazione",
    "hair density": "Densità dei capelli",
    "anagen hair ratio": "Capelli in fase di crescita",
    "texture smoothness": "Levigatezza della pelle",
    "skin brightness": "Luminosità della pelle",
    "dermal fat protrusion depth": "Protrusione adiposa nel derma",
    "skin roughness": "Ruvidità della pelle",
    "lip volume": "Volume delle labbra",
    "jawline definition": "Definizione dell'ovale del viso",
    "transepidermal water loss": "Perdita d'acqua transepidermica",
  },
  role: {
    "consultant dermatologist": "specialista in dermatologia",
    "board certified dermatologist": "specialista in dermatologia",
    "dermatologist": "specialista in dermatologia",
    "board certified dermatologist and clinical researcher":
      "specialista in dermatologia e ricerca clinica",
    "dermatologist and cosmetic physician":
      "specialista in dermatologia e medicina estetica",
    "dermatologist and trichologist": "specialista in dermatologia e tricologia",
    "clinical dermatologist and trichologist":
      "specialista in dermatologia clinica e tricologia",
    "clinical dermatologist": "specialista in dermatologia clinica",
    "dermatologist and medical cosmetics specialist":
      "specialista in dermatologia e dermocosmesi",
    "clinical and aesthetic dermatologist":
      "specialista in dermatologia clinica ed estetica",
    "dermatologist and aesthetic physician":
      "specialista in dermatologia e medicina estetica",
    "specialist in dermatology and venereology":
      "specialista in dermatologia e venereologia",
  },
};

const PT_PT: Table = {
  concern: {
    "dullness": "Pele baça",
    "eye corner lines": "Pés de galinha",
    "forehead lines": "Rugas da testa",
    "lip volume": "Volume dos lábios",
    "dehydration": "Desidratação",
    "cellulite": "Celulite",
    "loss of firmness": "Perda de firmeza",
    "neck lines": "Rugas do pescoço",
    "uneven tone": "Tom de pele irregular",
    "jawline": "Oval do rosto",
    "nose to mouth lines": "Sulcos nasogenianos",
    "dark spots": "Manchas escuras",
    "frown lines": "Rugas entre as sobrancelhas",
    "hair thinning": "Perda de densidade capilar",
    "hair density": "Densidade capilar",
    "jowls": "Bochechas descaídas",
    "chest wrinkles": "Rugas do decote",
    "hand wrinkles": "Rugas das mãos",
    "under eye": "Contorno dos olhos",
    "neck sagging": "Flacidez do pescoço",
    "glow": "Luminosidade",
    "elbow wrinkles": "Rugas dos cotovelos",
    "lip lines": "Rugas do contorno dos lábios",
  },
  measure: {
    "wrinkle depth": "Profundidade das rugas",
    "skin firmness": "Firmeza da pele",
    "hydration": "Hidratação",
    "skin elasticity": "Elasticidade da pele",
    "skin density": "Densidade da pele",
    "radiance": "Luminosidade",
    "pigmentation": "Pigmentação",
    "hair density": "Densidade capilar",
    "anagen hair ratio": "Cabelo em fase de crescimento",
    "texture smoothness": "Suavidade da pele",
    "skin brightness": "Claridade do tom de pele",
    "dermal fat protrusion depth": "Protrusão de gordura na derme",
    "skin roughness": "Rugosidade da pele",
    "lip volume": "Volume dos lábios",
    "jawline definition": "Definição do oval do rosto",
    "transepidermal water loss": "Perda de água transepidérmica",
  },
  role: {
    "consultant dermatologist": "dermatologista",
    "board certified dermatologist": "dermatologista com título de especialista",
    "dermatologist": "dermatologista",
    "board certified dermatologist and clinical researcher":
      "dermatologista com título de especialista, investigação clínica",
    "dermatologist and cosmetic physician":
      "especialista em dermatologia e medicina estética",
    "dermatologist and trichologist": "dermatologista e tricologista",
    "clinical dermatologist and trichologist":
      "especialista em dermatologia clínica e tricologia",
    "clinical dermatologist": "especialista em dermatologia clínica",
    "dermatologist and medical cosmetics specialist":
      "dermatologista, especialista em dermocosmética",
    "clinical and aesthetic dermatologist":
      "especialista em dermatologia clínica e estética",
    "dermatologist and aesthetic physician":
      "especialista em dermatologia e medicina estética",
    "specialist in dermatology and venereology":
      "especialista em dermatologia e venereologia",
  },
};

const PT_BR: Table = {
  concern: {
    "dullness": "Pele sem viço",
    "eye corner lines": "Pés de galinha",
    "forehead lines": "Rugas na testa",
    "lip volume": "Volume dos lábios",
    "dehydration": "Desidratação",
    "cellulite": "Celulite",
    "loss of firmness": "Perda de firmeza",
    "neck lines": "Rugas no pescoço",
    "uneven tone": "Tom de pele irregular",
    "jawline": "Contorno facial",
    "nose to mouth lines": "Sulcos nasogenianos",
    "dark spots": "Manchas escuras",
    "frown lines": "Rugas entre as sobrancelhas",
    "hair thinning": "Afinamento dos fios",
    "hair density": "Densidade capilar",
    "jowls": "Bochechas caídas",
    "chest wrinkles": "Rugas no colo",
    "hand wrinkles": "Rugas nas mãos",
    "under eye": "Área dos olhos",
    "neck sagging": "Flacidez no pescoço",
    "glow": "Luminosidade",
    "elbow wrinkles": "Rugas nos cotovelos",
    "lip lines": "Rugas ao redor dos lábios",
  },
  measure: {
    "wrinkle depth": "Profundidade das rugas",
    "skin firmness": "Firmeza da pele",
    "hydration": "Hidratação",
    "skin elasticity": "Elasticidade da pele",
    "skin density": "Densidade da pele",
    "radiance": "Luminosidade",
    "pigmentation": "Pigmentação",
    "hair density": "Densidade capilar",
    "anagen hair ratio": "Fios em fase de crescimento",
    "texture smoothness": "Maciez da pele",
    "skin brightness": "Claridade do tom de pele",
    "dermal fat protrusion depth": "Protrusão de gordura na derme",
    "skin roughness": "Aspereza da pele",
    "lip volume": "Volume dos lábios",
    "jawline definition": "Definição do contorno facial",
    "transepidermal water loss": "Perda de água transepidérmica",
  },
  role: {
    "consultant dermatologist": "dermatologista",
    "board certified dermatologist": "dermatologista com título de especialista",
    "dermatologist": "dermatologista",
    "board certified dermatologist and clinical researcher":
      "dermatologista com título de especialista, pesquisa clínica",
    "dermatologist and cosmetic physician":
      "especialista em dermatologia e medicina estética",
    "dermatologist and trichologist": "dermatologista e tricologista",
    "clinical dermatologist and trichologist":
      "especialista em dermatologia clínica e tricologia",
    "clinical dermatologist": "especialista em dermatologia clínica",
    "dermatologist and medical cosmetics specialist":
      "dermatologista, especialista em dermocosméticos",
    "clinical and aesthetic dermatologist":
      "especialista em dermatologia clínica e estética",
    "dermatologist and aesthetic physician":
      "especialista em dermatologia e medicina estética",
    "specialist in dermatology and venereology":
      "especialista em dermatologia e venereologia",
  },
};

const DE: Table = {
  concern: {
    "dullness": "Fahler Teint",
    "eye corner lines": "Krähenfüße",
    "forehead lines": "Stirnfalten",
    "lip volume": "Lippenvolumen",
    "dehydration": "Feuchtigkeitsmangel",
    "cellulite": "Cellulite",
    "loss of firmness": "Nachlassende Spannkraft",
    "neck lines": "Halsfalten",
    "uneven tone": "Ungleichmäßiger Teint",
    "jawline": "Kinnlinie",
    "nose to mouth lines": "Nasolabialfalten",
    "dark spots": "Pigmentflecken",
    "frown lines": "Zornesfalten",
    "hair thinning": "Dünner werdendes Haar",
    "hair density": "Haardichte",
    "jowls": "Hängebäckchen",
    "chest wrinkles": "Dekolletéfalten",
    "hand wrinkles": "Falten an den Händen",
    "under eye": "Augenpartie",
    "neck sagging": "Erschlaffte Halspartie",
    "glow": "Strahlender Teint",
    "elbow wrinkles": "Falten an den Ellbogen",
    "lip lines": "Lippenfältchen",
  },
  measure: {
    "wrinkle depth": "Faltentiefe",
    "skin firmness": "Hautfestigkeit",
    "hydration": "Hautfeuchtigkeit",
    "skin elasticity": "Hautelastizität",
    "skin density": "Hautdichte",
    "radiance": "Strahlkraft",
    "pigmentation": "Pigmentierung",
    "hair density": "Haardichte",
    "anagen hair ratio": "Haare in der Wachstumsphase",
    "texture smoothness": "Hautglätte",
    "skin brightness": "Hauthelligkeit",
    "dermal fat protrusion depth": "Tiefe der Fettvorwölbungen",
    "skin roughness": "Hautrauigkeit",
    "lip volume": "Lippenvolumen",
    "jawline definition": "Kinnkontur",
    "transepidermal water loss": "Transepidermaler Wasserverlust",
  },
  role: {
    "consultant dermatologist": "Dermatologie",
    "board certified dermatologist": "Dermatologie",
    "dermatologist": "Dermatologie",
    "board certified dermatologist and clinical researcher":
      "Dermatologie und klinische Forschung",
    "dermatologist and cosmetic physician": "Dermatologie und ästhetische Medizin",
    "dermatologist and trichologist": "Dermatologie und Trichologie",
    "clinical dermatologist and trichologist":
      "Klinische Dermatologie und Trichologie",
    "clinical dermatologist": "Klinische Dermatologie",
    "dermatologist and medical cosmetics specialist":
      "Dermatologie und medizinische Kosmetik",
    "clinical and aesthetic dermatologist": "Klinische und ästhetische Dermatologie",
    "dermatologist and aesthetic physician": "Dermatologie und ästhetische Medizin",
    "specialist in dermatology and venereology": "Dermatologie und Venerologie",
  },
};

const NL: Table = {
  concern: {
    "dullness": "Doffe huid",
    "eye corner lines": "Kraaienpootjes",
    "forehead lines": "Voorhoofdsrimpels",
    "lip volume": "Lipvolume",
    "dehydration": "Vochtarme huid",
    "cellulite": "Cellulite",
    "loss of firmness": "Verlies van stevigheid",
    "neck lines": "Halsrimpels",
    "uneven tone": "Ongelijkmatige teint",
    "jawline": "Kaaklijn",
    "nose to mouth lines": "Neus-lippenplooien",
    "dark spots": "Pigmentvlekken",
    "frown lines": "Fronsrimpels",
    "hair thinning": "Dunner wordend haar",
    "hair density": "Haardichtheid",
    "jowls": "Hangwangen",
    "chest wrinkles": "Decolletérimpels",
    "hand wrinkles": "Rimpels op de handen",
    "under eye": "Oogcontour",
    "neck sagging": "Verslapte hals",
    "glow": "Stralende huid",
    "elbow wrinkles": "Rimpels op de ellebogen",
    "lip lines": "Liplijntjes",
  },
  measure: {
    "wrinkle depth": "Rimpeldiepte",
    "skin firmness": "Stevigheid van de huid",
    "hydration": "Hydratatie",
    "skin elasticity": "Elasticiteit van de huid",
    "skin density": "Huiddichtheid",
    "radiance": "Uitstraling van de huid",
    "pigmentation": "Pigmentatie",
    "hair density": "Haardichtheid",
    "anagen hair ratio": "Haren in de groeifase",
    "texture smoothness": "Gladheid van de huid",
    "skin brightness": "Helderheid van de huid",
    "dermal fat protrusion depth": "Diepte van de vetuitstulpingen",
    "skin roughness": "Ruwheid van de huid",
    "lip volume": "Lipvolume",
    "jawline definition": "Definitie van de kaaklijn",
    "transepidermal water loss": "Transepidermaal vochtverlies",
  },
  role: {
    "consultant dermatologist": "dermatoloog",
    "board certified dermatologist": "geregistreerd dermatoloog",
    "dermatologist": "dermatoloog",
    "board certified dermatologist and clinical researcher":
      "geregistreerd dermatoloog en klinisch onderzoeker",
    "dermatologist and cosmetic physician": "dermatoloog en cosmetisch arts",
    "dermatologist and trichologist": "dermatoloog en tricholoog",
    "clinical dermatologist and trichologist": "klinisch dermatoloog en tricholoog",
    "clinical dermatologist": "klinisch dermatoloog",
    "dermatologist and medical cosmetics specialist":
      "dermatoloog en specialist in medische cosmetica",
    "clinical and aesthetic dermatologist": "klinisch en esthetisch dermatoloog",
    "dermatologist and aesthetic physician": "dermatoloog en cosmetisch arts",
    "specialist in dermatology and venereology":
      "specialist in dermatologie en venereologie",
  },
};

const DA: Table = {
  concern: {
    "dullness": "Gusten hud",
    "eye corner lines": "Kragetæer",
    "forehead lines": "Panderynker",
    "lip volume": "Læbevolumen",
    "dehydration": "Fugtfattig hud",
    "cellulite": "Cellulite",
    "loss of firmness": "Tab af fasthed",
    "neck lines": "Rynker på halsen",
    "uneven tone": "Ujævn hudtone",
    "jawline": "Kæbelinje",
    "nose to mouth lines": "Linjer fra næse til mund",
    "dark spots": "Pigmentpletter",
    "frown lines": "Bekymringsrynker",
    "hair thinning": "Tyndere hår",
    "hair density": "Hårtæthed",
    "jowls": "Hængekinder",
    "chest wrinkles": "Rynker på dekolletagen",
    "hand wrinkles": "Rynker på hænderne",
    "under eye": "Øjenomgivelser",
    "neck sagging": "Slap hud på halsen",
    "glow": "Glød",
    "elbow wrinkles": "Rynker på albuerne",
    "lip lines": "Rynker omkring læberne",
  },
  measure: {
    "wrinkle depth": "Rynkedybde",
    "skin firmness": "Hudens fasthed",
    "hydration": "Hudens fugtniveau",
    "skin elasticity": "Hudens elasticitet",
    "skin density": "Hudens tæthed",
    "radiance": "Glød",
    "pigmentation": "Pigmentering",
    "hair density": "Hårtæthed",
    "anagen hair ratio": "Hår i vækstfasen",
    "texture smoothness": "Hudens glathed",
    "skin brightness": "Hudens lyshed",
    "dermal fat protrusion depth": "Fedtudbulingernes dybde",
    "skin roughness": "Hudens ruhed",
    "lip volume": "Læbevolumen",
    "jawline definition": "Kæbelinjens kontur",
    "transepidermal water loss": "Transepidermalt vandtab",
  },
  role: {
    "consultant dermatologist": "speciallæge i dermatologi",
    "board certified dermatologist": "speciallæge i dermatologi",
    "dermatologist": "hudlæge",
    "board certified dermatologist and clinical researcher":
      "speciallæge i dermatologi og klinisk forsker",
    "dermatologist and cosmetic physician": "hudlæge og kosmetisk læge",
    "dermatologist and trichologist": "hudlæge og trikolog",
    "clinical dermatologist and trichologist": "klinisk dermatolog og trikolog",
    "clinical dermatologist": "klinisk dermatolog",
    "dermatologist and medical cosmetics specialist":
      "hudlæge og specialist i medicinsk kosmetik",
    "clinical and aesthetic dermatologist":
      "speciallæge i klinisk og æstetisk dermatologi",
    "dermatologist and aesthetic physician": "hudlæge og æstetisk læge",
    "specialist in dermatology and venereology":
      "speciallæge i dermato-venerologi",
  },
};

const SV: Table = {
  concern: {
    "dullness": "Glåmig hy",
    "eye corner lines": "Kråksparkar",
    "forehead lines": "Pannrynkor",
    "lip volume": "Läppvolym",
    "dehydration": "Fuktfattig hy",
    "cellulite": "Celluliter",
    "loss of firmness": "Minskad fasthet",
    "neck lines": "Rynkor på halsen",
    "uneven tone": "Ojämn hudton",
    "jawline": "Käklinje",
    "nose to mouth lines": "Linjer mellan näsa och mun",
    "dark spots": "Pigmentfläckar",
    "frown lines": "Bekymmersrynkor",
    "hair thinning": "Tunnhårighet",
    "hair density": "Hårtäthet",
    "jowls": "Hängande kinder",
    "chest wrinkles": "Rynkor på dekolletaget",
    "hand wrinkles": "Rynkor på händerna",
    "under eye": "Ögonpartiet",
    "neck sagging": "Slapp hud på halsen",
    "glow": "Lyster",
    "elbow wrinkles": "Rynkor på armbågarna",
    "lip lines": "Rynkor runt läpparna",
  },
  measure: {
    "wrinkle depth": "Rynkdjup",
    "skin firmness": "Hudens fasthet",
    "hydration": "Hudens fuktnivå",
    "skin elasticity": "Hudens elasticitet",
    "skin density": "Hudens täthet",
    "radiance": "Lyster",
    "pigmentation": "Pigmentering",
    "hair density": "Hårtäthet",
    "anagen hair ratio": "Hår i tillväxtfasen",
    "texture smoothness": "Hudens släthet",
    "skin brightness": "Hudens ljushet",
    "dermal fat protrusion depth": "Fettutbuktningarnas djup",
    "skin roughness": "Hudens strävhet",
    "lip volume": "Läppvolym",
    "jawline definition": "Käklinjens kontur",
    "transepidermal water loss": "Transepidermal vattenförlust",
  },
  role: {
    "consultant dermatologist": "specialistläkare i dermatologi",
    "board certified dermatologist": "specialistläkare i dermatologi",
    "dermatologist": "hudläkare",
    "board certified dermatologist and clinical researcher":
      "specialistläkare i dermatologi och klinisk forskare",
    "dermatologist and cosmetic physician": "hudläkare och estetisk läkare",
    "dermatologist and trichologist": "hudläkare och trikolog",
    "clinical dermatologist and trichologist": "klinisk dermatolog och trikolog",
    "clinical dermatologist": "klinisk dermatolog",
    "dermatologist and medical cosmetics specialist":
      "hudläkare och specialist inom medicinsk kosmetik",
    "clinical and aesthetic dermatologist":
      "specialistläkare i klinisk och estetisk dermatologi",
    "dermatologist and aesthetic physician": "hudläkare och estetisk läkare",
    "specialist in dermatology and venereology":
      "specialistläkare i dermatologi och venereologi",
  },
};

const NB: Table = {
  concern: {
    "dullness": "Gusten hud",
    "eye corner lines": "Kråketær",
    "forehead lines": "Pannerynker",
    "lip volume": "Leppevolum",
    "dehydration": "Fuktfattig hud",
    "cellulite": "Cellulitter",
    "loss of firmness": "Tap av fasthet",
    "neck lines": "Rynker på halsen",
    "uneven tone": "Ujevn hudtone",
    "jawline": "Kjevelinje",
    "nose to mouth lines": "Linjer fra nese til munn",
    "dark spots": "Pigmentflekker",
    "frown lines": "Sinnarynker",
    "hair thinning": "Tynnere hår",
    "hair density": "Hårtetthet",
    "jowls": "Hengekinn",
    "chest wrinkles": "Rynker på dekolletasjen",
    "hand wrinkles": "Rynker på hendene",
    "under eye": "Øyepartiet",
    "neck sagging": "Slapp hud på halsen",
    "glow": "Glød",
    "elbow wrinkles": "Rynker på albuene",
    "lip lines": "Rynker rundt leppene",
  },
  measure: {
    "wrinkle depth": "Rynkedybde",
    "skin firmness": "Hudens fasthet",
    "hydration": "Hudens fuktnivå",
    "skin elasticity": "Hudens elastisitet",
    "skin density": "Hudens tetthet",
    "radiance": "Glød",
    "pigmentation": "Pigmentering",
    "hair density": "Hårtetthet",
    "anagen hair ratio": "Hår i vekstfasen",
    "texture smoothness": "Hudens glatthet",
    "skin brightness": "Hudens lyshet",
    "dermal fat protrusion depth": "Fettutbulingenes dybde",
    "skin roughness": "Hudens ruhet",
    "lip volume": "Leppevolum",
    "jawline definition": "Kjevelinjens kontur",
    "transepidermal water loss": "Transepidermalt vanntap",
  },
  role: {
    "consultant dermatologist": "spesialist i hudsykdommer",
    "board certified dermatologist": "spesialist i hudsykdommer",
    "dermatologist": "hudlege",
    "board certified dermatologist and clinical researcher":
      "spesialist i hudsykdommer og klinisk forsker",
    "dermatologist and cosmetic physician": "hudlege og kosmetisk lege",
    "dermatologist and trichologist": "hudlege og trikolog",
    "clinical dermatologist and trichologist": "klinisk dermatolog og trikolog",
    "clinical dermatologist": "klinisk dermatolog",
    "dermatologist and medical cosmetics specialist":
      "hudlege og spesialist i medisinsk kosmetikk",
    "clinical and aesthetic dermatologist":
      "spesialist i klinisk og estetisk dermatologi",
    "dermatologist and aesthetic physician": "hudlege og estetisk lege",
    "specialist in dermatology and venereology":
      "spesialist i hud- og veneriske sykdommer",
  },
};

const FI: Table = {
  concern: {
    "dullness": "Eloton iho",
    "eye corner lines": "Silmäkulmien rypyt",
    "forehead lines": "Otsarypyt",
    "lip volume": "Huulten täyteläisyys",
    "dehydration": "Kosteusköyhä iho",
    "cellulite": "Selluliitti",
    "loss of firmness": "Kiinteyden heikkeneminen",
    "neck lines": "Kaulan rypyt",
    "uneven tone": "Epätasainen ihonsävy",
    "jawline": "Leukalinja",
    "nose to mouth lines": "Nenä-huulipoimut",
    "dark spots": "Pigmenttiläiskät",
    "frown lines": "Kulmien väliset rypyt",
    "hair thinning": "Hiusten oheneminen",
    "hair density": "Hiusten tiheys",
    "jowls": "Roikkuvat posket",
    "chest wrinkles": "Dekolteen rypyt",
    "hand wrinkles": "Käsien rypyt",
    "under eye": "Silmänympärykset",
    "neck sagging": "Kaulan ihon löystyminen",
    "glow": "Hehku",
    "elbow wrinkles": "Kyynärpäiden rypyt",
    "lip lines": "Suun ympäryksen juonteet",
  },
  measure: {
    "wrinkle depth": "Ryppyjen syvyys",
    "skin firmness": "Ihon kiinteys",
    "hydration": "Ihon kosteus",
    "skin elasticity": "Ihon kimmoisuus",
    "skin density": "Ihon tiheys",
    "radiance": "Hehku",
    "pigmentation": "Pigmentaatio",
    "hair density": "Hiusten tiheys",
    "anagen hair ratio": "Kasvuvaiheen hiukset",
    "texture smoothness": "Ihon sileys",
    "skin brightness": "Ihon kirkkaus",
    "dermal fat protrusion depth": "Rasvakudoksen pullistumien syvyys",
    "skin roughness": "Ihon karheus",
    "lip volume": "Huulten täyteläisyys",
    "jawline definition": "Leukalinjan selkeys",
    "transepidermal water loss": "Veden haihtuminen ihon läpi",
  },
  role: {
    "consultant dermatologist": "ihotautien erikoislääkäri",
    "board certified dermatologist": "ihotautien erikoislääkäri",
    "dermatologist": "ihotautilääkäri",
    "board certified dermatologist and clinical researcher":
      "ihotautien erikoislääkäri ja kliininen tutkija",
    "dermatologist and cosmetic physician":
      "ihotautilääkäri ja esteettisen lääketieteen lääkäri",
    "dermatologist and trichologist": "ihotautilääkäri ja trikologi",
    "clinical dermatologist and trichologist":
      "kliininen ihotautilääkäri ja trikologi",
    "clinical dermatologist": "kliininen ihotautilääkäri",
    "dermatologist and medical cosmetics specialist":
      "ihotautilääkäri ja lääketieteellisen kosmetiikan asiantuntija",
    "clinical and aesthetic dermatologist":
      "kliinisen ja esteettisen dermatologian erikoislääkäri",
    "dermatologist and aesthetic physician":
      "ihotautilääkäri ja esteettisen lääketieteen lääkäri",
    "specialist in dermatology and venereology":
      "iho- ja sukupuolitautien erikoislääkäri",
  },
};

const PL: Table = {
  concern: {
    "dullness": "Szara, zmęczona cera",
    "eye corner lines": "Kurze łapki",
    "forehead lines": "Zmarszczki na czole",
    "lip volume": "Objętość ust",
    "dehydration": "Odwodniona skóra",
    "cellulite": "Cellulit",
    "loss of firmness": "Utrata jędrności",
    "neck lines": "Zmarszczki na szyi",
    "uneven tone": "Nierówny koloryt",
    "jawline": "Owal twarzy",
    "nose to mouth lines": "Bruzdy nosowo-wargowe",
    "dark spots": "Przebarwienia",
    "frown lines": "Lwia zmarszczka",
    "hair thinning": "Przerzedzające się włosy",
    "hair density": "Gęstość włosów",
    "jowls": "Opadające policzki",
    "chest wrinkles": "Zmarszczki na dekolcie",
    "hand wrinkles": "Zmarszczki na dłoniach",
    "under eye": "Okolice oczu",
    "neck sagging": "Wiotka skóra szyi",
    "glow": "Blask skóry",
    "elbow wrinkles": "Zmarszczki na łokciach",
    "lip lines": "Zmarszczki wokół ust",
  },
  measure: {
    "wrinkle depth": "Głębokość zmarszczek",
    "skin firmness": "Jędrność skóry",
    "hydration": "Nawilżenie skóry",
    "skin elasticity": "Elastyczność skóry",
    "skin density": "Gęstość skóry",
    "radiance": "Blask skóry",
    "pigmentation": "Pigmentacja",
    "hair density": "Gęstość włosów",
    "anagen hair ratio": "Włosy w fazie wzrostu",
    "texture smoothness": "Gładkość skóry",
    "skin brightness": "Jasność skóry",
    "dermal fat protrusion depth": "Głębokość uwypukleń tkanki tłuszczowej",
    "skin roughness": "Szorstkość skóry",
    "lip volume": "Objętość ust",
    "jawline definition": "Zarys owalu twarzy",
    "transepidermal water loss": "Przeznaskórkowa utrata wody",
  },
  role: {
    "consultant dermatologist": "specjalista dermatolog",
    "board certified dermatologist": "lekarz specjalista dermatolog",
    "dermatologist": "dermatolog",
    "board certified dermatologist and clinical researcher":
      "lekarz specjalista dermatolog, badania kliniczne",
    "dermatologist and cosmetic physician":
      "dermatolog, lekarz medycyny estetycznej",
    "dermatologist and trichologist": "dermatolog i trycholog",
    "clinical dermatologist and trichologist": "dermatolog kliniczny i trycholog",
    "clinical dermatologist": "dermatolog kliniczny",
    "dermatologist and medical cosmetics specialist":
      "dermatolog, specjalista kosmetologii medycznej",
    "clinical and aesthetic dermatologist": "dermatolog kliniczny i estetyczny",
    "dermatologist and aesthetic physician":
      "dermatolog, lekarz medycyny estetycznej",
    "specialist in dermatology and venereology":
      "specjalista dermatologii i wenerologii",
  },
};

const RO: Table = {
  concern: {
    "dullness": "Ten tern",
    "eye corner lines": "Riduri la colțul ochilor",
    "forehead lines": "Riduri pe frunte",
    "lip volume": "Volumul buzelor",
    "dehydration": "Deshidratare",
    "cellulite": "Celulită",
    "loss of firmness": "Pierderea fermității",
    "neck lines": "Riduri pe gât",
    "uneven tone": "Ten neuniform",
    "jawline": "Ovalul feței",
    "nose to mouth lines": "Șanțuri nazolabiale",
    "dark spots": "Pete pigmentare",
    "frown lines": "Riduri între sprâncene",
    "hair thinning": "Rărirea părului",
    "hair density": "Densitatea părului",
    "jowls": "Obraji lăsați",
    "chest wrinkles": "Riduri pe decolteu",
    "hand wrinkles": "Riduri pe mâini",
    "under eye": "Conturul ochilor",
    "neck sagging": "Piele lăsată pe gât",
    "glow": "Luminozitate",
    "elbow wrinkles": "Riduri pe coate",
    "lip lines": "Riduri în jurul buzelor",
  },
  measure: {
    "wrinkle depth": "Adâncimea ridurilor",
    "skin firmness": "Fermitatea pielii",
    "hydration": "Hidratare",
    "skin elasticity": "Elasticitatea pielii",
    "skin density": "Densitatea pielii",
    "radiance": "Strălucire",
    "pigmentation": "Pigmentare",
    "hair density": "Densitatea părului",
    "anagen hair ratio": "Fire de păr în faza de creștere",
    "texture smoothness": "Netezimea pielii",
    "skin brightness": "Luminozitatea pielii",
    "dermal fat protrusion depth": "Adâncimea protruziilor adipoase",
    "skin roughness": "Rugozitatea pielii",
    "lip volume": "Volumul buzelor",
    "jawline definition": "Definirea ovalului feței",
    "transepidermal water loss": "Pierderea transepidermică de apă",
  },
  role: {
    "consultant dermatologist": "medic specialist în dermatologie",
    "board certified dermatologist": "medic specialist în dermatologie",
    "dermatologist": "medic specialist în dermatologie",
    "board certified dermatologist and clinical researcher":
      "medic specialist în dermatologie, cercetare clinică",
    "dermatologist and cosmetic physician":
      "medic specialist în dermatologie și medicină estetică",
    "dermatologist and trichologist":
      "medic specialist în dermatologie și tricologie",
    "clinical dermatologist and trichologist":
      "medic specialist în dermatologie clinică și tricologie",
    "clinical dermatologist": "medic specialist în dermatologie clinică",
    "dermatologist and medical cosmetics specialist":
      "medic specialist în dermatologie și dermatocosmetică",
    "clinical and aesthetic dermatologist":
      "medic specialist în dermatologie clinică și estetică",
    "dermatologist and aesthetic physician":
      "medic specialist în dermatologie și medicină estetică",
    "specialist in dermatology and venereology":
      "medic specialist în dermatovenerologie",
  },
};

const HU: Table = {
  concern: {
    "dullness": "Fakó bőr",
    "eye corner lines": "Szarkalábak",
    "forehead lines": "Homlokráncok",
    "lip volume": "Ajkak teltsége",
    "dehydration": "Vízhiányos bőr",
    "cellulite": "Narancsbőr",
    "loss of firmness": "Feszességvesztés",
    "neck lines": "Nyakráncok",
    "uneven tone": "Egyenetlen bőrtónus",
    "jawline": "Állvonal",
    "nose to mouth lines": "Orr-ajak redők",
    "dark spots": "Pigmentfoltok",
    "frown lines": "Haragráncok",
    "hair thinning": "Hajritkulás",
    "hair density": "Hajsűrűség",
    "jowls": "Megereszkedett orcák",
    "chest wrinkles": "Dekoltázsráncok",
    "hand wrinkles": "Kézráncok",
    "under eye": "Szemkörnyék",
    "neck sagging": "Megereszkedett nyak",
    "glow": "Ragyogás",
    "elbow wrinkles": "Könyökráncok",
    "lip lines": "Ajak körüli ráncok",
  },
  measure: {
    "wrinkle depth": "Ráncmélység",
    "skin firmness": "Bőrfeszesség",
    "hydration": "Hidratáltság",
    "skin elasticity": "Bőrrugalmasság",
    "skin density": "Bőrsűrűség",
    "radiance": "Ragyogás",
    "pigmentation": "Pigmentáció",
    "hair density": "Hajsűrűség",
    "anagen hair ratio": "Növekedési fázisú hajszálak",
    "texture smoothness": "Bőrsimaság",
    "skin brightness": "Bőrtónus világossága",
    "dermal fat protrusion depth": "Zsírszövet-kitüremkedések mélysége",
    "skin roughness": "Bőrérdesség",
    "lip volume": "Ajkak teltsége",
    "jawline definition": "Állvonal határozottsága",
    "transepidermal water loss": "Transzepidermális vízvesztés",
  },
  role: {
    "consultant dermatologist": "bőrgyógyász szakorvos",
    "board certified dermatologist": "bőrgyógyász szakorvos",
    "dermatologist": "bőrgyógyász",
    "board certified dermatologist and clinical researcher":
      "bőrgyógyász szakorvos és klinikai kutató",
    "dermatologist and cosmetic physician": "bőrgyógyász és esztétikai orvos",
    "dermatologist and trichologist": "bőrgyógyász és trichológus",
    "clinical dermatologist and trichologist":
      "klinikai bőrgyógyász és trichológus",
    "clinical dermatologist": "klinikai bőrgyógyász",
    "dermatologist and medical cosmetics specialist":
      "bőrgyógyász és orvosi kozmetikai szakértő",
    "clinical and aesthetic dermatologist": "klinikai és esztétikai bőrgyógyász",
    "dermatologist and aesthetic physician": "bőrgyógyász és esztétikai orvos",
    "specialist in dermatology and venereology":
      "bőr- és nemigyógyász szakorvos",
  },
};

const EL: Table = {
  concern: {
    "dullness": "Θαμπή επιδερμίδα",
    "eye corner lines": "Πόδι της χήνας",
    "forehead lines": "Ρυτίδες στο μέτωπο",
    "lip volume": "Όγκος χειλιών",
    "dehydration": "Αφυδάτωση",
    "cellulite": "Κυτταρίτιδα",
    "loss of firmness": "Απώλεια σφριγηλότητας",
    "neck lines": "Ρυτίδες στον λαιμό",
    "uneven tone": "Ανομοιόμορφος τόνος",
    "jawline": "Περίγραμμα προσώπου",
    "nose to mouth lines": "Ρινοχειλικές αύλακες",
    "dark spots": "Σκούρες κηλίδες",
    "frown lines": "Ρυτίδες μεσόφρυου",
    "hair thinning": "Αραίωση μαλλιών",
    "hair density": "Πυκνότητα μαλλιών",
    "jowls": "Χαλάρωση στα μάγουλα",
    "chest wrinkles": "Ρυτίδες στο ντεκολτέ",
    "hand wrinkles": "Ρυτίδες στα χέρια",
    "under eye": "Περιοχή των ματιών",
    "neck sagging": "Χαλάρωση στον λαιμό",
    "glow": "Λάμψη",
    "elbow wrinkles": "Ρυτίδες στους αγκώνες",
    "lip lines": "Ρυτίδες γύρω από τα χείλη",
  },
  measure: {
    "wrinkle depth": "Βάθος ρυτίδων",
    "skin firmness": "Σφριγηλότητα επιδερμίδας",
    "hydration": "Ενυδάτωση",
    "skin elasticity": "Ελαστικότητα επιδερμίδας",
    "skin density": "Πυκνότητα επιδερμίδας",
    "radiance": "Λάμψη",
    "pigmentation": "Μελάγχρωση",
    "hair density": "Πυκνότητα μαλλιών",
    "anagen hair ratio": "Τρίχες σε φάση ανάπτυξης",
    "texture smoothness": "Λειότητα επιδερμίδας",
    "skin brightness": "Φωτεινότητα επιδερμίδας",
    "dermal fat protrusion depth": "Βάθος προβολής του λίπους στο χόριο",
    "skin roughness": "Τραχύτητα επιδερμίδας",
    "lip volume": "Όγκος χειλιών",
    "jawline definition": "Ευκρίνεια περιγράμματος προσώπου",
    "transepidermal water loss": "Διαεπιδερμική απώλεια νερού",
  },
  role: {
    "consultant dermatologist": "δερματολόγος",
    "board certified dermatologist": "δερματολόγος με τίτλο ειδικότητας",
    "dermatologist": "δερματολόγος",
    "board certified dermatologist and clinical researcher":
      "δερματολόγος με τίτλο ειδικότητας, κλινική έρευνα",
    "dermatologist and cosmetic physician":
      "δερματολόγος και ιατρός αισθητικής ιατρικής",
    "dermatologist and trichologist": "δερματολόγος και τριχολόγος",
    "clinical dermatologist and trichologist":
      "δερματολόγος και τριχολόγος, κλινική δερματολογία",
    "clinical dermatologist": "δερματολόγος, κλινική δερματολογία",
    "dermatologist and medical cosmetics specialist":
      "δερματολόγος, ειδίκευση στην ιατρική κοσμετολογία",
    "clinical and aesthetic dermatologist":
      "δερματολόγος, κλινική και αισθητική δερματολογία",
    "dermatologist and aesthetic physician":
      "δερματολόγος και ιατρός αισθητικής ιατρικής",
    "specialist in dermatology and venereology": "δερματολόγος-αφροδισιολόγος",
  },
};

const AR: Table = {
  concern: {
    "dullness": "بشرة باهتة",
    "eye corner lines": "تجاعيد زوايا العينين",
    "forehead lines": "تجاعيد الجبهة",
    "lip volume": "حجم الشفاه",
    "dehydration": "نقص ترطيب البشرة",
    "cellulite": "السيلوليت",
    "loss of firmness": "فقدان تماسك البشرة",
    "neck lines": "تجاعيد الرقبة",
    "uneven tone": "تفاوت لون البشرة",
    "jawline": "خط الفك",
    "nose to mouth lines": "خطوط الابتسامة",
    "dark spots": "البقع الداكنة",
    "frown lines": "تجاعيد ما بين الحاجبين",
    "hair thinning": "ترقق الشعر",
    "hair density": "كثافة الشعر",
    "jowls": "ترهل الخدين",
    "chest wrinkles": "تجاعيد أعلى الصدر",
    "hand wrinkles": "تجاعيد اليدين",
    "under eye": "محيط العينين",
    "neck sagging": "ترهل الرقبة",
    "glow": "نضارة البشرة",
    "elbow wrinkles": "تجاعيد المرفقين",
    "lip lines": "تجاعيد محيط الفم",
  },
  measure: {
    "wrinkle depth": "عمق التجاعيد",
    "skin firmness": "تماسك البشرة",
    "hydration": "ترطيب البشرة",
    "skin elasticity": "مرونة البشرة",
    "skin density": "كثافة البشرة",
    "radiance": "إشراقة البشرة",
    "pigmentation": "التصبغ",
    "hair density": "كثافة الشعر",
    "anagen hair ratio": "الشعر في طور النمو",
    "texture smoothness": "نعومة ملمس البشرة",
    "skin brightness": "صفاء البشرة",
    "dermal fat protrusion depth": "عمق بروز الدهون في الأدمة",
    "skin roughness": "خشونة البشرة",
    "lip volume": "حجم الشفاه",
    "jawline definition": "تحديد خط الفك",
    "transepidermal water loss": "فقدان الماء عبر البشرة",
  },
  role: {
    "consultant dermatologist": "طب الأمراض الجلدية",
    "board certified dermatologist": "طب الأمراض الجلدية (شهادة البورد)",
    "dermatologist": "طب الأمراض الجلدية",
    "board certified dermatologist and clinical researcher":
      "طب الأمراض الجلدية (شهادة البورد) والبحث السريري",
    "dermatologist and cosmetic physician": "طب الأمراض الجلدية والطب التجميلي",
    "dermatologist and trichologist": "طب الأمراض الجلدية وأمراض الشعر",
    "clinical dermatologist and trichologist":
      "طب الأمراض الجلدية السريري وأمراض الشعر",
    "clinical dermatologist": "طب الأمراض الجلدية السريري",
    "dermatologist and medical cosmetics specialist":
      "طب الأمراض الجلدية ومستحضرات التجميل الطبية",
    "clinical and aesthetic dermatologist":
      "طب الأمراض الجلدية السريري والتجميلي",
    "dermatologist and aesthetic physician": "طب الأمراض الجلدية والطب التجميلي",
    "specialist in dermatology and venereology":
      "طب الأمراض الجلدية والتناسلية",
  },
};

const JA: Table = {
  concern: {
    "dullness": "くすみ",
    "eye corner lines": "目尻のシワ",
    "forehead lines": "額のシワ",
    "lip volume": "唇のボリューム",
    "dehydration": "うるおい不足",
    "cellulite": "セルライト",
    "loss of firmness": "ハリ不足",
    "neck lines": "首のシワ",
    "uneven tone": "色ムラ",
    "jawline": "フェイスライン",
    "nose to mouth lines": "ほうれい線",
    "dark spots": "シミ",
    "frown lines": "眉間のシワ",
    "hair thinning": "薄毛",
    "hair density": "髪の密度",
    "jowls": "頬のたるみ",
    "chest wrinkles": "デコルテのシワ",
    "hand wrinkles": "手のシワ",
    "under eye": "目元",
    "neck sagging": "首のたるみ",
    "glow": "ツヤ不足",
    "elbow wrinkles": "肘のシワ",
    "lip lines": "口元のシワ",
  },
  measure: {
    "wrinkle depth": "シワの深さ",
    "skin firmness": "肌のハリ",
    "hydration": "肌の水分量",
    "skin elasticity": "肌の弾力",
    "skin density": "肌密度",
    "radiance": "ツヤ",
    "pigmentation": "色素沈着",
    "hair density": "毛髪密度",
    "anagen hair ratio": "成長期の毛髪の割合",
    "texture smoothness": "肌のなめらかさ",
    "skin brightness": "肌の明るさ",
    "dermal fat protrusion depth": "真皮への脂肪突出の深さ",
    "skin roughness": "肌のざらつき",
    "lip volume": "唇のボリューム",
    "jawline definition": "フェイスラインの引き締まり",
    "transepidermal water loss": "経表皮水分蒸散量",
  },
  role: {
    "consultant dermatologist": "皮膚科専門医",
    "board certified dermatologist": "認定皮膚科専門医",
    "dermatologist": "皮膚科医",
    "board certified dermatologist and clinical researcher":
      "認定皮膚科専門医・臨床研究者",
    "dermatologist and cosmetic physician": "皮膚科・美容皮膚科医",
    "dermatologist and trichologist": "皮膚科医・毛髪専門医",
    "clinical dermatologist and trichologist": "臨床皮膚科医・毛髪専門医",
    "clinical dermatologist": "臨床皮膚科医",
    "dermatologist and medical cosmetics specialist":
      "皮膚科医・メディカルコスメ専門家",
    "clinical and aesthetic dermatologist": "臨床・美容皮膚科医",
    "dermatologist and aesthetic physician": "皮膚科・美容皮膚科医",
    "specialist in dermatology and venereology": "皮膚科・性病科専門医",
  },
};

/** locale (lowercase) → kind → normalized English key → native label.
 *  English has no table: the source serves. */
export const RESULT_GLOSSARY: Record<string, Table> = {
  ar: AR,
  da: DA,
  de: DE,
  el: EL,
  es: ES,
  fi: FI,
  fr: FR,
  hu: HU,
  it: IT,
  ja: JA,
  nb: NB,
  nl: NL,
  no: NB,
  pl: PL,
  "pt-br": PT_BR,
  "pt-pt": PT_PT,
  ro: RO,
  sv: SV,
};

/** A bare Portuguese (or a regional one without its own table) reads the
 *  European table, the results-ui-copy.server.ts convention. */
const BASE_ALIASES: Record<string, string> = { pt: "pt-pt" };

function tableFor(locale: string): Table | null {
  const wanted = typeof locale === "string" ? locale.trim().toLowerCase() : "";
  if (!wanted) return null;
  const exact = RESULT_GLOSSARY[wanted];
  if (exact) return exact;
  const base = wanted.split("-")[0];
  return RESULT_GLOSSARY[BASE_ALIASES[base] ?? base] ?? null;
}

/**
 * The glossary's label for an English source in `locale` (exact locale,
 * then its base language), or null when the locale has no table or the
 * term is not listed: the caller then falls through to DeepL / the source.
 */
export function curatedResultLabel(
  kind: ResultGlossaryKind,
  locale: string,
  sourceText: string,
): string | null {
  const table = tableFor(locale);
  if (!table) return null;
  const key = resultGlossaryKey(sourceText);
  if (!key || !Object.prototype.hasOwnProperty.call(table[kind], key)) return null;
  const value = table[kind][key];
  return typeof value === "string" && /\S/.test(value) ? value : null;
}

/** Every locale that carries a glossary label for `sourceText` (the admin
 *  reviewer shows the built-in text under each language). */
export function curatedResultLabelsFor(
  kind: ResultGlossaryKind,
  sourceText: string,
): [string, string][] {
  const key = resultGlossaryKey(sourceText);
  if (!key) return [];
  const out: [string, string][] = [];
  for (const [locale, table] of Object.entries(RESULT_GLOSSARY)) {
    if (!Object.prototype.hasOwnProperty.call(table[kind], key)) continue;
    const value = table[kind][key];
    if (typeof value === "string" && /\S/.test(value)) out.push([locale, value]);
  }
  return out;
}

/**
 * Which glossary kind a per-entry result field belongs to: a measurement
 * LABEL (`m0l`..`m5l`) is a "measure", the attribution role is a "role".
 * Everything else (testimonial, measurement notes) is free text: null.
 */
export function resultFieldGlossaryKind(field: string): ResultGlossaryKind | null {
  if (/^m[0-5]l$/.test(field)) return "measure";
  if (field === "attributionRole") return "role";
  return null;
}
