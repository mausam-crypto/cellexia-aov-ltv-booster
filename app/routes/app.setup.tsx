import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  runHealthChecks,
  summarizeHealth,
  type HealthCheck,
} from "../services/health.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const checks = await runHealthChecks(admin, session);
  return { checks, summary: summarizeHealth(checks) };
};

function StatusBadge({ status }: { status: HealthCheck["status"] }) {
  if (status === "pass") return <Badge tone="success">Pass</Badge>;
  if (status === "warn") return <Badge tone="warning">Warning</Badge>;
  return <Badge tone="critical">Fail</Badge>;
}

function FixButton({ check }: { check: HealthCheck }) {
  if (!check.fixUrl) return null;
  const isAdminUrl = check.fixUrl.startsWith("http");
  return (
    <Button
      url={check.fixUrl}
      target={isAdminUrl ? "_blank" : undefined}
      size="slim"
    >
      {isAdminUrl ? "Open in Shopify admin" : "Open fix page"}
    </Button>
  );
}

function CheckRow({ check }: { check: HealthCheck }) {
  return (
    <BlockStack gap="300">
      <Divider />
      <InlineStack gap="300" align="space-between" blockAlign="start" wrap>
        <Box maxWidth="70ch">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingSm">
                {check.label}
              </Text>
              <StatusBadge status={check.status} />
            </InlineStack>
            <Text as="p" variant="bodySm">
              {check.detail}
            </Text>
            {check.status !== "pass" ? (
              <Text as="p" tone="subdued" variant="bodySm">
                Fix: {check.fixHint}
              </Text>
            ) : null}
          </BlockStack>
        </Box>
        {check.status !== "pass" ? <FixButton check={check} /> : null}
      </InlineStack>
    </BlockStack>
  );
}

export default function SetupPage() {
  const { checks, summary } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const running = revalidator.state !== "idle";
  const allGreen = summary.failing === 0 && summary.warnings === 0;

  return (
    <Page
      title="Setup & health"
      subtitle={`${summary.passing} of ${summary.total} checks passing`}
      backAction={{ content: "Dashboard", url: "/app" }}
      primaryAction={{
        content: "Re-run checks",
        onAction: () => revalidator.revalidate(),
        loading: running,
      }}
    >
      <TitleBar title="Setup & health" />
      <Layout>
        <Layout.Section>
          {summary.failing > 0 ? (
            <Banner
              tone="critical"
              title={`${summary.failing} check${summary.failing === 1 ? "" : "s"} failing — the store is not launch-ready`}
            >
              <Text as="p">
                Fix the failing checks below before going live. Failing checks
                mean widgets will not render, will render stale settings, or
                cannot complete a purchase path.
              </Text>
            </Banner>
          ) : summary.warnings > 0 ? (
            <Banner
              tone="warning"
              title={`All critical checks pass — ${summary.warnings} warning${summary.warnings === 1 ? "" : "s"} to review`}
            >
              <Text as="p">
                Warnings will not block a launch, but review each one so
                nothing surprises you later.
              </Text>
            </Banner>
          ) : (
            <Banner tone="success" title="All checks passing — launch-ready">
              <Text as="p">
                Everything a fresh install needs is verified: config sync,
                theme embeds, webhooks, content model, languages and preview
                hygiene.
              </Text>
            </Banner>
          )}
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  Launch checklist
                </Text>
                <Text as="p" tone="subdued">
                  This page verifies every wiring step programmatically. It
                  should be all green before you arm previews or go live —
                  each check tells you exactly what to fix and where.
                  {allGreen ? " You are all set." : ""}
                </Text>
              </BlockStack>
              {checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Next steps
              </Text>
              <Text as="p" tone="subdued">
                Once this page is green: preview your features on the real
                storefront, then go live per market — both from the Preview
                Center.
              </Text>
              <InlineStack gap="200">
                <Button url="/app/preview">Open the Preview Center</Button>
                <Button url="/app/features" variant="plain">
                  Browse all features
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
