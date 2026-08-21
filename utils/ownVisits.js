const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/// "Have I been here myself?"
///
/// The spot cards carry a line about who has been to a place, and it was built
/// only from the user's *friends* — `getFriendIds` deliberately excludes the
/// person asking, since nobody is their own friend. So someone who had checked
/// in ten times still read "Be the first of your friends to be spotted here",
/// which is both wrong and slightly insulting.
///
/// This answers the missing half. It stays separate from the friends list on
/// purpose: folding the user into `friendIds` would put their own face in the
/// row of friend avatars and quietly inflate every count by one.
///
/// No schema change — `LocationPoint` already has `userId` and `placeId`, and
/// the `[userId, placeId, createdAt]` index already exists for the duplicate
/// check-in guard, so this rides on it.

/// Which of [placeIds] this user has checked into, as a Set.
///
/// One query for the whole page rather than one per card: a feed of twenty
/// cards asking individually would be twenty round trips for a question the
/// database can answer once.
///
/// Returns an empty Set when there is no user (a logged-out or unknown caller)
/// or nothing to look up, so callers never need to guard.
async function visitedPlaceIds(userId, placeIds) {
  if (!userId || !Array.isArray(placeIds) || placeIds.length === 0) {
    return new Set();
  }

  const ids = [...new Set(placeIds.filter(Boolean).map(String))];
  if (!ids.length) return new Set();

  try {
    const rows = await prisma.locationPoint.findMany({
      where: { userId, placeId: { in: ids } },
      select: { placeId: true },
      distinct: ['placeId'],
    });
    return new Set(rows.map((r) => r.placeId));
  } catch (e) {
    // A card that can't answer this should still render — it simply falls back
    // to the friends-only line, which is what it showed before.
    console.error('visitedPlaceIds failed', e);
    return new Set();
  }
}

/// The single-place form, for the detail screen.
async function hasVisited(userId, placeId) {
  const set = await visitedPlaceIds(userId, [placeId]);
  return set.has(String(placeId));
}

module.exports = { visitedPlaceIds, hasVisited };
