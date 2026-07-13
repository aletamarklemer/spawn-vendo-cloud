/* SpawnCloud Manager — app logic.
   Phase 1: login → device list → per-device rates editor.
   Backend contract (existing Spawn Vendo API):
     POST /auth/login              -> { token, profile }
     GET  /devices                 -> { devices: [...] }
     GET  /admin/pricing-tiers?device_id=X -> { tiers, device_id }
     PUT  /admin/pricing-tiers  body { device_id, tiers }
*/

let DEVICES = [];
let CURRENT = null;        // selected device
let GLOBAL_TIERS = [];     // fallback default tiers

/* ---------------- toast ---------------- */
let __toastT = null;
function toast(msg, kind) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show ' + (kind || '');
  clearTimeout(__toastT);
  __toastT = setTimeout(() => { t.className = ''; }, 2800);
}

/* ---------------- screens ---------------- */
function show(id) {
  document.querySelectorAll('#app-frame .screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function showDevices() { show('screen-devices'); }

/* ---------------- login ---------------- */
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-pass').value;
  const btn = document.getElementById('btn-login');
  if (!email || !pass) { toast('Enter your email and password', 'err'); return; }

  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const { token, profile } = await API.post('/auth/login', { email, password: pass });
    Auth.token = token;
    Auth.user = profile;
    enterApp();
  } catch (e) {
    toast(e.message || 'Sign in failed', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}

function doLogout() {
  Auth.clear();
  document.getElementById('app-frame').style.display = 'none';
  document.getElementById('screen-login').classList.add('active');
  document.getElementById('login-pass').value = '';
}

function enterApp() {
  document.getElementById('screen-login').classList.remove('active');
  document.getElementById('app-frame').style.display = 'block';
  const u = Auth.user || {};
  document.getElementById('role-chip').textContent = u.role || 'staff';
  loadDevices();
}

/* ---------------- devices ---------------- */
async function loadDevices() {
  const list = document.getElementById('device-list');
  list.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const { devices } = await API.get('/devices');
    DEVICES = devices || [];
    renderDevices(DEVICES);
    document.getElementById('device-count').textContent = DEVICES.length + ' units';
  } catch (e) {
    list.innerHTML = emptyState('Could not load vendos', e.message);
  }
}

function renderDevices(items) {
  const list = document.getElementById('device-list');
  if (!items.length) {
    list.innerHTML = emptyState('No vendos found', 'Try a different search.');
    return;
  }
  list.innerHTML = items.map((d) => {
    const st = d.router_online ? 'online' : (d.status === 'offline' ? 'offline' : 'unknown');
    const loc = [d.location, d.area].filter(Boolean).join(' · ') || 'No location set';
    const roam = d.ssid ? `<span class="device-tag roam">📶 ${esc(d.ssid)}</span>` : '';
    return `
      <div class="device" onclick="openDevice('${d.id}')">
        <span class="device-status ${st}"></span>
        <div class="device-body">
          <div class="device-name">${esc(d.device_name || 'Unnamed')}</div>
          <div class="device-meta">${esc(loc)}</div>
        </div>
        ${roam}
        <svg class="device-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
      </div>`;
  }).join('');
}

function filterDevices() {
  const q = document.getElementById('device-search').value.trim().toLowerCase();
  if (!q) return renderDevices(DEVICES);
  renderDevices(DEVICES.filter((d) =>
    [d.device_name, d.location, d.area, d.ssid, d.id]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
  ));
}

/* ---------------- device detail + rates ---------------- */
async function openDevice(id) {
  CURRENT = DEVICES.find((d) => d.id === id);
  if (!CURRENT) return;
  document.getElementById('detail-name').textContent = CURRENT.device_name || 'Unnamed';
  document.getElementById('detail-sub').textContent =
    [CURRENT.location, CURRENT.area].filter(Boolean).join(' · ') || CURRENT.id;

  // status strip
  const st = CURRENT.router_online ? 'online' : (CURRENT.status === 'offline' ? 'offline' : 'unknown');
  const stTxt = st === 'online' ? 'Online' : st === 'offline' ? 'Offline' : 'Unknown';
  document.getElementById('detail-status').innerHTML = `
    <span class="stat-pill"><span class="device-status ${st}"></span><span class="lbl">Router</span> <b>${stTxt}</b></span>
    ${CURRENT.ssid ? `<span class="stat-pill"><span class="lbl">Roam</span> <b>${esc(CURRENT.ssid)}</b></span>` : ''}
    ${CURRENT.clients_connected != null ? `<span class="stat-pill"><span class="lbl">Clients</span> <b>${CURRENT.clients_connected}</b></span>` : ''}
  `;
  // v2 (Phase 2): SSID editor
  const si = document.getElementById('ssid-input');
  si.value = CURRENT.ssid || '';
  si.dataset.orig = CURRENT.ssid || '';
  document.getElementById('ssid-roam').textContent = CURRENT.ssid ? 'ROAM GROUP KEY' : 'NOT SET';
  document.getElementById('ssid-warn').style.display = 'none';
  document.getElementById('btn-save-ssid').disabled = true;

  show('screen-detail');
  loadRates(id);
}

/* ---------------- SSID (Phase 2) ---------------- */
function ssidChanged() {
  const si = document.getElementById('ssid-input');
  const changed = si.value.trim() !== (si.dataset.orig || '');
  document.getElementById('btn-save-ssid').disabled = !changed;
  document.getElementById('ssid-warn').style.display = changed ? 'flex' : 'none';
}

async function saveSsid() {
  if (!CURRENT) return;
  const si = document.getElementById('ssid-input');
  const name = si.value.trim();
  if (!name) { toast('WiFi name cannot be empty', 'err'); return; }
  if (name.length > 32) { toast('Max 32 characters', 'err'); return; }
  if (!/^[A-Za-z0-9 ._-]+$/.test(name)) { toast('Letters, numbers, space, dot, dash, underscore only', 'err'); return; }
  if (!confirm('Change WiFi name to "' + name + '"?\n\nUsers on this vendo will briefly disconnect and must rejoin the new network.')) return;

  const btn = document.getElementById('btn-save-ssid');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await API.patch('/devices/' + CURRENT.id, { ssid: name });
    CURRENT.ssid = name;
    si.dataset.orig = name;
    document.getElementById('ssid-roam').textContent = 'ROAM GROUP KEY';
    document.getElementById('ssid-warn').style.display = 'none';
    toast('WiFi name saved — the router applies it within seconds', 'ok');
    const d = DEVICES.find((x) => x.id === CURRENT.id);
    if (d) d.ssid = name;
  } catch (e) {
    toast(e.message || 'Could not save WiFi name', 'err');
    btn.disabled = false;
  } finally {
    btn.textContent = 'Save WiFi name';
  }
}

async function loadRates(deviceId) {
  const rowsEl = document.getElementById('rates-rows');
  rowsEl.innerHTML = '<div class="skeleton" style="height:52px"></div><div class="skeleton" style="height:52px"></div>';
  try {
    // load global default first (fallback template) + this device's tiers
    const [globalRes, devRes] = await Promise.all([
      API.get('/admin/pricing-tiers'),
      API.get('/admin/pricing-tiers?device_id=' + encodeURIComponent(deviceId)),
    ]);
    GLOBAL_TIERS = globalRes.tiers || [];
    const devTiers = devRes.tiers || [];
    const usingGlobal = devTiers.length === 0;

    document.getElementById('rates-source').textContent = usingGlobal ? 'GLOBAL DEFAULT' : 'THIS VENDO';
    document.getElementById('rates-notice').style.display = usingGlobal ? 'flex' : 'none';

    // if using global, pre-fill the editor with the global tiers as a starting point
    const tiers = usingGlobal ? GLOBAL_TIERS : devTiers;
    renderRates(tiers);
  } catch (e) {
    rowsEl.innerHTML = emptyState('Could not load rates', e.message);
  }
}

function renderRates(tiers) {
  const rowsEl = document.getElementById('rates-rows');
  if (!tiers.length) {
    rowsEl.innerHTML = emptyState('No rates set', 'Add tiers below or reset to global default.');
    return;
  }
  rowsEl.innerHTML = tiers.map((t, i) => `
    <div class="rate-row" data-i="${i}">
      <div class="rate-coin">₱${Number(t.amount)}</div>
      <div class="rate-input-group">
        <input type="number" min="1" class="input-mono r-val" value="${t.duration_value}" inputmode="numeric">
        <select class="r-unit">
          <option value="minute" ${t.duration_unit === 'minute' ? 'selected' : ''}>min</option>
          <option value="hour"   ${t.duration_unit === 'hour'   ? 'selected' : ''}>hrs</option>
          <option value="day"    ${t.duration_unit === 'day'    ? 'selected' : ''}>day</option>
        </select>
      </div>
      <input type="number" min="1" class="input-mono r-amt" value="${Number(t.amount)}" inputmode="numeric" title="Coin amount ₱" style="text-align:center">
    </div>
  `).join('');
}

function collectRates() {
  const rows = [...document.querySelectorAll('#rates-rows .rate-row')];
  return rows.map((row) => ({
    amount: Number(row.querySelector('.r-amt').value),
    duration_value: parseInt(row.querySelector('.r-val').value, 10),
    duration_unit: row.querySelector('.r-unit').value,
  }));
}

async function saveRates() {
  if (!CURRENT) return;
  const tiers = collectRates();
  // client-side guard
  for (const t of tiers) {
    if (!t.amount || t.amount <= 0) { toast('Coin amount must be greater than 0', 'err'); return; }
    if (!t.duration_value || t.duration_value <= 0) { toast('Duration must be greater than 0', 'err'); return; }
  }
  const btn = document.getElementById('btn-save-rates');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await API.put('/admin/pricing-tiers', { device_id: CURRENT.id, tiers });
    toast('Rates saved for ' + (CURRENT.device_name || 'this vendo'), 'ok');
    document.getElementById('rates-source').textContent = 'THIS VENDO';
    document.getElementById('rates-notice').style.display = 'none';
  } catch (e) {
    toast(e.message || 'Could not save rates', 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Save rates';
  }
}

async function resetToGlobal() {
  if (!CURRENT) return;
  if (!confirm('Reset this vendo to the global default rates? Its custom rates will be removed.')) return;
  const btn = document.getElementById('btn-save-rates');
  btn.disabled = true;
  try {
    // empty tiers for this device = clears the per-device override
    await API.put('/admin/pricing-tiers', { device_id: CURRENT.id, tiers: [] });
    toast('Reset to global default', 'ok');
    loadRates(CURRENT.id);
  } catch (e) {
    toast(e.message || 'Could not reset', 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- helpers ---------------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function emptyState(title, sub) {
  return `<div class="empty">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/></svg>
    <div style="font-weight:600;color:var(--txt-dim);margin-bottom:4px">${esc(title)}</div>
    <div style="font-size:13px">${esc(sub || '')}</div>
  </div>`;
}

/* Enter key on login */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.getElementById('screen-login').classList.contains('active')) doLogin();
});

/* Resume session on refresh */
if (Auth.token && Auth.user) { enterApp(); }
