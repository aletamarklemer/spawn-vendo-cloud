'use strict';
/** middleware/error.js */
const { fail } = require('../utils/helpers');

function notFound(req, res) {
  return fail(res, `Not found: ${req.method} ${req.originalUrl}`, 404);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[error]', err.message);
  const status = err.status || 500;
  const msg = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message;
  return fail(res, msg, status);
}

module.exports = { notFound, errorHandler };
