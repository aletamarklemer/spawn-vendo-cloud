'use strict';
/** controllers/coin.controller.js — coin insert, session status, expiry */
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');

const insertCoin = asyncHandler(async (req, res) => {
  const { device_id, client_mac, amount, txn_ref } = req.body || {};
  if (amount == null) return fail(res, 'amount required', 400);

  let data, error;

  if (client_mac) {
    ({ data, error } = await supabaseAdmin.rpc('add_credits', {
      p_device_id: device_id || null,
      p_client_mac: client_mac,
      p_amount: Number(amount),
      p_txn_ref: txn_ref || null,
    }));
  } else {
    if (!device_id) return fail(res, 'device_id required', 400);
    ({ data, error } = await supabaseAdmin.rpc('add_credits_from_device', {
      p_device_id: device_id,
      p_amount: Number(amount),
      p_txn_ref: txn_ref || null,
    }));
  }

  if (error) {
    if (String(error.message).includes('NO_ARMED_CLIENT')) {
      return fail(res, 'No client is waiting on this device. Tap "Insert Coin" first.', 409);
    }
    return fail(res, error.message, 400);
  }

  if (device_id) {
    await supabaseAdmin.from('vendo_devices')
      .update({ status: 'online', last_online: new Date().toISOString() })
      .eq('id', device_id);
  }
  return ok(res, { session: data });
});

const armDevice = asyncHandler(async (req, res) => {
  const { device_id, client_mac, seconds } = req.body || {};
  if (!device_id || !client_mac) return fail(res, 'device_id and client_mac required', 400);

  const { data, error } = await supabaseAdmin.rpc('arm_device', {
    p_device_id: device_id,
    p_client_mac: client_mac,
    p_seconds: seconds ? Number(seconds) : 90,
  });
  if (error) return fail(res, error.message, 400);
  return ok(res, { arm: data });
});

const getSession = asyncHandler(async (req, res) => {
  const { mac } = req.params;

  // Try exact match first (active or paused)
  let { data, error } = await supabaseAdmin
    .from('internet_sessions')
    .select('*')
    .eq('client_mac', mac)
    .in('status', ['active', 'paused'])
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle();

  if (error) return fail(res, error.message, 400);

  // If not found and IP-based, try matching same IP
  if (!data && mac.startsWith('IP:')) {
    const { data: d2 } = await supabaseAdmin
      .from('internet_sessions')
      .select('*')
      .like('client_mac', mac)
      .in('status', ['active', 'paused'])
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();
    if (d2) data = d2;
  }

  // Fallback: any status for display
  if (!data) {
    const { data: d3 } = await supabaseAdmin
      .from('internet_sessions')
      .select('*')
      .eq('client_mac', mac)
      .order('created_at', { ascending: false })
      .limit(1).maybeSingle();
    if (d3) data = d3;
  }

  if (!data) return ok(res, { session: null, remaining_seconds: 0 });

  let remaining = 0;
  if (data.status === 'active' && data.end_time) {
    remaining = Math.max(0, Math.floor((new Date(data.end_time) - Date.now()) / 1000));
    if (remaining === 0) {
      await supabaseAdmin.from('internet_sessions').update({ status: 'expired' }).eq('id', data.id);
      data.status = 'expired';
    }
  } else if (data.status === 'paused') {
    remaining = data.remaining_seconds || 0;
  }

  return ok(res, { session: data, remaining_seconds: remaining });
});

/** POST /api/coin/session/pause  (device auth) */
const pauseSession = asyncHandler(async (req, res) => {
  const { client_mac } = req.body || {};
  if (!client_mac) return fail(res, 'client_mac required', 400);

  // Find active session
  const { data, error } = await supabaseAdmin
    .from('internet_sessions')
    .select('*')
    .eq('client_mac', client_mac)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle();

  if (error) return fail(res, error.message, 400);
  if (!data) return ok(res, { paused: false, message: 'No active session' });

  // Calculate remaining seconds from end_time
  const remaining = Math.max(0, Math.floor((new Date(data.end_time) - Date.now()) / 1000));
  if (remaining === 0) return ok(res, { paused: false, message: 'Session already expired' });

  // Pause: save remaining, clear end_time
  const { error: updateErr } = await supabaseAdmin
    .from('internet_sessions')
    .update({ status: 'paused', remaining_seconds: remaining, end_time: null })
    .eq('id', data.id);

  if (updateErr) return fail(res, updateErr.message, 400);
  return ok(res, { paused: true, remaining_seconds: remaining });
});

/** POST /api/coin/session/resume  (device auth) */
const resumeSession = asyncHandler(async (req, res) => {
  const { client_mac } = req.body || {};
  if (!client_mac) return fail(res, 'client_mac required', 400);

  // Find paused session
  const { data, error } = await supabaseAdmin
    .from('internet_sessions')
    .select('*')
    .eq('client_mac', client_mac)
    .eq('status', 'paused')
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle();

  if (error) return fail(res, error.message, 400);
  if (!data) return ok(res, { resumed: false, message: 'No paused session' });

  const remaining = data.remaining_seconds || 0;
  if (remaining === 0) {
    await supabaseAdmin.from('internet_sessions').update({ status: 'expired' }).eq('id', data.id);
    return ok(res, { resumed: false, message: 'Session expired' });
  }

  // Resume: set new end_time
  const newEndTime = new Date(Date.now() + remaining * 1000).toISOString();
  const { error: updateErr } = await supabaseAdmin
    .from('internet_sessions')
    .update({ status: 'active', end_time: newEndTime })
    .eq('id', data.id);

  if (updateErr) return fail(res, updateErr.message, 400);
  return ok(res, { resumed: true, remaining_seconds: remaining });
});

const ACCEPTED_DENOMS = [1, 5, 10, 15, 20];

const portalInsert = asyncHandler(async (req, res) => {
  const { client_mac, amount, device_id } = req.body || {};
  if (!client_mac) return fail(res, 'client_mac required', 400);

  const amt = Number(amount);
  if (!ACCEPTED_DENOMS.includes(amt)) {
    return fail(res, `amount must be one of ₱${ACCEPTED_DENOMS.join(', ₱')}`, 400);
  }

  const txn_ref = `PORTAL-${client_mac}-${Date.now()}`;

  const { data, error } = await supabaseAdmin.rpc('add_credits', {
    p_device_id: device_id || null,
    p_client_mac: client_mac,
    p_amount: amt,
    p_txn_ref: txn_ref,
  });
  if (error) return fail(res, error.message, 400);

  let remaining = 0;
  if (data && data.end_time) {
    remaining = Math.max(0, Math.floor((new Date(data.end_time) - Date.now()) / 1000));
  }
  return ok(res, { session: data, remaining_seconds: remaining });
});

const history = asyncHandler(async (req, res) => {
  const { mac } = req.params;
  const [{ data: sessions }, { data: coins }] = await Promise.all([
    supabaseAdmin.from('internet_sessions').select('*')
      .eq('client_mac', mac).order('created_at', { ascending: false }).limit(20),
    supabaseAdmin.from('coin_transactions').select('*')
      .eq('client_mac', mac).order('created_at', { ascending: false }).limit(20),
  ]);
  return ok(res, { sessions: sessions || [], coins: coins || [] });
});

module.exports = { insertCoin, getSession, history, portalInsert, armDevice, pauseSession, resumeSession };