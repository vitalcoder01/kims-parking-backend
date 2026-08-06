const asyncHandler = require('../utils/asyncHandler');
const analyticsService = require('../services/analytics.service');

const overview = asyncHandler(async (req, res) => {
  res.json(await analyticsService.overview());
});

module.exports = { overview };
