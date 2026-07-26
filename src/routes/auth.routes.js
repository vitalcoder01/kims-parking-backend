const express = require('express');
const rateLimit = require('express-rate-limit');
const { login, me } = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();

// Brute-force guard: real credentials only need a handful of attempts. Keyed
// on the employeeId being attempted (not IP) — many staff share one hospital
// NAT gateway, so an IP-keyed limit would lock out everyone behind it during
// a shift change; this instead only throttles repeated guesses against one
// specific account.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => (req.body?.employeeId ? String(req.body.employeeId).toUpperCase() : req.ip),
  message: { error: { message: 'Too many login attempts. Please wait a few minutes and try again.' } },
});

router.post('/login', loginLimiter, login);
router.get('/me', requireAuth, me);

module.exports = router;
