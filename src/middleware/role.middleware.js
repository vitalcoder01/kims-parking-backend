const ApiError = require('../utils/ApiError');

// Usage: router.post('/x', requireAuth, requireRole('valet', 'admin'), handler)
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(ApiError.forbidden(`This action requires one of: ${roles.join(', ')}`));
    }
    next();
  };
}

module.exports = { requireRole };
