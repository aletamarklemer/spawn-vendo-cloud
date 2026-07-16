'use strict';
/**
 * utils/autopause.js — AUTO-PAUSE / AUTO-RESUME (presence-based, roaming-safe)
 * ---------------------------------------------------------------------------
 * Kung ang customer mo-disconnect sa WiFi: ~2.5-5s = AUTO-PAUSE (oras frozen).
 * Kung mobalik siya (associate sa BISAN ASA nga vendo sa iyang roam group):
 * AUTO-RESUME dayon + connect_requested=true = INSTANT AUTH sa enforce =
 * internet nga WALAY portal.
 *
 * SAFETY DESIGN (mga leksyon gikan sa Jun 30 validity bug + Jul 10 roaming analysis):
 *  1. ROAMING-SAFE: presence = union sa MAC reports sa TANAN vendos sa ssid
 *     group. Ang customer nga naa sa vendo2 DILI i-pause sa vendo1.
 *  2. UNKNOWN != ABSENT: kung walay vendo sa group nga nag-report og presko
 *     nga MAC list (offline / WAN down / old enforce nga walay m= param),
 *     WALAY pause. Ang hm flag sa liveness ang guard sa old-enforce case.
 *  3. VALIDITY INTACT: auto-pause DILI mo-hilabot sa manual_paused_at (ang
 *     validity clock sa manual pause). Lahi nga kolum: auto_paused_at.
 *     Ang auto-paused mo-expire pud human sa pause_validity_days (per Wendell).
 *  4. MANUAL PAUSE = MANUAL RESUME: ang presence sweep mo-resume RA sa mga
 *     pause nga AUTO (auto_paused_at set). Ang manual pause magpabilin
 *     hangtod ang customer mo-Resume sa portal (respeto sa intent).
 *  5. BOOT-HOLD: walay auto-pause sulod sa unang 60s human mag-boot ang
 *     backend (walay pa MAC data = walay false mass-pause sa deploy).
 *  6. RACE GUARDS: ang matag update naay .eq('status', ...) condition — kung
 *     nausab na ang session (coin topup, portal action), no-op ang sweep.
 *  7. BACKEND-ONLY: zero enforce/router/portal changes. Ang MAC reporting
 *     (m= sa poll) ug INSTANT AUTH kay existing na.
 *
 * Scale note (800+ vendos): usa ka indexed SELECT sa active+paused sessions
 * kada SWEEP_MS. Tunable via env AUTOPAUSE_SWEEP_MS / AUTOPAUSE_GRACE_MS.
 * I-disable via AUTOPAUSE_ENABLED=0 (instant kill-switch, walay deploy).
 */
const { supabaseAdmin } = require('../config/supabase');
const liveness = require('./liveness');
const { getDeviceSsidMap } = require('../controllers/enforcement.controller');

const ENABLED      = process.env.AUTOPAUSE_ENABLED !== '0';
const SWEEP_MS     = parseInt(process.env.AUTOPAUSE_SWEEP_MS || '1500', 10);
const GRACE_MS     = parseInt(process.env.AUTOPAUSE_GRACE_MS || '8000', 10);  // v2: 2500->8000 - ang mugbo nga band-hop/power-save blips sa phone dili na mo-flap og pause/resume; tinuod nga paglakaw ma-detect gihapon sulod 8s
const FRESH_MS     = 8000;        // device report presko kung sulod sa 8s
const BOOT_HOLD_MS = 60 * 1000;   // walay pause sulod sa unang 60s human sa boot
const BOOT_AT      = Date.now();

// DB nag-store og 'MAC:XX:XX:...' prefix; ang vendos nag-report og plain 'XX:XX:...'.
// I-strip ang prefix para mo-match ang presence (KRITIKAL — kung dili, ma-pause ang connected!).
const norm = (m) => String(m || '').trim().toUpperCase().replace(/-/g, ':').replace(/^MAC:/, '');
const absentSince = new Map();    // session_id -> unang nakita nga absent (ms)

let _validityCache = { ms: null, at: 0 };
async function getValidityMs() {
  const now = Date.now();
  if (_validityCache.ms !== null && (now - _validityCache.at) < 60000) return _validityCache.ms;
  try {
    const { data } = await supabaseAdmin
      .from('settings').select('pause_validity_days')
      .eq('is_active', true).order('updated_at', { ascending: false })
      .limit(1).maybeSingle();
    const days = (data && data.pause_validity_days) || 3;
    _validityCache = { ms: days * 24 * 60 * 60 * 1000, at: now };
  } catch (e) {
    if (_validityCache.ms === null) _validityCache = { ms: 3 * 24 * 60 * 60 * 1000, at: now };
  }
  return _validityCache.ms;
}

function groupMembers(deviceId, ssidMap) {
  const g = deviceId ? ssidMap[deviceId] : null;
  if (!g) return deviceId ? [deviceId] : [];
  return Object.keys(ssidMap).filter((id) => ssidMap[id] === g);
}

/* presence: { anyFresh, present }
   anyFresh = naay bisan usa ka vendo sa group nga presko ang MAC-list report
   present  = ang MAC nakita sa bisan asa nga presko nga report */
function presence(mac, members, now) {
  let anyFresh = false, present = false;
  for (const id of members) {
    const st = liveness.rawStats(id);
    if (!st || !st.hm) continue;               // old enforce / walay MAC list = dili saligan
    if (now - st.at > FRESH_MS) continue;      // stale report = dili saligan
    anyFresh = true;
    if ((st.macs || []).includes(mac)) { present = true; break; }
  }
  return { anyFresh, present };
}

async function autoPause(s, now) {
  const remaining = Math.max(0, Math.floor((new Date(s.end_time).getTime() - now) / 1000));
  if (remaining <= 10) {
    await supabaseAdmin.from('internet_sessions')
      .update({ status: 'expired' }).eq('id', s.id).eq('status', 'active');
    return;
  }
  const upd = {
    status: 'paused', remaining_seconds: remaining, end_time: null,
    auto_paused_at: new Date(now).toISOString(),
  };
  if (!s.first_paused_at) upd.first_paused_at = new Date(now).toISOString();
  const { error } = await supabaseAdmin.from('internet_sessions')
    .update(upd).eq('id', s.id).eq('status', 'active');  // race guard
  if (!error) console.log(`[autopause] PAUSED ${s.client_mac} (${remaining}s frozen)`);
}

async function autoResume(s, now) {
  const remaining = s.remaining_seconds || 0;
  if (remaining <= 10) {
    await supabaseAdmin.from('internet_sessions')
      .update({ status: 'expired' }).eq('id', s.id).eq('status', 'paused');
    return;
  }
  const upd = {
    status: 'active',
    end_time: new Date(now + remaining * 1000).toISOString(),
    connect_requested: true,   // = INSTANT AUTH sa enforce, internet nga walay portal
    auto_paused_at: null,
  };
  const { error } = await supabaseAdmin.from('internet_sessions')
    .update(upd).eq('id', s.id).eq('status', 'paused');  // race guard
  if (!error) console.log(`[auto-connect] ${s.client_mac} (${remaining}s restored, presence-sweep)`);
}

async function handleSession(s, ssidMap, now) {
  const mac = norm(s.client_mac);
  if (!mac || mac.startsWith('TEST')) return;   // skip test rows (prefix na-strip na)
  const members = groupMembers(s.device_id, ssidMap);
  if (!members.length) return;
  const { anyFresh, present } = presence(mac, members, now);

  if (s.status === 'active') {
    if (!anyFresh || present) { absentSince.delete(s.id); return; }  // unknown != absent
    if (!absentSince.has(s.id)) absentSince.set(s.id, now);
    if (now - absentSince.get(s.id) >= GRACE_MS) {
      absentSince.delete(s.id);
      await autoPause(s, now);
    }
    return;
  }

  // status === 'paused'
  absentSince.delete(s.id);
  const VMS = await getValidityMs();
  const manualDead = s.manual_paused_at && (now - new Date(s.manual_paused_at).getTime() > VMS);
  const autoDead   = s.auto_paused_at   && (now - new Date(s.auto_paused_at).getTime()   > VMS);
  if (manualDead || autoDead) {
    await supabaseAdmin.from('internet_sessions')
      .update({ status: 'expired' }).eq('id', s.id).eq('status', 'paused');
    return;
  }
  // AUTO-RESUME: kung ang kasamtangang pause kay AUTO ug presente na balik ang MAC
  if (s.auto_paused_at && present) await autoResume(s, now);
}

let _running = false;
async function sweep() {
  if (_running) return;   // walay overlap
  _running = true;
  try {
    const now = Date.now();
    if (now - BOOT_AT < BOOT_HOLD_MS) return;
    const ssidMap = await getDeviceSsidMap();
    const { data, error } = await supabaseAdmin
      .from('internet_sessions')
      .select('id, client_mac, device_id, status, end_time, remaining_seconds, first_paused_at, manual_paused_at, auto_paused_at')
      .in('status', ['active', 'paused']);
    if (error || !data || !data.length) return;
    for (const s of data) {
      try { await handleSession(s, ssidMap, now); } catch (e) { /* per-session isolation */ }
    }
    const ids = new Set(data.map((s) => s.id));
    for (const k of absentSince.keys()) if (!ids.has(k)) absentSince.delete(k);
  } catch (e) { /* ang sweep dili gyud mo-crash sa app */ }
  finally { _running = false; }
}

function start() {
  if (!ENABLED) { console.log('[autopause] DISABLED via AUTOPAUSE_ENABLED=0'); return; }
  setInterval(sweep, SWEEP_MS);
  console.log(`[autopause] presence sweep started (every ${SWEEP_MS}ms, grace ${GRACE_MS}ms, boot-hold 60s)`);
}

module.exports = { start };