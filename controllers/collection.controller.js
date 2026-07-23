'use strict';
/** controllers/collection.controller.js — cash collection (operator/collector)
 *  Ang operator (collector) mo-lantaw sa TANAN nga vendo, mo-"Mark Collected"
 *  (mo-empty sa coin box), ug mo-tan-aw sa history. Ang na-collect nga amount
 *  kay gikwenta SA SERVER (sum sa coin_transactions sukad sa katapusang collect),
 *  DILI gikan sa client — para accurate ug dili ma-tamper. */
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');
const audit = require('../services/audit.service');
const liveness = require('../utils/liveness');

const OFFLINE_AFTER_MS = 5 * 60 * 1000; // parehas sa device.controller

/** GET /api/collections/summary — per-vendo uncollected cash + status (TANAN vendo) */
const summary = asyncHandler(async (req, res) => {
  const [devRes, sumRes] = await Promise.all([
    supabaseAdmin.from('vendo_devices')
      .select('id, device_name, location, area, status, last_online').order('device_name'),
    supabaseAdmin.rpc('get_collection_summary'),
  ]);
  if (devRes.error) return fail(res, devRes.error.message, 400);
  if (sumRes.error) return fail(res, sumRes.error.message, 400);

  const byId = {};
  (sumRes.data || []).forEach((r) => { byId[r.device_id] = r; });

  const now = Date.now();
  let totalUncollected = 0, totalCount = 0;
  const vendos = (devRes.data || []).map((d) => {
    const s = byId[d.id] || {};
    const uncollected = Number(s.uncollected_amount || 0);
    const uncollected_count = Number(s.uncollected_count || 0);
    totalUncollected += uncollected;
    totalCount += uncollected_count;
    const stale = !d.last_online || (now - new Date(d.last_online).getTime()) > OFFLINE_AFTER_MS;
    return {
      device_id: d.id,
      device_name: d.device_name,
      location: d.location,
      area: d.area,
      status: d.status === 'maintenance' ? 'maintenance' : (stale ? 'offline' : 'online'),
      router_online: liveness.routerOnline(d.id),
      uncollected,
      uncollected_count,
      last_collected_at: s.last_collected_at || null,
      last_collected_amount: s.last_collected_amount != null ? Number(s.last_collected_amount) : null,
    };
  });
  vendos.sort((a, b) => b.uncollected - a.uncollected);
  return ok(res, {
    vendos,
    totals: { uncollected: totalUncollected, count: totalCount, vendos: vendos.length },
  });
});

/** POST /api/collections — mark ONE vendo collected (records amount, resets counter).
 *  body: { device_id, notes? }. Amount = SERVER-computed (atomic RPC). */
const create = asyncHandler(async (req, res) => {
  const { device_id, notes } = req.body || {};
  if (!device_id) return fail(res, 'device_id required', 400);

  const { data: dev, error: dErr } = await supabaseAdmin.from('vendo_devices')
    .select('id, device_name').eq('id', device_id).maybeSingle();
  if (dErr) return fail(res, dErr.message, 400);
  if (!dev) return fail(res, 'Vendo not found', 404);

  const { data, error } = await supabaseAdmin.rpc('mark_collected', {
    p_device_id: device_id,
    p_collector: req.user.sub,
    p_notes: notes ? String(notes).slice(0, 500) : null,
  });
  if (error) return fail(res, error.message, 400);
  const row = Array.isArray(data) ? data[0] : data;

  await audit.log('collection.create', req.user.sub, {
    device_id,
    device_name: dev.device_name,
    amount: row ? Number(row.amount) : null,
    txn_count: row ? row.txn_count : null,
  }, req);
  return ok(res, { collection: row }, 201);
});

/** GET /api/collections/history — recent collections (TANAN vendo), optional ?device_id */
const history = asyncHandler(async (req, res) => {
  let q = supabaseAdmin.from('collections')
    .select('*, vendo_devices(device_name, location), profiles(full_name, email)')
    .order('collected_at', { ascending: false }).limit(2000);
  if (req.query.device_id) q = q.eq('device_id', req.query.device_id);
  const { data, error } = await q;
  if (error) return fail(res, error.message, 400);
  return ok(res, { collections: data || [] });
});

/** GET /api/collections/totals — all-time collected amount + coins + #collections */
const totals = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.rpc('get_collected_totals');
  if (error) return fail(res, error.message, 400);
  const r = Array.isArray(data) ? data[0] : data;
  return ok(res, { totals: r || { total_amount: 0, total_coins: 0, collections_count: 0 } });
});

module.exports = { summary, create, history, totals };
