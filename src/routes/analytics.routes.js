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

module.exports = router;
