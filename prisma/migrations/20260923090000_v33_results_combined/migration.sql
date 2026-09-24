-- v33 results gallery: ONE combined before+after photo for lab (clinical)
-- entries — an alternative to the separate beforeUrl/afterUrl pair (left
-- half = before, right half = after). Additive only; nullable keeps every
-- existing row valid.
ALTER TABLE "CustomerResult" ADD COLUMN "combinedUrl" TEXT;
