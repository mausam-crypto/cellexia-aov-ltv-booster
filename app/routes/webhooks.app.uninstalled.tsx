import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already
  // been uninstalled. If the webhook already ran, the session may have been
  // deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // v4 lifecycle hygiene (best-effort, each step isolated so one failure
  // never blocks the others or fails the webhook — Shopify would retry and
  // eventually drop the delivery):
  //  - Drop PreviewState so a stale armed preview (and its token) does not
  //    survive an uninstall/reinstall cycle.
  //  - Stop running/concluding experiments — nothing can conclude them once
  //    the app is gone, and "kept" preserves whatever flags were live.
  try {
    await db.previewState.deleteMany({ where: { shop } });
  } catch (error) {
    console.error(`Failed to delete PreviewState for ${shop}:`, error);
  }
  try {
    await db.experiment.updateMany({
      where: { shop, status: { in: ["running", "concluding"] } },
      data: { status: "stopped", outcome: "kept", concludedAt: new Date() },
    });
  } catch (error) {
    console.error(`Failed to stop running experiments for ${shop}:`, error);
  }

  return new Response();
};
