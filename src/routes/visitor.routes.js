const express = require('express');
const ctrl = require('../controllers/visitor.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.list);
router.post('/', requireRole('valet', 'admin'), ctrl.create);
router.patch('/:id', requireRole('valet', 'driver', 'admin'), ctrl.update);

module.exports = router;
