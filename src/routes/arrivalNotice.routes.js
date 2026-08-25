const express = require('express');
const ctrl = require('../controllers/arrivalNotice.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', requireRole('valet', 'admin'), ctrl.list);
// Must be declared before any '/:id' route would shadow it.
router.get('/mine', requireRole('doctor', 'staff', 'admin'), ctrl.mine);
router.post('/', requireRole('doctor', 'staff', 'admin'), ctrl.create);
router.patch('/:id/accept', requireRole('valet'), ctrl.accept);
// Doctor/staff included so someone whose plans changed can take their own
// heads-up back; the controller scopes them to their own notice.
router.patch('/:id/dismiss', requireRole('valet', 'admin', 'doctor', 'staff'), ctrl.dismiss);

module.exports = router;
