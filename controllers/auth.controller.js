'use strict';
/** controllers/auth.controller.js */
const { supabaseAdmin, supabaseAnon } = require('../config/supabase');
const { signToken } = require('../middleware/auth');
const { ok, fail, asyncHandler } = require('../utils/helpers');
const audit = require('../services/audit.service');

/**
 * POST /api/auth/login
 * body: { email, password }
 * Validates against Supabase Auth, looks up the profile/role, then issues
 * our own API JWT. We never send Supabase tokens to staff clients.
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return fail(res, 'Email and password required', 400);

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    await audit.log('staff.login_failed', null, { email: email ? String(email).slice(0, 120) : null }, req);
    return fail(res, 'Invalid credentials', 401);
  }

  let { data: profile } = await supabaseAdmin
    .from('profiles').select('id, full_name, email, role, is_active')
    .eq('id', data.user.id).single();

  // Self-heal: if the row never got created (trigger not installed, or the
  // account predates it), create it now from the authenticated auth user.
  if (!profile) {
    const meta = data.user.user_metadata || {};
    const { data: created, error: cErr } = await supabaseAdmin
      .from('profiles')
      .upsert({
        id: data.user.id,
        email: data.user.email,
        full_name: meta.full_name || data.user.email,
        role: meta.role || 'operator',
      }, { onConflict: 'id' })
      .select('id, full_name, email, role, is_active')
      .single();
    if (cErr || !created) return fail(res, 'Profile not found', 401);
    profile = created;
  }

  if (!profile.is_active) return fail(res, 'Account disabled', 403);

  const token = signToken({ sub: profile.id, role: profile.role, email: profile.email });
  await audit.log('staff.login', profile.id, { role: profile.role }, req);
  return ok(res, { token, profile });
});

/**
 * POST /api/auth/register   (admin-only — guarded in routes)
 * body: { email, password, full_name, role }
 * Uses the admin API so the new user is confirmed immediately. The
 * on_auth_user_created trigger creates the profile; we then set the role.
 */
const register = asyncHandler(async (req, res) => {
  const { email, password, full_name, role = 'operator' } = req.body || {};
  if (!email || !password) return fail(res, 'Email and password required', 400);
  if (!['admin', 'technician', 'operator'].includes(role))
    return fail(res, 'Invalid role', 400);

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name, role },
  });
  if (error) return fail(res, error.message, 400);

  // Don't rely on the on_auth_user_created trigger being installed.
  // Upsert the profile explicitly so the role is guaranteed to be set.
  const { error: pErr } = await supabaseAdmin.from('profiles')
    .upsert({ id: data.user.id, email, full_name, role }, { onConflict: 'id' });
  if (pErr) return fail(res, pErr.message, 400);

  await audit.log('staff.register', req.user?.sub || null, { email, role }, req);
  return ok(res, { id: data.user.id, email, role }, 201);
});

/** GET /api/auth/me */
const me = asyncHandler(async (req, res) => {
  const { data: profile } = await supabaseAdmin
    .from('profiles').select('id, full_name, email, role, is_active')
    .eq('id', req.user.sub).single();
  return ok(res, { profile });
});

/** PATCH /api/auth/profile — update own name & email */
const updateProfile = asyncHandler(async (req, res) => {
  const { full_name, email } = req.body || {};
  if (!full_name && !email) return fail(res, 'full_name or email required', 400);

  const updates = {};
  if (full_name) updates.full_name = full_name;
  if (email) updates.email = email;

  // Update profiles table
  const { error: pErr } = await supabaseAdmin
    .from('profiles').update(updates).eq('id', req.user.sub);
  if (pErr) return fail(res, pErr.message, 400);

  // Update auth email if changed
  if (email) {
    const { error: aErr } = await supabaseAdmin.auth.admin
      .updateUserById(req.user.sub, { email });
    if (aErr) return fail(res, aErr.message, 400);
  }

  await audit.log('staff.profile_update', req.user.sub, updates, req);

  // Fetch and return updated profile
  const { data: profile } = await supabaseAdmin
    .from('profiles').select('*').eq('id', req.user.sub).maybeSingle();

  return ok(res, { updated: true, profile });
});

module.exports = { login, register, me, updateProfile };