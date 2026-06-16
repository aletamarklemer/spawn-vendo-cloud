'use strict';
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');

const allowedClients = asyncHandler(async (req, res) => {
  const { device_id } = req.query || {};

  const { data, error } = await supabaseAdmin.rpc('list_allowed_clients');
  if (error) return fail(res, error.message, 400);

  let rows = data || [];
  if (device_id) rows = rows.filter((r) => r.device_id === device_id);

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