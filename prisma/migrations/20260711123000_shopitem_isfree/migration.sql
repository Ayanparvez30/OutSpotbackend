-- Explicit free/paid flag for shop items. Until now "free" was inferred as
-- "both store SKUs null"; the shared-SKU cosmetic flow makes that inference
-- wrong (paid items also have null per-item SKUs).
ALTER TABLE `ShopItem` ADD COLUMN `isFree` BOOLEAN NOT NULL DEFAULT false;

-- Backfill preserves existing behavior exactly: rows that were "free" under the
-- old convention (no per-item SKU on either platform) become isFree = true;
-- everything that had a SKU stays paid.
UPDATE `ShopItem`
  SET `isFree` = true
  WHERE `appleProductId` IS NULL AND `googleProductId` IS NULL;
