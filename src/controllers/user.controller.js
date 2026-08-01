const asyncHandler = require('../utils/asyncHandler');
const userService = require('../services/user.service');
const { serializeUser } = require('../utils/serialize');

const lookupByCardCode = asyncHandler(async (req, res) => {
  const user = await userService.findByCardCode(req.params.code);
  res.json({ user: serializeUser(user) });
});

// Self-service profile update — deliberately narrow (car number, phone
// only). Role/password/employeeId changes stay admin-only via /admin/users.
const updateMe = asyncHandler(async (req, res) => {
  const { carNumber, phone } = req.body;
  const user = await userService.updateOwnProfile(req.user.id, { carNumber, phone });
  res.json({ user: serializeUser(user) });
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

module.exports = { lookupByCardCode, updateMe, updateMyDesignation };
