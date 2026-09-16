const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const cache = require('../utils/responseCache');
const realtime = require('../realtime');
const { serializeDriver, serializeSlot } = require('../utils/serialize');
// task.service.js does NOT require this module, so requiring it here is
// safe — used only for emitTask, so a forcibly-cancelled job disappears
// live from whoever still has it on screen, the same way any other
// cancellation does.
const taskService = require('./task.service');

const CACHE_TTL_MS = 2500;

// Jobs each driver actually finished today, keyed by driver id.
//
// The apps have shown "N done today" since forever, but nothing ever computed
// it — the field simply did not exist on the wire, so every driver read "0
// done today", and the valet's "least busy first" ordering was comparing 0 to
// 0 on every pair. That is also what made the "Suggested" driver meaningless:
// it was whichever row the database happened to return first.
//
// One grouped query rather than a count per driver, so this stays a single
// round trip no matter how many drivers are on shift.
async function completedTodayByDriver() {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const rows = await prisma.parkingTask.groupBy({
    by: ['driverId'],
    where: { status: 'completed', completedAt: { gte: since }, driverId: { not: null } },
    _count: { _all: true },
  });
  const map = new Map();
  for (const r of rows) map.set(r.driverId, r._count._all);
  return map;
}

async function listDrivers({ status } = {}) {
  const key = `drivers:${status ?? ''}`;
  return cache.cached(key, CACHE_TTL_MS, async () => {
    const [drivers, doneToday] = await Promise.all([
      prisma.driver.findMany({
    // A Driver row can outlive its user's 'driver' role (see user.service.js
    // updateUser — it can't be hard-deleted once it has task history), so
    // this filters on the linked user's *current* role too, not just the
    // row's own existence, or a transferred-away account could still be
    // assigned new tasks.
        where: { ...(status && { status }), user: { role: 'driver' } },
        include: { user: true },
        orderBy: { createdAt: 'asc' },
      }),
      completedTodayByDriver(),
    ]);
    // Attached to the row so serializeDriver can read it without a second
    // lookup — the count is per-driver data even though it isn't a column.
    return drivers.map(d => ({ ...d, completedToday: doneToday.get(d.id) ?? 0 }));
  });
}

// The statuses that mean a driver is physically out on a job. Same set as the
// partial unique index in migration 20260730170000 — they have to agree, or
// this check passes something the database then refuses.
const ACTIVE_TASK_STATUSES = ['assigned', 'key_collected', 'in_transit'];

async function setStatus(driverId, status) {
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw ApiError.notFound('Driver not found');

  // Moving a driver off 'busy' used to be a blind write of the status column,
  // leaving currentTaskId pointing at a job that was still live. The driver
  // then LOOKED free while the database still held them: their next
  // assignment tripped the one-live-job-per-driver index and came back as
  // "This driver is already assigned to another job" — about someone the
  // valet could plainly see listed as Ready — and stayed that way until the
  // forgotten job closed. Refuse the move instead of creating that state.
  if (status !== 'busy') {
    const liveTask = await prisma.parkingTask.findFirst({
      where: { driverId, status: { in: ACTIVE_TASK_STATUSES } },
      select: { id: true, carNumber: true },
    });
    if (liveTask) {
      throw ApiError.conflict(
        `This driver is still out on ${liveTask.carNumber} — finish or cancel that job first`,
        'DRIVER_BUSY',
      );
    }
  }

  const updated = await prisma.driver.update({
    where: { id: driverId },
    // With no live job, a lingering currentTaskId is stale by definition —
    // clear it in the same write so the two can't disagree.
    data: { status, ...(status === 'busy' ? {} : { currentTaskId: null }) },
    include: { user: true },
  });
  cache.invalidate('drivers:');
  realtime.emitAll('driver:patch', serializeDriver(updated));
  return updated;
}

// Admin escape hatch. setStatus above deliberately REFUSES to free a driver
// who still has a live job — that guard is correct for the normal case
// (someone fat-fingering a status change shouldn't orphan a real trip) but
// it means a driver whose job got stuck on a state nothing can advance or
// cancel through the normal flow (a past bug, a genuinely abandoned test
// job, a driver who lost their phone mid-trip) has NO way back to available
// through any of the app's own screens. This is that way back: cancels
// whatever task(s) currently hold the driver — any status, not just the
// early ones the ordinary cancelTask allows — frees the slot if one was
// occupied, and frees the driver. Deliberately blunt and admin-only: it
// bypasses the task state machine every other path is careful never to
// bypass, so it is not something a valet gets to reach for mid-shift.
async function forceFreeDriver(driverId) {
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw ApiError.notFound('Driver not found');

  const { cancelledTaskIds, freedSlot } = await prisma.$transaction(async (tx) => {
    // The driver's own pointer is the obvious place to look, but sweep for
    // any task still claiming this driver, not just currentTaskId — one
    // live job per driver is enforced elsewhere, but this tool exists
    // precisely because something already got past that once.
    const stuckTasks = await tx.parkingTask.findMany({
      where: { driverId, status: { in: ACTIVE_TASK_STATUSES } },
    });

    let freedSlot = null;
    for (const task of stuckTasks) {
      await tx.parkingTask.update({
        where: { id: task.id },
        data: { status: 'cancelled', completedAt: new Date(), isCurrent: false },
      });
      if (task.slotId) {
        const slot = await tx.parkingSlot.findUnique({ where: { id: task.slotId } });
        // Only free it if THIS task is still the one holding it — a slot
        // that's moved on to a different task since must not be yanked
        // out from under it.
        if (slot && slot.taskId === task.id) {
          freedSlot = await tx.parkingSlot.update({
            where: { id: task.slotId },
            data: { status: 'free', carNumber: null, doctorId: null, taskId: null },
          });
        }
      }
    }

    await tx.driver.update({ where: { id: driverId }, data: { status: 'available', currentTaskId: null } });
    return { cancelledTaskIds: stuckTasks.map(t => t.id), freedSlot };
  });

  cache.invalidate('drivers:');
  if (cancelledTaskIds.length) cache.invalidate('tasks:');
  if (freedSlot) cache.invalidate('slots:');

  const updated = await prisma.driver.findUnique({ where: { id: driverId }, include: { user: true } });
  realtime.emitAll('driver:patch', serializeDriver(updated));
  if (freedSlot) realtime.emitAll('slot:patch', serializeSlot(freedSlot));
  // Broadcast each cancelled task through the SAME ownership-aware path
  // every other mutation uses, rather than a raw emit here that could show
  // it to someone isVisibleToValet would have kept it from.
  for (const taskId of cancelledTaskIds) {
    const full = await taskService.getTask(taskId).catch(() => null);
    if (!full) continue;
    taskService.emitTask(full);
    // A visitor's own ticket never mirrors a task mutation automatically
    // (see task.service.js's cancelTask — this is the same omission that
    // once left a cancelled check-in reading as a live 'pending' arrival
    // forever). Same fix, same place it's needed.
    if (full.visitorId) await taskService.syncVisitorFromTask(full).catch(() => {});
  }

  return updated;
}

module.exports = { listDrivers, setStatus, forceFreeDriver };
