const express = require('express');
const ctrl = require('../controllers/visitor.controller');

// Public — no auth. Backs the WhatsApp "track your car" link, which a
// patient/visitor opens straight from their phone with no app/login.
const router = express.Router();

router.get('/:id', ctrl.track);

module.exports = router;
