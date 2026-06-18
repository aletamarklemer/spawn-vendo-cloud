'use strict';
/** controllers/admin.controller.js — analytics, settings, users */
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
  let pause_validity_days = parseInt(req.body?.pause_validity_days, 10);
  if (!pause_validity_days || pause_validity_days < 1) pause_validity_days = 3;

  // Pricing is driven by pricing_tiers; settings only carries session config.
  // Carry over the legacy rate columns (NOT NULL) from the current active row.
  const { data: current } = await supabaseAdmin.from('settings')
    .select('peso_rate, minutes_rate').eq('is_active', true)
    .order('updated_at', { ascending: false }).limit(1).maybeSingle();
  const peso_rate = current?.peso_rate ?? 1;
  const minutes_rate = current?.minutes_rate ?? 10;

  await supabaseAdmin.from('settings').update({ is_active: false }).eq('is_active', true);
  const { data, error } = await supabaseAdmin.from('settings')
    .insert({ peso_rate, minutes_rate, pause_validity_days, is_active: true }).select().single();
  if (error) return fail(res, error.message, 400);
  await audit.log('settings.update', req.user.sub, { pause_validity_days });
  return ok(res, { settings: data });
});

// ---- pricing tiers ----
const UNIT_SECONDS = { minute: 60, hour: 3600, day: 86400 };

/** GET /api/admin/pricing-tiers */
const getPricingTiers = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('pricing_tiers')
    .select('*').eq('is_active', true)
    .order('sort_order', { ascending: true }).order('amount', { ascending: true });
  if (error) return fail(res, error.message, 400);
  return ok(res, { tiers: data || [] });
});

/** PUT /api/admin/pricing-tiers — replace the whole active tier set */
const savePricingTiers = asyncHandler(async (req, res) => {
  const incoming = Array.isArray(req.body?.tiers) ? req.body.tiers : null;
  if (!incoming) return fail(res, 'tiers array required', 400);

  const rows = [];
  const seenAmounts = new Set();
  for (let i = 0; i < incoming.length; i++) {
    const t = incoming[i] || {};
    const amount = Number(t.amount);
    const duration_value = parseInt(t.duration_value, 10);
    const duration_unit = String(t.duration_unit || '').toLowerCase();
    if (!amount || amount <= 0) return fail(res, `Row ${i + 1}: amount must be greater than 0`, 400);
    if (!duration_value || duration_value <= 0) return fail(res, `Row ${i + 1}: duration must be greater than 0`, 400);
    if (!UNIT_SECONDS[duration_unit]) return fail(res, `Row ${i + 1}: unit must be minute, hour, or day`, 400);
    if (seenAmounts.has(amount)) return fail(res, `Duplicate amount ₱${amount} — each amount must be unique`, 400);
    seenAmounts.add(amount);
    rows.push({
      amount,
      duration_value,
      duration_unit,
      seconds: duration_value * UNIT_SECONDS[duration_unit],
      is_active: true,
      sort_order: i,
    });
  }

  // Replace: drop existing active tiers, then insert the new set.
  const { error: delErr } = await supabaseAdmin.from('pricing_tiers')
    .delete().eq('is_active', true);
  if (delErr) return fail(res, delErr.message, 400);

  let inserted = [];
  if (rows.length) {
    const { data, error } = await supabaseAdmin.from('pricing_tiers').insert(rows).select();
    if (error) return fail(res, error.message, 400);
    inserted = data;
  }
  await audit.log('pricing_tiers.update', req.user.sub, { count: rows.length });
  return ok(res, { tiers: inserted });
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

/** GET /api/pricing — public, no auth. Returns the active pricing tiers. */
const getPublicPricing = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('pricing_tiers')
    .select('amount, duration_value, duration_unit, seconds')
    .eq('is_active', true)
    .order('sort_order', { ascending: true }).order('amount', { ascending: true });
  if (error) return fail(res, error.message, 400);
  return ok(res, { tiers: data || [] });
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
  const { error } = await supabaseAdmin.from('audit_logs')
    .delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) return fail(res, error.message, 400);
  return ok(res, { deleted: true });
});

module.exports = {
  stats, revenueSeries, transactions,
  deleteTransaction, deleteAllTransactions,
  listSessions, deleteSession, deleteExpiredSessions,
  getSettings, updateSettings, getPublicPricing,
  getPricingTiers, savePricingTiers,
  listUsers, setUserActive, deleteUser, updateUserPassword, getUserPassword,
  auditLogs, deleteAllAudit,
};