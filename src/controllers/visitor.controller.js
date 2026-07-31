const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const visitorService = require('../services/visitor.service');
const taskService = require('../services/task.service');
const notificationService = require('../services/notification.service');
const { serializeTask, serializeVisitor, serializeVisitorPublic } = require('../utils/serialize');
const parseId = require('../utils/parseId');

const list = asyncHandler(async (req, res) => {
  const visitors = await visitorService.listVisitors();
  res.json({ visitors: visitors.map(serializeVisitor) });
});

// Creates the visitor record + token. The mobile app is responsible for
// opening the WhatsApp deep link with this token — that's a client-side
// action (Linking.openURL), not something this API performs.
// Valet desk: find a live visitor session by token, mobile, plate or name.
const search = asyncHandler(async (req, res) => {
  const visitors = await visitorService.searchVisitors(req.query.q);
  res.json({ visitors: visitors.map(serializeVisitor) });
});

// Valet desk: the visitor is standing here and wants their car. Routed
// through taskService.requestRetrieval — the SAME function the doctor's app
// calls — so ownership, scheduling, notifications, timeout recovery and
// driver assignment are the existing ones, not a second implementation.
const requestVisitorRetrieval = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const raw = req.body?.plannedDepartureMinutes;
  const task = await taskService.requestRetrieval({
    visitorId: id,
    plannedDepartureMinutes: raw == null ? 0 : Number(raw),
  });
  // Mirrored onto the Visitor row so the tracking page, which reads Visitor,
  // reflects the request without needing to know a task exists.
  const visitor = await visitorService.markRetrievalRequested(id);
  res.status(201).json({ visitor: serializeVisitor(visitor), task: serializeTask(task) });
});

// Typeahead for the check-in form's vehicle field.
const suggestPlates = asyncHandler(async (req, res) => {
  const plates = await visitorService.suggestPlates(req.query.q);
  res.json({ plates });
});

const create = asyncHandler(async (req, res) => {
  const { name, carNumber, mobile, vehicleType } = req.body;
  // Two things must be right, for different reasons.
  //
  // The mobile number is how the token and the tracking link reach them — a
  // wrong one leaves a visitor with no way to get their car back.
  //
  // The vehicle number is how the CAR is found: it is what the valet searches
  // at the desk, what the driver matches against in the car park, and what
  // ties a slot to a person. A session without it is a car nobody can locate.
  //
  // The name stays optional — a visitor may simply decline to give one, and
  // refusing the check-in over it helps nobody.
  const digits = String(mobile ?? '').replace(/\D/g, '');
  if (digits.length !== 10) {
    throw ApiError.badRequest('A valid 10-digit mobile number is required');
  }
  if (!String(carNumber ?? '').trim()) {
    throw ApiError.badRequest('Vehicle number is required');
  }
  const visitor = await visitorService.createVisitor({
    name, carNumber, mobile: digits, vehicleType, valetId: req.user.id,
  });
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
    // JOB_GONE, same reasoning as task.service.js assertOwnDriver — this is
    // reached by a stale screen far more often than by a real intruder.
    throw ApiError.conflict('This pickup has already moved on', 'JOB_GONE');
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
// page ( below).
const assignRetrievalDriver = asyncHandler(async (req, res) => {
  const { driverId } = req.body;
  if (!driverId) throw ApiError.badRequest('driverId is required');
  const visitor = await visitorService.assignRetrievalDriver(parseId(req.params.id), parseId(driverId), req.user.id);
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


module.exports = { search, requestVisitorRetrieval, suggestPlates, list, create, update, assignDriver, accept, reject, pickup, cancel, park, assignRetrievalDriver, retrieve, confirmDelivered, track };
