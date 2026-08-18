import type { LoaderFunctionArgs } from "@remix-run/node";

/**
 * v15.4 — liveness endpoint for the hosting platform. Deliberately touches
 * NOTHING (no database, no Shopify): it answers "the process is up". Point the
 * platform's health check at /healthz so a database outage never makes the
 * platform restart (and re-restart) a perfectly healthy server. Readiness of
 * the database is a separate concern (Setup & health in the app).
 */
export const loader = async (_args: LoaderFunctionArgs) =>
  new Response(JSON.stringify({ ok: true, service: "cellexia-booster", uptimeSeconds: Math.round(process.uptime()) }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
