// FCM push — how the driver alarm still lands when the app is killed or the
// phone was rebooted (Android wakes the app for a high-priority push; the
// client's background handler then raises the full alarm notification).
//
// Entirely optional at runtime: without FIREBASE_SERVICE_ACCOUNT (path to a
// service-account JSON, or the JSON itself / base64 of it) every send is a
// silent no-op, so the server runs fine before Firebase is set up.
const prisma = require('../config/database');
const parseId = require('../utils/parseId');

let messaging = null;

function init() {
  if (messaging) return messaging;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    // firebase-admin v14 dropped the old admin.credential.cert()/admin.messaging()
    // namespaced API in favor of flat top-level exports.
    // eslint-disable-next-line global-require
    const admin = require('firebase-admin');
    // eslint-disable-next-line global-require
    const { getMessaging } = require('firebase-admin/messaging');
    let serviceAccount;
    if (raw.trim().startsWith('{')) {
      serviceAccount = JSON.parse(raw);
    } else if (/^[A-Za-z0-9+/=]+$/.test(raw.trim()) && !raw.includes('/')) {
      serviceAccount = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } else {
      serviceAccount = require(raw);
    }
    const existing = admin.getApps();
    const app = existing.length ? existing[0] : admin.initializeApp({ credential: admin.cert(serviceAccount) });
    messaging = getMessaging(app);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[push] Firebase init failed, pushes disabled:', err.message);
  }
  return messaging;
}

async function registerDevice(userId, token, platform = 'android') {
  return prisma.deviceToken.upsert({
    where: { token },
    // A token can migrate between accounts on a shared device — rebind it.
    update: { userId, platform },
    create: { userId, token, platform },
  });
}

// Called on logout so a phone stops receiving this account's pushes the
// moment it signs out, instead of staying bound until someone else logs in
// on the same device. Scoped to (userId, token) so a request can only drop
// its own registration, never another account's.
async function unregisterDevice(userId, token) {
  await prisma.deviceToken.deleteMany({ where: { userId, token } });
}

// Resolve a Notification-style target (role name, 'all', 'driver:<id>',
// 'doctor:<userId>' or explicit userId) to the concrete user ids to push to.
async function resolveTargetUserIds(targetRole, targetUserId) {
  const ids = new Set();
  if (targetUserId) ids.add(targetUserId);
  if (!targetRole || targetRole === 'all') {
    if (targetRole === 'all') {
      const users = await prisma.user.findMany({ select: { id: true } });
      users.forEach(u => ids.add(u.id));
    }
    return [...ids];
  }
  const [kind, scopedId] = targetRole.split(':');
  if (scopedId) {
    if (kind === 'driver') {
      const driver = await prisma.driver.findUnique({ where: { id: parseId(scopedId) } });
      if (driver) ids.add(driver.userId);
    } else {
      ids.add(parseId(scopedId)); // 'doctor:<userId>' style — the id is a user id
    }
  } else {
    const users = await prisma.user.findMany({ where: { role: kind }, select: { id: true } });
    users.forEach(u => ids.add(u.id));
  }
  return [...ids];
}

// Fire-and-forget: notification delivery must never fail the API call that
// triggered it. Alarm-type pushes ride the alarm channel with max priority
// so Android shows them loud even with the app dead.
// `notifId` becomes the notification's id on the device. Both delivery paths
// (this push, and the socket's notification:new) carry it, so the same event
// resolves to ONE tray entry instead of two — see displayNotification on the
// app side. Every value in an FCM data payload must be a string.
// How long FCM keeps retrying an undelivered message.
//
// This MUST NOT outlive the thing the message is about. An assignment alarm
// is only true for as long as the driver still has the job: past the accept
// window the watchdog has already rolled it back, freed the driver and moved
// on — so a late delivery rings a phone about a job that no longer exists,
// which is exactly the "I opened it and there was nothing there" report. It
// used to be a flat 5 minutes against a 60-second window, leaving four
// minutes in which every delivery was guaranteed stale.
//
// Informational pushes ("your car is ready") describe something that stays
// true, so those keep the longer window.
const INFO_TTL_MS = 5 * 60 * 1000;

async function alarmTtlMs() {
  try {
    // eslint-disable-next-line global-require
    return await require('./setting.service').getAcceptTimeoutMs();
  } catch {
    return 60 * 1000;
  }
}

async function pushToUsers(userIds, { title, body, type = 'info', notifId, tag, data = {}, alarmLevel = 'short' }) {
  const m = init();
  if (!m || userIds.length === 0) return;

  const tokens = await prisma.deviceToken.findMany({ where: { userId: { in: userIds } } });
  if (tokens.length === 0) return;

  // Tray identity. Defaults to the notification's own id (one event, one
  // entry) but a caller can pass a stable job-scoped tag so a later message
  // about the SAME job — notably the cancellation below — replaces the
  // original entry instead of stacking a second, contradictory one.
  const trayTag = tag ?? (notifId != null ? `kims-notif-${notifId}` : undefined);
  const ttl = type === 'alarm' ? await alarmTtlMs() : INFO_TTL_MS;

  // A data-only message needs the app's background handler to run in order to
  // show anything. That is fine while the app is merely backgrounded, but a
  // swiped-away app is treated as force-stopped by most OEM Androids
  // (Xiaomi/MIUI, Oppo, Vivo, Realme, Samsung), and force-stopped apps never
  // receive data-only pushes — Android won't launch a force-stopped app's
  // broadcast receivers, full stop — so the notification silently never
  // appeared.
  //
  // A `notification` block is rendered by Play Services itself, in ITS OWN
  // process, not the app's — that survives a killed/force-stopped app,
  // which is why the non-alarm path below already uses one.
  const isAlarm = type === 'alarm';
  const message = {
    tokens: tokens.map(t => t.token),
    data: {
      title, body, type,
      // The device picks its ring channel from this. Long alarms are for a
      // person actually waiting on someone (a retrieval or arrival request);
      // everything else rings briefly, so the loud one keeps its meaning.
      alarmLevel,
      ...(notifId != null ? { notifId: String(notifId) } : {}),
      ...data,
    },
    ...(isAlarm ? {} : { notification: { title, body } }),
    android: {
      priority: 'high',
      ttl,
      ...(isAlarm ? {} : {
        notification: {
          // v2: the original channel was created with no explicit sound —
          // silent on several Android builds, and channels are immutable
          // after creation, so this has to be a fresh id to actually reach
          // installs that already made the v1 one. See notifications.ts.
          channelId: 'kims_parking_v2',
          // Same identity the in-app path uses, so a repeat delivery replaces
          // the entry instead of stacking a second one.
          ...(trayTag ? { tag: trayTag } : {}),
        },
      }),
    },
  };

  // Alarms stay data-only in the message above ON PURPOSE — adding a
  // `notification` block to THAT message would make Android auto-display a
  // plain system notification instead of invoking the background handler at
  // all while merely backgrounded (not killed), silently downgrading the
  // rich full-screen ring to a generic tray entry for the common case.
  //
  // But that leaves a genuinely killed/force-stopped app with nothing —
  // exactly the "kill state" gap this was missing. So alarms ALSO get a
  // second, separate, notification-only message: Play Services renders this
  // one by itself regardless of app state, so it's the one thing that still
  // reaches a force-stopped app. It rides the SAME channel id notifee's
  // ringAssignmentAlarm uses on-device, so on the rare device where both
  // land (backgrounded-but-alive), it still rings with that channel's real
  // alarm sound/vibration rather than a silent generic one — not a literal
  // duplicate-suppression, but never worse than the loud ring either way.
  const fallbackMessage = isAlarm ? {
    tokens: tokens.map(t => t.token),
    notification: { title, body },
    android: {
      priority: 'high',
      ttl,
      notification: {
        // MUST match the app's notifications.ts channel ids, and the
        // manifest's default_notification_channel_id.
        //
        // This was left on _v2 after the app moved to _v3, and that single
        // mismatch is what broke the killed-state alarm: Play Services
        // rendered this message against a channel the device had never
        // created, so Android dropped it or demoted it to system defaults.
        // The manifest fallback pointed at the same dead id, so there was
        // nothing to catch it. Changing the app's channel means changing all
        // three, together.
        // Killed-state alarms are rendered by Play Services against a channel
        // the device already created, so the LEVEL has to choose the channel
        // here — the app is not running to choose it.
        channelId: alarmLevel === 'long' ? 'kims_parking_ring_v4' : 'kims_parking_ring_short_v1',
        ...(trayTag ? { tag: trayTag } : {}),
      },
    },
  } : null;

  const pruneDead = async (res) => {
    const dead = [];
    res.responses.forEach((r, i) => {
      const code = r.error?.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        dead.push(tokens[i].token);
      }
    });
    if (dead.length) await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
  };

  try {
    const res = await m.sendEachForMulticast(message);
    await pruneDead(res);
    if (fallbackMessage) {
      const fbRes = await m.sendEachForMulticast(fallbackMessage);
      await pruneDead(fbRes);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[push] send failed:', err.message);
  }
}

async function pushToTarget(targetRole, targetUserId, payload) {
  const userIds = await resolveTargetUserIds(targetRole, targetUserId);
  return pushToUsers(userIds, payload);
}

// Stable tray identity for everything said about one assignment, so the
// "this job is yours" alarm and the "it expired" notice that follows it are
// the same entry on the device rather than two contradictory ones sitting
// side by side.
function assignmentTag(kind, id) {
  return `kims-assign-${kind}-${id}`;
}

module.exports = { registerDevice, unregisterDevice, pushToUsers, pushToTarget, resolveTargetUserIds, assignmentTag };
