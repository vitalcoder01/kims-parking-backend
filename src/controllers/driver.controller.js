const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const driverService = require('../services/driver.service');
const { serializeDriver } = require('../utils/serialize');
const parseId = require('../utils/parseId');

const list = asyncHandler(async (req, res) => {
  const drivers = await driverService.listDrivers({ status: req.query.status });
  res.json({ drivers: drivers.map(serializeDriver) });
});

const setStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['available', 'busy', 'off'].includes(status)) {
    throw ApiError.badRequest('status must be one of: available, busy, off');
  }
  const driver = await driverService.setStatus(parseId(req.params.id), status);
  res.json({ driver: serializeDriver(driver) });
});

module.exports = { list, setStatus };
