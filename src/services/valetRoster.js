const prisma = require('../config/database');

// Ownership routing only means anything when there is more than one valet to
// route between. On a single-valet site "escalate to the rest of the team"
// resolves to the same person who was already alarmed, so the ladder has to
// know the difference — otherwise one car generates three alarms for one
// person, two of them worded for an audience that doesn't exist.
//
// Counted at call time, never baked in and never cached: a site goes from one
// valet to five between shifts, and both have to behave correctly without a
// restart or a config change.
//
// `take: 2` is all the resolution either question needs — "exactly one" and
// "more than one" are both answerable without counting the whole roster.
async function firstTwoValetIds() {
  const rows = await prisma.user.findMany({
    where: { role: 'valet' },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 2,
  });
  return rows.map(r => r.id);
}

// True when there is nobody to escalate TO, so a broadcast is just the same
// alarm reaching the same phone a second time.
async function isSoloValetSite() {
  return (await firstTwoValetIds()).length <= 1;
}

module.exports = { isSoloValetSite };
