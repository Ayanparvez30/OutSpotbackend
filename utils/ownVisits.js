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

/// The face to draw for a user — the same rule the rest of the app already uses.
///
/// "Latest" means the most recently *touched* saved minime, not the most
/// recently generated one: picking one out of the locker bumps its `updatedAt`
/// (`userController.selectMinime`) precisely so it sorts first here. Every
/// profile, chat header, admin list and friend avatar orders by `updatedAt desc`
/// over `isSaved: true`, so a user's face on a spot card is the same face they
/// see everywhere else, and changing it changes all of them at once.
///
/// `selfieUrl` is the fallback for an account whose minime was saved before an
/// avatar was generated for it.
///
/// The caller fetches this once per page and passes it down rather than each
/// card asking: a feed of twenty cards would otherwise repeat one question
/// twenty times.
async function latestAvatar(userId) {
  if (!userId) return null;
  try {
    const m = await prisma.minime.findFirst({
      where: { userId, isSaved: true },
      select: { avatarUrl: true, selfieUrl: true },
      orderBy: { updatedAt: 'desc' },
    });
    return m?.avatarUrl || m?.selfieUrl || null;
  } catch (e) {
    // A missing avatar is a blank circle, not a broken card.
    console.error('latestAvatar failed', e);
    return null;
  }
}

module.exports = { visitedPlaceIds, hasVisited, latestAvatar };
