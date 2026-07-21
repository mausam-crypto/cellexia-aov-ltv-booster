-- AlterTable
ALTER TABLE "Event" ADD COLUMN "market" TEXT;

-- AlterTable
ALTER TABLE "OrderStat" ADD COLUMN "countryCode" TEXT;
ALTER TABLE "OrderStat" ADD COLUMN "market" TEXT;

-- CreateTable
CREATE TABLE "Experiment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "flips" TEXT NOT NULL,
    "revertState" TEXT NOT NULL,
    "settingsHash" TEXT,
    "baselineDays" INTEGER NOT NULL,
    "baselineFrom" DATETIME NOT NULL,
    "baselineTo" DATETIME NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endsAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "concludedAt" DATETIME,
    "outcome" TEXT,
    "warningJson" TEXT,
    "reportJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Experiment_shop_status_idx" ON "Experiment"("shop", "status");

-- CreateIndex
CREATE INDEX "Event_shop_market_createdAt_idx" ON "Event"("shop", "market", "createdAt");

-- CreateIndex
CREATE INDEX "OrderStat_shop_market_processedAt_idx" ON "OrderStat"("shop", "market", "processedAt");
