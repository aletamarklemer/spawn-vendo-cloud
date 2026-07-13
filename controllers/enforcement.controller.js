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

const allowedClients = asyncHandler(async (req, res) => {
  const { device_id, c, a, m, o, w } = req.query || {};
  liveness.markRouter(device_id);  // router health pulse (in-memory, scale-safe)
  liveness.markClients(device_id, c, a, m, o);  // client counts gikan sa enforce v17 (optional params)
  if (w) liveness.markWireless(device_id, w);   // v26: wireless iface list (hex, read-only visibility)

  const { data, error } = await supabaseAdmin.rpc('list_allowed_clients');
  if (error) return fail(res, error.message, 400);

  let rows = data || [];
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

  const sig = await updateSignal();
  return ok(res, {
    pv: sig.pv, sv: sig.sv,  // instant update signal (portal ver + scripts signature)
    ss: targetSsid,          // v25: target broadcast SSID (enforce syncs uci kung lahi)
    ...wcf,                  // v27: pending wifi command (wcid/wca/wcs/wcv/wch/wcb) kung naa
    wc: (await pendingWifiCommands())[device_id] || '',  // v27: pending wifi command (flat)
    macs: activeClients.map((c) => c.client_mac),   // only active MACs
    paused_macs: pausedClients.map((c) => c.client_mac), // paused MACs separate
    clients: [...activeClients, ...pausedClients],
    speeds,  // per-MAC voucher speed override
    count: activeClients.length,
    server_time: new Date().toISOString(),
  });
});

module.exports = { wifiDone, allowedClients , wifiAck };