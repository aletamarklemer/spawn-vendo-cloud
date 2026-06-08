'use strict';
/** routes/index.js — mounts all REST routes under /api */
const router = require('express').Router();
const rateLimit = require('express-rate-limit');

const { authenticate, authorize, deviceAuth } = require('../middleware/auth');
const auth = require('../controllers/auth.controller');
const coin = require('../controllers/coin.controller');
const voucher = require('../controllers/voucher.controller');
const device = require('../controllers/device.controller');
const admin = require('../controllers/admin.controller');
const enforcement = require('../controllers/enforcement.controller');
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('../config/supabase');

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const coinLimiter  = rateLimit({ windowMs: 60 * 1000, max: 120 });

// --- public config for the browser (anon key only) ---
router.get('/config', (req, res) =>
  res.json({ success: true, data: { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY } }));

router.get('/health', (req, res) => res.json({ success: true, data: { status: 'ok', ts: Date.now() } }));

// --- auth ---
router.post('/auth/login', loginLimiter, auth.login);
router.post('/auth/register', authenticate, authorize('admin'), auth.register);
router.get('/auth/me', authenticate, auth.me);

// --- coin / session (device + public portal) ---
router.post('/coin/insert', coinLimiter, deviceAuth, coin.insertCoin);
router.post('/coin/portal-insert', coinLimiter, coin.portalInsert); // public (captive portal)
router.post('/coin/arm', coinLimiter, coin.armDevice);              // public (captive portal claims a machine)
router.get('/coin/session/:mac', coin.getSession);
router.get('/coin/history/:mac', coin.history);

// --- enforcement (OpenWRT agent polls this) ---
router.get('/enforcement/allowed', deviceAuth, enforcement.allowedClients);

// --- vouchers ---
router.post('/vouchers/generate', authenticate, authorize('admin'), voucher.generate);
router.get('/vouchers', authenticate, authorize('admin'), voucher.list);
router.post('/vouchers/void', authenticate, authorize('admin'), voucher.voidVoucher);
router.post('/vouchers/redeem', voucher.redeem); // public (captive portal)

// --- devices ---
router.get('/devices', authenticate, authorize('admin', 'technician', 'operator'), device.list);
router.post('/devices', authenticate, authorize('admin'), device.create);
router.patch('/devices/:id', authenticate, authorize('admin', 'technician'), device.update);
router.delete('/devices/:id', authenticate, authorize('admin'), device.remove);
router.post('/devices/heartbeat', deviceAuth, device.heartbeat);

// --- maintenance ---
router.get('/maintenance', authenticate, authorize('admin', 'technician'), device.listMaintenance);
router.post('/maintenance', authenticate, authorize('admin', 'technician'), device.createMaintenance);
router.patch('/maintenance/:id', authenticate, authorize('admin', 'technician'), device.resolveMaintenance);

// --- admin analytics / settings / users / audit ---
router.get('/admin/stats', authenticate, authorize('admin', 'operator', 'technician'), admin.stats);
router.get('/admin/revenue', authenticate, authorize('admin'), admin.revenueSeries);
router.get('/admin/transactions', authenticate, authorize('admin'), admin.transactions);
router.get('/admin/settings', authenticate, authorize('admin'), admin.getSettings);
router.put('/admin/settings', authenticate, authorize('admin'), admin.updateSettings);
router.get('/admin/users', authenticate, authorize('admin'), admin.listUsers);
router.patch('/admin/users/:id/active', authenticate, authorize('admin'), admin.setUserActive);
router.get('/admin/audit', authenticate, authorize('admin'), admin.auditLogs);

// --- collections (operator + admin) ---
router.get('/collections', authenticate, authorize('admin', 'operator'), admin.listCollections);
router.post('/collections', authenticate, authorize('admin', 'operator'), admin.createCollection);

module.exports = router;