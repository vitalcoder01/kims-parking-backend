const asyncHandler = require('../utils/asyncHandler');
const adminService = require('../services/admin.service');
const userService = require('../services/user.service');
const ApiError = require('../utils/ApiError');
const { serializeUser } = require('../utils/serialize');

const ROLES = ['doctor', 'staff', 'valet', 'driver', 'admin'];

const dashboard = asyncHandler(async (req, res) => {
  res.json(await adminService.dashboard());
});

const listUsers = asyncHandler(async (req, res) => {
  const users = await userService.listUsers();
  res.json({ users: users.map(serializeUser) });
});

const createUser = asyncHandler(async (req, res) => {
  const { employeeId, name, role, password, department, cardCode, phone, carNumber } = req.body;
  if (!employeeId || !name || !role || !password) {
    throw ApiError.badRequest('employeeId, name, role and password are required');
  }
  if (!ROLES.includes(role)) {
    throw ApiError.badRequest(`role must be one of: ${ROLES.join(', ')}`);
  }
  if (password.length < 4) {
    throw ApiError.badRequest('password must be at least 4 characters');
  }

  const user = await userService.createUser({ employeeId, name, role, password, department, cardCode, phone, carNumber });
  res.status(201).json({ user: serializeUser(user) });
});

module.exports = { dashboard, listUsers, createUser };
