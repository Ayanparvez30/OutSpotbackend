const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminAppReviewController');

router.get('/', ctrl.index);
// Same route hides and un-hides — an accidental hide is one click from undone.
router.post('/:id/toggle', ctrl.toggleHidden);

module.exports = router;
