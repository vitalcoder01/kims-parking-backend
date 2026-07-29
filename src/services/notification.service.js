const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const realtime = require('../realtime');
const pushService = require('./push.service');
const { serializeNotification } = require('../utils/serialize');

// targetRole supports role-wide broadcast ('valet', 'driver', 'doctor', 'all')
// or a precise 'driver:<driverId>' style tag, matching the mobile app.
// targetUserId (optional) additionally scopes to one exact user.
//
// Creating a notification now also (a) emits it over the socket to exactly
// the clients it targets — this is what makes phones ring in real time —
// and (b) sends an FCM push so killed/rebooted apps still get it.
async function push({ targetRole, targetUserId, title, body, type, data }) {
  const notif = await prisma.notification.create({
    data: { targetRole, targetUserId: targetUserId ?? null, title, body, type: type || 'info' },
  });

  const serialized = serializeNotification(notif);
  emitTargeted(targetRole, targetUserId, serialized);
  // Fire-and-forget: FCM latency/failures must never block the API response.
  pushService.pushToTarget(targetRole, targetUserId, { title, body, type: type || 'info', data }).catch(() => {});

  return notif;
}

function emitTargeted(targetRole, targetUserId, payload) {
  if (targetUserId) realtime.emitToUser(targetUserId, 'notification:new', payload);
  if (!targetRole) return;
  if (targetRole === 'all') {
    realtime.emitAll('notification:new', payload);
    return;
  }
  const [kind, scopedId] = targetRole.split(':');
  if (scopedId) {
    if (kind === 'driver') realtime.emitToDriver(scopedId, 'notification:new', payload);
    // 'doctor:<userId>' style tags carry a user id; skip if already sent
    // via targetUserId above.
    else if (scopedId !== targetUserId) realtime.emitToUser(scopedId, 'notification:new', payload);
  } else {
    realtime.emitToRoles([kind], 'notification:new', payload);
  }
}

// Notifications relevant to a given logged-in user: their own role, "all",
// their user id, or (for drivers) their driver-id-scoped tag.
async function listForUser(user) {
  const roleTags = [user.role, 'all'];
  if (user.driver) roleTags.push(`driver:${user.driver.id}`);

  return prisma.notification.findMany({
    where: {
      OR: [
        { targetUserId: user.id },
        { targetRole: { in: roleTags } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

async function markRead(id) {
  const notif = await prisma.notification.findUnique({ where: { id } });
  if (!notif) throw ApiError.notFound('Notification not found');
  return prisma.notification.update({ where: { id }, data: { read: true } });
}

module.exports = { push, listForUser, markRead };
