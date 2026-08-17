const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const cache = require('../utils/responseCache');
const realtime = require('../realtime');
const { serializeDriver } = require('../utils/serialize');

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

module.exports = { listDrivers, setStatus };
