const prisma = require('../config/database');
const whatsapp = require('./whatsapp.service');
const pushService = require('./push.service');

/*
 * Tells you about faults instead of waiting to be asked.
 *
 * Crash reports land in client_errors, which until now could only be read by
 * opening the admin app or a laptop — so the reporting pipeline ended in a
 * table nobody was looking at. A valet hits a crash at 3am and the fastest
 * anyone finds out is whenever someone next thinks to check.
 *
 * WhatsApp is the delivery channel that actually solves that, because it
 * needs neither the app nor a laptop: the message arrives like any other
 * message, on a phone already in a pocket. Push is sent alongside for admins
 * who do have the app, and is the weaker of the two — an admin who has not
 * opened the app in a week still gets the WhatsApp.
 *
 * Two moments, deliberately:
 *
 *   NEW FAULT   sent immediately, once, the first time a fingerprint is ever
 *               seen. Something just broke that has never broken before.
 *
 *   DAILY       one summary, so recurring faults are visible without a
 *               message per occurrence. A crash loop is one line in the
 *               digest, not four hundred notifications.
 *
 * Everything here is best-effort and swallows its own failures. A reporting
 * pipeline that can break the request that triggered it is worse than no
 * reporting pipeline.
 */

const DIGEST_HOUR = Number(process.env.FAULT_DIGEST_HOUR ?? 20); // local, 24h
const DAY_MS = 24 * 60 * 60 * 1000;

/*
 * Who gets told.
 *
 * FAULT_ALERT_PHONES is the one that actually matters, and it exists because
 * of what the admin table really contains: both admin accounts have no phone
 * number at all. Deriving recipients purely from user records would have
 * produced a reporting pipeline that ran perfectly and messaged nobody —
 * failing exactly the way the bug it reports on fails, silently.
 *
 * So: an explicit env list, comma-separated, set on the host. It keeps real
 * numbers out of the repository, works whether or not anyone has filled in
 * their profile, and reaches a phone that needs neither this app nor a
 * laptop. Admin profile numbers are merged in when present.
 */
async function recipients() {
  const admins = await prisma.user.findMany({
    where: { role: 'admin' },
    select: { id: true, name: true, phone: true },
  });

  const fromEnv = (process.env.FAULT_ALERT_PHONES ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);

  const phones = [...new Set([...fromEnv, ...admins.map(a => a.phone).filter(Boolean)])];
  return { ids: admins.map(a => a.id), phones };
}

/**
 * Whether anything can actually be delivered.
 *
 * Reported once at startup rather than discovered months later: a digest
 * nobody receives looks identical to a system with no faults.
 */
function deliveryStatus() {
  const hasEnvPhones = Boolean((process.env.FAULT_ALERT_PHONES ?? '').trim());
  return {
    whatsappConfigured: whatsapp.isConfigured(),
    hasEnvPhones,
  };
}

async function deliver(title, body) {
  const { ids, phones } = await recipients();

  if (whatsapp.isConfigured()) {
    for (const mobile of phones) {
      // Sequential and individually guarded: one bad number must not stop the
      // rest of the list.
      await whatsapp.sendText({ mobile, body: `${title}\n\n${body}` }).catch(() => {});
    }
  }

  if (ids.length) {
    // 'info', never 'alarm'. A crash report is not worth a twenty-second
    // ring in someone's pocket — the whole point of the tiering is that the
    // loud alert keeps its meaning.
    await pushService.pushToUsers(ids, {
      title,
      body,
      type: 'info',
      tag: 'kims-fault-digest',
    }).catch(() => {});
  }
}

/**
 * A fingerprint nobody has ever seen before.
 *
 * Called only on CREATE, never on the increment path, so a fault that fires
 * four hundred times sends exactly one message.
 */
async function notifyNewFault(row) {
  try {
    const where = row.screen ? ` on ${row.screen}` : '';
    const who = row.roles?.length ? ` (${row.roles.join(', ')})` : '';
    await deliver(
      '🐞 New fault in KIMS Parking',
      `${row.name}: ${row.message}`.slice(0, 300)
      + `\n\nv${row.appVersion} · ${row.platform}${where}${who}`
      + '\n\nThis is the first time this one has happened.',
    );
  } catch {
    // Never let reporting break the thing being reported.
  }
}

/** Everything from the last 24 hours, in one message. */
async function sendDailyDigest() {
  try {
    const since = new Date(Date.now() - DAY_MS);

    const active = await prisma.clientError.findMany({
      where: { lastSeenAt: { gte: since } },
      orderBy: { count: 'desc' },
      take: 5,
    });
    const fixed = await prisma.clientError.count({ where: { resolvedAt: { gte: since } } });
    const fresh = await prisma.clientError.count({ where: { firstSeenAt: { gte: since } } });

    if (!active.length && !fixed) {
      // Silence beats a daily "nothing happened" — a report that arrives
      // every day regardless is one people stop opening, and then the day it
      // matters it goes unread too.
      return;
    }

    const lines = active.map(e => {
      const where = e.screen ? ` · ${e.screen}` : '';
      return `• ${e.name}: ${String(e.message).slice(0, 90)}\n  ×${e.count}${where} · v${e.appVersion}`;
    });

    const total = active.reduce((n, e) => n + e.count, 0);
    await deliver(
      '📋 KIMS Parking — today',
      `${fresh} new fault${fresh === 1 ? '' : 's'}, `
      + `${active.length} active, `
      + `${total} occurrence${total === 1 ? '' : 's'}, `
      + `${fixed} marked fixed.\n\n`
      + (lines.length ? lines.join('\n') : 'Nothing currently failing.'),
    );
  } catch {
    // Best-effort by design.
  }
}

let digestTimer = null;
let lastDigestDay = null;

/**
 * Checks once an hour whether the digest hour has arrived today.
 *
 * A DB-free hourly tick rather than a cron dependency, matching how
 * jobAlerts and driverReminder already sweep. lastDigestDay guards against a
 * restart inside the digest hour sending a second copy — a process that
 * redeploys twice in an evening should not message everyone three times.
 */
function startDigest() {
  if (digestTimer) return;
  const tick = () => {
    const now = new Date();
    const day = now.toDateString();
    if (now.getHours() === DIGEST_HOUR && lastDigestDay !== day) {
      lastDigestDay = day;
      sendDailyDigest();
    }
  };
  const status = deliveryStatus();
  if (!status.whatsappConfigured || !status.hasEnvPhones) {
    // Loud on purpose. This is the failure mode where everything "works" and
    // no message ever arrives.
    console.warn(
      '[faultDigest] fault alerts will not reach WhatsApp — '
      + `whatsappConfigured=${status.whatsappConfigured}, FAULT_ALERT_PHONES=${status.hasEnvPhones ? 'set' : 'NOT SET'}. `
      + 'Admins with the app still receive a push.',
    );
  }

  tick();
  digestTimer = setInterval(tick, 60 * 60 * 1000);
  if (digestTimer.unref) digestTimer.unref();
}

module.exports = { notifyNewFault, sendDailyDigest, startDigest, deliveryStatus };
