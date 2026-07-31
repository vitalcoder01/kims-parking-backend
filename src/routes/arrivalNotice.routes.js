const express = require('express');
const ctrl = require('../controllers/arrivalNotice.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', requireRole('valet', 'admin'), ctrl.list);
router.post('/', requireRole('doctor', 'staff', 'admin'), ctrl.create);
router.patch('/:id/accept', requireRole('valet'), ctrl.accept);
router.patch('/:id/dismiss', requireRole('valet', 'admin'), ctrl.dismiss);

module.exports = router;
