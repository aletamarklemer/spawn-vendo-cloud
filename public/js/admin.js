/* public/js/admin.js — admin dashboard controller */
let CHART = null;
let CHART_DRAWING = false;  // guard batok concurrent/stacked draws (flaky WAN)
let REV_RANGE = 'daily';  // remember last-selected revenue range para auto-redraw
let ALL_TX = [];
let ALL_SESS = [];
let ALL_USERS = [];
let AUTO_REFRESH = null; // global auto-refresh interval

async function boot() {
  const p = await requireRole(['admin']);
  if (!p) return;
  document.getElementById('whoami').textContent = p.full_name || p.email;
  nav('dashboard');
}

function nav(section) {
  // Clear previous auto-refresh
  if (AUTO_REFRESH) { clearInterval(AUTO_REFRESH); AUTO_REFRESH = null; }
  // Destroy revenue chart when leaving dashboard — redrawn fresh on return
  // (fixes: chart disappears after nav away / app reopen, needing manual re-select)
  if (section !== 'dashboard' && CHART) { CHART.destroy(); CHART = null; }

  document.querySelectorAll('.navlink').forEach(n => n.classList.toggle('active', n.dataset.sec === section));
  document.querySelectorAll('[data-section]').forEach(s => s.classList.toggle('hidden', s.dataset.section !== section));

  const loaders = {
    dashboard: loadDashboard, devices: loadDevices, transactions: loadTransactions,
    sessions: loadSessions, vouchers: loadVouchers, users: loadUsers,
    settings: loadSettings, audit: loadAudit,
  };
  if (loaders[section]) loaders[section]();

  // Auto-refresh intervals per section
  const intervals = {
    dashboard: 5000,    // 5 seconds
    sessions: 3000,     // 3 seconds - real-time
    devices: 5000,      // 5 seconds
    transactions: 5000, // 5 seconds
  };
  if (intervals[section]) {
    AUTO_REFRESH = setInterval(loaders[section], intervals[section]);
  }
}

/* ---------- Dashboard ---------- */
async function loadDashboard() {
  try {
    const s = await API.get('/admin/stats');
    document.getElementById('rev-today').textContent = peso(s.revenue.today);
    document.getElementById('rev-week').textContent = peso(s.revenue.week);
    document.getElementById('rev-month').textContent = peso(s.revenue.month);
    document.getElementById('active-sessions').textContent = s.active_sessions;
    document.getElementById('dev-online').textContent = `${s.devices.online}/${s.devices.total}`;
    document.getElementById('tx-today').textContent = s.transactions.today;
    // Draw revenue chart if not yet drawn (fresh load, nav back, or app reopen).
    // Guarded by !CHART so the 5s auto-refresh doesn't redraw/flicker every tick.
    if (!CHART && !CHART_DRAWING) drawRevenue(REV_RANGE);
  } catch(e) {}
}

async function drawRevenue(range) {
  if (CHART_DRAWING) return;   // usa ra ka draw sa usa ka higayon (pugngi ang stacking sa hinay nga WAN)
  CHART_DRAWING = true;
  REV_RANGE = range;  // remember para ma-redraw sa dashboard re-entry
  document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('btn-primary', b.dataset.range === range));
  document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('btn-ghost', b.dataset.range !== range));
  try {
    const d = await API.get('/admin/revenue?range=' + range);
    const ctx = document.getElementById('revChart');
    if (!ctx) return;   // section wala pa sa DOM
    if (CHART) { CHART.destroy(); CHART = null; }
    CHART = new Chart(ctx, {
      type: 'bar',
      data: { labels: d.series.map(x => x.label), datasets: [{
        label: 'Revenue (₱)', data: d.series.map(x => x.value),
        backgroundColor: 'rgba(10,132,255,.6)', borderRadius: 6,
      }]},
      options: { responsive: true, maintainAspectRatio: false,
        animation: { duration: 600, easing: 'easeOutQuart' },  // smooth pero paspas
        animations: { y: { from: 0 } },  // bars mo-grow gikan sa 0 = nindot nga entrance
        transitions: { active: { animation: { duration: 200 } } },
        plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: '#9aa0b4' }, grid: { display: false } },
                  y: { ticks: { color: '#9aa0b4' }, grid: { color: '#272735' } } } },
    });
  } catch (e) {
    // WAN fail — ayaw i-leave nga stuck; mo-retry ra sa sunod nga dashboard load
  } finally {
    CHART_DRAWING = false;
  }
}

/* ---------- Devices ---------- */
let ALL_DEVICES = [];
function renderDevices(list) {
    document.getElementById('devTable').innerHTML = (list||[]).map(d => {
      const dl = d.download_mbps || 0, ul = d.upload_mbps || 0;
      const speedTxt = (dl === 0 && ul === 0) ? '<span style="color:var(--muted)">Unlimited</span>' : `↓${dl||'∞'} ↑${ul||'∞'} Mbps`;
      return `
      <tr><td><b>${d.device_name}</b><br><small style="color:var(--muted)">${d.mac_address}</small></td>
      <td>${d.location || '—'}${d.area ? ' · ' + d.area : ''}</td>
      <td>${speedTxt}</td>
      <td><span class="badge ${d.router_online ? 'online' : 'offline'}">&#128246; Router: ${d.router_online ? 'Online' : 'Offline'}</span><br>
          ${d.has_node === false
            ? '<span class="badge" style="margin-top:4px;display:inline-block;color:var(--muted);border:1px solid var(--line);background:transparent">&#129689; No coin slot (extender)</span>'
            : (!d.router_online
              ? '<span class="badge maintenance" style="margin-top:4px;display:inline-block">&#129689; Node: &#9888;&#65039; Unknown (router down)</span>'
              : `<span class="badge ${d.node_online ? 'online' : 'offline'}" style="margin-top:4px;display:inline-block">&#129689; Node: ${d.node_online ? 'Online' : 'Offline'}</span>`)}${
          d.router_online && d.clients_connected != null
            ? `<div style="font-size:11px;color:var(--r5);margin-top:4px;cursor:pointer;text-decoration:underline" onclick="openClientsModal('${d.id}','${(d.device_name||'').replace(/'/g,'')}')" title="See who is online">&#128101; ${d.clients_connected} connected &middot; ${d.clients_online} online</div>`
            : ''}</td>
      <td>${fmtDate(d.last_online)}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="editDevice('${d.id}')">✏️ Edit</button>
          <button class="btn btn-ghost btn-sm" onclick="editDeviceSpeed('${d.id}',${dl},${ul})">⚡ Speed</button>
          <button class="btn btn-ghost btn-sm" onclick="toggleNode('${d.id}',${d.has_node === false ? 'false' : 'true'})">&#129689; ${d.has_node === false ? 'Extender' : 'Vendo'}</button>
          <button class="btn btn-ghost btn-sm" onclick="editRoam('${d.id}')">&#128246; ${d.ssid ? d.ssid : 'No roam'}</button>
          <button class="btn btn-danger btn-sm" onclick="delDevice('${d.id}')">Delete</button></td></tr>`;
    }).join('')
      || '<tr><td colspan="7" style="color:var(--muted)">No devices yet.</td></tr>';
}
/** Real-time filter sa Devices tab */
function filterDevices() {
  const q = (document.getElementById('dev-search')||{value:''}).value.toLowerCase().trim();
  if (!q) return renderDevices(ALL_DEVICES);
  renderDevices((ALL_DEVICES||[]).filter(d =>
    ((d.device_name||'').toLowerCase().includes(q)) ||
    ((d.mac_address||'').toLowerCase().includes(q)) ||
    ((d.location||'').toLowerCase().includes(q)) ||
    ((d.area||'').toLowerCase().includes(q)) ||
    ((d.ssid||'').toLowerCase().includes(q)) ||
    ((d.status||'').toLowerCase().includes(q)) ||
    ((d.id||'').toLowerCase().includes(q))
  ));
}
async function loadDevices() {
  try {
    const { devices } = await API.get('/devices');
    ALL_DEVICES = devices;
    renderDevices(devices);
  } catch(e) {}
}
/** Roam group (ssid): parehas nga value = magka-share ug sessions (roaming).
 *  Blanko = walay roaming. PAHINUMDOM: ang broadcast WiFi name sa router
 *  i-parehas pud, ug parehas nga rates sulod sa usa ka group. */
async function editRoam(id) {
  const dev = (ALL_DEVICES || []).find(d => d.id === id);
  if (!dev) { toast('Device not found', 'err'); return; }
  const v = prompt('Roam group / SSID\n(devices with the SAME value share sessions = roaming)\nLeave blank = no roaming:', dev.ssid || '');
  if (v === null) return;
  const val = v.trim() || null;
  try {
    await API.patch('/devices/' + id, { ssid: val });
    toast(val ? ('Roam group: ' + val + ' — remember to match the broadcast WiFi name too!') : 'Roaming removed (standalone)');
    loadDevices();
  } catch (e) { toast(e.message, 'err'); }
}
/** Toggle: naay coin slot (Vendo) o wala (Extender ra). Editable anytime —
 *  depende sa customer request kung butangan ug NodeMCU ang unit o dili. */
async function toggleNode(id, hasNode) {
  const toExtender = hasNode; // current true -> becoming extender (false)
  const msg = toExtender
    ? 'Set this device as an EXTENDER (no coin slot)?\n\nThe Node badge will show "No coin slot" instead of a false offline alarm.'
    : 'Set this device as a VENDO (with coin slot/NodeMCU)?\n\nNode health monitoring will be active again for this device.';
  if (!confirm(msg)) return;
  try {
    await API.patch('/devices/' + id, { has_node: !hasNode ? true : false });
    toast(toExtender ? 'Set as Extender (no coin slot)' : 'Set as Vendo (with coin slot)');
    loadDevices();
  } catch (e) { toast(e.message, 'err'); }
}
async function addDevice() {
  const body = {
    device_name: val('d_name'), mac_address: val('d_mac'),
    location: val('d_loc'), area: val('d_area'),
    download_mbps: parseInt(val('d_dl'), 10) || 0, upload_mbps: parseInt(val('d_ul'), 10) || 0,
  };
  if (!body.device_name || !body.mac_address) return toast('Name and MAC required', 'err');
  try { await API.post('/devices', body); toast('Device added'); loadDevices();
    ['d_name','d_mac','d_loc','d_area','d_dl','d_ul'].forEach(id => document.getElementById(id).value = '');
  } catch (e) { toast(e.message, 'err'); }
}
async function editDeviceSpeed(id, curDl, curUl) {
  const dl = prompt('Download speed limit (Mbps)\n0 = unlimited', curDl);
  if (dl === null) return;
  const ul = prompt('Upload speed limit (Mbps)\n0 = unlimited', curUl);
  if (ul === null) return;
  try {
    await API.patch('/devices/' + id, {
      download_mbps: parseInt(dl, 10) || 0,
      upload_mbps: parseInt(ul, 10) || 0,
    });
    toast('Speed updated');
    loadDevices();
  } catch (e) { toast(e.message, 'err'); }
}
async function editDevice(id) {
  const dev = (ALL_DEVICES || []).find(d => d.id === id);
  if (!dev) { toast('Device not found', 'err'); return; }
  const name = prompt('Device Name', dev.device_name || '');
  if (name === null) return;
  const mac = prompt('MAC Address', dev.mac_address || '');
  if (mac === null) return;
  const loc = prompt('Location', dev.location || '');
  if (loc === null) return;
  const area = prompt('Area', dev.area || '');
  if (area === null) return;
  if (!name.trim() || !mac.trim()) { toast('Name and MAC required', 'err'); return; }
  try {
    await API.patch('/devices/' + id, {
      device_name: name.trim(),
      mac_address: mac.trim(),
      location: loc.trim(),
      area: area.trim(),
    });
    toast('Device updated');
    loadDevices();
  } catch (e) { toast(e.message, 'err'); }
}
async function delDevice(id) {
  if (!confirm('Delete this device?')) return;
  try { await API.del('/devices/' + id); toast('Deleted'); loadDevices(); } catch (e) { toast(e.message, 'err'); }
}
async function deleteAllDevices() {
  if (!confirm('Delete ALL devices? This cannot be undone!')) return;
  try {
    const { devices } = await API.get('/devices');
    await Promise.all(devices.map(d => API.del('/devices/' + d.id)));
    toast('All devices deleted'); loadDevices();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- Transactions ---------- */
async function loadTransactions() {
  try {
    const { transactions } = await API.get('/admin/transactions');
    ALL_TX = transactions;
    populateDeviceFilter('tx-device-filter', transactions);
    filterTx();
  } catch(e) {}
  // Per-vendo income summary
  try {
    const { vendos, totals } = await API.get('/admin/vendo-income');
    document.getElementById('inc-total').textContent = peso(totals.total);
    document.getElementById('inc-today').textContent = peso(totals.today);
    document.getElementById('inc-week').textContent  = peso(totals.week);
    document.getElementById('inc-month').textContent = peso(totals.month);
    document.getElementById('inc-count').textContent = totals.count;
    document.getElementById('vendoIncomeTable').innerHTML = vendos.map(v => `
      <tr><td><b>${v.device_name}</b></td>
      <td><b style="color:var(--accent,#0a84ff)">${peso(v.total)}</b></td>
      <td>${peso(v.today)}</td><td>${peso(v.week)}</td><td>${peso(v.month)}</td>
      <td>${v.count}</td></tr>`).join('')
      || '<tr><td colspan="6" style="color:var(--muted)">No income yet.</td></tr>';
  } catch(e) {}
}
function renderTx(list) {
  document.getElementById('txTable').innerHTML = list.map(t => `
    <tr><td>${fmtDate(t.created_at)}</td><td>${t.vendo_devices?.device_name || '—'}</td>
    <td>${peso(t.amount)}</td><td>${t.credits} min</td>
    <td><small style="color:var(--muted)">${t.client_mac || '—'}</small></td>
    <td><button class="btn btn-danger btn-sm" onclick="delTx('${t.id}')">Delete</button></td></tr>`).join('')
    || '<tr><td colspan="6" style="color:var(--muted)">No transactions.</td></tr>';
}
function filterTx() {
  const q = document.getElementById('tx-search').value.toLowerCase();
  const dev = (document.getElementById('tx-device-filter')||{}).value || '';
  renderTx(ALL_TX.filter(t =>
    ((t.client_mac||'').toLowerCase().includes(q) || (t.vendo_devices?.device_name||'').toLowerCase().includes(q)) &&
    (!dev || t.device_id === dev)
  ));
}
async function delTx(id) {
  if (!confirm('Delete this transaction?')) return;
  try { await API.del('/admin/transactions/' + id); toast('Deleted'); loadTransactions(); } catch (e) { toast(e.message, 'err'); }
}
async function deleteAllTx() {
  if (!confirm('Delete ALL transactions? This cannot be undone!')) return;
  try { await API.del('/admin/transactions'); toast('All transactions deleted'); loadTransactions(); } catch (e) { toast(e.message, 'err'); }
}
async function deleteDeviceTx() {
  const sel = document.getElementById('tx-device-filter');
  const dev = (sel || {}).value || '';
  if (!dev) { toast('Select a vendo in the device filter first', 'err'); return; }
  const devName = sel.options[sel.selectedIndex].text;
  const cnt = ALL_TX.filter(t => t.device_id === dev).length;
  if (!confirm(`Delete ALL ${cnt} transaction(s) of "${devName}"? This cannot be undone!`)) return;
  try {
    const d = await API.del('/admin/transactions/device/' + dev);
    toast(`Deleted ${d.count} transaction(s) of ${devName}`);
    loadTransactions();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- Sessions ---------- */
let SESS_VALIDITY_DAYS = 3;
async function loadSessions() {
  try {
    try { const { settings } = await API.get('/admin/settings'); if (settings && settings.pause_validity_days) SESS_VALIDITY_DAYS = settings.pause_validity_days; } catch (e) {}
    const { sessions } = await API.get('/admin/sessions');
    ALL_SESS = sessions;
    populateDeviceFilter('sess-device-filter', sessions);
    filterSessions();
  } catch (e) {}
}
function filterSessions() {
  const q = ((document.getElementById('sess-search')||{}).value || '').toLowerCase();
  const dev = (document.getElementById('sess-device-filter')||{}).value || '';
  const list = ALL_SESS.filter(s =>
    ((s.client_mac||'').toLowerCase().includes(q) || (s.device_info||'').toLowerCase().includes(q) || (s.vendo_devices?.device_name||'').toLowerCase().includes(q)) &&
    (!dev || s.device_id === dev)
  );
  renderSessions(list);
}
function renderSessions(list) {
  const validityDays = SESS_VALIDITY_DAYS;
  document.getElementById('sessTable').innerHTML = list.map(s => {
    let validityTxt = '—';
    // SAME as portal/backend: validity clock = manual_paused_at + pause_validity_days,
    // shown only while active/paused. (first_paused_at = legacy, NOT the real clock;
    // add_credits resets manual_paused_at on payment = fresh validity, portal-matched.)
    let vb = s.manual_paused_at || null;
    if (s.auto_paused_at && (!vb || new Date(s.auto_paused_at) < new Date(vb))) vb = s.auto_paused_at;
    if (vb && (s.status === 'active' || s.status === 'paused')) {
      const exp = new Date(new Date(vb).getTime() + validityDays * 86400000);
      const expired = Date.now() > exp.getTime();
      validityTxt = `<span style="color:${expired ? 'var(--bad)' : 'var(--ok)'}">${fmtDate(exp.toISOString())}${expired ? ' (expired)' : ''}</span>`;
    }
    const phone = s.device_info ? `<span style="color:var(--text)">${s.device_info}</span>` : '<span style="color:var(--muted)">—</span>';
    return `
    <tr><td><small style="color:var(--muted)">${s.client_mac}</small></td>
    <td><small>${phone}</small></td>
    <td>${s.vendo_devices?.device_name || '—'}</td>
    <td><span class="badge ${s.status === 'active' ? 'active' : s.status === 'paused' ? 'maintenance' : 'expired'}">${s.status}</span></td>
    <td>${s.status === 'active' ? hms(Math.max(0, Math.floor((new Date(s.end_time) - Date.now()) / 1000))) : s.status === 'paused' ? hms(s.remaining_seconds || 0) + ' (paused)' : '—'}</td>
    <td>${fmtDate(s.end_time)}</td>
    <td>${validityTxt}</td>
    <td><button class="btn btn-danger btn-sm" onclick="delSession('${s.id}')">Delete</button></td></tr>`;
  }).join('')
    || '<tr><td colspan="8" style="color:var(--muted)">No sessions.</td></tr>';
}
/* Populate a device dropdown from a list with device_id + vendo_devices.device_name */
function populateDeviceFilter(selId, list) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  const cur = sel.value;
  const seen = {};
  list.forEach(x => { if (x.device_id && x.vendo_devices?.device_name) seen[x.device_id] = x.vendo_devices.device_name; });
  const opts = ['<option value="">All Vendo</option>'].concat(
    Object.keys(seen).map(id => `<option value="${id}">${seen[id]}</option>`)
  );
  sel.innerHTML = opts.join('');
  if (cur && seen[cur]) sel.value = cur;
}
async function delSession(id) {
  if (!confirm('Delete this session?')) return;
  try { await API.del('/admin/sessions/' + id); toast('Deleted'); loadSessions(); } catch (e) { toast(e.message, 'err'); }
}
async function deleteAllSessions() {
  if (!confirm('Delete all expired sessions?')) return;
  try { await API.del('/admin/sessions/expired'); toast('Expired sessions deleted'); loadSessions(); } catch (e) { toast(e.message, 'err'); }
}

/* ---------- Vouchers ---------- */
function fmtVoucherDuration(mins) {
  if (mins >= 1440 && mins % 1440 === 0) return (mins / 1440) + ' day' + (mins / 1440 > 1 ? 's' : '');
  if (mins >= 60 && mins % 60 === 0) return (mins / 60) + ' hour' + (mins / 60 > 1 ? 's' : '');
  return mins + ' min';
}
function fmtVoucherSpeed(dl, ul) {
  dl = Number(dl) || 0; ul = Number(ul) || 0;
  if (dl === 0 && ul === 0) return 'No limit';
  return `${dl}/${ul} Mbps`;
}
async function loadVouchers() {
  const { vouchers } = await API.get('/vouchers');
  document.getElementById('vchTable').innerHTML = vouchers.map(v => `
    <tr><td style="font-family:ui-monospace,monospace">${v.code}</td>
    <td>${fmtVoucherDuration(v.minutes)}</td>
    <td>${fmtVoucherSpeed(v.download_mbps, v.upload_mbps)}</td>
    <td><span class="badge ${v.status === 'unused' ? 'active' : v.status === 'used' ? 'expired' : 'offline'}">${v.status}</span></td>
    <td>${fmtDate(v.created_at)}</td>
    <td style="display:flex;gap:6px">
      ${v.status === 'unused' ? `<button class="btn btn-ghost btn-sm" onclick="voidVch('${v.id}')">Void</button>` : ''}
      <button class="btn btn-danger btn-sm" onclick="delVoucher('${v.id}')">Delete</button>
    </td></tr>`).join('')
    || '<tr><td colspan="6" style="color:var(--muted)">No vouchers.</td></tr>';
}
async function genVouchers() {
  const duration = parseInt(val('v_duration'), 10) || 0;
  const unit = val('v_unit');
  const count = parseInt(val('v_count'), 10) || 1;
  if (!duration || duration <= 0) return toast('Enter duration', 'err');
  let minutes = duration;
  if (unit === 'hours') minutes = duration * 60;
  else if (unit === 'days') minutes = duration * 60 * 24;
  try {
    const download_mbps = parseInt(val('v_dl'), 10) || 0;
    const upload_mbps = parseInt(val('v_ul'), 10) || 0;
    const d = await API.post('/vouchers/generate', { minutes, count, download_mbps, upload_mbps });
    toast(`Generated ${d.vouchers.length} voucher(s)`); loadVouchers();
  } catch (e) { toast(e.message, 'err'); }
}
async function voidVch(id) { try { await API.post('/vouchers/void', { id }); toast('Voided'); loadVouchers(); } catch (e) { toast(e.message, 'err'); } }
async function delVoucher(id) {
  if (!confirm('Delete this voucher?')) return;
  try { await API.del('/vouchers/' + id); toast('Deleted'); loadVouchers(); } catch (e) { toast(e.message, 'err'); }
}
async function deleteAllVouchers() {
  if (!confirm('Delete all voided/used vouchers?')) return;
  try { await API.del('/vouchers/voided'); toast('Voided vouchers deleted'); loadVouchers(); } catch (e) { toast(e.message, 'err'); }
}
async function deleteAllVouchersForce() {
  if (!confirm('Delete ALL vouchers (including unused)? This cannot be undone!')) return;
  try { await API.del('/vouchers/all'); toast('All vouchers deleted'); loadVouchers(); } catch (e) { toast(e.message, 'err'); }
}

/* ---------- Users ---------- */
async function loadUsers() {
  const { users } = await API.get('/admin/users');
  ALL_USERS = users;
  document.getElementById('usrTable').innerHTML = users.map(u => `
    <tr><td><b>${u.full_name || '—'}</b><br><small style="color:var(--muted)">${u.email}</small></td>
    <td><span class="badge active">${u.role}</span></td>
    <td>
      <div style="display:flex;align-items:center;gap:8px">
        <input type="password" id="pw_show_${u.id}" value="••••••••" readonly style="width:120px;padding:6px 10px;font-size:12px;background:var(--bg-2)">
        <button class="btn btn-ghost btn-sm" onclick="toggleShowPw('${u.id}')">👁</button>
        <button class="btn btn-ghost btn-sm" onclick="openPwModal('${u.id}')">Change</button>
      </div>
    </td>
    <td><span class="badge ${u.is_active ? 'online' : 'offline'}">${u.is_active ? 'active' : 'disabled'}</span></td>
    <td style="display:flex;gap:6px">
      <button class="btn btn-ghost btn-sm" onclick="toggleUser('${u.id}',${!u.is_active})">${u.is_active ? 'Disable' : 'Enable'}</button>
      <button class="btn btn-danger btn-sm" onclick="delUser('${u.id}')">Delete</button>
    </td></tr>`).join('');
}
async function addUser() {
  const body = { email: val('u_email'), password: val('u_pass'), full_name: val('u_name'), role: val('u_role') };
  if (!body.email || !body.password) return toast('Email and password required', 'err');
  if (body.password.length < 8) return toast('Password must be at least 8 characters', 'err');
  try { await API.post('/auth/register', body); toast('User created'); loadUsers();
    ['u_email','u_pass','u_name'].forEach(id => document.getElementById(id).value = ''); } catch (e) { toast(e.message, 'err'); }
}
async function toggleUser(id, active) {
  try { await API.patch(`/admin/users/${id}/active`, { is_active: active }); loadUsers(); } catch (e) { toast(e.message, 'err'); }
}
async function delUser(id) {
  if (!confirm('Delete this user? This cannot be undone!')) return;
  try { await API.del('/admin/users/' + id); toast('User deleted'); loadUsers(); } catch (e) { toast(e.message, 'err'); }
}
async function toggleShowPw(uid) {
  const input = document.getElementById('pw_show_' + uid);
  if (input.value === '••••••••') {
    try {
      const { password } = await API.get('/admin/users/' + uid + '/password');
      input.value = password;
      input.type = 'text';
    } catch (e) { toast(e.message, 'err'); }
  } else {
    input.value = '••••••••';
    input.type = 'password';
  }
}

/* ---------- Change Password Modal ---------- */
function openPwModal(uid) {
  document.getElementById('pw_uid').value = uid;
  document.getElementById('pw_new').value = '';
  const inp = document.getElementById('pw_new');
  if (inp) inp.type = 'password';
  document.getElementById('pwModal').classList.remove('hidden');
  if (inp) setTimeout(() => inp.focus(), 50);
}
function closePwModal() {
  document.getElementById('pwModal').classList.add('hidden');
}
function togglePw(inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
}
async function savePw() {
  const uid = document.getElementById('pw_uid').value;
  const pw = document.getElementById('pw_new').value;
  if (!pw || pw.length < 8) return toast('Password must be at least 8 characters', 'err');
  try {
    await API.patch('/admin/users/' + uid + '/password', { password: pw });
    toast('Password changed');
    closePwModal();
    loadUsers();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------- Settings ---------- */
async function loadSettings() {
  const { settings } = await API.get('/admin/settings');
  if (settings && document.getElementById('s_validity')) {
    document.getElementById('s_validity').value = settings.pause_validity_days || 3;
  }
  if (settings && document.getElementById('s_abuse_threshold')) {
    document.getElementById('s_abuse_threshold').value = settings.coin_abuse_threshold || 5;
  }
  if (settings && document.getElementById('s_ban_seconds')) {
    document.getElementById('s_ban_seconds').value = settings.coin_ban_seconds || 60;
  }
  loadTiers();
}
async function saveSettings() {
  try { await API.put('/admin/settings', {
      pause_validity_days: parseInt(val('s_validity'), 10) || 3,
      coin_abuse_threshold: parseInt(val('s_abuse_threshold'), 10) || 5,
      coin_ban_seconds: parseInt(val('s_ban_seconds'), 10) || 60,
    });
    toast('Settings saved'); } catch (e) { toast(e.message, 'err'); }
}

/* ---------- Pricing Tiers ---------- */
const TIER_UNITS = [['minute', 'Minutes'], ['hour', 'Hours'], ['day', 'Days']];
function tierUnitOpts(sel) {
  return TIER_UNITS.map(([v, label]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${label}</option>`).join('');
}
function tierRowHtml(t) {
  t = t || { amount: '', duration_value: '', duration_unit: 'minute' };
  return `<tr>
    <td><input type="number" step="0.01" min="0" class="t-amt" value="${t.amount}" placeholder="₱" style="width:90px"></td>
    <td><input type="number" min="1" class="t-val" value="${t.duration_value}" placeholder="0" style="width:80px"></td>
    <td><select class="t-unit">${tierUnitOpts(t.duration_unit)}</select></td>
    <td><button class="btn btn-danger btn-sm" type="button" onclick="this.closest('tr').remove();updateTierNote()">✕</button></td>
  </tr>`;
}
function addTierRow(t) {
  document.getElementById('tierRows').insertAdjacentHTML('beforeend', tierRowHtml(t));
  updateTierNote();
}
function updateTierNote() {
  const has = document.querySelectorAll('#tierRows tr').length > 0;
  const note = document.getElementById('tierEmptyNote');
  if (note) note.style.display = has ? 'none' : '';
}
async function fillTierDeviceSel() {
  const sel = document.getElementById('tierDevice');
  if (!sel || sel.dataset.loaded) return;
  try {
    const { devices } = await API.get('/devices');
    (devices || []).forEach(d => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = (d.device_name || d.id.slice(0, 8)) + (d.ssid ? ' (' + d.ssid + ')' : '');
      sel.appendChild(o);
    });
    sel.dataset.loaded = '1';
  } catch (e) { /* devices list optional; global editing still works */ }
}
async function loadTiers() {
  await fillTierDeviceSel();
  const sel = document.getElementById('tierDevice');
  const devId = sel && sel.value ? sel.value : '';
  const { tiers } = await API.get('/admin/pricing-tiers' + (devId ? ('?device_id=' + devId) : ''));
  const body = document.getElementById('tierRows');
  if (!body) return;
  body.innerHTML = '';
  (tiers || []).forEach(addTierRow);
  updateTierNote();
  const note = document.getElementById('tierScopeNote');
  if (note) note.textContent = devId
    ? 'Per-device rates: if tiers are set here, ONLY these apply to this vendo. If empty, it falls back to the Global Default.'
    : 'Global Default: used by ALL vendos that have no per-device tiers of their own.';
}
async function saveTiers() {
  const sel = document.getElementById('tierDevice');
  const devId = sel && sel.value ? sel.value : null;
  const rows = [...document.querySelectorAll('#tierRows tr')].map(tr => ({
    amount: tr.querySelector('.t-amt').value,
    duration_value: tr.querySelector('.t-val').value,
    duration_unit: tr.querySelector('.t-unit').value,
  }));
  try {
    await API.put('/admin/pricing-tiers', { tiers: rows, device_id: devId });
    toast(devId ? 'Per-device rates saved' : 'Global pricing tiers saved');
  }
  catch (e) { toast(e.message, 'err'); }
}

/* ---------- Audit ---------- */
async function loadAudit() {
  const { logs } = await API.get('/admin/audit');
  document.getElementById('audTable').innerHTML = logs.map(l => `
    <tr><td>${fmtDate(l.created_at)}</td><td><b>${l.action}</b></td>
    <td>${l.profiles?.full_name || l.profiles?.email || '—'}</td>
    <td><small style="color:var(--muted)">${l.details ? JSON.stringify(l.details) : ''}</small></td></tr>`).join('')
    || '<tr><td colspan="4" style="color:var(--muted)">No logs.</td></tr>';
}
async function deleteAllAudit() {
  if (!confirm('Delete ALL audit logs? This cannot be undone!')) return;
  try { await API.del('/admin/audit'); toast('Audit logs cleared'); loadAudit(); } catch (e) { toast(e.message, 'err'); }
}

/* ===== Edit Profile ===== */
function openEditProfile() {
  const p = API.profile() || {};
  document.getElementById('ep_name').value = p.full_name || '';
  document.getElementById('ep_email').value = p.email || '';
  document.getElementById('editProfileModal').classList.remove('hidden');
}
function closeEditProfile() {
  document.getElementById('editProfileModal').classList.add('hidden');
}
async function saveProfile() {
  const full_name = document.getElementById('ep_name').value.trim();
  const email = document.getElementById('ep_email').value.trim();
  if (!full_name && !email) { toast('Enter a name or email', 'err'); return; }
  const btn = document.getElementById('epSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const body = {};
    if (full_name) body.full_name = full_name;
    if (email) body.email = email;
    const data = await API.patch('/auth/profile', body);
    if (data && data.profile) API.setProfile(data.profile);
    document.getElementById('whoami').textContent = full_name || email;
    toast('Profile updated');
    closeEditProfile();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

const val = (id) => document.getElementById(id).value.trim();
boot();

/* ---------- WHO'S ONLINE modal (real-time clients per router) ---------- */
let __clIv = null;
function openClientsModal(devId, devName) {
  document.getElementById('cl_title').textContent = 'Online on: ' + (devName || 'Device');
  document.getElementById('clientsModal').classList.remove('hidden');
  loadClientsList(devId);
  if (__clIv) clearInterval(__clIv);
  __clIv = setInterval(() => loadClientsList(devId), 5000);  // real-time refresh
}
function closeClientsModal() {
  document.getElementById('clientsModal').classList.add('hidden');
  if (__clIv) { clearInterval(__clIv); __clIv = null; }
}
async function loadClientsList(devId) {
  try {
    const d = await API.get('/devices/' + devId + '/clients');
    const tb = document.getElementById('clTable');
    if (!d.fresh) { tb.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No real-time data (router offline or enforce not updated yet)</td></tr>'; return; }
    if (!d.clients.length) { tb.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No one connected right now</td></tr>'; return; }
    tb.innerHTML = d.clients.map((c) => `
      <tr>
        <td style="font-family:monospace;font-size:12px">${c.mac}</td>
        <td>${c.phone || '<span style="color:var(--muted)">—</span>'}</td>
        <td>${c.online
              ? '<span class="badge online">&#127760; Online (browsing)</span>'
              : '<span class="badge maintenance">&#128268; Connected only (not browsing)</span>'}</td>
        <td>${c.remaining_seconds != null
              ? hmsAdm(c.remaining_seconds) + (c.session_status === 'paused' ? ' <small style="color:var(--muted)">(paused)</small>' : '')
              : '<span style="color:var(--muted)">no session</span>'}</td>
      </tr>`).join('');
    labelTableCells();
  } catch (e) { /* transient — sunod refresh */ }
}
function hmsAdm(s) { s = Math.max(0, Math.floor(s)); const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60), x = s%60; const t = [h,m,x].map(v => String(v).padStart(2,'0')).join(':'); return d > 0 ? d + (d > 1 ? ' days ' : ' day ') + t : t; }  // v2: >24h = day display (match portal v25)

/* MOBILE: auto-add data-label sa kada <td> gikan sa header row (para sa card-style
   table sa phone). Idempotent, walay epekto sa desktop (CSS @media ra mogamit). */
function labelTableCells(root) {
  const scope = root || document;
  scope.querySelectorAll('table').forEach((tbl) => {
    const heads = [...tbl.querySelectorAll('thead th')].map((h) => h.textContent.trim());
    if (!heads.length) return;
    tbl.querySelectorAll('tbody tr').forEach((tr) => {
      [...tr.children].forEach((td, i) => {
        if (heads[i] && !td.hasAttribute('data-label')) td.setAttribute('data-label', heads[i]);
      });
    });
  });
}
// Auto-run human sa bisan unsang table render (MutationObserver = walay kinahanglan tawgon kada function)
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    const obs = new MutationObserver(() => labelTableCells());
    document.querySelectorAll('tbody').forEach((tb) =>
      obs.observe(tb, { childList: true }));
    labelTableCells();
  });
}