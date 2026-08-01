const express = require('express');
const ctrl = require('../controllers/task.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/', requireRole('valet', 'admin'), ctrl.create);
router.post('/request-retrieval', requireRole('doctor', 'staff', 'admin'), ctrl.requestRetrieval);
router.patch('/:id/assign', requireRole('valet', 'admin'), ctrl.assignDriver);
// Valet gives up on a driver who hasn't accepted yet — right now, instead of
// waiting out the accept-timeout window. Frees the driver, job stays open.
router.patch('/:id/cancel-assignment', requireRole('valet', 'admin'), ctrl.cancelAssignment);
router.patch('/:id/accept', requireRole('driver', 'admin'), ctrl.accept);
router.patch('/:id/reject', requireRole('driver', 'admin'), ctrl.reject);
router.patch('/:id/key-collected', requireRole('valet', 'admin'), ctrl.keyCollected);
router.patch('/:id/in-transit', requireRole('driver', 'admin'), ctrl.inTransit);
router.patch('/:id/park', requireRole('driver', 'admin'), ctrl.park);
router.patch('/:id/retrieve', requireRole('driver', 'admin'), ctrl.retrieve);
router.patch('/:id/confirm-delivered', requireRole('valet', 'admin'), ctrl.confirmDelivered);
router.patch('/:id/cancel', requireRole('valet', 'admin'), ctrl.cancel);
// Doctor/staff calling off their own departure request. Separate route from
// the valet's cancel so the caller's identity is unambiguous — the service
// scopes on it rather than trusting a body field.
router.patch('/:id/cancel-my-retrieval', requireRole('doctor', 'staff', 'admin'), ctrl.cancelMyRetrieval);
// Valet claims a departure request (owner, or recovery after the owner's
// window lapsed). First one through the door wins.
router.patch('/:id/accept-retrieval', requireRole('valet'), ctrl.acceptRetrieval);
// Valet taps "Later" on a reassign prompt — defers escalation, doesn't cancel it.
router.patch('/:id/acknowledge', requireRole('valet', 'admin'), ctrl.acknowledge);
// Valet aborts a park job already in the driver's hands — "bring it back".
router.patch('/:id/recall', requireRole('valet', 'admin'), ctrl.recall);
// Driver confirms they've brought a recalled car back to the counter.
router.patch('/:id/returned', requireRole('driver', 'admin'), ctrl.markReturned);
router.patch('/:id/location', requireRole('driver', 'admin'), ctrl.updateLocation);

module.exports = router;
