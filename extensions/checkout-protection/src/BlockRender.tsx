// Wires the host's reactive properties to Preact BEFORE anything renders:
// this module hands @preact/signals' Signal class to the sandbox
// (shopify.setSignals), which is what makes `shopify.*.value` reads inside
// components subscribe them to updates. Without it the extension renders
// once and never reacts to cart/discount/instruction changes (2026-10-06
// migration-merge review catch — Shopify's own template ships this line).
import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {Extension} from './Extension';

/**
 * Entry module for the `purchase.checkout.block.render` target (see
 * shopify.extension.toml). Single-target extension — no sibling entry file
 * needed, unlike checkout-trust/checkout-delivery.
 */
export default async () => {
  render(<Extension />, document.body);
};
