import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Checkbox,
  DropZone,
  InlineStack,
  Select,
  Spinner,
  Tag,
  Text,
  TextField,
  Thumbnail,  Collapsible,
} from "@shopify/polaris";
import { ArrowDownIcon, ArrowUpIcon, ImageIcon, StarFilledIcon, StarIcon } from "@shopify/polaris-icons";
import { useAppBridge } from "@shopify/app-bridge-react";

/**
 * Shared form pieces for the /app/proof tabs (docs/SPEC-v8-proof-library.md
 * §5). Route modules deliberately do not share UI, but a components/ file is
 * allowed — these are the entry forms, the image field and the product tag
 * picker used identically by all three tabs.
 *
 * Every fetcher here submits to the CURRENT route: each proof tab's action
 * implements the same `upload_image` (multipart, stagedImageUpload pattern
 * from app.products.$id.tsx) and `search_products` intents. The image field
 * stores plain https CDN URLs (the proof tables hold URLs, not file GIDs),
 * so an uploaded file resolves to its Shopify Files URL and a pasted https
 * URL is stored as-is.
 */

export const PROOF_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The slice of a proof tab's action result the shared fields read. */
export interface ProofFieldActionData {
  intent: string;
  ok: boolean;
  errors: string[];
  /** upload_image */
  url?: string | null;
  previewUrl?: string | null;
  /** search_products */
  products?: ProofProductHit[];
}

export interface ProofProductHit {
  gid: string;
  title: string;
  imageUrl: string | null;
  status: string;
}

const HTTPS_PATTERN = /^https:\/\/\S+$/;

const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/\d+$/;

/** Client mirror of proof.server.ts parseProductGids — the routes' table and
 *  edit forms run in the browser where the .server module cannot be imported.
 *  Keep the two implementations behaviour-identical. */
export function parseProductGidList(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is string =>
            typeof entry === "string" && PRODUCT_GID_PATTERN.test(entry),
        )
      : [];
  } catch {
    return [];
  }
}

export function httpsUrlError(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed !== "" && !HTTPS_PATTERN.test(trimmed)
    ? "Must be an https:// URL (or leave empty)"
    : undefined;
}

// ---------------------------------------------------------------------------
// Image field — upload to Shopify Files (URL result) or paste an https URL
// ---------------------------------------------------------------------------

interface ProofImageFieldProps {
  label: string;
  /** Stored value — an https URL or "". */
  url: string;
  disabled: boolean;
  onChange: (url: string) => void;
  /** Optional guidance under the field (e.g. optimal-logo requirements). */
  helpText?: string;
}

export function ProofImageField({
  label,
  url,
  disabled,
  onChange,
  helpText,
}: ProofImageFieldProps) {
  const shopify = useAppBridge();
  const upload = useFetcher<ProofFieldActionData>();
  const [urlText, setUrlText] = useState("");
  const busy = upload.state !== "idle";

  useEffect(() => {
    const data = upload.data;
    if (!data || data.intent !== "upload_image") return;
    const resolved = data.url ?? data.previewUrl ?? null;
    if (data.ok && resolved) {
      onChange(resolved);
      shopify.toast.show("Image uploaded");
    } else if (data.ok) {
      // The file GID exists but the CDN URL is still processing — the proof
      // tables store URLs, so ask for a retry instead of storing nothing.
      shopify.toast.show(
        "Shopify is still processing the image — try again in a few seconds",
        { isError: true },
      );
    } else {
      shopify.toast.show(data.errors[0] ?? "Upload failed", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upload.data]);

  const handleDrop = (_dropped: File[], accepted: File[]) => {
    const file = accepted[0];
    if (!file) {
      shopify.toast.show("That file type can’t be used here", { isError: true });
      return;
    }
    if (file.size > PROOF_MAX_UPLOAD_BYTES) {
      shopify.toast.show("The file is larger than 10 MB", { isError: true });
      return;
    }
    const formData = new FormData();
    formData.set("intent", "upload_image");
    formData.set("file", file, file.name);
    upload.submit(formData, { method: "post", encType: "multipart/form-data" });
  };

  const urlValid = HTTPS_PATTERN.test(urlText.trim());

  return (
    <Box minWidth="220px" maxWidth="260px">
      <BlockStack gap="200">
        <Text as="span" variant="bodySm" fontWeight="semibold">
          {label}
        </Text>
        {helpText ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {helpText}
          </Text>
        ) : null}
        <DropZone
          accept="image/*"
          type="image"
          allowMultiple={false}
          onDrop={handleDrop}
          disabled={disabled || busy}
          label={label}
          labelHidden
        >
          {url ? (
            <img
              src={url}
              alt={label}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
              }}
            />
          ) : (
            <DropZone.FileUpload
              actionTitle="Add image"
              actionHint="or drop a file (max 10 MB)"
            />
          )}
        </DropZone>
        {busy ? (
          <InlineStack gap="100" blockAlign="center">
            <Spinner size="small" accessibilityLabel="Uploading image" />
            <Text as="span" variant="bodySm" tone="subdued">
              Uploading…
            </Text>
          </InlineStack>
        ) : null}
        <TextField
          label={`${label} URL`}
          labelHidden
          placeholder="…or paste an https:// image URL"
          value={urlText}
          onChange={setUrlText}
          autoComplete="off"
          disabled={disabled || busy}
          connectedRight={
            <Button
              onClick={() => {
                onChange(urlText.trim());
                setUrlText("");
              }}
              disabled={disabled || busy || !urlValid}
            >
              Use
            </Button>
          }
        />
        {url ? (
          <Button
            variant="plain"
            tone="critical"
            onClick={() => onChange("")}
            disabled={disabled || busy}
          >
            Remove image
          </Button>
        ) : null}
      </BlockStack>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Product tag picker
// ---------------------------------------------------------------------------

interface ProductTagPickerProps {
  /** Selected product GIDs (stored order preserved). */
  value: string[];
  disabled: boolean;
  onChange: (gids: string[]) => void;
}

function numericTail(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

export function ProductTagPicker({
  value,
  disabled,
  onChange,
}: ProductTagPickerProps) {
  const search = useFetcher<ProofFieldActionData>();
  const [query, setQuery] = useState("");
  // gid -> title, accumulated from search hits so tags stay readable. Rows
  // seeded from the database only carry GIDs; unknown ones show the id tail.
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
    titlesRef.current[gid] ?? `Product ${numericTail(gid)}`;

  return (
    <BlockStack gap="200">
      <Text as="span" variant="bodySm" fontWeight="semibold">
        Tagged products
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        No tagged products = a brand-level entry, shown in every context.
        Tagged entries appear first on their own product pages and are hidden
        on other products.
      </Text>
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
      ) : null}
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
                Tag
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

// ---------------------------------------------------------------------------
// Row controls shared by the three tables
// ---------------------------------------------------------------------------

interface TwoClickDeleteButtonProps {
  disabled: boolean;
  onConfirmedDelete: () => void;
}

/** The house 2-click delete: first click arms for 4 s, second click fires. */
export function TwoClickDeleteButton({
  disabled,
  onConfirmedDelete,
}: TwoClickDeleteButtonProps) {
  const [armed, setArmed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const handleClick = () => {
    if (armed) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setArmed(false);
      onConfirmedDelete();
      return;
    }
    setArmed(true);
    timeoutRef.current = setTimeout(() => setArmed(false), 4000);
  };

  return (
    <Button
      variant="plain"
      tone="critical"
      onClick={handleClick}
      disabled={disabled}
    >
      {armed ? "Click again to remove" : "Delete"}
    </Button>
  );
}

interface MoveButtonsProps {
  disabled: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove: (direction: "up" | "down") => void;
}

export function MoveButtons({
  disabled,
  isFirst,
  isLast,
  onMove,
}: MoveButtonsProps) {
  return (
    <InlineStack gap="100">
      <Button
        icon={ArrowUpIcon}
        accessibilityLabel="Move up"
        size="slim"
        onClick={() => onMove("up")}
        disabled={disabled || isFirst}
      />
      <Button
        icon={ArrowDownIcon}
        accessibilityLabel="Move down"
        size="slim"
        onClick={() => onMove("down")}
        disabled={disabled || isLast}
      />
    </InlineStack>
  );
}

interface FeaturedStarButtonProps {
  featured: boolean;
  disabled: boolean;
  onToggle: () => void;
}

export function FeaturedStarButton({
  featured,
  disabled,
  onToggle,
}: FeaturedStarButtonProps) {
  return (
    <Button
      icon={featured ? StarFilledIcon : StarIcon}
      accessibilityLabel={featured ? "Unfeature" : "Feature"}
      size="slim"
      variant={featured ? "primary" : "secondary"}
      onClick={onToggle}
      disabled={disabled}
    />
  );
}

// ---------------------------------------------------------------------------
// Entry forms (Add + inline Edit share these)
// ---------------------------------------------------------------------------

export interface PressFormValues {
  publication: string;
  logoUrl: string;
  quote: string;
  articleUrl: string;
  productGids: string[];
  /** [] = shown in every market (v8.1 per-item market scoping). */
  marketHandles: string[];
  featured: boolean;
  status: string;
}

export const EMPTY_PRESS_FORM: PressFormValues = {
  publication: "",
  logoUrl: "",
  quote: "",
  articleUrl: "",
  productGids: [],
  marketHandles: [],
  featured: false,
  status: "approved",
};

export interface MarketOptionLite {
  handle: string;
  name: string;
  primary: boolean;
}

/** Per-ITEM market scoping (v8.1) — [] = all markets. Distinct from the
 *  page-level MarketScopeCard, which gates the whole feature. */
export function ItemMarketPicker({
  markets,
  value,
  disabled,
  onChange,
}: {
  markets: MarketOptionLite[];
  value: string[];
  disabled: boolean;
  onChange: (handles: string[]) => void;
}) {
  const allMarkets = value.length === 0;
  // Stale handles (a market deleted/renamed since this item was saved, or a
  // partial markets load) must stay VISIBLE and survive unrelated toggles —
  // silently dropping them would unscope the item behind the merchant's
  // back (v8 review finding). They render as explicit removable entries.
  const knownHandles = new Set(markets.map((m) => m.handle));
  const staleHandles = value.filter((h) => !knownHandles.has(h));
  const toggle = (handle: string, checked: boolean) => {
    const set = new Set(value);
    if (checked) set.add(handle);
    else set.delete(handle);
    onChange([
      ...markets.map((m) => m.handle).filter((h) => set.has(h)),
      ...staleHandles.filter((h) => set.has(h)),
    ]);
  };
  if (markets.length === 0) {
    return (
      <Text as="p" tone="subdued" variant="bodySm">
        Markets could not be loaded — market limits cannot be edited right
        now{value.length > 0 ? ` (this entry is limited to: ${value.join(", ")})` : "; this entry shows in every market"}.
      </Text>
    );
  }
  return (
    <BlockStack gap="150">
      <Text as="p" variant="bodyMd" fontWeight="semibold">
        Markets
      </Text>
      <Checkbox
        label="All markets"
        helpText="Untick to limit this entry to selected markets — each market can carry its own publications."
        checked={allMarkets}
        onChange={(checked) => {
          if (checked) onChange([]);
          else onChange(markets.map((m) => m.handle));
        }}
        disabled={disabled}
      />
      {!allMarkets ? (
        <InlineStack gap="300" wrap>
          {markets.map((market) => (
            <Checkbox
              key={market.handle}
              label={market.primary ? `${market.name} (primary)` : market.name}
              checked={value.includes(market.handle)}
              onChange={(checked) => toggle(market.handle, checked)}
              disabled={disabled}
            />
          ))}
          {staleHandles.map((handle) => (
            <Checkbox
              key={handle}
              label={`${handle} (market no longer exists)`}
              checked
              onChange={(checked) => toggle(handle, checked)}
              disabled={disabled}
            />
          ))}
        </InlineStack>
      ) : null}
      {!allMarkets && value.length === 0 ? (
        <Text as="p" tone="critical" variant="bodySm">
          No markets selected — this entry won’t appear anywhere.
        </Text>
      ) : null}
    </BlockStack>
  );
}

const PRESS_STATUS_OPTIONS = [
  { label: "Approved", value: "approved" },
  { label: "Hidden", value: "hidden" },
];

interface PressItemFormProps {
  initial: PressFormValues;
  busy: boolean;
  submitLabel: string;
  markets: MarketOptionLite[];
  onSubmit: (values: PressFormValues) => void;
  onCancel?: () => void;
}

export function PressItemForm({
  initial,
  busy,
  submitLabel,
  markets,
  onSubmit,
  onCancel,
}: PressItemFormProps) {
  const [values, setValues] = useState<PressFormValues>(initial);
  const set = <K extends keyof PressFormValues>(
    key: K,
    value: PressFormValues[K],
  ) => setValues((previous) => ({ ...previous, [key]: value }));

  const articleError = httpsUrlError(values.articleUrl);
  const valid =
    values.publication.trim() !== "" &&
    values.quote.trim() !== "" &&
    !articleError;
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);

  return (
    <BlockStack gap="300">
      <InlineStack gap="300" wrap blockAlign="start">
        <Box minWidth="240px">
          <TextField
            label="Publication"
            value={values.publication}
            maxLength={255}
            onChange={(publication) => set("publication", publication)}
            requiredIndicator
            autoComplete="off"
            disabled={busy}
          />
        </Box>
        <ProofImageField
          label="Publication logo"
          url={values.logoUrl}
          disabled={busy}
          onChange={(logoUrl) => set("logoUrl", logoUrl)}
          helpText="Best: a horizontal wordmark on a TRANSPARENT background (PNG or SVG), at least 240 px wide, around 3:1 to 6:1 width-to-height. It renders about 24 px tall, grayscale until hover — solid white boxes, dark-only marks and portrait-format logos display poorly."
        />
      </InlineStack>
      <TextField
        label="Quote"
        value={values.quote}
        multiline={3}
        maxLength={5000}
        onChange={(quote) => set("quote", quote)}
        requiredIndicator
        helpText="The large quote shown in the press band — exactly as printed."
        autoComplete="off"
        disabled={busy}
      />
      <TextField
        label="Article link (optional)"
        value={values.articleUrl}
        onChange={(articleUrl) => set("articleUrl", articleUrl)}
        error={articleError}
        placeholder="https://…"
        helpText="Leave empty to show the quote without a link."
        autoComplete="off"
        disabled={busy}
      />
      <ProductTagPicker
        value={values.productGids}
        disabled={busy}
        onChange={(productGids) => set("productGids", productGids)}
      />
      <ItemMarketPicker
        markets={markets}
        value={values.marketHandles}
        disabled={busy}
        onChange={(marketHandles) => set("marketHandles", marketHandles)}
      />
      <InlineStack gap="300" blockAlign="center" wrap>
        <Checkbox
          label="Featured"
          helpText="Featured entries are served first."
          checked={values.featured}
          onChange={(featured) => set("featured", featured)}
          disabled={busy}
        />
        <Box minWidth="160px">
          <Select
            label="Status"
            options={PRESS_STATUS_OPTIONS}
            value={values.status}
            onChange={(status) => set("status", status)}
            disabled={busy}
          />
        </Box>
      </InlineStack>
      <InlineStack gap="200">
        <Button
          variant="primary"
          onClick={() => onSubmit(values)}
          disabled={busy || !valid || !dirty}
          loading={busy}
        >
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </InlineStack>
    </BlockStack>
  );
}

export interface EndorsementFormValues {
  name: string;
  credentials: string;
  country: string;
  quote: string;
  imageUrl: string;
  productGids: string[];
  featured: boolean;
  status: string;
}

export const EMPTY_ENDORSEMENT_FORM: EndorsementFormValues = {
  name: "",
  credentials: "",
  country: "",
  quote: "",
  imageUrl: "",
  productGids: [],
  featured: false,
  status: "approved",
};

export function iso2Error(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed !== "" && !/^[A-Za-z]{2}$/.test(trimmed)
    ? "2-letter ISO code (e.g. US) or empty"
    : undefined;
}

interface EndorsementFormProps {
  initial: EndorsementFormValues;
  busy: boolean;
  submitLabel: string;
  onSubmit: (values: EndorsementFormValues) => void;
  onCancel?: () => void;
}

export function EndorsementForm({
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: EndorsementFormProps) {
  const [values, setValues] = useState<EndorsementFormValues>(initial);
  const set = <K extends keyof EndorsementFormValues>(
    key: K,
    value: EndorsementFormValues[K],
  ) => setValues((previous) => ({ ...previous, [key]: value }));

  const countryError = iso2Error(values.country);
  const valid =
    values.name.trim() !== "" && values.quote.trim() !== "" && !countryError;
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);

  return (
    <BlockStack gap="300">
      <InlineStack gap="300" wrap blockAlign="start">
        <BlockStack gap="300">
          <Box minWidth="240px">
            <TextField
              label="Name"
              value={values.name}
              maxLength={255}
              onChange={(name) => set("name", name)}
              requiredIndicator
              placeholder="Dr. Anna Weiss"
              autoComplete="off"
              disabled={busy}
            />
          </Box>
          <Box minWidth="240px">
            <TextField
              label="Credentials (optional)"
              value={values.credentials}
              maxLength={255}
              onChange={(credentials) => set("credentials", credentials)}
              placeholder="MD, Board-certified dermatologist"
              autoComplete="off"
              disabled={busy}
            />
          </Box>
          <Box minWidth="120px" maxWidth="160px">
            <TextField
              label="Country (optional)"
              value={values.country}
              maxLength={2}
              onChange={(country) => set("country", country)}
              error={countryError}
              placeholder="US"
              autoComplete="off"
              disabled={busy}
            />
          </Box>
        </BlockStack>
        <ProofImageField
          label="Portrait (optional)"
          url={values.imageUrl}
          disabled={busy}
          onChange={(imageUrl) => set("imageUrl", imageUrl)}
        />
      </InlineStack>
      <TextField
        label="Endorsement quote"
        value={values.quote}
        multiline={6}
        maxLength={5000}
        onChange={(quote) => set("quote", quote)}
        requiredIndicator
        helpText="Short one-liners and full 2–3 paragraph statements both work — paragraph breaks are kept when a visitor expands the quote."
        autoComplete="off"
        disabled={busy}
      />
      <ProductTagPicker
        value={values.productGids}
        disabled={busy}
        onChange={(productGids) => set("productGids", productGids)}
      />
      <InlineStack gap="300" blockAlign="center" wrap>
        <Checkbox
          label="Featured"
          helpText="Featured entries are served first."
          checked={values.featured}
          onChange={(featured) => set("featured", featured)}
          disabled={busy}
        />
        <Box minWidth="160px">
          <Select
            label="Status"
            options={PRESS_STATUS_OPTIONS}
            value={values.status}
            onChange={(status) => set("status", status)}
            disabled={busy}
          />
        </Box>
      </InlineStack>
      <InlineStack gap="200">
        <Button
          variant="primary"
          onClick={() => onSubmit(values)}
          disabled={busy || !valid || !dirty}
          loading={busy}
        >
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </InlineStack>
    </BlockStack>
  );
}

export interface ResultFormValues {
  source: string;
  verified: boolean;
  beforeUrl: string;
  afterUrl: string;
  ageRange: string;
  skinType: string;
  concern: string;
  durationWeeks: string;
  country: string;
  testimonial: string;
  videoUrl: string;
  productGids: string[];
  featured: boolean;
  status: string;
}

export const EMPTY_RESULT_FORM: ResultFormValues = {
  source: "customer",
  verified: false,
  beforeUrl: "",
  afterUrl: "",
  ageRange: "",
  skinType: "",
  concern: "",
  durationWeeks: "",
  country: "",
  testimonial: "",
  videoUrl: "",
  productGids: [],
  featured: false,
  status: "pending",
};

const RESULT_STATUS_OPTIONS = [
  { label: "Pending", value: "pending" },
  { label: "Approved", value: "approved" },
  { label: "Hidden", value: "hidden" },
];

const SOURCE_OPTIONS = [
  { label: "Customer submitted", value: "customer" },
  { label: "Lab / clinical", value: "lab" },
];

const AGE_OPTIONS = [
  { label: "No age range", value: "" },
  { label: "18–24", value: "18-24" },
  { label: "25–34", value: "25-34" },
  { label: "35–44", value: "35-44" },
  { label: "45–54", value: "45-54" },
  { label: "55–64", value: "55-64" },
  { label: "65+", value: "65+" },
];

const SKIN_OPTIONS = [
  { label: "No skin type", value: "" },
  { label: "Dry", value: "dry" },
  { label: "Oily", value: "oily" },
  { label: "Combination", value: "combination" },
  { label: "Sensitive", value: "sensitive" },
  { label: "Normal", value: "normal" },
];

export function durationWeeksError(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/.test(trimmed) || Number(trimmed) > 520) {
    return "Whole number of weeks (0–520) or empty";
  }
  return undefined;
}

interface ResultFormProps {
  initial: ResultFormValues;
  busy: boolean;
  submitLabel: string;
  onSubmit: (values: ResultFormValues) => void;
  onCancel?: () => void;
}

export function ResultForm({
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: ResultFormProps) {
  const [values, setValues] = useState<ResultFormValues>(initial);
  const set = <K extends keyof ResultFormValues>(
    key: K,
    value: ResultFormValues[K],
  ) => setValues((previous) => ({ ...previous, [key]: value }));

  const videoError = httpsUrlError(values.videoUrl);
  const countryError = iso2Error(values.country);
  const durationError = durationWeeksError(values.durationWeeks);
  const hasContent =
    values.beforeUrl !== "" ||
    values.afterUrl !== "" ||
    values.testimonial.trim() !== "" ||
    values.videoUrl.trim() !== "";
  const valid = hasContent && !videoError && !countryError && !durationError;
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);

  return (
    <BlockStack gap="300">
      <InlineStack gap="300" wrap blockAlign="start">
        <ProofImageField
          label="Before image"
          url={values.beforeUrl}
          disabled={busy}
          onChange={(beforeUrl) => set("beforeUrl", beforeUrl)}
        />
        <ProofImageField
          label="After image"
          url={values.afterUrl}
          disabled={busy}
          onChange={(afterUrl) => set("afterUrl", afterUrl)}
        />
      </InlineStack>
      {!hasContent ? (
        <Text as="p" variant="bodySm" tone="subdued">
          Add at least an image, a testimonial or a video.
        </Text>
      ) : null}
      <TextField
        label="Testimonial (optional)"
        value={values.testimonial}
        multiline={3}
        maxLength={5000}
        onChange={(testimonial) => set("testimonial", testimonial)}
        helpText="Shown exactly as written — customer text is never machine-translated."
        autoComplete="off"
        disabled={busy}
      />
      <TextField
        label="Video URL (optional)"
        value={values.videoUrl}
        onChange={(videoUrl) => set("videoUrl", videoUrl)}
        error={videoError}
        placeholder="https://…"
        helpText="Direct https link to a video file, or a video page link."
        autoComplete="off"
        disabled={busy}
      />
      <InlineStack gap="300" wrap blockAlign="start">
        <Box minWidth="180px">
          <Select
            label="Source"
            options={SOURCE_OPTIONS}
            value={values.source}
            onChange={(source) => set("source", source)}
            disabled={busy}
          />
        </Box>
        <Box minWidth="160px">
          <Select
            label="Age range"
            options={AGE_OPTIONS}
            value={values.ageRange}
            onChange={(ageRange) => set("ageRange", ageRange)}
            disabled={busy}
          />
        </Box>
        <Box minWidth="160px">
          <Select
            label="Skin type"
            options={SKIN_OPTIONS}
            value={values.skinType}
            onChange={(skinType) => set("skinType", skinType)}
            disabled={busy}
          />
        </Box>
        <Box minWidth="140px" maxWidth="180px">
          <TextField
            label="Duration (weeks)"
            value={values.durationWeeks}
            onChange={(durationWeeks) => set("durationWeeks", durationWeeks)}
            error={durationError}
            inputMode="numeric"
            autoComplete="off"
            disabled={busy}
          />
        </Box>
        <Box minWidth="120px" maxWidth="160px">
          <TextField
            label="Country"
            value={values.country}
            maxLength={2}
            onChange={(country) => set("country", country)}
            error={countryError}
            placeholder="US"
            autoComplete="off"
            disabled={busy}
          />
        </Box>
        <Box minWidth="180px">
          <TextField
            label="Concern tag"
            value={values.concern}
            maxLength={60}
            onChange={(concern) => set("concern", concern)}
            placeholder="wrinkles"
            helpText="Free slug used by the gallery's concern filter."
            autoComplete="off"
            disabled={busy}
          />
        </Box>
      </InlineStack>
      <ProductTagPicker
        value={values.productGids}
        disabled={busy}
        onChange={(productGids) => set("productGids", productGids)}
      />
      <InlineStack gap="300" blockAlign="center" wrap>
        <Checkbox
          label="Verified purchase"
          helpText="Counts toward the “verified customers” scale banner."
          checked={values.verified}
          onChange={(verified) => set("verified", verified)}
          disabled={busy}
        />
        <Checkbox
          label="Featured"
          helpText="Featured entries are served first."
          checked={values.featured}
          onChange={(featured) => set("featured", featured)}
          disabled={busy}
        />
        <Box minWidth="160px">
          <Select
            label="Status"
            options={RESULT_STATUS_OPTIONS}
            value={values.status}
            onChange={(status) => set("status", status)}
            disabled={busy}
          />
        </Box>
      </InlineStack>
      <InlineStack gap="200">
        <Button
          variant="primary"
          onClick={() => onSubmit(values)}
          disabled={busy || !valid || !dirty}
          loading={busy}
        >
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </InlineStack>
    </BlockStack>
  );
}

// ---------------------------------------------------------------------------
// v8.11: per-entry translations review (the proof twin of Translate & Adapt
// review — proof entries live in the app DB, so T&A never sees them).
// Rendered ONLY inside an expanded editor (never for collapsed rows — a
// page of items times 17 locales would be hundreds of hidden fields).
// ---------------------------------------------------------------------------

export interface ProofTranslationRow {
  locale: string;
  field: string;
  value: string;
  manual: boolean;
  outdated?: boolean;
}

export interface ProofTranslationsSectionProps {
  /** Translatable fields of this entry with their CURRENT source text. */
  fields: { field: string; label: string; sourceText: string }[];
  /** Published non-primary shop locales (lowercase). */
  targetLocales: string[];
  /** Stored translations for this entry. */
  translations: ProofTranslationRow[];
  /** Fires the save_translation intent; blank value clears the row. */
  onSave: (locale: string, field: string, value: string) => void;
  saving: boolean;
}

export function ProofTranslationsSection({
  fields,
  targetLocales,
  translations,
  onSave,
  saving,
}: ProofTranslationsSectionProps) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const stored = new Map(
    translations.map((row) => [`${row.locale} ${row.field}`, row]),
  );
  const activeFields = fields.filter((f) => /\S/.test(f.sourceText));
  if (activeFields.length === 0 || targetLocales.length === 0) return null;
  const translatedCount = targetLocales.filter((locale) =>
    activeFields.every((f) => stored.has(`${locale} ${f.field}`)),
  ).length;
  return (
    <BlockStack gap="200">
      <Button
        variant="plain"
        disclosure={open ? "up" : "down"}
        onClick={() => setOpen((value) => !value)}
      >
        {`Translations (${translatedCount} of ${targetLocales.length} languages)`}
      </Button>
      <Collapsible open={open} id="cx-proof-translations">
        <BlockStack gap="300">
          <Text as="p" tone="subdued" variant="bodySm">
            Auto-translated by DeepL when a key is set (Languages page).
            Editing a value here marks it manual — auto-translation never
            overwrites it. Clearing a value falls back to the original text.
          </Text>
          {targetLocales.map((locale) => (
            <BlockStack key={locale} gap="150">
              <Text as="h4" variant="headingSm">
                {locale.toUpperCase()}
              </Text>
              {activeFields.map((f) => {
                const key = `${locale} ${f.field}`;
                const row = stored.get(key);
                const draftKey = key;
                const value = drafts[draftKey] ?? row?.value ?? "";
                return (
                  <TextField
                    key={f.field}
                    label={`${f.label}${row?.manual ? " (manual)" : row?.outdated ? " (auto — outdated, re-translates on the next run)" : row ? " (auto)" : " (untranslated)"}`}
                    value={value}
                    multiline={2}
                    autoComplete="off"
                    disabled={saving}
                    onChange={(next) =>
                      setDrafts((prev) => ({ ...prev, [draftKey]: next }))
                    }
                    connectedRight={
                      <Button
                        onClick={() => onSave(locale, f.field, value)}
                        disabled={saving || value === (row?.value ?? "")}
                      >
                        Save
                      </Button>
                    }
                  />
                );
              })}
            </BlockStack>
          ))}
        </BlockStack>
      </Collapsible>
    </BlockStack>
  );
}
