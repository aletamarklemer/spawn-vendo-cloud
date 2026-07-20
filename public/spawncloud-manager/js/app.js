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
  document.getElementById('role-chip').textContent = (u.role === 'technician') ? 'lineman' : (u.role || 'staff');
  var wb = document.getElementById('btn-wizard');
  if (wb) wb.style.display = (u.role === 'admin') ? '' : 'none';
  loadDevices();
  // Operators (collectors) land straight on the Collections dashboard.
  if (u.role === 'operator') openCollect();
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
  loadWireless(id);
}

/* ---------------- WiFi Networks visibility (Phase 2.5A, read-only) ---------------- */
async function loadWireless(id) {
  const box = document.getElementById('wifi-networks');
  const fr = document.getElementById('wifi-fresh');
  box.innerHTML = '<div class="skeleton" style="height:52px"></div>';
  fr.textContent = '';
  try {
    const d = await API.get('/devices/' + id + '/wireless');
    if (!d.fresh || !d.networks.length) {
      fr.textContent = 'UNKNOWN';
      box.innerHTML = '<div class="empty-note">No data yet \u2014 the router reports its networks while online (enforce v26+).</div>';
      return;
    }
    fr.textContent = 'LIVE';
    WNETS = d.networks;
    box.innerHTML = d.networks.map(function (n, i) {
      const chips =
        '<span class="chip">' + esc(n.band) + '</span>' +
        (n.hidden ? '<span class="chip chip-warn">HIDDEN</span>' : '') +
        (n.disabled ? '<span class="chip chip-warn">OFF</span>' : '');
      const hint = n.hidden ? '<div class="net-hint">\uD83D\uDD0C likely node link \u2014 changes may disconnect the coin slot</div>' : '';
      const btns =
        '<button class="btn-mini" onclick="netHide(' + i + ')">' + (n.hidden ? 'Show' : 'Hide') + '</button>' +
        '<button class="btn-mini btn-mini-danger" onclick="netDel(' + i + ')">Delete</button>';
      return '<div class="net-row"><div><div class="net-ssid">' + esc(n.ssid || '(blank)') + '</div>' + hint +
        '<div class="net-hint" style="opacity:.6">' + esc(n.section) + '</div></div>' +
        '<div><div class="net-chips">' + chips + '</div><div class="net-acts">' + btns + '</div></div></div>';
    }).join('');
  } catch (e) {
    fr.textContent = '';
    box.innerHTML = '<div class="empty-note">' + esc(e.message || 'Could not load networks') + '</div>';
  }
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }

/* ---------------- WiFi write controls (Phase 2.5B) ---------------- */
let WNETS = [];

async function postWifiCmd(action, params, confirmMsg) {
  if (!CURRENT) return;
  if (confirmMsg && !confirm(confirmMsg)) return;
  try {
    await API.post('/devices/' + CURRENT.id + '/wifi-command', { action: action, params: params });
    toast('Command sent \u2014 the router applies it in ~10-15s', 'ok');
    setTimeout(function () { loadWireless(CURRENT.id); }, 12000);
    setTimeout(function () { loadWireless(CURRENT.id); }, 20000);
  } catch (e) {
    toast(e.message || 'Command failed', 'err');
  }
}

function netHide(i) {
  const n = WNETS[i]; if (!n) return;
  const toHidden = !n.hidden;
  let msg = (toHidden ? 'Hide' : 'Show') + ' "' + n.ssid + '" (' + n.band + ')?\n\nWiFi will briefly reload (~5-10s blip for users).';
  if (n.hidden && !toHidden) msg = 'Show the hidden network "' + n.ssid + '"?\n\nIf this is the node link, exposing it is usually harmless but unnecessary.';
  postWifiCmd('set_hidden', { section: n.section, hidden: toHidden }, msg);
}

function netDel(i) {
  const n = WNETS[i]; if (!n) return;
  let msg = 'DELETE network "' + n.ssid + '" (' + n.band + ', ' + n.section + ')?\n\nThis removes it from the router. WiFi will reload.';
  if (n.hidden) msg = '\u26A0\uFE0F WARNING: "' + n.ssid + '" is HIDDEN \u2014 likely the NODE (coin slot) link!\n\nDeleting it will take the coin slot OFFLINE until reconfigured.\n\nDelete anyway?';
  postWifiCmd('del_iface', { section: n.section }, msg);
}

function toggleAddNet(show) {
  document.getElementById('wifi-add-card').style.display = show ? 'block' : 'none';
  document.getElementById('btn-add-net').style.display = show ? 'none' : 'block';
  if (show) document.getElementById('add-ssid').focus();
}

function submitAddNet() {
  const ssid = document.getElementById('add-ssid').value.trim();
  const band = document.getElementById('add-band').value;
  const hidden = document.getElementById('add-hidden').checked;
  if (!/^[A-Za-z0-9 ._-]{1,32}$/.test(ssid)) { toast('Letters, numbers, space, dot, dash, underscore only (max 32)', 'err'); return; }
  const section = 'sc_' + ssid.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  if (section.length < 4) { toast('Name too short', 'err'); return; }
  toggleAddNet(false);
  document.getElementById('add-ssid').value = '';
  postWifiCmd('add_iface', { section: section, ssid: ssid, band: band, hidden: hidden },
    'Add ' + (hidden ? 'HIDDEN ' : '') + 'network "' + ssid + '" (' + (band === 'both' ? '2.4G+5G' : band === 'radio0' ? '2.4G' : '5G') + ')?\n\nWiFi will briefly reload.');
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

/* ---------------- INSTALLER WIZARD (Phase 3, admin-only) ---------------- */
let WIZ = { device: null, watchT: null, nodeT: null, hasNode: true };

function openWizard() {
  if ((Auth.user || {}).role !== 'admin') { toast('Admin only', 'err'); return; }
  WIZ = { device: null, watchT: null, nodeT: null, hasNode: true };
  ['wiz-name', 'wiz-mac', 'wiz-loc', 'wiz-area', 'wiz-ssid', 'wiz-roam'].forEach(function (id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('wiz-lan').value = '10.0.0.1';
  document.getElementById('wiz-did-card').style.display = 'none';
  document.getElementById('wiz-next-1').disabled = true;
  document.getElementById('wiz-next-3').disabled = true;
  document.getElementById('wiz-reg-btn').disabled = false;
  document.getElementById('wiz-reg-btn').textContent = 'Register & get DEVICE_ID';
  document.querySelectorAll('#screen-wizard .wiz-check input').forEach(function (c) { c.checked = false; });
  wizStep(1);
  show('screen-wizard');
}

function closeWizard() {
  wizStopWatchers();
  loadDevices();
  showDevices();
}

function wizStopWatchers() {
  if (WIZ.watchT) { clearInterval(WIZ.watchT); WIZ.watchT = null; }
  if (WIZ.nodeT) { clearInterval(WIZ.nodeT); WIZ.nodeT = null; }
}

function wizStep(n) {
  for (var i = 1; i <= 5; i++) {
    var el = document.getElementById('wiz-' + i);
    if (el) el.style.display = (i === n) ? '' : 'none';
  }
  var dots = document.querySelectorAll('#wiz-progress .wdot');
  dots.forEach(function (d, i) { d.className = 'wdot' + (i < n ? ' active' : ''); });
  if (n === 2) wizBuildCmds();
  if (n === 3) wizStartRouterWatch();
  if (n === 4 && WIZ.device && !document.getElementById('wiz-roam').value) {
    document.getElementById('wiz-roam').value = document.getElementById('wiz-ssid').value.trim();
  }
  if (n === 5) wizStartNodeWatch();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function wizRegister() {
  var name = document.getElementById('wiz-name').value.trim();
  var mac = document.getElementById('wiz-mac').value.trim();
  var loc = document.getElementById('wiz-loc').value.trim();
  var area = document.getElementById('wiz-area').value.trim();
  if (!name || !mac) { toast('Device name and MAC are required', 'err'); return; }
  if (!/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(mac)) { toast('MAC format: AA:BB:CC:DD:EE:FF', 'err'); return; }
  var btn = document.getElementById('wiz-reg-btn');
  btn.disabled = true; btn.textContent = 'Registering\u2026';
  try {
    var r = await API.post('/devices', { device_name: name, mac_address: mac.toUpperCase(), location: loc, area: area });
    WIZ.device = r.device;
    document.getElementById('wiz-did').textContent = WIZ.device.id;
    document.getElementById('wiz-did-card').style.display = '';
    document.getElementById('wiz-next-1').disabled = false;
    btn.textContent = 'Registered \u2713';
    toast('Device registered!', 'ok');
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Register & get DEVICE_ID';
    toast(e.message || 'Register failed', 'err');
  }
}

function wizBuildCmds() {
  if (!WIZ.device) return;
  var ssid = document.getElementById('wiz-ssid').value.trim() || 'SpawnCloud';
  var lan = document.getElementById('wiz-lan').value.trim() || '10.0.0.1';
  var c = '# ===== 1. WAN SETUP (SSH router, fresh LAN = 192.168.1.1) =====\n' +
    '# Router-mode: WAN/LAN3 port -> LAN port sa PPPoE router (internet feed)\n' +
    'uci set network.wan.proto=dhcp; uci commit network; /etc/init.d/network restart\n' +
    'sleep 12; ping -c 3 8.8.8.8            # dapat 0% loss\n' +
    'ping -c 5 -s 1464 8.8.8.8              # kung naay loss: MTU 1492 fix (tan-awa guide)\n\n' +
    '# ===== 2. DEPLOY (CMD/PC) =====\n' +
    'scp -O "C:\\Users\\acer\\Desktop\\Automate Multi Vendo Update\\spawn-golden-v30.tar.gz" root@192.168.1.1:/tmp/spawn-golden.tar.gz\n' +
    'scp -O "C:\\Users\\acer\\Desktop\\Automate Multi Vendo Update\\deploy-vendo-v5.4.sh" root@192.168.1.1:/tmp/deploy-vendo.sh\n\n' +
    '# ===== 3. RUN DEPLOY (SSH router) =====\n' +
    'sh /tmp/deploy-vendo.sh\n' +
    '#   DEVICE_ID : ' + WIZ.device.id + '\n' +
    '#   LAN IP    : ' + lan + '\n' +
    '#   SSID      : ' + ssid + '\n' +
    'reboot\n\n' +
    '# ===== 4. MTU 1492 (kung luyo sa PPPoE router) - ssh root@10.0.0.1 =====\n' +
    'uci set network.@device[4].mtu=\'1492\'; uci commit network; ip link set dev wan mtu 1492\n' +
    'ip link show wan | grep -o "mtu [0-9]*"     # dapat: mtu 1492';
  document.getElementById('wiz-cmds').textContent = c;
}

function wizCopy(id) {
  var t = document.getElementById(id).textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(function () { toast('Copied!', 'ok'); }, function () { toast('Copy failed', 'err'); });
  } else { toast('Copy not available', 'err'); }
}

function wizStartRouterWatch() {
  wizStopWatchers();
  if (!WIZ.device) return;
  var box = document.getElementById('wiz-router-watch');
  box.innerHTML = '<span class="spin"></span> Waiting for the router\u2019s first poll\u2026';
  var check = async function () {
    try {
      var r = await API.get('/devices');
      var d = (r.devices || []).find(function (x) { return x.id === WIZ.device.id; });
      if (d && d.router_online) {
        box.innerHTML = '\u2705 <b>Router ONLINE!</b> Deploy verified \u2014 the vendo is polling the cloud.';
        document.getElementById('wiz-next-3').disabled = false;
        clearInterval(WIZ.watchT); WIZ.watchT = null;
      }
    } catch (e) { /* keep watching */ }
  };
  check();
  WIZ.watchT = setInterval(check, 8000);
}

async function wizSetRoam() {
  if (!WIZ.device) return;
  var v = document.getElementById('wiz-roam').value.trim();
  var btn = document.getElementById('wiz-roam-btn');
  btn.disabled = true;
  try {
    await API.patch('/devices/' + WIZ.device.id, { ssid: v || null });
    toast(v ? 'Roam group set: ' + v : 'Standalone (no roam group)', 'ok');
  } catch (e) { toast(e.message || 'Save failed', 'err'); }
  btn.disabled = false;
}

async function wizSetMode(hasNode) {
  if (!WIZ.device) return;
  try {
    await API.patch('/devices/' + WIZ.device.id, { has_node: hasNode });
    WIZ.hasNode = hasNode;
    document.getElementById('wiz-mode-vendo').className = 'btn btn-sm' + (hasNode ? '' : ' btn-ghost');
    document.getElementById('wiz-mode-ext').className = 'btn btn-sm' + (hasNode ? ' btn-ghost' : '');
    document.getElementById('wiz-mode-note').textContent = hasNode
      ? 'Vendo = flash NodeMCU fw v5 (this DEVICE_ID + shared key) via USB.'
      : 'Extender = no NodeMCU, coverage only. Customers coin at another vendo in the group and roam here.';
    toast(hasNode ? 'Mode: Vendo' : 'Mode: Extender', 'ok');
  } catch (e) { toast(e.message || 'Save failed', 'err'); }
}

function wizStartNodeWatch() {
  if (WIZ.nodeT) { clearInterval(WIZ.nodeT); WIZ.nodeT = null; }
  var card = document.getElementById('wiz-node-card');
  var box = document.getElementById('wiz-node-watch');
  if (!WIZ.hasNode) { card.style.display = 'none'; return; }
  card.style.display = '';
  if (!WIZ.device) return;
  box.innerHTML = '<span class="spin"></span> Waiting for NodeMCU heartbeat\u2026';
  var check = async function () {
    try {
      var r = await API.get('/devices');
      var d = (r.devices || []).find(function (x) { return x.id === WIZ.device.id; });
      if (d && d.node_online) {
        box.innerHTML = '\u2705 <b>Node ONLINE!</b> Coin slot heartbeat received.';
        clearInterval(WIZ.nodeT); WIZ.nodeT = null;
      }
    } catch (e) { /* keep watching */ }
  };
  check();
  WIZ.nodeT = setInterval(check, 8000);
}

function wizFinish() {
  wizStopWatchers();
  toast('Vendo ready to ship! \uD83D\uDE80', 'ok');
  loadDevices();
  showDevices();
}

/* ---------------- COLLECTIONS (operator / collector) ---------------- */
let COLLECT = [];

function peso(n) { return '\u20B1' + Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 }); }

function openCollect() {
  const back = document.getElementById('collect-back');
  if (back) back.style.display = ((Auth.user || {}).role === 'operator') ? 'none' : '';
  collectTab('vendos');
  show('screen-collect');
  loadCollectSummary();
}

function refreshCollect() {
  const onHistory = document.getElementById('collect-history-view').style.display !== 'none';
  if (onHistory) loadCollectHistory(); else loadCollectSummary();
}

function collectTab(which) {
  const vView = document.getElementById('collect-vendos-view');
  const hView = document.getElementById('collect-history-view');
  const vBtn = document.getElementById('ctab-vendos');
  const hBtn = document.getElementById('ctab-history');
  const on = 'btn btn-sm', off = 'btn btn-ghost btn-sm';
  if (which === 'history') {
    vView.style.display = 'none'; hView.style.display = '';
    vBtn.className = off; hBtn.className = on;
    loadCollectHistory();
  } else {
    vView.style.display = ''; hView.style.display = 'none';
    vBtn.className = on; hBtn.className = off;
  }
}

async function loadCollectSummary() {
  const list = document.getElementById('collect-list');
  list.innerHTML = '<div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:64px"></div>';
  try {
    const { vendos, totals } = await API.get('/collections/summary');
    COLLECT = vendos || [];
    document.getElementById('collect-grand').textContent = peso(totals ? totals.uncollected : 0);
    document.getElementById('collect-grand-sub').textContent =
      (totals ? totals.count : 0) + ' coin drops \u00B7 ' + (totals ? totals.vendos : 0) + ' vendos';
    renderCollect(COLLECT);
  } catch (e) {
    list.innerHTML = emptyState('Could not load collections', e.message);
  }
}

function filterCollect() {
  const q = document.getElementById('collect-search').value.trim().toLowerCase();
  if (!q) return renderCollect(COLLECT);
  renderCollect(COLLECT.filter((v) =>
    [v.device_name, v.location, v.area].filter(Boolean).some((s) => String(s).toLowerCase().includes(q))));
}

function renderCollect(items) {
  const list = document.getElementById('collect-list');
  if (!items.length) { list.innerHTML = emptyState('No vendos', 'Nothing to collect yet.'); return; }
  list.innerHTML = items.map((v) => {
    const st = v.router_online ? 'online' : (v.status === 'offline' ? 'offline' : 'unknown');
    const loc = [v.location, v.area].filter(Boolean).join(' \u00B7 ') || 'No location';
    const last = v.last_collected_at
      ? 'Last: ' + peso(v.last_collected_amount) + ' \u00B7 ' + timeAgo(v.last_collected_at)
      : 'Never collected';
    const has = v.uncollected > 0;
    return (
      '<div class="device" style="align-items:center">' +
        '<span class="device-status ' + st + '"></span>' +
        '<div class="device-body">' +
          '<div class="device-name">' + esc(v.device_name || 'Unnamed') + '</div>' +
          '<div class="device-meta">' + esc(loc) + '</div>' +
          '<div class="device-meta" style="opacity:.7">' + esc(last) + '</div>' +
        '</div>' +
        '<div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:6px">' +
          '<div class="mono" style="font-size:18px;font-weight:800;' + (has ? '' : 'opacity:.45') + '">' + peso(v.uncollected) + '</div>' +
          '<button class="btn btn-sm" ' + (has ? '' : 'disabled ') +
            'onclick="markCollected(\'' + v.device_id + '\')">Collect</button>' +
        '</div>' +
      '</div>'
    );
  }).join('');
}

async function markCollected(deviceId) {
  const v = COLLECT.find((x) => x.device_id === deviceId);
  if (!v) return;
  if (!(v.uncollected > 0)) { toast('Nothing to collect', 'err'); return; }
  if (!confirm('Collect ' + peso(v.uncollected) + ' from "' + (v.device_name || 'this vendo') +
    '"?\n\nThis records the cash under your name and resets this vendo\u2019s counter to \u20B10. The coins inside the box should match this amount.')) return;
  try {
    const { collection } = await API.post('/collections', { device_id: deviceId });
    toast('Collected ' + peso(collection ? collection.amount : v.uncollected) + ' from ' + (v.device_name || 'vendo'), 'ok');
    loadCollectSummary();
  } catch (e) {
    toast(e.message || 'Could not record collection', 'err');
  }
}

async function loadCollectHistory() {
  const box = document.getElementById('collect-history-list');
  box.innerHTML = '<div class="skeleton" style="height:56px"></div><div class="skeleton" style="height:56px"></div>';
  try {
    const { collections } = await API.get('/collections/history');
    if (!collections || !collections.length) {
      box.innerHTML = emptyState('No collections yet', 'Recorded collections will appear here.');
      return;
    }
    box.innerHTML = collections.map((c) => {
      const name = (c.vendo_devices && c.vendo_devices.device_name) || 'Unknown vendo';
      const who = (c.profiles && (c.profiles.full_name || c.profiles.email)) || 'Unknown';
      return (
        '<div class="device" style="align-items:center">' +
          '<div class="device-body">' +
            '<div class="device-name">' + esc(name) + '</div>' +
            '<div class="device-meta">' + esc(who) + ' \u00B7 ' + esc(fmtDateTime(c.collected_at)) + '</div>' +
            '<div class="device-meta" style="opacity:.7">' + (c.txn_count || 0) + ' coin drops</div>' +
          '</div>' +
          '<div class="mono" style="font-size:18px;font-weight:800">' + peso(c.amount) + '</div>' +
        '</div>'
      );
    }).join('');
  } catch (e) {
    box.innerHTML = emptyState('Could not load history', e.message);
  }
}

/* small date helpers (client-side) */
function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60; if (m < 60) return Math.floor(m) + 'm ago';
  const h = m / 60; if (h < 24) return Math.floor(h) + 'h ago';
  const d = h / 24; if (d < 7) return Math.floor(d) + 'd ago';
  return fmtDate(iso);
}
function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }); } catch (e) { return ''; }
}
function fmtDateTime(iso) {
  try { return new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
}