/**
 * GET /api/users/:userId/visited-spots — controllers/userController.js `getUserVisitedSpots`
 * (~line 1209).
 *
 * Verifies the wire-up of the new central `dedupeVisitedSpots` util:
 *   - self-view / friend-view -> 200 { success: true, data: [...], total: N }
 *   - non-friend, non-self    -> 403 { success: false }
 *   - invalid userId          -> 400
 *   - prisma throws           -> 500
 *   - data flow: 4 raw LocationPoint rows (2 same-place, 1 coord-only ~5m from
 *     that place, 1 far-away coord-only) dedupe down to 2 spots, and data[0]
 *     reflects the merged place spot.
 *
 * Pure stubs, no DB. Only `@prisma/client` and `../utils/googlePlaces` are
 * stubbed — everything else userController.js pulls in (openai, multer,
 * sharp, s3Upload, minimeGen, firebaseAdmin, dotenv) loads for real, same as
 * the existing precedent in tests/checkin-cooldown.test.js /
 * tests/profile-privacy.test.js, and has no side effects at require time.
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
    friendships: [],     // {id, requesterId, receiverId, status}
    locationPoints: [],  // {id, userId, placeId, placeName, placeType, latitude, longitude, mediaUrl, points, createdAt}
  };
}
resetDB();

let THROW_ON = null;
function maybeThrow(name) {
  if (THROW_ON === name) throw new Error('Simulated DB failure: ' + name);
}

const fakePrisma = {
  friendship: {
    findFirst: async ({ where }) => {
      maybeThrow('friendship.findFirst');
      return DB.friendships.find((f) => matchWhere(f, where)) || null;
    },
  },
  locationPoint: {
    findMany: async ({ where }) => {
      maybeThrow('locationPoint.findMany');
      const rows = DB.locationPoints.filter((p) => matchWhere(p, where));
      rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return rows.map((r) => ({ ...r }));
    },
  },
};

// ---------- stub modules BEFORE requiring the controller ----------
const prismaClientPath = require.resolve('@prisma/client');
require.cache[prismaClientPath] = {
  id: prismaClientPath, filename: prismaClientPath, loaded: true,
  exports: { PrismaClient: function () { return fakePrisma; } },
};

const gpPath = require.resolve('../utils/googlePlaces');
require.cache[gpPath] = {
  id: gpPath, filename: gpPath, loaded: true,
  exports: {
    details: async () => ({}),
    nearbyPage: async () => ({ results: [], next_page_token: null }),
    nearbyAll: async () => [],
    nearbyByDistance: async () => [],
    nearbyByDistanceAll: async () => [],
    textSearch: async () => [],
    photoUrlByRef: () => '',
  },
};

const userCtrl = require('../controllers/userController');

function req({ viewerId, userId }) {
  return { authData: { id: viewerId }, params: { userId: String(userId) }, query: {} };
}
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

(async () => {
  // ---------- 1. Self-view ----------
  console.log('\n[1] Self-view -> 200 { success: true, data: [...], total }');
  resetDB();
  DB.locationPoints = [
    { id: 1, userId: 42, placeId: 'p1', placeName: 'Cafe A', placeType: null, latitude: 1, longitude: 1, mediaUrl: 'x.jpg', points: 5, createdAt: new Date('2026-06-01') },
  ];
  const r1 = res();
  await userCtrl.getUserVisitedSpots(req({ viewerId: 42, userId: 42 }), r1);
  eq('200', r1.statusCode, 200);
  eq('success:true', r1.body?.success, true);
  eq('total=1', r1.body?.total, 1);
  eq('data.length=1', r1.body?.data?.length, 1);

  // ---------- 2. Friend-view ----------
  console.log('\n[2] Friend-view (friendship.findFirst returns a row) -> 200');
  resetDB();
  DB.friendships = [{ id: 1, requesterId: 42, receiverId: 99, status: 'ACCEPTED' }];
  DB.locationPoints = [
    { id: 1, userId: 99, placeId: 'p1', placeName: 'Cafe A', placeType: null, latitude: 1, longitude: 1, mediaUrl: null, points: 3, createdAt: new Date('2026-06-01') },
  ];
  const r2 = res();
  await userCtrl.getUserVisitedSpots(req({ viewerId: 42, userId: 99 }), r2);
  eq('200', r2.statusCode, 200);
  eq('success:true', r2.body?.success, true);
  eq('total=1', r2.body?.total, 1);

  // ---------- 3. Non-friend, non-self -> 403 ----------
  console.log('\n[3] Non-friend, non-self -> 403');
  resetDB();
  const r3 = res();
  await userCtrl.getUserVisitedSpots(req({ viewerId: 42, userId: 7 }), r3);
  eq('403', r3.statusCode, 403);
  eq('success:false', r3.body?.success, false);

  // ---------- 4. Invalid userId -> 400 ----------
  console.log('\n[4] Invalid userId -> 400');
  resetDB();
  const r4 = res();
  await userCtrl.getUserVisitedSpots(req({ viewerId: 42, userId: 'abc' }), r4);
  eq('400', r4.statusCode, 400);
  eq('success:false', r4.body?.success, false);

  // ---------- 5. Prisma throws -> 500 ----------
  console.log('\n[5] Prisma throws -> 500');
  resetDB();
  THROW_ON = 'locationPoint.findMany';
  const r5 = res();
  await userCtrl.getUserVisitedSpots(req({ viewerId: 42, userId: 42 }), r5);
  eq('500', r5.statusCode, 500);
  eq('success:false', r5.body?.success, false);
  THROW_ON = null;

  // ---------- 6. Data flow: dedupe merges correctly through the endpoint ----------
  console.log('\n[6] Data flow: 4 raw rows -> 2 deduped spots, data[0] is the merged place');
  resetDB();
  DB.locationPoints = [
    // Same place ("p1"), visited twice — newest has photo.
    { id: 1, userId: 42, placeId: 'p1', placeName: 'Times Square', placeType: null, latitude: 40.7128, longitude: -74.0060, mediaUrl: 'newest.jpg', points: 5, createdAt: new Date('2026-06-10') },
    { id: 2, userId: 42, placeId: 'p1', placeName: 'Times Square', placeType: null, latitude: 40.7128, longitude: -74.0060, mediaUrl: null, points: 5, createdAt: new Date('2026-06-05') },
    // Coord-only, ~5m from p1 -> merges into p1's spot.
    { id: 3, userId: 42, placeId: null, placeName: null, placeType: null, latitude: 40.71283, longitude: -74.00602, mediaUrl: null, points: 2, createdAt: new Date('2026-06-01') },
    // Coord-only, far away -> separate spot.
    { id: 4, userId: 42, placeId: null, placeName: null, placeType: null, latitude: 34.0000, longitude: -118.0000, mediaUrl: null, points: 1, createdAt: new Date('2026-05-01') },
  ];
  const r6 = res();
  await userCtrl.getUserVisitedSpots(req({ viewerId: 42, userId: 42 }), r6);
  eq('200', r6.statusCode, 200);
  eq('total=2 (merged place + far coord)', r6.body?.total, 2);
  const merged = r6.body?.data?.[0];
  eq('data[0] is the merged place (placeId=p1)', merged?.placeId, 'p1');
  eq('data[0].visitCount=3', merged?.visitCount, 3);
  eq('data[0].totalPoints=12 (5+5+2)', merged?.totalPoints, 12);
  eq('data[0].mediaUrl = newest.jpg', merged?.mediaUrl, 'newest.jpg');

  console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
  process.exit(FAIL > 0 ? 1 : 0);
})().catch((err) => { console.error('TEST CRASH', err); process.exit(1); });
