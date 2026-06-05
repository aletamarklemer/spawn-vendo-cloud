'use strict';
/** controllers/admin.controller.js — analytics, settings, users, collections */
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');
const audit = require('../services/audit.service');

function sinceISO(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

/** GET /api/admin/stats — headline dashboard numbers */
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

/** GET /api/admin/revenue?range=daily|weekly|monthly — series for charts */
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
    .select('*, vendo_devices(device_name)').order('created_at', { ascending: false }).limit(200);
  if (error) return fail(res, error.message, 400);
  return ok(res, { transactions: data });
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

// ---- collections ----
const listCollections = asyncHandler(async (req, res) => {
  let q = supabaseAdmin.from('collections')
    .select('*, vendo_devices(device_name), profiles(full_name)')
    .order('collection_date', { ascending: false });
  if (req.user.role === 'operator') q = q.eq('operator_id', req.user.sub);
  const { data, error } = await q;
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

/** GET /api/admin/audit */
const auditLogs = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('audit_logs')
    .select('*, profiles(full_name, email)').order('created_at', { ascending: false }).limit(200);
  if (error) return fail(res, error.message, 400);
  return ok(res, { logs: data });
});

module.exports = {
  stats, revenueSeries, transactions,
  getSettings, updateSettings,
  listUsers, setUserActive,
  listCollections, createCollection,
  auditLogs,
};
