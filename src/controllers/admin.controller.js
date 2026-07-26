const asyncHandler = require('../utils/asyncHandler');
const adminService = require('../services/admin.service');

const dashboard = asyncHandler(async (req, res) => {
  res.json(await adminService.dashboard());
});

module.exports = { dashboard };
