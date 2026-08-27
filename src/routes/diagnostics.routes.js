const express = require('express');
const ctrl = require('../controllers/clientError.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();

/*
 * Reporting is open to any signed-in role.
 *
 * A crash can happen on any phone, and the roles most likely to hit one are
 * exactly the ones without admin rights. Gating intake to admins would mean
 * collecting crashes only from the people least likely to crash.
 *
 * Reading is admin-only: the list is an operational view of what is broken
 * across the fleet, not something a driver has any use for.
 */
router.post('/errors', requireAuth, ctrl.report);
router.get('/errors', requireAuth, requireRole('admin'), ctrl.list);
router.patch('/errors/:id/resolve', requireAuth, requireRole('admin'), ctrl.resolve);

module.exports = router;
