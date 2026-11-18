# SPEC v41 — Cellexia Subscriptions (the new app): a third selling-plan family

**Cart** `csOffered()` / `csOn()` / `csPlan()` / `csAlloc()` / `csXsOneTime()` / `csXsPlanFor()` (cellexia-cart.js) · **PDP** `azCsField()` / `azCsPlan()` / `azCsRowPlan()` (cellexia-pdp.js) · **island member** `"cs":1` and **group member** `"app"` (cart-booster.liquid, proxy.cart-data.tsx) · shipped 2026-11-18.

A new in-house subscriptions app (repository `subscription-cellexia`) is replacing Joy
country by country. This spec records what that app puts on the store, the contract this
app relies on, and the rules of the third plan family that serves it. The owned family
(v17/v23) and the native family (v40, Joy) are untouched.

## 1. What the new app looks like on the store (read 2026-11-18)

- **Where it is offered.** One shop metafield, `cellexia.subscription_offer` (json):
  `{"everywhere": false, "countries": ["LU"], "buy_once": true}`. Offered when
  `everywhere` is true or `countries` contains `localization.country.iso_code`, and never
  to a B2B customer. The unit is the **country**, not the market: all markets share one
  domain and Luxembourg is listed in two of them. The app's emergency stop writes
  `countries: []`.
- **Plans.** Each of the 33 sizes of the 11 main products carries exactly one plan of
  the app: 1 unit "Delivered every 4 weeks", 2 units "every 8 weeks", 3 units "every 12
  weeks" (on the store: 719235481975 / 719235514743 / 719235547511, the same three ids
  on every product). Their selling plan group is named "Subscription" and its
  **`app_id` is `cellexia-subscriptions`**. Sachets and extras carry none.
  `requires_selling_plan` stays false.
- **Price.** No pricing policy today: the allocation price equals the variant price.
  The owner may later raise the one-time price so the subscription becomes the cheaper
  one; first-order and renewal prices may then differ (the allocation price is the
  first order's).
- **Joy is still there.** Joy's two groups (5 % off, ids per product) stay on the same
  variants and are listed first. Joy's widget is drawn for Spain only, and Spain must
  not be switched on in the new app.
- **Product page.** Where offered, the app's theme snippet renders
  `[data-cellexia-subscription]` right after `.pdp__grey` and **moves its plan field into
  `.pdp__grey`**: `<input type="hidden" name="selling_plan" data-cellexia-plan>`. Its
  value is the plan of the selected size; the link "Buy once for …" empties it and
  "Subscribe instead" puts the plan back. Every change dispatches a bubbling `change`.
  It also prints `<script type="application/json" data-cellexia-sizes>` =
  `{"<variant id>": {"plan": <plan id>, …}}`. The theme's add-to-cart sends the field.
  The snippet removes itself where `.Avada-SubscriptionData-Block` is on the page.
- **Cart.** Nothing: no Function, no line property, no cart attribute. A line without a
  plan is a one-time line.

## 2. The contract this app relies on

| Signal | Where | Used for |
|---|---|---|
| group `app_id == "cellexia-subscriptions"` | Liquid `group.app_id`, Ajax `selling_plan_groups[].app_id` | which plans are the new app's (`"app"` in our three data sources) |
| `input[name=selling_plan][data-cellexia-plan]`, the first enabled plan field inside `.pdp__grey` | product page | "the new app is offered on this page"; value = selected plan, empty = Buy once |
| the field's bubbling `change` | product page | re-price (already caught by the v40 `azNativeOn` capture listener) |
| `[data-cellexia-sizes]` JSON | product page | the page product's plan ids, so an older server is enough |
| `shop.metafields.cellexia.subscription_offer.value` + `localization.country.iso_code` | cart-booster.liquid, subscription-nudge.liquid | the country gate (`"cs":1`) |

If the new app renames any of these, this app silently falls back to one-time behaviour
on its pages (and the quantity cards keep their one-time prices, which are the right
prices while the subscription is not discounted). The constant `cellexia-subscriptions`
is `APP_ID` in that app's `src/shopify/selling-plans.ts`.

## 3. Owner decisions (2026-11-18)

1. Where the new app is offered, everything this app adds is a subscription **by
   default**, and the shopper's "Buy once" is respected: FBT adds one-time, a one-time
   cart line upgrades to a one-time bigger pack.
2. No "Remove subscription" button in the cart there, at any time.
3. Offers stay price-only: no plan name, no delivery rhythm on tiles and rows.
4. Checkout offers: a later release.

## 4. Rules of the family

**Gates.** Cart: `csOffered()` = `cfg.cs === 1` and not B2B; `csOn()` adds the kill
switch "Subscription prices in cart offers". Product page: `azCsField()` (the DOM field);
the existing reader `azSubPlanId()` already applies the kill switch and the B2B rule.

**Where the family is on**

- It is the only family: `nativeSubs()` returns false, `findPlanForItem()` returns null
  (no switch card), `ensureNativeDeny()` asks nothing.
- A plan is used when the variant itself carries it and it is the new app's. **No
  "cheaper than one-time" rule**, no name rule, no fallback to any other plan. Usable
  price = above zero and not above the one-time price.
- **Pack tile** (`upgradeCandidates`): a line on the new app's plan → the bigger pack on
  that pack's own plan (`candidate.planId`), no tile when the pack has none; badge =
  `csSavingsPercent`, against qty × the 1-unit size's own subscription price. A one-time
  line → the one-time tile, unchanged. A line on another app's plan → no tile.
  `performUpgrade` is unchanged (it already adds on `candidate.planId` and restores the
  original size on its original plan).
- **Cross-sell** (`crossSellPlanFor` → `csXsPlanFor`): the row variant's own plan, with
  no anchor line needed, unless `csXsOneTime()`: the cart holds at least one line that
  could be subscribed and no subscribed line. A line whose product data has not landed
  counts as one that could (fail toward one-time). The click is re-resolved in both
  directions (`performCrossSellAdd`): a row that no longer shows what the cart would add
  is refreshed, never sent.
- **Row prices**: a plan priced like a one-time purchase strikes nothing; a cheaper one
  shows its price with the one-time price struck (both builders).
- **Product page** (`azSubRowPlan`): the branch `if (azCsField()) return
  azCsRowPlan(variantId)` sits before every buy-box and native rule. Cards, FBT rows and
  similar cards resolve to their own plan of the new app. FBT holds one click while a
  row's plan data has not landed. The embedded nudge and the nudge block are off.
- **"Remove subscription"**: never rendered.

**Where the family is off** (every other country, B2B, kill switch off)

- `nativeAlloc()` refuses the new app's plans; the native loop of `azSubRowPlan` and
  `findPlanForItem` skip them. So they are never a Joy offer, in any country, at any
  price.
- A line that carries one gets no tile, anchors nothing and gets no "Remove
  subscription" button.

**Plan identity is a union that is never unlearned** (`csIds`, `azSubCs`): product
entries replaced by ones without `"app"` (an older server) do not hide what earlier
entries said.

## 5. Deploy skew

Server and extension deploy separately. New extension + old server: the island and the
Ajax adapter carry `app`, and the block's sizes JSON names the page product's plans, so
the cart and the quantity cards are right; FBT companions fetched through the proxy
resolve through the same three shared plan ids once they are known, else stay one-time.
New server + old extension: the extra `"app"` member is ignored.

## 6. Proof

- `sims/quantity-selector` Q10 (the report, size by size; cheaper plans; older server;
  Joy page unchanged), mutants m26–m31.
- `sims/fbt` v41 block, mutants f11–f14.
- `sims/crosssell-pipeline` v41 block, mutants m52–m64.
- `sims/subscribed-upgrade` v41 block.
- `harness` section "v41 CELLEXIA SUBSCRIPTIONS".
- Browser runs on local copies of the real Luxembourg, Spain and France pages, build 85
  against this release (UPDATE.md §3a).

## 7. Not in this release

- Checkout upsell (adds one-time).
- The theme's routine quiz (adds one-time; theme code).
- Removing the owned family, whose app was uninstalled on 2026-11-18: its island
  member `sx` is still emitted from leftover shop metafields and still supplies the
  native family's deny-list.
