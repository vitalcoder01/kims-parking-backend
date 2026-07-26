const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const taskService = require('../services/task.service');
const attendanceService = require('../services/attendance.service');
const { serializeTask } = require('../utils/serialize');

const list = asyncHandler(async (req, res) => {
  const { doctorId, driverId, status, type } = req.query;
  const tasks = await taskService.listTasks({ doctorId, driverId, status, type });
  res.json({ tasks: tasks.map(serializeTask) });
});

const get = asyncHandler(async (req, res) => {
  const task = await taskService.getTask(req.params.id);
  res.json({ task: serializeTask(task) });
});

// Valet: "Key Received" — also marks the valet's attendance for today, and
// for a park task (the doctor/staff physically handing over their key),
// marks that person present too — handing your key to the valet is real
// proof you're on-site, so there's no separate manual check-in step needed.
const create = asyncHandler(async (req, res) => {
  const { type, doctorId, carNumber, slotId, destinationLat, destinationLng } = req.body;
  if (!type || !doctorId || !carNumber) {
    throw ApiError.badRequest('type, doctorId and carNumber are required');
  }

  const task = await taskService.createTask({ type, doctorId, carNumber, slotId, destinationLat, destinationLng });
  await attendanceService.incrementVehiclesHandled(req.user.id);
  if (type === 'park') {
    await attendanceService.ensurePresent(doctorId).catch(() => {});
  }

  res.status(201).json({ task: serializeTask(task) });
});

const assignDriver = asyncHandler(async (req, res) => {
  const { driverId } = req.body;
  if (!driverId) throw ApiError.badRequest('driverId is required');

  const task = await taskService.assignDriver(req.params.id, driverId);
  res.json({ task: serializeTask(task) });
});

const keyCollected = asyncHandler(async (req, res) => {
  const task = await taskService.markKeyCollected(req.params.id);
  res.json({ task: serializeTask(task) });
});

const inTransit = asyncHandler(async (req, res) => {
  const task = await taskService.markInTransit(req.params.id);
  await attendanceService.ensurePresent(req.user.id).catch(() => {});
  res.json({ task: serializeTask(task) });
});

const park = asyncHandler(async (req, res) => {
  const { slotId } = req.body;
  if (!slotId) throw ApiError.badRequest('slotId is required');

  const task = await taskService.markParked(req.params.id, slotId);
  res.json({ task: serializeTask(task) });
});

const retrieve = asyncHandler(async (req, res) => {
  const task = await taskService.markRetrieved(req.params.id);
  res.json({ task: serializeTask(task) });
});

// Driver: live GPS ping. Only the driver assigned to this task may report a
// position for it — otherwise any driver could spoof another's location.
const updateLocation = asyncHandler(async (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw ApiError.badRequest('lat and lng (numbers) are required');
  }

  const task = await taskService.getTask(req.params.id);
  if (req.user.role !== 'admin' && task.driverId !== req.user.driver?.id) {
    throw ApiError.forbidden('You are not the driver assigned to this task');
  }

  const updated = await taskService.updateLocation(req.params.id, lat, lng);
  res.json({ task: serializeTask(updated) });
});

module.exports = { list, get, create, assignDriver, keyCollected, inTransit, park, retrieve, updateLocation };
