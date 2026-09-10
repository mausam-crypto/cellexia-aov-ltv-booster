import { useEffect, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  Collapsible,
  DataTable,
  Divider,
  InlineStack,
  Select,
  Tag,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { DeleteIcon, ImageIcon, PlusIcon } from "@shopify/polaris-icons";
import type { VariantSummary } from "../../services/products.server";
import { GiftPicker } from "./GiftPicker";
import {
  CAPS,
  GIFT_PDP_STYLE_LABELS,
  UNKNOWN_AVAIL,
  formatEur,
  giftOptionLabel,
  numericId,
  shortGid,
  variantLabel,
  type GiftClusterRow,
  type GiftOptionRow,
  type GiftTierErrors,
  type GiftTierRow,
  type LocationOption,
  type MarketOption,
  type RewardsFormState,
  type SampleRule,
  type StockView,
} from "./shared";

/**
 * "Free gifts" tab (v15): one card per tier — "Spend €119 → gets: [Bamboo
 * towels] [2 sample sachets] [+ add gift]" — a preset Select with "Use this
 * preset", and an "Advanced" section (per-market amounts with "Suggest from
 * local prices", warehouses & stock, max gift lines, shipping milestone,
 * sample rule, sample pool).
 */

type PickerTarget =
  | { kind: "option"; clusterId: string; tier: number; slot: number; option: number }
  | { kind: "pool" };

export interface GiftsTabProps {
  gt: RewardsFormState["gt"];
  setGt: (patch: Partial<RewardsFormState["gt"]>) => void;
  variantIndex: Record<string, VariantSummary>;
  registerVariant: (variant: VariantSummary) => void;
  updateTier: (clusterId: string, index: number, update: Partial<GiftTierRow>) => void;
  removeTier: (clusterId: string, index: number) => void;
  addTier: (clusterId: string) => void;
  updateSlots: (clusterId: string, tier: number, slots: GiftOptionRow[][]) => void;
  updateOption: (
    clusterId: string,
    tier: number,
    slot: number,
    option: number,
    update: Partial<GiftOptionRow>,
  ) => void;
  addCluster: () => void;
  removeCluster: (clusterId: string) => void;
  updateCluster: (clusterId: string, update: Partial<GiftClusterRow>) => void;
  toggleClusterCountry: (clusterId: string, code: string, checked: boolean) => void;
  toggleClusterLocation: (clusterId: string, locationId: string, checked: boolean) => void;
  setThresholdAmount: (code: string, currencyCode: string, index: number, value: string) => void;
  clearThreshold: (code: string) => void;
  /** How many tiers a country's cluster has (sizes its amount row). */
  tierCountForCountry: (code: string) => number;
  /** Cluster id -> that cluster's ladder errors. */
  clusterErrors: Record<string, { tierErrors: GiftTierErrors[]; formErrors: string[] }>;
  formErrors: string[];
  thresholdErrors: Record<string, string>;
  maxGiftLinesError?: string;
  stockDaysError?: string;
  stockMinError?: string;
  /** v15.1 (F1): pool over the server cap — blocks Save; shown under the pool. */
  poolError?: string;
  /** v15.1: note after "Load my sachets" (entries dropped at the cap). */
  poolNote?: string;
  /** Server cap (REWARDS_CAPS.samplePool = 9). */
  poolCap: number;
  /** Bumped by the route when a "Fix these before saving" line points into
   *  this tab's Advanced section — opens it. */
  advancedSignal?: number;
  markets: MarketOption[];
  locations: LocationOption[];
  reach: string;
  onEditMarkets: () => void;
  // intents
  onLoadPreset: () => void;
  presetLoading: boolean;
  presetNotes: string[];
  onLoadSachets: () => void;
  sachetsLoading: boolean;
  sachetsErrors: string[];
  onSuggestAmounts: () => void;
  suggestLoading: boolean;
  suggestNotes: string[];
  onRefreshStock: () => void;
  stockLoading: boolean;
  stockView: StockView;
  stockNote: string | null;
  stockErrors: string[];
}

export function GiftsTab(props: GiftsTabProps) {
  const {
    gt,
    setGt,
    variantIndex,
    registerVariant,
    updateTier,
    removeTier,
    addTier,
    updateSlots,
    updateOption,
    addCluster,
    removeCluster,
    updateCluster,
    toggleClusterCountry,
    toggleClusterLocation,
    setThresholdAmount,
    clearThreshold,
    tierCountForCountry,
    clusterErrors,
    formErrors,
    thresholdErrors,
    maxGiftLinesError,
    stockDaysError,
    stockMinError,
    poolError,
    poolNote,
    poolCap,
    advancedSignal = 0,
    markets,
    locations,
    reach,
    onEditMarkets,
    onLoadPreset,
    presetLoading,
    presetNotes,
    onLoadSachets,
    sachetsLoading,
    sachetsErrors,
    onSuggestAmounts,
    suggestLoading,
    suggestNotes,
    onRefreshStock,
    stockLoading,
    stockView,
    stockNote,
    stockErrors,
  } = props;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    if (advancedSignal > 0) setAdvancedOpen(true);
  }, [advancedSignal]);
  const poolFull = gt.samplePool.length >= poolCap;
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [showBackups, setShowBackups] = useState(false);
  /** Which cluster card is expanded ("" = all collapsed). Starts on the
   *  first one so the tab is never a wall of closed rows. */
  const [openCluster, setOpenCluster] = useState<string>(() => gt.clusters[0]?.id ?? "");

  const closePicker = () => setPicker(null);
  const pickVariant = (variant: VariantSummary) => {
    if (!picker) return;
    registerVariant(variant);
    if (picker.kind === "pool") {
      if (!gt.samplePool.some((e) => e.variantId === variant.id) && gt.samplePool.length < poolCap) {
        setGt({
          samplePool: [...gt.samplePool, { variantId: variant.id, handle: variant.productHandle }],
        });
      }
    } else {
      updateOption(picker.clusterId, picker.tier, picker.slot, picker.option, {
        kind: "variant",
        variantId: variant.id,
        handle: variant.productHandle,
        count: "1",
      });
    }
    setPicker(null);
  };

  const thumbFor = (option: GiftOptionRow): string | undefined =>
    option.kind === "variant" ? (variantIndex[option.variantId]?.imageUrl ?? undefined) : undefined;

  const marketName = (handle: string) => markets.find((m) => m.handle === handle)?.name ?? handle;

  // ---- Stock table --------------------------------------------------------
  const stockColumns = (() => {
    const seen = new Map<string, string>();
    for (const cluster of gt.clusters) {
      for (const tier of cluster.tiers) {
        for (const slot of tier.slots) {
          for (const option of slot) {
            if (option.kind === "variant" && option.variantId) {
              const nid = numericId(option.variantId);
              if (nid && !seen.has(nid)) {
                const v = variantIndex[option.variantId];
                seen.set(nid, v ? variantLabel(v) : option.handle || shortGid(option.variantId));
              }
            }
          }
        }
      }
    }
    for (const entry of gt.samplePool) {
      const nid = numericId(entry.variantId);
      if (nid && !seen.has(nid)) {
        const v = variantIndex[entry.variantId];
        seen.set(nid, `${v ? variantLabel(v) : entry.handle} (sachet)`);
      }
    }
    for (const entries of Object.values(stockView.byCluster)) {
      for (const nid of Object.keys(entries)) {
        if (!seen.has(nid)) seen.set(nid, `#${nid}`);
      }
    }
    return [...seen.entries()];
  })();
  const stockClusters = Object.keys(stockView.byCluster).sort();
  const clusterName = (id: string) => gt.clusters.find((c) => c.id === id)?.name ?? id;
  const stockRows = stockClusters.map((id) => [
    clusterName(id),
    ...stockColumns.map(([nid]) => {
      const entry = stockView.byCluster[id]?.[nid];
      if (!entry) return "not checked";
      // v18: -1 means Shopify has no inventory row at this cluster's
      // warehouses. That is unknown, not zero, and never pauses a gift.
      if (entry.avail === UNKNOWN_AVAIL) return "unknown";
      return entry.paused ? `${entry.avail} · paused` : String(entry.avail);
    }),
  ]);
  const pausedTotal = stockClusters.reduce(
    (n, id) => n + Object.values(stockView.byCluster[id] ?? {}).filter((e) => e.paused).length,
    0,
  );

  const renderTierCard = (cluster: GiftClusterRow, tier: GiftTierRow, ti: number) => {
    const errors = clusterErrors[cluster.id]?.tierErrors[ti];
    const giftNames = tier.slots
      .map((slot) => (slot[0] ? giftOptionLabel(slot[0], variantIndex) : ""))
      .filter((s) => s !== "");
    return (
      <Box key={`gt-${cluster.id}-tier-${ti}`} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
        <BlockStack gap="300">
          <InlineStack gap="300" blockAlign="start" wrap align="space-between">
            <InlineStack gap="300" blockAlign="start" wrap>
              <Box width="170px">
                <TextField
                  label={`Tier ${ti + 1} — spend from`}
                  type="number"
                  prefix="€"
                  min={0}
                  value={tier.amount}
                  onChange={(amount) => updateTier(cluster.id, ti, { amount })}
                  error={errors?.amount}
                  autoComplete="off"
                />
              </Box>
              <Box paddingBlockStart="600">
                <Text as="p" variant="bodyMd">
                  {giftNames.length > 0
                    ? `Spend ${formatEur(tier.amount)} → gets ${giftNames.join(" + ")}`
                    : `Spend ${formatEur(tier.amount)} → add a gift below`}
                </Text>
              </Box>
            </InlineStack>
            <Box paddingBlockStart="600">
              <Button
                icon={DeleteIcon}
                variant="tertiary"
                accessibilityLabel={`Remove tier ${ti + 1}`}
                onClick={() => removeTier(cluster.id, ti)}
              />
            </Box>
          </InlineStack>
          {errors?.tier ? (
            <Text as="p" tone="critical" variant="bodySm">
              {errors.tier}
            </Text>
          ) : null}
          <InlineStack gap="200" wrap blockAlign="center">
            {tier.slots.map((slot, si) => {
              const primary = slot[0];
              const optionError = errors?.slots[si]?.[0] ?? "";
              const isPicking =
                picker?.kind === "option" && picker.tier === ti && picker.slot === si && picker.option === 0;
              return (
                <Box
                  key={`gt-slot-${ti}-${si}`}
                  padding="200"
                  background="bg-surface-secondary"
                  borderRadius="200"
                >
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    {primary?.kind === "variant" ? (
                      <Thumbnail
                        source={thumbFor(primary) ?? ImageIcon}
                        alt={giftOptionLabel(primary, variantIndex)}
                        size="small"
                      />
                    ) : null}
                    {primary?.kind === "samples" ? (
                      <Box width="90px">
                        <TextField
                          label="Sachets"
                          labelHidden
                          type="number"
                          min={1}
                          max={CAPS.samplesPerOption}
                          value={primary.count}
                          onChange={(count) => updateOption(cluster.id, ti, si, 0, { count })}
                          autoComplete="off"
                        />
                      </Box>
                    ) : null}
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      {primary ? giftOptionLabel(primary, variantIndex) : "Empty"}
                    </Text>
                    {primary?.kind === "variant" ? (
                      <Button
                        size="slim"
                        variant="plain"
                        onClick={() =>
                          setPicker(isPicking ? null : { kind: "option", clusterId: cluster.id, tier: ti, slot: si, option: 0 })
                        }
                      >
                        {isPicking ? "Cancel" : primary.variantId || primary.handle ? "Change" : "Pick a product"}
                      </Button>
                    ) : null}
                    <Button
                      icon={DeleteIcon}
                      variant="tertiary"
                      size="slim"
                      accessibilityLabel="Remove this gift"
                      onClick={() => updateSlots(cluster.id, ti, tier.slots.filter((_, i) => i !== si))}
                    />
                  </InlineStack>
                  {optionError ? (
                    <Text as="p" tone="critical" variant="bodySm">
                      {optionError}
                    </Text>
                  ) : null}
                </Box>
              );
            })}
            <Button
              size="slim"
              icon={PlusIcon}
              disabled={tier.slots.length >= CAPS.giftSlots}
              onClick={() => {
                const next = [...tier.slots, [{ kind: "variant" as const, variantId: "", handle: "", count: "1" }]];
                updateSlots(cluster.id, ti, next);
                setPicker({ kind: "option", clusterId: cluster.id, tier: ti, slot: next.length - 1, option: 0 });
              }}
            >
              Add a gift product
            </Button>
            <Button
              size="slim"
              icon={PlusIcon}
              disabled={tier.slots.length >= CAPS.giftSlots}
              onClick={() =>
                updateSlots(cluster.id, ti, [...tier.slots, [{ kind: "samples", variantId: "", handle: "", count: "2" }]])
              }
            >
              Add sample sachets
            </Button>
          </InlineStack>
          {picker?.kind === "option" && picker.tier === ti && picker.option === 0 ? (
            <GiftPicker title="Pick the gift product" onPick={pickVariant} onClose={closePicker} />
          ) : null}
          {showBackups
            ? tier.slots.map((slot, si) =>
                slot[0]?.kind === "variant" ? (
                  <Box key={`gt-backup-${ti}-${si}`} paddingInlineStart="300">
                    <BlockStack gap="100">
                      <Text as="p" tone="subdued" variant="bodySm">
                        Backups for {giftOptionLabel(slot[0], variantIndex)} (used when the gift is
                        out of stock, in this order):
                      </Text>
                      <InlineStack gap="200" wrap blockAlign="center">
                        {slot.slice(1).map((option, k) => {
                          const oi = k + 1;
                          const picking =
                            picker?.kind === "option" &&
                            picker.tier === ti &&
                            picker.slot === si &&
                            picker.option === oi;
                          return (
                            <InlineStack key={`gt-bk-${ti}-${si}-${oi}`} gap="100" blockAlign="center">
                              <Text as="span" variant="bodySm">
                                {giftOptionLabel(option, variantIndex)}
                              </Text>
                              <Button
                                size="micro"
                                variant="plain"
                                onClick={() =>
                                  setPicker(picking ? null : { kind: "option", clusterId: cluster.id, tier: ti, slot: si, option: oi })
                                }
                              >
                                {picking ? "Cancel" : "Change"}
                              </Button>
                              <Button
                                size="micro"
                                variant="plain"
                                tone="critical"
                                onClick={() =>
                                  updateSlots(
                                    cluster.id,
                                    ti,
                                    tier.slots.map((s, i) => (i === si ? s.filter((_, j) => j !== oi) : s)),
                                  )
                                }
                              >
                                Remove
                              </Button>
                              {errors?.slots[si]?.[oi] ? (
                                <Text as="span" tone="critical" variant="bodySm">
                                  {errors.slots[si][oi]}
                                </Text>
                              ) : null}
                            </InlineStack>
                          );
                        })}
                        <Button
                          size="micro"
                          disabled={slot.length >= CAPS.giftOptionsPerSlot}
                          onClick={() => {
                            const nextSlots = tier.slots.map((s, i) =>
                              i === si ? [...s, { kind: "variant" as const, variantId: "", handle: "", count: "1" }] : s,
                            );
                            updateSlots(cluster.id, ti, nextSlots);
                            setPicker({ kind: "option", clusterId: cluster.id, tier: ti, slot: si, option: slot.length });
                          }}
                        >
                          Add a backup
                        </Button>
                      </InlineStack>
                      {picker?.kind === "option" && picker.tier === ti && picker.slot === si && picker.option > 0 ? (
                        <GiftPicker title="Pick the backup product" onPick={pickVariant} onClose={closePicker} />
                      ) : null}
                    </BlockStack>
                  </Box>
                ) : null,
              )
            : null}
        </BlockStack>
      </Box>
    );
  };

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <Text as="h2" variant="headingMd">
              Free gifts
            </Text>
            <InlineStack gap="200" blockAlign="center">
              <Badge>{`${gt.clusters.length} cluster${gt.clusters.length === 1 ? "" : "s"}`}</Badge>
              <Badge tone={gt.enabled ? "success" : undefined}>{gt.enabled ? "On" : "Off"}</Badge>
            </InlineStack>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            Shoppers who spend past a tier get a free gift. The cart shows a
            reward ladder towards the next one, the app adds the gift line at
            100 % off, and a gift that runs out of stock is paused for the
            cluster it belongs to.
          </Text>
          <Checkbox
            label="Turn free gifts on"
            checked={gt.enabled}
            onChange={(enabled) => setGt({ enabled })}
          />
          <InlineStack gap="200" blockAlign="center" wrap>
            <Text as="p" tone="subdued" variant="bodySm">
              Where it shows: {reach}
            </Text>
            <Button variant="plain" onClick={onEditMarkets}>
              Change markets
            </Button>
          </InlineStack>
          <Divider />
          <InlineStack gap="300" blockAlign="center" wrap>
            <Button onClick={onLoadPreset} loading={presetLoading}>
              Load the default clusters
            </Button>
            <Text as="p" tone="subdued" variant="bodySm">
              Replaces the clusters below with the recommended ones, looked up
              in your store. Nothing is saved until you press Save.
            </Text>
          </InlineStack>
          {presetNotes.length > 0 ? (
            <Banner tone="warning" title="Defaults loaded with notes">
              <BlockStack gap="100">
                {presetNotes.map((note) => (
                  <Text as="p" key={note}>
                    {note}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          ) : null}
          <InlineStack align="space-between" blockAlign="center" wrap>
            <Text as="h3" variant="headingSm">
              Clusters (amounts in EUR; each country converts under Advanced)
            </Text>
            <Button variant="plain" onClick={() => setShowBackups((v) => !v)}>
              {showBackups ? "Hide backup gifts" : "Show backup gifts"}
            </Button>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            A cluster is a group of countries that share one reward ladder,
            usually because they ship from the same warehouse. Every country
            belongs to exactly one cluster, and the catch-all at the bottom
            covers everything you have not listed, so a country can never end
            up with no answer.
          </Text>
          {gt.clusters.map((cluster) => {
            const open = openCluster === cluster.id;
            const tierSummary =
              cluster.tiers.length === 0
                ? "no tier yet"
                : cluster.tiers.map((t) => formatEur(t.amount)).join(" · ");
            return (
              <Box
                key={`cluster-${cluster.id}`}
                padding="300"
                borderColor="border"
                borderWidth="025"
                borderRadius="200"
              >
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center" wrap>
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Text as="h4" variant="headingSm">
                        {cluster.name}
                      </Text>
                      {cluster.rest ? <Badge tone="info">Catch-all</Badge> : null}
                      <Text as="span" tone="subdued" variant="bodySm">
                        {cluster.rest
                          ? "every country not listed above"
                          : `${cluster.countries.length} countr${cluster.countries.length === 1 ? "y" : "ies"}`}
                        {" · "}
                        {tierSummary}
                      </Text>
                    </InlineStack>
                    <InlineStack gap="200" blockAlign="center">
                      <Button
                        variant="plain"
                        onClick={() => setOpenCluster(open ? "" : cluster.id)}
                      >
                        {open ? "Close" : "Edit"}
                      </Button>
                      {cluster.rest ? null : (
                        <Button
                          icon={DeleteIcon}
                          variant="tertiary"
                          accessibilityLabel={`Remove ${cluster.name}`}
                          onClick={() => removeCluster(cluster.id)}
                        />
                      )}
                    </InlineStack>
                  </InlineStack>
                  <Collapsible id={`cluster-body-${cluster.id}`} open={open}>
                    <BlockStack gap="300">
                      <InlineStack gap="300" blockAlign="start" wrap>
                        <Box width="260px">
                          <TextField
                            label="Cluster name"
                            value={cluster.name}
                            onChange={(name) => updateCluster(cluster.id, { name })}
                            autoComplete="off"
                            maxLength={60}
                          />
                        </Box>
                        <Box width="320px">
                          <TextField
                            label="Countries"
                            value={cluster.rest ? "" : cluster.countries.join(", ")}
                            disabled={cluster.rest}
                            helpText={
                              cluster.rest
                                ? "The catch-all covers every country you have not listed in another cluster."
                                : "Two-letter codes, comma separated. A country listed here is removed from any other cluster."
                            }
                            onChange={(value) => {
                              const codes = value
                                .split(/[\s,]+/)
                                .map((c) => c.trim().toUpperCase())
                                .filter((c) => /^[A-Z]{2}$/.test(c));
                              const wanted = new Set(codes);
                              for (const code of codes) {
                                if (!cluster.countries.includes(code)) {
                                  toggleClusterCountry(cluster.id, code, true);
                                }
                              }
                              for (const code of cluster.countries) {
                                if (!wanted.has(code)) toggleClusterCountry(cluster.id, code, false);
                              }
                            }}
                            autoComplete="off"
                            multiline={2}
                          />
                        </Box>
                      </InlineStack>
                      <BlockStack gap="100">
                        <Text as="p" variant="bodySm" fontWeight="semibold">
                          Warehouses that serve this cluster
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          Stock is checked at these locations. Leave them all
                          unticked to check every active location.
                        </Text>
                        <InlineStack gap="300" wrap>
                          {locations.map((location) => (
                            <Checkbox
                              key={`${cluster.id}-${location.id}`}
                              label={location.countryCode ? `${location.name} (${location.countryCode})` : location.name}
                              checked={cluster.locations.includes(location.id)}
                              onChange={(checked) =>
                                toggleClusterLocation(cluster.id, location.id, checked)
                              }
                            />
                          ))}
                        </InlineStack>
                      </BlockStack>
                      {cluster.tiers.map((tier, ti) => renderTierCard(cluster, tier, ti))}
                      {(clusterErrors[cluster.id]?.formErrors ?? []).map((error) => (
                        <Text as="p" tone="critical" variant="bodySm" key={error}>
                          {error}
                        </Text>
                      ))}
                      <InlineStack>
                        <Button
                          icon={PlusIcon}
                          onClick={() => addTier(cluster.id)}
                          disabled={cluster.tiers.length >= CAPS.giftTiers}
                        >
                          Add a tier to {cluster.name}
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </Collapsible>
                </BlockStack>
              </Box>
            );
          })}
          {formErrors.map((error) => (
            <Text as="p" tone="critical" variant="bodySm" key={error}>
              {error}
            </Text>
          ))}
          <InlineStack>
            <Button
              icon={PlusIcon}
              onClick={addCluster}
              disabled={gt.clusters.length >= CAPS.clusters}
            >
              Add a cluster
            </Button>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            Every gift of a reached tier is granted{gt.cumulative ? ", and the gifts of the lower tiers stay" : ""}.
            “Sample sachets” are taken from the sample pool under Advanced.
          </Text>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            On product pages
          </Text>
          <Checkbox
            label="Show a line on product pages"
            checked={gt.pdpEnabled}
            onChange={(pdpEnabled) => setGt({ pdpEnabled })}
            helpText="Reads the shopper's cart, so it can say how far they are from the next gift rather than just advertising it."
          />
          {gt.pdpEnabled ? (
            <ChoiceList
              title="Where it goes and how it looks"
              choices={(["card", "line", "ladder"] as const).map((style) => ({
                label: GIFT_PDP_STYLE_LABELS[style],
                value: style,
              }))}
              selected={[gt.pdpStyle]}
              onChange={(values) => {
                const next = values[0];
                if (next === "line" || next === "card" || next === "ladder") {
                  setGt({ pdpStyle: next });
                }
              }}
            />
          ) : null}
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h3" variant="headingSm">
              Advanced
            </Text>
            <Button
              variant="plain"
              onClick={() => setAdvancedOpen((open) => !open)}
              ariaExpanded={advancedOpen}
              ariaControls="gt-advanced"
            >
              {advancedOpen ? "Hide" : "Show"}
            </Button>
          </InlineStack>
          <Collapsible id="gt-advanced" open={advancedOpen}>
            <BlockStack gap="400">
              {/* ---- Rules ---- */}
              <BlockStack gap="200">
                <Text as="h4" variant="headingSm">
                  Rules
                </Text>
                <Checkbox
                  label="A higher tier keeps the gifts of the lower tiers"
                  checked={gt.cumulative}
                  onChange={(cumulative) => setGt({ cumulative })}
                />
                <ChoiceList
                  title="Who picks the gift"
                  choices={[
                    { label: "The app — first available gift of each tier", value: "auto" },
                    {
                      label: "The shopper — a “Swap gift” link appears when a backup exists",
                      value: "choose",
                    },
                  ]}
                  selected={[gt.choice]}
                  onChange={(selection) => setGt({ choice: selection[0] === "choose" ? "choose" : "auto" })}
                />
                <InlineStack gap="300" wrap>
                  <Box width="180px">
                    <TextField
                      label="Max gift lines per cart"
                      type="number"
                      min={1}
                      max={CAPS.maxGiftLines}
                      value={gt.maxGiftLines}
                      onChange={(maxGiftLines) => setGt({ maxGiftLines })}
                      error={maxGiftLinesError}
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="280px">
                    <Select
                      label="Sample sachets are picked"
                      options={[
                        { label: "Not already in the cart (then rotate)", value: "not_in_cart" },
                        { label: "Rotate from cart to cart", value: "rotate" },
                        { label: "Always the first ones of the pool", value: "fixed" },
                      ]}
                      value={gt.sampleRule}
                      onChange={(sampleRule) => setGt({ sampleRule: sampleRule as SampleRule })}
                    />
                  </Box>
                </InlineStack>
                <Checkbox
                  label="Show the free-shipping milestone on the cart progress bar"
                  helpText="Uses the market's free-shipping threshold (Settings → Free shipping)."
                  checked={gt.showShippingMilestone}
                  onChange={(showShippingMilestone) => setGt({ showShippingMilestone })}
                />
              </BlockStack>

              <Divider />
              {/* ---- Sample pool ---- */}
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h4" variant="headingSm">
                    Sample pool (sachets)
                  </Text>
                  <InlineStack gap="200">
                    <Button size="slim" onClick={onLoadSachets} loading={sachetsLoading} disabled={poolFull}>
                      Load my sachets
                    </Button>
                    <Button
                      size="slim"
                      disabled={poolFull}
                      onClick={() => setPicker(picker?.kind === "pool" ? null : { kind: "pool" })}
                    >
                      {picker?.kind === "pool" ? "Cancel" : "Add a sachet"}
                    </Button>
                  </InlineStack>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  “Load my sachets” adds every active product tagged
                  sample-sachet (at most {poolCap} in the pool). Sachets pause
                  when fewer than 100 are in stock.
                </Text>
                {poolError ? (
                  <Text as="p" tone="critical" variant="bodySm">
                    {poolError}
                  </Text>
                ) : poolFull ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    The pool is full ({poolCap} of {poolCap}) — remove a sachet to add another.
                  </Text>
                ) : null}
                {poolNote ? (
                  <Text as="p" tone="caution" variant="bodySm">
                    {poolNote}
                  </Text>
                ) : null}
                {sachetsErrors.length > 0 ? (
                  <Text as="p" tone="critical" variant="bodySm">
                    {sachetsErrors.join(" ")}
                  </Text>
                ) : null}
                {gt.samplePool.length > 0 ? (
                  <InlineStack gap="200" wrap>
                    {gt.samplePool.map((entry) => {
                      const v = variantIndex[entry.variantId];
                      return (
                        <Tag
                          key={entry.variantId}
                          onRemove={() =>
                            setGt({ samplePool: gt.samplePool.filter((e) => e.variantId !== entry.variantId) })
                          }
                        >
                          {v ? variantLabel(v) : entry.handle}
                        </Tag>
                      );
                    })}
                  </InlineStack>
                ) : (
                  <Text as="p" tone="subdued" variant="bodySm">
                    The pool is empty — “sample sachets” gifts grant nothing until you add some.
                  </Text>
                )}
                {picker?.kind === "pool" ? (
                  <GiftPicker title="Add a sachet to the sample pool" onPick={pickVariant} onClose={closePicker} />
                ) : null}
              </BlockStack>

              <Divider />
              {/* ---- v18 per-country amounts ---- */}
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h4" variant="headingSm">
                    Amounts per country
                  </Text>
                  <Button
                    size="slim"
                    onClick={onSuggestAmounts}
                    loading={suggestLoading}
                    disabled={gt.clusters.every((cluster) => cluster.tiers.length === 0)}
                  >
                    Suggest from local prices
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  A blank row scales that country's cluster ladder by its own
                  price level and rounds it to a clean number, which is what
                  most countries should use. “Suggest from local prices” fills
                  every row with what it would be, so you can see and change
                  them. Review, then Save.
                </Text>
                {suggestNotes.length > 0 ? (
                  <Banner tone="warning" title="Suggestion notes">
                    <BlockStack gap="100">
                      {suggestNotes.map((note) => (
                        <Text as="p" key={note}>
                          {note}
                        </Text>
                      ))}
                    </BlockStack>
                  </Banner>
                ) : null}
                <BlockStack gap="300">
                  {gt.clusters.map((cluster) => {
                    const codes = cluster.rest
                      ? Object.keys(gt.thresholds)
                          .filter(
                            (code) =>
                              !gt.clusters.some((c) => !c.rest && c.countries.includes(code)),
                          )
                          .sort()
                      : cluster.countries;
                    return (
                      <BlockStack gap="200" key={`amt-${cluster.id}`}>
                        <Text as="p" variant="bodySm" fontWeight="semibold">
                          {cluster.name}
                          {cluster.rest && codes.length === 0
                            ? ": no country has its own amounts yet"
                            : ""}
                        </Text>
                        {codes.map((code) => {
                          const row = gt.thresholds[code];
                          const error = thresholdErrors[code];
                          const currency = row?.currencyCode || "EUR";
                          return (
                            <InlineStack key={`th-${code}`} gap="300" blockAlign="start" wrap>
                              <Box width="90px" paddingBlockStart="200">
                                <Text as="span" variant="bodyMd">
                                  {code}
                                </Text>
                              </Box>
                              {cluster.tiers.map((tier, ti) => (
                                <Box width="130px" key={`th-${code}-${ti}`}>
                                  <TextField
                                    label={`Tier ${ti + 1}`}
                                    labelHidden
                                    type="number"
                                    min={0}
                                    suffix={currency}
                                    placeholder={tier.amount || "auto"}
                                    value={row?.amounts[ti] ?? ""}
                                    onChange={(value) => setThresholdAmount(code, currency, ti, value)}
                                    error={ti === 0 ? error : undefined}
                                    autoComplete="off"
                                  />
                                </Box>
                              ))}
                              {row && row.amounts.some((a) => a.trim() !== "") ? (
                                <Box paddingBlockStart="100">
                                  <Button variant="plain" onClick={() => clearThreshold(code)}>
                                    Use automatic
                                  </Button>
                                </Box>
                              ) : null}
                            </InlineStack>
                          );
                        })}
                      </BlockStack>
                    );
                  })}
                </BlockStack>
              </BlockStack>

              <Divider />
              {/* ---- Warehouses & stock ---- */}
              <BlockStack gap="200">
                <Text as="h4" variant="headingSm">
                  Warehouses & stock
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Tick the locations that ship each market so gift stock is
                  read where it matters (no tick = every active location). A
                  gift pauses in a market when its stock is below the minimum
                  (sachets: at least 100).
                </Text>
                <InlineStack gap="300" wrap>
                  <Box width="160px">
                    <TextField
                      label="Minimum units in stock"
                      type="number"
                      min={0}
                      value={gt.stockFloorMinUnits}
                      onChange={(stockFloorMinUnits) => setGt({ stockFloorMinUnits })}
                      error={stockMinError}
                      autoComplete="off"
                    />
                  </Box>
                  <Box width="160px">
                    <TextField
                      label="Days of cover"
                      type="number"
                      min={0}
                      max={60}
                      helpText="Reserved for a later version."
                      value={gt.stockFloorDays}
                      onChange={(stockFloorDays) => setGt({ stockFloorDays })}
                      error={stockDaysError}
                      autoComplete="off"
                    />
                  </Box>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Warehouses are chosen per cluster, on each cluster's own
                  card above, because a cluster is a fulfilment centre. A gift
                  with no inventory record at all at those locations counts as
                  unknown rather than zero, and is never paused.
                </Text>
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h4" variant="headingSm">
                    Gift stock by cluster
                  </Text>
                  <Button size="slim" onClick={onRefreshStock} loading={stockLoading}>
                    Check stock now
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  {stockView.t
                    ? `Last checked ${stockView.t.replace("T", " ").slice(0, 16)} UTC · ${pausedTotal} paused gift(s).`
                    : "Not checked yet."}{" "}
                  Uses the saved gifts — save first after changing them. Checked
                  again automatically every 15 minutes and on inventory changes.
                </Text>
                {stockNote ? (
                  <Text as="p" tone="critical" variant="bodySm">
                    {stockNote}
                  </Text>
                ) : null}
                {stockErrors.length > 0 ? (
                  <Text as="p" tone="critical" variant="bodySm">
                    {stockErrors.join(" ")}
                  </Text>
                ) : null}
                {stockRows.length > 0 && stockColumns.length > 0 ? (
                  <Box overflowX="scroll">
                    <DataTable
                      columnContentTypes={["text", ...stockColumns.map(() => "text" as const)]}
                      headings={["Market", ...stockColumns.map(([, label]) => label)]}
                      rows={stockRows}
                      increasedTableDensity
                    />
                  </Box>
                ) : (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No stock data yet — configure gifts, save, then check stock.
                  </Text>
                )}
              </BlockStack>
            </BlockStack>
          </Collapsible>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}
