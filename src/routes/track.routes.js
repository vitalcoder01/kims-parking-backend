const express = require('express');
const { rateLimit } = require('express-rate-limit');
const ctrl = require('../controllers/visitor.controller');

// Public — no auth. Backs the WhatsApp "track your car" link, which a
// patient/visitor opens straight from their phone with no app/login.
const router = express.Router();

// The only public *write* in this app — the global /api limiter already
// covers it, but that one's keyed generously for authenticated polling
// traffic. This is IP-keyed and much tighter: nobody legitimately taps
// "request my car" more than a couple times a minute.
const requestRetrievalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests — please wait a moment and try again.' } },
});

router.get('/:id', ctrl.track);
router.patch('/:id/request-retrieval', requestRetrievalLimiter, ctrl.selfRequestRetrieval);

module.exports = router;
