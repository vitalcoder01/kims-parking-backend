require('./env'); // ensure the right .env.* file is loaded before Prisma reads DATABASE_URL

const { PrismaClient } = require('@prisma/client');

// Singleton — avoids exhausting Supabase's connection pool with a fresh
// PrismaClient per request/hot-reload.
const prisma = global.__kimsPrisma || new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['error', 'warn', 'query'],
});

if (process.env.NODE_ENV !== 'production') {
  global.__kimsPrisma = prisma;
}

module.exports = prisma;
