import crypto from "node:crypto";
import prisma from "../db.server";
import {
  DELIVERY_ESTIMATE_FORMATS,
  DERM_SURVEY_FORMATS,
  type BoosterSettings,
} from "../models/settings.server";

/**
 * Mirrors the settings blob to the two places extensions read it from:
 *
 *  - App-data metafield (owner: AppInstallation, namespace "cellexia",
 *    key "config"): the theme app extension reads it in Liquid via
 *    {{ app.metafields.cellexia.config.value }} — no scopes required.
 *
 *  - Shop metafield (owner: Shop, namespace "$app:cellexia", key "config"):
 *    the checkout UI extensions declare it in shopify.extension.toml and
 *    read it with useAppMetafields().
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

const OWNER_IDS_QUERY = `#graphql
  query cellexiaOwnerIds {
    currentAppInstallation {
      id
    }
    shop {
      id
      myshopifyDomain
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation cellexiaSetConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Preview payload split (SPEC v4): the app-data metafield feeds page-visible
 * Liquid and must NEVER carry the preview token (raw or hashed); the shop
 * metafield is only reachable by our checkout extensions and carries the
 * sha256 HASH of the token (`tokenHash`) so checkout can validate the
 * `_cx_preview` cart attribute (extensions compare sha256(attribute) ===
 * tokenHash) — the raw token never ships to a buyer's checkout session.
 */
export interface PreviewSyncPayload {
  armed: boolean;
  draftFlags: Record<string, boolean>;
  /**
   * Draft, preview-session-only config overrides (v5.8) — the derm-survey
   * display format plus the three per-surface delivery-estimate formats
   * (`deliveryFormat` / `deliveryFormatCart` / `deliveryFormatCheckout`,
   * v6.0). Tokenless by construction (closed-enum values only), so it is
   * safe for the page-visible app-data metafield AND the checkout shop
   * metafield while the preview is armed.
   */
  draftConfig: Record<string, string>;
  /**
   * RAW preview token (input only) — hashed at write time; only its sha256
   * hex digest is ever written, and only to the shop metafield.
   */
  token: string;
}

/** sha256 hex digest of the raw preview token (checkout-side comparator). */
function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Loads the current preview state for a shop so that EVERY settings sync
 * preserves an armed preview (feature pages, experiments etc. call
 * syncSettingsToMetafields without a preview argument — omitting this lookup
 * would silently disarm the storefront side of an armed preview).
 */
async function loadPreviewPayload(shop: string): Promise<PreviewSyncPayload> {
  try {
    const row = await prisma.previewState.findUnique({ where: { shop } });
    if (!row) return { armed: false, draftFlags: {}, draftConfig: {}, token: "" };
    let draftFlags: Record<string, boolean> = {};
    try {
      const parsed = JSON.parse(row.draftFlags);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "boolean") draftFlags[key] = value;
        }
      }
    } catch {
      draftFlags = {};
    }
    // Mirrors preview.server's sanitizeDraftConfig (not imported — that
    // module imports this one, so the tiny validation is duplicated here to
    // avoid a cycle): only known keys with closed-enum values survive.
    let draftConfig: Record<string, string> = {};
    try {
      const parsed = JSON.parse(row.draftConfig);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const format = (parsed as Record<string, unknown>).dermSurveyFormat;
        if (
          typeof format === "string" &&
          (DERM_SURVEY_FORMATS as readonly string[]).includes(format)
        ) {
          draftConfig.dermSurveyFormat = format;
        }
        const deliveryFormat = (parsed as Record<string, unknown>)
          .deliveryFormat;
        if (
          typeof deliveryFormat === "string" &&
          (DELIVERY_ESTIMATE_FORMATS as readonly string[]).includes(
            deliveryFormat,
          )
        ) {
          draftConfig.deliveryFormat = deliveryFormat;
        }
        const deliveryFormatCart = (parsed as Record<string, unknown>)
          .deliveryFormatCart;
        if (
          typeof deliveryFormatCart === "string" &&
          (DELIVERY_ESTIMATE_FORMATS as readonly string[]).includes(
            deliveryFormatCart,
          )
        ) {
          draftConfig.deliveryFormatCart = deliveryFormatCart;
        }
        const deliveryFormatCheckout = (parsed as Record<string, unknown>)
          .deliveryFormatCheckout;
        if (
          typeof deliveryFormatCheckout === "string" &&
          (DELIVERY_ESTIMATE_FORMATS as readonly string[]).includes(
            deliveryFormatCheckout,
          )
        ) {
          draftConfig.deliveryFormatCheckout = deliveryFormatCheckout;
        }
      }
    } catch {
      draftConfig = {};
    }
    return { armed: row.armed, draftFlags, draftConfig, token: row.token };
  } catch {
    return { armed: false, draftFlags: {}, draftConfig: {}, token: "" };
  }
}

export async function syncSettingsToMetafields(
  admin: AdminGraphqlClient,
  settings: BoosterSettings,
  preview?: PreviewSyncPayload,
): Promise<{ ok: boolean; errors: string[] }> {
  const ownerResponse = await admin.graphql(OWNER_IDS_QUERY);
  const ownerJson = (await ownerResponse.json()) as {
    data?: {
      currentAppInstallation?: { id: string };
      shop?: { id: string; myshopifyDomain?: string };
    };
  };

  const appInstallationId = ownerJson.data?.currentAppInstallation?.id;
  const shopId = ownerJson.data?.shop?.id;
  if (!appInstallationId || !shopId) {
    return { ok: false, errors: ["Could not resolve metafield owner ids"] };
  }

  const shopDomain = ownerJson.data?.shop?.myshopifyDomain ?? "";
  const effectivePreview =
    preview ??
    (shopDomain
      ? await loadPreviewPayload(shopDomain)
      : { armed: false, draftFlags: {}, draftConfig: {}, token: "" });

  // Defense in depth: a disarmed preview never ships draft flags (or draft
  // config overrides) anywhere.
  const draftFlags = effectivePreview.armed ? effectivePreview.draftFlags : {};
  const draftConfig = effectivePreview.armed
    ? effectivePreview.draftConfig
    : {};
  const liquidValue = JSON.stringify({
    ...settings,
    preview: { armed: effectivePreview.armed, draftFlags, draftConfig },
  });
  // draftConfig is tokenless by construction (closed-enum values only —
  // validated in loadPreviewPayload / preview.server's sanitizeDraftConfig),
  // so it is safe to mirror into BOTH payloads: the checkout extension needs
  // it (v6.0) to honor a previewed delivery format, exactly like Liquid does.
  const checkoutValue = JSON.stringify({
    ...settings,
    preview: {
      armed: effectivePreview.armed,
      draftFlags,
      draftConfig,
      tokenHash:
        effectivePreview.armed && effectivePreview.token
          ? sha256Hex(effectivePreview.token)
          : "",
    },
  });

  const response = await admin.graphql(METAFIELDS_SET_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId: appInstallationId,
          namespace: "cellexia",
          key: "config",
          type: "json",
          value: liquidValue,
        },
        {
          ownerId: shopId,
          namespace: "$app:cellexia",
          key: "config",
          type: "json",
          value: checkoutValue,
        },
      ],
    },
  });

  const json = (await response.json()) as {
    data?: {
      metafieldsSet?: {
        userErrors?: { field?: string[] | null; message: string }[];
      };
    };
  };
  const errors = (json.data?.metafieldsSet?.userErrors ?? []).map(
    (e) => e.message,
  );
  return { ok: errors.length === 0, errors };
}
