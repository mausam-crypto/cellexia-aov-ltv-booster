/**
 * v10 US state module — self-hosted IP→US-state geolocation
 * (docs/SPEC-v10-us-state-delivery.md §6).
 *
 * PRIVACY DESIGN (SPEC doctrine #3, binding): the storefront asks OUR app
 * proxy which US state a visitor is in, and the answer comes entirely from a
 * range table compiled into our own database. The visitor's IP is parsed,
 * binary-searched in memory and discarded — it is NEVER stored, NEVER
 * logged (nothing in this module writes an IP anywhere, console included)
 * and NEVER sent to a third party. The only data that persists is SOURCE
 * data: the DB-IP range table itself.
 *
 * DATA SOURCE: DB-IP City Lite, a free keyless monthly CSV
 * (https://download.db-ip.com/free/dbip-city-lite-YYYY-MM.csv.gz), licensed
 * CC BY 4.0 — attribution required wherever a geolocation result is shown
 * (GEO_ATTRIBUTION here; the storefront selector renders the
 * "IP Geolocation by DB-IP" link whenever a detected state is in use). A new
 * file appears at the start of each month; the merchant re-runs the build
 * from the Delivery page monthly.
 *
 * MEMORY DISCIPLINE: the source is ~84 MB gzipped / ~674 MB text / ~7.9M
 * rows and is NEVER buffered — fetch body → gunzip → readline, keeping only
 * the packed US ranges (fixed 9-/33-byte records, buffers grown in 1 MB
 * steps, never proportional to the source).
 *
 * BLOB FORMAT (GeoStateDb.dataV4/dataV6, gzipped): concatenated fixed-size
 * records sorted by range start — v4: start u32 BE, end u32 BE, stateIdx u8
 * (9 B); v6: start 16 B BE, end 16 B BE, stateIdx u8 (33 B). stateIdx
 * indexes US_STATE_CODES, which is therefore part of the stored format.
 *
 * FAILURE DOCTRINE: the state layer fails OPEN (SPEC doctrine #1) — every
 * error path here resolves to null or keeps the last good table, and the
 * storefront keeps the US-wide promise. Dates stay fail-closed elsewhere;
 * nothing in this module produces a date.
 */

import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createGunzip, gunzipSync, gzipSync } from "node:zlib";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import prisma from "../db.server";

/** CC BY 4.0 attribution for every surface that shows a geolocation result. */
export const GEO_ATTRIBUTION =
  "IP Geolocation by DB-IP (db-ip.com), CC BY 4.0";

const DBIP_URL_BASE = "https://download.db-ip.com/free/";

/** Whole-build budget (fetch + stream + pack). Past it the build aborts and
 *  reports a timeout instead of holding the in-progress slot forever. */
const GEO_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Packed-range buffers grow by this step (never source-proportional). */
const PACK_GROW_STEP = 1024 * 1024;

/**
 * Canonical state-code order — 50 states + DC, sorted. stateIdx bytes in the
 * stored blobs index THIS array: it is part of the on-disk format. Never
 * reorder or re-key it in v10 (a change would need a format-version marker
 * in GeoStateDb.source plus a rebuild). Territories (PR, GU, VI, AS, MP)
 * are deliberately absent — not states in v10, dropped by the importer.
 */
export const US_STATE_CODES: readonly string[] = [
  "AK", "AL", "AR", "AZ", "CA", "CO", "CT", "DC", "DE", "FL",
  "GA", "HI", "IA", "ID", "IL", "IN", "KS", "KY", "LA", "MA",
  "MD", "ME", "MI", "MN", "MO", "MS", "MT", "NC", "ND", "NE",
  "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV",
  "WY",
];

/**
 * Importer-only inverse of the storefront US_STATE_NAMES twins (SPEC §2):
 * DB-IP's stateprov column carries the English NAME ("California"), never a
 * code. The trailing keys are common feed variants for the district. The
 * country === "US" row filter runs first, so "Georgia" can only mean the
 * state. Names absent here (territories, foreign spellings) are skipped and
 * counted — never guessed.
 */
export const US_STATE_NAME_TO_CODE: Record<string, string> = {
  Alabama: "AL",
  Alaska: "AK",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  "District of Columbia": "DC",
  Florida: "FL",
  Georgia: "GA",
  Hawaii: "HI",
  Idaho: "ID",
  Illinois: "IL",
  Indiana: "IN",
  Iowa: "IA",
  Kansas: "KS",
  Kentucky: "KY",
  Louisiana: "LA",
  Maine: "ME",
  Maryland: "MD",
  Massachusetts: "MA",
  Michigan: "MI",
  Minnesota: "MN",
  Mississippi: "MS",
  Missouri: "MO",
  Montana: "MT",
  Nebraska: "NE",
  Nevada: "NV",
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY",
  "Washington, D.C.": "DC",
  "Washington D.C.": "DC",
  "Washington DC": "DC",
};

/** name → US_STATE_CODES index, resolved once (Map: no prototype keys). */
const stateIdxByName = new Map<string, number>();
for (const [name, code] of Object.entries(US_STATE_NAME_TO_CODE)) {
  const idx = US_STATE_CODES.indexOf(code);
  if (idx !== -1) stateIdxByName.set(name, idx);
}

// ---------------------------------------------------------------------------
// IP text → fixed-width big-endian bytes (pure, no logging)
// ---------------------------------------------------------------------------

interface ParsedIp {
  family: 4 | 6;
  bytes: Buffer;
}

function parseIpv4(text: string): Buffer | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  const bytes = Buffer.alloc(4);
  for (let i = 0; i < 4; i += 1) {
    const octet = Number(match[i + 1]);
    if (octet > 255) return null;
    bytes[i] = octet;
  }
  return bytes;
}

const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/;

function parseIpv6(text: string): Buffer | null {
  let head = text;
  // Embedded dotted-quad tail ("::ffff:1.2.3.4"): parse it separately and
  // stand in two zero groups so the hex-group math below stays uniform.
  let v4Tail: Buffer | null = null;
  const lastColon = head.lastIndexOf(":");
  if (lastColon !== -1 && head.indexOf(".", lastColon) !== -1) {
    v4Tail = parseIpv4(head.slice(lastColon + 1));
    if (!v4Tail) return null;
    head = `${head.slice(0, lastColon + 1)}0:0`;
  }
  const parts = head.split("::");
  if (parts.length > 2) return null;
  const groupsOf = (side: string): string[] =>
    side === "" ? [] : side.split(":");
  const left = groupsOf(parts[0]);
  const right = parts.length === 2 ? groupsOf(parts[1]) : [];
  const total = left.length + right.length;
  if (parts.length === 2 ? total > 7 : total !== 8) return null;
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < left.length; i += 1) {
    if (!HEX_GROUP.test(left[i])) return null;
    bytes.writeUInt16BE(parseInt(left[i], 16), i * 2);
  }
  for (let i = 0; i < right.length; i += 1) {
    if (!HEX_GROUP.test(right[i])) return null;
    bytes.writeUInt16BE(parseInt(right[i], 16), (8 - right.length + i) * 2);
  }
  if (v4Tail) v4Tail.copy(bytes, 12);
  return bytes;
}

function isV4Mapped(bytes: Buffer): boolean {
  for (let i = 0; i < 10; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * Dotted v4 or RFC-4291 v6 text → family + big-endian bytes; anything
 * malformed → null. v4-mapped v6 (::ffff:a.b.c.d — what dual-stack hosts
 * report for v4 clients) normalizes to family 4 so those visitors hit the
 * v4 table.
 */
function parseIp(text: string): ParsedIp | null {
  const value = text.trim();
  if (value === "" || value.length > 45) return null;
  if (value.includes(":")) {
    const bytes = parseIpv6(value);
    if (!bytes) return null;
    if (isV4Mapped(bytes)) return { family: 4, bytes: bytes.subarray(12) };
    return { family: 6, bytes };
  }
  const bytes = parseIpv4(value);
  return bytes ? { family: 4, bytes } : null;
}

// ---------------------------------------------------------------------------
// Fixed-size-record packing with adjacent-range merge
// ---------------------------------------------------------------------------

function cmpBytes(
  a: Uint8Array,
  aOff: number,
  b: Uint8Array,
  bOff: number,
  len: number,
): number {
  for (let i = 0; i < len; i += 1) {
    const diff = a[aOff + i] - b[bOff + i];
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** start === prevEnd + 1, computed without allocating: the successor of
 *  prevEnd increments its lowest non-0xff byte and zeroes everything below. */
function isAdjacent(
  prevEnd: Uint8Array,
  prevOff: number,
  start: Uint8Array,
  startOff: number,
  len: number,
): boolean {
  let pivot = len - 1;
  while (pivot >= 0 && prevEnd[prevOff + pivot] === 0xff) pivot -= 1;
  if (pivot < 0) return false; // all-0xff has no successor
  for (let i = 0; i < pivot; i += 1) {
    if (start[startOff + i] !== prevEnd[prevOff + i]) return false;
  }
  if (start[startOff + pivot] !== prevEnd[prevOff + pivot] + 1) return false;
  for (let i = pivot + 1; i < len; i += 1) {
    if (start[startOff + i] !== 0x00) return false;
  }
  return true;
}

interface RangePacker {
  addrLen: number;
  recSize: number;
  buf: Buffer;
  len: number;
  count: number;
  outOfOrder: number;
}

function packerCreate(addrLen: number): RangePacker {
  return {
    addrLen,
    recSize: addrLen * 2 + 1,
    buf: Buffer.alloc(0),
    len: 0,
    count: 0,
    outOfOrder: 0,
  };
}

/**
 * Appends a range, merging into the previous record when it is the same
 * state and exactly adjacent — the source is sorted, so this inline merge
 * is the whole compaction story. Sortedness is still verified per row:
 * violations are only counted here (an inline merge that DID fire is a
 * correct union regardless of global order) and packerFinish re-sorts and
 * re-merges the packed table when any were seen — the simple robust path.
 */
function packerAppend(
  p: RangePacker,
  start: Buffer,
  end: Buffer,
  stateIdx: number,
): void {
  const { addrLen, recSize } = p;
  if (p.count > 0) {
    const prevOff = p.len - recSize;
    const prevEndOff = prevOff + addrLen;
    if (cmpBytes(start, 0, p.buf, prevEndOff, addrLen) <= 0) {
      p.outOfOrder += 1;
    } else if (
      p.buf[prevOff + addrLen * 2] === stateIdx &&
      isAdjacent(p.buf, prevEndOff, start, 0, addrLen)
    ) {
      end.copy(p.buf, prevEndOff);
      return;
    }
  }
  if (p.len + recSize > p.buf.length) {
    const grown = Buffer.alloc(p.buf.length + PACK_GROW_STEP);
    p.buf.copy(grown, 0, 0, p.len);
    p.buf = grown;
  }
  start.copy(p.buf, p.len);
  end.copy(p.buf, p.len + addrLen);
  p.buf[p.len + addrLen * 2] = stateIdx;
  p.len += recSize;
  p.count += 1;
}

/**
 * Fallback only (sortedness violations seen while packing): sort the packed
 * records by range start and re-merge. Costs one extra copy of the PACKED
 * table — never of the source file. Same-state overlapping/adjacent ranges
 * union; a cross-state overlap (a source anomaly) is kept as-is and the
 * earlier range wins at lookup time.
 */
function repackSorted(p: RangePacker): void {
  const { addrLen, recSize } = p;
  const packed = p.buf.subarray(0, p.len);
  const order: number[] = new Array(p.count);
  for (let i = 0; i < p.count; i += 1) order[i] = i;
  order.sort((a, b) =>
    cmpBytes(packed, a * recSize, packed, b * recSize, addrLen),
  );
  const out = Buffer.alloc(p.len);
  let len = 0;
  let count = 0;
  for (const rec of order) {
    const off = rec * recSize;
    if (count > 0) {
      const prevOff = len - recSize;
      const prevEndOff = prevOff + addrLen;
      const sameState =
        out[prevOff + addrLen * 2] === packed[off + addrLen * 2];
      const touches =
        cmpBytes(packed, off, out, prevEndOff, addrLen) <= 0 ||
        isAdjacent(out, prevEndOff, packed, off, addrLen);
      if (sameState && touches) {
        if (cmpBytes(packed, off + addrLen, out, prevEndOff, addrLen) > 0) {
          packed.copy(out, prevEndOff, off + addrLen, off + addrLen * 2);
        }
        continue;
      }
    }
    packed.copy(out, len, off, off + recSize);
    len += recSize;
    count += 1;
  }
  p.buf = out;
  p.len = len;
  p.count = count;
  p.outOfOrder = 0;
}

interface PackedTable {
  gz: Uint8Array<ArrayBuffer>;
  count: number;
}

function packerFinish(p: RangePacker): PackedTable {
  if (p.outOfOrder > 0) repackSorted(p);
  // Re-based onto a plain ArrayBuffer: Prisma's Bytes input rejects Node
  // Buffers (ArrayBufferLike-backed) under TS 5.7 typed-array generics.
  const gz = new Uint8Array(gzipSync(p.buf.subarray(0, p.len)));
  return { gz, count: p.count };
}

// ---------------------------------------------------------------------------
// Build pipeline (fire-and-forget from the admin action)
// ---------------------------------------------------------------------------

interface GeoBuildProgress {
  startedAt: number;
  rowsScanned: number;
  usRowsKept: number;
  unknownNames: number;
}

/**
 * One build per shop at a time; presence = "building" for getGeoStatus.
 * In-memory ONLY: a process restart empties it, so a persisted "building"
 * row with no entry here can never finish — getGeoStatus reports that
 * combination as an interrupted-build error and heals the row.
 */
const geoBuildsInProgress = new Map<string, GeoBuildProgress>();

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/** "YYYY-MM" tags to try: current UTC month, then the previous one — the
 *  monthly file appears at the start of each month and can lag a few days. */
function dbipMonthTags(now: Date): string[] {
  const tags: string[] = [];
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  for (let i = 0; i < 2; i += 1) {
    tags.push(`${year}-${String(month + 1).padStart(2, "0")}`);
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return tags;
}

async function openDownload(
  signal: AbortSignal,
): Promise<{ tag: string; body: Readable }> {
  let lastFailure = "network error";
  for (const tag of dbipMonthTags(new Date())) {
    const url = `${DBIP_URL_BASE}dbip-city-lite-${tag}.csv.gz`;
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch (error) {
      if (signal.aborted) throw error;
      lastFailure = "network error";
      continue;
    }
    if (res.ok && res.body) {
      return {
        tag,
        body: Readable.fromWeb(
          res.body as unknown as WebReadableStream<Uint8Array>,
        ),
      };
    }
    lastFailure = `HTTP ${res.status}`;
    try {
      await res.body?.cancel();
    } catch {
      // response already gone — nothing to release
    }
  }
  throw new Error(`source download failed (${lastFailure})`);
}

/**
 * First `count` fields of an RFC-4180 line. The source quotes only fields
 * containing commas or quotes (city names — `"Mountain View"`); no field
 * spans lines. Returns null when the line is malformed or too short.
 */
function csvFields(line: string, count: number): string[] | null {
  const fields: string[] = [];
  let i = 0;
  for (;;) {
    let value = "";
    if (line[i] === '"') {
      i += 1;
      for (;;) {
        const quote = line.indexOf('"', i);
        if (quote === -1) return null; // unterminated quote
        if (line[quote + 1] === '"') {
          value += line.slice(i, quote + 1);
          i = quote + 2;
        } else {
          value += line.slice(i, quote);
          i = quote + 1;
          break;
        }
      }
    } else {
      const comma = line.indexOf(",", i);
      value = comma === -1 ? line.slice(i) : line.slice(i, comma);
      i = comma === -1 ? line.length : comma;
    }
    fields.push(value);
    if (fields.length === count) return fields;
    if (i >= line.length || line[i] !== ",") return null;
    i += 1;
  }
}

async function downloadAndPack(progress: GeoBuildProgress): Promise<{
  tag: string;
  v4: PackedTable;
  v6: PackedTable;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_DOWNLOAD_TIMEOUT_MS);
  let body: Readable | null = null;
  let lines: ReturnType<typeof createInterface> | null = null;
  try {
    const download = await openDownload(controller.signal);
    body = download.body;
    const gunzip = createGunzip();
    body.pipe(gunzip);
    lines = createInterface({ input: gunzip, crlfDelay: Infinity });
    const v4 = packerCreate(4);
    const v6 = packerCreate(16);
    const rl = lines;
    const source = body;
    // Stream errors (network cut, truncated gzip) do not surface through
    // the readline iterator on their own — race them in explicitly; the
    // finally below closes the pipeline so the iterator can settle.
    const failed = new Promise<never>((_, reject) => {
      source.once("error", reject);
      gunzip.once("error", reject);
    });
    const consume = async (): Promise<void> => {
      // Columns: ip_start, ip_end, continent, country, stateprov, city, …
      // — only the first five matter, so parsing stops there per line.
      for await (const line of rl) {
        progress.rowsScanned += 1;
        if (line === "") continue;
        const fields = csvFields(line, 5);
        if (!fields || fields[3] !== "US") continue;
        const stateIdx = stateIdxByName.get(fields[4]);
        if (stateIdx === undefined) {
          progress.unknownNames += 1; // territories + unmapped names
          continue;
        }
        const start = parseIp(fields[0]);
        const end = parseIp(fields[1]);
        if (!start || !end || start.family !== end.family) continue;
        const packer = start.family === 4 ? v4 : v6;
        if (cmpBytes(start.bytes, 0, end.bytes, 0, packer.addrLen) > 0) {
          continue; // inverted range — source anomaly, skip
        }
        packerAppend(packer, start.bytes, end.bytes, stateIdx);
        progress.usRowsKept += 1;
      }
    };
    await Promise.race([consume(), failed]);
    if (progress.usRowsKept === 0) {
      throw new Error(
        `no usable US rows in the source (${progress.unknownNames} US rows ` +
          "with unmapped region names) — existing table kept",
      );
    }
    return { tag: download.tag, v4: packerFinish(v4), v6: packerFinish(v6) };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("download timed out (10 minutes)");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    lines?.close();
    body?.destroy();
  }
}

/**
 * Downloads + compiles the state table for a shop. Fire-and-forget from the
 * admin action (`void buildGeoStateDb(shop)`): it NEVER rejects, updates the
 * GeoStateDb status row `building` → `ready`/`error`, and getGeoStatus
 * merges the live in-progress numbers for the admin card's polling.
 *
 * Single-flight is the in-memory map ONLY — the persisted status is
 * deliberately NOT a start gate. A restart mid-build empties the map and
 * orphans the row on "building"; the next click here must start a fresh
 * build (getGeoStatus demotes such rows to "error" so the admin card offers
 * that click). A previous good table (blobs + builtAt) keeps serving
 * throughout — only success replaces it.
 */
export async function buildGeoStateDb(shop: string): Promise<void> {
  if (geoBuildsInProgress.has(shop)) return;
  const progress: GeoBuildProgress = {
    startedAt: Date.now(),
    rowsScanned: 0,
    usRowsKept: 0,
    unknownNames: 0,
  };
  geoBuildsInProgress.set(shop, progress);
  try {
    await prisma.geoStateDb.upsert({
      where: { shop },
      update: { status: "building", error: "" },
      create: { shop, status: "building" },
    });
    const built = await downloadAndPack(progress);
    await prisma.geoStateDb.update({
      where: { shop },
      data: {
        status: "ready",
        source: `dbip-city-lite-${built.tag}`,
        error: "",
        rangesV4: built.v4.count,
        rangesV6: built.v6.count,
        dataV4: built.v4.gz,
        dataV6: built.v6.gz,
        builtAt: new Date(),
      },
    });
    geoIndexCache.delete(shop); // next lookup loads the fresh table
  } catch (error) {
    // Only status/error change here: any previous good table (blobs +
    // builtAt) keeps serving — a failed refresh must not unserve it.
    try {
      await prisma.geoStateDb.upsert({
        where: { shop },
        update: { status: "error", error: errorText(error) },
        create: { shop, status: "error", error: errorText(error) },
      });
    } catch {
      // DB unreachable — nothing to report to; callers fire-and-forget,
      // so never rethrow.
    }
  } finally {
    geoBuildsInProgress.delete(shop);
  }
}

// ---------------------------------------------------------------------------
// Lookup (in-memory index, getCachedHealth Map idiom)
// ---------------------------------------------------------------------------

export interface GeoIndex {
  /** builtAt epoch ms — a rebuild changes it, lazily refreshing the entry. */
  key: number;
  v4: Uint8Array;
  v4Count: number;
  v6: Uint8Array;
  v6Count: number;
}

const geoIndexCache = new Map<string, GeoIndex>();

function inflateTable(
  blob: Uint8Array | null,
  recSize: number,
): { data: Uint8Array; count: number } | null {
  if (!blob || blob.length === 0) return { data: new Uint8Array(0), count: 0 };
  try {
    const data = gunzipSync(blob);
    if (data.length % recSize !== 0) return null; // corrupt — fail open
    return { data, count: data.length / recSize };
  } catch {
    return null;
  }
}

/**
 * Decoded in-memory table for a shop, cached per shop+builtAt (module Map —
 * the single-merchant single-instance assumption of getCachedHealth). Serves
 * the LAST SUCCESSFUL build regardless of `status`: a failed monthly refresh
 * (status "error") must not unserve a working table. Null while no build has
 * succeeded or the stored blobs are unreadable.
 */
export async function getGeoIndex(shop: string): Promise<GeoIndex | null> {
  const row = await prisma.geoStateDb.findUnique({
    where: { shop },
    select: { builtAt: true },
  });
  if (!row?.builtAt) return null;
  const key = row.builtAt.getTime();
  const cached = geoIndexCache.get(shop);
  if (cached && cached.key === key) return cached;
  const blobs = await prisma.geoStateDb.findUnique({
    where: { shop },
    select: { dataV4: true, dataV6: true },
  });
  const v4 = inflateTable(blobs?.dataV4 ?? null, 9);
  const v6 = inflateTable(blobs?.dataV6 ?? null, 33);
  if (!v4 || !v6) return null;
  const index: GeoIndex = {
    key,
    v4: v4.data,
    v4Count: v4.count,
    v6: v6.data,
    v6Count: v6.count,
  };
  geoIndexCache.set(shop, index);
  return index;
}

function searchRange(
  data: Uint8Array,
  count: number,
  addr: Buffer,
  addrLen: number,
): number | null {
  const recSize = addrLen * 2 + 1;
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const off = mid * recSize;
    if (cmpBytes(addr, 0, data, off, addrLen) < 0) {
      hi = mid - 1;
    } else if (cmpBytes(addr, 0, data, off + addrLen, addrLen) > 0) {
      lo = mid + 1;
    } else {
      return data[off + addrLen * 2];
    }
  }
  return null;
}

/**
 * USPS state code for an IP, or null (malformed IP, no table, VPN/unknown
 * range, non-US range). The `ip` argument is parsed, searched and discarded
 * — never logged, never persisted (SPEC doctrine #3).
 */
export async function lookupUsState(
  shop: string,
  ip: string,
): Promise<string | null> {
  const parsed = parseIp(ip);
  if (!parsed) return null;
  const index = await getGeoIndex(shop);
  if (!index) return null;
  const stateIdx =
    parsed.family === 4
      ? searchRange(index.v4, index.v4Count, parsed.bytes, 4)
      : searchRange(index.v6, index.v6Count, parsed.bytes, 16);
  if (stateIdx === null) return null;
  return US_STATE_CODES[stateIdx] ?? null;
}

// ---------------------------------------------------------------------------
// Status (admin geo card, 3 s polling while building)
// ---------------------------------------------------------------------------

export interface GeoStatus {
  status: string; // empty | building | ready | error
  source: string;
  builtAt: Date | null;
  rangesV4: number;
  rangesV6: number;
  error: string;
  /** Live numbers while a build runs in this process, else null. */
  progress: { rowsScanned: number; usRowsKept: number } | null;
}

/** Reported — and lazily persisted — for a row stuck on "building" with no
 *  live build in this process: nothing can ever finish that row. */
const GEO_BUILD_INTERRUPTED = "build interrupted — run Download & build again";

/**
 * "building" is reported ONLY while this process holds a live build: a
 * persisted "building" row without one is an interrupted build (restart
 * mid-download) and reports as "error"/GEO_BUILD_INTERRUPTED, with a
 * fire-and-forget heal so the stored row converges too. The heal touches
 * status/error only — the serve-last-good gate (builtAt + readable blobs,
 * getGeoIndex) is never affected.
 */
export async function getGeoStatus(shop: string): Promise<GeoStatus> {
  const row = await prisma.geoStateDb.findUnique({
    where: { shop },
    select: {
      status: true,
      source: true,
      builtAt: true,
      rangesV4: true,
      rangesV6: true,
      error: true,
    },
  });
  const building = geoBuildsInProgress.get(shop);
  const interrupted = !building && row?.status === "building";
  if (interrupted) {
    void (async () => {
      if (geoBuildsInProgress.has(shop)) return; // a live build owns the row
      try {
        await prisma.geoStateDb.update({
          where: { shop },
          data: { status: "error", error: GEO_BUILD_INTERRUPTED },
        });
      } catch {
        // DB unreachable or row gone — the next status read retries.
      }
    })();
  }
  return {
    status: building
      ? "building"
      : interrupted
        ? "error"
        : (row?.status ?? "empty"),
    source: row?.source ?? "",
    builtAt: row?.builtAt ?? null,
    rangesV4: row?.rangesV4 ?? 0,
    rangesV6: row?.rangesV6 ?? 0,
    error: building
      ? ""
      : interrupted
        ? GEO_BUILD_INTERRUPTED
        : (row?.error ?? ""),
    progress: building
      ? { rowsScanned: building.rowsScanned, usRowsKept: building.usRowsKept }
      : null,
  };
}
