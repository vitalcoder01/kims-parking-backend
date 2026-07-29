const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const notificationService = require('../services/notification.service');
const pushService = require('../services/push.service');
const { serializeNotification } = require('../utils/serialize');
const parseId = require('../utils/parseId');

const push = asyncHandler(async (req, res) => {
  const { targetRole, targetId, title, body, type } = req.body;
  if (!targetRole || !title || !body) {
    throw ApiError.badRequest('targetRole, title and body are required');
  }
  const notif = await notificationService.push({ targetRole, targetUserId: parseId(targetId), title, body, type });
  res.status(201).json({ notification: serializeNotification(notif) });
});

const listMine = asyncHandler(async (req, res) => {
  const notifs = await notificationService.listForUser(req.user);
  res.json({ notifications: notifs.map(serializeNotification) });
});

const markRead = asyncHandler(async (req, res) => {
  const notif = await notificationService.markRead(parseId(req.params.id));
  res.json({ notification: serializeNotification(notif) });
});

// FCM device token registration — how pushes reach this user's phone even
// when the app is killed or after a reboot.
const registerDevice = asyncHandler(async (req, res) => {
  const { token, platform } = req.body;
  if (!token) throw ApiError.badRequest('token is required');
  await pushService.registerDevice(req.user.id, token, platform);
  res.status(204).end();
});

module.exports = { push, listMine, markRead, registerDevice };
