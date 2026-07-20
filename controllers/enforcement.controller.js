'use strict';
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');
const liveness = require('../utils/liveness');

// ============================================================
// ROAMING (SSID group) — v2
// Kung ang duha ka vendo PAREHAS ug `ssid` sa devices table,
// magka-share silag sessions: ang customer nga nag-coin sa
// vendo1 maka-continue sa vendo2 (auto-auth), lakip pause/resume.
// Kung NULL ang ssid = per-device ra gihapon (old behavior).
//
// CACHED 60s (samang pattern sa getValidityMs sa coin controller)
// para WALAY extra DB query kada poll — safe bisan 800 vendos
// nga nag-poll matag 1-2s.
// ============================================================
let _ssidCache = { map: null, at: 0 };
async function getDeviceSsidMap() {
  const now = Date.now();
  if (_ssidCache.map !== null && (now - _ssidCache.at) < 60000) {
    return _ssidCache.map;
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('vendo_devices')
      .select('id, ssid');
    if (error) throw error;
    const map = {};
    (data || []).forEach((d) => {
      // Empty string = walay group (treat as NULL)
      if (d.ssid && String(d.ssid).trim() !== '') {
        map[d.id] = String(d.ssid).trim();
      }
    });
    _ssidCache = { map, at: now };
    return map;
  } catch (e) {
    // Kung na-fail ang query: gamita ang daan nga cache kung naa;
    // kung wala, empty map = mo-fallback sa exact device_id filter (SAFE)
    if (_ssidCache.map !== null) return _ssidCache.map;
    return {};
  }
}

/* ============================================================
   INSTANT AUTO-CONNECT (resume-pending list `rp`)
   ------------------------------------------------------------
   Para ma-INSTANT (2-3s) ang auto-connect sa reconnect, i-apil sa /allowed
   response ang mga MAC nga AUTO-PAUSED-nga-eligible (rp). Ang enforce v33
   mo-auth DAYON sa mao ra nga poll (walay 2nd round-trip) inig ka-associate
   balik sa phone = internet nga walay portal sulod sa ~1-2s.

   Eligible = status 'paused' + auto_paused_at set (AUTO ra, dili manual) +
   remaining_seconds > 10 + sulod pa sa validity window (auto_paused_at + N days).
   MANUAL pause = DILI apil (respeto sa intent — manual resume ra gihapon).

   Cached 2s GLOBALLY (tanan groups) para dili per-poll-per-device ang DB hit —
   scale-safe bisan 800+ vendos. Ang group filter kay JS-side (parehas sa roaming).
   ============================================================ */
let _rpValid = { ms: null, at: 0 };
async function getResumeValidityMs() {
  const now = Date.now();
  if (_rpValid.ms !== null && (now - _rpValid.at) < 60000) return _rpValid.ms;
  try {
    const { data } = await supabaseAdmin
      .from('settings').select('pause_validity_days')
      .eq('is_active', true).order('updated_at', { ascending: false })
      .limit(1).maybeSingle();
    const days = (data && data.pause_validity_days) || 3;
    _rpValid = { ms: days * 24 * 60 * 60 * 1000, at: now };
  } catch (e) {
    if (_rpValid.ms === null) _rpValid = { ms: 3 * 24 * 60 * 60 * 1000, at: now };
  }
  return _rpValid.ms;
}

let _rpCache = { at: 0, rows: [] };
async function getResumePending() {
  const now = Date.now();
  if (now - _rpCache.at < 2000) return _rpCache.rows;   // 2s cache = fresh enough para instant
  try {
    const validMs = await getResumeValidityMs();
    const cutoff = new Date(now - validMs).toISOString();
    const { data } = await supabaseAdmin
      .from('internet_sessions')
      .select('client_mac, device_id, remaining_seconds, auto_paused_at')
      .eq('status', 'paused')
      .not('auto_paused_at', 'is', null)      // AUTO ra (manual = manual resume)
      .gt('remaining_seconds', 10)            // naay pulos nga oras
      .gte('auto_paused_at', cutoff);         // sulod pa sa validity
    _rpCache = { at: now, rows: data || [] };
  } catch (e) { _rpCache.at = now; }          // keep old rows on error (graceful)
  return _rpCache.rows;
}

/* INSTANT UPDATE SIGNAL: cached portal version (pv) + scripts signature (sv).
   Gi-piggyback sa /allowed response (~30 bytes) para ang enforce v19 maka-detect
   ug bag-ong release sulod sa segundos (imbes maghulat sa cron). 60s cache =
   1 DB query/min bisan 800 ka vendo ang nag-poll kada 1-3s. */
const crypto = require('crypto');
let _sig = { at: 0, pv: 0, sv: '' };
async function updateSignal() {
  const now = Date.now();
  if (now - _sig.at < 60 * 1000) return _sig;
  try {
    const [p, s] = await Promise.all([
      supabaseAdmin.from('portal_releases').select('version').eq('id', 1).maybeSingle(),
      supabaseAdmin.from('script_releases').select('name, version'),
    ]);
    const pv = (p.data && p.data.version) || 0;
    const joined = (s.data || []).map((x) => `${x.name}:${x.version}`).sort().join(',');
    const sv = crypto.createHash('md5').update(joined).digest('hex').slice(0, 12);
    _sig = { at: now, pv, sv };
  } catch (e) { _sig.at = now; } // keep old values on error (graceful)
  return _sig;
}

/* v27: PENDING WIFI COMMANDS cache — ONE query per 10s para sa tibuok fleet
   (parehas sa updateSignal pattern; 800-scale-safe). Flat-serialized para
   sayon i-parse sa BusyBox (walay nested JSON sa router side). */
let _wifiCmd = { at: 0, map: {} };
async function pendingWifiCommands() {
  const now = Date.now();
  if (now - _wifiCmd.at < 10 * 1000) return _wifiCmd.map;
  try {
    const { data } = await supabaseAdmin.from('wifi_commands')
      .select('id, device_id, action, params')
      .eq('status', 'pending').order('created_at', { ascending: true }).limit(200);
    const map = {};
    (data || []).forEach((c) => {
      if (map[c.device_id]) return;  // usa ra ka command kada device kada round (FIFO)
      const p = c.params || {};
      let flat = '';
      if (c.action === 'set_hidden') flat = `${c.id}~set_hidden~${p.section}~${p.hidden ? 1 : 0}`;
      else if (c.action === 'add_iface') flat = `${c.id}~add_iface~${p.section}~${p.ssid}~${p.band}~${p.hidden ? 1 : 0}`;
      else if (c.action === 'del_iface') flat = `${c.id}~del_iface~${p.section}`;
      if (flat) map[c.device_id] = flat;
    });
    _wifiCmd = { at: now, map };
  } catch (err) { _wifiCmd.at = now; }
  return _wifiCmd.map;
}
function bustWifiCmdCache() { _wifiCmd.at = 0; }

/** POST /api/enforcement/wifi-ack (device auth) body: { id, ok } — router confirms apply */
const wifiAck = asyncHandler(async (req, res) => {
  const { id, ok } = req.body || {};
  if (!id) return fail(res, 'id required', 400);
  await supabaseAdmin.from('wifi_commands')
    .update({ status: ok === false ? 'failed' : 'done', done_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'pending');
  bustWifiCmdCache();
  return ok2(res);
});
function ok2(res) { return ok(res, { acked: true }); }

/* v27: WiFi command delivery — SCALE-SAFE: usa ka global query kada 15s (ang set
   sa device_ids nga naay pending), unya per-device fetch RA kung apil (rare). */
let _wcCache = { at: 0, set: new Set() };
async function pendingWifiDevices() {
  if (Date.now() - _wcCache.at < 15 * 1000) return _wcCache.set;
  try {
    const { data } = await supabaseAdmin.from('wifi_commands').select('device_id').eq('status', 'pending');
    _wcCache = { at: Date.now(), set: new Set((data || []).map((r) => r.device_id)) };
  } catch (err) { _wcCache.at = Date.now(); }
  return _wcCache.set;
}

/** POST /api/enforcement/wifi-done (device auth) — ang router mo-report human ma-apply */
const wifiDone = asyncHandler(async (req, res) => {
  const { id, ok } = req.body || {};
  if (!id) return fail(res, 'id required', 400);
  await supabaseAdmin.from('wifi_commands')
    .update({ status: ok ? 'done' : 'failed', done_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'pending');
  _wcCache.at = 0;  // invalidate cache para dali ma-clear
  return ok2(res);
});
function ok2(res) { return res.json({ success: true }); }

/* 800-SCALE CACHE: ang list_allowed_clients RPC kay GLOBAL man ang resulta
   (gi-filter per-device dinhi sa Node), so USA ra ka execution kada 2s ang
   kinahanglan para sa TIBUOK fleet — dili kada poll sa kada router. Sa 800 ka
   vendo nga nag-poll kada ~3s: gikan ~270 RPC execution/s → 0.5/s (~500x gaan).
   Ang RPC pod ang nag-expire sa sessions (UPDATE) — mo-dagan gihapon kada 2s.
   INSTANT PROPAGATION: coin/pause/resume/connect/redeem mo-tawag ug
   bustAllowedCache() para fresh dayon ang sunod nga poll — walay dugang
   latency ang customer. (Samang 2s-global pattern sa rp cache sa taas.) */
let _allowed = { at: 0, rows: null };
async function getAllowedRows() {
  const now = Date.now();
  if (_allowed.rows !== null && (now - _allowed.at) < 2000) return _allowed.rows;
  const { data, error } = await supabaseAdmin.rpc('list_allowed_clients');
  if (error) {
    // DB hiccup fail-safe: gamita ang luma nga cache (hangtod 15s) para dili
    // ma-cut ang mga customer tungod sa usa ka lapsed query.
    if (_allowed.rows !== null && (now - _allowed.at) < 15000) return _allowed.rows;
    throw new Error(error.message);
  }
  _allowed = { at: now, rows: data || [] };
  return _allowed.rows;
}
function bustAllowedCache() { _allowed.at = 0; _rpCache.at = 0; }

const allowedClients = asyncHandler(async (req, res) => {
  const { device_id, c, a, m, o, w, ev } = req.query || {};
  liveness.markRouter(device_id, ev);  // router health pulse + v36 enforce_version (in-memory, scale-safe)
  liveness.markClients(device_id, c, a, m, o);  // client counts gikan sa enforce v17 (optional params)
  if (w) liveness.markWireless(device_id, w);   // v26: wireless iface list (hex, read-only visibility)

  let rows;
  try { rows = await getAllowedRows(); } catch (e) { return fail(res, e.message, 400); }
  let targetSsid = '';  // v25: ang device's DB ssid = target broadcast (SSID sync)
  if (device_id) {
    const ssidMap = await getDeviceSsidMap();
    const reqSsid = ssidMap[device_id];
    targetSsid = reqSsid || '';
    if (reqSsid) {
      // ROAMING: i-apil ang sessions sa TANAN devices nga parehas ug ssid
      // (lakip na ang requesting device mismo)
      rows = rows.filter((r) => ssidMap[r.device_id] === reqSsid);
    } else {
      // Walay ssid group = old behavior (exact device match)
      rows = rows.filter((r) => r.device_id === device_id);
    }
  }

  const norm = (m) => String(m || '').trim().toUpperCase().replace(/-/g, ':');

  // Separate active vs paused
  const activeRows  = rows.filter((r) => r.status === 'active');
  const pausedRows  = rows.filter((r) => r.status === 'paused');

  const activeClients = activeRows.map((r) => ({
    client_mac: norm(r.client_mac),
    remaining_seconds: r.remaining_seconds,
    end_time: r.end_time,
    status: 'active',
  }));

  const pausedClients = pausedRows.map((r) => ({
    client_mac: norm(r.client_mac),
    remaining_seconds: r.remaining_seconds,
    end_time: null,
    status: 'paused',
  }));

  // Build speed map: MAC -> "dl_ul" (only for clients with voucher speed set)
  const speeds = {};
  rows.forEach((r) => {
    if (r.download_mbps != null || r.upload_mbps != null) {
      speeds[norm(r.client_mac)] = {
        download_mbps: r.download_mbps,
        upload_mbps: r.upload_mbps,
      };
    }
  });

  // v27: pending WiFi command (flat fields para dali i-parse sa busybox sed)
  let wcf = {};
  if (device_id && (await pendingWifiDevices()).has(device_id)) {
    const { data: cmd } = await supabaseAdmin.from('wifi_commands').select('*')
      .eq('device_id', device_id).eq('status', 'pending')
      .order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (cmd) {
      const p = cmd.params || {};
      wcf = {
        wcid: cmd.id,
        wca: cmd.action,
        wcs: p.section || '',
        wcv: p.ssid || '',
        wch: p.hidden ? '1' : '0',
        wcb: String(({ both: 2, radio0: 0, radio1: 1, '0': 0, '1': 1, '2': 2 })[String(p.band)] ?? 2),  // normalize: both/radio0/radio1 or 0/1/2 -> 0=2.4G, 1=5G, 2=both
      };
    }
  }

  // INSTANT AUTO-CONNECT (v33): resume-pending MACs para sa requesting device/group.
  // Auto-paused-nga-eligible ra (rp) — ang enforce mo-auth DAYON sa reconnect.
  let rp = [];
  try {
    const rpRows = await getResumePending();
    const rpMap = await getDeviceSsidMap();          // cached (60s) — walay extra DB hit
    const grp = device_id ? rpMap[device_id] : null;
    const inScope = (rid) => {
      if (!device_id) return true;                   // walay device filter (dev/test)
      if (grp) return rpMap[rid] === grp;            // roaming group
      return rid === device_id;                      // walay group = exact device
    };
    rp = rpRows.filter((r) => inScope(r.device_id)).map((r) => norm(r.client_mac));
    if (rp.length > 50) rp = rp.slice(0, 50);        // cap 50 (parse-safe sa router)
  } catch (e) { rp = []; }

  const sig = await updateSignal();
  return ok(res, {
    pv: sig.pv, sv: sig.sv,  // instant update signal (portal ver + scripts signature)
    ss: targetSsid,          // v25: target broadcast SSID (enforce syncs uci kung lahi)
    ...wcf,                  // v27: pending wifi command (wcid/wca/wcs/wcv/wch/wcb) kung naa
    wc: (await pendingWifiCommands())[device_id] || '',  // v27: pending wifi command (flat)
    macs: activeClients.map((c) => c.client_mac),   // only active MACs
    paused_macs: pausedClients.map((c) => c.client_mac), // paused MACs separate
    rp,                      // v33: INSTANT AUTO-CONNECT resume-pending (auto-paused eligible)
    clients: [...activeClients, ...pausedClients],
    speeds,  // per-MAC voucher speed override
    count: activeClients.length,
    server_time: new Date().toISOString(),
  });
});

/* POST /api/enforcement/resume (deviceAuth) body: { client_mac, device_id }
   v33 INSTANT AUTO-CONNECT: gitawag sa spawn-enforce v33 sa MISMO nga gutlo nga
   ni-associate balik ang phone ug gi-auth na nila LOCALLY. Kini mo-flip sa DB
   (paused -> active) DAYON para (a) responsive ang admin dashboard, ug (b) ang
   sunod nga poll mo-return na sa MAC isip 'active' (dili na sa rp).
   AUTO ra ang i-resume (auto_paused_at set) — respeto sa manual pause.
   Race-guarded (.eq status paused); idempotent kung na-flip na sa sweep. */
const resumeClient = asyncHandler(async (req, res) => {
  const { client_mac } = req.body || {};
  if (!client_mac) return fail(res, 'client_mac required', 400);
  // Router nag-send og bare lowercase mac (aa:bb..); ang DB nag-store og 'MAC:AA:BB..'.
  const bare = String(client_mac).trim().toUpperCase().replace(/-/g, ':').replace(/^MAC:/, '');
  const stored = 'MAC:' + bare;

  const { data, error } = await supabaseAdmin
    .from('internet_sessions')
    .select('id, remaining_seconds, auto_paused_at, first_paused_at')
    .eq('client_mac', stored).eq('status', 'paused')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return fail(res, error.message, 400);
  if (!data) return ok(res, { resumed: false, reason: 'no-paused' });
  if (!data.auto_paused_at) return ok(res, { resumed: false, reason: 'manual' });  // manual = manual resume ra

  const remaining = data.remaining_seconds || 0;
  if (remaining <= 10) {
    await supabaseAdmin.from('internet_sessions')
      .update({ status: 'expired' }).eq('id', data.id).eq('status', 'paused');
    return ok(res, { resumed: false, reason: 'expired' });
  }
  const newEnd = new Date(Date.now() + remaining * 1000).toISOString();
  const { error: uErr } = await supabaseAdmin
    .from('internet_sessions')
    .update({ status: 'active', end_time: newEnd, connect_requested: true, auto_paused_at: null })
    .eq('id', data.id).eq('status', 'paused');   // race guard (sweep/manual/topup)
  if (uErr) return fail(res, uErr.message, 400);
  console.log(`[auto-connect] ${stored} (${remaining}s restored, router-triggered)`);
  bustAllowedCache();  // 800-scale cache: active na siya — ipakita dayon sa sunod poll
  return ok(res, { resumed: true, remaining_seconds: remaining });
});

module.exports = { wifiDone, allowedClients, wifiAck, resumeClient, getDeviceSsidMap, bustAllowedCache };
