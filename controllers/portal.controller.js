'use strict';
/**
 * controllers/portal.controller.js
 * --------------------------------
 * Remote portal auto-update endpoints.
 *
 *  - GET  /api/portal/version  → router mo-check kung naa bay bag-ong version
 *                                (lightweight: version + checksum ra, walay HTML)
 *  - GET  /api/portal/latest   → router mo-pull sa full portal HTML
 *                                (deviceAuth — para ang vendo ra makakuha)
 *  - PUT  /api/portal          → admin mo-upload bag-ong portal (auto-bump version)
 *  - GET  /api/portal          → admin mo-tan-aw sa current portal metadata
 */
const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');
const audit = require('../services/audit.service');

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }

/** GET /api/portal/version — lightweight check (router polls ni) */
const version = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('portal_releases')
    .select('version, checksum, updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) return fail(res, error.message, 400);
  if (!data) return ok(res, { version: 0, checksum: null });
  return ok(res, { version: data.version, checksum: data.checksum, updated_at: data.updated_at });
});

/** GET /api/portal/latest — full portal HTML (deviceAuth guarded) */
const latest = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('portal_releases')
    .select('version, html, checksum')
    .eq('id', 1)
    .maybeSingle();
  if (error) return fail(res, error.message, 400);
  if (!data) return fail(res, 'No portal release found', 404);
  return ok(res, { version: data.version, html: data.html, checksum: data.checksum });
});

/** GET /api/portal — admin: current metadata (walay full html) */
const getMeta = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('portal_releases')
    .select('version, checksum, notes, updated_at, updated_by')
    .eq('id', 1)
    .maybeSingle();
  if (error) return fail(res, error.message, 400);
  return ok(res, { release: data || null });
});

/** PUT /api/portal — admin: upload bag-ong portal, auto-bump version */
const publish = asyncHandler(async (req, res) => {
  const { html, notes } = req.body || {};
  if (!html || typeof html !== 'string' || html.length < 100) {
    return fail(res, 'Valid portal html required (min 100 chars)', 400);
  }
  // Safety: siguraduha nga naa ang IP-fallback fix (dili mo-publish ug luma nga portal)
  if (!html.includes('/ip/')) {
    return fail(res, 'Portal html walay /ip/ IP-fallback fix — mobalik ang Loading bug. Rejected.', 400);
  }

  const checksum = md5(html);

  // Kuhaa ang current version para i-increment
  const { data: cur } = await supabaseAdmin
    .from('portal_releases').select('version, checksum').eq('id', 1).maybeSingle();

  // Kung parehas ra ang checksum, walay kausaban — ayaw bump
  if (cur && cur.checksum === checksum) {
    return ok(res, { version: cur.version, unchanged: true, message: 'Walay kausaban sa portal' });
  }

  const newVersion = (cur?.version || 0) + 1;

  const { error } = await supabaseAdmin
    .from('portal_releases')
    .upsert({
      id: 1,
      version: newVersion,
      html,
      checksum,
      notes: notes || null,
      updated_at: new Date().toISOString(),
      updated_by: req.user?.sub || null,
    }, { onConflict: 'id' });
  if (error) return fail(res, error.message, 400);

  await audit.log('portal.publish', req.user?.sub || null, { version: newVersion, checksum });
  return ok(res, { version: newVersion, checksum, message: `Portal published as v${newVersion}` });
});

module.exports = { version, latest, getMeta, publish };
