// Server-side accept timeout: when a driver is assigned (task or visitor
// job) they must accept within the admin-configured window, or the
// assignment is rolled back, the driver freed, and the valet loudly asked
// to pick someone else. Lives server-side so it fires even if every phone
// involved is locked in a pocket.
const prisma = require('../config/database');
const runSerializable = require('../utils/runSerializable');
const cache = require('../utils/responseCache');
const settingService = require('./setting.service');
const notificationService = require('./notification.service');
const realtime = require('../realtime');
const { serializeTask, serializeVisitor } = require('../utils/serialize');
// Required lazily inside the handlers: jobAlerts pulls in notification/
// setting services, and requiring it at module load creates a cycle with
// the task/visitor services that require this watchdog.
function jobAlerts() { return require('./jobAlerts'); }

const taskInclude = { doctor: true, driver: { include: { user: true } } };
const visitorInclude = { driver: { include: { user: true } } };

// One pending timer per job. These live in memory, so a restart would
// otherwise drop every in-flight countdown on the floor — leaving those
// assignments pending forever with no timeout and no reassign prompt, since
// nothing else ever revisits them. rehydrate() below re-arms them at boot.
const timers = new Map();

function key(kind, id) { return `${kind}:${id}`; }

function disarm(kind, id) {
  const k = key(kind, id);
  const t = timers.get(k);
  if (t) { clearTimeout(t); timers.delete(k); }
}

async function arm(kind, id, driverId, timeoutOverrideMs) {
  disarm(kind, id);
  const timeoutMs = timeoutOverrideMs ?? await settingService.getAcceptTimeoutMs();
  const t = setTimeout(() => {
    timers.delete(key(kind, id));
    const fire = kind === 'task' ? fireTaskTimeout : fireVisitorTimeout;
    fire(id, driverId).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(`[acceptWatchdog] ${kind} ${id} timeout handling failed:`, err.message);
    });
  }, timeoutMs);
  timers.set(key(kind, id), t);
}

// Re-arms countdowns for assignments that were still awaiting acceptance
// when the process last stopped. Without this, a deploy or crash silently
// stranded every pending assignment: no timeout would ever fire, so the
// valet would never be prompted to reassign and the driver would stay
// marked busy indefinitely. Each one resumes with whatever remains of its
// original window (or fires almost immediately if that window has already
// elapsed while the server was down).
async function rehydrate() {
  const timeoutMs = await settingService.getAcceptTimeoutMs();
  const remainingFor = (assignedAt) => {
    if (!assignedAt) return 1000;
    return Math.max(1000, timeoutMs - (Date.now() - new Date(assignedAt).getTime()));
  };

  const [tasks, visitors] = await Promise.all([
    prisma.parkingTask.findMany({
      where: { status: 'assigned', driverId: { not: null }, acceptedAt: null },
      select: { id: true, driverId: true, assignedAt: true },
    }),
    prisma.visitor.findMany({
      where: { status: 'pending', driverId: { not: null }, acceptedAt: null },
      select: { id: true, driverId: true, driverAssignedAt: true },
    }),
  ]);

  for (const t of tasks) await arm('task', t.id, t.driverId, remainingFor(t.assignedAt));
  for (const v of visitors) await arm('visitor', v.id, v.driverId, remainingFor(v.driverAssignedAt));

  const count = tasks.length + visitors.length;
  if (count > 0) {
    // eslint-disable-next-line no-console
    console.log(`[acceptWatchdog] re-armed ${count} pending assignment(s) after restart`);
  }
  return count;
}

async function fireTaskTimeout(taskId, driverId) {
  // MUST be serializable. The guard below ("has the driver accepted yet?")
  // is only meaningful if it can't be invalidated between the read and the
  // write — and acceptTask runs serializable, so at Read Committed the two
  // simply don't serialize against each other:
  //
  //   accept  reads acceptedAt=null ... commits acceptedAt=now
  //   timeout reads acceptedAt=null ......... commits driverId=null
  //
  // Both succeed, and the task ends up accepted-but-driverless: the driver
  // sees the job vanish after they accepted it, while the valet is told
  // "driver did not accept" and asked to reassign — repeatedly.
  const rolledBack = await runSerializable(async (tx) => {
    const task = await tx.parkingTask.findUnique({ where: { id: taskId }, include: taskInclude });
    // Only roll back if this exact assignment is still pending acceptance —
    // an accept, reject, reassign, or completion in the meantime wins.
    if (!task || task.driverId !== driverId || task.acceptedAt || task.status !== 'assigned') return null;

    const driverName = task.driver?.user?.name ?? 'Driver';
    const updated = await tx.parkingTask.update({
      where: { id: taskId },
      // Retrieve jobs fall back to 'requested' so they reappear in the
      // valet's Retrieval Requests list with its Assign button; park jobs
      // stay 'assigned' with no driver ("Waiting for driver").
      // acceptedAt cleared too: a rolled-back assignment must leave no trace
      // of an acceptance, or the next assign/accept reasons about a stale one.
      data: { driverId: null, acceptedAt: null, ...(task.type === 'retrieve' && { status: task.retrievalOwnerValetId ? 'accepted' : 'requested' }) },
      include: taskInclude,
    });
    await tx.driver.update({ where: { id: driverId }, data: { status: 'available', currentTaskId: null } });
    return { updated, driverName };
  });
  if (!rolledBack) return;

  cache.invalidate('tasks:');
  cache.invalidate('drivers:');
  const { updated, driverName } = rolledBack;
  const serialized = serializeTask(updated);
  realtime.emitAll('task:upsert', serialized);
  realtime.emitAll('driver:patch', { id: driverId, status: 'available', currentTaskId: null });
  // Addressed straight at the driver who just lost it, rather than leaving
  // them to infer it from a broadcast. Their alarm notification is `ongoing`
  // — it cannot be swiped away — so if they miss this they are left holding a
  // live-looking alarm for a job that is no longer theirs.
  realtime.emitToDriver(driverId, 'assignment:cancelled', { kind: 'task', id: taskId });
  // Owner-targeted rather than broadcast to every valet — jobAlerts decides
  // who to address, and its sweep escalates if the owner doesn't act.
  await jobAlerts().alertTaskNeedsDriver(updated, driverName);
}

async function fireVisitorTimeout(visitorId, driverId) {
  // Serializable for the same reason as fireTaskTimeout above.
  const rolledBack = await runSerializable(async (tx) => {
    const visitor = await tx.visitor.findUnique({ where: { id: visitorId }, include: visitorInclude });
    if (!visitor || visitor.driverId !== driverId || visitor.acceptedAt || visitor.status !== 'pending') return null;

    const driverName = visitor.driver?.user?.name ?? 'Driver';
    const updated = await tx.visitor.update({
      where: { id: visitorId },
      data: { driverId: null, driverAssignedAt: null, acceptedAt: null, trackingProgress: 0 },
      include: visitorInclude,
    });
    // The visitor's check-in also created a real ParkingTask (see
    // visitor.service.js) that assignDriver stamped with this same
    // driverId. Freeing the driver and the visitor row without also
    // rolling THIS back left an orphaned task row still holding driverId —
    // invisible everywhere (driver shows available, visitor shows
    // unassigned) except to the DB's one-active-job-per-driver index,
    // which then blocked every future assignment of this driver with the
    // unhelpful raw constraint error, looking like driver-data corruption.
    const linkedTask = await tx.parkingTask.findFirst({ where: { visitorId, type: 'park', isCurrent: true } });
    let updatedTask = null;
    if (linkedTask && linkedTask.driverId === driverId) {
      updatedTask = await tx.parkingTask.update({
        where: { id: linkedTask.id },
        data: { driverId: null, acceptedAt: null },
        include: taskInclude,
      });
    }
    await tx.driver.update({ where: { id: driverId }, data: { status: 'available', currentTaskId: null } });
    return { updated, driverName, updatedTask };
  });
  if (!rolledBack) return;

  cache.invalidate('visitors:');
  cache.invalidate('drivers:');
  const { updated, driverName, updatedTask } = rolledBack;
  if (updatedTask) {
    cache.invalidate('tasks:');
    realtime.emitAll('task:upsert', serializeTask(updatedTask));
  }
  realtime.emitToDriver(driverId, 'assignment:cancelled', { kind: 'visitor', id: visitorId });
  const serialized = serializeVisitor(updated);
  realtime.emitAll('visitor:upsert', serialized);
  realtime.emitAll('driver:patch', { id: driverId, status: 'available', currentTaskId: null });
  await jobAlerts().alertVisitorNeedsDriver(updated, driverName);
}

// One-time startup repair for exactly the corruption fireVisitorTimeout used
// to cause before the fix above: a ParkingTask left holding a driverId with
// an active status (assigned/key_collected/in_transit) after that driver had
// already been freed elsewhere, so the driver shows "Ready" everywhere while
// the DB's one-active-job-per-driver index still silently blocks assigning
// them to anything, with only a raw constraint error to show for it. The
// invariant this restores: if a driver is genuinely on a job, that job's id
// is their own currentTaskId — anything else pointing at them is a leftover.
// Safe to run on every boot; a clean DB makes this a fast no-op query.
async function reconcileOrphanedDriverAssignments() {
  const orphaned = await prisma.parkingTask.findMany({
    where: { status: { in: ['assigned', 'key_collected', 'in_transit'] }, driverId: { not: null } },
    include: { driver: true },
  });
  const stale = orphaned.filter((t) => t.driver && t.driver.currentTaskId !== t.id);
  if (stale.length === 0) return 0;

  for (const task of stale) {
    const updated = await prisma.parkingTask.update({
      where: { id: task.id },
      data: { driverId: null, acceptedAt: null },
      include: taskInclude,
    });
    realtime.emitAll('task:upsert', serializeTask(updated));
  }
  cache.invalidate('tasks:');
  // eslint-disable-next-line no-console
  console.log(`[acceptWatchdog] reconciled ${stale.length} orphaned driver assignment(s) on boot`);
  return stale.length;
}

module.exports = { arm, disarm, rehydrate, reconcileOrphanedDriverAssignments };
