const prisma = require('../config/database');

// Operational analytics — cars parked/retrieved, per-driver breakdown, and
// timing stats. Computed from completed ParkingTask rows; pulled once and
// reduced in JS rather than SQL AVG(), since the duration we care about is
// the difference between two columns (not a single column's average),
// which isn't portably expressible as a single aggregate across every DB
// Prisma targets.
//
// Date-range filtering is optional (all-time when omitted, same as
// before) — added because the admin dashboard's period selector
// (Daily/Weekly/Monthly/Yearly) needs a real, database-backed scoped
// answer, not something guessed client-side from a capped recent-task
// fetch. If the completed-task volume grows large enough that pulling
// every row in range becomes slow, this is the first place to push the
// reduction into SQL (e.g. a raw query with AVG(EXTRACT(EPOCH FROM
// "completedAt" - "keyCollectedAt"))).

/** Average minutes between two timestamp columns, over rows where both are
 *  set. Returns null (not 0) when there's no data yet — "no data" and
 *  "instant" are different things and the UI needs to tell them apart. */
function avgMinutes(rows, fromKey, toKey) {
  const diffs = rows
    .filter(r => r[fromKey] && r[toKey])
    .map(r => (new Date(r[toKey]).getTime() - new Date(r[fromKey]).getTime()) / 60000)
    .filter(m => m >= 0); // a clock skew/bad row producing a negative duration shouldn't drag the average down
  if (!diffs.length) return null;
  return Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10;
}

// `range` is optional — { from: Date, to: Date }, both inclusive-exclusive
// on completedAt (a job counts toward a period by when it FINISHED, not
// when it started, matching how "today" already reads on the live
// dashboard). Omitted entirely means the original all-time behavior.
async function overview(range) {
  const completedWhere = { status: 'completed' };
  if (range?.from || range?.to) {
    completedWhere.completedAt = {
      ...(range.from && { gte: range.from }),
      ...(range.to && { lt: range.to }),
    };
  }

  const [completedTasks, driverRows] = await Promise.all([
    prisma.parkingTask.findMany({
      where: completedWhere,
      select: {
        id: true, type: true, driverId: true, visitorId: true,
        assignedAt: true, keyCollectedAt: true, completedAt: true,
      },
    }),
    prisma.driver.findMany({ include: { user: true } }),
  ]);

  const parkTasks = completedTasks.filter(t => t.type === 'park');
  const retrieveTasks = completedTasks.filter(t => t.type === 'retrieve');

  // Busiest hour of day across every completed job — an at-a-glance
  // operational signal for when to schedule more drivers on shift.
  const hourCounts = new Array(24).fill(0);
  for (const t of completedTasks) {
    if (!t.completedAt) continue;
    hourCounts[new Date(t.completedAt).getHours()]++;
  }
  const busiestHour = hourCounts.every(c => c === 0) ? null : hourCounts.indexOf(Math.max(...hourCounts));

  const drivers = driverRows
    .map(d => {
      const mine = completedTasks.filter(t => t.driverId === d.id);
      const mineParks = mine.filter(t => t.type === 'park');
      const mineRetrieves = mine.filter(t => t.type === 'retrieve');
      return {
        id: d.id,
        name: d.user.name,
        parksCompleted: mineParks.length,
        retrievesCompleted: mineRetrieves.length,
        totalCompleted: mine.length,
        // Park duration is measured from key-in-hand (keyCollectedAt), not
        // assignment — the driver isn't moving yet while waiting to accept.
        avgParkMinutes: avgMinutes(mineParks, 'keyCollectedAt', 'completedAt'),
        // Retrieval has no equivalent "key in hand" milestone that isn't
        // itself the finish line for a park leg, so this measures from
        // assignment — the full round trip the driver actually owns.
        avgRetrieveMinutes: avgMinutes(mineRetrieves, 'assignedAt', 'completedAt'),
      };
    })
    // Busiest first — this list doubles as the leaderboard.
    .sort((a, b) => b.totalCompleted - a.totalCompleted);

  return {
    totalCarsParked: parkTasks.length,
    totalCarsRetrieved: retrieveTasks.length,
    totalJobsCompleted: completedTasks.length,
    avgParkMinutes: avgMinutes(parkTasks, 'keyCollectedAt', 'completedAt'),
    avgRetrieveMinutes: avgMinutes(retrieveTasks, 'assignedAt', 'completedAt'),
    busiestHour,
    // Full 24-slot histogram, not just the peak — lets the UI draw a real
    // hour-by-hour chart instead of a single "6 AM" data point.
    hourlyDistribution: hourCounts,
    visitorJobs: completedTasks.filter(t => t.visitorId != null).length,
    staffJobs: completedTasks.filter(t => t.visitorId == null).length,
    drivers,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { overview };
