const express = require('express');
const multer = require('multer');
const router = express.Router();
const { checkAuth } = require('../middlewares/authMiddleware');
const {
  submitSuggestion,
  getMySuggestions,
} = require('../controllers/mapSpotController');

// Same in-memory storage the check-in photo upload uses — the buffer goes
// straight to S3, nothing is written to the server's disk.
const upload = multer({ storage: multer.memoryStorage() });

// One photo per suggestion, so `single` rather than `array`.
router.post('/spots/suggest', checkAuth, upload.single('image'), submitSuggestion);
router.get('/spots/my-suggestions', checkAuth, getMySuggestions);

module.exports = router;
