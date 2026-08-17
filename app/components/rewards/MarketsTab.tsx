import { Badge, BlockStack, Button, Card, Checkbox, Divider, InlineStack, Text } from "@shopify/polaris";
import { scopeMarketCount, type MarketOption, type RewardsKey, type ScopeState } from "./shared";

/**
 * "Markets & go live" tab (v15): one market checklist per feature with an
 * "All markets" toggle, plus a plain summary of where each feature is live.
 */

export function MarketScopePicker({
  title,
  description,
  markets,
  scope,
  onChange,
}: {
  title: string;
  description: string;
  markets: MarketOption[];
  scope: ScopeState;
  onChange: (scope: ScopeState) => void;
}) {
  const allHandles = markets.map((m) => m.handle);
  const toggleAll = (checked: boolean) => {
    onChange(
      checked
        ? { mode: "all", markets: [...scope.markets] }
        : { mode: "selected", markets: scope.markets.length > 0 ? [...scope.markets] : [...allHandles] },
    );
  };
  const toggleMarket = (handle: string, checked: boolean) => {
    const set = new Set(scope.markets);
    if (checked) set.add(handle);
    else set.delete(handle);
    const ordered = allHandles.filter((h) => set.has(h));
    for (const other of set) if (!allHandles.includes(other)) ordered.push(other);
    onChange({ mode: "selected", markets: ordered });
  };
  const count = scopeMarketCount(scope, markets);
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <Text as="h3" variant="headingSm">
            {title}
          </Text>
          <Badge tone={count === 0 ? "critical" : "info"}>
            {scope.mode === "all" ? "All markets" : `${count} of ${markets.length} markets`}
          </Badge>
        </InlineStack>
        <Text as="p" tone="subdued" variant="bodySm">
          {description}
        </Text>
        <Checkbox label="All markets" checked={scope.mode === "all"} onChange={toggleAll} />
        {scope.mode === "selected" ? (
          <BlockStack gap="100">
            {markets.length === 0 ? (
              <Text as="p" tone="subdued" variant="bodySm">
                No markets could be loaded.
              </Text>
            ) : null}
            {markets.map((market) => (
              <Checkbox
                key={market.handle}
                label={market.primary ? `${market.name} (primary)` : market.name}
                helpText={market.enabled ? undefined : "inactive market"}
                checked={scope.markets.includes(market.handle)}
                onChange={(checked) => toggleMarket(market.handle, checked)}
              />
            ))}
            {count === 0 ? (
              <Text as="p" tone="critical" variant="bodySm">
                No market ticked — this will not show anywhere.
              </Text>
            ) : null}
          </BlockStack>
        ) : null}
      </BlockStack>
    </Card>
  );
}

export function MarketsTab({
  markets,
  scopes,
  setScope,
  ssEnabled,
  gtEnabled,
  fsEnabled,
  fsScope,
  onPreview,
}: {
  markets: MarketOption[];
  scopes: Record<RewardsKey, ScopeState>;
  setScope: (key: RewardsKey, scope: ScopeState) => void;
  ssEnabled: boolean;
  gtEnabled: boolean;
  fsEnabled: boolean;
  fsScope: ScopeState;
  onPreview: () => void;
}) {
  const liveLine = (label: string, enabled: boolean, scope: ScopeState) => {
    const n = scopeMarketCount(scope, markets);
    if (!enabled) return `${label}: off (turn it on in its tab, then Save).`;
    if (n === 0) return `${label}: on, but no market is ticked — shoppers will not see it.`;
    return `${label}: live in ${n === markets.length ? "all" : n} market${n === 1 ? "" : "s"} once saved.`;
  };
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Markets & go live
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            A feature is live for shoppers when it is turned on in its tab AND
            its market is ticked below AND you pressed Save. Preview first: the
            preview only shows in your own browser session — live shoppers
            never see it.
          </Text>
          <BlockStack gap="100">
            <Text as="p" variant="bodySm">
              {liveLine("Set savings", ssEnabled, scopes.set_savings)}
            </Text>
            <Text as="p" variant="bodySm">
              {liveLine("Free gifts", gtEnabled, scopes.gift_tiers)}
            </Text>
            <Text as="p" variant="bodySm">
              {liveLine("Free shipping", fsEnabled, fsScope)}
            </Text>
          </BlockStack>
          <Divider />
          <InlineStack gap="200">
            <Button onClick={onPreview}>Preview in my browser</Button>
          </InlineStack>
        </BlockStack>
      </Card>
      <div id="market-set_savings">
        <MarketScopePicker
          title="Set savings — markets"
          description="Tick the markets where the set-savings messages and discount codes should work."
          markets={markets}
          scope={scopes.set_savings}
          onChange={(scope) => setScope("set_savings", scope)}
        />
      </div>
      <div id="market-gift_tiers">
        <MarketScopePicker
          title="Free gifts — markets"
          description="Tick the markets where the gift progress bar and free gifts should work."
          markets={markets}
          scope={scopes.gift_tiers}
          onChange={(scope) => setScope("gift_tiers", scope)}
        />
      </div>
    </BlockStack>
  );
}
