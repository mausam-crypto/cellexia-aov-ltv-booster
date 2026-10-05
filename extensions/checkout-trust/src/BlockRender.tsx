import {render} from 'preact';
import {Extension} from './Extension';

/**
 * Entry module for the `purchase.checkout.block.render` target (see
 * shopify.extension.toml). Renders the shared Extension component — the
 * same UI also registered from ./ActionsRenderBefore.tsx for the
 * alternative static placement.
 */
export default async () => {
  render(<Extension />, document.body);
};
