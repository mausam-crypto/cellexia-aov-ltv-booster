import {render} from 'preact';
import {Extension} from './Extension';

/**
 * Entry module for the `purchase.checkout.actions.render-before` target
 * (see shopify.extension.toml) — the static placement immediately before
 * the actions (Pay button) area. Same shared UI as ./BlockRender.tsx.
 */
export default async () => {
  render(<Extension />, document.body);
};
