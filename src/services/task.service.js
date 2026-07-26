const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const cache = require('../utils/responseCache');

const CACHE_TTL_MS = 2500;

const taskInclude = {
  doctor: true,
  driver: { include: { user: true } },
};

// A completed task is immutable, and every other transition only makes sense
// from one specific prior state — without this, e.g. re-firing key-collected
// on an already-completed task flips its status back while leaving
// completedAt/slotId in place, corrupting the record.
function assertTransition(task, allowed, action) {
  if (!allowed.includes(task.status)) {
    throw ApiError.conflict(`Cannot ${action} — task is currently "${task.status}"`);
  }
}

// The mobile app polls this every ~4s with no filters at all, so an
// unfiltered query re-sends the entire all-time task history to every
// connected client on every poll — unbounded and only gets worse as the
// hospital operates over months. When the caller doesn't ask for a specific
// status, default to "active, plus anything completed recently" and cap the
// result, which keeps the common (polling) case bounded while still
// supporting exact history queries when a status is explicitly requested.
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TASK_LIMIT = 200;

async function listTasks({ doctorId, driverId, status, type } = {}) {
  // Not per-user — every client polling with the same filters gets the same
  // rows, so dedupe concurrent pollers onto one query for a couple seconds
  // instead of every phone hitting Postgres on its own 4s tick.
  const key = `tasks:${doctorId ?? ''}:${driverId ?? ''}:${status ?? ''}:${type ?? ''}`;
  return cache.cached(key, CACHE_TTL_MS, () => prisma.parkingTask.findMany({
    where: {
      ...(doctorId && { doctorId }),
      ...(driverId && { driverId }),
      ...(type && { type }),
      ...(status
        ? { status }
        : { OR: [{ status: { not: 'completed' } }, { completedAt: { gte: new Date(Date.now() - DEFAULT_WINDOW_MS) } }] }),
    },
    include: taskInclude,
    orderBy: { createdAt: 'desc' },
    take: DEFAULT_TASK_LIMIT,
  }));
}

async function getTask(id) {
  const task = await prisma.parkingTask.findUnique({ where: { id }, include: taskInclude });
  if (!task) throw ApiError.notFound('Task not found');
  return task;
}

// Valet: "Key Received" — creates a PARK task, attendance is marked by the
// caller (controller) since it is a distinct concern from task creation.
async function createTask({ type, doctorId, carNumber, slotId, destinationLat, destinationLng }) {
  const doctor = await prisma.user.findUnique({ where: { id: doctorId } });
  if (!doctor) throw ApiError.badRequest('doctorId does not reference a valid user');

  const task = await prisma.parkingTask.create({
    data: {
      type,
      doctorId,
      carNumber: carNumber.trim().toUpperCase(),
      slotId: slotId ?? null,
      status: 'assigned',
      assignedAt: new Date(),
      destinationLat: destinationLat ?? null,
      destinationLng: destinationLng ?? null,
    },
    include: taskInclude,
  });
  cache.invalidate('tasks:');
  return task;
}

// Valet: assigns an available driver to an already-created task.
async function assignDriver(taskId, driverId) {
  const task = await prisma.$transaction(async (tx) => {
    const existing = await tx.parkingTask.findUnique({ where: { id: taskId } });
    if (!existing) throw ApiError.notFound('Task not found');
    assertTransition(existing, ['assigned'], 'assign a driver');

    const driver = await tx.driver.findUnique({ where: { id: driverId } });
    if (!driver) throw ApiError.badRequest('driverId does not reference a valid driver');
    if (driver.status !== 'available') throw ApiError.conflict('Driver is not available');

    const updated = await tx.parkingTask.update({
      where: { id: taskId },
      data: { driverId, status: 'assigned', assignedAt: new Date() },
      include: taskInclude,
    });

    await tx.driver.update({
      where: { id: driverId },
      data: { status: 'busy', currentTaskId: taskId },
    });

    return updated;
  });
  cache.invalidate('tasks:');
  cache.invalidate('drivers:');
  return task;
}

// Valet: "Mark Key Handed to Driver" — park tasks only (retrieve has no key
// handoff step). Clears any previous GPS start-anchor so the next location
// ping re-establishes it fresh for this leg of the trip.
async function markKeyCollected(taskId) {
  const task = await prisma.parkingTask.findUnique({ where: { id: taskId } });
  if (!task) throw ApiError.notFound('Task not found');
  if (task.type !== 'park') throw ApiError.conflict('Only park tasks have a key handoff step');
  assertTransition(task, ['assigned'], 'mark key collected');

  const updated = await prisma.parkingTask.update({
    where: { id: taskId },
    data: { status: 'key_collected', keyCollectedAt: new Date(), trackingProgress: 0, driverStartLat: null, driverStartLng: null },
    include: taskInclude,
  });
  cache.invalidate('tasks:');
  return updated;
}

// Driver: en route — for park tasks this follows key_collected; for retrieve
// tasks (no key handoff step) this is the driver's own "Start Retrieval" tap
// straight from "assigned", so it also clears the GPS start-anchor.
async function markInTransit(taskId) {
  const task = await prisma.parkingTask.findUnique({ where: { id: taskId } });
  if (!task) throw ApiError.notFound('Task not found');
  const allowed = task.type === 'retrieve' ? ['assigned', 'key_collected'] : ['key_collected'];
  assertTransition(task, allowed, 'start transit');

  const updated = await prisma.parkingTask.update({
    where: { id: taskId },
    data: { status: 'in_transit', driverStartLat: null, driverStartLng: null },
    include: taskInclude,
  });
  cache.invalidate('tasks:');
  return updated;
}

// Driver: "Mark Parked" — occupies the slot, frees the driver, completes the task.
async function markParked(taskId, slotId) {
  const task = await prisma.$transaction(async (tx) => {
    const task = await tx.parkingTask.findUnique({ where: { id: taskId } });
    if (!task) throw ApiError.notFound('Task not found');
    if (task.type !== 'park') throw ApiError.conflict('Only park tasks can be marked parked');
    assertTransition(task, ['key_collected', 'in_transit'], 'mark parked');

    const slot = await tx.parkingSlot.findUnique({ where: { id: slotId } });
    if (!slot) throw ApiError.badRequest(`Slot ${slotId} does not exist`);
    if (slot.status !== 'free') throw ApiError.conflict(`Slot ${slotId} is not free`);

    await tx.parkingSlot.update({
      where: { id: slotId },
      data: {
        status: 'occupied',
        carNumber: task.carNumber,
        doctorId: task.doctorId,
        taskId: task.id,
      },
    });

    if (task.driverId) {
      await tx.driver.update({
        where: { id: task.driverId },
        data: { status: 'available', currentTaskId: null },
      });
    }

    return tx.parkingTask.update({
      where: { id: taskId },
      data: { slotId, status: 'completed', completedAt: new Date(), trackingProgress: 1 },
      include: taskInclude,
    });
  });
  cache.invalidate('tasks:');
  cache.invalidate('slots:');
  cache.invalidate('drivers:');
  return task;
}

// Driver: "Car Delivered to Valet Counter" — frees the slot, frees the driver.
async function markRetrieved(taskId) {
  const task = await prisma.$transaction(async (tx) => {
    const task = await tx.parkingTask.findUnique({ where: { id: taskId } });
    if (!task) throw ApiError.notFound('Task not found');
    if (task.type !== 'retrieve') throw ApiError.conflict('Only retrieve tasks can be marked retrieved');
    assertTransition(task, ['in_transit'], 'mark retrieved');

    // Only free the slot if the car actually sitting there matches this
    // retrieval — slot.taskId still points at the original *park* task (a
    // retrieve task is a separate row), so taskId can never match `task.id`
    // here; carNumber is the real invariant that proves this is genuinely
    // the same car and not some unrelated/bad-data occupancy.
    if (task.slotId) {
      const slot = await tx.parkingSlot.findUnique({ where: { id: task.slotId } });
      if (slot?.status === 'occupied' && slot.carNumber === task.carNumber) {
        await tx.parkingSlot.update({
          where: { id: task.slotId },
          data: { status: 'free', taskId: null, carNumber: null, doctorId: null },
        });
      }
    }

    if (task.driverId) {
      await tx.driver.update({
        where: { id: task.driverId },
        data: { status: 'available', currentTaskId: null },
      });
    }

    return tx.parkingTask.update({
      where: { id: taskId },
      data: { status: 'completed', completedAt: new Date(), trackingProgress: 1 },
      include: taskInclude,
    });
  });
  cache.invalidate('tasks:');
  cache.invalidate('slots:');
  cache.invalidate('drivers:');
  return task;
}

// Driver: periodic GPS ping while en route. Ownership is enforced by the
// caller (controller) — only the driver assigned to this task may update it.
// The first ping since the last key_collected/in_transit transition becomes
// the shared start-anchor every viewer computes trip progress from.
async function updateLocation(taskId, lat, lng) {
  const task = await prisma.parkingTask.findUnique({ where: { id: taskId } });
  if (!task) throw ApiError.notFound('Task not found');
  assertTransition(task, ['key_collected', 'in_transit'], 'report location');

  const isFirstPing = task.driverStartLat == null || task.driverStartLng == null;

  const updated = await prisma.parkingTask.update({
    where: { id: taskId },
    data: {
      driverLat: lat,
      driverLng: lng,
      locationUpdatedAt: new Date(),
      ...(isFirstPing && { driverStartLat: lat, driverStartLng: lng }),
    },
    include: taskInclude,
  });
  cache.invalidate('tasks:');
  return updated;
}

module.exports = {
  listTasks,
  getTask,
  createTask,
  assignDriver,
  markKeyCollected,
  markInTransit,
  markParked,
  markRetrieved,
  updateLocation,
};
