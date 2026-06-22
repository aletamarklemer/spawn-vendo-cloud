'use strict';
/**
 * controllers/script.controller.js
 * --------------------------------
 * Remote ROUTER SCRIPT auto-update. Parehas sa portal pero para sa
 * router scripts (spawn-enforce.sh, spawn-tokmap.sh, etc.).
 *
 *  - GET  /api/script/manifest  → router mo-check sa tanan script versions
 *  - GET  /api/script/:name     → router mo-pull sa specific script content
 *  - PUT  /api/script           → admin mo-publish bag-ong script (JSON)
 *  - POST /api/script/raw       → router/CLI mo-publish via raw body
 *  - GET  /api/script           → admin: list tanan scripts (metadata)
 */
const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');
const audit = require('../services/audit.service');

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }

// Allowed scripts (whitelist — para dili ma-abuse para mag-install ug bisan unsa)
const ALLOWED = {
  'spawn-enforce.sh': '/usr/bin/spawn-enforce.sh',
  'spawn-tokmap.sh':  '/usr/bin/spawn-tokmap.sh',
  'spawn-tc.sh':      '/usr/bin/spawn-tc.sh',
  'spawn-update.sh':  '/usr/bin/spawn-update.sh',
};

/** GET /api/script/manifest — lightweight: tanan name+version+checksum */
const manifest = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('script_releases')
    .select('name, version, checksum, target_path, restart_cmd');
  if (error) return fail(res, error.message, 400);
  return ok(res, { scripts: data || [] });
});

/** GET /api/script/:name — full content sa usa ka script */
const getScript = asyncHandler(async (req, res) => {
  const { name } = req.params;
  const { data, error } = await supabaseAdmin
    .from('script_releases')
    .select('name, version, content, checksum, target_path, restart_cmd')
    .eq('name', name).maybeSingle();
  if (error) return fail(res, error.message, 400);
  if (!data) return fail(res, 'Script not found', 404);
  return ok(res, data);
});

/** GET /api/script — admin: list metadata */
const listMeta = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('script_releases')
    .select('name, version, checksum, target_path, restart_cmd, notes, updated_at');
  if (error) return fail(res, error.message, 400);
  return ok(res, { scripts: data || [] });
});

/** Shared publish logic */
async function doPublish(res, name, content, restartCmd, notes, userId) {
  if (!ALLOWED[name]) {
    return fail(res, `Script '${name}' dili allowed. Allowed: ${Object.keys(ALLOWED).join(', ')}`, 400);
  }
  if (!content || typeof content !== 'string' || content.length < 20) {
    return fail(res, 'Valid script content required', 400);
  }
  // Safety: dapat shell script (mag-start ug #!/bin/sh o #!)
  if (!content.startsWith('#!')) {
    return fail(res, 'Script dapat mag-start ug shebang (#!/bin/sh) — rejected', 400);
  }

  const checksum = md5(content);
  const target = ALLOWED[name];

  const { data: cur } = await supabaseAdmin
    .from('script_releases').select('version, checksum').eq('name', name).maybeSingle();

  if (cur && cur.checksum === checksum) {
    return ok(res, { name, version: cur.version, unchanged: true, message: 'Walay kausaban' });
  }

  const newVersion = (cur?.version || 0) + 1;

  const { error } = await supabaseAdmin
    .from('script_releases')
    .upsert({
      name, version: newVersion, content, checksum,
      target_path: target,
      restart_cmd: restartCmd || null,
      notes: notes || null,
      updated_at: new Date().toISOString(),
      updated_by: userId || null,
    }, { onConflict: 'name' });
  if (error) return fail(res, error.message, 400);

  await audit.log('script.publish', userId || null, { name, version: newVersion, checksum });
  return ok(res, { name, version: newVersion, checksum, message: `Script ${name} published as v${newVersion}` });
}

/** PUT /api/script — admin: publish via JSON {name, content, restart_cmd, notes} */
const publish = asyncHandler(async (req, res) => {
  const { name, content, restart_cmd, notes } = req.body || {};
  return await doPublish(res, name, content, restart_cmd, notes, req.user?.sub);
});

/** POST /api/script/raw?name=...&restart=... — publish via raw body (router/CLI) */
const publishRaw = asyncHandler(async (req, res) => {
  const name = req.query.name;
  const restartCmd = req.query.restart || null;
  const notes = req.query.notes || 'Published via raw';
  const content = typeof req.body === 'string' ? req.body : '';
  return await doPublish(res, name, content, restartCmd, notes, null);
});

module.exports = { manifest, getScript, listMeta, publish, publishRaw };