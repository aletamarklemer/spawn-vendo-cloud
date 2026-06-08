'use strict';
/**
 * controllers/enforcement.controller.js
 * -------------------------------------
 * Endpoints consumed by the OpenWRT enforcement agent running on the router.
 * The agent polls GET /api/enforcement/allowed every few seconds, then syncs
 * its firewall: any MAC in the list is allowed to reach the internet, every
 * other connected client is blocked (or bounced to the captive portal).
 *
 * Device-key protected (x-device-key header) — same secret the firmware uses.
 */
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');

/**
 * GET /api/enforcement/allowed   (device auth: x-device-key)
 * Optional query: ?device_id=<uuid> to scope to a single router/device.
 *
 * Returns: { macs: ["AA:BB:..", ...], clients: [{client_mac, remaining_seconds, end_time}] }
 * `macs` is a flat array for easy shell parsing on the router.
 */
const allowedClients = asyncHandler(async (req, res) => {
  const { device_id } = req.query || {};

  const { data, error } = await supabaseAdmin.rpc('list_allowed_clients');
  if (error) return fail(res, error.message, 400);

  let rows = data || [];
  // If a router only manages one device, let it filter server-side.
  if (device_id) rows = rows.filter((r) => r.device_id === device_id);

  // Normalise MACs to uppercase, colon-separated — nftables/iptables friendly.
  const norm = (m) => String(m || '').trim().toUpperCase().replace(/-/g, ':');

  const clients = rows.map((r) => ({
    client_mac: norm(r.client_mac),
    remaining_seconds: r.remaining_seconds,
    end_time: r.end_time,
  }));

  return ok(res, {
    macs: clients.map((c) => c.client_mac),
    clients,
    count: clients.length,
    server_time: new Date().toISOString(),
  });
});

module.exports = { allowedClients };