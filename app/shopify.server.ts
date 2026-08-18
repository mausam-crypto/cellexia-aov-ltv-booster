// Load .env before anything reads process.env: production hosts running
// `npm start` via remix-serve do not load .env on their own (the Shopify CLI
// only does this in dev). dotenv never overrides already-set env vars, so
// platform-injected config (Render, Docker, etc.) always wins.
import "dotenv/config";
import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import prisma from "./db.server";
import { ResilientPrismaSessionStorage } from "./services/session-storage.server";
import { installProcessGuards } from "./process-guards.server";

// v15.4: the process must survive a database outage (see process-guards.server.ts).
installProcessGuards();

const shopify = shopifyApp({
  hooks: {
    // v8.23 (review catch): uninstalling destroys the AppInstallation and
    // with it BOTH config metafields, while ShopSettings deliberately
    // survives in the DB. Without this hook a REINSTALL leaves the
    // storefront dark (cfg nil in every Liquid gate) until someone
    // happens to press Save — now the mirrors resync on auth. Fully
    // guarded: an auth must never fail because a resync did.
    afterAuth: async ({ session, admin }) => {
      try {
        const [{ getSettings }, { syncSettingsToMetafields }] =
          await Promise.all([
            import("./models/settings.server"),
            import("./services/metafields.server"),
          ]);
        const settings = await getSettings(session.shop);
        await syncSettingsToMetafields(admin, settings);
      } catch (error) {
        console.error(
          "afterAuth metafield resync failed (storefront may need a manual Save):",
          error,
        );
      }
    },
  },
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October25,
  scopes: process.env.SCOPES?.split(","),
  // Render.com injects RENDER_EXTERNAL_URL — fall back to it so the app
  // boots with a correct URL even when SHOPIFY_APP_URL is not set.
  appUrl:
    process.env.SHOPIFY_APP_URL || process.env.RENDER_EXTERNAL_URL || "",
  authPathPrefix: "/auth",
  // v15.4: DB-outage-tolerant session storage (see services/session-storage.server.ts).
  sessionStorage: new ResilientPrismaSessionStorage(prisma),
  // Cellexia runs this as a custom app on its own Plus store. Switch to
  // AppDistribution.AppStore if it is ever listed publicly.
  distribution: AppDistribution.SingleMerchant,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
