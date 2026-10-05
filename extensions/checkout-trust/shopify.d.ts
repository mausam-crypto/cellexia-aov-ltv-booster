import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/BlockRender.tsx' {
  const shopify: import('@shopify/ui-extensions/purchase.checkout.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/ActionsRenderBefore.tsx' {
  const shopify: import('@shopify/ui-extensions/purchase.checkout.actions.render-before').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/Extension.tsx' {
  const shopify:
    | import('@shopify/ui-extensions/purchase.checkout.block.render').Api
    | import('@shopify/ui-extensions/purchase.checkout.actions.render-before').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/delivery-engine.ts' {
  const shopify:
    | import('@shopify/ui-extensions/purchase.checkout.block.render').Api
    | import('@shopify/ui-extensions/purchase.checkout.actions.render-before').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/trust-logic.ts' {
  const shopify:
    | import('@shopify/ui-extensions/purchase.checkout.block.render').Api
    | import('@shopify/ui-extensions/purchase.checkout.actions.render-before').Api;
  const globalThis: { shopify: typeof shopify };
}
