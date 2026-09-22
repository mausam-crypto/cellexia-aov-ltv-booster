// v32 volume pricing — wasm entry for target cart.lines.discounts.generate.run
// (toml export "cart-lines-discounts-generate-run" -> this named export, per
// the cellexia-rewards / Shopify JS discount template). No logic here:
// everything lives in ./logic.js so the harness can test it in plain Node
// (validation/sims/volume-function.mjs). Never throws: a malformed input
// yields no operations rather than a failed Function run.
import { volumeOperations } from "./logic.js";

/**
 * @param {object} input CartInput (see cart_lines_discounts_generate_run.graphql)
 * @returns {{operations: object[]}}
 */
export function cartLinesDiscountsGenerateRun(input) {
  try {
    return { operations: volumeOperations(input) };
  } catch {
    return { operations: [] };
  }
}
