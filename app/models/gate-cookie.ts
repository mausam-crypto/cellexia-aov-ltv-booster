/**
 * v22 URL parameter gates — the stored-unlock wire format
 * (docs/SPEC-v22-param-gates.md §4).
 *
 * One value describes every gate a visitor has unlocked and when each one
 * lapses:
 *
 *   1.br-1797072000.bs-1797072000
 *   ^ format version   ^ gate id, expiry in epoch SECONDS
 *
 * Per-gate expiry (rather than one cookie-wide Max-Age) means a visitor who
 * arrives through a second tagged link on day 80 does not silently extend
 * the first gate, and it makes the whole thing testable against an injected
 * clock instead of the wall clock.
 *
 * PURE module: no *.server import, no Node built-in. The app-proxy route and
 * the validation harness import it, and the extension JS carries a twin
 * pinned by validation/sims/param-gates.cjs.
 */

/** First-party functional cookie. Two short ids and an expiry — no personal
 *  data, no cross-site identifier. */
export const GATE_COOKIE_NAME = "cx_ux";
/** localStorage mirror, written synchronously by the extension so an unlock
 *  survives a cookie the browser declines to keep. */
export const GATE_STORAGE_KEY = "cx:ux";
export const GATE_VALUE_VERSION = "1";
export const GATE_TTL_SECONDS = 90 * 24 * 60 * 60;

export type GateUnlocks = Record<string, number>;

/**
 * Parse a stored value, dropping anything expired or malformed. Unknown gate
 * ids are kept: this module does not own the registry, and dropping an id a
 * newer deploy understands would log a visitor out of a gate on downgrade.
 */
export function parseGateValue(raw: unknown, nowSeconds: number): GateUnlocks {
  const out: GateUnlocks = {};
  if (typeof raw !== "string" || raw === "") return out;
  const parts = raw.split(".");
  if (parts[0] !== GATE_VALUE_VERSION) return out;
  for (let i = 1; i < parts.length; i += 1) {
    const dash = parts[i].lastIndexOf("-");
    if (dash < 1) continue;
    const id = parts[i].slice(0, dash);
    const expiry = Number(parts[i].slice(dash + 1));
    if (!/^[a-z0-9]{1,8}$/.test(id)) continue;
    if (!Number.isFinite(expiry) || expiry <= nowSeconds) continue;
    if (expiry > out[id] || out[id] === undefined) out[id] = Math.floor(expiry);
  }
  return out;
}

/** Serialize, dropping anything expired. Ids are sorted so the value is
 *  stable and two writers converge on the same string. */
export function serializeGateValue(
  unlocks: GateUnlocks,
  nowSeconds: number,
): string {
  const parts = Object.keys(unlocks)
    .filter((id) => Number.isFinite(unlocks[id]) && unlocks[id] > nowSeconds)
    .sort()
    .map((id) => `${id}-${Math.floor(unlocks[id])}`);
  return parts.length > 0 ? [GATE_VALUE_VERSION, ...parts].join(".") : "";
}

/** The expiry stamp a fresh unlock gets. */
export function gateExpiry(nowSeconds: number): number {
  return Math.floor(nowSeconds) + GATE_TTL_SECONDS;
}

/** Read one cookie out of a raw Cookie header. */
export function readCookie(header: string | null, name: string): string {
  if (!header) return "";
  for (const chunk of header.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    if (chunk.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(chunk.slice(eq + 1).trim());
  }
  return "";
}
