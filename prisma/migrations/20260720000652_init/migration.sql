-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER,
    "revenue" REAL,
    "currency" TEXT,
    "meta" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OrderStat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "totalPrice" REAL NOT NULL,
    "currency" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "unitCount" INTEGER NOT NULL,
    "hasSubscription" BOOLEAN NOT NULL DEFAULT false,
    "hasProtection" BOOLEAN NOT NULL DEFAULT false,
    "upsellAttributed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE INDEX "Event_shop_feature_type_createdAt_idx" ON "Event"("shop", "feature", "type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderStat_orderId_key" ON "OrderStat"("orderId");

-- CreateIndex
CREATE INDEX "OrderStat_shop_processedAt_idx" ON "OrderStat"("shop", "processedAt");
