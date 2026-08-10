# SPEC v10 — US delivery promise by state

Wave: **v10** (2026-08-08). **AS BUILT** — this file was the wave's design
contract and now records the landed reality; where the draft and the code
diverged, THIS text follows the code. Extends the delivery promise system
(`delivery_estimate` + `dispatch` schedule) with an optional **United States
state-level module**: per-state business-day windows, per-state days off, a
per-state dispatch cutoff, a self-hosted IP→state lookup for the product page +
cart, an Amazon-style "Deliver to: California ▾" selector, and the exact
typed-address state promise at checkout. **No new FeatureKey** (still 35), no
new scopes, no new env vars, no new extension or embed — everything rides
`delivery_estimate` as a sub-module (the `boughtOnCards` precedent).

Design doctrine (binding, from the merchant brief + house rules):

1. **The page always renders the current US-wide promise first**, exactly as
   before v10. The state layer is a *quiet upgrade*: if it cannot resolve —
   geo DB missing, fetch fails, VPN, malformed entry — the visitor keeps the
   US-wide promise. A state-layer problem must NEVER hide or corrupt the
   country-level widget. (Exception: an explicit `hidden: true` state override
   deliberately hides.)
2. **Checkout never guesses**: the state comes ONLY from the typed shipping
   address (`useShippingAddress().provinceCode`). That is where the binding
   guarantee lives. Checkout extensions have NO network access — no geo there.
3. **No visitor data leaves the system**: the IP lookup is served by our own
   app proxy from a locally compiled range table. The visitor's IP is never
   stored, never logged, never sent to a third party. Responses are
   `Cache-Control: no-store`.
4. Fail-closed stays absolute for *dates*: never show a date you cannot stand
   behind. Fail-open stays absolute for the *state layer*: degrade to US-wide.

---

## 1. Settings contract (landed in `app/models/settings.server.ts`)

```ts
/**
 * Per-US-state delivery override (v10). Every field OPTIONAL — an entry
 * overrides only what it sets; everything else inherits from the resolved
 * US country config (deliveryEstimate base + byCountry.US, dispatch base +
 * dispatch.byCountry.US). hidden:true hides the widget for buyers resolved
 * to that state (checkout too). cutoff/dispatchDays are PARTIAL dispatch
 * overrides (timezone always inherits — one physical warehouse).
 * extraHolidays entries are "MM-DD" (every year) or "YYYY-MM-DD" (one-off).
 */
export interface DeliveryStateOverride {
  minDays?: number;          // 0..30 int
  maxDays?: number;          // 1..30 int
  deliveryDays?: number[];   // ISO weekdays 1..7, non-empty
  holidaysEnabled?: boolean;
  hidden?: boolean;
  cutoff?: string;           // "HH:MM" 24h, warehouse timezone
  dispatchDays?: number[];   // ISO weekdays 1..7, non-empty
  extraHolidays?: string[];  // "MM-DD" | "YYYY-MM-DD"
}
```

`deliveryEstimate` gained one sub-object (after `byCountry`):

```ts
  usStates: {
    enabled: boolean;          // module master, default false
    selector: boolean;         // "Deliver to" selector, default true
    federalHolidays: boolean;  // built-in US federal holiday calendar, default true
    extraHolidays: string[];   // US-wide days off, "MM-DD" | "YYYY-MM-DD", default []
    byState: Record<string, DeliveryStateOverride>;  // USPS code keys /^[A-Z]{2}$/, default {}
  };
```

Landed rules:

- `DEFAULT_SETTINGS.deliveryEstimate.usStates = {enabled: false, selector:
  true, federalHolidays: true, extraHolidays: [], byState: {}}` — every field
  present so `mergeSettings` (which walks DEFAULTS' keys) preserves it;
  pre-v10 stored blobs merge to these inert defaults.
- `"byState"` is in `DYNAMIC_RECORD_KEYS` (wholesale-replaced on merge —
  matching is by BARE key name anywhere in the tree; editors always send the
  FULL map).
- Sanitize mirrors the `byCountry` block: typeof-boolean guards for
  enabled/selector/federalHolidays; uppercase 2-letter key gate (`iso2`
  regex); per-field keep-if-valid; `intInRange`; within-entry
  `maxDays >= max(1, minDays)` repair only; cutoff regex
  `/^([01]\d|2[0-3]):[0-5]\d$/`; day arrays cleaned 1..7 non-empty
  (`cleanDeliveryDays`); `extraHolidays` entries must match
  `/^(\d{4}-)?(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/` (invalid entries
  dropped; an EMPTY array is kept — an entry whose only surviving field is
  `extraHolidays: []` is therefore KEPT); empty entries dropped. The date
  regex is deliberately shape-only ("02-30" passes — same philosophy as the
  cutoff regex; the engines simply never match it).
- `extraHolidays` COUNTS are capped after filtering: **60 dates US-wide, 40
  per state** (`cleanExtraDates(raw, max)` filters by the shape regex FIRST,
  then `.slice(0, max)` — the first N valid entries in input order). Reason:
  the settings blob rides two json metafields capped at 65,536 chars on
  ApiVersion.October25; 60 + 51×40 dates keeps the worst-case blob near
  ~47 KB. Layering: `validateDeliveryPatch` fails LOUD at the same numbers
  BEFORE its per-entry shape loops — exact strings "US-wide extra days off
  can list at most 60 dates." / "Extra days off for California (CA) can
  list at most 40 dates." — so an over-limit patch through the admin action
  never persists (nothing saved, no metafield write attempted); the
  sanitizer slice is the silent fail-open backstop only for payloads that
  bypass the form. Client-safe mirror constants
  `US_EXTRA_DATES_MAX`/`STATE_EXTRA_DATES_MAX` sit next to
  `EXTRA_DATE_PATTERN`; both TextFields' helpText states the caps.
- Keys are NOT validated against a state list server-side (any AA..ZZ kept —
  harmless; storefront/checkout only consult codes they resolve to; the admin
  UI can only add the 51 known states).
- Cross-inheritance inconsistencies (state min over US-wide max) are NOT
  rewritten server-side; the resolvers fail **open**: a state entry that
  merges into an invalid window is IGNORED whole (US-wide promise stays).
  This deliberately differs from the country layer (fail-closed) per doctrine
  #1; the sanitize comment on the maxDays repair says so.
- Both metafield mirrors pick the sub-object up automatically (full spread).
- `validateDeliveryPatch` (app.features.delivery.tsx) is fail-loud for every
  field, per-state error strings naming the state ("The dispatch cutoff for
  California (CA) must be…"); client-safe mirrors `CUTOFF_PATTERN` +
  `EXTRA_DATE_PATTERN` carry "mirrors the sanitizer" comments.

## 2. US federal holidays + state data (landed, 4-way mirrored)

Server canonical, `app/services/delivery-holidays.server.ts`
(`DELIVERY_HOLIDAYS`/`GLOBAL_DELIVERY_EXCLUSIONS` untouched — 4-way
parity-pinned at 25 countries):

```ts
/** Fixed-date US federal holidays not already globally excluded. MM-DD. */
export const US_FEDERAL_FIXED = ["06-19", "07-04", "11-11"];
/** Movable federal holidays as [month(1-12), weekday(ISO 1-7), ordinal] — ordinal 5 = last. */
export const US_FEDERAL_RULES: Array<[number, number, number]> = [
  [1, 1, 3],   // MLK — 3rd Monday of January
  [2, 1, 3],   // Presidents' Day — 3rd Monday of February
  [5, 1, 5],   // Memorial Day — LAST Monday of May
  [9, 1, 1],   // Labor Day — 1st Monday of September
  [10, 1, 2],  // Columbus / Indigenous Peoples' Day — 2nd Monday of October
  [11, 4, 4],  // Thanksgiving — 4th Thursday of November
];
```

12-25 and 01-01 are global exclusions; `US_FEDERAL_FIXED` is identical to
`DELIVERY_HOLIDAYS.US` but the lists are kept independent (never
cross-referenced), so with `federalHolidays` on the net addition is exactly
the six movable rules.

`usFederalMovable(year): string[]` returns the six `"YYYY-MM-DD"` dates in
`US_FEDERAL_RULES` order (chronological within a year) — pure UTC calendar
math, no Intl. It exists in FOUR mirrors that the v10 sim
byte-/behavior-compares:

1. `delivery-holidays.server.ts` — canonical TS (`usFederalMovable`).
2. `extensions/checkout-delivery/src/delivery-engine.ts` — exported
   `usFederalMovable` + exported `US_FEDERAL_RULES` (exported so sims can
   extract them, the `DELIVERY_HOLIDAYS` extractability convention). The
   draft's alternate name `usFederal` was dropped — `usFederalMovable`
   everywhere in TS.
3. Its BYTE-IDENTICAL checkout-trust copy (sim T1 whole-file compare).
4. ES5 twins `deliveryUsFederal(year)` in `cellexia-pdp.js` +
   `cellexia-cart.js` (byte-identical to each other).

2026 oracle: 01-19, 02-16, 05-25, 09-07, 10-12, 11-26.

**State names**: `US_STATE_NAMES` — 51 entries (50 states + DC), English
proper nouns, single-line ES5 literal, byte-identical twins in both theme JS
assets (AZ_SHIPS_FORMS precedent: JS assets are uncapped; state names NEVER go
into locale files). Server inverse map `US_STATE_NAME_TO_CODE` in
`app/services/geo.server.ts` (importer-only: 51 canonical names + DC variants
— "District of Columbia", "Washington, D.C."; the "Georgia" country ambiguity
is resolved by the importer's `country === "US"` filter). `US_STATE_CODES`
(51, sorted) also lives in geo.server.ts and is PART OF THE ON-DISK BLOB
FORMAT (`stateIdx` indexes it) — never reorder; bump the `source` tag if it
ever changes (it won't in v10). Territories (PR, GU, VI, AS, MP) are NOT
states in v10: the importer drops them, the selector doesn't list them.

## 3. Config island emission (landed; measured source bytes)

All three delivery-bearing islands gained a `"us"` member INSIDE the existing
`"delivery"` object (nested ⇒ no new top-level cfg key pin), per block:

```liquid
assign cx_us = false
if cx_country == 'US' and cx_de.usStates.enabled == true
  assign cx_us = cx_de.usStates
endif
```

and inside the delivery member, before its closing `}`:
`{% if cx_us %}, "us": {{ cx_us | json }}{% endif %}`.

- Sites: `pdp-booster.liquid`, `cart-booster.liquid`, `amazon-booster.liquid`
  (az standalone delivery member — `azGapFillConfig()` copies `cfg.delivery`
  wholesale, so the nested `us` rides along on az-only pages; the az island
  was verified untouched otherwise).
- `deliveryStrings` in the SAME three islands gained ONE key:
  `"delivery.deliver_to": {{ 'delivery.deliver_to' | t | json }}` (no
  params). NOT one of the 7 required keys — a missing/empty string hides only
  the selector, never the promise.
- Non-US pages and module-off shops render byte-identical Liquid output; the
  rendered `{{ cx_us | json }}` size depends on the merchant's byState map and
  is not counted by the source budget. The storefront resolver re-validates
  every field, so unsanitized junk degrades to US-wide.
- Measured (wc -c): each island +228 B source — pdp-booster 24,812 → 25,040;
  cart-booster 20,612 → 20,840; amazon-booster 18,057 → 18,285. Blocks +
  snippets total 92,422 → 93,106 (tripwire ≤ 95,000).
- Reads go through the `cx_de` alias (no new cfg-path literal);
  `deliveryEstimate.usStates` landed in `DEFAULT_SETTINGS` in the same wave.

## 4. Storefront (landed in `cellexia-pdp.js` + `cellexia-cart.js` + CSS)

Module state (both files): `deliveryUsGeoState` (resolved code or null),
`deliveryUsGeoPromise` (single-flight), `deliveryUsDocBound`,
`deliveryUsEventToken` (a module-unique `{}` identifying this bundle's own
`cx:us-state` dispatches — §4b fan-out). Persistence:

- **User choice**: localStorage key `cx:us_state` — valid iff it matches
  `/^[A-Z]{2}$/` AND is a `US_STATE_NAMES` key, else ignored; all access
  try/catch-wrapped (private mode); set with an invalid/empty code clears.
- **Geo cache**: sessionStorage key `cx_geo:1` = `{"s":"CA"|null,"t":<ms>}`,
  TTL 21,600,000 ms (6 h), best-effort writes, negative caching (null
  verdicts AND fetch failures both cache `{s:null}` — no refetch storms).

Resolution precedence: **user choice > geo > none** (`deliveryUsCurrent`).

### 4a. Engine overlay — the FINAL federal design (one design, four engines)

`deliveryConfig()` (byte-twinned): after the existing country-override merge
and strict validation, the fail-OPEN state layer:

1. `var us = d.us;` — absent / not object / `us.enabled !== true` → return dc
   unchanged (module inert).
2. `var st = deliveryUsCurrent(us);` and `var e = us.byState && us.byState[st]`.
   Each field of `e` re-validated exactly like the country override
   (int-in-range, day arrays 1..7 non-empty, booleans, cutoff regex) into a
   CANDIDATE copy. `e.hidden === true` → return **null** (deliberate hide).
   Candidate `max < min` → **discard the WHOLE entry** (US-wide values stay;
   the discarded entry contributes NOTHING — not its extraHolidays, not its
   cutoff/dispatchDays). Valid → adopt minDays/maxDays/deliveryDays/
   holidaysEnabled, `cutoffMinutes` from `e.cutoff`, `dispatchDays`.
3. `dc.extra` = **merchant extra dates ONLY** (module `us.extraHolidays` then
   the adopted state entry's, each validated by the date regex; omitted when
   empty). `dc.usFederal` = `us.federalHolidays !== false && <RESOLVED
   holidaysEnabled>` (post-merge). `dc.us = {sel: us.selector === true,
   state: st || null}`. All three attach even when NO state resolves — with
   the module on, US-wide buyers already get module extras + federal
   holidays.

`deliveryQualifies(ut, dc)` owns the federal computation: one clause excludes
a candidate day when `dc.extra` contains its `mmdd` OR its full
`yyyy + '-' + mmdd`; a second clause, when `dc.usFederal`, computes
`deliveryUsFederal(y)` for the candidate day's own UTC year and excludes on
match (6 rules × ≤ 74 iterations — cheap, deliberately uncached). This
`dc.extra`-merchant-dates-only + `dc.usFederal`-boolean split IS the binding
design in all four engines; the draft's alternative (year-materialized federal
dates inside `dc.extra`) is dead.

### 4b. State resolution timing — `deliveryUsPrime` (sync, BEFORE mount) + `deliveryUsGeoKick` (async)

**`deliveryUsPrime()` (byte-twinned) is the synchronous half — zero
network.** Call sites: pdp `init()` immediately after `cfg = readConfig()`
(before `mountDispatch`/`mountDelivery`/`buildProofStack`/`azInit`); cart
`renderInto()` before any render decision. With the module on it (a) reads
the localStorage choice and AUTO-CLEARS it when its byState entry has
`hidden === true` (self-heal — the selector no longer offers hidden states,
§4d; the visitor falls back to geo, which re-hides a genuine hidden-state
local); (b) a kept choice masks geo — early return; (c) otherwise reads the
`cx_geo:1` cache and, when fresh (< TTL), sets `deliveryUsGeoState`
directly — no ticks, no beacon, no broadcast.

**Impression honesty (the v6.1 rule, held for v10)**: because prime runs
before every mount decision, a cached hidden verdict means
`deliveryConfig()` is already null at every mount gate — no node is built
and no impression beacon fires (`mountDelivery`, `azMountDeliveryLine` and
cart `renderDelivery` all fail their existing dc gates), and
`mountDispatch`'s `azReplacesDelivery()` pre-check evaluates against the
RESOLVED state, so the dispatch countdown that stays visible (the
country-schedule fallback) beacons honestly. A widget removed before paint
is never recorded as seen. The first-ever visit (no cache yet) still mounts
US-wide and beacons honestly — it painted; the async kick's verdict
upgrades/removes post-paint (accepted: the widget was genuinely seen).

**`deliveryUsGeoKick()` (byte-twinned, byte-untouched by the review fixes)**
runs once per page AFTER the delivery widget mounts (pdp: end of
`mountDelivery` after the beacon line, plus the az delivery mount; cart: in
`renderDelivery`), ONLY when ALL hold: `cfg.delivery` present with a valid
`deliveryConfig()`, `cfg.delivery.us` present (island-gated ⇒ country === US
and module on), no valid user choice, geo cache miss/expired. Cache hit
(including a cached null) applies without fetching — still correct for any
no-prime path. On miss: GET `routeRoot() + 'apps/cellexia/geo'` with
`cache:'no-store'`; accepts `{s:"CA"}` where `s` must match `/^[A-Z]{2}$/`
AND be a known state, else null. Stores the verdict, sets
`deliveryUsGeoState`, and when the effective state CHANGED runs the
quiet-upgrade fan-out `deliveryUsTicks()`: `deliveryTick()` +
`dispatchTick()` + typeof-guarded `azDeliveryTick()` + selector re-sync —
plus the cross-bundle broadcast below. All failures `.catch` → cache
`{s:null}` — silent. NEVER re-fires impression beacons. May run in verified
preview sessions (read-only, off `boot()`'s critical path, cannot pollute
analytics).

**Cross-bundle fan-out (`deliveryUsBroadcast()`, byte-twinned)**: pdp + cart
are separate IIFE closures on one page (mini-cart drawer over the PDP), so a
state change in either must reach the sibling or its dates/countdown lag up
to the 30 s interval behind an instantly re-synced label. The selector's
`change` handler and `deliveryUsGeoApply` (when the effective state changed)
write the shared storage FIRST, then dispatch a document CustomEvent
**`cx:us-state`** with `detail = deliveryUsEventToken`.
`deliveryUsDocBind`'s third once-bound document listener skips its own token
(no re-entrant loop) and otherwise runs `deliveryUsPrime()` +
`deliveryUsTicks()` — the sibling's module-local state converges from the
shared storage, so both bundles' labels, dates and countdowns agree
immediately. Engines without `CustomEvent` fall back to the 30 s interval
catch-up.

### 4c. Dispatch countdown coherence (landed decision)

`dispatchSchedule()` (per-file edit, semantically identical — NOT
byte-twinned): when `cfg.delivery && cfg.delivery.us` AND `deliveryConfig()`
resolved a state (`dc.us.state` non-null), substitute `cutoffMinutes`/`days`
**from the resolver's OUTPUT** — the countdown does not re-validate the raw
byState entry; it re-reads `deliveryConfig()`, so the fail-open discard rules
can never diverge between the countdown and the promised dates (cost: one
extra `deliveryConfig()` call per schedule read; 30 s ticks — negligible).
Timezone always inherits.

### 4d. "Deliver to" selector (landed structure + the attribution decision)

Builder `deliveryUsSelectorNode()` (byte-twinned), appended by
`deliveryUsSelectorAttach()` as the LAST child of each mounted delivery node
(`.cx-delivery` on pdp + cart, `.cx-az-delivery` on the az line) when:
`dc.us` present AND `dc.us.sel === true` AND `deliveryUsDeliverTo()` returns a
usable string (empty OR `Translation missing`-prefixed ⇒ selector hidden,
promise untouched — the azT/azStr rule). createElement/textContent ONLY
(innerHTML site counts unchanged: pdp 10, cart 7):

```
div.cx-usloc
  button.cx-usloc__btn  type=button  aria-expanded=false  aria-haspopup=true
    (pin icon via the existing cxIcon path — 'pin' added to CX_AZ_ICONS in
     BOTH files, 12px-rendered, currentColor)
    span.cx-usloc__label   → deliver_to string + NBSP + (English state name |
                             Intl.DisplayNames country name, fallback
                             'United States')
    span.cx-usloc__caret   → "▾"
  div.cx-usloc__pop  hidden
    select.cx-usloc__select  aria-label = raw deliver_to string
      option value=""  → raw deliver_to string (placeholder)
      options value=CODE → English state name, name-sorted — one per
        NON-hidden state (a byState entry with hidden: true is filtered
        out: a hidden state must never be CHOOSABLE; geo may still
        resolve one — see the trade-off below)
    a.cx-usloc__attr  href="https://db-ip.com"  rel="noopener" target="_blank"
      → "IP Geolocation by DB-IP"
```

- **Attribution (landed decision, differs from the draft)**: the
  `a.cx-usloc__attr` node is ALWAYS built inside the popover and toggled via
  the `hidden` attribute (own CSS guard
  `.cx-usloc__attr[hidden]{display:none!important}`) — visible ONLY while the
  effective state came from geo (CC BY 4.0 requirement); hidden for a manual
  choice or no state. Functionally equivalent to the draft's "absent from the
  DOM" and keeps re-fills idempotent. Sims MUST assert on the hidden
  attribute / visibility, never on node existence.
- Behavior: button toggles the popover via `hidden` (the v6.8.1 guard class
  `.cx-usloc__pop[hidden]{display:none!important}` exists); select pre-set
  to the current state. `change` → `deliveryUsChoiceSet(code)` +
  `deliveryUsTicks()` + `deliveryUsBroadcast()` ALWAYS, but the popover
  closes on change ONLY for a coarse pointer (`deliveryUsPointerCoarse()`:
  `matchMedia('(pointer: coarse)')`; a matchMedia miss counts as FINE — the
  keyboard-safe default). Constraint: native coarse pickers fire ONE change
  per commit, while a fine pointer arrow-browsing a closed `<select>` fires
  change per keystroke — closing there would commit-and-dismiss on the
  first arrow. Fine pointer: the popover stays open (a live date preview)
  and closes on select blur / outside click / Escape. Focus is never
  stranded: the Escape close (once-bound `deliveryUsDocBind` keydown)
  restores focus to the open popover's `.cx-usloc__btn`; a blur-close
  restores it when `relatedTarget` is falsy (focus would fall to `<body>`);
  blur ignores focus moves within `.cx-usloc`, and a one-task
  mousedown-inside flag keeps clicks inside the selector from blur-closing
  (Safari never focuses a clicked button — without the flag a button click
  would close-then-reopen). `aria-expanded` stays coherent: every
  open/close path goes through `deliveryUsPopToggle`. Outside-click +
  Escape + the `cx:us-state` listener (§4b) are the THREE once-bound
  guarded document listeners (`deliveryUsDocBind`, cheap open-popover early
  exit on the first two).
- Idempotence: `deliveryUsSelectorFill`/`Sync` re-derive label, selection and
  attribution from storage/module vars — cart re-renders re-create the
  selector without losing state (selection never lives in the DOM).
- CSS: new `"Deliver to" selector (v10)` section in `cellexia-booster.css`
  between the cart delivery block and the dispatch section — `.cx-usloc`
  (flex 1 0 100%, own row under the promise), `__btn` (quiet #565959 ink,
  underline-on-hover label, focus-visible outline; under
  `@media (pointer: coarse)`: `min-height: 44px` + `padding-block: 14px` —
  the house 44px touch floor; padding buys the target height while the
  visual stays the quiet 12px line, fine pointers keep the compact inline
  look), `__label`, `__caret`, `__pop` (hairline #d5d9d9, radius 8px,
  logical properties, z-index 30) + its [hidden] guard, `__select`
  (**font-size 16px, always** — iOS Safari auto-zooms, and STAYS zoomed on,
  any focused form control under 16px; the theme's own selects hold the
  same 16px line and the width-capped popover absorbs the larger control),
  `__attr` + its [hidden] guard. Every emitted class styled
  (CLASS-COVERAGE); no new element ids; RTL-safe.

**KNOWN TRADE-OFF (accepted v10 behavior, narrowed by the review fixes)**:
a `hidden: true` state can no longer be CHOSEN (its option is filtered out
of the selector) and a previously stored choice of a now-hidden state
auto-clears on the next `deliveryUsPrime()` (§4b), so the only remaining
hide path is GEO: a visitor geo-resolved to a hidden state loses the whole
widget — selector included — for up to the 6 h `cx_geo:1` TTL, with no
on-page corrector. For that state's genuine locals this IS the merchant's
stated intent (doctrine #1's exception); for a misresolved VPN/mobile
visitor it is an accepted cost, bounded by the TTL and masked by any
explicit choice made on an earlier page. Revisit only with product
sign-off.

### 4e. Storefront symbol inventory (the v10 sim's twin list)

Byte-identical twins in `cellexia-pdp.js` + `cellexia-cart.js`, spliced from
one source (`deliveryConfig`/`deliveryQualifies` were EDITED and stay owned by
`delivery-businessdays.mjs`'s twin list — the v10 sim registers ONLY the new
symbols; one owner, no dupes):

- vars: `US_STATE_NAMES`, `deliveryUsGeoState`, `deliveryUsGeoPromise`,
  `deliveryUsDocBound`, `deliveryUsEventToken`
- fns: `deliveryUsFederal`, `deliveryUsChoiceGet`, `deliveryUsChoiceSet`,
  `deliveryUsCurrent`, `deliveryUsDeliverTo`, `deliveryUsLabel`,
  `deliveryUsPointerCoarse`, `deliveryUsPopToggle`, `deliveryUsPopCloseAll`,
  `deliveryUsDocBind`, `deliveryUsSelectorFill`, `deliveryUsSelectorSync`,
  `deliveryUsTicks`, `deliveryUsBroadcast`, `deliveryUsSelectorNode`,
  `deliveryUsSelectorAttach`, `deliveryUsGeoApply`, `deliveryUsPrime`,
  `deliveryUsGeoKick`

`dispatchSchedule` is a per-file edit (semantically identical, not
byte-twinned). Hooks: prime — pdp `init()` immediately after
`cfg = readConfig()` (before every mount), cart `renderInto()` before its
render decisions (§4b); pdp `mountDelivery` (attach after
`bindDeliveryTooltip`, kick after the beacon line), pdp `azMountDeliveryLine`
(attach after the replacement removals, kick after track), cart
`renderDelivery` (attach after tooltip bind, kick before return).

## 5. Checkout (landed in both extensions)

`delivery-engine.ts` — edited in checkout-delivery, byte-copied to
checkout-trust (both 24,924 B, md5-identical; sim T1 compares whole files):

- `ResolvedDeliveryConfig` gained `extra?: string[]` + `usFederal?: boolean`
  (present only when the usStates module applied).
- `resolveDeliveryConfig(root, countryCode, provinceCode?: unknown)` —
  2-arg calls remain valid (provinceCode optional; no other call sites
  changed). Implementation note (landed, deliberate): the validated US-wide
  values are materialized into the typed `resolved` object BEFORE the state
  layer overlays it (TypeScript drops guard-narrowing of reassigned `unknown`
  lets — the draft's in-place merge did not compile); behavior is exactly
  §4a, and a discarded entry provably degrades to the validated US-wide
  values.
- State layer: applies when `country === 'US'` && `usStates.enabled === true`
  && `provinceCode` matches `/^[A-Za-z]{2}$/` (uppercased; anything else =
  US-wide, never hidden). Then EXACTLY the §4a semantics: `hidden` → null;
  per-field keep-if-valid candidate merge; whole-entry discard on candidate
  `max < min` (including its extraHolidays); cutoff/dispatchDays = PARTIAL
  dispatch override, timezone untouched; `extra`/`usFederal` built per §4a
  step 3 — note they attach even when provinceCode is absent on a US order
  (module-level extras + federal already apply US-wide; this is not a
  state-only path).
- `deliveryQualifies(ut, dc)`: the same two clauses as §4a
  (`dc.extra` mmdd/yyyy-mm-dd + `dc.usFederal` via `usFederalMovable` of the
  candidate day's UTC year).
- `Checkout.tsx` (both extensions, minimal): `const provinceCode =
  shippingAddress?.provinceCode;` next to the country read; passed as third
  arg; added to the memo deps. checkout-trust's tracked-row formatter logic
  untouched (state formatters would belong in `trust-logic.ts`, never the
  engine — v9 rule; none were needed).
- Sims (landed in the same wave, green in isolation):
  `validation/sims/checkout-trust.ts` — T5 anchor now
  `resolveDeliveryConfig(configRoot, countryCode, provinceCode)` + a
  `shippingAddress?.provinceCode` pin; T1 untouched; all 7 mutants caught.
  `validation/sims/checkout-delivery-engine.ts` — v10 fixture block (override
  applied incl. cutoffMinutes; hidden → null; inconsistent-candidate discard;
  invalid-field keep-if-valid; dispatchDays partial override; extras both
  forms + year scoping + non-leak; federal oracle + Thanksgiving qualify;
  cutoff-shifted dispatch day; `federalHolidays: false`; FR ignores
  provinceCode; module-absent inertness) — the 25-country pin untouched.

## 6. Geo pipeline (landed server half)

### Prisma (BOTH `schema.prisma` + `schema.postgres.prisma`, byte-parity
verified; SQLite migration `20260808094512_v10_us_geo` applied to dev)

```prisma
model GeoStateDb {
  id        Int       @id @default(autoincrement())
  shop      String    @unique
  status    String    @default("empty")  // empty | building | ready | error
  source    String    @default("")       // "dbip-city-lite-YYYY-MM"
  error     String    @default("")
  rangesV4  Int       @default(0)
  rangesV6  Int       @default(0)
  dataV4    Bytes?    // gzip( concat per range: start BE u32, end BE u32, stateIdx u8 )
  dataV6    Bytes?    // gzip( concat per range: start 16B BE, end 16B BE, stateIdx u8 )
  builtAt   DateTime?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}
```

`stateIdx` indexes `US_STATE_CODES` (§2). Production: `db push` per UPDATE.md
§2.

### `app/services/geo.server.ts` (Node 20 built-ins only, zero new deps)

- `buildGeoStateDb(shop): Promise<void>` — fire-and-forget and it NEVER
  rejects; a module-level in-progress Map single-flights concurrent builds;
  status row `building` → `ready`/`error`. **Single-flight is the in-memory
  map ONLY — the persisted status is deliberately NOT a start gate**: a
  restart mid-build empties the map and orphans the row on `building`
  (nothing in-process can ever finish it), so the next click starts a fresh
  build; `getGeoStatus` demotes such rows (below) so the admin card offers
  that click. Streams
  `https://download.db-ip.com/free/dbip-city-lite-YYYY-MM.csv.gz` (current
  UTC month; one-month fallback on HTTP failure) under a 10-minute
  AbortController covering fetch AND stream; gunzip → readline
  (line-streaming only — the ~84 MB gz / ~674 MB / ~7.9 M rows are never
  buffered). Light RFC-4180 parse of the first 5 fields (quoted fields, ""
  escapes). Filter `country === "US"`; `stateprov` name → USPS code via
  `US_STATE_NAME_TO_CODE` (unknown names counted + skipped — territories
  dropped by design). IP parse v4/v6 (`::ffff:a.b.c.d` normalized to v4).
  Ranges packed into growable buffers (1 MB steps) with inline
  adjacent-same-state merge + per-row sortedness verification; if violations
  were seen, the PACKED table only is sorted + re-merged (the documented
  simpler-robust path). ZERO US rows → refuses to replace the table. The
  error path updates ONLY status/error — **a failed refresh never unserves
  the previous good blobs**. gzip both tables, single upsert, in-memory index
  refresh. This is SOURCE data — no visitor data is ever involved.
- `getGeoIndex(shop)` — module Map cache keyed shop + builtAt-epoch; gunzips
  to `Uint8Array`s; corrupt blob → null (fail-open). **Landed decision: it
  serves the LAST SUCCESSFUL build regardless of the `status` column** (gate
  = builtAt + readable blobs, NOT `status === "ready"`) — a monthly refresh
  that fails sets status `error` but keeps serving (doctrine #1/#3).
- `lookupUsState(shop, ip)` — v4/v6/v4-mapped parse, allocation-free
  byte-compare binary search over the fixed 9-/33-byte records; returns a
  USPS code or null; the ip is never stored or logged.
- `getGeoStatus(shop)` → **GeoStatus** (the admin contract):
  `{status, source, builtAt: Date|null, rangesV4, rangesV6, error,
  progress: {rowsScanned, usRowsKept} | null}` — `progress` merged live from
  the in-progress map while building, null otherwise. **`building` is
  reported ONLY while THIS process holds a live map entry**: a persisted
  `building` row with no entry is an interrupted build (process died
  mid-download) and reports status `error`, `error =
  GEO_BUILD_INTERRUPTED` (`"build interrupted — run Download & build
  again"`, module const at the GeoStatus definition), progress null. The
  same call lazily HEALS the row — fire-and-forget update writing
  status/error ONLY, guarded by a `geoBuildsInProgress.has(shop)` re-check
  so a build that started meanwhile is never clobbered; a DB failure is
  swallowed (the next status read retries). The heal never touches builtAt
  or the blobs, so the serve-last-good gate (`getGeoIndex`) is unaffected.
  Admin consequence, no route change: the healed status flows into the geo
  card's existing error branch — "Download & build" re-enables (it disables
  only on `building`), the 3 s poll stops, recovery is one click.
  (Single-instance assumption, same as getCachedHealth — a second instance
  would both miss a live build's progress AND heal a row another instance
  is actively building; harmless, since the builder's own `ready`/`error`
  write still lands last.)
- `GEO_ATTRIBUTION = "IP Geolocation by DB-IP (db-ip.com), CC BY 4.0"`.

### `app/routes/proxy.geo.tsx` (proxy.track/proxy.proof idiom)

- `authenticate.public.appProxy`; an invalid-signature request surfaces the
  library's thrown 400 Response (identical to the other proxy routes); null
  session → 401 `{s:null}`; GET/HEAD only (405 otherwise).
- Client IP: FIRST entry of `x-forwarded-for` (Shopify sends the buyer IP
  first; hosts append hops), syntactic validation; unparseable → `{s:null}`.
- EVERY response carries the literal `"Cache-Control": "no-store"` via one
  `geoResponse` helper (a per-IP answer must never be cross-served by a
  shared cache); every lookup/error path returns 200 `{s:null}` (200 avoids
  storefront console noise). Body is only `{s}` — the IP is never echoed. No
  query params are read.

## 7. Admin (landed in `app/routes/app.features.delivery.tsx`)

Card **"United States — delivery by state"** after the country-override card
(house patterns: stacked rows + Divider, Select-to-add, plain critical
Remove, single `"patch"` POST, client+server validation mirrors, helpText
honesty):

- Master Checkbox → `usStates.enabled`; indented content when on: selector
  Checkbox; federalHolidays Checkbox whose helpText lists THIS year's movable
  dates (server-computed in the loader via `US_FEDERAL_MOVABLE_NAMES` —
  never `new Date()` in render) and notes the fixed dates already ride the US
  table; US-wide extra-days-off TextField (comma-separated MM-DD /
  YYYY-MM-DD; helpText states the 60-date cap, §1).
- Per-state rows (Select-to-add over the 51-entry client literal
  `US_STATE_OPTIONS` minus used, name-sorted): min/max days (placeholders =
  EFFECTIVE US-wide values, computed from live form state — the country
  rows' live-placeholder pattern), custom delivery weekdays, holidays
  inherit/on/off Select (inherit label shows the effective behavior), cutoff
  HH:MM (placeholder = effective US cutoff from saved dispatch settings;
  "timezone always inherits" copy), custom dispatch days, per-state extra
  days off (40-date cap in helpText, §1), hidden Checkbox, Remove. A NON-BLOCKING per-row caution appears
  when an entry merges into an impossible window against the US-wide values
  ("…the storefront ignores this override — fail-open") — the server
  deliberately accepts these; the caution keeps the ignore honest.
- Save posts `usStates = {enabled, selector, federalHolidays, extraHolidays,
  byState}` with the FULL byState map (wholesale-replace rule, marker
  comment). Dirty tracking canonicalizes parsed extras ("a, b" vs "a,b" never
  dirty). The form-reset effect keys on serialized settings CONTENT, not
  object identity (the 3 s polling below would otherwise wipe unsaved edits).
- **Live examples**: `computeExample(settings, country, now, state?)` applies
  the §4a/§5 semantics (reuses `US_FEDERAL_FIXED`/`usFederalMovable` from the
  holidays service; module extras + federal apply to the plain "US" example
  too). `DeliveryExample.code` allows `"US-CA"`; codes appear only when the
  module is enabled; Select labels "United States — California".
- **Geo card "State detection database"**: status line per state — empty /
  building (live rowsScanned + usRowsKept counters) / ready (source + range
  counts + builtAt, formatted server-side, + monthly-refresh note) / error
  (an interrupted build — restart mid-download — surfaces here as "build
  interrupted — run Download & build again" with the button re-enabled, §6);
  primary Button **Download & build**; **Test lookup** TextField + Button
  (disabled unless status `ready`) rendering `ip → California (CA)` or the
  no-state fallback; subdued attribution paragraph (`GEO_ATTRIBUTION`, the
  storefront selector shows the required DB-IP link whenever a detected state
  is in use, product page falls back to US-wide without the DB, checkout
  works regardless via the typed address).
- **geoIntent action contract** (branches BEFORE the patch path;
  `SettingsSaveResult` gained an optional `geo` member so the shared
  `{ok, syncErrors}` Banner/Toast contract is untouched):
  - `geoIntent=build` → `buildGeoStateDb(shop)` fire-and-forget (it
    single-flights itself and never rejects) → fast response
    `{ok: true, syncErrors: [], geo: {intent: "build"}}` — the `geo` marker
    keeps the shared save-toast quiet (build gets one ack toast).
  - `geoIntent=test` with an `ip` field → `lookupUsState(shop, ip)` in
    try/catch → `geo: {intent: "test", ip, state, error?}`.
  - While `geoStatus.status === "building"`: 3 s polling revalidation via
    `useRevalidator`, cleaned up otherwise; `pendingGeoIntent` keeps the
    Save spinner off during geo posts.
- `deliveryReadiness` (preview.server.ts): when `usStates.enabled`, the
  reason string gains " US state module on — N state overrides; product-page
  detection needs the IP database (build it on the Delivery page)." —
  static wording, sync, no DB read; placed between hiddenNote and
  scheduleWarning (the fail-closed timezone warning stays last).

## 8. Locale key (landed; theme extension only)

`delivery.deliver_to` in ALL 18 theme locale files, positioned LAST in the
`delivery` group. The label ONLY — the JS appends NBSP + the state/country
name; each language's colon convention lives INSIDE the string. en
`"Deliver to:"`; fr `"Livrer à :"` with a genuine NBSP U+00A0 before the
colon (byte-verified); ja `"お届け先:"` with the ASCII colon DELIBERATELY (a
Latin state name follows — ja's own Amazon-style group does the same); nb
stays a byte-copy of no. All files ≤ 15,000 B after the change (tightest:
el.json 14,660 — 340 B headroom; ar.json 14,590). Checkout locales: NO
changes.

## 9. Validation obligations (same wave, `npm run validate` green)

1. `validation/sims/us-state-delivery.mjs` (register in run-all SUITES +
   suite-manifest `required`, floor 8000): twin byte-identity for EXACTLY the
   §4e inventory (only the NEW symbols — `deliveryConfig`/`deliveryQualifies`
   stay with `delivery-businessdays.mjs`; one owner, no dupes); 4-way
   behavioral parity of the federal computation (server TS, 2× ES5, checkout
   TS) incl. the 2026 oracle; the overlay matrix (override applied / hidden /
   invalid-entry-ignored incl. no-extras-leak / cutoff + dispatchDays
   adoption / extra dates both forms with year scoping / federal off /
   choice-beats-geo); geo fetch unit (stubbed fetch + mini-DOM:
   single-flight, TTL, negative cache, tick fan-out, no beacon); selector DOM
   (label text = raw deliver_to + NBSP + name, popover hidden toggle,
   coarse-pointer change → choice + close vs fine-pointer change keeps the
   popover open with blur/outside/Escape close + focus restore per §4d,
   hidden states absent from the options, attribution VISIBILITY toggled via
   the hidden attr — never node absence, per §4d). Review-fix additions ride
   the same suite: prime-before-mount source-ORDER + behavior pins (§4b —
   cached hidden verdict ⇒ `deliveryConfig()` null pre-mount, stored hidden
   choice auto-clears, expired cache ignored with the kick still
   refetching), cross-bundle `cx:us-state` fan-out (two vm closures over ONE
   shared document: sibling ticks exactly once, own-token echo skipped, no
   re-entrant loop), `dispatchSchedule` extracted into BOTH per-file bundles
   with §4c coherence checks (resolved state ⇒ schedule = resolver output;
   discarded entry ⇒ US-wide; hidden ⇒ country fallback) + mutants M7/M8,
   and a per-entry `CX_AZ_ICONS` twin check (the cart table is a deliberate
   subset — the law is per-cart-key byte equality + 'pin' present in both).
   ≥5 mutation tests with `FAIL: ` tap.
2. `delivery-businessdays.mjs`: `dc.extra`/`dc.usFederal` engine cases ride
   the existing FUNCS extraction; its 25-country + exclusion pins untouched.
3. Checkout sims: landed per §5 (both green in isolation; re-verify in the
   full run).
4. `settings-derivation.ts`: usStates defaults resolve; sanitize round-trips
   (bad cutoff dropped, lowercase keys upcased, byState wholesale-replace,
   extraHolidays validation incl. the kept-`[]` entry, pre-v10 blob
   back-compat → inert defaults). Fixtures must NOT expect calendar-exact
   date rejection (the regex is shape-only, §1).
5. `harness.mjs` v10 pins: `proxy.geo.tsx` exists + literal
   `"Cache-Control": "no-store"` + `x-forwarded-for` read; `GeoStateDb` in
   both schemas (twin parity automatic); the `"us":` emission in the three
   delivery members; `delivery.deliver_to` in all 18 locale files; the
   `.cx-usloc__pop[hidden]` CSS guard. Landed pin literals: localStorage
   `cx:us_state`, sessionStorage `cx_geo:1`, proxy path
   `apps/cellexia/geo` (the TTL `21600000` is held by the v10 sim —
   exactly-expired fixtures plus a mutation anchor on the literal, not a
   harness grep). Never weaken existing pins; Liquid total stays
   ≤ 95,000 (now 93,106).
6. `validation/allowlist.json` v10 entries for the five diverging extension
   files: pdp-booster.liquid, cart-booster.liquid, amazon-booster.liquid,
   cellexia-pdp.js, cellexia-cart.js (cart-booster.liquid + cellexia-cart.js
   get their FIRST entries; reasons name the functions/members + covering
   sims).
7. All suites offline/deterministic: the geo sim stubs fetch; clocks
   injected. Run-all totals CHANGE vs v9 (new suites) — UPDATE.md §5 says so.
8. Review-fix hardening (landed same wave, beyond item 1):
   `checkout-delivery-engine.ts` readSource-anchors
   `extensions/checkout-delivery/src/Checkout.tsx` for the 3-arg
   `resolveDeliveryConfig(configRoot, countryCode, provinceCode)` +
   `shippingAddress?.provinceCode` (mirrors checkout-trust T5 — tsc cannot
   catch a 2-arg fallback because provinceCode is optional by design, §5);
   NEW `validation/sims/geo-lookup.ts` covers the server geo half offline
   (the REAL geo.server.ts via the settings-loader anchor pattern — prisma
   swapped for an in-memory row store, fetch stubbed with a gzipped
   synthetic CSV): the build pipeline end-to-end, the `lookupUsState`
   boundary matrix incl. `::ffff:` mapped v4 and misses, `US_STATE_CODES`
   exact content AND order pin — it is the on-disk blob format, §2 — the
   §6 interrupted-build heal contract (exact error string, heal touches
   status/error only, build restarts over an orphaned row,
   serve-last-good on `error` rows) and the proxy's
   FIRST-`x-forwarded-for`-entry choice. The
   §1 extras caps are enforced at both app layers but carry no dedicated
   suite pin yet (fixture recipe if one is added: 61/41 dates via the
   action ⇒ the exact §1 error strings; 61/41 valid dates through raw
   `sanitizeSettings` ⇒ trimmed to exactly 60/40, invalid entries dropped
   before counting). Post-fix totals: 24 suites / 6,249 checks, green.

## 10. Docs + deploy (landed in this wave)

- UPDATE.md §2: `GeoStateDb` added to the additions list (db push). §5 v10
  note (top): both-halves deploy, the one-time Download & build step +
  monthly refresh, module enable/configure, DB-IP attribution, scopes
  unchanged, honest accuracy caveats, validate-count note.
- INSTALL.md §5: geo-build step (only if using the US module). §8: the
  `{"s":null}` probe answer is healthy fail-open, not breakage.
- docs/liquid-notes.md: the v10 note (the `"us"` island member, the
  deliver_to string, the selector, the client-side state-resolution split).
- SPEC.md: the app-proxy line mentions `geo`; the string-catalog section
  carries the dated `delivery.deliver_to` note.
- ZIP: `cellexia-aov-ltv-booster-UPDATE-2026-08-08-v6.zip` (recipe:
  exclusions incl. node_modules, build/, prisma/dev.sqlite,
  prisma/.generated-client.json, shopify.app.toml, validation/.generated/,
  .DS_Store; verify by sorted name-list diff vs -v5).

## 11. Explicit non-goals (v10)

- No new FeatureKey, no preview draft-state ("preview as California") — the
  module is a LIVE setting like az placement (v6.5 precedent).
- No per-carrier holiday flags (merchant extra dates cover divergence).
- No US territories in the selector; no ZIP-level granularity.
- No storefront geo on non-US pages, non-US countries, or checkout.
- No new analytics beacons.
