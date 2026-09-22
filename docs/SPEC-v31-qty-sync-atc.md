# SPEC v31 — quantity stepper sync + add-to-cart button v2

**FeatureKeys** `atc_button` (46th) + `quantity_sync` (47th, both appended) ·
**sections** `atcButton` / `quantitySync` · **island members** `ab` / `qy`
(#cx-pdp-config) · **JS prefixes** `atcb` / `qsync` (cellexia-pdp.js) ·
**CSS prefixes** `cx-atcb` / `cx-qsync` · **admin** `/app/features/quantity`
(both, the v21 cart-page precedent) · built 2026-09-21. Both ship OFF;
previewable through the standard Preview Center draft flags; market-scoped
like every FeatureKey.

The merchant's ask, verbatim intent: (1) a new optional add-to-cart button
look — icon, bigger label, price better placed; (2) the theme's +/- stepper
"doesn't even change the price shown on the add to cart button and doesn't
integrate at all with the quantity selector" — connect them: 2 selects the
2-tier, 3 the 3-tier, "for 4 or above it should always have the discount of
the 3-pack", with a subtle visual connection, perfect on mobile.

---

## 0. The theme facts this build stands on (docs/theme-integration.md)

- The PDP stepper (`.pdp__actions .action--qty .qty`: `.js-qty--minus`,
  `input#quantity-select-pdp[sm-rc-quantity-selector][name="quantity"]`,
  `.js-qty--plus`) is a DEAD END: its jQuery handler only rewrites the
  input value; nothing re-renders. At add time
  `CartJS.addItem(currentVariant.id, qty)` MULTIPLIES the selected bundle
  variant by it (qty 2 of "3 Jars" = 6 jars).
- Volume tiers are VARIANTS (1/2/3 units; pill buttons with `data-val-id`,
  hidden selects, `renderVariables()` writing `[sm-rc-current-price]`).
- The ATC button: `button[sm-rc-add-to-cart].btn.btn--primary.btn--atc`
  holding `.oos-text` + `.is-text` ("{label} - " text node +
  `span[sm-rc-current-price]`). The theme only ever writes the price
  span's text and show/hides the two state spans — never the structure.
- ≤576px the ATC wraps to full width BELOW the stepper row.

## 1. quantity_sync — design invariants

Binding. Enforced by the harness v31 block and/or sims/quantity-sync.cjs.

1. **The stepper counts UNITS, and the pills stay the only tier channel.**
   Counts 1..K relay through the v26 cards' own `choose` (silent — the
   sync beacons under its own key) when the cards are mounted, else a
   native `.click()` on the theme pill; the theme's price/subscription
   machinery runs unchanged. K = the top tier (3 on the live store).
2. **Mount shape is strict**: the qs data member (emission widened to
   `cx_qs or cx_qy`), consecutive `1..K` unit tiers (leading-integer parse
   per tier, `K >= 2`, cap 6), usable presentment cents on every tier, an
   id-matched pill per tier, and the theme input's `min` = 1. ANY miss
   keeps the theme stepper untouched (a B2B MOQ stepper is never
   replaced). Hide only after insert (the v6.6 rule); the theme's `.qty`
   stays in the DOM because its input keeps holding the submit quantity.
3. **Past the catalog (n > K): whole top-tier bundles + at most one
   best-tier remainder.** `split(n) = floor(n/K)` top bundles + the
   `n % K` tier when the remainder is non-zero. Every unit past the top
   tier keeps the deepest bundle price the catalog offers; on the live
   1/2/3 catalog n=4 is a 3-pack + a 1-jar, n=5 a 3-pack + a 2-pack, n=6
   two 3-packs. (A flat per-unit 3-pack rate on 4/5 is NOT expressible
   with variant-based tiers — no such variant exists; the composition is
   the closest truthful mechanic and the shown total is exactly what
   checkout charges.)
4. **The theme input holds WHOLE BUNDLES, never the unit count.** For
   n <= K it is 1 (the tier variant IS the units); past K it is
   `floor(n/K)`. The native add path therefore stays truthful on its own:
   a dead interceptor can only under-buy the remainder, never oversell.
5. **The ATC capture composes ONLY when needed.** A document-capture click
   listener steps aside (native add runs) unless `n % K > 0` off the top
   tier; then it prevents the theme handler and posts ONE
   `{items:[bundle, remainder]}` `/cart/add.js` call, handing success to
   the theme's own `successState()` (fallback: fresh cart.js →
   `refreshMiniCart`). Errors leave the cart untouched.
6. **Price text ownership is minimal.** For n <= K the pill relay already
   makes the THEME write that tier's total into `[sm-rc-current-price]` —
   the sync touches nothing. Past K it writes the composed total via the
   v26 `qselMoney` twin (presentment format) and re-asserts it in a
   microtask after any theme rewrite (MutationObserver; idempotent writes
   break the loop). Dropping back to the catalog hands the text back via
   `window.renderVariables()` (else a native `change` on the hidden
   variant select). No arithmetic ever happens on formatted strings.
7. **Subscriptions clamp at the top tier.** While `azSubPlanId()` (v17.1
   probe: fail-closed on kill switch/B2B/widget absent/one-time) resolves
   a plan, the cap is K — plan allocations price single tiers, so composed
   counts stay one-time territory; `cx:buybox:change` snaps an
   out-of-range count back. The capture never composes in sub mode.
8. **Bidirectional, one beacon per shopper action.** Pill listeners sync
   the stepper back on any tier tap (card taps arrive as their pill
   relay): count = that tier's units, no re-relay (`relaying` guard), no
   `quantity_sync` beacon (the cards' own click beacon covers it).
   Stepper-driven changes beacon `quantity_sync`/`click`/`q<n>`; a mount
   beacons one impression; a composed add beacons `add_to_cart`/`q<n>`.
9. **The save tag is computed honesty.** `baseline*n − composed` shown
   only when n >= 2 AND positive, worded by the cards' own `save`
   template via `qselTpl`/`qselMoney` (all 18 locales, zero locale-file
   bytes); the `cx-qsync--deal` ring accompanies it. The tag floats off
   the stepper's top edge (absolute) so the buy row's height never moves.
10. **Visual thread**: the stepper mirrors the theme's own pill anatomy
    (1px ink ring, 40px radius); a tier change fires one `--pulse` beat on
    the chosen card (CSS-gated for reduced motion). Counter cap 24
    (qselQty's own cap); a11y = role=group + localized qty/inc/dec labels
    (three new CX_QSEL_STR keys, JS asset only — el/ar walls untouched).

## 2. atc_button — design invariants

1. **Same button, new face, zero new text.** `.is-text` reflows to
   `[cart glyph + label]` centered + `[price]` right behind a hairline:
   the label is the theme's OWN localized text minus the " - " joiner,
   wrapped in `cx-atcb__label`; the price span MOVES as the SAME node into
   `cx-atcb__price`, so every later theme write (and the sync's composed
   price) lands unchanged. The glyph is `cxIcon('cart', 20)` (new
   CX_AZ_ICONS entry, literal-only call site).
2. **Fail closed on any drift.** No `.is-text`, no price span, the span
   not a direct child, any non-text sibling, or an empty label → return
   BEFORE any mutation (the notify-me buttons and future theme edits keep
   their exact markup). Idempotent via the `data-cx-feature="atc_button"`
   marker on the button.
3. **State machinery untouched**: `.oos-text` toggling, `disabled`, the
   jQuery click handlers — all on the same nodes as before. The hairline
   is `currentColor` at 0.35 so the theme's hover invert keeps it visible.
   Label = Gobold 16px (14.5px under 380px), uppercase; `:lang(ar)` drops
   the letterspacing (house rule).
4. One impression beacon per decorated button; `track` suppression in
   preview rides the house `track()` itself.

## 3. Settings + island

```ts
atcButton:    { enabled: boolean };   // default false
quantitySync: { enabled: boolean };   // default false
```

Both: STANDALONE_SECTION_FIELDS, FEATURE_RAW_FIELD kind "section",
marketScopes, strict `=== true` sanitize, FEATURE_META labels
"Add-to-cart button v2" / "Quantity stepper sync". Members (emitted when
live-in-market OR draft-armed, the v26 gate idiom verbatim):

```json
"ab": {"live": bool},
"qy": {"live": bool}
```

The qs DATA member (locale, money format, variant cents) now emits under
`cx_qs or cx_qy` — the sync needs the cents while the cards are off; the
cards' own render gate (`pdpMemberAllowed(qs, 'quantity_selector')`) is
unchanged.

## 4. What this pair deliberately does NOT do

- No flat per-unit top-tier price on 4/5 units (see §1.3) — that would
  need a Shopify volume-pricing discount/Function, a different project.
- No availability data per tier (the island carries none): a composed add
  whose remainder variant is sold out fails quietly like the theme's own
  error path (console line, cart untouched).
- No stepper on multi-option / non-tier products, and no replacement of
  the drawer/cart steppers (PDP buy box only).
- The restyle invents no copy and never re-formats the in-catalog price
  (whatever the theme writes is what shows).

## 5. Budgets

Liquid +~660 B (two v26-idiom gates + two members + the widened qs
emission + wrapper-gate tokens), PAID FIRST by a −~350 B diet (pdp head
`{%- assign -%}` lines merged into the liquid block, the brace-literals
comment moved to docs/liquid-notes.md, four PDP schema labels + the
guarantee-facts paragraph trimmed, five amazon schema strings trimmed) —
total 99,452 ≤ 99,500 (harness §1). Locale files: ZERO new keys (aria
strings ride CX_QSEL_STR in the JS asset; el/ar walls untouched).
