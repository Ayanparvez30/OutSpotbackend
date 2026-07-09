// Per-user chat lock (password-protected chats).
//
// Each participant maintains their own ChatLock row for a chat; one user
// locking a chat does not affect the other. Unrelated to Chat.isLocked
// (group-freeze admin flag), which stays as-is.
//
// Endpoints (all under /api, all checkAuth):
//   POST   /chats/:chatId/lock              { password, currentPassword? }
//   POST   /chats/:chatId/lock/verify       { password }        → { ok }
//   DELETE /chats/:chatId/lock              { password }
//   GET    /chats/:chatId/lock/status                            → { isPasswordLocked }
//
// All responses use the standard envelope { status, message, data? } via
// functions/response.js.

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();
const { true_status, response_with_code } = require('../functions/response');

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 4;

// -------- verify rate limit (in-memory, per-process) --------
// Cap *wrong* attempts on POST /:chatId/lock/verify (and share the budget with
// DELETE /:chatId/lock). Key = `${userId}:${chatId}`. The password comparison
// happens FIRST; a correct guess resets the counter and always succeeds. A
// wrong guess bumps the counter, and if that bump crosses VERIFY_MAX_ATTEMPTS
// the response becomes 429 for the remainder of VERIFY_WINDOW_MS. This lets a
// user who knows the right password recover even at the boundary attempt.
//   markVerifyResult(userId, chatId, wasWrong) → { blocked, retryAfterMs? }
// (blocked=true means we're over the cap AFTER this result — send 429).
const VERIFY_WINDOW_MS = 15 * 60 * 1000; // 15 min
const VERIFY_MAX_ATTEMPTS = 5;
const verifyBuckets = new Map(); // key → { count, resetAt }

function _verifyKey(userId, chatId) { return `${userId}:${chatId}`; }
function markVerifyResult(userId, chatId, wasWrong) {
  const key = _verifyKey(userId, chatId);
  const now = Date.now();
  if (!wasWrong) {
    verifyBuckets.delete(key);
    return { blocked: false };
  }
  const existing = verifyBuckets.get(key);
  let bucket;
  if (!existing || now >= existing.resetAt) {
    bucket = { count: 1, resetAt: now + VERIFY_WINDOW_MS };
    verifyBuckets.set(key, bucket);
  } else {
    existing.count += 1;
    bucket = existing;
  }
  if (bucket.count > VERIFY_MAX_ATTEMPTS) {
    return { blocked: true, retryAfterMs: bucket.resetAt - now };
  }
  return { blocked: false };
}
function verifyLimitReset(userId, chatId) {
  verifyBuckets.delete(_verifyKey(userId, chatId));
}

// Membership check — reuses the pattern from the rest of chatController.
// Returns the UserOnChat row or null.
async function _assertMember(userId, chatId) {
  return prisma.userOnChat.findFirst({ where: { userId, chatId }, select: { id: true } });
}

// ---------- POST /chats/:chatId/lock ----------
// Create OR change the caller's lock on this chat.
//   Body: { password: string, currentPassword?: string }
// If a lock already exists, currentPassword must match before overwriting.
exports.setLock = async (req, res) => {
  try {
    const userId = req.authData.id;
    const chatId = parseInt(req.params.chatId, 10);
    if (!Number.isFinite(chatId)) return response_with_code(res, 400, 'Invalid chatId');

    const { password, currentPassword } = req.body || {};
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
      return response_with_code(res, 400, `Password must be at least ${MIN_PASSWORD_LEN} characters`);
    }

    const member = await _assertMember(userId, chatId);
    if (!member) return response_with_code(res, 403, 'Not a participant of this chat');

    const existing = await prisma.chatLock.findUnique({
      where: { userId_chatId: { userId, chatId } },
      select: { id: true, passwordHash: true },
    });

    if (existing) {
      // Change flow: require currentPassword to match before overwriting.
      if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
        return response_with_code(res, 400, 'Current password required to change the lock');
      }
      const ok = await bcrypt.compare(currentPassword, existing.passwordHash);
      if (!ok) return response_with_code(res, 403, 'Current password is incorrect');

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await prisma.chatLock.update({
        where: { id: existing.id },
        data: { passwordHash },
      });
      // A fresh password invalidates the old brute-force counter for this user.
      verifyLimitReset(userId, chatId);
      return true_status(res, undefined, 'Chat lock updated');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await prisma.chatLock.create({
      data: { userId, chatId, passwordHash },
    });
    return true_status(res, undefined, 'Chat locked');
  } catch (err) {
    console.error('setLock error:', err);
    return response_with_code(res, 500, 'Failed to set chat lock');
  }
};

// ---------- POST /chats/:chatId/lock/verify ----------
// Verify a password. Returns { ok: true } on match, { ok: false } on miss
// (200-status, not 4xx — client shows an inline "Incorrect password" message).
// Rate-limited to defend against brute force.
exports.verifyLock = async (req, res) => {
  try {
    const userId = req.authData.id;
    const chatId = parseInt(req.params.chatId, 10);
    if (!Number.isFinite(chatId)) return response_with_code(res, 400, 'Invalid chatId');

    const { password } = req.body || {};
    if (typeof password !== 'string' || password.length === 0) {
      return response_with_code(res, 400, 'Password required');
    }

    const member = await _assertMember(userId, chatId);
    if (!member) return response_with_code(res, 403, 'Not a participant of this chat');

    const lock = await prisma.chatLock.findUnique({
      where: { userId_chatId: { userId, chatId } },
      select: { passwordHash: true },
    });
    if (!lock) {
      // No lock exists — nothing to verify against; treat as ok=false so the
      // client's inline-error UX is consistent with a wrong password.
      return true_status(res, { ok: false }, 'No lock set');
    }

    // Compare FIRST so a correct guess always succeeds and resets the counter
    // even at the cap boundary; a wrong guess bumps the counter and, if that
    // bump crosses the cap, converts the response to 429.
    const ok = await bcrypt.compare(password, lock.passwordHash);
    const gate = markVerifyResult(userId, chatId, !ok);
    if (!ok && gate.blocked) {
      res.set('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)));
      return response_with_code(res, 429, 'Too many attempts. Try again later.');
    }
    return true_status(res, { ok }, ok ? 'Unlocked' : 'Incorrect password');
  } catch (err) {
    console.error('verifyLock error:', err);
    return response_with_code(res, 500, 'Failed to verify chat lock');
  }
};

// ---------- DELETE /chats/:chatId/lock ----------
// Verify the password first, then delete the row.
exports.removeLock = async (req, res) => {
  try {
    const userId = req.authData.id;
    const chatId = parseInt(req.params.chatId, 10);
    if (!Number.isFinite(chatId)) return response_with_code(res, 400, 'Invalid chatId');

    const { password } = req.body || {};
    if (typeof password !== 'string' || password.length === 0) {
      return response_with_code(res, 400, 'Password required');
    }

    const member = await _assertMember(userId, chatId);
    if (!member) return response_with_code(res, 403, 'Not a participant of this chat');

    const lock = await prisma.chatLock.findUnique({
      where: { userId_chatId: { userId, chatId } },
      select: { id: true, passwordHash: true },
    });
    if (!lock) return response_with_code(res, 404, 'No lock exists for this chat');

    // Same compare-then-mark pattern as verifyLock; shares the same budget so
    // brute force via DELETE is capped identically.
    const ok = await bcrypt.compare(password, lock.passwordHash);
    if (!ok) {
      const gate = markVerifyResult(userId, chatId, true);
      if (gate.blocked) {
        res.set('Retry-After', String(Math.ceil(gate.retryAfterMs / 1000)));
        return response_with_code(res, 429, 'Too many attempts. Try again later.');
      }
      return response_with_code(res, 403, 'Incorrect password');
    }

    await prisma.chatLock.delete({ where: { id: lock.id } });
    verifyLimitReset(userId, chatId);
    return true_status(res, undefined, 'Chat lock removed');
  } catch (err) {
    console.error('removeLock error:', err);
    return response_with_code(res, 500, 'Failed to remove chat lock');
  }
};

// ---------- GET /chats/:chatId/lock/status ----------
// Returns { isPasswordLocked } for the caller.
exports.lockStatus = async (req, res) => {
  try {
    const userId = req.authData.id;
    const chatId = parseInt(req.params.chatId, 10);
    if (!Number.isFinite(chatId)) return response_with_code(res, 400, 'Invalid chatId');

    const member = await _assertMember(userId, chatId);
    if (!member) return response_with_code(res, 403, 'Not a participant of this chat');

    const lock = await prisma.chatLock.findUnique({
      where: { userId_chatId: { userId, chatId } },
      select: { id: true },
    });
    return true_status(res, { isPasswordLocked: !!lock }, 'OK');
  } catch (err) {
    console.error('lockStatus error:', err);
    return response_with_code(res, 500, 'Failed to fetch lock status');
  }
};

// Exported so chatController list/detail responses can bulk-annotate chats
// with the caller's isPasswordLocked flag without an N+1 query.
exports.getLockedChatIdSet = async function (userId, chatIds) {
  if (!Array.isArray(chatIds) || chatIds.length === 0) return new Set();
  const rows = await prisma.chatLock.findMany({
    where: { userId, chatId: { in: chatIds } },
    select: { chatId: true },
  });
  return new Set(rows.map((r) => r.chatId));
};

// Test-only reset — clears the in-memory rate-limit map. Not wired to a route.
exports.__resetVerifyLimits = function () { verifyBuckets.clear(); };
