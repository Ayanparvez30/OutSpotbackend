const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/* ------------------------ week helpers ------------------------ */
// Mirrors controllers/leaderboardController.js so the admin numbers match the
// app's weekly window exactly (Mon 00:00 local — TZ is America/New_York).
function getStartOfWeek() {
  const now = new Date();
  const day = now.getDay(); // Sun=0, Mon=1
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function weekLabel(weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return `${fmt(weekStart)} → ${fmt(weekEnd)}`;
}

const firstAvatar = (minimeArr) =>
  Array.isArray(minimeArr) && minimeArr.length > 0
    ? (minimeArr[0]?.avatarUrl || null)
    : null;

/* Build a Map<userId, weeklyPoints> for the given member ids. */
async function weeklyTotalsMap(userIds, weekStart) {
  if (!userIds.length) return new Map();
  const rows = await prisma.pointsLedger.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds }, createdAt: { gte: weekStart } },
    _sum: { finalPoints: true },
  });
  return new Map(rows.map((r) => [r.userId, Number(r._sum.finalPoints || 0)]));
}

/* ------------------------ community ranking (index) ------------------------ */
// All communities ranked by all-time total points, showing weekly points too.
exports.listCommunityLeaderboard = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 20;
    const weekStart = getStartOfWeek();

    const communities = await prisma.community.findMany({
      select: {
        id: true,
        name: true,
        imageUrl: true,
        creator: { select: { id: true, username: true } },
        members: { select: { userId: true } },
        _count: { select: { members: true } },
      },
    });

    const allUserIds = Array.from(
      new Set(communities.flatMap((c) => c.members.map((m) => m.userId)))
    );

    // Weekly (this week, from the ledger) + all-time (User.totalPoints) per member.
    const [weeklyMap, users] = await Promise.all([
      weeklyTotalsMap(allUserIds, weekStart),
      allUserIds.length
        ? prisma.user.findMany({
            where: { id: { in: allUserIds } },
            select: { id: true, totalPoints: true },
          })
        : [],
    ]);
    const totalMap = new Map(users.map((u) => [u.id, Number(u.totalPoints || 0)]));

    const rows = communities.map((c) => {
      let weeklyPoints = 0;
      let allTimePoints = 0;
      for (const m of c.members) {
        weeklyPoints += weeklyMap.get(m.userId) || 0;
        allTimePoints += totalMap.get(m.userId) || 0;
      }
      return {
        id: c.id,
        name: c.name,
        imageUrl: c.imageUrl || null,
        creator: c.creator,
        membersCount: c._count.members,
        weeklyPoints,
        allTimePoints,
      };
    });

    // Rank by all-time total (stable admin metric), weekly as tie-breaker.
    rows.sort((a, b) => b.allTimePoints - a.allTimePoints || b.weeklyPoints - a.weeklyPoints);
    rows.forEach((r, idx) => { r.rank = idx + 1; });

    const total = rows.length;
    const totalPages = Math.ceil(total / pageSize);
    const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

    res.render('admin/pages/leaderboard/index', {
      layout: 'admin/layouts/main',
      title: 'Leaderboard',
      communities: pageRows,
      total, page, totalPages,
      baseUrl: '/admin/leaderboard',
      weekLabel: weekLabel(weekStart),
    });
  } catch (error) {
    console.error('List community leaderboard error:', error);
    req.flash('error', 'Failed to load leaderboard.');
    res.redirect('/admin/dashboard');
  }
};

/* ------------------------ member leaderboard (detail) ------------------------ */
// Members of one community ranked by all-time total points, with weekly + avatar.
exports.showCommunityLeaderboard = async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    if (!Number.isFinite(communityId)) {
      req.flash('error', 'Invalid community.');
      return res.redirect('/admin/leaderboard');
    }
    const weekStart = getStartOfWeek();

    const community = await prisma.community.findUnique({
      where: { id: communityId },
      select: {
        id: true,
        name: true,
        imageUrl: true,
        _count: { select: { members: true } },
        members: {
          orderBy: { joinedAt: 'asc' },
          select: {
            joinedAt: true,
            user: {
              select: {
                id: true, username: true, firstName: true, lastName: true,
                email: true, phone: true, totalPoints: true,
                minime: {
                  where: { isSaved: true },
                  orderBy: { updatedAt: 'desc' },
                  take: 1,
                  select: { avatarUrl: true },
                },
              },
            },
          },
        },
      },
    });

    if (!community) {
      req.flash('error', 'Community not found.');
      return res.redirect('/admin/leaderboard');
    }

    const memberIds = community.members.map((m) => m.user.id);
    const weeklyMap = await weeklyTotalsMap(memberIds, weekStart);

    const rows = community.members.map((m) => {
      const u = m.user;
      const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username;
      return {
        id: u.id,
        username: u.username,
        fullName,
        contact: u.email || u.phone || null,
        avatarUrl: firstAvatar(u.minime),
        weeklyPoints: weeklyMap.get(u.id) || 0,
        allTimePoints: Number(u.totalPoints || 0),
        joinedAt: m.joinedAt,
      };
    });

    rows.sort((a, b) => b.allTimePoints - a.allTimePoints || b.weeklyPoints - a.weeklyPoints);
    rows.forEach((r, idx) => { r.rank = idx + 1; });

    res.render('admin/pages/leaderboard/show', {
      layout: 'admin/layouts/main',
      title: `Leaderboard · ${community.name}`,
      community,
      members: rows,
      weekLabel: weekLabel(weekStart),
    });
  } catch (error) {
    console.error('Show community leaderboard error:', error);
    req.flash('error', 'Failed to load community leaderboard.');
    res.redirect('/admin/leaderboard');
  }
};
