/*
  Warnings:

  - You are about to drop the column `tokenHash` on the `PreviewState` table. All the data in the column will be lost.
  - Added the required column `token` to the `PreviewState` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PreviewState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "armed" BOOLEAN NOT NULL DEFAULT false,
    "armedAt" DATETIME,
    "draftFlags" TEXT NOT NULL DEFAULT '{}',
    "simulatedMarket" TEXT,
    "productHandle" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_PreviewState" ("armed", "armedAt", "createdAt", "draftFlags", "id", "productHandle", "shop", "simulatedMarket", "updatedAt") SELECT "armed", "armedAt", "createdAt", "draftFlags", "id", "productHandle", "shop", "simulatedMarket", "updatedAt" FROM "PreviewState";
DROP TABLE "PreviewState";
ALTER TABLE "new_PreviewState" RENAME TO "PreviewState";
CREATE UNIQUE INDEX "PreviewState_shop_key" ON "PreviewState"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
