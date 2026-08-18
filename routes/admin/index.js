const express = require('express');
const router = express.Router();
const adminAuth = require('../../middlewares/adminAuth');

// Auth routes (no middleware needed)
router.use('/', require('./authRoutes'));

// All routes below require admin authentication
router.use(adminAuth);

// Admin pages render live moderation data — never let the browser serve a
// stale cached copy. Without this, a ban/unban/points-adjust/edit updates the
// DB but the post-action redirect can show a cached page, so the change looks
// like it "didn't apply". (Static assets under /admin/assets are mounted
// separately and stay cacheable.)
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  next();
});

router.use('/dashboard', require('./dashboardRoutes'));
router.use('/app-version', require('./appVersionRoutes'));
router.use('/reviews', require('./appReviewRoutes'));
router.use('/users', require('./userRoutes'));
router.use('/communities', require('./communityRoutes'));
router.use('/friends', require('./friendRoutes'));
router.use('/challenges', require('./challengeRoutes'));
router.use('/leaderboard', require('./leaderboardRoutes'));
router.use('/shop', require('./shopRoutes'));
router.use('/premades', require('./premadeRoutes'));
router.use('/body-shapes', require('./bodyShapeRoutes'));
router.use('/points', require('./pointsRoutes'));
router.use('/reports', require('./reportRoutes'));
router.use('/locations', require('./locationRoutes'));

// Redirect /admin to /admin/dashboard
router.get('/', (req, res) => res.redirect('/admin/dashboard'));

module.exports = router;
