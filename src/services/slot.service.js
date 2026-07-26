const prisma = require('../config/database');
const cache = require('../utils/responseCache');

const CACHE_TTL_MS = 2500;

async function listSlots({ status, block } = {}) {
  const key = `slots:${status ?? ''}:${block ?? ''}`;
  return cache.cached(key, CACHE_TTL_MS, () => prisma.parkingSlot.findMany({
    where: {
      ...(status && { status }),
      ...(block && { block }),
    },
    orderBy: [{ block: 'asc' }, { number: 'asc' }],
  }));
}

async function occupancySummary() {
  const slots = await prisma.parkingSlot.findMany();
  const total = slots.length;
  const occupied = slots.filter(s => s.status === 'occupied').length;
  const byBlock = {};
  for (const s of slots) {
    byBlock[s.block] ??= { total: 0, occupied: 0 };
    byBlock[s.block].total += 1;
    if (s.status === 'occupied') byBlock[s.block].occupied += 1;
  }
  return {
    total,
    occupied,
    available: total - occupied,
    occupancyPct: total ? Math.round((occupied / total) * 100) : 0,
    byBlock,
  };
}

module.exports = { listSlots, occupancySummary };
