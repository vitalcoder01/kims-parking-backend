const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const taskService = require('../services/task.service');
const attendanceService = require('../services/attendance.service');
const { serializeTask } = require('../utils/serialize');
const parseId = require('../utils/parseId');

const list = asyncHandler(async (req, res) => {
  const { doctorId, driverId, status, type, history } = req.query;
  // Doctor and staff only ever have a legitimate need for their OWN tasks.
  // The list endpoint used to accept whatever ?doctorId=... the client sent
  // and just trust it, so any doctor/staff account calling GET /tasks with
  // no filter (or with someone else's id) got every task in the system —
  // every plate, driver, arrival time and slot for every other doctor.
  // Force the filter here rather than relying on the client to be polite.
  // Fix (audit B2). Valets and admins keep the wider view they need for
  // their dispatch roles.
  const scopedDoctorId = (req.user.role === 'doctor' || req.user.role === 'staff')
    ? req.user.id
    : parseId(doctorId);
  const tasks = await taskService.listTasks({
    doctorId: scopedDoctorId, driverId: parseId(driverId), status, type,
    history: history === 'true',
  });
  // Valets only see retrievals they own, or ones that have been released back
  // to the floor. Enforced server-side so a stale client can't act on a job
  // it was never shown.
  const visible = req.user.role === 'valet'
    ? await taskService.filterVisibleToValet(tasks, req.user.id)
    : tasks;
  res.json({ tasks: visible.map(serializeTask) });
});

const get = asyncHandler(async (req, res) => {
  const task = await taskService.getTask(parseId(req.params.id));
  // Same reasoning as the list scoping above — a doctor/staff account
  // fetching an arbitrary task by id had no ownership check either. Fix
  // (audit B2). Only refuse cross-owner reads for doctor/staff; valets
  // and admins have legitimate cross-task visibility.
  if ((req.user.role === 'doctor' || req.user.role === 'staff') && task.doctorId !== req.user.id) {
    throw ApiError.forbidden('This is not your car');
  }
  res.json({ task: serializeTask(task) });
});

// Valet: "Key Received" — also marks the valet's attendance for today, and
// for a park task (the doctor/staff physically handing over their key),
// marks that person present too — handing your key to the valet is real
// proof you're on-site, so there's no separate manual check-in step needed.
const create = asyncHandler(async (req, res) => {
  const { type, doctorId, carNumber, slotId } = req.body;
  if (!type || !doctorId || !carNumber) {
    throw ApiError.badRequest('type, doctorId and carNumber are required');
  }
  if (type === 'retrieve') {
    throw ApiError.badRequest('Retrieval must be requested by the doctor/staff who owns the car (POST /tasks/request-retrieval)');
  }

  // The valet making this call owns the resulting job.
  const { task, created } = await taskService.createTask({
    type, doctorId: parseId(doctorId), carNumber, slotId, valetId: req.user.id,
  });
  // A repeat call that returned the existing task (double-tap) isn't a new
  // vehicle handled — only count real creations.
  if (created) await attendanceService.incrementVehiclesHandled(req.user.id);
  await attendanceService.ensurePresent(parseId(doctorId)).catch(() => {});

  res.status(created ? 201 : 200).json({ task: serializeTask(task) });
});

// Gate-station valet: the two-station handoff model's single action for a
// new park job — collects the key, assigns the driver, and hands the key
// over, all in one tap (the driver is accepted automatically, see
// taskService.assignDriver). Same attendance side-effects as create/keyCollected
// above, since this replaces both of those for a site running this model.
const gateHandoff = asyncHandler(async (req, res) => {
  const { doctorId, carNumber, slotId, driverId } = req.body;
  if (!doctorId || !carNumber || !driverId) {
    throw ApiError.badRequest('doctorId, carNumber and driverId are required');
  }
  const task = await taskService.gateHandoff({
    doctorId: parseId(doctorId), carNumber, slotId, driverId: parseId(driverId), valetId: req.user.id,
  });
  await attendanceService.incrementVehiclesHandled(req.user.id).catch(() => {});
  await attendanceService.ensurePresent(parseId(doctorId)).catch(() => {});
  res.status(201).json({ task: serializeTask(task) });
});

// Doctor/staff: request retrieval of their own parked car. The car's real
// GPS destination is wherever they are standing right now (their own
// phone) — that's who the driver is actually bringing it back to.
const requestRetrieval = asyncHandler(async (req, res) => {
  // The doctor's planned departure — planning info for the valet team, not
  // an arrival estimate. Accepts the legacy `eta` key so an older installed
  // build keeps working through the rollout.
  const plannedDepartureMinutes = req.body.plannedDepartureMinutes ?? req.body.eta;
  const task = await taskService.requestRetrieval({
    doctorId: req.user.id,
    plannedDepartureMinutes: plannedDepartureMinutes == null ? null : Number(plannedDepartureMinutes),
  });
  res.status(201).json({ task: serializeTask(task) });
});

// Valet desk: staff/doctor called instead of using their own app and wants
// their car — raises the request only, no driver. Routed through the SAME
// taskService.requestRetrieval the doctor's own app and the visitor desk
// flow (visitor.controller.js's requestVisitorRetrieval) both call, so
// ownership, station routing, scheduling and notifications are the
// existing ones, not a second implementation. Two-station handoff model:
// this is what lets the request reach the lot valet the normal way instead
// of the calling (gate) valet short-circuiting straight to assignDriver —
// see assignRetrievalDriverForDoctor below, which still does exactly that
// combined raise-and-assign for a valet with no station (or the lot
// station, where assigning it themselves IS the normal flow).
const requestRetrievalForDoctor = asyncHandler(async (req, res) => {
  const task = await taskService.requestRetrieval({
    doctorId: parseId(req.params.doctorId),
    plannedDepartureMinutes: 0,
  });
  res.status(201).json({ task: serializeTask(task) });
});

const assignDriver = asyncHandler(async (req, res) => {
  const { driverId, lat, lng } = req.body;
  if (!driverId) throw ApiError.badRequest('driverId is required');

  const valetLocation = typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null;
  const task = await taskService.assignDriver(parseId(req.params.id), parseId(driverId), valetLocation, req.user.id);
  res.json({ task: serializeTask(task) });
});

// Valet: "Request retrieval" on behalf of a staff/doctor member who called
// the desk instead of using their own app — raises the request (if one isn't
// already live) and assigns a driver in one tap, mirroring visitor.service.js
// assignRetrievalDriver.
const assignRetrievalDriverForDoctor = asyncHandler(async (req, res) => {
  const { driverId, lat, lng } = req.body;
  if (!driverId) throw ApiError.badRequest('driverId is required');

  const valetLocation = typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null;
  const task = await taskService.assignRetrievalDriverForDoctor(
    parseId(req.params.doctorId), parseId(driverId), valetLocation, req.user.id,
  );
  res.json({ task: serializeTask(task) });
});

// Valet: give up on a driver who hasn't accepted this job yet, right now,
// instead of waiting out the accept-timeout window.
const cancelAssignment = asyncHandler(async (req, res) => {
  const task = await taskService.cancelPendingAssignment(parseId(req.params.id));
  res.json({ task: serializeTask(task) });
});

// Driver: explicit accept/decline of an assignment — ownership enforced by
// passing the caller's own driver id into the service.
const accept = asyncHandler(async (req, res) => {
  const driverId = req.user.driver?.id;
  if (!driverId && req.user.role !== 'admin') throw ApiError.forbidden('Only drivers can accept tasks');
  const task = await taskService.acceptTask(parseId(req.params.id), driverId ?? parseId(req.body.driverId));
  res.json({ task: serializeTask(task) });
});

const reject = asyncHandler(async (req, res) => {
  const driverId = req.user.driver?.id;
  if (!driverId && req.user.role !== 'admin') throw ApiError.forbidden('Only drivers can reject tasks');
  const task = await taskService.rejectTask(parseId(req.params.id), driverId ?? parseId(req.body.driverId));
  res.json({ task: serializeTask(task) });
});

const keyCollected = asyncHandler(async (req, res) => {
  const task = await taskService.markKeyCollected(parseId(req.params.id));
  res.json({ task: serializeTask(task) });
});

// Ownership is enforced inside the services now (assertOwnDriver), so it
// holds for every caller rather than only the routes that remembered to
// check. Admins pass `undefined` to opt out — they're allowed to act on any
// job, which is exactly the distinction the services can't make themselves.
const callerDriverId = (req) => (req.user.role === 'admin' ? undefined : req.user.driver?.id ?? null);

const inTransit = asyncHandler(async (req, res) => {
  const task = await taskService.markInTransit(parseId(req.params.id), callerDriverId(req));
  await attendanceService.ensurePresent(req.user.id).catch(() => {});
  res.json({ task: serializeTask(task) });
});

const park = asyncHandler(async (req, res) => {
  const { slotId } = req.body;
  if (!slotId) throw ApiError.badRequest('slotId is required');

  const task = await taskService.markParked(parseId(req.params.id), slotId, callerDriverId(req));
  res.json({ task: serializeTask(task) });
});

const retrieve = asyncHandler(async (req, res) => {
  const task = await taskService.markRetrieved(parseId(req.params.id), callerDriverId(req));
  res.json({ task: serializeTask(task) });
});

// Lot-station valet: confirms the car has been parked, in place of the
// driver's own "park" action above — see taskService.confirmParkedByValet.
const confirmParked = asyncHandler(async (req, res) => {
  const { slotId } = req.body;
  if (!slotId) throw ApiError.badRequest('slotId is required');
  const task = await taskService.confirmParkedByValet(parseId(req.params.id), slotId);
  res.json({ task: serializeTask(task) });
});

// Gate-station valet: confirms the car has arrived back at the front gate,
// in place of the driver's own "retrieve" action above — see
// taskService.confirmArrivedByValet.
const confirmArrived = asyncHandler(async (req, res) => {
  const task = await taskService.confirmArrivedByValet(parseId(req.params.id));
  res.json({ task: serializeTask(task) });
});

// Valet: "no driver available on my station — ask the other side."
const requestOtherStation = asyncHandler(async (req, res) => {
  const task = await taskService.requestOtherStationDriver(parseId(req.params.id), req.user.id);
  res.json({ task: serializeTask(task) });
});

// Valet: "Accept Retrieval". Available to the session owner inside their
// window, and to any valet once the request has been released for recovery.
// Which of those applies is decided in the service, atomically.
const acceptRetrieval = asyncHandler(async (req, res) => {
  const task = await require('../services/jobAlerts').claimRetrieval(parseId(req.params.id), req.user.id);
  res.json({ task: serializeTask(task) });
});

// Valet: "Later" on the reassign prompt — an explicit "seen it, I'll handle
// it". Restarts their escalation window so the whole team isn't pulled in
// seconds after they just told us they're on it.
const acknowledge = asyncHandler(async (req, res) => {
  await require('../services/jobAlerts').touchOwnerWindow('task', parseId(req.params.id));
  res.json({ ok: true });
});

// Valet: "Later" on the driver-reminder prompt (see driverReminder.js) —
// a DIFFERENT "Later" from the one above. This one means stop, not defer:
// the repeating 60s reminder for this specific ticket goes silent, while
// the ticket itself stays exactly where it was on "Driver assign pending"
// for anyone (including this same valet) to act on whenever they're ready.
const silenceDriverReminder = asyncHandler(async (req, res) => {
  await require('../services/driverReminder').silence(parseId(req.params.id));
  res.json({ ok: true });
});

// Valet: abort a parking job the driver is already out on — they bring the
// car back to the counter instead of parking it.
const recall = asyncHandler(async (req, res) => {
  const task = await taskService.recallTask(parseId(req.params.id));
  res.json({ task: serializeTask(task) });
});

// Driver: "car returned to the valet counter" after a recall.
const markReturned = asyncHandler(async (req, res) => {
  const task = await taskService.markReturned(parseId(req.params.id), callerDriverId(req));
  res.json({ task: serializeTask(task) });
});

// Valet: confirms the doctor/staff member actually came and took the car.
const confirmDelivered = asyncHandler(async (req, res) => {
  const task = await taskService.confirmDelivered(parseId(req.params.id));
  res.json({ task: serializeTask(task) });
});

// Valet/admin: retire a stuck task (e.g. never got a driver) instead of it
// silently blocking every later session for that doctor forever.
const cancel = asyncHandler(async (req, res) => {
  const task = await taskService.cancelTask(parseId(req.params.id));
  res.json({ task: serializeTask(task) });
});

// Valet/admin: close a parked session whose car physically left without
// anyone requesting a retrieval, freeing the slot it was holding. See
// closeParkedSession — destructive by design, the client confirms first.
const closeParked = asyncHandler(async (req, res) => {
  const task = await taskService.closeParkedSession(parseId(req.params.id));
  res.json({ task: serializeTask(task) });
});

// Doctor/staff: call off a departure they asked for. Scoped to their own car
// by passing their id — the service refuses anyone else's, and refuses once
// the driver has actually set off.
const cancelMyRetrieval = asyncHandler(async (req, res) => {
  const task = await taskService.cancelTask(parseId(req.params.id), req.user.id);
  res.json({ task: serializeTask(task) });
});


module.exports = { list, get, create, gateHandoff, requestRetrieval, requestRetrievalForDoctor, assignDriver, assignRetrievalDriverForDoctor, cancelAssignment, acceptRetrieval, cancelMyRetrieval, accept, reject, keyCollected, inTransit, park, confirmParked, requestOtherStation, retrieve, confirmArrived, confirmDelivered, cancel, closeParked, recall, markReturned, acknowledge, silenceDriverReminder };
