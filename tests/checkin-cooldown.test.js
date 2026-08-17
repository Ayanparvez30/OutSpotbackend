/**
 * checkin-cooldown.test.js
 *
 * Tests the global 30-minute check-in cooldown added to recordVisit
 * (controllers/exploreController.js) and verifies enforcement consistency
 * with getSubmitForPointsStatus (controllers/userController.js).
 *
 * Stubs: ONLY googlePlaces.details — all other paths use the real DB (live Prisma).
 *
 * Assertions:
 *   1. No prior LocationPoint → recordVisit → SUCCESS, 1 LP created
 *   2. Immediately after #1 → recordVisit (different placeId) → HTTP 429, rate-limited
 *      response shape correct, NO new LP created
 *   3. details() NOT called during rate-limited request (call counter unchanged)
 *   4. /submit-for-points/status after #1 → canSubmit=false, countdown consistent,
 *      rateLimitMinutes=30, nextAllowedAt present
 *   5. Simulate cooldown elapsed (set LP.createdAt 31min ago) → recordVisit → SUCCESS,
 *      new LP created; status → canSubmit=true, retryAfterSeconds=0
 *   6. Integrity: exactly 2 LPs created across test (assertions 1 and 5 = successes)
 */

'use strict';

process.chdir('/Users/jubair/Documents/outspot-backend');

// ─── Stub injection must happen BEFORE the controller loads ─────────────────
// Both exploreController and userController use a freshly-created PrismaClient
// instance at module load — they don't share a singleton unless we pre-seed the
// cache. We leave @prisma/client alone (real DB) and only stub googlePlaces.

const gpPath    = require.resolve('../utils/googlePlaces');
const ctrlPath  = require.resolve('../controllers/exploreController');
const uCtrlPath = require.resolve('../controllers/userController');

delete require.cache[gpPath];
delete require.cache[ctrlPath];
delete require.cache[uCtrlPath];

// Mutable call counter — lets assertion 3 verify short-circuit before Google fetch.
let detailsCallCount = 0;
let detailsImpl = async () => { throw new Error('detailsImpl not set'); };

require.cache[gpPath] = {
  id: gpPath,
  filename: gpPath,
  loaded: true,
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
    photoUrlByRef:       (ref) => ref ? `photo://${ref}` : '',
  },
};

// Load controllers after stub is in place.
const explore  = require('../controllers/exploreController');
const userCtrl = require('../controllers/userController');

// Real Prisma for seed/cleanup/assertions.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ─── Test coordinates — place and user at same point (dist ≈ 0m) ────────────
const PLAT = 40.748817;
const PLNG = -73.985428;

// Controlled "open and operational" place stub that always passes every
// recordVisit check after the cooldown gate (open, at-location, OPERATIONAL).
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

// Distinct placeIds — avoids the 12h same-place dedupe masking cooldown results.
const PID = {
  first:    'ChIJcooldown_FIRST_001',
  second:   'ChIJcooldown_SECOND_002',
  third:    'ChIJcooldown_THIRD_003',
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

function makeExploreReq(userId, placeId, lat = PLAT, lng = PLNG) {
  return {
    authData: { id: userId },
    body: {
      placeId,
      name:        'Test Place',
      latitude:    lat,
      longitude:   lng,
      categoryKey: 'restaurants',
    },
  };
}

function makeStatusReq(userId) {
  return { authData: { id: userId } };
}

// ─── Score tracking ──────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0;
const results = [];

function assert(id, name, cond, got, want) {
  const ok = !!cond;
  if (ok) PASS++; else FAIL++;
  const detail = ok ? '' : `got=${JSON.stringify(got)}  want=${JSON.stringify(want)}`;
  results.push({ id, name, ok, detail });
}
function eq(id, name, got, want) { assert(id, name, got === want, got, want); }

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  // ── Seed: create a real user ─────────────────────────────────────────────
  let testUser;
  try {
    testUser = await prisma.user.create({
      data: {
        username:    `cooldown_test_${Date.now()}`,
        email:       `cooldown_test_${Date.now()}@test.invalid`,
        password:    'hashed_placeholder',
        isVerified:  true,
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

  const testStart  = new Date();
  // Track LP ids that we expect to exist — used in assertion 6.
  const successLPIds = [];

  // Count LPs for this user created within the test window OR after
  // the simulated-elapsed timestamp (for assertion 5 where the first LP
  // is backdated to 31 min ago, which falls before testStart).
  async function lpCountForUser() {
    return prisma.locationPoint.count({
      where: { userId },
    });
  }

  // Set stub to the open place before each recordVisit call.
  function armStub() { detailsImpl = async () => makeOpenPlace(); }

  const detailsCountBefore = () => detailsCallCount;

  try {
    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 1 — No prior LP → recordVisit → SUCCESS, 1 LP created
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[1] No prior LocationPoint → recordVisit → SUCCESS');

    // Confirm clean baseline for this user.
    const baselineLPs = await lpCountForUser();
    eq('1-baseline', 'zero LocationPoints before test', baselineLPs, 0);

    armStub();
    const r1 = makeRes();
    await explore.recordVisit(makeExploreReq(userId, PID.first), r1);

    eq('1a', 'HTTP 200',       r1.statusCode,    200);
    eq('1b', 'awarded=true',   r1.body?.awarded, true);
    assert('1c', 'points > 0', (r1.body?.points || 0) > 0, r1.body?.points, '> 0');
    eq('1d', 'placeId in response', r1.body?.placeId, PID.first);

    const lp1Count = await lpCountForUser();
    eq('1e', '1 LocationPoint created after success (total for user)', lp1Count, 1);
    if (r1.body?.id) successLPIds.push(r1.body.id);

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 2 — Immediately after #1 → 429 rate-limited, response shape,
    //               NO new LP created
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[2] Immediately after #1 (LP within window) → 429 rate-limited');

    armStub();
    const counterBefore2 = detailsCountBefore();
    const r2 = makeRes();
    await explore.recordVisit(makeExploreReq(userId, PID.second), r2);

    eq('2a', 'HTTP 429',                   r2.statusCode,           429);
    eq('2b', 'awarded=false',              r2.body?.awarded,        false);
    eq('2c', "reason='rate-limited'",      r2.body?.reason,         'rate-limited');
    eq('2d', 'rateLimitMinutes=30',        r2.body?.rateLimitMinutes, 30);
    assert('2e', 'retryAfterSeconds is a number', typeof r2.body?.retryAfterSeconds === 'number',
      typeof r2.body?.retryAfterSeconds, 'number');
    assert('2f', 'retryAfterSeconds between 1 and 1800',
      r2.body?.retryAfterSeconds >= 1 && r2.body?.retryAfterSeconds <= 1800,
      r2.body?.retryAfterSeconds, '1..1800');
    assert('2g', 'nextAllowedAt is an ISO string',
      typeof r2.body?.nextAllowedAt === 'string' && !isNaN(Date.parse(r2.body.nextAllowedAt)),
      r2.body?.nextAllowedAt, 'ISO string');

    const lp2Count = await lpCountForUser();
    eq('2h', 'still only 1 LP (none added during rate-limit)', lp2Count, 1);

    // Store r2's retryAfterSeconds for comparison with assertion 4.
    const r2RetryAfterSeconds = r2.body?.retryAfterSeconds;

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 3 — details() NOT called during rate-limited request
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[3] details() short-circuit — NOT called during rate-limited request');

    const counterAfter2 = detailsCallCount;
    eq('3a', 'detailsCallCount unchanged across assertion 2 (cooldown short-circuits before Google fetch)',
      counterAfter2, counterBefore2);

    // Sanity: confirm details WAS called during assertion 1 (stub is working).
    assert('3b', 'details() WAS called during assertion 1 (stub confirmed working)',
      counterBefore2 >= 1, counterBefore2, '>= 1');

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 4 — /submit-for-points/status: canSubmit=false, countdown
    //               consistent with assertion 2, rateLimitMinutes=30
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[4] /submit-for-points/status → canSubmit=false, countdown consistent');

    const r4 = makeRes();
    await userCtrl.getSubmitForPointsStatus(makeStatusReq(userId), r4);

    eq('4a', 'HTTP 200',            r4.statusCode,                  200);
    eq('4b', 'canSubmit=false',     r4.body?.canSubmit,             false);
    eq('4c', 'rateLimitMinutes=30', r4.body?.rateLimitMinutes,      30);
    assert('4d', 'nextAllowedAt present',
      typeof r4.body?.nextAllowedAt === 'string' && r4.body?.nextAllowedAt.length > 0,
      r4.body?.nextAllowedAt, 'non-empty ISO string');
    assert('4e', 'retryAfterSeconds is a number', typeof r4.body?.retryAfterSeconds === 'number',
      typeof r4.body?.retryAfterSeconds, 'number');

    // Countdown consistency: status retryAfterSeconds must be within ±3 seconds
    // of enforcement retryAfterSeconds (both computed from same LP.createdAt, same
    // clock; small delta is tolerated for execution time between the two calls).
    const countdownDelta = Math.abs((r4.body?.retryAfterSeconds || 0) - (r2RetryAfterSeconds || 0));
    assert('4f',
      `status countdown within 3s of enforcement countdown (delta=${countdownDelta}s)`,
      countdownDelta <= 3,
      countdownDelta, '<= 3');

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 5 — Simulate cooldown elapsed: set LP.createdAt 31min ago →
    //               recordVisit → SUCCESS; status → canSubmit=true
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[5] Simulate cooldown elapsed (createdAt −31min) → recordVisit succeeds; status canSubmit=true');

    // Move the user's latest LP back 31 minutes to appear outside the window.
    const thirtyOneMinsAgo = new Date(Date.now() - 31 * 60 * 1000);
    await prisma.locationPoint.updateMany({
      where: { userId, createdAt: { gte: testStart } },
      data:  { createdAt: thirtyOneMinsAgo },
    });
    console.log(`  Set existing LP.createdAt = ${thirtyOneMinsAgo.toISOString()} (31 min ago)`);

    // Check status BEFORE the check-in — verifies the window appears clear
    // to both enforcement (recordVisit) and the countdown endpoint (status).
    // After the check-in the cooldown resets, so canSubmit would flip back to
    // false — the meaningful assertion is "can submit NOW (before check-in)".
    const r5s = makeRes();
    await userCtrl.getSubmitForPointsStatus(makeStatusReq(userId), r5s);

    eq('5e', 'canSubmit=true after cooldown elapsed',      r5s.body?.canSubmit,         true);
    eq('5f', 'retryAfterSeconds=0 after cooldown elapsed', r5s.body?.retryAfterSeconds, 0);

    // recordVisit should now succeed (no LP within the 30-min window).
    armStub();
    const r5 = makeRes();
    await explore.recordVisit(makeExploreReq(userId, PID.third), r5);

    eq('5a', 'HTTP 200 after cooldown elapsed',  r5.statusCode,    200);
    eq('5b', 'awarded=true',                     r5.body?.awarded, true);
    assert('5c', 'points > 0', (r5.body?.points || 0) > 0, r5.body?.points, '> 0');

    const lp5Count = await lpCountForUser();
    eq('5d', '2 LPs now exist (original + new)', lp5Count, 2);
    if (r5.body?.id) successLPIds.push(r5.body.id);

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 6 — Integrity: exactly 2 LPs created (assertions 1 + 5)
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n[6] Integrity: exactly 2 LPs created across test');

    const totalLPs = await lpCountForUser();
    eq('6a', 'exactly 2 LocationPoints total (1 from assertion 1, 1 from assertion 5)',
      totalLPs, 2);

    // PID.second (the rate-limited attempt) must have exactly 0 LPs.
    // PID.second was the rate-limited attempt — should have zero LPs ever.
    const rateLimitedLP = await prisma.locationPoint.count({
      where: { userId, placeId: PID.second },
    });
    eq('6b', '0 LPs for rate-limited placeId (PID.second)',
      rateLimitedLP, 0);

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
    console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  checkin-cooldown test results                                       ║');
    console.log('╠══════════════════════════════════════════════════════════════════════╣');

    const rows = [
      { group: '1', label: 'First check-in (no prior LP) → SUCCESS' },
      { group: '2', label: 'Immediate repeat → 429 rate-limited (shape + no new LP)' },
      { group: '3', label: 'details() short-circuit confirmed' },
      { group: '4', label: 'Status countdown consistent with enforcement' },
      { group: '5', label: 'Elapsed cooldown → SUCCESS + status canSubmit=true' },
      { group: '6', label: 'Integrity: exactly 2 LPs total' },
    ];

    for (const row of rows) {
      const sub = results.filter(r => String(r.id).startsWith(row.group) && r.id !== 'cleanup' && r.id !== '1-baseline');
      const allPassed = sub.every(r => r.ok);
      const icon = sub.length === 0 ? '?' : (allPassed ? '✓' : '✗');
      const groupLine = `  ${icon} [${row.group}] ${row.label}`;
      console.log(`║ ${groupLine.padEnd(70)} ║`);
      for (const r of sub) {
        if (!r.ok) {
          const failLine = `      ✗ [${r.id}] ${r.name}: ${r.detail}`;
          // Wrap long lines
          const chunks = [];
          for (let i = 0; i < failLine.length; i += 68) chunks.push(failLine.slice(i, i + 68));
          for (const c of chunks) console.log(`║   ${c.padEnd(68)} ║`);
        }
      }
    }

    // Enforcement vs countdown consistency summary
    console.log('╠══════════════════════════════════════════════════════════════════════╣');
    const c4f = results.find(r => r.id === '4f');
    const consistLine = c4f
      ? (c4f.ok ? '  Enforcement + countdown CONSISTENT (4f passed)' : '  Enforcement + countdown INCONSISTENT (4f failed)')
      : '  4f not reached';
    console.log(`║ ${consistLine.padEnd(70)} ║`);

    const c3a = results.find(r => r.id === '3a');
    const shortLine = c3a
      ? (c3a.ok ? '  details() short-circuit CONFIRMED (3a passed)' : '  details() short-circuit NOT confirmed (3a failed)')
      : '  3a not reached';
    console.log(`║ ${shortLine.padEnd(70)} ║`);

    console.log('╠══════════════════════════════════════════════════════════════════════╣');
    console.log(`║  PASSED: ${String(PASS).padEnd(3)}  FAILED: ${String(FAIL).padEnd(3)}                                              ║`);
    console.log('╚══════════════════════════════════════════════════════════════════════╝');

    process.exit(FAIL > 0 ? 1 : 0);
  }
})().catch(err => {
  console.error('\nTEST CRASH (unhandled):', err);
  prisma.$disconnect().finally(() => process.exit(1));
});
