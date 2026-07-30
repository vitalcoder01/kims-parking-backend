const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const visitorService = require('../services/visitor.service');
const notificationService = require('../services/notification.service');
const { serializeVisitor, serializeVisitorPublic } = require('../utils/serialize');
const parseId = require('../utils/parseId');

const list = asyncHandler(async (req, res) => {
  const visitors = await visitorService.listVisitors();
  res.json({ visitors: visitors.map(serializeVisitor) });
});

// Creates the visitor record + token. The mobile app is responsible for
// opening the WhatsApp deep link with this token — that's a client-side
// action (Linking.openURL), not something this API performs.
const create = asyncHandler(async (req, res) => {
  const { name, carNumber, mobile, vehicleType } = req.body;
  // carNumber is optional — the plate may not be available at intake.
  if (!name || !mobile) {
    throw ApiError.badRequest('name and mobile are required');
  }
  const visitor = await visitorService.createVisitor({ name, carNumber, mobile, vehicleType, valetId: req.user.id });
  res.status(201).json({ visitor: serializeVisitor(visitor) });
});

// Driver: accept / reject the assigned pickup, and confirm physical key
// collection — the driver id always comes from the caller's own session.
const requireOwnDriverId = (req) => {
  const driverId = req.user.driver?.id;
  if (!driverId && req.user.role !== 'admin') throw ApiError.forbidden('Only drivers can do this');
  return driverId ?? parseId(req.body.driverId);
};

const accept = asyncHandler(async (req, res) => {
  const visitor = await visitorService.acceptTask(parseId(req.params.id), requireOwnDriverId(req));
  res.json({ visitor: serializeVisitor(visitor) });
});

const reject = asyncHandler(async (req, res) => {
  const visitor = await visitorService.rejectTask(parseId(req.params.id), requireOwnDriverId(req));
  res.json({ visitor: serializeVisitor(visitor) });
});

const pickup = asyncHandler(async (req, res) => {
  const visitor = await visitorService.markPickedUp(parseId(req.params.id), requireOwnDriverId(req));
  res.json({ visitor: serializeVisitor(visitor) });
});

// Valet: cancel a pending visitor (no-show / valet cancelled / parking failed).
const cancel = asyncHandler(async (req, res) => {
  const visitor = await visitorService.cancelVisitor(parseId(req.params.id), req.body.reason);
  res.json({ visitor: serializeVisitor(visitor) });
});

const update = asyncHandler(async (req, res) => {
  const visitor = await visitorService.updateVisitor(parseId(req.params.id), req.body);
  res.json({ visitor: serializeVisitor(visitor) });
});

// Valet: assign an available driver to collect the key / bring the car back.
const assignDriver = asyncHandler(async (req, res) => {
  const { driverId } = req.body;
  if (!driverId) throw ApiError.badRequest('driverId is required');
  const visitor = await visitorService.assignDriver(parseId(req.params.id), parseId(driverId), req.user.id);
  res.json({ visitor: serializeVisitor(visitor) });
});

// Same gap task.controller.js had: park/retrieve are driver actions but
// never verified the caller was actually the driver assigned to this job.
async function assertOwnDriverVisitor(req, id) {
  const visitor = await visitorService.getVisitor(id);
  if (req.user.role !== 'admin' && visitor.driverId !== req.user.driver?.id) {
    throw ApiError.forbidden('You are not the driver assigned to this pickup');
  }
  return visitor;
}

const park = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  await assertOwnDriverVisitor(req, id);
  // slotId optional — omitted means "auto-assign the next free slot".
  const visitor = await visitorService.markParked(id, req.body?.slotId);
  res.json({ visitor: serializeVisitor(visitor) });
});

// Valet: assign (or reassign) a driver to a retrieval — either one they're
// raising themselves or one the visitor already flagged from the tracking
// page (selfRequestRetrieval below).
const assignRetrievalDriver = asyncHandler(async (req, res) => {
  const { driverId } = req.body;
  if (!driverId) throw ApiError.badRequest('driverId is required');
  const visitor = await visitorService.assignRetrievalDriver(parseId(req.params.id), parseId(driverId));
  res.json({ visitor: serializeVisitor(visitor) });
});

const retrieve = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  await assertOwnDriverVisitor(req, id);
  const visitor = await visitorService.markRetrieved(id);
  res.json({ visitor: serializeVisitor(visitor) });
});

// Valet: confirms the visitor actually came and took the car.
const confirmDelivered = asyncHandler(async (req, res) => {
  const visitor = await visitorService.confirmDelivered(parseId(req.params.id));
  res.json({ visitor: serializeVisitor(visitor) });
});

// Public (no auth) — backs the WhatsApp tracking link/page. Only exposes
// fields safe to show to an unauthenticated visitor (no mobile number).
const track = asyncHandler(async (req, res) => {
  const visitor = await visitorService.trackById(req.params.id);
  res.json({ visitor: serializeVisitorPublic(visitor) });
});

// Public (no auth) — the tracking page's "Request My Car" button. Only
// flags the request; a valet still has to assign a driver (assignRetrievalDriver
// above), same division of labor as the doctor/staff retrieval flow.
const selfRequestRetrieval = asyncHandler(async (req, res) => {
  const visitor = await visitorService.requestRetrieval(req.params.id);
  await notificationService.push({
    targetRole: 'valet',
    title: '🚗 Visitor Ready to Leave',
    body: `${visitor.name} requested their car (${visitor.carNumber}) back from slot ${visitor.slotId ?? ''}.`,
    type: 'info',
  }).catch(() => {});
  res.json({ visitor: serializeVisitorPublic(visitor) });
});

module.exports = { list, create, update, assignDriver, accept, reject, pickup, cancel, park, assignRetrievalDriver, retrieve, confirmDelivered, track, selfRequestRetrieval };
