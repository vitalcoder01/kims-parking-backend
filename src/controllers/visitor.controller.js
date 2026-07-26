const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const visitorService = require('../services/visitor.service');
const { serializeVisitor } = require('../utils/serialize');

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

module.exports = { list, create, update };
