# Frontend Contract — Shop IAP (shared SKU) + Mini-Me face source

**Audience:** Flutter developer.
**Status:** Backend is deployed to production. These are the frontend changes
required to match it. No backend request/response shape will change again for
this — build against this document.

There are two changes:

1. **Shop cosmetics now use ONE shared IAP product** — the big one.
2. **Mini-Me `faceSource` field** — small, one new field.

---

# PART 1 — Shop cosmetics: one shared IAP SKU for everything

## 1.1 The core change (read this first)

**Before:** every cosmetic item (100+ shirts, watches, glasses, …) was its own
separate Play Store / App Store in-app-purchase product. Each had its own
`appleProductId` / `googleProductId`.

**Now:** there is **exactly one** in-app-purchase product for **all** cosmetics.
Every clothing/watch/accessory purchase buys that same product. The backend
figures out **which** item to unlock from an `itemId` you send in the confirm
call — not from the store product.

```
SHARED COSMETIC PRODUCT (consumable):
    Android : item_unlock_299
    iOS     : item_unlock_299
    Price   : $2.99   (all cosmetics are the same price — that's what makes this possible)
```

> It is a **consumable** product, on purpose. The same product is purchased over
> and over — once per cosmetic the user unlocks. So after every successful
> purchase you must **consume / finish** the transaction, or the store will not
> let the user buy it again.

## 1.2 What stays the same (do NOT change)

- **Catalog loading and display.** Same endpoints, same JSON, same images.
  Your shop and wardrobe screens do not change how they fetch or render.
- **Point-multiplier purchases.** Unchanged — multipliers still have their own
  individual SKUs and are bought exactly as they are today.

## 1.3 What you must change (three things)

1. Buy the **single shared SKU** for every cosmetic (instead of a per-item SKU).
2. Display the price by reading it from the **store product** for that shared SKU.
3. Handle a new **`409` "already used"** response on the confirm call.

---

## 1.4 Catalog endpoints — UNCHANGED

```
GET /api/shop/catalog?gender=masculine|feminine        → all paid items
GET /api/shop/catalog/paid?gender=masculine|feminine   → paid items only
GET /api/shop/catalog/free?gender=masculine|feminine    → free items only
```

Headers: `Authorization: Bearer <token>`.

Each item in the response:

| Field | Type | Notes |
|---|---|---|
| `id` | int | **This is what you send as `itemId` when buying.** |
| `slot` | string | TOP / BOTTOM / SHOES / GLASSES / WATCH / MAKEUP / PURSE / ORNAMENT |
| `name` | string | |
| `brand` | string / null | |
| `imageUrl` | string | Admin-uploaded image — render exactly as today. |
| `isFeatured` | bool | |
| `gender` | string | masculine / feminine |
| `priceUsd` | string | Reference number only — for display prefer the store price (see 1.5). |

Response wrapper:

```json
{ "success": true, "data": { "items": [ … ], "grouped": { "TOP": [ … ], … }, "total": 42 } }
```

> Free vs paid is decided **server-side** now (an internal `isFree` flag). You do
> not add any logic — `/paid` returns paid items, `/free` returns free items,
> same as before. You never see or send `isFree`.

---

## 1.5 Pricing — take the price from the store product

Because all cosmetics share one product, query the store **once** for
`item_unlock_299` and use that product's localized price string on **every**
cosmetic card. They will all show the same price ($2.99, localized per region).

- Use the store product's localized `price` (e.g. `"$2.99"`, `"€2,99"`).
- Do not build the price from `priceUsd` — that's a bare number without currency
  formatting.

---

## 1.6 Purchase flow — step by step

**Step 1 — Buy the shared consumable product** `item_unlock_299` through the
store (the normal consumable purchase flow). Remember which `itemId` the user is
buying — you'll need it in step 2.

**Step 2 — On a successful store purchase, confirm with the backend:**

```
POST /api/shop/iap/confirm
Authorization: Bearer <token>
Content-Type: application/json
```

Request body:

| Field | Type | Required | Value |
|---|---|---|---|
| `platform` | string | ✅ | `"google"` or `"apple"` |
| `productId` | string | ✅ | `"item_unlock_299"` — the shared SKU, **not** a per-item id |
| `receipt` | string | ✅ | Android: the `purchaseToken`. iOS: the transaction receipt / token. |
| `type` | string | ✅ | `"item"` |
| `itemId` | int | ✅ | The catalog item `id` the user is unlocking |
| `applyNow` | bool | optional | `true` = also equip it onto the mini-me immediately |

Example:

```json
{
  "platform":  "google",
  "productId": "item_unlock_299",
  "receipt":   "<purchaseToken>",
  "type":      "item",
  "itemId":    402,
  "applyNow":  true
}
```

**Step 3 — Consume / finish the store transaction.** It is a consumable; if you
don't finish it, the next cosmetic purchase will be blocked by the store.

---

## 1.7 Confirm responses — handle all of these

| HTTP | `message` | Meaning | What the app should do |
|---|---|---|---|
| `200` | `Item granted` | Success. Item added to inventory. | Refresh wardrobe from `data.wardrobe`; show success. Still consume the store txn (step 3). |
| `409` | `This purchase was already used` | That receipt/transaction was already spent. **One payment unlocks exactly one item.** | Do **not** re-send the same receipt. Surface a clear message. |
| `400` | `Invalid product for item purchase` | `productId` wasn't the shared SKU. | Send `item_unlock_299`. |
| `400` | `itemId required for item purchase` | Missing `itemId`. | Always include `itemId`. |
| `400` | `platform, productId, receipt, type are required` | A required field missing. | Fill all required fields. |
| `404` | `Item not found` | Bad `itemId`. | Check the id from the catalog. |

**The one rule to internalize:** *one store transaction = one item.* The receipt
you get from buying `item_unlock_299` unlocks the single `itemId` you send with
it. You cannot reuse that receipt to unlock a second item — that returns `409`.
To unlock another cosmetic, start a brand-new purchase.

## 1.8 Success (200) body

```json
{
  "success": true,
  "message": "Item granted",
  "data": {
    "item":          { "id": 402, "slot": "TOP", "name": "…", "imageUrl": "…" },
    "inventory":     { "id": 100, "userId": 7, "itemId": 402, "equipped": false },
    "minime":        { /* latest mini-me — present only when applyNow=true */ },
    "wardrobeCount": 12,
    "wardrobe":      [ { "item": { … }, "equipped": true }, … ]
  }
}
```

## 1.9 Multipliers — unchanged

Point multipliers keep their own per-tier SKUs and are bought exactly as today:

```
POST /api/shop/iap/confirm
{ "platform": "...", "productId": "<multiplier SKU>", "receipt": "...", "type": "multiplier" }
```

Nothing about the multiplier flow changes.

---

# PART 2 — Mini-Me `faceSource` (premade can override an existing selfie)

## 2.1 Why

Previously, once a user uploaded a real selfie, generating a mini-me **always**
used that selfie — they could never switch their face to a premade avatar. The
app now states which face to use.

## 2.2 The change — one new field on generate

```
POST /api/minime/generate
Authorization: Bearer <token>
```

Add **`faceSource`** to the body (all your existing fields stay):

| Field | Type | Required | Notes |
|---|---|---|---|
| `faceSource` | string | recommended | `"premade"` or `"selfie"` |
| `premadeId` | int | required **if** `faceSource == "premade"` | Which premade face |
| *(existing fields: bodyType, bodyShapeUrl, shirt, pant, …)* | | | Unchanged |

Behavior:

| `faceSource` | Face used to generate |
|---|---|
| `"premade"` (with `premadeId`) | The chosen premade — **even if the user already has a selfie**. |
| `"selfie"` | The user's uploaded selfie. |
| omitted | Legacy fallback: selfie if one exists, else premade, else last mini-me. |

Errors:

- `faceSource: "premade"` without `premadeId` → `400 "premadeId required when faceSource is premade"`.
- No usable face at all → `400 "No selfie found. Please upload a selfie or select a premade avatar first."`

## 2.3 Related endpoints — unchanged

- **Upload selfie:** `POST /api/minime/upload-avatar` (existing) sets the user's
  selfie. Must happen before `faceSource: "selfie"` can be used.
- **Regenerate:** `POST /api/minime/regenerate` needs **no** `faceSource`. It
  keeps whatever face the current draft was built with — a premade will not
  silently revert to the selfie.

## 2.4 Recommended app behavior

- User selects a **premade** face → send `faceSource: "premade"` + `premadeId`.
- User selects **"use my selfie"** → send `faceSource: "selfie"`.
- Send `faceSource` explicitly whenever the user makes the choice, so it's
  never ambiguous.

---

# Migration checklist

**Shop (Part 1):**
- [ ] Register the shared SKU `item_unlock_299` in the store product query.
- [ ] Show every cosmetic's price from that shared product's localized price.
- [ ] Cosmetic purchase → buy `item_unlock_299` (consumable) → `POST /shop/iap/confirm` with `type:"item"` + the catalog `itemId`.
- [ ] Always consume/finish the transaction after a cosmetic purchase.
- [ ] Handle `409 "This purchase was already used"` (never retry the same receipt).
- [ ] Leave the multiplier purchase flow unchanged.

**Mini-Me (Part 2):**
- [ ] Send `faceSource:"premade"` + `premadeId` when a premade is chosen.
- [ ] Send `faceSource:"selfie"` when the user picks their selfie.
- [ ] Leave the regenerate call unchanged.

# For whoever configures the store products

- **Cosmetics:** create **one** consumable product `item_unlock_299` priced $2.99
  on both Play Console and App Store Connect. It backs every cosmetic.
- **Multipliers:** keep the existing per-tier products.

---

_Backend note: server-side Apple/Google receipt verification is not enabled yet.
It does not affect any request/response shape above — when it is turned on, all
of these calls keep working exactly the same._
