const prisma = require('../config/database');
const { occupancySummary } = require('./slot.service');

async function dashboard() {
  const [occupancy, activeTasks, driverCounts, staffOnDuty, recentActivity, retrievalPending] = await Promise.all([
    occupancySummary(),
    prisma.parkingTask.count({ where: { status: { not: 'completed' } } }),
    // groupBy pushes the available/busy/off tally to the DB instead of
    // pulling every driver row (with its joined user) just to count in JS.
    prisma.driver.groupBy({ by: ['status'], _count: true }),
    prisma.user.count({ where: { role: { in: ['valet', 'staff'] } } }),
    prisma.parkingTask.findMany({
      where: { status: 'completed' },
      include: { doctor: true, visitor: true, driver: { include: { user: true } } },
      orderBy: { completedAt: 'desc' },
      take: 10,
    }),
    prisma.parkingTask.count({ where: { type: 'retrieve', status: { not: 'completed' } } }),
  ]);

  const countFor = (status) => driverCounts.find(d => d.status === status)?._count ?? 0;

  return {
    occupancy,
    activeTasks,
    retrievalPending,
    staffOnDuty,
    drivers: {
      total: driverCounts.reduce((sum, d) => sum + d._count, 0),
      available: countFor('available'),
      busy: countFor('busy'),
      off: countFor('off'),
    },
    recentActivity: recentActivity.map(t => ({
      id: t.id,
      type: t.type,
      carNumber: t.carNumber,
      slotId: t.slotId,
      doctorName: t.doctor?.name ?? t.visitor?.name,
      driverName: t.driver?.user?.name,
      completedAt: t.completedAt,
    })),
  };
}

module.exports = { dashboard };
