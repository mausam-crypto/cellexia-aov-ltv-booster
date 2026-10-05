-- v35: CustomerResult.study — the clinical study (study-batch) name a lab
-- entry belongs to. Nullable text; existing rows keep NULL (no study tag,
-- no grouping change). Lab-only at save time, like measurements.
ALTER TABLE "CustomerResult" ADD COLUMN "study" TEXT;
