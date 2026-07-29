const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const authService = require('../services/auth.service');
const { serializeUser } = require('../utils/serialize');

const login = asyncHandler(async (req, res) => {
  const { username, loginName, password } = req.body;
  const loginValue = username || loginName;
  if (!loginValue || !password) throw ApiError.badRequest('username and password are required');

  const { token, user } = await authService.login(loginValue, password);
  res.json({ token, user: serializeUser(user) });
});

const me = asyncHandler(async (req, res) => {
  res.json({ user: serializeUser(req.user) });
});

module.exports = { login, me };
