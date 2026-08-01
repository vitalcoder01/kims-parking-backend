const ApiError = require('../utils/ApiError');

function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

// Centralized error handler — every route funnels errors here via
// asyncHandler/next(err), so this is the single place that shapes error JSON.
// eslint-disable-next-line no-unused-vars
// Constraints that exist to enforce a real operational rule, not just data
// hygiene — a raw "Duplicate value for: driverId" tells a valet nothing
// about what they actually did wrong or what to do instead.
//
// Matched by substring, not exact equality: these two indexes aren't part
// of Prisma's schema DSL (written by hand in a migration — see
// schema.prisma's comments on ParkingTask), so Prisma has no field metadata
// for them and reports whatever the Postgres driver gives it — which varies
// between the index name and the bare column name depending on version/path.
// An exact-match lookup silently missed the column-name form and fell
// through to the raw "Duplicate value for: driverId" message, which is
// exactly the unhelpful text this table exists to avoid.
const CONSTRAINT_MESSAGES = [
  {test: /driver/i, message: 'This driver is already assigned to another job'},
  {test: /doctor_current|doctorId/i, message: 'This person already has an active parking session'},
];

function constraintMessage(err) {
  const target = err.meta?.target;
  const keys = Array.isArray(target) ? target : [target].filter(Boolean);
  const haystack = keys.join(' ');
  for (const {test, message} of CONSTRAINT_MESSAGES) {
    if (test.test(haystack)) return message;
  }
  return `Duplicate value for: ${keys.join(', ') || 'unique field'}`;
}

function errorHandler(err, req, res, next) {
  if (err.code === 'P2002') {
    // Prisma unique constraint violation
    return res.status(409).json({ error: { message: constraintMessage(err) } });
  }
  if (err.code === 'P2025') {
    // Prisma "record not found" on update/delete
    return res.status(404).json({ error: { message: 'Record not found' } });
  }
  // A write conflict/deadlock that escaped a retry loop (or came from a
  // path that never had one) is transient — it must not read as a 500.
  if (err.code === 'P2034' || err.code === '40001' || err.code === '40P01') {
    return res.status(409).json({
      error: { message: 'That just changed under you — please try again' },
    });
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
    error: { message, details: err.details, code: err.code },
  });
}

module.exports = { notFoundHandler, errorHandler };
