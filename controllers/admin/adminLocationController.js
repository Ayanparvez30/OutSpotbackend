const { reverseCheckIn } = require('../../utils/checkinReversal');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/// Every check-in, in one place.
///
/// This is where the "submit for points" data lives. It used to be reachable
/// only by opening a user, which made a check-in impossible to look at unless
/// you already knew whose it was — no way to answer "what came in today?".
///
/// Read-only apart from the reversal button. Nothing here is a judgement: the
/// flags are the same signals the dashboard shows, and an admin decides.
exports.listLocationPoints = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = 30;
    const search = (req.query.q || '').trim();
    const filter = (req.query.filter || '').trim();

    const where = {
      ...(search
        ? {
            OR: [
              { placeName: { contains: search } },
              { placeId: { contains: search } },
              { user: { username: { contains: search } } },
            ],
          }
        : {}),
      // 'no-photo' and 'reversed' are the two questions worth asking of the
      // whole list; anything subtler belongs in the dashboard's findings.
      ...(filter === 'no-photo' ? { mediaUrl: '' } : {}),
      ...(filter === 'reversed' ? { points: 0 } : {}),
      ...(filter === 'has-floor' ? { floor: { not: null } } : {}),
    };

    const [locationPoints, total, stats] = await Promise.all([
      prisma.locationPoint.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              minime: {
                where: { isSaved: true },
                select: { avatarUrl: true },
                orderBy: { updatedAt: 'desc' },
                take: 1,
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.locationPoint.count({ where }),
      // Counted over everything, not the filtered set, so the chips always show
      // how much there is to filter down to.
      Promise.all([
        prisma.locationPoint.count(),
        prisma.locationPoint.count({ where: { mediaUrl: '' } }),
        prisma.locationPoint.count({ where: { points: 0 } }),
        prisma.locationPoint.count({ where: { floor: { not: null } } }),
      ]).then(([all, noPhoto, reversed, withFloor]) => ({
        all,
        noPhoto,
        reversed,
        withFloor,
      })),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const qs = [];
    if (search) qs.push(`q=${encodeURIComponent(search)}`);
    if (filter) qs.push(`filter=${filter}`);
    const baseUrl = `/admin/locations${qs.length ? `?${qs.join('&')}` : ''}`;

    res.render('admin/pages/locations/index', {
      layout: 'admin/layouts/main',
      title: 'Check-ins',
      locationPoints,
      total,
      stats,
      page,
      totalPages,
      baseUrl,
      search,
      filter,
    });
  } catch (error) {
    console.error('List check-ins error:', error);
    req.flash('error', 'Failed to load check-ins.');
    res.redirect('/admin/dashboard');
  }
};

/// Corrects the number recorded against a check-in.
///
/// Deliberately does NOT touch the user's balance — that is what the reversal
/// below is for. This only fixes the figure on the record, e.g. when the points
/// were computed from stale Google data.
exports.adjustPoints = async (req, res) => {
  const back = req.body?.back || '/admin/locations';
  try {
    const id = parseInt(req.params.id, 10);
    const points = parseInt(req.body.points, 10);
    if (!Number.isFinite(points) || points < 0) {
      req.flash('error', 'Points must be zero or more');
      return res.redirect(back);
    }
    await prisma.locationPoint.update({ where: { id }, data: { points } });
    req.flash('success', `Check-in #${id} set to ${points} points.`);
  } catch (error) {
    console.error('Adjust check-in points error:', error);
    req.flash('error', 'Failed to adjust points.');
  }
  res.redirect(back);
};

/// Takes the points back from a check-in judged to be fake.
///
/// This used to be `locationPoint.delete()` and nothing else — the row went, the
/// user kept the points, and the leaderboard (which sums PointsLedger) never
/// noticed. So there was no way to act on a fraud report at all.
///
/// The row is now zeroed rather than deleted, so the evidence and its photo
/// survive; see utils/checkinReversal.js for why the ledger's figure is the one
/// reversed rather than the check-in's.
exports.removePoint = async (req, res) => {
  const back = req.body?.back || '/admin/locations';
  try {
    const result = await reverseCheckIn(req.params.id, {
      adminName: req.session?.admin?.username || 'admin',
    });
    req.flash(result.ok ? 'success' : 'error', result.message);
  } catch (error) {
    console.error('Reverse check-in error:', error);
    req.flash('error', 'Failed to reverse that check-in.');
  }
  res.redirect(back);
};
