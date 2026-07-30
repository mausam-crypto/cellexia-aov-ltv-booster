/**
 * Loads the REAL app/models/settings.server.ts for execution inside the
 * validation suites (settings-derivation, config-path emission) without a
 * database: the single `import prisma from "../db.server"` line is
 * replaced with a throwing Proxy stub, so any code path that actually
 * touches prisma fails loudly instead of silently passing.
 *
 * The stubbed copy is generated into validation/lib/.gen/ (repo-resident,
 * regenerated on every run from the CURRENT tree — the model itself is
 * never forked). Run with `npx tsx`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");

const PRISMA_IMPORT = 'import prisma from "../db.server";';
const PRISMA_STUB = [
  "// validation stub — the real import is `import prisma from \"../db.server\";`",
  "const prisma: any = new Proxy({}, {",
  "  get(_t, p) {",
  "    throw new Error(",
  "      'validation: settings.server.ts touched prisma.' + String(p) +",
  "      ' — suites must stay offline/db-free');",
  "  },",
  "});",
].join("\n");

export async function loadSettingsModel(): Promise<any> {
  const srcPath = path.join(ROOT, "app", "models", "settings.server.ts");
  const src = fs.readFileSync(srcPath, "utf8");
  if (!src.includes(PRISMA_IMPORT)) {
    throw new Error(
      "settings-loader: prisma import anchor not found in settings.server.ts — " +
        "update PRISMA_IMPORT in validation/lib/settings-loader.ts",
    );
  }
  const stubbed = src.replace(PRISMA_IMPORT, PRISMA_STUB);
  const genDir = path.join(HERE, ".gen");
  fs.mkdirSync(genDir, { recursive: true });
  const outPath = path.join(genDir, "settings.server.real.ts");
  // Write only when changed so repeated runs stay byte-stable.
  if (!fs.existsSync(outPath) || fs.readFileSync(outPath, "utf8") !== stubbed) {
    fs.writeFileSync(outPath, stubbed);
  }
  return await import(pathToFileURL(outPath).href);
}
