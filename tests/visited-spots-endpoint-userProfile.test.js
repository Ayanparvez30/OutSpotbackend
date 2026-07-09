/**
 * GET /api/users/:userId/profile — controllers/friendController.js
 * `exports.getUserProfile` (~line 1652).
 *
 * Same visited-spots matrix as tests/visited-spots-endpoint-friendProfile.test.js,
 * applied to getUserProfile (self and friend views, where the rich sections —
 * including spotsVisited / recentVisitedSpots — are populated). Also covers the
 * non-self/non-friend + private-account branch, only asserting the
 * visited-spots-relevant subset (isPrivate=true -> spotsVisited=0,
 * recentVisitedSpots=[]) without over-constraining the rest of that payload.
 *
 * Pure stubs, no DB. Same stub set as the friendProfile test file.
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
    users: new Map(),        // id -> {id, username, firstName, lastName, bio, totalPoints, isProfilePrivate, minime:[]}
    friendships: [],         // {id, requesterId, receiverId, status}
    locationPoints: [],
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
      const rows = DB.friendships.filter((f) => matchWhere(f, where));
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
      return rows.map((c) => ({ ...c }));
    },
    findFirst: async ({ where }) => {
      const rows = DB.communityMembers.filter((c) => matchWhere(c, where));
      rows.sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
      return rows[0] ? { ...rows[0] } : null;
    },
    count: async ({ where }) => DB.communityMembers.filter((c) => matchWhere(c, where)).length,
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

function req({ viewerId, userId, query }) {
  return { authData: { id: viewerId }, params: { userId: String(userId) }, query: query || {} };
}
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function seedUser(id, overrides = {}) {
  DB.users.set(id, {
    id, username: `u${id}`, firstName: `F${id}`, lastName: 'L', bio: '',
    totalPoints: 0, isProfilePrivate: false, minime: [],
    ...overrides,
  });
}

(async () => {
  // ---------- 1. Self-view: 15 unique visits -> spotsVisited=15, recentVisitedSpots capped at 10 ----------
  console.log('\n[1] Self-view — 15 unique visits -> spotsVisited=15, recentVisitedSpots.length=10');
  resetDB();
  seedUser(42);
  DB.locationPoints = Array.from({ length: 15 }, (_, i) => ({
    id: i + 1, userId: 42, placeId: `place${i}`, placeName: `Place ${i}`, placeType: null,
    latitude: 10 + i, longitude: 20 + i, mediaUrl: null, points: 1,
    createdAt: new Date(2026, 5, 1 + i),
  }));
  const r1 = res();
  await friendCtrl.getUserProfile(req({ viewerId: 42, userId: 42 }), r1);
  eq('200', r1.statusCode, 200);
  eq('isSelf=true', r1.body?.data?.isSelf, true);
  eq('isPrivate=false', r1.body?.data?.isPrivate, false);
  eq('spotsVisited=15', r1.body?.data?.spotsVisited, 15);
  eq('recentVisitedSpots.length=10', r1.body?.data?.recentVisitedSpots?.length, 10);

  // ---------- 2. Friend-view: duplicate-heavy 20 rows -> 3 unique ----------
  console.log('\n[2] Friend-view — 20 raw rows dedupe to 3 unique -> spotsVisited=3, recentVisitedSpots.length=3');
  resetDB();
  seedUser(42);
  seedUser(99);
  DB.friendships = [{ id: 1, requesterId: 42, receiverId: 99, status: 'ACCEPTED' }];
  const places = ['pA', 'pB', 'pC'];
  DB.locationPoints = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1, userId: 99, placeId: places[i % 3], placeName: `Place ${places[i % 3]}`, placeType: null,
    latitude: null, longitude: null, mediaUrl: null, points: 2,
    createdAt: new Date(2026, 5, 1 + i),
  }));
  const r2 = res();
  await friendCtrl.getUserProfile(req({ viewerId: 42, userId: 99 }), r2);
  eq('200', r2.statusCode, 200);
  eq('isFriend=true', r2.body?.data?.isFriend, true);
  eq('isPrivate=false', r2.body?.data?.isPrivate, false);
  eq('spotsVisited=3', r2.body?.data?.spotsVisited, 3);
  eq('recentVisitedSpots.length=3', r2.body?.data?.recentVisitedSpots?.length, 3);

  // ---------- 3. Regression: mixed placeId + coord-only rows for the same place not double-counted ----------
  console.log('\n[3] Regression: mixed placeId + coord-only rows for same physical place -> not double-counted');
  resetDB();
  seedUser(42);
  seedUser(99);
  DB.friendships = [{ id: 1, requesterId: 42, receiverId: 99, status: 'ACCEPTED' }];
  DB.locationPoints = [
    { id: 1, userId: 99, placeId: 'plaza', placeName: 'Plaza', placeType: null, latitude: 40.7128, longitude: -74.0060, mediaUrl: null, points: 5, createdAt: new Date('2026-06-10') },
    { id: 2, userId: 99, placeId: null, placeName: null, placeType: null, latitude: 40.71282, longitude: -74.00601, mediaUrl: null, points: 3, createdAt: new Date('2026-06-05') },
    { id: 3, userId: 99, placeId: null, placeName: null, placeType: null, latitude: 40.71281, longitude: -74.00599, mediaUrl: null, points: 2, createdAt: new Date('2026-06-01') },
  ];
  const r3 = res();
  await friendCtrl.getUserProfile(req({ viewerId: 42, userId: 99 }), r3);
  eq('200', r3.statusCode, 200);
  eq('spotsVisited=1 (all 3 rows are the same place)', r3.body?.data?.spotsVisited, 1);
  eq('visitCount on the merged spot = 3', r3.body?.data?.recentVisitedSpots?.[0]?.visitCount, 3);

  // ---------- 4. Non-self, non-friend, PRIVATE target -> isPrivate=true, visited-spots subset only ----------
  console.log('\n[4] Non-self, non-friend, private target -> isPrivate branch (visited-spots subset only)');
  resetDB();
  seedUser(42);
  seedUser(7, { isProfilePrivate: true });
  // No friendship row between 42 and 7 at all -> friendshipStatus="NONE", isFriend=false.
  DB.locationPoints = [
    { id: 1, userId: 7, placeId: 'secret', placeName: 'Secret Spot', placeType: null, latitude: 1, longitude: 1, mediaUrl: null, points: 5, createdAt: new Date('2026-06-01') },
  ];
  const r4 = res();
  await friendCtrl.getUserProfile(req({ viewerId: 42, userId: 7 }), r4);
  eq('200', r4.statusCode, 200);
  eq('isPrivate=true', r4.body?.data?.isPrivate, true);
  eq('spotsVisited=0 (rich section not fetched for private, non-friend viewer)', r4.body?.data?.spotsVisited, 0);
  eq('recentVisitedSpots=[] (rich section not fetched)', r4.body?.data?.recentVisitedSpots, []);

  // ---------- 5. Non-self, non-friend, NON-private target -> visited spots ARE populated ----------
  console.log('\n[5] Non-self, non-friend, PUBLIC target -> visited-spots subset still populated (not gated behind friendship)');
  resetDB();
  seedUser(42);
  seedUser(8, { isProfilePrivate: false });
  DB.locationPoints = [
    { id: 1, userId: 8, placeId: 'public-spot', placeName: 'Public Spot', placeType: null, latitude: 1, longitude: 1, mediaUrl: null, points: 5, createdAt: new Date('2026-06-01') },
  ];
  const r5 = res();
  await friendCtrl.getUserProfile(req({ viewerId: 42, userId: 8 }), r5);
  eq('200', r5.statusCode, 200);
  eq('isPrivate=false', r5.body?.data?.isPrivate, false);
  eq('spotsVisited=1', r5.body?.data?.spotsVisited, 1);
  eq('recentVisitedSpots.length=1', r5.body?.data?.recentVisitedSpots?.length, 1);

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
