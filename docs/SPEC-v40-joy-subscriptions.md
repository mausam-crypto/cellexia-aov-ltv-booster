# SPEC v40 — Joy Subscriptions: a native selling-plan family

**Cart** `nativeSubs()` / `nativeLinePlan()` / `nativeVariantAlloc()` (cellexia-cart.js) · **PDP** `azNativePlanId()` / `azSubRowPlan()` / `azNativeOn()` / `qselReprice()` (cellexia-pdp.js) · **proxy member** `"xp"` (proxy.cart-data.tsx) · shipped 2026-11-13, amended by v40.2 and v40.3 on 2026-11-14 (§7).

The merchant decided to sell subscriptions through **Joy Subscriptions (Avada)** and to
keep the in-house **Cellexia Subscriptions** app installed but switched off. Everything
subscription-aware that shipped from v17 on only activated on that in-house app's
signals (`cellexia.*` shop metafields, `window.CellexiaSubs`), and the validation suite
asserted that a Joy plan must never activate it. With Joy as the live app those
features were silently off, and the quantity stepper would have mis-ordered.

v40 adds a **parallel** family for Joy's plain Shopify selling plans. The v17/v23
"owned" family is untouched.

## 1. What Joy looks like on the store (verified live, Spanish market, 2026-11-13)

- Joy renders its **own** widget (`.Avada-SubscriptionData-Block` … `.Avada-Subscription`)
  and default-selects the subscription. The theme's `sm-rc-widget` is in the DOM but
  hidden, and its `select[sm-rc-plan-selector]` stays `"false"` whatever Joy shows. It
  is **not** a signal.
- Joy keeps the shopper's choice in **one** `<input type="hidden" name="selling_plan">`
  inside `div.pdp__grey` (there is no `<form>`; the theme adds by AJAX). Numeric plan id
  while a subscription is selected, empty string for one-time; rewritten on every
  variant change. This is the field the theme's add-to-cart sends
  (`selling_plan=<id>&id=<variant>&quantity=1`).
- Joy fires on `window`: `subscription-change` (plain Event) and `avada:plan:selected`
  (CustomEvent, two to three times per change, two payload shapes), plus a `change` on
  the hidden input. A pack change produces 7 to 14 of these.
- Joy does **not** touch other add calls: a booster-style JSON `/cart/add.js` made from
  the product page while Joy's subscription was selected stayed one-time.
- Selling plans, per product: Joy group "Every 2 months" → one plan "Every 2 Months",
  5 %, on the **1-unit variant only**; Joy group "Every 3 months" → one plan
  "Every 3 Months", 5 %, on the **2- and 3-unit variants only**. **Plan ids are
  different on every product.** Joy's allocation is first in each variant's list.
- The in-house group "Main" (three plans, 0 %, priced exactly at one-time) is still
  attached to **every** variant of every product.
- The cart island still carries `"sx":{"p":[<3 in-house plan ids>],"d":…,"live":false}`
  and `window.CellexiaSubs.getState()` answers `null`.
- Joy is rendered in the Spanish market only. France, the US and the UK show no
  subscription option and have no `selling_plan` input.

## 2. Design invariants

1. **Two families, never mixed.** *Owned* (v17/v23) = the in-house app, driven by
   `cfg.sx` and `CellexiaSubs`; byte-identical to v39.1. *Native* (v40) = any other
   Shopify selling plan, i.e. Joy. The family is decided **per cart line**: a line on
   an in-house plan stays owned, and a resolution never crosses from one family into
   the other.
2. **Native is off while the in-house app is live.** Cart: `cfg.sx.live === true`.
   PDP: `CellexiaSubs.getState()` answers anything (a buy box that says "one-time" is
   never overruled by Joy's field). So re-launching the in-house app restores v39.1
   behaviour without a deploy.
3. **Same gates as before.** The admin kill switch "Subscription prices in cart
   offers" and the B2B rule apply to native exactly as to owned.
4. **In-house plans are never offered natively.** The deny-list is the in-house plan
   ids: `cfg.sx.p` on the cart, the app proxy's `"xp"` member on the PDP and on a cart
   whose island is absent. **Unknown list = native inert** (fail closed), so an older
   server, or a proxy error, can never enroll a shopper in the dark app.
5. **Offerable = strictly cheaper than one-time.** A native plan is used only when the
   variant itself carries it, it is not on the deny-list, and `0 < price < one-time
   price`. That refuses 0 % plans and prepaid lumps.
6. **Per-shopper proof.** Native cart context needs a cart line whose **own** plan is
   offerable on its **own** variant. Native PDP context needs Joy's field to hold a
   plan. Nothing proof-less was added; the home/collection card-price decorator stays
   owned-only (merchant decision: cards keep one-time prices under Joy).
7. **Delivery frequencies.** Joy plan ids are per product and per pack size, so "the
   same plan elsewhere" never holds:
   - **Cart cross-sell row** and **cart pack-upgrade tile**: each resolves to its
     variant's own offerable plan, the one **named** like the cart's subscription first.
     Neither prints the plan name (merchant decisions 2026-11-14: v40.2 for the tile,
     v40.3 for the row — the offers show the subscription price only; the theme's cart
     line shows the plan once the product is in the cart). v40 printed the name whenever
     the schedule differed from the cart's.
   - **PDP** (FBT rows, similar cards): a row follows the selection only through its
     own offerable plan with the **same name** as the page plan, otherwise it stays
     one-time. Nothing visually new on the product page.
   Names are compared as rendered for the page's language (case-insensitive), never
   parsed.
8. **The add never contradicts the display.** In native mode the FBT add is refused,
   and the rows re-priced, when the click-time plan differs from what a row is showing
   (Joy mounts late and may select a subscription without a tick).

## 3. Behaviour matrix

| Surface | In-house LIVE | In-house dark, Joy line / Joy selected | Kill switch off or B2B |
|---|---|---|---|
| Cart cross-sell price + add | owned ladder (v17) | row's own Joy plan (no frequency text, v40.3) | one-time |
| Cart pack tile on a subscribed line | exact plan only (v17) | tier variant's own Joy plan (no frequency text, v40.2) | no tile |
| PDP quantity cards (v40.2) | pack's exact-plan price | each pack's own Joy plan price | one-time |
| Cart switch card, no keyword match | owned fallback (v23) | first offerable Joy plan of the line's variant | hidden (B2B) / keyword only |
| Home / collection card prices | owned (v17.2/v23) | **one-time** | one-time |
| PDP FBT + similar | page plan's exact allocation (v17.1) | row's own same-named Joy plan, else one-time | one-time |
| PDP quantity stepper | caps at the top tier | caps at the top tier | unchanged |

In-house plan ids unknown (island absent **and** no `"xp"`): every native cell above is
"one-time", the stepper cap still applies.

## 4. Implementation

### Cart (`extensions/cellexia-booster/assets/cellexia-cart.js`)

- `inhouseLive()`, `nativeDenyList()`, `subsDenied()`, `nativeSubs()`, `nativeAlloc()`,
  `nativePlanName()`, `nativeSameName()`, `nativeLinePlan()`, `nativeVariantAlloc()`.
- `ensureNativeDeny()`: only when the island is absent and a native surface could need
  the list (a plan line in the cart, or the switch card on): one
  `apps/cellexia/cart-data` fetch per page, kept in `sessionStorage`
  (`cx_subs_xp:1`, 10 minutes).
- `subXsPlanLine()`: an owned line anchors as before (`{planId}`); any other plan line
  anchors only through `nativeLinePlan` (`{planId, native: true, name}`).
- `crossSellPlanFor()`: native branch returns `{planId, priceCents, name}`.
- `upgradeCandidates()`: when the tier variant lacks the line's plan and the line is
  native, the candidate takes the tier variant's offerable plan and gains `planId`.
  `performUpgrade()` sends `candidate.planId`; the failure-restore still re-adds the
  **original** variant on the **original** plan.
- `findPlanForItem()`: guarded native fallback; the keyword path skips in-house plans
  while that app is not live.
- Untouched: `subsAware`, `subsLive`, `ownedPlan`, `ownedCadenceAlloc`, the card
  decorator, `performSubscribeAll`, `performUnsubscribe`, `performCrossSellAdd`.

### PDP (`extensions/cellexia-booster/assets/cellexia-pdp.js`)

- `azSubPlanId()`: the buy box when it answers, else `azNativePlanId()` (an `INPUT`
  named `selling_plan` inside `.pdp__grey` with an all-digits value).
- `azSubRowPlan(variantId, pagePlanId)` feeds `azSubPriceRow`, the similar-card loop
  and `azFbtAdd`. `azSubDenyLoad()` reads `"xp"` from the same proxy response as the
  allocations; `azSubRegister()` also keeps plan names.
- `azNativeOn(fn)`: Joy's two window events and a capture-phase `change` on the field,
  used as **ticks** only (the field is the truth). Wired at both `cx:buybox:change`
  sites: re-price, and the stepper clamp (deferred one task).
- `azNativeSettle()`: re-prices once when Joy's late-rendered field first appears.
- `qsyncAtcCapture()`: in native mode the clamping click is cancelled, because the
  clamp just changed the variant and Joy's field still holds the previous variant's
  plan.

### Server

- `app/routes/proxy.cart-data.tsx`: top-level `"xp"` =
  `shop.metafields.cellexia.plan_groups.value.planIds`, `[]` when absent. Route-side
  Liquid: zero theme-extension bytes.
- `app/routes/webhooks.orders.paid.tsx`: `hasSubscription` now comes from
  `line_items[].selling_plan_id` when the payload carries it (webhook API 2026-10+),
  else from one Admin GraphQL `order.lineItems.sellingPlan` lookup. Before v40 it read
  a field order webhooks never carry, so the subscription rate was 0 with any app.
- No settings-model change, no new scope, no database change, no Liquid change.

## 5. Known limits

- A Joy plan at 0 % is never offered (invariant 5).
- The switch card has no Joy-liveness signal: Joy's plans exist on the products in
  every market, so the card must be scoped, in its own market scope, to the markets
  where Joy's widget is shown. It is off today.
- The switch card itself does not print the delivery frequency (unchanged since v4.7).
- The subscription nudge still anchors to the theme's hidden `sm-rc-widget`; check its
  placement before enabling it in a Joy market.
- On a product page whose selection is the 2/3-unit pack ("Every 3 Months"), FBT
  companions and similar cards stay one-time, because their 1-unit variants only carry
  "Every 2 Months" plans.

## 6. Enforcement

(v40.2 additions are listed in §7.)

- Harness v40 block: the native gates, the deny-list source, the strict price rule,
  the disclosure rules, the upgrade payload and restore, the label emission, the PDP
  reader and ticks, the proxy member, the webhook lookup, and a negative pin that the
  card decorator carries no native logic. Three v17/v23 pins were restated; every
  other owned-family pin is green unchanged.
- `sims/crosssell-pipeline.cjs`: native activation matrix, resolution, rows, adds,
  upgrade and restore, proxy list; mutants m22 (re-anchored) and m33–m51.
- `sims/subscribed-upgrade.cjs`: tier tiles and the switch-card lookup on the live
  fixture shape.
- `sims/fbt.cjs`: Joy field reader, per-row plans, deny-list, mismatch abort, ticks;
  newly mutation-tested (f1–f10).
- `sims/quantity-sync.cjs`: S10b (Joy tick clamp), S10c (cancelled clamping click);
  mutants m20, m21.

## 7. v40.2 (2026-11-14) — two changes after the first day live

Merchant feedback on the deployed v40 (Spanish market).

### 7.1 Quantity cards follow the selected subscription

**Report.** With "Continuous Treatment" selected in Joy's "Choose Your Treatment"
widget (its default), the quantity cards still showed one-time prices (1 Jar €57.00,
2 Jars €48.45 each, 3 Jars €45.60 each) next to an add-to-cart button saying €54.15.
The island carries one-time prices only, and v26 deliberately had no subscription
interplay.

**Now.** While a subscription is selected (`azSubPlanId()`: Joy's hidden field, or an
answering in-house buy box), every card shows what **its own pack** costs on a
subscription:

| Card | One-time | Subscription selected |
|---|---|---|
| 1 Jar | €57.00 | €54.15 · ~~€57.00~~ · Save €2.85 |
| 2 Jars | €48.45 each · ~~€57.00 each~~ · Save €17.10 | €46.03 each · ~~€57.00 each~~ · Save €21.94 |
| 3 Jars | €45.60 each · ~~€57.00 each~~ · Save €34.20 | €43.32 each · ~~€57.00 each~~ · Save €41.04 |

Rules:

1. **Each pack's own plan.** `azSubRowPlan(variantId, pagePlanId, own = true)`: the page
   plan's exact allocation on that variant when offerable, else that variant's own
   offerable plan — same-named first, otherwise its first one. That is the plan Joy
   switches to when the shopper picks the pack (1 unit "Every 2 Months", 2/3 units
   "Every 3 Months"). Same deny-list and strict-price rules as FBT (invariants 4, 5):
   in-house ids unknown = cards stay one-time.
2. **One baseline.** The struck price and the save chip keep comparing against the
   **one-time 1-unit price** in both modes (the v17 rule for subscribed tiles: pack
   saving and subscription discount combined). The 1-unit card therefore gains a struck
   price and a chip under a subscription, so the whole list shares one baseline.
3. **A pack without an offerable plan keeps its one-time price**, and a subscription
   figure is never shown unless it is below the card's own one-time price.
4. **The free-shipping micro-line follows the charged price** (`qselShipSync`).
5. **Display only.** Selection, relay to the theme pill, and the add (the theme's own,
   with Joy's field) are untouched. Flipping back to one-time restores the original
   block.
6. **Data.** The page product's allocations come from the app proxy
   (`cart-data?handles=<page handle>`, which also carries `"xp"`): one call per page,
   made at mount when Joy's server-rendered `.Avada-SubscriptionData-Block` is on the
   page, or on the first selected plan otherwise. Never in a market without a
   subscription widget. Plan data registered by FBT / similar (`azSubRegister`)
   re-prices the cards too.
7. **Cheap.** Joy fires 7–14 events per change: re-pricing is coalesced into one task
   (`qselRepriceSoon`) and repaints nothing when the verdict is unchanged.

### 7.2 No delivery-frequency text on the cart pack-upgrade tile

The v40 tile printed the pack's plan name ("Every 3 Months") under the per-unit price.
Removed at the merchant's request: the tile is back to "Upgrade to 2 units / €46.03 /
unit / Save 19%". The upgrade itself is unchanged (it still moves the line to the pack's
own Joy plan, and a failed upgrade still restores the original line and plan). With no
label to show, a tier plan whose name is unknown is no longer a reason to hide the tile.
(v40.2 left the cross-sell row note in place; v40.3 removed it, §7.4.)

### 7.3 Enforcement

- Harness: v40.2 pins (price block, own-pack resolver, coalescing / idempotence / ship
  sync, wiring and the one-call rule) and a negative pin that the cart script and the
  stylesheet contain no `cx-volume__freq`.
- `sims/quantity-selector.cjs` section Q8 (34 checks on the live prices) with mutants
  m13–m21; `sims/crosssell-pipeline.cjs` m41 re-purposed ("the label must not come
  back"), m42 retired; `sims/subscribed-upgrade.cjs` restated.

### 7.4 v40.3 — no delivery-frequency note on cart cross-sell rows

Asked after v40.2 whether the remaining note should stay, the merchant chose to remove
it too. v40 printed the row plan's name ("Every 2 Months") under the price of a
cross-sell row whenever its schedule differed from the cart's subscription (for example
after the cart moved to a 3-month pack). Now a subscription-priced row shows the
subscription price with the one-time price struck, and nothing else.

- `crossSellPlanFor()` no longer returns `freq`, and no longer refuses a differing plan
  whose name is unknown (there is nothing left to disclose it with).
- Both row builders lost the `.cx-crosssell__freq` element; its CSS rule is deleted. The
  stylesheet is byte-identical to v39.1 again.
- Unchanged: which plan a row resolves to, its price, the add payload, the click guard.
- Enforcement: a harness negative pin (no `cx-crosssell__freq`, no `freq` field, in the
  script or the stylesheet); `sims/crosssell-pipeline.cjs` m46 / m47 re-purposed ("the
  note must not come back", auto and manual rows), m43 and m48 retired.

After v40.3 no cart offer prints a delivery frequency. The frequency a shopper ends up on
is shown where it always was: Joy's own widget on the product page, and the theme's cart
line.
