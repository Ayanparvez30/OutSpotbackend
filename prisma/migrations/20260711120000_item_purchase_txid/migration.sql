-- One row per paid cosmetic unlock. All cosmetics share a single $2.99
-- consumable store SKU; receiptTxId is UNIQUE so one store transaction unlocks
-- exactly one item (replay guard).
CREATE TABLE `ItemPurchase` (
  `id`          INTEGER      NOT NULL AUTO_INCREMENT,
  `userId`      INTEGER      NOT NULL,
  `itemId`      INTEGER      NOT NULL,
  `productId`   VARCHAR(191) NOT NULL,
  `platform`    VARCHAR(191) NOT NULL,
  `priceUsd`    DECIMAL(10, 2) NOT NULL,
  `receiptTxId` VARCHAR(191) NOT NULL,
  `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `ItemPurchase_receiptTxId_key`(`receiptTxId`),
  INDEX `ItemPurchase_userId_createdAt_idx`(`userId`, `createdAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ItemPurchase`
  ADD CONSTRAINT `ItemPurchase_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ItemPurchase`
  ADD CONSTRAINT `ItemPurchase_itemId_fkey`
  FOREIGN KEY (`itemId`) REFERENCES `ShopItem`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
