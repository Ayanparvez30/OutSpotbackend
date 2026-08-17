const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { pointsForDifficulty } = require('../../utils/challengeDifficulty');
const { previewActiveChallenge, resolveZone, windowKeyForDate } = require('../../utils/challenges');

exports.listChallenges = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 20;
    const freq = req.query.frequency;
    const search = (req.query.q || '').trim();

    const where = {};
    if (freq) where.frequency = freq;
    if (search) where.title = { contains: search };

    const [challenges, total] = await Promise.all([
      prisma.challenge.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ frequency: 'asc' }, { createdAt: 'desc' }],
        include: { _count: { select: { submissions: true, completions: true } } },
      }),
      prisma.challenge.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (freq) params.set('frequency', freq);
    const baseUrl = `/admin/challenges${params.toString() ? `?${params}` : ''}`;

    // Which challenge is *live right now* (admin override → else the app's
    // deterministic date-seeded pick) for the default app timezone. Independent
    // of the page filter above.
    const zone = resolveZone();
    const [dailyPick, weeklyPick] = await Promise.all([
      previewActiveChallenge(prisma, 'DAILY', zone),
      previewActiveChallenge(prisma, 'WEEKLY', zone),
    ]);
    const todayKey = dailyPick.windowKey; // today's date key in the app zone

    // Today-and-future admin overrides (so the admin can review/cancel them).
    // Guarded so the page still loads if the migration hasn't been run yet.
    const upcomingSchedules = prisma.challengeSchedule
      ? await prisma.challengeSchedule.findMany({
          where: { windowKey: { gte: todayKey } },
          include: { challenge: { select: { id: true, title: true, frequency: true } } },
          orderBy: [{ windowKey: 'asc' }, { frequency: 'asc' }],
          take: 60,
        })
      : [];

    res.render('admin/pages/challenges/index', {
      layout: 'admin/layouts/main',
      title: 'Challenges',
      challenges, total, page, totalPages, baseUrl,
      search, frequency: freq || '',
      liveDaily: dailyPick.challenge,
      liveWeekly: weeklyPick.challenge,
      liveDailySource: dailyPick.source,
      liveWeeklySource: weeklyPick.source,
      liveZone: zone,
      todayKey,
      upcomingSchedules,
    });
  } catch (error) {
    console.error('List challenges error:', error);
    req.flash('error', 'Failed to load challenges.');
    res.redirect('/admin/dashboard');
  }
};

// Pin a challenge to a specific day/week (admin override). Date comes from the
// modal as "yyyy-mm-dd"; the window key is derived from the challenge's own
// frequency (DAILY = that date, WEEKLY = the Sunday week-start containing it).
exports.setSchedule = async (req, res) => {
  try {
    const challengeId = parseInt(req.params.id);
    const dateStr = (req.body.date || '').trim();
    const ch = await prisma.challenge.findUnique({ where: { id: challengeId } });
    if (!ch) {
      req.flash('error', 'Challenge not found.');
      return res.redirect('/admin/challenges');
    }
    if (!dateStr) {
      req.flash('error', 'Please pick a date.');
      return res.redirect('/admin/challenges');
    }
    const zone = resolveZone();
    const windowKey = windowKeyForDate(ch.frequency, dateStr, zone);
    if (!windowKey) {
      req.flash('error', 'Invalid date.');
      return res.redirect('/admin/challenges');
    }
    // One override per (frequency, window) — upsert replaces any existing pin.
    await prisma.challengeSchedule.upsert({
      where: { frequency_windowKey: { frequency: ch.frequency, windowKey } },
      update: { challengeId },
      create: { frequency: ch.frequency, windowKey, challengeId },
    });
    const label = ch.frequency === 'DAILY' ? windowKey : `week of ${windowKey}`;
    req.flash('success', `"${ch.title}" scheduled for ${label}.`);
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Set challenge schedule error:', error);
    req.flash('error', 'Failed to schedule challenge.');
    res.redirect('/admin/challenges');
  }
};

// Remove an override → that window reverts to the automatic seeded pick.
exports.clearSchedule = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.challengeSchedule.delete({ where: { id } });
    req.flash('success', 'Override removed — that window reverts to auto-pick.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Clear challenge schedule error:', error);
    req.flash('error', 'Failed to remove override.');
    res.redirect('/admin/challenges');
  }
};

exports.createForm = (req, res) => {
  res.render('admin/pages/challenges/form', {
    layout: 'admin/layouts/main',
    title: 'Create Challenge',
    challenge: null,
  });
};

exports.createChallenge = async (req, res) => {
  try {
    const { title, description, type, frequency, points, tier, requiredPhotos, difficulty } = req.body;
    // Difficulty → points (EASY 10/MEDIUM 15/HARD 20/MULTI_STEP 25). Explicit
    // points win; otherwise difficulty sets them; else default 10.
    const diff = difficulty ? String(difficulty).toUpperCase() : null;
    const diffPoints = pointsForDifficulty(diff);
    await prisma.challenge.create({
      data: {
        title,
        description,
        type: type || null,
        frequency: frequency || 'DAILY',
        points: parseInt(points) || diffPoints || 10,
        tier: tier || 'SILVER',
        requiredPhotos: parseInt(requiredPhotos) || 1,
        difficulty: diffPoints != null ? diff : null,
      },
    });
    req.flash('success', 'Challenge created.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Create challenge error:', error);
    req.flash('error', 'Failed to create challenge.');
    res.redirect('/admin/challenges/create');
  }
};

exports.editForm = async (req, res) => {
  try {
    const challenge = await prisma.challenge.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!challenge) {
      req.flash('error', 'Challenge not found.');
      return res.redirect('/admin/challenges');
    }
    res.render('admin/pages/challenges/form', {
      layout: 'admin/layouts/main',
      title: `Edit: ${challenge.title}`,
      challenge,
    });
  } catch (error) {
    console.error('Edit challenge form error:', error);
    req.flash('error', 'Failed to load challenge.');
    res.redirect('/admin/challenges');
  }
};

exports.updateChallenge = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { title, description, type, frequency, points, tier, requiredPhotos, difficulty } = req.body;
    const diff = difficulty ? String(difficulty).toUpperCase() : null;
    const diffPoints = pointsForDifficulty(diff);
    await prisma.challenge.update({
      where: { id },
      data: {
        title,
        description,
        type: type || null,
        frequency: frequency || undefined,
        // explicit points win; else realign to difficulty if one was chosen
        points: parseInt(points) || (diffPoints != null ? diffPoints : undefined),
        tier: tier || undefined,
        requiredPhotos: parseInt(requiredPhotos) || undefined,
        difficulty: diffPoints != null ? diff : undefined,
      },
    });
    req.flash('success', 'Challenge updated.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Update challenge error:', error);
    req.flash('error', 'Failed to update challenge.');
    res.redirect(`/admin/challenges/${req.params.id}/edit`);
  }
};

exports.activateChallenge = async (req, res) => {
  try {
    await prisma.challenge.update({ where: { id: parseInt(req.params.id) }, data: { isActive: true } });
    req.flash('success', 'Challenge activated.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Activate challenge error:', error);
    req.flash('error', 'Failed to activate.');
    res.redirect('/admin/challenges');
  }
};

exports.deactivateChallenge = async (req, res) => {
  try {
    await prisma.challenge.update({ where: { id: parseInt(req.params.id) }, data: { isActive: false } });
    req.flash('success', 'Challenge deactivated.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Deactivate challenge error:', error);
    req.flash('error', 'Failed to deactivate.');
    res.redirect('/admin/challenges');
  }
};

exports.toggleFeature = async (req, res) => {
  try {
    const challenge = await prisma.challenge.findUnique({ where: { id: parseInt(req.params.id) } });
    await prisma.challenge.update({
      where: { id: parseInt(req.params.id) },
      data: { isFeatured: !challenge.isFeatured },
    });
    req.flash('success', challenge.isFeatured ? 'Challenge unfeatured.' : 'Challenge featured.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Toggle feature error:', error);
    req.flash('error', 'Failed to toggle feature.');
    res.redirect('/admin/challenges');
  }
};

exports.deleteChallenge = async (req, res) => {
  try {
    await prisma.challenge.delete({ where: { id: parseInt(req.params.id) } });
    req.flash('success', 'Challenge deleted.');
    res.redirect('/admin/challenges');
  } catch (error) {
    console.error('Delete challenge error:', error);
    req.flash('error', 'Failed to delete challenge. It may have submissions.');
    res.redirect('/admin/challenges');
  }
};

// All submissions across every challenge (sidebar → Submissions).
exports.listAllSubmissions = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = 30;
    const status = req.query.status;
    const where = status ? { verificationStatus: status } : {};

    const [submissions, total] = await Promise.all([
      prisma.submission.findMany({
        where,
        include: {
          user: { select: { id: true, username: true, minime: { where: { isSaved: true }, select: { avatarUrl: true }, orderBy: { updatedAt: 'desc' }, take: 1 } } },
          challenge: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.submission.count({ where }),
    ]);

    const totalPages = Math.ceil(total / pageSize);
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    const baseUrl = `/admin/challenges/submissions${params.toString() ? `?${params}` : ''}`;

    res.render('admin/pages/challenges/all-submissions', {
      layout: 'admin/layouts/main',
      title: 'Submissions',
      submissions, total, page, totalPages, baseUrl, statusFilter: status || '',
    });
  } catch (error) {
    console.error('List all submissions error:', error);
    req.flash('error', 'Failed to load submissions.');
    res.redirect('/admin/dashboard');
  }
};

exports.viewSubmissions = async (req, res) => {
  try {
    const challengeId = parseInt(req.params.id);
    const page = parseInt(req.query.page) || 1;
    const pageSize = 20;

    const challenge = await prisma.challenge.findUnique({ where: { id: challengeId } });

    const [submissions, total] = await Promise.all([
      prisma.submission.findMany({
        where: { challengeId },
        include: { user: { select: { id: true, username: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.submission.count({ where: { challengeId } }),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    res.render('admin/pages/challenges/submissions', {
      layout: 'admin/layouts/main',
      title: `Submissions: ${challenge?.title || challengeId}`,
      challenge, submissions, total, page, totalPages,
      baseUrl: `/admin/challenges/${challengeId}/submissions`,
    });
  } catch (error) {
    console.error('View submissions error:', error);
    req.flash('error', 'Failed to load submissions.');
    res.redirect('/admin/challenges');
  }
};
