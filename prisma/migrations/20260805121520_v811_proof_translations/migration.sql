-- CreateTable
CREATE TABLE "ProofTranslation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sourceDigest" TEXT NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ProofTranslation_shop_resourceType_resourceId_idx" ON "ProofTranslation"("shop", "resourceType", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProofTranslation_shop_resourceType_resourceId_locale_field_key" ON "ProofTranslation"("shop", "resourceType", "resourceId", "locale", "field");
