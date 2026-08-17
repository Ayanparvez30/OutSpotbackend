/**
 * controllers/chatLockController.js — per-user chat lock (password-protected chats).
 *
 * Direct handler tests against a stubbed Prisma. bcrypt is NOT stubbed (real
 * hashing/compare — fast enough for tests). Covers setLock / verifyLock /
 * removeLock / lockStatus / getLockedChatIdSet, including the 15-min sliding
 * rate limiter on verify + remove.
 *
 * Zero HTTP, zero DB.
 */

'use strict';

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// ---------- in-memory fake DB ----------
let DB;
function resetDB() {
  DB = {
    userOnChat: [], // { userId, chatId }
    chatLock: [],   // { id, userId, chatId, passwordHash }
  };
}
resetDB();
let nextLockId = 1;

let THROW_ON = null;
function maybeThrow(name) {
  if (THROW_ON === name) throw new Error('Simulated DB failure: ' + name);
}

let chatLockFindManyCalls = 0;

const fakePrisma = {
  userOnChat: {
    findFirst: async ({ where }) => {
      maybeThrow('userOnChat.findFirst');
      return DB.userOnChat.find((r) => r.userId === where.userId && r.chatId === where.chatId) || null;
    },
  },
  chatLock: {
    findUnique: async ({ where }) => {
      maybeThrow('chatLock.findUnique');
      const { userId, chatId } = where.userId_chatId;
      return DB.chatLock.find((r) => r.userId === userId && r.chatId === chatId) || null;
    },
    create: async ({ data }) => {
      maybeThrow('chatLock.create');
      const row = { id: nextLockId++, ...data };
      DB.chatLock.push(row);
      return row;
    },
    update: async ({ where, data }) => {
      maybeThrow('chatLock.update');
      const row = DB.chatLock.find((r) => r.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    delete: async ({ where }) => {
      maybeThrow('chatLock.delete');
      const idx = DB.chatLock.findIndex((r) => r.id === where.id);
      if (idx === -1) throw new Error('not found');
      DB.chatLock.splice(idx, 1);
    },
    findMany: async ({ where }) => {
      maybeThrow('chatLock.findMany');
      chatLockFindManyCalls++;
      return DB.chatLock
        .filter((r) => r.userId === where.userId && where.chatId.in.includes(r.chatId))
        .map((r) => ({ chatId: r.chatId }));
    },
  },
};

// ---------- stub @prisma/client BEFORE requiring the controller ----------
const prismaClientPath = require.resolve('@prisma/client');
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

const chatLock = require('../controllers/chatLockController');
const bcrypt = require('bcrypt');

function req({ userId, chatId, body }) {
  return { authData: { id: userId }, params: { chatId: String(chatId) }, body: body || {} };
}
function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}

const U1 = 1, U2 = 2, CHAT = 100;

function addMember(userId, chatId) { DB.userOnChat.push({ userId, chatId }); }

(async () => {
  // ============================================================
  console.log('\n[setLock]');
  // ============================================================

  resetDB(); THROW_ON = null; chatLock.__resetVerifyLimits();
  addMember(U1, CHAT);

  // -- non-member (password valid — password check runs first in the code) --
  {
    const r = res();
    await chatLock.setLock(req({ userId: U2, chatId: CHAT, body: { password: 'goodpass' } }), r);
    eq('non-member -> 403', r.statusCode, 403);
  }

  // -- password < 4 chars --
  {
    const r = res();
    await chatLock.setLock(req({ userId: U1, chatId: CHAT, body: { password: 'abc' } }), r);
    eq('short password -> 400', r.statusCode, 400);
  }

  // -- password missing --
  {
    const r = res();
    await chatLock.setLock(req({ userId: U1, chatId: CHAT, body: {} }), r);
    eq('missing password -> 400', r.statusCode, 400);
  }

  // -- password not a string --
  {
    const r = res();
    await chatLock.setLock(req({ userId: U1, chatId: CHAT, body: { password: 1234 } }), r);
    eq('non-string password -> 400', r.statusCode, 400);
  }

  // -- no existing lock -> creates row, bcrypt-hashed, 200 --
  {
    const r = res();
    await chatLock.setLock(req({ userId: U1, chatId: CHAT, body: { password: 'firstpw' } }), r);
    eq('create -> 200', r.statusCode, 200);
    const row = DB.chatLock.find((x) => x.userId === U1 && x.chatId === CHAT);
    ok('row created', !!row);
    ok('passwordHash is bcrypt hash of "firstpw"', row && await bcrypt.compare('firstpw', row.passwordHash));
    ok('passwordHash NOT returned in response', !JSON.stringify(r.body).includes(row.passwordHash));
    eq('data is undefined (no leak)', r.body.data, undefined);
  }

  // -- existing lock, missing currentPassword -> 400 --
  {
    const r = res();
    await chatLock.setLock(req({ userId: U1, chatId: CHAT, body: { password: 'secondpw' } }), r);
    eq('existing lock, no currentPassword -> 400', r.statusCode, 400);
  }

  // -- existing lock, wrong currentPassword -> 403 --
  {
    const r = res();
    await chatLock.setLock(req({ userId: U1, chatId: CHAT, body: { password: 'secondpw', currentPassword: 'nope' } }), r);
    eq('existing lock, wrong currentPassword -> 403', r.statusCode, 403);
  }

  // -- existing lock, correct currentPassword -> updates with NEW hash, 200 --
  {
    const before = DB.chatLock.find((x) => x.userId === U1 && x.chatId === CHAT);
    const oldHash = before.passwordHash;
    const r = res();
    await chatLock.setLock(req({ userId: U1, chatId: CHAT, body: { password: 'secondpw', currentPassword: 'firstpw' } }), r);
    eq('update -> 200', r.statusCode, 200);
    const after = DB.chatLock.find((x) => x.userId === U1 && x.chatId === CHAT);
    ok('hash changed', after.passwordHash !== oldHash);
    ok('new hash matches new password', await bcrypt.compare('secondpw', after.passwordHash));
    ok('old password no longer matches', !(await bcrypt.compare('firstpw', after.passwordHash)));
    ok('passwordHash NOT returned in response', !JSON.stringify(r.body).includes(after.passwordHash));
  }

  // -- Prisma throws -> 500 --
  {
    THROW_ON = 'userOnChat.findFirst';
    const r = res();
    await chatLock.setLock(req({ userId: U1, chatId: CHAT, body: { password: 'whatever1' } }), r);
    eq('prisma throws -> 500', r.statusCode, 500);
    THROW_ON = null;
  }

  // ============================================================
  console.log('\n[verifyLock]');
  // ============================================================

  resetDB(); THROW_ON = null; chatLock.__resetVerifyLimits();
  addMember(U1, CHAT);
  addMember(U2, CHAT);

  // -- non-member (password present so we get past the 400 check) --
  {
    const r = res();
    await chatLock.verifyLock(req({ userId: 999, chatId: CHAT, body: { password: 'x' } }), r);
    eq('non-member -> 403', r.statusCode, 403);
  }

  // -- missing password -> 400 --
  {
    const r = res();
    await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: {} }), r);
    eq('missing password -> 400', r.statusCode, 400);
  }

  // -- lock does not exist -> {ok:false}, 200, envelope status:true --
  {
    const r = res();
    await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'anything' } }), r);
    eq('no lock -> 200', r.statusCode, 200);
    eq('no lock -> status:true', r.body.status, true);
    eq('no lock -> ok:false', r.body.data.ok, false);
    eq('no lock -> message', r.body.message, 'No lock set');
  }

  // create a real lock for U1 on CHAT
  await chatLock.setLock(req({ userId: U1, chatId: CHAT, body: { password: 'correcthorse' } }), res());
  chatLock.__resetVerifyLimits();

  // -- wrong password -> {ok:false}, 200, NOT 4xx --
  {
    const r = res();
    await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'wrongpw' } }), r);
    eq('wrong password -> 200', r.statusCode, 200);
    eq('wrong password -> status:true', r.body.status, true);
    eq('wrong password -> ok:false', r.body.data.ok, false);
  }

  // -- correct password -> {ok:true}, 200 --
  chatLock.__resetVerifyLimits();
  {
    const r = res();
    await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'correcthorse' } }), r);
    eq('correct password -> 200', r.statusCode, 200);
    eq('correct password -> ok:true', r.body.data.ok, true);
  }

  // -- rate limit: 5 wrong attempts in a row -> 6th returns 429 with Retry-After --
  chatLock.__resetVerifyLimits();
  {
    let last;
    for (let i = 0; i < 5; i++) {
      const r = res();
      await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'wrongwrong' } }), r);
      ok(`attempt ${i + 1}/5 wrong -> 200 ok:false (not yet blocked)`, r.statusCode === 200 && r.body.data.ok === false,
        `got status=${r.statusCode} body=${JSON.stringify(r.body)}`);
      last = r;
    }
    const r6 = res();
    await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'wrongwrong' } }), r6);
    eq('6th attempt -> 429', r6.statusCode, 429);
    const retryAfter = r6.headers['Retry-After'];
    ok('Retry-After is a positive integer string <= 900', /^\d+$/.test(retryAfter) && Number(retryAfter) > 0 && Number(retryAfter) <= 900,
      `Retry-After=${JSON.stringify(retryAfter)}`);
  }

  // -- correct password resets the counter --
  // Spec: 5 wrong then 1 right -> next 5 wrong should ALL fail with 200 (not 429).
  chatLock.__resetVerifyLimits();
  {
    for (let i = 0; i < 5; i++) {
      await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'wrongwrong' } }), res());
    }
    const rRight = res();
    await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'correcthorse' } }), rRight);
    ok('6th attempt (correct pw) succeeds instead of being rate-limited',
      rRight.statusCode === 200 && rRight.body?.data?.ok === true,
      `got status=${rRight.statusCode} body=${JSON.stringify(rRight.body)} — see BUG note below`);

    let allOkFalse200 = true;
    const details = [];
    for (let i = 0; i < 5; i++) {
      const r = res();
      await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'wrongwrong' } }), r);
      const good = r.statusCode === 200 && r.body?.data?.ok === false;
      if (!good) allOkFalse200 = false;
      details.push(`#${i + 1}:status=${r.statusCode}`);
    }
    ok('counter reset -> next 5 wrong all 200 {ok:false}, none 429', allOkFalse200, details.join(' '));
  }

  // -- isolation: user A's failures don't block user B on same chat --
  chatLock.__resetVerifyLimits();
  {
    for (let i = 0; i < 5; i++) {
      await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'wrongwrong' } }), res());
    }
    const rBlockedA = res();
    await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'wrongwrong' } }), rBlockedA);
    eq('A is now blocked', rBlockedA.statusCode, 429);

    // B has no lock set, but should NOT be rate-limited (member check passes, gate check passes -> 200 ok:false "No lock set")
    const rB = res();
    await chatLock.verifyLock(req({ userId: U2, chatId: CHAT, body: { password: 'irrelevant' } }), rB);
    eq('B is NOT blocked by A\'s failures on same chat', rB.statusCode, 200);
  }

  // -- isolation: user A's failures on chat X don't block A on chat Y --
  chatLock.__resetVerifyLimits();
  {
    const CHAT_Y = 200;
    addMember(U1, CHAT_Y);
    for (let i = 0; i < 5; i++) {
      await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'wrongwrong' } }), res());
    }
    const rBlockedX = res();
    await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'wrongwrong' } }), rBlockedX);
    eq('A is blocked on chat X', rBlockedX.statusCode, 429);

    const rY = res();
    await chatLock.verifyLock(req({ userId: U1, chatId: CHAT_Y, body: { password: 'irrelevant' } }), rY);
    eq('A is NOT blocked on chat Y', rY.statusCode, 200);
  }

  // -- Prisma throws -> 500 --
  chatLock.__resetVerifyLimits();
  {
    THROW_ON = 'chatLock.findUnique';
    const r = res();
    await chatLock.verifyLock(req({ userId: U1, chatId: CHAT, body: { password: 'x' } }), r);
    eq('prisma throws -> 500', r.statusCode, 500);
    THROW_ON = null;
  }

  // ============================================================
  console.log('\n[removeLock]');
  // ============================================================

  resetDB(); THROW_ON = null; chatLock.__resetVerifyLimits();
  addMember(U1, CHAT);

  // -- non-member --
  {
    const r = res();
    await chatLock.removeLock(req({ userId: 999, chatId: CHAT, body: { password: 'x' } }), r);
    eq('non-member -> 403', r.statusCode, 403);
  }

  // -- missing password --
  {
    const r = res();
    await chatLock.removeLock(req({ userId: U1, chatId: CHAT, body: {} }), r);
    eq('missing password -> 400', r.statusCode, 400);
  }

  // -- no lock exists -> 404 --
  {
    const r = res();
    await chatLock.removeLock(req({ userId: U1, chatId: CHAT, body: { password: 'x' } }), r);
    eq('no lock -> 404', r.statusCode, 404);
  }

  // create a lock
  await chatLock.setLock(req({ userId: U1, chatId: CHAT, body: { password: 'removeme1' } }), res());
  chatLock.__resetVerifyLimits();

  // -- wrong password -> 403, row still exists --
  {
    const r = res();
    await chatLock.removeLock(req({ userId: U1, chatId: CHAT, body: { password: 'wrongpw' } }), r);
    eq('wrong password -> 403', r.statusCode, 403);
    ok('row still exists after wrong password', !!DB.chatLock.find((x) => x.userId === U1 && x.chatId === CHAT));
  }

  // -- rate limit: 5 wrong deletes -> 6th returns 429 --
  chatLock.__resetVerifyLimits();
  {
    for (let i = 0; i < 5; i++) {
      const r = res();
      await chatLock.removeLock(req({ userId: U1, chatId: CHAT, body: { password: 'wrongpw' } }), r);
      ok(`delete attempt ${i + 1}/5 wrong -> 403 (not yet blocked)`, r.statusCode === 403);
    }
    const r6 = res();
    await chatLock.removeLock(req({ userId: U1, chatId: CHAT, body: { password: 'wrongpw' } }), r6);
    eq('6th delete attempt -> 429', r6.statusCode, 429);
    ok('Retry-After header present', /^\d+$/.test(r6.headers['Retry-After']));
  }

  // -- correct password -> row deleted, 200 --
  chatLock.__resetVerifyLimits();
  {
    ok('lock exists before delete', !!DB.chatLock.find((x) => x.userId === U1 && x.chatId === CHAT));
    const r = res();
    await chatLock.removeLock(req({ userId: U1, chatId: CHAT, body: { password: 'removeme1' } }), r);
    eq('correct password -> 200', r.statusCode, 200);
    ok('row deleted', !DB.chatLock.find((x) => x.userId === U1 && x.chatId === CHAT));
  }

  // -- Prisma throws -> 500 --
  {
    await chatLock.setLock(req({ userId: U1, chatId: CHAT, body: { password: 'throwtest1' } }), res());
    chatLock.__resetVerifyLimits();
    THROW_ON = 'chatLock.delete';
    const r = res();
    await chatLock.removeLock(req({ userId: U1, chatId: CHAT, body: { password: 'throwtest1' } }), r);
    eq('prisma throws -> 500', r.statusCode, 500);
    THROW_ON = null;
  }

  // ============================================================
  console.log('\n[lockStatus]');
  // ============================================================

  resetDB(); THROW_ON = null; chatLock.__resetVerifyLimits();
  addMember(U1, CHAT);

  // -- non-member --
  {
    const r = res();
    await chatLock.lockStatus(req({ userId: 999, chatId: CHAT }), r);
    eq('non-member -> 403', r.statusCode, 403);
  }

  // -- no lock -> isPasswordLocked:false --
  {
    const r = res();
    await chatLock.lockStatus(req({ userId: U1, chatId: CHAT }), r);
    eq('no lock -> 200', r.statusCode, 200);
    eq('no lock -> isPasswordLocked:false', r.body.data.isPasswordLocked, false);
  }

  // -- lock exists -> isPasswordLocked:true --
  {
    await chatLock.setLock(req({ userId: U1, chatId: CHAT, body: { password: 'statuscheck1' } }), res());
    const r = res();
    await chatLock.lockStatus(req({ userId: U1, chatId: CHAT }), r);
    eq('lock exists -> isPasswordLocked:true', r.body.data.isPasswordLocked, true);
  }

  // -- Prisma throws -> 500 --
  {
    THROW_ON = 'chatLock.findUnique';
    const r = res();
    await chatLock.lockStatus(req({ userId: U1, chatId: CHAT }), r);
    eq('prisma throws -> 500', r.statusCode, 500);
    THROW_ON = null;
  }

  // ============================================================
  console.log('\n[getLockedChatIdSet helper]');
  // ============================================================

  resetDB(); THROW_ON = null;

  // -- empty chatIds -> empty Set, no Prisma call --
  {
    chatLockFindManyCalls = 0;
    const set = await chatLock.getLockedChatIdSet(U1, []);
    eq('empty chatIds -> empty Set', [...set], []);
    eq('no chatLock.findMany call for empty chatIds', chatLockFindManyCalls, 0);
  }

  // -- non-empty -> only chatIds locked by that user --
  {
    // members needed for setLock to pass the membership check
    addMember(U1, 10); addMember(U1, 20); addMember(U2, 30);
    await chatLock.setLock(req({ userId: U1, chatId: 10, body: { password: 'lockuser1a' } }), res());
    await chatLock.setLock(req({ userId: U1, chatId: 20, body: { password: 'lockuser1b' } }), res());
    await chatLock.setLock(req({ userId: U2, chatId: 30, body: { password: 'lockuser2a' } }), res());

    const setForU1 = await chatLock.getLockedChatIdSet(U1, [10, 20, 30]);
    eq('U1 locked set = {10,20}', [...setForU1].sort(), [10, 20]);

    const setForU2 = await chatLock.getLockedChatIdSet(U2, [10, 20, 30]);
    eq('U2 locked set = {30} — never includes U1\'s chats', [...setForU2].sort(), [30]);
  }

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
