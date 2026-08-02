const asyncHandler = require('../utils/asyncHandler');
const userService = require('../services/user.service');
const { serializeUser } = require('../utils/serialize');

const lookupByCardCode = asyncHandler(async (req, res) => {
  const user = await userService.findByCardCode(req.params.code);
  res.json({ user: serializeUser(user) });
});

// Self-service profile update — car details, phone, display name, and
// login username. Password lives on its own endpoint (changeMyPassword,
// below) because it requires re-authentication; role/employeeId stay
// admin-only via /admin/users.
const updateMe = asyncHandler(async (req, res) => {
  const { carNumber, phone, carModel, carColor, vehicleType, name, username } = req.body;
  const user = await userService.updateOwnProfile(req.user.id, { carNumber, phone, carModel, carColor, vehicleType, name, username });
  res.json({ user: serializeUser(user) });
});

// Self-service password change. Always requires the current password to
// prove the caller isn't just holding a stolen JWT — see changeOwnPassword
// in user.service.js for the security reasoning. 204 on success (no body
// needed: nothing on the client changes visually, and echoing the user row
// back could tempt callers to trust it as fresh auth state when it isn't).
const changeMyPassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  await userService.changeOwnPassword(req.user.id, currentPassword, newPassword);
  res.status(204).end();
});

// The one-time follow-up after self-registration — correcting the default
// 'doctor' designation to 'staff'. See userService.updateOwnDesignation for
// why this is safe to leave as a standalone, repeatable endpoint rather
// than a general role-change (it can only ever produce doctor or staff).
const updateMyDesignation = asyncHandler(async (req, res) => {
  const { role } = req.body;
  const user = await userService.updateOwnDesignation(req.user.id, role);
  res.json({ user: serializeUser(user) });
});

module.exports = { lookupByCardCode, updateMe, changeMyPassword, updateMyDesignation };
