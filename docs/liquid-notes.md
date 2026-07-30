# Liquid extension notes (v6.2)

Documentation moved out of `extensions/cellexia-booster/*.liquid` in the v6.2
"Liquid diet" (Shopify caps total Liquid per theme app extension at 100KB).
Each file keeps one terse `{% # ... %}` pointer per removed block; the full
original text is preserved verbatim below.

> **v6.2 divergence note (deliberate, safer):** the widgets migrated from
> Liquid `<template>`s to JS builders route every dynamic value through
> `textContent` (t-filtered JSON strings pass `decodeEntities`; raw-json
> merchant fields such as the survey methodology do not). A locale string or
> merchant field that contains HTML markup therefore renders as literal text,
> where the v6.1 templates would have parsed it as elements. This closes a
> latent injection vector (e.g. the verifier name t-param) and is invisible
> for all current locale content — a markup-in-locale report against these
> widgets is this hardening, not a regression.
>
> **v6.2 az standalone fix:** `amazon-booster.liquid` re-emits the dispatch
> schedule + per-country delivery config (and the two `dispatch.*` strings)
> under `az_any_delivery`, exactly as v6.1 shipped — the embed must stand
> alone so `az_delivery_line` (and its "Order within…" clause) renders when
> the classic delivery estimate / dispatch countdown are off, hidden on the
> PDP surface, or market-scoped out. `azGapFillConfig()` still prefers the
> classic `#cx-pdp-config` island when both emit; the az copies carry no
> `live` field, so they can never mount the classic widgets.

## pdp-booster

_Source: `extensions/cellexia-booster/blocks/pdp-booster.liquid`_

### pdp-booster — block 1 (now: "PDP booster embed (v3-v6.1). Full docs: docs/liquid-notes.md#pdp-booster")

```
Cellexia Booster — PDP booster app embed (target: body).
Only active on product templates. Renders hidden, fully translated
<template> fragments; assets/cellexia-pdp.js clones them into the PDP
(.pdp__grey after .stock-msg, and after the sm-rc-widget container for the
subscription nudge). Graceful no-op when the selectors are missing.
Every widget requires its feature flag to be explicitly true — a missing
config metafield renders NOTHING (no config JSON, no templates, no CSS/JS
tags): missing config = hidden (safe default).
Market gating: a widget is visible only when its flag is on, its block
setting is on, AND its cfg.marketScopes entry matches the current market
(nil scope or mode "all" match everywhere; mode "selected" requires this
market's handle; an empty handle matches only non-selected scopes). The
market handle is exposed to cellexia-pdp.js via data-cx-market on the
config script tag for beacon attribution.

SPEC v3 — five PDP trust boosters (proof stack). Each is additionally
gated per product via the cellexia.pdp_flags JSON metafield (missing key
= true, only an explicit false hides) and, for the content widgets, on
the referenced metaobject content actually existing:
  derm_survey            settings-driven (cfg.dermSurvey numbers/verifier)
  clinical_study         cellexia.clinical_study metaobject reference
  verified_before_after  cellexia.before_afters list (non-empty)
  batch_transparency     cellexia.batch_transparency metaobject reference
  empty_bottle_guarantee settings-driven (cfg.emptyBottleGuarantee.days)
All merchant metaobject text renders TRANSLATED automatically per
storefront language (Translate & Adapt). cellexia-pdp.js clones the
templates in CRO order into a .cx-proof-stack container inserted before
.pdp__tabs (or after it when the placement setting says below_tabs).
```

### pdp-booster — block 2 (now: "Tokenless preview: cx_draft_* can only be true when armed")

```
  SPEC v4 preview. cfg.preview comes from the app-data metafield and is
  TOKENLESS ({ armed, draftFlags }). Every cx_draft_* boolean can only
  become true when preview is armed, so every draft-marked template
  emission below is provably dead when disarmed and the rendered page
  stays byte-identical to v3.
```

### pdp-booster — block 3 (now: "v4 dedup: single emission, data-cx-draft only in the armed draft-only case")

```
    SPEC v4 dedup (Shopify 100KB Liquid limit): every widget template
    below is a SINGLE emission gated on (live OR armed-draft). The
    opening tag adds data-cx-draft="1" via an inline unless-guard on the
    live boolean, so the marker appears ONLY when the template renders
    for the armed draft-only case: a disarmed page stays byte-identical
    to the former live twin and an armed preview sees exactly the former
    draft twin (cellexia-pdp.js consumes data-cx-draft unchanged). All
    cx_draft_* are provably false when preview is disarmed, so the
    merged gates reduce to the v3 live gates.
```

### pdp-booster — block 4 (now: "nil items = default badge list; saved-empty = no template")

```
      Fall back to the default badge list only when no list was ever saved
      (trustBadges.items absent). An explicitly-saved empty array means the
      merchant deselected every badge, so no template is rendered at all.
```

### pdp-booster — block 5 (now: "free_shipping_over renders only with a presentment-formattable threshold")

```
              `money` formats in the buyer's presentment currency without
              converting, so the badge renders only when a threshold in that
              exact currency exists: the market's byMarket entry, or the
              global shop-currency threshold when presentment == shop
              currency (cx_fs_badge_ok / cx_fs_badge_money, precomputed).
```

### pdp-booster — block 6 (now: "v3 proof stack, server-translated, cloned in CRO order")

```
    ------------------------------------------------------------------
    SPEC v3 proof stack templates. Rendered fully translated server-
    side (real t: params — no sentinel re-substitution needed, nothing
    is rewritten by JS). cellexia-pdp.js clones them in CRO order:
    derm_survey → clinical_study → verified_before_after →
    batch_transparency → empty_bottle_guarantee.
    ------------------------------------------------------------------
```

### pdp-booster — block 7 (now: "v5.8 five survey formats; live fmt in deduped tpl, draft fmt in alt tpl")

```
      SPEC v5.8 — five merchant-selectable survey display formats. All
      share the same data (survey_yes / survey_total / survey_pct,
      fail-closed via survey_ok above), the same accessible "How the
      survey was conducted" disclosure and the same verifier chip. The
      LIVE format renders inside the deduped cx-tpl-pdp-survey template;
      the DRAFT format (armed preview payload only) renders in the
      always-draft alt template further below. The
      presentation is a survey visualization, never a certification mark.
```

### pdp-booster — block 8 (now: "Armed-only ALT survey template for the draft format")

```
    v5.8 preview-only ALT survey template. Every emission byte lives
    strictly inside the armed gate, so the DISARMED page stays
    byte-identical for real visitors. Renders the DRAFT format from the
    tokenless armed payload (cfg.preview.draftConfig.dermSurveyFormat)
    when it is one of the five valid formats AND differs from the live
    format; cellexia-pdp.js prefers this template over cx-tpl-pdp-survey
    only inside a verified preview session. The id is deliberately NOT a
    substring collision with cx-tpl-pdp-survey.
```

### pdp-booster — block 9 (now: "weeks fragment pre-composed via pluralized study.weeks_count")

```
            The week fragment is pre-composed via the pluralized
            study.weeks_count key so every locale inflects the counted
            noun correctly, then interpolated as {{ weeks }}.
```

### pdp-booster — block 10 (now: "days fragment pre-composed via pluralized bottle.days_count")

```
            The day fragment is pre-composed via the pluralized
            bottle.days_count key so every locale inflects the counted
            noun correctly, then interpolated as {{ days }}.
```

### pdp-booster — block 11 (now: "v4.9 guarantee-check modal; facts are merchant-entered only")

```
    v4.9 guarantee-check modal. Hidden, fully server-translated template
    cloned on demand by cellexia-pdp.js when the bottle widget's
    "Guarantee check" button is clicked (in-page dialog — no navigation,
    no external URL). Rendered whenever a bottle template (live or draft)
    exists, so the trigger always has content; disarmed byte-parity holds
    because cx_draft_bottle is provably false when preview is disarmed.
    The trust section lists ONLY merchant-entered company facts from the
    guarantee_fact_1..4 block settings — the app never invents claims;
    the whole section disappears when all four are blank.
```

### pdp-booster — block 12 (now: "Dispatch shell: JS engine owns text + visibility")

```
    Dispatch countdown (v5.0) — markup SHELL only: the ticking text is
    computed and set via textContent by the engine in cellexia-pdp.js,
    which alone decides visibility (working day + cutoff today + within
    showWithinHours, all in the warehouse timezone; any error = hidden).
    Same single-emission live/draft pattern as every widget above.
```

### pdp-booster — block 13 (now: "Delivery shells: fail-closed JS engine; alt tpl is armed-only")

```
    Delivery estimate + guarantee (v5.9) — shells only: dates land via
    textContent from the fail-closed engine in cellexia-pdp.js; the alt
    draft-format template is emitted STRICTLY inside the armed gate.
```

## cart-booster

_Source: `extensions/cellexia-booster/blocks/cart-booster.liquid`_

### cart-booster — block 1 (now: "Cart booster embed (v1-v6.1). Full docs: docs/liquid-notes.md#cart-booster")

```
Cellexia Booster — Cart booster app embed (target: body). The flagship.
Renders a JSON config blob + fully translated <template> fragments; all
behavior lives in assets/cellexia-cart.js (injected between
.mini-cart__list and .mini-cart__footer so it survives refreshMiniCart).
Gating is two-level: a missing config metafield renders NOTHING at all
(no beacon, no config JSON, no templates, no CSS/JS tags): missing
config = hidden (safe default). When the config exists, a tiny inline
session beacon always runs — one "session" event per browser session,
the experiment tracker's conversion denominator — independent of any
feature flag; the cart widgets (config JSON, templates, CSS/JS) stay
master-gated on cartUpsell.enabled == true.
Market gating: each cart feature key (cart_volume_upsell, free_shipping_bar,
cart_subscription_upsell, cart_trust_row) is visible only when its sub-flag
is on AND its cfg.marketScopes entry matches the current market (nil scope
or mode "all" match everywhere; mode "selected" requires this market's
handle; an empty handle matches only non-selected scopes). The per-market
booleans are precomputed HERE and emitted as `effective` in the config JSON
— cellexia-cart.js consumes them as-is, no scope logic in JS. The legacy
settings.show* keys carry the same market-aware values for back-compat.
v4.8: cart_cross_sell is a STANDALONE master (cfg.cartCrossSell.enabled —
NOT under the cartUpsell master): the outer gate ORs it, its per-market
effective boolean ("crossSell") follows the same scope pattern, and its
#cx-tpl-crosssell template renders the hand-picked products via
all_products so prices are presentment-correct.
v4.9: cfg.cartCrossSell.mode ("auto" default | "manual") ships to the JS
as settings.crossSellMode. "manual" keeps the template-clone path below;
"auto" builds rows in JS from /recommendations + the app proxy, so the
template may render with zero items in auto mode (harmless — the JS
ignores it). The strings map additionally exports crosssell.title and
crosssell.add (the auto rows are createElement-built) and the overrides
map exports the title override as crossSellTitle.
v6.0: delivery estimate joins the cart surface — the SAME
delivery_estimate feature as the v5.9 PDP widget (cfg.deliveryEstimate
master + showInCart surface flag + buyer-country hidden flag + market
scope), with its own formatCart display format. The config JSON ships
the identical "delivery"/"deliveryStrings" shape the PDP block emits,
and the twin fail-closed engine in cellexia-cart.js renders the widget
right after the dispatch countdown (urgency then reassurance, above
the shipbar).
v6.1: two Amazon-PATTERN cart features (conventions only — never the
Amazon brand). az_cart_free_line (cfg.amazon.cartFreeLine): a green
declarative threshold sentence at the very TOP of the booster root,
computed from the SAME per-market threshold machinery as the shipbar;
while it actually renders, the shipbar keeps its progress bar but drops
its own text line. az_cta_count (cfg.amazon.ctaCount): the JS
decorates the THEME's checkout buttons with a plural-correct
"Proceed to checkout (N items)" label — no template, text swap only,
original label stored once and restored when not effective. Both are
standalone masters joined to the outer gate OR, both market-scoped via
cfg.marketScopes.az_cart_free_line / .az_cta_count, both previewable
via the standard draft flags. The cta_count strings ship as a CLDR
plural KEY GROUP passthrough ("amazon.cta_count.<category>" — one
entry per category, sentinel @@COUNT@@): categories a language does
not define arrive as Shopify "Translation missing:" markers and the
JS discards them (fail closed — the theme label stays untouched
rather than ever showing a broken string). The en amazon.* keys are
owned by the PDP/locales work — this file only references them.
```

### cart-booster — block 2 (now: "Buyer-country delivery row resolved once; hidden gates live AND draft")

```
Delivery estimate (v6.0): the buyer country's byCountry row is resolved
ONCE here — its hidden flag gates the cart surface live AND draft
(exactly like the PDP block), and the row itself ships as .override in
the config JSON below so the JS resolver owns the merge.
```

### cart-booster — block 3 (now: "Tokenless preview: cx_draft_* can only be true when armed")

```
SPEC v4 preview. cfg.preview comes from the app-data metafield and is
TOKENLESS ({ armed, draftFlags }) — the raw token never reaches page-
visible Liquid. Every cx_draft_* boolean below can only become true when
preview is armed, so every draft-marked template emission is provably
dead when disarmed and the rendered page stays byte-identical to v3.
```

### cart-booster — block 4 (now: "v4 dedup: single emission, data-cx-draft only in the armed draft-only case")

```
  SPEC v4 dedup (Shopify 100KB Liquid limit): the trust-row and
  cross-sell templates below are SINGLE emissions gated on
  (live-effective OR armed-draft). The opening tag adds
  data-cx-draft="1" via an inline unless-guard on the live-effective
  boolean, so the marker appears ONLY for the armed draft-only case
  (drafted on, or live-ignoring-scope for market simulation): identical
  markup marked inert. Real visitors' JS never reveals a draft-marked
  template — the effective.* booleans stay false — only a
  server-verified preview session clones it, and a disarmed page
  renders bytes identical to the former live twin.
```

### cart-booster — block 5 (now: "v4.8 hand-picked cross-sell via all_products; JS enforces max/in-cart")

```
  Cart cross-sell (v4.8). Hand-picked items from cfg.cartCrossSell.items
  ({ variantId (GID), handle }) rendered via all_products so price /
  compare-at / availability are live and presentment-correct. Liquid
  renders at most 8 <li>s; the JS hides in-cart products and enforces
  settings.crossSellMaxItems. Missing product (csp.id nil), missing
  variant or unavailable variant => the item is silently skipped. Same
  single-emission live/draft pattern as the trust row above.
```

### cart-booster — block 6 (now: "Dispatch shell (surface-specific id): JS engine owns text + visibility")

```
  Dispatch countdown (v5.0) — markup SHELL only: the ticking text is
  computed and set via textContent by the engine in cellexia-cart.js,
  which renders it at the TOP of the widget root (above the shipbar)
  and alone decides visibility (working day + cutoff today + within
  showWithinHours, all in the warehouse timezone; any error = hidden).
  Same single-emission live/draft pattern as the templates above. The
  id is surface-specific (cx-tpl-dispatch-cart vs the PDP block's
  cx-tpl-dispatch) — this embed renders on product pages too, so a
  shared id would collide with the PDP template.
```

### cart-booster — block 7 (now: "v6.0 cart delivery shells, surface-specific ids; alt tpl is armed-only")

```
  Delivery estimate + guarantee (v6.0) — CART surface of the v5.9 PDP
  feature, shells only: dates land via textContent from the fail-closed
  twin engine in cellexia-cart.js, which renders the widget directly
  after the dispatch countdown (urgency then reassurance, above the
  shipbar). The format is deliveryEstimate.formatCart — each surface
  picks its own. Ids are surface-specific (cx-tpl-delivery-cart /
  cx-delivery-tip-cart): this embed renders on product pages too, so
  shared ids would collide with the PDP block's, and the JS re-ids the
  tooltip per clone (drawer + cart page can mount simultaneously).
  Same single-emission live/draft pattern as the templates above; the
  alt draft-format template is emitted STRICTLY inside the armed gate.
```

### cart-booster — block 8 (now: "v6.1 az free-shipping line: both states in one template, JS reveals one")

```
  Amazon-pattern free-shipping sentence (v6.1, az_cart_free_line) —
  BOTH states ship in one template: the qualified line carries its
  translated sentence baked in (green, check icon), the unqualified
  line is an empty shell the JS fills from strings["amazon.add_more"]
  (textContent + a <strong> amount — same @@AMOUNT@@ split as the
  shipbar). The JS reveals exactly one state, computed from the SAME
  per-market threshold + cart-total machinery as the shipbar, and
  while this widget actually renders the shipbar drops its own text
  line (the progress bar remains, directly below the sentence). Same
  single-emission live/draft pattern as the templates above. NO
  Amazon wording/trade dress — pattern only.
```

## amazon-booster

_Source: `extensions/cellexia-booster/blocks/amazon-booster.liquid`_

### amazon-booster — block 1 (now: "v6.1 Amazon-pattern PDP embed (8 az widgets). Full docs: docs/liquid-notes.md#amazon-booster")

```
Cellexia Booster — Amazon-pattern PDP app embed (target: body). v6.1.
Carries the NINE Amazon-pattern product-page widgets (az_buy_box,
az_microcopy, az_delivery_line, az_stock_line, az_ships_from — the
v6.8 split-out "Ships from {country}" line — az_bought_count,
az_bestseller_badge, az_fbt, az_similar_items) as hidden, fully
translated <template> fragments plus a config JSON; all behavior lives
in assets/cellexia-pdp.js (the az module in the same IIFE as the
classic PDP widgets — same engines, same preview machinery). The two
cart-surface az features (az_cart_free_line, az_cta_count) live in
cart-booster.liquid / cellexia-cart.js, not here.

IMPORTANT (deploy): this is a NEW app embed — it must be enabled once
in the theme editor before any az_* widget can appear (see UPDATE.md).
pdp-booster.liquid is at its harness byte pin and carries NOTHING new.

We model Amazon's PATTERNS (layout, ordering, color conventions,
microcopy structure) — never their brand: the words "Amazon" /
"Prime" / "Amazon's Choice", the smile mark and their exact badge
trade dress are forbidden in rendered output, and every string below
comes from the translator-owned `amazon` locale group.

Gating (same house rules as pdp-booster.liquid):
- missing config metafield renders NOTHING (safe default);
- every widget requires its cfg.amazon.* flag to be explicitly
  true (all default OFF), its embed show_az_* setting, and its
  cfg.marketScopes[az_*] entry to match the current market;
- SPEC v4 preview: single-emission dedup templates — each template is
  emitted when (live-effective OR armed-draft) and carries
  data-cx-draft="1" only in the armed draft-only case, so a disarmed
  page stays byte-identical to the all-live-gates rendering and real
  visitors can never see a draft (cellexia-pdp.js widgetAllowed).
  Armed drafts follow the market-simulation rule (draft flag OR live
  master ignoring scope). All cx_draft_az_* are provably false when
  preview is disarmed.
- honesty guards evaluated HERE and re-checked in JS: the bought
  count renders only when merchant-set, > 0 and no older than 45
  days; the bestseller pill only with merchant-entered rank AND
  category; the delivery line only when the free-shipping threshold
  is formattable in the buyer's presentment currency (the over-X
  clause is mandatory whenever a threshold exists — never a bare
  "FREE delivery"); the stock line's availability comes from the
  theme's real variant data in JS, fail closed.

Replacement semantics (enforced by the az module in cellexia-pdp.js,
keyed on the same effective/preview helpers so verified preview
sessions see the swap):
- az_delivery_line suppresses the standard PDP delivery_estimate
  widget AND the PDP dispatch_countdown line while effective;
- az_microcopy suppresses the app-injected PDP trust-badges strip
  (a theme-editor-placed trust block must be removed manually);
- az_stock_line (green "In Stock") and az_ships_from ("Ships from
  {country}", v6.8 split — own toggle + own market scope) EACH hide
  the theme's own .stock-msg while effective (either alone, or both
  for the combined pre-split look) and restore it on unavailability /
  preview exit; az_ships_from fails closed without a resolvable
  warehouse;
- az_cta_count / az_cart_free_line replacements live in the cart
  surface, not here.

Config contract consumed below (written by the app — the Liquid key
paths EQUAL the BoosterSettings paths, the classic cfg.cartUpsell /
cfg.trustBadges convention; syncSettingsToMetafields serializes the
settings object as-is):
  cfg.amazon.buyBox, cfg.amazon.microcopy, cfg.amazon.deliveryLine,
  cfg.amazon.stockLine, cfg.amazon.shipsFrom (v6.8), cfg.amazon.boughtCount,
  cfg.amazon.bestsellerBadge, cfg.amazon.fbt, cfg.amazon.similarItems
  (independent booleans, all default OFF); cfg.amazon.shipsFromByCountry
  Record<buyerISO2, warehouseISO2> + cfg.amazon.defaultWarehouse +
  cfg.amazon.shipsFromDefault (plain-label fallback for az_microcopy);
  marketScopes under the az_* keys; preview.draftFlags under the az_*
  keys.
Per-product data from the cellexia.pdp_flags JSON metafield:
  boughtCount (int), boughtCountSetAt (ISO date), bestsellerLabel
  ({ rank, category } | null), fbtManual ([{ variantId, handle }],
  empty = auto recommendations).
```

### amazon-booster — block 2 (now: "v4 dedup templates; JS-composed strings flow through sentinel maps only")

```
    Templates below follow the SPEC v4 dedup model: single emission,
    data-cx-draft="1" only in the armed draft-only case, consumed by
    cloneTemplate/widgetAllowed in cellexia-pdp.js. All visible text
    is server-rendered through the `amazon` locale group; the only
    JS-composed strings flow through the sentinel maps above and
    reach textContent exclusively.
```

## trust-badges

_Source: `extensions/cellexia-booster/blocks/trust-badges.liquid`_

### trust-badges — block 1 (now: "Trust badges app block. Full docs: docs/liquid-notes.md#trust-badges")

```
Cellexia Booster — Trust badges app block (target: section).
Reads app.metafields.cellexia.config.value; renders ONLY when
trustBadges.enabled is explicitly true AND the trust_badges market scope
matches the current market. Missing config = hidden (safe default).
```

### trust-badges — block 2 (now: "free_shipping_over renders only with a presentment-formattable threshold")

```
        `money` formats in the buyer's presentment currency without
        converting, so the badge renders only when a threshold in that
        exact currency exists: the market's byMarket entry, or the global
        shop-currency threshold when presentment == shop currency
        (cx_fs_badge_ok / cx_fs_badge_money, precomputed above).
```

## clinical-results

_Source: `extensions/cellexia-booster/blocks/clinical-results.liquid`_

### clinical-results — block 1 (now: "Clinical results stat band. Full docs: docs/liquid-notes.md#clinical-results")

```
Cellexia Booster — Clinical results stat band app block (target: section).
Stats (value / suffix / labelKey) come from the config metafield; block
settings can override each stat label per instance. Renders ONLY when
clinicalResults.enabled is explicitly true AND the clinical_results market
scope matches the current market. Missing config = hidden (safe default).
The hardcoded default claims apply ONLY when the stats field is nil
(config predates it); an explicitly-saved EMPTY stats array hides the
whole block — no orphan eyebrow/title/footnote, no impression beacon.
```

### clinical-results — block 2 (now: "Defaults matching DEFAULT_SETTINGS.clinicalResults.stats")

```
 Defaults matching DEFAULT_SETTINGS.clinicalResults.stats 
```

## trustpilot

_Source: `extensions/cellexia-booster/blocks/trustpilot.liquid`_

### trustpilot — block 1 (now: "Trustpilot rating block. Full docs: docs/liquid-notes.md#trustpilot")

```
Cellexia Booster — Trustpilot rating app block (target: section).
Rating / review count / profile URL come from the config metafield and can
be overridden per block instance. Renders ONLY when trustpilot.enabled is
explicitly true AND the trustpilot market scope matches the current market.
Missing config = hidden (safe default).
```

### trustpilot — block 2 (now: "v5.1 showLink: explicit false drops the link; else path keeps markup verbatim")

```
    v5.1: cfg.trustpilot.showLink — an explicit false drops the profile
    link line (the stars/rating/count above render exactly as before,
    just not linked). Inverted test on purpose: missing/true takes the
    else path, which carries the existing markup VERBATIM, so the
    default render stays byte-identical.
```

## subscription-nudge

_Source: `extensions/cellexia-booster/blocks/subscription-nudge.liquid`_

### subscription-nudge — block 1 (now: "Subscription nudge block (B2B hidden). Full docs: docs/liquid-notes.md#subscription-nudge")

```
Cellexia Booster — Subscription nudge app block (target: section).
Promotes the Joy "Continuous Treatment Plan". Hidden for B2B customers;
renders ONLY when subscriptionNudge.enabled is explicitly true in the
config metafield AND the subscription_nudge market scope matches the
current market. Missing config = hidden (safe default).
```

## guarantee

_Source: `extensions/cellexia-booster/blocks/guarantee.liquid`_

### guarantee — block 1 (now: "Money-back guarantee block. Full docs: docs/liquid-notes.md#guarantee")

```
Cellexia Booster — Money-back guarantee app block (target: section).
Renders ONLY when guarantee.enabled is explicitly true in the config
metafield AND the guarantee market scope matches the current market.
Missing config = hidden (safe default).
```

## cx-icons

_Source: `extensions/cellexia-booster/snippets/cx-icons.liquid`_

### cx-icons — block 1 (now: "Inline SVG icons: icon, size (20), class. Monochrome currentColor 20x20")

```
Cellexia Booster — inline SVG icon set.
Usage: {% render 'cx-icons', icon: 'lock' %}
Optional: size (px, default 20), class (extra CSS class).
All icons are monochrome (stroke/fill: currentColor), 20x20 viewBox.
```

## cx-trustpilot-stars

_Source: `extensions/cellexia-booster/snippets/cx-trustpilot-stars.liquid`_

### cx-trustpilot-stars — block 1 (now: "5-star row w/ fractional fill: rating, uid, size (20), color, empty")

```
Cellexia Booster — Trustpilot-style 5-star row with fractional fill.
Usage: {% render 'cx-trustpilot-stars', rating: 4.8, uid: block.id %}
Params:
  rating (number 0-5, required — defaults to 0)
  uid    (string used to namespace SVG gradient ids; default 'cx')
  size   (star size in px, default 20)
  color  (filled-star color, default Trustpilot green #00b67a)
  empty  (empty-star color, default #d8d8d8)
```


## Inner {% liquid %} comments removed in Tier 2

### blocks/pdp-booster.liquid

```
comment
SPEC v3 proof-stack widgets. Per-product opt-out: pdp_flags JSON
metafield — a missing metafield/key means TRUE (opted in); only an
explicit false hides. Content widgets additionally require their
metaobject content to exist (empty content = nothing to prove =
hidden, no orphan headings, no beacon).
endcomment
```

```
comment
SPEC v5.8 derm survey numbers. Percent = round(yesCount / sampleSize
* 100). FAIL CLOSED for live AND draft: non-positive or inconsistent
numbers (yesCount > sampleSize) render NOTHING — the app never
fabricates or massages survey data.
endcomment
```

```
comment
Dispatch countdown (v5.0). The schedule is resolved server-side per
BUYER COUNTRY: cfg.dispatch.byCountry[ISO2] overrides the default
cutoff/timezone/days wholesale (sanitizeSettings guarantees complete
entries). Live-effective = master enabled AND the showOnPdp surface
flag (missing = true) AND market scope. The credibility rules (only
when the cutoff is TODAY, a working day, within showWithinHours) are
enforced by the JS engine from this schedule — any invalid data
fails closed to hidden.
endcomment
```

```
comment
Delivery estimate (v5.9): Liquid picks the buyer country's byCountry
row and gates on hidden (live AND draft); the JS engine resolves and
validates everything else, fail-closed.
endcomment
```

```
comment
SPEC v4.5: per-market free-shipping threshold. When the current market
has a byMarket entry whose currencyCode equals the cart's presentment
currency, `money` formats its amount correctly — render it. Otherwise
fall back to the global shop-currency threshold, which is only safe to
render when the presentment currency IS the shop currency (the
pre-v4.5 skip-when-mismatch semantics).
endcomment
```

```
comment
SPEC v4 preview drafts. A widget is draft-rendered (inert hidden
template carrying data-cx-draft="1") when preview is armed AND its
embed show_* setting is on AND (its draftFlags entry is exactly
true OR its live flag is on ignoring market scope — market
simulation needs a template for widgets live only in the simulated
market). Per-product pdp_flags and content-present checks still
apply — a draft flag cannot conjure missing content, and a draft
can never show a widget the embed settings hide. All cx_draft_*
stay false when disarmed.
endcomment
```

```
# Ring arc length for the seal: percent of the r=45 circle's
# circumference (2 * pi * 45 = 282.74; 1% = 2.8274 units).
```

```
# number_decimal renders "93.0" — strip the trailing .0 for
# whole numbers, keep real decimals (e.g. 2.5) untouched.
```

```
comment
v5.1 container-agnostic guarantee copy. The container word is
resolved SERVER-SIDE and passed into the bottle.body /
bottle.point_1 t calls (the guarantee-check modal below reuses
it): per-product pdp_flags.container wins when it is one of the
five valid values, else cfg.emptyBottleGuarantee.container
(same validation), else 'jar'.
endcomment
```

### blocks/cart-booster.liquid

```
comment
Market simulation: the trust row template must also exist when its
NON-SCOPE gates pass (live master + sub-flag on) even though this
market's scope check fails, so a preview simulating a market where
it is live finds a template. Still armed-only — real visitors'
effective.trustRow stays false and the JS never clones it.
endcomment
```

```
comment
Same market-simulation rule for the cross-sell template: it must
also exist when its standalone master is live (scope ignored) so a
preview simulating another market finds a template. Armed-only.
endcomment
```

```
comment
Same market-simulation rule for the dispatch template (v5.0):
standalone master + the showInCart surface flag, scope ignored.
Armed-only.
endcomment
```

```
comment
Same market-simulation rule for the delivery template (v6.0): the
shared delivery_estimate master + the showInCart surface flag,
scope ignored — the buyer country's hidden flag still applies
(live AND draft, exactly like the PDP block). Armed-only.
endcomment
```

```
comment
Same market-simulation rule for the two v6.1 Amazon-pattern cart
features: their standalone masters live (scope ignored) must also
surface the draft path so a preview simulating another market
finds the green-line template / the cta strings. Armed-only.
endcomment
```

```
# SPEC v4.5: per-market free-shipping threshold ({ amount, currencyCode }).
# nil when this market has no entry (or the market handle is empty) —
# the config JSON then falls back to the global shop-currency threshold.
```

```
# Per-market effective booleans: LIVE master on AND sub-flag on (missing
# sub-flag = true) AND market scope match. SPEC v4: this block can now
# also render for an armed preview draft with the master OFF — the live
# effective booleans must stay false then (they are what real visitors'
# JS obeys), so each computation is additionally guarded on the live
# master. When disarmed the surrounding gate already implies the master
# is on, so cx_live_cart is true and the results are identical to v3.
```

```
# Cart cross-sell (v4.8): STANDALONE master — not under cx_live_cart.
# Effective = cfg.cartCrossSell.enabled AND market scope match, exactly
# like the other cart features' scope rule.
```

```
# Trustpilot strip inside the trust row: explicit master + its own scope.
```

```
# Dispatch countdown (v5.0): per-country schedule resolution — the
# buyer country's byCountry entry (ISO2, sanitized complete) overrides
# the default cutoff/timezone/days wholesale. Effective = standalone
# master AND showInCart surface flag (missing = true) AND market scope.
# The JS engine enforces the credibility rules (cutoff TODAY, working
# day, within showWithinHours — warehouse timezone; errors = hidden).
```

```
# Delivery estimate (v6.0): the SAME delivery_estimate master as the
# PDP widget, gated for this surface by showInCart (missing = true),
# the buyer country's hidden flag (resolved at the top of this file)
# and the shared market scope. The twin JS engine validates and
# resolves everything else, fail closed.
```

```
# Amazon-pattern cart features (v6.1): STANDALONE masters, exactly the
# cartCrossSell scope rule. az_cart_free_line = the green threshold
# sentence at the top of the booster root; az_cta_count = the theme
# checkout-button label decoration.
```

### blocks/amazon-booster.liquid

```
comment
Honesty data gates — evaluated for live AND draft alike (a draft
flag can never conjure missing or stale merchant data).
endcomment
```

```
comment
SPEC v4.5 per-market free-shipping threshold — the exact
pdp-booster/cart-booster resolution. The delivery line's over-X
clause is MANDATORY whenever a threshold exists, so an
unformattable threshold (presentment currency without a byMarket
entry) fails the WHOLE az_delivery_line closed rather than
rendering a bare (dishonest) "FREE delivery".
endcomment
```

```
comment
Ships-from resolution: buyer country -> warehouse ISO2 from
cfg.amazon.shipsFromByCountry, falling back to the default
warehouse field. The country NAME renders client-side via
Intl.DisplayNames in the page language; az_microcopy's own
fallback is the merchant-set plain label.
endcomment
```

```
comment
Live-effective booleans: master flag + embed setting + market scope.
endcomment
```

```
comment
SPEC v4 armed drafts — market-simulation rule (draft flag OR live
master ignoring scope), embed settings always respected, honesty
data gates always applied. All false when disarmed.
endcomment
```

### blocks/trust-badges.liquid

```
# Market gating: visible = flag explicitly true AND (scope nil OR
# scope.mode != 'selected' OR scope.markets contains the current market
# handle). An empty handle matches only non-selected scopes.
```

```
# SPEC v4.5: per-market free-shipping threshold. When the current market
# has a byMarket entry whose currencyCode equals the cart's presentment
# currency, `money` formats its amount correctly — render it. Otherwise
# fall back to the global shop-currency threshold, which is only safe to
# render when the presentment currency IS the shop currency (the
# pre-v4.5 skip-when-mismatch semantics).
```

### blocks/clinical-results.liquid

```
# Market gating: visible = flag explicitly true AND (scope nil OR
# scope.mode != 'selected' OR scope.markets contains the current market
# handle). An empty handle matches only non-selected scopes.
```

```
# An explicitly-saved EMPTY stats array means "no stat claims": hide the
# whole block. The defaults below apply only when stats is nil (config
# predates the field).
```

```
# The dashboard stores labelKey "custom" for free-text stats;
# only real clinical.* keys go through the translation filter.
```

### blocks/trustpilot.liquid

```
# Market gating: visible = flag explicitly true AND (scope nil OR
# scope.mode != 'selected' OR scope.markets contains the current market
# handle). An empty handle matches only non-selected scopes.
```

### blocks/subscription-nudge.liquid

```
# Market gating: visible = flag explicitly true AND (scope nil OR
# scope.mode != 'selected' OR scope.markets contains the current market
# handle). An empty handle matches only non-selected scopes. B2B hides.
```

### blocks/guarantee.liquid

```
# Market gating: visible = flag explicitly true AND (scope nil OR
# scope.mode != 'selected' OR scope.markets contains the current market
# handle). An empty handle matches only non-selected scopes.
```

