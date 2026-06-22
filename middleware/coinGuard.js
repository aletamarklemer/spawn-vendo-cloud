'use strict';
/**
 * middleware/coinGuard.js
 * -----------------------
 * Anti-fraud para sa coin acceptor manipulation (lighter, signal spam, tampering).
 *
 * Duha ka layer:
 *  1. PER-DEVICE RATE LIMIT — max coins kada minuto kada device.
 *     Ang realistic max sa physical coin acceptor kay ~20-30/min.
 *     Kung sobra → block (lagmit spam/lighter).
 *  2. BURST DETECTION — kung ang coins sunod-sunod nga sobra ka-paspas
 *     (< MIN_GAP_MS apart), suspicious (electronic spam, dili tawo).
 *
 * In-memory tracker (walay extra DB). Reset kada server restart — OK ra
 * kay short-window detection man. Per-device, dili global.
 *
 * Naa pud audit logging para makita nimo ang suspicious devices.
 */

// --- Config (i-adjust base sa imong coin acceptor) ---
const WINDOW_MS   = 60 * 1000;  // 1 minuto nga window
const MAX_PER_MIN = 25;         // max coins kada minuto kada device (realistic limit)
const MIN_GAP_MS  = 400;        // pinaka-mubo nga gap tali sa coins (< ani = burst/spam)
const BURST_LIMIT = 3;          // pila ka sunod-sunod nga burst bag-o mo-block

// device_id -> { times: [timestamps], bursts: int, blockedUntil: ts }
const tracker = new Map();
const BLOCK_DURATION_MS = 5 * 60 * 1000; // 5 min cooldown kung na-block

// Cleanup daan nga entries kada 5 min (para dili mo-grow ang memory)
setInterval(() => {
  const now = Date.now();
  for (const [dev, rec] of tracker.entries()) {
    rec.times = rec.times.filter(t => now - t < WINDOW_MS);
    if (rec.times.length === 0 && (!rec.blockedUntil || rec.blockedUntil < now)) {
      tracker.delete(dev);
    }
  }
}, 5 * 60 * 1000);

/**
 * coinGuard middleware — i-apply sa coin insert endpoints.
 * Mo-block kung suspicious, mo-log sa fraud attempts.
 */
function coinGuard(req, res, next) {
  const deviceId = (req.body && (req.body.device_id)) || req.headers['x-device-id'] || 'unknown';
  const now = Date.now();

  let rec = tracker.get(deviceId);
  if (!rec) {
    rec = { times: [], bursts: 0, blockedUntil: 0, lastLog: 0 };
    tracker.set(deviceId, rec);
  }

  // Naka-block pa ba?
  if (rec.blockedUntil && rec.blockedUntil > now) {
    const secs = Math.ceil((rec.blockedUntil - now) / 1000);
    logSuspicious(deviceId, `blocked (cooldown ${secs}s)`, rec);
    return res.status(429).json({
      success: false,
      error: 'Coin acceptor temporarily locked (suspicious activity). Pasensya, sulayi pag-usab.',
      retryAfter: secs,
    });
  }

  // Prune daan nga timestamps (gawas sa window)
  rec.times = rec.times.filter(t => now - t < WINDOW_MS);

  // --- LAYER 2: Burst detection (sobra ka-paspas nga sunod-sunod) ---
  const lastTime = rec.times.length ? rec.times[rec.times.length - 1] : 0;
  const gap = now - lastTime;
  if (lastTime && gap < MIN_GAP_MS) {
    rec.bursts++;
    if (rec.bursts >= BURST_LIMIT) {
      rec.blockedUntil = now + BLOCK_DURATION_MS;
      rec.bursts = 0;
      logSuspicious(deviceId, `BURST detected (gap=${gap}ms) — BLOCKED ${BLOCK_DURATION_MS/60000}min`, rec);
      return res.status(429).json({
        success: false,
        error: 'Coin acceptor locked: sobra ka-paspas nga coins (posible nga tampering).',
        retryAfter: BLOCK_DURATION_MS / 1000,
      });
    }
  } else {
    // Normal gap — reset burst counter
    rec.bursts = 0;
  }

  // --- LAYER 1: Per-device rate limit ---
  if (rec.times.length >= MAX_PER_MIN) {
    rec.blockedUntil = now + BLOCK_DURATION_MS;
    logSuspicious(deviceId, `RATE LIMIT (${rec.times.length}/${MAX_PER_MIN} per min) — BLOCKED`, rec);
    return res.status(429).json({
      success: false,
      error: 'Coin acceptor locked: sobra ka-daghang coins sa mubo nga oras.',
      retryAfter: BLOCK_DURATION_MS / 1000,
    });
  }

  // OK — record kini nga coin
  rec.times.push(now);
  next();
}

/** Log suspicious activity (throttled — dili mag-spam sa logs) */
function logSuspicious(deviceId, reason, rec) {
  const now = Date.now();
  if (now - (rec.lastLog || 0) < 5000) return; // throttle: 1 log kada 5s kada device
  rec.lastLog = now;
  console.warn(`[COIN-FRAUD] device=${deviceId} — ${reason} (count=${rec.times.length})`);
}

/** Export ang current suspicious devices (para sa dashboard/monitoring) */
function getSuspiciousDevices() {
  const now = Date.now();
  const out = [];
  for (const [dev, rec] of tracker.entries()) {
    if (rec.blockedUntil && rec.blockedUntil > now) {
      out.push({ device_id: dev, blocked: true, retryAfter: Math.ceil((rec.blockedUntil - now)/1000), recentCoins: rec.times.length });
    }
  }
  return out;
}

module.exports = { coinGuard, getSuspiciousDevices };