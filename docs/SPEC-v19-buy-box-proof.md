# SPEC v19 — Buy-box proof block

**FeatureKey** `buy_box_proof` · **settings section** `buyBoxProof` · **admin page**
`/app/features/proof-block` · **marker** `data-cx-feature="buy_box_proof"` ·
**CSS prefix** `cx-bbp` · shipped 2026-09-09.

The merchant's CRO-designed proof stack, rendered directly under the theme's
Add-to-cart panel. One feature, one toggle, one market scope, one preview
draft flag — and one impression beacon.

## 1. What it renders (design order)

Inside `.pdp__grey`, chained after `.stock-msg` (the documented trust-badge
anchor; after `.cx-dispatch--pdp` when the countdown painted), as
`div.cx-bbp`:

| Row | Class | Fact source |
| --- | --- | --- |
| Ships from *Country* | `cx-bbp__ships` | `amazon.shipsFromByCountry[buyer] \|\| amazon.defaultWarehouse`, inflected through `AZ_SHIPS_FORMS` |
| Get it by *date* + "Delivery guarantee" pill | `cx-bbp__deliver` | the `deliveryEstimate` engine + `delivery.line` / `delivery.badge` |
| Icon strip | `cx-bbp__badges` | `buyBoxProof.badges` keys over the SHARED `badges` island member's index-aligned labels |
| *N*-Day money-back card | `cx-bbp__guarantee` | the shared `g` member (`guarantee.days`) |
| Stars + score + count + Trustpilot | `cx-bbp__rating` | the shared `tp` member (`trustpilot.*`) |

Then, as a SIBLING inserted directly after `.pdp__grey` (so it reads as its
own card, above `.pdp__accordions`), `div.cx-bbp-research`: the translated
"Based on published research from" eyebrow, the institution logos, and the
certification seal with its translated note.

## 2. One source of truth per fact

The block stores **no** second copy of a label, a day count, a rating or a
warehouse. `pdp-booster.liquid` widens the emission gates of the `badges`,
`g`, `tp`, `delivery` and `deliveryStrings` members to `or cx_bbp_on`, so
the data is on the page with the block alone enabled. Each legacy widget
keeps its OWN `live`/draft gate, so none of them paints.

Consequences that are deliberate:

* editing the guarantee window, the rating or the badge labels on
  **Trust & badges** changes the block too;
* the warehouse map lives on **Amazon patterns** and is honoured with
  `az_ships_from` itself switched off (a warehouse is a fact, not a feature),
  including its `shipsFromExcludedByMarket` product exclusions;
* the delivery date obeys the delivery engine's own fail-closed rules, the
  per-country `hidden` override and `excludedByMarket` (Liquid folds those
  into the `dl` flag).

## 3. Replacement rule (the az_microcopy precedent)

While the block is effective on a product page it OWNS the buy-box proof
area, so the widgets that would duplicate it there stand down — **with their
beacons** (a widget never painted is never counted):

`trust_badges`, `guarantee`, `trustpilot`, the PDP `delivery_estimate`
widget, `az_microcopy`, `az_ships_from`.

`dispatch_countdown` is a different message and is untouched. The suppressed
features keep their own settings and stay live everywhere else (cart,
checkout). Gating lives in exactly three places: `azOn()` (which keeps
`azWillReplace`/`azTpl` honest), `mountDelivery()`, and the classic
badge/guarantee/trustpilot chain in `init()`.

## 4. Fail-closed rules

Every row drops on its own; the block never shows half a promise.

* no island member, no settings payload (`"c": null` — a metafield written
  before v19), not live and not drafted, or no `.pdp__grey` anchor → nothing
  renders and nothing beacons;
* **ships**: no INFLECTED country form in `AZ_SHIPS_FORMS` for the page
  language → no row. A bare nominative is ungrammatical in the fusing
  languages, so a wrong sentence is never preferred to no sentence;
* **delivery**: `dl !== true`, no resolvable date, or a missing string → no
  row;
* **badges**: unknown keys dropped, `free_shipping_over` dropped without a
  safe amount (`badges.fs`), no keys → no strip;
* **research**: blank institution names dropped; nothing to say (research off
  and seal off) → the whole band is absent.

## 5. Copy and translation

Two new locale keys, translated in all 17 store languages:
`badges.research` ("Based on published research from") and `badges.seal`
("Independent testing. Proven skin tolerance."). Everything else reuses
existing translated strings (`amazon.ships_from`, `delivery.line`,
`delivery.badge`, `badges.*`, `guarantee.title`, `trustpilot.*`).

Institution names are merchant free text and stay **untranslated** — proper
nouns, the `US_STATE_NAMES` precedent. The certification seal's own wording
is a MARK and is not translated either (the Trustpilot wordmark precedent);
only the note beside it is.

`el.json` (15,184 B) and `ar.json` (15,190 B) sit against the 15,200 B
harness pin (Shopify hard-rejects at 15,360 B). Room for these two keys came
from applying the merchant's standing no-em-dash rule to both files plus a
handful of shorter, equally faithful phrasings. **Any further Greek or
Arabic copy must trim existing copy first.**

## 6. Logos and the seal

`research.institutions` is up to 6 `{ name, imageUrl }` rows. `imageUrl` is a
sanitized `https://` URL (Shopify Files) — the app ships **no third-party
logo artwork of its own**; a blank URL renders the name as a plain wordmark.

* every row has a logo → the single row with vertical rules, equal cells,
  each mark at its own aspect ratio inside a 52 px-tall cell
  (`cx-bbp-research__logos--row`);
* any row is a text wordmark → the marks stack (a wrapped row shows a stray
  leading rule, which reads as a rendering bug).

`seal.imageUrl` replaces the built-in DermaCert artwork, which is otherwise
drawn as a static inline SVG (one of the harness-annotated `innerHTML`
sites; sharp at any size, no extra request). The translated note is the
seal's `alt` text.

## 7. Admin

`/app/features/proof-block`: master toggle, per-row switches, badge picker
with ordering, the institution list with a **storefront-size preview** of
each uploaded logo, the seal, and the market scope. A banner names every
feature the block takes over and links to the pages that own the borrowed
facts; per-row warnings fire when no warehouse is mapped or the delivery
windows look incomplete. The caps travel through the loader — a route's
client bundle may not reference `settings.server` values at module scope
(the v8.3 build lesson).

## 8. Budgets paid, not moved

* **Liquid** 99,331 / 99,500 B. The block's ~1.0 KB of gates + island was
  paid for FIRST by deleting the 967 B `{% comment %}` from
  `proof-booster.liquid` (content moved to `docs/theme-integration.md`,
  matching every other comment-free block) and by de-duplicating five
  identical schema `info` strings. The v14 pin did not move.
* **Locales** el 15,184 B / ar 15,190 B ≤ 15,200 B pin.
* **FeatureKeys** 37 → 38, appended at the END so every index-based consumer
  keeps its positions.

## 9. Validation

`validation/sims/buy-box-proof.cjs` (75 checks, 6 mutants) runs the real
builders: design order, both mount points, fail-closed rules, ships-from
grammar in en/pl/ja incl. the sentinel-leading sentence, borrowed facts,
badge ordering, research row-vs-stack, beacon honesty, preview draft.
`validation/sims/az-split.cjs` gained the B-series proving the az
suppression (and that a not-live or payload-less block suppresses nothing).
