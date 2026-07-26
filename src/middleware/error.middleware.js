const ApiError = require('../utils/ApiError');

function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

// Centralized error handler — every route funnels errors here via
// asyncHandler/next(err), so this is the single place that shapes error JSON.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err.code === 'P2002') {
    // Prisma unique constraint violation
    return res.status(409).json({
      error: { message: `Duplicate value for: ${err.meta?.target?.join(', ') || 'unique field'}` },
    });
  }
  if (err.code === 'P2025') {
    // Prisma "record not found" on update/delete
    return res.status(404).json({ error: { message: 'Record not found' } });
  }

  const statusCode = err instanceof ApiError ? err.statusCode : (err.statusCode || 500);
  const message = statusCode === 500 && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  if (statusCode === 500) {
    // eslint-disable-next-line no-console
    console.error(err);
  }

  res.status(statusCode).json({
    error: { message, details: err.details },
  });
}

module.exports = { notFoundHandler, errorHandler };
