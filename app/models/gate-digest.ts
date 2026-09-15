/**
 * v22 URL parameter gates — the digest lane (docs/SPEC-v22-param-gates.md).
 *
 * A gate's parameter name and token NEVER reach the storefront in clear: the
 * metafield mirror carries only these digests, and the extension hashes each
 * `name=value` pair it finds in the query string to look for a match. Keeping
 * the pair out of page source is the whole point, so nothing in this file may
 * ever be emitted next to its input.
 *
 * Dual-lane FNV-1a 32 (two offset bases) rendered as 16 lowercase hex chars,
 * i.e. 64 bits. Deliberately NOT crypto.subtle: the storefront capture has to
 * run synchronously before first paint, and subtle.digest is async. This is a
 * non-cryptographic hash — it makes the parameter undiscoverable by reading
 * page source, it is not a security boundary.
 *
 * PURE module: no *.server import, no Node built-in. The admin route bundle,
 * the app-proxy route and the validation harness all import it, and the
 * extension JS carries a byte-twin of `gateDigest` pinned by
 * validation/sims/param-gates.cjs.
 */

/** The literal a gate's parameter takes to CLEAR that gate (QA escape hatch). */
export const GATE_OFF_VALUE = "off";

function fnv1a(input: string, basis: number): number {
  let hash = basis >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash ^ input.charCodeAt(i)) >>> 0;
    // hash * 16777619 without Math.imul, so the ES5 extension twin can be
    // character-identical: the shift sum is the 0x01000193 decomposition.
    hash =
      (hash +
        ((hash << 1) >>> 0) +
        ((hash << 4) >>> 0) +
        ((hash << 7) >>> 0) +
        ((hash << 8) >>> 0) +
        ((hash << 24) >>> 0)) >>>
      0;
  }
  return hash >>> 0;
}

function hex8(value: number): string {
  return `0000000${(value >>> 0).toString(16)}`.slice(-8);
}

/** 16 lowercase hex chars for any input string. */
export function gateDigest(input: string): string {
  const text = String(input);
  return hex8(fnv1a(text, 0x811c9dc5)) + hex8(fnv1a(text, 0x811c9dcd));
}

/** The digest the extension looks for to OPEN a gate. */
export function gateOnDigest(param: string, token: string): string {
  return gateDigest(`${param}=${token}`);
}

/** The digest the extension looks for to CLEAR a gate. */
export function gateOffDigest(param: string): string {
  return gateDigest(`${param}=${GATE_OFF_VALUE}`);
}

/** The 32-hex pair the metafield mirror carries for one enabled gate. */
export function gateDigestPair(param: string, token: string): string {
  return gateOnDigest(param, token) + gateOffDigest(param);
}
