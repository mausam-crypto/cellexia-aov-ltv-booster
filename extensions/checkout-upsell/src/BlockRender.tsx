import {render} from 'preact';
import {Extension} from './Extension';

/**
 * Entry module for the `purchase.checkout.block.render` target (see
 * shopify.extension.toml).
 */
export default async () => {
  render(<Extension />, document.body);
};
