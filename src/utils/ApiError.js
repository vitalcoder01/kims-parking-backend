class ApiError extends Error {
  // `code` is a stable, machine-readable tag for the cases a client needs to
  // branch on. Messages are written for humans and get reworded; anything
  // that string-matches them breaks silently the next time the copy changes.
  constructor(statusCode, message, details, code) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.code = code;
  }

  static badRequest(message, details) { return new ApiError(400, message, details); }
  static unauthorized(message = 'Unauthorized') { return new ApiError(401, message); }
  static forbidden(message = 'Forbidden') { return new ApiError(403, message); }
  static notFound(message = 'Not found') { return new ApiError(404, message); }
  static conflict(message, code) { return new ApiError(409, message, undefined, code); }
}

module.exports = ApiError;
