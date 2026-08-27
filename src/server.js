// Must be the very first require — loads .env.development or .env.production
// (based on NODE_ENV) before any other module (esp. the Prisma client) reads
// process.env.
const { NODE_ENV, PORT, envFile } = require('./config/env');

const app = require('./app');
const { initRealtime } = require('./realtime');

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[kims-parking-backend] ${NODE_ENV} server listening on port ${PORT} (loaded ${envFile})`);
});

initRealtime(server);

// Accept countdowns live in memory, so a deploy/crash would otherwise strand
// every assignment that was still awaiting acceptance — no timeout, no
// reassign prompt, driver stuck busy. Re-arm them from the DB on boot.
const acceptWatchdog = require('./services/acceptWatchdog');
acceptWatchdog.rehydrate().catch((err) => {
  // eslint-disable-next-line no-console
  console.warn('[kims-parking-backend] watchdog rehydrate failed:', err.message);
});

// One-time repair for any driver assignment left orphaned by a bug fixed
// alongside this (see acceptWatchdog.js) — a task still holding a driverId
// with an active status after that driver was freed elsewhere, silently
// blocking every future assignment of that driver via the DB's unique
// index. Safe to run on every boot.
acceptWatchdog.reconcileOrphanedDriverAssignments().catch((err) => {
  // eslint-disable-next-line no-console
  console.warn('[kims-parking-backend] orphaned-assignment reconcile failed:', err.message);
});

// Escalation ladder for jobs whose owning valet hasn't acted — see
// jobAlerts.js. A DB sweep rather than per-job timers, so it survives a
// restart on its own.
require('./services/jobAlerts').startEscalationSweep();

// Repeating "still needs a driver" reminder for freshly-created park
// tickets — see driverReminder.js. Deliberately separate from the
// escalation ladder above (different cadence, different silence rule).
require('./services/driverReminder').startSweep();

// Once-a-day summary of client faults, delivered over WhatsApp (and pushed to
// admins who have the app). The point of the WhatsApp path is that it needs
// neither the app nor a laptop — until now every crash report ended in a
// table nobody was looking at. Hour is FAULT_DIGEST_HOUR, local, default 20.
require('./services/faultDigest').startDigest();

async function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`\n[kims-parking-backend] ${signal} received, shutting down...`);
  const prisma = require('./config/database');
  await prisma.$disconnect();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// asyncHandler forwards every route-level rejection to Express's error
// middleware, so this only fires for rejections outside a request's
// lifecycle (a stray timer, a fire-and-forget call) — log instead of
// letting Node silently crash the whole process over one bad promise.
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[kims-parking-backend] Unhandled rejection:', reason);
});

// An uncaught synchronous exception means something is in an unknown state —
// unlike unhandledRejection, this is not safe to just log and continue from.
// Exit and let the process manager (Render) restart with a clean process.
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[kims-parking-backend] Uncaught exception, exiting:', err);
  process.exit(1);
});
