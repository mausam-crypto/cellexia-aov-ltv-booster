# SPEC v37 — Brazilian Portuguese (pt-BR) as a shipped language

v37 (2026-10-07). Adds `pt-BR` as the 19th storefront locale (18 languages +
`en.default`), across every surface that carries pre-translated copy. Zero
Liquid bytes, zero new locale keys in existing files, `el`/`ar` byte walls
untouched.

## Why a separate locale (not the pt fallback)

Shopify publishes Brazilian Portuguese as `pt-BR`. Before v37:

- Liquid `{{ 'key' | t }}` on a `pt-BR` storefront fell back to
  **en.default** (Shopify never falls back pt-BR → pt-PT), so the widgets
  read English.
- The JS catalogs (`CX_QSEL_STR`, `CX_QSEL_UNITS`, `CX_BBP_AWARD`) resolved
  pt-BR to the **pt-PT** tables via the first-same-base-key scan;
  `AZ_SHIPS_FORMS` had no table at all for pt-BR pages.
- The server curated tables either aliased to pt-pt (`results-ui-copy`) or
  missed entirely and fell through to DeepL (`copy-curated`).

European and Brazilian Portuguese differ enough that serving pt-PT to
Brazilians reads foreign (utilizador/usuário, encomenda/pedido,
poupar/economizar, "A carregar"/"Carregando"). v37 gives pt-BR its own copy
everywhere; bare `pt` and `pt-PT` keep the European tables on purpose.

## Surfaces and files

| Surface | File(s) | pt-BR shape |
| --- | --- | --- |
| Theme extension strings | `extensions/cellexia-booster/locales/pt-BR.json` | 236 keys, 12,981B (cap 15,360B; harness budget 15,200B). Key set mirrors `pt-PT.json` exactly (same CLDR plural subsets: `{one, other}`, `bought_count` adds `many`). |
| Checkout extensions | `checkout-delivery/ -protection/ -trust/ -upsell/locales/pt-BR.json` | Mirrors each extension's `pt-PT.json` key set; `{{x}}` placeholders stay space-free. |
| Quantity cards | `cellexia-pdp.js` `CX_QSEL_STR["pt-BR"]` | `b2`/`b3` twinned VERBATIM with the locale file's `volume.most_popular` ("O mais popular") / `volume.best_value` ("Melhor custo-benefício") — harness v26/v27 pins enforce it. |
| Unit words | `cellexia-pdp.js` `CX_QSEL_UNITS["pt-BR"]` | Pote, Seringa, Tubo, Frasco conta-gotas, Stick, Frasco pump, Frasco — `{one, other}`, each matching the locale file's `bottle.container_*` nouns. |
| Award strip | `cellexia-pdp.js` `CX_BBP_AWARD["pt-BR"]` | "Nº {r} entre mais de {n} {c}" + 10 Brazilian category nouns ("cremes anti-idade", "cremes firmadores", "tratamentos antimanchas", "produtos de cuidados com a pele"). |
| Ships-from grammar | `scripts/gen-ships-from-grammar.mjs` `LANGS["pt-BR"]` → generated `AZ_SHIPS_FORMS["pt-BR"]` | All 59 fused-preposition country forms. Brazilian articles where pt-PT has none (da França, da Itália, da Espanha, do Marrocos, do Chipre) and Brazilian spellings (Estônia, Letônia, Polônia, Romênia, Eslovênia, Tchéquia, Mônaco, Vietnã, Liechtenstein). Never hand-edit the JS literal — edit the script and re-run it. |
| Endorsement overlay copy | `app/services/copy-curated.server.ts` `CURATED_COPY_TRANSLATIONS["pt-br"]` | 12 strings (lowercase key; `tableFor` hits it exactly, so the DeepL fallback is no longer used for pt-BR). |
| Results-gallery chrome | `app/services/results-ui-copy.server.ts` `RESULTS_UI_COPY["pt-br"]` | 13 codes. `BASE_ALIASES.pt` still points bare `pt` at `pt-pt`. |
| Volume discount label | `extensions/cellexia-volume/src/logic.js` `VOLUME_MSG["pt-br"]` | "Desconto por quantidade" (BR idiom; base `pt` keeps "Desconto de quantidade"). FIELD BUG FIXED HERE: the input `localization.language.isoCode` is the GraphQL LanguageCode ENUM (`PT_BR`, `PT_PT` — enum names cannot carry hyphens), and `volumeMessage` only lowercased, so every regional code fell through to English since v32; it now normalizes `_` → `-` (sim H5b pins `PT_BR`/`PT_PT`). `dist/function.wasm` rebuilt (`npx shopify app function build --path extensions/cellexia-volume`); the normal deploy rebuilds it anyway. |
| Admin | `app.localization.tsx` + `health.server.ts` `SHIPPED_LOCALES`, `LANGUAGE_NAMES` | "Portuguese (Brazil)"; coverage check now counts a published pt-BR as covered. |
| DeepL | `translation.server.ts` | No change needed — `pt-br → PT-BR` was already in `DEEPL_TARGETS`; targets come from the shop's published locales. |

## Key-order rule (resolver trap)

`qselLocale`, `bbpAwardLocale` and the ships-from lookup fall back to the
FIRST key sharing the base language. `pt-BR` therefore sits AFTER `pt-PT` in
every JS object literal and in the generator's `LANGS`, so a bare `pt` page
keeps resolving to European Portuguese
(`sims/quantity-selector.cjs` pins `qselLocale({l:"pt"}) === "pt-PT"`).

## Translation conventions (the native register)

- você register, gerúndio progressives ("Adicionando…", "Carregando",
  "Mostrando"), próclise ("se qualifica", "pediu a eles").
- Vocabulary: frete (shipping), pedido (order), estoque (stock), brinde
  (free gift), usuários, assinatura/assine (subscription), pesquisa
  (survey/research), pacientes, baixar (download), kit (the rewards set; the volume module says "Sua opção atual"),
  matéria (press article), criptografia, extravio (lost parcel),
  forma de pagamento, Finalizar compra (checkout CTA), Nota {{ rating }}
  de 5, "Melhor custo-benefício".
- "dermatologistas certificados/habilitados", never "licenciados" (in
  Brazil "médico licenciado" can read as a doctor ON LEAVE).
- NO em dashes (house rule since v15.5) — the new file uses comma/colon/full
  stop where `pt-PT.json` still carries legacy dashes; numeric ranges keep
  the en dash ("8–12 semanas"). Curly quotes (“ ”), not «guillemets».
- CLDR note: pt (= Brazilian) selects `one` for 0 AND 1; the widgets never
  render zero counts, and the file mirrors pt-PT's plural key subsets.

## Validation deltas

- harness: locale-file counts 18 → 19 (v8.16, v10); catalog-coverage pins
  18 → 19 (v26 `CX_QSEL_STR`, v27 `CX_QSEL_UNITS`, v28 `CX_BBP_AWARD`);
  `AZ_SHIPS_FORMS` 18 → 19 tables + new grammar spot-pins
  `pt-BR FR "da França"`, `VN "do Vietnã"`, `US "dos Estados Unidos"`.
  The v26/v27 b2/b3 twin pins extend to pt-BR automatically (they derive
  the locale list from the files on disk).
- sims: `proof-server` UC4 now expects `resultsUiCopy("pt-BR") ===
  table["pt-br"]` (was: aliases to pt-pt); `checkout-trust` adds pt-BR to
  `CHECKOUT_LOCALES` + T4 19 files; `native-dates` 19 files + pt-BR
  verbatim-tag check (fixtures regenerate on run, now locales × 20 incl.
  pt-BR); `quantity-selector` unit catalog 19 locales (pt-BR under the
  default `{one, other}` rule).
- Suite: 36 suites / 12,561 checks green; `tsc` + `npm run build` green.

## What the merchant still does

Add Brazilian Portuguese in Shopify admin → Settings → Languages and publish
it for the Brazilian market. Until then nothing is shopper-visible. DeepL
auto-translation of merchant-EDITED copy picks pt-BR up from the published
locale list on the next save / translate run (curated built-ins win where
they exist, per the v15.5 ranking).

## Known copy edges (accepted)

- `amazon.bought_count` pt-BR: the plural category comes from the RAW count
  while the shown number is compacted, so a count like 1,500,000 picks
  `other` but renders "1 mi" ("Mais de 1 mi compras", missing the "de").
  Exact millions (the realistic merchant inputs at that scale) pick `many`
  and read correctly; counts under a million are always correct. Fixing it
  for arbitrary >1M counts is a code change (round stored counts to whole
  millions), out of v37's copy scope.
- Pre-existing, all-language, out of scope: the `' — '` code joiners in
  `cellexia-cart.js` (after `volume.current_pack`) and `cellexia-pdp.js`
  (compact survey top line) render an em dash in every locale, and the
  award strip prints its count unformatted ("1500", where pt-BR writes
  "1.500"). Both predate v37 and are the known v15.5 follow-up.
