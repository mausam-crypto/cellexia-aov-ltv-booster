import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/ShippingOptionListRenderAfter.tsx' {
  const shopify: import('@shopify/ui-extensions/purchase.checkout.shipping-option-list.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/BlockRender.tsx' {
  const shopify: import('@shopify/ui-extensions/purchase.checkout.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/Extension.tsx' {
  const shopify:
    | import('@shopify/ui-extensions/purchase.checkout.shipping-option-list.render-after').Api
    | import('@shopify/ui-extensions/purchase.checkout.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/delivery-engine.ts' {
  const shopify:
    | import('@shopify/ui-extensions/purchase.checkout.shipping-option-list.render-after').Api
    | import('@shopify/ui-extensions/purchase.checkout.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
