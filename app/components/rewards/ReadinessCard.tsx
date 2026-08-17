import { Badge, BlockStack, Box, Button, Card, InlineStack, Text } from "@shopify/polaris";

/**
 * "Ready to go live?" checklist (v15 admin overhaul): four rows, each a
 * status badge + one plain sentence + one action. The route computes the
 * statuses; this component only renders them.
 */

export type ReadinessTone = "success" | "attention" | "critical" | "info";

export interface ReadinessRow {
  id: string;
  title: string;
  tone: ReadinessTone;
  badge: string;
  /** One sentence: what the status means and what to do next. */
  sentence: string;
  action?: {
    label: string;
    onClick?: () => void;
    url?: string;
    loading?: boolean;
    disabled?: boolean;
    disabledReason?: string;
  };
  /** Optional detail lines under the sentence (e.g. the codes to create). */
  details?: string[];
  /** Optional error lines (collisions etc.). */
  errors?: string[];
}

export function ReadinessCard({ rows }: { rows: ReadinessRow[] }) {
  const allGood = rows.every((row) => row.tone === "success");
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <Text as="h2" variant="headingMd">
            Ready to go live?
          </Text>
          <Badge tone={allGood ? "success" : "attention"}>
            {allGood ? "All set" : "Some steps left"}
          </Badge>
        </InlineStack>
        <Text as="p" tone="subdued" variant="bodySm">
          Four steps, top to bottom. Each row tells you what to do next.
          Existing discounts in your store are never changed by this app.
        </Text>
        <BlockStack gap="200">
          {rows.map((row) => (
            <Box
              key={row.id}
              padding="300"
              borderColor="border"
              borderWidth="025"
              borderRadius="200"
            >
              <InlineStack align="space-between" blockAlign="start" wrap gap="300">
                <BlockStack gap="100">
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={row.tone === "info" ? undefined : row.tone}>{row.badge}</Badge>
                    <Text as="h3" variant="headingSm">
                      {row.title}
                    </Text>
                  </InlineStack>
                  <Text as="p" variant="bodySm">
                    {row.sentence}
                  </Text>
                  {row.details?.map((line) => (
                    <Text as="p" tone="subdued" variant="bodySm" key={line}>
                      {line}
                    </Text>
                  ))}
                  {row.errors?.map((line) => (
                    <Text as="p" tone="critical" variant="bodySm" key={line}>
                      {line}
                    </Text>
                  ))}
                  {row.action?.disabled && row.action.disabledReason ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      {row.action.disabledReason}
                    </Text>
                  ) : null}
                </BlockStack>
                {row.action ? (
                  <Box>
                    <Button
                      onClick={row.action.onClick}
                      url={row.action.url}
                      loading={row.action.loading}
                      disabled={row.action.disabled}
                    >
                      {row.action.label}
                    </Button>
                  </Box>
                ) : null}
              </InlineStack>
            </Box>
          ))}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}
