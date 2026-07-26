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

module.exports = { lookupByCardCode, updateMe };
