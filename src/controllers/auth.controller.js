const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const authService = require('../services/auth.service');
const { serializeUser } = require('../utils/serialize');

const login = asyncHandler(async (req, res) => {
  const { employeeId, password } = req.body;
  if (!employeeId || !password) throw ApiError.badRequest('employeeId and password are required');

  const { token, user } = await authService.login(employeeId, password);
  res.json({ token, user: serializeUser(user) });
});

const me = asyncHandler(async (req, res) => {
  res.json({ user: serializeUser(req.user) });
});

module.exports = { login, me };
