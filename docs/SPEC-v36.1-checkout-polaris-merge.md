# SPEC v36.1 — checkout Polaris web-components migration, merged + hardened

2026-10-06. The dev's migration package (guide archived at
`docs/vendor/CHECKOUT_MIGRATION_FOR_DEVELOPER-2026-10.md`) rewrote the
four checkout UI extensions for api_version 2026-04 (Preact + `<s-*>`
web components + the `shopify` global) and is ALREADY LIVE as app
version `cellexia-aov-ltv-booster-73`. This wave merges it into our
canonical tree — so v37+ packages stop regressing the live architecture
and the Oct-1-2026 deploy block stops gating our extension deploys —
after a full review against the 2026-10-05 audit checklist
(the audit artifact: https://claude.ai/artifact/CKgsgQYCdYs1ALsUR3EYAU).

## Review method + results

- **Base equivalence**: our checkout-* dirs had ZERO drift since v35
  (diffed against the v35 zip), and the audit had already established
  v33↔v35 byte-identity — so the dev's port base (their master = v33)
  equals our current code exactly. `trust-logic.ts` and
  `delivery-engine.ts` byte-identical in the package, twins consistent.
- **Anchor equivalence** (old `Checkout.tsx` vs new `Extension.tsx`,
  per extension): translation keys, `_`-prefixed cart-attribute keys,
  `cellexia_*` storage keys, instruction gates
  (canUpdateDiscountCodes/canRemoveCartLine), GraphQL query names and
  the `endsWith('cellexia')` namespace rule — ALL identical.
- **Full reads** of all four new `Extension.tsx` + all 7 entry modules:
  no network calls, no eval, no foreign endpoints; every guard
  preserved (mutationInFlightRef, addInFlightRef, autoAddStartedRef,
  kitStartedRef, yieldStartedRef, sawCodesRef, removingRef,
  latestLinesRef; fail-closed storage semantics; preview
  `mutationsAllowed = !inEditor && (!previewActive || rehearsal)`).
- **Types**: all four extensions `tsc --noEmit` CLEAN against the real
  installed `@shopify/ui-extensions@2026.4.4` (strict, full `<s-*>`
  attribute validation). Even `s-text type="redundant"` for the
  struck-through compare-at price is right — the installed Text.d.ts
  documents that exact use-case.
- **toml identity**: uid/handle pairs are the deploy-generated ones our
  tree previously lacked; preserved verbatim and now harness-pinned
  (section 8) — regenerating either orphans the live extensions.

## The three defects found and fixed in-tree

1. **Missing signals wiring (CRITICAL — present in the live `-73`).**
   `@shopify/ui-extensions/preact` is one line of runtime:
   `shopify.setSignals(Signal)` with `@preact/signals`' class — the
   mechanism that makes `shopify.*.value` reads inside components
   subscribe them (Shopify's own template ships the import; verified
   from the installed package source AND shopify.dev). The package
   declared `@preact/signals` as a dependency but NO module imported
   anything from it → the host's signals stay un-integrated → every
   extension renders once and only refreshes when unrelated local state
   re-renders it (trust/delivery: a 30s timer; protection/upsell: taps).
   The checkout-protection RewardsSafetyNet has NO local state at all —
   its gift-honesty / yield / KIT-attach effects freeze on first-render
   values. FIX: the import leads all 7 entry modules; harness-pinned
   per entry ("frozen-extension guard").
2. **Checkbox snap-back (audit item 4).** `s-checkbox` self-toggles in
   the DOM; after a FAILED `applyCartLinesChange` the `checked` prop
   value is unchanged, so Preact's diff never rewrites it — a declined
   add stayed visually ticked with no protection line. FIX: the change
   handler re-reads cart truth off `shopify.lines.value` after the
   mutation settles (shared `findProtectionLine` helper) and writes
   `el.checked` directly when they disagree. Harness-pinned.
3. **Dropped defensive gate (audit correction).** The old code read
   `'applyDiscountCodeChange' in api` before acting; the port dropped
   it citing the type declarations. Types are not runtime, and both
   rewards effects burn a ONE-SHOT storage key (KIT_YIELDED_KEY /
   KIT_ATTACHED_KEY) before calling the method — a throw after the
   write retires the action forever. FIX: `typeof
   applyDiscountCodeChange !== 'function'` early-return in both
   effects, before any storage write. Harness-pinned (count === 2).

## Side-fixes shipped with this wave

- `scripts/prisma-env.mjs` + `validation/harness.mjs`: `execFileSync`
  gains `shell: process.platform === "win32"` (npx is `npx.cmd` on
  Windows; Node refuses `.cmd` shims without a shell since the 2024
  spawn hardening). Static args only at both call sites.
- The dev's request to drop `read_price_lists,write_price_lists` from
  the scopes template was DECLINED with evidence:
  `app/services/protection-pricing.server.ts` calls
  `priceListFixedPricesAdd` and walks `Market.catalogs.priceList` — the
  Order Protection per-market price sync requires both scopes; nothing
  here uses `write_markets`. Flagged back in UPDATE.md §3b: if their
  live toml dropped the scopes, that sync is failing silently.

## Validation

- harness section 8 rebuilt: per-extension pins for api_version
  2026-04, exact uid+handle, React-family-stays-gone, jsxImportSource,
  the signals import per entry module, the snap-back and the two
  discount-method belts. The old react-reconciler pin is gone with the
  dependency.
- Pin moves for the architecture rename (Checkout.tsx →
  Extension.tsx): the harness feature-EVIDENCE map (8 entries), the
  v12/v13/v14 literal blocks (`useCartLines()` → `shopify.lines.value`,
  `useDiscountCodes`/`useInstructions` → `shopify.discountCodes`/
  `shopify.instructions`), sims/checkout-trust.ts T5 (path + 6 anchors:
  JSX.Element, star `type=`/`tone=` spellings, `'success' : 'auto'`,
  `'_cx_us_state')`), sims/checkout-delivery-engine.ts (path + 2
  anchors). Mutant suites untouched — they run against the pure
  modules, which did not change.
- `npm run validate`: 36 suites GREEN (12,325+ checks after this wave).
- Local typecheck recipe (no Shopify CLI needed): in an extension dir,
  `npm install`, write a `shopify.d.ts` of
  `import type {Api} from '@shopify/ui-extensions/purchase.checkout.block.render';
  declare module '@shopify/ui-extensions/checkout' { interface
  ShopifyGlobal extends Api {} } export {};` and run `npx tsc --noEmit`.
  Delete the shim afterwards — the real file is generated by
  `shopify app build` and intentionally not committed.

## What is NOT covered (same gap the dev declared)

Live-runtime click-through of the checkout flows (cart mutations,
discount interactions, the checkbox snap-back under a real decline) —
run the audit artifact's §6 runtime matrix in `shopify app dev`'s
checkout preview before the next deploy, and after deploying confirm
all four blocks are still placed in the checkout editor.

## Release

Ships in `cellexia-aov-ltv-booster-UPDATE-2026-10-06-v36.1.zip`
(supersedes the same-day v36 zip, which still carried the React
extensions). The extension half carries everything; the server half is
unchanged by this wave.
