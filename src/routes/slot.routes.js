const express = require('express');
const ctrl = require('../controllers/slot.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.list);
router.get('/occupancy', ctrl.occupancy);

module.exports = router;
