const express = require('express');
const ctrl = require('../controllers/user.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/by-card/:code', requireRole('valet', 'admin'), ctrl.lookupByCardCode);

module.exports = router;
