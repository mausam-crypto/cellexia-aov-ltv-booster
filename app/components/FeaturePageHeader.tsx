import { Badge, Button, InlineStack, Text } from "@shopify/polaris";

/**
 * Shared feature-page header strip (SPEC v4 §C consistency pass): the same
 * status badge + "Preview this" shortcut on every feature settings page,
 * deep-linking into the Preview Center with the feature pre-selected.
 *
 * Client-safe on purpose (lives in app/components, imports nothing from
 * *.server modules) so any route can render it. `featureKey` is a canonical
 * FeatureKey string — typed loosely so client bundles never touch the
 * server-side settings model.
 *
 * Usage:
 *   <FeaturePageHeader
 *     featureKey="checkout_upsell"
 *     enabled={combinedFlag}
 *     reachCaption="All markets"
 *   />
 */
export interface FeaturePageHeaderProps {
  /** Canonical FeatureKey (e.g. "cart_volume_upsell") for the deep link. */
  featureKey: string;
  /** Combined live flag state (master AND sub-flag) for the status badge. */
  enabled: boolean;
  /** Optional replacement for the default "Active"/"Off" badge label. */
  statusLabel?: string;
  /** Optional market-reach caption, e.g. "All markets" or "2 markets". */
  reachCaption?: string;
}

export function FeaturePageHeader({
  featureKey,
  enabled,
  statusLabel,
  reachCaption,
}: FeaturePageHeaderProps) {
  return (
    <InlineStack gap="300" align="space-between" blockAlign="center" wrap>
      <InlineStack gap="200" blockAlign="center">
        <Badge tone={enabled ? "success" : undefined}>
          {statusLabel ?? (enabled ? "Active" : "Off")}
        </Badge>
        {reachCaption ? (
          <Text as="span" tone="subdued" variant="bodySm">
            {reachCaption}
          </Text>
        ) : null}
      </InlineStack>
      <Button
        variant="plain"
        url={`/app/preview?feature=${encodeURIComponent(featureKey)}`}
      >
        Preview this
      </Button>
    </InlineStack>
  );
}

export default FeaturePageHeader;
