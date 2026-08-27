const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const service = require('../services/clientError.service');
const parseId = require('../utils/parseId');

/*
 * Crash intake and triage.
 *
 * The reporting endpoint is the unusual one here: it is written to by
 * clients that are, by definition, in a bad state. It has to assume the
 * caller may be looping, may send malformed payloads, and may be several
 * releases old. So it validates narrowly, stores a bounded amount, and never
 * lets a failure here become a second visible failure on a phone that is
 * already broken.
 */

/** Guards against a wedged client turning one bug into a write storm. */
const MAX_PER_MINUTE = 30;
const seen = new Map(); // fingerprint -> {count, windowStart}

function overRate(fingerprint) {
  const now = Date.now();
  const entry = seen.get(fingerprint);
  if (!entry || now - entry.windowStart > 60_000) {
    seen.set(fingerprint, {count: 1, windowStart: now});
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_MINUTE;
}

// Keep the rate-limit map from growing without bound on a long-lived process.
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [k, v] of seen) if (v.windowStart < cutoff) seen.delete(k);
}, 5 * 60_000).unref();

const report = asyncHandler(async (req, res) => {
  const {fingerprint, platform, appVersion, name, message, stack, screen} = req.body ?? {};

  if (!fingerprint || typeof fingerprint !== 'string') {
    throw ApiError.badRequest('fingerprint is required');
  }
  if (platform !== 'android' && platform !== 'web') {
    throw ApiError.badRequest('platform must be android or web');
  }

  /*
   * Answer 202 rather than 429 when rate-limited.
   *
   * The client is already crashing; handing it an error to handle invites a
   * second failure inside its own error handler. It does not need to know we
   * dropped a duplicate — the row it belongs to already exists and already
   * has a count.
   */
  if (overRate(fingerprint)) {
    return res.status(202).json({accepted: false, reason: 'rate_limited'});
  }

  await service.record({
    fingerprint,
    platform,
    appVersion: String(appVersion || 'unknown').slice(0, 40),
    name,
    message,
    stack,
    screen,
    // Taken from the session, never from the body: a client in a broken
    // state is not a trustworthy source for who it is.
    role: req.user?.role ?? null,
    userId: req.user?.id ?? null,
  });

  res.status(202).json({accepted: true});
});

const list = asyncHandler(async (req, res) => {
  const errors = await service.list({
    includeResolved: req.query.includeResolved === 'true',
    limit: req.query.limit,
  });
  res.json({errors});
});

const resolve = asyncHandler(async (req, res) => {
  const error = await service.resolve(parseId(req.params.id));
  res.json({error});
});

module.exports = {report, list, resolve};
