# SPEC v39 — dedicated before/after results page

Read with SPEC-v8 (proof library + the single embed), SPEC-v36 (swipe
viewer) and SPEC-v4 (preview). Shipped 2026-11-13.

## Merchant ask

"On our website we have turned on the before-afters on the product pages and
the home page widget too, but we still have a 'results' page which has our
old before-after system. […] Help me add something to the app to make it
really easy to turn a page into a dedicated before/after results page using
all our existing results with the proper formatting, click to be able to
check details, etc. Without changing the page without our intervention but
making it easy for someone non technical."

Two decisions confirmed with the merchant: staff **pick the page from a
list** (one new read-only scope), and the page shows the **gallery only**
(no press / endorsement sections).

## Contract

1. **The app never writes a page.** Scope is `read_online_store_pages`
   only; no `pageCreate` / `pageUpdate` / `pageDelete` exists in `app/`
   (harness-pinned). A page "becomes" the results page because the proof
   embed's Liquid gate matches its id, nothing else.
2. **Nothing reaches shoppers without an explicit click.** Choosing a page
   stores a draft. Shoppers see the gallery only while `pageLive` is true.
3. **Fully reversible.** Take offline / Remove restore the page exactly,
   because the page itself was never touched.
4. **A changed page is never live.** `sanitizeSettings` forces
   `pageLive = false` whenever `pageId` changes.
5. **Sub-surface, not a feature.** No new FEATURE_KEY: the page shares
   `verified_before_after`'s enable switch, market scope and analytics key.

## Settings (`BoosterSettings.beforeAfter`)

| Key | Type | Notes |
|---|---|---|
| `pageId` | number | Numeric Shopify page id, `0` = none. The ONLY identity Liquid matches (renamed / translated handles keep working). |
| `pageHandle` | string | Admin display + the preview link. Never read by Liquid. |
| `pageTitle` | string | Admin display. |
| `pageLive` | boolean | Shoppers see the gallery only while true. |

`pageId === 0` clears the other three. All four ride the normal config
mirror (`app.metafields.cellexia.config`).

## Storefront

### Liquid (`blocks/proof-booster.liquid`)

One block after the results gate:

```
if request.page_type == 'page' and page.id == cfg.beforeAfter.pageId
assign cx_page_ok = true
assign cx_ctx = 'page'
assign cx_r_draft = true
if cfg.beforeAfter.pageLive != true
assign cx_r_on = false
endif
endif
```

- `request.page_type == 'page'` is a nil guard, not decoration: off page
  templates `page.id` is nil, and with a pre-v39 mirror `pageId` is nil too
  (`nil == nil` is true in Liquid).
- `cx_r_draft = true` emits the island on the chosen page even as a draft
  (`"live": false`), so Preview works without arming the Preview Center
  (arming rewrites other features' drafts and both mirrors).
- `cx_r_on` keeps its normal meaning (feature enabled + market in scope) and
  is additionally forced off until `pageLive`.
- Byte budget: +213B, paid for by −234B of slimming in the same file (the
  stale comment and the three `request.page_type == 'product'` wrappers
  folded into one `cx_f` assign). 99,433 / 99,500, no pin move.

### JS (`assets/cellexia-proof.js`), island `ctx: "page"`

- `pfSkipOnPage` — press and endorsements bail on the page (their islands
  are still emitted; suppressing them in Liquid would cost bytes).
- `pfBandAt` — the band gets `cx-proof-band--page container` (full content
  column). Placement is unchanged: a `[data-cx-mount="results"]` element
  wins if the theme provides one, else the end of `#main`, i.e. below the
  page's own title and content.
- `resultsParams` — pages at 24 (the viewer's size), so grid and viewer
  share one page sequence over `st.items`.
- `resultsBuildSection` — root modifier `cx-results--page` REPLACES the
  density tiers and the desktop-layout flag; no "+N" end tile; Show more
  stays. Show more first renders anything the viewer already loaded
  (`st.items.length > shown`), otherwise fetches page
  `floor(st.items.length / 24) + 1`; an appended fetch catches the grid up
  to the whole store. Draft islands prepend a preview note.
- `pfTrack(feature, type, meta)` — the page impression sends `meta: "page"`.

### CSS

`.cx-results--page .cx-results__rail` is a grid at every breakpoint:
1 column, 2 at ≥600px, 3 at ≥900px, 4 at ≥1200px. Appended last in the file
(equal specificity to the rail/grid modifiers, later wins).

## Preview

`buildPreviewEntryUrl(..., { pageHandle })` adds `&page=<handle>`. The hub
(`proxy.preview.tsx`) verifies the token as always, then returns a
standalone `{% layout none %}` document that seeds `cx_preview_token` /
`cx_preview_ok` and `location.replace`s to `pages[handle].url`. A hidden or
deleted page gets a plain explanation. `sanitizePageHandle` validates (never
rewrites) the handle, since it sits in a Liquid string literal.

No arming: `verifyToken` does not depend on `armed`, and with the preview
disarmed `cellexia-cart.js` neither re-verifies nor clears the session.

## Admin (`/app/proof/page`, tab "Results page")

- `app/services/results-page.server.ts` — scope check + storefront origin,
  `pages` list (title search), single page read (body summarized server-side,
  never sent to the browser), the shared go-live rule
  (`resultsPageGoLiveBlockers`) and the storefront probe.
- Actions: `choose` (re-reads the page; always draft), `golive` (re-checks
  the rule server-side), `offline` and `remove` (retry the mirror once),
  `resync`.
- Go-live blockers: no page, page deleted, page Hidden, feature off, zero
  approved results. A page or count that could not be READ is not a blocker.
- Readiness rows: page visible · app embed on · results on + approved count
  · page layout (custom `templateSuffix` warns) · page's own content ·
  gallery connected on the real page (`#cx-results-config` present).
- Scope not granted yet: the tab shows the approval steps instead of the
  list; offline / remove still work.

## Edge cases

| Case | Behavior |
|---|---|
| Page deleted | Id never matches; tab shows "Not found"; never auto-cleared. |
| Page set to Hidden | Storefront 404s it; tab row is critical; Go live blocked. |
| Handle renamed / translated | Id match unaffected; tab shows the live handle. |
| Feature off / market out of scope | `cx_r_on` false → inert draft island only. |
| Zero approved results | Section fails closed; Go live blocked. |
| Preview armed for other features | Independent; previewer also sees the preview bar. |
| Stale mirror (pre-v39) | `pageId` nil → page-type guard keeps every page out. |
| Take offline | Mirror write is synchronous (one retry); Shopify page cache ≈ a minute. |

## Validation

Harness v39 block (page clause, no handle in Liquid, JS call sites, CSS
breakpoints, tab path, read-only scope, no page mutations), `proof-gallery`
page-mode cases + mutants, `proof-placement` page band, and
`settings-derivation` (defaults, junk coercion, page change resets live).

## v39.1 — speed, title gap, product filter, product labels

Merchant feedback on the live page (2026-11-13): the before/afters appear
late, there is a strange gap around the page title, shoppers need to filter
by product, the filters do not read as filters, and a result does not say
which product it belongs to. Everything below is page mode only (island
`ctx: "page"`); product pages and the home band are byte-identical.

### What was measured on the live page

- The gallery data was requested only once the storefront script ran
  (about 670 ms in) and the app proxy answers in 250 to 450 ms. Shopify
  does not edge-cache app-proxy responses (`cf-cache-status: DYNAMIC`), so
  every shopper pays that round trip.
- The 24 first photos were full-resolution uploads (1344 px wide, about
  200 KB each as served, 3.1 MB for the first screenful), all lazy.
- The theme's default page template pads an empty content area: 60 px under
  the title, 80 px under the section, then the shared 50 px section margin.
  The title sat 190 px above the gallery (112 px on phones).

### Speed

- **Early request.** On the LIVE page the embed prints one inline script
  before its stylesheet: `cxRF = fetch(<root>apps/cellexia/proof?type=
  results&page=1&per=24&ctx=page&locale=<locale>)`. `resultsFirstData` uses
  that promise once (live island, normal visitor) and falls back to the
  classic `proofFetch` on any problem or after 8 s. Drafts and previewing
  merchants never use it (the preview keeps its cache-busting `pv` query).
- **Placeholder.** `resultsInit` mounts `resultsPageSkeleton()` (class
  `cx-rsk`, `aria-hidden`) the moment the script runs and swaps it for the
  section; `resultsPageUnmount` removes it, the empty band and the spacing
  classes when there is nothing to show.
- **Photos.** `resultsPageThumbs` gives every card photo a Shopify-CDN
  `srcset` (360/540/720, or 240/360/540 for a half-width pair frame) with
  `sizes` matching the grid, `decoding="async"`, eager loading for the
  first four cards and `fetchpriority="high"` for the first two. Foreign
  hosts and already-sized URLs are left alone.

### Title gap

`resultsPageChrome` sets `cx-rp` on `#main` while the gallery sits in
`#main`'s own band, plus `cx-rp--bare` when `.page__content` holds no text,
image, video or iframe. CSS, scoped to those classes: the section's bottom
padding goes to 0; on a bare page the title's bottom padding goes to 0 and
the empty content box is hidden; the band alone spaces the gallery (24 px
bare, 32 px otherwise). The page's own content is never read into anything,
moved or changed, and the classes come off again if the gallery cannot
render.

### Product data (proxy, `ctx=page` only)

- `getPublicResults(…, { withProducts: true })` adds each item's `products`
  (numeric ids) and `facets.products` (results per tagged product, most
  first). `filters.product` (query `prod=<numeric id>`) serves only results
  TAGGED for that product; brand-level results do not match. It is separate
  from the product page's `product` prioritisation argument.
- `results-products.server.ts` resolves ids to `{ t, h, i?, u? }` (title in
  the shopper's language when Shopify holds a title translation, handle,
  featured image, `u: 1` when on the Online Store). Two read-only queries,
  cached in memory ten minutes per shop and language, a failure remembered
  one minute. The map rides every page-context response as `products`.
- Fail-soft: no map means no product rows and no Product filter. An old
  server (no `ctx` support) leaves the page exactly as v39 rendered it.

### Storefront

- **Product row.** `resultsProductRow` renders "Product used" plus one line
  per tagged product (picture, name) under the photos, on cards and in the
  enlarged view. A product on the Online Store is a link
  (`<locale root>products/<encoded handle>`); any other is plain text.
  Brand-level results carry no row.
- **Filter bar.** One framed bar: a "Filter by" lead-in, the filters as
  dropdown buttons (label or "Label: value", caret), Clear filters, and a
  live "Results: N" counter (`aria-live="polite"`). Product leads when the
  library spans two or more nameable products. Each filter opens ITS OWN
  options (the shared panel shows one group; a sheet on phones), every
  group leads with "All", and product options carry the product picture.
- **Readable concerns.** Concern slugs print as words on the page
  ("Frown lines").
- New proxy copy codes, 18 tables each: `fp` Product, `fb` Filter by,
  `al` All, `rn` Results: @@N@@, `pu` Product used. `rn` is "label: number"
  in every language so it needs no plural agreement.

### Liquid budget

No budget move. The inline early fetch (+184 B) was paid for first in the
same file: each of the three opt-out + draft gates folds into one
`if / elsif` and drops its `cx_*_ok` flag (-180 B). 99,433 B to 99,437 B.

### Validation

Harness v39.1 block; `proof-gallery` PG8 to PG14 with mutants m69 to m81;
`proof-server` PF1 to PF9 and RP1 to RP12 with mutants m17 to m19.

## v39.2 — the separate reviews app must not badge the gallery

Merchant report (2026-11-14): every card on the live page showed a product
star rating inside the clinical panel header.

The in-house `cellexia-reviews` app badges the card around any
`a[href*="/products/"]`; v39.1's "Product used" row put such links inside
cards whose class contains `card`, and its title lookup
(`[class*="title"]`) anchored on `.cx-results__clin-title`.

Fix: the gallery root is now `section.cx.cx-proof.cx-results…`. The bare
`cx` token is that app's own opt-out marker (it skips every link inside
`.cx` and stamps the same token on the badges it injects), and it carries
no styles in either app's stylesheet. The lightbox/viewer already matched
its `.cx-lightbox` skip rule. Cart and cross-sell cards keep their badges.

Pinned by `proof-gallery` PG15 (+ m82) and the harness v39.2 block, which
also fails if anything ever styles a bare `.cx`. Cross-app contract:
`docs/theme-integration.md`, "The separate Cellexia reviews app".

