/// How close a check-in has to be, given what kind of place it is.
///
/// Google returns a `viewport` rectangle with every place. The check-in code
/// used to accept a user anywhere inside it, on the reasoning that a stadium or
/// a park is too big to judge by distance-to-centre. The reasoning is right for
/// those; it is badly wrong for everything else, because Google's viewport for
/// an ordinary restaurant is routinely 200-300m across. Measured example:
/// "Boston Sail Loft", an ordinary seafood restaurant, has a 300m x 222m
/// viewport — so `insideViewport` alone let a check-in through from 150m away,
/// and the 20m rule that everyone believed was running mostly wasn't.
///
/// The fix is not to drop the viewport — large venues genuinely need it — but to
/// honour it only for the place types that are actually large, and to cap how
/// much slack it can ever buy.

/// Place types where the building or grounds really are bigger than a radius
/// around a point. Straight from Google's `types` array, which Details already
/// returns and which we are already paying for.
const LARGE_VENUE_TYPES = new Set([
  'airport',
  'amusement_park',
  'campground',
  'casino',
  'city_hall',
  'convention_center',
  'department_store',
  'golf_course',
  'hospital',
  'museum',
  'national_park',
  'park',
  'university',
  'school',
  'shopping_mall',
  'stadium',
  'subway_station',
  'tourist_attraction',
  'train_station',
  'transit_station',
  'zoo',
]);

/// Ceiling on the slack a viewport may buy, even for a large venue. A viewport
/// can be arbitrarily large (a national park's is kilometres); without this a
/// single mis-typed place would reopen the hole.
const MAX_VENUE_RADIUS_METERS = 250;

/// Indoors, Android's fused provider falls back to Wi-Fi trilateration and
/// tends to land near the *building* centroid with a plausible-looking accuracy.
/// In a large mall a tenant's own pin can sit well away from that centroid, so
/// anything inside a big building gets a floor under its radius — an honest
/// diner on the fourth floor must not be rejected because the phone reported
/// the atrium.
const LARGE_BUILDING_FLOOR_METERS = 80;

function metresBetween(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/// Half the diagonal of a viewport, in metres — i.e. the furthest a point
/// inside it can be from its centre.
function viewportHalfDiagonal(viewport) {
  if (!viewport?.northeast || !viewport?.southwest) return 0;
  const { northeast: ne, southwest: sw } = viewport;
  return (
    metresBetween(
      { lat: sw.lat, lng: sw.lng },
      { lat: ne.lat, lng: ne.lng },
    ) / 2
  );
}

function isLargeVenue(types) {
  return Array.isArray(types) && types.some((t) => LARGE_VENUE_TYPES.has(t));
}

/// The radius a check-in at this place must fall within.
///
/// `baseRadius` is the strict default (20m, or an admin's own number for an
/// OutSpot spot). It is only ever widened, never narrowed, so a custom spot's
/// configured radius is always honoured.
function allowedRadiusFor({ baseRadius, types, viewport }) {
  let radius = baseRadius;
  let reason = 'base';

  if (isLargeVenue(types)) {
    // Big venue: allow up to the viewport, capped.
    const fromViewport = Math.min(
      Math.round(viewportHalfDiagonal(viewport)),
      MAX_VENUE_RADIUS_METERS,
    );
    const widened = Math.max(radius, fromViewport, LARGE_BUILDING_FLOOR_METERS);
    if (widened > radius) {
      radius = widened;
      reason = 'large-venue';
    }
  }

  return { radius, reason };
}

module.exports = {
  allowedRadiusFor,
  isLargeVenue,
  viewportHalfDiagonal,
  metresBetween,
  LARGE_VENUE_TYPES,
  MAX_VENUE_RADIUS_METERS,
  LARGE_BUILDING_FLOOR_METERS,
};
