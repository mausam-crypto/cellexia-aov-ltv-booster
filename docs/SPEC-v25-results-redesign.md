# SPEC v25 — Results gallery clinical trust redesign

Merchant ask (2026-09-18, with two reference designs): redesign the
before/after widget and its lightbox for trust/credibility and conversion
("See results from 67 real Cellexia users" headline treatment, REAL PEOPLE.
REAL RESULTS. tagline, green clinical-metrics panel, trust-mark row,
dermatologist attribution); let an entry that is marked as a clinical study
carry instrument measurements; make the lightbox close button actually
visible (it vanished over photos). The feature stays OFF live
(`beforeAfter.enabled` untouched); everything ships dark.

Binding contract for the v25 wave. Read `docs/SPEC-v8-proof-library.md`
first — the gallery's architecture (proxy, ProofTranslation, density
tiers, fail-closed rules) all carries over. Inherited non-negotiables:

- ZERO new locale keys (el/ar at the 15,200B pin) and ZERO Liquid bytes
  (total stays 98,422/99,500) — no `.liquid` file is touched, and the
  only locale edit is v25.1's in-place reword of two EXISTING keys (§8).
- ES5, textContent-only sinks, createElementNS icons, pfHttps gates,
  class coverage, prover allowlist, fail-closed rendering.
- Zero new assets: system font stack for the banner sentence, Georgia for
  the green serif numerals (the v24 rule).

## 1. Data model (Prisma, BOTH schema files + sqlite migration
`20260918083000_v25_results_clinical`; Postgres = `db push` per UPDATE.md §2)

`CustomerResult` gains:

| column            | type                     | meaning                                    |
| ----------------- | ------------------------ | ------------------------------------------ |
| `measurements`    | String @default("[]")    | JSON `[{label, dir: "down"\|"up", pct, info?}]`, lab entries only |
| `markInstrument`  | Boolean @default(false)  | trust mark: instrument measured            |
| `markSamePatient` | Boolean @default(false)  | trust mark: same patient                   |
| `markUnretouched` | Boolean @default(false)  | trust mark: unretouched images             |
| `attributionName` | String?                  | who the testimonial quote is from (proper noun, never translated) |
| `attributionRole` | String?                  | their role/title (translatable prose)      |

Caps (proof.server.ts, exported): `MAX_RESULT_MEASUREMENTS = 6`,
`MEASUREMENT_LABEL_MAX = 80`, `MEASUREMENT_INFO_MAX = 240`,
`MEASUREMENT_PCT_MAX = 500`. v26.2: `pct` is 0.1–500 with AT MOST ONE
decimal — `validMeasurementPct` (server) / `resultsValidPct` (JS twin)
validate via the String round-trip `/^\d+(\.\d)?$/` (34.2 × 10 !== 342
in IEEE 754, so never numeric decimal-place math); integers print bare
("34%", never "34.0%"), 34.25 is a SAVE ERROR (fake precision). Display:
`resultsFmtPct` swaps the dot for a comma when the page language (base
of `pfPageLocale()`) is in `RESULTS_COMMA_DECIMAL` (the 15 comma-decimal
theme languages; en/ja/ar keep the dot, digits stay Western — the
widget-wide convention). Admin accepts a typed comma and normalizes to a
dot on save. Both `dir` values are IMPROVEMENTS the merchant chose to
publish (down = reduction, up = increase) — one green family, the sign
carried by the arrow, never typed.

LAB-ONLY RULE (three layers): `saveResult` clears measurements + marks
whenever `source != "lab"` (the admin hides the editor there — flipping an
entry to customer deliberately drops its clinical claims); `getPublicResults`
serves `[]` + false marks for non-lab rows whatever the columns hold (the
drifted-data belt, sim-mutant-pinned); `resultsValidItems` +
`resultsClinical` both gate on `lab` client-side (redundant pair —
direct-call pinned, the v21.1 precedent). Measurements REQUIRE
`durationWeeks >= 1` at save time (the panel header states when they were
taken). Attribution is NOT lab-gated (customer quotes get names too).

Validation: strict at save (`cleanMeasurements` — every problem is a
reported error, nothing silently dropped), tolerant at serve/display
(`parseResultMeasurements` — drops bad rows per row). The admin has a
client twin `parseResultMeasurementList` in ProofForms.tsx
(parseProductGidList precedent — `.server` modules never reach the bundle).

## 2. Proxy (proxy.proof.tsx, results branch)

- Item payload += `measurements` (parsed, lab-gated), the three mark
  booleans, `attributionName`, `attributionRole` (PublicResult is now
  eighteen fields — proof-server PR4 pin updated).
- Translation overlay sources per item grow to
  `{testimonial, attributionRole, m{i}l, m{i}i}` where `m{i}l`/`m{i}i` are
  the i-th measurement's label/info (0-based, index-positional so digests
  align with translate-time sources; reordering rows digest-mismatches old
  rows → skipped, re-translated on the next run, never mis-applied).
- NEW `payload.copy` member on EVERY results response: the six fixed
  chrome strings from `app/services/results-ui-copy.server.ts` —
  `{rp, ma, vsb, mi, mp, mu}` (tagline, "Clinically measured at @@N@@
  weeks", "vs. baseline", the three trust-mark labels), resolved by page
  locale with base-language + pt/nb-twin fallback, English last. The table
  is a curated, reviewable 18-locale module (no settings, no DeepL, no
  admin surface — fixed chrome; deep-validated by proof-server UC cases:
  exact catalog-language coverage, non-blank, no em dashes, @@N@@ present,
  en strings pinned to the mock's wording).

## 3. Translation service (proof-translation.server.ts)

`TRANSLATABLE_PROOF_FIELDS.results` = `["testimonial", "attributionRole",
...RESULT_MEASUREMENT_FIELDS]` (m0l/m0i…m5l/m5i — 14 fields).
`loadSourceFields` emits them from the row via `measurementSourceFields`
(exported; a LOCAL tolerant parse — this module must never gain a runtime
import of proof.server, which imports it back). Manual review accepts the
new codes (`m6l`+ rejected). The admin results tab feeds
ProofTranslationsSection the per-measurement fields with human labels.

## 4. Storefront (cellexia-proof.js + cellexia-booster.css)

New builders (sim-extracted): `resultsIcon(kind, size)` (stroke icon set —
chart/down/up/flask/scope/person/camera/info/x, createElementNS only),
`resultsApplyCopy` (whitelist `['rp','ma','vsb','mi','mp','mu']`, called
FIRST in resultsBuildSection so refetched cards share the merged
`conf.str`; codes are proxy-only → `pfStrRaw` reads, the v8.22
convention), `resultsValidMeasurements` (per-row fail-closed: label +
dir + 1..500 int pct required, ≤6), `resultsClinical(item, s)` (the
panel), `resultsAttr(item)` (name strong + ", role" span; role without a
name never renders).

Card order: media → clinical panel → badges → meta → quote → attribution.
The After frame's pill carries `cx-results__tag--after` (green). The lab
badge gains a flask icon (`cx-results__badge-ic`).

Clinical panel (`cx-results__clin*`, shared card + lightbox DOM, lightbox
restyled via `.cx-lightbox` context selectors): head (chart icon +
`ma`-with-weeks + `vsb`, flex-wrap so the baseline tag drops to its own
right-aligned row in narrow cards; title only when `weeks > 0`), tile grid
(`auto-fit minmax(70px,1fr)` → 3-across on phones; label, green Georgia
percent with arrow, `--down`/`--up` modifiers), ONE shared note line
per panel fed by the ⓘ toggles (aria-expanded sync, aria-live polite,
re-tap collapses), then the trust-mark row (icons + labels, hairline
separators, only CHECKED marks with present labels). Panel renders only
for lab entries with rows or labeled marks; every chrome string fails
soft (missing proxy copy → numbers still render, header/marks skipped).

Lightbox: close button = white 40px circle, hairline + shadow, drawn X
(`resultsIcon('x', 16)`), `position: sticky` with the negative-margin
flow collapse so it pins while the card scrolls (THE visibility fix —
the old borderless text × vanished over photos). Captions under the
figures (letterspaced). Panel after the badges. NEW `cx-lightbox__foot`:
quote (italic) + attribution start-side, the meta microline end-side;
with neither quote nor attribution the meta renders alone (no wrapper).

Banner: system-stack 700 `clamp(21px, 3.4vw, 27px)`; count = Georgia
serif `#1b6a4d` on a `#d8ecdf` bottom-gradient highlight. Tagline
`cx-results__tagline` (uppercase letterspaced, hidden under `--ultra`).
Greens: ink `#1b6a4d`, panel `#e9f3ee`, pill `#d8ecdf`; the lab pill is
soft blue `#e1ecf9`/`#274a70` (brand blue stays on badges). `:lang(ar)`
zeroes the new letterspaced chrome. Ultra density compresses the panel
(pure CSS, same DOM — the density rule).

## 5. Admin (app.proof.results.tsx + components/ProofForms.tsx)

ResultForm gains Attribution name/role fields (always) and, when source
is "Lab / clinical", the Clinical measurements card: rows (label /
direction Select / percent / info note) with move-up/down + remove, Add ≤
`MAX_MEASUREMENT_ROWS = 6` (server mirror), the three trust-mark
checkboxes with the "only if true for THIS entry" copy, and client
validation mirroring the server (labels required, pct 1–500, duration
required once rows exist — the save button gates on all of it). List rows
append "· N metrics". `formToPayload` drops fully-empty rows and numbers
`pct`; everything else reaches `saveResult` verbatim.

## 6. Proof inventory

- `sims/proof-gallery.cjs`: fixtures `CLIN_COPY`/`STR_CLIN`/`RES_LAB`;
  cases R19 (full clinical card incl. order, modifiers, textContent
  pins), R20 (lab gates ×2 incl. the DIRECT second-defense call,
  fail-soft chrome, weekless header, row validation + cap), R21 (info
  toggle), R22 (copy whitelist + malformed payloads), R23 (tagline +
  copy-merge feeds card builds), R24 (lightbox close/panel/foot);
  mutants m32–m36 (two lab gates, whitelist, pct cap, attribution
  innerHTML sink). Extraction list += the five new builders +
  RESULTS_ICON_PATHS.
- `sims/proof-server.ts`: seed defaults += the six columns; PR4 pin →
  eighteen fields; SR1–SR4 (save round-trip, customer-flip clearing,
  drifted-row serve belt, every validation error); UC1–UC5 (the
  results-ui-copy table, loaded REAL via direct import); mutants m6
  (serve belt), m7 (duration requirement).
- `sims/proof-translation.ts`: T7b (measurementSourceFields pairs +
  positional indices, 14-field allowlist, translate run stores
  m0l/m0i/attributionRole rows — never attributionName, serve overlay,
  manual save accepts m0l / rejects m6l); mutant m0 (measurement sources
  dropped).
- harness v25 block: schema columns ×2 files, migration, caps, serve
  belt, save clearing, translation allowlist line, proxy copy emission +
  overlay sources, ui-copy byte floor, JS whitelist/raw-reads/gates/
  close-icon, CSS sticky-white-shadowed close + new class family, admin
  cap mirror + reviewer fields. The v8.11 allowlist pin moved with the
  documented v25 field growth.
- prover: v25 allowlist entry for `assets/cellexia-proof.js` (CSS is
  outside baseline scope).

## 7. Byte meters (at ship)

Liquid TOTAL 98,422 / 99,500 (UNTOUCHED — zero Liquid bytes). Locale
files: untouched by v25 itself; v25.1 rewords the two banner keys in all
18 files (below) — el 15,069 / ar 15,124 against the 15,200 pin.
cellexia-proof.js ~104KB, cellexia-booster.css ~165KB (no caps). Suite
9,941 checks green; tsc + build green; fresh-SQLite `migrate deploy`
green.

## 8. Out of scope (deliberate) + v25.1

- v25.1 (2026-09-18, same day — merchant chose the mock's wording):
  `results.banner_verified` -> "See results from {{ count }} real
  Cellexia users." and `banner_all` -> "… {{ count }} Cellexia users.",
  reworded natively in ALL 18 locale files (register preserved per file:
  fr vous "vrais utilisateurs", de Sie "echten Cellexia-Anwendern", es tú
  "usuarios reales", pt-PT "utilizadores", ja "実際のユーザー{{ count }}名",
  fi numeral-genitive "aidon Cellexia-käyttäjän", pl/hu informal, el "Δες
  … αληθινούς χρήστες", ar "من مستخدمي Cellexia الحقيقيين"). ro's banner
  pair ALSO lost its em dashes ("— {{ count }} în total" -> ": {{ count }}
  în total" — the no-em-dash rule; the colon keeps the count-trailing
  structure that dodges Romanian's "de"-after-20 numeral agreement, since
  these keys have no CLDR forms). Bytes: el 15,069 (-10) / ar 15,124 (+8),
  both under the 15,200 pin; the {{ count }} harness pin holds. Sim
  fixture strings + R8/R9/U/C banner asserts updated; the admin
  verified-checkbox helpText now quotes the new banner.
- v26.2 (2026-09-19, merchant ask): decimal percentages — see the §1
  caps paragraph. Proofed by proof-gallery R19/R20/R21b + mutants
  m35 (re-anchored)/m37, proof-server SR1/SR4, and the harness v26.2
  wiring pin.
- The endorsements overlay's own × (a different control) keeps its look.
- No merchant editing of the six chrome strings (fixed curated table; the
  v8.22 settings+DeepL machinery can be added later if asked).
