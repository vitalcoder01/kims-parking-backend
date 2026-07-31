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
async function pushToUsers(userIds, { title, body, type = 'info', notifId, data = {} }) {
  const m = init();
  if (!m || userIds.length === 0) return;

  const tokens = await prisma.deviceToken.findMany({ where: { userId: { in: userIds } } });
  if (tokens.length === 0) return;

  const message = {
    tokens: tokens.map(t => t.token),
    data: { title, body, type, ...(notifId != null ? { notifId: String(notifId) } : {}), ...data },
    android: {
      priority: 'high',
      ttl: 5 * 60 * 1000,
    },
  };

  try {
    const res = await m.sendEachForMulticast(message);
    // Prune tokens FCM says are dead so the table doesn't grow stale forever.
    const dead = [];
    res.responses.forEach((r, i) => {
      const code = r.error?.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        dead.push(tokens[i].token);
      }
    });
    if (dead.length) await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[push] send failed:', err.message);
  }
}

async function pushToTarget(targetRole, targetUserId, payload) {
  const userIds = await resolveTargetUserIds(targetRole, targetUserId);
  return pushToUsers(userIds, payload);
}

module.exports = { registerDevice, unregisterDevice, pushToUsers, pushToTarget, resolveTargetUserIds };
