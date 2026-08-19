const { PrismaClient } = require('@prisma/client');
const uploadToS3 = require('../utils/s3Upload');
const { true_status, false_status } = require('../functions/response');

const prisma = new PrismaClient();

/// Spots OutSpot knows about that Google does not.
///
/// Two halves that meet in the middle:
///  - `SpotSuggestion` — a user standing at a small place submits it. One a day.
///  - `MapSpot` — what an admin publishes onto the live map, either by
///    approving a suggestion or by adding one directly.
///
/// The design rule everything else depends on: a published `MapSpot` is handed
/// to the app in exactly the shape a Google place arrives in (see `toPlaceCard`
/// below). The Flutter cards, the place-detail screen and the check-in flow
/// therefore need no idea that custom spots exist — they simply see one more
/// place in the list.

/// Category keys that a spot may belong to — the same list Explore uses, so a
/// custom spot can never land in a bucket the app has no tab for.
const VALID_CATEGORIES = new Set([
  'restaurants',
  'cafes',
  'bars',
  'dessert',
  'outdoors',
  'venue-events',
]);

/// A pending suggestion is deleted, photo and all, after this long. Keeps the
/// review queue honest and stops abandoned submissions accumulating in S3.
const SUGGESTION_TTL_DAYS = 21;

/// A rejected suggestion is kept only long enough for the reporter to read
/// why, then it and its photo go. Measured from when the admin acted, not from
/// when it was sent — see the cron in server.js.
const REJECTED_TTL_DAYS = 7;

/// What approving someone's suggestion is worth to them.
const APPROVAL_REWARD_POINTS = 50;

/// How far a suggestion may sit from where the user says they are. They are
/// meant to be standing at the place; this only catches nonsense.
const MAX_SUBMIT_DRIFT_METERS = 200;

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const metersToMiles = (m) => (m == null ? null : m / 1609.344);

/// The app-wide id for a custom spot.
///
/// The `outspot_` prefix is load-bearing: it can never collide with a Google
/// place id, and any code holding a place id can tell which kind it has with a
/// string check instead of a database lookup.
const placeIdFor = (id) => `outspot_${id}`;
const isCustomPlaceId = (placeId) =>
  typeof placeId === 'string' && placeId.startsWith('outspot_');

/// Shapes a MapSpot row exactly like `mapPlace()` in exploreController shapes a
/// Google result. Fields Google would supply and we don't are null/empty rather
/// than absent, so the Flutter parsers see the shape they already handle.
function toPlaceCard(spot, lat, lng) {
  const distance =
    lat != null && lng != null
      ? haversineMeters(
          { lat, lng },
          { lat: spot.latitude, lng: spot.longitude },
        )
      : null;

  return {
    placeId: spot.placeId,
    name: spot.name,
    address: spot.address || null,
    photoUrl: spot.imageUrl || null,
    // Admin-set, because there is no price level or review count to derive
    // points from the way Google spots do.
    points: spot.points,
    distanceMiles: distance == null ? null : metersToMiles(distance),
    lat: spot.latitude,
    lng: spot.longitude,
    rating: null,
    userRatingsTotal: null,
    openNow: null,
    status: '',
    openingHours: [],
    priceLevel: null,
    priceRange: '',
    businessStatus: null,
    types: [],
    accessible: false,
    // The one honest marker that this is ours, for anything that wants to badge
    // it. Everything else can ignore it.
    isCustomSpot: true,
  };
}

/// Live spots of one category within `radius` metres, nearest first.
///
/// Bounding-box first so the index does the work, then exact distance on what
/// survives — the row count here is small (admin-curated), so this stays cheap.
async function nearbyMapSpots({ categoryKey, lat, lng, radius = 16093, limit = 60 }) {
  if (lat == null || lng == null) return [];

  const latDelta = radius / 111320;
  const lngDelta = radius / (111320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));

  const rows = await prisma.mapSpot.findMany({
    where: {
      active: true,
      ...(categoryKey ? { categoryKey } : {}),
      latitude: { gte: lat - latDelta, lte: lat + latDelta },
      longitude: { gte: lng - lngDelta, lte: lng + lngDelta },
    },
    take: limit,
  });

  return rows
    .map((s) => ({
      spot: s,
      distance: haversineMeters({ lat, lng }, { lat: s.latitude, lng: s.longitude }),
    }))
    .filter((r) => r.distance <= radius)
    .sort((a, b) => a.distance - b.distance)
    .map((r) => r.spot);
}

/// Looks a custom spot up by its `outspot_...` id. Returns null for Google ids.
async function findByPlaceId(placeId) {
  if (!isCustomPlaceId(placeId)) return null;
  return prisma.mapSpot.findUnique({ where: { placeId } });
}

/// Start of today in the server's timezone (`America/New_York`, set in
/// server.js), which is what "one a day" is measured against.
function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// ---------------------------------------------------------------- user API

// POST /api/spots/suggest   (multipart: image + fields)
//
// The user is standing at the place, so latitude/longitude come from the device
// at submit time and are stored as given — an admin can change the name or the
// points later, but never where it is.
exports.submitSuggestion = async (req, res) => {
  try {
    const userId = req.authData.id;

    const name = String(req.body.name || '').trim();
    const categoryKey = String(req.body.categoryKey || '').trim();
    const lat = parseFloat(req.body.latitude);
    const lng = parseFloat(req.body.longitude);

    if (!name) return false_status(res, 'Please give the place a name');
    if (!VALID_CATEGORIES.has(categoryKey)) {
      return false_status(res, 'Please choose a category');
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      return false_status(
        res,
        'We could not read your location. Turn location on and try again.',
      );
    }

    // One a day. Checked against every submission, not just pending ones, so
    // getting rejected doesn't buy another go at it today.
    const todayCount = await prisma.spotSuggestion.count({
      where: { userId, createdAt: { gte: startOfToday() } },
    });
    if (todayCount > 0) {
      return false_status(
        res,
        'You can suggest one spot a day. Try again tomorrow.',
      );
    }

    // Optional sanity check when the client also sends where it thinks the user
    // is. Not security — just catches a spot pinned somewhere absurd.
    const userLat = parseFloat(req.body.userLatitude);
    const userLng = parseFloat(req.body.userLongitude);
    if (Number.isFinite(userLat) && Number.isFinite(userLng)) {
      const drift = haversineMeters({ lat, lng }, { lat: userLat, lng: userLng });
      if (drift > MAX_SUBMIT_DRIFT_METERS) {
        return false_status(
          res,
          'You need to be at the place to suggest it.',
        );
      }
    }

    // A failed upload must not lose the submission — the admin can still judge
    // it from the name, address and note.
    let imageUrl = null;
    if (req.file) {
      try {
        imageUrl = await uploadToS3(req.file, 'spot-suggestions');
      } catch (e) {
        console.error('submitSuggestion: image upload failed', e?.message);
      }
    }

    const created = await prisma.spotSuggestion.create({
      data: {
        userId,
        name: name.slice(0, 200),
        address: (req.body.address || '').trim().slice(0, 300) || null,
        categoryKey,
        note: (req.body.note || '').trim().slice(0, 1000) || null,
        imageUrl,
        latitude: lat,
        longitude: lng,
      },
    });

    return true_status(
      res,
      { id: created.id, status: created.status, createdAt: created.createdAt },
      'Thanks! We\'ll review your spot soon.',
    );
  } catch (e) {
    console.error('submitSuggestion error', e);
    return false_status(res, 'Could not submit your spot');
  }
};

// GET /api/spots/my-suggestions
//
// Feeds the "what have I sent" list on the submit screen, and tells the app
// whether today's one has been used up.
exports.getMySuggestions = async (req, res) => {
  try {
    const userId = req.authData.id;

    const [rows, todayCount] = await Promise.all([
      prisma.spotSuggestion.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          name: true,
          address: true,
          categoryKey: true,
          imageUrl: true,
          status: true,
          rejectReason: true,
          createdAt: true,
          reviewedAt: true,
        },
      }),
      prisma.spotSuggestion.count({
        where: { userId, createdAt: { gte: startOfToday() } },
      }),
    ]);

    return true_status(
      res,
      {
        canSubmitToday: todayCount === 0,
        pendingCount: rows.filter((r) => r.status === 'PENDING').length,
        rewardPoints: APPROVAL_REWARD_POINTS,
        expiryDays: SUGGESTION_TTL_DAYS,
        suggestions: rows,
      },
      'Suggestions fetched',
    );
  } catch (e) {
    console.error('getMySuggestions error', e);
    return false_status(res, 'Could not load your suggestions');
  }
};

/// The same spot in the shape the *map* category endpoint returns
/// (`getRestaurantsByCategory`), which differs from the Explore one: `id`
/// instead of `placeId`, `image`/`photos` instead of `photoUrl`, `totalReviews`
/// instead of `userRatingsTotal`.
function toMapCard(spot, categoryTitle) {
  return {
    id: spot.placeId,
    name: spot.name,
    address: spot.address || '',
    phone: '',
    website: '',
    googleMapsUrl: `https://www.google.com/maps?q=${spot.latitude},${spot.longitude}`,
    lat: spot.latitude,
    lng: spot.longitude,
    image: spot.imageUrl || '',
    photos: spot.imageUrl ? [spot.imageUrl] : [],
    category: categoryTitle,
    points: spot.points,
    priceLevel: null,
    priceRange: '',
    openNow: null,
    status: '',
    openingHours: [],
    rating: 0,
    totalReviews: 0,
    businessStatus: null,
    types: [],
    isCustomSpot: true,
  };
}

module.exports.VALID_CATEGORIES = VALID_CATEGORIES;
module.exports.SUGGESTION_TTL_DAYS = SUGGESTION_TTL_DAYS;
module.exports.APPROVAL_REWARD_POINTS = APPROVAL_REWARD_POINTS;
module.exports.placeIdFor = placeIdFor;
module.exports.isCustomPlaceId = isCustomPlaceId;
module.exports.toPlaceCard = toPlaceCard;
module.exports.nearbyMapSpots = nearbyMapSpots;
module.exports.findByPlaceId = findByPlaceId;
module.exports.haversineMeters = haversineMeters;
module.exports.toMapCard = toMapCard;
module.exports.REJECTED_TTL_DAYS = REJECTED_TTL_DAYS;
