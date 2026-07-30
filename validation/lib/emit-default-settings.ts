/**
 * Prints the REAL serialized settings emission (DEFAULT_SETTINGS from the
 * live app/models/settings.server.ts) as JSON on stdout. The harness
 * spawns this via `npx tsx` for the config-path-resolution tripwire —
 * exactly what the old harness section 16 did before the scratchpad wipe.
 */
import { loadSettingsModel } from "./settings-loader";

const model = await loadSettingsModel();
if (!model.DEFAULT_SETTINGS || typeof model.DEFAULT_SETTINGS !== "object") {
  throw new Error("DEFAULT_SETTINGS missing from settings.server.ts exports");
}
process.stdout.write(JSON.stringify(model.DEFAULT_SETTINGS));
