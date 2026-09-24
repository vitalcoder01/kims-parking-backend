const express = require('express');
const ctrl = require('../controllers/slot.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth, requireRole('valet', 'admin'));

router.get('/', ctrl.list);
router.get('/occupancy', ctrl.occupancy);

module.exports = router;
