import type { LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLoaderData, useLocation, useNavigate } from "@remix-run/react";
import { Banner, BlockStack, Box, Card, Layout, Page, Tabs, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getProofModerationCounts } from "../services/proof.server";

/**
 * Proof library hub (docs/SPEC-v8-proof-library.md §5): the shared layout for
 * the three moderation tabs — Press, Endorsements, Results gallery — each a
 * nested route with its own loader/action. The hub only carries the tab
 * navigation with per-type count badges (refreshed automatically because
 * child actions revalidate this loader) and the storefront placement note.
 * /app/proof itself redirects to the results tab (app.proof._index.tsx).
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const counts = await getProofModerationCounts(session.shop);
  const storePrefix = session.shop.replace(".myshopify.com", "");
  const themeEditorUrl = `https://admin.shopify.com/store/${storePrefix}/themes/current/editor?context=apps`;
  return { counts, themeEditorUrl };
};

const TAB_PATHS = [
  "/app/proof/press",
  "/app/proof/endorsements",
  "/app/proof/results",
];

export default function ProofLibraryLayout() {
  const { counts, themeEditorUrl } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();

  const tabs = [
    // When counts.ok is false the DB was unreachable — badge with "?" so a
    // fabricated (0) never reads as an empty library (v8 review).
    {
      id: "press",
      content: counts.ok ? `Press (${counts.press.total})` : "Press (?)",
    },
    {
      id: "endorsements",
      content: counts.ok
        ? `Endorsements (${counts.endorsements.total})`
        : "Endorsements (?)",
    },
    {
      id: "results",
      content: !counts.ok
        ? "Results (?)"
        : counts.results.pending > 0
          ? `Results (${counts.results.total} · ${counts.results.pending} pending)`
          : `Results (${counts.results.total})`,
    },
  ];
  const selected = Math.max(
    TAB_PATHS.findIndex((path) => location.pathname.startsWith(path)),
    0,
  );

  return (
    <Page
      title="Proof library"
      backAction={{ content: "Dashboard", url: "/app" }}
      secondaryActions={[
        {
          content: "Display density",
          url: "/app/features#display-density",
          helpText:
            "Compact / ultra-compact modes for the press, endorsements and results widgets",
        },
      ]}
    >
      <TitleBar title="Proof library" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card padding="0">
              <Tabs
                tabs={tabs}
                selected={selected}
                onSelect={(index) => navigate(TAB_PATHS[index])}
              />
              <Box padding="300" paddingBlockStart="0">
                <Text as="p" variant="bodySm" tone="subdued">
                  Entries live in the app’s database and are served to the
                  storefront through the /apps/cellexia/proof endpoint — no
                  byte-budget limits, so hundreds or thousands of entries are
                  fine.
                </Text>
              </Box>
            </Card>
            {/* v8.7: ONE app embed ("Cellexia proof library") carries all
                three widgets — the store's legacy Liquid templates cannot
                take section app blocks (merchant-verified), so the v8 blocks
                were retired for an embed that self-inserts on product pages
                and the home page. */}
            <Banner
              title="One-time step: enable the app embed"
              tone="info"
              action={{ content: "Open App embeds", url: themeEditorUrl, target: "_blank" }}
            >
              <p>
                These widgets render through the <b>Cellexia proof library</b>{" "}
                app embed — turning a feature on (or previewing it) shows
                nothing until the embed is enabled. In the theme editor open{" "}
                <b>App embeds</b>, switch on “Cellexia proof library”, and
                save. One time only; the widgets then place themselves on
                product pages (below the info tabs) and the home page, and
                every feature/preview toggle works normally.
              </p>
            </Banner>
            <Outlet />
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
