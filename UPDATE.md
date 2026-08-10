# Cellexia Booster — UPDATE Deployment Guide

**Audience: the developer updating an EXISTING production install.** For first-time
installation use `INSTALL.md`. Read this whole file before touching production —
every issue from previous deploy rounds is addressed here, most of them now fixed
in-tree so local patches are no longer needed.

## 0. Your previous local fixes are now in-tree — drop your patches

Every workaround from the last deploy round is now part of the codebase. **Do not
re-apply local patches; deploy this tree as-is** (after the config merge in §1):

| Previously patched by hand | In-tree fix |
|---|---|
| **Prisma datasource patch (sqlite → postgres)** | **Fully automatic now.** The build/install scripts run `node scripts/prisma-env.mjs generate`, which selects `prisma/schema.postgres.prisma` whenever `DATABASE_URL` is a Postgres URL (Render sets it at build time) and the SQLite dev schema otherwise. Drop this patch too — §2/§3 explain the new flow, and the server now REFUSES TO BOOT if a mismatched client ever slips through |
| Missing dotenv loading | `dotenv` is a dependency; `app/shopify.server.ts` imports `dotenv/config` first (never overrides host-set vars) |
| Missing `RENDER_EXTERNAL_URL` fallback | `appUrl` resolves `SHOPIFY_APP_URL → RENDER_EXTERNAL_URL → ""` (also in the app-proxy health check) |
| Missing `react-reconciler` | Declared in all four checkout extensions' `package.json` (incl. the new `checkout-delivery`) |
| 27-char schema name limit | All block schema names now ≤ 25 chars (`Cellexia subscription`) |
| `external` → `target` Button iframe issue | ALL occurrences swept (14 across 5 admin routes — more than the 6 you found; new pages had regressed it) |
| 100 KB Liquid limit | The live/draft template pairs are deduplicated in-tree (single template with a conditional `data-cx-draft` marker) — `pdp-booster.liquid` is well under the limit again and won't regress |
| Before/after image height attributes | `width`/`height` attributes restored on B/A images (and added to every other extension `<img>`) |

## 1. ⚠️ Config merge — your `shopify.app.toml` is now SAFE from the unzip

**This ZIP no longer contains `shopify.app.toml`** — unzipping over your working
copy can no longer clobber your production config (a real hazard in previous
rounds: the old template shipped example.com URLs at the live path, and
`include_config_on_deploy = true` would have pushed them to the live app). The
template now ships as **`shopify.app.toml.example`** for reference only. In your
REAL toml, make exactly three changes:

- **`scopes`** — replace the line with (additions since your build:
  `read_shipping`, `read_price_lists`, `write_price_lists`, `write_translations`):

```
scopes = "read_products,write_products,read_publications,write_publications,read_orders,read_locales,read_translations,read_markets,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects,read_files,write_files,read_themes,read_shipping,read_price_lists,write_price_lists,write_translations"
```

- **`automatically_update_urls_on_dev = false`** under `[build]` (the example
  file shows it). With `true`, any `npm run dev` session against this single
  production app rewrites the LIVE `application_url`/`redirect_urls` to an
  ephemeral tunnel — breaking merchant admin access until redeployed. Dev work
  should use a separate linked dev app (`shopify app config link` +
  `npm run config:use`).

- **`api_version = "2025-10"`** under `[webhooks]` (was `2025-07`, which left
  Shopify's 12-month support window on 2026-07-01 — the server code in this
  version is pinned to `2025-10` to match).

Everything else in your toml stays as-is: `client_id`, `application_url`,
`redirect_urls`, and the whole `[app_proxy]` block (url = your host + `/proxy`).
On the host, **no NEW environment variables** — but if you set a `SCOPES` env
var (INSTALL.md's flow does), update it to the same value as the toml scopes
line above so the two never disagree.

## 2. Database — read this if production is Postgres

**The schema now selects itself.** `prisma/schema.postgres.prisma` is a
ready-made Postgres twin of the dev schema (`provider = "postgresql"`,
`url = env("DATABASE_URL")`, models byte-identical — the validation suite
enforces it can never drift), and every npm script that touches Prisma goes
through `scripts/prisma-env.mjs`, which picks the twin automatically whenever
`DATABASE_URL` is a Postgres URL. **Never patch `prisma/schema.prisma` again,
and never run bare `prisma generate` / `prisma migrate deploy` on the host.**

The one database step for this update — create the new tables (run it BEFORE
or immediately WITH the server deploy, so the new code never serves against
missing tables):

```bash
npx prisma db push --schema prisma/schema.postgres.prisma
```

**Where to run it:** either from the Render *Shell* tab (fine here — unlike
`generate`, `db push` changes the DATABASE, not the service filesystem, so it
persists), or from your machine with the production URL exported first:
`DATABASE_URL='postgres://…' npx prisma db push --schema prisma/schema.postgres.prisma`.
It fails with "Environment variable not found: DATABASE_URL" if you forget the
export — that's your signal, not a bug. Alternatively `npm run setup` on the
host now does generate + the correct apply step for whichever database
`DATABASE_URL` points at.

> ⚠️ **History, so nobody regresses this:** the "Cannot read properties of
> undefined (reading 'count')" incident was caused by reusing an OLD patched
> copy of `schema.prisma`, and the v8.4 hotfix's plain `prisma generate` would
> have introduced the opposite failure (a SQLite-wired client silently ignoring
> `DATABASE_URL` — reproduced in our deploy audit with every health check
> green). Both are now impossible: the selector picks the schema from the
> environment, and the server refuses to boot on a provider mismatch.

The `prisma/migrations` folder is **SQLite-dialect** (dev-only) — that is why
Postgres uses `db push`; the selector enforces this split automatically.

Additions since the pre-v8 build: **four proof-library tables** — `PressItem`
(incl. `marketHandles`), `DermEndorsement`, `CustomerResult` (incl. the
`legacyGid` unique key that makes the before/after import exactly-once) and
`ProofTranslation` (v8.11 — per-entry, per-locale translated text) — plus
v10's **`GeoStateDb`** (one row per shop: build status + the compiled,
gzipped IP→US-state range tables behind the delivery promise's state
detection; `db push` creates the empty table, the one-time in-app
"Download & build" step in the §5 v10 note fills it).
Earlier additions if you're further behind: `PreviewState` (+ `draftConfig`),
`TranslationConfig`, `Experiment.startSyncErrors`, `Event.market`,
`OrderStat.market`, `OrderStat.countryCode` (+ indexes). `db push` adds all of
this without touching existing data. Take your usual DB backup first anyway.
One narrow edge case: if your DB was first created from the short-lived
2026-07-20 intermediate build, `db push` may report dropping an unused
`PreviewState.tokenHash` column — accepting that is safe (preview re-arms).
(If you maintain your own Postgres migration history, diff
`prisma/schema.postgres.prisma` against production and add the tables/columns
above by hand instead.)

## 3. Deploy — BOTH halves, in this order

The update changes the app server AND the extensions. Deploying only one half is
the #1 cause of "nothing changed" reports (preview/checkout handshakes span both).

**The Prisma Client regenerates itself from the RIGHT schema on every install
and every build.** `postinstall` and `build` both run
`node scripts/prisma-env.mjs generate`, which reads `DATABASE_URL`: a Postgres
URL selects `prisma/schema.postgres.prisma`, anything else selects the SQLite
dev schema. Render exposes environment variables at build time, so the standard
Render flow needs ZERO manual Prisma steps. Two safety nets back this up: the
selector records the chosen provider in `prisma/.generated-client.json` and the
server **refuses to boot** (clear error, exact fix in the message) if
`DATABASE_URL` says Postgres but the client was generated for SQLite; and the
*Proof library database* health check independently asks the connected database
what engine it is, failing loudly on a wrong-database deploy.

> ⚠️ **Do NOT "fix" a stale client from a host shell.** Running
> `npx prisma generate` in a one-off shell (e.g. Render's *Shell* tab) does NOT
> persist into the running service — the shell's filesystem changes are thrown
> away and the already-running Node process keeps its loaded client anyway.
> `generate` runs during the BUILD, which this version's scripts do
> automatically. If your host uses a **custom build command**, make sure it is
> (or includes) `npm ci && npm run build` — that is sufficient. (Only for build
> systems that HIDE env vars at build time — e.g. plain `docker build` — set
> `PRISMA_SCHEMA=prisma/schema.postgres.prisma` in the build environment, or
> rely on `npm run setup` at container start, which re-selects with the runtime
> env; the shipped Dockerfile already does this.)

```bash
# 0) DATABASE first (or simultaneously): npx prisma db push per §2
npm ci                    # clean install (lockfile is authoritative; postinstall regenerates the client)
npm run build             # must pass locally before you ship (also regenerates the client)
# 1) APP SERVER: deploy/restart your Render service with this code
# 2) EXTENSIONS:
npm run deploy            # pushes theme extension + 4 checkout extensions + config
#    (v6.0 adds a FOURTH checkout extension, checkout-delivery — it deploys
#     with the same command, no extra registration needed)
#    If the CLI ever rejects an extension api_version as unsupported, bump the
#    api_version line in the five extensions/*/shopify.extension.toml files to
#    the version the CLI suggests and re-run npm run deploy — the extension
#    code uses stable APIs only.
```

**Verify the deployed client** (run this in a shell attached to the RUNNING
service, from the app directory — for verification a shell is fine, it's only
*fixing* from a shell that doesn't stick):

```bash
node -e "const m=require('./prisma/.generated-client.json');const {PrismaClient}=require('@prisma/client');const c=new PrismaClient();console.log('provider:',m.provider,'| models:',typeof c.pressItem,typeof c.dermEndorsement,typeof c.customerResult)"
```

On a Postgres host this must print `provider: postgresql` and `object` three
times. `provider: sqlite` = the build could not see `DATABASE_URL` → fix the
build env (see the box above) and redeploy; any `undefined` = a pre-v8 client →
rebuild/redeploy (do not shell-generate). The app also self-diagnoses: **Setup
& health → "Proof library database"** distinguishes all three failure modes —
stale client, missing tables, and wrong-database — each with its own fix, and
the Proof admin pages / storefront API report the same actionable messages.

**Maintenance flag — schedule before 2026-09-30:** this release pins the Admin
API + webhooks to `2025-10`, the newest version the current dependency line
(`@shopify/shopify-app-remix` 3.x) supports; the checkout extensions stay on
their tooling line's latest (`2025-07`). Before 2025-10 retires (~2026-09-30),
plan a dedicated platform upgrade (shopify-app-remix 4.x + the matching
`@shopify/ui-extensions` line, then bump every `api_version`) as its own tested
release — do not fold it into a feature deploy.

Then in the store admin, **open the app once** — you'll be prompted to approve the
new scopes. Approve them (protection per-currency pricing, free-shipping
auto-detection, and booster auto-translation need them).

## 4. Post-deploy checklist (10 minutes, in order)

1. **Setup & health** (app nav): re-run checks — everything green. Three checks
   matter most after an update: *App proxy reachable*, *Deployed extension build*
   (its build number must have INCREASED — if it didn't, `npm run deploy` didn't
   land), and the NEW *Proof library database* (fails with the exact fix if the
   running server has a stale Prisma Client or the DB is missing the v8 tables).
2. **Free shipping**: Settings → Free shipping thresholds → mode Auto → **Detect
   now** (needs the new `read_shipping` scope).
3. **Protection prices**: Checkout features → per-market price table → enter round
   prices per currency → **Apply to Shopify Markets**. If a market shows
   "skipped: no price list", create one under Settings → Markets → [market] →
   Products and pricing, then Apply again.
4. **Checkout editor** (Settings → Checkout → Customize): all FOUR Cellexia blocks
   are ALWAYS visible/previewable in the editor (they render representative
   previews there even when features are off). Place or re-position them — the
   upsell and trust blocks also offer a placement anchored at the Pay-button
   area ("actions" slot), and the NEW "Cellexia delivery" block offers a
   placement directly under the shipping options (its natural home) plus a
   freely-placeable variant. Place the delivery block once here or buyers
   never see it, even with the feature enabled. Save.
5. **Preview**: in the app, **Disarm** then **Arm** the preview once (writes the
   new-format metafields), open a FRESH preview link, and verify: cart drawer
   (cross-sell now automatic), product page (Guarantee check modal), and checkout
   (via any route into checkout — the preview cart is auto-tagged now). If a
   checkout feature won't render in preview it now TELLS you why in place.
6. **Auto-translation** (optional, merchant can do it themselves): app nav →
   **Languages** → paste a DeepL API key (free tier at deepl.com/pro-api) →
   Save & verify. From then on, per-product booster content auto-translates into
   every published language on save; each product editor also has a
   "Translate into all languages" button. The key is stored in the app database
   only (`TranslationConfig`) and never reaches the storefront.
7. **Storefront spot-check** (2 min, real visitor view, preview disarmed): pages
   render exactly as before for buyers; `https://<store>/apps/cellexia/track`
   returns `{"ok":true,"service":"cellexia-booster"}`.

## 4b. v6.2 — the 100KB Liquid blocker you reported: FIXED in-tree

Your diagnosis was right on all three counts. What changed: (1) ~46KB of
Liquid comments/indentation stripped (never rendered); (2) the duplicated
engine config you suspected was deduped where safe (the az delivery island
keeps a deliberately standalone copy — required so the Amazon delivery line
works when the classic widget's PDP surface is off; it carries no "live"
field so it can never activate the classic widgets); (3) most widget
template markup moved from Liquid into the JS assets (no Liquid cap there),
each migration machine-proven byte-equivalent against the pre-diet baseline
by scratch prover tooling. RESULT: total Liquid is now 91,934 bytes — 10.5KB
under Shopify's 102,400 cap. Rendered output for buyers is equivalent (the
diet also FIXED a v6.1 latent bug: a stray reference that silently killed
the entire PDP proof stack). A build-time tripwire now fails any future
change that pushes total Liquid over 95,000 bytes, so this cannot reach
deployment again. Nothing to do on your side beyond the normal deploy.

## 4c. v6.7 — Liquid head-room build-out (no behavior change)

All remaining widget markup moved from Liquid templates to the JS assets:
the extension now contains ZERO <template> tags and totals 83,596 bytes of
Liquid — 18.8KB under Shopify's 102,400 cap. Every migration is
machine-proven byte-equivalent to the previous release (27 registered
proofs); rendered output, preview behavior, translations and toggles are
identical. Nothing to do on your side beyond the normal extensions deploy.

## 4d. NEW: run the validation suite before every deploy

The repo now ships its full validation suite at `validation/` (24 suites,
6,200+ checks — `npm run validate` prints the live totals: equivalence prover vs a committed baseline, structural
tripwires incl. the Shopify Liquid-budget guard, and engine/feature
simulations that execute the real shipped code — all offline, ~3s):

```bash
npm run validate
```

Run it after `npm ci` and before deploying; a red scoreboard means stop.
(`npm run proofs` is now an alias of the same suite: the v6.8-era
`scripts/proofs/` runner was retired in v6.11 — both of its proofs live on
strengthened inside `validation/`, see the v6.11 notes below.)

## 5. What's in this update (context for the diff you'll see)

v8.19 — ENDORSEMENT COPY SPEAKS EVERY LANGUAGE (2026-08-09): the seven
custom copy fields of the endorsement section/badge (eyebrow, headline,
description, badge headline, badge link, badge no-link, badge chip) now
AUTO-TRANSLATE through the same DeepL system as quotes and testimonials:
saving the copy card fires an incremental translate run (DeepL key on the
Languages page; {n} survives translation), the storefront serves each
page's language via the proof proxy, and a "Translations" reviewer under
the copy card lets you hand-polish any language (manual edits are never
overwritten; clearing one falls back). An edited field serves its new
primary text everywhere until re-translated — never a translation of the
old text. No DB change (the ProofTranslation table already fits), no new
scopes, no locale-file or Liquid growth.

v8.18 — FOUR BADGE DESIGNS (2026-08-09): the endorsement badge gained a
"Badge design" picker (Proof library → Endorsements → "Buy-box badge &
section copy"): CLASSIC (the shield + blue link look, unchanged default),
DERMATOLOGISTS' CHOICE (cream panel, laurel-and-caduceus serif title —
the section eyebrow doubles as the title — bold count, underlined link
and a "Licensed dermatologists" credential chip), SLIM BAR (a one-line
pill: three portraits, a "+N" spillover counter, shield and bold count)
and CHOICE COMPACT (the Choice look condensed to two tight rows). One
new locale key endo.badge_chip in all 18 languages + an editable "Badge
chip text" field. No new feature key, scope, table or embed; existing
stores keep the classic design until they pick another. NOTE: el.json is
now 3B under the 15,000B locale budget — Greek copy additions of ANY
kind must trim existing el strings first.

v8.17 — ENDORSEMENT BADGE + EDITABLE WALL COPY (2026-08-09): the
dermatologist-endorsement feature gains (1) an optional BUY-BOX BADGE on
product pages — a compact strip right under the price (above the
description on desktop) with up to five real endorsement portraits, a
shield-check + "Recommended by N dermatologists" line (N = the same
product+brand total the wall shows) and an optional link that
smooth-scrolls to the wall; when the link is toggled off an editable
non-link line shows instead — and (2) fully MERCHANT-EDITABLE section
copy: eyebrow, headline ({n} = live count), a NEW description paragraph,
badge headline, badge link text and badge no-link text, all edited on
Proof library → Endorsements → "Buy-box badge & section copy" (blank =
built-in copy, now "Dermatologist recommended" / "{n} dermatologists
recommend Cellexia" / the new description, translated in all 18
languages; custom text is served as entered in every language). Both
ship OFF/blank; no new feature key, scope, table or embed — everything
rides the existing proof embed + derm_endorsements flag and beacons.
DEPLOY: extensions half + app server, no DB change. NOTE: el.json now
sits 6B under the 15,000B locale budget (Shopify hard-caps locale files
at 15,360B) — the NEXT Greek copy addition must trim existing el strings
first; ar.json now ships minified (MINIFIED_LOCALES).

v10 — US DELIVERY PROMISE BY STATE (2026-08-08): the Delivery guarantee
gains an optional United States STATE-level module — per-state business-day
windows, per-state days off and dispatch cutoffs, a built-in US federal
holiday calendar (the six movable holidays; the fixed ones were already in
the US table), an Amazon-style "Deliver to: California" selector on the
product page and in the cart, self-hosted IP→state detection (the visitor's
IP is looked up against a locally compiled table on YOUR server — never
sent to a third party, never stored, never logged), and the exact
typed-address state promise at checkout. No new feature key, no new scopes,
no new surface: it all rides the existing Delivery guarantee, ships OFF,
and quietly degrades to the current US-wide promise whenever a state cannot
be resolved.

DEPLOY STEPS SPECIFIC TO v10 (in addition to the §2 basics):
1. DATABASE: `db push` per §2 — one new table, `GeoStateDb`.
2. Deploy BOTH halves as usual (§3): the app server changed (settings,
   the Delivery admin page, the geo pipeline + a new `/apps/cellexia/geo`
   app-proxy endpoint) AND the extensions changed (theme JS/Liquid/CSS +
   all 18 locale files, plus the checkout-delivery AND checkout-trust
   extensions — their shared date engine learned the state layer). Scopes
   UNCHANGED — no re-approval prompt. No new extension, no new
   checkout-editor placement, no new app embed.
3. ONE-TIME (only if you'll use the module): Features → Delivery
   guarantee → "State detection database" card → **Download & build**.
   Downloads the free DB-IP City Lite database (~84 MB) and compiles the
   US ranges — takes a few minutes; the card shows live progress and the
   rest of the app stays usable. Until it's built (or if you never build
   it) the product page + cart simply keep the US-wide promise; checkout's
   state promise works REGARDLESS — it reads the typed shipping address,
   never the IP. Refresh MONTHLY from the same button (DB-IP publishes
   monthly; a failed refresh keeps serving the previous good table). If a
   build is interrupted (server restart/redeploy mid-download), the card
   shows "build interrupted — run Download & build again" and the button
   re-enables — recovery is that one click, no manual cleanup, and the
   previous good table keeps serving throughout.
4. ENABLE + CONFIGURE: same page → "United States — delivery by state"
   card (ships OFF) → master switch on, then add per-state overrides
   (min/max days, delivery weekdays, holidays inherit/on/off, per-state
   cutoff + dispatch days — the warehouse timezone always inherits —
   extra days off capped at 60 dates US-wide / 40 per state, or hide the
   widget for a state entirely). The module is a sub-layer: the Delivery
   guarantee itself must be enabled (and not hidden or market-scoped away)
   for US buyers, or nothing shows at all.
5. ATTRIBUTION (license requirement): state detection uses DB-IP City
   Lite (CC BY 4.0). The storefront handles it automatically — whenever a
   DETECTED state is in use, the selector popover shows the required
   "IP Geolocation by DB-IP" link (it hides when the visitor picks a
   state manually). Don't suppress it.
6. HONEST EXPECTATIONS: IP state detection is ~90% accurate; mobile
   visitors in particular can resolve to a neighboring state or not at
   all. That is why the page ALWAYS renders the US-wide promise first (the
   state layer is a quiet upgrade), why the selector lets visitors correct
   the state, and why checkout NEVER guesses — its promise comes only from
   the typed address.
7. `npm run validate` totals DIFFER from v9's (two new v10 suites plus
   extended pins) — the scoreboard's live counts are the authority; green
   is what matters.

v9 — CHECKOUT TRUST MODULE V2 (2026-08-08): the checkout reassurance module
rebuilt with two new per-market rows and refreshed copy, in all 18
languages.

DEPLOY STEPS SPECIFIC TO v9 (in addition to the §2 basics):
1. Deploy BOTH halves as usual (§3) — the checkout-trust extension changed,
   and the app half carries two new feature keys. No new extension and no
   new checkout-editor placement: the existing "Cellexia Checkout Trust"
   block simply gains the new rows. If you use Translate & Adapt overrides
   on the trust module strings, re-review them: `secure` and
   `guarantee_body` changed in every language.
2. COPY CHANGES (live immediately after deploy, all 18 languages):
   "Secure SSL-encrypted checkout" → "Secure Encrypted Checkout", and the
   guarantee sub-line is now "Not satisfied? Get your money back within
   60 days." (the number follows your guarantee-days setting).
3. NEW ROW — "No customs or additional fees on delivery." (OFF by
   default): enable it on Features → Checkout ("No customs or additional
   fees" line), then limit it per market with its own "Markets —
   Customs-free delivery line" card (or the Markets page row "Customs-free
   delivery line"). Turn it on only for markets where you genuinely cover
   customs and import fees.
4. NEW ROW — "Tracked Delivery · Guaranteed by ⟨date⟩" (OFF by default):
   same switches one card down. The date is EXACTLY the Delivery
   guarantee's guaranteed-by date (same dispatch schedule, country
   overrides and holiday calendars — the extension ships a byte-identical
   copy of the delivery date engine, enforced by the validation suite), so
   whenever both render they can never disagree. The row STANDS ALONE,
   though: it keeps rendering even while the Delivery guarantee feature is
   switched off (only the schedule settings are shared) — turn the row off
   to stop the promise. It renders in
   the buyer's language with a native date in all 18 languages ("13
   August" / "13 août" / "13. August" / "8月13日"), appears only once the
   buyer's shipping country is known, and hides itself rather than ever
   showing a wrong or half-computed date.
5. Both rows are draft-previewable from the Preview Center (they imply the
   module chrome in preview even while the module master is off) and
   market-targetable before being enabled — scope selections save
   immediately and apply when you switch a row on.

v8 — THE PROOF LIBRARY (2026-08-02): three new trust surfaces backed by a
database + public JSON API, compact display modes, and the before/after
widget rebuilt as a browsable gallery.

DEPLOY STEPS SPECIFIC TO v8 (in addition to the §2 basics):
1. DATABASE: two new migrations ship (proof-library tables + press market
   scoping). SQLite dev applies them via `npm run setup`; Postgres
   production uses `prisma db push` as always (prisma/migrations are
   SQLite-dialect — the schema is the source of truth).
2. THEME EDITOR — superseded in v8.7: the three widgets now ride ONE app
   embed, "Cellexia proof library" (the store's legacy Liquid templates
   cannot take section app blocks). Enable it once under App embeds; the
   widgets self-insert on product pages AND the home page — those two
   templates only, never cart/blog/search (the results gallery REPLACES the old before/after
   widget there) and, if you want the brand-level modules, on the home
   page too. On product pages they auto-prioritise entries tagged to that
   product; on other pages they show everything.
3. CONTENT: the new nav page **Proof library** holds everything — press
   quotes (publication, logo, quote, optional article link; tag to
   products or leave brand-wide; v8.1: limit any item to selected MARKETS
   so each market can carry its own publications), dermatologist
   endorsements (name, credentials, optional portrait, quote — built for
   dozens/hundreds; the wall headline shows the full count), and customer
   results (before/after photos, age range, skin type, concern, duration,
   country, verified-purchase flag, testimonial, optional video; approve/
   feature/reorder; visitors filter by concern/age/skin/duration). Click
   "Import legacy before/afters" once to convert your existing per-product
   B/A entries into gallery results (idempotent — it walks your whole
   catalog and never duplicates an already-imported entry).
4. The old "Real results, independently verified" widget is gone from the
   product page; the results gallery (same feature key, same market
   scopes, same per-product opt-outs) replaces it. Nothing renders until
   the gallery has approved entries — import or add them first.
5. COMPACT MODES (optional): Features hub → "Display density" — per-widget
   toggles that shrink the dermatologist survey, clinical study and
   guarantee to a fraction of their height (survey: headline + top outcome
   + "+N more" expander; study: inline hero + mini-stats; guarantee: slim
   one-row band; the Guarantee-check window keeps the full details).
6. Two new features appear in Features/Preview/Markets: "As seen in the
   press" and "Dermatologist endorsements" (both OFF by default, both
   market-targetable, both with per-product opt-outs under Product
   boosters). The proof API is served through the existing app proxy —
   the App Proxy requirement (§1 / the toml's own [app_proxy] warning) matters for it too.
7. v8.2/v8.3 — DISPLAY DENSITY: each of the three new widgets has THREE
   density levels on the Display density card — Full, Compact and Ultra
   compact. Compact keeps everything visible at a fraction of the height
   (press: one logo row with the quote shown beneath it; endorsements:
   count headline over a rail of readable cards; results: full banner +
   filters with the card rail on desktop too). Ultra compact is the
   maximum-diet variant (press: logo row only, quote on tap; endorsements:
   one-line headline + mini rail; results: slim banner + one-line filter
   strip). Stores that enabled the earlier ultra-compact toggles keep
   ultra automatically.
   The press logo upload states the optimal artwork requirements inline
   (transparent horizontal wordmark, PNG/SVG, ≥240 px wide). Endorsement
   quotes support full 2–3-paragraph statements — paragraph breaks are
   kept when a visitor expands the quote, in both layouts.

v7 — THE PROOF STACK GOES PER-PRODUCT (three merchant requests, 2026-08-01):

(1) DERMATOLOGIST SURVEY, REBUILT PER-PRODUCT. The shop-global survey
widget (one set of numbers on every product page) is gone. Each product now
carries its OWN survey: outcome statements dermatologists rated for that
specific product ("Skin looked visibly firmer after 8 weeks" — 246 of 270
agreed), with derived percent bars, an optional "NN% would recommend"
headline, an optional verbatim question quote, and per-product methodology/
verifier overrides. One outcomes-forward format replaces the five old
display formats (the Preview Center format picker is gone with them).
IMPORTANT MIGRATION BEHAVIOR — deliberate: after this update the survey is
OFF on every product until you add its content (Product boosters → product →
Dermatologist survey card). Products without survey content show nothing;
your old shop-global numbers are preserved in settings but no longer render.
The survey feature page (Features → Dermatologist survey) now holds the
master switch, market targeting and shop-wide DEFAULTS (verifier,
verification URL, "How the survey was conducted" text — each overridable
per product). All survey content lives in translatable metaobjects and
rides the DeepL auto-translation pipeline like the other boosters.

(2) CLINICAL STUDY: PRODUCT-BOUND + FULLY CUSTOMISABLE. New always-on
subject line under the eyebrow — "Tested on {{ product }} itself — the
exact formula on this page." (override it per product via the new Study
subject field). The n/weeks/lab methodology sentence became scannable
protocol FACT CHIPS (participants · study length · lab · instruments).
Result rows can be reordered in the editor (first row = the big headline
stat); add/remove up to 6 as before, every value/suffix/label editable.
NOTE: the app adds the new `subject` field to your existing clinical-study
metaobject definition automatically on first admin load after deploy.

(3) GUARANTEE RENAMED: "Try it for 60 days, completely risk-free" (the
day count follows your setting, translated in all 18 languages). The theme
editor now offers body + all three point overrides next to the existing
title override (Translate & Adapt-translatable, blank = translated
default). Admin label is now "Risk-free trial guarantee" — same feature
key, market scopes and experiments unaffected.

All three widgets were redesigned for skeptical visitors (specificity,
verifiability, restraint) and verified on desktop + mobile. 18 locale
catalogs updated natively (9 dead survey keys removed everywhere).
After deploying: add survey content to your key products FIRST, or the
survey section simply won't appear anywhere.

v6.11 — the dermatologist survey's "How the survey was conducted" text is
now FULLY merchant-editable: the Survey page gained an "Edit the built-in
text" button that loads the complete built-in explanation into the editor,
and the placeholders {{ total }}, {{ yes }} and {{ percent }} keep tracking
the live survey numbers inside custom text (storefront-substituted; the
admin preview mirrors it exactly). Saving an UNTOUCHED copy of the built-in
text stores nothing — the 17 translations stay active; only actually-edited
text becomes a (deliberately untranslated) custom override. The clinical
study widget is now a centered 680px composition on desktop (matching the
survey's measure; it used to span the full content column left-anchored —
mobile unchanged). Housekeeping: the v6.8-era `scripts/proofs/` directory
was retired — its two proofs were long since ported into `validation/`
(settings-derivation + flip-test, and sims/az-split which had already
overtaken the frozen original when v6.10 changed the module it probes) —
and `npm run proofs` now runs the canonical `validation/` suite; a new
sims/survey-methodology suite (27 checks, mutation-tested) covers the token
substitution. After deploying: product page → survey → open "How the survey
was conducted" (unchanged wording = translations intact), and view a
product page with a clinical study on desktop to see the centered layout.

v6.10 — the Ships-from line has a merchant-selectable display style:
Features → Amazon patterns → Ships-from card → "Display style" — Subtle
(the pre-v6.10 microline, still the default; zero visual change until you
switch) or Prominent (green local-shipping signal with the truck icon and
the country in bold — recommended when fulfillment is local to the market).
Preview both styles from the Preview Center before adopting.

v6.8 — the "In Stock + Ships from" booster is now TWO independently
toggleable, independently market-targetable features (In-stock line /
Ships-from line, each still replacing the theme's stock message while on):
stores that had the combined feature enabled show ONLY the green "In Stock"
line after this update until the new Ships-from feature is switched on in
Features → Amazon patterns. The v6.8 machine proofs (settings derivation +
31-key flip, az split case matrix vs the real PDP module) were committed
in the repo at scripts/proofs/ and run with `npm run proofs` (since v6.11
both live on strengthened inside `validation/`, and `npm run proofs` runs
that full suite — the old directory is gone); the analytics
event allowlist also now accepts the nine beaconing az_* features, so
Amazon-pattern impressions (dropped server-side since v6.1) start counting
in Analytics from this release.

The Delivery guarantee now covers ALL THREE surfaces under the one feature:
product page, cart drawer (renders right under the dispatch countdown) and
checkout (new checkout-delivery extension placed under the shipping options)
— each surface independently on/off with its OWN format choice, same
translated wording everywhere, each previewable per surface from the
Preview Center · survey methodology copy updated in all 18 languages
(cosmetic research firm, 5-patients/8-weeks testing protocol, "requested by
Cellexia"; set Answered "Yes" to 248 on the Survey page after deploying) ·
NEW booster #20 "Delivery guarantee": per-country business-day delivery
estimates computed off the dispatch schedule (weekends via configurable
delivery days, Dec 24/25/31 + Jan 1 always excluded, conservative fixed-date
national-holiday table per country — on by default, toggleable per country;
per-country min/max overrides and per-country hide), four PDP widget formats
(line / range / 3-step timeline / guarantee box) each carrying the
"Delivery guarantee" badge with the refund-or-replace explainer tooltip,
translated in all 18 languages, format-previewable from the Preview Center;
configure under Features → Delivery guarantee (ships OFF) ·
Dermatologist-survey booster rebuilt as FIVE selectable display formats
(authority proof seal with a 90% ring, clinical results panel, verbatim
survey question, one-dot-per-dermatologist tally, understated single line) —
picked on the Survey feature page, each with the accessible "How the survey
was conducted" methodology disclosure (translated in all 18 languages,
numbers from settings, custom override supported), and previewable per
format from the Preview Center without touching the live site · all
merchant-sourced URLs now HTML-escaped in href attributes + stricter URL
sanitizers (security hardening) · free-shipping auto-detect snaps 60.01-style
rate-band values to round numbers (re-run Detect now once) ·
Checkout trust module: the "Continuous Treatment Plan members save 5%…"
line is removed (extension + all 18 languages) · Dispatch countdown fully previewable (in a preview session the widget always
shows — the real countdown when the display window is open, otherwise a
labeled sample plus a note saying exactly why buyers don't see it right now;
real visitors byte-identical, never fabricated urgency) · dispatch widget is
now a SINGLE line ("Order within 1h 17m for same-day dispatch" — the
buyer-local clock suffix is removed everywhere incl. all 18 languages) ·
preview coverage is now enforced: every current and future feature must map
to a verified preview surface and appear in the Preview Center / Features
hub pickers or the validation harness fails the build; both pickers also
gained an automatic fallback group so no feature can ever become unpickable ·
Auto-translation of per-product booster content (DeepL key on the Languages
page; translations registered natively via the Translations API, reviewable in
Translate & Adapt; names/labs/licenses/INCI/batch codes/dates never machine-
translated) · Trustpilot widget link toggle · container-aware guarantee copy
(jar/tube/pump/bottle, global default + per-product override) · subscribed-line
volume upgrades fixed (tiles only offer variants carrying the line's plan) ·
Dispatch countdown (timezone-correct same-day urgency, per-country schedules — enable + configure under Features → Dispatch countdown) · Auto cross-sell in the cart + auto checkout upsells (Shopify recommendations,
buyer-currency prices, Search & Discovery curation respected; hand-picked mode
still available) · subscription switch fixed (per-variant Joy plan allocations —
the 422 root cause) with one-tap "Upgrade all" + per-line remove · Guarantee check
modal on PDP (merchant-fact fields in the theme editor) · Order Protection card
redesign + per-market round pricing via Markets fixed prices · checkout-editor
visibility for all blocks + Pay-button-area placement option · HTML-entity display
fix in all languages · per-market free-shipping thresholds with auto-detection ·
preview hardening (hash-attribute checkout handshake, cart auto-tagging,
diagnostics) · Setup & health checks #10 (app proxy end-to-end) and #11 (deployed
extension build) · the seven §0 fixes.

**v8.4 — deploy-proofing after the "Cannot read properties of undefined
(reading 'count')" incident.** The app itself was verified correct (the proof
functions run green against a freshly generated client on both the tsx and the
plain-node/remix-serve execution paths); the error can only occur when the
RUNNING service uses a Prisma Client generated from a pre-v8 schema. v8.4 makes
that class of deploy failure (a) self-healing — `prisma generate` now runs in
both `postinstall` and the `build` script, so any normal rebuild regenerates
the client; (b) impossible to misdiagnose — every proof-library entry point
asserts the three models exist and otherwise throws a message with the exact
fix (instead of the cryptic `undefined (reading 'count')`), and Setup & health
check #12 "Proof library database" distinguishes a stale generated client from
missing DB tables, each with its own fix; and (c) easier to deploy right —
`prisma/schema.postgres.prisma` ships in-tree (drift-proofed by the validation
suite) so Postgres hosts never hand-patch `schema.prisma` again (§2, §3).

**v8.5 — full deployment audit (31-agent, adversarially verified) + the fixes.**
The audit's headline: v8.4's plain `prisma generate` would have generated from
the SQLite dev schema on a Postgres host, silently running production against a
throwaway local SQLite file (empirically reproduced: app healthy, checks green,
data on ephemeral disk). v8.5 closes it with three independent layers:
(1) `scripts/prisma-env.mjs` — the ONLY Prisma entry point in the npm scripts —
selects the schema from `DATABASE_URL` (Postgres → the twin; supports a
`PRISMA_SCHEMA` override for env-less build systems) and records the provider
in `prisma/.generated-client.json`; `npm run setup` now applies the right
database step per engine too (db push on Postgres, migrate deploy on SQLite),
making `docker-start` viable on both. (2) `app/db.server.ts` refuses to boot
when `DATABASE_URL` says Postgres but the client was generated for SQLite, and
passes `DATABASE_URL` as the datasource so even an unmarked mismatched client
fails loudly instead of opening `dev.sqlite`. (3) The *Proof library database*
health check now asks the connected database what engine it actually is and
fails on a wrong-database deploy. Also from the audit: the Dockerfile builds
again under the postinstall hook (schema + scripts copied before `npm ci`, plus
a `PRISMA_SCHEMA` build arg); the ZIP no longer contains `shopify.app.toml`
(template ships as `.example`) so unzipping can never clobber production
config; `automatically_update_urls_on_dev = false` guards the live app's URLs
from dev sessions; Admin API/webhooks pinned to `2025-10` (extensions stay on
their tooling line's `2025-07`; see the §3 maintenance flag for the 4.x
platform upgrade due before 2026-09-30); INSTALL.md rewritten to the same flow
(it still taught the banned hand-patch + `migrate deploy`-on-Postgres path and
said "three" checkout extensions). Proof status: the audit's smoke lane ran the
Postgres twin end-to-end against a real postgres:16 in Docker (db push clean,
server boot + route probes clean, PressItem insert/read/delete on real
Postgres), and the v8.5 selector + boot guard were then proven on fresh clones
of this ZIP — a build WITH `DATABASE_URL` records `provider: postgresql`, and
the wrong-way build (no `DATABASE_URL` at build, Postgres at runtime) now
REFUSES to boot with the exact fix in the error instead of silently serving
SQLite.

**v8.6 — Markets matrix completed + Display density made findable (merchant
couldn't find either).** The Markets page's targeting matrix had shipped with
only 15 of the 33 boosters since the per-product waves — the clinical study,
results gallery, batch transparency, risk-free guarantee, dermatologist
survey, press, dermatologist endorsements and all eleven Amazon patterns had
working per-market gating on the storefront but NO admin surface to edit it
(the dashboards only display "Market reach"). All 18 missing rows are now in
the matrix under three new groups (trust boosters / Proof library / Amazon
patterns — the Amazon rows are independent flags with no shared master
switch, unlike the cart rows which share cartUpsell), plus the same automatic fallback group the
Preview and Features pickers have had since v5.4, now enforced for the matrix
by the validation suite too — a future booster can never lose its market
control again. Separately, the "Display density" card (compact / ultra-compact
modes, bottom of the Features page) is now one click away from where merchants
actually look: a header link on the Proof library page and a link on the
Product boosters page, both deep-linking straight to the card.

**v8.7 — proof widgets became ONE app embed (merchant-verified theme
constraint).** The v8 press / endorsement wall / results gallery shipped as
section-target app blocks — but this store's legacy Liquid templates cannot
take app blocks on the product page (the theme editor offers no "Add block →
Apps" there), so they were unusable. They are now merged into a single app
embed, **"Cellexia proof library"**: enable it once under App embeds (like
the cart/PDP/Amazon embeds) and the widgets place themselves — product pages
directly below the info-tabs box, other pages at the end of the main content,
always press → endorsements → results, fail-closed when no anchor exists
(never dumped at the bottom of `<body>`). The three config islands are
byte-identical to v8.3 (density modes included); the three old block files
are deleted. A STANDING RULE now lives in docs/theme-integration.md and is
ENFORCED by the validation suite: every storefront surface ships as an app
embed — any new section-target block fails the build (the five pre-v8
optional drag-and-drop blocks are frozen exceptions). The Proof library
banner, Preview Center readiness notes, INSTALL.md §5.3 and the theme-embeds
health check (now probing the proof embed, warn-grade) were all repointed
from "place the blocks" to "enable the embed". DEPLOY NOTE: this changes the
theme extension — run `npm run deploy`, then enable the embed once.

**v8.8 — three new dermatologist-survey designs (merchant-selectable).**
Survey page → **Widget design** now offers four looks, all presentation-only
(same translated strings, same per-product numbers — the percentage headline,
the per-product question and intro, every outcome row with its count, the
methodology disclosure and the verifier all render in every design): **Classic** (the v7 layout; the only design the Display-density
compact toggle affects), **Certificate** (engraved attestation: double-rule
paper border, centered header between rules, large percentage, outcomes as a
ruled figures table), **Clinical dossier** (lab-report excerpt: ink header
band with inverted verified mark, index-numbered rows with fine gauges and
right-aligned figures) and **Verified seal** (die-cut seal holding the
percentage and verified label, outcomes as tight stat cards). The three new
designs are inherently short on mobile while showing everything. It is a
LIVE setting (density convention): saving applies to real visitors wherever
the widget is already live. Nothing to deploy beyond the normal both-halves
flow; no new translations (the designs recompose existing strings).

**v8.9 — per-widget product-page placement + mobile press polish (merchant
asks).** Features page → **Product-page placement** card (also one click from
the Proof library header): each of the press band, endorsement wall and
results gallery independently picks one of three spots on product pages —
**Below the info tabs** (default, the v8.7 position), **Above the proof
stack** (right before the dermatologist survey), or **Below the proof stack**
(after the survey / study / guarantee group). Widgets sharing a spot keep the
fixed press → endorsements → results order; when a product has no proof stack
the above/below choices fall back to the stack's own position and then to the
default chain — never nothing, never the footer. Home-page rendering is
unchanged. Live settings (density convention). Mobile press band (v8.10b):
the logo strip wraps and centers on every breakpoint — every logo is always
visible (the old horizontal scroller hid overflow logos with no affordance,
reported live with a 4th publication); a lone logo renders larger, and the
quote text is centered to match the eyebrow and attribution.

**v8.10 — press "All quotes visible" layout (merchant ask).** Features page →
Display density card → **"As seen in the press — layout"**: *Featured quote*
(the current logo strip + one large rotating quote; density tiers apply) or
*All quotes visible — compact cards* (every press quote renders at once as a
compact attribution card — logo or wordmark, the full quote, publication name
and the optional article link; masonry columns on desktop, one tight column
on mobile; nothing to tap, nothing hidden; density tiers are ignored — the
wall is inherently compact). Live setting, no new translations.

**v8.11 — proof-library translations (merchant ask: "the usual system").**
Press quotes, endorsement quotes + credentials and before/after testimonials
now translate like the per-product booster content — with one structural
difference: proof entries live in the app's own database, so Translate &
Adapt can never see them; the same contract is reproduced on a new
`ProofTranslation` table (additive — `db push` per §2 covers it):
DeepL via the merchant's existing key (Languages page), INCREMENTAL
(sha256 source digests — only missing/outdated fields are sent; editing an
entry re-translates just that entry), per-locale independent success, and
manual-edit protection (each Proof tab's entry editor has a "Translations"
review section; an edited value is marked manual and auto-translation never
overwrites it; clearing it falls back to the original). Names, publications,
URLs and country codes are NEVER machine-translated. Each Proof tab gains a
"Translate into all languages" button + a coverage line, and saves
auto-translate the saved entry when auto-translate-on-save is on. The
storefront passes the page locale on every proof fetch and the proxy overlays
stored translations per field — the original text is always the fallback, so
a missing translation can never blank a quote. Hardened after its own
adversarial review: translated chunks persist as they complete (a mid-run
DeepL quota/throttle failure never discards already-billed work — the retry
resumes exactly where it stopped), auto-writes are conditional so a manual
edit saved at ANY moment survives a concurrently-running bulk translation,
an edited entry immediately serves its NEW original text (never a
translation of the old text) until re-translated, DeepL detects each
quote's source language itself (market-scoped press libraries legitimately
mix languages), and long translation runs no longer block the moderation
buttons — translations run on their own request lane with a result toast.

**v8.12 — optional press logo switch cue (merchant ask).** Features page →
Display density card → **"As seen in the press — logo switch cue"** (off by
default): on the full featured layout, a short ink indicator renders under
the ACTIVE logo and glides to whichever logo the visitor taps — the learned
active-tab pattern, which signals "the other logos are tappable" without any
arrows or instructional text. Pointer users get a faint secondary cue on
hover/focus; reduced-motion visitors get the indicator without animation.
Compact/ultra tiers and the quote wall are unaffected. Live setting; no new
translations.

**v8.12b — enable switches on the Proof library tabs (merchant catch).**
"As seen in the press" and "Dermatologist endorsements" had no enable button
anywhere their Configure links led — the only master switches were the
Markets matrix rows. Each Proof library tab now carries its own
Active/Off badge + Enable/Disable button (press, endorsements, results),
exactly like the dashboard feature cards. Market targeting, per-product
opt-outs and content requirements still apply as before.

**v8.13 — per-language product names + Markets page redesign (merchant
asks).** Two changes, no deploy steps beyond the normal §3 flow:

1. *Product names tab* (new nav entry): the dermatologist survey and
   clinical study widgets speak the product's name inside a sentence, and on
   translated pages that name was either the untranslated English title or a
   machine translation that didn't match the store's exact name. The new
   page lets the merchant set the exact name per language: pick a product,
   set a base display name plus one field per published store language.
   Values live in a new translatable `cellexia.display_name` product
   metafield (auto-created the first time any product-related app page —
   including this new tab — loads, by the same definition-ensure pass as
   the other cellexia metafields; nothing to migrate), and each language is
   registered as a native Shopify translation on it, so localized pages
   serve the right name with zero runtime cost. Unset = falls back to the
   product title, byte-identical to v8.12b behavior. These names are
   deliberately NEVER machine-translated (excluded from the DeepL flow).

2. *Markets page* is now a master-detail layout instead of the giant
   feature × market checkbox grid: search/pick a feature on the left (with
   Active/Off, reach and unsaved-edit badges), edit its master switch,
   "All markets" mode and per-market chips on the right, with Select
   all/Clear shortcuts. Save semantics are unchanged — the same
   changed-only settings writes as before, and market selections still save
   while a feature is off (they apply the moment it's enabled).

**v8.13b — `{name}` placeholder in custom study/survey text (merchant
catch).** Custom text overrides used to ship verbatim, so "Tested on {name}
itself" showed the literal braces. Every merchant-entered text field of the
clinical study (title, concern, subject line, footnote, result labels and
suffixes, lab name, instruments) and dermatologist survey (headline,
question, intro, outcome statements, verifier, methodology — per-product
and the global default) now substitutes `{name}` with the product's display
name from the Product names page (per language; falls back to the product
title). Type it as `{name}` — common variants ({Name}, {{ name }},
{ name }) are auto-corrected on save. The placeholder also survives machine
translation of custom text, same as the existing `{{ total }}` family, while
proof-library prose (press quotes, endorsements, testimonials) is explicitly
exempt from placeholder freezing so brace-styled words in quotes still
translate normally. The editor field hints mention the placeholder.

**v8.14 — press quotes are now OPTIONAL: logo-only mentions (merchant
ask).** A press entry needs only a publication name; the quote field on the
Proof library → Press tab is optional. No deploy steps beyond §3; no schema
change (a blank quote stores as an empty string).

- *Logo-only entries in a mixed band:* an entry without a quote renders as a
  static (non-tappable) grayscale mark in the logo strip — no switch cue, no
  hover lift, no `aria-pressed` — while quoteful entries keep the tap-to-
  rotate behavior. The rotation starts at the first entry that HAS a quote.
  In the "All quotes visible" wall layout, a quote-less entry is a bare
  logo/name card (its "Read the article" link still shows when set).
- *No quotes at all → compact logo strip:* when no serving entry has a
  quote, the band automatically renders the classic "As seen in" pattern —
  eyebrow + centered wrapping logo strip, roughly half the height of the
  featured layout on both mobile and desktop. Density tiers and the logo
  switch cue are ignored in this state (nothing to reveal or switch), same
  as the wall layout.
- *Admin:* the entry list labels blank-quote rows "Logo only — no quote";
  translation status/coverage only counts entries that have a quote; and a
  cleared quote can never resurrect its old translations (stale rows are
  digest-skipped by the proxy overlay).

No new locale keys and no Liquid change — the band reuses the existing
eyebrow/aria strings, so nothing to re-translate.

## 6. If something looks wrong

- Preview link 404 → §Troubleshooting in INSTALL.md (app proxy).
- Checkout preview renders nothing → the FOUR blocks aren't placed (§4.4), or one
  deploy half is stale (§3) — the "Deployed extension build" health check tells you.
- Widgets missing for buyers → feature/market toggles (everything ships OFF), or
  Setup & health flags the cause.
- Press / endorsements / results gallery INVISIBLE on the storefront (even in
  preview, with content added and the feature on) → the "Cellexia proof
  library" app embed is not enabled. Theme editor → App embeds → switch on
  "Cellexia proof library" → save. One-time step; the widgets then place
  themselves (product pages below the info tabs, home page at the end of the
  main content). The Proof library page and the Preview Center readiness
  notes both say this.
- Proof library errors (press / endorsements / results won't load or save) →
  run Setup & health; the "Proof library database" check names the culprit —
  stale generated Prisma Client (rebuild per §3, never shell-generate) vs
  missing tables (`db push` per §2) — and the error banners now carry the same
  actionable fix.
- Rollback: redeploy the previous server build + previous extension version from
  the Partner Dashboard (extension versions are retained); `db push` changes are
  additive and safe to leave in place.

## 7. v6.1 — Amazon-pattern widgets: one extra deploy step

v6.1 adds a NEW app embed, **"Cellexia Amazon patterns"**, carrying the ten
Amazon-pattern features' product-page surface (buy-box card, trust microcopy,
compound FREE-delivery line, In-Stock line, bought-count, bestseller badge,
Frequently bought together, Similar items). Like every embed it ships disabled:

1. Deploy the extension (`npm run deploy`) as usual.
2. In the theme editor open **App embeds** and enable **Cellexia Amazon
   patterns** once, then save. (The existing "Cellexia PDP booster" and
   "Cellexia cart booster" embeds stay as they are.)
3. Turn individual az_* features on under **Features → Amazon patterns** —
   everything is OFF by default and market-scopable, and nothing renders from
   enabling the embed alone.

Notes: while the trust-microcopy feature is effective it replaces the
app-injected trust-badge strip on product pages — if you ever placed a trust
badge block manually in the theme editor, remove that block yourself. The
compound delivery line replaces the standard delivery estimate + dispatch
countdown on product pages while effective; the cart features replace the
ship-bar sentence and decorate the checkout button label, restoring the theme's
own label when switched off.
