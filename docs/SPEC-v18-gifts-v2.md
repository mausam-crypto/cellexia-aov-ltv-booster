# SPEC v18 — Free gifts V2: country clusters, local-price thresholds, product-page surface

Binding contract for v18 (2026-09-09). Supersedes the gift half of
`SPEC-v14-rewards.md`; the set-savings half of v14/v15 is unchanged.

## 0. What changed and why

v14 shipped **one flat gift ladder** for the whole world, with per-MARKET
amount overrides. Three things were wrong with that for this store:

1. A Shopify market is the wrong unit. The store has both a `germany` market
   and an `eu` market listing Germany, and `rest-of-world` alone spans 37
   countries in a dozen currencies.
2. The store ships from different fulfilment centres holding different
   giveaway stock, so one ladder cannot be right everywhere.
3. The per-market amount suggester **skipped any market whose currency equals
   the shop currency**, so Finland (an explicit +15 % price-list adjustment in
   EUR) and the euro-denominated Rest Of World countries (+20 %) silently kept
   the flat EUR ladder. That was a live bug, not a v18 concern.

Separately, **gifts never appeared in the cart while previewing**, which made
the feature impossible to sign off. Root cause in §6.

## 1. Vocabulary

- **Cluster**: a named group of **countries** sharing one reward ladder,
  usually because they ship from the same warehouse. Exactly one cluster is
  the **catch-all** (`rest: true`) and covers every country not named
  elsewhere. A country belongs to at most one cluster, so resolution is total.
- **Spend**: unchanged from v14 — the sum of pre-discount line prices over
  lines that are not gifts, not the protection product and not sachets.
- **Local multiplier**: `localPrice / basePrice` for a reference product.
  **NOT a price premium**: it bundles the exchange rate with the market's own
  price-list adjustment. It is the correct multiplier only because a threshold
  is denominated in the same currency as the price it came from.

## 2. Settings (`app/models/settings.server.ts`)

```ts
export interface GiftCluster {
  id: string;          // slug, unique, never reused after a delete
  name: string;        // merchant-facing
  rest: boolean;       // exactly one; its `countries` is always emptied
  countries: string[]; // ISO-3166-1 alpha-2, uppercase, unique across ALL clusters
  locations: string[]; // Location GIDs serving this cluster (stock check)
  tiers: GiftTier[];   // 0..4, amounts strictly increasing, EUR
}
```

`rewards.giftTiers` **gains** `clusters`, `thresholdsByCountry`
(`ISO2 -> {amounts, currencyCode}`) and `pdp` (`{enabled, style}`).
It **loses** `tiers`, `giftPreset`, `giftThresholdsByMarket` and
`warehouseByMarket` (locations now live on the cluster that owns them).

Invariants `sanitizeGiftClusters` guarantees, and everything else relies on:

- ids unique and slug-shaped; a duplicate id drops the later cluster;
- a country claimed by an earlier cluster is dropped from later ones;
- **exactly one** `rest` cluster — the first claiming it wins, and if none
  does the LAST cluster is promoted, so a country added by Shopify tomorrow
  can never resolve to nothing;
- the rest cluster stores no countries.

`DYNAMIC_RECORD_KEYS` gains `thresholdsByCountry`; miss that and the record is
silently emptied on every load. `REWARDS_CAPS` gains `clusters: 8`,
`countriesPerCluster: 120`, `thresholdCountries: 260`, `locationsPerCluster: 6`.

### Migration

`coerceLegacyGiftClusters(settings, raw)` runs on the LOAD path (beside
`coerceLegacyProofDensities`, reading the RAW stored row because the merge has
already dropped the retired keys). It only acts on a pre-cluster row:

- gifts were never switched on → keep the shipped v18 presets;
- gifts WERE on → copy the merchant's live ladder into EVERY cluster, which
  reproduces v14 behaviour exactly.

Deliberately **not** migrated: `giftThresholdsByMarket` (market amounts cannot
be mapped to countries without an Admin API call, and the price-scaled
per-country defaults supersede them) and `warehouseByMarket`. Both are
regenerated from the admin.

## 3. Shipped clusters

| Cluster | Countries | Ladder |
|---|---|---|
| **Amphora** | ES, PT, IT, FR | €150 → 2 sachets · €200 → Bamboo Beauty Towel · €350 → 3 more sachets |
| **Active Ants** | DE, AT, DK, SE, FI, NO, IS, GR, IE, GB, GG, JE, CA, BR, MX, CL, AR, UY, AU, NZ, SG, HK, JP, KR, AE, SA, QA, KW, OM, IL, EG (31) | €150 → 2 sachets · €200 → Bamboo Beauty Towel · €350 → Premium Leather Cosmetic Bag + Advanced Cooling Mask |
| **Rest of world** (catch-all) | everything else | €200 → Bamboo Beauty Towel · €350 → Jawline Contour Tightening Cream |

Cumulative is on, so Amphora at €350 grants the towel plus **five** sachets
(2 from tier 1, 3 more from tier 3), which is six lines, exactly the
`maxGiftLines` default. Rest has no €150 tier, so its meter shows two
milestones and never an empty step.

## 4. Per-country amounts

Authored once per cluster in EUR, then scaled by each country's own price
level so "spend enough for roughly three jars" means the same thing
everywhere. `suggestGiftThresholds(admin, settings, countries)` is now
**per country**, samples **three** reference products and takes the **median**
ratio (Ireland overrides 27 individual product prices and the UK 9, so a
single sampled variant would swing a whole country's ladder).

`roundThreshold(value)` (in the settings model, so both the server and the
proof suites can use it) replaces the old three-band `niceRound` for
thresholds:

| amount | rounds to nearest | example |
|---|---|---|
| < 20 | 1 | |
| 20–99 | 5 | |
| 100–999 | 10 | **147 → 150** |
| 1,000–9,999 | 50 | kr 1,676 → kr 1,700 |
| 10,000–99,999 | 500 | ¥32,895 → ¥33,000 |
| 100,000+ | 5,000 | ₩286,842 → ₩285,000 |

Currency-agnostic by design, so yen, won and króna need no special case.

## 5. Delivery: server precomputes, Liquid indexes

New app-data metafield **`cellexia/gift_plan`** (json), built by
`buildGiftPlan()` in `app/services/gift-plan.server.ts` (its own module so the
live and preview paths can share it without an import cycle):

```jsonc
{ "t": "<iso>",
  "cc": { "ES": "amphora", ... },   // country -> cluster (named clusters only)
  "rest": "rest",                    // the catch-all id
  "cl":  { "amphora": { name, a[], t[][][], p[], cum, max, choice, rule, pool, ship } },
  "bc":  { "GB": { "a": [...], "c": "GBP" } },
  "pdp": { "on": true, "style": "card" } }
```

Both islands slice it with `cx_country`, so a browser only ever receives its
own cluster:

- cart: `#cx-rw-config` → `{"ss": …, "gt": cl[cluster], "gb": bc[country]}`
- product page: `#cx-gift-config` → `{"c": …, "b": …, "p": …}`, in its **own**
  script tag rather than inside `#cx-pdp-config`, so a Liquid problem in the
  gift data can only break the gift surface (the 2026-08-17 isolation lesson).

The plan is rewritten on **every** `refreshGiftStock`, not only when the paused
set moves, because it now carries the ladders too and gating on stock would
leave a stale ladder after a settings-only save.

**Discount Function**: `clusterFor(gt, country)` + `giftAmounts(gt, country,
currency, rate)`. Its GraphQL input already selected
`localization.country.isoCode`, so **no function input change was required**.
Gifts now follow the COUNTRY, not the market handle — that is the point of the
change, and `sims/rewards-function` pins it with a cart that discriminates the
two rules.

## 6. Why preview added nothing, and the fix

`rwMutable()` (`cellexia-cart.js`) returns
`PREVIEW.rehearsal === true && !rwSim()`. So a gift is only really added when
"Test with my real cart" is ticked **and** the cart simulator is off. Typing a
spend into the simulator therefore silently cancelled the rehearsal. The block
is correct — a pretend total must not buy a real free product — but nothing
said so.

- `rwGiftWhy()` returns one of **12 reason codes** naming what the gift pass
  did or why it could not act, rendered in the preview bar and refreshed after
  every render; also `window.CellexiaBooster.giftWhy()` on live pages.
  Its ORDER is load-bearing and pinned by `sims/gift-why`: below a threshold
  you see the distance, above it you see the simulator notice.
- The Preview Center shows a **critical banner with a one-click "Turn the
  simulator off"** when both controls are set.
- A **"Clear gifts"** button in the preview bar undoes a rehearsal.
- Preview simulates a **country** (carried in `draftConfig.country`, so no
  Prisma migration), and `rewardsPreviewSections` returns the same slice shape
  the live island carries, so preview and live cannot drift.

## 7. Surfaces

**Cart**: `rwRenderLadder` draws one card per gift tier under the meter track.
Unlocked cards keep their tick and stay full-strength; the next is emphasised;
later ones dim but stay readable. That is what communicates the cumulative rule
— with **no new copy to translate into 18 languages**. The strip scrolls
sideways so the meter can never grow tall enough to push checkout below the
fold.

**Product page**: its own on/off switch plus three placements, all cart-aware:

| style | where | why |
|---|---|---|
| `line` | buy box, above Add to cart | smallest footprint |
| `card` *(default)* | **below** Add to cart | gift thumbnail + progress bar; cannot push the button down the page |
| `ladder` | under the product title | the only one showing every tier |

Each picks the strongest applicable sentence: "Add this and unlock …" fires
whenever this product's price closes the gap, otherwise "You're €43 away …",
otherwise "Spend €200 and get …".

**Copy**: the three product-page sentences are English-only in
`cellexia-pdp.js` RW_DEFAULTS on purpose. Every locale file must carry the
same 24 rewards keys (18 files, harness-pinned), so a product-page-only string
cannot live in `en.default.json` without forcing 18 translations, and
machine-translating them would breach the standing rule that translated copy
reads natively. **They need the curated-copy pass before non-English markets
go live.**

## 8. Stock: fail open, not closed

`refreshGiftStock` is per CLUSTER (a cluster is a fulfilment centre) and the
state is `giftStock.byCluster`. The rule changed:

- a tracked level genuinely **below** the floor pauses the option;
- **no inventory row at all is unknown, not zero, and never pauses**
  (`UNKNOWN_AVAIL = -1`, shown as "unknown" in the admin).

The old code summed `byLocation[loc] ?? 0`, so a third-party warehouse with no
Shopify record read as empty and paused a real gift, silently deleting a whole
tier from the ladder.

## 9. Byte budget

Liquid is **99,383 B** against the 99,500 B budget (Shopify's cap is
102,400 B): **117 B spare**. v18 paid for itself by renaming the `cx_scope`
scratch variable to `cx_s` across all nine blocks (129 occurrences, 516 B, no
behaviour change) before spending anything. **The next Liquid work must diet
first.**

## 10. Proof

`npm run validate` → 29 suites, 8,901 checks. New:

- `sims/gift-why` (42) — the 12 reason codes, every branch reachable, the four
  orderings that make the diagnostic a narrative, and no em dashes in the copy.
- `sims/rewards-clusters` (186) — the server, the plan and the Function land on
  the same cluster for every country in a matrix that includes junk and
  casing; the local-amount currency rule; the rounding table; and that
  resolution stays total when a config ships no catch-all.
- `settings-derivation` gains the shipped cluster pins (ladders, country
  lists, no country in two clusters) and the v18 sanitizer proofs.
