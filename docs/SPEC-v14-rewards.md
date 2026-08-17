# SPEC v14 — Rewards: Set savings (KIT tiers) + Gift tiers + Free-shipping guarantee

Binding contract for v14 (2026-08-16). Every file that touches these features
implements EXACTLY the names, shapes and rules below. Plain-language plan:
`docs/PLAN-set-savings-gift-tiers.md`. Merchant decisions folded in: KIT
codes visible at checkout; subscription lines count and get the saving on the
FIRST order only; free standard shipping automatically when the cart holds
≥ 2 full-size units OR the pre-discount spend meets the market's free-shipping
threshold (opt-in per market); Joy referral/reward codes are NOT a concern
(the merchant is retiring Joy); tier ladder stays 2/3/5/10 → 5/10/20/30 %;
gift tier 1 default = Jawline Contour Tightening Cream (1 unit), changeable;
sachet-free pools where sachets are not stocked; returns keep the gift (no
code); per-market pricing differs (US/CH/AU higher) so thresholds are
per-market amounts in the market currency with a pricing-aware "suggest".

## 0. Vocabulary

- **Full-size product**: any product that is not a sachet, not a gift-pool
  product, not the order-protection product. Sachet = product with tag
  `sample-sachet` OR variant listed in `rewards.giftTiers.samplePool`.
- **Units of a line**: for a full-size product, the variant's ladder position
  (1-based index in `product.variants`; "1 Jar"=1, "2 Jars"=2, "3 Jars"=3),
  times `line.quantity`. Server mirrors this as `units[variantId]` (only
  entries > 1) so the Function agrees with the storefront. Non-ladder
  products (single variant) = 1 × quantity.
- **Different products**: distinct `product_id` among ELIGIBLE lines.
- **Eligible line** (counts toward tiers AND receives the KIT %): full-size
  product line, not carrying `_cellexia_gift`, not the protection product,
  not excluded for the market (`setSavingsExcludedByMarket[market]`),
  subscription lines included when `includeSubscriptions` (default true).
- **Spend** (gift thresholds, meter, free-shipping guarantee): sum of
  `original_line_price` (storefront) / `cost.subtotalAmount` (Function; the
  amount BEFORE line discounts) over lines that are NOT gift lines and NOT
  the protection product. Sachets DO count toward spend (they cost money).
  Compared in the cart's presentment currency.
- **Gift line**: cart line with line property `_cellexia_gift` = tier number
  as a string ("1", "2", "3", "4"). Storefront adds gifts with quantity 1.
- **Reached tier**: highest gift tier whose market amount ≤ spend.
- **KIT tier**: highest set-savings tier whose `count` ≤ different products.

## 1. Settings (app/models/settings.server.ts)

New top-level section `rewards`. New FeatureKeys (append at the END of
FEATURE_KEYS, in this order): `set_savings`, `gift_tiers` → 37 keys.

```ts
export interface GiftOption {
  /** "variant" = a specific gift product; "samples" = N sachets from samplePool */
  kind: "variant" | "samples";
  variantId: string;   // GID (kind variant) or ""
  handle: string;      // product handle (kind variant; Liquid all_products lookup) or ""
  count: number;       // kind samples: number of sachets (1..6); kind variant: 1
}
export interface GiftTier {
  /** Default threshold in EUR (shop currency); per-market amounts live in thresholdsByMarket */
  amount: number;
  /** slots: every slot is granted; within a slot the FIRST available option is used (fallback order); "choose" mode lets the shopper swap within a slot */
  slots: GiftOption[][];   // ≤ 3 slots, ≤ 3 options per slot
}
export interface SetSavingsTier { count: number; pct: number; code: string }

rewards: {
  setSavings: {
    enabled: boolean;                       // FeatureKey set_savings master
    tiers: SetSavingsTier[];                // default LADDER_PRESETS.compact = [{2,5,"KIT2"},{3,10,"KIT3"},{4,15,"KIT4"},{6,20,"KIT6"}] (v14.2; was extended 2/3/5/10); ≤ 6, counts strictly increasing, pct 1..90, code /^[A-Z0-9_-]{2,32}$/ unique
    ladderPreset: "compact" | "extended" | "custom"; // v14.2 default "compact" — informational, `tiers` is always the truth
    includeSubscriptions: boolean;          // default true (Function: appliesOnSubscription true, recurringCycleLimit 1)
    surfaces: { pdpLine: boolean; similarCaption: boolean; fbtCaption: boolean; cartNudge: boolean; crossSellReframe: boolean }; // all default true
    /** DYNAMIC record: market handle -> product GIDs excluded from counting + discount in that market */
    setSavingsExcludedByMarket: Record<string, string[]>;
    checkoutMessage: string;                // default "" → Function message "Set savings −{pct}%"; ≤ 60 chars, may contain {pct}
  };
  giftTiers: {
    enabled: boolean;                       // FeatureKey gift_tiers master
    cumulative: boolean;                    // default true
    choice: "auto" | "choose";              // default "auto"
    maxGiftLines: number;                   // default 6 (1..8; was 4 before v14.1) — cap on gift lines per cart
    sampleRule: "not_in_cart" | "rotate" | "fixed"; // default "not_in_cart"
    tiers: GiftTier[];                      // ≤ 4 tiers, amounts strictly increasing (EUR); default GIFT_PRESETS.value_first (v14.2)
    giftPreset: "value_first" | "cream_first" | "custom"; // v14.2 default "value_first" — informational, `tiers` is always the truth
    /** DYNAMIC record: market handle -> {amounts (one per tier index, same length as tiers), currencyCode} */
    giftThresholdsByMarket: Record<string, { amounts: number[]; currencyCode: string }>;
    /** sachet variants usable as samples: [{variantId, handle}] ≤ 12 */
    samplePool: { variantId: string; handle: string }[];
    /** DYNAMIC record: market handle -> location GIDs that ship that market (inventory awareness) */
    warehouseByMarket: Record<string, string[]>;
    stockFloor: { days: number; minUnits: number }; // default {3, 25}; sachets use max(minUnits,100)
    /** show the meter's free-shipping milestone from freeShipping.byMarket */
    showShippingMilestone: boolean;         // default true
  };
  freeShip: {                               // free-shipping guarantee (automatic SHIPPING discount)
    enabled: boolean;                       // default false; NOT a FeatureKey — its own MarketScope below
    minUnits: number;                       // default 2 (0 = rule off): full-size units ≥ minUnits → free standard shipping
    byThreshold: boolean;                   // default true: spend ≥ freeShipping.byMarket[market] (explicit entries only, never the 150 fallback)
    scope: MarketScope;                     // default all
  };
}
```

Defaults for `giftTiers.tiers` (EUR, cumulative) = `GIFT_PRESETS.value_first`
(v14.2 default):
1. 119 → slots [[variant Bamboo Beauty Towels `bamboo-beauty-towel`, first
   variant], [samples 2]] (the admin "Load defaults" button fills the variant
   GID from the store; the shipped default carries handle + empty variantId
   and the sanitizer keeps it)
2. 200 → slots [[variant Jawline Contour Tightening Cream `jawline-contour-tightening-cream`], [samples 2]]
3. 350 → slots [[variant Premium Leather Cosmetic Bag `premium-leather-cosmetic-bag`], [samples 3]]

`GIFT_PRESETS.cream_first` is the v14.0 order (119 cream / 200 towel / 350
bag, same sample counts) and stays loadable from the admin.

### v14.2 presets (2026-08-16)

- `LADDER_PRESETS = { compact: 2/3/4/6 → 5/10/15/20 % (KIT2/KIT3/KIT4/KIT6),
  extended: 2/3/5/10 → 5/10/20/30 % (KIT2/KIT3/KIT5/KIT10) }`,
  `LADDER_PRESET_KEYS = ["compact","extended","custom"]`;
  `DEFAULT_SETTINGS.rewards.setSavings.tiers` is a clone of `compact` and
  `ladderPreset` defaults to `"compact"`. Rationale: the store sells 11
  full-size products — a 10-product tier is unreachable for nearly every
  cart, while 4 and 6 are realistic routine baskets.
- `GIFT_PRESETS = { value_first, cream_first }` (GiftTier[] with handle +
  empty variantId), `GIFT_PRESET_KEYS = ["value_first","cream_first"]`
  (the two "Load defaults" choices; the stored `giftPreset` may also be
  `"custom"`). Default `value_first`.
- Both `ladderPreset` / `giftPreset` are informational: the sanitizer only
  coerces them into the closed enum — an unknown/missing value (pre-v14.2
  rows) is INFERRED from the tier table (`inferLadderPreset` /
  `inferGiftPreset`: equal to a preset → that key, else `"custom"`; gift
  matching ignores variantIds) — and never rewrites `tiers` from them; the
  admin flips them to `"custom"` when the table is hand-edited.
- Admin `load_defaults` accepts an optional `preset` form field
  (`value_first` | `cream_first`, default `value_first`) and resolves the
  handles to live variant GIDs as before.
- `connectRewardsDiscounts(..., {replaceExisting: true})` additionally
  DEACTIVATES (Admin API 2025-10 `discountCodeDeactivate(id)`, never deletes)
  every `LEGACY_KIT_CODES` entry (`KIT2 KIT3 KIT4 KIT5 KIT6 KIT10`) that
  exists in the store, is NOT our DiscountCodeApp and is NOT in the
  configured ladder — reported in the summary as
  "deactivated legacy code X". Without the tick nothing is touched.

### v14.3 legacy alias codes (2026-08-16)

- Settings: `rewards.setSavings.keepLegacyCodes: boolean` (default true) and
  the DERIVED, read-only `rewards.setSavings.aliasCodes: string[]` =
  `aliasCodesFor(settings)` = `LEGACY_KIT_CODES` minus the ladder codes
  (upper-cased, deduped) when `keepLegacyCodes`, else `[]` — recomputed by
  `sanitizeSettings` on every save (any payload value is discarded), so the
  raw settings section (cart island `rw.ss`) already carries it and Liquid
  needs no change. `validateSetSavingsPatch` checks `keepLegacyCodes` is a
  boolean. Compact ladder → aliases KIT5/KIT10; extended → KIT4/KIT6.
- Semantics: the ACTIVE LADDER codes behave as before (a ladder code grants
  only when it equals the code of the tier the cart qualifies for). An ALIAS
  typed by a shopper grants the tier the cart qualifies for (any tier).
  Aliases are NEVER auto-attached by the storefront and never stack with a
  ladder code: storefront + checkout safety net keep at most ONE code of the
  KIT family (ladder + aliases) on the cart — a shopper-typed alias that is
  applicable wins over our auto-attached ladder code (we remove ours); an
  alias that is NOT applicable is left alone and our ladder code is attached
  as today.
- Metafield (§2.2): `live.ss` / `draft.ss` gain `"alias": [codes]` (draft
  recomputed against the draft-overridden ladder).
- Connect (§3): alias codes go through the SAME create/update path as the
  ladder codes (title `Set savings alias KITn`, `nodes.kit[code]` keyed by
  code; summary "created alias code KIT5." / "updated alias code KIT5.");
  foreign basic codes with the same code string are deleted first only when
  `replaceExisting`. The v14.2 deactivation sweep runs ONLY when
  `keepLegacyCodes` is false (and `replaceExisting`). Health check
  `rewards-discounts` counts alias nodes as required while `keepLegacyCodes`.
- Function (§8, `logic.js computeKit`): triggering code (case-insensitive)
  is a ladder code → grant only when it equals the qualifying tier code;
  else if in `cfg.ss.alias` → grant the qualifying tier if any; else nothing.
- Admin (§11): "Keep legacy codes" checkbox on the Set savings card with the
  derived alias list shown read-only.

`DYNAMIC_RECORD_KEYS` += `setSavingsExcludedByMarket`, `giftThresholdsByMarket`,
`warehouseByMarket`. Sanitize + fail-loud validate pairs for each (reuse
`isExclusionMarketHandle`; caps: giftThresholdsByMarket ≤ 60 markets, amounts
0..1,000,000; warehouseByMarket ≤ 60 markets × ≤ 6 location GIDs
`/^gid:\/\/shopify\/Location\/\d+$/`).

FEATURE_DEFS: `set_savings` get/set `rewards.setSavings.enabled`, `gift_tiers`
get/set `rewards.giftTiers.enabled`, siblings []. Labels "Set savings (KIT
tiers)" / "Gift tiers". `STANDALONE_SECTION_FIELDS`/`FEATURE_RAW_FIELD` and
every 35-count pin → 37 (harness.mjs, settings-derivation.ts, flip-test.ts).
`marketScopes` gains both keys (defaultMarketScopes handles it).

## 2. Metafields

### 2.1 Existing mirrors
`cellexia.config` (app-data) and `$app:cellexia.config` (shop) keep carrying
the whole settings blob incl. `rewards` (unchanged path).

### 2.2 NEW shop metafield `$app:cellexia` / `rewards` (json) — the Function's ONLY config
Written in the SAME `metafieldsSet` call as the two mirrors (third entry,
ownerId = shop). Small (< 12 KB). Shape (all keys short on purpose):

```jsonc
{
  "v": 1,
  "ph": "<sha256 hex of preview token when armed, else ''>",
  "live": {
    "ss": { "on": true, "tiers": [{"n":2,"p":5,"c":"KIT2"}, ...], "sub": true,
            "scope": {"mode":"all","markets":[]}, "excl": {"<market>": ["<productId numeric>", ...]},
            "msg": "" },
    "gt": { "on": true, "cum": true, "max": 4,
            "tiers": [ { "eur": 119, "slots": [[{"k":"v","vid":"<numeric>"},{"k":"s","n":2}], ...] }, ... ],
            "bm": { "<market>": {"a":[119,200,350], "c":"EUR"} },
            "pool": ["<numeric variantId>", ...],
            "scope": {"mode":"all","markets":[]} },
    "fs": { "on": false, "min": 2, "th": true,
            "bm": { "<market>": {"a": 80, "c":"EUR"} },   // copy of freeShipping.byMarket
            "scope": {"mode":"all","markets":[]} },
    "units": { "<numeric variantId>": 2, ... },        // ladder variants with units > 1
    "prot": "<numeric productId or ''>",               // order-protection product id (from checkoutProtection.variantId → product)
    "giftPids": ["<numeric productId>", ...],          // every gift-pool + samplePool product id
    "cm": { "US": "usa", "FR": "france", ... }         // country ISO2 -> market handle (marketCountryMap)
  },
  "draft": null | { same shape as live, built from settings + draftConfig overrides }
}
```
Numeric ids everywhere (Function input GIDs are compared after stripping the
`gid://shopify/.../` prefix). Written on every settings save, preview arm /
disarm / apply, and Connect. Function reads it via
`shop { metafield(namespace: "$app:cellexia", key: "rewards") { jsonValue } }`.

### 2.3 NEW app-data metafield `cellexia` / `gift_stock` (json) — inventory pause state
`{"t":"<ISO>","paused":{"<market>":["<numeric variantId>", ...]}}` written by the
stock watcher only when the paused set changes. Liquid reads
`app.metafields.cellexia.gift_stock.value.paused[cx_market]` → island `gsp`.
The Function ignores stock (a paused gift already in a cart stays free).

## 3. Discount nodes (app/services/rewards.server.ts)

Scopes added: `write_discounts`, `read_inventory`, `read_locations` (+ webhook
`inventory_levels/update` → `/webhooks/inventory/update`). Prisma model:

```prisma
model RewardsState {
  shop        String   @id
  functionId  String   @default("")
  nodes       String   @default("{}")   // json: {kit:{KIT2:"gid://shopify/DiscountCodeNode/..",...}, gift:"gid://…", ship:"gid://…"}
  giftStock   String   @default("{}")   // json: {t, byMarket:{<market>:{<variantId>:{avail, paused}}}}
  updatedAt   DateTime @updatedAt
}
```
(both `prisma/schema.prisma` and `prisma/schema.postgres.prisma`; migration
folder `prisma/migrations/20260816120000_v14_rewards`.)

`connectRewardsDiscounts(admin, shop, settings)`:
1. `shopifyFunctions(first:25)` → the function with `apiType: "discount"` and
   `app.handle` ours / title "Cellexia rewards" → functionId (error if not
   deployed: "Deploy the extensions first (npm run deploy)").
2. For each set-savings tier code: `codeDiscountNodeByCode(code)`; if it exists
   and is NOT a DiscountCodeApp with our functionId → `discountCodeDelete`
   (only when the merchant ticked "Replace existing KIT codes"); then
   `discountCodeAppCreate` (or `…Update` when ours) with: title `Set savings
   KIT{n}`, code, functionId, startsAt now, combinesWith {order:true,
   product:true, shipping:true}, discountClasses [PRODUCT],
   appliesOnSubscription = includeSubscriptions, recurringCycleLimit 1,
   usageLimit null, appliesOncePerCustomer false.
3. `discountAutomaticAppCreate/Update` "Cellexia free gifts" (classes
   [PRODUCT], combinesWith all true) and "Cellexia free shipping" (classes
   [SHIPPING], combinesWith all true). Both created ACTIVE but inert until the
   metafield says `on`.
4. Save node ids in RewardsState; write the rewards metafield.
Health check `rewards-discounts`: nodes exist, ACTIVE, functionId matches the
deployed function; warns when set_savings/gift_tiers/freeShip is on but the
matching node is missing.

`suggestGiftThresholds(admin, settings, markets)`: reference variant = first
variant of the first ACTIVE full-size product with ≥ 3 variants (prefer handle
`jawline-contour-tightening-cream`); per market: `productVariant.contextualPricing(context:{country: <first region country of that market>}).price` vs the
shop-currency price → ratio; amount_i = niceRound(eur_i × ratio) in the
market's base currency (niceRound: ≥1000 → nearest 10; ≥100 → nearest 5;
else nearest 1). Multi-currency markets (`eu`, `rest-of-world`) → EUR amounts
unchanged. Returns a full `giftThresholdsByMarket` record for the admin to
review/save.

Gift stock: `refreshGiftStock(admin, shop, settings)` reads `inventoryLevels`
of every gift-pool + samplePool variant at the locations in
`warehouseByMarket` (fallback: all active locations); computes per market /
variant `avail`; paused = avail < floor where floor = max(stockFloor.minUnits,
sachet ? 100 : 0) (days-of-cover is out of scope for v14; keep the field);
persists to RewardsState.giftStock and, when the paused set changed, writes
the `gift_stock` metafield. Called on: Rewards page save, "Refresh stock"
button, inventory webhook (debounced 60 s per shop; only when the
inventoryItem belongs to a gift variant), and lazily from the Rewards loader
when older than 15 min.

Orders webhook: `OrderPayload` gains `discount_codes[{code}]` and line
`properties`; `OrderStat` gains `kitCode String @default("")`,
`giftLines Int @default(0)` (both schemas). Dashboard cards read them.

Analytics: `ALLOWED_FEATURES` += `set_savings`, `gift_tiers`;
`ALLOWED_TYPES` += `tier_reached`, `code_applied`, `gift_added`,
`gift_removed`; FEATURE_LABELS "Set savings", "Gift tiers".

## 4. Cart island (extensions/cellexia-booster/blocks/cart-booster.liquid)

Liquid variables: `cx_rw = cfg.rewards`, `cx_eff_ss`, `cx_eff_gt` (master on
AND marketScopes.<key> allows cx_market), `cx_draft_ss`, `cx_draft_gt` (armed
AND (draftFlags.<key> == true OR master on)); both join the master gate on
line 118 and `cx_cart_draft_any`. Island additions (emit only when
`cx_eff_ss or cx_draft_ss or cx_eff_gt or cx_draft_gt`):

```jsonc
"effective": { ..., "setSavings": <cx_eff_ss>, "giftTiers": <cx_eff_gt> },
"rw": {
  "ss": { "live": <cx_eff_ss>, "tiers": <cfg.rewards.setSavings.tiers | json>, "sub": <includeSubscriptions>,
          "sf": <surfaces | json>, "excl": <setSavingsExcludedByMarket[cx_market] | json or []> },
  "gt": { "live": <cx_eff_gt>, "cum": <cumulative>, "choice": <choice>, "max": <maxGiftLines>, "rule": <sampleRule>,
          "tiers": <tiers | json>,                       // slots incl. handles + variantIds + counts
          "th": {"a": [amounts for cx_market or EUR defaults], "c": "<currency>"},   // per-market amounts; c = market currency or shop currency
          "pool": <samplePool | json>, "paused": <gift_stock paused[cx_market] or []>, "ship": <showShippingMilestone> },
  "fs": { "on": <freeShip.enabled and scope allows>, "min": <minUnits>, "th": <byThreshold> },
  "gifts": { "<numeric variantId>": {"h": handle, "t": product title, "c": price cents (presentment), "i": image 56px url or "", "a": available bool} , ... }   // every variant option + samplePool entry, via all_products[handle]
},
"strings": { ..., "rw.<key>": <'rewards.<key>' | t: amount:'@@AMOUNT@@', pct:'@@PCT@@', count:'@@COUNT@@', code:'@@CODE@@', gift:'@@GIFT@@', value:'@@VALUE@@' | json> for every key in §7 (emit with a for-loop over a split list to save bytes) }
```
`products` map entries gain `"s": 1` when `item.product.tags contains
'sample-sachet'` (also in proxy.cart-data PRODUCT_BODY_LIQUID).
Byte caps: cart-booster.liquid ≤ 23,600 B; total Liquid ≤ 99,500 B (harness
BUDGET moves 96,500 → 99,500, documented; Shopify cap 102,400).

## 5. Amazon island (amazon-booster.liquid) — PDP surfaces

`az_eff_ss` (rewards.setSavings.enabled AND marketScopes.set_savings AND
surface flags) + `cx_draft_ss`. Island: `"rw": {"tiers": [...], "sf": {"pdp":bool,"sim":bool,"fbt":bool}, "excl": [productIds for market], "live": bool}` and strings `rw.pdp_line`, `rw.pdp_line_next`, `rw.fbt_caption`, `rw.fbt_add_save`, `rw.similar_caption` (same t: params). Byte cap: amazon-booster.liquid ≤ 19,700 B.

## 6. Storefront behaviour (cellexia-cart.js, cellexia-pdp.js) — ES5 only

Shared tier helper (byte-identical TWIN in both assets, listed in a new sim
`validation/sims/rewards-tiers.mjs`):
```js
function cxRwTier(tiers, count) { /* returns {n,p,c} of the highest tier with n <= count, or null */ }
function cxRwNext(tiers, count) { /* returns the next tier above count, or null */ }
```
Cart-only helpers (must NOT appear in cellexia-pdp.js): `rwSpendCents()`,
`rwEligibleLines()`, `rwDistinctCount()`, `rwUnits()`, `rwGiftLines()`,
`rwDesiredCode()`, `rwSyncCode()`, `rwSyncGifts()`, `rwRenderMeter()`,
`rwRenderNudge()`, `rwDecorateGiftRows()`.

Rules:
- `rwSpendCents()` = Σ `original_line_price` over non-gift, non-protection
  lines. `renderShipbar`, `renderAzFreeLine` and the meter use it (replacing
  `items_subtotal_price`). `quietRefresh`/`themeRefresh` write
  `money(cart.total_price)` into the theme's total spans (was
  items_subtotal_price).
- Gift-tier thresholds in cents: `rw.gt.th.a[i]` × 100 when `rw.gt.th.c ===
  activeCurrency()`, else EUR default × `shopRate()` (same rule as
  thresholdCents()).
- KIT code sync (`rwSyncCode`, after every `renderAll` when
  `featureOn('setSavings')` and not `state.busy` and not preview-without-
  rehearsal): desired = `cxRwTier(tiers, rwDistinctCount()).c` or null.
  Read `state.cart.discount_codes` (array of `{code, applicable}`; treat
  missing as []). KIT codes = the set of tier codes (v14.3: + `rw.ss.aliasCodes`
  — a shopper-typed APPLICABLE alias wins: desired = null for our ladder code
  and the alias stays; a non-applicable alias is left alone and the ladder
  code is attached as usual; never auto-attach an alias). If desired ∈ current
  codes → nothing. Else POST `cart/update.js` `{discount: union(nonKIT codes,
  desired).join(',')}` (desired omitted when null → removes stale KIT code);
  then re-fetch cart, `quietRefresh`. One correction per cart signature
  (`cartSignature() + '|' + desired`), never loops; failure = stand down for
  that signature. Track `set_savings` `code_applied` `{tier:n}` when a KIT
  code is newly applied.
- Gift sync (`rwSyncGifts`, same trigger, `featureOn('giftTiers')`): reached =
  highest tier with threshold ≤ spend. Wanted gift set = for tiers t ≤
  reached (or only reached when !cum): for each slot, first option that is
  available (`rw.gifts[vid].a`, not in `rw.gt.paused`, and, for kind variant,
  whose product is not already in the cart as a paid line — then fall to the
  next option); kind samples → N sachet variants from `pool` chosen by rule
  (`not_in_cart`: prefer sachets whose product id is not among cart product
  ids, then rotate by cart signature hash; `rotate`: rotate; `fixed`: first N),
  excluding paused. Cap total at `max`. Session memory
  `sessionStorage.cx_rw_gift_removed` = variantIds the shopper removed
  (never re-add those; meter shows the "add back" link). Diff vs current
  gift lines (property `_cellexia_gift`): add missing (`cart/add.js` `{items:[{id, quantity:1, properties:{_cellexia_gift:"<tier>"}}]}`, one request), remove
  extras / lines whose tier > reached / lines with `final_line_price > 0`
  after refresh (honesty rule; when the reason is not-free show
  `rw.gift_unavailable` notice) via `cart/change.js` `{id: item.key,
  quantity: 0}`; reset any gift line with quantity > 1 to 1. All through the
  quiet path; `setNotice('success', t('rw.gift_added'))` on add. Track
  `gift_tiers` `gift_added` / `gift_removed` `{tier}` and `tier_reached`.
  Preview: no cart mutation unless `PREVIEW.rehearsal === true`; render the
  would-be gift as a sample row with a `cx-preview-note`.
- Gift rows (`rwDecorateGiftRows`, called from `renderAll` after fetchCart,
  and after `decorateSubscriptionRows`): match theme rows `.mini-cart__list
  .product--cart` / `tr.cart-row` by index into `state.cart.items` (assert
  equal length, else skip); for gift lines set `data-cx-gift="1"` on the row,
  hide `.remove-product`, `.action--qty`, `.js-qty--cart` groups and any
  `.cx-sub-remove-row` via CSS on `[data-cx-gift]`, set `span.unit-price`
  and `.actions .price` / `td.col__price` / `td.col__total` textContent to
  `t('rw.free')` and add a `span.cx-rw-gifttag` inside `.product__info
  .title` with `t('rw.gift_tag')`; a quiet `button.cx-rw-giftremove` (t
  'rw.remove') that removes and remembers; in `choice` mode a
  `button.cx-rw-giftswap` when the slot has another available option.
  Never insert siblings inside `.mini-cart__list`. Exclude gift lines and
  sachets from `upgradeCandidates`, `findPlanForItem`, `distinctProductCount`,
  cross-sell/auto-cross-sell picks (extend the PROTECTION_HANDLE exclusion with
  gift product handles from `rw.gifts` and pool), and from `az_cta_count`? (no
  — items count stays honest).
- Meter (`rwRenderMeter`, replaces `renderShipbar` when
  `featureOn('giftTiers')`; when only shipbar is on the old bar renders):
  node `div.cx-rw-meter[data-cx-feature="gift_tiers"]` > `p.cx-rw-meter__msg`
  (headline) + `div.cx-rw-meter__track` > `div.cx-rw-meter__fill` +
  `span.cx-rw-meter__mark` per milestone (style left:%; `data-done` when
  reached; title = label). Milestones = gift tiers (amount, label = first
  option's product title or "sample set") + free shipping (thresholdCents(),
  when `rw.gt.ship` and shipbar feature is on for the market or fs.on). Scale
  = highest milestone. Headline: nearest unreached milestone: gift →
  `rw.meter_gift_away` (amount, value = money(gift price), gift = title);
  shipping → `shipbar.away_html`; all reached → `rw.meter_all`; a just-
  reached gift also shows `rw.meter_gift_unlocked` briefly (notice). Impression
  key `gift_tiers`; when the meter renders the old shipbar does not (returns
  'free_shipping_bar' impression too if the shipping milestone is shown).
- Nudge (`rwRenderNudge`, `featureOn('setSavings')` and `sf.cartNudge`):
  `div.cx-rw-nudge[data-cx-feature="set_savings"]` right under the meter /
  shipbar; text: current tier → `rw.set_saving` (amount = money(Σ line
  discounts from KIT: `state.cart.total_discount` when a KIT code is
  applicable, else 0), code) as first line + next tier → `rw.set_add_one` /
  `rw.set_add_more` (count = next.n − distinct, pct); no next → only saving
  line. Reconciliation `div.cx-rw-recon` (Subtotal = money(original_total_price),
  Set savings −X) rendered only when a KIT discount is active. Cross-sell
  reframe (`sf.crossSellReframe`): `crosssellTitleText()` and the auto title
  → `t('rw.set_title', {pct: next.p})` when a next tier exists (override
  block setting still wins); each row's price shows `money(price × (1 −
  next.p/100))` with the original struck (`s.cx-crosssell__compare`).
- Preview simulator: `PREVIEW.sim = {spend: cents, count: n}` from
  `sessionStorage.cx_preview_sim` (JSON) or `preview-config.simCart`; when
  set, `rwSpendCents()` and `rwDistinctCount()` return the simulated values
  and NO cart mutation happens; `injectPreviewBar()` gains an amount input +
  count stepper writing `cx_preview_sim` and calling `scheduleRefresh()`.

PDP (cellexia-pdp.js): buy-box row `p.cx-az-row.cx-rw-pdp[data-cx-feature="set_savings"]`
built with `azBuildMicro`-style helpers, mounted after `.stock-msg` and added
to `AZ_BUYBOX_ORDER`; text `rw.pdp_line` (pct = tiers[0].p, count) or, when
`window.CartJS && CartJS.cart.items` show ≥ 1 different eligible product not
this one, `rw.pdp_line_next` (pct of the tier the cart would reach). FBT:
`p.cx-az-fbt__sub` under the h2 (`rw.fbt_caption`, count = rows, pct =
cxRwTier(tiers, rows).p, "at least"), total shows `strong.cx-az-fbt__total`
= discounted + `s.cx-az-fbt__was` = original; button label
`rw.fbt_add_save` (count, pct). Similar: `p.cx-az-similar__sub`
(`rw.similar_caption`, pct = tiers[0].p). Exclude products in `rw.excl` and
sachets from FBT/similar picks (via productsByHandle `s` flag / recs
`sample-sachet` tag). v14.1: gift-pool products are NOT excluded any more
(the `rw.giftPids` island member stays but is unused — see §11b).

## 7. Strings (locale key `rewards.*`; island key `rw.*`; params via @@TOKENS@@)

| key | English default | params |
|---|---|---|
| meter_gift_away | You're {{ amount }} away from a free {{ gift }} (worth {{ value }}) | amount, gift, value |
| meter_gift_unlocked | Free gift unlocked: {{ gift }} | gift |
| meter_all | All rewards unlocked — enjoy! | |
| set_add_one | Add 1 more product to save {{ pct }}% on everything | pct |
| set_add_more | Add {{ count }} more products to save {{ pct }}% on everything | count, pct |
| set_saving | Set savings −{{ amount }} ({{ code }}) | amount, code |
| set_title | Complete your set & save {{ pct }}% | pct |
| subtotal | Subtotal | |
| free | FREE | |
| gift_tag | Free gift | |
| gift_added | Free gift added to your cart | |
| gift_back | Add your free gift back | |
| gift_unavailable | Your free gift can't be applied to this order right now | |
| remove | Remove | |
| swap | Swap gift | |
| sample_set | Sample set | |
| pdp_line | Add any second product, save {{ pct }}% on both | pct |
| pdp_line_next | Add this to your cart and save {{ pct }}% on your set | pct |
| fbt_caption | Buy all {{ count }} together, save at least {{ pct }}% | count, pct |
| fbt_add_save | Add all {{ count }} & save {{ pct }}% | count, pct |
| similar_caption | Add any of these, save {{ pct }}% on both | pct |
| meter_gift_away_plain | You're {{ amount }} away from a free {{ gift }} | amount, gift |
| set_title_more | Complete your set — {{ pct }}% off everything you add | pct |
| fbt_add_save_both | Add both & save {{ pct }}% | pct |

The last three rows were APPENDED by the v14.1 polish (contract order:
meter_gift_away_plain, set_title_more, fbt_add_save_both — always at the END
of the group; ar.json keeps its 17-key prefix, el.json stays empty). The cart
`RW_DEFAULTS` lists all 24 keys in this order; the PDP `RW_DEFAULTS` lists the
5 PDP keys + fbt_add_save_both.

JS holds these English defaults inline (`RW_DEFAULTS`) and uses them whenever
the island string is missing or starts with "Translation missing" — Greek
(el.json) and Arabic (ar.json) may not have room for every key; add keys in
the table order until the file would exceed 15,200 B (harness budget), and
stop. All other 15 locale files get all keys. `en.default.json` must carry all
keys (superset rule).

## 8. Discount Function (extensions/cellexia-rewards/, JS, api_version 2025-10)

Targets: `cart.lines.discounts.generate.run` (export `cart-lines-discounts-generate-run`)
and `cart.delivery-options.discounts.generate.run` (export
`cart-delivery-options-discounts-generate-run`). Input queries select:
`cart { attribute(key:"_cx_preview"){value} lines { id quantity attribute(key:"_cellexia_gift"){value} cost { subtotalAmount { amount currencyCode } } merchandise { __typename ... on ProductVariant { id product { id hasAnyTag(tags:["sample-sachet"]) } } } sellingPlanAllocation { sellingPlan { id } } } deliveryGroups { id deliveryOptions { handle cost { amount } } } }`,
`discount { discountClasses }`, `triggeringDiscountCode`, `localization { country { isoCode } }`, `presentmentCurrencyRate`, `shop { metafield(namespace:"$app:cellexia", key:"rewards") { jsonValue } }`.

Config selection: `cfg = mf.draft && cart.attribute._cx_preview === mf.ph && mf.ph ? mf.draft : mf.live`.
Market = `cfg.cm[country]` or "" ; `scopeOk(scope, market)` = mode !== 'selected' || markets includes market.

cart.lines run:
- If `discount.discountClasses` lacks PRODUCT → `{operations: []}`.
- Classify lines: gift (attribute present), protection (`product.id` numeric ==
  cfg.prot), sachet (hasAnyTag or variant in cfg.gt.pool), excluded (product
  id in cfg.ss.excl[market]), subscription (sellingPlanAllocation present).
- If `triggeringDiscountCode` (KIT node): require `cfg.ss.on && scopeOk`.
  Eligible = not gift, not protection, not sachet, not excluded, (not
  subscription unless cfg.ss.sub). distinct = |product ids of eligible|.
  qualifying = highest tier with n ≤ distinct. Grant ONLY if
  `qualifying && qualifying.c === triggeringDiscountCode`: one
  `productDiscountsAdd` with candidates targeting every eligible line
  (`cartLine {id}` full quantity), `percentage {value: p}`, message = cfg.ss.msg
  with {pct} substituted or `Set savings −p%`, `associatedDiscountCode
  {code}`, selectionStrategy FIRST. Else `{operations: []}` (Shopify reports
  the code not applicable).
- Else (automatic gifts node): require `cfg.gt.on && scopeOk(gt.scope)`.
  spend = Σ subtotalAmount over non-gift non-protection lines (Decimal). Tier
  amounts: `bm[market]` when its `c` equals the cart currency
  (lines[0].cost.subtotalAmount.currencyCode) else `tiers[i].eur ×
  presentmentCurrencyRate`. reached = highest index with amount ≤ spend (−1
  none). Granted variant set G = union of every option vid in slots of tiers
  ≤ reached (or == reached when !cum); allowed samples S = Σ n over "s"
  options of those tiers. For each gift line: if variant in G → candidate 100%
  qty 1; else if variant in pool and samples granted so far < S → candidate
  100% qty 1; else nothing (line stays paid). Cap total granted gift lines at
  cfg.gt.max. Message "Free gift". selectionStrategy FIRST? — use `ALL`?
  (ProductDiscountSelectionStrategy FIRST applies the first candidate only;
  we need every gift line discounted → emit ONE candidate per line inside ONE
  productDiscountsAdd with selectionStrategy ALL.) For the KIT node emit ONE
  candidate with multiple targets (FIRST is fine).
delivery run:
- If classes lack SHIPPING or `!cfg.fs.on || !scopeOk(fs.scope)` → `[]`.
- units = Σ (cfg.units[vid] || 1) × quantity over non-gift non-protection non-sachet lines; ok = (fs.min > 0 && units ≥ fs.min) || (fs.th && bm[market] && spend ≥ amount(bm[market]) ) where amount uses c==currency ? a : a × rate only when c is the shop currency (EUR) — otherwise skip.
- For every deliveryGroup: cheapest option with cost > 0 → candidate
  `{targets:[{deliveryOption:{handle}}], value:{percentage:{value:100}}, message:"Free shipping"}`; selectionStrategy ALL.
Package: `package.json` {name:"cellexia-rewards", dependencies:{"@shopify/shopify_function":"^2"}, scripts build/typegen}, `shopify.extension.toml` (type "function", `[extensions.build] command="" path="dist/function.wasm"`, `[extensions.ui] paths.create/details` omitted), `src/*.js` + `.graphql`, `schema.graphql` fetched by typegen is optional (do not commit generated types). Deterministic (no Date/Math.random). Unit tests in `validation/sims/rewards-function.mjs` importing the pure logic from `src/logic.js` (pure functions with plain input objects) so the harness runs them.

## 9. Checkout safety net (extensions/checkout-protection/src/Checkout.tsx — add a small hook, no new extension)

Reads `$app:cellexia/config.rewards` + preview. When `rewards.giftTiers.enabled`
(or preview draft) and not previewActive-without-rehearsal: for every line whose
attribute `_cellexia_gift` exists and whose `cost.totalAmount.amount > 0` after
discounts (i.e. not free) → `applyCartLinesChange({type:'removeCartLine', id,
quantity})` once (useStorage memory `cellexia_gift_removed_<lineId>` to avoid
loops). When `rewards.setSavings.enabled`, `instructions.discounts.canUpdateDiscountCodes`
and the checkout has NO discount codes at all: compute distinct eligible
products from lines (excluding gift lines, protection variant, sachets by
productType/tag unknown → skip tag rule; use `rewards.giftTiers.samplePool`
ids) and `applyDiscountCodeChange({type:'addDiscountCode', code})` once per
session (useStorage), never re-adding a code the buyer removed. Best effort;
all errors swallowed. `PreviewDiagnostic` line "gift not eligible" as per
existing pattern.

## 10. Preview (preview.server.ts, metafields.server.ts, proxy.preview-config.tsx, app.preview.tsx)

`PreviewDraftConfig` += `simCart?: { spendCents: number (0..100000000); count: number (0..50) }`,
`rehearsal?: boolean`, `rewards?: { setSavingsTiers?: SetSavingsTier[]; giftTiers?: GiftTier[]; giftAmountsByMarket?: Record<string,{amounts:number[],currencyCode:string}> }` (validated with the same sanitizers as settings; both duplicated validators updated). The rewards metafield `draft` = live shape rebuilt from settings + these overrides while armed. `preview-config` JSON gains `simCart`, `rehearsal`, and `rewardsForMarket: {ssTiers, gtAmounts:{a,c}, gifts:[{vid,handle,title}]}` for the simulated market. Preview Center: "Simulate cart" card (spend amount in the simulated market currency + products count, quick chips per tier), "Live rehearsal" checkbox, draft tier editors (reuse the admin components), readiness notes; FEATURE_GROUPS "Cart drawer" += set_savings, gift_tiers; PREVIEWABLE.

## 11. Admin (app/routes/app.features.rewards.tsx) — new page "Rewards"

Cards: Set savings (master, tier table, includeSubscriptions, surfaces,
checkoutMessage, per-market exclusions card (reuse the exclusions component),
"Connect KIT codes & discounts" button with "Replace existing KIT codes"
checkbox + result banner), Gift tiers (master, tiers editor: EUR amount +
slots + options with variant picker via `/app/api/variants` search + samples
count; cumulative/choice/max/sampleRule/showShippingMilestone; samplePool
with "Load sachets" (products tagged sample-sachet); per-market amounts table
(rows from listMarkets, currency = market base currency locked, "Suggest
amounts" fills from pricing); warehouse map (locations list via
`locations(first:20)`), stock floor, "Refresh stock" + stock table), Free
shipping guarantee (enabled, minUnits, byThreshold, MarketScope picker),
Market targeting card (both FeatureKeys, azReachCaption pattern). Register:
features hub (`app.features._index.tsx`), CONFIGURE_URL/GROUPS/MATRIX_GROUPS in
app.markets.tsx, FEATURE_GROUPS in app.preview.tsx, dashboard cards
(`app._index.tsx`), nav link in `app.tsx`.

## 11b. v14.1 polish (2026-08-16, deep-check follow-up)

Binding deltas on top of the sections above:

- **Spend excludes sachets** — `rwSpendCents()` (cart) and `spendOf()`
  (Function) skip sachet-classified lines as well as gift and protection
  lines; a €1 sachet never buys a tier or the shipping threshold. Sachets
  still never count as distinct products.
- **Gift-pool PRODUCTS are normal products** — only gift LINES
  (`_cellexia_gift`) and sachets are excluded from spend / distinct count /
  FBT / similar / cross-sell / the PDP buy-box row. A paid Jawline line
  earns the set saving everywhere (cart runtime and PDP agree); the PDP
  shows the row on a gift-pool product's own page and `azRwSkip` no longer
  consults `rw.giftPids` (the island member stays, harmless).
- **Gift plan ordering** — `rwGiftPlan` walks every reached tier's
  `variant` slots first, then `samples` slots (highest tier first), then
  applies the `maxGiftLines` cap — the headline gift is never the line the
  cap drops.
- **maxGiftLines default 6** (sanitizer range unchanged 1..8).
- **Strings** — `meter_gift_away` now names the gift ("You're {{ amount }}
  away from a free {{ gift }} (worth {{ value }})"); `gift_unavailable` =
  "Your free gift can't be applied to this order right now" (info level, not
  error); three keys appended: `meter_gift_away_plain` (used when the tier
  value is 0 / unknown or the headline slot is a sample set — never "worth
  €0.00"), `set_title_more` (cross-sell title once a KIT code is already
  active and the next tier is further away), `fbt_add_save_both` (FBT
  button for exactly two rows, mirroring `amazon.fbt_add_both`).
- **Nudge priority** — the "add N more" line renders only when a KIT saving
  is already active (distinct ≥ 2) OR the cart has no volume-upgrade
  candidate; for a 1-jar cart the ladder keeps priority and the set message
  lives in the cross-sell title only.
- **Meter** — equal-width segments (n milestones → n segments; fill = done
  segments + fractional progress inside the current one) with a
  `span.cx-rw-meter__cap` amount caption under each mark (done marks
  checked); the headline stays the only sentence.

## 12. Budgets & harness

- Liquid: BUDGET 96,500 → 99,500 (document in harness §1 comment: v14 rewards
  +≤3,000 B); per-file ceilings unchanged (30,000). Cap Shopify 102,400.
- Locales ≤ 15,200 B each (unchanged); en.default superset rule (24 rewards keys since v14.1).
- ES5 in the two theme assets (deploy-safety acorn) — `var`, no arrow/template
  literals/let/const/spread; `Object.keys`, `Array.prototype.forEach` fine.
- innerHTML forbidden except pinned sites → createElement/textContent only.
- Every new `cx-rw-*` class must be styled in cellexia-booster.css (§4 rule).
- New FeatureKeys need EVIDENCE markers `'data-cx-feature', 'set_savings'` /
  `'gift_tiers'` in cellexia-cart.js; 35 → 37 pins; FEATURE_GROUPS etc.
- New sims: `validation/sims/rewards-tiers.mjs` (twin cxRwTier/cxRwNext across
  both assets + tier fixtures), `validation/sims/rewards-function.mjs`
  (Function pure logic fixtures: KIT tier grant/refuse, gift grants, cum
  on/off, samples cap, draft selection, shipping units/threshold, wrong class).
- prover allowlist: any touched baseline-covered file needs its allowlist entry
  regenerated the documented way (validation/README.md).
- Line property prefix `_cellexia_` (webhook + extensions convention); cart
  attribute prefix `_cx_`.

## 13. Ownership (parallel build, no shared files)

A server: settings.server.ts, metafields.server.ts, rewards.server.ts (new),
webhooks.inventory.update.tsx (new), webhooks.orders.paid.tsx, analytics.server.ts,
health.server.ts, prisma/*, shopify.app.toml.example, proxy.cart-data.tsx (`s` flag),
markets.server.ts (if a helper is needed).
B function: extensions/cellexia-rewards/** (+ its sim file).
C admin: app/routes/app.features.rewards.tsx (new), app.features._index.tsx,
app.markets.tsx, app._index.tsx, app.tsx, app/components/* (new components only).
D cart storefront: cart-booster.liquid, cellexia-cart.js, cellexia-booster.css (cart section only).
E pdp storefront: amazon-booster.liquid, cellexia-pdp.js, cellexia-booster.css (append a clearly delimited `/* v14 rewards pdp */` block at the END; D appends its block before it — coordinate: D writes `/* v14 rewards cart */` block, E writes `/* v14 rewards pdp */` block, both appended at file end; run sequentially D then E to avoid clobbering).
F checkout + preview: checkout-protection Checkout.tsx, preview.server.ts, proxy.preview-config.tsx, app.preview.tsx (preview parts only), metafields.server.ts draft validator (coordinate with A: A owns the file; F sends the exact patch to apply → to avoid conflicts F edits ONLY `sanitizeDraftConfig` twins after A is done).
G locales: extensions/cellexia-booster/locales/*.json.
H harness/docs/zip: validation/**, UPDATE.md, INSTALL.md, README.md, docs/SPEC.md.
