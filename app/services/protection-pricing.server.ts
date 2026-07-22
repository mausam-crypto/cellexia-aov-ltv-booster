/**
 * Shopify Markets fixed pricing for the Order Protection variant
 * (SPEC v4.9 — scopes: read_price_lists, write_price_lists).
 *
 * Motivation: the checkout protection extension displays the protection
 * price in the buyer's presentment currency. Without a fixed per-market
 * price, Shopify converts the base price with FX rates and the buyer sees
 * (and is charged) an ugly number like 3.07 EUR. Writing the merchant's
 * round per-market amounts as FIXED prices onto each market's price list
 * makes the displayed AND charged amount match the configured one exactly.
 *
 * Resolution chain per market (2025-07 Admin API, shapes verified):
 *   markets → Market.catalogs → MarketCatalog.priceList → PriceList{id,currency}
 *   then priceListFixedPricesAdd(priceListId, prices:[{variantId, price}]).
 *
 * Every function here degrades per-market and NEVER throws — a market
 * without a price list becomes a "skipped" result with a how-to-fix detail,
 * a userError becomes a "failed" result, and transport errors surface in
 * `errors` so the admin UI can render them in a banner.
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

/** Desired price for one market (mirrors settings.checkoutProtection.prices). */
export interface ProtectionMarketPrice {
  amount: number;
  currencyCode: string;
}

export interface ApplyProtectionMarketResult {
  /** Market handle the entry belongs to. */
  market: string;
  status: "applied" | "failed" | "skipped";
  /** Human-readable outcome (why it was skipped / what failed / what was set). */
  detail: string;
}

export interface ApplyProtectionPricesResult {
  /** True when nothing failed outright (skips are allowed and reported). */
  ok: boolean;
  /** Top-level errors (market lookup failed, no variant connected, …). */
  errors: string[];
  results: ApplyProtectionMarketResult[];
}

export interface ProtectionPriceReadback {
  ok: boolean;
  errors: string[];
  /** market handle -> the variant's current FIXED price on that market's price list. */
  byMarket: Record<string, { amount: string; currencyCode: string }>;
}

const MARKET_PRICE_LISTS_QUERY = `#graphql
  query cellexiaMarketPriceLists {
    markets(first: 50) {
      nodes {
        handle
        catalogs(first: 5) {
          nodes {
            id
            status
            priceList {
              id
              currency
            }
          }
        }
      }
    }
  }
`;

const FIXED_PRICES_ADD_MUTATION = `#graphql
  mutation cellexiaProtectionFixedPricesAdd(
    $priceListId: ID!
    $prices: [PriceListPriceInput!]!
  ) {
    priceListFixedPricesAdd(priceListId: $priceListId, prices: $prices) {
      prices {
        price {
          amount
          currencyCode
        }
      }
      userErrors {
        field
        code
        message
      }
    }
  }
`;

const PRICE_LIST_FIXED_PRICES_QUERY = `#graphql
  query cellexiaPriceListFixedPrices($priceListId: ID!) {
    priceList(id: $priceListId) {
      id
      currency
      prices(first: 250, originType: FIXED) {
        nodes {
          variant {
            id
          }
          price {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

interface MarketPriceListInfo {
  handle: string;
  priceListId: string | null;
  /** Currency of the price list ("" when there is no price list). */
  currency: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function graphqlErrorMessages(json: unknown): string[] {
  if (typeof json !== "object" || json === null) return [];
  const errors = (json as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((entry) =>
      typeof entry === "object" && entry !== null && "message" in entry
        ? String((entry as { message: unknown }).message)
        : "",
    )
    .filter((message) => message !== "");
}

/** Resolves every market's catalog price list. Never throws. */
async function loadMarketPriceLists(
  admin: AdminGraphqlClient,
): Promise<{ markets: MarketPriceListInfo[]; errors: string[] }> {
  try {
    const response = await admin.graphql(MARKET_PRICE_LISTS_QUERY);
    const json = (await response.json()) as {
      errors?: unknown;
      data?: {
        markets?: {
          nodes?: {
            handle: string;
            catalogs?: {
              nodes?: ({
                id: string;
                status?: string | null;
                priceList?: { id: string; currency: string } | null;
              } | null)[];
            } | null;
          }[];
        };
      };
    };
    const topErrors = graphqlErrorMessages(json);
    const nodes = json.data?.markets?.nodes;
    if (!nodes) {
      return {
        markets: [],
        errors:
          topErrors.length > 0
            ? topErrors
            : ["Could not load the shop's markets and price lists."],
      };
    }
    const markets = nodes.map((market) => {
      const catalogs = (market.catalogs?.nodes ?? []).filter(
        (catalog): catalog is NonNullable<typeof catalog> =>
          Boolean(catalog?.priceList?.id),
      );
      // Prefer an ACTIVE catalog's price list; fall back to any catalog's.
      const chosen =
        catalogs.find((catalog) => catalog.status === "ACTIVE") ?? catalogs[0];
      return {
        handle: market.handle,
        priceListId: chosen?.priceList?.id ?? null,
        currency: chosen?.priceList?.currency ?? "",
      };
    });
    return { markets, errors: topErrors };
  } catch (error) {
    return { markets: [], errors: [errorMessage(error)] };
  }
}

/**
 * Writes the desired per-market protection prices onto each market's price
 * list as FIXED prices. Degrades per market:
 *  - market gone / renamed            -> skipped
 *  - market has no catalog price list -> skipped (with the admin path to create one)
 *  - saved currency != price list's   -> skipped (stale entry — re-save first)
 *  - mutation userErrors / transport  -> failed
 */
export async function applyProtectionPrices(
  admin: AdminGraphqlClient,
  options: {
    variantId: string;
    byMarket: Record<string, ProtectionMarketPrice>;
  },
): Promise<ApplyProtectionPricesResult> {
  try {
    const entries = Object.entries(options.byMarket ?? {});
    if (!options.variantId) {
      return {
        ok: false,
        errors: [
          "No Order Protection product is connected — create or verify it on the Checkout features page first.",
        ],
        results: [],
      };
    }
    if (entries.length === 0) {
      return {
        ok: false,
        errors: [
          "No per-market protection prices are configured — enter at least one amount and save.",
        ],
        results: [],
      };
    }

    const lookup = await loadMarketPriceLists(admin);
    if (lookup.markets.length === 0) {
      return {
        ok: false,
        errors:
          lookup.errors.length > 0
            ? lookup.errors
            : ["Could not load the shop's markets and price lists."],
        results: [],
      };
    }
    const byHandle = new Map(
      lookup.markets.map((market) => [market.handle, market]),
    );

    const results: ApplyProtectionMarketResult[] = [];
    for (const [handle, entry] of entries) {
      const market = byHandle.get(handle);
      if (!market) {
        results.push({
          market: handle,
          status: "skipped",
          detail:
            "no market with this handle exists on the shop anymore — remove or re-save the price.",
        });
        continue;
      }
      if (!market.priceListId) {
        results.push({
          market: handle,
          status: "skipped",
          detail: `no price list — create one under Settings > Markets > ${handle} > Products and pricing, then apply again.`,
        });
        continue;
      }
      if (entry.currencyCode !== market.currency) {
        results.push({
          market: handle,
          status: "skipped",
          detail: `saved price is in ${entry.currencyCode || "an unknown currency"} but the market's price list uses ${market.currency} — re-enter the amount and save again.`,
        });
        continue;
      }

      try {
        const response = await admin.graphql(FIXED_PRICES_ADD_MUTATION, {
          variables: {
            priceListId: market.priceListId,
            prices: [
              {
                variantId: options.variantId,
                price: {
                  amount: String(entry.amount),
                  currencyCode: entry.currencyCode,
                },
              },
            ],
          },
        });
        const json = (await response.json()) as {
          errors?: unknown;
          data?: {
            priceListFixedPricesAdd?: {
              userErrors?: { message: string }[] | null;
            } | null;
          };
        };
        const topErrors = graphqlErrorMessages(json);
        const userErrors = (
          json.data?.priceListFixedPricesAdd?.userErrors ?? []
        ).map((userError) => userError.message);
        const failures = [...topErrors, ...userErrors];
        if (failures.length > 0) {
          results.push({
            market: handle,
            status: "failed",
            detail: failures.join(" "),
          });
        } else {
          results.push({
            market: handle,
            status: "applied",
            detail: `fixed price set to ${entry.amount} ${entry.currencyCode} on the market's price list.`,
          });
        }
      } catch (error) {
        results.push({
          market: handle,
          status: "failed",
          detail: errorMessage(error),
        });
      }
    }

    return {
      ok:
        lookup.errors.length === 0 &&
        !results.some((result) => result.status === "failed"),
      errors: lookup.errors,
      results,
    };
  } catch (error) {
    // Belt and braces — nothing above should throw, but the caller renders
    // this in an admin banner and must never see an exception.
    return { ok: false, errors: [errorMessage(error)], results: [] };
  }
}

/**
 * Reads the variant's current FIXED prices back from each market's price
 * list so the admin UI can show what is live on Shopify right now.
 *
 * Limitation: scans the first 250 fixed prices per price list (no
 * pagination) — plenty for this app's usage, where price lists carry at
 * most a handful of fixed entries. Missing entries simply don't appear in
 * `byMarket`; failures degrade into `errors`.
 */
export async function readbackProtectionPrices(
  admin: AdminGraphqlClient,
  variantId: string,
): Promise<ProtectionPriceReadback> {
  try {
    if (!variantId) return { ok: true, errors: [], byMarket: {} };

    const lookup = await loadMarketPriceLists(admin);
    if (lookup.markets.length === 0) {
      return { ok: lookup.errors.length === 0, errors: lookup.errors, byMarket: {} };
    }

    const uniquePriceListIds = [
      ...new Set(
        lookup.markets
          .map((market) => market.priceListId)
          .filter((id): id is string => Boolean(id)),
      ),
      // Defensive cap — one query per price list, and a shop rarely has
      // more than a handful of market catalogs.
    ].slice(0, 20);

    const errors = [...lookup.errors];
    const byPriceList = new Map<string, { amount: string; currencyCode: string }>();
    for (const priceListId of uniquePriceListIds) {
      try {
        const response = await admin.graphql(PRICE_LIST_FIXED_PRICES_QUERY, {
          variables: { priceListId },
        });
        const json = (await response.json()) as {
          errors?: unknown;
          data?: {
            priceList?: {
              prices?: {
                nodes?: ({
                  variant?: { id: string } | null;
                  price?: { amount: string; currencyCode: string } | null;
                } | null)[];
              } | null;
            } | null;
          };
        };
        errors.push(...graphqlErrorMessages(json));
        const match = (json.data?.priceList?.prices?.nodes ?? []).find(
          (node) => node?.variant?.id === variantId,
        );
        if (match?.price) {
          byPriceList.set(priceListId, {
            amount: match.price.amount,
            currencyCode: match.price.currencyCode,
          });
        }
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }

    const byMarket: Record<string, { amount: string; currencyCode: string }> =
      {};
    for (const market of lookup.markets) {
      if (!market.priceListId) continue;
      const price = byPriceList.get(market.priceListId);
      if (price) byMarket[market.handle] = price;
    }
    return { ok: errors.length === 0, errors, byMarket };
  } catch (error) {
    return { ok: false, errors: [errorMessage(error)], byMarket: {} };
  }
}
