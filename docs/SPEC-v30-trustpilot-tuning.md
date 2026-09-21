# SPEC v30 — Trustpilot presentation tuning (checkout star color + PDP row size + star rounding + cart row completion)

Two merchant-facing display options plus two merchant-requested rendering
corrections. The OPTIONS (§1 checkout star color, §2 PDP row size) are
**LIVE settings** (the v6.5 placement precedent: no draft flags, no
Preview Center plumbing — they only restyle rows that are already visible)
defaulting to the exact pre-v30 render, so they change nothing until
edited in the admin. The CORRECTIONS ship ON (the v16.1 direct-change
precedent): the ROUNDING RULE (§3, v30.1 — "if it's 4.8/5, all 5 stars
should be full just like on trustpilot") fills the fifth star completely
wherever a 4.8 previously drew an 80% partial, and the CART ROW COMPLETION
(§2b, v30.2 — "it doesn't show number of reviews and doesn't say
trustpilot") adds the count + wordmark to the cart drawer's Trustpilot
cell on deploy.

## 1. Checkout trust module — Trustpilot star color

**Setting:** `checkoutTrust.trustpilotStars: "accent" | "green"` (default
`"accent"`).

- `"accent"` — the pre-v30 render: filled stars carry the checkout theme's
  accent color (blue on this store). Byte-identical output.
- `"green"` — filled stars switch to the `success` appearance token, the
  closest a checkout UI extension can get to Trustpilot's own star green
  (#00b67a). Unfilled stars stay `subdued` either way.

**Why not exact #00b67a:** checkout UI extensions may only use the theme's
NAMED appearance colors (`Appearance` union in @shopify/ui-extensions
2025.7) — arbitrary hex does not exist there, `Image` rejects `data:` URIs,
and extensions cannot bundle static assets, so an exact-brand SVG would have
to be hotlinked from an external host at checkout render time. This module's
header invariant is "no network calls"; a paint-time dependency on an
outside server in the money flow is not worth a color shade. The exact
shade of `"green"` therefore follows the store's checkout-branding success
color (green by default; tunable store-wide via the checkoutBranding API if
the merchant ever wants it to be #00b67a precisely). The admin copy says
all of this plainly.

**Enforcement (closed enum, twice):**
- sanitize (`settings.server.ts`): `=== "green" ? "green" : "accent"` — a
  pre-v30 blob, junk, or case variants all persist `"accent"`.
- `resolveConfig` (`trust-logic.ts`): same strict comparison against the
  RAW metafield, so even a hand-edited metafield cannot smuggle a third
  value into the render. Sim: `checkout-trust.ts` T2 checks + T5 anchors +
  mutant `m12-starcolor-loose`.

**Render (`Checkout.tsx`):** `starAppearance = trustpilotStars === 'green'
? 'success' : 'accent'`, used ONLY in the filled branch of the star Icons.

**Admin:** Checkout page → trust-module card → "Trustpilot line — star
color" ChoiceList. No color swatch preview on purpose: the true shades come
from the store's checkout branding, and an approximated swatch would lie.
The helpText sends the merchant to the checkout editor to see the truth.

## 2. PDP Trustpilot row — size (the SHARED `trustpilot.scale`)

**Location correction (merchant catch):** the first cut of this option
lived on the Buy-box proof page as `buyBoxProof.ratingScale` — the WRONG
surface: this store shows the Trustpilot line through the standalone
`trustpilot` feature (the strip `pdpTrustpilotBuildNode` chains inside
`.pdp__grey`, configured on Trust & badges → Trustpilot) and keeps the
proof block OFF. The setting is now **`trustpilot.scale`** (whole percent,
clamped `TRUSTPILOT_SCALE_MIN`=100 … `TRUSTPILOT_SCALE_MAX`=200, default
100), and it scales BOTH PDP Trustpilot rows from one control: the strip
and — if ever enabled — the proof block's rating row. `ratingScale` is
gone (it never shipped; no migration needed).

**Data path:** the shared `tp` island member in `pdp-booster.liquid`
carries `"s"` **only when** the value is above 100
(`{%- if cfg.trustpilot.scale > 100 -%},"s":{{ cfg.trustpilot.scale |
times: 1 }}{%- endif -%}` — the `times: 1` is the deploy-safety
bare-output rule). 100 = no member = byte-identical island. Both
consumers pass the member through ONE helper, `cxTpScale(node, tp)`
(cellexia-pdp.js): finite AND >100, capped at 200, writes
`style="--cxtp:<factor>"` — junk, 100, below, and every pre-v30 mirror
leave the attribute off entirely. Old JS ignores `s`; new JS without it
renders identically: the deploy gap is safe in both directions.

**Mechanism (the v28 award-strip technique):** every metric of BOTH rows
is authored in `cellexia-booster.css` as `calc(var(--cxtp, 1) * Npx)`:

| Row | Metrics ×factor |
| --- | --- |
| Strip `.cx-trustpilot--pdp` | root gap 8/16, main gap 8, stars 16 (+2 gap), rating 13, count 11, wordmark 13 (+3 gap, 14 star), link 11 |
| Proof-block `.cx-bbp__rating` | row gap 6/10, stars 17 (+2 gap), score 15, count 13, wordmark 14 (+4 gap, 15 star); ≤400px: 6 / 14 / 11 / 12 |

Margins/paddings stay FIXED (page rhythm, not row size). Verified in a
real browser against the shipped stylesheet: at the default every metric
computes to exactly the old pixel value; at ×1.4 all of them scale to the
decimal. Additionally, an ENLARGED strip wraps whole pieces on narrow
phones instead of squeezing the count mid-phrase or clipping the wordmark
— via `.cx-trustpilot--pdp[style*="--cxtp"]` rules that match ONLY rows
`cxTpScale` stamped, so the default keeps today's exact layout.

Note `cx-stars__star` left the harness's annotated inherit list with this
change: it now carries scoped calc-sizing rules (strip + bbp). Everywhere
else it is still sized by its width/height attributes.

**Bytes:** +~90 B in pdp-booster.liquid (the `s` conditional); zero locale
file changes (el/ar walls untouched).

**Admin:** Trust & badges page → Trustpilot card → "Size on the product
page" RangeSlider (step 5) + `TrustpilotStripMock`, a to-scale preview
drawn with the STRIP's pixel formulas, the storefront's star artwork and
colors, the v30.1 half-star display rounding, and the live
rating/review-count/showLink state — typeface aside, what the merchant
sees is what ships. The proof-block page carries no size control (its
Rating-row helpText points here).

**Sims:** `buy-box-proof.cjs` D14 (tp.s: absent / 100 / below / junk →
attribute-free; 130 → `--cxtp:1.3`; 999 → capped `--cxtp:2`) + D16 (the
strip consumes the SAME `s` through the SAME helper; its content carries
count + wordmark) + mutants `m14-tpscale-writes-at-100`,
`m15-tpscale-uncapped`; harness v30 block pins the island emission
and the slider's admin home.

## 2b. Cart trust row — review count + Trustpilot wordmark (v30.2, ships ON)

The cart drawer's trust row (`cart_trust_row`, JS-built `trustRowBuildNode`
in cellexia-cart.js) showed ONLY stars + "4.8/5" in its Trustpilot cell —
no review count, no platform name (the merchant reported it). The cell now
mirrors the other surfaces: stars, score, the localized count-baked
"4,478 reviews on" (`tpr.cnt`, composed server-side from
`trustpilot.reviews_count` — an EXISTING key in all 18 locales, zero
locale bytes) and a bold ★Trustpilot wordmark (`cx-trust-row__brand`, the
green star via a new cart `cxStarIcon` twin — the harness static-svg
innerHTML count moved 1→2 for CART_JS). A deploy-gap mirror without `cnt`
just skips that span. The cell (`cx-trust-row__item--tp`) may wrap
INTERNALLY on narrow phones — whole pieces only, centered.

**Byte diet (cart-booster.liquid sits on its 23,600 cap):** the single-use
`tp_rating_rounded` and `tp_url` assigns were inlined into the `tpr`
emission, the url DEFAULT was dropped (sanitize guarantees `profileUrl`;
the cart builder gained the same `\S` url guard the PDP twins carry), and
`tp_count` + `"cnt"` were added → **23,595/23,600** (5 B spare — the file
is BACK ON the wall; diet before any future member).

Ships ON (the v16.1 direct-change precedent — the merchant asked for the
missing content, not an option): deploying adds the count + wordmark to
the live cart row.

## 3. Star display rounding — Trustpilot's own rule (v30.1, ships ON)

Trustpilot renders its star IMAGE rounded to the **nearest half star**
(TrustScore 4.8 → five full stars; 4.3 → four and a half) while the score
text stays raw. The merchant asked for exactly that ("if it's 4.8/5, all 5
stars should be full just like on trustpilot"), so every place this app
draws Trustpilot stars now snaps the FILL — never the label or aria — the
same way:

| Renderer | Snap |
| --- | --- |
| `snippets/cx-trustpilot-stars.liquid` (standalone strip, server render) | `times: 2 \| round \| divided_by: 2.0` AFTER `cx_rating_label` is taken (aria keeps the raw score) |
| `cxStarsSvgs` in `cellexia-pdp.js` (PDP strip + buy-box rating row) | `r = Math.round(r * 2) / 2` after the clamps — byte-identical twin lines |
| `cxStarsSvgs` in `cellexia-cart.js` (cart trust row) | same twin line |
| checkout (`trust-logic.ts` → `Checkout.tsx`) | NEW pure `trustStarShapes(rating)` → `full \| half \| empty` ×5; halves drawn with the `starHalf` icon, full/half take the v30 star color, empty stays subdued. Replaces the old `Math.round` whole-star fill |
| admin `TrustpilotStripMock` (Trust & badges page) | same snap, so the slider preview matches the storefront |

Consequences at the LIVE 4.8 rating: the buy-box/PDP/cart fifth star goes
from an 80% gradient to fully filled **on deploy** (the requested change);
checkout was already five full stars at 4.8 (old `Math.round`), so its
render is IDENTICAL at 4.8 — the rule only redraws checkout in the
half-star bands (e.g. 4.6: five full → four and a half, matching
trustpilot.com instead of over-filling). Gradient stops now only ever hit
0/50/100%.

Sims: `checkout-trust.ts` shape table (4.8/4.75 → five full, 4.6/4.74 →
half, clamps, junk) + anchors + mutant `m13-star-snap-dropped`;
`buy-box-proof.cjs` D15 (fixture 4.7 → 50% stop, never 70%; 4.8 → ten
100% stops) + mutant `m16-star-snap-dropped`.

## 4. Deploy-safety summary

| Order | Result |
| --- | --- |
| Deploy only (no admin touch) | The two OPTIONS change nothing (missing keys resolve to `accent`/100, no `s` member). The corrections apply immediately: §3 rounding fills the fifth star at 4.8 (checkout unchanged at 4.8); §2b adds count + wordmark to the cart cell |
| Save BEFORE extensions deploy | New keys in both mirrors; OLD bundles ignore unknown keys and the absent `cnt` |
| Save AFTER deploy (controls untouched) | Sanitize persists `"accent"`/`scale:100` → options render unchanged |
| Revert options | Set the ChoiceList back / slider to 100 and Save — identical option rendering (the §3/§2b corrections stay: they are requested behavior, not options) |
