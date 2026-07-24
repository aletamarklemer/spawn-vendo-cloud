'use strict';
/**
 * controllers/gcash.controller.js
 * -------------------------------
 * GCash -> Voucher (self-hosted, cashless). NO 3rd-party gateway, NO fee.
 * Centavo-code matching: each order gets a unique centavo (e.g. PHP 20.01) so the
 * exact received amount uniquely identifies ONE order. Payment is confirmed by an
 * SMS bridge (owner's phone forwards the GCash "You received PHP X" SMS here).
 *
 * Public (portal):
 *   POST /api/gcash/order        -> create a pending order (centavo assigned)
 *   GET  /api/gcash/order/:id     -> poll order status (id = uuid OR ref_code)
 *
 * Phone bridge (x-gcash-key = GCASH_BRIDGE_KEY):
 *   POST /api/gcash/sms          -> parse GCash SMS, match & issue voucher (atomic RPC)
 *   GET  /api/gcash/outbox       -> pending voucher SMS to send back to customer
 *   POST /api/gcash/outbox/ack   -> mark an outbox SMS sent/failed
 *
 * All crediting reuses the EXISTING voucher system (redeem_voucher). Matching +
 * issuing is done inside the gcash_match_and_issue RPC = atomic + idempotent.
 */
const { supabaseAdmin } = require('../config/supabase');
const { ok, fail, asyncHandler } = require('../utils/helpers');

// --- phone-bridge auth: Macrodroid sends x-gcash-key = GCASH_BRIDGE_KEY ---
function gcashBridge(req, res, next) {
  const expected = process.env.GCASH_BRIDGE_KEY;
  if (!expected) return fail(res, 'GCash bridge not configured', 503);
  const key = req.headers['x-gcash-key'];
  if (!key || key !== expected) return fail(res, 'Invalid bridge key', 401);
  next();
}

/** GET /api/gcash/status  (public — portal shows the button only when active) */
const getStatus = asyncHandler(async (req, res) => {
  const { data } = await supabaseAdmin.from('gcash_config')
    .select('active, gcash_number, gcash_name').eq('id', 1).maybeSingle();
  const active = !!(data && data.active);
  // Only expose the GCash number/name when the feature is live (nothing leaks before launch).
  return ok(res, {
    active,
    gcash_number: active ? (data.gcash_number || null) : null,
    gcash_name: active ? (data.gcash_name || null) : null,
  });
});

/** POST /api/gcash/order  (public — portal) */
const createOrder = asyncHandler(async (req, res) => {
  const { device_id, client_mac, customer_phone, amount } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt <= 0) return fail(res, 'amount required', 400);
  const { data, error } = await supabaseAdmin.rpc('gcash_create_order', {
    p_device_id: device_id || null,
    p_client_mac: client_mac || null,
    p_customer_phone: (customer_phone || '').toString().slice(0, 20) || null,
    p_amount_base: amt,
  });
  if (error) return fail(res, error.message, 400);
  const st = data && data.status;
  if (st === 'disabled') return fail(res, 'GCash payment is not available right now.', 409);
  if (st === 'no_tier') return fail(res, `No pricing tier for ₱${amt}.`, 400);
  if (st === 'busy') return fail(res, 'GCash is busy, please try again in a minute.', 429);
  return ok(res, { order: data });
});

/** GET /api/gcash/order/:id  (public — poll; id = order uuid OR ref_code) */
const getOrder = asyncHandler(async (req, res) => {
  const id = String(req.params.id || '');
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  let q = supabaseAdmin.from('gcash_orders')
    .select('id, ref_code, status, amount_base, amount_total, minutes, voucher_code, expires_at')
    .limit(1);
  q = isUuid ? q.eq('id', id) : q.eq('ref_code', id.toUpperCase());
  const { data, error } = await q.maybeSingle();
  if (error) return fail(res, error.message, 400);
  if (!data) return ok(res, { order: null });
  // on-read expiry (safety): a pending order past its window becomes 'expired'
  if (data.status === 'pending' && new Date(data.expires_at).getTime() < Date.now()) {
    await supabaseAdmin.from('gcash_orders')
      .update({ status: 'expired' }).eq('id', data.id).eq('status', 'pending');
    data.status = 'expired';
  }
  return ok(res, { order: data });
});

/** Parse a GCash "received money" SMS -> { amount, sender, ref } (or { ignored }). */
function parseGcashSms(raw) {
  const text = String(raw || '');
  // Only process incoming "received" money SMS. Anything else (OTP, promo, "you sent") is ignored.
  if (!/received/i.test(text)) return { ignored: true };
  let amount = null;
  const am = text.match(/received\s+(?:php|p|₱)?\s*([\d,]+\.\d{2})/i)
          || text.match(/(?:php|p|₱)\s*([\d,]+\.\d{2})\s*from/i);
  if (am) {
    const n = Number(String(am[1]).replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0 && n < 100000) amount = n;
  }
  let ref = null;
  const rm = text.match(/ref(?:erence)?\.?\s*no\.?\s*:?\s*([A-Za-z0-9]{6,})/i);
  if (rm) ref = rm[1];
  let sender = null;
  const smNum = text.match(/from\s+[^0-9+]*?(\+?63\d{9}|09\d{9})/i);
  if (smNum) {
    sender = smNum[1];
  } else {
    const smName = text.match(/from\s+([A-Za-z0-9 .,'\-]+?)(?:\.\s|\s+your\b|\s+ref\b|\s+ma[.a]?\s|$)/i);
    if (smName) sender = smName[1].trim().slice(0, 60);
  }
  return { amount, sender, ref };
}

/** POST /api/gcash/sms  (phone bridge) */
const receiveSms = asyncHandler(async (req, res) => {
  const raw = (typeof req.body === 'string' ? req.body
              : (req.body && (req.body.raw || req.body.text || req.body.message))) || '';
  if (!raw) return fail(res, 'raw sms required', 400);
  const p = parseGcashSms(raw);
  if (p.ignored) return ok(res, { result: { status: 'ignored' } });
  const { data, error } = await supabaseAdmin.rpc('gcash_match_and_issue', {
    p_amount: p.amount,
    p_sender: p.sender || null,
    p_ref: p.ref || null,
    p_raw: String(raw).slice(0, 1000),
  });
  if (error) return fail(res, error.message, 400);
  return ok(res, { result: data });
});

/** GET /api/gcash/outbox  (phone bridge) — pending voucher SMS to send */
const getOutbox = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin.from('gcash_outbox')
    .select('id, to_number, body').eq('status', 'pending')
    .order('created_at', { ascending: true }).limit(20);
  if (error) return fail(res, error.message, 400);
  return ok(res, { outbox: data || [] });
});

/**
 * GET /api/gcash/outbox/next  (phone bridge) — Macrodroid-friendly.
 * Returns the oldest pending voucher SMS as PLAIN TEXT "to_number|body" (or empty),
 * and marks it sent immediately (optimistic — portal already shows the code, SMS is a bonus).
 * The phone just: GET this → split on "|" → Send SMS. No JSON, no ack loop.
 */
const nextOutbox = asyncHandler(async (req, res) => {
  const { data } = await supabaseAdmin.from('gcash_outbox')
    .select('id, to_number, body').eq('status', 'pending')
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!data) return res.type('text/plain').send('');
  await supabaseAdmin.from('gcash_outbox')
    .update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', data.id);
  // Headers = easy path for Macrodroid ("Save response headers in a dictionary variable").
  const safeBody = String(data.body).replace(/[\r\n]+/g, ' ');
  res.set('X-Sms-To', String(data.to_number));
  res.set('X-Sms-Body', safeBody);
  // Body = "to|body" fallback if you'd rather split the response text.
  return res.type('text/plain').send(`${data.to_number}|${safeBody}`);
});

/**
 * Two-call SMS-back (zero parsing on the phone):
 *  GET /api/gcash/outbox/claim   → oldest pending → mark 'sending' → return to_number (plain text) | ''
 *  GET /api/gcash/outbox/message → the 'sending' row → mark 'sent' → return body (plain text) | ''
 * Macrodroid: GET claim → var num; if num not empty → GET message → var msg → Send SMS to {num} {msg}.
 * Self-heals: a 'sending' row older than 10 min (send never completed) is offered again as pending.
 */
const claimOutbox = asyncHandler(async (req, res) => {
  // re-offer stale 'sending' rows (phone died mid-send)
  await supabaseAdmin.from('gcash_outbox').update({ status: 'pending' })
    .eq('status', 'sending').lt('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());
  const { data } = await supabaseAdmin.from('gcash_outbox')
    .select('id, to_number').eq('status', 'pending')
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!data) return res.type('text/plain').send('');
  await supabaseAdmin.from('gcash_outbox').update({ status: 'sending' }).eq('id', data.id);
  return res.type('text/plain').send(String(data.to_number));
});

const messageOutbox = asyncHandler(async (req, res) => {
  const { data } = await supabaseAdmin.from('gcash_outbox')
    .select('id, body').eq('status', 'sending')
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!data) return res.type('text/plain').send('');
  await supabaseAdmin.from('gcash_outbox')
    .update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', data.id);
  return res.type('text/plain').send(String(data.body).replace(/[\r\n]+/g, ' '));
});

/** POST /api/gcash/outbox/ack  (phone bridge) — mark sent/failed */
const ackOutbox = asyncHandler(async (req, res) => {
  const { id, status } = req.body || {};
  if (!id) return fail(res, 'id required', 400);
  const st = status === 'failed' ? 'failed' : 'sent';
  const { error } = await supabaseAdmin.from('gcash_outbox')
    .update({ status: st, sent_at: new Date().toISOString() }).eq('id', id);
  if (error) return fail(res, error.message, 400);
  return ok(res, { acked: true, status: st });
});

module.exports = { gcashBridge, getStatus, createOrder, getOrder, receiveSms, getOutbox, nextOutbox, claimOutbox, messageOutbox, ackOutbox };
