/**
 * validation/sims/rewards-clusters.ts — v18: the three engines agree on
 * which cluster a country is in.
 *
 * Free gifts are decided in three places that never see each other's code:
 *
 *   SERVER      app/models/settings.server.ts  (clusterForCountry) — the
 *               admin, the suggester and the plan builder all use it.
 *   PLAN        app/services/gift-plan.server.ts (buildGiftPlan) — flattens
 *               the clusters into the cc/rest map that Liquid indexes, so
 *               the STOREFRONT resolves by lookup instead of logic.
 *   FUNCTION    extensions/cellexia-rewards/src/logic.js (clusterFor) — the
 *               referee that actually zeroes the price at checkout.
 *
 * If any two of them disagree, a shopper sees one ladder in the cart and is
 * charged against another at checkout, which is exactly the class of bug the
 * gift feature cannot afford. This suite drives all three over the same
 * country matrix and asserts they land on the same cluster every time, and
 * that the local-amount resolution matches too.
 *
 * Offline, deterministic (pure resolution over the shipped defaults; no
 * clock, no DOM, no network, no database).
 */
import { loadSettingsModel } from "../lib/settings-loader";
import { makeChecker } from "../lib/util.mjs";
import { buildGiftPlan, giftPlanForCountry } from "../../app/services/gift-plan.server";
import { clusterFor, giftAmounts } from "../../extensions/cellexia-rewards/src/logic.js";

const { ok, finish } = makeChecker("sims/rewards-clusters: server / plan / Function agree per country");

const M = await loadSettingsModel();
const { DEFAULT_SETTINGS, clusterForCountry, roundThreshold, sanitizeGiftClusters } = M;

const settings = structuredClone(DEFAULT_SETTINGS);
const clusters = settings.rewards.giftTiers.clusters;

// Every country named anywhere, plus unlisted ones and junk, so the catch-all
// and the guards are exercised as hard as the happy path.
const MATRIX = [
  ...clusters.flatMap((c: { countries: string[] }) => c.countries),
  "US", "NL", "BE", "CH", "PL", "CZ", "HU", "RO", "MT", "CY", // unlisted -> catch-all
  "ZZ", "", "  ", "es", "gb", "Gb", "USA", "1", "__proto__",   // junk / casing
];

// ---------------------------------------------------------------- 1. AGREE
const plan = buildGiftPlan(settings, {});
const fnConfig = {
  cl: Object.fromEntries(
    clusters.map((c: { id: string; tiers: { amount: number }[] }) => [
      c.id,
      { tiers: c.tiers.map((t) => ({ eur: t.amount, slots: [] })) },
    ]),
  ),
  cc: plan.cc,
  rest: plan.rest,
  bc: {},
};

let agreed = 0;
for (const country of MATRIX) {
  const server = clusterForCountry(clusters, country);
  const viaPlan = giftPlanForCountry(plan, country);
  const viaFn = clusterFor(fnConfig, country);
  ok(
    server !== null,
    `server: "${country}" resolves to a cluster, never null (total by construction)`,
  );
  ok(
    viaPlan.gt !== null && viaPlan.gt.name === server.name,
    `plan: "${country}" -> ${server.id} (Liquid indexes cc/rest to the same cluster the server picked)`,
  );
  ok(
    viaFn !== null &&
      JSON.stringify(viaFn.tiers.map((t: { eur: number }) => t.eur)) ===
        JSON.stringify(server.tiers.map((t: { amount: number }) => t.amount)),
    `function: "${country}" -> the same ladder the server and the plan resolved (${server.id})`,
  );
  agreed += 1;
}
ok(agreed === MATRIX.length, `all ${MATRIX.length} countries were checked (anti-vacuity)`);

// ------------------------------------------------------- 2. THE SHIPPED MAP
ok(clusterForCountry(clusters, "ES").id === "amphora", "ES is served by Amphora");
ok(clusterForCountry(clusters, "GB").id === "active-ants", "GB is served by Active Ants");
ok(clusterForCountry(clusters, "GG").id === "active-ants", "Guernsey rides with the UK");
ok(clusterForCountry(clusters, "JE").id === "active-ants", "Jersey rides with the UK");
ok(clusterForCountry(clusters, "EG").id === "active-ants", "Egypt is in the Active Ants list");
ok(clusterForCountry(clusters, "US").id === "rest", "the US falls to the catch-all");
ok(clusterForCountry(clusters, "NL").id === "rest", "the Netherlands falls to the catch-all");
ok(
  clusterForCountry(clusters, "US").tiers.length === 2,
  "the catch-all ladder has TWO tiers: the Rest cluster has no 150 tier, so its meter shows two milestones and never an empty step",
);
ok(
  clusterForCountry(clusters, "ES").tiers.length === 3 &&
    clusterForCountry(clusters, "GB").tiers.length === 3,
  "Amphora and Active Ants both ship three tiers",
);

// --------------------------------------------------- 3. LOCAL AMOUNT RULES
// A country's own amounts win only when they are already denominated in the
// currency the shopper is charged in. Otherwise both engines fall back to the
// cluster's EUR ladder times the rate, which is what keeps a GBP shopper from
// being measured against a euro number.
{
  const withAmounts = structuredClone(settings);
  withAmounts.rewards.giftTiers.thresholdsByCountry = {
    GB: { amounts: [160, 210, 360], currencyCode: "GBP" },
  };
  const p2 = buildGiftPlan(withAmounts, {});
  const slice = giftPlanForCountry(p2, "GB");
  ok(
    slice.gb !== null && JSON.stringify(slice.gb.a) === JSON.stringify([160, 210, 360]),
    "plan: GB carries its own GBP amounts for the storefront to use verbatim",
  );
  ok(giftPlanForCountry(p2, "DE").gb === null, "plan: DE has no own amounts, so the EUR ladder converts at runtime");

  const fnWithAmounts = { ...fnConfig, bc: { GB: { a: [160, 210, 360], c: "GBP" } } };
  ok(
    JSON.stringify(giftAmounts(fnWithAmounts, "GB", "GBP", 1)) === JSON.stringify([160, 210, 360]),
    "function: GB in GBP uses its own amounts",
  );
  ok(
    JSON.stringify(giftAmounts(fnWithAmounts, "GB", "EUR", 1)) === JSON.stringify([150, 200, 350]),
    "function: the SAME country billed in EUR ignores its GBP amounts and uses the cluster ladder (currency mismatch)",
  );
  ok(
    JSON.stringify(giftAmounts(fnWithAmounts, "US", "USD", 2)) === JSON.stringify([400, 700]),
    "function: an unlisted country uses the catch-all ladder times the rate (200/350 EUR × 2)",
  );
}

// -------------------------------------------- 4. ROUNDING THE MERCHANT ASKED FOR
ok(roundThreshold(147) === 150, "147 rounds to 150, the example the merchant gave");
ok(roundThreshold(172.5) === 170, "a Finnish tier at +15% rounds to a clean 170");
ok(roundThreshold(176.25) === 180, "an Irish tier at +17.5% rounds to 180");
ok(roundThreshold(1123.65) === 1100, "a Danish tier rounds to the nearest 50");
ok(roundThreshold(286842) === 285000, "a Korean won tier rounds to the nearest 5,000 rather than the nearest 10");
ok(
  [1, 5, 19, 20, 99, 100, 999, 1000, 9999, 10000, 99999, 100000].every((v) => roundThreshold(v) > 0),
  "every magnitude band returns a usable amount",
);

// --------------------------------------------------- 5. RESOLUTION IS TOTAL
// The sanitizer promises exactly one catch-all. If that ever broke, a country
// could resolve to nothing and the feature would silently vanish for it.
{
  const noRest = sanitizeGiftClusters([
    { id: "a", name: "A", rest: false, countries: ["ES"], locations: [], tiers: [] },
  ]);
  ok(noRest.filter((c: { rest: boolean }) => c.rest).length === 1, "a config with no catch-all gets one promoted");
  ok(clusterForCountry(noRest, "ZZ") !== null, "so an unknown country still resolves");
  const twoRest = sanitizeGiftClusters([
    { id: "a", name: "A", rest: true, countries: [], locations: [], tiers: [] },
    { id: "b", name: "B", rest: true, countries: [], locations: [], tiers: [] },
  ]);
  ok(twoRest.filter((c: { rest: boolean }) => c.rest).length === 1, "a config with two catch-alls keeps only the first");
}

finish();
