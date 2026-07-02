/**
 * gps-integrity-checkin.test.js
 *
 * Tests GPS-integrity validation in recordVisit (controllers/exploreController.js).
 * Validates that isMocked and accuracy checks short-circuit BEFORE the cooldown
 * check and BEFORE the googlePlaces.details() fetch.
 *
 * Uses live Prisma DB. Stubs ONLY googlePlaces.details.
 * Seeds a real user; restores DB baseline exactly in finally.
 *
 * Assertions 1–8:
 *   1. isMocked=true (boolean), accuracy=10, at-location → 409 mocked-location; 0 LPs; details NOT called
 *   2. isMocked='true' (string), accuracy=10 → 409 mocked-location
 *   3. accuracy=80 (>50), isMocked=false → 409 low-accuracy; response includes accuracy+maxAccuracy; 0 LPs; details NOT called
 *   4. accuracy=20 (<=50), isMocked=false, open, at-location, no recent LP → SUCCESS; 1 LP; details WAS called
 *   5. accuracy omitted (undefined), isMocked omitted, open, at-location, no recent LP → SUCCESS (older-client allowance)
 *   6. accuracy=50 exactly (boundary, not >50), no recent LP → SUCCESS
 *   7. ORDER: isMocked=true AND recent LP present → reason='mocked-location' (GPS check wins over cooldown)
 *   8. Integrity: reject cases 0 LPs; success cases 1 LP each
 */

'use strict';

process.chdir('/Users/jubair/Documents/outspot-backend');

// ─── Stub injection BEFORE controller loads ──────────────────────────────────
// exploreController destructures `details` at require() time. We pre-seed the
// require.cache with a stub that delegates through a mutable `detailsImpl` so
// behaviour can be swapped per test without reloading the module.

const gpPath   = require.resolve('../utils/googlePlaces');
const ctrlPath = require.resolve('../controllers/exploreController');

delete require.cache[gpPath];
delete require.cache[ctrlPath];

let detailsCallCount = 0;
let detailsImpl = async () => { throw new Error('detailsImpl not set'); };

require.cache[gpPath] = {
  id:       gpPath,
  filename: gpPath,
  loaded:   true,
  exports: {
    details: async (...args) => {
      detailsCallCount++;
      return detailsImpl(...args);
    },
    nearbyPage:          async () => ({ results: [], next_page_token: null }),
    nearbyAll:           async () => [],
    nearbyByDistance:    async () => [],
    nearbyByDistanceAll: async () => [],
    textSearch:          async () => [],
    photoUrlByRef:       (ref) => (ref ? `photo://${ref}` : ''),
  },
};

const explore = require('../controllers/exploreController');

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Test coordinates ────────────────────────────────────────────────────────
const PLAT = 40.748817;
const PLNG = -73.985428;

// Open, OPERATIONAL place at the user's exact coordinates (dist ≈ 0, no too-far reject).
function makeOpenPlace() {
  return {
    geometry: {
      location: { lat: PLAT, lng: PLNG },
      viewport: null,
    },
    name: 'T',
    price_level: 2,
    user_ratings_total: 500,
    opening_hours: { open_now: true },
    business_status: 'OPERATIONAL',
  };
}

function armStub() { detailsImpl = async () => makeOpenPlace(); }

// Distinct placeIds — 12h same-place dedupe must not mask results.
const PID = {
  mocked_bool:   'ChIJgps_MOCKED_BOOL_001',
  mocked_str:    'ChIJgps_MOCKED_STR_002',
  low_acc:       'ChIJgps_LOW_ACC_003',
  good_acc:      'ChIJgps_GOOD_ACC_004',
  omit_acc:      'ChIJgps_OMIT_ACC_005',
  boundary_acc:  'ChIJgps_BNDRY_ACC_006',
  order_check:   'ChIJgps_ORDER_007',
};

// ─── Shims ───────────────────────────────────────────────────────────────────
function makeRes() {
  const r = {
    statusCode: 200,
    body: null,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
  return r;
}

function makeReq(userId, placeId, extra = {}) {
  return {
    authData: { id: userId },
    body: {
      placeId,
      name:        'Test Place',
      latitude:    PLAT,
      longitude:   PLNG,
      categoryKey: 'restaurants',
      ...extra,
    },
  };
}

// ─── Score tracking ──────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0;
const results = [];

function assert(id, name, cond, got, want) {
  const ok = !!cond;
  if (ok) PASS++; else FAIL++;
  results.push({ id, name, ok, detail: ok ? '' : `got=${JSON.stringify(got)}  want=${JSON.stringify(want)}` });
}
function eq(id, name, got, want) { assert(id, name, got === want, got, want); }

// Count LPs for userId with a given placeId created at or after testStart.
let testStart;
async function lpCount(placeId) {
  return prisma.locationPoint.count({
    where: { userId: undefined, placeId, createdAt: { gte: testStart } },
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  // ── Seed ─────────────────────────────────────────────────────────────────
  let testUser;
  try {
    testUser = await prisma.user.create({
      data: {
        username:    `gps_integrity_${Date.now()}`,
        email:       `gps_integrity_${Date.now()}@test.invalid`,
        password:    'hashed_placeholder',
        isVerified:  true,
        totalPoints: 0,
      },
    });
  } catch (seedErr) {
    console.error('SEED FAILED:', seedErr.message);
    await prisma.$disconnect();
    process.exit(1);
  }

  const userId = testUser.id;
  console.log(`\nSeeded test user id=${userId}`);
  testStart = new Date();

  // Capture baseline counts to verify exact restoration.
  const baselineUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { totalPoints: true },
  });

  // Helper: count LPs for our user with given placeId (no date filter — clearCooldown
  // backdates rows, so a testStart filter would miss them; placeId is unique enough).
  async function countLP(placeId) {
    return prisma.locationPoint.count({
      where: { userId, placeId },
    });
  }

  // Helper: count ALL LPs for our user (used for integrity cross-check).
  async function countAllLP() {
    return prisma.locationPoint.count({
      where: { userId },
    });
  }

  // Helper: backdate all LPs for userId so 30-min cooldown does not fire.
  async function clearCooldown() {
    const thirtyOneMinsAgo = new Date(Date.now() - 31 * 60 * 1000);
    await prisma.locationPoint.updateMany({
      where: { userId },
      data:  { createdAt: thirtyOneMinsAgo },
    });
  }

  try {
    // ════════════════════════════════════════════════════════════════════════
    // Test 1 — isMocked=true (boolean), accuracy=10 → 409 mocked-location;
    //          0 LPs; details NOT called
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[1] isMocked=true (boolean), accuracy=10 → 409 mocked-location');

    armStub();
    const counterBefore1 = detailsCallCount;
    const r1 = makeRes();
    await explore.recordVisit(makeReq(userId, PID.mocked_bool, { isMocked: true, accuracy: 10 }), r1);
    const counterAfter1 = detailsCallCount;

    eq('1a', 'HTTP 409',                    r1.statusCode,        409);
    eq('1b', 'awarded=false',               r1.body?.awarded,     false);
    eq('1c', "reason='mocked-location'",    r1.body?.reason,      'mocked-location');
    assert('1d', 'message present',         typeof r1.body?.message === 'string' && r1.body.message.length > 0,
      r1.body?.message, 'non-empty string');
    eq('1e', 'details NOT called',          counterAfter1,        counterBefore1);
    eq('1f', '0 LPs created',              await countLP(PID.mocked_bool), 0);

    // ════════════════════════════════════════════════════════════════════════
    // Test 2 — isMocked='true' (string), accuracy=10 → 409 mocked-location
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[2] isMocked="true" (string), accuracy=10 → 409 mocked-location');

    armStub();
    const counterBefore2 = detailsCallCount;
    const r2 = makeRes();
    await explore.recordVisit(makeReq(userId, PID.mocked_str, { isMocked: 'true', accuracy: 10 }), r2);
    const counterAfter2 = detailsCallCount;

    eq('2a', 'HTTP 409',                    r2.statusCode,        409);
    eq('2b', 'awarded=false',               r2.body?.awarded,     false);
    eq('2c', "reason='mocked-location'",    r2.body?.reason,      'mocked-location');
    eq('2d', 'details NOT called',          counterAfter2,        counterBefore2);
    eq('2e', '0 LPs created',              await countLP(PID.mocked_str), 0);

    // ════════════════════════════════════════════════════════════════════════
    // Test 3 — accuracy=80 (>50), isMocked=false → 409 low-accuracy;
    //          response includes accuracy+maxAccuracy; 0 LPs; details NOT called
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[3] accuracy=80 (>50), isMocked=false → 409 low-accuracy');

    armStub();
    const counterBefore3 = detailsCallCount;
    const r3 = makeRes();
    await explore.recordVisit(makeReq(userId, PID.low_acc, { isMocked: false, accuracy: 80 }), r3);
    const counterAfter3 = detailsCallCount;

    eq('3a', 'HTTP 409',                    r3.statusCode,        409);
    eq('3b', 'awarded=false',               r3.body?.awarded,     false);
    eq('3c', "reason='low-accuracy'",       r3.body?.reason,      'low-accuracy');
    eq('3d', 'accuracy=80 in response',     r3.body?.accuracy,    80);
    eq('3e', 'maxAccuracy=50 in response',  r3.body?.maxAccuracy, 50);
    assert('3f', 'message present',         typeof r3.body?.message === 'string' && r3.body.message.length > 0,
      r3.body?.message, 'non-empty string');
    eq('3g', 'details NOT called',          counterAfter3,        counterBefore3);
    eq('3h', '0 LPs created',              await countLP(PID.low_acc), 0);

    // ════════════════════════════════════════════════════════════════════════
    // Test 4 — accuracy=20 (<=50), isMocked=false, open, at-location, no recent LP
    //          → SUCCESS; 1 LP; details WAS called
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[4] accuracy=20 (<=50), isMocked=false, open, at-location, no recent LP → SUCCESS');

    // Ensure no recent LP (in case prior tests leaked; they should not have but be safe).
    await clearCooldown();

    armStub();
    const counterBefore4 = detailsCallCount;
    const r4 = makeRes();
    await explore.recordVisit(makeReq(userId, PID.good_acc, { isMocked: false, accuracy: 20 }), r4);
    const counterAfter4 = detailsCallCount;

    eq('4a', 'HTTP 200',                    r4.statusCode,        200);
    eq('4b', 'awarded=true',                r4.body?.awarded,     true);
    assert('4c', 'points > 0',              (r4.body?.points || 0) > 0, r4.body?.points, '> 0');
    assert('4d', 'details WAS called',      counterAfter4 > counterBefore4, counterAfter4 - counterBefore4, '> 0');
    eq('4e', '1 LP created',               await countLP(PID.good_acc), 1);

    // ════════════════════════════════════════════════════════════════════════
    // Test 5 — accuracy omitted (undefined), isMocked omitted
    //          → SUCCESS (older-client allowance)
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[5] accuracy omitted, isMocked omitted → SUCCESS (older-client allowance)');

    // Backdate LP from test 4 to clear cooldown.
    await clearCooldown();

    armStub();
    const r5 = makeRes();
    // Do NOT include accuracy or isMocked in body at all.
    await explore.recordVisit(makeReq(userId, PID.omit_acc, {}), r5);

    eq('5a', 'HTTP 200',                    r5.statusCode,        200);
    eq('5b', 'awarded=true',                r5.body?.awarded,     true);
    assert('5c', 'points > 0',              (r5.body?.points || 0) > 0, r5.body?.points, '> 0');
    eq('5d', '1 LP created',               await countLP(PID.omit_acc), 1);

    // ════════════════════════════════════════════════════════════════════════
    // Test 6 — accuracy=50 exactly (boundary, not >50) → SUCCESS
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[6] accuracy=50 (boundary, not >50), isMocked=false → SUCCESS');

    // Backdate LP from test 5 to clear cooldown.
    await clearCooldown();

    armStub();
    const r6 = makeRes();
    await explore.recordVisit(makeReq(userId, PID.boundary_acc, { isMocked: false, accuracy: 50 }), r6);

    eq('6a', 'HTTP 200',                    r6.statusCode,        200);
    eq('6b', 'awarded=true',                r6.body?.awarded,     true);
    assert('6c', 'points > 0',              (r6.body?.points || 0) > 0, r6.body?.points, '> 0');
    eq('6d', '1 LP created',               await countLP(PID.boundary_acc), 1);

    // ════════════════════════════════════════════════════════════════════════
    // Test 7 — ORDER: isMocked=true AND recent LP within 30-min window
    //          → reason='mocked-location' (GPS check wins before cooldown)
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[7] ORDER: isMocked=true + recent LP (cooldown active) → reason=mocked-location (GPS wins)');

    // Do NOT clear cooldown — we want an active LP within the 30-min window.
    // The most recent LP from test 6 (createdAt = now) is within the window.
    // But test 6 backdated all existing LPs, so we need to ensure there's a
    // fresh one within the window. Create one directly.
    const freshLP = await prisma.locationPoint.create({
      data: {
        userId,
        placeId:   'ChIJgps_COOLDOWN_SEED',
        placeName: 'Cooldown Seed Place',
        latitude:  PLAT,
        longitude: PLNG,
        points:    10,
        mediaUrl:  '',
      },
    });
    // Verify the LP is within the cooldown window (created just now).
    const windowMs = 30 * 60 * 1000;
    const withinWindow = (Date.now() - freshLP.createdAt.getTime()) < windowMs;
    assert('7-pre', 'cooldown seed LP is within 30-min window', withinWindow,
      `age=${Date.now() - freshLP.createdAt.getTime()}ms`, `< ${windowMs}ms`);

    armStub();
    const counterBefore7 = detailsCallCount;
    const r7 = makeRes();
    await explore.recordVisit(makeReq(userId, PID.order_check, { isMocked: true, accuracy: 10 }), r7);
    const counterAfter7 = detailsCallCount;

    eq('7a', 'HTTP 409',                          r7.statusCode,        409);
    eq('7b', "reason='mocked-location' (not 'rate-limited')", r7.body?.reason, 'mocked-location');
    eq('7c', 'awarded=false',                     r7.body?.awarded,     false);
    eq('7d', 'details NOT called',                counterAfter7,        counterBefore7);
    eq('7e', '0 LPs for order-check placeId',    await countLP(PID.order_check), 0);

    // ════════════════════════════════════════════════════════════════════════
    // Test 8 — Integrity: reject cases 0 LPs; success cases 1 LP each
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[8] Integrity: reject placeIds=0 LPs; success placeIds=1 LP each');

    const rejectIds = [PID.mocked_bool, PID.mocked_str, PID.low_acc, PID.order_check];
    const successIds = [PID.good_acc, PID.omit_acc, PID.boundary_acc];

    const rejectCounts  = await Promise.all(rejectIds.map(pid => countLP(pid)));
    const successCounts = await Promise.all(successIds.map(pid => countLP(pid)));

    eq('8a', 'reject cases total 0 LPs',  rejectCounts.reduce((a, b) => a + b, 0), 0);
    eq('8b', 'good_acc: 1 LP',            successCounts[0], 1);
    eq('8c', 'omit_acc: 1 LP',            successCounts[1], 1);
    eq('8d', 'boundary_acc: 1 LP',        successCounts[2], 1);

    // Confirm all 3 success LPs exist = 3 total for those placeIds.
    eq('8e', 'total success LPs = 3',     successCounts.reduce((a, b) => a + b, 0), 3);

  } finally {
    // ── Cleanup: restore DB baseline exactly ─────────────────────────────
    console.log('\n── Cleanup ──────────────────────────────────────────────');

    const lpDel = await prisma.locationPoint.deleteMany({ where: { userId } });
    console.log(`  Deleted ${lpDel.count} LocationPoint row(s) for userId=${userId}`);

    const plDel = await prisma.pointsLedger.deleteMany({ where: { userId } });
    console.log(`  Deleted ${plDel.count} PointsLedger row(s) for userId=${userId}`);

    await prisma.user.delete({ where: { id: userId } });
    console.log(`  Deleted test user id=${userId}`);

    const gone = await prisma.user.findUnique({ where: { id: userId } });
    assert('cleanup', 'DB baseline restored — test user deleted', gone === null, gone, null);

    await prisma.$disconnect();

    // ── Results table ─────────────────────────────────────────────────────
    const W = 74;
    const bar = '═'.repeat(W);
    console.log(`\n╔${bar}╗`);
    console.log(`║  ${'gps-integrity-checkin test results'.padEnd(W - 2)}║`);
    console.log(`╠${bar}╣`);

    const groups = [
      { id: '1', label: 'isMocked=true (bool), acc=10 → 409 mocked-location; details skipped' },
      { id: '2', label: 'isMocked="true" (string) → 409 mocked-location' },
      { id: '3', label: 'accuracy=80 (>50) → 409 low-accuracy; details skipped; acc+max in response' },
      { id: '4', label: 'accuracy=20 (<=50) → SUCCESS; details called; 1 LP' },
      { id: '5', label: 'accuracy omitted → SUCCESS (older-client allowance)' },
      { id: '6', label: 'accuracy=50 (boundary) → SUCCESS' },
      { id: '7', label: 'ORDER: isMocked=true + cooldown LP → mocked-location wins (not rate-limited)' },
      { id: '8', label: 'Integrity: reject=0 LPs; success=1 LP each' },
    ];

    let allPassed = true;
    for (const g of groups) {
      const sub = results.filter(r => String(r.id).startsWith(g.id) && r.id !== 'cleanup');
      const ok  = sub.length > 0 && sub.every(r => r.ok);
      if (!ok) allPassed = false;
      const icon = sub.length === 0 ? '?' : (ok ? '✓' : '✗');
      const line = `  ${icon} [${g.id}] ${g.label}`;
      console.log(`║ ${line.padEnd(W)}║`);
      for (const r of sub) {
        if (!r.ok) {
          const fl = `      ✗ [${r.id}] ${r.name}: ${r.detail}`;
          for (let i = 0; i < fl.length; i += W - 2) {
            console.log(`║   ${fl.slice(i, i + W - 2).padEnd(W - 2)} ║`);
          }
        }
      }
    }

    // Short-circuit confirmation lines
    console.log(`╠${bar}╣`);
    const gpsBefore4 = results.find(r => r.id === '1e');
    const gpsLine = gpsBefore4
      ? (gpsBefore4.ok
          ? '  GPS checks short-circuit BEFORE details() fetch (1e, 2d, 3g confirmed)'
          : '  GPS short-circuit NOT confirmed for mocked-location (1e failed)')
      : '  1e not reached';
    console.log(`║ ${gpsLine.padEnd(W)}║`);

    const orderR = results.find(r => r.id === '7b');
    const orderLine = orderR
      ? (orderR.ok
          ? '  GPS check wins over cooldown (mocked-location before rate-limited) (7b passed)'
          : '  ORDER check FAILED — cooldown ran before GPS check (7b failed)')
      : '  7b not reached';
    console.log(`║ ${orderLine.padEnd(W)}║`);

    console.log(`╠${bar}╣`);
    console.log(`║  PASSED: ${String(PASS).padEnd(3)}  FAILED: ${String(FAIL).padEnd(3)}${''.padEnd(W - 20)}║`);
    console.log(`╚${bar}╝`);

    process.exit(FAIL > 0 ? 1 : 0);
  }
})().catch(err => {
  console.error('\nTEST CRASH (unhandled):', err);
  prisma.$disconnect().finally(() => process.exit(1));
});
