// WhatsApp Cloud API (Meta) — server-side template sending.
//
// Entirely optional at runtime. Without WHATSAPP_PHONE_NUMBER_ID and
// WHATSAPP_ACCESS_TOKEN every send is a silent no-op, exactly like
// push.service.js is without FIREBASE_SERVICE_ACCOUNT, so the server runs
// normally before the Meta app exists and starts sending the moment the
// credentials are added — no code change, no redeploy of anything else.
//
// Environment switching is automatic: the process loads .env.development or
// .env.production by NODE_ENV (see server.js), so this file only ever reads
// process.env and never needs to know which environment it is in. Template
// NAMES come from the environment too — Meta templates are approved per
// account, so a hardcoded name would work in one environment and 404 in the
// other.
//
// Nothing here is ever exposed to the frontend: the token stays in the
// server process, and clients only call our own endpoints.

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';

function config() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) return null;
  return { phoneNumberId, accessToken };
}

/** True when the Meta app is configured — useful for health/diagnostics. */
function isConfigured() {
  return config() !== null;
}

// India-first, matching the rest of the app (the valet-side deep link already
// assumes +91). A number already carrying a country code is left alone.
function toE164(mobile) {
  const digits = String(mobile ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

async function post(path, body) {
  const cfg = config();
  if (!cfg) return null;
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${cfg.phoneNumberId}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Never thrown to the caller — a WhatsApp failure must not fail the
    // check-in that triggered it. The visitor is already parked; the message
    // is a courtesy on top.
    // eslint-disable-next-line no-console
    console.warn('[whatsapp] send failed:', json?.error?.message ?? res.status);
    return null;
  }
  return json;
}

/**
 * The check-in template: welcome, parking token, tracking link, and the two
 * quick-action buttons (retrieve / status).
 *
 * Body and button parameters are positional in Meta templates, so the order
 * here has to match the approved template exactly. Documented rather than
 * inferred, because getting it wrong sends a plausible-looking message with
 * the token in the wrong slot.
 *
 *   {{1}} visitor name (or "there" when they didn't give one)
 *   {{2}} parking token
 *   {{3}} vehicle number (or "your vehicle")
 *   button url suffix -> the publicToken, appended to the template's base URL
 */
async function sendCheckIn({ mobile, name, token, publicToken, carNumber }) {
  const template = process.env.WHATSAPP_TEMPLATE_CHECKIN;
  const to = toE164(mobile);
  if (!config() || !template || !to) return null;

  return post('messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template,
      language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: (name && name.trim()) || 'there' },
            { type: 'text', text: String(token) },
            { type: 'text', text: (carNumber && carNumber.trim()) || 'your vehicle' },
          ],
        },
        {
          // Dynamic URL button — Meta appends this to the template's base URL,
          // so the approved template holds the domain and this supplies only
          // the token. That keeps the tracking domain out of the code.
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: String(publicToken) }],
        },
      ],
    },
  });
}

/**
 * Free-form reply, used by the inbound command handler (/status, /help …).
 *
 * Only valid inside the 24-hour customer service window Meta allows after the
 * visitor messages us — which is exactly when this is called, since it only
 * ever answers an inbound message.
 */
async function sendText({ mobile, body }) {
  const to = toE164(mobile);
  if (!config() || !to || !body) return null;
  return post('messages', {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { preview_url: false, body },
  });
}

module.exports = { isConfigured, sendCheckIn, sendText, toE164 };
