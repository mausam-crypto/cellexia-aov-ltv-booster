# SPEC v29 — proof-block split: research band + award strip as their own features

**FeatureKeys** `research_band` (#44), `award_strip` (#45) · **sections**
`researchBand`, `awardStrip` · **admin** `/app/features/research-band`,
`/app/features/award-strip` · **island members** `rb`, `aw` · **markers**
`data-cx-feature="research_band"` / `"award_strip"` · built 2026-09-19.

The merchant's ask: "separate the based-on-published-research and the
Verbraucher Berichte thing into their own features outside the buy box
proof block. should be previewable separately as their own separate
features." So each piece now has its OWN flag, market scope, Preview
Center draft flag, URL-gate ownership, island member, feature marker and
impression beacon. `buy_box_proof` keeps only the in-panel rows
(ships-from, delivery, icon strip, guarantee card, rating row) and its
replacement rule — nothing else changed about it.

## 1. What did NOT change

The design order under the panel is v28's, verbatim: `.pdp__grey` → the
award strip → the research band → `.pdp__accordions`. The builders
(`bbpResearchNode`, `bbpAwardNode`, the seal, the one-row `--cxaw` fit)
are byte-shared between the new mounts and the legacy path. CSS classes
(`cx-bbp-research*`, `cx-bbp-award*`) are untouched. The v22 gate ids
`br`/`bs`/`ba` are STABLE (a visitor's stored unlock names them); only
`GATE_TARGETS[..].feature` moved to the new owners.

## 2. Data model and migration

`buyBoxProof.research/.seal/.award` moved to top-level sections:

```ts
researchBand: { enabled, showResearch, gate, institutions[], seal: { enabled, gate, imageUrl } }
awardStrip:   { enabled, gate, rank, count, category, publication, imageUrl, year }
```

`researchBand.enabled` is the NEW band master (strict default-OFF, v21
convention); `showResearch` carries the pre-v29 `research.enabled`
semantics (institutions on/off; the seal keeps its own switch, so a
seal-only band still exists).

**`coerceLegacyProofSplit`** (getSettings, innermost coercion, fed the
RAW blob like every coercion) lifts a pre-v29 blob so the split never
changes what shoppers see:

```
new enabled = old buyBoxProof.enabled AND the piece's own switch
```

— a piece was only ever visible under the master, so live shops stay
live and fresh/off shops stay off. Both migrated features also inherit
the proof block's market scope (which used to govern them), unless the
blob already stores their own. Gates, institutions, seal and award
fields are carried verbatim (they were sanitized when saved).

## 3. Island and the deploy gap

`pdp-booster.liquid` gains two members in the v26 `cx_qsl`/`cx_qs` idiom
(live = enabled + market scope; emission = live OR the feature's own
draft flag), and the big island/CSS/JS gate admits each alone:

```liquid
"rb": {"live": {{ cx_rbl }}, "c": {{ cfg.researchBand | json }}, "rs": {{ 'badges.research' | t | json }}},
"aw": {"live": {{ cx_awl }}, "c": {{ cfg.awardStrip | json }}},
```

The `bbp` member still ships `cfg.buyBoxProof` whole (now rows-only) and
KEEPS the `rs` eyebrow string: a NEW bundle over an OLD metafield (the
window between deploying and the first save/preview-arm, which rewrites
the mirror through the new server) takes `mountBbp`'s **legacy branch**
— no `rb`/`aw` member means both pieces render from the old nested
config exactly as v28 shipped, one `buy_box_proof` beacon and all.
Sims run every A-G/AW check against the legacy island on purpose.

**Paid for, not moved:** the ~860 B of new Liquid was funded by deleting
the eleven `assign cx_draft_* = false` pre-inits (nil is falsy in every
use; the armed-branch B2B nudge RE-clear stays) and by dropping the
schema `info` strings from the five FROZEN pre-v8 section blocks (this
theme's editor cannot even add them — the v8.7 lesson; all five were
already allowlisted since v18). Total Liquid: 99,430 → **99,030 /
99,500** — the wave ends with MORE headroom than it started.

## 4. Storefront

`init()` mounts in design order: `mountBbp()` (rows, or the whole legacy
composition), then `mountResearchBand()`, then `mountAwardStrip()` (the
strip inserts after `.pdp__grey` last, so it unshifts ahead of the band).
Each new mount is idempotent, gates on `pdpMemberAllowed(d, <its own
key>)`, stamps ITS feature marker over the shared builder, and beacons
under its own name with the v22 gate meta (`bbpGateMeta` reused:
`(conf, band, null)` for the band, `({award: c}, null, node)` for the
strip). `awBuildConf` forces `enabled: true` into the builder because in
the split model the enabled flag IS the feature flag, already decided by
the live/draft gate — a draft preview of a not-yet-enabled strip must
still render. Impression honesty holds: a fully locked strip paints
nothing and beacons nothing (the band can beacon the `"g:"` control arm
whenever its ungated half painted).

**Previewable separately** — the point: the Preview Center lists both
keys in the Product-page group; a verified session with only
`research_band` drafted renders the band alone, only `award_strip`
renders the strip alone, with the proof block and each other dark
(sims V4/V5).

## 5. Analytics

`ALLOWED_FEATURES` gains `research_band` and `award_strip` — and
**`buy_box_proof`, which had been missing since v19**: every proof-block
impression (and the entire v22 "Tagged-link pieces" split) was being
silently dropped by `proxy.track` — the v6.1/v13.1 silent-drop class, a
third time. Labels added on the Analytics page; `getGateSplits` now
groups the gate arms under the feature that owns each piece.

## 6. Admin

Three pages: **Buy-box proof block** (rows + the takeover banner, now
with a pointer to the two new pages), **Research band** (institutions +
`br` gate, seal + `bs` gate, own market scope), **Award strip** (the v28
card + `ba` gate, own market scope). The features hub, Markets matrix
and Preview Center list both new keys.

## 7. Validation

* `sims/buy-box-proof.cjs` — V1-V8 (split composition/order/markers,
  independence from the block and from each other, per-feature live
  flags, separate previews, draft-of-disabled strip, null-config
  fail-closed, no legacy double-render, per-feature gate meta +
  impression honesty) + mutants m11 (band not gated on its own feature),
  m12 (marker lost), m13 (legacy branch lost). 144 checks / 13 mutants,
  with the A-G/AW series running against the LEGACY island.
* `validation/harness.mjs` v29 block — gate owners, migration formula +
  scope inheritance, island members + v26 idiom + the kept `rs`, the
  draft-init diet (and the surviving B2B re-clear), init mount order
  (not mutation-testable from the sim — the sim drives mounts itself),
  per-feature allowed gates and beacon lines, the analytics allowlist
  (all three keys), page labels, Markets rows/mappers, Preview Center
  keys, hub links, and the rows-only proof-block page.
* Updated in place (documented): FEATURE_KEYS 43 → 45 pins (harness,
  settings-derivation, flip-test), the tail-append order pin, the
  STANDALONE_SECTION_FIELDS tail, the big-gate pin, the v22 sanitizer
  gate paths, and the v28 block's section/route paths.
