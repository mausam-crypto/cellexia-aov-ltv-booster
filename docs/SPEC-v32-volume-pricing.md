# SPEC v32 — exact volume pricing at 4+ units (Discount Function)

**Sub-flag** `quantitySync.volume` (no new FeatureKey — the 4+ arm of
`quantity_sync`) · **function extension** `extensions/cellexia-volume`
(target `cart.lines.discounts.generate.run`, api 2025-10) · **config
metafield** shop-owner `$app:cellexia/volume` · **server**
`app/services/volume-pricing.server.ts` · **island** `qy.vd` ·
**webhook** `products/update` · built 2026-09-21. Ships OFF.

Merchant decisions (2026-09-21, verbatim): (1) match each market's REAL
3-pack per-unit rate computed from the store's own prices; (2) promo codes
CAN stack; (3) no other discounts to coordinate with. The app creates and
owns the discount; nothing is configured in the Shopify admin by hand.

---

## 1. The mechanic

For a tier product (consecutive 1..K unit variants), a one-time cart line
of the **1-unit variant** with **quantity ≥ K+1** is discounted so the
line total becomes exactly

    target(n) = round_half_up(n × p3 / K)        (integer cents)

where `p3` is the top-tier variant's price and `p1` the 1-unit price **in
the buyer's own country pricing** (contextualPricing — the same numbers
the storefront island emits). The function emits ONE
`fixedAmount { amount: subtotal − target, appliesToEachItem: false }`
candidate per qualifying line (`productDiscountsAdd`, strategy ALL), so
checkout charges the composed figure to the cent and the widget displays
the identical formula from the island's cents. No percentages anywhere —
percentage rounding was the drift this design exists to avoid.

## 2. Design invariants

Binding. Enforced by the harness v32 block and/or
sims/volume-function.mjs + the sims/quantity-sync.cjs vd block.

1. **Inert until armed** (the v14 discount pattern): the automatic app
   discount is created ACTIVE but the function returns no operations
   unless the config metafield says `on: true`. `on` mirrors
   `quantitySync.enabled && quantitySync.volume`; flipping either OFF
   re-mirrors `on: false` in the same save. No pause/activate API dance.
2. **Fail closed on every anchor.** A line is discounted ONLY when all of:
   config `on`; product entry exists; the line's variant id == the entry's
   1-unit variant id; quantity ≥ K+1; NO sellingPlanAllocation; NO
   `_cellexia_gift` attribute; a country entry exists for
   `localization.country.isoCode`; the line's currency == the entry's
   currency; the line's per-unit price equals the entry's `p1` to the cent
   (THE STALENESS TRIPWIRE: a price change after the last sync kills the
   discount silently instead of mischarging); and the computed amount-off
   is > 0 and ≤ 60% of the subtotal. Any miss = that line untouched.
3. **Country-keyed config, prices first-class.** Per product:
   `{k, v1, cc: {ISO2: {c, p1, p3}}}` with p1/p3 as integer cents in the
   country's presentment currency, fetched via aliased
   `contextualPricing(context:{country})` (the v18 gifts precedent) for
   the 1-unit and top-tier variants. Only countries whose market is inside
   the `quantity_sync` market scope are mirrored — the discount honors the
   same market targeting as the widget. Multi-currency markets (`eu`,
   `rest-of-world`) work because the key is the COUNTRY, not the market.
4. **Tier eligibility is the server twin of the widget rule**: 2..6
   variants, position-ordered, every variant title's leading integer ==
   its position (the qselQty parse), no gift cards; `p3 < K × p1` must
   hold or the product is skipped (no negative/zero "discounts").
5. **Refresh discipline**: a FULL refresh (catalog scan + price fetch +
   discount upsert + metafield write) runs from the Quantity page save,
   the `products/update` webhook (debounced 120 s per shop, only when the
   feature has ever been synced), and lazily from the Quantity page loader
   when the last sync is older than 24 h. An input hash (`_s.h` = catalog
   ids/prices basis + scope + flags) makes unchanged refreshes no-ops.
   `syncSettingsToMetafields` additionally re-projects the CHEAP parts
   (`on` + scope filter) from the already-mirrored `cc` tables on every
   settings save, so a Markets-matrix scope flip is honored without a
   price fetch; countries newly in scope but missing `cc` stay excluded
   (fail closed) until the next full refresh, and the admin page says so.
6. **State lives in the metafield** (`_s: {h, t, d}` = inputs hash, synced
   ISO time, discount GID) — no new Prisma model, no migration. The
   discount is found again by that id (recreated when deleted by hand);
   nothing else in the store's discounts is ever read or touched.
7. **Stacking**: `combinesWith` all-true (merchant decision — codes may
   stack). A code that itself refuses product discounts still won't; that
   is the code's own setting. The rewards SET codes target kit products,
   not tier singles — disjoint by construction; the volume function never
   emits for a line the gift machinery marked (`_cellexia_gift`).
8. **The message is localized in-function**: `localization.language`
   picks from an 18-locale curated table (native wording, no em dashes),
   base-language fallback, then English. Deterministic, no I/O — the
   whole logic lives in pure `src/logic.js` (integer-cents math), run in
   plain Node by sims/volume-function.mjs (the rewards-function pattern).
9. **Widget vd mode** (island `qy.vd: 1`, emitted when the sub-flag is on
   and `quantity_sync` is live-or-draft for the market): the 4+ arm stops
   composing bundles. Instead the stepper keeps the count on ONE line of
   the 1-unit variant: mechanical selection relays to the 1-UNIT pill
   (silent, relay-guarded), the CARDS keep the top tier painted (the rate
   promise; `qselApi.paint`), the theme input holds `n` (the native add
   is the whole order — the capture never intercepts in vd mode), the
   displayed price/chip use the SAME `round(n × p3 / K)` cents formula as
   the function, and the sub-mode clamp is unchanged. Without `vd` the
   v31 bundle-composition arm runs untouched — deploy-order safe in both
   directions.
10. **Preview honesty**: a draft-armed preview shows vd prices while the
    live discount may still be off; the Preview Center readiness note and
    UPDATE.md say checkout honors them only after go-live. Beacons: none
    new (the v31 quantity_sync beacons already cover the arm; the
    `add_to_cart` beacon now rides the native add path only when
    intercepting — i.e. never in vd mode — impressions/clicks unchanged).

## 2b. v32.1 — the field fixes (2026-09-22, after the merchant's live test)

The v32.0 build shipped and the merchant hit exactly the failure class §2.1
was supposed to prevent: the widget ran vd mode (4 singles in the cart, a
discounted total on the button) while the discount never applied. Two
defects, both fixed and now BINDING:

11. **The widget follows the VERIFIED armed verdict, never the raw
    switch.** `syncSettingsToMetafields` computes `quantitySync.volumeLive`
    (= the volume metafield's `on` via `planVolumeScope`) and injects it
    into BOTH config mirrors; the island gates `vd` on `volumeLive`. A
    refused/incomplete arming therefore degrades to the v31 whole-packs
    composition (correct charges, no function involved) — a shown discount
    that checkout won't honor is now structurally impossible. Every
    refresh caller (Quantity save, the refresh button, the webhook, the
    lazy TTL) re-syncs the mirrors afterwards so volumeLive flips in the
    same pass. volumeLive is computed-only: never stored in settings,
    registered as an INJECTED path in the harness emission check.
12. **The price sync survives Shopify's throttle and arms per product.**
    contextualPricing batches are 20 aliases, paced 250 ms apart, retried
    up to 3 times with backoff on THROTTLED, and a batch that still fails
    THROWS (a silent per-country gap must never masquerade as "no price").
    Arming is per product: one product's fetch trouble records a reason
    and skips THAT product; the rest arm (every function anchor is per
    line, so partial configs are safe by construction). The last refresh's
    reasons persist in the config (`_s.e`, capped) and an on-but-not-armed
    state renders as a CRITICAL banner with those reasons on the Quantity
    page — never a subdued line.

## 2c. v32.2 — field fixes round 2 (2026-09-22, "Title must be unique")

The live retry surfaced the NEXT layer: the app could not see its own
volume config through the Admin API (`$app:cellexia` shorthand read came
back empty while writes and function/checkout reads work), so every sync
started from scratch and the re-create died on the unique-title rule.
Three more BINDING rules:

13. **The config read falls back to the concrete reserved namespace**
    (`app--{numeric app id}--cellexia`, resolved once per process) before
    ever concluding "never synced".
14. **The discount is self-healing**: a missing/stale `_s.d` id is
    recovered by EXACT-title adoption of a function-backed
    DiscountAutomaticApp node (guarded to THIS app's function ids when
    resolvable; anything else in the store is never touched), a
    unique-title create error triggers one more adoption pass, and the
    last resort is an honest manual path naming the discount to delete.
    The deploy hint appears ONLY on a function-shaped create error.
15. **Volume wanted but unverified caps the stepper at K** (island
    `vd: 0`, widget `vw`): the merchant rejected the composed 3+1
    fallback for 4+, so while `quantitySync.volume` is on and
    `volumeLive` is not, counts past the top tier are simply not offered
    (mirrors the sub-mode clamp). The composed v31 arm remains ONLY for
    stores that never opt into volume pricing. Pricing calls also run
    the per-product variant pair in parallel at 150 ms spacing (the
    v32.1 fully-sequential run read as a hung button).

## 3. What this deliberately does NOT do

- No discount on 2..K (those ARE the tier variants; the pills/cards handle
  them), no order-level discounts, no shipping.
- No per-product opt-out UI in v32 (every tier product in scope gets it;
  ask if a product should sit out and a flags arm can gate it later).
- No B2B special-casing beyond what exists: B2B MOQ steppers never mount
  the sync, and company carts don't run automatic app discounts through
  the same storefront path; the p1 anchor would refuse wholesale prices
  anyway.
- ZERO cart-side changes: both drawer render paths already print
  `final_line_price` (verified in the live bundle), so discounted lines
  display correctly, and the volume-upgrade tile CANNOT collide — its
  `upgradeCandidates` gate fires only on quantity-1 lines, so a qty ≥ K+1
  volume line never grows a tile (verified in cellexia-cart.js; pinned by
  the harness v32 block so a future tile change re-opens this question
  loudly).

## 4. Budgets

Liquid: `vd` emission ≈ +50 B inside the existing `qy` member, paid by a
further amazon-booster schema trim; total stays ≤ 99,500. Locale files:
ZERO new keys (the discount message ships in the function; the widget
reuses v26/v31 tables). The function wasm is its own extension budget.
