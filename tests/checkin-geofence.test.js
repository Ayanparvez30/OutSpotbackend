/**
 * The two location defences added after it turned out that /explore/visit
 * trusted whatever the caller said about where they were.
 *
 * Run: node tests/checkin-geofence.test.js
 */
const { allowedRadiusFor, viewportHalfDiagonal } = require('../utils/venueGeofence');
const { assessTravel } = require('../utils/travelPlausibility');

let PASS = 0;
let FAIL = 0;
function assert(cond, label) {
  if (cond) {
    PASS++;
    console.log(`  ✓ ${label}`);
  } else {
    FAIL++;
    console.log(`  ✗ ${label}`);
  }
}
const eq = (a, b, label) => assert(a === b, `${label} (got ${a}, want ${b})`);

// A real viewport, measured from Google Details for "Boston Sail Loft" — an
// ordinary seafood restaurant. 300m x 222m. This is the whole reason the
// viewport bypass mattered: it is not an edge case, it is the normal size.
const REAL_RESTAURANT_VIEWPORT = {
  northeast: { lat: 42.3625, lng: -71.0495 },
  southwest: { lat: 42.3598, lng: -71.0522 },
};

console.log('\n[1] Viewport no longer widens the radius for ordinary places');
{
  const { radius, reason } = allowedRadiusFor({
    baseRadius: 20,
    types: ['seafood_restaurant', 'bar_and_grill', 'cafe', 'restaurant'],
    viewport: REAL_RESTAURANT_VIEWPORT,
  });
  eq(radius, 20, 'a restaurant stays at the strict 20m');
  eq(reason, 'base', 'and reports that the base radius applied');

  // The bug, stated as a number: being inside that rectangle used to pass.
  const half = Math.round(viewportHalfDiagonal(REAL_RESTAURANT_VIEWPORT));
  assert(half > 100, `the old bypass was worth ~${half}m of slack`);
}

console.log('\n[2] Genuinely large venues still get the room they need');
{
  const mall = allowedRadiusFor({
    baseRadius: 20,
    types: ['shopping_mall', 'point_of_interest'],
    viewport: REAL_RESTAURANT_VIEWPORT,
  });
  assert(mall.radius > 20, `a shopping mall is widened (${mall.radius}m)`);
  eq(mall.reason, 'large-venue', 'and says why');

  // Never below the indoor floor: inside a big building Android reports the
  // building centroid, which can be tens of metres from a tenant's own pin.
  const tinyViewport = {
    northeast: { lat: 42.3601, lng: -71.0501 },
    southwest: { lat: 42.36, lng: -71.05 },
  };
  const smallMall = allowedRadiusFor({
    baseRadius: 20,
    types: ['shopping_mall'],
    viewport: tinyViewport,
  });
  assert(smallMall.radius >= 80, `a small mall still gets the indoor floor (${smallMall.radius}m)`);

  // And never unbounded, however large the viewport.
  const huge = allowedRadiusFor({
    baseRadius: 20,
    types: ['national_park'],
    viewport: {
      northeast: { lat: 43.0, lng: -70.0 },
      southwest: { lat: 42.0, lng: -71.0 },
    },
  });
  assert(huge.radius <= 250, `a park's radius is capped (${huge.radius}m)`);
}

console.log("\n[3] An admin's own radius is never narrowed");
{
  const spot = allowedRadiusFor({ baseRadius: 100, types: [], viewport: null });
  eq(spot.radius, 100, 'an OutSpot spot keeps the number the admin set');

  const wide = allowedRadiusFor({ baseRadius: 300, types: ['restaurant'], viewport: REAL_RESTAURANT_VIEWPORT });
  eq(wide.radius, 300, 'even when it is wider than the cap');
}

console.log('\n[4] Impossible travel — the check a spoofed request cannot pass');
{
  const ago = (seconds) => ({
    latitude: 23.8103,
    longitude: 90.4125, // Dhaka
    createdAt: new Date(Date.now() - seconds * 1000),
  });
  const LONDON = { lat: 51.5074, lng: -0.1278 };
  const CHITTAGONG = { lat: 22.3569, lng: 91.7832 };

  // The attack: a script checking in around the world. No amount of lying in
  // the request body helps, because this reads the server's own history.
  const scripted = assessTravel({ previous: ago(40 * 60), ...LONDON });
  assert(!scripted.plausible, `Dhaka → London in 40 min is refused (${scripted.speedKmh} km/h)`);

  const hopped = assessTravel({ previous: ago(5 * 60), ...CHITTAGONG });
  assert(!hopped.plausible, `Dhaka → Chittagong in 5 min is refused (${hopped.speedKmh} km/h)`);
}

console.log('\n[5] …and the honest journeys it must never refuse');
{
  const ago = (seconds) => ({
    latitude: 23.8103,
    longitude: 90.4125,
    createdAt: new Date(Date.now() - seconds * 1000),
  });

  assert(
    assessTravel({ previous: ago(10 * 3600), lat: 51.5074, lng: -0.1278 }).plausible,
    'a real flight to London over 10 hours is fine',
  );
  assert(
    assessTravel({ previous: ago(5 * 3600), lat: 22.3569, lng: 91.7832 }).plausible,
    'a five-hour bus to Chittagong is fine',
  );
  assert(
    assessTravel({ previous: ago(30 * 60), lat: 23.8103, lng: 90.4125 }).plausible,
    'two check-ins in the same building are not judged at all',
  );
  assert(
    assessTravel({ previous: null, lat: 23.8103, lng: 90.4125 }).plausible,
    'a first-ever check-in has nothing to compare against and passes',
  );
  assert(
    assessTravel({
      previous: { latitude: null, longitude: null, createdAt: new Date() },
      lat: 23.8103,
      lng: 90.4125,
    }).plausible,
    'a previous check-in with no coordinates passes',
  );

  // Clock skew must not manufacture a violation: two rows written in the same
  // second, far apart, would divide by ~0 without the minimum-elapsed floor.
  const skewed = assessTravel({
    previous: { latitude: 23.8103, longitude: 90.4125, createdAt: new Date() },
    lat: 23.82,
    lng: 90.42,
  });
  assert(skewed.plausible, 'a ~1km move recorded in the same second is not judged');
}

console.log(`\nResult: ${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL > 0 ? 1 : 0);
