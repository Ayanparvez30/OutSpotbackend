const express = require('express');
const router = express.Router();
const { checkAuth } = require('../middlewares/authMiddleware');
const { getMyReview, submitReview } = require('../controllers/appReviewController');

// In-app reviews of OutSpot. Both routes are per-user, so both need auth —
// unlike the force-update check, nobody asks these before signing in.
router.get('/review/me', checkAuth, getMyReview);
router.post('/review', checkAuth, submitReview);

module.exports = router;
