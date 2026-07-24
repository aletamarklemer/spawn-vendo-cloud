'use strict';
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { coinGuard } = require('../middleware/coinGuard');

const { authenticate, authorize, deviceAuth } = require('../middleware/auth');
const auth = require('../controllers/auth.controller');
const coin = require('../controllers/coin.controller');
const voucher = require('../controllers/voucher.controller');
const device = require('../controllers/device.controller');
const admin = require('../controllers/admin.controller');
const enforcement = require('../controllers/enforcement.controller');
const portal = require('../controllers/portal.controller');
const script = require('../controllers/script.controller');
const collection = require('../controllers/collection.controller');
const gcash = require('../controllers/gcash.controller');

const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('../config/supabase');

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const coinLimiter  = rateLimit({ windowMs: 60 * 1000, max: 120 });
// Strict limiter para sa voucher redeem — anti brute-force sa voucher codes.
// Lehitimong customer 1-2 ra ka try; 10/min per IP mo-pugong sa code guessing.
const redeemLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

router.get('/config', (req, res) =>
  res.json({ success: true, data: { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY } }));

router.get('/health', (req, res) => res.json({ success: true, data: { status: 'ok', ts: Date.now() } }));

// public - no auth
router.get('/pricing', admin.getPublicPricing);

// --- Portal auto-update ---
// Router polls /version (lightweight) ug pulls /latest (deviceAuth).
// Admin mo-publish via PUT /portal (JSON). Router mo-publish via POST /portal/raw (raw html).
const express = require('express');
router.get('/portal/version', deviceAuth, portal.version);
router.get('/portal/latest',  deviceAuth, portal.latest);
router.get('/portal/latest-raw', deviceAuth, portal.latestRaw);
router.get('/portal',         authenticate, authorize('admin'), portal.getMeta);
router.put('/portal',         authenticate, authorize('admin'), portal.publish);
router.post('/portal/raw',    deviceAuth, express.text({ type: '*/*', limit: '1mb' }), portal.publishRaw);

// --- Router script auto-update ---
router.get('/script/manifest', deviceAuth, script.manifest);
router.get('/script/manifest-raw', deviceAuth, script.manifestRaw);
router.get('/script/:name/raw', deviceAuth, script.getScriptRaw);
router.get('/script/:name',    deviceAuth, script.getScript);
router.get('/script',          authenticate, authorize('admin'), script.listMeta);
router.put('/script',          authenticate, authorize('admin'), script.publish);
router.post('/script/raw',     deviceAuth, express.text({ type: '*/*', limit: '512kb' }), script.publishRaw);

router.post('/auth/login', loginLimiter, auth.login);
router.post('/auth/register', authenticate, authorize('admin'), auth.register);
router.get('/auth/me', authenticate, auth.me);
router.patch('/auth/profile', authenticate, auth.updateProfile);

router.post('/coin/insert', coinLimiter, deviceAuth, coinGuard, coin.insertCoin);
router.post('/coin/portal-insert', coinLimiter, deviceAuth, coinGuard, coin.portalInsert);
router.post('/coin/arm', coinLimiter, coin.armDevice);
router.post('/coin/disarm', coinLimiter, coin.disarmDevice);
router.post('/coin/connect', coinLimiter, coin.requestConnect);
router.get('/coin/session/:mac', coin.getSession);
router.get('/coin/history/:mac', coin.history);
router.post('/coin/session/pause', deviceAuth, coin.pauseSession);
router.post('/coin/session/resume', deviceAuth, coin.resumeSession);
// NOTE: kining duha gitawag sa portal (browser) — DILI mahimong deviceAuth kay
// ang browser walay DEVICE_KEY. Kung WALA NAY pause/resume buttons sa imong
// working portal (automatic na via spawn-enforce.sh), i-DELETE na ni nga 2 ka lines.
// Kung gigamit pa: gibilin nga walay deviceAuth (browser-callable).
// coinLimiter gidugang: public endpoint ni (browser-callable) — anti spam/abuse.
router.post('/coin/session/pause-client', coinLimiter, coin.pauseSession);
router.post('/coin/session/resume-client', coinLimiter, coin.resumeSession);

// enforcement
router.get('/enforcement/allowed', deviceAuth, enforcement.allowedClients);
router.post('/enforcement/resume', deviceAuth, enforcement.resumeClient); // v33 instant auto-connect
router.post('/enforcement/wifi-done', deviceAuth, enforcement.wifiDone);
router.post('/enforcement/wifi-ack', deviceAuth, enforcement.wifiAck);

// vouchers — specific routes BEFORE :id param
router.post('/vouchers/generate', authenticate, authorize('admin'), voucher.generate);
router.post('/vouchers/void', authenticate, authorize('admin'), voucher.voidVoucher);
router.post('/vouchers/redeem', redeemLimiter, voucher.redeem);
router.delete('/vouchers/voided', authenticate, authorize('admin'), voucher.deleteVoidedVouchers);
router.delete('/vouchers/all', authenticate, authorize('admin'), voucher.deleteAllVouchers);
router.get('/vouchers', authenticate, authorize('admin'), voucher.list);
router.delete('/vouchers/:id', authenticate, authorize('admin'), voucher.deleteVoucher);

// --- GCash -> Voucher (self-hosted cashless; no 3rd-party gateway) ---
// Public (portal): create order + poll status. Phone bridge (x-gcash-key): sms/outbox.
router.get('/gcash/status', gcash.getStatus);
router.post('/gcash/order', coinLimiter, gcash.createOrder);
router.get('/gcash/order/:id', gcash.getOrder);
router.post('/gcash/sms', coinLimiter, express.text({ type: 'text/*', limit: '64kb' }), gcash.gcashBridge, gcash.receiveSms);
router.get('/gcash/outbox', gcash.gcashBridge, gcash.getOutbox);
router.post('/gcash/outbox/ack', coinLimiter, gcash.gcashBridge, gcash.ackOutbox);

// devices
router.get('/devices', authenticate, authorize('admin', 'technician', 'operator'), device.list);
router.get('/devices/:id/clients', authenticate, authorize('admin', 'technician', 'operator'), device.clients);
router.get('/devices/:id/wireless', authenticate, authorize('admin', 'technician', 'operator'), device.wireless);
router.post('/devices/:id/wifi-command', authenticate, authorize('admin', 'technician', 'operator'), device.wifiCommand);
router.get('/devices/:id/wifi-commands', authenticate, authorize('admin', 'technician', 'operator'), device.wifiCommands);
router.post('/devices', authenticate, authorize('admin'), device.create);
router.patch('/devices/:id', authenticate, authorize('admin', 'technician', 'operator'), device.update);
router.delete('/devices/:id', authenticate, authorize('admin'), device.remove);
router.post('/devices/heartbeat', deviceAuth, device.heartbeat);
router.get('/devices/speed', deviceAuth, device.getSpeed);
router.get('/devices/armed', deviceAuth, device.armed);

// collections (operator/collector cash tracking) — view + collect + history, TANAN vendo
router.get('/collections/summary', authenticate, authorize('admin', 'technician', 'operator'), collection.summary);
router.get('/collections/history', authenticate, authorize('admin', 'technician', 'operator'), collection.history);
router.post('/collections',        authenticate, authorize('admin', 'technician', 'operator'), collection.create);
router.get('/collections/totals',   authenticate, authorize('admin', 'technician', 'operator'), collection.totals);

// maintenance
router.get('/maintenance', authenticate, authorize('admin', 'technician'), device.listMaintenance);
router.post('/maintenance', authenticate, authorize('admin', 'technician'), device.createMaintenance);
router.patch('/maintenance/:id', authenticate, authorize('admin', 'technician'), device.resolveMaintenance);

// admin stats & revenue
router.get('/admin/stats', authenticate, authorize('admin', 'operator', 'technician'), admin.stats);
router.get('/admin/revenue', authenticate, authorize('admin'), admin.revenueSeries);

// transactions
router.get('/admin/transactions', authenticate, authorize('admin', 'operator'), admin.transactions);
router.get('/admin/vendo-income', authenticate, authorize('admin', 'operator'), admin.vendoIncome);
router.delete('/admin/transactions', authenticate, authorize('admin'), admin.deleteAllTransactions);
router.delete('/admin/transactions/device/:deviceId', authenticate, authorize('admin'), admin.deleteDeviceTransactions);
router.delete('/admin/transactions/:id', authenticate, authorize('admin'), admin.deleteTransaction);

// sessions
router.get('/admin/sessions', authenticate, authorize('admin', 'operator', 'technician'), admin.listSessions);
router.delete('/admin/sessions/expired', authenticate, authorize('admin'), admin.deleteExpiredSessions);
router.delete('/admin/sessions/:id', authenticate, authorize('admin'), admin.deleteSession);

// settings
router.get('/admin/settings', authenticate, authorize('admin'), admin.getSettings);
router.put('/admin/settings', authenticate, authorize('admin'), admin.updateSettings);

// pricing tiers
router.get('/admin/pricing-tiers', authenticate, authorize('admin', 'technician', 'operator'), admin.getPricingTiers);
router.put('/admin/pricing-tiers', authenticate, authorize('admin', 'technician', 'operator'), admin.savePricingTiers);

// users
router.get('/admin/users', authenticate, authorize('admin'), admin.listUsers);
router.patch('/admin/users/:id/active', authenticate, authorize('admin'), admin.setUserActive);
router.patch('/admin/users/:id/role', authenticate, authorize('admin'), admin.setUserRole);
router.patch('/admin/users/:id/password', authenticate, authorize('admin'), admin.updateUserPassword);
router.get('/admin/users/:id/password', authenticate, authorize('admin'), admin.getUserPassword);
router.delete('/admin/users/:id', authenticate, authorize('admin'), admin.deleteUser);

// audit
router.get('/admin/audit', authenticate, authorize('admin'), admin.auditLogs);
router.delete('/admin/audit', authenticate, authorize('admin'), admin.deleteAllAudit);


module.exports = router;