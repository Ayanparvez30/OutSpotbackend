# Shop IAP — Flutter Integration (shared-SKU cosmetics)

Contract for the Flutter app after the shared-SKU migration. **The only real
change is on the purchase side.** Catalog fetch/display is unchanged.

---

## TL;DR

| Area | Change? | What |
|---|---|---|
| Catalog fetch (`/shop/catalog*`) | **No** | Same URLs, same response shape. Keep rendering as-is. |
| Item **price display** | **Yes (source)** | Read the price from the **store product** (the shared SKU), not from backend. |
| Cosmetic purchase | **Yes** | Buy **one shared consumable SKU** for every cosmetic; tell backend which `itemId`. |
| Multiplier purchase | **No** | Unchanged — per-tier SKUs as before. |

---

## 1. Catalog — no change

```
GET /api/shop/catalog?gender=masculine|feminine        // all paid items
GET /api/shop/catalog/paid?gender=masculine|feminine   // paid only
GET /api/shop/catalog/free?gender=masculine|feminine    // free only
```

Response shape is unchanged. Each item:

```json
{
  "id": 123,
  "slot": "TOP",
  "name": "Blue Hawaiian",
  "brand": "…",
  "imageUrl": "https://…",     // admin-uploaded image — render exactly as today
  "isFeatured": true,
  "gender": "masculine",
  "priceUsd": "2.99"           // reference only — see pricing note below
}
```

Free vs paid split is now decided server-side by an `isFree` flag. The app does
**not** need to change any catalog logic — `/catalog/paid` returns paid items,
`/catalog/free` returns free items, same as before.

---

## 2. Pricing — read the price from the STORE SKU

> **Important:** All paid cosmetics share **one** store product (SKU). Show the
> price by querying the store for that shared SKU, not per item.

- There is **one** consumable product in Play/App Store for all cosmetics:

  ```
  SHARED_COSMETIC_SKU = "item_unlock_299"   // same id on Android + iOS
  ```

- Query it once via `in_app_purchase` `queryProductDetails({ SHARED_COSMETIC_SKU })`
  and use `ProductDetails.price` (localized, e.g. "$2.99") for **every** cosmetic
  card. Because the same SKU backs all of them, they all show the same price.

- `item.priceUsd` from the API is a plain reference number — prefer the store's
  localized `price` string for display (correct currency/format per region).

---

## 3. Buying a cosmetic

Every cosmetic purchase buys the **same** shared consumable SKU. The backend
learns which item to unlock from `itemId` in the confirm call.

**Step 1 — buy the shared SKU on the store**

```dart
final resp = await InAppPurchase.instance.queryProductDetails({ "item_unlock_299" });
final product = resp.productDetails.first;
await InAppPurchase.instance.buyConsumable(
  purchaseParam: PurchaseParam(productDetails: product),
);
```

**Step 2 — on a successful purchase, confirm with backend**

```
POST /api/shop/iap/confirm
Authorization: Bearer <token>
{
  "platform":  "google" | "apple",
  "productId": "item_unlock_299",   // the shared SKU (NOT a per-item id)
  "receipt":   "<purchaseToken (Android) / transaction receipt (iOS)>",
  "type":      "item",
  "itemId":    123,                 // which cosmetic to unlock
  "applyNow":  true                 // optional: also equip onto the mini-me now
}
```

**Step 3 — finish/consume the store transaction** (required — it's consumable,
so it must be consumed to allow the next purchase):

```dart
await InAppPurchase.instance.completePurchase(purchaseDetails);
// Android consumables are auto-consumed by completePurchase; ensure it runs.
```

### Responses

| Status | Meaning | App action |
|---|---|---|
| `200` | Item granted. `data.wardrobe` = updated inventory, `data.minime` if `applyNow`. | Refresh wardrobe; show success. |
| `409` `"This purchase was already used"` | That receipt/transaction was already spent (one payment = one item). | Do **not** retry the same receipt; tell the user. |
| `400` `"Invalid product for item purchase"` | `productId` wasn't the shared SKU. | Fix the SKU sent. |
| `404` `"Item not found"` | Bad `itemId`. | — |

> **One transaction = one item.** A single `item_unlock_299` payment unlocks
> exactly the one `itemId` you send. Reusing the same receipt for another item
> is rejected (`409`). To unlock another cosmetic, make a new purchase.

---

## 4. Multipliers — no change

Point multipliers keep their own per-tier SKUs (different prices). Same call as
today:

```
POST /api/shop/iap/confirm
{ "platform": "...", "productId": "<multiplier SKU>", "receipt": "...", "type": "multiplier" }
```

---

## 5. Store console setup (for reference)

- **Cosmetics:** create **one** consumable product `item_unlock_299` ($2.99) on
  both Play Console and App Store Connect. Used by all clothes/watch/etc.
- **Multipliers:** keep the existing per-tier products (few, priced individually).

---

## Migration checklist (Flutter)

- [ ] Add the shared SKU `item_unlock_299` to the product-query set.
- [ ] Show cosmetic price from the shared SKU's `ProductDetails.price`.
- [ ] Cosmetic buy → `buyConsumable(item_unlock_299)`, then confirm with `itemId`.
- [ ] Always `completePurchase` (consume) after a cosmetic buy.
- [ ] Handle `409` (already-used receipt) gracefully.
- [ ] Multiplier flow untouched.
