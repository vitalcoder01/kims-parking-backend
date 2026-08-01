const express = require('express');
const ctrl = require('../controllers/visitor.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.list);
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
router.patch('/:id/park', requireRole('driver', 'admin'), ctrl.park);
// Valet desk: raise a retrieval for a visitor standing at the counter. The
// visitor cannot do this themselves — there is no public equivalent.
router.post('/:id/request-retrieval', requireRole('valet', 'admin'), ctrl.requestVisitorRetrieval);
router.patch('/:id/assign-retrieval', requireRole('valet', 'admin'), ctrl.assignRetrievalDriver);
router.patch('/:id/retrieve', requireRole('driver', 'admin'), ctrl.retrieve);
router.patch('/:id/confirm-delivered', requireRole('valet', 'admin'), ctrl.confirmDelivered);

module.exports = router;
