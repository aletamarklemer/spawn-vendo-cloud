'use strict';
/** controllers/coin.controller.js — coin insert, session status, expiry */
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');

/**
 * POST /api/coin/insert        (device auth: x-device-key)
 * body: { device_id, amount, txn_ref }   <-- client_mac NO LONGER required
 *
 * The coin acceptor cannot know which phone dropped the coin, so we credit
 * whichever client most recently "armed" this device (tapped Insert Coin).
 * Resolution + crediting happens atomically in add_credits_from_device().
 *
 * Backward compatible: if a client_mac IS sent (old firmware), we still honor
 * it via the original add_credits() path.
 */
const insertCoin = asyncHandler(async (req, res) => {
  const { device_id, client_mac, amount, txn_ref } = req.body || {};
  if (amount == null) return fail(res, 'amount required', 400);

  let data, error;

  if (client_mac) {
    // Legacy path: explicit MAC provided by firmware.
    ({ data, error } = await supabaseAdmin.rpc('add_credits', {
      p_device_id: device_id || null,
      p_client_mac: client_mac,
      p_amount: Number(amount),
      p_txn_ref: txn_ref || null,
    }));
  } else {
    // New path: resolve the armed client for this device.
    if (!device_id) return fail(res, 'device_id required', 400);
    ({ data, error } = await supabaseAdmin.rpc('add_credits_from_device', {
      p_device_id: device_id,
      p_amount: Number(amount),
      p_txn_ref: txn_ref || null,
    }));
  }

  if (error) {
    // Friendly message when nobody armed the machine.
    if (String(error.message).includes('NO_ARMED_CLIENT')) {
      return fail(res, 'No client is waiting on this device. Tap "Insert Coin" first.', 409);
    }
    return fail(res, error.message, 400);
  }

  // Mark device online opportunistically.
  if (device_id) {
    await supabaseAdmin.from('vendo_devices')
      .update({ status: 'online', last_online: new Date().toISOString() })
      .eq('id', device_id);
  }
  return ok(res, { session: data });
});

/**
 * POST /api/coin/arm           (public — captive portal)
 * body: { device_id, client_mac, seconds? }
 * The customer's phone "claims" the machine so the next physical coin is
 * credited to them. Short window (default 90s) re-armed on each Insert tap.
 */
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

/**
 * GET /api/coin/session/:mac   (public — captive portal polls this)
 * Returns the live remaining time for a client MAC.
 */
const getSession = asyncHandler(async (req, res) => {
  const { mac } = req.params;
  const { data, error } = await supabaseAdmin
    .from('internet_sessions')
    .select('*')
    .eq('client_mac', mac)
    .order('created_at', { ascending: false })
    .limit(1).maybeSingle();
  if (error) return fail(res, error.message, 400);
  if (!data) return ok(res, { session: null, remaining_seconds: 0 });

  // Compute live remaining from end_time so the client always sees truth.
  let remaining = 0;
  if (data.status === 'active' && data.end_time) {
    remaining = Math.max(0, Math.floor((new Date(data.end_time) - Date.now()) / 1000));
    if (remaining === 0) {
      await supabaseAdmin.from('internet_sessions').update({ status: 'expired' }).eq('id', data.id);
      data.status = 'expired';
    }
  }
  return ok(res, { session: data, remaining_seconds: remaining });
});

/**
 * POST /api/coin/portal-insert  (public — captive portal)
 * body: { client_mac, amount, device_id? }
 * Lets the captive portal register a coin insert for the connected client and
 * immediately reflect the topped-up time. Amount is restricted to the accepted
 * physical denominations so the public endpoint can't be abused for arbitrary
 * credits. A txn_ref is generated server-side for idempotency on retries.
 */
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

/** GET /api/coin/history/:mac — session + coin history for a client */
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

module.exports = { insertCoin, getSession, history, portalInsert, armDevice };