const { PrismaClient } = require('@prisma/client');
const { true_status, false_status } = require('../functions/response');

const prisma = new PrismaClient();

/// In-app reviews of OutSpot itself.
///
/// One review per user, edited in place — "Rate OutSpot" in Settings reopens
/// the same review rather than stacking a second one. The app decides *when*
/// to ask (3 opens, snoozed 2 days on "Later"); the server only answers the
/// one question the app can't work out on its own: has this account already
/// reviewed, from any device or install?
///
/// Nothing here touches Play Store / App Store ratings. Neither store reports
/// back who rated or what they said, so those can never appear in the admin
/// panel — only reviews written inside the app do.

const MAX_COMMENT = 1000;

/// Shapes a row for the app. `hidden` is deliberately not exposed: a review
/// the admin hid still belongs to its author, who should keep seeing and
/// editing their own words.
function toAppJson(review) {
  if (!review) return null;
  return {
    id: review.id,
    rating: review.rating,
    comment: review.comment || '',
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  };
}

// GET /api/review/me
//
// Drives the prompt: the app asks this before deciding whether to show the
// review sheet, so a user who reviewed on their old phone is never asked again.
exports.getMyReview = async (req, res) => {
  try {
    const userId = req.authData.id;
    const review = await prisma.appReview.findUnique({ where: { userId } });

    return true_status(
      res,
      { hasReviewed: !!review, review: toAppJson(review) },
      'Review status fetched',
    );
  } catch (e) {
    console.error('getMyReview error', e);
    // Fail open: if we can't tell, claim they've reviewed. Pestering someone
    // who already left a review is worse than missing one prompt.
    return true_status(
      res,
      { hasReviewed: true, review: null },
      'Review status unavailable',
    );
  }
};

// POST /api/review  { rating: 1-5, comment?: string }
//
// Creates or updates — the unique index on userId makes this a genuine upsert,
// so a double-tap can't produce two reviews.
exports.submitReview = async (req, res) => {
  try {
    const userId = req.authData.id;
    const rating = parseInt(req.body.rating, 10);

    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return false_status(res, 'Rating must be between 1 and 5');
    }

    const comment =
      typeof req.body.comment === 'string'
        ? req.body.comment.trim().slice(0, MAX_COMMENT)
        : '';

    const review = await prisma.appReview.upsert({
      where: { userId },
      create: { userId, rating, comment: comment || null },
      // An edit does not un-hide a review the admin took down, and does not
      // reset createdAt — `updatedAt` carries the fact that it changed.
      update: { rating, comment: comment || null },
    });

    return true_status(res, toAppJson(review), 'Thanks for your review');
  } catch (e) {
    console.error('submitReview error', e);
    return false_status(res, 'Could not save your review');
  }
};
