const { metresBetween } = require('./venueGeofence');

/// "Could this person actually have got here from where they last were?"
///
/// Every other location check in the app reads a number the phone sent, and a
/// caller who is writing their own requests simply sends whatever passes. The
/// `isMocked` flag is the clearest case: the test is `if (isMocked === true)`,
/// so a script sends `false`. Coordinates are the same — the server has no
/// independent way to know where a phone is, and it never will.
///
/// This check is different in kind, and that is the whole point of it. It
/// compares the claimed position against **the server's own record** of where
/// that user checked in last. An attacker can lie about where they are now, but
/// they cannot go back and change where the server already saw them, so the two
/// claims have to be consistent with each other — and a farmer sweeping places
/// across a city, or scripting from a laptop, produces jumps no human makes.
///
/// It is a detector, not a wall. It does not stop the person genuinely standing
/// in the mall. It stops the much larger attack: check-ins from anywhere on
/// earth, with no travel in between.

/// Fastest a person plausibly moves between two check-ins, in metres/second.
/// 900 km/h — a cruising airliner, plus slack. Anything above this is not a
/// journey, and the number is deliberately absurd so that no real traveller,
/// however fast, is ever caught by it.
const MAX_SPEED_MPS = 250;

/// Below this, don't judge. Two check-ins in the same building are 0m apart and
/// would divide to an infinite implied speed; short hops are the normal case
/// and are policed by the cooldown and the same-cluster rules instead.
const MIN_DISTANCE_METERS = 500;

/// GPS is noisy and clocks drift. Treat any gap shorter than this as this long,
/// so a pair of check-ins seconds apart can't produce a wild speed.
const MIN_ELAPSED_SECONDS = 30;

/// Judges a claimed position against the user's previous check-in.
///
/// Returns `{ plausible, ... }`. `plausible` is true whenever there is nothing
/// to compare against — a first-ever check-in, or a previous one with no
/// coordinates — because absence of evidence must never reject an honest user.
function assessTravel({ previous, lat, lng, at = new Date() }) {
  if (!previous || previous.latitude == null || previous.longitude == null) {
    return { plausible: true, reason: 'no-previous' };
  }

  const distance = metresBetween(
    { lat: previous.latitude, lng: previous.longitude },
    { lat, lng },
  );
  if (distance < MIN_DISTANCE_METERS) {
    return { plausible: true, reason: 'too-close-to-judge', distance };
  }

  const elapsed = Math.max(
    MIN_ELAPSED_SECONDS,
    (at.getTime() - new Date(previous.createdAt).getTime()) / 1000,
  );
  const speedMps = distance / elapsed;

  return {
    plausible: speedMps <= MAX_SPEED_MPS,
    reason: speedMps <= MAX_SPEED_MPS ? 'ok' : 'impossible-travel',
    distance: Math.round(distance),
    elapsedSeconds: Math.round(elapsed),
    speedKmh: Math.round(speedMps * 3.6),
  };
}

module.exports = {
  assessTravel,
  MAX_SPEED_MPS,
  MIN_DISTANCE_METERS,
  MIN_ELAPSED_SECONDS,
};
