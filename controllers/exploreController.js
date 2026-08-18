const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { nearbyPage, nearbyAll, nearbyByDistance, nearbyByDistanceAll, details, detailsCached, textSearch, textSearchAll, photoUrlByRef } = require('../utils/googlePlaces');
const { addPointsWithMultiplier } = require('../utils/points');
const { pointsForPlace } = require('../utils/pointsForPlace');
const uploadToS3 = require('../utils/s3Upload');

const toRad = d => (d * Math.PI) / 180;
const haversineMeters = (a, b) => {
  const R = 6371000, dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const A = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(A));
};
const metersToMiles = (m) => +(m / 1609.344).toFixed(2);
function buildPhotosArray(d, max = 8, width = 4800) {
  const refs = (d?.photos || []).slice(0, max).map(p => p.photo_reference).filter(Boolean);
  return refs.map(ref => photoUrlByRef(ref, width)).filter(Boolean);
}

// ---- de-dupe tuning (env overrideable) ----
const NEARBY_WITH_PLACEID   = Number(process.env.EXPLORE_DUP_RADIUS_WITH_PLACEID || 0);   // 0 = skip proximity when placeId present
const NEARBY_WITHOUT_PLACEID= Number(process.env.EXPLORE_DUP_RADIUS_METERS       || 15);  // fallback when no placeId
const DUP_WINDOW_HOURS      = Number(process.env.EXPLORE_DUP_WINDOW_HOURS        || 12);  // 12h window

// In-memory shared cache so /explore/category and /restaurants/category return
// the SAME candidate set for the same (location, category) within TTL. Without
// this, Google Places API jitter produces e.g. 60 vs 52 results on two
// back-to-back calls because next_page_token retries don't always saturate.
const CATEGORY_CACHE = new Map(); // key -> { ts, candidates }
// Every cold entry costs ~40-50 Google calls (core types + long-tail subtypes +
// text queries), so this TTL is the main lever on the Places bill. Place data is
// near-static — only open_now moves, and that is read live off the search result.
// Raise it (30-60 min) in production if the Places spend matters.
const CATEGORY_CACHE_TTL_MS = Number(process.env.EXPLORE_CATEGORY_CACHE_TTL_MS || 5 * 60 * 1000);
// Every distinct (category, 110m cell) pins a pool of place objects forever
// otherwise — one process serving a whole city grows without bound.
const CATEGORY_CACHE_MAX = Number(process.env.EXPLORE_CATEGORY_CACHE_MAX || 500);
function sweepCategoryCache() {
  const now = Date.now();
  for (const [k, v] of CATEGORY_CACHE) {
    if (now - v.ts >= CATEGORY_CACHE_TTL_MS) CATEGORY_CACHE.delete(k);
  }
  while (CATEGORY_CACHE.size >= CATEGORY_CACHE_MAX) {
    CATEGORY_CACHE.delete(CATEGORY_CACHE.keys().next().value); // oldest insert
  }
}
function categoryCacheKey(catKey, lat, lng) {
  // Round to 3 decimals (~110m) so close GPS reads hit the same cache slot.
  // Radius is NOT part of the key — Flutter's /restaurants call omits radius
  // while /explore passes it explicitly; we cache the unfiltered candidate
  // pool and apply each caller's radius at retrieval time.
  return `${catKey}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
}
// Lazy grid expansion stages — load only what we need for the requested page.
// Stage 1 (center cell) on first request, stage 2 (cardinal cells) when more
// places needed, stage 3 (corner cells), stage 4 (text searches). Each stage
// adds to the shared cached pool — next user in same cell gets the bigger pool
// for free.
const GRID_STAGES = [
  { name: 'center',   cells: ['center'] },
  { name: 'cardinal', cells: ['N', 'S', 'E', 'W'] },
  { name: 'corner',   cells: ['NE', 'NW', 'SE', 'SW'] },
];

function buildGridCells(lat, lng, radius) {
  // 9-cell grid covering the search circle. Cell radius = half total; center
  // offset = total/2.5 → cells overlap slightly so no gap.
  const cellRadius = Math.max(1000, Math.floor(radius / 2));
  const offsetM = Math.floor(radius / 2.5);
  const offsetLat = offsetM / 111000;
  const offsetLng = offsetM / (111000 * Math.cos(lat * Math.PI / 180));
  return {
    center: { lat, lng, radius: cellRadius },
    N:  { lat: lat + offsetLat, lng,                    radius: cellRadius },
    S:  { lat: lat - offsetLat, lng,                    radius: cellRadius },
    E:  { lat,                  lng: lng + offsetLng,   radius: cellRadius },
    W:  { lat,                  lng: lng - offsetLng,   radius: cellRadius },
    NE: { lat: lat + offsetLat, lng: lng + offsetLng,   radius: cellRadius },
    NW: { lat: lat + offsetLat, lng: lng - offsetLng,   radius: cellRadius },
    SE: { lat: lat - offsetLat, lng: lng + offsetLng,   radius: cellRadius },
    SW: { lat: lat - offsetLat, lng: lng - offsetLng,   radius: cellRadius },
  };
}

async function getCategoryCandidates({ cat, lat, lng, radius, requiredCount = 1000 }) {
  const key = categoryCacheKey(cat.key, lat, lng);
  let entry = CATEGORY_CACHE.get(key);
  if (!entry || Date.now() - entry.ts >= CATEGORY_CACHE_TTL_MS) {
    sweepCategoryCache();
    entry = {
      ts: Date.now(),
      sortedPool: [],            // append-only — position locked once a place lands here
      seenIds: new Set(),        // dedup guard (covers ALL expansion stages)
      cellsLoaded: new Set(),
      baseLoaded: false,         // long-tail subtypes + text queries fetched once
    };
    CATEGORY_CACHE.set(key, entry);
  }

  const radiusMiles = metersToMiles(radius);

  // Filter, score & append a freshly-fetched batch to sortedPool. New places
  // are sorted WITHIN the batch then concatenated — once positioned, a place
  // never moves. Guarantees zero duplicates across paginated requests.
  //
  // `trusted` = the batch came from one of THIS category's own text queries, so
  // membership is already established by the query itself (a "paintball" result
  // has types like amusement_center that no bucket lists).
  const appendBatch = (places, { trusted = false } = {}) => {
    const fresh = [];
    for (const p of places) {
      if (!p?.place_id || entry.seenIds.has(p.place_id)) continue;
      if (!trusted && !belongsToCategory(p, cat)) continue;
      if (!p.geometry?.location) continue;
      const distMeters = haversineMeters({ lat, lng }, p.geometry.location);
      if (metersToMiles(distMeters) > radiusMiles) continue;
      const reviews = p.user_ratings_total || 0;
      p._hybridScore = reviews / (1 + distMeters / 1000);
      entry.seenIds.add(p.place_id);
      fresh.push(p);
    }
    fresh.sort((a, b) => (b._hybridScore || 0) - (a._hybridScore || 0));
    entry.sortedPool.push(...fresh);
  };

  const cells = buildGridCells(lat, lng, radius);
  const onFail = (what) => (e) => { console.error(`[explore] ${cat.key} ${what} failed:`, e.message); return []; };

  // Base load — everything that DEFINES this category's coverage, fetched once
  // per cache entry and all in flight together so latency is one round trip.
  //
  // searchNearby returns the 20 most popular places per type, so asking only for
  // `restaurant` never surfaces a ramen shop or a sushi bar: they lose the
  // popularity race to steakhouses. Google's taxonomy has a searchable subtype
  // for each (`ramen_restaurant`, `sushi_restaurant`, `video_arcade`,
  // `miniature_golf_course`, …) — one call apiece over the full radius, since a
  // long-tail subtype is sparse enough that 20 covers the whole area.
  //
  // Text queries are coverage too, not a fallback: they used to run only when the
  // grid came up short, which never happened, so "escape room" and "mini golf"
  // were unreachable no matter how far the user scrolled.
  if (!entry.baseLoaded) {
    const c = cells.center;
    const [core, extra, text] = await Promise.all([
      Promise.all(cat.googleTypes.map(t =>
        nearbyByDistanceAll({ lat: c.lat, lng: c.lng, type: t, radius: c.radius }).catch(onFail(`nearby/${t}`)))),
      // Ranked by DISTANCE, not popularity: the core types already fetched the
      // crowd-pleasers, and a subtype's whole job is to reach the tail. Ranking
      // `italian_restaurant` by popularity returns the same famous places again
      // and buries the five trattorias four blocks away.
      Promise.all((cat.extraTypes || []).map(t =>
        nearbyByDistanceAll({ lat, lng, type: t, radius, rank: 'DISTANCE' }).catch(onFail(`subtype/${t}`)))),
      Promise.all((cat.textQueries || []).map(q =>
        textSearchAll({ query: q, lat, lng, radius, maxPages: 2 }).catch(onFail(`text/"${q}"`)))),
    ]);
    entry.cellsLoaded.add('center');
    entry.baseLoaded = true;
    appendBatch([...core.flat(), ...extra.flat()]);
    // A "mini golf" result is tagged miniature_golf_course + point_of_interest —
    // the query already established it belongs here, so skip the type check.
    appendBatch(text.flat(), { trusted: true });
  }

  // Grid expansion for the core types — only as deep as the requested page needs.
  for (const stage of GRID_STAGES) {
    if (entry.sortedPool.length >= requiredCount) break;
    const cellsToLoad = stage.cells.filter(c => !entry.cellsLoaded.has(c));
    if (cellsToLoad.length === 0) continue;
    const tasks = [];
    for (const cellName of cellsToLoad) {
      const c = cells[cellName];
      for (const t of cat.googleTypes) {
        tasks.push(
          nearbyByDistanceAll({ lat: c.lat, lng: c.lng, type: t, radius: c.radius })
            // A swallowed rejection here is indistinguishable from "Google has no
            // such places", which is how quota/network failures used to surface as
            // silently short card lists. Log, then degrade.
            .catch(onFail(`nearby/${t}@${cellName}`))
            .then(places => ({ cellName, places }))
        );
      }
    }
    const results = await Promise.all(tasks);
    const batch = [];
    for (const { cellName, places } of results) {
      entry.cellsLoaded.add(cellName);
      batch.push(...places);
    }
    appendBatch(batch);
  }

  return entry.sortedPool;
}

// Bucket definitions. Three sources feed a category's card pool, and together
// they decide what a user can ever see:
//
//   googleTypes — the broad types. Grid-expanded across 9 cells as the user
//     paginates. Also the membership test (belongsToCategory), together with
//     extraTypes.
//   extraTypes  — Google's long-tail subtypes. searchNearby only ever returns the
//     20 most popular places per type, so a query for `restaurant` is dominated by
//     steakhouses and never reaches a ramen shop. Each subtype gets one call over
//     the full radius; they are sparse enough that 20 covers the area.
//   textQueries — what a person types into Google Maps. Prefer plain nouns:
//     searchText matches against place NAMES too, so an adjective narrows it to
//     places literally called that. In Boston "popular restaurants" returns 2
//     results where "restaurants" returns 20 + a page token. Keep an adjective
//     only when it names a real cuisine or venue kind ("fine dining", "irish pubs").
//
// Points removed from each bucket — per-place dynamic via pointsForPlace().
const CATEGORIES = [
  { key: 'venue-events', title: 'Venue Events', icon: '🎤', imageKey: 'venue-events',
    googleTypes: ['night_club', 'karaoke', 'comedy_club', 'live_music_venue', 'concert_hall', 'performing_arts_theater'],
    extraTypes: ['event_venue', 'auditorium', 'banquet_hall', 'cultural_center', 'arena', 'stadium',
      'movie_theater', 'amphitheatre', 'dance_hall', 'opera_house'],
    textQueries: ['live music venues', 'nightclubs', 'karaoke bars', 'comedy clubs', 'concert venues'] },
  { key: 'outdoors',     title: 'Outdoors',     icon: '🌳', imageKey: 'outdoors',
    googleTypes: [
      'park', 'campground', 'tourist_attraction', 'hiking_area', 'national_park', 'botanical_garden', 'beach',
      'sports_complex', 'sports_club',
      'bowling_alley', 'aquarium', 'zoo', 'marina', 'amusement_park',
    ],
    extraTypes: ['amusement_center', 'video_arcade', 'miniature_golf_course', 'golf_course', 'adventure_sports_center',
      'sports_activity_location', 'athletic_field', 'ice_skating_rink', 'swimming_pool', 'water_park', 'dog_park',
      'garden', 'plaza', 'state_park', 'historical_landmark', 'observation_deck', 'skateboard_park'],
    textQueries: ['paintball', 'go karting', 'boating', 'kayaking', 'hiking trails', 'escape room', 'mini golf', 'arcade'] },
  { key: 'bars',         title: 'Bars',         icon: '🍻', imageKey: 'bars',
    googleTypes: ['bar', 'pub', 'wine_bar', 'bar_and_grill'],
    extraTypes: ['cocktail_bar', 'sports_bar', 'lounge_bar', 'gastropub', 'brewery', 'beer_garden'],
    textQueries: ['bars', 'irish pubs', 'cocktail bars', 'rooftop bar', 'brewery', 'sports bar'] },
  { key: 'cafes',        title: 'Cafes',        icon: '☕', imageKey: 'cafes',
    // `bakery` earns its place: Tatte, Flour Bakery + Cafe and L.A. Burdick are
    // tagged bakery+restaurant, never `cafe`, so a cafe-only list omitted them.
    googleTypes: ['cafe', 'coffee_shop', 'bakery', 'tea_house'],
    // dessert_shop / donut_shop / ice_cream_shop moved to the `dessert` bucket
    // below — the redesign gives Dessert its own filter pill and carousel, so
    // leaving them here would make the two lists return the same places.
    // `bakery` stays a cafe for the reason above; juice/bagel stay too.
    extraTypes: ['juice_shop', 'bagel_shop', 'internet_cafe', 'cat_cafe'],
    textQueries: ['coffee shops', 'cafes', 'bakeries', 'espresso bar'] },
  { key: 'dessert',      title: 'Dessert',      icon: '🍨', imageKey: 'dessert',
    googleTypes: ['dessert_shop', 'ice_cream_shop', 'donut_shop', 'candy_store', 'chocolate_shop'],
    // bubble_tea_store / frozen_yogurt_shop / cupcake_shop were in this list
    // but Google's Places API (New) rejects them as unsupported types — every
    // fetch logged INVALID_ARGUMENT and burned a call for nothing. The text
    // queries below still surface those shops.
    extraTypes: ['dessert_restaurant', 'acai_shop', 'confectionery', 'pastry_shop'],
    textQueries: ['dessert', 'ice cream', 'donuts', 'bubble tea', 'cake shop', 'frozen yogurt', 'gelato'] },
  { key: 'restaurants',  title: 'Restaurants',  icon: '🍽️', imageKey: 'restaurants',
    googleTypes: ['restaurant', 'meal_takeaway', 'meal_delivery', 'fast_food_restaurant', 'fine_dining_restaurant', 'brunch_restaurant', 'breakfast_restaurant'],
    extraTypes: ['american_restaurant', 'italian_restaurant', 'pizza_restaurant', 'sushi_restaurant', 'japanese_restaurant',
      'ramen_restaurant', 'chinese_restaurant', 'mexican_restaurant', 'thai_restaurant', 'indian_restaurant',
      'korean_restaurant', 'vietnamese_restaurant', 'asian_restaurant', 'seafood_restaurant', 'steak_house',
      'barbecue_restaurant', 'hamburger_restaurant', 'sandwich_shop', 'deli', 'mediterranean_restaurant',
      'greek_restaurant', 'french_restaurant', 'spanish_restaurant', 'middle_eastern_restaurant',
      'vegan_restaurant', 'vegetarian_restaurant'],
    textQueries: ['restaurants', 'best restaurants', 'fine dining', 'sushi', 'ramen', 'pizza', 'steakhouse', 'tacos'] },
];

// googleTypes ∪ extraTypes — the full set of Google types that mean "this
// category". Computed once per bucket; membership runs on every fetched place.
const CATEGORY_TYPE_SETS = new Map();
function categoryTypeSet(cat) {
  let set = CATEGORY_TYPE_SETS.get(cat.key);
  if (!set) {
    set = new Set([...cat.googleTypes, ...(cat.extraTypes || [])]);
    CATEGORY_TYPE_SETS.set(cat.key, set);
  }
  return set;
}

function findCat(key) { return CATEGORIES.find(c => c.key === key); }

// Trending pool — separate from the per-category grid pools because Google's
// trending signal is a single textSearch query, not a type-bucketed search.
// We cache per (lat-cell, lng-cell) for 5min so a hot location only pays
// one Google call per window.
async function getTrendingCandidates({ lat, lng, radius }) {
  const cacheKey = `trending|${lat.toFixed(3)}|${lng.toFixed(3)}`;
  const hit = CATEGORY_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.ts < CATEGORY_CACHE_TTL_MS) return hit.sortedPool;

  // Paginated: a single searchText page caps at 20, which left page 2 of the
  // trending list empty.
  const raw = await textSearchAll({ query: 'trending places near me', lat, lng, radius, maxPages: 3 });
  const radiusMiles = metersToMiles(radius);
  const sortedPool = [];
  for (const p of (raw || [])) {
    if (!p?.place_id || !p.geometry?.location) continue;
    const distMeters = haversineMeters({ lat, lng }, p.geometry.location);
    if (metersToMiles(distMeters) > radiusMiles) continue;
    p._hybridScore = (p.user_ratings_total || 0) / (1 + distMeters / 1000);
    sortedPool.push(p);
  }
  // Preserve Google's trending order — DO NOT re-sort. Google's ranking already
  // reflects "trending" signals we don't have access to. Hybrid score kept only
  // as a tiebreaker if a UI ever needs it.
  sweepCategoryCache();
  CATEGORY_CACHE.set(cacheKey, { ts: Date.now(), sortedPool });
  return sortedPool;
}

// Membership test for a category's card list. A place belongs when Google tags
// it with one of the bucket's types — the exact signal we searched on.
//
// This is deliberately NON-exclusive, unlike primaryCategory() below. Bucketing
// each place into exactly one category discarded 39-46% of the places Google had
// already returned for that category: a restaurant search surfaced Cheers and
// Time Out Market, then re-bucketed them to Bars, so they vanished from the
// Restaurants cards while still showing up in search. Overlap is the truth —
// Cheers really is both a bar and a restaurant.
function belongsToCategory(place, cat) {
  const catTypes = categoryTypeSet(cat);
  if (place?.primary_type && catTypes.has(place.primary_type)) return true;
  const types = Array.isArray(place?.types) ? place.types : [];
  return types.some(t => catTypes.has(t));
}

// Determine the PRIMARY category for a place. No name-based inference.
// Strict primary_type ONLY for venue-events because Google tags `night_club`
// loosely on restaurants/museums; for everything else, lenient types[] match.
// Cafe/restaurant overlap (Starbucks=cafe+restaurant vs McDonald's=cafe+restaurant)
// is resolved by Google's `primary_type` — no name regex.
function primaryCategory(place) {
  const types = Array.isArray(place?.types) ? place.types : [];
  const primaryType = place?.primary_type || null;

  // 1) Venue Events — STRICT primary_type (filters out restaurants tagged night_club)
  if (categoryTypeSet(findCat('venue-events')).has(primaryType)) return findCat('venue-events');
  // 2) Outdoors — lenient types[] match
  if (types.some(t => categoryTypeSet(findCat('outdoors')).has(t))) return findCat('outdoors');
  // 3) Bars — lenient types[] match
  if (types.some(t => categoryTypeSet(findCat('bars')).has(t))) return findCat('bars');

  // 4) Cafe vs Restaurant — use bucket config so any cafe-family type
  // (cafe, coffee_shop, etc) and any restaurant-family type (restaurant,
  // meal_takeaway, meal_delivery, fast_food_restaurant, fine_dining_restaurant,
  // brunch_restaurant, breakfast_restaurant) is matched consistently.
  const cafesTypes = categoryTypeSet(findCat('cafes'));
  const restTypes = categoryTypeSet(findCat('restaurants'));
  const isCafe = types.some(t => cafesTypes.has(t));
  const isRest = types.some(t => restTypes.has(t));
  if (isCafe && isRest) {
    // Both family tags present (Starbucks: coffee_shop + restaurant; McDonald's:
    // fast_food_restaurant + cafe sometimes). Google's primary_type decides.
    return cafesTypes.has(primaryType) ? findCat('cafes') : findCat('restaurants');
  }
  if (isCafe) return findCat('cafes');
  if (isRest) return findCat('restaurants');

  return null;
}


const RESTAURANT_CATEGORIES = [
  { key: 'trending', title: 'Trending', icon: '🔥', type: 'restaurant', keyword: 'popular restaurants' },
  { key: 'popular',  title: 'Popular',  icon: '⭐', type: 'restaurant', keyword: 'top rated restaurants' },

  { key: 'cafes',    title: 'Cafes',    icon: '☕', type: 'cafe',       keyword: 'cafe' },

  { key: 'bars',     title: 'Bars',     icon: '🍻', type: 'bar',        keyword: 'bar' },
  { key: 'outdoors', title: 'Outdoors', icon: '🌿', type: 'restaurant', keyword: 'outdoor seating restaurant' },
  { key: 'events',   title: 'Events',   icon: '🎉', type: 'restaurant', keyword: 'live music restaurant' },
];

const getRestaurantCategory = (key) => RESTAURANT_CATEGORIES.find((c) => c.key === key);

// Google price_level (0..4) → dollar signs. Must stay in lockstep with
// pointsForPlace: 0=free (no $), 1=$, 2=$$, 3=$$$, 4=$$$$. Was off by one, so a
// $$ place like Cheers (level 2) showed "$$$" while correctly awarding 20 pts.
function priceLevelToRange(level) {
  if (level === 1) return '$';
  if (level === 2) return '$$';
  if (level === 3) return '$$$';
  if (level === 4) return '$$$$';
  return ''; // 0 (free) or null → no price tier
}

function openNowToStatus(openNow) {
  if (openNow === true) return 'Open';
  if (openNow === false) return 'Closed';
  return 'Unknown';
}

// Backward-compatible key aliases — old Flutter clients still send legacy keys.
// All map into the 5 canonical buckets so /explore/category and
// /restaurants/category return the same underlying places.
const CATEGORY_ALIASES = {
  'rooftop-bars':        'bars',
  'outdoor-activities':  'outdoors',
  'popular-restaurants': 'restaurants',
  // 'trending' is NOT aliased — it routes to a dedicated trending path that
  // uses Google's textSearch('trending places near me') instead of the grid pool.
  // Both /explore/category/trending/places and /restaurants/category/trending/places
  // detect the key and short-circuit to getTrendingCandidates().
  'popular':             'restaurants',
  'events':              'venue-events',
};
const getCategory = key => {
  const resolved = CATEGORY_ALIASES[key] || key;
  return CATEGORIES.find(c => c.key === resolved);
};

// helper: map raw Google place to response object.
// Points computed from Google price_level + user_ratings_total per launch spec
// (see utils/pointsForPlace.js). No static per-category points.
function mapPlace(p, lat, lng) {
  const placeLat = p.geometry?.location?.lat ?? 0;
  const placeLng = p.geometry?.location?.lng ?? 0;
  const openNow = p.opening_hours?.open_now ?? null;
  const points = pointsForPlace({
    priceLevel: p.price_level,
    userRatingsTotal: p.user_ratings_total,
  });
  return {
    placeId: p.place_id,
    name: p.name,
    address: p.vicinity || p.formatted_address || null,
    photoUrl: photoUrlByRef(p.photos?.[0]?.photo_reference, 4800),
    points,
    distanceMiles: placeLat && placeLng
      ? metersToMiles(haversineMeters({ lat, lng }, { lat: placeLat, lng: placeLng }))
      : null,
    lat: Number(placeLat),
    lng: Number(placeLng),
    rating: p.rating || null,
    userRatingsTotal: p.user_ratings_total || null,
    openNow,
    status: openNowToStatus(openNow),
    openingHours: p.opening_hours?.weekday_text || [],
    priceLevel: p.price_level ?? null,
    priceRange: priceLevelToRange(p.price_level) || '',
    businessStatus: p.business_status || null,
    types: p.types || [],
    // Wheelchair glyph on the redesign's cards. Comes from the search response
    // now that accessibilityOptions is in SEARCH_FIELD_MASK; Google omits the
    // field for places it has no data on, so undefined → false, never "no".
    accessible: p.wheelchair_accessible_entrance === true,
  };
}

// GET /api/explore/category/:key/places?lat&lng&radius=5000
exports.getCategoryPlaces = async (req, res) => {
  try {
    const { key } = req.params;

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 16093;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng required' });
    }

    // Trending short-circuit — different data source (Google textSearch).
    if (key === 'trending') {
      return _renderTrendingPlaces(req, res, lat, lng, radius);
    }

    const cat = getCategory(key);
    if (!cat) return res.status(404).json({ error: 'Unknown category' });

    // Pagination — default page=1, pageSize=20. Pool expands lazily as user
    // paginates so cold first page stays fast.
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(50, parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * pageSize;
    const requiredCount = (page + 1) * pageSize;

    const candidates = await getCategoryCandidates({ cat, lat, lng, radius, requiredCount });
    const totalCount = candidates.length;
    const slice = candidates.slice(offset, offset + pageSize);
    const items = slice.map(p => ({ ...mapPlace(p, lat, lng), category: cat.title }));
    const hasMore = offset + items.length < totalCount;

    res.json({
      // category.points = null — bucket has no fixed point value. Per-place
      // `points` (inside places[]) is the source of truth (price_level × reviews).
      category: { key: cat.key, title: cat.title, points: null },
      page,
      pageSize,
      totalCount,
      hasMore,
      places: items,
      nextPageToken: null,
    });
  } catch (e) {
    console.error('Category places error', e);
    res.status(500).json({ error: 'Failed to load places' });
  }
};

// GET /api/explore/category/:key/more?pagetoken=X&lat&lng
exports.getCategoryMorePlaces = async (req, res) => {
  try {
    const { key } = req.params;
    const cat = getCategory(key);
    if (!cat) return res.status(404).json({ error: 'Unknown category' });

    const pagetoken = req.query.pagetoken;
    if (!pagetoken) return res.status(400).json({ error: 'pagetoken required' });

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat/lng required' });
    }

    const page = await nearbyPage({ pagetoken });
    const items = (page.results || []).map(p => mapPlace(p, lat, lng));
    items.sort((a, b) => (a.distanceMiles || 0) - (b.distanceMiles || 0) || (b.rating || 0) - (a.rating || 0));

    res.json({
      places: items,
      nextPageToken: page.next_page_token || null,
    });
  } catch (e) {
    console.error('Category more places error', e);
    res.status(500).json({ error: 'Failed to load more places' });
  }
};
exports.recordVisit = async (req, res) => {
  try {
    const userId = req.authData.id;
    let { placeId, name, latitude, longitude, mediaUrl, categoryKey, accuracy, isMocked } = req.body || {};

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'Bad latitude/longitude' });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Latitude/longitude out of range' });
    }

    // #5 — GPS integrity (anti-spoof + precision). Cheap, runs first.
    // 1) Mocked/fake location → reject.
    if (isMocked === true || isMocked === 'true') {
      return res.status(409).json({
        awarded: false,
        reason: 'mocked-location',
        message: 'Your location looks spoofed. Turn off mock location to check in.',
      });
    }
    // 2) Low GPS precision → reject (only when accuracy is actually reported;
    //    missing/unknown accuracy is allowed so older clients aren't blocked).
    const MAX_GPS_ACCURACY_METERS = Number(process.env.MAX_GPS_ACCURACY_METERS || 50);
    const acc = accuracy != null && accuracy !== '' ? Number(accuracy) : null;
    if (acc != null && Number.isFinite(acc) && acc > MAX_GPS_ACCURACY_METERS) {
      return res.status(409).json({
        awarded: false,
        reason: 'low-accuracy',
        message: 'Weak GPS signal — move to open sky and try again.',
        accuracy: acc,
        maxAccuracy: MAX_GPS_ACCURACY_METERS,
      });
    }

    // ✅ require placeId (so we can validate)
    if (!placeId || typeof placeId !== 'string' || placeId.trim().length < 5) {
      return res.status(400).json({ error: 'placeId required to award points' });
    }
    placeId = placeId.trim();

    // #4 — global check-in cooldown (once per N min, any place). Mirrors the
    // /submit-for-points/status countdown (same LocationPoint source + env), so
    // the FE countdown matches what's actually enforced here. Runs BEFORE the
    // Google details fetch so spammed/early taps cost nothing.
    const RATE_LIMIT_MINUTES = Number(process.env.SUBMIT_RATE_LIMIT_MINUTES || 30);
    if (RATE_LIMIT_MINUTES > 0) {
      const windowMs = RATE_LIMIT_MINUTES * 60 * 1000;
      const lastVisit = await prisma.locationPoint.findFirst({
        where: { userId, createdAt: { gte: new Date(Date.now() - windowMs) } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (lastVisit) {
        const nextAllowedAt = new Date(lastVisit.createdAt.getTime() + windowMs);
        const retryAfterSeconds = Math.max(1, Math.ceil((nextAllowedAt.getTime() - Date.now()) / 1000));
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
          awarded: false,
          reason: 'rate-limited',
          message: `You can only check in once every ${RATE_LIMIT_MINUTES} minutes. Try again soon.`,
          rateLimitMinutes: RATE_LIMIT_MINUTES,
          retryAfterSeconds,
          nextAllowedAt: nextAllowedAt.toISOString(),
        });
      }
    }

    const cat = categoryKey ? getCategory(categoryKey) : null;

    // --------------------------
    // ✅ server-side place validate
    // --------------------------
    const MAX_PLACE_DISTANCE_METERS = Number(process.env.MAX_PLACE_DISTANCE_METERS || 20);

    let placeLat = null;
    let placeLng = null;
    let placeNameFromGoogle = null;
    let viewport = null;  // { northeast: {lat,lng}, southwest: {lat,lng} } or null
    let placePriceLevel = null;
    let placeReviewCount = null;
    let placeOpenNow = null;     // null/undefined = hours unknown → allow
    let placeBizStatus = null;

    try {
      const d = await details(placeId);
      placeLat = d?.geometry?.location?.lat ?? null;
      placeLng = d?.geometry?.location?.lng ?? null;
      placeNameFromGoogle = d?.name ?? null;
      viewport = d?.geometry?.viewport || null;
      placePriceLevel = d?.price_level ?? null;
      placeReviewCount = d?.user_ratings_total ?? null;
      placeOpenNow = d?.opening_hours?.open_now ?? null; // derived from currentOpeningHours.openNow (same field FE shows)
      placeBizStatus = d?.business_status ?? null;
    } catch (e) {
      return res.status(502).json({
        awarded: false,
        error: 'Failed to verify placeId via Google Places',
      });
    }

    if (!Number.isFinite(placeLat) || !Number.isFinite(placeLng)) {
      return res.status(400).json({
        awarded: false,
        error: 'Invalid placeId (no geometry)',
      });
    }

    // #2 — closed-place reject. Only reject on an EXPLICIT closed signal; if the
    // place has no hours data (openNow null/undefined) we ALLOW (don't block legit
    // spots that simply lack hours on Google). Mirrors the FE's Open/Closed badge.
    if (placeOpenNow === false ||
        placeBizStatus === 'CLOSED_TEMPORARILY' ||
        placeBizStatus === 'CLOSED_PERMANENTLY') {
      return res.status(409).json({
        awarded: false,
        reason: 'place-closed',
        message: 'This place is closed right now — you can’t check in.',
      });
    }

    const distToPlace = haversineMeters(
      { lat, lng },
      { lat: placeLat, lng: placeLng }
    );

    // Accept if user is inside Google's viewport bounding box (handles large
    // venues — stadiums, malls, parks — where distance to center is misleading).
    const insideViewport = viewport &&
      lat >= viewport.southwest.lat && lat <= viewport.northeast.lat &&
      lng >= viewport.southwest.lng && lng <= viewport.northeast.lng;

    if (!insideViewport && distToPlace > MAX_PLACE_DISTANCE_METERS) {
      const dist = Math.round(distToPlace);
      console.log(`[recordVisit] too-far user=${userId} placeId=${placeId} dist=${dist}m max=${MAX_PLACE_DISTANCE_METERS}m viewport=${viewport ? 'present-but-outside' : 'absent'}`);
      return res.status(403).json({
        awarded: false,
        reason: 'too-far-from-place',
        message: `You need to be within ${MAX_PLACE_DISTANCE_METERS}m of this place to check in. You are currently ${dist}m away.`,
        placeId,
        distanceMiles: metersToMiles(dist),
        maxMiles: metersToMiles(MAX_PLACE_DISTANCE_METERS),
      });
    }

    const since = new Date(Date.now() - DUP_WINDOW_HOURS * 60 * 60 * 1000);

    /* ---------- 1) Precise de-dupe by placeId ---------- */
    const priorSamePlace = await prisma.locationPoint.findFirst({
      where: { userId, placeId, createdAt: { gte: since } },
      select: { id: true, createdAt: true }
    });

    if (priorSamePlace) {
      return res.status(200).json({
        awarded: false,
        reason: 'duplicate-place-within-window',
        placeId,
        windowHours: DUP_WINDOW_HOURS,
        since: priorSamePlace.createdAt
      });
    }

    /* ---------- 2) Proximity fallback (optional) ---------- 
       If you keep NEARBY_WITH_PLACEID=0 it will skip. */
    const fallbackRadius = NEARBY_WITH_PLACEID;

    if (fallbackRadius > 0) {
      const recent = await prisma.locationPoint.findMany({
        where: { userId, createdAt: { gte: since } },
        select: { latitude: true, longitude: true, createdAt: true }
      });

      let nearest = null;
      for (const lp of recent) {
        if (lp.latitude == null || lp.longitude == null) continue;
        const d = haversineMeters({ lat: lp.latitude, lng: lp.longitude }, { lat, lng });
        if (!nearest || d < nearest.distance) nearest = { ...lp, distance: d };
      }

      if (nearest && nearest.distance <= fallbackRadius) {
        return res.status(200).json({
          awarded: false,
          reason: 'duplicate-nearby-within-window',
          radiusMeters: fallbackRadius,
          nearestMeters: Math.round(nearest.distance),
          windowHours: DUP_WINDOW_HOURS,
          lastCheckinAt: nearest.createdAt
        });
      }
    }

    /* ---------- 3) Create + award ---------- */
    // Points from Google price_level + user_ratings_total per launch spec
    // (pointsForPlace handles null/no-data fallback via review-count tiers).
    const points = pointsForPlace({
      priceLevel: placePriceLevel,
      userRatingsTotal: placeReviewCount,
    });

    // Evidence photo: prefer the uploaded file (check-in camera capture); fall
    // back to a mediaUrl passed in the body (older clients), else empty string.
    // An upload hiccup must NOT block the check-in / point award.
    let evidenceUrl = mediaUrl || '';
    if (req.file) {
      try {
        evidenceUrl = await uploadToS3(req.file, 'points');
      } catch (e) {
        console.error('recordVisit: evidence upload failed', e?.message);
      }
    }

    const created = await prisma.locationPoint.create({
      data: {
        userId,
        mediaUrl: evidenceUrl,
        placeId,
        placeName: (name && String(name).trim()) || placeNameFromGoogle || null,
        placeType: cat?.title || null,
        latitude: lat,
        longitude: lng,
        points
      }
    });

    await addPointsWithMultiplier(userId, points, 'LOCATION_VISIT', created.id);

    return res.json({
      awarded: true,
      points,
      id: created.id,
      placeId,
      distanceMiles: metersToMiles(distToPlace),
    });
  } catch (e) {
    console.error('recordVisit error', e);
    return res.status(500).json({ error: 'Failed to record visit' });
  }
};

exports.getPlaceDetail = async (req, res) => {
  try {
    const { placeId } = req.params;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const d = await details(placeId);

    // Which of this user's friends have checked in here. The map's bottom sheet
    // shows a "Friends Spotted" card, and this is the only call it makes, so the
    // data rides along rather than costing a second round trip.
    const userId = req.authData?.id;
    let friendsCount = 0;
    let friendsPreview = [];
    if (userId) {
      const friendIds = await getFriendIds(userId);
      if (friendIds.length) {
        const visits = await prisma.locationPoint.findMany({
          where: { userId: { in: friendIds }, placeId },
          select: { userId: true },
          distinct: ['userId'],
        });
        friendsCount = visits.length;
        friendsPreview = await previewFriends(visits.map(v => v.userId));
      }
    }

    const photos = buildPhotosArray(d, 8);
    const image = photos[0] || photoUrlByRef(d.photos?.[0]?.photo_reference, 4800) || '';
    const openNow = d.opening_hours?.open_now ?? null;
    const placeLat = d.geometry?.location?.lat;
    const placeLng = d.geometry?.location?.lng;

    let distanceMiles = null;
    if (Number.isFinite(lat) && Number.isFinite(lng) && placeLat && placeLng) {
      distanceMiles = metersToMiles(haversineMeters({ lat, lng }, { lat: placeLat, lng: placeLng }));
    }

    // Match which app categories this place falls under based on Google types
    const placeTypes = d.types || [];
    const TYPE_TO_SECTIONS = {
      restaurant: ['Popular Restaurants'],
      cafe: ['Cafes'],
      bar: ['Bars'],
      night_club: ['Bars'],
      park: ['Outdoor Activities'],
      campground: ['Outdoor Activities'],
      tourist_attraction: ['Outdoor Activities'],
      rooftop: ['Rooftop Bars'],
    };
    const sections = new Set();
    for (const t of placeTypes) {
      if (TYPE_TO_SECTIONS[t]) TYPE_TO_SECTIONS[t].forEach(s => sections.add(s));
    }
    // (Name-based guessing removed — sections derive ONLY from Google's types[].)

    // ---------- Cuisine taxonomy split into 4 buckets ----------
    // cuisine = origin/style of food (American, Pizza, Sushi, etc) — from types
    // meals   = breakfast/brunch/lunch/dinner/dessert flags
    // drinks  = bar/pub/coffee/tea + serves_beer/wine/cocktails flags
    // dietary = vegetarian + keyword detection (vegan/gluten-free/halal/kosher)
    const CUISINE_TYPE_MAP = {
      american_restaurant: 'American', italian_restaurant: 'Italian',
      mexican_restaurant: 'Mexican', chinese_restaurant: 'Chinese',
      japanese_restaurant: 'Japanese', thai_restaurant: 'Thai',
      indian_restaurant: 'Indian', french_restaurant: 'French',
      spanish_restaurant: 'Spanish', greek_restaurant: 'Greek',
      korean_restaurant: 'Korean', vietnamese_restaurant: 'Vietnamese',
      mediterranean_restaurant: 'Mediterranean', middle_eastern_restaurant: 'Middle Eastern',
      seafood_restaurant: 'Seafood', steak_house: 'Steakhouse',
      sushi_restaurant: 'Sushi', pizza_restaurant: 'Pizza',
      hamburger_restaurant: 'Burger', sandwich_shop: 'Sandwich',
      barbecue_restaurant: 'BBQ', ramen_restaurant: 'Ramen',
      fast_food_restaurant: 'Fast Food', fine_dining_restaurant: 'Fine Dining',
      bar_and_grill: 'American', bakery: 'Bakery', ice_cream_shop: 'Ice Cream',
      brunch_restaurant: null, breakfast_restaurant: null, // meals, not cuisine
      dessert_restaurant: null, dessert_shop: null,
    };
    const MEAL_TYPE_MAP = {
      breakfast_restaurant: 'Breakfast', brunch_restaurant: 'Brunch',
      dessert_restaurant: 'Dessert', dessert_shop: 'Dessert',
    };
    const DRINK_TYPE_MAP = {
      bar: 'Bar', pub: 'Pub', night_club: 'Nightlife',
      coffee_shop: 'Coffee', cafe: 'Coffee', tea_house: 'Tea', wine_bar: 'Wine',
    };

    const cuisine = new Set();
    const meals = new Set();
    const drinks = new Set();
    const dietary = new Set();

    for (const t of placeTypes) {
      if (CUISINE_TYPE_MAP[t]) cuisine.add(CUISINE_TYPE_MAP[t]);
      if (MEAL_TYPE_MAP[t]) meals.add(MEAL_TYPE_MAP[t]);
      if (DRINK_TYPE_MAP[t]) drinks.add(DRINK_TYPE_MAP[t]);
    }
    // Meal flags (only push if explicit — drop the always-on Lunch/Dinner from before)
    if (d.serves_breakfast) meals.add('Breakfast');
    if (d.serves_brunch) meals.add('Brunch');
    if (d.serves_lunch) meals.add('Lunch');
    if (d.serves_dinner) meals.add('Dinner');
    if (d.serves_dessert) meals.add('Dessert');
    // Drink flags
    if (d.serves_beer) drinks.add('Beer');
    if (d.serves_wine) drinks.add('Wine');
    if (d.serves_cocktails) drinks.add('Cocktails');
    if (d.serves_coffee) drinks.add('Coffee');
    // Dietary — ONLY real Google flags. servesVegetarianFood is the only
    // dietary boolean Google exposes. Vegan/Gluten-Free/Halal/Kosher are NOT
    // returned by Places API — so we omit them entirely rather than guess.
    if (d.serves_vegetarian_food) dietary.add('Vegetarian');

    // Enforce no-overlap rule: sections wins, strip from cuisine/meals/drinks/dietary
    for (const s of sections) {
      cuisine.delete(s); meals.delete(s); drinks.delete(s); dietary.delete(s);
    }

    const services = [];
    if (d.dine_in) services.push('Dine-in');
    if (d.takeout) services.push('Takeout');
    if (d.delivery) services.push('Delivery');
    if (d.reservable) services.push('Reservable');
    if (d.wheelchair_accessible_entrance) services.push('Wheelchair Accessible');

    // Reviews (top 5 from Google)
    const reviews = (d.reviews || []).slice(0, 5).map(r => ({
      author: r.author_name || '',
      authorPhoto: r.profile_photo_url || null,
      rating: r.rating || 0,
      text: r.text || '',
      timeAgo: r.relative_time_description || '',
    }));

    res.json({
      id: String(d.place_id),
      name: d.name || '',
      address: d.formatted_address || '',
      phone: d.formatted_phone_number || d.international_phone_number || '',
      website: d.website || '',
      googleMapsUrl: d.url || '',
      lat: Number(placeLat ?? 0),
      lng: Number(placeLng ?? 0),
      distanceMiles,
      image,
      photos,
      description: d.editorial_summary?.overview || null,
      category: d.types?.[0] || '',
      sections: [...sections],
      cuisine: [...cuisine],
      meals: [...meals],
      drinks: [...drinks],
      dietary: [...dietary],
      services,
      priceLevel: d.price_level ?? null,
      priceRange: priceLevelToRange(d.price_level) || '',
      openNow,
      status: openNowToStatus(openNow),
      openingHours: d.opening_hours?.weekday_text || [],
      rating: Number(d.rating ?? 0),
      totalReviews: Number(d.user_ratings_total ?? 0),
      reviews,
      businessStatus: d.business_status || null,
      types: d.types || [],
      accessible: d.wheelchair_accessible_entrance === true,
      friendsCount,
      friendsPreview,
    });
  } catch (e) {
    console.error('place detail error', e);
    res.status(500).json({ error: 'Failed to load place detail' });
  }
};

// GET /api/explore/search?q=starbucks&lat=X&lng=Y&radius=5000&limit=10
// Backend-driven search (Flutter calls this instead of Google Autocomplete directly).
// Returns rich place details + points breakdown applying user's active multiplier.
exports.searchPlaces = async (req, res) => {
  try {
    const userId = req.authData.id;
    const query = (req.query.q || '').trim();
    if (!query || query.length < 2) {
      return res.status(400).json({ success: false, error: 'Search query required (min 2 characters)' });
    }

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 16093;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ success: false, error: 'lat/lng required' });
    }
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 20);

    // Text-relevant search across ALL categories, kept within OUR taxonomy.
    // We run a type-LESS Google Text Search (location-biased) so the query
    // matches by name/relevance, then classify each result into our canonical
    // buckets and DROP anything that doesn't fall into one of them. So "cheers"
    // finds the bar even though the map screen defaults to ?category=restaurants.
    // NOTE: the ?category= param is the browse-screen default, NOT a search
    // filter — it is intentionally IGNORED here, otherwise the forced
    // "restaurants" default would hide bars/cafes/etc the user is searching for.
    // Results still never escape the 6 categories (primaryCategory drops the rest).
    let pool = [];
    try {
      pool = await textSearch({ query, lat, lng, radius });
    } catch (e) {
      console.error('searchPlaces textSearch error:', e.message);
    }

    const top = [];
    for (const p of pool) {
      const bucket = primaryCategory(p);
      if (!bucket) continue;                 // outside our 6 categories → drop
      top.push(p);
      if (top.length >= limit) break;
    }

    // 2) Active multiplier for this user (factor=1 if none)
    const now = new Date();
    const activeMult = await prisma.activeMultiplier.findFirst({
      where: { userId, endsAt: { gt: now } },
      orderBy: { endsAt: 'desc' },
    });
    const multiplier = activeMult?.factor || 1;

    // 3) Enrich each result with details + classification + points.
    // Field shape mirrors /restaurants/category/:key/places so Flutter can
    // render search results with the SAME widget it uses for the category grid.
    const restaurants = await Promise.all(top.map(async (p) => {
      let d = null;
      try { d = await detailsCached(p.place_id); } catch (_) {}
      const photos = buildPhotosArray(d, 8);
      const image = photos[0] || photoUrlByRef(p.photos?.[0]?.photo_reference, 4800) || '';
      const matched = primaryCategory(d || p);
      const bucket = matched; // each result classified into its own bucket (search spans all 6)
      // Points from Google price_level + reviews (per launch spec).
      const basePoints = pointsForPlace({
        priceLevel: d?.price_level ?? p.price_level,
        userRatingsTotal: d?.user_ratings_total ?? p.user_ratings_total,
      });
      const finalPoints = Math.round(basePoints * multiplier);
      const openNow = d?.opening_hours?.open_now ?? p.opening_hours?.open_now;
      const placeLat = p.geometry?.location?.lat ?? d?.geometry?.location?.lat ?? 0;
      const placeLng = p.geometry?.location?.lng ?? d?.geometry?.location?.lng ?? 0;

      return {
        id: String(p.place_id),
        name: d?.name || p.name || '',
        address: d?.formatted_address || p.formatted_address || p.vicinity || '',
        phone: d?.formatted_phone_number || d?.international_phone_number || '',
        website: d?.website || '',
        googleMapsUrl: d?.url || '',
        lat: Number(placeLat),
        lng: Number(placeLng),
        image,
        photos,
        category: bucket ? bucket.title : (matched?.title || null),
        points: finalPoints,
        priceLevel: d?.price_level ?? null,
        priceRange: priceLevelToRange(d?.price_level) || '',
        openNow: openNow ?? null,
        status: openNowToStatus(openNow),
        openingHours: d?.opening_hours?.weekday_text || [],
        rating: Number(d?.rating ?? p.rating ?? 0),
        totalReviews: Number(d?.user_ratings_total ?? p.user_ratings_total ?? 0),
        businessStatus: d?.business_status || null,
        types: d?.types || p.types || [],
        basePoints,
        multiplier,
      };
    }));

    res.json({
      success: true,
      category: null, // search spans all 6 categories; each place carries its own `category`
      radius,
      totalCount: restaurants.length,
      hasMore: false,
      // Return BOTH keys — legacy Flutter parses `places`, newer parses `restaurants`.
      // Same array, no duplication on the wire (same reference).
      restaurants,
      places: restaurants,
    });
  } catch (e) {
    console.error('Search places error', e);
    res.status(500).json({ success: false, error: 'Search failed' });
  }
};

// ===================== Restaurant APIs =====================
// GET /api/restaurants/categories
exports.getRestaurantCategories = async (req, res) => {
  try {
    return res.json({
      success: true,
      categories: RESTAURANT_CATEGORIES.map((c) => ({
        key: c.key,
        title: c.title,
        icon: c.icon,
      })),
    });
  } catch (e) {
    console.error('getRestaurantCategories error', e);
    return res.status(500).json({ success: false, error: 'Failed to load categories' });
  }
};
exports.getRestaurantsByCategory = async (req, res) => {
  try {
    const { key } = req.params;

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 16093;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ success: false, error: 'lat/lng required' });
    }

    // Trending short-circuit — different data source (Google textSearch).
    if (key === 'trending') {
      return _renderTrendingRestaurants(req, res, lat, lng, radius);
    }

    // Use the canonical 5-bucket category (with aliases for legacy keys
    // popular/events/rooftop-bars/outdoor-activities/popular-restaurants).
    const cat = getCategory(key);
    if (!cat) return res.status(404).json({ success: false, error: 'Unknown category' });

    // Pagination — only run details() for the visible page (Google API cost +
    // latency scales with details() calls). Default page=1, pageSize=20.
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(50, parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * pageSize;

    // Shared cached candidate pool — pool expands lazily as user paginates.
    // We ask for enough places to cover current page + a buffer of one extra page.
    const requiredCount = (page + 1) * pageSize;
    const candidates = await getCategoryCandidates({ cat, lat, lng, radius, requiredCount });
    const top = candidates.slice(offset, offset + pageSize);
    const totalCount = candidates.length;
    const hasMore = offset + top.length < totalCount;

    const restaurants = await Promise.all(
      top.map(async (p) => {
        const placeId = p.place_id;

        // ✅ Full details for every item in list (আপনার চাওয়া অনুযায়ী)
        // Memoized — a page of 20 cards used to cost 20 Details calls, re-paid on
        // every scroll and by every user browsing the same neighbourhood.
        let d = null;
        try {
          d = await detailsCached(placeId);
        } catch (err) {
          d = null;
        }

        const photos = buildPhotosArray(d, 8);        // ✅ multiple photos
        const image =
          photos[0] ||
          photoUrlByRef(p.photos?.[0]?.photo_reference, 4800) ||
          '';

        const lat2 = p.geometry?.location?.lat ?? d?.geometry?.location?.lat ?? 0;
        const lng2 = p.geometry?.location?.lng ?? d?.geometry?.location?.lng ?? 0;

        // Search result first: `d` is cached for hours, but open_now is live.
        const openNow = p.opening_hours?.open_now ?? d?.opening_hours?.open_now;
        const status = openNowToStatus(openNow);

        return {
          id: String(placeId),
          name: d?.name || p.name || '',
          address: d?.formatted_address || p.vicinity || '',
          phone: d?.formatted_phone_number || d?.international_phone_number || '',
          website: d?.website || '',
          googleMapsUrl: d?.url || '',
          lat: Number(lat2),
          lng: Number(lng2),

          // ✅ images
          image,
          photos,

          category: cat.title,
          // Per-place points from Google price_level + reviews (launch spec).
          points: pointsForPlace({
            priceLevel: d?.price_level ?? p.price_level,
            userRatingsTotal: d?.user_ratings_total ?? p.user_ratings_total,
          }),
          priceLevel: d?.price_level ?? null,
          priceRange: priceLevelToRange(d?.price_level) || '',
          openNow: openNow ?? null,
          status,
          openingHours: d?.opening_hours?.weekday_text || [],

          rating: Number(d?.rating ?? p.rating ?? 0),
          totalReviews: Number(d?.user_ratings_total ?? p.user_ratings_total ?? 0),
          businessStatus: d?.business_status || null,
          types: d?.types || p.types || [],
        };
      })
    );

    return res.json({
      success: true,
      category: { key: cat.key, title: cat.title },
      radius,
      page,
      pageSize,
      totalCount,
      hasMore,
      restaurants,
    });
  } catch (e) {
    console.error('getRestaurantsByCategory error', e);
    return res.status(500).json({ success: false, error: 'Failed to load restaurants' });
  }
};

// Shared trending renderer for /explore/category/trending/places.
// Same response envelope as getCategoryPlaces (places[] + page/pageSize/etc),
// data source = Google textSearch('trending places near me').
async function _renderTrendingPlaces(req, res, lat, lng, radius) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(50, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;

  const candidates = await getTrendingCandidates({ lat, lng, radius });
  const totalCount = candidates.length;
  const slice = candidates.slice(offset, offset + pageSize);
  // Points computed per-place from Google signals via mapPlace.
  const items = slice.map(p => ({ ...mapPlace(p, lat, lng), category: 'Trending' }));

  return res.json({
    // category.points = null — per-place card is the source of truth.
    category: { key: 'trending', title: 'Trending', points: null },
    page,
    pageSize,
    totalCount,
    hasMore: offset + items.length < totalCount,
    places: items,
    nextPageToken: null,
  });
}

// Shared trending renderer for /restaurants/category/trending/places.
// Same response envelope + enrichment as getRestaurantsByCategory.
async function _renderTrendingRestaurants(req, res, lat, lng, radius) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(50, parseInt(req.query.pageSize, 10) || 20));
  const offset = (page - 1) * pageSize;

  const candidates = await getTrendingCandidates({ lat, lng, radius });
  const totalCount = candidates.length;
  const top = candidates.slice(offset, offset + pageSize);
  const hasMore = offset + top.length < totalCount;

  const restaurants = await Promise.all(top.map(async (p) => {
    const placeId = p.place_id;
    let d = null;
    try { d = await detailsCached(placeId); } catch (_) { d = null; }

    const photos = buildPhotosArray(d, 8);
    const image = photos[0] || photoUrlByRef(p.photos?.[0]?.photo_reference, 4800) || '';
    const lat2 = p.geometry?.location?.lat ?? d?.geometry?.location?.lat ?? 0;
    const lng2 = p.geometry?.location?.lng ?? d?.geometry?.location?.lng ?? 0;
    // Search result first: `d` is cached for hours, but open_now is live.
    const openNow = p.opening_hours?.open_now ?? d?.opening_hours?.open_now;
    // Points from Google price_level + reviews (per launch spec).
    const points = pointsForPlace({
      priceLevel: d?.price_level ?? p.price_level,
      userRatingsTotal: d?.user_ratings_total ?? p.user_ratings_total,
    });

    return {
      id: String(placeId),
      name: d?.name || p.name || '',
      address: d?.formatted_address || p.vicinity || '',
      phone: d?.formatted_phone_number || d?.international_phone_number || '',
      website: d?.website || '',
      googleMapsUrl: d?.url || '',
      lat: Number(lat2),
      lng: Number(lng2),
      image,
      photos,
      category: 'Trending',
      points,
      priceLevel: d?.price_level ?? null,
      priceRange: priceLevelToRange(d?.price_level) || '',
      openNow: openNow ?? null,
      status: openNowToStatus(openNow),
      openingHours: d?.opening_hours?.weekday_text || [],
      rating: Number(d?.rating ?? p.rating ?? 0),
      totalReviews: Number(d?.user_ratings_total ?? p.user_ratings_total ?? 0),
      businessStatus: d?.business_status || null,
      types: d?.types || p.types || [],
    };
  }));

  return res.json({
    success: true,
    category: { key: 'trending', title: 'Trending' },
    radius,
    page,
    pageSize,
    totalCount,
    hasMore,
    restaurants,
  });
}

function startOfWeekMonday(d = new Date()) {
  const date = new Date(d);
  const day = date.getDay(); // 0=Sun,1=Mon...
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

async function getFriendIds(userId) {
  const rows = await prisma.friendship.findMany({
    where: {
      status: 'ACCEPTED',
      OR: [{ requesterId: userId }, { receiverId: userId }],
    },
    select: { requesterId: true, receiverId: true },
  });

  const ids = new Set();
  for (const r of rows) {
    ids.add(r.requesterId === userId ? r.receiverId : r.requesterId);
  }
  return [...ids];
}

async function getUserAvatar(userId) {
  // Optional: latest saved minime avatar
  const m = await prisma.minime.findFirst({
    where: { userId, isSaved: true },
    select: { avatarUrl: true, selfieUrl: true },
    orderBy: { updatedAt: 'desc' },
  });
  return m?.avatarUrl || m?.selfieUrl || null;
}

exports.getTopTrendingWeekRestaurants = async (req, res) => {
  try {
    const userId = req.authData.id;

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 3000;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ success: false, error: 'lat/lng required' });
    }

    const since = startOfWeekMonday(new Date());

const grouped = await prisma.locationPoint.groupBy({
  by: ['placeId'],
  where: {
    createdAt: { gte: since },
    placeId: { not: null },
    latitude: { not: null },
    longitude: { not: null },
  },
  _count: { placeId: true },  // ✅ visitCount
  _sum: { points: true },     // ✅ pointsCollected
  take: limit * 6,
  orderBy: [
    { _sum: { points: 'desc' } },
    { _count: { placeId: 'desc' } },
  ],
});


    if (!grouped.length) {
      return res.json({
        success: true,
        title: 'Top Trending',
        subtitle: 'Best of the week',
        since,
        radius,
        restaurants: [],
      });
    }

    const placeIds = grouped.map(g => g.placeId).filter(Boolean);

    // ✅ uniqueUsers: placeId ভিত্তিতে distinct user গণনা
    // Prisma distinct + count workaround:
    const allWeekPoints = await prisma.locationPoint.findMany({
      where: {
        createdAt: { gte: since },
        placeId: { in: placeIds },
      },
      select: { placeId: true, userId: true, latitude: true, longitude: true, placeName: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const uniqueUsersMap = new Map(); // placeId -> Set(userId)
    const latestByPlace = new Map();  // placeId -> latest lp

    for (const lp of allWeekPoints) {
      if (!uniqueUsersMap.has(lp.placeId)) uniqueUsersMap.set(lp.placeId, new Set());
      uniqueUsersMap.get(lp.placeId).add(lp.userId);

      if (!latestByPlace.has(lp.placeId)) {
        latestByPlace.set(lp.placeId, lp); // because sorted desc
      }
    }

    // ✅ Friend list
    const friendIds = await getFriendIds(userId);

    // ✅ Friends who went where (distinct by placeId+userId)
    let friendsByPlace = new Map(); // placeId -> Set(friendId)
    if (friendIds.length) {
      const friendVisits = await prisma.locationPoint.findMany({
        where: {
          createdAt: { gte: since },
          placeId: { in: placeIds },
          userId: { in: friendIds },
        },
        select: { placeId: true, userId: true },
      });

      friendsByPlace = new Map();
      for (const v of friendVisits) {
        if (!friendsByPlace.has(v.placeId)) friendsByPlace.set(v.placeId, new Set());
        friendsByPlace.get(v.placeId).add(v.userId);
      }
    }

    // ✅ Build output
    const here = { lat, lng };
    const out = [];

    for (const g of grouped) {
      const placeId = g.placeId;
      const last = latestByPlace.get(placeId);
      if (!last?.latitude || !last?.longitude) continue;

      // radius filter (user position)
      const dMeters = haversineMeters(here, { lat: last.latitude, lng: last.longitude });
      if (dMeters > radius) continue;

      // Google details for proper address/phone/website/photo (memoized — this
      // loop is sequential, one Details call per post otherwise)
      let d = null;
      try { d = await detailsCached(placeId); } catch (e) { d = null; }

      const photoRef = d?.photos?.[0]?.photo_reference || null;

      const friendSet = friendsByPlace.get(placeId) || new Set();
      const friendsCount = friendSet.size;

      // Preview 3 friends
      const previewIds = [...friendSet].slice(0, 3);
      const previewUsers = previewIds.length
        ? await prisma.user.findMany({
            where: { id: { in: previewIds } },
            select: { id: true, username: true, firstName: true, lastName: true },
          })
        : [];

      const friendsPreview = [];
      for (const u of previewUsers) {
        friendsPreview.push({
          id: u.id,
          username: u.username,
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
          avatar: await getUserAvatar(u.id),
        });
      }
const photos = buildPhotosArray(d, 8);
const image = photos[0] || '';

out.push({
  id: String(placeId),
  name: d?.name || last.placeName || '',
  address: d?.formatted_address || '',
  phone: d?.formatted_phone_number || d?.international_phone_number || '',
  website: d?.website || '',
  googleMapsUrl: d?.url || '',
  lat: d?.geometry?.location?.lat ?? last.latitude,
  lng: d?.geometry?.location?.lng ?? last.longitude,

  image,
  photos,

  category: 'Trending',
  priceLevel: d?.price_level ?? null,
  priceRange: priceLevelToRange(d?.price_level) || '',
  openNow: d?.opening_hours?.open_now ?? null,
  status: openNowToStatus(d?.opening_hours?.open_now),
  openingHours: d?.opening_hours?.weekday_text || [],

  rating: Number(d?.rating ?? 0),
  totalReviews: Number(d?.user_ratings_total ?? 0),
  businessStatus: d?.business_status || null,
  types: d?.types || [],
  // Details is already fetched above, so this costs nothing extra.
  accessible: d?.wheelchair_accessible_entrance === true,

  visitCount: g._count?.placeId || 0,     
  uniqueUsers: uniqueUsersMap.get(placeId)?.size || 0,
  pointsCollected: g._sum?.points || 0,
  distanceMiles: metersToMiles(dMeters),

  friendsCount,
  friendsPreview,
});

      if (out.length >= limit) break;
    }

    // ✅ Sort: points -> uniqueUsers -> visitCount -> distance
    out.sort((a, b) =>
      (b.pointsCollected || 0) - (a.pointsCollected || 0) ||
      (b.uniqueUsers || 0) - (a.uniqueUsers || 0) ||
      (b.visitCount || 0) - (a.visitCount || 0) ||
      (a.distanceMiles || 0) - (b.distanceMiles || 0)
    );

    return res.json({
      success: true,
      title: 'Top Trending',
      subtitle: 'Best of the week',
      since,
      radius,
      restaurants: out.slice(0, limit),
    });
  } catch (e) {
    console.error('getTopTrendingWeekRestaurants error', e);
    return res.status(500).json({ success: false, error: 'Failed to load trending week' });
  }
};

// ---------------------------------------------------------------------------
// Explore redesign — two feed sections the new design asks for.
//
// Both reuse the existing pipeline (LocationPoint for visits, detailsCached for
// Google data, getUserAvatar for minimes) and add no tables, so they ship on a
// plain deploy with no migration.
// ---------------------------------------------------------------------------

// Shared shaper so a redesign card looks identical whichever section served it.
// Mirrors the object getTopTrendingWeekRestaurants returns.
function buildSpotCard({ placeId, details: d, fallbackName, fallbackLat, fallbackLng, category, points, distanceMiles, friendsCount, friendsPreview }) {
  const photos = buildPhotosArray(d, 8);
  return {
    id: String(placeId),
    placeId: String(placeId),
    name: d?.name || fallbackName || '',
    address: d?.formatted_address || '',
    website: d?.website || '',
    googleMapsUrl: d?.url || '',
    lat: d?.geometry?.location?.lat ?? fallbackLat,
    lng: d?.geometry?.location?.lng ?? fallbackLng,

    image: photos[0] || '',
    photos,

    category,
    priceLevel: d?.price_level ?? null,
    priceRange: priceLevelToRange(d?.price_level) || '',
    openNow: d?.opening_hours?.open_now ?? null,
    status: openNowToStatus(d?.opening_hours?.open_now),
    openingHours: d?.opening_hours?.weekday_text || [],

    rating: Number(d?.rating ?? 0),
    totalReviews: Number(d?.user_ratings_total ?? 0),
    businessStatus: d?.business_status || null,
    types: d?.types || [],

    // Google exposes this on Details; the card renders a wheelchair glyph when
    // it's true and simply omits it otherwise.
    accessible: d?.wheelchair_accessible_entrance === true,

    points,
    distanceMiles,
    friendsCount,
    friendsPreview,
  };
}

// Resolve up to 3 friends per place into { id, username, name, avatar }.
async function previewFriends(friendIds) {
  const ids = [...friendIds].slice(0, 3);
  if (!ids.length) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, username: true, firstName: true, lastName: true },
  });
  const out = [];
  for (const u of users) {
    out.push({
      id: u.id,
      username: u.username,
      name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
      avatar: await getUserAvatar(u.id),
    });
  }
  return out;
}

// GET /api/explore/friends-visited?lat&lng&radius&limit&days
// "Spots Your Friends Visited Recently" — newest friend check-in first.
exports.getFriendsVisitedRecently = async (req, res) => {
  try {
    const userId = req.authData.id;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 16093;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;
    const days = req.query.days ? parseInt(req.query.days, 10) : 30;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ success: false, error: 'lat/lng required' });
    }

    const friendIds = await getFriendIds(userId);
    if (!friendIds.length) {
      return res.json({ success: true, title: 'Spots Your Friends Visited Recently', places: [] });
    }

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Newest first, so the first row seen for a placeId is its latest visit.
    // Over-fetch because the radius filter below drops far-away places.
    const visits = await prisma.locationPoint.findMany({
      where: {
        userId: { in: friendIds },
        createdAt: { gte: since },
        placeId: { not: null },
        latitude: { not: null },
        longitude: { not: null },
      },
      select: {
        placeId: true, userId: true, placeName: true,
        latitude: true, longitude: true, points: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit * 20,
    });

    const byPlace = new Map(); // placeId -> { latest, friends:Set, points }
    for (const v of visits) {
      let e = byPlace.get(v.placeId);
      if (!e) {
        e = { latest: v, friends: new Set(), points: v.points || 0 };
        byPlace.set(v.placeId, e);
      }
      e.friends.add(v.userId);
    }

    const here = { lat, lng };
    const out = [];

    for (const [placeId, e] of byPlace) {
      const dMeters = haversineMeters(here, { lat: e.latest.latitude, lng: e.latest.longitude });
      if (dMeters > radius) continue;

      let d = null;
      try { d = await detailsCached(placeId); } catch (_) { d = null; }

      out.push(buildSpotCard({
        placeId,
        details: d,
        fallbackName: e.latest.placeName,
        fallbackLat: e.latest.latitude,
        fallbackLng: e.latest.longitude,
        category: 'Visited',
        points: pointsForPlace({
          priceLevel: d?.price_level,
          userRatingsTotal: d?.user_ratings_total,
        }),
        distanceMiles: metersToMiles(dMeters),
        friendsCount: e.friends.size,
        friendsPreview: await previewFriends(e.friends),
      }));

      if (out.length >= limit) break;
    }

    return res.json({
      success: true,
      title: 'Spots Your Friends Visited Recently',
      since,
      radius,
      places: out,
    });
  } catch (e) {
    console.error('getFriendsVisitedRecently error', e);
    return res.status(500).json({ success: false, error: 'Failed to load friends-visited' });
  }
};

// GET /api/explore/points-boost?lat&lng&radius&limit
// "Spots to Boost Your Points" — nearby places worth the most points that the
// user hasn't checked in at yet.
//
// Candidates come from the same cached category buckets the rest of the feed
// uses, so on a warm cache this costs no extra Google calls.
exports.getPointsBoostSpots = async (req, res) => {
  try {
    const userId = req.authData.id;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = req.query.radius ? parseInt(req.query.radius, 10) : 16093;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ success: false, error: 'lat/lng required' });
    }

    // The buckets most likely to be warm already — restaurants and bars carry
    // the high price levels that drive the points formula.
    const buckets = ['restaurants', 'bars', 'cafes'];
    const seen = new Map(); // placeId -> mapped place

    for (const key of buckets) {
      const cat = findCat(key);
      if (!cat) continue;
      let candidates = [];
      try {
        candidates = await getCategoryCandidates({ cat, lat, lng, radius, requiredCount: 60 });
      } catch (e) {
        console.error(`getPointsBoostSpots: ${key} candidates failed`, e);
        continue;
      }
      for (const p of candidates) {
        if (!p?.place_id || seen.has(p.place_id)) continue;
        seen.set(p.place_id, mapPlace(p, lat, lng));
      }
    }

    if (!seen.size) {
      return res.json({ success: true, title: 'Spots to Boost Your Points', places: [] });
    }

    // Drop anywhere this user has already been — the point of the section is
    // somewhere new to earn at.
    const visited = await prisma.locationPoint.findMany({
      where: { userId, placeId: { in: [...seen.keys()] } },
      select: { placeId: true },
      distinct: ['placeId'],
    });
    for (const v of visited) seen.delete(v.placeId);

    const ranked = [...seen.values()]
      .filter(p => (p.points || 0) > 0)
      .sort((a, b) =>
        (b.points || 0) - (a.points || 0) ||
        (a.distanceMiles ?? 9e9) - (b.distanceMiles ?? 9e9)
      )
      .slice(0, limit);

    // Which friends have been to these, so the card's spotted-here row fills in.
    const friendIds = await getFriendIds(userId);
    const friendsByPlace = new Map();
    if (friendIds.length && ranked.length) {
      const friendVisits = await prisma.locationPoint.findMany({
        where: { userId: { in: friendIds }, placeId: { in: ranked.map(p => p.placeId) } },
        select: { placeId: true, userId: true },
      });
      for (const v of friendVisits) {
        if (!friendsByPlace.has(v.placeId)) friendsByPlace.set(v.placeId, new Set());
        friendsByPlace.get(v.placeId).add(v.userId);
      }
    }

    const places = [];
    for (const p of ranked) {
      const friendSet = friendsByPlace.get(p.placeId) || new Set();
      places.push({
        ...p,
        id: String(p.placeId),
        image: p.photoUrl || '',
        category: 'Points Boost',
        totalReviews: p.userRatingsTotal || 0,
        // mapPlace already carries this through from the search response.
        friendsCount: friendSet.size,
        friendsPreview: await previewFriends(friendSet),
      });
    }

    return res.json({
      success: true,
      title: 'Spots to Boost Your Points',
      radius,
      places,
    });
  } catch (e) {
    console.error('getPointsBoostSpots error', e);
    return res.status(500).json({ success: false, error: 'Failed to load points-boost' });
  }
};

// ---------------------------------------------------------------------------
// Saved places — the bookmark on a spot card and the Saved screen behind the
// top-bar icon.
//
// The table holds only placeId + name + coordinates. Photo, rating, price and
// opening hours are read back from Google through detailsCached, because a
// bookmark from three weeks ago must not show three-week-old opening hours.
// ---------------------------------------------------------------------------

// POST /api/explore/saved   { placeId, placeName?, latitude?, longitude? }
// Idempotent: saving an already-saved place succeeds and changes nothing.
exports.savePlace = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { placeId, placeName, latitude, longitude } = req.body || {};

    if (!placeId || typeof placeId !== 'string') {
      return res.status(400).json({ success: false, error: 'placeId required' });
    }

    const lat = latitude != null ? parseFloat(latitude) : null;
    const lng = longitude != null ? parseFloat(longitude) : null;

    const saved = await prisma.savedPlace.upsert({
      where: { userId_placeId: { userId, placeId } },
      // Refresh the cached name/coords in case Google renamed the place.
      update: {
        placeName: placeName || undefined,
        latitude: Number.isFinite(lat) ? lat : undefined,
        longitude: Number.isFinite(lng) ? lng : undefined,
      },
      create: {
        userId,
        placeId,
        placeName: placeName || null,
        latitude: Number.isFinite(lat) ? lat : null,
        longitude: Number.isFinite(lng) ? lng : null,
      },
    });

    return res.json({ success: true, saved: true, id: saved.id });
  } catch (e) {
    console.error('savePlace error', e);
    return res.status(500).json({ success: false, error: 'Failed to save place' });
  }
};

// DELETE /api/explore/saved/:placeId
// Also idempotent: un-saving something that isn't saved is a success.
exports.unsavePlace = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { placeId } = req.params;
    if (!placeId) {
      return res.status(400).json({ success: false, error: 'placeId required' });
    }

    await prisma.savedPlace.deleteMany({ where: { userId, placeId } });
    return res.json({ success: true, saved: false });
  } catch (e) {
    console.error('unsavePlace error', e);
    return res.status(500).json({ success: false, error: 'Failed to unsave place' });
  }
};

// GET /api/explore/saved/ids
// Just the ids, so the feed can mark bookmarks without pulling Google details
// for every card. Cheap enough to call on every Explore open.
exports.getSavedPlaceIds = async (req, res) => {
  try {
    const userId = req.authData.id;
    const rows = await prisma.savedPlace.findMany({
      where: { userId },
      select: { placeId: true },
    });
    return res.json({ success: true, placeIds: rows.map(r => r.placeId) });
  } catch (e) {
    console.error('getSavedPlaceIds error', e);
    return res.status(500).json({ success: false, error: 'Failed to load saved ids' });
  }
};

// GET /api/explore/saved?lat&lng&limit
// The Saved screen: full cards, newest bookmark first.
exports.getSavedPlaces = async (req, res) => {
  try {
    const userId = req.authData.id;
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const hasHere = Number.isFinite(lat) && Number.isFinite(lng);

    const rows = await prisma.savedPlace.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    if (!rows.length) {
      return res.json({ success: true, title: 'Saved Spots', places: [] });
    }

    // Which friends have been to these, so the card's spotted-here row fills in.
    const friendIds = await getFriendIds(userId);
    const friendsByPlace = new Map();
    if (friendIds.length) {
      const visits = await prisma.locationPoint.findMany({
        where: { userId: { in: friendIds }, placeId: { in: rows.map(r => r.placeId) } },
        select: { placeId: true, userId: true },
      });
      for (const v of visits) {
        if (!friendsByPlace.has(v.placeId)) friendsByPlace.set(v.placeId, new Set());
        friendsByPlace.get(v.placeId).add(v.userId);
      }
    }

    const places = [];
    for (const row of rows) {
      let d = null;
      try { d = await detailsCached(row.placeId); } catch (_) { d = null; }

      const placeLat = d?.geometry?.location?.lat ?? row.latitude;
      const placeLng = d?.geometry?.location?.lng ?? row.longitude;
      const distanceMiles =
        hasHere && Number.isFinite(placeLat) && Number.isFinite(placeLng)
          ? metersToMiles(haversineMeters({ lat, lng }, { lat: placeLat, lng: placeLng }))
          : null;

      const friendSet = friendsByPlace.get(row.placeId) || new Set();

      places.push(buildSpotCard({
        placeId: row.placeId,
        details: d,
        fallbackName: row.placeName,
        fallbackLat: row.latitude,
        fallbackLng: row.longitude,
        category: 'Saved',
        points: pointsForPlace({
          priceLevel: d?.price_level,
          userRatingsTotal: d?.user_ratings_total,
        }),
        distanceMiles,
        friendsCount: friendSet.size,
        friendsPreview: await previewFriends(friendSet),
      }));
    }

    return res.json({ success: true, title: 'Saved Spots', places });
  } catch (e) {
    console.error('getSavedPlaces error', e);
    return res.status(500).json({ success: false, error: 'Failed to load saved places' });
  }
};

// ---------------------------------------------------------------------------
// Explore search history.
//
// Stored per user rather than on the device so it survives a reinstall. Only
// the typed phrase is kept — results go stale, and re-running the search live
// is both fresher and cheaper than caching places nobody may revisit.
// ---------------------------------------------------------------------------

/// Longest phrase worth keeping. The column is VARCHAR(191); anything past
/// that is a paste accident, not a search.
const SEARCH_HISTORY_MAX_LEN = 100;

/// How many entries a user's history holds before the oldest fall off.
const SEARCH_HISTORY_KEEP = 20;

// GET /api/explore/search-history
exports.getSearchHistory = async (req, res) => {
  try {
    const userId = req.authData.id;
    const rows = await prisma.searchHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: SEARCH_HISTORY_KEEP,
      select: { id: true, query: true, createdAt: true },
    });
    return res.json({ success: true, history: rows });
  } catch (e) {
    console.error('getSearchHistory error', e);
    return res.status(500).json({ success: false, error: 'Failed to load history' });
  }
};

// POST /api/explore/search-history   { query }
// Re-searching an existing phrase bumps it to the top rather than duplicating.
exports.addSearchHistory = async (req, res) => {
  try {
    const userId = req.authData.id;
    const raw = (req.body?.query ?? '').toString().trim();
    if (!raw) {
      return res.status(400).json({ success: false, error: 'query required' });
    }
    const query = raw.slice(0, SEARCH_HISTORY_MAX_LEN);

    const row = await prisma.searchHistory.upsert({
      where: { userId_query: { userId, query } },
      update: { createdAt: new Date() },
      create: { userId, query },
    });

    // Trim the tail so the table can't grow without bound per user.
    const stale = await prisma.searchHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: SEARCH_HISTORY_KEEP,
      select: { id: true },
    });
    if (stale.length) {
      await prisma.searchHistory.deleteMany({
        where: { id: { in: stale.map(s => s.id) } },
      });
    }

    return res.json({ success: true, id: row.id, query: row.query });
  } catch (e) {
    console.error('addSearchHistory error', e);
    return res.status(500).json({ success: false, error: 'Failed to save history' });
  }
};

// DELETE /api/explore/search-history/:id — one entry.
// Scoped to the caller, so an id from another account matches nothing.
exports.deleteSearchHistory = async (req, res) => {
  try {
    const userId = req.authData.id;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'bad id' });
    }
    await prisma.searchHistory.deleteMany({ where: { id, userId } });
    return res.json({ success: true });
  } catch (e) {
    console.error('deleteSearchHistory error', e);
    return res.status(500).json({ success: false, error: 'Failed to delete entry' });
  }
};

// DELETE /api/explore/search-history — clear all.
exports.clearSearchHistory = async (req, res) => {
  try {
    const userId = req.authData.id;
    const { count } = await prisma.searchHistory.deleteMany({ where: { userId } });
    return res.json({ success: true, cleared: count });
  } catch (e) {
    console.error('clearSearchHistory error', e);
    return res.status(500).json({ success: false, error: 'Failed to clear history' });
  }
};
