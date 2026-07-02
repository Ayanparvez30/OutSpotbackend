// utils/dwellTime.js
// -----------------------------------------------------------------------------
// Turn a user's raw LocationHistory trail (lat/lng pings with timestamps) into
// "dwell sessions" — i.e. "stayed near point X from arrivedAt to leftAt".
//
// The app sends a location ping only while it's in the foreground (and throttled
// to ~10–50m of movement), so this is a best-effort inference, not exact GPS
// dwell. A truly stationary user who sends a single ping can't yield a duration
// and is dropped as noise. No DB, no schema change — pure computation over rows
// the admin controller already has.
// -----------------------------------------------------------------------------

const EARTH_M = 6371000; // mean earth radius, metres

// Great-circle distance between two lat/lng points, in metres.
function haversineMeters(aLat, aLng, bLat, bLng) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

/**
 * Group an ordered ping list into dwell sessions.
 *
 * A session is a run of consecutive pings that all stay within `radiusM` of the
 * session's anchor (its first ping). The first ping that jumps beyond the radius
 * closes the current session and opens a new one. Sessions that are a single
 * ping or shorter than `minMinutes` are dropped as pass-through noise.
 *
 * @param {Array<{latitude:number, longitude:number, createdAt:Date|string}>} pings
 *        Ordered by createdAt ASCENDING.
 * @param {{radiusM?:number, minMinutes?:number}} [opts]
 * @returns {Array<{latitude:number, longitude:number, arrivedAt:Date, leftAt:Date,
 *                  dwellMs:number, dwellMinutes:number, pings:number}>}
 */
function computeDwellSessions(pings, opts = {}) {
  const radiusM = opts.radiusM ?? 150;
  const minMinutes = opts.minMinutes ?? 5;

  const sessions = [];
  let cur = null;

  for (const p of pings) {
    const lat = Number(p.latitude);
    const lng = Number(p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const t = p.createdAt instanceof Date ? p.createdAt : new Date(p.createdAt);
    if (Number.isNaN(t.getTime())) continue;

    if (!cur) {
      cur = { latSum: lat, lngSum: lng, anchorLat: lat, anchorLng: lng, arrivedAt: t, leftAt: t, pings: 1 };
      continue;
    }

    const dist = haversineMeters(cur.anchorLat, cur.anchorLng, lat, lng);
    if (dist <= radiusM) {
      // still around the same anchor — extend the session
      cur.latSum += lat;
      cur.lngSum += lng;
      cur.pings += 1;
      cur.leftAt = t;
    } else {
      // moved away — close this session, start a fresh one anchored here
      sessions.push(cur);
      cur = { latSum: lat, lngSum: lng, anchorLat: lat, anchorLng: lng, arrivedAt: t, leftAt: t, pings: 1 };
    }
  }
  if (cur) sessions.push(cur);

  return sessions
    .map((s) => {
      const dwellMs = s.leftAt.getTime() - s.arrivedAt.getTime();
      return {
        // centroid of the cluster — used for display + reverse geocoding
        latitude: s.latSum / s.pings,
        longitude: s.lngSum / s.pings,
        arrivedAt: s.arrivedAt,
        leftAt: s.leftAt,
        dwellMs,
        dwellMinutes: Math.round(dwellMs / 60000),
        pings: s.pings,
      };
    })
    .filter((s) => s.pings >= 2 && s.dwellMinutes >= minMinutes);
}

module.exports = { computeDwellSessions, haversineMeters };
