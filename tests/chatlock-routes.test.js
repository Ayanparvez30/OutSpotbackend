/**
 * routes/chatRoutes.js — registration of the 4 per-user chat-lock routes.
 *
 * Loads the real express Router and inspects `router.stack` to verify verbs,
 * paths, handlers, and middleware, plus that the new routes don't hijack the
 * pre-existing catch-all `GET /chats/:user2Id`.
 *
 * Only @prisma/client is stubbed (chatController + chatLockController +
 * authMiddleware all instantiate PrismaClient at require time). No HTTP server
 * is started — router.stack is inspected directly.
 */

'use strict';

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const fakePrisma = {}; // no queries run at require time — empty stub is enough

const prismaClientPath = require.resolve('@prisma/client');
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

const router = require('../routes/chatRoutes');
const chatLockController = require('../controllers/chatLockController');
const chatController = require('../controllers/chatController');
const { checkAuth } = require('../middlewares/authMiddleware');

// route layers only (skip param/other middleware layers without `.route`)
const routeLayers = router.stack.filter((l) => l.route);

function findRoutes(path, method) {
  return routeLayers.filter((l) => l.route.path === path && l.route.methods[method]);
}
function handlersOf(layer) {
  return layer.route.stack.map((s) => s.handle);
}

(async () => {
  console.log('\n[route registration — per-user chat lock]');

  // ---- POST /chats/:chatId/lock -> setLock ----
  {
    const matches = findRoutes('/chats/:chatId/lock', 'post');
    eq('POST /chats/:chatId/lock registered exactly once', matches.length, 1);
    const handlers = matches[0] ? handlersOf(matches[0]) : [];
    ok('POST /chats/:chatId/lock uses checkAuth', handlers.includes(checkAuth));
    ok('POST /chats/:chatId/lock -> setLock', handlers.includes(chatLockController.setLock));
  }

  // ---- POST /chats/:chatId/lock/verify -> verifyLock ----
  {
    const matches = findRoutes('/chats/:chatId/lock/verify', 'post');
    eq('POST /chats/:chatId/lock/verify registered exactly once', matches.length, 1);
    const handlers = matches[0] ? handlersOf(matches[0]) : [];
    ok('POST /chats/:chatId/lock/verify uses checkAuth', handlers.includes(checkAuth));
    ok('POST /chats/:chatId/lock/verify -> verifyLock', handlers.includes(chatLockController.verifyLock));
  }

  // ---- DELETE /chats/:chatId/lock -> removeLock ----
  {
    const matches = findRoutes('/chats/:chatId/lock', 'delete');
    eq('DELETE /chats/:chatId/lock registered exactly once', matches.length, 1);
    const handlers = matches[0] ? handlersOf(matches[0]) : [];
    ok('DELETE /chats/:chatId/lock uses checkAuth', handlers.includes(checkAuth));
    ok('DELETE /chats/:chatId/lock -> removeLock', handlers.includes(chatLockController.removeLock));
  }

  // ---- GET /chats/:chatId/lock/status -> lockStatus ----
  {
    const matches = findRoutes('/chats/:chatId/lock/status', 'get');
    eq('GET /chats/:chatId/lock/status registered exactly once', matches.length, 1);
    const handlers = matches[0] ? handlersOf(matches[0]) : [];
    ok('GET /chats/:chatId/lock/status uses checkAuth', handlers.includes(checkAuth));
    ok('GET /chats/:chatId/lock/status -> lockStatus', handlers.includes(chatLockController.lockStatus));
  }

  // ---- registration order: verify path resolved before the generic /lock POST route ----
  {
    const verifyIdx = routeLayers.findIndex((l) => l.route.path === '/chats/:chatId/lock/verify' && l.route.methods.post);
    const genericIdx = routeLayers.findIndex((l) => l.route.path === '/chats/:chatId/lock' && l.route.methods.post);
    ok('router lists /chats/:chatId/lock/verify before /chats/:chatId/lock (POST)',
      verifyIdx !== -1 && genericIdx !== -1 && verifyIdx < genericIdx,
      `verifyIdx=${verifyIdx} genericIdx=${genericIdx}`);
  }

  // ---- regression: existing GET /chats/:user2Id route is still present ----
  {
    const matches = findRoutes('/chats/:user2Id', 'get');
    eq('GET /chats/:user2Id still registered', matches.length, 1);
    const handlers = matches[0] ? handlersOf(matches[0]) : [];
    ok('GET /chats/:user2Id -> getChatsByUsers (unchanged)', handlers.includes(chatController.getChatsByUsers));
  }

  // ---- both the generic-GET route and the new 3-segment GET route coexist ----
  {
    const genericGet = findRoutes('/chats/:user2Id', 'get');
    const statusGet = findRoutes('/chats/:chatId/lock/status', 'get');
    ok('both /chats/:user2Id and /chats/:chatId/lock/status are present on the stack',
      genericGet.length === 1 && statusGet.length === 1);
  }

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
