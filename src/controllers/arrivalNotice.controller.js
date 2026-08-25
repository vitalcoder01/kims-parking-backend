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

// The caller's own open heads-up (or null) — doctor/staff only. `list`
// above is the valet's whole-queue view and stays valet/admin-scoped.
const mine = asyncHandler(async (req, res) => {
  const notice = await svc.findActiveForDoctor(req.user.id);
  res.json({ arrival: notice ? serializeArrivalNotice(notice) : null });
});

const dismiss = asyncHandler(async (req, res) => {
  // A doctor/staff member may only clear their OWN notice; valet/admin may
  // clear any. Passing undefined is what opts out of the ownership check.
  const isOwnerCancelling = req.user.role === 'doctor' || req.user.role === 'staff';
  const notice = await svc.dismiss(parseId(req.params.id), isOwnerCancelling ? req.user.id : undefined);
  res.json({ arrival: serializeArrivalNotice(notice) });
});

module.exports = { create, list, mine, accept, dismiss };
