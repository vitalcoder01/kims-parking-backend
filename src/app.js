const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const {rateLimit, ipKeyGenerator} = require('express-rate-limit');

const { NODE_ENV, CORS_ORIGIN, LOG_LEVEL } = require('./config/env');
const routes = require('./routes');
const { renderTrackPage } = require('./views/trackPage');
const { notFoundHandler, errorHandler } = require('./middleware/error.middleware');

const app = express();

app.use(helmet());
app.use(cors({
  origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map(o => o.trim()),
}));
// Every response here is JSON or HTML polled repeatedly by mobile clients on
// cellular connections — gzip cuts payload size (and radio time) for
// essentially free CPU cost at this request volume.
app.use(compression());
app.use(express.json({ limit: '256kb' }));
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));

// Baseline abuse guard for the whole API — generous enough that the app's
// own ~4s polling (several requests per tick, per device) never comes close,
// but stops a runaway client or scripted abuse from hammering the DB.
//
// Keyed on the bearer token (falling back to IP only for unauthenticated
// requests) rather than IP alone — a whole hospital's staff typically share
// one NAT gateway/public IP, so an IP-keyed limit would throttle everyone
// together the moment enough phones are polling at once.
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.headers.authorization || ipKeyGenerator(req.ip),
}));

app.get('/', (req, res) => {
  res.json({ service: 'kims-parking-backend', env: NODE_ENV, logLevel: LOG_LEVEL });
});

// Public visitor tracking page — plain HTML, no auth, opened straight from
// the WhatsApp link. Lives outside /api since it's a page, not a JSON route;
// the page itself polls /api/track/:id for data.
app.get('/track/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  // helmet's default CSP (script-src/style-src 'self') would block this
  // page's inline <script>/<style> — relax just for this one HTML response.
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
  res.send(renderTrackPage(req.params.id));
});

// WhatsApp webhook — Meta calls this, so it sits outside /api and its auth.
// Mounted before the rate limiter for the same reason: throttling Meta's
// delivery attempts would just make it retry.
app.use('/webhooks/whatsapp', require('./routes/whatsapp.routes'));

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
