// Inbound WhatsApp commands. READ-ONLY.
//
// A visitor cannot act on their car over WhatsApp — no retrieve, no cancel,
// no reschedule. They come to the valet desk and the valet raises the
// retrieval through the normal workflow, so there is exactly one way a
// retrieval can be created and it is the one staff already use.
//
// This file therefore contains no business logic at all: it reads state and
// describes it.

const prisma = require('../config/database');
const whatsapp = require('./whatsapp.service');

// The visitor reads these on their phone in India; the server may well be
// running in UTC (Render is). Formatting without an explicit zone would tell
// someone their car is coming at 8:18 pm when they asked for 1:48 am.
// Overridable for a deployment that isn't in IST.
const DISPLAY_TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

function clockLabel(date) {
  return new Date(date).toLocaleTimeString('en-IN', {
    hour: 'numeric', minute: '2-digit', timeZone: DISPLAY_TZ,
  });
}

const HELP = [
  'KIMS Parking — what you can send me:',
  '',
  '/status   your parking token and where your car is',
  '/help     this message',
  '',
  'To collect your car, please come to the valet desk with your token.',
].join('\n');

// The most recent visitor for this number who still has a live session. A
// number can check in more than once over a day, so "latest active" is the
// only reading that isn't ambiguous.
async function findVisitorByMobile(mobile) {
  const digits = String(mobile ?? '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return null;
  return prisma.visitor.findFirst({
    where: { mobile: { endsWith: digits }, status: { notIn: ['retrieved', 'cancelled'] } },
    orderBy: { createdAt: 'desc' },
  });
}

// The visitor's live task, if any. Retrieval state lives on ParkingTask now,
// exactly as it does for staff.
async function currentTask(visitorId) {
  return prisma.parkingTask.findFirst({
    where: { visitorId, isCurrent: true },
    include: { driver: { include: { user: true } } },
  });
}

function statusText(visitor, task) {
  const car = visitor.carNumber || 'your vehicle';
  if (visitor.status === 'pending') return `${car} is being parked. We'll message you once it's in a slot.`;
  if (visitor.status === 'retrieved') return `${car} has been returned. Thank you for visiting KIMS.`;

  if (!task || task.type !== 'retrieve' || task.status === 'cancelled') {
    return `${car} is parked${visitor.slotId ? ` at slot ${visitor.slotId}` : ''}.\nToken ${visitor.token}.\nSend /retrieve when you're ready to leave.`;
  }
  if (task.status === 'delivered') return `${car} is waiting for you at the valet counter.`;
  if (task.driverId && (task.status === 'in_transit' || task.status === 'assigned')) {
    const who = task.driver?.user?.name ?? 'A driver';
    return task.status === 'in_transit'
      ? `${who} is bringing ${car} to the valet counter now.`
      : `${who} has been assigned and is on the way to your car.`;
  }
  // Scheduled but not yet started — say when, not "soon".
  if (task.retrievalReadyAt && new Date(task.retrievalReadyAt).getTime() > Date.now()) {
    return `Booked. We'll start bringing ${car} in time for ${clockLabel(task.plannedDepartureAt)}.\nSend /cancel or /reschedule to change it.`;
  }
  return `Your request for ${car} is with the valet team — a driver is being assigned.`;
}

async function handleCommand(mobile, rawText) {
  const text = String(rawText ?? '').trim();
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/^\//, '');

  if (cmd === 'help' || cmd === 'hi' || cmd === 'hello') return HELP;

  const visitor = await findVisitorByMobile(mobile);
  if (!visitor) {
    return "I couldn't find an active parking session for this number. If you've just checked in, please try again in a moment.";
  }
  const task = await currentTask(visitor.id);

  if (cmd === 'status') return statusText(visitor, task);




  return `I didn't understand that.\n\n${HELP}`;
}

/**
 * Meta webhook payload -> reply. Meta batches messages, so this walks the
 * envelope rather than assuming a single one, and answers each sender.
 */
async function handleWebhook(body) {
  const entries = body?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      for (const msg of change?.value?.messages ?? []) {
        // Interactive button replies carry their payload in a different
        // place from typed text; both end up as the same command string.
        const text = msg?.text?.body
          ?? msg?.interactive?.button_reply?.id
          ?? msg?.interactive?.list_reply?.id
          ?? msg?.button?.payload;
        if (!text || !msg.from) continue;
        try {
          const reply = await handleCommand(msg.from, text);
          if (reply) await whatsapp.sendText({ mobile: msg.from, body: reply });
        } catch (err) {
          // Never throw: Meta retries a non-200 webhook, which would replay
          // the command and could raise a second retrieval request.
          // eslint-disable-next-line no-console
          console.warn('[whatsapp] command failed:', err.message);
        }
      }
    }
  }
}

module.exports = { handleWebhook, handleCommand, HELP };
