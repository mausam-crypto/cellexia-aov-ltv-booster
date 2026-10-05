# SPEC v34 — Study presets for the results gallery (batch entry)

**DB** `ResultPreset` (shop, name, payload JSON) · **admin**
/app/proof/results (picker in Add result, "Save as study preset" in the
form, Study presets card) · **storefront** NONE — zero Liquid, zero locale,
zero proxy, zero JS · built 2026-09-25.

Merchant ask (2026-09-25): "we're going to add lots of before/afters from
different studies … create some presets for a clinical study which
pre-selects that it's a study, pre-fills the dermatologist name, title and
quote + the measurement timeline (weeks) and the various measurement types
and notes … if a preset is selected all that has to be done is simply enter
the before/after and the numbers of each measurement."

Read `docs/SPEC-v33-results-slider.md` and `docs/SPEC-v25-results-redesign.md`
first — presets are pure admin convenience ON TOP of that contract; nothing
in the serve path changes.

## 1. Data model

`ResultPreset { id cuid, shop, name, payload String @default("{}"),
createdAt, updatedAt, @@index([shop, name]) }` in BOTH schema files +
sqlite migration `20260925090000_v34_result_presets` (Postgres = `db push`,
UPDATE.md §2).

`payload` is one JSON blob of the per-STUDY constants:
`{testimonial, attributionName, attributionRole, durationWeeks,
measurements: [{label, dir, info?}], markInstrument, markSamePatient,
markUnretouched}`. Two deliberate absences: `source` (a preset IS lab —
applying one sets the form's Source to "Lab / clinical") and the
measurement PERCENTS (they are the per-entry numbers; a pct sent to
`saveResultPreset` is dropped by `cleanPresetMeasurements`, harness-pinned).
Facets (age/skin/concern/country), product tags, photos, verified and
status stay per-entry and are never stored or touched.

## 2. Server (proof.server.ts)

- `MAX_RESULT_PRESETS = 50`, `PRESET_NAME_MAX = 80`.
- `assertPresetModel()` — the v8 old-client guard pattern for the new model.
- Strict at save: `saveResultPreset` cleans name/quote/attribution/weeks
  (the saveResult rules) + `cleanPresetMeasurements` (label + dir required,
  info optional, ≤6 rows, NO pct — every problem is a reported error).
  SAME-NAME UPSERT: re-saving "Study X" refreshes that preset in place
  (mutant-pinned) — the cap only gates NEW names.
- Tolerant at read: `parseResultPresetFields` degrades corrupt payloads to
  empty fields, never throws. `listResultPresets` orders by name, takes ≤50.
- `deleteResultPreset` is shop-scoped (`findFirst {id, shop}`,
  mutant-pinned list scope too).
- Presets never serve: an entry built from one still passes `saveResult`'s
  FULL validation (percents required with duration, lab gates, the works).

## 3. Admin (app.proof.results.tsx + ProofForms.tsx)

- **Add form picker** — "Start from a study preset" Select (rendered only
  when presets exist, ADD form only: the edit form deliberately has no
  picker, an accidental apply would overwrite curated text). Applying sets
  Source to lab and fills the constants; measurement rows arrive with
  `pct: ""` so the existing per-row validation gates the save until every
  number is typed. Photos, product tags, facets and status are PRESERVED —
  a late apply never discards an upload (the v33.1 lesson applied).
- **"Save as study preset"** — inside the form whenever Source is
  Lab / clinical (BOTH add and edit: an existing filled entry is the
  natural authoring path). Plain-button disclosure → name field + Save;
  the route's `submitSavePreset` strips percents and posts
  `save_result_preset`. Help text states the same-name-updates rule.
- **Study presets card** — always rendered (discoverability: the empty
  state TEACHES the mint path instead of hiding the feature); rows show
  name + "attribution · N weeks · N measurements" + the house two-click
  delete. Own `presetFetcher` (the v8.11b isolation rule) with toasts.
- Route action: `save_result_preset` (JSON payload, field-coerced like
  save_item) + `delete_result_preset` (id). `ResultPresetOption` is the
  CLIENT twin type in ProofForms (`.server` types never reach the bundle).

## 4. Proof inventory

- `sims/proof-server.ts`: stub gains the `resultPreset` model; PS1 (save
  round-trip, trims, pct dropped), PS2 (same-name upsert, single row),
  PS3 (name/label/dir/cap/weeks errors), PS4 (shop scoping both ways +
  delete), PS5 (cap at 50, upsert still allowed at cap), PS6 (tolerant
  parse of corrupt payloads); mutants m11 (list shop scope), m12 (upsert
  dropped). 549 checks.
- harness v34 block: schema ×2 + migration, cap/guard/cleaner pins, the
  pct-free-cleaner NEGATIVE pin (the cleaner's body must not mention pct),
  route intents + loader list, picker/save-button strings, the `pct: ""`
  apply line. Suite after v34: 36 suites / 11,961 checks + tsc + build.

## 5. Out of scope (deliberate)

- No per-preset product tags, facets or concern — those vary per entry
  (subject) more than per study; easy to add to the payload later.
- No preset rename UI (delete + re-save, or re-save under the new name).
- No translation impact: presets are admin-side; entry text translates as
  before once the ENTRY is saved.
