-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PressItem" (
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
    "marketHandles" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_PressItem" ("articleUrl", "createdAt", "featured", "id", "logoUrl", "productGids", "publication", "quote", "shop", "sortWeight", "status", "updatedAt") SELECT "articleUrl", "createdAt", "featured", "id", "logoUrl", "productGids", "publication", "quote", "shop", "sortWeight", "status", "updatedAt" FROM "PressItem";
DROP TABLE "PressItem";
ALTER TABLE "new_PressItem" RENAME TO "PressItem";
CREATE INDEX "PressItem_shop_status_featured_sortWeight_idx" ON "PressItem"("shop", "status", "featured", "sortWeight");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
