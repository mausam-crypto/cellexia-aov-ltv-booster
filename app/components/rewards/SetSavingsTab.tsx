import { useEffect, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Collapsible,
  DataTable,
  Divider,
  InlineStack,
  Select,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import { DeleteIcon, PlusIcon } from "@shopify/polaris-icons";
import { MarketProductExclusionsCard } from "../MarketExclusions";
import {
  CAPS,
  LADDER_PRESET_LABELS,
  normalizeYieldCodes,
  stackedPct,
  type DiscountNodesView,
  type LadderPresetKey,
  type MarketOption,
  type PresetTables,
  type RewardsFormState,
  type SetSavingsRowErrors,
  type SetSavingsTierRow,
} from "./shared";

/**
 * "Set savings" tab (v15): essentials first (on/off, tier table with example
 * sentences, discount-code status), then an "Advanced" section
 * (subscriptions, checkout line text, step-aside codes, storefront
 * switches, excluded products, stacking table).
 */

export interface SetSavingsTabProps {
  ss: RewardsFormState["ss"];
  setSs: (patch: Partial<RewardsFormState["ss"]>) => void;
  updateTier: (index: number, update: Partial<SetSavingsTierRow>) => void;
  removeTier: (index: number) => void;
  addTier: () => void;
  applyLadderPreset: (preset: LadderPresetKey) => void;
  presets: PresetTables;
  rowErrors: SetSavingsRowErrors[];
  formErrors: string[];
  checkoutMessageError?: string;
  /** v15.1: rewards.setSavings.blockedCodes — SERVER-WRITTEN by "Create
   *  discount codes": tier codes owned by another discount in the store.
   *  Read-only here; the storefront and checkout never attach them. */
  blockedCodes: string[];
  /** Bumped by the route when a "Fix these before saving" line points into
   *  this tab's Advanced section — opens it. */
  advancedSignal?: number;
  nodes: DiscountNodesView;
  markets: MarketOption[];
  reach: string;
  onEditMarkets: () => void;
  exclusionTitles: Record<string, string>;
  disabled: boolean;
  /** Volume-discount percentages of the cart page (for the stacking table). */
  volumePcts: number[];
  /** "Detect my existing KIT codes" — the route runs the intent. */
  onDetectCodes: (prefixes: string) => void;
  detectLoading: boolean;
  detectResult: { ok: boolean; codes: string[]; errors: string[] } | null;
}

const JOY_WORST_CASE_PCT = 5;

function exampleSentence(row: SetSavingsTierRow): string {
  const count = Number(row.count);
  const pct = Number(row.pct);
  const code = row.code.trim().toUpperCase();
  if (!Number.isFinite(count) || count < 2 || !Number.isFinite(pct) || pct <= 0 || code === "") {
    return "Fill in the row to see the example.";
  }
  return `A cart with ${count} different products gets ${pct} % off${code ? ` — code ${code}` : ""}.`;
}

export function SetSavingsTab({
  ss,
  setSs,
  updateTier,
  removeTier,
  addTier,
  applyLadderPreset,
  presets,
  rowErrors,
  formErrors,
  checkoutMessageError,
  blockedCodes,
  advancedSignal = 0,
  nodes,
  markets,
  reach,
  onEditMarkets,
  exclusionTitles,
  disabled,
  volumePcts,
  onDetectCodes,
  detectLoading,
  detectResult,
}: SetSavingsTabProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    if (advancedSignal > 0) setAdvancedOpen(true);
  }, [advancedSignal]);
  const blocked = new Set(blockedCodes.map((c) => c.trim().toUpperCase()));
  const [yieldDraft, setYieldDraft] = useState("");
  const [detectPrefix, setDetectPrefix] = useState("KIT");
  const [yieldNote, setYieldNote] = useState<string | undefined>(undefined);

  const addYieldCodes = (raw: string[]) => {
    const merged = normalizeYieldCodes([...ss.yieldToCodes, ...raw], ss.tiers);
    setSs({ yieldToCodes: merged.codes });
    setYieldNote(merged.error);
    setYieldDraft("");
  };

  const validTiers = ss.tiers
    .filter((row, i) => !rowErrors[i]?.pct && !rowErrors[i]?.count)
    .map((row) => ({ count: Number(row.count), pct: Number(row.pct), code: row.code.trim().toUpperCase() }));
  const stackingHeadings = [
    "Set savings tier",
    ...volumePcts.map((l) => `+ ${l}% volume discount`),
    ...volumePcts.map((l) => `+ ${l}% volume + ${JOY_WORST_CASE_PCT}% referral code`),
  ];
  const stackingRows = validTiers.map((tier) => [
    `${tier.code} (${tier.count}+ products, ${tier.pct}%)`,
    ...volumePcts.map((v) => stackedPct([v, tier.pct])),
    ...volumePcts.map((v) => stackedPct([v, tier.pct, JOY_WORST_CASE_PCT])),
  ]);

  const presetOptions = presets.ladderKeys.map((key) => ({
    label: LADDER_PRESET_LABELS[key],
    value: key,
  }));

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center" wrap>
            <Text as="h2" variant="headingMd">
              Set savings
            </Text>
            <Badge tone={ss.enabled ? "success" : undefined}>{ss.enabled ? "On" : "Off"}</Badge>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            Shoppers who buy several different products save a growing
            percentage on the whole set. The app adds the matching discount
            code to the cart by itself; Shopify only takes the percentage off
            when the cart really holds that many different products.
          </Text>
          <Checkbox
            label="Turn set savings on"
            helpText="Shows the savings messages in the cart and on product pages and lets the app add the discount code."
            checked={ss.enabled}
            onChange={(enabled) => setSs({ enabled })}
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
          <Select
            label="Tiers"
            options={presetOptions}
            value={ss.ladderPreset}
            onChange={(value) => {
              if (value === "compact" || value === "extended" || value === "custom") {
                applyLadderPreset(value);
              }
            }}
            helpText="Picking a preset replaces the table below. Editing the table switches to Custom."
          />
          <BlockStack gap="300">
            {ss.tiers.map((row, index) => (
              <Box
                key={`ss-tier-${index}`}
                padding="300"
                background="bg-surface-secondary"
                borderRadius="200"
              >
                <BlockStack gap="200">
                  <InlineStack gap="300" blockAlign="start" wrap>
                    <Box width="150px">
                      <TextField
                        label="Different products"
                        type="number"
                        min={2}
                        max={50}
                        value={row.count}
                        onChange={(count) => updateTier(index, { count })}
                        error={rowErrors[index]?.count}
                        autoComplete="off"
                      />
                    </Box>
                    <Box width="120px">
                      <TextField
                        label="Discount"
                        type="number"
                        suffix="%"
                        min={1}
                        max={90}
                        value={row.pct}
                        onChange={(pct) => updateTier(index, { pct })}
                        error={rowErrors[index]?.pct}
                        autoComplete="off"
                      />
                    </Box>
                    <Box width="180px">
                      <TextField
                        label="Discount code"
                        value={row.code}
                        onChange={(code) =>
                          updateTier(index, { code: code.toUpperCase().replace(/\s+/g, "") })
                        }
                        error={
                          rowErrors[index]?.code ??
                          (blocked.has(row.code.trim().toUpperCase())
                            ? "Not created: this code is used by another discount in your store — change it"
                            : undefined)
                        }
                        autoComplete="off"
                        helpText={
                          blocked.has(row.code.trim().toUpperCase())
                            ? "Shoppers never get this code from the app until you change it"
                            : nodes.kit[row.code.trim().toUpperCase()]
                              ? "Created in Shopify"
                              : "Not created yet"
                        }
                      />
                    </Box>
                    <Box paddingBlockStart="600">
                      <Button
                        icon={DeleteIcon}
                        variant="tertiary"
                        accessibilityLabel={`Remove tier ${index + 1}`}
                        onClick={() => removeTier(index)}
                      />
                    </Box>
                  </InlineStack>
                  <Text as="p" variant="bodySm">
                    {exampleSentence(row)}
                  </Text>
                </BlockStack>
              </Box>
            ))}
            {formErrors.map((error) => (
              <Text as="p" tone="critical" variant="bodySm" key={error}>
                {error}
              </Text>
            ))}
            {blockedCodes.length > 0 ? (
              <Banner tone="warning" title="Some codes could not be created">
                <Text as="p">
                  {blockedCodes.join(", ")}: used by another discount in your
                  store. The app never changes or deletes that discount and
                  never adds these codes to a cart — the shopper gets the next
                  lower tier instead. Change the code in the table (or delete
                  that discount yourself), Save, then press “Create discount
                  codes” again.
                </Text>
              </Banner>
            ) : null}
            <InlineStack>
              <Button icon={PlusIcon} onClick={addTier} disabled={ss.tiers.length >= CAPS.setSavingsTiers}>
                Add a tier
              </Button>
            </InlineStack>
          </BlockStack>
          <Text as="p" tone="subdued" variant="bodySm">
            The codes above belong to the app. Your existing codes (for
            example KIT2 or KIT5) are never touched — if a shopper types one of
            them, the app steps aside and does not add its own code. See
            “Step-aside codes” under Advanced.
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
              ariaControls="ss-advanced"
            >
              {advancedOpen ? "Hide" : "Show"}
            </Button>
          </InlineStack>
          <Collapsible id="ss-advanced" open={advancedOpen}>
            <BlockStack gap="400">
              <Checkbox
                label="Subscription products count and get the saving on the first order"
                helpText="Off: subscription lines neither count as a product nor get the percentage."
                checked={ss.includeSubscriptions}
                onChange={(includeSubscriptions) => setSs({ includeSubscriptions })}
              />
              <TextField
                label="Text shown next to the discount at checkout"
                helpText='Leave blank for "Set savings −{pct}%". You may use {pct} for the percentage.'
                value={ss.checkoutMessage}
                onChange={(checkoutMessage) => setSs({ checkoutMessage })}
                error={checkoutMessageError}
                maxLength={CAPS.checkoutMessage}
                showCharacterCount
                autoComplete="off"
              />

              <Divider />
              <BlockStack gap="200">
                <Text as="h4" variant="headingSm">
                  Step-aside codes
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  When a shopper uses one of these codes, the app never adds
                  its own set-savings code and removes it if it was already
                  added. Use this for the discount codes you already run
                  (your old KIT codes, partner codes…). The app never edits or
                  deletes those discounts.
                </Text>
                {ss.yieldToCodes.length > 0 ? (
                  <InlineStack gap="200" wrap>
                    {ss.yieldToCodes.map((code) => (
                      <Tag
                        key={code}
                        onRemove={() =>
                          setSs({ yieldToCodes: ss.yieldToCodes.filter((c) => c !== code) })
                        }
                      >
                        {code}
                      </Tag>
                    ))}
                  </InlineStack>
                ) : (
                  <Text as="p" tone="subdued" variant="bodySm">
                    No step-aside codes yet.
                  </Text>
                )}
                <InlineStack gap="200" blockAlign="end" wrap>
                  <Box width="260px">
                    <TextField
                      label="Add codes"
                      labelHidden
                      placeholder="KIT2, KIT3, PARTNER10"
                      value={yieldDraft}
                      onChange={(value) => setYieldDraft(value.toUpperCase())}
                      autoComplete="off"
                      disabled={ss.yieldToCodes.length >= CAPS.yieldToCodes}
                    />
                  </Box>
                  <Button
                    onClick={() => addYieldCodes(yieldDraft.split(/[\s,;]+/))}
                    disabled={yieldDraft.trim() === "" || ss.yieldToCodes.length >= CAPS.yieldToCodes}
                  >
                    Add
                  </Button>
                  <Box width="120px">
                    <TextField
                      label="Prefix"
                      labelHidden
                      value={detectPrefix}
                      onChange={(value) => setDetectPrefix(value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
                      autoComplete="off"
                    />
                  </Box>
                  <Button
                    onClick={() => onDetectCodes(detectPrefix || "KIT")}
                    loading={detectLoading}
                  >
                    Detect my existing {detectPrefix || "KIT"} codes
                  </Button>
                </InlineStack>
                {yieldNote ? (
                  <Text as="p" tone="caution" variant="bodySm">
                    {yieldNote}
                  </Text>
                ) : null}
                {detectResult ? (
                  detectResult.errors.length > 0 ? (
                    <Banner tone="warning" title="Could not look up your discount codes">
                      <BlockStack gap="100">
                        {detectResult.errors.map((error) => (
                          <Text as="p" key={error}>
                            {error}
                          </Text>
                        ))}
                      </BlockStack>
                    </Banner>
                  ) : detectResult.codes.length === 0 ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      No discount code starting with “{detectPrefix || "KIT"}” was found in your
                      store — nothing to step aside for.
                    </Text>
                  ) : (
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm">
                        Found in your store: {detectResult.codes.join(", ")}.
                      </Text>
                      <InlineStack>
                        <Button size="slim" onClick={() => addYieldCodes(detectResult.codes)}>
                          Add all as step-aside codes
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  )
                ) : null}
              </BlockStack>

              <Divider />
              <BlockStack gap="200">
                <Text as="h4" variant="headingSm">
                  Where the savings messages appear
                </Text>
                <Checkbox
                  label="Product page line (“Add any second product, save X% on both”)"
                  checked={ss.surfaces.pdpLine}
                  onChange={(pdpLine) => setSs({ surfaces: { ...ss.surfaces, pdpLine } })}
                />
                <Checkbox
                  label="Similar-items caption"
                  checked={ss.surfaces.similarCaption}
                  onChange={(similarCaption) => setSs({ surfaces: { ...ss.surfaces, similarCaption } })}
                />
                <Checkbox
                  label="Frequently-bought-together caption and discounted total"
                  checked={ss.surfaces.fbtCaption}
                  onChange={(fbtCaption) => setSs({ surfaces: { ...ss.surfaces, fbtCaption } })}
                />
                <Checkbox
                  label="Cart message (“Add 1 more product to save X% on everything”)"
                  checked={ss.surfaces.cartNudge}
                  onChange={(cartNudge) => setSs({ surfaces: { ...ss.surfaces, cartNudge } })}
                />
                <Checkbox
                  label="Cart cross-sell title (“Complete your set & save X%”) with discounted prices"
                  checked={ss.surfaces.crossSellReframe}
                  onChange={(crossSellReframe) =>
                    setSs({ surfaces: { ...ss.surfaces, crossSellReframe } })
                  }
                />
              </BlockStack>

              <Divider />
              <BlockStack gap="200">
                <Text as="h4" variant="headingSm">
                  How discounts stack (worst case)
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Set-savings codes combine with product, order and shipping
                  discounts. A product already discounted by your volume
                  offer ({volumePcts.join("% / ")}%), plus a set-savings code,
                  plus a {JOY_WORST_CASE_PCT}% referral code ends up at the
                  total discount below.
                </Text>
                {stackingRows.length > 0 ? (
                  <Box overflowX="scroll">
                    <DataTable
                      columnContentTypes={stackingHeadings.map(() => "text")}
                      headings={stackingHeadings}
                      rows={stackingRows}
                      increasedTableDensity
                    />
                  </Box>
                ) : (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Add a valid tier to see the table.
                  </Text>
                )}
              </BlockStack>
            </BlockStack>
          </Collapsible>
        </BlockStack>
      </Card>

      {advancedOpen ? (
        <MarketProductExclusionsCard
          title="Excluded products — set savings"
          description="Products excluded for a market neither count as a different product nor get the percentage in that market."
          markets={markets}
          value={ss.excluded}
          titles={exclusionTitles}
          disabled={disabled}
          onChange={(next) => setSs({ excluded: next })}
        />
      ) : null}
    </BlockStack>
  );
}
