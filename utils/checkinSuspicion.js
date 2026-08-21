const { PrismaClient } = require('@prisma/client');
const { metresBetween } = require('./venueGeofence');
const { assessTravel } = require('./travelPlausibility');

const prisma = new PrismaClient();

/// Finding check-ins that look wrong, from what the server already stored.
///
/// Everything here reads `LocationPoint` rows the server wrote itself, so none
/// of it can be influenced by what a caller claims in a request. That is the
/// whole reason these particular signals were chosen over the tempting ones: a
/// spoofer picks their own coordinates, but they cannot go back and change the
/// trail those choices left behind.
///
/// This is a report, not a gate. Nothing here rejects a check-in or takes points
/// automatically — an admin looks and decides. Rules that punish on suspicion
/// alone would hit honest people in exactly the places honest use concentrates:
/// a family eating twice in the same mall is the normal case in Dhaka, not the
/// fraud case.

/// Two check-ins closer than this are treated as the same building. Sized for a
/// shopping centre footprint rather than a single shopfront, because that is the
/// thing being farmed.
const BUILDING_CLUSTER_METERS = 60;

/// How many distinct places in one building, in one day, before it is worth an
/// admin's attention. Two is an ordinary lunch-then-coffee. Four is not.
const CLUSTER_ALERT_COUNT = 4;

const DAY_MS = 24 * 60 * 60 * 1000;

/// Groups a user's check-ins into buildings by simple proximity chaining.
///
/// Deliberately not clustering on Google's `formatted_address`: addresses for
/// the same Dhaka building are wildly inconsistent ("Level 4, Jamuna Future
/// Park" and "Ka-244, Kuril, Progoti Sarani" are the same place), so string
/// matching would both over-merge and under-merge exactly where it matters.
/// Coordinates do not have that problem.
function clusterByProximity(points) {
  const clusters = [];
  for (const p of points) {
    if (p.latitude == null || p.longitude == null) continue;
    const home = clusters.find((c) =>
      c.points.some(
        (q) =>
          metresBetween(
            { lat: q.latitude, lng: q.longitude },
            { lat: p.latitude, lng: p.longitude },
          ) <= BUILDING_CLUSTER_METERS,
      ),
    );
    if (home) home.points.push(p);
    else clusters.push({ points: [p] });
  }
  return clusters;
}

/// Users who checked into several *different* places inside one building within
/// a day — the mall-farming pattern the client reported.
async function findClusterFarming({ since, alertCount = CLUSTER_ALERT_COUNT }) {
  const rows = await prisma.locationPoint.findMany({
    where: {
      createdAt: { gte: since },
      latitude: { not: null },
      longitude: { not: null },
      // Reversed check-ins are zeroed rather than deleted; they have already
      // been dealt with and should not keep resurfacing.
      points: { gt: 0 },
    },
    select: {
      id: true,
      userId: true,
      placeId: true,
      placeName: true,
      latitude: true,
      longitude: true,
      points: true,
      createdAt: true,
      user: { select: { id: true, username: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, []);
    byUser.get(r.userId).push(r);
  }

  const findings = [];
  for (const [userId, points] of byUser) {
    for (const cluster of clusterByProximity(points)) {
      // Distinct *places*, not distinct check-ins: going back to the same cafe
      // twice is not the pattern, and the cooldown already governs that.
      const distinct = new Set(cluster.points.map((p) => p.placeId).filter(Boolean));
      if (distinct.size < alertCount) continue;

      const first = cluster.points[0];
      const last = cluster.points[cluster.points.length - 1];
      const spanMs = new Date(last.createdAt) - new Date(first.createdAt);
      if (spanMs > DAY_MS) continue;

      findings.push({
        kind: 'cluster-farming',
        userId,
        user: first.user,
        placeCount: distinct.size,
        checkInCount: cluster.points.length,
        pointsAwarded: cluster.points.reduce((sum, p) => sum + (p.points || 0), 0),
        spanHours: Math.max(1, Math.round(spanMs / 3600000)),
        where: first.placeName || `${first.latitude.toFixed(4)}, ${first.longitude.toFixed(4)}`,
        at: last.createdAt,
        checkInIds: cluster.points.map((p) => p.id),
        detail:
          `${distinct.size} different places in one building within ` +
          `${Math.max(1, Math.round(spanMs / 3600000))}h`,
      });
    }
  }
  return findings;
}

/// Consecutive check-ins no journey could connect.
///
/// New check-ins are refused outright now, so anything found here either
/// predates that or came in through a path that does not run the check —
/// which is itself worth seeing.
async function findImpossibleTravel({ since }) {
  const rows = await prisma.locationPoint.findMany({
    where: {
      createdAt: { gte: since },
      latitude: { not: null },
      longitude: { not: null },
      points: { gt: 0 },
    },
    select: {
      id: true,
      userId: true,
      placeName: true,
      latitude: true,
      longitude: true,
      points: true,
      createdAt: true,
      user: { select: { id: true, username: true, firstName: true, lastName: true } },
    },
    orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
  });

  const findings = [];
  let previous = null;
  for (const r of rows) {
    if (!previous || previous.userId !== r.userId) {
      previous = r;
      continue;
    }
    const travel = assessTravel({
      previous,
      lat: r.latitude,
      lng: r.longitude,
      at: new Date(r.createdAt),
    });
    if (!travel.plausible) {
      findings.push({
        kind: 'impossible-travel',
        userId: r.userId,
        user: r.user,
        pointsAwarded: r.points || 0,
        where: r.placeName || `${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)}`,
        at: r.createdAt,
        checkInIds: [r.id],
        detail: `${Math.round(travel.distance / 1000)}km in ${Math.round(travel.elapsedSeconds / 60)}min — ${travel.speedKmh} km/h`,
      });
    }
    previous = r;
  }
  return findings;
}

/// The same photo submitted for more than one check-in.
///
/// A genuine capture is a new file on every check-in and gets its own random S3
/// key, so a repeated URL means the same image was submitted twice — which the
/// app cannot do by accident.
async function findReusedPhotos({ since }) {
  const rows = await prisma.locationPoint.groupBy({
    by: ['mediaUrl'],
    where: { createdAt: { gte: since }, mediaUrl: { not: '' }, points: { gt: 0 } },
    _count: { mediaUrl: true },
    having: { mediaUrl: { _count: { gt: 1 } } },
  });
  if (!rows.length) return [];

  const urls = rows.map((r) => r.mediaUrl);
  const points = await prisma.locationPoint.findMany({
    where: { mediaUrl: { in: urls }, createdAt: { gte: since } },
    select: {
      id: true,
      userId: true,
      mediaUrl: true,
      placeName: true,
      points: true,
      createdAt: true,
      user: { select: { id: true, username: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const byUrl = new Map();
  for (const p of points) {
    if (!byUrl.has(p.mediaUrl)) byUrl.set(p.mediaUrl, []);
    byUrl.get(p.mediaUrl).push(p);
  }

  return [...byUrl.values()]
    // The same person reusing a photo is the signal; the same URL across two
    // different users would mean something stranger and is worth seeing too.
    .map((group) => ({
      kind: 'reused-photo',
      userId: group[0].userId,
      user: group[0].user,
      pointsAwarded: group.reduce((sum, p) => sum + (p.points || 0), 0),
      where: group[0].placeName || '—',
      at: group[0].createdAt,
      checkInIds: group.map((p) => p.id),
      mediaUrl: group[0].mediaUrl,
      detail: `the same photo used for ${group.length} check-ins`,
    }));
}

/// Everything worth an admin's attention, newest first.
async function findSuspiciousCheckIns({ days = 7, limit = 20 } = {}) {
  const since = new Date(Date.now() - days * DAY_MS);
  try {
    const [clusters, travel, photos] = await Promise.all([
      findClusterFarming({ since }),
      findImpossibleTravel({ since }),
      findReusedPhotos({ since }),
    ]);
    return [...clusters, ...travel, ...photos]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, limit);
  } catch (e) {
    // The dashboard must render even if this half fails.
    console.error('findSuspiciousCheckIns failed', e);
    return [];
  }
}

module.exports = {
  findSuspiciousCheckIns,
  findClusterFarming,
  findImpossibleTravel,
  findReusedPhotos,
  clusterByProximity,
  BUILDING_CLUSTER_METERS,
  CLUSTER_ALERT_COUNT,
};
