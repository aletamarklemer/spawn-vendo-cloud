/* public/js/api.js — shared client helpers (vanilla JS) */
const API = {
  base: '/api',
  token() { return localStorage.getItem('spawn_token'); },
  setToken(t) { localStorage.setItem('spawn_token', t); },
  clear() { localStorage.removeItem('spawn_token'); localStorage.removeItem('spawn_profile'); },
  profile() { try { return JSON.parse(localStorage.getItem('spawn_profile') || 'null'); } catch { return null; } },
  setProfile(p) { localStorage.setItem('spawn_profile', JSON.stringify(p)); },

  async req(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = this.token();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(this.base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    let json = {};
    try { json = await res.json(); } catch {}
    if (!res.ok || json.success === false) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json.data;
  },
  get(p) { return this.req('GET', p); },
  post(p, b) { return this.req('POST', p, b); },
  put(p, b) { return this.req('PUT', p, b); },
  patch(p, b) { return this.req('PATCH', p, b); },
  del(p) { return this.req('DELETE', p); },
};

/* Toast notifications */
function toast(msg, type = 'ok') {
  let host = document.getElementById('toast');
  if (!host) { host = document.createElement('div'); host.id = 'toast'; document.body.appendChild(host); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* Require a logged-in staff member with one of the allowed roles, else redirect */
async function requireRole(allowed) {
  if (!API.token()) { location.href = '/login.html'; return null; }
  try {
    const { profile } = await API.get('/auth/me');
    if (!profile || !allowed.includes(profile.role)) { location.href = '/login.html'; return null; }
    API.setProfile(profile);
    return profile;
  } catch {
    API.clear(); location.href = '/login.html'; return null;
  }
}

function logout() { API.clear(); location.href = '/login.html'; }

/* Format helpers */
const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (s) => s ? new Date(s).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
function hms(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
}
