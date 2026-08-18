const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/// Admin view of the in-app reviews.
///
/// Two capabilities only: read them, and hide one. Hiding is a reversible flag
/// — the row stays, the author keeps their words, and the review still counts
/// as "this user has reviewed" so hiding never makes the app pester them again.
/// Nothing here edits or deletes what a user wrote.
///
/// Play Store / App Store ratings do not appear here and cannot: neither store
/// tells the app who rated or what they said.

const PAGE_SIZE = 20;

exports.index = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    // '5'..'1' filter by stars; 'hidden' shows what's been taken down.
    const filter = String(req.query.filter || '').trim();
    const star = parseInt(filter, 10);
    const where =
      filter === 'hidden'
        ? { hidden: true }
        : Number.isFinite(star) && star >= 1 && star <= 5
          ? { rating: star, hidden: false }
          : { hidden: false };

    const [reviews, total, visible, breakdown] = await Promise.all([
      prisma.appReview.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.appReview.count({ where }),
      prisma.appReview.count({ where: { hidden: false } }),
      // Star distribution — hidden reviews are excluded so the average shown
      // matches what a hidden review no longer contributes to.
      prisma.appReview.groupBy({
        by: ['rating'],
        where: { hidden: false },
        _count: { rating: true },
      }),
    ]);

    const counts = [5, 4, 3, 2, 1].map((s) => ({
      star: s,
      count: breakdown.find((b) => b.rating === s)?._count.rating || 0,
    }));
    const totalStars = counts.reduce((sum, c) => sum + c.star * c.count, 0);
    const average = visible > 0 ? (totalStars / visible).toFixed(2) : '—';

    res.render('admin/pages/appReview/index', {
      layout: 'admin/layouts/main',
      title: 'App Reviews',
      reviews,
      total,
      visible,
      average,
      counts,
      page,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      filter,
      baseUrl: `/admin/reviews${filter ? `?filter=${filter}` : ''}`,
    });
  } catch (err) {
    console.error('App reviews page error:', err);
    req.flash('error', 'Failed to load reviews');
    res.redirect('/admin/dashboard');
  }
};

/// Toggles the hidden flag. Same route both ways, so an accidental hide is one
/// click from being undone.
exports.toggleHidden = async (req, res) => {
  const back = req.body.back || '/admin/reviews';
  try {
    const id = parseInt(req.params.id, 10);
    const review = await prisma.appReview.findUnique({ where: { id } });
    if (!review) {
      req.flash('error', 'That review no longer exists');
      return res.redirect(back);
    }

    await prisma.appReview.update({
      where: { id },
      data: { hidden: !review.hidden },
    });
    req.flash(
      'success',
      review.hidden ? 'Review is visible again.' : 'Review hidden.',
    );
  } catch (err) {
    console.error('Toggle review hidden error:', err);
    req.flash('error', 'Failed to update the review');
  }
  res.redirect(back);
};
