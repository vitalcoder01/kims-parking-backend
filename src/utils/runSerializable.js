const prisma = require('../config/database');
const ApiError = require('./ApiError');

// Read Committed (Postgres/Prisma's default) lets two concurrent
// transactions both read "not taken yet" before either writes — e.g. two
// valets assigning two different jobs to the same driver at the same
// instant, or two drivers claiming the same free slot. Serializable makes
// Postgres abort the loser rather than silently letting both succeed.
//
// The catch: under Serializable, an abort is NOT necessarily a real
// business conflict. Postgres aborts on any read-write dependency it can't
// prove safe — including entirely benign ones, like a driver's GPS ping
// (updateLocation, every ~3s) writing to the same parking_tasks row that a
// state transition is reading. Those are transient by definition: the
// transaction rolled back cleanly and the exact same call succeeds on a
// second attempt.
//
// So retry them here instead of bubbling up. Surfacing "please try again"
// to a driver standing at the counter — for a conflict that resolves itself
// on a retry a few milliseconds later — is the server making its
// concurrency-control strategy the user's problem.
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 25;

// P2034: "Transaction failed due to a write conflict or a deadlock".
// 40001 = serialization_failure, 40P01 = deadlock_detected — the raw
// Postgres SQLSTATEs behind it, checked too since not every driver/path
// surfaces the Prisma code.
function isTransientConflict(err) {
  return err?.code === 'P2034' || err?.code === '40001' || err?.code === '40P01';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runSerializable(fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: 'Serializable' });
    } catch (err) {
      if (!isTransientConflict(err)) throw err;
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        // Exponential backoff with jitter — two callers that collided once
        // would otherwise retry in lockstep and collide again.
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        await sleep(delay + Math.random() * delay);
      }
    }
  }
  // Genuinely contended past every retry — now it's worth telling someone.
  // eslint-disable-next-line no-console
  console.warn(`[runSerializable] gave up after ${MAX_ATTEMPTS} attempts:`, lastErr?.message);
  throw ApiError.conflict('That just changed under you — please try again');
}

module.exports = runSerializable;
module.exports.isTransientConflict = isTransientConflict;
