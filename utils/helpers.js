'use strict';
/** utils/helpers.js — small shared helpers */
const crypto = require('crypto');

/**
 * Reversible password encryption (AES-256-GCM).
 * Para sa "View Password" feature: ma-decrypt balik sa dashboard,
 * pero DILI plaintext sa database. Gamit ang PASSWORD_ENC_KEY env var
 * (32-byte hex = 64 chars). I-set kini sa Railway.
 */
function _encKey() {
  const k = process.env.PASSWORD_ENC_KEY || '';
  if (k.length !== 64) {
    throw new Error('PASSWORD_ENC_KEY must be 64 hex chars (32 bytes). Generate: openssl rand -hex 32');
  }
  return Buffer.from(k, 'hex');
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', _encKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: iv.tag.ciphertext (all base64)
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decryptSecret(blob) {
  try {
    const [ivB, tagB, dataB] = String(blob).split('.');
    if (!ivB || !tagB || !dataB) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', _encKey(),
      Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

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

module.exports = { asyncHandler, ok, fail, genVoucherCode, encryptSecret, decryptSecret };