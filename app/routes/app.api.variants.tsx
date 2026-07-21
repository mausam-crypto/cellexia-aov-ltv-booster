import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  getVariantsByIds,
  searchVariants,
  type VariantSummary,
} from "../services/products.server";

/**
 * Loader-only JSON resource route backing the dashboard variant pickers.
 *
 *   GET /app/api/variants?q=serum            -> search by product/variant title
 *   GET /app/api/variants?ids=gid://...,gid… -> hydrate saved selections
 */
export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<{ variants: VariantSummary[] }> => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);

  const idsParam = url.searchParams.get("ids");
  if (idsParam !== null && idsParam.trim() !== "") {
    const ids = idsParam
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.startsWith("gid://shopify/ProductVariant/"))
      .slice(0, 50);
    const variants = await getVariantsByIds(admin, ids);
    return { variants };
  }

  const query = (url.searchParams.get("q") ?? "")
    .replace(/["'\\]/g, "")
    .trim()
    .slice(0, 80);
  const variants = await searchVariants(admin, query);
  return { variants };
};
