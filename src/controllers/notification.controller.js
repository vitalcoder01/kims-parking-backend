const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const notificationService = require('../services/notification.service');
const { serializeNotification } = require('../utils/serialize');

const push = asyncHandler(async (req, res) => {
  const { targetRole, targetId, title, body, type } = req.body;
  if (!targetRole || !title || !body) {
    throw ApiError.badRequest('targetRole, title and body are required');
  }
  const notif = await notificationService.push({ targetRole, targetUserId: targetId, title, body, type });
  res.status(201).json({ notification: serializeNotification(notif) });
});

const listMine = asyncHandler(async (req, res) => {
  const notifs = await notificationService.listForUser(req.user);
  res.json({ notifications: notifs.map(serializeNotification) });
});

const markRead = asyncHandler(async (req, res) => {
  const notif = await notificationService.markRead(req.params.id);
  res.json({ notification: serializeNotification(notif) });
});

module.exports = { push, listMine, markRead };
