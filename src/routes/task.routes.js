const express = require('express');
const ctrl = require('../controllers/task.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/', requireRole('valet', 'admin'), ctrl.create);
router.patch('/:id/assign', requireRole('valet', 'admin'), ctrl.assignDriver);
router.patch('/:id/key-collected', requireRole('valet', 'admin'), ctrl.keyCollected);
router.patch('/:id/in-transit', requireRole('driver', 'admin'), ctrl.inTransit);
router.patch('/:id/park', requireRole('driver', 'admin'), ctrl.park);
router.patch('/:id/retrieve', requireRole('driver', 'admin'), ctrl.retrieve);
router.patch('/:id/location', requireRole('driver', 'admin'), ctrl.updateLocation);

module.exports = router;
