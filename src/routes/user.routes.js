const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const ctrl = require('../controllers/user.controller');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');

const router = express.Router();
router.use(requireAuth);

// Password change is the highest-value endpoint on this router — a stolen
// session token trying to rotate credentials is the exact abuse it needs to
// resist. Keyed on the authenticated user id (not IP: staff share NAT
// gateways), so bursts of guesses against one specific account get throttled
// while everyone else stays unaffected.
const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => (req.user?.id != null ? `u:${req.user.id}` : ipKeyGenerator(req.ip)),
  message: { error: { message: 'Too many password change attempts. Please wait a few minutes and try again.' } },
});

router.get('/by-card/:code', requireRole('valet', 'admin'), ctrl.lookupByCardCode);
router.patch('/me', ctrl.updateMe);
router.post('/me/password', passwordChangeLimiter, ctrl.changeMyPassword);
router.patch('/me/designation', ctrl.updateMyDesignation);

module.exports = router;
