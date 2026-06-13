/* public/js/admin.js — admin dashboard controller */
let CHART = null;
let ALL_TX = [];
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
  } catch(e) {}
}

async function drawRevenue(range) {
  const d = await API.get('/admin/revenue?range=' + range);
  document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('btn-primary', b.dataset.range === range));
  document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('btn-ghost', b.dataset.range !== range));
  const ctx = document.getElementById('revChart');
  if (CHART) CHART.destroy();
  CHART = new Chart(ctx, {
    type: 'bar',
    data: { labels: d.series.map(x => x.label), datasets: [{
      label: 'Revenue (₱)', data: d.series.map(x => x.value),
      backgroundColor: 'rgba(10,132,255,.6)', borderRadius: 6,
    }]},
    options: { plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: '#9aa0b4' }, grid: { display: false } },
                y: { ticks: { color: '#9aa0b4' }, grid: { color: '#272735' } } } },
  });
}

/* ---------- Devices ---------- */
async function loadDevices() {
  try {
    const { devices } = await API.get('/devices');
    document.getElementById('devTable').innerHTML = devices.map(d => `
      <tr><td><b>${d.device_name}</b><br><small style="color:var(--muted)">${d.mac_address}</small></td>
      <td>${d.location || '—'}${d.area ? ' · ' + d.area : ''}</td>
      <td>${d.vlan ?? '—'}</td>
      <td><span class="badge ${d.status}">${d.status}</span></td>
      <td>${fmtDate(d.last_online)}</td>
      <td><button class="btn btn-danger btn-sm" onclick="delDevice('${d.id}')">Delete</button></td></tr>`).join('')
      || '<tr><td colspan="6" style="color:var(--muted)">No devices yet.</td></tr>';
  } catch(e) {}
}
async function addDevice() {
  const body = {
    device_name: val('d_name'), mac_address: val('d_mac'),
    location: val('d_loc'), area: val('d_area'), vlan: parseInt(val('d_vlan'), 10) || null,
  };
  if (!body.device_name || !body.mac_address) return toast('Name and MAC required', 'err');
  try { await API.post('/devices', body); toast('Device added'); loadDevices();
    ['d_name','d_mac','d_loc','d_area','d_vlan'].forEach(id => document.getElementById(id).value = '');
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
    renderTx(transactions);
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
  renderTx(ALL_TX.filter(t => (t.client_mac||'').toLowerCase().includes(q) || (t.vendo_devices?.device_name||'').toLowerCase().includes(q)));
}
async function delTx(id) {
  if (!confirm('Delete this transaction?')) return;
  try { await API.del('/admin/transactions/' + id); toast('Deleted'); loadTransactions(); } catch (e) { toast(e.message, 'err'); }
}
async function deleteAllTx() {
  if (!confirm('Delete ALL transactions? This cannot be undone!')) return;
  try { await API.del('/admin/transactions'); toast('All transactions deleted'); loadTransactions(); } catch (e) { toast(e.message, 'err'); }
}

/* ---------- Sessions ---------- */
async function loadSessions() {
  try {
    const { sessions } = await API.get('/admin/sessions');
    document.getElementById('sessTable').innerHTML = sessions.map(s => `
      <tr><td><small style="color:var(--muted)">${s.client_mac}</small></td>
      <td>${s.vendo_devices?.device_name || '—'}</td>
      <td><span class="badge ${s.status === 'active' ? 'active' : s.status === 'paused' ? 'maintenance' : 'expired'}">${s.status}</span></td>
      <td>${s.status === 'active' ? hms(Math.max(0, Math.floor((new Date(s.end_time) - Date.now()) / 1000))) : s.status === 'paused' ? hms(s.remaining_seconds || 0) + ' (paused)' : '—'}</td>
      <td>${fmtDate(s.end_time)}</td>
      <td><button class="btn btn-danger btn-sm" onclick="delSession('${s.id}')">Delete</button></td></tr>`).join('')
      || '<tr><td colspan="6" style="color:var(--muted)">No sessions.</td></tr>';
  } catch (e) {}
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
async function loadVouchers() {
  const { vouchers } = await API.get('/vouchers');
  document.getElementById('vchTable').innerHTML = vouchers.map(v => `
    <tr><td style="font-family:ui-monospace,monospace">${v.code}</td>
    <td>${fmtVoucherDuration(v.minutes)}</td>
    <td><span class="badge ${v.status === 'unused' ? 'active' : v.status === 'used' ? 'expired' : 'offline'}">${v.status}</span></td>
    <td>${fmtDate(v.created_at)}</td>
    <td style="display:flex;gap:6px">
      ${v.status === 'unused' ? `<button class="btn btn-ghost btn-sm" onclick="voidVch('${v.id}')">Void</button>` : ''}
      <button class="btn btn-danger btn-sm" onclick="delVoucher('${v.id}')">Delete</button>
    </td></tr>`).join('')
    || '<tr><td colspan="5" style="color:var(--muted)">No vouchers.</td></tr>';
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
    const d = await API.post('/vouchers/generate', { minutes, count });
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

/* ---------- Settings ---------- */
async function loadSettings() {
  const { settings } = await API.get('/admin/settings');
  if (settings) { document.getElementById('s_peso').value = settings.peso_rate; document.getElementById('s_min').value = settings.minutes_rate; }
  prev();
}
async function saveSettings() {
  try { await API.put('/admin/settings', { peso_rate: Number(val('s_peso')), minutes_rate: parseInt(val('s_min'), 10) });
    toast('Rates updated'); } catch (e) { toast(e.message, 'err'); }
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

const val = (id) => document.getElementById(id).value.trim();
boot();