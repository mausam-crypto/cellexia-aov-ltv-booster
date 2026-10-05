import {render} from 'preact';
import {Extension} from './Extension';

/**
 * Entry module for the `purchase.checkout.shipping-option-list.render-after`
 * target (see shopify.extension.toml) — the static placement directly under
 * the shipping-method section. Same shared UI as ./BlockRender.tsx; the
 * merchant picks either placement in the checkout editor.
 */
export default async () => {
  render(<Extension />, document.body);
};
