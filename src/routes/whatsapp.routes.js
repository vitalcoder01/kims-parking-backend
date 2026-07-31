const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const commands = require('../services/whatsappCommands');

// Meta Cloud API webhook. Public by necessity — Meta calls it — so it is
// mounted outside the authenticated API and verified by the shared token
// below rather than by a session.
const router = express.Router();

// Meta's one-time subscription handshake: it GETs with a challenge and
// expects the raw value echoed back, plain text, only if the token matches.
router.get('/', (req, res) => {
  const verify = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && verify && token === verify) {
    return res.status(200).send(String(challenge ?? ''));
  }
  return res.sendStatus(403);
});

// Inbound messages. Answered with 200 immediately and processed after:
// Meta retries anything slow or non-200, and a retry would replay the
// command — raising a second retrieval request for the same visitor.
router.post('/', asyncHandler(async (req, res) => {
  res.sendStatus(200);
  commands.handleWebhook(req.body).catch(() => {});
}));

module.exports = router;
