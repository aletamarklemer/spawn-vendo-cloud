'use strict';
/** utils/liveness.js — IN-MEMORY router/node health tracking (800-vendo scale-safe).
 *  Kada poll (enforce = router, armed = node) mo-marka sa Map (libre, walay DB).
 *  Ang dashboard badges mo-basa DIRETSO sa memory = instant online, ~60-90s offline.
 *  DB persist kada 5 min ra per device (history/last-seen record lang) =
 *  ~5 writes/sec sa 800 vendos (vs 64/sec kung per-poll throttled writes).
 *  Trade-off: Railway redeploy = blanko ang memory kadiyot; router mo-balik
 *  sulod sa 1-2s, node sulod sa iyang poll interval — self-healing.
 *  NOTE: single-instance design (usa ra ka Railway instance — current setup). */
const { supabaseAdmin } = require('../config/supabase');

const routerSeen = new Map();
const nodeSeen = new Map();
const clientStats = new Map();  // per-device {c: connected, a: authenticated, at: ts} gikan sa enforce v17 polls
const dbLast = new Map();
const DB_PERSIST_MS = 5 * 60 * 1000;

const ROUTER_ONLINE_MS = 60 * 1000;  // enforce polls kada 1-2s -> 60s nga hilom = down
const NODE_ONLINE_MS = 90 * 1000;    // NodeMCU armed poll -> 90s nga hilom = down

function mark(map, col, device_id) {
  if (!device_id) return;
  const now = Date.now();
  map.set(device_id, now);
  const k = col + ':' + device_id;
  if (now - (dbLast.get(k) || 0) < DB_PERSIST_MS) return;
  dbLast.set(k, now);
  supabaseAdmin.from('vendo_devices')
    .update({ [col]: new Date().toISOString() })
    .eq('id', device_id)
    .then(() => {}, () => {});
}

function markClients(id, c, a) {
  if (!id) return;
  const ci = parseInt(c, 10), ai = parseInt(a, 10);
  if (Number.isNaN(ci)) return;  // old enforce (walay counts) = walay record
  clientStats.set(id, { c: ci, a: Number.isNaN(ai) ? 0 : ai, at: Date.now() });
}

module.exports = {
  markRouter: (id) => mark(routerSeen, 'router_last_seen', id),
  markClients,
  clients: (id) => {
    const s = clientStats.get(id);
    if (!s || (Date.now() - s.at) > 60 * 1000) return null;  // stale = unknown
    return { connected: s.c, online: s.a };
  },
  markNode: (id) => mark(nodeSeen, 'node_last_seen', id),
  routerOnline: (id) => (Date.now() - (routerSeen.get(id) || 0)) < ROUTER_ONLINE_MS,
  nodeOnline: (id) => (Date.now() - (nodeSeen.get(id) || 0)) < NODE_ONLINE_MS,
};