#!/usr/bin/env node
/**
 * v15.4 — outage-tolerant container boot (`npm run docker-start`).
 *
 * BEFORE: `npm run setup && npm run start` — the schema apply (`prisma db
 * push` on Postgres) ran FIRST and the server only started when it
 * succeeded. A database that was unreachable for a moment (restart, disk
 * full, failover) made the push fail, the `&&` short-circuited, the
 * container exited, the platform restarted it into the same window: a full
 * outage of the admin AND of every storefront widget served through the app
 * proxy, for as long as the database hiccuped (plus restart back-off).
 *
 * NOW, in this order:
 *   1. generate the Prisma Client for the schema DATABASE_URL selects
 *      (offline — never touches the database);
 *   2. START THE SERVER IMMEDIATELY (the app itself tolerates an unreachable
 *      database: requests that need it fail individually, the process
 *      survives — see app/process-guards.server.ts and
 *      app/services/session-storage.server.ts);
 *   3. apply the schema in the BACKGROUND with retries and back-off
 *      (15 s → 30 s → 60 s, capped; up to `CELLEXIA_DB_APPLY_MAX_MINUTES`,
 *      default 60) and log every attempt. All schema changes are additive
 *      (`db push` on Postgres, `migrate deploy` on SQLite), so applying them
 *      while the server is already serving is safe. When the apply keeps
 *      failing the server simply keeps running on the previous schema — the
 *      Setup & health page reports the missing objects.
 * The process exits ONLY when the server process itself exits (its code is
 * propagated), or on SIGTERM/SIGINT (forwarded to the server).
 *
 * Opt-outs: CELLEXIA_SKIP_DB_APPLY=1 skips step 3 entirely (hosts that apply
 * schema changes in their own release phase). CELLEXIA_DB_APPLY_BLOCKING=1
 * restores the pre-v15.4 behaviour (apply first, then start) for operators
 * who prefer it.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const selector = resolve(here, "prisma-env.mjs");
const require = createRequire(import.meta.url);
// The server is spawned DIRECTLY (not through `npm run start`): npm does not
// forward SIGTERM reliably, which would leave an orphaned server behind when
// the platform stops the container.
const remixServe = require.resolve("@remix-run/serve/dist/cli.js");
const serverEntry = resolve(root, "build/server/index.js");

function log(msg) {
  console.log(`[boot] ${msg}`);
}

function runOnce(cmd, args, { inherit = true } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: false,
    });
    let out = "";
    if (!inherit) {
      child.stdout?.on("data", (d) => {
        out += String(d);
      });
      child.stderr?.on("data", (d) => {
        out += String(d);
      });
    }
    child.on("error", (error) => resolveRun({ code: 1, out: out + String(error) }));
    child.on("exit", (code) => resolveRun({ code: code ?? 1, out }));
  });
}

async function generateClient() {
  log("generating the Prisma Client for the selected schema (offline)");
  const { code } = await runOnce(process.execPath, [selector, "generate"]);
  if (code !== 0) {
    // A generate failure is a build/packaging problem, not a database one:
    // the server cannot run without a client. Fail fast with the real error.
    console.error("[boot] Prisma Client generation failed — cannot start (see the error above).");
    process.exit(code);
  }
}

async function applySchemaWithRetry() {
  if (process.env.CELLEXIA_SKIP_DB_APPLY === "1") {
    log("CELLEXIA_SKIP_DB_APPLY=1 — not applying schema changes from the container");
    return;
  }
  const maxMinutes = Number(process.env.CELLEXIA_DB_APPLY_MAX_MINUTES) > 0
    ? Number(process.env.CELLEXIA_DB_APPLY_MAX_MINUTES)
    : 60;
  const deadline = Date.now() + maxMinutes * 60_000;
  let delay = 15_000;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    log(`applying schema changes (attempt ${attempt})…`);
    const { code, out } = await runOnce(process.execPath, [selector, "apply"], { inherit: false });
    if (code === 0) {
      log("schema is up to date");
      return;
    }
    const tail = out.trim().split("\n").slice(-6).join("\n");
    console.error(`[boot] schema apply attempt ${attempt} failed (the server keeps running):\n${tail}`);
    if (Date.now() + delay > deadline) {
      console.error(
        `[boot] giving up on the background schema apply after ${maxMinutes} min — run \`npm run setup\` (or \`npx prisma db push --schema prisma/schema.postgres.prisma\`) once the database is healthy; Setup & health lists any missing objects.`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 60_000);
  }
}

function startServer() {
  log("starting the server");
  const child = spawn(process.execPath, [remixServe, serverEntry], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  child.on("exit", (code, signal) => {
    log(`server exited (${signal ?? code}) — exiting`);
    process.exit(typeof code === "number" ? code : 1);
  });
  child.on("error", (error) => {
    console.error("[boot] could not start the server:", error);
    process.exit(1);
  });
  return child;
}

await generateClient();
if (process.env.CELLEXIA_DB_APPLY_BLOCKING === "1") {
  // Legacy order for operators who insist on it — still with retries, and the
  // server starts even when the apply gives up.
  await applySchemaWithRetry();
  startServer();
} else {
  startServer();
  // Give the server a head start so its logs come first, then apply.
  setTimeout(() => {
    applySchemaWithRetry().catch((error) => {
      console.error("[boot] background schema apply crashed (the server keeps running):", error);
    });
  }, 3_000);
}
