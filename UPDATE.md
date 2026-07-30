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
| Missing dotenv loading | `dotenv` is a dependency; `app/shopify.server.ts` imports `dotenv/config` first (never overrides host-set vars) |
| Missing `RENDER_EXTERNAL_URL` fallback | `appUrl` resolves `SHOPIFY_APP_URL → RENDER_EXTERNAL_URL → ""` (also in the app-proxy health check) |
| Missing `react-reconciler` | Declared in all four checkout extensions' `package.json` (incl. the new `checkout-delivery`) |
| 27-char schema name limit | All block schema names now ≤ 25 chars (`Cellexia subscription`) |
| `external` → `target` Button iframe issue | ALL occurrences swept (14 across 5 admin routes — more than the 6 you found; new pages had regressed it) |
| 100 KB Liquid limit | The live/draft template pairs are deduplicated in-tree (single template with a conditional `data-cx-draft` marker) — `pdp-booster.liquid` is well under the limit again and won't regress |
| Before/after image height attributes | `width`/`height` attributes restored on B/A images (and added to every other extension `<img>`) |

## 1. ⚠️ Config merge — do NOT overwrite your `shopify.app.toml` values

This ZIP ships a template `shopify.app.toml` (empty `client_id`, example.com URLs).
Your production toml has the real values. **Keep yours** and change ONLY this:

- **`scopes`** — replace the line with (additions since your build:
  `read_shipping`, `read_price_lists`, `write_price_lists`, `write_translations`):

```
scopes = "read_products,write_products,read_publications,write_publications,read_orders,read_locales,read_translations,read_markets,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects,read_files,write_files,read_themes,read_shipping,read_price_lists,write_price_lists,write_translations"
```

Everything else in your toml stays as-is: `client_id`, `application_url`,
`redirect_urls`, and the whole `[app_proxy]` block (url = your host + `/proxy`).
Same for `.env` on the host — **no new environment variables** in this update.

## 2. Database — read this if production is Postgres

The `prisma/migrations` folder is **SQLite-dialect** (generated in development) —
`prisma migrate deploy` will NOT work against Postgres. For this update use:

```bash
npx prisma db push        # against DATABASE_URL — safe here: all changes are additive
```

Additions in this update: `PreviewState` table (+ `PreviewState.draftConfig`
column — non-boolean preview options, e.g. the survey format being previewed);
`TranslationConfig` table (holds
the merchant's DeepL API key server-side — deliberately NOT in the settings blob
that mirrors to metafields); `Experiment.startSyncErrors`; `Event.market`;
`OrderStat.market`, `OrderStat.countryCode` (+ indexes). `db push`
adds them without touching existing data. Take your usual DB backup first anyway.
(If you previously deployed with `db push`, this is just your normal flow. If you
maintain your own Postgres migration history, diff `prisma/schema.prisma` against
production and add the columns/table above by hand instead.)

## 3. Deploy — BOTH halves, in this order

The update changes the app server AND the extensions. Deploying only one half is
the #1 cause of "nothing changed" reports (preview/checkout handshakes span both).

```bash
npm ci                    # clean install (lockfile is authoritative)
npm run build             # must pass locally before you ship
# 1) APP SERVER: deploy/restart your Render service with this code
#    (build command unchanged; then: npx prisma db push per §2)
# 2) EXTENSIONS:
npm run deploy            # pushes theme extension + 4 checkout extensions + config
#    (v6.0 adds a FOURTH checkout extension, checkout-delivery — it deploys
#     with the same command, no extra registration needed)
```

Then in the store admin, **open the app once** — you'll be prompted to approve the
new scopes. Approve them (protection per-currency pricing, free-shipping
auto-detection, and booster auto-translation need them).

## 4. Post-deploy checklist (10 minutes, in order)

1. **Setup & health** (app nav): re-run checks — everything green. Two checks matter
   most after an update: *App proxy reachable* and *Deployed extension build* (its
   build number must have INCREASED — if it didn't, `npm run deploy` didn't land).
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

The repo now ships its full validation suite at `validation/` (16 suites,
~3,600 checks: equivalence prover vs a committed baseline, structural
tripwires incl. the Shopify Liquid-budget guard, and engine/feature
simulations that execute the real shipped code — all offline, ~3s):

```bash
npm run validate
```

Run it after `npm ci` and before deploying; a red scoreboard means stop.

## 5. What's in this update (context for the diff you'll see)

v6.8 — the "In Stock + Ships from" booster is now TWO independently
toggleable, independently market-targetable features (In-stock line /
Ships-from line, each still replacing the theme's stock message while on):
stores that had the combined feature enabled show ONLY the green "In Stock"
line after this update until the new Ships-from feature is switched on in
Features → Amazon patterns. The v6.8 machine proofs (settings derivation +
31-key flip, az split case matrix vs the real PDP module) are now committed
in the repo at scripts/proofs/ and run with `npm run proofs`; the analytics
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

## 6. If something looks wrong

- Preview link 404 → §Troubleshooting in INSTALL.md (app proxy).
- Checkout preview renders nothing → the three blocks aren't placed (§4.4), or one
  deploy half is stale (§3) — the "Deployed extension build" health check tells you.
- Widgets missing for buyers → feature/market toggles (everything ships OFF), or
  Setup & health flags the cause.
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
