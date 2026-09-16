const express = require('express');
const ctrl = require('../controllers/driver.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.list);
router.patch('/:id/status', requireRole('driver', 'valet', 'admin'), ctrl.setStatus);
// Admin-only: forcibly cancels whatever job has this driver stuck and frees
// them, bypassing the normal state machine — see driverService.forceFreeDriver.
router.patch('/:id/force-free', requireRole('admin'), ctrl.forceFree);

module.exports = router;
