const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
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
  getSavedPlaceIds
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

// Visit/Check-in → points award. Accepts an optional evidence photo
// (multipart field "media"); JSON-only clients still work (no file).
router.post('/explore/visit', checkAuth, upload.single('media'), recordVisit);

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
