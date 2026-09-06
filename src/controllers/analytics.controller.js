const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const analyticsService = require('../services/analytics.service');
const insightService = require('../services/insight.service');
const { PERIODS, periodRange } = require('../utils/periodRange');

function parsePeriod(req) {
  const { period } = req.query;
  if (period && !PERIODS.includes(period)) {
    throw ApiError.badRequest(`period must be one of: ${PERIODS.join(', ')}`);
  }
  return period || 'all';
}

const overview = asyncHandler(async (req, res) => {
  const period = parsePeriod(req);
  const range = periodRange(period);
  res.json({ ...(await analyticsService.overview(range, period)), period });
});

// Bundles slot intelligence, the task funnel, notification intelligence,
// data quality and computed insights into one response — the admin
// Intelligence screen's single fetch. Kept separate from /overview (which
// valets also use) since everything here is admin-only operational detail
// a valet has no use for.
const intelligence = asyncHandler(async (req, res) => {
  const period = parsePeriod(req);
  const range = periodRange(period);
  const [overviewData, slots, taskFunnel, notifications, dataQuality, anomalies] = await Promise.all([
    analyticsService.overview(range, period),
    analyticsService.slotIntelligence(range),
    analyticsService.taskFunnel(range),
    analyticsService.notificationIntelligence(range),
    analyticsService.dataQuality(),
    analyticsService.anomalies(),
  ]);
  const insights = insightService.buildInsights({ overview: overviewData, slots, taskFunnel, notifications, dataQuality, anomalies });
  res.json({ period, overview: overviewData, slots, taskFunnel, notifications, dataQuality, anomalies, insights });
});

module.exports = { overview, intelligence };
