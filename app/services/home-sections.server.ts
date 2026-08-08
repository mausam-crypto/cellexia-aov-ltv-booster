/**
 * v8.15: home-template section listing (scope: read_themes).
 *
 * Reads templates/index.json from the LIVE (main) theme and returns the
 * rendered home sections in order, so the Features page can offer a named
 * "home-page position" picker for the press band (press.homeAfterSection
 * stores the picked SECTION KEY — the `order` entry, which is also the
 * suffix of the section's rendered wrapper id `shopify-section-…__{key}`,
 * so the storefront anchor survives theme-editor reordering).
 *
 * Fail-soft by contract: any error (scope missing, theme read failure,
 * malformed template JSON) returns ok:false with a human reason — the
 * picker then degrades to the saved value + the end-of-page default
 * instead of breaking the Features page.
 */

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export interface HomeSectionEntry {
  /** templates/index.json `order` entry — the stored anchor value. */
  key: string;
  /** Human label: humanized section type + a short content hint. */
  label: string;
}

const HOME_TEMPLATE_QUERY = `#graphql
  query cellexiaHomeTemplate {
    themes(first: 1, roles: [MAIN]) {
      nodes {
        files(filenames: ["templates/index.json"], first: 1) {
          nodes {
            body {
              ... on OnlineStoreThemeFileBodyText {
                content
              }
            }
          }
        }
      }
    }
  }
`;

/** Strip an optional leading comment banner (settings_data.json style) so a
 *  dev-authored template with one still parses. */
function stripJsonBanner(content: string): string {
  return content.replace(/^\s*\/\*[\s\S]*?\*\//, "");
}

function humanizeType(type: string): string {
  const words = type.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Section";
}

/** First non-empty text-ish setting, HTML-stripped and shortened — enough
 *  for the merchant to tell two sections of the same type apart. */
function contentHint(settings: Record<string, unknown> | undefined): string {
  if (!settings || typeof settings !== "object") return "";
  for (const field of ["heading", "title", "eyebrow", "copy", "pre_heading"]) {
    const raw = settings[field];
    if (typeof raw !== "string") continue;
    const text = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    return text.length > 40 ? `${text.slice(0, 39).trimEnd()}…` : text;
  }
  return "";
}

export interface HomeSectionsResult {
  ok: boolean;
  sections: HomeSectionEntry[];
  /** Human-readable reason when ok is false. */
  error: string;
}

export async function listHomeSections(
  admin: AdminGraphqlClient,
): Promise<HomeSectionsResult> {
  try {
    const response = await admin.graphql(HOME_TEMPLATE_QUERY);
    const json = (await response.json()) as {
      data?: {
        themes?: {
          nodes?: {
            files?: {
              nodes?: { body?: { content?: string } }[];
            };
          }[];
        };
      };
    };
    const content =
      json.data?.themes?.nodes?.[0]?.files?.nodes?.[0]?.body?.content;
    if (typeof content !== "string" || content.trim() === "") {
      return {
        ok: false,
        sections: [],
        error: "The live theme has no readable templates/index.json.",
      };
    }
    const template = JSON.parse(stripJsonBanner(content)) as {
      sections?: Record<
        string,
        { type?: string; disabled?: boolean; settings?: Record<string, unknown> }
      >;
      order?: string[];
    };
    const order = Array.isArray(template.order) ? template.order : [];
    const sections: HomeSectionEntry[] = [];
    for (const key of order) {
      if (typeof key !== "string" || key === "") continue;
      const section = template.sections?.[key];
      // Hidden sections don't render — anchoring on one would silently
      // fall back to the end of the page, so they are not offered.
      if (!section || section.disabled === true) continue;
      const type = typeof section.type === "string" ? section.type : "";
      const hint = contentHint(section.settings);
      sections.push({
        key,
        label: hint
          ? `${humanizeType(type)} — “${hint}”`
          : humanizeType(type),
      });
    }
    if (sections.length === 0) {
      return {
        ok: false,
        sections: [],
        error: "The home template lists no visible sections.",
      };
    }
    return { ok: true, sections, error: "" };
  } catch (error) {
    return {
      ok: false,
      sections: [],
      error:
        error instanceof Error
          ? error.message
          : "Could not read the home template from the live theme.",
    };
  }
}
