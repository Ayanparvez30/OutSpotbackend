/**
 * closed-place-checkin.test.js
 *
 * Tests the "closed-place reject" logic in recordVisit (controllers/exploreController.js).
 * Uses a LIVE Prisma DB (seed + cleanup). Stubs ONLY googlePlaces.details so no real
 * Google API calls are made. The real addPointsWithMultiplier / locationPoint.create run
 * against the actual DB so we can assert on real DB state.
 *
 * Assertions:
 *   1. open_now=false            → 409 place-closed, zero LocationPoints created
 *   2. CLOSED_TEMPORARILY        → 409 place-closed, zero LocationPoints created
 *   3. CLOSED_PERMANENTLY        → 409 place-closed, zero LocationPoints created
 *   4. open_now=true, OPERATIONAL → success (awarded), one LocationPoint created
 *   5. open_now=undefined, biz=null → success (allowed, no hours guard), one LocationPoint created
 *   6. open_now=true but user ~100m away (viewport=null) → 403 too-far, zero LocationPoints
 *   7. DB integrity — success cases have exactly 1 LocationPoint each; reject cases 0
 */

'use strict';

process.chdir('/Users/jubair/Documents/outspot-backend');

// ─── require.cache injection MUST happen before the controller is loaded ────
// exploreController destructures `details` at require() time, so patching the
// module object after-the-fact would have no effect. We pre-seed cache with a
// stub object that delegates through a mutable `detailsImpl` so we can swap
// behaviour per test without re-requiring the controller.

const path    = require('path');
const gpPath  = require.resolve('../utils/googlePlaces');
const ctrlPath = require.resolve('../controllers/exploreController');

// Remove any cached copies (could be loaded from a previous test in the same
// process) so our stub gets injected cleanly.
delete require.cache[gpPath];
delete require.cache[ctrlPath];

// Mutable stub state — swap before each call.
let detailsImpl = async () => { throw new Error('detailsImpl not set'); };
let detailsCallCount = 0;

// Inject stub for googlePlaces BEFORE the controller loads.
require.cache[gpPath] = {
  id: gpPath,
  filename: gpPath,
  loaded: true,
  exports: {
    details: async (...args) => {
      detailsCallCount++;
      return detailsImpl(...args);
    },
    nearbyPage:           async () => ({ results: [], next_page_token: null }),
    nearbyAll:            async () => [],
    nearbyByDistance:     async () => [],
    nearbyByDistanceAll:  async () => [],
    textSearch:           async () => [],
    photoUrlByRef:        (ref) => ref ? `photo://${ref}` : '',
  },
};

// Now load the controller — it will destructure `details` from our stub.
const explore = require('../controllers/exploreController');

// Real Prisma for baseline reads and cleanup.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Test place coordinates (Empire State Building area) ────────────────────
const PLAT = 40.748817;
const PLNG = -73.985428;

// User at the exact same point → dist ≈ 0m → always within MAX_PLACE_DISTANCE_METERS
const USER_AT    = { latitude: PLAT,          longitude: PLNG };
// User ~100m north → clearly outside the 20m gate
const USER_FAR   = { latitude: PLAT + 0.0009, longitude: PLNG }; // ~100m north

// Use distinct placeIds so the 12h dedup window never masks success results.
const PID = {
  closedOpenNow:   'ChIJtest_CLOSED_OPENNOW_001',
  closedTemp:      'ChIJtest_CLOSED_TEMP_002',
  closedPerm:      'ChIJtest_CLOSED_PERM_003',
  openOperational: 'ChIJtest_OPEN_OP_004',
  noHours:         'ChIJtest_NO_HOURS_005',
  tooFar:          'ChIJtest_TOO_FAR_006',
};

// Canonical "open and operational" stub geometry — place coords = user coords.
function makePlace(overrides = {}) {
  return {
    geometry: {
      location: { lat: PLAT, lng: PLNG },
      viewport: null,
    },
    name: 'Test Place',
    price_level: 2,
    user_ratings_total: 500,
    opening_hours:   { open_now: true },
    business_status: 'OPERATIONAL',
    ...overrides,
  };
}

// ─── Tiny res shim ───────────────────────────────────────────────────────────
function makeRes() {
  const r = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
  };
  return r;
}

// ─── Score tracking ──────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0;
const results = [];

function assert(id, name, cond, got, want) {
  const ok = !!cond;
  if (ok) PASS++; else FAIL++;
  const detail = ok ? '' : `  got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`;
  results.push({ id, name, ok, detail });
}
function eq(id, name, got, want) { assert(id, name, got === want, got, want); }

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  // ── Seed: create a real user for the test ───────────────────────────────
  let testUser;
  try {
    testUser = await prisma.user.create({
      data: {
        username:   `closed_place_test_${Date.now()}`,
        email:      `closed_place_test_${Date.now()}@test.invalid`,
        password:   'hashed_password_placeholder',
        isVerified: true,
        totalPoints: 0,
      },
    });
  } catch (seedErr) {
    console.error('SEED FAILED — cannot run tests:', seedErr.message);
    await prisma.$disconnect();
    process.exit(1);
  }

  const userId = testUser.id;
  console.log(`\nSeeded test user id=${userId} (will be deleted in finally)`);

  // Track LocationPoint ids created during success tests for cleanup + assertion.
  const createdLPIds = [];

  // Helper: count LocationPoints for our user with a given placeId created after
  // the test started (avoids interference from any pre-existing data).
  const testStart = new Date();
  async function lpCount(placeId) {
    return prisma.locationPoint.count({
      where: { userId, placeId, createdAt: { gte: testStart } },
    });
  }

  // Helper: call recordVisit with stub + req body.
  async function callRecordVisit({ placeId, userPos, stubPlace }) {
    detailsImpl = async () => stubPlace;
    const req = {
      authData: { id: userId },
      body: {
        placeId,
        name:        'Test Place',
        latitude:    userPos.latitude,
        longitude:   userPos.longitude,
        categoryKey: 'restaurants',
      },
    };
    const res = makeRes();
    await explore.recordVisit(req, res);
    return res;
  }

  try {
    // ════════════════════════════════════════════════════════════════════════
    // Test 1 — open_now=false → 409 place-closed
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[Test 1] open_now=false at location → 409 place-closed');
    const t1Before = await lpCount(PID.closedOpenNow);
    const r1 = await callRecordVisit({
      placeId:    PID.closedOpenNow,
      userPos:    USER_AT,
      stubPlace:  makePlace({ opening_hours: { open_now: false }, business_status: 'OPERATIONAL' }),
    });
    const t1After = await lpCount(PID.closedOpenNow);

    eq('1a', 'HTTP 409',            r1.statusCode,   409);
    eq('1b', 'awarded=false',       r1.body?.awarded, false);
    eq('1c', "reason='place-closed'", r1.body?.reason, 'place-closed');
    eq('1d', 'zero LocationPoints', t1After - t1Before, 0);

    // ════════════════════════════════════════════════════════════════════════
    // Test 2 — business_status=CLOSED_TEMPORARILY (open_now undefined) → 409
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[Test 2] business_status=CLOSED_TEMPORARILY (open_now undefined) → 409');
    const t2Before = await lpCount(PID.closedTemp);
    const r2 = await callRecordVisit({
      placeId:    PID.closedTemp,
      userPos:    USER_AT,
      stubPlace:  makePlace({ opening_hours: { open_now: undefined }, business_status: 'CLOSED_TEMPORARILY' }),
    });
    const t2After = await lpCount(PID.closedTemp);

    eq('2a', 'HTTP 409',            r2.statusCode,   409);
    eq('2b', 'awarded=false',       r2.body?.awarded, false);
    eq('2c', "reason='place-closed'", r2.body?.reason, 'place-closed');
    eq('2d', 'zero LocationPoints', t2After - t2Before, 0);

    // ════════════════════════════════════════════════════════════════════════
    // Test 3 — business_status=CLOSED_PERMANENTLY → 409
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[Test 3] business_status=CLOSED_PERMANENTLY → 409');
    const t3Before = await lpCount(PID.closedPerm);
    const r3 = await callRecordVisit({
      placeId:    PID.closedPerm,
      userPos:    USER_AT,
      stubPlace:  makePlace({ opening_hours: { open_now: false }, business_status: 'CLOSED_PERMANENTLY' }),
    });
    const t3After = await lpCount(PID.closedPerm);

    eq('3a', 'HTTP 409',            r3.statusCode,   409);
    eq('3b', 'awarded=false',       r3.body?.awarded, false);
    eq('3c', "reason='place-closed'", r3.body?.reason, 'place-closed');
    eq('3d', 'zero LocationPoints', t3After - t3Before, 0);

    // ════════════════════════════════════════════════════════════════════════
    // Test 4 — open_now=true, OPERATIONAL, at location → SUCCESS
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[Test 4] open_now=true, OPERATIONAL, at location → success');
    const t4Before = await lpCount(PID.openOperational);
    const r4 = await callRecordVisit({
      placeId:    PID.openOperational,
      userPos:    USER_AT,
      stubPlace:  makePlace({ opening_hours: { open_now: true }, business_status: 'OPERATIONAL' }),
    });
    const t4After = await lpCount(PID.openOperational);

    // Capture created LP id for cleanup
    if (r4.body?.id) createdLPIds.push(r4.body.id);

    eq('4a', 'awarded=true',                r4.body?.awarded, true);
    eq('4b', 'points > 0',                  (r4.body?.points > 0), true);
    eq('4c', 'one LocationPoint created',   t4After - t4Before, 1);
    assert('4d', 'placeId in response',     r4.body?.placeId === PID.openOperational, r4.body?.placeId, PID.openOperational);

    // ════════════════════════════════════════════════════════════════════════
    // Test 5 — open_now=undefined (no hours), biz=null → ALLOWED (not blocked)
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[Test 5] open_now=undefined (no hours), biz=null → allowed');
    const t5Before = await lpCount(PID.noHours);
    const r5 = await callRecordVisit({
      placeId:    PID.noHours,
      userPos:    USER_AT,
      stubPlace:  makePlace({ opening_hours: { open_now: undefined }, business_status: null }),
    });
    const t5After = await lpCount(PID.noHours);

    if (r5.body?.id) createdLPIds.push(r5.body.id);

    eq('5a', 'awarded=true (null-guard: undefined hours not blocked)', r5.body?.awarded, true);
    eq('5b', 'one LocationPoint created',   t5After - t5Before, 1);
    // Confirm it did NOT return place-closed
    assert('5c', "reason != 'place-closed'", r5.body?.reason !== 'place-closed', r5.body?.reason, '!= place-closed');

    // ════════════════════════════════════════════════════════════════════════
    // Test 6 — open_now=true but user ~100m away (viewport=null) → 403 too-far
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[Test 6] open_now=true but user ~100m away → 403 too-far');
    const t6Before = await lpCount(PID.tooFar);
    const r6 = await callRecordVisit({
      placeId:    PID.tooFar,
      userPos:    USER_FAR,
      stubPlace:  makePlace({ opening_hours: { open_now: true }, business_status: 'OPERATIONAL', geometry: { location: { lat: PLAT, lng: PLNG }, viewport: null } }),
    });
    const t6After = await lpCount(PID.tooFar);

    eq('6a', 'HTTP 403',                    r6.statusCode,   403);
    eq('6b', "reason='too-far-from-place'", r6.body?.reason, 'too-far-from-place');
    eq('6c', 'awarded=false',               r6.body?.awarded, false);
    eq('6d', 'zero LocationPoints',         t6After - t6Before, 0);
    // Confirm the too-far reject does NOT bleed into the closed logic
    assert('6e', "reason != 'place-closed'", r6.body?.reason !== 'place-closed', r6.body?.reason, '!= place-closed');

    // ════════════════════════════════════════════════════════════════════════
    // Test 7 — DB integrity summary
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[Test 7] DB integrity — reject cases have 0 LP, success cases have 1 each');
    const rejectCounts = await Promise.all([
      lpCount(PID.closedOpenNow),
      lpCount(PID.closedTemp),
      lpCount(PID.closedPerm),
      lpCount(PID.tooFar),
    ]);
    const successCounts = await Promise.all([
      lpCount(PID.openOperational),
      lpCount(PID.noHours),
    ]);

    eq('7a', 'reject placeIds: 0 LPs total', rejectCounts.reduce((a, b) => a + b, 0), 0);
    eq('7b', 'success openOperational: 1 LP', successCounts[0], 1);
    eq('7c', 'success noHours: 1 LP',         successCounts[1], 1);

    // Confirm stub was actually used (real Google never called = detailsCallCount > 0)
    assert('stub', `stub was used (details called ${detailsCallCount}x, real Google not hit)`,
      detailsCallCount >= 6, detailsCallCount, '>= 6');

  } finally {
    // ── Cleanup: restore DB baseline exactly ─────────────────────────────
    console.log('\n── Cleanup ──────────────────────────────────────────────');

    // Delete all LocationPoints created for our test user (cascade from user delete
    // handles this, but explicit for clarity and safety in case user delete fails).
    const lpDel = await prisma.locationPoint.deleteMany({ where: { userId } });
    console.log(`  Deleted ${lpDel.count} LocationPoint row(s) for userId=${userId}`);

    // Delete PointsLedger rows
    const plDel = await prisma.pointsLedger.deleteMany({ where: { userId } });
    console.log(`  Deleted ${plDel.count} PointsLedger row(s) for userId=${userId}`);

    // Delete the test user (cascade will mop up any stragglers).
    await prisma.user.delete({ where: { id: userId } });
    console.log(`  Deleted test user id=${userId}`);

    // Verify user is gone.
    const gone = await prisma.user.findUnique({ where: { id: userId } });
    assert('cleanup', 'DB baseline restored — test user deleted', gone === null, gone, null);

    await prisma.$disconnect();

    // ── Results table ─────────────────────────────────────────────────────
    console.log('\n╔══════════════════════════════════════════════════════════════════╗');
    console.log('║  closed-place-checkin test results                               ║');
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    for (const r of results) {
      const icon = r.ok ? '✓' : '✗';
      const line = `  ${icon} [${r.id}] ${r.name}`;
      console.log(`║ ${line.padEnd(66)} ║`);
      if (!r.ok && r.detail) {
        console.log(`║   ${r.detail.padEnd(65)} ║`);
      }
    }
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    console.log(`║  PASSED: ${String(PASS).padEnd(3)}  FAILED: ${String(FAIL).padEnd(3)}                                    ║`);
    console.log('╚══════════════════════════════════════════════════════════════════╝');

    process.exit(FAIL > 0 ? 1 : 0);
  }
})().catch(err => {
  console.error('\nTEST CRASH (unhandled):', err);
  prisma.$disconnect().finally(() => process.exit(1));
});
