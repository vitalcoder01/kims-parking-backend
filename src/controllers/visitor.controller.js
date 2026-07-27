const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const visitorService = require('../services/visitor.service');
const notificationService = require('../services/notification.service');
const { serializeVisitor, serializeVisitorPublic } = require('../utils/serialize');

const list = asyncHandler(async (req, res) => {
  const visitors = await visitorService.listVisitors();
  res.json({ visitors: visitors.map(serializeVisitor) });
});

// Creates the visitor record + token. The mobile app is responsible for
// opening the WhatsApp deep link with this token — that's a client-side
// action (Linking.openURL), not something this API performs.
const create = asyncHandler(async (req, res) => {
  const { name, carNumber, mobile } = req.body;
  if (!name || !carNumber || !mobile) {
    throw ApiError.badRequest('name, carNumber and mobile are required');
  }
  const visitor = await visitorService.createVisitor({ name, carNumber, mobile });
  res.status(201).json({ visitor: serializeVisitor(visitor) });
});

const update = asyncHandler(async (req, res) => {
  const visitor = await visitorService.updateVisitor(req.params.id, req.body);
  res.json({ visitor: serializeVisitor(visitor) });
});

// Valet: assign an available driver to collect the key / bring the car back.
const assignDriver = asyncHandler(async (req, res) => {
  const { driverId } = req.body;
  if (!driverId) throw ApiError.badRequest('driverId is required');
  const visitor = await visitorService.assignDriver(req.params.id, driverId);
  res.json({ visitor: serializeVisitor(visitor) });
});

const park = asyncHandler(async (req, res) => {
  const { slotId } = req.body;
  if (!slotId) throw ApiError.badRequest('slotId is required');
  const visitor = await visitorService.markParked(req.params.id, slotId);
  res.json({ visitor: serializeVisitor(visitor) });
});

// Valet: assign (or reassign) a driver to a retrieval — either one they're
// raising themselves or one the visitor already flagged from the tracking
// page (selfRequestRetrieval below).
const assignRetrievalDriver = asyncHandler(async (req, res) => {
  const { driverId } = req.body;
  if (!driverId) throw ApiError.badRequest('driverId is required');
  const visitor = await visitorService.assignRetrievalDriver(req.params.id, driverId);
  res.json({ visitor: serializeVisitor(visitor) });
});

const retrieve = asyncHandler(async (req, res) => {
  const visitor = await visitorService.markRetrieved(req.params.id);
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

module.exports = { list, create, update, assignDriver, park, assignRetrievalDriver, retrieve, track, selfRequestRetrieval };
