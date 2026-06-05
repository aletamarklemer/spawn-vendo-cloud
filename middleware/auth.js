'use strict';
/**
 * middleware/auth.js
 * ------------------
 * Two auth surfaces:
 *  1. Staff (admin/technician/operator) — log in via Supabase Auth on the
 *     server, then we mint our OWN short-lived JWT carrying {sub, role}.
 *     `authenticate` verifies that JWT on subsequent requests.
 *  2. Devices (vendo firmware) — authenticate with a static x-device-key
 *     header (DEVICE_API_KEY). `deviceAuth` guards the coin endpoint.
 */
const jwt = require('jsonwebtoken');
const { fail } = require('../utils/helpers');

const { JWT_SECRET, JWT_EXPIRES_IN = '12h', DEVICE_API_KEY } = process.env;

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function authenticate(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return fail(res, 'Missing bearer token', 401);
  try {
    req.user = jwt.verify(token, JWT_SECRET); // { sub, role, email }
    next();
  } catch {
    return fail(res, 'Invalid or expired token', 401);
  }
}

// Role-based access control. Usage: authorize('admin'), authorize('admin','operator')
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return fail(res, 'Unauthenticated', 401);
    if (roles.length && !roles.includes(req.user.role))
      return fail(res, 'Forbidden: insufficient role', 403);
    next();
  };
}

function deviceAuth(req, res, next) {
  const key = req.headers['x-device-key'];
  if (!key || key !== DEVICE_API_KEY) return fail(res, 'Invalid device key', 401);
  next();
}

module.exports = { signToken, authenticate, authorize, deviceAuth };
