interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export interface VariantSummary {
  id: string;
  title: string;
  price: string;
  currencyCode?: string;
  productTitle: string;
  /** Product URL handle — stored alongside the variant GID by the cart
   *  cross-sell picker so Liquid can render live product data. */
  productHandle: string;
  imageUrl: string | null;
  availableForSale?: boolean;
}

const PROTECTION_HANDLE = "cellexia-order-protection";

const FIND_PROTECTION_QUERY = `#graphql
  query cellexiaFindProtection($query: String!) {
    products(first: 1, query: $query) {
      nodes {
        id
        title
        handle
        status
        variants(first: 1) {
          nodes {
            id
            price
          }
        }
      }
    }
  }
`;

const CREATE_PROTECTION_MUTATION = `#graphql
  mutation cellexiaCreateProtection($input: ProductSetInput!) {
    productSet(synchronous: true, input: $input) {
      product {
        id
        handle
        variants(first: 1) {
          nodes {
            id
            price
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PUBLICATIONS_QUERY = `#graphql
  query cellexiaPublications {
    publications(first: 20) {
      nodes {
        id
        name
      }
    }
  }
`;

const PUBLISH_PRODUCT_MUTATION = `#graphql
  mutation cellexiaPublishProtection($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Publishes the product to the Online Store publication so the checkout
 * protection extension can add it as a cart line (products created via the
 * Admin GraphQL API start unpublished). Returns publish userError messages.
 */
async function publishToOnlineStore(
  admin: AdminGraphqlClient,
  productId: string,
): Promise<string[]> {
  const publicationsResponse = await admin.graphql(PUBLICATIONS_QUERY);
  const publicationsJson = (await publicationsResponse.json()) as {
    data?: {
      publications?: { nodes?: { id: string; name: string }[] };
    };
  };
  const publications = publicationsJson.data?.publications?.nodes ?? [];
  const onlineStore =
    publications.find(
      (publication) => publication.name.toLowerCase() === "online store",
    ) ?? publications[0];
  if (!onlineStore) {
    return [
      "No sales channel found to publish the Order Protection product to.",
    ];
  }
  const publishResponse = await admin.graphql(PUBLISH_PRODUCT_MUTATION, {
    variables: {
      id: productId,
      input: [{ publicationId: onlineStore.id }],
    },
  });
  const publishJson = (await publishResponse.json()) as {
    data?: {
      publishablePublish?: {
        userErrors?: { message: string }[];
      };
    };
  };
  return (publishJson.data?.publishablePublish?.userErrors ?? []).map(
    (e) => e.message,
  );
}

/**
 * Finds (or creates) the hidden "Order Protection" product used by the
 * in-checkout purchase protection extension, and returns its variant GID.
 * The product is published to the Online Store publication in both cases —
 * checkout can only add variants that are available on the storefront.
 */
export async function ensureProtectionProduct(
  admin: AdminGraphqlClient,
  price: string,
): Promise<{ variantId: string | null; created: boolean; errors: string[] }> {
  const findResponse = await admin.graphql(FIND_PROTECTION_QUERY, {
    variables: { query: `handle:${PROTECTION_HANDLE}` },
  });
  const findJson = (await findResponse.json()) as {
    data?: {
      products?: {
        nodes?: {
          id: string;
          status: string;
          variants: { nodes: { id: string; price: string }[] };
        }[];
      };
    };
  };
  const existing = findJson.data?.products?.nodes?.[0];
  if (existing?.variants?.nodes?.[0]?.id) {
    if (existing.status !== "ACTIVE") {
      return {
        variantId: null,
        created: false,
        errors: [
          `An "Order Protection" product already exists but its status is ${existing.status}, so checkout cannot sell it. Set the product to Active in your Shopify admin, then try again.`,
        ],
      };
    }
    const publishErrors = await publishToOnlineStore(admin, existing.id);
    return {
      variantId: existing.variants.nodes[0].id,
      created: false,
      errors: publishErrors,
    };
  }

  const createResponse = await admin.graphql(CREATE_PROTECTION_MUTATION, {
    variables: {
      input: {
        title: "Order Protection",
        handle: PROTECTION_HANDLE,
        status: "ACTIVE",
        productType: "Order Protection",
        vendor: "Cellexia",
        tags: ["cellexia-app", "cellexia-order-protection"],
        descriptionHtml:
          "<p>Protects your order against loss, theft and damage in transit. Added at checkout.</p>",
        productOptions: [
          { name: "Title", position: 1, values: [{ name: "Default Title" }] },
        ],
        variants: [
          {
            optionValues: [{ optionName: "Title", name: "Default Title" }],
            price,
            taxable: false,
            inventoryPolicy: "CONTINUE",
          },
        ],
      },
    },
  });
  const createJson = (await createResponse.json()) as {
    data?: {
      productSet?: {
        product?: {
          id: string;
          variants: { nodes: { id: string }[] };
        } | null;
        userErrors?: { message: string }[];
      };
    };
  };
  const errors = (createJson.data?.productSet?.userErrors ?? []).map(
    (e) => e.message,
  );
  const product = createJson.data?.productSet?.product ?? null;
  const variantId = product?.variants?.nodes?.[0]?.id ?? null;
  if (product?.id) {
    errors.push(...(await publishToOnlineStore(admin, product.id)));
  }
  return { variantId, created: Boolean(variantId), errors };
}

const SEARCH_PRODUCTS_QUERY = `#graphql
  query cellexiaSearchProducts($query: String!) {
    products(first: 10, query: $query) {
      nodes {
        title
        handle
        featuredImage {
          url
        }
        variants(first: 10) {
          nodes {
            id
            title
            price
            availableForSale
            image {
              url
            }
          }
        }
      }
    }
  }
`;

/** Variant search backing the upsell product pickers in the dashboard.
 *  Searches by PRODUCT title (variant titles are just "1 unit"/"2 units"
 *  style option labels) and flattens each product's variants. */
export async function searchVariants(
  admin: AdminGraphqlClient,
  search: string,
): Promise<VariantSummary[]> {
  const cleaned = search.replace(/["\\]/g, "").trim();
  const query =
    cleaned === ""
      ? ""
      : /\s/.test(cleaned)
        ? `title:"${cleaned}"`
        : `title:*${cleaned}*`;
  const response = await admin.graphql(SEARCH_PRODUCTS_QUERY, {
    variables: { query },
  });
  const json = (await response.json()) as {
    data?: {
      products?: {
        nodes?: {
          title: string;
          handle: string;
          featuredImage: { url: string } | null;
          variants: {
            nodes: {
              id: string;
              title: string;
              price: string;
              availableForSale: boolean;
              image: { url: string } | null;
            }[];
          };
        }[];
      };
    };
  };
  return (json.data?.products?.nodes ?? []).flatMap((product) =>
    (product.variants?.nodes ?? []).map((variant) => ({
      id: variant.id,
      title: variant.title,
      price: variant.price,
      productTitle: product.title,
      productHandle: product.handle,
      imageUrl: variant.image?.url ?? product.featuredImage?.url ?? null,
      availableForSale: variant.availableForSale,
    })),
  );
}

const VARIANTS_BY_ID_QUERY = `#graphql
  query cellexiaVariantsById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        price
        availableForSale
        image {
          url
        }
        product {
          title
          handle
          featuredImage {
            url
          }
        }
      }
    }
  }
`;

export async function getVariantsByIds(
  admin: AdminGraphqlClient,
  ids: string[],
): Promise<VariantSummary[]> {
  if (ids.length === 0) return [];
  const response = await admin.graphql(VARIANTS_BY_ID_QUERY, {
    variables: { ids },
  });
  const json = (await response.json()) as {
    data?: {
      nodes?: ({
        id: string;
        title: string;
        price: string;
        availableForSale: boolean;
        image: { url: string } | null;
        product: {
          title: string;
          handle: string;
          featuredImage: { url: string } | null;
        };
      } | null)[];
    };
  };
  return (json.data?.nodes ?? [])
    .filter((node): node is NonNullable<typeof node> => Boolean(node?.id))
    .map((node) => ({
      id: node.id,
      title: node.title,
      price: node.price,
      productTitle: node.product.title,
      productHandle: node.product.handle,
      imageUrl: node.image?.url ?? node.product.featuredImage?.url ?? null,
      availableForSale: node.availableForSale,
    }));
}
