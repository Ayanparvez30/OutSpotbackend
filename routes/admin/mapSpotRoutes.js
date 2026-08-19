const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminMapSpotController');

// Same shape as the shop's uploader: memory storage straight through to S3,
// 5 MB cap, images only.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (jpg, png, webp, gif) are allowed'), false);
    }
  },
});

/// Turns multer's rejections into a flash message and a redirect.
///
/// Without this an oversized or non-image file escapes as an unhandled error
/// and the admin gets a raw 500 page instead of being told what was wrong.
function uploadImage(req, res, next) {
  upload.single('imageFile')(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That image is over 5 MB — pick a smaller one'
        : err.message || 'Could not read that image';
    console.error('Map spot upload rejected:', err.message);
    req.flash('error', message);
    res.redirect(req.body?.back || '/admin/locations/map-spots');
  });
}

// Live spots on the map.
router.get('/map-spots', ctrl.spotsIndex);
router.post('/map-spots', uploadImage, ctrl.createSpot);
router.post('/map-spots/:id/photo', uploadImage, ctrl.updateSpotPhoto);
router.post('/map-spots/:id/toggle', ctrl.toggleSpot);
router.post('/map-spots/:id/delete', ctrl.deleteSpot);

// The review queue for what users sent in.
router.get('/spot-suggestions', ctrl.suggestionsIndex);
router.post('/spot-suggestions/:id/approve', ctrl.approveSuggestion);
router.post('/spot-suggestions/:id/reject', ctrl.rejectSuggestion);
router.post('/spot-suggestions/:id/delete', ctrl.deleteSuggestion);

module.exports = router;
