const express = require('express');
const router = express.Router();
const { getAppVersion } = require('../controllers/appVersionController');

// Force-update check.
//
// Public on purpose — no checkAuth. The app calls this from the splash screen
// before it knows whether anyone is logged in, and a user blocked by an old
// build may never reach a screen where they could sign in.
router.get('/app/version', getAppVersion);

module.exports = router;
