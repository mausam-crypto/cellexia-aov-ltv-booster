import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Select,
  Tag,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";

/**
 * v12 — shared "Excluded products" card for the per-market product
 * exclusion records (dispatch.excludedByMarket /
 * deliveryEstimate.excludedByMarket / checkoutTrust.customsExcludedByMarket
 * / checkoutTrust.trackedExcludedByMarket /
 * amazon.shipsFromExcludedByMarket). Route modules deliberately do not
 * share UI, but a components/ file is allowed (the ProofForms.tsx
 * precedent — this file follows its product-picker mechanics exactly).
 *
 * Contract with the host route:
 *  - the route's ACTION implements the `search_products` intent returning
 *    `{ intent: "search_products", ok, errors, products: [{ gid, title,
 *    imageUrl, status }] }` (the proof-tab shape — every picker fetcher
 *    here submits to the CURRENT route);
 *  - the route's LOADER passes `titles` (gid -> title, via
 *    getProductTitlesByIds) so stored exclusions stay readable after a
 *    reload; unknown gids fall back to "Product <id>";
 *  - `value` is the full record (market handle -> product GIDs) and
 *    `onChange` receives the full next record — the settings merge
 *    replaces these records WHOLESALE on save, so the host's handleSave
 *    must always send the complete map;
 *  - markets no longer in Shopify Markets stay visible and editable
 *    (the ItemMarketPicker precedent — a stale handle is shown with a
 *    "not in Markets" badge, never silently dropped).
 *
 * Entries with zero products are kept client-side for editing but are
 * dropped by the server sanitizer on save — the card says so.
 */

export interface ExclusionMarketOption {
  handle: string;
  name: string;
}

interface SearchActionData {
  intent: string;
  ok: boolean;
  errors: string[];
  products?: { gid: string; title: string; imageUrl: string | null; status: string }[];
}

function numericTail(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

/** One market's product list: tag chips + the search-and-add picker. */
function ExclusionProductPicker({
  value,
  titles,
  disabled,
  onChange,
}: {
  value: string[];
  titles: Record<string, string>;
  disabled: boolean;
  onChange: (gids: string[]) => void;
}) {
  const search = useFetcher<SearchActionData>();
  const [query, setQuery] = useState("");
  // gid -> title from search hits; loader-hydrated titles arrive via the
  // `titles` prop. Unknown gids show the id tail (ProductTagPicker rule).
  const titlesRef = useRef<Record<string, string>>({});
  const busy = search.state !== "idle";

  useEffect(() => {
    const data = search.data;
    if (!data || data.intent !== "search_products") return;
    for (const hit of data.products ?? []) {
      titlesRef.current[hit.gid] = hit.title;
    }
  }, [search.data]);

  const runSearch = () => {
    const formData = new FormData();
    formData.set("intent", "search_products");
    formData.set("q", query.trim());
    search.submit(formData, { method: "post" });
  };

  const hits = useMemo(() => {
    const data = search.data;
    if (!data || data.intent !== "search_products" || !data.ok) return [];
    return (data.products ?? []).filter((hit) => !value.includes(hit.gid));
  }, [search.data, value]);

  const labelFor = (gid: string) =>
    titles[gid] ?? titlesRef.current[gid] ?? `Product ${numericTail(gid)}`;

  return (
    <BlockStack gap="200">
      {value.length > 0 ? (
        <InlineStack gap="100" wrap>
          {value.map((gid) => (
            <Tag
              key={gid}
              onRemove={
                disabled
                  ? undefined
                  : () => onChange(value.filter((other) => other !== gid))
              }
            >
              {labelFor(gid)}
            </Tag>
          ))}
        </InlineStack>
      ) : (
        <Text as="p" variant="bodySm" tone="subdued">
          No products excluded yet — search below to add some.
        </Text>
      )}
      <TextField
        label="Search products"
        labelHidden
        placeholder="Search products by title"
        value={query}
        onChange={setQuery}
        autoComplete="off"
        disabled={disabled}
        connectedRight={
          <Button onClick={runSearch} disabled={disabled} loading={busy}>
            Search
          </Button>
        }
      />
      {hits.length > 0 ? (
        <BlockStack gap="100">
          {hits.map((hit) => (
            <InlineStack
              key={hit.gid}
              gap="200"
              blockAlign="center"
              align="space-between"
            >
              <InlineStack gap="200" blockAlign="center">
                <Thumbnail
                  source={hit.imageUrl ?? ImageIcon}
                  alt={hit.title}
                  size="extraSmall"
                />
                <Text as="span" variant="bodySm">
                  {hit.title}
                </Text>
                {hit.status !== "ACTIVE" ? (
                  <Badge tone="info" size="small">
                    {hit.status === "DRAFT" ? "Draft" : "Archived"}
                  </Badge>
                ) : null}
              </InlineStack>
              <Button
                size="slim"
                onClick={() => onChange([...value, hit.gid])}
                disabled={disabled}
              >
                Exclude
              </Button>
            </InlineStack>
          ))}
        </BlockStack>
      ) : null}
      {search.data &&
      search.data.intent === "search_products" &&
      !search.data.ok ? (
        <Text as="p" variant="bodySm" tone="critical">
          {search.data.errors[0] ?? "Product search failed"}
        </Text>
      ) : null}
    </BlockStack>
  );
}

export interface MarketProductExclusionsCardProps {
  /** Card heading, e.g. "Excluded products — delivery promise". */
  title: string;
  /** Feature-specific explanation of what exclusion does where. */
  description: string;
  markets: ExclusionMarketOption[];
  /** The FULL record (market handle -> product GIDs). */
  value: Record<string, string[]>;
  /** gid -> title, hydrated by the route loader (getProductTitlesByIds). */
  titles: Record<string, string>;
  disabled?: boolean;
  onChange: (next: Record<string, string[]>) => void;
}

export function MarketProductExclusionsCard({
  title,
  description,
  markets,
  value,
  titles,
  disabled = false,
  onChange,
}: MarketProductExclusionsCardProps) {
  const nameFor = (handle: string) =>
    markets.find((market) => market.handle === handle)?.name ?? handle;
  const entries = useMemo(
    () =>
      Object.keys(value).sort((a, b) => nameFor(a).localeCompare(nameFor(b))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, markets],
  );
  const addable = markets.filter((market) => !(market.handle in value));
  const [pendingMarket, setPendingMarket] = useState("");

  const setList = (handle: string, gids: string[]) => {
    onChange({ ...value, [handle]: gids });
  };
  const removeMarket = (handle: string) => {
    const next = { ...value };
    delete next[handle];
    onChange(next);
  };

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingSm">
          {title}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {description} Optional — with no exclusions, nothing changes.
          Markets left with zero products are removed when you save.
        </Text>
        {entries.map((handle) => {
          const known = markets.some((market) => market.handle === handle);
          return (
            <BlockStack key={handle} gap="200">
              <InlineStack gap="200" blockAlign="center" align="space-between">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" variant="bodySm" fontWeight="semibold">
                    {nameFor(handle)}
                  </Text>
                  {!known ? (
                    <Badge tone="warning" size="small">
                      Not in Markets
                    </Badge>
                  ) : null}
                </InlineStack>
                <Button
                  variant="plain"
                  tone="critical"
                  onClick={() => removeMarket(handle)}
                  disabled={disabled}
                >
                  Remove market
                </Button>
              </InlineStack>
              <ExclusionProductPicker
                value={value[handle] ?? []}
                titles={titles}
                disabled={disabled}
                onChange={(gids) => setList(handle, gids)}
              />
            </BlockStack>
          );
        })}
        {addable.length > 0 ? (
          <Select
            label="Add a market"
            options={[
              { label: "Select a market…", value: "" },
              ...addable.map((market) => ({
                label: market.name,
                value: market.handle,
              })),
            ]}
            value={pendingMarket}
            disabled={disabled}
            onChange={(handle) => {
              setPendingMarket("");
              if (handle && !(handle in value)) setList(handle, []);
            }}
          />
        ) : markets.length === 0 ? (
          <Text as="p" variant="bodySm" tone="subdued">
            Markets could not be loaded — existing exclusions stay editable
            above.
          </Text>
        ) : null}
      </BlockStack>
    </Card>
  );
}
