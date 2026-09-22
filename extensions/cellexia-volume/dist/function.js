// node_modules/@shopify/shopify_function/run.ts
function run_default(userfunction) {
  try {
    ShopifyFunction;
  } catch (e) {
    throw new Error(
      "ShopifyFunction is not defined. Please rebuild your function using the latest version of Shopify CLI."
    );
  }
  const input_obj = ShopifyFunction.readInput();
  const output_obj = userfunction(input_obj);
  ShopifyFunction.writeOutput(output_obj);
}

// extensions/cellexia-volume/src/logic.js
var CLASS_PRODUCT = "PRODUCT";
var STRATEGY_ALL = "ALL";
var MAX_OFF_SHARE = 0.6;
var VOLUME_MSG = {
  en: "Volume discount",
  fr: "Remise sur quantit\xE9",
  de: "Mengenrabatt",
  es: "Descuento por cantidad",
  it: "Sconto quantit\xE0",
  nl: "Volumekorting",
  pt: "Desconto de quantidade",
  da: "M\xE6ngderabat",
  sv: "M\xE4ngdrabatt",
  nb: "Mengderabatt",
  no: "Mengderabatt",
  fi: "M\xE4\xE4r\xE4alennus",
  pl: "Rabat ilo\u015Bciowy",
  ro: "Reducere de volum",
  hu: "Mennyis\xE9gi kedvezm\xE9ny",
  el: "\u0388\u03BA\u03C0\u03C4\u03C9\u03C3\u03B7 \u03C0\u03BF\u03C3\u03CC\u03C4\u03B7\u03C4\u03B1\u03C2",
  ja: "\u307E\u3068\u3081\u8CB7\u3044\u5272\u5F15",
  ar: "\u062E\u0635\u0645 \u0627\u0644\u0643\u0645\u064A\u0629"
};
function numId(gid) {
  if (gid == null) return "";
  const s = String(gid);
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}
function minorUnits(amount, m) {
  const n = Number(amount);
  if (!isFinite(n) || n < 0) return -1;
  const mm = m === 1 || m === 1e3 ? m : 100;
  return Math.round(n * mm);
}
function volumeTargetMinor(qty, p3, k) {
  return Math.round(qty * p3 / k);
}
function fmtAmount(minor, m) {
  const mm = m === 1 || m === 1e3 ? m : 100;
  const digits = mm === 1 ? 0 : mm === 1e3 ? 3 : 2;
  return (minor / mm).toFixed(digits);
}
function volumeMessage(langIso) {
  const raw = typeof langIso === "string" ? langIso.toLowerCase() : "";
  if (VOLUME_MSG[raw]) return VOLUME_MSG[raw];
  const base = raw.split("-")[0];
  if (VOLUME_MSG[base]) return VOLUME_MSG[base];
  return VOLUME_MSG.en;
}
function volumeConfig(input) {
  const cfg = input?.shop?.metafield?.jsonValue;
  if (!cfg || typeof cfg !== "object") return null;
  if (cfg.on !== true) return null;
  if (!cfg.p || typeof cfg.p !== "object") return null;
  return cfg;
}
function volumeLineOff(line, cfg, countryIso) {
  if (!line || typeof line !== "object") return null;
  const merch = line.merchandise;
  if (!merch || merch.__typename !== "ProductVariant") return null;
  const entry = cfg.p[numId(merch.product?.id)];
  if (!entry || typeof entry !== "object") return null;
  if (numId(merch.id) !== String(entry.v1)) return null;
  if (line.sellingPlanAllocation) return null;
  if (line.attribute && line.attribute.value != null && line.attribute.value !== "") return null;
  const k = entry.k;
  if (!(typeof k === "number" && k >= 2 && k <= 6)) return null;
  const qty = line.quantity;
  if (!(typeof qty === "number" && isFinite(qty) && qty >= k + 1)) return null;
  const ce = entry.cc && typeof entry.cc === "object" ? entry.cc[countryIso] : null;
  if (!ce || typeof ce !== "object") return null;
  const sub = line.cost?.subtotalAmount;
  if (!sub || sub.currencyCode !== ce.c) return null;
  const m = ce.m === 1 || ce.m === 1e3 ? ce.m : 100;
  const p1 = ce.p1;
  const p3 = ce.p3;
  if (!(typeof p1 === "number" && p1 > 0 && typeof p3 === "number" && p3 > 0)) return null;
  const subMinor = minorUnits(sub.amount, m);
  if (subMinor !== qty * p1) return null;
  const target = volumeTargetMinor(qty, p3, k);
  const off = subMinor - target;
  if (!(off > 0)) return null;
  if (off > subMinor * MAX_OFF_SHARE) return null;
  return { off, m };
}
function volumeOperations(input) {
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
          appliesToEachItem: false
        }
      }
    });
  }
  if (!candidates.length) return [];
  return [
    {
      productDiscountsAdd: {
        selectionStrategy: STRATEGY_ALL,
        candidates
      }
    }
  ];
}

// extensions/cellexia-volume/src/cart_lines_discounts_generate_run.js
function cartLinesDiscountsGenerateRun(input) {
  try {
    return { operations: volumeOperations(input) };
  } catch {
    return { operations: [] };
  }
}

// <stdin>
function cartLinesDiscountsGenerateRun2() {
  return run_default(cartLinesDiscountsGenerateRun);
}
export {
  cartLinesDiscountsGenerateRun2 as cartLinesDiscountsGenerateRun
};
