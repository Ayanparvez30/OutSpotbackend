const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/admin/adminAppVersionController');

router.get('/', ctrl.index);
router.post('/', ctrl.save);
router.post('/:id/restore', ctrl.restore);

module.exports = router;
