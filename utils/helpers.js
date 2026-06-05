'use strict';
/** utils/helpers.js — small shared helpers */

// Wrap async route handlers so thrown errors hit the error middleware.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const ok   = (res, data = {}, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, message, status = 400, extra = {}) =>
  res.status(status).json({ success: false, error: message, ...extra });

// Generate a human-friendly voucher code like SPAWN-7F3K-9QP2
function genVoucherCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `SPAWN-${block()}-${block()}`;
}

module.exports = { asyncHandler, ok, fail, genVoucherCode };
