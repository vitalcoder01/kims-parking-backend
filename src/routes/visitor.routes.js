const express = require('express');
const ctrl = require('../controllers/visitor.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.list);
router.post('/', requireRole('valet', 'admin'), ctrl.create);
router.patch('/:id', requireRole('valet', 'driver', 'admin'), ctrl.update);
router.patch('/:id/assign', requireRole('valet', 'admin'), ctrl.assignDriver);
router.patch('/:id/park', requireRole('driver', 'admin'), ctrl.park);
router.patch('/:id/assign-retrieval', requireRole('valet', 'admin'), ctrl.assignRetrievalDriver);
router.patch('/:id/retrieve', requireRole('driver', 'admin'), ctrl.retrieve);

module.exports = router;
