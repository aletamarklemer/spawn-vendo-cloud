'use strict';
/**
 * db/seed.js — create the first admin account.
 * Usage:  node db/seed.js admin@spawn.net admin123 "Wendell Dampios"
 * Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in .env.
 */
require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

(async () => {
  const [, , email, password, name = 'Administrator'] = process.argv;
  if (!email || !password) {
    console.error('Usage: node db/seed.js <email> <password> [full_name]');
    process.exit(1);
  }
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: name, role: 'admin' },
  });
  if (error) { console.error('Failed:', error.message); process.exit(1); }
  await supabaseAdmin.from('profiles')
    .upsert({ id: data.user.id, role: 'admin', full_name: name, email }, { onConflict: 'id' });
  console.log(`✅ Admin created: ${email}`);

  process.exit(0);
})();