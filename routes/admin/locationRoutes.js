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
const EXPLORE_CATEGORIES = [
  { key: 'venue-events', title: 'Venue Events' },
  { key: 'outdoors', title: 'Outdoors' },
  { key: 'bars', title: 'Bars' },
  { key: 'cafes', title: 'Cafes' },
  { key: 'restaurants', title: 'Restaurants' },
];
router.get('/map-spots', (req, res) => {
  res.render('admin/pages/locations/map-spots', {
    layout: 'admin/layouts/main',
    title: 'Map Spots',
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    categories: EXPLORE_CATEGORIES,
  });
});

// Spot Suggestions — admin UI / design + flow only, MOCK data (no API/schema
// yet). Wire frontend + backend later.
const MOCK_SUGGESTIONS = [
  { id: 1, user: 'maya.k', initials: 'MA', color: '#e0457b', name: 'Rooftop 88', address: '88 Mulberry St, 12th fl, New York', city: 'New York', type: 'Bar', snaps: 3, submitted: '2026-06-24 21:14', status: 'new', lat: 40.7185, lng: -73.9975, note: 'Hidden rooftop above a noodle spot. Insane skyline view at sunset, 21+.' },
  { id: 2, user: 'diego_runs', initials: 'DI', color: '#1f9d8f', name: 'Echo Park Drumming Circle', address: 'Echo Park Lake, west lawn, Los Angeles', city: 'Los Angeles', type: 'Event (Outdoor)', snaps: 2, submitted: '2026-06-24 18:02', status: 'reviewing', lat: 34.0722, lng: -118.2603, note: 'Sunday drum circle by the lake. Big lively crowd.' },
  { id: 3, user: 'theoplays', initials: 'TH', color: '#2f7be0', name: 'Tinta Coffee', address: '1145 Valencia St, San Francisco', city: 'San Francisco', type: 'Cafe', snaps: 4, submitted: '2026-06-23 09:30', status: 'new', lat: 37.7553, lng: -122.4209, note: 'Tiny corner cafe — amazing cortado and pastries.' },
  { id: 4, user: 'nyc_walker', initials: 'NY', color: '#e0683c', name: 'Smorgasburg WB', address: '90 Kent Ave, New York', city: 'New York', type: 'Event (Outdoor)', snaps: 2, submitted: '2026-06-22 14:45', status: 'approved', lat: 40.7216, lng: -73.9617, note: 'Weekend food market on the waterfront.' },
  { id: 5, user: 'kai_v', initials: 'KA', color: '#7b51f3', name: 'Definitely a real place', address: 'Nowhere blvd, —', city: '', type: 'Venue', snaps: 0, submitted: '2026-06-21 02:10', status: 'rejected', lat: 0, lng: 0, note: 'Trust me bro.' },
];
router.get('/spot-suggestions', (req, res) => {
  res.render('admin/pages/locations/spot-suggestions', {
    layout: 'admin/layouts/main',
    title: 'Spot Suggestions',
    mapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    categories: EXPLORE_CATEGORIES,
    suggestions: MOCK_SUGGESTIONS,
  });
});

router.post('/:id/adjust', ctrl.adjustPoints);
router.post('/:id/delete', ctrl.removePoint);

module.exports = router;
