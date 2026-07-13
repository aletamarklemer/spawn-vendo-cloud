'use strict';
/** controllers/device.controller.js */
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');
const audit = require('../services/audit.service');
const liveness = require('../utils/liveness');

const OFFLINE_AFTER_MS = 5 * 60 * 1000; // 5 min without heartbeat => offline

/** GET /api/devices  (admin, technician, operator-own) */
const list = asyncHandler(async (req, res) => {
  let q = supabaseAdmin.from('vendo_devices').select('*').order('device_name');
  if (req.user.role === 'operator') q = q.eq('operator_id', req.user.sub);
  const { data, error } = await q;
  if (error) return fail(res, error.message, 400);

  // Derive offline status from last_online for the UI.
  const now = Date.now();
  const devices = (data || []).map((d) => {
    const stale = !d.last_online || (now - new Date(d.last_online).getTime()) > OFFLINE_AFTER_MS;
    // Live badges gikan sa IN-MEMORY liveness (instant online, ~60-90s offline, zero DB cost)
    const router_online = liveness.routerOnline(d.id);
    const node_online = liveness.nodeOnline(d.id);
    const cs = liveness.clients(d.id);  // null = unknown (old enforce o offline)
    return { ...d, status: d.status === 'maintenance' ? 'maintenance' : (stale ? 'offline' : 'online'), router_online, node_online,
      clients_connected: cs ? cs.connected : null, clients_online: cs ? cs.online : null };
  });
  return ok(res, { devices });
});

/** POST /api/devices  (admin) */
const create = asyncHandler(async (req, res) => {
  const { device_name, location, mac_address, area, operator_id, download_mbps, upload_mbps } = req.body || {};
  if (!device_name || !mac_address) return fail(res, 'device_name and mac_address required', 400);
  const { data, error } = await supabaseAdmin.from('vendo_devices')
    .insert({ device_name, location, mac_address, area, operator_id, download_mbps: download_mbps || 0, upload_mbps: upload_mbps || 0 }).select().single();
  if (error) return fail(res, error.message, 400);
  await audit.log('device.create', req.user.sub, { device_name, mac_address });
  return ok(res, { device: data }, 201);
});

/** PATCH /api/devices/:id  (admin full, technician status only) */
const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  let patch = {};
  if (req.user.role === 'technician') {
    if (body.status) patch.status = body.status; // tech can only flip status
  } else {
    patch = body;
  }
  const { data, error } = await supabaseAdmin.from('vendo_devices')
    .update(patch).eq('id', id).select().single();
  if (error) return fail(res, error.message, 400);
  return ok(res, { device: data });
});

/** POST /api/devices/heartbeat  (device auth) body: { mac_address } */
const heartbeat = asyncHandler(async (req, res) => {
  const { mac_address } = req.body || {};
  if (!mac_address) return fail(res, 'mac_address required', 400);
  const { data, error } = await supabaseAdmin.from('vendo_devices')
    .update({ status: 'online', last_online: new Date().toISOString(), node_last_seen: new Date().toISOString() })
    .eq('mac_address', mac_address).select().maybeSingle();
  if (error) return fail(res, error.message, 400);
  return ok(res, { device: data });
});

/** DELETE /api/devices/:id (admin) */
const remove = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.from('vendo_devices').delete().eq('id', req.params.id);
  if (error) return fail(res, error.message, 400);
  return ok(res, { deleted: true });
});

// ---- maintenance requests ----
const listMaintenance = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('maintenance_requests')
    .select('*, vendo_devices(device_name, location)')
    .order('created_at', { ascending: false });
  if (error) return fail(res, error.message, 400);
  return ok(res, { requests: data });
});

const createMaintenance = asyncHandler(async (req, res) => {
  const { device_id, issue } = req.body || {};
  if (!device_id || !issue) return fail(res, 'device_id and issue required', 400);
  const { data, error } = await supabaseAdmin.from('maintenance_requests')
    .insert({ device_id, issue, technician_id: req.user.sub }).select().single();
  if (error) return fail(res, error.message, 400);
  return ok(res, { request: data }, 201);
});

const resolveMaintenance = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { resolution, status = 'resolved' } = req.body || {};
  const { data, error } = await supabaseAdmin.from('maintenance_requests')
    .update({ resolution, status, resolved_at: status === 'resolved' ? new Date().toISOString() : null })
    .eq('id', id).select().single();
  if (error) return fail(res, error.message, 400);
  return ok(res, { request: data });
});

/** GET /api/devices/speed?device_id=xxx  (device auth) — returns Mbps for enforcement */
const getSpeed = asyncHandler(async (req, res) => {
  const { device_id } = req.query || {};
  if (!device_id) return fail(res, 'device_id required', 400);
  const { data, error } = await supabaseAdmin.from('vendo_devices')
    .select('download_mbps, upload_mbps').eq('id', device_id).maybeSingle();
  if (error) return fail(res, error.message, 400);
  return ok(res, {
    download_mbps: data?.download_mbps || 0,
    upload_mbps: data?.upload_mbps || 0,
  });
});

/** GET /api/devices/armed?device_id=xxx  (device auth)
 *  Gigamit sa NodeMCU firmware (inhibit wire). Mo-return kung naay
 *  armed, non-expired client sa device. Kung true → i-enable ang coin
 *  slot. Kung false → i-reject/iluwa ang coin (walay client naghulat).
 */
const armed = asyncHandler(async (req, res) => {
  const { device_id } = req.query || {};
  if (!device_id) return fail(res, 'device_id required', 400);
  liveness.markNode(device_id);  // node health pulse (in-memory, scale-safe)
  const { data, error } = await supabaseAdmin.rpc('is_device_armed', {
    p_device_id: device_id,
  });
  if (error) return fail(res, error.message, 400);
  return ok(res, { armed: data === true });
});

/** GET /api/devices/:id/clients (admin/tech/oper) — KINSA ANG NAKA-ONLINE karon
 *  sa maong router: real-time MAC list gikan sa enforce v20 (iw station dump),
 *  gi-enrich sa sessions (phone info, status, remaining). null lists = old
 *  enforce pa or offline ang router. */
/** GET /api/devices/:id/wireless — WiFi networks sa router (read-only visibility, enforce v26) */
const wireless = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const hex = liveness.wirelessList(id);
  if (!hex) return ok(res, { fresh: false, networks: [] });  // stale/old-enforce/offline
  let raw = '';
  try { raw = Buffer.from(hex, 'hex').toString('utf8'); } catch (e) { return ok(res, { fresh: false, networks: [] }); }
  const networks = raw.split('|').filter(Boolean).map((row) => {
    const [section, ssid, device, hidden, disabled] = row.split('~');
    return {
      section: section || '',
      ssid: ssid || '',
      radio: device || '',
      band: device === 'radio1' ? '5G' : device === 'radio0' ? '2.4G' : (device || '?'),
      hidden: hidden === '1',
      disabled: disabled === '1',
    };
  });
  return ok(res, { fresh: true, networks });
});

const clients = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const lst = liveness.clientList(id);
  if (!lst) return ok(res, { fresh: false, clients: [] });  // unknown/stale/old-enforce

  const macs = lst.macs || [];
  if (!macs.length) return ok(res, { fresh: true, clients: [] });

  // Sessions lookup: ang sessions naka-store as 'MAC:AA:BB:...' uppercase
  const keys = macs.map((m) => 'MAC:' + m.toUpperCase());
  const { data: rows } = await supabaseAdmin
    .from('internet_sessions')
    .select('client_mac, device_info, status, end_time, remaining_seconds, created_at')
    .in('client_mac', keys)
    .order('created_at', { ascending: false });

  const byMac = {};
  (rows || []).forEach((r) => { if (!byMac[r.client_mac]) byMac[r.client_mac] = r; });

  const onlineSet = new Set((lst.online || []).map((m) => m.toUpperCase()));
  const out = macs.map((m) => {
    const key = 'MAC:' + m.toUpperCase();
    const s = byMac[key];
    let remaining = null;
    if (s && s.status === 'active' && s.end_time) {
      remaining = Math.max(0, Math.floor((new Date(s.end_time) - Date.now()) / 1000));
    } else if (s && s.status === 'paused') {
      remaining = s.remaining_seconds || 0;
    }
    return {
      mac: m.toUpperCase(),
      online: onlineSet.has(m.toUpperCase()),        // authenticated + associated = nag-browse
      phone: (s && s.device_info) || null,           // gikan sa portal buildPhoneInfo
      session_status: (s && s.status) || null,       // active/paused/expired/null
      remaining_seconds: remaining,
    };
  });
  return ok(res, { fresh: true, clients: out });
});

module.exports = {
  getSpeed, armed,
  list, create, update, heartbeat, remove,
  listMaintenance, createMaintenance, resolveMaintenance, clients, wireless,
};