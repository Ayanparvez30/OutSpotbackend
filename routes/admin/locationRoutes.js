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
router.get('/map-spots', comingSoon('Map Spots'));

router.post('/:id/adjust', ctrl.adjustPoints);
router.post('/:id/delete', ctrl.removePoint);

module.exports = router;
