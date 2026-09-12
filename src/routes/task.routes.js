const express = require('express');
const ctrl = require('../controllers/task.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/', requireRole('valet', 'admin'), ctrl.create);
// Gate-station valet: the two-station handoff model's single action for a
// new park job (collect key, assign driver, hand over the key) — see
// taskService.gateHandoff.
router.post('/gate-handoff', requireRole('valet', 'admin'), ctrl.gateHandoff);
router.post('/request-retrieval', requireRole('doctor', 'staff', 'admin'), ctrl.requestRetrieval);
router.patch('/:id/assign', requireRole('valet', 'admin'), ctrl.assignDriver);
// Valet: "Request retrieval" on behalf of a staff/doctor member (they called
// the desk instead of using their own app) — raises the request and assigns
// a driver in one step, the staff/doctor equivalent of visitors'
// PATCH /visitors/:id/assign-retrieval.
router.patch('/doctor/:doctorId/assign-retrieval', requireRole('valet', 'admin'), ctrl.assignRetrievalDriverForDoctor);
// Valet gives up on a driver who hasn't accepted yet — right now, instead of
// waiting out the accept-timeout window. Frees the driver, job stays open.
router.patch('/:id/cancel-assignment', requireRole('valet', 'admin'), ctrl.cancelAssignment);
router.patch('/:id/accept', requireRole('driver', 'admin'), ctrl.accept);
router.patch('/:id/reject', requireRole('driver', 'admin'), ctrl.reject);
router.patch('/:id/key-collected', requireRole('valet', 'admin'), ctrl.keyCollected);
router.patch('/:id/in-transit', requireRole('driver', 'admin'), ctrl.inTransit);
router.patch('/:id/park', requireRole('driver', 'admin'), ctrl.park);
// Lot-station valet: confirms the car has been parked, in place of the
// driver's own "park" action above — see taskService.confirmParkedByValet.
router.patch('/:id/confirm-parked', requireRole('valet', 'admin'), ctrl.confirmParked);
router.patch('/:id/retrieve', requireRole('driver', 'admin'), ctrl.retrieve);
// Gate-station valet: confirms the car has arrived back at the front gate,
// in place of the driver's own "retrieve" action above — see
// taskService.confirmArrivedByValet.
router.patch('/:id/confirm-arrived', requireRole('valet', 'admin'), ctrl.confirmArrived);
// Valet: "no driver available on my station — ask the other side to
// assign one." See taskService.requestOtherStationDriver.
router.patch('/:id/request-other-station', requireRole('valet', 'admin'), ctrl.requestOtherStation);
router.patch('/:id/confirm-delivered', requireRole('valet', 'admin'), ctrl.confirmDelivered);
router.patch('/:id/cancel', requireRole('valet', 'admin'), ctrl.cancel);
// Close a parked session whose car already left (frees the slot).
router.patch('/:id/close-parked', requireRole('valet', 'admin'), ctrl.closeParked);
// Doctor/staff calling off their own departure request. Separate route from
// the valet's cancel so the caller's identity is unambiguous — the service
// scopes on it rather than trusting a body field.
router.patch('/:id/cancel-my-retrieval', requireRole('doctor', 'staff', 'admin'), ctrl.cancelMyRetrieval);
// Valet claims a departure request (owner, or recovery after the owner's
// window lapsed). First one through the door wins.
router.patch('/:id/accept-retrieval', requireRole('valet'), ctrl.acceptRetrieval);
// Valet taps "Later" on a reassign prompt — defers escalation, doesn't cancel it.
router.patch('/:id/acknowledge', requireRole('valet', 'admin'), ctrl.acknowledge);
router.patch('/:id/silence-driver-reminder', requireRole('valet', 'admin'), ctrl.silenceDriverReminder);
// Valet aborts a park job already in the driver's hands — "bring it back".
router.patch('/:id/recall', requireRole('valet', 'admin'), ctrl.recall);
// Driver confirms they've brought a recalled car back to the counter.
router.patch('/:id/returned', requireRole('driver', 'admin'), ctrl.markReturned);

module.exports = router;
