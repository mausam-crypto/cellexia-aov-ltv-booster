# Manual deploy guide — Cellexia AOV & LTV Booster

For when a new update ZIP arrives and no automated assistant is available to
run it through. Follow this in order. Every step here reflects a mistake
this app's own update exports have actually made at least once — skipping a
check doesn't mean it won't bite you, it means no one will catch it before
it ships.

## 0. Where everything lives

| Thing | Value |
|---|---|
| Canonical working copy | `cellexia-apps/cellexia-aov-ltv-booster-updated/cellexia-aov-ltv-booster` |
| GitHub | `github.com/mausam-crypto/cellexia-aov-ltv-booster` (branch `master`) |
| Render service | `cellexia-aov-ltv-booster` → `cellexia-aov-ltv-booster.onrender.com` |
| Render database | `cellexia-aov-ltv-booster-db` (Postgres, free plan) |
| Shopify Partner org | Cellexia Ltd |
| Client ID | `2aadc2719a5bc649804cb42c0cbb917c` |
| App proxy subpath | `apps/cellexia/*` — **this app owns "cellexia" alone.** Reviews uses `cellexia-reviews`, Subscriptions uses `cellexia-subscriptions`. Never let an update regress this app's subpath to anything else, and never give another app plain `cellexia`. |
| Theme extensions | `cellexia-booster` (theme app extension: PDP booster, cart booster, Amazon patterns), `checkout-protection`, `checkout-trust`, `checkout-upsell`, `checkout-delivery` (4 checkout UI extensions) |

## 1. Before touching anything

```bash
cd cellexia-aov-ltv-booster-updated/cellexia-aov-ltv-booster
git status --short      # must be empty — if not, something is mid-flight; stop and figure out what
ls shopify.app*.toml     # must show exactly ONE file: shopify.app.toml
```

If `ls` shows more than one `shopify.app*.toml`, a stray file from a past
export landed in this folder. Move it out before doing anything else — an
extra toml has previously caused a deploy to land on the *wrong app* under a
different Partner org.

## 2. Diff against the last real update, not this repo

**Don't diff the new ZIP against this canonical folder.** This folder's Liquid
files have had comments/whitespace stripped (see §5) — diffing against it
makes every file look "changed" even when nothing really is. Instead, keep
the previous update ZIP's extracted folder around and diff the new one
against *that*:

```bash
diff -rq /path/to/previous-update/cellexia-aov-ltv-booster \
         /path/to/new-update/cellexia-aov-ltv-booster \
  --exclude=node_modules --exclude=.git --exclude=build --exclude=dist \
  --exclude=.env --exclude=".shopify"
```

If you don't have the previous update ZIP anymore, diff against this
canonical folder anyway, but expect Liquid files to show noisy diffs — read
them carefully rather than trusting line counts, and check §5 before
assuming a Liquid file's changes are all "new content."

Read whatever `UPDATE.md` ships with the new ZIP in full before touching
code — it usually tells you what's genuinely new vs. what it *claims* is
already fixed (see §3).

## 3. Files that will look "changed" but are NOT — never copy these over

Every export regresses the same handful of files back to their un-fixed
state. Check the diff; if the ONLY difference is one of these patterns,
skip the file entirely and keep the canonical version:

- **`app/shopify.server.ts`** — the export ships without `import "dotenv/config"` at
  the top, without the `process.env.SHOPIFY_APP_URL || process.env.RENDER_EXTERNAL_URL || ""`
  fallback, and with `distribution: AppDistribution.AppStore` instead of
  `AppDistribution.SingleMerchant`. All three must stay as they are in this
  repo — copying the export's version breaks the Render deploy (empty
  `appUrl` crash) and breaks scope access on the live store (`AppStore`
  distribution silently grants zero scopes for this custom app).
- **`package.json`** — the export's `docker-start` is `npm run setup && npm run start`,
  which runs `prisma migrate deploy`. **This will fail against Postgres** —
  the shipped migrations are SQLite-dialect (generated in the export's dev
  environment). This repo's `docker-start` runs `setup:production` instead,
  which does `prisma generate --schema=./prisma/schema.production.prisma &&
  prisma db push --schema=... --skip-generate`. Keep ours; only adopt a
  version-number bump from the export if you want it reflected.
- **`shopify.app.toml`** — the export always ships a template with a blank
  `client_id` and `example.com` URLs. **Never overwrite this file's
  `client_id`, `application_url`, `redirect_urls`, or `[app_proxy]` block.**
  The only thing worth checking is whether `[access_scopes] scopes` lists
  something genuinely new — and even then, verify the scope actually exists
  (see the very next point) before adding it.
- **Any `extensions/*/shopify.extension.toml`** — the export omits the `uid`
  line entirely. That `uid` is what Shopify uses to recognize "this is the
  same extension, just a new version" rather than "a brand new extension."
  If you copy the export's toml over ours, the next deploy risks creating a
  **duplicate** extension entry instead of updating the existing one. Diff
  first; if the only change is a missing `uid` line, don't copy the file.

## 4. The scopes trap

More than once, `UPDATE.md` has instructed adding `read_price_lists` and
`write_price_lists` to the scopes list. **These scopes do not exist** — a
real `shopify app deploy` attempt will reject them outright. The actual
scope needed for the per-market pricing feature that prompted this
instruction is `write_markets` (already in this repo's scope list). If an
`UPDATE.md` ever tells you to add a scope, check it's real before adding it —
try the deploy and read the exact validation error if you're not sure; don't
just trust the doc.

Current, correct scope list (also in `shopify.app.toml` and `render.yaml`):

```
read_files,read_locales,read_markets,read_metaobject_definitions,read_metaobjects,read_orders,read_products,read_publications,read_shipping,read_themes,read_translations,write_files,write_markets,write_metaobject_definitions,write_metaobjects,write_products,write_publications,write_translations
```

## 5. The 100KB Liquid limit

Shopify caps a theme app extension's **combined** Liquid content (every
`.liquid` file under `blocks/` + `snippets/` in the `cellexia-booster`
extension, added together) at 100,000 bytes. This has been exceeded by new
feature content more than once. Check it before deploying:

```bash
cat extensions/cellexia-booster/blocks/*.liquid extensions/cellexia-booster/snippets/*.liquid | wc -c
```

If it's near or over ~95,000 bytes, strip in this order (all of these are
byte-identical to the rendered output — Liquid's `{%- -%}` dash-trim already
discards this content at render time, so removing it from the source file
changes nothing customers see):

1. **`{%- comment -%}...{%- endcomment -%}` blocks** (including the bare
   `comment`/`endcomment` form used inside `{%- liquid %}` multi-statement
   blocks).
2. **`#`-prefixed line comments** inside `{%- liquid %}` blocks (a Liquid
   line-comment syntax, e.g. `# SPEC v4.5: ...`) — these are NOT caught by
   the comment-block regex above; strip them as a separate pass.
3. **Leading indentation whitespace** on every line — safe *only* if you've
   confirmed the file has no `<pre>`, `<textarea>`, `white-space: pre` CSS,
   or JS template literals (backtick strings) where indentation is
   semantically meaningful. Check with:
   ```bash
   grep -in "<pre\|<textarea\|white-space:\s*pre" extensions/cellexia-booster/blocks/*.liquid
   grep -c '`' extensions/cellexia-booster/blocks/*.liquid
   ```
   If either check finds something, don't blanket-strip indentation in that
   file — handle it by hand.

After stripping, **verify tag balance** before trusting the result — a
regex-based strip can accidentally eat a real tag if the pattern is too
greedy:

```bash
node -e "
  const fs=require('fs');
  const s=fs.readFileSync('extensions/cellexia-booster/blocks/pdp-booster.liquid','utf8');
  const count=(re)=> (s.match(re)||[]).length;
  console.log('if',count(/\{%-?\s*if\b/g),'endif',count(/\{%-?\s*endif\s*-?%\}/g));
  console.log('unless',count(/\{%-?\s*unless\b/g),'endunless',count(/\{%-?\s*endunless\s*-?%\}/g));
  console.log('for',count(/\{%-?\s*for\b/g),'endfor',count(/\{%-?\s*endfor\s*-?%\}/g));
  console.log('template-open',count(/<template\b/g),'template-close',count(/<\/template>/g));
"
```

Every count in each if/endif, unless/endunless, for/endfor, and
template-open/close pair must match exactly. Repeat for every `.liquid` file
you stripped.

If stripping alone doesn't get you under the limit and a genuinely large new
feature is the cause, **the fix is not to split the feature into a separate
theme extension** unless you've confirmed none of the JS assets are shared
between blocks in a way that depends on being in the same extension (check
for a `window.SomeNamespace.__loaded` idempotency guard shared across
multiple blocks' `<script src>` tags — if you find one, splitting extensions
will break it, since each extension would load its own separate copy of the
file and the guard would make the second one silently no-op).

## 6. Other known gotchas

- **`react-reconciler`** must be a dependency in every checkout extension's
  own `package.json` (`checkout-protection`, `checkout-trust`,
  `checkout-upsell`, `checkout-delivery`) — the export has occasionally
  omitted it from a newly-added checkout extension.
- **Literal braces inside a `{{ }}` Liquid tag** — if you ever see something
  like `{{ 'some_key' | t: percent: '{percent}' }}`, this is a real Liquid
  syntax error (`shopify app deploy` will reject it: "was not properly
  terminated"), not just a lint nit. Fix by building the placeholder via
  string concatenation first: `{%- assign ph = '{' | append: 'percent' |
  append: '}' -%}` then reference `ph` instead of the literal string.
- **Polaris `<Button external>`** doesn't work inside the embedded admin
  iframe (throws "admin.shopify.com refused to connect" when clicked) — use
  `<Button target="_blank">` instead. Check any admin route the export
  touches for a regression back to `external`.

## 7. Sanity suite (run all of these before deploying)

```bash
npm install
npx prisma generate
npx tsc --noEmit                 # must be empty
npm run build                    # must succeed, both client and server bundles
npx shopify app build            # bundles all 5 extensions; "AssetSizeAppBlockJavaScript"
                                  # and "OrphanedSnippet"/"UnclosedHTMLElement" warnings are
                                  # known false positives — only a hard [error] plus a
                                  # non-zero exit / failed "built!" message means stop
```

## 8. Deploy

```bash
git add -A
git commit -m "describe what actually changed"
git push origin master           # Render auto-deploys the app server from this push

ls shopify.app*.toml              # re-check: exactly one file, right before deploying
npx shopify app deploy --allow-updates
```

After `git push`, confirm Render's redeploy actually finished before
considering the update done:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://cellexia-aov-ltv-booster.onrender.com/ --max-time 20
```

Should return `200`.

## 9. Safety

Every feature in this app ships **OFF by default** and stays off until a
merchant explicitly enables it in Settings/Features — deploying a new
version never changes what's currently live on the storefront by itself. New
app **embeds** (like "Cellexia Amazon patterns") additionally need enabling
once in the theme editor (App embeds) before anything can render at all, on
top of the feature-level toggle.
