# SPEC v24 — Clinical study "published research" redesign

Merchant ask (2026-09-17, with a reference screenshot): make the PDP clinical
study widget look exactly like the reference — eyebrow "PUBLISHED CLINICAL
RESEARCH", a "Finished-product clinical study" line, a huge uppercase
protocol headline ("RANDOMIZED · DOUBLE-BLIND · PLACEBO-CONTROLLED"), two
gray credibility lines (conducted-by, published-in), ONE tinted stat panel
(giant numeral | hairline divider | bold label + gray "Measured by 3D skin
imaging" line), three white fact pills ("478 participants", "12-week study",
"Instrumentally measured") and a small footnote — with **every line of text
editable per product**. Approved variant: **zero new assets** (system font
stack at heavy weights; no bundled webfont).

Non-negotiables inherited from the codebase:

- ZERO new locale keys — `el.json`/`ar.json` sit at Shopify's per-file byte
  cap. All new text is per-product merchant text on the existing
  `cellexia_clinical_study` metaobject; blank fields fall back to existing
  keys or simply don't render.
- The widget stays the single `studyBuildSection` builder fed by the
  `#cx-study-config` island; live/preview gates, `data-cx-feature` marker,
  compact (`cm: 1`) pure-CSS recomposition and the C6 "identical DOM"
  contract all survive.

## 1. Metaobject definition (MIGRATION)

`cellexia_clinical_study` gains three optional single-line fields:

| key           | label            | renders as                                     |
| ------------- | ---------------- | ---------------------------------------------- |
| `eyebrow`     | Eyebrow          | top letterspaced line (blank = `study.eyebrow` locale default) |
| `publication` | Publication line | second gray credibility line (blank = hidden)  |
| `badge`       | Extra fact pill  | third pill after participants/duration (blank = 2 pills) |

Create branch carries them for new shops; existing shops are backfilled by
the `ensureDefinitionFields` migration block (the v7 `subject` pattern —
idempotent, runs from `ensurePdpDefinitions` in the products loaders).
`saveClinicalStudy` writes the three keys unconditionally, so a stale admin
tab loaded BEFORE the server deploy can fail its first save with a Shopify
"field not defined" error — reload the page (the loader migrates), save
again.

Repurposed (storage unchanged, meaning sharpened):

- `title` → the HEADLINE (rendered uppercase/huge; merchants write protocol
  descriptors with `·` separators).
- `concern` → the conducted-by line (full sentence; the university/lab name
  lives inside it).
- `instruments` → the measurement-method line INSIDE the stat panel,
  rendered verbatim (the `study.instruments` "Measured with {methods}"
  composition is retired; the key stays in the locale files, unused).
- `lab_name` → RETIRED FROM DISPLAY. Still defined, still saved (the admin
  form holds it in state and passes it through untouched so nothing is
  wiped), no longer rendered, no longer editable in the form.

## 2. Island contract (#cx-study-config)

New conditional members, each emitted only when non-blank and riding the
`cx_name_token` replace: `"e"` (eyebrow), `"j"` (publication), `"b"`
(badge). `"pi"` now carries the RAW instruments value. The `cx_study_lab`
assign and the `"pl"` member are deleted. Name-token replace count in
pdp-booster.liquid: 14 → 16 (harness pin updated: -1 lab, +3 new).

## 3. Builder DOM (cellexia-pdp.js, studyBuildSection)

```
section.cx-proof.cx-study[.cx-study--compact]  [data-cx-feature=clinical_study]
  p.cx-proof__eyebrow.eyebrow.eyebrow--sm   ← data.e || str.eyebrow
  p.cx-study__subject                       ← data.sub || str.sub (unchanged)
  h2.cx-study__heading                      ← data.t  (theme heading--two class DROPPED)
  p.cx-study__concern                       ← data.c
  p.cx-study__journal                       ← data.j  (NEW, only when set)
  div.cx-study__hero                        ← results[0] (the stat panel)
    span.cx-study__hero-value ( + span.cx-study__hero-suffix )
    div.cx-study__hero-body                 ← NEW; built ONLY when label or method
      span.cx-study__hero-label             ←   exists (its border is the divider —
      p.cx-study__hero-method  ← data.pi    ←   never an orphan line)
  ul.cx-study__grid > li.cx-study__stat…    ← results[1..] (unchanged shape)
  ul.cx-study__facts > li.cx-study__fact…   ← str.fn (pn-gated), data.pw, data.b
  p.cx-study__method > a.cx-proof__link     ← data.u (unchanged)
  p.cx-study__footnote                      ← data.f || str.foot (unchanged)
```

## 4. CSS (cellexia-booster.css)

- Blue accent card retired (`border-inline-start` + padding, incl. the
  640px override). Base rule anchor is now `.cx-study {\n  color: #1d1d1b`
  (harness v6.11 pin updated); the pinned 680px desktop centered-measure
  rule is byte-identical.
- Zero-new-assets type: headline + numerals use
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
  Arial, sans-serif` at 900/800. Headline `clamp(24px, 4.6vw, 34px)`
  uppercase; hero numeral `clamp(48px, 9vw, 72px)`; suffix 0.45em.
- Panel `#f4f4f2`, radius 12px; divider = `border-inline-start` on
  `.cx-study__hero-body` (RTL-safe); pills white with the house `#e5e5e3`
  hairline, radius 999px.
- `:lang(ar)` zeroes the eyebrow/headline letter-spacing (joining script —
  the survey designs' review catch).
- Both study lists now carry their own `list-style: none` (the v8 survey
  lesson: never depend on the theme's `list-reset` utility).
- Compact modifier restyled for the same DOM (30px numeral, tight panel,
  wrapping mini-panel row, small pills).

## 5. Admin (app.products.$id.tsx) + server plumbing

- Form reordered to mirror the widget top-to-bottom; new fields Eyebrow /
  Published in (line 2) / Extra fact pill; relabels Headline, Conducted by
  (line 1), Measurement method; Lab name field removed (state passthrough
  keeps the stored value). Results explainer reworded (first result = the
  big panel).
- `pdp-content.server.ts`: `ClinicalStudyView/Input`, `CleanClinicalStudy`,
  `validateClinicalStudy` (SINGLE_LINE_MAX cleanText) and `parentFields`
  gain `eyebrow`/`publication`/`badge`.
- `translation.server.ts`: the three keys join `TRANSLATABLE_FIELD_KEYS`
  (per-product DeepL run picks them up like title/concern/subject).

## 6. Proof inventory

- `sims/survey-methodology.cjs`: T2/T3/T5 pills rewritten (participants ·
  duration · badge), T4 kept, NEW T6 (eyebrow override + fallback), T7
  (publication line presence), T8 (hero-body column, RAW method, no
  instruments pill, no orphan divider, bare-numeral survival), C6 fixture
  refreshed with the v24 members. Mutants m13 (eyebrow override ignored),
  m14 (badge pill dropped), m15 (hero-body always built).
- Harness: replace-count pin 14 → 16; instruments site pin now the raw
  emission; v6.11 base anchor pin updated. Everything else (island id,
  PROOF_ORDER slot, `cx-study--compact` token, "sub"/"pn" members) is
  untouched and still green.
- Prover: v24 allowlist entries for `pdp-booster.liquid` +
  `cellexia-pdp.js` (CSS is outside baseline scope).

## 7. Byte meters (at ship)

- pdp-booster.liquid 27,628 B (+213); TOTAL Liquid 98,422 / 99,500.
- Locale files untouched.

## 8. Merchant content migration (once, after deploy)

Per product with a study: rewrite Headline as protocol descriptors, fill
Eyebrow / Published in / Extra fact pill, fold the lab into the
Conducted-by line, reword Measurement method as a full line ("Measured by
3D skin imaging"). Old content renders fine untouched — just in the new
clothes.
