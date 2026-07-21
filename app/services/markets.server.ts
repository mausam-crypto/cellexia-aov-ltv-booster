/**
 * Shopify Markets access (scope: read_markets).
 *
 * - listMarkets: id/name/handle/enabled/primary for the admin UI.
 * - marketCountryMap: market handle -> ISO country codes, used by the
 *   orders/paid webhook to attribute an order to a market from its shipping
 *   country (the REST-shaped webhook payload carries no market id).
 *   Cached in-module per shop for 1 hour — webhook volume friendly.
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export interface MarketSummary {
  id: string;
  name: string;
  handle: string;
  enabled: boolean;
  primary: boolean;
  /** Market base currency (ISO 4217, e.g. "EUR"); "" when unavailable. */
  currencyCode: string;
}

const MARKETS_QUERY = `#graphql
  query cellexiaMarkets {
    markets(first: 50) {
      nodes {
        id
        name
        handle
        enabled
        primary
        currencySettings {
          baseCurrency {
            currencyCode
          }
        }
      }
    }
  }
`;

const MARKET_REGIONS_QUERY = `#graphql
  query cellexiaMarketRegions {
    markets(first: 50) {
      nodes {
        handle
        enabled
        regions(first: 250) {
          nodes {
            ... on MarketRegionCountry {
              code
            }
          }
        }
      }
    }
  }
`;

export async function listMarkets(
  admin: AdminGraphqlClient,
): Promise<MarketSummary[]> {
  const response = await admin.graphql(MARKETS_QUERY);
  const json = (await response.json()) as {
    data?: {
      markets?: {
        nodes?: {
          id: string;
          name: string;
          handle: string;
          enabled: boolean;
          primary: boolean;
          currencySettings?: {
            baseCurrency?: { currencyCode?: string | null } | null;
          } | null;
        }[];
      };
    };
  };
  return (json.data?.markets?.nodes ?? []).map((node) => ({
    id: node.id,
    name: node.name,
    handle: node.handle,
    enabled: Boolean(node.enabled),
    primary: Boolean(node.primary),
    currencyCode:
      typeof node.currencySettings?.baseCurrency?.currencyCode === "string"
        ? node.currencySettings.baseCurrency.currencyCode
        : "",
  }));
}

export interface MarketCountryMap {
  /** ISO country code -> market handle */
  byCountry: Map<string, string>;
  /** primary/first enabled market handle, used as a fallback label */
  primaryHandle: string | null;
}

const countryMapCache = new Map<
  string,
  { fetchedAt: number; value: MarketCountryMap }
>();
const COUNTRY_MAP_TTL_MS = 60 * 60 * 1000;

export async function marketCountryMap(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<MarketCountryMap> {
  const cached = countryMapCache.get(shop);
  if (cached && Date.now() - cached.fetchedAt < COUNTRY_MAP_TTL_MS) {
    return cached.value;
  }

  const [markets, regionsResponse] = await Promise.all([
    listMarkets(admin),
    admin.graphql(MARKET_REGIONS_QUERY),
  ]);
  const regionsJson = (await regionsResponse.json()) as {
    data?: {
      markets?: {
        nodes?: {
          handle: string;
          enabled: boolean;
          regions: { nodes: ({ code?: string } | null)[] };
        }[];
      };
    };
  };

  const byCountry = new Map<string, string>();
  for (const market of regionsJson.data?.markets?.nodes ?? []) {
    if (!market.enabled) continue;
    for (const region of market.regions?.nodes ?? []) {
      const code = region?.code;
      if (code && !byCountry.has(code)) {
        byCountry.set(code, market.handle);
      }
    }
  }
  const primaryHandle =
    markets.find((m) => m.primary)?.handle ??
    markets.find((m) => m.enabled)?.handle ??
    null;

  const value: MarketCountryMap = { byCountry, primaryHandle };
  countryMapCache.set(shop, { fetchedAt: Date.now(), value });
  return value;
}
