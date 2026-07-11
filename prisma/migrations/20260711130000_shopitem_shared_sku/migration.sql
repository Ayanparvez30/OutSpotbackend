-- Move all paid cosmetics onto ONE shared store SKU so the app is server-driven:
-- it reads productId off the catalog and buys whatever's there. To let many
-- items share a value, the per-item unique indexes must go first.
--
-- ShopItem is only ever looked up by id (never by SKU), so dropping these unique
-- indexes changes no query behavior.
DROP INDEX `ShopItem_appleProductId_key` ON `ShopItem`;
DROP INDEX `ShopItem_googleProductId_key` ON `ShopItem`;

-- Point every existing PAID item at the shared consumable SKU. Free items keep
-- NULL SKUs. After this, the currently released app (which buys the catalog's
-- productId) automatically purchases the shared SKU — no app release needed.
UPDATE `ShopItem`
  SET `appleProductId` = 'item_unlock_299',
      `googleProductId` = 'item_unlock_299'
  WHERE `isFree` = false;
