# SPEC v28 — "Rated #1" award strip

**Settings piece** `buyBoxProof.award` · **gate id** `ba` · **admin page**
`/app/features/proof-block` ("Award strip" card) · **CSS prefix**
`cx-bbp-award` · **marker** `data-cx-feature="buy_box_proof"` (the block's) ·
built 2026-09-19.

The merchant's reference mock: a compact endorsement card — the navy rank
medallion ("#1"), "Rated #1 of 100+ wrinkle treatments" over "in independent
lab testing", the red-over-yellow colour bar beside the publication name
("Verbraucher Berichte"), and the year, four cells behind three vertical
rules on ONE row at every width. It is the THIRD piece of the v19 buy-box
proof block and the third v22 parameter-gate target.

## 1. Placement and order

A sibling card inserted directly after `.pdp__grey`, ALWAYS ahead of the
research band:

```
.pdp__grey  →  .cx-bbp-award  →  .cx-bbp-research  →  .pdp__accordions
```

`mountBbp` builds the research band first and the strip second; both insert
with `insertAfter(node, grey)`, so the later insert lands nearer the panel.
The order is sim-pinned (buy-box-proof AW3 + mutant m9) and harness-pinned.

## 2. One toggle, one gate, off by default

`award.enabled` is a STRICT default-OFF boolean (the v21 convention, `===
true` on both sides), so a pre-v28 metafield — which has no `award` key at
all — paints nothing. The piece renders only while the buy_box_proof feature
itself is effective (master flag or Preview-Center draft flag, market scope
included), exactly like the research band.

`award.gate` points at the new v22 gate target `ba` ("Proof block — award
strip"). Everything in SPEC-v22 applies unchanged: minted `param=token`
pair, digests-only metafield, 90-day unlock, `?param=off` escape hatch,
fail-closed dangling references, and **PREVIEW always renders the gated
piece** so the merchant can check the design before buying traffic.
`bbpGateMeta` gained the third argument; a painted gated strip tags the
block's one impression with `ba` (Analytics → "Tagged-link pieces").

## 3. Data model

```ts
award: {
  enabled: boolean;   // strict default-OFF
  gate: string;       // "" | "ba"
  rank: number;       // 1..99        (AWARD_RANK_MIN/MAX)
  count: number;      // 20..9999     (AWARD_COUNT_MIN/MAX)
  category: string;   // AWARD_CATEGORY_KEYS
  publication: string;// free text, required at render time
  imageUrl: string;   // optional https logo (Shopify Files)
  year: number;       // 2000..2100   (AWARD_YEAR_MIN/MAX)
}
```

The section rides the EXISTING whole-section island member
(`"c": {{ cfg.buyBoxProof | json }}`), so **pdp-booster.liquid is untouched
and the Liquid budget does not move** (still 99,430 / 99,500 B —
harness-pinned that the file does not even contain the word "award").

`count`'s floor is 20 on purpose: the curated templates are written for the
round-figure register (Romanian requires "de" after 19 — "peste 100 de
tratamente"; Polish takes the genitive after round numerals), and a "#1 of
fewer than 20" claim is not a strip worth showing.

## 4. Copy — curated in 18 locales, zero locale-file bytes

`CX_BBP_AWARD` in `cellexia-pdp.js` (the v26 `CX_QSEL_STR` convention; the
el/ar 15,200 B locale wall is untouched). Per locale: `l1` (the headline
template, placeholders `{r}` rank / `{n}` count / `{c}` category), `l2`
(the method line), `b` (the medallion's short form — "#1", "Nr.1", "1.",
"1位"), and `c` (the ten category nouns).

Grammar rules the curation encodes — the v27 CX_QSEL_UNITS lesson (case
tables are grammar; DeepL or merchant free text cannot be right here):

* each locale's category noun is stored ALREADY INFLECTED for that locale's
  own template: German dative after "von" ("von über 100
  Hautpflegeprodukten"), Polish genitive plural ("wśród ponad 100 kremów
  przeciwzmarszczkowych"), Finnish genitive singular before "joukossa"
  ("yli 100 ryppyhoidon joukossa"), Arabic singular after a round hundred,
  Japanese with the category FIRST ("シワケア製品100種類以上の中で第1位");
* French avoids the participle ("N°1 sur plus de…") so no gender agreement
  with the product is ever wrong;
* Greek uses invariable "πάνω από" so the quantifier never has to agree
  with the category's gender;
* rank medallions use each locale's native short ordinal form; forms longer
  than three characters take the `--wide` modifier (smaller type) instead
  of overflowing the circle;
* `nb`/`no` are byte-twins; no string anywhere carries an em or en dash
  ([[no-em-dashes-native-copy]] — harness-enforced for this table).

The catalog (`AWARD_CATEGORY_KEYS`, closed, two-way harness-pinned against
the table AND the admin Select): `wrinkle`, `cellulite`, `antiaging`,
`firming`, `darkspot`, `serum`, `eye`, `lip`, `hair`, `skincare` — chosen
against the live Cellexia catalog (wrinkle fillers/creams, anti-cellulite,
jawline/neck tightening, dark-spot corrector, glow serum, eye serum, lip
formula, hair serum). Adding a category is a code change that lands with
its 18 translations.

The publication name is merchant free text and stays as written in every
language (a proper noun — the US_STATE_NAMES / institution-name precedent);
the year renders in Western digits everywhere (the RESULTS_COMMA_DECIMAL
precedent keeps digits Western).

## 5. Fail-closed rules

No island member / pre-v28 mirror (no `award` key) / `enabled !== true` →
nothing. Locked gate → nothing (and `"g:"` control-arm meta). Blank
publication → nothing (no named source, no claim). Unknown category key →
nothing (never half a sentence). Non-positive or non-numeric rank/count →
nothing. A missing year drops the year line alone. A malformed logo URL is
sanitized away server-side and the wordmark renders instead.

## 6. Layout — the reference lockup, exactly

The merchant's mock, replicated element for element (their explicit
instruction after the first draft: "replicate it exactly", including "the
little color strip"):

* white card, 14px radius, 1.5px `#e4e7ee` border;
* navy `#24344f` rank medallion (44px at scale 1), then a vertical rule, then the navy `#223a64` headline over the muted
  `#8590a2` method line, then a rule, then the publication lockup, then a
  rule, then the `#959daa` year — four cells, three rules;
* **the publication lockup carries the reference's red-over-yellow colour
  bar** (6px, `#e63229` over `#f6c500` at a 58/42 split, stretching to the
  wordmark's height) as BUILT-IN artwork beside the bold `#1e2a44` name —
  the bbpBuiltInSeal precedent. An uploaded `imageUrl` replaces the WHOLE
  lockup, bar included (a real logo brings its own device);
* the wordmark is `width: min-content`, so a multi-word name stacks at
  its longest word — exactly the mock's "Verbraucher / Berichte".

**ONE ROW AT EVERY WIDTH** (the merchant's second correction: "it has to
all hold in one line even on mobile … pixel by pixel"). Every metric in
the stylesheet is authored as `calc(var(--cxaw, 1) * Npx)` and every text
cell is `white-space: nowrap`, so the strip has ONE degree of freedom:
`bbpAwardFit` resets the inline `--cxaw` custom property to 1 (the v21
`--cx-spo` inline-custom-prop precedent), reads the root's natural
nowrap `scrollWidth`, and sets `--cxaw = clientWidth / (need × 1.02)`,
clamped to [0.4, 1] — the whole design scales down proportionally, the
reference photographed smaller, never a reflowed variant. The 2% slack
absorbs subpixel font rounding; the 0.4 floor sits below the longest
translation's requirement on a 320px phone (Polish ≈ 0.41), so it only
binds for pathological containers, where the card clips (`overflow:
hidden`) instead of scrolling the page. Hairline rules and the card
border stay unscaled (sub-pixel strokes disappear). Refit runs at mount
(same task as insertion — no flash), on `resize`, on `load`, and once
800ms after mount, because the theme's webfont swap changes text metrics
(the v20 ibApply re-measure pattern). The text column alone carries
`flex-grow`, so the surplus at large widths becomes the mock's elastic
gap before the lockup; its `min-width` stays `auto` so `scrollWidth` is
the honest one-line width. Logical properties keep RTL (ar) correct with
no extra rules. Audit: 18 locales × {360px, 300px} iframes — zero
horizontal overflow, one headline line everywhere, strip height 31-45px.

## 7. Admin

The "Award strip" card sits between "Guarantee and rating" and "Research
band" (the storefront order). Rank / products tested / year as bounded
number fields (the server clamps; the form flags out-of-range input where
the merchant can still see it), the category Select, publication name +
optional logo URL with the storefront-size preview (the institution-row
pattern), a claim-honesty warning banner, a live English wording preview
(`AWARD_EN_L1/L2` — harness-pinned twins of the table's `en` entry), and
the shared `ParamGateCard` for gate `ba`.

## 8. Budgets paid, not moved

* **Liquid** 99,430 / 99,500 B — UNTOUCHED (zero bytes; the config rides
  the existing whole-section member).
* **Locales** el/ar walls untouched (zero locale-file bytes; all copy in
  the JS asset).
* **FeatureKeys** 43 → 43 (`award` is a piece of `buy_box_proof`, the
  research/seal precedent).
* **GATE_TARGETS** 2 → 3 — the documented spec update the v22 harness pin
  demanded; the pin now reads "a fourth needs a spec update".

## 9. Validation

* `sims/buy-box-proof.cjs` — AW1-AW9 (default-off, mock composition incl.
  the colour-bar lockup and its logo replacement, order under the panel,
  fail-closed legs, logo/alt, standalone strip, Japanese composition,
  medallion width modifier, year drop) + mutants m8 (strict default
  lost), m9 (order flipped), m10 (category fallback open). 114 checks /
  10 mutants.
* `sims/param-gates.cjs` — R12-R17 (ungated/locked/unlocked/preview/
  dangling/all-three-sorted meta) + mutant m7 (award guard dropped). 113
  checks / 7 mutants.
* `validation/harness.mjs` v28 block — strict default pins on both sides,
  verbatim DEFAULT_SETTINGS, gate guard + meta wiring, mount order, table
  parses as strict JSON with exactly the 18 shipped locales, nb/no twins,
  two-way category catalog (server ↔ table ↔ admin Select), dash-free
  copy, placeholder presence, admin EN-preview twins, ParamGateCard + `ba`
  patch wiring, and pdp-booster.liquid untouched.
