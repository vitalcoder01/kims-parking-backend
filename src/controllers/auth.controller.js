const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const authService = require('../services/auth.service');
const { serializeUser } = require('../utils/serialize');

const login = asyncHandler(async (req, res) => {
  const { loginName, password } = req.body;
  if (!loginName || !password) throw ApiError.badRequest('loginName and password are required');

  const { token, user } = await authService.login(loginName, password);
  res.json({ token, user: serializeUser(user) });
});

const me = asyncHandler(async (req, res) => {
  res.json({ user: serializeUser(req.user) });
});

module.exports = { login, me };
