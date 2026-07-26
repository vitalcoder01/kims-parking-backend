const asyncHandler = require('../utils/asyncHandler');
const adminService = require('../services/admin.service');
const userService = require('../services/user.service');
const attendanceService = require('../services/attendance.service');
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

const updateUser = asyncHandler(async (req, res) => {
  const { name, role, department, cardCode, phone, carNumber } = req.body;
  if (role !== undefined && !ROLES.includes(role)) {
    throw ApiError.badRequest(`role must be one of: ${ROLES.join(', ')}`);
  }
  // An admin demoting their own only-admin account would lock everyone out
  // of admin tooling with no way back in short of a direct DB edit.
  if (req.params.id === req.user.id && role !== undefined && role !== 'admin') {
    throw ApiError.conflict('You cannot change your own role away from admin');
  }

  const user = await userService.updateUser(req.params.id, { name, role, department, cardCode, phone, carNumber });
  res.json({ user: serializeUser(user) });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) {
    throw ApiError.badRequest('password must be at least 4 characters');
  }
  await userService.resetPassword(req.params.id, password);
  res.json({ ok: true });
});

const deleteUser = asyncHandler(async (req, res) => {
  if (req.params.id === req.user.id) {
    throw ApiError.conflict('You cannot delete your own account while logged in as it');
  }
  await userService.deleteUser(req.params.id);
  res.status(204).send();
});

const attendanceToday = asyncHandler(async (req, res) => {
  const records = await attendanceService.listToday();
  res.json({
    attendance: records.map(r => ({
      id: r.id,
      userId: r.userId,
      name: r.user?.name,
      role: r.user?.role,
      employeeId: r.user?.employeeId,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      vehiclesHandled: r.vehiclesHandled,
      gate: r.gate,
    })),
  });
});

module.exports = { dashboard, listUsers, createUser, updateUser, resetPassword, deleteUser, attendanceToday };
