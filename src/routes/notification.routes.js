const express = require('express');
const ctrl = require('../controllers/notification.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.listMine);
router.post('/', ctrl.push);
router.patch('/:id/read', ctrl.markRead);
router.post('/register-device', ctrl.registerDevice);
router.post('/unregister-device', ctrl.unregisterDevice);

module.exports = router;
