import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

/**
 * Wrong-database boot guard (v8.5). The generated Prisma Client bakes in the
 * datasource provider + URL of the schema it was generated from; nothing at
 * runtime re-reads DATABASE_URL unless we pass it. A server generated from
 * the dev schema (sqlite, literal file:dev.sqlite) on a Postgres host would
 * therefore IGNORE DATABASE_URL and silently run against a throwaway local
 * SQLite file — reproduced end-to-end in the v8.5 deploy audit, with every
 * health check green. Defense in depth:
 *
 *   1. scripts/prisma-env.mjs (the only generate path in the npm scripts)
 *      picks the schema from DATABASE_URL and records the provider in
 *      prisma/.generated-client.json — read here, mismatch = refuse to boot
 *      with the exact fix in the message.
 *   2. When DATABASE_URL is a Postgres URL we also pass it as datasourceUrl,
 *      so even a mis-generated client that slips past the marker fails LOUD
 *      on first query ("the URL must start with the protocol `file:`")
 *      instead of silently opening dev.sqlite.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const WANTS_POSTGRES = /^postgres(ql)?:\/\//.test(DATABASE_URL);

function generatedProvider(): string | null {
  try {
    const marker = JSON.parse(
      readFileSync("prisma/.generated-client.json", "utf8"),
    ) as { provider?: unknown };
    return typeof marker.provider === "string" ? marker.provider : null;
  } catch {
    return null; // marker absent (client generated outside the npm scripts) — rely on layer 2
  }
}

function buildClient(): PrismaClient {
  // v13.1: third defense layer. The v8.5 guard below only engages when
  // DATABASE_URL IS a Postgres URL — an UNSET (or mistyped, e.g. missing
  // colon) DATABASE_URL in production skipped both layers and silently ran
  // the app on the baked-in file:dev.sqlite, a throwaway file wiped on every
  // redeploy, with every health check green. Refuse to boot instead; the
  // check lives here (not at module top) so bundling never executes it.
  if (
    process.env.NODE_ENV === "production" &&
    !WANTS_POSTGRES &&
    process.env.CELLEXIA_ALLOW_SQLITE !== "1"
  ) {
    throw new Error(
      (DATABASE_URL === ""
        ? "DATABASE_URL is not set in production. "
        : "DATABASE_URL is set in production but does not start with postgres:// or postgresql:// — " +
          "probably a typo (a file: URL is NOT honored, see below). ") +
        "The app would silently run on the SQLite file baked into the build — SQLite mode IGNORES " +
        "DATABASE_URL entirely (the dev schema hardcodes file:dev.sqlite, resolved next to the schema " +
        "as prisma/dev.sqlite), and on Docker/Render that file is wiped at every redeploy: settings " +
        "and analytics would be written into a black hole (the exact v8.5 audit failure). Fix: set " +
        "DATABASE_URL to the production Postgres URL in the service's environment (build AND " +
        "runtime), then rebuild and restart. CELLEXIA_ALLOW_SQLITE=1 skips this guard for deliberate " +
        "throwaway deployments (tests, demos) — it still writes prisma/dev.sqlite, never the " +
        "DATABASE_URL path.",
    );
  }
  if (WANTS_POSTGRES) {
    const provider = generatedProvider();
    if (provider !== null && provider !== "postgresql") {
      throw new Error(
        `DATABASE_URL points at Postgres but the generated Prisma Client was built from the ${provider} schema ` +
          "(prisma/.generated-client.json) — starting now would silently run against a local SQLite file instead of " +
          "the production database. Fix: rebuild with DATABASE_URL present in the BUILD environment " +
          "(`npm ci && npm run build` — the build auto-selects prisma/schema.postgres.prisma), or set " +
          "PRISMA_SCHEMA=prisma/schema.postgres.prisma for build environments that hide DATABASE_URL, then restart.",
      );
    }
    return new PrismaClient({ datasourceUrl: DATABASE_URL });
  }
  return new PrismaClient();
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = buildClient();
  }
}

const prisma: PrismaClient = global.prismaGlobal ?? buildClient();

export default prisma;
