// utils/reverseGeocode.js
// -----------------------------------------------------------------------------
// lat/lng -> city name via Google Geocoding API. Results are cached in-memory
// (keyed by coords rounded to ~110m) so the same location isn't re-fetched on
// every admin page load. No DB, no new env var — reuses GOOGLE_MAPS_API_KEY.
//
// NOTE: the Geocoding API must be ENABLED on that key in Google Cloud. If it
// isn't (or any call fails), cityFromLatLng() returns null and the caller falls
// back to coordinates — it never throws.
// -----------------------------------------------------------------------------

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

// coordsKey -> city string | null. Cities don't move, so entries are kept for
// the process lifetime; a soft cap prevents unbounded growth.
const _cache = new Map();
const _inFlight = new Map();
const MAX_CACHE = 5000;

function _key(lat, lng) {
  // 3 decimals ≈ 110m — close reads share one cache slot / one API call.
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

// Pick the most "city-like" component from a geocode result.
function _pickCity(results) {
  const wanted = ['locality', 'postal_town', 'administrative_area_level_2', 'administrative_area_level_1'];
  for (const type of wanted) {
    for (const r of results || []) {
      const comp = (r.address_components || []).find(c => (c.types || []).includes(type));
      if (comp && comp.long_name) return comp.long_name;
    }
  }
  return null;
}

async function cityFromLatLng(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const key = _key(lat, lng);
  if (_cache.has(key)) return _cache.get(key);
  if (_inFlight.has(key)) return _inFlight.get(key);

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const promise = (async () => {
    try {
      const url = `${GEOCODE_URL}?latlng=${lat},${lng}&result_type=locality|administrative_area_level_2|administrative_area_level_1&key=${apiKey}`;
      const r = await fetch(url);
      const data = await r.json();
      const city = data.status === 'OK' ? _pickCity(data.results) : null;

      if (_cache.size >= MAX_CACHE) _cache.clear(); // crude evict — fine for admin use
      _cache.set(key, city);
      return city;
    } catch (e) {
      console.error('reverseGeocode error', e.message);
      return null; // do not cache transient failures
    } finally {
      _inFlight.delete(key);
    }
  })();

  _inFlight.set(key, promise);
  return promise;
}

module.exports = { cityFromLatLng };
