/**
 * Metaobject foundation for the PDP trust boosters (SPEC v3).
 *
 * Owns three concerns:
 *
 *  1. ensurePdpDefinitions — idempotently creates the eight Cellexia
 *     metaobject definitions (translatable + publishable, storefront
 *     PUBLIC_READ) and the six PRODUCT metafield definitions in the
 *     "cellexia" namespace. Safe to call from any loader on every request;
 *     it only issues create mutations for definitions that are missing, and
 *     (v7) backfills fields that later versions added to a definition via
 *     ensureDefinitionFields (create never migrates on its own).
 *
 *  2. Generic metaobject CRUD wrappers (createMetaobject / updateMetaobject /
 *     deleteMetaobject) used by pdp-content.server.ts. Field values are always
 *     strings: reference values are GID strings, list references are
 *     JSON-encoded arrays of GIDs, dates are "YYYY-MM-DD", numbers are their
 *     decimal string representation.
 *
 *  3. stagedImageUpload — staged upload pipeline for booster imagery and CoA
 *     PDFs: stagedUploadsCreate -> multipart POST to the staged target ->
 *     fileCreate -> poll fileStatus until READY.
 *
 * Every function resolves with { ok, errors, ... } and never throws on
 * GraphQL userErrors (network/parse failures are also converted to errors).
 */

export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export interface MetaobjectFieldInput {
  key: string;
  value: string;
}

/** Namespace shared by the PDP booster product metafields. */
export const CELLEXIA_NAMESPACE = "cellexia";

/** FROZEN metaobject type names — Liquid reads them literally (SPEC v3). */
export const PDP_METAOBJECT_TYPES = {
  studyResult: "cellexia_study_result",
  clinicalStudy: "cellexia_clinical_study",
  beforeAfter: "cellexia_before_after",
  ingredient: "cellexia_ingredient",
  coa: "cellexia_coa",
  batchTransparency: "cellexia_batch_transparency",
  surveyOutcome: "cellexia_survey_outcome",
  productSurvey: "cellexia_product_survey",
} as const;

/** FROZEN product metafield keys in the "cellexia" namespace (SPEC v3).
 *  bestseller_category (v6.4): the az bestseller badge category lives in its
 *  own single_line_text_field metafield — a TRANSLATABLE Shopify resource,
 *  unlike the pdp_flags JSON blob — so storefront Liquid serves it localized
 *  automatically and the v5.2 DeepL pipeline can register translations.
 *  product_survey (v7): per-product dermatologist survey content — its
 *  presence IS the per-product switch (no metafield = survey hidden). */
export const PDP_METAFIELD_KEYS = {
  clinicalStudy: "clinical_study",
  beforeAfters: "before_afters",
  batchTransparency: "batch_transparency",
  pdpFlags: "pdp_flags",
  bestsellerCategory: "bestseller_category",
  productSurvey: "product_survey",
} as const;

// ---------------------------------------------------------------------------
// Shared GraphQL plumbing
// ---------------------------------------------------------------------------

/**
 * Executes an Admin GraphQL request and normalises the outcome to
 * { data, errors }. Top-level GraphQL errors and thrown transport errors both
 * land in `errors` so callers never need try/catch.
 */
export async function adminRequest<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data: T | null; errors: string[] }> {
  try {
    const response = await admin.graphql(
      query,
      variables ? { variables } : undefined,
    );
    const json = (await response.json()) as {
      data?: T;
      errors?: { message?: string }[];
    };
    const errors = (json.errors ?? []).map(
      (error) => error.message ?? "Unknown GraphQL error",
    );
    return { data: json.data ?? null, errors };
  } catch (error) {
    return {
      data: null,
      errors: [
        error instanceof Error ? error.message : "Admin GraphQL request failed",
      ],
    };
  }
}

interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

function messages(errors: UserError[] | undefined): string[] {
  return (errors ?? []).map((error) => error.message);
}

// ---------------------------------------------------------------------------
// ensurePdpDefinitions
// ---------------------------------------------------------------------------

const PDP_DEFINITION_LOOKUP_QUERY = `#graphql
  query cellexiaPdpDefinitionLookup {
    studyResult: metaobjectDefinitionByType(type: "cellexia_study_result") { id }
    ingredient: metaobjectDefinitionByType(type: "cellexia_ingredient") { id }
    coa: metaobjectDefinitionByType(type: "cellexia_coa") { id }
    clinicalStudy: metaobjectDefinitionByType(type: "cellexia_clinical_study") { id }
    beforeAfter: metaobjectDefinitionByType(type: "cellexia_before_after") { id }
    batchTransparency: metaobjectDefinitionByType(type: "cellexia_batch_transparency") { id }
    surveyOutcome: metaobjectDefinitionByType(type: "cellexia_survey_outcome") { id }
    productSurvey: metaobjectDefinitionByType(type: "cellexia_product_survey") { id }
    metafieldDefinitions(first: 20, ownerType: PRODUCT, namespace: "cellexia") {
      nodes { id key }
    }
  }
`;

const METAOBJECT_DEFINITION_BY_TYPE_QUERY = `#graphql
  query cellexiaMetaobjectDefinitionByType($type: String!) {
    metaobjectDefinitionByType(type: $type) { id }
  }
`;

const METAOBJECT_DEFINITION_CREATE_MUTATION = `#graphql
  mutation cellexiaMetaobjectDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition { id type }
      userErrors { field message code }
    }
  }
`;

const METAFIELD_DEFINITION_CREATE_MUTATION = `#graphql
  mutation cellexiaMetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }
`;

interface DefinitionIdNode {
  id: string;
}

interface PdpDefinitionLookupData {
  studyResult: DefinitionIdNode | null;
  ingredient: DefinitionIdNode | null;
  coa: DefinitionIdNode | null;
  clinicalStudy: DefinitionIdNode | null;
  beforeAfter: DefinitionIdNode | null;
  batchTransparency: DefinitionIdNode | null;
  surveyOutcome: DefinitionIdNode | null;
  productSurvey: DefinitionIdNode | null;
  metafieldDefinitions: { nodes: { id: string; key: string }[] } | null;
}

interface MetaobjectDefinitionCreateData {
  metaobjectDefinitionCreate: {
    metaobjectDefinition: { id: string; type: string } | null;
    userErrors: UserError[];
  } | null;
}

interface MetafieldDefinitionCreateData {
  metafieldDefinitionCreate: {
    createdDefinition: { id: string } | null;
    userErrors: UserError[];
  } | null;
}

const METAOBJECT_DEFINITION_FIELDS_QUERY = `#graphql
  query cellexiaMetaobjectDefinitionFields($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id
      fieldDefinitions { key }
    }
  }
`;

const METAOBJECT_DEFINITION_UPDATE_MUTATION = `#graphql
  mutation cellexiaMetaobjectDefinitionUpdate($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
    metaobjectDefinitionUpdate(id: $id, definition: $definition) {
      metaobjectDefinition { id }
      userErrors { field message code }
    }
  }
`;

interface MetaobjectDefinitionFieldsData {
  metaobjectDefinitionByType: {
    id: string;
    fieldDefinitions: { key: string }[];
  } | null;
}

interface MetaobjectDefinitionUpdateData {
  metaobjectDefinitionUpdate: {
    metaobjectDefinition: { id: string } | null;
    userErrors: UserError[];
  } | null;
}

/** Every text field translatable in Translate & Adapt; entries publishable. */
const DEFINITION_CAPABILITIES = {
  translatable: { enabled: true },
  publishable: { enabled: true },
};

/** Liquid on the storefront must be able to read the metaobjects. */
const DEFINITION_ACCESS = { storefront: "PUBLIC_READ" };

interface FieldDefinitionInput {
  key: string;
  name: string;
  type: string;
  validations?: { name: string; value: string }[];
}

function field(key: string, name: string, type: string): FieldDefinitionInput {
  return { key, name, type };
}

function listReferenceField(
  key: string,
  name: string,
  referencedDefinitionId: string,
): FieldDefinitionInput {
  return {
    key,
    name,
    type: "list.metaobject_reference",
    validations: [
      { name: "metaobject_definition_id", value: referencedDefinitionId },
    ],
  };
}

export interface EnsurePdpDefinitionsResult {
  ok: boolean;
  errors: string[];
  /** Definition types / metafield keys created by THIS call. */
  created: string[];
  /** Metaobject definition GIDs by type name (null when unresolved). */
  definitionIds: Record<string, string | null>;
}

/**
 * Idempotently creates the eight PDP metaobject definitions plus the six
 * PRODUCT metafield definitions. Leaf definitions (study result, ingredient,
 * CoA, survey outcome) are created before the parents whose
 * list.metaobject_reference fields validate against their definition ids.
 * Losing a creation race to a concurrent call is handled by re-querying the
 * definition by type. v7: fields added to a definition after shops were
 * provisioned (clinical study `subject`) are backfilled for existing
 * definitions via ensureDefinitionFields.
 */
export async function ensurePdpDefinitions(
  admin: AdminGraphqlClient,
): Promise<EnsurePdpDefinitionsResult> {
  const errors: string[] = [];
  const created: string[] = [];
  const definitionIds: Record<string, string | null> = {
    [PDP_METAOBJECT_TYPES.studyResult]: null,
    [PDP_METAOBJECT_TYPES.ingredient]: null,
    [PDP_METAOBJECT_TYPES.coa]: null,
    [PDP_METAOBJECT_TYPES.clinicalStudy]: null,
    [PDP_METAOBJECT_TYPES.beforeAfter]: null,
    [PDP_METAOBJECT_TYPES.batchTransparency]: null,
    [PDP_METAOBJECT_TYPES.surveyOutcome]: null,
    [PDP_METAOBJECT_TYPES.productSurvey]: null,
  };

  const lookup = await adminRequest<PdpDefinitionLookupData>(
    admin,
    PDP_DEFINITION_LOOKUP_QUERY,
  );
  if (!lookup.data) {
    return {
      ok: false,
      errors: lookup.errors.length
        ? lookup.errors
        : ["Could not query existing metaobject definitions"],
      created,
      definitionIds,
    };
  }
  definitionIds[PDP_METAOBJECT_TYPES.studyResult] =
    lookup.data.studyResult?.id ?? null;
  definitionIds[PDP_METAOBJECT_TYPES.ingredient] =
    lookup.data.ingredient?.id ?? null;
  definitionIds[PDP_METAOBJECT_TYPES.coa] = lookup.data.coa?.id ?? null;
  definitionIds[PDP_METAOBJECT_TYPES.clinicalStudy] =
    lookup.data.clinicalStudy?.id ?? null;
  definitionIds[PDP_METAOBJECT_TYPES.beforeAfter] =
    lookup.data.beforeAfter?.id ?? null;
  definitionIds[PDP_METAOBJECT_TYPES.batchTransparency] =
    lookup.data.batchTransparency?.id ?? null;
  definitionIds[PDP_METAOBJECT_TYPES.surveyOutcome] =
    lookup.data.surveyOutcome?.id ?? null;
  definitionIds[PDP_METAOBJECT_TYPES.productSurvey] =
    lookup.data.productSurvey?.id ?? null;

  const ensureDefinition = async (
    type: string,
    definition: Record<string, unknown>,
  ): Promise<string | null> => {
    const known = definitionIds[type];
    if (known) return known;
    const result = await adminRequest<MetaobjectDefinitionCreateData>(
      admin,
      METAOBJECT_DEFINITION_CREATE_MUTATION,
      { definition },
    );
    const createdDefinition =
      result.data?.metaobjectDefinitionCreate?.metaobjectDefinition ?? null;
    if (createdDefinition?.id) {
      created.push(type);
      definitionIds[type] = createdDefinition.id;
      return createdDefinition.id;
    }
    // Creation refused — most likely another concurrent ensure call created
    // the definition first ("taken"). Re-query before treating it as failure.
    const requery = await adminRequest<{
      metaobjectDefinitionByType: DefinitionIdNode | null;
    }>(admin, METAOBJECT_DEFINITION_BY_TYPE_QUERY, { type });
    const existingId = requery.data?.metaobjectDefinitionByType?.id ?? null;
    if (existingId) {
      definitionIds[type] = existingId;
      return existingId;
    }
    const userErrors = result.data?.metaobjectDefinitionCreate?.userErrors;
    errors.push(
      ...messages(userErrors).map((message) => `${type}: ${message}`),
      ...result.errors.map((message) => `${type}: ${message}`),
    );
    return null;
  };

  // 1. Leaf definitions (their ids feed the parents' reference validations).
  const studyResultId = await ensureDefinition(
    PDP_METAOBJECT_TYPES.studyResult,
    {
      type: PDP_METAOBJECT_TYPES.studyResult,
      name: "Cellexia study result",
      displayNameKey: "label",
      access: DEFINITION_ACCESS,
      capabilities: DEFINITION_CAPABILITIES,
      fieldDefinitions: [
        field("value", "Value", "number_decimal"),
        field("suffix", "Suffix", "single_line_text_field"),
        field("label", "Label", "single_line_text_field"),
      ],
    },
  );
  const ingredientId = await ensureDefinition(PDP_METAOBJECT_TYPES.ingredient, {
    type: PDP_METAOBJECT_TYPES.ingredient,
    name: "Cellexia ingredient",
    displayNameKey: "name",
    access: DEFINITION_ACCESS,
    capabilities: DEFINITION_CAPABILITIES,
    fieldDefinitions: [
      field("name", "Ingredient name", "single_line_text_field"),
      field("concentration", "Actual concentration (%)", "number_decimal"),
      field("form", "Form", "single_line_text_field"),
      field("note", "Note", "single_line_text_field"),
    ],
  });
  const coaId = await ensureDefinition(PDP_METAOBJECT_TYPES.coa, {
    type: PDP_METAOBJECT_TYPES.coa,
    name: "Cellexia certificate of analysis",
    displayNameKey: "batch",
    access: DEFINITION_ACCESS,
    capabilities: DEFINITION_CAPABILITIES,
    fieldDefinitions: [
      field("batch", "Batch number", "single_line_text_field"),
      field("issued", "Issued on", "date"),
      field("lab", "Testing lab", "single_line_text_field"),
      field("document_url", "Document URL", "url"),
      field("document", "Document (PDF)", "file_reference"),
    ],
  });
  const surveyOutcomeId = await ensureDefinition(
    PDP_METAOBJECT_TYPES.surveyOutcome,
    {
      type: PDP_METAOBJECT_TYPES.surveyOutcome,
      name: "Cellexia survey outcome",
      displayNameKey: "statement",
      access: DEFINITION_ACCESS,
      capabilities: DEFINITION_CAPABILITIES,
      fieldDefinitions: [
        field("statement", "Outcome statement", "single_line_text_field"),
        field("yes_count", "Dermatologists who agreed", "number_integer"),
      ],
    },
  );

  // 2. Parent definitions.
  const clinicalStudyExisted = Boolean(
    definitionIds[PDP_METAOBJECT_TYPES.clinicalStudy],
  );
  if (studyResultId) {
    await ensureDefinition(PDP_METAOBJECT_TYPES.clinicalStudy, {
      type: PDP_METAOBJECT_TYPES.clinicalStudy,
      name: "Cellexia clinical study",
      displayNameKey: "title",
      access: DEFINITION_ACCESS,
      capabilities: DEFINITION_CAPABILITIES,
      fieldDefinitions: [
        field("title", "Study title", "single_line_text_field"),
        field("subject", "Subject", "single_line_text_field"),
        field("concern", "Concern", "single_line_text_field"),
        field("duration_weeks", "Duration (weeks)", "number_integer"),
        field("sample_size", "Sample size (n)", "number_integer"),
        field("lab_name", "Lab name", "single_line_text_field"),
        field("instruments", "Instruments", "single_line_text_field"),
        field("study_url", "Study summary URL", "url"),
        listReferenceField("results", "Results", studyResultId),
        field("footnote", "Footnote", "multi_line_text_field"),
      ],
    });
    // v7 migration: `subject` postdates already-provisioned shops, and the
    // create branch above never runs for a definition that exists — backfill
    // any missing fields on it (idempotent no-op once present).
    if (clinicalStudyExisted) {
      const migration = await ensureDefinitionFields(
        admin,
        PDP_METAOBJECT_TYPES.clinicalStudy,
        [field("subject", "Subject", "single_line_text_field")],
      );
      errors.push(...migration.errors);
      created.push(
        ...migration.added.map(
          (key) => `${PDP_METAOBJECT_TYPES.clinicalStudy}.${key}`,
        ),
      );
    }
  } else {
    errors.push(
      `${PDP_METAOBJECT_TYPES.clinicalStudy}: skipped — the ${PDP_METAOBJECT_TYPES.studyResult} definition it references could not be resolved`,
    );
  }

  await ensureDefinition(PDP_METAOBJECT_TYPES.beforeAfter, {
    type: PDP_METAOBJECT_TYPES.beforeAfter,
    name: "Cellexia verified before/after",
    displayNameKey: "clinic",
    access: DEFINITION_ACCESS,
    capabilities: DEFINITION_CAPABILITIES,
    fieldDefinitions: [
      field("before_image", "Before image", "file_reference"),
      field("after_image", "After image", "file_reference"),
      field("before_date", "Before date", "date"),
      field("after_date", "After date", "date"),
      field("weeks", "Weeks between", "number_integer"),
      field("clinic", "Clinic", "single_line_text_field"),
      field("imaging", "Imaging system", "single_line_text_field"),
      field("verifier_name", "Verifier name", "single_line_text_field"),
      field("verifier_license", "Verifier license", "single_line_text_field"),
      field("statement", "Verifier statement", "multi_line_text_field"),
      field("verification_url", "Verification URL", "url"),
    ],
  });

  if (ingredientId && coaId) {
    await ensureDefinition(PDP_METAOBJECT_TYPES.batchTransparency, {
      type: PDP_METAOBJECT_TYPES.batchTransparency,
      name: "Cellexia batch transparency",
      access: DEFINITION_ACCESS,
      capabilities: DEFINITION_CAPABILITIES,
      fieldDefinitions: [
        field("intro", "Intro", "multi_line_text_field"),
        listReferenceField("ingredients", "Ingredients", ingredientId),
        listReferenceField("certificates", "Certificates of analysis", coaId),
      ],
    });
  } else {
    errors.push(
      `${PDP_METAOBJECT_TYPES.batchTransparency}: skipped — the ${PDP_METAOBJECT_TYPES.ingredient}/${PDP_METAOBJECT_TYPES.coa} definitions it references could not be resolved`,
    );
  }

  if (surveyOutcomeId) {
    await ensureDefinition(PDP_METAOBJECT_TYPES.productSurvey, {
      type: PDP_METAOBJECT_TYPES.productSurvey,
      name: "Cellexia dermatologist survey",
      displayNameKey: "title",
      access: DEFINITION_ACCESS,
      capabilities: DEFINITION_CAPABILITIES,
      fieldDefinitions: [
        field("title", "Headline override", "single_line_text_field"),
        field("sample_size", "Dermatologists surveyed (n)", "number_integer"),
        field("recommend_yes", "Would recommend (count)", "number_integer"),
        field("question", "Question asked", "single_line_text_field"),
        field("intro", "Outcomes intro override", "single_line_text_field"),
        field("methodology", "Methodology override", "multi_line_text_field"),
        field("verifier_name", "Verifier name", "single_line_text_field"),
        field("verification_url", "Verification URL", "url"),
        listReferenceField("outcomes", "Outcomes", surveyOutcomeId),
      ],
    });
  } else {
    errors.push(
      `${PDP_METAOBJECT_TYPES.productSurvey}: skipped — the ${PDP_METAOBJECT_TYPES.surveyOutcome} definition it references could not be resolved`,
    );
  }

  // 3. Product metafield definitions (so the metafields render nicely in the
  //    Shopify admin product page and can be pinned/validated).
  const existingMetafieldKeys = new Set(
    (lookup.data.metafieldDefinitions?.nodes ?? []).map((node) => node.key),
  );

  const metafieldDefinitions: {
    key: string;
    referencedType?: string;
    build: (referencedDefinitionId: string | null) => Record<
      string,
      unknown
    > | null;
  }[] = [
    {
      key: PDP_METAFIELD_KEYS.clinicalStudy,
      referencedType: PDP_METAOBJECT_TYPES.clinicalStudy,
      build: (referencedDefinitionId) =>
        referencedDefinitionId
          ? {
              name: "Cellexia clinical study",
              namespace: CELLEXIA_NAMESPACE,
              key: PDP_METAFIELD_KEYS.clinicalStudy,
              description:
                "Independent clinical study rendered on the product page by the Cellexia AOV & LTV Booster.",
              type: "metaobject_reference",
              ownerType: "PRODUCT",
              pin: true,
              access: DEFINITION_ACCESS,
              validations: [
                {
                  name: "metaobject_definition_id",
                  value: referencedDefinitionId,
                },
              ],
            }
          : null,
    },
    {
      key: PDP_METAFIELD_KEYS.beforeAfters,
      referencedType: PDP_METAOBJECT_TYPES.beforeAfter,
      build: (referencedDefinitionId) =>
        referencedDefinitionId
          ? {
              name: "Cellexia verified before/afters",
              namespace: CELLEXIA_NAMESPACE,
              key: PDP_METAFIELD_KEYS.beforeAfters,
              description:
                "Verified before/after entries rendered on the product page by the Cellexia AOV & LTV Booster.",
              type: "list.metaobject_reference",
              ownerType: "PRODUCT",
              pin: true,
              access: DEFINITION_ACCESS,
              validations: [
                {
                  name: "metaobject_definition_id",
                  value: referencedDefinitionId,
                },
              ],
            }
          : null,
    },
    {
      key: PDP_METAFIELD_KEYS.batchTransparency,
      referencedType: PDP_METAOBJECT_TYPES.batchTransparency,
      build: (referencedDefinitionId) =>
        referencedDefinitionId
          ? {
              name: "Cellexia batch transparency",
              namespace: CELLEXIA_NAMESPACE,
              key: PDP_METAFIELD_KEYS.batchTransparency,
              description:
                "Ingredient concentrations and certificates of analysis rendered on the product page.",
              type: "metaobject_reference",
              ownerType: "PRODUCT",
              pin: true,
              access: DEFINITION_ACCESS,
              validations: [
                {
                  name: "metaobject_definition_id",
                  value: referencedDefinitionId,
                },
              ],
            }
          : null,
    },
    {
      key: PDP_METAFIELD_KEYS.productSurvey,
      referencedType: PDP_METAOBJECT_TYPES.productSurvey,
      build: (referencedDefinitionId) =>
        referencedDefinitionId
          ? {
              name: "Cellexia dermatologist survey",
              namespace: CELLEXIA_NAMESPACE,
              key: PDP_METAFIELD_KEYS.productSurvey,
              description:
                "Per-product dermatologist survey rendered on the product page by the Cellexia AOV & LTV Booster.",
              type: "metaobject_reference",
              ownerType: "PRODUCT",
              pin: true,
              access: DEFINITION_ACCESS,
              validations: [
                {
                  name: "metaobject_definition_id",
                  value: referencedDefinitionId,
                },
              ],
            }
          : null,
    },
    {
      key: PDP_METAFIELD_KEYS.bestsellerCategory,
      build: () => ({
        name: "Bestseller category",
        namespace: CELLEXIA_NAMESPACE,
        key: PDP_METAFIELD_KEYS.bestsellerCategory,
        description:
          "Category shown in the Cellexia bestseller badge (“#1 Bestseller · {category}”). Translatable per language.",
        type: "single_line_text_field",
        ownerType: "PRODUCT",
        pin: true,
        access: DEFINITION_ACCESS,
      }),
    },
    {
      key: PDP_METAFIELD_KEYS.pdpFlags,
      build: () => ({
        name: "Cellexia PDP booster flags",
        namespace: CELLEXIA_NAMESPACE,
        key: PDP_METAFIELD_KEYS.pdpFlags,
        description:
          "Per-product opt-in/out flags for the five Cellexia PDP trust boosters (missing key = enabled).",
        type: "json",
        ownerType: "PRODUCT",
        pin: true,
        access: DEFINITION_ACCESS,
      }),
    },
  ];

  for (const definition of metafieldDefinitions) {
    if (existingMetafieldKeys.has(definition.key)) continue;
    const input = definition.build(
      definition.referencedType
        ? definitionIds[definition.referencedType]
        : null,
    );
    if (!input) {
      errors.push(
        `cellexia.${definition.key}: skipped — the ${definition.referencedType} metaobject definition it references could not be resolved`,
      );
      continue;
    }
    const result = await adminRequest<MetafieldDefinitionCreateData>(
      admin,
      METAFIELD_DEFINITION_CREATE_MUTATION,
      { definition: input },
    );
    if (result.data?.metafieldDefinitionCreate?.createdDefinition?.id) {
      created.push(`cellexia.${definition.key}`);
      continue;
    }
    let userErrors = result.data?.metafieldDefinitionCreate?.userErrors ?? [];
    let requestErrors = result.errors;
    // The shop is at its pinned-definition limit — the definition itself is
    // still valid, so retry once unpinned rather than failing outright.
    if (
      userErrors.some(
        (error) =>
          error.code === "PINNED_LIMIT_REACHED" ||
          /pinned.*(limit|maximum)|(limit|maximum).*pinned/i.test(
            error.message,
          ),
      )
    ) {
      const retry = await adminRequest<MetafieldDefinitionCreateData>(
        admin,
        METAFIELD_DEFINITION_CREATE_MUTATION,
        { definition: { ...input, pin: false } },
      );
      if (retry.data?.metafieldDefinitionCreate?.createdDefinition?.id) {
        created.push(`cellexia.${definition.key}`);
        continue;
      }
      userErrors = retry.data?.metafieldDefinitionCreate?.userErrors ?? [];
      requestErrors = retry.errors;
    }
    // TAKEN = a concurrent call created it between our lookup and this
    // mutation — that is the idempotent success case.
    if (userErrors.some((error) => error.code === "TAKEN")) continue;
    errors.push(
      ...messages(userErrors).map(
        (message) => `cellexia.${definition.key}: ${message}`,
      ),
      ...requestErrors.map(
        (message) => `cellexia.${definition.key}: ${message}`,
      ),
    );
  }

  return { ok: errors.length === 0, errors, created, definitionIds };
}

export interface EnsureDefinitionFieldsResult {
  ok: boolean;
  errors: string[];
  /** Field keys added to the definition by THIS call. */
  added: string[];
}

/**
 * v7 migration path: adds MISSING fields to an EXISTING metaobject
 * definition. ensurePdpDefinitions only ever creates, so a field introduced
 * in a later version would never reach shops provisioned before it. This
 * helper queries the definition's current fieldDefinitions and issues one
 * metaobjectDefinitionUpdate containing only `create` operations for the
 * keys that are missing — existing fields are never removed or modified,
 * re-running is a no-op, and losing the create race to a concurrent call
 * (TAKEN) is the idempotent success case.
 */
export async function ensureDefinitionFields(
  admin: AdminGraphqlClient,
  type: string,
  fields: FieldDefinitionInput[],
): Promise<EnsureDefinitionFieldsResult> {
  const lookup = await adminRequest<MetaobjectDefinitionFieldsData>(
    admin,
    METAOBJECT_DEFINITION_FIELDS_QUERY,
    { type },
  );
  const definition = lookup.data?.metaobjectDefinitionByType ?? null;
  if (!definition) {
    return {
      ok: false,
      errors: lookup.errors.length
        ? lookup.errors.map((message) => `${type}: ${message}`)
        : [`${type}: definition not found — cannot add fields to it`],
      added: [],
    };
  }
  const existingKeys = new Set(
    (definition.fieldDefinitions ?? []).map((entry) => entry.key),
  );
  const missing = fields.filter((entry) => !existingKeys.has(entry.key));
  if (missing.length === 0) return { ok: true, errors: [], added: [] };

  const result = await adminRequest<MetaobjectDefinitionUpdateData>(
    admin,
    METAOBJECT_DEFINITION_UPDATE_MUTATION,
    {
      id: definition.id,
      definition: {
        fieldDefinitions: missing.map((entry) => ({ create: entry })),
      },
    },
  );
  if (result.data?.metaobjectDefinitionUpdate?.metaobjectDefinition?.id) {
    return { ok: true, errors: [], added: missing.map((entry) => entry.key) };
  }
  const userErrors = result.data?.metaobjectDefinitionUpdate?.userErrors ?? [];
  // TAKEN = a concurrent migration added the field between our lookup and
  // this mutation — the fields exist now, which is the goal.
  const fatal = userErrors.filter((error) => error.code !== "TAKEN");
  if (fatal.length === 0 && result.errors.length === 0) {
    return { ok: true, errors: [], added: [] };
  }
  return {
    ok: false,
    errors: [
      ...messages(fatal).map((message) => `${type}: ${message}`),
      ...result.errors.map((message) => `${type}: ${message}`),
    ],
    added: [],
  };
}

// ---------------------------------------------------------------------------
// Metaobject CRUD wrappers
// ---------------------------------------------------------------------------

const METAOBJECT_CREATE_MUTATION = `#graphql
  mutation cellexiaMetaobjectCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

const METAOBJECT_UPDATE_MUTATION = `#graphql
  mutation cellexiaMetaobjectUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject { id }
      userErrors { field message code }
    }
  }
`;

const METAOBJECT_DELETE_MUTATION = `#graphql
  mutation cellexiaMetaobjectDelete($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message code }
    }
  }
`;

export interface MetaobjectWriteResult {
  ok: boolean;
  /** Created/updated/deleted metaobject GID (null on failure). */
  id: string | null;
  errors: string[];
}

interface MetaobjectCreateData {
  metaobjectCreate: {
    metaobject: { id: string } | null;
    userErrors: UserError[];
  } | null;
}

interface MetaobjectUpdateData {
  metaobjectUpdate: {
    metaobject: { id: string } | null;
    userErrors: UserError[];
  } | null;
}

interface MetaobjectDeleteData {
  metaobjectDelete: {
    deletedId: string | null;
    userErrors: UserError[];
  } | null;
}

/**
 * Creates a metaobject of `type` with the given fields, published ACTIVE so
 * the storefront can read it immediately. Field values are strings; empty
 * strings are dropped (an absent field and a cleared field are equivalent on
 * a brand-new metaobject, and typed fields reject "" on create).
 */
export async function createMetaobject(
  admin: AdminGraphqlClient,
  type: string,
  fields: MetaobjectFieldInput[],
): Promise<MetaobjectWriteResult> {
  const result = await adminRequest<MetaobjectCreateData>(
    admin,
    METAOBJECT_CREATE_MUTATION,
    {
      metaobject: {
        type,
        fields: fields.filter((entry) => entry.value !== ""),
        capabilities: { publishable: { status: "ACTIVE" } },
      },
    },
  );
  const id = result.data?.metaobjectCreate?.metaobject?.id ?? null;
  const errors = [
    ...messages(result.data?.metaobjectCreate?.userErrors),
    ...result.errors,
  ];
  return { ok: Boolean(id) && errors.length === 0, id, errors };
}

/**
 * Updates a metaobject's fields (partial update — only the provided keys are
 * touched; an empty-string value clears that field).
 */
export async function updateMetaobject(
  admin: AdminGraphqlClient,
  id: string,
  fields: MetaobjectFieldInput[],
): Promise<MetaobjectWriteResult> {
  const result = await adminRequest<MetaobjectUpdateData>(
    admin,
    METAOBJECT_UPDATE_MUTATION,
    { id, metaobject: { fields } },
  );
  const updatedId = result.data?.metaobjectUpdate?.metaobject?.id ?? null;
  const errors = [
    ...messages(result.data?.metaobjectUpdate?.userErrors),
    ...result.errors,
  ];
  return { ok: Boolean(updatedId) && errors.length === 0, id: updatedId, errors };
}

export async function deleteMetaobject(
  admin: AdminGraphqlClient,
  id: string,
): Promise<MetaobjectWriteResult> {
  const result = await adminRequest<MetaobjectDeleteData>(
    admin,
    METAOBJECT_DELETE_MUTATION,
    { id },
  );
  const deletedId = result.data?.metaobjectDelete?.deletedId ?? null;
  const errors = [
    ...messages(result.data?.metaobjectDelete?.userErrors),
    ...result.errors,
  ];
  return { ok: Boolean(deletedId) && errors.length === 0, id: deletedId, errors };
}

// ---------------------------------------------------------------------------
// Staged file upload
// ---------------------------------------------------------------------------

const STAGED_UPLOADS_CREATE_MUTATION = `#graphql
  mutation cellexiaStagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE_MUTATION = `#graphql
  mutation cellexiaFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus }
      userErrors { field message code }
    }
  }
`;

const FILE_STATUS_QUERY = `#graphql
  query cellexiaFileStatus($id: ID!) {
    node(id: $id) {
      ... on MediaImage {
        id
        fileStatus
        image { url }
        preview { image { url } }
      }
      ... on GenericFile {
        id
        fileStatus
        url
        preview { image { url } }
      }
    }
  }
`;

interface StagedUploadsCreateData {
  stagedUploadsCreate: {
    stagedTargets: {
      url: string;
      resourceUrl: string;
      parameters: { name: string; value: string }[];
    }[];
    userErrors: UserError[];
  } | null;
}

interface FileCreateData {
  fileCreate: {
    files: { id: string; fileStatus: string }[];
    userErrors: UserError[];
  } | null;
}

interface FileStatusData {
  node: {
    id?: string;
    fileStatus?: string;
    url?: string | null;
    image?: { url: string } | null;
    preview?: { image: { url: string } | null } | null;
  } | null;
}

export interface StagedUploadRequest {
  filename: string;
  mimeType: string;
  buffer: Uint8Array | ArrayBuffer;
}

export interface StagedUploadResult {
  ok: boolean;
  /** MediaImage GID for images, GenericFile GID for other files. */
  fileGid: string | null;
  /**
   * Canonical CDN URL of the file (image URL / file download URL). Null when
   * Shopify is still processing the file after the polling window — the file
   * GID is valid and the URL can be fetched later.
   */
  url: string | null;
  /** Thumbnail/preview URL (falls back to `url`). */
  previewUrl: string | null;
  errors: string[];
}

const FILE_POLL_TRIES = 10;
const FILE_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failedUpload(errors: string[]): StagedUploadResult {
  return { ok: false, fileGid: null, url: null, previewUrl: null, errors };
}

/**
 * Normalises the upload body to a plain ArrayBuffer so it is a valid
 * BlobPart regardless of whether the caller hands us a Node Buffer, a
 * Uint8Array over a SharedArrayBuffer, or an ArrayBuffer.
 */
function toArrayBuffer(buffer: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (buffer instanceof ArrayBuffer) return buffer;
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

/**
 * Uploads a file buffer to Shopify Files via the staged-upload pipeline:
 * stagedUploadsCreate -> multipart POST of the target's parameters + file to
 * the staged URL -> fileCreate with the resource URL -> poll fileStatus until
 * READY (max 10 tries, 500ms apart).
 *
 * image/* mime types become MediaImage files (resource IMAGE); everything
 * else (CoA PDFs) becomes a GenericFile (resource FILE).
 */
export async function stagedImageUpload(
  admin: AdminGraphqlClient,
  { filename, mimeType, buffer }: StagedUploadRequest,
): Promise<StagedUploadResult> {
  if (!filename || !mimeType || buffer.byteLength === 0) {
    return failedUpload(["A filename, mime type and non-empty file are required"]);
  }
  const isImage = mimeType.toLowerCase().startsWith("image/");

  const staged = await adminRequest<StagedUploadsCreateData>(
    admin,
    STAGED_UPLOADS_CREATE_MUTATION,
    {
      input: [
        {
          filename,
          mimeType,
          resource: isImage ? "IMAGE" : "FILE",
          fileSize: String(buffer.byteLength),
          httpMethod: "POST",
        },
      ],
    },
  );
  const stagedErrors = [
    ...messages(staged.data?.stagedUploadsCreate?.userErrors),
    ...staged.errors,
  ];
  const target = staged.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target || stagedErrors.length > 0) {
    return failedUpload(
      stagedErrors.length ? stagedErrors : ["Could not create a staged upload target"],
    );
  }

  // Multipart POST: the target's parameters first, the file last.
  try {
    const form = new FormData();
    for (const parameter of target.parameters) {
      form.append(parameter.name, parameter.value);
    }
    form.append(
      "file",
      new Blob([toArrayBuffer(buffer)], { type: mimeType }),
      filename,
    );
    const uploadResponse = await fetch(target.url, {
      method: "POST",
      body: form,
    });
    if (!uploadResponse.ok) {
      return failedUpload([
        `Staged upload POST failed with HTTP ${uploadResponse.status}`,
      ]);
    }
  } catch (error) {
    return failedUpload([
      error instanceof Error ? error.message : "Staged upload POST failed",
    ]);
  }

  const fileCreate = await adminRequest<FileCreateData>(
    admin,
    FILE_CREATE_MUTATION,
    {
      files: [
        {
          contentType: isImage ? "IMAGE" : "FILE",
          originalSource: target.resourceUrl,
          alt: filename,
          duplicateResolutionMode: "APPEND_UUID",
        },
      ],
    },
  );
  const fileCreateErrors = [
    ...messages(fileCreate.data?.fileCreate?.userErrors),
    ...fileCreate.errors,
  ];
  const fileGid = fileCreate.data?.fileCreate?.files?.[0]?.id ?? null;
  if (!fileGid || fileCreateErrors.length > 0) {
    return failedUpload(
      fileCreateErrors.length ? fileCreateErrors : ["fileCreate returned no file"],
    );
  }

  for (let attempt = 0; attempt < FILE_POLL_TRIES; attempt += 1) {
    if (attempt > 0) await sleep(FILE_POLL_INTERVAL_MS);
    const status = await adminRequest<FileStatusData>(admin, FILE_STATUS_QUERY, {
      id: fileGid,
    });
    const node = status.data?.node ?? null;
    if (!node?.fileStatus) continue;
    if (node.fileStatus === "FAILED") {
      return {
        ok: false,
        fileGid,
        url: null,
        previewUrl: null,
        errors: ["Shopify could not process the uploaded file"],
      };
    }
    if (node.fileStatus === "READY") {
      const url = node.image?.url ?? node.url ?? null;
      return {
        ok: true,
        fileGid,
        url,
        previewUrl: node.preview?.image?.url ?? url,
        errors: [],
      };
    }
  }

  // Still processing after the polling window: the file exists and its GID is
  // safe to store; only the CDN URL is not available yet.
  return { ok: true, fileGid, url: null, previewUrl: null, errors: [] };
}
