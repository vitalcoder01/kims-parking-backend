const prisma = require('../config/database');

// Anchor calendar day to Indian Standard Time (IST, UTC+05:30) so night-shift
// check-ins (between 00:00 and 05:30 AM IST) are recorded on the correct day.
function todayDateOnly() {
  const now = new Date();
  const istDate = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return new Date(Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate()));
}

async function checkIn(userId, gate) {
  const date = todayDateOnly();
  return prisma.attendance.upsert({
    where: { userId_date: { userId, date } },
    update: { checkIn: new Date(), gate },
    create: { userId, date, checkIn: new Date(), gate },
  });
}

// Used by automatic presence triggers (key handover, driver starting a
// trip) — unlike checkIn(), this never overwrites an existing check-in time.
// A doctor handing over a second car at 2pm shouldn't erase their real 8am
// arrival; this only fills in checkIn if today's record doesn't have one yet.
async function ensurePresent(userId) {
  const date = todayDateOnly();
  const existing = await prisma.attendance.findUnique({ where: { userId_date: { userId, date } } });
  if (existing?.checkIn) return existing;
  return prisma.attendance.upsert({
    where: { userId_date: { userId, date } },
    update: { checkIn: new Date() },
    create: { userId, date, checkIn: new Date() },
  });
}

async function checkOut(userId) {
  const date = todayDateOnly();
  return prisma.attendance.update({
    where: { userId_date: { userId, date } },
    data: { checkOut: new Date() },
  });
}

async function incrementVehiclesHandled(userId) {
  const date = todayDateOnly();
  return prisma.attendance.upsert({
    where: { userId_date: { userId, date } },
    update: { vehiclesHandled: { increment: 1 } },
    create: { userId, date, vehiclesHandled: 1, checkIn: new Date() },
  });
}

async function history(userId, { limit = 30 } = {}) {
  return prisma.attendance.findMany({
    where: { userId },
    orderBy: { date: 'desc' },
    take: limit,
  });
}

async function listToday() {
  const date = todayDateOnly();
  return prisma.attendance.findMany({
    where: { date },
    include: { user: true },
    orderBy: { checkIn: 'asc' },
  });
}

// Every attendance record for a given calendar month ("YYYY-MM"), across
// every user — the admin calendar view groups these client-side per person.
async function monthly(month) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return prisma.attendance.findMany({
    where: { date: { gte: start, lt: end } },
    include: { user: true },
    orderBy: [{ userId: 'asc' }, { date: 'asc' }],
  });
}

module.exports = { checkIn, checkOut, ensurePresent, incrementVehiclesHandled, history, listToday, monthly };
