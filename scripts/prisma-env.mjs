#!/usr/bin/env node
/**
 * Environment-aware Prisma pipeline (v8.5).
 *
 * THE problem this solves: the generated Prisma Client bakes in the datasource
 * provider + URL of whichever schema `prisma generate` reads, and
 * app/db.server.ts applies no override — so a production host that generates
 * from the dev schema (sqlite, literal file:dev.sqlite) ships a server that
 * IGNORES DATABASE_URL and silently runs against a throwaway local SQLite
 * file. That exact failure was reproduced end-to-end during the v8.5 deploy
 * audit (app healthy, health checks green, all data written to ephemeral
 * disk). No npm script may ever call `prisma generate` / `prisma migrate
 * deploy` directly again — everything goes through this selector:
 *
 *   node scripts/prisma-env.mjs generate   # generate client from the right schema
 *   node scripts/prisma-env.mjs apply      # create/update the DATABASE (db push / migrate deploy)
 *   node scripts/prisma-env.mjs setup      # generate + apply
 *
 * Selection rule (in order):
 *   1. PRISMA_SCHEMA env var, if set — explicit override for unusual hosts
 *      (e.g. Docker image builds where DATABASE_URL is not present at build
 *      time: set PRISMA_SCHEMA=prisma/schema.postgres.prisma).
 *   2. DATABASE_URL starts with postgres:// or postgresql:// →
 *      prisma/schema.postgres.prisma (db push — the bundled migrations are
 *      SQLite-dialect and must never touch Postgres).
 *   3. DATABASE_URL set but NOT Postgres and NOT file: → hard error (this
 *      app ships SQLite + Postgres schemas only).
 *   4. Otherwise (dev machines, CI) → prisma/schema.prisma (sqlite) with
 *      `migrate deploy`.
 *
 * After every generate, the chosen provider is recorded in
 * prisma/.generated-client.json — app/db.server.ts reads it at boot and
 * refuses to start a Postgres-configured host on a sqlite-generated client.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SQLITE_SCHEMA = "prisma/schema.prisma";
const POSTGRES_SCHEMA = "prisma/schema.postgres.prisma";
const MARKER = join(ROOT, "prisma", ".generated-client.json");

function fail(message) {
  console.error(`\n[prisma-env] ${message}\n`);
  process.exit(1);
}

function pickSchema() {
  const explicit = process.env.PRISMA_SCHEMA;
  if (explicit && explicit !== "") {
    if (!existsSync(join(ROOT, explicit))) {
      fail(`PRISMA_SCHEMA points at "${explicit}" which does not exist.`);
    }
    const provider = explicit === POSTGRES_SCHEMA ? "postgresql" : "sqlite";
    return { schema: explicit, provider, reason: `PRISMA_SCHEMA=${explicit}` };
  }
  const url = process.env.DATABASE_URL ?? "";
  if (/^postgres(ql)?:\/\//.test(url)) {
    return {
      schema: POSTGRES_SCHEMA,
      provider: "postgresql",
      reason: "DATABASE_URL is a Postgres URL",
    };
  }
  if (url !== "" && !url.startsWith("file:")) {
    fail(
      `DATABASE_URL is set to an unsupported scheme (${url.split(":")[0]}:). ` +
        "This app ships schemas for SQLite (dev) and PostgreSQL (production) only.",
    );
  }
  return {
    schema: SQLITE_SCHEMA,
    provider: "sqlite",
    reason: url === "" ? "no DATABASE_URL (dev default)" : "DATABASE_URL is a file: URL",
  };
}

function run(args) {
  execFileSync("npx", ["prisma", ...args], { cwd: ROOT, stdio: "inherit" });
}

const command = process.argv[2];
if (!["generate", "apply", "setup"].includes(command ?? "")) {
  fail(`usage: node scripts/prisma-env.mjs <generate|apply|setup> (got: ${command})`);
}

const { schema, provider, reason } = pickSchema();
console.log(`[prisma-env] ${command}: using ${schema} (${provider}) — ${reason}`);

if (command === "generate" || command === "setup") {
  run(["generate", "--schema", schema]);
  writeFileSync(
    MARKER,
    JSON.stringify({ provider, schema, selectedBecause: reason }, null, 2) + "\n",
  );
  console.log(`[prisma-env] recorded provider "${provider}" in prisma/.generated-client.json`);
}

if (command === "apply" || command === "setup") {
  if (provider === "postgresql") {
    // The bundled prisma/migrations history is SQLite-dialect (its
    // migration_lock.toml pins provider "sqlite") — `migrate deploy` can
    // never run against Postgres. All schema changes are additive, so
    // `db push` is the supported path (see UPDATE.md §2).
    run(["db", "push", "--schema", schema]);
  } else {
    run(["migrate", "deploy", "--schema", schema]);
  }
}
