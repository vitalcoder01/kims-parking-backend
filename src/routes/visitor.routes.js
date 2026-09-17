const express = require('express');
const ctrl = require('../controllers/visitor.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

// Valet-only — a visitor list includes plates, names and mobile numbers of
// walk-in guests; the doctors/staff who log into the same portal have no
// legitimate reason to see the walk-in registry. Fix (audit B3).
router.get('/', requireRole('valet', 'admin'), ctrl.list);
// Vehicle-number typeahead for the check-in form.
router.get('/plate-suggest', requireRole('valet', 'admin'), ctrl.suggestPlates);
// Valet desk lookup — token, mobile, plate or name.
router.get('/search', requireRole('valet', 'admin'), ctrl.search);
router.post('/', requireRole('valet', 'admin'), ctrl.create);
router.patch('/:id', requireRole('valet', 'driver', 'admin'), ctrl.update);
router.patch('/:id/assign', requireRole('valet', 'admin'), ctrl.assignDriver);
// Valet gives up on a driver who hasn't accepted this pickup yet — right
// now, instead of waiting out the accept-timeout window. Token untouched.
router.patch('/:id/cancel-assignment', requireRole('valet', 'admin'), ctrl.cancelAssignment);
router.patch('/:id/accept', requireRole('driver', 'admin'), ctrl.accept);
router.patch('/:id/reject', requireRole('driver', 'admin'), ctrl.reject);
router.patch('/:id/pickup', requireRole('driver', 'admin'), ctrl.pickup);
router.patch('/:id/cancel', requireRole('valet', 'admin'), ctrl.cancel);
// Destructive: frees the slot the visitor's car was in. Every other
// visitor mutation on this router requires valet/admin — this one was
// left without a guard, so any authenticated user could free a slot that
// still had a real car in it and the next park job would be sent there.
// Fix (audit B4).
router.patch('/:id/close-parked', requireRole('valet', 'admin'), ctrl.closeParked);
// Key's already with a driver — "bring my car back" instead of a cancel.
router.patch('/:id/recall', requireRole('valet', 'admin'), ctrl.recall);
router.patch('/:id/park', requireRole('driver', 'admin'), ctrl.park);
// Valet desk: raise a retrieval for a visitor standing at the counter. The
// visitor cannot do this themselves — there is no public equivalent.
router.post('/:id/request-retrieval', requireRole('valet', 'admin'), ctrl.requestVisitorRetrieval);
router.patch('/:id/assign-retrieval', requireRole('valet', 'admin'), ctrl.assignRetrievalDriver);
router.patch('/:id/retrieve', requireRole('driver', 'admin'), ctrl.retrieve);
router.patch('/:id/confirm-delivered', requireRole('valet', 'admin'), ctrl.confirmDelivered);

module.exports = router;
