'use strict';
/** services/audit.service.js — fire-and-forget audit logging (+ forensic ip/user_agent) */
const { supabaseAdmin } = require('../config/supabase');

function reqMeta(req) {
  if (!req) return { ip: null, user_agent: null };
  const h = req.headers || {};
  const xff = h['x-forwarded-for'];
  const ip = (xff ? String(xff).split(',')[0].trim()
                  : (req.ip || (req.socket && req.socket.remoteAddress))) || null;
  let ua = h['user-agent'] || null;
  if (ua) ua = String(ua).slice(0, 300);
  return { ip, user_agent: ua };
}

async function log(action, userId = null, details = {}, req = null) {
  try {
    const m = reqMeta(req);
    await supabaseAdmin.from('audit_logs').insert({
      action, user_id: userId, details, ip: m.ip, user_agent: m.user_agent,
    });
  } catch (e) {
    console.error('[audit] failed:', e.message);
  }
}
module.exports = { log };
