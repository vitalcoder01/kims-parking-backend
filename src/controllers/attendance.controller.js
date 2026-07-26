const asyncHandler = require('../utils/asyncHandler');
const attendanceService = require('../services/attendance.service');

const checkIn = asyncHandler(async (req, res) => {
  const record = await attendanceService.checkIn(req.user.id, req.body.gate);
  res.json({ attendance: record });
});

const checkOut = asyncHandler(async (req, res) => {
  const record = await attendanceService.checkOut(req.user.id);
  res.json({ attendance: record });
});

const myHistory = asyncHandler(async (req, res) => {
  const records = await attendanceService.history(req.user.id, { limit: Number(req.query.limit) || 30 });
  res.json({ attendance: records });
});

module.exports = { checkIn, checkOut, myHistory };
