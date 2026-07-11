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

### This is SERVER-DRIVEN — you do NOT hard-code the SKU

The backend now returns `item_unlock_299` as **every paid cosmetic's**
`appleProductId` / `googleProductId` in the catalog. **Keep doing exactly what
you do today** — read the product id off the catalog item and buy that. Because
that value is now the shared SKU for all of them, the app buys the shared SKU
automatically, with **no code change** to the SKU logic and **no new app
release** required for the switch itself.

> If a future SKU rename is ever needed, it's a backend/DB change only — the app
> keeps reading whatever id the catalog serves.

### ⚠️ The ONE thing that may need an app change: CONSUMABLE handling

The old per-item products were bought **once** each (one-time unlocks), so the
app likely treated them as **non-consumable**. The shared product is a
**consumable** — it's purchased again and again (once per cosmetic). That means:

- Buy it as a **consumable**.
- **Consume / finish** the transaction after every successful purchase.

If you do **not** consume it, the store will refuse the user's *next* cosmetic
purchase (it thinks they still own the un-consumed one). **Check how cosmetic
purchases are handled today** — if they're non-consumable / never consumed, that
must change. This is the only part that isn't purely server-driven.

## 1.2 What stays the same (do NOT change)

- **Catalog loading and display.** Same endpoints, same JSON, same images.
  Your shop and wardrobe screens do not change how they fetch or render.
- **Reading the product id off the catalog to start a purchase.** Same as today —
  the value is just the shared SKU now.
- **Point-multiplier purchases.** Unchanged — multipliers still have their own
  individual SKUs and are bought exactly as they are today.

## 1.3 What you must change

1. **Consumable handling** — buy the cosmetic product as a **consumable** and
   **consume/finish** it after each purchase (see the ⚠️ above). This is the main one.
2. Handle the new **`409` "already used"** response on the confirm call.
3. (Pricing) The price comes from the store product — since all cosmetics share
   one product, they all show the same $2.99 (see 1.5).

> Note: you do NOT change the SKU itself — the catalog serves the shared SKU.

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
| `appleProductId` / `googleProductId` | string | The store SKU to buy — now the shared `item_unlock_299` for every paid item. Read it and buy it, same as today. Null for free items. |
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

**Step 1 — Buy the product** using the `googleProductId` / `appleProductId` from
the catalog item (now `item_unlock_299` for every paid cosmetic). Buy it as a
**consumable**. Remember which `itemId` the user is buying — you need it in step 2.

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
| `productId` | string | ✅ | The SKU you bought — i.e. the catalog item's `googleProductId`/`appleProductId` (= `"item_unlock_299"`) |
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

**Shop (Part 1):** — the SKU is server-driven; the real app work is the consumable + 409.
- [ ] **Buy the cosmetic product as a CONSUMABLE and consume/finish it after every purchase.** (If cosmetics are currently non-consumable, this is the key change — else the 2nd purchase is blocked by the store.)
- [ ] Keep reading the product id off the catalog item (`googleProductId`/`appleProductId`) and buy that — it's now the shared SKU. No hard-coding, no SKU logic change.
- [ ] `POST /shop/iap/confirm` with `type:"item"`, the catalog `itemId`, and the productId you bought (unchanged call shape).
- [ ] Handle `409 "This purchase was already used"` (never retry the same receipt).
- [ ] Show price from the shared store product's localized price (all cosmetics = $2.99).
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
