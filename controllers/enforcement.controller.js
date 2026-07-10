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

const allowedClients = asyncHandler(async (req, res) => {
  const { device_id, c, a } = req.query || {};
  liveness.markRouter(device_id);  // router health pulse (in-memory, scale-safe)
  liveness.markClients(device_id, c, a);  // client counts gikan sa enforce v17 (optional params)

  const { data, error } = await supabaseAdmin.rpc('list_allowed_clients');
  if (error) return fail(res, error.message, 400);

  let rows = data || [];
  if (device_id) {
    const ssidMap = await getDeviceSsidMap();
    const reqSsid = ssidMap[device_id];
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

  return ok(res, {
    macs: activeClients.map((c) => c.client_mac),   // only active MACs
    paused_macs: pausedClients.map((c) => c.client_mac), // paused MACs separate
    clients: [...activeClients, ...pausedClients],
    speeds,  // per-MAC voucher speed override
    count: activeClients.length,
    server_time: new Date().toISOString(),
  });
});

module.exports = { allowedClients };