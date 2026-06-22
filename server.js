'use strict';
/**
 * server.js — Spawn Internet Coin Vendo System
 * Express app: security middleware, static portal, REST API, error handling,
 * and a lightweight in-process session-expiry sweep.
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const apiRoutes = require('./routes');
const { notFound, errorHandler } = require('./middleware/error');
const { supabaseAdmin } = require('./config/supabase');

const app = express();

// Trust proxy — KINAHANGLAN para sa Railway (naa sa likod sa proxy).
// Para sa rate limiting + accurate client IP detection (X-Forwarded-For).
// 1 = trust ang unang proxy (Railway edge). Dili 'true' kay insecure (mahimong i-spoof).
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// --- security & parsing ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' allows inline <script> blocks (internal admin tool — pages use inline JS)
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      // scriptSrcAttr allows inline event handlers like onclick="..." (29+ sa dashboard)
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc:  ["'none'"],
      frameAncestors: ["'self'"],
      // --- ZAP fix: explicit directives nga walay default-src fallback ---
      baseUri:    ["'self'"],        // pugngan ang <base> tag hijack
      formAction: ["'self'"],        // forms mo-submit ra sa kaugalingong server
      frameSrc:   ["'none'"],        // walay iframe embedding
      workerSrc:  ["'self'"],        // web workers gikan ra sa kaugalingon
      manifestSrc:["'self'"],
      mediaSrc:   ["'self'"],
    },
  },
}));

// CORS — restrict to known origins (set CORS_ORIGINS=comma,separated,list in .env)
// Same-origin requests (dashboard -> kaugalingong API) ALWAYS allowed.
// External cross-origin requests blocked unless naa sa CORS_ORIGINS whitelist.
const allowedOrigins = (process.env.CORS_ORIGINS || `http://localhost:${PORT}`)
  .split(',').map((s) => s.trim()).filter(Boolean);

// Auto-allow ang kaugalingong Railway/public domain (same-origin dashboard)
const SELF_HOSTS = [
  'https://spawn-vendo-cloud-production-4f63.up.railway.app', // known production domain
  process.env.RAILWAY_PUBLIC_DOMAIN,            // Railway auto-sets ni
  process.env.RAILWAY_STATIC_URL,
  process.env.PUBLIC_URL,
].filter(Boolean).map((h) => h.startsWith('http') ? h : `https://${h}`);

app.use(cors({
  origin(origin, cb) {
    // allow same-origin / non-browser clients (no Origin header)
    if (!origin) return cb(null, true);
    // allow whitelisted origins + kaugalingong host (same-origin dashboard)
    if (allowedOrigins.includes(origin) || SELF_HOSTS.includes(origin)) return cb(null, true);
    // allow vendo captive portals: private LAN IPs (10.x, 192.168.x, 172.16-31.x) on port 3000.
    // Kada vendo naay kaugalingong LAN IP — ang portal mo-fetch session/pricing gikan sa Railway.
    if (/^http:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):3000$/.test(origin)) {
      return cb(null, true);
    }
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('tiny'));

// --- ZAP fix: no-cache para sa API responses (sensitive data dili ma-cache) ---
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  next();
});

// --- API ---
app.use('/api', apiRoutes);

// --- static frontend (captive portal + dashboards) ---
app.use(express.static(path.join(__dirname, 'public')));

// Dashboard routes — Admin only
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));

// Redirect old role URLs to admin
app.get('/technician', (req, res) => res.redirect('/admin'));
app.get('/operator', (req, res) => res.redirect('/admin'));

// --- errors ---
app.use('/api', notFound);
app.use(errorHandler);

// --- background expiry sweep (every 60s) ---
setInterval(async () => {
  try {
    const { data, error } = await supabaseAdmin.rpc('expire_sessions');
    if (!error && data) console.log(`[sweep] expired ${data} session(s)`);
  } catch (e) { /* ignore */ }
}, 60 * 1000);

app.listen(PORT, () => {
  console.log(`Spawn Vendo System running on http://localhost:${PORT}`);
});

module.exports = app;