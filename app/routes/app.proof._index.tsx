import { redirect } from "@remix-run/node";

/** /app/proof lands on the results tab (the highest-volume moderation
 *  surface — customer submissions arrive as pending there). */
export const loader = async () => redirect("/app/proof/results");
