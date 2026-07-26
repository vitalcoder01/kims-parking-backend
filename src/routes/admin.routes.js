const express = require('express');
const ctrl = require('../controllers/admin.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/dashboard', ctrl.dashboard);
router.get('/users', ctrl.listUsers);
router.post('/users', ctrl.createUser);

module.exports = router;
