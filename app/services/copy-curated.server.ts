/**
 * v15.5: CURATED copy translations for the dermatologist-endorsements
 * module — hand-written, native-reviewed text (one translator + one
 * adversarial reviewer per language) for the copy that is NOT in the
 * theme-extension locale catalogs: the v8.22 overlay-content English
 * defaults (panel View-all pill, official-overlay intro / FAQ / list
 * title) and this shop's live badge overrides. Those strings used to reach
 * shoppers only through DeepL, which mangled the {n} count token
 * ("d'{n}", "de «{n}»", "in „{n}“"), invented "nos dermatologues" and
 * mirrored the English em dashes.
 *
 * Contract:
 *   - keyed by LOCALE (lowercase Shopify locale; regional twins share a
 *     table: pt-pt, nb/no) then by the EXACT English source text, so a
 *     merchant edit stops matching by itself and DeepL takes over again;
 *   - ranking (proof-translation.server.ts): fresh MANUAL row > curated >
 *     fresh auto (DeepL) row > source. Curated is applied at SERVE time
 *     (the proxy overlay) and WRITTEN by the translate run (never billed);
 *   - the storefront copy rule: NO em dashes in any language; {n} kept
 *     verbatim; the intro keeps its two paragraphs ("\n\n");
 *   - PURE module (no prisma, no network) — the sim runs the real thing.
 *
 * Adding a language or a string: add the English source to
 * CURATED_COPY_SOURCES and a translation to EVERY locale table (the sim
 * fails on a missing entry). Do not edit the extension locale files for
 * these — el.json sits at the Shopify 15 KB byte wall.
 */

/** The English source texts (must equal the settings defaults / the live
 *  override wording character for character). */
export const CURATED_COPY_SOURCES = {
  eyebrowChoice:
    "Dermatologists' choice",
  badgeLinkView:
    "View dermatologists & learn more below",
  wallCta:
    "Read all {n} endorsements",
  overlayIntro:
    "Every endorsement in this collection comes from a licensed dermatologist who reviewed Cellexia's formulas, ingredients and approach, then shared a written professional assessment in their own words.\n\nEach recommendation is published with the dermatologist's name, professional title and country of practice, and is kept on file by Cellexia.",
  faqTitle:
    "Common questions",
  faq1Q:
    "Who are the dermatologists behind these recommendations?",
  faq1A:
    "All contributors are licensed dermatologists. Each recommendation is published with the doctor's name, specialist certification or professional title, and country of practice.",
  faq2Q:
    "How were these recommendations collected?",
  faq2A:
    "Cellexia shared the product and its full ingredient information with practising dermatologists and asked for their independent professional assessment. Their statements are published in their own words.",
  faq3Q:
    "Does a recommendation mean the product will suit my skin?",
  faq3A:
    "No two skins are alike. These assessments describe the formulation approach in general terms. For personal advice about your own skin, please consult your dermatologist or pharmacist.",
  listTitle:
    "All {n} dermatologists",
} as const;

const S = CURATED_COPY_SOURCES;

/** locale (lowercase) → English source text → native translation. */
export const CURATED_COPY_TRANSLATIONS: Record<
  string,
  Record<string, string>
> = {
  "fr": {
    [S.eyebrowChoice]:
      "Le choix des dermatologues",
    [S.badgeLinkView]:
      "Voir les dermatologues et en savoir plus",
    [S.wallCta]:
      "Lire les {n} recommandations",
    [S.overlayIntro]:
      "Chaque recommandation présentée ici provient d'un dermatologue diplômé qui a examiné les formules, les ingrédients et l'approche de Cellexia, puis a rédigé une évaluation professionnelle avec ses propres mots.\n\nLes recommandations sont publiées avec le nom, le titre professionnel et le pays d'exercice de chaque dermatologue, et sont conservées dans les archives de Cellexia.",
    [S.faqTitle]:
      "Questions fréquentes",
    [S.faq1Q]:
      "Qui sont les dermatologues à l'origine de ces recommandations ?",
    [S.faq1A]:
      "Toutes ces recommandations émanent de dermatologues diplômés. Chaque recommandation est publiée avec le nom du médecin, son diplôme de spécialité ou son titre professionnel, ainsi que le pays dans lequel il exerce.",
    [S.faq2Q]:
      "Comment ces recommandations ont-elles été recueillies ?",
    [S.faq2A]:
      "Cellexia a présenté le produit et la liste complète de ses ingrédients à des dermatologues en exercice, et leur a demandé une évaluation professionnelle indépendante. Leurs propos sont publiés tels quels, sans reformulation.",
    [S.faq3Q]:
      "Une recommandation signifie-t-elle que le produit conviendra à ma peau ?",
    [S.faq3A]:
      "Il n'y a pas deux peaux identiques. Ces évaluations décrivent l'approche de formulation en termes généraux. Pour des conseils personnalisés concernant votre peau, consultez votre dermatologue ou votre pharmacien.",
    [S.listTitle]:
      "Les {n} dermatologues",
  },
  "es": {
    [S.eyebrowChoice]:
      "La elección de los dermatólogos",
    [S.badgeLinkView]:
      "Conoce a los dermatólogos y descubre más",
    [S.wallCta]:
      "Leer las {n} recomendaciones",
    [S.overlayIntro]:
      "Cada recomendación de esta recopilación procede de un dermatólogo colegiado que ha analizado las fórmulas, los ingredientes y el enfoque de Cellexia, y que ha redactado una valoración profesional con sus propias palabras.\n\nLas recomendaciones se publican con el nombre, el título profesional y el país en el que ejerce cada dermatólogo, y Cellexia las conserva en sus archivos.",
    [S.faqTitle]:
      "Preguntas frecuentes",
    [S.faq1Q]:
      "¿Quiénes son los dermatólogos que están detrás de estas recomendaciones?",
    [S.faq1A]:
      "Todos los firmantes son dermatólogos colegiados. Cada recomendación se publica con el nombre del médico, su título de especialista o cargo profesional y el país en el que ejerce.",
    [S.faq2Q]:
      "¿Cómo se recopilaron estas recomendaciones?",
    [S.faq2A]:
      "Cellexia ha facilitado el producto y la información completa sobre sus ingredientes a dermatólogos en ejercicio y les ha solicitado su valoración profesional independiente. Sus declaraciones se publican tal y como las han expresado.",
    [S.faq3Q]:
      "¿Una recomendación significa que el producto será adecuado para mi piel?",
    [S.faq3A]:
      "No hay dos pieles iguales. Estas valoraciones describen el enfoque de la formulación en términos generales. Para un consejo personalizado sobre tu piel, consulta a tu dermatólogo o farmacéutico.",
    [S.listTitle]:
      "Los {n} dermatólogos",
  },
  "de": {
    [S.eyebrowChoice]:
      "Die Wahl der Dermatologen",
    [S.badgeLinkView]:
      "Alle Dermatologen ansehen und mehr erfahren",
    [S.wallCta]:
      "Alle {n} Empfehlungen lesen",
    [S.overlayIntro]:
      "Jede Empfehlung in dieser Sammlung stammt von einem approbierten Dermatologen, der die Rezepturen, die Inhaltsstoffe und den Ansatz von Cellexia geprüft und anschließend eine schriftliche fachliche Einschätzung in eigenen Worten abgegeben hat.\n\nJede Empfehlung wird mit Namen und Berufsbezeichnung des Dermatologen sowie dem Land veröffentlicht, in dem er praktiziert. Alle Empfehlungen werden von Cellexia dokumentiert und aufbewahrt.",
    [S.faqTitle]:
      "Häufige Fragen",
    [S.faq1Q]:
      "Wer sind die Dermatologen hinter diesen Empfehlungen?",
    [S.faq1A]:
      "Alle Verfasser sind approbierte Dermatologen. Jede Empfehlung wird mit Namen, Facharztanerkennung oder Berufsbezeichnung sowie dem Land veröffentlicht, in dem die Ärztin oder der Arzt praktiziert.",
    [S.faq2Q]:
      "Wie wurden diese Empfehlungen eingeholt?",
    [S.faq2A]:
      "Cellexia hat praktizierenden Dermatologen das Produkt und die vollständigen Angaben zu den Inhaltsstoffen vorgelegt und sie um eine unabhängige fachliche Einschätzung gebeten. Die Aussagen der Dermatologen werden in ihren eigenen Worten wiedergegeben.",
    [S.faq3Q]:
      "Bedeutet eine Empfehlung, dass das Produkt zu meiner Haut passt?",
    [S.faq3A]:
      "Keine Haut gleicht der anderen. Diese Einschätzungen beschreiben den Ansatz hinter der Rezeptur in allgemeiner Form. Für eine individuelle Beratung zu Ihrer Haut wenden Sie sich bitte an Ihre dermatologische Praxis oder Apotheke.",
    [S.listTitle]:
      "Alle {n} Dermatologen",
  },
  "it": {
    [S.eyebrowChoice]:
      "La scelta dei dermatologi",
    [S.badgeLinkView]:
      "Scopri i dermatologi e approfondisci qui sotto",
    [S.wallCta]:
      "Leggi tutte le {n} raccomandazioni",
    [S.overlayIntro]:
      "Ogni raccomandazione presente in questa raccolta proviene da un dermatologo abilitato che ha esaminato le formule, gli ingredienti e l'approccio di Cellexia e ha poi condiviso una valutazione professionale scritta con le proprie parole.\n\nLe raccomandazioni sono pubblicate con il nome, il titolo professionale e il Paese in cui esercita ciascun dermatologo, e sono conservate negli archivi di Cellexia.",
    [S.faqTitle]:
      "Domande frequenti",
    [S.faq1Q]:
      "Chi sono i dermatologi che hanno formulato queste raccomandazioni?",
    [S.faq1A]:
      "Sono tutti dermatologi abilitati. Ogni raccomandazione è pubblicata con il nome del medico, la specializzazione o il titolo professionale e il Paese in cui esercita.",
    [S.faq2Q]:
      "Come sono state raccolte queste raccomandazioni?",
    [S.faq2A]:
      "Cellexia ha messo il prodotto e le informazioni complete sugli ingredienti a disposizione di dermatologi in attività, chiedendo loro una valutazione professionale indipendente. Le dichiarazioni sono pubblicate con le loro stesse parole.",
    [S.faq3Q]:
      "Una raccomandazione significa che il prodotto è adatto alla mia pelle?",
    [S.faq3A]:
      "Non esistono due pelli uguali. Queste valutazioni descrivono l'approccio alla formulazione in termini generali. Per un consiglio personalizzato sulla tua pelle, rivolgiti al tuo dermatologo o farmacista.",
    [S.listTitle]:
      "Tutti i {n} dermatologi",
  },
  "nl": {
    [S.eyebrowChoice]:
      "De keuze van dermatologen",
    [S.badgeLinkView]:
      "Bekijk de dermatologen en lees hieronder meer",
    [S.wallCta]:
      "Lees alle {n} aanbevelingen",
    [S.overlayIntro]:
      "Elke aanbeveling in dit overzicht is afkomstig van een erkende dermatoloog die de formules, ingrediënten en aanpak van Cellexia heeft bestudeerd en vervolgens in eigen woorden een schriftelijke professionele beoordeling heeft gegeven.\n\nDe aanbevelingen worden gepubliceerd met de naam, de beroepstitel en het land waar de dermatoloog praktijk houdt, en worden door Cellexia bewaard.",
    [S.faqTitle]:
      "Veelgestelde vragen",
    [S.faq1Q]:
      "Wie zijn de dermatologen achter deze aanbevelingen?",
    [S.faq1A]:
      "Alle betrokken artsen zijn erkende dermatologen. Elke aanbeveling wordt gepubliceerd met de naam, de specialistenregistratie of beroepstitel en het land waar de arts praktijk houdt.",
    [S.faq2Q]:
      "Hoe zijn deze aanbevelingen verzameld?",
    [S.faq2A]:
      "Cellexia heeft het product en de volledige ingrediënteninformatie voorgelegd aan praktiserende dermatologen en hen gevraagd om een onafhankelijke professionele beoordeling. Hun uitspraken worden in hun eigen woorden gepubliceerd.",
    [S.faq3Q]:
      "Betekent een aanbeveling dat het product geschikt is voor mijn huid?",
    [S.faq3A]:
      "Elke huid is anders. Deze beoordelingen beschrijven de samenstelling van de formules in algemene zin. Voor persoonlijk advies over je eigen huid kun je het beste je dermatoloog of apotheker raadplegen.",
    [S.listTitle]:
      "Alle {n} dermatologen",
  },
  "pt-pt": {
    [S.eyebrowChoice]:
      "A escolha dos dermatologistas",
    [S.badgeLinkView]:
      "Veja os dermatologistas e saiba mais abaixo",
    [S.wallCta]:
      "Ler as {n} recomendações",
    [S.overlayIntro]:
      "Cada recomendação aqui apresentada provém de um dermatologista certificado que analisou as fórmulas, os ingredientes e a abordagem da Cellexia e partilhou, por escrito e nas suas próprias palavras, a sua avaliação profissional.\n\nAs recomendações são publicadas com o nome, o título profissional e o país de exercício de cada dermatologista, e ficam arquivadas na Cellexia.",
    [S.faqTitle]:
      "Perguntas frequentes",
    [S.faq1Q]:
      "Quem são os dermatologistas responsáveis por estas recomendações?",
    [S.faq1A]:
      "Todos os autores são dermatologistas certificados. Cada recomendação é publicada com o nome do médico, a respetiva certificação de especialista ou título profissional e o país onde exerce.",
    [S.faq2Q]:
      "Como foram recolhidas estas recomendações?",
    [S.faq2A]:
      "A Cellexia disponibilizou o produto e a informação completa sobre os ingredientes a dermatologistas em exercício e pediu-lhes uma avaliação profissional independente. As declarações são publicadas nas suas próprias palavras.",
    [S.faq3Q]:
      "Uma recomendação significa que o produto é adequado à minha pele?",
    [S.faq3A]:
      "Não há duas peles iguais. Estas avaliações descrevem a abordagem de formulação em termos gerais. Para aconselhamento personalizado sobre a sua pele, consulte o seu dermatologista ou farmacêutico.",
    [S.listTitle]:
      "Todos os {n} dermatologistas",
  },
  "da": {
    [S.eyebrowChoice]:
      "Dermatologernes valg",
    [S.badgeLinkView]:
      "Se dermatologerne og læs mere nedenfor",
    [S.wallCta]:
      "Læs alle {n} anbefalinger",
    [S.overlayIntro]:
      "Hver anbefaling i denne samling kommer fra en autoriseret dermatolog, der har gennemgået Cellexias formler, ingredienser og tilgang og derefter afgivet en skriftlig faglig vurdering med sine egne ord.\n\nAnbefalingerne offentliggøres med den enkelte dermatologs navn, faglige titel og det land, hvor vedkommende praktiserer, og opbevares hos Cellexia.",
    [S.faqTitle]:
      "Ofte stillede spørgsmål",
    [S.faq1Q]:
      "Hvem er dermatologerne bag disse anbefalinger?",
    [S.faq1A]:
      "Alle bidragydere er autoriserede dermatologer. Hver anbefaling offentliggøres med lægens navn, speciallægeanerkendelse eller faglige titel samt det land, hvor vedkommende praktiserer.",
    [S.faq2Q]:
      "Hvordan er anbefalingerne indsamlet?",
    [S.faq2A]:
      "Cellexia har præsenteret produktet og de fulde oplysninger om ingredienserne for praktiserende dermatologer og bedt om deres uafhængige faglige vurdering. Deres udtalelser er offentliggjort med deres egne ord.",
    [S.faq3Q]:
      "Betyder en anbefaling, at produktet passer til min hud?",
    [S.faq3A]:
      "Ingen to mennesker har den samme hud. Vurderingerne beskriver produktets formulering i generelle vendinger. Ønsker du personlig rådgivning om netop din hud, bør du tale med din hudlæge eller spørge på apoteket.",
    [S.listTitle]:
      "Alle {n} dermatologer",
  },
  "sv": {
    [S.eyebrowChoice]:
      "Dermatologernas val",
    [S.badgeLinkView]:
      "Se dermatologerna och läs mer nedan",
    [S.wallCta]:
      "Läs alla {n} rekommendationer",
    [S.overlayIntro]:
      "Varje rekommendation i den här samlingen kommer från en legitimerad dermatolog som har granskat Cellexias formler, ingredienser och syn på hudvård och därefter lämnat en skriftlig, professionell bedömning med egna ord.\n\nRekommendationerna publiceras med varje dermatologs namn, yrkestitel och verksamhetsland, och finns dokumenterade hos Cellexia.",
    [S.faqTitle]:
      "Vanliga frågor",
    [S.faq1Q]:
      "Vilka är dermatologerna bakom rekommendationerna?",
    [S.faq1A]:
      "Samtliga medverkande är legitimerade dermatologer. Varje rekommendation publiceras med läkarens namn, specialistkompetens eller yrkestitel samt verksamhetsland.",
    [S.faq2Q]:
      "Hur samlades rekommendationerna in?",
    [S.faq2A]:
      "Cellexia försåg kliniskt verksamma dermatologer med produkten och fullständig information om ingredienserna och bad dem om en oberoende, professionell bedömning. Uttalandena publiceras med deras egna ord.",
    [S.faq3Q]:
      "Betyder en rekommendation att produkten passar min hud?",
    [S.faq3A]:
      "Ingen hud är den andra lik. Bedömningarna beskriver produkternas sammansättning i allmänna ordalag. Vill du ha personlig rådgivning om just din hud, vänd dig till din dermatolog eller apotekare.",
    [S.listTitle]:
      "Alla {n} dermatologer",
  },
  "nb": {
    [S.eyebrowChoice]:
      "Hudlegenes valg",
    [S.badgeLinkView]:
      "Se hudlegene og les mer nedenfor",
    [S.wallCta]:
      "Les alle {n} anbefalingene",
    [S.overlayIntro]:
      "Hver anbefaling i denne samlingen kommer fra en autorisert hudlege som har vurdert Cellexias formuleringer, ingredienser og tilnærming, og deretter delt en skriftlig faglig vurdering med egne ord.\n\nAnbefalingene publiseres med hver hudleges navn, faglige tittel og landet der vedkommende praktiserer, og oppbevares i Cellexias arkiv.",
    [S.faqTitle]:
      "Vanlige spørsmål",
    [S.faq1Q]:
      "Hvem er hudlegene som står bak disse anbefalingene?",
    [S.faq1A]:
      "Alle som har bidratt, er autoriserte hudleger. Hver anbefaling publiseres med legens navn, spesialistgodkjenning eller faglige tittel, og landet der vedkommende praktiserer.",
    [S.faq2Q]:
      "Hvordan ble disse anbefalingene samlet inn?",
    [S.faq2A]:
      "Cellexia delte produktet og fullstendig informasjon om ingrediensene med praktiserende hudleger og ba om deres uavhengige faglige vurdering. Uttalelsene publiseres med hudlegenes egne ord.",
    [S.faq3Q]:
      "Betyr en anbefaling at produktet passer for huden min?",
    [S.faq3A]:
      "All hud er forskjellig. Disse vurderingene beskriver tilnærmingen bak formuleringen på generelt grunnlag. Ønsker du personlige råd om din egen hud, bør du snakke med hudlegen din eller spørre på apoteket.",
    [S.listTitle]:
      "Alle {n} hudlegene",
  },
  // Shopify publishes Norwegian as "no" or "nb" — one table, two keys.
  "no": {
    [S.eyebrowChoice]:
      "Hudlegenes valg",
    [S.badgeLinkView]:
      "Se hudlegene og les mer nedenfor",
    [S.wallCta]:
      "Les alle {n} anbefalingene",
    [S.overlayIntro]:
      "Hver anbefaling i denne samlingen kommer fra en autorisert hudlege som har vurdert Cellexias formuleringer, ingredienser og tilnærming, og deretter delt en skriftlig faglig vurdering med egne ord.\n\nAnbefalingene publiseres med hver hudleges navn, faglige tittel og landet der vedkommende praktiserer, og oppbevares i Cellexias arkiv.",
    [S.faqTitle]:
      "Vanlige spørsmål",
    [S.faq1Q]:
      "Hvem er hudlegene som står bak disse anbefalingene?",
    [S.faq1A]:
      "Alle som har bidratt, er autoriserte hudleger. Hver anbefaling publiseres med legens navn, spesialistgodkjenning eller faglige tittel, og landet der vedkommende praktiserer.",
    [S.faq2Q]:
      "Hvordan ble disse anbefalingene samlet inn?",
    [S.faq2A]:
      "Cellexia delte produktet og fullstendig informasjon om ingrediensene med praktiserende hudleger og ba om deres uavhengige faglige vurdering. Uttalelsene publiseres med hudlegenes egne ord.",
    [S.faq3Q]:
      "Betyr en anbefaling at produktet passer for huden min?",
    [S.faq3A]:
      "All hud er forskjellig. Disse vurderingene beskriver tilnærmingen bak formuleringen på generelt grunnlag. Ønsker du personlige råd om din egen hud, bør du snakke med hudlegen din eller spørre på apoteket.",
    [S.listTitle]:
      "Alle {n} hudlegene",
  },
  "fi": {
    [S.eyebrowChoice]:
      "Ihotautilääkärien valinta",
    [S.badgeLinkView]:
      "Tutustu ihotautilääkäreihin ja lue lisää alta",
    [S.wallCta]:
      "Lue kaikki {n} suositusta",
    [S.overlayIntro]:
      "Jokainen tämän kokoelman suositus on peräisin laillistetulta ihotautilääkäriltä, joka on perehtynyt Cellexian koostumuksiin, ainesosiin ja lähestymistapaan sekä laatinut sen jälkeen kirjallisen ammatillisen arvion omin sanoin.\n\nJokaisen suosituksen yhteydessä julkaistaan ihotautilääkärin nimi, ammattinimike ja maa, jossa hän harjoittaa ammattiaan. Cellexia säilyttää kaikki suositukset arkistossaan.",
    [S.faqTitle]:
      "Usein kysyttyä",
    [S.faq1Q]:
      "Keitä ovat näiden suositusten takana olevat ihotautilääkärit?",
    [S.faq1A]:
      "Kaikki suositusten antajat ovat laillistettuja ihotautilääkäreitä. Jokaisen suosituksen yhteydessä ilmoitetaan lääkärin nimi, erikoislääkärin pätevyys tai ammattinimike sekä maa, jossa hän harjoittaa ammattiaan.",
    [S.faq2Q]:
      "Miten nämä suositukset on kerätty?",
    [S.faq2A]:
      "Cellexia toimitti tuotteen ja sen täydelliset ainesosatiedot ammattiaan harjoittaville ihotautilääkäreille ja pyysi heiltä riippumatonta ammatillista arviota. Lausunnot on julkaistu sellaisinaan, kunkin lääkärin omin sanoin.",
    [S.faq3Q]:
      "Tarkoittaako suositus, että tuote sopii iholleni?",
    [S.faq3A]:
      "Jokainen iho on erilainen. Nämä arviot kuvaavat tuotteiden koostumusta yleisellä tasolla. Jos haluat henkilökohtaista neuvontaa omasta ihostasi, käänny ihotautilääkärisi tai apteekin puoleen.",
    [S.listTitle]:
      "Kaikki {n} ihotautilääkäriä",
  },
  "pl": {
    [S.eyebrowChoice]:
      "Wybór dermatologów",
    [S.badgeLinkView]:
      "Zobacz listę dermatologów i dowiedz się więcej poniżej",
    [S.wallCta]:
      "Przeczytaj wszystkie rekomendacje ({n})",
    [S.overlayIntro]:
      "Każda rekomendacja w tym zbiorze pochodzi od lekarza dermatologa z prawem wykonywania zawodu, który zapoznał się z recepturami, składnikami i podejściem Cellexii, a następnie przedstawił własnymi słowami pisemną opinię ekspercką.\n\nRekomendacje są publikowane wraz z imieniem i nazwiskiem każdego dermatologa, jego tytułem zawodowym oraz krajem, w którym prowadzi praktykę, a Cellexia przechowuje je w swojej dokumentacji.",
    [S.faqTitle]:
      "Najczęstsze pytania",
    [S.faq1Q]:
      "Kim są dermatolodzy, którzy wystawili te rekomendacje?",
    [S.faq1A]:
      "Wszyscy autorzy to lekarze dermatolodzy z prawem wykonywania zawodu. Każda rekomendacja jest publikowana wraz z imieniem i nazwiskiem lekarza, jego specjalizacją lub tytułem zawodowym oraz krajem, w którym prowadzi praktykę.",
    [S.faq2Q]:
      "W jaki sposób zebrano te rekomendacje?",
    [S.faq2A]:
      "Cellexia udostępniła praktykującym dermatologom produkt wraz z pełną informacją o składzie i poprosiła ich o niezależną opinię ekspercką. Ich wypowiedzi są publikowane w oryginalnym, niezmienionym brzmieniu.",
    [S.faq3Q]:
      "Czy rekomendacja oznacza, że produkt będzie odpowiedni dla mojej skóry?",
    [S.faq3A]:
      "Każda skóra jest inna. Zamieszczone tu opinie opisują podejście do receptur w ujęciu ogólnym. Po indywidualną poradę dotyczącą Twojej skóry zwróć się do swojego dermatologa lub farmaceuty.",
    [S.listTitle]:
      "Wszyscy dermatolodzy ({n})",
  },
  "ro": {
    [S.eyebrowChoice]:
      "Alegerea dermatologilor",
    [S.badgeLinkView]:
      "Vezi lista dermatologilor și află mai multe",
    [S.wallCta]:
      "Citește toate recomandările ({n})",
    [S.overlayIntro]:
      "Fiecare recomandare din această colecție provine de la un dermatolog autorizat care a analizat formulele, ingredientele și abordarea Cellexia și a redactat apoi o evaluare profesională, în propriile cuvinte.\n\nRecomandările sunt publicate împreună cu numele fiecărui dermatolog, titlul său profesional și țara în care profesează, iar Cellexia le păstrează în arhiva sa.",
    [S.faqTitle]:
      "Întrebări frecvente",
    [S.faq1Q]:
      "Cine sunt dermatologii din spatele acestor recomandări?",
    [S.faq1A]:
      "Toate recomandările provin de la medici dermatologi autorizați. Fiecare recomandare este publicată împreună cu numele medicului, certificarea de specialitate sau titlul profesional și țara în care profesează.",
    [S.faq2Q]:
      "Cum au fost obținute aceste recomandări?",
    [S.faq2A]:
      "Cellexia a pus la dispoziția unor medici dermatologi cu drept de liberă practică produsul și informațiile complete despre ingrediente și le-a cerut o evaluare profesională independentă. Declarațiile lor sunt publicate exact așa cum le-au formulat.",
    [S.faq3Q]:
      "O recomandare înseamnă că produsul se va potrivi pielii mele?",
    [S.faq3A]:
      "Nu există două tipuri de piele identice. Aceste evaluări descriu, în termeni generali, modul în care au fost concepute formulele. Pentru sfaturi personalizate privind pielea ta, consultă-ți dermatologul sau farmacistul.",
    [S.listTitle]:
      "Toți dermatologii ({n})",
  },
  "hu": {
    [S.eyebrowChoice]:
      "Bőrgyógyászok választása",
    [S.badgeLinkView]:
      "Nézd meg a bőrgyógyászokat, és tudj meg többet",
    [S.wallCta]:
      "Olvasd el az összes ajánlást ({n})",
    [S.overlayIntro]:
      "A gyűjteményben szereplő minden ajánlás olyan bőrgyógyász szakorvostól származik, aki áttekintette a Cellexia formuláit, összetevőit és bőrápolási szemléletét, majd saját szavaival írásos szakmai véleményt fogalmazott meg.\n\nAz ajánlásokat a bőrgyógyász nevével, szakmai titulusával és annak az országnak a megjelölésével együtt tesszük közzé, ahol praktizál, és mindegyiket nyilvántartásunkban megőrizzük.",
    [S.faqTitle]:
      "Gyakori kérdések",
    [S.faq1Q]:
      "Kik azok a bőrgyógyászok, akiktől ezek az ajánlások származnak?",
    [S.faq1A]:
      "Minden közreműködő szakvizsgázott bőrgyógyász. Az ajánlásokat az orvos nevével, szakvizsgájával vagy szakmai titulusával, valamint annak az országnak a megjelölésével együtt tesszük közzé, ahol praktizál.",
    [S.faq2Q]:
      "Hogyan gyűjtötték össze ezeket az ajánlásokat?",
    [S.faq2A]:
      "A Cellexia eljuttatta a terméket és annak teljes összetevőlistáját praktizáló bőrgyógyászoknak, és független szakmai véleményüket kérte. Nyilatkozataikat saját szavaikkal közöljük.",
    [S.faq3Q]:
      "Azt jelenti egy ajánlás, hogy a termék az én bőrömnek is megfelel?",
    [S.faq3A]:
      "Nincs két egyforma bőr. Ezek a vélemények általánosságban ismertetik a formulák mögötti megközelítést. Ha a saját bőröddel kapcsolatban személyre szabott tanácsra van szükséged, fordulj bőrgyógyászodhoz vagy gyógyszerészedhez.",
    [S.listTitle]:
      "Az összes bőrgyógyász ({n})",
  },
  "el": {
    [S.eyebrowChoice]:
      "Η επιλογή των δερματολόγων",
    [S.badgeLinkView]:
      "Δες τους δερματολόγους και μάθε περισσότερα",
    [S.wallCta]:
      "Διάβασε όλες τις συστάσεις ({n})",
    [S.overlayIntro]:
      "Κάθε σύσταση σε αυτή τη συλλογή προέρχεται από πιστοποιημένο δερματολόγο που μελέτησε τις συνθέσεις, τα συστατικά και την προσέγγιση της Cellexia και στη συνέχεια κατέθεσε γραπτή επαγγελματική αξιολόγηση με δικά του λόγια.\n\nΟι συστάσεις δημοσιεύονται με το όνομα κάθε δερματολόγου, τον επαγγελματικό του τίτλο και τη χώρα στην οποία ασκεί το επάγγελμά του, και φυλάσσονται στο αρχείο της Cellexia.",
    [S.faqTitle]:
      "Συχνές ερωτήσεις",
    [S.faq1Q]:
      "Ποιοι είναι οι δερματολόγοι πίσω από αυτές τις συστάσεις;",
    [S.faq1A]:
      "Όλοι όσοι συμμετέχουν είναι πιστοποιημένοι δερματολόγοι. Κάθε σύσταση δημοσιεύεται με το όνομα του ιατρού, τον τίτλο ειδικότητας ή τον επαγγελματικό του τίτλο, καθώς και τη χώρα στην οποία ασκεί το επάγγελμά του.",
    [S.faq2Q]:
      "Πώς συγκεντρώθηκαν αυτές οι συστάσεις;",
    [S.faq2A]:
      "Η Cellexia παρουσίασε το προϊόν και τα πλήρη στοιχεία για τα συστατικά του σε εν ενεργεία δερματολόγους και ζήτησε την ανεξάρτητη επαγγελματική τους αξιολόγηση. Οι δηλώσεις τους δημοσιεύονται όπως ακριβώς τις διατύπωσαν.",
    [S.faq3Q]:
      "Μια σύσταση σημαίνει ότι το προϊόν θα ταιριάζει στην επιδερμίδα μου;",
    [S.faq3A]:
      "Κάθε επιδερμίδα είναι διαφορετική. Οι αξιολογήσεις αυτές περιγράφουν σε γενικές γραμμές την προσέγγιση της σύνθεσης. Για συμβουλές προσαρμοσμένες στη δική σου επιδερμίδα, απευθύνσου στον δερματολόγο ή στον φαρμακοποιό σου.",
    [S.listTitle]:
      "Όλοι οι δερματολόγοι ({n})",
  },
  "ja": {
    [S.eyebrowChoice]:
      "皮膚科医が選ぶ",
    [S.badgeLinkView]:
      "皮膚科医の一覧と詳細を見る",
    [S.wallCta]:
      "{n}件の推薦文をすべて読む",
    [S.overlayIntro]:
      "ここに掲載されているすべての推薦文は、免許を持つ皮膚科医によるものです。各医師はCellexiaの処方、成分、そしてスキンケアへの考え方を精査したうえで、専門家としての評価を自身の言葉で書面にまとめて寄せています。\n\n各推薦文には、皮膚科医の氏名、肩書き、および診療を行っている国が明記されており、Cellexiaが記録として保管しています。",
    [S.faqTitle]:
      "よくある質問",
    [S.faq1Q]:
      "推薦文を寄せているのは、どのような皮膚科医ですか？",
    [S.faq1A]:
      "寄稿者は全員、免許を持つ皮膚科医です。各推薦文には、医師の氏名、専門医資格または肩書き、および診療を行っている国が明記されています。",
    [S.faq2Q]:
      "推薦文はどのように集められたのですか？",
    [S.faq2A]:
      "Cellexiaは、本製品と全成分情報を現役の皮膚科医に提供し、独立した立場からの専門的な評価を依頼しました。医師のコメントは、本人の言葉のまま掲載しています。",
    [S.faq3Q]:
      "推薦されているということは、私の肌にも合うということですか？",
    [S.faq3A]:
      "肌は人それぞれ異なります。これらの評価は、処方の考え方を一般的な観点から述べたものです。ご自身の肌に関する個別のアドバイスについては、皮膚科医または薬剤師にご相談ください。",
    [S.listTitle]:
      "{n}名の皮膚科医一覧",
  },
  "ar": {
    [S.eyebrowChoice]:
      "اختيار أطباء الجلدية",
    [S.badgeLinkView]:
      "اطّلع على أطباء الجلدية واعرف المزيد أدناه",
    [S.wallCta]:
      "اقرأ جميع التوصيات الـ{n}",
    [S.overlayIntro]:
      "كل توصية في هذه المجموعة صادرة عن طبيب جلدية مرخّص راجع تركيبات Cellexia ومكوناتها ونهجها، ثم قدّم تقييمًا مهنيًا مكتوبًا بعباراته الخاصة.\n\nتُنشر التوصيات مع ذكر اسم كل طبيب جلدية ولقبه المهني والبلد الذي يمارس فيه مهنته، وتحتفظ Cellexia بها في سجلاتها.",
    [S.faqTitle]:
      "الأسئلة الشائعة",
    [S.faq1Q]:
      "من هم أطباء الجلدية الذين قدّموا هذه التوصيات؟",
    [S.faq1A]:
      "جميع المساهمين أطباء جلدية مرخّصون. وتُنشر كل توصية مع ذكر اسم الطبيب، وشهادة التخصص أو لقبه المهني، والبلد الذي يمارس فيه مهنته.",
    [S.faq2Q]:
      "كيف جُمعت هذه التوصيات؟",
    [S.faq2A]:
      "شاركت Cellexia المنتج ومعلومات مكوناته الكاملة مع أطباء جلدية ممارسين، وطلبت منهم تقييمًا مهنيًا مستقلًا. وتُنشر تصريحاتهم بعباراتهم الخاصة.",
    [S.faq3Q]:
      "هل تعني التوصية أن المنتج سيكون مناسبًا لبشرتي؟",
    [S.faq3A]:
      "لا توجد بشرتان متشابهتان. تصف هذه التقييمات نهج التركيب بعبارات عامة. وللحصول على نصيحة شخصية بشأن بشرتك، يرجى استشارة طبيب الجلدية أو الصيدلي.",
    [S.listTitle]:
      "جميع أطباء الجلدية الـ{n}",
  },
};

function tableFor(locale: string): Record<string, string> | null {
  const wanted = locale.trim().toLowerCase();
  if (!wanted) return null;
  const exact = CURATED_COPY_TRANSLATIONS[wanted];
  if (exact) return exact;
  const base = wanted.split("-")[0];
  return CURATED_COPY_TRANSLATIONS[base] ?? null;
}

/**
 * The curated translation of `sourceText` for `locale` (exact locale, then
 * its base language), or null when either the locale or the exact source
 * text is unknown — the caller then falls through to DeepL / the source.
 */
export function curatedCopyTranslation(
  locale: string,
  sourceText: string,
): string | null {
  const table = tableFor(locale);
  if (!table) return null;
  const value = table[sourceText];
  return typeof value === "string" && /\S/.test(value) ? value : null;
}

/** Every locale that carries a curated translation of `sourceText`
 *  (admin reviewer: show the built-in text under each language). */
export function curatedTranslationsFor(
  sourceText: string,
): [string, string][] {
  const out: [string, string][] = [];
  for (const [locale, table] of Object.entries(CURATED_COPY_TRANSLATIONS)) {
    const value = table[sourceText];
    if (typeof value === "string" && /\S/.test(value)) out.push([locale, value]);
  }
  return out;
}
