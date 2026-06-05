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
app.use(helmet({ contentSecurityPolicy: false })); // CSP off so CDN Bootstrap/Chart.js load
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('tiny'));

// --- API ---
app.use('/api', apiRoutes);

// --- static frontend (captive portal + dashboards) ---
app.use(express.static(path.join(__dirname, 'public')));

// Dashboard routes resolve to their HTML files
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));
app.get('/technician', (req, res) => res.sendFile(path.join(__dirname, 'public/technician/index.html')));
app.get('/operator', (req, res) => res.sendFile(path.join(__dirname, 'public/operator/index.html')));

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
