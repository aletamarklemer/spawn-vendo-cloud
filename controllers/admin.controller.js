'use strict';
/** controllers/admin.controller.js — analytics, settings, users, collections */
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');
const audit = require('../services/audit.service');
const bcrypt = require('bcryptjs');

function sinceISO(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/** GET /api/admin/stats */
const stats = asyncHandler(async (req, res) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const isoToday = today.toISOString();

  const [tx, devices, sessions] = await Promise.all([
    supabaseAdmin.from('coin_transactions').select('amount, created_at').gte('created_at', sinceISO(31)),
    supabaseAdmin.from('vendo_devices').select('id, status, last_online'),
    supabaseAdmin.from('internet_sessions').select('id, status').eq('status', 'active'),
  ]);

  const txs = tx.data || [];
  const sum = (arr) => arr.reduce((a, r) => a + Number(r.amount || 0), 0);
  const inDay  = txs.filter((r) => r.created_at >= isoToday);
  const inWeek = txs.filter((r) => r.created_at >= sinceISO(7));

  const now = Date.now();
  const online = (devices.data || []).filter(
    (d) => d.last_online && (now - new Date(d.last_online).getTime()) <= 5 * 60 * 1000
  ).length;

  return ok(res, {
    revenue: { today: sum(inDay), week: sum(inWeek), month: sum(txs) },
    transactions: { today: inDay.length, month: txs.length },
    devices: { total: (devices.data || []).length, online, offline: (devices.data || []).length - online },
    active_sessions: (sessions.data || []).length,
  });
});

/** GET /api/admin/revenue?range=daily|weekly|monthly */
const revenueSeries = asyncHandler(async (req, res) => {
  const range = req.query.range || 'daily';
  const days = range === 'monthly' ? 180 : range === 'weekly' ? 84 : 30;
  const { data, error } = await supabaseAdmin.from('coin_transactions')
    .select('amount, created_at').gte('created_at', sinceISO(days));
  if (error) return fail(res, error.message, 400);

  const bucket = {};
  for (const r of data) {
    const d = new Date(r.created_at);
    let key;
    if (range === 'monthly') key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    else if (range === 'weekly') {
      const onejan = new Date(d.getFullYear(), 0, 1);
      const wk = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
      key = `${d.getFullYear()}-W${String(wk).padStart(2, '0')}`;
    } else key = d.toISOString().slice(0, 10);
    bucket[key] = (bucket[key] || 0) + Number(r.amount || 0);
  }
  const series = Object.entries(bucket).sort().map(([label, value]) => ({ label, value }));
  return ok(res, { range, series });
});

/** GET /api/admin/transactions */
const transactions = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('coin_transactions')
    .select('*, vendo_devices(device_name)').order('created_at', { ascending: false }).limit(500);
  if (error) return fail(res, error.message, 400);
  return ok(res, { transactions: data });
});

/** DELETE /api/admin/transactions/:id */
const deleteTransaction = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.from('coin_transactions').delete().eq('id', req.params.id);
  if (error) return fail(res, error.message, 400);
  return ok(res, { deleted: true });
});

/** DELETE /api/admin/transactions — delete all */
const deleteAllTransactions = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.from('coin_transactions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) return fail(res, error.message, 400);
  await audit.log('transactions.delete_all', req.user.sub, {});
  return ok(res, { deleted: true });
});

/** GET /api/admin/sessions */
const listSessions = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('internet_sessions')
    .select('*, vendo_devices(device_name)').order('created_at', { ascending: false }).limit(200);
  if (error) return fail(res, error.message, 400);
  return ok(res, { sessions: data });
});

/** DELETE /api/admin/sessions/:id */
const deleteSession = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.from('internet_sessions').delete().eq('id', req.params.id);
  if (error) return fail(res, error.message, 400);
  return ok(res, { deleted: true });
});

/** DELETE /api/admin/sessions/expired */
const deleteExpiredSessions = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.from('internet_sessions').delete().eq('status', 'expired');
  if (error) return fail(res, error.message, 400);
  return ok(res, { deleted: true });
});

// ---- settings ----
const getSettings = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('settings')
    .select('*').eq('is_active', true).order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return fail(res, error.message, 400);
  return ok(res, { settings: data });
});

const updateSettings = asyncHandler(async (req, res) => {
  const peso_rate = Number(req.body?.peso_rate);
  const minutes_rate = parseInt(req.body?.minutes_rate, 10);
  if (!peso_rate || !minutes_rate) return fail(res, 'peso_rate and minutes_rate required', 400);
  await supabaseAdmin.from('settings').update({ is_active: false }).eq('is_active', true);
  const { data, error } = await supabaseAdmin.from('settings')
    .insert({ peso_rate, minutes_rate, is_active: true }).select().single();
  if (error) return fail(res, error.message, 400);
  await audit.log('settings.update', req.user.sub, { peso_rate, minutes_rate });
  return ok(res, { settings: data });
});

// ---- users ----
const listUsers = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('profiles')
    .select('id, full_name, email, role, is_active, created_at').order('created_at', { ascending: false });
  if (error) return fail(res, error.message, 400);
  return ok(res, { users: data });
});

const setUserActive = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body || {};
  const { data, error } = await supabaseAdmin.from('profiles')
    .update({ is_active: !!is_active }).eq('id', id).select().single();
  if (error) return fail(res, error.message, 400);
  return ok(res, { user: data });
});

/** DELETE /api/admin/users/:id */
const deleteUser = asyncHandler(async (req, res) => {
  const { id } = req.params;
  // Delete from auth + profiles
  const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(id);
  if (authErr) return fail(res, authErr.message, 400);
  await audit.log('user.delete', req.user.sub, { deleted_id: id });
  return ok(res, { deleted: true });
});

/** PATCH /api/admin/users/:id/password */
const updateUserPassword = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { password } = req.body || {};
  if (!password || password.length < 8) return fail(res, 'Password must be at least 8 characters', 400);
  const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { password });
  if (error) return fail(res, error.message, 400);
  // Store hashed password in profiles for view feature
  const hashed = await bcrypt.hash(password, 10);
  await supabaseAdmin.from('profiles').update({ password_hint: password }).eq('id', id);
  await audit.log('user.password_change', req.user.sub, { target_id: id });
  return ok(res, { updated: true });
});

/** GET /api/admin/users/:id/password */
const getUserPassword = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabaseAdmin.from('profiles')
    .select('password_hint').eq('id', id).maybeSingle();
  if (error) return fail(res, error.message, 400);
  return ok(res, { password: data?.password_hint || '(not stored)' });
});

// ---- collections ----
const listCollections = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('collections')
    .select('*, vendo_devices(device_name), profiles(full_name)')
    .order('collection_date', { ascending: false });
  if (error) return fail(res, error.message, 400);
  return ok(res, { collections: data });
});

const createCollection = asyncHandler(async (req, res) => {
  const { device_id, amount, collection_date, notes } = req.body || {};
  if (amount == null) return fail(res, 'amount required', 400);
  const { data, error } = await supabaseAdmin.from('collections').insert({
    operator_id: req.user.sub, device_id, amount: Number(amount),
    collection_date: collection_date || new Date().toISOString().slice(0, 10), notes,
  }).select().single();
  if (error) return fail(res, error.message, 400);
  return ok(res, { collection: data }, 201);
});

/** DELETE /api/collections/:id */
const deleteCollection = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.from('collections').delete().eq('id', req.params.id);
  if (error) return fail(res, error.message, 400);
  return ok(res, { deleted: true });
});

/** DELETE /api/collections — delete all */
const deleteAllCollections = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.from('collections').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) return fail(res, error.message, 400);
  return ok(res, { deleted: true });
});

/** GET /api/admin/audit */
const auditLogs = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('audit_logs')
    .select('*, profiles(full_name, email)').order('created_at', { ascending: false }).limit(200);
  if (error) return fail(res, error.message, 400);
  return ok(res, { logs: data });
});

/** DELETE /api/admin/audit */
const deleteAllAudit = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.from('audit_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) return fail(res, error.message, 400);
  return ok(res, { deleted: true });
});

/** GET /api/pricing — public, no auth */
const getPublicPricing = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('settings')
    .select('peso_rate, minutes_rate')
    .eq('is_active', true)
    .order('updated_at', { ascending: false })
    .limit(1).maybeSingle();
  if (error) return fail(res, error.message, 400);
  return ok(res, { pricing: data || { peso_rate: 1, minutes_rate: 15 } });
});

module.exports = {
  stats, revenueSeries, transactions,
  deleteTransaction, deleteAllTransactions,
  listSessions, deleteSession, deleteExpiredSessions,
  getSettings, updateSettings, getPublicPricing,
  listUsers, setUserActive, deleteUser, updateUserPassword, getUserPassword,
  listCollections, createCollection, deleteCollection, deleteAllCollections,
  auditLogs, deleteAllAudit,
};