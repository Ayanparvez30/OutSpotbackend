/// Reading the two vertical signals a phone might offer, safely.
///
/// GPS has no useful vertical resolution, so nothing in the check-in flow can
/// tell floor 2 from floor 5 in a mall. These are the only two signals that
/// bear on it at all, and both are partial:
///
///  * **`floor`** — iOS only, and only inside venues Apple has surveyed
///    (mostly large US malls and airports). Where present it is authoritative:
///    Core Location gives the actual floor index, no arithmetic needed.
///  * **`pressureHpa`** — a barometer reading. Only ~5% of Android models have
///    one; most iPhones do. On its own it cannot name a floor: consecutive
///    floors are ~0.3-0.4 hPa apart, and weather plus air conditioning move the
///    reading further than that across a day. It becomes useful only when
///    compared against another reading from the same building at the same time.
///
/// So neither is a gate. Both are recorded, and the admin dashboard shows what
/// they imply. The decision about whether to act on them comes later, when
/// there are enough rows to say how often they actually arrive.
///
/// Everything here is client-supplied and therefore forgeable, exactly like the
/// coordinates. That is fine for a signal an admin reads; it would not be fine
/// for a rule that rejects.

/// Believable range for a floor index. Deep basements and tall towers both
/// exist; anything outside this is a typo or a lie, and is dropped rather than
/// stored as noise.
const MIN_FLOOR = -20;
const MAX_FLOOR = 200;

/// Sea-level pressure sits near 1013 hPa. The range below spans roughly the
/// Dead Sea to the top of a very tall building in a deep storm — wide enough
/// that no honest reading is discarded, narrow enough to reject nonsense.
const MIN_HPA = 800;
const MAX_HPA = 1100;

/// Pulls the vertical fields out of a request body, or null where absent or
/// implausible. Never throws: a malformed value must not cost someone a
/// check-in they earned.
function readVerticalHint(body = {}) {
  let floor = null;
  const rawFloor = body.floor;
  if (rawFloor !== undefined && rawFloor !== null && rawFloor !== '') {
    const n = parseInt(rawFloor, 10);
    if (Number.isFinite(n) && n >= MIN_FLOOR && n <= MAX_FLOOR) floor = n;
  }

  let pressureHpa = null;
  const rawPressure = body.pressureHpa ?? body.pressure;
  if (rawPressure !== undefined && rawPressure !== null && rawPressure !== '') {
    const n = Number(rawPressure);
    if (Number.isFinite(n) && n >= MIN_HPA && n <= MAX_HPA) {
      // One decimal is the precision a phone barometer actually has (±0.1 hPa);
      // storing more would imply an accuracy that isn't there.
      pressureHpa = Math.round(n * 10) / 10;
    }
  }

  return { floor, pressureHpa };
}

/// Rough height difference, in metres, between two pressure readings.
///
/// ~0.12 hPa per metre near sea level. Only meaningful between two readings
/// taken close together in time — across hours the weather moves more than a
/// storey, which is the whole reason this is a hint and not an answer.
function metresBetweenPressures(hpaA, hpaB) {
  if (!Number.isFinite(hpaA) || !Number.isFinite(hpaB)) return null;
  return (hpaA - hpaB) / 0.12;
}

module.exports = {
  readVerticalHint,
  metresBetweenPressures,
  MIN_FLOOR,
  MAX_FLOOR,
  MIN_HPA,
  MAX_HPA,
};
