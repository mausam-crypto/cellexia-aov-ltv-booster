// v32 volume pricing — ALL decision logic of the "Cellexia volume pricing"
// Discount Function as pure functions over plain objects
// (docs/SPEC-v32-volume-pricing.md).
//
// Why pure + separate: the validation harness runs these in plain Node
// (validation/sims/volume-function.mjs) without a wasm build; the run
// module is a thin wrapper that never carries logic of its own.
//
// House rules for a Function (the cellexia-rewards precedent):
// deterministic (no Date, no Math.random, no I/O), no throws on odd input
// (skip the line / return no operations instead), numeric ids compared as
// strings after stripping the GID prefix. Money here is INTEGER MINOR
// UNITS throughout (cents, yen, fils — `m` minor-per-unit from the
// config), because the whole point of this function is cents-exact parity
// with the storefront widget's `round(n × p3 / K)` formula: percentages
// and float decimals are exactly the drift this design exists to avoid.
//
// The config is the shop metafield $app:cellexia/volume written by
// app/services/volume-pricing.server.ts:
//   { v: 1, on: bool,
//     p: { "<numeric productId>": { k, v1: "<numeric variantId>",
//          cc: { "<ISO2>": { c: "USD", m: 100, p1: 8600, p3: 20500 } } } },
//     _s: { h, t, d } }              // server state, ignored here
//
// Every anchor fails CLOSED: a line that misses any check keeps its full
// price (SPEC §2.2). The p1 equality check is the staleness tripwire — a
// price changed after the last sync yields NO discount, never a wrong one.

/** Selection strategy / class string literals (no generated types needed). */
export const CLASS_PRODUCT = "PRODUCT";
export const STRATEGY_ALL = "ALL";

/** The largest share of a line the function will ever discount (sanity clamp). */
export const MAX_OFF_SHARE = 0.6;

/**
 * Shopper-facing message, per storefront language (native wording, the
 * house no-em-dash rule; the same 18 locales as the theme). Checkout and
 * the cart render it next to the reduced line.
 */
export const VOLUME_MSG = {
  en: "Volume discount",
  fr: "Remise sur quantité",
  de: "Mengenrabatt",
  es: "Descuento por cantidad",
  it: "Sconto quantità",
  nl: "Volumekorting",
  pt: "Desconto de quantidade",
  da: "Mængderabat",
  sv: "Mängdrabatt",
  nb: "Mengderabatt",
  no: "Mengderabatt",
  fi: "Määräalennus",
  pl: "Rabat ilościowy",
  ro: "Reducere de volum",
  hu: "Mennyiségi kedvezmény",
  el: "Έκπτωση ποσότητας",
  ja: "まとめ買い割引",
  ar: "خصم الكمية",
};

/** "gid://shopify/ProductVariant/123" -> "123"; numeric/falsy passes through as a string. */
export function numId(gid) {
  if (gid == null) return "";
  const s = String(gid);
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

/** Decimal amount string -> integer minor units under `m` (100 | 1 | 1000). NaN/negative -> -1. */
export function minorUnits(amount, m) {
  const n = Number(amount);
  if (!isFinite(n) || n < 0) return -1;
  const mm = m === 1 || m === 1000 ? m : 100;
  return Math.round(n * mm);
}

/**
 * The ONE rounding rule, shared verbatim with the storefront widget
 * (cellexia-pdp.js qsyncSplit vd arm): the discounted line total for n
 * units is round-half-up(n × p3 / k) in minor units.
 */
export function volumeTargetMinor(qty, p3, k) {
  return Math.round((qty * p3) / k);
}

/** Minor units -> the decimal string Shopify expects for that currency. */
export function fmtAmount(minor, m) {
  const mm = m === 1 || m === 1000 ? m : 100;
  const digits = mm === 1 ? 0 : mm === 1000 ? 3 : 2;
  return (minor / mm).toFixed(digits);
}

/** Message for the buyer's language iso code ("EN", "pt-PT", ...): exact -> base -> en. */
export function volumeMessage(langIso) {
  const raw = typeof langIso === "string" ? langIso.toLowerCase() : "";
  if (VOLUME_MSG[raw]) return VOLUME_MSG[raw];
  const base = raw.split("-")[0];
  if (VOLUME_MSG[base]) return VOLUME_MSG[base];
  return VOLUME_MSG.en;
}

/** The config member, or null when absent/malformed/not armed. */
export function volumeConfig(input) {
  const cfg = input?.shop?.metafield?.jsonValue;
  if (!cfg || typeof cfg !== "object") return null;
  if (cfg.on !== true) return null;
  if (!cfg.p || typeof cfg.p !== "object") return null;
  return cfg;
}

/**
 * The per-line verdict (exported so the sim can pin every anchor alone).
 * Returns { off, m, message-less } minor-unit amount to take off the line,
 * or null when the line keeps its price.
 */
export function volumeLineOff(line, cfg, countryIso) {
  if (!line || typeof line !== "object") return null;
  const merch = line.merchandise;
  if (!merch || merch.__typename !== "ProductVariant") return null;
  const entry = cfg.p[numId(merch.product?.id)];
  if (!entry || typeof entry !== "object") return null;
  if (numId(merch.id) !== String(entry.v1)) return null;
  // One-time only: plan allocations price single tiers (SPEC v31 §1.7);
  // the widget clamps at K in sub mode and the function never contradicts it.
  if (line.sellingPlanAllocation) return null;
  // Never touch a line the gift machinery owns.
  if (line.attribute && line.attribute.value != null && line.attribute.value !== "") return null;
  const k = entry.k;
  if (!(typeof k === "number" && k >= 2 && k <= 6)) return null;
  const qty = line.quantity;
  if (!(typeof qty === "number" && isFinite(qty) && qty >= k + 1)) return null;
  const ce = entry.cc && typeof entry.cc === "object" ? entry.cc[countryIso] : null;
  if (!ce || typeof ce !== "object") return null;
  const sub = line.cost?.subtotalAmount;
  if (!sub || sub.currencyCode !== ce.c) return null;
  const m = ce.m === 1 || ce.m === 1000 ? ce.m : 100;
  const p1 = ce.p1;
  const p3 = ce.p3;
  if (!(typeof p1 === "number" && p1 > 0 && typeof p3 === "number" && p3 > 0)) return null;
  const subMinor = minorUnits(sub.amount, m);
  // THE STALENESS TRIPWIRE: the pre-discount subtotal must be exactly
  // qty × the mirrored 1-unit price. A changed price = no discount,
  // never a wrong one; the next sync re-arms it.
  if (subMinor !== qty * p1) return null;
  const target = volumeTargetMinor(qty, p3, k);
  const off = subMinor - target;
  if (!(off > 0)) return null;
  if (off > subMinor * MAX_OFF_SHARE) return null;
  return { off, m };
}

/**
 * The operations for cart.lines.discounts.generate.run: one
 * productDiscountsAdd (strategy ALL) holding one fixedAmount candidate per
 * qualifying line, or [] when nothing qualifies.
 */
export function volumeOperations(input) {
  const classes = input?.discount?.discountClasses;
  if (!Array.isArray(classes) || classes.indexOf(CLASS_PRODUCT) === -1) return [];
  const cfg = volumeConfig(input);
  if (!cfg) return [];
  const lines = input?.cart?.lines;
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const country = input?.localization?.country?.isoCode;
  if (typeof country !== "string" || !country) return [];
  const message = volumeMessage(input?.localization?.language?.isoCode);
  const candidates = [];
  for (const line of lines) {
    const verdict = volumeLineOff(line, cfg, country);
    if (!verdict || !line.id) continue;
    candidates.push({
      message,
      targets: [{ cartLine: { id: line.id } }],
      value: {
        fixedAmount: {
          amount: fmtAmount(verdict.off, verdict.m),
          appliesToEachItem: false,
        },
      },
    });
  }
  if (!candidates.length) return [];
  return [
    {
      productDiscountsAdd: {
        selectionStrategy: STRATEGY_ALL,
        candidates,
      },
    },
  ];
}
