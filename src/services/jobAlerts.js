const prisma = require('../config/database');
const realtime = require('../realtime');
const notificationService = require('./notification.service');
const settingService = require('./setting.service');
const { serializeTask, serializeVisitor } = require('../utils/serialize');
const ApiError = require('../utils/ApiError');
const valetRoster = require('./valetRoster');

// Lazy, matching acceptWatchdog: task.service requires THIS module, so a
// top-level require here would be circular and one of the two would see an
// empty object at load time.
function taskService() { return require('./task.service'); }

// Who gets told when a job needs a valet's attention (driver rejected, or
// never accepted in time).
//
// Previously every one of these woke EVERY valet on shift. Now the job's
// owning valet is alarmed alone, and only escalates if they don't act:
//
//   1. the owning valet, alone
//   2. -> every valet, once the owner has had their window and not acted
//
// There used to be a third rung that alarmed admins, on the reasoning that
// "escalate to all valets" is a no-op on a single-valet site. Admins are
// deliberately out of the alert path now: dispatch is not their job, and
// being pulled into every stall on the floor with a prompt they had no
// reason to answer made the alerts noise. They still receive all task DATA,
// so their dashboard is unchanged — they simply stop being alarmed.
//
// That does remove the last automated rung on a single-valet site. The real
// backstop was never the pushes anyway: it's that the job stays in the queue
// in a loud "needs a driver" state nobody can miss on next open. A push can
// silently fail; the queue cannot.

// How long the owner gets before the rest of the valets are pulled in. Reuses
// the admin-configured driver-accept window so operations only tune one knob.
async function ownerGraceMs() {
  return settingService.getAcceptTimeoutMs();
}

// Valets only. This event raises an actionable "assign another driver"
// dialog, and dispatch is not an admin's job — they were being pulled into
// every stall on the floor with a prompt they had no reason to answer.
// Admins still receive all task DATA (see emitTask), so their dashboard is
// unaffected; they simply stop being alarmed.
function emitTaskReassign(task, driverName, rejected, scope) {
  const payload = { task: serializeTask(task), driverName, rejected, scope };
  if (scope === 'owner' && task.valetId) {
    realtime.emitToUser(task.valetId, 'task:needs-reassign', payload);
  } else {
    realtime.emitToRoles(['valet'], 'task:needs-reassign', payload);
  }
}

function emitVisitorReassign(visitor, driverName, rejected, scope) {
  const payload = { visitor: serializeVisitor(visitor), driverName, rejected, scope };
  if (scope === 'owner' && visitor.valetId) {
    realtime.emitToUser(visitor.valetId, 'visitor:needs-reassign', payload);
  } else {
    realtime.emitToRoles(['valet'], 'visitor:needs-reassign', payload);
  }
}

// One alert, addressed as narrowly as the job allows. An unowned job (a
// retrieval nobody has picked up yet) has no one to address, so it goes to
// everyone — that's correct, not a fallback.
async function notifyOwnerOrAll({ valetId, title, body }) {
  if (valetId) {
    // 'valet:<id>' — NOT plain 'valet'. A bare role name is a broadcast: both
    // the socket fan-out and the FCM resolver expand it to every user with
    // that role, which silently defeated the whole point of owning a job
    // (and delivered it to the owner twice, once via each path).
    return notificationService.push({
      targetRole: `valet:${valetId}`, targetUserId: valetId, title, body, type: 'alarm',
    });
  }
  return notificationService.push({ targetRole: 'valet', title, body, type: 'alarm' });
}

// Restarts the owning valet's escalation window. Used both when a job first
// becomes stalled, and when the owner explicitly acknowledges the prompt —
// tapping "Later" is them saying "seen it, I'll handle it", so broadcasting
// to every valet moments later actively contradicts what they just told us.
// It defers rather than cancels: ignore it for a full window and it still
// escalates, because a real car with no driver can't be deferred forever.
async function touchOwnerWindow(kind, id) {
  const data = { valetClaimedAt: new Date(), escalatedAt: null };
  const model = kind === 'task' ? prisma.parkingTask : prisma.visitor;
  await model.update({ where: { id }, data }).catch(() => {});
}

async function alertTaskNeedsDriver(task, driverName, { rejected = false } = {}) {
  // The owner's grace window starts NOW — the moment the job actually became
  // stalled. valetClaimedAt was last stamped when they assigned the driver,
  // and the driver then had the full accept window to respond, so by the time
  // we get here that timestamp is already older than the escalation cutoff:
  // the owner's window and the driver's ran concurrently instead of one after
  // the other, and the sweep escalated to every valet within seconds of the
  // owner being told. Re-stamping gives them their own window, from here.
  await touchOwnerWindow('task', task.id);
  emitTaskReassign(task, driverName, rejected, task.valetId ? 'owner' : 'all');
  const why = rejected ? 'rejected the job' : "didn't accept in time";
  await notifyOwnerOrAll({
    valetId: task.valetId,
    title: '⚠️ Driver did not accept',
    body: `${driverName} ${why} for ${task.carNumber}. Please assign another driver.`,
  }).catch(() => {});
}

async function alertVisitorNeedsDriver(visitor, driverName, { rejected = false } = {}) {
  await touchOwnerWindow('visitor', visitor.id);
  emitVisitorReassign(visitor, driverName, rejected, visitor.valetId ? 'owner' : 'all');
  const why = rejected ? 'rejected the job' : "didn't accept in time";
  await notifyOwnerOrAll({
    valetId: visitor.valetId,
    title: '⚠️ Driver did not accept',
    body: `${driverName} ${why} for ${visitor.name}'s pickup. Please assign another driver.`,
  }).catch(() => {});
}

// Rungs 2 and 3. Runs on a sweep rather than a per-job timer so it survives
// a restart for free (unlike the in-memory accept watchdog, which has to
// rehydrate itself explicitly).
const SWEEP_INTERVAL_MS = 30 * 1000;
let sweepTimer = null;

// Departure requests whose owner never responded. Their session owner was
// alarmed alone (that's the point of ownership) — but an owner who is on a
// break, off shift, or simply not looking at their phone cannot be allowed to
// hold a doctor's car hostage. After a configurable window the request goes
// back out to every available valet, tagged with why.
//
// The original arrivalOwnerValetId is deliberately left untouched: the record
// of who took that car in is history, not a routing field.
// SCHEDULED -> READY. A departure booked for later sits silent on the
// Retrieval Requests page until its lead time is reached; this is what makes
// it actionable and alerts the one valet who owns it.
//
// Runs on the same sweep as everything else rather than a per-request timer,
// so it survives a restart for free — an in-memory timer for a departure six
// hours out would simply be lost on the next deploy.
async function promoteScheduledRetrievals() {
  const now = new Date();
  const due = await prisma.parkingTask.findMany({
    where: {
      type: 'retrieve',
      status: 'requested',
      isCurrent: true,
      driverId: null,
      retrievalReadyAt: { lte: now },
      // Not yet alerted — this is the flag that makes the promotion happen
      // exactly once, and it is also what starts the owner's response clock.
      ownerNotifiedAt: null,
    },
    include: { doctor: true, visitor: true, driver: { include: { user: true } }, valet: true, arrivalOwnerValet: true, retrievalOwnerValet: true },
    take: 50,
  });

  let promoted = 0;
  for (const task of due) {
    // Conditional so two sweep ticks — or two server processes — cannot both
    // promote the same row and alert the owner twice.
    const won = await prisma.parkingTask.updateMany({
      where: { id: task.id, ownerNotifiedAt: null },
      data: { ownerNotifiedAt: now, valetClaimedAt: now },
    });
    if (won.count === 0) continue;

    const fresh = await prisma.parkingTask.findUnique({
      where: { id: task.id },
      include: { doctor: true, visitor: true, driver: { include: { user: true } }, valet: true, arrivalOwnerValet: true, retrievalOwnerValet: true },
    });
    if (!fresh) continue;

    // The row's own delta — this is what flips it from SCHEDULED to READY on
    // the page. taskService.emitTask keeps it addressed to the owner alone.
    taskService().emitTask(fresh);
    await taskService().notifyRetrievalOwner(fresh).catch(() => {});
    promoted += 1;
  }
  return promoted;
}

async function releaseUnansweredRetrievals() {
  const cutoff = new Date(Date.now() - await settingService.getOwnerResponseWindowMs());

  const stalled = await prisma.parkingTask.findMany({
    where: {
      type: 'retrieve',
      status: 'requested',
      isCurrent: true,
      driverId: null,
      arrivalOwnerValetId: { not: null },
      // Nobody has claimed the retrieval itself — an owner who accepted is
      // responding, and an owner who assigned a driver has driverId set.
      retrievalOwnerValetId: null,
      recoveryBroadcastAt: null,
      // Null means the owner has not been alerted yet — the request is still
      // SCHEDULED. Recovery measures from the notification, so a departure
      // booked for later cannot be "unanswered" before anyone was asked.
      ownerNotifiedAt: { not: null, lt: cutoff },
    },
    include: { doctor: true, visitor: true, arrivalOwnerValet: true },
    take: 50,
  });

  // Whether there is anyone to hand these to. Read once per sweep rather than
  // per job — the roster can't change halfway through a loop that takes
  // milliseconds.
  const solo = await valetRoster.isSoloValetSite();

  for (const task of stalled) {
    // Conditional so two sweep ticks (or two processes) can't both broadcast.
    const released = await prisma.parkingTask.updateMany({
      where: { id: task.id, recoveryBroadcastAt: null, retrievalOwnerValetId: null },
      data: { recoveryBroadcastAt: new Date() },
    });
    if (released.count === 0) continue;

    const fresh = await prisma.parkingTask.findUnique({
      where: { id: task.id },
      include: { doctor: true, visitor: true, driver: { include: { user: true } }, valet: true, arrivalOwnerValet: true, retrievalOwnerValet: true },
    });

    // The record still goes out — recoveryBroadcastAt lifts the ownership
    // guards, so admins can now step in either way, and the owner's own card
    // needs to reflect the new state.
    realtime.emitToRoles(['valet', 'admin'], 'task:upsert', serializeTask(fresh));

    const who = taskService().ownerLabel(task, 'A guest');
    if (solo) {
      // There is no "original owner unavailable" to report to anyone: the
      // only valet IS the owner, and telling them someone is unavailable —
      // or that the first to accept takes it — describes a situation that
      // doesn't exist. What's actually true is that a car has been waiting,
      // so that's what gets said, to the one person who can do anything.
      await notificationService.push({
        targetRole: `valet:${task.arrivalOwnerValetId}`,
        targetUserId: task.arrivalOwnerValetId,
        title: '⏰ Still waiting for a driver',
        body: `${who} is still waiting for ${task.carNumber}. Please assign a driver.`,
        type: 'alarm',
      }).catch(() => {});
      continue;
    }

    realtime.emitToRoles(['valet', 'admin'], 'task:recovery', {
      task: serializeTask(fresh),
      reason: 'Original owner unavailable',
    });
    await notificationService.push({
      targetRole: 'valet',
      title: '🚗 Retrieval needs a valet',
      body: `${task.carNumber} — original owner unavailable. First to accept takes it.`,
      type: 'alarm',
    }).catch(() => {});
  }

  return stalled.length;
}

// First valet to accept a released retrieval takes it. Same WHERE-clause
// guard as arrival accept: the loser's UPDATE matches zero rows, so the
// database decides, not whose tap reached the server on a faster network.
async function claimRetrieval(taskId, valetId) {
  // Same rule as assignDriver: a scheduled departure cannot be accepted
  // early, whoever is asking. Checked before the claim so the answer is the
  // honest reason rather than a generic "no longer available".
  const pre = await prisma.parkingTask.findUnique({ where: { id: taskId } });
  if (pre && taskService().isRetrievalScheduled(pre)) {
    throw ApiError.conflict('This departure is scheduled for later and is not ready yet', 'NOT_READY');
  }

  const claimed = await prisma.parkingTask.updateMany({
    where: {
      id: taskId,
      type: 'retrieve',
      // 'accepted' too: a retrieval whose driver assignment was rolled back
      // sits there, and if its holder then goes quiet it must still be
      // claimable by whoever picks it up.
      status: { in: ['requested', 'accepted'] },
      // Claimable when nobody holds it, or when whoever did hold it has
      // already been escalated past.
      OR: [
        { retrievalOwnerValetId: null, recoveryBroadcastAt: { not: null } },
        { retrievalOwnerValetId: null, arrivalOwnerValetId: valetId },
        { escalatedAt: { not: null } },
      ],
    },
    data: {
      retrievalOwnerValetId: valetId,
      retrievalAcceptedAt: new Date(),
      // RECOVERY only when they are NOT the original owner — an owner
      // answering inside their own window is the normal path, not a recovery.
      valetId,
      valetClaimedAt: new Date(),
      escalatedAt: null,
      status: 'accepted',
    },
  });

  const task = await prisma.parkingTask.findUnique({
    where: { id: taskId },
    include: { doctor: true, visitor: true, driver: { include: { user: true } }, valet: true, arrivalOwnerValet: true, retrievalOwnerValet: true },
  });
  if (!task) throw ApiError.notFound('Retrieval request not found');

  if (claimed.count === 0) {
    if (task.retrievalOwnerValetId && task.retrievalOwnerValetId !== valetId) {
      throw ApiError.conflict('This retrieval request has already been accepted.', 'ALREADY_ACCEPTED');
    }
    if (task.retrievalOwnerValetId !== valetId) {
      throw ApiError.conflict('This retrieval request is no longer available.', 'JOB_GONE');
    }
    return task; // idempotent re-accept by the same valet
  }

  // Source is derived from who won, and written after the claim so it can't
  // race with the claim itself.
  const source = task.arrivalOwnerValetId === valetId ? 'OWNER' : 'RECOVERY';
  const withSource = await prisma.parkingTask.update({
    where: { id: taskId },
    data: { retrievalOwnershipSource: source },
    include: { doctor: true, visitor: true, driver: { include: { user: true } }, valet: true, arrivalOwnerValet: true, retrievalOwnerValet: true },
  });

  const payload = serializeTask(withSource);
  realtime.emitToRoles(['doctor', 'staff', 'driver', 'admin'], 'task:upsert', payload);
  realtime.emitToUser(valetId, 'task:upsert', payload);
  // Everyone who saw the recovery broadcast loses the action now.
  realtime.emitToRoles(['valet'], 'task:restrict', { id: taskId, ownerValetId: valetId });
  return withSource;
}

async function escalateStalledJobs() {
  const graceMs = await ownerGraceMs();
  const cutoff = new Date(Date.now() - graceMs);

  // A job is stalled if it's sitting with no driver, owned by someone who
  // hasn't acted since before the cutoff, and hasn't already been escalated.
  const [tasks, visitors] = await Promise.all([
    prisma.parkingTask.findMany({
      where: {
        status: { in: ['requested', 'accepted', 'assigned'] },
        driverId: null,
        valetId: { not: null },
        escalatedAt: null,
        valetClaimedAt: { lt: cutoff },
        // Every unclaimed departure belongs to the recovery pass below, not
        // to this one. That covers all three of its states — scheduled for
        // later, inside the owner's private window, and already broadcast —
        // and recovery IS the escalation for them: it has already told every
        // valet. Excluding only the first two meant a recovered request got a
        // SECOND round one tick later ("still needs a driver" to the whole
        // team) for a car the whole team had just been told about.
        //
        // A retrieval someone has actually claimed and then sat on still
        // escalates here, which is the case this pass exists for.
        NOT: {
          type: 'retrieve',
          retrievalOwnerValetId: null,
        },
      },
      include: { doctor: true, visitor: true, driver: { include: { user: true } }, valet: true },
      take: 50,
    }),
    prisma.visitor.findMany({
      where: {
        status: 'pending',
        driverId: null,
        valetId: { not: null },
        escalatedAt: null,
        valetClaimedAt: { lt: cutoff },
      },
      include: { driver: { include: { user: true } } },
      take: 50,
    }),
  ]);

  // Rung 2 is "pull in the rest of the team". With one valet there is no rest
  // of the team, so it is skipped entirely and the ladder goes straight to
  // rung 3 (admins) — the only rung that reaches someone new.
  const solo = await valetRoster.isSoloValetSite();

  for (const task of tasks) {
    await prisma.parkingTask.update({
      where: { id: task.id },
      data: {
        escalatedAt: new Date(),
        // A retrieval escalating past its holder is the same event as an
        // unanswered one being released: it has to become visible to the
        // valets we're about to alarm, or they get a notification for a card
        // that isn't on their screen.
        ...(task.type === 'retrieve' && !task.recoveryBroadcastAt ? { recoveryBroadcastAt: new Date() } : {}),
      },
    }).catch(() => {});
    // Rung 2: the whole valet team. driverName is deliberately null — no
    // driver failed here, the job simply never got one. It used to pass the
    // VALET's name into a field the prompt renders as the driver, so the
    // owner was told "Ramesh didn't accept in time" about themselves.
    if (!solo) {
      emitTaskReassign(task, null, false, 'all');
      await notificationService.push({
        targetRole: 'valet',
        title: '⚠️ Job still needs a driver',
        body: `${task.carNumber} still has no driver. Please assign one.`,
        type: 'alarm',
      }).catch(() => {});
    }
  }

  for (const visitor of visitors) {
    await prisma.visitor.update({ where: { id: visitor.id }, data: { escalatedAt: new Date() } }).catch(() => {});
    if (!solo) {
      emitVisitorReassign(visitor, null, false, 'all');
      await notificationService.push({
        targetRole: 'valet',
        title: '⚠️ Pickup still needs a driver',
        body: `${visitor.name}'s car still has no driver. Please assign one.`,
        type: 'alarm',
      }).catch(() => {});
    }
  }

  const promoted = await promoteScheduledRetrievals().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[jobAlerts] scheduled promotion failed:', err.message);
    return 0;
  });

  const released = await releaseUnansweredRetrievals().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[jobAlerts] retrieval release failed:', err.message);
    return 0;
  });

  return tasks.length + visitors.length + released + promoted;
}

function startEscalationSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    escalateStalledJobs().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[jobAlerts] escalation sweep failed:', err.message);
    });
  }, SWEEP_INTERVAL_MS);
  // Don't hold the process open purely for this timer.
  if (sweepTimer.unref) sweepTimer.unref();
}

function stopEscalationSweep() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}

module.exports = {
  touchOwnerWindow,
  promoteScheduledRetrievals,
  releaseUnansweredRetrievals,
  claimRetrieval,
  alertTaskNeedsDriver,
  alertVisitorNeedsDriver,
  escalateStalledJobs,
  startEscalationSweep,
  stopEscalationSweep,
};
