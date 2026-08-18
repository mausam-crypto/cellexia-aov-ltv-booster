import type { PrismaClient } from "@prisma/client";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import type { Session } from "@shopify/shopify-api";

/**
 * v15.4 — DB-outage-tolerant session storage.
 *
 * Why: the stock PrismaSessionStorage probes the Session table in its
 * CONSTRUCTOR (i.e. while the server module loads): `connectionRetries` × 5 s,
 * then it stores a REJECTED promise in `this.ready`. Two consequences when the
 * database is unreachable for even a short moment at boot:
 *   1. the rejected promise has no handler → Node ≥ 15 treats it as an
 *      unhandled rejection and EXITS the process → the container dies and the
 *      platform restarts it into the same window → full outage;
 *   2. even when the process survives, `ensureReady()` awaits that rejected
 *      promise for the lifetime of the process → every session read/write
 *      keeps failing after the database is back, until someone restarts.
 *
 * This subclass keeps the upstream behaviour for the happy path and adds:
 *   - the initial probe never becomes an unhandled rejection (handlers are
 *     attached immediately; a failed probe just marks the storage unhealthy);
 *   - every session operation first re-checks readiness when the storage is
 *     unhealthy (`isReady()` re-polls once and RESETS `ready` upstream), so
 *     the storage heals itself on the first request after the database
 *     returns — no restart needed;
 *   - a connection-class error thrown by an operation flips the storage back
 *     to unhealthy so the next call re-probes instead of trusting a stale
 *     "ready".
 * A request served while the database is down still fails (500 from the
 * route) — that is correct: only the PROCESS must survive.
 */
export class ResilientPrismaSessionStorage extends PrismaSessionStorage<PrismaClient> {
  private healthy = false;
  private probing: Promise<boolean> | null = null;

  constructor(prisma: PrismaClient) {
    // One quick upstream probe (no 5 s sleeps at boot); we own the retries.
    super(prisma, { connectionRetries: 1, connectionRetryIntervalMs: 0 });
    const initial = (this as unknown as { ready?: Promise<boolean> }).ready;
    if (initial && typeof initial.then === "function") {
      initial.then(
        (ok) => {
          this.healthy = ok === true;
        },
        (error: unknown) => {
          this.healthy = false;
          console.error(
            "[session-storage] database not reachable at boot — the server keeps running and will heal on the first request after the database is back:",
            error instanceof Error ? error.message : error,
          );
        },
      );
    }
  }

  /** Re-probe once (shared while in flight) — never throws. */
  private async reprobe(): Promise<boolean> {
    if (!this.probing) {
      this.probing = this.isReady()
        .then((ok) => {
          this.healthy = ok;
          if (ok) console.log("[session-storage] database reachable again — session storage healed");
          return ok;
        })
        .catch(() => {
          this.healthy = false;
          return false;
        })
        .finally(() => {
          this.probing = null;
        });
    }
    return this.probing;
  }

  private async guarded<T>(op: () => Promise<T>): Promise<T> {
    if (!this.healthy) await this.reprobe();
    try {
      return await op();
    } catch (error) {
      if (looksLikeConnectionError(error)) this.healthy = false;
      throw error;
    }
  }

  override storeSession(session: Session): Promise<boolean> {
    return this.guarded(() => super.storeSession(session));
  }

  override loadSession(id: string): Promise<Session | undefined> {
    return this.guarded(() => super.loadSession(id));
  }

  override deleteSession(id: string): Promise<boolean> {
    return this.guarded(() => super.deleteSession(id));
  }

  override deleteSessions(ids: string[]): Promise<boolean> {
    return this.guarded(() => super.deleteSessions(ids));
  }

  override findSessionsByShop(shop: string): Promise<Session[]> {
    return this.guarded(() => super.findSessionsByShop(shop));
  }
}

/** Prisma connection / availability errors (P1000-P1017 initialisation
 *  errors, "not ready" storage errors, ECONNREFUSED-style transport errors). */
export function looksLikeConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^P10\d\d$/.test(code)) return true;
  const name = (error as { name?: unknown }).name;
  if (name === "PrismaClientInitializationError" || name === "MissingSessionStorageError") return true;
  const message = String((error as { message?: unknown }).message ?? "");
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Can't reach database|connection (refused|reset|terminated)|the database system is (starting up|shutting down|in recovery)|too many connections|not ready/i.test(
    message,
  );
}
