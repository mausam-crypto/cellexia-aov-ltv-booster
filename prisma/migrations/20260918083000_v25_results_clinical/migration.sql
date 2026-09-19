-- v25 results-gallery clinical redesign: per-entry instrument measurements
-- (JSON list), the three explicit trust-mark claims, and testimonial
-- attribution. Additive only; defaults keep every existing row valid.
ALTER TABLE "CustomerResult" ADD COLUMN "measurements" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "CustomerResult" ADD COLUMN "markInstrument" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CustomerResult" ADD COLUMN "markSamePatient" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CustomerResult" ADD COLUMN "markUnretouched" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CustomerResult" ADD COLUMN "attributionName" TEXT;
ALTER TABLE "CustomerResult" ADD COLUMN "attributionRole" TEXT;
