# SPEC v21 — Cart overlay features (binding contract)

Three INDEPENDENT FeatureKeys for the theme's mini-cart drawer, all default
OFF, market-scoped, previewable alone or in any combination. Read
`docs/theme-integration.md` ("Drawer geometry + scroll facts") first — it
holds the audited theme facts (the inline `headerOffset()` height writer, the
dead `body.cart-open` class, the `item` vs `line_item` qty template bug, the
`.aty` stepper typo) that this design responds to.

| FeatureKey | Settings field | EFFECTIVE key | html gate class |
|---|---|---|---|
| `cart_overlay_fix` | `overlayFix.scrollFix` | `ofix` | `cx-ofix` (+ `cx-ofix-lock` while open) |
| `cart_compact` | `overlayFix.compact` | `compact` | `cx-compact` |
| `cart_pinned_checkout` | `overlayFix.pinned` | `pinned` | `cx-pin` |

## 1. Architecture invariants

- **CSS-scoped**: every storefront rule lives in `assets/cellexia-booster.css`
  under one of the html gate classes. No gate class on the page ⇒ the drawer
  is byte-identical to the theme's own. OFF = current behavior, always.
- **The JS surface is class management only** (`cellexia-cart.js`, the
  `ofix*` module): plant/strip the gate classes per `featureOn(...)`, mirror
  `.mini-cart.is-open` onto `html.cx-ofix-lock` (from the EXISTING
  classObserver, first line, unconditional — close must unlock pre-paint),
  maintain `cx-more-below` on `.mini-cart__content`, heal blank qty inputs.
  Wired at exactly four points: classObserver head, listObserver,
  `renderAll()` tail, `init()` (`ofixInit`, listeners only when ≥1 feature
  on). Everything try/caught; a missing `.mini-cart` strips all classes
  (fail closed).
- **No node is painted, moved or rebuilt.** No `data-cx-feature` marker, no
  beacon (the v20 image_badges precedent); FeatureKey evidence = the gate-key
  strings in `CART_FEATURE_KEYS`.
- **Never write `.mini-cart`'s own class attribute** — the theme section's
  MutationObserver fetches `/cart.js` a second after every class change
  there. Gate classes live on `document.documentElement`; the cue class on
  `.mini-cart__content` (which `refreshMiniCart` never rebuilds).
- Preview: `PREVIEW.live ∪ PREVIEW.flags` per FeatureKey — all 2³
  combinations arm independently with zero effect on live visitors
  (`cx_draft_ofx/cpt/pin` feed only the island emission gate).

## 2. cart_overlay_fix

- **Height**: `html.cx-ofix .mini-cart { top:0; height:100vh !important;
  height:100dvh !important }` — the section's ONLY `!important`, needed to
  beat the theme's inline `calc(100vh - headerPx)` permanently (jQuery
  `.css()` cannot set priority). Panel drops its own 100vh (`height:100%`),
  backdrop gets vh/dvh. `svh` is deliberately NOT used (bottom band while
  iOS toolbars collapse). Not keyed on `.is-open` (full height through the
  ~200ms fadeOut). Shared: the height rules also fire under `cx-compact` and
  `cx-pin` — the cue and the sticky bar need a correctly sized drawer to
  position; the lock and the heal remain exclusive to this feature.
- **Scroll lock**: `html.cx-ofix body.cart-open{overflow:hidden}` (gives the
  theme's dead class meaning) + `html.cx-ofix-lock, html.cx-ofix-lock body
  {overflow:hidden}` (authoritative, observer-mirrored). Both html AND body
  (the theme's `html{overflow-x:clip}` blocks body-only propagation).
  `overscroll-behavior:contain` on the single scroller;
  `.mini-cart__list{overflow:visible}` (kills the nested scroll-eligible
  box); `touch-action:none` on the backdrop. **NO position:fixed body lock**
  — zeroing scrollY fires the theme's accumulated scroll handlers, and a
  missed restore freezes the page; documented fallback only if real devices
  still bleed.
- **Qty heal** (`ofixQtyHeal`): for each `.mini-cart__list .product--cart`
  row, if its `.qty input` value is `''` (strictly) AND it is not
  `document.activeElement` (review C1: a focused blank is the shopper
  clearing the field to retype — refilling it would let the theme's keyup
  autocommit order a concatenated quantity), fill from
  `state.cart.items[data-lineid − 1].quantity`. Bail whole on missing
  `state.cart` or row/item count mismatch; skip a row whose `data-varid`
  (present on exactly the Liquid path that produces blanks) disagrees with
  the cart line's variant id (review C2: equal-count divergence from
  another tab). Blank-only forever: never fights a shopper mid-edit, stays
  a no-op once the theme's `item` → `line_item` typo is fixed.
- **Lock support gate** (review C3): `ofixCanLock = typeof MutationObserver
  === 'function'` — a browser whose close transitions we cannot mirror
  (setupObservers bails there) never locks at all; height/cue/heal still
  work. And `html.cx-ofix { scrollbar-gutter: stable }` (review C4): the
  gutter is reserved for the whole feature-on session so classic
  (space-taking) scrollbars cannot shift the page or slide the fixed panel
  when the lock engages/releases.

## 3. cart_compact

- Compaction under `@media (max-width: 576px)` (the theme's breakpoint)
  only. Hard rules: **product photo size untouched; no font-size reduced
  anywhere; every touch target ≥ 44px** (the stepper's `padding:17px 0` IS
  the theme's own intended value, dead behind its `.aty` typo). Row reorg:
  `.unit-price{display:none}` (the duplicated per-row price),
  `.cx-volume__current{display:none}` (merchant-approved), tightened
  paddings/margins per the shipped table. `__actions` compaction excludes
  `cx-pin` (`:not(.cx-pin)`) — the pinned bar owns its own geometry.
- **Scroll cue**: `cx-more-below` set while
  `scrollHeight − clientHeight − scrollTop > 24` AND the drawer is open.
  Re-verdicted on: content scroll, every `renderAll`, list childList,
  is-open transitions, resize/orientationchange/pageshow (rAF-coalesced),
  capture-phase image `load` in the drawer. CHEVRON ONLY (review C5: a
  fade veil would haze white over the theme's solid #f4f4f4 subtotal
  footer for the last screenfuls). Two anchorings: with `cx-pin`, an
  `::after` chevron on the actions bar (`bottom:100%`); without, a sticky
  zero-flow-height `.mini-cart__content::after` with an inline-SVG chevron.
  Zero text, zero locale bytes, `pointer-events:none`, drift animation only
  under `prefers-reduced-motion: no-preference`.

## 4. cart_pinned_checkout

`position: sticky; bottom: 0` on `.mini-cart__actions` (last child of the
scroll container), white, hairline + soft shadow, `padding:14px 20px` +
`env(safe-area-inset-bottom)` — a comfortable bar (merchant: not slim); the
checkout pill keeps the theme's full size, `View Cart` restyled to an
underlined 14px link with a 44px hit area. No DOM change ⇒
`decorateCtaButtons` and the theme's subtotal observer keep working. A cart
too short to scroll renders it in normal flow (today's layout).

## 5. Liquid contract (`blocks/cart-booster.liquid`)

`cx_ov = cfg.overlayFix` alias; three house-idiom gates (`cx_eff_ofx/cpt/pin`
on their OWN `marketScopes.<key>`); three armed-preview draft flags
(`cx_draft_ofx/cpt/pin`, no pre-assign — the `cx_draft_rw` precedent) in the
draft-any chain; three emission-gate clauses (`or cx_ov.scrollFix or
cx_ov.compact or cx_ov.pinned`) IN FRONT of the pinned v14 tail; three
always-emitted `"effective"` members (`ofix`/`compact`/`pinned` —
`anyEffectiveLive()` boots the runtime on any of them alone). A pre-v21
metafield has no `cfg.overlayFix` ⇒ every gate nil-false. Byte caps
unmoved: file 23,356/23,600 B, total 97,972/99,500 B (v21 dieted first).

## 6. Enforcement

- `validation/harness.mjs` §v21: gates/members/emission idiom, the
  load-bearing CSS strings (dvh `!important`, html+body lock pair, sticky
  bar + safe-area, both cue anchorings, 17px stepper, `.unit-price` +
  `__current` hides, no `product__image` resize), JS pins (gate keys, no
  marker/beacon, documentElement-only writes, never `.mini-cart` classList,
  blank-only heal guard, the four wiring lines), settings pins (LAST keys,
  `overlay` kind, `=== true` sanitize), admin pins (cart page cards, Markets
  matrix read+write, preview keys, hub Configure).
- `validation/sims/cart-overlay-fix.cjs` (62 checks, 13 mutants): the 2³
  gating matrix incl. preview paths, lock both directions + ofix-only,
  cue threshold/tolerance/closed/compact-only + the LIVE listener wiring
  (scroll/image-load re-verdicts through the bound handlers), heal
  fill/never-overwrite/never-focused/varid-identity/count-bail/null-cart/
  ofix-only, no-MutationObserver-never-locks, rAF coalescing + re-arm,
  preview-armed init, fail-closed strips, idempotence, checkout node
  identity, `.mini-cart` class untouched.
- `validation/sims/flip-test.ts` covers the `overlay` raw-field kind in
  flip/scope/snapshot/selective-restore round-trips (42 keys).
