const { PrismaClient } = require('@prisma/client');
const { notifyUser } = require('../../utils/notificationService');
const { addPointsWithMultiplier } = require('../../utils/points');
const { deleteS3IfOrphanBulk } = require('../../utils/s3Cleanup');
const uploadToS3 = require('../../utils/s3Upload');
const {
  VALID_CATEGORIES,
  APPROVAL_REWARD_POINTS,
  placeIdFor,
} = require('../mapSpotController');

const prisma = new PrismaClient();

/// Admin side of custom map spots.
///
/// Two screens: the review queue for what users sent in, and the list of what
/// is live on the map. Approving a suggestion is the only path that both
/// publishes a spot and pays the reporter, and it runs in a transaction so a
/// half-approved suggestion can't exist.

const PAGE_SIZE = 20;

const CATEGORY_TITLES = {
  restaurants: 'Restaurants',
  cafes: 'Cafes',
  bars: 'Bars',
  dessert: 'Dessert',
  outdoors: 'Outdoors',
  'venue-events': 'Venue Events',
};

/// Validates the numbers an admin must supply before a spot can go live.
/// Returns `{ points, radiusMeters }` or throws with a message meant for them.
function readSpotNumbers(body) {
  const points = parseInt(body.points, 10);
  const radiusMeters = parseInt(body.radiusMeters, 10);

  // Both are required rather than defaulted: a spot published with someone's
  // forgotten placeholder points is worse than one that refused to publish.
  if (!Number.isFinite(points) || points < 1 || points > 10000) {
    throw new Error('Points must be a number between 1 and 10000');
  }
  if (!Number.isFinite(radiusMeters) || radiusMeters < 10 || radiusMeters > 5000) {
    throw new Error('Check-in radius must be between 10 and 5000 metres');
  }
  return { points, radiusMeters };
}

// ------------------------------------------------------------ review queue

exports.suggestionsIndex = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const status = String(req.query.status || '').toUpperCase();
    const where = ['PENDING', 'APPROVED', 'REJECTED'].includes(status)
      ? { status }
      : {};

    const [suggestions, total, counts] = await Promise.all([
      prisma.spotSuggestion.findMany({
        where,
        include: {
          user: {
            select: { id: true, username: true, firstName: true, lastName: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.spotSuggestion.count({ where }),
      prisma.spotSuggestion.groupBy({ by: ['status'], _count: { status: true } }),
    ]);

    const countBy = (s) =>
      counts.find((c) => c.status === s)?._count.status || 0;

    res.render('admin/pages/locations/spot-suggestions', {
      layout: 'admin/layouts/main',
      title: 'Spot Suggestions',
      mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
      categories: Object.entries(CATEGORY_TITLES).map(([key, title]) => ({
        key,
        title,
      })),
      suggestions,
      stats: {
        total: counts.reduce((sum, c) => sum + c._count.status, 0),
        pending: countBy('PENDING'),
        approved: countBy('APPROVED'),
        rejected: countBy('REJECTED'),
      },
      rewardPoints: APPROVAL_REWARD_POINTS,
      statusFilter: ['PENDING', 'APPROVED', 'REJECTED'].includes(status)
        ? status
        : '',
      page,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
  } catch (err) {
    console.error('Spot suggestions page error:', err);
    req.flash('error', 'Failed to load spot suggestions');
    res.redirect('/admin/dashboard');
  }
};

/// Publishes a suggestion as a live spot and pays the reporter.
///
/// One transaction covers creating the spot, stamping the suggestion and
/// awarding the points, so there is no window where a user is paid for a spot
/// that failed to publish. The notification and the realtime points signal are
/// sent afterwards, once the rows are actually committed — `addPointsWithMultiplier`
/// deliberately stays silent when handed a transaction client.
exports.approveSuggestion = async (req, res) => {
  const back = req.body.back || '/admin/locations/spot-suggestions';
  try {
    const id = parseInt(req.params.id, 10);
    const suggestion = await prisma.spotSuggestion.findUnique({ where: { id } });
    if (!suggestion) {
      req.flash('error', 'That suggestion no longer exists');
      return res.redirect(back);
    }
    if (suggestion.status !== 'PENDING') {
      req.flash('error', `Already ${suggestion.status.toLowerCase()}`);
      return res.redirect(back);
    }

    const { points, radiusMeters } = readSpotNumbers(req.body);

    const categoryKey = String(req.body.categoryKey || suggestion.categoryKey);
    if (!VALID_CATEGORIES.has(categoryKey)) {
      throw new Error('Pick a valid category');
    }

    const admin = req.session?.admin?.username || 'admin';

    const spot = await prisma.$transaction(async (tx) => {
      const created = await tx.mapSpot.create({
        data: {
          // Placeholder — rewritten below now that the row has an id.
          placeId: `pending_${suggestion.id}_${Date.now()}`,
          name: String(req.body.name || suggestion.name).trim().slice(0, 200),
          address:
            (req.body.address || suggestion.address || '').trim().slice(0, 300) ||
            null,
          city: (req.body.city || '').trim().slice(0, 120) || null,
          categoryKey,
          description:
            (req.body.description || suggestion.note || '').trim().slice(0, 1000) ||
            null,
          // The reporter's photo becomes the spot's photo. Both rows now point
          // at the same S3 object, which is exactly why both are counted in
          // utils/s3Cleanup.js.
          imageUrl: suggestion.imageUrl,
          // Never taken from the form: the coordinates are the evidence that
          // the reporter was standing there.
          latitude: suggestion.latitude,
          longitude: suggestion.longitude,
          radiusMeters,
          points,
          active: true,
          fromSuggestionId: suggestion.id,
          createdByAdmin: admin,
        },
      });

      const withPlaceId = await tx.mapSpot.update({
        where: { id: created.id },
        data: { placeId: placeIdFor(created.id) },
      });

      await tx.spotSuggestion.update({
        where: { id: suggestion.id },
        data: {
          status: 'APPROVED',
          reviewedAt: new Date(),
          reviewedByAdmin: admin,
          mapSpotId: created.id,
        },
      });

      await addPointsWithMultiplier(
        suggestion.userId,
        APPROVAL_REWARD_POINTS,
        'SPOT_SUGGESTION_APPROVED',
        created.id,
        tx,
      );

      return withPlaceId;
    });

    // Committed — safe to tell the user.
    notifyUser(
      suggestion.userId,
      'SPOT_SUGGESTION_APPROVED',
      'Your spot is on the map!',
      `"${spot.name}" is live. You earned ${APPROVAL_REWARD_POINTS} points.`,
      { spotId: spot.id, placeId: spot.placeId },
    ).catch((e) => console.error('approve notify failed', e?.message));

    req.flash(
      'success',
      `Published "${spot.name}" and gave ${APPROVAL_REWARD_POINTS} points to the reporter.`,
    );
  } catch (err) {
    console.error('Approve suggestion error:', err);
    req.flash('error', err.message || 'Failed to approve');
  }
  res.redirect(back);
};

/// Rejects with a reason the user will read. The reason is required — a
/// rejection notification saying nothing is worse than none at all.
exports.rejectSuggestion = async (req, res) => {
  const back = req.body.back || '/admin/locations/spot-suggestions';
  try {
    const id = parseInt(req.params.id, 10);
    const reason = String(req.body.rejectReason || '').trim();
    if (!reason) {
      req.flash('error', 'Give a reason — the user is shown it');
      return res.redirect(back);
    }

    const suggestion = await prisma.spotSuggestion.findUnique({ where: { id } });
    if (!suggestion || suggestion.status !== 'PENDING') {
      req.flash('error', 'That suggestion is not pending');
      return res.redirect(back);
    }

    await prisma.spotSuggestion.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectReason: reason.slice(0, 500),
        reviewedAt: new Date(),
        reviewedByAdmin: req.session?.admin?.username || 'admin',
      },
    });

    notifyUser(
      suggestion.userId,
      'SPOT_SUGGESTION_REJECTED',
      'Your spot suggestion wasn\'t approved',
      reason.slice(0, 500),
      { suggestionId: id },
    ).catch((e) => console.error('reject notify failed', e?.message));

    req.flash('success', 'Rejected, and the user has been told why.');
  } catch (err) {
    console.error('Reject suggestion error:', err);
    req.flash('error', 'Failed to reject');
  }
  res.redirect(back);
};

/// Removes a suggestion now, rather than waiting for it to expire.
///
/// Offered for PENDING and REJECTED only. An APPROVED one is the record of
/// where a live map spot came from, and its photo is the spot's photo — delete
/// the spot itself from Map Spots if it needs to go.
///
/// The photo goes through the orphan guard, never a direct S3 delete: an
/// approved suggestion shares its image URL with the MapSpot built from it, and
/// `countReferences()` in utils/s3Cleanup.js counts both tables, so a file
/// still in use is left alone.
exports.deleteSuggestion = async (req, res) => {
  const back = req.body.back || '/admin/locations/spot-suggestions';
  try {
    const id = parseInt(req.params.id, 10);
    const suggestion = await prisma.spotSuggestion.findUnique({ where: { id } });
    if (!suggestion) {
      req.flash('error', 'That suggestion no longer exists');
      return res.redirect(back);
    }
    if (suggestion.status === 'APPROVED') {
      req.flash(
        'error',
        'This one is live on the map — remove the spot from Map Spots instead.',
      );
      return res.redirect(back);
    }

    await prisma.spotSuggestion.delete({ where: { id } });

    // Row first, then the photo. The guard counts what is left, so the other
    // order would find the suggestion still holding its own image and skip it.
    if (suggestion.imageUrl) {
      deleteS3IfOrphanBulk([suggestion.imageUrl]).catch(e =>
        console.error('suggestion photo cleanup failed', e?.message),
      );
    }

    req.flash('success', `Deleted "${suggestion.name}".`);
  } catch (err) {
    console.error('Delete suggestion error:', err);
    req.flash('error', 'Failed to delete the suggestion');
  }
  res.redirect(back);
};

// -------------------------------------------------------------- live spots

exports.spotsIndex = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const categoryKey = String(req.query.category || '');
    const where = VALID_CATEGORIES.has(categoryKey) ? { categoryKey } : {};

    const [spots, total, activeCount] = await Promise.all([
      prisma.mapSpot.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      prisma.mapSpot.count({ where }),
      prisma.mapSpot.count({ where: { active: true } }),
    ]);

    res.render('admin/pages/locations/map-spots', {
      layout: 'admin/layouts/main',
      title: 'Map Spots',
      mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
      categories: Object.entries(CATEGORY_TITLES).map(([key, title]) => ({
        key,
        title,
      })),
      spots,
      total,
      activeCount,
      totalPoints: spots.reduce((sum, s) => sum + s.points, 0),
      categoryFilter: where.categoryKey || '',
      page,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    });
  } catch (err) {
    console.error('Map spots page error:', err);
    req.flash('error', 'Failed to load map spots');
    res.redirect('/admin/dashboard');
  }
};

/// Admin adds a spot directly, with no user suggestion behind it.
exports.createSpot = async (req, res) => {
  try {
    const { points, radiusMeters } = readSpotNumbers(req.body);

    const name = String(req.body.name || '').trim();
    const categoryKey = String(req.body.categoryKey || '');
    const latitude = parseFloat(req.body.latitude);
    const longitude = parseFloat(req.body.longitude);

    if (!name) throw new Error('Name is required');
    if (!VALID_CATEGORIES.has(categoryKey)) throw new Error('Pick a category');
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error('Drop a pin on the map');
    }

    // A failed upload must not lose the whole spot — the admin can add the
    // photo afterwards from the list.
    let imageUrl = null;
    if (req.file) {
      try {
        imageUrl = await uploadToS3(req.file, 'map-spots');
      } catch (e) {
        console.error('createSpot: image upload failed', e?.message);
      }
    }

    const created = await prisma.mapSpot.create({
      data: {
        placeId: `pending_new_${Date.now()}`,
        imageUrl,
        name: name.slice(0, 200),
        address: (req.body.address || '').trim().slice(0, 300) || null,
        city: (req.body.city || '').trim().slice(0, 120) || null,
        categoryKey,
        description: (req.body.description || '').trim().slice(0, 1000) || null,
        latitude,
        longitude,
        radiusMeters,
        points,
        active: req.body.active !== 'off',
        createdByAdmin: req.session?.admin?.username || 'admin',
      },
    });
    await prisma.mapSpot.update({
      where: { id: created.id },
      data: { placeId: placeIdFor(created.id) },
    });

    req.flash('success', `"${created.name}" is on the map.`);
  } catch (err) {
    console.error('Create map spot error:', err);
    req.flash('error', err.message || 'Failed to create the spot');
  }
  res.redirect('/admin/locations/map-spots');
};

/// Sets or replaces a spot's photo.
///
/// The old file is only removed once the row already points at the new one, and
/// then only through the orphan guard — a spot grown from a user's suggestion
/// shares its photo with that suggestion, and `countReferences()` counts both.
exports.updateSpotPhoto = async (req, res) => {
  const back = req.body.back || '/admin/locations/map-spots';
  try {
    const id = parseInt(req.params.id, 10);
    const spot = await prisma.mapSpot.findUnique({ where: { id } });
    if (!spot) {
      req.flash('error', 'That spot no longer exists');
      return res.redirect(back);
    }
    if (!req.file) {
      req.flash('error', 'Choose an image first');
      return res.redirect(back);
    }

    const imageUrl = await uploadToS3(req.file, 'map-spots');
    await prisma.mapSpot.update({ where: { id }, data: { imageUrl } });

    // Row updated first, so the guard no longer counts the old URL here.
    if (spot.imageUrl && spot.imageUrl !== imageUrl) {
      deleteS3IfOrphanBulk([spot.imageUrl]).catch(e =>
        console.error('old spot photo cleanup failed', e?.message),
      );
    }

    req.flash('success', `Photo updated for "${spot.name}".`);
  } catch (err) {
    console.error('Update spot photo error:', err);
    req.flash('error', err.message || 'Failed to update the photo');
  }
  res.redirect(back);
};

/// Hides or shows a spot. Reversible, and never touches the row's photo.
exports.toggleSpot = async (req, res) => {
  const back = req.body.back || '/admin/locations/map-spots';
  try {
    const id = parseInt(req.params.id, 10);
    const spot = await prisma.mapSpot.findUnique({ where: { id } });
    if (!spot) {
      req.flash('error', 'That spot no longer exists');
      return res.redirect(back);
    }
    await prisma.mapSpot.update({
      where: { id },
      data: { active: !spot.active },
    });
    req.flash('success', spot.active ? 'Spot hidden.' : 'Spot is live again.');
  } catch (err) {
    console.error('Toggle map spot error:', err);
    req.flash('error', 'Failed to update the spot');
  }
  res.redirect(back);
};

/// Deletes a spot for good.
///
/// Check-ins already earned stay put — `LocationPoint` keeps its own copy of
/// the place name and coordinates, so a user's history and points survive a
/// spot being removed.
exports.deleteSpot = async (req, res) => {
  const back = req.body.back || '/admin/locations/map-spots';
  try {
    const id = parseInt(req.params.id, 10);
    const spot = await prisma.mapSpot.findUnique({ where: { id } });
    if (!spot) {
      req.flash('error', 'That spot no longer exists');
      return res.redirect(back);
    }

    await prisma.mapSpot.delete({ where: { id } });

    // Row first, then cleanup — the orphan guard counts what's left, so
    // deleting in the other order would see the spot still holding the photo.
    // The suggestion behind it still references the same URL, so this only
    // deletes when that has gone too.
    if (spot.imageUrl) {
      deleteS3IfOrphanBulk([spot.imageUrl]).catch((e) =>
        console.error('spot photo cleanup failed', e?.message),
      );
    }

    req.flash('success', `Removed "${spot.name}".`);
  } catch (err) {
    console.error('Delete map spot error:', err);
    req.flash('error', 'Failed to delete the spot');
  }
  res.redirect(back);
};
