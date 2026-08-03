-- CreateTable
CREATE TABLE "PressItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sortWeight" INTEGER NOT NULL DEFAULT 0,
    "publication" TEXT NOT NULL,
    "logoUrl" TEXT,
    "quote" TEXT NOT NULL,
    "articleUrl" TEXT,
    "productGids" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DermEndorsement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sortWeight" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "credentials" TEXT,
    "country" TEXT,
    "quote" TEXT NOT NULL,
    "imageUrl" TEXT,
    "productGids" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CustomerResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sortWeight" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'customer',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "beforeUrl" TEXT,
    "afterUrl" TEXT,
    "ageRange" TEXT,
    "skinType" TEXT,
    "concern" TEXT,
    "durationWeeks" INTEGER,
    "country" TEXT,
    "testimonial" TEXT,
    "videoUrl" TEXT,
    "productGids" TEXT NOT NULL DEFAULT '[]',
    "legacyGid" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "PressItem_shop_status_featured_sortWeight_idx" ON "PressItem"("shop", "status", "featured", "sortWeight");

-- CreateIndex
CREATE INDEX "DermEndorsement_shop_status_featured_sortWeight_idx" ON "DermEndorsement"("shop", "status", "featured", "sortWeight");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerResult_legacyGid_key" ON "CustomerResult"("legacyGid");

-- CreateIndex
CREATE INDEX "CustomerResult_shop_status_featured_sortWeight_idx" ON "CustomerResult"("shop", "status", "featured", "sortWeight");

-- CreateIndex
CREATE INDEX "CustomerResult_shop_status_concern_idx" ON "CustomerResult"("shop", "status", "concern");
