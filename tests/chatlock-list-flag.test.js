/**
 * controllers/chatController.js — isPasswordLocked wiring into chat list /
 * detail payloads (getMyChats, getUnreadChats, getMyGroupChats, getChatsByUsers).
 *
 * Verifies each endpoint bulk-annotates its results with the CALLER's own
 * ChatLock rows (never another user's), via chatLockController.getLockedChatIdSet.
 *
 * Only @prisma/client is stubbed. Everything else chatController.js pulls in
 * (aws-sdk, multer, notificationService, s3Upload, realtime, weeklyPoints,
 * chatHelpers) loads for real — same precedent as tests/chat-list-ordering.test.js
 * — and chatLockController.js (required lazily inside the handlers) also loads
 * for real, sharing the same stubbed Prisma instance.
 */

'use strict';

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const A = 42, B = 43; // two chat participants

function userStub(id) {
  return { id, username: `u${id}`, firstName: `User${id}`, lastName: '', totalPoints: 0, minime: [] };
}

// Chat row shaped for both getMyChats/getUnreadChats (per-user `users` include)
// and getMyGroupChats (same include, different top-level where).
function chatRow({ id, isGroup = false, hasMessage = true }) {
  const now = new Date('2026-07-01T00:00:00Z');
  return {
    id,
    name: isGroup ? `Group ${id}` : null,
    isGroup,
    isCommunity: false,
    isLocked: false,
    communityId: null,
    imageUrl: null,
    disappearingSeconds: null,
    updatedAt: now,
    createdAt: now,
    createdById: A,
    users: [
      { userId: A, role: 'MEMBER', joinedAt: now, isMuted: false,
        lastSeenMessageId: null, lastDeliveredMessageId: null, clearedUpToMessageId: 0, user: userStub(A) },
      { userId: B, role: 'MEMBER', joinedAt: now, isMuted: false,
        lastSeenMessageId: null, lastDeliveredMessageId: null, clearedUpToMessageId: 0, user: userStub(B) },
    ],
    messages: hasMessage
      ? [{ id: id * 10, content: 'hi', imageUrl: null, createdAt: now, senderId: B }]
      : [],
    _count: { messages: hasMessage ? 1 : 0 },
  };
}

// ---------- fake DB / prisma ----------
let CHATS = [];
let MESSAGE_COUNT_BY_CHAT = {}; // chatId -> unread message count (for getUnreadChats to have candidates)
let chatLockFindManyCalls = 0;
let DB_CHATLOCK = []; // { userId, chatId }

const fakePrisma = {
  chat: {
    findMany: async ({ where }) => {
      if (where && where.isGroup === true) return CHATS.filter((c) => c.isGroup);
      return CHATS.slice();
    },
  },
  pointsLedger: { groupBy: async () => [] },
  userOnChat: {
    findMany: async ({ where }) => {
      // Used by getBulkUnreadCounts — everyone's lastSeenMessageId = 0 (nothing seen).
      const chatIds = where.chatId.in;
      return chatIds.map((chatId) => ({ chatId, lastSeenMessageId: 0 }));
    },
  },
  message: {
    count: async ({ where }) => MESSAGE_COUNT_BY_CHAT[where.chatId] || 0,
  },
  block: { findMany: async () => [] },
  chatLock: {
    findMany: async ({ where }) => {
      chatLockFindManyCalls++;
      return DB_CHATLOCK
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

const chatController = require('../controllers/chatController');

function req(userId, params) { return { authData: { id: userId }, params: params || {} }; }
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function byId(list, id) { return list.find((c) => c.id === id); }

(async () => {
  // ============================================================
  console.log('\n[getMyChats / getUnreadChats — isPasswordLocked reflects the caller only]');
  // ============================================================

  CHATS = [
    chatRow({ id: 1 }), // locked by A
    chatRow({ id: 2 }), // locked by B (not A)
    chatRow({ id: 3 }), // unlocked
  ];
  MESSAGE_COUNT_BY_CHAT = { 1: 1, 2: 1, 3: 1 }; // all "unread" so getUnreadChats has candidates
  DB_CHATLOCK = [{ userId: A, chatId: 1 }, { userId: B, chatId: 2 }];

  // --- getMyChats as A ---
  {
    const r = res();
    await chatController.getMyChats(req(A), r);
    eq('getMyChats(A) returns 3 chats', (r.body || []).length, 3);
    eq('chat1 locked=true for A',  byId(r.body, 1)?.isPasswordLocked, true);
    eq('chat2 locked=false for A', byId(r.body, 2)?.isPasswordLocked, false);
    eq('chat3 locked=false for A', byId(r.body, 3)?.isPasswordLocked, false);
  }

  // --- getMyChats as B ---
  {
    const r = res();
    await chatController.getMyChats(req(B), r);
    eq('chat1 locked=false for B', byId(r.body, 1)?.isPasswordLocked, false);
    eq('chat2 locked=true for B',  byId(r.body, 2)?.isPasswordLocked, true);
    eq('chat3 locked=false for B', byId(r.body, 3)?.isPasswordLocked, false);
  }

  // --- getUnreadChats as A ---
  {
    const r = res();
    await chatController.getUnreadChats(req(A), r);
    eq('getUnreadChats(A) returns 3 chats (all have unread)', (r.body || []).length, 3);
    eq('chat1 locked=true for A',  byId(r.body, 1)?.isPasswordLocked, true);
    eq('chat2 locked=false for A', byId(r.body, 2)?.isPasswordLocked, false);
  }

  // --- getUnreadChats as B ---
  {
    const r = res();
    await chatController.getUnreadChats(req(B), r);
    eq('chat1 locked=false for B', byId(r.body, 1)?.isPasswordLocked, false);
    eq('chat2 locked=true for B',  byId(r.body, 2)?.isPasswordLocked, true);
  }

  // ============================================================
  console.log('\n[getMyGroupChats — same per-user isPasswordLocked]');
  // ============================================================

  CHATS = [
    chatRow({ id: 11, isGroup: true }), // locked by A
    chatRow({ id: 12, isGroup: true }), // locked by B
    chatRow({ id: 13, isGroup: true }), // unlocked
    chatRow({ id: 14, isGroup: false }), // not a group — must be excluded
  ];
  MESSAGE_COUNT_BY_CHAT = { 11: 1, 12: 1, 13: 1, 14: 1 };
  DB_CHATLOCK = [{ userId: A, chatId: 11 }, { userId: B, chatId: 12 }];

  {
    const r = res();
    await chatController.getMyGroupChats(req(A), r);
    eq('getMyGroupChats(A) returns only the 3 group chats', (r.body || []).length, 3);
    eq('group 11 locked=true for A',  byId(r.body, 11)?.isPasswordLocked, true);
    eq('group 12 locked=false for A', byId(r.body, 12)?.isPasswordLocked, false);
    eq('group 13 locked=false for A', byId(r.body, 13)?.isPasswordLocked, false);
  }

  {
    const r = res();
    await chatController.getMyGroupChats(req(B), r);
    eq('group 11 locked=false for B', byId(r.body, 11)?.isPasswordLocked, false);
    eq('group 12 locked=true for B',  byId(r.body, 12)?.isPasswordLocked, true);
  }

  // ============================================================
  console.log('\n[getChatsByUsers — 1:1 detail lookup returns chatId AND isPasswordLocked]');
  // ============================================================

  CHATS = [
    chatRow({ id: 21 }), // A+B, locked by A
    chatRow({ id: 22 }), // A+B, unlocked
  ];
  DB_CHATLOCK = [{ userId: A, chatId: 21 }];

  {
    const r = res();
    await chatController.getChatsByUsers(req(A, { user2Id: String(B) }), r);
    eq('returns 2 entries', (r.body || []).length, 2);
    const e21 = r.body.find((x) => x.chatId === 21);
    const e22 = r.body.find((x) => x.chatId === 22);
    ok('entry has chatId key', e21 && 'chatId' in e21);
    ok('entry has isPasswordLocked key', e21 && 'isPasswordLocked' in e21);
    eq('chat21 isPasswordLocked=true for A',  e21?.isPasswordLocked, true);
    eq('chat22 isPasswordLocked=false for A', e22?.isPasswordLocked, false);
    // Backward-compat: old clients that only read `chatId` still get it, unaffected
    // by the new field being present alongside it.
    ok('backward-compat: chatId still present regardless of new field', typeof e21.chatId === 'number');
  }

  // -- empty chat list -> no ChatLock query fired --
  {
    CHATS = [];
    chatLockFindManyCalls = 0;
    const r = res();
    await chatController.getChatsByUsers(req(A, { user2Id: String(B) }), r);
    eq('empty result', r.body, []);
    eq('no chatLock.findMany call when chat list is empty', chatLockFindManyCalls, 0);
  }

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
