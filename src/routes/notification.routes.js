const express = require('express');
const ctrl = require('../controllers/notification.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.listMine);
// Push arbitrary notifications — the client only calls this from
// useValetActions (valet screens) via pushNotification. Without a role
// guard here, any authenticated user — including a doctor's own account —
// could POST a targetRole of 'valetStation:gate' with a fake "Car
// requested" alarm and fire every valet's phone. Fix (audit B1).
router.post('/', requireRole('valet', 'admin'), ctrl.push);
router.patch('/:id/read', ctrl.markRead);
router.post('/register-device', ctrl.registerDevice);
router.post('/unregister-device', ctrl.unregisterDevice);

module.exports = router;
