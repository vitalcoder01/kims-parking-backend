const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const cache = require('../utils/responseCache');

const CACHE_TTL_MS = 2500;

async function listDrivers({ status } = {}) {
  const key = `drivers:${status ?? ''}`;
  return cache.cached(key, CACHE_TTL_MS, () => prisma.driver.findMany({
    where: { ...(status && { status }) },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  }));
}

async function setStatus(driverId, status) {
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw ApiError.notFound('Driver not found');

  const updated = await prisma.driver.update({
    where: { id: driverId },
    data: { status },
    include: { user: true },
  });
  cache.invalidate('drivers:');
  return updated;
}

module.exports = { listDrivers, setStatus };
