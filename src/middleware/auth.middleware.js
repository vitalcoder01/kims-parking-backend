const { verifyToken } = require('../utils/jwt');
const ApiError = require('../utils/ApiError');
const prisma = require('../config/database');

// Verifies the Bearer JWT and attaches the current user (with driver profile
// if applicable) to req.user. 12-hour expiry is enforced by the token itself
// (see JWT_EXPIRES_IN), matching the mobile app's 12-hour session window.
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw ApiError.unauthorized('Missing or malformed Authorization header');
    }

    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { driver: true },
    });
    if (!user) throw ApiError.unauthorized('User no longer exists');

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return next(ApiError.unauthorized('Session expired, please sign in again'));
    if (err.name === 'JsonWebTokenError') return next(ApiError.unauthorized('Invalid session token'));
    next(err);
  }
}

module.exports = { requireAuth };
