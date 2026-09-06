// Shared period-range helper for every analytics endpoint that accepts
// ?period=daily|weekly|monthly|yearly|all — one definition of "This Week"
// so it means the same Monday-start week everywhere instead of drifting
// between endpoints written at different times. Computed in the server's
// own local time, same convention Attendance already uses for "today"
// (see admin.service.js).
const PERIODS = ['daily', 'weekly', 'monthly', 'yearly', 'all'];

function periodRange(period) {
  if (!period || period === 'all') return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'daily') {
    return { from: startOfToday, to: new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000) };
  }
  if (period === 'weekly') {
    // Week starts Monday — matches the hospital's operational shift pattern.
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

// The immediately-preceding window of the same length — "last month" for
// period=monthly, the 7 days before this week for period=weekly, etc. Used
// for "vs last period" KPI deltas. No previous window for 'all'/no period —
// there's nothing before "all time".
function previousPeriodRange(period) {
  const current = periodRange(period);
  if (!current) return null;
  const spanMs = current.to.getTime() - current.from.getTime();
  return { from: new Date(current.from.getTime() - spanMs), to: current.from };
}

module.exports = { PERIODS, periodRange, previousPeriodRange };
