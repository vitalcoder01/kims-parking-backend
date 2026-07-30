const ApiError = require('../utils/ApiError');

// Short-lived in-process mutual exclusion for assignment operations.
//
// Every assign path (parking task, visitor pickup, visitor retrieval) locks
// BOTH the job it's assigning AND the driver it's assigning — because the
// two races are different:
//   * same job, two valets      -> both would "reassign" sequentially
//   * same driver, two jobs     -> both would mark that one driver busy
// A per-job lock alone only stops the first; the driver key is what stops
// the second. All three paths share this one registry, so a parking task
// and a visitor pickup can't claim the same driver concurrently either.
//
// Node is single-threaded and there is no `await` between the has() checks
// and the add()s, so two callers can never both pass the check.
//
// NOTE: this is per-process. It is the second line of defence, not the
// first — the DB's partial unique index on (driverId) WHERE status IN
// (assigned, key_collected, in_transit) is what holds even across
// processes/restarts. This layer exists to turn those raw constraint
// violations into clean, immediate 409s in the common single-instance case.
const held = new Set();

const taskKey = (id) => `task:${id}`;
const visitorKey = (id) => `visitor:${id}`;
const driverKey = (id) => `driver:${id}`;

async function withLocks(keys, conflictMessage, fn) {
  for (const key of keys) {
    if (held.has(key)) throw ApiError.conflict(conflictMessage);
  }
  for (const key of keys) held.add(key);
  try {
    return await fn();
  } finally {
    for (const key of keys) held.delete(key);
  }
}

module.exports = { withLocks, taskKey, visitorKey, driverKey };
