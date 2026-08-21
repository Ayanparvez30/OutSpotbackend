const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');

/// Check-in evidence photos.
///
/// This used to be a bare `multer({ storage: memoryStorage() })` — no size cap
/// and no type check, unlike every other upload route in the app. Since
/// memoryStorage buffers the whole file in RAM before anything looks at it, a
/// single logged-in caller posting a few large videos could exhaust the
/// server's memory, and the server also runs MySQL and Socket.IO.
///
/// 25 MB is deliberately generous: the camera writes JPEGs at quality 100 and
/// PNGs in some paths, so a real photo from a high-megapixel phone can be well
/// into the teens. It is still far below any video worth the name, and the type
/// filter closes that door regardless of size.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const okExt = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
    const isImage = (file.mimetype || '').startsWith('image/');

    // Either signal being right is enough: some clients send a generic
    // application/octet-stream mimetype, and some send a filename with no
    // extension at all. Both together being wrong is what gets rejected.
    if (isImage || okExt.includes(ext)) return cb(null, true);
    cb(new Error('Check-in evidence must be a photo'), false);
  },
});

/// Turns multer's rejections into the JSON shape this API always answers with.
///
/// Without it an oversized or non-image upload escapes as an unhandled error
/// and the app receives a 500 with an HTML body, which its JSON parser then
/// chokes on — the user sees nothing useful at all.
function uploadEvidence(req, res, next) {
  upload.single('media')(req, res, (err) => {
    if (!err) return next();

    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That photo is too large. Please try again.'
        : 'Check-ins take a photo, not a video.';
    console.warn(
      `[recordVisit] upload rejected user=${req.authData?.id} ${err.code || err.message}`,
    );

    // 400, not 500: the request was understood and refused, and the app's
    // check-in flow already renders `error` to the user.
    return res.status(400).json({ awarded: false, error: message });
  });
}
const { checkAuth } = require('../middlewares/authMiddleware');
const {
  getCategoryPlaces,
  getCategoryMorePlaces,
  recordVisit,
  getPlaceDetail,
  searchPlaces,

  // ✅ Restaurants
  getRestaurantCategories,
  getRestaurantsByCategory,
  getTopTrendingWeekRestaurants,

  // ✅ Explore redesign feed sections
  getFriendsVisitedRecently,
  getPointsBoostSpots,

  // ✅ Saved places
  savePlace,
  unsavePlace,
  getSavedPlaces,
  getSavedPlaceIds,

  // ✅ Search history
  getSearchHistory,
  addSearchHistory,
  deleteSearchHistory,
  clearSearchHistory
} = require('../controllers/exploreController');
const { getExplorePosts } = require('../controllers/mediaController');

// Category list (first page, instant)
router.get('/explore/category/:key/places', checkAuth, getCategoryPlaces);

// Load more places (pagination)
router.get('/explore/category/:key/more', checkAuth, getCategoryMorePlaces);

// Manual search
router.get('/explore/search', checkAuth, searchPlaces);

// Explore posts feed (friends first, then public)
router.get('/explore/posts', checkAuth, getExplorePosts);

// Optional detail
router.get('/explore/place/:placeId', checkAuth, getPlaceDetail);

// ===================== Explore redesign feed =====================
// "Spots Your Friends Visited Recently" — friends' check-ins, newest first.
router.get('/explore/friends-visited', checkAuth, getFriendsVisitedRecently);

// "Spots to Boost Your Points" — highest-value nearby places not yet visited.
router.get('/explore/points-boost', checkAuth, getPointsBoostSpots);

// ===================== Saved places =====================
// Full cards for the Saved screen; ids only for marking bookmarks on the feed.
router.get('/explore/saved', checkAuth, getSavedPlaces);
router.get('/explore/saved/ids', checkAuth, getSavedPlaceIds);
router.post('/explore/saved', checkAuth, savePlace);
router.delete('/explore/saved/:placeId', checkAuth, unsavePlace);

// ===================== Search history =====================
// DELETE with no id clears the lot; with an id removes that one entry.
router.get('/explore/search-history', checkAuth, getSearchHistory);
router.post('/explore/search-history', checkAuth, addSearchHistory);
router.delete('/explore/search-history', checkAuth, clearSearchHistory);
router.delete('/explore/search-history/:id', checkAuth, deleteSearchHistory);

// Visit/Check-in → points award. Accepts an optional evidence photo
// (multipart field "media"); JSON-only clients still work (no file).
router.post('/explore/visit', checkAuth, uploadEvidence, recordVisit);

// ===================== Restaurants =====================
// Tabs list: Trending | Popular | Bars | Outdoors | Events
router.get('/restaurants/categories', checkAuth, getRestaurantCategories);

// Category wise places
router.get('/restaurants/category/:key/places', checkAuth, getRestaurantsByCategory);
router.get(
  '/restaurants/top-trending/week',
  checkAuth,
  getTopTrendingWeekRestaurants
);

module.exports = router;
