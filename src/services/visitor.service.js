const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const cache = require('../utils/responseCache');
const realtime = require('../realtime');
const watchdog = require('./acceptWatchdog');
const { serializeVisitor, serializeSlot } = require('../utils/serialize');

// Public tracking links carry either the publicToken (a non-numeric cuid)
// or, for old-style callers, the raw numeric id — `id` is now an Int
// column, so including it in the OR unconditionally throws a Prisma
// validation error whenever the value isn't numeric.
function publicLookupWhere(idOrToken) {
  const numeric = Number(idOrToken);
  const or = [{ publicToken: String(idOrToken) }];
  if (Number.isFinite(numeric)) or.push({ id: numeric });
  return { OR: or };
}

function generateToken() {
  return String(Math.floor(Math.random() * 900) + 100); // 3-digit, matches app
}

// Same reasoning as task.service.js listTasks — bound the default list to
// active visitors plus anything from the last 24h instead of all history.
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VISITOR_LIMIT = 100;
const CACHE_TTL_MS = 2500;
const CACHE_KEY = 'visitors:list';

const visitorInclude = {
  driver: { include: { user: true } },
};

// Realtime deltas — same contract as task.service.js: emit the changed
// record itself so clients patch in place instead of refetching.
function emitVisitor(visitor) {
  realtime.emitAll('visitor:upsert', serializeVisitor(visitor));
}
function emitDriverPatch(id, status, currentTaskId) {
  realtime.emitAll('driver:patch', { id, status, currentTaskId: currentTaskId ?? undefined });
}
function emitSlot(slot) {
  realtime.emitAll('slot:patch', serializeSlot(slot));
}

function assertTransition(visitor, allowed, action) {
  if (!allowed.includes(visitor.status)) {
    throw ApiError.conflict(`Cannot ${action} — visitor's car is currently "${visitor.status}"`);
  }
}

async function listVisitors() {
  return cache.cached(CACHE_KEY, CACHE_TTL_MS, () => prisma.visitor.findMany({
    where: { OR: [{ status: { notIn: ['retrieved', 'cancelled'] } }, { createdAt: { gte: new Date(Date.now() - DEFAULT_WINDOW_MS) } }] },
    include: visitorInclude,
    orderBy: { createdAt: 'desc' },
    take: DEFAULT_VISITOR_LIMIT,
  }));
}

async function getVisitor(id) {
  const visitor = await prisma.visitor.findUnique({ where: { id }, include: visitorInclude });
  if (!visitor) throw ApiError.notFound('Visitor not found');
  return visitor;
}

async function createVisitor({ name, carNumber, mobile, vehicleType }) {
  const visitor = await prisma.visitor.create({
    data: {
      name: name.trim(),
      // Plate is optional at intake — the app allows registering a visitor
      // before the car reaches the counter.
      carNumber: carNumber ? carNumber.trim().toUpperCase() : '',
      mobile: mobile.trim(),
      vehicleType: vehicleType === 'bike' ? 'bike' : 'car',
      token: generateToken(),
      status: 'pending',
    },
    include: visitorInclude,
  });
  cache.invalidate('visitors:');
  emitVisitor(visitor);
  return visitor;
}

async function updateVisitor(id, patch) {
  const visitor = await prisma.visitor.findUnique({ where: { id } });
  if (!visitor) throw ApiError.notFound('Visitor not found');

  const updated = await prisma.visitor.update({ where: { id }, data: patch, include: visitorInclude });
  cache.invalidate('visitors:');
  emitVisitor(updated);
  return updated;
}

// Valet: assigns an available driver to collect the key and park this
// visitor's car. Starts the accept countdown — the driver must confirm on
// their phone or the valet is prompted to reassign.
// Same in-process lock as task.service.js's assignDriver, same reason: a
// double-tap (or two different sessions) assigning this same visitor pickup
// back-to-back must not both go through as sequential "valid" reassignments.
const assigningVisitors = new Set();

async function assignDriver(visitorId, driverId) {
  if (assigningVisitors.has(visitorId)) {
    throw ApiError.conflict('This pickup is already being assigned to a driver');
  }
  assigningVisitors.add(visitorId);
  try {
    let previousDriverId = null;
    const visitor = await prisma.$transaction(async (tx) => {
      const existing = await tx.visitor.findUnique({ where: { id: visitorId } });
      if (!existing) throw ApiError.notFound('Visitor not found');
      assertTransition(existing, ['pending'], 'assign a driver');

      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw ApiError.badRequest('driverId does not reference a valid driver');
      if (driver.status !== 'available') throw ApiError.conflict('Driver is not available');

      const updated = await tx.visitor.update({
        where: { id: visitorId },
        data: { driverId, driverAssignedAt: new Date(), acceptedAt: null, pickedUpAt: null, trackingProgress: 0.25 },
        include: visitorInclude,
      });

      await tx.driver.update({ where: { id: driverId }, data: { status: 'busy', currentTaskId: visitorId } });

      // Same fix as task.service.js's assignDriver: reassigning away from
      // whoever had this before their accept/reject ever ran must free them
      // too, or they're stuck 'busy' forever on a job that's no longer theirs.
      if (existing.driverId && existing.driverId !== driverId) {
        const oldDriver = await tx.driver.findUnique({ where: { id: existing.driverId } });
        if (oldDriver?.currentTaskId === visitorId) {
          await tx.driver.update({ where: { id: existing.driverId }, data: { status: 'available', currentTaskId: null } });
          previousDriverId = existing.driverId;
        }
      }

      return updated;
    });
    cache.invalidate('visitors:');
    cache.invalidate('drivers:');
    emitVisitor(visitor);
    emitDriverPatch(driverId, 'busy', visitorId);
    if (previousDriverId) emitDriverPatch(previousDriverId, 'available', null);
    await watchdog.arm('visitor', visitorId, driverId);
    return visitor;
  } finally {
    assigningVisitors.delete(visitorId);
  }
}

// Driver: accepted the pickup — stops the accept countdown.
async function acceptTask(visitorId, driverId) {
  const visitor = await prisma.visitor.findUnique({ where: { id: visitorId }, include: visitorInclude });
  if (!visitor) throw ApiError.notFound('Visitor not found');
  if (visitor.driverId !== driverId) throw ApiError.forbidden('You are not the driver assigned to this pickup');
  assertTransition(visitor, ['pending'], 'accept');
  if (visitor.acceptedAt) return visitor;

  watchdog.disarm('visitor', visitorId);
  const updated = await prisma.visitor.update({
    where: { id: visitorId },
    data: { acceptedAt: new Date(), trackingProgress: 0.35 },
    include: visitorInclude,
  });
  cache.invalidate('visitors:');
  emitVisitor(updated);
  return updated;
}

// Driver: declined — immediate version of the accept-timeout rollback.
async function rejectTask(visitorId, driverId) {
  watchdog.disarm('visitor', visitorId);
  const result = await prisma.$transaction(async (tx) => {
    const visitor = await tx.visitor.findUnique({ where: { id: visitorId }, include: visitorInclude });
    if (!visitor) throw ApiError.notFound('Visitor not found');
    if (visitor.driverId !== driverId) throw ApiError.forbidden('You are not the driver assigned to this pickup');
    assertTransition(visitor, ['pending'], 'reject');

    const driverName = visitor.driver?.user?.name ?? 'Driver';
    const updated = await tx.visitor.update({
      where: { id: visitorId },
      data: { driverId: null, driverAssignedAt: null, acceptedAt: null, trackingProgress: 0 },
      include: visitorInclude,
    });
    await tx.driver.update({ where: { id: driverId }, data: { status: 'available', currentTaskId: null } });
    return { updated, driverName };
  });
  cache.invalidate('visitors:');
  cache.invalidate('drivers:');
  emitVisitor(result.updated);
  emitDriverPatch(driverId, 'available', null);
  realtime.emitToRoles(['valet', 'admin'], 'visitor:needs-reassign', {
    visitor: serializeVisitor(result.updated),
    driverName: result.driverName,
    rejected: true,
  });
  return result.updated;
}

// Driver: physically collected the vehicle from the valet counter.
async function markPickedUp(visitorId, driverId) {
  const visitor = await prisma.visitor.findUnique({ where: { id: visitorId }, include: visitorInclude });
  if (!visitor) throw ApiError.notFound('Visitor not found');
  if (visitor.driverId !== driverId) throw ApiError.forbidden('You are not the driver assigned to this pickup');
  assertTransition(visitor, ['pending'], 'mark picked up');

  watchdog.disarm('visitor', visitorId);
  const updated = await prisma.visitor.update({
    where: { id: visitorId },
    data: { pickedUpAt: new Date(), acceptedAt: visitor.acceptedAt ?? new Date(), trackingProgress: 0.5 },
    include: visitorInclude,
  });
  cache.invalidate('visitors:');
  emitVisitor(updated);
  return updated;
}

// Valet: cancel a pending visitor (no-show, valet cancelled, parking failed).
async function cancelVisitor(visitorId, reason) {
  watchdog.disarm('visitor', visitorId);
  const result = await prisma.$transaction(async (tx) => {
    const visitor = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!visitor) throw ApiError.notFound('Visitor not found');
    assertTransition(visitor, ['pending'], 'cancel');

    const freedDriverId = visitor.driverId;
    if (freedDriverId) {
      const driver = await tx.driver.findUnique({ where: { id: freedDriverId } });
      if (driver?.currentTaskId === visitorId) {
        await tx.driver.update({ where: { id: freedDriverId }, data: { status: 'available', currentTaskId: null } });
      }
    }

    const updated = await tx.visitor.update({
      where: { id: visitorId },
      data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason ?? 'valet_cancelled' },
      include: visitorInclude,
    });
    return { updated, freedDriverId };
  });
  cache.invalidate('visitors:');
  cache.invalidate('drivers:');
  emitVisitor(result.updated);
  if (result.freedDriverId) emitDriverPatch(result.freedDriverId, 'available', null);
  return result.updated;
}

// Driver: car has been parked. Slot may be omitted — the backend then
// auto-assigns the next free slot (what the app's park call relies on).
async function markParked(visitorId, slotId) {
  const { visitor, slot } = await prisma.$transaction(async (tx) => {
    const existing = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!existing) throw ApiError.notFound('Visitor not found');
    assertTransition(existing, ['pending'], 'mark parked');

    let slot;
    if (slotId) {
      slot = await tx.parkingSlot.findUnique({ where: { id: slotId } });
      if (!slot) throw ApiError.badRequest(`Slot ${slotId} does not exist`);
      if (slot.status !== 'free') throw ApiError.conflict(`Slot ${slotId} is not free`);
    } else {
      slot = await tx.parkingSlot.findFirst({ where: { status: 'free' }, orderBy: [{ block: 'asc' }, { number: 'asc' }] });
      if (!slot) throw ApiError.conflict('No free parking slots available');
    }

    const updatedSlot = await tx.parkingSlot.update({
      where: { id: slot.id },
      data: { status: 'occupied', carNumber: existing.carNumber },
    });

    if (existing.driverId) {
      await tx.driver.update({ where: { id: existing.driverId }, data: { status: 'available', currentTaskId: null } });
    }

    const updated = await tx.visitor.update({
      where: { id: visitorId },
      data: { slotId: slot.id, status: 'parked', trackingProgress: 1 },
      include: visitorInclude,
    });
    return { visitor: updated, slot: updatedSlot };
  });
  cache.invalidate('visitors:');
  cache.invalidate('slots:');
  cache.invalidate('drivers:');
  emitVisitor(visitor);
  emitSlot(slot);
  if (visitor.driverId) emitDriverPatch(visitor.driverId, 'available', null);
  return visitor;
}

// Visitor (public, self-service from the tracking page): flags the parked
// car for pickup. Deliberately idempotent. Never touches driverId/driver
// status — assigning a driver is still the valet's job.
async function requestRetrieval(visitorIdOrToken) {
  // Reached from the public tracking page, whose URL carries the
  // publicToken — accept either that or the raw record id.
  const existing = await prisma.visitor.findFirst({
    where: publicLookupWhere(visitorIdOrToken),
  });
  if (!existing) throw ApiError.notFound('Visitor not found');
  assertTransition(existing, ['parked'], 'request retrieval');

  if (existing.retrievalRequested) {
    return prisma.visitor.findUnique({ where: { id: existing.id }, include: visitorInclude });
  }

  const updated = await prisma.visitor.update({
    where: { id: existing.id },
    data: { retrievalRequested: true, trackingProgress: 0.75 },
    include: visitorInclude,
  });
  cache.invalidate('visitors:');
  emitVisitor(updated);
  return updated;
}

// Valet: assign (or reassign) a driver to bring a requested car back.
// `driverId` on Visitor is reused from the park leg and isn't cleared until
// the retrieval completes, so the driver's own currentTaskId is what
// disambiguates "actively out on this retrieval right now".
async function assignRetrievalDriver(visitorId, driverId) {
  const visitor = await prisma.$transaction(async (tx) => {
    const existing = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!existing) throw ApiError.notFound('Visitor not found');
    assertTransition(existing, ['parked'], 'assign a retrieval driver');

    if (existing.driverId) {
      const currentDriver = await tx.driver.findUnique({ where: { id: existing.driverId } });
      if (currentDriver?.status === 'busy' && currentDriver.currentTaskId === visitorId) {
        throw ApiError.conflict('A driver is already assigned to retrieve this car');
      }
    }

    const driver = await tx.driver.findUnique({ where: { id: driverId } });
    if (!driver) throw ApiError.badRequest('driverId does not reference a valid driver');
    if (driver.status !== 'available') throw ApiError.conflict('Driver is not available');

    await tx.driver.update({ where: { id: driverId }, data: { status: 'busy', currentTaskId: visitorId } });

    return tx.visitor.update({
      where: { id: visitorId },
      data: { driverId, retrievalRequested: true, trackingProgress: 0.85 },
      include: visitorInclude,
    });
  });
  cache.invalidate('visitors:');
  cache.invalidate('drivers:');
  emitVisitor(visitor);
  emitDriverPatch(driverId, 'busy', visitorId);
  return visitor;
}

// Driver: car handed back to the visitor at the valet counter — frees the
// slot and the driver, closes out the visit.
async function markRetrieved(visitorId) {
  const { visitor, slot } = await prisma.$transaction(async (tx) => {
    const existing = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!existing) throw ApiError.notFound('Visitor not found');
    assertTransition(existing, ['parked'], 'mark retrieved');
    if (!existing.retrievalRequested) throw ApiError.conflict('Retrieval has not been requested for this car');

    let freedSlot = null;
    if (existing.slotId) {
      const slot = await tx.parkingSlot.findUnique({ where: { id: existing.slotId } });
      if (slot?.status === 'occupied' && slot.carNumber === existing.carNumber) {
        freedSlot = await tx.parkingSlot.update({ where: { id: existing.slotId }, data: { status: 'free', taskId: null, carNumber: null, doctorId: null } });
      }
    }

    if (existing.driverId) {
      await tx.driver.update({ where: { id: existing.driverId }, data: { status: 'available', currentTaskId: null } });
    }

    const updated = await tx.visitor.update({
      where: { id: visitorId },
      // Not 'retrieved' yet — the valet still has to confirm the visitor
      // actually came and took the car (see confirmDelivered below).
      data: { status: 'delivered', retrievalRequested: false, trackingProgress: 0.95 },
      include: visitorInclude,
    });
    return { visitor: updated, slot: freedSlot };
  });
  cache.invalidate('visitors:');
  cache.invalidate('slots:');
  cache.invalidate('drivers:');
  emitVisitor(visitor);
  if (slot) emitSlot(slot);
  if (visitor.driverId) emitDriverPatch(visitor.driverId, 'available', null);
  return visitor;
}

// Valet: confirms the visitor actually came and took the car — the only
// thing that finally closes out a retrieval, mirroring task.service.js's
// confirmDelivered for staff/doctor tasks.
async function confirmDelivered(visitorId) {
  const existing = await prisma.visitor.findUnique({ where: { id: visitorId } });
  if (!existing) throw ApiError.notFound('Visitor not found');
  assertTransition(existing, ['delivered'], 'confirm handed to owner');

  const updated = await prisma.visitor.update({
    where: { id: visitorId },
    data: { status: 'retrieved', trackingProgress: 1 },
    include: visitorInclude,
  });
  cache.invalidate('visitors:');
  emitVisitor(updated);
  return updated;
}

// Public (no auth) — the WhatsApp tracking link resolves the visitor by the
// unguessable publicToken; plain record id still accepted for older links.
async function trackByPublicToken(idOrToken) {
  const visitor = await prisma.visitor.findFirst({
    where: publicLookupWhere(idOrToken),
    include: visitorInclude,
  });
  if (!visitor) throw ApiError.notFound('Tracking link not found');
  return visitor;
}

module.exports = {
  listVisitors, getVisitor, createVisitor, updateVisitor,
  assignDriver, acceptTask, rejectTask, markPickedUp, cancelVisitor,
  markParked, requestRetrieval, assignRetrievalDriver, markRetrieved, confirmDelivered,
  trackByPublicToken,
  // Back-compat alias for existing callers (track page controller).
  trackById: trackByPublicToken,
};
