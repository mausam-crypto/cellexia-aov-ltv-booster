// v14 rewards — wasm entry for target cart.delivery-options.discounts.generate.run
// (toml export "cart-delivery-options-discounts-generate-run"). Free-shipping
// guarantee; logic in ./logic.js. Never throws.
import { deliveryOperations } from "./logic.js";

/**
 * @param {object} input DeliveryInput (see cart_delivery_options_discounts_generate_run.graphql)
 * @returns {{operations: object[]}}
 */
export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  try {
    return { operations: deliveryOperations(input) };
  } catch {
    return { operations: [] };
  }
}
