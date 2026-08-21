const { reverseCheckIn } = require('../../utils/checkinReversal');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.listLocationPoints = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 30;
    const search = (req.query.q || '').trim();

    const where = search
      ? { OR: [{ placeName: { contains: search } }, { user: { username: { contains: search } } }] }
      : {};

    const [locationPoints, total] = await Promise.all([
      prisma.locationPoint.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              minime: { where: { isSaved: true }, select: { avatarUrl: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.locationPoint.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const baseUrl = `/admin/locations${search ? `?q=${encodeURIComponent(search)}` : ''}`;

    res.render('admin/pages/locations/index', {
      layout: 'admin/layouts/main',
      title: 'Location Points',
      locationPoints, total, page, totalPages, baseUrl, search,
    });
  } catch (error) {
    console.error('List location points error:', error);
    req.flash('error', 'Failed to load location points.');
    res.redirect('/admin/dashboard');
  }
};

exports.adjustPoints = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { points } = req.body;
    await prisma.locationPoint.update({
      where: { id },
      data: { points: parseInt(points) },
    });
    req.flash('success', `Location point #${id} adjusted.`);
    res.redirect('/admin/locations');
  } catch (error) {
    console.error('Adjust location points error:', error);
    req.flash('error', 'Failed to adjust points.');
    res.redirect('/admin/locations');
  }
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
