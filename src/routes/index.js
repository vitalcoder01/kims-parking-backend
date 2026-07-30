const express = require('express');
const prisma = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');

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
router.use('/arrivals', require('./arrivalNotice.routes'));
router.use('/attendance', require('./attendance.routes'));
router.use('/admin', require('./admin.routes'));
router.use('/track', require('./track.routes'));

// Verifies the DB is actually reachable, not just that the process is up —
// a load balancer/uptime monitor relying on a bare "process alive" check
// would keep routing traffic to an instance whose DB connection died.
router.get('/health', asyncHandler(async (req, res) => {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB health check timed out')), 3000)),
    ]);
  } catch (err) {
    return res.status(503).json({ ok: false, time: new Date().toISOString(), error: 'Database unreachable' });
  }
  res.json({ ok: true, time: new Date().toISOString() });
}));

// Public (no auth) — lets every client, even a stale/broken one, check
// whether a newer APK exists and prompt the user to install it.
router.get('/app/version', (req, res) => res.json(require('../config/appVersion')));

module.exports = router;
