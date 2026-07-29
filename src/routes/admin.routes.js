const express = require('express');
const ctrl = require('../controllers/admin.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/dashboard', ctrl.dashboard);
router.get('/users', ctrl.listUsers);
router.post('/users', ctrl.createUser);
router.patch('/users/:id', ctrl.updateUser);
router.patch('/users/:id/password', ctrl.resetPassword);
router.delete('/users/:id', ctrl.deleteUser);
router.get('/settings', ctrl.getSettings);
router.patch('/settings', ctrl.updateSettings);
router.get('/attendance/today', ctrl.attendanceToday);
router.get('/attendance/monthly', ctrl.attendanceMonthly);

module.exports = router;
