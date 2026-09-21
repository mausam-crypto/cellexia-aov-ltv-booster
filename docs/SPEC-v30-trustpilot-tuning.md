# SPEC v30 — Trustpilot presentation tuning (checkout star color + buy-box rating size)

Two merchant-facing display options, both **LIVE settings** (the v6.5
placement precedent: no draft flags, no Preview Center plumbing — they only
restyle rows that are already visible), both defaulting to the exact
pre-v30 render so deploying this release changes **nothing** until the
merchant edits them in the admin.

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

## 2. Buy-box proof block — rating row size

**Setting:** `buyBoxProof.ratingScale` (whole percent, clamped
`BUY_BOX_RATING_SCALE_MIN`=100 … `BUY_BOX_RATING_SCALE_MAX`=200, default
100).

**Mechanism (the v28 award-strip technique):** every metric of
`.cx-bbp__rating` is authored in `cellexia-booster.css` as
`calc(var(--cxtp, 1) * Npx)`:

| Metric | N (desktop) | N (≤400px) |
| --- | --- | --- |
| Star SVGs (`.cx-bbp__rating .cx-stars__star`) | 17px | – |
| Star gap (`.cx-bbp__rating .cx-stars`) | 2px | – |
| Row gap | 6px 10px | 6px |
| Score font | 15px | 14px |
| Count font | 13px | 11px |
| Wordmark font / gap / its star | 14px / 4px / 15px | 12px / – / – |

The row's `margin-block-start: 14px` stays FIXED on purpose (block rhythm,
not row size). `bbpRatingRow` (cellexia-pdp.js) writes
`style="--cxtp:<factor>"` on the row **only when** the config value is
finite and ABOVE 100 (capped at 200) — so 100, junk, and every pre-v30
mirror produce an attribute-free row: byte-identical DOM, and with the var
unset the `calc()`s compute to exactly the old pixel values. This also
covers the deploy gap in both directions: old JS ignores the new config
key; new JS + old config renders identically.

Note `cx-stars__star` left the harness's annotated inherit list with this
change: it now carries ONE scoped rule (the calc sizing above). Everywhere
else it is still sized by its width/height attributes.

**Zero Liquid bytes:** the value rides the existing wholesale
`"c": {{ cfg.buyBoxProof | json }}` member of the `bbp` island —
`pdp-booster.liquid` is untouched (the block total stays at its v29
byte level), and no locale file changes (el/ar walls untouched).

**Admin:** Buy-box proof page → "Guarantee and rating" card → "Rating row
size" RangeSlider (step 5) + `RatingRowMock`, a to-scale preview drawn with
the SAME pixel formulas and the storefront's own star artwork/colors
(#00b67a / #d8d8d8 gradient partial fill, #565959 count, #1d1d1b wordmark)
fed by the live `trustpilot.rating`/`reviewCount` — typeface aside, what
the merchant sees is what ships. The slider saves even while the row (or
the block) is off — the markets-card precedent.

**Sims:** `buy-box-proof.cjs` D14 checks (no-key / 100 / below / junk →
attribute-free; 130 → `--cxtp:1.3`; 999 → capped `--cxtp:2`) + mutants
`m14-ratingscale-writes-at-100`, `m15-ratingscale-uncapped`.

## 3. Deploy-safety summary

| Order | Result |
| --- | --- |
| Deploy only (no admin touch) | Both surfaces byte-identical: missing keys resolve to `accent`/100 |
| Save BEFORE extensions deploy | New keys in both mirrors; OLD bundles ignore unknown keys |
| Save AFTER deploy (controls untouched) | Sanitize persists `"accent"`/100 → identical render |
| Revert | Set the ChoiceList back / slider to 100 and Save — identical to pre-v30 |
