-- CreateTable
CREATE TABLE "PreviewState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "armed" BOOLEAN NOT NULL DEFAULT false,
    "armedAt" DATETIME,
    "draftFlags" TEXT NOT NULL DEFAULT '{}',
    "simulatedMarket" TEXT,
    "productHandle" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PreviewState_shop_key" ON "PreviewState"("shop");
