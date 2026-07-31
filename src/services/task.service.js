const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const cache = require('../utils/responseCache');
const realtime = require('../realtime');
const watchdog = require('./acceptWatchdog');
const arrivalNoticeService = require('./arrivalNotice.service');
const notificationService = require('./notification.service');
const assignLocks = require('./assignLocks');
const jobAlerts = require('./jobAlerts');
const settingService = require('./setting.service');
const runSerializable = require('../utils/runSerializable');
const { serializeTask, serializeSlot } = require('../utils/serialize');

// Realtime deltas: every mutation below emits the changed entity itself so
// connected apps patch just that record — nobody refetches lists on events.
// An owned retrieval is not broadcast to the valet role at all — the delta
// goes to every other role plus the owning valet's own socket. Without this
// the REST filter would be cosmetic: non-owners would still receive the
// record over the socket and patch it straight into their inbox.
function emitTask(task) {
  const payload = serializeTask(task);
  const owner = task.retrievalOwnerValetId ?? task.arrivalOwnerValetId;
  // Exactly the inverse of isVisibleToValet's "open to all" test — the two
  // must agree, or the socket shows a valet something the REST list then
  // takes away on the next poll (or vice versa).
  const restricted = task.type === 'retrieve' && owner != null && !isRetrievalOpenToAll(task);

  if (!restricted) {
    realtime.emitAll('task:upsert', payload);
    return;
  }
  realtime.emitToRoles(['doctor', 'staff', 'driver', 'admin'], 'task:upsert', payload);
  realtime.emitToUser(owner, 'task:upsert', payload);
  // Anyone who was shown this during a recovery broadcast and has now lost it
  // needs it taken off their screen, not left as a dead card.
  realtime.emitToRoles(['valet'], 'task:restrict', { id: task.id, ownerValetId: owner });
}
function emitDriverPatch(id, status, currentTaskId) {
  realtime.emitAll('driver:patch', { id, status, currentTaskId: currentTaskId ?? undefined });
}
function emitSlot(slot) {
  realtime.emitAll('slot:patch', serializeSlot(slot));
}

const CACHE_TTL_MS = 2500;

const taskInclude = {
  doctor: true,
  driver: { include: { user: true } },
  valet: true,
  arrivalOwnerValet: true,
  retrievalOwnerValet: true,
};

// A retrieval belongs to the valet who owns the doctor's parking session.
// Until either they respond or their window lapses and it goes back out to
// the floor, nobody else should see it at all — no card, no badge, no sound.
// Arrival/park jobs stay visible to everyone: those are counter work.
// Is this departure open to the whole floor right now? True in exactly two
// cases: the session owner never answered and it was released, or whoever
// held it then stalled and it escalated past them. Alerting valets about a
// job they can't see is worse than not alerting them, so every alert path
// has to keep this in step with itself.
function isRetrievalOpenToAll(task) {
  // A claim narrows it straight back down to one person — everyone else
  // loses the action the moment someone takes it, even mid-recovery.
  if (task.retrievalOwnerValetId != null) return task.escalatedAt != null;
  return task.recoveryBroadcastAt != null || task.escalatedAt != null;
}

// A departure booked for later is informational until its lead time is
// reached. Hiding the buttons is not enough on its own — a client holding a
// stale card, or one that never refreshed, would still be able to call the
// endpoint. This is the server-side half of that rule.
function isRetrievalScheduled(task) {
  if (task.type !== 'retrieve') return false;
  if (task.retrievalReadyAt == null) return false;   // pre-scheduling row
  return new Date(task.retrievalReadyAt).getTime() > Date.now();
}

function isVisibleToValet(task, valetId) {
  if (task.type !== 'retrieve') return true;
  const owner = task.retrievalOwnerValetId ?? task.arrivalOwnerValetId;
  if (owner == null) return true;               // never had an owner — open floor
  if (owner === valetId) return true;           // theirs
  return isRetrievalOpenToAll(task);
}

// A completed task is immutable, and every other transition only makes sense
// from one specific prior state — without this, e.g. re-firing key-collected
// on an already-completed task flips its status back while leaving
// completedAt/slotId in place, corrupting the record.
function assertTransition(task, allowed, action) {
  if (!allowed.includes(task.status)) {
    // Tagged JOB_GONE: by the time a transition is refused the job has moved
    // past the point the caller was acting on, so retrying the same screen
    // can't succeed.
    throw ApiError.conflict(`Cannot ${action} — task is currently "${task.status}"`, 'JOB_GONE');
  }
}

// Only the driver actually holding a job may drive its stages forward. This
// lives here rather than only in the controller so it holds for every caller
// of these services, not just the one HTTP route that remembered to check.
// `driverId` undefined means an admin/system caller and is allowed through —
// the controller is what decides whether the request is admin-privileged.
function assertOwnDriver(task, driverId) {
  if (driverId === undefined) return;
  if (task.driverId !== driverId) {
    // JOB_GONE rather than 403: a driver reaching one of these is almost
    // always acting on a screen the server has already invalidated — the job
    // was rolled back or reassigned while their card still showed it. Tagging
    // it lets the app clear that card; a bare 403 read as an accusation and
    // left the dead card exactly where it was.
    throw ApiError.conflict('This job has already moved on', 'JOB_GONE');
  }
}

// The mobile app polls this every ~4s with no filters at all, so an
// unfiltered query re-sends the entire all-time task history to every
// connected client on every poll — unbounded and only gets worse as the
// hospital operates over months. `isCurrent` bounds this naturally now: at
// most one row per doctor is ever current, so the live-board query is
// proportional to headcount, not to how much history has piled up. Pass
// `history: true` (with a doctorId) to explicitly bypass that and read a
// doctor's full past-sessions log instead.
const DEFAULT_TASK_LIMIT = 200;

async function listTasks({ doctorId, driverId, status, type, history } = {}) {
  // Not per-user — every client polling with the same filters gets the same
  // rows, so dedupe concurrent pollers onto one query for a couple seconds
  // instead of every phone hitting Postgres on its own 4s tick.
  const key = `tasks:${doctorId ?? ''}:${driverId ?? ''}:${status ?? ''}:${type ?? ''}:${history ? 'h' : ''}`;
  return cache.cached(key, CACHE_TTL_MS, () => prisma.parkingTask.findMany({
    where: {
      ...(doctorId && { doctorId }),
      ...(driverId && { driverId }),
      ...(type && { type }),
      ...(status && { status }),
      ...(!history && { isCurrent: true }),
    },
    include: taskInclude,
    orderBy: { createdAt: 'desc' },
    take: DEFAULT_TASK_LIMIT,
  }));
}

// Releases a driver ONLY if they're still actually on the job in question.
// Every "this job is over, free the driver" path used to blank the driver's
// status/currentTaskId unconditionally — so finishing or cancelling an old
// job would mark a driver available even when they'd since been assigned a
// newer one and were genuinely out on it. Returns whether it freed them, so
// callers know whether to emit a driver patch.
async function freeDriverIfStillOn(tx, driverId, jobId) {
  if (!driverId) return false;
  const driver = await tx.driver.findUnique({ where: { id: driverId } });
  // currentTaskId null means nothing else has claimed them — safe to reset
  // (this is the normal path; it's only non-null-and-different that's a
  // driver who has genuinely moved on to another job).
  if (driver && driver.currentTaskId != null && driver.currentTaskId !== jobId) return false;
  await tx.driver.update({ where: { id: driverId }, data: { status: 'available', currentTaskId: null } });
  return true;
}

// Retires whatever this doctor's current row is (if any) so a new one can
// become current without ever violating "at most one isCurrent row per
// doctor". A row already at a terminal status (completed/cancelled) just
// stops being current — its outcome stands. A row still mid-flight (e.g. an
// old "assigned, no driver" job nobody ever finished) is being superseded by
// a genuinely new session, so it's force-cancelled rather than left
// dangling forever in a status that claims to still be in progress.
async function retireCurrentTask(tx, doctorId) {
  const existing = await tx.parkingTask.findFirst({ where: { doctorId, isCurrent: true } });
  if (!existing) return;
  const terminal = existing.status === 'completed' || existing.status === 'cancelled';
  await tx.parkingTask.update({
    where: { id: existing.id },
    data: terminal
      ? { isCurrent: false }
      : { isCurrent: false, status: 'cancelled', completedAt: new Date() },
  });
}

async function getTask(id) {
  const task = await prisma.parkingTask.findUnique({ where: { id }, include: taskInclude });
  if (!task) throw ApiError.notFound('Task not found');
  return task;
}

// Valet: "Key Received" — creates a PARK task, attendance is marked by the
// caller (controller) since it is a distinct concern from task creation.
async function createTask({ type, doctorId, carNumber, slotId, valetId }) {
  const doctor = await prisma.user.findUnique({ where: { id: doctorId } });
  if (!doctor) throw ApiError.badRequest('doctorId does not reference a valid user');

  // A double-tap on "Key Received" (or a slow first request retried) would
  // otherwise create two live park tasks for the same doctor — return the
  // existing one instead of a duplicate, but only within a short window:
  // this is a guard against an accidental repeat click, not a rule that a
  // doctor can only ever have one task ever. An old still-open task from
  // long ago is a forgotten/stuck one, not a duplicate of *this* click, so
  // it gets superseded (see retireCurrentTask) instead of returned.
  const DUPLICATE_TAP_MS = 2 * 60 * 1000;
  // A park task genuinely has no destination — the driver just has the key
  // and drives to whichever free slot they pick, there's no fixed point to
  // route to in advance. Live tracking for this leg shows the driver's real
  // position, not a route to somewhere.
  const { task, created } = await runSerializable(async tx => {
    const existing = await tx.parkingTask.findFirst({ where: { doctorId, isCurrent: true }, include: taskInclude });
    if (existing) {
      const isOpen = existing.status !== 'completed' && existing.status !== 'cancelled';
      const isFresh = Date.now() - existing.createdAt.getTime() < DUPLICATE_TAP_MS;
      if (isOpen && isFresh) return { task: existing, created: false };
    }

    // The duplicate-tap guard above only covers the first couple minutes
    // after a still-open handoff — it does nothing once the car has
    // actually been parked. Re-scanning that same doctor's code afterwards
    // (a mis-scan, or someone not realizing the car's already parked) would
    // otherwise start a second park job and send a driver to park a car
    // that's already sitting in its slot, without ever freeing that slot —
    // the real signal that a "start parking" request doesn't make sense
    // right now is an occupied slot already on file for this doctor.
    const occupiedSlot = await tx.parkingSlot.findFirst({ where: { status: 'occupied', doctorId } });
    if (occupiedSlot) {
      throw ApiError.conflict(`This car is already parked at slot ${occupiedSlot.id} — request a retrieval instead of parking again`);
    }

    await retireCurrentTask(tx, doctorId);

    const made = await tx.parkingTask.create({
      data: {
        type,
        doctorId,
        carNumber: carNumber.trim().toUpperCase(),
        slotId: slotId ?? null,
        status: 'assigned',
        assignedAt: new Date(),
        destinationLat: null,
        destinationLng: null,
        isCurrent: true,
        // The valet who physically took the key owns this job — they're the
        // one alarmed if it stalls, rather than every valet on shift.
        valetId: valetId ?? null,
        valetClaimedAt: valetId ? new Date() : null,
      },
      include: taskInclude,
    });
    return { task: made, created: true };
  });
  cache.invalidate('tasks:');
  emitTask(task);

  // The valet just typed a plate in for someone with none on file yet — save
  // it to their profile too, so future visits don't ask again. Only when it
  // was genuinely empty: never overwrite a value the doctor already set
  // themselves with whatever the valet typed this one time (a mis-scanned
  // code would otherwise permanently misattach a plate to the wrong person).
  if (created && !doctor.carNumber?.trim()) {
    await prisma.user.update({ where: { id: doctorId }, data: { carNumber: task.carNumber } }).catch(() => {});
  }

  // This doctor's key just actually changed hands — any "I'm on my way"
  // notice they announced earlier is done, whether or not they ever sent
  // one (a no-op if there wasn't one).
  // Session ownership is deliberately NOT set here. Accepting the arrival
  // broadcast only means "I'll walk out and meet them" — it says nothing
  // about who ends up running the job, because the accepter can be busy,
  // on a break, or simply not the one the doctor walks up to. Ownership is
  // established when a driver is assigned (see assignDriver), by whoever
  // actually does it.
  //
  // Taking ownership from the accepter here is what let a valet who accepted
  // an arrival lock out the valet who was physically holding the key: the
  // key-taker created the job, ownership jumped to the accepter, and the
  // key-taker was then refused with "X is handling this job".
  if (created) {
    // The key has actually changed hands, so any "I'm on my way" notice this
    // doctor announced is done (a no-op if there wasn't one).
    await arrivalNoticeService.fulfillForDoctor(doctorId).catch(() => null);
  }

  return { task, created };
}

// Doctor/staff: request retrieval of their own currently-parked car. This is
// the ONLY way a retrieve task can come into existence — the valet cannot
// invent one — so a driver never gets sent to pull a car nobody asked for.
// Planned departure is minutes from NOW — 0 means "leaving now". It used to
// be a fixed menu; the doctor can now name an arbitrary clock time, so this is
// a range instead. Capped at 24h because the picker only ever offers the next
// occurrence of a time of day, which cannot be further away than that.
//
// Stored as minutes rather than an absolute timestamp so no migration is
// needed. The real deadline is always requestedAt + these minutes, and every
// display derives from that pair so it stays correct as time passes.
const MAX_PLANNED_DEPARTURE_MINUTES = 24 * 60;

// Extracted so the scheduler sweep and this path raise the identical alert —
// two copies of the same message drifting apart is how a doctor ends up
// described one way at request time and another way ten minutes later.
function notifyRetrievalOwner(task) {
  const owner = task.arrivalOwnerValetId;
  const who = task.doctor?.name ?? 'A doctor';
  const body = `${who} is leaving and needs ${task.carNumber}. Please assign a driver.`;
  // `valet:<id>` addresses one person; the bare role name would broadcast to
  // everyone and defeat the entire point of ownership. With no owner (a car
  // parked before ownership existed, or an owner whose account is gone) it
  // goes to the floor — correct, not a fallback: an unowned car still has to
  // be retrieved.
  return notificationService.push(owner
    ? { targetRole: `valet:${owner}`, targetUserId: owner, title: '🚗 Car requested — your session', body, type: 'alarm' }
    : { targetRole: 'valet', title: '🚗 Car requested', body, type: 'alarm' });
}

async function requestRetrieval({ doctorId, plannedDepartureMinutes }) {
  if (plannedDepartureMinutes != null
      && (!Number.isInteger(plannedDepartureMinutes)
        || plannedDepartureMinutes < 0
        || plannedDepartureMinutes > MAX_PLANNED_DEPARTURE_MINUTES)) {
    throw ApiError.badRequest(`plannedDepartureMinutes must be a whole number of minutes between 0 and ${MAX_PLANNED_DEPARTURE_MINUTES}`);
  }
  // No destination yet at request time — the real pickup point is wherever
  // the valet who assigns a driver to this happens to be standing (see
  // assignDriver below), since that's the actual physical handover spot,
  // and it naturally supports multiple valets each at their own location
  // instead of a single fixed point.
  // Scheduling is resolved ONCE, here, and stored. Recomputing it later from
  // the lead-time setting would let an operator changing that setting move the
  // deadline of every request already in flight.
  const now = Date.now();
  const leadMs = await settingService.getRetrievalLeadTimeMs();
  const departureAt = new Date(now + (plannedDepartureMinutes ?? 0) * 60000);
  const readyAt = new Date(departureAt.getTime() - leadMs);
  // "Now", or so close that the lead time has already elapsed — nothing to
  // schedule, so it is actionable immediately.
  const readyNow = readyAt.getTime() <= now;

  const task = await runSerializable(async (tx) => {
    const slot = await tx.parkingSlot.findFirst({ where: { status: 'occupied', doctorId } });
    if (!slot) throw ApiError.badRequest('No parked car found for your account');

    // Whoever owned this doctor's parking session owns the departure too, so
    // the doctor deals with the same valet throughout. Looked up from the
    // session being retired rather than carried on the doctor, because
    // ownership belongs to the session.
    const parkTask = await tx.parkingTask.findFirst({
      where: { doctorId, type: 'park', arrivalOwnerValetId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { arrivalOwnerValetId: true, arrivalAcceptedAt: true },
    });

    // Only a still-live retrieval blocks a new one. 'cancelled' has to be
    // excluded alongside 'completed': it's equally terminal, and treating it
    // as "still pending" meant one cancelled retrieval locked that car out
    // of ever being requested again, permanently, with no way back.
    const existing = await tx.parkingTask.findFirst({
      where: { slotId: slot.id, type: 'retrieve', status: { notIn: ['completed', 'cancelled'] } },
    });
    if (existing) throw ApiError.conflict('Retrieval has already been requested for this car');

    // The just-completed park row is this doctor's current row — retiring
    // it here (rather than leaving two isCurrent rows around) is what keeps
    // "one row per doctor" true across a park -> retrieve cycle, not just
    // within a single task type.
    await retireCurrentTask(tx, doctorId);

    return tx.parkingTask.create({
      data: {
        type: 'retrieve',
        doctorId,
        carNumber: slot.carNumber ?? '',
        slotId: slot.id,
        status: 'requested',
        requestedAt: new Date(),
        plannedDepartureMinutes: plannedDepartureMinutes ?? null,
        plannedDepartureAt: departureAt,
        retrievalReadyAt: readyAt,
        destinationLat: null,
        destinationLng: null,
        isCurrent: true,
        arrivalOwnerValetId: parkTask?.arrivalOwnerValetId ?? null,
        arrivalAcceptedAt: parkTask?.arrivalAcceptedAt ?? null,
        valetId: parkTask?.arrivalOwnerValetId ?? null,
        valetClaimedAt: parkTask?.arrivalOwnerValetId ? new Date() : null,
        // The owner's response clock starts when they are NOTIFIED, not when
        // the doctor submitted. A departure booked for 3pm must not burn its
        // 60-second window at 9am and hand itself to recovery six hours
        // early. Left null while the request is still SCHEDULED; the sweep
        // stamps it at the moment it actually alerts them.
        ownerNotifiedAt: readyNow ? new Date() : null,
      },
      include: taskInclude,
    });
  });
  cache.invalidate('tasks:');
  emitTask(task);

  // Owner-only alarm. `valet:<id>` addresses one person; the bare role name
  // would broadcast to everyone and defeat the entire point of ownership.
  // With no owner (a car parked before ownership existed, or a session whose
  // owner's account is gone) it goes to the floor — that's correct, not a
  // fallback: an unowned car still has to be retrieved.
  // Only alert now if there is nothing to wait for. A future departure stays
  // silent and sits on the Retrieval Requests page as an informational
  // SCHEDULED row until the sweep promotes it at readyAt — alerting at submit
  // time is precisely what made a 3pm departure ring a valet's phone at 9am.
  if (readyNow) notifyRetrievalOwner(task).catch(() => {});

  return task;
}

// Valet: assigns an available driver to a requested (or already-assigned,
// e.g. reassigning) task.
async function assignDriver(taskId, driverId, valetLocation, valetId) {
  // Locks BOTH sides of the assignment: the job (so two valets can't both
  // assign this same job) and the driver (so two valets can't both grab
  // this same driver for two different jobs — a per-task lock alone let
  // that straight through, since the task ids differ). Shared with
  // visitor.service.js via assignLocks so a parking task and a visitor
  // pickup can't claim the same driver concurrently either.
  return assignLocks.withLocks(
    [assignLocks.taskKey(taskId), assignLocks.driverKey(driverId)],
    'This job or driver is already being assigned',
    async () => {
      let previousDriverId = null;
      const task = await runSerializable(async (tx) => {
        const existing = await tx.parkingTask.findUnique({ where: { id: taskId } });
        if (!existing) throw ApiError.notFound('Task not found');
        assertTransition(existing, ['requested', 'accepted', 'assigned'], 'assign a driver');

        // Once a driver has explicitly accepted, the job is theirs — silently
        // moving it to someone else left the first driver's app showing a job
        // that was no longer theirs, with no signal anything had changed. To
        // hand it to someone else the valet has to cancel it first, which is
        // a deliberate, visible action rather than an invisible override.
        if (existing.acceptedAt && existing.driverId && existing.driverId !== driverId) {
          throw ApiError.conflict('That driver has already accepted this job — cancel it first to reassign', 'JOB_GONE');
        }

        // One job, one valet. Without this, two valets who both received the
        // same alert could each assign a driver: the second call is a
        // perfectly ordinary "reassign" as far as every other check is
        // concerned, so it silently bumped the first valet's driver off a job
        // they'd just staffed.
        //
        // The claim is deliberately NOT permanent — it lifts once the job has
        // escalated (escalatedAt set), which is the point at which the owner
        // has had their window and the team is meant to pick it up. So a valet
        // who logs off mid-job can't freeze a real car indefinitely.
        if (valetId && existing.valetId && existing.valetId !== valetId && !existing.escalatedAt) {
          const owner = await tx.user.findUnique({ where: { id: existing.valetId }, select: { name: true } });
          throw ApiError.conflict(`${owner?.name ?? 'Another valet'} is handling this job`, 'JOB_GONE');
        }

        // Not yet due. Refused for everyone, owner included: the whole point
        // of a lead time is that work starts then, not whenever a card
        // happens to be tapped.
        if (existing.type === 'retrieve' && isRetrievalScheduled(existing)) {
          throw ApiError.conflict('This departure is scheduled for later and is not ready yet', 'NOT_READY');
        }

        // Session ownership, enforced on the write path rather than only in
        // what each valet is shown — a client holding a stale card must not
        // be able to act on a job that isn't theirs.
        if (valetId && existing.type === 'retrieve') {
          const retrievalOwner = existing.retrievalOwnerValetId;
          // Lifts on escalation, exactly like the valetId claim above: an
          // owner who has had their window and not acted can't hold a real
          // car indefinitely.
          if (retrievalOwner != null && retrievalOwner !== valetId && !existing.escalatedAt) {
            const owner = await tx.user.findUnique({ where: { id: retrievalOwner }, select: { name: true } });
            throw ApiError.conflict(`${owner?.name ?? 'Another valet'} has accepted this retrieval`, 'JOB_GONE');
          }
          // Still inside the session owner's private window — nobody else has
          // even been shown this yet.
          if (retrievalOwner == null
              && existing.arrivalOwnerValetId != null
              && existing.arrivalOwnerValetId !== valetId
              && !existing.recoveryBroadcastAt) {
            const owner = await tx.user.findUnique({ where: { id: existing.arrivalOwnerValetId }, select: { name: true } });
            throw ApiError.conflict(`${owner?.name ?? 'Another valet'} is handling this job`, 'JOB_GONE');
          }
        }

        const driver = await tx.driver.findUnique({ where: { id: driverId } });
        if (!driver) throw ApiError.badRequest('driverId does not reference a valid driver');
        if (driver.status !== 'available') throw ApiError.conflict('Driver is not available', 'DRIVER_BUSY');

        // A retrieve task's real destination is wherever the valet assigning
        // this driver happens to be standing right now — the actual physical
        // handover point. Naturally supports multiple valets (each one's own
        // location, not one shared fixed point) since it's captured fresh on
        // every assignment rather than configured once somewhere central.
        // Assigning a driver is itself a response to the request, so it
        // claims the retrieval for whoever did it. Written here (inside the
        // same serializable transaction as the guard above) rather than as a
        // follow-up call, so there is no window where the job is staffed but
        // still unowned.
        const claim = existing.type === 'retrieve' && valetId && existing.retrievalOwnerValetId !== valetId
          ? {
              retrievalOwnerValetId: valetId,
              retrievalAcceptedAt: new Date(),
              retrievalOwnershipSource: existing.arrivalOwnerValetId === valetId ? 'OWNER' : 'RECOVERY',
            }
          : {};

        const dest = existing.type === 'retrieve' && valetLocation
          ? { destinationLat: valetLocation.lat, destinationLng: valetLocation.lng }
          : {};

        // A retrieval is raised by the doctor, so it has no owning valet
        // until one acts on it — whoever assigns the first driver takes it.
        // For a job that already has an owner, acting on it re-stamps the
        // claim and clears any escalation, so the stall clock starts over
        // rather than the job being treated as still-unattended.
        // Ownership follows whoever is actually doing the work. This used to
        // only ever stamp valetId on a job that had none, so it never moved:
        // after a job escalated and a SECOND valet stepped in and staffed it,
        // the record still named the first valet as owner. The claim guard
        // above then read "owner === caller" for the original valet and let
        // them reassign straight over the top of the person who'd just fixed
        // it — with escalatedAt cleared, so the takeover wasn't even visible.
        const ownership = {
          ...(valetId ? { valetId } : {}),
          valetClaimedAt: new Date(),
          escalatedAt: null,
          // THIS is where a parking session gets its owner: whoever dispatches
          // the driver. Write-once — a later reassignment moves the
          // operational claim (valetId) but never rewrites who owns the
          // session, so the record of who ran this doctor's arrival survives.
          ...(valetId && existing.type === 'park' && existing.arrivalOwnerValetId == null
            ? { arrivalOwnerValetId: valetId, arrivalAcceptedAt: new Date() }
            : {}),
        };

        const updated = await tx.parkingTask.update({
          where: { id: taskId },
          // A (re)assignment restarts the accept handshake from scratch.
          data: { driverId, status: 'assigned', assignedAt: new Date(), acceptedAt: null, ...dest, ...claim, ...ownership },
          include: taskInclude,
        });

        await tx.driver.update({
          where: { id: driverId },
          data: { status: 'busy', currentTaskId: taskId },
        });

        // Reassigning away from whoever had it before (accept-timeout and
        // reject already free the old driver themselves before this ever runs,
        // but a valet picking a different driver mid-assignment — before the
        // first one ever accepted or rejected — otherwise leaves that driver
        // stuck 'busy' on a task that's no longer theirs, forever, since
        // nothing else ever revisits it. Only clear them if that driver isn't
        // busy on some OTHER job too (currentTaskId still points at this task).
        if (existing.driverId && existing.driverId !== driverId) {
          const oldDriver = await tx.driver.findUnique({ where: { id: existing.driverId } });
          if (oldDriver?.currentTaskId === taskId) {
            await tx.driver.update({ where: { id: existing.driverId }, data: { status: 'available', currentTaskId: null } });
            previousDriverId = existing.driverId;
          }
        }

        return updated;
      });
      cache.invalidate('tasks:');
      cache.invalidate('drivers:');
      emitTask(task);
      emitDriverPatch(driverId, 'busy', taskId);
      if (previousDriverId) {
        emitDriverPatch(previousDriverId, 'available', null);
        // The valet moved this job to someone else while the first driver was
        // still being asked. Same reason as the timeout path: kill their alarm
        // at the source instead of hoping they're online for the broadcast.
        realtime.emitToDriver(previousDriverId, 'assignment:cancelled', { kind: 'task', id: taskId });
      }
      // Alerting the driver is this operation's job, not the calling app's.
      // It used to be fired client-side right after this call returned, so a
      // valet whose phone died (or lost signal) in that gap left a real
      // assignment sitting there that the driver was never told about.
      notifyDriverAssigned(task).catch(() => {});
      // Countdown for the driver to accept — on expiry the valet is prompted
      // to reassign (see acceptWatchdog.js). Any countdown still running for
      // the driver just bumped off this task is superseded by this same call
      // (arm() disarms whatever timer already existed for this task id).
      await watchdog.arm('task', taskId, driverId);
      return task;
    },
  );
}

// Server-side assignment alert — see the call site above for why this can't
// live in the client.
function notifyDriverAssigned(task) {
  const isRetrieve = task.type === 'retrieve';
  return notificationService.push({
    // targetRole alone fully identifies the recipient — the backend resolves
    // 'driver:<id>' to that driver's user id. Do NOT also pass targetUserId:
    // Driver.id and User.id are separate sequences that can collide.
    targetRole: `driver:${task.driverId}`,
    title: isRetrieve ? '🔔 Retrieval Task!' : '🔔 Task Assigned!',
    body: isRetrieve
      ? `Retrieve ${task.carNumber} from slot ${task.slotId} for ${task.doctor?.name ?? 'staff'}.`
      : `Collect key from valet for ${task.doctor?.name ?? 'staff'}'s car (${task.carNumber}).`,
    type: 'alarm',
  });
}

// Driver: explicit "I've got it" on the assignment alert. Stops the accept
// watchdog; the task stays 'assigned' (the valet's "Mark Key Handed to
// Driver" step is what moves it forward) but now shows an accepted driver.
async function acceptTask(taskId, driverId) {
  // Read-then-write has to be one atomic step: the valet can be cancelling
  // (or reassigning) this exact task at the same moment, and a plain
  // findUnique + update would happily write an acceptedAt onto a task that
  // had already moved out from under it between the two statements.
  const { task, alreadyAccepted } = await runSerializable(async (tx) => {
    const existing = await tx.parkingTask.findUnique({ where: { id: taskId }, include: taskInclude });
    if (!existing) throw ApiError.notFound('Task not found');
    // Tagged JOB_GONE, not 403. By the time a driver taps Accept on a stale
    // screen the assignment has usually been rolled back by the watchdog or
    // moved to someone else — that is the job changing under them, not them
    // reaching for something they were never given. The tag is what lets the
    // app clear the dead card instead of showing a raw error and leaving it.
    if (existing.driverId !== driverId) {
      throw ApiError.conflict('This job has already moved on', 'JOB_GONE');
    }
    assertTransition(existing, ['assigned'], 'accept');
    if (existing.acceptedAt) return { task: existing, alreadyAccepted: true };

    const updated = await tx.parkingTask.update({
      where: { id: taskId },
      data: { acceptedAt: new Date() },
      include: taskInclude,
    });
    return { task: updated, alreadyAccepted: false };
  });
  if (alreadyAccepted) return task;

  watchdog.disarm('task', taskId);
  cache.invalidate('tasks:');
  emitTask(task);
  return task;
}

// Driver: declined the assignment — same rollback the accept timeout does,
// just immediate: free the driver, put the job back in the valet's court,
// and prompt them to reassign.
async function rejectTask(taskId, driverId) {
  watchdog.disarm('task', taskId);
  const result = await runSerializable(async (tx) => {
    const task = await tx.parkingTask.findUnique({ where: { id: taskId }, include: taskInclude });
    if (!task) throw ApiError.notFound('Task not found');
    if (task.driverId !== driverId) {
      throw ApiError.conflict('This job has already moved on', 'JOB_GONE');
    }
    assertTransition(task, ['assigned'], 'reject');

    const driverName = task.driver?.user?.name ?? 'Driver';
    const updated = await tx.parkingTask.update({
      where: { id: taskId },
      data: { driverId: null, acceptedAt: null, ...(task.type === 'retrieve' && { status: task.retrievalOwnerValetId ? 'accepted' : 'requested' }) },
      include: taskInclude,
    });
    // Only release this driver if they're still actually on THIS job — if
    // they've since been assigned something else, blanking currentTaskId
    // here would mark them free while they're genuinely out on that newer job.
    await freeDriverIfStillOn(tx, driverId, taskId);
    return { updated, driverName };
  });
  cache.invalidate('tasks:');
  cache.invalidate('drivers:');
  emitTask(result.updated);
  emitDriverPatch(driverId, 'available', null);
  await jobAlerts.alertTaskNeedsDriver(result.updated, result.driverName, { rejected: true });
  return result.updated;
}

// Valet: "Mark Key Handed to Driver" — park tasks only (retrieve has no key
// handoff step). Clears any previous GPS start-anchor so the next location
// ping re-establishes it fresh for this leg of the trip.
async function markKeyCollected(taskId) {
  const task = await prisma.parkingTask.findUnique({ where: { id: taskId } });
  if (!task) throw ApiError.notFound('Task not found');
  if (task.type !== 'park') throw ApiError.conflict('Only park tasks have a key handoff step');
  assertTransition(task, ['assigned'], 'mark key collected');
  // Without this, a valet tapping "Key Handed to Driver" races the driver's
  // own accept/reject handshake: a reject that lands right after this call
  // would find the task already past 'assigned' and be rejected itself,
  // stranding the driver on a job they just tried to decline — or, the
  // other ordering, this call could go through with driverId already
  // cleared by a reject that landed first, leaving a 'key_collected' task
  // with no driver on it and no UI able to act on it again.
  if (!task.acceptedAt) throw ApiError.conflict('Driver has not accepted this assignment yet');

  const updated = await prisma.parkingTask.update({
    where: { id: taskId },
    data: { status: 'key_collected', keyCollectedAt: new Date(), trackingProgress: 0, driverStartLat: null, driverStartLng: null },
    include: taskInclude,
  });
  cache.invalidate('tasks:');
  // Key handed over means the assignment is definitively taken.
  watchdog.disarm('task', taskId);
  emitTask(updated);
  return updated;
}

// Driver: en route — for park tasks this follows key_collected; for retrieve
// tasks (no key handoff step) this is the driver's own "Start Retrieval" tap
// straight from "assigned", so it also clears the GPS start-anchor.
async function markInTransit(taskId, driverId) {
  const task = await prisma.parkingTask.findUnique({ where: { id: taskId } });
  if (!task) throw ApiError.notFound('Task not found');
  assertOwnDriver(task, driverId);
  const allowed = task.type === 'retrieve' ? ['assigned', 'key_collected'] : ['key_collected'];
  assertTransition(task, allowed, 'start transit');
  // A retrieve task starts here directly from 'assigned' (there's no key
  // handoff step to gate it), so this is the only place that can enforce
  // the accept handshake for that path — without it a driver who never
  // accepted could still start driving, leaving the watchdog to "time out"
  // an assignment that's actually already underway.
  if (!task.acceptedAt) throw ApiError.conflict('Accept this job before starting it');

  const updated = await prisma.parkingTask.update({
    where: { id: taskId },
    // startedAt only on the first transition — a re-entry into in_transit
    // shouldn't restart the trip clock the doctor is watching.
    data: {
      status: 'in_transit',
      driverStartLat: null,
      driverStartLng: null,
      ...(task.startedAt ? {} : { startedAt: new Date() }),
    },
    include: taskInclude,
  });
  cache.invalidate('tasks:');
  watchdog.disarm('task', taskId);
  emitTask(updated);
  return updated;
}

// Driver: "Mark Parked" — occupies the slot, frees the driver, completes the task.
async function markParked(taskId, slotId, driverId) {
  // Deliberately NOT Serializable. This runs while the task is
  // key_collected/in_transit — exactly when the driver's phone is writing a
  // GPS ping to this same row every few seconds. Under Serializable that
  // read-write dependency aborts the transaction, and the driver standing
  // at the slot gets "please try again" for a conflict that has nothing to
  // do with what they're doing.
  //
  // The race that genuinely needs protecting is two drivers claiming the
  // same free slot, and a conditional write handles that atomically at Read
  // Committed: `updateMany ... WHERE id = ? AND status = 'free'` either
  // matches (we won the slot) or matches nothing (someone else took it
  // first). No isolation escalation, no GPS contention.
  const { task, slot, freedDriver } = await prisma.$transaction(async (tx) => {
    const task = await tx.parkingTask.findUnique({ where: { id: taskId } });
    if (!task) throw ApiError.notFound('Task not found');
    assertOwnDriver(task, driverId);
    if (task.type !== 'park') throw ApiError.conflict('Only park tasks can be marked parked');
    assertTransition(task, ['key_collected', 'in_transit'], 'mark parked');
    // The valet pulled this job back mid-drive — the car is supposed to be
    // coming back to the counter, not going into a slot.
    if (task.recalledAt) {
      throw ApiError.conflict('This job was recalled — bring the car back to the valet counter instead');
    }

    const exists = await tx.parkingSlot.findUnique({ where: { id: slotId } });
    if (!exists) throw ApiError.badRequest(`Slot ${slotId} does not exist`);

    const claimed = await tx.parkingSlot.updateMany({
      where: { id: slotId, status: 'free' },
      data: {
        status: 'occupied',
        carNumber: task.carNumber,
        doctorId: task.doctorId,
        taskId: task.id,
      },
    });
    if (claimed.count === 0) throw ApiError.conflict(`Slot ${slotId} is not free`);
    const updatedSlot = await tx.parkingSlot.findUnique({ where: { id: slotId } });

    const freed = await freeDriverIfStillOn(tx, task.driverId, taskId);

    const updatedTask = await tx.parkingTask.update({
      where: { id: taskId },
      data: { slotId, status: 'completed', completedAt: new Date(), trackingProgress: 1 },
      include: taskInclude,
    });
    return { task: updatedTask, slot: updatedSlot, freedDriver: freed };
  });
  cache.invalidate('tasks:');
  cache.invalidate('slots:');
  cache.invalidate('drivers:');
  emitTask(task);
  emitSlot(slot);
  if (freedDriver && task.driverId) emitDriverPatch(task.driverId, 'available', null);
  return task;
}

// Driver: "Car Delivered to Valet Counter" — frees the slot, frees the driver.
async function markRetrieved(taskId, driverId) {
  // Read Committed, same reasoning as markParked: this runs mid-transit
  // while GPS pings are hitting this row, and Serializable would abort on
  // that alone. Nothing here races for a scarce resource — it *frees* a
  // slot rather than claiming one — so the stronger isolation bought
  // nothing and cost the driver a spurious error at the counter.
  const { task, slot, freedDriver } = await prisma.$transaction(async (tx) => {
    const task = await tx.parkingTask.findUnique({ where: { id: taskId } });
    if (!task) throw ApiError.notFound('Task not found');
    assertOwnDriver(task, driverId);
    if (task.type !== 'retrieve') throw ApiError.conflict('Only retrieve tasks can be marked retrieved');
    assertTransition(task, ['in_transit'], 'mark retrieved');
    let freedSlot = null;

    // Free the slot this retrieval was raised against. It used to also
    // require slot.carNumber === task.carNumber, which meant any drift in
    // the plate (an edit, different spacing/case) silently skipped the
    // release and stranded that slot as permanently occupied with nothing
    // able to free it again. The slot recorded on the task IS the authority
    // for which slot this retrieval empties; matching on doctorId keeps the
    // sanity check without being defeated by plate formatting.
    if (task.slotId) {
      const slot = await tx.parkingSlot.findUnique({ where: { id: task.slotId } });
      if (slot?.status === 'occupied' && slot.doctorId === task.doctorId) {
        freedSlot = await tx.parkingSlot.update({
          where: { id: task.slotId },
          data: { status: 'free', taskId: null, carNumber: null, doctorId: null },
        });
      }
    }

    const freed = await freeDriverIfStillOn(tx, task.driverId, taskId);

    const updatedTask = await tx.parkingTask.update({
      where: { id: taskId },
      // Not completed yet — the valet still has to confirm the doctor/staff
      // member actually came and took the car (see confirmDelivered below).
      data: { status: 'delivered', trackingProgress: 0.95 },
      include: taskInclude,
    });
    return { task: updatedTask, slot: freedSlot, freedDriver: freed };
  });
  cache.invalidate('tasks:');
  cache.invalidate('slots:');
  cache.invalidate('drivers:');
  emitTask(task);
  if (slot) emitSlot(slot);
  if (freedDriver && task.driverId) emitDriverPatch(task.driverId, 'available', null);

  // The one moment in a retrieval that the doctor actually has to act on:
  // their car is downstairs. Everything earlier in the journey (a valet took
  // the request, a driver was assigned, the driver set off) is already on
  // their Vehicle Status card in real time, and none of it asks anything of
  // them — so it stays silent. This is the only push they get.
  //
  // Raised here rather than from the driver's app so a driver whose phone
  // dies right after tapping "delivered" doesn't leave the doctor waiting
  // upstairs with no idea the car has arrived. 'info', not 'alarm': it
  // vibrates on the normal channel instead of ringing like a job alert.
  notificationService.push({
    targetRole: `doctor:${task.doctorId}`,
    targetUserId: task.doctorId,
    title: '🚗 Your car is ready',
    body: `${task.carNumber} is waiting at the valet counter.`,
    type: 'info',
  }).catch(() => {});

  return task;
}

// Valet: confirms the doctor/staff member actually came and took the car —
// the only thing that finally closes out a retrieval. Without this explicit
// step the system would just assume handover happened the instant the
// driver said the car arrived, with no record either way.
async function confirmDelivered(taskId) {
  const task = await prisma.parkingTask.findUnique({ where: { id: taskId } });
  if (!task) throw ApiError.notFound('Task not found');
  // A recalled park job also lands at 'delivered' (car brought back to the
  // counter) and needs the same confirmation — but its outcome is
  // 'cancelled', not 'completed': the car was never actually parked, so
  // recording it as a completed parking job would be a lie in the history.
  const isRecalledPark = task.type === 'park' && task.recalledAt != null;
  if (task.type !== 'retrieve' && !isRecalledPark) {
    throw ApiError.conflict('Only a retrieval or a recalled parking job can be confirmed');
  }
  assertTransition(task, ['delivered'], 'confirm handed over');

  const updated = await prisma.parkingTask.update({
    where: { id: taskId },
    data: {
      status: isRecalledPark ? 'cancelled' : 'completed',
      completedAt: new Date(),
      trackingProgress: 1,
    },
    include: taskInclude,
  });
  cache.invalidate('tasks:');
  emitTask(updated);
  return updated;
}

// Driver: periodic GPS ping while en route. Ownership is enforced by the
// caller (controller) — only the driver assigned to this task may update it.
// The first ping since the last key_collected/in_transit transition becomes
// the shared start-anchor every viewer computes trip progress from.
// A phone sitting still still emits a fix every few seconds. Writing every
// one of those to the task row is pure contention: it's the same row every
// state transition (mark parked / retrieved / key collected) has to read, so
// a constant stream of no-op writes is what was making those transitions
// abort and surface "please try again". Skip writes that carry no new
// information — under this threshold the stored position is already correct.
const LOCATION_MIN_MOVE_M = 8;
const LOCATION_MAX_STALE_MS = 20 * 1000;

function metersBetween(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function updateLocation(taskId, lat, lng, driverId) {
  const task = await prisma.parkingTask.findUnique({ where: { id: taskId }, include: taskInclude });
  if (!task) throw ApiError.notFound('Task not found');
  assertOwnDriver(task, driverId);
  assertTransition(task, ['key_collected', 'in_transit'], 'report location');

  const isFirstPing = task.driverStartLat == null || task.driverStartLng == null;

  // Always write the first ping (it sets the trip's start anchor) and any
  // real movement; otherwise only refresh periodically so viewers can still
  // tell the feed is alive rather than stalled.
  if (!isFirstPing && task.driverLat != null && task.driverLng != null) {
    const moved = metersBetween(task.driverLat, task.driverLng, lat, lng);
    const age = Date.now() - (task.locationUpdatedAt?.getTime() ?? 0);
    if (moved < LOCATION_MIN_MOVE_M && age < LOCATION_MAX_STALE_MS) {
      // NOTE: this is the row as read at the top of this request, and a
      // transition (mark parked/retrieved) may have committed since. Callers
      // must treat a location response as authoritative for the position
      // fields ONLY — never for status. The driver standing at the slot takes
      // this path on almost every ping, so it is the common case, not a rare
      // one.
      return task;
    }
  }

  const updated = await prisma.parkingTask.update({
    where: { id: taskId },
    data: {
      driverLat: lat,
      driverLng: lng,
      locationUpdatedAt: new Date(),
      ...(isFirstPing && { driverStartLat: lat, driverStartLng: lng }),
    },
    include: taskInclude,
  });
  cache.invalidate('tasks:');
  emitTask(updated);
  return updated;
}

// Staff/admin: retire a task that's stuck (no driver ever assigned/accepted,
// or genuinely abandoned) without waiting for a new session to naturally
// supersede it. Terminal, same weight as completed — just an honest outcome
// instead of a silent one.
// `byDoctorId` is set when a doctor/staff member cancels their own departure
// request from their app, and is what scopes them to their own car. Left
// undefined for valet/admin cancels, which may act on any job.
async function cancelTask(taskId, byDoctorId) {
  const task = await getTask(taskId);

  if (byDoctorId !== undefined) {
    if (task.doctorId !== byDoctorId) throw ApiError.forbidden('This is not your car');
    // A doctor may call off a departure they asked for. They have no business
    // voiding a parking job a valet is running.
    if (task.type !== 'retrieve') throw ApiError.conflict('Only a departure request can be cancelled', 'JOB_GONE');
    // Once the driver has set off the car is physically out of its slot, and
    // "cancel" would strand it between the slot and the counter with no job
    // describing where it should go. The honest answer is that it is already
    // coming, and the valet takes it from there.
    if (task.status === 'in_transit' || task.status === 'delivered') {
      throw ApiError.conflict('Your car is already on its way — please collect it at the valet counter', 'JOB_GONE');
    }
  }

  // Past the key handover a plain cancel isn't honest: a real car is
  // physically in a driver's hands. Those go through recallTask instead,
  // which tells the driver to bring it back rather than silently voiding a
  // job that's already in motion.
  assertTransition(task, ['requested', 'accepted', 'assigned'], 'cancel');
  watchdog.disarm('task', taskId);

  const { updated, freedDriver, restoredParkId } = await runSerializable(async tx => {
    const result = await tx.parkingTask.update({
      where: { id: taskId },
      data: { status: 'cancelled', completedAt: new Date() },
      include: taskInclude,
    });
    // A driver left mid-assignment would otherwise stay stuck 'busy' on a
    // task that no longer exists in any meaningful sense.
    const freed = await freeDriverIfStillOn(tx, task.driverId, taskId);

    // Cancelling a departure means the car is STILL PARKED — it never left
    // its slot. But requestRetrieval retired the park task to make this
    // retrieve the doctor's current row, so cancelling used to leave a
    // cancelled retrieve as the only current row. The doctor's screen reads
    // that as "no session at all" and falls back to the arrival prompt,
    // while their car sits in the slot with no way to ask for it again.
    //
    // So hand the session back to the park task that still owns the slot.
    // ParkingSlot.taskId points straight at it (set by markParked), so there
    // is no guessing about which row to restore.
    let restored = null;
    if (task.type === 'retrieve') {
      const slot = await tx.parkingSlot.findFirst({
        where: { status: 'occupied', doctorId: task.doctorId, taskId: { not: null } },
      });
      if (slot?.taskId) {
        // Step down before promoting: "at most one isCurrent row per doctor"
        // is a partial unique index, and the other order trips it.
        await tx.parkingTask.update({ where: { id: taskId }, data: { isCurrent: false } });
        await tx.parkingTask.update({ where: { id: slot.taskId }, data: { isCurrent: true } });
        restored = slot.taskId;
      }
    }
    return { updated: result, freedDriver: freed, restoredParkId: restored };
  });

  cache.invalidate('tasks:');
  if (freedDriver && task.driverId) {
    cache.invalidate('drivers:');
    emitDriverPatch(task.driverId, 'available', null);
  }
  emitTask(updated);
  // The park row is current again, so every client has to see it — otherwise
  // the doctor's app keeps the cancelled retrieve and still shows no car.
  if (restoredParkId) {
    const restored = await prisma.parkingTask.findUnique({ where: { id: restoredParkId }, include: taskInclude });
    if (restored) emitTask(restored);
  }

  // Whoever was working this needs telling, or a valet walks out to a car
  // nobody is coming for and a driver drives to a slot for no reason.
  if (byDoctorId !== undefined) {
    const who = updated.doctor?.name ?? 'A doctor';
    const owner = updated.retrievalOwnerValetId ?? updated.arrivalOwnerValetId ?? updated.valetId;
    notificationService.push(owner
      ? {
          targetRole: `valet:${owner}`,
          targetUserId: owner,
          title: '❌ Departure cancelled',
          body: `${who} cancelled the request for ${updated.carNumber}.`,
          type: 'alarm',
        }
      : {
          targetRole: 'valet',
          title: '❌ Departure cancelled',
          body: `${who} cancelled the request for ${updated.carNumber}.`,
          type: 'alarm',
        }).catch(() => {});

    if (task.driverId) {
      notificationService.push({
        targetRole: `driver:${task.driverId}`,
        title: '❌ Retrieval cancelled',
        body: `${updated.carNumber} is no longer needed — stand down.`,
        type: 'alarm',
      }).catch(() => {});
      // Their card is about to vanish; kill the assignment alarm at source.
      realtime.emitToDriver(task.driverId, 'assignment:cancelled', { kind: 'task', id: taskId });
    }
  }

  return updated;
}

// Valet: abort a park job the driver is already out on — "don't park it,
// bring it back". The car physically exists in someone's hands, so this
// can't just blank the record: the driver is told to return it, marks it
// returned at the counter (markReturned -> 'delivered'), and the valet
// confirms they physically have it back (confirmDelivered -> 'cancelled').
// Same two-step handshake a retrieval already uses, for the same reason.
async function recallTask(taskId) {
  const task = await getTask(taskId);
  if (task.type !== 'park') throw ApiError.conflict('Only a parking job can be recalled');
  assertTransition(task, ['key_collected', 'in_transit'], 'recall');
  if (task.recalledAt) throw ApiError.conflict('This job has already been recalled');

  const updated = await prisma.parkingTask.update({
    where: { id: taskId },
    data: { recalledAt: new Date() },
    include: taskInclude,
  });
  cache.invalidate('tasks:');
  emitTask(updated);

  if (updated.driverId) {
    notificationService.push({
      targetRole: `driver:${updated.driverId}`,
      title: '🔔 Job Recalled — Bring the Car Back',
      body: `Do not park ${updated.carNumber}. Return it to the valet counter.`,
      type: 'alarm',
    }).catch(() => {});
  }
  // Their Vehicle Status card is showing "being parked" — without this it
  // would just silently revert with no explanation of where the car went.
  notificationService.push({
    targetRole: `doctor:${updated.doctorId}`,
    targetUserId: updated.doctorId,
    title: 'Parking Cancelled',
    body: `${updated.carNumber} is being brought back to the valet counter instead of parked.`,
    type: 'warning',
  }).catch(() => {});

  return updated;
}

// Driver: "car returned to the valet counter" — the recall's counterpart to
// markParked. Frees the driver; the valet still has to confirm receipt.
async function markReturned(taskId, driverId) {
  // Read Committed — same mid-transit GPS contention as markParked/markRetrieved.
  const { task, freedDriver } = await prisma.$transaction(async (tx) => {
    const existing = await tx.parkingTask.findUnique({ where: { id: taskId } });
    if (!existing) throw ApiError.notFound('Task not found');
    assertOwnDriver(existing, driverId);
    if (!existing.recalledAt) throw ApiError.conflict('This job was not recalled');
    assertTransition(existing, ['key_collected', 'in_transit'], 'mark returned');

    const freed = await freeDriverIfStillOn(tx, existing.driverId, taskId);
    const updated = await tx.parkingTask.update({
      where: { id: taskId },
      data: { status: 'delivered', trackingProgress: 1 },
      include: taskInclude,
    });
    return { task: updated, freedDriver: freed };
  });
  cache.invalidate('tasks:');
  cache.invalidate('drivers:');
  emitTask(task);
  if (freedDriver && task.driverId) emitDriverPatch(task.driverId, 'available', null);

  // The valet who recalled this car is the one waiting for it at the counter,
  // so ring them alone. Unowned jobs still go to the floor — a car sitting
  // there unconfirmed is worse than an extra alarm.
  const returnOwner = task.valetId ?? task.arrivalOwnerValetId;
  notificationService.push(returnOwner
    ? {
        targetRole: `valet:${returnOwner}`,
        targetUserId: returnOwner,
        title: '🔔 Recalled Car Returned — Confirm',
        body: `${task.carNumber} is back at the counter. Confirm once you have the key.`,
        type: 'alarm',
      }
    : {
        targetRole: 'valet',
        title: '🔔 Recalled Car Returned — Confirm',
        body: `${task.carNumber} is back at the counter. Confirm once you have the key.`,
        type: 'alarm',
      }).catch(() => {});
  return task;
}

module.exports = {
  isVisibleToValet,
  isRetrievalScheduled,
  notifyRetrievalOwner,
  // Exported so the scheduler sweep emits through the SAME ownership-aware
  // path, rather than re-implementing who is allowed to see a retrieval.
  emitTask,
  isRetrievalOpenToAll,
  listTasks,
  getTask,
  createTask,
  requestRetrieval,
  assignDriver,
  acceptTask,
  rejectTask,
  markKeyCollected,
  markInTransit,
  markParked,
  markRetrieved,
  confirmDelivered,
  cancelTask,
  recallTask,
  markReturned,
  updateLocation,
};
