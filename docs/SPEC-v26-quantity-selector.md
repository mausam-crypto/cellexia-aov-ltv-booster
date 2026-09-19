# SPEC v26 — quantity selector cards

**FeatureKey** `quantity_selector` (43rd, appended) · **section** `quantitySelector` ·
**island member** `qs` (#cx-pdp-config) · **JS prefix** `qsel` (cellexia-pdp.js) ·
**CSS prefix** `cx-qsel` · **admin** `/app/features/quantity` · shipped 2026-09-18.

Replaces the theme's text-pill size picker ("1 Jar / 2 Jars - 15% Off / 3 Jars - 20% Off")
with picture cards: product thumbnails (fanned per unit count), the cleaned tier name, a
per-unit price, the struck 1-unit baseline and a computed "Save {amount}" chip, plus a
"Clinically recommended" badge on the second tier and the house "Best value" badge on the
last. Ships OFF; previewable through the standard Preview Center draft flags; market-scoped
like every FeatureKey. Works on every product of the store's shape (single option,
"N <container>" tiers) and fails closed into the theme's own picker everywhere else.

---

## 1. Design invariants

Binding. Each is enforced by the harness v26 block and/or sims/quantity-selector.cjs.

1. **The theme's own buttons stay the only control channel.** The original
   `.option__wrap--buttons` group is HIDDEN (`cx-qsel-src`), never removed or rebuilt, and
   every card click is relayed as a native `.click()` on the matching original button —
   the theme's jQuery handler then runs its own price/per-unit/hidden-select machinery
   unchanged (subscription widget and ATC state included). No form surgery, no synthetic
   events, no second source of variant state.
2. **Cards map to buttons by variant id only** (`data-val-id`, trimmed — the theme's
   `pdp-options.liquid` leaks a trailing newline on the last button). Index-based pairing
   is banned. Any mismatch (count, id, fewer than 2, more than one `.option__wrap`,
   missing island data) bails BEFORE anything is hidden: **never hide without inserting**
   (the v6.6 rule).
3. **Money strings must be presentment-correct in every market.** The island emits raw
   presentment cents (`p`) plus `mf` = `shop.money_format` (the v21.1 field-proven
   member); the runtime formats via the `qselFormatMoney` TWIN first (all 8 Shopify
   placeholder variants, HTML tags stripped — i.e. exactly what the page's Liquid
   `| money` prices show), falling back to `window.formatMoney` only for a placeholder
   the twin does not know, then `Intl` in the active currency. The twin-first order is
   deliberate: the LIVE theme's own formatMoney ignores the placeholder name and
   renders dot-decimals for every format (verified live 2026-09-18 on the PLN market —
   "216.00 zł" beside Liquid's "216,00 zł"). No arithmetic ever happens on formatted
   strings.
4. **Unit math is shown only when it is true.** `q` = leading integer (1..24) parsed from
   the variant's own (localized) title — no positional fallback, so a "30ml/50ml"-shaped
   product can never get fabricated per-unit math. Per-unit price and the struck baseline
   render only when the FIRST variant parses as q=1 (the baseline), q ≥ 2, and
   `floor(p/q) < base.p`; the save chip only when `q*base.p − p > 0`. A card that fails
   the guards still renders (image, name, total price) — it just carries no claims.
   The tier name strips the merchant's " - 15% Off"-style suffix (several of those
   percentages are factually wrong vs the live prices; the computed chip is the truth).
5. **All five UI strings ship in the JS asset** (`CX_QSEL_STR`, 18 locales — the v8.16b
   AZ_SHIPS_FORMS precedent: fixed UI chrome, zero locale-file bytes; el/ar are at the
   byte wall). `badge3` is the locale files' own `volume.best_value` wording verbatim;
   `save`/`title` follow the volume-tile register per language. `{amount}` placeholders
   are substituted with split/join (never first-match `.replace`). No em dashes.
   Locale resolution: exact `l` (island `request.locale.iso_code`) → base language →
   `en`. `document.documentElement.lang` is BANNED as a source — this theme emits
   `shop.locale` there (always the primary language).
6. **Live/draft gating is the ib pattern verbatim**: Liquid emits the member when the
   feature is live-in-market OR the preview draft flag is armed; the runtime renders only
   when `pdpMemberAllowed(d, "quantity_selector")` passes. Beacons ride `track()` (auto
   suppressed in preview): one `impression` after a successful mount, one `click` with
   meta `q<units>` per selection change.
7. **1 unit stays the default selection.** The initially-selected card mirrors the
   theme's own `.active` button (the theme marks the first). The module never clicks,
   selects, or adds anything on its own — preview included.
8. **Vertically compact.** One card row ≈ 64px on phones (image 48px), heading a small
   uppercase line — the block replaces the pill group's own vertical footprint instead of
   stacking under it.

## 2. Settings

```ts
quantitySelector: {
  /** Master switch (43rd FeatureKey). Default false — safe-by-default. */
  enabled: boolean;
}
```

`quantitySelector` joins STANDALONE_SECTION_FIELDS (snapshot/restore/flip-test ride the
generic section arm), FEATURE_RAW_FIELD kind "section", marketScopes like every key.
No other options: the layout, badges and math rules are this spec.

## 3. Island member (pdp-booster.liquid)

Emitted inside #cx-pdp-config when live-in-market or draft-armed (`cx_qs`):

```json
"qs": {"live": bool, "l": "<request.locale.iso_code>", "mf": "<shop.money_format>",
        "v": [{"id": 42…, "t": "2 Jars - 15% Off", "p": 11390,
                "im": "<168px CDN url>", "vi": 1}]}
```

`im` = the variant's own featured image (then `vi:1` — the runtime shows it alone) else
the product's featured image (the runtime fans `min(q,3)` copies). `p` is presentment
cents. Variants capped at 6. Every output is `| json` (island nil-tripwire discipline).

## 4. Storefront module (cellexia-pdp.js)

`qselMount()` runs first in `init()` (independent DOM area — `.pdp__options`). Steps:
member → allowed → single `.option__wrap` guard → button map by trimmed `data-val-id` →
build `.cx-qsel` (role=radiogroup, cards role=radio, roving tabindex, arrow keys) →
insert before the wrap → hide the wrap (`cx-qsel-src`) → impression. Card click: relay
to the original button, restyle selection, `click` beacon. Theme-editor
`shopify:section:load` re-mounts (design mode only). Everything try/caught: any throw
leaves the theme picker untouched.

## 5. What this feature deliberately does NOT do

- No auto-selection of higher tiers, no preselected "recommended" (invariant 7).
- No subscription interplay: the sm-rc/CellexiaSubs widgets read the same hidden selects
  they always did (invariant 1 keeps their input identical).
- No per-product overrides and no T&A copy hooks in v26 (fixed chrome, invariant 5) —
  a future wave can add settings-copy overrides via the v8.19 copy scope if asked.
- No layout work above 6 variants (cap) or on multi-option products (bail).

## 6. Budgets

Liquid additions ≈ 0.9 KB (gates + member); total must stay ≤ 99,500 (harness §1).
Locale files: ZERO new keys (el/ar walls untouched). JS/CSS asset growth is uncapped.
