const prisma = require('../config/database');
const ApiError = require('./ApiError');

// Read Committed (Postgres/Prisma's default) lets two concurrent
// transactions both read "not taken yet" before either writes — e.g. two
// valets assigning two different jobs to the same driver at the same
// instant, or two drivers claiming the same free slot. Serializable makes
// Postgres abort the loser with a real conflict error instead of silently
// letting both succeed; this maps that abort to a friendly "try again"
// instead of a raw 500.
async function runSerializable(fn) {
  try {
    return await prisma.$transaction(fn, { isolationLevel: 'Serializable' });
  } catch (err) {
    if (err.code === 'P2034') {
      throw ApiError.conflict('That just changed under you — please try again');
    }
    throw err;
  }
}

module.exports = runSerializable;
