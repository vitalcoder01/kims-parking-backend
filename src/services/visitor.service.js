const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const cache = require('../utils/responseCache');
const realtime = require('../realtime');
const watchdog = require('./acceptWatchdog');
const notificationService = require('./notification.service');
const assignLocks = require('./assignLocks');
const runSerializable = require('../utils/runSerializable');

// Lazy: task.service requires this module too, so a top-level require would
// be circular and one side would see an empty object.
function taskService() { return require('./task.service'); }
const whatsapp = require('./whatsapp.service');
const { serializeVisitor } = require('../utils/serialize');

// Public tracking links carry either the publicToken (a non-numeric cuid)
// or, for old-style callers, the raw numeric id — `id` is now an Int
// column, so including it in the OR unconditionally throws a Prisma
// validation error whenever the value isn't numeric.
function publicLookupWhere(idOrToken) {
  const numeric = Number(idOrToken);
  const or = [{ publicToken: String(idOrToken) }];
  if (Number.isFinite(numeric)) or.push({ id: numeric });
  return { OR: or };
}

function generateToken() {
  return String(Math.floor(Math.random() * 900) + 100); // 3-digit, matches app
}

// Releases a driver ONLY if they're still actually on this job — mirrors
// task.service.js's helper of the same name. Blanking currentTaskId
// unconditionally would mark a driver free while they're genuinely out on
// a newer job they'd since been assigned.
// Frees a driver only if they're still on THIS visitor's job.
//
// `Driver.currentTaskId` holds a ParkingTask id. It used to hold a visitor id
// on these paths, which was survivable while visitors had their own flow —
// but now that visitors run on ParkingTask, the two id spaces overlap and a
// visitor id can silently match an unrelated task. Anand Raj sat "busy" on
// currentTaskId=54 pointing at a task that does not exist, because 54 was a
// VISITOR id; nothing could ever free him.
//
// So the visitor's own task id is resolved first, and the comparison is made
// against that.
async function freeDriverIfStillOn(tx, driverId, visitorId) {
  if (!driverId) return false;
  const driver = await tx.driver.findUnique({ where: { id: driverId } });
  if (!driver) return false;

  if (driver.currentTaskId != null) {
    const task = await tx.parkingTask.findFirst({
      where: { visitorId, id: driver.currentTaskId },
      select: { id: true },
    });
    // Pointing at something that isn't this visitor's task means they have
    // genuinely moved on to another job — leave them on it.
    if (!task) return false;
  }

  await tx.driver.update({ where: { id: driverId }, data: { status: 'available', currentTaskId: null } });
  return true;
}

// Same reasoning as task.service.js listTasks — bound the default list to
// active visitors plus anything from the last 24h instead of all history.
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VISITOR_LIMIT = 100;
const CACHE_TTL_MS = 2500;
const CACHE_KEY = 'visitors:list';

const visitorInclude = {
  driver: { include: { user: true } },
};

// Realtime deltas — same contract as task.service.js: emit the changed
// record itself so clients patch in place instead of refetching.
function emitVisitor(visitor) {
  realtime.emitAll('visitor:upsert', serializeVisitor(visitor));
}
function emitDriverPatch(id, status, currentTaskId) {
  realtime.emitAll('driver:patch', { id, status, currentTaskId: currentTaskId ?? undefined });
}

function assertTransition(visitor, allowed, action) {
  if (!allowed.includes(visitor.status)) {
    throw ApiError.conflict(`Cannot ${action} — visitor's car is currently "${visitor.status}"`, 'JOB_GONE');
  }
}

async function listVisitors() {
  return cache.cached(CACHE_KEY, CACHE_TTL_MS, () => prisma.visitor.findMany({
    where: { OR: [{ status: { notIn: ['retrieved', 'cancelled'] } }, { createdAt: { gte: new Date(Date.now() - DEFAULT_WINDOW_MS) } }] },
    include: visitorInclude,
    orderBy: { createdAt: 'desc' },
    take: DEFAULT_VISITOR_LIMIT,
  }));
}

// Plate suggestions for the check-in form. Sourced from plates the system has
// already seen — past visitor check-ins and staff vehicles on file — so
// typing "TS09" surfaces the real cars that start that way instead of asking
// the valet to read a whole number off a windscreen.
//
// Matching is done on a normalised copy (spaces and dashes stripped) because
// the same plate gets entered as "TS09AB1234", "TS09 AB 1234" and
// "TS09-AB-1234" depending on who typed it, and a prefix match on the raw
// text would miss two of the three.
function normalisePlate(v) {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// "AP 39 AB 1234" — the canonical spelling, mirroring the app's plate.ts.
// Suggestions are rendered through this so the valet always sees one shape,
// rather than whichever spelling that car happened to be entered with first
// (we have the same plate stored as "AP39AB1234", "AP39 AB 1234" and
// "AP-39-AB-1234"). Anything that doesn't parse is passed through untouched —
// an older record, or a plate that simply isn't Indian-format.
function formatPlate(v) {
  const raw = normalisePlate(v);
  const m = raw.match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/);
  if (!m) return String(v ?? '').trim().toUpperCase();
  const [, state, rto, series, number] = m;
  return [state, rto, series, number].filter(Boolean).join(' ');
}

// Resolve a public tracking token (or raw id) to the visitor behind it. The
// tracking page and the WhatsApp link both carry the publicToken, never the
// numeric id, so this is the entry point for every unauthenticated action.
// Valet-desk lookup: a visitor walks up with a token on their phone, or reads
// out a number, or points at their car. All three land here.
//
// Matched against a normalised copy of the plate for the same reason the
// autocomplete does — the same car is entered as "TS09AB1234", "TS09 AB 1234"
// and "TS09-AB-1234" depending on who typed it. Token and mobile are matched
// as substrings so a partial read still finds them.
async function searchVisitors(query, limit = 12) {
  const raw = String(query ?? '').trim();
  if (raw.length < 2) return [];
  const digits = raw.replace(/\D/g, '');
  const plate = normalisePlate(raw);
  const lower = raw.toLowerCase();

  // Filtering happens in memory over live sessions only, not in the WHERE
  // clause. A database `contains` compares raw text, so "ap39cz" would never
  // match the stored "AP39 CZ 4567" — and normalising in SQL is not something
  // Prisma can express. The candidate set is "cars currently in the car park",
  // which is inherently small and already loaded wholesale elsewhere.
  const rows = await prisma.visitor.findMany({
    where: { status: { notIn: ['retrieved', 'cancelled'] } },
    include: visitorInclude,
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  const scored = [];
  for (const v of rows) {
    const token = String(v.token ?? '');
    const mobile = String(v.mobile ?? '');
    const carN = normalisePlate(v.carNumber);
    const name = String(v.name ?? '').toLowerCase();

    // Ranked so the desk sees the strongest match first: an exact token is
    // someone holding their phone up, and should never sit below a loose
    // name match.
    let rank = null;
    if (digits && token === digits) rank = 0;
    else if (plate.length >= 3 && carN === plate) rank = 1;
    else if (digits.length >= 4 && mobile.includes(digits)) rank = 2;
    else if (plate.length >= 2 && carN.includes(plate)) rank = 3;
    else if (digits && token.includes(digits)) rank = 4;
    else if (name && name.includes(lower)) rank = 5;
    if (rank !== null) scored.push({ rank, v });
  }

  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map(x => x.v);
}

async function getByPublicToken(idOrToken) {
  const visitor = await prisma.visitor.findFirst({ where: publicLookupWhere(idOrToken) });
  if (!visitor) throw ApiError.notFound('Visitor not found');
  return visitor;
}

// The retrieval itself now lives on a ParkingTask (same machinery as staff).
// This only mirrors the fact onto the Visitor row, because the tracking page
// reads Visitor and shouldn't have to know a task exists.
async function markRetrievalRequested(id) {
  const updated = await prisma.visitor.update({
    where: { id },
    data: { retrievalRequested: true },
    include: visitorInclude,
  });
  cache.invalidate('visitors:');
  emitVisitor(updated);
  return updated;
}

async function suggestPlates(query, limit = 10) {
  const q = normalisePlate(query);
  if (q.length < 2) return [];   // one character matches most of the car park

  // Every vehicle the system has ever seen, from the records that already
  // exist — visitor check-ins and staff/doctor profiles. No second table, no
  // separate vehicle registry to keep in step.
  const [visitors, users] = await Promise.all([
    prisma.visitor.findMany({
      where: { carNumber: { not: null } },
      select: { carNumber: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 800,
    }),
    prisma.user.findMany({
      where: { carNumber: { not: null } },
      select: { carNumber: true },
      take: 400,
    }),
  ]);

  // Ranked on how often a car has been here and how recently, because a
  // regular visitor's plate is a far better guess than one seen once months
  // ago. Keyed on the normalised form so "AP39AB1234" and "AP 39 AB 1234"
  // count as the same car rather than competing with each other.
  const stats = new Map();   // key -> { display, count, lastSeen }
  const note = (rawPlate, seenAt) => {
    const raw = String(rawPlate ?? '').trim();
    if (!raw) return;
    const key = normalisePlate(raw);
    if (!key.startsWith(q)) return;
    const prev = stats.get(key);
    if (prev) {
      prev.count += 1;
      if (seenAt && (!prev.lastSeen || seenAt > prev.lastSeen)) prev.lastSeen = seenAt;
    } else {
      stats.set(key, { display: formatPlate(raw), count: 1, lastSeen: seenAt ?? null });
    }
  };

  for (const v of visitors) note(v.carNumber, v.createdAt);
  // Staff vehicles have no visit history here, so they carry no recency —
  // they rank below anything actually parked, which is the honest order.
  for (const u of users) note(u.carNumber, null);

  return [...stats.values()]
    .sort((a, b) =>
      b.count - a.count
      || (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0)
      || a.display.localeCompare(b.display))
    .slice(0, limit)
    .map(x => x.display);
}

async function getVisitor(id) {
  const visitor = await prisma.visitor.findUnique({ where: { id }, include: visitorInclude });
  if (!visitor) throw ApiError.notFound('Visitor not found');
  return visitor;
}

// A double-tap on "Check In" (or two valet devices checking in the same
// walk-in within the same moment) otherwise created two full Visitor rows —
// this path had no guard at all, client or server, unlike createTask's
// equivalent for staff. The fast-path check below is a courtesy (returns the
// existing check-in without round-tripping through an error); the real
// guarantee is the DB-level partial unique index on (carNumber, mobile)
// WHERE status = 'pending' (see migration 20260802030000), which makes it
// impossible for two pending rows with the same car+mobile to exist at all —
// closing the race the old time-window check couldn't. A genuinely new visit
// for the same car+mobile is only blocked while an earlier one is still
// unresolved, which is correct: that earlier one needs cancelling first, not
// silently duplicated.
async function createVisitor({ name, carNumber, mobile, vehicleType, valetId }) {
  const normalizedCarNumber = carNumber ? String(carNumber).trim().toUpperCase().replace(/\s+/g, ' ') : '';
  const normalizedMobile = mobile.trim();

  const existing = await prisma.visitor.findFirst({
    where: { carNumber: normalizedCarNumber, mobile: normalizedMobile, status: 'pending' },
    orderBy: { createdAt: 'desc' },
    include: visitorInclude,
  });
  if (existing) return existing;

  let visitor;
  try {
    visitor = await prisma.visitor.create({
      data: {
        // Name is optional: a visitor who won't give one still needs a token,
        // and refusing the check-in over it helps nobody. Stored as '' rather
        // than null so every reader sees a string.
        name: (name ?? '').trim(),
        // Required at intake (see visitor.controller create) — it is how the
        // car is found later. Normalised so the same car typed three different
        // ways matches itself in search.
        carNumber: normalizedCarNumber,
        mobile: normalizedMobile,
        vehicleType: vehicleType === 'bike' ? 'bike' : 'car',
        token: generateToken(),
        status: 'pending',
        // The valet who registered this visitor owns the job.
        valetId: valetId ?? null,
        valetClaimedAt: valetId ? new Date() : null,
      },
      include: visitorInclude,
    });
  } catch (err) {
    // Lost the race that the fast-path check above couldn't catch — a
    // concurrent request's insert won between our SELECT and our INSERT.
    // P2002 here can only mean the partial unique index, so the winner's row
    // is exactly what we'd otherwise have returned had we checked a moment
    // later.
    if (err.code === 'P2002') {
      const winner = await prisma.visitor.findFirst({
        where: { carNumber: normalizedCarNumber, mobile: normalizedMobile, status: 'pending' },
        orderBy: { createdAt: 'desc' },
        include: visitorInclude,
      });
      if (winner) return winner;
    }
    throw err;
  }
  // The visitor's parking job is a real ParkingTask, exactly like a staff
  // member's. That is what puts it on the driver's normal job card with the
  // normal actions, instead of a separate "visitor pickup" shape that had to
  // be rendered and handled on its own everywhere.
  //
  // Created here, unassigned, mirroring createTask for staff: the valet then
  // picks a driver through the same assignDriver call.
  const linkedTask = await prisma.parkingTask.create({
    data: {
      type: 'park',
      visitorId: visitor.id,
      carNumber: visitor.carNumber ?? '',
      status: 'assigned',
      assignedAt: new Date(),
      isCurrent: true,
      valetId: valetId ?? null,
      valetClaimedAt: valetId ? new Date() : null,
    },
    include: { doctor: true, driver: { include: { user: true } } },
  }).catch(() => null); // a missing task must not fail the check-in

  cache.invalidate('tasks:');
  cache.invalidate('visitors:');
  emitVisitor(visitor);
  // Without this, the visitor's job never appeared on anyone's Job Queue in
  // real time — createTask (the staff equivalent) broadcasts on creation,
  // but this path never did. A valet who backed out of the assign screen
  // straight after check-in (Skip, or just the back arrow) had no way back
  // in: no queue card ever showed up to retry "Assign driver" from, since
  // nothing told any connected app this task existed until their next full
  // reconnect/refetch.
  if (linkedTask) taskService().emitTask(linkedTask);

  // Fire-and-forget, and deliberately AFTER the record exists: the visitor is
  // already parked either way, so a WhatsApp failure must never fail the
  // check-in that triggered it. No-ops silently until the Meta app is
  // configured.
  whatsapp.sendCheckIn({
    mobile: visitor.mobile,
    name: visitor.name,
    token: visitor.token,
    publicToken: visitor.publicToken,
    carNumber: visitor.carNumber,
  }).catch(() => {});

  return visitor;
}

async function updateVisitor(id, patch) {
  const visitor = await prisma.visitor.findUnique({ where: { id } });
  if (!visitor) throw ApiError.notFound('Visitor not found');

  const updated = await prisma.visitor.update({ where: { id }, data: patch, include: visitorInclude });
  cache.invalidate('visitors:');
  emitVisitor(updated);
  return updated;
}

// Valet: assigns an available driver to collect the key and park this
// visitor's car. Starts the accept countdown — the driver must confirm on
// their phone or the valet is prompted to reassign.
// Valet: put a driver on a visitor's parking job.
//
// Delegates to taskService.assignDriver — the same call the staff flow makes.
// The locking, the driver-availability check, the accept watchdog, the
// "one job one valet" claim and the driver's push notification are all that
// function's, not reimplemented here. This only finds the visitor's task.
async function assignDriver(visitorId, driverId, valetId) {
  const visitor = await prisma.visitor.findUnique({ where: { id: visitorId } });
  if (!visitor) throw ApiError.notFound('Visitor not found');
  assertTransition(visitor, ['pending'], 'assign a driver');

  const task = await prisma.parkingTask.findFirst({
    where: { visitorId, type: 'park', isCurrent: true },
  });
  if (!task) throw ApiError.conflict('This visitor has no parking job to assign', 'JOB_GONE');

  await taskService().assignDriver(task.id, driverId, null, valetId);

  // The task is the source of truth; this keeps the visitor row readable for
  // the tracking page and the valet's visitor list.
  const updated = await prisma.visitor.update({
    where: { id: visitorId },
    data: { driverId, driverAssignedAt: new Date(), acceptedAt: null, pickedUpAt: null, trackingProgress: 0.25 },
    include: visitorInclude,
  });
  cache.invalidate('visitors:');
  emitVisitor(updated);
  return updated;
}

// Valet: give up on a driver who hasn't accepted this pickup yet,
// immediately, instead of waiting out the accept-timeout window. Frees the
// driver and puts the job back to "needs a driver" — the visitor's token
// stays exactly as it was, nothing about the check-in itself is touched.
async function cancelPendingAssignment(visitorId) {
  return watchdog.cancelVisitorAssignment(visitorId);
}

// The visitor's park leg is a real ParkingTask under the hood (see
// createVisitor) — these three delegate to task.service.js's own
// accept/reject/key-collected instead of mutating the Visitor row directly,
// so the linked task always stays in lockstep (task.service.js's functions
// already call syncVisitorFromTask). Duplicating the mutation here instead
// used to leave that task orphaned — open forever, invisible everywhere
// except to the DB's one-active-job-per-driver index, which then blocked
// this driver's next assignment. Same corruption class fixed elsewhere in
// this file for assignment; this closes it for the rest of the lifecycle.
async function findLinkedParkTask(visitorId) {
  return prisma.parkingTask.findFirst({ where: { visitorId, type: 'park', isCurrent: true } });
}

async function acceptTask(visitorId, driverId) {
  const task = await findLinkedParkTask(visitorId);
  if (!task) throw ApiError.conflict('This visitor has no parking job to accept', 'JOB_GONE');
  await taskService().acceptTask(task.id, driverId);
  return prisma.visitor.findUnique({ where: { id: visitorId }, include: visitorInclude });
}

// Driver: declined — immediate version of the accept-timeout rollback.
async function rejectTask(visitorId, driverId) {
  const task = await findLinkedParkTask(visitorId);
  if (!task) throw ApiError.conflict('This visitor has no parking job to reject', 'JOB_GONE');
  await taskService().rejectTask(task.id, driverId);
  // task.service.js's rejectTask doesn't sync the visitor mirror (it has no
  // notion of visitors) — do it here, matching what syncVisitorFromTask
  // would have done for a driverId rollback.
  const updated = await prisma.visitor.update({
    where: { id: visitorId },
    data: { driverId: null, driverAssignedAt: null, acceptedAt: null, trackingProgress: 0 },
    include: visitorInclude,
  });
  cache.invalidate('visitors:');
  emitVisitor(updated);
  return updated;
}

// Driver: physically collected the vehicle from the valet counter — the
// visitor-flow equivalent of a valet tapping "Key handed over" for staff.
async function markPickedUp(visitorId, driverId) {
  const task = await findLinkedParkTask(visitorId);
  if (!task) throw ApiError.conflict('This visitor has no parking job', 'JOB_GONE');
  if (task.driverId !== driverId) throw ApiError.conflict('This pickup has already moved on', 'JOB_GONE');
  await taskService().markKeyCollected(task.id);
  return prisma.visitor.findUnique({ where: { id: visitorId }, include: visitorInclude });
}

// Valet: cancel a pending visitor (no-show, valet cancelled, parking failed).
async function cancelVisitor(visitorId, reason) {
  watchdog.disarm('visitor', visitorId);
  const result = await runSerializable(async (tx) => {
    const visitor = await tx.visitor.findUnique({ where: { id: visitorId } });
    if (!visitor) throw ApiError.notFound('Visitor not found');
    assertTransition(visitor, ['pending'], 'cancel');

    const freedDriverId = visitor.driverId;
    await freeDriverIfStillOn(tx, freedDriverId, visitorId);

    const updated = await tx.visitor.update({
      where: { id: visitorId },
      data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason ?? 'valet_cancelled' },
      include: visitorInclude,
    });
    return { updated, freedDriverId };
  });
  cache.invalidate('visitors:');
  cache.invalidate('drivers:');
  emitVisitor(result.updated);
  if (result.freedDriverId) emitDriverPatch(result.freedDriverId, 'available', null);

  // The check-in also created a linked ParkingTask (see createVisitor).
  // Cancelling only the visitor left that task open forever — invisible
  // everywhere except the DB's one-active-job-per-driver index, which then
  // blocked this driver's next assignment. Best-effort and only when the
  // task is still in a cancellable state (assertTransition inside
  // taskService().cancelTask enforces this) — a task already past key
  // handover means a driver is physically holding the car, which is a
  // recall, not a cancel, and is left for the valet to handle explicitly.
  const linkedTask = await findLinkedParkTask(visitorId);
  if (linkedTask && ['requested', 'accepted', 'assigned'].includes(linkedTask.status)) {
    await taskService().cancelTask(linkedTask.id).catch(() => {});
  }
  return result.updated;
}

// Valet: "Bring my car back" — the visitor-flow counterpart to the recall
// already available for staff (see task.service.js's recallTask). This is
// exactly the gap flagged in cancelVisitor's comment above: once a driver
// has the key, the check-in can no longer be cancelled/no-showed (the car
// is physically gone), and until now there was nothing else on offer here
// either. Delegates entirely to taskService().recallTask, which already
// handles the driver notification and the key_collected/in_transit-only
// guard — the visitor row itself doesn't need its own recalledAt mirror
// since the frontend reads the linked task (visitorId is on ParkingTask)
// for that state.
async function recallVisitor(visitorId) {
  const task = await findLinkedParkTask(visitorId);
  if (!task) throw ApiError.conflict('This visitor has no parking job to recall', 'JOB_GONE');
  await taskService().recallTask(task.id);
  return prisma.visitor.findUnique({ where: { id: visitorId }, include: visitorInclude });
}

// Driver: car has been parked — delegates to task.service.js's markParked
// so the linked ParkingTask (see createVisitor) actually completes, the
// slot claim and driver release happen in the one place staff jobs already
// go through, instead of duplicating that logic here and leaving the task
// orphaned open forever.
async function markParked(visitorId, slotId) {
  const task = await findLinkedParkTask(visitorId);
  if (!task) throw ApiError.conflict('This visitor has no parking job', 'JOB_GONE');

  // Slot may be omitted — auto-assign the next free one. task.service.js's
  // own markParked always requires an explicit slot, so resolve one here
  // first; its own atomic conditional claim (`WHERE status = 'free'`) still
  // protects against losing a race for it.
  let resolvedSlotId = slotId;
  if (!resolvedSlotId) {
    const candidate = await prisma.parkingSlot.findFirst({
      where: { status: 'free' },
      orderBy: [{ block: 'asc' }, { number: 'asc' }],
    });
    if (!candidate) throw ApiError.conflict('No free parking slots available');
    resolvedSlotId = candidate.id;
  }

  await taskService().markParked(task.id, resolvedSlotId, task.driverId);
  return prisma.visitor.findUnique({ where: { id: visitorId }, include: visitorInclude });
}

// Visitor (public, self-service from the tracking page): flags the parked
// car for pickup. Deliberately idempotent. Never touches driverId/driver
// status — assigning a driver is still the valet's job.
async function requestRetrieval(visitorIdOrToken) {
  // Reached from the public tracking page, whose URL carries the
  // publicToken — accept either that or the raw record id.
  const existing = await prisma.visitor.findFirst({
    where: publicLookupWhere(visitorIdOrToken),
  });
  if (!existing) throw ApiError.notFound('Visitor not found');
  assertTransition(existing, ['parked'], 'request retrieval');

  if (existing.retrievalRequested) {
    return prisma.visitor.findUnique({ where: { id: existing.id }, include: visitorInclude });
  }

  const updated = await prisma.visitor.update({
    where: { id: existing.id },
    data: { retrievalRequested: true, trackingProgress: 0.75 },
    include: visitorInclude,
  });
  cache.invalidate('visitors:');
  emitVisitor(updated);
  return updated;
}

// Valet: assign (or reassign) a driver to bring a requested car back.
// `driverId` on Visitor is reused from the park leg and isn't cleared until
// the retrieval completes, so the driver's own currentTaskId is what
// disambiguates "actively out on this retrieval right now".
// Valet: put a driver on a visitor's RETRIEVAL.
//
// The missing half of the unification. The parking leg already ran through
// ParkingTask, but this one still moved the Visitor row on its own — so the
// valet's list said "Anand Raj en route" while Anand's own app showed no job
// at all, because no task existed for him to see.
//
// Now it raises the retrieval through taskService (creating the task if the
// valet is acting before one exists) and then assigns through the same
// assignDriver every other job uses.
async function assignRetrievalDriver(visitorId, driverId, valetId) {
  const visitor = await prisma.visitor.findUnique({ where: { id: visitorId } });
  if (!visitor) throw ApiError.notFound('Visitor not found');
  assertTransition(visitor, ['parked'], 'assign a retrieval driver');

  let task = await prisma.parkingTask.findFirst({
    where: { visitorId, type: 'retrieve', status: { notIn: ['completed', 'cancelled'] } },
    orderBy: { createdAt: 'desc' },
  });

  // The valet is at the desk with the visitor in front of them, so pressing
  // "retrieve" IS the request — no separate step, and "now" is the honest
  // planned departure.
  if (!task) {
    task = await taskService().requestRetrieval({ visitorId, plannedDepartureMinutes: 0 });
  }

  await taskService().assignDriver(task.id, driverId, null, valetId);

  const updated = await prisma.visitor.update({
    where: { id: visitorId },
    data: { driverId, retrievalRequested: true, trackingProgress: 0.85 },
    include: visitorInclude,
  });
  cache.invalidate('visitors:');
  cache.invalidate('tasks:');
  emitVisitor(updated);
  return updated;
}

function findLinkedRetrieveTask(visitorId) {
  return prisma.parkingTask.findFirst({
    where: { visitorId, type: 'retrieve', status: { notIn: ['completed', 'cancelled'] } },
    orderBy: { createdAt: 'desc' },
  });
}

// Driver: "Car Delivered to Valet Counter" — delegates to task.service.js's
// markRetrieved so the linked retrieve-type ParkingTask (see
// assignRetrievalDriver) frees the slot/driver and reaches 'delivered' in
// the one place staff jobs already go through.
async function markRetrieved(visitorId) {
  const task = await findLinkedRetrieveTask(visitorId);
  if (!task) throw ApiError.conflict('This visitor has no retrieval job', 'JOB_GONE');
  await taskService().markRetrieved(task.id, task.driverId);
  return prisma.visitor.findUnique({ where: { id: visitorId }, include: visitorInclude });
}

// Valet: confirms the visitor actually came and took the car — the only
// thing that finally closes out a retrieval, mirroring task.service.js's
// confirmDelivered for staff/doctor tasks. Delegates to it so the linked
// retrieve task actually completes instead of only the Visitor mirror
// moving — leaving that task stuck at 'delivered' forever was the same
// corruption class fixed elsewhere in this file.
async function confirmDelivered(visitorId) {
  const existing = await prisma.visitor.findUnique({ where: { id: visitorId } });
  if (!existing) throw ApiError.notFound('Visitor not found');
  assertTransition(existing, ['delivered'], 'confirm handed to owner');

  const task = await prisma.parkingTask.findFirst({
    where: { visitorId, type: 'retrieve', status: 'delivered' },
    orderBy: { createdAt: 'desc' },
  });
  if (task) {
    await taskService().confirmDelivered(task.id);
    return prisma.visitor.findUnique({ where: { id: visitorId }, include: visitorInclude });
  }

  // No linked task at 'delivered' (an older visitor from before this was
  // wired up, or the task genuinely doesn't exist) — fall back to moving
  // just the visitor row rather than failing the confirmation outright.
  const updated = await prisma.visitor.update({
    where: { id: visitorId },
    data: { status: 'retrieved', trackingProgress: 1 },
    include: visitorInclude,
  });
  cache.invalidate('visitors:');
  emitVisitor(updated);
  return updated;
}

// Public (no auth) — the WhatsApp tracking link resolves the visitor by the
// unguessable publicToken; plain record id still accepted for older links.
async function trackByPublicToken(idOrToken) {
  const visitor = await prisma.visitor.findFirst({
    where: publicLookupWhere(idOrToken),
    include: visitorInclude,
  });
  if (!visitor) throw ApiError.notFound('Tracking link not found');
  return visitor;
}

module.exports = {
  formatPlate,
  searchVisitors,
  getByPublicToken,
  markRetrievalRequested,
  suggestPlates,
  normalisePlate,
  listVisitors, getVisitor, createVisitor, updateVisitor,
  assignDriver, cancelPendingAssignment, acceptTask, rejectTask, markPickedUp, cancelVisitor, recallVisitor,
  markParked, requestRetrieval, assignRetrievalDriver, markRetrieved, confirmDelivered,
  trackByPublicToken,
  // Back-compat alias for existing callers (track page controller).
  trackById: trackByPublicToken,
};
