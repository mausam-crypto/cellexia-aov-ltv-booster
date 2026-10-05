import { useEffect, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Checkbox,
  ChoiceList,
  Divider,
  DropZone,
  InlineStack,
  Select,
  Spinner,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  AGE_OPTIONS,
  MAX_MEASUREMENT_ROWS,
  MEASUREMENT_DIR_OPTIONS,
  PROOF_MAX_UPLOAD_BYTES,
  ProductTagPicker,
  SKIN_OPTIONS,
  durationWeeksError,
  iso2Error,
  measurementPctError,
  type ProofFieldActionData,
  type ResultPresetOption,
} from "./ProofForms";

/**
 * v35 — the study-batch entry form (docs/SPEC-v35-results-batches.md §5):
 * one clinical study's constants entered ONCE (name, duration, quote,
 * attribution, measurement definitions without percents, trust marks —
 * the v34 preset shape), then one compact row per participant carrying
 * only its photos and its percents. Dozens of before/afters become one
 * post of the `save_result_batch` intent; the server expands every row
 * through the SAME saveResult validation as a single entry.
 *
 * Photos: a bulk drop zone uploads many files sequentially through the
 * route's existing `upload_image` intent (one shared fetcher, 150ms
 * pacing — the house sequenced-write discipline) and fills rows in
 * filename order (numeric-aware), so "01-before.jpg, 01-after.jpg,
 * 02-before.jpg…" lands exactly as named. Every cell shows its thumbnail
 * for verification, can be re-dropped individually, and pair rows have a
 * swap button — accuracy is checkable at a glance, never assumed.
 */

/** Client twin of proof.server.ts MAX_RESULT_BATCH_ROWS. */
export const MAX_BATCH_ROWS = 100;

export interface BatchMeasurementDef {
  label: string;
  dir: string;
  info: string;
}

export interface BatchRowValues {
  /** Stable client key (never submitted). */
  key: number;
  beforeUrl: string;
  afterUrl: string;
  combinedUrl: string;
  /** One percent string per measurement definition, index-aligned. */
  pcts: string[];
  ageRange: string;
  skinType: string;
}

export interface ResultBatchFormValues {
  study: string;
  testimonial: string;
  attributionName: string;
  attributionRole: string;
  durationWeeks: string;
  measurements: BatchMeasurementDef[];
  markInstrument: boolean;
  markSamePatient: boolean;
  markUnretouched: boolean;
  verified: boolean;
  country: string;
  concern: string;
  productGids: string[];
  status: string;
  imageMode: "pair" | "combined";
  savePreset: boolean;
  rows: BatchRowValues[];
}

interface ResultBatchFormProps {
  busy: boolean;
  presets?: ResultPresetOption[];
  onSubmit: (values: ResultBatchFormValues) => void;
}

type PhotoSlot = "beforeUrl" | "afterUrl" | "combinedUrl";

interface UploadQueueItem {
  rowKey: number;
  slot: PhotoSlot;
  file: File;
}

const BATCH_STATUS_OPTIONS = [
  { label: "Pending (review first)", value: "pending" },
  { label: "Approved (publish immediately)", value: "approved" },
];

const EMPTY_DEF: BatchMeasurementDef = { label: "", dir: "down", info: "" };

function cellKey(rowKey: number, slot: PhotoSlot): string {
  return `${rowKey}:${slot}`;
}

/** Pairing key for bulk drops: numeric-aware (so "2-before" sorts before
 *  "10-before"), and the before/after TOKENS rank explicitly — plain
 *  alphabetical order puts "01-after" BEFORE "01-before" ('a' < 'b'),
 *  which would swap every pair for a merchant following the hint's own
 *  naming convention (review catch). Files without the tokens keep plain
 *  filename order; the thumbnails and the Swap button stay the check. */
function pairKey(name: string): string {
  return name.toLowerCase().replace(/before/g, "0").replace(/after/g, "1");
}

function sortByName(files: File[]): File[] {
  return [...files].sort((a, b) =>
    pairKey(a.name).localeCompare(pairKey(b.name), undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

function BatchPhotoCell({
  label,
  url,
  pending,
  disabled,
  onFile,
  onClear,
}: {
  label: string;
  url: string;
  pending: boolean;
  disabled: boolean;
  onFile: (file: File) => void;
  onClear: () => void;
}) {
  const shopify = useAppBridge();
  return (
    <Box minWidth="96px" maxWidth="96px">
      <BlockStack gap="050">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        {pending ? (
          <Box paddingBlock="300">
            <InlineStack align="center">
              <Spinner size="small" accessibilityLabel={`Uploading ${label}`} />
            </InlineStack>
          </Box>
        ) : url ? (
          <BlockStack gap="050" inlineAlign="start">
            <Thumbnail source={url} alt={label} size="small" />
            <Button
              variant="plain"
              tone="critical"
              onClick={onClear}
              disabled={disabled}
            >
              Remove
            </Button>
          </BlockStack>
        ) : (
          <DropZone
            accept="image/*"
            type="image"
            allowMultiple={false}
            disabled={disabled}
            label={label}
            labelHidden
            onDrop={(_all: File[], accepted: File[]) => {
              const file = accepted[0];
              if (!file) {
                shopify.toast.show("That file type can’t be used here", {
                  isError: true,
                });
                return;
              }
              if (file.size > PROOF_MAX_UPLOAD_BYTES) {
                shopify.toast.show("The file is larger than 10 MB", {
                  isError: true,
                });
                return;
              }
              onFile(file);
            }}
          >
            <DropZone.FileUpload actionTitle="Add" />
          </DropZone>
        )}
      </BlockStack>
    </Box>
  );
}

export function ResultBatchForm({ busy, presets, onSubmit }: ResultBatchFormProps) {
  const shopify = useAppBridge();
  const [study, setStudy] = useState("");
  const [testimonial, setTestimonial] = useState("");
  const [attributionName, setAttributionName] = useState("");
  const [attributionRole, setAttributionRole] = useState("");
  const [durationWeeks, setDurationWeeks] = useState("");
  const [defs, setDefs] = useState<BatchMeasurementDef[]>([]);
  const [markInstrument, setMarkInstrument] = useState(false);
  const [markSamePatient, setMarkSamePatient] = useState(false);
  const [markUnretouched, setMarkUnretouched] = useState(false);
  const [verified, setVerified] = useState(false);
  const [country, setCountry] = useState("");
  const [concern, setConcern] = useState("");
  const [productGids, setProductGids] = useState<string[]>([]);
  const [status, setStatus] = useState("pending");
  const [imageMode, setImageMode] = useState<"pair" | "combined">("pair");
  const [savePreset, setSavePreset] = useState(true);
  const [perPerson, setPerPerson] = useState(false);
  const [presetId, setPresetId] = useState("");
  const [rows, setRows] = useState<BatchRowValues[]>([]);

  // ---- sequential photo-upload pipeline (one fetcher, 150ms pacing) ----
  const upload = useFetcher<ProofFieldActionData>();
  const queueRef = useRef<UploadQueueItem[]>([]);
  const currentRef = useRef<UploadQueueItem | null>(null);
  const lastDataRef = useRef<ProofFieldActionData | null>(null);
  const [pendingCells, setPendingCells] = useState<Set<string>>(new Set());
  const [uploadTotal, setUploadTotal] = useState(0);
  const [uploadDone, setUploadDone] = useState(0);

  const rowKeyRef = useRef(1);
  const nextRowKey = () => rowKeyRef.current++;

  const setRow = (key: number, patch: Partial<BatchRowValues>) => {
    setRows((previous) =>
      previous.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  };

  const submitNext = () => {
    // One item in flight, ever: a second submit on the same fetcher would
    // CANCEL the in-flight upload and strand its cell on the spinner (the
    // enqueue-during-the-150ms-gap race).
    if (currentRef.current) return;
    const item = queueRef.current.shift() ?? null;
    currentRef.current = item;
    if (!item) return;
    const formData = new FormData();
    formData.set("intent", "upload_image");
    formData.set("file", item.file, item.file.name);
    upload.submit(formData, { method: "post", encType: "multipart/form-data" });
  };

  const enqueue = (items: UploadQueueItem[]) => {
    if (items.length === 0) return;
    queueRef.current.push(...items);
    setPendingCells((previous) => {
      const next = new Set(previous);
      for (const item of items) next.add(cellKey(item.rowKey, item.slot));
      return next;
    });
    setUploadTotal((t) => t + items.length);
    if (upload.state === "idle") submitNext();
  };

  useEffect(() => {
    const data = upload.data;
    const item = currentRef.current;
    if (upload.state !== "idle" || !data || !item) return;
    if (data === lastDataRef.current || data.intent !== "upload_image") return;
    lastDataRef.current = data;
    const resolved = data.url ?? data.previewUrl ?? null;
    if (data.ok && resolved) {
      setRow(item.rowKey, { [item.slot]: resolved } as Partial<BatchRowValues>);
    } else {
      // Leave the cell empty (its DropZone returns) — a failed upload must
      // be visible, never silently skipped in a dozens-row batch.
      shopify.toast.show(
        data.ok
          ? `${item.file.name}: Shopify is still processing — drop it on its row again in a few seconds`
          : `${item.file.name}: ${data.errors[0] ?? "upload failed"}`,
        { isError: true },
      );
    }
    setPendingCells((previous) => {
      const next = new Set(previous);
      next.delete(cellKey(item.rowKey, item.slot));
      return next;
    });
    setUploadDone((d) => d + 1);
    currentRef.current = null;
    // House pacing for sequenced writes — never hammer the upload path.
    window.setTimeout(submitNext, 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upload.state, upload.data]);

  const uploadsPending = pendingCells.size > 0;

  // ---- preset apply (the v34 contract: constants only) ----
  const applyPreset = (id: string) => {
    setPresetId(id);
    if (id === "") return;
    const preset = (presets ?? []).find((entry) => entry.id === id);
    if (!preset) return;
    const f = preset.fields;
    setStudy(preset.name);
    setTestimonial(f.testimonial);
    setAttributionName(f.attributionName);
    setAttributionRole(f.attributionRole);
    setDurationWeeks(f.durationWeeks === null ? "" : String(f.durationWeeks));
    const nextDefs = f.measurements.map((m) => ({
      label: m.label,
      dir: m.dir === "up" ? "up" : "down",
      info: m.info ?? "",
    }));
    setDefs(nextDefs);
    // Keep every row's percent list aligned with the new definitions.
    setRows((previous) =>
      previous.map((row) => ({
        ...row,
        pcts: nextDefs.map((_def, i) => row.pcts[i] ?? ""),
      })),
    );
    setMarkInstrument(f.markInstrument);
    setMarkSamePatient(f.markSamePatient);
    setMarkUnretouched(f.markUnretouched);
  };

  // ---- measurement definitions (pcts stay index-aligned on add/remove) ----
  const addDef = () => {
    if (defs.length >= MAX_MEASUREMENT_ROWS) return;
    setDefs((previous) => [...previous, { ...EMPTY_DEF }]);
    setRows((previous) =>
      previous.map((row) => ({ ...row, pcts: [...row.pcts, ""] })),
    );
  };

  const setDef = (index: number, patch: Partial<BatchMeasurementDef>) => {
    setDefs((previous) =>
      previous.map((def, i) => (i === index ? { ...def, ...patch } : def)),
    );
  };

  const removeDef = (index: number) => {
    setDefs((previous) => previous.filter((_def, i) => i !== index));
    setRows((previous) =>
      previous.map((row) => ({
        ...row,
        pcts: row.pcts.filter((_pct, i) => i !== index),
      })),
    );
  };

  // ---- rows ----
  const addRow = (): number | null => {
    if (rows.length >= MAX_BATCH_ROWS) return null;
    const key = nextRowKey();
    setRows((previous) => [
      ...previous,
      {
        key,
        beforeUrl: "",
        afterUrl: "",
        combinedUrl: "",
        pcts: defs.map(() => ""),
        ageRange: "",
        skinType: "",
      },
    ]);
    return key;
  };

  const removeRow = (key: number) => {
    // Drop the row's queued uploads too, or a late result would write
    // into a row that no longer exists.
    queueRef.current = queueRef.current.filter((item) => item.rowKey !== key);
    setPendingCells((previous) => {
      const next = new Set(previous);
      next.delete(cellKey(key, "beforeUrl"));
      next.delete(cellKey(key, "afterUrl"));
      next.delete(cellKey(key, "combinedUrl"));
      return next;
    });
    setRows((previous) => previous.filter((row) => row.key !== key));
  };

  const setPct = (key: number, index: number, value: string) => {
    setRows((previous) =>
      previous.map((row) =>
        row.key === key
          ? { ...row, pcts: row.pcts.map((p, i) => (i === index ? value : p)) }
          : row,
      ),
    );
  };

  const swapRow = (key: number) => {
    setRows((previous) =>
      previous.map((row) =>
        row.key === key
          ? { ...row, beforeUrl: row.afterUrl, afterUrl: row.beforeUrl }
          : row,
      ),
    );
  };

  // ---- bulk drop: new rows in filename order ----
  const handleBulkDrop = (_all: File[], accepted: File[]) => {
    const usable: File[] = [];
    let oversize = 0;
    for (const file of accepted) {
      if (file.size > PROOF_MAX_UPLOAD_BYTES) oversize += 1;
      else usable.push(file);
    }
    const rejected = _all.length - accepted.length;
    // PAIR MODE refuses a drop with ANY skipped file: positional pairing
    // after a silent gap would cross-pair every later subject's photos
    // (an EVEN number of skips doesn't even trip the odd-count warning) —
    // the accurate move is a clean re-drop (review catch).
    if (imageMode === "pair" && (oversize > 0 || rejected > 0)) {
      shopify.toast.show(
        `${oversize + rejected} file${oversize + rejected === 1 ? " was" : "s were"} skipped (images up to 10 MB only) — nothing was added, fix them and drop the full set again`,
        { isError: true },
      );
      return;
    }
    if (rejected > 0) {
      shopify.toast.show("Some files were skipped — images only", {
        isError: true,
      });
    }
    if (oversize > 0) {
      shopify.toast.show(
        `${oversize} file${oversize === 1 ? " is" : "s are"} larger than 10 MB and skipped`,
        { isError: true },
      );
    }
    if (usable.length === 0) return;
    const files = sortByName(usable);
    const perRow = imageMode === "combined" ? 1 : 2;
    const newRows = Math.ceil(files.length / perRow);
    if (rows.length + newRows > MAX_BATCH_ROWS) {
      shopify.toast.show(`No more than ${MAX_BATCH_ROWS} rows per batch`, {
        isError: true,
      });
      return;
    }
    if (perRow === 2 && files.length % 2 === 1) {
      shopify.toast.show(
        "Odd number of photos — the last row is missing its after photo",
        { isError: true },
      );
    }
    const queued: UploadQueueItem[] = [];
    const created: BatchRowValues[] = [];
    for (let i = 0; i < newRows; i++) {
      const key = nextRowKey();
      created.push({
        key,
        beforeUrl: "",
        afterUrl: "",
        combinedUrl: "",
        pcts: defs.map(() => ""),
        ageRange: "",
        skinType: "",
      });
      if (imageMode === "combined") {
        queued.push({ rowKey: key, slot: "combinedUrl", file: files[i] });
      } else {
        const before = files[i * 2];
        const after = files[i * 2 + 1];
        if (before) queued.push({ rowKey: key, slot: "beforeUrl", file: before });
        if (after) queued.push({ rowKey: key, slot: "afterUrl", file: after });
      }
    }
    setRows((previous) => [...previous, ...created]);
    enqueue(queued);
  };

  // ---- validation (client twins of the server rules) ----
  const durationError = durationWeeksError(durationWeeks);
  const countryError = iso2Error(country);
  const defsNeedDuration =
    defs.length > 0 && !/^[1-9]\d*$/.test(durationWeeks.trim());
  const defLabelMissing = defs.some((def) => def.label.trim() === "");

  const rowProblem = (row: BatchRowValues): string | undefined => {
    if (imageMode === "combined") {
      if (!row.combinedUrl) return "Needs its combined before/after photo";
    } else if (!row.beforeUrl || !row.afterUrl) {
      return "Needs both photos";
    }
    for (let i = 0; i < defs.length; i++) {
      if (measurementPctError(row.pcts[i] ?? "")) {
        return `Needs a percent for “${defs[i].label.trim() || `measurement ${i + 1}`}”`;
      }
    }
    return undefined;
  };

  const rowsInvalid = rows.some((row) => rowProblem(row) !== undefined);
  const valid =
    study.trim() !== "" &&
    !durationError &&
    !defsNeedDuration &&
    !defLabelMissing &&
    !countryError &&
    rows.length > 0 &&
    !rowsInvalid &&
    !uploadsPending;

  const submit = () => {
    onSubmit({
      study: study.trim(),
      testimonial,
      attributionName,
      attributionRole,
      durationWeeks,
      measurements: defs,
      markInstrument,
      markSamePatient,
      markUnretouched,
      verified,
      country,
      concern,
      productGids,
      status,
      imageMode,
      savePreset,
      // Unchecking "per-person details" must mean what it says: hidden
      // age/skin values are blanked at submit (and kept in state, so
      // re-checking restores them before submit) — review catch.
      rows: perPerson
        ? rows
        : rows.map((row) => ({ ...row, ageRange: "", skinType: "" })),
    });
  };

  return (
    <BlockStack gap="400">
      <Text as="p" tone="subdued" variant="bodySm">
        One batch is one clinical study: enter the study constants once,
        then add one row per participant — just the photos and the numbers.
        Every row is saved as its own before/after entry, tagged with the
        study name.
      </Text>

      {presets && presets.length > 0 ? (
        <Select
          label="Start from a study preset"
          options={[
            { label: "No preset", value: "" },
            ...presets.map((preset) => ({
              label: preset.name,
              value: preset.id,
            })),
          ]}
          value={presetId}
          onChange={applyPreset}
          disabled={busy}
          helpText="Fills the study constants below. Rows you already added are kept — their percents line up with the preset's measurements."
        />
      ) : null}

      <InlineStack gap="300" wrap blockAlign="start">
        <Box minWidth="260px">
          <TextField
            label="Study name"
            value={study}
            maxLength={80}
            onChange={setStudy}
            autoComplete="off"
            disabled={busy}
            placeholder="Helsinki 8-week clinical study"
            requiredIndicator
            helpText="Shown as a small tag on every card from this batch."
          />
        </Box>
        <Box minWidth="140px">
          <TextField
            label="Duration (weeks)"
            value={durationWeeks}
            onChange={setDurationWeeks}
            autoComplete="off"
            inputMode="numeric"
            disabled={busy}
            error={
              durationError ??
              (defsNeedDuration
                ? "Required when the study has measurements"
                : undefined)
            }
          />
        </Box>
        <Box minWidth="120px">
          <TextField
            label="Country"
            value={country}
            maxLength={2}
            onChange={setCountry}
            autoComplete="off"
            disabled={busy}
            placeholder="FI"
            error={countryError}
          />
        </Box>
        <Box minWidth="160px">
          <TextField
            label="Concern tag"
            value={concern}
            maxLength={60}
            onChange={setConcern}
            autoComplete="off"
            disabled={busy}
            placeholder="wrinkles"
            helpText="Optional gallery filter slug."
          />
        </Box>
      </InlineStack>

      <TextField
        label="Study quote (testimonial)"
        value={testimonial}
        onChange={setTestimonial}
        multiline={3}
        maxLength={5000}
        autoComplete="off"
        disabled={busy}
        helpText="Optional — shown on every card from this batch, with the attribution below."
      />
      <InlineStack gap="300" wrap>
        <Box minWidth="220px">
          <TextField
            label="Attribution name"
            value={attributionName}
            maxLength={80}
            onChange={setAttributionName}
            autoComplete="off"
            disabled={busy}
            placeholder="Dr. Lauren Bennett"
          />
        </Box>
        <Box minWidth="220px">
          <TextField
            label="Attribution role"
            value={attributionRole}
            maxLength={120}
            onChange={setAttributionRole}
            autoComplete="off"
            disabled={busy}
            placeholder="Consultant Dermatologist"
          />
        </Box>
      </InlineStack>

      <Box padding="300" background="bg-surface-secondary" borderRadius="200">
        <BlockStack gap="300">
          <Text as="h4" variant="headingSm">
            Measurements (same for every row)
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Define the instruments and metrics once — each row below gets
            one percent field per measurement.
          </Text>
          {defs.map((def, index) => (
            <InlineStack key={index} gap="200" wrap blockAlign="start">
              <Box minWidth="200px">
                <TextField
                  label={`Measurement ${index + 1}`}
                  value={def.label}
                  maxLength={80}
                  onChange={(label) => setDef(index, { label })}
                  error={
                    def.label.trim() === "" ? "Label required" : undefined
                  }
                  placeholder="Under-eye wrinkle depth"
                  autoComplete="off"
                  disabled={busy}
                />
              </Box>
              <Box minWidth="150px">
                <Select
                  label="Direction"
                  options={MEASUREMENT_DIR_OPTIONS}
                  value={def.dir}
                  onChange={(dir) => setDef(index, { dir })}
                  disabled={busy}
                />
              </Box>
              <Box minWidth="200px">
                <TextField
                  label="Info note"
                  value={def.info}
                  maxLength={240}
                  onChange={(info) => setDef(index, { info })}
                  autoComplete="off"
                  disabled={busy}
                />
              </Box>
              <Box paddingBlockStart="600">
                <Button
                  variant="plain"
                  tone="critical"
                  onClick={() => removeDef(index)}
                  disabled={busy}
                >
                  Remove
                </Button>
              </Box>
            </InlineStack>
          ))}
          {defs.length < MAX_MEASUREMENT_ROWS ? (
            <InlineStack>
              <Button onClick={addDef} disabled={busy}>
                Add measurement
              </Button>
            </InlineStack>
          ) : null}
          <InlineStack gap="400" wrap>
            <Checkbox
              label="Instrument measured"
              checked={markInstrument}
              onChange={setMarkInstrument}
              disabled={busy}
            />
            <Checkbox
              label="Same patient"
              checked={markSamePatient}
              onChange={setMarkSamePatient}
              disabled={busy}
            />
            <Checkbox
              label="Unretouched images"
              checked={markUnretouched}
              onChange={setMarkUnretouched}
              disabled={busy}
            />
          </InlineStack>
        </BlockStack>
      </Box>

      <ChoiceList
        title="Photo format"
        choices={[
          { label: "Separate before and after photos (2 per row)", value: "pair" },
          {
            label:
              "One combined before/after photo per row (before on the left, after on the right)",
            value: "combined",
          },
        ]}
        selected={[imageMode]}
        onChange={(selected) => {
          const mode = selected[0] === "combined" ? "combined" : "pair";
          setImageMode(mode);
        }}
        disabled={busy || rows.length > 0 || uploadsPending}
      />
      {rows.length > 0 ? (
        <Text as="p" tone="subdued" variant="bodySm">
          The photo format is locked while the batch has rows — remove them
          to change it.
        </Text>
      ) : null}

      <ProductTagPicker
        value={productGids}
        disabled={busy}
        onChange={setProductGids}
      />

      <Divider />

      <BlockStack gap="300">
        <Text as="h4" variant="headingSm">
          Before/after rows
        </Text>
        <DropZone
          accept="image/*"
          type="image"
          allowMultiple
          onDrop={handleBulkDrop}
          disabled={busy}
          label="Add all photos at once"
        >
          <DropZone.FileUpload
            actionTitle="Add all photos at once"
            actionHint={
              imageMode === "combined"
                ? "One combined photo per row — rows are created in filename order"
                : "Two photos per row, paired in filename order (01-before, 01-after, 02-before…)"
            }
          />
        </DropZone>
        {uploadsPending ? (
          <InlineStack gap="100" blockAlign="center">
            <Spinner size="small" accessibilityLabel="Uploading photos" />
            <Text as="span" variant="bodySm" tone="subdued">
              Uploading photo {Math.min(uploadDone + 1, uploadTotal)} of{" "}
              {uploadTotal}…
            </Text>
          </InlineStack>
        ) : null}
        <Checkbox
          label="Add age range and skin type per row"
          checked={perPerson}
          onChange={setPerPerson}
          disabled={busy}
        />

        {rows.map((row, index) => {
          const problem = rowProblem(row);
          return (
            <Box
              key={row.key}
              padding="300"
              background="bg-surface-secondary"
              borderRadius="200"
            >
              <BlockStack gap="200">
                <InlineStack gap="300" wrap blockAlign="start">
                  <Box paddingBlockStart="500" minWidth="28px">
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      {index + 1}.
                    </Text>
                  </Box>
                  {imageMode === "combined" ? (
                    <BatchPhotoCell
                      label="Combined"
                      url={row.combinedUrl}
                      pending={pendingCells.has(cellKey(row.key, "combinedUrl"))}
                      disabled={busy}
                      onFile={(file) =>
                        enqueue([{ rowKey: row.key, slot: "combinedUrl", file }])
                      }
                      onClear={() => setRow(row.key, { combinedUrl: "" })}
                    />
                  ) : (
                    <>
                      <BatchPhotoCell
                        label="Before"
                        url={row.beforeUrl}
                        pending={pendingCells.has(cellKey(row.key, "beforeUrl"))}
                        disabled={busy}
                        onFile={(file) =>
                          enqueue([{ rowKey: row.key, slot: "beforeUrl", file }])
                        }
                        onClear={() => setRow(row.key, { beforeUrl: "" })}
                      />
                      <BatchPhotoCell
                        label="After"
                        url={row.afterUrl}
                        pending={pendingCells.has(cellKey(row.key, "afterUrl"))}
                        disabled={busy}
                        onFile={(file) =>
                          enqueue([{ rowKey: row.key, slot: "afterUrl", file }])
                        }
                        onClear={() => setRow(row.key, { afterUrl: "" })}
                      />
                      <Box paddingBlockStart="500">
                        <Button
                          variant="plain"
                          onClick={() => swapRow(row.key)}
                          disabled={
                            busy ||
                            (!row.beforeUrl && !row.afterUrl) ||
                            // an in-flight upload targets a FIXED slot —
                            // swapping under it would land the photo on
                            // the wrong side (review catch)
                            pendingCells.has(cellKey(row.key, "beforeUrl")) ||
                            pendingCells.has(cellKey(row.key, "afterUrl"))
                          }
                        >
                          Swap
                        </Button>
                      </Box>
                    </>
                  )}
                  {defs.map((def, i) => (
                    <Box key={i} minWidth="120px" maxWidth="140px">
                      <TextField
                        label={def.label.trim() || `Measurement ${i + 1}`}
                        value={row.pcts[i] ?? ""}
                        onChange={(value) => setPct(row.key, i, value)}
                        suffix="%"
                        inputMode="decimal"
                        autoComplete="off"
                        disabled={busy}
                        placeholder="34.2"
                        error={
                          (row.pcts[i] ?? "") !== "" &&
                          measurementPctError(row.pcts[i] ?? "")
                            ? "0.1–500, one decimal"
                            : undefined
                        }
                      />
                    </Box>
                  ))}
                  {perPerson ? (
                    <>
                      <Box minWidth="130px">
                        <Select
                          label="Age range"
                          options={AGE_OPTIONS}
                          value={row.ageRange}
                          onChange={(ageRange) => setRow(row.key, { ageRange })}
                          disabled={busy}
                        />
                      </Box>
                      <Box minWidth="130px">
                        <Select
                          label="Skin type"
                          options={SKIN_OPTIONS}
                          value={row.skinType}
                          onChange={(skinType) => setRow(row.key, { skinType })}
                          disabled={busy}
                        />
                      </Box>
                    </>
                  ) : null}
                  <Box paddingBlockStart="500">
                    <Button
                      variant="plain"
                      tone="critical"
                      onClick={() => removeRow(row.key)}
                      disabled={busy}
                    >
                      Remove row
                    </Button>
                  </Box>
                </InlineStack>
                {problem ? (
                  <Text as="p" variant="bodySm" tone="critical">
                    {problem}
                  </Text>
                ) : null}
              </BlockStack>
            </Box>
          );
        })}

        {rows.length < MAX_BATCH_ROWS ? (
          <InlineStack>
            <Button
              onClick={() => {
                addRow();
              }}
              disabled={busy}
            >
              Add row
            </Button>
          </InlineStack>
        ) : null}
      </BlockStack>

      <Divider />

      <InlineStack gap="300" wrap blockAlign="start">
        <Box minWidth="240px">
          <Select
            label="Status"
            options={BATCH_STATUS_OPTIONS}
            value={status}
            onChange={setStatus}
            disabled={busy}
            helpText="Pending rows publish later with one click of “Approve all pending”."
          />
        </Box>
        <Box paddingBlockStart="500">
          <Checkbox
            label="Verified"
            checked={verified}
            onChange={setVerified}
            disabled={busy}
            helpText="Counts toward the scale banner."
          />
        </Box>
        <Box paddingBlockStart="500">
          <Checkbox
            label="Save these study settings as a preset"
            checked={savePreset}
            onChange={setSavePreset}
            disabled={busy}
            helpText="Same name updates that preset."
          />
        </Box>
      </InlineStack>

      {rows.length > 0 && !valid && !busy ? (
        <Banner tone="warning">
          <Text as="p" variant="bodySm">
            {uploadsPending
              ? "Photos are still uploading."
              : study.trim() === ""
                ? "The batch needs a study name."
                : defLabelMissing
                  ? "Every measurement needs a label."
                  : defsNeedDuration
                    ? "Measurements need Duration (weeks)."
                    : rowsInvalid
                      ? "Fix the rows marked below — every row needs its photos and every percent."
                      : "Fix the errors above."}
          </Text>
        </Banner>
      ) : null}

      <InlineStack gap="200">
        <Button
          variant="primary"
          onClick={submit}
          disabled={busy || !valid}
          loading={busy}
        >
          {rows.length === 0
            ? "Add results"
            : `Add ${rows.length} result${rows.length === 1 ? "" : "s"}`}
        </Button>
      </InlineStack>
    </BlockStack>
  );
}
