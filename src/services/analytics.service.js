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

// Bucket labels + the function that maps a completed task's completedAt to
// a bucket index, one pair per period granularity. Chosen so the trend
// chart's resolution matches what's actually meaningful to look at: hourly
// within a single day, but daily within a week/month (an hourly chart for
// a whole month would be 720+ silent bars), monthly within a year.
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function trendBuckets(period, range) {
  if (period === 'daily') {
    return { labels: Array.from({ length: 24 }, (_, h) => String(h)), bucketOf: (d) => d.getHours() };
  }
  if (period === 'weekly') {
    return { labels: WEEKDAY_LABELS, bucketOf: (d) => (d.getDay() + 6) % 7 }; // Mon=0..Sun=6
  }
  if (period === 'monthly') {
    const daysInMonth = new Date(range.from.getFullYear(), range.from.getMonth() + 1, 0).getDate();
    return { labels: Array.from({ length: daysInMonth }, (_, i) => String(i + 1)), bucketOf: (d) => d.getDate() - 1 };
  }
  if (period === 'yearly') {
    return { labels: MONTH_LABELS, bucketOf: (d) => d.getMonth() };
  }
  return null; // 'all' (or no period): no trend breakdown, just the existing all-time hour-of-day histogram
}

// `range` is optional — { from: Date, to: Date }, both inclusive-exclusive
// on completedAt (a job counts toward a period by when it FINISHED, not
// when it started, matching how "today" already reads on the live
// dashboard). `period` (the same string the range was derived from) picks
// the trend chart's bucket granularity — see trendBuckets above. Both
// omitted means the original all-time behavior, unchanged.
async function overview(range, period) {
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
        id: true, type: true, driverId: true, visitorId: true, slotId: true,
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

  // Block utilization — which block actually got used during this window.
  // Counted from completed PARK jobs only (a retrieve's slotId is where the
  // car came FROM, i.e. the same park event already counted) — slot ids are
  // "<block>-<number>" (see prisma/seed.js), so the block is just the part
  // before the dash. Vehicles whose slotId somehow never got set (shouldn't
  // happen for a completed park, but nothing enforces it at the DB level)
  // are simply not counted rather than guessed at.
  const blockCounts = new Map();
  for (const t of parkTasks) {
    if (!t.slotId) continue;
    const block = t.slotId.split('-')[0];
    blockCounts.set(block, (blockCounts.get(block) ?? 0) + 1);
  }
  const blockUtilization = [...blockCounts.entries()]
    .map(([block, count]) => ({ block, count }))
    .sort((a, b) => b.count - a.count || a.block.localeCompare(b.block));

  // Park-vs-retrieve trend within the period, bucketed at whatever
  // resolution actually makes sense for that period's span (see
  // trendBuckets) — null for 'all', where the existing hour-of-day
  // histogram above already covers the "when" question a calendar trend
  // can't usefully answer over a multi-year span.
  const buckets = trendBuckets(period, range);
  let trend = null;
  if (buckets) {
    const park = new Array(buckets.labels.length).fill(0);
    const retrieve = new Array(buckets.labels.length).fill(0);
    for (const t of completedTasks) {
      if (!t.completedAt) continue;
      const idx = buckets.bucketOf(new Date(t.completedAt));
      if (idx < 0 || idx >= buckets.labels.length) continue; // defensive — a bad bucketOf should drop the point, not throw
      (t.type === 'park' ? park : retrieve)[idx]++;
    }
    trend = { labels: buckets.labels, park, retrieve };
  }

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
    blockUtilization,
    trend,
    visitorJobs: completedTasks.filter(t => t.visitorId != null).length,
    staffJobs: completedTasks.filter(t => t.visitorId == null).length,
    drivers,
    generatedAt: new Date().toISOString(),
  };
}

function completedAtFilter(range) {
  if (!range?.from && !range?.to) return {};
  return {
    completedAt: {
      ...(range.from && { gte: range.from }),
      ...(range.to && { lt: range.to }),
    },
  };
}

// ── Slot intelligence ────────────────────────────────────────────────────
// Per-slot usage within the period, classified relative to the mean usage
// across all slots. "Usage" is a completed PARK job landing on that slot —
// the same definition blockUtilization above already uses, just broken out
// per slot instead of per block.
//
// This is DERIVED, not measured: true occupied-duration/idle-time/turnover
// would need a slot-state history table, which the schema does not have
// (ParkingSlot stores only CURRENT status, never a log of past states).
// Usage count and last-used are real; a duration figure would be inference
// dressed up as fact, so this deliberately does not compute one — see the
// `note` field, which the UI should surface rather than hide.
async function slotIntelligence(range) {
  const [parkTasks, slots] = await Promise.all([
    prisma.parkingTask.findMany({
      where: { status: 'completed', type: 'park', ...completedAtFilter(range) },
      select: { slotId: true, completedAt: true },
    }),
    prisma.parkingSlot.findMany({ select: { id: true, block: true, number: true, status: true } }),
  ]);

  const usageBySlot = new Map();
  const lastUseBySlot = new Map();
  for (const t of parkTasks) {
    if (!t.slotId) continue;
    usageBySlot.set(t.slotId, (usageBySlot.get(t.slotId) ?? 0) + 1);
    const prev = lastUseBySlot.get(t.slotId);
    if (t.completedAt && (!prev || t.completedAt > prev)) lastUseBySlot.set(t.slotId, t.completedAt);
  }

  const counts = slots.map(s => usageBySlot.get(s.id) ?? 0);
  const mean = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;

  // Thresholds are relative to the fleet's own mean, not an arbitrary
  // fixed number — "high" on a 5-slot lot and a 500-slot lot mean
  // different absolute counts, but the same relative story.
  function classify(usage) {
    if (mean === 0) return usage > 0 ? 'NORMAL' : 'NO_DATA';
    if (usage === 0) return 'UNDERUTILIZED';
    if (usage >= mean * 1.75) return 'OVERLOADED';
    if (usage >= mean * 1.25) return 'HIGH';
    if (usage <= mean * 0.5) return 'UNDERUTILIZED';
    return 'NORMAL';
  }

  const perSlot = slots
    .map(s => {
      const usage = usageBySlot.get(s.id) ?? 0;
      return {
        id: s.id,
        block: s.block,
        number: s.number,
        currentStatus: s.status,
        usageCount: usage,
        lastUsedAt: lastUseBySlot.get(s.id)?.toISOString() ?? null,
        classification: classify(usage),
      };
    })
    .sort((a, b) => b.usageCount - a.usageCount);

  return {
    meanUsage: Math.round(mean * 10) / 10,
    totalSlots: slots.length,
    slots: perSlot,
    underutilizedCount: perSlot.filter(s => s.classification === 'UNDERUTILIZED').length,
    overloadedCount: perSlot.filter(s => s.classification === 'OVERLOADED').length,
    note: 'Usage count and last-used are measured from completed park jobs in this period. Occupied-duration, idle-time and turnover cannot be computed — the database records only a slot\'s CURRENT status, not a history of past state changes.',
  };
}

// ── Task funnel ──────────────────────────────────────────────────────────
// Stage-to-stage average minutes across the completed task lifecycle,
// computed separately for park vs retrieve since they don't share a
// lifecycle shape (a park job has no acceptedAt/startedAt/deliveredAt
// stage; a retrieve does). A stage whose sample is too small to trust
// (<5 rows with both timestamps set) is still reported but excluded from
// bottleneck detection, so two data points can't crown a "bottleneck".
async function taskFunnel(range) {
  const tasks = await prisma.parkingTask.findMany({
    where: { status: 'completed', ...completedAtFilter(range) },
    select: {
      type: true, requestedAt: true, assignedAt: true, acceptedAt: true,
      keyCollectedAt: true, startedAt: true, deliveredAt: true, completedAt: true,
    },
  });

  const park = tasks.filter(t => t.type === 'park');
  const retrieve = tasks.filter(t => t.type === 'retrieve');

  const PARK_STAGES = [
    { key: 'assigned_to_key', label: 'Assigned → key collected', from: 'assignedAt', to: 'keyCollectedAt' },
    { key: 'key_to_parked', label: 'Key collected → parked', from: 'keyCollectedAt', to: 'completedAt' },
  ];
  const RETRIEVE_STAGES = [
    { key: 'requested_to_assigned', label: 'Requested → assigned', from: 'requestedAt', to: 'assignedAt' },
    { key: 'assigned_to_accepted', label: 'Assigned → accepted', from: 'assignedAt', to: 'acceptedAt' },
    { key: 'accepted_to_started', label: 'Accepted → driver started', from: 'acceptedAt', to: 'startedAt' },
    { key: 'started_to_delivered', label: 'Started → delivered to owner', from: 'startedAt', to: 'deliveredAt' },
    // The one gap this schema previously couldn't see — see ParkingTask.deliveredAt.
    { key: 'delivered_to_confirmed', label: 'Delivered → confirmed (owner pickup lag)', from: 'deliveredAt', to: 'completedAt' },
  ];

  function buildStages(rows, stages) {
    return stages.map(s => {
      const sampleSize = rows.filter(r => r[s.from] && r[s.to]).length;
      return { key: s.key, label: s.label, avgMinutes: avgMinutes(rows, s.from, s.to), sampleSize };
    });
  }

  function bottleneckOf(stages) {
    const usable = stages.filter(s => s.avgMinutes != null && s.sampleSize >= 5);
    if (!usable.length) return null;
    return usable.reduce((worst, s) => (s.avgMinutes > worst.avgMinutes ? s : worst));
  }

  const parkStages = buildStages(park, PARK_STAGES);
  const retrieveStages = buildStages(retrieve, RETRIEVE_STAGES);

  return {
    park: { stages: parkStages, sampleSize: park.length, bottleneck: bottleneckOf(parkStages) },
    retrieve: { stages: retrieveStages, sampleSize: retrieve.length, bottleneck: bottleneckOf(retrieveStages) },
  };
}

// ── Notification intelligence ────────────────────────────────────────────
async function notificationIntelligence(range) {
  const where = {};
  if (range?.from || range?.to) {
    where.createdAt = {
      ...(range.from && { gte: range.from }),
      ...(range.to && { lt: range.to }),
    };
  }
  const notifications = await prisma.notification.findMany({
    where, select: { type: true, targetRole: true, createdAt: true },
  });

  const byType = {};
  const byRole = {};
  const byDay = new Map();
  for (const n of notifications) {
    byType[n.type] = (byType[n.type] ?? 0) + 1;
    byRole[n.targetRole] = (byRole[n.targetRole] ?? 0) + 1;
    const day = n.createdAt.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const dailyCounts = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));

  const counts = dailyCounts.map(d => d.count);
  const mean = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  // A "spike" needs both a real multiple of the mean AND an absolute floor,
  // so a quiet stretch with 1-2 notifications/day doesn't register noise
  // as a spike the moment one day hits 3.
  const spikes = mean > 0 ? dailyCounts.filter(d => d.count >= Math.max(10, mean * 2)) : [];

  return { total: notifications.length, byType, byRole, dailyCounts, meanPerDay: Math.round(mean * 10) / 10, spikes };
}

// ── Data quality ──────────────────────────────────────────────────────────
// Grounded in what the database can actually tell us is wrong, not a
// generic checklist. Client-side crashes reuse the same client_errors table
// the admin diagnostics endpoint already reads (see clientError.service) —
// this is that table's data restated for the intelligence bundle, not a
// second collection mechanism.
async function dataQuality() {
  const clientErrorService = require('./clientError.service');
  const [openErrors, impossibleTimestampRows, taskSlotIds, realSlots] = await Promise.all([
    clientErrorService.list({ includeResolved: false, limit: 10 }),
    // completedAt earlier than createdAt is not physically possible for a
    // row that starts its life via createdAt=now() — points at a clock
    // issue or a bad backfill. Column-to-column comparison isn't expressible
    // through Prisma's `where`, hence the raw query.
    prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM parking_tasks WHERE "completedAt" IS NOT NULL AND "completedAt" < "createdAt"`,
    prisma.parkingTask.findMany({ where: { slotId: { not: null } }, distinct: ['slotId'], select: { slotId: true } }),
    prisma.parkingSlot.findMany({ select: { id: true } }),
  ]);

  const realSlotIds = new Set(realSlots.map(s => s.id));
  // A task pointing at a slot id that no longer exists in parking_slots —
  // slotId has no DB-level foreign key (see schema.prisma), so this can
  // only be caught here, not by a constraint.
  const orphanSlotIds = taskSlotIds.map(t => t.slotId).filter(id => !realSlotIds.has(id));

  return {
    openClientErrors: openErrors.length,
    topClientErrors: openErrors.slice(0, 5).map(e => ({
      id: e.id, name: e.name, message: e.message, screen: e.screen,
      count: e.count, roles: e.roles, lastSeenAt: e.lastSeenAt,
    })),
    impossibleTimestampCount: impossibleTimestampRows[0]?.count ?? 0,
    orphanSlotReferenceCount: orphanSlotIds.length,
    orphanSlotIds: orphanSlotIds.slice(0, 10),
  };
}

// ── Anomaly detection ─────────────────────────────────────────────────────
// Daily completed-job volume over a trailing window, flagged against that
// same window's own mean/stddev — never a fixed magic-number threshold,
// since "busy" means a different absolute count for every operation this
// runs on. Needs at least 5 days of history before it will call anything
// an anomaly; fewer than that isn't a baseline, it's a coincidence.
async function anomalies(lookbackDays = 14) {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const tasks = await prisma.parkingTask.findMany({
    where: { status: 'completed', completedAt: { gte: since } },
    select: { completedAt: true },
  });

  const byDay = new Map();
  for (const t of tasks) {
    const day = t.completedAt.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));

  if (days.length < 5) {
    return { lookbackDays, days, mean: null, stddev: null, anomalies: [], note: 'Not enough days of history yet to establish a baseline.' };
  }

  const counts = days.map(d => d.count);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
  const stddev = Math.sqrt(variance);

  const found = stddev > 0
    ? days.filter(d => Math.abs(d.count - mean) > 2 * stddev)
    : [];

  return {
    lookbackDays,
    days,
    mean: Math.round(mean * 10) / 10,
    stddev: Math.round(stddev * 10) / 10,
    anomalies: found.map(d => ({
      date: d.date, count: d.count,
      direction: d.count > mean ? 'high' : 'low',
      deviationStdDevs: Math.round(((d.count - mean) / (stddev || 1)) * 10) / 10,
    })),
  };
}

module.exports = { overview, slotIntelligence, taskFunnel, notificationIntelligence, dataQuality, anomalies };
