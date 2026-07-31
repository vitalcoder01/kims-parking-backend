const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const realtime = require('../realtime');
const { serializeArrivalNotice } = require('../utils/serialize');

const include = { doctor: true };

function emitUpsert(notice) {
  realtime.emitToRoles(['valet', 'admin'], 'arrival:upsert', serializeArrivalNotice(notice));
}
function emitRemove(id) {
  realtime.emitToRoles(['valet', 'admin'], 'arrival:remove', { id });
}

// Doctor/staff taps an ETA before they've handed over a car — nothing to
// anchor this to yet (a ParkingTask only exists once the valet takes the
// key), so it's a small standalone record the valet queue can list. Only
// one open notice per doctor at a time — a repeat tap just refreshes the ETA
// on the existing one instead of piling up duplicates in the valet's list.
async function create({ doctorId, eta }) {
  const doctor = await prisma.user.findUnique({ where: { id: doctorId } });
  if (!doctor) throw ApiError.badRequest('doctorId does not reference a valid user');

  const existing = await prisma.arrivalNotice.findFirst({ where: { doctorId, fulfilledAt: null } });
  const notice = existing
    ? await prisma.arrivalNotice.update({ where: { id: existing.id }, data: { eta, createdAt: new Date() }, include })
    : await prisma.arrivalNotice.create({ data: { doctorId, eta }, include });

  emitUpsert(notice);
  return notice;
}

// Valet-facing "Expected Arrivals" list — unfulfilled notices only, shown to
// every valet. A notice is a heads-up, not a job: there is nothing to claim,
// so there is nobody to filter it for.
async function listActive() {
  return prisma.arrivalNotice.findMany({
    where: { fulfilledAt: null },
    include,
    orderBy: { createdAt: 'asc' },
  });
}

// Retained ONLY so an installed app that still has the old "Accept" button
// doesn't 404 on it. Accepting an arrival no longer means anything: an
// arrival is a heads-up, and the parking session gets its owner when a valet
// dispatches a driver (see task.service.js assignDriver). Returns the notice
// unchanged so the old build carries on working. Delete once every phone has
// been rebuilt.
async function accept(id) {
  const notice = await prisma.arrivalNotice.findUnique({ where: { id }, include });
  if (!notice) throw ApiError.notFound('Arrival request not found');
  return notice;
}

// Called from task.service.js the moment a real park ParkingTask is created
// for this doctor — the arrival they announced has now actually happened,
// so their notice (if any) is done and drops off the valet's list.
async function fulfillForDoctor(doctorId) {
  const notice = await prisma.arrivalNotice.findFirst({ where: { doctorId, fulfilledAt: null } });
  if (!notice) return;
  await prisma.arrivalNotice.update({ where: { id: notice.id }, data: { fulfilledAt: new Date() } });
  emitRemove(notice.id);
}

// Valet: manually clear a notice that was a no-show or a mistake, without
// waiting around for it to auto-clear (which never happens if the doctor
// never actually hands over a car).
async function dismiss(id) {
  const notice = await prisma.arrivalNotice.findUnique({ where: { id } });
  if (!notice) throw ApiError.notFound('Arrival notice not found');
  if (notice.fulfilledAt) return notice;
  const updated = await prisma.arrivalNotice.update({ where: { id }, data: { fulfilledAt: new Date() } });
  emitRemove(id);
  return updated;
}

module.exports = { create, accept, listActive, fulfillForDoctor, dismiss };
