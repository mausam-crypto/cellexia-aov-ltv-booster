import { useCallback, useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Checkbox,
  InlineStack,
  Link,
  Text,
} from "@shopify/polaris";

/**
 * v22 — the "show this only to visitors who arrived through a tagged link"
 * control (docs/SPEC-v22-param-gates.md).
 *
 * SHARED across feature pages on purpose (the FeaturePageHeader precedent,
 * not the MarketScopeCard one): every future gated piece gets the same
 * explanation, the same copyable link and the same warnings, so the merchant
 * learns the mechanism once. Client-safe — it imports nothing from a
 * *.server module.
 */

export interface ParamGateCardProps {
  /** What this gate hides, in the merchant's words. */
  pieceLabel: string;
  /** Whether the piece is gated at all. */
  enabled: boolean;
  /** The minted parameter name, "" until the first save after enabling. */
  param: string;
  /** The minted token, "" until the first save after enabling. */
  token: string;
  /** The owning feature must be on for the gate to mean anything. */
  featureEnabled: boolean;
  onToggle: (enabled: boolean) => void;
  /** Clears the pair so the next save mints a fresh one. */
  onRegenerate: () => void;
  /** The store origin (no trailing slash) the example links are built on. */
  storeUrl?: string;
}

const FALLBACK_URL = "https://your-store.example";

export function ParamGateCard({
  pieceLabel,
  enabled,
  param,
  token,
  featureEnabled,
  onToggle,
  onRegenerate,
  storeUrl,
}: ParamGateCardProps) {
  const [copied, setCopied] = useState("");
  const ready = enabled && param !== "" && token !== "";
  const pair = ready ? `${param}=${token}` : "";
  const base = storeUrl && storeUrl !== "" ? storeUrl : FALLBACK_URL;
  const exampleUrl = ready ? `${base}/?${pair}` : "";
  const offUrl = ready ? `${base}/?${param}=off` : "";

  const copy = useCallback((label: string, value: string) => {
    if (!value) return;
    // Clipboard access can be refused (permissions, an insecure context);
    // the value is on screen either way, so a failure is not worth an error.
    try {
      void navigator.clipboard?.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(""), 2000);
    } catch {
      /* the merchant can still select it by hand */
    }
  }, []);

  return (
    <BlockStack gap="300">
      <InlineStack gap="200" blockAlign="center">
        <Text as="h3" variant="headingSm">
          Who sees it
        </Text>
        {enabled ? (
          <Badge tone="attention">Tagged links only</Badge>
        ) : (
          <Badge tone="success">Everyone</Badge>
        )}
      </InlineStack>

      <Checkbox
        label={`Show ${pieceLabel} only to visitors who arrive through a tagged link`}
        helpText="Off by default: the piece is visible to every visitor. Turn this on and it disappears from the normal storefront and appears only for someone who followed a link carrying the parameter below — remembered on their device for 90 days, so it stays visible on later visits."
        checked={enabled}
        disabled={!featureEnabled}
        onChange={onToggle}
      />

      {!featureEnabled ? (
        <Text as="p" variant="bodySm" tone="subdued">
          Turn {pieceLabel} on above before choosing who sees it.
        </Text>
      ) : null}

      {enabled && !ready ? (
        <Text as="p" variant="bodySm" tone="subdued">
          Save to generate this gate&rsquo;s parameter. It is random, unique to
          this piece, and never reused anywhere else.
        </Text>
      ) : null}

      {ready ? (
        <BlockStack gap="300">
          <Box
            background="bg-surface-secondary"
            padding="300"
            borderRadius="200"
          >
            <BlockStack gap="200">
              <Text as="p" variant="bodySm" fontWeight="semibold">
                Paste this into your ad platform
              </Text>
              <Text as="p" variant="bodyLg" fontWeight="bold" breakWord>
                {pair}
              </Text>
              <InlineStack gap="200">
                <Button size="slim" onClick={() => copy("pair", pair)}>
                  {copied === "pair" ? "Copied" : "Copy parameter"}
                </Button>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                In Google Ads put it in <b>Final URL suffix</b> (account or
                campaign settings) and in Meta put it in the ad&rsquo;s{" "}
                <b>URL parameters</b> field. Both add it to every ad URL for
                you, with the right <code>?</code> or <code>&amp;</code>, and
                it works alongside any parameters you already use.
              </Text>
            </BlockStack>
          </Box>

          <BlockStack gap="150">
            <Text as="p" variant="bodySm" fontWeight="semibold">
              Or paste a full link anywhere
            </Text>
            <Text as="p" variant="bodySm" breakWord>
              <code>{exampleUrl}</code>
            </Text>
            <InlineStack gap="200">
              <Button size="slim" onClick={() => copy("url", exampleUrl)}>
                {copied === "url" ? "Copied" : "Copy example link"}
              </Button>
              <Button
                size="slim"
                variant="plain"
                url={offUrl}
                target="_blank"
                accessibilityLabel={`Open a link that hides ${pieceLabel} again`}
              >
                Test link that hides it again
              </Button>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              Any page works as the entry point, not only a product page — a
              visitor who lands on your home page through the link sees the
              piece once they reach a product page. To undo it on your own
              device, open the second link.
            </Text>
          </BlockStack>

          <Box
            background="bg-surface-caution"
            padding="300"
            borderRadius="200"
          >
            <BlockStack gap="150">
              <Text as="p" variant="bodySm">
                <b>Put the parameter on the ad&rsquo;s own destination URL.</b>{" "}
                Then anyone who follows the ad — a reviewer included — lands on
                exactly the page your customer lands on. Do not use it to show
                a different price, offer, delivery promise or product claim:
                this changes presentation only, and both versions of the page
                sell the same thing on the same terms.
              </Text>
              <Text as="p" variant="bodySm">
                Regenerating gives this piece a new parameter and{" "}
                <b>immediately stops every link already running</b> from
                working. Update your live ads first.
              </Text>
              <InlineStack>
                <Button size="slim" tone="critical" onClick={onRegenerate}>
                  Regenerate parameter
                </Button>
              </InlineStack>
            </BlockStack>
          </Box>

          <Text as="p" variant="bodySm" tone="subdued">
            Impressions are tagged so you can compare visitors who saw this
            piece against those who did not — see{" "}
            <Link url="/app/analytics">Analytics</Link>.
          </Text>
        </BlockStack>
      ) : null}
    </BlockStack>
  );
}
