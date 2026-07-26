const prisma = require('../config/database');

function todayDateOnly() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function checkIn(userId, gate) {
  const date = todayDateOnly();
  return prisma.attendance.upsert({
    where: { userId_date: { userId, date } },
    update: { checkIn: new Date(), gate },
    create: { userId, date, checkIn: new Date(), gate },
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

module.exports = { checkIn, checkOut, incrementVehiclesHandled, history };
