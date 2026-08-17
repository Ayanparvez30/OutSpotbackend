# Chat Lock API

Per-user password lock on a chat. Each participant maintains their own lock —
one user locking a chat has no effect on the others. Distinct from
`PUT /api/chats/lock/:chatId` (group-freeze admin flag on `Chat.isLocked`),
which stays as-is.

## Auth & envelope

- All endpoints require `Authorization: Bearer <token>` (app auth token).
- All responses use the standard envelope:
  ```json
  { "status": true, "message": "...", "data": { ... } }
  ```
- Non-2xx responses use the same envelope with `status: false`.

## Model

Server-side, one row per (userId, chatId):

```
ChatLock {
  id, userId, chatId, passwordHash (bcrypt), createdAt, updatedAt
  UNIQUE(userId, chatId)
}
```

`passwordHash` is NEVER returned to the client.

Client already stores biometric opt-in and "unlocked this session" state
on-device; the backend does not track unlock sessions.

---

## Endpoints

### 1. POST `/api/chats/:chatId/lock` — Create OR change lock

**Request body**:
```json
{
  "password": "hunter2",            // required, min length 4
  "currentPassword": "old-one"      // required ONLY if a lock already exists
}
```

**Semantics**:
- If no lock exists for `(caller, chatId)` → create with `bcrypt.hash(password, 10)`.
- If a lock exists → `currentPassword` must match. On success, replace hash.

**Success (200)**:
```json
{ "status": true, "message": "Chat locked" }
```
or on overwrite:
```json
{ "status": true, "message": "Chat lock updated" }
```

**Errors**:
| Code | Message | Cause |
|---|---|---|
| 400 | `"Password must be at least 4 characters"` | Missing / short / non-string password |
| 400 | `"Current password required to change the lock"` | Lock exists but currentPassword missing/empty |
| 400 | `"Invalid chatId"` | `:chatId` not a number |
| 403 | `"Not a participant of this chat"` | Caller not in `UserOnChat` for this chatId |
| 403 | `"Current password is incorrect"` | `bcrypt.compare(currentPassword, hash)` failed |
| 500 | `"Failed to set chat lock"` | Unexpected server error |

---

### 2. POST `/api/chats/:chatId/lock/verify` — Check a password

**Request body**:
```json
{ "password": "hunter2" }
```

**Success (200) — password matches**:
```json
{ "status": true, "message": "Unlocked", "data": { "ok": true } }
```

**Success (200) — password does NOT match**:
```json
{ "status": true, "message": "Incorrect password", "data": { "ok": false } }
```

**Success (200) — no lock exists for this chat**:
```json
{ "status": true, "message": "No lock set", "data": { "ok": false } }
```

> ⚠ Wrong password is a **200** response with `data.ok = false`, NOT a 4xx.
> Client should show an inline "Incorrect password" message.

**Rate limit**:
- 5 wrong attempts per (user, chat) per 15-minute sliding window.
- Password compared FIRST, so a correct guess at the boundary still succeeds
  and resets the counter.
- On the wrong bump that crosses the cap → response becomes 429 with
  `Retry-After` header (seconds until window resets).
- Budget is SHARED with `DELETE /api/chats/:chatId/lock` on the same
  (user, chat) key.

**Errors**:
| Code | Message | Cause |
|---|---|---|
| 400 | `"Password required"` | Missing / non-string password |
| 400 | `"Invalid chatId"` | `:chatId` not a number |
| 403 | `"Not a participant of this chat"` | Caller not in `UserOnChat` |
| 429 | `"Too many attempts. Try again later."` | 5 wrong within 15 min. Header: `Retry-After: <seconds>` |
| 500 | `"Failed to verify chat lock"` | Unexpected server error |

---

### 3. DELETE `/api/chats/:chatId/lock` — Remove lock

**Request body**:
```json
{ "password": "hunter2" }
```

**Semantics**: verify password first (bcrypt.compare), then delete the row.

**Success (200)**:
```json
{ "status": true, "message": "Chat lock removed" }
```

**Rate limit**: same shared budget as `verify`. Wrong password bumps the
counter and can trigger 429 the same way.

**Errors**:
| Code | Message | Cause |
|---|---|---|
| 400 | `"Password required"` | Missing / non-string password |
| 400 | `"Invalid chatId"` | `:chatId` not a number |
| 403 | `"Not a participant of this chat"` | Caller not in `UserOnChat` |
| 403 | `"Incorrect password"` | Password mismatch (also bumps rate counter) |
| 404 | `"No lock exists for this chat"` | Nothing to delete |
| 429 | `"Too many attempts. Try again later."` | Header: `Retry-After: <seconds>` |
| 500 | `"Failed to remove chat lock"` | Unexpected server error |

---

### 4. GET `/api/chats/:chatId/lock/status` — Is this chat locked for me?

No body.

**Success (200)**:
```json
{
  "status": true,
  "message": "OK",
  "data": { "isPasswordLocked": true }
}
```

**Errors**:
| Code | Message | Cause |
|---|---|---|
| 400 | `"Invalid chatId"` | `:chatId` not a number |
| 403 | `"Not a participant of this chat"` | Caller not in `UserOnChat` |
| 500 | `"Failed to fetch lock status"` | Unexpected server error |

---

## `isPasswordLocked` on existing chat payloads

Every chat object returned by these endpoints now carries a per-caller
`isPasswordLocked: boolean`:

- `GET /api/chats`                  — main chat list (getMyChats)
- `GET /api/chats/unread`           — unread chats (getUnreadChats)
- `GET /api/chats/groupsOnly`       — group chats (getMyGroupChats)
- `GET /api/chats/:user2Id`         — 1:1 chat-detail lookup (getChatsByUsers)

Example (getMyChats):
```json
[
  {
    "id": 42,
    "name": null,
    "isGroup": false,
    "isCommunity": false,
    "isLocked": false,           // ← unchanged: group-freeze admin flag
    "isPasswordLocked": true,    // ← NEW: per-user chat lock
    "unreadCount": 3,
    "isMuted": false,
    "latestMessage": { "id": 987, "content": "Yo", "senderId": 7, "createdAt": "..." },
    ...
  }
]
```

`getChatsByUsers` response shape changed from `[{ chatId }]` to
`[{ chatId, isPasswordLocked }]` (additive — old clients ignoring the new
key still work).

---

## Client contract notes (already implemented in Flutter)

- Biometric opt-in stored on-device (Keychain/Keystore); Face ID / fingerprint
  runs locally, no backend call.
- "Unlocked this session" kept in memory; re-locks on app background.
- When `isPasswordLocked = true`: hide chat-list preview + read-receipt tick,
  show a lock icon.
- On enter chat: if locked, show password sheet → `POST /lock/verify`. On
  `{ ok: true }` allow through; on `{ ok: false }` keep sheet, show inline error;
  on 429 show "Too many attempts, try again in X min" using `Retry-After`.

---

## Migration

Table: `ChatLock`. Migration file:
`prisma/migrations/20260709120000_add_chat_lock/migration.sql`.

Run on prod BEFORE deploying (auto-deploy does not run migrations):
```bash
npx prisma migrate deploy
```

---

## Optional hardening (not implemented in v1)

- Server-side gate on `GET /chats/:chatId/messages`: reject unless the request
  carries a short-lived unlock token minted by `/lock/verify`. The client
  already hides messages until unlocked, so this is defense-in-depth for the
  "messages never leave the server unlocked" property.
