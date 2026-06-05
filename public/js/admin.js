/* public/js/admin.js — admin dashboard controller */
let CHART = null;

async function boot() {
  const p = await requireRole(['admin']);
  if (!p) return;
  document.getElementById('whoami').textContent = p.full_name || p.email;
  nav('dashboard');
}

function nav(section) {
  document.querySelectorAll('.navlink').forEach(n => n.classList.toggle('active', n.dataset.sec === section));
  document.querySelectorAll('[data-section]').forEach(s => s.classList.toggle('hidden', s.dataset.section !== section));
  ({
    dashboard: loadDashboard, devices: loadDevices, transactions: loadTransactions,
    vouchers: loadVouchers, users: loadUsers, collections: loadCollections,
    settings: loadSettings, audit: loadAudit,
  }[section] || (() => {}))();
}

/* ---------- Dashboard ---------- */
async function loadDashboard() {
  const s = await API.get('/admin/stats');
  document.getElementById('rev-today').textContent = peso(s.revenue.today);
  document.getElementById('rev-week').textContent = peso(s.revenue.week);
  document.getElementById('rev-month').textContent = peso(s.revenue.month);
  document.getElementById('active-sessions').textContent = s.active_sessions;
  document.getElementById('dev-online').textContent = `${s.devices.online}/${s.devices.total}`;
  document.getElementById('tx-today').textContent = s.transactions.today;
  drawRevenue('daily');
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
  const { devices } = await API.get('/devices');
  document.getElementById('devTable').innerHTML = devices.map(d => `
    <tr><td><b>${d.device_name}</b><br><small style="color:var(--muted)">${d.mac_address}</small></td>
    <td>${d.location || '—'}${d.area ? ' · ' + d.area : ''}</td>
    <td>${d.vlan ?? '—'}</td>
    <td><span class="badge ${d.status}">${d.status}</span></td>
    <td>${fmtDate(d.last_online)}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="delDevice('${d.id}')">Delete</button></td></tr>`).join('')
    || '<tr><td colspan="6" style="color:var(--muted)">No devices yet.</td></tr>';
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
async function delDevice(id) { if (!confirm('Delete device?')) return;
  try { await API.del('/devices/' + id); toast('Deleted'); loadDevices(); } catch (e) { toast(e.message, 'err'); } }

/* ---------- Transactions ---------- */
async function loadTransactions() {
  const { transactions } = await API.get('/admin/transactions');
  document.getElementById('txTable').innerHTML = transactions.map(t => `
    <tr><td>${fmtDate(t.created_at)}</td><td>${t.vendo_devices?.device_name || '—'}</td>
    <td>${peso(t.amount)}</td><td>${t.credits} min</td>
    <td><small style="color:var(--muted)">${t.client_mac || '—'}</small></td></tr>`).join('')
    || '<tr><td colspan="5" style="color:var(--muted)">No transactions.</td></tr>';
}

/* ---------- Vouchers ---------- */
async function loadVouchers() {
  const { vouchers } = await API.get('/vouchers');
  document.getElementById('vchTable').innerHTML = vouchers.map(v => `
    <tr><td style="font-family:ui-monospace,monospace">${v.code}</td><td>${v.minutes} min</td>
    <td><span class="badge ${v.status === 'unused' ? 'active' : v.status === 'used' ? 'expired' : 'offline'}">${v.status}</span></td>
    <td>${fmtDate(v.created_at)}</td>
    <td>${v.status === 'unused' ? `<button class="btn btn-ghost btn-sm" onclick="voidVch('${v.id}')">Void</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="5" style="color:var(--muted)">No vouchers.</td></tr>';
}
async function genVouchers() {
  const minutes = parseInt(val('v_minutes'), 10), count = parseInt(val('v_count'), 10) || 1;
  if (!minutes) return toast('Enter minutes', 'err');
  try { const d = await API.post('/vouchers/generate', { minutes, count });
    toast(`Generated ${d.vouchers.length} voucher(s)`); loadVouchers(); } catch (e) { toast(e.message, 'err'); }
}
async function voidVch(id) { try { await API.post('/vouchers/void', { id }); toast('Voided'); loadVouchers(); } catch (e) { toast(e.message, 'err'); } }

/* ---------- Users ---------- */
async function loadUsers() {
  const { users } = await API.get('/admin/users');
  document.getElementById('usrTable').innerHTML = users.map(u => `
    <tr><td><b>${u.full_name || '—'}</b><br><small style="color:var(--muted)">${u.email}</small></td>
    <td><span class="badge active">${u.role}</span></td>
    <td><span class="badge ${u.is_active ? 'online' : 'offline'}">${u.is_active ? 'active' : 'disabled'}</span></td>
    <td><button class="btn btn-ghost btn-sm" onclick="toggleUser('${u.id}',${!u.is_active})">${u.is_active ? 'Disable' : 'Enable'}</button></td></tr>`).join('');
}
async function addUser() {
  const body = { email: val('u_email'), password: val('u_pass'), full_name: val('u_name'), role: val('u_role') };
  if (!body.email || !body.password) return toast('Email and password required', 'err');
  try { await API.post('/auth/register', body); toast('User created'); loadUsers();
    ['u_email','u_pass','u_name'].forEach(id => document.getElementById(id).value = ''); } catch (e) { toast(e.message, 'err'); }
}
async function toggleUser(id, active) { try { await API.patch(`/admin/users/${id}/active`, { is_active: active }); loadUsers(); } catch (e) { toast(e.message, 'err'); } }

/* ---------- Collections ---------- */
async function loadCollections() {
  const { collections } = await API.get('/collections');
  document.getElementById('colTable').innerHTML = collections.map(c => `
    <tr><td>${c.collection_date}</td><td>${c.vendo_devices?.device_name || '—'}</td>
    <td>${c.profiles?.full_name || '—'}</td><td>${peso(c.amount)}</td><td>${c.notes || ''}</td></tr>`).join('')
    || '<tr><td colspan="5" style="color:var(--muted)">No collections.</td></tr>';
}

/* ---------- Settings ---------- */
async function loadSettings() {
  const { settings } = await API.get('/admin/settings');
  if (settings) { document.getElementById('s_peso').value = settings.peso_rate; document.getElementById('s_min').value = settings.minutes_rate; }
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

const val = (id) => document.getElementById(id).value.trim();
boot();
