const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { login, me } = require('../controllers/auth.controller');
const { requireAuth } = require('../middleware/auth.middleware');

const router = express.Router();

// Brute-force guard: real credentials only need a handful of attempts. Keyed
// on the loginName being attempted (not IP) — many staff share one hospital
// NAT gateway, so an IP-keyed limit would lock out everyone behind it during
// a shift change; this instead only throttles repeated guesses against one
// specific account.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => {
    const value = req.body?.username || req.body?.loginName;
    return value ? String(value).toLowerCase() : ipKeyGenerator(req.ip);
  },
  message: { error: { message: 'Too many login attempts. Please wait a few minutes and try again.' } },
});

router.post('/login', loginLimiter, login);
router.get('/me', requireAuth, me);

module.exports = router;
