# SPEC v20 — Image badges on mobile

**FeatureKey** `image_badges` · **settings section** `imageBadges` · **admin page**
`/app/features/badges` (its own card + market scope) · **island member** `ib` ·
**CSS marker** `cx-ib-on` / `--cx-ib-w` · shipped 2026-09-11.

The merchant's ask, verbatim: *"ability to make the product page badges bigger
on mobile. Customizable size increase, making sure it always looks good and
doesn't get out of the product image box. On desktop their size is good."*

## 1. Whose badges these are

They are the **theme's**, not ours. `sections/pdp.liquid` renders
`.badges > .badge > img` over the product gallery from the merchant's own
`sleepless.badge` / `sleepless.badge_size` / `sleepless.country_badges`
metafields (Accentuate-hosted artwork), which means the set of badges varies
per product AND per market. Nothing in this app supplies, orders, translates
or removes them — see `docs/theme-integration.md` (PDP structure) for the full
DOM and CSS facts.

The theme sizes them well from 577px up (`max-width: 100px` — 17-21% of the
product image) and pins every one of them to `width: 45px !important` under
`@media (max-width: 576px)` — about 14% of the image, the complaint.

**So this feature changes exactly one declaration: the width of an existing
badge, on phones.** It paints no node, ships no copy, adds no locale key
(so neither the el/ar byte wall nor the DeepL pipeline is touched) and fires
no beacon — a feature that paints nothing has no impression to count, the
`cart_trust_row` / `az_bought_count` precedent.

## 2. The control

`imageBadges.scale` — a whole percent of the theme's own phone width
(`IMAGE_BADGE_BASE_PX = 45`), from `IMAGE_BADGE_SCALE_MIN` 100 to
`IMAGE_BADGE_SCALE_MAX` 200, default **140** (63px on a 375px phone, which
reproduces the desktop proportion the merchant is happy with). 100 is a
deliberate no-op: the slider parked at "theme size" changes nothing.

The scale is a LIVE setting, like every other widget setting: a preview
session renders the SAVED value, so the loop is tune → save → preview →
adjust → go live. Only the on/off flag is armable as a preview draft, and it
follows the house preview contract — the LIVE flag is market-aware, the DRAFT
flag is global (`live ∪ draft`), so an armed draft is visible in the market
the merchant happens to be browsing, exactly like every other feature.

## 3. "Never out of the product image box"

The percentage is a REQUEST. `ibSizeFor()` (cellexia-pdp.js) measures the
live box on every pass and clamps it:

| Clamp | Value |
| --- | --- |
| one badge | ≤ `IMAGE_BADGE_MAX_IMAGE_SHARE` (25%) of the product image's width |
| the row | ≤ `IMAGE_BADGE_MAX_ROW_SHARE` (75%) of it |
| the row | never past the image's left edge, mirroring the inset the theme leaves on the right |
| always | never SMALLER than what the theme renders — the feature only adds |

The row's right edge is fixed by the theme (`right: 15px`), so the row grows
leftward and the left-edge rule is what keeps it in the picture. The badge
count is whatever the product carries: with more badges each one gets less
room, and a row that cannot grow at all keeps the theme's own size, unmarked.

Measured results (live geometry, 3 badges): 375px phone 140% → 63px (row =
61% of the image); 200% → 77px (the 25% cap, not 90px); 5 badges at 200% →
46px; 6 badges → no change at all.

## 4. Fail-closed rules

Every one of these leaves the theme's own rendering untouched — the fallback
in the stylesheet is literally the theme's `45px`:

* no `ib` island member (feature off, or out of market, in Liquid);
* a draft-only member outside a **verified** preview session;
* `scale <= 100`, or a non-numeric scale;
* a viewport above 576px — the stylesheet's media query and the runtime's
  `ibPhone()` use the same breakpoint, so desktop is unreachable twice over;
* an image that cannot be measured yet (lazy images, hidden gallery copy) —
  re-measured on `load`, `resize` and `orientationchange`;
* a row with no badges, or no room to grow.

Switching the feature off (or rotating to a wide viewport) removes BOTH the
class and the custom property, so the theme's size returns without a reload.

## 5. Storefront surface

* **Liquid** (`pdp-booster.liquid`, +403 B): the market-scoped live flag, the
  draft union, the gated island member `"ib": {"live": …, "s": …}`, and the
  feature's own term in the island/CSS/JS emission gate — so turning ONLY
  this feature on still puts the asset on the page.
* **CSS** (`cellexia-booster.css`): one rule,
  `@media screen and (max-width: 576px) { .pdp .badges.cx-ib-on .badge { width: var(--cx-ib-w, 45px) !important } }`.
  `.cx-ib-on` lifts specificity to (0,4,0) over the theme's own (0,3,0)
  `!important` rule.
* **JS** (`cellexia-pdp.js`): `mountImageBadges()` runs first in `init()`,
  measures each `.pdp .badges`, and writes `--cx-ib-w` + `cx-ib-on` on the row.
  `CX_IB_*` twin the settings-model constants (harness-pinned both ways).

## 6. Admin

`/app/features/badges` → **Image badges on mobile**: the switch, the
percentage slider, and a to-scale mock of a 375px phone with a 2-5 badge
selector, so the merchant sees the clamp before going live. The helper line
names the actual outcome ("45 px → 63 px per badge; 3 badges fill 61% of the
image width") and says when the cap — not the slider — decided. Caps travel
through the loader (a route's client bundle may not reference
`settings.server` at module scope — the v8.3 build lesson). The feature has
its own Markets card, its own Preview Center row and a hub card under
"Product page".

## 7. Budgets paid, not moved

* **Liquid** 98,129 / 99,500 B. The feature's 403 B was paid FIRST, the v19
  way: `snippets/cx-icons.liquid` 3,610 → 2,043 B (−1,567 B) by hoisting the
  nine identical `<svg>` opening tags out of the icon `case`. That rewrite
  was generated mechanically and proved byte-identical for all eight icons
  plus the fallback before it was written. The v14 pin did not move, and the
  wave LEAVES 1,371 B of headroom where it found 207 B.
* **Locales** untouched — the feature has no copy.
* **FeatureKeys** 38 → 39, appended at the END so every index-based consumer
  keeps its positions.

## 8. Validation

`validation/sims/image-badges.cjs` (86 checks, 7 mutants) runs the real
extracted builders: the merchant's size at 320/375/414px, the two caps at
every badge count, the "stays inside the image box" invariant, all nine
fail-closed paths, both copies of the theme's badge row, the live/draft/
market gate in and out of preview, idempotence (re-running never compounds),
the reset on switch-off and on rotation past the breakpoint, and the
twinning of every constant with `settings.server.ts` and the stylesheet.
`validation/harness.mjs` pins the Liquid gates, the CSS rule, the absence of
a marker/beacon, and the admin wiring.
