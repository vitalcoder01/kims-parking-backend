const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const cache = require('../utils/responseCache');

const CACHE_TTL_MS = 2500;

async function listDrivers({ status } = {}) {
  const key = `drivers:${status ?? ''}`;
  return cache.cached(key, CACHE_TTL_MS, () => prisma.driver.findMany({
    // A Driver row can outlive its user's 'driver' role (see user.service.js
    // updateUser — it can't be hard-deleted once it has task history), so
    // this filters on the linked user's *current* role too, not just the
    // row's own existence, or a transferred-away account could still be
    // assigned new tasks.
    where: { ...(status && { status }), user: { role: 'driver' } },
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
