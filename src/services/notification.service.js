const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');

// targetRole supports role-wide broadcast ('valet', 'driver', 'doctor', 'all')
// or a precise 'driver:<driverId>' style tag, matching the mobile app.
// targetUserId (optional) additionally scopes to one exact user.
async function push({ targetRole, targetUserId, title, body, type }) {
  return prisma.notification.create({
    data: { targetRole, targetUserId: targetUserId ?? null, title, body, type: type || 'info' },
  });
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
