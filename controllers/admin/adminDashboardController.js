const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Build a percentage-change trend ("+12.4%" / "-5%") between the current window
// and the previous window of equal length. Returns { dir, text } where dir is
// up | down | flat (drives the green/red/muted colour in the view).
function pctTrend(curr, prev) {
  if (!prev) {
    if (!curr) return { dir: 'flat', text: '0%' };
    return { dir: 'up', text: 'new' }; // no prior data to divide by
  }
  const pct = ((curr - prev) / prev) * 100;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const sign = pct > 0 ? '+' : pct < 0 ? '-' : '';
  return { dir, text: `${sign}${Math.abs(pct).toFixed(1)}%` };
}

exports.renderDashboard = async (req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const DAY = 24 * 60 * 60 * 1000;
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const twoWeeksAgo = new Date(now.getTime() - 14 * DAY);
    const monthAgo = new Date(now.getTime() - 30 * DAY);
    const twoMonthsAgo = new Date(now.getTime() - 60 * DAY);

    const [
      totalUsers,
      newUsersToday,
      newUsersWeek,
      newUsersPrevWeek,
      totalChallenges,
      activeChallenges,
      pendingReports,
      totalPurchases,
      purchasesPrevMonth,
      recentReports,
      recentUsers,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      // Previous 7-day window (days 8–14 ago) for the New Users trend.
      prisma.user.count({ where: { createdAt: { gte: twoWeeksAgo, lt: weekAgo } } }),
      prisma.challenge.count(),
      prisma.challenge.count({ where: { isActive: true } }),
      prisma.report.count({ where: { status: 'PENDING' } }),
      prisma.pointBundlePurchase.count({ where: { createdAt: { gte: monthAgo } } }),
      // Previous 30-day window (days 31–60 ago) for the Purchases trend.
      prisma.pointBundlePurchase.count({ where: { createdAt: { gte: twoMonthsAgo, lt: monthAgo } } }),
      prisma.report.findMany({
        where: { status: 'PENDING' },
        include: {
          reporter: { select: { id: true, username: true } },
          reported: { select: { id: true, username: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true, username: true, email: true, phone: true,
          firstName: true, lastName: true, createdAt: true, totalPoints: true,
          minime: { where: { isSaved: true }, select: { avatarUrl: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
        },
      }),
    ]);

    res.render('admin/pages/dashboard', {
      layout: 'admin/layouts/main',
      title: 'Dashboard',
      metrics: {
        totalUsers,
        newUsersToday,
        newUsersWeek,
        totalChallenges,
        activeChallenges,
        pendingReports,
        totalPurchases,
        // Period-over-period trends shown on the stat cards (New Users &
        // Purchases only — Challenges/Reports intentionally have no trend).
        usersTrend: pctTrend(newUsersWeek, newUsersPrevWeek),
        purchasesTrend: pctTrend(totalPurchases, purchasesPrevMonth),
      },
      recentReports,
      recentUsers,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    req.flash('error', 'Failed to load dashboard.');
    res.render('admin/pages/dashboard', {
      layout: 'admin/layouts/main',
      title: 'Dashboard',
      metrics: {},
      recentReports: [],
      recentUsers: [],
    });
  }
};
