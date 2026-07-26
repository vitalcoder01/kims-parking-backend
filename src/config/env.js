const path = require('path');
const dotenv = require('dotenv');

// Must run before anything else (Prisma client reads DATABASE_URL at import
// time), so this file is required first thing in server.js.
const NODE_ENV = process.env.NODE_ENV || 'development';
const envFile = NODE_ENV === 'production' ? '.env.production' : '.env.development';

dotenv.config({ path: path.resolve(__dirname, '../..', envFile) });

const required = ['DATABASE_URL', 'JWT_SECRET'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
  const message = `[env] Missing ${missing.join(', ')} in ${envFile}.`;
  if (NODE_ENV === 'production') {
    // A missing JWT_SECRET must never silently fall back to a known default
    // in production — that would let anyone forge a valid session token.
    // Refusing to start is much safer than running insecurely.
    throw new Error(`${message} Refusing to start in production without these set.`);
  }
  // eslint-disable-next-line no-console
  console.warn(`${message} Server will start but DB/auth routes will fail until these are set.`);
}

module.exports = {
  NODE_ENV,
  envFile,
  PORT: Number(process.env.PORT) || 4000,
  JWT_SECRET: process.env.JWT_SECRET || 'insecure-dev-secret',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '12h',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  LOG_LEVEL: process.env.LOG_LEVEL || 'debug',
};
