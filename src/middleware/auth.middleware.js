const { verifyToken } = require('../utils/jwt');
const ApiError = require('../utils/ApiError');
const prisma = require('../config/database');
const cache = require('../utils/responseCache');

// This lookup runs on literally every authenticated request — every
// ~4s poll from every connected screen, of which most screens fire several
// concurrently (tasks/slots/drivers/visitors/notifications all at once).
// A short cache turns that from "one DB round trip per request" into
// roughly "one per user per TTL window". Any mutation that can change what
// this returns (see user.service.js) invalidates the specific user's entry
// immediately, so a role change still applies without re-login — the TTL
// only governs the unchanged case, never a stale-after-write one.
const CACHE_TTL_MS = 3000;
const cacheKey = (userId) => `authuser:${userId}`;

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw ApiError.unauthorized('Missing or malformed Authorization header');
    }

    const payload = verifyToken(token);
    const user = await cache.cached(cacheKey(payload.sub), CACHE_TTL_MS, () => prisma.user.findUnique({
      where: { id: payload.sub },
      include: { driver: true },
    }));
    if (!user) throw ApiError.unauthorized('User no longer exists');

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return next(ApiError.unauthorized('Session expired, please sign in again'));
    if (err.name === 'JsonWebTokenError') return next(ApiError.unauthorized('Invalid session token'));
    next(err);
  }
}

module.exports = { requireAuth, invalidateUserCache: (userId) => cache.invalidate(cacheKey(userId)) };
