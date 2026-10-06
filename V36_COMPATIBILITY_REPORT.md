# v36 update compatibility report — for the developer

**Audited:** `cellexia-aov-ltv-booster-UPDATE-2026-10-06-v36` against the live repo (`master` @ `065d3bd`, deployed as Shopify app version `cellexia-aov-ltv-booster-73`, Render service healthy).

## Summary

Good news first: **the v36 feature content itself is clean and compatible.** The bundled historical content (v18 through v35) now matches our live repo byte-for-byte on every file checked — the divergence we hit on the v35 update (our `master` had evolved its own v33 independently of your package) is fully resolved on our end, and this package's baseline now matches it exactly. The new v36 feature — a full-screen swipe viewer replacing "Show more" in the results gallery — looks like a substantial, well-built, additive feature (619 new lines in `cellexia-proof.js`, 284 in the CSS, a new `docs/SPEC-v36-results-viewer.md`).

**But there is one confirmed, repeating incompatibility that needs your action before we can apply this update**, plus two smaller recurring bugs worth fixing at the source so they stop reappearing in every release.

## 1. Blocking — checkout extensions are still pre-migration React code

Shopify required all four checkout extensions in this app to migrate off the React architecture (`@shopify/ui-extensions-react`) to Polaris Web Components, before a 2026-10-01 deploy-blocking deadline. **We completed that migration and it's already live** (Shopify app version `-73`, all four extensions on `api_version = "2026-04"`, Preact + `<s-*>` web components).

This v36 package — like the v35 one before it — still ships the **old** pre-migration versions of all four:

| Extension | This package | Our live version |
|---|---|---|
| `checkout-trust` | `api_version = "2025-07"`, `react` + `react-reconciler` deps, `src/Checkout.tsx` | `api_version = "2026-04"`, Preact, `src/Extension.tsx` + `BlockRender.tsx`/`ActionsRenderBefore.tsx` |
| `checkout-delivery` | same old pattern | same new pattern |
| `checkout-protection` | same old pattern | same new pattern |
| `checkout-upsell` | same old pattern | same new pattern |

**We will not apply these four folders from this package** — doing so would silently revert a completed, deployed Shopify-mandated migration. This is the second update in a row where this has happened, so flagging it clearly: **please either stop including `extensions/checkout-trust`, `checkout-delivery`, `checkout-protection`, `checkout-upsell` in future update packages (they're not part of your feature work and shouldn't need to travel with it), or update your own source tree to the migrated architecture so future packages are compatible.** Happy to share our migrated source if that helps.

## 2. Recurring bug — Windows line-ending / shell compatibility fix keeps regressing

`scripts/prisma-env.mjs` and `validation/harness.mjs` both call:
```js
execFileSync("npx", [...], { cwd: ROOT, stdio: "inherit" })
```
On Windows, this throws `ENOENT: spawnSync npx` unless `shell: process.platform === "win32"` is added to the options. This fix has already been applied and documented as "now in-tree" as far back as the v22 round, but it keeps missing from the actual shipped files — this is the **third** release in a row (v22-era, v35, now v36) where we've had to re-add it by hand before `npm install`/`npm run build` would even run on a Windows machine. Worth checking why it isn't sticking in your own source tree.

## 3. Minor — stale scope boilerplate

`shopify.app.toml.example`'s scopes line still includes `read_price_lists,write_price_lists`, which (per our own notes from an earlier round) is a known no-op for this app — we deliberately use `write_markets` instead and have never needed these two. Not blocking, just worth removing from the template so it stops looking like a required addition on every release.

## What's safe to apply once #1 is resolved

Everything else in this package is clean:
- `app/services/results-ui-copy.server.ts` (81-line diff — new viewer copy strings)
- `extensions/cellexia-booster/assets/cellexia-proof.js` + `cellexia-booster.css` (the actual viewer implementation)
- `docs/SPEC-v36-results-viewer.md`
- `validation/allowlist.json` (one new v36 entry), plus the matching `validation/sims/proof-gallery.cjs` test coverage (VW1-VW11, LB6, mutants m50-m55)
- The three other extensions' `shopify.extension.toml` diffs are just missing `uid` lines (expected — those are deploy-generated, not something your template carries)

## Recommended next step

Once you've addressed #1 (exclude the checkout extensions or migrate them), we can apply the rest of v36 the same way we did v35 — confirm it merges cleanly, run our validation suite, and deploy. No need to resend the whole package just for that; a version without the four checkout extension folders would apply cleanly as-is.
