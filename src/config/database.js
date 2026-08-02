require('./env'); // ensure the right .env.* file is loaded before Prisma reads DATABASE_URL

const { PrismaClient } = require('@prisma/client');

// Singleton — avoids exhausting Supabase's connection pool with a fresh
// PrismaClient per request/hot-reload.
const prisma = global.__kimsPrisma || new PrismaClient({
  log: process.env.NODE_ENV === 'production'
    // Event-based (not stdout) so the listener below can filter by
    // duration — logging every single query in production would be far too
    // noisy to be useful, but a query that's genuinely slow is exactly what
    // the app-wide latency reports need surfaced.
    ? [{ emit: 'event', level: 'query' }, 'error', 'warn']
    : ['error', 'warn', 'query'],
});

// Temporary diagnostic for the "stays slow throughout use" reports — logs
// only queries slow enough to plausibly explain a multi-second UI delay.
// Safe to remove once the actual bottleneck (DB vs elsewhere) is confirmed.
const SLOW_QUERY_MS = 300;
if (process.env.NODE_ENV === 'production') {
  prisma.$on('query', (e) => {
    if (e.duration >= SLOW_QUERY_MS) {
      console.warn(`[slow-query] ${e.duration}ms :: ${e.query.slice(0, 200)}`);
    }
  });
}

if (process.env.NODE_ENV !== 'production') {
  global.__kimsPrisma = prisma;
}

module.exports = prisma;
