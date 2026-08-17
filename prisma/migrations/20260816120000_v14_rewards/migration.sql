-- AlterTable
ALTER TABLE "OrderStat" ADD COLUMN "kitCode" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OrderStat" ADD COLUMN "giftLines" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RewardsState" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "functionId" TEXT NOT NULL DEFAULT '',
    "nodes" TEXT NOT NULL DEFAULT '{}',
    "giftStock" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" DATETIME NOT NULL
);
