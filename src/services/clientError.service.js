const prisma = require('../config/database');

/*
 * Client crash intake.
 *
 * One row per distinct fault, with a counter — not one row per occurrence.
 * A render loop can fire the same error hundreds of times a minute, and the
 * useful question is never "how many events" but "is this still happening,
 * to how many people, since which version". Aggregating on the way in is
 * what keeps this table readable and keeps a crash loop from becoming a
 * storage problem.
 */

/** Cap on stored stack size — enough to identify a fault, not a core dump. */
const MAX_STACK = 4000;
const MAX_MESSAGE = 1000;

/**
 * Record one occurrence.
 *
 * `userId` is used only to decide whether this is a NEW person hitting the
 * fault; it is never stored. A diagnostics table that can name who crashed
 * is a liability, and the count answers every question the identity would.
 */
async function record({fingerprint, platform, appVersion, name, message, stack, screen, role, userId}) {
  const existing = await prisma.clientError.findUnique({where: {fingerprint}});

  if (!existing) {
    return prisma.clientError.create({
      data: {
        fingerprint,
        platform,
        appVersion,
        name: String(name || 'Error').slice(0, 200),
        message: String(message || '').slice(0, MAX_MESSAGE),
        stack: stack ? String(stack).slice(0, MAX_STACK) : null,
        screen: screen ? String(screen).slice(0, 120) : null,
        roles: role ? [role] : [],
        userCount: userId ? 1 : 0,
      },
    });
  }

  /*
   * Roles accumulate so the table can answer "is this everyone, or only
   * valets" — which is usually the first thing worth knowing, because a
   * role-specific fault points straight at that role's screens.
   */
  const roles = role && !existing.roles.includes(role)
    ? [...existing.roles, role]
    : existing.roles;

  /*
   * userCount is an approximation and is meant to be.
   *
   * Counting distinct users exactly would mean storing user ids against
   * faults, which is exactly what this table refuses to do. Incrementing on
   * a role we had not seen before gives a floor on the blast radius —
   * enough to tell one person's broken phone from an outage — without
   * keeping anything identifying.
   */
  const sawNewRole = roles.length > existing.roles.length;

  return prisma.clientError.update({
    where: {fingerprint},
    data: {
      count: {increment: 1},
      lastSeenAt: new Date(),
      roles,
      userCount: sawNewRole ? {increment: 1} : undefined,
      // A fault that returns after being marked resolved is a regression and
      // must stop looking resolved.
      resolvedAt: null,
      // Always reflect the newest version that produced it, so a stale row
      // cannot make a live regression look like old news.
      appVersion,
    },
  });
}

/** Newest-first, unresolved by default — the triage view. */
async function list({includeResolved = false, limit = 50} = {}) {
  return prisma.clientError.findMany({
    where: includeResolved ? {} : {resolvedAt: null},
    orderBy: {lastSeenAt: 'desc'},
    take: Math.min(Number(limit) || 50, 200),
  });
}

async function resolve(id) {
  return prisma.clientError.update({where: {id}, data: {resolvedAt: new Date()}});
}

module.exports = {record, list, resolve};
