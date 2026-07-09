// Dedupe visited-spot rows for profile stats and lists.
//
// Root causes this handles:
//   1. Same physical place stamped sometimes with placeId, sometimes without —
//      groups by placeId first, then merges nearby coord-only rows into any
//      place-key spot within COORD_MERGE_METERS.
//   2. GPS drift on coord-only visits — buckets by ~11m grid (toFixed(4))
//      instead of ~1m (toFixed(5)), so two check-ins standing 5m apart collapse.
//   3. Empty / null mediaUrl on the newest visit — promotes any older visit's
//      non-empty mediaUrl into the representative so the profile circle always
//      shows a photo if the user ever uploaded one for that place.
//
// Input rows must be pre-sorted `createdAt` desc.

const { haversineMeters } = require('./placeDistance');

const COORD_PRECISION = 4;          // ~11m grid; was 5 (~1m) → GPS-drift dupes
const COORD_MERGE_METERS = 50;      // coord-key merges into place-key within this radius

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function coordKey(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `coord:${lat.toFixed(COORD_PRECISION)},${lng.toFixed(COORD_PRECISION)}`;
}

function inferPlaceType(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  if (/rooftop/.test(n)) return 'Rooftop Bars';
  if (/cafe|coffee|bakery|patisserie/.test(n)) return 'Cafes';
  if (/bar|pub|lounge|tavern/.test(n)) return 'Rooftop Bars';
  if (/restaurant|grill|bistro|diner|eatery|kitchen|food/.test(n)) return 'Popular Restaurants';
  if (/park|garden|trail|nature|outdoor|reserve|forest/.test(n)) return 'Outdoor Activities';
  if (/concert|venue|theater|theatre|arena|stadium|event/.test(n)) return 'Venue Events';
  return null;
}

// Group + dedupe visited-spot rows.
//   rows: [{ id?, placeId, placeName, placeType, latitude, longitude,
//            mediaUrl, points, createdAt }, ...]   (desc order)
// Returns: [{ placeId, placeName, placeType, latitude, longitude, mediaUrl,
//             firstVisitedAt, lastVisitedAt, visitCount, totalPoints }, ...]
function dedupeVisitedSpots(rows) {
  const map = new Map();
  const list = rows || [];

  // Pre-pass: collect one lat/lng anchor per placeId from ALL rows so the
  // coord→place merge is order-independent. Without this the merge only saw
  // place-keys processed earlier in the DESC pass, missing the case where the
  // newest visit for a place was coord-only and an older visit had the
  // placeId. Prefer the first (newest) lat/lng we see for that placeId.
  const placeKeyList = [];
  const seenPlaceIds = new Set();
  for (const p of list) {
    if (!isNonEmptyString(p.placeId)) continue;
    if (seenPlaceIds.has(p.placeId)) continue;
    seenPlaceIds.add(p.placeId);
    if (Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
      placeKeyList.push({ key: `place:${p.placeId}`, latitude: p.latitude, longitude: p.longitude });
    }
  }

  for (const p of list) {
    const hasPlace = isNonEmptyString(p.placeId);
    let key;

    if (hasPlace) {
      key = `place:${p.placeId}`;
    } else {
      // Coord-only row: if lat/lng is close to any place-key spot in this
      // dataset, fold it in there. Otherwise fall back to the coarser coord
      // bucket. Order-independent via placeKeyList built pre-pass.
      let mergedInto = null;
      if (Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
        for (const pk of placeKeyList) {
          const d = haversineMeters(
            { lat: p.latitude, lng: p.longitude },
            { lat: pk.latitude, lng: pk.longitude },
          );
          if (d <= COORD_MERGE_METERS) { mergedInto = pk.key; break; }
        }
      }
      key = mergedInto || coordKey(p.latitude, p.longitude);
      if (!key) continue; // unusable row (no placeId, no coords)
    }

    if (!map.has(key)) {
      map.set(key, {
        placeId: p.placeId || null,
        placeName: p.placeName || null,
        placeType: p.placeType || inferPlaceType(p.placeName),
        latitude: p.latitude,
        longitude: p.longitude,
        mediaUrl: isNonEmptyString(p.mediaUrl) ? p.mediaUrl : null,
        firstVisitedAt: p.createdAt,
        lastVisitedAt: p.createdAt,
        visitCount: 1,
        totalPoints: p.points || 0,
      });
      if (hasPlace) placeKeyList.push({ key, latitude: p.latitude, longitude: p.longitude });
    } else {
      const existing = map.get(key);
      existing.visitCount += 1;
      existing.totalPoints += p.points || 0;
      // desc order → this row is older
      existing.firstVisitedAt = p.createdAt;
      if (!existing.placeType) {
        existing.placeType = p.placeType || inferPlaceType(p.placeName);
      }
      // Promote non-empty mediaUrl from any older visit if the representative
      // (newest) had none. Fixes empty-circle issue on profile stats.
      if (!existing.mediaUrl && isNonEmptyString(p.mediaUrl)) {
        existing.mediaUrl = p.mediaUrl;
      }
      // Backfill placeId / name / coords onto a coord-only representative when
      // a later (older) row does have them.
      if (!existing.placeId && isNonEmptyString(p.placeId)) existing.placeId = p.placeId;
      if (!existing.placeName && isNonEmptyString(p.placeName)) existing.placeName = p.placeName;
      if (!Number.isFinite(existing.latitude) && Number.isFinite(p.latitude)) existing.latitude = p.latitude;
      if (!Number.isFinite(existing.longitude) && Number.isFinite(p.longitude)) existing.longitude = p.longitude;
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => new Date(b.lastVisitedAt) - new Date(a.lastVisitedAt),
  );
}

module.exports = {
  dedupeVisitedSpots,
  inferPlaceType,
  COORD_PRECISION,
  COORD_MERGE_METERS,
};
