'use strict';
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

router.get('/config', (req, res) =>
  res.json({ success: true, data: { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY } }));

router.get('/health', (req, res) => res.json({ success: true, data: { status: 'ok', ts: Date.now() } }));

// public - no auth
router.get('/pricing', admin.getPublicPricing);

router.post('/auth/login', loginLimiter, auth.login);
router.post('/auth/register', authenticate, authorize('admin'), auth.register);
router.get('/auth/me', authenticate, auth.me);

router.post('/coin/insert', coinLimiter, deviceAuth, coin.insertCoin);
router.post('/coin/portal-insert', coinLimiter, coin.portalInsert);
router.post('/coin/arm', coinLimiter, coin.armDevice);
router.get('/coin/session/:mac', coin.getSession);
router.get('/coin/history/:mac', coin.history);
router.post('/coin/session/pause', deviceAuth, coin.pauseSession);
router.post('/coin/session/resume', deviceAuth, coin.resumeSession);

// enforcement
router.get('/enforcement/allowed', deviceAuth, enforcement.allowedClients);

// vouchers
router.post('/vouchers/generate', authenticate, authorize('admin'), voucher.generate);
router.get('/vouchers', authenticate, authorize('admin'), voucher.list);
router.post('/vouchers/void', authenticate, authorize('admin'), voucher.voidVoucher);
router.post('/vouchers/redeem', voucher.redeem);
router.delete('/vouchers/:id', authenticate, authorize('admin'), voucher.deleteVoucher);
router.delete('/vouchers/voided', authenticate, authorize('admin'), voucher.deleteVoidedVouchers);

// devices
router.get('/devices', authenticate, authorize('admin', 'technician', 'operator'), device.list);
router.post('/devices', authenticate, authorize('admin'), device.create);
router.patch('/devices/:id', authenticate, authorize('admin', 'technician'), device.update);
router.delete('/devices/:id', authenticate, authorize('admin'), device.remove);
router.post('/devices/heartbeat', deviceAuth, device.heartbeat);

// maintenance
router.get('/maintenance', authenticate, authorize('admin', 'technician'), device.listMaintenance);
router.post('/maintenance', authenticate, authorize('admin', 'technician'), device.createMaintenance);
router.patch('/maintenance/:id', authenticate, authorize('admin', 'technician'), device.resolveMaintenance);

// admin stats & revenue
router.get('/admin/stats', authenticate, authorize('admin', 'operator', 'technician'), admin.stats);
router.get('/admin/revenue', authenticate, authorize('admin'), admin.revenueSeries);

// transactions
router.get('/admin/transactions', authenticate, authorize('admin', 'operator'), admin.transactions);
router.delete('/admin/transactions', authenticate, authorize('admin'), admin.deleteAllTransactions);
router.delete('/admin/transactions/:id', authenticate, authorize('admin'), admin.deleteTransaction);

// sessions
router.get('/admin/sessions', authenticate, authorize('admin', 'operator', 'technician'), admin.listSessions);
router.delete('/admin/sessions/expired', authenticate, authorize('admin'), admin.deleteExpiredSessions);
router.delete('/admin/sessions/:id', authenticate, authorize('admin'), admin.deleteSession);

// settings
router.get('/admin/settings', authenticate, authorize('admin'), admin.getSettings);
router.put('/admin/settings', authenticate, authorize('admin'), admin.updateSettings);

// users
router.get('/admin/users', authenticate, authorize('admin'), admin.listUsers);
router.patch('/admin/users/:id/active', authenticate, authorize('admin'), admin.setUserActive);
router.patch('/admin/users/:id/password', authenticate, authorize('admin'), admin.updateUserPassword);
router.get('/admin/users/:id/password', authenticate, authorize('admin'), admin.getUserPassword);
router.delete('/admin/users/:id', authenticate, authorize('admin'), admin.deleteUser);

// audit
router.get('/admin/audit', authenticate, authorize('admin'), admin.auditLogs);
router.delete('/admin/audit', authenticate, authorize('admin'), admin.deleteAllAudit);

// collections
router.get('/collections', authenticate, authorize('admin', 'operator'), admin.listCollections);
router.post('/collections', authenticate, authorize('admin', 'operator'), admin.createCollection);
router.delete('/collections', authenticate, authorize('admin'), admin.deleteAllCollections);
router.delete('/collections/:id', authenticate, authorize('admin', 'operator'), admin.deleteCollection);

module.exports = router;