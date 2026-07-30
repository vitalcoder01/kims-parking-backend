const prisma = require('../config/database');
const realtime = require('../realtime');
const notificationService = require('./notification.service');
const settingService = require('./setting.service');
const { serializeTask, serializeVisitor } = require('../utils/serialize');

// Who gets told when a job needs a valet's attention (driver rejected, or
// never accepted in time).
//
// Previously every one of these woke EVERY valet on shift. Now the job's
// owning valet is alarmed alone — but "alone" is only safe with a way out,
// because a single unreachable owner (phone dead, logged out, FCM blocked
// by battery optimisation) would otherwise mean a real car with a real
// driver sits with nobody watching it. Escalating "to all valets" is a
// no-op when there is only ONE valet and they're the one who's unreachable,
// so the ladder has to end somewhere that isn't a valet at all:
//
//   1. the owning valet, alone
//   2. -> every valet, once the owner has had their window and not acted
//   3. -> admins, who can always reassign, and who are the actual backup in
//         a single-valet operation
//
// Rung 3 is why this is safe to ship. The genuine backstop, though, isn't
// any of these: it's that the job stays in the queue in a loud "needs a
// driver" state that nobody can miss on next open. A push can silently fail;
// the queue cannot.

// How long the owner gets before the rest of the valets are pulled in. Reuses
// the admin-configured driver-accept window so operations only tune one knob.
async function ownerGraceMs() {
  return settingService.getAcceptTimeoutMs();
}

function emitTaskReassign(task, driverName, rejected, scope) {
  const payload = { task: serializeTask(task), driverName, rejected, scope };
  if (scope === 'owner' && task.valetId) {
    realtime.emitToUser(task.valetId, 'task:needs-reassign', payload);
  } else {
    realtime.emitToRoles(['valet', 'admin'], 'task:needs-reassign', payload);
  }
}

function emitVisitorReassign(visitor, driverName, rejected, scope) {
  const payload = { visitor: serializeVisitor(visitor), driverName, rejected, scope };
  if (scope === 'owner' && visitor.valetId) {
    realtime.emitToUser(visitor.valetId, 'visitor:needs-reassign', payload);
  } else {
    realtime.emitToRoles(['valet', 'admin'], 'visitor:needs-reassign', payload);
  }
}

// One alert, addressed as narrowly as the job allows. An unowned job (a
// retrieval nobody has picked up yet) has no one to address, so it goes to
// everyone — that's correct, not a fallback.
async function notifyOwnerOrAll({ valetId, title, body }) {
  if (valetId) {
    return notificationService.push({ targetRole: 'valet', targetUserId: valetId, title, body, type: 'alarm' });
  }
  return notificationService.push({ targetRole: 'valet', title, body, type: 'alarm' });
}

async function alertTaskNeedsDriver(task, driverName, { rejected = false } = {}) {
  emitTaskReassign(task, driverName, rejected, task.valetId ? 'owner' : 'all');
  const why = rejected ? 'rejected the job' : "didn't accept in time";
  await notifyOwnerOrAll({
    valetId: task.valetId,
    title: '⚠️ Driver did not accept',
    body: `${driverName} ${why} for ${task.carNumber}. Please assign another driver.`,
  }).catch(() => {});
}

async function alertVisitorNeedsDriver(visitor, driverName, { rejected = false } = {}) {
  emitVisitorReassign(visitor, driverName, rejected, visitor.valetId ? 'owner' : 'all');
  const why = rejected ? 'rejected the job' : "didn't accept in time";
  await notifyOwnerOrAll({
    valetId: visitor.valetId,
    title: '⚠️ Driver did not accept',
    body: `${driverName} ${why} for ${visitor.name}'s pickup. Please assign another driver.`,
  }).catch(() => {});
}

// Rungs 2 and 3. Runs on a sweep rather than a per-job timer so it survives
// a restart for free (unlike the in-memory accept watchdog, which has to
// rehydrate itself explicitly).
const SWEEP_INTERVAL_MS = 30 * 1000;
let sweepTimer = null;

async function escalateStalledJobs() {
  const graceMs = await ownerGraceMs();
  const cutoff = new Date(Date.now() - graceMs);

  // A job is stalled if it's sitting with no driver, owned by someone who
  // hasn't acted since before the cutoff, and hasn't already been escalated.
  const [tasks, visitors] = await Promise.all([
    prisma.parkingTask.findMany({
      where: {
        status: { in: ['requested', 'assigned'] },
        driverId: null,
        valetId: { not: null },
        escalatedAt: null,
        valetClaimedAt: { lt: cutoff },
      },
      include: { doctor: true, driver: { include: { user: true } }, valet: true },
      take: 50,
    }),
    prisma.visitor.findMany({
      where: {
        status: 'pending',
        driverId: null,
        valetId: { not: null },
        escalatedAt: null,
        valetClaimedAt: { lt: cutoff },
      },
      include: { driver: { include: { user: true } } },
      take: 50,
    }),
  ]);

  for (const task of tasks) {
    await prisma.parkingTask.update({ where: { id: task.id }, data: { escalatedAt: new Date() } }).catch(() => {});
    // Rung 2: the whole valet team.
    emitTaskReassign(task, task.valet?.name ?? 'A driver', false, 'all');
    await notificationService.push({
      targetRole: 'valet',
      title: '⚠️ Unclaimed job needs a driver',
      body: `${task.carNumber} still has no driver. Please assign one.`,
      type: 'alarm',
    }).catch(() => {});
    // Rung 3: admins — the real backup when there's only one valet and
    // they're the one who's unreachable.
    await notificationService.push({
      targetRole: 'admin',
      title: '⚠️ Job unattended',
      body: `${task.carNumber} (${task.doctor?.name ?? 'staff'}) has had no driver since it was raised.`,
      type: 'alarm',
    }).catch(() => {});
  }

  for (const visitor of visitors) {
    await prisma.visitor.update({ where: { id: visitor.id }, data: { escalatedAt: new Date() } }).catch(() => {});
    emitVisitorReassign(visitor, 'A driver', false, 'all');
    await notificationService.push({
      targetRole: 'valet',
      title: '⚠️ Unclaimed pickup needs a driver',
      body: `${visitor.name}'s car still has no driver. Please assign one.`,
      type: 'alarm',
    }).catch(() => {});
    await notificationService.push({
      targetRole: 'admin',
      title: '⚠️ Visitor pickup unattended',
      body: `${visitor.name}'s pickup has had no driver since it was raised.`,
      type: 'alarm',
    }).catch(() => {});
  }

  return tasks.length + visitors.length;
}

function startEscalationSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    escalateStalledJobs().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[jobAlerts] escalation sweep failed:', err.message);
    });
  }, SWEEP_INTERVAL_MS);
  // Don't hold the process open purely for this timer.
  if (sweepTimer.unref) sweepTimer.unref();
}

function stopEscalationSweep() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

module.exports = {
  alertTaskNeedsDriver,
  alertVisitorNeedsDriver,
  escalateStalledJobs,
  startEscalationSweep,
  stopEscalationSweep,
};
