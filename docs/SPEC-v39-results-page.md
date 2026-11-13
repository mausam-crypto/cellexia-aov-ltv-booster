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
