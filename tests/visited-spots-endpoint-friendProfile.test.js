/**
 * GET /api/friends/:friendId/profile — controllers/friendController.js
 * `exports.getFriendProfile` (~line 1435).
 *
 * Verifies data.spotsVisited / data.recentVisitedSpots reflect the central
 * dedupeVisitedSpots util wiring:
 *   - 15 unique visits -> spotsVisited=15, recentVisitedSpots.length=10 (top-10 cap)
 *   - 20 raw rows that dedupe to 3 unique places -> spotsVisited=3, recentVisitedSpots.length=3
 *   - regression: mixed placeId + coord-only rows for the SAME physical place
 *     are not double-counted
 *   - recentVisitedSpots exactly matches dedupeVisitedSpots(rows).slice(0, 10)
 *
 * Pure stubs, no DB. Stubs @prisma/client, nodemailer, notificationService,
 * s3Cleanup, realtime. weeklyPoints.js and placeDistance's haversineMeters
 * are left real (weeklyPoints just reads the stubbed prisma.pointsLedger;
 * haversineMeters is pure).
 */

'use strict';

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

// ---------- generic Prisma-ish where-matcher ----------
function matchWhere(row, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return v.some((sub) => matchWhere(row, sub));
    if (k === 'AND') return v.every((sub) => matchWhere(row, sub));
    if (k === 'NOT') return !matchWhere(row, v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('gte' in v) return new Date(row[k]) >= new Date(v.gte);
      return true;
    }
    return row[k] === v;
  });
}

// ---------- fake DB state ----------
let DB;
function resetDB() {
  DB = {
    users: new Map(),        // id -> {id, username, firstName, lastName, bio, totalPoints, minime:[]}
    friendships: [],         // {id, requesterId, receiverId, status}
    locationPoints: [],      // LocationPoint rows
    stories: [],
    communityMembers: [],    // {userId, communityId, community, joinedAt}
    pointsLedger: [],
  };
}
resetDB();

const fakePrisma = {
  friendship: {
    findFirst: async ({ where }) => DB.friendships.find((f) => matchWhere(f, where)) || null,
    findMany: async ({ where }) => {
      let rows = DB.friendships.filter((f) => matchWhere(f, where));
      return rows.map((f) => ({
        ...f,
        requester: DB.users.get(f.requesterId) ? { ...DB.users.get(f.requesterId) } : null,
        receiver: DB.users.get(f.receiverId) ? { ...DB.users.get(f.receiverId) } : null,
      }));
    },
    count: async ({ where }) => DB.friendships.filter((f) => matchWhere(f, where)).length,
  },
  user: {
    findUnique: async ({ where }) => {
      const u = DB.users.get(where.id);
      return u ? { ...u } : null;
    },
  },
  story: {
    findMany: async ({ where }) => DB.stories.filter((s) => matchWhere(s, where)).map((s) => ({ ...s })),
  },
  communityMember: {
    findMany: async ({ where }) => {
      const rows = DB.communityMembers.filter((c) => matchWhere(c, where));
      return rows
        .slice()
        .sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt))
        .map((c) => ({ ...c }));
    },
  },
  locationPoint: {
    findMany: async ({ where }) => {
      const rows = DB.locationPoints.filter((p) => matchWhere(p, where));
      rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return rows.map((r) => ({ ...r }));
    },
  },
  pointsLedger: {
    groupBy: async ({ where }) => {
      const rows = DB.pointsLedger.filter((p) => matchWhere(p, where));
      const sums = new Map();
      for (const r of rows) sums.set(r.userId, (sums.get(r.userId) || 0) + (r.finalPoints || 0));
      return [...sums.entries()].map(([userId, sum]) => ({ userId, _sum: { finalPoints: sum } }));
    },
  },
};

// ---------- stub modules BEFORE requiring the controller ----------
const prismaClientPath = require.resolve('@prisma/client');
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

const nodemailerPath = require.resolve('nodemailer');
require.cache[nodemailerPath] = {
  id: nodemailerPath, filename: nodemailerPath, loaded: true,
  exports: { createTransport: () => ({ sendMail: async () => {} }) },
};

const notifPath = require.resolve('../utils/notificationService');
require.cache[notifPath] = {
  id: notifPath, filename: notifPath, loaded: true,
  exports: { notifyUser: async () => {} },
};

const s3CleanupPath = require.resolve('../utils/s3Cleanup');
require.cache[s3CleanupPath] = {
  id: s3CleanupPath, filename: s3CleanupPath, loaded: true,
  exports: { deleteS3IfOrphanBulk: async () => {} },
};

const realtimePath = require.resolve('../utils/realtime');
require.cache[realtimePath] = {
  id: realtimePath, filename: realtimePath, loaded: true,
  exports: { toUser: () => {}, toUsers: () => {}, toFriends: () => {}, toCommunity: () => {}, toGroup: () => {} },
};

const friendCtrl = require('../controllers/friendController');
const { dedupeVisitedSpots } = require('../utils/visitedSpots');

function req({ viewerId, friendId, query }) {
  return { authData: { id: viewerId }, params: { friendId: String(friendId) }, query: query || {} };
}
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function seedFriend(id) {
  DB.users.set(id, { id, username: `u${id}`, firstName: `F${id}`, lastName: 'L', bio: '', totalPoints: 0, minime: [] });
}

(async () => {
  // ---------- 1. 15 unique visits -> spotsVisited=15, recentVisitedSpots capped at 10 ----------
  console.log('\n[1] 15 unique visits -> spotsVisited=15, recentVisitedSpots.length=10');
  resetDB();
  DB.friendships = [{ id: 1, requesterId: 42, receiverId: 99, status: 'ACCEPTED' }];
  seedFriend(42);
  seedFriend(99);
  DB.locationPoints = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1, userId: 99, placeId: `place${i}`, placeName: `Place ${i}`, placeType: null,
    latitude: 10 + i, longitude: 20 + i, mediaUrl: null, points: 1,
    createdAt: new Date(2026, 5, 1 + i),
  }));
  const r1 = res();
  await friendCtrl.getFriendProfile(req({ viewerId: 42, friendId: 99 }), r1);
  eq('200', r1.statusCode, 200);
  eq('spotsVisited=15', r1.body?.data?.spotsVisited, 15);
  eq('recentVisitedSpots.length=10', r1.body?.data?.recentVisitedSpots?.length, 10);

  // Compare exactly against dedupeVisitedSpots(rows).slice(0, 10)
  const expected1 = dedupeVisitedSpots(DB.locationPoints.map(({ id, placeId, placeName, placeType, latitude, longitude, mediaUrl, points, createdAt }) =>
    ({ id, placeId, placeName, placeType, latitude, longitude, mediaUrl, points, createdAt }))).slice(0, 10);
  eq('recentVisitedSpots matches dedupeVisitedSpots(...).slice(0,10)', r1.body?.data?.recentVisitedSpots, expected1);

  // ---------- 2. Duplicate-heavy: 20 raw rows -> 3 unique places ----------
  console.log('\n[2] Duplicate-heavy: 20 raw rows dedupe to 3 unique -> spotsVisited=3, recentVisitedSpots.length=3');
  resetDB();
  DB.friendships = [{ id: 1, requesterId: 42, receiverId: 99, status: 'ACCEPTED' }];
  seedFriend(42);
  seedFriend(99);
  const places = ['pA', 'pB', 'pC'];
  DB.locationPoints = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1, userId: 99, placeId: places[i % 3], placeName: `Place ${places[i % 3]}`, placeType: null,
    latitude: null, longitude: null, mediaUrl: null, points: 2,
    createdAt: new Date(2026, 5, 1 + i),
  }));
  const r2 = res();
  await friendCtrl.getFriendProfile(req({ viewerId: 42, friendId: 99 }), r2);
  eq('200', r2.statusCode, 200);
  eq('spotsVisited=3', r2.body?.data?.spotsVisited, 3);
  eq('recentVisitedSpots.length=3', r2.body?.data?.recentVisitedSpots?.length, 3);

  // ---------- 3. Regression: mixed placeId + coord-only rows for the SAME place not double-counted ----------
  console.log('\n[3] Regression: mixed placeId + coord-only rows for same physical place -> not double-counted');
  resetDB();
  DB.friendships = [{ id: 1, requesterId: 42, receiverId: 99, status: 'ACCEPTED' }];
  seedFriend(42);
  seedFriend(99);
  DB.locationPoints = [
    { id: 1, userId: 99, placeId: 'plaza', placeName: 'Plaza', placeType: null, latitude: 40.7128, longitude: -74.0060, mediaUrl: null, points: 5, createdAt: new Date('2026-06-10') },
    { id: 2, userId: 99, placeId: null, placeName: null, placeType: null, latitude: 40.71282, longitude: -74.00601, mediaUrl: null, points: 3, createdAt: new Date('2026-06-05') },
    { id: 3, userId: 99, placeId: null, placeName: null, placeType: null, latitude: 40.71281, longitude: -74.00599, mediaUrl: null, points: 2, createdAt: new Date('2026-06-01') },
  ];
  const r3 = res();
  await friendCtrl.getFriendProfile(req({ viewerId: 42, friendId: 99 }), r3);
  eq('200', r3.statusCode, 200);
  eq('spotsVisited=1 (all 3 rows are the same place)', r3.body?.data?.spotsVisited, 1);
  eq('visitCount on the merged spot = 3', r3.body?.data?.recentVisitedSpots?.[0]?.visitCount, 3);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
