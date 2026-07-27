const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const cache = require('../utils/responseCache');

function generateToken() {
  return String(Math.floor(Math.random() * 900) + 100); // 3-digit, matches app
}

// Same reasoning as task.service.js listTasks — polled every ~4s with no
// filters, so bound it to active visitors plus anything from the last 24h
// instead of the entire all-time history.
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VISITOR_LIMIT = 100;
const CACHE_TTL_MS = 2500;
const CACHE_KEY = 'visitors:list';

const visitorInclude = {
  driver: { include: { user: true } },
};

function assertTransition(visitor, allowed, action) {
  if (!allowed.includes(visitor.status)) {
    throw ApiError.conflict(`Cannot ${action} — visitor's car is currently "${visitor.status}"`);
  }
}

async function listVisitors() {
  return cache.cached(CACHE_KEY, CACHE_TTL_MS, () => prisma.visitor.findMany({
    where: { OR: [{ status: { not: 'retrieved' } }, { createdAt: { gte: new Date(Date.now() - DEFAULT_WINDOW_MS) } }] },
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

async function createVisitor({ name, carNumber, mobile }) {
  const visitor = await prisma.visitor.create({
    data: {
      name: name.trim(),
      carNumber: carNumber.trim().toUpperCase(),
      mobile: mobile.trim(),
      token: generateToken(),
      status: 'pending',
    },
    include: visitorInclude,
  });
  cache.invalidate('visitors:');
  return visitor;
}

async function updateVisitor(id, patch) {
  const visitor = await prisma.visitor.findUnique({ where: { id } });
  if (!visitor) throw ApiError.notFound('Visitor not found');

  const updated = await prisma.visitor.update({ where: { id }, data: patch, include: visitorInclude });
  cache.invalidate('visitors:');
  return updated;
}

// Valet: assigns an available driver to collect the key and park this
// visitor's car — the same handoff a doctor/staff "Collect Key" flow gets,
// so a visitor token never sits unattended after the WhatsApp message goes out.
async function assignDriver(visitorId, driverId) {
  const visitor = await prisma.$transaction(async (tx) => {
    const existing = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!existing) throw ApiError.notFound('Visitor not found');
    assertTransition(existing, ['pending'], 'assign a driver');

    const driver = await tx.driver.findUnique({ where: { id: driverId } });
    if (!driver) throw ApiError.badRequest('driverId does not reference a valid driver');
    if (driver.status !== 'available') throw ApiError.conflict('Driver is not available');

    const updated = await tx.visitor.update({
      where: { id: visitorId },
      data: { driverId, trackingProgress: 0.25 },
      include: visitorInclude,
    });

    await tx.driver.update({ where: { id: driverId }, data: { status: 'busy', currentTaskId: visitorId } });

    return updated;
  });
  cache.invalidate('visitors:');
  cache.invalidate('drivers:');
  return visitor;
}

// Driver: car has been parked — occupies the slot, frees the driver.
async function markParked(visitorId, slotId) {
  const visitor = await prisma.$transaction(async (tx) => {
    const existing = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!existing) throw ApiError.notFound('Visitor not found');
    assertTransition(existing, ['pending'], 'mark parked');

    const slot = await tx.parkingSlot.findUnique({ where: { id: slotId } });
    if (!slot) throw ApiError.badRequest(`Slot ${slotId} does not exist`);
    if (slot.status !== 'free') throw ApiError.conflict(`Slot ${slotId} is not free`);

    await tx.parkingSlot.update({
      where: { id: slotId },
      data: { status: 'occupied', carNumber: existing.carNumber },
    });

    if (existing.driverId) {
      await tx.driver.update({ where: { id: existing.driverId }, data: { status: 'available', currentTaskId: null } });
    }

    return tx.visitor.update({
      where: { id: visitorId },
      data: { slotId, status: 'parked', trackingProgress: 1 },
      include: visitorInclude,
    });
  });
  cache.invalidate('visitors:');
  cache.invalidate('slots:');
  cache.invalidate('drivers:');
  return visitor;
}

// Valet: visitor is ready to leave — flags the parked car for pickup and, if
// a driver is given, assigns them immediately (mirrors task assignDriver).
async function requestRetrieval(visitorId, driverId) {
  const visitor = await prisma.$transaction(async (tx) => {
    const existing = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!existing) throw ApiError.notFound('Visitor not found');
    assertTransition(existing, ['parked'], 'request retrieval');
    if (existing.retrievalRequested) throw ApiError.conflict('Retrieval has already been requested for this car');

    const data = { retrievalRequested: true, trackingProgress: 0.75 };

    if (driverId) {
      const driver = await tx.driver.findUnique({ where: { id: driverId } });
      if (!driver) throw ApiError.badRequest('driverId does not reference a valid driver');
      if (driver.status !== 'available') throw ApiError.conflict('Driver is not available');
      data.driverId = driverId;
      await tx.driver.update({ where: { id: driverId }, data: { status: 'busy', currentTaskId: visitorId } });
    }

    return tx.visitor.update({ where: { id: visitorId }, data, include: visitorInclude });
  });
  cache.invalidate('visitors:');
  cache.invalidate('drivers:');
  return visitor;
}

// Driver: car handed back to the visitor at the valet counter — frees the
// slot and the driver, closes out the visit.
async function markRetrieved(visitorId) {
  const visitor = await prisma.$transaction(async (tx) => {
    const existing = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!existing) throw ApiError.notFound('Visitor not found');
    assertTransition(existing, ['parked'], 'mark retrieved');
    if (!existing.retrievalRequested) throw ApiError.conflict('Retrieval has not been requested for this car');

    if (existing.slotId) {
      const slot = await tx.parkingSlot.findUnique({ where: { id: existing.slotId } });
      if (slot?.status === 'occupied' && slot.carNumber === existing.carNumber) {
        await tx.parkingSlot.update({ where: { id: existing.slotId }, data: { status: 'free', taskId: null, carNumber: null, doctorId: null } });
      }
    }

    if (existing.driverId) {
      await tx.driver.update({ where: { id: existing.driverId }, data: { status: 'available', currentTaskId: null } });
    }

    return tx.visitor.update({
      where: { id: visitorId },
      data: { status: 'retrieved', retrievalRequested: false, trackingProgress: 1 },
      include: visitorInclude,
    });
  });
  cache.invalidate('visitors:');
  cache.invalidate('slots:');
  cache.invalidate('drivers:');
  return visitor;
}

// Public (no auth) — the WhatsApp tracking link resolves the visitor by
// their record id, not the 3-digit token (that token isn't guaranteed
// globally unique and is only meant to be read aloud/shown at the counter).
async function trackById(id) {
  const visitor = await prisma.visitor.findUnique({ where: { id }, include: visitorInclude });
  if (!visitor) throw ApiError.notFound('Tracking link not found');
  return visitor;
}

module.exports = {
  listVisitors, getVisitor, createVisitor, updateVisitor,
  assignDriver, markParked, requestRetrieval, markRetrieved, trackById,
};
