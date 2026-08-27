const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const realtime = require('../realtime');
const { serializeArrivalNotice } = require('../utils/serialize');
const notificationService = require('./notification.service');

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

  /*
   * Tell the valet properly, not just over the socket.
   *
   * Until now an arrival notice ONLY emitted arrival:upsert, which reaches a
   * valet whose app is open and in front of them, and nobody else. A valet
   * with the app backgrounded — or closed, which is most of a shift — was
   * told nothing at all, so a doctor announcing they were on their way
   * landed in a list no one was looking at.
   *
   * alarmLevel 'long': this is a person saying they are coming for their
   * car. It is one of exactly two events that earn the 20-second ring, the
   * other being an outright retrieval request.
   */
  const who = doctor.name || 'A staff member';
  notificationService.push({
    targetRole: 'valet',
    title: '🔔 Arrival expected',
    body: eta ? `${who} is arriving in about ${eta} min — please have their car ready.` : `${who} is on their way in.`,
    type: 'alarm',
    alarmLevel: 'long',
    // Job-scoped so a re-tapped ETA replaces the entry rather than stacking
    // a second one — create() already refreshes instead of duplicating.
    tag: `kims-arrival-${notice.id}`,
  }).catch(() => {});
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
// The doctor/staff member's own still-open heads-up, if they have one.
// Their app needs this to offer "I'm not coming after all" — without it the
// only way to clear a notice was for a valet to dismiss it from their side,
// so someone whose plans changed had no way to take it back.
async function findActiveForDoctor(doctorId) {
  return prisma.arrivalNotice.findFirst({ where: { doctorId, fulfilledAt: null }, include });
}

// `byDoctorId` is set when a doctor/staff member cancels their OWN heads-up
// from their app, and is what scopes them to their own notice. Left
// undefined for valet/admin dismissals, which may clear any notice.
async function dismiss(id, byDoctorId) {
  const notice = await prisma.arrivalNotice.findUnique({ where: { id } });
  if (!notice) throw ApiError.notFound('Arrival notice not found');
  if (byDoctorId !== undefined && notice.doctorId !== byDoctorId) {
    throw ApiError.forbidden('This is not your arrival notice');
  }
  if (notice.fulfilledAt) return notice;
  const updated = await prisma.arrivalNotice.update({ where: { id }, data: { fulfilledAt: new Date() } });
  emitRemove(id);
  return updated;
}

module.exports = { create, accept, listActive, findActiveForDoctor, fulfillForDoctor, dismiss };
