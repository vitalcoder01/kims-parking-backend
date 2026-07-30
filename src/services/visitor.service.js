const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const cache = require('../utils/responseCache');
const realtime = require('../realtime');
const watchdog = require('./acceptWatchdog');
const notificationService = require('./notification.service');
const assignLocks = require('./assignLocks');
const jobAlerts = require('./jobAlerts');
const runSerializable = require('../utils/runSerializable');
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

// Releases a driver ONLY if they're still actually on this job — mirrors
// task.service.js's helper of the same name. Blanking currentTaskId
// unconditionally would mark a driver free while they're genuinely out on
// a newer job they'd since been assigned.
async function freeDriverIfStillOn(tx, driverId, jobId) {
  if (!driverId) return false;
  const driver = await tx.driver.findUnique({ where: { id: driverId } });
  if (driver && driver.currentTaskId != null && driver.currentTaskId !== jobId) return false;
  await tx.driver.update({ where: { id: driverId }, data: { status: 'available', currentTaskId: null } });
  return true;
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

async function createVisitor({ name, carNumber, mobile, vehicleType, valetId }) {
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
      // The valet who registered this visitor owns the job.
      valetId: valetId ?? null,
      valetClaimedAt: valetId ? new Date() : null,
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
async function assignDriver(visitorId, driverId, valetId) {
  // Locks the pickup AND the driver, in the same shared registry
  // task.service.js uses — otherwise a parking task and a visitor pickup
  // could each claim this same driver at the same moment (separate locks
  // and separate ids meant neither one saw the other).
  return assignLocks.withLocks(
    [assignLocks.visitorKey(visitorId), assignLocks.driverKey(driverId)],
    'This pickup or driver is already being assigned',
    async () => {
      let previousDriverId = null;
      // Serializable, matching the task-side assign: at Read Committed two
      // concurrent assigns could both read this driver as available.
      const visitor = await runSerializable(async (tx) => {
        const existing = await tx.visitor.findUnique({ where: { id: visitorId } });
        if (!existing) throw ApiError.notFound('Visitor not found');
        assertTransition(existing, ['pending'], 'assign a driver');

        // Same rule as parking tasks: once a driver has accepted, the job is
        // theirs until it's explicitly cancelled — no silent handovers.
        if (existing.acceptedAt && existing.driverId && existing.driverId !== driverId) {
          throw ApiError.conflict('That driver has already accepted this pickup — cancel it first to reassign');
        }

        // One pickup, one valet — see task.service.js assignDriver for why
        // this lifts once the job has escalated rather than being permanent.
        if (valetId && existing.valetId && existing.valetId !== valetId && !existing.escalatedAt) {
          const owner = await tx.user.findUnique({ where: { id: existing.valetId }, select: { name: true } });
          throw ApiError.conflict(`${owner?.name ?? 'Another valet'} is handling this pickup`);
        }

        const driver = await tx.driver.findUnique({ where: { id: driverId } });
        if (!driver) throw ApiError.badRequest('driverId does not reference a valid driver');
        if (driver.status !== 'available') throw ApiError.conflict('Driver is not available');

        // Acting on the job re-stamps the claim and clears any escalation,
        // so the stall clock restarts instead of it still reading unattended.
        // Ownership follows whoever acts — see task.service.js assignDriver.
        const ownership = {
          ...(valetId ? { valetId } : {}),
          valetClaimedAt: new Date(),
          escalatedAt: null,
        };

        const updated = await tx.visitor.update({
          where: { id: visitorId },
          data: { driverId, driverAssignedAt: new Date(), acceptedAt: null, pickedUpAt: null, trackingProgress: 0.25, ...ownership },
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
      // Server-side alert, same reasoning as the task-side assign: a valet
      // whose phone dies right after this call must not leave a live
      // assignment the driver was never told about.
      notificationService.push({
        targetRole: `driver:${driverId}`,
        title: '🔔 Visitor Car Pickup!',
        body: `Collect key from valet for ${visitor.name}'s car (${visitor.carNumber ?? 'no plate'}).`,
        type: 'alarm',
      }).catch(() => {});
      await watchdog.arm('visitor', visitorId, driverId);
      return visitor;
    },
  );
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
  const result = await runSerializable(async (tx) => {
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
    await freeDriverIfStillOn(tx, driverId, visitorId);
    return { updated, driverName };
  });
  cache.invalidate('visitors:');
  cache.invalidate('drivers:');
  emitVisitor(result.updated);
  emitDriverPatch(driverId, 'available', null);
  await jobAlerts.alertVisitorNeedsDriver(result.updated, result.driverName, { rejected: true });
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
  const result = await runSerializable(async (tx) => {
    const visitor = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!visitor) throw ApiError.notFound('Visitor not found');
    assertTransition(visitor, ['pending'], 'cancel');

    const freedDriverId = visitor.driverId;
    await freeDriverIfStillOn(tx, freedDriverId, visitorId);

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
  // The slot race is handled by the conditional claim below rather than by
  // isolation level — see markParked in task.service.js for why escalating
  // to Serializable here would collide with in-flight GPS writes.
  const { visitor, slot } = await prisma.$transaction(async (tx) => {
    const existing = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!existing) throw ApiError.notFound('Visitor not found');
    assertTransition(existing, ['pending'], 'mark parked');

    // Conditional claim (`WHERE id = ? AND status = 'free'`) rather than
    // read-then-write: it's atomic at Read Committed, so two concurrent
    // auto-assigns can't both resolve to the same first free slot and both
    // write it. On the auto-assign path a lost race just means trying the
    // next candidate rather than failing the whole call.
    let updatedSlot = null;
    if (slotId) {
      const exists = await tx.parkingSlot.findUnique({ where: { id: slotId } });
      if (!exists) throw ApiError.badRequest(`Slot ${slotId} does not exist`);
      const claimed = await tx.parkingSlot.updateMany({
        where: { id: slotId, status: 'free' },
        data: { status: 'occupied', carNumber: existing.carNumber },
      });
      if (claimed.count === 0) throw ApiError.conflict(`Slot ${slotId} is not free`);
      updatedSlot = await tx.parkingSlot.findUnique({ where: { id: slotId } });
    } else {
      const candidates = await tx.parkingSlot.findMany({
        where: { status: 'free' },
        orderBy: [{ block: 'asc' }, { number: 'asc' }],
        take: 10,
      });
      if (candidates.length === 0) throw ApiError.conflict('No free parking slots available');
      for (const candidate of candidates) {
        const claimed = await tx.parkingSlot.updateMany({
          where: { id: candidate.id, status: 'free' },
          data: { status: 'occupied', carNumber: existing.carNumber },
        });
        if (claimed.count > 0) {
          updatedSlot = await tx.parkingSlot.findUnique({ where: { id: candidate.id } });
          break;
        }
      }
      if (!updatedSlot) throw ApiError.conflict('No free parking slots available');
    }
    const slot = updatedSlot;

    await freeDriverIfStillOn(tx, existing.driverId, visitorId);

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
  // This path had no lock at all — only the pickup-side assign did, so a
  // double-tap here went straight through.
  return assignLocks.withLocks(
    [assignLocks.visitorKey(visitorId), assignLocks.driverKey(driverId)],
    'This retrieval or driver is already being assigned',
    () => assignRetrievalDriverLocked(visitorId, driverId),
  );
}

async function assignRetrievalDriverLocked(visitorId, driverId) {
  const visitor = await runSerializable(async (tx) => {
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
  notificationService.push({
    targetRole: `driver:${driverId}`,
    title: '🔔 Visitor Retrieval!',
    body: `Bring ${visitor.carNumber ?? 'the car'} from slot ${visitor.slotId ?? ''} back for ${visitor.name}.`,
    type: 'alarm',
  }).catch(() => {});
  return visitor;
}

// Driver: car handed back to the visitor at the valet counter — frees the
// slot and the driver, closes out the visit.
async function markRetrieved(visitorId) {
  const { visitor, slot } = await runSerializable(async (tx) => {
    const existing = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!existing) throw ApiError.notFound('Visitor not found');
    assertTransition(existing, ['parked'], 'mark retrieved');
    if (!existing.retrievalRequested) throw ApiError.conflict('Retrieval has not been requested for this car');

    // The slot recorded on the visitor is the authority for which slot this
    // retrieval empties — requiring the plate to match too meant any drift
    // in it (an edit, different spacing/case, or no plate captured at all)
    // silently skipped the release and stranded that slot as permanently
    // occupied with nothing able to free it again.
    let freedSlot = null;
    if (existing.slotId) {
      const slot = await tx.parkingSlot.findUnique({ where: { id: existing.slotId } });
      if (slot?.status === 'occupied') {
        freedSlot = await tx.parkingSlot.update({ where: { id: existing.slotId }, data: { status: 'free', taskId: null, carNumber: null, doctorId: null } });
      }
    }

    await freeDriverIfStillOn(tx, existing.driverId, visitorId);

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
