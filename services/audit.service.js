'use strict';
/** services/audit.service.js — fire-and-forget audit logging */
const { supabaseAdmin } = require('../config/supabase');

async function log(action, userId = null, details = {}) {
  try {
    await supabaseAdmin.from('audit_logs').insert({ action, user_id: userId, details });
  } catch (e) {
    console.error('[audit] failed:', e.message);
  }
}
module.exports = { log };
