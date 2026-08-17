import { Badge, BlockStack, Box, Card, Checkbox, Divider, InlineStack, Text, TextField } from "@shopify/polaris";
import { MarketScopePicker } from "./MarketsTab";
import type { MarketOption, RewardsFormState, ScopeState } from "./shared";

/**
 * "Free shipping" tab (v15): the free-shipping guarantee rule + its own
 * market scope. Plain language, essentials only.
 */
export function FreeShippingTab({
  fs,
  setFs,
  minUnitsError,
  explicitThresholds,
  explicitThresholdCount,
  markets,
  nodeCreated,
}: {
  fs: RewardsFormState["fs"];
  setFs: (patch: Partial<RewardsFormState["fs"]>) => void;
  minUnitsError?: string;
  explicitThresholds: string[];
  explicitThresholdCount: number;
  markets: MarketOption[];
  nodeCreated: boolean;
}) {
  const units = Number(fs.minUnits);
  const example =
    Number.isInteger(units) && units > 0
      ? `Example: a cart with ${units} full-size product${units === 1 ? "" : "s"} (2 jars of one cream count as 2) ships for free.`
      : "The units rule is off — only the spend rule below can grant free shipping.";
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <Text as="h2" variant="headingMd">
              Free shipping
            </Text>
            <Badge tone={fs.enabled ? "success" : undefined}>{fs.enabled ? "On" : "Off"}</Badge>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            Makes the cheapest paid shipping option free when the cart meets a
            rule. Works as an automatic shipping discount created by the app
            (“Create discount codes” at the top of the page also creates it).
            {nodeCreated ? " The shipping discount exists in Shopify." : " The shipping discount is not created yet."}
          </Text>
          <Checkbox
            label="Turn free shipping on"
            checked={fs.enabled}
            onChange={(enabled) => setFs({ enabled })}
          />
          <Divider />
          <Box width="220px">
            <TextField
              label="Free from this many full-size products"
              type="number"
              min={0}
              max={50}
              helpText="0 turns the units rule off."
              value={fs.minUnits}
              onChange={(minUnits) => setFs({ minUnits })}
              error={minUnitsError}
              autoComplete="off"
            />
          </Box>
          <Text as="p" variant="bodySm">
            {example}
          </Text>
          <Checkbox
            label="Also free when the cart total reaches the market's free-shipping amount"
            helpText={
              explicitThresholds.length > 0
                ? `Amounts you set under Settings → Free shipping: ${explicitThresholds.join(", ")}${explicitThresholdCount > explicitThresholds.length ? ", …" : ""}`
                : "No per-market free-shipping amount is set yet (Settings → Free shipping) — this rule grants nothing until one exists."
            }
            checked={fs.byThreshold}
            onChange={(byThreshold) => setFs({ byThreshold })}
          />
        </BlockStack>
      </Card>
      <MarketScopePicker
        title="Markets — free shipping"
        description="Free shipping applies only in the markets ticked here (and only while it is turned on above)."
        markets={markets}
        scope={fs.scope}
        onChange={(scope: ScopeState) => setFs({ scope })}
      />
    </BlockStack>
  );
}
