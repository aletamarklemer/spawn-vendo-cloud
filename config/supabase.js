'use strict';
/**
 * config/supabase.js
 * -------------------
 * Creates two Supabase clients:
 *  - supabaseAdmin: uses the service_role key, bypasses RLS. Server-side ONLY.
 *  - supabaseAnon : uses the anon key, respects RLS. Used to validate user
 *                   JWTs and for operations that should honour row-level rules.
 */
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  // Fail fast: the backend cannot function without these.
  console.error('[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment.');
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: WebSocket },
});

const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY || '', {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { transport: WebSocket },
});

module.exports = { supabaseAdmin, supabaseAnon, SUPABASE_URL, SUPABASE_ANON_KEY };
