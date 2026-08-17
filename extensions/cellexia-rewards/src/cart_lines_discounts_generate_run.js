// v14 rewards — wasm entry for target cart.lines.discounts.generate.run
// (toml export "cart-lines-discounts-generate-run" -> this named export, per
// Shopify's JS discount template). No logic here: everything lives in
// ./logic.js so the harness can test it in plain Node. Never throws: a
// malformed input yields no operations rather than a failed Function run.
import { cartLinesOperations } from "./logic.js";

/**
 * @param {object} input CartInput (see cart_lines_discounts_generate_run.graphql)
 * @returns {{operations: object[]}}
 */
export function cartLinesDiscountsGenerateRun(input) {
  try {
    return { operations: cartLinesOperations(input) };
  } catch {
    return { operations: [] };
  }
}
