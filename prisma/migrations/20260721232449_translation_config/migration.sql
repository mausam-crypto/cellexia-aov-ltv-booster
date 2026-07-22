-- CreateTable
CREATE TABLE "TranslationConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'deepl',
    "apiKey" TEXT NOT NULL DEFAULT '',
    "autoOnSave" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "TranslationConfig_shop_key" ON "TranslationConfig"("shop");
