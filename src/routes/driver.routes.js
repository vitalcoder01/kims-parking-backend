const express = require('express');
const ctrl = require('../controllers/driver.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.list);
router.patch('/:id/status', requireRole('driver', 'valet', 'admin'), ctrl.setStatus);

module.exports = router;
