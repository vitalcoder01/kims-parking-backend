const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const analyticsService = require('../services/analytics.service');
const insightService = require('../services/insight.service');
const { PERIODS, periodRange, previousPeriodRange } = require('../utils/periodRange');

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

// Everything the desktop admin command-center dashboard needs, in one
// fetch: the existing overview/intelligence data plus activity trend,
// weekday×hour heatmap, funnel volumes, visitor intelligence, the 7-category
// anomaly radar, period-over-period KPI deltas, real operational-friction
// counts (driver no-response, assignment expiry, recalls, escalations,
// recovery broadcasts, cancellation rate — see analyticsService.
// operationalFriction), and a documented operational-health score computed
// from the above (see analyticsService.operationalHealth). Admin-only.
const commandCenter = asyncHandler(async (req, res) => {
  const period = parsePeriod(req);
  const range = periodRange(period);
  const previousRange = previousPeriodRange(period);

  const [
    overviewData, slots, taskFunnel, taskFunnelVolume, notifications, dataQuality, anomalies,
    activityTrend, demandHeatmap, visitorIntelligence, anomalyRadar, kpiComparison, operationalFriction,
  ] = await Promise.all([
    analyticsService.overview(range, period),
    analyticsService.slotIntelligence(range),
    analyticsService.taskFunnel(range),
    analyticsService.taskFunnelVolume(range),
    analyticsService.notificationIntelligence(range),
    analyticsService.dataQuality(),
    analyticsService.anomalies(),
    analyticsService.activityTrend(range),
    analyticsService.demandHeatmap(range),
    analyticsService.visitorIntelligence(range),
    analyticsService.anomalyRadar(14),
    analyticsService.kpiComparison(range, previousRange),
    analyticsService.operationalFriction(range),
  ]);

  const insights = insightService.buildInsights({ overview: overviewData, slots, taskFunnel, notifications, dataQuality, anomalies });
  const health = analyticsService.operationalHealth(insights, dataQuality);

  res.json({
    period, overview: overviewData, slots, taskFunnel, taskFunnelVolume, notifications, dataQuality,
    anomalies, activityTrend, demandHeatmap, visitorIntelligence, anomalyRadar, kpiComparison,
    operationalFriction, insights, health,
  });
});

module.exports = { overview, intelligence, commandCenter };
