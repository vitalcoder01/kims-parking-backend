const express = require('express');
const ctrl = require('../controllers/visitor.controller');

// Public — no auth. Backs the WhatsApp "track your car" link, which a
// patient/visitor opens straight from their phone with no app/login.
//
// Read-only. A visitor cannot request their own car: they come to the valet
// desk, and the valet raises the retrieval through the normal workflow. That
// also means this router has no public write for anyone to abuse.
const router = express.Router();


router.get('/:id', ctrl.track);

module.exports = router;
