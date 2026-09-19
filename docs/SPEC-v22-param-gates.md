# SPEC v22 — URL parameter gates

**Settings section** `paramGates` · **registry** `GATE_TARGETS` · **gate ids** `br`, `bs` · **admin** `/app/features/proof-block` · **island id** `cx-g` · **cookie** `cx_ux` · **proxy** `/apps/cellexia/gate` · shipped 2026-09-14.

A gated piece is **hidden on the normal storefront** and shown only to a visitor who
arrived through a link carrying that piece's own random parameter, remembered on their
device for 90 days. It is a general system: a future feature declares a gate id and points
at it, and everything below applies unchanged.

**First users (v22):** the two pieces of the v19 research band —
`buyBoxProof.research` (gate `br`) and `buyBoxProof.seal` (gate `bs`), each tickable on its
own. The buy-box rows themselves are never gated, so the proof block's suppression of the
classic badge / guarantee / Trustpilot / delivery widgets is unaffected by any of this.

**Third target (v28, documented spec update):** the award strip (gate `ba`),
docs/SPEC-v28-award-strip.md. Same rules, same `ParamGateCard`, same digests-only
projection; the harness pin moved from "exactly two" to "exactly three" gate targets.

**v29 (docs/SPEC-v29-proof-split.md):** the band and the strip became their own
features, and the three targets moved to the features that own the pieces
(`research_band` for `br`/`bs`, `award_strip` for `ba`). The IDS never change — a
live visitor's stored unlock names them. The gate references now live at
`researchBand.gate`, `researchBand.seal.gate` and `awardStrip.gate`.

---

## 1. Design invariants

Binding. Every one is enforced somewhere in §8, and none may be relaxed without a spec change.

1. **The link is the only input.** The experience depends on the query string of the URL the
   visitor followed and on the first-party storage that URL wrote — nothing else. No user
   agent, IP, referrer, device, `navigator.webdriver` or automation check appears anywhere
   in the module.
2. **The server response is byte-identical for every visitor**, parameter or no parameter.
   Liquid emits the same HTML; the difference happens entirely in the visitor's browser
   after a storage read. There is no server-side branch at all.
3. **The parameter belongs on the link's own destination URL** — Google Ads *Final URL
   suffix*, Meta *URL parameters*. Anyone who follows the link lands on exactly the page the
   customer lands on.
4. **Additive and non-material.** Gated content is trust and proof presentation only. Price,
   offer, discount, shipping terms, guarantee terms, product claims and availability are
   identical either way. Enforced structurally: `GATE_TARGETS` is a closed allowlist, so
   gating a new feature is a deliberate code change that gets reviewed.
5. **The default page stays complete.** Nothing is removed for the ungated visitor.
6. **The URL is stable, shareable and public.** Same URL, same result, for anyone, forever.
   No randomisation, no time window, no geo or device branching.
7. **Nothing is hidden from search engines and no robots directives are added.** The
   parameter is *not* stripped from the address bar — unlike the v4 preview token, which is
   stripped because it is a credential. Keeping it visible is honest and shareable, and
   stripping it would risk clobbering the `gclid`/`utm` values the theme's own analytics
   read at load. Shopify's canonical tag already points every parameterised product URL at
   the clean one.

**Stated limitation.** The digest is a 64-bit non-cryptographic hash. It makes the
parameter undiscoverable by reading page source; it is not a security boundary. The worst
case of a forced collision is that somebody sees an extra trust band.

---

## 2. Data model

`app/models/settings.server.ts`.

```ts
export const GATE_TARGETS = {
  // v29: ids are STABLE; ownership moved with the proof-block split.
  br: { label: "Research band — institutions",        feature: "research_band" },
  bs: { label: "Research band — certification seal",  feature: "research_band" },
  ba: { label: "Award strip",                         feature: "award_strip" }, // v28
} as const;

paramGates: Record<GateId, { enabled: boolean; param: string; token: string }>;
```

`paramGates` is **not** a `FeatureKey` — it is per-feature metadata, the
`rewards.freeShip.scope` precedent. `FEATURE_KEYS` stays at 42, there is no `MarketScope`
entry, and none of the four picker registries change. Market scoping still applies at the
owning feature's level, above the gate.

Gate ids are **stable and never reused**: a live visitor's stored unlock names the id, so
recycling one would hand them somebody else's gate. `DEFAULT_SETTINGS.paramGates` declares
every id, so `mergeSettings` (which walks the defaults) keeps the section intact — this is
a fixed registry, not a `DYNAMIC_RECORD_KEYS` case.

### The reference — one source of truth each

| Field (v29 paths) | Meaning |
| --- | --- |
| `researchBand.gate` | `""` = everyone, `"br"` = tagged links only |
| `researchBand.seal.gate` | `""` = everyone, `"bs"` = tagged links only |
| `awardStrip.gate` | `""` = everyone, `"ba"` = tagged links only |

The secret lives in `paramGates`; the intent lives in the feature. Neither is duplicated or
derived, and because each owning section ships to the PDP island whole (`"c": {{ cfg.researchBand
| json }}` / `cfg.awardStrip`) the reference rides along for free. (In v22 the references lived
at `buyBoxProof.research.gate` / `buyBoxProof.seal.gate` and rode the `bbp` member the same way.)

### Minting

The merchant never types a parameter. On enable, the sanitizer mints
`param` matching `/^[a-z][a-z0-9]{5}$/` and `token` matching `/^[a-z0-9]{10}$/` from
`crypto.randomBytes`, and re-mints anything that fails a rule:

- **Reserved names** are refused, by exact match and by prefix family: Shopify storefront
  controls (`variant`, `view`, `section_id`, `preview_theme_id`, `_ab`, `pb`, …), ad-click
  and analytics identifiers (`gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`, `ttclid`,
  `utm_*`, `srsltid`, …) and this app's own proxy parameters (`t`, `shop`, `product`, …).
  A collision with any of these would break a page or corrupt attribution.
- **Uniqueness** across gates: one unique parameter per gate, always.

Turning a gate off **keeps** its pair, so re-ticking it does not invalidate links already
running in a live campaign. *Regenerate* clears the pair, and the next save mints a fresh
one — which stops every existing link immediately, so the admin says so in as many words.

### Fail-closed referential integrity

A `gate` naming an unknown id is cleared. A `gate` naming a **known id whose gate is off**
is *kept*, and the runtime then paints nothing. Clearing it would fail open — showing
link-only content to every visitor, the one outcome that must never happen by accident.

Unticking the gate in the admin is a different thing: it clears the reference deliberately
and hands the piece back to everyone.

---

## 3. The digest

`app/models/gate-digest.ts` (TypeScript) and a twin inside the extension bundles.

Dual-lane FNV-1a 32 — two offset bases, `0x811c9dc5` and `0x811c9dcd` — over the decoded
string `param + "=" + value`, rendered as 16 lowercase hex chars. Deliberately **not**
`crypto.subtle`: the storefront capture must be synchronous, before first paint.

- `onDigest  = digest(param + "=" + token)` — opens the gate
- `offDigest = digest(param + "=off")` — clears it, the QA escape hatch

The metafield carries `onDigest + offDigest`, 32 hex chars per enabled gate.

**The raw pair never leaves the app database.** `projectGates` in
`app/services/metafields.server.ts` replaces the section in *both* mirrors (Liquid and
checkout) with digests, so the parameter cannot reach page source through some future
Liquid that prints a whole section, and is not in Shopify's metafield storage either.
`projectGates` returns `undefined` when no gate is on, so an ordinary shop emits no island
and pays nothing for the feature.

---

## 4. Storage and expiry

| Where | Key | Why both |
| --- | --- | --- |
| cookie | `cx_ux` | primary; re-issued with a 90-day `Max-Age` by the proxy (§5) |
| localStorage | `cx:ux` | synchronous mirror, so an unlock survives a cookie the browser declines to keep |

One value describes every unlock and when each lapses:

```
1.br-1797072000.bs-1797072000
^ format version   ^ gate id, expiry in epoch SECONDS
```

Per-gate expiry rather than one cookie-wide `Max-Age`: a visitor who arrives through a
second tagged link on day 80 does not silently extend the first gate, and the whole thing
is testable against an injected clock. Reads merge the two lanes on the later expiry;
anything expired, malformed or of an unknown format version is dropped, fail-closed.

**Self-healing.** When the value is intact in the mirror but the cookie lane is gone — the
Safari case — the next page view rewrites the cookie from the mirror, with **no network
call**. `app/models/gate-cookie.ts` is the shared parse/serialize; the extension carries a
twin.

---

## 5. The durable cookie

`app/routes/proxy.gate.tsx` → `/apps/cellexia/gate`, app-proxy authenticated like every
other proxy route, `Cache-Control: no-store`.

**Why it exists:** Safari's ITP caps a cookie written by `document.cookie` at 7 days no
matter what `Max-Age` it asks for. A cookie set by a first-party *response* is not capped,
so this endpoint is what actually delivers the 90 days on iOS — roughly half of Meta and
Google mobile traffic.

**It is not on the critical path.** The extension has already written localStorage and the
JS cookie before it calls, so the feature works with this route unreachable; only the
Safari window is shorter. It is called once per unlock, and never on an ordinary page view — and once, not
twice, on a product page where both bundles boot and both capture (`window.__cxGateSynced`
guards the page view).

The client sends **digests, not gate ids**, and the server maps each one back through the
shop's own gates — so the endpoint cannot open a gate for a caller who does not already
know the parameter. Response:
`Set-Cookie: cx_ux=<value>; Path=/; Max-Age=7776000; SameSite=Lax; Secure` — **no `Domain`
attribute**, so it defaults to the storefront host and stays first-party, and **not
`HttpOnly`**, because the extension has to read it back.

> **Deploy check, still open:** Shopify does not document whether an app proxy forwards
> `Set-Cookie`. Verify with `curl -i` against the dev store and record the answer here. A
> negative answer costs only the longer Safari window — nothing to roll back.

**Privacy.** `cx_ux` is a first-party functional cookie holding two short ids and an
expiry. No personal data, no cross-site identifier — the `cx:us_state` preference
precedent.

---

## 6. Storefront

### Liquid — 137 bytes, in `cart-booster.liquid` only

```liquid
{%- if cfg.paramGates -%}
<script type="application/json" id="cx-g">{{ cfg.paramGates | json }}</script>
{%- endif -%}
```

It sits beside the always-on session beacon: that is the one surface in the extension with
no page-type gate and no feature gate, so it runs on the home page, collections, blog and
product pages alike, and being inline it is parsed before any deferred bundle looks for it.
The bundle-loader condition also gained `or cfg.paramGates`, so `cellexia-cart.js` is
present on every page whenever a gate is live. **The gate term sits ahead of
`cx_ov.scrollFix`** — the v14 and v21 harness pins both require their tail of that
condition to stay contiguous.

### JS — the `cxGate*` module

Byte-identical in `cellexia-pdp.js` and `cellexia-cart.js` (the `cx:us_state` duplication
precedent), so whichever bundle a landing page loads captures the unlock. `cxGateBoot(Date.now())`
runs at the top of each `boot()`, synchronously, before the preview round trip and before
`init()` paints — a visitor landing straight on a product page sees the piece on the first
view, with no jump.

Parsing is by hand (`split('&')`, then the first `=`, then a guarded `decodeURIComponent`),
capped at `CX_GATE_MAX_PAIRS` (30). Position does not matter and neither do the other
parameters, so a tagged link composes with `utm_*`, `gclid`, `variant` or anything else.
The clear digest wins over the open digest when a URL somehow carries both.

### The two guards

```js
// bbpSealNode
if (seal.gate && !PREVIEW && !cxGateOpen(seal.gate, Date.now())) return null;
// bbpResearchNode
var researchGated = !!(research && research.gate) && !PREVIEW && !cxGateOpen(research.gate, Date.now());
```

`bbpResearchNode`'s existing `if (!painted && !seal) return null;` already removes the whole
band when both pieces are absent — no new combination logic. **`PREVIEW` always renders
gated pieces** so the merchant can check the design in the Preview Center; `track()`
already suppresses every beacon there.

Fail closed everywhere: no island, an unparseable island, a malformed digest pair, a gate
that is off, unreadable storage or a lapsed entry all mean the piece does not render.

---

## 7. Admin and analytics

`app/components/ParamGateCard.tsx` is **shared** (the `FeaturePageHeader` precedent, not
the deliberately-duplicated `MarketScopeCard` one) so every future gated piece gets the same
explanation, the same copyable link and the same warnings. One instance sits in the Research
band card and one in the Certification seal card of `/app/features/proof-block`.

It shows the bare `param=token` pair to paste into Google Ads *Final URL suffix* or Meta
*URL parameters*, a full example link, the `?<param>=off` test link, and the Regenerate
button with its warning. It states invariants 3 and 4 in the merchant's own terms.

**Analytics.** No Prisma migration: `Event.meta` already exists and `proxy.track.tsx`
already forwards it. `track()` gained an optional third `meta` argument, and `mountBbp`
passes `bbpGateMeta(conf, research)` — `""` when no piece of the block is gated (so an
ungated shop's beacons are byte-identical to before v22), otherwise `"g:"` plus the gated
pieces that painted. `"g:"` alone is the control arm and `"g:br,bs"` the treated arm; both
are needed or there is nothing to compare against. `getGateSplits` reads them and the
Analytics page renders a "Tagged-link pieces" table.

---

## 8. Budgets paid, not moved

- **Liquid** 98,010 → 98,147 B against the enforced 99,500 (Shopify cap 102,400). 137 B
  spent, 1,353 B still free. No pin moved, and no other file touched.
- **Locales** untouched: this feature ships no storefront copy. The el/ar 15,200 B wall is
  not approached.
- **FeatureKeys** 42 → 42. `paramGates` is not a `FeatureKey`, so no index-based consumer
  shifts and `settings-derivation`'s tail-order assertion is untouched.
- **Metafield** one extra key per mirror, 32 hex chars per enabled gate — bounded by
  `GATE_TARGETS`, which is a closed allowlist.

---

## 9. Validation

`validation/sims/param-gates.cjs` — **102 checks, 6 mutants**, executing the real `cxGate*`
functions extracted from the shipped `cellexia-pdp.js` against an injected clock, plus the
real `bbpSealNode` / `bbpResearchNode` / `bbpGateMeta` builders. Lettered contract:
A digest (including the canonical FNV-1a `"hello"` vector and the TypeScript twin),
B matching, C value format, D expiry, E independence, F fail-closed, G persistence,
H inputs, I twins, R render-side guards.

Mutants that must be caught: the clear digest losing to the open digest; expiry not
enforced on read; either render guard dropped; the format version not checked; the proxy
sync losing its de-duplication.

`validation/harness.mjs` section **v22** pins what a sandbox cannot see: that the registry
is closed, that **both** metafield mirrors project down to digests and no Liquid prints a
parameter, that the island is gated on the registry and never on the request, that the
module's *code* (comments stripped) reads none of the identity signals, that the digest
lanes and the 90-day constant agree across TypeScript and both bundles, that the module is
a byte-twin across bundles, that the reserved-name families are present, and that the proxy
endpoint takes digests rather than gate ids.

`validation/allowlist.json` carries three `wave: "v22"` entries — `cart-booster.liquid`,
`cellexia-pdp.js`, `cellexia-cart.js`.
