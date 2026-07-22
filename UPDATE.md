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
| Missing `react-reconciler` | Declared in all three checkout extensions' `package.json` |
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

Additions in this update: `PreviewState` table; `TranslationConfig` table (holds
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
npm run deploy            # pushes theme extension + 3 checkout extensions + config
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
4. **Checkout editor** (Settings → Checkout → Customize): all three Cellexia blocks
   are now ALWAYS visible/previewable in the editor (they render representative
   previews there even when features are off). Place or re-position them — the
   upsell and trust blocks now also offer a placement anchored at the Pay-button
   area ("actions" slot). Save.
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

## 5. What's in this update (context for the diff you'll see)

Dispatch countdown fully previewable (in a preview session the widget always
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
