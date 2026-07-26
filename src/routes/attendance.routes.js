const express = require('express');
const ctrl = require('../controllers/attendance.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/me', ctrl.myHistory);
router.post('/check-in', ctrl.checkIn);
router.post('/check-out', ctrl.checkOut);

module.exports = router;
