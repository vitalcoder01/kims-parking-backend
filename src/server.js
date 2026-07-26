// Must be the very first require — loads .env.development or .env.production
// (based on NODE_ENV) before any other module (esp. the Prisma client) reads
// process.env.
const { NODE_ENV, PORT, envFile } = require('./config/env');

const app = require('./app');

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[kims-parking-backend] ${NODE_ENV} server listening on port ${PORT} (loaded ${envFile})`);
});

async function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`\n[kims-parking-backend] ${signal} received, shutting down...`);
  const prisma = require('./config/database');
  await prisma.$disconnect();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
