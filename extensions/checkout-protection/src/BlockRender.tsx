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
