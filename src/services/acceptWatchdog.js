// Server-side accept timeout: when a driver is assigned (task or visitor
// job) they must accept within the admin-configured window, or the
// assignment is rolled back, the driver freed, and the valet loudly asked
// to pick someone else. Lives server-side so it fires even if every phone
// involved is locked in a pocket.
const prisma = require('../config/database');
const cache = require('../utils/responseCache');
const settingService = require('./setting.service');
const notificationService = require('./notification.service');
const realtime = require('../realtime');
const { serializeTask, serializeVisitor } = require('../utils/serialize');

const taskInclude = { doctor: true, driver: { include: { user: true } } };
const visitorInclude = { driver: { include: { user: true } } };

// One pending timer per job. In-memory is fine: a server restart only loses
// in-flight countdowns, and those assignments simply wait for the valet to
// notice via the (still-visible) "waiting for driver" state.
const timers = new Map();

function key(kind, id) { return `${kind}:${id}`; }

function disarm(kind, id) {
  const k = key(kind, id);
  const t = timers.get(k);
  if (t) { clearTimeout(t); timers.delete(k); }
}

async function arm(kind, id, driverId) {
  disarm(kind, id);
  const timeoutMs = await settingService.getAcceptTimeoutMs();
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

async function fireTaskTimeout(taskId, driverId) {
  const rolledBack = await prisma.$transaction(async (tx) => {
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
      data: { driverId: null, ...(task.type === 'retrieve' && { status: 'requested' }) },
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
  // The prompt event the valet app answers with its reassign flow.
  realtime.emitToRoles(['valet', 'admin'], 'task:needs-reassign', { task: serialized, driverName });
  await notificationService.push({
    targetRole: 'valet',
    title: '⚠️ Driver did not accept',
    body: `${driverName} didn't accept ${updated.carNumber} in time. Please assign another driver.`,
    type: 'alarm',
  }).catch(() => {});
}

async function fireVisitorTimeout(visitorId, driverId) {
  const rolledBack = await prisma.$transaction(async (tx) => {
    const visitor = await tx.visitor.findUnique({ where: { id: visitorId }, include: visitorInclude });
    if (!visitor || visitor.driverId !== driverId || visitor.acceptedAt || visitor.status !== 'pending') return null;

    const driverName = visitor.driver?.user?.name ?? 'Driver';
    const updated = await tx.visitor.update({
      where: { id: visitorId },
      data: { driverId: null, driverAssignedAt: null, trackingProgress: 0 },
      include: visitorInclude,
    });
    await tx.driver.update({ where: { id: driverId }, data: { status: 'available', currentTaskId: null } });
    return { updated, driverName };
  });
  if (!rolledBack) return;

  cache.invalidate('visitors:');
  cache.invalidate('drivers:');
  const { updated, driverName } = rolledBack;
  const serialized = serializeVisitor(updated);
  realtime.emitAll('visitor:upsert', serialized);
  realtime.emitAll('driver:patch', { id: driverId, status: 'available', currentTaskId: null });
  realtime.emitToRoles(['valet', 'admin'], 'visitor:needs-reassign', { visitor: serialized, driverName });
  await notificationService.push({
    targetRole: 'valet',
    title: '⚠️ Driver did not accept',
    body: `${driverName} didn't accept ${updated.name}'s pickup in time. Please assign another driver.`,
    type: 'alarm',
  }).catch(() => {});
}

module.exports = { arm, disarm };
