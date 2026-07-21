# SPEC v2 — Safe Defaults, Market Targeting, Experiment Tracker

Extends `SPEC.md` (v1 stays binding unless overridden here). Three pillars:

## 1. Safe-by-default install

Nothing may change on the storefront or in checkout until the merchant explicitly enables a
feature in the dashboard.

- `DEFAULT_SETTINGS`: every feature master `enabled` flag is now **false** (`cartUpsell.enabled`,
  `trustBadges.enabled`, `trustpilot.enabled`, `guarantee.enabled`, `clinicalResults.enabled`,
  `subscriptionNudge.enabled`, `checkoutUpsell.enabled`, `checkoutProtection.enabled`,
  `checkoutTrust.enabled`). Sub-flags (`showFreeShippingBar`, `showVolumeUpsell`,
  `showSubscriptionUpsell`, `showTrustRow`, `checkoutTrust.show*`) keep their true defaults —
  they only matter once the master goes on.
- **Semantics flip in every render surface**: missing/absent config now means HIDDEN.
  - Theme blocks: `{%- if cfg.<feature>.enabled == true -%}` (was `unless ... == false`).
    A nil metafield renders nothing at all (no config JSON, no assets, no templates).
  - Checkout extensions: missing/unparsable metafield or missing feature object → `return null`
    (inline DEFAULTS objects flip their `enabled` to false too).
- Dashboard: when every feature is off, `app._index` shows a friendly onboarding Banner
  ("Everything is installed but nothing is live yet — features go live only when you enable
  them"). Feature toggle cards unchanged.

## 2. Per-market feature targeting

### Model (settings.server.ts — already implemented, this is the contract)

```ts
export type FeatureKey =
  | "cart_volume_upsell" | "free_shipping_bar" | "cart_subscription_upsell"
  | "cart_trust_row" | "trust_badges" | "trustpilot" | "guarantee"
  | "clinical_results" | "subscription_nudge" | "checkout_upsell"
  | "checkout_protection" | "checkout_trust";

export interface MarketScope { mode: "all" | "selected"; markets: string[] } // market HANDLES
// settings.marketScopes: Record<FeatureKey, MarketScope>, default { mode: "all", markets: [] }
```

Effective visibility of a feature in market M =
`masterEnabledFlag && subFlagIfAny && (scope.mode === "all" || scope.markets.includes(M))`.
`resolveFeatureFlag(settings, key)` / `isFeatureOnForMarket(settings, key, marketHandle)` helpers
exist in settings.server.ts — use them, do not re-derive flag paths.

FeatureKey ↔ settings-flag mapping (also in settings.server.ts `FEATURE_DEFS`):
cart_volume_upsell → cartUpsell.enabled && cartUpsell.showVolumeUpsell;
free_shipping_bar → cartUpsell.enabled && showFreeShippingBar;
cart_subscription_upsell → cartUpsell.enabled && showSubscriptionUpsell;
cart_trust_row → cartUpsell.enabled && showTrustRow; trust_badges → trustBadges.enabled;
trustpilot → trustpilot.enabled; guarantee → guarantee.enabled;
clinical_results → clinicalResults.enabled; subscription_nudge → subscriptionNudge.enabled;
checkout_upsell → checkoutUpsell.enabled; checkout_protection → checkoutProtection.enabled;
checkout_trust → checkoutTrust.enabled.

### Storefront enforcement

- **Theme extension (Liquid)**: current market = `localization.market.handle` (nil-safe: treat
  nil as the primary market handle if determinable, else as "" which only matches mode "all").
  Each block/embed computes its feature's effective boolean inline (compact liquid; scope data
  from `cfg.marketScopes`). cart-booster additionally computes ALL four cart feature booleans
  for the current market and emits them as a flat `effective` object in the config JSON —
  cellexia-cart.js consumes ONLY those precomputed booleans (no scope logic in JS).
- **Checkout extensions**: market from the checkout localization API (verify exact surface in
  the installed 2025.7 typings — `useApi().localization.market` subscribable or dedicated hook,
  handle + id fields). Rule: mode "selected" + undetectable market → **hide** (fail closed,
  Google-ads compliance: never show something in a market it wasn't enabled for).

### Admin UX

- New nav item **Markets** (`app.markets.tsx`): the centerpiece is a **feature × market matrix**
  — one row per feature (grouped: Cart / Product page / Checkout), one column per market
  (from GraphQL `markets(first: 50) { nodes { id name handle } }`, new scope `read_markets`),
  each cell a checkbox = "feature visible in this market". Column header has "All on/off for
  this market" tri-state control; row start has the feature's master toggle + an "All markets"
  switch (mode=all). Editing cells switches the row to mode=selected with the checked set;
  turning "All markets" on resets mode=all. Single Save button persists the whole matrix
  (one patch), with unsaved-changes protection. Also show each market's name+handle and a hint
  that features must ALSO be globally enabled (master toggle) to appear anywhere.
- Each feature settings page gets a compact "Markets" card: radio All markets / Selected
  markets + checkbox list of markets (same data), saved with the page's Save.
- `markets.server.ts` service: `listMarkets(admin)` (id, name, handle, primary flag if
  available) and `marketCountryMap(admin)` (handle → ISO country codes via markets regions
  query) — the latter used by the orders webhook to resolve a market from the shipping country.

## 3. Experiment tracker (sequential — explicitly NOT A/B)

One live configuration per market at any time. An experiment = "flip these features for this
market, compare an equal-length window against the immediately-preceding baseline window".

### Data model (prisma — already migrated, contract)

```prisma
model Experiment {
  id Int @id @default(autoincrement())
  shop String
  name String
  market String        // market handle, or "all"
  flips String         // JSON: [{ key: FeatureKey, from: boolean, to: boolean }]
  revertState String   // JSON snapshot: { enabledFlags..., marketScopes } before start
  baselineDays Int     // 7..28
  baselineFrom DateTime
  baselineTo DateTime  // == startedAt
  startedAt DateTime
  endsAt DateTime      // startedAt + baselineDays
  status String        // running | completed | stopped
  concludedAt DateTime?
  outcome String?      // kept | rolled_back (set on conclusion)
  warningJson String?  // latest EarlyWarning JSON (recomputed on page loads)
  reportJson String?   // final ExperimentReport JSON (cached at conclusion)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([shop, status])
}
```

`Event` gained `market String?`; `OrderStat` gained `market String?` + `countryCode String?`.

### Data capture

- **Session beacon**: cart-booster embed JS sends ONE beacon per browser session
  (sessionStorage guard `cx_session_sent`): `{feature:"site", type:"session", meta:market}` +
  `market` field. `proxy.track` + `recordEvent` accept feature "site", type "session", and an
  optional `market` (string ≤64, `[a-z0-9-]` sanitized) stored in Event.market. All existing
  widget beacons also gain the market field (from the Liquid config).
- **Orders webhook**: resolves market from `order.shipping_address.country_code` (fallback
  billing) via `marketCountryMap` (cached 1h in module scope per shop), stores
  `market` + `countryCode` on OrderStat. Unresolvable → market null (excluded from per-market
  experiment metrics, included in "all").

### Metrics engine (`app/services/experiments.server.ts`)

`periodMetrics(shop, market|"all", from, to)` returns:
sessions, orders, revenue (shop currency), aov, unitsPerOrder, conversionRate
(orders/sessions; null when sessions == 0), subscriptionRate, protectionAttachRate,
upsellAttributionRate, plus per-day series (orders/day, revenue/day) for the tests.
Market "all" = no market filter; market M = rows where market == M.

### Statistics (`app/services/stats.server.ts` — pure, unit-tested)

- `welchTTest(sampleA: number[], sampleB: number[])` → { t, df, pTwoSided } with Student-t CDF
  via the regularized incomplete beta function (continued fraction, ~40 lines, no deps).
- `twoProportionZTest(successA, totalA, successB, totalB)` → { z, pTwoSided } pooled.
- Tests applied: AOV → Welch over per-order totals; orders/day + revenue/day → Welch over daily
  values; conversionRate / subscriptionRate / protectionAttachRate → two-proportion z.
- **Early warning** (`evaluateEarlyWarning(experiment)`): runs only after ≥3 full experiment
  days AND ≥30 baseline orders. A metric triggers when: direction is NEGATIVE, relative change
  worse than −5%, and p < 0.05. Severity "critical" (recommend stopping now) when p < 0.01 OR
  relative drop worse than −15%; else "caution". Positive significant movements are reported as
  good news, never as warnings. Result cached in warningJson with computedAt; recomputed on
  experiments/index/dashboard page loads (no cron needed).
- All statistical output must state sample sizes and use plain language in the UI
  ("Very unlikely to be random (p = 0.008)").

### Lifecycle

- **Create wizard** (`app.experiments.new.tsx` or a wizard inside `app.experiments.tsx`):
  1. Name + pick market (Select incl. "All markets") — **only ONE experiment may run at a
     time, shop-wide** (any running experiment blocks starting another; this makes the
     whole-shop revertState snapshot always safe to restore and keeps sequential data clean).
  2. Pick baseline length: 7 / 14 / 21 / 28 days (default 14) — shows live preview of baseline
     metrics for that market/window (calls periodMetrics), with warnings when baseline data is
     thin (<30 orders) or sessions are absent (conversion metrics will be n/a).
  3. Pick feature flips: table of all 12 features showing their CURRENT effective state in that
     market with a "flip" checkbox each (so you can turn features ON or OFF as the experiment).
     At least one flip required.
  4. Review screen: exactly what changes for whom, note "everyone in this market sees the new
     version — this is a sequential rollout, never an A/B split", then Start.
- **Start** (action): snapshot revertState, apply flips via saveSettings (adjusting
  marketScopes: turning ON for market M when globally off → master on + mode selected + [M];
  turning ON when mode selected → add M; turning OFF for M when mode all → mode selected with
  all-markets-minus-M; etc. — implement as `applyFlipForMarket(settings, key, market, to)` in
  settings.server.ts with exhaustive unit-reasoned cases) + syncSettingsToMetafields.
- **Running view** (`app.experiments.$id.tsx`): progress (day X of N), early-warning Banner
  (critical → red with "Stop experiment" primary action), live baseline-vs-so-far table
  (clearly labeled partial), flips list, market.
- **Stop early / Conclude**: both show the final comparison report (equal windows for conclude;
  truncated-but-equal windows for early stop: compare N experiment days against the FIRST N
  baseline days? No — against an equal-length window ending at baselineTo; implement
  `report(experiment, now)` using min(elapsedDays, baselineDays) from each window's start) and
  ask: **Keep the changes** (settings stay) or **Roll back** (restore revertState +
  syncSettingsToMetafields). Record outcome. Reports cache into reportJson.
- **Report**: side-by-side DataTable: metric | baseline | experiment | change % | significance
  (plain-language + p), with callout verdict cards for conversionRate, AOV, revenue/day; honest
  n/a rows when data insufficient. No composite "winner" claims — it's a tracker, not a test.

### Compliance guardrails (surface in UI copy)

- Only sequential comparisons; the report page states time-based confounds plainly
  (seasonality, ads changes) in a note.
- One running experiment at a time, shop-wide (rollback restores a whole-shop snapshot, so
  concurrent experiments would corrupt each other's state and statistics).
- The session beacon renders whenever the config metafield exists (independent of any feature
  flag) so the conversion denominator is continuous; conversion tests are suppressed when
  session coverage doesn't span the full baseline window.
- Changing feature settings for an experimenting market outside the experiment triggers a
  warning banner on the experiment page (compare current settings hash vs snapshot).

## Cross-cutting

- New scope: `read_markets` (toml + .env.example) — DONE in scaffold.
- New admin nav: Markets, Experiments — DONE in app.tsx.
- No new storefront copy → NO locale file changes (session beacon is invisible).
- README: new sections for the three pillars.
