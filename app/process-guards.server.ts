/**
 * v15.4 — process-level availability guards (server only, installed once).
 *
 * Node ≥ 15 EXITS the process on any unhandled promise rejection. In a
 * request-serving process that is the wrong default: one stray rejection
 * (a background sync, a webhook side effect, a library probe such as the
 * session storage's table poll) takes the whole app — and with it the app
 * proxy that the storefront widgets depend on — down for everyone. This
 * module turns those events into loud log lines instead. Requests that hit a
 * real error still fail on their own (Remix answers 5xx for that request);
 * only the PROCESS is protected.
 *
 * `uncaughtException` is handled the same way: log and keep serving. This is
 * a deliberate availability trade-off for a stateless-per-request server
 * (no in-memory state a half-run request could corrupt).
 */
let installed = false;

export function installProcessGuards(): void {
  if (installed || typeof process === "undefined" || typeof process.on !== "function") return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[process-guard] unhandled promise rejection (kept serving):",
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    );
  });
  process.on("uncaughtException", (error) => {
    console.error(
      "[process-guard] uncaught exception (kept serving):",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
  });
}
