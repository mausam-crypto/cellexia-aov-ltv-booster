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

Additions since the pre-v8 build: **three proof-library tables** — `PressItem`
(incl. `marketHandles`), `DermEndorsement`, `CustomerResult` (incl. the
`legacyGid` unique key that makes the before/after import exactly-once).
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

The repo now ships its full validation suite at `validation/` (19 suites,
4,400+ checks — `npm run validate` prints the live totals: equivalence prover vs a committed baseline, structural
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

v8 — THE PROOF LIBRARY (2026-08-02): three new trust surfaces backed by a
database + public JSON API, compact display modes, and the before/after
widget rebuilt as a browsable gallery.

DEPLOY STEPS SPECIFIC TO v8 (in addition to the §2 basics):
1. DATABASE: two new migrations ship (proof-library tables + press market
   scoping). SQLite dev applies them via `npm run setup`; Postgres
   production uses `prisma db push` as always (prisma/migrations are
   SQLite-dialect — the schema is the source of truth).
2. THEME EDITOR — the three new blocks must be PLACED (apps cannot do it):
   "Cellexia press", "Cellexia derm endorsements" and "Cellexia results
   gallery" are app blocks that work on ANY template. Place them on the
   product template (the results gallery REPLACES the old before/after
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

## 6. If something looks wrong

- Preview link 404 → §Troubleshooting in INSTALL.md (app proxy).
- Checkout preview renders nothing → the FOUR blocks aren't placed (§4.4), or one
  deploy half is stale (§3) — the "Deployed extension build" health check tells you.
- Widgets missing for buyers → feature/market toggles (everything ships OFF), or
  Setup & health flags the cause.
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
