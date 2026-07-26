const asyncHandler = require('../utils/asyncHandler');
const userService = require('../services/user.service');
const { serializeUser } = require('../utils/serialize');

const lookupByCardCode = asyncHandler(async (req, res) => {
  const user = await userService.findByCardCode(req.params.code);
  res.json({ user: serializeUser(user) });
});

module.exports = { lookupByCardCode };
