/**
 * Threshold-snap sim (v5.x free-shipping auto-detect) — executes the REAL
 * app/services/shipping.server.ts (imported directly, no copies) against
 * a mock Admin GraphQL client:
 *
 *  - snapDetectedThreshold edge matrix: Shopify's rate-band editor stores
 *    "free over 60" as a 60.01 minimum — anything within 5 cents of a
 *    whole number snaps to it, genuine non-round thresholds pass through;
 *  - zone rules: only ACTIVE zero-price DeliveryRateDefinition rates with
 *    a TOTAL_PRICE / GREATER_THAN_OR_EQUAL_TO MoneyV2 condition count;
 *    per zone the LOWEST threshold wins;
 *  - market attribution: a zone spanning several markets contributes to
 *    all of them, per market the lowest threshold wins, rest-of-world
 *    zones and zones without an enabled market land in unmatchedZones;
 *  - error paths degrade to { ok:false, errors } — never throw.
 *
 * Offline by construction: the mock admin answers the markets queries
 * (marketCountryMap) and the two shipping queries; each scenario uses a
 * unique shop name so the markets module's per-shop cache never leaks
 * between scenarios.
 */
import {
  detectFreeShippingThresholds,
  snapDetectedThreshold,
} from "../../app/services/shipping.server";

let checks = 0;
let failures = 0;
function ok(cond: boolean, label: string) {
  checks++;
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  }
}

// --- snap edge matrix --------------------------------------------------------
ok(snapDetectedThreshold(60.01) === 60, "60.01 (rate-band artifact) snaps to 60");
ok(snapDetectedThreshold(59.99) === 60, "59.99 snaps up to 60");
ok(snapDetectedThreshold(60.05) === 60, "60.05 (5 cents) still snaps");
ok(snapDetectedThreshold(60.06) === 60.06, "60.06 (>5 cents) passes through");
ok(snapDetectedThreshold(62.5) === 62.5, "genuine 62.50 threshold untouched");
ok(snapDetectedThreshold(0.01) === 0, "0.01 snaps to 0");
ok(snapDetectedThreshold(100) === 100, "whole number unchanged");
ok(snapDetectedThreshold(149.99) === 150, "149.99 snaps to 150");
// FP honesty: 150 - 149.95 evaluates a hair ABOVE 0.05 in IEEE doubles, so
// the exact <= 0.05 comparison lets it through unchanged — pinned so a
// future "fix" that widens the window shows up here.
ok(snapDetectedThreshold(149.95) === 149.95, "149.95 passes through (FP boundary, documented)");

// --- mock admin --------------------------------------------------------------
interface GraphqlCall {
  query: string;
  variables?: Record<string, unknown>;
}

type Responder = (call: GraphqlCall) => unknown;

function mockAdmin(responder: Responder) {
  const calls: GraphqlCall[] = [];
  return {
    calls,
    admin: {
      graphql: async (
        query: string,
        options?: { variables?: Record<string, unknown> },
      ) => {
        const call = { query, variables: options?.variables };
        calls.push(call);
        const body = responder(call);
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
}

/** Markets fixture: CH market (CH, LI), EU market (DE, FR), disabled US. */
function marketsAnswer(call: GraphqlCall): unknown | null {
  if (call.query.includes("cellexiaMarkets")) {
    return {
      data: {
        markets: {
          nodes: [
            { id: "gid://m/1", name: "Switzerland", handle: "ch", enabled: true, primary: true,
              currencySettings: { baseCurrency: { currencyCode: "CHF" } } },
            { id: "gid://m/2", name: "Europe", handle: "eu", enabled: true, primary: false,
              currencySettings: { baseCurrency: { currencyCode: "EUR" } } },
            { id: "gid://m/3", name: "US", handle: "us", enabled: false, primary: false,
              currencySettings: { baseCurrency: { currencyCode: "USD" } } },
          ],
        },
      },
    };
  }
  if (call.query.includes("regions")) {
    return {
      data: {
        markets: {
          nodes: [
            { handle: "ch", enabled: true, regions: { nodes: [{ code: "CH" }, { code: "LI" }] } },
            { handle: "eu", enabled: true, regions: { nodes: [{ code: "DE" }, { code: "FR" }] } },
            { handle: "us", enabled: false, regions: { nodes: [{ code: "US" }] } },
          ],
        },
      },
    };
  }
  return null;
}

function freeRate(minAmount: number | string, active = true) {
  return {
    active,
    rateProvider: { price: { amount: "0.00", currencyCode: "CHF" } },
    methodConditions: [
      {
        field: "TOTAL_PRICE",
        operator: "GREATER_THAN_OR_EQUAL_TO",
        conditionCriteria: { amount: String(minAmount), currencyCode: "CHF" },
      },
    ],
  };
}

function zone(name: string, countries: (string | "REST_OF_WORLD")[], methods: unknown[]) {
  return {
    zone: {
      name,
      countries: countries.map((c) =>
        c === "REST_OF_WORLD"
          ? { code: { restOfWorld: true } }
          : { code: { countryCode: c, restOfWorld: false } },
      ),
    },
    methodDefinitions: { pageInfo: { hasNextPage: false }, nodes: methods },
  };
}

function profileAnswer(zones: unknown[]) {
  return {
    data: {
      deliveryProfile: {
        profileLocationGroups: [
          {
            locationGroup: { id: "gid://lg/1" },
            locationGroupZones: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: zones,
            },
          },
        ],
      },
    },
  };
}

async function main() {
  // --- full pipeline: snap, lowest-wins, attribution, unmatched ---------------
  {
    const { admin } = mockAdmin((call) => {
      const markets = marketsAnswer(call);
      if (markets) return markets;
      if (call.query.includes("cellexiaShippingProfiles")) {
        return {
          data: {
            shop: { currencyCode: "CHF" },
            deliveryProfiles: { nodes: [{ id: "gid://dp/1" }] },
          },
        };
      }
      if (call.query.includes("cellexiaShippingZones")) {
        return profileAnswer([
          // CH zone: paid band artifact 60.01 -> snapped 60; a HIGHER free
          // band (100) must lose to the lowest.
          zone("Domestic", ["CH", "LI"], [
            freeRate("100.00"),
            freeRate("60.01"),
            // non-free rate with a condition: ignored
            {
              active: true,
              rateProvider: { price: { amount: "5.00", currencyCode: "CHF" } },
              methodConditions: [{
                field: "TOTAL_PRICE",
                operator: "GREATER_THAN_OR_EQUAL_TO",
                conditionCriteria: { amount: "1.00", currencyCode: "CHF" },
              }],
            },
            // inactive free rate: ignored
            freeRate("10.00", false),
            // wrong operator: ignored
            {
              active: true,
              rateProvider: { price: { amount: "0.00", currencyCode: "CHF" } },
              methodConditions: [{
                field: "TOTAL_PRICE",
                operator: "LESS_THAN_OR_EQUAL_TO",
                conditionCriteria: { amount: "5.00", currencyCode: "CHF" },
              }],
            },
            // wrong field: ignored
            {
              active: true,
              rateProvider: { price: { amount: "0.00", currencyCode: "CHF" } },
              methodConditions: [{
                field: "TOTAL_WEIGHT",
                operator: "GREATER_THAN_OR_EQUAL_TO",
                conditionCriteria: { amount: "2.00", currencyCode: "CHF" },
              }],
            },
            // carrier-calculated rate (no price shape): ignored
            { active: true, rateProvider: {}, methodConditions: [] },
          ]),
          // DE-only zone: genuine non-round threshold passes through and
          // must NOT overwrite a lower value later (see FR zone below).
          zone("Germany", ["DE"], [freeRate("62.50")]),
          // FR zone: lower threshold; DE+FR share the eu market -> lowest wins.
          zone("France", ["FR"], [freeRate("47.50")]),
          // rest-of-world zone: unmatched.
          zone("Everywhere else", ["REST_OF_WORLD"], [freeRate("200.00")]),
          // zone whose country belongs to NO enabled market: unmatched.
          zone("US", ["US"], [freeRate("75.00")]),
          // zone with no free rate at all: silently skipped.
          zone("Paid only", ["CH"], [{
            active: true,
            rateProvider: { price: { amount: "9.00", currencyCode: "CHF" } },
            methodConditions: [],
          }]),
        ]);
      }
      throw new Error("unexpected query");
    });
    const result = await detectFreeShippingThresholds(admin, "sim-shop-a.myshopify.com");
    ok(result.ok === true, "pipeline: ok");
    ok(result.errors.length === 0, "pipeline: no errors (" + result.errors.join("; ") + ")");
    ok(result.shopCurrency === "CHF", "shop currency captured");
    ok(result.byMarket.ch?.amount === 60,
      "CH: 60.01 artifact snapped to 60 AND lowest free band wins (got " +
      String(result.byMarket.ch?.amount) + ")");
    ok(result.byMarket.ch?.currencyCode === "CHF", "CH threshold currency from the condition");
    ok(result.byMarket.eu?.amount === 47.5,
      "EU: lowest across the market's zones wins; 47.50 is genuine, no snap (got " +
      String(result.byMarket.eu?.amount) + ")");
    ok(result.byMarket.us === undefined, "disabled market never attributed");
    ok(result.unmatchedZones === 2, "rest-of-world + no-market zones counted as unmatched (got " +
      String(result.unmatchedZones) + ")");
  }

  // --- multi-market zone contributes to every spanned market -------------------
  {
    const { admin } = mockAdmin((call) => {
      const markets = marketsAnswer(call);
      if (markets) return markets;
      if (call.query.includes("cellexiaShippingProfiles")) {
        return {
          data: {
            shop: { currencyCode: "CHF" },
            deliveryProfiles: { nodes: [{ id: "gid://dp/1" }] },
          },
        };
      }
      if (call.query.includes("cellexiaShippingZones")) {
        return profileAnswer([zone("Alps + EU", ["CH", "DE"], [freeRate("80.02")])]);
      }
      throw new Error("unexpected query");
    });
    const result = await detectFreeShippingThresholds(admin, "sim-shop-b.myshopify.com");
    ok(result.byMarket.ch?.amount === 80 && result.byMarket.eu?.amount === 80,
      "zone spanning two markets feeds both (snapped 80.02 -> 80)");
  }

  // --- error paths: never throw --------------------------------------------------
  {
    const { admin } = mockAdmin((call) => {
      const markets = marketsAnswer(call);
      if (markets) return markets;
      return { errors: [{ message: "shop is locked" }] };
    });
    const result = await detectFreeShippingThresholds(admin, "sim-shop-c.myshopify.com");
    ok(result.ok === false && result.errors.some((e) => e.includes("shop is locked")),
      "GraphQL errors degrade to ok:false with the message surfaced");
  }
  {
    const { admin } = mockAdmin((call) => {
      const markets = marketsAnswer(call);
      if (markets) return markets;
      if (call.query.includes("cellexiaShippingProfiles")) {
        return { data: {} }; // missing deliveryProfiles — scope not granted
      }
      throw new Error("unexpected query");
    });
    const result = await detectFreeShippingThresholds(admin, "sim-shop-d.myshopify.com");
    ok(result.ok === false && result.errors.some((e) => e.includes("read_shipping")),
      "missing scope shape produces the read_shipping hint");
  }
  {
    const { admin } = mockAdmin((call) => {
      const markets = marketsAnswer(call);
      if (markets) return markets;
      if (call.query.includes("cellexiaShippingProfiles")) {
        return {
          data: {
            shop: { currencyCode: "CHF" },
            deliveryProfiles: { nodes: [] },
          },
        };
      }
      throw new Error("unexpected query");
    });
    const result = await detectFreeShippingThresholds(admin, "sim-shop-e.myshopify.com");
    ok(result.ok === false && result.errors.some((e) => e.includes("No delivery profiles")),
      "zero profiles is a reported hard failure");
  }

  // --- crowded-zone partial-coverage warning ----------------------------------------
  {
    const { admin } = mockAdmin((call) => {
      const markets = marketsAnswer(call);
      if (markets) return markets;
      if (call.query.includes("cellexiaShippingProfiles")) {
        return {
          data: {
            shop: { currencyCode: "CHF" },
            deliveryProfiles: { nodes: [{ id: "gid://dp/1" }] },
          },
        };
      }
      if (call.query.includes("cellexiaShippingZones")) {
        const crowded = zone("Busy zone", ["CH"], [freeRate("50.00")]) as {
          methodDefinitions: { pageInfo: { hasNextPage: boolean } };
        };
        crowded.methodDefinitions.pageInfo.hasNextPage = true;
        return profileAnswer([crowded]);
      }
      throw new Error("unexpected query");
    });
    const result = await detectFreeShippingThresholds(admin, "sim-shop-f.myshopify.com");
    ok(result.ok === true && result.byMarket.ch?.amount === 50,
      "crowded zone still yields its scanned threshold");
    ok(result.errors.some((e) => e.includes("partially checked")),
      "crowded zone reported as partially checked");
  }

  if (failures > 0) {
    console.error(`\n${failures}/${checks} CHECKS FAILED`);
    process.exit(1);
  }
  console.log(`ALL ${checks} CHECKS PASSED (threshold snap + free-shipping detection vs the real shipping.server.ts)`);
}

main().catch((e) => {
  console.error("SIM CRASHED:", e);
  process.exit(1);
});
