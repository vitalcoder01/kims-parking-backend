const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const analyticsService = require('../services/analytics.service');

// Period boundaries computed in the server's own local time — same
// convention Attendance already uses for "today" (see admin.service.js),
// so "This Week"/"This Month" here lines up with what the rest of the app
// already means by those words instead of introducing a second, UTC-based
// notion of a day.
const PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'all'];

function periodRange(period) {
  if (!period || period === 'all') return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'daily') {
    return { from: startOfToday, to: new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000) };
  }
  if (period === 'weekly') {
    // Week starts Monday — matches the attendance calendar's own week
    // rendering (WEEKDAYS starts 'S' for the grid header, but the
    // operational week here follows the hospital's Mon-Sun shift pattern).
    const day = startOfToday.getDay(); // 0=Sun..6=Sat
    const diffToMonday = day === 0 ? 6 : day - 1;
    const from = new Date(startOfToday.getTime() - diffToMonday * 24 * 60 * 60 * 1000);
    return { from, to: new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000) };
  }
  if (period === 'monthly') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { from, to };
  }
  // yearly
  return { from: new Date(now.getFullYear(), 0, 1), to: new Date(now.getFullYear() + 1, 0, 1) };
}

const overview = asyncHandler(async (req, res) => {
  const { period } = req.query;
  if (period && !PERIODS.includes(period)) {
    throw ApiError.badRequest(`period must be one of: ${PERIODS.join(', ')}`);
  }
  const range = periodRange(period);
  res.json({ ...(await analyticsService.overview(range)), period: period || 'all' });
});

module.exports = { overview };
