const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminLeaderboardController');

router.get('/', ctrl.listCommunityLeaderboard);
router.get('/:id', ctrl.showCommunityLeaderboard);

module.exports = router;
