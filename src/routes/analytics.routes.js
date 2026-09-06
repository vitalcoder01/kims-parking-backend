const express = require('express');
const ctrl = require('../controllers/analytics.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
// Valet AND admin — this is the one analytics surface both roles share (a
// valet sees it as their own dispatch performance view, admin as an
// operational overview), unlike /admin/* which is admin-only.
router.use(requireAuth, requireRole('valet', 'admin'));

router.get('/overview', ctrl.overview);
// Admin-only — narrows the router-level valet+admin gate above. This is
// operational depth (slot classification, funnel bottlenecks, data
// quality) a valet dashboard has no use for and shouldn't be able to poll.
router.get('/intelligence', requireRole('admin'), ctrl.intelligence);
router.get('/command-center', requireRole('admin'), ctrl.commandCenter);

module.exports = router;
