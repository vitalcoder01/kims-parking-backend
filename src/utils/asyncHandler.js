// Wraps an async route handler so rejected promises are forwarded to
// Express's error middleware instead of crashing the process.
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
