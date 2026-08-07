/**
 * v8.13: per-language product DISPLAY NAMES for the widgets that speak the
 * product's name in a sentence — the dermatologist survey ("92% … would
 * recommend {name}") and the clinical study ("Tested on {name} itself").
 *
 * Why: those sentences interpolate the product title in Liquid, so a
 * localized page serves whatever title translation exists — often the
 * English title (untranslated) or a marketing title that reads wrong
 * mid-sentence. The merchant needs EXACT control per language.
 *
 * How: a translatable product metafield (cellexia.display_name — defined
 * in ensurePdpDefinitions). The BASE value rides metafieldsSet; each
 * language's value is registered as a NATIVE Shopify translation on the
 * metafield (translationsRegister with the source digest — the v6.4
 * bestseller-category machinery), so localized storefront pages serve the
 * right name with zero runtime cost. Liquid falls back to product.title
 * when unset. NAMES ARE NEVER MACHINE-TRANSLATED — this surface is
 * manual-entry only, and the DeepL metafield allowlist
 * (collectAllowedMetafieldGids) deliberately excludes display_name.
 */

import { aliasForLocale } from "./translation.server";

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

async function gql<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: T; errors?: string[] }> {
  try {
    const response = await admin.graphql(
      query,
      variables ? { variables } : undefined,
    );
    const json = (await response.json()) as {
      data?: T;
      errors?: { message: string }[];
    };
    return {
      data: json.data,
      errors: json.errors?.map((e) => e.message),
    };
  } catch (error) {
    return {
      errors: [error instanceof Error ? error.message : "GraphQL request failed"],
    };
  }
}

const NAME_PATTERN = /^[a-zA-Z0-9-]+$/;

const PRODUCT_NAME_QUERY = `#graphql
  query cellexiaProductName($id: ID!) {
    product(id: $id) {
      id
      title
      metafield(namespace: "cellexia", key: "display_name") {
        id
        value
      }
    }
  }
`;

const METAFIELD_TRANSLATABLE_QUERY = (locales: string[]) => {
  const aliases = locales
    .filter((locale) => NAME_PATTERN.test(locale))
    .map(
      (locale) =>
        `${aliasForLocale(locale)}: translations(locale: "${locale}") { key value }`,
    )
    .join("\n        ");
  return `#graphql
  query cellexiaNameTranslatable($ids: [ID!]!) {
    translatableResourcesByIds(first: 1, resourceIds: $ids) {
      nodes {
        resourceId
        translatableContent { key value digest locale }
        ${aliases}
      }
    }
  }
`;
};

export interface ProductNameState {
  ok: boolean;
  errors: string[];
  productGid: string;
  title: string;
  /** The base (primary-language) display name; "" = falls back to title. */
  baseName: string;
  metafieldGid: string | null;
  /** Per-locale registered display names (lowercase locale keys). */
  perLocale: Record<string, string>;
}

export async function getProductDisplayName(
  admin: AdminGraphqlClient,
  productGid: string,
  locales: string[],
): Promise<ProductNameState> {
  const state: ProductNameState = {
    ok: false,
    errors: [],
    productGid,
    title: "",
    baseName: "",
    metafieldGid: null,
    perLocale: {},
  };
  const product = await gql<{
    product: {
      id: string;
      title: string;
      metafield: { id: string; value: string } | null;
    } | null;
  }>(admin, PRODUCT_NAME_QUERY, { id: productGid });
  if (product.errors?.length || !product.data?.product) {
    state.errors = product.errors ?? ["Product not found"];
    return state;
  }
  state.title = product.data.product.title;
  state.baseName = product.data.product.metafield?.value ?? "";
  state.metafieldGid = product.data.product.metafield?.id ?? null;
  if (state.metafieldGid) {
    const translatable = await gql<{
      translatableResourcesByIds: {
        nodes: ({
          resourceId: string;
          translatableContent: { key: string; digest: string | null }[];
        } & Record<string, { key: string; value: string }[] | unknown>)[];
      } | null;
    }>(admin, METAFIELD_TRANSLATABLE_QUERY(locales), {
      ids: [state.metafieldGid],
    });
    // A failed/empty translations read must NOT report ok — the route would
    // hydrate every locale field as blank and a later save would then
    // translationsRemove real translations (review v8.13 F0: silent data
    // loss from a transient throttle).
    if (translatable.errors?.length) {
      state.errors = translatable.errors;
      return state;
    }
    const node = translatable.data?.translatableResourcesByIds?.nodes?.[0];
    if (!node) {
      state.errors = ["Could not read the name translations — try again."];
      return state;
    }
    {
      for (const locale of locales) {
        const rows = node[aliasForLocale(locale)];
        if (Array.isArray(rows)) {
          const valueRow = (rows as { key: string; value: string }[]).find(
            (row) => row.key === "value",
          );
          if (valueRow?.value) {
            state.perLocale[locale.toLowerCase()] = valueRow.value;
          }
        }
      }
    }
  }
  state.ok = true;
  return state;
}

const METAFIELDS_SET_MUTATION = `#graphql
  mutation cellexiaSetDisplayName($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

const METAFIELD_DELETE_MUTATION = `#graphql
  mutation cellexiaDeleteDisplayName($input: MetafieldIdentifierInput!) {
    metafieldsDelete(metafields: [$input]) {
      userErrors { field message }
    }
  }
`;

const DIGEST_QUERY = `#graphql
  query cellexiaNameDigest($ids: [ID!]!) {
    translatableResourcesByIds(first: 1, resourceIds: $ids) {
      nodes {
        resourceId
        translatableContent { key digest }
      }
    }
  }
`;

const REGISTER_MUTATION = `#graphql
  mutation cellexiaRegisterNames($id: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $id, translations: $translations) {
      userErrors { field message }
    }
  }
`;

const REMOVE_MUTATION = `#graphql
  mutation cellexiaRemoveNames($id: ID!, $locales: [String!]!) {
    translationsRemove(resourceId: $id, locales: $locales, translationKeys: ["value"]) {
      userErrors { field message }
    }
  }
`;

export interface SaveProductNamesResult {
  ok: boolean;
  errors: string[];
}

/**
 * Save the base name (blank = remove the metafield, widgets fall back to
 * the product title) and register/remove one native translation per
 * locale. Blank locale values REMOVE that locale's translation, so the
 * localized page falls back to the base name (or title).
 */
export async function saveProductDisplayName(
  admin: AdminGraphqlClient,
  productGid: string,
  baseName: string,
  perLocale: Record<string, string>,
): Promise<SaveProductNamesResult> {
  const errors: string[] = [];
  const base = baseName.trim().slice(0, 255);

  if (base === "") {
    // A blank base with typed per-language names would silently drop those
    // names (the delete path never reads perLocale) while toasting success
    // (review v8.13 F1) — refuse instead; the route shows the error banner.
    const typedLocales = Object.entries(perLocale)
      .filter(([, value]) => value.trim() !== "")
      .map(([locale]) => locale);
    if (typedLocales.length > 0) {
      return {
        ok: false,
        errors: [
          `Per-language names need a base name. Enter a base name (the product title is a good default), or clear the ${typedLocales.join(", ")} field(s) if you meant to remove everything.`,
        ],
      };
    }
    // No base name: clear everything (translations die with the metafield).
    const del = await gql<{
      metafieldsDelete: { userErrors: { message: string }[] } | null;
    }>(admin, METAFIELD_DELETE_MUTATION, {
      input: {
        ownerId: productGid,
        namespace: "cellexia",
        key: "display_name",
      },
    });
    errors.push(
      ...(del.errors ?? []),
      ...(del.data?.metafieldsDelete?.userErrors ?? []).map((e) => e.message),
    );
    return { ok: errors.length === 0, errors };
  }

  const set = await gql<{
    metafieldsSet: {
      metafields: { id: string }[] | null;
      userErrors: { message: string }[];
    } | null;
  }>(admin, METAFIELDS_SET_MUTATION, {
    metafields: [
      {
        ownerId: productGid,
        namespace: "cellexia",
        key: "display_name",
        type: "single_line_text_field",
        value: base,
      },
    ],
  });
  errors.push(
    ...(set.errors ?? []),
    ...(set.data?.metafieldsSet?.userErrors ?? []).map((e) => e.message),
  );
  const metafieldGid = set.data?.metafieldsSet?.metafields?.[0]?.id ?? null;
  if (!metafieldGid || errors.length > 0) {
    return { ok: false, errors: errors.length ? errors : ["Could not save the base name"] };
  }

  // Digest of the just-saved source value — required by translationsRegister.
  const digestResult = await gql<{
    translatableResourcesByIds: {
      nodes: {
        translatableContent: { key: string; digest: string | null }[];
      }[];
    } | null;
  }>(admin, DIGEST_QUERY, { ids: [metafieldGid] });
  const digest = digestResult.data?.translatableResourcesByIds?.nodes?.[0]?.translatableContent?.find(
    (row) => row.key === "value",
  )?.digest;
  if (!digest) {
    return {
      ok: false,
      errors: ["Could not read the translation digest — the base name saved, re-open and try the languages again."],
    };
  }

  const registers = Object.entries(perLocale)
    .filter(([, value]) => value.trim() !== "")
    .map(([locale, value]) => ({
      locale,
      key: "value",
      value: value.trim().slice(0, 255),
      translatableContentDigest: digest,
    }));
  if (registers.length > 0) {
    const reg = await gql<{
      translationsRegister: { userErrors: { message: string }[] } | null;
    }>(admin, REGISTER_MUTATION, {
      id: metafieldGid,
      translations: registers,
    });
    errors.push(
      ...(reg.errors ?? []),
      ...(reg.data?.translationsRegister?.userErrors ?? []).map((e) => e.message),
    );
  }
  const removals = Object.entries(perLocale)
    .filter(([, value]) => value.trim() === "")
    .map(([locale]) => locale);
  if (removals.length > 0) {
    const rem = await gql<{
      translationsRemove: { userErrors: { message: string }[] } | null;
    }>(admin, REMOVE_MUTATION, { id: metafieldGid, locales: removals });
    errors.push(
      ...(rem.errors ?? []),
      ...(rem.data?.translationsRemove?.userErrors ?? []).map((e) => e.message),
    );
  }
  return { ok: errors.length === 0, errors };
}
