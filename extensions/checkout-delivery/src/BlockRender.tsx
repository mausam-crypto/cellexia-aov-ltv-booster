import {render} from 'preact';
import {Extension} from './Extension';

/**
 * Entry module for the `purchase.checkout.block.render` target (see
 * shopify.extension.toml) — the merchant-positioned freely placeable block.
 * Same shared UI as ./ShippingOptionListRenderAfter.tsx.
 */
export default async () => {
  render(<Extension />, document.body);
};
