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
