/**
 * Unit tests for utils/visitedSpots.js `dedupeVisitedSpots`.
 *
 * Pure function, no stubs needed except the real (pure) haversineMeters from
 * utils/placeDistance — explicitly required to run for real per task spec.
 *
 * Covers: empty/degenerate input, placeId grouping, coord-bucket grouping,
 * GPS-drift bucketing (toFixed(4)), cross-key (coord -> place) haversine
 * merge and its order-dependence, mediaUrl/placeId/placeName/coord
 * backfill promotion rules, placeType inference, totalPoints null-safety,
 * and final sort order.
 */

let PASS = 0, FAIL = 0;
function ok(name, cond, detail) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${detail?`\n      ${detail}`:''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }

const { dedupeVisitedSpots, inferPlaceType, COORD_PRECISION, COORD_MERGE_METERS } = require('../utils/visitedSpots');
const { haversineMeters } = require('../utils/placeDistance');

// Small fixed "now" so createdAt math is deterministic.
const T0 = new Date('2026-07-01T12:00:00Z'); // newest
const T1 = new Date('2026-06-28T12:00:00Z'); // older
const T2 = new Date('2026-06-20T12:00:00Z'); // oldest

function row(overrides) {
  return {
    id: overrides.id ?? 1,
    placeId: overrides.placeId ?? null,
    placeName: overrides.placeName ?? null,
    placeType: overrides.placeType ?? null,
    latitude: overrides.latitude ?? null,
    longitude: overrides.longitude ?? null,
    mediaUrl: overrides.mediaUrl ?? null,
    points: overrides.points ?? 0,
    createdAt: overrides.createdAt ?? T0,
    ...overrides,
  };
}

console.log('\n[1] Empty input');
eq('empty array -> []', dedupeVisitedSpots([]), []);
eq('null/undefined input -> []', dedupeVisitedSpots(undefined), []);

console.log('\n[2] Single row with placeId');
{
  const out = dedupeVisitedSpots([
    row({ placeId: 'p1', placeName: 'Star Coffee', mediaUrl: 'https://s3/a.jpg', points: 5, createdAt: T0 }),
  ]);
  eq('1 spot', out.length, 1);
  eq('placeId passthrough', out[0].placeId, 'p1');
  eq('visitCount=1', out[0].visitCount, 1);
  eq('mediaUrl passthrough', out[0].mediaUrl, 'https://s3/a.jpg');
  eq('totalPoints=5', out[0].totalPoints, 5);
  eq('firstVisitedAt=lastVisitedAt', out[0].firstVisitedAt, out[0].lastVisitedAt);
}

console.log('\n[3] Single row without placeId, with coords -> keyed by coord bucket');
{
  const out = dedupeVisitedSpots([
    row({ placeId: null, latitude: 40.7128, longitude: -74.0060, createdAt: T0 }),
  ]);
  eq('1 spot', out.length, 1);
  eq('placeId null', out[0].placeId, null);
  eq('lat passthrough', out[0].latitude, 40.7128);
  eq('lng passthrough', out[0].longitude, -74.0060);
}

console.log('\n[4] Row with neither placeId nor coords -> dropped silently');
{
  const out = dedupeVisitedSpots([
    row({ placeId: null, latitude: null, longitude: null, createdAt: T0 }),
  ]);
  eq('0 spots (row dropped)', out.length, 0);
}

console.log('\n[5] Two visits to same placeId -> 1 spot, counts/points summed, first/last correct');
{
  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: 'p1', points: 10, mediaUrl: 'https://s3/new.jpg', createdAt: T0 }),
    row({ id: 2, placeId: 'p1', points: 7, mediaUrl: null, createdAt: T1 }),
  ]);
  eq('1 spot', out.length, 1);
  eq('visitCount=2', out[0].visitCount, 2);
  eq('totalPoints=17', out[0].totalPoints, 17);
  eq('lastVisitedAt = newer (T0)', out[0].lastVisitedAt, T0);
  eq('firstVisitedAt = older (T1)', out[0].firstVisitedAt, T1);
}

console.log('\n[6] Newest mediaUrl empty string, older has a real URL -> promote older');
{
  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: 'p1', mediaUrl: '', createdAt: T0 }),
    row({ id: 2, placeId: 'p1', mediaUrl: 'https://s3/foo.jpg', createdAt: T1 }),
  ]);
  eq('mediaUrl promoted from older visit', out[0].mediaUrl, 'https://s3/foo.jpg');
}

console.log('\n[7] Newest mediaUrl null, older has a real URL -> promote older');
{
  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: 'p1', mediaUrl: null, createdAt: T0 }),
    row({ id: 2, placeId: 'p1', mediaUrl: 'https://s3/bar.jpg', createdAt: T1 }),
  ]);
  eq('mediaUrl promoted from older visit', out[0].mediaUrl, 'https://s3/bar.jpg');
}

console.log('\n[8] Both visits have empty mediaUrl -> representative mediaUrl is null (not "")');
{
  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: 'p1', mediaUrl: '', createdAt: T0 }),
    row({ id: 2, placeId: 'p1', mediaUrl: '', createdAt: T1 }),
  ]);
  eq('mediaUrl is null', out[0].mediaUrl, null);
  ok('mediaUrl is not empty string', out[0].mediaUrl !== '');
}

console.log('\n[9] GPS drift within the ~11m (toFixed(4)) bucket -> collapses to 1 spot');
{
  // NOTE: verified via node that (34.12341).toFixed(4) === (34.12344).toFixed(4)
  // === "34.1234", and likewise for the longitude — a genuine same-bucket pair.
  const out = dedupeVisitedSpots([
    row({ id: 1, latitude: 34.12341, longitude: -118.12341, createdAt: T0 }),
    row({ id: 2, latitude: 34.12344, longitude: -118.12344, createdAt: T1 }),
  ]);
  eq('COORD_PRECISION is 4', COORD_PRECISION, 4);
  eq('1 merged spot', out.length, 1);
  eq('visitCount=2', out[0].visitCount, 2);
}

console.log('\n[9b] DIAGNOSTIC: the task-spec example pair (34.12345/34.12349) does NOT actually');
console.log('     bucket together — floating point toFixed(4) rounds them to different strings.');
{
  // (34.12345).toFixed(4) -> "34.1234"   (34.12349).toFixed(4) -> "34.1235"
  const a = (34.12345).toFixed(4);
  const b = (34.12349).toFixed(4);
  ok('documented: spec example pair rounds to DIFFERENT lat buckets (' + a + ' vs ' + b + ')', a !== b);
  const out = dedupeVisitedSpots([
    row({ id: 1, latitude: 34.12345, longitude: -118.12345, createdAt: T0 }),
    row({ id: 2, latitude: 34.12349, longitude: -118.12349, createdAt: T1 }),
  ]);
  eq('documented: spec example pair produces 2 spots, NOT 1 (see diagnosis notes)', out.length, 2);
}

console.log('\n[10] GPS drift beyond the bucket -> 2 separate spots');
{
  const out = dedupeVisitedSpots([
    row({ id: 1, latitude: 34.1200, longitude: -118.1200, createdAt: T0 }),
    row({ id: 2, latitude: 34.1300, longitude: -118.1300, createdAt: T1 }),
  ]);
  eq('2 spots', out.length, 2);
}

console.log('\n[11] Cross-key merge: coord-only row ~4-5m from an existing place-key spot folds in');
{
  eq('COORD_MERGE_METERS is 50', COORD_MERGE_METERS, 50);
  const dist = haversineMeters({ lat: 40.7128, lng: -74.0060 }, { lat: 40.71283, lng: -74.00602 });
  ok('sanity: real haversine distance well under 50m (' + dist.toFixed(2) + 'm)', dist < 50);

  const out = dedupeVisitedSpots([
    // newer place-key row FIRST (desc order) so it's already in placeKeyList
    // by the time the coord-only row is processed.
    row({ id: 1, placeId: 'p_timessq', placeName: 'Times Square', latitude: 40.7128, longitude: -74.0060, points: 5, createdAt: T0 }),
    row({ id: 2, placeId: null, latitude: 40.71283, longitude: -74.00602, points: 3, createdAt: T1 }),
  ]);
  eq('1 merged spot', out.length, 1);
  eq('visitCount=2', out[0].visitCount, 2);
  eq('placeId preserved', out[0].placeId, 'p_timessq');
  eq('totalPoints summed', out[0].totalPoints, 8);
}

console.log('\n[12] Cross-key merge miss: coord-only row ~200m away stays separate');
{
  const dist = haversineMeters({ lat: 40.7128, lng: -74.0060 }, { lat: 40.7146, lng: -74.0060 });
  ok('sanity: real haversine distance is ~200m (' + dist.toFixed(2) + 'm), over the 50m threshold', dist > COORD_MERGE_METERS);

  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: 'p_timessq', latitude: 40.7128, longitude: -74.0060, createdAt: T0 }),
    row({ id: 2, placeId: null, latitude: 40.7146, longitude: -74.0060, createdAt: T1 }),
  ]);
  eq('2 separate spots', out.length, 2);
}

console.log('\n[13] Order-dependence — place-key BEFORE coord-only (desc) -> merges into 1 spot');
{
  // Same case as [11], re-asserted explicitly for the "order matters" spec item.
  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: 'p_a', latitude: 10.0000, longitude: 20.0000, createdAt: T0 }), // newest, place-key
    row({ id: 2, placeId: null, latitude: 10.00003, longitude: 20.00003, createdAt: T1 }), // older, coord-only, ~4m away
  ]);
  eq('merges: 1 spot', out.length, 1);
  eq('placeId preserved from the newer place-key row', out[0].placeId, 'p_a');
}

console.log('\n[14] Order-independence — coord-only BEFORE place-key (desc) -> still merges into 1 spot');
{
  // The pre-pass builds placeKeyList from ALL rows before the main loop, so
  // the coord-only newest row still folds into the place-key that appears
  // later in DESC order. Result: 1 spot with placeId backfilled from the
  // older row.
  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: null, latitude: 10.0000, longitude: 20.0000, createdAt: T0 }), // newest, coord-only
    row({ id: 2, placeId: 'p_a', latitude: 10.00003, longitude: 20.00003, createdAt: T1 }), // older, place-key, ~4m away
  ]);
  eq('merges: 1 spot', out.length, 1);
  ok('placeId backfilled onto representative', out[0].placeId === 'p_a');
  eq('visitCount = 2', out[0].visitCount, 2);
}

console.log('\n[15] placeName/coord backfill onto a representative missing them (same placeId group)');
{
  // Both rows share placeId, so both land in the SAME "place:p1" group —
  // here the backfill code IS reachable, unlike the coord/place cross-key case above.
  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: 'p1', placeName: null, latitude: null, longitude: null, createdAt: T0 }),
    row({ id: 2, placeId: 'p1', placeName: 'Riverside Rooftop', latitude: 12.34, longitude: 56.78, createdAt: T1 }),
  ]);
  eq('1 spot', out.length, 1);
  eq('placeName backfilled from older row', out[0].placeName, 'Riverside Rooftop');
  eq('latitude backfilled from older row', out[0].latitude, 12.34);
  eq('longitude backfilled from older row', out[0].longitude, 56.78);
}

console.log('\n[16] placeType inference');
eq('Star Coffee -> Cafes', inferPlaceType('Star Coffee'), 'Cafes');
eq('Riverside Rooftop -> Rooftop Bars', inferPlaceType('Riverside Rooftop'), 'Rooftop Bars');
eq('unmatched name -> null', inferPlaceType('Zzyx Unmatched Name 123'), null);
eq('null name -> null', inferPlaceType(null), null);
{
  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: 'p1', placeName: 'Star Coffee', placeType: null, createdAt: T0 }),
  ]);
  eq('representative.placeType inferred = Cafes', out[0].placeType, 'Cafes');
}
{
  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: 'p2', placeName: 'Riverside Rooftop', placeType: null, createdAt: T0 }),
  ]);
  eq('representative.placeType inferred = Rooftop Bars', out[0].placeType, 'Rooftop Bars');
}
{
  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: 'p3', placeName: 'Zzyx Unmatched Name 123', placeType: null, createdAt: T0 }),
  ]);
  eq('representative.placeType stays null for unmatched name', out[0].placeType, null);
}

console.log('\n[17] Sort: final list ordered by lastVisitedAt desc');
{
  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: 'mid', createdAt: T1 }),
    row({ id: 2, placeId: 'newest', createdAt: T0 }),
    row({ id: 3, placeId: 'oldest', createdAt: T2 }),
  ]);
  eq('3 spots', out.length, 3);
  eq('order = newest, mid, oldest', out.map(s => s.placeId), ['newest', 'mid', 'oldest']);
}

console.log('\n[18] totalPoints sums null-safe: undefined points treated as 0');
{
  const out = dedupeVisitedSpots([
    row({ id: 1, placeId: 'p1', points: undefined, createdAt: T0 }),
    row({ id: 2, placeId: 'p1', points: undefined, createdAt: T1 }),
  ]);
  eq('totalPoints=0', out[0].totalPoints, 0);
}

console.log(`\n========================================\nResult: ${PASS} passed, ${FAIL} failed\n========================================`);
process.exit(FAIL > 0 ? 1 : 0);
