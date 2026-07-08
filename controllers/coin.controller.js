'use strict';
/** controllers/coin.controller.js — coin insert, session status, expiry */
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');

// Fetch pause validity in milliseconds from settings (default 3 days)
// CACHED para dili mag-DB-query kada tawag (portal nag-poll matag 1.5-3s).
// Cache TTL: 60 segundo — kung mag-change ang validity, ma-apply sulod sa 1 min.
let _validityCache = { ms: null, at: 0 };
async function getValidityMs() {
  const now = Date.now();
  // Gamita ang cache kung bag-o pa (sulod sa 60s)
  if (_validityCache.ms !== null && (now - _validityCache.at) < 60000) {
    return _validityCache.ms;
  }
  try {
    const { data } = await supabaseAdmin
      .from('settings').select('pause_validity_days')
      .eq('is_active', true).order('updated_at', { ascending: false })
      .limit(1).maybeSingle();
    const days = (data && data.pause_validity_days) || 3;
    const ms = days * 24 * 60 * 60 * 1000;
    _validityCache = { ms, at: now };  // i-save sa cache
    return ms;
  } catch (e) {
    // Kung naa cache (bisan luma), gamita; kung wala, default 3 days
    if (_validityCache.ms !== null) return _validityCache.ms;
    return 3 * 24 * 60 * 60 * 1000;
  }
}


// Abuse-protection config (threshold + ban seconds) from settings.
// CACHED 60s para dili mag-DB-query kada arm (portal mo-tap = mo-arm).
let _abuseCfgCache = { threshold: null, banSeconds: null, at: 0 };
async function getAbuseConfig() {
  const now = Date.now();
  if (_abuseCfgCache.threshold !== null && (now - _abuseCfgCache.at) < 60000) {
    return _abuseCfgCache;
  }
  try {
    const { data } = await supabaseAdmin
      .from('settings').select('coin_abuse_threshold, coin_ban_seconds')
      .eq('is_active', true).order('updated_at', { ascending: false })
      .limit(1).maybeSingle();
    const threshold = (data && data.coin_abuse_threshold) || 5;
    const banSeconds = (data && data.coin_ban_seconds) || 60;
    _abuseCfgCache = { threshold, banSeconds, at: now };
    return _abuseCfgCache;
  } catch (e) {
    if (_abuseCfgCache.threshold !== null) return _abuseCfgCache;
    return { threshold: 5, banSeconds: 60, at: now };
  }
}

// Idle window: kung mo-hunong og tap ang user og ganiini ka-dugay, i-reset
// ang counter (para dili ma-ban ang tawo nga nag-tap 5x sa tibuok adlaw).
const ABUSE_IDLE_RESET_MS = 3 * 60 * 1000; // 3 minutes

// Reset abuse counter para sa client (gitawag kung successful ang coin insert).
async function resetAbuseCounter(client_mac) {
  if (!client_mac) return;
  try {
    await supabaseAdmin.from('coin_abuse_tracking')
      .update({ tap_count: 0, banned_until: null, updated_at: new Date().toISOString() })
      .eq('client_mac', client_mac);
  } catch (e) { /* non-fatal */ }
}

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
    if (String(error.message).includes('NO_PRICING_TIER')) {
      return fail(res, `No pricing tier for ₱${amount}.`, 400);
    }
    return fail(res, error.message, 400);
  }

  if (device_id) {
    await supabaseAdmin.from('vendo_devices')
      .update({ status: 'online', last_online: new Date().toISOString() })
      .eq('id', device_id);
  }
  // Successful coin insert = dili abuse. Reset ang counter.
  if (client_mac) await resetAbuseCounter(client_mac);
  return ok(res, { session: data });
});

const armDevice = asyncHandler(async (req, res) => {
  const { device_id, client_mac, seconds, device_info } = req.body || {};
  if (!device_id || !client_mac) return fail(res, 'device_id and client_mac required', 400);

  // ---- Insert-coin button abuse protection ----
  // Kung mo-tap og sobra sa threshold nga walay coin, i-ban sulod sa ban_seconds.
  const { threshold, banSeconds } = await getAbuseConfig();
  const nowMs = Date.now();
  try {
    const { data: track } = await supabaseAdmin.from('coin_abuse_tracking')
      .select('*').eq('device_id', device_id).eq('client_mac', client_mac).maybeSingle();

    // Naka-ban pa ba?
    if (track && track.banned_until && new Date(track.banned_until).getTime() > nowMs) {
      const secsLeft = Math.ceil((new Date(track.banned_until).getTime() - nowMs) / 1000);
      return fail(res, `BANNED:${secsLeft}`, 429);
    }

    // Idle reset O post-ban reset: kung dugay na ang last tap, O kung naay
    // ban nga EXPIRED na, sugod balik sa counter (0). Kini ang nag-ayo sa
    // "dili mo-enable balik" bug — human mo-expire ang ban, limpyo ang counter.
    let count = (track && track.tap_count) || 0;
    const idleExpired = track && track.last_tap_at &&
        (nowMs - new Date(track.last_tap_at).getTime()) > ABUSE_IDLE_RESET_MS;
    const banExpired = track && track.banned_until &&
        new Date(track.banned_until).getTime() <= nowMs;
    if (idleExpired || banExpired) {
      count = 0;
    }
    count = count + 1;

    // Sobra na sa threshold? I-ban.
    if (count >= threshold) {
      const bannedUntil = new Date(nowMs + banSeconds * 1000).toISOString();
      await supabaseAdmin.from('coin_abuse_tracking').upsert({
        device_id, client_mac, tap_count: count, last_tap_at: new Date().toISOString(),
        banned_until: bannedUntil, updated_at: new Date().toISOString(),
      }, { onConflict: 'device_id,client_mac' });
      return fail(res, `BANNED:${banSeconds}`, 429);
    }

    // Wala pa maabot ang threshold — i-record ang tap
    await supabaseAdmin.from('coin_abuse_tracking').upsert({
      device_id, client_mac, tap_count: count, last_tap_at: new Date().toISOString(),
      banned_until: null, updated_at: new Date().toISOString(),
    }, { onConflict: 'device_id,client_mac' });
  } catch (e) {
    // Non-fatal: kung mafail ang tracking, padayon gihapon ang arm (fail-open,
    // para dili maguba ang coin flow kung naay DB hiccup)
  }

  const { data, error } = await supabaseAdmin.rpc('arm_device', {
    p_device_id: device_id,
    p_client_mac: client_mac,
    p_seconds: seconds ? Number(seconds) : 90,
    p_device_info: device_info || null,
  });
  if (error) return fail(res, error.message, 400);
  return ok(res, { arm: data });
});

/** POST /api/coin/disarm  (no auth — captive portal client)
 *  Instant cancel sa arming. Gi-call sa portal kung mag-tap Cancel o
 *  mo-close sa coin-waiting. Para dili modawat ug coin human ma-cancel.
 */
const disarmDevice = asyncHandler(async (req, res) => {
  const { device_id, client_mac } = req.body || {};
  if (!device_id) return fail(res, 'device_id required', 400);
  const { error } = await supabaseAdmin.rpc('disarm_device', {
    p_device_id: device_id,
    p_client_mac: client_mac || null,
  });
  if (error) return fail(res, error.message, 400);
  return ok(res, { disarmed: true });
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
    // Validity deadline: GIKAN SA MANUAL PAUSE LANG (manual_paused_at).
    // Kung walay manual pause, normal session ra (base sa end_time).
    const VALIDITY_MS = await getValidityMs();
    if (data.manual_paused_at && (Date.now() - new Date(data.manual_paused_at).getTime() > VALIDITY_MS)) {
      await supabaseAdmin.from('internet_sessions').update({ status: 'expired' }).eq('id', data.id);
      data.status = 'expired';
      remaining = 0;
    } else {
      remaining = Math.max(0, Math.floor((new Date(data.end_time) - Date.now()) / 1000));
      if (remaining === 0) {
        await supabaseAdmin.from('internet_sessions').update({ status: 'expired' }).eq('id', data.id);
        data.status = 'expired';
      }
    }
  } else if (data.status === 'paused') {
    // Validity check: manual pause lang
    const VALIDITY_MS = await getValidityMs();
    if (data.manual_paused_at && (Date.now() - new Date(data.manual_paused_at).getTime() > VALIDITY_MS)) {
      await supabaseAdmin.from('internet_sessions').update({ status: 'expired' }).eq('id', data.id);
      data.status = 'expired';
      remaining = 0;
    } else {
      remaining = data.remaining_seconds || 0;
    }
  }

  // Pause-validity info para sa portal display: kanus-a ra taman ang time
  // human sa MANUAL pause (clock = manual_paused_at + pause_validity_days).
  const VMS = await getValidityMs();
  const validity_days = Math.round(VMS / 86400000);
  let pause_valid_until = null;
  if (data.manual_paused_at && (data.status === 'active' || data.status === 'paused')) {
    pause_valid_until = new Date(new Date(data.manual_paused_at).getTime() + VMS).toISOString();
  }

  return ok(res, { session: data, remaining_seconds: remaining, pause_valid_until, validity_days });
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

  // If less than 10 seconds left, expire instead of pause
  if (remaining <= 10) {
    await supabaseAdmin.from('internet_sessions').update({ status: 'expired' }).eq('id', data.id);
    return ok(res, { paused: false, message: 'Session expired' });
  }

  // Check validity from MANUAL pause lang (kung wala pa na-manual-pause, dili mag-expire)
  const VALIDITY_MS = await getValidityMs();
  if (data.manual_paused_at && (Date.now() - new Date(data.manual_paused_at).getTime() > VALIDITY_MS)) {
    await supabaseAdmin.from('internet_sessions').update({ status: 'expired' }).eq('id', data.id);
    return ok(res, { paused: false, message: 'Session expired (validity reached)' });
  }

  // Pause: save remaining, clear end_time.
  // manual_paused_at i-set LANG kung manual pause (gikan sa portal button),
  // DILI sa auto-pause (WiFi disconnect). Kini ang basehan sa validity.
  const pauseUpdate = { status: 'paused', remaining_seconds: remaining, end_time: null };
  if (!data.first_paused_at) pauseUpdate.first_paused_at = new Date().toISOString();
  // Manual pause flag: set manual_paused_at kung wala pa
  if (req.body && req.body.manual === true && !data.manual_paused_at) {
    pauseUpdate.manual_paused_at = new Date().toISOString();
  }

  const { error: updateErr } = await supabaseAdmin
    .from('internet_sessions')
    .update(pauseUpdate)
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
  if (remaining <= 10) {
    // Too little time left — expire instead of resuming
    await supabaseAdmin.from('internet_sessions').update({ status: 'expired' }).eq('id', data.id);
    return ok(res, { resumed: false, message: 'Session expired' });
  }

  // Check validity from MANUAL pause lang
  const VALIDITY_MS = await getValidityMs();
  if (data.manual_paused_at && (Date.now() - new Date(data.manual_paused_at).getTime() > VALIDITY_MS)) {
    await supabaseAdmin.from('internet_sessions').update({ status: 'expired' }).eq('id', data.id);
    return ok(res, { resumed: false, message: 'Session expired (validity reached)' });
  }

  // Resume: set new end_time + auto-connect (connect_requested = true)
  const newEndTime = new Date(Date.now() + remaining * 1000).toISOString();
  const { error: updateErr } = await supabaseAdmin
    .from('internet_sessions')
    .update({ status: 'active', end_time: newEndTime, connect_requested: true })
    .eq('id', data.id);

  if (updateErr) return fail(res, updateErr.message, 400);
  return ok(res, { resumed: true, remaining_seconds: remaining });
});

// Accepted amounts come from the active pricing tiers.
async function getAcceptedAmounts() {
  const { data } = await supabaseAdmin.from('pricing_tiers')
    .select('amount').eq('is_active', true);
  return (data || []).map((r) => Number(r.amount));
}

const portalInsert = asyncHandler(async (req, res) => {
  const { client_mac, amount, device_id } = req.body || {};
  if (!client_mac) return fail(res, 'client_mac required', 400);

  const amt = Number(amount);
  const accepted = await getAcceptedAmounts();
  if (!accepted.length) {
    return fail(res, 'No pricing tiers configured. Please set rates in the admin panel.', 400);
  }
  if (!accepted.includes(amt)) {
    return fail(res, `amount must be one of ₱${accepted.join(', ₱')}`, 400);
  }

  const txn_ref = `PORTAL-${client_mac}-${Date.now()}`;

  const { data, error } = await supabaseAdmin.rpc('add_credits', {
    p_device_id: device_id || null,
    p_client_mac: client_mac,
    p_amount: amt,
    p_txn_ref: txn_ref,
  });
  if (error) {
    if (String(error.message).includes('NO_PRICING_TIER')) {
      return fail(res, `No pricing tier for ₱${amt}.`, 400);
    }
    return fail(res, error.message, 400);
  }

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

/** POST /api/coin/connect — customer tapped "Connect Now" or countdown expired.
 *  Sets connect_requested=true so spawn-enforce.sh will auth this client.
 *  Browser-callable (portal), so NO deviceAuth. */
const requestConnect = asyncHandler(async (req, res) => {
  const { client_mac } = req.body || {};
  if (!client_mac) return fail(res, 'client_mac required', 400);

  const { data, error } = await supabaseAdmin.rpc('request_connect', {
    p_client_mac: client_mac,
  });
  if (error) return fail(res, error.message, 400);
  return ok(res, { session: data, connect_requested: true });
});

module.exports = { insertCoin, getSession, history, portalInsert, armDevice, disarmDevice, pauseSession, resumeSession, requestConnect };