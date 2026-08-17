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
  const targetId = parseId(req.params.id);

  // The route allows driver, valet and admin — but "driver" was only ever
  // meant to mean a driver going on or off duty THEMSELVES. Without this,
  // the id in the URL was taken at face value, so any driver could put any
  // other driver off duty. Valets and admins keep the wider power: managing
  // the roster is their job.
  if (req.user.role === 'driver' && req.user.driver?.id !== targetId) {
    throw ApiError.forbidden('You can only change your own duty status');
  }

  const driver = await driverService.setStatus(targetId, status);
  res.json({ driver: serializeDriver(driver) });
});

module.exports = { list, setStatus };
