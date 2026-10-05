-- v34: admin-only study presets for batch-entering before/afters from the
-- same clinical study (per-study constants as one JSON payload; the entry
-- still passes saveResult's full validation when it is saved).
CREATE TABLE "ResultPreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "ResultPreset_shop_name_key" ON "ResultPreset"("shop", "name");
