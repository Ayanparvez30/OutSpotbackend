const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminLocationController');

router.get('/', ctrl.listLocationPoints);

// Placeholders — not built yet. Render a "coming soon" page instead of
// falling through to a 404 / the Location Points list.
const comingSoon = (feature) => (req, res) =>
  res.render('admin/pages/comingSoon', {
    layout: 'admin/layouts/main',
    title: feature,
    feature,
  });
router.get('/multipliers', comingSoon('Place Multipliers'));

// Map Spots — admin UI / design + flow only (no save API or schema yet).
// Renders a real Google map (GOOGLE_MAPS_API_KEY) and the app's real categories.
// Map Spots and Spot Suggestions used to be rendered here from MOCK data.
// They are real now — see routes/admin/mapSpotRoutes.js.

router.post('/:id/adjust', ctrl.adjustPoints);
router.post('/:id/delete', ctrl.removePoint);

module.exports = router;
