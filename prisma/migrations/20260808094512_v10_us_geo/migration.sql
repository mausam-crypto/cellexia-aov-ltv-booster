-- CreateTable
CREATE TABLE "GeoStateDb" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'empty',
    "source" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "rangesV4" INTEGER NOT NULL DEFAULT 0,
    "rangesV6" INTEGER NOT NULL DEFAULT 0,
    "dataV4" BLOB,
    "dataV6" BLOB,
    "builtAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "GeoStateDb_shop_key" ON "GeoStateDb"("shop");
