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
  GIFT_PRESET_BADGES,
  GIFT_PRESET_LABELS,
  formatEur,
  giftOptionLabel,
  isLoadableGiftPreset,
  numericId,
  shortGid,
  variantLabel,
  type GiftOptionRow,
  type GiftTierErrors,
  type GiftTierRow,
  type LoadableGiftPreset,
  type LocationOption,
  type MarketOption,
  type PresetTables,
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
  | { kind: "option"; tier: number; slot: number; option: number }
  | { kind: "pool" };

export interface GiftsTabProps {
  gt: RewardsFormState["gt"];
  setGt: (patch: Partial<RewardsFormState["gt"]>) => void;
  presets: PresetTables;
  variantIndex: Record<string, VariantSummary>;
  registerVariant: (variant: VariantSummary) => void;
  updateTier: (index: number, update: Partial<GiftTierRow>) => void;
  removeTier: (index: number) => void;
  addTier: () => void;
  updateSlots: (tier: number, slots: GiftOptionRow[][]) => void;
  updateOption: (tier: number, slot: number, option: number, update: Partial<GiftOptionRow>) => void;
  setThresholdAmount: (handle: string, currencyCode: string, index: number, value: string) => void;
  clearThreshold: (handle: string) => void;
  toggleWarehouse: (handle: string, locationId: string, checked: boolean) => void;
  tierErrors: GiftTierErrors[];
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
  giftPresetChoice: LoadableGiftPreset;
  setGiftPresetChoice: (preset: LoadableGiftPreset) => void;
  onLoadPreset: (preset: LoadableGiftPreset) => void;
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
    presets,
    variantIndex,
    registerVariant,
    updateTier,
    removeTier,
    addTier,
    updateSlots,
    updateOption,
    setThresholdAmount,
    clearThreshold,
    toggleWarehouse,
    tierErrors,
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
    giftPresetChoice,
    setGiftPresetChoice,
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
      updateOption(picker.tier, picker.slot, picker.option, {
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
    for (const tier of gt.tiers) {
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
    for (const entry of gt.samplePool) {
      const nid = numericId(entry.variantId);
      if (nid && !seen.has(nid)) {
        const v = variantIndex[entry.variantId];
        seen.set(nid, `${v ? variantLabel(v) : entry.handle} (sachet)`);
      }
    }
    for (const entries of Object.values(stockView.byMarket)) {
      for (const nid of Object.keys(entries)) {
        if (!seen.has(nid)) seen.set(nid, `#${nid}`);
      }
    }
    return [...seen.entries()];
  })();
  const stockMarkets = Object.keys(stockView.byMarket).sort();
  const stockRows = stockMarkets.map((handle) => [
    marketName(handle),
    ...stockColumns.map(([nid]) => {
      const entry = stockView.byMarket[handle]?.[nid];
      if (!entry) return "—";
      return entry.paused ? `${entry.avail} · paused` : String(entry.avail);
    }),
  ]);
  const pausedTotal = stockMarkets.reduce(
    (n, handle) => n + Object.values(stockView.byMarket[handle] ?? {}).filter((e) => e.paused).length,
    0,
  );

  const renderTierCard = (tier: GiftTierRow, ti: number) => {
    const errors = tierErrors[ti];
    const giftNames = tier.slots
      .map((slot) => (slot[0] ? giftOptionLabel(slot[0], variantIndex) : ""))
      .filter((s) => s !== "");
    return (
      <Box key={`gt-tier-${ti}`} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
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
                  onChange={(amount) => updateTier(ti, { amount })}
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
                onClick={() => removeTier(ti)}
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
                          onChange={(count) => updateOption(ti, si, 0, { count })}
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
                          setPicker(isPicking ? null : { kind: "option", tier: ti, slot: si, option: 0 })
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
                      onClick={() => updateSlots(ti, tier.slots.filter((_, i) => i !== si))}
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
                updateSlots(ti, next);
                setPicker({ kind: "option", tier: ti, slot: next.length - 1, option: 0 });
              }}
            >
              Add a gift product
            </Button>
            <Button
              size="slim"
              icon={PlusIcon}
              disabled={tier.slots.length >= CAPS.giftSlots}
              onClick={() =>
                updateSlots(ti, [...tier.slots, [{ kind: "samples", variantId: "", handle: "", count: "2" }]])
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
                                  setPicker(picking ? null : { kind: "option", tier: ti, slot: si, option: oi })
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
                            updateSlots(ti, nextSlots);
                            setPicker({ kind: "option", tier: ti, slot: si, option: slot.length });
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
              <Badge tone={gt.giftPreset === "custom" ? "info" : "attention"}>
                {GIFT_PRESET_BADGES[gt.giftPreset]}
              </Badge>
              <Badge tone={gt.enabled ? "success" : undefined}>{gt.enabled ? "On" : "Off"}</Badge>
            </InlineStack>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            Shoppers who spend more than a tier amount get a free gift. The
            cart shows a progress bar towards the next gift, the app adds the
            gift line at 100 % off, and a gift that runs out of stock is
            paused for that market.
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
          <InlineStack gap="300" blockAlign="end" wrap>
            <Box minWidth="320px">
              <Select
                label="Start from a preset"
                options={presets.giftKeys.map((key) => ({ label: GIFT_PRESET_LABELS[key], value: key }))}
                value={giftPresetChoice}
                onChange={(value) => {
                  if (isLoadableGiftPreset(value, presets.giftKeys)) setGiftPresetChoice(value);
                }}
              />
            </Box>
            <Button onClick={() => onLoadPreset(giftPresetChoice)} loading={presetLoading}>
              Use this preset
            </Button>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            “Use this preset” replaces the tiers below with the preset's
            gifts, looked up in your store. Nothing is saved until you press
            Save. Edit any tier afterwards — it then counts as Custom.
          </Text>
          {presetNotes.length > 0 ? (
            <Banner tone="warning" title="Preset loaded with notes">
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
              Tiers (amounts in EUR — other currencies under Advanced)
            </Text>
            <Button variant="plain" onClick={() => setShowBackups((v) => !v)}>
              {showBackups ? "Hide backup gifts" : "Show backup gifts"}
            </Button>
          </InlineStack>
          {gt.tiers.map(renderTierCard)}
          {formErrors.map((error) => (
            <Text as="p" tone="critical" variant="bodySm" key={error}>
              {error}
            </Text>
          ))}
          <InlineStack>
            <Button icon={PlusIcon} onClick={addTier} disabled={gt.tiers.length >= CAPS.giftTiers}>
              Add a tier
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
              {/* ---- Per-market amounts ---- */}
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h4" variant="headingSm">
                    Amounts per market
                  </Text>
                  <Button size="slim" onClick={onSuggestAmounts} loading={suggestLoading} disabled={gt.tiers.length === 0}>
                    Suggest from local prices
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Blank rows use the EUR amounts converted at Shopify's rate.
                  “Suggest from local prices” scales the EUR amounts by the
                  real price difference of your reference product in each
                  market and rounds them — review, then Save.
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
                {markets.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No markets could be loaded.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {markets.map((market) => {
                      const currency = market.currencyCode || "EUR";
                      const row = gt.thresholds[market.handle];
                      const error = thresholdErrors[market.handle];
                      return (
                        <InlineStack key={market.handle} gap="300" blockAlign="start" wrap>
                          <Box width="200px" paddingBlockStart="200">
                            <Text as="span" variant="bodyMd">
                              {market.name}
                              {market.primary ? " (primary)" : ""}
                            </Text>
                            <Text as="p" tone="subdued" variant="bodySm">
                              {currency}
                              {!market.enabled ? " · inactive" : ""}
                            </Text>
                          </Box>
                          {gt.tiers.map((_, ti) => (
                            <Box width="130px" key={`th-${market.handle}-${ti}`}>
                              <TextField
                                label={`Tier ${ti + 1}`}
                                labelHidden
                                type="number"
                                min={0}
                                suffix={currency}
                                placeholder={gt.tiers[ti]?.amount || "—"}
                                value={row?.amounts[ti] ?? ""}
                                onChange={(value) => setThresholdAmount(market.handle, currency, ti, value)}
                                error={ti === 0 ? error : undefined}
                                autoComplete="off"
                              />
                            </Box>
                          ))}
                          {row && row.amounts.some((a) => a.trim() !== "") ? (
                            <Box paddingBlockStart="100">
                              <Button variant="plain" onClick={() => clearThreshold(market.handle)}>
                                Use EUR amounts
                              </Button>
                            </Box>
                          ) : null}
                        </InlineStack>
                      );
                    })}
                    {Object.entries(gt.thresholds)
                      .filter(([handle]) => !markets.some((m) => m.handle === handle))
                      .map(([handle, row]) => (
                        <Text as="p" tone="subdued" variant="bodySm" key={handle}>
                          Stored amounts for “{handle}” (market not found): {row.amounts.join(" / ")}{" "}
                          {row.currencyCode} — kept until you clear them.{" "}
                          <Button variant="plain" onClick={() => clearThreshold(handle)}>
                            Clear
                          </Button>
                        </Text>
                      ))}
                  </BlockStack>
                )}
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
                {locations.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No locations could be loaded — every market reads all active locations.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {markets.map((market) => (
                      <BlockStack gap="100" key={`wh-${market.handle}`}>
                        <Text as="span" variant="bodyMd">
                          {market.name}
                          <Text as="span" tone="subdued" variant="bodySm">
                            {" "}
                            ({gt.warehouse[market.handle]?.length
                              ? `${gt.warehouse[market.handle].length} location(s)`
                              : "all active locations"})
                          </Text>
                        </Text>
                        <InlineStack gap="300" wrap>
                          {locations.map((location) => (
                            <Checkbox
                              key={`${market.handle}-${location.id}`}
                              label={location.countryCode ? `${location.name} (${location.countryCode})` : location.name}
                              checked={(gt.warehouse[market.handle] ?? []).includes(location.id)}
                              disabled={
                                !(gt.warehouse[market.handle] ?? []).includes(location.id) &&
                                (gt.warehouse[market.handle] ?? []).length >= CAPS.warehouseLocations
                              }
                              onChange={(checked) => toggleWarehouse(market.handle, location.id, checked)}
                            />
                          ))}
                        </InlineStack>
                      </BlockStack>
                    ))}
                  </BlockStack>
                )}
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <Text as="h4" variant="headingSm">
                    Gift stock by market
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
