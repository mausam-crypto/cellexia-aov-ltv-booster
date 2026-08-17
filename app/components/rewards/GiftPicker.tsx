import { useEffect, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  BlockStack,
  Button,
  Card,
  InlineStack,
  Spinner,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import type { VariantSummary } from "../../services/products.server";
import type { loader as variantsLoader } from "../../routes/app.api.variants";
import { variantLabel } from "./shared";

/**
 * Product picker for gifts and sample sachets — the cart page's
 * `/app/api/variants?q=` search (debounced 350 ms). Purely presentational:
 * the parent decides what a pick means.
 */
export function GiftPicker({
  title,
  onPick,
  onClose,
}: {
  title: string;
  onPick: (variant: VariantSummary) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useFetcher<typeof variantsLoader>();
  const load = search.load;
  const lastQueryRef = useRef("");
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "" || trimmed === lastQueryRef.current) return;
    const handle = setTimeout(() => {
      lastQueryRef.current = trimmed;
      load(`/app/api/variants?q=${encodeURIComponent(trimmed)}`);
    }, 350);
    return () => clearTimeout(handle);
  }, [query, load]);
  const results = search.data?.variants ?? [];
  const busy = search.state !== "idle";
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingSm">
            {title}
          </Text>
          <Button variant="plain" onClick={onClose}>
            Close
          </Button>
        </InlineStack>
        <TextField
          label="Search products"
          placeholder="Search by product title"
          value={query}
          onChange={setQuery}
          autoComplete="off"
          autoFocus
        />
        {busy ? (
          <InlineStack align="center">
            <Spinner size="small" accessibilityLabel="Searching products" />
          </InlineStack>
        ) : null}
        {query.trim() !== "" && !busy ? (
          <BlockStack gap="200">
            {results.length === 0 && search.data ? (
              <Text as="p" tone="subdued" variant="bodySm">
                Nothing matched “{query.trim()}”.
              </Text>
            ) : null}
            {results.map((variant) => (
              <InlineStack key={variant.id} gap="300" align="space-between" blockAlign="center" wrap={false}>
                <InlineStack gap="300" blockAlign="center" wrap={false}>
                  <Thumbnail source={variant.imageUrl ?? ImageIcon} alt={variantLabel(variant)} size="small" />
                  <BlockStack gap="050">
                    <Text as="span" variant="bodyMd">
                      {variantLabel(variant)}
                    </Text>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {variant.price}
                      {variant.availableForSale === false ? " · Out of stock" : ""}
                    </Text>
                  </BlockStack>
                </InlineStack>
                <Button size="slim" onClick={() => onPick(variant)}>
                  Use this
                </Button>
              </InlineStack>
            ))}
          </BlockStack>
        ) : null}
      </BlockStack>
    </Card>
  );
}
