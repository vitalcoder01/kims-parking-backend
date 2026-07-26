const prisma = require('../config/database');
const ApiError = require('../utils/ApiError');
const cache = require('../utils/responseCache');

function generateToken() {
  return String(Math.floor(Math.random() * 900) + 100); // 3-digit, matches app
}

// Same reasoning as task.service.js listTasks — polled every ~4s with no
// filters, so bound it to active visitors plus anything from the last 24h
// instead of the entire all-time history.
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VISITOR_LIMIT = 100;
const CACHE_TTL_MS = 2500;
const CACHE_KEY = 'visitors:list';

async function listVisitors() {
  return cache.cached(CACHE_KEY, CACHE_TTL_MS, () => prisma.visitor.findMany({
    where: { OR: [{ status: { not: 'retrieved' } }, { createdAt: { gte: new Date(Date.now() - DEFAULT_WINDOW_MS) } }] },
    orderBy: { createdAt: 'desc' },
    take: DEFAULT_VISITOR_LIMIT,
  }));
}

async function createVisitor({ name, carNumber, mobile }) {
  const visitor = await prisma.visitor.create({
    data: {
      name: name.trim(),
      carNumber: carNumber.trim().toUpperCase(),
      mobile: mobile.trim(),
      token: generateToken(),
      status: 'pending',
    },
  });
  cache.invalidate('visitors:');
  return visitor;
}

async function updateVisitor(id, patch) {
  const visitor = await prisma.visitor.findUnique({ where: { id } });
  if (!visitor) throw ApiError.notFound('Visitor not found');

  const updated = await prisma.visitor.update({ where: { id }, data: patch });
  cache.invalidate('visitors:');
  return updated;
}

module.exports = { listVisitors, createVisitor, updateVisitor };
