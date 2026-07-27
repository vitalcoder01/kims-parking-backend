const express = require('express');

const router = express.Router();

// Express auto-generates a weak ETag on every JSON response, but without an
// explicit Cache-Control an HTTP cache has no signal that it's allowed to
// store the response and revalidate it later with If-None-Match — this
// tells any conforming cache (our own axios interceptor included) that it
// is: always revalidate before reuse (max-age=0), never share across users
// (private), and don't fall back to a stale copy if revalidation fails.
router.get('*', (req, res, next) => {
  res.set('Cache-Control', 'private, max-age=0, must-revalidate');
  next();
});

router.use('/auth', require('./auth.routes'));
router.use('/users', require('./user.routes'));
router.use('/tasks', require('./task.routes'));
router.use('/drivers', require('./driver.routes'));
router.use('/slots', require('./slot.routes'));
router.use('/visitors', require('./visitor.routes'));
router.use('/notifications', require('./notification.routes'));
router.use('/attendance', require('./attendance.routes'));
router.use('/admin', require('./admin.routes'));
router.use('/track', require('./track.routes'));

router.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Public (no auth) — lets every client, even a stale/broken one, check
// whether a newer APK exists and prompt the user to install it.
router.get('/app/version', (req, res) => res.json(require('../config/appVersion')));

module.exports = router;
