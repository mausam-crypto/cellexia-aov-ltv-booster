# SPEC v23 — subscription liveness gate for proof-less surfaces

**Island member** `sx.live` (cart-booster.liquid) · **predicate** `subsLive()` (cellexia-cart.js) · **gated surfaces** v17.2 card-price decorator, switch-card keyword-less fallback · shipped 2026-09-16.

While the NEW subscription app (Cellexia Subscriptions) is in **setup**, or live in only
some markets, theme product cards on the home page and collection pages showed the
subscription-discounted price in **every** market. The merchant papered over it by
syncing 0% pricing policies — blocking real discount configuration until fixed.

## 1. Why the leak existed

v17.1 deliberately opens the `sx` data island in `setup` (`cellexia.launch_status`
present, either value) so the subscription app's own previews work end-to-end. The
safety argument was **per-shopper proof**: the cart cross-sell only activates off an
owned subscription line already in the cart, which a real shopper cannot hold while
the widget is dark. Two later surfaces reused the open gate WITHOUT such a proof:

- the **v17.2 card-price decorator** (swaps a theme card's `.product__price` text to
  the owned default-cadence allocation price), and
- the **switch card's keyword-less fallback** (offers an owned plan the merchant's
  keyword did not name — its own comment already promised "live + market + kill
  switch + ownership", but "live" was not literal).

Selling-plan allocations are market-blind and launch-blind on Shopify's side, so in
setup the discounted figure rendered everywhere the island did.

## 2. Design invariants

1. **The island is the only channel.** `sx.live` is a byte-exact mirror of the buy
   box's own launch gate: `shop.metafields.cellexia.launch_status.value | default:
   shop.metafields.cellexia.launch_status`, compared `== 'live'`. No other signal,
   no JS-side metafield fetches.
2. **Proof-less surfaces gate on `subsLive()`** — `subsAware() && cfg.sx.live ===
   true`. A missing/false member fails closed: an old cached island without the
   field behaves like setup.
3. **Cart cross-sell keeps `subsAware()`** — its per-shopper proof (owned plan line
   in the cart) is the v17.1 contract and previews in setup must keep working.
4. **Cached verdicts never cross the boundary.** The card-flags cache key's
   `s1`/`s0` side is derived from `subsLive()`, so cents resolved under a live
   context are never served after a revert-to-setup (and vice versa), on top of the
   existing market/currency/locale key parts.

## 3. Behavior matrix

| App state | Cards (home/collections) | Switch-card fallback | Cart cross-sell |
|---|---|---|---|
| SETUP (any market) | one-time price, always | refuses (no enrollment) | works off an owned line (previews) |
| LIVE, markets selected | subscription price inside enabled markets only | eligible inside enabled markets | unchanged |
| LIVE, unrestricted | v17.2 behavior | v17 behavior, now literally "live" | unchanged |

## 4. Enforcement

- Harness structural tripwires (v23 block): `subsLive` definition, the island
  member, the fallback swap, and cart cross-sell still on `subsAware`.
- `sims/badge-cards.cjs`: setup-mode scenario (island open, `live:false` → price
  untouched, `s0` cache side) and missing-member fail-closed scenario.
- `sims/subscribed-upgrade.cjs`: setup fallback refusal scenario.
- The three v17.2 pins now assert the `subsLive()` call sites verbatim.
