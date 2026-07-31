const asyncHandler = require('../utils/asyncHandler');
const adminService = require('../services/admin.service');
const settingService = require('../services/setting.service');
const userService = require('../services/user.service');
const attendanceService = require('../services/attendance.service');
const ApiError = require('../utils/ApiError');
const { serializeUser } = require('../utils/serialize');
const parseId = require('../utils/parseId');

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
  const id = parseId(req.params.id);
  // An admin demoting their own only-admin account would lock everyone out
  // of admin tooling with no way back in short of a direct DB edit.
  if (id === req.user.id && role !== undefined && role !== 'admin') {
    throw ApiError.conflict('You cannot change your own role away from admin');
  }

  const user = await userService.updateUser(id, { name, role, department, cardCode, phone, carNumber });
  res.json({ user: serializeUser(user) });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) {
    throw ApiError.badRequest('password must be at least 4 characters');
  }
  await userService.resetPassword(parseId(req.params.id), password);
  res.json({ ok: true });
});

const deleteUser = asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  if (id === req.user.id) {
    throw ApiError.conflict('You cannot delete your own account while logged in as it');
  }
  await userService.deleteUser(id);
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

// Calendar view: every attendance day for every user in a given month,
// grouped per user so the admin UI can render one calendar strip per person.
const MONTH_RE = /^\d{4}-\d{2}$/;
const attendanceMonthly = asyncHandler(async (req, res) => {
  const month = typeof req.query.month === 'string' && MONTH_RE.test(req.query.month)
    ? req.query.month
    : new Date().toISOString().slice(0, 7);

  const records = await attendanceService.monthly(month);
  const byUser = new Map();
  for (const r of records) {
    if (!byUser.has(r.userId)) {
      byUser.set(r.userId, {
        userId: r.userId,
        name: r.user?.name,
        role: r.user?.role,
        employeeId: r.user?.employeeId,
        days: [],
      });
    }
    byUser.get(r.userId).days.push({
      date: r.date.toISOString().slice(0, 10),
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      vehiclesHandled: r.vehiclesHandled,
    });
  }

  res.json({ month, users: [...byUser.values()] });
});

// Operational settings (e.g. driverAcceptTimeoutSeconds — the window a
// driver has to accept an assignment before the valet is asked to reassign).
const getSettings = asyncHandler(async (req, res) => {
  res.json({ settings: await settingService.getAll() });
});

const updateSettings = asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body !== 'object') throw ApiError.badRequest('settings object required');
  for (const key of ['driverAcceptTimeoutSeconds', 'ownerResponseTimeoutSeconds', 'ownerResponseWindowSeconds']) {
    if (req.body[key] === undefined) continue;
    const n = Number(req.body[key]);
    if (!Number.isFinite(n) || n < 10 || n > 600) {
      throw ApiError.badRequest(`${key} must be between 10 and 600`);
    }
  }
  // Lead time has its own range: 0 is valid ("start as soon as they ask"),
  // and hours ahead is reasonable for a planned departure.
  if (req.body.retrievalLeadTimeMinutes !== undefined) {
    const n = Number(req.body.retrievalLeadTimeMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 240) {
      throw ApiError.badRequest('retrievalLeadTimeMinutes must be between 0 and 240');
    }
  }
  res.json({ settings: await settingService.update(req.body) });
});

module.exports = { dashboard, listUsers, createUser, updateUser, resetPassword, deleteUser, attendanceToday, attendanceMonthly, getSettings, updateSettings };
