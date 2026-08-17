/**
 * Cosmetic IAP — one $2.99 transaction unlocks exactly ONE item.
 *
 * All cosmetics share a single consumable store SKU; the item is chosen by the
 * client via itemId. The security guard is: receiptTxId is single-use, so a
 * paid receipt cannot be replayed against other itemIds to grab the catalog.
 *
 * These stubs enforce ItemPurchase.receiptTxId uniqueness exactly like the DB
 * unique index the migration adds. Pure stubs, no DB / no network.
 */
let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } }

const ITEMS = {
  1: { id: 1, slot: 'TOP',   name: 'Blue Tee', priceUsd: 2.99 },
  2: { id: 2, slot: 'SHOES', name: 'Red Kicks', priceUsd: 2.99 },
};

// Fake DB with a real unique constraint on ItemPurchase.receiptTxId.
let itemPurchases;   // array of rows
let inventory;       // Set of `${userId}:${itemId}`
function resetDb() { itemPurchases = []; inventory = new Set(); }

const fakePrisma = {
  shopItem:      { findUnique: async ({ where }) => ITEMS[where.id] || null },
  multiplierProduct: { findUnique: async () => null },
  minime:        { findFirst: async () => null },
  itemPurchase: {
    create: async ({ data }) => {
      if (itemPurchases.some(r => r.receiptTxId === data.receiptTxId)) {
        const e = new Error('Unique constraint failed'); e.code = 'P2002'; throw e;
      }
      const row = { id: itemPurchases.length + 1, ...data };
      itemPurchases.push(row);
      return row;
    },
    findUnique: async ({ where }) =>
      itemPurchases.find(r => r.receiptTxId === where.receiptTxId) || null,
  },
  userInventory: {
    upsert: async ({ where }) => {
      const k = `${where.userId_itemId.userId}:${where.userId_itemId.itemId}`;
      inventory.add(k);
      return { id: inventory.size, userId: where.userId_itemId.userId, itemId: where.userId_itemId.itemId, equipped: false };
    },
    updateMany: async () => ({ count: 0 }),
    update:     async () => ({}),
    findMany:   async ({ where }) => [...inventory].filter(k => k.startsWith(`${where.userId}:`)).map(k => ({ item: {} })),
  },
};

// ---- Stubs (must precede controller require) ----
const prismaClientPath = require.resolve('@prisma/client');
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};
// Real verifier is a stub in the repo; emulate "receipt string → deterministic txId".
const iapPath = require.resolve('../utils/iapVerify');
require.cache[iapPath] = {
  id: iapPath, filename: iapPath, loaded: true,
  exports: {
    verifyApple:  async (r) => ({ ok: !!r, transactionId: `apple_${r}` }),
    verifyGoogle: async (r) => ({ ok: !!r, transactionId: `google_${r}` }),
  },
};
for (const [p, ex] of [
  ['../utils/minimeLoadout', { applyClothingToCurrentMinime: async () => {} }],
  ['../utils/minimeGen', { renderCurrentMinime: async () => ({}) }],
  ['../utils/realtime', { toUser: () => {}, toUsers: () => {}, toFriends: () => {}, toGroup: () => {}, toCommunity: () => {} }],
]) {
  const rp = require.resolve(p);
  require.cache[rp] = { id: rp, filename: rp, loaded: true, exports: ex };
}

const shop = require('../controllers/shopController');

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
async function buy({ receipt, itemId, platform = 'google', transactionId }) {
  const body = { platform, productId: 'item_unlock_299', receipt, type: 'item', itemId };
  if (transactionId) body.transactionId = transactionId;
  const req = { authData: { id: 7 }, body };
  const res = makeRes();
  await shop.confirmIAPPurchase(req, res);
  return res;
}

(async () => {
  console.log('\n=== cosmetic IAP: one transaction = one item ===\n');

  // 1) A fresh paid receipt unlocks the chosen item.
  resetDb();
  let res = await buy({ receipt: 'rcpt-A', itemId: 1 });
  ok('fresh receipt → item 1 granted (200)', res.statusCode === 200 && inventory.has('7:1'), `status=${res.statusCode}`);

  // 2) THE EXPLOIT: replay the SAME receipt against a DIFFERENT item → rejected.
  res = await buy({ receipt: 'rcpt-A', itemId: 2 });
  ok('same receipt, different item → 409 rejected', res.statusCode === 409, `status=${res.statusCode}`);
  ok('  item 2 NOT granted', !inventory.has('7:2'));

  // 3) Only ONE payment row exists for that receipt.
  ok('exactly one ItemPurchase row for rcpt-A', itemPurchases.filter(r => r.receiptTxId === 'google_rcpt-A').length === 1);

  // 4) Re-sending the SAME receipt for the SAME item → harmless retry (still 200).
  res = await buy({ receipt: 'rcpt-A', itemId: 1 });
  ok('same receipt, same item → idempotent 200', res.statusCode === 200);

  // 5) A NEW paid receipt unlocks another item (normal second purchase).
  res = await buy({ receipt: 'rcpt-B', itemId: 2 });
  ok('new receipt → item 2 granted (200)', res.statusCode === 200 && inventory.has('7:2'));

  // 6) Shared-SKU guard: wrong productId rejected when env SKU is set.
  process.env.IAP_ITEM_SKU_GOOGLE = 'item_unlock_299';
  resetDb();
  const req = { authData: { id: 7 }, body: { platform: 'google', productId: 'some_cheaper_sku', receipt: 'rcpt-C', type: 'item', itemId: 1 } };
  const badRes = makeRes();
  await shop.confirmIAPPurchase(req, badRes);
  ok('wrong SKU with shared-SKU set → 400', badRes.statusCode === 400, `status=${badRes.statusCode}`);
  delete process.env.IAP_ITEM_SKU_GOOGLE;

  // 7) iOS path works the same (distinct txId namespace).
  resetDb();
  res = await buy({ receipt: 'rcpt-A', itemId: 1, platform: 'apple' });
  ok('apple fresh receipt → granted', res.statusCode === 200 && inventory.has('7:1'));
  res = await buy({ receipt: 'rcpt-A', itemId: 2, platform: 'apple' });
  ok('apple replay different item → 409', res.statusCode === 409);

  // 8) iOS CUMULATIVE receipt — the real-world bug. Same app-receipt string for
  //    every purchase, but the app sends a distinct per-transaction id. Dedup
  //    must key on transactionId, so shirt then pant BOTH succeed.
  resetDb();
  const iosReceipt = 'IOS-CUMULATIVE-APP-RECEIPT-BLOB';
  res = await buy({ platform: 'apple', receipt: iosReceipt, transactionId: 'txn-1', itemId: 1 });
  ok('iOS shirt (txn-1) → 200', res.statusCode === 200 && inventory.has('7:1'), `status=${res.statusCode}`);
  res = await buy({ platform: 'apple', receipt: iosReceipt, transactionId: 'txn-2', itemId: 2 });
  ok('iOS pant, SAME receipt, new txn-2 → 200 (no false "already used")', res.statusCode === 200 && inventory.has('7:2'), `status=${res.statusCode}`);
  ok('  two ItemPurchase rows', itemPurchases.filter(r => r.userId === 7).length === 2);
  // Replaying the SAME transactionId against a different item is still blocked.
  res = await buy({ platform: 'apple', receipt: iosReceipt, transactionId: 'txn-1', itemId: 2 });
  ok('iOS replay SAME txn-1, different item → 409', res.statusCode === 409, `status=${res.statusCode}`);

  console.log('\n========================================');
  console.log(`Result: ${PASS} passed, ${FAIL} failed`);
  console.log('========================================');
  process.exit(FAIL > 0 ? 1 : 0);
})();
