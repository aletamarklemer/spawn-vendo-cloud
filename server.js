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
const PORT = process.env.PORT || 3000;

// --- security & parsing ---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc:  ["'none'"],
      frameAncestors: ["'self'"],
    },
  },
}));

// CORS — restrict to known origins (set CORS_ORIGINS=comma,separated,list in .env)
const allowedOrigins = (process.env.CORS_ORIGINS || `http://localhost:${PORT}`)
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // allow same-origin / non-browser clients (no Origin header) and whitelisted origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('tiny'));

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