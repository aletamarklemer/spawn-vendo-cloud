'use strict';
/** controllers/voucher.controller.js */
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler, genVoucherCode } = require('../utils/helpers');
const audit = require('../services/audit.service');

/** POST /api/vouchers/generate */
const generate = asyncHandler(async (req, res) => {
  const minutes = parseInt(req.body?.minutes, 10);
  const count = Math.min(parseInt(req.body?.count, 10) || 1, 500);
  const download_mbps = parseInt(req.body?.download_mbps, 10) || 0;
  const upload_mbps = parseInt(req.body?.upload_mbps, 10) || 0;
  if (!minutes || minutes <= 0) return fail(res, 'minutes must be > 0', 400);
  const rows = Array.from({ length: count }, () => ({ code: genVoucherCode(), minutes, download_mbps, upload_mbps }));
  const { data, error } = await supabaseAdmin.from('vouchers').insert(rows).select();
  if (error) return fail(res, error.message, 400);
  await audit.log('voucher.generate', req.user.sub, { minutes, count, download_mbps, upload_mbps });
  return ok(res, { vouchers: data }, 201);
});

/** GET /api/vouchers */
const list = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('vouchers')
    .select('*').order('created_at', { ascending: false }).limit(500);
  if (error) return fail(res, error.message, 400);
  return ok(res, { vouchers: data });
});

/** POST /api/vouchers/redeem */
const redeem = asyncHandler(async (req, res) => {
  const { code, client_mac, device_id } = req.body || {};
  if (!code || !client_mac) return fail(res, 'code and client_mac required', 400);
  const { data, error } = await supabaseAdmin.rpc('redeem_voucher', {
    p_code: code.trim().toUpperCase(),
    p_client_mac: client_mac,
    p_device_id: device_id || null,
  });
  if (error) {
    const map = {
      VOUCHER_NOT_FOUND: ['Voucher not found', 404],
      VOUCHER_ALREADY_USED: ['Voucher already used or void', 409],
    };
    const [m, s] = map[error.message] || [error.message, 400];
    return fail(res, m, s);
  }
  return ok(res, { session: data });
});

/** POST /api/vouchers/void */
const voidVoucher = asyncHandler(async (req, res) => {
  const { id } = req.body || {};
  const { data, error } = await supabaseAdmin.from('vouchers')
    .update({ status: 'void' }).eq('id', id).eq('status', 'unused').select().maybeSingle();
  if (error) return fail(res, error.message, 400);
  if (!data) return fail(res, 'Voucher not voidable', 409);
  return ok(res, { voucher: data });
});

/** DELETE /api/vouchers/:id */
const deleteVoucher = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.from('vouchers').delete().eq('id', req.params.id);
  if (error) return fail(res, error.message, 400);
  return ok(res, { deleted: true });
});

/** DELETE /api/vouchers/voided — delete all void/used */
const deleteVoidedVouchers = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.from('vouchers')
    .delete().in('status', ['void', 'used']);
  if (error) return fail(res, error.message, 400);
  return ok(res, { deleted: true });
});

/** DELETE /api/vouchers/all — delete ALL vouchers */
const deleteAllVouchers = asyncHandler(async (req, res) => {
  const { error } = await supabaseAdmin.from('vouchers')
    .delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) return fail(res, error.message, 400);
  return ok(res, { deleted: true });
});

module.exports = { generate, list, redeem, voidVoucher, deleteVoucher, deleteVoidedVouchers, deleteAllVouchers };