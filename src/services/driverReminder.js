// Repeating "still needs a driver" reminder for a freshly-created park
// ticket — staff key-collection or a visitor check-in, both of which are
// the same ParkingTask row underneath (see createTask/createVisitor).
// Deliberately its own sweep, not folded into jobAlerts.js's escalation
// ladder: that one is a ONE-TIME grace-period escalation used for
// retrieval requests and driver rejections, and must go on behaving
// exactly as it does today. This is a tight, unconditional 60s loop to
// the owning valet alone, until either a driver is assigned or they
// explicitly silence it.
const prisma = require('../config/database');
const realtime = require('../realtime');
const notificationService = require('./notification.service');
const { serializeTask } = require('../utils/serialize');

const REMINDER_INTERVAL_MS = 60 * 1000;
// Checked more often than the reminder interval itself so a due reminder
// fires within a few seconds of its 60s mark, not up to a full tick late.
const SWEEP_TICK_MS = 15 * 1000;

async function sendDueReminders() {
  const cutoff = new Date(Date.now() - REMINDER_INTERVAL_MS);

  const due = await prisma.parkingTask.findMany({
    where: {
      type: 'park',
      status: 'assigned',
      isCurrent: true,
      driverId: null,
      valetId: { not: null },
      driverReminderSilencedAt: null,
      OR: [
        { lastDriverReminderAt: null, assignedAt: { lte: cutoff } },
        { lastDriverReminderAt: { lte: cutoff } },
      ],
    },
    take: 50,
  });

  let sent = 0;
  for (const task of due) {
    // Conditional on the exact row this read saw, so two sweep ticks (or two
    // server processes) racing the same task can't both fire — the loser's
    // update matches zero rows.
    const won = await prisma.parkingTask.updateMany({
      where: {
        id: task.id,
        driverId: null,
        driverReminderSilencedAt: null,
        lastDriverReminderAt: task.lastDriverReminderAt,
      },
      data: { lastDriverReminderAt: new Date() },
    });
    if (won.count === 0) continue;

    const fresh = await prisma.parkingTask.findUnique({
      where: { id: task.id },
      include: { doctor: true, visitor: true, driver: { include: { user: true } }, valet: true, arrivalOwnerValet: true, retrievalOwnerValet: true },
    });
    if (!fresh) continue;

    // Same event shape jobAlerts.js's reassign prompt already uses client
    // side, tagged so the client knows this one's "Later" means silence
    // (see the driverReminder handling branch), not the escalation ladder's
    // "remind me again" semantics.
    realtime.emitToUser(fresh.valetId, 'task:driver-reminder', { task: serializeTask(fresh) });
    await notificationService.push({
      targetRole: `valet:${fresh.valetId}`,
      targetUserId: fresh.valetId,
      title: '🔑 Still needs a driver',
      body: `${fresh.carNumber} still has no driver assigned.`,
      type: 'alarm',
    }).catch(() => {});
    sent += 1;
  }
  return sent;
}

async function silence(taskId) {
  await prisma.parkingTask.update({
    where: { id: taskId },
    data: { driverReminderSilencedAt: new Date() },
  }).catch(() => {});
}

let sweepTimer = null;

function startSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sendDueReminders().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[driverReminder] sweep failed:', err.message);
    });
  }, SWEEP_TICK_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}

function stopSweep() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

module.exports = { sendDueReminders, silence, startSweep, stopSweep };
