/**
 * Free-shipping threshold auto-detection (scope: read_shipping, SPEC v4.5).
 *
 * Reads the store's delivery profiles and looks for "free shipping over X"
 * rates: an ACTIVE method definition whose rate is a DeliveryRateDefinition
 * with price.amount == 0 AND that carries a TOTAL_PRICE /
 * GREATER_THAN_OR_EQUAL_TO condition with a MoneyV2 criteria. The criteria
 * amount is the threshold — delivery conditions are always expressed in the
 * SHOP currency.
 *
 * Each zone's country codes are attributed to Shopify Markets via
 * marketCountryMap (a zone spanning several markets contributes to all of
 * them). Per market the LOWEST threshold wins. Rest-of-world zones cannot be
 * attributed and are reported in `unmatchedZones`, as are zones with a
 * detected threshold whose countries belong to no enabled market.
 *
 * The Admin API caps a single query at 1,000 cost points, so the prescribed
 * "10 profiles x 50 zones x 50 rates" coverage cannot be fetched in one
 * request (a 50x50 nested connection alone costs >10,000). Instead the
 * detector fetches profile ids first, then pages through each profile's
 * zones in small chunks (well under the cost cap) up to a hard request
 * budget — same effective coverage, no throttling risk.
 *
 * NEVER throws: any transport/shape problem degrades to { ok:false, errors }.
 */

import { marketCountryMap } from "./markets.server";
import type { MarketThreshold } from "../models/settings.server";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export interface ShippingDetectionResult {
  ok: boolean;
  errors: string[];
  /** Shop currency (delivery conditions are stated in it); "" if unknown. */
  shopCurrency: string;
  /** market handle -> lowest detected free-shipping threshold. */
  byMarket: Record<string, MarketThreshold>;
  /** Zones with rest-of-world coverage, plus zones whose detected threshold
   *  could not be attributed to any enabled market. */
  unmatchedZones: number;
}

const MAX_PROFILES = 10;
/** Zones per page — keeps each query far below the 1,000-point cost cap. */
const ZONES_PAGE_SIZE = 8;
const METHODS_PAGE_SIZE = 15;
/** Hard budget of zone-page requests across all profiles. */
const MAX_ZONE_REQUESTS = 25;

const PROFILE_IDS_QUERY = `#graphql
  query cellexiaShippingProfiles($first: Int!) {
    shop {
      currencyCode
    }
    deliveryProfiles(first: $first) {
      nodes {
        id
      }
    }
  }
`;

const ZONE_FIELDS = `#graphql
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        zone {
          name
          countries {
            code {
              countryCode
              restOfWorld
            }
          }
        }
        methodDefinitions(first: ${METHODS_PAGE_SIZE}) {
          pageInfo {
            hasNextPage
          }
          nodes {
            active
            rateProvider {
              ... on DeliveryRateDefinition {
                price {
                  amount
                  currencyCode
                }
              }
            }
            methodConditions {
              field
              operator
              conditionCriteria {
                ... on MoneyV2 {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
`;

const PROFILE_ZONES_QUERY = `#graphql
  query cellexiaShippingZones($profileId: ID!, $zonesFirst: Int!) {
    deliveryProfile(id: $profileId) {
      profileLocationGroups {
        locationGroup {
          id
        }
        locationGroupZones(first: $zonesFirst) {
          ${ZONE_FIELDS}
        }
      }
    }
  }
`;

/** Follow-up pages scoped to ONE location group — zone cursors belong to a
 *  single connection, so paging must not fan the cursor out to sibling
 *  location groups. */
const PROFILE_ZONES_PAGE_QUERY = `#graphql
  query cellexiaShippingZonesPage(
    $profileId: ID!
    $locationGroupId: ID!
    $zonesFirst: Int!
    $after: String!
  ) {
    deliveryProfile(id: $profileId) {
      profileLocationGroups(locationGroupId: $locationGroupId) {
        locationGroup {
          id
        }
        locationGroupZones(first: $zonesFirst, after: $after) {
          ${ZONE_FIELDS}
        }
      }
    }
  }
`;

interface ZoneCountryCode {
  countryCode?: string | null;
  restOfWorld?: boolean | null;
}

interface MethodDefinitionNode {
  active?: boolean | null;
  rateProvider?: {
    price?: { amount?: string | number | null; currencyCode?: string | null } | null;
  } | null;
  methodConditions?:
    | ({
        field?: string | null;
        operator?: string | null;
        conditionCriteria?: {
          amount?: string | number | null;
          currencyCode?: string | null;
        } | null;
      } | null)[]
    | null;
}

interface ZoneNode {
  zone?: {
    name?: string | null;
    countries?: ({ code?: ZoneCountryCode | null } | null)[] | null;
  } | null;
  methodDefinitions?: {
    pageInfo?: { hasNextPage?: boolean | null } | null;
    nodes?: (MethodDefinitionNode | null)[] | null;
  } | null;
}

interface LocationGroupNode {
  locationGroup?: { id?: string | null } | null;
  locationGroupZones?: {
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
    nodes?: (ZoneNode | null)[] | null;
  } | null;
}

function toFiniteNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function graphqlErrorMessages(json: {
  errors?: ({ message?: string } | null)[];
}): string[] {
  return (json.errors ?? [])
    .map((error) => error?.message)
    .filter((message): message is string => typeof message === "string");
}

/**
 * Snap a detected threshold to the round number it plainly represents.
 *
 * Shopify's rate-band editor stores "free shipping above 60" as a free rate
 * whose minimum is 60.01 (the paid band ends at 60.00), so raw detection
 * reports 60.01 — which then leaks into the shipbar as "Free shipping over
 * 60.01". Any amount within 5 cents of a whole number is intended as that
 * whole number; genuine non-round thresholds (e.g. 62.50) pass through
 * untouched.
 */
export function snapDetectedThreshold(amount: number): number {
  const nearest = Math.round(amount);
  return Math.abs(amount - nearest) <= 0.05 ? nearest : amount;
}

/**
 * Lowest "free over X" threshold configured in a zone, or null when the zone
 * has none. `moneyCurrency` (out-param style via return) also surfaces the
 * condition's currency so the caller can backfill the shop currency.
 */
function zoneThreshold(zone: ZoneNode): {
  amount: number;
  currencyCode: string;
} | null {
  let best: { amount: number; currencyCode: string } | null = null;
  for (const method of zone.methodDefinitions?.nodes ?? []) {
    if (!method || method.active !== true) continue;
    const price = toFiniteNumber(method.rateProvider?.price?.amount);
    // Only DeliveryRateDefinition providers expose price; carrier-calculated
    // (DeliveryParticipant) rates come back as {} and are skipped here.
    if (price === null || price !== 0) continue;
    for (const condition of method.methodConditions ?? []) {
      if (!condition) continue;
      if (condition.field !== "TOTAL_PRICE") continue;
      if (condition.operator !== "GREATER_THAN_OR_EQUAL_TO") continue;
      const raw = toFiniteNumber(condition.conditionCriteria?.amount);
      if (raw === null || raw < 0) continue;
      const amount = snapDetectedThreshold(raw);
      const currencyCode =
        typeof condition.conditionCriteria?.currencyCode === "string"
          ? condition.conditionCriteria.currencyCode
          : "";
      if (!best || amount < best.amount) {
        best = { amount, currencyCode };
      }
    }
  }
  return best;
}

export async function detectFreeShippingThresholds(
  admin: AdminGraphqlClient,
  shop: string,
): Promise<ShippingDetectionResult> {
  const result: ShippingDetectionResult = {
    ok: false,
    errors: [],
    shopCurrency: "",
    byMarket: {},
    unmatchedZones: 0,
  };

  try {
    const [countryMap, profilesResponse] = await Promise.all([
      marketCountryMap(admin, shop),
      admin.graphql(PROFILE_IDS_QUERY, {
        variables: { first: MAX_PROFILES },
      }),
    ]);
    const profilesJson = (await profilesResponse.json()) as {
      data?: {
        shop?: { currencyCode?: string | null } | null;
        deliveryProfiles?: {
          nodes?: ({ id?: string | null } | null)[] | null;
        } | null;
      };
      errors?: ({ message?: string } | null)[];
    };

    const profileErrors = graphqlErrorMessages(profilesJson);
    if (profileErrors.length > 0) {
      result.errors.push(...profileErrors);
      return result;
    }
    if (!profilesJson.data?.deliveryProfiles) {
      result.errors.push(
        "Unexpected delivery profiles response shape — is the read_shipping scope granted?",
      );
      return result;
    }

    result.shopCurrency =
      typeof profilesJson.data.shop?.currencyCode === "string"
        ? profilesJson.data.shop.currencyCode
        : "";
    const profileIds = (profilesJson.data.deliveryProfiles.nodes ?? [])
      .map((node) => node?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    let zoneRequests = 0;
    let coverageTruncated = false;
    const crowdedZones: string[] = [];

    const processZones = (nodes: (ZoneNode | null)[]) => {
      for (const zone of nodes) {
        if (!zone) continue;
        if (zone.methodDefinitions?.pageInfo?.hasNextPage) {
          crowdedZones.push(zone.zone?.name || "unnamed zone");
        }
        const codes = zone.zone?.countries ?? [];
        const restOfWorld = codes.some(
          (country) => country?.code?.restOfWorld === true,
        );
        const threshold = zoneThreshold(zone);
        if (threshold && !result.shopCurrency && threshold.currencyCode) {
          result.shopCurrency = threshold.currencyCode;
        }
        if (restOfWorld) {
          // No market can be attributed to a rest-of-world zone — the
          // storefront falls back to global.freeShippingThreshold there.
          result.unmatchedZones += 1;
          continue;
        }
        if (!threshold) continue;
        const handles = new Set<string>();
        for (const country of codes) {
          const code = country?.code?.countryCode;
          if (!code) continue;
          const handle = countryMap.byCountry.get(code);
          if (handle) handles.add(handle);
        }
        if (handles.size === 0) {
          result.unmatchedZones += 1;
          continue;
        }
        const entry: MarketThreshold = {
          amount: threshold.amount,
          currencyCode: threshold.currencyCode || result.shopCurrency || "",
        };
        for (const handle of handles) {
          const existing = result.byMarket[handle];
          if (!existing || entry.amount < existing.amount) {
            result.byMarket[handle] = { ...entry };
          }
        }
      }
    };

    for (const profileId of profileIds) {
      if (zoneRequests >= MAX_ZONE_REQUESTS) {
        coverageTruncated = true;
        break;
      }
      zoneRequests += 1;
      const response = await admin.graphql(PROFILE_ZONES_QUERY, {
        variables: { profileId, zonesFirst: ZONES_PAGE_SIZE },
      });
      const json = (await response.json()) as {
        data?: {
          deliveryProfile?: {
            profileLocationGroups?: (LocationGroupNode | null)[] | null;
          } | null;
        };
        errors?: ({ message?: string } | null)[];
      };
      const errors = graphqlErrorMessages(json);
      if (errors.length > 0) {
        result.errors.push(...errors);
        continue;
      }
      const locationGroups =
        json.data?.deliveryProfile?.profileLocationGroups ?? null;
      if (!locationGroups) {
        result.errors.push(
          "Unexpected delivery profile response shape for one shipping profile.",
        );
        continue;
      }

      // Per-location-group cursors that still have pages left.
      const pending: { locationGroupId: string; after: string }[] = [];
      for (const group of locationGroups) {
        const connection = group?.locationGroupZones;
        if (!connection) continue;
        processZones(connection.nodes ?? []);
        const pageInfo = connection.pageInfo;
        const groupId = group?.locationGroup?.id;
        if (pageInfo?.hasNextPage && pageInfo.endCursor) {
          if (groupId) {
            pending.push({ locationGroupId: groupId, after: pageInfo.endCursor });
          } else {
            coverageTruncated = true;
          }
        }
      }

      while (pending.length > 0) {
        if (zoneRequests >= MAX_ZONE_REQUESTS) {
          coverageTruncated = true;
          break;
        }
        zoneRequests += 1;
        const page = pending.shift()!;
        const pageResponse = await admin.graphql(PROFILE_ZONES_PAGE_QUERY, {
          variables: {
            profileId,
            locationGroupId: page.locationGroupId,
            zonesFirst: ZONES_PAGE_SIZE,
            after: page.after,
          },
        });
        const pageJson = (await pageResponse.json()) as {
          data?: {
            deliveryProfile?: {
              profileLocationGroups?: (LocationGroupNode | null)[] | null;
            } | null;
          };
          errors?: ({ message?: string } | null)[];
        };
        const pageErrors = graphqlErrorMessages(pageJson);
        if (pageErrors.length > 0) {
          result.errors.push(...pageErrors);
          coverageTruncated = true;
          continue;
        }
        const pagedGroups =
          pageJson.data?.deliveryProfile?.profileLocationGroups ?? [];
        for (const group of pagedGroups) {
          if (group?.locationGroup?.id !== page.locationGroupId) continue;
          const connection = group?.locationGroupZones;
          if (!connection) continue;
          processZones(connection.nodes ?? []);
          const pageInfo = connection.pageInfo;
          if (pageInfo?.hasNextPage && pageInfo.endCursor) {
            pending.push({
              locationGroupId: page.locationGroupId,
              after: pageInfo.endCursor,
            });
          }
        }
      }
    }

    if (profileIds.length === 0) {
      result.errors.push("No delivery profiles found on this store.");
    }
    if (coverageTruncated) {
      result.errors.push(
        "Not all shipping zones could be scanned — thresholds were detected from the zones read so far.",
      );
    }
    if (crowdedZones.length > 0) {
      result.errors.push(
        `Some zones have more than ${METHODS_PAGE_SIZE} rates and were only partially checked: ${[
          ...new Set(crowdedZones),
        ]
          .slice(0, 5)
          .join(", ")}.`,
      );
    }

    // Partial reads still produced usable thresholds; only a run with zero
    // successfully-scanned profiles is a hard failure.
    result.ok =
      profileIds.length > 0 &&
      (Object.keys(result.byMarket).length > 0 ||
        result.errors.length === 0 ||
        coverageTruncated ||
        crowdedZones.length > 0);
    return result;
  } catch (error) {
    result.errors.push(
      error instanceof Error
        ? error.message
        : "Could not read shipping rates from the Admin API.",
    );
    result.ok = false;
    return result;
  }
}
