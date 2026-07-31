const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const svc = require('../services/arrivalNotice.service');
const { serializeArrivalNotice } = require('../utils/serialize');
const parseId = require('../utils/parseId');

const create = asyncHandler(async (req, res) => {
  const { eta } = req.body;
  if (!eta) throw ApiError.badRequest('eta is required');
  const notice = await svc.create({ doctorId: req.user.id, eta: Number(eta) });
  res.status(201).json({ arrival: serializeArrivalNotice(notice) });
});

// Deprecated no-op, kept so old installed builds don't 404 on their Accept
// button. There is nothing to accept: an arrival is a heads-up.
const accept = asyncHandler(async (req, res) => {
  const notice = await svc.accept(parseId(req.params.id));
  res.json({ arrival: serializeArrivalNotice(notice) });
});

const list = asyncHandler(async (req, res) => {
  const notices = await svc.listActive();
  res.json({ arrivals: notices.map(serializeArrivalNotice) });
});

const dismiss = asyncHandler(async (req, res) => {
  const notice = await svc.dismiss(parseId(req.params.id));
  res.json({ arrival: serializeArrivalNotice(notice) });
});

module.exports = { create, list, accept, dismiss };
